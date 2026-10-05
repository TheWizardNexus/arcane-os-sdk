#import "ArcaneHost.h"
#import <dispatch/dispatch.h>

typedef void (^ArcaneHostCompletion)(void);
typedef void (^ArcaneHostOperation)(ArcaneHostCompletion completion);
typedef void (^ArcaneHostReply)(id _Nullable reply, NSString * _Nullable errorMessage);

static NSError *ArcaneHostError(NSString *code, NSString *message, NSError *underlying) {
    NSMutableDictionary *details = [@{NSLocalizedDescriptionKey: message, @"code": code} mutableCopy];
    if (underlying) details[NSUnderlyingErrorKey] = underlying;
    return [NSError errorWithDomain:@"ArcaneHost" code:1 userInfo:details];
}

static id ArcaneDiagnosticValue(id value, NSMutableArray *ancestors, NSError **error) {
    if (!value) return NSNull.null;
    if ([value isKindOfClass:[NSString class]] || [value isKindOfClass:[NSNumber class]]
        || [value isKindOfClass:[NSDate class]] || [value isKindOfClass:[NSNull class]]) return value;
    for (id ancestor in ancestors) {
        if (ancestor == value) {
            *error = ArcaneHostError(@"CORE_NATIVE_DIAGNOSTIC_UNREPRESENTABLE",
                @"A native diagnostic contains a cyclic object graph that WebKit arguments cannot represent. The complete error remains with the native host delegate.", nil);
            return nil;
        }
    }
    [ancestors addObject:value];
    id result = nil;
    if ([value isKindOfClass:[NSError class]]) {
        NSError *nativeError = value;
        result = ArcaneDiagnosticValue(@{
            @"code": nativeError.userInfo[@"code"] ?: @"CORE_HOST_FAILED",
            @"message": nativeError.localizedDescription,
            @"domain": nativeError.domain, @"nativeCode": @(nativeError.code),
            @"userInfo": nativeError.userInfo
        }, ancestors, error);
    } else if ([value isKindOfClass:[NSDictionary class]]) {
        NSMutableDictionary *dictionary = [NSMutableDictionary dictionary];
        for (id key in value) {
            if (![key isKindOfClass:[NSString class]]) {
                *error = ArcaneHostError(@"CORE_NATIVE_DIAGNOSTIC_UNREPRESENTABLE",
                    @"A native diagnostic dictionary has a non-string key that WebKit arguments cannot represent. The complete error remains with the native host delegate.", nil);
                break;
            }
            id item = ArcaneDiagnosticValue(value[key], ancestors, error);
            if (!item) break;
            dictionary[key] = item;
        }
        if (!*error) result = dictionary;
    } else if ([value isKindOfClass:[NSArray class]]) {
        NSMutableArray *array = [NSMutableArray array];
        for (id item in value) {
            id converted = ArcaneDiagnosticValue(item, ancestors, error);
            if (!converted) break;
            [array addObject:converted];
        }
        if (!*error) result = array;
    } else if ([value isKindOfClass:[NSURL class]]) {
        NSURL *url = value;
        // Reversible Foundation values that are not WebKit argument types stay
        // complete in explicit transport records, including relative URLs.
        result = ArcaneDiagnosticValue(@{@"nativeType": @"NSURL",
            @"relativeString": url.relativeString, @"baseURL": (id)url.baseURL ?: NSNull.null}, ancestors, error);
    } else if ([value isKindOfClass:[NSData class]]) {
        result = @{@"nativeType": @"NSData", @"base64": [value base64EncodedStringWithOptions:0]};
    } else {
        *error = ArcaneHostError(@"CORE_NATIVE_DIAGNOSTIC_UNREPRESENTABLE",
            [NSString stringWithFormat:@"The native diagnostic class %@ cannot be passed as a WebKit argument. The complete error remains with the native host delegate.", NSStringFromClass([value class])], nil);
    }
    [ancestors removeLastObject];
    return result;
}

static NSDictionary *ArcaneHostErrorRecord(NSError *error, NSError **representationError) {
    *representationError = nil;
    return ArcaneDiagnosticValue(error, [NSMutableArray array], representationError);
}

static NSData *ArcaneCancelRequestsData(void) {
    return [@"{\"protocol\":\"arcane/1\",\"type\":\"control\",\"control\":\"requests.cancelAll\"}"
        dataUsingEncoding:NSUTF8StringEncoding];
}

@interface ArcaneHost () <NSWindowDelegate, WKNavigationDelegate,
                         WKScriptMessageHandlerWithReply, ArcaneCoreProcessDelegate> {
    WKWebView *_webView;
    WKUserContentController *_contentController;
    ArcaneCoreProcess *_process;
    id<ArcaneHostDelegate> _hostDelegate;
    NSMutableArray<NSError *> *_errors;
    NSMutableArray<ArcaneHostOperation> *_ingressOperations;
    NSMutableArray<ArcaneHostOperation> *_deliveries;
    NSMutableArray<void (^)(NSArray<NSError *> *)> *_closeCompletions;
    NSMutableDictionary<NSString *, NSString *> *_requestActivations;
    NSString *_activation;
    NSError *_terminalError;
    BOOL _ingressRunning;
    BOOL _deliveryRunning;
    BOOL _processComplete;
    BOOL _closing;
    BOOL _closed;
    BOOL _windowClosed;
    ArcaneHost *_closingOwner;
}
@end

@implementation ArcaneHost

+ (instancetype)openApplicationURL:(NSURL *)applicationURL
                  websiteDataStore:(WKWebsiteDataStore *)websiteDataStore
                             title:(NSString *)title
                      contentFrame:(NSRect)contentFrame
                     classicSource:(NSString *)classicSource
                     executableURL:(NSURL *)executableURL
                         arguments:(NSArray<NSString *> *)arguments
               workingDirectoryURL:(NSURL *)workingDirectoryURL
                          delegate:(id<ArcaneHostDelegate>)delegate {
    if (![NSThread isMainThread] || !websiteDataStore || !title
        || !classicSource || !executableURL || !arguments || !workingDirectoryURL || !delegate) {
        [NSException raise:NSInvalidArgumentException
                    format:@"Open the host on the main thread with a store, title, classic source, Core configuration and delegate."];
    }
    NSWindow *window = [[NSWindow alloc] initWithContentRect:contentFrame
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
            | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    ArcaneHost *host = [[self alloc] initWithWindow:window];
    host->_hostDelegate = delegate;
    host->_errors = [NSMutableArray array];
    host->_ingressOperations = [NSMutableArray array];
    host->_deliveries = [NSMutableArray array];
    host->_closeCompletions = [NSMutableArray array];
    host->_requestActivations = [NSMutableDictionary dictionary];
    window.title = title;
    window.releasedWhenClosed = NO;
    window.delegate = host;

    host->_contentController = [[WKUserContentController alloc] init];
    [host->_contentController addScriptMessageHandlerWithReply:host
        contentWorld:WKContentWorld.pageWorld name:@"arcane"];
    [host->_contentController addUserScript:[[WKUserScript alloc] initWithSource:classicSource
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES
        inContentWorld:WKContentWorld.pageWorld]];
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    configuration.websiteDataStore = websiteDataStore;
    configuration.userContentController = host->_contentController;
    host->_webView = [[WKWebView alloc] initWithFrame:window.contentView.bounds configuration:configuration];
    host->_webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    host->_webView.navigationDelegate = host;
    window.contentView = host->_webView;
    [host showWindow:nil];
    if (applicationURL) [host loadApplicationURL:applicationURL];
    host->_process = [ArcaneCoreProcess startExecutableURL:executableURL arguments:arguments
        workingDirectoryURL:workingDirectoryURL delegate:host];
    return host;
}

- (WKWebView *)webView { return _webView; }
- (BOOL)isClosing { return _closing; }

- (WKNavigation *)loadApplicationURL:(NSURL *)applicationURL {
    if (_closing) return nil;
    return [_webView loadRequest:[NSURLRequest requestWithURL:applicationURL]];
}

- (void)reportError:(NSError *)error {
    [_errors addObject:error];
    [_hostDelegate host:self didEncounterError:error];
}

- (void)enqueueOperation:(ArcaneHostOperation)operation ingress:(BOOL)ingress {
    NSMutableArray<ArcaneHostOperation> *operations = ingress ? _ingressOperations : _deliveries;
    [operations addObject:[operation copy]];
    [self runNextOperationForIngress:ingress];
}

- (void)runNextOperationForIngress:(BOOL)ingress {
    if (ingress ? _ingressRunning : _deliveryRunning) return;
    NSMutableArray<ArcaneHostOperation> *operations = ingress ? _ingressOperations : _deliveries;
    if (!operations.count) { [self finishCloseIfReady]; return; }
    if (ingress) _ingressRunning = YES;
    else _deliveryRunning = YES;
    ArcaneHostOperation operation = operations.firstObject;
    [operations removeObjectAtIndex:0];
    operation(^{
        if (ingress) self->_ingressRunning = NO;
        else self->_deliveryRunning = NO;
        // Advance on the main queue without recursively walking a run of
        // immediately settled messages. Ingress waits only for its own probe
        // and ordered writes; page delivery never holds subsequent stdin work.
        dispatch_async(dispatch_get_main_queue(), ^{ [self runNextOperationForIngress:ingress]; });
    });
}

- (void)rejectReply:(ArcaneHostReply)reply error:(NSError *)error {
    [self reportError:error];
    NSError *representationError = nil;
    NSDictionary *record = ArcaneHostErrorRecord(error, &representationError);
    if (record) reply(@{@"accepted": @NO, @"error": record}, nil);
    else {
        [self reportError:representationError];
        reply(nil, representationError.localizedDescription);
    }
}

- (void)writeData:(NSData *)data completion:(void (^)(NSError *error))completion {
    NSError *error = nil;
    BOOL queued = [_process sendJSONData:data completion:^(NSError *writeError) {
        dispatch_async(dispatch_get_main_queue(), ^{ completion(writeError); });
    } error:&error];
    if (!queued) completion(error ?: ArcaneHostError(@"CORE_PROCESS_INPUT_CLOSED", @"Core input is closed.", nil));
}

- (void)userContentController:(WKUserContentController *)controller
      didReceiveScriptMessage:(WKScriptMessage *)message replyHandler:(ArcaneHostReply)replyHandler {
    id body = message.body;
    if (![body isKindOfClass:[NSDictionary class]]
        || ![body[@"type"] isKindOfClass:[NSString class]]
        || ![body[@"activation"] isKindOfClass:[NSString class]]) {
        [self rejectReply:replyHandler error:ArcaneHostError(@"CORE_WEBKIT_RECORD_INVALID",
            @"The selected classic source must supply WebKit document lifecycle records.", nil)];
        return;
    }
    NSDictionary *record = [body copy];
    ArcaneHostReply reply = [replyHandler copy];
    [self enqueueOperation:^(ArcaneHostCompletion done) {
        if (self->_closing || self->_processComplete) {
            [self rejectReply:reply error:self->_terminalError ?: ArcaneHostError(
                @"CORE_PROCESS_INPUT_CLOSED", @"Core input is closed.", nil)];
            done();
            return;
        }
        if ([record[@"type"] isEqual:@"activate"]) {
            [self activate:record[@"activation"] reply:reply completion:done];
        } else if ([record[@"type"] isEqual:@"frame"] || [record[@"type"] isEqual:@"retire"]) {
            [self writeRecord:record reply:reply completion:done];
        } else {
            [self rejectReply:reply error:ArcaneHostError(@"CORE_WEBKIT_RECORD_INVALID",
                @"The WebKit transport record has no supported operation.", nil)];
            done();
        }
    } ingress:YES];
}

- (void)activate:(NSString *)activation reply:(ArcaneHostReply)reply completion:(ArcaneHostCompletion)done {
    // WKFrameInfo identifies a frame, not its document. Probe the currently
    // executing realm; every later delivery also checks its activation there.
    [_webView callAsyncJavaScript:@"return typeof globalThis.__arcaneWebKitDocumentCurrent === 'function' && globalThis.__arcaneWebKitDocumentCurrent(activation) === true;"
        arguments:@{@"activation": activation} inFrame:nil inContentWorld:WKContentWorld.pageWorld
        completionHandler:^(id result, NSError *error) {
            if (error || ![result isEqual:@YES] || self->_closing || self->_processComplete) {
                [self rejectReply:reply error:error ?: ArcaneHostError(@"CORE_DOCUMENT_RETIRED",
                    @"The requesting document activation is no longer current.", nil)];
                done();
                return;
            }
            void (^accept)(NSError *) = ^(NSError *writeError) {
                if (writeError || self->_closing || self->_processComplete) {
                    [self rejectReply:reply error:writeError ?: ArcaneHostError(
                        @"CORE_PROCESS_INPUT_CLOSED", @"Core input is closed.", nil)];
                    done();
                    return;
                }
                self->_activation = [activation copy];
                reply(@{@"accepted": @YES}, nil);
                done();
            };
            if (self->_activation && ![self->_activation isEqual:activation]) {
                self->_activation = nil;
                // Existing control cancels request lifetime only. It precedes
                // opening the new ingress; accepted service work stays alive.
                [self writeData:ArcaneCancelRequestsData() completion:accept];
            } else accept(nil);
        }];
}

- (void)writeRecord:(NSDictionary *)record reply:(ArcaneHostReply)reply completion:(ArcaneHostCompletion)done {
    NSString *activation = record[@"activation"];
    if (![_activation isEqual:activation]) {
        [self rejectReply:reply error:ArcaneHostError(@"CORE_DOCUMENT_RETIRED",
            @"The requesting document activation has retired.", nil)];
        done();
        return;
    }
    NSString *json = record[@"json"];
    NSData *data = [json isKindOfClass:[NSString class]] ? [json dataUsingEncoding:NSUTF8StringEncoding] : nil;
    NSError *parseError = nil;
    id frame = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&parseError] : nil;
    if (![frame isKindOfClass:[NSDictionary class]]) {
        [self rejectReply:reply error:ArcaneHostError(@"CORE_WEBKIT_JSON_INVALID",
            @"The WebKit transport requires a complete serialized Core frame.", parseError)];
        done();
        return;
    }
    NSString *requestID = [frame[@"type"] isEqual:@"request"]
        && [frame[@"id"] isKindOfClass:[NSString class]] ? frame[@"id"] : nil;
    if (requestID) _requestActivations[requestID] = activation;
    if ([record[@"type"] isEqual:@"retire"]) _activation = nil;
    // The original string is encoded only at the stdio boundary. Parsing above
    // reads routing fields; it never reconstructs or changes the Core payload.
    [self writeData:data completion:^(NSError *error) {
        if (error) {
            if (requestID) [self->_requestActivations removeObjectForKey:requestID];
            [self rejectReply:reply error:error];
        } else reply(@{@"accepted": @YES}, nil);
        done();
    }];
}

- (void)receiveFrameData:(NSData *)data {
    [_hostDelegate host:self receivedFrameData:data];
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    NSError *error = nil;
    id frame = json ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&error] : nil;
    if (![frame isKindOfClass:[NSDictionary class]]) {
        [self reportError:ArcaneHostError(@"CORE_OUTPUT_JSON_INVALID", @"Core output is not a readable JSON frame.", error)];
        return;
    }
    NSString *activation = nil;
    if ([frame[@"type"] isEqual:@"response"] && [frame[@"id"] isKindOfClass:[NSString class]]) {
        activation = _requestActivations[frame[@"id"]];
        [_requestActivations removeObjectForKey:frame[@"id"]];
    } else if ([frame[@"type"] isEqual:@"event"]) {
        activation = _activation;
    } else {
        [self reportError:ArcaneHostError(@"CORE_OUTPUT_FRAME_INVALID", @"Core output has no supported frame type.", nil)];
        return;
    }
    // No current subscriber/response owner: native diagnostics own the complete
    // frame. A later activation requests current state, not transient history.
    if (!activation) return;
    [self enqueueOperation:^(ArcaneHostCompletion done) {
        [self deliverJSON:json activation:activation completion:done];
    } ingress:NO];
}

- (void)deliverJSON:(NSString *)json activation:(NSString *)activation completion:(ArcaneHostCompletion)done {
    [_webView callAsyncJavaScript:@"return typeof globalThis.__arcaneReceive === 'function' && globalThis.__arcaneReceive(json, activation);"
        arguments:@{@"json": json, @"activation": activation}
        inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id result, NSError *error) {
            if (error) [self reportError:error];
            // false includes an activation retired while WebKit queued this
            // evaluation. The complete frame already reached native diagnostics.
            done();
        }];
}

- (void)deliverFailure:(NSError *)error completion:(ArcaneHostCompletion)done {
    if (!_activation) { done(); return; }
    NSError *representationError = nil;
    NSDictionary *record = ArcaneHostErrorRecord(error, &representationError);
    if (!record) {
        [self reportError:representationError];
        // Report the actual transport representation failure rather than send
        // a partial version of the original native error as if it were complete.
        record = ArcaneHostErrorRecord(representationError, &representationError);
    }
    [_webView callAsyncJavaScript:@"return typeof globalThis.__arcaneTransportFailed === 'function' && globalThis.__arcaneTransportFailed(error, activation);"
        arguments:@{@"error": record, @"activation": _activation}
        inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id result, NSError *evaluationError) {
            if (evaluationError) [self reportError:evaluationError];
            done();
        }];
}

- (void)coreProcess:(ArcaneCoreProcess *)process didLaunch:(pid_t)processIdentifier {
    dispatch_async(dispatch_get_main_queue(), ^{ [self->_hostDelegate host:self didLaunchCoreProcess:processIdentifier]; });
}

- (void)coreProcess:(ArcaneCoreProcess *)process receivedOutputData:(NSData *)data stream:(ArcaneCoreOutputStream)stream {
    dispatch_async(dispatch_get_main_queue(), ^{ [self->_hostDelegate host:self receivedOutputData:data stream:stream]; });
}

- (void)coreProcess:(ArcaneCoreProcess *)process receivedFrameData:(NSData *)data {
    dispatch_async(dispatch_get_main_queue(), ^{ [self receiveFrameData:data]; });
}

- (void)coreProcess:(ArcaneCoreProcess *)process didEncounterError:(NSError *)error {
    dispatch_async(dispatch_get_main_queue(), ^{ [self reportError:error]; });
}

- (void)coreProcess:(ArcaneCoreProcess *)process didExitWithStatus:(int)status reason:(NSTaskTerminationReason)reason {
    dispatch_async(dispatch_get_main_queue(), ^{ [self->_hostDelegate host:self didExitCoreProcessWithStatus:status reason:reason]; });
}

- (void)coreProcess:(ArcaneCoreProcess *)process didCompleteWithErrors:(NSArray<NSError *> *)errors {
    dispatch_async(dispatch_get_main_queue(), ^{
        self->_processComplete = YES;
        self->_terminalError = errors.firstObject ?: ArcaneHostError(@"CORE_PROCESS_CLOSED", @"Core has completed and closed its transport.", nil);
        [self enqueueOperation:^(ArcaneHostCompletion done) {
            [self deliverFailure:self->_terminalError completion:^{
                [self->_hostDelegate host:self coreDidCompleteWithErrors:errors];
                done();
            }];
        } ingress:NO];
    });
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    // An unsuccessful provisional navigation may leave the current document
    // alive. Its connection is owned by shared page lifecycle, not URL changes.
    [self reportError:error];
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    [self reportError:error];
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    [self reportError:ArcaneHostError(@"CORE_WEB_CONTENT_PROCESS_TERMINATED", @"The WebKit content process terminated.", nil)];
    // The callback has no document activation. Keep routing decisions at the
    // shared lifecycle seam: a later confirmed activation cancels prior request
    // lifetime before opening its ingress; the caller can also close the host.
}

- (void)close { [self closeWithCompletion:nil]; }

- (void)closeWithCompletion:(void (^)(NSArray<NSError *> *errors))completion {
    if (_closed) { if (completion) completion([_errors copy]); return; }
    if (completion) [_closeCompletions addObject:[completion copy]];
    if (!_closing) {
        _closing = YES;
        _closingOwner = self;
        [_process closeInput];
    }
    [self finishCloseIfReady];
}

- (BOOL)windowShouldClose:(NSWindow *)sender {
    [self closeWithCompletion:nil];
    return _closed;
}

- (void)windowWillClose:(NSNotification *)notification {
    _windowClosed = YES;
    [self closeWithCompletion:nil];
}

- (void)finishCloseIfReady {
    if (!_closing || _closed || !_processComplete || _ingressRunning || _deliveryRunning
        || _ingressOperations.count || _deliveries.count) return;
    _closed = YES;
    if (!_windowClosed) [super close];
    [_contentController removeScriptMessageHandlerForName:@"arcane" contentWorld:WKContentWorld.pageWorld];
    _webView.navigationDelegate = nil;
    self.window.delegate = nil;
    _activation = nil;
    [_requestActivations removeAllObjects];
    _process = nil;
    NSArray *completions = [_closeCompletions copy];
    [_closeCompletions removeAllObjects];
    NSArray<NSError *> *errors = [_errors copy];
    for (void (^completion)(NSArray<NSError *> *) in completions) completion(errors);
    _hostDelegate = nil;
    _closingOwner = nil;
}
@end

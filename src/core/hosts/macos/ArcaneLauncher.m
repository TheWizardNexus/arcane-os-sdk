#import "ArcaneHost.h"
#import <dispatch/dispatch.h>

static NSError *ArcaneLauncherError(NSString *code, NSString *message, id detail) {
    NSMutableDictionary *info = [@{NSLocalizedDescriptionKey: message, @"code": code} mutableCopy];
    if (detail) info[@"detail"] = detail;
    return [NSError errorWithDomain:@"ArcaneLauncher" code:1 userInfo:info];
}

static NSString *ArcaneAbsolutePath(NSString *filename, NSString *directory) {
    return [(filename.isAbsolutePath ? filename : [directory stringByAppendingPathComponent:filename])
        stringByStandardizingPath];
}

static NSDictionary *ArcaneReadRecord(NSURL *url, NSError **error) {
    NSData *data = [NSData dataWithContentsOfURL:url options:0 error:error];
    if (!data) return nil;
    id record = [NSJSONSerialization JSONObjectWithData:data options:0 error:error];
    if (!record) return nil;
    if (![record isKindOfClass:NSDictionary.class]) {
        *error = ArcaneLauncherError(@"CORE_LAUNCH_RECORD_INVALID", @"The selected file must contain a JSON object.", url);
        return nil;
    }
    return record;
}

static NSString *ArcaneRequiredString(NSDictionary *record, NSString *key, NSError **error) {
    id value = record[key];
    if ([value isKindOfClass:NSString.class] && [value length]) return value;
    *error = ArcaneLauncherError(@"CORE_LAUNCH_MANIFEST_INVALID",
        [NSString stringWithFormat:@"The native manifest needs a string at %@.", key], record);
    return nil;
}

static BOOL ArcaneExpectedDocumentCancellation(NSError *error) {
    return ([error.domain isEqual:NSURLErrorDomain] && error.code == NSURLErrorCancelled)
        || [error.userInfo[@"code"] isEqual:@"CORE_DOCUMENT_RETIRED"];
}

typedef NS_ENUM(NSUInteger, ArcaneDiagnosticStream) {
    ArcaneDiagnosticNative,
    ArcaneDiagnosticStandardOutput,
    ArcaneDiagnosticStandardError
};

@interface ArcaneLauncher : NSObject <NSApplicationDelegate, ArcaneHostDelegate> {
    ArcaneHost *_host;
    NSString *_title;
    NSString *_stateRoot;
    NSString *_workingDirectory;
    NSString *_launchFilename;
    NSDictionary *_launchContext;
    NSFileHandle *_nativeLog;
    NSFileHandle *_stdoutLog;
    NSFileHandle *_stderrLog;
    dispatch_queue_t _diagnosticQueue;
    BOOL _diagnosticsScheduled;
    BOOL _diagnosticFailed;
    BOOL _closeOnInputEnd;
    BOOL _terminationRequested;
    BOOL _finished;
    BOOL _failurePresented;
    BOOL _webReady;
    int _exitStatus;
}
@property(nonatomic, readonly) int exitStatus;
@end

@implementation ArcaneLauncher

- (instancetype)init {
    self = [super init];
    if (self) _diagnosticQueue = dispatch_queue_create("org.arcane.launcher.diagnostics", DISPATCH_QUEUE_SERIAL);
    return self;
}

- (int)exitStatus { return _exitStatus; }

- (NSFileHandle *)openLog:(NSString *)name inDirectory:(NSString *)directory error:(NSError **)error {
    NSURL *url = [NSURL fileURLWithPath:[directory stringByAppendingPathComponent:name]];
    if (![NSData.data writeToURL:url options:NSDataWritingWithoutOverwriting error:error]) return nil;
    return [NSFileHandle fileHandleForWritingToURL:url error:error];
}

- (BOOL)openDiagnosticsAtRoot:(NSString *)stateRoot error:(NSError **)error {
    NSString *directory = [stateRoot stringByAppendingPathComponent:@"Diagnostics"];
    if (![NSFileManager.defaultManager createDirectoryAtPath:directory
        withIntermediateDirectories:YES attributes:nil error:error]) return NO;
    NSString *name = [NSString stringWithFormat:@"launch-%d-%@", NSProcessInfo.processInfo.processIdentifier, NSUUID.UUID.UUIDString];
    _nativeLog = [self openLog:[name stringByAppendingString:@".jsonl"] inDirectory:directory error:error];
    if (!_nativeLog) return NO;
    _stdoutLog = [self openLog:[name stringByAppendingString:@".stdout"] inDirectory:directory error:error];
    if (!_stdoutLog) return NO;
    _stderrLog = [self openLog:[name stringByAppendingString:@".stderr"] inDirectory:directory error:error];
    return _stderrLog != nil;
}

- (void)scheduleDiagnostics {
    if (_diagnosticsScheduled) return;
    _diagnosticsScheduled = YES;
    NSString *stateRoot = _stateRoot ?: [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/Arcane"];
    // Setup precedes writes on this queue, not application startup. An
    // unavailable directory leaves complete stderr delivery operational.
    dispatch_async(_diagnosticQueue, ^{
        NSError *error = nil;
        @try {
            if ([self openDiagnosticsAtRoot:stateRoot error:&error]) return;
        } @catch (NSException *exception) {
            error = ArcaneLauncherError(@"CORE_DIAGNOSTIC_OPEN_FAILED", exception.reason ?: exception.name,
                @{ @"name": exception.name, @"userInfo": exception.userInfo ?: @{}, @"callStackSymbols": exception.callStackSymbols });
        }
        self->_diagnosticFailed = YES;
        [self writeDiagnosticError:error ?: ArcaneLauncherError(@"CORE_DIAGNOSTIC_OPEN_FAILED",
            @"The application diagnostic files could not be opened.", nil) toLog:self->_nativeLog];
    });
}

- (void)writeDiagnosticData:(NSData *)data toLog:(NSFileHandle *)log {
    NSError *error = nil;
    if (log && ![log writeData:data error:&error]) {
        _diagnosticFailed = YES;
        // The original chunk is still sent intact to stderr even if its file
        // becomes unavailable. Log failures must remain visible too.
        NSLog(@"Arcane diagnostic file failed: %@", error);
    }
    error = nil;
    if (![NSFileHandle.fileHandleWithStandardError writeData:data error:&error]) {
        _diagnosticFailed = YES;
        NSLog(@"Arcane diagnostic stderr failed: %@", error);
    }
}

- (void)writeData:(NSData *)data stream:(ArcaneDiagnosticStream)stream {
    // Retain the entire native chunk and preserve enqueue order without making
    // the main-thread delegate wait for a file or a redirected stderr reader.
    dispatch_async(_diagnosticQueue, ^{
        NSFileHandle *log = stream == ArcaneDiagnosticNative ? self->_nativeLog
            : stream == ArcaneDiagnosticStandardOutput ? self->_stdoutLog : self->_stderrLog;
        [self writeDiagnosticData:data toLog:log];
    });
}

- (void)writeDiagnosticError:(NSError *)error toLog:(NSFileHandle *)log {
    // Foundation's archive preserves the complete native NSError/userInfo
    // graph, including nested causes, URLs and binary values. JSON carries the
    // reversible archive, not a shortened description of that native graph.
    NSError *archiveError = nil;
    NSData *archive = nil;
    @try {
        archive = [NSKeyedArchiver archivedDataWithRootObject:error requiringSecureCoding:NO error:&archiveError];
    } @catch (NSException *exception) {
        archiveError = ArcaneLauncherError(@"CORE_DIAGNOSTIC_ARCHIVE_FAILED", exception.reason ?: exception.name,
            @{ @"name": exception.name, @"userInfo": exception.userInfo ?: @{} });
    }
    NSMutableDictionary *record = [@{ @"kind": @"native-error", @"domain": error.domain,
        @"nativeCode": @(error.code), @"message": error.localizedDescription } mutableCopy];
    if (archive) record[@"nativeArchiveBase64"] = [archive base64EncodedStringWithOptions:0];
    else {
        _diagnosticFailed = YES;
        // No partial representation is claimed to be the complete native error.
        record[@"representationFailure"] = archiveError.localizedDescription ?: @"The native error could not be archived.";
        NSLog(@"Arcane native diagnostic could not be archived: %@; original: %@", archiveError, error);
    }
    NSError *jsonError = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:record options:0 error:&jsonError];
    if (json) {
        NSMutableData *line = [json mutableCopy];
        [line appendData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
        [self writeDiagnosticData:line toLog:log];
    } else {
        _diagnosticFailed = YES;
        NSLog(@"Arcane diagnostic serialization failed: %@; original: %@", jsonError, error);
    }
}

- (void)recordError:(NSError *)error {
    if (!ArcaneExpectedDocumentCancellation(error)) _exitStatus = 1;
    dispatch_async(_diagnosticQueue, ^{ [self writeDiagnosticError:error toLog:self->_nativeLog]; });
}

- (void)presentFailure:(NSString *)message {
    _exitStatus = 1;
    if (_terminationRequested || _finished) return;
    if (_closeOnInputEnd) { [NSApp terminate:nil]; return; }
    if (_failurePresented) return;
    _failurePresented = YES;
    NSAlert *alert = [[NSAlert alloc] init];
    alert.alertStyle = NSAlertStyleCritical;
    alert.messageText = message;
    alert.informativeText = @"Close the application and try opening it again.";
    [alert addButtonWithTitle:@"Close Application"];
    if (_host.window.visible) {
        [alert beginSheetModalForWindow:_host.window completionHandler:^(NSModalResponse response) {
            [NSApp terminate:nil];
        }];
    } else {
        [alert runModal];
        [NSApp terminate:nil];
    }
}

- (BOOL)prepareAndOpen:(NSError **)error {
    _workingDirectory = NSFileManager.defaultManager.currentDirectoryPath;
    NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
    for (NSUInteger index = 1; index < arguments.count; index++) {
        NSString *argument = arguments[index];
        if ([argument isEqual:@"--arcane-launch-config"]) {
            if (++index == arguments.count || ![arguments[index] length]) {
                *error = ArcaneLauncherError(@"CORE_LAUNCH_ARGUMENT_INVALID", @"--arcane-launch-config needs a filename.", nil);
                return NO;
            }
            _launchFilename = ArcaneAbsolutePath(arguments[index], _workingDirectory);
        } else if ([argument isEqual:@"--close-on-stdin-eof"]) _closeOnInputEnd = YES;
        else {
            *error = ArcaneLauncherError(@"CORE_LAUNCH_ARGUMENT_INVALID", @"Unknown launcher argument.", argument);
            return NO;
        }
    }

    NSURL *resources = NSBundle.mainBundle.resourceURL;
    NSDictionary *manifest = ArcaneReadRecord([resources URLByAppendingPathComponent:@"arcane-native.json"], error);
    if (!manifest) return NO;
    NSDictionary *app = manifest[@"app"];
    NSDictionary *client = manifest[@"client"];
    NSDictionary *core = manifest[@"core"];
    if (![app isKindOfClass:NSDictionary.class] || ![client isKindOfClass:NSDictionary.class]
        || ![core isKindOfClass:NSDictionary.class]) {
        *error = ArcaneLauncherError(@"CORE_LAUNCH_MANIFEST_INVALID", @"The native manifest needs app, client and core records.", manifest);
        return NO;
    }
    NSString *appID = ArcaneRequiredString(app, @"id", error);
    if (!appID) return NO;
    _title = [app[@"displayName"] isKindOfClass:NSString.class] ? app[@"displayName"] : appID;
    id defaults = manifest[@"launchContext"];
    if (defaults && ![defaults isKindOfClass:NSDictionary.class]) {
        *error = ArcaneLauncherError(@"CORE_LAUNCH_MANIFEST_INVALID", @"The native launchContext must be an object.", defaults);
        return NO;
    }
    NSMutableDictionary *launchContext = defaults ? [defaults mutableCopy] : [NSMutableDictionary dictionary];
    if (_launchFilename) {
        NSDictionary *explicitContext = ArcaneReadRecord([NSURL fileURLWithPath:_launchFilename], error);
        if (!explicitContext) return NO;
        [launchContext addEntriesFromDictionary:explicitContext];
    }
    _launchContext = launchContext;
    // The opted-in Node resolver uses HOME when supplied; retain the previous
    // native default unchanged for applications without launchContext.
    NSString *nativeHome = defaults ? (NSProcessInfo.processInfo.environment[@"HOME"] ?: NSHomeDirectory()) : NSHomeDirectory();
    id selectedState = _launchContext[@"stateRoot"];
    _stateRoot = [selectedState isKindOfClass:NSString.class]
        ? ArcaneAbsolutePath(selectedState, _workingDirectory)
        : [[nativeHome stringByAppendingPathComponent:@"Library/Application Support/Arcane"] stringByAppendingPathComponent:appID];
    [self scheduleDiagnostics];
    NSString *clientPath = ArcaneRequiredString(client, @"source", error);
    if (!clientPath) return NO;
    NSString *corePath = ArcaneRequiredString(core, @"entry", error);
    if (!corePath) return NO;
    NSString *classic = [NSString stringWithContentsOfURL:[resources URLByAppendingPathComponent:clientPath]
        encoding:NSUTF8StringEncoding error:error];
    if (!classic) return NO;
    NSMutableArray<NSString *> *coreArguments = [NSMutableArray arrayWithObjects:
        [resources URLByAppendingPathComponent:corePath].path,
        @"--arcane-host-state-root", _stateRoot, nil];
    if (_launchFilename) [coreArguments addObjectsFromArray:@[@"--arcane-launch-config", _launchFilename]];

    NSMenu *menu = [[NSMenu alloc] initWithTitle:_title];
    NSMenuItem *applicationItem = [[NSMenuItem alloc] initWithTitle:_title action:nil keyEquivalent:@""];
    NSMenu *applicationMenu = [[NSMenu alloc] initWithTitle:_title];
    [applicationMenu addItemWithTitle:[@"Quit " stringByAppendingString:_title] action:@selector(terminate:) keyEquivalent:@"q"];
    applicationItem.submenu = applicationMenu;
    [menu addItem:applicationItem];
    NSApp.mainMenu = menu;

    // The generated bundle ID owns its persistent default WebKit store on
    // macOS 11+. stateRoot is Core/diagnostic storage, not a WebKit profile path.
    _host = [ArcaneHost openApplicationURL:nil websiteDataStore:WKWebsiteDataStore.defaultDataStore
        title:_title contentFrame:NSMakeRect(0, 0, 1100, 760) classicSource:classic
        executableURL:[resources URLByAppendingPathComponent:@"runtime/node"] arguments:coreArguments
        workingDirectoryURL:[NSURL fileURLWithPath:_workingDirectory isDirectory:YES] delegate:self];
    [NSApp activateIgnoringOtherApps:YES];
    if (_closeOnInputEnd) [self observeRunnerInput];
    return YES;
}

- (void)observeRunnerInput {
    // The opt-in pipe signals runner lifetime only. It never holds the window
    // or the Core drain open when the user closes the application first.
    __weak ArcaneLauncher *owner = self;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        @autoreleasepool {
            NSError *error = nil;
            NSFileHandle *input = NSFileHandle.fileHandleWithStandardInput;
            for (;;) {
                NSData *chunk = [input readDataUpToLength:4096 error:&error];
                if (!chunk || !chunk.length) break;
            }
            dispatch_async(dispatch_get_main_queue(), ^{
                ArcaneLauncher *launcher = owner;
                if (!launcher || launcher->_finished) return;
                if (error) [launcher recordError:error];
                [NSApp terminate:nil];
            });
        }
    });
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    NSError *error = nil;
    @try {
        if ([self prepareAndOpen:&error]) return;
    } @catch (NSException *exception) {
        error = ArcaneLauncherError(@"CORE_LAUNCH_FAILED", exception.reason ?: exception.name,
            @{ @"name": exception.name, @"userInfo": exception.userInfo ?: @{}, @"callStackSymbols": exception.callStackSymbols });
    }
    [self scheduleDiagnostics];
    [self recordError:error ?: ArcaneLauncherError(@"CORE_LAUNCH_FAILED", @"Application startup failed.", nil)];
    [self presentFailure:@"The application could not start."];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return YES; }

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    if (_terminationRequested) return NSTerminateLater;
    _terminationRequested = YES;
    // Reply after this callback returns, even if startup failed before a host
    // existed or a directly closed window has already completed its drain.
    dispatch_async(dispatch_get_main_queue(), ^{
        void (^finished)(NSArray<NSError *> *) = ^(NSArray<NSError *> *errors) {
            for (NSError *error in errors) [self recordError:error];
            self->_finished = YES;
            [sender replyToApplicationShouldTerminate:NO];
            // Keep a natural main return with the real failure status instead
            // of AppKit's unconditional successful process termination.
            dispatch_async(dispatch_get_main_queue(), ^{
                [sender stop:nil];
                [sender postEvent:[NSEvent otherEventWithType:NSEventTypeApplicationDefined
                    location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil
                    subtype:0 data1:0 data2:0] atStart:NO];
            });
        };
        if (self->_host) [self->_host closeWithCompletion:finished];
        else finished(@[]);
    });
    return NSTerminateLater;
}

- (void)host:(ArcaneHost *)host didLaunchCoreProcess:(pid_t)processIdentifier {
    NSData *data = [[NSString stringWithFormat:@"{\"kind\":\"core-process-started\",\"pid\":%d}\n", processIdentifier]
        dataUsingEncoding:NSUTF8StringEncoding];
    [self writeData:data stream:ArcaneDiagnosticNative];
}

- (void)host:(ArcaneHost *)host receivedOutputData:(NSData *)data stream:(ArcaneCoreOutputStream)stream {
    [self writeData:data stream:stream == ArcaneCoreStandardOutput
        ? ArcaneDiagnosticStandardOutput : ArcaneDiagnosticStandardError];
}

- (void)host:(ArcaneHost *)host receivedFrameData:(NSData *)data {
    NSError *error = nil;
    id frame = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
    // ArcaneHost diagnoses unreadable frames. Raw transport data has already
    // reached the diagnostic owner, including all unrecognized event fields.
    if (![frame isKindOfClass:NSDictionary.class] || ![frame[@"type"] isEqual:@"event"]) return;
    id detail = frame[@"data"];
    if ([frame[@"event"] isEqual:@"core.web.ready"]) {
        if (_webReady || _terminationRequested) return;
        NSString *url = [detail isKindOfClass:NSDictionary.class] ? detail[@"url"] : nil;
        NSURL *applicationURL = [url isKindOfClass:NSString.class] ? [NSURL URLWithString:url] : nil;
        if (!applicationURL.scheme || !applicationURL.host) {
            [self recordError:ArcaneLauncherError(@"CORE_WEB_READY_INVALID", @"The packaged-web ready event has no application URL.", frame)];
            [self presentFailure:@"The application could not open."];
            return;
        }
        _webReady = YES;
        [host loadApplicationURL:applicationURL];
    } else if ([frame[@"event"] isEqual:@"core.web.failed"]
        || ([frame[@"event"] isEqual:@"core.service.state"]
            && [detail isKindOfClass:NSDictionary.class]
            && [detail[@"name"] isEqual:@"packaged-web"] && [detail[@"state"] isEqual:@"failed"])) {
        // Complete serialized service errors stay in the raw frame log, never
        // in the ordinary native alert or the application's chat history.
        [self presentFailure:_webReady ? @"The application connection stopped." : @"The application could not start."];
    }
}

- (void)host:(ArcaneHost *)host didEncounterError:(NSError *)error {
    [self recordError:error];
    if (!_terminationRequested && !ArcaneExpectedDocumentCancellation(error)) {
        [self presentFailure:@"The application encountered an error."];
    }
}

- (void)host:(ArcaneHost *)host didExitCoreProcessWithStatus:(int)status reason:(NSTaskTerminationReason)reason {
    if (status != 0 || reason != NSTaskTerminationReasonExit) _exitStatus = 1;
    NSData *data = [[NSString stringWithFormat:@"{\"kind\":\"core-process-exited\",\"status\":%d,\"reason\":%ld}\n", status, (long)reason]
        dataUsingEncoding:NSUTF8StringEncoding];
    [self writeData:data stream:ArcaneDiagnosticNative];
}

- (void)host:(ArcaneHost *)host coreDidCompleteWithErrors:(NSArray<NSError *> *)errors {
    for (NSError *error in errors) [self recordError:error];
    if (_terminationRequested) return;
    if (host.isClosing) {
        // A title-bar close already requested the host-owned drain. Join that
        // same completion instead of treating its EOF as a runtime failure.
        [NSApp terminate:nil];
        return;
    }
    [self recordError:ArcaneLauncherError(@"CORE_PROCESS_ENDED_UNEXPECTEDLY",
        _webReady ? @"Core completed without an application or host close request."
            : @"Core completed before the packaged web listener became ready, without a close request.",
        @{ @"webReady": @(_webReady), @"errors": errors })];
    [self presentFailure:_webReady ? @"The application connection stopped." : @"The application could not start."];
}

- (void)closeDiagnostics {
    // AppKit and Core are already drained. This is the first consumer that
    // needs durable completion of every accepted diagnostic write.
    dispatch_sync(_diagnosticQueue, ^{
        for (id file in @[self->_nativeLog ?: NSNull.null, self->_stdoutLog ?: NSNull.null, self->_stderrLog ?: NSNull.null]) {
            if (![file isKindOfClass:NSFileHandle.class]) continue;
            NSError *error = nil;
            if (![file closeAndReturnError:&error]) {
                self->_diagnosticFailed = YES;
                [self writeDiagnosticError:error toLog:nil];
            }
        }
    });
    if (_diagnosticFailed) _exitStatus = 1;
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *application = NSApplication.sharedApplication;
        [application setActivationPolicy:NSApplicationActivationPolicyRegular];
        ArcaneLauncher *launcher = [[ArcaneLauncher alloc] init];
        application.delegate = launcher;
        [application run];
        [launcher closeDiagnostics];
        return launcher.exitStatus;
    }
}

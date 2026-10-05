#import "ArcaneCoreProcess.h"
#import <dispatch/dispatch.h>
#import <errno.h>
#import <fcntl.h>

static NSError *ArcaneProcessError(NSString *code, NSString *message,
                                  NSString *operation, NSError *underlying) {
    NSMutableDictionary *details = [@{NSLocalizedDescriptionKey: message,
        @"code": code, @"operation": operation} mutableCopy];
    if (underlying) details[NSUnderlyingErrorKey] = underlying;
    return [NSError errorWithDomain:@"ArcaneCoreProcess" code:1 userInfo:details];
}

static NSError *ArcaneProcessException(NSException *exception, NSString *operation) {
    return [NSError errorWithDomain:@"ArcaneCoreProcess" code:1 userInfo:@{
        NSLocalizedDescriptionKey: exception.reason ?: exception.name,
        @"code": @"CORE_PROCESS_EXCEPTION", @"operation": operation,
        @"exceptionName": exception.name, @"exceptionInfo": exception.userInfo ?: @{},
        @"callStackSymbols": exception.callStackSymbols
    }];
}

@interface ArcaneCoreProcess () {
    NSURL *_executableURL;
    NSArray<NSString *> *_arguments;
    NSURL *_workingDirectoryURL;
    id<ArcaneCoreProcessDelegate> _delegate;
    NSLock *_state;
    NSMutableArray<NSError *> *_errors;
    dispatch_queue_t _inputQueue;
    dispatch_group_t _lifetime;
    NSTask *_task;
    NSFileHandle *_input;
    NSError *_inputFailure;
    BOOL _accepting;
    BOOL _closeQueued;
    pid_t _processIdentifier;
}
- (instancetype)initExecutableURL:(NSURL *)executableURL
                        arguments:(NSArray<NSString *> *)arguments
              workingDirectoryURL:(NSURL *)workingDirectoryURL
                         delegate:(id<ArcaneCoreProcessDelegate>)delegate;
@end

@implementation ArcaneCoreProcess

+ (instancetype)startExecutableURL:(NSURL *)executableURL
                        arguments:(NSArray<NSString *> *)arguments
              workingDirectoryURL:(NSURL *)workingDirectoryURL
                         delegate:(id<ArcaneCoreProcessDelegate>)delegate {
    if (!executableURL || !arguments || !workingDirectoryURL || !delegate) {
        [NSException raise:NSInvalidArgumentException
                    format:@"Select a Core executable, arguments, working directory and delegate."];
    }
    ArcaneCoreProcess *process = [[self alloc] initExecutableURL:executableURL
        arguments:arguments workingDirectoryURL:workingDirectoryURL delegate:delegate];
    [process start];
    return process;
}

- (instancetype)initExecutableURL:(NSURL *)executableURL
                        arguments:(NSArray<NSString *> *)arguments
              workingDirectoryURL:(NSURL *)workingDirectoryURL
                         delegate:(id<ArcaneCoreProcessDelegate>)delegate {
    self = [super init];
    if (self) {
        _executableURL = [executableURL copy];
        _arguments = [[NSArray alloc] initWithArray:arguments copyItems:YES];
        _workingDirectoryURL = [workingDirectoryURL copy];
        _delegate = delegate;
        _state = [[NSLock alloc] init];
        _errors = [NSMutableArray array];
        _inputQueue = dispatch_queue_create("arcane.core.macos.input", DISPATCH_QUEUE_SERIAL);
        _lifetime = dispatch_group_create();
        _accepting = YES;
    }
    return self;
}

- (pid_t)processIdentifier {
    [_state lock];
    pid_t result = _processIdentifier;
    [_state unlock];
    return result;
}

- (void)reportError:(NSError *)error {
    [_state lock];
    [_errors addObject:error];
    [_state unlock];
    [_delegate coreProcess:self didEncounterError:error];
}

- (void)start {
    // Startup and stdin each retain ownership until their actual completion.
    dispatch_group_enter(_lifetime);
    dispatch_group_enter(_lifetime);
    dispatch_async(_inputQueue, ^{ [self launch]; });
    dispatch_group_notify(_lifetime, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        [self complete];
    });
}

- (void)launch {
    @autoreleasepool {
        NSPipe *inputPipe = nil;
        NSPipe *outputPipe = nil;
        NSPipe *errorPipe = nil;
        NSError *launchError = nil;
        BOOL launched = NO;
        @try {
            inputPipe = [NSPipe pipe];
            outputPipe = [NSPipe pipe];
            errorPipe = [NSPipe pipe];
            _input = inputPipe.fileHandleForWriting;
            _task = [[NSTask alloc] init];
            _task.executableURL = _executableURL;
            _task.arguments = _arguments;
            _task.currentDirectoryURL = _workingDirectoryURL;
            _task.standardInput = inputPipe;
            _task.standardOutput = outputPipe;
            _task.standardError = errorPipe;
            // A closed child pipe must produce an observable EPIPE write error,
            // not terminate the host. This affects this descriptor only.
            if (fcntl(_input.fileDescriptor, F_SETNOSIGPIPE, 1) == -1) {
                launchError = [NSError errorWithDomain:NSPOSIXErrorDomain code:errno userInfo:nil];
            } else {
                launched = [_task launchAndReturnError:&launchError];
            }
        }
        @catch (NSException *exception) { launchError = ArcaneProcessException(exception, @"launch"); }
        if (!launched) {
            _inputFailure = ArcaneProcessError(@"CORE_PROCESS_START_FAILED",
                @"The selected Core executable did not start.", @"launch", launchError);
            [self reportError:_inputFailure];
            [self closeInput];
            // No child owns these handles after a failed launch. Their pipe
            // objects release unused ends; stdin still follows the input queue.
            _task = nil;
            dispatch_group_leave(_lifetime);
            return;
        }
        [_state lock];
        _processIdentifier = _task.processIdentifier;
        [_state unlock];
        [_delegate coreProcess:self didLaunch:_processIdentifier];

        // Exactly two stream readers and one exit observer per child. Each
        // reader invokes its consumer before reading again, applying stream
        // backpressure without a second unbounded callback queue.
        dispatch_group_async(_lifetime, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            [self readOutput:outputPipe.fileHandleForReading stream:ArcaneCoreStandardOutput];
        });
        dispatch_group_async(_lifetime, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            [self readOutput:errorPipe.fileHandleForReading stream:ArcaneCoreStandardError];
        });
        dispatch_group_async(_lifetime, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            [self observeExit];
        });
        dispatch_group_leave(_lifetime);
    }
}

- (BOOL)sendJSONData:(NSData *)data
         completion:(void (^)(NSError * _Nullable error))completion
              error:(NSError * _Nullable * _Nullable)error {
    if (!data || !completion) {
        if (error) *error = ArcaneProcessError(@"CORE_PROCESS_SEND_INVALID",
            @"Supply complete JSON data and a write completion callback.", @"write", nil);
        return NO;
    }
    NSData *body = [data copy];
    [_state lock];
    if (!_accepting) {
        [_state unlock];
        if (error) *error = ArcaneProcessError(@"CORE_PROCESS_INPUT_CLOSED",
            @"Core input no longer accepts requests.", @"write", nil);
        return NO;
    }
    dispatch_group_enter(_lifetime);
    // Enqueue under the same lock as closeInput: every accepted frame precedes
    // the close, even when callers submit and close from different threads.
    dispatch_async(_inputQueue, ^{
        @autoreleasepool {
            NSError *writeError = self->_inputFailure;
            if (!writeError) {
                NSString *header = [NSString stringWithFormat:@"Content-Length: %lu\r\n\r\n",
                    (unsigned long)body.length];
                @try {
                    if (![self->_input writeData:[header dataUsingEncoding:NSASCIIStringEncoding] error:&writeError]
                        || ![self->_input writeData:body error:&writeError]) {
                        writeError = ArcaneProcessError(@"CORE_PROCESS_WRITE_FAILED",
                            @"The complete Core frame could not be written.", @"write", writeError);
                    }
                } @catch (NSException *exception) {
                    writeError = ArcaneProcessException(exception, @"write");
                }
                if (writeError) {
                    self->_inputFailure = writeError;
                    [self reportError:writeError];
                    [self closeInput];
                }
            }
            completion(writeError);
            dispatch_group_leave(self->_lifetime);
        }
    });
    [_state unlock];
    return YES;
}

- (void)closeInput {
    [_state lock];
    if (_closeQueued) { [_state unlock]; return; }
    _accepting = NO;
    _closeQueued = YES;
    dispatch_async(_inputQueue, ^{
        [self closeHandle:self->_input operation:@"stdin.close"];
        self->_input = nil;
        dispatch_group_leave(self->_lifetime);
    });
    [_state unlock];
}

- (void)closeHandle:(NSFileHandle *)handle operation:(NSString *)operation {
    if (!handle) return;
    NSError *error = nil;
    @try {
        if (![handle closeAndReturnError:&error]) {
            error = ArcaneProcessError(@"CORE_PROCESS_CLOSE_FAILED",
                @"A Core pipe could not be closed.", operation, error);
        }
    }
    @catch (NSException *exception) { error = ArcaneProcessException(exception, operation); }
    if (error) [self reportError:error];
}

- (BOOL)readContentLength:(NSData *)header result:(NSUInteger *)result {
    NSString *text = [[NSString alloc] initWithData:header encoding:NSASCIIStringEncoding];
    if (!text) return NO;
    BOOL found = NO;
    for (NSString *line in [text componentsSeparatedByString:@"\r\n"]) {
        NSRange colon = [line rangeOfString:@":"];
        if (colon.location == NSNotFound) continue;
        if ([[line substringToIndex:colon.location] caseInsensitiveCompare:@"Content-Length"] != NSOrderedSame) continue;
        if (found) return NO;
        NSString *value = [[line substringFromIndex:colon.location + 1]
            stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        if (!value.length) return NO;
        NSUInteger length = 0;
        for (NSUInteger index = 0; index < value.length; index++) {
            unichar digit = [value characterAtIndex:index];
            if (digit < '0' || digit > '9') return NO;
            NSUInteger next = (NSUInteger)(digit - '0');
            // This is representability of the unavoidable framing field.
            if (length > (NSUIntegerMax - next) / 10) return NO;
            length = length * 10 + next;
        }
        *result = length;
        found = YES;
    }
    return found;
}

- (void)readOutput:(NSFileHandle *)handle stream:(ArcaneCoreOutputStream)stream {
    @autoreleasepool {
        NSMutableData *pending = [NSMutableData data];
        NSData *separator = [@"\r\n\r\n" dataUsingEncoding:NSASCIIStringEncoding];
        BOOL readingBody = NO;
        BOOL decoding = YES;
        NSUInteger expected = 0;
        BOOL reachedEOF = NO;
        while (!reachedEOF) {
            @autoreleasepool {
                NSError *readError = nil;
                NSData *chunk = nil;
                @try { chunk = [handle readDataUpToLength:65536 error:&readError]; }
                @catch (NSException *exception) { readError = ArcaneProcessException(exception, @"read"); }
                if (!chunk) {
                    [self reportError:ArcaneProcessError(@"CORE_PROCESS_READ_FAILED",
                        @"A Core output stream could not be read.",
                        stream == ArcaneCoreStandardOutput ? @"stdout.read" : @"stderr.read", readError)];
                    [self closeInput];
                    break;
                }
                if (!chunk.length) { reachedEOF = YES; break; }
                [_delegate coreProcess:self receivedOutputData:chunk stream:stream];
                if (stream != ArcaneCoreStandardOutput || !decoding) continue;
                [pending appendData:chunk];
                for (;;) {
                    if (!readingBody) {
                        NSRange marker = [pending rangeOfData:separator options:0
                            range:NSMakeRange(0, pending.length)];
                        if (marker.location == NSNotFound) break;
                        NSData *header = [pending subdataWithRange:NSMakeRange(0, marker.location)];
                        if (![self readContentLength:header result:&expected]) {
                            decoding = NO;
                            [self reportError:ArcaneProcessError(@"IPC_LENGTH_INVALID",
                                @"Core stdout contains an unreadable Content-Length frame header.", @"stdout.frame", nil)];
                            [self closeInput];
                            break;
                        }
                        [pending replaceBytesInRange:NSMakeRange(0, NSMaxRange(marker)) withBytes:NULL length:0];
                        readingBody = YES;
                    }
                    if (pending.length < expected) break;
                    NSData *frame = [pending subdataWithRange:NSMakeRange(0, expected)];
                    [pending replaceBytesInRange:NSMakeRange(0, expected) withBytes:NULL length:0];
                    readingBody = NO;
                    [_delegate coreProcess:self receivedFrameData:frame];
                }
            }
        }
        if (stream == ArcaneCoreStandardOutput && reachedEOF && decoding && (readingBody || pending.length)) {
            [self reportError:ArcaneProcessError(@"IPC_FRAME_INCOMPLETE",
                @"Core stdout ended during a frame.", @"stdout.frame", nil)];
            [self closeInput];
        }
        [self closeHandle:handle operation:stream == ArcaneCoreStandardOutput ? @"stdout.close" : @"stderr.close"];
    }
}

- (void)observeExit {
    @autoreleasepool {
        // Only this background owner waits. Output readers remain independent.
        int status;
        NSTaskTerminationReason reason;
        @try {
            [_task waitUntilExit];
            status = _task.terminationStatus;
            reason = _task.terminationReason;
        } @catch (NSException *exception) {
            [self reportError:ArcaneProcessException(exception, @"exit.observe")];
            [self closeInput];
            return;
        }
        [self closeInput];
        if (status != 0 || reason != NSTaskTerminationReasonExit) {
            [self reportError:[NSError errorWithDomain:@"ArcaneCoreProcess" code:status userInfo:@{
                NSLocalizedDescriptionKey: @"Core exited without a successful normal completion.",
                @"code": @"CORE_PROCESS_EXIT_FAILED", @"operation": @"exit",
                @"terminationStatus": @(status), @"terminationReason": @(reason)
            }]];
        }
        [_delegate coreProcess:self didExitWithStatus:status reason:reason];
    }
}

- (void)complete {
    [_state lock];
    NSArray<NSError *> *errors = [_errors copy];
    [_state unlock];
    [_delegate coreProcess:self didCompleteWithErrors:errors];
    _delegate = nil;
    _task = nil;
}
@end

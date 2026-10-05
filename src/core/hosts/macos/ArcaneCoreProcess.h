#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@class ArcaneCoreProcess;

typedef NS_ENUM(NSUInteger, ArcaneCoreOutputStream) {
    ArcaneCoreStandardOutput,
    ArcaneCoreStandardError
};

/**
 * Callbacks run on process-owned background queues. Each output stream retains
 * its order; different streams, writes and exit observation can be concurrent.
 * Marshal UI work at the host. Callbacks must return normally and must not wait
 * for another callback or for completion. The process retains its delegate
 * through didCompleteWithErrors, then releases it.
 *
 * receivedOutputData delivers every unmodified stdout/stderr chunk. Stdout
 * includes framing; receivedFrameData additionally delivers each complete
 * opaque JSON body. No payload is decoded, parsed or rewritten here. Following
 * a framing error, raw stdout continues to EOF without guessing a new boundary.
 */
@protocol ArcaneCoreProcessDelegate <NSObject>
- (void)coreProcess:(ArcaneCoreProcess *)process didLaunch:(pid_t)processIdentifier;
- (void)coreProcess:(ArcaneCoreProcess *)process receivedFrameData:(NSData *)data;
- (void)coreProcess:(ArcaneCoreProcess *)process receivedOutputData:(NSData *)data
            stream:(ArcaneCoreOutputStream)stream;
- (void)coreProcess:(ArcaneCoreProcess *)process didEncounterError:(NSError *)error;
- (void)coreProcess:(ArcaneCoreProcess *)process didExitWithStatus:(int)status
            reason:(NSTaskTerminationReason)reason;
/**
 * Last callback: launch/exit observation, accepted writes and both streams have
 * settled, successfully or with reported errors. Launch failure has no exit
 * callback; an exit-observation failure is not proof that the child exited.
 */
- (void)coreProcess:(ArcaneCoreProcess *)process didCompleteWithErrors:(NSArray<NSError *> *)errors;
@end

/**
 * Foundation-only ownership of one explicit Core executable and framed pipes.
 * Compile with Objective-C ARC and blocks; no third-party runtime is linked.
 */
API_AVAILABLE(macos(11.0))
@interface ArcaneCoreProcess : NSObject

/**
 * Starts asynchronously without shell execution, PATH lookup, environment
 * mutation or a foreground wait. Arguments exclude argv[0]; the selected child
 * inherits the host environment. Launch failure is reported through the
 * delegate and completion. Callbacks can begin before this method returns.
 */
+ (instancetype)startExecutableURL:(NSURL *)executableURL
                        arguments:(NSArray<NSString *> *)arguments
              workingDirectoryURL:(NSURL *)workingDirectoryURL
                         delegate:(id<ArcaneCoreProcessDelegate>)delegate;

/** Zero until a successful launch; the original child PID remains after exit. */
@property(nonatomic, readonly) pid_t processIdentifier;

/**
 * Copies and queues the complete opaque JSON body. YES accepts the write and
 * calls completion exactly once on the input queue. nil completion-error means
 * the full frame reached child stdin, not that Core accepted or completed its
 * operation. NO supplies a synchronous error and never calls completion.
 * A partial/failed write is never retried. Payload length is transport framing
 * only, never an application limit or policy.
 */
- (BOOL)sendJSONData:(NSData *)data
         completion:(void (^)(NSError * _Nullable error))completion
              error:(NSError * _Nullable * _Nullable)error;

/**
 * Idempotent and nonblocking: reject new sends, finish accepted writes, then
 * close stdin. Keep reading stdout/stderr and observe child exit. There is no
 * forced termination or deadline. Accepted service work can outlive a renderer;
 * renderer cancellation belongs to the public Core control protocol.
 */
- (void)closeInput;

- (instancetype)init NS_UNAVAILABLE;
+ (instancetype)new NS_UNAVAILABLE;
@end

NS_ASSUME_NONNULL_END

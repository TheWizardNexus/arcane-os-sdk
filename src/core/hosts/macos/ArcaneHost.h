#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import "ArcaneCoreProcess.h"

NS_ASSUME_NONNULL_BEGIN

@class ArcaneHost;

/**
 * Main-thread callbacks. Return promptly; process readers never wait for these
 * callbacks. Output and frame callbacks expose complete native diagnostics,
 * including responses whose original document activation has retired.
 * The delegate is retained until the host finishes closing.
 * Bridge failures preserve NSError domain/code and full nested userInfo;
 * NSURL and NSData use explicit reversible transport records. If an actual
 * native value cannot cross WebKit, the bridge reports that representation
 * failure and the delegate retains the complete original diagnostic.
 */
@protocol ArcaneHostDelegate <NSObject>
- (void)host:(ArcaneHost *)host didLaunchCoreProcess:(pid_t)processIdentifier;
- (void)host:(ArcaneHost *)host receivedOutputData:(NSData *)data stream:(ArcaneCoreOutputStream)stream;
- (void)host:(ArcaneHost *)host receivedFrameData:(NSData *)data;
- (void)host:(ArcaneHost *)host didEncounterError:(NSError *)error;
- (void)host:(ArcaneHost *)host didExitCoreProcessWithStatus:(int)status reason:(NSTaskTerminationReason)reason;
- (void)host:(ArcaneHost *)host coreDidCompleteWithErrors:(NSArray<NSError *> *)errors;
@end

/**
 * Generic AppKit/WebKit composition. Compile with Objective-C ARC and blocks,
 * linking only AppKit, WebKit and Foundation plus ArcaneCoreProcess.
 * Public methods and properties belong to the main thread.
 */
API_AVAILABLE(macos(11.0))
@interface ArcaneHost : NSWindowController

/**
 * Opens immediately while the explicit Core executable starts on its own queue.
 * Supply an already-serving applicationURL to load immediately, or nil and call
 * loadApplicationURL: when the serving owner's listener-ready result arrives.
 * Process creation is not listener readiness. The caller owns NSApplication,
 * its menus/delegate, actual serving origin, selected start URL and website
 * data store. Navigation keeps Core and accepted service-lifetime work alive.
 *
 * Supply canonical createCoreClassicSource({eventOwnerModuleURL,
 * replayRuntimeState:true,webKitDocumentLifecycle:true}) output. It is installed
 * unchanged at document start in the main frame's page world, before app code.
 * No file/custom-scheme serving, application client copy or certificate policy
 * is provided here. Arguments exclude argv[0]; Core inherits the environment.
 * Events broadcast to the current document; periods without one remain fully
 * observable through native diagnostics. The shared client replays current
 * runtime state after activation instead of replaying old transient events.
 */
+ (instancetype)openApplicationURL:(NSURL * _Nullable)applicationURL
                  websiteDataStore:(WKWebsiteDataStore *)websiteDataStore
                             title:(NSString *)title
                      contentFrame:(NSRect)contentFrame
                     classicSource:(NSString *)classicSource
                     executableURL:(NSURL *)executableURL
                         arguments:(NSArray<NSString *> *)arguments
               workingDirectoryURL:(NSURL *)workingDirectoryURL
                          delegate:(id<ArcaneHostDelegate>)delegate;

@property(nonatomic, readonly) WKWebView *webView;

/** Loads the selected app URL after its serving owner is ready. */
- (WKNavigation * _Nullable)loadApplicationURL:(NSURL *)applicationURL;

/**
 * Idempotent, nonblocking shutdown: stop accepting writes, send ordered stdin
 * EOF, drain process output/exit and pending native deliveries, then close the
 * window. Direct NSWindow.close is also observed and drains while hidden.
 * Each supplied completion runs once on the main thread with all host errors.
 * The caller can use this completion with NSApplicationTerminateLater and its
 * own replyToApplicationShouldTerminate:, without replacing its app delegate.
 */
- (void)closeWithCompletion:(void (^ _Nullable)(NSArray<NSError *> *errors))completion;
- (void)close;

- (instancetype)init NS_UNAVAILABLE;
+ (instancetype)new NS_UNAVAILABLE;
@end

NS_ASSUME_NONNULL_END

#ifndef ARCANE_CORE_PROCESS_H
#define ARCANE_CORE_PROCESS_H

#include <stddef.h>
#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct ArcaneCoreProcess ArcaneCoreProcess;

typedef enum {
    ARCANE_CORE_STDOUT,
    ARCANE_CORE_STDERR
} ArcaneCoreStream;

typedef struct {
    pid_t pid;
    int launched;
    /* A terminal child status was observed, including termination by signal. */
    int exited;
    /* -1 unless the child exited normally; term_signal is zero unless signaled. */
    int exit_code;
    int term_signal;
    int had_error;
} ArcaneCoreProcessResult;

/*
 * All callbacks run on owner-managed background threads, never a UI thread.
 * stdout, stderr, writes and lifecycle callbacks can run concurrently. Each
 * individual stream and the write acknowledgements retain their original order.
 * Marshal UI work at the host; keep context alive through complete() returning.
 * Callback arguments and payloads are borrowed for the duration of the call.
 * Callbacks must return normally and must not wait for another owner callback.
 * They may call send(), close(), retain() or release() with an owned reference.
 * A borrowed callback process remains valid through that callback's return.
 *
 * output() receives every unmodified stdout/stderr chunk. stdout includes its
 * transport headers; frame() additionally receives each complete opaque JSON
 * body. No JSON is parsed, reformatted or selected here. After a framing error,
 * stdout continues through output() until EOF, without guessing a new boundary.
 * error() identifies the operation and its POSIX error. For child.exit-status
 * or child.signal, error_number is zero and exited() supplies the actual status.
 * Complete raw output is
 * retained by the output callbacks, including incomplete/malformed frames.
 *
 * written() fires exactly once for each send() returning zero. A zero error
 * means the complete header and body reached the child's input transport, not
 * that Core accepted or completed the requested operation. Core response frames
 * own that distinction. A nonzero error reports an undelivered/partial write.
 * No payload is retried after a partial write.
 *
 * started() is optional and runs after exec succeeds, before frame delivery.
 * exited() runs when waitpid observes the child, independently of output EOF.
 * complete() runs last, after every accepted write has an outcome, both output
 * streams have ended (or reported a read error), and the child has been reaped
 * (or waitpid has reported its error). It runs even when launch fails.
 * All callbacks except started() are required so outcomes cannot disappear.
 * A framing/read failure requests graceful close while preserving queued writes
 * and continuing every still-readable output stream through EOF.
 */
typedef struct {
    void (*started)(ArcaneCoreProcess *process, pid_t pid, void *context);
    void (*frame)(ArcaneCoreProcess *process, const void *json, size_t length, void *context);
    void (*output)(ArcaneCoreProcess *process, ArcaneCoreStream stream,
                   const void *data, size_t length, void *context);
    void (*written)(ArcaneCoreProcess *process, void *write_context,
                    int error_number, void *context);
    void (*error)(ArcaneCoreProcess *process, const char *operation,
                  int error_number, void *context);
    void (*exited)(ArcaneCoreProcess *process, const ArcaneCoreProcessResult *result,
                   void *context);
    void (*complete)(ArcaneCoreProcess *process, const ArcaneCoreProcessResult *result,
                     void *context);
} ArcaneCoreProcessCallbacks;

/*
 * Start one executable, with an explicit NULL-terminated argv (including argv[0])
 * and working directory. Relative executable paths resolve after chdir; PATH
 * search, shell commands and OS/product defaults are not used. The child inherits
 * the host environment. This call copies its arguments and starts background
 * ownership; it does not wait for launch, I/O or child exit. Callbacks may begin
 * before this function returns. A NULL result sets errno and emits no callbacks.
 * Once a handle is returned, asynchronous launch failures use error/complete.
 * The caller owns one reference. No global signal disposition is changed.
 */
ArcaneCoreProcess *arcane_core_process_start(
    const char *executable,
    const char *const argv[],
    const char *working_directory,
    const ArcaneCoreProcessCallbacks *callbacks,
    void *context);

/*
 * Copy and queue a complete opaque JSON body. Length exists only for transport
 * framing and is not a product limit. The caller may release its input after
 * return. Zero accepts the write; a POSIX error rejects it synchronously and
 * written() is then not called. Concurrent calls are ordered when queued.
 */
int arcane_core_process_send(ArcaneCoreProcess *process, const void *json,
                           size_t length, void *write_context);

/*
 * Idempotent, nonblocking graceful close: reject new sends, finish the accepted
 * write queue, then close child stdin. stdout/stderr remain open until EOF and
 * the child is observed to exit. There is no forced termination or deadline.
 * Accepted service work may continue after the renderer closes. Renderer request
 * cancellation is a host decision sent through the public Core control protocol.
 */
void arcane_core_process_close(ArcaneCoreProcess *process);

/*
 * References permit host/UI ownership independent of background completion.
 * retain() requires an already-live reference. release() relinquishes one; the
 * last external release does not cancel work or close input. Call close() when
 * the host intends shutdown, and keep callback context alive until completion.
 * No function may race use of its own final reference against release().
 */
void arcane_core_process_retain(ArcaneCoreProcess *process);
void arcane_core_process_release(ArcaneCoreProcess *process);

#ifdef __cplusplus
}
#endif

#endif

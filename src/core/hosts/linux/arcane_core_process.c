#define _GNU_SOURCE
#define _POSIX_C_SOURCE 200809L

#include "arcane_core_process.h"

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

typedef struct CoreWrite {
    struct CoreWrite *next;
    void *data;
    size_t length;
    void *context;
} CoreWrite;

struct ArcaneCoreProcess {
    atomic_uint references;
    pthread_mutex_t mutex;
    pthread_cond_t changed;
    ArcaneCoreProcessCallbacks callbacks;
    void *context;
    char *executable;
    char **argv;
    char *working_directory;
    CoreWrite *first;
    CoreWrite *last;
    int closing;
    int launch_done;
    int launch_error;
    int input;
    int output;
    int errors;
    ArcaneCoreProcessResult result;
};

typedef struct {
    int operation;
    int error_number;
} LaunchFailure;

typedef struct {
    ArcaneCoreProcess *process;
    unsigned char chunk[16384];
    size_t position;
    size_t available;
    int error_number;
} CoreReader;

enum { LAUNCH_CHDIR = 1, LAUNCH_DUP, LAUNCH_EXEC };

static void *run_core(void *data);
static void *write_core(void *data);
static void *read_core(void *data);
static void *read_errors(void *data);

static void free_process(ArcaneCoreProcess *process) {
    if (process->argv) {
        for (size_t index = 0; process->argv[index]; ++index) free(process->argv[index]);
        free(process->argv);
    }
    free(process->executable);
    free(process->working_directory);
    pthread_cond_destroy(&process->changed);
    pthread_mutex_destroy(&process->mutex);
    free(process);
}

void arcane_core_process_retain(ArcaneCoreProcess *process) {
    if (process) atomic_fetch_add_explicit(&process->references, 1, memory_order_relaxed);
}

void arcane_core_process_release(ArcaneCoreProcess *process) {
    if (process && atomic_fetch_sub_explicit(&process->references, 1, memory_order_acq_rel) == 1)
        free_process(process);
}

static void report_error(ArcaneCoreProcess *process, const char *operation, int error_number) {
    pthread_mutex_lock(&process->mutex);
    process->result.had_error = 1;
    pthread_mutex_unlock(&process->mutex);
    process->callbacks.error(process, operation, error_number, process->context);
}

static void close_owned(ArcaneCoreProcess *process, int descriptor, const char *operation) {
    if (descriptor >= 0 && close(descriptor) != 0) report_error(process, operation, errno);
}

void arcane_core_process_close(ArcaneCoreProcess *process) {
    if (!process) return;
    pthread_mutex_lock(&process->mutex);
    process->closing = 1;
    pthread_cond_broadcast(&process->changed);
    pthread_mutex_unlock(&process->mutex);
}

int arcane_core_process_send(ArcaneCoreProcess *process, const void *json,
                           size_t length, void *write_context) {
    if (!process || (!json && length)) return EINVAL;
    CoreWrite *write = calloc(1, sizeof(*write));
    if (!write) return ENOMEM;
    write->data = malloc(length ? length : 1);
    if (!write->data) { free(write); return ENOMEM; }
    if (length) memcpy(write->data, json, length);
    write->length = length;
    write->context = write_context;
    pthread_mutex_lock(&process->mutex);
    if (process->closing) {
        pthread_mutex_unlock(&process->mutex);
        free(write->data);
        free(write);
        return EPIPE;
    }
    if (process->last) process->last->next = write;
    else process->first = write;
    process->last = write;
    pthread_cond_broadcast(&process->changed);
    pthread_mutex_unlock(&process->mutex);
    return 0;
}

ArcaneCoreProcess *arcane_core_process_start(
    const char *executable, const char *const argv[], const char *working_directory,
    const ArcaneCoreProcessCallbacks *callbacks, void *context) {
    if (!executable || !*executable || !argv || !argv[0]
        || !working_directory || !*working_directory || !callbacks
        || !callbacks->frame || !callbacks->output || !callbacks->written
        || !callbacks->error || !callbacks->exited || !callbacks->complete) {
        errno = EINVAL;
        return NULL;
    }
    ArcaneCoreProcess *process = calloc(1, sizeof(*process));
    if (!process) return NULL;
    int failure = pthread_mutex_init(&process->mutex, NULL);
    if (failure) { free(process); errno = failure; return NULL; }
    failure = pthread_cond_init(&process->changed, NULL);
    if (failure) {
        pthread_mutex_destroy(&process->mutex);
        free(process);
        errno = failure;
        return NULL;
    }
    atomic_init(&process->references, 2); /* caller and detached lifecycle owner */
    process->callbacks = *callbacks;
    process->context = context;
    process->input = process->output = process->errors = -1;
    process->result.pid = -1;
    process->result.exit_code = -1;
    process->executable = strdup(executable);
    process->working_directory = strdup(working_directory);
    size_t count = 0;
    while (argv[count]) {
        if (count == SIZE_MAX / sizeof(char *) - 1) {
            free_process(process);
            errno = EOVERFLOW;
            return NULL;
        }
        ++count;
    }
    process->argv = calloc(count + 1, sizeof(char *));
    if (!process->executable || !process->working_directory || !process->argv) {
        free_process(process);
        errno = ENOMEM;
        return NULL;
    }
    for (size_t index = 0; index < count; ++index) {
        process->argv[index] = strdup(argv[index]);
        if (!process->argv[index]) { free_process(process); errno = ENOMEM; return NULL; }
    }
    pthread_attr_t attributes;
    failure = pthread_attr_init(&attributes);
    if (failure) { free_process(process); errno = failure; return NULL; }
    failure = pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
    pthread_t thread;
    if (!failure) failure = pthread_create(&thread, &attributes, run_core, process);
    pthread_attr_destroy(&attributes);
    if (failure) { free_process(process); errno = failure; return NULL; }
    return process;
}

static int await_launch(ArcaneCoreProcess *process) {
    pthread_mutex_lock(&process->mutex);
    while (!process->launch_done) pthread_cond_wait(&process->changed, &process->mutex);
    int launched = process->result.launched;
    pthread_mutex_unlock(&process->mutex);
    return launched;
}

static void acknowledge_write(ArcaneCoreProcess *process, CoreWrite *write, int failure) {
    process->callbacks.written(process, write->context, failure, process->context);
    free(write->data);
    free(write);
}

static int send_complete(int descriptor, const void *data, size_t length) {
    const unsigned char *cursor = data;
    while (length) {
        /* A chunk is transport work, never a content limit. MSG_NOSIGNAL avoids
         * modifying SIGPIPE behavior for the host or any other thread. */
        size_t chunk = length > 16384 ? 16384 : length;
        ssize_t sent = send(descriptor, cursor, chunk, MSG_NOSIGNAL);
        if (sent < 0 && errno == EINTR) continue;
        if (sent < 0) return errno;
        if (!sent) return EPIPE;
        cursor += sent;
        length -= (size_t)sent;
    }
    return 0;
}

static void *write_core(void *data) {
    ArcaneCoreProcess *process = data;
    int failure = await_launch(process) ? 0 : process->launch_error;
    for (;;) {
        pthread_mutex_lock(&process->mutex);
        while (!process->first && !process->closing)
            pthread_cond_wait(&process->changed, &process->mutex);
        CoreWrite *write = process->first;
        if (write) {
            process->first = write->next;
            if (!process->first) process->last = NULL;
        }
        pthread_mutex_unlock(&process->mutex);
        if (!write) break;
        if (!failure) {
            char header[sizeof(size_t) * 3 + sizeof("Content-Length: \r\n\r\n")];
            int length = snprintf(header, sizeof(header), "Content-Length: %zu\r\n\r\n", write->length);
            failure = length < 0 || (size_t)length >= sizeof(header) ? EOVERFLOW
                : send_complete(process->input, header, (size_t)length);
            if (!failure) failure = send_complete(process->input, write->data, write->length);
            if (failure) {
                arcane_core_process_close(process);
                report_error(process, "stdin.write", failure);
            }
        }
        acknowledge_write(process, write, failure);
    }
    if (process->input >= 0) close_owned(process, process->input, "stdin.close");
    return NULL;
}

/* Streaming chunks carry the complete stream, without imposing content limits. */
static int fill_stdout(CoreReader *reader) {
    if (reader->position == reader->available) {
        ssize_t count;
        do { count = read(reader->process->output, reader->chunk, sizeof(reader->chunk)); }
        while (count < 0 && errno == EINTR);
        if (count < 0) {
            reader->error_number = errno;
            arcane_core_process_close(reader->process);
            report_error(reader->process, "stdout.read", reader->error_number);
            return -1;
        }
        if (!count) return 0;
        reader->position = 0;
        reader->available = (size_t)count;
        reader->process->callbacks.output(reader->process, ARCANE_CORE_STDOUT,
            reader->chunk, (size_t)count, reader->process->context);
    }
    return 1;
}

/* Returns 1 for a character, 0 for EOF, or -1 after a reported read failure. */
static int next_character(CoreReader *reader, unsigned char *character) {
    int status = fill_stdout(reader);
    if (status != 1) return status;
    *character = reader->chunk[reader->position++];
    return 1;
}

static int append_header(char **header, size_t *length, size_t *capacity, unsigned char character) {
    if (*length == *capacity) {
        if (*capacity > SIZE_MAX / 2) return EOVERFLOW;
        size_t next = *capacity ? *capacity * 2 : 128;
        char *replacement = realloc(*header, next);
        if (!replacement) return ENOMEM;
        *header = replacement;
        *capacity = next;
    }
    (*header)[(*length)++] = (char)character;
    return 0;
}

static int content_length(const char *header, size_t length, size_t *body_length) {
    size_t cursor = 0;
    int found = 0;
    while (cursor < length) {
        size_t end = cursor;
        while (end + 1 < length && !(header[end] == '\r' && header[end + 1] == '\n')) ++end;
        if (end + 1 >= length) return EPROTO;
        if (end == cursor) break;
        size_t colon = cursor;
        while (colon < end && header[colon] != ':') ++colon;
        if (colon == end) return EPROTO;
        if (colon - cursor == 14 && strncasecmp(header + cursor, "Content-Length", 14) == 0) {
            if (found) return EPROTO;
            found = 1;
            size_t number = colon + 1;
            while (number < end && (header[number] == ' ' || header[number] == '\t')) ++number;
            if (number == end || header[number] < '0' || header[number] > '9') return EPROTO;
            size_t value = 0;
            while (number < end && header[number] >= '0' && header[number] <= '9') {
                unsigned digit = (unsigned)(header[number++] - '0');
                if (value > (SIZE_MAX - digit) / 10) return EOVERFLOW;
                value = value * 10 + digit;
            }
            while (number < end && (header[number] == ' ' || header[number] == '\t')) ++number;
            if (number != end) return EPROTO;
            *body_length = value;
        }
        cursor = end + 2;
    }
    return found ? 0 : EPROTO;
}

static void *read_core(void *data) {
    ArcaneCoreProcess *process = data;
    if (!await_launch(process)) return NULL;
    CoreReader reader = {.process = process};
    int parsing = 1;
    while (parsing) {
        char *header = NULL;
        size_t length = 0, capacity = 0, body_length = 0;
        int read_status = 1, failure = 0;
        unsigned char character;
        while ((read_status = next_character(&reader, &character)) == 1) {
            failure = append_header(&header, &length, &capacity, character);
            if (failure || (length >= 4 && memcmp(header + length - 4, "\r\n\r\n", 4) == 0)) break;
        }
        if (read_status <= 0) {
            if (!read_status && length) {
                arcane_core_process_close(process);
                report_error(process, "stdout.incomplete-header", EPROTO);
            }
            free(header);
            break;
        }
        if (!failure) failure = content_length(header, length, &body_length);
        free(header);
        if (failure) {
            arcane_core_process_close(process);
            report_error(process, "stdout.frame-header", failure);
            parsing = 0;
            break;
        }
        unsigned char *body = malloc(body_length ? body_length : 1);
        if (!body) {
            arcane_core_process_close(process);
            report_error(process, "stdout.frame-allocation", ENOMEM);
            parsing = 0;
            break;
        }
        size_t received = 0;
        while (received < body_length) {
            read_status = fill_stdout(&reader);
            if (read_status != 1) break;
            size_t amount = reader.available - reader.position;
            if (amount > body_length - received) amount = body_length - received;
            memcpy(body + received, reader.chunk + reader.position, amount);
            reader.position += amount;
            received += amount;
        }
        if (received == body_length) process->callbacks.frame(process, body, body_length, process->context);
        else if (!reader.error_number) {
            arcane_core_process_close(process);
            report_error(process, "stdout.incomplete-body", EPROTO);
        }
        free(body);
        if (received != body_length) break;
    }
    if (!parsing) {
        /* Every chunk was already delivered to output(). A malformed frame is
         * not permission to drop the remaining child's diagnostic stream. */
        reader.position = reader.available;
        while (fill_stdout(&reader) == 1) reader.position = reader.available;
    }
    arcane_core_process_close(process);
    close_owned(process, process->output, "stdout.close");
    return NULL;
}

static void *read_errors(void *data) {
    ArcaneCoreProcess *process = data;
    if (!await_launch(process)) return NULL;
    unsigned char chunk[16384];
    for (;;) {
        ssize_t count = read(process->errors, chunk, sizeof(chunk));
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) {
            int failure = errno;
            arcane_core_process_close(process);
            report_error(process, "stderr.read", failure);
        }
        if (count <= 0) break;
        process->callbacks.output(process, ARCANE_CORE_STDERR, chunk, (size_t)count, process->context);
    }
    close_owned(process, process->errors, "stderr.close");
    return NULL;
}

static int prepare_descriptor(int descriptor) {
    if (descriptor < 3) {
        int replacement = fcntl(descriptor, F_DUPFD_CLOEXEC, 3);
        int saved = errno;
        close(descriptor);
        errno = saved;
        return replacement;
    }
    return descriptor;
}

static int create_pair(int pair[2], int input) {
    /* Atomic close-on-exec prevents concurrent launches retaining another
     * process's channel and indefinitely holding its EOF open. */
    if ((input ? socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair)
               : pipe2(pair, O_CLOEXEC)) != 0) return errno;
    pair[0] = prepare_descriptor(pair[0]);
    if (pair[0] < 0) {
        int failure = errno;
        close(pair[1]);
        pair[1] = -1;
        return failure;
    }
    pair[1] = prepare_descriptor(pair[1]);
    if (pair[1] < 0) {
        int failure = errno;
        close(pair[0]);
        pair[0] = -1;
        return failure;
    }
    return 0;
}

static void child_failed(int descriptor, int operation) {
    LaunchFailure failure = {operation, errno};
    const unsigned char *cursor = (const unsigned char *)&failure;
    size_t remaining = sizeof(failure);
    while (remaining) {
        ssize_t count = write(descriptor, cursor, remaining);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) break;
        cursor += count;
        remaining -= (size_t)count;
    }
    _exit(127);
}

static void exec_child(ArcaneCoreProcess *process, int pairs[4][2]) {
    close(pairs[3][0]);
    if (chdir(process->working_directory) != 0) child_failed(pairs[3][1], LAUNCH_CHDIR);
    if (dup2(pairs[0][1], STDIN_FILENO) < 0
        || dup2(pairs[1][1], STDOUT_FILENO) < 0
        || dup2(pairs[2][1], STDERR_FILENO) < 0) child_failed(pairs[3][1], LAUNCH_DUP);
    for (size_t index = 0; index < 3; ++index) {
        close(pairs[index][0]);
        close(pairs[index][1]);
    }
    execve(process->executable, process->argv, environ);
    child_failed(pairs[3][1], LAUNCH_EXEC);
}

static int observe_launch(int descriptor, const char **operation) {
    LaunchFailure failure = {0};
    unsigned char *cursor = (unsigned char *)&failure;
    size_t received = 0;
    while (received < sizeof(failure)) {
        ssize_t count = read(descriptor, cursor + received, sizeof(failure) - received);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) return errno;
        if (!count) return received ? EPROTO : 0;
        received += (size_t)count;
    }
    *operation = failure.operation == LAUNCH_CHDIR ? "launch.chdir"
        : failure.operation == LAUNCH_DUP ? "launch.stdio" : "launch.exec";
    return failure.error_number;
}

static void *run_core(void *data) {
    ArcaneCoreProcess *process = data;
    int pairs[4][2] = {{-1, -1}, {-1, -1}, {-1, -1}, {-1, -1}};
    pthread_t threads[3];
    void *(*workers[3])(void *) = {write_core, read_core, read_errors};
    size_t started = 0;
    int failure = 0;
    const char *operation = "launch.pipe";
    for (size_t index = 0; index < 4 && !failure; ++index)
        failure = create_pair(pairs[index], index == 0);
    if (!failure) {
        operation = "thread.start";
        for (; started < 3; ++started) {
            failure = pthread_create(&threads[started], NULL, workers[started], process);
            if (failure) break;
        }
    }
    pid_t child = -1;
    if (!failure) {
        operation = "launch.fork";
        child = fork();
        if (!child) exec_child(process, pairs);
        if (child < 0) failure = errno;
        else {
            process->result.pid = child;
            for (size_t index = 0; index < 4; ++index) {
                close_owned(process, pairs[index][1], "launch.parent-close");
                pairs[index][1] = -1;
            }
            operation = "launch.handshake";
            failure = observe_launch(pairs[3][0], &operation);
        }
    }
    if (failure) report_error(process, operation, failure);
    if (!failure) {
        process->input = pairs[0][0];
        process->output = pairs[1][0];
        process->errors = pairs[2][0];
        for (size_t index = 0; index < 3; ++index) pairs[index][0] = -1;
        if (process->callbacks.started) process->callbacks.started(process, child, process->context);
    }
    for (size_t index = 0; index < 4; ++index) {
        close_owned(process, pairs[index][0], "launch.pipe-close");
        close_owned(process, pairs[index][1], "launch.pipe-close");
    }
    pthread_mutex_lock(&process->mutex);
    process->result.launched = !failure;
    process->launch_error = failure;
    process->launch_done = 1;
    if (failure) process->closing = 1;
    pthread_cond_broadcast(&process->changed);
    pthread_mutex_unlock(&process->mutex);
    if (!started) write_core(process); /* Return outcomes even before a writer exists. */
    if (child > 0) {
        int status = 0;
        pid_t waited;
        do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
        if (waited < 0) report_error(process, "child.wait", errno);
        pthread_mutex_lock(&process->mutex);
        process->closing = 1;
        if (waited == child) {
            process->result.exited = WIFEXITED(status) || WIFSIGNALED(status);
            if (WIFEXITED(status)) process->result.exit_code = WEXITSTATUS(status);
            if (WIFSIGNALED(status)) process->result.term_signal = WTERMSIG(status);
            if (process->result.term_signal || process->result.exit_code != 0)
                process->result.had_error = 1;
        }
        ArcaneCoreProcessResult result = process->result;
        pthread_cond_broadcast(&process->changed);
        pthread_mutex_unlock(&process->mutex);
        if (waited == child && (result.term_signal || result.exit_code != 0))
            process->callbacks.error(process, result.term_signal ? "child.signal" : "child.exit-status",
                                     0, process->context);
        process->callbacks.exited(process, &result, process->context);
    }
    for (size_t index = 0; index < started; ++index) pthread_join(threads[index], NULL);
    process->callbacks.complete(process, &process->result, process->context);
    arcane_core_process_release(process);
    return NULL;
}

import path from 'node:path';
import Is from 'strong-type';
import {ArcaneError, throwIfAborted} from './errors.mjs';
import {runProcess} from './process.mjs';
import {createEventQueue} from './event-queue.mjs';

const is = new Is(false);

/** Read only non-secret identity configuration through ordinary Git scopes. */
export async function readGitIdentity({directory, signal, onEvent, run = runProcess} = {}) {
    const cwd = directory === undefined ? undefined : path.resolve(directory);
    throwIfAborted(signal);
    const events = createEventQueue(onEvent);

    async function observeScope(scope) {
        const args = ['config'];
        if (scope !== 'effective') args.push(`--${scope}`);
        args.push('--includes', '--null', '--get-regexp', '^(user[.](name|email)|github[.]user)$');
        const chunks = [];
        try {
            const result = await run('git', args, {
                cwd, signal, onEvent: events.send, allowNonzero: true,
                outputEncoding: {stdout: null},
                captureOutput: {stdout: false},
                emitOutputEvents: {stdout: false},
                // Git configuration may contain non-UTF-8 values. Keep its raw
                // output until close rather than silently replacing characters.
                onOutput: function observeOutput({stream, chunk}) {
                    if (stream === 'stdout') chunks.push(chunk);
                }
            });
            try { throwIfAborted(signal); }
            catch (error) { error.details = result; throw error; }
            const identity = {name: null, email: null, githubUser: null};
            if (result.code === 1) return identity;
            if (result.code !== 0) {
                throw new ArcaneError('ARCANE_OPERATION_FAILED',
                    `Git ${scope} identity lookup exited with code ${String(result.code)}.`, {details: result});
            }
            let output;
            try { output = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(Buffer.concat(chunks)); }
            catch (cause) {
                throw new ArcaneError('ARCANE_GIT_IDENTITY_NOT_TEXT',
                    `Git ${scope} identity configuration cannot be represented as UTF-8 text.`, {cause, details: result});
            }
            const fields = {'user.name': 'name', 'user.email': 'email', 'github.user': 'githubUser'};
            // Git's NUL record framing preserves complete values, including newlines
            // and empty strings. The last occurrence is the effective scalar value.
            for (const record of output.split('\0')) {
                if (record === '') continue;
                const separator = record.indexOf('\n');
                const key = separator === -1 ? record : record.slice(0, separator);
                if (Object.hasOwn(fields, key)) {
                    identity[fields[key]] = separator === -1 ? '' : record.slice(separator + 1);
                }
            }
            return identity;
        } catch (error) {
            // Keep the process error and its native details intact. Raw stdout
            // belongs to this reader because the process owner did not decode it.
            const rawStdout = Buffer.concat(chunks);
            let attached = false;
            let attachmentError;
            try {
                if (error !== null && (is.object(error) || is.function(error)) && !('rawStdout' in error)) {
                    Object.defineProperty(error, 'rawStdout', {
                        value: rawStdout, writable: true, enumerable: true, configurable: true
                    });
                    attached = true;
                }
            } catch (cause) { attachmentError = cause; }
            if (attached) throw error;
            const failure = new ArcaneError(error?.code ?? 'ARCANE_OPERATION_FAILED',
                error instanceof Error ? error.message : String(error),
                {cause: error, details: error?.details, exitCode: error?.exitCode});
            failure.rawStdout = rawStdout;
            if (attachmentError) failure.attachmentError = attachmentError;
            throw failure;
        }
    }

    const scopes = cwd === undefined ? ['global'] : ['global', 'local', 'effective'];
    const observations = await Promise.allSettled(scopes.map(observeScope));
    const failures = observations.filter(function failed(result) {
        return result.status === 'rejected';
    }).map(function cause(result) { return result.reason; });
    try { await events.drain(); }
    catch (error) {
        const visited = new Set();
        function containsObserverFailure(failure) {
            if (failure === error) return true;
            if (failure === null || failure === undefined || visited.has(failure)) return false;
            visited.add(failure);
            return containsObserverFailure(failure.cause)
                || (is.array(failure.errors) && failure.errors.some(containsObserverFailure));
        }
        const represented = failures.some(containsObserverFailure);
        if (!represented) failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Git identity observations failed.');
    const result = {global: null, local: null, effective: null};
    for (const [index, scope] of scopes.entries()) result[scope] = observations[index].value;
    return result;
}

/** Capture one factory's selection without changing Git files or process.env. */
export function createGitIdentityRunner(run, {name, email, username} = {}) {
    const configuration = [];
    const environment = {};
    for (const [field, value] of Object.entries({name, email, username})) {
        if (value === undefined) continue;
        if (!is.string(value) || !value.isWellFormed() || value.includes('\0')) {
            throw new TypeError(`gitIdentity.${field} must be text representable as a native process argument.`);
        }
        configuration.push('-c', `${field === 'username' ? 'credential.username' : `user.${field}`}=${value}`);
        if (field === 'name') {
            environment.GIT_AUTHOR_NAME = value;
            environment.GIT_COMMITTER_NAME = value;
        } else if (field === 'email') {
            environment.GIT_AUTHOR_EMAIL = value;
            environment.GIT_COMMITTER_EMAIL = value;
        }
    }
    if (!configuration.length) return run;
    const selectsAuthor = name !== undefined || email !== undefined;
    return function runSelectedGit(command, args, options = {}) {
        return run(command, [...configuration, ...args], selectsAuthor
            ? {...options, env: {...options.env, ...environment}}
            : options);
    };
}

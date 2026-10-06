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
        const result = await run('git', args, {
            cwd, signal, onEvent: events.send, allowNonzero: true,
            // Use the process owner's complete output-aware failure record even
            // if event delivery fails; stdout/stderr already retain the text.
            onOutput: function observeOutput() {}
        });
        try { throwIfAborted(signal); }
        catch (error) { error.details = result; throw error; }
        const identity = {name: null, email: null, githubUser: null};
        if (result.code === 1) return identity;
        if (result.code !== 0) {
            throw new ArcaneError('ARCANE_OPERATION_FAILED',
                `Git ${scope} identity lookup exited with code ${String(result.code)}.`, {details: result});
        }
        const fields = {'user.name': 'name', 'user.email': 'email', 'github.user': 'githubUser'};
        // Git's NUL record framing preserves complete values, including newlines
        // and empty strings. The last occurrence is the effective scalar value.
        for (const record of result.stdout.split('\0')) {
            if (record === '') continue;
            const separator = record.indexOf('\n');
            const key = separator === -1 ? record : record.slice(0, separator);
            if (Object.hasOwn(fields, key)) {
                identity[fields[key]] = separator === -1 ? '' : record.slice(separator + 1);
            }
        }
        return identity;
    }

    const scopes = cwd === undefined ? ['global'] : ['global', 'local', 'effective'];
    const observations = await Promise.allSettled(scopes.map(observeScope));
    const failures = observations.filter(function failed(result) {
        return result.status === 'rejected';
    }).map(function cause(result) { return result.reason; });
    try { await events.drain(); }
    catch (error) { if (!failures.includes(error)) failures.push(error); }
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

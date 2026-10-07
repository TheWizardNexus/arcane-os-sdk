import {runProcess} from './process.mjs';
import {ArcaneError,ERROR_CODES,throwIfAborted} from './errors.mjs';
import path from 'node:path';
import Is from 'strong-type';

const is = new Is(false);

async function git(args,{run=runProcess,...options}){
    return run('git',args,options);
}

/** Private shared reader for Git text protocols, retaining native diagnostics. */
export async function readGitText(args, {
    cwd, signal, onEvent, run = runProcess, allowNonzero = false,
    notTextCode = 'ARCANE_GIT_CONFIGURATION_NOT_TEXT', label = 'Git configuration'
} = {}) {
    const chunks = [];
    try {
        const result = await run('git', args, {
            cwd, signal, onEvent, allowNonzero,
            outputEncoding: {stdout: null}, captureOutput: {stdout: false}, emitOutputEvents: {stdout: false},
            onOutput: function observeOutput({stream, chunk}) {
                if (stream === 'stdout') chunks.push(chunk);
            }
        });
        try { throwIfAborted(signal); }
        catch (error) { error.details = result; throw error; }
        const rawStdout = Buffer.concat(chunks);
        let output = null;
        if (result.code === 0) {
            try { output = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(rawStdout); }
            catch (cause) {
                throw new ArcaneError(notTextCode, `${label} cannot be represented as UTF-8 text.`, {cause, details: result});
            }
        }
        return {result, output, rawStdout};
    } catch (error) {
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
        const failure = new ArcaneError(error?.code ?? ERROR_CODES.operationFailed,
            error instanceof Error ? error.message : String(error),
            {cause: error, details: error?.details, exitCode: error?.exitCode});
        failure.rawStdout = rawStdout;
        if (attachmentError) failure.attachmentError = attachmentError;
        throw failure;
    }
}

/** Derive a Git argument only when the caller explicitly selects a local base. */
export function captureRepositoryRemote(remote, remoteBase) {
    if (remoteBase === undefined) return remote;
    if (!is.string(remoteBase) || !remoteBase.isWellFormed() || remoteBase.includes('\0')) {
        throw new TypeError('remoteBase must be text representable as a native filesystem path.');
    }
    return remote === undefined ? undefined : path.resolve(remoteBase, remote);
}

/** Keep original selection text separate from the accepted command argument. */
export function captureRepositoryTarget(target) {
    if (target === undefined) return undefined;
    const {remote, ref, remoteBase} = target;
    for (const [name, value] of Object.entries({remote, ref})) {
        if (!is.string(value) || value === '' || !value.isWellFormed() || value.includes('\0')) {
            throw new TypeError(`target.${name} must be nonempty text representable as a native process argument.`);
        }
    }
    return {
        target: {remote, ref, ...(remoteBase === undefined ? {} : {remoteBase})},
        remoteArgument: captureRepositoryRemote(remote, remoteBase)
    };
}

export function repositoryPushArguments(selection) {
    return selection === undefined ? ['push']
        : ['push', '--no-follow-tags', '--', selection.remoteArgument, `HEAD:${selection.target.ref}`];
}

/** Observe an existing workspace without initializing or refreshing it. */
export async function repositoryConfiguration({workspaceRoot = process.cwd(), signal, onEvent, run = runProcess} = {}) {
    const repositoryRoot = path.resolve(workspaceRoot);
    const options = {cwd: repositoryRoot, signal, onEvent, run, allowNonzero: true};
    throwIfAborted(signal);

    function processFailure(observation, message) {
        const failure = new ArcaneError(ERROR_CODES.operationFailed, message, {details: observation.result});
        failure.rawStdout = observation.rawStdout;
        return failure;
    }

    async function configuration(pattern) {
        const observation = await readGitText(['config', '--includes', '--null', '--get-regexp', pattern], options);
        const values = new Map();
        if (observation.result.code === 1) return values;
        if (observation.result.code !== 0) throw processFailure(observation, 'Git configuration observation failed.');
        for (const record of observation.output.split('\0')) {
            if (record === '') continue;
            const separator = record.indexOf('\n');
            const key = separator === -1 ? record : record.slice(0, separator);
            const value = separator === -1 ? '' : record.slice(separator + 1);
            const entries = values.get(key) ?? [];
            entries.push(value);
            values.set(key, entries);
        }
        return values;
    }

    function literalPattern(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    }

    const root = await readGitText(['rev-parse', '--is-inside-work-tree', '--show-prefix'], options);
    if (root.result.code !== 0) throw processFailure(root, 'Git working repository observation failed.');
    if (root.output !== 'true\n\n' && root.output !== 'true\r\n\r\n') {
        const failure = new ArcaneError('ARCANE_REPOSITORY_DIRECTORY_INVALID',
            'The selected directory is not a Git working repository root.', {details: root.result});
        failure.rawStdout = root.rawStdout;
        throw failure;
    }
    const head = await readGitText(['symbolic-ref', '--quiet', 'HEAD'], options);
    if (head.result.code !== 0 && head.result.code !== 1) throw processFailure(head, 'Git symbolic HEAD observation failed.');
    const headRef = head.result.code === 1 ? null : head.output.replace(/\r?\n$/u, '');
    let upstream = null;
    let remoteName;
    if (headRef?.startsWith('refs/heads/')) {
        const key = `branch.${headRef.slice('refs/heads/'.length)}`;
        const branch = await configuration(`^${literalPattern(key)}[.](remote|merge)$`);
        const remoteNames = branch.get(`${key}.remote`) ?? [];
        remoteName = remoteNames.at(-1);
        upstream = {remoteNames, mergeRefs: branch.get(`${key}.merge`) ?? [], urls: [], pushUrls: []};
    }
    const selectedNames = ['origin'];
    if (remoteName !== undefined && remoteName !== '.' && remoteName !== 'origin') selectedNames.push(remoteName);
    const names = selectedNames.map(literalPattern).join('|');
    const remotes = await configuration(`^remote[.](${names})[.](url|pushurl)$`);
    const origin = {urls: remotes.get('remote.origin.url') ?? [], pushUrls: remotes.get('remote.origin.pushurl') ?? []};
    if (upstream && remoteName !== undefined && remoteName !== '.') {
        upstream.urls = remotes.get(`remote.${remoteName}.url`) ?? [];
        upstream.pushUrls = remotes.get(`remote.${remoteName}.pushurl`) ?? [];
    }
    return {repositoryRoot, headRef, origin, upstream};
}

export async function repositoryStatus({
    workspaceRoot=process.cwd(),
    signal,
    onEvent,
    run=runProcess
}={}){
    throwIfAborted(signal);
    // These commands intentionally share one public event callback. Run them in
    // a fixed order so each process owns and drains its events before the next
    // producer begins.
    const root=await git(['rev-parse','--show-toplevel'],{cwd:workspaceRoot,signal,onEvent,run});
    const branch=await git(['branch','--show-current'],{cwd:workspaceRoot,signal,onEvent,run});
    const status=await git(['status','--short','--branch'],{cwd:workspaceRoot,signal,onEvent,run});
    return {
        repositoryRoot:root.stdout.trim(),
        branch:branch.stdout.trim()||null,
        clean:status.stdout.split(/\r?\n/u).filter(Boolean).every(line=>line.startsWith('##')),
        status:status.stdout.trim()
    };
}

export async function repositoryPull({
    workspaceRoot=process.cwd(),
    target,
    signal,
    onEvent,
    run=runProcess
}={}){
    throwIfAborted(signal);
    const selectedTarget=captureRepositoryTarget(target);
    return pullRepositoryTarget(selectedTarget,{workspaceRoot,signal,onEvent,run});
}

/** Internal workspace path: its target was already captured before queueing. */
export async function pullRepositoryTarget(selectedTarget,{workspaceRoot,signal,onEvent,run=runProcess}){
    throwIfAborted(signal);
    const before=await repositoryStatus({workspaceRoot,signal,onEvent,run});
    if(!before.clean){
        throw new ArcaneError(
            ERROR_CODES.policyDenied,
            'Refusing to pull into a repository with uncommitted changes.',
            {details:before}
        );
    }
    const args=selectedTarget===undefined?['pull','--ff-only']
        :['pull','--ff-only','--',selectedTarget.remoteArgument,`${selectedTarget.target.ref}:`];
    const result=await git(args,{cwd:workspaceRoot,signal,onEvent,run});
    return {
        action:'pull',
        repositoryRoot:before.repositoryRoot,
        branch:before.branch,
        output:result.stdout.trim(),
        ...(selectedTarget===undefined?{}:{target:selectedTarget.target,stdout:result.stdout,stderr:result.stderr})
    };
}

export async function repositoryPush({
    workspaceRoot=process.cwd(),
    target,
    signal,
    onEvent,
    run=runProcess
}={}){
    throwIfAborted(signal);
    const selectedTarget=captureRepositoryTarget(target);
    return pushRepositoryTarget(selectedTarget,{workspaceRoot,signal,onEvent,run});
}

/** Internal workspace path: its target was already captured before queueing. */
export async function pushRepositoryTarget(selectedTarget,{workspaceRoot,signal,onEvent,run=runProcess}){
    throwIfAborted(signal);
    const before=await repositoryStatus({workspaceRoot,signal,onEvent,run});
    if(!before.branch){
        throw new ArcaneError(
            ERROR_CODES.policyDenied,
            'Refusing to push from a detached HEAD.'
        );
    }
    const result=await git(repositoryPushArguments(selectedTarget),{cwd:workspaceRoot,signal,onEvent,run});
    return {
        action:'push',
        repositoryRoot:before.repositoryRoot,
        branch:before.branch,
        output:(result.stdout||result.stderr).trim(),
        ...(selectedTarget===undefined?{}:{target:selectedTarget.target,stdout:result.stdout,stderr:result.stderr})
    };
}

export async function runRepositoryAction(action,options={}){
    if(action==='status'){
        return repositoryStatus(options);
    }
    if(action==='pull'){
        return repositoryPull(options);
    }
    if(action==='push'){
        return repositoryPush(options);
    }
    throw new ArcaneError(
        ERROR_CODES.usage,
        `Unknown repository action: ${String(action)}. Expected status, pull, or push.`
    );
}

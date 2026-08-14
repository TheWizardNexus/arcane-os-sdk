import {runProcess} from './process.mjs';
import {ArcaneError,ERROR_CODES,throwIfAborted} from './errors.mjs';

async function git(args,{run=runProcess,...options}){
    return run('git',args,options);
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
    signal,
    onEvent,
    run=runProcess
}={}){
    throwIfAborted(signal);
    const before=await repositoryStatus({workspaceRoot,signal,onEvent,run});
    if(!before.clean){
        throw new ArcaneError(
            ERROR_CODES.policyDenied,
            'Refusing to pull into a repository with uncommitted changes.',
            {details:before}
        );
    }
    const result=await git(['pull','--ff-only'],{cwd:workspaceRoot,signal,onEvent,run});
    return {
        action:'pull',
        repositoryRoot:before.repositoryRoot,
        branch:before.branch,
        output:result.stdout.trim()
    };
}

export async function repositoryPush({
    workspaceRoot=process.cwd(),
    signal,
    onEvent,
    run=runProcess
}={}){
    throwIfAborted(signal);
    const before=await repositoryStatus({workspaceRoot,signal,onEvent,run});
    if(!before.branch){
        throw new ArcaneError(
            ERROR_CODES.policyDenied,
            'Refusing to push from a detached HEAD.'
        );
    }
    const result=await git(['push'],{cwd:workspaceRoot,signal,onEvent,run});
    return {
        action:'push',
        repositoryRoot:before.repositoryRoot,
        branch:before.branch,
        output:(result.stdout||result.stderr).trim()
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

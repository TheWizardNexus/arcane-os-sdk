export const ERROR_CODES=Object.freeze({
    usage:'ARCANE_USAGE',
    workspaceInvalid:'ARCANE_WORKSPACE_INVALID',
    prerequisiteMissing:'ARCANE_PREREQUISITE_MISSING',
    targetUnavailable:'ARCANE_TARGET_UNAVAILABLE',
    targetDeferred:'ARCANE_TARGET_DEFERRED',
    policyDenied:'ARCANE_POLICY_DENIED',
    integrityFailed:'ARCANE_INTEGRITY_FAILED',
    operationFailed:'ARCANE_OPERATION_FAILED',
    cancelled:'ARCANE_CANCELLED'
});

export class ArcaneError extends Error{
    constructor(code,message,{details,cause,exitCode}={}){
        super(message,{cause});
        this.name='ArcaneError';
        this.code=code||ERROR_CODES.operationFailed;
        this.details=details;
        this.exitCode=Number.isInteger(exitCode)?exitCode:1;
    }
}

export function fail(code,message,options){
    throw new ArcaneError(code,message,options);
}

export function throwIfAborted(signal){
    if(signal?.aborted){
        throw new ArcaneError(
            ERROR_CODES.cancelled,
            'The Arcane operation was cancelled.',
            {cause:signal.reason,exitCode:130}
        );
    }
}

export function normalizeError(error,fallbackCode=ERROR_CODES.operationFailed){
    if(error instanceof ArcaneError){
        return error;
    }

    if(error?.name==='AbortError'||error?.code==='ABORT_ERR'
        ||error?.code===ERROR_CODES.cancelled){
        return new ArcaneError(
            ERROR_CODES.cancelled,
            'The Arcane operation was cancelled.',
            {cause:error,exitCode:130}
        );
    }

    const reportedCode=typeof error?.code==='string'&&/^ARCANE_[A-Z0-9_]+$/u.test(error.code)
        ?error.code
        :fallbackCode;

    return new ArcaneError(
        reportedCode,
        error instanceof Error?error.message:String(error??'The Arcane operation failed.'),
        {
            cause:error,
            details:error?.details,
            exitCode:Number.isInteger(error?.exitCode)?error.exitCode:undefined
        }
    );
}

export function errorRecord(error){
    const normalized=normalizeError(error);
    return {
        code:normalized.code,
        message:normalized.message,
        ...(normalized.details===undefined?{}:{details:normalized.details})
    };
}

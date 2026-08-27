import {ArcaneError,ERROR_CODES,throwIfAborted} from './errors.mjs';
import {
    deleteMailCredential,
    getMailCredentialStatus,
    readMailCredential,
    setMailCredential
} from './mail-credentials.mjs';
import {sendResendMail,startResendMailServer} from './mail-server.mjs';

export const MAIL_COMMAND_ACTIONS=Object.freeze([
    'key-set',
    'key-status',
    'key-delete',
    'send',
    'serve'
]);

const ACTION_SET=new Set(MAIL_COMMAND_ACTIONS);

function usage(message){
    throw new ArcaneError(ERROR_CODES.usage,message);
}

function validateOptions(options){
    if(!options||typeof options!=='object'||Array.isArray(options)){
        usage('Mail command options must be an object.');
    }
    if(typeof options.action!=='string'||!ACTION_SET.has(options.action)){
        usage(`Mail action must be one of: ${MAIL_COMMAND_ACTIONS.join(', ')}.`);
    }
    return options;
}

function dependency(options,name,fallback){
    const value=options[name]??fallback;
    if(typeof value!=='function'){
        usage(`${name} must be a function when supplied.`);
    }
    return value;
}

function recipientList(value,label){
    const entries=Array.isArray(value)
        ? value
        : typeof value==='string'
            ? value.split(',')
            : null;
    if(!entries||entries.length===0||entries.length>50){
        usage(`${label} must contain one to 50 comma-separated email addresses.`);
    }
    const result=entries.map(function normalizeMailRecipient(entry){
        if(typeof entry!=='string'||!entry.trim()){
            usage(`${label} contains an empty email address.`);
        }
        return entry.trim();
    });
    if(new Set(result.map(function lowercaseRecipient(entry){
        return entry.toLowerCase();
    })).size!==result.length){
        usage(`${label} must not contain duplicate email addresses.`);
    }
    return result;
}

function originList(value){
    const entries=Array.isArray(value)?value:[value];
    if(entries.length===0||entries.some(function invalidOrigin(entry){
        return typeof entry!=='string'||!entry.trim();
    })){
        usage('Mail serve requires at least one exact allowed origin.');
    }
    return entries.map(function normalizeAllowedOrigin(entry){return entry.trim();});
}

function credentialOptions(options){
    return {
        profile:options.profile,
        platform:options.platform,
        systemRoot:options.systemRoot,
        temporaryDirectory:options.temporaryDirectory,
        spawnImpl:options.spawnImpl,
        runner:options.credentialRunner,
        signal:options.signal,
        timeoutMs:options.credentialTimeoutMs
    };
}

async function setCredential(options){
    const readSecret=dependency(options,'readSecret',null);
    const store=dependency(options,'setCredential',setMailCredential);
    throwIfAborted(options.signal);
    let secret='';
    try{
        secret=await readSecret();
        throwIfAborted(options.signal);
        return await store({...credentialOptions(options),secret});
    }finally{
        secret='';
    }
}

async function credentialStatus(options){
    const status=dependency(options,'getCredentialStatus',getMailCredentialStatus);
    throwIfAborted(options.signal);
    return status(credentialOptions(options));
}

async function deleteCredential(options){
    const remove=dependency(options,'deleteCredential',deleteMailCredential);
    throwIfAborted(options.signal);
    return remove(credentialOptions(options));
}

function safeSendFailure(result){
    return Object.freeze({
        provider:'resend',
        status:result.status,
        classification:result.classification,
        requestId:result.requestId,
        providerStatus:result.providerStatus,
        recipientCount:result.recipientCount,
        retryable:result.retryable===true,
        uncertain:result.uncertain===true,
        ...(typeof result.code==='string'?{code:result.code}:{}),
        ...(Number.isSafeInteger(result.retryAfterMs)&&result.retryAfterMs>0
            ?{retryAfterMs:result.retryAfterMs}
            :{})
    });
}

async function sendMail(options){
    const readReport=dependency(options,'readReport',null);
    const readCredential=dependency(options,'readCredential',readMailCredential);
    const send=dependency(options,'sendMail',sendResendMail);
    throwIfAborted(options.signal);
    const report=await readReport();
    throwIfAborted(options.signal);
    let apiKey=await readCredential(credentialOptions(options));
    if(apiKey===null){
        throw new ArcaneError(
            ERROR_CODES.prerequisiteMissing,
            `No Resend credential is configured for profile ${String(options.profile)}.`
        );
    }
    if(typeof apiKey!=='string'||!apiKey){
        throw new ArcaneError(
            ERROR_CODES.operationFailed,
            'The configured Resend credential could not be read.'
        );
    }
    try{
        throwIfAborted(options.signal);
        const result=await send({
            apiKey,
            appId:'arcane-cli',
            fetchImpl:options.fetchImpl,
            from:options.from,
            maxProviderResponseBytes:options.maxProviderResponseBytes,
            maxRequestBytes:options.maxRequestBytes,
            onEvent:options.onEvent,
            providerTimeoutMs:options.requestTimeout,
            report,
            reportKey:options.reportKey,
            requestIdFactory:options.requestIdFactory,
            retryableDelayMs:options.retryableDelayMs,
            signal:options.signal
        });
        if(result?.classification==='accepted'&&result.status==='accepted'){
            return result;
        }
        const details=safeSendFailure(result||{});
        throw new ArcaneError(
            ERROR_CODES.operationFailed,
            `Resend did not authoritatively accept the mail request (${details.classification||'unknown'}).`,
            {details}
        );
    }finally{
        apiKey='';
    }
}

async function serveMail(options){
    const readCredential=dependency(options,'readCredential',readMailCredential);
    const readAppKey=dependency(options,'readAppKey',null);
    const startServer=dependency(options,'startServer',startResendMailServer);
    throwIfAborted(options.signal);
    let apiKey=await readCredential(credentialOptions(options));
    if(apiKey===null){
        throw new ArcaneError(
            ERROR_CODES.prerequisiteMissing,
            `No Resend credential is configured for profile ${String(options.profile)}.`
        );
    }
    if(typeof apiKey!=='string'||!apiKey){
        throw new ArcaneError(
            ERROR_CODES.operationFailed,
            'The configured Resend credential could not be read.'
        );
    }
    let appKey='';
    try{
        throwIfAborted(options.signal);
        appKey=await readAppKey();
        if(typeof appKey!=='string'||!appKey){
            throw new ArcaneError(
                ERROR_CODES.operationFailed,
                'The local Mail gateway app key could not be read.'
            );
        }
        throwIfAborted(options.signal);
        const recipientAllowlist=recipientList(options.allowTo,'allowTo');
        const errorRecipients=options.errorTo===undefined
            ? recipientAllowlist
            : recipientList(options.errorTo,'errorTo');
        return await startServer({
            apiKey,
            appKey,
            appId:options.appId,
            allowedOrigins:originList(options.origin),
            bodyQueueTimeoutMs:options.bodyQueueTimeoutMs,
            bodyTimeoutMs:options.bodyTimeoutMs,
            errorRecipients,
            fetchImpl:options.fetchImpl,
            from:options.from,
            host:options.host,
            maxConcurrentBodyReads:options.maxConcurrentBodyReads,
            maxConcurrentSends:options.maxConcurrentSends,
            maxMessageBytes:options.maxMessageBytes,
            maxProviderResponseBytes:options.maxProviderResponseBytes,
            maxQueuedBodyReads:options.maxQueuedBodyReads,
            maxQueuedSends:options.maxQueuedSends,
            maxQueuedMessageBytes:options.maxQueuedMessageBytes,
            maxRequestBytes:options.maxRequestBytes,
            onEvent:options.onEvent,
            port:options.port,
            providerTimeoutMs:options.requestTimeout,
            recipientAllowlist,
            requestIdFactory:options.requestIdFactory,
            retryableDelayMs:options.retryableDelayMs,
            sendQueueTimeoutMs:options.sendQueueTimeoutMs,
            signal:options.signal
        });
    }finally{
        apiKey='';
        appKey='';
    }
}

export async function executeMailCommand(rawOptions={}){
    const options=validateOptions(rawOptions);
    switch(options.action){
        case 'key-set':return setCredential(options);
        case 'key-status':return credentialStatus(options);
        case 'key-delete':return deleteCredential(options);
        case 'send':return sendMail(options);
        case 'serve':return serveMail(options);
        default:usage('Unsupported Mail action.');
    }
}

export default executeMailCommand;

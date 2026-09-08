import Is from 'strong-type';
import {ArcaneError,ERROR_CODES,throwIfAborted} from './errors.mjs';
import {
    deleteMailCredential,
    getMailCredentialStatus,
    mailCredentialLocation,
    readMailCredential,
    readMailConfiguration,
    setMailCredential
} from './mail-credentials.mjs';
import {sendResendMail,startResendMailServer} from './mail-server.mjs';

const is = new Is(false);

export const MAIL_COMMAND_ACTIONS=[
    'key-set',
    'key-status',
    'key-delete',
    'send',
    'serve'
];

const ACTION_SET=new Set(MAIL_COMMAND_ACTIONS);

function throwMailUsageError(message){
    throw new ArcaneError(ERROR_CODES.usage,message);
}

function validateMailCommandOptions(options){
    if(!options||!is.object(options)||is.array(options)){
        throwMailUsageError('Mail command options must be an object.');
    }
    if(!is.string(options.action)||!ACTION_SET.has(options.action)){
        throwMailUsageError(`Mail action must be one of: ${MAIL_COMMAND_ACTIONS.join(', ')}.`);
    }
    return options;
}

function resolveMailCommandDependency(options,name,fallback){
    const value=options[name]??fallback;
    if(!is.function(value)){
        throwMailUsageError(`${name} must be a function when supplied.`);
    }
    return value;
}

function mailRecipientOptions(value,label){
    if(value===undefined||value===null||value===''){
        return [];
    }
    if(is.array(value))return [...value];
    if(is.string(value))return value.split(',');
    throwMailUsageError(`${label} must be an address array or comma-separated string.`);
}

function mailCredentialOptions(options){
    return {
        profile:options.profile,
        cwd:options.cwd,
        workspaceRoot:options.workspaceRoot,
        signal:options.signal
    };
}

function configuredMailOption(options, settings, name, alias = name) {
    if (options[alias] !== undefined) return options[alias];
    if (options[name] !== undefined) return options[name];
    return settings[name];
}

async function setMailCredentialFromInput(options){
    const readSecret=resolveMailCommandDependency(options,'readSecret',null);
    const store=resolveMailCommandDependency(options,'setCredential',setMailCredential);
    throwIfAborted(options.signal);
    let secret='';
    try{
        secret=await readSecret();
        throwIfAborted(options.signal);
        return await store({...mailCredentialOptions(options),secret});
    }finally{
        secret='';
    }
}

async function readMailCredentialStatus(options){
    const status=resolveMailCommandDependency(options,'getCredentialStatus',getMailCredentialStatus);
    throwIfAborted(options.signal);
    return status(mailCredentialOptions(options));
}

async function deleteMailCredentialProfile(options){
    const remove=resolveMailCommandDependency(options,'deleteCredential',deleteMailCredential);
    throwIfAborted(options.signal);
    return remove(mailCredentialOptions(options));
}

async function sendMailFromReport(options){
    const readReport=resolveMailCommandDependency(options,'readReport',null);
    const send=resolveMailCommandDependency(options,'sendMail',sendResendMail);
    throwIfAborted(options.signal);
    const report=await readReport();
    throwIfAborted(options.signal);
    const readConfiguration=resolveMailCommandDependency(options,'readServerSettings',readMailConfiguration);
    const mailSettings=await readConfiguration(options);
    throwIfAborted(options.signal);
    let apiKey=await readMailProviderKey(options,mailSettings);
    try{
        throwIfAborted(options.signal);
        const result=await send({
            apiKey,
            appId:'arcane-cli',
            fetchImpl:options.fetchImpl,
            from:configuredMailOption(options,mailSettings,'from'),
            onEvent:options.onEvent,
            providerTimeoutMs:configuredMailOption(options,mailSettings,'providerTimeoutMs','requestTimeout'),
            report,
            reportKey:options.reportKey,
            requestIdFactory:options.requestIdFactory,
            retryableDelayMs:configuredMailOption(options,mailSettings,'retryableDelayMs'),
            signal:options.signal
        });
        if(result?.classification==='accepted'&&result.status==='accepted'){
            return result;
        }
        const details=result&&is.object(result)&&!is.array(result)
            ?result
            :{provider:'resend',result};
        throw new ArcaneError(
            ERROR_CODES.operationFailed,
            `Resend did not authoritatively accept the mail request (${details.classification||'unknown'}).`,
            {details}
        );
    }finally{
        apiKey='';
    }
}

async function readMailProviderKey(options, mailSettings){
    const credentialOptions=mailCredentialOptions(
        {...options,profile:options.profile??mailSettings?.profile}
    );
    const apiKey = mailSettings !== undefined && (options.readCredential ?? null) === null
        ? mailSettings.apiKey
        : await resolveMailCommandDependency(options, 'readCredential', readMailCredential)(credentialOptions);
    if(apiKey===null){
        const location=mailCredentialLocation(credentialOptions);
        const nestedSetting = location.profile === 'mail'
            ? 'mail.apiKey'
            : `mail.profiles[${JSON.stringify(location.profile)}].apiKey`;
        throw new ArcaneError(
            ERROR_CODES.prerequisiteMissing,
            `Missing ${location.setting} or ${nestedSetting} in ${location.filePath}.`
        );
    }
    if(!is.string(apiKey)||!apiKey){
        throw new ArcaneError(
            ERROR_CODES.operationFailed,
            'The configured Resend credential could not be read.'
        );
    }
    return apiKey;
}

async function serveMailGateway(options){
    const startServer=resolveMailCommandDependency(options,'startServer',startResendMailServer);
    const readServerSettings = resolveMailCommandDependency(options, 'readServerSettings', readMailConfiguration);
    throwIfAborted(options.signal);
    const serverSettings = await readServerSettings(options);
    throwIfAborted(options.signal);
    let apiKey=await readMailProviderKey(options, serverSettings);
    try{
        throwIfAborted(options.signal);
        const missingSettings = [];
        if (!serverSettings.certPath) missingSettings.push('MAIL_TLS_CERT_PATH');
        if (!serverSettings.keyPath) missingSettings.push('MAIL_TLS_KEY_PATH');
        if (missingSettings.length) {
            const location = mailCredentialLocation(options);
            throw new ArcaneError(
                ERROR_CODES.prerequisiteMissing,
                `Missing ${missingSettings.join(', ')} in ${location.filePath}, or the corresponding mail.certPath/mail.keyPath in arcane.config.json. Mail HTTPS requires a certificate and private key.`
            );
        }
        const recipientAllowlist=mailRecipientOptions(
            configuredMailOption(options,serverSettings,'recipientAllowlist','allowTo'),'recipientAllowlist'
        );
        const errorTo=configuredMailOption(options,serverSettings,'errorRecipients','errorTo');
        const errorRecipients=errorTo===undefined
            ? recipientAllowlist
            : mailRecipientOptions(errorTo,'errorRecipients');
        const origins=configuredMailOption(options,serverSettings,'origins','origin');
        return await startServer({
            apiKey,
            appId:configuredMailOption(options,serverSettings,'appId'),
            allowedOrigins:origins===undefined
                ?[]
                :is.array(origins)?[...origins]:[origins],
            bodyTimeoutMs:configuredMailOption(options,serverSettings,'bodyTimeoutMs'),
            certPath:serverSettings.certPath,
            errorRecipients,
            fetchImpl:options.fetchImpl,
            from:configuredMailOption(options,serverSettings,'from'),
            host:configuredMailOption(options,serverSettings,'host')??'0.0.0.0',
            keyPath:serverSettings.keyPath,
            onEvent:options.onEvent,
            port:configuredMailOption(options,serverSettings,'port'),
            providerTimeoutMs:configuredMailOption(options,serverSettings,'providerTimeoutMs','requestTimeout'),
            recipientAllowlist,
            requestIdFactory:options.requestIdFactory,
            retryableDelayMs:configuredMailOption(options,serverSettings,'retryableDelayMs'),
            signal:options.signal,
            verifySubscription:options.verifySubscription
        });
    }finally{
        apiKey='';
    }
}

export async function executeMailCommand(rawOptions={}){
    const options=validateMailCommandOptions(rawOptions);
    switch(options.action){
        case 'key-set':return setMailCredentialFromInput(options);
        case 'key-status':return readMailCredentialStatus(options);
        case 'key-delete':return deleteMailCredentialProfile(options);
        case 'send':return sendMailFromReport(options);
        case 'serve':return serveMailGateway(options);
        default:throwMailUsageError('Unsupported Mail action.');
    }
}

export default executeMailCommand;

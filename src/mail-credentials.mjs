import Is from 'strong-type';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {ArcaneError,ERROR_CODES,throwIfAborted} from './errors.mjs';

const is = new Is(false);

export function mailCredentialLocation(options={}){
    const profile=options.profile??'mail';
    if(!is.string(profile)||!profile){
        throw new ArcaneError(ERROR_CODES.usage,'Mail credential profile must be a nonempty string.');
    }
    return {
        filePath:path.resolve(options.cwd??options.workspaceRoot??process.cwd(),'.arcane.env.json'),
        profile,
        setting:profile==='mail'?'RESEND_API_KEY':`MAIL_PROFILES[${JSON.stringify(profile)}].RESEND_API_KEY`
    };
}

async function readMailSettings(filePath,signal){
    throwIfAborted(signal);
    let content;
    try{
        content=await readFile(filePath,{encoding:'utf8',signal});
    }catch(error){
        if(error.code==='ENOENT'){
            return {};
        }
        throw error;
    }
    let settings;
    try{
        settings=JSON.parse(content);
    }catch{
        // A JSON parser error can quote the credential itself.
        throw new ArcaneError(ERROR_CODES.usage,`Unable to parse ${filePath} as JSON.`);
    }
    if(!settings||!is.object(settings)||is.array(settings)){
        throw new ArcaneError(ERROR_CODES.usage,`${filePath} must contain a JSON object.`);
    }
    return settings;
}

function mailProfileSettings(settings,location,nested=false){
    const source=nested?settings.mail:settings;
    if(source===undefined)return undefined;
    if(!source||!is.object(source)||is.array(source)){
        throw new ArcaneError(ERROR_CODES.usage,`mail in ${location.filePath} must be an object.`);
    }
    if(location.profile==='mail'){
        return source;
    }
    const profiles=nested?source.profiles:source.MAIL_PROFILES;
    const label=nested?'mail.profiles':'MAIL_PROFILES';
    if(profiles===undefined){
        return undefined;
    }
    if(!profiles||!is.object(profiles)||is.array(profiles)){
        throw new ArcaneError(ERROR_CODES.usage,`${label} in ${location.filePath} must be an object.`);
    }
    if(!Object.hasOwn(profiles,location.profile)){
        return undefined;
    }
    const profileSettings=profiles[location.profile];
    if(!profileSettings||!is.object(profileSettings)||is.array(profileSettings)){
        throw new ArcaneError(
            ERROR_CODES.usage,
            `${label}[${JSON.stringify(location.profile)}] in ${location.filePath} must be an object.`
        );
    }
    return profileSettings;
}

function mailCredentialEntry(settings, location) {
    const nestedSettings = mailProfileSettings(settings, location, true);
    const nestedEntry = {
        profileSettings: nestedSettings,
        key: 'apiKey',
        setting: location.profile === 'mail'
            ? 'mail.apiKey'
            : `mail.profiles[${JSON.stringify(location.profile)}].apiKey`
    };
    if (nestedSettings && Object.hasOwn(nestedSettings, 'apiKey')) return nestedEntry;
    const legacySettings = mailProfileSettings(settings, location);
    if (legacySettings && Object.hasOwn(legacySettings, 'RESEND_API_KEY')) {
        return {profileSettings: legacySettings, key: 'RESEND_API_KEY', setting: location.setting};
    }
    return nestedEntry;
}

function configuredMailKey(settings,location){
    const entry=mailCredentialEntry(settings,location);
    const apiKey=entry.profileSettings?.[entry.key];
    if(apiKey===undefined||apiKey===null||apiKey===''){
        return null;
    }
    if(!is.string(apiKey)){
        throw new ArcaneError(
            ERROR_CODES.usage,
            `${entry.setting} in ${location.filePath} must be a string.`
        );
    }
    return apiKey;
}

function mailCredentialStatus(profile,exists){
    return {profile,provider:'resend',storage:'.arcane.env.json',exists};
}

export async function setMailCredential(options={}){
    const location=mailCredentialLocation(options);
    if(!is.string(options.secret)||!options.secret){
        throw new ArcaneError(ERROR_CODES.usage,'The Resend API key must be a nonempty string.');
    }
    const settings=await readMailSettings(location.filePath,options.signal);
    const entry=mailCredentialEntry(settings,location);
    if(entry.profileSettings){
        entry.profileSettings[entry.key]=options.secret;
    }else{
        settings.mail??={};
        if(location.profile==='mail'){
            settings.mail.apiKey=options.secret;
        }else{
            settings.mail.profiles={
                ...settings.mail.profiles,
                [location.profile]:{apiKey:options.secret}
            };
        }
    }
    throwIfAborted(options.signal);
    await writeFile(location.filePath,`${JSON.stringify(settings,null,2)}\n`,{
        encoding:'utf8',
        mode:0o600,
        signal:options.signal
    });
    return mailCredentialStatus(location.profile,true);
}

export async function readMailCredential(options={}){
    const location=mailCredentialLocation(options);
    const settings=await readMailSettings(location.filePath,options.signal);
    return configuredMailKey(settings,location);
}

export async function readMailConfiguration(options = {}) {
    const directory = path.resolve(options.cwd ?? options.workspaceRoot ?? process.cwd());
    const configPath = path.join(directory, 'arcane.config.json');
    const envPath = path.join(directory, '.arcane.env.json');
    const readCredentialFromFile = (options.readCredential ?? null) === null;
    const [config, secrets] = await Promise.all(
        [
            readMailSettings(configPath, options.signal),
            options.action !== 'send' || readCredentialFromFile
                ? readMailSettings(envPath, options.signal)
                : {}
        ]
    );
    const mailSettings = config.mail === undefined ? {} : config.mail;
    if (!mailSettings || !is.object(mailSettings) || is.array(mailSettings)) {
        throw new ArcaneError(ERROR_CODES.usage, `mail in ${configPath} must be an object.`);
    }
    const location = mailCredentialLocation(
        {...options, profile: options.profile !== undefined ? options.profile : mailSettings.profile}
    );
    const configuration = {profile: location.profile};
    for (const name of [
        'host', 'port', 'origins', 'from', 'appId', 'recipientAllowlist',
        'errorRecipients', 'bodyTimeoutMs', 'providerTimeoutMs', 'retryableDelayMs'
    ]) {
        if (mailSettings[name] !== undefined) configuration[name] = mailSettings[name];
    }
    if (readCredentialFromFile) {
        configuration.apiKey = configuredMailKey(secrets, location);
    }
    // Sending a report does not consume listener certificate configuration.
    if (options.action === 'send') return configuration;
    const tlsSettings = {
        MAIL_TLS_CERT_PATH: 'certPath',
        MAIL_TLS_KEY_PATH: 'keyPath'
    };
    for (const [setting, option] of Object.entries(tlsSettings)) {
        const value = options[option] !== undefined
            ? options[option]
            : mailSettings[option] !== undefined ? mailSettings[option] : secrets[setting];
        if (value === undefined || value === null || value === '') {
            continue;
        }
        if (!is.string(value)) {
            throw new ArcaneError(
                ERROR_CODES.usage,
                `mail.${option} (${setting}) must be a PEM file path string.`
            );
        }
        configuration[option] = path.resolve(directory, value);
    }
    return configuration;
}

export async function getMailCredentialStatus(options={}){
    const location=mailCredentialLocation(options);
    const settings=await readMailSettings(location.filePath,options.signal);
    return mailCredentialStatus(location.profile,configuredMailKey(settings,location)!==null);
}

export async function deleteMailCredential(options={}){
    const location=mailCredentialLocation(options);
    const settings=await readMailSettings(location.filePath,options.signal);
    let changed=false;
    for(const nested of [true,false]){
        const profileSettings=mailProfileSettings(settings,location,nested);
        const key=nested?'apiKey':'RESEND_API_KEY';
        if(profileSettings&&Object.hasOwn(profileSettings,key)){
            delete profileSettings[key];
            changed=true;
        }
    }
    if(changed){
        throwIfAborted(options.signal);
        await writeFile(location.filePath,`${JSON.stringify(settings,null,2)}\n`,{
            encoding:'utf8',
            signal:options.signal
        });
    }
    return mailCredentialStatus(location.profile,false);
}

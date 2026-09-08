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
        filePath:path.resolve(options.cwd??options.workspaceRoot??process.cwd(),'.env.json'),
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

function mailProfileSettings(settings,location){
    if(location.profile==='mail'){
        return settings;
    }
    if(settings.MAIL_PROFILES===undefined){
        return undefined;
    }
    if(!settings.MAIL_PROFILES||!is.object(settings.MAIL_PROFILES)||is.array(settings.MAIL_PROFILES)){
        throw new ArcaneError(ERROR_CODES.usage,`MAIL_PROFILES in ${location.filePath} must be an object.`);
    }
    if(!Object.hasOwn(settings.MAIL_PROFILES,location.profile)){
        return undefined;
    }
    const profileSettings=settings.MAIL_PROFILES[location.profile];
    if(!profileSettings||!is.object(profileSettings)||is.array(profileSettings)){
        throw new ArcaneError(
            ERROR_CODES.usage,
            `MAIL_PROFILES[${JSON.stringify(location.profile)}] in ${location.filePath} must be an object.`
        );
    }
    return profileSettings;
}

function configuredMailKey(settings,location){
    const apiKey=mailProfileSettings(settings,location)?.RESEND_API_KEY;
    if(apiKey===undefined||apiKey===null||apiKey===''){
        return null;
    }
    if(!is.string(apiKey)){
        throw new ArcaneError(
            ERROR_CODES.usage,
            `${location.setting} in ${location.filePath} must be a string.`
        );
    }
    return apiKey;
}

function mailCredentialStatus(profile,exists){
    return {profile,provider:'resend',storage:'.env.json',exists};
}

export async function setMailCredential(options={}){
    const location=mailCredentialLocation(options);
    if(!is.string(options.secret)||!options.secret){
        throw new ArcaneError(ERROR_CODES.usage,'The Resend API key must be a nonempty string.');
    }
    const settings=await readMailSettings(location.filePath,options.signal);
    const profileSettings=mailProfileSettings(settings,location);
    const updatedProfile={...profileSettings,RESEND_API_KEY:options.secret};
    const updatedSettings=location.profile==='mail'
        ?updatedProfile
        :{
            ...settings,
            MAIL_PROFILES:{...settings.MAIL_PROFILES,[location.profile]:updatedProfile}
        };
    throwIfAborted(options.signal);
    await writeFile(location.filePath,`${JSON.stringify(updatedSettings,null,2)}\n`,{
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

export async function readMailServerSettings(options = {}) {
    const location = mailCredentialLocation(options);
    const settings = await readMailSettings(location.filePath, options.signal);
    const serverSettings = (options.readCredential ?? null) === null
        ? {apiKey: configuredMailKey(settings, location)}
        : {};
    const tlsSettings = {
        MAIL_TLS_CERT_PATH: 'certPath',
        MAIL_TLS_KEY_PATH: 'keyPath'
    };
    for (const [setting, option] of Object.entries(tlsSettings)) {
        const value = settings[setting];
        if (value === undefined || value === null || value === '') {
            continue;
        }
        if (!is.string(value)) {
            throw new ArcaneError(
                ERROR_CODES.usage,
                `${setting} in ${location.filePath} must be a PEM file path string.`
            );
        }
        serverSettings[option] = path.resolve(path.dirname(location.filePath), value);
    }
    return serverSettings;
}

export async function getMailCredentialStatus(options={}){
    const location=mailCredentialLocation(options);
    const settings=await readMailSettings(location.filePath,options.signal);
    return mailCredentialStatus(location.profile,configuredMailKey(settings,location)!==null);
}

export async function deleteMailCredential(options={}){
    const location=mailCredentialLocation(options);
    const settings=await readMailSettings(location.filePath,options.signal);
    const profileSettings=mailProfileSettings(settings,location);
    if(profileSettings&&Object.hasOwn(profileSettings,'RESEND_API_KEY')){
        const {RESEND_API_KEY,...remainingSettings}=profileSettings;
        const updatedSettings=location.profile==='mail'
            ?remainingSettings
            :{
                ...settings,
                MAIL_PROFILES:{...settings.MAIL_PROFILES,[location.profile]:remainingSettings}
            };
        throwIfAborted(options.signal);
        await writeFile(location.filePath,`${JSON.stringify(updatedSettings,null,2)}\n`,{
            encoding:'utf8',
            signal:options.signal
        });
    }
    return mailCredentialStatus(location.profile,false);
}

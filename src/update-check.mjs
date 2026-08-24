import {ArcaneError,ERROR_CODES,throwIfAborted} from './errors.mjs';
import {parseSemver} from './packager/core.mjs';
import {SDK_NAME,SDK_VERSION} from './constants.mjs';

export const SDK_UPDATE_REGISTRY='https://registry.npmjs.org/';
export const SDK_UPDATE_TIMEOUT_MS=2500;

const MAX_RESPONSE_BYTES=32*1024;
const MAX_DIST_TAGS=64;
const DIST_TAG_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const FORBIDDEN_DIST_TAG_KEYS=new Set(['__proto__','constructor','prototype']);

function updateFailure(message,{cause,details}={}){
    return new ArcaneError(ERROR_CODES.updateCheckFailed,message,{cause,details});
}

function plainObject(value){
    return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

function canonicalPackageName(value){
    if(value!==SDK_NAME){
        throw updateFailure('The SDK update check is restricted to the installed Arcane SDK package.');
    }
    return value;
}

export function validateUpdateRegistry(value,{
    allowedHosts=new Set(['registry.npmjs.org'])
}={}){
    let registry;
    try{
        registry=new URL(value);
    }catch(error){
        throw updateFailure('The SDK update registry URL is invalid.',{cause:error});
    }
    if(registry.protocol!=='https:'
        ||registry.username||registry.password
        ||registry.search||registry.hash
        ||registry.pathname!=='/'
        ||(registry.port&&registry.port!=='443')
        ||!allowedHosts.has(registry.hostname.toLowerCase())){
        throw updateFailure(
            'The SDK update registry must be an approved credential-free HTTPS origin.',
            {details:{registryOrigin:registry.origin}}
        );
    }
    return registry;
}

function registryEndpoint(registry,packageName){
    return new URL('-/package/'+encodeURIComponent(packageName)+'/dist-tags',registry);
}

function validateTimeout(value){
    if(!Number.isSafeInteger(value)||value<100||value>10_000){
        throw updateFailure('The SDK update timeout must be between 100 and 10000 milliseconds.');
    }
    return value;
}

function linkedAbortSignal(signal,timeoutMs,{schedule=setTimeout,cancel=clearTimeout}={}){
    const controller=new AbortController();
    let timedOut=false;
    const abort=()=>controller.abort(signal?.reason);
    if(signal?.aborted){
        abort();
    }else{
        signal?.addEventListener('abort',abort,{once:true});
    }
    const timer=schedule(()=>{
        timedOut=true;
        controller.abort(new Error('SDK update registry request timed out.'));
    },timeoutMs);
    timer?.unref?.();
    return {
        signal:controller.signal,
        timedOut:()=>timedOut,
        cleanup(){
            cancel(timer);
            signal?.removeEventListener('abort',abort);
        }
    };
}

async function boundedResponseBytes(response){
    const contentType=response.headers?.get?.('content-type')??'';
    if(!/^(?:application\/json|application\/[A-Za-z0-9.+-]+\+json)(?:\s*;|$)/iu.test(contentType)){
        throw updateFailure('The npm registry returned a non-JSON update response.');
    }
    const declared=response.headers?.get?.('content-length');
    if(declared!==null&&declared!==undefined&&declared!==''){
        if(!/^\d+$/u.test(declared)||Number(declared)>MAX_RESPONSE_BYTES){
            throw updateFailure('The npm registry update response exceeded the byte limit.');
        }
    }
    if(!response.body||typeof response.body.getReader!=='function'){
        throw updateFailure('The npm registry returned no readable update response.');
    }
    const reader=response.body.getReader();
    const chunks=[];
    let total=0;
    try{
        while(true){
            const {done,value}=await reader.read();
            if(done)break;
            if(!(value instanceof Uint8Array)){
                await reader.cancel();
                throw updateFailure('The npm registry update response was not a byte stream.');
            }
            total+=value.byteLength;
            if(total>MAX_RESPONSE_BYTES){
                await reader.cancel();
                throw updateFailure('The npm registry update response exceeded the byte limit.');
            }
            chunks.push(value);
        }
    }finally{
        reader.releaseLock?.();
    }
    const bytes=new Uint8Array(total);
    let offset=0;
    for(const chunk of chunks){
        bytes.set(chunk,offset);
        offset+=chunk.byteLength;
    }
    try{
        return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    }catch(error){
        throw updateFailure('The npm registry update response was not valid UTF-8.',{cause:error});
    }
}

function canonicalDistTags(value){
    if(!plainObject(value)){
        throw updateFailure('The npm registry update response was not a dist-tag object.');
    }
    const entries=Object.entries(value);
    if(entries.length<1||entries.length>MAX_DIST_TAGS){
        throw updateFailure('The npm registry update response contained an invalid dist-tag count.');
    }
    const tags=Object.create(null);
    for(const [tag,version] of entries){
        if(!DIST_TAG_PATTERN.test(tag)||FORBIDDEN_DIST_TAG_KEYS.has(tag)
            ||typeof version!=='string'||version.length>128){
            throw updateFailure('The npm registry update response contained an invalid dist-tag.');
        }
        try{
            parseSemver(version);
        }catch(error){
            throw updateFailure('The npm registry dist-tag '+tag+' is not a semantic version.',{cause:error});
        }
        tags[tag]=version;
    }
    return Object.freeze(tags);
}

function comparePrerelease(left,right){
    const length=Math.max(left.length,right.length);
    for(let index=0;index<length;index+=1){
        const leftPart=left[index];
        const rightPart=right[index];
        if(leftPart===undefined)return -1;
        if(rightPart===undefined)return 1;
        if(leftPart===rightPart)continue;
        const leftNumeric=/^\d+$/u.test(leftPart);
        const rightNumeric=/^\d+$/u.test(rightPart);
        if(leftNumeric&&rightNumeric){
            if(leftPart.length!==rightPart.length)return leftPart.length<rightPart.length?-1:1;
            return leftPart<rightPart?-1:1;
        }
        if(leftNumeric!==rightNumeric)return leftNumeric?-1:1;
        return leftPart<rightPart?-1:1;
    }
    return 0;
}

export function compareSdkVersions(leftValue,rightValue){
    const left=parseSemver(leftValue);
    const right=parseSemver(rightValue);
    for(const key of ['major','minor','patch']){
        if(left[key]!==right[key])return left[key]<right[key]?-1:1;
    }
    if(!left.prerelease.length&&!right.prerelease.length)return 0;
    if(!left.prerelease.length)return 1;
    if(!right.prerelease.length)return -1;
    return comparePrerelease(left.prerelease,right.prerelease);
}

export function updateTagForVersion(value){
    try{
        return parseSemver(value).prerelease.length?'dev':'latest';
    }catch(error){
        throw updateFailure('The installed SDK version is invalid.',{cause:error});
    }
}

export async function checkForSdkUpdate({
    packageName=SDK_NAME,
    currentVersion=SDK_VERSION,
    registry=SDK_UPDATE_REGISTRY,
    allowedRegistryHosts,
    timeoutMs=SDK_UPDATE_TIMEOUT_MS,
    fetchImpl=globalThis.fetch,
    signal,
    onEvent,
    clock=()=>new Date()
}={}){
    throwIfAborted(signal);
    const selectedPackage=canonicalPackageName(packageName);
    const selectedRegistry=validateUpdateRegistry(registry,{
        ...(allowedRegistryHosts===undefined?{}:{allowedHosts:allowedRegistryHosts})
    });
    const selectedTimeout=validateTimeout(timeoutMs);
    if(typeof fetchImpl!=='function'){
        throw updateFailure('The SDK update HTTP client is unavailable.');
    }
    const tag=updateTagForVersion(currentVersion);
    const endpoint=registryEndpoint(selectedRegistry,selectedPackage);
    await onEvent?.({
        type:'update.check.started',
        message:'Checking npm '+tag+' for '+selectedPackage+'.',
        data:{packageName:selectedPackage,currentVersion,tag,registry:selectedRegistry.origin}
    });
    const linked=linkedAbortSignal(signal,selectedTimeout);
    try{
        const response=await fetchImpl(endpoint,{
            method:'GET',
            headers:Object.freeze({accept:'application/json'}),
            redirect:'error',
            cache:'no-store',
            credentials:'omit',
            referrerPolicy:'no-referrer',
            signal:linked.signal
        });
        throwIfAborted(signal);
        if(!response||typeof response.status!=='number'
            ||response.redirected===true
            ||(response.url&&response.url!==endpoint.href)){
            throw updateFailure('The npm registry update response changed origin or request identity.');
        }
        if(response.status!==200){
            throw updateFailure(
                'The npm registry update request failed with HTTP '+response.status+'.',
                {details:{status:response.status}}
            );
        }
        const body=await boundedResponseBytes(response);
        let document;
        try{
            document=JSON.parse(body);
        }catch(error){
            throw updateFailure('The npm registry update response was not valid JSON.',{cause:error});
        }
        const tags=canonicalDistTags(document);
        const registryVersion=tags[tag];
        if(!registryVersion){
            throw updateFailure('The npm registry does not define the required '+tag+' dist-tag.');
        }
        let comparison;
        try{
            comparison=compareSdkVersions(currentVersion,registryVersion);
        }catch(error){
            if(error instanceof ArcaneError&&error.code===ERROR_CODES.updateCheckFailed)throw error;
            throw updateFailure('The installed or registry SDK version is invalid.',{cause:error});
        }
        const status=comparison<0?'update-available':comparison===0?'current':'ahead';
        const result=Object.freeze({
            packageName:selectedPackage,
            currentVersion,
            registryVersion,
            tag,
            status,
            updateAvailable:status==='update-available',
            registry:selectedRegistry.origin,
            checkedAt:clock().toISOString()
        });
        await onEvent?.({
            type:'update.check.completed',
            message:status==='update-available'
                ?selectedPackage+' '+registryVersion+' is available under npm '+tag+'.'
                :selectedPackage+' '+currentVersion+' is '+status+' for npm '+tag+'.',
            data:result
        });
        return result;
    }catch(error){
        if(signal?.aborted){
            throwIfAborted(signal);
        }
        const normalized=error instanceof ArcaneError&&error.code===ERROR_CODES.updateCheckFailed
            ?error
            :updateFailure(
                linked.timedOut()
                    ?'The npm registry update request exceeded '+selectedTimeout+' milliseconds.'
                    :'The npm registry update request failed.',
                {cause:error}
            );
        await onEvent?.({
            type:'update.check.failed',
            message:normalized.message,
            data:{code:normalized.code,tag,packageName:selectedPackage}
        });
        throw normalized;
    }finally{
        linked.cleanup();
    }
}

const MAX_MODEL_DEFINITION_CHARACTERS=128*1024;
const MAX_SYSTEM_PROMPT_CHARACTERS=96*1024;
const MAX_PARAMETER_COUNT=32;
const MAX_RESPONSE_BYTES=MAX_MODEL_DEFINITION_CHARACTERS*4;
const MODEL_REFERENCE=/^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
const PARAMETER_NAME=/^[a-z][a-z0-9_]{0,63}$/;

function fail(message){
    const error=new TypeError(message);
    error.code='MODEL_DEFINITION_INVALID';
    throw error;
}

function freeze(value){
    if(!value||typeof value!=='object'||Object.isFrozen(value)){
        return value;
    }

    for(const child of Object.values(value)){
        freeze(child);
    }

    return Object.freeze(value);
}

function responseLength(response){
    const raw=response?.headers?.get?.('content-length');

    if(raw===null||raw===undefined||raw===''){
        return null;
    }

    const value=Number(raw);
    return Number.isSafeInteger(value)&&value>=0?value:Number.POSITIVE_INFINITY;
}

async function boundedResponseText(response,maxBytes=MAX_RESPONSE_BYTES){
    const declaredLength=responseLength(response);

    if(declaredLength!==null&&declaredLength>maxBytes){
        fail('The model definition response exceeds the allowed size.');
    }

    const reader=response?.body?.getReader?.();

    if(!reader){
        if(typeof response?.text!=='function'){
            fail('The model definition response is not readable.');
        }

        const text=await response.text();

        if(typeof text!=='string'||new TextEncoder().encode(text).byteLength>maxBytes){
            fail('The model definition response exceeds the allowed size.');
        }

        return text;
    }

    const decoder=new TextDecoder('utf-8',{fatal:true});
    const parts=[];
    let total=0;

    try{
        while(true){
            const {done,value}=await reader.read();

            if(done){
                break;
            }
            if(!(value instanceof Uint8Array)){
                fail('The model definition response contained an invalid byte chunk.');
            }

            total+=value.byteLength;
            if(total>maxBytes){
                await reader.cancel?.();
                fail('The model definition response exceeds the allowed size.');
            }
            parts.push(decoder.decode(value,{stream:true}));
        }
        parts.push(decoder.decode());
    }catch(error){
        if(error?.code==='MODEL_DEFINITION_INVALID'){
            throw error;
        }
        fail('The model definition response is not valid UTF-8 text.');
    }

    return parts.join('');
}

/**
 * Parses the small, deterministic Modelfile subset Arcane applications use as
 * a packaged model definition. Unknown directives and ambiguous SYSTEM blocks
 * are rejected so browser prompts cannot silently drift from the definition.
 */
export function parseModelDefinition(source){
    if(typeof source!=='string'
        ||!source
        ||source.length>MAX_MODEL_DEFINITION_CHARACTERS
        ||source.includes('\0')
    ){
        fail('The model definition must be bounded non-empty text.');
    }

    const normalized=source.replaceAll('\r\n','\n');

    if(normalized.includes('\r')||normalized.startsWith('\uFEFF')){
        fail('The model definition must use canonical UTF-8 line endings.');
    }

    const match=normalized.match(
        /^FROM ([^\n]+)\n\nSYSTEM """\n([\s\S]*?)\n"""(?:\n\n([\s\S]+?))?\n?$/
    );

    if(!match||normalized.match(/^SYSTEM """$/gm)?.length!==1){
        fail('The model definition must contain one unambiguous FROM and SYSTEM block.');
    }

    const from=match[1];
    const system=match[2];
    const parameterLines=match[3]?match[3].split('\n'):[];

    if(!MODEL_REFERENCE.test(from)){
        fail('The model definition contains an invalid base-model reference.');
    }
    if(!system.trim()
        ||system!==system.trim()
        ||system.length>MAX_SYSTEM_PROMPT_CHARACTERS
        ||system.split('\n').some(function systemLineTooLong(line){
            return line.length>4096;
        })
    ){
        fail('The model definition contains an invalid SYSTEM prompt.');
    }
    if(parameterLines.length>MAX_PARAMETER_COUNT){
        fail('The model definition contains an invalid parameter count.');
    }

    const parameters={};

    for(const line of parameterLines){
        const parameter=line.match(/^PARAMETER ([^ ]+) ([^\n]+)$/);

        if(!parameter
            ||!PARAMETER_NAME.test(parameter[1])
            ||parameter[2]!==parameter[2].trim()
            ||parameter[2].length>256
            ||Object.hasOwn(parameters,parameter[1])
        ){
            fail(`The model definition contains an invalid parameter line: ${line}`);
        }

        parameters[parameter[1]]=parameter[2];
    }

    return freeze({from,system,parameters});
}

/**
 * Loads a packaged definition with a read-only same-origin GET and returns the
 * SYSTEM block. The definition is never evaluated and no model service is
 * contacted by this helper.
 */
export async function loadModelDefinitionSystemPrompt(url,{
    fetchImpl=globalThis.fetch
}={}){
    if(typeof fetchImpl!=='function'){
        fail('A browser fetch implementation is required.');
    }

    const response=await fetchImpl(url,{
        method:'GET',
        credentials:'same-origin',
        cache:'default',
        redirect:'error'
    });

    if(!response||response.ok!==true){
        const error=new Error(
            `Unable to load the packaged model definition (${response?.status||'unavailable'}).`
        );
        error.code='MODEL_DEFINITION_UNAVAILABLE';
        throw error;
    }

    return parseModelDefinition(await boundedResponseText(response)).system;
}

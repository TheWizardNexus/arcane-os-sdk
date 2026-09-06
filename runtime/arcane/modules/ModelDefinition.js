import Is from 'strong-type';
const is=new Is(false);

const MODEL_REFERENCE=/^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const PARAMETER_NAME=/^[a-z][a-z0-9_]*$/;

function fail(message){
    const error=new TypeError(message);
    error.code='MODEL_DEFINITION_INVALID';
    throw error;
}

async function completeResponseText(response){
    if(!is.function(response?.text)){
        fail('The model definition response is not readable.');
    }

    const text=await response.text();

    if(!is.string(text)){
        fail('The model definition response is not readable text.');
    }

    return text;
}

/**
 * Parses the small, deterministic Modelfile subset Arcane applications use as
 * a packaged model definition. Unknown directives and ambiguous SYSTEM blocks
 * are rejected so browser prompts cannot silently drift from the definition.
 */
export function parseModelDefinition(source){
    if(!is.string(source)
        ||!source
        ||source.includes('\0')
    ){
        fail('The model definition must be non-empty text without null characters.');
    }

    const normalized=source
        .replace(/^\uFEFF/u,'')
        .replaceAll('\r\n','\n')
        .replaceAll('\r','\n');

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
    if(!system.trim()){
        fail('The model definition contains an invalid SYSTEM prompt.');
    }

    const parameters={};

    for(const line of parameterLines){
        const parameter=line.match(/^PARAMETER ([^ ]+) ([^\n]+)$/);

        if(!parameter
            ||!PARAMETER_NAME.test(parameter[1])
            ||!parameter[2].trim()
            ||Object.hasOwn(parameters,parameter[1])
        ){
            fail(`The model definition contains an invalid parameter line: ${line}`);
        }

        parameters[parameter[1]]=parameter[2];
    }

    return {from,system,parameters};
}

/**
 * Loads a packaged definition with an ordinary read-only GET and returns the
 * complete SYSTEM block. The definition is never evaluated and no model
 * service is contacted by this helper.
 */
export async function loadModelDefinitionSystemPrompt(url,{
    fetchImpl=globalThis.fetch
}={}){
    if(!is.function(fetchImpl)){
        fail('A browser fetch implementation is required.');
    }

    const response=await fetchImpl(url,{
        method:'GET'
    });

    if(!response||response.ok!==true){
        const error=new Error(
            `Unable to load the packaged model definition (${response?.status||'unavailable'}).`
        );
        error.code='MODEL_DEFINITION_UNAVAILABLE';
        throw error;
    }

    return parseModelDefinition(await completeResponseText(response)).system;
}

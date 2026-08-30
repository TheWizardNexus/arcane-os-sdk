function isRecord(value){
    return Boolean(value)
        &&typeof value==='object'
        &&!Array.isArray(value);
}

function coded(error,code){
    error.code=code;
    return error;
}

function optionalText(value,label){
    if(value===undefined||value===null) return value;
    if(typeof value!=='string') throw new TypeError(`${label} must be a string when provided.`);
    return value;
}

function normalizeDirectoryPickerOptions(input={}){
    if(!isRecord(input)) throw new TypeError('Directory picker options must be an object.');
    const normalized={...input};
    if(Object.prototype.hasOwnProperty.call(input,'title')){
        normalized.title=optionalText(input.title,'title');
    }
    if(Object.prototype.hasOwnProperty.call(input,'initialPath')){
        normalized.initialPath=optionalText(input.initialPath,'initialPath');
    }
    return normalized;
}

function normalizeDirectorySelection(input){
    if(
        !isRecord(input)
        ||typeof input.cancelled!=='boolean'
    ){
        throw coded(
            new TypeError('The directory picker provider returned an invalid result.'),
            'DIRECTORY_PICKER_INVALID_RESULT',
        );
    }
    if(input.cancelled){
        return {
            ...input,
            cancelled:true,
            path:input.path===undefined?null:input.path,
        };
    }
    let path;
    try{
        path=optionalText(input.path,'The selected directory path');
    }catch(error){
        throw coded(error,'DIRECTORY_PICKER_INVALID_RESULT');
    }
    if(!path){
        throw coded(
            new TypeError('The directory picker provider did not return a selected path.'),
            'DIRECTORY_PICKER_INVALID_RESULT',
        );
    }
    return {...input,cancelled:false,path};
}

/**
 * Opens a provider-owned operating-system directory selector.
 *
 * This wrapper does not enumerate directories, persist a selected path, or use
 * a browser file picker. The injected provider must expose
 * `selectDirectory(options)` and return a record with `cancelled` and `path`.
 * Caller options and additional provider result fields pass through unchanged.
 */
export default class DirectoryPicker{
    constructor(provider=globalThis.Arcane?.filesystem){
        this.provider=provider||null;
    }

    get available(){
        return typeof this.provider?.selectDirectory==='function';
    }

    async select(options={}){
        if(!this.available){
            throw coded(
                new Error('The Arcane directory selector is unavailable. Open this application through an installed Arcane OS build.'),
                'DIRECTORY_PICKER_UNAVAILABLE',
            );
        }
        const normalized=normalizeDirectoryPickerOptions(options);
        return normalizeDirectorySelection(
            await this.provider.selectDirectory({...normalized}),
        );
    }
}

export {normalizeDirectoryPickerOptions,normalizeDirectorySelection};

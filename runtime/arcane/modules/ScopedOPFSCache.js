import {
    canonicalApplicationId,
    openApplicationDataDirectory
} from './AppDataScope.js';

function safeSegment(value,label){
    if(typeof value!=='string'){
        throw new TypeError(`${label} must be a string.`);
    }
    const normalized=value.trim();
    if(!normalized){
        throw new RangeError(`${label} must not be empty.`);
    }
    if(normalized==='.'||normalized==='..'||/[\\/\0]/u.test(normalized)){
        throw new TypeError(`${label} must be one filename-safe segment.`);
    }
    return normalized;
}

function unavailable(){
    const error=new Error('Origin Private File System storage is unavailable in this browser.');
    error.code='OPFS_UNAVAILABLE';
    return error;
}

/**
 * A deliberately narrow JSON cache over one application-owned OPFS directory.
 *
 * It exposes only exact-key get, set, and delete operations. It never enumerates,
 * exports, restores, clears, or selects another namespace, so one consumer cannot
 * accidentally mutate unrelated origin storage.
 */
export default class ScopedOPFSCache{
    #applicationId;
    #arcane;
    #directoryPromise=null;
    #documentObject;
    #namespace;
    #storage;

    constructor({
        applicationId=null,
        namespace,
        storage=globalThis.navigator?.storage,
        documentObject=globalThis.document,
        arcane=globalThis.Arcane
    }={}){
        this.#applicationId=applicationId==null||applicationId===''
            ?null
            :canonicalApplicationId(applicationId);
        this.#namespace=safeSegment(namespace,'namespace');
        if(!storage||typeof storage.getDirectory!=='function'){
            throw unavailable();
        }
        this.#storage=storage;
        this.#documentObject=documentObject;
        this.#arcane=arcane;
    }

    static supported(storage=globalThis.navigator?.storage){
        return Boolean(storage&&typeof storage.getDirectory==='function');
    }

    get namespace(){
        return this.#namespace;
    }

    get applicationId(){
        return this.#applicationId;
    }

    async #directory(){
        if(!this.#directoryPromise){
            this.#directoryPromise=(async()=>{
                const scope=await openApplicationDataDirectory({
                    storage:this.#storage,
                    applicationId:this.#applicationId,
                    documentObject:this.#documentObject,
                    arcane:this.#arcane,
                    create:true
                });
                this.#applicationId=scope.applicationId;
                return scope.directory.getDirectoryHandle(
                    this.#namespace,
                    {create:true}
                );
            })().catch(error=>{
                this.#directoryPromise=null;
                throw error;
            });
        }
        return this.#directoryPromise;
    }

    async get(key){
        const normalized=safeSegment(key,'key');
        try{
            const directory=await this.#directory();
            const handle=await directory.getFileHandle(normalized);
            const file=await handle.getFile();
            const source=await file.text();
            try{
                return JSON.parse(source);
            }catch{
                await this.delete(normalized).catch(()=>{});
                return undefined;
            }
        }catch(error){
            if(error?.name==='NotFoundError'||error?.code==='ENOENT'){
                return undefined;
            }
            throw error;
        }
    }

    async set(key,value){
        const normalized=safeSegment(key,'key');
        const source=JSON.stringify(value);
        if(source===undefined){
            throw new TypeError('Cache values must be JSON serializable.');
        }
        const directory=await this.#directory();
        const handle=await directory.getFileHandle(normalized,{create:true});
        const writable=await handle.createWritable();
        try{
            await writable.write(source);
            await writable.close();
        }catch(error){
            await writable.abort?.().catch(()=>{});
            throw error;
        }
        return value;
    }

    async delete(key){
        const normalized=safeSegment(key,'key');
        const directory=await this.#directory();
        try{
            await directory.removeEntry(normalized);
            return true;
        }catch(error){
            if(error?.name==='NotFoundError'||error?.code==='ENOENT'){
                return false;
            }
            throw error;
        }
    }
}

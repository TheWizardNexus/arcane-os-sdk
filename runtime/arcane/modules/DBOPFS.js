import { arcaneLogging } from 'arcane-os/logging';
import Is from 'strong-type';
import {openApplicationDataDirectory} from './AppDataScope.js';
import {
    createArcaneEventSource,
    projectArcaneDOMEvent
} from 'arcane-os/event-manager';
const is=new Is(false);

const dbopfsEventTypes={
    ready:'dbopfs-ready',
    change:'dbopfs-change'
};
const dbopfsReasons={
    ready:'opfs-database-ready'
};
export const DBOPFS_EVENT_TYPES={...dbopfsEventTypes};
export const DBOPFS_REASONS={...dbopfsReasons};

const TABLE_DIRECTORY_ALIASES={
    memories:'memory'
};
const DIRECTORY_TABLE_ALIASES={
    memory:'memories'
};

function directoryNameForTable(tableName=''){
    return TABLE_DIRECTORY_ALIASES[tableName]||tableName;
}

function tableNameForDirectory(directoryName=''){
    return DIRECTORY_TABLE_ALIASES[directoryName]||directoryName;
}

function parseFileValue(fileName='',textContent=''){
    let value=textContent;
    const extension=fileName.slice(fileName.lastIndexOf('.')+1).toLowerCase();

    switch(extension){
        case 'json':
            try{
                value=JSON.parse(textContent.trim());
            }catch{}
            break;
        case 'jsonl':
        case 'ndjson':
            value=[];
            for(const row of textContent.split('\n')){
                if(!row.trim())continue;
                try{
                    value.push(JSON.parse(row.trim()));
                }catch{
                    value.push(row);
                }
            }
            break;
    }

    return value;
}

if(navigator.storage?.persist){
    await navigator.storage.persist().catch(()=>false);
}

/**
 * @typedef {Object<string,any>} DBOPFSTableCache
 * Represents cached values of a table in memory.
 * Key = filename
 * Value = parsed file content
 */

/**
 * @typedef {Object<string,DBOPFSTableCache>} DBOPFSTables
 * Represents the in-memory cache of all tables.
 */

/**
 * @typedef {Object<string,FileSystemDirectoryHandle>} DBOPFSTableHandles
 * Handles to directories inside OPFS.
 */

/**
 * @typedef {Object<string,Promise<FileSystemDirectoryHandle>>} DBOPFSTableHandlePromises
 * Pending table handle requests keyed by logical table name.
 */

/**
 * @typedef {Object<string,Promise>} DBOPFSWriteLocks
 * Promise based write locks to serialize writes to the same file.
 */

/**
 * @typedef {Object} DBOPFSTableUpdate
 * @property {string} tableName
 * @property {string} fileName
 * @property {*} value
 */


/**
 * DBOPFS
 *
 * A lightweight database abstraction on top of the
 * **Origin Private File System (OPFS)**.
 *
 * Tables are directories and records are files.
 *
 * This module automatically attaches a singleton to:
 *
 *     window.dbopfs
 *
 * Example:
 *
 *     await dbopfs.set('users','alex',{email:'alex@example.com'})
 *     const user=await dbopfs.get('users','alex')
 */
class DBOPFS {

    #events;
    #changeChannel=null;
    #changeOriginId=globalThis.crypto?.randomUUID?.()
        ||`dbopfs-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    #changeSequence=0;
    #changeWindow=window;
    #changesSuspended=false;
    #cacheStates=new Map();

    /** @type {FileSystemDirectoryHandle|Object} */
    #db={}

    /** @type {DBOPFSTableHandles} */
    #tableHandles={}

    /** @type {DBOPFSTableHandlePromises} */
    #tableHandlePromises={}

    /** @type {DBOPFSTables} */
    #tables={}

    /** @type {DBOPFSWriteLocks} */
    #writeLocks={}

    /** @type {ServiceWorker|Object} */
    #serviceWorker={}

    /** @type {Worker|Object} */
    #writeWorker={}

    /** @type {string} */
    #applicationId=''

    /** @type {string} */
    #storagePath=''

    /**
     * Handles messages received from the service worker.
     * Placeholder for future synchronization logic.
     * @private
     */
    #handleServiceWorkerMessage(){};

    /**
     * Writes file data through a dedicated OPFS worker.
     * Used when FileSystemFileHandle.createWritable is unavailable.
     *
     * @private
     * @param {string} directoryName
     * @param {string} fileName
     * @param {*} fileData
     * @param {boolean} append
     * @returns {Promise<boolean>}
    */
    async #writeFileWithWorker(directoryName='',fileName='',fileData='',append=false){
        const fileDataBuffer=await new Blob([fileData]).arrayBuffer();

        await this.#requestFileWorker(
            {
                operation:'write',
                applicationId:this.#applicationId,
                directoryName,
                fileName,
                fileData:fileDataBuffer,
                append
            },
            [fileDataBuffer]
        )

        return true
    }

    /**
     * Reads file data through a dedicated OPFS worker.
     * Used when FileSystemFileHandle.getFile is unavailable.
     *
     * @private
     * @param {string} directoryName
     * @param {string} fileName
     * @returns {Promise<File>}
     */
    async #readFileWithWorker(directoryName='',fileName=''){
        const response=await this.#requestFileWorker(
            {
                operation:'read',
                applicationId:this.#applicationId,
                directoryName,
                fileName
            }
        )

        return new File(
            [response.fileData],
            fileName
        )
    }

    /**
     * Sends a file operation to the shared OPFS worker.
     *
     * @private
     * @param {Object} data
     * @param {Transferable[]} transfer
     * @returns {Promise<Object>}
     */
    async #requestFileWorker(data={},transfer=[]){

        if(!is.function(this.#writeWorker?.postMessage)){
            this.#writeWorker=new Worker(
                new URL('./DBOPFSWorker.js',import.meta.url)
            );
        }

        const channel=new MessageChannel();
        const worker=this.#writeWorker;
        const db=this;

        return new Promise(
            function fileWorkerPromise(resolve,reject){
                function cleanup(){
                    channel.port1.onmessage=null;
                    channel.port1.close();
                    worker.removeEventListener('error',workerErrorHandler);
                }

                function workerErrorHandler(event){
                    cleanup();
                    worker.terminate();

                    if(db.#writeWorker===worker){
                        db.#writeWorker={};
                    }

                    reject(event.error||new Error(event.message||'OPFS worker failed'));
                }

                channel.port1.onmessage=function fileWorkerMessage(event){
                    cleanup();

                    if(event.data?.error){
                        const error=new Error(event.data.error.message);
                        error.name=event.data.error.name;
                        reject(error);
                        return;
                    }

                    resolve(event.data);
                };

                channel.port1.start();
                worker.addEventListener('error',workerErrorHandler);

                try{
                    worker.postMessage(
                        data,
                        transfer.concat(channel.port2)
                    );
                }catch(error){
                    cleanup();
                    channel.port2.close();
                    reject(error);
                }
            }
        );
    }

    /**
     * Generates a unique key for a file lock.
     * @private
     * @param {string} tableName
     * @param {string} fileName
     * @returns {string}
     */
    #getLockKey(tableName,fileName){
        return `${tableName}:${fileName}`
    }

    #fileCacheState(tableName,fileName){
        const directoryName=directoryNameForTable(tableName);
        let table=this.#cacheStates.get(directoryName);
        if(!table){
            table=new Map();
            this.#cacheStates.set(directoryName,table);
        }
        let state=table.get(fileName);
        if(!state){
            state={revision:0};
            table.set(fileName,state);
        }
        return state;
    }

    #forgetFile(tableName,fileName,retire=false){
        const directoryName=directoryNameForTable(tableName);
        const registeredTableName=tableNameForDirectory(directoryName);
        const states=this.#cacheStates.get(directoryName);
        const state=states?.get(fileName);
        if(state)state.revision+=1;
        if(retire&&states){
            states.delete(fileName);
            if(states.size===0)this.#cacheStates.delete(directoryName);
        }
        for(const name of new Set([tableName,directoryName,registeredTableName])){
            if(this.#tables[name])delete this.#tables[name][fileName];
        }
    }

    #openChangeChannel(){
        if(this.#changesSuspended||this.#changeChannel||!this.#applicationId)return;
        const Channel=this.#changeWindow.BroadcastChannel;
        if(!is.function(Channel))return;
        try{
            const channel=new Channel(`arcane.dbopfs.changes:${this.#storagePath}`);
            const database=this;
            channel.onmessage=function receiveCommittedChange(event){
                const change=event.data;
                if(!change||change.applicationId!==database.#applicationId
                    ||change.storagePath!==database.#storagePath
                    ||change.originId===database.#changeOriginId)return;
                if(!['write','append','delete','table-delete'].includes(change.action)
                    ||typeof change.tableName!=='string'
                    ||typeof change.directoryName!=='string'
                    ||typeof change.changeId!=='string'
                    ||(change.action!=='table-delete'&&typeof change.fileName!=='string'))return;
                database.#receiveChange(change);
            };
            channel.onmessageerror=function reportChangeMessageError(event){
                arcaneLogging.error('DBOPFS could not receive a committed-change notification.',event);
            };
            this.#changeChannel=channel;
        }catch(error){
            arcaneLogging.error('DBOPFS cross-document notifications are unavailable; local storage remains available.',error);
        }
    }

    #closeChangeChannel(){
        if(!this.#changeChannel)return;
        this.#changeChannel.onmessage=null;
        this.#changeChannel.onmessageerror=null;
        this.#changeChannel.close();
        this.#changeChannel=null;
    }

    #receiveChange(change){
        if(change.action==='table-delete'){
            this.#forgetTable(change.tableName,change.directoryName,tableNameForDirectory(change.directoryName));
        }else{
            this.#forgetFile(change.tableName,change.fileName,change.action==='delete');
        }
        this.#events.dispatch(dbopfsEventTypes.change,{...change,remote:true},{operationId:change.changeId});
    }

    #commitChange(tableName,fileName,action){
        const directoryName=directoryNameForTable(tableName);
        const registeredTableName=tableNameForDirectory(directoryName);
        if(action==='table-delete'){
            this.#forgetTable(tableName,directoryName,registeredTableName);
        }else{
            this.#forgetFile(tableName,fileName,action==='delete');
        }
        this.#changeSequence+=1;
        const change={
            applicationId:this.#applicationId,
            storagePath:this.#storagePath,
            tableName:registeredTableName,
            directoryName,
            fileName,
            action,
            originId:this.#changeOriginId,
            sequence:this.#changeSequence,
            changeId:`${this.#changeOriginId}:${this.#changeSequence}`
        };
        // Notify the remote transport before synchronous local observers can
        // start another mutation. Transport failure cannot undo a saved record.
        if(this.#changeChannel){
            try{
                this.#changeChannel.postMessage(change);
            }catch(error){
                arcaneLogging.error('DBOPFS saved a change whose cross-document notification failed.',error);
            }
        }
        this.#events.dispatch(dbopfsEventTypes.change,{...change,remote:false},{operationId:change.changeId});
    }

    /**
     * Invalidates every known cache key for one logical/physical table pair.
     * @private
     * @param {string} tableName
     * @param {string} directoryName
     * @param {string} registeredTableName
     */
    #forgetTable(tableName,directoryName,registeredTableName){
        this.#cacheStates.delete(directoryName);
        for(const name of new Set([
            tableName,
            directoryName,
            registeredTableName
        ])){
            delete this.#tables[name]
            delete this.#tableHandles[name]
            delete this.#tableHandlePromises[name]
        }
    }

    /** @type {boolean} */
    ready=false;

    /** @type {Promise<void>} */
    readyPromise=Promise.resolve();

    constructor(options={}){
        if(window.dbopfs){
            return window.dbopfs;
        }

        this.#events=createArcaneEventSource(this,{
            source:'dbopfs',
            eventTypes:Object.values(dbopfsEventTypes)
        });
        const database=this;
        this.#changeWindow.addEventListener('pagehide',function suspendDBOPFSChanges(){
            database.#changesSuspended=true;
            database.#closeChangeChannel();
        });
        this.#changeWindow.addEventListener('pageshow',function resumeDBOPFSChanges(){
            if(!database.#changesSuspended)return;
            database.#changesSuspended=false;
            // Notifications have no history. Discard only this page's cached
            // views after suspension; storage and committed events are unchanged.
            database.#tables={};
            database.#tableHandles={};
            database.#tableHandlePromises={};
            database.#cacheStates.clear();
            database.#openChangeChannel();
        });
        this.readyPromise=this.#init(options);
    }

    /**
     * Initializes the application OPFS database scope.
     * Dispatches `dbopfs-ready` event when complete.
     *
     * @returns {Promise<void>}
     */
    async #init(options={}){
        const scope=await openApplicationDataDirectory({
            storage:options.storage||navigator.storage,
            applicationId:options.applicationId||null,
            documentObject:options.documentObject||globalThis.document,
            arcane:options.arcane||globalThis.Arcane,
            create:true
        });
        this.#applicationId=scope.applicationId;
        this.#storagePath=scope.path;
        this.#db=scope.directory;
        this.#openChangeChannel();

        this.ready=true;

        const {occurrence}=this.#events.dispatch(
            dbopfsEventTypes.ready,
            {
                dbopfs:this,
                applicationId:this.#applicationId,
                storagePath:this.#storagePath,
                reason:dbopfsReasons.ready
            },
            {
                operationId:`dbopfs-ready-${this.#events.instanceId}`,
                publicDetail:{
                    applicationId:this.#applicationId,
                    ready:true,
                    reason:dbopfsReasons.ready,
                    storagePath:this.#storagePath
                }
            }
        );
        projectArcaneDOMEvent(window,occurrence);
    }

    /**
     * Canonical application identity owning this database.
     *
     * @returns {string}
     */
    get applicationId(){
        return this.#applicationId;
    }

    /**
     * Application-relative OPFS directory used by this database.
     *
     * @returns {string}
     */
    get storagePath(){
        return this.#storagePath;
    }

    /**
     * Observes committed record/table changes through the canonical event owner.
     * Subscription is live-only; it does not replay records or load a table.
     * @param {function} listener Receives an event whose detail is change metadata.
     * @param {{signal?:AbortSignal,once?:boolean}} options
     * @returns {function} Idempotent unsubscribe with a matching dispose method.
     */
    subscribeChanges(listener,options={}){
        return this.#events.subscribe(dbopfsEventTypes.change,listener,options);
    }

    /**
     * Returns in-memory table cache.
     *
     * @returns {DBOPFSTables}
     */
    get tables(){
        return this.#tables
    }

    /**
     * Convenience setter to write to tables.
     *
     * Example:
     *
     *     dbopfs.tables={
     *         tableName:'users',
     *         fileName:'alex',
     *         value:{email:'alex@example.com'}
     *     }
     *
     * @param {DBOPFSTableUpdate} update
     */
    set tables(update={tableName:'',fileName:'',value:''}){
        this.set(update.tableName,update.fileName,update.value)
    }

    /**
     * Gets the directory handle for a table.
     * Creates the table if it does not exist.
     *
     * @param {string} tableName
     * @returns {Promise<FileSystemDirectoryHandle>}
     */
    async getTableHandle(tableName=''){
        if(!this.ready){
            await this.readyPromise;
        }

        const directoryName=directoryNameForTable(tableName);
        const registeredTableName=tableNameForDirectory(directoryName);

        if(this.#tableHandles[registeredTableName]){
            return this.#tableHandles[registeredTableName];
        }

        const existingHandle=Object.values(this.#tableHandles).find(
            function matchingTableDirectory(handle){
                return handle.name===directoryName;
            }
        );

        if(existingHandle){
            this.#tableHandles[registeredTableName]=existingHandle;
            return existingHandle;
        }

        if(!this.#tableHandlePromises[registeredTableName]){
            const handlePromise=this.#db.getDirectoryHandle(
                directoryName,
                {create:true}
            ).then(
                function registerRequestedTable(handle){
                    if(this.#tableHandlePromises[registeredTableName]===handlePromise){
                        this.#tableHandles[registeredTableName]=handle;
                    }
                    return handle;
                }.bind(this)
            );
            this.#tableHandlePromises[registeredTableName]=handlePromise;

            function clearTableHandlePromise(){
                if(this.#tableHandlePromises[registeredTableName]===handlePromise){
                    delete this.#tableHandlePromises[registeredTableName];
                }
            }

            handlePromise.then(
                clearTableHandlePromise.bind(this),
                clearTableHandlePromise.bind(this)
            );
        }

        return this.#tableHandlePromises[registeredTableName];
    }

    /**
     * Writes a value to OPFS.
     *
     * @param {string} tableName
     * @param {string} fileName
     * @param {*} value
     * @returns {Promise<*>}
     */
    async set(tableName='',fileName='',value={}, append=false){
        const lockKey=this.#getLockKey(tableName,fileName)

        const previousWrite=this.#writeLocks[lockKey]||Promise.resolve()
        const currentWrite=previousWrite.catch(()=>{}).then(
            async function setWriteLocked(){
                if(!this.#tables[tableName]){
                    this.#tables[tableName]={}
                }

                let dataToWrite=value

                if(!is.string(value)){
                    dataToWrite=JSON.stringify(dataToWrite)
                }

                const cacheState=this.#fileCacheState(tableName,fileName);
                const cacheRevision=cacheState.revision;
                const result=append?true:parseFileValue(fileName,String(dataToWrite));

                try{
                    await this.writeFile(
                        tableName,
                        fileName,
                        dataToWrite,
                        append
                    );

                    if(!append&&this.#fileCacheState(tableName,fileName)===cacheState
                        &&cacheState.revision<=cacheRevision+1){
                        if(!this.#tables[tableName])this.#tables[tableName]={};
                        this.#tables[tableName][fileName]=result;
                    }
                    if(append&&cacheState.revision===cacheRevision){
                        this.#forgetFile(tableName,fileName);
                    }
                }catch(error){
                    arcaneLogging.error(`Error writing file '${fileName}' to table '${tableName}':`,error)
                    throw error
                }

                return result
            }.bind(this)
        )

        this.#writeLocks[lockKey]=currentWrite

        function clearWriteLock(){
            if(this.#writeLocks[lockKey]===currentWrite){
                delete this.#writeLocks[lockKey]
            }
        }

        currentWrite.then(
            clearWriteLock.bind(this),
            clearWriteLock.bind(this)
        )

        return currentWrite
    }

    /**
     * Writes raw file data to OPFS.
     *
     * @param {string} tableName
     * @param {string} fileName
     * @param {*} fileData
     * @param {boolean} append
     * @returns {Promise<boolean>}
     */
    async writeFile(tableName='',fileName='',fileData='',append=false){
        const table=await this.getTableHandle(tableName)
        const handle=await table.getFileHandle(
            fileName,
            {create:true}
        );

        if(!is.function(handle.createWritable)){
            await this.#writeFileWithWorker(
                table.name,
                fileName,
                fileData,
                append
            );
            this.#commitChange(tableName,fileName,append?'append':'write');
            return true;
        }

        const writable=await handle.createWritable(
            {keepExistingData:append}
        );

        if(append){
            const file=await handle.getFile();
            await writable.seek(file.size);
        }

        const blob = new Blob(
            [
                fileData
            ]
        );

        await writable.write(blob);
        await writable.close();
        this.#commitChange(tableName,fileName,append?'append':'write');

        return true
    }

    /**
     * Reads a raw file from OPFS.
     * Falls back to a synchronous access handle in a worker on browsers
     * without FileSystemFileHandle.getFile.
     *
     * @param {string} tableName
     * @param {string} fileName
     * @returns {Promise<File>}
     */
    async readFile(tableName='',fileName=''){
        const table=await this.getTableHandle(tableName)
        const handle=await table.getFileHandle(fileName,{create:false})

        if(is.function(handle.getFile)){
            return handle.getFile()
        }

        return this.#readFileWithWorker(
            table.name,
            fileName
        )
    }

    /**
     * Returns metadata exposed by the browser File API.
     * Creation time is not available through the OPFS file handle.
     *
     * @param {string} tableName
     * @param {string} fileName
     * @returns {Promise<Object>}
     */
    async getFileMetadata(tableName='',fileName=''){
        const table=await this.getTableHandle(tableName)
        const handle=await table.getFileHandle(fileName,{create:false})

        if(!is.function(handle.getFile)){
            return {
                lastModified:null,
                size:null,
                type:''
            }
        }

        const file=await handle.getFile()

        return {
            lastModified:file.lastModified||null,
            size:file.size,
            type:file.type||''
        }
    }

    /**
     * Writes multiple files into a table.
     *
     * @param {string} tableName
     * @param {Object<string,*>} items
     * @returns {Promise<PromiseSettledResult[]>}
     */
    async setMany(tableName,items){
        const entries=Object.entries(items)

        const setPromises=entries.map(
            function setManyPromises([fileName,value]){
                return this.set(tableName,fileName,value)
            }.bind(this)
        );

        const results=await Promise.allSettled(setPromises);

        results.forEach(
            function setManyResultsItterator(result,index){
                const fileName=entries[index][0]

                if(result.status!=='fulfilled'){
                    arcaneLogging.error(`Failed to set file '${fileName}':`,result.reason)
                }
            }
        );

        return results
    }

    /**
     * Reads a file from OPFS.
     *
     * @param {string} tableName
     * @param {string} fileName
     * @param {boolean} force
     * @returns {Promise<*>}
     */
    async get(tableName='',fileName='',force=false){
        if(force||!this.#tables[tableName]?.[fileName]){
            const cacheState=this.#fileCacheState(tableName,fileName);
            const cacheRevision=cacheState.revision;
            try{
                const file=await this.readFile(tableName,fileName)
                const textContent=await file.text()

                if(!this.#tables[tableName]){
                    this.#tables[tableName]={}
                }

                const value=parseFileValue(fileName,textContent);
                if(this.#fileCacheState(tableName,fileName)===cacheState
                    &&cacheState.revision===cacheRevision){
                    this.#tables[tableName][fileName]=value;
                }
                return value;
            }catch(error){
                if(error.name==='NotFoundError'){
                    this.#forgetFile(tableName,fileName,true);
                    return null
                }

                throw error
            }
        }

        return this.#tables[tableName][fileName];
    }

    /**
     * Reads multiple files.
     *
     * @param {string} tableName
     * @param {string[]} items
     * @returns {Promise<PromiseSettledResult[]>}
     */
    async getMany(tableName,items){
        const getPromises=items.map(
            function getManyPromises(fileName){
                return this.get(tableName,fileName)
            }.bind(this)
        )

        return Promise.allSettled(getPromises);
    }

    /**
     * Reads all files from a table or the entire DB.
     *
     * @param {string} tableName
     * @param {boolean} force
     * Force each record to be read from OPFS instead of the in-memory cache.
     * @returns {Promise<Object>}
     */
    async getAll(tableName='',force=false){
        if(!is.boolean(force)){
            throw new TypeError('DBOPFS.getAll force must be boolean');
        }
        const items={}

        if(tableName){
            const table=await this.getTableHandle(tableName)

            const readPromises=[]

            for await(const [name]of table.entries()){
                readPromises.push(
                    this.get(tableName,name,force).then(
                        function assignValue(value){
                            items[name]=value
                        }
                    )
                )
            }

            await Promise.all(readPromises)

            return items
        }

        await this.getTableNames(true)

        const tableNames=Object.keys(this.#tableHandles)

        const tablePromises=tableNames.map(
            async function loadTable(tableName){
                const table=await this.getTableHandle(tableName);
                const tableItems={};

                const readPromises=[];

                for await(const [name]of table.entries()){
                    readPromises.push(
                        this.get(tableName,name,force).then(
                            function assignValue(value){
                                tableItems[name]=value;
                            }
                        )
                    );
                }

                await Promise.all(readPromises);

                items[tableName]=tableItems;
            }.bind(this)
        )

        await Promise.all(tablePromises)

        return items
    }

    /**
     * Deletes a file.
     *
     * @param {string} tableName
     * @param {string} fileName
     * @returns {Promise<boolean>}
     */
    async delete(tableName='',fileName=''){
        const table=await this.getTableHandle(tableName)

        try{
            await table.removeEntry(fileName)
            this.#commitChange(tableName,fileName,'delete');
        }catch(error){
            if(error.name!=='NotFoundError'){
                arcaneLogging.error(error)
                throw error
            }
            this.#forgetFile(tableName,fileName,true);
        }

        return true
    }

    /**
     * Deletes multiple files.
     *
     * @param {string} tableName
     * @param {string[]} fileNames
     * @returns {Promise<PromiseSettledResult[]>}
     */
    async deleteMany(tableName,fileNames){
        const deletionPromises=fileNames.map(
            function deleteManyPromises(fileName){
                return this.delete(tableName,fileName)
            }.bind(this)
        );

        return Promise.allSettled(deletionPromises);
    }

    /**
     * Deletes a full table.
     *
     * @param {string} tableName
     * @returns {Promise<boolean>}
     */
    async deleteTable(tableName){
        const directoryName=directoryNameForTable(tableName);
        const registeredTableName=tableNameForDirectory(directoryName);

        try{
            await this.#db.removeEntry(directoryName,{recursive:true})
            this.#commitChange(tableName,null,'table-delete');
        }catch(error){
            if(error.name==='NotFoundError')this.#forgetTable(tableName,directoryName,registeredTableName);
            arcaneLogging.error(error)
        }

        return true
    }

    /**
     * Removes one existing table only when its physical directory is empty.
     * The target is resolved as an existing directory without creating or
     * scanning it. Native non-recursive OPFS removal owns the emptiness
     * decision, so this method never clears or recursively removes a table.
     *
     * @param {string} tableName
     * @returns {Promise<{
     *   status:'removed'|'absent'|'not-empty',
     *   removed:boolean,
     *   tableName:string,
     *   directoryName:string
     * }>}
     */
    async removeEmptyTable(tableName){
        if(!this.ready){
            await this.readyPromise;
        }

        const directoryName=directoryNameForTable(tableName);
        const registeredTableName=tableNameForDirectory(directoryName);

        try{
            await this.#db.getDirectoryHandle(directoryName,{create:false})
            await this.#db.removeEntry(directoryName)
        }catch(error){
            if(error.name==='InvalidModificationError'){
                return {
                    status:'not-empty',
                    removed:false,
                    tableName:registeredTableName,
                    directoryName
                }
            }

            if(error.name!=='NotFoundError'){
                arcaneLogging.error(error)
                throw error
            }

            this.#forgetTable(tableName,directoryName,registeredTableName)

            return {
                status:'absent',
                removed:false,
                tableName:registeredTableName,
                directoryName
            }
        }

        this.#commitChange(tableName,null,'table-delete');

        return {
            status:'removed',
            removed:true,
            tableName:registeredTableName,
            directoryName
        }
    }

    /**
     * Clears only the current application's OPFS database.
     *
     * @returns {Promise<DBOPFS>}
     */
    async clearAllStorage(){
        if(!this.ready){
            await this.readyPromise;
        }

        for await(const [name]of this.#db.entries()){
            await this.#db.removeEntry(name,{recursive:true})
            this.#commitChange(name,null,'table-delete');
        }

        this.#tables={}
        this.#tableHandles={}
        this.#tableHandlePromises={}
        this.#cacheStates.clear();
        this.#writeLocks={}

        return this
    }

    /**
     * Clears a table.
     *
     * @param {string} tableName
     * @returns {Promise<void>}
     */
    async clear(tableName){
        const table=await this.getTableHandle(tableName)

        for await(const [name]of table.entries()){
            await this.delete(tableName,name)
        }
    }

    /**
     * Returns all keys in a table.
     *
     * @param {string} tableName
     * @returns {Promise<string[]>}
     */
    async getAllKeys(tableName){
        const keys=[]
        const table=await this.getTableHandle(tableName)

        for await(const [name]of table.entries()){
            keys.push(name)
        }

        return keys
    }

    /**
     * Returns registered table names, or discovers physical OPFS directories.
     * Discovered directories are registered so later reads and exports include
     * data created outside the current page load.
     *
     * @param {boolean} discover
     * @returns {Promise<string[]>}
     */
    async getTableNames(discover=false){
        if(!discover){
            return Object.keys(this.#tableHandles)
        }

        const tableNames=[]

        for await(const [name,handle]of this.#db.entries()){
            if(handle.kind!=='directory'){
                continue
            }

            const registeredTableName=tableNameForDirectory(name);
            const registered=Object.values(this.#tableHandles).some(
                function matchingDiscoveredDirectory(tableHandle){
                    return tableHandle.name===name;
                }
            );

            if(!registered){
                this.#tableHandles[registeredTableName]=handle
            }

            tableNames.push(name)
        }

        return tableNames
    }

    /**
     * Filters files by key substring.
     *
     * @param {string} tableName
     * @param {string} subString
     * @returns {Promise<Object>}
     */
    async filterKeyIncludes(tableName,subString=''){
        const items={}
        const table=await this.getTableHandle(tableName)

        for await(const [name]of table.entries()){
            if(name.includes(subString)){
                items[name]=await this.get(tableName,name)
            }
        }

        return items
    }

    /**
     * Checks if a key exists.
     *
     * @param {string} tableName
     * @param {string} key
     * @returns {Promise<boolean>}
     */
    async hasKey(tableName,key){
        try{
            const table=await this.getTableHandle(tableName)
            await table.getFileHandle(key)
            return true
        }catch(err){
            return false
        }
    }

    /**
     * Counts items in a table.
     *
     * @param {string} tableName
     * @returns {Promise<number>}
     */
    async count(tableName){
        let count=0
        const table=await this.getTableHandle(tableName)

        for await(const _ of table.entries()){
            count++
        }

        return count
    }

    /**
     * Creates a PNG backup without downloading or writing database records.
     * JSON is deflated and framed with the existing little-endian payload
     * length, then encoded in RGB channels with opaque alpha for restoration.
     *
     * @param {Object} options
     * @param {string[]} [options.tableNames] Saved tables; omitted selects all.
     * @param {Object<string,Object<string,*>>} [options.additionalTables]
     * Caller-owned tables. Each replaces the matching saved table in this
     * export only. Values must be JSON-serializable; no storage write occurs.
     * @param {AbortSignal} [options.signal]
     * Stops further preparation and prevents a subsequent download. Browser
     * file reads and canvas encoding already in progress cannot be interrupted.
     * @returns {Promise<Blob>} An image/png Blob in the existing backup format.
     */
    async createCompressedPNG({tableNames, additionalTables = {}, signal} = {}) {
        signal?.throwIfAborted();
        if (!('CompressionStream' in window)) {
            throw new Error('CompressionStream not supported.');
        }

        await this.readyPromise;
        signal?.throwIfAborted();
        await this.getTableNames(true);
        signal?.throwIfAborted();

        function logicalTableName(name) {
            return tableNameForDirectory(directoryNameForTable(name));
        }

        const selectedNames = new Set(
            (tableNames === undefined ? Object.keys(this.#tableHandles) : tableNames)
                .map(logicalTableName)
        );
        const suppliedTables = new Map();
        for (const [name, records] of Object.entries(additionalTables)) {
            const tableName = logicalTableName(name);
            selectedNames.add(tableName);
            suppliedTables.set(tableName, records);
        }

        const database = this;
        const encoder = new TextEncoder();

        async function* tableRecords(tableName) {
            if (suppliedTables.has(tableName)) {
                yield* Object.entries(suppliedTables.get(tableName));
                return;
            }

            const table = database.#tableHandles[tableName];
            if (!table) return;
            for await (const [fileName] of table.entries()) {
                signal?.throwIfAborted();
                const value = await database.get(tableName, fileName);
                signal?.throwIfAborted();
                yield [fileName, value];
            }
        }

        async function* encodeDatabase() {
            yield encoder.encode('{');
            let firstTable = true;
            for (const tableName of selectedNames) {
                signal?.throwIfAborted();
                if (!firstTable) yield encoder.encode(',');
                firstTable = false;
                yield encoder.encode(`${JSON.stringify(tableName)}:{`);

                let firstRecord = true;
                for await (const [fileName, value] of tableRecords(tableName)) {
                    signal?.throwIfAborted();
                    if (!firstRecord) yield encoder.encode(',');
                    firstRecord = false;
                    const serialized = JSON.stringify(value);
                    if (serialized === undefined) {
                        throw new TypeError(`PNG record ${tableName}/${fileName} is not JSON-serializable.`);
                    }
                    yield encoder.encode(`${JSON.stringify(fileName)}:${serialized}`);
                }
                yield encoder.encode('}');
            }
            yield encoder.encode('}');
        }

        const encoded = encodeDatabase();
        const jsonStream = new ReadableStream(
            {
                async pull(controller) {
                    signal?.throwIfAborted();
                    const {done, value} = await encoded.next();
                    if (done) controller.close();
                    else controller.enqueue(value);
                },
                async cancel() {
                    await encoded.return();
                }
            }
        );
        const compressedStream = jsonStream.pipeThrough(
            new CompressionStream('deflate'),
            {signal}
        );
        const reader = compressedStream.getReader();
        const chunks = [];
        let totalLength = 0;
        try {
            while (true) {
                const {done, value} = await reader.read();
                signal?.throwIfAborted();
                if (done) break;
                chunks.push(value);
                totalLength += value.length;
            }
        } finally {
            reader.releaseLock();
        }

        // Length and channel offsets belong only to the existing PNG format.
        const payload = new Uint8Array(totalLength + 4);
        const view = new DataView(payload.buffer);
        view.setUint32(0, totalLength, true);
        let offset = 4;
        for (const chunk of chunks) {
            payload.set(chunk, offset);
            offset += chunk.length;
        }

        const size = Math.ceil(Math.sqrt(payload.length / 3));
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Canvas 2D context unavailable.');
        }

        const imgData = ctx.createImageData(size, size);
        let position = 0;
        for (let index = 0; index < imgData.data.length; index += 4) {
            imgData.data[index] = payload[position] ?? 0;
            imgData.data[index + 1] = payload[position + 1] ?? 0;
            imgData.data[index + 2] = payload[position + 2] ?? 0;
            imgData.data[index + 3] = 255;
            position += 3;
        }
        ctx.putImageData(imgData, 0, 0);

        const blob = await new Promise(
            function encodeBackupPNG(resolve) {
                canvas.toBlob(resolve, 'image/png');
            }
        );
        signal?.throwIfAborted();
        if (!blob) {
            throw new Error('PNG export failed.');
        }
        return blob;
    }

    /**
     * Downloads one PNG backup using the same options as createCompressedPNG.
     * Existing one-argument callers still export the whole database.
     * @param {string} name Base filename; an ISO timestamp is appended.
     * @param {Object} options PNG table selection and optional signal.
     * @returns {Promise<void>}
     */
    async downloadCompressedPNG(name = 'DBOPFS-backup', options = {}) {
        const blob = await this.createCompressedPNG(options);
        options.signal?.throwIfAborted();
        const stamp = new Date()
            .toISOString()
            .slice(0, 19)
            .replace(/[:T]/g, '-');

        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `${name}-${stamp}.png`;

        try {
            document.body.appendChild(a);
            options.signal?.throwIfAborted();
            a.click();
        } finally {
            a.remove();
            URL.revokeObjectURL(url);
        }
    }

    /**
     * Restores a database backup from a PNG image created by
     * `downloadCompressedPNG`.
     *
     * The PNG is decoded into RGBA pixel data,the compressed payload
     * is extracted using the stored byte length header, then
     * decompressed using DecompressionStream.
     *
     * The resulting JSON database structure is parsed and written
     * back into OPFS using `setMany`.
     *
     * Restore process:
     *
     *     PNG → RGBA bytes → deflate payload → JSON → DBOPFS tables
     *
     * Any existing records with matching keys will be overwritten.
     *
     * @param {File|Blob} file
     * PNG backup file generated by DBOPFS.
     * @param {Object} options
     * @param {function(Object): Object|Promise<Object>} [options.selectTables]
     * Receives the complete decoded table/file map once, before writes. Only
     * its returned map is restored; the application owns selection/projection.
     *
     * @returns {Promise<void>}
     * Resolves after every write succeeds. Rejected writes are collected after
     * all table batches settle and reported in an AggregateError with the
     * original reasons and table/file associations; successful writes remain.
     */
    async restoreFromPNG(file, {selectTables} = {}) {
        const img=await createImageBitmap(
            file,
            {premultiplyAlpha:'none'}
        )

        let data;
        try {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;

            const ctx = canvas.getContext('2d');
            if (!ctx) {
                throw new Error('Canvas 2D context unavailable.');
            }

            ctx.drawImage(img, 0, 0);
            data = ctx.getImageData(0, 0, img.width, img.height).data;
        } finally {
            img.close();
        }

        if(data.length < 4){
            throw new Error('Invalid PNG backup.')
        }

        const payload=new Uint8Array((data.length/4)*3);

        let p=0;

        for(let i=0;i<data.length;i+=4){
            payload[p++] = data[i];
            payload[p++] = data[i+1];
            payload[p++] = data[i+2];
        }

        const view=new DataView(payload.buffer)

        const length=view.getUint32(0,true);

        if(length <= 0 || length > payload.length-4){
            throw new Error('Invalid PNG backup payload length.')
        }

        const gzipBytes=payload.slice(4,4+length)

        const stream=new Blob([gzipBytes])
            .stream()
            .pipeThrough(new DecompressionStream('deflate'))

        const json=await new Response(stream).text()

        const decodedTables = JSON.parse(json);
        const db = selectTables === undefined
            ? decodedTables
            : await selectTables(decodedTables);

        const tables=Object.keys(db)

        const failures = [];
        for (const tableName of tables) {
            const fileNames = Object.keys(db[tableName]);
            const results = await this.setMany(tableName, db[tableName]);
            for (const [index, result] of results.entries()) {
                if (result.status === 'rejected') {
                    failures.push(
                        {tableName, fileName: fileNames[index], reason: result.reason}
                    );
                }
            }
        }

        if (failures.length > 0) {
            const error = new AggregateError(
                failures.map(
                    function restoreWriteReason(failure) {
                        return failure.reason;
                    }
                ),
                'PNG restore could not save every record.'
            );
            error.code = 'DBOPFS_RESTORE_WRITE_FAILED';
            error.failures = failures;
            throw error;
        }
    }
}

if(!is.function(window.dbopfs?.get)){
    window.dbopfs=new DBOPFS();
}

export default DBOPFS;

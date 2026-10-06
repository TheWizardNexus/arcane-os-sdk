import assert from 'node:assert/strict';
import test from '../src/testing.mjs';

let harnessSequence=0;

function storageError(name,message){
    const error=new Error(message);
    error.name=name;
    return error;
}

function createDirectory(name){
    const children=new Map();
    return {
        name,
        kind:'directory',
        children,
        async getDirectoryHandle(entryName,{create=false}={}){
            if(!children.has(entryName)){
                if(!create)throw storageError('NotFoundError',entryName);
                children.set(entryName,createDirectory(entryName));
            }
            return children.get(entryName);
        },
        async getFileHandle(entryName,{create=false}={}){
            if(!children.has(entryName)){
                if(!create)throw storageError('NotFoundError',entryName);
                const entry={name:entryName,kind:'file',text:'',readGate:null,closeGate:null,closeError:null};
                entry.getFile=async function getFile(){
                    const snapshot=new Blob([entry.text]);
                    const gate=entry.readGate;
                    return {
                        size:snapshot.size,
                        async text(){
                            if(gate)await gate.promise;
                            return snapshot.text();
                        }
                    };
                };
                entry.createWritable=async function createWritable({keepExistingData=false}={}){
                    let pending=keepExistingData?entry.text:'';
                    return {
                        async seek(){},
                        async write(blob){pending+=await blob.text();},
                        async close(){
                            if(entry.closeGate)await entry.closeGate.promise;
                            if(entry.closeError)throw entry.closeError;
                            entry.text=pending;
                        }
                    };
                };
                children.set(entryName,entry);
            }
            return children.get(entryName);
        },
        async removeEntry(entryName,{recursive=false}={}){
            const entry=children.get(entryName);
            if(!entry)throw storageError('NotFoundError',entryName);
            if(entry.removeError)throw entry.removeError;
            if(entry.kind==='directory'&&entry.children.size&&!recursive){
                throw storageError('InvalidModificationError',entryName);
            }
            children.delete(entryName);
        },
        async *entries(){yield* children.entries();}
    };
}

async function createHarness(){
    const descriptors=new Map(['window','document','navigator','Worker'].map(function descriptor(name){
        return [name,Object.getOwnPropertyDescriptor(globalThis,name)];
    }));
    const channels=new Set();
    const pending=[];
    const windows=[];
    const workerRequests=[];
    const workerRequested=Promise.withResolvers();
    const moduleId=++harnessSequence;
    let posts=0;
    class MemoryChannel {
        constructor(name){this.name=name;channels.add(this);}
        postMessage(data){
            posts+=1;
            for(const channel of channels){
                if(channel!==this&&channel.name===this.name){
                    pending.push({channel,data:structuredClone(data)});
                }
            }
        }
        close(){channels.delete(this);}
    }
    class FileWorker extends EventTarget {
        postMessage(data,transfer){
            workerRequests.push({data,port:transfer.at(-1)});
            workerRequested.resolve();
        }
        terminate(){}
    }
    const root=createDirectory('root');
    const storage={async persist(){return true;},async getDirectory(){return root;}};
    function setGlobal(name,value){
        Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
    }
    async function createDocument(applicationId='squid-parade',transport=true,Constructor=null){
        const documentObject={
            documentElement:{dataset:{arcaneAppId:applicationId}},
            querySelector(){return null;}
        };
        const windowTarget=new EventTarget();
        windowTarget.document=documentObject;
        if(transport)windowTarget.BroadcastChannel=MemoryChannel;
        windows.push(windowTarget);
        setGlobal('window',windowTarget);
        setGlobal('document',documentObject);
        setGlobal('navigator',{storage});
        setGlobal('Worker',FileWorker);
        if(Constructor){
            windowTarget.dbopfs=new Constructor({applicationId,storage,documentObject,arcane:null});
        }else{
            const module=await import(`../runtime/arcane/modules/DBOPFS.js?committed-change-fixture=${moduleId}`);
            Constructor=module.default;
        }
        await windowTarget.dbopfs.readyPromise;
        return {db:windowTarget.dbopfs,window:windowTarget,Constructor};
    }
    return {
        createDocument,
        workerRequests,
        workerRequested:workerRequested.promise,
        channels,
        get posts(){return posts;},
        flush(){
            while(pending.length){
                const {channel,data}=pending.shift();
                if(channels.has(channel))channel.onmessage?.({data});
            }
        },
        close(){
            for(const target of windows)target.dispatchEvent(new Event('pagehide'));
            for(const [name,descriptor] of descriptors){
                if(descriptor)Object.defineProperty(globalThis,name,descriptor);
                else delete globalThis[name];
            }
        }
    };
}

test('DBOPFS committed changes preserve values, invalidate aliases and relay once per document',async function committedChanges(){
    const harness=await createHarness();
    try{
        const first=await harness.createDocument();
        const second=await harness.createDocument('squid-parade',true,first.Constructor);
        const other=await harness.createDocument('moon-bus',true,first.Constructor);
        const local=[];
        const remote=[];
        const unrelated=[];
        first.db.subscribeChanges(event=>local.push(event.detail));
        second.db.subscribeChanges(event=>remote.push(event.detail));
        other.db.subscribeChanges(event=>unrelated.push(event.detail));
        const complete={title:'Squids stole the moon bus',body:'First line\nSecond line',nested:{enabled:true}};
        assert.deepEqual(await first.db.set('memories','parade.json',complete),complete);
        assert.equal(local.length,1);
        harness.flush();
        assert.equal(remote.length,1);
        assert.equal(unrelated.length,0);
        assert.equal(harness.posts,1);
        assert.equal(local[0].remote,false);
        assert.equal(remote[0].remote,true);
        assert.equal(remote[0].changeId,local[0].changeId);
        assert.equal(local[0].changeId,`${local[0].originId}:${local[0].sequence}`);
        assert.deepEqual(
            [local[0].applicationId,local[0].storagePath,local[0].tableName,local[0].directoryName,local[0].fileName,local[0].action],
            ['squid-parade','apps/squid-parade','memories','memory','parade.json','write']
        );
        assert.deepEqual(await second.db.get('memories','parade.json'),complete);
        assert.deepEqual(await second.db.get('memory','parade.json'),complete);
        await first.db.writeFile('memory','parade.json','{"title":"Bus returned"}');
        harness.flush();
        assert.equal(second.db.tables.memories?.['parade.json'],undefined);
        assert.equal(second.db.tables.memory?.['parade.json'],undefined);
        assert.deepEqual(await second.db.get('memories','parade.json'),{title:'Bus returned'});
        assert.equal(await first.db.set('memories','parade.json','\n',true),true);
        harness.flush();
        assert.equal(remote.at(-1).action,'append');
        await first.db.delete('memory','parade.json');
        harness.flush();
        assert.equal(remote.at(-1).action,'delete');
        assert.equal(await second.db.get('memories','parade.json'),null);
        const beforeMissingDelete=local.length;
        await first.db.delete('memories','parade.json');
        assert.equal(local.length,beforeMissingDelete);
        const tableBefore=await second.db.getTableHandle('memories');
        assert.equal((await first.db.removeEmptyTable('memories')).status,'removed');
        harness.flush();
        assert.equal(remote.at(-1).action,'table-delete');
        assert.equal(remote.at(-1).fileName,null);
        assert.notEqual(await second.db.getTableHandle('memory'),tableBefore);
        assert.equal(local.length,remote.length);
        assert.equal(harness.posts,local.length);

        const controller=new AbortController();
        let observed=0;
        const unsubscribe=first.db.subscribeChanges(()=>observed++,{signal:controller.signal});
        controller.abort();
        unsubscribe();
        unsubscribe.dispose();
        await first.db.set('records','after-abort.txt','Complete unchanged content');
        assert.equal(observed,0);

        const previousRemoteCount=remote.length;
        await second.db.get('records','after-abort.txt');
        second.window.dispatchEvent(new Event('pagehide'));
        await first.db.set('records','after-abort.txt','Changed while asleep');
        harness.flush();
        assert.equal(remote.length,previousRemoteCount);
        second.window.dispatchEvent(new Event('pageshow'));
        assert.equal(remote.length,previousRemoteCount);
        assert.equal(await second.db.get('records','after-abort.txt'),'Changed while asleep');

        const localOnly=await harness.createDocument('lone-squid',false,first.Constructor);
        let localOnlyCount=0;
        localOnly.db.subscribeChanges(()=>localOnlyCount++);
        await localOnly.db.set('records','quiet.txt','Local events remain available');
        assert.equal(localOnlyCount,1);
    }finally{
        harness.close();
    }
});

test('DBOPFS reports committed partial successes and keeps old reads out of refreshed cache',async function committedBoundaries(){
    const harness=await createHarness();
    try{
        const first=await harness.createDocument('squid-warehouse');
        const changes=[];
        first.db.subscribeChanges(event=>changes.push(event.detail));
        const table=await first.db.getTableHandle('records');
        const delayed=await table.getFileHandle('delayed.txt',{create:true});
        delayed.closeGate=Promise.withResolvers();
        const writing=first.db.writeFile('records','delayed.txt','Committed after close');
        await Promise.resolve();
        assert.equal(changes.length,0);
        delayed.closeGate.resolve();
        await writing;
        assert.equal(changes.length,1);
        const failed=await table.getFileHandle('failed.txt',{create:true});
        failed.closeError=new Error('Synthetic close failure');
        const batch=await first.db.setMany('records',{'good.txt':'Saved','failed.txt':'Unsaved'});
        assert.deepEqual(batch.map(result=>result.status),['fulfilled','rejected']);
        assert.deepEqual(changes.map(change=>change.fileName),['delayed.txt','good.txt']);
        failed.removeError=new Error('Synthetic removal failure');
        const beforeDelete=changes.length;
        const deleted=await first.db.deleteMany('records',['good.txt','failed.txt']);
        assert.deepEqual(deleted.map(result=>result.status),['fulfilled','rejected']);
        assert.equal(changes.length,beforeDelete+1);
        assert.equal(changes.at(-1).action,'delete');
        assert.equal(changes.at(-1).fileName,'good.txt');

        await first.db.set('records','race.txt','Old snapshot');
        const race=await table.getFileHandle('race.txt');
        race.readGate=Promise.withResolvers();
        const originalRead=first.db.readFile.bind(first.db);
        const entered=Promise.withResolvers();
        first.db.readFile=async function observeRead(...args){
            const file=await originalRead(...args);
            entered.resolve();
            return file;
        };
        const oldRead=first.db.get('records','race.txt',true);
        await entered.promise;
        await first.db.writeFile('records','race.txt','New committed value');
        race.readGate.resolve();
        assert.equal(await oldRead,'Old snapshot');
        race.readGate=null;
        first.db.readFile=originalRead;
        assert.equal(await first.db.get('records','race.txt'),'New committed value');

        const workerFile=await table.getFileHandle('worker.txt',{create:true});
        workerFile.createWritable=undefined;
        const beforeWorker=changes.length;
        const workerWrite=first.db.writeFile('records','worker.txt','Worker payload');
        // The native MessageChannel acknowledgement is the production boundary;
        // no timer or fake successful storage response is sent before capture.
        await harness.workerRequested;
        assert.equal(changes.length,beforeWorker);
        const request=harness.workerRequests.shift();
        assert.equal(new TextDecoder().decode(request.data.fileData),'Worker payload');
        request.port.postMessage({success:true});
        request.port.close();
        await workerWrite;
        assert.equal(changes.length,beforeWorker+1);
        assert.equal(changes.at(-1).fileName,'worker.txt');

        await first.db.set('survivors','captain.txt','Still saved');
        const survivors=await first.db.getTableHandle('survivors');
        survivors.removeError=new Error('Synthetic table removal failure');
        const beforeClear=changes.length;
        await assert.rejects(first.db.clearAllStorage(),survivors.removeError);
        assert.equal(changes.length,beforeClear+1);
        assert.equal(changes.at(-1).action,'table-delete');
        assert.equal(changes.at(-1).tableName,'records');
        assert.equal(await first.db.get('survivors','captain.txt'),'Still saved');
    }finally{
        harness.close();
    }
});

import {arcaneEvents} from '../event-manager.mjs';
import {CORE_PROTOCOL,CORE_READY_EVENTS,CoreError,serializeCoreError} from './contracts.mjs';

const CORE_CLIENT_KEY=Symbol.for('arcane-os.core.client');
const CORE_EVENT='core.rpc.event';
const LONG_OPERATION_TIMEOUT=50*60*1000;

/** One RPC client. Native execution and service policy belong to the host. */
export function createCoreClient({
    global=globalThis,
    transport:providedTransport=null,
    eventOwner=arcaneEvents,
    eventOwnerReady,
    autoConnect=true,
    onError=error=>global.console?.error('Arcane Core client failed.',error)
}={}){
    const pending=new Map();
    const acknowledgements=new Map();
    const completedEvents=new Map();
    const eventActions=[];
    const cleanups=[];
    const eventIdentity={};
    let source=null;
    let drainingEvents=false;
    let transport=null;
    let closed=false;
    let eventOwnerFailure=null;

    function report(error){
        try{onError(error instanceof CoreError?error:new CoreError(error));}
        catch(reportError){global.console?.error('Arcane Core error listener failed.',reportError,error);}
    }
    function uuid(){
        return global.crypto?.randomUUID?.()
            ??`req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }
    function attachEventOwner(owner){
        if(closed)return;
        source=owner.createSource(eventIdentity,{source:'core-client',eventTypes:[CORE_EVENT]});
        // This is an ordered handoff queue, not an event dispatcher. The SDK
        // event owner alone manages subscriptions and delivery.
        drainingEvents=true;
        try{
            while(eventActions.length&&!closed)eventActions.shift()();
        }finally{
            drainingEvents=false;
        }
    }
    function withEvents(action){
        if(closed)return;
        if(source&&!drainingEvents)action();
        else eventActions.push(action);
    }
    if(eventOwner)attachEventOwner(eventOwner);
    const eventsReady=eventOwner?Promise.resolve():Promise.resolve(eventOwnerReady).then(attachEventOwner);
    eventsReady.catch(function failEventOwner(error){
        eventOwnerFailure=error instanceof CoreError?error:new CoreError(error);
        for(const id of pending.keys())settle(id,eventOwnerFailure);
        report(eventOwnerFailure);
    });

    function emit(event,data){
        withEvents(()=>source.dispatch(CORE_EVENT,{event,data}));
    }
    function complete(event,data){
        if(completedEvents.has(event))return false;
        completedEvents.set(event,data);
        emit(event,data);
        return true;
    }
    const events={
        on(event,listener){
            if(typeof listener!=='function')throw new TypeError('Arcane event listener must be a function.');
            let active=!closed;
            let dispose=null;
            withEvents(()=>{
                if(!active)return;
                dispose=source.on(CORE_EVENT,function receiveCoreEvent(occurrence){
                    if(!active)return;
                    const message=occurrence.detail;
                    if(event==='*')listener(message);
                    else if(event===message.event)listener(message.data);
                });
            });
            return function unsubscribe(){
                if(!active)return false;
                active=false;
                dispose?.();
                return true;
            };
        },
        once(event,listener){
            if(typeof listener!=='function')throw new TypeError('Arcane event listener must be a function.');
            const unsubscribe=events.on(event,function receiveOnce(value){
                unsubscribe();
                listener(value);
            });
            return unsubscribe;
        },
        when(event,listener){
            if(!CORE_READY_EVENTS.includes(event))throw new TypeError('Arcane completion event is not designated as durable.');
            if(typeof listener!=='function')throw new TypeError('Arcane event listener must be a function.');
            if(!completedEvents.has(event))return events.once(event,listener);
            const value=completedEvents.get(event);
            let active=!closed;
            Promise.resolve().then(function replayReadyEvent(){
                if(!active||closed)return;
                active=false;
                try{listener(value);}catch(error){report(error);}
            });
            return function unsubscribe(){active=false;};
        },
        completed(event){return CORE_READY_EVENTS.includes(event)&&completedEvents.has(event);}
    };

    function settle(id,error,result){
        const request=pending.get(id);
        if(!request)return false;
        pending.delete(id);
        clearTimeout(request.timer);
        request.signal?.removeEventListener('abort',request.abort);
        if(error)request.reject(error);
        else request.resolve(result);
        return true;
    }
    function receive(input){
        if(closed)return false;
        let message=input;
        if(typeof message==='string'){
            try{message=JSON.parse(message);}
            catch(error){report(new CoreError({code:'ARCANE_INVALID_NATIVE_JSON',message:error.message,input,cause:error}));return false;}
        }
        if(!message||message.protocol!==CORE_PROTOCOL)return false;
        if(message.type==='event'){
            const data=Object.hasOwn(message,'data')?message.data:{};
            if(CORE_READY_EVENTS.includes(message.event))complete(message.event,data);
            else emit(message.event,data);
            return true;
        }
        if(message.type!=='response'||!pending.has(message.id))return false;
        // Final responses follow earlier event deliveries, including while a
        // classic host is connecting the shared SDK event owner. A stream's
        // completion must not remove its subscription before its chunks arrive.
        withEvents(()=>settle(message.id,message.ok?null:new CoreError(message.error),message.result));
        return true;
    }
    function installCallback(name,value){
        const previous=global[name];
        global[name]=value;
        cleanups.push(function restoreCallback(){
            if(global[name]!==value)return;
            if(previous===undefined)delete global[name];
            else global[name]=previous;
        });
    }
    function parseAcknowledgement(input,{required=false}={}){
        let acknowledgement=input;
        if(typeof acknowledgement==='string'){
            try{acknowledgement=JSON.parse(acknowledgement);}catch{acknowledgement=null;}
        }
        if(acknowledgement?.accepted===false){
            throw new CoreError(acknowledgement.error??{code:'BRIDGE_REJECTED',message:'The native host rejected the request.'});
        }
        if(required&&acknowledgement?.accepted!==true){
            throw new CoreError({code:'NATIVE_BRIDGE_REPLY_INVALID',message:'The native host returned an invalid acknowledgement.'});
        }
    }
    function acknowledge(token,value){
        const record=acknowledgements.get(token);
        if(!record)return false;
        acknowledgements.delete(token);
        clearTimeout(record.timer);
        try{parseAcknowledgement(value,{required:true});record.resolve();}
        catch(error){record.reject(error);}
        return true;
    }
    function chooseTransport(){
        const webview=global.chrome?.webview;
        if(webview?.hostObjects){
            const bridge=webview.hostObjects.arcaneBridge;
            function nativeMessage(event){receive(event.data);}
            webview.addEventListener('message',nativeMessage);
            cleanups.push(()=>webview.removeEventListener?.('message',nativeMessage));
            return {name:'webview2',async send(frame){
                try{parseAcknowledgement(await bridge.Send(JSON.stringify(frame)));}
                catch(error){
                    if(error instanceof CoreError)throw error;
                    const details=serializeCoreError(error);
                    if(error?.code===undefined)details.code='ARCANE_BRIDGE_CALL_FAILED';
                    throw new CoreError({
                        method:frame.method,transport:'webview2',...details
                    });
                }
            }};
        }
        const webkit=global.webkit?.messageHandlers?.arcane;
        if(typeof global.__arcaneWebKitPostMessage==='function'||webkit){
            installCallback('__arcaneReceive',receive);
            installCallback('__arcaneWebKitAcknowledge',acknowledge);
            return {name:'webkitgtk',async send(frame){
                const serialized=JSON.stringify(frame);
                if(typeof global.__arcaneWebKitPostMessage!=='function'){
                    parseAcknowledgement(await webkit.postMessage(serialized),{required:true});
                    return;
                }
                const token=uuid();
                return new Promise(function sendWebKitFrame(resolve,reject){
                    const timer=setTimeout(function missingAcknowledgement(){
                        acknowledgements.delete(token);
                        reject(new CoreError({code:'NATIVE_BRIDGE_ACK_TIMEOUT',message:'The native host did not acknowledge the request.'}));
                    },30000);
                    acknowledgements.set(token,{resolve,reject,timer});
                    try{
                        if(global.__arcaneWebKitPostMessage(token,serialized)!==true){
                            throw new CoreError({code:'NATIVE_BRIDGE_UNTRUSTED_MAIN_FRAME',message:'The native host did not accept the request.'});
                        }
                    }catch(error){
                        acknowledgements.delete(token);
                        clearTimeout(timer);
                        reject(error instanceof CoreError?error:new CoreError(error));
                    }
                });
            }};
        }
        const android=global.arcaneAndroid;
        if(typeof android?.postMessage==='function'){
            const previous=android.onmessage;
            function androidMessage(message){
                receive(message&&typeof message==='object'&&'data' in message?message.data:message);
            }
            android.onmessage=androidMessage;
            cleanups.push(()=>{if(android.onmessage===androidMessage)android.onmessage=previous;});
            return {name:'android-webview',async send(frame){
                try{await android.postMessage(JSON.stringify(frame));}
                catch(error){
                    const details=serializeCoreError(error);
                    if(error?.code===undefined)details.code='ARCANE_ANDROID_BRIDGE_CALL_FAILED';
                    throw new CoreError({
                        method:frame.method,transport:'android-webview',...details
                    });
                }
            }};
        }
        if(global.__ARCANE_DEV_HTTP__){
            if(typeof global.EventSource==='function'){
                const stream=new global.EventSource('/events');
                stream.onmessage=event=>receive(event.data);
                stream.onerror=event=>report(new CoreError({code:'DEV_BRIDGE_EVENT_ERROR',message:'The development event connection reported an error.',event}));
                cleanups.push(()=>stream.close());
            }
            return {name:'development-http',async send(frame){
                const response=await global.fetch('/rpc',{
                    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(frame)
                });
                const payload=await response.json();
                if(!response.ok)throw new CoreError(payload?.error??{code:'DEV_BRIDGE_FAILED',message:'The development bridge failed.'});
                if(payload?.type==='response')receive(payload);
            }};
        }
        throw new CoreError({code:'ARCANE_TRANSPORT_UNAVAILABLE',message:'This interface is not connected to an Arcane native host.'});
    }
    function connect(){
        if(closed)throw new CoreError({code:'ARCANE_CLIENT_CLOSED',message:'The Core client is closed.'});
        if(transport)return transport;
        const cleanupStart=cleanups.length;
        try{
            const selected=providedTransport??chooseTransport();
            if(typeof selected?.send!=='function'){
                throw new CoreError({code:'ARCANE_TRANSPORT_INVALID',message:'The Core transport must provide send(frame).'});
            }
            transport=selected;
            if(typeof transport.subscribe==='function'){
                const unsubscribe=transport.subscribe(receive);
                if(typeof unsubscribe==='function')cleanups.push(unsubscribe);
            }
        }catch(error){
            transport=null;
            for(const cleanup of cleanups.splice(cleanupStart)){
                try{cleanup();}catch(cleanupError){report(cleanupError);}
            }
            throw error;
        }
        complete('transport.ready',{protocol:CORE_PROTOCOL,transport:transport.name});
        return transport;
    }
    function runtimeSnapshot(){
        const name=transport?.name??providedTransport?.name
            ??(global.chrome?.webview?.hostObjects?'webview2'
                :typeof global.__arcaneWebKitPostMessage==='function'||global.webkit?.messageHandlers?.arcane?'webkitgtk'
                    :typeof global.arcaneAndroid?.postMessage==='function'?'android-webview'
                        :global.__ARCANE_DEV_HTTP__?'development-http':'standalone');
        return {connected:transport!==null&&!closed,transport:name,
            native:['webview2','webkitgtk','android-webview'].includes(name),
            managedLocalAI:['webview2','webkitgtk'].includes(name)};
    }
    function sendControl(frame){
        if(!transport)return;
        try{Promise.resolve(transport.send(frame)).catch(report);}catch(error){report(error);}
    }
    function aborted(method){
        return new CoreError({name:'AbortError',code:'ARCANE_REQUEST_ABORTED',message:'The Arcane request was cancelled.',method});
    }
    function cancel(id,error){
        if(!settle(id,error))return false;
        sendControl({protocol:CORE_PROTOCOL,type:'control',control:'request.cancel',requestId:id});
        return true;
    }
    function cancelAll(){
        if(!pending.size)return false;
        for(const [id,request] of pending)settle(id,aborted(request.method));
        sendControl({protocol:CORE_PROTOCOL,type:'control',control:'requests.cancelAll'});
        return true;
    }
    function invoke(method,parameters={},options={}){
        if(eventOwnerFailure)return Promise.reject(eventOwnerFailure);
        let selected;
        try{selected=connect();}catch(error){return Promise.reject(error);}
        const {signal,timeoutMs=10*60*1000}=options??{};
        if(signal&&(typeof signal.aborted!=='boolean'
            ||typeof signal.addEventListener!=='function'
            ||typeof signal.removeEventListener!=='function')){
            return Promise.reject(new TypeError('Arcane request signal must be an AbortSignal.'));
        }
        if(signal?.aborted)return Promise.reject(aborted(method));
        const id=uuid();
        const frame={protocol:CORE_PROTOCOL,type:'request',id,method,parameters,sentAt:new Date().toISOString()};
        const promise=new Promise(function ownRequest(resolve,reject){
            const abort=()=>cancel(id,aborted(method));
            const timer=timeoutMs>0?setTimeout(()=>cancel(id,new CoreError({
                code:'ARCANE_REQUEST_TIMEOUT',message:'Arcane did not finish the operation before the request timed out.',method
            })),timeoutMs):null;
            pending.set(id,{resolve,reject,timer,signal,abort,method});
            signal?.addEventListener('abort',abort,{once:true});
            if(signal?.aborted)abort();
        });
        if(!pending.has(id))return promise;
        function sendFailed(error){
            const failure=error instanceof CoreError?error:new CoreError(error);
            if(!settle(id,failure))report(failure);
        }
        try{
            Promise.resolve(selected.send(frame)).catch(sendFailed);
        }catch(error){sendFailed(error);}
        return promise;
    }
    function close(){
        if(closed)return false;
        closed=true;
        cancelAll();
        for(const record of acknowledgements.values()){
            clearTimeout(record.timer);
            record.reject(new CoreError({code:'ARCANE_CLIENT_CLOSED',message:'The Core client is closed.'}));
        }
        acknowledgements.clear();
        for(const cleanup of cleanups.splice(0)){
            try{cleanup();}catch(error){report(error);}
        }
        source?.dispose();
        // Registration closures and already-delivered payloads belong to this
        // client lifetime and are released when the owner explicitly closes it.
        eventActions.length=0;
        completedEvents.clear();
        return true;
    }
    if(typeof global.addEventListener==='function'){
        global.addEventListener('pagehide',cancelAll,{capture:true});
        cleanups.push(()=>global.removeEventListener('pagehide',cancelAll,{capture:true}));
    }
    if(autoConnect){
        try{connect();}catch(error){if(error.code!=='ARCANE_TRANSPORT_UNAVAILABLE')report(error);}
    }
    return {protocol:CORE_PROTOCOL,Error:CoreError,invoke,receive,connect,close,cancelAll,events,eventsReady,runtime:{current:runtimeSnapshot},uuid};
}

/** Existing namespace call shapes; method implementations remain host-owned. */
export function createCoreFacade(client){
    const {invoke,events,uuid}=client;
    const long={timeoutMs:LONG_OPERATION_TIMEOUT};
    function ollamaInvoke(operation,request={},options={}){
        const onChunk=typeof options==='function'?options:options?.onChunk;
        const timeoutMs=options?.timeoutMs??(['pull','push','create'].includes(operation)?LONG_OPERATION_TIMEOUT:10*60*1000);
        if(typeof onChunk!=='function')return invoke(`ollama.${operation}`,request,{timeoutMs,signal:options?.signal});
        const streamId=uuid();
        const unsubscribe=events.on('ollama.chunk',function streamChunk(event){
            if(event?.streamId===streamId)onChunk(event.chunk,{operation,streamId});
        });
        return invoke(`ollama.${operation}`,{...request,stream:true,streamId},{timeoutMs,signal:options?.signal}).finally(unsubscribe);
    }
    function environmentNameIsSensitive(name){
        const canonical=String(name??'').toUpperCase();
        return canonical.split(/[_.-]+/u).some(token=>[
            'AUTH','BEARER','CREDENTIAL','CREDENTIALS','KEY','KEYS','PASS','PASSWD','PASSWORD','PASSWORDS','PWD','SECRET','SECRETS','TOKEN','TOKENS'
        ].includes(token))||['ACCESSKEY','ACCESSTOKEN','APIKEY','AUTHKEY','AUTHTOKEN','CLIENTSECRET','PRIVATEKEY'].some(suffix=>canonical.endsWith(suffix));
    }
    return {
        protocol:CORE_PROTOCOL,Error:CoreError,runtime:client.runtime,events,
        ai:{
            models:()=>invoke('ai.models'),chat:request=>invoke('ai.chat',request??{},{timeoutMs:130000}),
            profile:()=>invoke('ai.profile.current'),providerSettings:()=>invoke('ai.provider.settings.get'),
            saveProviderSettings:settings=>invoke('ai.provider.settings.set',settings??{},{timeoutMs:130000}),
            providerModels:()=>invoke('ai.provider.models',{},{timeoutMs:130000})
        },
        environment:{list:()=>invoke('environment.list'),get:name=>invoke('environment.get',{name}),
            set:(name,value,options)=>invoke('environment.set',{name,value,protected:options&&Object.hasOwn(options,'protected')?options.protected:environmentNameIsSensitive(name)}),
            remove:name=>invoke('environment.delete',{name})},
        mail:{send:request=>invoke('mail.send',request??{},{timeoutMs:450000})},
        speech:{status:()=>invoke('speech.status',{},{timeoutMs:10000}),
            synthesize:request=>invoke('speech.synthesize',request??{},{timeoutMs:180000}),
            transcribe:request=>invoke('speech.transcribe',request??{},{timeoutMs:180000})},
        localAI:{status:()=>invoke('localai.status',{},{timeoutMs:15000}),
            ensurePlatform:()=>invoke('localai.platform.ensure',{},long),recover:request=>invoke('localai.services.recover',request??{},long),
            setParallelRequests:request=>invoke('localai.parallel.requests.set',request??{},long),
            inspectIsolatedModel:request=>invoke('localai.isolated.inspect',request??{},{timeoutMs:45000}),
            runIsolatedQuestion(request={},options={}){
                const operationId=uuid();
                const unsubscribe=typeof options?.onPhase==='function'?events.on('localai.isolated.phase',event=>{
                    if(event?.operationId===operationId)options.onPhase(event.phase,event);
                }):()=>{};
                return invoke('localai.isolated.question',{...request,operationId},long).finally(unsubscribe);
            }},
        ollama:{version:()=>invoke('ollama.version'),models:()=>invoke('ollama.models'),list:()=>invoke('ollama.models'),
            running:()=>invoke('ollama.running'),show:(model,options={})=>invoke('ollama.show',{...options,model}),
            generate:(request,options)=>ollamaInvoke('generate',request,options),chat:(request,options)=>ollamaInvoke('chat',request,options),
            embed:request=>invoke('ollama.embed',request??{}),
            pull:(model,options={},streamOptions)=>ollamaInvoke('pull',{...options,model},streamOptions),
            push:(model,options={},streamOptions)=>ollamaInvoke('push',{...options,model},streamOptions),
            create:(request,options)=>ollamaInvoke('create',request,options),
            copy:(source,destination)=>invoke('ollama.copy',{source,destination},{timeoutMs:120000}),
            delete:model=>invoke('ollama.delete',{model},{timeoutMs:120000}),selection:()=>invoke('ollama.selection.get'),
            select:preference=>invoke('ollama.selection.set',{preference:preference??'auto'},long),settings:()=>invoke('ollama.settings.get'),
            saveSettings:settings=>invoke('ollama.settings.set',settings??{},long),createBrain:definition=>invoke('ollama.brain.create',definition??{},long),
            serviceSettings:()=>invoke('ollama.service.settings.get'),saveServiceSettings:settings=>invoke('ollama.service.settings.set',settings??{},long)},
        app:{current:()=>invoke('app.current')},applications:{list:()=>invoke('apps.list'),launch:id=>invoke('apps.launch',{id})},
        external:{open:uri=>invoke('external.open',{uri})},
        terminal:{start:(options={})=>invoke('terminal.start',{shell:options?.shell??'auto',cwd:options?.cwd??'',columns:options?.columns??120,rows:options?.rows??32}),
            list:()=>invoke('terminal.list'),write:(sessionId,data)=>invoke('terminal.write',{sessionId,data}),
            resize:(sessionId,columns,rows)=>invoke('terminal.resize',{sessionId,columns,rows}),
            signal:(sessionId,signal='interrupt')=>invoke('terminal.signal',{sessionId,signal}),close:sessionId=>invoke('terminal.close',{sessionId})},
        capabilities:{list:()=>invoke('capabilities.list')},platform:{status:()=>invoke('platform.status')},permissions:{status:()=>invoke('permissions.status')},
        version:{current:()=>invoke('version.current'),installation:()=>invoke('installation.status')},machine:{status:()=>invoke('machine.status')},user:{current:()=>invoke('user.current')},
        requirements:{list:()=>invoke('requirements.list'),ensure:(requirementIds,options={})=>invoke('requirements.ensure',{
            requirementIds,userProcessInterruption:options?.userProcessInterruption??'deny'
        },long)},
        installation:{status:()=>invoke('installation.status'),ensure:()=>invoke('installation.ensure',{},long),openUninstaller:()=>invoke('installation.uninstaller.open')},
        users:{list:()=>invoke('users.list'),validate:usernames=>invoke('users.validate',{usernames:Array.isArray(usernames)?usernames:[usernames]}),
            add:usernames=>invoke('users.add',{usernames:Array.isArray(usernames)?usernames:[usernames]},long),
            activate:username=>invoke('users.activate',{username},long),resetPassword:username=>invoke('users.resetPassword',{username},long),
            applyPassword:(username,temporaryPassword)=>invoke('users.applyPassword',{username,temporaryPassword},long),
            verifyShell:username=>invoke('users.verifyShell',{username},long),restoreShell:username=>invoke('users.restoreShell',{username},long)},
        system:{lock:()=>invoke('system.lock'),ping:()=>invoke('system.ping',{},{timeoutMs:10000}),metrics:()=>invoke('system.metrics'),
            failurePolicy:()=>invoke('system.failurePolicy.get'),saveFailurePolicy:settings=>invoke('system.failurePolicy.set',settings??{})},
        network:{status:()=>invoke('network.status')},filesystem:{selectDirectory:(options={})=>invoke('filesystem.directory.select',options,long)},
        storage:{list:()=>invoke('storage.list'),get:key=>invoke('storage.get',{key}),set:(key,value)=>invoke('storage.set',{key,value}),delete:key=>invoke('storage.delete',{key})},
        preferences:{list:()=>invoke('preferences.list'),get:key=>invoke('preferences.get',{key}),set:(key,value)=>invoke('preferences.set',{key,value}),
            setMany:entries=>invoke('preferences.setMany',{entries}),delete:key=>invoke('preferences.delete',{key})},
        appearance:{current:()=>invoke('appearance.current'),apply:appearance=>invoke('appearance.apply',appearance??{})},session:{logout:()=>invoke('session.logout')},
        provisioning:{plan:usernames=>invoke('provisioning.plan',{usernames:Array.isArray(usernames)?usernames:[usernames].filter(Boolean)})},
        diagnostics:{recentErrors:()=>invoke('diagnostics.recent'),get:diagnosticId=>invoke('diagnostics.get',{diagnosticId})},
        development:{inspect:root=>invoke('development.inspect',{root}),context:(root,query)=>invoke('development.context',{root,query},{timeoutMs:130000}),
            setup:(root,taskId)=>invoke('development.setup',{root,taskId},long),installNode:()=>invoke('development.node.install',{},long)}
    };
}

/** Installs the same synchronous facade used by classic native-host scripts. */
export function installCoreClient(global=globalThis,options={}){
    if(global[CORE_CLIENT_KEY])return global[CORE_CLIENT_KEY];
    const client=createCoreClient({...options,global,autoConnect:false});
    const facade=createCoreFacade(client);
    global.Arcane=facade;
    global[CORE_CLIENT_KEY]=client;
    const previous=global.__arcaneReceive;
    global.__arcaneReceive=client.receive;
    const close=client.close;
    client.close=function closeInstalledClient(){
        const changed=close();
        if(global[CORE_CLIENT_KEY]===client)delete global[CORE_CLIENT_KEY];
        if(global.Arcane===facade)delete global.Arcane;
        if(global.__arcaneReceive===client.receive){
            if(previous===undefined)delete global.__arcaneReceive;
            else global.__arcaneReceive=previous;
        }
        return changed;
    };
    try{client.connect();}catch(error){
        if(error.code!=='ARCANE_TRANSPORT_UNAVAILABLE'){
            if(options.onError)options.onError(error);
            else global.console?.error('Arcane Core transport initialization failed.',error);
        }
    }
    return client;
}

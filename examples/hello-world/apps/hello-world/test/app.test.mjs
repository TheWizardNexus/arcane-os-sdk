import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import test from 'arcane-os/testing';

const appRoot=new URL('../',import.meta.url);
const MODEL=Object.freeze({
    id:'ibm-granite-4.1-3b-q4-k-s',
    url:'https://huggingface.co/ibm-granite/granite-4.1-3b-GGUF/resolve/ab4701481089b58a082ef63cc1cee738887293ff/granite-4.1-3b-Q4_K_S.gguf',
    bytes:1_998_371_424,
    sha256:'ed5b17192313b021f0579561d9c471419e7e62ec490986364e3d9d63ea36a08a'
});

const TEST_SPEECH_AUTHORITIES=Object.freeze({
    stt:Object.freeze({
        model:Object.freeze({
            id:'hello-world-test-whisper',
            repository:'hello-world-test/stt',
            revision:'stt-r1',
            files:Object.freeze([Object.freeze({
                path:'models/stt-r1/model.bin',
                url:'https://speech.example.invalid/releases/stt-r1/model.bin',
                bytes:4,
                sha256:'1111111111111111111111111111111111111111111111111111111111111111',
                mediaType:'application/octet-stream'
            })])
        }),
        runtime:Object.freeze({
            adapter:'transformers-whisper',
            version:'test-1',
            revision:'stt-runtime-r1',
            entry:'runtime/stt-runtime-r1/index.js',
            files:Object.freeze([Object.freeze({
                path:'runtime/stt-runtime-r1/index.js',
                url:'https://speech.example.invalid/releases/stt-runtime-r1/index.js',
                bytes:4,
                sha256:'2222222222222222222222222222222222222222222222222222222222222222',
                mediaType:'text/javascript'
            })])
        })
    }),
    tts:Object.freeze({
        model:Object.freeze({
            id:'hello-world-test-kokoro',
            repository:'hello-world-test/tts',
            revision:'tts-r1',
            defaultVoice:'hello-world-test-voice',
            files:Object.freeze([Object.freeze({
                path:'models/tts-r1/model.bin',
                url:'https://speech.example.invalid/releases/tts-r1/model.bin',
                bytes:4,
                sha256:'3333333333333333333333333333333333333333333333333333333333333333',
                mediaType:'application/octet-stream'
            })])
        }),
        runtime:Object.freeze({
            adapter:'kokoro-js',
            version:'test-1',
            revision:'tts-runtime-r1',
            entry:'runtime/tts-runtime-r1/index.js',
            files:Object.freeze([Object.freeze({
                path:'runtime/tts-runtime-r1/index.js',
                url:'https://speech.example.invalid/releases/tts-runtime-r1/index.js',
                bytes:4,
                sha256:'4444444444444444444444444444444444444444444444444444444444444444',
                mediaType:'text/javascript'
            })])
        })
    })
});
const EMPTY_SPEECH_AUTHORITIES=Object.freeze({stt:null,tts:null});

async function runtimeRoot(){
    const physical=new URL('../../../arcane/',import.meta.url);
    await stat(new URL('modules/AppDataScope.js',physical));
    return physical;
}

function interactiveElement({
    textContent='',
    value='',
    disabled=false,
    hidden=false,
    max=0,
    files=[],
    src=''
}={}){
    const listeners=new Map();
    const element={
        textContent,
        value,
        disabled,
        hidden,
        max,
        files,
        src,
        loadCalls:0,
        pauseCalls:0,
        playCalls:0,
        removedAttributes:[]
    };
    element.addEventListener=function addEventListener(type,listener){
        const values=listeners.get(type)??new Set();
        values.add(listener);
        listeners.set(type,values);
    };
    element.removeEventListener=function removeEventListener(type,listener){
        listeners.get(type)?.delete(listener);
    };
    element.trigger=async function trigger(type){
        const values=[...(listeners.get(type)??[])];
        assert.ok(values.length>0,`Missing ${type} listener.`);
        for(const listener of values){
            await listener.call(element,{type,target:element,currentTarget:element});
        }
    };
    element.removeAttribute=function removeAttribute(name){
        element.removedAttributes.push(name);
        if(name==='src')element.src='';
        if(name==='value')element.value=undefined;
    };
    element.pause=function pause(){ element.pauseCalls+=1; };
    element.load=function load(){ element.loadCalls+=1; };
    element.play=function play(){
        element.playCalls+=1;
        return Promise.resolve();
    };
    return element;
}

function browserHarness(){
    const elements=new Map([
        ['#app-action',interactiveElement()],
        ['#app-status',interactiveElement({textContent:'Ready to say hello.'})],
        ['#ai-load',interactiveElement()],
        ['#ai-load-offline',interactiveElement()],
        ['#ai-unload',interactiveElement({disabled:true})],
        ['#ai-cancel',interactiveElement({disabled:true,hidden:true})],
        ['#ai-prompt',interactiveElement({
            value:'Say hello in one short sentence. If useful, propose the show_greeting tool.'
        })],
        ['#ai-send',interactiveElement({disabled:true})],
        ['#ai-status',interactiveElement({
            textContent:'Model not loaded. No model download has started.'
        })],
        ['#ai-lifecycle',interactiveElement({textContent:'Lifecycle: unloaded.'})],
        ['#ai-progress',interactiveElement({value:0,max:MODEL.bytes,hidden:true})],
        ['#ai-progress-label',interactiveElement()],
        ['#ai-response',interactiveElement({textContent:'Load the model to begin.'})],
        ['#ai-tool-calls',interactiveElement({
            textContent:'No tool calls proposed. Structural output is displayed only; the application invokes no tool.'
        })],
        ['#speech-authority-status',interactiveElement()],
        ['#tts-lifecycle',interactiveElement()],
        ['#tts-status',interactiveElement()],
        ['#tts-load',interactiveElement({disabled:true})],
        ['#tts-load-offline',interactiveElement({disabled:true})],
        ['#tts-cancel',interactiveElement({disabled:true,hidden:true})],
        ['#tts-unload',interactiveElement({disabled:true})],
        ['#tts-progress',interactiveElement({value:0,max:1,hidden:true})],
        ['#tts-progress-label',interactiveElement()],
        ['#tts-input',interactiveElement({
            value:"Hello from Arcane's independent text-to-speech lifecycle."
        })],
        ['#tts-synthesize',interactiveElement({disabled:true})],
        ['#tts-audio',interactiveElement({hidden:true})],
        ['#stt-lifecycle',interactiveElement()],
        ['#stt-status',interactiveElement()],
        ['#stt-load',interactiveElement({disabled:true})],
        ['#stt-load-offline',interactiveElement({disabled:true})],
        ['#stt-cancel',interactiveElement({disabled:true,hidden:true})],
        ['#stt-unload',interactiveElement({disabled:true})],
        ['#stt-progress',interactiveElement({value:0,max:1,hidden:true})],
        ['#stt-progress-label',interactiveElement()],
        ['#stt-file',interactiveElement({disabled:true,files:[]})],
        ['#stt-transcribe',interactiveElement({disabled:true})],
        ['#stt-transcript',interactiveElement()]
    ]);

    class HarnessBlob {
        constructor(parts=[],options={}){
            this.parts=[...parts];
            this.type=options.type??'';
            this.size=this.parts.reduce(function sumBlobSize(total,part){
                return total+Number(part?.byteLength??part?.size??String(part).length);
            },0);
        }
    }

    class HarnessFile extends HarnessBlob {
        constructor(parts,name,options={}){
            super(parts,options);
            this.name=String(name);
            this.lastModified=options.lastModified??0;
        }
    }

    const NativeURL=globalThis.URL;
    const urlCalls={created:[],revoked:[]};
    class HarnessURL extends NativeURL {}
    HarnessURL.createObjectURL=function createObjectURL(blob){
        const value=`blob:hello-world-${urlCalls.created.length+1}`;
        urlCalls.created.push({blob,value});
        return value;
    };
    HarnessURL.revokeObjectURL=function revokeObjectURL(value){
        urlCalls.revoked.push(value);
    };
    const values=new Map();
    const storage={
        getItem(key){ return values.has(key)?values.get(key):null; },
        setItem(key,value){ values.set(key,String(value)); },
        removeItem(key){ values.delete(key); }
    };
    const dataset={arcaneAppId:'hello-world'};
    const properties=new Map();
    const root={
        dataset,
        style:{
            fontSize:'',
            setProperty(name,value){ properties.set(name,value); },
            removeProperty(name){ properties.delete(name); }
        },
        removeAttribute(name){
            if(!name.startsWith('data-'))return;
            const key=name.slice(5).replace(/-([a-z])/gu,(_match,letter)=>letter.toUpperCase());
            delete dataset[key];
        }
    };
    const documentObject={
        documentElement:root,
        querySelector(selector){
            if(selector==='meta[name="arcane-app-id"]'){
                return {getAttribute:name=>name==='content'?'hello-world':null};
            }
            return elements.get(selector)??null;
        }
    };
    const pageListeners=new Map();
    function addPageListener(type,listener,options={}){
        const records=pageListeners.get(type)??new Set();
        records.add({listener,once:options?.once===true});
        pageListeners.set(type,records);
    }
    function removePageListener(type,listener){
        const records=pageListeners.get(type);
        for(const record of records??[]){
            if(record.listener===listener)records.delete(record);
        }
    }
    async function triggerPage(type,details={}){
        const records=[...(pageListeners.get(type)??[])];
        for(const record of records){
            record.listener({...details,type,target:globalThis,currentTarget:globalThis});
            if(record.once)pageListeners.get(type)?.delete(record);
        }
        await new Promise(resolve=>setTimeout(resolve,0));
    }
    const location={
        reloadCalls:0,
        reload(){ location.reloadCalls+=1; }
    };
    return {
        Blob:HarnessBlob,
        File:HarnessFile,
        URL:HarnessURL,
        addPageListener,
        documentObject,
        elements,
        location,
        removePageListener,
        storage,
        triggerPage,
        urlCalls,
        values
    };
}

function arcaneFailure(code,message='provider-private-message'){
    return Object.assign(new Error(message),{code});
}

function aiHarness(options={}){
    const behavior={
        deferRequest:options.deferRequest===true,
        offlineMiss:options.offlineMiss===true,
        speechDeferRequest:{stt:false,tts:false},
        speechFailureRole:options.speechFailureRole??null,
        speechOfflineMissRole:options.speechOfflineMissRole??null
    };
    const calls={
        createAI:[],
        configureBrowserSpeech:[],
        configureSpeech:[],
        dbopfs:[],
        dispose:0,
        load:[],
        modelSources:[],
        provider:[],
        requests:[],
        resolveSpeechRequest:{stt:null,tts:null},
        speechDisposes:[],
        speechConfigurationDisposes:0,
        speechFetch:0,
        speechAuthorityValidations:[],
        speechLoads:[],
        speechProviders:{stt:[],tts:[]},
        speechRequests:[],
        speechRuntimeCancels:[],
        speechStore:[],
        speechUnloads:[],
        store:[],
        storeRemove:0,
        unload:0
    };
    const listeners=new Map();
    let state='unloaded';
    let cacheState='unknown';
    let progress=null;

    function flatStatus(){
        return Object.freeze({
            state,
            cache:Object.freeze({state:cacheState}),
            security:Object.freeze({
                secure:false,
                checks:Object.freeze({byteLength:false,sha256:false})
            }),
            integrity:Object.freeze({state:'unchecked'}),
            progress
        });
    }

    function emit(type){
        const event={type,detail:flatStatus()};
        for(const listener of [...(listeners.get(type)??[])]){
            listener(event);
        }
    }

    function report(phase,loaded){
        progress=Object.freeze({
            modelId:MODEL.id,
            phase,
            loaded,
            total:MODEL.bytes,
            percent:(loaded/MODEL.bytes)*100
        });
        emit('progress');
    }

    const facade={
        llm:{
            addEventListener(type,listener){
                const values=listeners.get(type)??new Set();
                values.add(listener);
                listeners.set(type,values);
            },
            removeEventListener(type,listener){ listeners.get(type)?.delete(listener); }
        },
        status(){ return Object.freeze({llm:flatStatus()}); },
        async load(loadOptions={}){
            calls.load.push(loadOptions);
            state='loading';
            progress=null;
            emit('statechange');
            if(loadOptions.offline===true){
                report('verify-cache',MODEL.bytes);
                if(behavior.offlineMiss){
                    state='error';
                    progress=null;
                    emit('statechange');
                    throw arcaneFailure(
                        'ARCANE_AI_MODEL_OFFLINE_MISS',
                        'PRIVATE OFFLINE PROVIDER DETAIL'
                    );
                }
                cacheState='cached';
            }else{
                report('download',Math.floor(MODEL.bytes/2));
                report('verify-download',MODEL.bytes);
                cacheState='installed';
            }
            report('initialize',MODEL.bytes);
            if(loadOptions.signal?.aborted){
                throw arcaneFailure('ARCANE_AI_REQUEST_ABORTED');
            }
            state='ready';
            progress=null;
            emit('statechange');
            return flatStatus();
        },
        async streamRequest(request){
            calls.requests.push(request);
            if(behavior.deferRequest){
                await new Promise((resolve,reject)=>{
                    const abort=()=>reject(arcaneFailure(
                        'ARCANE_AI_REQUEST_ABORTED',
                        'PRIVATE ABORT PROVIDER DETAIL'
                    ));
                    if(request.signal?.aborted)abort();
                    else request.signal?.addEventListener('abort',abort,{once:true});
                    calls.resolveRequest=resolve;
                });
            }
            if(request.signal?.aborted){
                throw arcaneFailure('ARCANE_AI_REQUEST_ABORTED');
            }
            request.onChunk?.('Hello locally.',`M-${request.id}`,false);
            request.onToolCall?.('show_greeting');
            return {show_greeting:'{"message":"Hello from Granite."}'};
        },
        async unload(){
            calls.unload+=1;
            state='unloaded';
            progress=null;
            emit('statechange');
            return flatStatus();
        },
        async dispose(){
            calls.dispose+=1;
            state='unloaded';
            progress=null;
            emit('statechange');
            return flatStatus();
        }
    };

    const store=Object.freeze({
        async remove(){ calls.storeRemove+=1; return true; }
    });

    function createSpeechProvider(role,providerOptions){
        let speechState='unloaded';
        let speechCacheState='unknown';
        let speechErrorCode=null;
        const provider={
            protocol:'arcane-ai-provider/2',
            role,
            id:providerOptions.id,
            localOnly:true,
            catalog(){
                return Object.freeze([Object.freeze({id:providerOptions.model.id})]);
            },
            inspect(){
                return Object.freeze({
                    available:true,
                    authority:Object.freeze({
                        providerId:providerOptions.id,
                        modelId:providerOptions.model.id,
                        localOnly:true
                    })
                });
            },
            status(){
                return Object.freeze({
                    role,
                    providerId:providerOptions.id,
                    modelId:providerOptions.model.id,
                    state:speechState,
                    loaded:speechState==='ready',
                    busy:false,
                    generation:1,
                    errorCode:speechErrorCode,
                    cache:speechCacheState,
                    security:Object.freeze({
                        secure:providerOptions.security.secure,
                        byteLength:false,
                        sha256:false
                    }),
                    integrity:Object.freeze({state:'unchecked'}),
                    warnings:Object.freeze([
                        'browser-speech-warn-first-secure-mode-disabled'
                    ])
                });
            },
            async load(loadOptions={}){
                calls.speechLoads.push({role,options:loadOptions,provider});
                speechState='loading';
                speechErrorCode=null;
                loadOptions.progress?.(Object.freeze({
                    phase:providerOptions.offline?'verify-cache':'download',
                    completed:4,
                    total:4,
                    unit:'bytes',
                    heartbeat:false
                }));
                if(behavior.speechOfflineMissRole===role&&providerOptions.offline){
                    speechState='error';
                    speechErrorCode='ARCANE_AI_ARTIFACT_OFFLINE_MISS';
                    throw arcaneFailure(
                        'ARCANE_AI_ARTIFACT_OFFLINE_MISS',
                        'PRIVATE SPEECH OFFLINE DETAIL'
                    );
                }
                if(loadOptions.signal?.aborted){
                    speechState='error';
                    speechErrorCode='ARCANE_AI_REQUEST_ABORTED';
                    throw arcaneFailure('ARCANE_AI_REQUEST_ABORTED');
                }
                speechCacheState=providerOptions.offline?'cached':'installed';
                speechState='ready';
                loadOptions.progress?.(Object.freeze({
                    phase:'ready',
                    completed:1,
                    total:1,
                    unit:'items',
                    heartbeat:true
                }));
                return provider.status();
            },
            async request(request){
                calls.speechRequests.push({role,request,provider});
                if(behavior.speechFailureRole===role){
                    throw arcaneFailure(
                        'ARCANE_AI_PROVIDER_REQUEST_FAILED',
                        'PRIVATE SPEECH PROVIDER DETAIL'
                    );
                }
                if(behavior.speechDeferRequest[role]){
                    await new Promise(function awaitSpeechAbort(resolve,reject){
                        function abortSpeechRequest(){
                            speechState='error';
                            speechErrorCode='ARCANE_AI_REQUEST_ABORTED';
                            reject(arcaneFailure(
                                'ARCANE_AI_REQUEST_ABORTED',
                                `PRIVATE ${role.toUpperCase()} ABORT DETAIL`
                            ));
                        }
                        if(request.signal?.aborted)abortSpeechRequest();
                        else request.signal?.addEventListener('abort',abortSpeechRequest,{once:true});
                        calls.resolveSpeechRequest[role]=resolve;
                    });
                }
                if(request.signal?.aborted){
                    throw arcaneFailure('ARCANE_AI_REQUEST_ABORTED');
                }
                if(role==='tts'){
                    return Object.freeze({
                        audio:new Uint8Array([82,73,70,70]),
                        contentType:'audio/wav'
                    });
                }
                return Object.freeze({text:'Hello from the selected audio file.'});
            },
            async unload(){
                calls.speechUnloads.push({role,provider});
                speechState='unloaded';
                speechErrorCode=null;
                return provider.status();
            },
            async dispose(){
                calls.speechDisposes.push({role,provider});
                speechState='unloaded';
                speechErrorCode=null;
                return provider.status();
            }
        };
        calls.speechProviders[role].push({options:providerOptions,provider});
        return Object.freeze(provider);
    }

    function createNormalizedAI({publishAIRuntimeRoleState}={}){
        const externalSelection=Object.freeze({
            providerId:'OPENAI',
            modelId:'OPENAI',
            localOnly:false
        });
        const routes={
            stt:{default:externalSelection,localOnly:null},
            tts:{default:externalSelection,localOnly:null}
        };
        const providers={stt:null,tts:null};
        const managed={stt:false,tts:false};
        const roleProgress={stt:null,tts:null};
        let activeConfiguration=null;
        let activeDescriptor=null;

        function selected(role,options={}){
            return options.localOnly===true
                ?routes[role].localOnly
                :routes[role].default;
        }

        function normalizedRoleStatus(role){
            const provider=providers[role];
            const selection=selected(role);
            const providerStatus=provider?.status();
            const roleState=providerStatus?.state??(selection?'unavailable':'unloaded');
            const errorCode=providerStatus?.errorCode??null;
            return Object.freeze({
                role,
                state:roleState,
                providerId:selection?.providerId??null,
                modelId:selection?.modelId??null,
                localOnly:selection?.localOnly??null,
                loaded:providerStatus?.loaded??false,
                busy:providerStatus?.busy??false,
                operationId:null,
                progress:roleProgress[role],
                error:roleState==='error'
                    ?Object.freeze({
                        code:errorCode??'ARCANE_AI_PROVIDER_REQUEST_FAILED',
                        message:'The selected test provider operation failed.'
                    })
                    :null
            });
        }

        function publishRole(role){
            publishAIRuntimeRoleState?.(role,normalizedRoleStatus(role));
        }

        const providerRuntime={
            selection: selected,
            configureSpeech(configuration){
                calls.configureSpeech.push(configuration);
                routes.stt=configuration.stt;
                routes.tts=configuration.tts;
                return configuration;
            },
            providerIdentity(role,providerId){
                const provider=providers[role];
                if(!provider||provider.id!==providerId)return null;
                return Object.freeze({
                    protocol:provider.protocol,
                    role,
                    id:provider.id,
                    localOnly:true
                });
            },
            status(role){ return normalizedRoleStatus(role); },
            catalog(role){
                const provider=providers[role];
                return provider
                    ?Object.freeze([Object.freeze({
                        providerId:provider.id,
                        localOnly:true,
                        models:provider.catalog()
                    })])
                    :Object.freeze([]);
            },
            async inspect(role){
                return providers[role]?.inspect()??Object.freeze({
                    available:false,
                    code:'ARCANE_AI_PROVIDER_UNAVAILABLE'
                });
            },
            async load(role,loadOptions={}){
                const provider=providers[role];
                if(!provider)throw arcaneFailure('ARCANE_AI_PROVIDER_UNAVAILABLE');
                const selection=selected(role,{localOnly:loadOptions.localOnly===true});
                try{
                    const result=await provider.load({
                        role,
                        selection,
                        signal:loadOptions.signal,
                        progress(value){
                            roleProgress[role]=value;
                            publishRole(role);
                        }
                    });
                    roleProgress[role]=null;
                    publishRole(role);
                    return result;
                }catch(error){
                    roleProgress[role]=null;
                    publishRole(role);
                    throw error;
                }
            },
            async unload(role,unloadOptions={}){
                const provider=providers[role];
                if(!provider)return normalizedRoleStatus(role);
                const result=await provider.unload({
                    role,
                    selection:selected(role),
                    signal:unloadOptions.signal
                });
                roleProgress[role]=null;
                publishRole(role);
                return result;
            },
            cancel(role){
                calls.speechRuntimeCancels.push(role);
                return true;
            },
            async request(role,requestOptions){
                const provider=providers[role];
                if(!provider)throw arcaneFailure('ARCANE_AI_PROVIDER_UNAVAILABLE');
                try{
                    const result=await provider.request({
                        role,
                        operation:requestOptions.operation,
                        selection:selected(role),
                        signal:requestOptions.signal,
                        payload:requestOptions.payload
                    });
                    publishRole(role);
                    return result;
                }catch(error){
                    publishRole(role);
                    throw error;
                }
            }
        };

        const normalized={
            providerRuntime,
            muted:true,
            get browserSpeechConfiguration(){ return activeConfiguration; },
            get browserSpeechDescriptor(){ return activeDescriptor; },
            async configureBrowserSpeech(configuration,configureOptions={}){
                const configuredRoles=['stt','tts'].filter(function hasConfiguredRole(role){
                    return Object.hasOwn(configuration,role);
                });
                const normalizedSpeechStore=Object.freeze({
                    kind:'fake-dbopfs-speech-artifact-store',
                    dbopfs:configuration.dbopfs
                });
                calls.speechStore.push({
                    dbopfs:configuration.dbopfs,
                    value:normalizedSpeechStore
                });
                const before=Object.freeze({
                    stt:selected('stt'),
                    tts:selected('tts')
                });
                for(const role of configuredRoles){
                    const roleConfiguration=configuration[role];
                    const oldProvider=providers[role];
                    const provider=createSpeechProvider(role,{
                        id:roleConfiguration.providerId,
                        model:roleConfiguration.model,
                        runtime:roleConfiguration.runtime,
                        security:roleConfiguration.security,
                        store:normalizedSpeechStore,
                        offline:roleConfiguration.offline
                    });
                    const selection=Object.freeze({
                        providerId:provider.id,
                        modelId:provider.catalog()[0].id,
                        localOnly:true
                    });
                    providers[role]=provider;
                    routes[role]=Object.freeze({default:selection,localOnly:selection});
                    managed[role]=true;
                    if(oldProvider)await oldProvider.dispose();
                    publishRole(role);
                }
                const merged={
                    protocol:configuration.protocol,
                    id:configuration.id,
                    dbopfs:configuration.dbopfs
                };
                const descriptor={
                    protocol:configuration.protocol,
                    configurationId:configuration.id,
                    stt:null,
                    tts:null
                };
                for(const role of ['stt','tts']){
                    if(!managed[role])continue;
                    const roleConfiguration=Object.hasOwn(configuration,role)
                        ?configuration[role]
                        :activeConfiguration?.[role];
                    merged[role]=roleConfiguration;
                    descriptor[role]=Object.freeze({
                        role,
                        providerId:providers[role].id,
                        modelId:providers[role].catalog()[0].id,
                        offline:roleConfiguration.offline,
                        ...(role==='tts'
                            ?{defaultVoice:roleConfiguration.model.defaultVoice}
                            :{})
                    });
                }
                activeConfiguration=Object.freeze(merged);
                activeDescriptor=Object.freeze(descriptor);
                calls.configureBrowserSpeech.push({
                    before,
                    configuration,
                    options:configureOptions,
                    descriptor:activeDescriptor
                });
                return activeDescriptor;
            },
            async setSpeechMuted(muted){
                normalized.muted=muted;
                if(muted){
                    await providerRuntime.unload('tts');
                }else{
                    await providerRuntime.load('tts');
                }
                return true;
            },
            async fetchTTS(payload,signal){
                const result=await providerRuntime.request('tts',{
                    operation:'synthesize',
                    payload:{
                        model:payload.model,
                        voice:activeConfiguration.tts.model.defaultVoice,
                        input:payload.input,
                        responseFormat:payload.responseFormat,
                        speed:payload.speed
                    },
                    localOnly:false,
                    signal
                });
                return new globalThis.Blob([result.audio],{type:result.contentType});
            },
            async fetchSTT(file,responseHandler,signal){
                const result=await providerRuntime.request('stt',{
                    operation:'transcribe',
                    payload:{
                        audio:file,
                        mimeType:file.type,
                        model:selected('stt').modelId
                    },
                    localOnly:false,
                    signal
                });
                const text=result.text;
                await responseHandler(text);
                return text;
            },
            async disposeBrowserSpeech(){
                calls.speechConfigurationDisposes+=1;
                for(const role of ['stt','tts']){
                    if(!managed[role])continue;
                    await providers[role].dispose();
                    providers[role]=null;
                    routes[role]=Object.freeze({default:null,localOnly:null});
                    managed[role]=false;
                }
                activeConfiguration=null;
                activeDescriptor=null;
                return true;
            }
        };
        return normalized;
    }

    return {
        behavior,
        calls,
        facade,
        createDbopfs(constructorOptions={}){
            const value={
                applicationId:constructorOptions.applicationId??'hello-world',
                readyPromise:Promise.resolve(),
                getTableHandle(){ return {}; }
            };
            calls.dbopfs.push({options:constructorOptions,value});
            return value;
        },
        createDbopfsModelStore(storeOptions){
            calls.store.push(storeOptions);
            return store;
        },
        createBrowserModelSource(descriptor){
            calls.modelSources.push(descriptor);
            return Object.freeze({descriptor});
        },
        createBrowserWasmLlmProvider(providerOptions){
            calls.provider.push(providerOptions);
            return Object.freeze({kind:'fake-browser-wasm-provider'});
        },
        createArcaneAI(createOptions){
            calls.createAI.push(createOptions);
            return facade;
        },
        createNormalizedAI,
        createDbopfsSpeechArtifactStore(storeOptions){
            calls.speechStore.push(storeOptions);
            return Object.freeze({kind:'fake-dbopfs-speech-artifact-store'});
        },
        createBrowserWhisperProvider(providerOptions){
            return createSpeechProvider('stt',providerOptions);
        },
        createBrowserKokoroProvider(providerOptions){
            return createSpeechProvider('tts',providerOptions);
        },
        createBrowserSpeechAuthority(authorityOptions){
            calls.speechAuthorityValidations.push(authorityOptions);
            if(!authorityOptions.model?.id||!authorityOptions.runtime?.entry){
                throw new TypeError('Invalid speech authority fixture.');
            }
            return Object.freeze({protocol:'arcane-ai-model-authority/1'});
        }
    };
}

function installGlobals(browser,aiRuntime,speechAuthorities){
    const names=[
        'Blob',
        'File',
        'URL',
        'location',
        'document',
        'localStorage',
        'Arcane',
        'arcaneThemeReady',
        'arcaneThemeAppearanceListener',
        '__arcaneHelloWorldAIHarness',
        '__arcaneHelloWorldSpeechAuthorities',
        'dbopfs',
        'fetch',
        'addEventListener',
        'removeEventListener'
    ];
    const previous=new Map(names.map(name=>[
        name,
        Object.getOwnPropertyDescriptor(globalThis,name)
    ]));
    for(const name of names)delete globalThis[name];
    Object.defineProperties(globalThis,{
        Blob:{value:browser.Blob,writable:true,configurable:true},
        File:{value:browser.File,writable:true,configurable:true},
        URL:{value:browser.URL,writable:true,configurable:true},
        location:{value:browser.location,writable:true,configurable:true},
        document:{value:browser.documentObject,writable:true,configurable:true},
        localStorage:{value:browser.storage,writable:true,configurable:true},
        __arcaneHelloWorldAIHarness:{value:aiRuntime,writable:true,configurable:true},
        __arcaneHelloWorldSpeechAuthorities:{
            value:speechAuthorities,
            writable:true,
            configurable:true
        },
        fetch:{
            value:function rejectUnexpectedFetch(){
                aiRuntime.calls.speechFetch+=1;
                return Promise.reject(new Error('Unexpected application fetch.'));
            },
            writable:true,
            configurable:true
        },
        addEventListener:{value:browser.addPageListener,writable:true,configurable:true},
        removeEventListener:{value:browser.removePageListener,writable:true,configurable:true}
    });
    return function restoreGlobals(){
        for(const name of names){
            const descriptor=previous.get(name);
            if(descriptor)Object.defineProperty(globalThis,name,descriptor);
            else delete globalThis[name];
        }
    };
}

async function runApplication(callback,{
    aiOptions={},
    speechAuthorities=EMPTY_SPEECH_AUTHORITIES
}={}){
    const temporaryRoot=await mkdtemp(path.join(tmpdir(),'arcane-hello-world-test-'));
    const appModules=path.join(temporaryRoot,'apps','hello-world','modules');
    const fakeRoot=path.join(temporaryRoot,'fakes');
    const arcaneRoot=await runtimeRoot();
    await Promise.all([
        cp(fileURLToPath(new URL('modules/',appRoot)),appModules,{recursive:true}),
        cp(fileURLToPath(new URL('modules/',arcaneRoot)),path.join(temporaryRoot,'arcane','modules'),{
            recursive:true
        }),
        cp(fileURLToPath(new URL('entities/',arcaneRoot)),path.join(temporaryRoot,'arcane','entities'),{
            recursive:true
        })
    ]);
    await mkdir(fakeRoot,{recursive:true});
    await writeFile(
        path.join(temporaryRoot,'package.json'),
        '{"type":"module"}\n',
        'utf8'
    );
    await writeFile(path.join(fakeRoot,'dbopfs.mjs'),`
const harness=globalThis.__arcaneHelloWorldAIHarness;
class DBOPFS {
    constructor(options={}){ return harness.createDbopfs(options); }
}
if(!globalThis.dbopfs?.getTableHandle){ globalThis.dbopfs=new DBOPFS(); }
export default DBOPFS;
`,'utf8');
    await writeFile(path.join(fakeRoot,'browser-ai.mjs'),`
const harness=globalThis.__arcaneHelloWorldAIHarness;
export const createDbopfsModelStore=options=>harness.createDbopfsModelStore(options);
export const createBrowserModelSource=descriptor=>harness.createBrowserModelSource(descriptor);
export const createBrowserWasmLlmProvider=options=>harness.createBrowserWasmLlmProvider(options);
export const createArcaneAI=options=>harness.createArcaneAI(options);
`,'utf8');
    await writeFile(path.join(fakeRoot,'arcane-ai.mjs'),`
import {publishAIRuntimeRoleState} from 'arcane/AIRuntimeState';
const harness=globalThis.__arcaneHelloWorldAIHarness;
export const AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL='arcane-ai-browser-speech-configuration/1';
export default class AI {
    constructor(){ return harness.createNormalizedAI({publishAIRuntimeRoleState}); }
}
`,'utf8');
    await writeFile(path.join(fakeRoot,'browser-speech.mjs'),`
const harness=globalThis.__arcaneHelloWorldAIHarness;
export const createDbopfsSpeechArtifactStore=options=>harness.createDbopfsSpeechArtifactStore(options);
export const createBrowserSpeechAuthority=options=>harness.createBrowserSpeechAuthority(options);
export const createBrowserWhisperProvider=options=>harness.createBrowserWhisperProvider(options);
export const createBrowserKokoroProvider=options=>harness.createBrowserKokoroProvider(options);
`,'utf8');
    await writeFile(path.join(fakeRoot,'speech-authorities.mjs'),`
export default globalThis.__arcaneHelloWorldSpeechAuthorities;
`,'utf8');

    const appPath=path.join(appModules,'App.js');
    const namedTargets=new Map([
        [
            'arcane/ThemeBootstrap',
            pathToFileURL(path.join(temporaryRoot,'arcane','modules','ThemeBootstrap.js')).href
        ],
        [
            'arcane/AppDataScope',
            pathToFileURL(path.join(temporaryRoot,'arcane','modules','AppDataScope.js')).href
        ],
        ['arcane/DBOPFS',pathToFileURL(path.join(fakeRoot,'dbopfs.mjs')).href],
        ['arcane/AI',pathToFileURL(path.join(fakeRoot,'arcane-ai.mjs')).href],
        [
            'arcane/AIRuntimeState',
            pathToFileURL(path.join(temporaryRoot,'arcane','modules','AIRuntimeState.js')).href
        ],
        ['arcane-os/event-manager',import.meta.resolve('arcane-os/event-manager')],
        ['arcane-os/ai/browser-wasm',pathToFileURL(path.join(fakeRoot,'browser-ai.mjs')).href],
        [
            'arcane-os/ai/browser-speech',
            pathToFileURL(path.join(fakeRoot,'browser-speech.mjs')).href
        ],
        [
            './SpeechAuthorities.js',
            pathToFileURL(path.join(fakeRoot,'speech-authorities.mjs')).href
        ]
    ]);
    const moduleHooks=registerHooks({
        resolve(specifier,context,nextResolve){
            const target=namedTargets.get(specifier);
            return target?{url:target,shortCircuit:true}:nextResolve(specifier,context);
        }
    });

    const browser=browserHarness();
    const aiRuntime=aiHarness(aiOptions);
    const restoreGlobals=installGlobals(browser,aiRuntime,speechAuthorities);
    try{
        await import(pathToFileURL(appPath).href);
        await new Promise(resolve=>setTimeout(resolve,0));
        return await callback({...browser,aiRuntime});
    }finally{
        await browser.triggerPage('pagehide');
        restoreGlobals();
        moduleHooks.deregister();
        await rm(temporaryRoot,{recursive:true,force:true});
    }
}

async function waitFor(predicate,label){
    for(let attempt=0;attempt<50;attempt+=1){
        if(predicate())return;
        await new Promise(resolve=>setTimeout(resolve,0));
    }
    assert.fail(`Timed out waiting for ${label}.`);
}

test('application shell installs its managed import map before every module',async function verifyImportMapOrder(){
    const [source,mapSource]=await Promise.all([
        readFile(new URL('index.html',appRoot),'utf8'),
        readFile(new URL('modules/arcane.importmap.json',appRoot),'utf8')
    ]);
    const theme=source.indexOf('./arcane/css/theme.css');
    const primitives=source.indexOf('./arcane/css/primitives.css');
    const appStyle=source.indexOf('./apps/hello-world/hello-world.css');
    const base=source.indexOf('<base href="../../">');
    const importMap=source.indexOf('data-arcane-import-map');
    const appModule=source.indexOf('<script type="module"');
    const managed=source.match(
        /<script type="importmap" data-arcane-import-map>\s*([\s\S]*?)\s*<\/script>/u
    );
    const parsed=JSON.parse(mapSource);

    assert.match(source,/<meta name="arcane-app-id" content="hello-world">/u);
    assert.ok(theme>=0&&primitives>theme&&appStyle>primitives);
    assert.ok(base>=0&&importMap>base&&appModule>importMap);
    assert.ok(managed);
    assert.deepEqual(Object.keys(parsed),['imports']);
    const importSpecifiers=Object.keys(parsed.imports);
    assert.deepEqual(importSpecifiers,[...importSpecifiers].sort());
    assert.equal(
        parsed.imports['arcane-os/ai/browser-speech'],
        './arcane/sdk/ai/browser-speech.mjs'
    );
    assert.equal(
        parsed.imports['arcane-os/ai/browser-wasm'],
        './arcane/sdk/ai/browser-wasm.mjs'
    );
    assert.deepEqual(JSON.parse(managed[1]),parsed);
    assert.equal(`${managed[1].trim()}\n`,mapSource);
    assert.doesNotMatch(source,/ThemeBootstrap[.]js[?]/u);
});

test('application package is browser-only with one explicit initial model origin',async function verifyPackageIdentity(){
    const [manifest,descriptor]=await Promise.all([
        readFile(new URL('arcane-package.json',appRoot),'utf8').then(JSON.parse),
        readFile(new URL('arcane-app.json',appRoot),'utf8').then(JSON.parse)
    ]);
    assert.equal(manifest.id,'hello-world');
    assert.equal(manifest.strategy,'static');
    assert.deepEqual(manifest.shared,['browser-runtime']);
    assert.equal(manifest.include.includes('img/icon.png'),false);
    assert.deepEqual(manifest.security.connectOrigins,['https://huggingface.co']);
    assert.deepEqual(descriptor.targets,['browser']);
    assert.deepEqual(descriptor.permissions,{capabilities:[],methods:[]});
    assert.deepEqual(descriptor.security.connectOrigins,['https://huggingface.co']);
    assert.equal(descriptor.native.icon,null);
});

test('workspace pins the published SDK and browser release workflow',async function verifyWorkspaceWorkflow(){
    const workspaceRoot=new URL('../../../',import.meta.url);
    const [packageJson,packageLock,lock,packager,readme]=await Promise.all([
        readFile(new URL('package.json',workspaceRoot),'utf8').then(JSON.parse),
        readFile(new URL('package-lock.json',workspaceRoot),'utf8').then(JSON.parse),
        readFile(new URL('arcane.lock.json',workspaceRoot),'utf8').then(JSON.parse),
        readFile(new URL('arcane-packager.json',workspaceRoot),'utf8').then(JSON.parse),
        readFile(new URL('README.md',workspaceRoot),'utf8')
    ]);
    assert.equal(packageJson.devDependencies['arcane-os'],'0.3.1');
    assert.equal(packageJson.engines.node,'>=22.23.2');
    assert.equal(packageLock.packages[''].devDependencies['arcane-os'],'0.3.1');
    assert.equal(packageLock.packages['node_modules/arcane-os'].version,'0.3.1');
    assert.equal(
        packageLock.packages['node_modules/arcane-os'].integrity,
        'sha512-g9C0cXK6Xim4Mu8D7zLKn3XErIo8UZEjIaGUA1fwnU6nVbB8XXgLD6/AjaVln+na6ihIHLzsHGgyTeic4yNggg=='
    );
    assert.equal(
        packageLock.packages['node_modules/arcane-os'].resolved,
        'https://registry.npmjs.org/arcane-os/-/arcane-os-0.3.1.tgz'
    );
    assert.equal(lock.sdk.version,'0.3.1');
    assert.equal(
        lock.runtime.contentSha256,
        '9ed39694d9f286e0994404a82fb6002c3ba48be0d085a6b68d51c7facc17c56f'
    );
    assert.equal(lock.runtime.upstreamCommit,'c540014afe69f14cf5ae60493b7295f36dbcec64');
    assert.equal(lock.sdkBrowserRuntime.sdkVersion,'0.3.1');
    assert.equal(
        lock.sdkBrowserRuntime.contentSha256,
        '1493497265c330507abed847e52e65dc2ce22c15efaf5646ed7ae544b107ad6f'
    );
    assert.equal(
        lock.sdkBrowserRuntime.manifestSha256,
        'fbb9cde052660d98f3bc1c15a5e85fe9ec3c9716b3f0f2d9d0b055ec20037410'
    );
    assert.deepEqual(
        Object.fromEntries([
            'import-map',
            'package',
            'verify',
            'bundle',
            'build',
            'run'
        ].map(name=>[name,packageJson.scripts[name]])),
        {
            'import-map':'arcane import-map',
            package:'arcane package',
            verify:'arcane verify',
            bundle:'arcane bundle',
            build:'arcane build --target browser',
            run:'arcane run --target browser'
        }
    );
    const runtimeRoutes=packager.sharedPayloads['browser-runtime'];
    assert.deepEqual(runtimeRoutes[0],{
        source:'arcane',
        destination:'arcane',
        include:['components','css','dependencies','entities','img','modules','sdk','security'],
        exclude:[]
    });
    assert.equal(
        runtimeRoutes.some(route=>route.destination==='node_modules/strong-type'),
        false
    );
    assert.match(readme,/runtime receipts enumerate\s+the authenticated projection/u);
    assert.match(readme,/generated import map is the authority/u);
    assert.match(readme,/listed by the release receipt/u);
    assert.doesNotMatch(readme,/173 files|86 entries/u);
    assert.match(readme,/does not create a\s+standalone native executable/u);
    assert.match(readme,/no artifact request starts\s+until its own load button is chosen/u);
    assert.match(readme,/`load\(\{offline:true\}\)` makes no\s+model-source request/u);
    assert.match(readme,/Packaged same-origin Wllama\/WASM\s+runtime assets may still load/u);
    assert.match(readme,/maps expected failures to stable codes/u);
    assert.match(readme,/initial\s+Hugging Face origin/u);
    assert.match(readme,/provider-controlled HTTPS redirect\s+chain/u);
    assert.doesNotMatch(readme,/`load\(\{offline:true\}\)` never fetches|regional CDN hostname[^.]*in `security[.]connectOrigins`/iu);
    assert.doesNotMatch(readme,/--arcane-root|source sync|SDK update poll/iu);
});

test('application demonstrates direct named Arcane and browser-AI imports',async function verifyNamedImports(){
    const [html,script,authorities]=await Promise.all([
        readFile(new URL('index.html',appRoot),'utf8'),
        readFile(new URL('modules/App.js',appRoot),'utf8'),
        readFile(new URL('modules/SpeechAuthorities.js',appRoot),'utf8')
    ]);
    assert.match(html,/Hello, Arcane World!/u);
    assert.match(html,/>Say hello<\/button>/u);
    assert.match(html,/Full SDK AI lifecycle/u);
    assert.match(html,/No model download has started/u);
    assert.match(html,/No external AI model or adapter artifact downloads at import time/u);
    assert.match(html,/1,998,371,424 bytes \(1[.]86 GiB\)/u);
    assert.match(html,/WebGPU-capable browser/u);
    assert.match(html,/maxlength="2000"/u);
    assert.match(html,/<h4>Proposed tool calls<\/h4>/u);
    assert.match(html,/Arcane ships no speech runtime bytes, model weights, or voices/u);
    assert.match(html,/never requests microphone access/u);
    assert.match(html,/Playback begins only when you use the audio controls/u);
    assert.match(html,/maxlength="500"/u);
    assert.match(html,/audio file up to 8 MiB/u);
    assert.match(script,/from 'arcane\/ThemeBootstrap'/u);
    assert.match(script,/from 'arcane\/AppDataScope'/u);
    assert.match(script,/from 'arcane\/DBOPFS'/u);
    assert.match(script,/from 'arcane\/AI'/u);
    assert.match(script,/from 'arcane\/AIRuntimeState'/u);
    assert.match(script,/from 'arcane-os\/ai\/browser-wasm'/u);
    assert.match(script,/from '[.]\/SpeechAuthorities[.]js'/u);
    assert.match(script,/loadPolicy:'manual'/u);
    assert.match(script,/localOnly:true/u);
    assert.match(script,/AI_SECURITY=Object[.]freeze\(\{secure:false\}\)/u);
    assert.match(script,/AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL/u);
    assert.match(script,/configureBrowserSpeech/u);
    assert.match(script,/localOnly:null/u);
    assert.match(script,/providerRuntime[.]load/u);
    assert.match(script,/providerRuntime[.]unload/u);
    assert.match(script,/disposeBrowserSpeech/u);
    assert.match(script,/toolChoice:'auto'/u);
    assert.match(script,/ARCANE_AI_MODEL_OFFLINE_MISS/u);
    assert.match(script,/HELLO_WORLD_SPEECH_AUTHORITY_REQUIRED/u);
    assert.match(script,/MAX_STT_FILE_BYTES=8[*]1024[*]1024/u);
    assert.match(script,/MAX_TTS_TEXT_LENGTH=500/u);
    assert.match(script,/MAX_LLM_PROMPT_LENGTH=2000/u);
    assert.match(script,/ARCANE_AI_WEBGPU_REQUIRED/u);
    assert.match(script,/without a model-source request/u);
    assert.match(script,/Packaged same-origin Wllama\/WASM assets may still load/u);
    assert.match(script,/Any admitted DBOPFS cache remains; interrupted downloads are discarded/u);
    assert.match(script,/Proposed tool calls \(structural output only\)/u);
    assert.match(script,/responseFormat:'wav'/u);
    assert.match(script,/fetchSTT/u);
    assert.doesNotMatch(script,/createBrowserWhisperProvider|createBrowserKokoroProvider|createDbopfsSpeechArtifactStore/u);
    assert.doesNotMatch(script,/gpuLayers/u);
    assert.doesNotMatch(script,/getUserMedia|mediaDevices|navigator[.]mediaDevices/iu);
    assert.doesNotMatch(script,/[.]play\s*\(/u);
    assert.doesNotMatch(`${html}\n${script}`,/Tool-call receipt|never executed|executes tool calls/iu);
    assert.doesNotMatch(script,/ThemeBootstrap[.]js|AppDataScope[.]js|DBOPFS[.]js/u);
    assert.doesNotMatch(script,/toolHandlers|executeTools|Date[.]now|SDK update/iu);
    assert.match(authorities,/stt:null/u);
    assert.match(authorities,/tts:null/u);
    assert.match(authorities,/adapter:'transformers-whisper'/u);
    assert.match(authorities,/adapter:'kokoro-js'/u);
    assert.doesNotMatch(authorities,/https:\/\//u);
});

test('browser mode persists a greeting without loading a model',async function verifyBrowserBehavior(){
    await runApplication(async({elements,values,aiRuntime})=>{
        const action=elements.get('#app-action');
        const status=elements.get('#app-status');

        assert.equal(aiRuntime.calls.load.length,0);
        assert.equal(aiRuntime.calls.requests.length,0);
        assert.equal(aiRuntime.calls.modelSources.length,0);
        assert.equal(aiRuntime.calls.speechStore.length,0);
        assert.equal(aiRuntime.calls.speechAuthorityValidations.length,0);
        assert.equal(aiRuntime.calls.speechProviders.tts.length,0);
        assert.equal(aiRuntime.calls.speechProviders.stt.length,0);
        assert.equal(aiRuntime.calls.speechFetch,0);
        await action.trigger('click');
        await action.trigger('click');
        assert.equal(values.get('arcane.apps.hello-world:hello-count'),'2');
        assert.equal(status.textContent,'Hello from Arcane OS! Greeting 2.');
        assert.equal(aiRuntime.calls.load.length,0);
        assert.match(
            elements.get('#speech-authority-status').textContent,
            /HELLO_WORLD_SPEECH_AUTHORITY_REQUIRED/u
        );
        assert.match(elements.get('#tts-lifecycle').textContent,/authority-required/u);
        assert.match(elements.get('#stt-lifecycle').textContent,/authority-required/u);
    });
});

test('malformed speech records map to the stable authority error before storage',async function verifyMalformedSpeechAuthority(){
    await runApplication(async function inspectMalformedSpeechAuthority({elements,aiRuntime}){
        await elements.get('#tts-load').trigger('click');
        await elements.get('#stt-load').trigger('click');

        assert.equal(aiRuntime.calls.speechAuthorityValidations.length,0);
        assert.equal(aiRuntime.calls.speechStore.length,0);
        assert.equal(aiRuntime.calls.speechProviders.tts.length,0);
        assert.equal(aiRuntime.calls.speechProviders.stt.length,0);
        assert.match(elements.get('#tts-status').textContent,/HELLO_WORLD_SPEECH_AUTHORITY_REQUIRED/u);
        assert.match(elements.get('#stt-status').textContent,/HELLO_WORLD_SPEECH_AUTHORITY_REQUIRED/u);
    },{speechAuthorities:Object.freeze({stt:Object.freeze({}),tts:Object.freeze({})})});
});

test('missing speech authority fails closed before storage or provider creation',async function verifyMissingSpeechAuthority(){
    await runApplication(async function inspectMissingSpeechAuthority({elements,aiRuntime}){
        await elements.get('#tts-load').trigger('click');
        await elements.get('#stt-load').trigger('click');

        assert.equal(aiRuntime.calls.speechStore.length,0);
        assert.equal(aiRuntime.calls.speechProviders.tts.length,0);
        assert.equal(aiRuntime.calls.speechProviders.stt.length,0);
        assert.equal(aiRuntime.calls.speechLoads.length,0);
        assert.equal(aiRuntime.calls.speechRequests.length,0);
        assert.equal(aiRuntime.calls.speechFetch,0);
        for(const selector of ['#tts-status','#stt-status']){
            const rendered=elements.get(selector).textContent;
            assert.match(rendered,/HELLO_WORLD_SPEECH_AUTHORITY_REQUIRED/u);
            assert.match(rendered,/Configure SpeechAuthorities[.]js before loading it/u);
            assert.doesNotMatch(rendered,/provider-private-message|PRIVATE/u);
        }
    });
});

test('speech inputs are bounded before provider dispatch',async function verifySpeechInputBounds(){
    await runApplication(async function inspectSpeechInputBounds({elements,aiRuntime}){
        await elements.get('#tts-load').trigger('click');
        await elements.get('#stt-load').trigger('click');

        elements.get('#tts-input').value='x'.repeat(501);
        await elements.get('#tts-synthesize').trigger('click');
        assert.match(
            elements.get('#tts-status').textContent,
            /HELLO_WORLD_TTS_TEXT_TOO_LONG/u
        );

        elements.get('#stt-file').files=[{
            name:'too-large.wav',
            size:(8*1024*1024)+1,
            type:'audio/wav'
        }];
        await elements.get('#stt-transcribe').trigger('click');
        assert.match(
            elements.get('#stt-status').textContent,
            /HELLO_WORLD_STT_FILE_TOO_LARGE/u
        );
        assert.equal(aiRuntime.calls.speechRequests.length,0);

        elements.get('#stt-file').files=[{
            name:'not-audio.txt',
            size:4,
            type:'text/plain'
        }];
        await elements.get('#stt-transcribe').trigger('click');
        assert.match(
            elements.get('#stt-status').textContent,
            /HELLO_WORLD_STT_MIME_TYPE_REQUIRED/u
        );
        assert.equal(aiRuntime.calls.speechRequests.length,0);
    },{speechAuthorities:TEST_SPEECH_AUTHORITIES});
});

test('configured speech roles use exact authority, selections, and file or WAV payloads',async function verifySpeechRequests(){
    await runApplication(async function inspectSpeechRequests({
        Blob,
        File,
        elements,
        urlCalls,
        aiRuntime
    }){
        assert.match(
            elements.get('#speech-authority-status').textContent,
            /Speech authorities configured/u
        );
        assert.equal(aiRuntime.calls.speechStore.length,0);

        await elements.get('#tts-load').trigger('click');
        await elements.get('#stt-load').trigger('click');

        assert.equal(aiRuntime.calls.speechStore.length,2);
        assert.equal(aiRuntime.calls.speechAuthorityValidations.length,0);
        assert.equal(aiRuntime.calls.speechStore[0].dbopfs.applicationId,'hello-world');
        assert.equal(aiRuntime.calls.speechStore[1].dbopfs.applicationId,'hello-world');
        assert.equal(aiRuntime.calls.speechProviders.tts.length,1);
        assert.equal(aiRuntime.calls.speechProviders.stt.length,1);
        assert.equal(aiRuntime.calls.configureSpeech.length,1);
        assert.equal(aiRuntime.calls.configureBrowserSpeech.length,2);
        const pendingRoutes=aiRuntime.calls.configureSpeech[0];
        assert.deepEqual(pendingRoutes.tts.default,{
            providerId:'hello-world-browser-kokoro',
            modelId:TEST_SPEECH_AUTHORITIES.tts.model.id,
            localOnly:null
        });
        assert.equal(pendingRoutes.tts.localOnly,null);
        assert.deepEqual(pendingRoutes.stt.default,{
            providerId:'OPENAI',
            modelId:'OPENAI',
            localOnly:false
        });
        const firstConfiguration=aiRuntime.calls.configureBrowserSpeech[0];
        assert.equal(firstConfiguration.before.tts.localOnly,null);
        assert.equal(firstConfiguration.before.stt.providerId,'OPENAI');
        const secondConfiguration=aiRuntime.calls.configureBrowserSpeech[1];
        assert.equal(secondConfiguration.before.tts.localOnly,true);
        assert.equal(secondConfiguration.before.stt.providerId,'OPENAI');
        assert.equal(secondConfiguration.descriptor.tts.providerId,'hello-world-browser-kokoro');
        assert.equal(secondConfiguration.descriptor.stt.providerId,'hello-world-browser-whisper');

        const ttsProvider=aiRuntime.calls.speechProviders.tts[0];
        const sttProvider=aiRuntime.calls.speechProviders.stt[0];
        assert.equal(ttsProvider.options.id,'hello-world-browser-kokoro');
        assert.equal(sttProvider.options.id,'hello-world-browser-whisper');
        for(const [role,record] of [['tts',ttsProvider],['stt',sttProvider]]){
            assert.equal('localOnly' in record.options,false);
            assert.deepEqual(record.options.security,{secure:false});
            assert.equal(record.options.model,TEST_SPEECH_AUTHORITIES[role].model);
            assert.equal(record.options.runtime,TEST_SPEECH_AUTHORITIES[role].runtime);
            assert.equal(record.options.offline,false);
            assert.match(
                elements.get(`#${role}-status`).textContent,
                /Warn-first mode/u
            );
        }
        assert.notEqual(ttsProvider.options.store,sttProvider.options.store);
        assert.equal(elements.get('#tts-progress').hidden,false);
        assert.equal(elements.get('#stt-progress').hidden,false);
        assert.match(elements.get('#tts-progress-label').textContent,/ready/u);
        assert.match(elements.get('#stt-progress-label').textContent,/ready/u);

        const ttsLoad=aiRuntime.calls.speechLoads.find(function findTtsLoad(entry){
            return entry.role==='tts';
        });
        const sttLoad=aiRuntime.calls.speechLoads.find(function findSttLoad(entry){
            return entry.role==='stt';
        });
        assert.deepEqual(ttsLoad.options.selection,{
            providerId:'hello-world-browser-kokoro',
            modelId:TEST_SPEECH_AUTHORITIES.tts.model.id,
            localOnly:true
        });
        assert.deepEqual(sttLoad.options.selection,{
            providerId:'hello-world-browser-whisper',
            modelId:TEST_SPEECH_AUTHORITIES.stt.model.id,
            localOnly:true
        });
        assert.equal(ttsLoad.options.signal,undefined);
        assert.ok(sttLoad.options.signal instanceof AbortSignal);
        assert.notEqual(ttsLoad.options.signal,sttLoad.options.signal);

        await elements.get('#tts-synthesize').trigger('click');
        const selectedFile=new File(
            [new Uint8Array([1,2,3,4])],
            'selected-audio.wav',
            {type:'audio/wav'}
        );
        elements.get('#stt-file').files=[selectedFile];
        await elements.get('#stt-transcribe').trigger('click');

        const ttsRequest=aiRuntime.calls.speechRequests.find(function findTtsRequest(entry){
            return entry.role==='tts';
        }).request;
        assert.equal(ttsRequest.role,'tts');
        assert.equal(ttsRequest.operation,'synthesize');
        assert.deepEqual(ttsRequest.selection,ttsLoad.options.selection);
        assert.deepEqual(ttsRequest.payload,{
            model:TEST_SPEECH_AUTHORITIES.tts.model.id,
            voice:TEST_SPEECH_AUTHORITIES.tts.model.defaultVoice,
            input:"Hello from Arcane's independent text-to-speech lifecycle.",
            responseFormat:'wav',
            speed:1
        });
        assert.ok(ttsRequest.signal instanceof AbortSignal);

        const audio=elements.get('#tts-audio');
        assert.equal(urlCalls.created.length,1);
        assert.ok(urlCalls.created[0].blob instanceof Blob);
        assert.equal(urlCalls.created[0].blob.type,'audio/wav');
        assert.ok(urlCalls.created[0].blob.parts[0] instanceof Uint8Array);
        assert.equal(audio.src,urlCalls.created[0].value);
        assert.equal(audio.hidden,false);
        assert.equal(audio.playCalls,0);

        const sttRequest=aiRuntime.calls.speechRequests.find(function findSttRequest(entry){
            return entry.role==='stt';
        }).request;
        assert.equal(sttRequest.role,'stt');
        assert.equal(sttRequest.operation,'transcribe');
        assert.deepEqual(sttRequest.selection,sttLoad.options.selection);
        assert.equal(sttRequest.payload.audio,selectedFile);
        assert.equal(sttRequest.payload.mimeType,'audio/wav');
        assert.equal(sttRequest.payload.model,TEST_SPEECH_AUTHORITIES.stt.model.id);
        assert.deepEqual(Object.keys(sttRequest.payload).sort(),['audio','mimeType','model']);
        assert.ok(sttRequest.signal instanceof AbortSignal);
        assert.equal(
            elements.get('#stt-transcript').textContent,
            'Hello from the selected audio file.'
        );
        assert.match(elements.get('#stt-status').textContent,/No microphone was opened or requested/u);
        await elements.get('#tts-unload').trigger('click');
        assert.deepEqual(urlCalls.revoked,[urlCalls.created[0].value]);
        assert.equal(audio.src,'');
        assert.equal(audio.hidden,true);
        assert.equal(audio.loadCalls,1);
        assert.match(elements.get('#stt-lifecycle').textContent,/ready/u);
        assert.equal(aiRuntime.calls.speechFetch,0);
    },{speechAuthorities:TEST_SPEECH_AUTHORITIES});
});

test('warn-first offline speech loads replace only the selected role over the app store',async function verifySpeechOfflineReconstruction(){
    await runApplication(async function inspectSpeechOfflineReconstruction({elements,aiRuntime}){
        for(const role of ['tts','stt']){
            await elements.get(`#${role}-load`).trigger('click');
            await elements.get(`#${role}-unload`).trigger('click');
            await elements.get(`#${role}-load-offline`).trigger('click');

            const records=aiRuntime.calls.speechProviders[role];
            assert.equal(records.length,2);
            assert.equal(records[0].options.offline,false);
            assert.equal(records[1].options.offline,true);
            assert.equal(records[0].options.id,records[1].options.id);
            assert.equal(records[0].options.model,records[1].options.model);
            assert.equal(records[0].options.runtime,records[1].options.runtime);
            assert.notEqual(records[0].options.store,records[1].options.store);
            assert.equal(records[0].options.security.secure,false);
            assert.equal(records[1].options.security.secure,false);
            assert.match(
                elements.get(`#${role}-status`).textContent,
                /upstream requests disabled/u
            );
        }

        assert.equal(aiRuntime.calls.speechStore.length,4);
        assert.equal(aiRuntime.calls.configureBrowserSpeech.length,4);
        assert.equal(aiRuntime.calls.speechUnloads.length,2);
        assert.equal(aiRuntime.calls.speechDisposes.length,2);
        assert.deepEqual(
            aiRuntime.calls.speechDisposes.map(function disposedRole(entry){
                return entry.role;
            }).sort(),
            ['stt','tts']
        );
        assert.equal(aiRuntime.calls.speechLoads.length,4);
        assert.equal(aiRuntime.calls.speechFetch,0);
    },{speechAuthorities:TEST_SPEECH_AUTHORITIES});
});

test('speech offline miss is stable and never exposes provider detail',async function verifySpeechOfflineMiss(){
    await runApplication(async function inspectSpeechOfflineMiss({elements,aiRuntime}){
        await elements.get('#stt-load-offline').trigger('click');

        const rendered=elements.get('#stt-status').textContent;
        assert.match(rendered,/ARCANE_AI_ARTIFACT_OFFLINE_MISS/u);
        assert.match(rendered,/No compatible offline speech cache is available/u);
        assert.doesNotMatch(rendered,/PRIVATE SPEECH OFFLINE DETAIL/u);
        assert.equal(aiRuntime.calls.speechProviders.stt[0].options.offline,true);
        assert.equal(aiRuntime.calls.speechFetch,0);
    },{
        aiOptions:{speechOfflineMissRole:'stt'},
        speechAuthorities:TEST_SPEECH_AUTHORITIES
    });
});

test('speech cancellation and unload remain independent by role',async function verifyIndependentSpeechLifecycle(){
    await runApplication(async function inspectIndependentSpeechLifecycle({File,elements,aiRuntime}){
        await elements.get('#tts-load').trigger('click');
        await elements.get('#stt-load').trigger('click');
        elements.get('#stt-file').files=[new File(
            [new Uint8Array([1,2,3,4])],
            'independent.wav',
            {type:'audio/wav'}
        )];

        aiRuntime.behavior.speechDeferRequest.tts=true;
        aiRuntime.behavior.speechDeferRequest.stt=true;
        const ttsOperation=elements.get('#tts-synthesize').trigger('click');
        const sttOperation=elements.get('#stt-transcribe').trigger('click');
        await waitFor(
            function bothSpeechRequestsStarted(){
                return aiRuntime.calls.speechRequests.length===2;
            },
            'independent TTS and STT requests'
        );

        const ttsRequest=aiRuntime.calls.speechRequests.find(function findTts(entry){
            return entry.role==='tts';
        }).request;
        const sttRequest=aiRuntime.calls.speechRequests.find(function findStt(entry){
            return entry.role==='stt';
        }).request;
        assert.notEqual(ttsRequest.signal,sttRequest.signal);
        assert.equal(ttsRequest.signal.aborted,false);
        assert.equal(sttRequest.signal.aborted,false);

        await elements.get('#tts-cancel').trigger('click');
        await ttsOperation;
        assert.equal(ttsRequest.signal.aborted,true);
        assert.equal(sttRequest.signal.aborted,false);
        assert.match(elements.get('#tts-status').textContent,/ARCANE_AI_REQUEST_ABORTED/u);
        assert.doesNotMatch(elements.get('#tts-status').textContent,/PRIVATE TTS ABORT DETAIL/u);
        assert.match(elements.get('#stt-lifecycle').textContent,/ready/u);

        await elements.get('#stt-cancel').trigger('click');
        await sttOperation;
        assert.equal(sttRequest.signal.aborted,true);
        assert.doesNotMatch(elements.get('#stt-status').textContent,/PRIVATE STT ABORT DETAIL/u);
        assert.deepEqual(aiRuntime.calls.speechRuntimeCancels,['tts','stt']);

        assert.match(elements.get('#tts-lifecycle').textContent,/error/u);
        assert.match(elements.get('#stt-lifecycle').textContent,/error/u);
        assert.equal(aiRuntime.calls.speechUnloads.length,0);
        assert.equal(aiRuntime.calls.speechDisposes.length,0);
        assert.equal(aiRuntime.calls.dispose,0);
        assert.equal(aiRuntime.calls.unload,0);
    },{speechAuthorities:TEST_SPEECH_AUTHORITIES});
});

test('speech provider failures render stable public copy only',async function verifySpeechErrorPrivacy(){
    await runApplication(async function inspectSpeechErrorPrivacy({elements}){
        await elements.get('#tts-load').trigger('click');
        await elements.get('#tts-synthesize').trigger('click');

        const rendered=elements.get('#tts-status').textContent;
        assert.match(rendered,/ARCANE_AI_PROVIDER_REQUEST_FAILED/u);
        assert.match(rendered,/could not complete the request/u);
        assert.doesNotMatch(rendered,/PRIVATE SPEECH PROVIDER DETAIL/u);
    },{
        aiOptions:{speechFailureRole:'tts'},
        speechAuthorities:TEST_SPEECH_AUTHORITIES
    });
});

test('online load authenticates the exact model and request stays local',async function verifyLocalAI(){
    await runApplication(async({elements,aiRuntime})=>{
        await elements.get('#ai-load').trigger('click');

        assert.deepEqual(aiRuntime.calls.modelSources,[MODEL]);
        assert.equal(aiRuntime.calls.store.length,1);
        assert.equal(aiRuntime.calls.store[0].dbopfs.applicationId,'hello-world');
        assert.equal(aiRuntime.calls.createAI.length,1);
        assert.equal(aiRuntime.calls.createAI[0].loadPolicy,'manual');
        assert.deepEqual(aiRuntime.calls.createAI[0].security,{secure:false});
        assert.deepEqual(aiRuntime.calls.provider[0].loadDefaults,{
            contextTokens:1024,
            threads:1,
            batchTokens:256,
            microBatchTokens:64
        });
        assert.equal('gpuLayers' in aiRuntime.calls.provider[0].loadDefaults,false);
        assert.equal(aiRuntime.calls.load.length,1);
        assert.equal(aiRuntime.calls.load[0].offline,false);
        assert.ok(aiRuntime.calls.load[0].signal instanceof AbortSignal);
        assert.equal(elements.get('#ai-progress').value,MODEL.bytes);
        assert.match(elements.get('#ai-status').textContent,/Warn-first mode/u);
        assert.match(elements.get('#ai-status').textContent,/checks were not requested/u);

        await elements.get('#ai-send').trigger('click');
        assert.equal(aiRuntime.calls.requests.length,1);
        const request=aiRuntime.calls.requests[0];
        assert.equal(request.id,'hello-world-1');
        assert.equal(request.localOnly,true);
        assert.ok(request.signal instanceof AbortSignal);
        assert.equal(request.tools.length,1);
        assert.equal(request.tools[0].function.name,'show_greeting');
        assert.equal('toolHandlers' in request,false);
        assert.equal('executeTools' in request,false);
        assert.equal(elements.get('#ai-response').textContent,'Hello locally.');
        assert.match(elements.get('#ai-tool-calls').textContent,/Proposed tool calls \(structural output only\)/u);
        assert.match(elements.get('#ai-tool-calls').textContent,/show_greeting/u);
        assert.match(elements.get('#ai-tool-calls').textContent,/Hello from Granite/u);
        assert.equal(aiRuntime.calls.storeRemove,0);
    });
});

test('LLM prompts are bounded before tokenization and provider dispatch',async function verifyLlmInputBound(){
    await runApplication(async function inspectLlmInputBound({elements,aiRuntime}){
        await elements.get('#ai-load').trigger('click');
        elements.get('#ai-prompt').value='x'.repeat(2001);
        await elements.get('#ai-send').trigger('click');

        assert.equal(aiRuntime.calls.requests.length,0);
        assert.match(
            elements.get('#ai-status').textContent,
            /HELLO_WORLD_LLM_PROMPT_TOO_LONG/u
        );
    });
});

test('offline load reuses a compatible cache without a model-source request',async function verifyOfflineLoad(){
    await runApplication(async({elements,aiRuntime})=>{
        await elements.get('#ai-load-offline').trigger('click');
        assert.equal(aiRuntime.calls.load.length,1);
        assert.equal(aiRuntime.calls.load[0].offline,true);
        assert.match(elements.get('#ai-status').textContent,/without a model-source request/u);
        assert.equal(aiRuntime.calls.storeRemove,0);
    });
});

test('offline miss renders stable copy without leaking provider detail',async function verifyOfflineMiss(){
    await runApplication(async({elements,aiRuntime})=>{
        await elements.get('#ai-load-offline').trigger('click');
        const rendered=elements.get('#ai-status').textContent;
        assert.match(rendered,/ARCANE_AI_MODEL_OFFLINE_MISS/u);
        assert.match(rendered,/No compatible offline LLM cache is available/u);
        assert.doesNotMatch(rendered,/PRIVATE OFFLINE PROVIDER DETAIL/u);
        assert.equal(aiRuntime.calls.storeRemove,0);
    },{aiOptions:{offlineMiss:true}});
});

test('cancel aborts a pending local request with stable copy',async function verifyCancellation(){
    await runApplication(async({elements,aiRuntime})=>{
        await elements.get('#ai-load').trigger('click');
        aiRuntime.behavior.deferRequest=true;
        const requestOperation=elements.get('#ai-send').trigger('click');
        await waitFor(()=>aiRuntime.calls.requests.length===1,'pending AI request');
        const signal=aiRuntime.calls.requests[0].signal;
        assert.equal(signal.aborted,false);
        await elements.get('#ai-cancel').trigger('click');
        await requestOperation;
        assert.equal(signal.aborted,true);
        const rendered=elements.get('#ai-status').textContent;
        assert.match(rendered,/ARCANE_AI_REQUEST_ABORTED/u);
        assert.match(rendered,/Any admitted DBOPFS cache remains/u);
        assert.match(rendered,/interrupted downloads are discarded/u);
        assert.doesNotMatch(rendered,/partial bytes were removed/u);
        assert.doesNotMatch(rendered,/PRIVATE ABORT PROVIDER DETAIL/u);
    });
});

test('unload and page exit release runtime state but never delete cache',async function verifyLifecycle(){
    await runApplication(async({elements,aiRuntime,triggerPage})=>{
        await elements.get('#ai-load').trigger('click');
        await elements.get('#ai-unload').trigger('click');
        assert.equal(aiRuntime.calls.unload,1);
        assert.match(elements.get('#ai-status').textContent,/browser model Worker is no longer active/u);
        assert.match(elements.get('#ai-status').textContent,/stored DBOPFS cache remains/u);
        assert.equal(aiRuntime.calls.storeRemove,0);

        await elements.get('#ai-load').trigger('click');
        aiRuntime.behavior.deferRequest=true;
        const requestOperation=elements.get('#ai-send').trigger('click');
        await waitFor(()=>aiRuntime.calls.requests.length===1,'page-exit AI request');
        const signal=aiRuntime.calls.requests[0].signal;
        await triggerPage('pagehide');
        await requestOperation;
        await waitFor(()=>aiRuntime.calls.dispose===1,'AI dispose');
        assert.equal(signal.aborted,true);
        assert.equal(aiRuntime.calls.dispose,1);
        assert.equal(aiRuntime.calls.storeRemove,0);
    });
});

test('page exit aborts and disposes all three roles and revokes generated audio',async function verifyFullPageLifecycle(){
    await runApplication(async function inspectFullPageLifecycle({
        File,
        elements,
        location,
        triggerPage,
        urlCalls,
        aiRuntime
    }){
        await elements.get('#ai-load').trigger('click');
        await elements.get('#tts-load').trigger('click');
        await elements.get('#stt-load').trigger('click');
        await elements.get('#tts-synthesize').trigger('click');
        assert.equal(urlCalls.created.length,1);
        const audioUrl=urlCalls.created[0].value;

        elements.get('#stt-file').files=[new File(
            [new Uint8Array([1,2,3,4])],
            'page-exit.wav',
            {type:'audio/wav'}
        )];
        aiRuntime.behavior.deferRequest=true;
        aiRuntime.behavior.speechDeferRequest.tts=true;
        aiRuntime.behavior.speechDeferRequest.stt=true;

        const llmOperation=elements.get('#ai-send').trigger('click');
        const ttsOperation=elements.get('#tts-synthesize').trigger('click');
        const sttOperation=elements.get('#stt-transcribe').trigger('click');
        await waitFor(
            function allRoleRequestsStarted(){
                return aiRuntime.calls.requests.length===1
                    &&aiRuntime.calls.speechRequests.length===3;
            },
            'pending LLM, TTS, and STT requests'
        );

        const llmSignal=aiRuntime.calls.requests[0].signal;
        const pendingTts=aiRuntime.calls.speechRequests.filter(function selectTts(entry){
            return entry.role==='tts';
        })[1].request;
        const pendingStt=aiRuntime.calls.speechRequests.find(function selectStt(entry){
            return entry.role==='stt';
        }).request;
        assert.equal(llmSignal.aborted,false);
        assert.equal(pendingTts.signal.aborted,false);
        assert.equal(pendingStt.signal.aborted,false);

        await triggerPage('pagehide');
        await Promise.all([llmOperation,ttsOperation,sttOperation]);
        await waitFor(
            function everyRoleDisposed(){
                return aiRuntime.calls.dispose===1
                    &&aiRuntime.calls.speechDisposes.length===2
                    &&aiRuntime.calls.speechConfigurationDisposes===1;
            },
            'all AI role disposals'
        );

        assert.equal(llmSignal.aborted,true);
        assert.equal(pendingTts.signal.aborted,true);
        assert.equal(pendingStt.signal.aborted,true);
        assert.equal(aiRuntime.calls.dispose,1);
        assert.equal(aiRuntime.calls.speechConfigurationDisposes,1);
        assert.deepEqual(
            aiRuntime.calls.speechDisposes.map(function disposedRole(entry){
                return entry.role;
            }).sort(),
            ['stt','tts']
        );
        assert.deepEqual(urlCalls.revoked,[audioUrl]);
        assert.equal(elements.get('#tts-audio').src,'');
        assert.equal(elements.get('#tts-audio').pauseCalls,1);
        assert.equal(elements.get('#tts-audio').loadCalls,1);
        assert.equal(elements.get('#tts-audio').playCalls,0);
        assert.equal(aiRuntime.calls.storeRemove,0);
        assert.equal(aiRuntime.calls.speechFetch,0);
        await triggerPage('pageshow',{persisted:true});
        assert.equal(location.reloadCalls,1);
    },{speechAuthorities:TEST_SPEECH_AUTHORITIES});
});

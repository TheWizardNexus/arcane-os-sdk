import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import test from '../src/testing.mjs';
import {
    applyAIResponseLength,
    AI_RESPONSE_LENGTH_DEFAULT,
    aiResponseLengthInstruction,
    normalizeAIResponseLength
} from '../runtime/arcane/modules/AIResponseLength.js';
import {
    getCoreLocalModelCatalog,
    getCoreLocalModelCatalogWithAdmissionFailures,
    getCoreLocalSpeechAvailability,
    isUserManagedLoopbackLocalAIStatus,
    USER_MANAGED_LOOPBACK_PROVIDER_MODE
} from '../runtime/arcane/modules/CoreLocalModelCatalog.js';
import {
    isOllamaModelIdentifier,
    normalizeOllamaModelIdentifier
} from '../runtime/arcane/modules/OllamaModelIdentifier.js';
import {
    AI_RUNTIME_INTENT_EVENT,
    AI_RUNTIME_PROTOCOL,
    AI_RUNTIME_ROLES,
    AI_RUNTIME_STARTUP_EVENT,
    AI_RUNTIME_STATE_EVENT,
    AI_RUNTIME_STATES,
    aiRuntimeEvents,
    getAIRuntimeState,
    publishAIRuntimeRoleState,
    requestAIRuntimeIntent,
    startAIRuntime,
    subscribeAIRuntimeIntents,
    subscribeAIRuntimeState
} from '../runtime/arcane/modules/AIRuntimeState.js';
import {
    AI_MODEL_AUTHORITY_PROTOCOL,
    AI_PROVIDER_PROTOCOL,
    AI_PROVIDER_RUNTIME_PROTOCOL,
    AIProviderRuntime,
    getAIProviderRuntime
} from '../runtime/arcane/modules/AIProviderRuntime.js';
import {
    availabilityFromReport
} from '../runtime/arcane/modules/LocalAIReadinessController.js';
import {
    createSTTActivationController
} from '../runtime/arcane/modules/ComponentContracts.js';
import ConfiguredAIChatSession from '../runtime/arcane/modules/ConfiguredAIChatSession.js';

const repositoryRoot=new URL('../',import.meta.url);

test(
    'local readiness availability is fail-closed and grants no provider readiness',
    function testFailClosedLocalAIAvailability() {
        const empty=availabilityFromReport({});
        assert.deepEqual(empty,{llm:false,stt:false,tts:false});
        assert.equal(Object.isFrozen(empty),true);
        assert.deepEqual(
            availabilityFromReport({
                slots:{
                    llm:{required:false,ready:true},
                    stt:{required:false,ready:null},
                    tts:{required:true,ready:false}
                }
            }),
            {llm:false,stt:false,tts:false}
        );
        assert.deepEqual(
            availabilityFromReport({
                slots:{
                    llm:{required:true,ready:true},
                    stt:{required:true,ready:true},
                    tts:{required:true,ready:true}
                }
            }),
            {llm:true,stt:true,tts:true}
        );
    }
);

const readyEvents=[];
const previousDispatchEvent=globalThis.dispatchEvent;
globalThis.dispatchEvent=event=>{
    readyEvents.push(event);
    return true;
};
const {
    default:ollama,
    Ollama,
    ollama:exportedOllama
}=await import('../runtime/arcane/modules/Ollama.js?runtime-api-behavior');
if(previousDispatchEvent===undefined)delete globalThis.dispatchEvent;
else globalThis.dispatchEvent=previousDispatchEvent;

function installOllamaBridge(client){
    globalThis.Arcane={ollama:client};
}

function runtimeRoleState(role, overrides = {}) {
    return {
        role,
        state: 'unavailable',
        providerId: null,
        modelId: null,
        localOnly: null,
        loaded: false,
        busy: false,
        operationId: null,
        progress: null,
        error: null,
        ...overrides
    };
}

test('configured chat accepts bounded initial history and keeps request context transient',async()=>{
    const requests=[];
    const controller=new AbortController();
    const session=new ConfiguredAIChatSession({
        chat:async request=>{
            requests.push(request);
            return {message:{role:'assistant',content:'current response'}};
        },
        contextBuilder:async({signal})=>{
            assert.equal(signal,controller.signal);
            return 'request-only context';
        },
        initialMessages:[
            {role:'user',content:'prior request'},
            {role:'assistant',content:'prior response'},
        ],
    });
    await session.send('current request',{signal:controller.signal});
    assert.ok(requests[0].messages.some(message=>message.content==='prior request'));
    assert.ok(requests[0].messages.some(message=>String(message.content).includes('request-only context')));
    assert.ok(!session.history().some(message=>String(message.content).includes('request-only context')));

    const aborted=new AbortController();
    aborted.abort();
    await assert.rejects(
        session.send('never sent',{signal:aborted.signal}),
        error=>error?.code==='AI_CHAT_ABORTED',
    );
});

test('configured chat round-trips structural tool context and keeps prepared turns rollback-safe',async()=>{
    const requests=[];
    const session=new ConfiguredAIChatSession({
        chat:async request=>{
            requests.push(structuredClone(request));
            return {message:{role:'assistant',content:'tool result accepted'}};
        },
        initialMessages:[
            {role:'user',content:'lookup alpha'},
            {
                role:'assistant',
                content:'',
                tool_calls:[{
                    id:'lookup-1',
                    type:'function',
                    function:{name:'lookup',arguments:'{"id":"alpha"}'},
                }],
            },
        ],
        maxMessageCharacters:256,
    });
    const prepared=await session.prepare({
        role:'tool',
        content:'{"title":"Alpha"}',
        tool_call_id:'lookup-1',
    });
    assert.equal(requests[0].messages.at(-2).tool_calls[0].id,'lookup-1');
    assert.equal(requests[0].messages.at(-1).role,'tool');
    prepared.rollback();
    assert.ok(!session.history().some(message=>message.role==='tool'));
    await assert.rejects(
        session.send('skip the pending tool'),
        error=>error?.code==='AI_CHAT_TOOL_RESULT_REQUIRED',
    );

    assert.throws(
        ()=>new ConfiguredAIChatSession({
            initialMessages:[
                {role:'user',content:'invoke tools'},
                {
                    role:'assistant',
                    content:'',
                    tool_calls:[
                        {id:'one',type:'function',function:{name:'lookup',arguments:'{}'}},
                        {id:'two',type:'function',function:{name:'lookup',arguments:'{}'}},
                    ],
                },
            ],
        }),
        /exactly one structural tool call/u,
    );

    const prefixed=new ConfiguredAIChatSession({
        chat:async()=>({message:{role:'assistant',content:'unused'}}),
        contextBuilder:async()=>'.'.repeat(256),
        maxMessageCharacters:256,
    });
    await assert.rejects(
        prefixed.send('context overflow'),
        error=>error?.code==='AI_CHAT_CONTEXT_LIMIT',
    );
});

test('configured chat normalizes one fail-closed OpenAI-compatible completion',async()=>{
    const providerCompletion=Object.freeze({
        provider:'OPENAI',
        model:'gpt-compatible',
        choices:Object.freeze([
            Object.freeze({
                index:0,
                message:Object.freeze({
                    role:'assistant',
                    content:null,
                    tool_calls:Object.freeze([
                        Object.freeze({
                            id:'lookup-1',
                            type:'function',
                            function:Object.freeze({
                                name:'lookup',
                                arguments:'{"id":"alpha"}'
                            })
                        })
                    ])
                }),
                finish_reason:'tool_calls'
            })
        ]),
        usage:Object.freeze({prompt_tokens:12,completion_tokens:7,total_tokens:19})
    });
    const session=new ConfiguredAIChatSession({chat:async()=>providerCompletion});
    const response=await session.send('Find alpha');
    assert.deepEqual(response,{
        provider:'OPENAI',
        model:'gpt-compatible',
        message:{
            role:'assistant',
            content:'',
            tool_calls:[{
                id:'lookup-1',
                type:'function',
                function:{name:'lookup',arguments:'{"id":"alpha"}'}
            }]
        },
        done:true,
        doneReason:'tool_calls',
        promptEvalCount:12,
        evalCount:7
    });
    assert.equal(Object.isFrozen(response),true);
    assert.equal(Object.isFrozen(response.message),true);
    assert.equal(session.history().at(-1).tool_calls[0].id,'lookup-1');

    for(const invalid of [
        {choices:[]},
        {choices:[{index:0,message:{role:'user',content:'wrong role'}}]},
        {choices:[
            {index:0,message:{role:'assistant',content:'one'}},
            {index:1,message:{role:'assistant',content:'two'}}
        ]},
        {choices:[{index:0,message:{role:'assistant',content:'',tool_calls:[]}}]},
        {choices:[{index:0,message:{role:'assistant',content:'ok'}}],usage:{prompt_tokens:-1}}
    ]){
        const rejected=new ConfiguredAIChatSession({chat:async()=>invalid});
        await assert.rejects(
            rejected.send('Reject malformed completion'),
            error=>error?.code==='AI_CHAT_INVALID_RESPONSE'
        );
        assert.deepEqual(rejected.history(),[]);
    }

    const providerFailure=new Error('Provider rejected the request.');
    providerFailure.code='AI_PROVIDER_REJECTED';
    const rejected=new ConfiguredAIChatSession({
        chat:async()=>{throw providerFailure;}
    });
    await assert.rejects(rejected.send('Preserve provider error'),providerFailure);

    const cancellation=new AbortController();
    const cancellable=new ConfiguredAIChatSession({
        chat:async({signal})=>new Promise((_resolve,reject)=>{
            signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
        })
    });
    const pending=cancellable.send('Cancel provider request',{signal:cancellation.signal});
    cancellation.abort(new Error('Caller cancelled.'));
    await assert.rejects(pending,error=>error?.code==='AI_CHAT_ABORTED');
    assert.deepEqual(cancellable.history(),[]);
});

test('the Arcane Ollama module publishes one immutable complete browser surface',()=>{
    assert.equal(ollama,exportedOllama);
    assert.ok(ollama instanceof Ollama);
    assert.ok(Object.isFrozen(ollama));
    assert.deepEqual(
        Object.getOwnPropertyNames(Ollama.prototype).sort(),
        [
            'chat','chatText','constructor','copy','create','createBrain','delete',
            'embed','generate','generateText','list','models','pull','push',
            'readiness','running','saveServiceSettings','saveSettings','select',
            'selection','serviceSettings','settings','show','unload','version'
        ].sort()
    );

    const descriptor=Object.getOwnPropertyDescriptor(globalThis,'arcaneOllama');
    assert.deepEqual(
        {
            value:descriptor.value,
            enumerable:descriptor.enumerable,
            configurable:descriptor.configurable,
            writable:descriptor.writable
        },
        {value:ollama,enumerable:true,configurable:false,writable:false}
    );
    assert.equal(readyEvents.length,1);
    assert.equal(readyEvents[0].type,'arcane-ollama-ready');
    assert.equal(readyEvents[0].detail.ollama,ollama);
});

test('every raw Ollama wrapper preserves exact arguments and provider-native results',()=>{
    const result=Object.freeze({
        done:true,
        providerExtension:{thinking:'preserved'},
        unknownFutureField:['preserved']
    });
    const calls=[];
    installOllamaBridge(new Proxy({}, {
        get(_target,property){
            return (...arguments_)=>{
                calls.push({property,arguments_});
                return result;
            };
        }
    }));

    const objectA={a:1};
    const objectB={b:2};
    const objectC={c:3};
    const cases=[
        ['version','version',[]],
        ['models','models',[]],
        ['list','models',[]],
        ['running','running',[]],
        ['show','show',['model:latest',objectA]],
        ['generate','generate',[objectA,objectB]],
        ['chat','chat',[objectA,objectB]],
        ['embed','embed',[objectA]],
        ['pull','pull',['model:latest',objectA,objectB]],
        ['push','push',['model:latest',objectA,objectB]],
        ['create','create',[objectA,objectB]],
        ['copy','copy',['source:latest','destination:latest']],
        ['delete','delete',['model:latest']],
        ['selection','selection',[]],
        ['select','select',[objectA]],
        ['settings','settings',[]],
        ['saveSettings','saveSettings',[objectA]],
        ['createBrain','createBrain',[objectA]],
        ['serviceSettings','serviceSettings',[]],
        ['saveServiceSettings','saveServiceSettings',[objectC]]
    ];

    for(const [wrapper,bridgeMethod,arguments_] of cases){
        calls.length=0;
        assert.equal(ollama[wrapper](...arguments_),result,wrapper);
        assert.equal(calls.length,1,wrapper);
        assert.equal(calls[0].property,bridgeMethod,wrapper);
        assert.equal(calls[0].arguments_.length,arguments_.length,wrapper);
        for(let index=0;index<arguments_.length;index+=1){
            assert.equal(calls[0].arguments_[index],arguments_[index],`${wrapper} argument ${index}`);
        }
    }
});

test('Ollama bridge absence fails synchronously before any provider fallback',()=>{
    delete globalThis.Arcane;
    assert.throws(
        ()=>ollama.version(),
        error=>error?.code==='ARCANE_OLLAMA_UNAVAILABLE'
            &&/Open this app through Arcane OS/u.test(error.message)
    );
});

test('Ollama convenience helpers normalize only their documented result fields',async t=>{
    await t.test('readiness accepts object and string versions and freezes its snapshots',async()=>{
        installOllamaBridge({version:async()=>({version:' 0.6.8 '})});
        const objectResult=await ollama.readiness();
        assert.deepEqual(objectResult,{ready:true,version:'0.6.8',errorCode:null});
        assert.ok(Object.isFrozen(objectResult));

        installOllamaBridge({version:async()=>' 0.7.0 '});
        const stringResult=await ollama.readiness();
        assert.deepEqual(stringResult,{ready:true,version:'0.7.0',errorCode:null});
        assert.ok(Object.isFrozen(stringResult));
    });

    await t.test('readiness reduces failures to one stable error code',async()=>{
        installOllamaBridge({
            version:async()=>{
                throw Object.assign(new Error('private provider detail'),{
                    code:'LOCAL_OLLAMA_REQUEST_FAILED'
                });
            }
        });
        const result=await ollama.readiness();
        assert.deepEqual(result,{
            ready:false,
            version:null,
            errorCode:'LOCAL_OLLAMA_REQUEST_FAILED'
        });
        assert.ok(Object.isFrozen(result));
    });

    await t.test('text helpers preserve argument identity and return only text',async()=>{
        const request={model:'model:latest'};
        const options={signal:new AbortController().signal};
        installOllamaBridge({
            generate:async(actualRequest,actualOptions)=>{
                assert.equal(actualRequest,request);
                assert.equal(actualOptions,options);
                return {response:42,context:[1,2,3]};
            },
            chat:async(actualRequest,actualOptions)=>{
                assert.equal(actualRequest,request);
                assert.equal(actualOptions,options);
                return {message:{content:'hello',tool_calls:[{name:'example'}]}};
            }
        });
        assert.equal(await ollama.generateText(request,options),'42');
        assert.equal(await ollama.chatText(request,options),'hello');
    });

    await t.test('text helpers map missing and falsy nonstring fields to empty text',async()=>{
        for(const value of [undefined,null,false,0]){
            installOllamaBridge({
                generate:async()=>({response:value}),
                chat:async()=>({message:{content:value}})
            });
            assert.equal(await ollama.generateText({model:'model:latest'}),'');
            assert.equal(await ollama.chatText({model:'model:latest'}),'');
        }
    });

    await t.test('unload translates to one exact generate request',async()=>{
        const rawResult={done:true,providerField:'preserved'};
        installOllamaBridge({
            generate(request,options){
                assert.deepEqual(request,{
                    model:'model:latest',
                    prompt:'',
                    keep_alive:0
                });
                assert.equal(options,undefined);
                return rawResult;
            }
        });
        assert.equal(await ollama.unload('model:latest'),rawResult);
    });
});

test('renderer model identifiers enforce their exact bounded contract',()=>{
    const maximumBase='a'.repeat(192);
    const maximumTag='b'.repeat(64);
    for(const value of [
        'model','namespace/model:latest',`${maximumBase}:${maximumTag}`
    ]){
        assert.equal(normalizeOllamaModelIdentifier(value),value);
        assert.equal(isOllamaModelIdentifier(value),true);
    }
    for(const value of [
        '',null,' model','model ','OPENAI','openai','model:',
        'alpha:beta:tag',`${maximumBase}a`,`${maximumBase}:${maximumTag}b`
    ]){
        assert.equal(normalizeOllamaModelIdentifier(value),null);
        assert.equal(isOllamaModelIdentifier(value),false);
    }
});

test('Core local-model helpers preserve admission truth without granting authority',()=>{
    assert.equal(
        isUserManagedLoopbackLocalAIStatus({
            schemaVersion:2,
            providerMode:USER_MANAGED_LOOPBACK_PROVIDER_MODE
        }),
        true
    );
    assert.equal(
        isUserManagedLoopbackLocalAIStatus({
            schemaVersion:1,
            providerMode:USER_MANAGED_LOOPBACK_PROVIDER_MODE
        }),
        false
    );

    const catalog=getCoreLocalModelCatalog({
        models:{ollama:[{id:'model:latest',name:'Model:latest'}]}
    });
    assert.deepEqual(catalog,[{
        providerValue:'OLLAMA',
        preferenceValue:'model:latest',
        modelId:'model:latest',
        label:'Model:latest'
    }]);
    assert.ok(Object.isFrozen(catalog));
    assert.ok(Object.isFrozen(catalog[0]));

    const admission=getCoreLocalModelCatalogWithAdmissionFailures({
        ollama:{activeParallelRequests:3},
        models:{ollama:[]},
        admission:{rejected:[{
            id:'large:latest',
            name:'Large:latest',
            runnable:false,
            compatibility:{
                code:'MODEL_ADMISSION_MEMORY_INSUFFICIENT',
                maxAllowedParallelRequests:1
            }
        }]}
    });
    assert.equal(admission.length,1);
    assert.equal(admission[0].disabled,true);
    assert.equal(admission[0].status,'rejected');
    assert.equal(admission[0].admissionCode,'MODEL_ADMISSION_MEMORY_INSUFFICIENT');
    assert.equal(admission[0].reason,'active 3; max 1 parallel request');

    assert.throws(
        ()=>getCoreLocalModelCatalogWithAdmissionFailures({
            models:{ollama:[{id:'MODEL:latest',name:'MODEL:latest'}]},
            admission:{rejected:[{id:'model:latest',name:'model:latest'}]}
        }),
        /duplicate local-model identifier/u
    );
});

test('Core speech projection requires both role health and bounded catalog evidence',()=>{
    const result=getCoreLocalSpeechAvailability({
        speech:{transcriptionAvailable:true,synthesisAvailable:true},
        models:{
            transcription:[{
                id:'whisper',name:'Whisper',provider:'speech',roles:['stt'],available:true
            }],
            speech:[{
                id:'kokoro',name:'Kokoro',provider:'speech',roles:['tts'],available:true
            }]
        }
    });
    assert.deepEqual(result,{stt:true,tts:true});
    assert.ok(Object.isFrozen(result));
    assert.throws(
        ()=>getCoreLocalSpeechAvailability({
            speech:{synthesisAvailable:true},
            models:{speech:Array.from({length:9},(_value,index)=>({
                id:`voice-${index}`,
                name:`Voice ${index}`,
                provider:'speech',
                roles:['tts'],
                available:true
            }))}
        }),
        /too many local speech models/u
    );
});

test('AI response-length helpers normalize one provider-independent prompt contract',()=>{
    assert.equal(AI_RESPONSE_LENGTH_DEFAULT,'medium');
    assert.equal(normalizeAIResponseLength(' HIGH '),'high');
    assert.equal(normalizeAIResponseLength('unknown'),'medium');
    const instruction=aiResponseLengthInstruction('low');
    assert.match(instruction,/Aim for 1 to 5 sentences/u);
    const applied=applyAIResponseLength('System context.','low');
    assert.match(applied,/System context[.]\n\n## Application-selected response length/u);
    assert.equal(applyAIResponseLength(applied,'high'),applied);
    assert.throws(()=>applyAIResponseLength(null,'medium'),/must be a string/u);
});

test(
    'AI runtime state is sticky, immutable, role-independent, and capability-neutral',
    async function testAIRuntimeStateContract() {
        assert.equal(AI_RUNTIME_PROTOCOL, 'arcane-ai-runtime-state/1');
        assert.equal(AI_RUNTIME_STATE_EVENT, 'arcane-ai-runtime-state');
        assert.equal(AI_RUNTIME_INTENT_EVENT, 'arcane-ai-runtime-intent');
        assert.equal(
            AI_RUNTIME_STARTUP_EVENT,
            'arcane-ai-runtime-startup-settled'
        );
        assert.deepEqual(AI_RUNTIME_ROLES, ['llm', 'stt', 'tts']);
        assert.deepEqual(
            AI_RUNTIME_STATES,
            [
                'unavailable',
                'unloaded',
                'loading',
                'ready',
                'unloading',
                'error',
                'disposed'
            ]
        );
        assert.ok(Object.isFrozen(AI_RUNTIME_ROLES));
        assert.ok(Object.isFrozen(AI_RUNTIME_STATES));

        const initial = getAIRuntimeState();
        assert.deepEqual(
            initial,
            {
                protocol: AI_RUNTIME_PROTOCOL,
                revision: 0,
                roles: {
                    llm: runtimeRoleState('llm'),
                    stt: runtimeRoleState('stt'),
                    tts: runtimeRoleState('tts')
                }
            }
        );
        assert.ok(Object.isFrozen(initial));
        assert.ok(Object.isFrozen(initial.roles));
        assert.ok(Object.values(initial.roles).every(Object.isFrozen));

        const stateController = new AbortController();
        const snapshots = [];
        const intents = [];
        const stateEvents = [];

        function observeSnapshot(snapshot) {
            snapshots.push(snapshot);
        }

        function observeIntent(intent) {
            intents.push(intent);
        }

        function observeStateEvent(event) {
            stateEvents.push(event.detail);
        }

        aiRuntimeEvents.addEventListener(
            AI_RUNTIME_STATE_EVENT,
            observeStateEvent
        );
        const unsubscribeState = subscribeAIRuntimeState(
            observeSnapshot,
            {
                signal: stateController.signal
            }
        );
        const unsubscribeIntents = subscribeAIRuntimeIntents(observeIntent);

        try {
            assert.deepEqual(snapshots, [initial]);

            const loading = publishAIRuntimeRoleState(
                'tts',
                runtimeRoleState(
                    'tts',
                    {
                        state: 'loading',
                        providerId: 'speech-t5',
                        modelId: 'speech-t5-q8',
                        localOnly: true,
                        operationId: 'tts-load-1',
                        progress: {
                            phase: 'weights',
                            completed: 4,
                            total: 8,
                            unit: 'bytes',
                            heartbeat: true
                        }
                    }
                )
            );
            assert.equal(snapshots.at(-1), loading);
            assert.equal(stateEvents.at(-1), loading);
            assert.equal(loading.roles.llm, initial.roles.llm);
            assert.equal(loading.roles.stt, initial.roles.stt);
            assert.ok(Object.isFrozen(loading.roles.tts.progress));

            const beforeMalformed = getAIRuntimeState();
            assert.throws(
                function rejectIncompleteRoleRecord() {
                    publishAIRuntimeRoleState('tts', {role: 'tts'});
                },
                /must contain exactly/u
            );
            assert.throws(
                function rejectIncoherentErrorRecord() {
                    publishAIRuntimeRoleState(
                        'tts',
                        runtimeRoleState(
                            'tts',
                            {
                                state: 'error',
                                providerId: 'speech-t5',
                                modelId: 'speech-t5-q8',
                                localOnly: true
                            }
                        )
                    );
                },
                /error role state must include error details/u
            );
            assert.throws(
                function rejectLoadedRoleWithoutModel() {
                    publishAIRuntimeRoleState(
                        'tts',
                        runtimeRoleState(
                            'tts',
                            {
                                state: 'ready',
                                providerId: 'speech-t5',
                                localOnly: true,
                                loaded: true
                            }
                        )
                    );
                },
                /must identify its provider and model/u
            );
            assert.throws(
                function rejectInvalidProgressRecord() {
                    publishAIRuntimeRoleState(
                        'tts',
                        runtimeRoleState(
                            'tts',
                            {
                                state: 'loading',
                                progress: {
                                    phase: 'weights',
                                    completed: 2,
                                    total: 1,
                                    unit: 'bytes',
                                    heartbeat: false
                                }
                            }
                        )
                    );
                },
                /no smaller than progress.completed/u
            );
            assert.equal(getAIRuntimeState(), beforeMalformed);

            const failed = publishAIRuntimeRoleState(
                'tts',
                runtimeRoleState(
                    'tts',
                    {
                        state: 'error',
                        providerId: 'speech-t5',
                        modelId: 'speech-t5-q8',
                        localOnly: true,
                        error: {
                            code: 'ARCANE_AI_RUNTIME_LOAD_FAILED',
                            message: 'The selected runtime did not become ready.'
                        }
                    }
                )
            );
            assert.ok(Object.isFrozen(failed.roles.tts.error));
            assert.equal(failed.roles.llm, initial.roles.llm);
            assert.equal(failed.roles.stt, initial.roles.stt);

            const stateBeforeIntents = getAIRuntimeState();
            for (const action of ['load', 'unload', 'dispose']) {
                const intent = requestAIRuntimeIntent(
                    {
                        role: 'tts',
                        action,
                        reason: action === 'dispose' ? 'teardown' : 'user'
                    }
                );
                assert.ok(Object.isFrozen(intent));
            }
            assert.equal(getAIRuntimeState(), stateBeforeIntents);
            assert.deepEqual(
                intents.map(function readIntentAction(intent) {
                    return intent.action;
                }),
                ['load', 'unload', 'dispose']
            );
            assert.throws(
                function rejectMalformedIntent() {
                    requestAIRuntimeIntent(
                        {
                            role: 'tts',
                            action: 'fallback',
                            reason: 'user'
                        }
                    );
                },
                /must be load, unload, or dispose/u
            );
            assert.equal(getAIRuntimeState(), stateBeforeIntents);

            const snapshotsBeforeAbort = snapshots.length;
            stateController.abort();
            const independent = publishAIRuntimeRoleState(
                'stt',
                runtimeRoleState(
                    'stt',
                    {
                        state: 'unloaded',
                        providerId: 'moonshine-tiny',
                        modelId: 'moonshine-tiny-q8',
                        localOnly: true
                    }
                )
            );
            assert.equal(snapshots.length, snapshotsBeforeAbort);
            assert.equal(independent.roles.tts, failed.roles.tts);

            const intentsBeforeUnsubscribe = intents.length;
            unsubscribeIntents();
            requestAIRuntimeIntent(
                {
                    role: 'stt',
                    action: 'load',
                    reason: 'startup'
                }
            );
            assert.equal(intents.length, intentsBeforeUnsubscribe);

            const startupIntents = [];
            const startupReports = [];

            function observeStartupIntent(intent) {
                startupIntents.push(intent);
            }

            function observeStartupReport(event) {
                startupReports.push(event.detail);
            }

            aiRuntimeEvents.addEventListener(
                AI_RUNTIME_STARTUP_EVENT,
                observeStartupReport
            );
            const unsubscribeStartupIntents = subscribeAIRuntimeIntents(
                observeStartupIntent
            );
            try {
                publishAIRuntimeRoleState(
                    'llm',
                    runtimeRoleState(
                        'llm',
                        {
                            state: 'unloaded',
                            providerId: 'wllama',
                            modelId: 'wllama-test-model',
                            localOnly: true
                        }
                    )
                );
                publishAIRuntimeRoleState(
                    'stt',
                    runtimeRoleState(
                        'stt',
                        {
                            state: 'unloaded',
                            providerId: 'moonshine-tiny',
                            modelId: 'moonshine-tiny-q8',
                            localOnly: true
                        }
                    )
                );
                publishAIRuntimeRoleState(
                    'tts',
                    runtimeRoleState(
                        'tts',
                        {
                            state: 'unloaded',
                            providerId: 'speech-t5',
                            modelId: 'speech-t5-q8',
                            localOnly: true
                        }
                    )
                );

                const startSnapshot = getAIRuntimeState();
                const standbyTTS = startSnapshot.roles.tts;
                const deferredTranscriptionStart = startAIRuntime();
                assert.deepEqual(
                    startupIntents,
                    [
                        {
                            role: 'llm',
                            action: 'load',
                            reason: 'startup'
                        }
                    ]
                );
                const deferredTranscriptionWaits = Promise.allSettled(
                    [
                        deferredTranscriptionStart.barrier,
                        deferredTranscriptionStart.settled
                    ]
                );
                deferredTranscriptionStart.cancel();
                await deferredTranscriptionWaits;
                startupIntents.length = 0;
                const mutedStart = startAIRuntime({startTranscription: true});
                assert.ok(Object.isFrozen(mutedStart));
                assert.deepEqual(
                    startupIntents,
                    [
                        {
                            role: 'llm',
                            action: 'load',
                            reason: 'startup'
                        },
                        {
                            role: 'stt',
                            action: 'load',
                            reason: 'startup'
                        }
                    ]
                );

                let settledReport = null;
                const observeMutedSettlement = mutedStart.settled.then(
                    function captureMutedSettlement(report) {
                        settledReport = report;
                        return report;
                    }
                );
                publishAIRuntimeRoleState(
                    'stt',
                    runtimeRoleState(
                        'stt',
                        {
                            state: 'loading',
                            providerId: 'moonshine-tiny',
                            modelId: 'moonshine-tiny-q8',
                            localOnly: true,
                            operationId: 'stt-load-1'
                        }
                    )
                );
                publishAIRuntimeRoleState(
                    'llm',
                    runtimeRoleState(
                        'llm',
                        {
                            state: 'ready',
                            providerId: 'wllama',
                            modelId: 'wllama-test-model',
                            localOnly: true,
                            loaded: true
                        }
                    )
                );
                const barrierReport = await mutedStart.barrier;
                assert.equal(barrierReport.startRevision, startSnapshot.revision);
                assert.equal(barrierReport.startMuted, true);
                assert.equal(barrierReport.startTranscription, true);
                assert.equal(barrierReport.chatReady, true);
                assert.equal(barrierReport.roles.llm.requested, true);
                assert.equal(barrierReport.roles.stt.requested, true);
                assert.equal(barrierReport.roles.tts.requested, false);
                assert.equal(
                    barrierReport.roles.llm.state.modelId,
                    'wllama-test-model'
                );
                assert.equal(barrierReport.roles.stt.state.state, 'loading');
                assert.equal(barrierReport.roles.tts.state, standbyTTS);
                assert.equal(startupReports.at(-1), barrierReport);
                assert.ok(Object.isFrozen(barrierReport));
                assert.equal(settledReport, null);

                publishAIRuntimeRoleState(
                    'stt',
                    runtimeRoleState(
                        'stt',
                        {
                            state: 'ready',
                            providerId: 'moonshine-tiny',
                            modelId: 'moonshine-tiny-q8',
                            localOnly: true,
                            loaded: true
                        }
                    )
                );
                const completeReport = await observeMutedSettlement;
                assert.equal(completeReport.roles.stt.state.state, 'ready');
                assert.equal(completeReport.roles.tts.state, standbyTTS);

                publishAIRuntimeRoleState(
                    'llm',
                    runtimeRoleState(
                        'llm',
                        {
                            state: 'loading',
                            providerId: 'wllama',
                            modelId: 'wllama-test-model',
                            localOnly: true,
                            operationId: 'llm-load-2'
                        }
                    )
                );
                startupIntents.length = 0;
                const startupEventCount = startupReports.length;
                const startupController = new AbortController();
                const unmutedStart = startAIRuntime(
                    {
                        startMuted: false,
                        signal: startupController.signal
                    }
                );
                assert.deepEqual(
                    startupIntents,
                    [
                        {
                            role: 'tts',
                            action: 'load',
                            reason: 'startup'
                        }
                    ]
                );

                const cancelledWaits = Promise.allSettled(
                    [unmutedStart.barrier, unmutedStart.settled]
                );
                startupController.abort();
                const cancellation = await cancelledWaits;
                assert.equal(cancellation[0].status, 'rejected');
                assert.equal(cancellation[1].status, 'rejected');
                assert.equal(cancellation[0].reason, cancellation[1].reason);
                assert.equal(cancellation[0].reason.name, 'AbortError');
                assert.equal(
                    cancellation[0].reason.code,
                    'ARCANE_AI_REQUEST_ABORTED'
                );
                assert.deepEqual(
                    startupIntents,
                    [
                        {
                            role: 'tts',
                            action: 'load',
                            reason: 'startup'
                        },
                        {
                            role: 'llm',
                            action: 'unload',
                            reason: 'startup'
                        }
                    ]
                );
                assert.equal(startupReports.length, startupEventCount);
                unmutedStart.cancel();
            } finally {
                unsubscribeStartupIntents();
                aiRuntimeEvents.removeEventListener(
                    AI_RUNTIME_STARTUP_EVENT,
                    observeStartupReport
                );
            }
        } finally {
            stateController.abort();
            unsubscribeState();
            unsubscribeState();
            unsubscribeIntents();
            unsubscribeIntents();
            aiRuntimeEvents.removeEventListener(
                AI_RUNTIME_STATE_EVENT,
                observeStateEvent
            );
        }
    }
);

test(
    'AI provider runtime owns explicit routes, startup settlement, and independent speech lifecycle',
    async function testAIProviderRuntimeContract() {
        assert.equal(AI_PROVIDER_PROTOCOL, 'arcane-ai-provider/2');
        assert.equal(AI_PROVIDER_RUNTIME_PROTOCOL, 'arcane-ai-runtime/2');
        assert.equal(
            AI_MODEL_AUTHORITY_PROTOCOL,
            'arcane-ai-model-authority/1'
        );

        function createProvider(role, id, localOnly, response) {
            const counters = {
                load: 0,
                request: 0,
                unload: 0,
                dispose: 0
            };
            let state = 'unloaded';
            let loaded = false;
            let requestError = null;
            let heldLoad = null;
            let heldRequest = null;
            let requestBusy = false;
            const requests = [];
            return {
                protocol: AI_PROVIDER_PROTOCOL,
                role,
                id,
                localOnly,
                counters,
                requests,
                failNextRequest: function failNextTestProviderRequest(error) {
                    requestError = error;
                },
                holdNextLoad: function holdNextTestProviderLoad() {
                    let markStarted;
                    let release;
                    const started = new Promise(function createHeldLoadStart(resolve) {
                        markStarted = resolve;
                    });
                    const released = new Promise(function createHeldLoadRelease(resolve) {
                        release = resolve;
                    });
                    heldLoad = {markStarted, released};
                    return {started, release};
                },
                holdNextRequest: function holdNextTestProviderRequest() {
                    let markAborted;
                    let markStarted;
                    let release;
                    const aborted = new Promise(function createHeldRequestAbort(resolve) {
                        markAborted = resolve;
                    });
                    const started = new Promise(function createHeldRequestStart(resolve) {
                        markStarted = resolve;
                    });
                    const released = new Promise(function createHeldRequestRelease(resolve) {
                        release = resolve;
                    });
                    heldRequest = {
                        markAborted,
                        markStarted,
                        released
                    };
                    return {aborted, started, release};
                },
                catalog: function catalogTestProvider() {
                    return [{id: `${id}-model`}];
                },
                inspect: function inspectTestProvider(selection) {
                    return {
                        available: true,
                        authority: {
                            protocol: AI_MODEL_AUTHORITY_PROTOCOL,
                            providerId: id,
                            modelId: selection.modelId,
                            admitted: true
                        }
                    };
                },
                status: function statusTestProvider() {
                    return {
                        state,
                        loaded,
                        busy: requestBusy
                    };
                },
                load: async function loadTestProvider({progress, signal}) {
                    counters.load += 1;
                    progress(
                        {
                            phase: 'initialize',
                            completed: 0,
                            total: null,
                            unit: 'items',
                            heartbeat: true
                        }
                    );
                    if (signal.aborted) {
                        const error = new Error('cancelled');
                        error.name = 'AbortError';
                        throw error;
                    }
                    if (heldLoad) {
                        const gate = heldLoad;
                        heldLoad = null;
                        gate.markStarted();
                        await Promise.race(
                            [
                                gate.released,
                                new Promise(function rejectHeldLoadOnAbort(resolve, reject) {
                                    signal.addEventListener(
                                        'abort',
                                        function abortHeldTestProviderLoad() {
                                            const error = new Error('cancelled');
                                            error.name = 'AbortError';
                                            reject(error);
                                        },
                                        {once: true}
                                    );
                                })
                            ]
                        );
                    }
                    if (signal.aborted) {
                        const error = new Error('cancelled');
                        error.name = 'AbortError';
                        throw error;
                    }
                    state = 'ready';
                    loaded = true;
                },
                request: async function requestTestProvider({payload, signal}) {
                    counters.request += 1;
                    requests.push(payload);
                    requestBusy = true;
                    try {
                        if (signal.aborted) {
                            const error = new Error('cancelled');
                            error.name = 'AbortError';
                            throw error;
                        }
                        if (heldRequest) {
                            const gate = heldRequest;
                            heldRequest = null;
                            function observeHeldRequestAbort() {
                                gate.markAborted();
                            }
                            gate.markStarted();
                            signal.addEventListener(
                                'abort',
                                observeHeldRequestAbort,
                                {once: true}
                            );
                            try {
                                await gate.released;
                            } finally {
                                signal.removeEventListener(
                                    'abort',
                                    observeHeldRequestAbort
                                );
                            }
                        }
                        if (signal.aborted) {
                            const error = new Error('cancelled');
                            error.name = 'AbortError';
                            throw error;
                        }
                        if (requestError) {
                            const error = requestError;
                            requestError = null;
                            throw error;
                        }
                        return response;
                    } finally {
                        requestBusy = false;
                    }
                },
                unload: async function unloadTestProvider() {
                    counters.unload += 1;
                    state = 'unloaded';
                    loaded = false;
                },
                dispose: async function disposeTestProvider() {
                    counters.dispose += 1;
                    state = 'disposed';
                    loaded = false;
                }
            };
        }

        function selection(providerId, modelId, localOnly) {
            return {
                providerId,
                modelId,
                localOnly
            };
        }

        assert.throws(
            function rejectSecondAIProviderRuntime() {
                return new AIProviderRuntime();
            },
            function isSingletonRuntimeError(error) {
                return error?.code === 'ARCANE_AI_RUNTIME_SINGLETON_REQUIRED';
            }
        );
        const runtime = getAIProviderRuntime();
        const localLLM = createProvider('llm', 'local-llm', true, 'local result');
        const cloudLLM = createProvider('llm', 'cloud-llm', false, 'cloud result');
        const localSTT = createProvider('stt', 'local-stt', true, {text: 'hello'});
        const localTTS = createProvider('tts', 'local-tts', true, new Uint8Array([1]));
        runtime.register(localLLM);
        runtime.register(cloudLLM);
        runtime.register(localSTT);
        runtime.register(localTTS);

        const pendingTupleRoutes = runtime.configureFromTuple(
            [
                'missing-llm',
                'local-stt',
                'local-tts',
                'missing-llm-model',
                'local-tts-model',
                'local-stt-model'
            ]
        );
        assert.deepEqual(
            pendingTupleRoutes.llm.default,
            selection('missing-llm', 'missing-llm-model', null)
        );
        const pendingLLM = createProvider('llm', 'missing-llm', true, 'pending result');
        const unregisterPendingLLM = runtime.register(pendingLLM);
        assert.deepEqual(
            runtime.selection('llm', {localOnly: true}),
            selection('missing-llm', 'missing-llm-model', true)
        );

        const localRoutes = runtime.configure(
            {
                llm: {
                    default: selection('local-llm', 'local-llm-model', true),
                    localOnly: selection('local-llm', 'local-llm-model', true)
                },
                stt: {
                    default: selection('local-stt', 'local-stt-model', true),
                    localOnly: selection('local-stt', 'local-stt-model', true)
                },
                tts: {
                    default: selection('local-tts', 'local-tts-model', true),
                    localOnly: selection('local-tts', 'local-tts-model', true)
                }
            }
        );
        assert.equal(unregisterPendingLLM(), true);
        assert.ok(Object.isFrozen(localRoutes));
        assert.equal(runtime.protocol, AI_PROVIDER_RUNTIME_PROTOCOL);
        assert.equal(runtime.status('llm').state, 'unloaded');
        assert.equal(runtime.status('llm').providerId, 'local-llm');
        assert.equal(runtime.status('stt').providerId, 'local-stt');
        assert.equal(runtime.status('tts').providerId, 'local-tts');

        const invalidStartupOptions = {};
        Object.defineProperty(
            invalidStartupOptions,
            'startMuted',
            {
                enumerable: true,
                get: function readForbiddenStartupAccessor() {
                    return true;
                }
            }
        );
        const beforeInvalidStartup = runtime.status();
        await assert.rejects(
            runtime.start(invalidStartupOptions),
            function rejectsStartupAccessor(error) {
                return error?.code === 'ARCANE_AI_PROVIDER_RUNTIME_INVALID';
            }
        );
        assert.equal(runtime.status(), beforeInvalidStartup);

        const startupOptions = {
            startMuted: true,
            startTranscription: false
        };
        const startupPromise = runtime.start(startupOptions);
        startupOptions.startMuted = false;
        startupOptions.startTranscription = true;
        const startup = await startupPromise;
        const barrier = await startup.barrier;
        const settled = await startup.settled;
        assert.equal(barrier.chatReady, true);
        assert.equal(settled.chatReady, true);
        assert.equal(settled.roles.llm.state.state, 'ready');
        assert.equal(settled.startTranscription, false);
        assert.equal(settled.roles.stt.requested, false);
        assert.equal(settled.roles.stt.state.state, 'unloaded');
        assert.equal(settled.roles.tts.requested, false);
        assert.equal(localLLM.counters.load, 1);
        assert.equal(localSTT.counters.load, 0);
        assert.equal(localTTS.counters.load, 0);
        await runtime.load('stt', {localOnly: true});
        assert.equal(localSTT.counters.load, 1);

        assert.equal(
            await runtime.chat(
                {messages: []},
                {localOnly: true}
            ),
            'local result'
        );
        const requestsBeforeSupersession = localLLM.counters.request;
        const heldRequest = localLLM.holdNextRequest();
        const firstRequest = runtime.chat(
            {messages: [], requestId: 'first'},
            {localOnly: true}
        );
        const firstRejection = assert.rejects(
            firstRequest,
            function rejectSupersededActiveRequest(error) {
                return error?.code === 'ARCANE_AI_REQUEST_ABORTED';
            }
        );
        await heldRequest.started;
        const intermediateRequest = runtime.chat(
            {messages: [], requestId: 'intermediate'},
            {localOnly: true}
        );
        const intermediateRejection = assert.rejects(
            intermediateRequest,
            function rejectIntermediateRequestAdmission(error) {
                return error?.code === 'ARCANE_AI_OPERATION_SUPERSEDED';
            }
        );
        const newestRequest = runtime.chat(
            {messages: [], requestId: 'newest'},
            {localOnly: true}
        );
        await heldRequest.aborted;
        assert.equal(
            localLLM.counters.request,
            requestsBeforeSupersession + 1,
            'The newest request must wait for the superseded provider promise.'
        );
        await assert.rejects(
            runtime.load('llm', {localOnly: true}),
            function keepLoadFailClosedDuringRequestAdmission(error) {
                return error?.code === 'ARCANE_AI_ROLE_BUSY';
            }
        );
        assert.throws(
            function keepReconfigurationFailClosedDuringRequestAdmission() {
                runtime.configure(localRoutes);
            },
            function isRequestOwnershipConfigurationGuard(error) {
                return error?.code === 'ARCANE_AI_ROLE_BUSY';
            }
        );
        heldRequest.release();
        await Promise.all([firstRejection, intermediateRejection]);
        assert.equal(await newestRequest, 'local result');
        assert.equal(
            localLLM.counters.request,
            requestsBeforeSupersession + 2
        );
        assert.equal(localLLM.requests.at(-1).requestId, 'newest');
        assert.equal(runtime.status('llm').state, 'ready');
        assert.equal(runtime.status('llm').busy, false);
        await assert.rejects(
            runtime.request(
                'llm',
                {
                    operation: 'chat',
                    payload: {messages: [], onChunk: function forbiddenCallback() {}},
                    localOnly: true,
                    signal: null
                }
            ),
            function rejectProviderCallbackPayload(error) {
                return error?.code === 'ARCANE_AI_PROVIDER_CALLBACK_BOUNDARY';
            }
        );
        const requestFailure = new Error('C:\\private\\prompt-response.txt');
        requestFailure.code = 'ARCANE_AI_PROVIDER_REQUEST_FAILED';
        localLLM.failNextRequest(requestFailure);
        await assert.rejects(
            runtime.chat({messages: []}, {localOnly: true}),
            requestFailure
        );
        assert.equal(runtime.status('llm').state, 'ready');
        assert.equal(runtime.status('llm').error, null);
        await runtime.setSpeechMuted(false);
        assert.equal(localTTS.counters.load, 1);
        assert.equal(runtime.status('tts').state, 'ready');
        const replacementSTT = createProvider(
            'stt',
            'replacement-stt',
            true,
            {text: 'replacement'}
        );
        const replacementTTS = createProvider(
            'tts',
            'replacement-tts',
            true,
            new Uint8Array([2])
        );
        const originalSpeechRoutes = {
            stt: {
                default: selection('local-stt', 'local-stt-model', true),
                localOnly: selection('local-stt', 'local-stt-model', true)
            },
            tts: {
                default: selection('local-tts', 'local-tts-model', true),
                localOnly: selection('local-tts', 'local-tts-model', true)
            }
        };
        const retainedTTSState = runtime.status('tts');
        const retainedTTSSelection = runtime.selection('tts');
        const retainedTTSLoadCount = localTTS.counters.load;
        const retainedTTSUnloadCount = localTTS.counters.unload;
        await runtime.unload('stt');
        const replacedSTT = runtime.replaceSpeechProvider(
            'stt',
            {
                provider: replacementSTT,
                routes: {
                    default: selection(
                        'replacement-stt',
                        'replacement-stt-model',
                        true
                    ),
                    localOnly: selection(
                        'replacement-stt',
                        'replacement-stt-model',
                        true
                    )
                },
                expectedProvider: localSTT
            }
        );
        assert.ok(Object.isFrozen(replacedSTT));
        assert.equal(runtime.status('tts'), retainedTTSState);
        assert.equal(runtime.selection('tts'), retainedTTSSelection);
        assert.equal(runtime.ownsProvider('tts', localTTS), true);
        assert.equal(localTTS.counters.load, retainedTTSLoadCount);
        assert.equal(localTTS.counters.unload, retainedTTSUnloadCount);
        assert.equal(runtime.speechMuted, false);
        await runtime.load('stt', {localOnly: true});
        assert.equal(runtime.status('stt').state, 'ready');

        const retainedSTTState = runtime.status('stt');
        const retainedSTTSelection = runtime.selection('stt');
        const retainedSTTLoadCount = replacementSTT.counters.load;
        const retainedSTTUnloadCount = replacementSTT.counters.unload;
        await runtime.unload('tts');
        const mutedBeforeTTSReplacement = runtime.speechMuted;
        const replacedTTS = runtime.replaceSpeechProvider(
            'tts',
            {
                provider: replacementTTS,
                routes: {
                    default: selection(
                        'replacement-tts',
                        'replacement-tts-model',
                        true
                    ),
                    localOnly: selection(
                        'replacement-tts',
                        'replacement-tts-model',
                        true
                    )
                },
                expectedProvider: localTTS
            }
        );
        assert.ok(Object.isFrozen(replacedTTS));
        assert.equal(runtime.status('stt'), retainedSTTState);
        assert.equal(runtime.selection('stt'), retainedSTTSelection);
        assert.equal(runtime.ownsProvider('stt', replacementSTT), true);
        assert.equal(replacementSTT.counters.load, retainedSTTLoadCount);
        assert.equal(replacementSTT.counters.unload, retainedSTTUnloadCount);
        assert.equal(runtime.speechMuted, mutedBeforeTTSReplacement);

        await runtime.unload('stt');
        runtime.replaceSpeechProviders({
            providers: {stt: localSTT, tts: localTTS},
            routes: originalSpeechRoutes,
            expectedProviders: {
                stt: replacementSTT,
                tts: replacementTTS
            }
        });
        await replacementSTT.dispose({signal: null});
        await replacementTTS.dispose({signal: null});
        await runtime.load('stt', {localOnly: true});
        await runtime.setSpeechMuted(false);
        assert.equal(runtime.status('stt').state, 'ready');
        assert.equal(runtime.status('tts').state, 'ready');
        const rapidMute = runtime.setSpeechMuted(true);
        const rapidUnmute = runtime.setSpeechMuted(false);
        await Promise.all([rapidMute, rapidUnmute]);
        assert.equal(runtime.speechMuted, false);
        assert.equal(runtime.status('tts').state, 'ready');
        await runtime.setSpeechMuted(true);
        assert.ok(localTTS.counters.unload >= 1);
        assert.equal(runtime.status('tts').state, 'unloaded');
        const heldTTSLoad = localTTS.holdNextLoad();
        const unmuteDuringHeldLoad = runtime.setSpeechMuted(false);
        await heldTTSLoad.started;
        const muteDuringHeldLoad = runtime.setSpeechMuted(true);
        await assert.rejects(
            unmuteDuringHeldLoad,
            function isCancelledHeldTTSLoad(error) {
                return error?.code === 'ARCANE_AI_REQUEST_ABORTED';
            }
        );
        await muteDuringHeldLoad;
        assert.equal(runtime.speechMuted, true);
        assert.equal(runtime.status('tts').state, 'unloaded');

        await runtime.unload('stt');
        const llmBeforeSpeechConfiguration = runtime.status('llm');
        const speechOnlyRoutes = runtime.configureSpeech(
            {
                stt: {
                    default: selection('local-stt', 'local-stt-model', true),
                    localOnly: selection('local-stt', 'local-stt-model', true)
                },
                tts: {
                    default: selection('local-tts', 'local-tts-model', true),
                    localOnly: selection('local-tts', 'local-tts-model', true)
                }
            }
        );
        assert.ok(Object.isFrozen(speechOnlyRoutes));
        assert.deepEqual(runtime.status('llm'), llmBeforeSpeechConfiguration);
        assert.equal(runtime.status('llm').state, 'ready');
        assert.equal(runtime.status('stt').state, 'unloaded');
        assert.equal(runtime.status('tts').state, 'unloaded');
        assert.throws(
            function rejectMalformedSpeechConfiguration() {
                runtime.validateSpeechConfiguration(
                    {
                        stt: {
                            default: null,
                            localOnly: null
                        }
                    }
                );
            },
            function isSpeechConfigurationContractMismatch(error) {
                return error?.code === 'ARCANE_AI_PROVIDER_RUNTIME_INVALID'
                    && error?.reason === 'speech-configuration-contract-mismatch';
            }
        );

        await runtime.unload('llm');
        await runtime.unload('stt');
        runtime.configure(
            {
                llm: {
                    default: selection('cloud-llm', 'cloud-llm-model', false),
                    localOnly: selection('local-llm', 'local-llm-model', true)
                },
                stt: {
                    default: selection('local-stt', 'local-stt-model', true),
                    localOnly: selection('local-stt', 'local-stt-model', true)
                },
                tts: {
                    default: selection('local-tts', 'local-tts-model', true),
                    localOnly: selection('local-tts', 'local-tts-model', true)
                }
            }
        );
        await runtime.load('llm');
        await assert.rejects(
            runtime.request(
                'llm',
                {
                    operation: 'chat',
                    payload: {messages: []},
                    localOnly: true,
                    signal: null
                }
            ),
            function rejectDefaultRouteForLocalOnly(error) {
                return error?.code === 'ARCANE_AI_ROUTE_NOT_READY';
            }
        );
        assert.equal(cloudLLM.counters.request, 0);
        await runtime.unload('llm');
        await runtime.load('llm', {localOnly: true});
        assert.equal(
            await runtime.request(
                'llm',
                {
                    operation: 'chat',
                    payload: {messages: []},
                    localOnly: true,
                    signal: null
                }
            ),
            'local result'
        );
        assert.equal(cloudLLM.counters.request, 0);
        await runtime.dispose('llm');
        await runtime.dispose('stt');
        await runtime.dispose('tts');
        assert.equal(runtime.status('llm').state, 'disposed');
        assert.equal(runtime.status('stt').state, 'disposed');
        assert.equal(runtime.status('tts').state, 'disposed');
        runtime.configure(
            {
                llm: {default: null, localOnly: null},
                stt: {default: null, localOnly: null},
                tts: {default: null, localOnly: null}
            }
        );
        assert.equal(runtime.unregister('llm', 'local-llm'), true);
        assert.equal(runtime.unregister('llm', 'cloud-llm'), true);
        assert.equal(runtime.unregister('stt', 'local-stt'), true);
        assert.equal(runtime.unregister('tts', 'local-tts'), true);
    }
);

test(
    'legacy Cloud and admitted Core routes publish truthful provider-v2 readiness',
    async function testLegacyLLMProviderAdapters() {
        const previousWindow=globalThis.window;
        const previousArcane=globalThis.Arcane;
        const previousFetch=globalThis.fetch;
        const previousLocalStorage=globalThis.localStorage;
        const previousDocument=globalThis.document;
        const windowTarget=new EventTarget();
        windowTarget.dbopfs={ready:false,get:function ignoreDBOPFSRead(){}};
        windowTarget.user={ready:false};
        const documentObject={
            documentElement:{dataset:{arcaneAppId:'runtime-api-contract'}},
            querySelector(){return null;}
        };
        const storedValues=new Map();
        const localStorage={
            getItem(key){
                const normalizedKey=String(key);
                return storedValues.has(normalizedKey)
                    ? storedValues.get(normalizedKey)
                    : null;
            },
            setItem(key,value){storedValues.set(String(key),String(value));},
            removeItem(key){storedValues.delete(String(key));},
            clear(){storedValues.clear();}
        };
        windowTarget.localStorage=localStorage;
        windowTarget.document=documentObject;
        globalThis.window=windowTarget;
        globalThis.localStorage=localStorage;
        globalThis.document=documentObject;
        const requests=[];
        globalThis.fetch=async function answerLegacyCloudRequest(url,options) {
            requests.push({url:String(url),options});
            if(String(url).endsWith('/audio/transcriptions')){
                return new Response('cloud transcript',{status:200});
            }
            if(String(url).endsWith('/audio/speech')){
                return new Response(new Uint8Array([1,2,3,4]),{
                    status:200,
                    headers:{'content-type':'audio/ogg'}
                });
            }
            return new Response(JSON.stringify({
                id:'cloud-response',
                model:'gpt-5-mini',
                choices:[{
                    index:0,
                    message:{role:'assistant',content:'cloud response'},
                    finish_reason:'stop'
                }],
                usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}
            }),{
                status:200,
                headers:{'content-type':'application/json'}
            });
        };
        try{
            const {default:AI}=await import(
                '../runtime/arcane/modules/AI.js?legacy-provider-v2-readiness'
            );
            const ai=new AI('OPENAI','OPENAI','OPENAI','OPENAI','OPENAI','OPENAI');
            const runtime=ai.providerRuntime;
            assert.deepEqual(runtime.providerIdentity('llm','OPENAI'),{
                protocol:AI_PROVIDER_PROTOCOL,
                role:'llm',
                id:'OPENAI',
                localOnly:false
            });
            assert.equal(runtime.status('llm').state,'unloaded');
            assert.equal(runtime.status('stt').state,'unloaded');
            assert.equal(runtime.status('tts').state,'unloaded');
            assert.deepEqual(runtime.providerIdentity('stt','OPENAI'),{
                protocol:AI_PROVIDER_PROTOCOL,
                role:'stt',
                id:'OPENAI',
                localOnly:false
            });
            assert.deepEqual(runtime.providerIdentity('tts','OPENAI'),{
                protocol:AI_PROVIDER_PROTOCOL,
                role:'tts',
                id:'OPENAI',
                localOnly:false
            });
            assert.equal(ai.configured,false);
            await assert.rejects(
                runtime.load('stt'),
                error=>error?.code==='AI_PROVIDER_NOT_CONFIGURED'
            );

            ai.license='test-credential';
            await runtime.load('llm');
            await runtime.load('stt');
            await ai.setSpeechMuted(false);
            assert.equal(runtime.status('llm').state,'ready');
            assert.equal(runtime.status('stt').state,'ready');
            assert.equal(runtime.status('tts').state,'ready');
            assert.equal(runtime.status('llm').loaded,true);
            assert.equal(ai.configured,true);
            assert.equal(requests.length,0,'Cloud readiness must not probe or download');
            assert.deepEqual(runtime.catalog('llm').find(
                entry=>entry.providerId==='OPENAI'
            ).models,[{id:ai.model}]);

            const directCloud=await runtime.request('llm',{
                operation:'chat',
                payload:{messages:[{role:'user',content:'Direct cloud'}]},
                localOnly:false,
                signal:null
            });
            assert.equal(directCloud.choices[0].message.content,'cloud response');
            assert.equal(runtime.status('llm').state,'ready');
            assert.equal(runtime.status('llm').busy,false);
            const publicCloud=await ai.fetchRequest({
                messages:[{role:'user',content:'Public cloud'}]
            });
            assert.equal(publicCloud.choices[0].message.content,'cloud response');
            assert.equal(requests.length,2);
            const cloudTranscript=await ai.fetchSTT(
                new Blob([new Uint8Array([1,2,3])],{type:'audio/webm'})
            );
            assert.equal(cloudTranscript,'cloud transcript');
            const cloudSpeech=await ai.fetchTTS({
                model:ai.modelTTS,
                voice:'alloy',
                input:'Cloud voice.',
                responseFormat:'opus',
                speed:1
            });
            assert.ok(cloudSpeech instanceof Blob);
            assert.equal(requests.length,4);

            await ai.setSpeechMuted(true);
            await runtime.unload('stt');
            ai.license='';
            await runtime.unload('llm');
            assert.equal(runtime.status('llm').state,'unloaded');
            assert.equal(ai.configured,false);

            const nativeCalls=[];
            const nativeSpeechCalls=[];
            globalThis.Arcane={
                ollama:{
                    async chat(request,options) {
                        nativeCalls.push({request,options});
                        return {
                            model:request.model,
                            message:{role:'assistant',content:'core response'},
                            done_reason:'stop',
                            prompt_eval_count:4,
                            eval_count:3
                        };
                    }
                },
                speech:{
                    async transcribe(request){
                        nativeSpeechCalls.push({operation:'transcribe',request});
                        return {text:'core transcript'};
                    },
                    async synthesize(request){
                        nativeSpeechCalls.push({operation:'synthesize',request});
                        return {
                            audioBase64:'AQIDBA==',
                            contentType:'audio/ogg'
                        };
                    }
                }
            };
            await ai.transitionAI(
                'OLLAMA','LOCAL_SPEACH','LOCAL_SPEACH',
                'granite3.3:8b','LOCAL_SPEACH','LOCAL_SPEACH'
            );
            assert.deepEqual(runtime.providerIdentity('llm','OLLAMA'),{
                protocol:AI_PROVIDER_PROTOCOL,
                role:'llm',
                id:'OLLAMA',
                localOnly:true
            });
            assert.equal(runtime.status('llm').state,'ready');
            assert.equal(runtime.status('llm').localOnly,true);
            assert.equal(ai.configured,true);
            assert.equal(nativeCalls.length,0,'Core readiness must not load or probe a model');
            assert.equal(runtime.status('stt').state,'unloaded');
            assert.equal(runtime.status('tts').state,'unloaded');
            assert.equal(nativeSpeechCalls.length,0,'Core speech readiness must not probe');
            await runtime.load('stt',{localOnly:true});
            await ai.setSpeechMuted(false);
            assert.equal(runtime.status('stt').state,'ready');
            assert.equal(runtime.status('tts').state,'ready');
            assert.equal(nativeSpeechCalls.length,0,'Core speech load must be capability-only');
            const directCore=await runtime.request('llm',{
                operation:'chat',
                payload:{messages:[{role:'user',content:'Direct core'}]},
                localOnly:true,
                signal:null
            });
            assert.equal(directCore.choices[0].message.content,'core response');
            const publicCore=await ai.fetchRequest({
                messages:[{role:'user',content:'Public core'}],
                localOnly:true
            });
            assert.equal(publicCore.choices[0].message.content,'core response');
            assert.equal(nativeCalls.length,2);
            const coreTranscript=await ai.fetchSTT(
                new Blob([new Uint8Array([5,6,7])],{type:'audio/webm'})
            );
            assert.equal(coreTranscript,'core transcript');
            const coreSpeech=await ai.fetchTTS({
                model:ai.modelTTS,
                input:'Core voice.',
                responseFormat:'opus',
                speed:1
            });
            assert.ok(coreSpeech instanceof Blob);
            assert.equal(nativeSpeechCalls[0].operation,'transcribe');
            assert.equal(nativeSpeechCalls[1].operation,'synthesize');
            assert.equal(nativeSpeechCalls[1].request.voice,'af_heart');

            await ai.setSpeechMuted(true);
            await runtime.unload('stt');
            await runtime.unload('llm');
            const ttsRequests=[];
            const ttsSignals=[];
            let ttsState='unloaded';
            const ttsProvider={
                protocol:AI_PROVIDER_PROTOCOL,
                role:'tts',
                id:'catalog-tts',
                localOnly:true,
                catalog(){
                    return [{
                        id:'catalog-tts-model',
                        defaultVoice:'provider_voice',
                        speech:{
                            outputSampleRate:24_000,
                            responseFormats:['wav'],
                            defaultResponseFormat:'wav'
                        }
                    }];
                },
                inspect(selection){
                    return {
                        available:true,
                        authority:{
                            protocol:AI_MODEL_AUTHORITY_PROTOCOL,
                            providerId:'catalog-tts',
                            modelId:selection.modelId,
                            admitted:true
                        }
                    };
                },
                status(){
                    return {state:ttsState,loaded:ttsState==='ready',busy:false};
                },
                async load({progress}){
                    progress({
                        phase:'capability',completed:1,total:1,unit:'items',heartbeat:false
                    });
                    ttsState='ready';
                },
                async request(context){
                    ttsRequests.push(context.payload);
                    ttsSignals.push(context.signal);
                    return {audio:new Uint8Array([1,2,3,4]),contentType:'audio/wav'};
                },
                async unload(){ttsState='unloaded';},
                async dispose(){ttsState='disposed';}
            };
            const unregisterTTS=runtime.register(ttsProvider);
            const ttsSelection={
                providerId:'catalog-tts',modelId:'catalog-tts-model',localOnly:true
            };
            ai.configureProviders({
                llm:{default:null,localOnly:null},
                stt:{default:null,localOnly:null},
                tts:{default:ttsSelection,localOnly:ttsSelection}
            });
            windowTarget.user.AI_voice='alloy';
            windowTarget.AudioContext=class ContractAudioContext{
                state='running';
                destination={};
                async decodeAudioData(){return {};}
                createBufferSource(){
                    return {
                        connect(){},
                        disconnect(){},
                        start(){},
                        stop(){}
                    };
                }
            };
            await ai.setSpeechMuted(false);
            assert.equal(ai.muted,false);
            const synthesisController=new AbortController();
            const directCatalogSpeech=await ai.fetchTTS({
                model:'catalog-tts-model',
                input:'Direct shared route synthesis.',
                responseFormat:'wav',
                speed:1
            },synthesisController.signal);
            assert.ok(directCatalogSpeech instanceof Blob);
            assert.equal(directCatalogSpeech.type,'audio/wav');
            assert.notEqual(ttsSignals[0],synthesisController.signal);
            assert.equal(ttsSignals[0]?.aborted,false);
            assert.equal(typeof ttsSignals[0]?.addEventListener,'function');
            assert.deepEqual(ttsRequests[0],{
                model:'catalog-tts-model',
                voice:'provider_voice',
                input:'Direct shared route synthesis.',
                responseFormat:'wav',
                speed:1
            });
            await assert.rejects(
                ai.fetchTTS({
                    model:'different-tts-model',
                    input:'Rejected model.',
                    responseFormat:'wav',
                    speed:1
                }),
                error=>error?.code==='ARCANE_AI_TTS_MODEL_SELECTION_MISMATCH'
            );
            await assert.rejects(
                ai.fetchTTS({
                    model:'catalog-tts-model',
                    voice:7,
                    input:'Rejected voice.',
                    responseFormat:'wav',
                    speed:1
                }),
                error=>error?.code==='ARCANE_AI_TTS_VOICE_INVALID'
            );
            assert.equal(await ai.streamTTS('Shared route synthesis.',true),true);
            assert.equal(ttsRequests.length,2);
            assert.deepEqual(ttsRequests[1],{
                model:'catalog-tts-model',
                voice:'provider_voice',
                input:'Shared route synthesis.',
                responseFormat:'wav',
                speed:1
            });
            ai.stopAudio();
            await ai.setSpeechMuted(true);
            ai.configureProviders({
                llm:{default:null,localOnly:null},
                stt:{default:null,localOnly:null},
                tts:{default:null,localOnly:null}
            });
            assert.equal(unregisterTTS(),true);
            assert.equal(runtime.providerIdentity('llm','OLLAMA'),null);
            assert.equal(runtime.status('llm').state,'unavailable');
        }finally{
            if(previousWindow===undefined)delete globalThis.window;
            else globalThis.window=previousWindow;
            if(previousArcane===undefined)delete globalThis.Arcane;
            else globalThis.Arcane=previousArcane;
            if(previousFetch===undefined)delete globalThis.fetch;
            else globalThis.fetch=previousFetch;
            if(previousLocalStorage===undefined)delete globalThis.localStorage;
            else globalThis.localStorage=previousLocalStorage;
            if(previousDocument===undefined)delete globalThis.document;
            else globalThis.document=previousDocument;
        }
    }
);

test(
    'browser speech replaces one configured role without replacing or disposing the other',
    async function testIndependentBrowserSpeechConfiguration() {
        const previousWindow=globalThis.window;
        const previousLocalStorage=globalThis.localStorage;
        const previousDocument=globalThis.document;
        const dbopfsReads=[];
        const dbopfs=Object.freeze({
            readyPromise:Promise.resolve(),
            async getTableHandle(tableName){
                dbopfsReads.push(tableName);
                throw new Error('Browser speech configuration must not load artifacts.');
            }
        });
        const localStorage={
            getItem(){return null;},
            setItem(){},
            removeItem(){},
            clear(){}
        };
        const documentObject={
            documentElement:{dataset:{arcaneAppId:'browser-speech-role-contract'}},
            querySelector(){return null;}
        };
        const windowTarget=new EventTarget();
        windowTarget.dbopfs=dbopfs;
        windowTarget.user={ready:false};
        windowTarget.localStorage=localStorage;
        windowTarget.document=documentObject;
        globalThis.window=windowTarget;
        globalThis.localStorage=localStorage;
        globalThis.document=documentObject;

        function graphFile(index,kind,path,revision,mediaType,runtimeRequestUrls=[]){
            const sha256=(index+1).toString(16).repeat(64);
            return {
                kind,
                path,
                sourceUrl:`https://speech.example/${revision}/${sha256}/${path}`,
                revision,
                license:'Apache-2.0',
                mediaType,
                bytes:1,
                sha256,
                runtimeRequestUrls
            };
        }

        function browserSpeechGraph(createBrowserSpeechArtifactGraph,role,providerId,suffix){
            const runtimeRevision=`${role}-runtime-${suffix}`;
            const modelRevision=`${role}-model-${suffix}`;
            const modelRoute=`https://speech.example/${modelRevision}/request/config.json`;
            const voiceRoute=role==='tts'
                ?`https://speech.example/${modelRevision}/request/voice.bin`
                :null;
            const files=[
                graphFile(
                    0,
                    'runtime-entrypoint-javascript',
                    'runtime/entry.mjs',
                    runtimeRevision,
                    'text/javascript'
                ),
                graphFile(
                    1,
                    'runtime-auxiliary-javascript',
                    'runtime/ort.mjs',
                    runtimeRevision,
                    'text/javascript'
                ),
                graphFile(
                    2,
                    'runtime-wasm-binary',
                    'runtime/ort.wasm',
                    runtimeRevision,
                    'application/wasm'
                ),
                graphFile(
                    3,
                    'model-configuration-json',
                    'model/config.json',
                    modelRevision,
                    'application/json',
                    [modelRoute]
                )
            ];
            if(role==='tts'){
                files.push(graphFile(
                    4,
                    'voice-style-binary',
                    'voices/af_contract.bin',
                    modelRevision,
                    'application/octet-stream',
                    [voiceRoute]
                ));
            }
            return createBrowserSpeechArtifactGraph({
                providerId,
                role,
                model:{
                    id:`${role}-model-${suffix}`,
                    repository:`example/${role}-${suffix}`,
                    revision:modelRevision,
                    dtype:'q8',
                    ...(role==='stt'
                        ?{inputSampleRate:16_000}
                        :{
                            outputSampleRate:24_000,
                            defaultVoice:'af_contract',
                            voices:[{id:'af_contract',path:'voices/af_contract.bin'}]
                        })
                },
                runtime:{
                    adapter:role==='stt'?'transformers-whisper':'kokoro-js',
                    version:'1.0.0',
                    revision:runtimeRevision,
                    entrypoint:'runtime/entry.mjs',
                    onnxWasm:{
                        namespace:role==='stt'
                            ?'transformers-env-backends-onnx-wasm'
                            :'kokoro-env-wasm-paths',
                        mjsPath:'runtime/ort.mjs',
                        wasmPath:'runtime/ort.wasm',
                        ...(role==='stt'?{numThreads:1}:{})
                    },
                    negativeRuntimeRequestUrls:[]
                },
                files,
                edges:{
                    staticImports:[],
                    dynamicImports:[],
                    moduleWorkers:[],
                    fetches:[{
                        modulePath:'runtime/entry.mjs',
                        occurrence:1,
                        edgePolicy:'artifact-targets-admitted',
                        targetPaths:['model/config.json']
                    }],
                    cacheOpens:role==='tts'?[{
                        modulePath:'runtime/entry.mjs',
                        occurrence:1,
                        edgePolicy:'artifact-targets-admitted',
                        cacheName:'kokoro-voices',
                        targetPaths:['voices/af_contract.bin']
                    }]:[]
                },
                transforms:[]
            });
        }

        let ai=null;
        try{
            const [{
                default:AI,
                AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL
            },{
                createBrowserSpeechArtifactGraph
            }]=await Promise.all([
                import('../runtime/arcane/modules/AI.js?browser-speech-role-contract'),
                import('../browser-runtime/ai/browser-speech.mjs')
            ]);
            ai=new AI('OPENAI','OPENAI','OPENAI','OPENAI','OPENAI','OPENAI');
            const runtime=ai.providerRuntime;
            const role=function browserSpeechRole(role,providerId,suffix){
                return Object.freeze({
                    providerId,
                    graph:browserSpeechGraph(
                        createBrowserSpeechArtifactGraph,
                        role,
                        providerId,
                        suffix
                    ),
                    offline:false
                });
            };
            const directSTTRole=function directBrowserSpeechSTTRole(providerId){
                const runtimeVersion='3.5.1';
                return Object.freeze({
                    providerId,
                    model:Object.freeze({
                        id:'whisper-tiny-en-direct',
                        repository:'onnx-community/whisper-tiny.en',
                        revision:'0123456789abcdef0123456789abcdef01234567',
                        files:Object.freeze([])
                    }),
                    runtime:Object.freeze({
                        adapter:'transformers-whisper',
                        version:runtimeVersion,
                        revision:runtimeVersion,
                        entry:'runtime/transformers.js',
                        wasmPaths:'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/',
                        files:Object.freeze([Object.freeze({
                            path:'runtime/transformers.js',
                            url:'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/transformers.js',
                            mediaType:'text/javascript'
                        })])
                    }),
                    offline:false
                });
            };
            const externalTTSIdentity=runtime.providerIdentity('tts','OPENAI');
            const externalTTSSelection=runtime.selection('tts');
            const externalTTSStatus=runtime.status('tts');
            const initialSTTOnly=Object.freeze({
                protocol:AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL,
                id:'browser-speech-initial-stt-only',
                dbopfs,
                stt:directSTTRole('boss-stt-direct')
            });
            const initialSTTDescriptor=await ai.configureBrowserSpeech(
                initialSTTOnly
            );
            assert.equal(ai.browserSpeechConfiguration,initialSTTOnly);
            assert.equal(initialSTTDescriptor.stt.providerId,'boss-stt-direct');
            assert.equal(initialSTTDescriptor.stt.modelId,'whisper-tiny-en-direct');
            assert.equal(
                Object.hasOwn(initialSTTDescriptor.stt,'artifactGraphId'),
                false
            );
            assert.equal(initialSTTDescriptor.tts,null);
            assert.deepEqual(
                runtime.providerIdentity('tts','OPENAI'),
                externalTTSIdentity
            );
            assert.equal(runtime.selection('tts'),externalTTSSelection);
            assert.equal(runtime.status('tts'),externalTTSStatus);
            assert.equal(await ai.disposeBrowserSpeech(),true);
            assert.equal(runtime.selection('stt'),null);
            assert.equal(runtime.selection('tts'),externalTTSSelection);
            assert.equal(runtime.status('tts'),externalTTSStatus);

            const initial=Object.freeze({
                protocol:AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL,
                id:'browser-speech-both-a',
                dbopfs,
                stt:role('stt','boss-stt-a','a'),
                tts:role('tts','boss-tts-a','a')
            });
            const initialDescriptor=await ai.configureBrowserSpeech(initial);
            assert.equal(ai.browserSpeechConfiguration,initial);
            assert.equal(initialDescriptor.stt.providerId,'boss-stt-a');
            assert.equal(initialDescriptor.tts.providerId,'boss-tts-a');
            assert.equal(Object.hasOwn(initialDescriptor.stt,'artifactGraphId'),true);
            assert.equal(Object.hasOwn(initialDescriptor.tts,'artifactGraphId'),true);
            assert.equal(runtime.selection('stt').providerId,'boss-stt-a');
            assert.equal(runtime.selection('tts').providerId,'boss-tts-a');
            assert.equal(runtime.status('stt').state,'unloaded');
            assert.equal(runtime.status('tts').state,'unloaded');
            assert.equal(ai.muted,true);
            assert.deepEqual(dbopfsReads,[]);

            const retainedTTSIdentity=runtime.providerIdentity('tts','boss-tts-a');
            const retainedTTSSelection=runtime.selection('tts');
            const retainedTTSStatus=runtime.status('tts');
            const retainedTTSDescriptor=initialDescriptor.tts;
            const sttOnly=Object.freeze({
                protocol:AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL,
                id:'browser-speech-stt-b',
                dbopfs,
                stt:role('stt','boss-stt-b','b')
            });
            const sttDescriptor=await ai.configureBrowserSpeech(sttOnly);
            assert.equal(sttDescriptor.stt.providerId,'boss-stt-b');
            assert.equal(Object.hasOwn(sttDescriptor.stt,'artifactGraphId'),true);
            assert.equal(sttDescriptor.tts,retainedTTSDescriptor);
            assert.deepEqual(
                runtime.providerIdentity('tts','boss-tts-a'),
                retainedTTSIdentity
            );
            assert.deepEqual(runtime.selection('tts'),retainedTTSSelection);
            assert.equal(runtime.status('tts'),retainedTTSStatus);
            assert.equal(ai.muted,true);
            assert.equal(runtime.providerIdentity('stt','boss-stt-a'),null);
            assert.equal(ai.browserSpeechConfiguration.stt,sttOnly.stt);
            assert.equal(ai.browserSpeechConfiguration.tts,initial.tts);
            assert.equal(Object.isFrozen(ai.browserSpeechConfiguration),true);
            assert.equal(await ai.configureBrowserSpeech(sttOnly),sttDescriptor);

            const retainedSTTIdentity=runtime.providerIdentity('stt','boss-stt-b');
            const retainedSTTSelection=runtime.selection('stt');
            const retainedSTTStatus=runtime.status('stt');
            const retainedSTTDescriptor=sttDescriptor.stt;
            const ttsOnly=Object.freeze({
                protocol:AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL,
                id:'browser-speech-tts-b',
                dbopfs,
                tts:role('tts','boss-tts-b','b')
            });
            const ttsDescriptor=await ai.configureBrowserSpeech(ttsOnly);
            assert.equal(ttsDescriptor.stt,retainedSTTDescriptor);
            assert.equal(ttsDescriptor.tts.providerId,'boss-tts-b');
            assert.deepEqual(
                runtime.providerIdentity('stt','boss-stt-b'),
                retainedSTTIdentity
            );
            assert.deepEqual(runtime.selection('stt'),retainedSTTSelection);
            assert.equal(runtime.status('stt'),retainedSTTStatus);
            assert.equal(runtime.providerIdentity('tts','boss-tts-a'),null);
            assert.equal(ai.browserSpeechConfiguration.stt,sttOnly.stt);
            assert.equal(ai.browserSpeechConfiguration.tts,ttsOnly.tts);
            assert.equal(runtime.status('stt').state,'unloaded');
            assert.equal(runtime.status('tts').state,'unloaded');
            assert.deepEqual(dbopfsReads,[]);

            assert.equal(await ai.disposeBrowserSpeech(),true);
            assert.equal(runtime.selection('stt'),null);
            assert.equal(runtime.selection('tts'),null);
            assert.equal(runtime.providerIdentity('stt','boss-stt-b'),null);
            assert.equal(runtime.providerIdentity('tts','boss-tts-b'),null);
            assert.deepEqual(dbopfsReads,[]);
            ai.configureProviders({
                llm:{default:null,localOnly:null},
                stt:{default:null,localOnly:null},
                tts:{default:null,localOnly:null}
            });
        }finally{
            if(previousWindow===undefined)delete globalThis.window;
            else globalThis.window=previousWindow;
            if(previousLocalStorage===undefined)delete globalThis.localStorage;
            else globalThis.localStorage=previousLocalStorage;
            if(previousDocument===undefined)delete globalThis.document;
            else globalThis.document=previousDocument;
        }
    }
);

test(
    'chat requires explicit selected-unloaded AI activation before reporting a usable route',
    async function testChatAIActivationContract() {
        const source=await readFile(
            new URL('runtime/arcane/components/chat.html',repositoryRoot),
            'utf8'
        );
        const functionStart=source.indexOf('function createAIActivationController(');
        const functionEnd=source.indexOf(
            '\n    function synchronizeAIRuntimeState',
            functionStart
        );
        assert.notEqual(functionStart,-1);
        assert.notEqual(functionEnd,-1);
        const factorySource=source.slice(functionStart,functionEnd);
        const createAIActivationController=Function(
            `'use strict';\n${factorySource}\nreturn createAIActivationController;`
        )();

        class ActivationEvent {
            constructor(type,options={}) {
                this.type=type;
                this.detail=options.detail;
                this.bubbles=options.bubbles===true;
                this.composed=options.composed===true;
                this.cancelable=options.cancelable===true;
                this.defaultPrevented=false;
            }

            preventDefault() {
                if(this.cancelable){
                    this.defaultPrevented=true;
                }
            }
        }

        function element() {
            const listeners=new Map();
            return {
                hidden:false,
                disabled:false,
                textContent:'',
                attributes:new Map(),
                listeners,
                setAttribute(name,value) {
                    this.attributes.set(name,String(value));
                },
                addEventListener(name,listener) {
                    listeners.set(name,listener);
                },
                removeEventListener(name,listener) {
                    if(listeners.get(name)===listener){
                        listeners.delete(name);
                    }
                }
            };
        }

        const panel=element();
        const title=element();
        const status=element();
        const button=element();
        const events=[];
        const intents=[];
        let preventNextRequest=false;
        let activationFailure=null;
        let activationResult=null;
        const host={
            dispatchEvent(event) {
                events.push(event);
                if(preventNextRequest&&event.type==='chat-ai-activation-request'){
                    preventNextRequest=false;
                    event.preventDefault();
                }
                return !event.defaultPrevented;
            },
            async requestAIActivation(intent) {
                intents.push(intent);
                if(activationResult){
                    const result=activationResult;
                    activationResult=null;
                    return result;
                }
                if(activationFailure){
                    const error=activationFailure;
                    activationFailure=null;
                    throw error;
                }
            }
        };
        const activationReasons=Object.freeze({
            languageModelActivationRequested:'language-model-activation-requested',
            languageModelActivationRejected:'language-model-activation-rejected'
        });
        const activationErrorCodes=Object.freeze({
            languageModelActivationRejected:'ARCANE_CHAT_LANGUAGE_MODEL_ACTIVATION_REQUEST_REJECTED'
        });
        let operationSequence=0;
        function publishActivation(type,detail,options={}){
            const event=new ActivationEvent(type,{
                detail,
                bubbles:options.bubbles,
                composed:options.composed,
                cancelable:options.cancelable
            });
            event.operationId=options.operationId??null;
            event.publicDetail=Object.freeze({...options.publicDetail});
            return host.dispatchEvent(event);
        }
        const controller=createAIActivationController({
            host,
            panel,
            title,
            status,
            button,
            publish:publishActivation,
            createOperationId(){
                operationSequence+=1;
                return `chat-test:llm-activation:${operationSequence}`;
            },
            readErrorFields(error,boundaryCode){
                const causeCode=typeof error?.code==='string'?error.code.trim():'';
                return Object.freeze({
                    code:boundaryCode,
                    ...(causeCode&&causeCode!==boundaryCode?{causeCode}:{})
                });
            },
            reasons:activationReasons,
            errorCodes:activationErrorCodes
        });
        assert.ok(Object.isFrozen(controller));
        assert.equal(intents.length,0);

        const unloaded=Object.freeze({
            role:'llm',
            state:'unloaded',
            providerId:'browser-llm',
            modelId:'selected-model',
            localOnly:true,
            progress:null,
            error:null
        });
        controller.synchronize(unloaded);
        assert.equal(panel.hidden,false);
        assert.equal(panel.attributes.get('aria-busy'),'false');
        assert.equal(title.textContent,'Language model not active');
        assert.equal(button.textContent,'Start language model');
        assert.equal(button.disabled,false);
        assert.equal(intents.length,0,'state observation must never start a model');

        assert.equal(await controller.request('load'),true);
        assert.deepEqual(intents,[{role:'llm',action:'load',reason:'user'}]);
        assert.ok(Object.isFrozen(intents[0]));
        const loadEvent=events.find(
            function findLoadRequest(event) {
                return event.type==='chat-ai-activation-request'
                    &&event.detail.intent.action==='load';
            }
        );
        assert.ok(loadEvent);
        assert.equal(loadEvent.bubbles,true);
        assert.equal(loadEvent.composed,true);
        assert.equal(loadEvent.cancelable,true);
        assert.equal(
            loadEvent.publicDetail.reason,
            activationReasons.languageModelActivationRequested
        );
        assert.match(loadEvent.operationId,/^chat-test:llm-activation:/u);
        assert.equal(loadEvent.detail.state,unloaded);
        assert.ok(Object.isFrozen(loadEvent.detail));

        preventNextRequest=true;
        assert.equal(await controller.request('load'),false);
        assert.equal(intents.length,1,'preventDefault must suppress the activation callback');

        const loading=Object.freeze({
            ...unloaded,
            state:'loading',
            progress:Object.freeze({
                phase:'download',
                completed:4,
                total:10,
                unit:'bytes',
                heartbeat:true
            })
        });
        controller.synchronize(loading);
        assert.equal(panel.attributes.get('aria-busy'),'true');
        assert.equal(title.textContent,'Starting language model');
        assert.match(status.textContent,/download, 4 of 10 bytes, active heartbeat/u);
        assert.equal(button.textContent,'Cancel loading');
        assert.equal(await controller.request('unload'),true);
        assert.deepEqual(intents.at(-1),{role:'llm',action:'unload',reason:'user'});

        controller.synchronize(Object.freeze({...unloaded,state:'unloading'}));
        assert.equal(title.textContent,'Canceling language model load');
        assert.equal(button.disabled,true);

        const runtimeFailure=new Error('Runtime authority rejected the selected model.');
        controller.synchronize(Object.freeze({...unloaded,state:'error',error:runtimeFailure}));
        assert.equal(title.textContent,'Language model activation failed');
        assert.equal(status.textContent,runtimeFailure.message);
        assert.equal(button.textContent,'Try again');

        const callbackFailure=new Error('Activation callback failed.');
        callbackFailure.code='ARCANE_AI_RUNTIME_ACTIVATION_REJECTED';
        activationFailure=callbackFailure;
        assert.equal(await controller.request('load'),false);
        const errorEvent=events.at(-1);
        assert.equal(errorEvent.type,'chat-ai-activation-error');
        assert.equal(errorEvent.bubbles,true);
        assert.equal(errorEvent.composed,true);
        assert.equal(errorEvent.detail.error,callbackFailure);
        assert.equal(errorEvent.detail.message,callbackFailure.message);
        assert.equal(errorEvent.detail.request.intent.action,'load');
        assert.equal(
            errorEvent.publicDetail.code,
            activationErrorCodes.languageModelActivationRejected
        );
        assert.equal(
            errorEvent.publicDetail.causeCode,
            callbackFailure.code
        );
        assert.equal(
            errorEvent.publicDetail.reason,
            activationReasons.languageModelActivationRejected
        );
        assert.ok(Object.isFrozen(errorEvent.detail));
        assert.ok(Object.isFrozen(errorEvent.publicDetail));

        let rejectSupersededActivation;
        activationResult=new Promise(
            function createSupersededActivation(resolve,reject){
                rejectSupersededActivation=reject;
            }
        );
        controller.synchronize(Object.freeze({...unloaded,state:'error'}));
        const supersededActivation=controller.request('load');
        await Promise.resolve();
        const activationErrorsBeforeSupersession=events.filter(
            event=>event.type==='chat-ai-activation-error'
        ).length;
        controller.synchronize(Object.freeze({
            ...unloaded,
            state:'loading',
            operationId:'replacement-llm-operation'
        }));
        rejectSupersededActivation(
            Object.assign(
                new Error('The superseded activation settled late.'),
                {code:'ARCANE_AI_RUNTIME_ACTIVATION_REJECTED'}
            )
        );
        assert.equal(await supersededActivation,false);
        assert.equal(
            events.filter(event=>event.type==='chat-ai-activation-error').length,
            activationErrorsBeforeSupersession,
            'sticky role supersession must suppress stale activation failure settlement'
        );

        controller.synchronize(Object.freeze({...unloaded,state:'ready'}));
        assert.equal(panel.hidden,true);
        assert.match(
            source,
            /llm:snapshot[.]roles[.]llm[.]state==='ready'/u,
            'Send availability must remain bound to the sticky ready state.'
        );
        assert.match(
            source,
            /stt:latestAIRuntimeRoles[\s\S]*latestAIRuntimeRoles[.]stt[.]state==='ready'/u,
            'Speech readiness must remain bound to sticky STT state.'
        );
        assert.doesNotMatch(
            source,
            /speech[.]setAvailability/u,
            'Chat compatibility availability must not synthesize speech readiness.'
        );
        const dispatchStart=source.indexOf('function dispatchChatEvent(');
        const dispatchEnd=source.indexOf('\n\n    function publicErrorFields',dispatchStart);
        const ownershipStart=source.indexOf('function isAbortSignal(value)');
        const ownershipEnd=source.indexOf('\n\n    host.sendMessage=',ownershipStart);
        const submissionStart=source.indexOf('function observeHostSubmission(');
        const submissionEnd=source.indexOf(
            '\n\n    async function receivedMessage',
            submissionStart
        );
        for(const boundary of [
            dispatchStart,
            dispatchEnd,
            ownershipStart,
            ownershipEnd,
            submissionStart,
            submissionEnd
        ]){
            assert.notEqual(boundary,-1);
        }
        const createChatSubmissionHarness=Function(
            'ActivationEvent',
            `'use strict';
            return function createChatSubmissionHarness({cancelProjection=false}={}){
                const aiRuntimeStateAbortController=new AbortController();
                const activeSubmissionOwnerships=new Set();
                const chatReasons=Object.freeze({
                    messageSubmissionRequested:'message-submission-requested',
                    messageSubmissionCancelled:'message-submission-cancelled',
                    callerSignalAborted:'caller-signal-aborted',
                    componentDestroyed:'component-destroyed',
                    hostMessageSubmissionRejected:'host-message-submission-rejected'
                });
                const chatErrorCodes=Object.freeze({
                    messageSubmissionAborted:'ARCANE_CHAT_MESSAGE_SUBMISSION_ABORTED',
                    hostMessageSubmissionRejected:'ARCANE_CHAT_HOST_MESSAGE_SUBMISSION_REJECTED'
                });
                let destroyed=false;
                let eventOperationSequence=0;
                let hostSubmissionGeneration=0;
                let canonicalDispatchCount=0;
                let projectionCount=0;
                let projectedEvent=null;
                let resolveHost;
                let rejectHost;
                const hostResult=new Promise(function createHostResult(resolve,reject){
                    resolveHost=resolve;
                    rejectHost=reject;
                });
                const sent=[];
                const host={
                    name:'User',
                    conversationComplete:false,
                    aiAvailability:{llm:true,tts:false},
                    dispatchEvent(event){
                        projectedEvent=event;
                        if(cancelProjection){
                            event.preventDefault();
                        }
                        return !event.defaultPrevented;
                    },
                    sendMessage(text,context){
                        sent.push({text,context,argumentCount:arguments.length});
                        return hostResult;
                    }
                };
                const events={
                    descriptor:Object.freeze({instanceId:'chat-contract'}),
                    dispatch(type,detail,options={}){
                        canonicalDispatchCount+=1;
                        return Object.freeze({
                            accepted:true,
                            occurrence:Object.freeze({
                                type,
                                detail:Object.freeze({...detail}),
                                operationId:options.operationId??null,
                                publicDetail:Object.freeze({...options.publicDetail}),
                                cancelable:options.cancelable===true
                            })
                        });
                    }
                };
                function projectArcaneDOMEvent(target,occurrence,options={}){
                    projectionCount+=1;
                    const event=new ActivationEvent(occurrence.type,{
                        detail:occurrence.detail,
                        bubbles:options.bubbles,
                        composed:options.composed,
                        cancelable:options.cancelable
                    });
                    event.operationId=occurrence.operationId;
                    event.publicDetail=occurrence.publicDetail;
                    target.dispatchEvent(event);
                    return !event.defaultPrevented;
                }
                function nextChatOperationId(kind){
                    eventOperationSequence+=1;
                    return \`chat-contract:\${kind}:\${eventOperationSequence}\`;
                }
                function getMilTime(){return '00:00';}
                class MD{
                    constructor(text){this.rendered=text;}
                }
                const textArea={value:'Cancel this message.'};
                const chatOutput={innerHTML:'',scrollTop:0,scrollHeight:0};
                const speech={muted:true};
                const hostSubmissionBarrier={
                    track(value){return Promise.resolve(value);}
                };
                ${source.slice(ownershipStart,ownershipEnd)}
                ${source.slice(dispatchStart,dispatchEnd)}
                ${source.slice(submissionStart,submissionEnd)}
                const callerController=new AbortController();
                const submission=submitMessage('',{
                    source:'user',
                    signal:callerController.signal
                });
                return Object.freeze({
                    submission,
                    callerController,
                    resolveHost,
                    rejectHost,
                    destroy(){
                        if(destroyed)return;
                        destroyed=true;
                        const reason=createChatSubmissionAbort(
                            chatReasons.componentDestroyed,
                            'The chat component was destroyed before message submission settled.'
                        );
                        for(const ownership of [...activeSubmissionOwnerships]){
                            ownership.abort(reason);
                        }
                        aiRuntimeStateAbortController.abort(reason);
                    },
                    state(){
                        return Object.freeze({
                            sent:[...sent],
                            canonicalDispatchCount,
                            projectionCount,
                            projectedEvent,
                            activeSubmissionCount:activeSubmissionOwnerships.size
                        });
                    }
                });
            };`
        )(ActivationEvent);

        const cancelledSubmission=createChatSubmissionHarness({cancelProjection:true});
        assert.equal(await cancelledSubmission.submission,false);
        const cancelledState=cancelledSubmission.state();
        assert.equal(cancelledState.canonicalDispatchCount,1);
        assert.equal(cancelledState.projectionCount,1);
        assert.equal(cancelledState.sent.length,0);
        assert.equal(cancelledState.projectedEvent.defaultPrevented,true);
        assert.equal(cancelledState.projectedEvent.operationId,'chat-contract:message:1');
        assert.ok(Object.isFrozen(cancelledState.projectedEvent.detail.context));
        assert.equal(cancelledState.projectedEvent.detail.context.signal.aborted,true);
        assert.equal(
            cancelledState.projectedEvent.detail.context.signal.reason.code,
            'ARCANE_CHAT_MESSAGE_SUBMISSION_ABORTED'
        );
        assert.equal(cancelledState.activeSubmissionCount,0);

        const callerCancelledSubmission=createChatSubmissionHarness();
        const callerCancelledState=callerCancelledSubmission.state();
        assert.equal(callerCancelledState.sent.length,1);
        assert.equal(callerCancelledState.sent[0].argumentCount,2);
        assert.notEqual(
            callerCancelledState.sent[0].context.signal,
            callerCancelledSubmission.callerController.signal
        );
        const callerAbortReason=new Error('Caller canceled the submission.');
        callerCancelledSubmission.callerController.abort(callerAbortReason);
        assert.equal(callerCancelledState.sent[0].context.signal.aborted,true);
        assert.equal(callerCancelledState.sent[0].context.signal.reason,callerAbortReason);
        callerCancelledSubmission.resolveHost(true);
        assert.equal(await callerCancelledSubmission.submission,false);
        assert.equal(callerCancelledSubmission.state().activeSubmissionCount,0);

        const destroyedSubmission=createChatSubmissionHarness();
        const destroyedContext=destroyedSubmission.state().sent[0].context;
        destroyedSubmission.destroy();
        assert.equal(destroyedContext.signal.aborted,true);
        assert.equal(
            destroyedContext.signal.reason.code,
            'ARCANE_CHAT_MESSAGE_SUBMISSION_ABORTED'
        );
        assert.equal(destroyedContext.signal.reason.reason,'component-destroyed');
        destroyedSubmission.rejectHost(new Error('Late host rejection.'));
        assert.equal(await destroyedSubmission.submission,false);
        assert.equal(destroyedSubmission.state().activeSubmissionCount,0);

        const retryStart=source.indexOf('function waitForConversationTimeboxRetry(');
        const retryEnd=source.indexOf('\n\n    host.ready=true',retryStart);
        assert.notEqual(retryStart,-1);
        assert.notEqual(retryEnd,-1);
        const retryHarness=Function(
            `'use strict';
            const aiRuntimeStateAbortController=new AbortController();
            ${source.slice(retryStart,retryEnd)}
            return Object.freeze({
                controller:aiRuntimeStateAbortController,
                wait:waitForConversationTimeboxRetry
            });`
        )();
        const retryWait=retryHarness.wait(100);
        retryHarness.controller.abort();
        assert.equal(await retryWait,false);
        assert.match(source,/<button type="button" id="ai_activation_button">/u);
        controller.destroy();
        assert.equal(button.listeners.has('click'),false);
        assert.equal(panel.hidden,true);
    }
);

test(
    'shared speech components expose explicit admitted STT activation without hidden startup',
    async function testSpeechSTTActivationContract() {
        const source = await readFile(
            new URL('runtime/arcane/components/speech.html', repositoryRoot),
            'utf8'
        );
        const voiceSource = await readFile(
            new URL(
                'runtime/arcane/components/voice-transcription.html',
                repositoryRoot
            ),
            'utf8'
        );

        class ActivationEvent {
            constructor(type, options = {}) {
                this.type = type;
                this.detail = options.detail;
                this.bubbles = options.bubbles === true;
                this.composed = options.composed === true;
                this.cancelable = options.cancelable === true;
                this.defaultPrevented = false;
            }

            preventDefault() {
                if (this.cancelable) {
                    this.defaultPrevented = true;
                }
            }
        }

        const listeners = new Map();
        const button = {
            addEventListener(name, listener) {
                listeners.set(name, listener);
            },
            removeEventListener(name, listener) {
                if (listeners.get(name) === listener) {
                    listeners.delete(name);
                }
            }
        };
        const events = [];
        const intents = [];
        let preventNextRequest = false;
        let reenterNextRequest = false;
        let reentrantRequest = null;
        let activationFailure = null;
        let deferredActivation = null;
        let synchronizeNextRequest = null;
        let controller;
        const host = {
            dispatchEvent(event) {
                events.push(event);
                if (reenterNextRequest
                    && event.type === 'speech-stt-activation-request') {
                    reenterNextRequest = false;
                    reentrantRequest = controller.request(
                        event.detail.intent.action
                    );
                    event.preventDefault();
                }
                if (preventNextRequest
                    && event.type === 'speech-stt-activation-request') {
                    preventNextRequest = false;
                    event.preventDefault();
                }
                if (synchronizeNextRequest
                    && event.type === 'speech-stt-activation-request') {
                    const nextRole = synchronizeNextRequest;
                    synchronizeNextRequest = null;
                    controller.synchronize(nextRole);
                }
                return !event.defaultPrevented;
            },
            async requestSTTActivation(intent) {
                intents.push(intent);
                if (deferredActivation) {
                    return deferredActivation.promise;
                }
                if (activationFailure) {
                    const error = activationFailure;
                    activationFailure = null;
                    throw error;
                }
            }
        };
        controller = createSTTActivationController(
            {
                host,
                button,
                onChange: function observeSTTActivationChange() {},
                EventClass: ActivationEvent
            }
        );
        assert.ok(Object.isFrozen(controller));
        assert.equal(intents.length, 0);

        const unloaded = Object.freeze(
            {
                role: 'stt',
                state: 'unloaded',
                providerId: 'browser-stt',
                modelId: 'selected-stt-model',
                localOnly: true,
                loaded: false,
                busy: false,
                operationId: null,
                progress: null,
                error: null
            }
        );
        controller.synchronize(unloaded);
        assert.equal(controller.action, 'load');
        assert.equal(controller.visible, true);
        assert.equal(controller.label, 'Start transcription');
        assert.equal(
            controller.status,
            'Transcription selected and waiting to load.'
        );
        assert.equal(intents.length, 0, 'state observation must never load STT');
        assert.equal(await controller.request('load'), true);
        assert.deepEqual(
            intents,
            [{role: 'stt', action: 'load', reason: 'user'}]
        );
        assert.ok(Object.isFrozen(intents[0]));
        const loadEvent = events.find(
            function findSTTLoadRequest(event) {
                return event.type === 'speech-stt-activation-request'
                    && event.detail.intent.action === 'load';
            }
        );
        assert.ok(loadEvent);
        assert.equal(loadEvent.bubbles, true);
        assert.equal(loadEvent.composed, true);
        assert.equal(loadEvent.cancelable, true);
        assert.equal(loadEvent.detail.state, unloaded);
        assert.ok(Object.isFrozen(loadEvent.detail));

        preventNextRequest = true;
        assert.equal(await controller.request('load'), false);
        assert.equal(intents.length, 1);

        reenterNextRequest = true;
        assert.equal(await controller.request('load'), false);
        assert.equal(await reentrantRequest, false);
        assert.equal(intents.length, 1, 'event reentry must not duplicate intent');

        const loading = Object.freeze(
            {
                ...unloaded,
                state: 'loading',
                operationId: 'stt-load-1',
                progress: Object.freeze(
                    {
                        phase: 'download',
                        completed: 4,
                        total: 10,
                        unit: 'bytes',
                        heartbeat: true
                    }
                )
            }
        );
        controller.synchronize(loading);
        assert.equal(controller.action, 'unload');
        assert.equal(controller.label, 'Cancel loading');
        assert.match(controller.status, /download, 4 of 10 bytes, active heartbeat/u);
        assert.equal(await controller.request('unload'), true);
        assert.deepEqual(
            intents.at(-1),
            {role: 'stt', action: 'unload', reason: 'user'}
        );
        controller.synchronize(
            Object.freeze(
                {
                    ...loading,
                    progress: Object.freeze(
                        {
                            ...loading.progress,
                            total: null,
                            heartbeat: false
                        }
                    )
                }
            )
        );
        assert.equal(
            controller.status,
            'Transcription download, 4 bytes; Cancel is available.'
        );

        controller.synchronize(
            Object.freeze({...loading, state: 'unloading', progress: null})
        );
        assert.equal(controller.action, null);
        assert.equal(controller.label, 'Canceling…');
        assert.match(controller.status, /releasing/u);

        const callbackFailure = new Error('STT activation callback failed.');
        controller.synchronize(Object.freeze({...unloaded, state: 'error'}));
        assert.equal(controller.label, 'Try again');
        synchronizeNextRequest = loading;
        assert.equal(await controller.request('load'), false);
        assert.equal(
            intents.at(-1).action,
            'unload',
            'synchronous state replacement must suppress the stale load intent'
        );
        controller.synchronize(Object.freeze({...unloaded, state: 'error'}));
        activationFailure = callbackFailure;
        assert.equal(await controller.request('load'), false);
        const errorEvent = events.at(-1);
        assert.equal(errorEvent.type, 'speech-stt-activation-error');
        assert.equal(errorEvent.detail.error, callbackFailure);
        assert.ok(Object.isFrozen(errorEvent.detail));

        let rejectDeferredActivation;
        const deferredPromise = new Promise(
            function createDeferredSTTActivation(resolve, reject) {
                rejectDeferredActivation = reject;
            }
        );
        deferredActivation = {promise: deferredPromise};
        const staleLoad = controller.request('load');
        controller.synchronize(loading);
        deferredActivation = null;
        assert.equal(await controller.request('unload'), true);
        const errorCount = events.filter(
            function countSTTActivationErrors(event) {
                return event.type === 'speech-stt-activation-error';
            }
        ).length;
        rejectDeferredActivation(new Error('Late stale activation failure.'));
        assert.equal(await staleLoad, false);
        assert.equal(
            events.filter(
                function countFinalSTTActivationErrors(event) {
                    return event.type === 'speech-stt-activation-error';
                }
            ).length,
            errorCount
        );

        controller.synchronize(
            Object.freeze(
                {
                    ...unloaded,
                    state: 'ready',
                    loaded: true,
                    busy: true,
                    operationId: 'stt-transcribe-1'
                }
            )
        );
        assert.equal(controller.action, null);
        assert.equal(controller.status, 'Transcription busy.');

        function createActivationReentrancyHarness(onChange) {
            const caseEvents = [];
            const caseIntents = [];
            let caseController;
            const caseHost = {
                dispatchEvent(event) {
                    caseEvents.push(event);
                    return !event.defaultPrevented;
                },
                async requestSTTActivation(intent) {
                    caseIntents.push(intent);
                }
            };
            caseController = createSTTActivationController(
                {
                    host: caseHost,
                    button: {
                        addEventListener() {},
                        removeEventListener() {}
                    },
                    onChange() {
                        onChange(caseController);
                    },
                    EventClass: ActivationEvent
                }
            );
            caseController.synchronize(unloaded);
            return {controller: caseController, events: caseEvents, intents: caseIntents};
        }

        let destroyOnChange = true;
        const destroyedOnChange = createActivationReentrancyHarness(
            function destroyActivationController(activeController) {
                if (destroyOnChange) {
                    destroyOnChange = false;
                    activeController.destroy();
                }
            }
        );
        assert.equal(await destroyedOnChange.controller.request('load'), false);
        assert.equal(destroyedOnChange.controller.pending, false);
        assert.deepEqual(destroyedOnChange.intents, []);

        let synchronizeOnChange = true;
        const synchronizedOnChange = createActivationReentrancyHarness(
            function replaceActivationState(activeController) {
                if (synchronizeOnChange) {
                    synchronizeOnChange = false;
                    activeController.synchronize(loading);
                }
            }
        );
        assert.equal(await synchronizedOnChange.controller.request('load'), false);
        assert.deepEqual(synchronizedOnChange.intents, []);

        let reentrantOnChangeRequest = null;
        const reenteredOnChange = createActivationReentrancyHarness(
            function reenterActivation(activeController) {
                if (!reentrantOnChangeRequest) {
                    reentrantOnChangeRequest = activeController.request('load');
                }
            }
        );
        assert.equal(await reenteredOnChange.controller.request('load'), true);
        assert.equal(await reentrantOnChangeRequest, false);
        assert.equal(reenteredOnChange.intents.length, 1);

        let throwOnChange = true;
        const failedOnChange = createActivationReentrancyHarness(
            function failActivationPresentation() {
                if (throwOnChange) {
                    throwOnChange = false;
                    throw new Error('STT presentation failed.');
                }
            }
        );
        assert.equal(await failedOnChange.controller.request('load'), false);
        assert.equal(failedOnChange.controller.pending, false);
        assert.deepEqual(failedOnChange.intents, []);
        assert.equal(
            failedOnChange.events.at(-1).type,
            'speech-stt-activation-error'
        );
        assert.match(
            source,
            /<button id="sttActivationButton" type="button" hidden disabled>/u
        );
        assert.match(
            source,
            /fetchSTT\([\s\S]*audioFile,[\s\S]*undefined,[\s\S]*controller[.]signal/u,
            'The shared STT request must receive its owned cancellation signal.'
        );
        assert.match(
            source,
            /function cancelSTTOperation[\s\S]*transcriptionAbortController[?][.]abort\(\)/u,
            'Shared STT cancellation must abort the active request controller.'
        );
        assert.match(
            source,
            /globalThis[.]ai[?][.]setSpeechMuted[\s\S]*setSpeechMuted\(action === 'unload'\)[\s\S]*requestAIRuntimeIntent/u,
            'TTS mute intent must reach the lifecycle owner before it is published.'
        );
        const errorFieldsStart = source.indexOf(
            'function publicSpeechErrorFields('
        );
        const errorFieldsEnd = source.indexOf(
            '\n\n    function microphoneFailureReason',
            errorFieldsStart
        );
        assert.notEqual(errorFieldsStart, -1);
        assert.notEqual(errorFieldsEnd, -1);
        const publicSpeechErrorFields = Function(
            `'use strict';\n${source.slice(errorFieldsStart, errorFieldsEnd)}\nreturn publicSpeechErrorFields;`
        )();
        const providerFailure = new Error('Provider synthesis failed.');
        providerFailure.code = 'ARCANE_AI_BROWSER_SPEECH_TTS_SYNTHESIS_REJECTED';
        const speechFailure = publicSpeechErrorFields(
            providerFailure,
            'ARCANE_SPEECH_TTS_SYNTHESIS_REQUEST_REJECTED'
        );
        assert.deepEqual(
            speechFailure,
            {
                code: 'ARCANE_SPEECH_TTS_SYNTHESIS_REQUEST_REJECTED',
                causeCode: 'ARCANE_AI_BROWSER_SPEECH_TTS_SYNTHESIS_REJECTED'
            }
        );
        assert.ok(Object.isFrozen(speechFailure));
        assert.deepEqual(
            publicSpeechErrorFields(
                Object.assign(
                    new Error('Boundary failure.'),
                    {code: 'ARCANE_SPEECH_TTS_SYNTHESIS_REQUEST_REJECTED'}
                ),
                'ARCANE_SPEECH_TTS_SYNTHESIS_REQUEST_REJECTED'
            ),
            {code: 'ARCANE_SPEECH_TTS_SYNTHESIS_REQUEST_REJECTED'}
        );
        assert.equal(
            source.match(/publicSpeechErrorFields\(/gu)?.length,
            5,
            'Every speech error projection must use the shared boundary/cause fields.'
        );
        assert.match(
            source,
            /Object[.]prototype[.]hasOwnProperty[.]call\(input, 'stt'\)[\s\S]*!Boolean\(input[.]stt\)[\s\S]*!selectedRole\(sttRole\)/u,
            'Speech compatibility input must neither create readiness nor replace a selected sticky STT role.'
        );

        const admissionStart = voiceSource.indexOf(
            'function canStartVoiceRecording('
        );
        const admissionEnd = voiceSource.indexOf(
            '\n\n    function optionsFromDataset',
            admissionStart
        );
        assert.notEqual(admissionStart, -1);
        assert.notEqual(admissionEnd, -1);
        const admissionSource = voiceSource.slice(admissionStart, admissionEnd);
        const canStartVoiceRecording = Function(
            `'use strict';\n${admissionSource}\nreturn canStartVoiceRecording;`
        )();
        const ready = Object.freeze(
            {
                ...unloaded,
                state: 'ready',
                loaded: true
            }
        );
        for (const unavailableState of [
            'unavailable',
            'unloaded',
            'loading',
            'unloading',
            'error',
            'disposed'
        ]) {
            assert.equal(
                canStartVoiceRecording(
                    Object.freeze({...unloaded, state: unavailableState}),
                    'idle',
                    false
                ),
                false
            );
        }
        assert.equal(canStartVoiceRecording(ready, 'idle', false), true);
        assert.equal(canStartVoiceRecording(ready, 'error', false), true);
        assert.equal(
            canStartVoiceRecording(Object.freeze({...ready, busy: true}), 'idle', false),
            false
        );
        assert.equal(canStartVoiceRecording(ready, 'recording', false), false);
        assert.equal(canStartVoiceRecording(ready, 'idle', true), false);

        assert.match(
            voiceSource,
            /setState\('starting'[\s\S]*recordingStartIsCurrent\(generation,'starting'\)[\s\S]*getUserMedia[\s\S]*recordingStartIsCurrent\(generation,'starting'\)[\s\S]*rejectRecordingStart\(generation,stream\)/u,
            'Starting reentrancy and ready-to-busy permission races must reject the returned stream.'
        );
        assert.match(
            voiceSource,
            /setState\('recording'[\s\S]*recordingStartIsCurrent\(generation,'recording'\)[\s\S]*rejectAssignedRecordingStart\(generation,stream\)/u,
            'Recording-state reentrancy must release the recorder and stream.'
        );
        assert.match(
            voiceSource,
            /const activeRecorder=recorder[\s\S]*setState\('transcribing'[\s\S]*recorder!==activeRecorder[\s\S]*activeRecorder[.]stop\(\)/u,
            'Stop must retain and recheck the recorder identity after state publication.'
        );
        const startLifecycleStart = voiceSource.indexOf(
            'async function startRecording()'
        );
        const startLifecycleEnd = voiceSource.indexOf(
            '\n\n    function createRecorder',
            startLifecycleStart
        );
        const createStartLifecycleHarness = Function(
            `'use strict';
            return function createStartLifecycleHarness(destroyOnState=''){
                let chunks=[];
                let mediaStream=null;
                let recorder=null;
                let state='idle';
                let sttRole={state:'ready',busy:false};
                let destroyed=false;
                let sessionGeneration=0;
                let permissionRequests=0;
                let resolvePermission;
                let recorderStarts=0;
                let recorderStops=0;
                let trackStops=0;
                const track={
                    addEventListener(){},
                    removeEventListener(){},
                    stop(){trackStops+=1;}
                };
                const stream={
                    getAudioTracks(){return [track];},
                    getTracks(){return [track];}
                };
                const options={
                    mediaConstraints:{audio:true},
                    messages:{
                        ready:'Ready.',
                        recording:'Recording.',
                        requesting:'Requesting.',
                        startError:'Start failed.',
                        unsupported:'Unsupported.'
                    }
                };
                class MediaRecorder {}
                const navigator={
                    mediaDevices:{
                        getUserMedia(){
                            permissionRequests+=1;
                            return new Promise(
                                resolve=>{resolvePermission=resolve;}
                            );
                        }
                    }
                };
                function setState(nextState){
                    state=nextState;
                    if(nextState===destroyOnState){
                        destroyed=true;
                        sessionGeneration+=1;
                        releaseMicrophone();
                        state='idle';
                    }
                }
                function createRecorder(){
                    return {
                        state:'inactive',
                        addEventListener(){},
                        removeEventListener(){},
                        start(){
                            this.state='recording';
                            recorderStarts+=1;
                        },
                        stop(){
                            this.state='inactive';
                            recorderStops+=1;
                        }
                    };
                }
                function stopMediaStream(activeStream){
                    for(const activeTrack of activeStream?.getTracks?.()||[]){
                        activeTrack.stop();
                    }
                }
                function releaseMicrophone(){
                    if(recorder?.state==='recording'){
                        recorder.stop();
                    }
                    stopMediaStream(mediaStream);
                    mediaStream=null;
                    recorder=null;
                    chunks=[];
                }
                function collectAudio(){}
                function finishRecording(){}
                function recordingError(){}
                function recordingInterrupted(){}
                ${admissionSource}
                ${voiceSource.slice(startLifecycleStart, startLifecycleEnd)}
                return Object.freeze({
                    busy(){sttRole={...sttRole,busy:true};},
                    get permissionRequests(){return permissionRequests;},
                    get recorderStarts(){return recorderStarts;},
                    get recorderStops(){return recorderStops;},
                    resolve(){resolvePermission?.(stream);},
                    start:startRecording,
                    get state(){return state;},
                    get trackStops(){return trackStops;}
                });
            };`
        )();
        const busyDuringPermission = createStartLifecycleHarness();
        const busyStart=busyDuringPermission.start();
        busyDuringPermission.busy();
        busyDuringPermission.resolve();
        assert.equal(await busyStart, false);
        assert.equal(busyDuringPermission.permissionRequests, 1);
        assert.equal(busyDuringPermission.recorderStarts, 0);
        assert.equal(busyDuringPermission.trackStops, 1);
        assert.equal(busyDuringPermission.state, 'idle');

        const destroyedWhileStarting = createStartLifecycleHarness('starting');
        assert.equal(await destroyedWhileStarting.start(), false);
        assert.equal(destroyedWhileStarting.permissionRequests, 0);

        const destroyedWhileRecording = createStartLifecycleHarness('recording');
        const destroyedRecordingStart=destroyedWhileRecording.start();
        destroyedWhileRecording.resolve();
        assert.equal(await destroyedRecordingStart, false);
        assert.equal(destroyedWhileRecording.recorderStarts, 1);
        assert.equal(destroyedWhileRecording.recorderStops, 1);
        assert.equal(destroyedWhileRecording.trackStops, 1);

        const stopLifecycleStart = voiceSource.indexOf(
            'function stopRecording()'
        );
        const stopLifecycleEnd = voiceSource.indexOf(
            '\n\n    async function finishRecording',
            stopLifecycleStart
        );
        const stopDuringDestroy = Function(
            `'use strict';
            let state='recording';
            let destroyed=false;
            let sessionGeneration=9;
            let stopCalls=0;
            let recorder={state:'recording',stop(){stopCalls+=1;}};
            const options={messages:{transcribing:'Transcribing.'}};
            function isCurrentVoiceOperation(generation,expectedState){
                return !destroyed
                    &&generation===sessionGeneration
                    &&state===expectedState;
            }
            function setState(nextState){
                state=nextState;
                destroyed=true;
                sessionGeneration+=1;
                recorder=null;
                state='idle';
            }
            ${voiceSource.slice(stopLifecycleStart, stopLifecycleEnd)}
            return Object.freeze({
                run:stopRecording,
                get stopCalls(){return stopCalls;}
            });`
        )();
        assert.equal(stopDuringDestroy.run(), false);
        assert.equal(stopDuringDestroy.stopCalls, 0);
        assert.match(
            voiceSource,
            /<button id="start" type="button" disabled><\/button>[\s\S]*<button id="sttActivation" type="button" hidden disabled>/u
        );
        assert.match(
            voiceSource,
            /subscribeAIRuntimeState\([\s\S]*synchronizeAIRuntimeState,[\s\S]*signal:runtimeStateAbortController[.]signal/u
        );
        assert.match(
            voiceSource,
            /async function startRecording\(\)\{[\s\S]*!canStartVoiceRecording\(sttRole,state,destroyed\)[\s\S]*getUserMedia/u,
            'Programmatic recording must fail before microphone access when STT is not admitted.'
        );
        assert.match(
            voiceSource,
            /return globalThis[.]ai[.]fetchSTT\(file,undefined,signal\)/u,
            'The default voice path must preserve the AI.fetchSTT callback position and owned signal.'
        );
        assert.match(
            voiceSource,
            /signal:controller[.]signal[\s\S]*return options[.]transcribe\(file,context\)/u,
            'Injected transcribers must receive the owned signal additively in their existing context.'
        );
        const releaseStart = voiceSource.indexOf(
            'function releaseTranscriptionController('
        );
        const releaseEnd = voiceSource.indexOf(
            '\n\n    async function transcribeAudio',
            releaseStart
        );
        assert.notEqual(releaseStart, -1);
        assert.notEqual(releaseEnd, -1);
        const releaseSource = voiceSource.slice(releaseStart, releaseEnd);
        const controllerOwnership = Function(
            `'use strict';
            let transcriptionAbortController=null;
            ${releaseSource}
            return Object.freeze({
                get active(){return transcriptionAbortController;},
                release:releaseTranscriptionController,
                set active(value){transcriptionAbortController=value;}
            });`
        )();
        const staleController = new AbortController();
        const currentController = new AbortController();
        controllerOwnership.active = staleController;
        staleController.abort();
        controllerOwnership.active = currentController;
        assert.equal(staleController.signal.aborted, true);
        assert.equal(currentController.signal.aborted, false);
        assert.equal(controllerOwnership.release(staleController), false);
        assert.equal(
            controllerOwnership.active,
            currentController,
            'An abort-ignoring stale transcription must not clear the newer request controller.'
        );
        assert.equal(controllerOwnership.release(currentController), true);
        assert.equal(controllerOwnership.active, null);

        const replacementStart = voiceSource.indexOf(
            'function supersedeForTranscriptReplacement()'
        );
        const replacementEnd = voiceSource.indexOf(
            '\n\n    function clear',
            replacementStart
        );
        const completionStart = voiceSource.indexOf(
            'async function completeStream()'
        );
        const completionEnd = voiceSource.indexOf(
            '\n\n    function supersedeForTranscriptReplacement',
            completionStart
        );
        const transcribeAwait = voiceSource.indexOf(
            'const result=await transcribeAudio('
        );
        const transcribeSegment = voiceSource.indexOf(
            "const segment=typeof result==='string'",
            transcribeAwait
        );
        const saveBlockStart = voiceSource.indexOf(
            'if(options.persist){',
            transcribeSegment
        );
        const saveBlockEnd = voiceSource.indexOf(
            '\n            const detail=',
            saveBlockStart
        );
        const createReplacementHarness = Function(
            `'use strict';
            return function createReplacementHarness(
                initialState,
                withController=true,
                settings={}
            ){
                let state=initialState;
                let transcript='original';
                let sessionGeneration=12;
                let destroyed=false;
                const controller=withController?new AbortController():null;
                let transcriptionAbortController=controller;
                let releases=0;
                const cancellations=[];
                const events=[];
                const transitions=[];
                const options={
                    onComplete:settings.onComplete,
                    onSave:settings.onSave,
                    persist:true,
                    messages:{
                        complete:'Complete.',
                        completeError:'Completion failed.',
                        completing:'Completing.',
                        ready:'Ready.',
                        saveError:'Save failed.',
                        saving:'Saving.',
                        transcriptReplaced:'Transcript replaced.'
                    }
                };
                const sttRole={state:'ready'};
                const host={
                    dispatchEvent(event){
                        events.push(event);
                        if(event.type===settings.replaceOnEvent){
                            setValue('replacement');
                        }
                    }
                };
                class CustomEvent {
                    constructor(type,{detail}){
                        this.type=type;
                        this.detail=detail;
                    }
                }
                function releaseMicrophone(){releases+=1;}
                function renderTranscript(){}
                function reportSTTCancellation(reason,message){
                    cancellations.push({reason,message});
                    state='idle';
                }
                function dispatchVoiceEvent(type,compatibilityDetail){
                    const event=new CustomEvent(type,{detail:compatibilityDetail});
                    host.dispatchEvent(event);
                    return true;
                }
                function setState(nextState){
                    state=nextState;
                    transitions.push(nextState);
                    if(nextState===settings.replaceOnState){
                        setValue('replacement');
                    }
                    if(nextState===settings.destroyOnState){
                        destroyed=true;
                        sessionGeneration+=1;
                        state='idle';
                    }
                }
                function isCurrentVoiceOperation(generation,expectedState){
                    return !destroyed
                        &&generation===sessionGeneration
                        &&state===expectedState;
                }
                function releaseTranscriptionController(activeController){
                    if(transcriptionAbortController!==activeController){
                        return false;
                    }
                    transcriptionAbortController=null;
                    return true;
                }
                function transcribeAudio(file,context,signal){
                    return settings.transcribe(file,context,signal);
                }
                ${voiceSource.slice(completionStart, completionEnd)}
                ${voiceSource.slice(replacementStart, replacementEnd)}
                async function settleTranscription(){
                    const generation=sessionGeneration;
                    const controller=transcriptionAbortController;
                    const file={};
                    const audio={};
                    const mimeType='audio/webm';
                    ${voiceSource.slice(transcribeAwait, transcribeSegment)}
                    return result;
                }
                async function persistSegment(){
                    const generation=sessionGeneration;
                    const segment='segment';
                    ${voiceSource.slice(saveBlockStart, saveBlockEnd)}
                    return isCurrentVoiceOperation(generation,'saving');
                }
                return Object.freeze({
                    get cancellations(){return cancellations;},
                    complete:completeStream,
                    get controller(){return controller;},
                    get events(){return events;},
                    get generation(){return sessionGeneration;},
                    isCurrent:isCurrentVoiceOperation,
                    get releases(){return releases;},
                    persist:persistSegment,
                    set:setValue,
                    settleTranscription,
                    get state(){return state;},
                    get transcript(){return transcript;},
                    get transitions(){return transitions;}
                });
            };`
        )();
        for (const activeState of [
            'starting',
            'transcribing',
            'saving',
            'completing'
        ]) {
            const replacement = createReplacementHarness(activeState);
            const operationGeneration = replacement.generation;
            assert.equal(replacement.set('replacement'), 'replacement');
            assert.equal(replacement.generation, operationGeneration + 1);
            assert.equal(replacement.controller.signal.aborted, true);
            assert.equal(replacement.releases, 1);
            assert.equal(replacement.state, 'idle');
            assert.equal(
                replacement.isCurrent(operationGeneration, activeState),
                false,
                `Late ${activeState} settlement must be stale after transcript replacement.`
            );
            assert.deepEqual(
                replacement.cancellations,
                [{reason: 'transcript-replaced', message: 'Transcript replaced.'}]
            );
            assert.equal(replacement.events.at(-1).type, 'voice-transcription-change');
            assert.deepEqual(
                replacement.events.at(-1).detail,
                {transcript: 'replacement'}
            );
        }
        const recordingReplacement = createReplacementHarness('recording', false);
        const recordingGeneration = recordingReplacement.generation;
        recordingReplacement.set('replacement');
        assert.equal(recordingReplacement.generation, recordingGeneration);
        assert.equal(recordingReplacement.releases, 0);
        assert.deepEqual(recordingReplacement.cancellations, []);
        assert.equal(recordingReplacement.state, 'recording');

        let resolveLateTranscription;
        const lateTranscription = createReplacementHarness(
            'transcribing',
            true,
            {
                transcribe(){
                    return new Promise(
                        resolve=>{resolveLateTranscription=resolve;}
                    );
                }
            }
        );
        const pendingTranscription=lateTranscription.settleTranscription();
        lateTranscription.set('replacement');
        resolveLateTranscription('stale segment');
        assert.equal(await pendingTranscription, false);
        assert.equal(lateTranscription.transcript, 'replacement');

        let savingStateCallbacks=0;
        const replacedOnSaving = createReplacementHarness(
            'transcribing',
            false,
            {
                replaceOnState:'saving',
                onSave(){savingStateCallbacks+=1;}
            }
        );
        assert.equal(await replacedOnSaving.persist(), false);
        assert.equal(savingStateCallbacks, 0);

        let destroyedSavingCallbacks=0;
        const destroyedOnSaving = createReplacementHarness(
            'transcribing',
            false,
            {
                destroyOnState:'saving',
                onSave(){destroyedSavingCallbacks+=1;}
            }
        );
        assert.equal(await destroyedOnSaving.persist(), false);
        assert.equal(destroyedSavingCallbacks, 0);

        let resolveLateSave;
        let saveInput=null;
        const lateSave = createReplacementHarness(
            'transcribing',
            false,
            {
                onSave(input){
                    saveInput=input;
                    return new Promise(resolve=>{resolveLateSave=resolve;});
                }
            }
        );
        const pendingSave=lateSave.persist();
        lateSave.set('replacement');
        resolveLateSave();
        assert.equal(await pendingSave, false);
        assert.deepEqual(
            saveInput,
            {transcript:'original',segment:'segment'}
        );
        assert.equal(lateSave.transcript, 'replacement');

        let completingStateCallbacks=0;
        const destroyedOnCompleting = createReplacementHarness(
            'idle',
            false,
            {
                destroyOnState:'completing',
                onComplete(){completingStateCallbacks+=1;}
            }
        );
        assert.equal(await destroyedOnCompleting.complete(), false);
        assert.equal(completingStateCallbacks, 0);

        let resolveLateCompletion;
        let completionInput=null;
        const lateCompletion = createReplacementHarness(
            'idle',
            false,
            {
                onComplete(input){
                    completionInput=input;
                    return new Promise(resolve=>{resolveLateCompletion=resolve;});
                }
            }
        );
        const pendingCompletion=lateCompletion.complete();
        lateCompletion.set('replacement');
        resolveLateCompletion();
        assert.equal(await pendingCompletion, false);
        assert.deepEqual(completionInput, {transcript:'original'});
        assert.equal(
            lateCompletion.events.some(event=>
                event.type==='voice-transcription-complete'
            ),
            false
        );
        assert.equal(lateCompletion.transcript, 'replacement');

        const replacedFromCompletionEvent = createReplacementHarness(
            'idle',
            false,
            {
                onComplete(){},
                replaceOnEvent:'voice-transcription-complete'
            }
        );
        assert.equal(await replacedFromCompletionEvent.complete(), false);
        assert.deepEqual(
            replacedFromCompletionEvent.events[0].detail,
            {transcript:'original'}
        );
        assert.equal(replacedFromCompletionEvent.state, 'idle');
        assert.equal(
            replacedFromCompletionEvent.transitions.includes('complete'),
            false
        );

        const destroyedOnCompleteState = createReplacementHarness(
            'idle',
            false,
            {destroyOnState:'complete',onComplete(){}}
        );
        assert.equal(await destroyedOnCompleteState.complete(), false);
        assert.deepEqual(
            destroyedOnCompleteState.transitions,
            ['completing','complete']
        );
        assert.match(
            voiceSource,
            /value:\{get:\(\)=>transcript,set:setValue\}/u
        );
        assert.match(
            voiceSource,
            /hasOwnProperty[.]call\(input\|\|\{\},'initialValue'\)[\s\S]*if\(setInitial\)\{[\s\S]*setValue\(options[.]initialValue\)/u
        );

        const successStart = voiceSource.indexOf(
            'function reportTranscriptionSuccess('
        );
        const successEnd = voiceSource.indexOf(
            '\n\n    function releaseTranscriptionController',
            successStart
        );
        const createSuccessHarness = Function(
            `'use strict';
            return function createSuccessHarness(
                eventAction='',
                destroyOnIdle=false,
                destroyOnEvent=false
            ){
                let destroyed=false;
                let state='transcribing';
                let sessionGeneration=21;
                const events=[];
                const transitions=[];
                const controls={
                    destroy(){
                        destroyed=true;
                        sessionGeneration+=1;
                        state='idle';
                    },
                    replace(){
                        sessionGeneration+=1;
                        state='idle';
                    }
                };
                const host={
                    dispatchEvent(event){
                        events.push(event.type);
                        if(event.type===eventAction){
                            controls[destroyOnEvent?'destroy':'replace']();
                        }
                    }
                };
                class CustomEvent {
                    constructor(type,{detail}){
                        this.type=type;
                        this.detail=detail;
                    }
                }
                function dispatchVoiceEvent(type,compatibilityDetail){
                    const event=new CustomEvent(type,{detail:compatibilityDetail});
                    host.dispatchEvent(event);
                    return true;
                }
                function isCurrentVoiceOperation(generation,expectedState){
                    return !destroyed
                        &&generation===sessionGeneration
                        &&state===expectedState;
                }
                function setState(nextState){
                    state=nextState;
                    transitions.push(nextState);
                    if(nextState==='idle'&&destroyOnIdle){controls.destroy();}
                }
                ${voiceSource.slice(successStart, successEnd)}
                const generation=sessionGeneration;
                return Object.freeze({
                    events,
                    run(){
                        return reportTranscriptionSuccess(
                            generation,
                            'transcribing',
                            {text:'segment',transcript:'original segment'},
                            'Transcribed.'
                        );
                    },
                    get state(){return state;},
                    transitions
                });
            };`
        )();
        const replacedFromFirstSuccess = createSuccessHarness(
            'speech-transcription-complete'
        );
        assert.equal(replacedFromFirstSuccess.run(), false);
        assert.deepEqual(
            replacedFromFirstSuccess.events,
            ['speech-transcription-complete']
        );
        assert.deepEqual(replacedFromFirstSuccess.transitions, []);

        const destroyedFromFirstSuccess = createSuccessHarness(
            'speech-transcription-complete',
            false,
            true
        );
        assert.equal(destroyedFromFirstSuccess.run(), false);
        assert.deepEqual(
            destroyedFromFirstSuccess.events,
            ['speech-transcription-complete']
        );
        assert.deepEqual(destroyedFromFirstSuccess.transitions, []);

        const replacedFromSegment = createSuccessHarness(
            'voice-transcription-segment'
        );
        assert.equal(replacedFromSegment.run(), false);
        assert.deepEqual(
            replacedFromSegment.events,
            ['speech-transcription-complete', 'voice-transcription-segment']
        );
        assert.deepEqual(replacedFromSegment.transitions, []);

        const destroyedFromIdleState = createSuccessHarness('', true);
        assert.equal(destroyedFromIdleState.run(), false);
        assert.deepEqual(destroyedFromIdleState.transitions, ['idle']);

        const transcribeSettlementGuard = voiceSource.indexOf(
            'generation!==sessionGeneration',
            transcribeAwait
        );
        assert.ok(
            transcribeAwait<transcribeSettlementGuard
            &&transcribeSettlementGuard<transcribeSegment,
            'Transcript replacement must invalidate a late transcription before it can append.'
        );
        const saveAwait = voiceSource.indexOf(
            'await save({transcript,segment});'
        );
        const saveSettlementGuard = voiceSource.indexOf(
            "isCurrentVoiceOperation(generation,'saving')",
            saveAwait
        );
        const successCall = voiceSource.indexOf(
            'return reportTranscriptionSuccess(',
            saveAwait
        );
        assert.ok(
            saveAwait<saveSettlementGuard&&saveSettlementGuard<successCall,
            'Transcript replacement must invalidate a late save before success events.'
        );

        const initialState = voiceSource.lastIndexOf(
            "setState('idle',options.messages.ready);"
        );
        const guardedSubscription = voiceSource.indexOf(
            'if(!destroyed){',
            initialState
        );
        const subscription = voiceSource.indexOf(
            'subscribeAIRuntimeState(',
            guardedSubscription
        );
        const guardedReady = voiceSource.indexOf(
            'if(!destroyed){',
            subscription
        );
        const readyPublication = voiceSource.indexOf(
            'host.ready=true;',
            guardedReady
        );
        assert.ok(
            initialState<guardedSubscription
            &&guardedSubscription<subscription
            &&subscription<guardedReady
            &&guardedReady<readyPublication,
            'Synchronous teardown must prevent subscription or ready publication during initialization.'
        );
        const initializationEnd = voiceSource.indexOf(
            '\n</script>',
            initialState
        );
        const createInitializationHarness = Function(
            `'use strict';
            return function createInitializationHarness(destroyAt){
                let destroyed=false;
                let transcript='';
                let subscriptions=0;
                const events=[];
                const options={
                    initialValue:'initial',
                    messages:{ready:'Ready.'}
                };
                const host={
                    ready:false,
                    dispatchEvent(event){events.push(event.type);}
                };
                class CustomEvent {
                    constructor(type){this.type=type;}
                }
                const runtimeStateAbortController={signal:{}};
                function renderOptions(){}
                function renderTranscript(){}
                function setState(){
                    if(destroyAt==='state'){destroyed=true;}
                }
                function synchronizeAIRuntimeState(){
                    if(destroyAt==='subscription'){destroyed=true;}
                }
                function subscribeAIRuntimeState(callback){
                    subscriptions+=1;
                    callback();
                }
                ${voiceSource.slice(initialState, initializationEnd)}
                return Object.freeze({events,ready:host.ready,subscriptions});
            };`
        )();
        assert.deepEqual(
            createInitializationHarness('state'),
            {events:[],ready:false,subscriptions:0}
        );
        assert.deepEqual(
            createInitializationHarness('subscription'),
            {events:[],ready:false,subscriptions:1}
        );
        assert.match(
            voiceSource,
            /finally\{[\s\S]*releaseTranscriptionController\(controller\)/u,
            'Every transcription settlement must use the identity-checked release boundary.'
        );
        assert.match(
            voiceSource,
            /setState\('saving',options[.]messages[.]saving\)[\s\S]*isCurrentVoiceOperation\(generation,'saving'\)[\s\S]*await save\(\{transcript,segment\}\)[\s\S]*catch\(error\)\{[\s\S]*isCurrentVoiceOperation\(generation,'saving'\)[\s\S]*return reportTranscriptionSuccess/u,
            'Save settlement must suppress stale teardown errors and success events.'
        );
        const saveCatchStart = voiceSource.indexOf(
            'await save({transcript,segment});'
        );
        const saveCatchEnd = voiceSource.indexOf(
            '\n                }',
            saveCatchStart
        );
        const saveCatchSource = voiceSource.slice(saveCatchStart, saveCatchEnd);
        assert.doesNotMatch(
            saveCatchSource,
            /isTranscriptionCancellation/u,
            'A current app save AbortError must take the observable save-error path.'
        );
        assert.match(
            voiceSource,
            /catch\(error\)\{[\s\S]*generation!==sessionGeneration\|\|destroyed[\s\S]*isTranscriptionCancellation\(error,controller\)[\s\S]*reportSTTCancellation\([\s\S]*stt-provider-request-cancelled/u,
            'A current provider cancellation must leave the transcribing state observably.'
        );
        assert.match(
            voiceSource,
            /async function completeStream\(\)\{[\s\S]*const completionTranscript=transcript[\s\S]*setState\('completing'[\s\S]*isCurrentVoiceOperation\(generation,'completing'\)[\s\S]*await complete\(\{transcript:completionTranscript\}\)[\s\S]*isCurrentVoiceOperation\(generation,'completing'\)/u,
            'Complete must remain terminal after destroy, including late callback settlement.'
        );
        assert.match(
            voiceSource,
            /completeButton[.]disabled=destroyed[\s\S]*sttActivationButton[.]hidden=destroyed[\s\S]*function runtimeStatusMessage\(\)\{[\s\S]*if\(destroyed\)[\s\S]*Transcription unavailable[.]/u,
            'Destroyed presentation must stay unavailable with Complete and activation disabled.'
        );
        const cancellationStart = voiceSource.indexOf(
            'function cancelSTTOperation('
        );
        const cancellationEnd = voiceSource.indexOf(
            '\n\n    function renderState',
            cancellationStart
        );
        assert.notEqual(cancellationStart, -1);
        assert.notEqual(cancellationEnd, -1);
        const cancellationSource = voiceSource.slice(
            cancellationStart,
            cancellationEnd
        );
        const savingCancellation = Function(
            `'use strict';
            let state='saving';
            let mediaStream=null;
            let recorder=null;
            let transcriptionAbortController=null;
            let sessionGeneration=17;
            let stateMessage='Saving transcription…';
            const destroyed=false;
            const host={
                dispatchEvent(){throw new Error('No cancellation event expected.');}
            };
            function releaseMicrophone(){
                throw new Error('No media release expected.');
            }
            function renderState(){
                throw new Error('No cancellation render expected.');
            }
            const CustomEvent=class UnexpectedCustomEvent{};
            ${cancellationSource}
            return Object.freeze({
                cancel:cancelSTTOperation,
                get generation(){return sessionGeneration;},
                get state(){return state;}
            });`
        )();
        assert.equal(savingCancellation.cancel('runtime-unready'), false);
        assert.equal(
            savingCancellation.generation,
            17,
            'Readiness loss during an app save must not invalidate that save.'
        );
        assert.equal(
            savingCancellation.state,
            'saving',
            'Readiness loss during an app save must not strand or rewrite its workflow state.'
        );
        assert.match(
            voiceSource,
            /function cancelSTTOperation[\s\S]*transcriptionAbortController[?][.]abort\(\)[\s\S]*speech-transcription-cancelled/u
        );
        assert.match(
            voiceSource,
            /function destroy\(\)[\s\S]*runtimeStateAbortController[.]abort\(\)[\s\S]*sttActivationController[.]destroy\(\)/u
        );

        let rejectDestroyedActivation;
        deferredActivation = {
            promise: new Promise(
                function createDestroyedSTTActivation(resolve, reject) {
                    rejectDestroyedActivation = reject;
                }
            )
        };
        controller.synchronize(Object.freeze({...unloaded, state: 'error'}));
        const destroyedLoad = controller.request('load');
        const errorsBeforeDestroy = events.filter(
            function countErrorsBeforeSTTActivationDestroy(event) {
                return event.type === 'speech-stt-activation-error';
            }
        ).length;
        controller.destroy();
        rejectDestroyedActivation(new Error('Late failure after destroy.'));
        assert.equal(await destroyedLoad, false);
        assert.equal(
            events.filter(
                function countErrorsAfterSTTActivationDestroy(event) {
                    return event.type === 'speech-stt-activation-error';
                }
            ).length,
            errorsBeforeDestroy
        );
        assert.equal(listeners.has('click'), false);
    }
);

test(
    'calculator lifecycle events use the singleton authority without changing legacy results',
    async function testCalculatorEventAuthority() {
        const [{default: CalculatorEngine, CALCULATOR_ENGINE_ERROR_CODES}, {arcaneEvents}]
            = await Promise.all([
                import('../runtime/arcane/modules/CalculatorEngine.js'),
                import('../src/event-manager.mjs')
            ]);
        const engine = new CalculatorEngine();
        const canonicalEvents = [];
        const localEvents = [];
        const removeCanonicalResult = arcaneEvents.subscribe(
            'calculator-result',
            function observeCanonicalCalculatorResult(event) {
                canonicalEvents.push(event);
            }
        );
        const removeCanonicalError = arcaneEvents.subscribe(
            'calculator-error',
            function observeCanonicalCalculatorError(event) {
                canonicalEvents.push(event);
            }
        );
        const removeLocalResult = engine.on(
            'calculator-result',
            function observeLocalCalculatorResult(event) {
                localEvents.push(event);
            }
        );
        const removeLocalError = engine.on(
            'calculator-error',
            function observeLocalCalculatorError(event) {
                localEvents.push(event);
            }
        );

        const calculation = engine.calculate('2 + 3');
        assert.equal(calculation.result, 5);
        assert.equal(localEvents[0].detail, calculation);
        const instanceId = localEvents[0].instanceId;
        const resultOccurrence = canonicalEvents.find(
            event => event.instanceId === instanceId && event.type === 'calculator-result'
        );
        assert.deepEqual(resultOccurrence.detail, {result: 5});
        assert.ok(Object.isFrozen(resultOccurrence.detail));
        assert.equal(resultOccurrence.operationId, localEvents[0].operationId);

        let domainError;
        assert.throws(
            function rejectCalculatorDomainFailure() {
                engine.calculate('1 / 0');
            },
            function rememberCalculatorDomainFailure(error) {
                domainError = error;
                return error?.code === CALCULATOR_ENGINE_ERROR_CODES.domain;
            }
        );
        const localError = localEvents.find(event => event.type === 'calculator-error');
        const errorOccurrence = canonicalEvents.find(
            event => event.instanceId === instanceId && event.type === 'calculator-error'
        );
        assert.equal(localError.detail.error, domainError);
        assert.deepEqual(errorOccurrence.detail, {
            code: CALCULATOR_ENGINE_ERROR_CODES.domain
        });
        assert.ok(Object.isFrozen(errorOccurrence.detail));
        assert.throws(
            function rejectCalculatorInputFailure() {
                engine.calculate('');
            },
            error => error?.code === CALCULATOR_ENGINE_ERROR_CODES.input
        );

        assert.equal(removeLocalResult(), true);
        assert.equal(removeLocalResult(), false);
        assert.equal(removeLocalError.dispose(), true);
        assert.equal(removeCanonicalResult(), true);
        assert.equal(removeCanonicalError.dispose(), true);
        assert.equal(engine.dispose(), true);
        assert.equal(engine.destroy(), false);
        assert.throws(
            function rejectDisposedCalculator() {
                engine.calculate('1 + 1');
            },
            error => error?.code === CALCULATOR_ENGINE_ERROR_CODES.disposed
        );
    }
);

import assert from 'node:assert/strict';

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
                const mutedStart = startAIRuntime();
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
            return {
                protocol: AI_PROVIDER_PROTOCOL,
                role,
                id,
                localOnly,
                counters,
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
                        busy: false
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
                request: async function requestTestProvider({signal}) {
                    counters.request += 1;
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

        const startupOptions = {startMuted: true};
        const startupPromise = runtime.start(startupOptions);
        startupOptions.startMuted = false;
        const startup = await startupPromise;
        const barrier = await startup.barrier;
        const settled = await startup.settled;
        assert.equal(barrier.chatReady, true);
        assert.equal(settled.chatReady, true);
        assert.equal(settled.roles.llm.state.state, 'ready');
        assert.equal(settled.roles.stt.state.state, 'ready');
        assert.equal(settled.roles.tts.requested, false);
        assert.equal(localLLM.counters.load, 1);
        assert.equal(localSTT.counters.load, 1);
        assert.equal(localTTS.counters.load, 0);

        assert.equal(
            await runtime.chat(
                {messages: []},
                {localOnly: true}
            ),
            'local result'
        );
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

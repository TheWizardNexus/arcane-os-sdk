import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import test from '../src/testing.mjs';
import {arcaneEvents} from '../src/event-manager.mjs';
import {
    applyAIResponseLength,
    AI_RESPONSE_LENGTH_DEFAULT,
    AI_RESPONSE_LENGTH_OPTIONS,
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
    appendTranscription,
    createSTTActivationController,
    formatAIRuntimeProgress
} from '../runtime/arcane/modules/ComponentContracts.js';
import ConfiguredAIChatSession from '../runtime/arcane/modules/ConfiguredAIChatSession.js';
import {hasConversationEntry,hasUserEntry} from '../runtime/arcane/modules/ChatRecords.js';
import DevelopmentWorkspace,{contextQuery,setupTaskId,workspaceRoot} from '../runtime/arcane/modules/DevelopmentWorkspace.js';
import {
    normalizeDirectoryPickerOptions,
    normalizeDirectorySelection
} from '../runtime/arcane/modules/DirectoryPicker.js';
import {normalizeContentAdvisory} from '../runtime/arcane/modules/MessageAdvisory.js';
import PreferenceStore from '../runtime/arcane/modules/PreferenceStore.js';
import {
    cleanExcerpt,
    extractDateMentions,
    findRulePassages
} from '../runtime/arcane/modules/RecordPassageIndex.js';
import RecordReviewStore from '../runtime/arcane/modules/RecordReviewStore.js';
import {assessScamRisk} from '../runtime/arcane/modules/ScamRiskPolicy.js';

const repositoryRoot=new URL('../',import.meta.url);

test('chat record predicates preserve complete model-authored openings',()=>{
    assert.equal(hasUserEntry([{role:'assistant',content:'Welcome.'}]),false);
    assert.equal(hasConversationEntry([{role:'assistant',content:'Welcome.'}]),true);
    assert.equal(hasConversationEntry([{role:'assistant',content:'   '}]),false);
    assert.equal(hasConversationEntry([{role:'system',content:'Internal prompt.'}]),false);
});

test('transcription assembly preserves complete whitespace and content',()=>{
    assert.equal(appendTranscription('', '  first  '), '  first  ');
    assert.equal(
        appendTranscription('  first  ', '  second  ', '\n--\n'),
        '  first  \n--\n  second  '
    );
    assert.equal(appendTranscription('existing', ''), 'existing');
});

test('AI runtime progress preserves complete provider-reported measures',()=>{
    assert.equal(
        formatAIRuntimeProgress(
            {
                phase:'fetching',
                completed:10.5,
                total:10,
                unit:'octets'
            },
            'loading'
        ),
        'fetching · 10.5 of 10 octets'
    );
});

test('message advisories and record passages preserve complete content',()=>{
    const summary='Complete advisory content '.repeat(80);
    const signals=Array.from({length:12},(_,index)=>`signal ${index+1} ${'detail '.repeat(30)}`);
    const advisory=normalizeContentAdvisory({summary,signals});
    assert.equal(advisory.summary,summary);
    assert.deepEqual(advisory.signals,signals);
    assert.equal(Object.isFrozen(advisory),false);
    assert.equal(Object.isFrozen(advisory.signals),false);

    const excerpt='first complete line second complete line';
    assert.equal(
        cleanExcerpt(['first complete line','second complete line'],0,1,{maximumLength:3}),
        excerpt
    );
    assert.equal(
        findRulePassages(
            'payment first\npayment second',
            [{id:'payment',patterns:[/payment/gi]}],
            {contextLines:0,maximumPerRule:1,maximumResults:1}
        ).length,
        2
    );
    assert.equal(
        extractDateMentions(
            'January 1, 2025\nFebruary 2, 2025',
            {contextLines:0,maximumResults:1}
        ).length,
        2
    );
});

test('record components retain every supplied item and complete source content',async()=>{
    const paths={
        fileDrop:'runtime/arcane/components/file-drop.html',
        relationshipBoard:'runtime/arcane/components/relationship-board.html',
        sourceViewer:'runtime/arcane/components/source-code-viewer.html',
        timeline:'runtime/arcane/components/record-timeline.html'
    };
    const sources=Object.fromEntries(await Promise.all(
        Object.entries(paths).map(async([name,path])=>[
            name,
            await readFile(new URL(path,repositoryRoot),'utf8')
        ])
    ));

    assert.match(sources.fileDrop,/currentFiles=files;/);
    assert.doesNotMatch(sources.fileDrop,/ARCANE_FILE_DROP_FILE_COUNT_LIMIT_EXCEEDED/);
    assert.doesNotMatch(sources.timeline,/\.slice\(0,5000\)/);
    assert.doesNotMatch(sources.relationshipBoard,/\.slice\(0,(?:12|1500|6000)\)/);
    assert.doesNotMatch(sources.sourceViewer,/MAXIMUM_(?:CHARACTERS|LINES)|Object\.freeze|\.slice\(0,512\)/);
});

test('record review storage reports unreadable records and directory paths remain complete',async()=>{
    const store=new RecordReviewStore({adapter:{
        async get(){return 'unreadable record review data';},
        async set(value){return value;}
    }});
    await assert.rejects(
        store.load(),
        error=>error?.code==='ARCANE_RECORD_REVIEW_STORED_RECORDS_INVALID'
    );
    store.dispose();

    const source=await readFile(
        new URL('runtime/arcane/components/directory-picker.html',repositoryRoot),
        'utf8'
    );
    assert.doesNotMatch(source,/next\.length>4096|bounded plain text|control characters/u);
});

test('directory picker preserves complete options and provider results',async()=>{
    const path='  /workspace/\u0001/complete path  ';
    const options={
        initialPath:path,
        title:'  Complete picker title  ',
        providerExtension:{purpose:'complete provider option'}
    };
    const normalizedOptions=normalizeDirectoryPickerOptions(options);
    assert.deepEqual(normalizedOptions,options);
    assert.equal(Object.isFrozen(normalizedOptions),false);
    assert.deepEqual(
        normalizeDirectoryPickerOptions({title:'',initialPath:null}),
        {title:'',initialPath:null}
    );

    const selected=normalizeDirectorySelection({
        cancelled:false,
        path,
        providerExtension:{purpose:'complete provider result'}
    });
    assert.equal(selected.path,path);
    assert.deepEqual(
        selected.providerExtension,
        {purpose:'complete provider result'}
    );
    assert.equal(Object.isFrozen(selected),false);

    const cancelled=normalizeDirectorySelection({
        cancelled:true,
        reason:'provider-owned cancellation detail'
    });
    assert.deepEqual(
        cancelled,
        {
            cancelled:true,
            reason:'provider-owned cancellation detail',
            path:null
        }
    );
});

test('development inputs remain complete and blocked-domain hardening is explicit',async()=>{
    const root='C:/workspace/'+'.nested/'.repeat(800);
    const query='complete context '.repeat(400);
    const task='Application owned setup task / complete';
    assert.equal(workspaceRoot(root),root);
    assert.equal(contextQuery(query),query.trim());
    assert.equal(setupTaskId(task),task);

    const calls=[];
    const workspace=new DevelopmentWorkspace({
        inspect(value){calls.push(value);return value;},
        context(){},
        setup(){}
    });
    assert.equal(workspace.inspect(root),root);
    assert.deepEqual(calls,[root]);

    const networkPolicy={
        schemaVersion:1,
        generation:1,
        domainRules:[{
            id:'test-rule',
            domain:'example.test',
            reason:{code:'test',title:'Test',description:'Test policy'},
            source:{id:'test',label:'Test',reference:null}
        }],
        networkRules:[]
    };
    const ordinary=assessScamRisk('Visit https://example.test',{networkPolicy});
    assert.equal(ordinary.matches.some(match=>match.id==='blocked-domain'),false);
    const selected=assessScamRisk('Visit https://example.test',{networkPolicy,secure:true});
    assert.equal(selected.matches.some(match=>match.id==='blocked-domain'),true);
    assert.equal(Object.isFrozen(selected),false);
    assert.equal(Object.isFrozen(selected.matches),false);
});

test('preference setAll uses the admitted native atomic batch once',async()=>{
    const previousArcane=globalThis.Arcane;
    const previousArcaneAndroid=globalThis.arcaneAndroid;
    const previousDocument=globalThis.document;
    const batches=[];
    let serialWrites=0;
    const preferences={
        async get(){return {found:false,value:null};},
        async set(){serialWrites+=1;},
        async delete(){},
        async setMany(entries,context){
            assert.equal(this,preferences);
            batches.push({entries,context});
            return {keys:Object.keys(entries),count:Object.keys(entries).length};
        }
    };
    let store=null;
    const controller=new AbortController();
    try{
        globalThis.Arcane={preferences};
        delete globalThis.arcaneAndroid;
        globalThis.document={
            querySelector(selector){
                return selector==='meta[name="arcane-app-id"]'
                    ?{getAttribute(){return 'spellwire';}}
                    :null;
            },
            documentElement:{dataset:{}}
        };
        store=new PreferenceStore({
            namespace:'spellwire',
            schema:[
                {key:'enabled',type:'boolean',defaultValue:false},
                {key:'volume',type:'number',defaultValue:0,minimum:0,maximum:1}
            ]
        });
        const changed=[];
        store.addEventListener('preference-change',event=>{
            changed.push(event.detail);
            if(changed.length===1) controller.abort('atomic-batch-committed');
        });
        const result=await store.setAll(
            {enabled:'true',volume:5,unknown:'ignored'},
            {signal:controller.signal}
        );
        assert.equal(serialWrites,0);
        assert.equal(batches.length,1);
        assert.deepEqual(
            batches[0].entries,
            {'spellwire.enabled':true,'spellwire.volume':1}
        );
        assert.equal(Object.isFrozen(batches[0].entries),false);
        assert.equal(Object.isFrozen(batches[0].context),false);
        assert.equal(batches[0].context.signal,controller.signal);
        assert.equal(controller.signal.aborted,true);
        assert.deepEqual(result,{enabled:true,volume:1});
        assert.deepEqual(changed.map(detail=>detail.key),['enabled','volume']);
        assert.equal(changed.every(detail=>Object.isFrozen(detail.values)),false);
        assert.equal(changed.every(detail=>{
            return detail.values.enabled===true&&detail.values.volume===1;
        }),true);
    }finally{
        store?.dispose();
        if(previousArcane===undefined) delete globalThis.Arcane;
        else globalThis.Arcane=previousArcane;
        if(previousArcaneAndroid===undefined) delete globalThis.arcaneAndroid;
        else globalThis.arcaneAndroid=previousArcaneAndroid;
        if(previousDocument===undefined) delete globalThis.document;
        else globalThis.document=previousDocument;
    }
});

test('preference setAll fails closed after an advertised batch rejects',async()=>{
    const failure=new Error('Atomic preference batch rejected.');
    let batchCalls=0;
    let serialWrites=0;
    let changeEvents=0;
    const store=new PreferenceStore({
        namespace:'batch-failure',
        schema:[
            {key:'enabled',type:'boolean',defaultValue:false},
            {key:'label',type:'text',defaultValue:'original'}
        ],
        adapter:{
            async get(){return {found:false,value:null};},
            async set(){serialWrites+=1;},
            async delete(){},
            async setMany(){batchCalls+=1;throw failure;}
        }
    });
    store.addEventListener('preference-change',()=>{changeEvents+=1;});
    try{
        await assert.rejects(
            store.setAll({enabled:true,label:'replacement'}),
            error=>error===failure
        );
        assert.equal(batchCalls,1);
        assert.equal(serialWrites,0);
        assert.equal(changeEvents,0);
        assert.deepEqual(store.values,{enabled:false,label:'original'});
    }finally{
        store.dispose();
    }
});

test('preference setAll preserves successful serial writes before a later failure',async()=>{
    const writes=[];
    const changes=[];
    const failure=new Error('Second serial preference write rejected.');
    const store=new PreferenceStore({
        namespace:'serial',
        schema:[
            {key:'enabled',type:'boolean',defaultValue:false},
            {key:'label',type:'text',defaultValue:''}
        ],
        adapter:{
            async get(){return {found:false,value:null};},
            async set(key,value,context){
                writes.push({key,value,context});
                if(writes.length===2) throw failure;
            },
            async delete(){}
        }
    });
    store.addEventListener('preference-change',event=>changes.push(event.detail.key));
    try{
        await assert.rejects(
            store.setAll({enabled:true,label:'ready'}),
            error=>error===failure
        );
        assert.deepEqual(
            writes.map(({key,value})=>({key,value})),
            [
                {key:'serial.enabled',value:true},
                {key:'serial.label',value:'ready'}
            ]
        );
        assert.equal(writes[0].context,writes[1].context);
        assert.match(writes[0].context.operationId,/:set-all:/u);
        assert.deepEqual(store.values,{enabled:true,label:''});
        assert.deepEqual(changes,['enabled']);
    }finally{
        store.dispose();
    }
});

test('preference setAll preserves every entry in an arbitrary-size atomic batch',async()=>{
    const schema=Array.from({length:33},(_,index)=>({
        key:`entry-${index+1}`,
        type:'number',
        defaultValue:0
    }));
    const values=Object.fromEntries(schema.map((definition,index)=>[
        definition.key,
        index+1
    ]));
    const batches=[];
    const writes=[];
    const store=new PreferenceStore({
        namespace:'bounded-batch',
        schema,
        adapter:{
            async get(){return {found:false,value:null};},
            async set(key,value){writes.push({key,value});},
            async delete(){},
            async setMany(entries){batches.push(entries);}
        }
    });
    try{
        assert.deepEqual(await store.setAll(values),values);
        assert.equal(batches.length,1);
        assert.equal(writes.length,0);
        assert.equal(batches[0]['bounded-batch.entry-1'],1);
        assert.equal(batches[0]['bounded-batch.entry-33'],33);
    }finally{
        store.dispose();
    }
});

test(
    'local readiness availability reflects provider readiness in a mutable result',
    function testMutableLocalAIAvailability() {
        const empty=availabilityFromReport({});
        assert.deepEqual(empty,{llm:false,stt:false,tts:false});
        assert.equal(Object.isFrozen(empty),false);
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
        request:{localOnly:true,toolChoice:'auto'},
    });
    await session.send('current request',{
        request:{toolChoice:'none'},
        signal:controller.signal,
    });
    assert.equal(requests[0].localOnly,true);
    assert.equal(requests[0].toolChoice,'none');
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

test('configured chat prepares a model-authored opening without retaining its bootstrap',async()=>{
    const requests=[];
    const session=new ConfiguredAIChatSession({
        chat:async request=>{
            requests.push(structuredClone(request));
            return {message:{role:'assistant',content:'Welcome from the selected model.'}};
        },
        systemPrompt:'Open the conversation after the application requests it.',
    });

    const prepared=await session.prepareOpening('Internal application bootstrap.');
    assert.equal(
        requests[0].messages.at(-1).content,
        'Internal application bootstrap.',
    );
    assert.deepEqual(
        session.history(),
        [{role:'system',content:'Open the conversation after the application requests it.'}],
    );
    prepared.commit();
    assert.deepEqual(
        session.history(),
        [
            {role:'system',content:'Open the conversation after the application requests it.'},
            {role:'assistant',content:'Welcome from the selected model.'},
        ],
    );
    assert.ok(!session.history().some(message=>message.content==='Internal application bootstrap.'));
    await assert.rejects(
        session.prepareOpening('Do not create a second opening.'),
        error=>error?.code==='AI_CHAT_OPENING_EXISTS',
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
                    function:{
                        name:'lookup',
                        arguments:'{"id":"alpha","message":"Looking up Alpha."}'
                    },
                }],
            },
        ],
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
                        {id:'one',type:'function',function:{name:'lookup',arguments:'{"message":"Looking up the first record."}'}},
                        {id:'two',type:'function',function:{name:'lookup',arguments:'{"message":"Looking up the second record."}'}},
                    ],
                },
            ],
        }),
        /exactly one structural tool call/u,
    );
    assert.throws(
        ()=>new ConfiguredAIChatSession({
            request:{
                tools:[{
                    type:'function',
                    function:{
                        name:'lookup',
                        parameters:{
                            type:'object',
                            properties:{id:{type:'string'}},
                            required:['id'],
                        },
                    },
                }],
            },
        }),
        error=>error?.code==='AI_CHAT_TOOL_MESSAGE_REQUIRED',
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
                                arguments:'{"id":"alpha","message":"Looking up Alpha."}'
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
                function:{
                    name:'lookup',
                    arguments:'{"id":"alpha","message":"Looking up Alpha."}'
                }
            }]
        },
        done:true,
        doneReason:'tool_calls',
        promptEvalCount:12,
        evalCount:7
    });
    assert.equal(Object.isFrozen(response),false);
    assert.equal(Object.isFrozen(response.message),false);
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
    assert.equal(Object.isFrozen(ollama),false);
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
        assert.equal(Object.isFrozen(objectResult),false);

        installOllamaBridge({version:async()=>' 0.7.0 '});
        const stringResult=await ollama.readiness();
        assert.deepEqual(stringResult,{ready:true,version:'0.7.0',errorCode:null});
        assert.equal(Object.isFrozen(stringResult),false);
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
        assert.equal(Object.isFrozen(result),false);
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
        '',null,' model','model ','TWIN','twin','model:',
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
    assert.equal(Object.isFrozen(catalog),false);
    assert.equal(Object.isFrozen(catalog[0]),false);

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
    assert.equal(Object.isFrozen(result),false);
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

test('AI response-length compatibility preserves complete provider-independent prompts',()=>{
    assert.equal(AI_RESPONSE_LENGTH_DEFAULT,'medium');
    assert.deepEqual(
        AI_RESPONSE_LENGTH_OPTIONS.map(option=>option.label),
        ['Complete','Complete','Complete']
    );
    assert.equal(normalizeAIResponseLength(' HIGH '),'high');
    assert.equal(normalizeAIResponseLength('unknown'),'medium');
    assert.equal(aiResponseLengthInstruction('low'),'');
    const prompt='  System context with every surrounding character.  ';
    assert.equal(applyAIResponseLength(prompt,'low'),prompt);
    assert.equal(applyAIResponseLength(prompt,'high'),prompt);
    assert.throws(()=>applyAIResponseLength(null,'medium'),/must be a string/u);
});

test(
    'AI runtime state is sticky, mutable, role-independent, and capability-neutral',
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
        initial.annotation='caller state annotation';
        assert.equal(initial.annotation,'caller state annotation');
        delete initial.annotation;

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

        function observeStateEvent(occurrence) {
            stateEvents.push(occurrence.detail);
        }

        const unsubscribeStateEvents = arcaneEvents.subscribe(
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
                            unit: 'items',
                            heartbeat: true
                        }
                    }
                )
            );
            assert.equal(snapshots.at(-1), loading);
            assert.deepEqual(stateEvents.at(-1), {
                revision: loading.revision,
                role: 'tts',
                state: 'loading',
                operationId: 'tts-load-1',
                progress: loading.roles.tts.progress
            });
            assert.equal(loading.roles.llm, initial.roles.llm);
            assert.equal(loading.roles.stt, initial.roles.stt);
            loading.roles.tts.progress.annotation='caller progress annotation';
            assert.equal(
                loading.roles.tts.progress.annotation,
                'caller progress annotation'
            );
            delete loading.roles.tts.progress.annotation;

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
                                    unit: 'items',
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
            failed.roles.tts.error.context='complete failure context';
            assert.equal(failed.roles.tts.error.context,'complete failure context');
            delete failed.roles.tts.error.context;
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
                intent.context='caller intent context';
                assert.equal(intent.context,'caller intent context');
                delete intent.context;
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

            function observeStartupReport(occurrence) {
                startupReports.push(occurrence.detail);
            }

            const unsubscribeStartupReports = arcaneEvents.subscribe(
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
                const defaultLanguageModelStart = startAIRuntime();
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
                const defaultLanguageModelWaits = Promise.allSettled(
                    [
                        defaultLanguageModelStart.barrier,
                        defaultLanguageModelStart.settled
                    ]
                );
                defaultLanguageModelStart.cancel();
                await defaultLanguageModelWaits;
                startupIntents.length = 0;
                const explicitLLMActivationStart = startAIRuntime(
                    {startLanguageModel: false}
                );
                assert.deepEqual(startupIntents, []);
                const explicitLLMBarrier = await explicitLLMActivationStart.barrier;
                const explicitLLMSettlement = await explicitLLMActivationStart.settled;
                assert.equal(explicitLLMBarrier.chatReady, false);
                assert.equal(explicitLLMBarrier.roles.llm.requested, false);
                assert.equal(explicitLLMBarrier.roles.llm.state, startSnapshot.roles.llm);
                assert.deepEqual(explicitLLMSettlement, explicitLLMBarrier);
                startupIntents.length = 0;
                const mutedStart = startAIRuntime(
                    {
                        startLanguageModel: false,
                        startTranscription: true
                    }
                );
                mutedStart.context='caller startup context';
                assert.equal(mutedStart.context,'caller startup context');
                delete mutedStart.context;
                assert.deepEqual(
                    startupIntents,
                    [
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
                const barrierReport = await mutedStart.barrier;
                assert.equal(barrierReport.startRevision, startSnapshot.revision);
                assert.equal(barrierReport.startLanguageModel, false);
                assert.equal(barrierReport.startMuted, true);
                assert.equal(barrierReport.startTranscription, true);
                assert.equal(barrierReport.chatReady, false);
                assert.equal(barrierReport.roles.llm.requested, false);
                assert.equal(barrierReport.roles.stt.requested, true);
                assert.equal(barrierReport.roles.tts.requested, false);
                assert.equal(barrierReport.roles.llm.state, startSnapshot.roles.llm);
                assert.equal(barrierReport.roles.stt.state.state, 'unloaded');
                assert.equal(barrierReport.roles.tts.state, standbyTTS);
                assert.deepEqual(startupReports.at(-1), {
                    revision: barrierReport.currentRevision,
                    role: 'llm',
                    state: barrierReport.roles.llm.state.state
                });
                barrierReport.context='complete startup report';
                assert.equal(barrierReport.context,'complete startup report');
                delete barrierReport.context;
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
                        startLanguageModel: false,
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

                publishAIRuntimeRoleState(
                    'tts',
                    runtimeRoleState(
                        'tts',
                        {
                            state: 'loading',
                            providerId: 'speech-t5',
                            modelId: 'speech-t5-q8',
                            localOnly: true,
                            operationId: 'tts-load-1'
                        }
                    )
                );

                const cancelledWaits = Promise.allSettled(
                    [unmutedStart.barrier, unmutedStart.settled]
                );
                startupController.abort();
                const cancellation = await cancelledWaits;
                assert.equal(cancellation[0].status, 'fulfilled');
                assert.equal(cancellation[1].status, 'rejected');
                assert.equal(cancellation[0].value.chatReady, false);
                assert.equal(cancellation[0].value.roles.llm.requested, false);
                assert.equal(cancellation[1].reason.name, 'AbortError');
                assert.equal(
                    cancellation[1].reason.code,
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
                            role: 'tts',
                            action: 'unload',
                            reason: 'startup'
                        }
                    ]
                );
                assert.equal(startupReports.length, startupEventCount + 1);
                unmutedStart.cancel();
            } finally {
                unsubscribeStartupIntents();
                unsubscribeStartupReports();
            }
        } finally {
            stateController.abort();
            unsubscribeState();
            unsubscribeState();
            unsubscribeIntents();
            unsubscribeIntents();
            unsubscribeStateEvents();
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

        function createProvider(
            role,
            id,
            localOnly,
            response,
            {maxConcurrentRequests}={}
        ) {
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
            const heldRequests = [];
            let activeRequestCount = 0;
            const requests = [];
            return {
                protocol: AI_PROVIDER_PROTOCOL,
                role,
                id,
                localOnly,
                ...(maxConcurrentRequests===undefined
                    ?{}
                    :{maxConcurrentRequests}),
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
                    let markStarted;
                    let release;
                    const started = new Promise(function createHeldRequestStart(resolve) {
                        markStarted = resolve;
                    });
                    const released = new Promise(function createHeldRequestRelease(resolve) {
                        release = resolve;
                    });
                    const heldRequest = {
                        markStarted,
                        released
                    };
                    heldRequests.push(heldRequest);
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
                            modelId: selection.modelId
                        }
                    };
                },
                status: function statusTestProvider() {
                    return {
                        state,
                        loaded,
                        busy: activeRequestCount>0
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
                    activeRequestCount += 1;
                    try {
                        if (signal.aborted) {
                            const error = new Error('cancelled');
                            error.name = 'AbortError';
                            throw error;
                        }
                        if (heldRequests.length) {
                            const gate = heldRequests.shift();
                            gate.markStarted();
                            await gate.released;
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
                        activeRequestCount -= 1;
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
        assert.throws(
            function rejectParallelSTTProvider(){
                runtime.register(createProvider(
                    'stt',
                    'parallel-stt',
                    true,
                    {text:'unreachable'},
                    {maxConcurrentRequests:2}
                ));
            },
            function isParallelSTTContractError(error){
                return error?.code==='ARCANE_AI_PROVIDER_RUNTIME_INVALID'
                    &&/Only TTS providers/u.test(error.message);
            }
        );
        const localLLM = createProvider('llm', 'local-llm', true, 'local result');
        const cloudLLM = createProvider('llm', 'cloud-llm', false, 'cloud result');
        const localSTT = createProvider('stt', 'local-stt', true, {text: 'hello'});
        const localTTS = createProvider(
            'tts',
            'local-tts',
            true,
            new Uint8Array([1]),
            {maxConcurrentRequests:2}
        );
        runtime.register(localLLM);
        runtime.register(cloudLLM);

        const pendingTupleRoutes = runtime.configureFromTuple(
            [
                'missing-llm',
                'saved-stt-route',
                'saved-tts-route',
                'missing-llm-model',
                'saved-tts-model',
                'saved-stt-model'
            ]
        );
        assert.deepEqual(
            pendingTupleRoutes.llm.default,
            selection('missing-llm', 'missing-llm-model', null)
        );
        assert.deepEqual(
            pendingTupleRoutes.stt.default,
            selection('saved-stt-route', 'saved-stt-model', null)
        );
        assert.deepEqual(
            pendingTupleRoutes.tts.default,
            selection('saved-tts-route', 'saved-tts-model', null)
        );
        assert.equal(runtime.providerIdentity('stt', 'saved-stt-route'), null);
        assert.equal(runtime.providerIdentity('tts', 'saved-tts-route'), null);
        const hydratedSpeech = runtime.replaceSpeechProviders({
            providers: {stt: localSTT, tts: localTTS},
            routes: {
                stt: {
                    default: selection('local-stt', 'local-stt-model', true),
                    localOnly: selection('local-stt', 'local-stt-model', true)
                },
                tts: {
                    default: selection('local-tts', 'local-tts-model', true),
                    localOnly: selection('local-tts', 'local-tts-model', true)
                }
            },
            expectedProviders: {stt: null, tts: null}
        });
        hydratedSpeech.context='caller hydration context';
        assert.equal(hydratedSpeech.context,'caller hydration context');
        assert.equal(runtime.providerIdentity('stt', 'local-stt').id, 'local-stt');
        assert.equal(runtime.providerIdentity('tts', 'local-tts').id, 'local-tts');
        assert.equal(runtime.providerIdentity('stt', 'saved-stt-route'), null);
        assert.equal(runtime.providerIdentity('tts', 'saved-tts-route'), null);
        assert.deepEqual(
            runtime.selection('stt'),
            selection('local-stt', 'local-stt-model', true)
        );
        assert.deepEqual(
            runtime.selection('tts'),
            selection('local-tts', 'local-tts-model', true)
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
        localRoutes.context='caller route context';
        assert.equal(localRoutes.context,'caller route context');
        delete localRoutes.context;
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
            startLanguageModel: false,
            startMuted: true,
            startTranscription: false
        };
        const startupPromise = runtime.start(startupOptions);
        startupOptions.startLanguageModel = true;
        startupOptions.startMuted = false;
        startupOptions.startTranscription = true;
        const startup = await startupPromise;
        const barrier = await startup.barrier;
        const settled = await startup.settled;
        assert.equal(barrier.chatReady, false);
        assert.equal(settled.chatReady, false);
        assert.equal(settled.startLanguageModel, false);
        assert.equal(settled.roles.llm.requested, false);
        assert.equal(settled.roles.llm.state.state, 'unloaded');
        assert.equal(settled.startTranscription, false);
        assert.equal(settled.roles.stt.requested, false);
        assert.equal(settled.roles.stt.state.state, 'unloaded');
        assert.equal(settled.roles.tts.requested, false);
        assert.equal(localLLM.counters.load, 0);
        assert.equal(localSTT.counters.load, 0);
        assert.equal(localTTS.counters.load, 0);
        await runtime.load('llm', {localOnly: true});
        assert.equal(localLLM.counters.load, 1);
        await runtime.load('stt', {localOnly: true});
        assert.equal(localSTT.counters.load, 1);

        assert.equal(
            await runtime.chat(
                {messages: []},
                {localOnly: true}
            ),
            'local result'
        );
        const requestsBeforeQueue = localLLM.counters.request;
        const heldRequest = localLLM.holdNextRequest();
        const firstRequest = runtime.chat(
            {messages: [], requestId: 'first'},
            {localOnly: true}
        );
        await heldRequest.started;
        const intermediateRequest = runtime.chat(
            {messages: [], requestId: 'intermediate'},
            {localOnly: true}
        );
        const newestRequest = runtime.chat(
            {messages: [], requestId: 'newest'},
            {localOnly: true}
        );
        assert.equal(
            localLLM.counters.request,
            requestsBeforeQueue + 1,
            'Queued requests must wait for the active provider promise.'
        );
        await assert.rejects(
            runtime.load('llm', {localOnly: true}),
            function keepLoadUnavailableDuringRequest(error) {
                return error?.code === 'ARCANE_AI_ROLE_BUSY';
            }
        );
        assert.throws(
            function keepReconfigurationUnavailableDuringRequest() {
                runtime.configure(localRoutes);
            },
            function isRequestOwnershipConfigurationGuard(error) {
                return error?.code === 'ARCANE_AI_ROLE_BUSY';
            }
        );
        heldRequest.release();
        assert.deepEqual(
            await Promise.all([firstRequest, intermediateRequest, newestRequest]),
            ['local result','local result','local result']
        );
        assert.equal(
            localLLM.counters.request,
            requestsBeforeQueue + 3
        );
        assert.equal(localLLM.requests.at(-3).requestId, 'first');
        assert.equal(localLLM.requests.at(-2).requestId, 'intermediate');
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

        const requestCountBeforeParallelTTS=localTTS.counters.request;
        const parallelTTSGates=[
            localTTS.holdNextRequest(),
            localTTS.holdNextRequest(),
            localTTS.holdNextRequest(),
            localTTS.holdNextRequest()
        ];
        const parallelTTSPayloads=[
            {input:'  first exact TTS input\n'},
            {input:'second exact TTS input  '},
            {input:'third FIFO TTS input'},
            {input:'fourth FIFO TTS input'}
        ];
        const parallelTTSRequests=parallelTTSPayloads.map(
            function startParallelTTSRequest(payload){
                return runtime.synthesize(payload,{localOnly:true});
            }
        );
        await Promise.all([
            parallelTTSGates[0].started,
            parallelTTSGates[1].started
        ]);
        assert.equal(
            localTTS.counters.request,
            requestCountBeforeParallelTTS+2,
            'TTS must start exactly the provider-declared capacity.'
        );
        assert.deepEqual(
            localTTS.requests.slice(-2),
            parallelTTSPayloads.slice(0,2),
            'The runtime must preserve the exact original TTS payloads.'
        );
        parallelTTSGates[1].release();
        await parallelTTSGates[2].started;
        assert.deepEqual(
            localTTS.requests.slice(-3),
            parallelTTSPayloads.slice(0,3),
            'The oldest overflow request must start first.'
        );
        parallelTTSGates[0].release();
        await parallelTTSGates[3].started;
        assert.deepEqual(
            localTTS.requests.slice(-4),
            parallelTTSPayloads,
            'FIFO order must survive capacity becoming available out of order.'
        );
        parallelTTSGates[2].release();
        parallelTTSGates[3].release();
        await Promise.all(parallelTTSRequests);

        const targetedTTSGates=[
            localTTS.holdNextRequest(),
            localTTS.holdNextRequest()
        ];
        const cancelledTTS=runtime.synthesize(
            {input:'cancel only this active TTS request'},
            {localOnly:true}
        );
        const siblingTTS=runtime.synthesize(
            {input:'retain this active TTS sibling'},
            {localOnly:true}
        );
        await Promise.all(targetedTTSGates.map(
            function awaitTargetedTTSStart(gate){return gate.started;}
        ));
        assert.equal(runtime.cancel('tts'),true);
        const cancelledTTSAssertion=assert.rejects(
            cancelledTTS,
            function isTargetedTTSAbort(error){
                return error?.code==='ARCANE_AI_REQUEST_ABORTED';
            }
        );
        targetedTTSGates[0].release();
        await cancelledTTSAssertion;
        assert.equal(runtime.status('tts').busy,true);
        targetedTTSGates[1].release();
        assert.deepEqual(await siblingTTS,new Uint8Array([1]));
        assert.equal(runtime.status('tts').busy,false);

        const unloadTTSGates=[
            localTTS.holdNextRequest(),
            localTTS.holdNextRequest()
        ];
        const unloadTTSRequests=[
            runtime.synthesize({input:'active unload one'},{localOnly:true}),
            runtime.synthesize({input:'active unload two'},{localOnly:true}),
            runtime.synthesize({input:'queued unload overflow'},{localOnly:true})
        ];
        const unloadTTSSettlements=Promise.allSettled(unloadTTSRequests);
        await Promise.all(unloadTTSGates.map(
            function awaitUnloadTTSStart(gate){return gate.started;}
        ));
        const requestCountAtTTSUnload=localTTS.counters.request;
        const unloadingTTS=runtime.unload('tts');
        unloadTTSGates[0].release();
        unloadTTSGates[1].release();
        const unloadedTTSResults=await unloadTTSSettlements;
        assert.ok(unloadedTTSResults.every(
            function isCancelledTTSUnloadResult(result){
                return result.status==='rejected'
                    &&result.reason?.code==='ARCANE_AI_REQUEST_ABORTED';
            }
        ));
        assert.equal(
            localTTS.counters.request,
            requestCountAtTTSUnload,
            'Queued overflow must not start once unload owns the role.'
        );
        await unloadingTTS;
        assert.equal(runtime.status('tts').state,'unloaded');
        await runtime.setSpeechMuted(false);
        assert.equal(runtime.status('tts').state,'ready');

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
        replacedSTT.context='caller STT replacement context';
        assert.equal(replacedSTT.context,'caller STT replacement context');
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
        replacedTTS.context='caller TTS replacement context';
        assert.equal(replacedTTS.context,'caller TTS replacement context');
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
        speechOnlyRoutes.context='caller speech route context';
        assert.equal(speechOnlyRoutes.context,'caller speech route context');
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
    'TWiN Cloud LLM and on-device Core speech routes publish truthful provider-v2 readiness',
    async function testTWiNCloudAndDeviceSpeechAdapters() {
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
        globalThis.fetch=async function answerTWiNCloudRequest(url,options) {
            requests.push({url:String(url),options});
            const request=JSON.parse(options.body);
            if(request.stream){
                return new Response([
                    'data: {"id":"cloud-stream","model":"openai-gpt-oss-120b","choices":[{"index":0,"delta":{"role":"assistant","content":"cloud stream"},"finish_reason":null}]}',
                    'data: {"id":"cloud-stream","model":"openai-gpt-oss-120b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
                    'data: [DONE]',
                    ''
                ].join('\n\n'),{
                    status:200,
                    headers:{'content-type':'text/event-stream'}
                });
            }
            return new Response(JSON.stringify({
                id:'cloud-response',
                model:'openai-gpt-oss-120b',
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
                '../runtime/arcane/modules/AI.js?twin-cloud-device-speech-readiness'
            );
            const ai=new AI(
                'TWIN','OPENAI','OPENAI',
                'TWIN','OPENAI','OPENAI'
            );
            const runtime=ai.providerRuntime;
            assert.equal(ai.llmService,'TWIN');
            assert.equal(ai.sttService,'LOCAL_SPEACH');
            assert.equal(ai.ttsService,'LOCAL_SPEACH');
            assert.equal(ai.model,'openai-gpt-oss-120b');
            assert.equal(ai.modelSTT,'whisper-small');
            assert.equal(ai.modelTTS,'kokoro');
            assert.equal(runtime.providerIdentity('llm','OPENAI'),null);
            assert.deepEqual(runtime.providerIdentity('llm','TWIN'),{
                protocol:AI_PROVIDER_PROTOCOL,
                role:'llm',
                id:'TWIN',
                localOnly:false
            });
            assert.deepEqual(runtime.providerIdentity('stt','LOCAL_SPEACH'),{
                protocol:AI_PROVIDER_PROTOCOL,
                role:'stt',
                id:'LOCAL_SPEACH',
                localOnly:true
            });
            assert.deepEqual(runtime.providerIdentity('tts','LOCAL_SPEACH'),{
                protocol:AI_PROVIDER_PROTOCOL,
                role:'tts',
                id:'LOCAL_SPEACH',
                localOnly:true
            });
            assert.equal(runtime.providerIdentity('stt','OPENAI'),null);
            assert.equal(runtime.providerIdentity('tts','OPENAI'),null);
            assert.equal(runtime.status('llm').state,'unloaded');
            assert.equal(runtime.status('stt').state,'unloaded');
            assert.equal(runtime.status('tts').state,'unloaded');
            assert.equal(ai.configured,false);
            await assert.rejects(
                runtime.load('stt',{localOnly:true}),
                error=>error?.code==='AI_NATIVE_LOCAL_REQUIRED'
            );
            await runtime.unload('stt');
            await assert.rejects(
                ai.setSpeechMuted(false),
                error=>error?.code==='AI_NATIVE_LOCAL_REQUIRED'
            );
            await ai.setSpeechMuted(true);

            ai.license='test-credential';
            await runtime.load('llm');
            assert.equal(runtime.status('llm').state,'ready');
            assert.equal(runtime.status('stt').state,'unloaded');
            assert.equal(runtime.status('tts').state,'unloaded');
            assert.equal(runtime.status('llm').loaded,true);
            assert.equal(ai.configured,true);
            assert.equal(requests.length,0,'Cloud readiness must not probe or download');
            assert.deepEqual(runtime.catalog('llm').find(
                entry=>entry.providerId==='TWIN'
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
            const tool={
                type:'function',
                function:{
                    name:'report_progress',
                    description:'Report progress to the user.',
                    parameters:{
                        type:'object',
                        properties:{
                            message:{type:'string',minLength:1}
                        },
                        required:['message']
                    }
                }
            };
            const publicCloud=await ai.fetchRequest({
                messages:[{role:'user',content:'Public cloud'}],
                reasoningEffort:'low',
                tools:[tool]
            });
            assert.equal(publicCloud.choices[0].message.content,'cloud response');
            const streamedCloud=await ai.streamRequest({
                messages:[{role:'user',content:'Streamed cloud'}],
                reasoningEffort:'high',
                tools:[tool]
            });
            assert.equal(streamedCloud,'cloud stream');
            await assert.rejects(
                ai.fetchRequest({
                    messages:[{role:'user',content:'Invalid reasoning'}],
                    reasoningEffort:'minimal'
                }),
                error=>error?.code==='AI_REASONING_EFFORT_INVALID'
            );
            assert.equal(requests.length,3);
            assert.ok(requests.every(request=>
                request.url==='https://inference.do-ai.run/v1/chat/completions'
            ));
            assert.ok(requests.every(request=>
                request.options.headers.Authorization==='Bearer test-credential'
            ));
            assert.ok(requests.every(request=>
                JSON.parse(request.options.body).model==='openai-gpt-oss-120b'
            ));
            assert.equal(
                JSON.parse(requests[0].options.body).reasoning_effort,
                undefined
            );
            assert.equal(
                JSON.parse(requests[1].options.body).reasoning_effort,
                'low'
            );
            assert.deepEqual(JSON.parse(requests[1].options.body).tools,[tool]);
            assert.equal(
                JSON.parse(requests[2].options.body).reasoning_effort,
                'high'
            );
            assert.deepEqual(JSON.parse(requests[2].options.body).tools,[tool]);

            await runtime.unload('llm');
            await ai.transitionAI(
                'TWIN',undefined,undefined,
                'openai-gpt-oss-20b',undefined,undefined
            );
            assert.equal(ai.model,'openai-gpt-oss-20b');
            await ai.fetchRequest({
                messages:[{role:'user',content:'Smaller TWiN model'}],
                reasoningEffort:'max'
            });
            assert.equal(
                JSON.parse(requests[3].options.body).model,
                'openai-gpt-oss-20b'
            );
            assert.equal(
                JSON.parse(requests[3].options.body).reasoning_effort,
                'max'
            );

            const remoteSelection={
                providerId:'remote-audio',
                modelId:'remote-audio-model',
                localOnly:false
            };
            assert.throws(
                ()=>ai.configureSpeechProviders({
                    stt:{default:remoteSelection,localOnly:null},
                    tts:{default:null,localOnly:null}
                }),
                error=>error?.code==='AI_STT_DEVICE_ONLY'
            );
            assert.throws(
                ()=>ai.configureSpeechProviders({
                    stt:{default:null,localOnly:null},
                    tts:{default:remoteSelection,localOnly:null}
                }),
                error=>error?.code==='AI_TTS_DEVICE_ONLY'
            );

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
            assert.equal(requests.length,2,'On-device audio must not use remote fetch');

            await ai.setSpeechMuted(true);
            await runtime.unload('stt');
            await runtime.unload('llm');
            const ttsRequests=[];
            const ttsSignals=[];
            const deferredTTSResponses=[];
            const decodedTTSIds=new Set();
            const decodedTTSWaiters=new Map();
            const speechStarts=[];
            const speechDurations=new Map();
            let ttsState='unloaded';

            function deferTTSResponse(id,duration){
                let markStarted;
                let release;
                const started=new Promise(function createDeferredTTSStart(resolve){
                    markStarted=resolve;
                });
                const released=new Promise(function createDeferredTTSRelease(resolve){
                    release=resolve;
                });
                speechDurations.set(id,duration);
                deferredTTSResponses.push({id,markStarted,released});
                return {
                    started,
                    release:function releaseDeferredTTSResponse(){
                        release({
                            audio:new Uint8Array([id]),
                            contentType:'audio/wav'
                        });
                    }
                };
            }

            function waitForDecodedTTS(id){
                if(decodedTTSIds.has(id))return Promise.resolve();
                return new Promise(function awaitDecodedTTS(resolve){
                    decodedTTSWaiters.set(id,resolve);
                });
            }

            const ttsProvider={
                protocol:AI_PROVIDER_PROTOCOL,
                role:'tts',
                id:'catalog-tts',
                localOnly:true,
                maxConcurrentRequests:2,
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
                            modelId:selection.modelId
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
                    const deferred=deferredTTSResponses.shift();
                    if(deferred){
                        deferred.markStarted();
                        return deferred.released;
                    }
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
                currentTime=10;
                async decodeAudioData(buffer){
                    const id=new Uint8Array(buffer)[0];
                    const decoded={
                        id,
                        duration:speechDurations.get(id)??0.5
                    };
                    decodedTTSIds.add(id);
                    decodedTTSWaiters.get(id)?.();
                    decodedTTSWaiters.delete(id);
                    return decoded;
                }
                createBufferSource(){
                    return {
                        buffer:null,
                        context:this,
                        stopped:false,
                        connect(){},
                        disconnect(){},
                        start(time){
                            speechStarts.push({id:this.buffer.id,time});
                        },
                        stop(){this.stopped=true;}
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
            assert.deepEqual(ai.ttsSegmentation,{
                punctuation:'sentence',
                wordCadence:null
            });

            const firstDeferredSpeech=deferTTSResponse(41,1.25);
            const secondDeferredSpeech=deferTTSResponse(42,0.75);
            const completeSpeechText=
                '  First complete chunk.\nSecond complete chunk?  ';
            const parallelSpeech=ai.streamTTS(completeSpeechText,true);
            await Promise.all([
                firstDeferredSpeech.started,
                secondDeferredSpeech.started
            ]);
            assert.equal(
                ttsRequests.length,
                3,
                'Both available chunks must enter synthesis immediately.'
            );
            assert.equal(
                ttsRequests.slice(1,3).map(
                    function selectExactSpeechInput(request){return request.input;}
                ).join(''),
                completeSpeechText,
                'Speech segmentation must preserve every original character.'
            );
            secondDeferredSpeech.release();
            await waitForDecodedTTS(42);
            assert.deepEqual([...decodedTTSIds],[42]);
            assert.deepEqual(
                speechStarts,
                [],
                'A later completed synthesis must wait for the earlier chunk.'
            );
            firstDeferredSpeech.release();
            assert.equal(await parallelSpeech,true);
            assert.deepEqual(speechStarts.slice(0,2),[
                {id:41,time:10},
                {id:42,time:11.25}
            ]);
            assert.equal(
                speechStarts[1].time,
                speechStarts[0].time+speechDurations.get(41),
                'Consecutive buffers must use AudioBuffer.duration without a callback seam.'
            );

            ai.stopAudio();
            const clockStartOffset=speechStarts.length;
            const runtimeAudioContext=ai.audioContext;
            const suppliedAudioContext=new windowTarget.AudioContext();
            runtimeAudioContext.currentTime=120;
            suppliedAudioContext.currentTime=5;
            speechDurations.set(61,2);
            speechDurations.set(62,1.5);
            speechDurations.set(63,0.75);
            const suppliedSource=suppliedAudioContext.createBufferSource();
            await ai.playAudio(
                [new Uint8Array([61])],
                suppliedAudioContext,
                suppliedSource
            );
            assert.equal(ai.speechJobs[0].sourceNode,suppliedSource);
            assert.equal(ai.audioContext,runtimeAudioContext);
            runtimeAudioContext.currentTime=120.5;
            suppliedAudioContext.currentTime=5.5;
            await ai.playAudio([new Uint8Array([62])],runtimeAudioContext);
            runtimeAudioContext.currentTime=121;
            suppliedAudioContext.currentTime=6;
            await ai.playAudio([new Uint8Array([63])],suppliedAudioContext);
            assert.deepEqual(speechStarts.slice(clockStartOffset),[
                {id:61,time:5},
                {id:62,time:122},
                {id:63,time:8.5}
            ],'Cross-context scheduling must convert only the remaining queue delay.');
            const clockSources=[...ai.sourceNodes];
            ai.stopAudio();
            assert.ok(clockSources.every(function stoppedClockSource(source){
                return source.stopped;
            }));

            const suspendedStartOffset=speechStarts.length;
            suppliedAudioContext.state='suspended';
            let allowSuppliedResume=false;
            suppliedAudioContext.resume=async function resumeSuppliedSpeechContext(){
                if(!allowSuppliedResume){
                    const error=new Error('A user gesture is required.');
                    error.name='NotAllowedError';
                    throw error;
                }
                this.state='running';
            };
            await ai.playAudio([new Uint8Array([64])],suppliedAudioContext);
            await ai.playAudio([new Uint8Array([65])],runtimeAudioContext);
            assert.equal(speechStarts.length,suspendedStartOffset);
            assert.equal(ai.speechAwaitingGesture,true);
            allowSuppliedResume=true;
            await ai.speechUnlockHandler();
            assert.deepEqual(speechStarts.slice(suspendedStartOffset),[
                {id:64,time:6},
                {id:65,time:121.5}
            ],'The gesture must resume the blocked context before later queue entries.');
            const resumedSources=[...ai.sourceNodes];
            await ai.setSpeechMuted(true);
            assert.ok(resumedSources.every(function mutedClockSource(source){
                return source.stopped;
            }));
            assert.equal(ai.speechJobs.length,0);
            assert.equal(ai.speechUnlockHandler,null);
            await ai.setSpeechMuted(false);

            assert.deepEqual(
                ai.configureTTSSegmentation({
                    punctuation:'any',
                    wordCadence:4
                }),
                {
                    punctuation:'any',
                    wordCadence:4
                }
            );
            assert.equal(
                await ai.streamTTS(
                    'Don\'t re-',
                    false
                ),
                true
            );
            assert.equal(ttsRequests.length,3);
            assert.equal(
                await ai.streamTTS(
                    'enter,version2。Next words arrive now ',
                    false
                ),
                true
            );
            assert.equal(ttsRequests.length,5);
            assert.deepEqual(ttsRequests[3],{
                model:'catalog-tts-model',
                voice:'provider_voice',
                input:'Don\'t re-enter,version2。',
                responseFormat:'wav',
                speed:1
            });
            assert.deepEqual(ttsRequests[4],{
                model:'catalog-tts-model',
                voice:'provider_voice',
                input:'Next words arrive now ',
                responseFormat:'wav',
                speed:1
            });
            assert.equal(await ai.streamTTS('Close）Next',false),true);
            assert.equal(ttsRequests.length,6);
            assert.equal(ttsRequests[5].input,'Close）');
            assert.equal(await ai.finishTTS(),true);
            assert.equal(ttsRequests.length,7);
            assert.equal(ttsRequests[6].input,'Next');
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
        const dbopfs={
            readyPromise:Promise.resolve(),
            async getTableHandle(tableName){
                dbopfsReads.push(tableName);
                throw new Error('Browser speech configuration must not load artifacts.');
            }
        };
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

        function browserSpeechRole(role,providerId,suffix){
            const runtimeVersion=role==='stt'?'3.5.1':'1.2.1';
            const runtimePath='runtime/entry.mjs';
            const modelFiles=[{
                path:'model/model.onnx',
                url:`https://speech.example/${role}/${suffix}/model.onnx`,
                mediaType:'application/octet-stream'
            }];
            if(role==='tts'){
                modelFiles.push({
                    path:'voices/af_contract.bin',
                    url:`https://speech.example/${role}/${suffix}/af_contract.bin`,
                    mediaType:'application/octet-stream'
                });
            }
            return {
                providerId,
                model:{
                    id:`${role}-model-${suffix}`,
                    repository:`example/${role}-${suffix}`,
                    revision:`${role}-model-${suffix}`,
                    dtype:'q8',
                    ...(role==='stt'
                        ?{inputSampleRate:16_000}
                        :{
                            outputSampleRate:24_000,
                            defaultVoice:'af_contract',
                            voices:[{id:'af_contract',path:'voices/af_contract.bin'}]
                        }),
                    files:modelFiles
                },
                runtime:{
                    adapter:role==='stt'?'transformers-whisper':'kokoro-js',
                    version:runtimeVersion,
                    revision:`${role}-runtime-${suffix}`,
                    entry:runtimePath,
                    ...(role==='stt'
                        ?{wasmPaths:'https://speech.example/stt/wasm/'}
                        :{}),
                    files:[{
                        path:runtimePath,
                        url:`https://speech.example/${role}/${suffix}/runtime.mjs`,
                        mediaType:'text/javascript'
                    }]
                },
                offline:false
            };
        }

        let ai=null;
        try{
            const {
                default:AI,
                AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL
            }=await import('../runtime/arcane/modules/AI.js?browser-speech-role-contract');
            ai=new AI('TWIN','OPENAI','OPENAI','TWIN','OPENAI','OPENAI');
            const runtime=ai.providerRuntime;
            const initialLocalTTSSelection=runtime.selection('tts');
            const pendingSTTSelection={
                providerId:'saved-stt-route',
                modelId:'saved-stt-model',
                localOnly:null
            };
            runtime.configureSpeech({
                stt:{
                    default:pendingSTTSelection,
                    localOnly:null
                },
                tts:{
                    default:initialLocalTTSSelection,
                    localOnly:null
                }
            });
            const localTTSIdentity=runtime.providerIdentity(
                'tts','LOCAL_SPEACH'
            );
            const localTTSSelection=runtime.selection('tts');
            const localTTSStatus=runtime.status('tts');
            const hydrationProviderIds=[];
            const unsubscribeHydration=subscribeAIRuntimeState(
                function observePendingSpeechHydration(snapshot){
                    hydrationProviderIds.push(snapshot.roles.stt.providerId);
                }
            );
            const initialSTTOnly={
                protocol:AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL,
                id:'browser-speech-initial-stt-only',
                dbopfs,
                stt:browserSpeechRole('stt','browser-stt-direct','direct')
            };
            let initialSTTDescriptor;
            try{
                initialSTTDescriptor=await ai.configureBrowserSpeech(
                    initialSTTOnly
                );
            }finally{
                unsubscribeHydration();
            }
            assert.equal(hydrationProviderIds.includes('TWIN'),false);
            assert.equal(hydrationProviderIds.includes('OPENAI'),false);
            assert.equal(
                hydrationProviderIds.includes('browser-stt-direct'),
                true
            );
            assert.equal(
                hydrationProviderIds.every(providerId=>
                    providerId==='browser-stt-direct'
                ),
                true
            );
            assert.equal(ai.browserSpeechConfiguration,initialSTTOnly);
            assert.equal(initialSTTDescriptor.stt.providerId,'browser-stt-direct');
            assert.equal(initialSTTDescriptor.stt.modelId,'stt-model-direct');
            assert.equal(initialSTTDescriptor.tts,null);
            assert.equal(runtime.status('stt').state,'unloaded');
            assert.deepEqual(dbopfsReads,[]);
            assert.deepEqual(
                runtime.providerIdentity('tts','LOCAL_SPEACH'),
                localTTSIdentity
            );
            assert.equal(runtime.selection('tts'),localTTSSelection);
            assert.equal(runtime.status('tts'),localTTSStatus);
            assert.equal(await ai.disposeBrowserSpeech(),true);
            assert.equal(runtime.selection('stt'),null);
            assert.equal(runtime.selection('tts'),localTTSSelection);
            assert.equal(runtime.status('tts'),localTTSStatus);

            const initial={
                protocol:AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL,
                id:'browser-speech-both-a',
                dbopfs,
                stt:browserSpeechRole('stt','browser-stt-a','a'),
                tts:browserSpeechRole('tts','browser-tts-a','a')
            };
            const initialDescriptor=await ai.configureBrowserSpeech(initial);
            assert.equal(ai.browserSpeechConfiguration,initial);
            assert.equal(initialDescriptor.stt.providerId,'browser-stt-a');
            assert.equal(initialDescriptor.tts.providerId,'browser-tts-a');
            assert.deepEqual(initialDescriptor.tts.execution,{
                device:'auto',
                maxConcurrentRequests:2
            });
            assert.equal(runtime.selection('stt').providerId,'browser-stt-a');
            assert.equal(runtime.selection('tts').providerId,'browser-tts-a');
            assert.equal(runtime.status('stt').state,'unloaded');
            assert.equal(runtime.status('tts').state,'unloaded');
            assert.equal(ai.muted,true);
            assert.deepEqual(dbopfsReads,[]);

            const retainedTTSIdentity=runtime.providerIdentity('tts','browser-tts-a');
            const retainedTTSSelection=runtime.selection('tts');
            const retainedTTSStatus=runtime.status('tts');
            const retainedTTSDescriptor=initialDescriptor.tts;
            const sttOnly={
                protocol:AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL,
                id:'browser-speech-stt-b',
                dbopfs,
                stt:browserSpeechRole('stt','browser-stt-b','b')
            };
            const sttDescriptor=await ai.configureBrowserSpeech(sttOnly);
            assert.equal(sttDescriptor.stt.providerId,'browser-stt-b');
            assert.equal(sttDescriptor.tts,retainedTTSDescriptor);
            assert.deepEqual(
                runtime.providerIdentity('tts','browser-tts-a'),
                retainedTTSIdentity
            );
            assert.deepEqual(runtime.selection('tts'),retainedTTSSelection);
            assert.equal(runtime.status('tts'),retainedTTSStatus);
            assert.equal(ai.muted,true);
            assert.equal(runtime.providerIdentity('stt','browser-stt-a'),null);
            assert.equal(ai.browserSpeechConfiguration.stt,sttOnly.stt);
            assert.equal(ai.browserSpeechConfiguration.tts,initial.tts);
            ai.browserSpeechConfiguration.annotation='caller configuration';
            assert.equal(
                ai.browserSpeechConfiguration.annotation,
                'caller configuration'
            );
            delete ai.browserSpeechConfiguration.annotation;
            assert.equal(await ai.configureBrowserSpeech(sttOnly),sttDescriptor);

            const retainedSTTIdentity=runtime.providerIdentity('stt','browser-stt-b');
            const retainedSTTSelection=runtime.selection('stt');
            const retainedSTTStatus=runtime.status('stt');
            const retainedSTTDescriptor=sttDescriptor.stt;
            const ttsOnly={
                protocol:AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL,
                id:'browser-speech-tts-b',
                dbopfs,
                tts:browserSpeechRole('tts','browser-tts-b','b')
            };
            ttsOnly.tts.execution={
                device:'wasm',
                maxConcurrentRequests:3
            };
            const ttsDescriptor=await ai.configureBrowserSpeech(ttsOnly);
            assert.equal(ttsDescriptor.stt,retainedSTTDescriptor);
            assert.equal(ttsDescriptor.tts.providerId,'browser-tts-b');
            assert.deepEqual(ttsDescriptor.tts.execution,{
                device:'wasm',
                maxConcurrentRequests:3
            });
            assert.deepEqual(
                runtime.providerIdentity('stt','browser-stt-b'),
                retainedSTTIdentity
            );
            assert.deepEqual(runtime.selection('stt'),retainedSTTSelection);
            assert.equal(runtime.status('stt'),retainedSTTStatus);
            assert.equal(runtime.providerIdentity('tts','browser-tts-a'),null);
            assert.equal(ai.browserSpeechConfiguration.stt,sttOnly.stt);
            assert.equal(ai.browserSpeechConfiguration.tts,ttsOnly.tts);
            assert.equal(runtime.status('stt').state,'unloaded');
            assert.equal(runtime.status('tts').state,'unloaded');
            assert.deepEqual(dbopfsReads,[]);

            assert.equal(await ai.disposeBrowserSpeech(),true);
            assert.equal(runtime.selection('stt'),null);
            assert.equal(runtime.selection('tts'),null);
            assert.equal(runtime.providerIdentity('stt','browser-stt-b'),null);
            assert.equal(runtime.providerIdentity('tts','browser-tts-b'),null);
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
        const chatEntitySource=await readFile(
            new URL('runtime/arcane/entities/Chat.js',repositoryRoot),
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
                removeAttribute(name) {
                    this.attributes.delete(name);
                    delete this[name];
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
        const progress=element();
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
        const activationReasons={
            languageModelActivationRequested:'language-model-activation-requested',
            languageModelActivationRejected:'language-model-activation-rejected'
        };
        const activationErrorCodes={
            languageModelActivationRejected:'ARCANE_CHAT_LANGUAGE_MODEL_ACTIVATION_REQUEST_REJECTED'
        };
        let operationSequence=0;
        function publishActivation(type,detail,options={}){
            const event=new ActivationEvent(type,{
                detail,
                bubbles:options.bubbles,
                composed:options.composed,
                cancelable:options.cancelable
            });
            event.operationId=options.operationId??null;
            event.publicDetail={...options.publicDetail};
            return host.dispatchEvent(event);
        }
        const controller=createAIActivationController({
            host,
            panel,
            title,
            status,
            progress,
            button,
            publish:publishActivation,
            createOperationId(){
                operationSequence+=1;
                return `chat-test:llm-activation:${operationSequence}`;
            },
            readErrorFields(error,boundaryCode){
                const causeCode=typeof error?.code==='string'?error.code.trim():'';
                return {
                    code:boundaryCode,
                    ...(causeCode&&causeCode!==boundaryCode?{causeCode}:{})
                };
            },
            reasons:activationReasons,
            errorCodes:activationErrorCodes
        });
        controller.annotation='caller activation controller';
        assert.equal(controller.annotation,'caller activation controller');
        assert.equal(intents.length,0);

        const unloaded={
            role:'llm',
            state:'unloaded',
            providerId:'browser-llm',
            modelId:'selected-model',
            localOnly:true,
            progress:null,
            error:null
        };
        controller.synchronize(unloaded);
        assert.equal(panel.hidden,false);
        assert.equal(panel.attributes.get('aria-busy'),'false');
        assert.equal(title.textContent,'Language model not active');
        assert.equal(button.textContent,'Start language model');
        assert.equal(button.disabled,false);
        assert.equal(intents.length,0,'state observation must never start a model');

        assert.equal(await controller.request('load'),true);
        assert.deepEqual(intents,[{role:'llm',action:'load',reason:'user'}]);
        intents[0].context='caller activation intent';
        assert.equal(intents[0].context,'caller activation intent');
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
        loadEvent.detail.context='complete activation detail';
        assert.equal(loadEvent.detail.context,'complete activation detail');

        preventNextRequest=true;
        assert.equal(await controller.request('load'),false);
        assert.equal(intents.length,1,'preventDefault must suppress the activation callback');

        const loading={
            ...unloaded,
            state:'loading',
            progress:{
                phase:'download',
                completed:4,
                total:10,
                unit:'octets',
                heartbeat:true
            }
        };
        controller.synchronize(loading);
        assert.equal(panel.attributes.get('aria-busy'),'true');
        assert.equal(title.textContent,'Loading selected-model');
        assert.equal(
            status.textContent,
            'Loading selected-model through the Arcane SDK · download · 4 of 10 octets · The first activation can take several minutes; keep this tab open'
        );
        assert.equal(progress.max,10);
        assert.equal(progress.value,4);
        assert.equal(button.textContent,'Cancel activation');
        assert.equal(await controller.request('unload'),true);
        assert.deepEqual(intents.at(-1),{role:'llm',action:'unload',reason:'user'});

        controller.synchronize({...unloaded,state:'unloading'});
        assert.equal(title.textContent,'Canceling language model load');
        assert.equal(button.disabled,true);

        const runtimeFailure=new Error('Runtime authority rejected the selected model.');
        controller.synchronize({...unloaded,state:'error',error:runtimeFailure});
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
        errorEvent.detail.context='complete activation error';
        errorEvent.publicDetail.context='complete public activation error';
        assert.equal(errorEvent.detail.context,'complete activation error');
        assert.equal(
            errorEvent.publicDetail.context,
            'complete public activation error'
        );

        let rejectSupersededActivation;
        activationResult=new Promise(
            function createSupersededActivation(resolve,reject){
                rejectSupersededActivation=reject;
            }
        );
        controller.synchronize({...unloaded,state:'error'});
        const supersededActivation=controller.request('load');
        await Promise.resolve();
        const activationErrorsBeforeSupersession=events.filter(
            event=>event.type==='chat-ai-activation-error'
        ).length;
        controller.synchronize({
            ...unloaded,
            state:'loading',
            operationId:'replacement-llm-operation'
        });
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

        controller.synchronize({...unloaded,state:'ready'});
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
        assert.match(
            source,
            /time[.]dateTime=value[.]toISOString\(\);[\s\S]*?toLocaleTimeString\(\[\],\{[\s\S]*?hour:'2-digit',[\s\S]*?minute:'2-digit',[\s\S]*?hourCycle:'h23'[\s\S]*?\}\);[\s\S]*?time[.]title=value[.]toLocaleString\(\);/u,
            'Transcript timestamps must preserve ISO metadata, full local titles, and visible local HH:MM text.'
        );
        const modelMessagesStart=chatEntitySource.indexOf('get messages(){');
        const transcriptStart=chatEntitySource.indexOf('get transcript(){',modelMessagesStart);
        const transcriptEnd=chatEntitySource.indexOf('\n    /**',transcriptStart);
        for(const boundary of [modelMessagesStart,transcriptStart,transcriptEnd]){
            assert.notEqual(boundary,-1);
        }
        const modelMessagesSource=chatEntitySource.slice(modelMessagesStart,transcriptStart);
        const transcriptSource=chatEntitySource.slice(transcriptStart,transcriptEnd);
        for(const field of [
            'memory_excluded',
            'persistence_message',
            'persistence_name',
            'persistence_status',
            'persistence_excluded',
            'ui_hidden',
            'timestamp'
        ]){
            assert.ok(
                modelMessagesSource.includes(`delete copy.${field};`),
                `Model-facing Chat.messages must mask ${field}.`
            );
        }
        assert.match(
            modelMessagesSource,
            /const copy=\{[.][.][.]message\};[\s\S]*?copy[.]tool_calls=copyToolCalls\(copy[.]tool_calls\)[.]map\(call=>\(\{[\s\S]*?[.][.][.]call,[\s\S]*?function:\{[.][.][.]call[.]function\}/u,
            'The model-facing mask must retain all non-display message and tool-call extension fields.'
        );
        assert.match(
            transcriptSource,
            /storedChatRecords\(this[.]#messages\)[.]map\(function publicTranscriptMessage\(message\)\{[\s\S]*?return copyCompleteValue\(message\);/u,
            'Chat.transcript must expose the entity-owned sanitized durable projection.'
        );
        assert.match(
            transcriptSource,
            /storedChatRecords/u,
            'Chat.transcript must not expose raw provider or tool protocol records.'
        );
        const chatOutputStyleStart=source.indexOf('.chat_output {');
        const chatOutputStyleEnd=source.indexOf('\n    .chat_output > li',chatOutputStyleStart);
        assert.notEqual(chatOutputStyleStart,-1);
        assert.notEqual(chatOutputStyleEnd,-1);
        assert.match(
            source.slice(chatOutputStyleStart,chatOutputStyleEnd),
            /overflow-x:\s*auto;[\s\S]*?overflow-y:\s*auto;[\s\S]*?overscroll-behavior:\s*contain;/u,
            'The transcript viewport must mask overflow while retaining complete scrollable content.'
        );
        const scrollStart=source.indexOf('function scrollTranscriptToBottom()');
        const scrollEnd=source.indexOf('\n\n    function transcriptTime',scrollStart);
        assert.notEqual(scrollStart,-1);
        assert.notEqual(scrollEnd,-1);
        const scrollHarness=Function(
            `'use strict';
            return function scrollHarness(chatOutput){
                ${source.slice(scrollStart,scrollEnd)}
                return scrollTranscriptToBottom();
            };`
        )();
        const transcriptViewport={scrollHeight:947,scrollTop:19};
        assert.equal(scrollHarness(transcriptViewport),true);
        assert.equal(
            transcriptViewport.scrollTop,
            transcriptViewport.scrollHeight,
            'The shared scroll helper must target the complete transcript bottom.'
        );
        const transcriptMutationContracts=[
            {
                start:'function appendVisibleToolCall(',
                end:'\n\n    function setTranscriptMessageContent',
                mutation:'toolCalls.append(entry);',
                scrolls:1
            },
            {
                start:'function setTranscriptMessageContent(',
                end:'\n\n    function setTranscriptMessageTimestamp',
                mutation:'markdown.innerHTML=new MD(content).rendered;',
                scrolls:1
            },
            {
                start:'function setTranscriptMessageTimestamp(',
                end:'\n\n    function sameTranscriptRequest',
                mutation:'current.replaceWith(transcriptTime(timestamp));',
                scrolls:1
            },
            {
                start:'function appendTranscriptMessage(',
                end:'\n\n    function completeVisibleValue',
                mutation:'chatOutput.append(item);',
                scrolls:1
            },
            {
                start:'function renderSessionHistory(',
                end:'\n\n    async function bindSession',
                mutation:'chatOutput.replaceChildren(fragment);',
                scrolls:1
            },
            {
                start:'function setMessageProgress(',
                end:'\n\n    function setAIAvailability',
                mutation:"'aria-valuetext',",
                scrolls:1
            },
            {
                start:"async function streamMessage(text='', id='', isThinking)",
                end:'\n\n    textArea.addEventListener',
                mutation:'target.innerHTML=new MD(target.raw).rendered;',
                scrolls:2
            },
            {
                start:'function renderSessionMessageFailure(',
                end:'\n\n    function internalStructuralToolFailure',
                mutation:'markdown.innerHTML=new MD(text).rendered;',
                scrolls:1
            },
            {
                start:'function restoreRejectedStructuralDraft(',
                end:'\n\n    async function sendMessageThroughBoundSession',
                mutation:"textArea.style.height=`${textArea.scrollHeight}px`;",
                scrolls:1
            },
            {
                start:'async function receivedMessage(',
                end:'\n\n    function reportTTSError',
                mutation:"const message=appendTranscriptMessage('assistant',text,name);",
                scrolls:1
            }
        ];
        for(const contract of transcriptMutationContracts){
            const start=source.indexOf(contract.start);
            const end=source.indexOf(contract.end,start);
            assert.notEqual(start,-1,`${contract.start} must remain present`);
            assert.notEqual(end,-1,`${contract.start} must retain its source boundary`);
            const functionSource=source.slice(start,end);
            const mutationIndex=functionSource.indexOf(contract.mutation);
            assert.notEqual(
                mutationIndex,
                -1,
                `${contract.start} must retain its transcript mutation`
            );
            const scrollIndexes=[...functionSource.matchAll(/scrollTranscriptToBottom\(\);/gu)]
                .map(match=>match.index);
            assert.ok(
                scrollIndexes.length>=contract.scrolls,
                `${contract.start} must restore true-bottom scrolling after each mutation path`
            );
            assert.ok(
                scrollIndexes.some(index=>index>mutationIndex),
                `${contract.start} must scroll after its terminal transcript mutation`
            );
        }
        assert.match(
            source,
            /[.]chat_output > li \{[\s\S]*?min-inline-size:0;[\s\S]*?max-inline-size:min\(92%,48rem\);[\s\S]*?overflow-x: hidden;[\s\S]*?\}/u,
            'Chat cards must contain nested content at narrow widths and text zoom.'
        );
        assert.match(
            source,
            /[.]message_tool_call pre\{[\s\S]*?min-inline-size:0;[\s\S]*?max-inline-size:100%;[\s\S]*?white-space:pre-wrap;[\s\S]*?overflow-x:auto;[\s\S]*?overflow-wrap:anywhere;[\s\S]*?\}/u,
            'Complete structural arguments must wrap or scroll within their owning card.'
        );
        assert.match(
            source,
            /const statuses=new Map\(\[[\s\S]*?\['executed','Executed'\],[\s\S]*?\['declined','Declined'\],[\s\S]*?\['cancelled','Cancelled'\],[\s\S]*?\['not-executed','Not executed'\][\s\S]*?\]\);/u,
            'Chat.submitToolResults must preserve every public result status.'
        );
        assert.match(
            source,
            /async function submitToolResults\([\s\S]*?const ownership=createChatSubmissionOwnership\(context[.]signal\?\?null\);[\s\S]*?return observeHostSubmission\(result,eventContext,ownership\);/u,
            'Tool-result settlement must remain owned through asynchronous host submission.'
        );
        assert.match(
            source,
            /const status=result[.]status\?\?result[.]disposition;[\s\S]*?content:`\$\{statuses[.]get\(status\)\} — \$\{result[.]message\}`,[\s\S]*?message:result[.]message,[\s\S]*?name:pendingById[.]get\(toolCallId\)[.]function[.]name,[\s\S]*?status,[\s\S]*?tool_call_id:toolCallId/u,
            'Tool-result storage metadata must use only the caller-provided message, public name, and result status.'
        );
        assert.match(
            source,
            /const retainTurn=sessionRequestMessages[.]every\(message=>message[.]persist!==false\);[\s\S]*?if\(retainTurn\)\{[\s\S]*?\}else\{[\s\S]*?requestMessage[.]remove\(\);[\s\S]*?message[.]remove\(\);[\s\S]*?setPendingStructuralToolCalls\(previousPendingToolCalls\);/u,
            'A nonpersistent session turn must leave no retained Chat cards or pending context.'
        );
        assert.match(
            source,
            /if\(message[.]role==='tool'\)\{[\s\S]*?!message[.]content[.]trim\(\)[\s\S]*?'AI_CHAT_INVALID_TOOL_MESSAGE'/u,
            'Restored tool results must contain nonblank user-facing text.'
        );
        assert.match(
            source,
            /function visibleErrorMessage\(error,fallback\)\{[\s\S]*?error\?[.]userSafe===true[\s\S]*?return fallback;/u,
            'Unknown failures must use generic visible copy unless explicitly marked user-safe.'
        );
        assert.match(
            source,
            /async function streamMessage\(text=''[\s\S]*?typeof text!=='string'[\s\S]*?ARCANE_CHAT_STREAM_CONTENT_INVALID/u,
            'Nontext stream content must be diagnosed instead of rendered into the transcript.'
        );
        assert.match(
            source,
            /pendingStructuralToolMessage=pendingStructuralToolCalls[\s\S]*?[.]map\(structuralToolMessage\)[\s\S]*?[.]join\(' · '\);[\s\S]*?userMessage[.]textContent=structuralToolMessage\(call\);[\s\S]*?setSessionStatus\('tool',pendingStructuralToolMessage\);/u,
            'Every structural arguments.message value must drive the combined status and its visible card.'
        );
        assert.match(
            source,
            /host[.]submitToolResults=submitToolResults;[\s\S]*?Object[.]defineProperty\(host,'pendingTools',[\s\S]*?get:pendingStructuralToolSummaries[\s\S]*?Object[.]defineProperty\(host,'pendingToolCalls',[\s\S]*?get:pendingStructuralToolCallsComplete/u,
            'The public host must expose plural settlement and complete plural pending getters.'
        );
        assert.match(
            source,
            /if\(activeSessionMessageToken===sessionMessageToken\)\{\s*activeSessionMessageToken=null;\s*sessionMessagePending=false;[\s\S]*?\}\s*dispatchChatEvent\(\s*'chat-session-message'/u,
            'Terminal session ownership must release before a reentrant terminal event listener runs.'
        );
        const structuralFailureStart=source.indexOf(
            '&&internalStructuralToolFailure(error)'
        );
        const structuralFailureEnd=source.indexOf(
            '}else if(!destroyed&&bindingGeneration===sessionBindingGeneration)',
            structuralFailureStart
        );
        assert.notEqual(structuralFailureStart,-1);
        assert.notEqual(structuralFailureEnd,-1);
        const structuralFailureSource=source.slice(
            structuralFailureStart,
            structuralFailureEnd
        );
        assert.match(
            structuralFailureSource,
            /console[.]error\('Arcane structural tool protocol failure[.]',error\);/u
        );
        assert.match(
            structuralFailureSource,
            /restoreRejectedStructuralDraft\(messageId,context[.]operationId,text\);/u,
            'A rejected user turn must be restored after its textarea draft was cleared.'
        );
        assert.doesNotMatch(
            structuralFailureSource,
            /renderSessionMessageFailure|visibleErrorMessage/u,
            'Internal structural protocol diagnostics must not become assistant transcript errors.'
        );
        assert.match(
            structuralFailureSource,
            /setSessionStatus\(\s*pendingStructuralToolCalls[.]length\?'tool':'ready',[\s\S]*?pendingStructuralToolMessage\|\|'Chat ready[.]'/u,
            'Internal structural failures must leave only the generic actionable or ready status visible.'
        );

        const completeChatStart=source.indexOf('function publicErrorFields(');
        const completeChatEnd=source.indexOf('\n\n    function isAbortSignal(',completeChatStart);
        const toolSettlementStart=source.indexOf('async function submitToolResults(');
        const toolSettlementEnd=source.indexOf(
            '\n\n    function observeHostSubmission',
            toolSettlementStart
        );
        for(const boundary of [
            completeChatStart,
            completeChatEnd,
            toolSettlementStart,
            toolSettlementEnd
        ]){
            assert.notEqual(boundary,-1);
        }
        const createCompleteChatHarness=Function(
            `'use strict';
            return function createCompleteChatHarness(history){
                let ownerDocument=null;
                function classNames(node){
                    return new Set(node.className.split(/\\s+/u).filter(Boolean));
                }
                function attach(parent,value,index=parent.children.length){
                    const values=value?.fragment===true?[...value.children]:[value];
                    let offset=0;
                    for(let child of values){
                        if(typeof child==='string') child=ownerDocument.createTextNode(child);
                        child.parentNode=parent;
                        parent.children.splice(index+offset,0,child);
                        offset+=1;
                    }
                    if(value?.fragment===true) value.children=[];
                }
                function matches(node,selector){
                    if(selector.startsWith('.')){
                        return classNames(node).has(selector.slice(1));
                    }
                    if(selector.startsWith('#')) return node.id===selector.slice(1);
                    return node.tagName.toLowerCase()===selector.toLowerCase();
                }
                function firstMatch(node,selector){
                    for(const child of node.children){
                        if(matches(child,selector)) return child;
                        const nested=firstMatch(child,selector);
                        if(nested) return nested;
                    }
                    return null;
                }
                function node(tagName){
                    const value={
                        tagName:String(tagName).toUpperCase(),
                        ownerDocument,
                        parentNode:null,
                        fragment:false,
                        children:[],
                        dataset:{},
                        style:{},
                        attributes:new Map(),
                        className:'',
                        id:'',
                        raw:'',
                        textContent:'',
                        innerHTML:'',
                        append(...children){
                            for(const child of children) attach(this,child);
                        },
                        insertBefore(child,reference){
                            const index=reference===null?this.children.length:this.children.indexOf(reference);
                            attach(this,child,index<0?this.children.length:index);
                        },
                        replaceChildren(...children){
                            for(const child of this.children) child.parentNode=null;
                            this.children=[];
                            for(const child of children) attach(this,child);
                        },
                        replaceWith(replacement){
                            if(!this.parentNode) return;
                            const parent=this.parentNode;
                            const index=parent.children.indexOf(this);
                            if(index<0) return;
                            parent.children.splice(index,1);
                            this.parentNode=null;
                            attach(parent,replacement,index);
                        },
                        remove(){
                            if(!this.parentNode) return;
                            const index=this.parentNode.children.indexOf(this);
                            if(index>=0) this.parentNode.children.splice(index,1);
                            this.parentNode=null;
                        },
                        querySelector(selector){
                            return firstMatch(this,selector);
                        },
                        setAttribute(name,attributeValue){
                            this.attributes.set(name,String(attributeValue));
                        },
                        removeAttribute(name){
                            this.attributes.delete(name);
                        },
                        focus(){},
                        blur(){}
                    };
                    value.classList={
                        contains(name){return classNames(value).has(name);},
                        add(...names){
                            const next=classNames(value);
                            for(const name of names) next.add(name);
                            value.className=[...next].join(' ');
                        },
                        remove(...names){
                            const next=classNames(value);
                            for(const name of names) next.delete(name);
                            value.className=[...next].join(' ');
                        },
                        toggle(name,force){
                            const next=classNames(value);
                            const enabled=force===undefined?!next.has(name):Boolean(force);
                            if(enabled) next.add(name);
                            else next.delete(name);
                            value.className=[...next].join(' ');
                            return enabled;
                        }
                    };
                    return value;
                }
                ownerDocument={
                    createElement:node,
                    createDocumentFragment(){
                        const fragment=node('#fragment');
                        fragment.fragment=true;
                        return fragment;
                    },
                    createTextNode(text){
                        const textNode=node('#text');
                        textNode.textContent=String(text);
                        return textNode;
                    }
                };
                const chatOutput=node('ol');
                chatOutput.scrollHeight=947;
                let transcriptScrollTop=0;
                let transcriptScrollWrites=0;
                Object.defineProperty(chatOutput,'scrollTop',{
                    configurable:true,
                    get(){return transcriptScrollTop;},
                    set(value){
                        transcriptScrollTop=value;
                        transcriptScrollWrites+=1;
                    }
                });
                const textArea=node('textarea');
                textArea.value='';
                textArea.scrollHeight=67;
                const chatSessionStatus=node('output');
                chatSessionStatus.value='';
                const host={
                    name:'User',
                    aiName:'Assistant',
                    aiAvailability:{llm:true,stt:false,tts:false},
                    conversationComplete:false,
                    session:null
                };
                class MD{
                    constructor(text){this.rendered='rendered:'+text;}
                }
                const chatErrorCodes={
                    destroyed:'ARCANE_CHAT_DESTROYED',
                    sessionAlreadyBound:'ARCANE_CHAT_SESSION_ALREADY_BOUND',
                    sessionBindingRejected:'ARCANE_CHAT_SESSION_BINDING_REJECTED'
                };
                const chatReasons={
                    sessionBindingCompleted:'session-binding-completed',
                    sessionBindingRejected:'session-binding-rejected'
                };
                let pendingStructuralToolCalls=[];
                let pendingStructuralToolMessage='';
                let sessionHistoryRecoveryMessage='';
                let destroyed=false;
                let sessionBindingPending=false;
                let sessionMessagePending=false;
                let sessionBindingGeneration=0;
                let boundChatSession=null;
                let boundChatAI=null;
                let operationSequence=0;
                let releaseCount=0;
                let transcriptReads=0;
                let historyReads=0;
                const events=[];
                const sends=[];
                function nextChatOperationId(kind){
                    operationSequence+=1;
                    return 'chat-history:'+kind+':'+operationSequence;
                }
                async function createPersistentAIChatSession(){
                    throw new Error('The focused fixture supplies its session.');
                }
                function applyAIAvailability(){}
                function internalStructuralToolFailure(){return false;}
                function dispatchChatEvent(type,detail,options={}){
                    events.push({type,detail,options});
                    return true;
                }
                function createChatSubmissionOwnership(signal=null){
                    const controller=new AbortController();
                    return {
                        signal:signal??controller.signal,
                        release(){releaseCount+=1;}
                    };
                }
                function sendMessageThroughBoundSession(
                    text,
                    context,
                    requestMessages,
                    perTurnRequest
                ){
                    sends.push({text,context,requestMessages,perTurnRequest});
                    return Promise.resolve({accepted:true});
                }
                function observeHostSubmission(result,context,ownership){
                    return Promise.resolve(result).finally(function releaseSubmission(){
                        ownership.release();
                    });
                }
                ${source.slice(completeChatStart,completeChatEnd)}
                ${source.slice(toolSettlementStart,toolSettlementEnd)}
                const session={
                    ai:{id:'bound-ai'},
                    async ready(){},
                    async transcript(){
                        transcriptReads+=1;
                        return history;
                    },
                    async history(){
                        historyReads+=1;
                        return [];
                    },
                    async send(){return {accepted:true};}
                };
                function appendRejectedDraftTurn(text,operationId,messageId){
                    const request=appendTranscriptMessage('user',text,host.name);
                    request.dataset.operationId=operationId;
                    const response=appendTranscriptMessage('assistant','',host.aiName);
                    response.id='message-'+messageId;
                    return {request,response};
                }
                return {
                    bindSession,
                    submitToolResult,
                    submitToolResults,
                    restoreRejectedStructuralDraft,
                    appendRejectedDraftTurn,
                    pendingTool:pendingStructuralToolSummary,
                    pendingTools:pendingStructuralToolSummaries,
                    pendingToolCall:pendingStructuralToolCallComplete,
                    pendingToolCalls:pendingStructuralToolCallsComplete,
                    chatOutput,
                    textArea,
                    session,
                    events,
                    sends,
                    state(){
                        return {
                            boundChatSession,
                            historyReads,
                            releaseCount,
                            sessionBindingPending,
                            status:{...host.sessionStatus},
                            transcriptReads,
                            transcriptScrollTop,
                            transcriptScrollWrites
                        };
                    }
                };
            };`
        )();

        const firstParallelCall={
            id:'tool-one',
            type:'function',
            providerExtension:{flags:['complete-first',null]},
            function:{
                name:'firstAction',
                arguments:JSON.stringify({message:'Run the first action?'}),
                functionExtension:{nested:{preserved:true}}
            }
        };
        const secondParallelCall={
            id:'tool-two',
            type:'function',
            providerExtension:{flags:['complete-second',{ordinal:2}]},
            function:{
                name:'secondAction',
                arguments:JSON.stringify({message:'Run the second action?'}),
                functionExtension:{nested:{preserved:true}}
            }
        };
        const hiddenSavedRecord={
            role:'system',
            content:'Complete saved record marked UI-hidden.',
            timestamp:'2026-08-29T08:09:10.000Z',
            ui_hidden:true,
            savedExtension:{complete:['value',null]}
        };
        const parallelHistory=[
            hiddenSavedRecord,
            {
                role:'assistant',
                content:'Both actions require a decision.',
                timestamp:'2026-08-29T08:10:11.000Z',
                tool_calls:[firstParallelCall,secondParallelCall]
            }
        ];
        const parallelChat=createCompleteChatHarness(parallelHistory);
        assert.equal(
            await parallelChat.bindSession({session:parallelChat.session}),
            parallelChat.session
        );
        const parallelBoundState=parallelChat.state();
        assert.equal(parallelBoundState.boundChatSession,parallelChat.session);
        assert.equal(parallelBoundState.historyReads,0);
        assert.equal(parallelBoundState.releaseCount,0);
        assert.equal(parallelBoundState.sessionBindingPending,false);
        assert.deepEqual(
            parallelBoundState.status,
            {state:'tool',message:'Run the first action? · Run the second action?'}
        );
        assert.equal(parallelBoundState.transcriptReads,1);
        assert.equal(
            parallelBoundState.transcriptScrollTop,
            parallelChat.chatOutput.scrollHeight
        );
        assert.ok(
            parallelBoundState.transcriptScrollWrites>=3,
            'Restoring both tool cards and the completed transcript must each reach true bottom.'
        );
        assert.equal(
            parallelChat.chatOutput.children.length,
            parallelHistory.length,
            'Saved ui_hidden records remain complete transcript records and must render.'
        );
        const hiddenSavedItem=parallelChat.chatOutput.children[0];
        const hiddenSavedMarkdown=hiddenSavedItem.querySelector('.markdown');
        const hiddenSavedTime=hiddenSavedItem.querySelector('.message_timestamp');
        assert.equal(hiddenSavedMarkdown.raw,hiddenSavedRecord.content);
        assert.equal(hiddenSavedTime.tagName,'TIME');
        assert.equal(hiddenSavedTime.dateTime,hiddenSavedRecord.timestamp);
        assert.ok(hiddenSavedTime.textContent);
        assert.ok(hiddenSavedTime.title);
        assert.notEqual(hiddenSavedMarkdown,hiddenSavedTime);
        assert.equal(hiddenSavedMarkdown.raw.includes(hiddenSavedTime.dateTime),false);

        const pendingCards=parallelChat.chatOutput.children[1]
            .querySelector('.message_tool_calls');
        assert.deepEqual(
            pendingCards.children.map(card=>card.dataset.toolCallId),
            ['tool-one','tool-two']
        );
        assert.deepEqual(
            pendingCards.children.map(card=>JSON.parse(
                card.querySelector('code').textContent
            )),
            [firstParallelCall,secondParallelCall],
            'Every restored parallel card must expose the complete structural envelope.'
        );
        assert.equal(parallelChat.pendingTool(),null);
        assert.equal(parallelChat.pendingToolCall(),null);
        assert.deepEqual(
            parallelChat.pendingTools(),
            [
                {id:'tool-one',name:'firstAction',message:'Run the first action?'},
                {id:'tool-two',name:'secondAction',message:'Run the second action?'}
            ]
        );
        assert.deepEqual(
            parallelChat.pendingToolCalls(),
            [firstParallelCall,secondParallelCall]
        );
        const pendingCallProjection=parallelChat.pendingToolCalls();
        pendingCallProjection[0].providerExtension.flags.push('caller-mutation');
        pendingCallProjection[0].function.functionExtension.nested.preserved=false;
        assert.deepEqual(
            parallelChat.pendingToolCalls(),
            [firstParallelCall,secondParallelCall],
            'Complete pending getters must return caller-mutable copies without losing fields.'
        );
        const boundEvent=parallelChat.events.find(event=>event.type==='chat-session-bound');
        assert.ok(boundEvent);
        assert.equal(boundEvent.detail.pendingTool,null);
        assert.equal(boundEvent.detail.pendingToolCall,null);
        assert.deepEqual(boundEvent.detail.pendingTools,parallelChat.pendingTools());
        assert.deepEqual(boundEvent.detail.pendingToolCalls,parallelChat.pendingToolCalls());

        const parallelChildrenBeforeRejection=parallelChat.chatOutput.children.length;
        await assert.rejects(
            parallelChat.submitToolResult({
                disposition:'executed',
                message:'A singular settlement must not partially commit this batch.',
                persist:false,
                toolCallId:'tool-one'
            }),
            error=>error?.code==='AI_CHAT_TOOL_RESULT_BATCH_REQUIRED'
        );
        await assert.rejects(
            parallelChat.submitToolResults({
                results:[{
                    toolCallId:'tool-one',
                    disposition:'executed',
                    message:'First action completed.',
                    persist:false
                }]
            }),
            error=>error?.code==='AI_CHAT_TOOL_RESULT_REQUIRED'
        );
        assert.equal(parallelChat.sends.length,0);
        assert.equal(parallelChat.chatOutput.children.length,parallelChildrenBeforeRejection);
        await assert.rejects(
            parallelChat.submitToolResults({
                results:[
                    {
                        toolCallId:'tool-one',
                        disposition:'executed',
                        message:'First action completed.',
                        persist:true
                    },
                    {
                        toolCallId:'tool-two',
                        disposition:'declined',
                        message:'Second action declined.',
                        persist:false
                    }
                ]
            }),
            error=>error?.code==='AI_CHAT_INCOHERENT_PERSISTENCE'
        );
        assert.equal(parallelChat.sends.length,0);
        assert.equal(parallelChat.chatOutput.children.length,parallelChildrenBeforeRejection);
        assert.deepEqual(
            await parallelChat.submitToolResults(
                {
                    results:[
                        {
                            toolCallId:'tool-two',
                            status:'declined',
                            message:'Second action declined.',
                            persist:false
                        },
                        {
                            toolCallId:'tool-one',
                            status:'executed',
                            message:'First action completed.',
                            persist:false
                        }
                    ]
                },
                {operationId:'parallel-settlement'}
            ),
            {accepted:true}
        );
        assert.equal(parallelChat.sends.length,1);
        assert.deepEqual(
            parallelChat.sends[0].requestMessages,
            [
                {
                    content:'Executed — First action completed.',
                    message:'First action completed.',
                    name:'firstAction',
                    persist:false,
                    role:'tool',
                    status:'executed',
                    tool_call_id:'tool-one'
                },
                {
                    content:'Declined — Second action declined.',
                    message:'Second action declined.',
                    name:'secondAction',
                    persist:false,
                    role:'tool',
                    status:'declined',
                    tool_call_id:'tool-two'
                }
            ],
            'Plural settlement must atomically submit every result in pending-call order.'
        );
        assert.deepEqual(
            parallelChat.chatOutput.children.slice(-2).map(item=>({
                content:item.querySelector('.markdown').raw,
                operationId:item.dataset.operationId,
                toolCallId:item.dataset.toolCallId
            })),
            [
                {
                    content:'Executed — First action completed.',
                    operationId:'parallel-settlement',
                    toolCallId:'tool-one'
                },
                {
                    content:'Declined — Second action declined.',
                    operationId:'parallel-settlement',
                    toolCallId:'tool-two'
                }
            ]
        );
        assert.equal(parallelChat.state().releaseCount,1);
        assert.equal(
            parallelChat.state().transcriptScrollTop,
            parallelChat.chatOutput.scrollHeight
        );

        const restoredCall={
            id:'restored-tool',
            type:'function',
            extension:{complete:{value:null}},
            function:{
                name:'restoredAction',
                arguments:JSON.stringify({message:'Resume the restored action?'}),
                extension:{complete:['yes','']}
            }
        };
        const restoredChat=createCompleteChatHarness([{
            role:'assistant',
            content:'A saved action is still pending.',
            timestamp:'2026-08-29T08:11:12.000Z',
            tool_calls:[restoredCall]
        }]);
        await restoredChat.bindSession({session:restoredChat.session});
        assert.deepEqual(restoredChat.pendingToolCall(),restoredCall);
        assert.deepEqual(
            await restoredChat.submitToolResult({
                disposition:'not-executed',
                message:'The restored action remains pending outside this chat.',
                persist:true
            }),
            {accepted:true}
        );
        assert.equal(restoredChat.sends.length,1);
        assert.equal(restoredChat.sends[0].requestMessages.length,1);
        assert.equal(restoredChat.sends[0].requestMessages[0].tool_call_id,'restored-tool');

        restoredChat.appendRejectedDraftTurn(
            'Preserve this rejected user request.',
            'rejected-operation',
            'rejected-response'
        );
        restoredChat.textArea.value='A newer unsent draft.';
        assert.equal(
            restoredChat.restoreRejectedStructuralDraft(
                'rejected-response',
                'rejected-operation',
                'Preserve this rejected user request.'
            ),
            true
        );
        assert.equal(
            restoredChat.textArea.value,
            'Preserve this rejected user request.\nA newer unsent draft.'
        );
        assert.equal(
            restoredChat.chatOutput.children.some(
                item=>item.id==='message-rejected-response'
                    ||item.dataset.operationId==='rejected-operation'
            ),
            false
        );

        const dispatchStart=source.indexOf('function dispatchChatEvent(');
        const dispatchEnd=source.indexOf('\n\n    function publicErrorFields',dispatchStart);
        const ownershipStart=source.indexOf('function isAbortSignal(value)');
        const ownershipEnd=source.indexOf('\n\n    host.sendMessage=',ownershipStart);
        const submissionStart=source.indexOf('function observeHostSubmission(');
        const submissionObservationEnd=source.indexOf(
            '\n\n    async function submitMessage',
            submissionStart
        );
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
            submissionObservationEnd,
            submissionEnd
        ]){
            assert.notEqual(boundary,-1);
        }
        const hostSubmissionObservationSource=source.slice(
            submissionStart,
            submissionObservationEnd
        );
        assert.match(
            hostSubmissionObservationSource,
            /console[.]error\([\s\S]*?internalStructuralToolFailure\(error\)[\s\S]*?'Arcane structural tool protocol failure[.]'[\s\S]*?error[\s\S]*?dispatchChatEvent\([\s\S]*?'chat-send-error'/u,
            'Raw structural diagnostics must remain available through console and the error event.'
        );
        assert.match(
            hostSubmissionObservationSource,
            /publicDetail:\{[\s\S]*?publicErrorFields\([\s\S]*?error,[\s\S]*?chatErrorCodes[.]hostMessageSubmissionRejected/u,
            'The error event must retain the complete underlying structural failure.'
        );
        assert.doesNotMatch(
            hostSubmissionObservationSource,
            /renderSessionMessageFailure|setSessionStatus|textArea[.]value/u,
            'Host submission observation must not project raw structural failures into visible chat UI.'
        );
        const createChatSubmissionHarness=Function(
            'ActivationEvent',
            `'use strict';
            return function createChatSubmissionHarness({cancelProjection=false}={}){
                const aiRuntimeStateAbortController=new AbortController();
                const activeSubmissionOwnerships=new Set();
                const chatReasons={
                    messageSubmissionRequested:'message-submission-requested',
                    messageSubmissionCancelled:'message-submission-cancelled',
                    callerSignalAborted:'caller-signal-aborted',
                    componentDestroyed:'component-destroyed',
                    hostMessageSubmissionRejected:'host-message-submission-rejected'
                };
                const chatErrorCodes={
                    messageSubmissionAborted:'ARCANE_CHAT_MESSAGE_SUBMISSION_ABORTED',
                    hostMessageSubmissionRejected:'ARCANE_CHAT_HOST_MESSAGE_SUBMISSION_REJECTED'
                };
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
                    descriptor:{instanceId:'chat-contract'},
                    dispatch(type,detail,options={}){
                        canonicalDispatchCount+=1;
                        return {
                            accepted:true,
                            occurrence:{
                                type,
                                detail:{...detail},
                                operationId:options.operationId??null,
                                publicDetail:{...options.publicDetail},
                                cancelable:options.cancelable===true
                            }
                        };
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
                return {
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
                        return {
                            sent:[...sent],
                            canonicalDispatchCount,
                            projectionCount,
                            projectedEvent,
                            activeSubmissionCount:activeSubmissionOwnerships.size
                        };
                    }
                };
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
        cancelledState.projectedEvent.detail.context.annotation='complete cancellation context';
        assert.equal(
            cancelledState.projectedEvent.detail.context.annotation,
            'complete cancellation context'
        );
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
            return {
                controller:aiRuntimeStateAbortController,
                wait:waitForConversationTimeboxRetry
            };`
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
    'shared speech preserves configured unmute until selected TTS is ready',
    async function testSpeechConfiguredUnmuteContract() {
        const source = await readFile(
            new URL('runtime/arcane/components/speech.html', repositoryRoot),
            'utf8'
        );
        const configuredStart = source.indexOf(
            'function applyConfiguredMutedState(muted)'
        );
        const configuredEnd = source.indexOf(
            '\n    function synchronizeAIRuntimeState',
            configuredStart
        );
        const transitionsStart = source.indexOf(
            'function applyRoleTransitions(previousSTTRole, previousTTSRole)'
        );
        const transitionsEnd = source.indexOf(
            '\n    function renderSTTActivationState',
            transitionsStart
        );
        const continuationStart = source.indexOf(
            'function continuePendingUnmute()'
        );
        const continuationEnd = source.indexOf(
            '\n    async function requestTTSIntent',
            continuationStart
        );
        const settleStart = source.indexOf(
            'function settleSuccessfulUnmute()'
        );
        const settleEnd = continuationStart;
        assert.notEqual(configuredStart, -1);
        assert.notEqual(configuredEnd, -1);
        assert.notEqual(transitionsStart, -1);
        assert.notEqual(transitionsEnd, -1);
        assert.notEqual(continuationStart, -1);
        assert.notEqual(continuationEnd, -1);
        assert.notEqual(settleStart, -1);

        const configured = source.slice(configuredStart, configuredEnd);
        const transitions = source.slice(transitionsStart, transitionsEnd);
        const continuation = source.slice(continuationStart, continuationEnd);
        const settle = source.slice(settleStart, settleEnd);
        assert.match(
            source,
            /if \(!host\.initialMuted\) \{\s+applyConfiguredMutedState\(false\);/u
        );
        assert.match(configured, /pendingUnmute = true;/u);
        assert.doesNotMatch(configured, /pendingUnmute = false;/u);
        assert.match(configured, /continuePendingUnmute\(\);/u);
        assert.match(
            transitions,
            /settleSuccessfulUnmute\(\);\s+continuePendingUnmute\(\);/u
        );
        assert.match(continuation, /!selectedRole\(ttsRole\)/u);
        assert.match(continuation, /ttsRole\.state !== 'unloaded'/u);
        assert.match(continuation, /void requestUserUnmute\(\);/u);

        const createHarness = Function(
            `'use strict';
            return function createConfiguredUnmuteHarness(initialRole) {
                let pendingUnmute = false;
                let destroyed = false;
                let pendingTTSIntent = null;
                let activeTTSIntent = null;
                let ttsRole = {...initialRole};
                let loadRequests = 0;
                const host = {muted: true};
                function requestUserMute() {
                    pendingUnmute = false;
                    host.muted = true;
                }
                function requestUserUnmute() {
                    loadRequests += 1;
                    return Promise.resolve(true);
                }
                function selectedRole(role) {
                    return typeof role.providerId === 'string'
                        && role.providerId.length > 0
                        && typeof role.modelId === 'string'
                        && role.modelId.length > 0;
                }
                function synchronizeAIMutedState() {}
                function renderControls() {}
                function renderStatus() {}
                function resumeTTSPlayback() {}
                ${configured}
                ${settle}
                ${continuation}
                return {
                    configure: applyConfiguredMutedState,
                    transition(state) {
                        ttsRole = {...ttsRole, state};
                        settleSuccessfulUnmute();
                        continuePendingUnmute();
                    },
                    snapshot() {
                        return {pendingUnmute, muted: host.muted, loadRequests};
                    }
                };
            };`
        )();
        const loading = createHarness({
            state: 'loading',
            providerId: 'browser-tts',
            modelId: 'kokoro-q8'
        });
        loading.configure(false);
        assert.deepEqual(
            loading.snapshot(),
            {pendingUnmute: true, muted: true, loadRequests: 0}
        );
        loading.transition('ready');
        assert.deepEqual(
            loading.snapshot(),
            {pendingUnmute: false, muted: false, loadRequests: 0}
        );

        const delayedSelection = createHarness({
            state: 'unavailable',
            providerId: null,
            modelId: null
        });
        delayedSelection.configure(false);
        delayedSelection.transition('unloaded');
        assert.equal(delayedSelection.snapshot().loadRequests, 0);
        const selectedAfterConfiguration = createHarness({
            state: 'unloaded',
            providerId: 'browser-tts',
            modelId: 'kokoro-q8'
        });
        selectedAfterConfiguration.configure(false);
        assert.equal(selectedAfterConfiguration.snapshot().loadRequests, 1);
    }
);

test(
    'shared speech components expose explicit available STT activation without hidden startup',
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
        controller.annotation='caller speech activation controller';
        assert.equal(controller.annotation,'caller speech activation controller');
        assert.equal(intents.length, 0);

        const unloaded = {
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
        };
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
        intents[0].context='caller speech activation intent';
        assert.equal(intents[0].context,'caller speech activation intent');
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
        loadEvent.detail.context='complete speech activation detail';
        assert.equal(loadEvent.detail.context,'complete speech activation detail');

        preventNextRequest = true;
        assert.equal(await controller.request('load'), false);
        assert.equal(intents.length, 1);

        reenterNextRequest = true;
        assert.equal(await controller.request('load'), false);
        assert.equal(await reentrantRequest, false);
        assert.equal(intents.length, 1, 'event reentry must not duplicate intent');

        const loading = {
            ...unloaded,
            state: 'loading',
            operationId: 'stt-load-1',
            progress: {
                phase: 'download',
                completed: 4,
                total: 10,
                unit: 'items',
                heartbeat: true
            }
        };
        controller.synchronize(loading);
        assert.equal(controller.action, 'unload');
        assert.equal(controller.label, 'Cancel loading');
        assert.equal(controller.status, 'Transcription download; Cancel is available.');
        assert.equal(await controller.request('unload'), true);
        assert.deepEqual(
            intents.at(-1),
            {role: 'stt', action: 'unload', reason: 'user'}
        );
        controller.synchronize({
            ...loading,
            progress: {
                ...loading.progress,
                total: null,
                heartbeat: false
            }
        });
        assert.equal(
            controller.status,
            'Transcription download; Cancel is available.'
        );

        controller.synchronize({...loading, state: 'unloading', progress: null});
        assert.equal(controller.action, null);
        assert.equal(controller.label, 'Canceling…');
        assert.match(controller.status, /releasing/u);

        const callbackFailure = new Error('STT activation callback failed.');
        controller.synchronize({...unloaded, state: 'error'});
        assert.equal(controller.label, 'Try again');
        synchronizeNextRequest = loading;
        assert.equal(await controller.request('load'), false);
        assert.equal(
            intents.at(-1).action,
            'unload',
            'synchronous state replacement must suppress the stale load intent'
        );
        controller.synchronize({...unloaded, state: 'error'});
        activationFailure = callbackFailure;
        assert.equal(await controller.request('load'), false);
        const errorEvent = events.at(-1);
        assert.equal(errorEvent.type, 'speech-stt-activation-error');
        assert.equal(errorEvent.detail.error, callbackFailure);
        errorEvent.detail.context='complete speech activation error';
        assert.equal(errorEvent.detail.context,'complete speech activation error');

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

        controller.synchronize({
            ...unloaded,
            state: 'ready',
            loaded: true,
            busy: true,
            operationId: 'stt-transcribe-1'
        });
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
            /fetchSTT\([\s\S]*audioFile,[\s\S]*controller[.]signal/u,
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
        speechFailure.context='complete speech failure context';
        assert.equal(speechFailure.context,'complete speech failure context');
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
        const availabilityStart = voiceSource.indexOf(
            'function canStartVoiceRecording('
        );
        const availabilityEnd = voiceSource.indexOf(
            '\n\n    function optionsFromDataset',
            availabilityStart
        );
        assert.notEqual(availabilityStart, -1);
        assert.notEqual(availabilityEnd, -1);
        const availabilitySource = voiceSource.slice(
            availabilityStart,
            availabilityEnd
        );
        const canStartVoiceRecording = Function(
            `'use strict';\n${availabilitySource}\nreturn canStartVoiceRecording;`
        )();
        const ready = {
            ...unloaded,
            state: 'ready',
            loaded: true
        };
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
                    {...unloaded, state: unavailableState},
                    'idle',
                    false
                ),
                false
            );
        }
        assert.equal(canStartVoiceRecording(ready, 'idle', false), true);
        assert.equal(canStartVoiceRecording(ready, 'error', false), true);
        assert.equal(
            canStartVoiceRecording({...ready, busy: true}, 'idle', false),
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
                ${availabilitySource}
                ${voiceSource.slice(startLifecycleStart, startLifecycleEnd)}
                return {
                    busy(){sttRole={...sttRole,busy:true};},
                    get permissionRequests(){return permissionRequests;},
                    get recorderStarts(){return recorderStarts;},
                    get recorderStops(){return recorderStops;},
                    resolve(){resolvePermission?.(stream);},
                    start:startRecording,
                    get state(){return state;},
                    get trackStops(){return trackStops;}
                };
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
            return {
                run:stopRecording,
                get stopCalls(){return stopCalls;}
            };`
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
            'Programmatic recording must fail before microphone access when STT is unavailable.'
        );
        assert.match(
            voiceSource,
            /return globalThis[.]ai[.]fetchSTT\(file,signal\)/u,
            'The default voice path must pass the owned signal to AI.fetchSTT.'
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
            return {
                get active(){return transcriptionAbortController;},
                release:releaseTranscriptionController,
                set active(value){transcriptionAbortController=value;}
            };`
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
                return {
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
                };
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
                return {
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
                };
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
                return {events,ready:host.ready,subscriptions};
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
            return {
                cancel:cancelSTTOperation,
                get generation(){return sessionGeneration;},
                get state(){return state;}
            };`
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
        controller.synchronize({...unloaded, state: 'error'});
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
    'calculator lifecycle events use the singleton authority without changing results',
    async function testCalculatorEventAuthority() {
        const [{default: CalculatorEngine, CALCULATOR_ENGINE_ERROR_CODES}, {arcaneEvents}]
            = await Promise.all([
                import('../runtime/arcane/modules/CalculatorEngine.js'),
                import('../src/event-manager.mjs')
            ]);
        const engine = new CalculatorEngine();
        const canonicalEvents = [];
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
        const calculation = engine.calculate('2 + 3');
        assert.equal(calculation.result, 5);
        const resultOccurrence = canonicalEvents.find(
            event => event.type === 'calculator-result'
        );
        const instanceId = resultOccurrence.instanceId;
        assert.deepEqual(resultOccurrence.detail, {result: 5});
        resultOccurrence.detail.annotation='complete result occurrence';
        assert.equal(
            resultOccurrence.detail.annotation,
            'complete result occurrence'
        );
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
        const errorOccurrence = canonicalEvents.find(
            event => event.instanceId === instanceId && event.type === 'calculator-error'
        );
        assert.deepEqual(errorOccurrence.detail, {
            code: CALCULATOR_ENGINE_ERROR_CODES.domain,
            error: domainError,
            expression: '1 / 0'
        });
        errorOccurrence.detail.annotation='complete error occurrence';
        assert.equal(
            errorOccurrence.detail.annotation,
            'complete error occurrence'
        );
        assert.throws(
            function rejectCalculatorInputFailure() {
                engine.calculate('');
            },
            error => error?.code === CALCULATOR_ENGINE_ERROR_CODES.input
        );

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

test(
    'shared chat and speech controls survive persisted BFCache navigation',
    async function testSharedComponentBFCacheLifecycle() {
        const components=[
            {
                path:'runtime/arcane/components/chat.html',
                restoredBy:['setAIAvailability','scrollTranscriptToBottom']
            },
            {
                path:'runtime/arcane/components/speech.html',
                restoredBy:[
                    'synchronizeAIMutedState',
                    'renderControls',
                    'renderStatus'
                ]
            },
            {
                path:'runtime/arcane/components/voice-transcription.html',
                restoredBy:['renderState']
            }
        ];

        for(const component of components){
            const source=await readFile(
                new URL(component.path,repositoryRoot),
                'utf8'
            );
            const pageHideStart=source.indexOf('function handlePageHide(event)');
            const restoreStart=source.indexOf(
                'function restoreFromPageCache()',
                pageHideStart
            );
            const destroyStart=source.indexOf('function destroy()',restoreStart);
            assert.notEqual(pageHideStart,-1,`${component.path} must own pagehide`);
            assert.notEqual(restoreStart,-1,`${component.path} must own pageshow restore`);
            assert.notEqual(destroyStart,-1,`${component.path} must retain destroy`);

            const handlersSource=source.slice(pageHideStart,restoreStart);
            const restoreSource=source.slice(restoreStart,destroyStart);
            for(const call of component.restoredBy){
                assert.ok(
                    restoreSource.includes(`${call}();`),
                    `${component.path} must refresh ${call}()`
                );
            }
            assert.match(
                source,
                /'pagehide',\s*handlePageHide,\s*\{[^}]*signal:/u
            );
            assert.match(
                source,
                /'pageshow',\s*handlePageShow,\s*\{[^}]*signal:/u
            );
            assert.doesNotMatch(
                source,
                /'pagehide',\s*destroy,/u
            );
            assert.doesNotMatch(
                source,
                /'(?:pagehide|pageshow)',\s*(?:handlePageHide|handlePageShow),\s*\{[^}]*once\s*:\s*true/u
            );

            const restoredCalls=Object.fromEntries(
                component.restoredBy.map(function initializeRestoreCount(name){
                    return [name,0];
                })
            );
            const restoreStubs=component.restoredBy.map(
                function createRestoreStub(name){
                    return `function ${name}(){restoredCalls.${name}+=1;}`;
                }
            ).join('\n');

            const createHarness=Function(
                `'use strict';
                return function createPageLifecycleHarness(){
                    let destroyed=false;
                    let destroyCount=0;
                    const restoredCalls=${JSON.stringify(restoredCalls)};
                    function destroy(){
                        if(destroyed){
                            return false;
                        }
                        destroyed=true;
                        destroyCount+=1;
                        return true;
                    }
                    ${restoreStubs}
                    ${restoreSource}
                    ${handlersSource}
                    return {
                        pagehide:handlePageHide,
                        pageshow:handlePageShow,
                        snapshot:function snapshotPageLifecycle(){
                            return {destroyed,destroyCount,restoredCalls:{...restoredCalls}};
                        }
                    };
                };`
            )();
            const lifecycle=createHarness();
            const noRestores={...restoredCalls};
            const oneRestore=Object.fromEntries(
                component.restoredBy.map(function expectedSingleRestore(name){
                    return [name,1];
                })
            );

            lifecycle.pagehide({persisted:true});
            assert.deepEqual(
                lifecycle.snapshot(),
                {destroyed:false,destroyCount:0,restoredCalls:noRestores}
            );
            lifecycle.pageshow({persisted:true});
            assert.deepEqual(
                lifecycle.snapshot(),
                {destroyed:false,destroyCount:0,restoredCalls:oneRestore}
            );
            lifecycle.pageshow({persisted:false});
            lifecycle.pagehide({persisted:true});
            assert.deepEqual(
                lifecycle.snapshot(),
                {destroyed:false,destroyCount:0,restoredCalls:oneRestore}
            );
            lifecycle.pagehide({persisted:false});
            lifecycle.pagehide({persisted:false});
            lifecycle.pageshow({persisted:true});
            assert.deepEqual(
                lifecycle.snapshot(),
                {destroyed:true,destroyCount:1,restoredCalls:oneRestore}
            );
        }
    }
);

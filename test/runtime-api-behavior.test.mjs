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

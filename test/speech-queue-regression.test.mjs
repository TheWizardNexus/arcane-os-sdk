import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';

import test from '../src/testing.mjs';

function deferred(){
    let resolve;
    const promise=new Promise(function captureCompletion(complete){
        resolve=complete;
    });
    return {promise,resolve};
}

function observeCompletion(promise){
    const completion={settled:false,result:undefined};
    promise.then(function recordCompletion(result){
        completion.settled=true;
        completion.result=result;
    });
    return completion;
}

test(
    'AI speech queue preserves synthesis order and actual playback completion',
    async function testSpeechQueue(t){
        // This exercises the real AI and provider runtime with synthetic provider
        // results and a simulated Web Audio clock. It does not generate speech,
        // decode a real recording, or establish audible behavior in a consumer.
        const previousGlobals=new Map(
            ['window','document','localStorage','user'].map(function readGlobal(key){
                return [key,Object.getOwnPropertyDescriptor(globalThis,key)];
            })
        );
        const windowTarget=new EventTarget();
        const documentObject={
            documentElement:{dataset:{arcaneAppId:'speech-queue-regression'}},
            querySelector(){return null;}
        };
        const storedValues=new Map();
        const storage={
            getItem(key){return storedValues.get(String(key))??null;},
            setItem(key,value){storedValues.set(String(key),String(value));},
            removeItem(key){storedValues.delete(String(key));}
        };
        windowTarget.dbopfs={ready:false,get(){}};
        windowTarget.user={ready:false,developer:false};
        windowTarget.document=documentObject;
        windowTarget.localStorage=storage;
        globalThis.window=windowTarget;
        globalThis.document=documentObject;
        globalThis.localStorage=storage;
        globalThis.user=windowTarget.user;

        let ai;
        let unregisterProvider;
        const responses=new Map();
        t.after(async function restoreSpeechEnvironment(){
            try{
                ai?.stopAudio();
                for(const response of responses.values())response.release();
                if(ai){
                    await ai.setSpeechMuted(true);
                    ai.providerRuntime.configure({
                        llm:{default:null,localOnly:null},
                        stt:{default:null,localOnly:null},
                        tts:{default:null,localOnly:null}
                    });
                }
                if(unregisterProvider)await unregisterProvider();
            }finally{
                const registration=globalThis[
                    Symbol.for('arcane.ai.user-ready-registration')
                ];
                registration?.dispose();
                for(const [key,descriptor] of previousGlobals){
                    if(descriptor){
                        Object.defineProperty(globalThis,key,descriptor);
                    }else{
                        delete globalThis[key];
                    }
                }
            }
        });

        const {default:AI}=await import('../runtime/arcane/modules/AI.js');
        const {
            AI_MODEL_AUTHORITY_PROTOCOL,
            AI_PROVIDER_PROTOCOL
        }=await import('../runtime/arcane/modules/AIProviderRuntime.js');

        // Product model startup is outside this queue test. The constructor still
        // creates the real queue, events, and provider runtime; the selected mock
        // provider below supplies every synthesis request through the public API.
        class QueueTestAI extends AI{
            setAI(){return true;}
        }
        ai=new QueueTestAI();
        const requests=[];
        const pendingResponses=[];
        const starts=[];
        let providerState='unloaded';
        const model={
            id:'queue-test-model',
            defaultVoice:'catalog-selected-voice',
            speech:{
                outputSampleRate:24_000,
                responseFormats:['wav'],
                defaultResponseFormat:'wav'
            }
        };
        const provider={
            protocol:AI_PROVIDER_PROTOCOL,
            id:'queue-test-provider',
            role:'tts',
            localOnly:true,
            maxConcurrentRequests:4,
            catalog(){return [model];},
            inspect(selection){
                return {
                    available:true,
                    authority:{
                        protocol:AI_MODEL_AUTHORITY_PROTOCOL,
                        providerId:this.id,
                        modelId:selection.modelId
                    }
                };
            },
            status(){
                return {
                    state:providerState,
                    loaded:providerState==='ready',
                    busy:false
                };
            },
            async load(){providerState='ready';},
            async request(context){
                const response=pendingResponses.shift();
                assert.ok(response,'Every synthesis request has an explicit response.');
                requests.push(context);
                response.request=context;
                response.requested.resolve();
                return response.generated.promise;
            },
            async unload(){providerState='unloaded';},
            async dispose(){providerState='disposed';}
        };
        unregisterProvider=ai.providerRuntime.register(provider);
        const selection={
            providerId:provider.id,
            modelId:model.id,
            localOnly:true
        };
        ai.providerRuntime.configure({
            llm:{default:null,localOnly:null},
            stt:{default:null,localOnly:null},
            tts:{default:selection,localOnly:selection}
        });
        ai.ttsService=provider.id;
        ai.modelTTS=model.id;
        await ai.setSpeechMuted(false);
        assert.equal(ai.muted,false);
        ai.configureTTSSegmentation({punctuation:'none',wordCadence:null});

        const audioContext={
            state:'running',
            currentTime:10,
            destination:{},
            async decodeAudioData(buffer){
                // The response token identifies synthetic decoded audio. No WAV
                // parser, speech model, device, or wall-clock playback is used.
                const token=new TextDecoder().decode(buffer);
                const response=responses.get(token);
                assert.ok(response,'Decoded audio belongs to the requested response.');
                response.decoded.resolve();
                return {
                    token,
                    duration:response.duration,
                    sampleRate:24_000,
                    numberOfChannels:1
                };
            },
            createBufferSource(){
                const source={
                    context:this,
                    buffer:null,
                    playbackRate:{value:1},
                    onended:null,
                    stopped:false,
                    disconnected:false,
                    connect(){},
                    disconnect(){this.disconnected=true;},
                    start(time){
                        const response=responses.get(this.buffer.token);
                        this.startTime=time;
                        starts.push({token:this.buffer.token,time});
                        response.source=this;
                        response.scheduled.resolve();
                    },
                    stop(){this.stopped=true;},
                    finish(){
                        this.context.currentTime=this.startTime+this.buffer.duration;
                        this.onended?.();
                    }
                };
                return source;
            }
        };
        ai.audioContext=audioContext;

        function prepareResponse(token,duration){
            const response={
                token,duration,
                requested:deferred(),
                generated:deferred(),
                decoded:deferred(),
                scheduled:deferred(),
                release(){
                    this.generated.resolve({
                        audio:new TextEncoder().encode(this.token),
                        contentType:'audio/wav'
                    });
                }
            };
            responses.set(token,response);
            pendingResponses.push(response);
            return response;
        }

        await t.test(
            'Out-of-order synthesis schedules adjacent audio with the requested pause',
            async function testOrderedScheduling(){
                const first=prepareResponse('ordered-first',1.25);
                const second=prepareResponse('ordered-second',0.75);
                const third=prepareResponse('ordered-third',0.5);
                const options={voice:'af_heart',speed:1.125,waitForPlayback:true};
                const firstPlayback=ai.streamTTS('  First speech.\n',true,{
                    ...options,pauseAfterMs:125
                });
                const secondPlayback=ai.streamTTS('Second speech?  ',true,options);
                const thirdPlayback=ai.streamTTS('Third speech!',true,options);
                const firstCompletion=observeCompletion(firstPlayback);
                const secondCompletion=observeCompletion(secondPlayback);
                const thirdCompletion=observeCompletion(thirdPlayback);
                const completion=observeCompletion(Promise.all([
                    firstPlayback,secondPlayback,thirdPlayback
                ]));
                await Promise.all([first,second,third].map(
                    response=>response.requested.promise
                ));
                const originalTexts=['  First speech.\n','Second speech?  ','Third speech!'];
                for(const [index,response] of [first,second,third].entries()){
                    assert.deepEqual(response.request.payload,{
                        model:model.id,
                        input:originalTexts[index],
                        voice:options.voice,
                        responseFormat:'wav',
                        speed:options.speed
                    });
                }

                third.release();
                await third.decoded.promise;
                await setImmediate();
                assert.deepEqual(starts,[]);
                first.release();
                await first.scheduled.promise;
                assert.deepEqual(starts,[{token:first.token,time:10}]);
                second.release();
                await Promise.all([second.scheduled.promise,third.scheduled.promise]);
                assert.deepEqual(starts,[
                    {token:first.token,time:10},
                    {token:second.token,time:11.375},
                    {token:third.token,time:12.125}
                ]);
                assert.equal(
                    second.source.startTime,
                    first.source.startTime+first.duration+0.125
                );
                assert.equal(
                    third.source.startTime,
                    second.source.startTime+second.duration
                );
                await setImmediate();
                assert.equal(completion.settled,false);
                assert.equal(firstCompletion.settled,false);
                assert.equal(secondCompletion.settled,false);
                assert.equal(thirdCompletion.settled,false);

                first.source.finish();
                assert.equal(await firstPlayback,true);
                await setImmediate();
                assert.equal(completion.settled,false);
                assert.equal(secondCompletion.settled,false);
                assert.equal(thirdCompletion.settled,false);
                second.source.finish();
                assert.equal(await secondPlayback,true);
                await setImmediate();
                assert.equal(completion.settled,false);
                assert.equal(thirdCompletion.settled,false);
                third.source.finish();
                assert.equal(await thirdPlayback,true);
                await setImmediate();
                assert.deepEqual(completion.result,[true,true,true]);
                assert.equal(ai.isSpeaking,false);
                assert.equal(ai.speechJobs.length,0);
            }
        );

        await t.test(
            'Selected and caller-provided voice, speed, and complete text reach synthesis',
            async function testSpeechPayload(){
                const selected=prepareResponse('selected-voice',0.5);
                const exactText='  Café — 東京.\nFull selected text!  ';
                ai.voiceSpeed=0.875;
                const prepared=ai.streamTTS(exactText,true);
                await selected.requested.promise;
                assert.deepEqual(selected.request.payload,{
                    model:model.id,
                    input:exactText,
                    voice:model.defaultVoice,
                    responseFormat:'wav',
                    speed:0.875
                });
                selected.release();
                assert.equal(await prepared,true);
                await selected.scheduled.promise;
                selected.source.finish();
            }
        );

        await t.test(
            'Stop cancels scheduled playback and pending synthesis without late playback',
            async function testStopWithPendingSynthesis(){
                const first=prepareResponse('stopped-first',1);
                const second=prepareResponse('stopped-second',1);
                const pending=prepareResponse('stopped-pending',1);
                const playbacks=[first,second,pending].map(function queueResponse(response){
                    return ai.streamTTS(response.token,true,{waitForPlayback:true});
                });
                await Promise.all([first,second,pending].map(
                    response=>response.requested.promise
                ));
                first.release();
                second.release();
                await Promise.all([first.scheduled.promise,second.scheduled.promise]);
                const scheduledBeforeStop=[...starts];
                ai.stopAudio();
                assert.deepEqual(await Promise.all(playbacks),[false,false,false]);
                for(const response of [first,second]){
                    assert.equal(response.source.stopped,true);
                    assert.equal(response.source.disconnected,true);
                    assert.equal(response.source.onended,null);
                }
                assert.equal(pending.request.signal.aborted,true);
                pending.release();
                await setImmediate();
                assert.deepEqual(starts,scheduledBeforeStop);
                assert.equal(ai.speechJobs.length,0);
                assert.equal(ai.sourceNodes.length,0);
                assert.equal(ai.currentSpeechJob,null);
                assert.equal(ai.isSpeaking,false);
            }
        );

        await t.test(
            'Stop before generation starts settles queued playback without dispatch',
            async function testStopBeforeGeneration(){
                const dispatchedBeforeStop=requests.length;
                const playback=ai.streamTTS('Queued speech.',true,{waitForPlayback:true});
                ai.stopAudio();
                assert.equal(await playback,false);
                await setImmediate();
                assert.equal(requests.length,dispatchedBeforeStop);
                assert.equal(ai.speechJobs.length,0);
                assert.equal(ai.audioMessageChunks,'');
            }
        );
    }
);

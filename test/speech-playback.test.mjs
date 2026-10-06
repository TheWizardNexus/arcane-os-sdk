import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import test from '../src/testing.mjs';
import {arcaneEvents} from '../src/event-manager.mjs';
import {
    SPEECH_PLAYBACK_STATE_EVENT,
    SPEECH_VOICE_ALIASES,
    SPEECH_VOICE_OPTIONS,
    SpeechPlayback,
    splitSpeechText
} from '../runtime/arcane/modules/SpeechPlayback.js';

class ContractAudio extends EventTarget {
    constructor() {
        super();
        this.currentTime = 0;
        this.ended = false;
        this.hidden = true;
        this.paused = true;
        this.src = '';
    }

    load() {}

    async play() {
        this.paused = false;
        this.dispatchEvent(new Event('play'));
    }

    pause() {
        this.paused = true;
        this.dispatchEvent(new Event('pause'));
    }

    removeAttribute(name) {
        if (name === 'src') {
            this.src = '';
        }
    }
}

function writeASCII(bytes,offset,value) {
    for(let index=0;index<value.length;index+=1) {
        bytes[offset+index]=value.charCodeAt(index);
    }
}

function minimalWavBytes() {
    const sampleBytes=2;
    const buffer=new ArrayBuffer(44+sampleBytes);
    const bytes=new Uint8Array(buffer);
    const view=new DataView(buffer);
    writeASCII(bytes,0,'RIFF');
    view.setUint32(4,36+sampleBytes,true);
    writeASCII(bytes,8,'WAVE');
    writeASCII(bytes,12,'fmt ');
    view.setUint32(16,16,true);
    view.setUint16(20,1,true);
    view.setUint16(22,1,true);
    view.setUint32(24,8000,true);
    view.setUint32(28,16000,true);
    view.setUint16(32,2,true);
    view.setUint16(34,16,true);
    writeASCII(bytes,36,'data');
    view.setUint32(40,sampleBytes,true);
    view.setInt16(44,0,true);
    return bytes;
}

function minimalWavBlob() {
    return new Blob([minimalWavBytes()],{type:'audio/wav'});
}

function deferredRequest() {
    let resolve;
    let reject;
    const promise=new Promise(function captureDeferredRequest(
        resolveRequest,
        rejectRequest
    ) {
        resolve=resolveRequest;
        reject=rejectRequest;
    });
    return {promise,reject,resolve};
}

async function waitForContract(condition,message) {
    for(let attempt=0;attempt<25;attempt+=1) {
        if(condition())return;
        await new Promise(function waitForAsyncContractTurn(resolve) {
            globalThis.setTimeout(resolve,0);
        });
    }
    assert.fail(message);
}

function nativeSpeechFixture(input,controls,exposeRelease=true) {
    return {
        kind:'native-speech',
        input,
        play({signal,onState}) {
            const completion=deferredRequest();
            const release=deferredRequest();
            const control={
                input,
                signal,
                onState,
                finished:completion.promise,
                ...(exposeRelease?{released:release.promise}:{}),
                state:'playing',
                error:null,
                stops:0,
                pause() {
                    control.state='paused';
                    onState({state:'paused',error:null});
                    return true;
                },
                resume() {
                    control.state='playing';
                    onState({state:'playing',error:null});
                    return true;
                },
                stop() {
                    control.stops+=1;
                    if(control.stopFailure) {
                        control.fail(control.stopFailure);
                        return false;
                    }
                    control.state=control.error?'error':'stopped';
                    signal.removeEventListener('abort',stopForAbort);
                    onState({state:control.state,error:control.error});
                    if(control.error)completion.reject(control.error);
                    else completion.resolve(false);
                    release.resolve();
                    return true;
                },
                finish() {
                    control.state=control.error?'error':'complete';
                    signal.removeEventListener('abort',stopForAbort);
                    onState({state:control.state,error:control.error});
                    if(control.error)completion.reject(control.error);
                    else completion.resolve(true);
                    release.resolve();
                },
                fail(error) {
                    control.error=error;
                    control.state='error';
                    onState({state:'error',error});
                    completion.reject(error);
                }
            };
            function stopForAbort() {
                control.stop();
            }
            signal.addEventListener('abort',stopForAbort,{once:true});
            controls.push(control);
            onState({state:'playing',error:null});
            return control;
        }
    };
}

test(
    'SpeechPlayback forwards exact plain input through every client and preserves default cleanup',
    async function testPlainSpeechPlayback() {
        for(const method of ['prepareTTSPlayback','fetchTTS','prepare','synthesize']) {
            const requests=[];
            const speech={
                async [method](payload,options,preparation) {
                    requests.push({payload,options,preparation});
                    return minimalWavBlob();
                }
            };
            const audio=new ContractAudio();
            const playback=new SpeechPlayback({
                audio,
                speech,
                textFormat:'plain',
                createObjectURL:function createPlainSpeechURL() {
                    return `blob:plain-${method}-${requests.length}`;
                },
                revokeObjectURL:function releasePlainSpeechURL() {}
            });
            const question='  **Question?**\nKeep _these_ marks and *##*.  ';
            const answer='\n## Answer\n`code` ~~literal~~  ';
            const parts=[
                {input:question,voice:'question-voice',role:'question'},
                {input:answer,voice:'answer-voice',role:'answer'}
            ];
            try {
                assert.deepEqual(await playback.prepare({parts,autoplay:false}),{
                    ready:true,
                    played:false
                });
                await waitForContract(
                    function everyPlainPartRequested() {return requests.length===2;},
                    `${method} must receive both complete plain parts`
                );
                for(let index=0;index<parts.length;index+=1) {
                    assert.deepEqual(requests[index].payload,{
                        input:parts[index].input,
                        textFormat:'plain',
                        speed:1,
                        voice:parts[index].voice
                    });
                    assert.deepEqual(requests[index].preparation,{speechInputPrepared:true});
                    assert.equal(playback.parts[index].input,parts[index].input);
                    assert.equal(Object.hasOwn(parts[index],'textFormat'),false);
                }
                assert.equal(audio.paused,true);
                await playback.prepare({
                    parts:[{input:'**Default cleanup.**'}],
                    textFormat:null,
                    autoplay:false
                });
                assert.deepEqual(requests.at(-1).payload,{
                    input:'Default cleanup.',
                    speed:1
                });
                await playback.prepare({
                    parts:[{input:question}],
                    textFormat:'plain',
                    autoplay:false
                });
                assert.equal(requests.at(-1).payload.input,question);
                assert.equal(requests.at(-1).payload.textFormat,'plain');
                await playback.prepare({parts:[{input:answer}],autoplay:false});
                assert.equal(requests.at(-1).payload.input,answer);
                assert.equal(requests.at(-1).payload.textFormat,'plain');
            } finally {
                playback.destroy();
            }
        }
    }
);

test(
    'SpeechPlayback prepares native parts silently and advances only after native completion',
    async function testNativePlaybackOrderAndControls() {
        const requests=[];
        const controls=[];
        const audio=new ContractAudio();
        const playback=new SpeechPlayback({
            audio,
            speech:{
                providerRuntime:{
                    status() {
                        return {execution:{maxConcurrentRequests:4}};
                    }
                },
                prepareTTSPlayback(payload,signal,preparation) {
                    requests.push({payload,signal,preparation});
                    return nativeSpeechFixture(payload.input,controls);
                },
                fetchTTS() {
                    assert.fail('Native preparation must use the playback union.');
                }
            },
            createObjectURL() {
                assert.fail('Native speech does not produce an audio URL.');
            },
            revokeObjectURL() {
                assert.fail('Native speech has no audio URL to revoke.');
            }
        });
        try {
            assert.deepEqual(await playback.prepare({
                parts:['**First.**','Second.','Third.'],
                voice:'native-voice-uri',
                autoplay:false
            }),{ready:true,played:false});
            await waitForContract(
                () => playback.nativeSegments.size===3,
                'Every native descriptor should be prepared without starting speech.'
            );
            assert.equal(controls.length,0);
            assert.deepEqual(playback.urls,[]);
            assert.equal(audio.src,'');
            assert.equal(audio.hidden,true);
            assert.equal(playback.hasAudio(),true);
            assert.deepEqual(requests.map(function requestedInput(request) {
                return request.payload.input;
            }),['First.','Second.','Third.']);
            assert.equal(requests.every(function preparationIsMarked(request) {
                return request.signal instanceof AbortSignal
                    &&request.preparation.speechInputPrepared===true
                    &&request.payload.voice==='native-voice-uri';
            }),true);

            assert.equal(await playback.play(),true);
            assert.equal(controls.length,1);
            assert.equal(playback.state,'playing');
            assert.equal(await playback.togglePause(),true);
            assert.equal(controls[0].state,'paused');
            assert.equal(playback.state,'paused');
            assert.equal(await playback.togglePause(),true);
            assert.equal(controls[0].state,'playing');
            assert.equal(controls.length,1);

            controls[0].onState({state:'complete',error:null});
            audio.dispatchEvent(new Event('ended'));
            await Promise.resolve();
            assert.equal(controls.length,1);
            assert.equal(playback.index,0);
            controls[0].finish();
            await waitForContract(
                () => controls.length===2,
                'The second part should start after the first native end.'
            );
            assert.equal(controls[1].input,'Second.');
            controls[1].finish();
            await waitForContract(
                () => controls.length===3,
                'The third part should retain narration order.'
            );
            assert.equal(controls[2].input,'Third.');
            const completion=playback.nativePlayback.completion;
            controls[2].finish();
            assert.equal(await completion,true);
            assert.equal(playback.state,'ended');
            assert.equal(playback.nativePlayback,null);
        } finally {
            playback.destroy();
        }
    }
);

test(
    'SpeechPlayback distinguishes native stopped completion from initial ready',
    async function testNativeStoppedReason() {
        const controls=[];
        const states=[];
        const playback=new SpeechPlayback({
            audio:new ContractAudio(),
            speech:{
                prepare(payload) {return nativeSpeechFixture(payload.input,controls);}
            },
            onState:function observeNativeStoppedState(detail) {states.push(detail);}
        });
        try {
            await playback.prepare({parts:['First.','Second.'],autoplay:false});
            const initial=states.find(function initiallyReady(detail) {
                return detail.state==='ready';
            });
            assert.equal(initial.reason,null);
            await playback.play();
            controls[0].stop();
            await waitForContract(function nativeStoppedReported() {
                return states.some(function stopped(detail) {
                    return detail.reason==='native-playback-stopped';
                });
            },'Native non-natural completion must have a public semantic reason.');
            const stopped=states.at(-1);
            assert.equal(stopped.state,'ready');
            assert.equal(stopped.reason,'native-playback-stopped');
            assert.equal(stopped.operationId,initial.operationId);
            assert.equal(stopped.index,0);
            assert.equal(controls.length,1);
            assert.equal(states.some(function naturallyEnded(detail) {
                return detail.state==='ended';
            }),false);
        } finally {
            playback.destroy();
        }
    }
);

test(
    'SpeechPlayback native replay and disposal suppress superseded completion',
    async function testNativeReplayCancellation() {
        const controls=[];
        const requests=[];
        const playback=new SpeechPlayback({
            audio:new ContractAudio(),
            speech:{
                prepare(payload,{signal}) {
                    requests.push({payload,signal});
                    return nativeSpeechFixture(payload.input,controls,false);
                }
            },
            createObjectURL() {
                assert.fail('Native preview must not create an audio URL.');
            },
            revokeObjectURL() {
                assert.fail('Native preview must not revoke an audio URL.');
            }
        });
        try {
            await playback.prepare({parts:['First.','Second.'],autoplay:false});
            await waitForContract(
                () => playback.nativeSegments.has(1),
                'Direct native preparation should keep one silent lookahead.'
            );
            assert.equal(requests.length,2);
            assert.equal(controls.length,0);
            await playback.play();
            const originalCompletion=playback.nativePlayback.completion;
            controls[0].finish();
            assert.equal(await playback.replay(),true);
            assert.equal(await originalCompletion,false);
            assert.equal(controls[0].signal.aborted,true);
            assert.equal(controls.length,2);
            assert.equal(controls[1].input,'First.');
            assert.equal(playback.index,0);
            controls[0].onState({state:'paused',error:null});
            assert.equal(playback.state,'playing');

            const stopped=controls[1];
            const stoppedCompletion=playback.nativePlayback.completion;
            playback.stop();
            assert.equal(stopped.signal.aborted,true);
            assert.ok(stopped.stops>0);
            assert.equal(await stoppedCompletion,false);
            assert.equal(playback.hasAudio(),false);
            assert.equal(playback.nativeSegments.size,0);
            assert.equal(controls.length,2);

            await playback.prepare({parts:['New narration.'],autoplay:true});
            const disposed=controls[2];
            const disposedCompletion=playback.nativePlayback.completion;
            assert.equal(playback.destroy(),true);
            assert.equal(disposed.signal.aborted,true);
            assert.ok(disposed.stops>0);
            assert.equal(await disposedCompletion,false);
            assert.equal(playback.nativePlayback,null);
            assert.equal(playback.state,'idle');
        } finally {
            playback.destroy();
        }
    }
);

test(
    'SpeechPlayback observes native failures without advancing narration',
    async function testNativePlaybackFailure() {
        const controls=[];
        const playback=new SpeechPlayback({
            audio:new ContractAudio(),
            speech:{
                prepare(payload) {
                    return nativeSpeechFixture(payload.input,controls);
                }
            }
        });
        try {
            await playback.prepare({parts:['First.','Second.'],autoplay:true});
            const completion=playback.nativePlayback.completion;
            const failure=new Error('The native speech service failed.');
            failure.code='ARCANE_AI_SPEECH_SYNTHESIS_FAILED';
            controls[0].fail(failure);
            assert.equal(await completion,false);
            assert.equal(playback.state,'error');
            assert.equal(playback.index,0);
            assert.equal(controls.length,1);
            assert.equal(playback.nativePlayback.control,controls[0]);
            assert.equal(playback.nativePlayback.failed,true);
            const release=playback.nativePlayback.releaseCompletion;
            controls[0].finish();
            await release;
            assert.equal(playback.nativePlayback,null);
            assert.equal(playback.state,'error');
            assert.equal(controls.length,1);
        } finally {
            playback.destroy();
        }
    }
);

test(
    'SpeechPlayback retains native ownership when stopping fails until actual release',
    async function testNativeStopFailureLifetime() {
        const controls=[];
        const playback=new SpeechPlayback({
            audio:new ContractAudio(),
            speech:{
                prepare(payload) {
                    return nativeSpeechFixture(payload.input,controls);
                }
            }
        });
        try {
            await playback.prepare({parts:['One active utterance.'],autoplay:true});
            const active=playback.nativePlayback;
            const failure=new Error('The browser could not cancel the utterance.');
            failure.code='ARCANE_AI_SPEECH_SYNTHESIS_FAILED';
            controls[0].stopFailure=failure;
            playback.stop();
            assert.equal(await active.completion,false);
            assert.equal(playback.nativePlayback,active);
            assert.equal(active.failed,true);
            assert.equal(active.cancelled,true);
            assert.equal(playback.state,'error');
            assert.equal(playback.hasAudio(),false);
            assert.equal(controls.length,1);

            controls[0].finish();
            await active.releaseCompletion;
            assert.equal(playback.nativePlayback,null);
            assert.equal(playback.state,'error');
            assert.equal(controls.length,1);
        } finally {
            playback.destroy();
        }
    }
);

test(
    'SpeechPlayback waits for retained native release before loading or playing a Blob replacement',
    async function testNativeStopFailureBeforeBlobReplacement() {
        const controls=[];
        const audio=new ContractAudio();
        let source='';
        let sourceAutoplayAttempts=0;
        let playCalls=0;
        audio.autoplay=true;
        Object.defineProperty(audio,'src',{
            configurable:true,
            get() {
                return source;
            },
            set(value) {
                source=value;
                if(value&&audio.autoplay)sourceAutoplayAttempts+=1;
            }
        });
        audio.play=function recordAudioPlay() {
            playCalls+=1;
            return ContractAudio.prototype.play.call(audio);
        };
        const playback=new SpeechPlayback({
            audio,
            speech:{
                prepareTTSPlayback(payload) {
                    return payload.input==='Recorded replacement.'
                        ?minimalWavBlob()
                        :nativeSpeechFixture(payload.input,controls);
                }
            },
            createObjectURL() {
                return 'blob:recorded-replacement';
            },
            revokeObjectURL() {}
        });
        try {
            await playback.prepare({parts:['Native utterance.'],autoplay:true});
            const active=playback.nativePlayback;
            const failure=new Error('The browser could not stop the previous utterance.');
            failure.code='ARCANE_AI_SPEECH_SYNTHESIS_FAILED';
            controls[0].stopFailure=failure;

            assert.deepEqual(await playback.prepare({
                parts:['Recorded replacement.'],
                autoplay:true
            }),{ready:true,played:false});
            assert.equal(await active.completion,false);
            assert.equal(playback.nativePlayback,active);
            assert.equal(playback.state,'error');
            assert.equal(playback.urls[0],'blob:recorded-replacement');
            assert.equal(audio.src,'');
            assert.equal(audio.hidden,true);
            assert.equal(sourceAutoplayAttempts,0);
            assert.equal(playCalls,0);
            assert.equal(await playback.play(),false);
            assert.equal(sourceAutoplayAttempts,0);
            assert.equal(playCalls,0);

            controls[0].finish();
            await active.releaseCompletion;
            assert.equal(playback.nativePlayback,null);
            assert.equal(audio.src,'');
            assert.equal(playCalls,0);
            assert.equal(await playback.play(),true);
            assert.equal(audio.src,'blob:recorded-replacement');
            assert.equal(sourceAutoplayAttempts,1);
            assert.equal(playCalls,1);
            assert.equal(playback.state,'playing');
        } finally {
            playback.destroy();
        }
    }
);

test(
    'SpeechPlayback keeps Blob URLs distinct across native and recorded parts',
    async function testMixedNativeAndBlobPlayback() {
        const controls=[];
        const blobs=[];
        const revoked=[];
        const audio=new ContractAudio();
        const playback=new SpeechPlayback({
            audio,
            speech:{
                prepareTTSPlayback(payload) {
                    return payload.input==='Recorded.'
                        ?minimalWavBlob()
                        :nativeSpeechFixture(payload.input,controls);
                }
            },
            createObjectURL(blob) {
                assert.ok(blob instanceof Blob);
                blobs.push(blob);
                return 'blob:recorded-part';
            },
            revokeObjectURL(url) {
                revoked.push(url);
            }
        });
        try {
            await playback.prepare({parts:['Native first.','Recorded.','Native last.']});
            await waitForContract(
                () => playback.urls[1],
                'The recorded lookahead should retain its Blob URL.'
            );
            controls[0].finish();
            await waitForContract(
                () => playback.index===1&&audio.paused===false,
                'The recorded part should play after native completion.'
            );
            assert.equal(audio.src,'blob:recorded-part');
            assert.equal(audio.hidden,false);
            assert.equal(blobs.length,1);
            audio.dispatchEvent(new Event('ended'));
            await waitForContract(
                () => controls.length===2,
                'The native final part should follow the recorded audio end.'
            );
            assert.equal(controls[1].input,'Native last.');
            assert.equal(audio.src,'');
            assert.equal(audio.hidden,true);
            assert.equal(playback.urls[0],undefined);
            assert.equal(playback.urls[2],undefined);
        } finally {
            playback.destroy();
        }
        assert.deepEqual(revoked,['blob:recorded-part']);
    }
);

test(
    'SpeechPlayback uses caller policy, owned cancellation, and canonical state',
    async function testProviderNeutralSpeechPlayback() {
        const expectedVoiceOptions=[
            {value:'alloy',label:'Alloy'},
            {value:'ash',label:'Ash'},
            {value:'ballad',label:'Ballad'},
            {value:'coral',label:'Coral'},
            {value:'echo',label:'Echo'},
            {value:'fable',label:'Fable'},
            {value:'nova',label:'Nova'},
            {value:'onyx',label:'Onyx'},
            {value:'sage',label:'Sage'},
            {value:'shimmer',label:'Shimmer'}
        ];
        assert.deepEqual(SPEECH_VOICE_OPTIONS,expectedVoiceOptions);
        assert.deepEqual(
            [...SPEECH_VOICE_ALIASES],
            expectedVoiceOptions.map(function expectedVoiceAlias(option) {
                return option.value;
            })
        );
        assert.equal(Object.isFrozen(SPEECH_VOICE_OPTIONS),false);
        assert.equal(
            SPEECH_VOICE_OPTIONS.every(function voiceOptionIsMutable(option) {
                return !Object.isFrozen(option);
            }),
            true
        );
        const completeNarration='Complete narration. '.repeat(20_000);
        assert.deepEqual(splitSpeechText(completeNarration),[completeNarration]);
        const requests = [];
        const occurrences = [];
        const compatibilityStates = [];
        const compatibilityDeliveryOrder = [];
        const revoked = [];
        let urlSequence = 0;
        const unsubscribe = arcaneEvents.subscribe(
            SPEECH_PLAYBACK_STATE_EVENT,
            function observeSpeechPlaybackState(occurrence) {
                if (occurrence.source === 'speech-playback') {
                    occurrences.push(occurrence);
                }
            }
        );
        const speech = {
            async fetchTTS(payload, signal, preparation) {
                requests.push({payload, signal, preparation});
                return minimalWavBlob();
            }
        };
        const playbackAudio = new ContractAudio();
        const playback = new SpeechPlayback({
            audio: playbackAudio,
            speech,
            model: 'caller-model',
            voice: 'caller-voice',
            responseFormat: 'wav',
            speed: 1.25,
            onState: function observeCompatibilityState(state) {
                compatibilityDeliveryOrder.push(
                    occurrences.some(function matchingCanonicalState(occurrence) {
                        return occurrence.instanceId
                                ===playback.events.descriptor.instanceId
                            &&occurrence.detail.state===state.state
                            &&occurrence.operationId===state.operationId;
                    })
                );
                compatibilityStates.push(state);
            },
            createObjectURL: function createContractAudioURL(blob) {
                assert.equal(blob.type, 'audio/wav');
                urlSequence += 1;
                return `blob:contract-${urlSequence}`;
            },
            revokeObjectURL: function revokeContractAudioURL(url) {
                revoked.push(url);
            }
        });

        const formattedPart={input: '**Caller-selected speech.**'};
        const prepared = await playback.prepare({
            key: 'caller-narration',
            parts: [formattedPart],
            autoplay: false
        });
        assert.deepEqual(prepared, {ready: true, played: false});
        assert.deepEqual(requests[0].payload, {
            input: 'Caller-selected speech.',
            speed: 1.25,
            model: 'caller-model',
            voice: 'caller-voice',
            responseFormat: 'wav'
        });
        assert.deepEqual(requests[0].preparation,{speechInputPrepared:true});
        assert.equal(requests[0].signal instanceof AbortSignal, true);
        assert.equal(formattedPart.input,'**Caller-selected speech.**');
        assert.equal(
            compatibilityStates.some(function compatibilityStateIsReady(state) {
                return state.state==='ready';
            }),
            true
        );
        assert.equal(
            compatibilityDeliveryOrder.every(function canonicalStateWasDelivered(delivered) {
                return delivered;
            }),
            true
        );
        assert.equal(
            compatibilityStates.every(function compatibilityStateIsMutable(state) {
                return !Object.isFrozen(state);
            }),
            true
        );
        const playbackReadyOccurrence=occurrences.find(occurrence => (
            occurrence.detail.state === 'ready'
            && occurrence.instanceId === playback.events.descriptor.instanceId
        ));
        assert.equal(Object.isFrozen(playbackReadyOccurrence?.detail),false);
        assert.equal(
            playbackReadyOccurrence?.operationId,
            `${playback.events.descriptor.instanceId}:playback:1`
        );

        const policyNeutralSpeech = {
            async fetchTTS(payload) {
                assert.deepEqual(payload, {
                    input: 'Catalog-owned defaults.',
                    speed: 1
                });
                return {
                    audio: minimalWavBytes(),
                    contentType: 'audio/wav'
                };
            }
        };
        const policyNeutralPlayback = new SpeechPlayback({
            audio: new ContractAudio(),
            speech: policyNeutralSpeech,
            createObjectURL: function createPolicyNeutralAudioURL(blob) {
                assert.equal(blob.type, 'audio/wav');
                return 'blob:catalog-default';
            },
            revokeObjectURL: function revokePolicyNeutralAudioURL(url) {
                revoked.push(url);
            }
        });
        assert.deepEqual(
            await policyNeutralPlayback.prepare({
                parts: [{input: 'Catalog-owned defaults.'}],
                autoplay: false
            }),
            {ready: true, played: false}
        );
        const policyReadyOccurrence=occurrences.find(occurrence => (
            occurrence.detail.state === 'ready'
            && occurrence.instanceId
                === policyNeutralPlayback.events.descriptor.instanceId
        ));
        assert.equal(
            policyReadyOccurrence?.operationId,
            `${policyNeutralPlayback.events.descriptor.instanceId}:playback:1`
        );
        assert.notEqual(
            policyReadyOccurrence?.operationId,
            playbackReadyOccurrence?.operationId,
            'Two SpeechPlayback instances must never collide at operation 1.'
        );
        assert.equal(policyNeutralPlayback.destroy(), true);

        let nativeSynthesisRequest=null;
        const nativeSynthesisPlayback=new SpeechPlayback({
            audio: new ContractAudio(),
            speech: {
                async synthesize(payload,options) {
                    nativeSynthesisRequest={payload,options};
                    return minimalWavBytes().buffer;
                }
            },
            createObjectURL: function createNativeSynthesisURL(blob) {
                assert.equal(blob.type,'audio/wav');
                return 'blob:native-synthesis';
            },
            revokeObjectURL: function revokeNativeSynthesisURL(url) {
                revoked.push(url);
            }
        });
        assert.deepEqual(
            await nativeSynthesisPlayback.prepare({
                parts:[{input:'Native synthesis route.'}],
                autoplay: false
            }),
            {ready:true,played:false}
        );
        assert.deepEqual(nativeSynthesisRequest?.payload,{
            input:'Native synthesis route.',
            speed:1
        });
        assert.equal(
            nativeSynthesisRequest?.options.signal instanceof AbortSignal,
            true
        );
        assert.equal(nativeSynthesisPlayback.destroy(),true);

        const invalidSynthesizedResults=[
            {
                label:'empty audio',
                response:new Blob([],{type:'audio/wav'})
            },
            {
                label:'non-audio content',
                response:new Blob(['not audio'],{type:'text/plain'})
            },
            {
                label:'malformed WAV blob',
                response:new Blob(
                    [minimalWavBytes().slice(0,20)],
                    {type:'audio/wav'}
                )
            },
            {
                label:'malformed raw WAV',
                response:new Uint8Array([82,73,70,70])
            },
            {
                label:'malformed base64 WAV',
                response:{
                    audioBase64:'%%%not-base64%%%',
                    contentType:'audio/wav'
                }
            },
            {
                label:'non-audio byte declaration',
                response:{
                    audio:minimalWavBytes(),
                    contentType:'application/octet-stream'
                }
            }
        ];
        for(const invalidResult of invalidSynthesizedResults) {
            const invalidAudioPlayback = new SpeechPlayback({
                audio:new ContractAudio(),
                speech:{
                    async fetchTTS() {
                        return invalidResult.response;
                    }
                }
            });
            await assert.rejects(
                invalidAudioPlayback.prepare({
                    parts:[{input:`Reject ${invalidResult.label}.`}],
                    autoplay:false
                }),
                error => (
                    error?.code
                        === 'ARCANE_SPEECH_PLAYBACK_SYNTHESIZED_AUDIO_CONTRACT_MISMATCH'
                ),
                invalidResult.label
            );
            const invalidAudioOccurrence = occurrences.find(occurrence => (
                occurrence.instanceId
                    === invalidAudioPlayback.events.descriptor.instanceId
                && occurrence.detail.state === 'error'
            ));
            assert.equal(
                invalidAudioOccurrence?.detail.reason,
                'synthesized-audio-contract-mismatch',
                invalidResult.label
            );
            assert.equal(invalidAudioPlayback.destroy(),true);
        }

        let pauseSignal = null;
        const pausedPlayback = new SpeechPlayback({
            audio: new ContractAudio(),
            speech: {
                async fetchTTS() {
                    return {
                        audio: minimalWavBytes(),
                        contentType: 'audio/wav'
                    };
                }
            },
            delay: function retainPlaybackPause(duration, signal) {
                assert.equal(duration, 500);
                pauseSignal = signal;
                return new Promise(resolve => {
                    signal.addEventListener('abort', resolve, {once: true});
                });
            },
            createObjectURL: function createPausedAudioURL() {
                urlSequence += 1;
                return `blob:paused-${urlSequence}`;
            },
            revokeObjectURL: function revokePausedAudioURL(url) {
                revoked.push(url);
            }
        });
        await pausedPlayback.prepare({
            parts: [
                {input: 'First segment.', pauseAfterMs: 500},
                {input: 'Second segment.'}
            ],
            autoplay: false
        });
        const pendingAdvance = pausedPlayback.advance();
        while (!pauseSignal) {
            await Promise.resolve();
        }
        assert.equal(pausedPlayback.destroy(), true);
        assert.equal(pauseSignal.aborted, true);
        assert.equal(await pendingAdvance, false);

        let releaseHeldSpeech;
        let heldSignal;
        speech.fetchTTS = function holdSpeechPlaybackRequest(payload, signal) {
            requests.push({payload, signal});
            heldSignal = signal;
            return new Promise(function retainSpeechPlaybackRequest(resolve, reject) {
                releaseHeldSpeech = resolve;
                signal.addEventListener(
                    'abort',
                    function rejectCancelledSpeechPlaybackRequest() {
                        const error = new Error('cancelled');
                        error.name = 'AbortError';
                        reject(error);
                    },
                    {once: true}
                );
            });
        };
        const pending = playback.prepare({
            key: 'replacement',
            parts: [{input: 'This request will be cancelled.'}],
            autoplay: false
        });
        while (!heldSignal) {
            await Promise.resolve();
        }
        playback.stop();
        assert.equal(heldSignal.aborted, true);
        assert.deepEqual(await pending, {ready: false, played: false});
        releaseHeldSpeech?.(new Blob([]));

        const synthesisError = new Error('The selected synthesizer rejected the request.');
        playback.fail(synthesisError);
        const failureOccurrence=occurrences.filter(occurrence => (
            occurrence.instanceId === playback.events.descriptor.instanceId
            && occurrence.detail.state === 'error'
        )).at(-1);
        assert.equal(
            failureOccurrence?.detail.code,
            'ARCANE_SPEECH_PLAYBACK_SYNTHESIS_REQUEST_REJECTED'
        );
        assert.equal(failureOccurrence?.detail.reason,'speech-synthesis-rejected');

        assert.equal(playback.destroy(), true);
        assert.equal(playback.destroy(), false);
        playbackAudio.dispatchEvent(new Event('error'));
        assert.equal(playback.state, 'idle');
        assert.equal(unsubscribe(), true);
        assert.ok(revoked.includes('blob:contract-1'));
    }
);

test(
    'SpeechPlayback eagerly admits capable provider segments and plays exact order',
    async function testProviderParallelAdmissionAndReplay() {
        const requests=[];
        const statusCalls=[];
        const blobInputs=new Map();
        const createdURLs=[];
        const audio=new ContractAudio();
        const speech={
            providerRuntime:{
                status(role,options) {
                    statusCalls.push({role,options});
                    return {execution:{maxConcurrentRequests:4}};
                }
            },
            fetchTTS(payload,signal,preparation) {
                const deferred=deferredRequest();
                const request={...deferred,payload,signal,preparation};
                requests.push(request);
                return deferred.promise;
            }
        };
        const playback=new SpeechPlayback({
            audio,
            speech,
            createObjectURL(blob) {
                const input=blobInputs.get(blob);
                const url=`blob:${input}:${createdURLs.length+1}`;
                createdURLs.push({input,url});
                return url;
            },
            revokeObjectURL() {}
        });
        function resolveRequest(request) {
            const blob=minimalWavBlob();
            blobInputs.set(blob,request.payload.input);
            request.resolve(blob);
        }

        const preparation=playback.prepare({
            key:'provider-order',
            parts:['First.','Second.','Third.'],
            autoplay:false
        });
        await waitForContract(
            () => requests.length===3,
            'Every complete provider segment should be submitted before the first settles.'
        );
        assert.deepEqual(statusCalls,[
            {role:'tts',options:{execution:true}}
        ]);
        assert.equal(requests.every(request => request.signal instanceof AbortSignal),true);
        assert.equal(
            requests.every(request => (
                request.preparation?.speechInputPrepared===true
            )),
            true
        );

        resolveRequest(requests[2]);
        requests[1].reject(false);
        await waitForContract(
            () => playback.urls[2]&&playback.segmentErrors.has(1),
            'Out-of-order provider settlement should remain indexed.'
        );
        assert.equal(playback.hasAudio(),false);
        assert.equal(audio.src,'');

        resolveRequest(requests[0]);
        assert.deepEqual(await preparation,{ready:true,played:false});
        const firstURL=playback.urls[0];
        const thirdURL=playback.urls[2];
        assert.equal(audio.src,firstURL);
        assert.equal(await playback.advance(),false);
        assert.equal(playback.index,0);
        assert.equal(playback.state,'error');

        const sameAudio=playback.audio;
        assert.equal(await playback.replay(),true);
        assert.equal(playback.audio,sameAudio);
        await waitForContract(
            () => requests.length===4,
            'Replay should re-admit the failed missing segment.'
        );
        assert.equal(requests[3].payload.input,'Second.');
        assert.equal(playback.urls[0],firstURL);
        assert.equal(playback.urls[2],thirdURL);
        assert.equal(
            createdURLs.filter(record => record.input==='Third.').length,
            1
        );

        resolveRequest(requests[3]);
        await waitForContract(
            () => Boolean(playback.urls[1]),
            'The replayed segment should become available.'
        );
        assert.equal(await playback.togglePause(),true);
        assert.equal(audio.paused,true);
        assert.equal(playback.audio,sameAudio);
        assert.equal(await playback.togglePause(),true);
        assert.equal(audio.paused,false);
        assert.equal(playback.audio,sameAudio);

        assert.equal(await playback.advance(),true);
        assert.equal(audio.src,playback.urls[1]);
        assert.equal(await playback.advance(),true);
        assert.equal(audio.src,thirdURL);
        assert.equal(await playback.advance(),true);
        assert.equal(playback.destroy(),true);
    }
);

test(
    'SpeechPlayback preserves every falsy provider rejection',
    async function testFalsyProviderRejections() {
        for(const rejection of [undefined,null,false,0,'']) {
            const playback=new SpeechPlayback({
                audio:new ContractAudio(),
                speech:{
                    providerRuntime:{
                        status() {
                            return {execution:{maxConcurrentRequests:4}};
                        }
                    },
                    fetchTTS() {
                        return Promise.reject(rejection);
                    }
                }
            });
            let rejected=false;
            try {
                await playback.prepare({
                    parts:['Reject this segment.'],
                    autoplay:false
                });
            } catch(error) {
                rejected=true;
                assert.equal(error,rejection);
            }
            assert.equal(rejected,true);
            assert.equal(playback.state,'error');
            assert.equal(playback.hasAudio(),false);
            assert.equal(playback.destroy(),true);
        }
    }
);

test(
    'SpeechPlayback keeps native synthesis serialized with one lookahead',
    async function testSerializedNativeSynthesis() {
        const requests=[];
        const blobInputs=new Map();
        const audio=new ContractAudio();
        const playback=new SpeechPlayback({
            audio,
            speech:{
                synthesize(payload,options,preparation) {
                    const deferred=deferredRequest();
                    const request={...deferred,payload,options,preparation};
                    requests.push(request);
                    return deferred.promise;
                }
            },
            createObjectURL(blob) {
                return `blob:${blobInputs.get(blob)}`;
            },
            revokeObjectURL() {}
        });
        function resolveRequest(request) {
            const blob=minimalWavBlob();
            blobInputs.set(blob,request.payload.input);
            request.resolve(blob);
        }

        const nativeParts=['**Native first.**','Native second.','Native third.'];
        const preparation=playback.prepare({
            parts:nativeParts,
            autoplay:false
        });
        await waitForContract(
            () => requests.length===1,
            'Native synthesis should admit only the first segment initially.'
        );
        assert.equal(requests[0].options.signal instanceof AbortSignal,true);
        assert.equal(requests[0].payload.input,'Native first.');
        assert.deepEqual(requests[0].preparation,{speechInputPrepared:true});
        assert.equal(nativeParts[0],'**Native first.**');
        resolveRequest(requests[0]);
        assert.deepEqual(await preparation,{ready:true,played:false});
        await waitForContract(
            () => requests.length===2,
            'Native synthesis should prepare one lookahead segment.'
        );
        assert.equal(requests.length,2);

        resolveRequest(requests[1]);
        await waitForContract(
            () => Boolean(playback.urls[1]),
            'The native lookahead should settle before advancing.'
        );
        assert.equal(await playback.advance(),true);
        assert.equal(audio.src,'blob:Native second.');
        await waitForContract(
            () => requests.length===3,
            'The next native request should begin only after ordered playback advances.'
        );
        resolveRequest(requests[2]);
        await waitForContract(
            () => Boolean(playback.urls[2]),
            'The final native lookahead should settle.'
        );
        assert.equal(playback.destroy(),true);
    }
);

test(
    'SpeechPlayback stop aborts every pending capable provider segment',
    async function testProviderParallelCancellation() {
        const requests=[];
        const blobInputs=new Map();
        const createdURLs=[];
        const revokedURLs=[];
        const playback=new SpeechPlayback({
            audio:new ContractAudio(),
            speech:{
                providerRuntime:{
                    status() {
                        return {execution:{maxConcurrentRequests:4}};
                    }
                },
                fetchTTS(payload,signal) {
                    const deferred=deferredRequest();
                    const request={...deferred,payload,signal};
                    requests.push(request);
                    return deferred.promise;
                }
            },
            createObjectURL(blob) {
                const url=`blob:${blobInputs.get(blob)}`;
                createdURLs.push(url);
                return url;
            },
            revokeObjectURL(url) {
                revokedURLs.push(url);
            }
        });
        function resolveRequest(request) {
            const blob=minimalWavBlob();
            blobInputs.set(blob,request.payload.input);
            request.resolve(blob);
        }

        const preparation=playback.prepare({
            parts:['One.','Two.','Three.','Four.'],
            autoplay:false
        });
        await waitForContract(
            () => requests.length===4,
            'The capable provider should receive every complete segment immediately.'
        );
        resolveRequest(requests[0]);
        assert.deepEqual(await preparation,{ready:true,played:false});
        playback.stop();
        assert.equal(requests.slice(1).every(request => request.signal.aborted),true);
        assert.equal(playback.hasAudio(),false);

        for(const request of requests.slice(1))resolveRequest(request);
        await waitForContract(
            () => playback.pendingGenerations.size===0,
            'Late provider settlement should be observed and suppressed after stop.'
        );
        assert.deepEqual(createdURLs,['blob:One.']);
        assert.deepEqual(revokedURLs,['blob:One.']);
        assert.equal(playback.destroy(),true);
    }
);

test(
    'speech components keep activation explicit and project one canonical lifecycle',
    async function testSpeechComponentAuthorityContract() {
        const [speechSource, voiceSource] = await Promise.all([
            readFile(
                new URL(
                    '../runtime/arcane/components/speech.html',
                    import.meta.url
                ),
                'utf8'
            ),
            readFile(
                new URL(
                    '../runtime/arcane/components/voice-transcription.html',
                    import.meta.url
                ),
                'utf8'
            )
        ]);
        for (const source of [speechSource, voiceSource]) {
            assert.match(source, /createArcaneEventSource/u);
            assert.match(source, /projectArcaneDOMEvent/u);
            assert.match(source, /events[.]dispose[(][)]/u);
            assert.doesNotMatch(
                source,
                /new (?:EventManager|EventPubSub|EventTarget)|createBrowserSpeech|new Worker/u
            );
            assert.match(
                source,
                /descriptor[.]instanceId[^\n]*\$\{kind\}[^\n]*\$\{eventOperationSequence\}/u
            );
        }

        const startup = speechSource.slice(
            speechSource.indexOf('subscribeAIRuntimeState('),
            speechSource.indexOf('host.componentReady = true;')
        );
        assert.doesNotMatch(
            startup,
            /requestUserUnmute[(]/u,
            'A component mount must not request a TTS download.'
        );
        const ttsIntent = speechSource.slice(
            speechSource.indexOf('async function requestTTSIntent('),
            speechSource.indexOf('function reportTTSLifecycleError(')
        );
        assert.equal(
            (ttsIntent.match(/[.]setSpeechMuted[(]/gu) || []).length,
            1,
            'A TTS lifecycle intent must reach AI.setSpeechMuted exactly once.'
        );
        assert.match(ttsIntent, /else \{[\s\S]*requestAIRuntimeIntent/u);
        assert.match(ttsIntent, /activeTTSIntent[?][.]action === action/u);
        assert.match(
            speechSource,
            /sttRole[.]state !== 'ready'[\s\S]*sttRole[.]busy[\s\S]*MediaRecorder[\s\S]*getUserMedia/u
        );
        assert.match(
            voiceSource,
            /configuration-replaced[\s\S]*supersedeForConfigurationReplacement/u
        );
        assert.match(
            voiceSource,
            /signal:controller[.]signal[\s\S]*fetchSTT[(]file,signal[)]/u
        );
        assert.match(
            voiceSource,
            /publicDetail:\{reason:canonicalSTTCancellationReason[(]reason[)]\}/u
        );
    }
);

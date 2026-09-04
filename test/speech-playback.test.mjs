import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import test from '../src/testing.mjs';
import {arcaneEvents} from '../src/event-manager.mjs';
import {
    SPEECH_PLAYBACK_STATE_EVENT,
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

test(
    'SpeechPlayback uses caller policy, owned cancellation, and canonical state',
    async function testProviderNeutralSpeechPlayback() {
        const completeNarration='Complete narration. '.repeat(20_000);
        assert.deepEqual(splitSpeechText(completeNarration),[completeNarration]);
        const requests = [];
        const occurrences = [];
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
            async fetchTTS(payload, signal) {
                requests.push({payload, signal});
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
            createObjectURL: function createContractAudioURL(blob) {
                assert.equal(blob.type, 'audio/wav');
                urlSequence += 1;
                return `blob:contract-${urlSequence}`;
            },
            revokeObjectURL: function revokeContractAudioURL(url) {
                revoked.push(url);
            }
        });

        const prepared = await playback.prepare({
            key: 'caller-narration',
            parts: [{input: 'Caller-selected speech.'}],
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
        assert.equal(requests[0].signal instanceof AbortSignal, true);
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
            /signal:controller[.]signal[\s\S]*fetchSTT[(]file,undefined,signal[)]/u
        );
        assert.match(
            voiceSource,
            /publicDetail:\{reason:canonicalSTTCancellationReason[(]reason[)]\}/u
        );
    }
);

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setImmediate} from 'node:timers/promises';
import {Script, createContext} from 'node:vm';

import Is from '../browser-runtime/dependencies/strong-type/index.js';
import {
    appendTranscription,
    normalizeVoiceOptions
} from '../runtime/arcane/modules/ComponentContracts.js';
import test from '../src/testing.mjs';

// These fixtures execute the authored queue and AudioWorklet with synthetic
// audio and explicitly fake platform/provider boundaries. They do not prove
// microphone permission, audible capture, model inference, or app persistence.
const componentSource = await readFile(
    new URL('../runtime/arcane/components/voice-transcription.html', import.meta.url),
    'utf8'
);
const captureModuleUrl = new URL('../runtime/arcane/modules/ContinuousVoiceCapture.js', import.meta.url);
const [captureSource, workletSource] = await Promise.all([
    readFile(captureModuleUrl, 'utf8'),
    readFile(new URL('../runtime/arcane/modules/VoiceCaptureWorklet.js', import.meta.url), 'utf8')
]);

function createWorkletFixture(options = {}, onMessage = function observeMessage() {}) {
    const messages = [];
    let Processor;
    class FakeAudioWorkletProcessor {
        constructor() {
            this.port = {
                onmessage: null,
                postMessage(message) {
                    messages.push(message);
                    onMessage(message);
                }
            };
        }
    }
    const context = createContext({
        AudioWorkletProcessor: FakeAudioWorkletProcessor,
        sampleRate: 1000,
        registerProcessor(name, Constructor) {
            assert.equal(name, 'arcane-continuous-voice-capture');
            Processor = Constructor;
        }
    });
    new Script(workletSource, {filename: 'VoiceCaptureWorklet.js'}).runInContext(context);
    const processor = new Processor({processorOptions: {
        preRollMs: 4,
        quietMs: 3,
        chunkMs: 20,
        activityThreshold: 0.02,
        ...options
    }});
    return {
        processor,
        messages,
        get segments() {
            return messages.filter(function segment(message) { return message.type === 'segment'; });
        },
        feed(samples) {
            const input = Float32Array.from(samples);
            const output = new Float32Array(input.length).fill(0.75);
            const active = processor.process([[input]], [[output]]);
            assert.equal(output.every(function silent(sample) { return sample === 0; }), true);
            return active;
        },
        stop() { processor.port.onmessage({data: {type: 'stop'}}); }
    };
}

function wavSamples(audio) {
    // Read the real IEEE Float WAV transport fields, then compare audio sample
    // values. This does not introduce an application content-identity gate.
    const view = new DataView(audio);
    assert.equal(view.getUint16(20, true), 3);
    assert.equal(view.getUint16(22, true), 1);
    const sampleCount = view.getUint32(44, true);
    const samples = [];
    for (let index = 0; index < sampleCount; index += 1) {
        samples.push(view.getFloat32(56 + index * 4, true));
    }
    return samples;
}

function createCapturePlatformFixture({permission, moduleReady} = {}) {
    const contexts = [];
    const nodes = [];
    const segments = [];
    const states = [];
    const errors = [];
    const requests = [];
    class FakeTrack extends EventTarget {
        readyState = 'live';
        stops = 0;
        stop() { this.stops += 1; this.readyState = 'ended'; }
    }
    const track = new FakeTrack();
    const stream = {
        getTracks() { return [track]; },
        getAudioTracks() { return [track]; }
    };
    class FakeAudioContext extends EventTarget {
        state = 'suspended';
        destination = {};
        closes = 0;
        sources = [];
        constructor() {
            super();
            contexts.push(this);
            this.audioWorklet = {
                async addModule(url) {
                    assert.equal(url.href, new URL('./VoiceCaptureWorklet.js', captureModuleUrl).href);
                    await moduleReady?.promise;
                }
            };
        }
        async resume() { this.state = 'running'; }
        async close() { this.closes += 1; this.state = 'closed'; }
        createMediaStreamSource(selectedStream) {
            assert.equal(selectedStream, stream);
            const source = {
                disconnected: false,
                connect(node) { this.node = node; },
                disconnect() { this.disconnected = true; }
            };
            this.sources.push(source);
            return source;
        }
    }
    class FakeAudioWorkletNode extends EventTarget {
        disconnected = false;
        constructor(context, name, options) {
            super();
            assert.equal(name, 'arcane-continuous-voice-capture');
            nodes.push(this);
            const port = new EventTarget();
            port.controls = [];
            port.closed = false;
            port.start = function startPort() {};
            port.close = function closePort() { this.closed = true; };
            port.postMessage = function sendControl(message) { this.controls.push(message); };
            this.port = port;
            this.worklet = createWorkletFixture(options.processorOptions, function receiveWorkletMessage(message) {
                port.dispatchEvent(new MessageEvent('message', {data: message}));
            });
        }
        connect() {}
        disconnect() { this.disconnected = true; }
        flush() {
            for (const message of this.port.controls.splice(0)) {
                this.worklet.processor.port.onmessage({data: message});
            }
        }
    }
    const context = createContext({
        Is,
        Blob,
        URL,
        fixtureModuleUrl: captureModuleUrl.href,
        AudioContext: FakeAudioContext,
        AudioWorkletNode: FakeAudioWorkletNode,
        navigator: {
            mediaDevices: {
                getUserMedia(constraints) {
                    requests.push(constraints);
                    return permission ? permission.promise : Promise.resolve(stream);
                }
            }
        },
        arcaneLogging: {
            error(...details) { errors.push(details); }
        }
    });
    // Only the module-loading boundary changes in this VM fixture. The entire
    // capture class, including its private lifecycle implementation, executes.
    const executable = captureSource
        .replace(/^import .*;\r?\n/gmu, '')
        .replace('export default class ContinuousVoiceCapture', 'class ContinuousVoiceCapture')
        .replaceAll('import.meta.url', 'fixtureModuleUrl');
    new Script(`${executable}\nglobalThis.Capture=ContinuousVoiceCapture;`, {
        filename: 'ContinuousVoiceCapture.js'
    }).runInContext(context);
    const capture = new context.Capture({
        preRollMs: 4,
        quietMs: 3,
        chunkMs: 20,
        activityThreshold: 0.02,
        onSegment(segment) { segments.push(segment); },
        onState(state) { states.push(state); },
        onError(error) { errors.push(error); }
    });
    return {capture, contexts, nodes, segments, states, errors, requests, stream, track};
}

function sourceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.notEqual(start, -1, `Authored source contains ${startMarker}.`);
    assert.ok(end > start, `Authored source contains ${endMarker} after ${startMarker}.`);
    return source.slice(start, end);
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise(function captureSettlement(accept, decline) {
        resolve = accept;
        reject = decline;
    });
    return {promise, resolve, reject};
}

const createQueueFixture = Function(
    'Is', 'appendTranscription', 'normalizeVoiceOptions',
    `'use strict';
    return function createQueueFixture(settings={}) {
        const is=new Is(false);
        let destroyed=false;
        let sessionGeneration=1;
        let state='recording';
        let transcript=settings.initialValue??'';
        let completionAbortController=null;
        let sttRole={state:'ready',loaded:true,busy:false};
        const events=[];
        const errors=[];
        const transitions=[];
        const host={};
        const options=normalizeVoiceOptions({
            capture:{mode:'continuous'},
            onSave:settings.onSave,
            onComplete:settings.onComplete,
            persist:settings.persist??true
        });
        const arcaneLogging={error(...details){errors.push(details);}};
        let stopped=0;
        let canceled=0;
        const session={
            generation:sessionGeneration,
            controller:new AbortController(),
            requestController:null,
            capture:{
                stop(){stopped+=1;return settings.flush?.promise;},
                cancel(){canceled+=1;}
            },
            captureState:'listening',
            listening:true,
            flushing:false,
            processing:'idle',
            queue:[],failure:null,captureError:null,worker:null,waiters:[]
        };
        let continuousSession=session;
        function setState(next,message) {
            state=next;
            transitions.push({state:next,message});
            settings.onState?.(next,message);
        }
        function renderTranscript() {}
        function transcribeAudio(file,context,signal) {
            return settings.transcribe(file,context,signal);
        }
        function dispatchVoiceEvent(type,detail) {
            events.push({type,detail});
            settings.onEvent?.(type,detail);
        }
        function isCurrentVoiceOperation(generation,expectedState) {
            return !destroyed&&generation===sessionGeneration&&state===expectedState;
        }
        function reportSTTCancellation(reason,message) {
            setState('idle',message);
            dispatchVoiceEvent('speech-transcription-cancelled',{reason});
        }
        function cancelSTTOperation() {return false;}
        ${sourceBetween(
            componentSource,
            'function isCurrentContinuousSession(',
            'async function startRecording()'
        )}
        ${sourceBetween(
            componentSource,
            'async function completeStream()',
            'function supersedeForTranscriptReplacement()'
        )}
        return {
            session,events,errors,transitions,
            get transcript(){return transcript;},
            get state(){return state;},
            get stopped(){return stopped;},
            get canceled(){return canceled;},
            get details(){return continuousDetails(session);},
            enqueue(sequence,audio=new Blob(['synthetic clip'],{type:'audio/wav'})) {
                session.queue.push({audio,sequence,reason:'periodic',durationMs:4,stage:'transcribe',segment:null});
                processContinuousQueue(session);
            },
            setRole(patch) {
                sttRole={...sttRole,...patch};
                processContinuousQueue(session);
            },
            async settled(){await session.worker;},
            stop(){return stopContinuousRecording(session);},
            retry:retryTranscription,
            cancel:cancelRecording,
            complete:completeStream
        };
    };`
)(Is, appendTranscription, normalizeVoiceOptions);

test(
    'continuous voice queues complete clips and saves in order while capture continues',
    async function testOrderedCaptureQueue(t) {
        const firstText = deferred();
        const firstSave = deferred();
        const firstRequested = deferred();
        const firstSaving = deferred();
        const secondRequested = deferred();
        const requests = [];
        const saves = [];
        const fixture = createQueueFixture({
            transcribe(file, context, signal) {
                requests.push({file, context, signal});
                if (context.sequence === 1) {
                    firstRequested.resolve();
                    return firstText.promise;
                }
                secondRequested.resolve();
                return 'Second dragon report.\n';
            },
            onSave(payload) {
                saves.push(payload);
                if (payload.sequence === 1) {
                    firstSaving.resolve();
                    return firstSave.promise;
                }
            }
        });
        t.after(function cleanupQueue() {
            fixture.cancel();
            firstText.resolve('  First dragon report.  ');
            firstSave.resolve();
        });
        fixture.enqueue(1);
        await firstRequested.promise;
        fixture.enqueue(2);
        assert.equal(fixture.details.capture, 'listening');
        assert.equal(fixture.details.queued, 2);
        assert.deepEqual(requests.map(function sequence(request) {
            return request.context.sequence;
        }), [1]);

        firstText.resolve('  First dragon report.  ');
        await firstSaving.promise;
        assert.equal(requests.length, 1);
        assert.equal(saves[0].segment, '  First dragon report.  ');
        assert.equal(saves[0].transcript, '  First dragon report.  ');
        assert.equal(saves[0].signal.aborted, false);
        firstSave.resolve();
        await secondRequested.promise;
        await fixture.settled();
        assert.deepEqual(saves.map(function sequence(payload) {
            return payload.sequence;
        }), [1, 2]);
        assert.equal(fixture.transcript, '  First dragon report.  \n\nSecond dragon report.\n');
        assert.deepEqual(fixture.events.filter(function segment(event) {
            return event.type === 'voice-transcription-segment';
        }).map(function sequence(event) {
            return event.detail.sequence;
        }), [1, 2]);
        assert.equal(await fixture.stop(), true);
        assert.equal(fixture.stopped, 1);
    }
);

test(
    'continuous voice retains failed saves and retries only their successful text',
    async function testSaveRetry(t) {
        const requests = [];
        const saves = [];
        const saveFailure = new Error('Synthetic persistence is unavailable.');
        const fixture = createQueueFixture({
            transcribe(file, context) {
                requests.push(context.sequence);
                return context.sequence === 1 ? '  Exact first text.\n' : 'Second text.';
            },
            onSave(payload) {
                saves.push(payload);
                if (saves.length === 1) throw saveFailure;
            }
        });
        t.after(function cleanupQueue() { fixture.cancel(); });
        fixture.enqueue(1);
        fixture.enqueue(2);
        await fixture.settled();
        assert.equal(fixture.details.errorPhase, 'save');
        assert.equal(fixture.details.error, saveFailure);
        assert.equal(fixture.details.queued, 2);
        assert.deepEqual(requests, [1]);
        assert.equal(fixture.transcript, '  Exact first text.\n');
        assert.equal(await fixture.stop(), false);
        assert.equal(fixture.retry(), true);
        await fixture.settled();
        assert.deepEqual(requests, [1, 2]);
        assert.deepEqual(saves.map(function originalPayload(payload) {
            return [payload.sequence, payload.segment, payload.transcript];
        }), [
            [1, '  Exact first text.\n', '  Exact first text.\n'],
            [1, '  Exact first text.\n', '  Exact first text.\n'],
            [2, 'Second text.', '  Exact first text.\n\n\nSecond text.']
        ]);
        assert.equal(fixture.transcript, '  Exact first text.\n\n\nSecond text.');
        assert.equal(await fixture.stop(), true);
        assert.equal(fixture.retry(), false);
    }
);

test(
    'continuous voice waits for STT and retries failed audio without dropping later clips',
    async function testTranscriptionRetry(t) {
        const requests = [];
        const failure = new Error('Synthetic STT failure.');
        const fixture = createQueueFixture({
            persist: false,
            transcribe(file, context) {
                requests.push({file, context});
                if (requests.length === 1) throw failure;
                return `Segment ${context.sequence}.`;
            }
        });
        t.after(function cleanupQueue() { fixture.cancel(); });
        fixture.setRole({busy: true});
        const firstAudio = new Blob(['first'], {type: 'audio/wav'});
        fixture.enqueue(1, firstAudio);
        fixture.enqueue(2);
        await fixture.settled();
        assert.equal(requests.length, 0);
        assert.equal(fixture.details.processing, 'waiting');
        assert.equal(fixture.details.capture, 'listening');
        fixture.setRole({busy: false});
        await fixture.settled();
        assert.equal(fixture.details.errorPhase, 'transcribe');
        assert.equal(fixture.details.error, failure);
        assert.equal(fixture.session.queue[0].audio, firstAudio);
        assert.equal(fixture.retry(), true);
        await fixture.settled();
        assert.deepEqual(requests.map(function sequence(request) {
            return request.context.sequence;
        }), [1, 1, 2]);
        assert.equal(requests[1].context.audio, firstAudio);
        assert.equal(fixture.transcript, 'Segment 1.\n\nSegment 2.');
    }
);

test(
    'continuous voice distinguishes empty results from provider failure',
    async function testEmptyAndMalformedResult(t) {
        const saves = [];
        const fixture = createQueueFixture({
            transcribe(file, context) { return context.sequence === 1 ? '' : {text: 'unexpected shape'}; },
            onSave(payload) { saves.push(payload); }
        });
        t.after(function cleanupQueue() { fixture.cancel(); });
        fixture.enqueue(1);
        fixture.enqueue(2);
        await fixture.settled();
        assert.equal(saves.length, 0);
        assert.equal(fixture.transcript, '');
        assert.deepEqual(fixture.events.filter(function empty(event) {
            return event.type === 'voice-transcription-empty';
        }), [{type: 'voice-transcription-empty', detail: {sequence: 1, transcript: ''}}]);
        assert.equal(fixture.details.errorPhase, 'transcribe');
        assert.equal(fixture.session.queue[0].sequence, 2);
    }
);

test(
    'continuous voice completion waits for final flush and ordered save',
    async function testCompletionDrain(t) {
        const flush = deferred();
        const saving = deferred();
        const saved = deferred();
        const completed = [];
        const fixture = createQueueFixture({
            flush,
            transcribe() { return 'Final dragon report.'; },
            onSave() { saving.resolve(); return saved.promise; },
            onComplete(payload) { completed.push(payload); }
        });
        t.after(function cleanupQueue() {
            fixture.cancel();
            flush.resolve();
            saved.resolve();
        });
        const completion = fixture.complete();
        assert.equal(fixture.stopped, 1, 'Stop releases capture before waiting for the final clip.');
        fixture.enqueue(1);
        await saving.promise;
        flush.resolve();
        await setImmediate();
        assert.equal(completed.length, 0);
        saved.resolve();
        assert.equal(await completion, true);
        assert.equal(completed.length, 1);
        assert.equal(completed[0].transcript, 'Final dragon report.');
        assert.equal(completed[0].signal.aborted, false);
        assert.equal(fixture.state, 'complete');
    }
);

test(
    'continuous voice cancellation settles drain and suppresses late provider and save callbacks',
    async function testLateSettlement(t) {
        for (const phase of ['transcribe', 'save', 'complete']) {
            await t.test(phase, async function cancelPendingStage() {
                const entered = deferred();
                const pending = deferred();
                let activeSignal;
                const fixture = createQueueFixture({
                    initialValue: phase === 'complete' ? 'Existing transcript.' : '',
                    transcribe(file, context) {
                        if (phase === 'transcribe') {
                            activeSignal = context.signal;
                            entered.resolve();
                            return pending.promise;
                        }
                        return 'Captured transcript.';
                    },
                    onSave(payload) {
                        if (phase === 'save') {
                            activeSignal = payload.signal;
                            entered.resolve();
                            return pending.promise;
                        }
                    },
                    onComplete(payload) {
                        activeSignal = payload.signal;
                        entered.resolve();
                        return pending.promise;
                    }
                });
                try {
                    if (phase !== 'complete') fixture.enqueue(1);
                    const draining = phase === 'complete' ? fixture.complete() : fixture.stop();
                    await entered.promise;
                    const beforeCancel = fixture.transcript;
                    assert.equal(fixture.cancel(), true);
                    assert.equal(activeSignal.aborted, true);
                    assert.equal(await draining, false);
                    pending.resolve('Late provider text.');
                    await setImmediate();
                    assert.equal(fixture.transcript, beforeCancel);
                    assert.equal(fixture.events.some(function completed(event) {
                        return ['voice-transcription-segment', 'voice-transcription-complete'].includes(event.type);
                    }), false);
                    assert.equal(fixture.session.queue.length, 0);
                } finally {
                    fixture.cancel();
                    pending.resolve('Late provider text.');
                }
            });
        }
    }
);

test(
    'capture worklet keeps rolling pre-roll, cuts at pauses, and emits no silent clips',
    function testPauseAndPreRoll() {
        const silent = createWorkletFixture();
        silent.feed(new Array(100).fill(0));
        silent.stop();
        assert.equal(silent.segments.length, 0);
        assert.equal(silent.messages.at(-1).type, 'stopped');

        const capture = createWorkletFixture();
        const quiet = [0, 0.001, 0.002, 0.003, 0.004, 0.005];
        capture.feed(quiet);
        capture.feed([0.25, -0.5, 0, 0, 0]);
        assert.equal(capture.segments.length, 1);
        const first = capture.segments[0];
        assert.equal(first.reason, 'pause');
        assert.equal(first.sequence, 1);
        assert.equal(first.durationMs, 9);
        assert.deepEqual(wavSamples(first.audio), Array.from(Float32Array.from([
            0.002, 0.003, 0.004, 0.005, 0.25, -0.5, 0, 0, 0
        ])));
        capture.feed([0.006, 0.007, 0.5]);
        capture.stop();
        assert.equal(capture.segments.length, 2);
        const last = capture.segments[1];
        assert.equal(last.sequence, 2);
        assert.equal(last.reason, 'stop');
        assert.deepEqual(wavSamples(last.audio), Array.from(Float32Array.from([
            0.006, 0.007, 0.5
        ])));
        assert.equal(capture.messages.at(-1).type, 'stopped');

        const longerPreRoll = createWorkletFixture({preRollMs: 6, chunkMs: 3});
        longerPreRoll.feed([0, 0.001, 0.002, 0.003, 0.004, 0.005, 0.5]);
        longerPreRoll.stop();
        assert.equal(longerPreRoll.segments[0].durationMs, 7);
        assert.deepEqual(wavSamples(longerPreRoll.segments[0].audio), Array.from(Float32Array.from([
            0, 0.001, 0.002, 0.003, 0.004, 0.005, 0.5
        ])));
    }
);

test(
    'continuous stop settles when a state observer cancels before drain registration',
    async function testReentrantDrainCancellation(t) {
        let fixture;
        fixture = createQueueFixture({
            persist: false,
            transcribe() { return 'Unused synthetic text.'; },
            onState(state) {
                if (state === 'idle') fixture.cancel();
            }
        });
        t.after(function cleanupQueue() { fixture.cancel(); });
        fixture.session.listening = false;
        fixture.session.captureState = 'stopped';
        assert.equal(await fixture.stop(), false);
        assert.equal(fixture.session.waiters.length, 0);
        assert.equal(fixture.session.controller.signal.aborted, true);
    }
);

test(
    'continuous completion invokes its callback once across overlapping and reentrant requests',
    async function testSingleCompletion(t) {
        const entered = deferred();
        const pending = deferred();
        let fixture;
        let reentrant;
        let calls = 0;
        fixture = createQueueFixture({
            initialValue: 'Completed dragon report.',
            persist: false,
            transcribe() { return 'Unused synthetic text.'; },
            onComplete() {
                calls += 1;
                reentrant = fixture.complete();
                entered.resolve();
                return pending.promise;
            }
        });
        t.after(function cleanupQueue() {
            fixture.cancel();
            pending.resolve();
        });
        const first = fixture.complete();
        const overlapping = fixture.complete();
        await entered.promise;
        assert.equal(await reentrant, false);
        assert.equal(await overlapping, false);
        assert.equal(await fixture.complete(), false);
        assert.equal(calls, 1);
        pending.resolve();
        assert.equal(await first, true);
        assert.equal(await fixture.complete(), false);
        assert.equal(calls, 1);
    }
);

test(
    'capture worklet periodic boundaries preserve adjacent samples and flush once',
    function testPeriodicAdjacency() {
        const capture = createWorkletFixture({preRollMs: 0, chunkMs: 4, quietMs: 8});
        const original = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1, -0.5, -0.25];
        capture.feed(original);
        capture.stop();
        capture.stop();
        assert.deepEqual(capture.segments.map(function boundary(segment) {
            return [segment.sequence, segment.reason, segment.durationMs];
        }), [[1, 'periodic', 4], [2, 'periodic', 4], [3, 'stop', 2]]);
        assert.deepEqual(capture.segments.flatMap(function decode(segment) {
            return wavSamples(segment.audio);
        }), original);
        assert.equal(capture.messages.filter(function stopped(message) {
            return message.type === 'stopped';
        }).length, 1);
        assert.equal(capture.processor.process([[]], [[]]), false);

        const quietContinuation = createWorkletFixture({preRollMs: 0, chunkMs: 4, quietMs: 3});
        quietContinuation.feed([0.125, 0.25, 0.375, 0.5, 0, 0, 0, 0, 0]);
        quietContinuation.stop();
        assert.equal(quietContinuation.segments.length, 1);
    }
);

test(
    'capture stop releases the microphone before final worklet acknowledgement',
    async function testCaptureStopFlush(t) {
        const fixture = createCapturePlatformFixture();
        t.after(function releaseCapture() { fixture.capture.destroy(); });
        assert.equal(await fixture.capture.start(), true);
        assert.deepEqual(fixture.states, ['starting', 'listening']);
        fixture.nodes[0].worklet.feed([0, 0, 0.25, -0.5]);
        let settled = false;
        const stopping = fixture.capture.stop();
        stopping.then(function observeStop() { settled = true; });
        assert.equal(fixture.track.stops, 1);
        assert.equal(fixture.contexts[0].sources[0].disconnected, true);
        await setImmediate();
        assert.equal(settled, false);
        fixture.nodes[0].flush();
        await stopping;
        assert.equal(fixture.segments.length, 1);
        assert.equal(fixture.segments[0].audio.type, 'audio/wav');
        assert.equal(fixture.segments[0].reason, 'stop');
        assert.deepEqual(wavSamples(await fixture.segments[0].audio.arrayBuffer()), [0, 0, 0.25, -0.5]);
        assert.deepEqual(fixture.states, ['starting', 'listening', 'stopped']);
        assert.equal(fixture.contexts[0].state, 'closed');
        assert.equal(fixture.nodes[0].port.closed, true);
        assert.equal(fixture.nodes[0].disconnected, true);
        assert.deepEqual(fixture.errors, []);
    }
);

test(
    'capture stop during permission acquisition settles promptly and releases late tracks',
    async function testStopDuringStartup(t) {
        const permission = deferred();
        const fixture = createCapturePlatformFixture({permission});
        t.after(function releaseCapture() {
            fixture.capture.destroy();
            permission.resolve(fixture.stream);
        });
        const starting = fixture.capture.start();
        assert.equal(fixture.requests.length, 1);
        await fixture.capture.stop();
        assert.equal(await starting, false);
        assert.equal(fixture.contexts[0].state, 'closed');
        permission.resolve(fixture.stream);
        await setImmediate();
        assert.equal(fixture.track.stops, 1);
        assert.equal(fixture.nodes.length, 0);
        assert.equal(fixture.segments.length, 0);
        assert.deepEqual(fixture.errors, []);
    }
);

test(
    'naturally ended microphone flushes captured audio before reporting interruption',
    async function testMicrophoneInterruption(t) {
        const fixture = createCapturePlatformFixture();
        t.after(function releaseCapture() { fixture.capture.destroy(); });
        assert.equal(await fixture.capture.start(), true);
        const node = fixture.nodes[0];
        node.worklet.feed([0.125, 0.25]);
        fixture.track.readyState = 'ended';
        fixture.track.dispatchEvent(new Event('ended'));
        assert.equal(fixture.track.stops, 1);
        assert.equal(fixture.errors.length, 0);
        const stopped = fixture.capture.stop();
        node.flush();
        await stopped;
        assert.equal(fixture.segments.length, 1);
        assert.deepEqual(wavSamples(await fixture.segments[0].audio.arrayBuffer()), [0.125, 0.25]);
        assert.equal(fixture.errors.length, 1);
        assert.equal(fixture.errors[0].message, 'The microphone ended during continuous voice capture.');
        assert.equal(fixture.states.at(-1), 'interrupted');
        assert.equal(fixture.contexts[0].state, 'closed');
    }
);

test(
    'capture abort during worklet loading and cancel after start suppress late clips',
    async function testCaptureCancellation(t) {
        const moduleReady = deferred();
        const preparing = createCapturePlatformFixture({moduleReady});
        const signal = new AbortController();
        t.after(function releasePreparingCapture() {
            preparing.capture.destroy();
            moduleReady.resolve();
        });
        const starting = preparing.capture.start({signal: signal.signal});
        await setImmediate();
        signal.abort();
        assert.equal(await starting, false);
        moduleReady.resolve();
        await setImmediate();
        assert.equal(preparing.track.stops, 1);
        assert.equal(preparing.nodes.length, 0);
        assert.equal(preparing.contexts[0].state, 'closed');

        const listening = createCapturePlatformFixture();
        t.after(function releaseListeningCapture() { listening.capture.destroy(); });
        assert.equal(await listening.capture.start(), true);
        const node = listening.nodes[0];
        node.worklet.feed([0.25, -0.5]);
        listening.capture.cancel();
        node.worklet.stop();
        await setImmediate();
        assert.equal(listening.segments.length, 0);
        assert.equal(listening.track.stops, 1);
        assert.equal(listening.contexts[0].state, 'closed');
        assert.equal(node.port.closed, true);
        assert.equal(node.disconnected, true);
    }
);

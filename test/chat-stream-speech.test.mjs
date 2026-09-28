import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import test from '../src/testing.mjs';

test(
    'initial speech unmute waits for the canonical AI owner before provider registration',
    async function preservePreHydrationSpeechIntent() {
        const source = await readFile(
            new URL('../runtime/arcane/components/speech.html', import.meta.url),
            'utf8'
        );
        function section(startMarker, endMarker) {
            const start = source.indexOf(startMarker);
            const end = source.indexOf(endMarker, start);
            assert.notEqual(start, -1);
            assert.notEqual(end, -1);
            return source.slice(start, end);
        }
        const readyListener = source.split('\n').find(
            function findAIReadyListener(line) {
                return line.includes("window.addEventListener('ai-ready',");
            }
        );
        assert.ok(readyListener);
        const createSpeechHarness = Function(
            `'use strict';
            return function createSpeechHarness() {
                const globalThis = {};
                const window = new EventTarget();
                const runtimeStateAbortController = new AbortController();
                const lifecycleListenerOptions = {signal: runtimeStateAbortController.signal};
                const host = {muted: true, availability: {}, componentReady: true};
                const errors = [];
                const fallbackIntents = [];
                const is = {
                    function: function isFunction(value) {return typeof value === 'function';},
                    string: function isString(value) {return typeof value === 'string';}
                };
                const arcaneLogging = {error: function reportError(message, error) {errors.push(error);}};
                const events = {dispose: function disposeEvents() {}};
                const sttActivationController = null;
                const transcriptionEnabled = true;
                const microphonePermissionStatus = null;
                const microphonePermissionListener = null;
                let sttRole = {state: 'unavailable'};
                let ttsRole = {state: 'unavailable', providerId: null, modelId: null};
                let pendingUnmute = false;
                let pendingTTSIntent = null;
                let activeTTSIntent = null;
                let ttsIntentGeneration = 0;
                let ttsOperationId = null;
                let destroyed = false;
                function completeValue(value) {return value;}
                function nextSpeechOperationId() {return 'fixture-operation';}
                function renderControls() {}
                function renderStatus() {}
                function cancelSTTOperation() {}
                function reportTTSLifecycleError(error) {errors.push(error);}
                function reportTTSError(error) {errors.push(error);}
                function requestAIRuntimeIntent(intent) {
                    fallbackIntents.push(intent);
                    return intent;
                }
                ${section('    function selectedRole(', '    function configure(')}
                ${section('    function applyConfiguredMutedState(', '    function renderSTTActivationState(')}
                ${section('    function clearSettledTTSIntent(', '    function renderControls(')}
                ${section('    function requestUserMute(', '    function reportTTSLifecycleError(')}
                ${section('    function stopTTSPlayback(', '    async function transcribe(')}
                ${section('    function handlePageHide(', '</script>')}
                ${readyListener}
                return {
                    host,
                    errors,
                    fallbackIntents,
                    start: function start() {applyConfiguredMutedState(false);},
                    mute: requestUserMute,
                    destroy,
                    publish: function publish(state) {
                        synchronizeAIRuntimeState({
                            roles: {
                                stt: {state: 'unavailable'},
                                tts: {
                                    state,
                                    providerId: 'digitalocean-fal',
                                    modelId: 'fal-ai/elevenlabs/tts/multilingual-v2',
                                    loaded: state === 'ready'
                                }
                            }
                        });
                    },
                    installAI: function installAI(ai) {globalThis.ai = ai;},
                    ready: function ready() {window.dispatchEvent(new Event('ai-ready'));},
                    state: function state() {return {pendingUnmute, pendingTTSIntent, destroyed};}
                };
            };`
        )();
        function createAI() {
            const calls = [];
            let completeActivation;
            const ai = {
                muted: true,
                speechActivationPending: false,
                stopAudio: function stopAudio() {},
                resumeAudio: function resumeAudio() {return Promise.resolve(true);},
                setSpeechMuted: function setSpeechMuted(muted) {
                    calls.push(muted);
                    ai.muted = true;
                    if(muted) {
                        ai.speechActivationPending = false;
                        return Promise.resolve(true);
                    }
                    ai.speechActivationPending = true;
                    return new Promise(
                        function captureActivation(resolve) {
                            completeActivation = function complete() {
                                ai.speechActivationPending = false;
                                ai.muted = false;
                                resolve(true);
                            };
                        }
                    );
                }
            };
            return {ai, calls, complete: function complete() {completeActivation();}};
        }

        const fixture = createSpeechHarness();
        fixture.start();
        fixture.publish('unloaded');
        assert.deepEqual(fixture.fallbackIntents, []);
        assert.deepEqual(fixture.state(), {
            pendingUnmute: true, pendingTTSIntent: null, destroyed: false
        });
        const runtime = createAI();
        fixture.installAI(runtime.ai);
        fixture.ready();
        assert.deepEqual(runtime.calls, [false]);
        assert.equal(fixture.host.muted, true);
        fixture.publish('unloaded');
        assert.deepEqual(runtime.calls, [false]);
        fixture.publish('ready');
        runtime.complete();
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(fixture.host.muted, false);
        assert.deepEqual(fixture.fallbackIntents, []);
        assert.deepEqual(fixture.errors, []);
        fixture.destroy();

        for(const cancellation of ['mute', 'destroy']) {
            const cancelled = createSpeechHarness();
            cancelled.start();
            cancelled.publish('unloaded');
            cancelled[cancellation]();
            const laterRuntime = createAI();
            cancelled.installAI(laterRuntime.ai);
            cancelled.ready();
            assert.deepEqual(laterRuntime.calls, []);
            assert.deepEqual(cancelled.fallbackIntents, []);
            assert.equal(cancelled.host.muted, true);
            cancelled.destroy();
        }
    }
);

test(
    'shared chat forwards its first visible chunk once without waiting for speech',
    async function preserveFirstChatSpeechChunk() {
        const source = await readFile(
            new URL('../runtime/arcane/components/chat.html', import.meta.url),
            'utf8'
        );
        const streamStart = source.indexOf('    async function streamMessage(');
        const streamEnd = source.indexOf('\n\n    textArea.addEventListener', streamStart);
        const receivedStart = source.indexOf('    function receivedMessage(');
        const receivedEnd = source.indexOf('\n\n    function reportTTSError', receivedStart);
        for(const boundary of [streamStart, streamEnd, receivedStart, receivedEnd]) {
            assert.notEqual(boundary, -1);
        }
        const createStreamHarness = Function(
            `'use strict';
            return function createStreamHarness(useBoundRuntime = false) {
                const spoken = [];
                const globalSpoken = [];
                const errors = [];
                let releaseSpeech;
                const speechPreparation = new Promise(
                    function prepareSpeech(resolve) {
                        releaseSpeech = resolve;
                    }
                );
                const runtime = {
                    streamTTS(text) {
                        spoken.push(text);
                        return speechPreparation;
                    }
                };
                const boundChatAI = useBoundRuntime ? runtime : null;
                const globalThis = {
                    ai: useBoundRuntime
                        ? {
                            streamTTS(text) {
                                globalSpoken.push(text);
                                return speechPreparation;
                            }
                        }
                        : runtime
                };
                const host = {aiName: 'Assistant', aiAvailability: {tts: true}};
                const speech = {muted: false};
                const chatOutput = {children: []};
                const is = {
                    string: function isString(value) {
                        return typeof value === 'string';
                    },
                    function: function isFunction(value) {
                        return typeof value === 'function';
                    }
                };
                const arcaneLogging = {
                    error(message, error) {
                        errors.push(error);
                    },
                    warn(message) {
                        errors.push(message);
                    }
                };
                class MD {
                    constructor(text) {
                        this.rendered = 'rendered:' + text;
                    }
                }
                function scrollTranscriptToBottom() {}
                function reportTTSError(error) {
                    errors.push(error);
                }
                function appendTranscriptMessage(role, text, name) {
                    const markdown = {raw: text, innerHTML: new MD(text).rendered};
                    let thinking = null;
                    const message = {
                        role,
                        name,
                        id: '',
                        ownerDocument: {
                            createElement() {
                                return {
                                    className: '',
                                    textContent: '',
                                    classList: {
                                        contains() {return false;},
                                        remove() {}
                                    },
                                    append(node) {
                                        this.textContent += node.textContent;
                                    },
                                    remove() {
                                        thinking = null;
                                    }
                                };
                            },
                            createTextNode(text) {
                                return {textContent: text};
                            }
                        },
                        querySelector(selector) {
                            if(selector === '.markdown') return markdown;
                            if(selector === '.thinking') return thinking;
                            return null;
                        },
                        insertBefore(node) {
                            thinking = node;
                        }
                    };
                    chatOutput.children.push(message);
                    return message;
                }
                ${source.slice(streamStart, streamEnd)}
                ${source.slice(receivedStart, receivedEnd)}
                return {
                    stream: streamMessage,
                    chatOutput,
                    host,
                    speech,
                    spoken,
                    globalSpoken,
                    errors,
                    runtime,
                    releaseSpeech
                };
            };`
        )();

        for(const useBoundRuntime of [false, true]) {
            const fixture = createStreamHarness(useBoundRuntime);
            const first = fixture.stream('First', 'visible', false);
            const second = fixture.stream(' **word**\n', 'visible', false);
            assert.equal(fixture.chatOutput.children.length, 1);
            const message = fixture.chatOutput.children[0];
            assert.equal(message.id, 'message-visible');
            assert.equal(message.querySelector('.markdown').raw, 'First **word**\n');
            assert.equal(message.querySelector('.markdown').innerHTML, 'rendered:First **word**\n');
            assert.deepEqual(
                fixture.spoken,
                ['First', ' **word**\n']
            );
            assert.deepEqual(
                fixture.globalSpoken,
                []
            );
            await Promise.all(
                [first, second]
            );
            fixture.releaseSpeech(true);
            assert.deepEqual(
                fixture.errors,
                []
            );
        }

        const thinking = createStreamHarness();
        const pending = thinking.stream('Preparing the answer', 'thinking', true);
        assert.equal(thinking.chatOutput.children[0].querySelector('.markdown').raw, '');
        assert.deepEqual(
            thinking.spoken,
            []
        );
        const visible = thinking.stream('Hello', 'thinking', false);
        assert.equal(thinking.chatOutput.children[0].querySelector('.markdown').raw, 'Hello');
        assert.equal(thinking.chatOutput.children[0].querySelector('.thinking'), null);
        assert.deepEqual(
            thinking.spoken,
            ['Hello']
        );
        await Promise.all(
            [pending, visible]
        );
        thinking.releaseSpeech(true);

        for(const useBoundRuntime of [false,true]){
            const loading=createStreamHarness(useBoundRuntime);
            loading.runtime.speechActivationPending=true;
            loading.speech.muted=true;
            loading.host.aiAvailability.tts=false;
            await loading.stream('Visible while voice activates.','loading',false);
            assert.deepEqual(loading.spoken,['Visible while voice activates.']);
            assert.equal(loading.chatOutput.children[0].querySelector('.markdown').raw,
                'Visible while voice activates.');
            loading.releaseSpeech(true);
        }

        for(const state of [{muted: true, ready: true}, {muted: false, ready: false}]) {
            const fixture = createStreamHarness();
            fixture.speech.muted = state.muted;
            fixture.host.aiAvailability.tts = state.ready;
            await fixture.stream('Visible without speech', 'quiet', false);
            assert.equal(fixture.chatOutput.children[0].querySelector('.markdown').raw, 'Visible without speech');
            assert.deepEqual(
                fixture.spoken,
                []
            );
            fixture.releaseSpeech(true);
        }
    }
);

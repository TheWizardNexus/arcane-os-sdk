import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import test from '../src/testing.mjs';

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

import assert from 'node:assert/strict';
import test from '../src/testing.mjs';

test('HTTP tool-text cancellation preserves reader cleanup and genuine diagnostics', async function streamCancellationContract() {
    const previousGlobals = new Map(
        ['window', 'document', 'localStorage', 'fetch'].map(function readGlobalDescriptor(key) {
            return [key, Object.getOwnPropertyDescriptor(globalThis, key)];
        })
    );
    const previousConsoleError = console.error;
    const registrationKey = Symbol.for('arcane.ai.user-ready-registration');
    const previousRegistration = globalThis[registrationKey];
    const values = new Map();
    const localStorage = {
        getItem(key) { return values.get(String(key)) ?? null; },
        setItem(key, value) { values.set(String(key), String(value)); },
        removeItem(key) { values.delete(String(key)); }
    };
    const windowTarget = new EventTarget();
    const documentObject = {
        documentElement: {dataset: {arcaneAppId: 'stream-cancellation-contract'}},
        querySelector() { return null; }
    };
    windowTarget.dbopfs = {ready: false, get() {}};
    windowTarget.user = {ready: false};
    windowTarget.document = documentObject;
    windowTarget.localStorage = localStorage;
    globalThis.window = windowTarget;
    globalThis.document = documentObject;
    globalThis.localStorage = localStorage;
    const diagnostics = [];
    console.error = function captureError(...args) { diagnostics.push(args); };
    let ai;

    try {
        const {default: AI} = await import(process.env.ARCANE_SDK_CANCELLATION_AI_URL ?? 'arcane-os/ai');
        ai = new AI('TWIN', 'LOCAL_SPEACH', 'LOCAL_SPEACH', 'TWIN');
        ai.license = 'synthetic-test-credential';
        const tool = {
            type: 'function',
            function: {
                name: 'report_progress',
                description: 'Show the complete progress message.',
                parameters: {
                    type: 'object',
                    properties: {message: {type: 'string', minLength: 1}},
                    required: ['message']
                }
            }
        };
        const cases = [
            {name: 'caller abort repeated by the native stream', abort: true, readAbort: true, cleanup: 'native', logs: false},
            {name: 'transport abort without caller signal', abort: false, readAbort: true, cleanup: 'native', logs: false},
            {name: 'coded cleanup abort', abort: true, readAbort: true, cleanup: 'coded-abort', logs: false},
            {name: 'genuine cleanup failure during caller abort', abort: true, readAbort: true, cleanup: 'failure', logs: true},
            {name: 'cleanup abort after ordinary stream failure', abort: false, readAbort: false, cleanup: 'abort', logs: true},
            {name: 'ordinary stream and cleanup failure', abort: false, readAbort: false, cleanup: 'failure', logs: true}
        ];

        for (const scenario of cases) {
            const controller = new AbortController();
            const readError = scenario.readAbort
                ? new DOMException('BodyStreamBuffer was aborted', 'AbortError')
                : new Error('Synthetic stream read failed.');
            const cleanupError = scenario.cleanup === 'abort'
                ? new DOMException('Synthetic cleanup abort.', 'AbortError')
                : new Error('Synthetic reader cleanup failed.');
            if (scenario.cleanup === 'coded-abort') {
                cleanupError.code = 'ARCANE_AI_REQUEST_ABORTED';
            }
            let reads = 0;
            let cancellations = 0;
            let releases = 0;
            let completeCallbacks = 0;
            let toolTextCallbacks = 0;
            let cancelReason;
            let finishRelease;
            const released = new Promise(function awaitRelease(resolve) { finishRelease = resolve; });
            const stream = new ReadableStream(
                {
                    pull(streamController) {
                        if (scenario.abort) controller.abort('superseded by a newer turn');
                        streamController.error(readError);
                    }
                },
                {highWaterMark: 0}
            );
            globalThis.fetch = async function syntheticStreamingResponse() {
                return {
                    ok: true,
                    body: {
                        getReader() {
                            const reader = stream.getReader();
                            return {
                                read() { reads += 1; return reader.read(); },
                                async cancel(reason) {
                                    cancellations += 1;
                                    cancelReason = reason;
                                    if (scenario.cleanup !== 'native') throw cleanupError;
                                    return reader.cancel(reason);
                                },
                                releaseLock() {
                                    releases += 1;
                                    reader.releaseLock();
                                    finishRelease();
                                }
                            };
                        }
                    }
                };
            };
            diagnostics.length = 0;
            await assert.rejects(
                ai.streamRequest(
                    {
                        messages: [{role: 'user', content: 'Show progress.'}],
                        tools: [tool],
                        toolText: {name: 'report_progress', field: 'message'},
                        signal: controller.signal,
                        onToolText() { toolTextCallbacks += 1; },
                        onComplete() { completeCallbacks += 1; }
                    }
                ),
                function assertOriginalOutcome(error) {
                    if (scenario.abort || scenario.readAbort) {
                        assert.equal(error.name, 'AbortError', `${scenario.name}: ${error.stack}`);
                        assert.equal(error.code, 'ARCANE_AI_REQUEST_ABORTED', scenario.name);
                    } else {
                        assert.equal(error, readError, scenario.name);
                    }
                    return true;
                }
            );
            await released;
            assert.equal(reads, 1, scenario.name);
            assert.equal(cancellations, 1, scenario.name);
            assert.equal(cancelReason, readError, scenario.name);
            assert.equal(releases, 1, scenario.name);
            assert.equal(stream.locked, false, scenario.name);
            assert.equal(completeCallbacks, 0, scenario.name);
            assert.equal(toolTextCallbacks, 0, scenario.name);
            assert.deepEqual(
                diagnostics,
                scenario.logs ? [['Arcane tool text reader cleanup failed.', cleanupError]] : [],
                scenario.name
            );
        }
    } finally {
        try {
            ai?.stopAudio();
            await ai?.providerRuntime.disposeAll();
        } finally {
            const registration = globalThis[registrationKey];
            if (registration !== previousRegistration) registration?.dispose();
            for (const [key, descriptor] of previousGlobals) {
                if (descriptor) {
                    Object.defineProperty(globalThis, key, descriptor);
                } else {
                    delete globalThis[key];
                }
            }
            console.error = previousConsoleError;
        }
    }
});

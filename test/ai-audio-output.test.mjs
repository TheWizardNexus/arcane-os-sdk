import assert from 'node:assert/strict';
import test from '../src/testing.mjs';

function deferred(){
    let resolve;
    let reject;
    const promise = new Promise(function retainCompletion(accept, decline){ resolve = accept; reject = decline; });
    return {promise, resolve, reject};
}

test('AI audio output preparation is silent and owns its actual Web Audio lifecycle', async function testAudioOutput(t){
    // These are synthetic platform controls, not browser autoplay or audible evidence.
    const previousGlobals = new Map(
        ['window', 'document', 'localStorage', 'user', 'AudioContext', 'webkitAudioContext'].map(
            function rememberGlobal(key){ return [key, Object.getOwnPropertyDescriptor(globalThis, key)]; }
        )
    );
    const windowTarget = new EventTarget();
    const documentObject = {
        documentElement: {dataset: {arcaneAppId: 'audio-output-fixture'}},
        querySelector(){ return null; }
    };
    const values = new Map();
    const storage = {
        getItem(key){ return values.get(String(key)) ?? null; },
        setItem(key, value){ values.set(String(key), String(value)); },
        removeItem(key){ values.delete(String(key)); }
    };
    windowTarget.dbopfs = {ready: false, get(){}};
    windowTarget.user = {ready: false, developer: false};
    windowTarget.document = documentObject;
    windowTarget.localStorage = storage;
    globalThis.window = windowTarget;
    globalThis.document = documentObject;
    globalThis.localStorage = storage;
    globalThis.user = windowTarget.user;
    delete globalThis.webkitAudioContext;

    const contexts = [];
    const outputs = [];
    let sourceCalls = 0;
    let modelCalls = 0;
    let gestureListeners = 0;
    const addWindowListener = windowTarget.addEventListener.bind(windowTarget);
    windowTarget.addEventListener = function recordWindowListener(type, ...options){
        if(type === 'pointerdown' || type === 'keydown') gestureListeners += 1;
        return addWindowListener(type, ...options);
    };
    class FakeAudioContext extends EventTarget {
        state = 'suspended';
        currentTime = 0;
        resumeCalls = 0;
        closeCalls = 0;
        resumeError = null;
        closeError = null;
        resumeGate = null;
        closeGate = null;
        constructor(){
            super();
            contexts.push(this);
        }
        setState(state){
            this.state = state;
            this.dispatchEvent(new Event('statechange'));
        }
        async resume(){
            this.resumeCalls += 1;
            if(this.resumeGate) await this.resumeGate.promise;
            if(this.resumeError) throw this.resumeError;
            if(this.state !== 'closed') this.setState('running');
        }
        async close(){
            this.closeCalls += 1;
            if(this.closeGate) await this.closeGate.promise;
            if(this.closeError) throw this.closeError;
            this.setState('closed');
        }
        createBufferSource(){
            sourceCalls += 1;
            throw new Error('Silent output preparation must not create a source.');
        }
    }
    globalThis.AudioContext = FakeAudioContext;
    t.after(async function restoreAudioOutputFixture(){
        try {
            for(const context of contexts) {
                context.resumeGate?.resolve();
                context.closeGate?.resolve();
                context.closeError = null;
            }
            await Promise.allSettled(outputs.map(function disposeOutput(output){ return output.dispose(); }));
        } finally {
            globalThis[Symbol.for('arcane.ai.user-ready-registration')]?.dispose();
            for(const [key, descriptor] of previousGlobals) {
                if(descriptor) Object.defineProperty(globalThis, key, descriptor);
                else delete globalThis[key];
            }
        }
    });
    const {default: AI, AI_AUDIO_OUTPUT_STATE_EVENT} = await import('../runtime/arcane/modules/AI.js');
    const {arcaneEvents} = await import('arcane-os/event-manager');
    class AudioOutputFixtureAI extends AI {
        setAI(){ return true; }
        fetchTTS(){ modelCalls += 1; throw new Error('Output preparation must not synthesize.'); }
        setSpeechMuted(){ modelCalls += 1; throw new Error('Output preparation must not activate a provider.'); }
        startProviders(){ modelCalls += 1; throw new Error('Output preparation must not load providers.'); }
    }
    function prepare(ai){
        const output = ai.prepareAudioOutput();
        outputs.push(output);
        return output;
    }

    await t.test('prepares synchronously while muted and replays actual state through canonical events', async function testSilentPreparation(){
        const ai = new AudioOutputFixtureAI();
        ai.muted = true;
        const events = [];
        const stopEvents = arcaneEvents.subscribe(AI_AUDIO_OUTPUT_STATE_EVENT, function recordEvent(event){ events.push(event); });
        try {
            const output = prepare(ai);
            const context = ai.audioContext;
            assert.equal(output instanceof Promise, false);
            assert.equal(ai.prepareAudioOutput(), output);
            assert.equal(output.kind, 'web-audio');
            assert.equal(output.state, 'suspended');
            assert.equal(output.contextState, 'suspended');
            assert.equal(output.error, null);
            assert.equal(context.resumeCalls, 0);
            assert.equal(ai.muted, true);
            assert.equal(ai.speechJobs.length, 0);
            assert.equal(sourceCalls, 0);
            assert.equal(modelCalls, 0);
            assert.equal(gestureListeners, 0);
            const states = [];
            const unsubscribe = output.subscribe(function observeOutput(state){ states.push(state); });
            assert.equal(states.length, 1);
            assert.equal(states[0].state, 'suspended');
            assert.equal(await output.resume(), true);
            assert.equal(output.state, 'ready');
            assert.equal(ai.muted, true);
            assert.equal(sourceCalls, 0);
            context.setState('interrupted');
            assert.equal(output.state, 'interrupted');
            assert.equal(states.at(-1).contextState, 'interrupted');
            assert.equal(events.at(-1).detail.kind, 'web-audio');
            const observed = states.length;
            unsubscribe();
            unsubscribe();
            context.setState('suspended');
            assert.equal(states.length, observed);
            const disposedStates = [];
            output.subscribe(function observeDisposal(state){ disposedStates.push(state.state); });
            await output.dispose();
            assert.equal(disposedStates.at(-1), 'disposed');
            assert.equal(output.state, 'disposed');
            assert.equal(output.contextState, 'closed');
            assert.equal(context.closeCalls, 1);
            await output.dispose();
            assert.equal(context.closeCalls, 1);
            const replacement = prepare(ai);
            assert.notEqual(replacement, output);
            assert.notEqual(ai.audioContext, context);
            await replacement.dispose();
        } finally { stopEvents(); }
    });

    await t.test('a denied explicit resume exposes the real error and gesture requirement', async function testGestureState(){
        const ai = new AudioOutputFixtureAI();
        const output = prepare(ai);
        const error = new DOMException('Synthetic gesture rejection.', 'NotAllowedError');
        ai.audioContext.resumeError = error;
        await assert.rejects(output.resume(), function sameError(actual){ return actual === error; });
        assert.equal(output.state, 'gesture-required');
        assert.equal(output.error, error);
        assert.equal(output.contextState, 'suspended');
        ai.audioContext.resumeError = null;
        assert.equal(await output.resume(), true);
        assert.equal(output.state, 'ready');
        assert.equal(output.error, null);
        await output.dispose();
    });

    await t.test('disposal does not wait for a pending browser resume and ignores late completion', async function testPendingResume(){
        const ai = new AudioOutputFixtureAI();
        const output = prepare(ai);
        const context = ai.audioContext;
        context.resumeGate = deferred();
        const resumed = output.resume();
        await output.dispose();
        context.resumeGate.resolve();
        assert.equal(await resumed, false);
        assert.equal(output.state, 'disposed');
        assert.equal(ai.audioContext, null);
        assert.equal(sourceCalls, 0);
    });

    await t.test('an earlier resume rejection does not overwrite a newer running state', async function testRetiredResumeError(){
        const ai = new AudioOutputFixtureAI();
        const output = prepare(ai);
        const context = ai.audioContext;
        const first = deferred();
        let calls = 0;
        context.resume = function resumeInTwoAttempts(){
            calls += 1;
            if(calls === 1) return first.promise;
            context.setState('running');
            return Promise.resolve();
        };
        const pending = output.resume();
        assert.equal(await output.resume(), true);
        const error = new DOMException('Retired synthetic rejection.', 'NotAllowedError');
        first.reject(error);
        await assert.rejects(pending, function sameError(actual){ return actual === error; });
        assert.equal(output.state, 'ready');
        assert.equal(output.error, null);
        await output.dispose();
    });

    await t.test('disposal is reentrant and an actual close failure remains observable and retryable', async function testDisposalFailure(){
        const ai = new AudioOutputFixtureAI();
        const output = prepare(ai);
        const context = ai.audioContext;
        const error = new Error('Synthetic close failure.');
        context.closeError = error;
        let reentrant;
        output.subscribe(function retainReentrantDisposal(state){
            if(state.state === 'disposing') reentrant = output.dispose();
        });
        const first = output.dispose();
        assert.equal(first, reentrant);
        await assert.rejects(first, function sameError(actual){ return actual === error; });
        assert.equal(output.error, error);
        assert.equal(output.state, 'error');
        assert.equal(ai.prepareAudioOutput(), output);
        assert.equal(ai.audioContext, context);
        context.closeError = null;
        await output.dispose();
        assert.equal(output.state, 'disposed');
        assert.equal(context.closeCalls, 2);
    });

    await t.test('disposal cancels a native job waiting on this output clock without stopping independent native speech', async function testNativeClockDependency(){
        const ai = new AudioOutputFixtureAI();
        const output = prepare(ai);
        const context = ai.audioContext;
        context.setState('running');
        ai.muted = false;
        ai.speechScheduleGeneration = ai.speechGeneration;
        ai.speechScheduleContext = context;
        ai.speechScheduleTime = 30;
        let nativeStarts = 0;
        let nativeStops = 0;
        let result;
        const waiting = {
            generation: ai.speechGeneration, state: 'ready',
            abortController: new AbortController(),
            nativePlayback: {play(){ nativeStarts += 1; }},
            resolvePlayback(value){ result = value; }
        };
        ai.speechJobs.push(waiting);
        assert.equal(await ai.resumeAudio(context), true);
        assert.equal(waiting.precedingSpeechContext, context);
        await output.dispose();
        assert.equal(result, false);
        assert.equal(nativeStarts, 0);
        assert.equal(waiting.abortController.signal.aborted, true);
        const nextOutput = prepare(ai);
        const independent = {
            generation: ai.speechGeneration, state: 'scheduled',
            abortController: new AbortController(), nativePlayback: {},
            nativeControl: {stop(){ nativeStops += 1; }}
        };
        ai.speechJobs.push(independent);
        await nextOutput.dispose();
        assert.equal(nativeStops, 0);
        assert.equal(independent.abortController.signal.aborted, false);
        assert.equal(ai.speechJobs.includes(independent), true);
        ai.stopAudio();
    });

    await t.test('unavailable Web Audio reports its own boundary without loading a model', async function testUnavailableOutput(){
        delete globalThis.AudioContext;
        try {
            const ai = new AudioOutputFixtureAI();
            const output = prepare(ai);
            assert.equal(output.state, 'unavailable');
            assert.equal(output.contextState, null);
            assert.ok(output.error instanceof TypeError);
            assert.equal(await output.resume(), false);
            assert.equal(modelCalls, 0);
            await output.dispose();
        } finally { globalThis.AudioContext = FakeAudioContext; }
    });
});

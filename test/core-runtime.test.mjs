import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {createCoreRuntime} from '../src/core/runtime.mjs';
import {CORE_PROTOCOL, CoreError} from '../browser-runtime/core/contracts.mjs';

function deferred() {
    let resolve;
    const promise = new Promise(function retainSettlement(resolvePromise) {
        resolve = resolvePromise;
    });
    return {promise, resolve};
}

function request(id, method, parameters = {}) {
    return {protocol: CORE_PROTOCOL, type: 'request', id, method, parameters};
}

function cancel(requestId) {
    return {protocol: CORE_PROTOCOL, type: 'control', control: 'request.cancel', requestId};
}

test('reentrant shutdown follows the replay snapshot rather than preceding stale state', async function replayOrdering() {
    const runtime = createCoreRuntime();
    runtime.start();
    const states = [];
    let closing;
    runtime.onFrame(function onReplay(frame) {
        if (frame.event === 'core.ready') closing = runtime.close();
        if (frame.event === 'core.state') states.push(frame.data.state);
    });
    await runtime.handle({protocol: CORE_PROTOCOL, type: 'control', control: 'runtime.replay'});
    await closing;
    assert.deepEqual(states, ['ready', 'draining', 'closed']);
});

test('document reconnect replays current Core state without restarting services', async function replayState(t) {
    const frames = [];
    const startGate = deferred();
    const saveGate = deferred();
    const saveEntered = deferred();
    const failure = new Error('Complete startup failure\n🦑', {cause: new Error('Original cause')});
    let starts = 0;
    const runtime = createCoreRuntime({application: {id: 'moon-reconnect'}, version: 'selected'});
    runtime.onFrame(function collect(frame) { frames.push(frame); });
    const slow = runtime.registerService({name: 'slow', start() { starts += 1; return startGate.promise; }});
    const failed = runtime.registerService({name: 'failed', start() { starts += 1; throw failure; }});
    runtime.registerService({name: 'journal', methods: {'journal.save': {lifetime: 'service', async handle(value) {
        saveEntered.resolve();
        await saveGate.promise;
        return value;
    }}}});
    t.after(async function finish() {
        startGate.resolve();
        saveGate.resolve();
        try { await runtime.close(); }
        catch (error) { assert.deepEqual(error.errors, [failure]); }
    });
    const replay = {protocol: CORE_PROTOCOL, type: 'control', control: 'runtime.replay'};
    await runtime.handle(replay);
    assert.equal(starts, 0);
    assert.equal(frames.some(frame => frame.event === 'core.ready'), false);
    assert.deepEqual(frames.find(frame => frame.event === 'core.state').data.services.map(service => service.state),
        ['registered', 'registered', 'registered']);

    runtime.start();
    await assert.rejects(failed.ready, error => error === failure);
    const boundary = frames.length;
    const current = runtime.current();
    await runtime.handle(replay);
    const emitted = frames.slice(boundary);
    assert.deepEqual(emitted.map(frame => frame.event),
        ['core.ready', 'core.state', 'core.service.state', 'core.service.state', 'core.service.state']);
    assert.deepEqual(emitted[1].data, current);
    assert.equal(emitted[3].data.error.message, failure.message);
    assert.equal(emitted[3].data.error.cause.message, failure.cause.message);
    assert.equal(starts, 2);
    assert.equal(slow.current().state, 'starting');

    const payload = {text: '  Save the entire moon ledger\n🌙  '};
    const save = runtime.handle(request('retained-save', 'journal.save', payload));
    await saveEntered.promise;
    const closing = runtime.close();
    const expectedCloseFailure = assert.rejects(closing, error => error.errors.length === 1 && error.errors[0] === failure);
    const closingBoundary = frames.length;
    await runtime.handle(replay);
    const closingFrames = frames.slice(closingBoundary);
    assert.equal(closingFrames.some(frame => frame.event === 'core.ready'), false);
    assert.equal(closingFrames[0].data.state, 'draining');
    assert.equal(closingFrames[0].data.activeRequests[0].lifetime, 'service');
    saveGate.resolve();
    startGate.resolve();
    assert.deepEqual((await save).result, payload);
    await expectedCloseFailure;
    assert.equal(starts, 2);
});

test('Core dispatch becomes ready while independent services are still starting', async function independentStartup(t) {
    const slowStartup = deferred();
    const slowStarted = deferred();
    const fastStarted = deferred();
    const starts = [];
    const frames = [];
    let slowCalls = 0;
    const runtime = createCoreRuntime({application: {id: 'moon-cheese-lab'}, version: '0.1.0'});
    const slow = runtime.registerService({
        name: 'telescope',
        start() {
            starts.push('telescope');
            slowStarted.resolve();
            return slowStartup.promise;
        },
        methods: {
            'telescope.observe': function observe() {
                slowCalls += 1;
                return {constellation: 'The Outraged Squid'};
            }
        }
    });
    const fast = runtime.registerService({
        name: 'clipboard',
        start() {
            starts.push('clipboard');
            fastStarted.resolve();
        },
        methods: {'clipboard.read': function read() { return 'launch checklist'; }}
    });
    t.after(async function releaseStartup() {
        slowStartup.resolve();
        await runtime.close();
    });
    runtime.onFrame(function collectFrame(frame) { frames.push(frame); });

    assert.equal(runtime.start().state, 'ready');
    await Promise.all([slowStarted.promise, fastStarted.promise, fast.ready]);
    assert.deepEqual(starts, ['telescope', 'clipboard']);
    assert.equal(slow.current().state, 'starting');
    assert.equal(fast.current().state, 'ready');
    assert.equal(frames.filter(function readyFrame(frame) { return frame.event === 'core.ready'; }).length, 1);
    assert.deepEqual((await runtime.handle(request('ping', 'system.ping'))).result, {ok: true});
    assert.equal((await runtime.handle(request('clipboard', 'clipboard.read'))).result, 'launch checklist');

    const observation = runtime.handle(request('observe', 'telescope.observe'));
    assert.equal(slowCalls, 0);
    slowStartup.resolve();
    assert.deepEqual((await observation).result, {constellation: 'The Outraged Squid'});
    assert.equal(slowCalls, 1);
    assert.equal(slow.current().state, 'ready');
});

test('Core preserves complete parameters, results, context and application descriptors', async function exactContent(t) {
    const application = {id: 'squid-courier', label: 'Squid Courier', options: {language: '日本語'}};
    const parameters = {
        document: '  First line\r\nSecond line: 🦑 café e\u0301\n\nLast line  ',
        nested: {literal: '\\n', empty: '', zero: 0, disabled: false, value: null},
        list: ['original', {message: 'Leave every field intact.'}]
    };
    const result = {accepted: true, document: parameters.document, records: parameters.list};
    const emitted = [];
    let received;
    let context;
    let receiver;
    const service = {
        name: 'courier',
        methods: {
            'courier.deliver': function deliver(value, operation) {
                received = value;
                context = operation;
                receiver = this;
                operation.emit('courier.received', value);
                return result;
            }
        }
    };
    const runtime = createCoreRuntime({application, version: '0.1.0', services: [service]});
    t.after(async function closeRuntime() { await runtime.close(); });
    runtime.onFrame(function collectFrame(frame) { emitted.push(frame); });
    runtime.start();

    const response = await runtime.handle(request('delivery', 'courier.deliver', parameters));
    assert.equal(response.ok, true);
    assert.equal(response.id, 'delivery');
    assert.equal(response.protocol, CORE_PROTOCOL);
    assert.equal(received, parameters);
    assert.equal(response.result, result);
    assert.equal(receiver, service);
    assert.equal(context.application, application);
    assert.equal(context.service, 'courier');
    assert.equal(context.requestId, 'delivery');
    assert.equal(context.signal.aborted, false);
    const event = emitted.find(function courierEvent(frame) { return frame.event === 'courier.received'; });
    assert.deepEqual(event.data, parameters);
    const published = emitted.find(function deliveryResponse(frame) { return frame.type === 'response' && frame.id === 'delivery'; });
    assert.deepEqual(published, response);
    assert.equal((await runtime.handle(request('app', 'app.current'))).result, application);
    assert.equal((await runtime.handle(request('version', 'version.current'))).result, '0.1.0');
});

test('Core returns complete structured errors and nested causes', async function completeErrors(t) {
    const cause = new Error('The squid dropped the complete envelope.\nRecovery detail: café 🦑');
    cause.code = 'ENVELOPE_DROPPED';
    cause.stack = 'Error: envelope detail\n    at syntheticCourier';
    cause.context = {document: '  preserved\r\ncomplete  '};
    const error = new CoreError({
        name: 'CourierError',
        code: 'DELIVERY_FAILED',
        message: 'The complete delivery explanation.\nSecond paragraph.',
        userMessage: 'Retrieve the envelope.',
        technicalMessage: 'Every diagnostic line.\nIncluding the final line.',
        resolution: 'Ask the courier to retry.',
        diagnosticId: 'synthetic-delivery',
        hresult: '0x80004005',
        stack: 'CourierError: complete details\n    at syntheticDelivery',
        cause,
        details: {routes: ['Moon', 'Earth'], original: 'No content changes. 🦑'}
    });
    const runtime = createCoreRuntime({services: [{
        name: 'courier',
        methods: {'courier.deliver': function failDelivery() { throw error; }}
    }]});
    t.after(async function closeRuntime() { await runtime.close(); });
    runtime.start();

    const response = await runtime.handle(request('failed', 'courier.deliver'));
    assert.equal(response.ok, false);
    assert.equal(Object.hasOwn(response, 'result'), false);
    assert.deepEqual(response.error, {
        name: error.name,
        code: error.code,
        message: error.message,
        userMessage: error.userMessage,
        technicalMessage: error.technicalMessage,
        resolution: error.resolution,
        diagnosticId: error.diagnosticId,
        hresult: error.hresult,
        stack: error.stack,
        causeName: 'CourierError',
        details: error.details,
        cause: {
            name: 'Error',
            code: cause.code,
            message: cause.message,
            stack: cause.stack,
            context: cause.context
        }
    });
});

test('Core preserves every nested AggregateError failure', async function aggregateErrors(t) {
    const first = new Error('First complete service failure.');
    first.stack = 'Error: first synthetic failure';
    const second = new Error('Second complete service failure.', {cause: first});
    second.stack = 'Error: second synthetic failure';
    const failure = new AggregateError([first, second], 'Both service failures.');
    failure.stack = 'AggregateError: both synthetic failures';
    const runtime = createCoreRuntime({services: [{
        name: 'collection',
        methods: {'collection.read': function failCollection() { throw failure; }}
    }]});
    t.after(async function closeRuntime() { await runtime.close(); });
    runtime.start();

    const response = await runtime.handle(request('aggregate', 'collection.read'));
    assert.equal(response.ok, false);
    assert.equal(response.error.name, 'AggregateError');
    assert.equal(response.error.message, failure.message);
    assert.equal(response.error.stack, failure.stack);
    assert.deepEqual(response.error.errors, [
        {name: 'Error', code: 'ARCANE_ERROR', message: first.message, stack: first.stack},
        {
            name: 'Error', code: 'ARCANE_ERROR', message: second.message, stack: second.stack,
            cause: {name: 'Error', code: 'ARCANE_ERROR', message: first.message, stack: first.stack}
        }
    ]);
});

test('request cancellation reaches the handler while service writes retain their lifetime', async function cancellationLifetimes(t) {
    const requestStarted = deferred();
    const requestFinished = deferred();
    const saveStarted = deferred();
    const saveFinished = deferred();
    let requestSignal;
    let saveSignal;
    const runtime = createCoreRuntime({services: [{
        name: 'notebook',
        methods: {
            'notebook.search': async function search(parameters, context) {
                requestSignal = context.signal;
                requestStarted.resolve();
                await requestFinished.promise;
                return {found: parameters.query};
            },
            'notebook.save': {
                lifetime: 'service',
                async handle(parameters, context) {
                    saveSignal = context.signal;
                    saveStarted.resolve();
                    await saveFinished.promise;
                    return {saved: parameters};
                }
            }
        }
    }]});
    t.after(async function releaseOperations() {
        requestFinished.resolve();
        saveFinished.resolve();
        await runtime.close();
    });
    runtime.start();
    const saved = {text: 'The squid has signed the flight log.\n🦑'};
    const searching = runtime.handle(request('search', 'notebook.search', {query: 'squid'}));
    const saving = runtime.handle(request('save', 'notebook.save', saved));
    await Promise.all([requestStarted.promise, saveStarted.promise]);

    assert.equal(await runtime.handle(cancel('save')), false);
    assert.equal(await runtime.handle(cancel('search')), true);
    assert.equal(await runtime.handle(cancel('search')), false);
    await runtime.handle({protocol: CORE_PROTOCOL, type: 'control', control: 'requests.cancelAll'});
    assert.equal(requestSignal.aborted, true);
    assert.equal(requestSignal.reason.code, 'REQUEST_ABORTED');
    assert.equal(saveSignal.aborted, false);
    assert.deepEqual(runtime.current().activeRequests, [
        {id: 'search', method: 'notebook.search', lifetime: 'request'},
        {id: 'save', method: 'notebook.save', lifetime: 'service'}
    ]);

    requestFinished.resolve();
    saveFinished.resolve();
    const [searchResponse, saveResponse] = await Promise.all([searching, saving]);
    assert.equal(searchResponse.ok, false);
    assert.equal(searchResponse.error.name, 'AbortError');
    assert.equal(searchResponse.error.code, 'REQUEST_ABORTED');
    assert.equal(saveResponse.ok, true);
    assert.deepEqual(saveResponse.result, {saved});
    assert.deepEqual(runtime.current().activeRequests, []);
});

test('a cancelled request waiting for service startup never invokes its handler', async function cancellationDuringStartup(t) {
    const startup = deferred();
    const started = deferred();
    let calls = 0;
    const runtime = createCoreRuntime({services: [{
        name: 'archive',
        start() {
            started.resolve();
            return startup.promise;
        },
        methods: {'archive.read': function read() { calls += 1; return 'entry'; }}
    }]});
    t.after(async function releaseStartup() {
        startup.resolve();
        await runtime.close();
    });
    runtime.start();
    const reading = runtime.handle(request('read', 'archive.read'));
    await started.promise;
    assert.equal(await runtime.handle(cancel('read')), true);
    assert.equal(calls, 0);
    startup.resolve();
    const response = await reading;
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'REQUEST_ABORTED');
    assert.equal(calls, 0);
});

test('Core close waits for accepted writes, responses, drain and disposal and is idempotent', async function orderedClose(t) {
    const accepted = deferred();
    const written = deferred();
    const drainStarted = deferred();
    const drained = deferred();
    const disposeStarted = deferred();
    const disposed = deferred();
    const order = [];
    let signal;
    let repeatedClose;
    let closeSettled = false;
    const runtime = createCoreRuntime({services: [{
        name: 'journal',
        methods: {
            'journal.save': {
                lifetime: 'service',
                async handle(parameters, context) {
                    signal = context.signal;
                    accepted.resolve();
                    await written.promise;
                    order.push('saved');
                    return parameters;
                }
            }
        },
        async drain() {
            order.push('drain');
            drainStarted.resolve();
            await drained.promise;
        },
        async dispose() {
            order.push('dispose');
            disposeStarted.resolve();
            await disposed.promise;
            order.push('disposed');
        }
    }]});
    t.after(async function releaseShutdown() {
        written.resolve();
        drained.resolve();
        disposed.resolve();
        await runtime.close();
    });
    runtime.onFrame(function observeResponse(frame) {
        if (frame.type === 'response' && frame.id === 'save') order.push('response');
    });
    runtime.subscribe(function closeAgainWhileDraining(state) {
        if (state.state === 'draining') repeatedClose = runtime.close();
    });
    runtime.start();
    const content = {text: 'A complete journal entry.\nAnother paragraph. 🦑'};
    const saving = runtime.handle(request('save', 'journal.save', content));
    await accepted.promise;
    const closing = runtime.close();
    function observeCloseSettlement() { closeSettled = true; }
    closing.then(observeCloseSettlement, observeCloseSettlement);
    assert.equal(repeatedClose, closing);
    assert.equal(runtime.close(), closing);
    assert.equal(runtime.current().state, 'draining');
    assert.equal(signal.aborted, false);
    assert.equal(closeSettled, false);

    const rejected = await runtime.handle(request('late', 'journal.save', content));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'CORE_NOT_READY');
    written.resolve();
    await drainStarted.promise;
    assert.deepEqual((await saving).result, content);
    assert.deepEqual(order, ['saved', 'response', 'drain']);
    assert.equal(closeSettled, false);
    drained.resolve();
    await disposeStarted.promise;
    assert.deepEqual(order, ['saved', 'response', 'drain', 'dispose']);
    assert.equal(closeSettled, false);
    disposed.resolve();
    const state = await closing;
    assert.equal(state.state, 'closed');
    assert.deepEqual(order, ['saved', 'response', 'drain', 'dispose', 'disposed']);
    assert.equal(runtime.close(), closing);
    assert.deepEqual(state.activeRequests, []);
});

test('reentrant close preserves ready, draining and closed state publication order', async function reentrantStateOrder(t) {
    const localStates = [];
    const wireStates = [];
    const runtime = createCoreRuntime();
    t.after(async function closeRuntime() { await runtime.close(); });
    runtime.subscribe(function closeFromReady(state) {
        localStates.push(state.state);
        if (state.state === 'ready') runtime.close();
    });
    runtime.onFrame(function collectWireState(frame) {
        if (frame.event === 'core.state') wireStates.push(frame.data.state);
    });

    runtime.start();
    await runtime.close();
    assert.deepEqual(localStates, ['created', 'ready', 'draining', 'closed']);
    assert.deepEqual(wireStates, ['ready', 'draining', 'closed']);
});

test('service startup failure remains observable while unrelated dispatch stays available', async function isolatedStartupFailure() {
    const failure = new Error('The telescope motor reports its complete failure.');
    const frames = [];
    const hooks = [];
    const runtime = createCoreRuntime({services: [{
        name: 'telescope',
        start() { throw failure; },
        methods: {'telescope.observe': function observe() { throw new Error('This handler must remain uncalled.'); }},
        drain() { hooks.push('drain'); },
        dispose() { hooks.push('dispose'); }
    }]});
    runtime.onFrame(function collectFrame(frame) { frames.push(frame); });
    runtime.start();
    try {
        const response = await runtime.handle(request('failed-startup', 'telescope.observe'));
        assert.equal(response.ok, false);
        assert.equal(response.error.message, failure.message);
        assert.equal(runtime.current().state, 'ready');
        assert.equal(runtime.current().services[0].state, 'failed');
        assert.equal(runtime.current().services[0].error.message, failure.message);
        assert.equal(runtime.current().services[0].error.stack, failure.stack);
        assert.deepEqual((await runtime.handle(request('ping', 'system.ping'))).result, {ok: true});
        const event = frames.find(function failedService(frame) {
            return frame.event === 'core.service.state' && frame.data.state === 'failed';
        });
        assert.equal(event.data.error.message, failure.message);
    } finally {
        await assert.rejects(runtime.close(), function originalShutdownFailure(error) {
            assert.equal(error.name, 'AggregateError');
            assert.deepEqual(error.errors, [failure]);
            return true;
        });
    }
    assert.deepEqual(hooks, ['drain', 'dispose']);
    assert.equal(runtime.current().state, 'closed');
});

test('throwing undefined during startup remains an explicit failed service outcome', async function undefinedStartupFailure() {
    const runtime = createCoreRuntime({services: [{
        name: 'archive',
        start() { throw undefined; },
        methods: {'archive.read': function read() { return 'unreachable'; }}
    }]});
    runtime.start();
    try {
        const response = await runtime.handle(request('undefined-failure', 'archive.read'));
        const expected = {name: 'Error', code: 'ARCANE_ERROR', message: 'undefined'};
        assert.equal(response.ok, false);
        assert.deepEqual(response.error, expected);
        assert.deepEqual(runtime.current().services[0].error, expected);
    } finally {
        await assert.rejects(runtime.close(), function undefinedShutdownFailure(error) {
            assert.deepEqual(error.errors, [undefined]);
            return true;
        });
    }
});

test('Core shutdown attempts disposal after drain failure and retains both errors', async function completeShutdownFailures() {
    const drainFailure = new Error('Complete drain failure.\nFinal drain detail.');
    const disposeFailure = new Error('Complete disposal failure.\nFinal disposal detail.');
    const failures = [];
    const order = [];
    const runtime = createCoreRuntime({services: [{
        name: 'journal',
        drain() { order.push('drain'); throw drainFailure; },
        dispose() { order.push('dispose'); throw disposeFailure; }
    }]});
    runtime.onFrame(function collectFailure(frame) {
        if (frame.event === 'core.error') failures.push(frame.data);
    });
    runtime.start();

    await assert.rejects(runtime.close(), function everyShutdownFailure(error) {
        assert.deepEqual(error.errors, [drainFailure, disposeFailure]);
        return true;
    });
    assert.deepEqual(order, ['drain', 'dispose']);
    assert.deepEqual(failures.map(function failureMessage(error) { return error.message; }), [
        drainFailure.message, disposeFailure.message
    ]);
    const state = runtime.current();
    assert.equal(state.state, 'closed');
    assert.equal(state.services[0].state, 'closed');
    assert.deepEqual(state.services[0].error.errors.map(function failureMessage(error) { return error.message; }), [
        drainFailure.message, disposeFailure.message
    ]);
});

import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import test from '../src/testing.mjs';
import {installNativeDiagnostics, reportNativeError} from '../browser-runtime/core/native-diagnostics.mjs';
import {createNativeDiagnosticsSource} from '../src/core-native-diagnostics-source.mjs';

const ownerKey = Symbol.for('arcane-os.native-diagnostics');
const documentKey = Symbol.for('arcane-os.app-control.document');

function deferred() {
    let resolve;
    const promise = new Promise(function retainSettlement(resolvePromise) { resolve = resolvePromise; });
    return {promise, resolve};
}

function documentFixture({transport = 'windows', send, documentId} = {}) {
    const frames = [];
    const failures = [];
    const listeners = [];
    const captureFailure = deferred();
    let documentIds = 0;

    class SyntheticDocument extends EventTarget {
        addEventListener(type, listener, options) {
            listeners.push({type, listener});
            super.addEventListener(type, listener, options);
        }
    }

    const global = new SyntheticDocument();
    global.location = {href: 'https://synthetic.invalid/moon-observatory.html'};
    global.crypto = {randomUUID() { documentIds += 1; return `synthetic-document-${documentIds}`; }};
    global.console = {
        error(...arguments_) {
            failures.push(arguments_);
            captureFailure.resolve(arguments_);
        }
    };
    if (documentId !== undefined) global[documentKey] = documentId;

    function sendFrame(text) {
        const frame = JSON.parse(text);
        frames.push(frame);
        return send ? send(frame) : {accepted: true, sequence: frames.length};
    }

    if (transport === 'windows') {
        global.chrome = {webview: {hostObjects: {arcaneDiagnostics: {Send: sendFrame}}}};
    } else if (transport === 'webkit') {
        global.webkit = {messageHandlers: {arcaneDiagnostics: {postMessage: sendFrame}}};
    }
    return {global, frames, failures, listeners, captureFailure, documentIds() { return documentIds; }};
}

function valueNode(record, reference) {
    const node = record.values.find(function matchingNode(value) { return value.id === reference?.ref; });
    assert.ok(node, 'The diagnostic reference identifies a retained graph node.');
    return node;
}

function property(record, reference, key) {
    const node = valueNode(record, reference);
    const descriptor = [...node.properties, ...node.inherited].find(function matchingProperty(item) { return item.key === key; });
    assert.ok(descriptor, `The complete diagnostic retains ${key}.`);
    return descriptor;
}

function setGlobalOwner(t, owner) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, ownerKey);
    t.after(function restoreGlobalOwner() {
        if (descriptor) Object.defineProperty(globalThis, ownerKey, descriptor);
        else delete globalThis[ownerKey];
    });
    if (owner === undefined) delete globalThis[ownerKey];
    else Object.defineProperty(globalThis, ownerKey, {configurable: true, writable: true, value: owner});
}

test('native diagnostics retain complete error causes, aggregate members and cyclic shared details', async function completeErrorGraph() {
    const fixture = documentFixture();
    const owner = installNativeDiagnostics(fixture.global);
    await owner.ready;
    const cause = new Error('  Complete underlying cause.\r\n月 🧀  ');
    Object.defineProperty(cause, 'code', {value: 'SYNTHETIC_MOON_ENGINE', enumerable: false, configurable: true});
    const member = new TypeError('  Complete aggregate member.\nSecond line.  ', {cause});
    const error = new AggregateError([member, cause], '  Complete observed failure.\r\nFinal line.  ', {cause});
    const shared = {message: '  Exact shared detail.\nKeep this line.  '};
    const details = {phase: 'synthetic observation', first: shared, second: shared, error};
    details.self = details;
    error.details = details;
    const accepted = await owner.report(error, {details});

    assert.equal(accepted.accepted, true);
    const frame = fixture.frames[1];
    assert.equal(frame.protocol, 'arcane.native-diagnostics/1');
    assert.equal(frame.documentId, owner.documentId);
    assert.equal(frame.documentUrl, fixture.global.location.href);
    assert.equal(Number.isNaN(Date.parse(frame.time)), false);
    assert.equal(frame.record.kind, 'application');
    assert.equal(frame.record.valueFormat, 'arcane.diagnostic-value/1');
    const record = frame.record;
    assert.equal(valueNode(record, record.error).constructorName, 'AggregateError');
    assert.equal(property(record, record.error, 'message').value, error.message);
    assert.equal(property(record, record.error, 'stack').value, error.stack);
    const causeReference = property(record, record.error, 'cause').value;
    assert.equal(property(record, causeReference, 'message').value, cause.message);
    assert.equal(property(record, causeReference, 'code').value, cause.code);
    assert.equal(property(record, causeReference, 'code').enumerable, false);
    const errorsReference = property(record, record.error, 'errors').value;
    const memberReference = property(record, errorsReference, '0').value;
    assert.equal(valueNode(record, memberReference).constructorName, 'TypeError');
    assert.equal(property(record, memberReference, 'message').value, member.message);
    assert.deepEqual(property(record, memberReference, 'cause').value, causeReference);
    assert.deepEqual(property(record, errorsReference, '1').value, causeReference);
    assert.deepEqual(property(record, record.error, 'details').value, record.details);
    assert.deepEqual(property(record, record.details, 'self').value, record.details);
    assert.deepEqual(property(record, record.details, 'error').value, record.error);
    const sharedReference = property(record, record.details, 'first').value;
    assert.deepEqual(property(record, record.details, 'second').value, sharedReference);
    assert.equal(property(record, sharedReference, 'message').value, shared.message);
    assert.deepEqual(fixture.failures, []);
});

test('diagnostic reflection preserves own and inherited accessors without invoking getters or toJSON', async function accessorDescriptors() {
    const fixture = documentFixture();
    const owner = installNativeDiagnostics(fixture.global);
    await owner.ready;
    const reads = [];
    function unreadValue() { reads.push('getter'); throw new Error('This synthetic getter must remain uncalled.'); }
    function unwrittenValue() { reads.push('setter'); }
    const prototype = Object.create(Error.prototype);
    Object.defineProperty(prototype, 'details', {get: unreadValue, set: unwrittenValue, configurable: true});
    const error = new Error('Complete accessor-bearing error.');
    Object.setPrototypeOf(error, prototype);
    Object.defineProperty(error, 'custom', {get: unreadValue, configurable: true, enumerable: true});
    const details = {};
    Object.defineProperty(details, 'lazy', {get: unreadValue, set: unwrittenValue, configurable: true, enumerable: true});
    Object.defineProperty(details, 'toJSON', {get: unreadValue, configurable: true});
    const symbol = Symbol('synthetic constellation');
    Object.defineProperty(details, symbol, {value: 'Complete symbol-named detail.', configurable: true});
    await owner.report(error, {details});

    const record = fixture.frames[1].record;
    assert.deepEqual(reads, []);
    const custom = property(record, record.error, 'custom');
    assert.equal(valueNode(record, custom.get).type, 'function');
    assert.deepEqual(custom.set, {type: 'undefined'});
    const inherited = property(record, record.error, 'details');
    assert.deepEqual(inherited.get, custom.get);
    const lazy = property(record, record.details, 'lazy');
    assert.deepEqual(lazy.get, custom.get);
    assert.deepEqual(lazy.set, inherited.set);
    assert.deepEqual(property(record, record.details, 'toJSON').get, custom.get);
    const symbolProperty = valueNode(record, record.details).properties.find(function symbolKey(item) { return item.key?.ref; });
    assert.ok(symbolProperty);
    assert.equal(valueNode(record, symbolProperty.key).type, 'symbol');
    assert.equal(valueNode(record, symbolProperty.key).description, symbol.description);
    assert.equal(symbolProperty.value, 'Complete symbol-named detail.');
});

test('a diagnostic snapshot is complete before waiting for an earlier native submission', async function snapshotBeforeIngress() {
    const entered = deferred();
    const finish = deferred();
    let reports = 0;
    const fixture = documentFixture({
        async send(frame) {
            if (frame.type === 'error' && ++reports === 1) {
                entered.resolve();
                await finish.promise;
            }
            return {accepted: true};
        }
    });
    const owner = installNativeDiagnostics(fixture.global);
    await owner.ready;
    const first = owner.report(new Error('Synthetic earlier report.'));
    await entered.promise;
    const error = new Error('Complete original message.');
    const details = {message: 'Complete original details.'};
    const second = owner.report(error, {details});
    error.message = 'Later application mutation.';
    details.message = 'Later details mutation.';
    finish.resolve();
    await Promise.all([first, second]);
    const record = fixture.frames[2].record;
    assert.equal(property(record, record.error, 'message').value, 'Complete original message.');
    assert.equal(property(record, record.details, 'message').value, 'Complete original details.');
});

test('report options preserve the details descriptor without reading unrelated options', async function optionDescriptors() {
    const fixture = documentFixture();
    const owner = installNativeDiagnostics(fixture.global);
    await owner.ready;
    let reads = 0;
    function unreadOption() { reads += 1; throw new Error('This option accessor must stay uncalled.'); }
    const options = {};
    for (const key of ['details', 'location', 'toJSON']) {
        Object.defineProperty(options, key, {get: unreadOption});
    }
    await owner.report(new Error('Complete error with accessor options.'), options);
    const record = fixture.frames[1].record;
    assert.equal(reads, 0);
    assert.equal(record.details.type, 'accessor');
    assert.equal(valueNode(record, record.details.get).type, 'function');
    assert.deepEqual(record.details.set, {type: 'undefined'});
    assert.equal(Object.hasOwn(record, 'location'), false);
});

test('reflection failures reject with the original error instead of accepting incomplete diagnostics', async function failedReflection() {
    const fixture = documentFixture();
    const owner = installNativeDiagnostics(fixture.global);
    await owner.ready;
    const failure = new Error('Complete original reflection failure.');
    const details = new Proxy({}, {ownKeys() { throw failure; }});
    await assert.rejects(owner.report(new Error('Synthetic application error.'), {details}), function originalError(error) {
        assert.equal(error, failure);
        return true;
    });
    assert.equal(fixture.frames.length, 1);
});

test('window errors and unhandled rejections retain their values without suppressing ordinary events', async function ordinaryEvents() {
    const windowCaptured = deferred();
    const rejectionCaptured = deferred();
    const fixture = documentFixture({
        send(frame) {
            if (frame.record?.kind === 'window.error') windowCaptured.resolve(frame);
            if (frame.record?.kind === 'unhandledrejection') rejectionCaptured.resolve(frame);
            return {accepted: true};
        }
    });
    const owner = installNativeDiagnostics(fixture.global);
    await owner.ready;
    const observed = [];
    fixture.global.addEventListener('error', function ordinaryWindowListener(event) { observed.push(event); });
    fixture.global.addEventListener('unhandledrejection', function ordinaryRejectionListener(event) { observed.push(event); });
    const error = new Error('  Complete synthetic window failure.\n月  ');
    const windowEvent = new Event('error', {cancelable: true});
    Object.assign(windowEvent, {error, message: error.message, filename: 'moon-observatory.mjs', lineno: 37, colno: 12});
    const reason = {message: '  Complete rejection reason.\r\nFinal line.  '};
    reason.self = reason;
    const rejectionEvent = new Event('unhandledrejection', {cancelable: true});
    Object.assign(rejectionEvent, {reason});
    assert.equal(fixture.global.dispatchEvent(windowEvent), true);
    assert.equal(fixture.global.dispatchEvent(rejectionEvent), true);
    const [windowFrame, rejectionFrame] = await Promise.all([windowCaptured.promise, rejectionCaptured.promise]);
    assert.equal(windowEvent.defaultPrevented, false);
    assert.equal(rejectionEvent.defaultPrevented, false);
    assert.deepEqual(observed, [windowEvent, rejectionEvent]);
    assert.equal(property(windowFrame.record, windowFrame.record.error, 'message').value, error.message);
    assert.deepEqual(windowFrame.record.location, {file: 'moon-observatory.mjs', line: 37, column: 12});
    assert.equal(property(rejectionFrame.record, rejectionFrame.record.error, 'message').value, reason.message);
    assert.deepEqual(property(rejectionFrame.record, rejectionFrame.record.error, 'self').value, rejectionFrame.record.error);
    assert.deepEqual(fixture.failures, []);
});

test('window capture preserves a message-only error and leaves resource failures outside its scope', async function messageOnlyError() {
    const captured = deferred();
    const fixture = documentFixture({send(frame) {
        if (frame.type === 'error') captured.resolve(frame);
        return {accepted: true};
    }});
    const owner = installNativeDiagnostics(fixture.global);
    await owner.ready;
    const errorListener = fixture.listeners.find(function windowListener(listener) { return listener.type === 'error'; }).listener;
    errorListener({target: {}, get error() { throw new Error('Resource errors must not be inspected as window failures.'); }});
    const event = new Event('error', {cancelable: true});
    Object.assign(event, {error: null, message: '  Complete message-only failure.\n月  ', filename: 'synthetic.mjs', lineno: 8, colno: 4});
    fixture.global.dispatchEvent(event);
    const frame = await captured.promise;
    assert.equal(frame.record.error, null);
    assert.equal(frame.record.message, event.message);
    assert.deepEqual(frame.record.values, []);
    assert.equal(event.defaultPrevented, false);
    assert.equal(fixture.frames.length, 2);
});

test('native diagnostic ingress remains independent of failed ordinary Core routes', async function independentCoreRoute(t) {
    for (const transport of ['windows', 'webkit']) {
        await t.test(transport, async function selectedNativeTransport() {
            const fixture = documentFixture({transport, send() { return '{"accepted":true,"recordId":"synthetic-native-record"}'; }});
            let coreCalls = 0;
            function failedCoreRoute() { coreCalls += 1; throw new Error('Synthetic Core route is closed.'); }
            Object.defineProperty(fixture.global, 'Arcane', {get: failedCoreRoute});
            fixture.global[Symbol.for('arcane-os.core.client')] = {closed: true, request: failedCoreRoute};
            if (transport === 'windows') fixture.global.chrome.webview.hostObjects.arcaneBridge = {Send: failedCoreRoute};
            else fixture.global.webkit.messageHandlers.arcane = {postMessage: failedCoreRoute};
            const owner = installNativeDiagnostics(fixture.global);
            await owner.ready;
            assert.deepEqual(await owner.report(new Error('Complete error after Core failure.')),
                {accepted: true, recordId: 'synthetic-native-record'});
            assert.equal(coreCalls, 0);
            assert.equal(fixture.frames.length, 2);
            assert.deepEqual(fixture.failures, []);
        });
    }
});

test('missing native ingress rejects readiness and explicit reports with observed startup failure', async function unavailableIngress() {
    const fixture = documentFixture({transport: 'absent'});
    const owner = installNativeDiagnostics(fixture.global);
    await assert.rejects(owner.ready, {code: 'ARCANE_NATIVE_DIAGNOSTICS_UNAVAILABLE'});
    const observed = await fixture.captureFailure.promise;
    assert.equal(observed[0], 'Arcane native diagnostic capture failed.');
    assert.equal(observed[1].code, 'ARCANE_NATIVE_DIAGNOSTICS_UNAVAILABLE');
    await assert.rejects(owner.report(new Error('Complete report without ingress.')), {code: 'ARCANE_NATIVE_DIAGNOSTICS_UNAVAILABLE'});
    assert.deepEqual(fixture.frames, []);
    assert.equal(fixture.failures.length, 1);
});

test('a rejected native report retains the complete rejection and does not block the next report', async function rejectedIngress() {
    const rejected = {accepted: false, error: {message: '  Complete host rejection.\n月  ', details: {state: 'synthetic refusal'}}};
    let reports = 0;
    const fixture = documentFixture({send(frame) {
        if (frame.type === 'error' && ++reports === 1) return rejected;
        return {accepted: true, recordId: 'retained-after-rejection'};
    }});
    const owner = installNativeDiagnostics(fixture.global);
    await owner.ready;
    await assert.rejects(owner.report(new Error('First synthetic report.')), function completeRejection(error) {
        assert.equal(error.code, 'ARCANE_NATIVE_DIAGNOSTIC_REJECTED');
        assert.deepEqual(error.cause, rejected.error);
        assert.deepEqual(error.details, rejected);
        return true;
    });
    assert.deepEqual(await owner.report(new Error('Second complete report.')), {accepted: true, recordId: 'retained-after-rejection'});
    assert.equal(fixture.frames.length, 3);
    assert.deepEqual(fixture.failures, []);
});

test('automatic capture observes a rejected native submission without changing the original event', async function observedAutomaticFailure() {
    const rejected = {accepted: false, error: {message: 'Complete synthetic native refusal.'}};
    const fixture = documentFixture({send(frame) { return frame.type === 'error' ? rejected : {accepted: true}; }});
    const owner = installNativeDiagnostics(fixture.global);
    await owner.ready;
    const reason = new Error('Complete original unhandled reason.');
    const event = new Event('unhandledrejection', {cancelable: true});
    Object.assign(event, {reason});
    assert.equal(fixture.global.dispatchEvent(event), true);
    const observed = await fixture.captureFailure.promise;
    assert.equal(observed[1].code, 'ARCANE_NATIVE_DIAGNOSTIC_REJECTED');
    assert.deepEqual(observed[1].details, rejected);
    assert.equal(observed[2], reason);
    assert.equal(event.reason, reason);
    assert.equal(event.defaultPrevented, false);
    assert.equal(fixture.frames.length, 2);
});

test('document installation reuses the app-control marker and installs one observer', async function documentSingleton() {
    const fixture = documentFixture({documentId: 'existing-app-control-document'});
    const first = installNativeDiagnostics(fixture.global);
    const second = installNativeDiagnostics(fixture.global);
    assert.equal(second, first);
    assert.equal(fixture.global[ownerKey], first);
    assert.equal(first.documentId, 'existing-app-control-document');
    assert.equal(fixture.documentIds(), 0);
    await first.ready;
    assert.deepEqual(fixture.listeners.map(function eventName(listener) { return listener.type; }), ['error', 'unhandledrejection']);
    assert.equal(fixture.frames.length, 1);
    assert.equal(fixture.frames[0].type, 'document');
    const separate = documentFixture();
    const separateOwner = installNativeDiagnostics(separate.global);
    await separateOwner.ready;
    assert.notEqual(separateOwner, first);
    assert.equal(separate.global[documentKey], separateOwner.documentId);
    assert.equal(separate.documentIds(), 1);
});

test('the ESM reporter uses the installed document owner and preserves explicit options', async function esmReporter(t) {
    const fixture = documentFixture();
    const owner = installNativeDiagnostics(fixture.global);
    await owner.ready;
    setGlobalOwner(t, owner);
    const error = new Error('Complete ESM-reported failure.');
    const details = {message: 'Complete explicit ESM details.'};
    const result = await reportNativeError(error, {details});
    assert.equal(result.accepted, true);
    assert.equal(fixture.frames.length, 2);
    assert.equal(fixture.frames[1].documentId, owner.documentId);
    assert.equal(property(fixture.frames[1].record, fixture.frames[1].record.details, 'message').value, details.message);
    assert.equal(fixture.listeners.length, 2);
});

test('the ESM reporter reports unavailable capture when no document owner is installed', async function missingEsmOwner(t) {
    setGlobalOwner(t, undefined);
    await assert.rejects(reportNativeError(new Error('Complete ESM failure without a native owner.')),
        {code: 'ARCANE_NATIVE_DIAGNOSTICS_UNAVAILABLE'});
});

test('the classic projection installs the canonical helper once without a module loader', async function classicProjection() {
    const fixture = documentFixture({documentId: 'classic-app-control-document'});
    const context = vm.createContext({
        location: fixture.global.location,
        crypto: fixture.global.crypto,
        console: fixture.global.console,
        chrome: fixture.global.chrome,
        [documentKey]: fixture.global[documentKey],
        addEventListener(type, listener) { fixture.listeners.push({type, listener}); }
    });
    const source = await createNativeDiagnosticsSource();
    assert.match(source, /function installNativeDiagnostics\(/u);
    assert.match(source, /function reportNativeError\(/u);
    assert.equal(/^import /mu.test(source), false);
    assert.equal(/^export /mu.test(source), false);
    assert.equal(source.includes('node:'), false);
    vm.runInContext(source, context);
    const owner = context[ownerKey];
    await owner.ready;
    vm.runInContext(source, context);
    assert.equal(context[ownerKey], owner);
    assert.equal(owner.documentId, 'classic-app-control-document');
    assert.equal(fixture.frames.length, 1);
    assert.deepEqual(fixture.listeners.map(function eventName(listener) { return listener.type; }), ['error', 'unhandledrejection']);
    await owner.report(new Error('Complete classic-helper error.'));
    assert.equal(property(fixture.frames[1].record, fixture.frames[1].record.error, 'message').value, 'Complete classic-helper error.');
});

test('the fixed native script leaves frame documents outside its capture scope', async function topLevelDocumentOnly() {
    const context = vm.createContext({top: {}});
    vm.runInContext(await createNativeDiagnosticsSource(), context);
    assert.equal(context[ownerKey], undefined);
});

test('native diagnostics are wired into public imports and pre-readiness Windows app control', async function sourceBindings() {
    const [manifest, imports, control, host, windowControl, pipe, launcher, build] = await Promise.all([
        'package.json', 'src/import-map.mjs', 'src/core/app-control.mjs',
        'src/core/hosts/windows/ArcaneHost.cs', 'src/core/hosts/windows/ArcaneWindowControl.cs',
        'src/core/hosts/windows/ArcaneAppControl.cs', 'src/core/hosts/windows/ArcaneLauncher.cs',
        'tools/build-core-windows-host.mjs'
    ].map(function readOwnedBinding(filename) { return readFile(new URL(`../${filename}`, import.meta.url), 'utf8'); }));
    const exports = JSON.parse(manifest).exports;
    assert.equal(exports['./core/native-diagnostics'], './browser-runtime/core/native-diagnostics.mjs');
    assert.equal(exports['./core/native-diagnostics-source'], './src/core-native-diagnostics-source.mjs');
    assert.match(imports, /\['arcane-os\/core\/native-diagnostics','sdk\/core\/native-diagnostics\.mjs'\]/u);
    assert.match(control, /diagnostics\(parameters = \{\}, options\).*app\.control\.diagnostics/u);
    assert.match(pipe, /method != "app\.control\.diagnostics"/u);
    assert.match(windowControl, /return nativeDiagnostics\.Snapshot\(parameters\)/u);
    assert.ok(windowControl.indexOf('return nativeDiagnostics.Snapshot(parameters)')
        < windowControl.indexOf('if (!AppControlDocumentReady())'));
    assert.match(windowControl, /\?\?= globalThis\.crypto\.randomUUID\(\)/u);
    assert.ok(host.indexOf('await InstallNativeDiagnosticsAsync(browser)') < host.indexOf('Task scripts = Task.WhenAll'));
    assert.match(host, /AddHostObjectToScript\("arcaneDiagnostics", nativeDiagnostics\)/u);
    assert.match(host, /nativeDiagnostics\.Stop\(\)/u);
    assert.match(launcher, /NativeDiagnosticsSource = File\.ReadAllText\(Path\.Combine\(directory, "arcane-native-diagnostics\.js"\)\)/u);
    assert.match(build, /createNativeDiagnosticsSource\(\)/u);
    assert.match(build, /ArcaneNativeDiagnostics\.cs/u);
});

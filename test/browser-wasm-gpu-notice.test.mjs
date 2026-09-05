import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Script, createContext} from 'node:vm';

import test from '../src/testing.mjs';

const providerUrl = new URL('../browser-runtime/ai/browser-wasm-llm-provider.mjs', import.meta.url);
const providerSource = await readFile(providerUrl, 'utf8');
const authoredNotice = providerSource.match(
    /function highPerformanceGpuBrowser\(\)[\s\S]*?(?=function sourceMetadata\()/u
);
assert.ok(authoredNotice, 'The provider owns the browser notice and adapter event together.');
// Execute the authored private boundary without introducing a production test API
// or importing a model runtime. Browser calls and evidence remain synthetic.
const noticeScript = new Script(authoredNotice[0]);
const windowsChrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';

function browserFixture(navigatorObject, {popupThrows = false, instrumentThrows = false} = {}) {
    const opened = [];
    const alerts = [];
    const events = [];
    let gpuRequests = 0;
    const context = createContext({
        navigator: navigatorObject === undefined ? undefined : {
            ...navigatorObject,
            gpu: {
                requestAdapter() {
                    gpuRequests += 1;
                    throw new Error('The notice must not request another GPU adapter.');
                }
            }
        },
        highPerformanceGpuNoticeShown: false,
        WEBGPU_ADAPTER_SELECTED_EVENT: 'arcane.ai.browser-wasm.webgpu.adapter.selected',
        WEBGPU_ADAPTER_SELECTION_PROTOCOL: 'arcane-ai-webgpu-adapter-selection/1',
        completeValue(value) {
            return value;
        },
        arcaneEvents: {
            instrument(type, detail, metadata) {
                events.push({type, detail, metadata});
                if (instrumentThrows) {
                    throw new Error('Synthetic event observer failure.');
                }
            }
        },
        open(...args) {
            opened.push(args);
            if (popupThrows) {
                throw new Error('Synthetic internal-page navigation failure.');
            }
            return null;
        },
        alert(message) {
            alerts.push(message);
        }
    });
    noticeScript.runInContext(context);
    return {
        alerts,
        events,
        opened,
        emit(evidence, modelId = 'synthetic-model') {
            context.emitWebgpuAdapterSelection({id: modelId}, {
                evidence() {
                    return evidence;
                }
            });
        },
        gpuRequests() {
            return gpuRequests;
        }
    };
}

function observedAdapter(adapter = {description: 'Synthetic selected adapter'}) {
    return {protocol: 'synthetic-runtime-evidence/1', webgpu: {observed: true, adapter}};
}

test('Windows Chromium notice names only the current browser and its single performance flag', function currentBrowserFlag() {
    const cases = [
        {navigator: {userAgent: `${windowsChrome} Edg/140.0.0.0`}, name: 'Microsoft Edge', scheme: 'edge'},
        {navigator: {userAgentData: {platform: 'Windows', brands: [{brand: 'Microsoft Edge'}]}}, name: 'Microsoft Edge', scheme: 'edge'},
        {navigator: {userAgent: windowsChrome, brave: {isBrave() { throw new Error('Brand detection must not call isBrave.'); }}}, name: 'Brave', scheme: 'brave'},
        {navigator: {userAgentData: {platform: 'Windows', brands: [{brand: 'Brave'}]}}, name: 'Brave', scheme: 'brave'},
        {navigator: {userAgent: `${windowsChrome} OPR/124.0.0.0`}, name: 'Opera', scheme: 'opera'},
        {navigator: {userAgentData: {platform: 'Windows', brands: [{brand: 'Opera'}]}}, name: 'Opera', scheme: 'opera'},
        {navigator: {userAgent: `${windowsChrome} Vivaldi/7.0.0.0`}, name: 'Vivaldi', scheme: 'vivaldi'},
        {navigator: {userAgentData: {platform: 'Windows', brands: [{brand: 'Vivaldi'}]}}, name: 'Vivaldi', scheme: 'vivaldi'},
        {navigator: {userAgent: `${windowsChrome} Edg/140.0.0.0`, userAgentData: {platform: 'Windows', brands: [{brand: 'Microsoft Edge'}, {brand: 'Vivaldi'}]}}, name: 'Vivaldi', scheme: 'vivaldi'},
        {navigator: {userAgent: windowsChrome}, name: 'your browser', scheme: 'about'},
        {navigator: {platform: 'Win32', userAgent: 'Chromium/140.0.0.0'}, name: 'your browser', scheme: 'about'},
        {navigator: {userAgentData: {platform: 'Windows', brands: [{brand: 'Google Chrome'}, {brand: 'Chromium'}]}}, name: 'your browser', scheme: 'about'}
    ];
    for (const scenario of cases) {
        const fixture = browserFixture(scenario.navigator);
        fixture.emit(observedAdapter());
        const url = `${scenario.scheme}://flags/#force-high-performance-gpu`;
        assert.deepEqual(fixture.opened, [[url, '_blank', 'noopener,noreferrer']]);
        assert.equal(fixture.alerts.length, 1);
        const message = fixture.alerts[0];
        assert.deepEqual(message.match(/[a-z]+:\/\/flags\/#[a-z-]+/gu), [url]);
        assert.ok(message.includes(`in ${scenario.name}`));
        assert.match(message, /If this computer has multiple GPUs/u);
        assert.match(message, /when available/u);
        assert.match(message, /completely close and reopen/u);
        assert.doesNotMatch(message, /integrated|discrete|ignore-gpu-blocklist|unsafe-webgpu|use-angle/iu);
        assert.equal(fixture.gpuRequests(), 0);
    }
});

test('unsupported browsers and non-Windows or mobile platforms receive no flag notice', function unsupportedBrowserSilence() {
    const navigators = [
        undefined,
        {},
        {platform: 'Win32', userAgent: 'Mozilla/5.0 Firefox/140.0'},
        {platform: 'Win32', userAgent: 'Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'},
        {platform: 'MacIntel', userAgent: windowsChrome},
        {platform: 'Linux x86_64', userAgent: windowsChrome},
        {userAgent: windowsChrome, userAgentData: {platform: 'macOS', brands: [{brand: 'Chromium'}]}},
        {userAgent: windowsChrome, userAgentData: {platform: 'Linux', brands: [{brand: 'Microsoft Edge'}]}},
        {userAgent: windowsChrome, userAgentData: {platform: 'Windows', mobile: true, brands: [{brand: 'Chromium'}]}},
        {platform: 'Win32', userAgent: `${windowsChrome} Android 15`},
        {platform: 'Win32', userAgent: `${windowsChrome} Mobile`},
        {platform: 'Win32', userAgent: `${windowsChrome} iPhone`},
        {platform: 'Win32', userAgent: `${windowsChrome} iPad`},
        {platform: 'Win32', userAgent: `${windowsChrome} iPod`}
    ];
    for (const navigatorObject of navigators) {
        const fixture = browserFixture(navigatorObject);
        fixture.emit(observedAdapter());
        assert.deepEqual(fixture.opened, []);
        assert.deepEqual(fixture.alerts, []);
        assert.equal(fixture.events.length, 1, 'Unsupported flag guidance preserves adapter events.');
        assert.equal(fixture.gpuRequests(), 0);
    }
});

test('only an observed selected adapter triggers the preserved adapter event and notice', function observedEvidenceBoundary() {
    const fixture = browserFixture({userAgent: windowsChrome});
    for (const evidence of [undefined, {}, {webgpu: {}}, {webgpu: {observed: true}}, {webgpu: {observed: false, adapter: {}}}]) {
        fixture.emit(evidence);
    }
    assert.deepEqual(fixture.events, []);
    assert.deepEqual(fixture.alerts, []);
    assert.deepEqual(fixture.opened, []);

    const evidence = observedAdapter({description: 'Synthetic chosen device', vendor: 'Synthetic vendor'});
    evidence.webgpu.offload = {layers: 8};
    evidence.webgpu.buffers = {count: 2};
    evidence.webgpu.queue = {submissions: 1};
    fixture.emit(evidence, 'selected-model');
    assert.equal(fixture.events.length, 1);
    const event = fixture.events[0];
    assert.equal(event.type, 'arcane.ai.browser-wasm.webgpu.adapter.selected');
    assert.equal(event.detail.protocol, 'arcane-ai-webgpu-adapter-selection/1');
    assert.equal(event.detail.providerId, 'arcane-browser-wasm-wllama');
    assert.equal(event.detail.modelId, 'selected-model');
    assert.equal(event.detail.runtimeEvidenceProtocol, evidence.protocol);
    assert.equal(event.detail.adapter, evidence.webgpu.adapter);
    assert.equal(event.detail.offload, evidence.webgpu.offload);
    assert.equal(event.detail.buffers, evidence.webgpu.buffers);
    assert.equal(event.detail.queue, evidence.webgpu.queue);
    assert.equal(event.metadata.source, 'sdk:ai/browser-wasm');
    assert.equal(event.metadata.category, 'capability');
    assert.equal(fixture.alerts.length, 1);
});

test('GPU guidance uses selected adapter evidence without inferring topology from its vendor', function vendorNeutralNotice() {
    for (const vendor of ['Intel', 'AMD', 'NVIDIA', '']) {
        const fixture = browserFixture({userAgent: windowsChrome});
        fixture.emit(observedAdapter({vendor}));
        assert.equal(fixture.alerts.length, 1);
        assert.ok(fixture.alerts[0].startsWith(`Selected WebGPU adapter: ${vendor || 'the available WebGPU adapter'}.`));
        assert.match(fixture.alerts[0], /If this computer has multiple GPUs/u);
    }
});

test('repeated model adapter events produce one notice in the same module realm', function oncePerRealmNotice() {
    const fixture = browserFixture({userAgent: windowsChrome});
    fixture.emit(observedAdapter(), 'first-model');
    fixture.emit(observedAdapter({name: 'Another selected adapter'}), 'second-model');
    assert.equal(fixture.events.length, 2);
    assert.equal(fixture.opened.length, 1);
    assert.equal(fixture.alerts.length, 1);
    assert.equal(fixture.gpuRequests(), 0);
});

test('a browser rejection of its flags page retains the manual address-bar instruction', function popupFailureNotice() {
    const fixture = browserFixture({userAgent: `${windowsChrome} Edg/140.0.0.0`}, {popupThrows: true});
    fixture.emit(observedAdapter());
    assert.equal(fixture.alerts.length, 1);
    assert.match(fixture.alerts[0], /paste edge:\/\/flags\/#force-high-performance-gpu into the address bar/u);
});

test('an adapter-event observer failure still presents the requested GPU notice', function eventFailureNotice() {
    const fixture = browserFixture({userAgent: windowsChrome}, {instrumentThrows: true});
    assert.throws(function emitWithFailingObserver() {
        fixture.emit(observedAdapter());
    }, /Synthetic event observer failure/u);
    assert.equal(fixture.alerts.length, 1);
    assert.equal(fixture.opened.length, 1);
});

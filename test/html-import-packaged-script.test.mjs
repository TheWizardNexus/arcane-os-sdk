import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {createHTMLImportScript} from '../runtime/arcane/modules/HTMLImportScript.js';

function deferred() {
    let resolve;
    const promise = new Promise(function captureResolution(complete) {
        resolve = complete;
    });
    return {promise, resolve};
}

test(
    'packaged HTMLImport scripts retain host-owned execution and lifecycle',
    async function packagedHTMLImportLifecycle(context) {
        const replacements = new Map();
        const definitions = new Map();
        const instances = [];
        const fragments = new Map();
        const sources = new Map();
        const requests = [];
        const appended = [];
        const pendingAppends = [];
        const appendWaiters = [];
        const hostRegistryKey = Symbol.for('arcane.html-import.hosts');
        const hostRegistry = new Map();

        function replaceGlobal(name, value) {
            replacements.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
            Object.defineProperty(globalThis, name, {
                value,
                configurable: true,
                writable: true
            });
        }

        class ScriptElement extends EventTarget {
            constructor(attributes = {}, source = '') {
                super();
                this.attributes = new Map(Object.entries(attributes));
                this.source = source;
                this.dataset = {};
                this.localName = 'script';
                this.parentNode = null;
                this.removed = false;
                this.textWrites = 0;
            }

            getAttribute(name) {
                return this.attributes.get(name) ?? null;
            }

            hasAttribute(name) {
                return this.attributes.has(name);
            }

            setAttribute(name, value) {
                this.attributes.set(name, String(value));
            }

            get src() {
                return this.getAttribute('src') ?? '';
            }

            set src(value) {
                this.setAttribute('src', value);
            }

            get textContent() {
                assert.equal(
                    this.hasAttribute('data-arcane-packaged-script'),
                    false,
                    'Packaged component scripts are never read as inline source.'
                );
                return this.source;
            }

            set textContent(value) {
                this.textWrites += 1;
                this.source = value;
            }

            remove() {
                this.removed = true;
                this.parentNode = null;
            }
        }

        class ImportElement extends EventTarget {
            constructor() {
                super();
                this.isConnected = false;
                this.attributes = new Map();
                this.trace = [];
                this.readyEvents = [];
                this.errorEvents = [];
                this.destroyCount = 0;
                instances.push(this);
                this.addEventListener('html-import-ready', function recordReady(event) {
                    this.readyEvents.push(event);
                });
                this.addEventListener('html-import-error', function recordError(event) {
                    this.errorEvents.push(event);
                });
            }

            getAttribute(name) {
                return this.attributes.get(name) ?? null;
            }

            setAttribute(name, value) {
                this.attributes.set(name, String(value));
            }

            attachShadow() {
                this.shadowRoot = {
                    content: null,
                    replaceChildren(content) {
                        this.content = content;
                    },
                    querySelectorAll(selector) {
                        return this.content.querySelectorAll(selector);
                    }
                };
                return this.shadowRoot;
            }
        }

        function createFragment(definition) {
            const scripts = definition.map(function createSourceScript(item) {
                return new ScriptElement(item.attributes, item.source);
            });
            const fragment = {
                removeChild(script) {
                    script.remove();
                },
                querySelectorAll(selector) {
                    if (selector === 'style') return [];
                    assert.ok(['script', '[href],[src]'].includes(selector));
                    return scripts.filter(function retainScript(script) {
                        return !script.removed
                            && (selector === 'script' || script.hasAttribute('src'));
                    });
                }
            };
            for (const script of scripts) script.parentNode = fragment;
            return fragment;
        }

        function executeScript(script, source) {
            const previous = document.currentScript;
            document.currentScript = script;
            try {
                Function(source)();
            } finally {
                document.currentScript = previous;
            }
        }

        function nextScript() {
            if (pendingAppends.length > 0) return Promise.resolve(pendingAppends.shift());
            const next = deferred();
            appendWaiters.push(next.resolve);
            return next.promise;
        }

        function runExternal(script, source) {
            assert.notEqual(script.src, '');
            assert.equal(script.textWrites, 0);
            executeScript(script, createHTMLImportScript(source));
            script.dispatchEvent(new Event('load'));
        }

        function registerFragment(name, definition) {
            const href = new URL(name, document.baseURI).href;
            fragments.set(href, definition);
            return href;
        }

        function packagedScript(src) {
            return {attributes: {src, 'data-arcane-packaged-script': ''}};
        }

        function createHost(href) {
            const host = new (customElements.get('html-import'))();
            host.setAttribute('href', href);
            host.isConnected = true;
            return host;
        }

        async function disconnect(host) {
            host.isConnected = false;
            await host.disconnectedCallback();
        }

        context.after(async function restoreFixture() {
            try {
                for (const instance of instances) await disconnect(instance);
            } finally {
                for (const [name, descriptor] of replacements) {
                    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                    else delete globalThis[name];
                }
            }
        });

        replaceGlobal('HTMLElement', ImportElement);
        replaceGlobal('customElements', {
            get(name) {
                return definitions.get(name);
            },
            define(name, constructor) {
                assert.equal(definitions.has(name), false);
                definitions.set(name, constructor);
            }
        });
        replaceGlobal(hostRegistryKey, hostRegistry);
        replaceGlobal('document', {
            baseURI: new URL('./packaged-components/', import.meta.url).href,
            currentScript: null,
            createElement(name) {
                if (name === 'script') return new ScriptElement();
                assert.equal(name, 'template');
                return {
                    content: null,
                    set innerHTML(value) {
                        assert.ok(fragments.has(value));
                        this.content = createFragment(fragments.get(value));
                    }
                };
            },
            head: {
                appendChild(script) {
                    script.parentNode = this;
                    appended.push(script);
                    if (script.src) {
                        const notify = appendWaiters.shift();
                        if (notify) notify(script);
                        else pendingAppends.push(script);
                    } else {
                        executeScript(script, script.textContent);
                    }
                    return script;
                }
            }
        });
        replaceGlobal('fetch', async function fetchComponent(url, options) {
            requests.push({url, options});
            assert.ok(
                fragments.has(url) || sources.has(url),
                `Only component HTML and unmarked script source may use fetch: ${url}`
            );
            return {
                ok: true,
                url,
                async text() {
                    return fragments.has(url) ? url : sources.get(url);
                }
            };
        });

        await import('../runtime/arcane/modules/HTMLImport.js?packaged-script-fixture');

        await context.test('script order awaits host initialization before readiness', async function orderedScripts() {
            const href = registerFragment('ordered.html', [
                packagedScript('./first.js'),
                packagedScript('./second.js')
            ]);
            const host = createHost(href);
            const gate = deferred();
            host.gate = gate.promise;
            const originalDestroy = function applicationDestroy() {};
            Object.defineProperty(host, 'destroy', {
                value: originalDestroy,
                writable: true,
                configurable: true,
                enumerable: false
            });
            const originalDescriptor = Object.getOwnPropertyDescriptor(host, 'destroy');
            const loading = host.connectedCallback();
            const first = await nextScript();
            assert.equal(first.src, new URL('./first.js', href).href);
            assert.equal(hostRegistry.get(first.dataset.arcaneHostToken).host, host);
            const body = 'this.trace.push("first"); await this.gate; this.trace.push("settled"); this.destroy = function importedDestroy() { this.destroyCount += 1; }; // Complete final comment';
            assert.ok(createHTMLImportScript(body).includes(body));
            runExternal(first, body);
            assert.deepEqual(host.trace, ['first']);
            assert.equal(host.ready, false);
            assert.equal(pendingAppends.length, 0);
            gate.resolve();
            const second = await nextScript();
            assert.equal(first.removed, true);
            assert.equal(first.dataset.arcaneHostToken, undefined);
            runExternal(second, 'this.trace.push("second");');
            await loading;
            assert.deepEqual(host.trace, ['first', 'settled', 'second']);
            assert.equal(host.ready, true);
            assert.equal(host.readyEvents.length, 1);
            assert.deepEqual(host.errorEvents, []);
            assert.equal(hostRegistry.size, 0);
            await disconnect(host);
            assert.equal(host.destroyCount, 1);
            assert.deepEqual(Object.getOwnPropertyDescriptor(host, 'destroy'), originalDescriptor);
        });

        await context.test('concurrent hosts have independent script bindings', async function concurrentHosts() {
            const href = registerFragment('concurrent.html', [packagedScript('./shared.js')]);
            const firstHost = createHost(href);
            const secondHost = createHost(href);
            const firstLoading = firstHost.connectedCallback();
            const secondLoading = secondHost.connectedCallback();
            const first = await nextScript();
            const second = await nextScript();
            assert.notEqual(first.dataset.arcaneHostToken, second.dataset.arcaneHostToken);
            assert.equal(first.src, second.src);
            runExternal(first, 'this.trace.push("shared");');
            runExternal(second, 'this.trace.push("shared");');
            await Promise.all([firstLoading, secondLoading]);
            assert.deepEqual(firstHost.trace, ['shared']);
            assert.deepEqual(secondHost.trace, ['shared']);
            assert.equal(firstHost.ready, true);
            assert.equal(secondHost.ready, true);
            assert.equal(hostRegistry.size, 0);
        });

        await context.test('disconnect cancels an unstarted external script', async function cancelBeforeExecution() {
            const href = registerFragment('cancel.html', [packagedScript('./delayed.js')]);
            const host = createHost(href);
            const loading = host.connectedCallback();
            const script = await nextScript();
            await disconnect(host);
            await loading;
            assert.equal(script.removed, true);
            assert.equal(script.dataset.arcaneHostToken, undefined);
            assert.equal(hostRegistry.size, 0);
            assert.equal(host.ready, false);
            assert.deepEqual(host.readyEvents, []);
            assert.deepEqual(host.errorEvents, []);
            assert.throws(function executeDetachedScript() {
                runExternal(script, 'this.trace.push("stale");');
            }, /host binding is unavailable/u);
            assert.deepEqual(host.trace, []);
        });

        await context.test('disconnect preserves teardown installed after async completion', async function cancelDuringExecution() {
            const href = registerFragment('cancel-running.html', [packagedScript('./running.js')]);
            const host = createHost(href);
            const gate = deferred();
            host.gate = gate.promise;
            const loading = host.connectedCallback();
            const script = await nextScript();
            runExternal(script, 'await this.gate; this.destroy = function delayedDestroy() { this.destroyCount += 1; };');
            host.isConnected = false;
            const disconnected = host.disconnectedCallback();
            gate.resolve();
            await Promise.all([loading, disconnected]);
            assert.equal(host.destroyCount, 1);
            assert.equal(Object.hasOwn(host, 'destroy'), false);
            assert.equal(host.ready, false);
            assert.deepEqual(host.readyEvents, []);
            assert.deepEqual(host.errorEvents, []);
            assert.equal(hostRegistry.size, 0);
        });

        await context.test('reconnection supersedes an older pending script', async function supersededGeneration() {
            const href = registerFragment('superseded.html', [packagedScript('./current.js')]);
            const host = createHost(href);
            const firstLoading = host.connectedCallback();
            const previous = await nextScript();
            const previousToken = previous.dataset.arcaneHostToken;
            const secondLoading = host.connectedCallback();
            const current = await nextScript();
            assert.equal(previous.removed, true);
            assert.equal(hostRegistry.has(previousToken), false);
            runExternal(current, 'this.trace.push("current");');
            await Promise.all([firstLoading, secondLoading]);
            assert.deepEqual(host.trace, ['current']);
            assert.equal(host.readyEvents.length, 1);
            assert.equal(host.ready, true);
            assert.equal(hostRegistry.size, 0);
        });

        await context.test('load and initializer failures publish errors and restore teardown', async function scriptFailures() {
            const href = registerFragment('failure.html', [packagedScript('./failure.js')]);
            const host = createHost(href);
            const failedLoad = host.connectedCallback();
            const missing = await nextScript();
            missing.dispatchEvent(new Event('error'));
            await failedLoad;
            assert.equal(host.ready, false);
            assert.equal(host.errorEvents.length, 1);
            assert.equal(host.errorEvents[0].detail.code, 'HTML_IMPORT_FAILED');
            assert.equal(missing.removed, true);
            assert.equal(hostRegistry.size, 0);

            const failedInitialization = host.connectedCallback();
            const rejected = await nextScript();
            runExternal(rejected, 'this.destroy = function rejectedDestroy() { this.destroyCount += 1; }; throw new Error("Fixture initialization failure");');
            await failedInitialization;
            assert.equal(host.errorEvents.length, 2);
            assert.equal(host.readyEvents.length, 0);
            assert.equal(host.destroyCount, 1);
            assert.equal(Object.hasOwn(host, 'destroy'), false);
            assert.equal(hostRegistry.size, 0);
        });

        await context.test('unmarked inline and fetched scripts keep their original execution path', async function ordinaryScripts() {
            const href = registerFragment('ordinary.html', [
                {attributes: {}, source: 'this.trace.push("inline");'},
                {attributes: {src: './ordinary.js'}, source: ''}
            ]);
            const scriptHref = new URL('./ordinary.js', href).href;
            sources.set(scriptHref, 'await Promise.resolve(); this.trace.push("fetched");');
            const host = createHost(href);
            const previousAppends = appended.length;
            await host.connectedCallback();
            assert.deepEqual(host.trace, ['inline', 'fetched']);
            assert.equal(host.ready, true);
            assert.equal(appended.length, previousAppends + 2);
            for (const script of appended.slice(previousAppends)) {
                assert.equal(script.src, '');
                assert.equal(script.textWrites, 1);
                assert.equal(script.removed, true);
            }
            assert.equal(requests.some(function requestedSource(request) {
                return request.url === scriptHref;
            }), true);
            assert.equal(hostRegistry.size, 0);
        });
    }
);

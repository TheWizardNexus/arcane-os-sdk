import assert from 'node:assert/strict';
import test from '../src/testing.mjs';

test(
    'HTMLImport URL variants share one usable registered element and its lifecycle',
    async function repeatedHTMLImportModuleURLs(context) {
        const definitions = new Map();
        const registeredConstructors = new Set();
        const definitionCalls = [];
        const requests = [];
        const instances = [];
        const readyEvents = [];
        const errorEvents = [];
        const html = '<p>Shared component content</p>';
        const hostRegistryKey = Symbol.for('arcane.html-import.hosts');
        const replacements = new Map();

        class RegistryHTMLElement extends EventTarget {
            constructor() {
                super();
                if (!registeredConstructors.has(new.target)) {
                    throw new TypeError('Illegal constructor: element is not registered.');
                }
                this.isConnected = false;
                this.attributes = new Map();
                this.shadowRoot = null;
                instances.push(this);
            }

            attachShadow({mode}) {
                this.shadowRoot = {
                    mode,
                    content: null,
                    replaceChildren(content) {
                        this.content = content;
                    },
                    querySelectorAll(selector) {
                        assert.equal(selector, 'script');
                        return [];
                    }
                };
                return this.shadowRoot;
            }

            getAttribute(name) {
                return this.attributes.get(name) ?? null;
            }

            setAttribute(name, value) {
                this.attributes.set(name, String(value));
            }
        }

        const registry = {
            get(name) {
                return definitions.get(name);
            },
            define(name, constructor) {
                definitionCalls.push({name, constructor});
                if (definitions.has(name) || registeredConstructors.has(constructor)) {
                    throw new DOMException(
                        'Custom element name or constructor is already registered.',
                        'NotSupportedError'
                    );
                }
                definitions.set(name, constructor);
                registeredConstructors.add(constructor);
            }
        };

        function replaceGlobal(name, value) {
            replacements.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
            Object.defineProperty(globalThis, name, {
                value,
                configurable: true,
                writable: true
            });
        }

        context.after(async function restoreHTMLImportFixture() {
            try {
                for (const instance of instances) {
                    instance.isConnected = false;
                    await instance.disconnectedCallback();
                }
            } finally {
                for (const [name, descriptor] of replacements) {
                    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                    else delete globalThis[name];
                }
            }
        });

        replaceGlobal('HTMLElement', RegistryHTMLElement);
        replaceGlobal('customElements', registry);
        replaceGlobal(hostRegistryKey, new Map());
        replaceGlobal('document', {
            baseURI: new URL('./components/', import.meta.url).href,
            createElement(name) {
                if (name === 'html-import') return new (registry.get(name))();
                assert.equal(name, 'template');
                // This fragment has no resource attributes, styles, or scripts.
                const content = {
                    html: '',
                    querySelectorAll(selector) {
                        assert.ok(['[href],[src]', 'style'].includes(selector));
                        return [];
                    }
                };
                return {
                    content,
                    set innerHTML(value) {
                        content.html = value;
                    }
                };
            }
        });
        replaceGlobal('fetch', async function fetchSyntheticComponent(url, options) {
            requests.push({url, options});
            return {
                ok: true,
                url,
                async text() {
                    return html;
                }
            };
        });

        const first = await import(new URL(
            '../runtime/arcane/modules/HTMLImport.js?arcaneVersion=0.7.3',
            import.meta.url
        ));
        const existing = document.createElement('html-import');
        const second = await import(new URL(
            '../runtime/arcane/modules/HTMLImport.js?v=6&arcaneVersion=0.7.3',
            import.meta.url
        ));
        const third = await import(new URL(
            '../runtime/arcane/modules/HTMLImport.js?arcaneVersion=0.8.1&v=6',
            import.meta.url
        ));

        assert.equal(definitionCalls.length, 1);
        assert.equal(definitionCalls[0].name, 'html-import');
        assert.equal(first.default, registry.get('html-import'));
        assert.equal(second.default, first.default);
        assert.equal(third.default, first.default);
        assert.ok(existing instanceof third.default);

        const imported = new third.default();
        assert.ok(imported instanceof first.default);
        assert.equal(imported.shadowRoot.mode, 'open');
        assert.equal(imported.ready, false);
        const componentHref = './component.html?v=6&mode=a%20b&arcaneVersion=&arcaneVersion=old#part';
        imported.setAttribute('href', componentHref);
        imported.addEventListener('html-import-ready', function recordReady(event) {
            readyEvents.push(event);
        });
        imported.addEventListener('html-import-error', function recordError(event) {
            errorEvents.push(event);
        });

        imported.isConnected = true;
        await imported.connectedCallback();
        assert.equal(imported.ready, true);
        assert.equal(imported.shadowRoot.content.html, html);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, new URL(
            './component.html?mode=a%20b&arcaneVersion=0.7.3#part',
            document.baseURI
        ).href);
        assert.equal(requests[0].options.method, 'GET');
        assert.equal(requests[0].options.cache, 'default');
        assert.equal(requests[0].options.signal.aborted, false);
        assert.equal(readyEvents.length, 1);
        assert.equal(readyEvents[0].detail.href, componentHref);
        assert.equal(readyEvents[0].bubbles, true);
        assert.equal(readyEvents[0].composed, true);
        assert.deepEqual(errorEvents, []);

        imported.isConnected = false;
        await imported.disconnectedCallback();
        assert.equal(imported.ready, false);
        imported.isConnected = true;
        await imported.connectedCallback();
        assert.equal(imported.ready, true);
        assert.equal(requests.length, 2);
        assert.equal(readyEvents.length, 2);
        assert.notEqual(readyEvents[0].detail.instanceId, readyEvents[1].detail.instanceId);
        assert.deepEqual(errorEvents, []);
        assert.equal(definitionCalls.length, 1);
    }
);

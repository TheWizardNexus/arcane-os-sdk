import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from '../src/testing.mjs';
import Is from '../browser-runtime/dependencies/strong-type/index.js';
import waitForComponent from '../runtime/arcane/modules/WaitForComponent.js';

class FixtureElement extends EventTarget {
    constructor(localName = 'div') {
        super();
        this.localName = localName;
        this.children = [];
        this.dataset = {};
        this.attributes = new Map();
        this.isConnected = true;
        this.focusCount = 0;
        this.classList = {
            toggle() {},
            add() {}
        };
    }

    append(...children) {
        this.children.push(...children);
    }

    replaceChildren(...children) {
        this.children = children;
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }

    hasAttribute(name) {
        return this.attributes.has(name);
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    toggleAttribute(name, enabled) {
        if (enabled) {
            this.setAttribute(name, '');
        } else {
            this.removeAttribute(name);
        }
    }

    focus() {
        this.focusCount += 1;
    }

    querySelector() {
        return null;
    }

    assignedNodes() {
        return [];
    }

    showModal() {
        this.open = true;
    }

    close() {
        this.open = false;
    }

    remove() {
        this.isConnected = false;
    }
}

async function runComponent(name, host, document, dependencies, window = {}) {
    const source = await readFile(
        new URL(`../runtime/arcane/components/${name}.html`, import.meta.url),
        'utf8'
    );
    const script = source.match(/<script type="module">(?<script>[\s\S]*?)<\/script>/u).groups.script;
    const AsyncFunction = Object.getPrototypeOf(
        async function componentScript() {}
    ).constructor;
    const initialize = new AsyncFunction(
        'loadDependency', 'document', 'window', 'Node', 'HTMLElement',
        script.replaceAll('import(', 'loadDependency(')
    );

    async function loadDependency(specifier) {
        if (specifier === 'strong-type') {
            return {default: Is};
        }
        if (specifier === 'arcane-os/event-manager') {
            return {
                createArcaneEventSource() {
                    return {
                        dispatch(type, detail) {
                            return {occurrence: {type, detail}};
                        },
                        dispose() {}
                    };
                },
                projectArcaneDOMEvent(target, occurrence) {
                    return target.dispatchEvent(
                        new Event(occurrence.type)
                    );
                }
            };
        }
        if (Object.hasOwn(dependencies, specifier)) {
            return dependencies[specifier];
        }
        throw new Error(`Unexpected close fixture dependency: ${specifier}`);
    }

    await initialize.call(host, loadDependency, document, window, FixtureElement, FixtureElement);
}

async function dataViewFixture(options = {}) {
    const order = [];
    const errors = [];
    const waits = [];
    const managerCreated = Promise.withResolvers();
    const host = new FixtureElement('html-import');
    const button = new FixtureElement('button');
    const modal = new FixtureElement('html-import');
    modal.ready = options.modalReady !== false;
    modal.opened = false;
    modal.populate = async function populateData(content) {
        modal.replaceChildren(content);
    };
    modal.open = async function openDataModal() {
        modal.opened = true;
        return true;
    };
    modal.close = async function closeDataModal() {
        order.push('parent');
        if (options.keepParentOpen) {
            return true;
        }
        const wasOpen = modal.opened;
        modal.opened = false;
        if (wasOpen) {
            modal.dispatchEvent(
                new Event('modal-closed')
            );
        }
        return true;
    };
    modal.destroy = function destroyDataModal() {
        modal.opened = false;
    };
    host.setAttribute('href', './arcane/components/data-view.html');
    host.beforeOpen = options.beforeOpen;
    host.shadowRoot = {
        querySelector(selector) {
            return selector === '#openData' ? button : modal;
        }
    };
    const document = {
        baseURI: 'https://close.example/',
        createElement(name) {
            const element = new FixtureElement(name);
            if (name === 'html-import') {
                element.ready = options.managerReady !== false;
                element.loadAll = async function reloadData() {
                    order.push('reload');
                    await options.reload?.();
                };
                element.close = async function closeChildPreview() {
                    order.push('child');
                    await options.closeChild?.();
                    return options.childCloseResult !== false;
                };
                element.destroy = function destroyFileManager() {
                    element.destroyed = true;
                };
                managerCreated.resolve(element);
            }
            return element;
        }
    };
    await runComponent(
        'data-view', host, document,
        {
            '../modules/WaitForComponent.js': {
                default(component, configuration) {
                    waits.push(configuration);
                    return waitForComponent(component, configuration);
                }
            },
            'arcane-os/logging': {
                arcaneLogging: {
                    error(...details) {
                        errors.push(details);
                    }
                }
            }
        }
    );
    return {host, modal, order, errors, waits, managerCreated};
}

test(
    'data-view closes its child before its parent and remains reusable',
    async function closeAndReopenHistory(context) {
        const childRelease = Promise.withResolvers();
        const fixture = await dataViewFixture(
            {closeChild: function waitForChildCleanup() {return childRelease.promise;}}
        );
        context.after(function destroyFixture() {fixture.host.destroy();});
        assert.equal(await fixture.host.open(), true);
        const manager = await fixture.managerCreated.promise;
        const closing = fixture.host.close();
        assert.deepEqual(fixture.order, ['child']);
        assert.equal(fixture.modal.opened, true);
        childRelease.resolve();
        assert.equal(await closing, true);
        assert.deepEqual(fixture.order, ['child', 'parent']);
        assert.equal(manager.destroyed, undefined);
        assert.equal(await fixture.host.open(), true);
        assert.equal(fixture.modal.opened, true);
        assert.deepEqual(fixture.order, ['child', 'parent', 'reload']);
        assert.equal(await fixture.host.close(), true);
        assert.equal(await fixture.host.close(), true);
    }
);

test(
    'closing history aborts its pending component wait without destroying the child',
    async function abortPendingReadiness(context) {
        const fixture = await dataViewFixture(
            {managerReady: false}
        );
        context.after(function destroyFixture() {fixture.host.destroy();});
        const opening = fixture.host.open();
        const manager = await fixture.managerCreated.promise;
        await Promise.resolve();
        const signal = fixture.waits.at(-1).signal;
        assert.equal(await fixture.host.close(), true);
        assert.equal(signal.aborted, true);
        assert.equal(await opening, false);
        assert.equal(manager.destroyed, undefined);
        manager.ready = true;
        manager.dispatchEvent(
            new Event('file-manager-ready')
        );
        assert.equal(fixture.modal.opened, false);
        assert.equal(await fixture.host.open(), true);
        assert.deepEqual(fixture.errors, []);
    }
);

test(
    'closing history prevents delayed beforeOpen and reload results from reopening it',
    async function ignoreLatePresentation(context) {
        for (const phase of ['beforeOpen', 'reload']) {
            const entered = Promise.withResolvers();
            const finish = Promise.withResolvers();
            let delayed = phase === 'beforeOpen';
            async function delayedOperation() {
                if (delayed) {
                    entered.resolve();
                    await finish.promise;
                }
            }
            const fixture = await dataViewFixture(
                {[phase]: delayedOperation}
            );
            context.after(function destroyFixture() {fixture.host.destroy();});
            if (phase === 'reload') {
                assert.equal(await fixture.host.open(), true);
                await fixture.host.close();
                delayed = true;
            }
            const opening = fixture.host.open();
            await entered.promise;
            assert.equal(await fixture.host.close(), true);
            finish.resolve();
            assert.equal(await opening, false);
            assert.equal(fixture.modal.opened, false);
        }
    }
);

test(
    'history close reports refused and failed closure honestly',
    async function retainUnclosedHistory(context) {
        const failure = new Error('Child cleanup failed.');
        for (const options of [
            {childCloseResult: false},
            {closeChild: async function failChildClosure() {throw failure;}},
            {keepParentOpen: true}
        ]) {
            const fixture = await dataViewFixture(options);
            context.after(function destroyFixture() {fixture.host.destroy();});
            await fixture.host.open();
            const firstClose = fixture.host.close();
            const concurrentClose = fixture.host.close();
            assert.equal(await firstClose, false);
            assert.equal(await concurrentClose, false);
            assert.equal(fixture.modal.opened, true);
            if (options.closeChild) {
                assert.equal(fixture.errors[0][1], failure);
            }
            fixture.host.destroy();
            assert.equal(await fixture.host.close(), false);
            assert.equal(await fixture.host.open(), false);
        }
    }
);

test(
    'modal restores a nested shadow opener and does not steal focus on immediate reopen',
    async function restoreDeepOpener(context) {
        const host = new FixtureElement('html-import');
        const openerHost = new FixtureElement('html-import');
        const nestedHost = new FixtureElement('html-import');
        const opener = new FixtureElement('button');
        openerHost.shadowRoot = {activeElement: nestedHost};
        nestedHost.shadowRoot = {activeElement: opener};
        const document = {
            activeElement: openerHost,
            createElement(name) {return new FixtureElement(name);}
        };
        const elements = new Map();
        for (const name of ['modal', 'modal-content', 'modal-search', 'close', 'header-slot', 'footer-slot']) {
            const element = new FixtureElement();
            element.parentElement = new FixtureElement();
            elements.set(`#${name}`, element);
        }
        host.shadowRoot = {
            querySelector(selector) {return elements.get(selector);}
        };
        await runComponent(
            'modal', host, document,
            {'arcane-os/logging': {arcaneLogging: {error() {}}}}
        );
        context.after(function destroyFixture() {host.destroy();});
        await host.open();
        await host.close();
        assert.equal(opener.focusCount, 1);
        assert.equal(openerHost.focusCount, 0);
        await host.open();
        const closing = host.close();
        const reopening = host.open();
        await closing;
        await reopening;
        assert.equal(opener.focusCount, 1);
    }
);

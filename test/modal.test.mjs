import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from '../src/testing.mjs';
import Is from '../browser-runtime/dependencies/strong-type/index.js';

// The real component script runs against controlled DOM and event dependencies.
// These cases exercise its public state transitions without native dialog rendering.
async function modalFixture(context) {
    const document = {activeElement: null};
    const shadowRoot = {activeElement: null};
    const publications = [];
    const errors = [];
    let eventSourceDisposed = false;

    class FakeElement extends EventTarget {
        constructor(tagName = 'div') {
            super();
            this.tagName = tagName;
            this.children = [];
            this.dataset = {};
            this.attributes = new Map();
            this.classes = new Set();
            this.open = false;
            this.isConnected = true;
            this.focusable = false;
            const classes = this.classes;
            const element = this;
            this.classList = {
                add(value) {
                    classes.add(value);
                },
                remove(value) {
                    classes.delete(value);
                },
                contains(value) {
                    return classes.has(value);
                },
                toggle(value, enabled) {
                    if (enabled) classes.add(value);
                    else classes.delete(value);
                    if (value === 'hidden' && enabled && document.activeElement === element) {
                        document.activeElement = null;
                        shadowRoot.activeElement = null;
                    }
                }
            };
        }

        setAttribute(name, value) {
            this.attributes.set(name, value);
        }

        hasAttribute(name) {
            return this.attributes.has(name);
        }

        removeAttribute(name) {
            this.attributes.delete(name);
        }

        replaceChildren(...children) {
            this.children = children;
        }

        append(...children) {
            this.children.push(...children);
        }

        querySelector(selector) {
            if (selector === 'h1,h2,h3') {
                return this.children.find(
                    function findHeading(child) {
                        return ['h1', 'h2', 'h3'].includes(child.tagName);
                    }
                ) ?? null;
            }
            return this.children.find(
                function findFocusable(child) {
                    return child.focusable;
                }
            ) ?? null;
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

        getBoundingClientRect() {
            return {left: 10, right: 100, top: 10, bottom: 100};
        }

        focus() {
            document.activeElement = this;
            shadowRoot.activeElement = this;
        }

        remove() {
            this.isConnected = false;
        }
    }

    const elements = new Map();
    for (const id of ['modal', 'modal-content', 'modal-search', 'close', 'header-slot', 'footer-slot']) {
        elements.set(
            `#${id}`,
            new FakeElement()
        );
    }
    for (const id of ['header-slot', 'footer-slot']) {
        elements.get(`#${id}`).parentElement = new FakeElement();
    }
    shadowRoot.querySelector = function findComponentElement(selector) {
        return elements.get(selector);
    };
    document.createElement = function createElement(tagName) {
        return new FakeElement(tagName);
    };
    const originalFocus = new FakeElement('button');
    document.activeElement = originalFocus;
    const host = new FakeElement('html-import');
    host.shadowRoot = shadowRoot;
    const window = {};

    async function loadDependency(specifier) {
        if (specifier === 'strong-type') return {default: Is};
        if (specifier === 'arcane-os/logging') {
            return {
                arcaneLogging: {
                    error(...values) {
                        errors.push(values);
                    }
                }
            };
        }
        if (specifier === 'arcane-os/event-manager') {
            return {
                createArcaneEventSource() {
                    return {
                        dispatch(type, detail, options) {
                            return {occurrence: {type, detail, ...options}};
                        },
                        dispose() {
                            eventSourceDisposed = true;
                        }
                    };
                },
                projectArcaneDOMEvent(_target, occurrence) {
                    publications.push(occurrence);
                    return true;
                }
            };
        }
        throw new Error(`Unknown modal dependency: ${specifier}`);
    }

    const source = await readFile(
        new URL('../runtime/arcane/components/modal.html', import.meta.url),
        'utf8'
    );
    const script = source.match(/<script type="module">(?<script>[\s\S]*?)<\/script>/u).groups.script;
    const AsyncFunction = Object.getPrototypeOf(
        async function componentScript() {}
    ).constructor;
    const initialize = new AsyncFunction(
        'loadDependency', 'window', 'document', 'Node', 'HTMLElement',
        script.replaceAll('await import(', 'await loadDependency(')
    );
    await initialize.call(host, loadDependency, window, document, FakeElement, FakeElement);
    context.after(
        function disposeFixtureModal() {
            host.destroy();
        }
    );

    return {
        host,
        dialog: elements.get('#modal'),
        closeButton: elements.get('#close'),
        content: elements.get('#modal-content'),
        document,
        originalFocus,
        window,
        publications,
        errors,
        get eventSourceDisposed() {
            return eventSourceDisposed;
        }
    };
}

function dismissThroughCancel(fixture) {
    const event = new Event(
        'cancel',
        {cancelable: true}
    );
    fixture.dialog.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
}

function dismissThroughBackdrop(fixture) {
    const event = new Event('click');
    Object.assign(
        event,
        {clientX: 0, clientY: 0}
    );
    fixture.dialog.dispatchEvent(event);
}

function dismissThroughCloseButton(fixture) {
    fixture.closeButton.dispatchEvent(
        new Event('click')
    );
}

const dismissalGestures = [dismissThroughCancel, dismissThroughBackdrop, dismissThroughCloseButton];

test(
    'modal retains default dismissal and configured owner-only closure through population and reopen',
    async function exerciseModalDismissibility(context) {
        const fixture = await modalFixture(context);
        const {host, closeButton, content, document, originalFocus, window} = fixture;
        assert.deepEqual(
            host.configure(),
            {dismissible: true}
        );

        for (const dismiss of dismissalGestures) {
            await host.open();
            assert.equal(document.activeElement, closeButton);
            dismiss(fixture);
            assert.equal(host.opened, false, `${dismiss.name} preserves the default`);
            await Promise.resolve();
            assert.equal(document.activeElement, originalFocus);
        }

        await host.open();
        assert.deepEqual(
            host.configure(
                {dismissible: false}
            ),
            {dismissible: false}
        );
        assert.equal(document.activeElement, content, 'hiding the focused close button moves focus to content');
        assert.equal(
            closeButton.classList.contains('hidden'),
            true
        );
        assert.deepEqual(
            host.configure(),
            {dismissible: false}
        );
        for (const dismiss of dismissalGestures) {
            dismiss(fixture);
            assert.equal(host.opened, true, `${dismiss.name} respects owner-only dismissal`);
        }

        const html = '<p>The moon exploded. Wait for mission control.</p>';
        await host.populate(html);
        assert.equal(content.innerHTML, html);
        assert.equal(
            closeButton.classList.contains('hidden'),
            true
        );
        assert.equal(
            await host.close(),
            true
        );
        assert.equal(host.opened, false);
        assert.deepEqual(
            window.modalStack,
            []
        );
        await host.open();
        assert.equal(document.activeElement, content);
        assert.equal(
            closeButton.classList.contains('hidden'),
            true
        );
        assert.deepEqual(
            host.configure(
                {dismissible: true}
            ),
            {dismissible: true}
        );
        assert.equal(
            closeButton.classList.contains('hidden'),
            false
        );
        dismissThroughCancel(fixture);
        assert.equal(host.opened, false);

        host.configure(
            {dismissible: false}
        );
        await host.open();
        assert.equal(
            host.destroy(),
            true
        );
        assert.equal(host.opened, false);
        assert.equal(host.isConnected, false);
        assert.equal(fixture.eventSourceDisposed, true);
        assert.deepEqual(
            window.modalStack,
            []
        );
        assert.equal(
            host.configure(
                {dismissible: true}
            ),
            false
        );

        const once = await modalFixture(context);
        const resolutionButton = once.document.createElement('button');
        resolutionButton.focusable = true;
        once.host.setAttribute('data-once', '');
        once.host.configure(
            {dismissible: false}
        );
        await once.host.populate(resolutionButton);
        assert.strictEqual(once.content.children[0], resolutionButton);
        await once.host.open();
        assert.equal(once.document.activeElement, resolutionButton);
        await once.host.close();
        assert.equal(once.host.isConnected, false, 'data-once owner closure still disposes the component');
        assert.equal(once.eventSourceDisposed, true);
    }
);

test(
    'modal task completion preserves dismissibility, task results, and explicit running closure',
    async function exerciseModalTaskSettlement(context) {
        for (const dismissible of [true, false]) {
            const fixture = await modalFixture(context);
            const {host, closeButton, content} = fixture;
            host.configure(
                {dismissible}
            );
            let resolveTask;
            const task = new Promise(
                function retainTaskCompletion(resolve) {
                    resolveTask = resolve;
                }
            );
            const result = {status: 'moon reassembled'};
            const pending = host.runTasks(
                'Reassemble the moon',
                [
                    {
                        name: 'Gather moon fragments',
                        task: function collectFragments() {
                            return task;
                        }
                    }
                ]
            );
            assert.equal(host.running, true);
            assert.equal(
                closeButton.classList.contains('hidden'),
                true
            );
            await host.close();
            assert.equal(host.opened, true, 'running task guard remains in effect');
            for (const dismiss of dismissalGestures) {
                dismiss(fixture);
                assert.equal(host.opened, true);
            }
            await host.close(undefined, true);
            assert.equal(host.opened, false, 'explicit forced owner close remains available');
            resolveTask(result);
            const results = await pending;
            assert.strictEqual(results[0].value, result);
            assert.equal(host.running, false);
            assert.equal(
                closeButton.classList.contains('hidden'),
                !dismissible
            );
            assert.equal(
                content.children[1].innerText.includes('You may close'),
                dismissible
            );

            const failure = new Error('The moon fragments escaped.');
            const failed = await host.runTasks(
                'Recover moon fragments',
                [
                    {
                        name: 'Recover fragments',
                        task: function rejectRecovery() {
                            throw failure;
                        }
                    }
                ]
            );
            assert.strictEqual(failed[0].reason, failure);
            assert.strictEqual(fixture.errors[0][1], failure);
            assert.equal(
                closeButton.classList.contains('hidden'),
                !dismissible
            );
            assert.equal(
                content.children[1].innerText.includes('You may close'),
                dismissible
            );
            assert.equal(
                await host.close(),
                true
            );
            assert.equal(host.opened, false);
        }
    }
);

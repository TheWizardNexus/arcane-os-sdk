/**
 * Runs inside the existing app document. The native host serializes this named
 * function with toString(), so all helpers must remain inside its lexical scope.
 *
 * inspect({selector?}) reads the top-level light DOM. Omission selects the whole
 * document; a CSS selector may select any number of roots. HTML, textContent,
 * attributes and live control state are returned completely. Frame documents
 * and shadow-root contents are outside this CSS scope; frame elements and open
 * shadow hosts are identified only. Closed shadow roots cannot be discovered.
 * domRole/domName are DOM-derived hints, not an accessibility-tree computation.
 *
 * act({action,selector,...}) requires one current CSS match. fill uses an exact
 * string value; select uses either value:string or values:string[]. scroll uses
 * absolute left/top CSS-pixel offsets, preserving any omitted axis. Actions use
 * DOM APIs and untrusted events without focus or desktop input. Results describe
 * immediate DOM state, including any browser value sanitization or scroll
 * clamping, not completion of asynchronous application work.
 *
 * The native host owns document-generation checks, scheduling and cancellation.
 * This function retains no state, retries no action and returns a JSON envelope
 * because ExecuteScriptAsync otherwise loses uncaught JavaScript exceptions.
 */
export function runAppControl(operation, params = {}) {
    let actionAttempted = false;
    const eventsDispatched = [];

    try {
        if (params === null || typeof params !== 'object' || Array.isArray(params)) {
            fail('INVALID_ARGUMENT', 'App-control parameters must be an object.');
        }
        if (operation === 'inspect') {
            return {ok: true, result: inspectDocument()};
        }
        if (operation === 'act') {
            return {ok: true, result: actOnElement()};
        }
        fail('INVALID_ARGUMENT', 'Expected the inspect or act operation.');
    } catch (error) {
        return {
            ok: false,
            error: {
                name: error?.name ?? 'Error',
                message: error?.message ?? String(error),
                stack: error?.stack ?? null,
                code: error?.code ?? 'ARCANE_APP_CONTROL_FAILED',
                details: error?.details ?? null,
                actionAttempted,
                eventsDispatched
            }
        };
    }

    function fail(code, message, details = null) {
        const error = new Error(message);
        error.code = code;
        error.details = details;
        throw error;
    }

    function queryElements(selector) {
        if (typeof selector !== 'string') {
            fail('INVALID_ARGUMENT', 'selector must be a CSS selector string.');
        }
        return Array.from(document.querySelectorAll(selector));
    }

    function inspectDocument() {
        const roots = params.selector === undefined
            ? (document.documentElement ? [document.documentElement] : [])
            : queryElements(params.selector);
        const rootSet = new Set(roots);
        const elements = Array.from(document.querySelectorAll('*'));
        const idCounts = new Map();
        const childCounts = new Map();
        const childIndexes = new Map();
        const scope = new Set();
        const selectors = new Map();
        const controls = [];
        const frames = [];
        const shadowHosts = [];

        // One traversal establishes selector paths and scope for all records.
        for (const element of elements) {
            if (element.id) {
                idCounts.set(element.id, (idCounts.get(element.id) ?? 0) + 1);
            }
            const parent = element.parentElement;
            const index = (childCounts.get(parent) ?? 0) + 1;
            childCounts.set(parent, index);
            childIndexes.set(element, index);
            if (rootSet.has(element) || scope.has(parent)) {
                scope.add(element);
            }
        }

        for (const element of elements) {
            if (!scope.has(element)) continue;
            if (element.matches('input,textarea,select,button,option,optgroup,fieldset,output,progress,meter,details,summary,a[href],area[href],audio,video,[contenteditable],[role],[tabindex]')) {
                controls.push(describeElement(element, uniqueSelector(element)));
            }
            if (element.localName === 'iframe' || element.localName === 'frame') {
                frames.push(describeElement(element, uniqueSelector(element)));
            }
            if (element.shadowRoot) {
                shadowHosts.push(
                    {
                        selector: uniqueSelector(element),
                        mode: element.shadowRoot.mode
                    }
                );
            }
        }

        return {
            scope: 'top-level-light-dom',
            title: document.title,
            readyState: document.readyState,
            doctype: document.doctype
                ? new XMLSerializer().serializeToString(document.doctype)
                : null,
            roots: roots.map(describeRoot),
            controls,
            frames,
            shadowHosts,
            activeElement: document.activeElement
                ? describeElement(document.activeElement, uniqueSelector(document.activeElement))
                : null,
            scrollingElement: document.scrollingElement
                ? uniqueSelector(document.scrollingElement)
                : null,
            selection: {text: document.getSelection()?.toString() ?? ''}
        };

        function describeRoot(element) {
            return {
                selector: uniqueSelector(element),
                html: element.outerHTML,
                text: element.textContent,
                state: readState(element)
            };
        }

        function uniqueSelector(element) {
            if (!element.isConnected || element.getRootNode() !== document) return null;
            const path = [];
            let current = element;
            let prefix = '';
            while (current) {
                if (selectors.has(current)) {
                    prefix = selectors.get(current);
                    break;
                }
                if (current.id && !current.id.includes('\0') && idCounts.get(current.id) === 1) {
                    prefix = `#${CSS.escape(current.id)}`;
                    selectors.set(current, prefix);
                    break;
                }
                path.push(current);
                current = current.parentElement;
            }
            for (let index = path.length - 1; index >= 0; index -= 1) {
                const part = path[index];
                const segment = `*:nth-child(${childIndexes.get(part)})`;
                prefix = prefix ? `${prefix} > ${segment}` : ':root';
                selectors.set(part, prefix);
            }
            return prefix;
        }
    }

    function describeElement(element, selector) {
        const attributeEntries = [];
        for (const attribute of element.attributes) {
            attributeEntries.push(
                [attribute.name, attribute.value]
            );
        }
        return {
            selector,
            tagName: element.localName,
            attributes: Object.fromEntries(attributeEntries),
            domRole: element.getAttribute('role'),
            domName: readDOMName(element),
            state: readState(element)
        };
    }

    function readDOMName(element) {
        const labelledBy = element.getAttribute('aria-labelledby');
        if (labelledBy) {
            const labels = [];
            for (const id of labelledBy.split(/\s+/u)) {
                const label = document.getElementById(id);
                if (label) labels.push(label.textContent);
            }
            if (labels.length) return {source: 'aria-labelledby', value: labels.join(' ')};
        }
        if (element.hasAttribute('aria-label')) {
            return {source: 'aria-label', value: element.getAttribute('aria-label')};
        }
        if (element.labels?.length) {
            const labels = [];
            for (const label of element.labels) labels.push(label.textContent);
            return {source: 'labels', value: labels.join(' ')};
        }
        if (element.hasAttribute('alt')) {
            return {source: 'alt', value: element.getAttribute('alt')};
        }
        if (element.localName === 'input' && ['button', 'submit', 'reset'].includes(element.type)) {
            return {source: 'value', value: element.value};
        }
        return {source: 'textContent', value: element.textContent};
    }

    function readState(element) {
        const state = {
            connected: element.isConnected,
            contentEditable: element.isContentEditable === true,
            effectivelyDisabled: element.matches(':disabled'),
            scrollLeft: element.scrollLeft,
            scrollTop: element.scrollTop,
            scrollWidth: element.scrollWidth,
            scrollHeight: element.scrollHeight,
            clientWidth: element.clientWidth,
            clientHeight: element.clientHeight
        };
        for (const field of [
            'value', 'type', 'checked', 'indeterminate', 'disabled', 'readOnly',
            'required', 'multiple', 'selected', 'selectedIndex', 'hidden', 'open',
            'tabIndex', 'selectionStart', 'selectionEnd', 'selectionDirection',
            'willValidate', 'validationMessage', 'paused', 'ended', 'currentTime',
            'muted', 'volume', 'playbackRate'
        ]) {
            const value = element[field];
            if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) {
                state[field] = value;
            }
        }
        if (element.isContentEditable) state.editableText = element.textContent;
        if (element.validity) {
            state.validity = {};
            for (const field of [
                'badInput', 'customError', 'patternMismatch', 'rangeOverflow',
                'rangeUnderflow', 'stepMismatch', 'tooLong', 'tooShort',
                'typeMismatch', 'valid', 'valueMissing'
            ]) {
                state.validity[field] = element.validity[field];
            }
        }
        if (element.localName === 'select') {
            state.options = [];
            for (const option of element.options) {
                state.options.push(
                    {
                        value: option.value,
                        text: option.text,
                        label: option.label,
                        selected: option.selected,
                        disabled: option.disabled,
                        effectivelyDisabled: option.matches(':disabled')
                    }
                );
            }
        }
        if (element.localName === 'input' && element.type === 'file') {
            state.files = [];
            for (const file of element.files) {
                state.files.push(
                    {name: file.name, type: file.type, lastModified: file.lastModified}
                );
            }
        }
        return state;
    }

    function actOnElement() {
        const targets = queryElements(params.selector);
        if (targets.length !== 1) {
            fail(
                'ARCANE_APP_CONTROL_TARGET_COUNT',
                'An action requires exactly one matching element.',
                {matches: targets.length}
            );
        }
        const target = targets[0];
        const action = params.action;
        if (!['click', 'fill', 'select', 'scroll'].includes(action)) {
            fail('INVALID_ARGUMENT', 'Expected a click, fill, select or scroll action.');
        }
        if (action !== 'scroll' && target.matches(':disabled')) {
            fail('ARCANE_APP_CONTROL_DISABLED', 'The selected control is disabled.');
        }

        let method;
        if (action === 'click') {
            if (typeof target.click !== 'function') {
                fail('ARCANE_APP_CONTROL_UNSUPPORTED', 'The selected element does not provide a DOM click method.');
            }
            actionAttempted = true;
            target.click();
            method = 'click';
        } else if (action === 'fill') {
            fillElement(target);
            method = 'fill';
        } else if (action === 'select') {
            selectOptions(target);
            method = 'select';
        } else {
            if (params.left === undefined && params.top === undefined) {
                fail('INVALID_ARGUMENT', 'scroll requires left, top or both absolute offsets.');
            }
            for (const field of ['left', 'top']) {
                if (params[field] !== undefined && (typeof params[field] !== 'number' || !Number.isFinite(params[field]))) {
                    fail('INVALID_ARGUMENT', `${field} must be a finite number.`);
                }
            }
            actionAttempted = true;
            target.scrollTo(
                {
                    left: params.left === undefined ? target.scrollLeft : params.left,
                    top: params.top === undefined ? target.scrollTop : params.top,
                    behavior: 'instant'
                }
            );
            method = 'scrollTo';
        }
        return {
            action,
            method,
            invoked: true,
            eventsDispatched,
            target: describeElement(target, params.selector)
        };
    }

    function fillElement(target) {
        if (typeof params.value !== 'string') {
            fail('INVALID_ARGUMENT', 'fill requires an exact string value.');
        }
        if (target.readOnly) fail('ARCANE_APP_CONTROL_READ_ONLY', 'The selected control is read-only.');
        let prototype;
        if (target.localName === 'textarea') {
            prototype = HTMLTextAreaElement.prototype;
        } else if (target.localName === 'input') {
            if (['file', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image'].includes(target.type)) {
                fail('ARCANE_APP_CONTROL_UNSUPPORTED', 'The selected input type does not support filling text.');
            }
            prototype = HTMLInputElement.prototype;
        } else if (!target.isContentEditable) {
            fail('ARCANE_APP_CONTROL_UNSUPPORTED', 'fill requires an input, textarea or contenteditable element.');
        }

        actionAttempted = true;
        if (prototype) {
            Object.getOwnPropertyDescriptor(prototype, 'value').set.call(target, params.value);
        } else {
            Object.getOwnPropertyDescriptor(Node.prototype, 'textContent').set.call(target, params.value);
        }
        dispatchInputAndChange(target, params.value, true);
    }

    function selectOptions(target) {
        if (target.localName !== 'select') {
            fail('ARCANE_APP_CONTROL_UNSUPPORTED', 'select requires a native select element.');
        }
        if ((params.value === undefined) === (params.values === undefined)) {
            fail('INVALID_ARGUMENT', 'select requires either value or values.');
        }
        const values = params.values === undefined ? [params.value] : params.values;
        if (!Array.isArray(values)) fail('INVALID_ARGUMENT', 'values must be an array of exact strings.');
        for (const value of values) {
            if (typeof value !== 'string') fail('INVALID_ARGUMENT', 'Every selected value must be an exact string.');
        }
        if (!target.multiple && values.length > 1) {
            fail('INVALID_ARGUMENT', 'A single-select control accepts at most one selected value.');
        }
        const optionsByValue = new Map();
        for (const option of target.options) {
            if (!optionsByValue.has(option.value)) {
                optionsByValue.set(
                    option.value,
                    []
                );
            }
            optionsByValue.get(option.value).push(option);
        }
        const selectedOptions = new Set();
        for (const value of values) {
            const options = optionsByValue.get(value);
            if (!options) {
                fail(
                    'ARCANE_APP_CONTROL_OPTION_MISSING',
                    'No option has the requested value.',
                    {value}
                );
            }
            for (const option of options) {
                if (option.matches(':disabled')) {
                    fail(
                        'ARCANE_APP_CONTROL_DISABLED',
                        'A requested option is disabled.',
                        {value}
                    );
                }
                selectedOptions.add(option);
                if (!target.multiple) break;
            }
        }
        actionAttempted = true;
        const setter = Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, 'selected').set;
        for (const option of target.options) {
            setter.call(option, selectedOptions.has(option));
        }
        if (selectedOptions.size === 0) {
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex').set.call(target, -1);
        }
        dispatchInputAndChange(target, null, false);
    }

    function dispatchInputAndChange(target, data, textInput) {
        const input = textInput
            ? new InputEvent(
                'input',
                {bubbles: true, composed: true, inputType: 'insertReplacementText', data}
            )
            : new Event(
                'input',
                {bubbles: true, composed: true}
            );
        target.dispatchEvent(input);
        eventsDispatched.push('input');
        const change = new Event(
            'change',
            {bubbles: true}
        );
        target.dispatchEvent(change);
        eventsDispatched.push('change');
    }
}

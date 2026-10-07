const NATIVE_DIAGNOSTICS_KEY = Symbol.for('arcane-os.native-diagnostics');
const NATIVE_DOCUMENT_KEY = Symbol.for('arcane-os.app-control.document');

/** Report an application-caught error to this document's native host ledger. */
export async function reportNativeError(error, options = {}) {
    const owner = globalThis[NATIVE_DIAGNOSTICS_KEY];
    if (!owner) throw nativeDiagnosticsUnavailable();
    return owner.report(error, options);
}

/** The native host installs this once, at document creation, before app scripts. */
export function installNativeDiagnostics(global = globalThis) {
    if (global[NATIVE_DIAGNOSTICS_KEY]) return global[NATIVE_DIAGNOSTICS_KEY];

    const documentId = global[NATIVE_DOCUMENT_KEY] ??= global.crypto.randomUUID();
    let delivery = Promise.resolve();
    const owner = {
        documentId,
        ready: null,
        report(error, options = {}) {
            return capture('application', error, options);
        }
    };
    global[NATIVE_DIAGNOSTICS_KEY] = owner;
    global.addEventListener('error', captureWindowError);
    global.addEventListener('unhandledrejection', captureUnhandledRejection);
    owner.ready = transmit(envelope('document'));
    owner.ready.catch(reportCaptureFailure);
    return owner;

    function envelope(type, record) {
        return {
            protocol: 'arcane.native-diagnostics/1',
            type,
            documentId,
            documentUrl: global.location.href,
            time: new Date().toISOString(),
            ...(record === undefined ? {} : {record})
        };
    }

    async function capture(kind, error, options = {}, observation) {
        // Snapshot synchronously at the reported failure, before any bridge wait.
        const record = {kind, ...encodeDiagnosticValues(error, options)};
        if (observation !== undefined) {
            record.location = observation.location;
            record.message = observation.message;
        }
        return transmit(envelope('error', record));
    }

    function transmit(frame) {
        // This document has one ordered ingress. A failed write is observed by
        // its caller and does not prevent subsequent independent reports.
        const text = JSON.stringify(frame);
        const pending = delivery.then(async function sendDiagnostic() {
            const windows = global.chrome?.webview?.hostObjects?.arcaneDiagnostics;
            const webkit = global.webkit?.messageHandlers?.arcaneDiagnostics;
            let reply;
            if (windows) reply = await windows.Send(text);
            else if (webkit) reply = await webkit.postMessage(text);
            else throw nativeDiagnosticsUnavailable();
            const result = typeof reply === 'string' ? JSON.parse(reply) : reply;
            if (result?.accepted !== true) {
                const error = new Error('The native host did not retain the diagnostic.', {cause: result?.error});
                error.code = 'ARCANE_NATIVE_DIAGNOSTIC_REJECTED';
                error.details = result;
                throw error;
            }
            return result;
        });
        delivery = pending.catch(function observeOrderedFailure() {});
        return pending;
    }

    function captureWindowError(event) {
        // Resource-element load failures are a different observation boundary;
        // this listener does not inspect their DOM or request payloads.
        if (event.target !== global) return;
        capture('window.error', event.error, {},
            {message: event.message, location: {file: event.filename, line: event.lineno, column: event.colno}}
        ).catch(function failedWindowCapture(failure) {
            reportCaptureFailure(failure, event.error);
        });
    }

    function captureUnhandledRejection(event) {
        capture('unhandledrejection', event.reason).catch(function failedRejectionCapture(failure) {
            reportCaptureFailure(failure, event.reason);
        });
    }

    function reportCaptureFailure(failure, original) {
        // Observe our own asynchronous failure without manufacturing another
        // unhandled rejection. The browser's ordinary error behavior continues.
        global.console.error('Arcane native diagnostic capture failed.', failure, original);
    }
}

function nativeDiagnosticsUnavailable() {
    const error = new Error('This document has no native diagnostic capture host.');
    error.code = 'ARCANE_NATIVE_DIAGNOSTICS_UNAVAILABLE';
    return error;
}

/**
 * Transport-local property graph, not JSON.stringify(error). Descriptor values
 * preserve non-enumerable Error fields, symbols, cycles and shared references.
 * Accessors remain descriptors; inspection never calls their get/set functions.
 * An object that rejects reflection fails the report with that original error.
 */
function encodeDiagnosticValues(error, options) {
    const references = new Map();
    const pending = [];
    const values = [];
    const record = {valueFormat: 'arcane.diagnostic-value/1', error: encode(error), values};
    const details = Object.getOwnPropertyDescriptor(options, 'details');
    if (details) {
        record.details = Object.hasOwn(details, 'value') ? encode(details.value)
            : {type: 'accessor', get: encode(details.get), set: encode(details.set)};
    }

    for (let index = 0; index < pending.length; index += 1) {
        const value = pending[index];
        const node = values[index];
        if (typeof value === 'symbol') {
            node.description = encode(value.description);
            node.globalKey = encode(Symbol.keyFor(value));
            continue;
        }
        const descriptors = Object.getOwnPropertyDescriptors(value);
        node.properties = Reflect.ownKeys(descriptors).map(function describeProperty(key) {
            return {key: encode(key), ...encodeDescriptor(descriptors[key])};
        });
        const prototype = Object.getPrototypeOf(value);
        const names = prototypeNames(prototype);
        if (names.length) node.constructorName = names[0];

        // Error subclasses may supply these on a prototype, including custom
        // accessors. Preserve the descriptor without reading through it.
        node.inherited = [];
        for (const key of ['name', 'message', 'stack', 'cause', 'errors', 'code', 'details']) {
            if (Object.hasOwn(descriptors, key)) continue;
            const descriptor = findDescriptor(prototype, key);
            if (descriptor) node.inherited.push({key, ...encodeDescriptor(descriptor)});
        }
        if (names.includes('Map')) {
            node.entries = Array.from(Map.prototype.entries.call(value), function encodeEntry([key, item]) {
                return [encode(key), encode(item)];
            });
        } else if (names.includes('Set')) {
            node.entries = Array.from(Set.prototype.values.call(value), encode);
        } else if (names.includes('Date')) {
            node.time = encode(Date.prototype.getTime.call(value));
        } else if (names.includes('RegExp')) {
            node.source = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get.call(value);
            node.flags = {};
            for (const key of ['hasIndices', 'global', 'ignoreCase', 'multiline', 'dotAll', 'unicode', 'unicodeSets', 'sticky']) {
                const getter = Object.getOwnPropertyDescriptor(RegExp.prototype, key)?.get;
                if (getter) node.flags[key] = getter.call(value);
            }
        }
    }
    return record;

    function encode(value) {
        const type = typeof value;
        if (value === null || type === 'string' || type === 'boolean') return value;
        if (type === 'number') {
            return Number.isFinite(value) && !Object.is(value, -0)
                ? value : {type, value: Object.is(value, -0) ? '-0' : String(value)};
        }
        if (type === 'undefined') return {type};
        if (type === 'bigint') return {type, value: String(value)};
        if (!references.has(value)) {
            const id = values.length + 1;
            references.set(value, id);
            pending.push(value);
            values.push({id, type: Array.isArray(value) ? 'array' : type});
        }
        return {ref: references.get(value)};
    }

    function encodeDescriptor(descriptor) {
        const result = {enumerable: descriptor.enumerable, configurable: descriptor.configurable};
        if (Object.hasOwn(descriptor, 'value')) {
            return {...result, value: encode(descriptor.value), writable: descriptor.writable};
        }
        return {...result, get: encode(descriptor.get), set: encode(descriptor.set)};
    }

    function findDescriptor(prototype, key) {
        const visited = new Set();
        while (prototype && !visited.has(prototype)) {
            visited.add(prototype);
            const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
            if (descriptor) return descriptor;
            prototype = Object.getPrototypeOf(prototype);
        }
        return undefined;
    }

    function prototypeNames(prototype) {
        const names = [];
        const visited = new Set();
        while (prototype && !visited.has(prototype)) {
            visited.add(prototype);
            const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
            if (typeof constructor === 'function') {
                const name = Object.getOwnPropertyDescriptor(constructor, 'name')?.value;
                if (typeof name === 'string') names.push(name);
            }
            prototype = Object.getPrototypeOf(prototype);
        }
        return names;
    }
}

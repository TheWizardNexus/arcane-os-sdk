const PROJECTION_LEDGER_SCHEMA_VERSION = '1.0.0';
const DEFAULT_PROJECTION_LEDGER_CAPACITY = 500;
const MAX_PROJECTION_LEDGER_CAPACITY = 5000;
const MAX_PROJECTION_LEDGER_DEPTH = 24;
const MAX_PROJECTION_LEDGER_NODES = 5000;
const MAX_PROJECTION_LEDGER_ARRAY_ITEMS = 1000;
const MAX_PROJECTION_LEDGER_OBJECT_KEYS = 1000;
const MAX_PROJECTION_LEDGER_OBJECT_KEY_LENGTH = 256;
const MAX_PROJECTION_LEDGER_STRING_LENGTH = 16000;
const MAX_PROJECTION_LEDGER_TOTAL_CHARACTERS = 64000;
const MAX_PROJECTION_LEDGER_TOTAL_UTF8_BYTES = 128000;
const MAX_PROJECTION_LEDGER_KEY_LENGTH = 256;
const MIN_PROJECTION_LEDGER_STORED_CHARACTERS = 128000;
const DEFAULT_PROJECTION_LEDGER_STORED_CHARACTERS = 4000000;
const MAX_PROJECTION_LEDGER_STORED_CHARACTERS = 16000000;
const MIN_PROJECTION_LEDGER_STORED_UTF8_BYTES = 256000;
const DEFAULT_PROJECTION_LEDGER_STORED_UTF8_BYTES = 8000000;
const MAX_PROJECTION_LEDGER_STORED_UTF8_BYTES = 32000000;
const MIN_PROJECTION_LEDGER_STORED_NODES = 10000;
const DEFAULT_PROJECTION_LEDGER_STORED_NODES = 500000;
const MAX_PROJECTION_LEDGER_STORED_NODES = 2000000;

const PROJECTION_LEDGER_STATUSES = Object.freeze(
    {
        ACTIVE_TARGET_CONFLICT: 'active-target-conflict',
        ALREADY_REVOKED: 'already-revoked',
        CAPACITY_REACHED: 'capacity-reached',
        EXISTS: 'exists',
        NOT_FOUND: 'not-found',
        REVOKED: 'revoked',
        SOURCE_CONFLICT: 'source-conflict',
        SOURCE_REVOKED: 'source-revoked',
        STORED: 'stored'
    }
);

const PROJECTION_LEDGER_REASON_CODES = Object.freeze(
    {
        INVALID_INPUT: 'INVALID_INPUT'
    }
);

const PROJECTION_LEDGER_LIMITS = Object.freeze(
    {
        defaultCapacity: DEFAULT_PROJECTION_LEDGER_CAPACITY,
        maximumCapacity: MAX_PROJECTION_LEDGER_CAPACITY,
        maximumDepth: MAX_PROJECTION_LEDGER_DEPTH,
        maximumNodes: MAX_PROJECTION_LEDGER_NODES,
        maximumArrayItems: MAX_PROJECTION_LEDGER_ARRAY_ITEMS,
        maximumObjectKeys: MAX_PROJECTION_LEDGER_OBJECT_KEYS,
        maximumObjectKeyLength: MAX_PROJECTION_LEDGER_OBJECT_KEY_LENGTH,
        maximumStringLength: MAX_PROJECTION_LEDGER_STRING_LENGTH,
        maximumTotalCharacters: MAX_PROJECTION_LEDGER_TOTAL_CHARACTERS,
        maximumTotalUtf8Bytes: MAX_PROJECTION_LEDGER_TOTAL_UTF8_BYTES,
        maximumLedgerKeyLength: MAX_PROJECTION_LEDGER_KEY_LENGTH,
        minimumStoredCharacters: MIN_PROJECTION_LEDGER_STORED_CHARACTERS,
        defaultStoredCharacters: DEFAULT_PROJECTION_LEDGER_STORED_CHARACTERS,
        maximumStoredCharacters: MAX_PROJECTION_LEDGER_STORED_CHARACTERS,
        minimumStoredUtf8Bytes: MIN_PROJECTION_LEDGER_STORED_UTF8_BYTES,
        defaultStoredUtf8Bytes: DEFAULT_PROJECTION_LEDGER_STORED_UTF8_BYTES,
        maximumStoredUtf8Bytes: MAX_PROJECTION_LEDGER_STORED_UTF8_BYTES,
        minimumStoredNodes: MIN_PROJECTION_LEDGER_STORED_NODES,
        defaultStoredNodes: DEFAULT_PROJECTION_LEDGER_STORED_NODES,
        maximumStoredNodes: MAX_PROJECTION_LEDGER_STORED_NODES
    }
);

const PROHIBITED_PROJECTION_LEDGER_KEYS = new Set(
    [
        '__proto__',
        'constructor',
        'prototype'
    ]
);

const PROJECTION_INPUT_KEYS = new Set(
    [
        'sourceKey',
        'targetKey',
        'identity',
        'payload'
    ]
);

const REVOCATION_INPUT_KEYS = new Set(
    [
        'projectionId',
        'payload'
    ]
);

const OPTIONS_KEYS = new Set(
    [
        'capacity',
        'maximumStoredCharacters',
        'maximumStoredUtf8Bytes',
        'maximumStoredNodes'
    ]
);

class ProjectionLedgerError extends TypeError {
    constructor(reasonCode, message) {
        super(message);
        this.name = 'ProjectionLedgerError';
        this.reasonCode = reasonCode;
    }
}

function invalidProjectionLedgerBoundary(label, detail) {
    return new ProjectionLedgerError(
        PROJECTION_LEDGER_REASON_CODES.INVALID_INPUT,
        `${label} ${detail}`
    );
}

function readProjectionLedgerPrototype(value, label) {
    try {
        return Object.getPrototypeOf(value);
    } catch (error) {
        throw invalidProjectionLedgerBoundary(
            label,
            'could not be inspected safely.'
        );
    }
}

function readProjectionLedgerOwnKeys(value, label) {
    try {
        return Reflect.ownKeys(value);
    } catch (error) {
        throw invalidProjectionLedgerBoundary(
            label,
            'could not be inspected safely.'
        );
    }
}

function readProjectionLedgerOwnDescriptor(value, key, label) {
    try {
        return Reflect.getOwnPropertyDescriptor(value, key);
    } catch (error) {
        throw invalidProjectionLedgerBoundary(
            label,
            'could not be inspected safely.'
        );
    }
}

function readProjectionLedgerDescriptors(value, keys, label) {
    const descriptors = Object.create(null);

    for (const key of keys) {
        const descriptor = readProjectionLedgerOwnDescriptor(value, key, label);

        if (!descriptor) {
            throw invalidProjectionLedgerBoundary(
                label,
                'changed while it was being inspected.'
            );
        }

        Object.defineProperty(
            descriptors,
            key,
            {
                configurable: true,
                enumerable: true,
                value: descriptor,
                writable: true
            }
        );
    }

    return descriptors;
}

function inspectProjectionLedgerArray(value, label) {
    try {
        return Array.isArray(value);
    } catch (error) {
        throw invalidProjectionLedgerBoundary(
            label,
            'could not be inspected safely.'
        );
    }
}

function assertProjectionLedgerDataDescriptor(descriptor, label) {
    if (!descriptor
        || Object.hasOwn(descriptor, 'get')
        || Object.hasOwn(descriptor, 'set')) {
        throw invalidProjectionLedgerBoundary(
            label,
            'contains an accessor property.'
        );
    }

    if (!descriptor.enumerable) {
        throw invalidProjectionLedgerBoundary(
            label,
            'contains a hidden property.'
        );
    }
}

function incrementProjectionLedgerNodeCount(label, state) {
    state.nodes += 1;

    if (state.nodes > MAX_PROJECTION_LEDGER_NODES) {
        throw invalidProjectionLedgerBoundary(
            label,
            'contains too many values.'
        );
    }
}

function projectionLedgerUtf8ByteLength(value) {
    let bytes = 0;

    for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index);

        if (codeUnit <= 0x7f) {
            bytes += 1;
        } else if (codeUnit <= 0x7ff) {
            bytes += 2;
        } else if (codeUnit >= 0xd800
            && codeUnit <= 0xdbff
            && index + 1 < value.length) {
            const nextCodeUnit = value.charCodeAt(index + 1);

            if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
                bytes += 4;
                index += 1;
            } else {
                bytes += 3;
            }
        } else {
            bytes += 3;
        }
    }

    return bytes;
}

function consumeProjectionLedgerStringBudget(value, label, state) {
    state.characters += value.length;
    state.utf8Bytes += projectionLedgerUtf8ByteLength(value);

    if (state.characters > MAX_PROJECTION_LEDGER_TOTAL_CHARACTERS) {
        throw invalidProjectionLedgerBoundary(
            label,
            'exceeds the cumulative character budget.'
        );
    }

    if (state.utf8Bytes > MAX_PROJECTION_LEDGER_TOTAL_UTF8_BYTES) {
        throw invalidProjectionLedgerBoundary(
            label,
            'exceeds the cumulative UTF-8 byte budget.'
        );
    }
}

function precheckProjectionLedgerArrayKeys(keys, length, label) {
    if (keys.length > MAX_PROJECTION_LEDGER_ARRAY_ITEMS + 1) {
        throw invalidProjectionLedgerBoundary(
            label,
            'contains too many array properties.'
        );
    }

    for (const key of keys) {
        if (typeof key !== 'string') {
            throw invalidProjectionLedgerBoundary(
                label,
                'contains a symbol key.'
            );
        }

        if (key === 'length') {
            continue;
        }

        if (!/^(?:0|[1-9][0-9]*)$/.test(key)
            || Number(key) >= length) {
            throw invalidProjectionLedgerBoundary(
                label,
                'contains a non-index array property.'
            );
        }
    }
}

function precheckProjectionLedgerObjectKeys(keys, label) {
    if (keys.length > MAX_PROJECTION_LEDGER_OBJECT_KEYS) {
        throw invalidProjectionLedgerBoundary(
            label,
            'contains too many object keys.'
        );
    }

    for (const key of keys) {
        if (typeof key !== 'string') {
            throw invalidProjectionLedgerBoundary(
                label,
                'contains a symbol key.'
            );
        }

        if (key.length > MAX_PROJECTION_LEDGER_OBJECT_KEY_LENGTH) {
            throw invalidProjectionLedgerBoundary(
                label,
                'contains an object key that is too long.'
            );
        }

        if (PROHIBITED_PROJECTION_LEDGER_KEYS.has(key)) {
            throw invalidProjectionLedgerBoundary(
                label,
                'contains a prohibited object key.'
            );
        }
    }
}

function assertProjectionLedgerKeysUnchanged(expectedKeys, actualKeys, label) {
    if (expectedKeys.length !== actualKeys.length) {
        throw invalidProjectionLedgerBoundary(
            label,
            'changed while it was being inspected.'
        );
    }

    const expectedKeySet = new Set(expectedKeys);

    for (const key of actualKeys) {
        if (!expectedKeySet.has(key)) {
            throw invalidProjectionLedgerBoundary(
                label,
                'changed while it was being inspected.'
            );
        }
    }
}

function cloneProjectionLedgerArray(value, label, depth, state) {
    const prototype = readProjectionLedgerPrototype(value, label);

    if (prototype !== Array.prototype) {
        throw invalidProjectionLedgerBoundary(
            label,
            'must contain only ordinary arrays.'
        );
    }

    const lengthDescriptor = readProjectionLedgerOwnDescriptor(
        value,
        'length',
        label
    );

    if (!lengthDescriptor
        || Object.hasOwn(lengthDescriptor, 'get')
        || Object.hasOwn(lengthDescriptor, 'set')
        || !Number.isInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0) {
        throw invalidProjectionLedgerBoundary(
            label,
            'contains an invalid array length.'
        );
    }

    const length = lengthDescriptor.value;

    if (length > MAX_PROJECTION_LEDGER_ARRAY_ITEMS) {
        throw invalidProjectionLedgerBoundary(
            label,
            'contains too many array items.'
        );
    }

    const keys = readProjectionLedgerOwnKeys(value, label);
    precheckProjectionLedgerArrayKeys(keys, length, label);
    const descriptors = readProjectionLedgerDescriptors(value, keys, label);
    const verifiedKeys = readProjectionLedgerOwnKeys(value, label);
    precheckProjectionLedgerArrayKeys(verifiedKeys, length, label);
    assertProjectionLedgerKeysUnchanged(keys, verifiedKeys, label);

    for (const key of keys) {
        if (key === 'length') {
            continue;
        }

        assertProjectionLedgerDataDescriptor(descriptors[key], label);
    }

    const output = [];

    for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];

        if (!descriptor) {
            throw invalidProjectionLedgerBoundary(
                label,
                'contains a sparse array item.'
            );
        }

        output.push(
            cloneProjectionLedgerNode(
                descriptor.value,
                `${label} item`,
                depth + 1,
                state
            )
        );
    }

    return output;
}

function cloneProjectionLedgerRecord(value, label, depth, state) {
    const prototype = readProjectionLedgerPrototype(value, label);

    if (prototype !== Object.prototype && prototype !== null) {
        throw invalidProjectionLedgerBoundary(
            label,
            'must contain only plain objects.'
        );
    }

    const keys = readProjectionLedgerOwnKeys(value, label);
    precheckProjectionLedgerObjectKeys(keys, label);
    const descriptors = readProjectionLedgerDescriptors(value, keys, label);
    const verifiedKeys = readProjectionLedgerOwnKeys(value, label);
    precheckProjectionLedgerObjectKeys(verifiedKeys, label);
    assertProjectionLedgerKeysUnchanged(keys, verifiedKeys, label);

    const output = Object.create(null);

    for (const key of keys) {
        consumeProjectionLedgerStringBudget(key, label, state);
        const descriptor = descriptors[key];
        assertProjectionLedgerDataDescriptor(descriptor, label);
        Object.defineProperty(
            output,
            key,
            {
                configurable: true,
                enumerable: true,
                value: cloneProjectionLedgerNode(
                    descriptor.value,
                    `${label} child`,
                    depth + 1,
                    state
                ),
                writable: true
            }
        );
    }

    return output;
}

function cloneProjectionLedgerNode(value, label, depth, state) {
    incrementProjectionLedgerNodeCount(label, state);

    if (depth > MAX_PROJECTION_LEDGER_DEPTH) {
        throw invalidProjectionLedgerBoundary(
            label,
            'is nested too deeply.'
        );
    }

    if (value === null || typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'string') {
        if (value.length > MAX_PROJECTION_LEDGER_STRING_LENGTH) {
            throw invalidProjectionLedgerBoundary(
                label,
                'contains a string that is too long.'
            );
        }

        consumeProjectionLedgerStringBudget(value, label, state);

        return value;
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw invalidProjectionLedgerBoundary(
                label,
                'contains a non-finite number.'
            );
        }

        return value;
    }

    if (typeof value !== 'object') {
        throw invalidProjectionLedgerBoundary(
            label,
            'contains an unsupported value type.'
        );
    }

    if (state.ancestors.has(value)) {
        throw invalidProjectionLedgerBoundary(
            label,
            'contains a cyclic reference.'
        );
    }

    state.ancestors.add(value);

    try {
        if (inspectProjectionLedgerArray(value, label)) {
            return cloneProjectionLedgerArray(value, label, depth, state);
        }

        return cloneProjectionLedgerRecord(value, label, depth, state);
    } finally {
        state.ancestors.delete(value);
    }
}

function cloneProjectionLedgerValueWithMetrics(value, label) {
    const state = {
        ancestors: new WeakSet(),
        characters: 0,
        nodes: 0,
        utf8Bytes: 0
    };
    const clonedValue = cloneProjectionLedgerNode(
        value,
        label,
        0,
        state
    );

    return {
        value: clonedValue,
        metrics: {
            characters: state.characters,
            nodes: state.nodes,
            utf8Bytes: state.utf8Bytes
        }
    };
}

function cloneProjectionLedgerValue(value, label = 'Value') {
    return cloneProjectionLedgerValueWithMetrics(value, label).value;
}

function isProjectionLedgerRecord(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }

    if (inspectProjectionLedgerArray(value, 'Record')) {
        return false;
    }

    const prototype = readProjectionLedgerPrototype(value, 'Record');
    return prototype === Object.prototype || prototype === null;
}

function stableProjectionLedgerValue(value) {
    if (Array.isArray(value)) {
        const output = [];

        for (const item of value) {
            output.push(stableProjectionLedgerValue(item));
        }

        return output;
    }

    if (value && typeof value === 'object') {
        const output = Object.create(null);
        const keys = Object.keys(value).sort();

        for (const key of keys) {
            output[key] = stableProjectionLedgerValue(value[key]);
        }

        return output;
    }

    return value;
}

function canonicalProjectionLedgerTextFromSafeValue(value) {
    return JSON.stringify(stableProjectionLedgerValue(value));
}

function createProjectionLedgerFingerprintFromSafeValue(value) {
    const text = canonicalProjectionLedgerTextFromSafeValue(value);
    let hash = 2166136261;

    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function createProjectionLedgerFingerprint(value) {
    const safeValue = cloneProjectionLedgerValue(value, 'Fingerprint value');
    return createProjectionLedgerFingerprintFromSafeValue(safeValue);
}

function deepFreezeProjectionLedgerValue(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
        return value;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            deepFreezeProjectionLedgerValue(item);
        }
    } else {
        for (const key of Object.keys(value)) {
            deepFreezeProjectionLedgerValue(value[key]);
        }
    }

    return Object.freeze(value);
}

function immutableProjectionLedgerRecord(record, label) {
    const cloned = cloneProjectionLedgerValueWithMetrics(record, label);

    return {
        record: deepFreezeProjectionLedgerValue(cloned.value),
        metrics: Object.freeze(cloned.metrics)
    };
}

function cloneProjectionLedgerRecordForOutput(record, label) {
    if (!record) {
        return null;
    }

    return cloneProjectionLedgerValue(record, label);
}

function normalizeProjectionLedgerKey(value, label) {
    if (typeof value !== 'string') {
        throw invalidProjectionLedgerBoundary(label, 'must be a string.');
    }

    const normalized = value.normalize('NFKC').trim();

    if (!normalized) {
        throw invalidProjectionLedgerBoundary(label, 'must not be empty.');
    }

    if (normalized.length > MAX_PROJECTION_LEDGER_KEY_LENGTH) {
        throw invalidProjectionLedgerBoundary(label, 'is too long.');
    }

    if (/[\u0000-\u001f\u007f-\u009f]/.test(normalized)) {
        throw invalidProjectionLedgerBoundary(
            label,
            'contains a control character.'
        );
    }

    return normalized;
}

function assertProjectionLedgerRecord(value, label) {
    if (!isProjectionLedgerRecord(value)) {
        throw invalidProjectionLedgerBoundary(label, 'must be a plain object.');
    }
}

function assertProjectionLedgerRecordKeys(record, allowedKeys, requiredKeys, label) {
    for (const key of Object.keys(record)) {
        if (!allowedKeys.has(key)) {
            throw invalidProjectionLedgerBoundary(
                label,
                `contains unsupported key ${key}.`
            );
        }
    }

    for (const key of requiredKeys) {
        if (!Object.hasOwn(record, key)) {
            throw invalidProjectionLedgerBoundary(
                label,
                `requires ${key}.`
            );
        }
    }
}

function normalizeProjectionLedgerBudget(
    options,
    key,
    defaultValue,
    minimum,
    maximum,
    label
) {
    const value = Object.hasOwn(options, key)
        ? options[key]
        : defaultValue;

    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw invalidProjectionLedgerBoundary(
            label,
            `must be an integer from ${minimum} through ${maximum}.`
        );
    }

    return value;
}

function normalizeProjectionLedgerOptions(options) {
    const safeOptions = cloneProjectionLedgerValue(options, 'Ledger options');
    assertProjectionLedgerRecord(safeOptions, 'Ledger options');
    assertProjectionLedgerRecordKeys(
        safeOptions,
        OPTIONS_KEYS,
        [],
        'Ledger options'
    );
    return {
        capacity: normalizeProjectionLedgerBudget(
            safeOptions,
            'capacity',
            DEFAULT_PROJECTION_LEDGER_CAPACITY,
            1,
            MAX_PROJECTION_LEDGER_CAPACITY,
            'Ledger capacity'
        ),
        maximumStoredCharacters: normalizeProjectionLedgerBudget(
            safeOptions,
            'maximumStoredCharacters',
            DEFAULT_PROJECTION_LEDGER_STORED_CHARACTERS,
            MIN_PROJECTION_LEDGER_STORED_CHARACTERS,
            MAX_PROJECTION_LEDGER_STORED_CHARACTERS,
            'Ledger maximumStoredCharacters'
        ),
        maximumStoredUtf8Bytes: normalizeProjectionLedgerBudget(
            safeOptions,
            'maximumStoredUtf8Bytes',
            DEFAULT_PROJECTION_LEDGER_STORED_UTF8_BYTES,
            MIN_PROJECTION_LEDGER_STORED_UTF8_BYTES,
            MAX_PROJECTION_LEDGER_STORED_UTF8_BYTES,
            'Ledger maximumStoredUtf8Bytes'
        ),
        maximumStoredNodes: normalizeProjectionLedgerBudget(
            safeOptions,
            'maximumStoredNodes',
            DEFAULT_PROJECTION_LEDGER_STORED_NODES,
            MIN_PROJECTION_LEDGER_STORED_NODES,
            MAX_PROJECTION_LEDGER_STORED_NODES,
            'Ledger maximumStoredNodes'
        )
    };
}

function formatProjectionLedgerSequence(sequence) {
    return String(sequence).padStart(6, '0');
}

/**
 * Keeps append-only projection and revocation events in bounded page memory.
 *
 * Inputs and outputs are descriptor-safe JSON-like values. The ledger does not
 * persist, communicate, authorize, or attach domain meaning to either key.
 * Operations are asynchronous for adapter compatibility but complete entirely
 * in memory before their returned promise settles. Capacity counts projection
 * slots; each slot includes one reserved revocation event, so every projection
 * can always be revoked and total events cannot exceed twice the capacity.
 * Ledger-wide character, UTF-8 byte, and node budgets count committed records
 * plus worst-case reserved revocations before any new projection is accepted.
 * Constructor options are `capacity`, `maximumStoredCharacters`,
 * `maximumStoredUtf8Bytes`, and `maximumStoredNodes`; their defaults are 500,
 * 4,000,000, 8,000,000, and 500,000. `remainingCapacity` reports unused
 * projection slots, while the `remainingStored*` getters include reservations.
 */
class RevocableProjectionLedger {
    #activeProjectionByTarget = new Map();
    #capacity;
    #maximumStoredCharacters;
    #maximumStoredNodes;
    #maximumStoredUtf8Bytes;
    #projectionById = new Map();
    #projectionBySource = new Map();
    #projectionRecords = [];
    #reservedRevocationCharacters = 0;
    #reservedRevocationNodes = 0;
    #reservedRevocationUtf8Bytes = 0;
    #revocationByProjectionId = new Map();
    #revocationRecords = [];
    #sequence = 0;
    #storedCharacters = 0;
    #storedNodes = 0;
    #storedUtf8Bytes = 0;

    constructor(options = {}) {
        const settings = normalizeProjectionLedgerOptions(options);
        this.#capacity = settings.capacity;
        this.#maximumStoredCharacters = settings.maximumStoredCharacters;
        this.#maximumStoredUtf8Bytes = settings.maximumStoredUtf8Bytes;
        this.#maximumStoredNodes = settings.maximumStoredNodes;
    }

    get capacity() {
        return this.#capacity;
    }

    get eventCount() {
        return this.#projectionRecords.length + this.#revocationRecords.length;
    }

    get eventCapacity() {
        return this.#capacity * 2;
    }

    get maximumStoredCharacters() {
        return this.#maximumStoredCharacters;
    }

    get maximumStoredUtf8Bytes() {
        return this.#maximumStoredUtf8Bytes;
    }

    get maximumStoredNodes() {
        return this.#maximumStoredNodes;
    }

    get storedCharacters() {
        return this.#storedCharacters;
    }

    get storedUtf8Bytes() {
        return this.#storedUtf8Bytes;
    }

    get storedNodes() {
        return this.#storedNodes;
    }

    get reservedRevocationCharacters() {
        return this.#reservedRevocationCharacters;
    }

    get reservedRevocationUtf8Bytes() {
        return this.#reservedRevocationUtf8Bytes;
    }

    get reservedRevocationNodes() {
        return this.#reservedRevocationNodes;
    }

    get remainingStoredCharacters() {
        return this.#maximumStoredCharacters
            - this.#storedCharacters
            - this.#reservedRevocationCharacters;
    }

    get remainingStoredUtf8Bytes() {
        return this.#maximumStoredUtf8Bytes
            - this.#storedUtf8Bytes
            - this.#reservedRevocationUtf8Bytes;
    }

    get remainingStoredNodes() {
        return this.#maximumStoredNodes
            - this.#storedNodes
            - this.#reservedRevocationNodes;
    }

    get remainingCapacity() {
        return this.#capacity - this.#projectionRecords.length;
    }

    #projectionBudgetResult(metrics) {
        if (metrics.characters + MAX_PROJECTION_LEDGER_TOTAL_CHARACTERS
            > this.remainingStoredCharacters) {
            return {
                status: PROJECTION_LEDGER_STATUSES.CAPACITY_REACHED,
                capacity: this.#capacity,
                capacityReason: 'stored-character-budget',
                maximumStoredCharacters: this.#maximumStoredCharacters,
                remainingStoredCharacters: this.remainingStoredCharacters,
                remainingCapacity: this.remainingCapacity,
                idempotent: false
            };
        }

        if (metrics.utf8Bytes + MAX_PROJECTION_LEDGER_TOTAL_UTF8_BYTES
            > this.remainingStoredUtf8Bytes) {
            return {
                status: PROJECTION_LEDGER_STATUSES.CAPACITY_REACHED,
                capacity: this.#capacity,
                capacityReason: 'stored-utf8-budget',
                maximumStoredUtf8Bytes: this.#maximumStoredUtf8Bytes,
                remainingStoredUtf8Bytes: this.remainingStoredUtf8Bytes,
                remainingCapacity: this.remainingCapacity,
                idempotent: false
            };
        }

        if (metrics.nodes + MAX_PROJECTION_LEDGER_NODES
            > this.remainingStoredNodes) {
            return {
                status: PROJECTION_LEDGER_STATUSES.CAPACITY_REACHED,
                capacity: this.#capacity,
                capacityReason: 'stored-node-budget',
                maximumStoredNodes: this.#maximumStoredNodes,
                remainingStoredNodes: this.remainingStoredNodes,
                remainingCapacity: this.remainingCapacity,
                idempotent: false
            };
        }

        return null;
    }

    #assertRevocationBudget(metrics) {
        const charactersAfter = this.#storedCharacters
            + metrics.characters
            + this.#reservedRevocationCharacters
            - MAX_PROJECTION_LEDGER_TOTAL_CHARACTERS;
        const utf8BytesAfter = this.#storedUtf8Bytes
            + metrics.utf8Bytes
            + this.#reservedRevocationUtf8Bytes
            - MAX_PROJECTION_LEDGER_TOTAL_UTF8_BYTES;
        const nodesAfter = this.#storedNodes
            + metrics.nodes
            + this.#reservedRevocationNodes
            - MAX_PROJECTION_LEDGER_NODES;

        if (this.#reservedRevocationCharacters
                < MAX_PROJECTION_LEDGER_TOTAL_CHARACTERS
            || this.#reservedRevocationUtf8Bytes
                < MAX_PROJECTION_LEDGER_TOTAL_UTF8_BYTES
            || this.#reservedRevocationNodes < MAX_PROJECTION_LEDGER_NODES
            || charactersAfter > this.#maximumStoredCharacters
            || utf8BytesAfter > this.#maximumStoredUtf8Bytes
            || nodesAfter > this.#maximumStoredNodes) {
            throw new Error(
                'Projection ledger revocation reservation invariant failed.'
            );
        }
    }

    async appendProjection(input) {
        const safeInput = cloneProjectionLedgerValue(
            input,
            'Projection input'
        );
        assertProjectionLedgerRecord(safeInput, 'Projection input');
        assertProjectionLedgerRecordKeys(
            safeInput,
            PROJECTION_INPUT_KEYS,
            PROJECTION_INPUT_KEYS,
            'Projection input'
        );

        const sourceKey = normalizeProjectionLedgerKey(
            safeInput.sourceKey,
            'Projection sourceKey'
        );
        const targetKey = normalizeProjectionLedgerKey(
            safeInput.targetKey,
            'Projection targetKey'
        );
        assertProjectionLedgerRecord(
            safeInput.identity,
            'Projection identity'
        );
        const identityText = canonicalProjectionLedgerTextFromSafeValue(
            safeInput.identity
        );
        const existingForSource = this.#projectionBySource.get(sourceKey);

        if (existingForSource) {
            const revocation = this.#revocationByProjectionId.get(
                existingForSource.id
            );

            if (revocation) {
                return {
                    status: PROJECTION_LEDGER_STATUSES.SOURCE_REVOKED,
                    record: cloneProjectionLedgerRecordForOutput(
                        existingForSource,
                        'Projection record'
                    ),
                    revocationRecord: cloneProjectionLedgerRecordForOutput(
                        revocation,
                        'Revocation record'
                    ),
                    idempotent: false,
                    remainingCapacity: this.remainingCapacity
                };
            }

            const sameIdentity = canonicalProjectionLedgerTextFromSafeValue(
                existingForSource.identity
            ) === identityText;

            if (existingForSource.targetKey === targetKey && sameIdentity) {
                return {
                    status: PROJECTION_LEDGER_STATUSES.EXISTS,
                    record: cloneProjectionLedgerRecordForOutput(
                        existingForSource,
                        'Projection record'
                    ),
                    idempotent: true,
                    remainingCapacity: this.remainingCapacity
                };
            }

            return {
                status: PROJECTION_LEDGER_STATUSES.SOURCE_CONFLICT,
                record: cloneProjectionLedgerRecordForOutput(
                    existingForSource,
                    'Projection record'
                ),
                idempotent: false,
                remainingCapacity: this.remainingCapacity
            };
        }

        const activeForTarget = this.#activeProjectionByTarget.get(targetKey);

        if (activeForTarget) {
            return {
                status: PROJECTION_LEDGER_STATUSES.ACTIVE_TARGET_CONFLICT,
                record: cloneProjectionLedgerRecordForOutput(
                    activeForTarget,
                    'Projection record'
                ),
                idempotent: false,
                remainingCapacity: this.remainingCapacity
            };
        }

        if (this.remainingCapacity === 0) {
            return {
                status: PROJECTION_LEDGER_STATUSES.CAPACITY_REACHED,
                capacity: this.#capacity,
                capacityReason: 'projection-slots',
                remainingCapacity: 0,
                idempotent: false
            };
        }

        const sequence = this.#sequence + 1;
        const draft = {
            schemaVersion: PROJECTION_LEDGER_SCHEMA_VERSION,
            id: `projection-${formatProjectionLedgerSequence(sequence)}`,
            sequence,
            kind: 'projection',
            sourceKey,
            targetKey,
            identity: safeInput.identity,
            identityFingerprint: createProjectionLedgerFingerprintFromSafeValue(
                safeInput.identity
            ),
            payload: safeInput.payload
        };
        const immutableRecord = immutableProjectionLedgerRecord(
            {
                ...draft,
                fingerprint: createProjectionLedgerFingerprintFromSafeValue(draft)
            },
            'Projection record'
        );
        const record = immutableRecord.record;
        const budgetResult = this.#projectionBudgetResult(
            immutableRecord.metrics
        );

        if (budgetResult) {
            return budgetResult;
        }

        let recordAppended = false;

        try {
            this.#projectionRecords.push(record);
            recordAppended = true;
            this.#projectionById.set(record.id, record);
            this.#projectionBySource.set(record.sourceKey, record);
            this.#activeProjectionByTarget.set(record.targetKey, record);
        } catch (error) {
            if (this.#projectionById.get(record.id) === record) {
                this.#projectionById.delete(record.id);
            }

            if (this.#projectionBySource.get(record.sourceKey) === record) {
                this.#projectionBySource.delete(record.sourceKey);
            }

            if (this.#activeProjectionByTarget.get(record.targetKey) === record) {
                this.#activeProjectionByTarget.delete(record.targetKey);
            }

            if (recordAppended
                && this.#projectionRecords[this.#projectionRecords.length - 1]
                    === record) {
                this.#projectionRecords.pop();
            }

            throw error;
        }

        this.#storedCharacters += immutableRecord.metrics.characters;
        this.#storedUtf8Bytes += immutableRecord.metrics.utf8Bytes;
        this.#storedNodes += immutableRecord.metrics.nodes;
        this.#reservedRevocationCharacters
            += MAX_PROJECTION_LEDGER_TOTAL_CHARACTERS;
        this.#reservedRevocationUtf8Bytes
            += MAX_PROJECTION_LEDGER_TOTAL_UTF8_BYTES;
        this.#reservedRevocationNodes += MAX_PROJECTION_LEDGER_NODES;
        this.#sequence = sequence;

        return {
            status: PROJECTION_LEDGER_STATUSES.STORED,
            record: cloneProjectionLedgerRecordForOutput(
                record,
                'Projection record'
            ),
            idempotent: false,
            remainingCapacity: this.remainingCapacity
        };
    }

    async appendRevocation(input) {
        const safeInput = cloneProjectionLedgerValue(
            input,
            'Revocation input'
        );
        assertProjectionLedgerRecord(safeInput, 'Revocation input');
        assertProjectionLedgerRecordKeys(
            safeInput,
            REVOCATION_INPUT_KEYS,
            REVOCATION_INPUT_KEYS,
            'Revocation input'
        );
        const projectionId = normalizeProjectionLedgerKey(
            safeInput.projectionId,
            'Revocation projectionId'
        );
        const projection = this.#projectionById.get(projectionId);

        if (!projection) {
            return {
                status: PROJECTION_LEDGER_STATUSES.NOT_FOUND,
                projectionId,
                idempotent: false,
                remainingCapacity: this.remainingCapacity
            };
        }

        const existingRevocation = this.#revocationByProjectionId.get(
            projectionId
        );

        if (existingRevocation) {
            return {
                status: PROJECTION_LEDGER_STATUSES.ALREADY_REVOKED,
                record: cloneProjectionLedgerRecordForOutput(
                    existingRevocation,
                    'Revocation record'
                ),
                projection: cloneProjectionLedgerRecordForOutput(
                    projection,
                    'Projection record'
                ),
                idempotent: true,
                remainingCapacity: this.remainingCapacity
            };
        }

        const sequence = this.#sequence + 1;
        const draft = {
            schemaVersion: PROJECTION_LEDGER_SCHEMA_VERSION,
            id: `projection-revocation-${formatProjectionLedgerSequence(sequence)}`,
            sequence,
            kind: 'projection-revocation',
            projectionId: projection.id,
            sourceKey: projection.sourceKey,
            targetKey: projection.targetKey,
            payload: safeInput.payload
        };
        const immutableRecord = immutableProjectionLedgerRecord(
            {
                ...draft,
                fingerprint: createProjectionLedgerFingerprintFromSafeValue(draft)
            },
            'Revocation record'
        );
        const record = immutableRecord.record;
        this.#assertRevocationBudget(immutableRecord.metrics);
        let recordAppended = false;

        try {
            this.#revocationRecords.push(record);
            recordAppended = true;
            this.#revocationByProjectionId.set(projection.id, record);
            this.#activeProjectionByTarget.delete(projection.targetKey);
        } catch (error) {
            if (this.#revocationByProjectionId.get(projection.id) === record) {
                this.#revocationByProjectionId.delete(projection.id);
            }

            if (!this.#activeProjectionByTarget.has(projection.targetKey)) {
                this.#activeProjectionByTarget.set(
                    projection.targetKey,
                    projection
                );
            }

            if (recordAppended
                && this.#revocationRecords[this.#revocationRecords.length - 1]
                    === record) {
                this.#revocationRecords.pop();
            }

            throw error;
        }

        this.#storedCharacters += immutableRecord.metrics.characters;
        this.#storedUtf8Bytes += immutableRecord.metrics.utf8Bytes;
        this.#storedNodes += immutableRecord.metrics.nodes;
        this.#reservedRevocationCharacters
            -= MAX_PROJECTION_LEDGER_TOTAL_CHARACTERS;
        this.#reservedRevocationUtf8Bytes
            -= MAX_PROJECTION_LEDGER_TOTAL_UTF8_BYTES;
        this.#reservedRevocationNodes -= MAX_PROJECTION_LEDGER_NODES;
        this.#sequence = sequence;

        return {
            status: PROJECTION_LEDGER_STATUSES.REVOKED,
            record: cloneProjectionLedgerRecordForOutput(
                record,
                'Revocation record'
            ),
            projection: cloneProjectionLedgerRecordForOutput(
                projection,
                'Projection record'
            ),
            idempotent: false,
            remainingCapacity: this.remainingCapacity
        };
    }

    async getProjection(id) {
        const normalizedId = normalizeProjectionLedgerKey(id, 'Projection id');
        return cloneProjectionLedgerRecordForOutput(
            this.#projectionById.get(normalizedId),
            'Projection record'
        );
    }

    async getProjectionBySourceKey(sourceKey) {
        const normalizedSourceKey = normalizeProjectionLedgerKey(
            sourceKey,
            'Projection sourceKey'
        );
        return cloneProjectionLedgerRecordForOutput(
            this.#projectionBySource.get(normalizedSourceKey),
            'Projection record'
        );
    }

    async listProjectionRecords() {
        const output = [];

        for (const record of this.#projectionRecords) {
            output.push(
                cloneProjectionLedgerRecordForOutput(
                    record,
                    'Projection record'
                )
            );
        }

        return output;
    }

    async listRevocationRecords() {
        const output = [];

        for (const record of this.#revocationRecords) {
            output.push(
                cloneProjectionLedgerRecordForOutput(
                    record,
                    'Revocation record'
                )
            );
        }

        return output;
    }

    async listEffectiveProjections() {
        const output = [];

        for (const record of this.#projectionRecords) {
            if (!this.#revocationByProjectionId.has(record.id)) {
                output.push(
                    cloneProjectionLedgerRecordForOutput(
                        record,
                        'Projection record'
                    )
                );
            }
        }

        return output;
    }
}

const PRISTINE_REVOCABLE_PROJECTION_LEDGER_PROTOTYPE =
    RevocableProjectionLedger.prototype;
const PRISTINE_REVOCABLE_PROJECTION_LEDGER_PROTOTYPE_KEYS = Object.freeze(
    Reflect.ownKeys(PRISTINE_REVOCABLE_PROJECTION_LEDGER_PROTOTYPE)
);
const PRISTINE_REVOCABLE_PROJECTION_LEDGER_CONSTRUCTOR_DESCRIPTOR =
    Reflect.getOwnPropertyDescriptor(
        PRISTINE_REVOCABLE_PROJECTION_LEDGER_PROTOTYPE,
        'constructor'
    );
const REVOCABLE_PROJECTION_LEDGER_GETTER_NAMES = Object.freeze(
    [
        'capacity',
        'eventCount',
        'eventCapacity',
        'maximumStoredCharacters',
        'maximumStoredUtf8Bytes',
        'maximumStoredNodes',
        'storedCharacters',
        'storedUtf8Bytes',
        'storedNodes',
        'reservedRevocationCharacters',
        'reservedRevocationUtf8Bytes',
        'reservedRevocationNodes',
        'remainingStoredCharacters',
        'remainingStoredUtf8Bytes',
        'remainingStoredNodes',
        'remainingCapacity'
    ]
);
const REVOCABLE_PROJECTION_LEDGER_METHOD_NAMES = Object.freeze(
    [
        'appendProjection',
        'appendRevocation',
        'getProjection',
        'getProjectionBySourceKey',
        'listProjectionRecords',
        'listRevocationRecords',
        'listEffectiveProjections'
    ]
);
const PRISTINE_REVOCABLE_PROJECTION_LEDGER_GETTER_DESCRIPTORS = Object.freeze(
    REVOCABLE_PROJECTION_LEDGER_GETTER_NAMES.reduce(
        function capturePristineLedgerGetterDescriptors(output, getterName) {
            output[getterName] = Reflect.getOwnPropertyDescriptor(
                PRISTINE_REVOCABLE_PROJECTION_LEDGER_PROTOTYPE,
                getterName
            );
            return output;
        },
        Object.create(null)
    )
);
const PRISTINE_REVOCABLE_PROJECTION_LEDGER_EVENT_COUNT_DESCRIPTOR =
    PRISTINE_REVOCABLE_PROJECTION_LEDGER_GETTER_DESCRIPTORS.eventCount;
const PRISTINE_REVOCABLE_PROJECTION_LEDGER_EVENT_COUNT =
    PRISTINE_REVOCABLE_PROJECTION_LEDGER_EVENT_COUNT_DESCRIPTOR.get;
const PRISTINE_REVOCABLE_PROJECTION_LEDGER_METHOD_DESCRIPTORS = Object.freeze(
    REVOCABLE_PROJECTION_LEDGER_METHOD_NAMES.reduce(
        function capturePristineLedgerMethodDescriptors(output, methodName) {
            output[methodName] = Reflect.getOwnPropertyDescriptor(
                PRISTINE_REVOCABLE_PROJECTION_LEDGER_PROTOTYPE,
                methodName
            );
            return output;
        },
        Object.create(null)
    )
);

function sameProjectionLedgerDataDescriptor(current, pristine) {
    return Boolean(current)
        && Boolean(pristine)
        && current.value === pristine.value
        && current.writable === pristine.writable
        && current.enumerable === pristine.enumerable
        && current.configurable === pristine.configurable;
}

function sameProjectionLedgerAccessorDescriptor(current, pristine) {
    return Boolean(current)
        && Boolean(pristine)
        && current.get === pristine.get
        && current.set === pristine.set
        && current.enumerable === pristine.enumerable
        && current.configurable === pristine.configurable;
}

function sameProjectionLedgerKeyList(current, pristine) {
    if (!Array.isArray(current) || current.length !== pristine.length) {
        return false;
    }
    for (let index = 0; index < pristine.length; index += 1) {
        if (current[index] !== pristine[index]) {
            return false;
        }
    }
    return true;
}

function invalidProjectionLedgerPort(detail) {
    throw invalidProjectionLedgerBoundary('Projection ledger port', detail);
}

function assertPristineRevocableProjectionLedger(value) {
    let prototype;
    let ownKeys;
    let prototypeKeys;
    let constructorDescriptor;
    const getterDescriptors = Object.create(null);
    const methodDescriptors = Object.create(null);
    try {
        prototype = Object.getPrototypeOf(value);
        ownKeys = Reflect.ownKeys(value);
        prototypeKeys = Reflect.ownKeys(
            PRISTINE_REVOCABLE_PROJECTION_LEDGER_PROTOTYPE
        );
        constructorDescriptor = Reflect.getOwnPropertyDescriptor(
            PRISTINE_REVOCABLE_PROJECTION_LEDGER_PROTOTYPE,
            'constructor'
        );
        for (const getterName of REVOCABLE_PROJECTION_LEDGER_GETTER_NAMES) {
            getterDescriptors[getterName] = Reflect.getOwnPropertyDescriptor(
                PRISTINE_REVOCABLE_PROJECTION_LEDGER_PROTOTYPE,
                getterName
            );
        }
        for (const methodName of REVOCABLE_PROJECTION_LEDGER_METHOD_NAMES) {
            methodDescriptors[methodName] = Reflect.getOwnPropertyDescriptor(
                PRISTINE_REVOCABLE_PROJECTION_LEDGER_PROTOTYPE,
                methodName
            );
        }
    } catch (error) {
        invalidProjectionLedgerPort('could not be inspected safely.');
    }
    if (prototype !== PRISTINE_REVOCABLE_PROJECTION_LEDGER_PROTOTYPE
        || !Array.isArray(ownKeys)
        || ownKeys.length !== 0
        || typeof PRISTINE_REVOCABLE_PROJECTION_LEDGER_EVENT_COUNT !== 'function'
        || !sameProjectionLedgerKeyList(
            prototypeKeys,
            PRISTINE_REVOCABLE_PROJECTION_LEDGER_PROTOTYPE_KEYS
        )
        || !sameProjectionLedgerDataDescriptor(
            constructorDescriptor,
            PRISTINE_REVOCABLE_PROJECTION_LEDGER_CONSTRUCTOR_DESCRIPTOR
        )) {
        invalidProjectionLedgerPort('requires an unmodified concrete producer.');
    }
    for (const getterName of REVOCABLE_PROJECTION_LEDGER_GETTER_NAMES) {
        if (!sameProjectionLedgerAccessorDescriptor(
            getterDescriptors[getterName],
            PRISTINE_REVOCABLE_PROJECTION_LEDGER_GETTER_DESCRIPTORS[getterName]
        )) {
            invalidProjectionLedgerPort('requires unmodified producer getters.');
        }
    }
    for (const methodName of REVOCABLE_PROJECTION_LEDGER_METHOD_NAMES) {
        if (!sameProjectionLedgerDataDescriptor(
            methodDescriptors[methodName],
            PRISTINE_REVOCABLE_PROJECTION_LEDGER_METHOD_DESCRIPTORS[methodName]
        )) {
            invalidProjectionLedgerPort('requires unmodified producer methods.');
        }
    }
}

function readPristineProjectionLedgerEventCount(value) {
    assertPristineRevocableProjectionLedger(value);
    const eventCount = PRISTINE_REVOCABLE_PROJECTION_LEDGER_EVENT_COUNT.call(value);
    if (!Number.isSafeInteger(eventCount) || eventCount < 0) {
        invalidProjectionLedgerPort('returned an invalid event count.');
    }
    return eventCount;
}

function probePristineRevocableProjectionLedger(value) {
    try {
        return readPristineProjectionLedgerEventCount(value);
    } catch (error) {
        if (error instanceof ProjectionLedgerError) {
            throw error;
        }
        invalidProjectionLedgerPort('failed its private-brand probe.');
    }
}

function callPristineProjectionLedgerMethod(value, methodName, args) {
    assertPristineRevocableProjectionLedger(value);
    return Reflect.apply(
        PRISTINE_REVOCABLE_PROJECTION_LEDGER_METHOD_DESCRIPTORS[methodName].value,
        value,
        args
    );
}

function callPristineProjectionLedgerMutation(
    value,
    methodName,
    input,
    label
) {
    const safeInput = cloneProjectionLedgerValue(input, label);
    return callPristineProjectionLedgerMethod(
        value,
        methodName,
        [safeInput]
    );
}

function createRevocableProjectionLedgerPortAdapter(value) {
    probePristineRevocableProjectionLedger(value);

    function readEventCount() {
        return readPristineProjectionLedgerEventCount(value);
    }

    function appendProjection(input) {
        return callPristineProjectionLedgerMutation(
            value,
            'appendProjection',
            input,
            'Projection adapter input'
        );
    }

    function appendRevocation(input) {
        return callPristineProjectionLedgerMutation(
            value,
            'appendRevocation',
            input,
            'Revocation adapter input'
        );
    }

    function getProjection(id) {
        return callPristineProjectionLedgerMethod(value, 'getProjection', [id]);
    }

    function getProjectionBySourceKey(sourceKey) {
        return callPristineProjectionLedgerMethod(
            value,
            'getProjectionBySourceKey',
            [sourceKey]
        );
    }

    function listProjectionRecords() {
        return callPristineProjectionLedgerMethod(value, 'listProjectionRecords', []);
    }

    function listRevocationRecords() {
        return callPristineProjectionLedgerMethod(value, 'listRevocationRecords', []);
    }

    function listEffectiveProjections() {
        return callPristineProjectionLedgerMethod(value, 'listEffectiveProjections', []);
    }

    return Object.freeze(
        {
            appendProjection,
            appendRevocation,
            getProjection,
            getProjectionBySourceKey,
            listProjectionRecords,
            listRevocationRecords,
            listEffectiveProjections,
            readEventCount
        }
    );
}

export {
    DEFAULT_PROJECTION_LEDGER_CAPACITY,
    DEFAULT_PROJECTION_LEDGER_STORED_CHARACTERS,
    DEFAULT_PROJECTION_LEDGER_STORED_NODES,
    DEFAULT_PROJECTION_LEDGER_STORED_UTF8_BYTES,
    MAX_PROJECTION_LEDGER_CAPACITY,
    MAX_PROJECTION_LEDGER_STORED_CHARACTERS,
    MAX_PROJECTION_LEDGER_STORED_NODES,
    MAX_PROJECTION_LEDGER_STORED_UTF8_BYTES,
    PROJECTION_LEDGER_LIMITS,
    PROJECTION_LEDGER_REASON_CODES,
    PROJECTION_LEDGER_SCHEMA_VERSION,
    PROJECTION_LEDGER_STATUSES,
    ProjectionLedgerError,
    RevocableProjectionLedger,
    cloneProjectionLedgerValue,
    createRevocableProjectionLedgerPortAdapter,
    createProjectionLedgerFingerprint
};

export default RevocableProjectionLedger;

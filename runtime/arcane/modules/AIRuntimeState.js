import {createArcaneEventSource} from 'arcane-os/event-manager';

export const AI_RUNTIME_PROTOCOL = 'arcane-ai-runtime-state/1';
export const AI_RUNTIME_STATE_EVENT = 'arcane-ai-runtime-state';
export const AI_RUNTIME_INTENT_EVENT = 'arcane-ai-runtime-intent';
/** Emitted with the text-chat barrier report, not full speech settlement. */
export const AI_RUNTIME_STARTUP_EVENT = 'arcane-ai-runtime-startup-settled';

export const AI_RUNTIME_ROLES = Object.freeze([
    'llm',
    'stt',
    'tts'
]);

export const AI_RUNTIME_STATES = Object.freeze([
    'unavailable',
    'unloaded',
    'loading',
    'ready',
    'unloading',
    'error',
    'disposed'
]);

const ROLE_KEYS = Object.freeze([
    'role',
    'state',
    'providerId',
    'modelId',
    'localOnly',
    'loaded',
    'busy',
    'operationId',
    'progress',
    'error'
]);
const PROGRESS_KEYS = Object.freeze([
    'phase',
    'completed',
    'total',
    'unit',
    'heartbeat'
]);
const ERROR_KEYS = Object.freeze([
    'code',
    'message'
]);
const INTENT_KEYS = Object.freeze([
    'role',
    'action',
    'reason'
]);
const SUBSCRIPTION_OPTION_KEYS = Object.freeze([
    'signal',
    'emitCurrent'
]);
const INTENT_SUBSCRIPTION_OPTION_KEYS = Object.freeze([
    'signal'
]);
const STARTUP_OPTION_KEYS = Object.freeze([
    'startMuted',
    'startTranscription',
    'signal'
]);
const ROLE_SET = new Set(AI_RUNTIME_ROLES);
const STATE_SET = new Set(AI_RUNTIME_STATES);
const INTENT_ACTIONS = new Set([
    'load',
    'unload',
    'dispose'
]);
const INTENT_REASONS = new Set([
    'startup',
    'user',
    'teardown'
]);
const MUST_BE_UNLOADED = new Set([
    'unavailable',
    'unloaded',
    'loading',
    'disposed'
]);
const STARTUP_TERMINAL_STATES = new Set([
    'unavailable',
    'error',
    'disposed'
]);
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_PROGRESS_UNIT_LENGTH = 32;
const MAX_ERROR_MESSAGE_LENGTH = 512;

const AI_RUNTIME_EVENT_OWNER = Object.freeze({});
const aiRuntimeEventSource = createArcaneEventSource(
    AI_RUNTIME_EVENT_OWNER,
    {
        source: 'ai-runtime-state',
        eventTypes: Object.freeze([
            AI_RUNTIME_STATE_EVENT,
            AI_RUNTIME_INTENT_EVENT,
            AI_RUNTIME_STARTUP_EVENT
        ])
    }
);

/**
 * @deprecated Subscribe through the focused runtime helpers or arcaneEvents.
 * This state-free EventTarget compatibility view delegates to the module's
 * canonical source; it does not own a second listener registry or event bus.
 */
export const aiRuntimeEvents = Object.freeze({
    addEventListener(type, listener, options) {
        return aiRuntimeEventSource.addEventListener(type, listener, options);
    },
    removeEventListener(type, listener, options) {
        return aiRuntimeEventSource.removeEventListener(type, listener, options);
    },
    dispatchEvent(event) {
        return aiRuntimeEventSource.dispatchEvent(event);
    }
});

function fail(message) {
    throw new TypeError(`ARCANE_AI_RUNTIME_STATE_INVALID: ${message}`);
}

function assertClosedRecord(value, expectedKeys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(`${label} must be a plain object.`);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        fail(`${label} must be a plain object.`);
    }

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(function hasSymbolKey(key) {
        return typeof key === 'symbol';
    })) {
        fail(`${label} must not contain symbol keys.`);
    }

    const actualKeys = ownKeys.slice().sort();
    const requiredKeys = expectedKeys.slice().sort();
    if (actualKeys.length !== requiredKeys.length
        || actualKeys.some(function hasUnexpectedKey(key, index) {
            return key !== requiredKeys[index];
        })) {
        fail(`${label} must contain exactly ${expectedKeys.join(', ')}.`);
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of expectedKeys) {
        if (!Object.hasOwn(descriptors[key], 'value')) {
            fail(`${label}.${key} must be a data property.`);
        }
    }
}

function assertClosedOptions(value, allowedKeys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(`${label} must be a plain object.`);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        fail(`${label} must be a plain object.`);
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol' || !allowedKeys.includes(key)) {
            fail(`${label} contains an unknown option.`);
        }
        if (!Object.hasOwn(descriptors[key], 'value')) {
            fail(`${label}.${key} must be a data property.`);
        }
    }
}

function assertNullableIdentifier(value, label) {
    if (value === null) {
        return;
    }

    if (typeof value !== 'string'
        || value.length < 1
        || value.length > MAX_IDENTIFIER_LENGTH
        || value.trim() !== value) {
        fail(`${label} must be null or a trimmed 1-${MAX_IDENTIFIER_LENGTH} character string.`);
    }
}

function assertRole(role) {
    if (!ROLE_SET.has(role)) {
        fail(`role must be one of ${AI_RUNTIME_ROLES.join(', ')}.`);
    }
}

function copyProgress(progress) {
    if (progress === null) {
        return null;
    }

    assertClosedRecord(progress, PROGRESS_KEYS, 'progress');
    if (typeof progress.phase !== 'string'
        || progress.phase.length < 1
        || progress.phase.length > MAX_IDENTIFIER_LENGTH
        || progress.phase.trim() !== progress.phase) {
        fail(`progress.phase must be a trimmed 1-${MAX_IDENTIFIER_LENGTH} character string.`);
    }
    if (!Number.isSafeInteger(progress.completed) || progress.completed < 0) {
        fail('progress.completed must be a nonnegative safe integer.');
    }
    if (progress.total !== null
        && (!Number.isSafeInteger(progress.total)
            || progress.total < progress.completed)) {
        fail('progress.total must be null or a safe integer no smaller than progress.completed.');
    }
    if (typeof progress.unit !== 'string'
        || progress.unit.length < 1
        || progress.unit.length > MAX_PROGRESS_UNIT_LENGTH
        || progress.unit.trim() !== progress.unit) {
        fail(`progress.unit must be a trimmed 1-${MAX_PROGRESS_UNIT_LENGTH} character string.`);
    }
    if (typeof progress.heartbeat !== 'boolean') {
        fail('progress.heartbeat must be a boolean.');
    }

    return Object.freeze(
        {
            phase: progress.phase,
            completed: progress.completed,
            total: progress.total,
            unit: progress.unit,
            heartbeat: progress.heartbeat
        }
    );
}

function copyError(error) {
    if (error === null) {
        return null;
    }

    assertClosedRecord(error, ERROR_KEYS, 'error');
    if (typeof error.code !== 'string'
        || error.code.length < 1
        || error.code.length > MAX_IDENTIFIER_LENGTH
        || error.code.trim() !== error.code) {
        fail(`error.code must be a trimmed 1-${MAX_IDENTIFIER_LENGTH} character string.`);
    }
    if (typeof error.message !== 'string'
        || error.message.length < 1
        || error.message.length > MAX_ERROR_MESSAGE_LENGTH
        || error.message.trim() !== error.message) {
        fail(`error.message must be a trimmed 1-${MAX_ERROR_MESSAGE_LENGTH} character string.`);
    }

    return Object.freeze(
        {
            code: error.code,
            message: error.message
        }
    );
}

function copyRoleRecord(role, record) {
    assertRole(role);
    assertClosedRecord(record, ROLE_KEYS, 'role state');
    if (record.role !== role) {
        fail('role state.role must match the published role.');
    }
    if (!STATE_SET.has(record.state)) {
        fail(`role state.state must be one of ${AI_RUNTIME_STATES.join(', ')}.`);
    }

    assertNullableIdentifier(record.providerId, 'role state.providerId');
    assertNullableIdentifier(record.modelId, 'role state.modelId');
    if (record.localOnly !== null && typeof record.localOnly !== 'boolean') {
        fail('role state.localOnly must be null or a boolean.');
    }
    if (typeof record.loaded !== 'boolean') {
        fail('role state.loaded must be a boolean.');
    }
    if (typeof record.busy !== 'boolean') {
        fail('role state.busy must be a boolean.');
    }
    assertNullableIdentifier(record.operationId, 'role state.operationId');

    const progress = copyProgress(record.progress);
    const error = copyError(record.error);
    if (record.state === 'ready' && !record.loaded) {
        fail('a ready role must be loaded.');
    }
    if (record.state === 'unloading' && !record.loaded) {
        fail('an unloading role must remain loaded until unloading completes.');
    }
    if (MUST_BE_UNLOADED.has(record.state) && record.loaded) {
        fail(`${record.state} role state must not be loaded.`);
    }
    if (record.loaded
        && (record.providerId === null || record.modelId === null)) {
        fail('a loaded role must identify its provider and model.');
    }
    if (record.busy && (record.state !== 'ready' || !record.loaded)) {
        fail('a busy role must be ready and loaded.');
    }
    if (record.state === 'error' && error === null) {
        fail('an error role state must include error details.');
    }
    if (record.state !== 'error' && error !== null) {
        fail('only an error role state may include error details.');
    }

    return Object.freeze(
        {
            role,
            state: record.state,
            providerId: record.providerId,
            modelId: record.modelId,
            localOnly: record.localOnly,
            loaded: record.loaded,
            busy: record.busy,
            operationId: record.operationId,
            progress,
            error
        }
    );
}

function unavailableRole(role) {
    return Object.freeze(
        {
            role,
            state: 'unavailable',
            providerId: null,
            modelId: null,
            localOnly: null,
            loaded: false,
            busy: false,
            operationId: null,
            progress: null,
            error: null
        }
    );
}

function publicAIRuntimeState(snapshot, role = null) {
    const roleState = role === null ? null : snapshot.roles[role];
    return Object.freeze(
        {
            revision: snapshot.revision,
            ...(roleState
                ? {
                    role,
                    state: roleState.state,
                    ...(roleState.operationId === null
                        ? {}
                        : {operationId: roleState.operationId}),
                    ...(roleState.error === null
                        ? {}
                        : {code: roleState.error.code})
                }
                : {count: AI_RUNTIME_ROLES.length})
        }
    );
}

function publicAIRuntimeIntent(intent) {
    return Object.freeze(
        {
            role: intent.role,
            action: intent.action,
            reason: intent.reason
        }
    );
}

function publicAIRuntimeStartup(report) {
    return Object.freeze(
        {
            revision: report.currentRevision,
            role: 'llm',
            state: report.roles.llm.state.state
        }
    );
}

function initialSnapshot() {
    return Object.freeze(
        {
            protocol: AI_RUNTIME_PROTOCOL,
            revision: 0,
            roles: Object.freeze(
                {
                    llm: unavailableRole('llm'),
                    stt: unavailableRole('stt'),
                    tts: unavailableRole('tts')
                }
            )
        }
    );
}

let currentSnapshot = initialSnapshot();

function assertAbortSignal(signal) {
    if (signal === null || signal === undefined) {
        return;
    }

    if (typeof signal !== 'object'
        || typeof signal.aborted !== 'boolean'
        || typeof signal.addEventListener !== 'function'
        || typeof signal.removeEventListener !== 'function') {
        fail('subscription signal must be an AbortSignal.');
    }
}

function stateSubscriptionOptions(options) {
    if (options === undefined) {
        return {
            signal: null,
            emitCurrent: true
        };
    }

    assertClosedOptions(options, SUBSCRIPTION_OPTION_KEYS, 'subscription options');
    const signal = Object.hasOwn(options, 'signal') ? options.signal : null;
    const emitCurrent = Object.hasOwn(options, 'emitCurrent')
        ? options.emitCurrent
        : true;
    assertAbortSignal(signal);
    if (typeof emitCurrent !== 'boolean') {
        fail('subscription options.emitCurrent must be a boolean.');
    }

    return {
        signal,
        emitCurrent
    };
}

function intentSubscriptionOptions(options) {
    if (options === undefined) {
        return {
            signal: null,
            emitCurrent: false
        };
    }

    assertClosedOptions(
        options,
        INTENT_SUBSCRIPTION_OPTION_KEYS,
        'intent subscription options'
    );
    const signal = Object.hasOwn(options, 'signal') ? options.signal : null;
    assertAbortSignal(signal);
    return {
        signal,
        emitCurrent: false
    };
}

function startupOptions(options) {
    if (options === undefined) {
        return {
            startMuted: true,
            startTranscription: false,
            signal: null
        };
    }

    assertClosedOptions(options, STARTUP_OPTION_KEYS, 'startup options');
    const startMuted = Object.hasOwn(options, 'startMuted')
        ? options.startMuted
        : true;
    const startTranscription = Object.hasOwn(options, 'startTranscription')
        ? options.startTranscription
        : false;
    const signal = Object.hasOwn(options, 'signal') ? options.signal : null;
    if (typeof startMuted !== 'boolean') {
        fail('startup options.startMuted must be a boolean.');
    }
    if (typeof startTranscription !== 'boolean') {
        fail('startup options.startTranscription must be a boolean.');
    }
    assertAbortSignal(signal);

    return {
        startMuted,
        startTranscription,
        signal
    };
}

function hasAIRuntimeSelection(roleState) {
    return roleState.providerId !== null && roleState.modelId !== null;
}

function startupRequestedRoles(snapshot, startMuted, startTranscription) {
    return Object.freeze(
        {
            llm: hasAIRuntimeSelection(snapshot.roles.llm),
            stt: startTranscription && hasAIRuntimeSelection(snapshot.roles.stt),
            tts: !startMuted && hasAIRuntimeSelection(snapshot.roles.tts)
        }
    );
}

function isAIRuntimeStartupRoleSettled(roleState) {
    return !hasAIRuntimeSelection(roleState)
        || roleState.state === 'ready'
        || STARTUP_TERMINAL_STATES.has(roleState.state);
}

function startupRoleReport(requested, roleState) {
    return Object.freeze(
        {
            requested,
            state: roleState
        }
    );
}

function startupReport(
    snapshot,
    startRevision,
    startMuted,
    startTranscription,
    requestedRoles
) {
    return Object.freeze(
        {
            protocol: AI_RUNTIME_PROTOCOL,
            startRevision,
            currentRevision: snapshot.revision,
            startMuted,
            startTranscription,
            chatReady: snapshot.roles.llm.state === 'ready',
            roles: Object.freeze(
                {
                    llm: startupRoleReport(
                        requestedRoles.llm,
                        snapshot.roles.llm
                    ),
                    stt: startupRoleReport(
                        requestedRoles.stt,
                        snapshot.roles.stt
                    ),
                    tts: startupRoleReport(
                        requestedRoles.tts,
                        snapshot.roles.tts
                    )
                }
            )
        }
    );
}

function normalizedAIRuntimeStartupAbort() {
    const error = new Error('The AI runtime startup was cancelled.');
    error.name = 'AbortError';
    error.code = 'ARCANE_AI_REQUEST_ABORTED';
    return error;
}

function assertListener(listener) {
    if (typeof listener !== 'function') {
        fail('listener must be a function.');
    }
}

function subscribe(eventName, listener, normalized, currentValue) {
    assertListener(listener);

    function forwardAIRuntimeEvent(event) {
        listener(event.detail);
    }

    const unsubscribeAIRuntimeEvent = aiRuntimeEventSource.on(
        eventName,
        forwardAIRuntimeEvent,
        normalized.signal
            ? {
                signal: normalized.signal
            }
            : undefined
    );

    try {
        if (!normalized.signal?.aborted
            && normalized.emitCurrent
            && currentValue !== undefined) {
            listener(currentValue);
        }
    } catch (error) {
        unsubscribeAIRuntimeEvent();
        throw error;
    }

    return unsubscribeAIRuntimeEvent;
}

/** Returns the current deeply immutable runtime-state snapshot. */
export function getAIRuntimeState() {
    return currentSnapshot;
}

/**
 * Subscribes to full runtime-state snapshots. The current snapshot is delivered
 * synchronously by default so a late subscriber never needs to poll.
 */
export function subscribeAIRuntimeState(listener, options) {
    return subscribe(
        AI_RUNTIME_STATE_EVENT,
        listener,
        stateSubscriptionOptions(options),
        currentSnapshot
    );
}

/**
 * Replaces one role's complete observational record and emits the new full
 * snapshot. Publishing state never grants provider authority.
 */
export function publishAIRuntimeRoleState(role, completeRecord) {
    const nextRole = copyRoleRecord(role, completeRecord);
    if (currentSnapshot.revision === Number.MAX_SAFE_INTEGER) {
        throw new RangeError(
            'ARCANE_AI_RUNTIME_STATE_INVALID: state revision exhausted.'
        );
    }

    const nextRoles = {
        llm: currentSnapshot.roles.llm,
        stt: currentSnapshot.roles.stt,
        tts: currentSnapshot.roles.tts
    };
    nextRoles[role] = nextRole;
    currentSnapshot = Object.freeze(
        {
            protocol: AI_RUNTIME_PROTOCOL,
            revision: currentSnapshot.revision + 1,
            roles: Object.freeze(nextRoles)
        }
    );
    aiRuntimeEventSource.dispatch(
        AI_RUNTIME_STATE_EVENT,
        currentSnapshot,
        {
            publicDetail: publicAIRuntimeState(currentSnapshot, role)
        }
    );
    return currentSnapshot;
}

/**
 * Atomically replaces all three role records and emits one coherent snapshot.
 * Provider routing commits use this boundary so synchronous subscribers never
 * observe a partially configured role set.
 */
export function publishAIRuntimeRolesState(completeRecords) {
    assertClosedRecord(completeRecords, AI_RUNTIME_ROLES, 'runtime role states');
    const nextRoles = Object.freeze(
        {
            llm: copyRoleRecord('llm', completeRecords.llm),
            stt: copyRoleRecord('stt', completeRecords.stt),
            tts: copyRoleRecord('tts', completeRecords.tts)
        }
    );
    if (currentSnapshot.revision === Number.MAX_SAFE_INTEGER) {
        throw new RangeError(
            'ARCANE_AI_RUNTIME_STATE_INVALID: state revision exhausted.'
        );
    }
    currentSnapshot = Object.freeze(
        {
            protocol: AI_RUNTIME_PROTOCOL,
            revision: currentSnapshot.revision + 1,
            roles: nextRoles
        }
    );
    aiRuntimeEventSource.dispatch(
        AI_RUNTIME_STATE_EVENT,
        currentSnapshot,
        {
            publicDetail: publicAIRuntimeState(currentSnapshot)
        }
    );
    return currentSnapshot;
}

/**
 * Emits an immutable capability-neutral lifecycle request. This function does
 * not execute, authorize, fetch, load, unload, dispose, or select a fallback.
 */
export function requestAIRuntimeIntent(intent) {
    assertClosedRecord(intent, INTENT_KEYS, 'runtime intent');
    assertRole(intent.role);
    if (!INTENT_ACTIONS.has(intent.action)) {
        fail('runtime intent.action must be load, unload, or dispose.');
    }
    if (!INTENT_REASONS.has(intent.reason)) {
        fail('runtime intent.reason must be startup, user, or teardown.');
    }

    const publishedIntent = Object.freeze(
        {
            role: intent.role,
            action: intent.action,
            reason: intent.reason
        }
    );
    aiRuntimeEventSource.dispatch(
        AI_RUNTIME_INTENT_EVENT,
        publishedIntent,
        {
            publicDetail: publicAIRuntimeIntent(publishedIntent)
        }
    );
    return publishedIntent;
}

/** Subscribes to transient runtime intents; intents have no sticky replay. */
export function subscribeAIRuntimeIntents(listener, options) {
    return subscribe(
        AI_RUNTIME_INTENT_EVENT,
        listener,
        intentSubscriptionOptions(options),
        undefined
    );
}

/**
 * Starts one observational runtime barrier after preferences and provider
 * routes are hydrated. `barrier` resolves when LLM is ready or terminal;
 * `settled` waits for every requested role. Providers own every requested load.
 */
export function startAIRuntime(options) {
    const normalized = startupOptions(options);
    let latestSnapshot = currentSnapshot;
    let requestedRoles = null;
    let startRevision = null;
    let unsubscribeState = null;
    let started = false;
    let cancelled = false;
    const loadRequested = {
        llm: false,
        stt: false,
        tts: false
    };
    let barrierResolved = false;
    let settledResolved = false;
    let resolveBarrier;
    let rejectBarrier;
    let resolveSettled;
    let rejectSettled;

    const barrier = new Promise(
        function createAIRuntimeStartupBarrier(resolve, reject) {
            resolveBarrier = resolve;
            rejectBarrier = reject;
        }
    );
    const settled = new Promise(
        function createAIRuntimeStartupSettlement(resolve, reject) {
            resolveSettled = resolve;
            rejectSettled = reject;
        }
    );

    function closeAIRuntimeStartupObservation() {
        if (unsubscribeState) {
            unsubscribeState();
            unsubscribeState = null;
        }
        normalized.signal?.removeEventListener(
            'abort',
            handleAIRuntimeStartupAbort
        );
    }

    function requestedRolesAreSettled(snapshot) {
        for (const role of AI_RUNTIME_ROLES) {
            if (requestedRoles[role]
                && !isAIRuntimeStartupRoleSettled(snapshot.roles[role])) {
                return false;
            }
        }

        return true;
    }

    function resolveAIRuntimeStartupBarrier(snapshot) {
        const report = startupReport(
            snapshot,
            startRevision,
            normalized.startMuted,
            normalized.startTranscription,
            requestedRoles
        );
        barrierResolved = true;
        resolveBarrier(report);
        aiRuntimeEventSource.dispatch(
            AI_RUNTIME_STARTUP_EVENT,
            report,
            {
                publicDetail: publicAIRuntimeStartup(report)
            }
        );
    }

    function resolveAIRuntimeStartupSettlement(snapshot) {
        settledResolved = true;
        resolveSettled(
            startupReport(
                snapshot,
                startRevision,
                normalized.startMuted,
                normalized.startTranscription,
                requestedRoles
            )
        );
    }

    function evaluateAIRuntimeStartup(snapshot) {
        if (cancelled) {
            return;
        }

        if (!barrierResolved
            && isAIRuntimeStartupRoleSettled(snapshot.roles.llm)) {
            resolveAIRuntimeStartupBarrier(snapshot);
        }
        if (cancelled) {
            return;
        }

        if (!settledResolved && requestedRolesAreSettled(snapshot)) {
            resolveAIRuntimeStartupSettlement(snapshot);
        }
        if (barrierResolved && settledResolved) {
            closeAIRuntimeStartupObservation();
        }
    }

    function observeAIRuntimeStartupState() {
        latestSnapshot = currentSnapshot;
        if (started) {
            requestPendingAIRuntimeStartupLoads(latestSnapshot);
            evaluateAIRuntimeStartup(latestSnapshot);
        }
    }

    function requestPendingAIRuntimeStartupLoads(snapshot) {
        for (const role of AI_RUNTIME_ROLES) {
            const roleState = snapshot.roles[role];
            if (!cancelled
                && requestedRoles[role]
                && !loadRequested[role]
                && hasAIRuntimeSelection(roleState)
                && roleState.state === 'unloaded') {
                loadRequested[role] = true;
                requestAIRuntimeIntent(
                    {
                        role,
                        action: 'load',
                        reason: 'startup'
                    }
                );
            }
        }
    }

    function cancelAIRuntimeStartup() {
        if (cancelled || settledResolved) {
            return;
        }

        cancelled = true;
        closeAIRuntimeStartupObservation();
        const error = normalizedAIRuntimeStartupAbort();
        if (!barrierResolved) {
            rejectBarrier(error);
        }
        if (!settledResolved) {
            rejectSettled(error);
        }

        const cancellationSnapshot = currentSnapshot;
        for (const role of AI_RUNTIME_ROLES) {
            if (requestedRoles[role]
                && cancellationSnapshot.roles[role].state === 'loading') {
                requestAIRuntimeIntent(
                    {
                        role,
                        action: 'unload',
                        reason: 'startup'
                    }
                );
            }
        }
    }

    function handleAIRuntimeStartupAbort() {
        cancelAIRuntimeStartup();
    }

    const handle = Object.freeze(
        {
            barrier,
            settled,
            cancel: cancelAIRuntimeStartup
        }
    );

    unsubscribeState = subscribeAIRuntimeState(observeAIRuntimeStartupState);
    startRevision = latestSnapshot.revision;
    requestedRoles = startupRequestedRoles(
        latestSnapshot,
        normalized.startMuted,
        normalized.startTranscription
    );
    normalized.signal?.addEventListener(
        'abort',
        handleAIRuntimeStartupAbort,
        {
            once: true
        }
    );
    if (normalized.signal?.aborted) {
        cancelAIRuntimeStartup();
        return handle;
    }

    requestPendingAIRuntimeStartupLoads(currentSnapshot);

    if (!cancelled) {
        started = true;
        latestSnapshot = currentSnapshot;
        evaluateAIRuntimeStartup(latestSnapshot);
    }
    return handle;
}

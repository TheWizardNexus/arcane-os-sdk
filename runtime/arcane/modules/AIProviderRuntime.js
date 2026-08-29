import {
    AI_RUNTIME_ROLES,
    getAIRuntimeState,
    publishAIRuntimeRoleState,
    publishAIRuntimeRolesState,
    startAIRuntime,
    subscribeAIRuntimeIntents
} from './AIRuntimeState.js';

const completeValue=(value)=>value;

export const AI_PROVIDER_PROTOCOL = 'arcane-ai-provider/2';
export const AI_PROVIDER_RUNTIME_PROTOCOL = 'arcane-ai-runtime/2';
export const AI_MODEL_AUTHORITY_PROTOCOL = 'arcane-ai-model-authority/1';

const ROLE_SET = new Set(AI_RUNTIME_ROLES);
const SPEECH_ROLES = completeValue(['stt', 'tts']);
const PROVIDER_METHODS = completeValue([
    'catalog',
    'inspect',
    'status',
    'load',
    'request',
    'unload',
    'dispose'
]);
const ROLE_OPERATIONS = completeValue(
    {
        llm: completeValue(['chat', 'stream']),
        stt: completeValue(['transcribe']),
        tts: completeValue(['synthesize'])
    }
);
const ROLE_OPERATION_SETS = completeValue(
    {
        llm: new Set(ROLE_OPERATIONS.llm),
        stt: new Set(ROLE_OPERATIONS.stt),
        tts: new Set(ROLE_OPERATIONS.tts)
    }
);
const ROUTE_KEYS = completeValue(['default', 'localOnly']);
const RUNTIME_CONSTRUCTION_AUTHORITY = completeValue({});
const PROVIDER_RECORDS = new WeakMap();

function fail(message, code = 'ARCANE_AI_PROVIDER_RUNTIME_INVALID') {
    const error = new TypeError(message);
    error.code = code;
    throw error;
}

function operationError(message, code, cause) {
    const error = cause === undefined
        ? new Error(message)
        : new Error(message, {cause});
    error.code = code;
    return error;
}

function normalizedAbort(cause) {
    if (cause?.code === 'ARCANE_AI_REQUEST_ABORTED'
        && cause?.name === 'AbortError') {
        return cause;
    }

    const error = operationError(
        'The AI provider operation was cancelled.',
        'ARCANE_AI_REQUEST_ABORTED',
        cause
    );
    error.name = 'AbortError';
    return error;
}

function isAbort(error, signal) {
    return signal?.aborted
        || error?.name === 'AbortError'
        || error?.code === 'AI_REQUEST_ABORTED'
        || error?.code === 'ARCANE_AI_REQUEST_ABORTED'
        || error?.code === 'ARCANE_REQUEST_ABORTED';
}

async function awaitStreamCleanup(operation) {
    const results = await Promise.resolve(operation);
    return {completed: true, results};
}

function assertStreamCleanupComplete(outcome) {
    const rejected = outcome.completed
        && Array.isArray(outcome.results)
        && outcome.results.some(function hasRejectedAIStreamCleanup(result) {
            return result.status === 'rejected';
        });
    if (!outcome.completed || rejected) {
        throw operationError(
            'The AI provider stream did not confirm cleanup.',
            'ARCANE_AI_STREAM_CLEANUP_INCOMPLETE'
        );
    }
}

function assertRole(role) {
    if (!ROLE_SET.has(role)) {
        fail(`AI provider role must be one of ${AI_RUNTIME_ROLES.join(', ')}.`);
    }
}

function assertIdentifier(value, label) {
    if (typeof value !== 'string'
        || value.length < 1
        || value.trim() !== value) {
        fail(`${label} must be a nonempty trimmed string.`);
    }
}

function nextSequence(value) {
    if (typeof value === 'bigint') {
        return value + 1n;
    }
    if (value === Number.MAX_SAFE_INTEGER) {
        return BigInt(value) + 1n;
    }
    return value + 1;
}

function assertAbortSignal(signal) {
    if (signal === null || signal === undefined) {
        return;
    }

    if (typeof signal !== 'object'
        || typeof signal.aborted !== 'boolean'
        || typeof signal.addEventListener !== 'function'
        || typeof signal.removeEventListener !== 'function') {
        fail('AI provider operation signal must be an AbortSignal.');
    }
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(`${label} must be a plain object.`);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        fail(`${label} must be a plain object.`);
    }
}

function isPlainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function validateLLMToolDeclarations(value) {
    if (value === undefined) {
        return;
    }
    if (!Array.isArray(value)) {
        fail(
            'AI LLM tools must be an array.',
            'ARCANE_AI_TOOL_CALL_INVALID'
        );
    }
    for (let index = 0; index < value.length; index += 1) {
        const tool = value[index];
        const parameters = tool?.function?.parameters;
        const messageSchema = parameters?.properties?.message;
        if (!isPlainRecord(tool)
            || tool.type !== 'function'
            || !isPlainRecord(tool.function)
            || !isPlainRecord(parameters)
            || parameters.type !== 'object'
            || !isPlainRecord(parameters.properties)
            || !isPlainRecord(messageSchema)
            || messageSchema.type !== 'string'
            || !Number.isInteger(messageSchema.minLength)
            || messageSchema.minLength < 1
            || !Array.isArray(parameters.required)
            || !parameters.required.includes('message')) {
            fail(
                `AI LLM tools[${index}] must require a nonempty string parameters.properties.message.`,
                'ARCANE_AI_TOOL_MESSAGE_REQUIRED'
            );
        }
    }
}

function validateLLMToolCall(call, label) {
    if (!isPlainRecord(call)
        || typeof call.id !== 'string'
        || !call.id.trim()
        || call.type !== 'function'
        || !isPlainRecord(call.function)
        || typeof call.function.name !== 'string'
        || !call.function.name.trim()
        || typeof call.function.arguments !== 'string') {
        fail(
            `${label} must be one complete structural function call.`,
            'ARCANE_AI_TOOL_CALL_INVALID'
        );
    }
    let argumentsRecord;
    try {
        argumentsRecord = JSON.parse(call.function.arguments);
    } catch (cause) {
        throw operationError(
            `${label} arguments must encode a JSON object.`,
            'ARCANE_AI_TOOL_CALL_INVALID',
            cause
        );
    }
    if (!isPlainRecord(argumentsRecord)) {
        fail(
            `${label} arguments must encode a JSON object.`,
            'ARCANE_AI_TOOL_CALL_INVALID'
        );
    }
    if (typeof argumentsRecord.message !== 'string'
        || !argumentsRecord.message.trim()) {
        fail(
            `${label} arguments must include a nonempty user-facing message.`,
            'ARCANE_AI_TOOL_MESSAGE_REQUIRED'
        );
    }
    return call.id;
}

function validateLLMMessageToolCalls(message, label) {
    if (!isPlainRecord(message)) {
        fail(
            `${label} must be a plain message object.`,
            'ARCANE_AI_INVALID_PROVIDER_RESULT'
        );
    }
    if (Object.hasOwn(message, 'toolCalls')
        || Object.hasOwn(message, 'function_call')
        || Object.hasOwn(message, 'functionCall')) {
        fail(
            `${label} contains a noncanonical structural tool-call field.`,
            'ARCANE_AI_TOOL_CALL_INVALID'
        );
    }
    if (!Object.hasOwn(message, 'tool_calls')) {
        return [];
    }
    const descriptor = Object.getOwnPropertyDescriptor(message, 'tool_calls');
    if (!descriptor || !Object.hasOwn(descriptor, 'value')
        || !Array.isArray(descriptor.value)) {
        fail(
            `${label}.tool_calls must be an array data property.`,
            'ARCANE_AI_TOOL_CALL_INVALID'
        );
    }
    if (descriptor.value.length > 1) {
        fail(
            'The Arcane AI runtime accepts one structural tool call at a time.',
            'ARCANE_AI_PARALLEL_TOOLS_UNSUPPORTED'
        );
    }
    for (let index = 0; index < descriptor.value.length; index += 1) {
        validateLLMToolCall(
            descriptor.value[index],
            `${label}.tool_calls[${index}]`
        );
    }
    return descriptor.value;
}

function validateLLMRequestPayload(payload) {
    assertPlainObject(payload, 'AI LLM request payload');
    if (!Array.isArray(payload.messages)) {
        fail('AI LLM request payload.messages must be an array.');
    }
    let pendingToolCallId = null;
    for (let index = 0; index < payload.messages.length; index += 1) {
        const message = payload.messages[index];
        if (!isPlainRecord(message)) {
            fail(`AI LLM request payload.messages[${index}] must be a plain object.`);
        }
        if (Object.hasOwn(message, 'tool_calls')
            && message.role !== 'assistant') {
            fail(
                `AI LLM request payload.messages[${index}].tool_calls is valid only for an assistant message.`,
                'ARCANE_AI_TOOL_CALL_INVALID'
            );
        }
        const calls = validateLLMMessageToolCalls(
            message,
            `AI LLM request payload.messages[${index}]`
        );
        let openedToolCall = false;
        if (calls.length) {
            if (pendingToolCallId !== null) {
                fail(
                    'The Arcane AI runtime accepts one structural tool call at a time.',
                    'ARCANE_AI_PARALLEL_TOOLS_UNSUPPORTED'
                );
            }
            pendingToolCallId = calls[0].id;
            openedToolCall = true;
        }
        if (message.role === 'tool') {
            if (typeof message.content !== 'string'
                || !message.content.trim()) {
                fail(
                    `AI LLM request payload.messages[${index}] must contain a nonblank user-facing tool result.`,
                    'ARCANE_AI_INVALID_TOOL_MESSAGE'
                );
            }
            if (pendingToolCallId === null
                || typeof message.tool_call_id !== 'string'
                || message.tool_call_id !== pendingToolCallId) {
                fail(
                    `AI LLM request payload.messages[${index}] does not settle the pending structural tool call.`,
                    'ARCANE_AI_INVALID_TOOL_MESSAGE'
                );
            }
            pendingToolCallId = null;
        } else {
            if (Object.hasOwn(message, 'tool_call_id')) {
                fail(
                    `AI LLM request payload.messages[${index}].tool_call_id is valid only for a tool result.`,
                    'ARCANE_AI_INVALID_TOOL_MESSAGE'
                );
            }
            if (pendingToolCallId !== null && !openedToolCall) {
                fail(
                    `AI LLM request payload.messages[${index}] precedes the pending structural tool result.`,
                    'ARCANE_AI_TOOL_RESULT_REQUIRED'
                );
            }
        }
    }
    if (pendingToolCallId !== null) {
        fail(
            'The pending structural tool call must be settled before requesting another response.',
            'ARCANE_AI_TOOL_RESULT_REQUIRED'
        );
    }
    validateLLMToolDeclarations(payload.tools);
    const parallelValues = [
        payload.parallelToolCalls,
        payload.parallel_tool_calls
    ];
    if (parallelValues.some(function enablesParallelLLMTools(value) {
        return value !== undefined && value !== false;
    })) {
        fail(
            'The Arcane AI runtime accepts one structural tool call at a time.',
            'ARCANE_AI_PARALLEL_TOOLS_UNSUPPORTED'
        );
    }
}

function validateLLMTerminalMessage(message, label) {
    if (!isPlainRecord(message) || message.role !== 'assistant') {
        fail(
            `${label} must contain an assistant message.`,
            'ARCANE_AI_INVALID_PROVIDER_RESULT'
        );
    }
    return validateLLMMessageToolCalls(message, label);
}

function validateLLMTerminalResult(value, label) {
    if (typeof value === 'string') {
        return value;
    }
    if (!isPlainRecord(value)) {
        fail(
            `${label} must be text or a chat completion object.`,
            'ARCANE_AI_INVALID_PROVIDER_RESULT'
        );
    }
    const hasMessage = Object.hasOwn(value, 'message');
    const hasChoices = Object.hasOwn(value, 'choices');
    if (hasMessage === hasChoices) {
        fail(
            `${label} must contain exactly one message or choices envelope.`,
            'ARCANE_AI_INVALID_PROVIDER_RESULT'
        );
    }
    if (hasMessage) {
        const descriptor = Object.getOwnPropertyDescriptor(value, 'message');
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            fail(
                `${label}.message must be a data property.`,
                'ARCANE_AI_INVALID_PROVIDER_RESULT'
            );
        }
        validateLLMTerminalMessage(descriptor.value, `${label}.message`);
        return value;
    }
    const choicesDescriptor = Object.getOwnPropertyDescriptor(value, 'choices');
    if (!choicesDescriptor || !Object.hasOwn(choicesDescriptor, 'value')
        || !Array.isArray(choicesDescriptor.value)
        || choicesDescriptor.value.length === 0) {
        fail(
            `${label}.choices must be a nonempty array data property.`,
            'ARCANE_AI_INVALID_PROVIDER_RESULT'
        );
    }
    const indexes = new Set();
    let totalToolCalls = 0;
    for (let position = 0; position < choicesDescriptor.value.length; position += 1) {
        const choice = choicesDescriptor.value[position];
        if (!isPlainRecord(choice)
            || !Number.isSafeInteger(choice.index)
            || choice.index < 0
            || indexes.has(choice.index)) {
            fail(
                `${label}.choices[${position}] must have a unique nonnegative safe-integer index.`,
                'ARCANE_AI_INVALID_PROVIDER_RESULT'
            );
        }
        indexes.add(choice.index);
        const messageDescriptor = Object.getOwnPropertyDescriptor(choice, 'message');
        if (!messageDescriptor || !Object.hasOwn(messageDescriptor, 'value')) {
            fail(
                `${label}.choices[${position}].message must be a data property.`,
                'ARCANE_AI_INVALID_PROVIDER_RESULT'
            );
        }
        const calls = validateLLMTerminalMessage(
            messageDescriptor.value,
            `${label}.choices[${position}].message`
        );
        if (position > 0 && calls.length) {
            fail(
                `${label} placed a structural tool call outside the selected first choice.`,
                'ARCANE_AI_INVALID_PROVIDER_RESULT'
            );
        }
        totalToolCalls += calls.length;
        if (totalToolCalls > 1) {
            fail(
                'The Arcane AI runtime accepts one structural tool call at a time.',
                'ARCANE_AI_PARALLEL_TOOLS_UNSUPPORTED'
            );
        }
    }
    return value;
}

function isLLMStreamContentKey(key) {
    return key === 'content'
        || key === 'text'
        || key === 'thinking'
        || key === 'reasoning'
        || key === 'reasoning_content';
}

function projectLLMStreamContent(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || seen.has(value)) {
        return null;
    }
    seen.add(value);
    if (Array.isArray(value)) {
        const result = [];
        for (const item of value) {
            const projected = projectLLMStreamContent(item, seen);
            if (projected !== null) {
                result.push(projected);
            }
        }
        seen.delete(value);
        return result.length ? result : null;
    }
    if (!isPlainRecord(value)) {
        seen.delete(value);
        return null;
    }
    const result = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === 'symbol') {
            continue;
        }
        const descriptor = descriptors[key];
        if (!Object.hasOwn(descriptor, 'value')) {
            continue;
        }
        if (isLLMStreamContentKey(key)
            && descriptor.value !== null
            && descriptor.value !== undefined) {
            result[key] = descriptor.value;
            continue;
        }
        const projected = projectLLMStreamContent(descriptor.value, seen);
        if (projected !== null) {
            result[key] = projected;
        }
    }
    seen.delete(value);
    return Object.keys(result).length ? result : null;
}

function projectLLMStreamChunk(value) {
    if (typeof value === 'string') {
        return value;
    }
    return projectLLMStreamContent(value);
}

function assertCallbackFreeProviderValue(value, seen = new WeakSet()) {
    if (typeof value === 'function') {
        fail(
            'AI providers receive data-only request payloads.',
            'ARCANE_AI_PROVIDER_CALLBACK_BOUNDARY'
        );
    }
    if (!value || typeof value !== 'object') {
        return;
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        return;
    }
    if (typeof Blob === 'function' && value instanceof Blob) {
        return;
    }
    if (seen.has(value)) {
        fail('AI provider request payloads must not contain cycles.');
    }
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = descriptors[key];
        if (typeof key === 'symbol' || !Object.hasOwn(descriptor, 'value')) {
            fail('AI provider request payloads must contain data properties only.');
        }
        assertCallbackFreeProviderValue(descriptor.value, seen);
    }
    seen.delete(value);
}

function assertClosedRecord(value, keys, label) {
    assertPlainObject(value, label);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Reflect.ownKeys(value);
    if (actual.some(function hasSymbolKey(key) {
        return typeof key === 'symbol';
    })) {
        fail(`${label} must not contain symbol keys.`);
    }
    if (actual.length !== keys.length
        || actual.some(function hasUnknownKey(key) {
            return !keys.includes(key);
        })) {
        fail(`${label} must contain exactly ${keys.join(', ')}.`);
    }
    for (const key of keys) {
        if (!Object.hasOwn(descriptors[key], 'value')) {
            fail(`${label}.${key} must be a data property.`);
        }
    }
}

function immutableSelection(role, value) {
    if (value === null) {
        return null;
    }

    assertClosedRecord(
        value,
        ['providerId', 'modelId', 'localOnly'],
        `${role} provider selection`
    );
    assertIdentifier(value.providerId, `${role} provider selection.providerId`);
    assertIdentifier(value.modelId, `${role} provider selection.modelId`);
    if (value.localOnly !== null && typeof value.localOnly !== 'boolean') {
        fail(`${role} provider selection.localOnly must be null or a boolean.`);
    }

    return completeValue(
        {
            providerId: value.providerId,
            modelId: value.modelId,
            localOnly: value.localOnly
        }
    );
}

function immutableRoleRoutes(role, value) {
    assertClosedRecord(value, ROUTE_KEYS, `${role} provider routes`);
    const defaultSelection = immutableSelection(role, value.default);
    const localSelection = immutableSelection(role, value.localOnly);
    if (localSelection && localSelection.localOnly !== true) {
        fail(`${role} localOnly route must identify a local-only selection.`);
    }
    return completeValue(
        {
            default: defaultSelection,
            localOnly: localSelection
        }
    );
}

function immutableSelections(value) {
    assertClosedRecord(value, AI_RUNTIME_ROLES, 'AI provider selections');
    return completeValue(
        {
            llm: immutableRoleRoutes('llm', value.llm),
            stt: immutableRoleRoutes('stt', value.stt),
            tts: immutableRoleRoutes('tts', value.tts)
        }
    );
}

function immutableSpeechSelections(value) {
    try {
        assertClosedRecord(value, SPEECH_ROLES, 'AI speech provider selections');
        return completeValue(
            {
                stt: immutableRoleRoutes('stt', value.stt),
                tts: immutableRoleRoutes('tts', value.tts)
            }
        );
    } catch (error) {
        if (error?.code === 'ARCANE_AI_PROVIDER_RUNTIME_INVALID'
            && !Object.hasOwn(error, 'reason')) {
            error.reason = 'speech-configuration-contract-mismatch';
        }
        throw error;
    }
}

function immutableStartupOptions(options) {
    if (options === undefined) {
        return completeValue({
            startLanguageModel: true,
            startMuted: true,
            startTranscription: false,
            signal: null
        });
    }

    assertPlainObject(options, 'AI provider startup options');
    const descriptors = Object.getOwnPropertyDescriptors(options);
    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === 'symbol'
            || (key !== 'startLanguageModel'
                && key !== 'startMuted'
                && key !== 'startTranscription'
                && key !== 'signal')) {
            fail('AI provider startup options contain an unknown option.');
        }
        if (!Object.hasOwn(descriptors[key], 'value')) {
            fail(`AI provider startup options.${key} must be a data property.`);
        }
    }
    const startLanguageModel = Object.hasOwn(
        descriptors,
        'startLanguageModel'
    )
        ? descriptors.startLanguageModel.value
        : true;
    const startMuted = Object.hasOwn(descriptors, 'startMuted')
        ? descriptors.startMuted.value
        : true;
    const startTranscription = Object.hasOwn(descriptors, 'startTranscription')
        ? descriptors.startTranscription.value
        : false;
    const signal = Object.hasOwn(descriptors, 'signal')
        ? descriptors.signal.value
        : null;
    if (typeof startLanguageModel !== 'boolean') {
        fail('AI startup startLanguageModel must be a boolean.');
    }
    if (typeof startMuted !== 'boolean') {
        fail('AI startup startMuted must be a boolean.');
    }
    if (typeof startTranscription !== 'boolean') {
        fail('AI startup startTranscription must be a boolean.');
    }
    assertAbortSignal(signal);
    return completeValue({
        startLanguageModel,
        startMuted,
        startTranscription,
        signal
    });
}

function immutableInspectionOptions(options) {
    assertPlainObject(options, 'AI provider inspection options');
    const descriptors = Object.getOwnPropertyDescriptors(options);
    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === 'symbol'
            || (key !== 'localOnly' && key !== 'signal')) {
            fail('AI provider inspection options contain an unknown option.');
        }
        if (!Object.hasOwn(descriptors[key], 'value')) {
            fail(`AI provider inspection options.${key} must be a data property.`);
        }
    }
    const localOnly = Object.hasOwn(descriptors, 'localOnly')
        ? descriptors.localOnly.value
        : false;
    const signal = Object.hasOwn(descriptors, 'signal')
        ? descriptors.signal.value
        : null;
    if (typeof localOnly !== 'boolean') {
        fail('AI provider inspection localOnly must be a boolean.');
    }
    assertAbortSignal(signal);
    return completeValue({localOnly, signal});
}

function nullableTupleIdentifier(value) {
    return typeof value === 'string' && value.trim()
        ? value
        : null;
}

function immutableProgress(value) {
    assertClosedRecord(
        value,
        ['phase', 'completed', 'total', 'unit', 'heartbeat'],
        'AI provider progress'
    );
    return completeValue(
        {
            phase: value.phase,
            completed: value.completed,
            total: value.total,
            unit: value.unit,
            heartbeat: value.heartbeat
        }
    );
}

function stateError(error, fallbackCode) {
    const code = typeof error?.code === 'string'
        && /^[A-Z][A-Z0-9_]*$/.test(error.code)
        ? error.code
        : fallbackCode;
    const fallbackMessage = code === 'ARCANE_AI_REQUEST_ABORTED'
        || code === 'AI_REQUEST_ABORTED'
        ? 'The AI operation was cancelled.'
        : code.includes('AUTHORITY') || code.includes('PROVENANCE')
            ? 'The selected AI model could not be used.'
            : code.includes('UNAVAILABLE') || code.includes('NOT_REGISTERED')
                ? 'The selected AI provider is unavailable.'
                : 'The selected AI provider operation failed.';
    const message = typeof error?.message === 'string' && error.message
        ? error.message
        : fallbackMessage;
    return completeValue(
        {
            code,
            message
        }
    );
}

function roleRecord(role, selection, overrides = {}) {
    return {
        role,
        state: selection ? 'unloaded' : 'unavailable',
        providerId: selection?.providerId ?? null,
        modelId: selection?.modelId ?? null,
        localOnly: selection?.localOnly ?? null,
        loaded: false,
        busy: false,
        operationId: null,
        progress: null,
        error: null,
        ...overrides
    };
}

function providerKey(role, providerId) {
    return `${role}:${providerId}`;
}

function validateProvider(provider) {
    const existing = PROVIDER_RECORDS.get(provider);
    if (existing) {
        return existing;
    }
    assertPlainObject(provider, 'AI provider');
    if (provider.protocol !== AI_PROVIDER_PROTOCOL) {
        fail(`AI provider.protocol must equal ${AI_PROVIDER_PROTOCOL}.`);
    }
    assertRole(provider.role);
    assertIdentifier(provider.id, 'AI provider.id');
    if (typeof provider.localOnly !== 'boolean') {
        fail('AI provider.localOnly must be a boolean.');
    }
    for (const method of PROVIDER_METHODS) {
        if (typeof provider[method] !== 'function') {
            fail(`AI provider.${method} must be a function.`);
        }
    }
    const record = {
        protocol: AI_PROVIDER_PROTOCOL,
        role: provider.role,
        id: provider.id,
        localOnly: provider.localOnly
    };
    for (const method of PROVIDER_METHODS) {
        record[method] = provider[method].bind(provider);
    }
    const admitted = completeValue(record);
    PROVIDER_RECORDS.set(provider, admitted);
    return admitted;
}

function speechProviderReplacementError(code, reason, message, cause) {
    const error = cause === undefined
        ? new Error(message)
        : new Error(message, {cause});
    error.code = code;
    error.reason = reason;
    return error;
}

function validateSpeechProviderReplacementProvider(provider, role, label) {
    let admitted;
    try {
        admitted = validateProvider(provider);
    } catch (cause) {
        throw speechProviderReplacementError(
            'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_PROVIDER_CONTRACT_MISMATCH',
            'speech-provider-replacement-provider-contract-mismatch',
            `${label} must implement the ${AI_PROVIDER_PROTOCOL} ${role} provider contract.`,
            cause
        );
    }
    if (admitted.role !== role) {
        throw speechProviderReplacementError(
            'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_PROVIDER_ROLE_MISMATCH',
            'speech-provider-replacement-provider-role-mismatch',
            `${label}.role must equal ${role}.`
        );
    }
    return admitted;
}

function immutableSpeechProviderReplacement(value) {
    try {
        assertClosedRecord(
            value,
            ['providers', 'routes', 'expectedProviders'],
            'AI speech provider replacement'
        );
        assertClosedRecord(
            value.providers,
            SPEECH_ROLES,
            'AI speech provider replacement.providers'
        );
        assertClosedRecord(
            value.expectedProviders,
            SPEECH_ROLES,
            'AI speech provider replacement.expectedProviders'
        );
    } catch (cause) {
        throw speechProviderReplacementError(
            'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_CONTRACT_MISMATCH',
            'speech-provider-replacement-contract-mismatch',
            'AI speech provider replacement must be a closed providers, routes, and expectedProviders record.',
            cause
        );
    }

    let routes;
    try {
        routes = immutableSpeechSelections(value.routes);
    } catch (cause) {
        throw speechProviderReplacementError(
            'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_ROUTE_CONTRACT_MISMATCH',
            'speech-provider-replacement-route-contract-mismatch',
            'AI speech provider replacement.routes must be a closed STT/TTS route record.',
            cause
        );
    }

    const providers = {};
    const expectedProviders = {};
    const replacementProviderCount = SPEECH_ROLES.filter(
        function hasSpeechReplacementProvider(role) {
            return value.providers[role] !== null;
        }
    ).length;
    const expectedProviderCount = SPEECH_ROLES.filter(
        function hasExpectedSpeechProvider(role) {
            return value.expectedProviders[role] !== null;
        }
    ).length;
    if (replacementProviderCount !== 0
        && replacementProviderCount !== SPEECH_ROLES.length) {
        throw speechProviderReplacementError(
            'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_PROVIDER_PAIR_MISMATCH',
            'speech-provider-replacement-provider-pair-mismatch',
            'AI speech provider replacement must supply both replacement providers or null for both.'
        );
    }
    const removal = replacementProviderCount === 0;
    if (removal && expectedProviderCount !== SPEECH_ROLES.length) {
        throw speechProviderReplacementError(
            'ARCANE_AI_SPEECH_PROVIDER_REMOVAL_EXPECTED_PROVIDER_REQUIRED',
            'speech-provider-removal-expected-provider-required',
            'AI speech provider removal requires exact expected STT and TTS provider identities.'
        );
    }
    for (const role of SPEECH_ROLES) {
        const provider = removal
            ? null
            : validateSpeechProviderReplacementProvider(
                value.providers[role],
                role,
                `AI speech provider replacement.providers.${role}`
            );
        const expectedValue = value.expectedProviders[role];
        if (expectedValue !== null) {
            expectedProviders[role] = validateSpeechProviderReplacementProvider(
                expectedValue,
                role,
                `AI speech provider replacement.expectedProviders.${role}`
            );
        } else {
            expectedProviders[role] = null;
        }
        if (removal) {
            if (routes[role].default || routes[role].localOnly) {
                throw speechProviderReplacementError(
                    'ARCANE_AI_SPEECH_PROVIDER_REMOVAL_ROUTE_NOT_EMPTY',
                    'speech-provider-removal-route-not-empty',
                    `AI speech provider removal routes for ${role} must both be null.`
                );
            }
        } else if (!routes[role].default) {
            throw speechProviderReplacementError(
                'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_DEFAULT_ROUTE_REQUIRED',
                'speech-provider-replacement-default-route-required',
                `AI speech provider replacement.routes.${role}.default must select the replacement provider.`
            );
        }
        for (const routeName of ROUTE_KEYS) {
            const selection = routes[role][routeName];
            if (!selection) {
                continue;
            }
            if (!provider
                || selection.providerId !== provider.id
                || selection.localOnly !== provider.localOnly) {
                throw speechProviderReplacementError(
                    'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_ROUTE_PROVIDER_MISMATCH',
                    'speech-provider-replacement-route-provider-mismatch',
                    `AI speech provider replacement ${role} ${routeName} route must match its replacement provider identity and locality.`
                );
            }
        }
        providers[role] = provider;
    }

    return completeValue(
        {
            providers: completeValue(providers),
            routes,
            expectedProviders: completeValue(expectedProviders),
            removal
        }
    );
}

function immutableSpeechProviderRoleReplacement(role, value) {
    if (!SPEECH_ROLES.includes(role)) {
        throw speechProviderReplacementError(
            'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_CONTRACT_MISMATCH',
            'speech-provider-replacement-contract-mismatch',
            'AI speech provider role replacement requires role stt or tts.'
        );
    }
    try {
        assertClosedRecord(
            value,
            ['provider', 'routes', 'expectedProvider'],
            'AI speech provider role replacement'
        );
    } catch (cause) {
        throw speechProviderReplacementError(
            'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_CONTRACT_MISMATCH',
            'speech-provider-replacement-contract-mismatch',
            'AI speech provider role replacement must be a closed provider, routes, and expectedProvider record.',
            cause
        );
    }

    let routes;
    try {
        routes = immutableRoleRoutes(role, value.routes);
    } catch (cause) {
        throw speechProviderReplacementError(
            'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_ROUTE_CONTRACT_MISMATCH',
            'speech-provider-replacement-route-contract-mismatch',
            `AI speech provider role replacement.routes must be a closed ${role.toUpperCase()} route record.`,
            cause
        );
    }
    const removal = value.provider === null;
    const provider = removal
        ? null
        : validateSpeechProviderReplacementProvider(
            value.provider,
            role,
            'AI speech provider role replacement.provider'
        );
    const expectedProvider = value.expectedProvider === null
        ? null
        : validateSpeechProviderReplacementProvider(
            value.expectedProvider,
            role,
            'AI speech provider role replacement.expectedProvider'
        );
    if (removal && expectedProvider === null) {
        throw speechProviderReplacementError(
            'ARCANE_AI_SPEECH_PROVIDER_REMOVAL_EXPECTED_PROVIDER_REQUIRED',
            'speech-provider-removal-expected-provider-required',
            'AI speech provider role removal requires its exact expected provider identity.'
        );
    }
    if (removal && (routes.default || routes.localOnly)) {
        throw speechProviderReplacementError(
            'ARCANE_AI_SPEECH_PROVIDER_REMOVAL_ROUTE_NOT_EMPTY',
            'speech-provider-removal-route-not-empty',
            `AI speech provider removal routes for ${role} must both be null.`
        );
    }
    if (!removal && !routes.default) {
        throw speechProviderReplacementError(
            'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_DEFAULT_ROUTE_REQUIRED',
            'speech-provider-replacement-default-route-required',
            'AI speech provider role replacement.routes.default must select the replacement provider.'
        );
    }
    for (const routeName of ROUTE_KEYS) {
        const selection = routes[routeName];
        if (!selection) {
            continue;
        }
        if (!provider
            || selection.providerId !== provider.id
            || selection.localOnly !== provider.localOnly) {
            throw speechProviderReplacementError(
                'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_ROUTE_PROVIDER_MISMATCH',
                'speech-provider-replacement-route-provider-mismatch',
                `AI speech provider role replacement ${role} ${routeName} route must match its replacement provider identity and locality.`
            );
        }
    }
    return completeValue({role, provider, routes, expectedProvider, removal});
}

function validateProviderStatus(status) {
    assertPlainObject(status, 'AI provider status');
    if (typeof status.state !== 'string'
        || typeof status.loaded !== 'boolean'
        || typeof status.busy !== 'boolean') {
        fail('AI provider status must include state, loaded, and busy values.');
    }
    return status;
}

function validateInspection(inspection, selection) {
    assertPlainObject(inspection, 'AI provider inspection');
    if (typeof inspection.available !== 'boolean') {
        fail('AI provider inspection.available must be a boolean.');
    }
    if (!inspection.available) {
        const code = typeof inspection.code === 'string' && inspection.code.length > 0
            ? inspection.code
            : 'ARCANE_AI_PROVIDER_AUTHORITY_BLOCKED';
        const message = typeof inspection.message === 'string' && inspection.message.length > 0
            ? inspection.message
            : 'The selected AI provider is unavailable.';
        throw operationError(message, code);
    }
    assertPlainObject(inspection.authority, 'AI provider inspection.authority');
    if (inspection.authority.protocol !== AI_MODEL_AUTHORITY_PROTOCOL
        || inspection.authority.providerId !== selection.providerId
        || inspection.authority.modelId !== selection.modelId) {
        throw operationError(
            'The selected AI provider returned a different model authority.',
            'ARCANE_AI_MODEL_AUTHORITY_REQUIRED'
        );
    }
    return inspection;
}

function createRoleSlot(role) {
    return {
        role,
        routes: completeValue({default: null, localOnly: null}),
        selection: null,
        generation: 0,
        operationSequence: 0,
        requestSequence: 0,
        loadController: null,
        loadPromise: null,
        unloadPromise: null,
        disposePromise: null,
        requestQueue: [],
        request: null,
        disposed: false,
        ready: false
    };
}

export class AIProviderRuntime {
    #providers = new Map();
    #slots = completeValue(
        {
            llm: createRoleSlot('llm'),
            stt: createRoleSlot('stt'),
            tts: createRoleSlot('tts')
        }
    );
    #speechMuted = true;
    #speechDesiredMuted = true;
    #speechTransition = Promise.resolve();
    #speechTransitionOwners = 0;
    #unsubscribeIntents = null;
    #closed = false;
    #closing = false;
    #configured = false;
    #configuring = false;
    #disposeAllPromise = null;
    #disposeAllCompletedProviders = new Set();

    constructor(authority) {
        if (authority !== RUNTIME_CONSTRUCTION_AUTHORITY) {
            throw operationError(
                'AIProviderRuntime is singleton-owned; use getAIProviderRuntime().',
                'ARCANE_AI_RUNTIME_SINGLETON_REQUIRED'
            );
        }
        const runtime = this;
        this.#unsubscribeIntents = subscribeAIRuntimeIntents(
            function handleAIProviderRuntimeIntent(intent) {
                runtime.#acceptIntent(intent);
            }
        );
    }

    get protocol() {
        return AI_PROVIDER_RUNTIME_PROTOCOL;
    }

    get speechMuted() {
        return this.#speechMuted;
    }

    get configured() {
        return this.#configured;
    }

    register(provider) {
        this.#assertOpen();
        this.#assertNotConfiguring();
        const admitted = validateProvider(provider);
        const key = providerKey(admitted.role, admitted.id);
        const existing = this.#providers.get(key);
        if (existing && existing !== admitted) {
            throw operationError(
                `AI provider ${key} is already registered.`,
                'ARCANE_AI_PROVIDER_ALREADY_REGISTERED'
            );
        }
        const slot = this.#slots[admitted.role];
        const nextRoutes = {
            default: slot.routes.default,
            localOnly: slot.routes.localOnly
        };
        let reconciled = false;
        for (const routeName of ROUTE_KEYS) {
            const selection = slot.routes[routeName];
            if (!selection || selection.providerId !== admitted.id) {
                continue;
            }
            if (selection.localOnly !== null
                && selection.localOnly !== admitted.localOnly) {
                throw operationError(
                    `AI provider ${key} does not match the configured ${routeName} route locality.`,
                    'ARCANE_AI_PROVIDER_LOCALITY_MISMATCH'
                );
            }
            if (selection.localOnly === null) {
                nextRoutes[routeName] = completeValue(
                    {
                        providerId: selection.providerId,
                        modelId: selection.modelId,
                        localOnly: admitted.localOnly
                    }
                );
                reconciled = true;
            }
        }
        if (reconciled
            && admitted.localOnly
            && !nextRoutes.localOnly
            && nextRoutes.default?.providerId === admitted.id) {
            nextRoutes.localOnly = nextRoutes.default;
        }
        this.#providers.set(key, admitted);
        if (reconciled) {
            const previousSelection = slot.selection;
            slot.routes = completeValue(nextRoutes);
            if (previousSelection?.providerId === admitted.id
                && previousSelection.localOnly === null) {
                slot.generation += 1;
                slot.selection = slot.routes.default?.providerId === admitted.id
                    && slot.routes.default.modelId === previousSelection.modelId
                    ? slot.routes.default
                    : Object.values(slot.routes).find(
                        function findReconciledAIProviderSelection(selection) {
                            return selection?.providerId === admitted.id
                                && selection.modelId === previousSelection.modelId;
                        }
                    ) ?? previousSelection;
                publishAIRuntimeRoleState(
                    admitted.role,
                    roleRecord(admitted.role, slot.selection)
                );
            }
        }

        return this.#createProviderUnregisterHandle(admitted);
    }

    unregister(role, providerId, expectedProvider = null) {
        this.#assertOpen();
        this.#assertNotConfiguring();
        assertRole(role);
        assertIdentifier(providerId, 'AI provider id');
        const key = providerKey(role, providerId);
        const provider = this.#providers.get(key);
        if (!provider || (expectedProvider && provider !== expectedProvider)) {
            return false;
        }

        const slot = this.#slots[role];
        if (slot.routes.default?.providerId === providerId
            || slot.routes.localOnly?.providerId === providerId) {
            throw operationError(
                `AI provider ${key} must be deselected before it is unregistered.`,
                'ARCANE_AI_PROVIDER_SELECTED'
            );
        }
        this.#providers.delete(key);
        this.#disposeAllCompletedProviders.delete(provider);
        return true;
    }

    hasProvider(role, providerId) {
        assertRole(role);
        assertIdentifier(providerId, 'AI provider id');
        return this.#providers.has(providerKey(role, providerId));
    }

    ownsProvider(role, expectedProvider) {
        if (!ROLE_SET.has(role)) {
            throw speechProviderReplacementError(
                'ARCANE_AI_PROVIDER_IDENTITY_ROLE_INVALID',
                'provider-identity-role-invalid',
                `AI provider identity role must be one of ${AI_RUNTIME_ROLES.join(', ')}.`
            );
        }

        let admitted;
        try {
            admitted = validateProvider(expectedProvider);
        } catch (cause) {
            throw speechProviderReplacementError(
                'ARCANE_AI_PROVIDER_IDENTITY_CONTRACT_MISMATCH',
                'provider-identity-contract-mismatch',
                `Expected ${role} provider identity must implement the ${AI_PROVIDER_PROTOCOL} provider contract.`,
                cause
            );
        }
        if (admitted.role !== role) {
            throw speechProviderReplacementError(
                'ARCANE_AI_PROVIDER_IDENTITY_ROLE_MISMATCH',
                'provider-identity-role-mismatch',
                `Expected provider identity role ${admitted.role} does not match ${role}.`
            );
        }

        return this.#providers.get(providerKey(role, admitted.id)) === admitted;
    }

    providerIdentity(role, providerId) {
        assertRole(role);
        assertIdentifier(providerId, 'AI provider id');
        const provider = this.#providers.get(providerKey(role, providerId)) ?? null;
        if (!provider) {
            return null;
        }
        return completeValue(
            {
                protocol: provider.protocol,
                role: provider.role,
                id: provider.id,
                localOnly: provider.localOnly
            }
        );
    }

    selection(role, options = {}) {
        assertRole(role);
        assertPlainObject(options, 'AI provider route options');
        for (const key of Reflect.ownKeys(options)) {
            if (key !== 'localOnly') {
                fail('AI provider route options contain an unknown option.');
            }
        }
        const localOnly = Object.hasOwn(options, 'localOnly')
            ? options.localOnly
            : false;
        if (typeof localOnly !== 'boolean') {
            fail('AI provider route localOnly must be a boolean.');
        }
        const slot = this.#slots[role];
        return localOnly ? slot.routes.localOnly : slot.routes.default;
    }

    ownsSelection(role, providerId, options = {}) {
        assertRole(role);
        assertIdentifier(providerId, 'AI provider id');
        return this.selection(role, options)?.providerId === providerId;
    }

    validateConfiguration(value) {
        this.#assertOpen();
        const selections = immutableSelections(value);
        for (const role of AI_RUNTIME_ROLES) {
            for (const routeName of ROUTE_KEYS) {
                const selection = selections[role][routeName];
                if (!selection) {
                    continue;
                }
                const provider = this.#providers.get(
                    providerKey(role, selection.providerId)
                ) ?? null;
                if (provider && selection.localOnly !== provider.localOnly) {
                    throw operationError(
                        `AI ${role} route ${routeName} does not match provider locality.`,
                        'ARCANE_AI_PROVIDER_LOCALITY_MISMATCH'
                    );
                }
            }
        }
        return selections;
    }

    validateSpeechConfiguration(value) {
        this.#assertOpen();
        const selections = immutableSpeechSelections(value);
        for (const role of SPEECH_ROLES) {
            for (const routeName of ROUTE_KEYS) {
                const selection = selections[role][routeName];
                if (!selection) {
                    continue;
                }
                const provider = this.#providers.get(
                    providerKey(role, selection.providerId)
                ) ?? null;
                if (provider && selection.localOnly !== provider.localOnly) {
                    throw operationError(
                        `AI ${role} route ${routeName} does not match provider locality.`,
                        'ARCANE_AI_PROVIDER_LOCALITY_MISMATCH'
                    );
                }
            }
        }
        return selections;
    }

    configure(value) {
        this.#assertOpen();
        if (this.#configuring) {
            throw operationError(
                'AI provider configuration cannot be changed reentrantly.',
                'ARCANE_AI_CONFIGURATION_REENTRANT'
            );
        }
        const selections = this.validateConfiguration(value);
        for (const role of AI_RUNTIME_ROLES) {
            const slot = this.#slots[role];
            if (this.#roleHasOwnedWork(slot)) {
                throw operationError(
                    `AI role ${role} must be unloaded before it is reconfigured.`,
                    'ARCANE_AI_ROLE_BUSY'
                );
            }
        }

        this.#configuring = true;
        try {
            for (const role of AI_RUNTIME_ROLES) {
                const slot = this.#slots[role];
                slot.generation += 1;
                slot.disposed = false;
                slot.ready = false;
                slot.routes = selections[role];
                slot.selection = selections[role].default;
            }
            this.#speechMuted = true;
            this.#configured = true;
            publishAIRuntimeRolesState(
                {
                    llm: roleRecord('llm', this.#slots.llm.selection),
                    stt: roleRecord('stt', this.#slots.stt.selection),
                    tts: roleRecord('tts', this.#slots.tts.selection)
                }
            );
        } finally {
            this.#configuring = false;
        }
        return selections;
    }

    configureSpeech(value) {
        this.#assertOpen();
        if (this.#configuring) {
            throw operationError(
                'AI speech provider configuration cannot be changed reentrantly.',
                'ARCANE_AI_SPEECH_CONFIGURATION_REENTRANT'
            );
        }
        const selections = this.validateSpeechConfiguration(value);
        for (const role of SPEECH_ROLES) {
            const slot = this.#slots[role];
            if (this.#roleHasOwnedWork(slot)) {
                throw operationError(
                    `AI role ${role} must be unloaded before it is reconfigured.`,
                    'ARCANE_AI_ROLE_BUSY'
                );
            }
        }

        this.#configuring = true;
        try {
            for (const role of SPEECH_ROLES) {
                const slot = this.#slots[role];
                slot.generation += 1;
                slot.disposed = false;
                slot.ready = false;
                slot.routes = selections[role];
                slot.selection = selections[role].default;
            }
            this.#speechDesiredMuted = true;
            this.#speechMuted = true;
            this.#configured = true;
            publishAIRuntimeRolesState(
                {
                    llm: this.status('llm'),
                    stt: roleRecord('stt', this.#slots.stt.selection),
                    tts: roleRecord('tts', this.#slots.tts.selection)
                }
            );
        } finally {
            this.#configuring = false;
        }
        return selections;
    }

    replaceSpeechProvider(role, value) {
        this.#assertOpen();
        if (this.#configuring) {
            throw speechProviderReplacementError(
                'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_REENTRANT',
                'speech-provider-replacement-reentrant',
                'AI speech provider replacement cannot be committed reentrantly.'
            );
        }
        this.#configuring = true;
        try {
            return this.#commitSpeechProviderRoleReplacement(role, value);
        } finally {
            this.#configuring = false;
        }
    }

    #pendingSpeechProviderHydrationMatches(role, slot, provider, routes) {
        if (!provider || !slot.selection || !routes.default) {
            return false;
        }
        const pending = slot.selection;
        if (this.#providers.has(providerKey(role, pending.providerId))
            || provider.id !== pending.providerId
            || routes.default.providerId !== pending.providerId
            || routes.default.modelId !== pending.modelId) {
            return false;
        }
        const currentSelections = [
            slot.selection,
            slot.routes.default,
            slot.routes.localOnly
        ].filter(Boolean);
        return currentSelections.length > 0
            && currentSelections.every(selection =>
                selection.providerId === pending.providerId
                && selection.modelId === pending.modelId
                && selection.localOnly === null
            );
    }

    #commitSpeechProviderRoleReplacement(role, value) {
        const replacement = immutableSpeechProviderRoleReplacement(role, value);
        const currentState = getAIRuntimeState();
        const slot = this.#slots[role];
        const roleState = currentState.roles[role];
        if (this.#roleHasOwnedWork(slot)
            || roleState.loaded
            || roleState.busy
            || (role === 'tts' && this.#speechTransitionOwners > 0)) {
            throw speechProviderReplacementError(
                'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_ROLE_NOT_UNLOADED',
                'speech-provider-replacement-role-not-unloaded',
                `AI role ${role} must be fully unloaded with no owned work before speech provider replacement.`
            );
        }

        const expected = replacement.expectedProvider;
        if (expected) {
            const registered = this.#providers.get(
                providerKey(role, expected.id)
            ) ?? null;
            if (registered !== expected) {
                throw speechProviderReplacementError(
                    'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_EXPECTED_PROVIDER_MISMATCH',
                    'speech-provider-replacement-expected-provider-mismatch',
                    `AI role ${role} expected provider identity is no longer registered.`
                );
            }
            const routeProviderMismatch = ROUTE_KEYS.some(
                function hasUnexpectedSelectedSpeechProvider(routeName) {
                    const selection = slot.routes[routeName];
                    return selection !== null
                        && selection.providerId !== expected.id;
                }
            );
            if (slot.routes.default?.providerId !== expected.id
                || slot.selection?.providerId !== expected.id
                || routeProviderMismatch) {
                throw speechProviderReplacementError(
                    'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_SELECTED_PROVIDER_MISMATCH',
                    'speech-provider-replacement-selected-provider-mismatch',
                    `AI role ${role} selected routes no longer belong to the expected provider identity.`
                );
            }
        } else if ((slot.routes.default
            || slot.routes.localOnly
            || slot.selection)
            && !this.#pendingSpeechProviderHydrationMatches(
                role,
                slot,
                replacement.provider,
                replacement.routes
            )) {
            throw speechProviderReplacementError(
                'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_EXPECTED_PROVIDER_REQUIRED',
                'speech-provider-replacement-expected-provider-required',
                `AI role ${role} has a selected provider, so replacement requires its exact expected provider identity.`
            );
        }

        const provider = replacement.provider;
        if (provider) {
            const registeredAtReplacementKey = this.#providers.get(
                providerKey(role, provider.id)
            ) ?? null;
            if (registeredAtReplacementKey
                && registeredAtReplacementKey !== expected) {
                throw speechProviderReplacementError(
                    'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_PROVIDER_ID_COLLISION',
                    'speech-provider-replacement-provider-id-collision',
                    `AI role ${role} replacement provider id is registered by a different provider identity.`
                );
            }
        }

        const currentProvider = this.#providerFor(slot);
        const inspectedProviders = new Set([currentProvider, expected, provider]);
        inspectedProviders.delete(null);
        for (const inspected of inspectedProviders) {
            let providerStatus;
            try {
                providerStatus = validateProviderStatus(inspected.status());
            } catch (cause) {
                throw speechProviderReplacementError(
                    'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_PROVIDER_STATUS_INVALID',
                    'speech-provider-replacement-provider-status-invalid',
                    `AI role ${role} replacement boundary received an invalid provider status.`,
                    cause
                );
            }
            if (providerStatus.state !== 'unloaded'
                || providerStatus.loaded
                || providerStatus.busy) {
                throw speechProviderReplacementError(
                    'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_PROVIDER_NOT_UNLOADED',
                    'speech-provider-replacement-provider-not-unloaded',
                    `AI role ${role} replacement boundary requires selected, old, and new providers to report unloaded and idle.`
                );
            }
        }
        if (expected) {
            this.#providers.delete(providerKey(role, expected.id));
            this.#disposeAllCompletedProviders.delete(expected);
        }
        if (provider) {
            this.#providers.set(providerKey(role, provider.id), provider);
            this.#disposeAllCompletedProviders.delete(provider);
        }
        slot.generation += 1;
        slot.disposed = false;
        slot.ready = false;
        slot.routes = replacement.routes;
        slot.selection = replacement.routes.default;
        this.#configured = true;
        publishAIRuntimeRoleState(role, roleRecord(role, slot.selection));

        return completeValue(
            {
                role,
                routes: replacement.routes,
                unregister: replacement.removal
                    ? null
                    : this.#createProviderUnregisterHandle(provider)
            }
        );
    }

    replaceSpeechProviders(value) {
        this.#assertOpen();
        if (this.#configuring) {
            throw speechProviderReplacementError(
                'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_REENTRANT',
                'speech-provider-replacement-reentrant',
                'AI speech provider replacement cannot be committed reentrantly.'
            );
        }
        this.#configuring = true;
        try {
            return this.#commitSpeechProviderReplacement(value);
        } finally {
            this.#configuring = false;
        }
    }

    #commitSpeechProviderReplacement(value) {
        const replacement = immutableSpeechProviderReplacement(value);
        const currentState = getAIRuntimeState();
        for (const role of SPEECH_ROLES) {
            const slot = this.#slots[role];
            const roleState = currentState.roles[role];
            if (this.#roleHasOwnedWork(slot)
                || roleState.loaded
                || roleState.busy
                || this.#speechTransitionOwners > 0) {
                throw speechProviderReplacementError(
                    'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_ROLE_NOT_UNLOADED',
                    'speech-provider-replacement-role-not-unloaded',
                    `AI role ${role} must be fully unloaded with no owned work before speech provider replacement.`
                );
            }

            const expected = replacement.expectedProviders[role];
            if (expected) {
                const registered = this.#providers.get(
                    providerKey(role, expected.id)
                ) ?? null;
                if (registered !== expected) {
                    throw speechProviderReplacementError(
                        'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_EXPECTED_PROVIDER_MISMATCH',
                        'speech-provider-replacement-expected-provider-mismatch',
                        `AI role ${role} expected provider identity is no longer registered.`
                    );
                }
                const routeProviderMismatch = ROUTE_KEYS.some(
                    function hasUnexpectedSelectedSpeechProvider(routeName) {
                        const selection = slot.routes[routeName];
                        return selection !== null
                            && selection.providerId !== expected.id;
                    }
                );
                if (slot.routes.default?.providerId !== expected.id
                    || slot.selection?.providerId !== expected.id
                    || routeProviderMismatch) {
                    throw speechProviderReplacementError(
                        'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_SELECTED_PROVIDER_MISMATCH',
                        'speech-provider-replacement-selected-provider-mismatch',
                        `AI role ${role} selected routes no longer belong to the expected provider identity.`
                    );
                }
            } else if ((slot.routes.default
                || slot.routes.localOnly
                || slot.selection)
                && !this.#pendingSpeechProviderHydrationMatches(
                    role,
                    slot,
                    replacement.providers[role],
                    replacement.routes[role]
                )) {
                throw speechProviderReplacementError(
                    'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_EXPECTED_PROVIDER_REQUIRED',
                    'speech-provider-replacement-expected-provider-required',
                    `AI role ${role} has a selected provider, so replacement requires its exact expected provider identity.`
                );
            }

            const provider = replacement.providers[role];
            if (provider) {
                const registeredAtReplacementKey = this.#providers.get(
                    providerKey(role, provider.id)
                ) ?? null;
                if (registeredAtReplacementKey
                    && registeredAtReplacementKey !== expected) {
                    throw speechProviderReplacementError(
                        'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_PROVIDER_ID_COLLISION',
                        'speech-provider-replacement-provider-id-collision',
                        `AI role ${role} replacement provider id is registered by a different provider identity.`
                    );
                }
            }

            const currentProvider = this.#providerFor(slot);
            const inspectedProviders = new Set([
                currentProvider,
                expected,
                provider
            ]);
            inspectedProviders.delete(null);
            for (const inspected of inspectedProviders) {
                if (!inspected) {
                    continue;
                }
                let providerStatus;
                try {
                    providerStatus = validateProviderStatus(inspected.status());
                } catch (cause) {
                    throw speechProviderReplacementError(
                        'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_PROVIDER_STATUS_INVALID',
                        'speech-provider-replacement-provider-status-invalid',
                        `AI role ${role} replacement boundary received an invalid provider status.`,
                        cause
                    );
                }
                if (providerStatus.state !== 'unloaded'
                    || providerStatus.loaded
                    || providerStatus.busy) {
                    throw speechProviderReplacementError(
                        'ARCANE_AI_SPEECH_PROVIDER_REPLACEMENT_PROVIDER_NOT_UNLOADED',
                        'speech-provider-replacement-provider-not-unloaded',
                        `AI role ${role} replacement boundary requires selected, old, and new providers to report unloaded and idle.`
                    );
                }
            }
        }
        for (const role of SPEECH_ROLES) {
            const expected = replacement.expectedProviders[role];
            const provider = replacement.providers[role];
            if (expected) {
                this.#providers.delete(providerKey(role, expected.id));
                this.#disposeAllCompletedProviders.delete(expected);
            }
            if (provider) {
                this.#providers.set(providerKey(role, provider.id), provider);
                this.#disposeAllCompletedProviders.delete(provider);
            }

            const slot = this.#slots[role];
            slot.generation += 1;
            slot.disposed = false;
            slot.ready = false;
            slot.routes = replacement.routes[role];
            slot.selection = replacement.routes[role].default;
        }
        this.#speechDesiredMuted = true;
        this.#speechMuted = true;
        this.#configured = true;
        publishAIRuntimeRolesState(
            {
                llm: currentState.roles.llm,
                stt: roleRecord('stt', this.#slots.stt.selection),
                tts: roleRecord('tts', this.#slots.tts.selection)
            }
        );

        return completeValue(
            {
                routes: replacement.routes,
                unregisters: completeValue(
                    {
                        stt: replacement.removal
                            ? null
                            : this.#createProviderUnregisterHandle(
                                replacement.providers.stt
                            ),
                        tts: replacement.removal
                            ? null
                            : this.#createProviderUnregisterHandle(
                                replacement.providers.tts
                            )
                    }
                )
            }
        );
    }

    configureFromTuple(tuple) {
        if (!Array.isArray(tuple) || tuple.length !== 6) {
            fail('AI preference tuple must contain exactly six entries.');
        }

        const providerIds = {
            llm: nullableTupleIdentifier(tuple[0]),
            stt: nullableTupleIdentifier(tuple[1]),
            tts: nullableTupleIdentifier(tuple[2])
        };
        const modelIds = {
            llm: nullableTupleIdentifier(tuple[3]),
            tts: nullableTupleIdentifier(tuple[4]),
            stt: nullableTupleIdentifier(tuple[5])
        };
        const selections = {};
        for (const role of AI_RUNTIME_ROLES) {
            const providerId = providerIds[role];
            const modelId = modelIds[role];
            const provider = providerId
                ? this.#providers.get(providerKey(role, providerId)) ?? null
                : null;
            if (!providerId && !modelId) {
                selections[role] = {
                    default: null,
                    localOnly: null
                };
                continue;
            }
            if (!providerId || !modelId) {
                throw operationError(
                    `AI ${role} selection requires both provider and model ids.`,
                    'ARCANE_AI_SELECTION_INCOMPLETE'
                );
            }
            const selection = {
                providerId,
                modelId,
                localOnly: provider?.localOnly ?? null
            };
            selections[role] = {
                default: selection,
                localOnly: provider?.localOnly === true
                    ? {...selection, localOnly: true}
                    : null
            };
        }
        return this.configure(selections);
    }

    status(role = null) {
        if (role === null) {
            return getAIRuntimeState();
        }
        assertRole(role);
        return getAIRuntimeState().roles[role];
    }

    catalog(role) {
        assertRole(role);
        const entries = [];
        for (const provider of this.#providers.values()) {
            if (provider.role !== role) {
                continue;
            }
            const providerCatalog = provider.catalog();
            if (!Array.isArray(providerCatalog)) {
                fail('AI provider.catalog() must synchronously return an array.');
            }
            entries.push(
                completeValue(
                    {
                        providerId: provider.id,
                        localOnly: provider.localOnly,
                        models: completeValue([...providerCatalog])
                    }
                )
            );
        }
        return completeValue(entries);
    }

    async inspect(role, options = {}) {
        this.#assertOpen();
        this.#assertNotConfiguring();
        assertRole(role);
        const {localOnly, signal} = immutableInspectionOptions(options);
        this.#assertOpen();
        this.#assertNotConfiguring();
        if (signal?.aborted) {
            throw normalizedAbort();
        }
        const slot = this.#slots[role];
        const generation = slot.generation;
        const selection = this.selection(role, {localOnly});
        if (!selection) {
            return completeValue(
                {
                    available: false,
                    code: 'ARCANE_AI_ROLE_NOT_SELECTED',
                    message: `No ${role} provider and model are selected.`
                }
            );
        }
        const provider = this.#providers.get(
            providerKey(role, selection.providerId)
        ) ?? null;
        if (!provider) {
            return completeValue(
                {
                    available: false,
                    code: 'ARCANE_AI_PROVIDER_UNAVAILABLE',
                    message: `The selected ${role} provider is not registered.`
                }
            );
        }

        let inspection;
        try {
            if (signal?.aborted) {
                throw normalizedAbort();
            }
            inspection = await provider.inspect(
                selection,
                {role, signal}
            );
            if (signal?.aborted) {
                throw normalizedAbort();
            }
        } catch (error) {
            if (isAbort(error, signal)) {
                throw normalizedAbort(error);
            }
            this.#assertOpen();
            this.#assertNotConfiguring();
            this.#assertCurrentOperation(slot, generation, signal);
            const unavailable = stateError(
                error,
                'ARCANE_AI_PROVIDER_AUTHORITY_BLOCKED'
            );
            return completeValue(
                {
                    available: false,
                    code: unavailable.code,
                    message: unavailable.message
                }
            );
        }
        this.#assertOpen();
        this.#assertNotConfiguring();
        this.#assertCurrentOperation(slot, generation, signal);
        try {
            validateInspection(inspection, selection);
            return inspection;
        } catch (error) {
            const unavailable = stateError(
                error,
                'ARCANE_AI_PROVIDER_AUTHORITY_BLOCKED'
            );
            return completeValue(
                {
                    available: false,
                    code: unavailable.code,
                    message: unavailable.message
                }
            );
        }
    }

    async start(options) {
        this.#assertOpen();
        this.#assertNotConfiguring();
        if (!this.#configured) {
            throw operationError(
                'AI provider routes must be configured before startup.',
                'ARCANE_AI_RUNTIME_NOT_CONFIGURED'
            );
        }
        const normalized = immutableStartupOptions(options);
        await this.#speechTransition.catch(
            function retainPriorAIStartupSpeechTransitionFailure() {}
        );
        await Promise.all(
            AI_RUNTIME_ROLES.map(
                function awaitActiveAIProviderUnload(role) {
                    return this.#slots[role].unloadPromise ?? Promise.resolve();
                },
                this
            )
        );
        this.#assertOpen();
        this.#assertNotConfiguring();
        if (normalized.startMuted) {
            await this.setSpeechMuted(true);
        } else {
            this.#speechDesiredMuted = false;
        }
        this.#assertOpen();
        this.#assertNotConfiguring();
        return startAIRuntime(normalized);
    }

    load(role, options = {}) {
        this.#assertOpen();
        this.#assertNotConfiguring();
        assertRole(role);
        assertPlainObject(options, 'AI provider load options');
        for (const key of Reflect.ownKeys(options)) {
            if (key !== 'signal' && key !== 'localOnly') {
                fail('AI provider load options contain an unknown option.');
            }
        }
        const signal = Object.hasOwn(options, 'signal') ? options.signal : null;
        const localOnly = Object.hasOwn(options, 'localOnly')
            ? options.localOnly
            : false;
        assertAbortSignal(signal);
        if (typeof localOnly !== 'boolean') {
            fail('AI provider load localOnly must be a boolean.');
        }
        const slot = this.#slots[role];
        if (slot.disposed) {
            return Promise.reject(
                operationError(
                    `AI role ${role} is disposed and must be explicitly reconfigured.`,
                    'ARCANE_AI_ROLE_DISPOSED'
                )
            );
        }
        if (slot.unloadPromise || slot.disposePromise) {
            return Promise.reject(
                operationError(
                    `AI role ${role} cannot load while cleanup is active.`,
                    'ARCANE_AI_OPERATION_SUPERSEDED'
                )
            );
        }
        if (slot.request || slot.requestQueue.length) {
            return Promise.reject(
                operationError(
                    `AI role ${role} cannot load during active request ownership.`,
                    'ARCANE_AI_ROLE_BUSY'
                )
            );
        }
        if (role === 'tts' && this.#speechDesiredMuted) {
            return Promise.reject(
                operationError(
                    'The TTS role remains unloaded while speech is muted.',
                    'ARCANE_AI_TTS_MUTED'
                )
            );
        }
        const targetSelection = localOnly
            ? slot.routes.localOnly
            : slot.routes.default;
        if (!targetSelection) {
            const code = localOnly
                ? 'AI_LOCAL_MODEL_REQUIRED'
                : 'ARCANE_AI_ROLE_NOT_SELECTED';
            const message = localOnly
                ? `No explicit local-only ${role} route is configured.`
                : `No ${role} provider and model are selected.`;
            return Promise.reject(operationError(message, code));
        }
        if (slot.loadPromise) {
            if (this.#sameSelection(slot.selection, targetSelection)) {
                return slot.loadPromise;
            }
            return Promise.reject(
                operationError(
                    `AI role ${role} is loading a different explicit route.`,
                    'ARCANE_AI_ROUTE_NOT_READY'
                )
            );
        }
        if (slot.ready && this.#sameSelection(slot.selection, targetSelection)) {
            const readyProvider = this.#providers.get(
                providerKey(role, targetSelection.providerId)
            ) ?? null;
            try {
                const readyStatus = readyProvider
                    ? validateProviderStatus(readyProvider.status())
                    : null;
                if (readyStatus?.state === 'ready'
                    && readyStatus.loaded === true
                    && readyStatus.busy === false) {
                    publishAIRuntimeRoleState(
                        role,
                        roleRecord(
                            role,
                            slot.selection,
                            {state: 'ready', loaded: true}
                        )
                    );
                    return Promise.resolve(this.status(role));
                }
                if (readyStatus?.busy === true) {
                    return Promise.reject(
                        operationError(
                            `AI role ${role} cannot load while its provider remains busy.`,
                            'ARCANE_AI_ROLE_BUSY'
                        )
                    );
                }
            } catch {
                // The private ready flag is revoked when provider proof is stale.
            }
            slot.ready = false;
        }
        if (slot.ready && !this.#sameSelection(slot.selection, targetSelection)) {
            return Promise.reject(
                operationError(
                    `AI role ${role} must unload before changing routes.`,
                    'ARCANE_AI_ROUTE_SWITCH_REQUIRES_UNLOAD'
                )
            );
        }
        if (!this.#sameSelection(slot.selection, targetSelection)) {
            slot.generation += 1;
            slot.ready = false;
            slot.selection = targetSelection;
        }

        const provider = this.#providerFor(slot);
        if (!provider) {
            slot.ready = false;
            const error = operationError(
                `The selected ${role} provider is not registered.`,
                'ARCANE_AI_PROVIDER_UNAVAILABLE'
            );
            this.#publishRoleError(slot, error, false);
            return Promise.reject(error);
        }
        if (slot.selection.localOnly === true && provider.localOnly !== true) {
            const error = operationError(
                `The selected ${role} route requires a local-only provider.`,
                'ARCANE_AI_LOCAL_PROVIDER_REQUIRED'
            );
            this.#publishRoleError(slot, error, false);
            return Promise.reject(error);
        }

        slot.generation += 1;
        slot.ready = false;
        const generation = slot.generation;
        const operationId = this.#nextOperationId(slot, 'load');
        const controller = new AbortController();
        slot.loadController = controller;
        const detachSignal = this.#forwardAbort(signal, controller);
        const runtime = this;
        const loadOperation = Promise.resolve().then(
            async function loadAIProviderRole() {
                try {
                    if (controller.signal.aborted) {
                        throw normalizedAbort();
                    }
                    const inspection = await provider.inspect(
                        slot.selection,
                        {role, signal: controller.signal}
                    );
                    validateInspection(inspection, slot.selection);
                    runtime.#assertCurrentOperation(slot, generation, controller.signal);
                    await provider.load(
                        {
                            role,
                            selection: slot.selection,
                            signal: controller.signal,
                            progress: function publishAIProviderLoadProgress(progress) {
                                runtime.#publishLoadProgress(
                                    slot,
                                    generation,
                                    operationId,
                                    progress
                                );
                            }
                        }
                    );
                    runtime.#assertCurrentOperation(slot, generation, controller.signal);
                    const providerStatus = validateProviderStatus(provider.status());
                    if (providerStatus.state !== 'ready'
                        || providerStatus.loaded !== true
                        || providerStatus.busy !== false) {
                        throw operationError(
                            `The selected ${role} provider did not become ready.`,
                            'ARCANE_AI_PROVIDER_NOT_READY'
                        );
                    }
                    slot.ready = true;
                    if (role === 'tts' && !runtime.#speechDesiredMuted) {
                        runtime.#speechMuted = false;
                    }
                    publishAIRuntimeRoleState(
                        role,
                        roleRecord(
                            role,
                            slot.selection,
                            {
                                state: 'ready',
                                loaded: true
                            }
                        )
                    );
                    return runtime.status(role);
                } catch (error) {
                    const normalized = isAbort(error, controller.signal)
                        ? normalizedAbort(error)
                        : error;
                    if (slot.generation === generation && !slot.unloadPromise) {
                        slot.ready = false;
                        if (role === 'tts') {
                            runtime.#speechMuted = true;
                        }
                        runtime.#publishRoleError(slot, normalized, false);
                    }
                    throw normalized;
                } finally {
                    detachSignal();
                    if (slot.generation === generation) {
                        slot.loadController = null;
                    }
                    slot.loadPromise = null;
                }
            }
        );
        slot.loadPromise = loadOperation;
        publishAIRuntimeRoleState(
            role,
            roleRecord(
                role,
                slot.selection,
                {
                    state: 'loading',
                    operationId,
                    progress: {
                        phase: 'loading',
                        completed: 0,
                        total: null,
                        unit: 'items',
                        heartbeat: false
                    }
                }
            )
        );
        return loadOperation;
    }

    unload(role, options = {}) {
        this.#assertNotConfiguring();
        assertRole(role);
        assertPlainObject(options, 'AI provider unload options');
        for (const key of Reflect.ownKeys(options)) {
            if (key !== 'signal') {
                fail('AI provider unload options contain an unknown option.');
            }
        }
        const signal = Object.hasOwn(options, 'signal') ? options.signal : null;
        assertAbortSignal(signal);
        const slot = this.#slots[role];
        if (slot.unloadPromise) {
            return slot.unloadPromise;
        }

        const provider = this.#providerFor(slot);
        const before = this.status(role);
        let providerStatus = null;
        if (provider) {
            try {
                providerStatus = validateProviderStatus(provider.status());
            } catch {
                // Cleanup remains fail-closed when provider status is malformed.
            }
        }
        if (slot.disposed) {
            return Promise.resolve(before);
        }
        const providerOwned = slot.ready
            || providerStatus?.loaded === true
            || providerStatus?.busy === true;
        if (!slot.loadPromise
            && !slot.request
            && slot.requestQueue.length === 0
            && !providerOwned
            && (!provider || providerStatus)) {
            slot.ready = false;
            publishAIRuntimeRoleState(
                role,
                roleRecord(role, slot.selection)
            );
            return Promise.resolve(this.status(role));
        }

        slot.generation += 1;
        const generation = slot.generation;
        slot.ready = false;
        if (role === 'tts') {
            this.#speechMuted = true;
        }
        slot.loadController?.abort();
        const requestCancellation = operationError(
            `AI role ${role} is unloading.`,
            'ARCANE_AI_REQUEST_ABORTED'
        );
        this.#rejectQueuedRoleRequests(slot, requestCancellation);
        slot.request?.controller.abort(requestCancellation);
        const capturedLoad = slot.loadPromise;
        const capturedRequestRecord = slot.request;
        const capturedRequest = capturedRequestRecord?.promise ?? null;
        const unloadOperationId = providerOwned
            ? this.#nextOperationId(slot, 'unload')
            : null;
        const runtime = this;
        const unloadOperation = Promise.resolve().then(async function unloadAIProviderRole() {
            try {
                if (signal?.aborted) {
                    throw normalizedAbort();
                }
                if (capturedRequestRecord?.cancel) {
                    try {
                        await capturedRequestRecord.cancel(requestCancellation);
                    } catch {
                        // Provider unload below remains the authoritative cleanup.
                    }
                }
                await Promise.allSettled(
                    [capturedLoad, capturedRequest].filter(Boolean)
                );
                if (signal?.aborted) {
                    throw normalizedAbort();
                }
                if (provider) {
                    await provider.unload(
                        {
                            role,
                            selection: slot.selection,
                            signal
                        }
                    );
                    const unloadedStatus = validateProviderStatus(provider.status());
                    if (unloadedStatus.loaded || unloadedStatus.busy) {
                        throw operationError(
                            `The selected ${role} provider remained loaded after unload.`,
                            'ARCANE_AI_PROVIDER_UNLOAD_INCOMPLETE'
                        );
                    }
                }
                if (slot.generation === generation) {
                    publishAIRuntimeRoleState(
                        role,
                        roleRecord(role, slot.selection)
                    );
                }
                return runtime.status(role);
            } catch (error) {
                if (slot.generation === generation) {
                    runtime.#publishRoleError(slot, error, providerOwned);
                }
                throw error;
            } finally {
                slot.unloadPromise = null;
            }
        });
        slot.unloadPromise = unloadOperation;
        if (providerOwned) {
            publishAIRuntimeRoleState(
                role,
                roleRecord(
                    role,
                    slot.selection,
                    {
                        state: 'unloading',
                        loaded: true,
                        operationId: unloadOperationId
                    }
                )
            );
        }
        return unloadOperation;
    }

    dispose(role, options = {}) {
        this.#assertNotConfiguring();
        assertRole(role);
        assertPlainObject(options, 'AI provider dispose options');
        for (const key of Reflect.ownKeys(options)) {
            if (key !== 'signal') {
                fail('AI provider dispose options contain an unknown option.');
            }
        }
        const signal = Object.hasOwn(options, 'signal') ? options.signal : null;
        assertAbortSignal(signal);
        const slot = this.#slots[role];
        if (slot.disposePromise) {
            return slot.disposePromise;
        }
        if (slot.disposed) {
            return Promise.resolve(this.status(role));
        }

        const provider = this.#providerFor(slot);
        const runtime = this;
        const disposeOperation = Promise.resolve().then(async function disposeAIProviderRole() {
            try {
                await runtime.unload(role, {signal});
                if (provider) {
                    await provider.dispose(
                        {
                            role,
                            selection: slot.selection,
                            signal
                        }
                    );
                    const disposedStatus = validateProviderStatus(provider.status());
                    if (disposedStatus.loaded || disposedStatus.busy) {
                        throw operationError(
                            `The selected ${role} provider remained active after disposal.`,
                            'ARCANE_AI_PROVIDER_DISPOSE_INCOMPLETE'
                        );
                    }
                }
                slot.ready = false;
                slot.disposed = true;
                publishAIRuntimeRoleState(
                    role,
                    roleRecord(
                        role,
                        slot.selection,
                        {
                            state: 'disposed'
                        }
                    )
                );
                return runtime.status(role);
            } catch (error) {
                runtime.#publishRoleError(slot, error, runtime.status(role).loaded);
                throw error;
            } finally {
                slot.disposePromise = null;
            }
        });
        slot.disposePromise = disposeOperation;
        return disposeOperation;
    }

    disposeAll(options = {}) {
        this.#assertNotConfiguring();
        assertPlainObject(options, 'AI provider dispose-all options');
        for (const key of Reflect.ownKeys(options)) {
            if (key !== 'signal') {
                fail('AI provider dispose-all options contain an unknown option.');
            }
        }
        const signal = Object.hasOwn(options, 'signal') ? options.signal : null;
        assertAbortSignal(signal);
        if (this.#disposeAllPromise) {
            return this.#disposeAllPromise;
        }
        if (this.#closed) {
            return Promise.resolve(this.status());
        }
        this.#closing = true;
        const runtime = this;
        const disposing = (async function disposeAIProviderRuntime() {
            const selectedProviders = new Set();
            const tasks = [];
            for (const role of AI_RUNTIME_ROLES) {
                const selectedProvider = runtime.#providerFor(runtime.#slots[role]);
                if (selectedProvider) {
                    selectedProviders.add(selectedProvider);
                }
                tasks.push(
                    {
                        provider: selectedProvider,
                        operation: runtime.dispose(role, {signal})
                    }
                );
            }
            const uniqueProviders = new Set(runtime.#providers.values());
            for (const provider of uniqueProviders) {
                if (selectedProviders.has(provider)
                    || runtime.#disposeAllCompletedProviders.has(provider)) {
                    continue;
                }
                const slot = runtime.#slots[provider.role];
                const selection = ROUTE_KEYS.map(
                    function selectRegisteredAIProviderRoute(routeName) {
                        return slot.routes[routeName];
                    }
                ).find(
                    function findRegisteredAIProviderRoute(candidate) {
                        return candidate?.providerId === provider.id;
                    }
                ) ?? null;
                tasks.push(
                    {
                        provider,
                        operation: Promise.resolve().then(
                            async function disposeUnselectedAIProvider() {
                                if (signal?.aborted) {
                                    throw normalizedAbort();
                                }
                                await provider.dispose(
                                    {
                                        role: provider.role,
                                        selection,
                                        signal
                                    }
                                );
                                const disposedStatus = validateProviderStatus(
                                    provider.status()
                                );
                                if (disposedStatus.loaded || disposedStatus.busy) {
                                    throw operationError(
                                        `AI provider ${providerKey(provider.role, provider.id)} remained active after disposal.`,
                                        'ARCANE_AI_PROVIDER_DISPOSE_INCOMPLETE'
                                    );
                                }
                            }
                        )
                    }
                );
            }
            const results = await Promise.allSettled(
                tasks.map(function runAIProviderDisposal(task) {
                    return task.operation;
                })
            );
            results.forEach(function retainCompletedAIProviderDisposal(result, index) {
                const provider = tasks[index].provider;
                if (result.status === 'fulfilled' && provider) {
                    runtime.#disposeAllCompletedProviders.add(provider);
                }
            });
            const failed = results.find(function findFailedDispose(result) {
                return result.status === 'rejected';
            });
            if (failed) {
                throw failed.reason;
            }
            runtime.#providers.clear();
            runtime.#disposeAllCompletedProviders.clear();
            for (const role of AI_RUNTIME_ROLES) {
                const slot = runtime.#slots[role];
                slot.generation += 1;
                slot.routes = completeValue({default: null, localOnly: null});
                slot.selection = null;
                slot.loadController = null;
                slot.loadPromise = null;
                slot.unloadPromise = null;
                slot.disposePromise = null;
                slot.requestQueue = [];
                slot.request = null;
                slot.ready = false;
                slot.disposed = true;
            }
            publishAIRuntimeRolesState(
                {
                    llm: roleRecord('llm', null, {state: 'disposed'}),
                    stt: roleRecord('stt', null, {state: 'disposed'}),
                    tts: roleRecord('tts', null, {state: 'disposed'})
                }
            );
            runtime.#closing = false;
            runtime.#closed = true;
            runtime.#unsubscribeIntents?.();
            runtime.#unsubscribeIntents = null;
            return runtime.status();
        })();
        this.#disposeAllPromise = disposing.then(
            function releaseCompletedAIProviderRuntimeDisposal(result) {
                runtime.#disposeAllPromise = null;
                return result;
            },
            function releaseFailedAIProviderRuntimeDisposal(error) {
                runtime.#disposeAllPromise = null;
                throw error;
            }
        );
        return this.#disposeAllPromise;
    }

    request(role, options = {}) {
        this.#assertOpen();
        this.#assertNotConfiguring();
        assertRole(role);
        assertClosedRecord(
            options,
            ['operation', 'payload', 'localOnly', 'signal'],
            'AI provider request options'
        );
        if (!ROLE_OPERATION_SETS[role].has(options.operation)) {
            fail(
                `AI ${role} operation must be one of ${ROLE_OPERATIONS[role].join(', ')}.`
            );
        }
        if (options.localOnly !== true && options.localOnly !== false) {
            fail('AI provider request localOnly must be a boolean.');
        }
        assertAbortSignal(options.signal);
        try {
            assertCallbackFreeProviderValue(options.payload);
            if (role === 'llm') {
                validateLLMRequestPayload(options.payload);
            }
        } catch (error) {
            return Promise.reject(error);
        }
        if (options.signal?.aborted) {
            return Promise.reject(normalizedAbort());
        }
        const slot = this.#slots[role];
        if (slot.disposed) {
            return Promise.reject(
                operationError(
                    `AI role ${role} is disposed and must be explicitly reconfigured.`,
                    'ARCANE_AI_ROLE_DISPOSED'
                )
            );
        }
        if (slot.unloadPromise || slot.disposePromise) {
            return Promise.reject(
                operationError(
                    `AI role ${role} is cleaning up.`,
                    'ARCANE_AI_OPERATION_SUPERSEDED'
                )
            );
        }
        const targetSelection = options.localOnly
            ? slot.routes.localOnly
            : slot.routes.default;
        if (!targetSelection) {
            return Promise.reject(
                operationError(
                    options.localOnly
                        ? `No explicit local-only ${role} route is configured.`
                        : `No default ${role} route is configured.`,
                    options.localOnly
                        ? 'AI_LOCAL_MODEL_REQUIRED'
                        : 'ARCANE_AI_ROLE_NOT_SELECTED'
                )
            );
        }
        if (!this.#sameSelection(slot.selection, targetSelection)) {
            return Promise.reject(
                operationError(
                    `The explicit ${options.localOnly ? 'local-only' : 'default'} ${role} route is not loaded.`,
                    'ARCANE_AI_ROUTE_NOT_READY'
                )
            );
        }
        const provider = this.#providerFor(slot);
        if (!provider) {
            return Promise.reject(
                operationError(
                    `The selected ${role} provider is not registered.`,
                    'ARCANE_AI_PROVIDER_UNAVAILABLE'
                )
            );
        }
        let providerStatus;
        try {
            providerStatus = validateProviderStatus(provider.status());
        } catch (error) {
            slot.ready = false;
            const invalidStatus = operationError(
                `The selected ${role} provider did not return a valid status.`,
                'ARCANE_AI_PROVIDER_STATUS_INVALID',
                error
            );
            this.#publishRoleError(slot, invalidStatus, false);
            return Promise.reject(invalidStatus);
        }
        if (options.localOnly && targetSelection.localOnly !== true) {
            return Promise.reject(
                operationError(
                    `AI role ${role} does not have a local-only route.`,
                    'AI_LOCAL_MODEL_REQUIRED'
                )
            );
        }
        if (slot.request) {
            return this.#enqueueRoleRequest(slot, options);
        }
        if (!slot.ready
            || providerStatus.state !== 'ready'
            || providerStatus.loaded !== true
            || providerStatus.busy !== false) {
            slot.ready = false;
            return Promise.reject(
                operationError(
                    `AI role ${role} is not ready.`,
                    'ARCANE_AI_ROLE_NOT_READY'
                )
            );
        }

        const generation = slot.generation;
        const requestSequence = this.#nextRequestSequence(slot);
        const operationId = this.#nextOperationId(slot, options.operation);
        const controller = new AbortController();
        const detachSignal = this.#forwardAbort(options.signal, controller);
        const runtime = this;
        const requestRecord = {
            controller,
            requestSequence,
            promise: null,
            cancel: null
        };
        slot.request = requestRecord;
        publishAIRuntimeRoleState(
            role,
            roleRecord(
                role,
                slot.selection,
                {
                    state: 'ready',
                    loaded: true,
                    busy: true,
                    operationId
                }
            )
        );

        function restoreAIProviderRoleAfterRequest(error) {
            if (slot.generation !== generation
                || slot.requestSequence !== requestSequence
                || slot.unloadPromise) {
                return;
            }
            let providerState = null;
            try {
                providerState = validateProviderStatus(provider.status());
            } catch {
                // A malformed provider status is itself a lifecycle failure.
            }
            if (providerState?.state === 'ready'
                && providerState.loaded
                && !providerState.busy) {
                slot.ready = true;
                publishAIRuntimeRoleState(
                    role,
                    roleRecord(
                        role,
                        slot.selection,
                        {
                            state: 'ready',
                            loaded: true
                        }
                    )
                );
                return;
            }
            slot.ready = false;
            runtime.#publishRoleError(slot, error, providerState?.loaded === true);
        }

        if (options.operation === 'stream') {
            let providerHandle = null;
            let providerOpenPromise = null;
            let iterator = null;
            let cleanupPromise = null;
            let terminalSettled = false;
            let resolveTerminal;
            let rejectTerminal;
            const terminal = new Promise(function createAIProviderStreamTerminal(resolve, reject) {
                resolveTerminal = resolve;
                rejectTerminal = reject;
            });
            terminal.catch(function retainAIProviderStreamTerminalRejection() {});
            requestRecord.promise = terminal;

            function settleAIProviderStream(error, value) {
                if (terminalSettled) {
                    return;
                }
                terminalSettled = true;
                controller.signal.removeEventListener(
                    'abort',
                    cancelAbortedAIProviderStream
                );
                detachSignal();
                if (slot.request === requestRecord) {
                    slot.request = null;
                }
                runtime.#drainRoleRequestQueue(slot);
                if (error) {
                    restoreAIProviderRoleAfterRequest(error);
                    rejectTerminal(error);
                } else {
                    restoreAIProviderRoleAfterRequest(null);
                    resolveTerminal(value);
                }
            }

            function beginAIProviderStreamHandleCleanup(opened, activeIterator, reason) {
                const cleanup = [];
                if (typeof opened?.cancel === 'function') {
                    cleanup.push(
                        Promise.resolve().then(function cancelOpenedAIStream() {
                            return opened.cancel(reason);
                        })
                    );
                }
                if (activeIterator && typeof activeIterator.return === 'function') {
                    cleanup.push(
                        Promise.resolve().then(function returnOpenedAIStream() {
                            return activeIterator.return();
                        })
                    );
                }
                return Promise.allSettled(cleanup);
            }

            async function cleanupAIProviderStreamHandle(opened, activeIterator, reason) {
                return awaitStreamCleanup(
                    beginAIProviderStreamHandleCleanup(
                        opened,
                        activeIterator,
                        reason
                    )
                );
            }

            async function cleanupOwnedAIProviderStream(reason) {
                if (providerHandle) {
                    return cleanupAIProviderStreamHandle(
                        providerHandle,
                        iterator,
                        reason
                    );
                }
                if (!providerOpenPromise) {
                    return {completed: true, results: []};
                }
                const lateCleanup = providerOpenPromise.then(
                    async function cleanupLateAIProviderStream(lateHandle) {
                        if (!lateHandle || typeof lateHandle.cancel !== 'function') {
                            throw operationError(
                                'The late AI provider stream did not expose cancellable ownership.',
                                'ARCANE_AI_STREAM_CLEANUP_INCOMPLETE'
                            );
                        }
                        providerHandle = lateHandle;
                        const results = await beginAIProviderStreamHandleCleanup(
                            lateHandle,
                            null,
                            reason
                        );
                        assertStreamCleanupComplete(
                            {completed: true, results}
                        );
                    },
                    function confirmRejectedAIProviderStreamOpen() {
                        // A rejected open confirms that no provider handle was returned.
                    }
                );
                return awaitStreamCleanup(
                    Promise.allSettled([lateCleanup])
                );
            }

            async function cancelAIProviderStream(reason, terminalError = null) {
                if (cleanupPromise) {
                    return cleanupPromise;
                }
                let resolveCleanup;
                let rejectCleanup;
                cleanupPromise = new Promise(
                    function createAIProviderStreamCleanup(resolve, reject) {
                        resolveCleanup = resolve;
                        rejectCleanup = reject;
                    }
                );
                controller.abort(reason);
                (async function closeAIProviderStream() {
                    const terminalOutcome = terminalError ?? normalizedAbort(
                        reason instanceof Error
                            ? reason
                            : operationError(
                                'The AI stream was cancelled.',
                                'ARCANE_AI_REQUEST_ABORTED'
                            )
                    );
                    try {
                        const cleanupOutcome = await cleanupOwnedAIProviderStream(reason);
                        assertStreamCleanupComplete(cleanupOutcome);
                        settleAIProviderStream(terminalOutcome);
                    } catch (cleanupError) {
                        const incomplete = cleanupError?.code === 'ARCANE_AI_STREAM_CLEANUP_INCOMPLETE'
                            ? cleanupError
                            : operationError(
                                'The AI provider stream did not confirm bounded cleanup.',
                                'ARCANE_AI_STREAM_CLEANUP_INCOMPLETE',
                                cleanupError
                            );
                        settleAIProviderStream(incomplete);
                        throw incomplete;
                    }
                })().then(resolveCleanup, rejectCleanup);
                await cleanupPromise;
            }
            requestRecord.cancel = cancelAIProviderStream;
            function cancelAbortedAIProviderStream() {
                cancelAIProviderStream(normalizedAbort()).catch(
                    function retainAbortedAIProviderStreamCleanupFailure() {}
                );
            }
            controller.signal.addEventListener(
                'abort',
                cancelAbortedAIProviderStream,
                {once: true}
            );

            const openPromise = (async function openAIProviderStream() {
                let opened = null;
                let detachOpenAbort = function detachAbsentAIStreamOpenAbort() {};
                try {
                    if (controller.signal.aborted) {
                        throw normalizedAbort();
                    }
                    providerOpenPromise = Promise.resolve().then(
                        function requestAIProviderStream() {
                            return provider.request(
                                {
                                    role,
                                    selection: slot.selection,
                                    operation: options.operation,
                                    payload: options.payload,
                                    signal: controller.signal
                                }
                            );
                        }
                    );
                    const abortedOpen = new Promise(function rejectAbortedAIStreamOpen(resolve, reject) {
                        function rejectAIStreamOpenAbort() {
                            reject(normalizedAbort());
                        }
                        controller.signal.addEventListener(
                            'abort',
                            rejectAIStreamOpenAbort,
                            {once: true}
                        );
                        detachOpenAbort = function detachAIStreamOpenAbort() {
                            controller.signal.removeEventListener(
                                'abort',
                                rejectAIStreamOpenAbort
                            );
                        };
                    });
                    opened = await Promise.race([providerOpenPromise, abortedOpen]);
                    if (!opened
                        || typeof opened[Symbol.asyncIterator] !== 'function'
                        || typeof opened.cancel !== 'function'
                        || !opened.result
                        || typeof opened.result.then !== 'function') {
                        throw operationError(
                            'AI stream providers must return an async iterable with result and cancel().',
                            'ARCANE_AI_PROVIDER_STREAM_INVALID'
                        );
                    }
                    providerHandle = opened;
                    iterator = opened[Symbol.asyncIterator]();
                    if (!iterator || typeof iterator.next !== 'function') {
                        throw operationError(
                            'The AI provider stream iterator has no next() method.',
                            'ARCANE_AI_PROVIDER_STREAM_INVALID'
                        );
                    }
                    runtime.#assertCurrentRequest(
                        slot,
                        generation,
                        requestSequence,
                        controller.signal
                    );
                    Promise.resolve(opened.result).then(
                        function acceptAIProviderStreamResult(value) {
                            try {
                                runtime.#assertCurrentRequest(
                                    slot,
                                    generation,
                                    requestSequence,
                                    controller.signal
                                );
                                const terminalValue = role === 'llm'
                                    ? validateLLMTerminalResult(
                                        value,
                                        'AI provider stream result'
                                    )
                                    : value;
                                settleAIProviderStream(null, terminalValue);
                            } catch (error) {
                                const normalized = isAbort(error, controller.signal)
                                    ? normalizedAbort(error)
                                    : error;
                                settleAIProviderStream(normalized);
                            }
                        },
                        async function rejectAIProviderStreamResult(error) {
                            const normalized = isAbort(error, controller.signal)
                                ? normalizedAbort(error)
                                : error;
                            try {
                                await cancelAIProviderStream(normalized, normalized);
                            } catch {
                                // The original provider result error remains terminal.
                            }
                        }
                    );

                    const handle = {
                        result: terminal,
                        cancel: cancelAIProviderStream,
                        async next(value) {
                            try {
                                let nextValue = value;
                                while (true) {
                                    const result = await iterator.next(nextValue);
                                    nextValue = undefined;
                                    runtime.#assertCurrentRequest(
                                        slot,
                                        generation,
                                        requestSequence,
                                        controller.signal
                                    );
                                    if (role !== 'llm') {
                                        return result;
                                    }
                                    if (result.done) {
                                        return {value: undefined, done: true};
                                    }
                                    const projected = projectLLMStreamChunk(result.value);
                                    if (projected !== null) {
                                        return {
                                            value: projected,
                                            done: false
                                        };
                                    }
                                }
                            } catch (error) {
                                await cancelAIProviderStream(error);
                                throw isAbort(error, controller.signal)
                                    ? normalizedAbort(error)
                                    : error;
                            }
                        },
                        async return(value) {
                            Promise.resolve().then(
                                function beginReturnedAIProviderStreamCancellation() {
                                    return cancelAIProviderStream(
                                        operationError(
                                            'The AI stream consumer stopped before completion.',
                                            'ARCANE_AI_REQUEST_ABORTED'
                                        )
                                    );
                                }
                            ).catch(
                                function reportReturnedAIProviderStreamCancellationFailure(error) {
                                    console.error(
                                        'Arcane AI provider stream early-return cancellation failed.',
                                        error
                                    );
                                }
                            );
                            return {value, done: true};
                        },
                        async throw(error) {
                            await cancelAIProviderStream(error);
                            throw error;
                        },
                        [Symbol.asyncIterator]() {
                            return this;
                        }
                    };
                    return completeValue(handle);
                } catch (error) {
                    const normalized = isAbort(error, controller.signal)
                        ? normalizedAbort(error)
                        : error;
                    if (cleanupPromise) {
                        try {
                            await cleanupPromise;
                        } catch (cleanupError) {
                            throw cleanupError;
                        }
                    } else if (providerHandle) {
                        try {
                            await cancelAIProviderStream(normalized, normalized);
                        } catch {
                            // The original stream-open failure remains authoritative.
                        }
                    } else if (opened) {
                        await cleanupAIProviderStreamHandle(
                            opened,
                            null,
                            normalized
                        ).catch(
                            function retainRejectedAIProviderStreamHandleCleanup() {}
                        );
                        settleAIProviderStream(normalized);
                    } else {
                        settleAIProviderStream(normalized);
                    }
                    throw normalized;
                } finally {
                    detachOpenAbort();
                }
            })();
            return openPromise;
        }

        requestRecord.cancel = async function cancelAIProviderRequest(reason) {
            controller.abort(reason);
            await requestRecord.promise?.catch(
                function retainCancelledAIProviderRequest() {}
            );
        };
        requestRecord.promise = (async function requestAIProviderRole() {
            let requestError = null;
            try {
                if (controller.signal.aborted) {
                    throw normalizedAbort();
                }
                const result = await provider.request(
                    {
                        role,
                        selection: slot.selection,
                        operation: options.operation,
                        payload: options.payload,
                        signal: controller.signal
                    }
                );
                runtime.#assertCurrentRequest(
                    slot,
                    generation,
                    requestSequence,
                    controller.signal
                );
                return role === 'llm'
                    ? validateLLMTerminalResult(
                        result,
                        'AI provider chat result'
                    )
                    : result;
            } catch (error) {
                const normalized = isAbort(error, controller.signal)
                    ? normalizedAbort(error)
                    : error;
                requestError = normalized;
                restoreAIProviderRoleAfterRequest(normalized);
                throw normalized;
            } finally {
                detachSignal();
                if (slot.request === requestRecord) {
                    slot.request = null;
                }
                runtime.#drainRoleRequestQueue(slot);
                if (!requestError
                    && slot.generation === generation
                    && !slot.unloadPromise) {
                    restoreAIProviderRoleAfterRequest(null);
                }
            }
        })();
        return requestRecord.promise;
    }

    chat(payload, options = {}) {
        return this.#roleRequestAlias('llm', 'chat', payload, options);
    }

    stream(payload, options = {}) {
        return this.#roleRequestAlias('llm', 'stream', payload, options);
    }

    transcribe(payload, options = {}) {
        return this.#roleRequestAlias('stt', 'transcribe', payload, options);
    }

    synthesize(payload, options = {}) {
        return this.#roleRequestAlias('tts', 'synthesize', payload, options);
    }

    cancel(role) {
        assertRole(role);
        const slot = this.#slots[role];
        if (!slot.request) {
            return false;
        }
        const requestRecord = slot.request;
        const reason = operationError(
            `AI role ${role} request was cancelled.`,
            'ARCANE_AI_REQUEST_ABORTED'
        );
        requestRecord?.controller.abort(reason);
        const cancellation = requestRecord?.cancel?.(reason);
        cancellation?.catch(function retainAIProviderCancelFailureInState() {});
        return true;
    }

    async setSpeechMuted(muted) {
        this.#assertOpen();
        this.#assertNotConfiguring();
        if (typeof muted !== 'boolean') {
            fail('AI speech muted state must be a boolean.');
        }
        this.#speechDesiredMuted = muted;
        if (muted) {
            this.#speechMuted = true;
            this.#slots.tts.loadController?.abort();
            this.cancel('tts');
        }
        const runtime = this;
        this.#speechTransitionOwners += 1;
        const transition = this.#speechTransition.catch(
            function retainPriorAISpeechTransitionFailure() {}
        ).then(
            async function reconcileLatestAISpeechPreference() {
                while (true) {
                    const desiredMuted = runtime.#speechDesiredMuted;
                    if (desiredMuted) {
                        runtime.cancel('tts');
                        try {
                            await runtime.unload('tts');
                        } finally {
                            runtime.#speechMuted = true;
                        }
                    } else {
                        const slot = runtime.#slots.tts;
                        if (slot.unloadPromise) {
                            await slot.unloadPromise;
                        }
                        if (runtime.#speechDesiredMuted) {
                            continue;
                        }
                        await runtime.load('tts');
                    }
                    if (runtime.#speechDesiredMuted === desiredMuted) {
                        runtime.#speechMuted = desiredMuted;
                        return runtime.status('tts');
                    }
                }
            }
        ).finally(
            function releaseAIProviderSpeechTransitionOwnership() {
                runtime.#speechTransitionOwners -= 1;
            }
        );
        this.#speechTransition = transition;
        return transition;
    }

    #providerFor(slot) {
        if (!slot.selection) {
            return null;
        }
        return this.#providers.get(
            providerKey(slot.role, slot.selection.providerId)
        ) ?? null;
    }

    #roleRequestAlias(role, operation, payload, options) {
        assertPlainObject(options, `AI ${operation} options`);
        for (const key of Reflect.ownKeys(options)) {
            if (key !== 'localOnly' && key !== 'signal') {
                fail(`AI ${operation} options contain an unknown option.`);
            }
        }
        const localOnly = Object.hasOwn(options, 'localOnly')
            ? options.localOnly
            : false;
        const signal = Object.hasOwn(options, 'signal')
            ? options.signal
            : null;
        return this.request(
            role,
            {
                operation,
                payload,
                localOnly,
                signal
            }
        );
    }

    #enqueueRoleRequest(slot, options) {
        const runtime = this;
        return new Promise(function queueAIProviderRoleRequest(resolve, reject) {
            const entry = {
                options,
                resolve,
                reject,
                detachSignal: null
            };
            function cancelQueuedAIProviderRoleRequest() {
                const index = slot.requestQueue.indexOf(entry);
                if (index === -1) {
                    return;
                }
                slot.requestQueue.splice(index, 1);
                entry.detachSignal?.();
                reject(normalizedAbort(options.signal?.reason));
            }
            if (options.signal) {
                if (options.signal.aborted) {
                    reject(normalizedAbort(options.signal.reason));
                    return;
                }
                options.signal.addEventListener(
                    'abort',
                    cancelQueuedAIProviderRoleRequest,
                    {once: true}
                );
                entry.detachSignal = function detachQueuedAIProviderRoleRequestSignal() {
                    options.signal.removeEventListener(
                        'abort',
                        cancelQueuedAIProviderRoleRequest
                    );
                };
            }
            slot.requestQueue.push(entry);
            runtime.#drainRoleRequestQueue(slot);
        });
    }

    #drainRoleRequestQueue(slot) {
        if (slot.request
            || slot.unloadPromise
            || slot.disposePromise
            || slot.disposed) {
            return;
        }
        const entry = slot.requestQueue.shift();
        if (!entry) {
            return;
        }
        entry.detachSignal?.();
        if (entry.options.signal?.aborted) {
            entry.reject(normalizedAbort(entry.options.signal.reason));
            this.#drainRoleRequestQueue(slot);
            return;
        }
        const runtime = this;
        Promise.resolve().then(
            function runQueuedAIProviderRoleRequest() {
                return runtime.request(slot.role, entry.options);
            }
        ).then(entry.resolve, entry.reject).finally(
            function continueAIProviderRoleRequestQueue() {
                if (!slot.request) {
                    runtime.#drainRoleRequestQueue(slot);
                }
            }
        );
    }

    #rejectQueuedRoleRequests(slot, error) {
        const queued = slot.requestQueue.splice(0);
        for (const entry of queued) {
            entry.detachSignal?.();
            entry.reject(error);
        }
    }

    #sameSelection(left, right) {
        return left === right
            || Boolean(
                left
                && right
                && left.providerId === right.providerId
                && left.modelId === right.modelId
                && left.localOnly === right.localOnly
            );
    }

    #assertOpen() {
        if (this.#closed || this.#closing) {
            throw operationError(
                this.#closed
                    ? 'The AI provider runtime is disposed.'
                    : 'The AI provider runtime is disposing.',
                this.#closed
                    ? 'ARCANE_AI_RUNTIME_DISPOSED'
                    : 'ARCANE_AI_RUNTIME_DISPOSING'
            );
        }
    }

    #assertNotConfiguring() {
        if (this.#configuring) {
            throw operationError(
                'The AI provider runtime is committing a configuration.',
                'ARCANE_AI_RUNTIME_CONFIGURING'
            );
        }
    }

    #roleHasOwnedWork(slot) {
        return Boolean(
            slot.loadPromise
            || slot.unloadPromise
            || slot.disposePromise
            || slot.request
            || slot.requestQueue.length > 0
            || slot.ready
        );
    }

    #createProviderUnregisterHandle(provider) {
        const runtime = this;
        let active = true;
        return function unregisterAIProvider() {
            if (!active) {
                return false;
            }
            const removed = runtime.unregister(
                provider.role,
                provider.id,
                provider
            );
            if (removed) {
                active = false;
            }
            return removed;
        };
    }

    #nextRequestSequence(slot) {
        slot.requestSequence = nextSequence(slot.requestSequence);
        return slot.requestSequence;
    }

    #nextOperationId(slot, operation) {
        slot.operationSequence = nextSequence(slot.operationSequence);
        return `${slot.role}-${operation}-${slot.operationSequence}`;
    }

    #assertCurrentOperation(slot, generation, signal) {
        if (signal?.aborted) {
            throw normalizedAbort();
        }
        if (slot.generation !== generation) {
            throw operationError(
                `AI role ${slot.role} operation was superseded.`,
                'ARCANE_AI_OPERATION_SUPERSEDED'
            );
        }
    }

    #assertCurrentRequest(slot, generation, requestSequence, signal) {
        this.#assertCurrentOperation(slot, generation, signal);
        if (slot.requestSequence !== requestSequence) {
            throw operationError(
                `AI role ${slot.role} no longer owns the active provider request.`,
                'ARCANE_AI_REQUEST_STALE'
            );
        }
    }

    #forwardAbort(signal, controller) {
        if (!signal) {
            return function detachAbsentAIProviderAbort() {};
        }
        function forwardAIProviderAbort() {
            controller.abort(signal.reason);
        }
        if (signal.aborted) {
            controller.abort(signal.reason);
            return function detachAlreadyAbortedAIProviderSignal() {};
        }
        signal.addEventListener('abort', forwardAIProviderAbort, {once: true});
        return function detachAIProviderAbort() {
            signal.removeEventListener('abort', forwardAIProviderAbort);
        };
    }

    #publishLoadProgress(slot, generation, operationId, progress) {
        if (slot.generation !== generation || slot.loadController?.signal.aborted) {
            return false;
        }
        publishAIRuntimeRoleState(
            slot.role,
            roleRecord(
                slot.role,
                slot.selection,
                {
                    state: 'loading',
                    operationId,
                    progress: immutableProgress(progress)
                }
            )
        );
        return true;
    }

    #publishRoleError(slot, error, loaded) {
        publishAIRuntimeRoleState(
            slot.role,
            roleRecord(
                slot.role,
                slot.selection,
                {
                    state: 'error',
                    loaded,
                    error: stateError(
                        error,
                        'ARCANE_AI_PROVIDER_OPERATION_FAILED'
                    )
                }
            )
        );
    }

    #acceptIntent(intent) {
        if (this.#closed || this.#closing || this.#configuring) {
            return;
        }
        const slot = this.#slots[intent.role];
        if (!slot.selection) {
            return;
        }
        let operation;
        try {
            if (intent.action === 'load') {
                operation = this.load(intent.role);
            } else if (intent.action === 'unload') {
                operation = this.unload(intent.role);
            } else {
                operation = this.dispose(intent.role);
            }
        } catch {
            return;
        }
        operation.catch(function retainAIProviderIntentFailureInState() {
            // Lifecycle failures are published as sticky role state.
        });
    }
}

export const aiProviderRuntime = new AIProviderRuntime(
    RUNTIME_CONSTRUCTION_AUTHORITY
);

export function getAIProviderRuntime() {
    return aiProviderRuntime;
}

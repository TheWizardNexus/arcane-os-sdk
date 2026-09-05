import {arcaneLogging} from 'arcane-os/logging';
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
        || Object.hasOwn(message, 'tool_call')
        || Object.hasOwn(message, 'toolCall')
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
    const ids = new Set();
    for (let index = 0; index < descriptor.value.length; index += 1) {
        const id = validateLLMToolCall(
            descriptor.value[index],
            `${label}.tool_calls[${index}]`
        );
        if (ids.has(id)) {
            fail(
                `${label}.tool_calls contains a duplicate structural tool-call ID.`,
                'ARCANE_AI_TOOL_CALL_INVALID'
            );
        }
        ids.add(id);
    }
    return descriptor.value;
}

function validateLLMRequestPayload(payload) {
    assertPlainObject(payload, 'AI LLM request payload');
    if (!Array.isArray(payload.messages)) {
        fail('AI LLM request payload.messages must be an array.');
    }
    const pendingToolCallIds = new Set();
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
            if (pendingToolCallIds.size) {
                fail(
                    'Every pending structural tool result must be supplied before another assistant tool-call sequence.',
                    'ARCANE_AI_TOOL_RESULT_REQUIRED'
                );
            }
            for (const call of calls) {
                if (pendingToolCallIds.has(call.id)) {
                    fail(
                        'An assistant structural tool-call sequence contains a duplicate ID.',
                        'ARCANE_AI_TOOL_CALL_INVALID'
                    );
                }
                pendingToolCallIds.add(call.id);
            }
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
            if (!pendingToolCallIds.size
                || typeof message.tool_call_id !== 'string'
                || !pendingToolCallIds.has(message.tool_call_id)) {
                fail(
                    `AI LLM request payload.messages[${index}] does not settle the pending structural tool call.`,
                    'ARCANE_AI_INVALID_TOOL_MESSAGE'
                );
            }
            pendingToolCallIds.delete(message.tool_call_id);
        } else {
            if (Object.hasOwn(message, 'tool_call_id')) {
                fail(
                    `AI LLM request payload.messages[${index}].tool_call_id is valid only for a tool result.`,
                    'ARCANE_AI_INVALID_TOOL_MESSAGE'
                );
            }
            if (pendingToolCallIds.size && !openedToolCall) {
                fail(
                    `AI LLM request payload.messages[${index}] precedes the pending structural tool result.`,
                    'ARCANE_AI_TOOL_RESULT_REQUIRED'
                );
            }
        }
    }
    if (pendingToolCallIds.size) {
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
    if (parallelValues.some(function invalidParallelLLMToolPreference(value) {
        return value !== undefined && typeof value !== 'boolean';
    })) {
        fail('AI LLM parallel tool-call preferences must be boolean when provided.');
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
        validateLLMTerminalMessage(
            messageDescriptor.value,
            `${label}.choices[${position}].message`
        );
    }
    return value;
}

function llmStreamToolCallMismatch(message, cause) {
    return operationError(
        message,
        'ARCANE_AI_STREAM_TOOL_CALL_MISMATCH',
        cause
    );
}

function canonicalLLMToolCall(call) {
    return {
        id: call.id,
        type: call.type,
        function: {
            name: call.function.name,
            arguments: call.function.arguments
        }
    };
}

function copyLLMDataValue(value, seen = new Map()) {
    if (!value || typeof value !== 'object') {
        return value;
    }
    if (seen.has(value)) {
        return seen.get(value);
    }
    if (!Array.isArray(value) && !isPlainRecord(value)) {
        return value;
    }
    const result = Array.isArray(value)
        ? new Array(value.length)
        : Object.create(Object.getPrototypeOf(value));
    seen.set(value, result);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
        if (Array.isArray(value) && key === 'length') {
            continue;
        }
        const descriptor = descriptors[key];
        if (Object.hasOwn(descriptor, 'value')) {
            descriptor.value = copyLLMDataValue(descriptor.value, seen);
        }
        Object.defineProperty(result, key, descriptor);
    }
    return result;
}

function sameLLMDataValue(left, right, seen = new Map()) {
    if (Object.is(left, right)) {
        return true;
    }
    if (!left || !right
        || typeof left !== 'object'
        || typeof right !== 'object'
        || Array.isArray(left) !== Array.isArray(right)) {
        return false;
    }
    if (!Array.isArray(left)
        && (!isPlainRecord(left) || !isPlainRecord(right))) {
        return false;
    }
    const matched = seen.get(left);
    if (matched !== undefined) {
        return matched === right;
    }
    seen.set(left, right);
    const leftDescriptors = Object.getOwnPropertyDescriptors(left);
    const rightDescriptors = Object.getOwnPropertyDescriptors(right);
    const leftKeys = Reflect.ownKeys(leftDescriptors);
    const rightKeys = Reflect.ownKeys(rightDescriptors);
    if (leftKeys.length !== rightKeys.length) {
        return false;
    }
    for (const key of leftKeys) {
        if (!Object.hasOwn(rightDescriptors, key)) {
            return false;
        }
        const leftDescriptor = leftDescriptors[key];
        const rightDescriptor = rightDescriptors[key];
        const leftIsData = Object.hasOwn(leftDescriptor, 'value');
        const rightIsData = Object.hasOwn(rightDescriptor, 'value');
        if (leftIsData !== rightIsData) {
            return false;
        }
        if (leftIsData) {
            if (!sameLLMDataValue(
                leftDescriptor.value,
                rightDescriptor.value,
                seen
            )) {
                return false;
            }
        } else if (leftDescriptor.get !== rightDescriptor.get
            || leftDescriptor.set !== rightDescriptor.set) {
            return false;
        }
    }
    return true;
}

function sameCanonicalLLMToolCalls(left, right) {
    return left.length === right.length
        && left.every(function sameCanonicalLLMToolCall(call, index) {
            const other = right[index];
            return call.id === other?.id
                && call.type === other?.type
                && call.function.name === other?.function?.name
                && call.function.arguments === other?.function?.arguments;
        });
}

function terminalLLMToolCallRecord(choiceIndex, completeCalls) {
    return {
        choiceIndex,
        completeCalls,
        canonicalCalls: completeCalls.map(canonicalLLMToolCall)
    };
}

function terminalLLMToolCalls(value) {
    if (typeof value === 'string') {
        return {direct: terminalLLMToolCallRecord(null, []), choices: []};
    }
    if (Object.hasOwn(value, 'message')) {
        const completeCalls = Array.isArray(value.message?.tool_calls)
            ? value.message.tool_calls
            : [];
        return {
            direct: terminalLLMToolCallRecord(null, completeCalls),
            choices: []
        };
    }
    return {
        direct: null,
        choices: value.choices.map(function retainTerminalLLMChoice(choice) {
            const completeCalls = Array.isArray(choice.message?.tool_calls)
                ? choice.message.tool_calls
                : [];
            return terminalLLMToolCallRecord(choice.index, completeCalls);
        })
    };
}

function createLLMStreamToolCallCorrelation() {
    const choices = new Map();
    const choiceOrder = [];
    let direct = null;

    function createRecord(choiceIndex = null) {
        return {
            choiceIndex,
            completeCalls: null,
            fragments: new Map(),
            seen: false,
            observed: false
        };
    }

    function directRecord() {
        if (!direct) {
            direct = createRecord();
        }
        return direct;
    }

    function choiceRecord(index, hasExplicitIndex) {
        const key = hasExplicitIndex
            ? `index:${index}`
            : `position:${index}`;
        if (!choices.has(key)) {
            const record = createRecord(hasExplicitIndex ? index : null);
            choices.set(key, record);
            choiceOrder.push(record);
        }
        return choices.get(key);
    }

    function structuralToolCalls(source, label) {
        if (!isPlainRecord(source)) {
            return null;
        }
        if (Object.hasOwn(source, 'toolCalls')
            || Object.hasOwn(source, 'tool_call')
            || Object.hasOwn(source, 'toolCall')
            || Object.hasOwn(source, 'function_call')
            || Object.hasOwn(source, 'functionCall')) {
            throw llmStreamToolCallMismatch(
                `${label} contains noncanonical structural tool-call data.`
            );
        }
        if (!Object.hasOwn(source, 'tool_calls')) {
            return null;
        }
        const descriptor = Object.getOwnPropertyDescriptor(source, 'tool_calls');
        if (!descriptor || !Object.hasOwn(descriptor, 'value')
            || !Array.isArray(descriptor.value)) {
            throw llmStreamToolCallMismatch(
                `${label}.tool_calls must be an array data property.`
            );
        }
        return descriptor.value;
    }

    function observeCompleteMessage(message, record, label) {
        const calls = structuralToolCalls(message, label);
        if (!calls?.length) {
            return;
        }
        let completeCalls;
        try {
            completeCalls = validateLLMMessageToolCalls(message, label)
                .map(function retainCompleteLLMStreamToolCall(call) {
                    return copyLLMDataValue(call);
                });
        } catch (cause) {
            throw llmStreamToolCallMismatch(
                `${label} did not contain complete structural tool calls.`,
                cause
            );
        }
        if (record.completeCalls
            && !sameLLMDataValue(record.completeCalls, completeCalls)) {
            throw llmStreamToolCallMismatch(
                `${label} changed its complete structural tool calls during streaming.`
            );
        }
        record.completeCalls = completeCalls;
        record.observed = true;
    }

    function observeFragments(source, record, label) {
        const calls = structuralToolCalls(source, label);
        if (!calls?.length) {
            return;
        }
        record.observed = true;
        for (let position = 0; position < calls.length; position += 1) {
            const fragment = calls[position];
            if (!isPlainRecord(fragment)) {
                throw llmStreamToolCallMismatch(
                    `${label}.tool_calls[${position}] must be a structural fragment object.`
                );
            }
            if (fragment.index !== undefined
                && (!Number.isSafeInteger(fragment.index) || fragment.index < 0)) {
                throw llmStreamToolCallMismatch(
                    `${label}.tool_calls[${position}] has an invalid structural call index.`
                );
            }
            const toolIndex = fragment.index ?? position;
            const retained = record.fragments.get(toolIndex) ?? {
                index: toolIndex,
                id: '',
                type: '',
                name: '',
                arguments: '',
                invalid: false
            };
            if (fragment.id !== undefined) {
                if (typeof fragment.id !== 'string'
                    || !fragment.id
                    || (retained.id && retained.id !== fragment.id)) {
                    retained.invalid = true;
                } else {
                    retained.id = fragment.id;
                }
            }
            if (fragment.type !== undefined) {
                if (typeof fragment.type !== 'string'
                    || !fragment.type
                    || (retained.type && retained.type !== fragment.type)) {
                    retained.invalid = true;
                } else {
                    retained.type = fragment.type;
                }
            }
            if (fragment.function !== undefined
                && !isPlainRecord(fragment.function)) {
                retained.invalid = true;
            }
            const functionFragment = isPlainRecord(fragment.function)
                ? fragment.function
                : {};
            if (functionFragment.name !== undefined) {
                if (typeof functionFragment.name !== 'string') {
                    retained.invalid = true;
                } else {
                    retained.name += functionFragment.name;
                }
            }
            if (functionFragment.arguments !== undefined) {
                if (typeof functionFragment.arguments !== 'string') {
                    retained.invalid = true;
                } else {
                    retained.arguments += functionFragment.arguments;
                }
            }
            record.fragments.set(toolIndex, retained);
        }
    }

    function observeChoice(choice, position) {
        if (!isPlainRecord(choice)) {
            return;
        }
        const delta = isPlainRecord(choice.delta) ? choice.delta : null;
        const message = isPlainRecord(choice.message) ? choice.message : null;
        const hasStructuralData = [choice, delta, message].some(
            function hasChoiceStructuralData(source) {
                return source && (
                    Object.hasOwn(source, 'tool_calls')
                    || Object.hasOwn(source, 'toolCalls')
                    || Object.hasOwn(source, 'tool_call')
                    || Object.hasOwn(source, 'toolCall')
                    || Object.hasOwn(source, 'function_call')
                    || Object.hasOwn(source, 'functionCall')
                );
            }
        );
        if (choice.index !== undefined
            && (!Number.isSafeInteger(choice.index) || choice.index < 0)) {
            throw llmStreamToolCallMismatch(
                `AI provider stream choice ${position} has an invalid index.`
            );
        }
        const hasExplicitIndex = choice.index !== undefined;
        const index = choice.index ?? position;
        const record = choiceRecord(index, hasExplicitIndex);
        record.seen = true;
        if (!hasStructuralData) {
            return;
        }
        observeFragments(choice, record, `AI provider stream choice ${position}`);
        if (delta) {
            observeFragments(
                delta,
                record,
                `AI provider stream choice ${position}.delta`
            );
        }
        if (message) {
            observeCompleteMessage(
                message,
                record,
                `AI provider stream choice ${position}.message`
            );
        }
    }

    function observe(chunk) {
        if (!isPlainRecord(chunk)) {
            return;
        }
        const record = directRecord();
        observeFragments(chunk, record, 'AI provider stream chunk');
        if (isPlainRecord(chunk.delta)) {
            observeFragments(
                chunk.delta,
                record,
                'AI provider stream chunk.delta'
            );
        }
        if (isPlainRecord(chunk.message)) {
            observeCompleteMessage(
                chunk.message,
                record,
                'AI provider stream chunk.message'
            );
        }
        if (Array.isArray(chunk.choices)) {
            for (let position = 0; position < chunk.choices.length; position += 1) {
                observeChoice(chunk.choices[position], position);
            }
        }
    }

    function completedCalls(record, label) {
        if (!record?.observed) {
            return null;
        }
        let fragmentCalls = null;
        if (record.fragments.size) {
            const orderedFragments = [...record.fragments.values()]
                .sort(function orderLLMStreamToolCalls(left, right) {
                    return left.index - right.index;
                });
            for (let index = 0; index < orderedFragments.length; index += 1) {
                if (orderedFragments[index].index !== index) {
                    throw llmStreamToolCallMismatch(
                        `${label} omitted an ordered structural tool-call index.`
                    );
                }
            }
            fragmentCalls = orderedFragments.map(
                function completeLLMStreamToolCall(fragment, index) {
                    if (fragment.invalid) {
                        throw llmStreamToolCallMismatch(
                            `${label} structural tool call ${index} changed an exact field.`
                        );
                    }
                    const call = {
                        id: fragment.id,
                        type: fragment.type,
                        function: {
                            name: fragment.name,
                            arguments: fragment.arguments
                        }
                    };
                    try {
                        validateLLMToolCall(
                            call,
                            `${label} structural tool call ${index}`
                        );
                    } catch (cause) {
                        throw llmStreamToolCallMismatch(
                            `${label} did not retain a complete structural tool call.`,
                            cause
                        );
                    }
                    return call;
                }
            );
        }
        if (record.completeCalls
            && fragmentCalls
            && !sameCanonicalLLMToolCalls(record.completeCalls, fragmentCalls)) {
            throw llmStreamToolCallMismatch(
                `${label} complete and fragmented structural tool calls do not match.`
            );
        }
        return {
            completeCalls: record.completeCalls,
            fragmentCalls
        };
    }

    function assertRecordMatchesTerminal(record, terminal, label) {
        const streamedCalls = completedCalls(record, label);
        if (!streamedCalls) {
            return;
        }
        if (streamedCalls.completeCalls
            && !sameLLMDataValue(
                streamedCalls.completeCalls,
                terminal.completeCalls
            )) {
            throw llmStreamToolCallMismatch(
                `${label} complete tool-call envelopes do not match its terminal result.`
            );
        }
        if (streamedCalls.fragmentCalls
            && !sameCanonicalLLMToolCalls(
                streamedCalls.fragmentCalls,
                terminal.canonicalCalls
            )) {
            throw llmStreamToolCallMismatch(
                `${label} structural tool-call fragments do not match its terminal result.`
            );
        }
    }

    function assertTerminal(value) {
        const terminal = terminalLLMToolCalls(value);
        const streamedChoices = choiceOrder.filter(
            function retainSeenLLMStreamChoice(record) {
                return record.seen;
            }
        );
        const observedDirect = direct?.observed ? direct : null;
        if (terminal.direct) {
            if (observedDirect) {
                assertRecordMatchesTerminal(
                    observedDirect,
                    terminal.direct,
                    'AI provider direct stream result'
                );
            }
            if (streamedChoices.length > 1) {
                throw llmStreamToolCallMismatch(
                    'The AI provider stream observed choices that are omitted from its direct terminal result.'
                );
            }
            if (streamedChoices.length === 1) {
                assertRecordMatchesTerminal(
                    streamedChoices[0],
                    terminal.direct,
                    'AI provider first-seen stream choice'
                );
            }
            return;
        }

        const terminalByIndex = new Map(
            terminal.choices.map(function indexTerminalLLMChoice(choice) {
                return [choice.choiceIndex, choice];
            })
        );
        const matchedTerminalIndexes = new Set();
        for (const record of streamedChoices) {
            if (record.choiceIndex === null) {
                continue;
            }
            const terminalChoice = terminalByIndex.get(record.choiceIndex);
            if (!terminalChoice) {
                throw llmStreamToolCallMismatch(
                    `The AI provider stream observed choice ${record.choiceIndex}, which is omitted from its terminal result.`
                );
            }
            assertRecordMatchesTerminal(
                record,
                terminalChoice,
                `AI provider stream choice ${record.choiceIndex}`
            );
            matchedTerminalIndexes.add(record.choiceIndex);
        }

        if (observedDirect) {
            const firstTerminalChoice = terminal.choices[0];
            assertRecordMatchesTerminal(
                observedDirect,
                firstTerminalChoice,
                `AI provider first terminal choice ${firstTerminalChoice.choiceIndex}`
            );
            matchedTerminalIndexes.add(firstTerminalChoice.choiceIndex);
        }

        for (const record of streamedChoices) {
            if (record.choiceIndex !== null) {
                continue;
            }
            const terminalChoice = terminal.choices.find(
                function findFirstUnmatchedTerminalLLMChoice(choice) {
                    return !matchedTerminalIndexes.has(choice.choiceIndex);
                }
            );
            if (!terminalChoice) {
                throw llmStreamToolCallMismatch(
                    'The AI provider stream observed a first-seen choice that is omitted from its terminal result.'
                );
            }
            assertRecordMatchesTerminal(
                record,
                terminalChoice,
                `AI provider first-seen stream choice for terminal choice ${terminalChoice.choiceIndex}`
            );
            matchedTerminalIndexes.add(terminalChoice.choiceIndex);
        }
    }

    return {observe, assertTerminal};
}

function isLLMStreamStructuralKey(key) {
    return key === 'tool_calls'
        || key === 'toolCalls'
        || key === 'tool_call'
        || key === 'toolCall'
        || key === 'function_call'
        || key === 'functionCall';
}

const OMITTED_LLM_STREAM_DATA = Symbol('omitted-llm-stream-data');

function projectLLMStreamData(value, seen = new Map()) {
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value !== 'object') {
        return value;
    }
    if (seen.has(value)) {
        return seen.get(value);
    }
    if (Array.isArray(value)) {
        const result = [];
        seen.set(value, result);
        for (const item of value) {
            const projected = projectLLMStreamData(item, seen);
            if (projected !== OMITTED_LLM_STREAM_DATA) result.push(projected);
        }
        return result.length || value.length === 0
            ? result
            : OMITTED_LLM_STREAM_DATA;
    }
    const result = {};
    seen.set(value, result);
    let sourceDataFields = 0;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === 'symbol') {
            continue;
        }
        const descriptor = descriptors[key];
        if (!Object.hasOwn(descriptor, 'value')) {
            continue;
        }
        sourceDataFields += 1;
        if (isLLMStreamStructuralKey(key)) {
            continue;
        }
        const projected = projectLLMStreamData(descriptor.value, seen);
        if (projected !== OMITTED_LLM_STREAM_DATA) result[key] = projected;
    }
    return Object.keys(result).length || sourceDataFields === 0
        ? result
        : OMITTED_LLM_STREAM_DATA;
}

function projectLLMStreamChunk(value) {
    return projectLLMStreamData(value);
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

function completeProgress(value) {
    if (!isPlainRecord(value)) {
        fail('AI provider progress must be a plain object.');
    }
    const result = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = descriptors[key];
        if (typeof key === 'symbol' || !Object.hasOwn(descriptor, 'value')) {
            fail('AI provider progress must contain string-keyed data properties only.');
        }
        result[key] = descriptor.value;
    }
    return completeValue(result);
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
    const maxConcurrentRequests = provider.maxConcurrentRequests === undefined
        ? 1
        : provider.maxConcurrentRequests;
    if (!Number.isSafeInteger(maxConcurrentRequests)
        || maxConcurrentRequests < 1) {
        fail('AI provider.maxConcurrentRequests must be a positive safe integer.');
    }
    if (provider.role !== 'tts' && maxConcurrentRequests !== 1) {
        fail('Only TTS providers may process more than one concurrent request.');
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
        localOnly: provider.localOnly,
        maxConcurrentRequests
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
        activeRequests: new Map(),
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
        arcaneLogging.debug('[Arcane speech runtime] speechMuted', this.#speechMuted);
        return this.#speechMuted;
    }

    get configured() {
        return this.#configured;
    }

    register(provider) {
        this.#assertOpen();
        this.#assertNotConfiguring();
        const admitted = validateProvider(provider);
        if (SPEECH_ROLES.includes(admitted.role)) {
            arcaneLogging.debug('[Arcane speech runtime] register', provider);
        }
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

        const unregister = this.#createProviderUnregisterHandle(admitted);
        if (SPEECH_ROLES.includes(admitted.role)) {
            arcaneLogging.debug('[Arcane speech runtime] register.result', admitted.role, admitted.id, unregister);
        }
        return unregister;
    }

    unregister(role, providerId, expectedProvider = null) {
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] unregister', role, providerId, expectedProvider);
        }
        this.#assertOpen();
        this.#assertNotConfiguring();
        assertRole(role);
        assertIdentifier(providerId, 'AI provider id');
        const key = providerKey(role, providerId);
        const provider = this.#providers.get(key);
        if (!provider || (expectedProvider && provider !== expectedProvider)) {
            if (SPEECH_ROLES.includes(role)) {
                arcaneLogging.debug('[Arcane speech runtime] unregister.result', role, providerId, false);
            }
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
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] unregister.result', role, providerId, true);
        }
        return true;
    }

    hasProvider(role, providerId) {
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] hasProvider', role, providerId);
        }
        assertRole(role);
        assertIdentifier(providerId, 'AI provider id');
        const result = this.#providers.has(providerKey(role, providerId));
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] hasProvider.result', role, providerId, result);
        }
        return result;
    }

    ownsProvider(role, expectedProvider) {
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] ownsProvider', role, expectedProvider);
        }
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

        const result = this.#providers.get(providerKey(role, admitted.id)) === admitted;
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] ownsProvider.result', role, admitted.id, result);
        }
        return result;
    }

    providerIdentity(role, providerId) {
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] providerIdentity', role, providerId);
        }
        assertRole(role);
        assertIdentifier(providerId, 'AI provider id');
        const provider = this.#providers.get(providerKey(role, providerId)) ?? null;
        if (!provider) {
            if (SPEECH_ROLES.includes(role)) {
                arcaneLogging.debug('[Arcane speech runtime] providerIdentity.result', role, providerId, null);
            }
            return null;
        }
        const result = completeValue(
            {
                protocol: provider.protocol,
                role: provider.role,
                id: provider.id,
                localOnly: provider.localOnly
            }
        );
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] providerIdentity.result', role, providerId, result);
        }
        return result;
    }

    selection(role, options = {}) {
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] selection', role, options);
        }
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
        const selection = localOnly ? slot.routes.localOnly : slot.routes.default;
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] selection.result', role, selection);
        }
        return selection;
    }

    ownsSelection(role, providerId, options = {}) {
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] ownsSelection', role, providerId, options);
        }
        assertRole(role);
        assertIdentifier(providerId, 'AI provider id');
        const result = this.selection(role, options)?.providerId === providerId;
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] ownsSelection.result', role, providerId, result);
        }
        return result;
    }

    validateConfiguration(value) {
        arcaneLogging.debug('[Arcane speech runtime] validateConfiguration', value);
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
        arcaneLogging.debug('[Arcane speech runtime] validateConfiguration.result', selections);
        return selections;
    }

    validateSpeechConfiguration(value) {
        arcaneLogging.debug('[Arcane speech runtime] validateSpeechConfiguration', value);
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
        arcaneLogging.debug('[Arcane speech runtime] validateSpeechConfiguration.result', selections);
        return selections;
    }

    configure(value) {
        arcaneLogging.debug('[Arcane speech runtime] configure', value);
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
        arcaneLogging.debug('[Arcane speech runtime] configure.result', selections);
        return selections;
    }

    configureSpeech(value) {
        arcaneLogging.debug('[Arcane speech runtime] configureSpeech', value);
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
        arcaneLogging.debug('[Arcane speech runtime] configureSpeech.result', selections);
        return selections;
    }

    replaceSpeechProvider(role, value) {
        arcaneLogging.debug('[Arcane speech runtime] replaceSpeechProvider', role, value);
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
            const result = this.#commitSpeechProviderRoleReplacement(role, value);
            arcaneLogging.debug('[Arcane speech runtime] replaceSpeechProvider.result', role, result);
            return result;
        } finally {
            this.#configuring = false;
        }
    }

    #pendingSpeechProviderHydrationMatches(role, slot) {
        if (!slot.selection) {
            return false;
        }
        const pending = slot.selection;
        if (this.#providers.has(providerKey(role, pending.providerId))) {
            return false;
        }
        const currentSelections = [
            slot.selection,
            slot.routes.default,
            slot.routes.localOnly
        ].filter(Boolean);
        return currentSelections.length > 0
            && currentSelections.every(
                function isSamePendingSpeechSelection(selection) {
                    return selection.providerId === pending.providerId
                        && selection.modelId === pending.modelId
                        && selection.localOnly === null;
                }
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
                slot
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
        arcaneLogging.debug('[Arcane speech runtime] replaceSpeechProviders', value);
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
            const result = this.#commitSpeechProviderReplacement(value);
            arcaneLogging.debug('[Arcane speech runtime] replaceSpeechProviders.result', result);
            return result;
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
                    slot
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
        arcaneLogging.debug('[Arcane speech runtime] configureFromTuple', tuple);
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

    status(role = null, options = {}) {
        if (role === null || SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] status', role, options);
        }
        if (role !== null) {
            assertRole(role);
        }
        const snapshot = getAIRuntimeState();
        if (options?.execution !== true) {
            const result = role === null ? snapshot : snapshot.roles[role];
            if (role === null || SPEECH_ROLES.includes(role)) {
                arcaneLogging.debug('[Arcane speech runtime] status.result', role, result);
            }
            return result;
        }

        // Live provider inspection is explicit so ordinary lifecycle reads
        // retain their sticky snapshot identity and never call a provider.
        const roles = {...snapshot.roles};
        for (const selectedRole of role === null ? AI_RUNTIME_ROLES : [role]) {
            const provider = this.#providerFor(this.#slots[selectedRole]);
            if (!provider) {
                continue;
            }
            const providerStatus = validateProviderStatus(provider.status());
            if (SPEECH_ROLES.includes(selectedRole)) {
                arcaneLogging.debug('[Arcane speech runtime] provider.status.result', selectedRole, providerStatus);
            }
            if (providerStatus.execution == null) {
                continue;
            }
            roles[selectedRole] = {
                ...roles[selectedRole],
                execution: {...providerStatus.execution}
            };
        }
        const result = role === null ? {...snapshot, roles} : roles[role];
        if (role === null || SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] status.result', role, result);
        }
        return result;
    }

    catalog(role) {
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] catalog', role);
        }
        assertRole(role);
        const entries = [];
        for (const provider of this.#providers.values()) {
            if (provider.role !== role) {
                continue;
            }
            const providerCatalog = provider.catalog();
            if (SPEECH_ROLES.includes(role)) {
                arcaneLogging.debug('[Arcane speech runtime] provider.catalog.result', role, provider.id, providerCatalog);
            }
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
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] catalog.result', role, entries);
        }
        return completeValue(entries);
    }

    async inspect(role, options = {}) {
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] inspect', role, options);
        }
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
            const result = completeValue({
                available: false,
                code: 'ARCANE_AI_ROLE_NOT_SELECTED',
                message: `No ${role} provider and model are selected.`
            });
            if (SPEECH_ROLES.includes(role)) {
                arcaneLogging.debug('[Arcane speech runtime] inspect.result', role, result);
            }
            return result;
        }
        const provider = this.#providers.get(
            providerKey(role, selection.providerId)
        ) ?? null;
        if (!provider) {
            const result = completeValue({
                available: false,
                code: 'ARCANE_AI_PROVIDER_UNAVAILABLE',
                message: `The selected ${role} provider is not registered.`
            });
            if (SPEECH_ROLES.includes(role)) {
                arcaneLogging.debug('[Arcane speech runtime] inspect.result', role, result);
            }
            return result;
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
            if (SPEECH_ROLES.includes(role)) {
                arcaneLogging.debug('[Arcane speech runtime] provider.inspect.result', role, selection, inspection);
            }
            if (signal?.aborted) {
                throw normalizedAbort();
            }
        } catch (error) {
            if (SPEECH_ROLES.includes(role)) {
                arcaneLogging.debug('[Arcane speech runtime] inspect.error', role, error);
            }
            if (isAbort(error, signal)) {
                if (SPEECH_ROLES.includes(role)) {
                    arcaneLogging.debug('[Arcane speech runtime] inspect.cancelled', role, error);
                }
                throw normalizedAbort(error);
            }
            this.#assertOpen();
            this.#assertNotConfiguring();
            this.#assertCurrentOperation(slot, generation, signal);
            const unavailable = stateError(
                error,
                'ARCANE_AI_PROVIDER_AUTHORITY_BLOCKED'
            );
            const result = completeValue({
                available: false,
                code: unavailable.code,
                message: unavailable.message
            });
            if (SPEECH_ROLES.includes(role)) {
                arcaneLogging.debug('[Arcane speech runtime] inspect.result', role, result);
            }
            return result;
        }
        this.#assertOpen();
        this.#assertNotConfiguring();
        this.#assertCurrentOperation(slot, generation, signal);
        try {
            validateInspection(inspection, selection);
            if (SPEECH_ROLES.includes(role)) {
                arcaneLogging.debug('[Arcane speech runtime] inspect.result', role, inspection);
            }
            return inspection;
        } catch (error) {
            if (SPEECH_ROLES.includes(role)) {
                arcaneLogging.debug('[Arcane speech runtime] inspect.error', role, error);
            }
            const unavailable = stateError(
                error,
                'ARCANE_AI_PROVIDER_AUTHORITY_BLOCKED'
            );
            const result = completeValue({
                available: false,
                code: unavailable.code,
                message: unavailable.message
            });
            if (SPEECH_ROLES.includes(role)) {
                arcaneLogging.debug('[Arcane speech runtime] inspect.result', role, result);
            }
            return result;
        }
    }

    async start(options) {
        arcaneLogging.debug('[Arcane speech runtime] start', options);
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
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] load', role, options);
        }
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
        if (slot.activeRequests.size || slot.requestQueue.length) {
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
                    if (SPEECH_ROLES.includes(role)) {
                        arcaneLogging.debug('[Arcane speech runtime] load.inspection', role, slot.selection, inspection);
                    }
                    validateInspection(inspection, slot.selection);
                    runtime.#assertCurrentOperation(slot, generation, controller.signal);
                    const loadRequest = {
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
                    };
                    if (SPEECH_ROLES.includes(role)) {
                        arcaneLogging.debug('[Arcane speech runtime] provider.load', {generation, operationId}, loadRequest);
                    }
                    const loadResult = await provider.load(loadRequest);
                    if (SPEECH_ROLES.includes(role)) {
                        arcaneLogging.debug('[Arcane speech runtime] provider.load.result', {role, generation, operationId}, loadResult);
                    }
                    runtime.#assertCurrentOperation(slot, generation, controller.signal);
                    const providerStatus = validateProviderStatus(provider.status());
                    if (SPEECH_ROLES.includes(role)) {
                        arcaneLogging.debug('[Arcane speech runtime] load.status', {role, generation, operationId}, providerStatus);
                    }
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
                    if (SPEECH_ROLES.includes(role)) {
                        arcaneLogging.debug('[Arcane speech runtime] load.error', {role, generation, operationId}, error);
                    }
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
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] unload', role, options);
        }
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
            || slot.activeRequests.size > 0
            || providerStatus?.loaded === true
            || providerStatus?.busy === true;
        if (!slot.loadPromise
            && slot.activeRequests.size === 0
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
        const capturedRequestRecords = [...slot.activeRequests.values()];
        for (const requestRecord of capturedRequestRecords) {
            requestRecord.controller.abort(requestCancellation);
        }
        const capturedLoad = slot.loadPromise;
        const capturedRequests = capturedRequestRecords.map(
            function selectAIProviderRequestPromise(requestRecord) {
                return requestRecord.promise;
            }
        ).filter(Boolean);
        const unloadOperationId = providerOwned
            ? this.#nextOperationId(slot, 'unload')
            : null;
        const runtime = this;
        const unloadOperation = Promise.resolve().then(async function unloadAIProviderRole() {
            try {
                if (signal?.aborted) {
                    throw normalizedAbort();
                }
                await Promise.allSettled(
                    capturedRequestRecords.map(
                        function cancelActiveAIProviderRequest(requestRecord) {
                            if (!requestRecord.cancel) {
                                return undefined;
                            }
                            return Promise.resolve().then(
                                function invokeActiveAIProviderRequestCancellation() {
                                    return requestRecord.cancel(requestCancellation);
                                }
                            );
                        }
                    )
                );
                await Promise.allSettled(
                    [capturedLoad, ...capturedRequests].filter(Boolean)
                );
                if (signal?.aborted) {
                    throw normalizedAbort();
                }
                if (provider) {
                    const unloadRequest = {role, selection: slot.selection, signal};
                    if (SPEECH_ROLES.includes(role)) {
                        arcaneLogging.debug('[Arcane speech runtime] provider.unload', {generation, operationId: unloadOperationId}, unloadRequest);
                    }
                    const unloadResult = await provider.unload(unloadRequest);
                    if (SPEECH_ROLES.includes(role)) {
                        arcaneLogging.debug('[Arcane speech runtime] provider.unload.result', {role, generation, operationId: unloadOperationId}, unloadResult);
                    }
                    const unloadedStatus = validateProviderStatus(provider.status());
                    if (SPEECH_ROLES.includes(role)) {
                        arcaneLogging.debug('[Arcane speech runtime] unload.status', role, unloadedStatus);
                    }
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
                if (SPEECH_ROLES.includes(role)) {
                    arcaneLogging.debug('[Arcane speech runtime] unload.error', {role, generation, operationId: unloadOperationId}, error);
                }
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
                        busy: capturedRequestRecords.length > 0,
                        operationId: unloadOperationId
                    }
                )
            );
        }
        return unloadOperation;
    }

    dispose(role, options = {}) {
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] dispose', role, options);
        }
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
                    const disposeRequest = {role, selection: slot.selection, signal};
                    if (SPEECH_ROLES.includes(role)) {
                        arcaneLogging.debug('[Arcane speech runtime] provider.dispose', disposeRequest);
                    }
                    const disposeResult = await provider.dispose(disposeRequest);
                    if (SPEECH_ROLES.includes(role)) {
                        arcaneLogging.debug('[Arcane speech runtime] provider.dispose.result', role, disposeResult);
                    }
                    const disposedStatus = validateProviderStatus(provider.status());
                    if (SPEECH_ROLES.includes(role)) {
                        arcaneLogging.debug('[Arcane speech runtime] dispose.status', role, disposedStatus);
                    }
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
                if (SPEECH_ROLES.includes(role)) {
                    arcaneLogging.debug('[Arcane speech runtime] dispose.error', role, error);
                }
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
        arcaneLogging.debug('[Arcane speech runtime] disposeAll', options);
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
                slot.activeRequests.clear();
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
                arcaneLogging.debug('[Arcane speech runtime] disposeAll.result', result);
                runtime.#disposeAllPromise = null;
                return result;
            },
            function releaseFailedAIProviderRuntimeDisposal(error) {
                arcaneLogging.debug('[Arcane speech runtime] disposeAll.error', error);
                runtime.#disposeAllPromise = null;
                throw error;
            }
        );
        return this.#disposeAllPromise;
    }

    request(role, options = {}) {
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] request', role, options);
        }
        return this.#requestRole(role, options, false);
    }

    #requestRole(role, options, queued) {
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
        const maxConcurrentRequests = this.#providerRequestCapacity(provider);
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] request.state', {
                role,
                generation: slot.generation,
                selection: slot.selection,
                ready: slot.ready,
                activeRequests: slot.activeRequests.size,
                queuedRequests: slot.requestQueue.length,
                maxConcurrentRequests,
                queued
            }, providerStatus);
        }
        if ((!queued && slot.requestQueue.length)
            || slot.activeRequests.size >= maxConcurrentRequests) {
            return this.#enqueueRoleRequest(slot, options);
        }
        if (!slot.ready
            || providerStatus.state !== 'ready'
            || providerStatus.loaded !== true
            || (providerStatus.busy !== false
                && slot.activeRequests.size === 0)) {
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
            operationId,
            requestSequence,
            promise: null,
            cancel: null
        };
        slot.activeRequests.set(requestSequence, requestRecord);
        this.#publishRoleRequestState(slot);

        function restoreAIProviderRoleAfterRequest(error) {
            if (slot.generation !== generation
                || slot.unloadPromise) {
                return;
            }
            if (slot.activeRequests.size || slot.requestQueue.length) {
                slot.ready = true;
                runtime.#publishRoleRequestState(slot);
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
            const llmToolCallCorrelation = role === 'llm'
                ? createLLMStreamToolCallCorrelation()
                : null;
            let privateStreamObservation = null;
            const projectedStreamChunks = [];
            const projectedStreamReaders = [];
            let projectedStreamClosed = false;
            let projectedStreamError = null;
            let terminalSettled = false;
            let resolveTerminal;
            let rejectTerminal;
            const terminal = new Promise(function createAIProviderStreamTerminal(resolve, reject) {
                resolveTerminal = resolve;
                rejectTerminal = reject;
            });
            terminal.catch(function retainAIProviderStreamTerminalRejection() {});
            requestRecord.promise = terminal;

            function drainProjectedAIProviderStreamReaders() {
                while (projectedStreamReaders.length
                    && projectedStreamChunks.length) {
                    const reader = projectedStreamReaders.shift();
                    reader.resolve({
                        value: projectedStreamChunks.shift(),
                        done: false
                    });
                }
                if (!projectedStreamClosed || projectedStreamChunks.length) {
                    return;
                }
                while (projectedStreamReaders.length) {
                    const reader = projectedStreamReaders.shift();
                    if (projectedStreamError) {
                        reader.reject(projectedStreamError);
                    } else {
                        reader.resolve({value: undefined, done: true});
                    }
                }
            }

            function publishProjectedAIProviderStreamChunk(value) {
                projectedStreamChunks.push(value);
                drainProjectedAIProviderStreamReaders();
            }

            function closeProjectedAIProviderStream(error = null) {
                if (projectedStreamClosed) {
                    return;
                }
                projectedStreamClosed = true;
                projectedStreamError = error;
                drainProjectedAIProviderStreamReaders();
            }

            function readProjectedAIProviderStreamChunk() {
                if (projectedStreamChunks.length) {
                    return Promise.resolve({
                        value: projectedStreamChunks.shift(),
                        done: false
                    });
                }
                if (projectedStreamClosed) {
                    return projectedStreamError
                        ? Promise.reject(projectedStreamError)
                        : Promise.resolve({value: undefined, done: true});
                }
                return new Promise(
                    function awaitProjectedAIProviderStreamChunk(resolve, reject) {
                        projectedStreamReaders.push({resolve, reject});
                    }
                );
            }

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
                if (slot.activeRequests.get(requestSequence) === requestRecord) {
                    slot.activeRequests.delete(requestSequence);
                }
                runtime.#drainRoleRequestQueue(slot);
                if (error) {
                    closeProjectedAIProviderStream(error);
                    restoreAIProviderRoleAfterRequest(error);
                    rejectTerminal(error);
                } else {
                    closeProjectedAIProviderStream();
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
                const terminalOutcome = terminalError ?? normalizedAbort(
                    reason instanceof Error
                        ? reason
                        : operationError(
                            'The AI stream was cancelled.',
                            'ARCANE_AI_REQUEST_ABORTED'
                        )
                );
                closeProjectedAIProviderStream(terminalOutcome);
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
                        requestRecord,
                        controller.signal
                    );
                    privateStreamObservation = (
                        async function observePrivateAIProviderStream() {
                            try {
                                while (true) {
                                    const result = await iterator.next();
                                    runtime.#assertCurrentRequest(
                                        slot,
                                        generation,
                                        requestSequence,
                                        requestRecord,
                                        controller.signal
                                    );
                                    if (result.done) {
                                        return;
                                    }
                                    if (role !== 'llm') {
                                        publishProjectedAIProviderStreamChunk(result.value);
                                        continue;
                                    }
                                    llmToolCallCorrelation.observe(result.value);
                                    const projected = projectLLMStreamChunk(result.value);
                                    if (projected !== OMITTED_LLM_STREAM_DATA) {
                                        publishProjectedAIProviderStreamChunk(projected);
                                    }
                                }
                            } catch (error) {
                                const normalized = isAbort(error, controller.signal)
                                    ? normalizedAbort(error)
                                    : error;
                                closeProjectedAIProviderStream(normalized);
                                try {
                                    await cancelAIProviderStream(normalized, normalized);
                                } catch {
                                    // Cancellation owns any cleanup failure.
                                }
                                throw normalized;
                            }
                        }
                    )();
                    privateStreamObservation.catch(
                        function retainPrivateAIProviderStreamRejection() {}
                    );
                    Promise.resolve(opened.result).then(
                        async function acceptAIProviderStreamResult(value) {
                            try {
                                await privateStreamObservation;
                                runtime.#assertCurrentRequest(
                                    slot,
                                    generation,
                                    requestSequence,
                                    requestRecord,
                                    controller.signal
                                );
                                const terminalValue = role === 'llm'
                                    ? validateLLMTerminalResult(
                                        value,
                                        'AI provider stream result'
                                    )
                                    : value;
                                llmToolCallCorrelation?.assertTerminal(terminalValue);
                                settleAIProviderStream(null, terminalValue);
                            } catch (error) {
                                if (cleanupPromise) {
                                    try {
                                        await cleanupPromise;
                                    } catch {
                                        // Stream cancellation owns terminal cleanup failure.
                                    }
                                    return;
                                }
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
                        next() {
                            return readProjectedAIProviderStreamChunk();
                        },
                        async return(value) {
                            cancelAIProviderStream(
                                operationError(
                                    'The AI stream consumer stopped before completion.',
                                    'ARCANE_AI_REQUEST_ABORTED'
                                )
                            ).catch(
                                function reportReturnedAIProviderStreamCancellationFailure(error) {
                                    arcaneLogging.error(
                                        'Arcane AI provider stream early-return cancellation failed.',
                                        error
                                    );
                                }
                            );
                            return {value, done: true};
                        },
                        async throw(error) {
                            await cancelAIProviderStream(error, error);
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
                    closeProjectedAIProviderStream(normalized);
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
            if (SPEECH_ROLES.includes(role)) {
                arcaneLogging.debug('[Arcane speech runtime] provider.request.cancel', {role, generation, requestSequence, operationId}, reason);
            }
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
                const providerRequest = {
                    role,
                    selection: slot.selection,
                    operation: options.operation,
                    payload: options.payload,
                    signal: controller.signal
                };
                if (SPEECH_ROLES.includes(role)) {
                    arcaneLogging.debug('[Arcane speech runtime] provider.request', {generation, requestSequence, operationId}, providerRequest);
                }
                const result = await provider.request(providerRequest);
                if (SPEECH_ROLES.includes(role)) {
                    arcaneLogging.debug('[Arcane speech runtime] provider.request.result', {role, generation, requestSequence, operationId}, result);
                }
                runtime.#assertCurrentRequest(
                    slot,
                    generation,
                    requestSequence,
                    requestRecord,
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
                if (SPEECH_ROLES.includes(role)) {
                    arcaneLogging.debug('[Arcane speech runtime] provider.request.error', {role, generation, requestSequence, operationId}, error);
                }
                requestError = normalized;
                throw normalized;
            } finally {
                detachSignal();
                if (slot.activeRequests.get(requestSequence) === requestRecord) {
                    slot.activeRequests.delete(requestSequence);
                }
                if (SPEECH_ROLES.includes(role)) {
                    arcaneLogging.debug('[Arcane speech runtime] request.settled', {
                        role,
                        generation,
                        currentGeneration: slot.generation,
                        requestSequence,
                        operationId,
                        activeRequests: slot.activeRequests.size,
                        queuedRequests: slot.requestQueue.length
                    }, requestError);
                }
                runtime.#drainRoleRequestQueue(slot);
                if (slot.generation === generation && !slot.unloadPromise) {
                    restoreAIProviderRoleAfterRequest(requestError);
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
        arcaneLogging.debug('[Arcane speech runtime] transcribe', payload, options);
        return this.#roleRequestAlias('stt', 'transcribe', payload, options);
    }

    synthesize(payload, options = {}) {
        arcaneLogging.debug('[Arcane speech runtime] synthesize', payload, options);
        return this.#roleRequestAlias('tts', 'synthesize', payload, options);
    }

    cancel(role) {
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] cancel', role);
        }
        assertRole(role);
        const slot = this.#slots[role];
        const requestRecord = slot.activeRequests.values().next().value ?? null;
        if (!requestRecord) {
            if (SPEECH_ROLES.includes(role)) {
                arcaneLogging.debug('[Arcane speech runtime] cancel.result', role, false);
            }
            return false;
        }
        const reason = operationError(
            `AI role ${role} request was cancelled.`,
            'ARCANE_AI_REQUEST_ABORTED'
        );
        requestRecord?.controller.abort(reason);
        const cancellation = requestRecord?.cancel?.(reason);
        cancellation?.catch(function retainAIProviderCancelFailureInState() {});
        if (SPEECH_ROLES.includes(role)) {
            arcaneLogging.debug('[Arcane speech runtime] cancel.result', role, true, requestRecord.operationId);
        }
        return true;
    }

    async setSpeechMuted(muted) {
        arcaneLogging.debug('[Arcane speech runtime] setSpeechMuted', muted);
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
                        arcaneLogging.debug('[Arcane speech runtime] setSpeechMuted.settled', desiredMuted);
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
        if (SPEECH_ROLES.includes(slot.role)) {
            arcaneLogging.debug('[Arcane speech runtime] queue.enqueue', {
                role: slot.role,
                generation: slot.generation,
                selection: slot.selection,
                activeRequests: slot.activeRequests.size,
                queuedRequests: slot.requestQueue.length
            }, options);
        }
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
                if (SPEECH_ROLES.includes(slot.role)) {
                    arcaneLogging.debug('[Arcane speech runtime] queue.cancelled', {
                        role: slot.role,
                        generation: slot.generation,
                        queuedRequests: slot.requestQueue.length
                    }, options, options.signal?.reason);
                }
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
            runtime.#publishRoleRequestState(slot);
            runtime.#drainRoleRequestQueue(slot);
        });
    }

    #drainRoleRequestQueue(slot) {
        if (slot.unloadPromise
            || slot.disposePromise
            || slot.disposed) {
            return;
        }
        const provider = this.#providerFor(slot);
        const maxConcurrentRequests = this.#providerRequestCapacity(provider);
        const runtime = this;
        while (slot.requestQueue.length
            && slot.activeRequests.size < maxConcurrentRequests) {
            const entry = slot.requestQueue.shift();
            entry.detachSignal?.();
            if (SPEECH_ROLES.includes(slot.role)) {
                arcaneLogging.debug('[Arcane speech runtime] queue.dispatch', {
                    role: slot.role,
                    generation: slot.generation,
                    activeRequests: slot.activeRequests.size,
                    queuedRequests: slot.requestQueue.length,
                    maxConcurrentRequests
                }, entry.options);
            }
            if (entry.options.signal?.aborted) {
                entry.reject(normalizedAbort(entry.options.signal.reason));
                continue;
            }
            let operation;
            try {
                operation = runtime.#requestRole(slot.role, entry.options, true);
            } catch (error) {
                if (SPEECH_ROLES.includes(slot.role)) {
                    arcaneLogging.debug('[Arcane speech runtime] queue.error', slot.role, entry.options, error);
                }
                entry.reject(error);
                continue;
            }
            Promise.resolve(operation).then(entry.resolve, entry.reject);
        }
    }

    #rejectQueuedRoleRequests(slot, error) {
        const queued = slot.requestQueue.splice(0);
        for (const entry of queued) {
            entry.detachSignal?.();
            if (SPEECH_ROLES.includes(slot.role)) {
                arcaneLogging.debug('[Arcane speech runtime] queue.rejected', slot.role, entry.options, error);
            }
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
            || slot.activeRequests.size > 0
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

    #assertCurrentRequest(
        slot,
        generation,
        requestSequence,
        requestRecord,
        signal
    ) {
        this.#assertCurrentOperation(slot, generation, signal);
        if (slot.activeRequests.get(requestSequence) !== requestRecord) {
            throw operationError(
                `AI role ${slot.role} no longer owns the active provider request.`,
                'ARCANE_AI_REQUEST_STALE'
            );
        }
    }

    #providerRequestCapacity(provider) {
        return provider?.role === 'tts'
            ? provider.maxConcurrentRequests
            : 1;
    }

    #publishRoleRequestState(slot) {
        const requestRecord = slot.activeRequests.values().next().value ?? null;
        if (SPEECH_ROLES.includes(slot.role)) {
            arcaneLogging.debug('[Arcane speech runtime] queue.state', {
                role: slot.role,
                generation: slot.generation,
                selection: slot.selection,
                operationId: requestRecord?.operationId ?? null,
                activeRequests: slot.activeRequests.size,
                queuedRequests: slot.requestQueue.length
            });
        }
        if (!requestRecord && slot.requestQueue.length === 0) {
            return false;
        }
        publishAIRuntimeRoleState(
            slot.role,
            roleRecord(
                slot.role,
                slot.selection,
                {
                    state: 'ready',
                    loaded: true,
                    busy: true,
                    operationId: requestRecord?.operationId ?? null
                }
            )
        );
        return true;
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
        if (SPEECH_ROLES.includes(slot.role)) {
            arcaneLogging.debug('[Arcane speech runtime] load.progress', {
                role: slot.role,
                generation,
                currentGeneration: slot.generation,
                operationId,
                aborted: slot.loadController?.signal.aborted
            }, progress);
        }
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
                    progress: completeProgress(progress)
                }
            )
        );
        return true;
    }

    #publishRoleError(slot, error, loaded) {
        const requestRecord = slot.activeRequests.values().next().value ?? null;
        if (SPEECH_ROLES.includes(slot.role)) {
            arcaneLogging.debug('[Arcane speech runtime] role.error', {
                role: slot.role,
                generation: slot.generation,
                selection: slot.selection,
                operationId: requestRecord?.operationId ?? null,
                loaded,
                activeRequests: slot.activeRequests.size,
                queuedRequests: slot.requestQueue.length
            }, error);
        }
        publishAIRuntimeRoleState(
            slot.role,
            roleRecord(
                slot.role,
                slot.selection,
                {
                    state: 'error',
                    loaded,
                    busy: Boolean(requestRecord || slot.requestQueue.length),
                    operationId: requestRecord?.operationId ?? null,
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
        if (SPEECH_ROLES.includes(intent.role)) {
            arcaneLogging.debug('[Arcane speech runtime] intent', intent);
        }
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

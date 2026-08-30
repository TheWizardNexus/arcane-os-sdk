const IDENTIFIER_MAXIMUM_CHARACTERS = 128;

const SCHEMA = 'arcane.twin-policy-decision';
const VERSION = 1;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){2,7}$/;
const REQUIREMENT_TARGET_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,7}$/;
const EXPLICIT_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const RESERVED_KEYS_VALUES = ['__proto__', 'constructor', 'prototype'];
const LAYER_VALUES = ['advisory', 'organization', 'platform', 'role'];
const OUTCOME_VALUES = ['confirm', 'constrain', 'deny', 'escalate', 'log', 'permit', 'redact'];
const REQUIREMENT_OUTCOME_VALUES = ['confirm', 'constrain', 'escalate', 'log', 'redact'];
const CORE_REASON_CODE_VALUES = {
    confirm: 'arcane.policy.confirm',
    constrain: 'arcane.policy.constrain',
    deny: 'arcane.policy.deny',
    escalate: 'arcane.policy.escalate',
    log: 'arcane.policy.log',
    permit: 'arcane.policy.permit',
    redact: 'arcane.policy.redact'
};
const ROOT_KEY_VALUES = [
    'schema',
    'version',
    'id',
    'evaluatedAt',
    'layer',
    'policy',
    'outcome',
    'reasonCodes',
    'requirements'
];
const PAYLOAD_KEY_VALUES = ['outcome', 'reasonCodes', 'requirements'];
const TRUSTED_CONTEXT_KEY_VALUES = ['id', 'evaluatedAt', 'layer', 'policyId', 'policyVersion'];
const POLICY_KEY_VALUES = ['id', 'version'];
const REQUIREMENT_KEY_VALUES = ['id', 'reasonCode', 'target', 'value'];

const RESERVED_KEYS = new Set(RESERVED_KEYS_VALUES);
const LAYERS = new Set(LAYER_VALUES);
const OUTCOMES = new Set(OUTCOME_VALUES);
const REQUIREMENT_OUTCOMES = new Set(REQUIREMENT_OUTCOME_VALUES);
const ROOT_KEYS = ROOT_KEY_VALUES;
const PAYLOAD_KEYS = PAYLOAD_KEY_VALUES;
const TRUSTED_CONTEXT_KEYS = TRUSTED_CONTEXT_KEY_VALUES;
const POLICY_KEYS = POLICY_KEY_VALUES;
const REQUIREMENT_KEYS = REQUIREMENT_KEY_VALUES;
const CORE_REASON_CODES = CORE_REASON_CODE_VALUES;
const CORE_REASON_CODE_SET = new Set(Object.values(CORE_REASON_CODES));

const constructionToken = Symbol('TWiNPolicyDecision construction');
const decisionInstances = new WeakSet();
const validationFailureTokens = new WeakMap();
let activeValidationToken = null;

export class TWiNPolicyDecisionValidationError extends TypeError {
    constructor(code, path, message) {
        super(message);
        defineDataProperty(this, 'name', 'TWiNPolicyDecisionValidationError');
        defineDataProperty(this, 'code', code);
        defineDataProperty(this, 'path', path);
    }
}

function fail(code, path, message) {
    const error = new TWiNPolicyDecisionValidationError(code, path, message);

    validationFailureTokens.set(error, activeValidationToken);
    throw error;
}

function validationBoundary(operation) {
    const previousToken = activeValidationToken;
    const operationToken = Symbol('TWiNPolicyDecision validation');

    activeValidationToken = operationToken;
    try {
        return operation();
    } catch (error) {
        if (validationFailureTokens.get(error) === operationToken) {
            throw error;
        }
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            '$',
            'TWiN policy decision input could not be inspected safely.'
        );
    } finally {
        activeValidationToken = previousToken;
    }
}

function safeRecord() {
    return {};
}

function defineDataProperty(target, key, value) {
    Object.defineProperty(
        target,
        key,
        {
            configurable: true,
            enumerable: true,
            value,
            writable: true
        }
    );

    return target;
}

function appendOwn(array, value) {
    defineDataProperty(array, array.length, value);

    return array;
}

function safeArray(values) {
    const array = [];

    for (let index = 0; index < values.length; index += 1) {
        appendOwn(array, values[index]);
    }
    return array;
}

function sortedCopy(values, compare) {
    const sorted = [];

    for (let index = 0; index < values.length; index += 1) {
        appendOwn(sorted, values[index]);
    }
    for (let index = 1; index < sorted.length; index += 1) {
        const current = sorted[index];
        let destination = index;

        while (destination > 0 && compare(sorted[destination - 1], current) > 0) {
            defineDataProperty(sorted, destination, sorted[destination - 1]);
            destination -= 1;
        }
        defineDataProperty(sorted, destination, current);
    }

    return sorted;
}

function validateUnicode(value, path) {
    for (let index = 0; index < value.length; index += 1) {
        const unit = value.charCodeAt(index);

        if (unit >= 0xD800 && unit <= 0xDBFF) {
            const following = value.charCodeAt(index + 1);

            if (!(following >= 0xDC00 && following <= 0xDFFF)) {
                fail(
                    'TWIN_POLICY_DECISION_INVALID',
                    path,
                    'TWiN policy decision text contains invalid Unicode.'
                );
            }
            index += 1;
        } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
            fail(
                'TWIN_POLICY_DECISION_INVALID',
                path,
                'TWiN policy decision text contains invalid Unicode.'
            );
        }
    }

    return value;
}

function normalizedString(value, path, options = {}) {
    const nullable = options.nullable === true;
    const nonempty = options.nonempty !== false;

    if (nullable && value === null) {
        return null;
    }
    if (typeof value !== 'string') {
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            path,
            'TWiN policy decision field has an invalid type.'
        );
    }
    validateUnicode(value, path);
    if (nonempty && !value.trim()) {
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            path,
            'TWiN policy decision field must contain text.'
        );
    }
    return value;
}

function identifier(value, path) {
    if (typeof value !== 'string') {
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            path,
            'TWiN policy decision identifier has an invalid type.'
        );
    }
    validateUnicode(value, path);
    if (value.length > IDENTIFIER_MAXIMUM_CHARACTERS || !IDENTIFIER_PATTERN.test(value)) {
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            path,
            'TWiN policy decision identifier is invalid.'
        );
    }

    return value;
}

function enumeration(value, path, allowed) {
    if (typeof value !== 'string' || !allowed.has(value)) {
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            path,
            'TWiN policy decision enum value is invalid.'
        );
    }

    return value;
}

function isReservedKey(key) {
    return typeof key === 'string' && RESERVED_KEYS.has(key);
}

function plainRecord(value, path, allowedKeys, active) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            path,
            'TWiN policy decision field must be a plain record.'
        );
    }
    const prototype = Object.getPrototypeOf(value);

    if (
        prototype !== Object.prototype
        && prototype !== null
        && !decisionInstances.has(value)
    ) {
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            path,
            'TWiN policy decision record prototype is invalid.'
        );
    }
    if (active.has(value)) {
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            path,
            'TWiN policy decision data must not contain cycles.'
        );
    }
    active.add(value);
    const allowed = new Set(allowedKeys);

    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || isReservedKey(key) || !allowed.has(key)) {
            active.delete(value);
            fail(
                'TWIN_POLICY_DECISION_UNKNOWN_FIELD',
                path,
                'TWiN policy decision contains an unsupported field.'
            );
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            active.delete(value);
            fail(
                'TWIN_POLICY_DECISION_INVALID',
                `${path}.${key}`,
                'TWiN policy decision accessors are not allowed.'
            );
        }
    }

    return value;
}

function finishRecord(value, active) {
    active.delete(value);
}

function ownValue(record, key, path, options = {}) {
    const required = options.required !== false;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);

    if (!descriptor) {
        if (required) {
            fail(
                'TWIN_POLICY_DECISION_INVALID',
                `${path}.${key}`,
                'TWiN policy decision required field is missing.'
            );
        }

        return options.defaultValue;
    }

    return descriptor.value;
}

function denseArray(value, path, active) {
    if (!Array.isArray(value)) {
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            path,
            'TWiN policy decision field must be an array.'
        );
    }
    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Array.prototype) {
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            path,
            'TWiN policy decision array prototype is invalid.'
        );
    }
    if (active.has(value)) {
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            path,
            'TWiN policy decision data must not contain cycles.'
        );
    }
    active.add(value);

    for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') {
            continue;
        }
        if (
            typeof key !== 'string'
            || isReservedKey(key)
            || !/^(0|[1-9]\d*)$/.test(key)
            || Number(key) >= value.length
        ) {
            active.delete(value);
            fail(
                'TWIN_POLICY_DECISION_UNKNOWN_FIELD',
                path,
                'TWiN policy decision array contains an unsupported field.'
            );
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            active.delete(value);
            fail(
                'TWIN_POLICY_DECISION_INVALID',
                `${path}[${key}]`,
                'TWiN policy decision accessors are not allowed.'
            );
        }
    }
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
            active.delete(value);
            fail(
                'TWIN_POLICY_DECISION_INVALID',
                `${path}[${index}]`,
                'TWiN policy decision sparse arrays are not allowed.'
            );
        }
    }

    return value;
}

function finishArray(value, active) {
    active.delete(value);
}

function normalizeTimestamp(value, path) {
    if (typeof value !== 'string') {
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            path,
            'TWiN policy decision timestamp is invalid.'
        );
    }
    const instant = new Date(value);

    if (Number.isNaN(instant.valueOf()) || instant.toISOString() !== value) {
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            path,
            'TWiN policy decision timestamp is invalid.'
        );
    }

    return value;
}

function isLeapYear(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isValidExplicitTimestamp(value) {
    if (!EXPLICIT_TIMESTAMP_PATTERN.test(value)) {
        return false;
    }
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const hour = Number(value.slice(11, 13));
    const minute = Number(value.slice(14, 16));
    const second = Number(value.slice(17, 19));
    const daysByMonth = [
        31,
        isLeapYear(year) ? 29 : 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31
    ];

    if (
        month < 1
        || month > 12
        || day < 1
        || day > daysByMonth[month - 1]
        || hour > 23
        || minute > 59
        || second > 59
    ) {
        return false;
    }
    if (!value.endsWith('Z')) {
        const offsetHour = Number(value.slice(-5, -3));
        const offsetMinute = Number(value.slice(-2));

        if (offsetHour > 23 || offsetMinute > 59) {
            return false;
        }
    }

    return true;
}

function normalizeTrustedTimestamp(value, path) {
    if (!(typeof value === 'string' || (value && typeof value === 'object'))) {
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            path,
            'TWiN policy decision timestamp is invalid.'
        );
    }
    let instant;

    if (typeof value === 'string' && !isValidExplicitTimestamp(value)) {
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            path,
            'TWiN policy decision timestamp is invalid.'
        );
    }
    try {
        if (typeof value === 'string') {
            instant = new Date(value);
        } else {
            instant = new Date(Date.prototype.getTime.call(value));
        }
    } catch {
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            path,
            'TWiN policy decision timestamp is invalid.'
        );
    }

    if (Number.isNaN(instant.valueOf())) {
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            path,
            'TWiN policy decision timestamp is invalid.'
        );
    }

    return instant.toISOString();
}

function normalizeReasonCode(value, path) {
    const code = normalizedString(value, path);

    if (!REASON_CODE_PATTERN.test(code)) {
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            path,
            'TWiN policy decision reason code is invalid.'
        );
    }

    return code;
}

function compareStrings(left, right) {
    if (left === right) {
        return 0;
    }

    return left < right ? -1 : 1;
}

function normalizeReasonCodes(value, outcome, path, active) {
    const list = denseArray(value, path, active);

    if (list.length === 0) {
        finishArray(list, active);
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            path,
            'TWiN policy decision requires a reason code.'
        );
    }
    const normalized = [];
    const seen = new Set();
    const requiredCode = CORE_REASON_CODES[outcome];

    for (let index = 0; index < list.length; index += 1) {
        const code = normalizeReasonCode(list[index], `${path}[${index}]`);

        if (seen.has(code)) {
            finishArray(list, active);
            fail(
                'TWIN_POLICY_DECISION_INVALID',
                `${path}[${index}]`,
                'TWiN policy decision reason codes must be unique.'
            );
        }
        if (index > 0 && CORE_REASON_CODE_SET.has(code)) {
            finishArray(list, active);
            fail(
                'TWIN_POLICY_DECISION_INCONSISTENT',
                `${path}[${index}]`,
                'TWiN policy decision contains a contradictory core reason code.'
            );
        }
        seen.add(code);
        appendOwn(normalized, code);
    }
    finishArray(list, active);

    if (normalized[0] !== requiredCode) {
        fail(
            'TWIN_POLICY_DECISION_INCONSISTENT',
            `${path}[0]`,
            'TWiN policy decision outcome and core reason code do not agree.'
        );
    }
    const additional = [];

    for (let index = 1; index < normalized.length; index += 1) {
        appendOwn(additional, normalized[index]);
    }
    const sortedAdditional = sortedCopy(additional, compareStrings);
    const canonicalReasons = [];

    appendOwn(canonicalReasons, requiredCode);
    for (let index = 0; index < sortedAdditional.length; index += 1) {
        appendOwn(canonicalReasons, sortedAdditional[index]);
    }

    return safeArray(canonicalReasons);
}

function normalizeRequirementTarget(value, path) {
    const target = normalizedString(
        value,
        path,
        {
            nullable: true
        }
    );

    if (target !== null && !REQUIREMENT_TARGET_PATTERN.test(target)) {
        fail(
            'TWIN_POLICY_DECISION_INVALID',
            path,
            'TWiN policy decision requirement target is invalid.'
        );
    }

    return target;
}

function normalizeScalar(value, path) {
    if (value === null || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        return normalizedString(
            value,
            path,
            {
                nonempty: false
            }
        );
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Object.is(value, -0) ? 0 : value;
    }

    fail(
        'TWIN_POLICY_DECISION_INVALID',
        path,
        'TWiN policy decision requirement value must be a JSON scalar.'
    );
}

function normalizeRequirement(value, path, reasonCodes, active) {
    const record = plainRecord(value, path, REQUIREMENT_KEYS, active);
    const requirement = {
        id: identifier(ownValue(record, 'id', path), `${path}.id`),
        reasonCode: normalizeReasonCode(
            ownValue(record, 'reasonCode', path),
            `${path}.reasonCode`
        ),
        target: normalizeRequirementTarget(
            ownValue(record, 'target', path),
            `${path}.target`
        ),
        value: normalizeScalar(
            ownValue(record, 'value', path),
            `${path}.value`
        )
    };
    finishRecord(record, active);

    if (!reasonCodes.has(requirement.reasonCode)) {
        fail(
            'TWIN_POLICY_DECISION_INCONSISTENT',
            `${path}.reasonCode`,
            'TWiN policy decision requirement references an undeclared reason code.'
        );
    }

    return requirement;
}

function compareRequirements(left, right) {
    return compareStrings(left.id, right.id);
}

function normalizeRequirements(value, outcome, reasonCodes, path, active) {
    const list = denseArray(value, path, active);
    const normalized = [];
    const ids = new Set();

    for (let index = 0; index < list.length; index += 1) {
        const requirement = normalizeRequirement(
            list[index],
            `${path}[${index}]`,
            reasonCodes,
            active
        );

        if (ids.has(requirement.id)) {
            finishArray(list, active);
            fail(
                'TWIN_POLICY_DECISION_INVALID',
                `${path}[${index}].id`,
                'TWiN policy decision requirement identifiers must be unique.'
            );
        }
        ids.add(requirement.id);
        appendOwn(normalized, requirement);
    }
    finishArray(list, active);

    if (REQUIREMENT_OUTCOMES.has(outcome) && normalized.length === 0) {
        fail(
            'TWIN_POLICY_DECISION_INCONSISTENT',
            path,
            'TWiN policy decision outcome requires at least one requirement.'
        );
    }
    if (!REQUIREMENT_OUTCOMES.has(outcome) && normalized.length !== 0) {
        fail(
            'TWIN_POLICY_DECISION_INCONSISTENT',
            path,
            'TWiN policy decision outcome does not accept requirements.'
        );
    }

    return safeArray(sortedCopy(normalized, compareRequirements));
}

function normalizePolicy(value, path, active) {
    const record = plainRecord(value, path, POLICY_KEYS, active);
    const policy = {
        id: identifier(ownValue(record, 'id', path), `${path}.id`),
        version: identifier(ownValue(record, 'version', path), `${path}.version`)
    };
    finishRecord(record, active);

    return policy;
}

function clonePolicy(value) {
    const policy = safeRecord();

    defineDataProperty(policy, 'id', value.id);
    defineDataProperty(policy, 'version', value.version);

    return policy;
}

function cloneRequirement(value) {
    const requirement = safeRecord();

    defineDataProperty(requirement, 'id', value.id);
    defineDataProperty(requirement, 'reasonCode', value.reasonCode);
    defineDataProperty(requirement, 'target', value.target);
    defineDataProperty(requirement, 'value', value.value);

    return requirement;
}

function canonicalRecord(values) {
    const requirements = [];

    for (let index = 0; index < values.requirements.length; index += 1) {
        appendOwn(requirements, cloneRequirement(values.requirements[index]));
    }
    const canonical = safeRecord();

    defineDataProperty(canonical, 'schema', SCHEMA);
    defineDataProperty(canonical, 'version', VERSION);
    defineDataProperty(canonical, 'id', values.id);
    defineDataProperty(canonical, 'evaluatedAt', values.evaluatedAt);
    defineDataProperty(canonical, 'layer', values.layer);
    defineDataProperty(canonical, 'policy', clonePolicy(values.policy));
    defineDataProperty(canonical, 'outcome', values.outcome);
    defineDataProperty(canonical, 'reasonCodes', safeArray(values.reasonCodes));
    defineDataProperty(canonical, 'requirements', safeArray(requirements));

    return canonical;
}

function normalizeValues(input) {
    const active = new WeakSet();
    const record = plainRecord(input, '$', ROOT_KEYS, active);
    const schema = ownValue(record, 'schema', '$');

    if (schema !== SCHEMA) {
        finishRecord(record, active);
        fail(
            'TWIN_POLICY_DECISION_UNSUPPORTED_VERSION',
            'schema',
            'TWiN policy decision schema is unsupported.'
        );
    }
    const version = ownValue(record, 'version', '$');

    if (version !== VERSION) {
        finishRecord(record, active);
        fail(
            'TWIN_POLICY_DECISION_UNSUPPORTED_VERSION',
            'version',
            'TWiN policy decision version is unsupported.'
        );
    }
    const outcome = enumeration(
        ownValue(record, 'outcome', '$'),
        'outcome',
        OUTCOMES
    );
    const reasonCodes = normalizeReasonCodes(
        ownValue(record, 'reasonCodes', '$'),
        outcome,
        'reasonCodes',
        active
    );
    const values = {
        id: identifier(ownValue(record, 'id', '$'), 'id'),
        evaluatedAt: normalizeTimestamp(
            ownValue(record, 'evaluatedAt', '$'),
            'evaluatedAt'
        ),
        layer: enumeration(
            ownValue(record, 'layer', '$'),
            'layer',
            LAYERS
        ),
        policy: normalizePolicy(
            ownValue(record, 'policy', '$'),
            'policy',
            active
        ),
        outcome,
        reasonCodes,
        requirements: normalizeRequirements(
            ownValue(record, 'requirements', '$'),
            outcome,
            new Set(reasonCodes),
            'requirements',
            active
        )
    };
    finishRecord(record, active);

    return values;
}

function normalizeCreatePayload(payload, trustedContext) {
    const active = new WeakSet();
    const source = plainRecord(payload, 'payload', PAYLOAD_KEYS, active);
    const context = plainRecord(
        trustedContext,
        'trustedContext',
        TRUSTED_CONTEXT_KEYS,
        active
    );
    const canonical = {
        schema: SCHEMA,
        version: VERSION,
        id: ownValue(context, 'id', 'trustedContext'),
        evaluatedAt: normalizeTrustedTimestamp(
            ownValue(context, 'evaluatedAt', 'trustedContext'),
            'evaluatedAt'
        ),
        layer: ownValue(context, 'layer', 'trustedContext'),
        policy: {
            id: ownValue(context, 'policyId', 'trustedContext'),
            version: ownValue(context, 'policyVersion', 'trustedContext')
        },
        outcome: ownValue(source, 'outcome', 'payload'),
        reasonCodes: ownValue(source, 'reasonCodes', 'payload'),
        requirements: ownValue(
            source,
            'requirements',
            'payload',
            {
                required: false,
                defaultValue: []
            }
        )
    };
    finishRecord(context, active);
    finishRecord(source, active);

    return canonical;
}

function auditRequirement(value) {
    const requirement = safeRecord();

    defineDataProperty(requirement, 'id', value.id);
    defineDataProperty(requirement, 'reasonCode', value.reasonCode);
    defineDataProperty(requirement, 'targetPresent', value.target !== null);
    defineDataProperty(
        requirement,
        'valueType',
        value.value === null ? 'null' : typeof value.value
    );

    return requirement;
}

class TWiNPolicyDecision {
    constructor(token, values) {
        if (token !== constructionToken) {
            fail(
                'TWIN_POLICY_DECISION_INVALID',
                '$',
                'TWiN policy decisions must be created through the public factory.'
            );
        }
        defineDataProperty(this, 'schema', SCHEMA);
        defineDataProperty(this, 'version', VERSION);
        defineDataProperty(this, 'id', values.id);
        defineDataProperty(this, 'evaluatedAt', values.evaluatedAt);
        defineDataProperty(this, 'layer', values.layer);
        defineDataProperty(this, 'policy', values.policy);
        defineDataProperty(this, 'outcome', values.outcome);
        defineDataProperty(this, 'reasonCodes', values.reasonCodes);
        defineDataProperty(this, 'requirements', values.requirements);
        decisionInstances.add(this);
    }

    toJSON() {
        return canonicalRecord(normalizeValues(this));
    }
}

function buildDecision(canonical) {
    const values = normalizeValues(canonical);

    return new TWiNPolicyDecision(constructionToken, values);
}

export function createTWiNPolicyDecision(payload, trustedContext) {
    return validationBoundary(
        function validateCreateInput() {
            return buildDecision(normalizeCreatePayload(payload, trustedContext));
        }
    );
}

export function rehydrateTWiNPolicyDecision(canonical) {
    return validationBoundary(
        function validateCanonicalInput() {
            let source = canonical;
            let canonicalText = null;

            if (typeof source === 'string') {
                canonicalText = source;
                source = JSON.parse(source);
            }
            const decision = buildDecision(source);

            if (
                canonicalText !== null
                && canonicalText !== JSON.stringify(canonicalRecord(decision))
            ) {
                fail(
                    'TWIN_POLICY_DECISION_INVALID',
                    '$',
                    'TWiN policy decision JSON is not canonical.'
                );
            }

            return decision;
        }
    );
}

export function serializeTWiNPolicyDecision(decision) {
    return JSON.stringify(canonicalRecord(rehydrateTWiNPolicyDecision(decision)));
}

export function twinPolicyDecisionAuditProjection(decision) {
    const value = rehydrateTWiNPolicyDecision(decision);
    const requirements = [];

    for (let index = 0; index < value.requirements.length; index += 1) {
        appendOwn(
            requirements,
            auditRequirement(value.requirements[index])
        );
    }
    const projection = safeRecord();

    defineDataProperty(projection, 'schema', value.schema);
    defineDataProperty(projection, 'version', value.version);
    defineDataProperty(projection, 'id', value.id);
    defineDataProperty(projection, 'evaluatedAt', value.evaluatedAt);
    defineDataProperty(projection, 'layer', value.layer);
    defineDataProperty(projection, 'policy', clonePolicy(value.policy));
    defineDataProperty(projection, 'outcome', value.outcome);
    defineDataProperty(
        projection,
        'reasonCodes',
        safeArray(value.reasonCodes)
    );
    defineDataProperty(
        projection,
        'requirements',
        safeArray(requirements)
    );

    return projection;
}

const limits = {
    identifierCharacters: IDENTIFIER_MAXIMUM_CHARACTERS
};
const contractValue = {
    schema: SCHEMA,
    version: VERSION,
    layers: [...LAYERS],
    outcomes: [...OUTCOMES],
    requirementOutcomes: [...REQUIREMENT_OUTCOMES],
    coreReasonCodes: CORE_REASON_CODES,
    limits
};

export const twinPolicyDecisionContract = contractValue;

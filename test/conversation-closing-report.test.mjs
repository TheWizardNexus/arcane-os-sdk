import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {
    CONVERSATION_CLOSING_REPORT_TOOL_NAME,
    classifyConversationClosingReportCalls,
    createConversationClosingReportTool,
    formatConversationClosingReport,
    normalizeConversationClosingReport
} from 'arcane-os/conversation-closing-report';

const INVALID_REPORT = {code: 'CONVERSATION_CLOSING_REPORT_INVALID'};
const REPORT_INPUT = {
    message: '  Preparing the dragon parade report.\n',
    final_message: '  The <dragon> & its parade are ready.\n'
};
const REPORT_OUTPUT = {
    message: REPORT_INPUT.message,
    finalMessage: REPORT_INPUT.final_message,
    rememberedActions: []
};

test(
    'default closing-report schema retains its existing fields and required values',
    function defaultSchemaCompatibility() {
        const tool = createConversationClosingReportTool();
        const parameters = tool.function.parameters;
        assert.equal(tool.type, 'function');
        assert.equal(tool.function.name, CONVERSATION_CLOSING_REPORT_TOOL_NAME);
        assert.equal(tool.function.name, 'prepare_conversation_closing_report');
        assert.equal(parameters.type, 'object');
        assert.equal(parameters.additionalProperties, false);
        assert.deepEqual(
            Object.keys(parameters.properties),
            ['message', 'final_message', 'remembered_actions']
        );
        assert.deepEqual(
            parameters.required,
            ['message', 'final_message']
        );
        for (const field of ['message', 'final_message']) {
            assert.equal(parameters.properties[field].type, 'string');
            assert.equal(parameters.properties[field].minLength, 1);
        }
        const actions = parameters.properties.remembered_actions;
        assert.equal(actions.type, 'array');
        assert.equal(actions.items.additionalProperties, false);
        assert.deepEqual(
            actions.items.required,
            ['text', 'basis']
        );
        assert.deepEqual(
            actions.items.properties.basis.enum,
            ['user_commitment', 'optional_homework']
        );
    }
);

test(
    'completion schema is opt-in, preserves app descriptions, and isolates factory calls',
    function completionSchemaOptions() {
        const baseline = structuredClone(
            createConversationClosingReportTool()
        );
        const description = '  True means every requested parade task is complete.\nFalse means work remains.  ';
        const declarations = [{description}, {description, required: false}, {description, required: true}];
        for (const declaration of declarations) {
            const options = {
                name: 'finish_parade',
                description: '  Return the complete parade report.\n',
                responseToUsersPromptComplete: declaration
            };
            const originalOptions = structuredClone(options);
            const tool = createConversationClosingReportTool(options);
            const parameters = tool.function.parameters;
            assert.deepEqual(options, originalOptions);
            assert.equal(tool.function.name, options.name);
            assert.equal(tool.function.description, options.description);
            assert.deepEqual(
                parameters,
                {
                    ...baseline.function.parameters,
                    properties: {
                        ...baseline.function.parameters.properties,
                        responseToUsersPromptComplete: {type: 'boolean', description}
                    },
                    required: declaration.required
                        ? ['message', 'final_message', 'responseToUsersPromptComplete']
                        : ['message', 'final_message']
                }
            );
            parameters.required.push('caller_owned');
            parameters.properties.message.description = 'Caller customization.';
            parameters.properties.remembered_actions.items.properties.basis.enum.push('caller_owned');
        }
        assert.deepEqual(
            createConversationClosingReportTool(),
            baseline
        );
    }
);

test(
    'completion declarations require a nonblank description and a boolean required option',
    function invalidCompletionDeclarations() {
        const declarations = [
            null, false, 'complete', [], {},
            {description: ''},
            {description: ' \n '},
            {description: null},
            {description: 1},
            {description: 'Complete.', required: null},
            {description: 'Complete.', required: 'true'},
            {description: 'Complete.', required: 1}
        ];
        for (const declaration of declarations) {
            assert.throws(
                function constructInvalidCompletionDeclaration() {
                    createConversationClosingReportTool(
                        {responseToUsersPromptComplete: declaration}
                    );
                },
                INVALID_REPORT
            );
        }
    }
);

test(
    'object and JSON reports preserve true, false, absent completion, and existing report content',
    function normalizeCompletionMetadata() {
        const rememberedActions = [
            {text: '  Invite the dragon.\n', basis: 'user_commitment'},
            {text: 'Sketch an optional parade route.', basis: 'optional_homework'}
        ];
        const inputs = [
            REPORT_INPUT,
            {...REPORT_INPUT, remembered_actions: rememberedActions},
            {...REPORT_INPUT, responseToUsersPromptComplete: true},
            {...REPORT_INPUT, responseToUsersPromptComplete: false}
        ];
        const expected = [
            REPORT_OUTPUT,
            {...REPORT_OUTPUT, rememberedActions},
            {...REPORT_OUTPUT, responseToUsersPromptComplete: true},
            {...REPORT_OUTPUT, responseToUsersPromptComplete: false}
        ];
        for (const [index, input] of inputs.entries()) {
            const originalInput = structuredClone(input);
            for (const value of [input, JSON.stringify(input)]) {
                assert.deepEqual(
                    normalizeConversationClosingReport(value),
                    expected[index]
                );
            }
            assert.deepEqual(input, originalInput);
        }
    }
);

test(
    'supplied completion metadata rejects nonbooleans without coercion',
    function rejectNonbooleanCompletionMetadata() {
        for (const completion of [undefined, null, 'true', 'false', 0, 1, [], {}]) {
            const input = {...REPORT_INPUT, responseToUsersPromptComplete: completion};
            const values = completion === undefined ? [input] : [input, JSON.stringify(input)];
            for (const value of values) {
                assert.throws(
                    function parseInvalidCompletionValue() {
                        normalizeConversationClosingReport(value);
                    },
                    INVALID_REPORT
                );
            }
        }
    }
);

test(
    'completion metadata retains required report fields and unexpected-field errors',
    function existingReportRequirements() {
        const invalidInputs = [
            {final_message: 'The parade is ready.', responseToUsersPromptComplete: true},
            {message: 'Preparing the report.', responseToUsersPromptComplete: false},
            {...REPORT_INPUT, message: ' \n ', responseToUsersPromptComplete: true},
            {...REPORT_INPUT, final_message: ' \n ', responseToUsersPromptComplete: false},
            {...REPORT_INPUT, unexpected: true},
            '{invalid JSON'
        ];
        for (const input of invalidInputs) {
            assert.throws(
                function parseInvalidExistingReport() {
                    normalizeConversationClosingReport(input);
                },
                INVALID_REPORT
            );
        }
    }
);

test(
    'completion metadata preserves sole-call classification and custom tool names',
    function closingCallCompatibility() {
        for (const toolName of [CONVERSATION_CLOSING_REPORT_TOOL_NAME, 'finish_parade']) {
            for (const input of [REPORT_INPUT, {...REPORT_INPUT, responseToUsersPromptComplete: false}]) {
                const accepted = classifyConversationClosingReportCalls(
                    {[toolName]: JSON.stringify(input)},
                    {toolName}
                );
                assert.deepEqual(
                    accepted,
                    {
                        present: true,
                        accepted: true,
                        report: normalizeConversationClosingReport(input),
                        error: null
                    }
                );
            }
            const mixed = classifyConversationClosingReportCalls(
                {[toolName]: REPORT_INPUT, another_tool: {message: 'A separate operation.'}},
                {toolName}
            );
            assert.equal(mixed.present, true);
            assert.equal(mixed.accepted, false);
            assert.equal(mixed.report, null);
            assert.equal(mixed.error.code, INVALID_REPORT.code);
            assert.match(mixed.error.message, /sole tool call/u);
            const malformed = classifyConversationClosingReportCalls(
                {[toolName]: {...REPORT_INPUT, responseToUsersPromptComplete: 'false'}},
                {toolName}
            );
            assert.equal(malformed.present, true);
            assert.equal(malformed.accepted, false);
            assert.equal(malformed.report, null);
            assert.equal(malformed.error.code, INVALID_REPORT.code);
        }
        assert.deepEqual(
            classifyConversationClosingReportCalls(),
            {present: false, accepted: false, report: null, error: null}
        );
    }
);

test(
    'formatting retains escaped final text for raw and normalized completion reports',
    function completionFormattingCompatibility() {
        const inputs = [
            REPORT_INPUT,
            {...REPORT_INPUT, responseToUsersPromptComplete: true},
            {...REPORT_INPUT, responseToUsersPromptComplete: false}
        ];
        for (const input of inputs) {
            for (const value of [input, normalizeConversationClosingReport(input)]) {
                assert.equal(
                    formatConversationClosingReport(value),
                    '  The &lt;dragon&gt; &amp; its parade are ready.\n'
                );
            }
        }
        for (const completion of [undefined, null, 'false', 0]) {
            const values = [
                {...REPORT_INPUT, responseToUsersPromptComplete: completion},
                {...REPORT_OUTPUT, responseToUsersPromptComplete: completion}
            ];
            for (const value of values) {
                assert.throws(
                    function formatInvalidCompletionValue() {
                        formatConversationClosingReport(value);
                    },
                    INVALID_REPORT
                );
            }
        }
    }
);

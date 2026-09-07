import Is from '../dependencies/strong-type/index.js';

const is = new Is(false);
const STRING_ESCAPES = {
    '"': '"',
    '\\': '\\',
    '/': '/',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t'
};

function projectionError(message, cause) {
    const error = new SyntaxError(
        `Tool text projection ${message}`,
        cause === undefined ? undefined : {cause}
    );
    error.code = 'ARCANE_AI_TOOL_TEXT_INVALID';
    return error;
}

function isWhitespace(character) {
    return character === ' ' || character === '\t'
        || character === '\n' || character === '\r';
}

function createArgumentScanner(field, appendText, beginText, endText) {
    const stack = [];
    let started = false;
    let finished = false;
    let string = null;
    let scalar = null;

    function finishValue() {
        stack[stack.length - 1].state = 'commaOrEnd';
    }

    function closeContainer() {
        stack.pop();
        if (stack.length) {
            finishValue();
        } else {
            finished = true;
        }
    }

    function acceptStringCharacter(character) {
        if (string.key) {
            if (stack.length === 1) string.value += character;
        } else if (string.selected) {
            appendText(character, string.offset);
            string.offset += character.length;
        }
    }

    function readStringCharacter(character) {
        if (string.unicode !== null) {
            if (!/[0-9a-fA-F]/.test(character)) {
                throw projectionError('encountered an invalid Unicode escape.');
            }
            string.unicode += character;
            if (string.unicode.length === 4) {
                acceptStringCharacter(
                    String.fromCharCode(Number.parseInt(string.unicode, 16))
                );
                string.unicode = null;
            }
            return;
        }
        if (string.escaped) {
            string.escaped = false;
            if (character === 'u') {
                string.unicode = '';
            } else if (Object.hasOwn(STRING_ESCAPES, character)) {
                acceptStringCharacter(STRING_ESCAPES[character]);
            } else {
                throw projectionError('encountered an invalid string escape.');
            }
            return;
        }
        if (character === '\\') {
            string.escaped = true;
        } else if (character === '"') {
            const frame = stack[stack.length - 1];
            if (string.key) {
                frame.key = string.value;
                frame.state = 'colon';
            } else {
                if (string.selected) endText(string.offset);
                finishValue();
            }
            string = null;
        } else {
            if (character.charCodeAt(0) < 32) {
                throw projectionError('encountered an unescaped control character.');
            }
            acceptStringCharacter(character);
        }
    }

    function startString(key, selected = false) {
        string = {key, selected, value: '', offset: 0, escaped: false, unicode: null};
        if (selected) beginText();
    }

    function startValue(character, frame) {
        const selected = stack.length === 1 && frame.kind === 'object'
            && frame.key === field;
        if (selected && character !== '"') {
            beginText();
            endText(0);
        }
        if (character === '"') {
            startString(false, selected);
        } else if (character === '{') {
            stack.push(
                {kind: 'object', state: 'keyOrEnd', key: ''}
            );
        } else if (character === '[') {
            stack.push(
                {kind: 'array', state: 'valueOrEnd'}
            );
        } else if (character === '-' || character >= '0' && character <= '9'
            || character === 't' || character === 'f' || character === 'n') {
            scalar = character;
        } else {
            throw projectionError('encountered an invalid argument value.');
        }
    }

    function appendArguments(fragment) {
        for (let position = 0; position < fragment.length; position += 1) {
            const character = fragment[position];
            if (string) {
                readStringCharacter(character);
                continue;
            }
            if (scalar !== null) {
                if (!isWhitespace(character) && character !== ','
                    && character !== '}' && character !== ']') {
                    scalar += character;
                    continue;
                }
                try {
                    JSON.parse(scalar);
                } catch (cause) {
                    throw projectionError('encountered an invalid argument value.', cause);
                }
                scalar = null;
                finishValue();
            }
            if (isWhitespace(character)) continue;
            if (finished) {
                throw projectionError('encountered content after the argument object.');
            }
            if (!started) {
                if (character !== '{') {
                    throw projectionError('requires a root argument object.');
                }
                started = true;
                stack.push(
                    {kind: 'object', state: 'keyOrEnd', key: ''}
                );
                continue;
            }
            const frame = stack[stack.length - 1];
            if (frame.state === 'keyOrEnd' || frame.state === 'key') {
                if (character === '"') {
                    startString(true);
                } else if (character === '}' && frame.state === 'keyOrEnd') {
                    closeContainer();
                } else {
                    throw projectionError('encountered an invalid object key.');
                }
            } else if (frame.state === 'colon') {
                if (character !== ':') {
                    throw projectionError('expected a colon after an object key.');
                }
                frame.state = 'value';
            } else if (frame.state === 'value' || frame.state === 'valueOrEnd') {
                if (character === ']' && frame.state === 'valueOrEnd') {
                    closeContainer();
                } else {
                    startValue(character, frame);
                }
            } else if (character === ',') {
                frame.state = frame.kind === 'object' ? 'key' : 'value';
            } else if (character === (frame.kind === 'object' ? '}' : ']')) {
                closeContainer();
            } else {
                throw projectionError('expected a comma or the end of an argument container.');
            }
        }
    }

    return appendArguments;
}

export function createToolTextObserver(selection, onText, {signal} = {}) {
    if (selection === undefined || selection === null || selection === false) return null;
    if (!is.object(selection) || is.array(selection)
        || !is.string(selection.name) || !selection.name.trim()
        || !is.string(selection.field) || !selection.field.trim()) {
        throw new TypeError('AI toolText must name a tool and a root string field.');
    }
    if (!is.function(onText)) {
        throw new TypeError('AI onToolText must be a function when toolText is selected.');
    }
    const name = selection.name;
    const field = selection.field;
    const choices = new Map();

    function recordFor(choiceIndex, index) {
        let calls = choices.get(choiceIndex);
        if (!calls) {
            calls = new Map();
            choices.set(choiceIndex, calls);
        }
        let record = calls.get(index);
        if (!record) {
            record = {
                id: '', name: '', index, choiceIndex, pending: [], scanner: null,
                text: '', emitted: 0, textOpen: false
            };
            calls.set(index, record);
        }
        return record;
    }

    function prepareScanner(record) {
        if (!record.scanner) {
            record.scanner = createArgumentScanner(
                field,
                function appendSelectedToolText(text, offset) {
                    for (let index = 0; index < text.length; index += 1) {
                        const position = offset + index;
                        if (position < record.text.length) {
                            if (record.text[position] !== text[index]) {
                                throw projectionError('received conflicting selected argument text.');
                            }
                        } else {
                            record.text += text[index];
                        }
                    }
                },
                function beginSelectedToolText() {
                    if (record.emitted === 0) record.text = '';
                    record.textOpen = true;
                },
                function finishSelectedToolText(length) {
                    if (length < record.text.length) {
                        throw projectionError('received a shorter replacement for selected argument text.');
                    }
                    record.textOpen = false;
                }
            );
        }
        for (const fragment of record.pending) record.scanner(fragment);
        record.pending = [];
    }

    function observeCompleteArguments(record, argumentsValue) {
        let argumentsObject = argumentsValue;
        if (is.string(argumentsObject)) {
            try {
                argumentsObject = JSON.parse(argumentsObject);
            } catch (cause) {
                throw projectionError('received invalid complete argument JSON.', cause);
            }
        }
        if (!argumentsObject || !is.object(argumentsObject) || is.array(argumentsObject)) {
            throw projectionError('requires a complete argument object.');
        }
        if (!Object.hasOwn(argumentsObject, field)) {
            if (record.emitted > 0) {
                throw projectionError('lost the selected argument field in a complete response.');
            }
            record.text = '';
            record.textOpen = false;
            return;
        }
        const text = argumentsObject[field];
        if (!is.string(text)) {
            throw projectionError('requires the selected argument field to be a string.');
        }
        // A terminal snapshot may repeat a complete value already streamed.
        if (record.emitted > 0 && !text.startsWith(record.text)) {
            throw projectionError('received conflicting complete argument text.');
        }
        record.text = text;
        record.textOpen = false;
    }

    async function emitSelectedText(record) {
        if (signal?.aborted || record.name !== name || !record.id) return;
        let end = record.text.length;
        if (record.textOpen && end > record.emitted) {
            // Keep a split surrogate pair together without changing its code units.
            const last = record.text.charCodeAt(end - 1);
            if (last >= 0xD800 && last <= 0xDBFF) end -= 1;
        }
        if (end <= record.emitted) return;
        const text = record.text.slice(record.emitted, end);
        record.emitted = end;
        await onText(
            text,
            {id: record.id, name: record.name, field, index: record.index, choiceIndex: record.choiceIndex}
        );
    }

    async function observeCalls(calls, choiceIndex, complete) {
        if (!is.array(calls)) return;
        for (let position = 0; position < calls.length; position += 1) {
            if (signal?.aborted) return;
            const call = calls[position];
            if (!call || !is.object(call)) continue;
            const record = recordFor(choiceIndex, call.index ?? position);
            if (is.string(call.id) && call.id) {
                if (record.emitted && record.id !== call.id) {
                    throw projectionError('changed the identity of a displayed tool call.');
                }
                record.id = call.id;
            }
            const functionValue = call.function && is.object(call.function)
                ? call.function
                : {};
            if (is.string(functionValue.name)) {
                const nextName = complete ? functionValue.name : record.name + functionValue.name;
                if (record.emitted && nextName !== record.name) {
                    throw projectionError('changed the name of a displayed tool call.');
                }
                record.name = nextName;
            }
            if (!name.startsWith(record.name)) {
                record.pending = [];
                continue;
            }
            if (!complete && is.string(functionValue.arguments)) {
                record.pending.push(functionValue.arguments);
            }
            if (record.name !== name) continue;
            prepareScanner(record);
            if (complete) observeCompleteArguments(record, functionValue.arguments);
            await emitSelectedText(record);
        }
    }

    return async function observeToolText(chunk) {
        if (signal?.aborted || !chunk || !is.object(chunk)) return;
        if (is.array(chunk.choices)) {
            for (let position = 0; position < chunk.choices.length; position += 1) {
                if (signal?.aborted) return;
                const choice = chunk.choices[position];
                if (!choice || !is.object(choice)) continue;
                const choiceIndex = choice.index ?? position;
                await observeCalls(choice.delta?.tool_calls, choiceIndex, false);
                await observeCalls(choice.message?.tool_calls, choiceIndex, true);
            }
        }
        if (!signal?.aborted) await observeCalls(chunk.message?.tool_calls, 0, true);
    };
}

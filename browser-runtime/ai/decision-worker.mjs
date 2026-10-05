import Is from '../dependencies/strong-type/index.js';
import {loadDecisionRuntime} from './decision-runtime.mjs';

const is = new Is(false);
let engine;

function errorRecord(error, seen = new Map()) {
    if (!is.error(error)) return error;
    if (seen.has(error)) return seen.get(error);
    const record = {name: error.name, message: error.message, stack: error.stack};
    seen.set(error, record);
    for (const key of Object.getOwnPropertyNames(error)) {
        if (key === 'cause') {
            record[key] = errorRecord(error[key], seen);
        } else if (key === 'errors' && is.array(error[key])) {
            record[key] = error[key].map(
                function recordNestedError(nested) {
                    return errorRecord(nested, seen);
                }
            );
        } else {
            record[key] = error[key];
        }
    }
    return record;
}

async function handleDecisionOperation(event) {
    const {id, op, payload} = event.data;
    try {
        if (op === 'load') {
            engine = await loadDecisionRuntime(
                payload,
                function reportDecisionProgress(progress) {
                    globalThis.postMessage(
                        {id, progress}
                    );
                }
            );
            globalThis.postMessage(
                {id, result: {loaded: true}}
            );
            return;
        }
        if (op === 'evaluate') {
            if (!engine) throw new Error('The decision model has not loaded.');
            globalThis.postMessage(
                {id, progress: {phase: 'evaluating'}}
            );
            const result = await engine.evaluate(payload);
            globalThis.postMessage(
                {id, progress: {phase: 'complete'}}
            );
            globalThis.postMessage(
                {id, result}
            );
            return;
        }
        throw new Error(`Unknown decision worker operation: ${op}.`);
    } catch (error) {
        globalThis.postMessage(
            {id, error: errorRecord(error)}
        );
    }
}

globalThis.addEventListener('message', handleDecisionOperation);

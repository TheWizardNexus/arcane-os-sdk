import {readFile} from 'node:fs/promises';
import {parentPort, workerData} from 'node:worker_threads';
import {Tokenizer} from '@huggingface/tokenizers';
import {createDecisionInputs, encodeDecisionRows} from '../../browser-runtime/ai/decision-runtime.mjs';
import {serializeCoreError} from '../../browser-runtime/core/contracts.mjs';

// Parsing and tokenization run here, not on Core's request/rendering thread.
try {
    const [tokenizerText, configurationText] = await Promise.all([
        readFile(workerData.tokenizerPath, 'utf8'),
        readFile(workerData.tokenizerConfigPath, 'utf8')
    ]);
    const tokenizer = new Tokenizer(JSON.parse(tokenizerText), JSON.parse(configurationText));
    const interfaceAdapter = {
        encode(text, options) { return tokenizer.encode(text, options).ids; },
        convert_tokens_to_ids(token) { return tokenizer.token_to_id(token); }
    };
    parentPort.on('message', function encodeRequest({id, rows}) {
        try {
            const {encoded, pad} = encodeDecisionRows(interfaceAdapter, rows, workerData.family);
            const inputs = createDecisionInputs(encoded, pad);
            parentPort.postMessage({id, result: inputs});
        } catch (error) {
            parentPort.postMessage({id, error: serializeCoreError(error)});
        }
    });
    parentPort.postMessage({id: 0, result: {ready: true}});
} catch (error) {
    parentPort.postMessage({id: 0, error: serializeCoreError(error)});
    parentPort.close();
}

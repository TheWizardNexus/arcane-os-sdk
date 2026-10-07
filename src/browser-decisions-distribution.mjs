import Is from 'strong-type';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const is = new Is(false);

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const error = signal.reason instanceof Error ? signal.reason : new Error('Operation cancelled.');
    error.code = error.code || 'ARCANE_CANCELLED';
    throw error;
}

async function emit(onEvent, event) {
    if (is.function(onEvent)) await onEvent(event);
}

export async function materializeBrowserDecisions(destination, signal, onEvent) {
    const transformers = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/';
    const onnx = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/';
    const files = [
        {name: 'transformers.min.js', url: `${transformers}dist/transformers.min.js`},
        {name: 'ort-wasm-simd-threaded.asyncify.mjs', url: `${onnx}dist/ort-wasm-simd-threaded.asyncify.mjs`},
        {name: 'ort-wasm-simd-threaded.asyncify.wasm', url: `${onnx}dist/ort-wasm-simd-threaded.asyncify.wasm`},
        {name: 'TRANSFORMERS-LICENSE', url: `${transformers}LICENSE`},
        {name: 'ONNX-RUNTIME-LICENSE', url: `${onnx}LICENSE`}
    ];
    const controller = new AbortController();
    function cancelDistribution() {
        controller.abort(signal.reason);
    }
    signal?.addEventListener('abort', cancelDistribution, {once: true});
    if (signal?.aborted) cancelDistribution();
    let completed = 0;
    try {
        throwIfAborted(controller.signal);
        await emit(
            onEvent,
            {type: 'workspace.decisions.started', completed, total: files.length}
        );
        throwIfAborted(controller.signal);
        await mkdir(destination, {recursive: true});
        async function acquireDistributionFile(file) {
            try {
                throwIfAborted(controller.signal);
                const response = await fetch(file.url, {signal: controller.signal});
                const content = new Uint8Array(await response.arrayBuffer());
                if (!response.ok) {
                    const error = new Error(`Browser decision distribution returned HTTP ${response.status} ${response.statusText}.`);
                    error.code = 'ARCANE_DECISION_DISTRIBUTION_DOWNLOAD_FAILED';
                    error.response = {
                        url: response.url,
                        status: response.status,
                        statusText: response.statusText,
                        headers: [...response.headers],
                        content
                    };
                    throw error;
                }
                throwIfAborted(controller.signal);
                // Upstream distribution content is opaque, including its own
                // imports and license text. No SDK source rewriting applies.
                await writeFile(path.join(destination, file.name), content);
                throwIfAborted(controller.signal);
                completed += 1;
                await emit(
                    onEvent,
                    {type: 'workspace.decisions.progress', file: file.name, url: file.url, completed, total: files.length}
                );
            } catch (error) {
                controller.abort(error);
                throw error;
            }
        }
        // One fixed distribution, acquired once for the selected projection or
        // package; no model/app/architecture multiplier or installation script.
        const outcomes = await Promise.allSettled(files.map(acquireDistributionFile));
        const failures = new Set();
        for (const outcome of outcomes) {
            if (outcome.status === 'rejected') failures.add(outcome.reason);
        }
        if (failures.size === 1) throw [...failures][0];
        if (failures.size > 1) {
            throw new AggregateError([...failures], 'Browser decision distribution acquisition failed.');
        }
        throwIfAborted(controller.signal);
    } finally {
        signal?.removeEventListener('abort', cancelDistribution);
    }
    return {
        transformersVersion: '4.3.0',
        onnxRuntimeVersion: '1.31.0-dev.20260914-8d85527a0',
        files: files.map(function distributionFilename(file) { return file.name; })
    };
}

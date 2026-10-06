import Is from '../dependencies/strong-type/index.js';

const is = new Is(false);

function throwIfCancelled(signal) {
    if (signal?.aborted) {
        throw signal.reason ?? new DOMException('Speech synthesis was cancelled.', 'AbortError');
    }
}

/**
 * Compose the selected Kokoro public classes without changing loaded instances.
 * The original synthesizer remains the sole owner of its model and disposal.
 */
export async function createCompleteKokoroSynthesis({
    KokoroTTS,
    synthesizer,
    repository,
    signal,
    onProgress,
}) {
    throwIfCancelled(signal);
    const Tokenizer = synthesizer.tokenizer.constructor;
    class CompleteKokoroTokenizer extends Tokenizer {
        _call(text, options = {}) {
            return super._call(text, { ...options, truncation: false });
        }
    }
    // Kokoro 1.2.1's factory uses the tokenizer's default revision. Reuse that
    // same public loading contract through the existing Worker resource router.
    const tokenizer = await CompleteKokoroTokenizer.from_pretrained(repository, {
        progress_callback: onProgress,
    });
    throwIfCancelled(signal);
    const contextLength = tokenizer.model_max_length;
    if (!is.safeInteger(contextLength) || contextLength < 3) {
        throw new Error('The selected Kokoro tokenizer does not expose its model context length.');
    }
    const contentCapacity = contextLength - 2;
    function boundaryIds(text) {
        const encoded = tokenizer(text, {
            add_special_tokens: false,
            return_tensor: false,
            truncation: false,
        });
        return new Set(encoded.input_ids.map(function tokenId(id) { return BigInt(id); }));
    }
    const punctuation = boundaryIds(';:,.!?—…');
    const spaces = boundaryIds(' ');

    function segmentEnd(tokens, start, limit, contentEnd) {
        if (limit === contentEnd) return limit;
        for (const boundaries of [punctuation, spaces]) {
            for (let index = limit - 1; index >= start; index -= 1) {
                if (boundaries.has(tokens[index])) return index + 1;
            }
        }
        return limit;
    }

    class CompleteKokoroTTS extends KokoroTTS {
        #signal;

        constructor(requestSignal) {
            super(synthesizer.model, tokenizer);
            this.#signal = requestSignal;
        }

        async generate_from_ids(inputIds, options = {}) {
            throwIfCancelled(this.#signal);
            if (inputIds.dims.at(-1) <= contextLength) {
                const output = await super.generate_from_ids(inputIds, options);
                throwIfCancelled(this.#signal);
                return output;
            }
            const Tensor = inputIds.constructor;
            const tokens = inputIds.data;
            const contentEnd = tokens.length - 1;
            const outputs = [];
            let sampleCount = 0;
            for (let start = 1; start < contentEnd;) {
                throwIfCancelled(this.#signal);
                const end = segmentEnd(tokens, start, Math.min(start + contentCapacity, contentEnd), contentEnd);
                // Only the original outer padding positions are replaced. All
                // content tokens, including boundary punctuation/space, survive.
                const data = new BigInt64Array(end - start + 2);
                data[0] = tokens[0];
                data.set(tokens.subarray(start, end), 1);
                data[data.length - 1] = tokens[tokens.length - 1];
                const ids = new Tensor('int64', data, [1, data.length]);
                const output = await super.generate_from_ids(ids, options);
                throwIfCancelled(this.#signal);
                outputs.push(output);
                sampleCount += output.audio.length;
                start = end;
            }
            const audio = new Float32Array(sampleCount);
            let offset = 0;
            for (const output of outputs) {
                audio.set(output.audio, offset);
                offset += output.audio.length;
            }
            throwIfCancelled(this.#signal);
            const RawAudio = outputs[0].constructor;
            return new RawAudio(audio, outputs[0].sampling_rate);
        }
    }

    return async function synthesizeCompleteKokoro(text, { voice, speed, signal: requestSignal } = {}) {
        throwIfCancelled(requestSignal);
        // Each invocation retains its own signal while sharing the one loaded
        // model. Inherited generate() still owns all upstream phonemization.
        const request = new CompleteKokoroTTS(requestSignal);
        return request.generate(text, { voice, speed });
    };
}

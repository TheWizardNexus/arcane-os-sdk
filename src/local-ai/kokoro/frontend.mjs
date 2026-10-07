import {readFile} from 'node:fs/promises';
import {endianness} from 'node:os';
import Is from 'strong-type';

const is = new Is(false);

export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const KOKORO_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
export const KOKORO_SAMPLE_RATE = 24000;
export const KOKORO_VOICES = [
    'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore',
    'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
    'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael',
    'am_onyx', 'am_puck', 'am_santa', 'bf_emma', 'bf_isabella', 'bm_george',
    'bm_lewis', 'bf_alice', 'bf_lily', 'bm_daniel', 'bm_fable'
];

/** Read the selected model's public tokenizer and voice tensors, without a second model store. */
export async function loadKokoroFrontend(paths, {signal} = {}) {
    const resources = await Promise.allSettled([
        readFile(paths.tokenizer, {encoding: 'utf8', signal}),
        readFile(paths.tokenizerConfig, {encoding: 'utf8', signal}),
        ...KOKORO_VOICES.map(function readVoice(voice) { return readFile(paths.voices[voice], {signal}); })
    ]);
    const failures = resources.filter(function failed(result) { return result.status === 'rejected'; })
        .map(function cause(result) { return result.reason; });
    if (signal?.aborted) {
        const independent = failures.filter(function independentFailure(cause) {
            return cause !== signal.reason && !(cause?.code === 'ABORT_ERR' && cause.cause === signal.reason);
        });
        if (independent.length) throw new AggregateError([signal.reason, ...independent], 'Kokoro resource loading was cancelled with errors.', {cause: signal.reason});
        signal.throwIfAborted();
    }
    if (failures.length) throw new AggregateError(failures, 'Reading the complete Kokoro frontend resources failed.');
    const tokenizer = JSON.parse(resources[0].value);
    const configuration = JSON.parse(resources[1].value);
    const vocabulary = tokenizer.model.vocab;
    const context = configuration.model_max_length;
    const boundary = vocabulary[configuration.pad_token];
    if (!is.integer(context) || context < 3 || !is.integer(boundary)) {
        throw new Error('The selected Kokoro tokenizer does not describe its context and boundary token.');
    }
    const voices = new Map();
    // Independent files load concurrently; the activation owns every read until it settles.
    for (let voiceIndex = 0; voiceIndex < KOKORO_VOICES.length; voiceIndex += 1) {
        const voice = KOKORO_VOICES[voiceIndex];
        signal?.throwIfAborted();
        const encoded = resources[voiceIndex + 2].value;
        const values = new Float32Array(Math.ceil(encoded.length / 4));
        for (let index = 0; index < values.length; index += 1) {
            values[index] = encoded.readFloatLE(index * 4);
        }
        voices.set(voice, values);
    }

    function tokens(clauses, voice) {
        const language = voiceLanguage(voice);
        const result = [];
        for (let index = 0; index < clauses.length; index += 1) {
            const clause = clauses[index];
            const phonemes = kokoroPhonemes(clause.phonemes, language);
            const beginning = clause.source.match(/^[\s;:,.!?—…"()“”]+/u)?.[0] ?? '';
            let ending = clause.source.match(/[\s;:,.!?—…"()“”]+$/u);
            // The public cursor can include one next-clause character saved by
            // eSpeak's UngetC. Its phonemes belong to the next returned clause;
            // recover only the preceding punctuation, leaving both records intact.
            if (!ending && index + 1 < clauses.length) {
                ending = clause.source.match(/[;:,.!?—…"()“”][\s;:,.!?—…"()“”]*(?=[^\s;:,.!?—…"()“”]$)/u);
            }
            const punctuation = ending && ending.index >= beginning.length ? ending[0] : '';
            const complete = beginning.replace(/\s/gu, ' ') + phonemes + punctuation.replace(/\s/gu, ' ');
            for (const symbol of complete) {
                const id = vocabulary[symbol];
                if (!is.integer(id)) {
                    const failure = new Error(`Kokoro has no token for the emitted phoneme ${JSON.stringify(symbol)}.`);
                    failure.code = 'KOKORO_PHONEME_UNSUPPORTED';
                    failure.data = {symbol, language, source: clause.source, phonemes: clause.phonemes, mappedPhonemes: complete};
                    throw failure;
                }
                result.push({id, symbol});
            }
        }
        return result;
    }

    function* segments(clauses, voice) {
        const content = tokens(clauses, voice);
        const style = voices.get(voice);
        const capacity = context - 2;
        let offset = 0;
        while (offset < content.length) {
            let end = Math.min(offset + capacity, content.length);
            if (end < content.length) {
                for (let candidate = end; candidate > offset; candidate -= 1) {
                    if (/[ ;:,.!?—…]/u.test(content[candidate - 1].symbol)) {
                        end = candidate;
                        break;
                    }
                }
            }
            const count = end - offset;
            const input = new BigInt64Array(count + 2);
            input[0] = BigInt(boundary);
            for (let index = 0; index < count; index += 1) input[index + 1] = BigInt(content[offset + index].id);
            input[count + 1] = BigInt(boundary);
            // The public model contract selects the style row by content-token count, excluding BOS/EOS.
            const row = style.subarray(count * 256, (count + 1) * 256);
            if (row.length !== 256) throw new Error(`The selected ${voice} tensor has no style row for ${count} phoneme tokens.`);
            yield {input, style: row, tokenCount: count};
            offset = end;
        }
    }

    return {segments};
}

export function voiceLanguage(voice) {
    if (!KOKORO_VOICES.includes(voice)) {
        const failure = new Error(`The selected Kokoro voice ${String(voice)} is unavailable.`);
        failure.code = 'KOKORO_VOICE_UNAVAILABLE';
        throw failure;
    }
    return voice.startsWith('b') ? 'en-gb' : 'en-us';
}

/** Model-specific IPA spelling for Kokoro v1.0 English, including the versioned recipe:
 * https://github.com/hexgrad/misaki/blob/main/misaki/espeak.py
 * This is phoneme conversion; the caller's source text is never rewritten.
 */
export function kokoroPhonemes(ipa, language) {
    const british = language === 'en-gb';
    const phones = Array.from(ipa);
    const output = [];
    const diphthongs = new Map([
        ['aɪ', 'I'], ['aʊ', 'W'], ['eɪ', 'A'], ['ɔɪ', 'Y'],
        ['oʊ', 'O'], ['əʊ', 'Q'], ['tʃ', 'ʧ'], ['dʒ', 'ʤ']
    ]);
    for (let index = 0; index < phones.length; index += 1) {
        const phone = phones[index];
        const tied = phones[index + 1] === '^';
        const next = phones[index + (tied ? 2 : 1)];
        const pair = phone + (next ?? '');
        if (diphthongs.has(pair)) {
            output.push(diphthongs.get(pair));
            index += tied ? 2 : 1;
        } else if (british && pair === 'eə') {
            output.push('ɛː');
            index += tied ? 2 : 1;
        } else if (british && pair === 'iə') {
            output.push('ɪə');
            index += tied ? 2 : 1;
        } else if (!british && pair === 'ɪə') {
            output.push('iə');
            index += tied ? 2 : 1;
        } else if (tied && pair === 'əl') {
            output.push('ᵊl');
            index += 2;
        } else if (phone === 'ʔ' && (next === 'n' || (next === 'ˌ' && phones[index + 2] === 'n'))
            && phones[index + (next === 'n' ? 2 : 3)] === '\u0329') {
            output.push('tn');
            index += next === 'n' ? 2 : 3;
        } else if (phone === '\u0329') {
            const consonant = output.pop();
            if (consonant === undefined) throw new Error('eSpeak emitted a syllabic mark without its consonant.');
            output.push('ᵊ', consonant);
        } else if (phone === 'ɚ') output.push('əɹ');
        else if (phone === 'ɝ') output.push('ɜɹ');
        else if (phone === 'r') output.push('ɹ');
        else if (phone === 'g') output.push('ɡ');
        else if (phone === 'ɐ') output.push('ə');
        else if (phone === 'ɬ') output.push('l');
        else if (phone === 'x' || phone === 'ç') output.push('k');
        else if (phone === 'ʔ') output.push('t');
        else if (phone === 'ɾ') output.push('T');
        else if (phone === 'ʲ') {
            if (next === 'o' || next === 'ə') output.push('j');
        } else if (phone === '\u0303') continue;
        else if (phone === 'o') output.push('ɔ');
        else if (phone === 'e') output.push('A');
        else if (phone === '^') continue;
        else if (phone === 'ː' && !british) {
            if (phones[index - 1] === 'ɜ' && next !== 'ɹ' && next !== 'r') output.push('ɹ');
        } else if (/\s/u.test(phone)) output.push(' ');
        else output.push(phone);
    }
    return output.join('');
}

/** IEEE float WAV preserves the complete native waveform without amplitude clamps. */
export function encodeKokoroWav(chunks) {
    const samples = chunks.reduce(function countSamples(total, chunk) { return total + chunk.length; }, 0);
    const dataLength = samples * 4;
    // RIFF's unsigned 32-bit chunk fields are an external format constraint, not a content policy.
    if (dataLength + 48 > 0xffffffff) throw new RangeError('This complete waveform exceeds the WAV RIFF format; select Ogg Opus.');
    const header = Buffer.alloc(56);
    header.write('RIFF', 0);
    header.writeUInt32LE(dataLength + 48, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(3, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(KOKORO_SAMPLE_RATE, 24);
    header.writeUInt32LE(KOKORO_SAMPLE_RATE * 4, 28);
    header.writeUInt16LE(4, 32);
    header.writeUInt16LE(32, 34);
    header.write('fact', 36);
    header.writeUInt32LE(4, 40);
    header.writeUInt32LE(samples, 44);
    header.write('data', 48);
    header.writeUInt32LE(dataLength, 52);
    return Buffer.concat([header, ...chunks.map(floatPCM)]);
}

export function floatPCM(samples) {
    if (endianness() === 'LE') return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    const encoded = Buffer.allocUnsafe(samples.length * 4);
    for (let index = 0; index < samples.length; index += 1) encoded.writeFloatLE(samples[index], index * 4);
    return encoded;
}

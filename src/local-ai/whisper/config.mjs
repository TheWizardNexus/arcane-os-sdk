import Is from 'strong-type';
import path from 'node:path';
import {ArcaneError, ERROR_CODES} from '../../errors.mjs';

const is = new Is(false);

export const WHISPER_SMALL_MODEL = {
    id: 'whisper-small',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    filename: 'ggml-small.bin'
};

export const WHISPER_SMALL_OPENVINO_MODEL = {
    id: 'whisper-small',
    archiveUrl: 'https://huggingface.co/Intel/whisper.cpp-openvino-models/resolve/main/ggml-small-models.zip',
    filename: 'ggml-small.bin',
    encoderFilename: 'ggml-small-encoder-openvino.xml',
    encoderDataFilename: 'ggml-small-encoder-openvino.bin'
};

/** Describe a selected native runtime and models without acquiring them. */
export function normalizeWhisperRuntimeRequirement(record) {
    if (record.helperRoot !== undefined && (!is.string(record.helperRoot) || !record.helperRoot)) {
        throw new ArcaneError(ERROR_CODES.usage, 'Whisper helperRoot must name the complete selected helper directory.');
    }
    const helperRoot = record.helperRoot ?? (is.string(record.helperExecutable) ? path.dirname(record.helperExecutable) : undefined);
    const backend = record.backend ?? 'auto';
    if (!['auto', 'cuda', 'metal', 'cpu'].includes(backend)) {
        throw new ArcaneError(ERROR_CODES.usage, `Unknown whisper.cpp backend: ${String(backend)}.`);
    }
    if (record.encoder !== undefined && record.encoder !== 'openvino-npu') {
        throw new ArcaneError(ERROR_CODES.usage, `Unknown whisper.cpp encoder: ${String(record.encoder)}.`);
    }
    if (record.models !== undefined && !is.array(record.models)) {
        throw new ArcaneError(ERROR_CODES.usage, 'whisper.cpp models must be an array of selected model IDs or descriptors.');
    }
    const models = (record.models ?? []).map(function selectedWhisperModel(value) {
        const model = value === 'whisper-small'
            ? record.encoder === 'openvino-npu' ? WHISPER_SMALL_OPENVINO_MODEL : WHISPER_SMALL_MODEL
            : value;
        if (!model || !is.object(model) || is.array(model) || !is.string(model.id) || !model.id) {
            throw new ArcaneError(ERROR_CODES.usage, 'A Whisper model needs a descriptor with an id, or the built-in whisper-small model ID.');
        }
        if ((!is.string(model.path) || !model.path) && (!is.string(model.url) || !model.url)
                && (!is.string(model.archiveUrl) || !model.archiveUrl)) {
            throw new ArcaneError(ERROR_CODES.usage, `Whisper model ${model.id} needs its selected path, URL, or model archive URL.`);
        }
        if (!model.path && model.archiveUrl && (!is.string(model.filename) || !model.filename)) {
            throw new ArcaneError(ERROR_CODES.usage, `Whisper model ${model.id} needs its model filename inside the selected archive.`);
        }
        if (record.encoder === 'openvino-npu') {
            const pairedFiles = model.path
                ? [model.path, model.encoderPath, model.encoderDataPath]
                : [model.archiveUrl, model.filename, model.encoderFilename, model.encoderDataFilename];
            if (!pairedFiles.every(function selectedEncoderFile(value) { return is.string(value) && value !== ''; })) {
                throw new ArcaneError(ERROR_CODES.usage, `Whisper model ${model.id} needs its matching GGML, OpenVINO XML, and encoder BIN files.`);
            }
        }
        return {...model};
    });
    if (record.variants !== undefined && (!is.array(record.variants) || record.variants.length === 0)) {
        throw new ArcaneError(ERROR_CODES.usage, 'whisper.cpp variants must be a nonempty array when supplied.');
    }
    const variants = record.variants?.map(function selectedWhisperVariant(variant) {
        if (!variant || !is.object(variant) || is.array(variant) || !['cuda', 'metal', 'cpu'].includes(variant.backend)) {
            throw new ArcaneError(ERROR_CODES.usage, 'Each Whisper runtime variant needs its cuda, metal, or cpu backend.');
        }
        if ((!is.string(variant.root) || !variant.root) && (!is.string(variant.url) || !variant.url)) {
            throw new ArcaneError(ERROR_CODES.usage, `Whisper ${variant.backend} needs its complete runtime root or archive URL.`);
        }
        if (variant.encoder !== undefined && variant.encoder !== 'openvino-npu') {
            throw new ArcaneError(ERROR_CODES.usage, `Unknown Whisper variant encoder: ${String(variant.encoder)}.`);
        }
        return {...variant};
    });
    if (record.modelId !== undefined && (!is.string(record.modelId) || !models.some(function matchingModel(model) {
        return model.id === record.modelId;
    }))) {
        throw new ArcaneError(ERROR_CODES.usage, 'Whisper modelId must name one of the explicitly selected models.');
    }
    return {
        ...record,
        version: record.version ?? '1.9.4',
        backend,
        models,
        ...(helperRoot === undefined ? {} : {helperRoot}),
        ...(variants ? {variants} : {})
    };
}

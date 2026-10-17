import {randomUUID} from 'node:crypto';

/** Selected native assets from NVIDIA NeMo-Speech.cpp v0.2.0 models/index.json. */
export const NEMO_SPEECH_MODELS = {
    stt: {
        modelId: 'nemotron-3.5-asr-streaming-0.6b',
        providerId: 'nemotron',
        name: 'Nemotron 3.5 + speaker diarization',
        members: [
            {
                path: 'nemotron-3.5-asr-streaming-0.6b.q8_0.gguf',
                url: 'https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b/resolve/1c8deaecc64b91f034d73e08dd8b64625eb3395d/nemotron-3.5-asr-streaming-0.6b.q8_0.gguf'
            },
            {
                path: 'Nemotron-3-Diarization.q8_0.gguf',
                url: 'https://huggingface.co/nvidia/Nemotron-3-Diarization/resolve/f667ed73aee57d40cc39428eb768b4fd87a0a29e/Nemotron-3-Diarization.q8_0.gguf'
            }
        ],
        resourcePaths: {
            model: 'nemotron-3.5-asr-streaming-0.6b.q8_0.gguf',
            diarization: 'Nemotron-3-Diarization.q8_0.gguf'
        }
    },
    tts: {
        modelId: 'magpie',
        providerId: 'magpie-native',
        name: 'Magpie + NanoCodec',
        members: [
            {
                path: 'magpie_tts_multilingual_357m.v2607.f16.gguf',
                url: 'https://huggingface.co/nvidia/magpie_tts_multilingual_357m/resolve/19806879b16d3f2ccf28fb112b1bcd16a3c7923e/magpie_tts_multilingual_357m.v2607.f16.gguf'
            },
            {
                path: 'nemo_nano_codec_22khz_1.89kbps_21.5fps.decoder.f16.gguf',
                url: 'https://huggingface.co/nvidia/nemo-nano-codec-22khz-1.89kbps-21.5fps/resolve/fc00890b604aa2de298d2641ffc6c5f6caf8c4d7/nemo_nano_codec_22khz_1.89kbps_21.5fps.decoder.f16.gguf'
            }
        ],
        archives: [
            {
                url: 'https://huggingface.co/nvidia/magpie_tts_multilingual_357m/resolve/19806879b16d3f2ccf28fb112b1bcd16a3c7923e/magpie_tts_multilingual_357m.nemo',
                format: 'tar',
                // These offsets select upstream TAR segments at the transport
                // boundary. Their complete selected members stay unchanged.
                ranges: [
                    {start: 0, end: 20619263, stopBefore: 'model_weights.ckpt'},
                    {start: 1459750400, end: 1470207999}
                ],
                members: [
                    {
                        path: 'tokenizer/05adc40366e149b69319acd4b28a4919_pt_br_prondict-v1.0.dict',
                        member: '05adc40366e149b69319acd4b28a4919_pt_br_prondict-v1.0.dict'
                    },
                    {
                        path: 'tokenizer/339da71c54b046f98cbcf38ef6d4ff67_hindi_phoneme_merged_phoneme_dict.dict',
                        member: '339da71c54b046f98cbcf38ef6d4ff67_hindi_phoneme_merged_phoneme_dict.dict'
                    },
                    {
                        path: 'tokenizer/41913ebaa70342058574da74293b7630_magpie_tts_multilingual_357m.nemo.speakers.json',
                        member: '41913ebaa70342058574da74293b7630_magpie_tts_multilingual_357m.nemo.speakers.json'
                    },
                    {
                        path: 'tokenizer/61d57a4ccb064d1e8e3d9f871c571932_heteronyms-052722',
                        member: '61d57a4ccb064d1e8e3d9f871c571932_heteronyms-052722'
                    },
                    {
                        path: 'tokenizer/74b3e832fe914a569fcd42b51d06b2f1_ipa_dict_nv23.05.txt',
                        member: '74b3e832fe914a569fcd42b51d06b2f1_ipa_dict_nv23.05.txt'
                    },
                    {
                        path: 'tokenizer/7dbc31751f224f2486090d59dc95b9f7_es_ES_nv230301.dict',
                        member: '7dbc31751f224f2486090d59dc95b9f7_es_ES_nv230301.dict'
                    },
                    {
                        path: 'tokenizer/c5e4ec2af5a14ce294f4b9edcc936535_de_nv230119.heteronym',
                        member: 'c5e4ec2af5a14ce294f4b9edcc936535_de_nv230119.heteronym'
                    },
                    {
                        path: 'tokenizer/cf01ab5c48c84f3282ef7888263361e5_de_nv230119.dict',
                        member: 'cf01ab5c48c84f3282ef7888263361e5_de_nv230119.dict'
                    },
                    {
                        path: 'tokenizer/dc7d60d6b15a4651b21c9ca2932b62c6_ipa_cmudict-0.7b_nv23.01.txt',
                        member: 'dc7d60d6b15a4651b21c9ca2932b62c6_ipa_cmudict-0.7b_nv23.01.txt'
                    },
                    {path: 'tokenizer/model_config.yaml', member: 'model_config.yaml'}
                ]
            }
        ],
        resourcePaths: {
            model: 'magpie_tts_multilingual_357m.v2607.f16.gguf',
            codec: 'nemo_nano_codec_22khz_1.89kbps_21.5fps.decoder.f16.gguf',
            tokenizerConfig: 'tokenizer/model_config.yaml'
        }
    }
};

/** Explicitly acquire the complete ASR and diarization selection. */
export function prepareNemotronModels(options = {}) {
    return prepareModels(NEMO_SPEECH_MODELS.stt, options);
}

/** Explicitly acquire Magpie, NanoCodec and the matching tokenizer members. */
export function prepareMagpieModels(options = {}) {
    return prepareModels(NEMO_SPEECH_MODELS.tts, options);
}

async function prepareModels(selection, {modelAssets, workingDirectory, directories, id = randomUUID(), signal, onProgress, refresh = false}) {
    if (typeof modelAssets?.prepare !== 'function' || typeof modelAssets?.release !== 'function') {
        throw new TypeError('Native speech preparation requires the existing model-assets service.');
    }
    signal?.throwIfAborted();
    let projection;
    if (directories !== undefined && !refresh) {
        if (typeof modelAssets.discover !== 'function' || typeof modelAssets.openExisting !== 'function') {
            throw new TypeError('Installed native speech discovery requires the model-assets discover and openExisting methods.');
        }
        const discovered = await modelAssets.discover({
            directories, signal,
            catalog: [{id: selection.modelId, members: selection.members, archives: selection.archives,
                entryPath: selection.resourcePaths.model}]
        });
        signal?.throwIfAborted();
        const existing = discovered.models.find(function completeSelection(model) {
            return model.complete && model.catalogId === selection.modelId;
        });
        if (existing) {
            await onProgress?.({phase: 'reuse', completed: 0, total: existing.members.length, unit: 'files'});
            signal?.throwIfAborted();
            projection = await modelAssets.openExisting({id, directory: existing.directory, members: existing.members, signal});
        }
    }
    const reused = projection !== undefined;
    projection ??= await modelAssets.prepare({
        id, workingDirectory, members: selection.members,
        archives: selection.archives, signal, onProgress, refresh
    });
    let released;
    function release() {
        released ??= Promise.resolve().then(function releasePreparation() { return modelAssets.release(projection.id); });
        return released;
    }
    try {
        signal?.throwIfAborted();
        if (reused) {
            await onProgress?.({phase: 'ready', completed: projection.members.length, total: projection.members.length, unit: 'files'});
            signal?.throwIfAborted();
        }
        return {
            assetProjectionId: projection.id, directory: projection.directory,
            members: projection.members, resourcePaths: {...selection.resourcePaths}, release
        };
    } catch (error) {
        try {
            await release();
        } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Native speech preparation and cleanup failed.', {cause: error});
        }
        throw error;
    }
}

import path from 'node:path';
import {resolveNativeLaunchContext} from 'arcane-os/core/host';
import {createModelAssetService} from 'arcane-os/core/model-assets';
import {NEMO_SPEECH_MODELS} from 'arcane-os/local-ai/nemotron';
import {LANGUAGE_MODELS} from './model-catalog.mjs';

export default function createConversationModels(options, launchContext) {
    const locations = resolveNativeLaunchContext({appId: 'native-conversation', context: launchContext});
    const directory = locations.modelsDirectory;
    const llmDirectory = path.join(directory, 'LLM');
    const speechDirectory = path.join(directory, 'Speech');
    const directories = [llmDirectory, path.join(launchContext.appRoot, 'models'), ...(options.directories ?? [])];
    const catalog = launchContext.models ?? LANGUAGE_MODELS;
    const assets = createModelAssetService({appRoot: launchContext.appRoot});
    // These factories share the host's one composition context and asset owner.
    launchContext.stateRoot = locations.stateRoot;
    launchContext.modelsDirectory = directory;
    launchContext.modelAssets = assets;

    return {
        ...assets,
        methods: {
            ...assets.methods,
            async 'conversationModels.catalog'(_parameters, request) {
                const [installed, installedSpeech] = await Promise.all([
                    assets.discover({directories, catalog, signal: request.signal}),
                    assets.discover({directories: [speechDirectory, path.join(launchContext.appRoot, 'models')],
                        catalog: Object.values(NEMO_SPEECH_MODELS).map(function speechCatalog(model) {
                            return {id: model.modelId, ...model};
                        }), signal: request.signal})
                ]);
                return {
                    directory, llmDirectory, speechDirectory, catalog, installed, installedSpeech,
                    speech: NEMO_SPEECH_MODELS,
                    configuredSpeech: {
                        stt: Boolean(launchContext.speech?.stt?.modelPath),
                        tts: Boolean(launchContext.speech?.tts?.paths)
                    }
                };
            }
        }
    };
}

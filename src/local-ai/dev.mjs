import path from 'node:path';
import {createDevelopmentCore} from '../core/development.mjs';
import {createLocalAIService} from '../core/services/local-ai.mjs';
import {createLocalImageService} from '../core/services/image.mjs';
import {createModelAssetService} from '../core/services/model-assets.mjs';
import {createSpeechService} from '../core/services/speech.mjs';
import {createExecutionDeviceService} from '../core/services/execution-devices.mjs';
import {normalizeLocalAIConfig} from './config.mjs';
import {discoverLocalAIRuntimes} from './discover.mjs';
import {ensureLocalAIRuntimes} from './install.mjs';
import {createWhisperRuntime} from './whisper/index.mjs';
import {createExecutionDeviceCatalog} from './execution-devices.mjs';

/** Local engines share the ordinary app-service development transport. */
export function createDevelopmentLocalAI({
    config, appRoot, directory, application, version, signal, onEvent,
    services = [], serviceModules = [], context = {}
} = {}) {
    const selected = normalizeLocalAIConfig(config) ?? {runtimes: []};
    const lifetime = new AbortController();
    signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    // Discovery starts on demand, independently of model runtime preparation.
    const executionDevices = createExecutionDeviceCatalog({signal});
    const localConfig = {
        ...selected,
        runtimes: selected.runtimes.filter(function selectedChatRuntime(requirement) {
            return requirement.id !== 'stable-diffusion.cpp' && requirement.id !== 'whisper.cpp';
        })
    };
    const service = createLocalAIService(
        localConfig,
        {
            appRoot, signal, onEvent, executionDevices,
            async prepare({signal, onEvent: report}) {
                const discovered = await discoverLocalAIRuntimes({config: localConfig, appRoot, signal});
                const installed = await ensureLocalAIRuntimes(
                    {runtimes: discovered.missing, directory, signal, onEvent: report}
                );
                return [...discovered.available, ...installed];
            }
        }
    );
    const definitions = [createExecutionDeviceService({catalog: executionDevices}), service, ...services];
    let modelAssets;
    let imageService;
    let speechService;
    const imageSelected = selected.runtimes.some(function selectedImageRuntime(requirement) {
        return requirement.id === 'stable-diffusion.cpp';
    });
    if (imageSelected || selected.runtimes.some(function selectedONNXRuntime(requirement) {
        return requirement.id === 'onnx';
    })) {
        modelAssets = createModelAssetService({appRoot});
        definitions.push(modelAssets);
    }
    if (imageSelected) {
        imageService = createLocalImageService(
            selected,
            {
                appRoot, modelAssets, signal, onEvent,
                async prepare({requirement, signal, onEvent: report}) {
                    const installed = await ensureLocalAIRuntimes(
                        {runtimes: [requirement], directory, signal, onEvent: report}
                    );
                    return installed[0];
                }
            }
        );
        definitions.push(imageService);
    }
    const whisperRequirement = selected.runtimes.find(function selectedWhisperRuntime(requirement) {
        return requirement.id === 'whisper.cpp';
    });
    if (whisperRequirement) {
        const stt = createWhisperRuntime(
            {
                modelId: whisperRequirement.modelId,
                temporaryDirectory: path.join(appRoot, '.arcane', 'speech', 'whisper'),
                onEvent,
                async prepare({signal, onEvent: report}) {
                    const installed = await ensureLocalAIRuntimes(
                        {runtimes: [whisperRequirement], directory, signal, onEvent: report}
                    );
                    return installed[0];
                }
            }
        );
        speechService = createSpeechService({stt, signal});
        definitions.push(speechService);
    }
    const core = createDevelopmentCore(
        {
            appRoot, application, version, signal, onEvent, context, serviceModules,
            services: definitions,
            getReplayEvents() {
                const snapshots = [{event: 'localai.state', data: service.current()}];
                if (imageService) snapshots.push({event: 'image.state', data: imageService.current()});
                if (speechService) snapshots.push({event: 'speech.state', data: speechService.current()});
                if (modelAssets) snapshots.push({event: 'modelAssets.state', data: modelAssets.current()});
                return snapshots;
            }
        }
    );
    function current() {
        return {
            ...core.current(),
            localAI: service.current(),
            image: imageService?.current() ?? null,
            speech: speechService?.current() ?? null
        };
    }
    let closing;
    function close() {
        if (!closing) {
            lifetime.abort();
            closing = core.close().then(current);
        }
        return closing;
    }
    return {...core, current, close};
}

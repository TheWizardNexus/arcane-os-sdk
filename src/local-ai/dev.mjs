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
import {createNativeKokoroRuntime} from './kokoro/index.mjs';
import {createExecutionDeviceCatalog} from './execution-devices.mjs';
import {ArcaneError, ERROR_CODES} from '../errors.mjs';

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
            return !['stable-diffusion.cpp', 'whisper.cpp', 'kokoro-native'].includes(requirement.id);
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
    if (imageSelected || selected.runtimes.some(function selectedProjectedRuntime(requirement) {
        return ['onnx', 'llama.cpp', 'kokoro-native'].includes(requirement.id);
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
    const kokoroRequirement = selected.runtimes.find(function selectedKokoroRuntime(requirement) {
        return requirement.id === 'kokoro-native';
    });
    let stt;
    let tts;
    if (whisperRequirement) {
        stt = createWhisperRuntime(
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
    }
    if (kokoroRequirement) {
        tts = createNativeKokoroRuntime({
            modelId: kokoroRequirement.modelId,
            model: kokoroRequirement.model,
            revision: kokoroRequirement.revision,
            dtype: kokoroRequirement.dtype,
            paths: kokoroRequirement.paths,
            assetProjectionId: kokoroRequirement.assetProjectionId,
            resourcePaths: kokoroRequirement.resourcePaths,
            sessionOptions: kokoroRequirement.sessionOptions,
            executionPreference: kokoroRequirement.executionPreference,
            executionTarget: kokoroRequirement.executionTarget,
            modelAssets, signal, onEvent,
            async prepare({signal: activationSignal}) {
                if (!localConfig.runtimes.some(function selectedONNX(requirement) { return requirement.id === 'onnx'; })) {
                    throw new ArcaneError(ERROR_CODES.targetUnavailable, 'Native Kokoro requires an explicitly selected onnx runtime.');
                }
                const preparation = new AbortController();
                const preparationSignal = AbortSignal.any([activationSignal, preparation.signal]);
                function preparationFailed(error) {
                    preparation.abort(error);
                    throw error;
                }
                // Helper acquisition and the existing ONNX owner's startup are
                // independent. Join both before native activation can continue.
                const outcomes = await Promise.allSettled([
                    waitForKokoroONNX(preparationSignal).catch(preparationFailed),
                    ensureLocalAIRuntimes({
                        runtimes: [kokoroRequirement], directory, signal: preparationSignal, onEvent
                    }).catch(preparationFailed)
                ]);
                const failures = outcomes.filter(function failed(result) { return result.status === 'rejected'; })
                    .map(function cause(result) { return result.reason; });
                if (failures.length === 1) throw failures[0];
                if (failures.length) throw new AggregateError(failures, 'Native Kokoro preparation failed.');
                preparationSignal.throwIfAborted();
                return {onnx: outcomes[0].value, runtime: outcomes[1].value[0]};
            }
        });
    }
    if (stt || tts) {
        speechService = createSpeechService({stt, tts, signal});
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
    function waitForKokoroONNX(activationSignal) {
        activationSignal.throwIfAborted();
        let cancel;
        const cancelled = new Promise(function observePreparationCancellation(_resolve, reject) {
            cancel = function stopWaitingForONNX() { reject(activationSignal.reason); };
            activationSignal.addEventListener('abort', cancel, {once: true});
        });
        const ready = core.ready.then(async function existingONNXOwner(runtime) {
            activationSignal.throwIfAborted();
            const owner = await runtime.getService('local-ai');
            activationSignal.throwIfAborted();
            return owner.getONNXRuntime();
        });
        // Cancel this selected activation's wait without stopping the shared owner.
        return Promise.race([ready, cancelled]).finally(function releaseONNXWait() {
            activationSignal.removeEventListener('abort', cancel);
        });
    }
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

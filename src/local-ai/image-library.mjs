import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import Is from 'strong-type';

const is = new Is(false);
let callbackSequence = 0;

// This adapter belongs to the process-owned image Worker. The upstream
// callbacks are library globals, so every SDK service shares that owner.
export function createImageLibrary(
    {
        libraryPath,
        bindingModulePath,
        onLog,
        onProgress
    }
) {
    const requireBinding = createRequire(bindingModulePath);
    const koffi = requireBinding(bindingModulePath);
    const library = loadLibrary(libraryPath);
    const backendDirectory = dirname(libraryPath);
    let backendLibrary;
    let backendBaseLibrary;
    let backendsLoaded = false;

    let native;
    let logCallback;
    let progressCallback;
    let nativeContext = null;
    let contextMemory;
    let operation;
    let unloading = false;
    let closing = false;
    let closed = false;
    let unloadPromise;
    let closePromise;
    const pendingCallbacks = new Set();
    const callbackErrors = [];
    const converters = new Map();

    // Field order and C types follow stable-diffusion.cpp master-929-3f8527a:
    // https://github.com/leejet/stable-diffusion.cpp/blob/3f8527a/include/stable-diffusion.h
    let contextType;
    let imageType;
    let generationType;
    try {
        // The selected Windows/Linux releases ship GGML beside this library.
        // macOS embeds it instead. Default GGML discovery searches beside the
        // host executable and in its working directory, so dynamic releases
        // need the public directory loader before enumeration or model load.
        const suffix = process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';
        const prefix = process.platform === 'win32' ? '' : 'lib';
        const backendPath = join(backendDirectory, `${prefix}ggml${suffix}`);
        if (existsSync(backendPath)) {
            backendLibrary = loadLibrary(backendPath);
            backendBaseLibrary = loadLibrary(
                join(backendDirectory, `${prefix}ggml-base${suffix}`)
            );
        }
        const tiling = defineStruct(
            {
                enabled: 'bool',
                temporal_tiling: 'bool',
                tile_size_w: 'int',
                tile_size_h: 'int',
                target_overlap: 'float',
                rel_size_w: 'float',
                rel_size_h: 'float',
                extra_tiling_args: 'cstring'
            }
        );
        const embedding = defineStruct(
            {
                name: 'cstring',
                path: 'cstring'
            }
        );
        contextType = defineStruct(
            {
                model_path: 'cstring',
                clip_l_path: 'cstring',
                clip_g_path: 'cstring',
                clip_vision_path: 'cstring',
                t5xxl_path: 'cstring',
                llm_path: 'cstring',
                llm_vision_path: 'cstring',
                diffusion_model_path: 'cstring',
                high_noise_diffusion_model_path: 'cstring',
                uncond_diffusion_model_path: 'cstring',
                embeddings_connectors_path: 'cstring',
                vae_path: 'cstring',
                audio_vae_path: 'cstring',
                audio_encoder_path: 'cstring',
                taesd_path: 'cstring',
                control_net_path: 'cstring',
                ip_adapter_path: 'cstring',
                motion_module_path: 'cstring',
                embeddings: {element: embedding, count: 'embedding_count'},
                embedding_count: 'uint32_t',
                photo_maker_path: 'cstring',
                pulid_weights_path: 'cstring',
                tensor_type_rules: 'cstring',
                n_threads: 'int',
                wtype: {convert: 'str_to_sd_type'},
                rng_type: {convert: 'str_to_rng_type'},
                sampler_rng_type: {convert: 'str_to_rng_type'},
                prediction: {convert: 'str_to_prediction'},
                lora_apply_mode: {convert: 'str_to_lora_apply_mode'},
                enable_mmap: 'bool',
                flash_attn: 'bool',
                diffusion_flash_attn: 'bool',
                tae_preview_only: 'bool',
                diffusion_conv_direct: 'bool',
                vae_conv_direct: 'bool',
                force_sdxl_vae_conv_scale: 'bool',
                vae_format: 'int',
                max_vram: 'cstring',
                disable_prefetch: 'bool',
                eager_load: 'bool',
                backend: 'cstring',
                params_backend: 'cstring',
                split_mode: 'cstring',
                auto_fit: 'bool',
                rpc_servers: 'cstring',
                model_args: 'cstring',
                disable_segmented_compute: 'bool',
                linear_scale: 'float',
                attn_scale: 'float',
                tokenizer: 'cstring',
                sage_attn: 'bool',
                conditioning_cache_size: 'int'
            }
        );
        imageType = defineStruct(
            {
                width: 'uint32_t',
                height: 'uint32_t',
                channel: 'uint32_t',
                data: {element: 'uint8_t', raster: true}
            }
        );
        const preprocessing = defineStruct(
            {
                rules: 'cstring'
            }
        );
        const slg = defineStruct(
            {
                layers: {element: 'int', count: 'layer_count'},
                layer_count: 'size_t',
                layer_start: 'float',
                layer_end: 'float',
                scale: 'float'
            }
        );
        const guidance = defineStruct(
            {
                txt_cfg: 'float',
                img_cfg: 'float',
                distilled_guidance: 'float',
                slg
            }
        );
        const sample = defineStruct(
            {
                guidance,
                scheduler: {convert: 'str_to_scheduler'},
                sample_method: {convert: 'str_to_sample_method'},
                sample_steps: 'int',
                eta: 'float',
                shifted_timestep: 'int',
                custom_sigmas: {element: 'float', count: 'custom_sigmas_count'},
                custom_sigmas_count: 'int',
                flow_shift: 'float',
                extra_sample_args: 'cstring'
            }
        );
        const photoMaker = defineStruct(
            {
                id_images: {element: imageType, count: 'id_images_count'},
                id_images_count: 'int',
                id_embed_path: 'cstring',
                style_strength: 'float'
            }
        );
        const pulid = defineStruct(
            {
                id_embedding_path: 'cstring',
                id_weight: 'float'
            }
        );
        const cache = defineStruct(
            {
                mode: 'int',
                reuse_threshold: 'float',
                start_percent: 'float',
                end_percent: 'float',
                error_decay_rate: 'float',
                use_relative_threshold: 'bool',
                reset_error_on_compute: 'bool',
                Fn_compute_blocks: 'int',
                Bn_compute_blocks: 'int',
                residual_diff_threshold: 'float',
                max_warmup_steps: 'int',
                max_cached_steps: 'int',
                max_continuous_cached_steps: 'int',
                taylorseer_n_derivatives: 'int',
                taylorseer_skip_interval: 'int',
                scm_mask: 'cstring',
                scm_policy_dynamic: 'bool',
                spectrum_w: 'float',
                spectrum_m: 'int',
                spectrum_lam: 'float',
                spectrum_window_size: 'int',
                spectrum_flex_window: 'float',
                spectrum_warmup_steps: 'int',
                spectrum_stop_percent: 'float'
            }
        );
        const lora = defineStruct(
            {
                is_high_noise: 'bool',
                multiplier: 'float',
                path: 'cstring'
            }
        );
        const hires = defineStruct(
            {
                enabled: 'bool',
                upscaler: {convert: 'str_to_sd_hires_upscaler'},
                model_path: 'cstring',
                scale: 'float',
                target_width: 'int',
                target_height: 'int',
                steps: 'int',
                denoising_strength: 'float',
                upscale_tile_size: 'int',
                custom_sigmas: {element: 'float', count: 'custom_sigmas_count'},
                custom_sigmas_count: 'int'
            }
        );
        generationType = defineStruct(
            {
                loras: {element: lora, count: 'lora_count'},
                lora_count: 'uint32_t',
                prompt: 'cstring',
                negative_prompt: 'cstring',
                clip_skip: 'int',
                init_image: imageType,
                ref_images: {element: imageType, count: 'ref_images_count'},
                ref_images_count: 'int',
                ref_image_args: 'cstring',
                mask_image: imageType,
                width: 'int',
                height: 'int',
                sample_params: sample,
                strength: 'float',
                seed: 'int64_t',
                batch_count: 'int',
                control_image: imageType,
                control_strength: 'float',
                ip_adapter_image: imageType,
                ip_adapter_strength: 'float',
                pm_params: photoMaker,
                pulid_params: pulid,
                vae_tiling_params: tiling,
                cache,
                hires,
                qwen_image_layers: 'int',
                circular_x: 'bool',
                circular_y: 'bool',
                image_preprocess: preprocessing
            }
        );
        const sequence = ++callbackSequence;
        const logType = koffi.proto(
            `ArcaneSdLog${sequence}`,
            'void',
            ['int', 'str', 'void *']
        );
        const progressType = koffi.proto(
            `ArcaneSdProgress${sequence}`,
            'void',
            ['int', 'int', 'float', 'void *']
        );
        native = {
            loadBackends: backendLibrary?.func(
                'ggml_backend_load_all_from_path', 'void',
                ['void *']
            ),
            setBackendLog: backendBaseLibrary?.func(
                'ggml_log_set', 'void',
                ['void *', 'void *']
            ),
            initContext: library.func(
                'sd_ctx_params_init', 'void',
                ['void *']
            ),
            createContext: library.func(
                'new_sd_ctx', 'void *',
                ['void *']
            ),
            freeContext: library.func(
                'free_sd_ctx', 'void',
                ['void *']
            ),
            modelVersion: library.func(
                'sd_get_model_version_name', 'str',
                ['void *']
            ),
            initGeneration: library.func(
                'sd_img_gen_params_init', 'void',
                ['void *']
            ),
            generate: library.func(
                'generate_image', 'bool',
                ['void *', 'void *', 'void *', 'void *']
            ),
            freeImages: library.func(
                'free_sd_images', 'void',
                ['void *', 'int']
            ),
            cancel: library.func(
                'sd_cancel_generation', 'void',
                ['void *', 'int']
            ),
            listDevices: library.func(
                'sd_list_devices', 'size_t',
                ['void *', 'size_t']
            ),
            setLog: library.func(
                'sd_set_log_callback', 'void',
                [koffi.pointer(logType), 'void *']
            ),
            setProgress: library.func(
                'sd_set_progress_callback', 'void',
                [koffi.pointer(progressType), 'void *']
            )
        };
        logCallback = koffi.register(
            receiveLog,
            koffi.pointer(logType)
        );
        progressCallback = koffi.register(
            receiveProgress,
            koffi.pointer(progressType)
        );
        native.setLog(logCallback, null);
        native.setProgress(progressCallback, null);
    } catch (error) {
        if (native) {
            native.setBackendLog?.(null, null);
            native.setLog(null, null);
            native.setProgress(null, null);
        }
        if (logCallback) koffi.unregister(logCallback);
        if (progressCallback) koffi.unregister(progressCallback);
        library.unload();
        backendLibrary?.unload();
        backendBaseLibrary?.unload();
        throw error;
    }

    return {
        listDevices,
        load,
        generate,
        cancel,
        unload,
        close
    };

    function loadLibrary(path) {
        try {
            return koffi.load(path);
        } catch (cause) {
            throw imageError(
                'LOCAL_IMAGE_LIBRARY_UNAVAILABLE',
                `Unable to load the local image library at ${path}.`,
                cause
            );
        }
    }

    async function loadBackends() {
        if (backendsLoaded) return;
        if (!native.loadBackends) {
            backendsLoaded = true;
            return;
        }
        const memory = createMemory();
        try {
            const directory = memory.string(backendDirectory, 'backend directory');
            await invoke(native.loadBackends, directory);
            backendsLoaded = true;
            await finishCallbacks();
        } finally {
            memory.release();
        }
    }

    function defineStruct(fields) {
        const nativeFields = {};
        for (const [name, field] of Object.entries(fields)) {
            nativeFields[name] = nativeType(field);
        }
        return {
            fields,
            type: koffi.struct(nativeFields)
        };
    }

    function nativeType(field) {
        if (field === 'cstring' || field.element) return 'void *';
        if (field.convert) return 'int';
        return field.type ?? field;
    }

    function zeroStruct(descriptor) {
        const value = {};
        for (const [name, field] of Object.entries(descriptor.fields)) {
            value[name] = field.fields
                ? zeroStruct(field)
                : field === 'cstring' || field.element
                    ? null
                    : field === 'bool' ? false : 0;
        }
        return value;
    }

    function createMemory() {
        const allocations = [];
        const strings = [];
        return {
            allocate,
            string,
            release
        };

        function allocate(type, count = 1) {
            const pointer = koffi.alloc(type, count);
            allocations.push(pointer);
            return pointer;
        }

        function string(value, name) {
            if (value === null) return null;
            if (!is.string(value)) throw new TypeError(`${name} must be a string or null.`);
            if (value.includes('\0') || !value.isWellFormed()) {
                throw imageError(
                    'LOCAL_IMAGE_STRING_INPUT_UNSUPPORTED',
                    `The native UTF-8 C string for ${name} cannot preserve embedded U+0000 or unpaired UTF-16 surrogates.`
                );
            }
            // Explicit native storage avoids transient FFI string marshalling;
            // the complete owned Buffer and its C string share this lifetime.
            const buffer = Buffer.from(`${value}\0`, 'utf8');
            strings.push(buffer);
            const pointer = allocate('uint8_t', buffer.length);
            koffi.encode(pointer, 'uint8_t', buffer, buffer.length);
            return pointer;
        }

        function release() {
            const errors = [];
            while (allocations.length) {
                try {
                    koffi.free(
                        allocations.pop()
                    );
                } catch (error) {
                    errors.push(error);
                }
            }
            strings.length = 0;
            if (errors.length) throw new AggregateError(errors, 'Local image input memory cleanup failed.');
        }
    }

    function marshalStruct(descriptor, defaults, supplied, memory, path) {
        if (!supplied || !is.object(supplied) || is.array(supplied)) {
            throw new TypeError(`${path} must contain native struct fields.`);
        }
        const value = {...defaults};
        for (const [name, input] of Object.entries(supplied)) {
            const field = descriptor.fields[name];
            if (field === undefined) {
                throw imageError(
                    'LOCAL_IMAGE_PARAMETER_UNSUPPORTED',
                    `${path}.${name} is absent from the selected native image ABI.`
                );
            }
            if (input === undefined) continue;
            const fieldPath = `${path}.${name}`;
            if (field === 'cstring') {
                value[name] = memory.string(input, fieldPath);
            } else if (field.fields) {
                value[name] = marshalStruct(field, defaults[name], input, memory, fieldPath);
            } else if (field.convert && is.string(input)) {
                let convert = converters.get(field.convert);
                if (!convert) {
                    convert = library.func(
                        field.convert, 'int',
                        ['void *']
                    );
                    converters.set(field.convert, convert);
                }
                value[name] = convert(
                    memory.string(input, fieldPath)
                );
            } else if (field.element) {
                const elements = input === null ? [] : input;
                if (!is.array(elements) && !ArrayBuffer.isView(elements)) {
                    throw new TypeError(`${fieldPath} must contain the complete native array.`);
                }
                if (elements.length === undefined) {
                    throw new TypeError(`${fieldPath} requires array elements rather than a DataView.`);
                }
                if (field.count) {
                    const count = supplied[field.count];
                    if (count !== undefined && Number(count) !== elements.length) {
                        throw imageError(
                            'LOCAL_IMAGE_ARRAY_INPUT_UNSUPPORTED',
                            `${path}.${field.count} must describe every element of ${fieldPath}.`
                        );
                    }
                    value[field.count] = elements.length;
                }
                const elementType = nativeType(field.element);
                const pointer = elements.length ? memory.allocate(elementType, elements.length) : null;
                if (pointer !== null) {
                    const encoded = field.element.fields
                        ? elements.map(
                            function marshalElement(element, index) {
                                return marshalStruct(
                                    field.element,
                                    zeroStruct(field.element),
                                    element,
                                    memory,
                                    `${fieldPath}[${index}]`
                                );
                            }
                        )
                        : elements;
                    koffi.encode(pointer, elementType, encoded, elements.length);
                }
                value[name] = pointer;
            } else {
                value[name] = input;
            }
        }
        for (const [name, field] of Object.entries(descriptor.fields)) {
            if (field.count && supplied[name] === undefined
                && supplied[field.count] !== undefined
                && Number(supplied[field.count]) !== Number(defaults[field.count])) {
                throw imageError(
                    'LOCAL_IMAGE_ARRAY_INPUT_UNSUPPORTED',
                    `${path}.${field.count} requires its complete ${name} array.`
                );
            }
            if (field.raster && supplied[name] !== undefined) {
                const elements = supplied[name] === null ? [] : supplied[name];
                // This is the C raster layout, not an application content cap.
                if (elements.length !== value.width * value.height * value.channel) {
                    throw imageError(
                        'LOCAL_IMAGE_RASTER_INPUT_UNSUPPORTED',
                        `${path}.data must contain every channel of the declared raster.`
                    );
                }
            }
        }
        return value;
    }

    function initialize(descriptor, init, supplied, memory, path) {
        const pointer = memory.allocate(descriptor.type);
        init(pointer);
        const defaults = koffi.decode(pointer, descriptor.type);
        const value = marshalStruct(descriptor, defaults, supplied, memory, path);
        koffi.encode(pointer, descriptor.type, value);
        return pointer;
    }

    function invoke(fn, ...args) {
        return new Promise(
            function invokeNative(resolve, reject) {
                fn.async(
                    ...args,
                    function nativeCompleted(error, result) {
                        if (error) reject(error);
                        else resolve(result);
                    }
                );
            }
        );
    }

    function receiveLog(level, text) {
        reassertCancellation();
        deliverCallback(
            onLog,
            {level, text}
        );
    }

    function receiveProgress(step, steps, time) {
        reassertCancellation();
        deliverCallback(
            onProgress,
            {step, steps, time}
        );
    }

    function reassertCancellation() {
        // generate_image resets its atomic flag at entry. A cancellation that
        // arrived while the FFI task was queued must survive that reset.
        if (operation?.aborted && operation.kind === 'generate' && nativeContext !== null) {
            native.cancel(nativeContext, 0);
        }
    }

    function deliverCallback(listener, event) {
        if (!is.function(listener)) return;
        try {
            const result = listener(event);
            if (result && is.function(result.then)) {
                const pending = Promise.resolve(result).catch(recordCallbackError).finally(
                    function callbackSettled() {
                        pendingCallbacks.delete(pending);
                    }
                );
                pendingCallbacks.add(pending);
            }
        } catch (error) {
            recordCallbackError(error);
        }
    }

    function recordCallbackError(error) {
        callbackErrors.push(error);
        cancel();
    }

    async function finishCallbacks() {
        while (pendingCallbacks.size) await Promise.all(pendingCallbacks);
        if (callbackErrors.length) {
            const errors = callbackErrors.splice(0);
            throw new AggregateError(errors, 'Local image callbacks failed.');
        }
    }

    function begin(kind, signal) {
        if (closed || closing || unloading) throw new Error('The local image library is closing or unloading.');
        if (operation) throw new Error('The shared local image context already has an active operation.');
        const current = {
            kind,
            signal,
            aborted: Boolean(signal?.aborted),
            done: null,
            complete: null,
            abort: cancel
        };
        current.done = new Promise(
            function observeCompletion(resolve) {
                current.complete = resolve;
            }
        );
        operation = current;
        signal?.addEventListener(
            'abort', current.abort,
            {once: true}
        );
        return current;
    }

    function end(current) {
        current.signal?.removeEventListener('abort', current.abort);
        operation = undefined;
        current.complete();
    }

    function requireActive(current) {
        if (current.aborted) {
            const error = imageError(
                'LOCAL_IMAGE_CANCELLED',
                `Local image ${current.kind} was cancelled.`,
                current.signal?.reason
            );
            error.name = 'AbortError';
            throw error;
        }
    }

    function cancel() {
        if (!operation) return false;
        operation.aborted = true;
        reassertCancellation();
        return true;
    }

    async function listDevices() {
        const current = begin('device enumeration');
        try {
            await loadBackends();
            requireActive(current);
            let required = Number(
                await invoke(native.listDevices, null, 0)
            );
            for (;;) {
                // sd_list_devices reports the complete C string length without
                // its terminator. Repeat only if enumeration changed mid-call.
                const buffer = Buffer.alloc(required + 1);
                const observed = Number(
                    await invoke(native.listDevices, buffer, buffer.length)
                );
                await finishCallbacks();
                requireActive(current);
                if (observed > required) {
                    required = observed;
                    continue;
                }
                const text = buffer.toString('utf8', 0, observed);
                const devices = [];
                for (const line of text.split('\n')) {
                    if (line === '') continue;
                    const separator = line.indexOf('\t');
                    devices.push(
                        {
                            name: separator < 0 ? line : line.substring(0, separator),
                            description: separator < 0 ? '' : line.substring(separator + 1)
                        }
                    );
                }
                return {text, devices};
            }
        } finally {
            end(current);
        }
    }

    async function load(
        {
            resources = {},
            context = {},
            signal
        } = {}
    ) {
        const current = begin('load', signal);
        const memory = createMemory();
        let created = null;
        let result;
        let failure;
        try {
            requireActive(current);
            await loadBackends();
            requireActive(current);
            await releaseContext();
            requireActive(current);
            const supplied = {...context};
            if (supplied.eager_load === undefined) supplied.eager_load = true;
            for (const [role, path] of Object.entries(resources)) {
                const name = contextType.fields[`${role}_path`] === 'cstring' ? `${role}_path` : role;
                if (contextType.fields[name] !== 'cstring') {
                    throw imageError('LOCAL_IMAGE_RESOURCE_UNSUPPORTED', `Unknown native model resource: ${role}.`);
                }
                supplied[name] = path;
            }
            const params = initialize(contextType, native.initContext, supplied, memory, 'context');
            created = await invoke(native.createContext, params);
            await finishCallbacks();
            requireActive(current);
            if (created === null) {
                throw imageError('LOCAL_IMAGE_MODEL_LOAD_FAILED', 'The native image model context could not be loaded.');
            }
            result = {
                modelVersion: native.modelVersion(created),
                // Upstream exposes no getter for the effective auto backend.
                backend: supplied.backend ?? null
            };
            nativeContext = created;
            contextMemory = memory;
            created = null;
        } catch (error) {
            failure = error;
        } finally {
            if (created !== null) {
                try {
                    await invoke(native.freeContext, created);
                    await finishCallbacks();
                } catch (error) {
                    failure = combineErrors(failure, error);
                }
            }
            if (contextMemory !== memory) {
                try {
                    memory.release();
                } catch (error) {
                    failure = combineErrors(failure, error);
                }
            }
            end(current);
        }
        if (failure) throw failure;
        return result;
    }

    async function generate(
        {
            prompt,
            parameters = {},
            signal,
            image
        } = {}
    ) {
        const current = begin('generate', signal);
        const memory = createMemory();
        let output;
        let count;
        let outputsInitialized = false;
        let result;
        let failure;
        try {
            requireActive(current);
            if (nativeContext === null) throw new Error('Load an image model before generating an image.');
            if (!is.string(prompt)) throw new TypeError('Image generation requires the complete prompt string.');
            const supplied = {...parameters, prompt};
            if (image !== undefined) supplied.init_image = image;
            const params = initialize(generationType, native.initGeneration, supplied, memory, 'parameters');
            output = memory.allocate('void *');
            koffi.encode(output, 'void *', null);
            count = memory.allocate('int');
            koffi.encode(count, 'int', 0);
            outputsInitialized = true;
            const succeeded = await invoke(native.generate, nativeContext, params, output, count);
            await finishCallbacks();
            requireActive(current);
            if (!succeeded) {
                throw imageError('LOCAL_IMAGE_GENERATION_FAILED', 'The native image generation operation failed.');
            }
            const pointer = koffi.decode(output, 'void *');
            const imageCount = koffi.decode(count, 'int');
            if (pointer === null || imageCount <= 0) {
                throw imageError('LOCAL_IMAGE_GENERATION_FAILED', 'The native image operation returned no images.');
            }
            result = [];
            for (const raster of koffi.decode(pointer, imageType.type, imageCount)) {
                const elements = raster.width * raster.height * raster.channel;
                if (raster.data === null || elements === 0) {
                    throw imageError('LOCAL_IMAGE_GENERATION_FAILED', 'The native image operation returned an empty raster.');
                }
                // Copy the entire raster before the upstream allocator frees it.
                const data = new Uint8Array(
                    new Uint8Array(
                        koffi.view(raster.data, elements)
                    )
                );
                result.push(
                    {
                        width: raster.width,
                        height: raster.height,
                        channel: raster.channel,
                        data
                    }
                );
            }
        } catch (error) {
            failure = error;
        } finally {
            if (outputsInitialized) {
                try {
                    const pointer = koffi.decode(output, 'void *');
                    if (pointer !== null) {
                        await invoke(
                            native.freeImages, pointer,
                            koffi.decode(count, 'int')
                        );
                        await finishCallbacks();
                    }
                } catch (error) {
                    failure = combineErrors(failure, error);
                }
            }
            try {
                memory.release();
            } catch (error) {
                failure = combineErrors(failure, error);
            }
            end(current);
        }
        if (failure) throw failure;
        requireActive(current);
        return result;
    }

    async function releaseContext() {
        const pointer = nativeContext;
        const memory = contextMemory;
        nativeContext = null;
        contextMemory = undefined;
        if (pointer === null) return;
        let failure;
        try {
            await invoke(native.freeContext, pointer);
            await finishCallbacks();
        } catch (error) {
            failure = error;
        }
        try {
            memory.release();
        } catch (error) {
            failure = combineErrors(failure, error);
        }
        if (failure) throw failure;
    }

    function unload() {
        if (closed) return Promise.resolve();
        if (unloadPromise) return unloadPromise;
        unloading = true;
        unloadPromise = performUnload().finally(
            function unloaded() {
                unloading = false;
                unloadPromise = undefined;
            }
        );
        return unloadPromise;
    }

    async function performUnload() {
        if (operation) {
            const pending = operation.done;
            cancel();
            await pending;
        }
        await releaseContext();
        await finishCallbacks();
    }

    function close() {
        if (closePromise) return closePromise;
        closing = true;
        closePromise = performClose();
        return closePromise;
    }

    async function performClose() {
        let failure;
        try {
            await unload();
        } catch (error) {
            failure = error;
        } finally {
            // Native work and frees have joined before global callback slots
            // are cleared and their registered JS functions are released.
            // GGML intentionally retains dynamic backends; reset its callback
            // into stable-diffusion before that shared library is unloaded.
            native.setBackendLog?.(null, null);
            native.setLog(null, null);
            native.setProgress(null, null);
            koffi.unregister(logCallback);
            koffi.unregister(progressCallback);
            library.unload();
            backendLibrary?.unload();
            backendBaseLibrary?.unload();
            closed = true;
        }
        if (failure) throw failure;
    }
}

function imageError(code, message, cause) {
    const options = cause === undefined ? undefined : {cause};
    const error = new Error(message, options);
    error.code = code;
    return error;
}

function combineErrors(first, second) {
    if (!first) return second;
    return new AggregateError(
        [first, second],
        'Local image operation and cleanup failed.'
    );
}

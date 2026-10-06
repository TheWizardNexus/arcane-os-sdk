import {parentPort,workerData} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
import Is from 'strong-type';

const is=new Is(false);
const imported=await import(pathToFileURL(workerData.modulePath).href);
const ort=imported.default??imported;
let session;

function describeError(error){
    if(!(error instanceof Error))return {name:'Error',message:String(error),cause:error};
    const result={...error,name:error.name,message:error.message,stack:error.stack};
    if(error.cause!==undefined)result.cause=error.cause instanceof Error?describeError(error.cause):error.cause;
    if(error instanceof AggregateError)result.errors=error.errors.map(describeError);
    return result;
}

async function createSession(request) {
    const supplied = request.sessionOptions;
    const selectProviders = supplied === undefined
        || (supplied !== null && is.object(supplied) && supplied.executionProviders === undefined);
    const options = selectProviders ? {...supplied, executionProviders: ['cpu']} : supplied;
    const execution = {
        preference: request.executionPreference ?? 'cpu',
        requestedTarget: request.executionTarget ?? null,
        resolvedDevice: null,
        resolution: 'automatic',
        reason: selectProviders ? 'engine-default-required' : 'caller-session-options',
        ...request.targetResolution,
        configuredTarget: null,
        observedTarget: null,
        supportedBackends: [],
        selectedProviders: [],
        attempts: [],
        fallback: false,
        discoveryError: null
    };
    const failures = [];

    function targetFailure(code, reason, message) {
        execution.reason = reason;
        const error = new Error(message);
        error.code = code;
        error.execution = execution;
        return error;
    }

    function providerName(provider) {
        return is.string(provider) ? provider : provider?.name;
    }

    async function configure(selectedOptions, source, finalAttempt = true) {
        const executionProviders = selectedOptions?.executionProviders ?? null;
        const names = is.array(executionProviders) ? executionProviders.map(providerName) : [];
        const configuredTarget = {source, executionProviders};
        const attempt = {executionProviders: names, configuredTarget, status: 'loading', error: null};
        execution.attempts.push(attempt);
        try {
            session = await ort.InferenceSession.create(request.model, selectedOptions);
            attempt.status = 'configured';
            execution.selectedProviders = names;
            execution.configuredTarget = configuredTarget;
            // Session creation accepts configuration. Node exposes no physical
            // placement observation; GPU and CPU graph partitioning may coexist.
            return execution;
        } catch (error) {
            attempt.status = 'failed';
            const record = describeError(error);
            attempt.error = record;
            if (finalAttempt) {
                // Preserve primitive and non-extensible provider failures while
                // adding SDK diagnostics without mutating the provider's value.
                throw Object.assign(new Error(record.message, {cause: record.cause}), record, {execution});
            }
            throw error;
        }
    }

    function hasBackend(name) {
        return execution.supportedBackends.some(
            function supportedBackend(backend) { return backend.name === name; }
        );
    }

    function physicalOptions(device) {
        let provider;
        if (device.kind === 'cpu' && device.deviceId === 'cpu') {
            provider = 'cpu';
        } else if (device.kind === 'gpu' && hasBackend('dml')
            && is.integer(device.addresses?.dxgiAdapterIndex) && device.addresses.dxgiAdapterIndex >= 0) {
            provider = {name: 'dml', deviceId: device.addresses.dxgiAdapterIndex};
        } else {
            throw targetFailure(
                'LOCAL_AI_EXECUTION_TARGET_UNSUPPORTED', 'provider-device-mapping-unavailable',
                'The installed ONNX binding cannot map this physical device to a supported execution provider.'
            );
        }
        if (!selectProviders) {
            const providers = supplied?.executionProviders;
            if (!is.array(providers) || providers.length === 0) {
                throw targetFailure(
                    'LOCAL_AI_EXECUTION_TARGET_CONFLICT', 'session-options-do-not-select-target',
                    'The explicit session options do not select the requested physical execution target.'
                );
            }
            const expectedName = providerName(provider);
            const primary = providers[0];
            const matches = providerName(primary) === expectedName
                && (expectedName === 'cpu' || (primary?.deviceId ?? 0) === provider.deviceId)
                && providers.every(
                    function compatibleProvider(value, index) { return index === 0 || providerName(value) === 'cpu'; }
                );
            if (!matches) {
                throw targetFailure(
                    'LOCAL_AI_EXECUTION_TARGET_CONFLICT', 'session-options-target-conflict',
                    'The explicit execution providers conflict with the physical target or have no established mapping to it.'
                );
            }
        }
        const selectedOptions = selectProviders ? {
            ...supplied,
            executionProviders: provider === 'cpu' ? ['cpu'] : [provider, 'cpu']
        } : {...supplied};
        if (providerName(provider) === 'dml') {
            if (selectedOptions.enableMemPattern === undefined) selectedOptions.enableMemPattern = false;
            if (selectedOptions.executionMode === undefined) selectedOptions.executionMode = 'sequential';
        }
        return selectedOptions;
    }

    const explicitDevice = request.executionTarget !== undefined && request.executionTarget !== null;
    if (explicitDevice && (execution.resolution !== 'matched' || !execution.resolvedDevice)) {
        throw targetFailure(
            execution.resolution === 'unsupported' ? 'LOCAL_AI_EXECUTION_TARGET_UNSUPPORTED' : 'LOCAL_AI_EXECUTION_TARGET_UNAVAILABLE',
            execution.reason ?? 'physical-device-unavailable',
            'The requested physical execution device could not be resolved.'
        );
    }
    if (request.executionTarget === null && !selectProviders
        && is.array(supplied?.executionProviders) && supplied.executionProviders.some(
            function fixedDevice(provider) { return !is.string(provider) && provider?.deviceId !== undefined; }
        )) {
        throw targetFailure(
            'LOCAL_AI_EXECUTION_TARGET_CONFLICT', 'automatic-target-fixed-session-device',
            'An automatic execution target conflicts with an explicit provider deviceId in session options.'
        );
    }
    if (explicitDevice && execution.resolvedDevice.kind === 'cpu') {
        return configure(physicalOptions(execution.resolvedDevice), 'execution-target');
    }
    if (!explicitDevice && (request.executionPreference !== 'gpu' || !selectProviders)) {
        return configure(options, selectProviders ? 'cpu-default' : 'session-options');
    }
    try {
        execution.supportedBackends = ort.listSupportedBackends();
    } catch (error) {
        execution.discoveryError = describeError(error);
        failures.push(error);
    }
    if (explicitDevice) {
        return configure(physicalOptions(execution.resolvedDevice), 'execution-target');
    }
    if (request.executionTarget === null && hasBackend('dml')) {
        const candidates = (request.deviceInventory?.devices ?? []).filter(
            function supportedPhysicalGPU(device) {
                return device.kind === 'gpu' && device.present === true && device.isHardware === true
                    && is.string(device.deviceId) && is.finite(device.dedicatedMemoryMiB)
                    && device.dedicatedMemoryMiB > 0 && is.integer(device.addresses?.dxgiAdapterIndex)
                    && device.addresses.dxgiAdapterIndex >= 0;
            }
        );
        candidates.sort(
            function largestDedicatedMemory(first, second) { return second.dedicatedMemoryMiB - first.dedicatedMemoryMiB; }
        );
        if (candidates.length) {
            execution.resolvedDevice = candidates[0];
            execution.reason = 'largest-supported-dedicated-memory-gpu';
            return configure(physicalOptions(execution.resolvedDevice), 'automatic-physical-target');
        }
    }
    // The inventory advertises compiled support. `bundled` describes packaging,
    // not whether an installed provider library or physical device can load.
    const candidates = ['cuda', 'tensorrt', 'dml', 'coreml', 'webgpu'].filter(
        function advertisedProvider(name) {
            return hasBackend(name);
        }
    );
    candidates.push('cpu');
    for (const provider of candidates) {
        const executionProviders = provider === 'cpu' ? ['cpu'] : [provider, 'cpu'];
        const selectedOptions = {...supplied, executionProviders};
        if (provider === 'dml') {
            // DirectML requires these session settings. Explicit caller values
            // remain exact and can produce the native provider's own error.
            if (selectedOptions.enableMemPattern === undefined) selectedOptions.enableMemPattern = false;
            if (selectedOptions.executionMode === undefined) selectedOptions.executionMode = 'sequential';
        }
        execution.fallback = provider === 'cpu';
        try {
            // Keep intermediate native errors untouched: a provider may reuse
            // one Error object for multiple attempts. The final failure owns
            // the execution record after every attempt has been described.
            return await configure(selectedOptions, 'gpu-preference', false);
        } catch (error) {
            failures.push(error);
        }
    }
    const error = new AggregateError(failures, 'ONNX accelerator session creation and CPU fallback failed.');
    error.execution = execution;
    throw error;
}

function tensorMap(records,inputs=false){
    return Object.fromEntries(Object.entries(records).map(function createTensor([name,record]){
        // ORT Node 1.30.0 supplies string feeds to FillStringTensor through
        // null-terminated strings, so this exact content cannot be preserved.
        if(inputs&&record?.type==='string'&&is.array(record.data)
            &&record.data.some(function embeddedNull(value){return is.string(value)&&value.includes('\0');})){
            const error=new Error(`ONNX Runtime Node cannot preserve embedded U+0000 in string tensor input "${name}".`);
            error.code='LOCAL_AI_ONNX_STRING_INPUT_UNSUPPORTED';
            throw error;
        }
        return [name,record===null?null:new ort.Tensor(record.type,record.data,record.dims)];
    }));
}

async function handleRequest(request){
    try{
        let result;
        if(request.operation==='load'){
            const execution = await createSession(request);
            result={
                inputNames:session.inputNames,
                outputNames:session.outputNames,
                inputMetadata:session.inputMetadata,
                outputMetadata:session.outputMetadata
            };
            if (execution) result.execution = execution;
        }else if(request.operation==='run'){
            const feeds=tensorMap(request.feeds,true);
            const fetches=request.fetches===undefined||request.fetches===null||is.array(request.fetches)
                ?request.fetches:tensorMap(request.fetches);
            // ORT treats an empty fetch map as its options overload and would
            // ignore the third argument. Both forms select every output.
            const allOutputs=fetches===undefined
                ||(fetches!==null&&!is.array(fetches)&&Object.keys(fetches).length===0);
            const outputs=allOutputs
                ?await session.run(feeds,request.runOptions)
                :await session.run(feeds,fetches,request.runOptions);
            result=Object.fromEntries(Object.entries(outputs).map(function tensorRecord([name,tensor]){
                return [name,{type:tensor.type,data:tensor.data,dims:tensor.dims}];
            }));
        }else if(request.operation==='unload'){
            await session?.release();
            session=undefined;
        }else{
            throw new Error(`Unknown ONNX worker operation: ${String(request.operation)}.`);
        }
        // Structured cloning retains typed tensors and BigInt without taking
        // ownership of the caller's buffers or converting their contents.
        parentPort.postMessage({requestId:request.requestId,operation:request.operation,result});
    }catch(error){
        parentPort.postMessage({requestId:request.requestId,operation:request.operation,error:describeError(error)});
    }finally{
        if(request.operation==='unload')parentPort.close();
    }
}

parentPort.on('message',function receiveRequest(request){
    // The session owner dispatches one operation at a time. Native ORT work
    // runs synchronously inside this worker, never on the caller's thread.
    void handleRequest(request).catch(function reportWorkerFailure(error){
        setImmediate(function throwWorkerFailure(){throw error;});
    });
});

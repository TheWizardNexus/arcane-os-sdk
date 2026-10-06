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
    if (request.executionPreference !== 'gpu' || !selectProviders) {
        session = await ort.InferenceSession.create(request.model, options);
        return undefined;
    }

    const execution = {
        preference: 'gpu',
        supportedBackends: [],
        selectedProviders: [],
        attempts: [],
        fallback: false,
        discoveryError: null
    };
    const failures = [];
    try {
        execution.supportedBackends = ort.listSupportedBackends();
    } catch (error) {
        execution.discoveryError = describeError(error);
        failures.push(error);
    }
    // The inventory advertises compiled support. `bundled` describes packaging,
    // not whether an installed provider library or physical device can load.
    const candidates = ['cuda', 'tensorrt', 'dml', 'coreml', 'webgpu'].filter(
        function advertisedProvider(name) {
            return execution.supportedBackends.some(
                function supportedBackend(backend) { return backend.name === name; }
            );
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
        const attempt = {executionProviders, status: 'loading', error: null};
        execution.attempts.push(attempt);
        execution.fallback = provider === 'cpu';
        try {
            session = await ort.InferenceSession.create(request.model, selectedOptions);
            attempt.status = 'configured';
            execution.selectedProviders = executionProviders;
            // Successful creation proves this session configuration was accepted.
            // ORT can assign graph nodes to CPU; it does not prove GPU execution.
            return execution;
        } catch (error) {
            attempt.status = 'failed';
            attempt.error = describeError(error);
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

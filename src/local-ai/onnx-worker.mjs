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
            const supplied=request.sessionOptions;
            const options=supplied===undefined
                ?{executionProviders:['cpu']}
                :supplied!==null&&is.object(supplied)&&supplied.executionProviders===undefined
                    ?{...supplied,executionProviders:['cpu']}
                    :supplied;
            session=await ort.InferenceSession.create(request.model,options);
            result={
                inputNames:session.inputNames,
                outputNames:session.outputNames,
                inputMetadata:session.inputMetadata,
                outputMetadata:session.outputMetadata
            };
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

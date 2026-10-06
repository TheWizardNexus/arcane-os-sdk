export const CORE_PROTOCOL='arcane/1';
export const CORE_READY_EVENTS=['transport.ready','core.ready'];

/** Wire descriptions, not method admission or application policy. */
export const CORE_FRAME_CONTRACTS={
    request:{type:'request',fields:['protocol','type','id','method','parameters','sentAt']},
    response:{type:'response',fields:['protocol','type','id','ok'],success:['result'],failure:['error'],optional:['time']},
    event:{type:'event',fields:['protocol','type','event','data'],optional:['time','requestId']},
    cancel:{type:'control',control:'request.cancel',fields:['protocol','type','control','requestId']},
    cancelAll:{type:'control',control:'requests.cancelAll',fields:['protocol','type','control']},
    replay:{type:'control',control:'runtime.replay',fields:['protocol','type','control']}
};

/** These names describe existing methods; installed services determine availability. */
export const CORE_METHOD_CONTRACTS={
    'system.ping':{input:'empty-object-v1',output:'system-ping-result-v1',meaning:'Dispatcher response, not application or model readiness.'},
    'version.current':{input:'empty-object-v1',output:'version-string-v1',meaning:'Active host release version.'},
    'app.current':{input:'empty-object-v1',output:'application-descriptor-v1'},
    'capabilities.list':{input:'empty-object',output:'{app,grants,methods}'},
    'platform.status':{input:'empty-object-v1',output:'platform-status-v1'},
    'network.status':{input:'empty-object-v1',output:'network-status-v1',meaning:'A non-loopback interface is present; this is not proof of Internet reachability.'},
    'apps.list':{input:'empty-object-v1',output:'application-catalog-v1'},
    'apps.launch':{input:'application-launch-v1',output:'application-launch-result-v1',meaning:'Host acceptance, not application readiness.'},
    'external.open':{input:'external-open-v1',output:'external-open-result-v1',meaning:'Host acceptance, not confirmation of a user action.'},
    'filesystem.directory.select':{input:'directory-selection-options',output:'directory-selection-result'},
    'storage.list':{input:'empty-object',output:'{keys}'},
    'storage.get':{input:'{key}',output:'{key,found,value}'},
    'storage.set':{input:'{key,value}',output:'{key,value}'},
    'storage.delete':{input:'{key}',output:'{key,deleted}'},
    'preferences.list':{input:'empty-object',output:'{keys}'},
    'preferences.get':{input:'{key}',output:'{key,found,value}'},
    'preferences.set':{input:'{key,value}',output:'{key,value}'},
    'preferences.setMany':{input:'{entries}',output:'preference-batch-result'},
    'preferences.delete':{input:'{key}',output:'{key,deleted}'},
    'window.setTheme': {
        input: '{backgroundColor?,textColor?}: null reset or {red,green,blue,alpha}',
        output: '{platform,supported,applied,unsupported}',
        meaning: 'Current host window only. Omitted colors stay unchanged; applied records platform-accepted values, not measured pixels or an atomic operation.'
    },
    'terminal.start':{input:'terminal-start-v1',output:'terminal-session-v1'},
    'terminal.list':{input:'empty-object-v1',output:'terminal-list-v1'},
    'terminal.write':{input:'terminal-write-v1',output:'terminal-write-result-v1'},
    'terminal.resize':{input:'terminal-resize-v1',output:'terminal-resize-result-v1'},
    'terminal.signal':{input:'terminal-signal-v1',output:'terminal-signal-result-v1'},
    'terminal.close':{input:'terminal-session-id-v1',output:'terminal-close-result-v1'},
    'environment.list':{input:'empty-object-v1',output:'environment-list-result-v1'},
    'environment.get':{input:'environment-name-v1',output:'environment-get-result-v1'},
    'environment.set':{input:'environment-set-v1',output:'environment-set-result-v1'},
    'environment.delete':{input:'environment-name-v1',output:'environment-delete-result-v1'},
    'mail.send':{input:'mail-send-v1',output:'mail-send-result-v1'},
    'user.current':{input:'empty-object-v1',output:'user-identity-v1'}
};

export class CoreError extends Error{
    constructor(value){
        const source=value!==null&&typeof value==='object'
            ?value
            :{message:value===undefined?'Arcane operation failed.':String(value)};
        super(source.message??source.userMessage??'Arcane operation failed.');
        for(const key of Object.getOwnPropertyNames(source))this[key]=source[key];
        this.name=source.name??'ArcaneError';
        this.code=source.code??'ARCANE_ERROR';
        this.resolution=source.resolution??null;
        this.diagnosticId=source.diagnosticId??null;
        this.technicalMessage=source.technicalMessage??source.message??null;
        const hresult=String(source.message??'').match(/\b0x[0-9a-f]{8}\b/iu);
        this.hresult=source.hresult??hresult?.[0]?.toUpperCase()??null;
        this.causeName=source.causeName??(source.name&&source.name!=='ArcaneError'?source.name:null);
        if(source.stack!==undefined)this.stack=source.stack;
        if(source.cause!==undefined)this.cause=source.cause;
    }
}

export function serializeCoreError(error){
    if(error===null||typeof error!=='object'){
        return {name:'Error',code:'ARCANE_ERROR',message:String(error)};
    }
    const record=Object.fromEntries(Object.getOwnPropertyNames(error).map(key=>[key,error[key]]));
    for(const key of ['name','message','stack','cause']){
        if(error[key]!==undefined)record[key]=key==='cause'&&error[key] instanceof Error
            ?serializeCoreError(error[key]):error[key];
    }
    if(Array.isArray(error.errors)){
        record.errors=error.errors.map(value=>value instanceof Error?serializeCoreError(value):value);
    }
    if(record.name===undefined)record.name='Error';
    if(record.code===undefined)record.code='ARCANE_ERROR';
    if(record.message===undefined)record.message='Arcane operation failed.';
    return record;
}

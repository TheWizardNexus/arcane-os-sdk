const componentWaitErrorCodes={
    abortSignalInvalid:'ARCANE_COMPONENT_READINESS_ABORT_SIGNAL_INVALID',
    elementRequired:'ARCANE_COMPONENT_READINESS_ELEMENT_REQUIRED',
    errorEventReported:'ARCANE_COMPONENT_READINESS_ERROR_EVENT_REPORTED',
    errorEventInspectionFailed:'ARCANE_COMPONENT_READINESS_ERROR_EVENT_INSPECTION_FAILED',
    listenerCleanupFailed:'ARCANE_COMPONENT_READINESS_LISTENER_CLEANUP_FAILED',
    listenerInstallationFailed:'ARCANE_COMPONENT_READINESS_LISTENER_INSTALLATION_FAILED',
    listenerTargetInvalid:'ARCANE_COMPONENT_READINESS_LISTENER_TARGET_INVALID',
    readinessEventRequired:'ARCANE_COMPONENT_READINESS_EVENT_REQUIRED',
    stateInspectionFailed:'ARCANE_COMPONENT_READINESS_STATE_INSPECTION_FAILED',
    timeoutInstallationFailed:'ARCANE_COMPONENT_READINESS_TIMEOUT_INSTALLATION_FAILED',
    waitAborted:'ARCANE_COMPONENT_READINESS_WAIT_ABORTED',
    waitOptionsInvalid:'ARCANE_COMPONENT_READINESS_WAIT_OPTIONS_INVALID',
    waitTimedOut:'COMPONENT_READY_TIMEOUT'
};

const componentWaitReasons={
    abortSignalInvalid:'component-readiness-abort-signal-invalid',
    elementMissing:'component-readiness-element-missing',
    errorEventReported:'component-readiness-error-event-reported',
    errorEventInspectionFailed:'component-readiness-error-event-inspection-threw',
    listenerCleanupFailed:'component-readiness-listener-cleanup-rejected',
    listenerInstallationFailed:'component-readiness-listener-installation-rejected',
    listenerTargetInvalid:'component-readiness-listener-target-invalid',
    readinessEventMissing:'component-readiness-event-missing',
    stateInspectionFailed:'component-readiness-state-inspection-threw',
    timeoutInstallationFailed:'component-readiness-timeout-installation-rejected',
    waitAborted:'component-readiness-wait-aborted',
    waitOptionsInvalid:'component-readiness-wait-options-invalid',
    waitTimedOut:'component-readiness-wait-timed-out'
};

export const COMPONENT_WAIT_ERROR_CODES={...componentWaitErrorCodes};
export const COMPONENT_WAIT_REASONS={...componentWaitReasons};

function defineComponentWaitError(error,code,reason,cause){
    const priorCode=typeof error?.code==='string'&&error.code
        ?error.code
        :null;
    try{
        if(priorCode&&priorCode!==code&&!Object.hasOwn(error,'causeCode')){
            Object.defineProperty(
                error,
                'causeCode',
                {value:priorCode,enumerable:false,configurable:true,writable:true}
            );
        }
        Object.defineProperty(
            error,
            'code',
            {value:code,enumerable:false,configurable:true,writable:true}
        );
        Object.defineProperty(
            error,
            'reason',
            {value:reason,enumerable:false,configurable:true,writable:true}
        );
        if(cause!==undefined&&cause!==error&&!('cause' in error)){
            Object.defineProperty(
                error,
                'cause',
                {value:cause,enumerable:false,configurable:true,writable:true}
            );
        }
        return error;
    }catch{
        const replacement=new Error(error?.message||'Component readiness wait failed.');
        replacement.name=error?.name||'Error';
        replacement.code=code;
        replacement.reason=reason;
        if(priorCode&&priorCode!==code){
            replacement.causeCode=priorCode;
        }
        replacement.cause=cause===undefined?error:cause;
        return replacement;
    }
}

function componentWaitError(message,code,reason,ErrorClass=Error,cause){
    return defineComponentWaitError(
        new ErrorClass(message),
        code,
        reason,
        cause
    );
}

function componentWaitAbortError(reason){
    const ownsError=!(reason instanceof Error&&reason.name==='AbortError');
    const error=ownsError
        ?new Error('Component readiness wait was aborted.')
        :reason;
    if(ownsError){
        error.name='AbortError';
    }
    return defineComponentWaitError(
        error,
        componentWaitErrorCodes.waitAborted,
        componentWaitReasons.waitAborted,
        reason
    );
}

function waitForComponent(element,options={}){
    if(!options||typeof options!=='object'||Array.isArray(options)){
        return Promise.reject(
            componentWaitError(
                'Component readiness wait options must be an object.',
                componentWaitErrorCodes.waitOptionsInvalid,
                componentWaitReasons.waitOptionsInvalid,
                TypeError
            )
        );
    }
    const {
        errorEvent='',
        methods=[],
        property='',
        event='',
        signal=null,
        timeoutMs=0
    }=options;

    if(typeof errorEvent!=='string'
        ||!Array.isArray(methods)
        ||methods.some(function invalidComponentMethod(method){
            return typeof method!=='string'||method.trim().length<1;
        })
        ||typeof property!=='string'
        ||typeof event!=='string'){
        return Promise.reject(
            componentWaitError(
                'Component readiness event, errorEvent, property, and methods options are invalid.',
                componentWaitErrorCodes.waitOptionsInvalid,
                componentWaitReasons.waitOptionsInvalid,
                TypeError
            )
        );
    }
    if(!Number.isFinite(timeoutMs)||timeoutMs<0){
        return Promise.reject(
            componentWaitError(
                'timeoutMs must be a non-negative finite number.',
                componentWaitErrorCodes.waitOptionsInvalid,
                componentWaitReasons.waitOptionsInvalid,
                RangeError
            )
        );
    }
    if(signal!==null
        &&(
            typeof signal!=='object'
            ||typeof signal.aborted!=='boolean'
            ||typeof signal.addEventListener!=='function'
            ||typeof signal.removeEventListener!=='function'
        )){
        return Promise.reject(
            componentWaitError(
                'signal must be an AbortSignal.',
                componentWaitErrorCodes.abortSignalInvalid,
                componentWaitReasons.abortSignalInvalid,
                TypeError
            )
        );
    }

    return new Promise(
        function waitForComponentPromise(resolve,reject){
            let abortListenerInstalled=false;
            let errorListenerInstalled=false;
            let eventListenerInstalled=false;
            let timeout=null;
            let settled=false;

            function cleanup(){
                let cleanupError=null;
                if(eventListenerInstalled){
                    try{
                        element.removeEventListener(event,eventHandler);
                    }catch(error){
                        cleanupError=error;
                    }
                    eventListenerInstalled=false;
                }
                if(errorListenerInstalled){
                    try{
                        element.removeEventListener(errorEvent,errorHandler);
                    }catch(error){
                        cleanupError??=error;
                    }
                    errorListenerInstalled=false;
                }
                if(timeout!==null){
                    clearTimeout(timeout);
                    timeout=null;
                }
                if(abortListenerInstalled){
                    try{
                        signal.removeEventListener('abort',abortWait);
                    }catch(error){
                        cleanupError??=error;
                    }
                    abortListenerInstalled=false;
                }
                return cleanupError;
            }

            function isReady(){
                if(property&&element[property]!==true){
                    return false;
                }

                return methods.every(function componentMethodAvailable(method){
                    return typeof element[method]==='function';
                });
            }

            function complete(){
                if(settled){
                    return;
                }
                settled=true;
                const cleanupError=cleanup();
                if(cleanupError){
                    reject(
                        componentWaitError(
                            'Component readiness listener cleanup failed.',
                            componentWaitErrorCodes.listenerCleanupFailed,
                            componentWaitReasons.listenerCleanupFailed,
                            Error,
                            cleanupError
                        )
                    );
                    return;
                }
                resolve(element);
            }

            function fail(error){
                if(settled){
                    return;
                }
                settled=true;
                const cleanupError=cleanup();
                if(cleanupError){
                    try{
                        Object.defineProperty(
                            error,
                            'cleanupError',
                            {
                                value:cleanupError,
                                enumerable:false,
                                configurable:true,
                                writable:true
                            }
                        );
                    }catch{}
                }
                reject(error);
            }

            function abortWait(){
                fail(componentWaitAbortError(signal?.reason));
            }

            function check(){
                try{
                    if(isReady()){
                        complete();
                        return true;
                    }
                    return false;
                }catch(error){
                    fail(
                        componentWaitError(
                            'Component readiness state inspection failed.',
                            componentWaitErrorCodes.stateInspectionFailed,
                            componentWaitReasons.stateInspectionFailed,
                            Error,
                            error
                        )
                    );
                    return false;
                }
            }

            function eventHandler(){
                check();
            }

            function errorHandler(errorEventObject){
                try{
                    const detail=errorEventObject?.detail;
                    const error=new Error(
                        detail?.message||'The component reported a loading error.'
                    );
                    const componentCode=typeof detail?.code==='string'
                        &&detail.code.trim()
                        ?detail.code
                        :null;
                    if(componentCode){
                        error.componentCode=componentCode;
                    }
                    fail(
                        defineComponentWaitError(
                            error,
                            componentWaitErrorCodes.errorEventReported,
                            componentWaitReasons.errorEventReported,
                            detail?.error
                        )
                    );
                }catch(error){
                    fail(
                        componentWaitError(
                            'Component readiness error-event inspection failed.',
                            componentWaitErrorCodes.errorEventInspectionFailed,
                            componentWaitReasons.errorEventInspectionFailed,
                            Error,
                            error
                        )
                    );
                }
            }

            if(!element){
                fail(
                    componentWaitError(
                        'Component element is required.',
                        componentWaitErrorCodes.elementRequired,
                        componentWaitReasons.elementMissing,
                        TypeError
                    )
                );
                return;
            }
            if((event||errorEvent)
                &&(
                    typeof element.addEventListener!=='function'
                    ||typeof element.removeEventListener!=='function'
                )){
                fail(
                    componentWaitError(
                        'The component readiness listener target must provide addEventListener() and removeEventListener().',
                        componentWaitErrorCodes.listenerTargetInvalid,
                        componentWaitReasons.listenerTargetInvalid,
                        TypeError
                    )
                );
                return;
            }
            if(signal?.aborted){
                abortWait();
                return;
            }

            if(signal){
                abortListenerInstalled=true;
                try{
                    signal.addEventListener('abort',abortWait,{once:true});
                }catch(error){
                    fail(
                        componentWaitError(
                            'Component readiness abort-listener installation failed.',
                            componentWaitErrorCodes.listenerInstallationFailed,
                            componentWaitReasons.listenerInstallationFailed,
                            Error,
                            error
                        )
                    );
                    return;
                }
                if(settled){
                    return;
                }
            }

            if(event){
                try{
                    element.addEventListener(event,eventHandler);
                    eventListenerInstalled=true;
                }catch(error){
                    fail(
                        componentWaitError(
                            'Component readiness listener installation failed.',
                            componentWaitErrorCodes.listenerInstallationFailed,
                            componentWaitReasons.listenerInstallationFailed,
                            Error,
                            error
                        )
                    );
                    return;
                }
            }else if(!check()){
                if(settled){
                    return;
                }
                fail(
                    componentWaitError(
                        'A component readiness event is required.',
                        componentWaitErrorCodes.readinessEventRequired,
                        componentWaitReasons.readinessEventMissing
                    )
                );
                return;
            }
            if(settled){
                return;
            }

            if(errorEvent){
                try{
                    element.addEventListener(errorEvent,errorHandler);
                    errorListenerInstalled=true;
                }catch(error){
                    fail(
                        componentWaitError(
                            'Component readiness error-listener installation failed.',
                            componentWaitErrorCodes.listenerInstallationFailed,
                            componentWaitReasons.listenerInstallationFailed,
                            Error,
                            error
                        )
                    );
                    return;
                }
            }
            if(timeoutMs>0){
                try{
                    timeout=setTimeout(function failComponentReadinessTimeout(){
                        fail(
                            componentWaitError(
                                `Component readiness timed out after ${timeoutMs} ms.`,
                                componentWaitErrorCodes.waitTimedOut,
                                componentWaitReasons.waitTimedOut
                            )
                        );
                    },timeoutMs);
                }catch(error){
                    fail(
                        componentWaitError(
                            'Component readiness timeout installation failed.',
                            componentWaitErrorCodes.timeoutInstallationFailed,
                            componentWaitReasons.timeoutInstallationFailed,
                            Error,
                            error
                        )
                    );
                    return;
                }
            }

            check();
        }
    );
}

export default waitForComponent;

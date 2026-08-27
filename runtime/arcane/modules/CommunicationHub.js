import {createArcaneEventSource} from 'arcane-os/event-manager';
import CommunicationMessage from '../entities/CommunicationMessage.js';
import CommunicationThread from '../entities/CommunicationThread.js';
import CommunicationProviderRegistry from './CommunicationProviderRegistry.js?v=2';

export const COMMUNICATION_HUB_EVENTS=Object.freeze({
    refreshCancelled:'communications-refresh-cancelled',
    refreshCompleted:'communications-refresh-completed',
    refreshFailed:'communications-refresh-failed',
    refreshLegacy:'communications-refresh',
    refreshPartiallyCompleted:'communications-refresh-partially-completed',
    refreshStarted:'communications-refresh-started'
});

export const COMMUNICATION_HUB_REFRESH_STATES=Object.freeze({
    cancelled:'refresh-cancelled',
    completed:'refresh-completed',
    failed:'refresh-failed',
    partiallyCompleted:'refresh-partially-completed',
    started:'refresh-started'
});

export const COMMUNICATION_HUB_REFRESH_REASONS=Object.freeze({
    allProviderThreadListsRejected:'all-provider-thread-lists-rejected',
    boundaryThrew:'refresh-boundary-threw',
    hubDisposed:'hub-disposed',
    providerThreadListRejected:'provider-thread-list-rejected',
    signalAborted:'refresh-signal-aborted',
    startCancelled:'refresh-start-cancelled',
    superseded:'refresh-superseded'
});

export const COMMUNICATION_HUB_ERROR_CODES=Object.freeze({
    allProviderThreadListsRejected:'ARCANE_COMMUNICATION_PROVIDER_THREAD_LISTS_REJECTED',
    disposed:'ARCANE_COMMUNICATION_HUB_DISPOSED',
    providerThreadListRejected:'ARCANE_COMMUNICATION_PROVIDER_THREAD_LIST_REJECTED',
    refreshAborted:'ARCANE_COMMUNICATION_HUB_REFRESH_ABORTED',
    refreshFailed:'ARCANE_COMMUNICATION_HUB_REFRESH_FAILED',
    refreshOptionsInvalid:'ARCANE_COMMUNICATION_HUB_REFRESH_OPTIONS_INVALID',
    refreshSuperseded:'ARCANE_COMMUNICATION_HUB_REFRESH_SUPERSEDED'
});

function codedError(message,code,{cause,name='Error',ErrorType=Error}={}){
    const error=new ErrorType(message);
    error.name=name;
    error.code=code;
    if(cause!==undefined){
        error.cause=cause;
    }
    return error;
}

function disposedError(){
    return codedError(
        'The communication hub has been disposed.',
        COMMUNICATION_HUB_ERROR_CODES.disposed
    );
}

function refreshAbortError(reason,code=COMMUNICATION_HUB_ERROR_CODES.refreshAborted){
    if(reason instanceof Error&&reason.name==='AbortError'&&reason.code===code){
        return reason;
    }
    return codedError(
        code===COMMUNICATION_HUB_ERROR_CODES.refreshSuperseded
            ?'The communication refresh was superseded by a newer refresh.'
            :'The communication refresh was aborted.',
        code,
        {
            cause:reason,
            name:'AbortError'
        }
    );
}

function refreshFailureError(error){
    if(error instanceof Error&&error.code===COMMUNICATION_HUB_ERROR_CODES.refreshFailed){
        return error;
    }
    return codedError(
        'The communication refresh boundary failed.',
        COMMUNICATION_HUB_ERROR_CODES.refreshFailed,
        {cause:error}
    );
}

function isAbortSignal(value){
    return Boolean(value)
        &&typeof value==='object'
        &&typeof value.aborted==='boolean'
        &&typeof value.addEventListener==='function'
        &&typeof value.removeEventListener==='function';
}

function normalizeRefreshOptions(value){
    if(value===undefined){
        return Object.freeze({signal:null});
    }
    if(!value||typeof value!=='object'||Array.isArray(value)){
        throw codedError(
            'Communication refresh options must be a plain record.',
            COMMUNICATION_HUB_ERROR_CODES.refreshOptionsInvalid,
            {ErrorType:TypeError}
        );
    }
    const descriptors=Object.getOwnPropertyDescriptors(value);
    const unknown=Reflect.ownKeys(descriptors).find(
        function findUnknownRefreshOption(key){
            return key!=='signal';
        }
    );
    if(unknown!==undefined||Object.values(descriptors).some(
        function findRefreshOptionAccessor(descriptor){
            return !Object.hasOwn(descriptor,'value');
        }
    )){
        throw codedError(
            'Communication refresh options may contain only a data signal property.',
            COMMUNICATION_HUB_ERROR_CODES.refreshOptionsInvalid,
            {ErrorType:TypeError}
        );
    }
    const signal=descriptors.signal?.value??null;
    if(signal!==null&&!isAbortSignal(signal)){
        throw codedError(
            'Communication refresh signal must be an AbortSignal.',
            COMMUNICATION_HUB_ERROR_CODES.refreshOptionsInvalid,
            {ErrorType:TypeError}
        );
    }
    return Object.freeze({signal});
}

function normalizeProviderThreads(provider,values){
    if(!Array.isArray(values)){
        throw new TypeError(`Communication provider ${provider.id} must return a thread array.`);
    }
    return values.map(function normalizeProviderThread(value){
        return value instanceof CommunicationThread
            ?value
            :new CommunicationThread(
                {
                    ...value,
                    providerId:provider.id
                }
            );
    });
}

function compareThreadsByUpdatedAt(left,right){
    return right.updatedAt.localeCompare(left.updatedAt);
}

function providerFailure(provider){
    return Object.freeze({
        code:COMMUNICATION_HUB_ERROR_CODES.providerThreadListRejected,
        providerId:provider.id,
        reason:COMMUNICATION_HUB_REFRESH_REASONS.providerThreadListRejected
    });
}

function settleWithAbort(operation,promise){
    const signal=operation.controller.signal;
    if(signal.aborted){
        return Promise.reject(signal.reason);
    }
    return new Promise(function settleCommunicationRefresh(resolve,reject){
        let settled=false;

        function cleanup(){
            signal.removeEventListener('abort',abortRefreshSettlement);
        }

        function resolveRefreshSettlement(value){
            if(settled){
                return;
            }
            settled=true;
            cleanup();
            resolve(value);
        }

        function rejectRefreshSettlement(error){
            if(settled){
                return;
            }
            settled=true;
            cleanup();
            reject(error);
        }

        function abortRefreshSettlement(){
            rejectRefreshSettlement(signal.reason);
        }

        signal.addEventListener('abort',abortRefreshSettlement,{once:true});
        promise.then(resolveRefreshSettlement,rejectRefreshSettlement);
    });
}

export default class CommunicationHub extends EventTarget{
    #disposed=false;
    #events;
    #operationSequence=0;
    #refreshOperation=null;

    constructor({providers=[],enabledProviderIds=[]}={}){
        super();
        this.registry=providers instanceof CommunicationProviderRegistry
            ?providers
            :new CommunicationProviderRegistry(providers);
        this.enabled=new Set(enabledProviderIds);
        this.threads=[];
        this.#events=createArcaneEventSource(
            this,
            {
                source:'communication-hub',
                eventTypes:Object.freeze(Object.values(COMMUNICATION_HUB_EVENTS))
            }
        );
    }

    addEventListener(type,listener,options){
        return this.#events.addEventListener(type,listener,options);
    }

    removeEventListener(type,listener,options){
        return this.#events.removeEventListener(type,listener,options);
    }

    on(type,listener,options){
        return this.#events.on(type,listener,options);
    }

    dispatchEvent(value){
        return this.#events.dispatchEvent(value);
    }

    #assertOpen(){
        if(this.#disposed){
            throw disposedError();
        }
    }

    #operationId(){
        this.#operationSequence+=1;
        return `${this.#events.instanceId}:refresh:${this.#operationSequence.toString(36)}`;
    }

    #clearRefreshOperation(operation){
        operation.signal?.removeEventListener('abort',operation.abortFromSignal);
        if(this.#refreshOperation===operation){
            this.#refreshOperation=null;
        }
    }

    #publishCancellation(operation,error,reason){
        if(operation.terminal){
            return false;
        }
        operation.terminal=true;
        operation.error=error;
        this.#clearRefreshOperation(operation);
        operation.controller.abort(error);
        if(!this.#events.disposed){
            this.#events.dispatch(
                COMMUNICATION_HUB_EVENTS.refreshCancelled,
                Object.freeze({error,reason}),
                {
                    operationId:operation.operationId,
                    publicDetail:Object.freeze({
                        code:error.code,
                        reason,
                        state:COMMUNICATION_HUB_REFRESH_STATES.cancelled
                    })
                }
            );
        }
        return true;
    }

    #cancelActiveRefresh(error,reason){
        const operation=this.#refreshOperation;
        if(!operation){
            return false;
        }
        return this.#publishCancellation(operation,error,reason);
    }

    setEnabled(ids=[]){
        this.#assertOpen();
        this.enabled=new Set(Array.from(ids,String));
        return this;
    }

    enabledProviders(){
        this.#assertOpen();
        return this.registry.list().filter(
            function selectEnabledCommunicationProvider(provider){
                return this.enabled.has(provider.id);
            },
            this
        );
    }

    async refresh(options={}){
        this.#assertOpen();
        const settings=normalizeRefreshOptions(options);
        if(settings.signal?.aborted){
            throw refreshAbortError(settings.signal.reason);
        }
        this.#cancelActiveRefresh(
            refreshAbortError(
                undefined,
                COMMUNICATION_HUB_ERROR_CODES.refreshSuperseded
            ),
            COMMUNICATION_HUB_REFRESH_REASONS.superseded
        );

        const providers=this.enabledProviders();
        const controller=new AbortController();
        const operation={
            abortFromSignal:null,
            controller,
            error:null,
            operationId:this.#operationId(),
            signal:settings.signal,
            terminal:false
        };
        operation.abortFromSignal=function abortCommunicationRefreshFromSignal(){
            this.#publishCancellation(
                operation,
                refreshAbortError(settings.signal.reason),
                COMMUNICATION_HUB_REFRESH_REASONS.signalAborted
            );
        }.bind(this);
        settings.signal?.addEventListener(
            'abort',
            operation.abortFromSignal,
            {once:true}
        );
        this.#refreshOperation=operation;

        const providerIds=Object.freeze(providers.map(
            function communicationProviderId(provider){
                return provider.id;
            }
        ));
        const startPublication=this.#events.dispatch(
            COMMUNICATION_HUB_EVENTS.refreshStarted,
            Object.freeze({providerIds}),
            {
                cancelable:true,
                operationId:operation.operationId,
                publicDetail:Object.freeze({
                    providerCount:providerIds.length,
                    providerIds,
                    state:COMMUNICATION_HUB_REFRESH_STATES.started
                })
            }
        );
        if(operation.terminal){
            throw operation.error;
        }
        if(!startPublication.accepted){
            const error=refreshAbortError();
            this.#publishCancellation(
                operation,
                error,
                COMMUNICATION_HUB_REFRESH_REASONS.startCancelled
            );
            throw error;
        }
        this.#assertOpen();
        if(this.#refreshOperation!==operation){
            throw operation.error??refreshAbortError(
                undefined,
                COMMUNICATION_HUB_ERROR_CODES.refreshSuperseded
            );
        }

        const providerOperations=providers.map(
            function startCommunicationProviderRefresh(provider){
                return Promise.resolve().then(
                    function requestProviderThreads(){
                        if(controller.signal.aborted){
                            throw controller.signal.reason;
                        }
                        return provider.listThreads(
                            {
                                operationId:operation.operationId,
                                signal:controller.signal
                            }
                        );
                    }
                ).then(
                    function normalizeCommunicationProviderThreads(values){
                        return normalizeProviderThreads(provider,values);
                    }
                );
            }
        );
        const providerSettlements=Promise.allSettled(providerOperations);

        try{
            const results=await settleWithAbort(operation,providerSettlements);
            if(controller.signal.aborted){
                throw controller.signal.reason;
            }
            this.#assertOpen();
            if(this.#refreshOperation!==operation){
                throw operation.error??refreshAbortError(
                    undefined,
                    COMMUNICATION_HUB_ERROR_CODES.refreshSuperseded
                );
            }

            const errors=[];
            const failures=[];
            const threads=[];
            for(let index=0;index<results.length;index+=1){
                const result=results[index];
                if(result.status==='fulfilled'){
                    threads.push(...result.value);
                }else{
                    errors.push(result.reason);
                    failures.push(providerFailure(providers[index]));
                }
            }
            threads.sort(compareThreadsByUpdatedAt);
            if(controller.signal.aborted){
                throw controller.signal.reason;
            }
            this.#assertOpen();
            if(this.#refreshOperation!==operation){
                throw operation.error??refreshAbortError(
                    undefined,
                    COMMUNICATION_HUB_ERROR_CODES.refreshSuperseded
                );
            }

            this.threads=threads;
            const returnedThreads=[...this.threads];
            const returnedErrors=[...errors];
            const frozenFailures=Object.freeze([...failures]);
            const allProvidersRejected=providers.length>0
                &&failures.length===providers.length;
            const state=allProvidersRejected
                ?COMMUNICATION_HUB_REFRESH_STATES.failed
                :failures.length
                    ?COMMUNICATION_HUB_REFRESH_STATES.partiallyCompleted
                    :COMMUNICATION_HUB_REFRESH_STATES.completed;
            const terminalType=allProvidersRejected
                ?COMMUNICATION_HUB_EVENTS.refreshFailed
                :failures.length
                    ?COMMUNICATION_HUB_EVENTS.refreshPartiallyCompleted
                    :COMMUNICATION_HUB_EVENTS.refreshCompleted;
            const compatibilityDetail=Object.freeze({
                errors:Object.freeze([...returnedErrors]),
                failures:frozenFailures,
                state,
                threads:Object.freeze([...returnedThreads])
            });
            const publicDetail=Object.freeze({
                ...(allProvidersRejected
                    ?{
                        code:COMMUNICATION_HUB_ERROR_CODES.allProviderThreadListsRejected,
                        reason:COMMUNICATION_HUB_REFRESH_REASONS.allProviderThreadListsRejected
                    }
                    :{}),
                failureCount:failures.length,
                failures:frozenFailures,
                providerCount:providers.length,
                state,
                threadCount:threads.length
            });
            operation.terminal=true;
            this.#clearRefreshOperation(operation);
            this.#events.dispatch(
                terminalType,
                compatibilityDetail,
                {
                    operationId:operation.operationId,
                    publicDetail
                }
            );
            if(!this.#events.disposed){
                this.#events.dispatch(
                    COMMUNICATION_HUB_EVENTS.refreshLegacy,
                    Object.freeze({
                        errors:compatibilityDetail.errors,
                        threads:compatibilityDetail.threads
                    }),
                    {
                        operationId:operation.operationId,
                        publicDetail
                    }
                );
            }
            return {threads:returnedThreads,errors:returnedErrors};
        }catch(error){
            if(operation.terminal){
                throw operation.error??error;
            }
            if(error instanceof Error&&error.name==='AbortError'){
                this.#publishCancellation(
                    operation,
                    error,
                    error.code===COMMUNICATION_HUB_ERROR_CODES.refreshSuperseded
                        ?COMMUNICATION_HUB_REFRESH_REASONS.superseded
                        :COMMUNICATION_HUB_REFRESH_REASONS.signalAborted
                );
                throw error;
            }
            const failure=refreshFailureError(error);
            operation.terminal=true;
            operation.error=failure;
            this.#clearRefreshOperation(operation);
            if(!this.#events.disposed){
                this.#events.dispatch(
                    COMMUNICATION_HUB_EVENTS.refreshFailed,
                    Object.freeze({error:failure}),
                    {
                        operationId:operation.operationId,
                        publicDetail:Object.freeze({
                            code:failure.code,
                            reason:COMMUNICATION_HUB_REFRESH_REASONS.boundaryThrew,
                            state:COMMUNICATION_HUB_REFRESH_STATES.failed
                        })
                    }
                );
            }
            throw failure;
        }
    }

    async messages(thread){
        this.#assertOpen();
        const record=thread instanceof CommunicationThread
            ?thread
            :new CommunicationThread(thread);
        const values=await this.registry.get(record.providerId).getMessages(record.id);
        this.#assertOpen();
        return values.map(function normalizeCommunicationMessage(value){
            return value instanceof CommunicationMessage
                ?value
                :new CommunicationMessage(
                    {
                        ...value,
                        threadId:record.id,
                        providerId:record.providerId,
                        channel:record.channel
                    }
                );
        }).sort(function compareCommunicationMessages(left,right){
            return left.timestamp.localeCompare(right.timestamp);
        });
    }

    async send({providerId,threadId,channel,body,subject='',recipients=[]}={}){
        this.#assertOpen();
        if(!String(body||'').trim()){
            throw new TypeError('A message body is required.');
        }
        const result=await this.registry.get(providerId).send(
            {
                threadId,
                channel,
                body:String(body),
                subject:String(subject),
                recipients:Array.from(recipients||[])
            }
        );
        this.#assertOpen();
        return result;
    }

    dispose(){
        if(this.#disposed){
            return false;
        }
        this.#disposed=true;
        this.#cancelActiveRefresh(
            refreshAbortError(
                disposedError(),
                COMMUNICATION_HUB_ERROR_CODES.disposed
            ),
            COMMUNICATION_HUB_REFRESH_REASONS.hubDisposed
        );
        return this.#events.dispose();
    }

    destroy(){
        return this.dispose();
    }
}

import {createArcaneEventSource} from 'arcane-os/event-manager';
import TerminalSession from '../entities/TerminalSession.js';

export const TERMINAL_CLIENT_EVENT_TYPES=Object.freeze({
    sessionStarted:'terminal-session',
    sessionExited:'terminal-exit',
    sessionError:'terminal-error',
    sessionOutput:'terminal-output'
});
export const TERMINAL_CLIENT_ERROR_CODES=Object.freeze({
    capabilityUnavailable:'ARCANE_TERMINAL_CAPABILITY_UNAVAILABLE',
    disposed:'ARCANE_TERMINAL_CLIENT_DISPOSED',
    hostEventSubscriptionInvalid:'ARCANE_TERMINAL_HOST_EVENT_SUBSCRIPTION_INVALID',
    hostEventUnsubscribeRejected:'ARCANE_TERMINAL_HOST_EVENT_UNSUBSCRIBE_REJECTED',
    eventTypeInvalid:'ARCANE_TERMINAL_CLIENT_EVENT_TYPE_INVALID',
    staleSessionCleanupRejected:'ARCANE_TERMINAL_STALE_SESSION_CLEANUP_REJECTED',
    sessionHostError:'ARCANE_TERMINAL_SESSION_HOST_ERROR'
});
export const TERMINAL_CLIENT_REASONS=Object.freeze({
    capabilityUnavailable:'terminal-capability-unavailable',
    disposed:'terminal-client-disposed',
    hostEventSubscriptionInvalid:'terminal-host-event-subscription-invalid',
    hostEventUnsubscribeRejected:'terminal-host-event-unsubscribe-rejected',
    eventTypeInvalid:'terminal-client-event-type-invalid',
    staleSessionCleanupRejected:'terminal-stale-session-cleanup-rejected',
    sessionStarted:'terminal-session-started',
    sessionExited:'terminal-session-exited',
    sessionHostErrorReceived:'terminal-session-host-error-received',
    sessionOutputReceived:'terminal-session-output-received'
});

function terminalClientError(code,reason,message,cause){
    const error=cause===undefined
        ?new Error(message)
        :new Error(message,{cause});
    error.code=code;
    error.reason=reason;
    return error;
}

function terminalEventReason(type){
    if(type==='session')return TERMINAL_CLIENT_REASONS.sessionStarted;
    if(type==='exit')return TERMINAL_CLIENT_REASONS.sessionExited;
    if(type==='error')return TERMINAL_CLIENT_REASONS.sessionHostErrorReceived;
    return TERMINAL_CLIENT_REASONS.sessionOutputReceived;
}

function terminalPublicDetail(detail,type,reason){
    const id=detail?.session?.id??detail?.sessionId;
    const output=typeof detail?.data==='string'?detail.data:'';
    const code=type==='error'
        ?typeof detail?.code==='string'&&detail.code
            ?detail.code
            :TERMINAL_CLIENT_ERROR_CODES.sessionHostError
        :null;
    return Object.freeze({
        ...(typeof id==='string'&&id?{id}:{}),
        ...(typeof detail?.stream==='string'?{stream:detail.stream}:{}),
        ...(output?{byteCount:new TextEncoder().encode(output).byteLength}:{}),
        ...(typeof detail?.session?.state==='string'?{status:detail.session.state}:{}),
        ...(code?{code}:{}),
        reason
    });
}

export default class TerminalClient extends EventTarget{
    #destroyed=false;
    #events;
    #generation=0;
    #operationSequence=0;
    constructor(api=globalThis.Arcane?.terminal){
        super();
        this.api=api||null;
        this.sessions=new Map();
        this.unsubscribe=[];
        this.#events=createArcaneEventSource(this,{
            source:'terminal-client',
            eventTypes:Object.freeze(
                Object.values(TERMINAL_CLIENT_EVENT_TYPES)
            )
        });
        const events=globalThis.Arcane?.events;
        if(events?.on){
            const client=this;
            try{
                for(const type of [
                    'terminal.output',
                    'terminal.exit',
                    'terminal.error'
                ]){
                    function receiveTerminalHostEvent(data){
                        client.receive(type,data);
                    }
                    const unsubscribe=events.on(
                        type,
                        receiveTerminalHostEvent
                    );
                    if(typeof unsubscribe!=='function'
                        &&typeof unsubscribe?.dispose!=='function'){
                        throw terminalClientError(
                            TERMINAL_CLIENT_ERROR_CODES.hostEventSubscriptionInvalid,
                            TERMINAL_CLIENT_REASONS.hostEventSubscriptionInvalid,
                            `Arcane.events.on(${type}) must return an unsubscribe function or disposable handle.`
                        );
                    }
                    this.unsubscribe.push(unsubscribe);
                }
            }catch(cause){
                this.#releaseHostSubscriptions();
                this.#events.dispose();
                if(cause?.code===TERMINAL_CLIENT_ERROR_CODES.hostEventSubscriptionInvalid){
                    throw cause;
                }
                throw terminalClientError(
                    TERMINAL_CLIENT_ERROR_CODES.hostEventSubscriptionInvalid,
                    TERMINAL_CLIENT_REASONS.hostEventSubscriptionInvalid,
                    'Terminal host event subscription was rejected.',
                    cause
                );
            }
        }
    }

    addEventListener(type,listener,options){return this.#events.addEventListener(type,listener,options);}
    removeEventListener(type,listener,options){return this.#events.removeEventListener(type,listener,options);}
    on(type,listener,options){return this.#events.on(type,listener,options);}
    subscribe(type,listener,options){return this.#events.subscribe(type,listener,options);}
    dispatchEvent(value){return this.#events.dispatchEvent(value);}

    get available(){
        return !this.#destroyed
            &&Boolean(this.api?.start&&this.api?.write&&this.api?.close);
    }

    #disposedError(){
        return terminalClientError(
            TERMINAL_CLIENT_ERROR_CODES.disposed,
            TERMINAL_CLIENT_REASONS.disposed,
            'The terminal client has been disposed.'
        );
    }

    #assertOpen(){
        if(this.#destroyed)throw this.#disposedError();
    }

    #assertCapability(method){
        this.#assertOpen();
        if(typeof this.api?.[method]!=='function'){
            throw terminalClientError(
                TERMINAL_CLIENT_ERROR_CODES.capabilityUnavailable,
                TERMINAL_CLIENT_REASONS.capabilityUnavailable,
                `The Arcane native terminal ${method} capability is unavailable. Open Terminal from the installed Arcane shell.`
            );
        }
    }

    #assertCurrent(generation){
        if(this.#destroyed||generation!==this.#generation){
            throw this.#disposedError();
        }
    }

    #releaseHostSubscriptions(){
        let firstError=null;
        for(const subscription of this.unsubscribe){
            try{
                if(typeof subscription==='function')subscription();
                else subscription.dispose();
            }catch(error){
                firstError??=error;
            }
        }
        this.unsubscribe=[];
        return firstError;
    }

    async start(options={}){
        this.#assertCapability('start');
        const generation=this.#generation;
        const result=await this.api.start(options);
        if(this.#destroyed||generation!==this.#generation){
            let cleanupError=null;
            if(typeof result?.id==='string'&&typeof this.api?.close==='function'){
                try{
                    await this.api.close(result.id);
                }catch(error){
                    cleanupError=error;
                }
            }
            if(cleanupError){
                throw terminalClientError(
                    TERMINAL_CLIENT_ERROR_CODES.staleSessionCleanupRejected,
                    TERMINAL_CLIENT_REASONS.staleSessionCleanupRejected,
                    'The terminal client was disposed and cleanup of its newly started host session was rejected.',
                    cleanupError
                );
            }
            throw this.#disposedError();
        }
        const session=new TerminalSession({...result,state:'running'});
        this.sessions.set(session.id,session);
        this.emit('session',{session});
        return session;
    }

    async write(id,data){
        this.#assertCapability('write');
        TerminalSession.id(id);
        const generation=this.#generation;
        const result=await this.api.write(id,String(data??''));
        this.#assertCurrent(generation);
        return result;
    }

    async resize(id,columns,rows){
        this.#assertCapability('resize');
        TerminalSession.id(id);
        const generation=this.#generation;
        const result=await this.api.resize(id,Number(columns),Number(rows));
        this.#assertCurrent(generation);
        return result;
    }

    async signal(id,signal='interrupt'){
        this.#assertCapability('signal');
        TerminalSession.id(id);
        const generation=this.#generation;
        const result=await this.api.signal(id,String(signal));
        this.#assertCurrent(generation);
        return result;
    }

    async close(id){
        this.#assertCapability('close');
        TerminalSession.id(id);
        const generation=this.#generation;
        const result=await this.api.close(id);
        this.#assertCurrent(generation);
        const session=this.sessions.get(id);
        if(session) this.sessions.set(id,session.with({state:'closed'}));
        return result;
    }

    receive(type,data={}){
        if(this.#destroyed)return false;
        const id=String(data.sessionId||'');
        if(!id||!this.sessions.has(id))return false;
        if(type==='terminal.exit'){
            const session=this.sessions.get(id).with({state:'exited'});
            this.sessions.set(id,session);
            this.emit('exit',{...data,session});
        }else if(type==='terminal.error'){
            this.emit('error',data);
        }else{
            this.emit('output',data);
        }
        return true;
    }

    emit(type,detail){
        this.#assertOpen();
        if(!['session','exit','error','output'].includes(type)){
            throw terminalClientError(
                TERMINAL_CLIENT_ERROR_CODES.eventTypeInvalid,
                TERMINAL_CLIENT_REASONS.eventTypeInvalid,
                'Terminal client events must be session, exit, error, or output.'
            );
        }
        const eventType=TERMINAL_CLIENT_EVENT_TYPES[
            type==='session'
                ?'sessionStarted'
                :type==='exit'
                    ?'sessionExited'
                    :type==='error'
                        ?'sessionError'
                        :'sessionOutput'
        ];
        const reason=terminalEventReason(type);
        this.#operationSequence+=1;
        const operationId=`${this.#events.instanceId}:${type}:${this.#operationSequence.toString(36)}`;
        const compatibilityDetail=Object.freeze({
            ...detail,
            operationId,
            reason
        });
        return this.#events.dispatch(
            eventType,
            compatibilityDetail,
            {
                operationId,
                publicDetail:terminalPublicDetail(detail,type,reason)
            }
        ).occurrence;
    }

    destroy(){
        if(this.#destroyed)return false;
        this.#destroyed=true;
        this.#generation+=1;
        const unsubscribeError=this.#releaseHostSubscriptions();
        this.#events.dispose();
        if(unsubscribeError){
            throw terminalClientError(
                TERMINAL_CLIENT_ERROR_CODES.hostEventUnsubscribeRejected,
                TERMINAL_CLIENT_REASONS.hostEventUnsubscribeRejected,
                'A terminal host event subscription rejected cleanup.',
                unsubscribeError
            );
        }
        return true;
    }

    dispose(){
        return this.destroy();
    }
}

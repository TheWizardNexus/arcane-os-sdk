import {
    checkLocalAIReadiness,
    deriveLocalAIRequirements
} from './LocalAIReadiness.js?v=4';
import {
    createArcaneEventSource,
    projectArcaneDOMEvent
} from 'arcane-os/event-manager';

const SLOT_NAMES=Object.freeze(['llm','stt','tts']);

export const LOCAL_AI_READINESS_CONTROLLER_EVENT_TYPES=Object.freeze({
    changed:'local-ai-readiness-change'
});
export const LOCAL_AI_READINESS_CONTROLLER_ERROR_CODES=Object.freeze({
    aborted:'ARCANE_LOCAL_AI_READINESS_CONTROLLER_ABORTED',
    disposed:'ARCANE_LOCAL_AI_READINESS_CONTROLLER_DISPOSED',
    statusReadyTimeout:'ARCANE_LOCAL_AI_STATUS_COMPONENT_READY_TIMEOUT'
});
export const LOCAL_AI_READINESS_CONTROLLER_REASONS=Object.freeze({
    checked:'local-ai-readiness-checked',
    aborted:'local-ai-readiness-controller-aborted',
    disposed:'local-ai-readiness-controller-disposed',
    statusReadyTimeout:'local-ai-status-component-ready-timeout'
});

function availabilityFromReport(report={}){
    const slots=report.slots||{};
    return Object.freeze(Object.fromEntries(SLOT_NAMES.map(name=>{
        const slot=slots[name]||{};
        return [name,slot.required===true&&slot.ready===true];
    })));
}

function selectedPreferences(source){
    return typeof source==='function'?source():source;
}

function pendingReport(requirements){
    return Object.freeze({
        slots:Object.freeze(Object.fromEntries(SLOT_NAMES.map(name=>[
            name,
            Object.freeze({
                ...requirements[name],
                ready:requirements[name].required?false:null
            })
        ])))
    });
}

function localAIReadinessAbortError(reason,disposed=false){
    const code=disposed
        ?LOCAL_AI_READINESS_CONTROLLER_ERROR_CODES.disposed
        :LOCAL_AI_READINESS_CONTROLLER_ERROR_CODES.aborted;
    const errorReason=disposed
        ?LOCAL_AI_READINESS_CONTROLLER_REASONS.disposed
        :LOCAL_AI_READINESS_CONTROLLER_REASONS.aborted;
    if(reason instanceof Error
        &&reason.name==='AbortError'
        &&reason.code===code
        &&reason.reason===errorReason){
        return reason;
    }

    const error=new Error(
        disposed
            ?'The local AI readiness controller has been disposed.'
            :'The local AI readiness check was aborted.'
    );
    error.name='AbortError';
    error.code=code;
    error.reason=errorReason;
    if(reason!==undefined){
        error.cause=reason;
    }
    return error;
}

async function waitForStatusComponent(status,signal){
    if(!status||status.ready){
        return status;
    }

    await new Promise(function waitForLocalAIStatusPromise(resolve,reject){
        let settled=false;
        const timeout=globalThis.setTimeout(failTimeout,10000);

        function cleanup(){
            globalThis.clearTimeout(timeout);
            status.removeEventListener('local-ai-status-ready',complete);
            signal?.removeEventListener('abort',abortWait);
        }

        function complete(){
            if(settled){
                return;
            }
            settled=true;
            cleanup();
            resolve();
        }

        function fail(error){
            if(settled){
                return;
            }
            settled=true;
            cleanup();
            reject(error);
        }

        function failTimeout(){
            const error=new Error('Local AI status component readiness timed out after 10000 ms.');
            error.code=LOCAL_AI_READINESS_CONTROLLER_ERROR_CODES.statusReadyTimeout;
            error.reason=LOCAL_AI_READINESS_CONTROLLER_REASONS.statusReadyTimeout;
            fail(error);
        }

        function abortWait(){
            fail(localAIReadinessAbortError(signal?.reason));
        }

        if(signal?.aborted){
            abortWait();
            return;
        }

        signal?.addEventListener('abort',abortWait,{once:true});
        status.addEventListener('local-ai-status-ready',complete,{once:true});
    });
    return status;
}

/**
 * Connects the shared readiness contract to a chat surface. Applications own
 * only their preference source and navigation destinations.
 */
export function createLocalAIReadinessController({
    chat,
    status,
    preferences,
    profileHref=null,
    onChange,
    ...checkOptions
}={}){
    if(!chat){
        throw new TypeError('A chat component is required.');
    }

    const lifecycleController=new AbortController();
    const eventOwner=Object.freeze({kind:'local-ai-readiness-controller'});
    const events=createArcaneEventSource(
        eventOwner,
        {
            source:'local-ai-readiness-controller',
            eventTypes:Object.freeze(
                Object.values(LOCAL_AI_READINESS_CONTROLLER_EVENT_TYPES)
            )
        }
    );
    let active=null;
    let chatReadyListenerPending=false;
    let destroyed=false;
    let latestReport=null;
    let currentAvailability=availabilityFromReport({});
    let operationSequence=0;

    function publishAvailability(){
        if(destroyed){
            return;
        }
        if(typeof chat.setAIAvailability==='function'){
            if(chatReadyListenerPending){
                chat.removeEventListener('chat-ready',publishAvailability);
            }
            chatReadyListenerPending=false;
            chat.setAIAvailability(currentAvailability);
        }else if(!chatReadyListenerPending){
            chatReadyListenerPending=true;
            chat.addEventListener(
                'chat-ready',
                publishAvailability,
                {
                    once:true,
                    signal:lifecycleController.signal
                }
            );
        }
    }

    function applyAvailability(report){
        currentAvailability=availabilityFromReport(report);
        publishAvailability();
    }

    async function check(){
        if(destroyed){
            throw localAIReadinessAbortError(
                lifecycleController.signal.reason,
                true
            );
        }
        if(active){
            return active;
        }

        active=(async function runLocalAIReadinessCheck(){
            const preferenceTuple=selectedPreferences(preferences);
            const requirements=deriveLocalAIRequirements(preferenceTuple);
            const required=SLOT_NAMES.some(name=>requirements[name].required);

            applyAvailability(pendingReport(requirements));
            await waitForStatusComponent(status,lifecycleController.signal);
            if(destroyed){
                throw localAIReadinessAbortError(
                    lifecycleController.signal.reason,
                    true
                );
            }
            status?.configure?.({profileHref});
            if(required){
                status?.begin?.(requirements);
            }else if(status){
                status.hidden=true;
            }

            latestReport=await checkLocalAIReadiness({
                ...checkOptions,
                preferences:preferenceTuple
            });
            if(destroyed){
                throw localAIReadinessAbortError(
                    lifecycleController.signal.reason,
                    true
                );
            }
            status?.present?.(latestReport);
            applyAvailability(latestReport);
            if(typeof onChange==='function'){
                onChange(latestReport);
            }
            const availability=availabilityFromReport(latestReport);
            if(destroyed){
                throw localAIReadinessAbortError(
                    lifecycleController.signal.reason,
                    true
                );
            }
            operationSequence+=1;
            const operationId=`${events.instanceId}:check:${operationSequence.toString(36)}`;
            const reason=LOCAL_AI_READINESS_CONTROLLER_REASONS.checked;
            const publication=events.dispatch(
                LOCAL_AI_READINESS_CONTROLLER_EVENT_TYPES.changed,
                Object.freeze({operationId,reason,report:latestReport}),
                {
                    operationId,
                    publicDetail:Object.freeze({availability,reason})
                }
            );
            projectArcaneDOMEvent(
                chat,
                publication.occurrence,
                {
                    bubbles:true,
                    composed:true
                }
            );
            return latestReport;
        })().finally(function releaseLocalAIReadinessCheck(){
            active=null;
        });

        return active;
    }

    function ensure(){
        if(active){
            return active;
        }
        return latestReport
            ?Promise.resolve(latestReport)
            :check();
    }

    function retry(){
        void check().catch(function ignoreDestroyedLocalAIRetry(error){
            if(error?.name!=='AbortError'){
                console.error('Local AI readiness retry failed.',error);
            }
        });
    }
    status?.addEventListener(
        'local-ai-retry',
        retry,
        {signal:lifecycleController.signal}
    );

    function destroy(){
        if(destroyed){
            return false;
        }
        destroyed=true;
        lifecycleController.abort(
            localAIReadinessAbortError(undefined,true)
        );
        if(chatReadyListenerPending){
            chat.removeEventListener('chat-ready',publishAvailability);
            chatReadyListenerPending=false;
        }
        status?.removeEventListener('local-ai-retry',retry);
        events.dispose();
        return true;
    }

    return Object.freeze({
        check,
        ensure,
        destroy,
        dispose:destroy,
        get availability(){
            return currentAvailability;
        },
        get report(){
            return latestReport;
        },
        readyFor(name){
            if(!SLOT_NAMES.includes(name)){
                throw new TypeError('Local AI slot must be llm, stt, or tts.');
            }
            return currentAvailability[name];
        }
    });
}

export {availabilityFromReport};

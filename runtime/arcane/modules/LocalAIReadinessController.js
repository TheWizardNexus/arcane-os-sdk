import {
    checkLocalAIReadiness,
    deriveLocalAIRequirements
} from './LocalAIReadiness.js?v=3';

const SLOT_NAMES=Object.freeze(['llm','stt','tts']);

function availabilityFromReport(report={}){
    const slots=report.slots||{};
    return Object.freeze(Object.fromEntries(SLOT_NAMES.map(name=>{
        const slot=slots[name]||{};
        return [name,!slot.required||slot.ready===true];
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

async function waitForStatusComponent(status){
    if(!status||status.ready){
        return status;
    }

    await new Promise(resolve=>{
        const timeout=globalThis.setTimeout(done,10000);
        function done(){
            globalThis.clearTimeout(timeout);
            status.removeEventListener('local-ai-status-ready',done);
            resolve();
        }
        status.addEventListener('local-ai-status-ready',done,{once:true});
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

    let active=null;
    let latestReport=null;
    let currentAvailability=availabilityFromReport({});

    const publishAvailability=()=>{
        if(typeof chat.setAIAvailability==='function'){
            chat.setAIAvailability(currentAvailability);
        }else{
            chat.addEventListener('chat-ready',publishAvailability,{once:true});
        }
    };

    const applyAvailability=report=>{
        currentAvailability=availabilityFromReport(report);
        publishAvailability();
    };

    const check=async()=>{
        if(active){
            return active;
        }

        active=(async()=>{
            const preferenceTuple=selectedPreferences(preferences);
            const requirements=deriveLocalAIRequirements(preferenceTuple);
            const required=SLOT_NAMES.some(name=>requirements[name].required);

            applyAvailability(pendingReport(requirements));
            await waitForStatusComponent(status);
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
            status?.present?.(latestReport);
            applyAvailability(latestReport);
            if(typeof onChange==='function'){
                onChange(latestReport);
            }
            chat.dispatchEvent(new CustomEvent('local-ai-readiness-change',{
                bubbles:true,
                composed:true,
                detail:{report:latestReport}
            }));
            return latestReport;
        })().finally(()=>{
            active=null;
        });

        return active;
    };

    const ensure=()=>{
        if(active){
            return active;
        }
        return latestReport
            ?Promise.resolve(latestReport)
            :check();
    };

    const retry=()=>void check();
    status?.addEventListener('local-ai-retry',retry);

    return Object.freeze({
        check,
        ensure,
        destroy(){
            status?.removeEventListener('local-ai-retry',retry);
        },
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

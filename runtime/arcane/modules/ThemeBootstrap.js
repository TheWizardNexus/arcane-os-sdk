import { arcaneLogging } from 'arcane-os/logging';
import {loadAndApplyTheme} from './ThemeManager.js';
import {createArcaneEventSource} from 'arcane-os/event-manager';

const sharedKey='arcaneThemeReady';
const listenerKey='arcaneThemeAppearanceListener';
const THEME_BOOTSTRAP_EVENT_OWNER={};
let themeBootstrapOperationSequence=0;
const themeBootstrapEvents=createArcaneEventSource(
    THEME_BOOTSTRAP_EVENT_OWNER,
    {
        source:'theme-bootstrap',
        eventTypes:['appearance.changed']
    }
);

function installAppearanceListener(ready){
    const hostEvents=globalThis.Arcane?.events;
    if(typeof hostEvents?.on!=='function'||globalThis[listenerKey]){
        return;
    }

    let active=true;
    const hostUnsubscribe=hostEvents.on(
        'appearance.changed',
        function forwardAppearanceChange(detail={}){
            themeBootstrapOperationSequence+=1;
            const forwarded={
                scheme:typeof detail?.scheme==='string'?detail.scheme:null,
                effectiveScheme:typeof detail?.effectiveScheme==='string'
                    ?detail.effectiveScheme
                    :null,
                source:typeof detail?.source==='string'?detail.source:null,
                reason:'host-appearance-changed'
            };
            themeBootstrapEvents.dispatch(
                'appearance.changed',
                forwarded,
                {
                    operationId:`theme-bootstrap-${themeBootstrapEvents.instanceId}-${themeBootstrapOperationSequence}`,
                    publicDetail:{...forwarded}
                }
            );
            Promise.resolve(ready).then(function reloadTheme(result){
                return result?.manager?.load?.();
            }).catch(function reportThemeReloadFailure(error){
                arcaneLogging.warn(
                    '[Arcane theme] Unable to apply the changed host appearance.',
                    error
                );
            });
        }
    );
    const dispose=function disposeArcaneThemeAppearanceListener(){
        if(!active){
            return false;
        }
        active=false;
        if(typeof hostUnsubscribe==='function'){
            hostUnsubscribe();
        }
        if(globalThis[listenerKey]===dispose){
            delete globalThis[listenerKey];
        }
        return true;
    };
    Object.defineProperty(dispose,'dispose',{
        value:dispose,
        enumerable:false,
        configurable:true,
        writable:true
    });
    globalThis[listenerKey]=dispose;
}

export function bootstrapArcaneTheme(options={}){
    const useSharedPromise=Object.keys(options).length===0;
    if(useSharedPromise&&globalThis[sharedKey]){
        installAppearanceListener(globalThis[sharedKey]);
        return globalThis[sharedKey];
    }

    const ready=loadAndApplyTheme(options).catch(error=>{
        arcaneLogging.warn('[Arcane theme] Unable to load the saved appearance; using the system theme.',error);
        return {manager:null,state:null,error};
    });

    if(useSharedPromise) globalThis[sharedKey]=ready;
    if(useSharedPromise){
        installAppearanceListener(ready);
    }
    return ready;
}

export function disposeArcaneThemeBootstrap(){
    const dispose=globalThis[listenerKey];
    return typeof dispose==='function'?dispose():false;
}

export const arcaneThemeReady=bootstrapArcaneTheme();
export default arcaneThemeReady;

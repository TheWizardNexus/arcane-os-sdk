import Is from 'strong-type';
const is=new Is(false);

import { arcaneLogging } from 'arcane-os/logging';
import {applyUserSkin,loadAndApplyTheme} from './ThemeManager.js';
import {createArcaneEventSource} from 'arcane-os/event-manager';

const sharedKey='arcaneThemeReady';
const listenerKey='arcaneThemeAppearanceListener';
const userListenerKey='arcaneThemeUserListener';
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
    if(!is.function(hostEvents?.on)||globalThis[listenerKey]){
        return;
    }

    let active=true;
    const hostUnsubscribe=hostEvents.on(
        'appearance.changed',
        function forwardAppearanceChange(detail={}){
            themeBootstrapOperationSequence+=1;
            const forwarded={
                scheme:is.string(detail?.scheme)?detail.scheme:null,
                effectiveScheme:is.string(detail?.effectiveScheme)
                    ?detail.effectiveScheme
                    :null,
                source:is.string(detail?.source)?detail.source:null,
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
        if(is.function(hostUnsubscribe)){
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

function installUserSkinListener(){
    if(globalThis[userListenerKey]||!is.function(globalThis.addEventListener)) return;
    let active=true;
    function applyReadyUserSkin(){
        if(!active||!globalThis.user?.ready) return;
        try{
            applyUserSkin(globalThis.user.skin);
        }catch(error){
            arcaneLogging.warn('[Arcane theme] Unable to apply the saved user skin.',error);
        }
    }
    globalThis.addEventListener('user-entity-loaded',applyReadyUserSkin);
    globalThis[userListenerKey]=function disposeArcaneThemeUserListener(){
        if(!active) return false;
        active=false;
        globalThis.removeEventListener('user-entity-loaded',applyReadyUserSkin);
        delete globalThis[userListenerKey];
        return true;
    };
    applyReadyUserSkin();
}

export function bootstrapArcaneTheme(options={}){
    const useSharedPromise=Object.keys(options).length===0;
    if(useSharedPromise&&globalThis[sharedKey]){
        installAppearanceListener(globalThis[sharedKey]);
        installUserSkinListener();
        return globalThis[sharedKey];
    }

    const ready=loadAndApplyTheme(options).catch(error=>{
        arcaneLogging.warn('[Arcane theme] Unable to load the saved appearance; retaining the current presentation.',error);
        return {manager:null,state:null,error};
    });

    if(useSharedPromise) globalThis[sharedKey]=ready;
    if(useSharedPromise){
        installAppearanceListener(ready);
        installUserSkinListener();
    }
    return ready;
}

export function disposeArcaneThemeBootstrap(){
    const dispose=globalThis[listenerKey];
    const disposeUser=globalThis[userListenerKey];
    const appearanceDisposed=is.function(dispose)?dispose():false;
    const userDisposed=is.function(disposeUser)?disposeUser():false;
    return appearanceDisposed||userDisposed;
}

export const arcaneThemeReady=bootstrapArcaneTheme();
export default arcaneThemeReady;

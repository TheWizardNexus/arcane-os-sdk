import Is from 'strong-type';
const is=new Is(false);

import { arcaneLogging } from 'arcane-os/logging';
import {applyUserSkin,loadAndApplyTheme} from './ThemeManager.js';
import {arcaneEvents,createArcaneEventSource} from 'arcane-os/event-manager';

const sharedKey='arcaneThemeReady';
const listenerKey='arcaneThemeAppearanceListener';
const userListenerKey='arcaneThemeUserListener';
const windowListenerKey='arcaneThemeWindowListener';
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

function installWindowThemeListener(ready){
    const host=globalThis.Arcane;
    const document=globalThis.document;
    if(globalThis[windowListenerKey]||!host?.runtime?.current?.().native
        ||!is.function(host?.window?.setTheme)||!document?.documentElement) return;

    let active=true;
    let suspended=false;
    let scheduled=false;
    let lastPresentation=null;
    let pending=null;
    let observedBody=null;
    let canvasContext=null;
    const root=document.documentElement;
    const scheme=globalThis.matchMedia('(prefers-color-scheme: dark)');
    const print=globalThis.matchMedia('print');
    const probe=document.createElement('span');
    probe.style.setProperty('display','none','important');

    function report(error){
        arcaneLogging.warn('[Arcane theme] Unable to update the native window colors.',error);
    }
    function colorRecord(resolved){
        // Read the browser's resolved color, not an authored CSS grammar. Keep
        // its alpha separately so raster conversion cannot round translucency away.
        const rgb=resolved.match(/^rgba?\(([^)]+)\)$/u);
        if(rgb){
            const values=rgb[1].split(/[\s,/]+/u).filter(Boolean).map(Number);
            if((values.length===3||values.length===4)&&values.every(Number.isFinite)){
                return {red:values[0],green:values[1],blue:values[2],alpha:values[3]??1};
            }
        }
        const alphaMatch=resolved.match(/\/\s*(none|[-+\d.eE]+%?)\s*\)$/u);
        const alphaValue=alphaMatch?.[1];
        const alpha=alphaValue===undefined?1:alphaValue==='none'?0:
            Number.parseFloat(alphaValue)/(alphaValue.endsWith('%')?100:1);
        if(!Number.isFinite(alpha)||(resolved.includes('/')&&!alphaMatch)){
            throw new TypeError(`Unable to read the resolved CSS color: ${resolved}`);
        }
        const opaque=alphaMatch?resolved.replace(/\/[^/]*\)$/u,'/ 1)'):resolved;
        if(!canvasContext){
            const canvas=document.createElement('canvas');
            canvas.width=1;
            canvas.height=1;
            canvasContext=canvas.getContext(
                '2d',
                {colorSpace:'srgb'}
            );
            if(!canvasContext) throw new Error('The browser cannot convert the resolved color to sRGB.');
        }
        // An unsupported fillStyle assignment leaves the old value intact.
        // Two different starting values distinguish rejection from a valid black.
        canvasContext.fillStyle='#000000';
        canvasContext.fillStyle=opaque;
        const accepted=canvasContext.fillStyle;
        canvasContext.fillStyle='#ffffff';
        canvasContext.fillStyle=opaque;
        if(canvasContext.fillStyle!==accepted){
            throw new TypeError(`The browser canvas cannot convert the resolved CSS color: ${resolved}`);
        }
        canvasContext.clearRect(0,0,1,1);
        canvasContext.fillRect(0,0,1,1);
        const [red,green,blue]=canvasContext.getImageData(0,0,1,1).data;
        return {red,green,blue,alpha};
    }
    function readPresentation(){
        const target=document.body;
        if(!target) return {};
        const styles=globalThis.getComputedStyle(target);
        const presentation={};
        target.appendChild(probe);
        try {
            const properties=[
                ['backgroundColor','--background'],
                ['textColor','--text-color']
            ];
            for(const [field,property] of properties){
                const authored=styles.getPropertyValue(property);
                if(!authored.trim()) continue;
                if(!globalThis.CSS.supports('color',authored)){
                    report(
                        new TypeError(`The app theme ${property} is not a supported CSS color: ${authored}`)
                    );
                    continue;
                }
                // Use the target's resolved value: registered properties may
                // deliberately not inherit into this child resolution element.
                probe.style.setProperty('color',authored,'important');
                try {
                    const resolved=globalThis.getComputedStyle(probe).color;
                    presentation[field]=colorRecord(resolved);
                } catch (error) {
                    report(error);
                }
            }
        } finally {
            probe.remove();
        }
        return presentation;
    }
    function samePresentation(next){
        return lastPresentation&&['backgroundColor','textColor'].every(
            function sameColor(field){
                const before=lastPresentation[field];
                const after=next[field];
                if(before===after) return true;
                if(!before||!after) return false;
                return ['red','green','blue','alpha'].every(
                    function sameChannel(channel){
                        return before[channel]===after[channel];
                    }
                );
            }
        );
    }
    function observeElements(){
        if(observedBody===document.body) return;
        observer.disconnect();
        observer.observe(
            root,
            {attributes:true,childList:true,attributeFilter:['class','style','data-color-scheme','data-user-skin','data-arcane-skin']}
        );
        observedBody=document.body;
        if(observedBody) observer.observe(
            observedBody,
            {attributes:true,attributeFilter:['class','style']}
        );
    }
    function sample(){
        scheduled=false;
        if(!active||suspended||print.matches) return;
        observeElements();
        const presentation=readPresentation();
        if(!Object.keys(presentation).length||samePresentation(presentation)) return;
        lastPresentation=presentation;
        pending?.abort();
        const controller=new AbortController();
        pending=controller;
        try {
            const operation=host.window.setTheme(
                presentation,
                {signal:controller.signal}
            );
            Promise.resolve(operation).catch(
                function reportWindowFailure(error){
                    if(error?.code==='ARCANE_REQUEST_ABORTED'||(controller.signal.aborted&&error?.name==='AbortError')) return;
                    report(error);
                    if(error?.code==='METHOD_NOT_ALLOWED') dispose();
                }
            ).finally(
                function finishWindowUpdate(){
                    if(pending===controller) pending=null;
                }
            );
        } catch (error) {
            if(pending===controller) pending=null;
            report(error);
        }
    }
    function schedule(){
        if(!active||suspended||scheduled) return;
        scheduled=true;
        Promise.resolve().then(sample).catch(report);
    }
    function stylesheetLoaded(event){
        if(event.target?.tagName==='LINK'&&event.target.relList?.contains('stylesheet')) schedule();
    }
    function hide(){
        suspended=true;
        pending?.abort();
    }
    function show(){
        suspended=false;
        lastPresentation=null;
        schedule();
    }
    function dispose(){
        if(!active) return false;
        active=false;
        pending?.abort();
        observer.disconnect();
        unsubscribe();
        scheme.removeEventListener('change',schedule);
        print.removeEventListener('change',schedule);
        document.removeEventListener('DOMContentLoaded',schedule);
        document.removeEventListener('load',stylesheetLoaded,true);
        globalThis.removeEventListener('pagehide',hide);
        globalThis.removeEventListener('pageshow',show);
        canvasContext=null;
        if(globalThis[windowListenerKey]===dispose) delete globalThis[windowListenerKey];
        return true;
    }
    const observer=new globalThis.MutationObserver(schedule);
    const unsubscribe=arcaneEvents.subscribe('arcane-theme-change',schedule);
    observer.observe(
        root,
        {attributes:true,childList:true,attributeFilter:['class','style','data-color-scheme','data-user-skin','data-arcane-skin']}
    );
    observeElements();
    scheme.addEventListener('change',schedule);
    print.addEventListener('change',schedule);
    document.addEventListener('DOMContentLoaded',schedule);
    document.addEventListener('load',stylesheetLoaded,true);
    globalThis.addEventListener('pagehide',hide);
    globalThis.addEventListener('pageshow',show);
    globalThis[windowListenerKey]=dispose;
    schedule();
    Promise.resolve(ready).then(schedule).catch(report);
}

export function bootstrapArcaneTheme(options={}){
    const useSharedPromise=Object.keys(options).length===0;
    if(useSharedPromise&&globalThis[sharedKey]){
        installAppearanceListener(globalThis[sharedKey]);
        installUserSkinListener();
        installWindowThemeListener(globalThis[sharedKey]);
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
        installWindowThemeListener(ready);
    }
    return ready;
}

export function disposeArcaneThemeBootstrap(){
    const dispose=globalThis[listenerKey];
    const disposeUser=globalThis[userListenerKey];
    const disposeWindow=globalThis[windowListenerKey];
    const appearanceDisposed=is.function(dispose)?dispose():false;
    const userDisposed=is.function(disposeUser)?disposeUser():false;
    const windowDisposed=is.function(disposeWindow)?disposeWindow():false;
    return appearanceDisposed||userDisposed||windowDisposed;
}

export const arcaneThemeReady=bootstrapArcaneTheme();
export default arcaneThemeReady;

export const DOM_INTERACTION_EVENT='arcane.dom.interaction';
export const DOM_MUTATION_EVENT='arcane.dom.mutation';
export const DOM_OBSERVATION_STARTED_EVENT='arcane.dom.observation.started';
export const DOM_OBSERVATION_STOPPED_EVENT='arcane.dom.observation.stopped';

export const DEFAULT_DOM_EVENT_TYPES=[
    'auxclick','beforeinput','blur','change','click','compositionend',
    'compositionstart','compositionupdate','contextmenu','copy','cut','dblclick',
    'drag','dragend','dragenter','dragleave','dragover','dragstart','drop','focus',
    'focusin','focusout','input','keydown','keypress','keyup','paste','pointercancel',
    'pointerdown','pointerenter','pointerleave','pointermove','pointerout','pointerover',
    'pointerup','reset','scroll','selectionchange','submit','touchcancel','touchend',
    'touchmove','touchstart','wheel'
];

const EVENT_FIELDS=[
    'altKey','button','buttons','charCode','clientX','clientY','code','ctrlKey','data',
    'deltaMode','deltaX','deltaY','deltaZ','detail','inputType','key','keyCode',
    'location','metaKey','movementX','movementY','offsetX','offsetY','pageX','pageY',
    'pointerId','pointerType','repeat','screenX','screenY','shiftKey','which'
];

function capturedString(value){
    return String(value??'');
}

function cssEscape(value){
    if(typeof globalThis.CSS?.escape==='function')return globalThis.CSS.escape(value);
    return String(value).replaceAll(/[^a-zA-Z0-9_-]/gu,character=>`\\${character.codePointAt(0).toString(16)} `);
}

function readAttribute(target,name){
    try{
        return typeof target?.getAttribute==='function'?target.getAttribute(name):null;
    }catch{
        return null;
    }
}

function elementName(target){
    return String(target?.localName??target?.tagName??'element').toLowerCase();
}

function siblingIndex(target){
    const siblings=target?.parentElement?.children;
    if(!siblings)return null;
    const name=elementName(target);
    let index=0;
    for(const sibling of siblings){
        if(elementName(sibling)!==name)continue;
        index+=1;
        if(sibling===target)return index;
    }
    return null;
}

function selectorSegment(target){
    const id=String(target?.id??readAttribute(target,'id')??'');
    if(id)return `#${cssEscape(id)}`;
    for(const attribute of ['data-arcane-id','data-testid']){
        const value=readAttribute(target,attribute);
        if(value)return `[${attribute}="${cssEscape(value)}"]`;
    }
    const name=elementName(target);
    const index=siblingIndex(target);
    return index===null?name:`${name}:nth-of-type(${index})`;
}

export function domSelector(target,root){
    if(!target||typeof target!=='object')return null;
    if(target.nodeType===9)return ':document';
    if(target.nodeType===11)return ':shadow-root';
    if(target.nodeType===3)return domSelector(target.parentElement??target.parentNode,root);
    if(target.nodeType!==1&&target.localName===undefined&&target.tagName===undefined)return null;

    const groups=[];
    let segments=[];
    let current=target;
    const visited=new Set();
    while(current&&current!==root&&!visited.has(current)){
        visited.add(current);
        segments.unshift(selectorSegment(current));
        const hasId=String(current?.id??readAttribute(current,'id')??'')!=='';
        if(hasId){
            let currentRoot=null;
            try{currentRoot=current.getRootNode?.()??null;}catch{}
            if(currentRoot?.host){
                groups.unshift(segments.join(' > '));
                segments=[];
                current=currentRoot.host;
                continue;
            }
            break;
        }
        if(current.parentElement){
            current=current.parentElement;
            continue;
        }
        let currentRoot=null;
        try{currentRoot=current.getRootNode?.()??null;}catch{}
        if(currentRoot?.host){
            groups.unshift(segments.join(' > '));
            segments=[];
            current=currentRoot.host;
            continue;
        }
        break;
    }
    if(segments.length)groups.unshift(segments.join(' > '));
    return groups.join(' >>> ')||selectorSegment(target);
}

export function describeDOMTarget(target,root){
    if(!target||typeof target!=='object')return null;
    if(target.nodeType===9){
        return {kind:'document',selector:':document'};
    }
    if(target.nodeType===11){
        return {
            kind:'shadow-root',
            selector:domSelector(target.host,root),
            host:target.host?describeDOMTarget(target.host,root):null
        };
    }
    if(target.nodeType===3){
        return {
            kind:'text',
            selector:domSelector(target,root),
            content:String(target.data??target.textContent??'')
        };
    }
    if(target.nodeType!==1&&target.localName===undefined&&target.tagName===undefined){
        return {kind:target===globalThis?'global':'event-target',selector:null};
    }
    return {
        kind:'element',
        selector:domSelector(target,root),
        tagName:elementName(target),
        id:String(target.id??readAttribute(target,'id')??'')||null,
        role:readAttribute(target,'role'),
        name:readAttribute(target,'name'),
        type:String(target.type??readAttribute(target,'type')??'')||null,
        content:String(target.outerHTML??target.textContent??'')
    };
}

function targetValue(target){
    if(!target||typeof target!=='object')return undefined;
    const type=String(target.type??'').toLowerCase();
    if(type==='checkbox'||type==='radio')return Boolean(target.checked);
    if(type==='file'){
        return Array.from(target.files??[]);
    }
    if(!('value' in target))return undefined;
    return String(target.value??'');
}

function safeEventDetail(value){
    if(typeof value==='string')return capturedString(value);
    if(value===null||typeof value==='number'||typeof value==='boolean')return value;
    return value;
}

function interactionRecord(event,root){
    const path=typeof event?.composedPath==='function'?event.composedPath():[event?.target];
    const target=path.find(item=>item&&typeof item==='object')??event?.target??null;
    const eventType=String(event?.type??'');
    const details={};
    const fields=new Set([
        ...EVENT_FIELDS,
        ...Reflect.ownKeys(event??{}).filter(field=>typeof field==='string')
    ]);
    for(const field of fields){
        let value;
        try{value=event?.[field];}catch{continue;}
        if(value!==undefined&&typeof value!=='function'){
            details[field]=safeEventDetail(value);
        }
    }
    const value=targetValue(target);
    return {
        eventType,
        target:describeDOMTarget(target,root),
        path:path.map(item=>describeDOMTarget(item,root)).filter(Boolean),
        bubbles:Boolean(event?.bubbles),
        cancelable:Boolean(event?.cancelable),
        composed:Boolean(event?.composed),
        defaultPrevented:Boolean(event?.defaultPrevented),
        trusted:Boolean(event?.isTrusted),
        ...(Object.keys(details).length?{details}:{}),
        ...(value===undefined?{}:{value})
    };
}

function serializeNode(node,root){
    const descriptor=describeDOMTarget(node,root);
    let content='';
    if(node?.nodeType===3||node?.nodeType===8)content=String(node.data??node.textContent??'');
    else content=String(node?.outerHTML??node?.textContent??'');
    return {target:descriptor,content};
}

function attributeValue(value){
    if(value===null||value===undefined)return null;
    return capturedString(value);
}

function mutationRecord(record,root){
    const target=describeDOMTarget(record?.target,root);
    if(record?.type==='attributes'){
        const attributeName=String(record.attributeName??'');
        const current=readAttribute(record.target,attributeName);
        return {
            mutationType:'attributes',target,attributeName,
            namespace:record.attributeNamespace??null,
            before:attributeValue(record.oldValue),
            after:attributeValue(current)
        };
    }
    if(record?.type==='characterData'){
        return {
            mutationType:'characterData',target,
            before:record.oldValue??null,
            after:String(record.target?.data??record.target?.textContent??'')
        };
    }
    return {
        mutationType:'childList',target,
        previousSibling:describeDOMTarget(record?.previousSibling,root),
        nextSibling:describeDOMTarget(record?.nextSibling,root),
        added:Array.from(
            record?.addedNodes??[],node=>serializeNode(node,root)
        ),
        removed:Array.from(
            record?.removedNodes??[],node=>serializeNode(node,root)
        )
    };
}

function rootDescription(root){
    if(root?.nodeType===9){
        const title=String(root.title??'');
        return {
            kind:'document',
            url:root.location?.href?capturedString(root.location.href):null,
            title:title?capturedString(title):null,
            root:describeDOMTarget(root.documentElement,root)
        };
    }
    return describeDOMTarget(root,root);
}

function collectOpenShadowRoots(root){
    const roots=[];
    const candidates=[];
    try{
        if(typeof root?.querySelectorAll==='function')candidates.push(...root.querySelectorAll('*'));
    }catch{}
    for(const candidate of candidates){
        if(candidate?.shadowRoot)roots.push(candidate.shadowRoot,...collectOpenShadowRoots(candidate.shadowRoot));
    }
    return roots;
}

export function createDOMInstrumentation({
    eventManager,
    root=globalThis.document,
    eventTypes=DEFAULT_DOM_EVENT_TYPES,
    MutationObserver:MutationObserverImpl=globalThis.MutationObserver,
    captureMutations=true,
    observeOpenShadowRoots=true
}={}){
    if(!eventManager||typeof eventManager.emit!=='function'){
        throw new TypeError('DOM instrumentation requires an event manager.');
    }
    if(!root||typeof root.addEventListener!=='function'||typeof root.removeEventListener!=='function'){
        throw new TypeError('DOM instrumentation requires an EventTarget-compatible root.');
    }
    if(!Array.isArray(eventTypes)||eventTypes.some(type=>typeof type!=='string'||!type)){
        throw new TypeError('DOM event types must be non-empty strings.');
    }
    eventTypes=[...new Set(eventTypes)];
    for(const [name,value] of Object.entries({captureMutations,observeOpenShadowRoots})){
        if(typeof value!=='boolean')throw new TypeError(`${name} must be boolean.`);
    }
    const observedRoots=new Set();
    const listenerRegistrations=new Map();
    let observer=null;
    let active=false;
    let cleanupPending=false;
    let lifecycleStarted=false;
    let pendingCausationId=null;
    let causationTimer=null;

    const removeInteractionListener=(target,type,handler)=>{
        let failure=null;
        for(let attempt=0;attempt<2;attempt+=1){
            try{
                target.removeEventListener(type,handler,true);
                return null;
            }catch(error){
                failure=error;
            }
        }
        return failure;
    };

    const disconnectObserver=()=>{
        let failure=null;
        for(let attempt=0;attempt<2;attempt+=1){
            try{
                observer?.disconnect();
                return null;
            }catch(error){
                failure=error;
            }
        }
        return failure;
    };

    const cleanupResources=()=>{
        let failure=null;
        for(const target of observedRoots){
            const registrations=listenerRegistrations.get(target)??new Map();
            for(const [type,handler] of [...registrations]){
                const removalFailure=removeInteractionListener(target,type,handler);
                if(removalFailure)failure??=removalFailure;
                else registrations.delete(type);
            }
            if(registrations.size===0)listenerRegistrations.delete(target);
        }
        const observerFailure=disconnectObserver();
        failure??=observerFailure;
        if(failure){
            active=true;
            cleanupPending=true;
            return failure;
        }
        observer=null;
        listenerRegistrations.clear();
        observedRoots.clear();
        active=false;
        cleanupPending=false;
        pendingCausationId=null;
        if(causationTimer!==null){
            clearTimeout(causationTimer);
            causationTimer=null;
        }
        return null;
    };

    const publish=(type,payload,metadata)=>{
        const before=Number(eventManager.eventCount??0);
        if(typeof eventManager.instrument==='function'){
            eventManager.instrument(type,payload,{source:'dom',...metadata});
        }else{
            eventManager.emit(type,payload);
        }
        const recorded=Number(eventManager.eventCount??0)>before
            ?eventManager.history?.[before]??null
            :null;
        return recorded?.type===type?recorded:null;
    };

    const interaction=(event,observedRoot)=>{
        let path=[];
        try{
            if(typeof event?.composedPath==='function')path=event.composedPath();
        }catch{}
        const outermostObservedRoot=path.reduce(
            (selected,item)=>observedRoots.has(item)?item:selected,
            null
        );
        if(outermostObservedRoot&&outermostObservedRoot!==observedRoot){
            return;
        }
        const record=publish(
            DOM_INTERACTION_EVENT,
            interactionRecord(event,root),
            {category:'interaction'}
        );
        if(record?.id){
            pendingCausationId=record.id;
            if(causationTimer!==null)clearTimeout(causationTimer);
            causationTimer=setTimeout(()=>{
                if(pendingCausationId===record.id)pendingCausationId=null;
                causationTimer=null;
            },0);
        }
    };

    const observeRoot=target=>{
        if(!target||observedRoots.has(target))return;
        const registrations=new Map();
        observedRoots.add(target);
        listenerRegistrations.set(target,registrations);
        try{
            for(const type of eventTypes){
                const handler=event=>interaction(event,target);
                target.addEventListener(type,handler,true);
                registrations.set(type,handler);
            }
            observer?.observe(target,{
                attributes:true,
                attributeOldValue:true,
                characterData:true,
                characterDataOldValue:true,
                childList:true,
                subtree:true
            });
        }catch(error){
            for(const [type,handler] of [...registrations]){
                const removalFailure=removeInteractionListener(target,type,handler);
                if(!removalFailure)registrations.delete(type);
            }
            if(registrations.size===0){
                listenerRegistrations.delete(target);
                observedRoots.delete(target);
            }else{
                active=true;
                cleanupPending=true;
            }
            throw error;
        }
    };

    const mutations=records=>{
        for(const record of records){
            publish(DOM_MUTATION_EVENT,mutationRecord(record,root),{
                category:'mutation',
                ...(pendingCausationId?{causationId:pendingCausationId}: {})
            });
            if(observeOpenShadowRoots&&record?.type==='childList'){
                for(const node of record.addedNodes??[]){
                    if(node?.shadowRoot)observeRoot(node.shadowRoot);
                    for(const shadowRoot of collectOpenShadowRoots(node))observeRoot(shadowRoot);
                }
            }
        }
    };

    function start(){
        if(cleanupPending){
            throw new Error('DOM instrumentation cleanup is pending; retry stop() before start().');
        }
        if(active)return api;
        try{
            if(captureMutations){
                if(typeof MutationObserverImpl!=='function'){
                    throw new TypeError('MutationObserver is required when DOM mutation capture is enabled.');
                }
                observer=new MutationObserverImpl(mutations);
            }
            observeRoot(root);
            if(observeOpenShadowRoots){
                for(const shadowRoot of collectOpenShadowRoots(root))observeRoot(shadowRoot);
            }
            active=true;
            cleanupPending=false;
            publish(DOM_OBSERVATION_STARTED_EVENT,{
                root:rootDescription(root),
                eventTypes:[...eventTypes],
                captureMutations,
                observeOpenShadowRoots
            },{category:'lifecycle'});
            lifecycleStarted=true;
            return api;
        }catch(error){
            const cleanupFailure=cleanupResources();
            if(!cleanupFailure)lifecycleStarted=false;
            throw error;
        }
    }

    function stop({emitLifecycle=true}={}){
        if(typeof emitLifecycle!=='boolean')throw new TypeError('emitLifecycle must be boolean.');
        if(!active)return api;
        const shouldEmitLifecycle=emitLifecycle&&lifecycleStarted;
        if(!emitLifecycle)lifecycleStarted=false;
        const failure=cleanupResources();
        if(failure)throw failure;
        lifecycleStarted=false;
        if(shouldEmitLifecycle){
            publish(
                DOM_OBSERVATION_STOPPED_EVENT,
                {root:rootDescription(root)},
                {category:'lifecycle'}
            );
        }
        return api;
    }

    const api={
        root,
        start,
        stop,
        get active(){return active;},
        get cleanupPending(){return cleanupPending;},
        get observedRootCount(){return observedRoots.size;}
    };
    return api;
}

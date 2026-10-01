import Is from 'strong-type';

const is=new Is(false);
const registries=new WeakMap();
let fontSequence=0;

/**
 * Print current rendered DOM. Callbacks are synchronous; retain() may return a
 * resource release function. print() reports a browser request, never an output.
 * Native beforeprint cannot await readiness or cancel the browser's dialog.
 */
export function createPrintView({
    host,
    content,
    title,
    active,
    priority=0,
    signal,
    onError,
    retain
}){
    if(!host?.ownerDocument||!is.function(content)||!is.function(title)
        ||!is.function(active)||!is.finite(priority)){
        throw new TypeError('A print view requires a host, content/title/active callbacks, and a finite priority.');
    }
    if((onError!==undefined&&!is.function(onError))
        ||(retain!==undefined&&!is.function(retain))){
        throw new TypeError('Print error and resource-retention callbacks must be functions.');
    }
    const registry=documentRegistry(host.ownerDocument);
    const view={host,content,title,active,priority,onError,retain,destroyed:false,pending:null};
    registry.views.add(view);
    signal?.addEventListener('abort',destroy,{once:true});
    if(signal?.aborted){
        destroy();
    }
    return {print,destroy};

    async function print(){
        if(!available(view)){
            return false;
        }
        if(view.pending){
            return view.pending;
        }
        view.pending=printRendered(registry,view).finally(function finishRequest(){
            view.pending=null;
        });
        return view.pending;
    }

    function destroy(){
        if(view.destroyed){
            return;
        }
        view.destroyed=true;
        signal?.removeEventListener('abort',destroy);
        registry.views.delete(view);
        if(registry.session?.view===view&&!registry.session.requested){
            registry.session.controller.abort();
        }
        disposeRegistry(registry);
    }
}

function available(view){
    if(view.destroyed||!view.host.isConnected||!view.active()
        ||!view.host.getClientRects().length){
        return false;
    }
    const appearance=view.host.ownerDocument.defaultView.getComputedStyle(view.host);
    return appearance.visibility!=='hidden'&&appearance.visibility!=='collapse';
}

function documentRegistry(document){
    const existing=registries.get(document);
    if(existing){
        return existing;
    }
    const registry={document,views:new Set(),session:null,beforePrint,afterPrint};
    registries.set(document,registry);
    document.defaultView.addEventListener('beforeprint',beforePrint);
    document.defaultView.addEventListener('afterprint',afterPrint);
    return registry;

    function beforePrint(){
        let view=registry.session?.view;
        try{
            if(!view){
                for(const candidate of registry.views){
                    if(available(candidate)&&(!view||candidate.priority>=view.priority)){
                        view=candidate;
                    }
                }
            }
            if(!view){
                return;
            }
            const session=registry.session||startSession(registry,view);
            if(!session.stage){
                capture(registry,session);
            }
            session.requested=true;
        }catch(error){
            if(registry.session){
                registry.session.error=error;
                finishSession(registry,registry.session);
            }
            // beforeprint is synchronous and cannot cancel the browser's dialog.
            if(view?.onError){
                view.onError(error);
            }else{
                console.error('Unable to prepare rendered content for native printing:',error);
            }
        }
    }

    function afterPrint(){
        if(registry.session){
            finishSession(registry,registry.session);
        }
    }
}

function disposeRegistry(registry){
    if(registry.views.size||registry.session){
        return;
    }
    const window=registry.document.defaultView;
    window.removeEventListener('beforeprint',registry.beforePrint);
    window.removeEventListener('afterprint',registry.afterPrint);
    registries.delete(registry.document);
}

function startSession(registry,view){
    const session={
        view,
        controller:new AbortController(),
        requested:false,
        stage:null,
        sheet:null,
        release:null,
        fonts:[],
        fontLoads:[],
        error:null,
        originalTitle:registry.document.title,
        titleChanged:false,
        finished:false
    };
    registry.session=session;
    try{
        session.release=view.retain?.()||null;
        if(session.release&&!is.function(session.release)){
            throw new TypeError('A print resource-retention callback must return a release function.');
        }
        session.content=view.content();
        if(!session.content||!is.function(session.content.cloneNode)){
            throw new TypeError('Print content must be a rendered DOM Node.');
        }
        session.title=view.title();
        if(!is.string(session.title)){
            throw new TypeError('A print title must be a string.');
        }
        return session;
    }catch(error){
        finishSession(registry,session);
        throw error;
    }
}

async function printRendered(registry,view){
    if(registry.session){
        throw new Error('A rendered print request is already being prepared or displayed.');
    }
    const session=startSession(registry,view);
    const signal=session.controller.signal;
    try{
        await readyDocuments(session.content,signal);
        if(session.error){
            throw session.error;
        }
        if(session.requested){
            return true;
        }
        if(signal.aborted||!available(view)){
            finishSession(registry,session);
            return false;
        }
        capture(registry,session);
        const images=Array.from(session.stage.shadowRoot.querySelectorAll('img'));
        await Promise.all(images.map(function readyImage(image){
            image.loading='eager';
            if(!image.currentSrc&&!image.getAttribute('src')&&!image.getAttribute('srcset')){
                return undefined;
            }
            return abortable(image.decode(),signal);
        }));
        await abortable(Promise.all(session.fontLoads),signal);
        await abortable(registry.document.fonts.ready,signal);
        if(session.error){
            throw session.error;
        }
        if(session.requested){
            return true;
        }
        if(signal.aborted||!available(view)){
            finishSession(registry,session);
            return false;
        }
        try{
            registry.document.defaultView.print();
        }catch(error){
            session.error=error;
            throw error;
        }
        session.requested=true;
        return true;
    }catch(error){
        if(session.requested&&!session.error){
            return true;
        }
        const cancelled=signal.aborted&&!session.error;
        finishSession(registry,session);
        if(cancelled){
            return false;
        }
        throw error;
    }
}

function finishSession(registry,session){
    if(session.finished){
        return;
    }
    session.finished=true;
    session.controller.abort();
    session.stage?.remove();
    session.sheet?.remove();
    if(session.titleChanged&&registry.document.title===session.title){
        registry.document.title=session.originalTitle;
    }
    for(const face of session.fonts){
        registry.document.fonts.delete(face);
    }
    if(registry.session===session){
        registry.session=null;
    }
    try{
        if(is.function(session.release)){
            session.release();
        }
    }finally{
        session.release=null;
        disposeRegistry(registry);
    }
}

function frameDocument(frame){
    const document=frame.contentDocument;
    if(!document||!['text/html','application/xhtml+xml'].includes(document.contentType)){
        throw new Error('This embedded document is not accessible rendered HTML. Open it in its owning viewer to print.');
    }
    return document;
}

function frameReady(frame,document){
    const pendingBlank=document.URL==='about:blank'
        &&(frame.hasAttribute('srcdoc')||(frame.getAttribute('src')&&frame.src!=='about:blank'));
    return document.readyState==='complete'&&!pendingBlank;
}

async function readyDocuments(root,signal){
    const pending=[];
    const document=root.ownerDocument||root;
    if(document.fonts){
        pending.push(abortable(document.fonts.ready,signal));
    }
    visit(root);
    await Promise.all(pending);

    function visit(node){
        if(node.localName==='iframe'){
            pending.push(readyFrame(node));
            return;
        }
        for(const child of renderedChildren(node)){
            visit(child);
        }
    }

    async function readyFrame(frame){
        if(!frameReady(frame,frameDocument(frame))){
            await loaded(frame,signal);
        }
        await readyDocuments(frameDocument(frame),signal);
    }
}

function loaded(element,signal){
    return new Promise(function waitForLoad(resolve,reject){
        function finish(error){
            element.removeEventListener('load',onLoad);
            element.removeEventListener('error',onError);
            signal.removeEventListener('abort',onAbort);
            if(error){
                reject(error);
            }else{
                resolve();
            }
        }
        function onLoad(){finish();}
        function onError(){finish(new Error('An embedded print document could not finish loading.'));}
        function onAbort(){finish(signal.reason||new DOMException('Printing was cancelled.','AbortError'));}
        element.addEventListener('load',onLoad,{once:true});
        element.addEventListener('error',onError,{once:true});
        signal.addEventListener('abort',onAbort,{once:true});
        if(signal.aborted){
            onAbort();
        }
    });
}

function abortable(promise,signal){
    return new Promise(function waitForReadiness(resolve,reject){
        function onAbort(){
            signal.removeEventListener('abort',onAbort);
            reject(signal.reason||new DOMException('Printing was cancelled.','AbortError'));
        }
        signal.addEventListener('abort',onAbort,{once:true});
        if(signal.aborted){
            onAbort();
        }
        Promise.resolve(promise).then(function ready(value){
            signal.removeEventListener('abort',onAbort);
            resolve(value);
        },function failed(error){
            signal.removeEventListener('abort',onAbort);
            reject(error);
        });
    });
}

function renderedChildren(node){
    if(node.localName==='slot'){
        const assigned=node.assignedNodes({flatten:true});
        if(assigned.length){
            return assigned;
        }
    }
    return (node.shadowRoot||node).childNodes||[];
}

function capture(registry,session){
    const document=registry.document;
    const stage=document.createElement('section');
    session.stage=stage;
    stage.setAttribute('data-arcane-print-stage','');
    const root=stage.attachShadow({mode:'open'});
    const styles=document.createElement('style');
    const state={document,session,rules:[],sequence:0,documents:new Map()};
    const heading=document.createElement('h1');
    heading.textContent=session.title;
    const rendered=copyRendered(session.content,state,true);
    styles.textContent=state.rules.join('\n');
    root.append(styles,heading,rendered);
    const sheet=document.createElement('style');
    session.sheet=sheet;
    sheet.textContent=`
        [data-arcane-print-stage]{display:none!important}
        @media print{
            html:root,html:root>body{display:block!important;height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;contain:none!important}
            html:root>body>*:not([data-arcane-print-stage]){display:none!important}
            html:root>body::before,html:root>body::after{display:none!important}
            html:root>body>[data-arcane-print-stage]{display:block!important;position:static!important;width:auto!important;height:auto!important;overflow:visible!important}
        }
    `;
    document.head.append(sheet);
    document.body.append(stage);
    session.originalTitle=document.title;
    session.titleChanged=true;
    document.title=session.title;
}

function copyRendered(source,state,root=false){
    const document=state.document;
    if(source.nodeType===9){
        return copyRendered(source.documentElement,state,true);
    }
    if(source.nodeType!==1){
        const clone=source.cloneNode(false);
        for(const child of renderedChildren(source)){
            clone.append(copyRendered(child,state));
        }
        return clone;
    }
    const name=source.localName;
    if(['script','style','link','head'].includes(name)){
        return document.createDocumentFragment();
    }
    if(name==='source'&&source.parentNode?.localName==='picture'){
        // The image below carries the actual rendered currentSrc. Re-selecting
        // picture candidates could change it in the print document or viewport.
        return document.createDocumentFragment();
    }
    if(name==='object'||name==='embed'){
        throw new Error('This embedded viewer does not expose rendered HTML for printing. Open it in its owning viewer to print.');
    }
    const sourceDocument=source.ownerDocument;
    if(!state.documents.has(sourceDocument)){
        state.documents.set(sourceDocument,copyFonts(sourceDocument,state));
    }
    const neutral=name==='iframe'||name==='html'||name==='body'||name==='picture'||name.includes('-');
    let clone=neutral?document.createElement('div'):source.cloneNode(false);
    if(neutral){
        for(const attribute of source.attributes){
            clone.setAttribute(attribute.name,attribute.value);
        }
    }
    if(name==='canvas'){
        clone=document.createElement('img');
        clone.src=source.toDataURL();
    }
    const window=sourceDocument.defaultView;
    const appearance=window.getComputedStyle(source);
    for(const property of appearance){
        clone.style.setProperty(property,appearance.getPropertyValue(property));
    }
    const families=state.documents.get(sourceDocument);
    if(families.size){
        clone.style.setProperty('font-family',printFontFamily(appearance.getPropertyValue('font-family'),families));
    }
    const selector=`[data-arcane-print-node="${String(++state.sequence)}"]`;
    clone.setAttribute('data-arcane-print-node',String(state.sequence));
    for(const pseudo of ['::before','::after']){
        const style=window.getComputedStyle(source,pseudo);
        if(style.content&&style.content!=='none'&&style.content!=='normal'){
            const declarations=Array.from(style,function declaration(property){
                const value=style.getPropertyValue(property);
                return `${property}:${property==='font-family'?printFontFamily(value,families):value}`;
            });
            state.rules.push(`${selector}${pseudo}{${declarations.join(';')}}`);
        }
    }
    if(name==='img'){
        if(source.currentSrc){
            clone.src=source.currentSrc;
            clone.removeAttribute('srcset');
            clone.removeAttribute('sizes');
        }else if(source.getAttribute('src')){
            clone.src=source.src;
        }
        clone.loading='eager';
    }
    if(name==='a'&&source.getAttribute('href')){
        clone.href=source.href;
    }
    if(name==='input'||name==='textarea'||name==='select'){
        clone.value=source.value;
        if(name==='input'){
            clone.checked=source.checked;
        }
    }
    if(name==='option'){
        clone.selected=source.selected;
    }
    if(!['img','svg','video','audio','input','canvas'].includes(name)){
        for(const [property,value] of [
            ['height','auto'],['min-height','0'],['max-height','none'],
            ['width','auto'],['min-width','0'],['max-width','100%'],['overflow','visible'],
            ['contain','none'],['content-visibility','visible'],['grid-template-rows','none'],
            ['break-inside','auto']
        ]){
            clone.style.setProperty(property,value);
        }
    }else if(name==='img'||name==='canvas'){
        clone.style.setProperty('max-width','100%');
        clone.style.setProperty('height','auto');
    }
    if(['absolute','fixed','sticky'].includes(appearance.position)){
        clone.style.setProperty('position','static');
    }
    if(root||name==='iframe'){
        clone.hidden=false;
        clone.style.setProperty('display',appearance.display==='none'?'block':appearance.display);
        clone.style.setProperty('visibility','visible');
    }
    if(name==='pre'){
        clone.style.setProperty('white-space','pre-wrap');
        clone.style.setProperty('overflow-wrap','anywhere');
    }
    if(name==='table'){
        clone.style.setProperty('table-layout','auto');
    }
    if(name==='td'||name==='th'){
        clone.style.setProperty('overflow-wrap','anywhere');
        clone.style.setProperty('white-space','normal');
    }
    if(name==='iframe'){
        const embedded=frameDocument(source);
        if(!frameReady(source,embedded)){
            throw new Error('The embedded HTML preview is still loading. Print again after it finishes.');
        }
        clone.append(copyRendered(embedded,state,true));
    }else{
        for(const child of renderedChildren(source)){
            clone.append(copyRendered(child,state));
        }
    }
    return clone;
}

function copyFonts(source,state){
    const families=new Map();
    if(source===state.document){
        return families;
    }
    let definitions=null;
    const visited=new Set();
    for(const face of source.fonts){
        if(face.status!=='loaded'||state.document.fonts.has(face)){
            continue;
        }
        if(!definitions){
            definitions=[];
            for(const sheet of source.styleSheets){
                readSheet(sheet);
            }
        }
        const definition=definitions.find(function matchingFont({style}){
            return fontFamilyName(style.getPropertyValue('font-family'))===fontFamilyName(face.family)
                &&(style.getPropertyValue('font-style')||'normal')===face.style
                &&(style.getPropertyValue('font-weight')||'normal')===face.weight
                &&(style.getPropertyValue('font-stretch')||'normal')===face.stretch
                &&(style.getPropertyValue('unicode-range')||'U+0-10FFFF')===face.unicodeRange;
        });
        if(!definition){
            throw new Error('An embedded document font does not expose its source. Open that document in its owning viewer to print.');
        }
        const family=fontFamilyName(face.family);
        if(!families.has(family)){
            families.set(family,`ArcanePrint-${String(++fontSequence)}`);
        }
        const src=definition.style.getPropertyValue('src').replace(
            /url\("((?:\\.|[^"\\])*)"\)/gu,
            function absoluteFontURL(match,value){
                return `url(${JSON.stringify(new URL(cssString(value),definition.base).href)})`;
            }
        );
        const copy=new state.document.defaultView.FontFace(families.get(family),src,{
            style:face.style,
            weight:face.weight,
            stretch:face.stretch,
            unicodeRange:face.unicodeRange,
            featureSettings:face.featureSettings,
            variationSettings:face.variationSettings,
            display:face.display
        });
        state.document.fonts.add(copy);
        state.session.fonts.push(copy);
        // The source has already loaded this face. The snapshot may reuse the
        // browser's resource cache; explicit printing observes actual readiness.
        const ready=copy.load();
        state.session.fontLoads.push(ready);
        void ready.catch(function observeNativeFontError(error){
            if(state.session.requested&&!state.session.finished){
                if(state.session.view.onError){
                    state.session.view.onError(error);
                }else{
                    console.error('Unable to load an embedded print font:',error);
                }
            }
        });
    }
    return families;

    function readSheet(sheet){
        if(visited.has(sheet)){
            return;
        }
        visited.add(sheet);
        let rules;
        try{
            rules=sheet.cssRules;
        }catch(error){
            if(error.name==='SecurityError'){
                return;
            }
            throw error;
        }
        readRules(rules,sheet.href||source.baseURI);
    }

    function readRules(rules,base){
        for(const rule of rules){
            if(rule.type===5){
                definitions.push({style:rule.style,base});
            }else if(rule.styleSheet){
                readSheet(rule.styleSheet);
            }else if(rule.cssRules){
                readRules(rule.cssRules,base);
            }
        }
    }
}

function cssString(value){
    return value.replace(/\\([\da-f]{1,6}\s?|.)/giu,function cssEscape(escape,character){
        return /^[\da-f]/iu.test(character)
            ?String.fromCodePoint(parseInt(character.trim(),16)||0xfffd)
            :character;
    });
}

function fontFamilyName(value){
    const name=value.trim();
    return cssString(name.replace(/^(?:"(.*)"|'(.*)')$/u,function unquote(match,double,single){
        return double??single;
    })).toLowerCase();
}

function printFontFamily(value,families){
    return value.replace(/(?:[^,"']|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')+/gu,function family(name){
        return families.get(fontFamilyName(name))||name;
    });
}

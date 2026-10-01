import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import test from '../src/testing.mjs';
import {arcaneLightThemeTokens} from '../runtime/arcane/entities/Theme.js';

const printStyleURL=new URL('../runtime/arcane/css/print.css',import.meta.url);
const sharedPrintStyles=await readFile(printStyleURL,'utf8');
const originalFetch=globalThis.fetch;
let printStyleFetches=0;
let createPrintView;
try{
    globalThis.fetch=async function sharedPrintStylesFetchDouble(url){
        assert.equal(String(url),printStyleURL.href);
        printStyleFetches++;
        return {ok:true,status:200,text:async function completeStyleText(){return sharedPrintStyles;}};
    };
    ({createPrintView}=await import('../runtime/arcane/modules/PrintView.js'));
}finally{
    globalThis.fetch=originalFetch;
}

// These DOM, layout, image, font and print-dialog doubles exercise ownership and
// snapshot construction. They do not establish browser pagination or dialog UI.
class FixtureStyle extends Map{
    setProperty(property,value){this.set(property,String(value));}
    getPropertyValue(property){return this.get(property)||'';}
    [Symbol.iterator](){return this.keys();}
    get display(){return this.getPropertyValue('display');}
    get visibility(){return this.getPropertyValue('visibility');}
    get position(){return this.getPropertyValue('position');}
    get content(){return this.getPropertyValue('content');}
}

class FixtureNode extends EventTarget{
    constructor(document,name='',nodeType=1){
        super();
        this.ownerDocument=document;
        this.localName=name;
        this.namespaceURI='http://www.w3.org/1999/xhtml';
        this.nodeType=nodeType;
        this.childNodes=[];
        this.parentNode=null;
        this.attributes=[];
        this.style=new FixtureStyle();
        this.appearance={display:'block',visibility:'visible',position:'static',overflow:'auto',height:'240px'};
        this.pseudo={};
        this.rects=[{}];
        this.data='';
        this.currentSrc='';
        this.decodeResult=Promise.resolve();
    }

    get isConnected(){
        return this.nodeType===9||Boolean(this.parentNode?.isConnected||this.host?.isConnected);
    }
    getClientRects(){return this.rects;}
    setAttribute(name,value){
        const previous=this.attributes.find(function named(attribute){return attribute.name===name;});
        if(previous){
            previous.value=String(value);
        }else{
            this.attributes.push({name,value:String(value)});
        }
    }
    getAttribute(name){
        return this.attributes.find(function named(attribute){return attribute.name===name;})?.value??null;
    }
    hasAttribute(name){return this.getAttribute(name)!==null;}
    removeAttribute(name){
        this.attributes=this.attributes.filter(function other(attribute){return attribute.name!==name;});
    }
    get src(){return new URL(this.getAttribute('src')||'',this.ownerDocument.baseURI).href;}
    set src(value){this.setAttribute('src',value);}
    get href(){return new URL(this.getAttribute('href')||'',this.ownerDocument.baseURI).href;}
    set href(value){this.setAttribute('href',value);}
    get hidden(){return this.hasAttribute('hidden');}
    set hidden(value){
        if(value){this.setAttribute('hidden','');}
        else{this.removeAttribute('hidden');}
    }
    get textContent(){
        return this.nodeType===3?this.data:this.childNodes.map(function text(child){return child.textContent;}).join('');
    }
    set textContent(value){
        this.childNodes=[];
        if(this.nodeType===3){this.data=String(value);}
        else{this.append(this.ownerDocument.createTextNode(String(value)));}
    }
    append(...nodes){
        for(const node of nodes){
            if(node.nodeType===11&&!node.host){
                this.append(...node.childNodes);
            }else{
                node.parentNode=this;
                this.childNodes.push(node);
            }
        }
    }
    remove(){
        if(this.parentNode){
            const parent=this.parentNode;
            parent.childNodes=parent.childNodes.filter(function other(child){return child!==this;},this);
            this.parentNode=null;
        }
    }
    attachShadow(){
        this.shadowRoot=new FixtureNode(this.ownerDocument,'',11);
        this.shadowRoot.host=this;
        return this.shadowRoot;
    }
    querySelectorAll(name){
        const found=[];
        function visit(node){
            for(const child of node.childNodes){
                if(child.localName===name){found.push(child);}
                visit(child);
            }
        }
        visit(this);
        return found;
    }
    cloneNode(){
        const copy=new FixtureNode(this.ownerDocument,this.localName,this.nodeType);
        copy.namespaceURI=this.namespaceURI;
        copy.attributes=this.attributes.map(function copyAttribute(attribute){return {...attribute};});
        copy.data=this.data;
        copy.decodeResult=this.decodeResult;
        copy.decodeStarted=this.decodeStarted;
        copy.value=this.value;
        copy.checked=this.checked;
        copy.selected=this.selected;
        return copy;
    }
    decode(){
        this.ownerDocument.decodeCalls.push(this);
        this.decodeStarted?.resolve();
        return this.decodeResult;
    }
}

class FixtureFontSet extends Set{
    constructor(){
        super();
        this.ready=Promise.resolve();
    }
    add(face){
        if(face.cssConnected&&this!==face.owner){
            throw new DOMException('CSS-owned font','InvalidModificationError');
        }
        return super.add(face);
    }
}

function fixtureDocument(url='https://print.example.test/app/'){
    const document=new FixtureNode(null,'',9);
    document.ownerDocument=null;
    document.URL=url;
    document.baseURI=url;
    document.readyState='complete';
    document.contentType='text/html';
    document.title='Original application title';
    document.fonts=new FixtureFontSet();
    document.styleSheets=[];
    document.decodeCalls=[];
    document.fontCopies=[];
    document.createElement=function createElement(name){return new FixtureNode(document,name);};
    document.createElementNS=function createElementNS(namespace,name){
        const node=new FixtureNode(document,name);
        node.namespaceURI=namespace;
        return node;
    };
    document.createDocumentFragment=function createDocumentFragment(){return new FixtureNode(document,'',11);};
    document.createTextNode=function createTextNode(text){
        const node=new FixtureNode(document,'',3);
        node.data=text;
        return node;
    };
    document.documentElement=document.createElement('html');
    document.head=document.createElement('head');
    document.body=document.createElement('body');
    document.append(document.documentElement);
    document.documentElement.append(document.head,document.body);
    const window=new EventTarget();
    const listeners=new Map();
    const add=window.addEventListener.bind(window);
    const remove=window.removeEventListener.bind(window);
    window.addEventListener=function addListener(type,callback){
        if(!listeners.has(type)){listeners.set(type,new Set());}
        listeners.get(type).add(callback);
        add(type,callback);
    };
    window.removeEventListener=function removeListener(type,callback){
        listeners.get(type)?.delete(callback);
        remove(type,callback);
    };
    window.listenerCount=function listenerCount(type){return listeners.get(type)?.size||0;};
    window.printCalls=0;
    window.print=function requestDialog(){
        window.printCalls++;
        window.dispatchEvent(new Event('beforeprint'));
    };
    window.getComputedStyle=function computedStyle(node,pseudo){
        return new FixtureStyle(Object.entries(pseudo
            ?{content:'none',...node.pseudo[pseudo]}
            :{...node.appearance,...Object.fromEntries(node.style.entries())}));
    };
    window.FontFace=class FixtureFontFace{
        constructor(family,source,descriptors){
            Object.assign(this,descriptors,{family,source,status:'unloaded'});
            document.fontCopies.push(this);
        }
        load(){this.status='loaded';return Promise.resolve(this);}
    };
    document.defaultView=window;
    return document;
}

function printStage(document){
    return document.body.childNodes.find(function stage(node){return node.hasAttribute('data-arcane-print-stage');});
}

function addView(context,document,options={}){
    const host=document.createElement('arcane-fixture');
    const content=document.createElement('section');
    const errors=[];
    const resources={retained:0,released:0};
    const state={active:true};
    host.append(content);
    document.body.append(host);
    const view=createPrintView({
        host,
        content:function renderedContent(){return content;},
        title:function renderedTitle(){return 'Moon-library receipt';},
        active:function activeView(){return state.active;},
        onError:function reportError(error){errors.push(error);},
        retain:function retainResources(){
            resources.retained++;
            return function releaseResources(){resources.released++;};
        },
        ...options
    });
    context.after(function cleanup(){
        document.defaultView.dispatchEvent(new Event('afterprint'));
        view.destroy();
    });
    return {view,host,content,errors,resources,state};
}

function deferred(){
    let resolve;
    let reject;
    const promise=new Promise(function pending(onResolve,onReject){resolve=onResolve;reject=onReject;});
    return {promise,resolve,reject};
}

test('rendered print preserves complete DOM, title, image selection and styles without editing the screen',async function explicitSnapshot(context){
    const document=fixtureDocument();
    const fixture=addView(context,document);
    const message='  The Moon librarian kept every line.\n第二行 — 🦉\nLast line.  ';
    const pre=document.createElement('pre');
    pre.textContent=message;
    pre.appearance={...pre.appearance,'max-height':'240px','white-space':'pre',color:'rgb(20, 30, 40)'};
    pre.pseudo['::before']={content:'"Ledger:"',color:'rgb(50, 60, 70)'};
    const image=document.createElement('img');
    image.src='portrait.png';
    image.currentSrc='https://print.example.test/app/portrait-large.png';
    image.setAttribute('srcset','portrait.png 1x, portrait-large.png 2x');
    const table=document.createElement('table');
    const row=document.createElement('tr');
    const cell=document.createElement('td');
    cell.textContent='All columns remain rendered';
    row.append(cell);
    table.append(row);
    fixture.content.append(pre,image,table);
    fixture.content.hidden=true;
    fixture.content.appearance.display='none';

    assert.equal(await fixture.view.print(),true);
    assert.equal(document.defaultView.printCalls,1);
    const stage=printStage(document);
    const snapshot=stage.shadowRoot;
    assert.equal(snapshot.querySelectorAll('h1')[0].textContent,'Moon-library receipt');
    assert.equal(snapshot.querySelectorAll('pre')[0].textContent,message);
    assert.equal(snapshot.querySelectorAll('pre')[0].style.getPropertyValue('white-space'),'pre');
    assert.equal(snapshot.querySelectorAll('pre')[0].style.getPropertyValue('overflow'),'auto');
    assert.equal(snapshot.querySelectorAll('pre')[0].hasAttribute('data-arcane-print-expand'),true);
    assert.match(sharedPrintStyles,/pre\[data-arcane-print-node\]\{white-space:pre-wrap!important;overflow-wrap:anywhere!important;/u);
    assert.match(sharedPrintStyles,/\[data-arcane-print-expand\]\{[^}]*overflow:visible!important;/u);
    assert.equal(snapshot.querySelectorAll('pre')[0].style.getPropertyValue('color'),'rgb(20, 30, 40)');
    assert.match(snapshot.querySelectorAll('style')[0].textContent,/Ledger:/u);
    assert.equal(snapshot.querySelectorAll('img')[0].src,image.currentSrc);
    assert.equal(snapshot.querySelectorAll('img')[0].hasAttribute('srcset'),false);
    assert.equal(snapshot.querySelectorAll('td')[0].textContent,cell.textContent);
    assert.equal(snapshot.querySelectorAll('section')[0].style.getPropertyValue('display'),'none');
    assert.equal(snapshot.querySelectorAll('section')[0].hasAttribute('data-arcane-print-block'),true);
    assert.equal(snapshot.querySelectorAll('section')[0].hasAttribute('data-arcane-print-root'),true);
    assert.match(sharedPrintStyles,/\[data-arcane-print-block\]\{display:block!important;/u);
    assert.equal(document.title,'Moon-library receipt');
    assert.equal(fixture.content.hidden,true);
    assert.equal(pre.appearance['max-height'],'240px');
    assert.equal(pre.style.size,0);
    assert.equal(fixture.resources.released,0);
    document.defaultView.dispatchEvent(new Event('afterprint'));
    assert.equal(printStage(document),undefined);
    assert.equal(document.title,'Original application title');
    assert.equal(fixture.resources.released,1);
});

test('explicit and native snapshots use the same ready stylesheet and one-inch margins without changing the screen',async function lightPrintPresentation(context){
    const presentations=[];
    for(const mode of ['explicit','native']){
        const document=fixtureDocument();
        document.documentElement.setAttribute('data-color-scheme','dark');
        document.documentElement.setAttribute('data-user-skin','warm');
        document.body.style.setProperty('background-color','rgb(20, 20, 20)');
        const screenSheet=document.createElement('style');
        screenSheet.textContent=':root{color-scheme:dark}';
        document.head.append(screenSheet);
        const fixture=addView(context,document);
        fixture.content.scrollTop=420;
        fixture.content.scrollLeft=18;
        const paragraph=document.createElement('p');
        paragraph.textContent='Every word survives the theme change.\n第二行 — 🦉';
        paragraph.appearance={...paragraph.appearance,
            color:'rgb(240, 240, 240)',
            'background-color':'rgb(20, 20, 20)',
            'background-image':'url("https://print.example.test/illustration.png")',
            'font-family':'Moon Serif, serif',
            'font-size':'19px',
            'line-height':'31px',
            'font-weight':'700',
            'font-style':'italic',
            margin:'12px 8px',
            padding:'6px',
            opacity:'.4',
            filter:'drop-shadow(0 1px 1px black)',
            '-webkit-text-fill-color':'rgb(240, 240, 240)'
        };
        paragraph.pseudo['::before']={content:'"Full ledger:"',color:'white',opacity:'.5'};
        fixture.content.append(paragraph);
        if(mode==='explicit'){
            assert.equal(await fixture.view.print(),true);
        }else{
            document.defaultView.dispatchEvent(new Event('beforeprint'));
        }
        const snapshot=printStage(document).shadowRoot;
        const palette=snapshot.querySelectorAll('style')[0].textContent;
        const pageSheet=document.head.childNodes.find(function printSheet(node){return node!==screenSheet;});
        assert.ok(palette.startsWith(sharedPrintStyles));
        assert.equal(pageSheet.textContent,sharedPrintStyles);
        assert.ok(palette.includes(`--arcane-print-text:${arcaneLightThemeTokens.text};`));
        assert.ok(palette.includes(`--arcane-print-paper:${arcaneLightThemeTokens.surface};`));
        assert.ok(palette.includes(`--arcane-print-border:${arcaneLightThemeTokens.border};`));
        assert.ok(palette.includes('border:1px solid var(--arcane-print-border)!important'));
        assert.ok(palette.includes('[data-arcane-print-node]:not(svg,svg *,img,video,audio)::before'));
        assert.ok(palette.includes('[data-arcane-print-node]:not(svg,svg *,img,video,audio)::after'));
        assert.match(palette,/background-color:transparent!important/u);
        assert.match(palette,/-webkit-text-fill-color:currentColor!important/u);
        assert.doesNotMatch(palette,/(?:^|[;{\n])\s*(?:opacity|filter|mix-blend-mode):[^;\n}]*!important/u);
        assert.match(palette,/Full ledger:/u);
        assert.doesNotMatch(palette,/background-image:none/u);
        assert.match(pageSheet.textContent,/@media print\s*\{\s*@page\{margin:1in;\}/u);
        assert.equal(printStyleFetches,1,'Native and explicit printing reuse the stylesheet loaded before registration.');
        assert.ok(pageSheet.textContent.includes('background:var(--arcane-print-paper)!important'));
        const printed=snapshot.querySelectorAll('p')[0];
        assert.equal(printed.textContent,paragraph.textContent);
        for(const property of ['font-family','font-size','line-height','font-weight','font-style','margin','padding','background-image','opacity','filter']){
            assert.equal(printed.style.getPropertyValue(property),paragraph.appearance[property]);
        }
        // The double inspects authored CSS, not browser cascade or pagination.
        // !important paper rules supersede the copied screen paint in the browser.
        assert.equal(printed.style.getPropertyValue('color'),paragraph.appearance.color);
        assert.equal(document.documentElement.getAttribute('data-color-scheme'),'dark');
        assert.equal(document.documentElement.getAttribute('data-user-skin'),'warm');
        assert.equal(document.body.style.getPropertyValue('background-color'),'rgb(20, 20, 20)');
        assert.equal(fixture.content.scrollTop,420);
        assert.equal(fixture.content.scrollLeft,18);
        assert.equal(paragraph.style.size,0);
        assert.equal(fixture.resources.released,0);
        presentations.push({palette,page:pageSheet.textContent});
        document.defaultView.dispatchEvent(new Event('afterprint'));
        assert.deepEqual(document.head.childNodes,[screenSheet]);
        assert.equal(printStage(document),undefined);
        assert.equal(fixture.resources.released,1);
    }
    assert.deepEqual(presentations[0],presentations[1]);
});

test('chat snapshot selectors exclude inspection and transient status without editing conversation markup',async function chatPrintPresentation(context){
    const document=fixtureDocument();
    const fixture=addView(context,document);
    fixture.content.setAttribute('class','chat_output');
    const item=document.createElement('li');
    const content=document.createElement('div');
    content.setAttribute('class','markdown');
    content.textContent='The complete human-visible conversation remains.\n第二行 — 🦉';
    const thinking=document.createElement('span');
    thinking.setAttribute('class','thinking');
    thinking.textContent='Working';
    const tools=document.createElement('section');
    tools.setAttribute('class','message_tool_calls');
    const tool=document.createElement('article');
    tool.setAttribute('class','message_tool_call');
    const message=document.createElement('p');
    message.setAttribute('class','message_tool_message');
    message.textContent='The telescope is ready.';
    const details=document.createElement('details');
    details.setAttribute('class','message_tool_details');
    details.textContent='Complete diagnostic inspection';
    tool.append(message,details);
    tools.append(tool);
    item.append(content,thinking,tools);
    fixture.content.append(item);

    assert.equal(await fixture.view.print(),true);
    const snapshot=printStage(document).shadowRoot;
    assert.ok(snapshot.querySelectorAll('div').some(node=>node.textContent===content.textContent));
    assert.equal(snapshot.querySelectorAll('p')[0].textContent,message.textContent);
    assert.equal(snapshot.querySelectorAll('section')[0].getAttribute('class'),'chat_output');
    // This double checks scoped authored selectors and preserved DOM; it does
    // not claim to evaluate :has(), the CSS cascade, or browser pagination.
    assert.match(sharedPrintStyles,/\.chat_output\[data-arcane-print-node\]>li\{[^}]*float:none!important;[^}]*text-align:start!important;/u);
    assert.ok(sharedPrintStyles.includes('.chat_output[data-arcane-print-node]>li [data-arcane-print-node]:not(.message_timestamp)'));
    assert.ok(sharedPrintStyles.includes('thead[data-arcane-print-node]{display:table-header-group!important;}'));
    assert.ok(sharedPrintStyles.includes('.chat_output[data-arcane-print-node]>li>.thinking,'));
    assert.ok(sharedPrintStyles.includes('.chat_output[data-arcane-print-node]>li>.message_tool_details,'));
    assert.ok(sharedPrintStyles.includes('.chat_output[data-arcane-print-node]>li>.message_tool_calls>.message_tool_call>.message_tool_details,'));
    assert.ok(sharedPrintStyles.includes('>li:has(>.thinking):has(>.markdown:empty):not(:has(.message_tool_message))'));
    assert.equal(fixture.content.hasAttribute('data-arcane-print-node'),false);
    assert.equal(details.parentNode,tool);
    assert.equal(thinking.parentNode,item);
});

test('light print presentation preserves SVG paint, selected image and canvas pixels, and live form values',async function preservedPrintArtwork(context){
    const document=fixtureDocument();
    const fixture=addView(context,document);
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 200 100');
    svg.appearance={...svg.appearance,color:'rgb(200, 40, 30)',fill:'currentColor',filter:'url("#artwork-shadow")'};
    const shape=document.createElementNS(svg.namespaceURI,'path');
    shape.setAttribute('d','M 0 0 L 200 100');
    shape.appearance={...shape.appearance,fill:'rgb(30, 120, 200)',stroke:'rgb(200, 80, 30)'};
    svg.append(shape);
    const image=document.createElement('img');
    image.src='original.png';
    image.currentSrc='https://print.example.test/selected-artwork.png';
    image.appearance={...image.appearance,filter:'contrast(1.2)',opacity:'.8'};
    const canvas=document.createElement('canvas');
    const pixels='data:image/png;base64,c3ludGhldGljLWNhbnZhcy1maXh0dXJl';
    canvas.toDataURL=function renderedPixels(){return pixels;};
    const input=document.createElement('input');
    input.value='Complete current value';
    input.checked=true;
    const select=document.createElement('select');
    const option=document.createElement('option');
    option.textContent='Current selection';
    option.selected=true;
    select.value='current';
    select.append(option);
    fixture.content.append(svg,image,canvas,input,select);
    assert.equal(await fixture.view.print(),true);
    const snapshot=printStage(document).shadowRoot;
    const printedSVG=snapshot.querySelectorAll('svg')[0];
    assert.equal(printedSVG.namespaceURI,svg.namespaceURI);
    assert.equal(printedSVG.getAttribute('viewBox'),'0 0 200 100');
    assert.equal(printedSVG.style.getPropertyValue('color'),svg.appearance.color);
    assert.equal(printedSVG.style.getPropertyValue('filter'),svg.appearance.filter);
    const printedShape=snapshot.querySelectorAll('path')[0];
    assert.equal(printedShape.getAttribute('d'),shape.getAttribute('d'));
    assert.equal(printedShape.style.getPropertyValue('fill'),shape.appearance.fill);
    assert.equal(printedShape.style.getPropertyValue('stroke'),shape.appearance.stroke);
    assert.equal(snapshot.querySelectorAll('img')[0].src,image.currentSrc);
    assert.equal(snapshot.querySelectorAll('img')[0].style.getPropertyValue('filter'),image.appearance.filter);
    assert.equal(snapshot.querySelectorAll('img')[1].src,pixels);
    assert.equal(snapshot.querySelectorAll('input')[0].value,input.value);
    assert.equal(snapshot.querySelectorAll('input')[0].checked,true);
    assert.equal(snapshot.querySelectorAll('select')[0].value,select.value);
    assert.equal(snapshot.querySelectorAll('option')[0].selected,true);
});

test('one native-print registry chooses the active preview and explicit Print still selects its own view',async function nativeSelection(context){
    const document=fixtureDocument();
    const editor=addView(context,document);
    editor.content.textContent='Rendered editor';
    const preview=addView(context,document,{priority:1});
    preview.content.textContent='Rendered preview';
    const hidden=addView(context,document,{priority:2});
    hidden.host.rects=[];
    hidden.content.textContent='Hidden view';
    assert.equal(document.defaultView.listenerCount('beforeprint'),1);
    assert.equal(document.defaultView.listenerCount('afterprint'),1);
    document.defaultView.dispatchEvent(new Event('beforeprint'));
    assert.match(printStage(document).shadowRoot.textContent,/Rendered preview/u);
    assert.doesNotMatch(printStage(document).shadowRoot.textContent,/Rendered editor|Hidden view/u);
    assert.equal(document.defaultView.printCalls,0);
    document.defaultView.dispatchEvent(new Event('afterprint'));
    assert.equal(await editor.view.print(),true);
    assert.match(printStage(document).shadowRoot.textContent,/Rendered editor/u);
    document.defaultView.dispatchEvent(new Event('afterprint'));
    preview.state.active=false;
    document.defaultView.dispatchEvent(new Event('beforeprint'));
    assert.match(printStage(document).shadowRoot.textContent,/Rendered editor/u);
    document.defaultView.dispatchEvent(new Event('afterprint'));
    editor.host.remove();
    assert.equal(await editor.view.print(),false);
    editor.view.destroy();
    preview.view.destroy();
    hidden.view.destroy();
    assert.equal(document.defaultView.listenerCount('beforeprint'),0);
    assert.equal(document.defaultView.listenerCount('afterprint'),0);
});

test('same-origin rendered HTML frames become complete flowing DOM with resolved images',async function flattenedFrame(context){
    const document=fixtureDocument();
    const fixture=addView(context,document);
    const frame=document.createElement('iframe');
    frame.setAttribute('srcdoc','Fixture source is deliberately different from rendered DOM.');
    const embedded=fixtureDocument('about:srcdoc');
    embedded.baseURI='https://print.example.test/documents/';
    frame.contentDocument=embedded;
    const first=embedded.createElement('p');
    first.textContent='Already-rendered beginning';
    first.appearance.color='rgb(80, 90, 100)';
    const image=embedded.createElement('img');
    image.src='diagram.png';
    image.currentSrc='https://print.example.test/documents/diagram.png';
    const picture=embedded.createElement('picture');
    const candidate=embedded.createElement('source');
    candidate.setAttribute('srcset','different-print-candidate.png');
    candidate.setAttribute('media','print');
    picture.append(candidate,image);
    const last=embedded.createElement('p');
    last.textContent='Complete ending below the screen viewport';
    embedded.body.append(first,picture,last);
    fixture.content.append(frame);
    assert.equal(await fixture.view.print(),true);
    const snapshot=printStage(document).shadowRoot;
    assert.equal(snapshot.querySelectorAll('iframe').length,0);
    assert.equal(snapshot.querySelectorAll('p')[1].textContent,last.textContent);
    assert.equal(snapshot.querySelectorAll('p')[0].style.getPropertyValue('color'),'rgb(80, 90, 100)');
    assert.equal(snapshot.querySelectorAll('img')[0].src,image.currentSrc);
    assert.equal(snapshot.querySelectorAll('picture').length,0);
    assert.equal(snapshot.querySelectorAll('source').length,0);
    assert.doesNotMatch(snapshot.textContent,/deliberately different/u);
    assert.equal(frame.contentDocument,embedded);
    assert.equal(frame.getAttribute('srcdoc'),'Fixture source is deliberately different from rendered DOM.');
    assert.equal(embedded.body.childNodes.length,3);
});

test('image readiness is abortable and retains source resources exactly through preparation',async function cancelledPreparation(context){
    const document=fixtureDocument();
    const controller=new AbortController();
    const fixture=addView(context,document,{signal:controller.signal});
    const image=document.createElement('img');
    image.src='pending.png';
    const pending=deferred();
    const started=deferred();
    image.decodeResult=pending.promise;
    image.decodeStarted=started;
    fixture.content.append(image);
    const printing=fixture.view.print();
    await started.promise;
    controller.abort();
    assert.equal(await printing,false);
    assert.equal(document.defaultView.printCalls,0);
    assert.equal(fixture.resources.retained,1);
    assert.equal(fixture.resources.released,1);
    assert.equal(printStage(document),undefined);
    assert.equal(await fixture.view.print(),false);
    pending.resolve();
});

test('destroy after dialog request preserves the snapshot and media until afterprint',async function deferredRelease(context){
    const document=fixtureDocument();
    const fixture=addView(context,document);
    fixture.content.textContent='Keep this rendered page until the browser finishes';
    assert.equal(await fixture.view.print(),true);
    const stage=printStage(document);
    fixture.view.destroy();
    assert.equal(printStage(document),stage);
    assert.equal(fixture.resources.released,0);
    assert.equal(document.defaultView.listenerCount('afterprint'),1);
    document.defaultView.dispatchEvent(new Event('afterprint'));
    assert.equal(fixture.resources.released,1);
    assert.equal(printStage(document),undefined);
    assert.equal(document.defaultView.listenerCount('beforeprint'),0);
    assert.equal(document.defaultView.listenerCount('afterprint'),0);
    document.defaultView.dispatchEvent(new Event('afterprint'));
    assert.equal(fixture.resources.released,1);
});

test('inaccessible and native PDF frames reject explicit printing and report native preparation failure',async function inaccessibleFrames(context){
    for(const contentType of [null,'application/pdf']){
        const document=fixtureDocument();
        const fixture=addView(context,document);
        const frame=document.createElement('iframe');
        frame.contentDocument=contentType?fixtureDocument():null;
        if(frame.contentDocument){frame.contentDocument.contentType=contentType;}
        fixture.content.append(frame);
        await assert.rejects(fixture.view.print(),/not accessible rendered HTML/u);
        assert.equal(document.defaultView.printCalls,0);
        assert.equal(printStage(document),undefined);
        assert.equal(fixture.resources.released,1);
        document.defaultView.dispatchEvent(new Event('beforeprint'));
        assert.equal(fixture.errors.length,1);
        assert.match(fixture.errors[0].message,/not accessible rendered HTML/u);
        assert.equal(printStage(document),undefined);
        assert.equal(fixture.resources.released,2);
    }
});

test('pending iframe readiness precedes the explicit browser request',async function readiness(context){
    const document=fixtureDocument();
    const fixture=addView(context,document);
    const frame=document.createElement('iframe');
    frame.setAttribute('srcdoc','The existing HTML document');
    const embedded=fixtureDocument('about:blank');
    embedded.baseURI=document.baseURI;
    frame.contentDocument=embedded;
    embedded.readyState='loading';
    embedded.body.textContent='Current frame body';
    fixture.content.append(frame);
    const printing=fixture.view.print();
    assert.equal(document.defaultView.printCalls,0);
    assert.equal(printStage(document),undefined);
    embedded.URL='about:srcdoc';
    embedded.readyState='complete';
    frame.dispatchEvent(new Event('load'));
    assert.equal(await printing,true);
    assert.equal(document.defaultView.printCalls,1);
    assert.match(printStage(document).shadowRoot.textContent,/Current frame body/u);
});

test('optional print preparation follows document readiness and captures a fresh synchronous content read',async function currentPreparedContent(context){
    const document=fixtureDocument();
    const fonts=deferred();
    document.fonts.ready=fonts.promise;
    const entered=deferred();
    const prepared=deferred();
    const first=document.createElement('section');
    first.textContent='Earlier rendered entry';
    const latest=document.createElement('section');
    latest.textContent='Complete latest rendered entry';
    latest.appearance.color='rgb(70, 80, 90)';
    let current=first;
    let preparationCalls=0;
    const reads=[];
    const fixture=addView(context,document,{
        content(){reads.push(current);return current;},
        title(){return current===first?'Earlier title':'Complete latest title';},
        prepare(signal){
            preparationCalls++;
            assert.equal(signal.aborted,false);
            entered.resolve();
            return prepared.promise;
        }
    });
    fixture.host.append(first);
    const printing=fixture.view.print();
    assert.equal(preparationCalls,0);
    assert.deepEqual(reads,[first]);
    fonts.resolve();
    await entered.promise;
    first.remove();
    fixture.host.append(latest);
    current=latest;
    prepared.resolve();
    assert.equal(await printing,true);
    assert.deepEqual(reads,[first,latest]);
    assert.equal(preparationCalls,1);
    const snapshot=printStage(document).shadowRoot;
    assert.equal(snapshot.querySelectorAll('h1')[0].textContent,'Complete latest title');
    assert.equal(document.title,'Complete latest title');
    assert.match(snapshot.textContent,/Complete latest rendered entry/u);
    assert.doesNotMatch(snapshot.textContent,/Earlier rendered entry/u);
    assert.equal(snapshot.querySelectorAll('section')[0].style.getPropertyValue('color'),'rgb(70, 80, 90)');
    assert.equal(fixture.resources.released,0);
    document.defaultView.dispatchEvent(new Event('afterprint'));
    assert.equal(fixture.resources.released,1);
});

test('optional print preparation cancellation settles without waiting for an uncooperative callback',async function cancelledViewPreparation(context){
    const document=fixtureDocument();
    const controller=new AbortController();
    const entered=deferred();
    const pending=deferred();
    let preparationSignal;
    const fixture=addView(context,document,{
        signal:controller.signal,
        prepare(signal){preparationSignal=signal;entered.resolve();return pending.promise;}
    });
    const printing=fixture.view.print();
    await entered.promise;
    controller.abort();
    assert.equal(await printing,false);
    assert.equal(preparationSignal.aborted,true);
    assert.equal(fixture.resources.released,1);
    assert.equal(document.defaultView.printCalls,0);
    assert.equal(printStage(document),undefined);
    pending.resolve();
    await Promise.resolve();
    assert.equal(document.defaultView.printCalls,0);
});

test('an iframe inserted during print preparation must expose a ready rendered document',async function latePendingFrame(context){
    const document=fixtureDocument();
    const fixture=addView(context,document,{
        prepare(){
            const frame=document.createElement('iframe');
            frame.setAttribute('srcdoc','The complete document is still being loaded.');
            frame.contentDocument=fixtureDocument('about:blank');
            frame.contentDocument.readyState='complete';
            fixture.content.append(frame);
        }
    });
    await assert.rejects(fixture.view.print(),/embedded HTML preview is still loading/u);
    assert.equal(fixture.resources.released,1);
    assert.equal(printStage(document),undefined);
    assert.equal(document.defaultView.printCalls,0);
});

test('a final synchronous content guard rejects changes arriving during async preparation',async function changedAfterPreparation(context){
    const document=fixtureDocument();
    const failure=new Error('The latest image is still loading.');
    let pending=false;
    const fixture=addView(context,document,{
        content(){if(pending)throw failure;return fixture.content;},
        async prepare(){pending=true;}
    });
    await assert.rejects(fixture.view.print(),function originalFailure(error){return error===failure;});
    assert.equal(fixture.resources.released,1);
    assert.equal(printStage(document),undefined);
    assert.equal(document.defaultView.printCalls,0);
});

test('native printing rechecks prepared views synchronously without invoking async preparation',async function nativePreparedContent(context){
    const document=fixtureDocument();
    const failure=new Error('Local media is still pending.');
    const pending=deferred();
    const entered=deferred();
    let blocked=false;
    let preparations=0;
    const fixture=addView(context,document,{
        content(){if(blocked)throw failure;return fixture.content;},
        prepare(){preparations++;entered.resolve();return pending.promise;}
    });
    const printing=fixture.view.print();
    const rejected=assert.rejects(printing,function nativeFailure(error){return error===failure;});
    await entered.promise;
    blocked=true;
    document.defaultView.dispatchEvent(new Event('beforeprint'));
    await rejected;
    assert.deepEqual(fixture.errors,[failure]);
    assert.equal(preparations,1);
    assert.equal(fixture.resources.released,1);
    assert.equal(printStage(document),undefined);
    assert.equal(document.defaultView.printCalls,0);
    pending.resolve();
    blocked=false;
    document.defaultView.dispatchEvent(new Event('beforeprint'));
    assert.equal(preparations,1,'Native beforeprint must not await or invoke prepare.');
    assert.ok(printStage(document));
});

test('optional print preparation failures preserve the complete error and release resources',async function rejectedViewPreparation(context){
    const document=fixtureDocument();
    const failure=new AggregateError([new Error('Complete local media failure.')],'Media preparation failed.');
    const fixture=addView(context,document,{prepare(){throw failure;}});
    await assert.rejects(fixture.view.print(),function completeFailure(error){return error===failure;});
    assert.equal(fixture.resources.released,1);
    assert.equal(printStage(document),undefined);
    assert.equal(document.defaultView.printCalls,0);
});

test('real image preparation errors reject and release without opening the print dialog',async function failedImage(context){
    const document=fixtureDocument();
    const fixture=addView(context,document);
    const image=document.createElement('img');
    image.src='broken.png';
    image.decodeResult=Promise.reject(new Error('Image decode failed'));
    void image.decodeResult.catch(function observedByFixture(){});
    fixture.content.append(image);
    await assert.rejects(fixture.view.print(),/Image decode failed/u);
    assert.equal(document.defaultView.printCalls,0);
    assert.equal(printStage(document),undefined);
    assert.equal(document.title,'Original application title');
    assert.equal(fixture.resources.released,1);
});

test('a browser print invocation error rejects even when beforeprint has fired',async function failedDialog(context){
    const document=fixtureDocument();
    const fixture=addView(context,document);
    fixture.content.textContent='Prepared rendered content';
    document.defaultView.print=function rejectedDialog(){
        document.defaultView.dispatchEvent(new Event('beforeprint'));
        throw new Error('The browser could not request its print dialog');
    };
    await assert.rejects(fixture.view.print(),/could not request its print dialog/u);
    assert.equal(printStage(document),undefined);
    assert.equal(fixture.resources.released,1);
});

test('CSS-owned frame fonts are copied through their source definitions and released after printing',async function embeddedFonts(context){
    const document=fixtureDocument();
    const fixture=addView(context,document);
    const frame=document.createElement('iframe');
    const embedded=fixtureDocument('https://print.example.test/documents/page.html');
    const face={
        family:'Moon Serif',style:'normal',weight:'normal',stretch:'normal',
        unicodeRange:'U+0-10FFFF',featureSettings:'normal',variationSettings:'normal',display:'auto',
        status:'loaded',cssConnected:true,owner:embedded.fonts
    };
    embedded.fonts.add(face);
    const style=new FixtureStyle([
        ['font-family','Moon Serif'],['src','url("../fonts/moon.woff2") format("woff2")']
    ]);
    embedded.styleSheets.push({href:'https://print.example.test/styles/page.css',cssRules:[{type:5,style}]});
    embedded.body.textContent='Rendered with its existing font';
    embedded.body.appearance['font-family']='"Moon Serif", serif';
    frame.contentDocument=embedded;
    fixture.content.append(frame);
    assert.equal(await fixture.view.print(),true);
    assert.equal(document.fontCopies.length,1);
    assert.match(document.fontCopies[0].source,/https:\/\/print\.example\.test\/fonts\/moon\.woff2/u);
    assert.equal(document.fontCopies[0].status,'loaded');
    assert.notEqual(document.fontCopies[0].family,face.family);
    assert.match(printStage(document).shadowRoot.querySelectorAll('div')[2].style.getPropertyValue('font-family'),/^ArcanePrint-\d+, serif$/u);
    assert.equal(document.fonts.has(document.fontCopies[0]),true);
    document.defaultView.dispatchEvent(new Event('afterprint'));
    assert.equal(document.fonts.has(document.fontCopies[0]),false);
    assert.equal(embedded.fonts.has(face),true);
});

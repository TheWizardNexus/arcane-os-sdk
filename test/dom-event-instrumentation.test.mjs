import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {
    DOM_INTERACTION_EVENT,
    DOM_MUTATION_EVENT,
    DOM_OBSERVATION_STARTED_EVENT,
    DOM_OBSERVATION_STOPPED_EVENT,
    EventManager
} from '../src/event-manager.mjs';

class FakeEventRoot{
    constructor({nodeType=9,host=null}={}){
        this.nodeType=nodeType;
        this.host=host;
        this.listeners=new Map();
        this.elements=[];
    }

    addEventListener(type,handler){
        const handlers=this.listeners.get(type)??new Set();
        handlers.add(handler);
        this.listeners.set(type,handlers);
    }

    removeEventListener(type,handler){
        this.listeners.get(type)?.delete(handler);
    }

    dispatch(event){
        for(const handler of this.listeners.get(event.type)??[])handler(event);
    }

    querySelectorAll(){return this.elements;}
}

class FakeElement{
    constructor(localName,{id='',parentElement=null,root=null,type='',value='',outerHTML}={}){
        this.nodeType=1;
        this.localName=localName;
        this.id=id;
        this.parentElement=parentElement;
        this.root=root;
        this.type=type;
        this.value=value;
        this.attributes=new Map();
        this.children=[];
        this.outerHTML=outerHTML??`<${localName}></${localName}>`;
        if(id)this.attributes.set('id',id);
        if(type)this.attributes.set('type',type);
        parentElement?.children.push(this);
    }

    getAttribute(name){return this.attributes.has(name)?this.attributes.get(name):null;}
    hasAttribute(name){return this.attributes.has(name);}
    setAttribute(name,value){this.attributes.set(name,String(value));}
    getRootNode(){return this.root;}
}

class FakeMutationObserver{
    static latest=null;

    constructor(callback){
        this.callback=callback;
        this.observed=[];
        this.disconnected=false;
        FakeMutationObserver.latest=this;
    }

    observe(target,options){this.observed.push({target,options});}
    disconnect(){this.disconnected=true;}
    trigger(records){this.callback(records);}
}

function fixture(){
    const documentRoot=new FakeEventRoot();
    documentRoot.title='Arcane fixture';
    documentRoot.location={href:'https://arcane.test/apps/example/'};
    const html=new FakeElement('html',{root:documentRoot,outerHTML:'<html></html>'});
    const body=new FakeElement('body',{parentElement:html,root:documentRoot});
    const button=new FakeElement('button',{
        id:'launch',parentElement:body,root:documentRoot,outerHTML:'<button id="launch">Launch</button>'
    });
    const password=new FakeElement('input',{
        id:'password',parentElement:body,root:documentRoot,type:'password',value:'not-recorded',
        outerHTML:'<input id="password" type="password">'
    });
    const host=new FakeElement('section',{id:'host',parentElement:body,root:documentRoot});
    const shadowRoot=new FakeEventRoot({nodeType:11,host});
    host.shadowRoot=shadowRoot;
    documentRoot.documentElement=html;
    documentRoot.elements=[html,body,button,password,host];
    return {documentRoot,html,body,button,password,host,shadowRoot};
}

function interaction(type,target,path){
    return {
        type,target,
        bubbles:true,cancelable:true,composed:true,defaultPrevented:false,isTrusted:true,
        button:0,clientX:12,clientY:14,
        composedPath:()=>path
    };
}

test('the time-travel flag captures DOM interactions, mutations, and open shadow roots',()=>{
    const roots=fixture();
    const manager=new EventManager({
        timeTravel:true,
        sessionId:'dom-session',
        clock:()=>new Date('2026-08-24T06:00:00.000Z'),
        now:()=>5,
        dom:{
            root:roots.documentRoot,
            MutationObserver:FakeMutationObserver,
            eventTypes:['click','input']
        }
    });

    assert.equal(manager.domInstrumentation.active,true);
    assert.equal(manager.domInstrumentation.observedRootCount,2);
    assert.equal(FakeMutationObserver.latest.observed.length,2);
    assert.equal(manager.history[0].type,DOM_OBSERVATION_STARTED_EVENT);

    roots.documentRoot.dispatch(interaction(
        'click',roots.button,[roots.button,roots.body,roots.html,roots.documentRoot]
    ));
    roots.shadowRoot.dispatch(interaction('click',roots.host,[roots.host,roots.shadowRoot]));
    roots.documentRoot.dispatch(interaction(
        'input',roots.password,[roots.password,roots.body,roots.html,roots.documentRoot]
    ));

    roots.button.setAttribute('data-state','running');
    FakeMutationObserver.latest.trigger([{
        type:'attributes',target:roots.button,attributeName:'data-state',
        attributeNamespace:null,oldValue:null
    }]);
    const added=new FakeElement('span',{
        parentElement:roots.button,root:roots.documentRoot,outerHTML:'<span>Ready</span>'
    });
    FakeMutationObserver.latest.trigger([{
        type:'childList',target:roots.button,previousSibling:null,nextSibling:null,
        addedNodes:[added],removedNodes:[]
    }]);

    const interactions=manager.getEventStack({type:DOM_INTERACTION_EVENT});
    assert.equal(interactions.length,3);
    assert.equal(interactions[0].payload[0].eventType,'click');
    assert.equal(interactions[0].payload[0].target.selector,'#launch');
    assert.equal(interactions[0].payload[0].details.clientX,12);
    assert.equal(interactions[2].payload[0].value,'not-recorded');
    assert.ok(interactions.every(record=>record.timestamp==='2026-08-24T06:00:00.000Z'));
    assert.ok(interactions.every(record=>record.source==='dom'&&record.category==='interaction'));

    const mutations=manager.getEventStack({type:DOM_MUTATION_EVENT});
    assert.equal(mutations.length,2);
    assert.ok(mutations.every(record=>record.source==='dom'&&record.category==='mutation'));
    assert.equal(mutations[0].causationId,interactions.at(-1).id);
    assert.deepEqual(mutations[0].payload[0],{
        mutationType:'attributes',
        target:{
            kind:'element',selector:'#launch',tagName:'button',id:'launch',
            role:null,name:null,type:null,content:'<button id="launch">Launch</button>'
        },
        attributeName:'data-state',namespace:null,before:null,after:'running'
    });
    assert.equal(mutations[1].payload[0].mutationType,'childList');
    assert.equal(mutations[1].payload[0].added[0].content,'<span>Ready</span>');
});

test('DOM capture defaults preserve complete interaction and mutation content',()=>{
    const roots=fixture();
    roots.documentRoot.location.href='https://arcane.test/app?token=url-secret';
    roots.documentRoot.title='title-secret';
    const manager=new EventManager({
        timeTravel:true,
        sessionId:'dom-private-session',
        dom:{
            root:roots.documentRoot,
            MutationObserver:FakeMutationObserver,
            eventTypes:['beforeinput','compositionupdate','keydown','paste']
        }
    });
    const path=[roots.password,roots.body,roots.html,roots.documentRoot];
    for(const eventType of ['beforeinput','compositionupdate','keydown','paste']){
        roots.documentRoot.dispatch({
            ...interaction(eventType,roots.password,path),
            data:'composition-secret',
            key:'k',
            code:'KeyK',
            charCode:75,
            keyCode:75,
            which:75,
            detail:{password:'detail-secret'},
            clipboardData:{getData:()=> 'clipboard-secret'}
        });
    }

    roots.button.setAttribute('href','https://arcane.test/path?secret=attribute-secret');
    roots.password.setAttribute('value','attribute-value-secret');
    FakeMutationObserver.latest.trigger([
        {
            type:'attributes',target:roots.button,attributeName:'href',
            attributeNamespace:null,oldValue:'https://before.test/?secret=old-url-secret'
        },
        {
            type:'attributes',target:roots.password,attributeName:'value',
            attributeNamespace:null,oldValue:'old-value-secret'
        },
        {
            type:'childList',target:roots.body,previousSibling:null,nextSibling:null,
            addedNodes:[new FakeElement('span',{
                root:roots.documentRoot,outerHTML:'<span>markup-secret</span>'
            })],removedNodes:[]
        }
    ]);

    const records=manager.getEventStack({type:DOM_INTERACTION_EVENT});
    assert.equal(records.length,4);
    for(const record of records){
        assert.equal(typeof record.stack,'string');
        assert.equal(record.payload[0].details.data,'composition-secret');
        assert.equal(record.payload[0].details.key,'k');
        assert.equal(record.payload[0].details.code,'KeyK');
        assert.equal(record.payload[0].details.charCode,75);
        assert.equal(record.payload[0].details.keyCode,75);
        assert.equal(record.payload[0].details.which,75);
        assert.deepEqual(record.payload[0].details.detail,{password:'detail-secret'});
        assert.equal(record.payload[0].value,'not-recorded');
        assert.equal(record.payload[0].details.clipboardData.getData.$type,'function');
    }
    const mutations=manager.getEventStack({type:DOM_MUTATION_EVENT});
    assert.deepEqual(
        [mutations[0].payload[0].before,mutations[0].payload[0].after],
        [
            'https://before.test/?secret=old-url-secret',
            'https://arcane.test/path?secret=attribute-secret'
        ]
    );
    assert.deepEqual(
        [mutations[1].payload[0].before,mutations[1].payload[0].after],
        ['old-value-secret','attribute-value-secret']
    );
    assert.equal(mutations[2].payload[0].added[0].content,'<span>markup-secret</span>');
    assert.equal(
        manager.history[0].payload[0].root.url,
        'https://arcane.test/app?token=url-secret'
    );
    assert.equal(manager.history[0].payload[0].root.title,'title-secret');

    const exported=manager.exportStack();
    for(const content of [
        'url-secret','attribute-secret','old-url-secret','markup-secret','title-secret'
    ]){
        assert.equal(exported.includes(content),true,`event stack omitted ${content}`);
    }
    for(const completeContent of [
        'composition-secret','detail-secret','attribute-value-secret','old-value-secret'
    ]){
        assert.equal(
            exported.includes(completeContent),
            true,
            `event stack omitted ${completeContent}`
        );
    }
});

test('removed nodes preserve complete mutation content after their ancestry is detached',()=>{
    const roots=fixture();
    const manager=new EventManager({
        timeTravel:true,
        sessionId:'dom-private-removal-session',
        dom:{
            root:roots.documentRoot,
            MutationObserver:FakeMutationObserver,
            eventTypes:[],
            observeOpenShadowRoots:false
        }
    });
    const privateContainer=new FakeElement('section',{
        id:'private-container',parentElement:roots.body,root:roots.documentRoot
    });
    privateContainer.setAttribute('data-arcane-private','');
    const removed=new FakeElement('span',{
        parentElement:privateContainer,
        root:roots.documentRoot,
        outerHTML:'<span>detached-private-secret</span>'
    });
    removed.parentElement=null;

    FakeMutationObserver.latest.trigger([{
        type:'childList',target:privateContainer,previousSibling:null,nextSibling:null,
        addedNodes:[],removedNodes:[removed]
    }]);

    const mutation=manager.getEventStack({type:DOM_MUTATION_EVENT})[0];
    assert.equal(Object.hasOwn(mutation.payload[0].target,'private'),false);
    assert.equal(Object.hasOwn(mutation.payload[0].removed[0].target,'private'),false);
    assert.equal(mutation.payload[0].removed[0].content,'<span>detached-private-secret</span>');
    assert.equal(manager.exportStack().includes('detached-private-secret'),true);
});

test('autocomplete values and complete selector identifiers are retained',()=>{
    const roots=fixture();
    const autocompleteInput=new FakeElement('input',{
        id:'credential',parentElement:roots.body,root:roots.documentRoot,
        type:'text',value:'uppercase-autocomplete-secret'
    });
    autocompleteInput.setAttribute('autocomplete','CURRENT-PASSWORD');
    const urlId=new FakeElement('button',{
        id:'https://arcane.test/path?token=selector-id-secret',
        parentElement:roots.body,
        root:roots.documentRoot
    });
    const urlTestId=new FakeElement('button',{
        parentElement:roots.body,
        root:roots.documentRoot
    });
    urlTestId.setAttribute(
        'data-testid','prefix-wss://arcane.test/path/selector-testid-secret'
    );
    roots.documentRoot.elements.push(autocompleteInput,urlId,urlTestId);
    const manager=new EventManager({
        timeTravel:true,
        sessionId:'dom-private-identifiers-session',
        dom:{
            root:roots.documentRoot,
            MutationObserver:FakeMutationObserver,
            eventTypes:['click','input'],
            observeOpenShadowRoots:false
        }
    });

    roots.documentRoot.dispatch({
        ...interaction('input',autocompleteInput,[autocompleteInput,roots.body,roots.documentRoot]),
        data:'uppercase-input-secret'
    });
    roots.documentRoot.dispatch(interaction('click',urlId,[urlId,roots.body,roots.documentRoot]));
    roots.documentRoot.dispatch(
        interaction('click',urlTestId,[urlTestId,roots.body,roots.documentRoot])
    );

    const interactions=manager.getEventStack({type:DOM_INTERACTION_EVENT});
    assert.equal(interactions[0].payload[0].value,'uppercase-autocomplete-secret');
    assert.equal(interactions[0].payload[0].details.data,'uppercase-input-secret');
    assert.ok(interactions[1].payload[0].target.selector.startsWith('#'));
    assert.ok(interactions[1].payload[0].target.selector.includes('selector-id-secret'));
    assert.ok(interactions[2].payload[0].target.selector.includes('selector-testid-secret'));
    const exported=manager.exportStack();
    assert.equal(exported.includes('uppercase-autocomplete-secret'),true);
    assert.equal(exported.includes('uppercase-input-secret'),true);
    assert.equal(exported.includes('selector-id-secret'),true);
    assert.equal(exported.includes('selector-testid-secret'),true);
    manager.disableTimeTravel();
});

test('event object deduplication is scoped to one DOM propagation occurrence',()=>{
    const roots=fixture();
    const manager=new EventManager({
        timeTravel:true,
        sessionId:'dom-event-reuse-session',
        dom:{
            root:roots.documentRoot,
            MutationObserver:FakeMutationObserver,
            eventTypes:['click']
        }
    });
    const reused=interaction(
        'click',roots.button,[roots.button,roots.body,roots.html,roots.documentRoot]
    );
    roots.documentRoot.dispatch(reused);
    roots.documentRoot.dispatch(reused);

    const composed=interaction('click',roots.host,[
        roots.host,roots.shadowRoot,roots.body,roots.html,roots.documentRoot
    ]);
    roots.documentRoot.dispatch(composed);
    roots.shadowRoot.dispatch(composed);
    roots.documentRoot.dispatch(composed);
    roots.shadowRoot.dispatch(composed);

    const interactions=manager.getEventStack({type:DOM_INTERACTION_EVENT});
    assert.equal(interactions.length,4);
    assert.equal(interactions.filter(record=>record.payload[0].target.id==='launch').length,2);
    assert.equal(interactions.filter(record=>record.payload[0].target.id==='host').length,2);
    manager.disableTimeTravel();
});

test('mutation batches retain the causing interaction through the microtask checkpoint',async()=>{
    const roots=fixture();
    const manager=new EventManager({
        timeTravel:true,
        sessionId:'dom-causation-session',
        dom:{
            root:roots.documentRoot,
            MutationObserver:FakeMutationObserver,
            eventTypes:['click']
        }
    });
    roots.documentRoot.dispatch(interaction(
        'click',roots.button,[roots.button,roots.body,roots.html,roots.documentRoot]
    ));
    const interactionId=manager.getEventStack({type:DOM_INTERACTION_EVENT})[0].id;
    await Promise.resolve();
    FakeMutationObserver.latest.trigger([{
        type:'attributes',target:roots.button,attributeName:'data-state',oldValue:null
    }]);
    assert.equal(manager.getEventStack({type:DOM_MUTATION_EVENT})[0].causationId,interactionId);
    manager.disableTimeTravel();
});

test('failed DOM startup rolls back every partially installed listener and observer',()=>{
    const roots=fixture();
    const add=roots.documentRoot.addEventListener.bind(roots.documentRoot);
    let additions=0;
    roots.documentRoot.addEventListener=(type,handler)=>{
        additions+=1;
        if(additions===2)throw new Error('listener installation failed');
        add(type,handler);
    };
    const manager=new EventManager();
    const instrumentation=manager.attachDOM(roots.documentRoot,{
        MutationObserver:FakeMutationObserver,
        eventTypes:['click','input'],
        observeOpenShadowRoots:false
    });

    assert.throws(()=>instrumentation.start(),/listener installation failed/u);
    assert.equal(instrumentation.active,false);
    assert.equal(instrumentation.observedRootCount,0);
    assert.equal(FakeMutationObserver.latest.disconnected,true);
    assert.ok([...roots.documentRoot.listeners.values()].every(handlers=>handlers.size===0));
});

test('failed DOM startup retains partial cleanup handles until a later successful stop',()=>{
    const roots=fixture();
    const add=roots.documentRoot.addEventListener.bind(roots.documentRoot);
    const remove=roots.documentRoot.removeEventListener.bind(roots.documentRoot);
    let additions=0;
    let permitCleanup=false;
    roots.documentRoot.addEventListener=(type,handler)=>{
        additions+=1;
        if(additions===2)throw new Error('persistent startup installation failure');
        add(type,handler);
    };
    roots.documentRoot.removeEventListener=(type,handler)=>{
        if(!permitCleanup)throw new Error('persistent startup listener cleanup failure');
        remove(type,handler);
    };
    class PersistentStartupObserver extends FakeMutationObserver{
        static latest=null;
        constructor(callback){
            super(callback);
            PersistentStartupObserver.latest=this;
        }
        disconnect(){
            if(!permitCleanup)throw new Error('persistent startup observer cleanup failure');
            super.disconnect();
        }
    }
    const manager=new EventManager();
    const lifecycle=[];
    manager.on(DOM_OBSERVATION_STARTED_EVENT,()=>lifecycle.push('started'));
    manager.on(DOM_OBSERVATION_STOPPED_EVENT,()=>lifecycle.push('stopped'));
    const instrumentation=manager.attachDOM(roots.documentRoot,{
        MutationObserver:PersistentStartupObserver,
        eventTypes:['click','input'],
        observeOpenShadowRoots:false
    });

    assert.throws(()=>instrumentation.start(),/persistent startup installation failure/u);
    assert.equal(instrumentation.active,true);
    assert.equal(instrumentation.cleanupPending,true);
    assert.equal(instrumentation.observedRootCount,1);
    assert.equal(roots.documentRoot.listeners.get('click').size,1);
    assert.equal(PersistentStartupObserver.latest.disconnected,false);
    assert.deepEqual(lifecycle,[]);

    permitCleanup=true;
    instrumentation.stop({emitLifecycle:false});
    assert.equal(instrumentation.active,false);
    assert.equal(instrumentation.cleanupPending,false);
    assert.equal(instrumentation.observedRootCount,0);
    assert.equal(roots.documentRoot.listeners.get('click').size,0);
    assert.equal(PersistentStartupObserver.latest.disconnected,true);
    assert.deepEqual(lifecycle,[]);
});

test('DOM lifecycle subscriber failures leave startup and shutdown state consistent',()=>{
    const startRoots=fixture();
    const startManager=new EventManager();
    const startFailure=new Error('start lifecycle subscriber failed');
    startManager.on(DOM_OBSERVATION_STARTED_EVENT,()=>{throw startFailure;});
    const instrumentation=startManager.attachDOM(startRoots.documentRoot,{
        MutationObserver:FakeMutationObserver,
        eventTypes:['click'],
        observeOpenShadowRoots:false
    });
    const startObserver=FakeMutationObserver.latest;
    assert.throws(()=>instrumentation.start(),error=>error===startFailure);
    assert.equal(instrumentation.active,false);
    assert.equal(startObserver.disconnected,true);
    assert.ok([...startRoots.documentRoot.listeners.values()].every(handlers=>handlers.size===0));

    const stopRoots=fixture();
    const stopManager=new EventManager({
        timeTravel:true,
        dom:{
            root:stopRoots.documentRoot,
            MutationObserver:FakeMutationObserver,
            eventTypes:['click'],
            observeOpenShadowRoots:false
        }
    });
    const stopObserver=FakeMutationObserver.latest;
    const stopFailure=new Error('stop lifecycle subscriber failed');
    stopManager.on(DOM_OBSERVATION_STOPPED_EVENT,()=>{throw stopFailure;});
    assert.throws(()=>stopManager.disableTimeTravel(),error=>error===stopFailure);
    assert.equal(stopManager.timeTravelEnabled,false);
    assert.equal(stopManager.domInstrumentation.active,false);
    assert.equal(stopObserver.disconnected,true);
    assert.ok([...stopRoots.documentRoot.listeners.values()].every(handlers=>handlers.size===0));
});

test('DOM shutdown retries transient cleanup failures and still detaches everything',()=>{
    const roots=fixture();
    const manager=new EventManager({
        timeTravel:true,
        dom:{
            root:roots.documentRoot,
            MutationObserver:FakeMutationObserver,
            eventTypes:['click'],
            observeOpenShadowRoots:false
        }
    });
    const remove=roots.documentRoot.removeEventListener.bind(roots.documentRoot);
    let failed=false;
    roots.documentRoot.removeEventListener=(type,handler)=>{
        if(!failed){
            failed=true;
            throw new Error('transient cleanup failure');
        }
        remove(type,handler);
    };

    manager.disableTimeTravel();
    assert.equal(manager.domInstrumentation.active,false);
    assert.equal(FakeMutationObserver.latest.disconnected,true);
    assert.ok([...roots.documentRoot.listeners.values()].every(handlers=>handlers.size===0));
});

test('DOM shutdown preserves cleanup handles after persistent failures and retries safely',()=>{
    const roots=fixture();
    const manager=new EventManager({
        timeTravel:true,
        sessionId:'dom-persistent-cleanup-session',
        dom:{
            root:roots.documentRoot,
            MutationObserver:FakeMutationObserver,
            eventTypes:['click'],
            observeOpenShadowRoots:false
        }
    });
    const instrumentation=manager.domInstrumentation;
    const observer=FakeMutationObserver.latest;
    const remove=roots.documentRoot.removeEventListener.bind(roots.documentRoot);
    const disconnect=observer.disconnect.bind(observer);
    let permitCleanup=false;
    roots.documentRoot.removeEventListener=(type,handler)=>{
        if(!permitCleanup)throw new Error('persistent listener cleanup failure');
        remove(type,handler);
    };
    observer.disconnect=()=>{
        if(!permitCleanup)throw new Error('persistent observer cleanup failure');
        disconnect();
    };

    const before=manager.eventCount;
    assert.throws(()=>instrumentation.stop(),/persistent listener cleanup failure/u);
    assert.equal(instrumentation.active,true);
    assert.equal(instrumentation.cleanupPending,true);
    assert.equal(instrumentation.observedRootCount,1);
    assert.equal(observer.disconnected,false);
    assert.equal(manager.eventCount,before);
    assert.equal(
        manager.history.some(record=>record.type===DOM_OBSERVATION_STOPPED_EVENT),
        false
    );
    assert.equal(roots.documentRoot.listeners.get('click').size,1);
    assert.throws(()=>instrumentation.start(),/cleanup is pending/u);

    permitCleanup=true;
    instrumentation.stop();
    assert.equal(instrumentation.active,false);
    assert.equal(instrumentation.cleanupPending,false);
    assert.equal(instrumentation.observedRootCount,0);
    assert.equal(observer.disconnected,true);
    assert.equal(roots.documentRoot.listeners.get('click').size,0);
    assert.equal(manager.eventCount,before+1);
    assert.equal(manager.history.at(-1).type,DOM_OBSERVATION_STOPPED_EVENT);
});

test('failed DOM replacement retains the prior cleanup handle without duplicate capture',()=>{
    const first=fixture();
    const second=fixture();
    const manager=new EventManager({
        timeTravel:true,
        sessionId:'dom-replacement-cleanup-session',
        dom:{
            root:first.documentRoot,
            MutationObserver:FakeMutationObserver,
            eventTypes:['click'],
            observeOpenShadowRoots:false
        }
    });
    const previous=manager.domInstrumentation;
    const previousObserver=FakeMutationObserver.latest;
    const remove=first.documentRoot.removeEventListener.bind(first.documentRoot);
    const disconnect=previousObserver.disconnect.bind(previousObserver);
    let permitCleanup=false;
    first.documentRoot.removeEventListener=(type,handler)=>{
        if(!permitCleanup)throw new Error('prior listener cleanup failure');
        remove(type,handler);
    };
    previousObserver.disconnect=()=>{
        if(!permitCleanup)throw new Error('prior observer cleanup failure');
        disconnect();
    };

    assert.throws(()=>manager.attachDOM(second.documentRoot,{
        MutationObserver:FakeMutationObserver,
        eventTypes:['click'],
        observeOpenShadowRoots:false
    }),/prior listener cleanup failure/u);
    assert.equal(manager.domInstrumentation,previous);
    assert.equal(previous.active,true);
    assert.equal(previous.cleanupPending,true);
    assert.equal(second.documentRoot.listeners.size,0);
    assert.equal(FakeMutationObserver.latest,previousObserver);

    permitCleanup=true;
    const replacement=manager.attachDOM(second.documentRoot,{
        MutationObserver:FakeMutationObserver,
        eventTypes:['click'],
        observeOpenShadowRoots:false
    });
    assert.equal(manager.domInstrumentation,replacement);
    assert.equal(previous.active,false);
    assert.equal(previous.cleanupPending,false);
    assert.equal(first.documentRoot.listeners.get('click').size,0);
    assert.equal(previousObserver.disconnected,true);
    assert.equal(replacement.active,true);
    assert.equal(second.documentRoot.listeners.get('click').size,1);
    manager.disableTimeTravel();
});

test('disabling time travel detaches DOM capture after recording the lifecycle boundary',()=>{
    const roots=fixture();
    const manager=new EventManager({
        timeTravel:true,
        sessionId:'dom-stop-session',
        dom:{
            root:roots.documentRoot,
            MutationObserver:FakeMutationObserver,
            eventTypes:['click']
        }
    });
    const observer=FakeMutationObserver.latest;
    manager.disableTimeTravel();
    const count=manager.eventCount;

    assert.equal(manager.timeTravelEnabled,false);
    assert.equal(manager.domInstrumentation.active,false);
    assert.equal(observer.disconnected,true);
    assert.equal(manager.history.at(-1).type,DOM_OBSERVATION_STOPPED_EVENT);
    roots.documentRoot.dispatch(interaction('click',roots.button,[roots.button,roots.documentRoot]));
    observer.trigger([{
        type:'attributes',target:roots.button,attributeName:'class',oldValue:null
    }]);
    assert.equal(manager.eventCount,count);
});

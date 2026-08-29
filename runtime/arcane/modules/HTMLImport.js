import {
  createArcaneEventSource,
  projectArcaneDOMEvent
} from 'arcane-os/event-manager';

const htmlImportHostRegistryKey=Symbol.for('arcane.html-import.hosts');
const htmlImportHostRegistry=globalThis[htmlImportHostRegistryKey] instanceof Map
  ?globalThis[htmlImportHostRegistryKey]
  :new Map();

globalThis[htmlImportHostRegistryKey]=htmlImportHostRegistry;

let htmlImportScriptId=0;

function componentRuntimeRoot(resolvedHref){
  const componentURL=new URL(resolvedHref);
  const componentMarker='/arcane/components/';
  const componentIndex=componentURL.pathname.lastIndexOf(componentMarker);
  if(componentIndex<0)return null;
  const runtimePath=componentURL.pathname.slice(
    0,
    componentIndex+'/arcane/'.length
  );
  return new URL(runtimePath,componentURL.origin);
}

function resolveComponentResource(value,runtimeRoot){
  if(!runtimeRoot||typeof value!=='string'||!value.startsWith('./arcane/')){
    return value;
  }
  return new URL(value.slice('./arcane/'.length),runtimeRoot).href;
}

function resolveComponentStyleResources(styleText,runtimeRoot){
  if(!runtimeRoot)return styleText;
  return styleText.replace(
    /url\(\s*(['"]?)\.\/arcane\/([^)'"\s]+)\1\s*\)/gu,
    function resolveStyleURL(_match,quote,resourcePath){
      const resolved=new URL(resourcePath,runtimeRoot).href;
      return `url(${quote}${resolved}${quote})`;
    }
  );
}

function createComponentFragment(html,resolvedHref){
  const template=document.createElement('template');
  template.innerHTML=html;
  const runtimeRoot=componentRuntimeRoot(resolvedHref);
  if(!runtimeRoot)return template.content;

  for(const element of template.content.querySelectorAll('[href],[src]')){
    for(const attribute of ['href','src']){
      if(!element.hasAttribute(attribute))continue;
      const value=element.getAttribute(attribute);
      const resolved=resolveComponentResource(value,runtimeRoot);
      if(resolved!==value)element.setAttribute(attribute,resolved);
    }
  }
  for(const style of template.content.querySelectorAll('style')){
    style.textContent=resolveComponentStyleResources(
      style.textContent||'',
      runtimeRoot
    );
  }
  return template.content;
}

function samePropertyDescriptor(left,right){
  if(!left||!right)return left===right;
  return left.configurable===right.configurable
    &&left.enumerable===right.enumerable
    &&left.writable===right.writable
    &&left.value===right.value
    &&left.get===right.get
    &&left.set===right.set;
}

class HTMLImport extends HTMLElement {
  #connectionGeneration=0;
  #eventOwner=Object.freeze({kind:'html-import-lifecycle-owner'});
  #events;
  #importedDestroy=null;
  #loadController=null;
  #loadTask=Promise.resolve();

  ready=false;

  constructor() {
      super();
      this.attachShadow({ mode: 'open' });
  }

  #createEvents(){
      this.#events=createArcaneEventSource(this.#eventOwner,{
        source:'html-import',
        eventTypes:Object.freeze([
          'html-import-error',
          'html-import-ready'
        ])
      });
      return this.#events;
  }

  connectedCallback() {
    const generation=++this.#connectionGeneration;
    const controller=new AbortController();
    this.ready=false;
    this.#loadController?.abort('html-import-load-superseded');
    this.#loadController=controller;
    const previous=this.#loadTask;
    const task=Promise.resolve(previous)
      .catch(()=>{})
      .then(()=>this.#connect(generation,controller));
    this.#loadTask=task;
    return task;
  }

  async #connect(generation,controller){
    if(!this.#isCurrentConnection(generation,controller))return;
    if(!this.#events||this.#events.disposed)this.#createEvents();
    const href=this.getAttribute('href');
    let resolvedHref='';
    const operationId=`html-import-load-${this.#events.instanceId}-${generation}`;
    if(!href){
      console.log('no href provided for html-import tag',this);
      this.#loadController=null;
      return;
    }

    try{
      const baseURL=new URL(document.baseURI);
      const resolvedURL=new URL(href,baseURL);
      resolvedHref=resolvedURL.href;
      if(resolvedURL.origin!==baseURL.origin){
        throw new Error('HTML imports must use a same-origin URL.');
      }
      const response=await fetch(resolvedURL.href,{
        cache:'default',
        credentials:'same-origin',
        method:'GET',
        redirect:'error',
        signal:controller.signal
      });
      if(!this.#isCurrentConnection(generation,controller))return;
      await this.#loadHTML(href,resolvedHref,response,generation,controller,operationId);
    }catch(err){
      if(!this.#isCurrentConnection(generation,controller)){
        await this.#destroyImportedHost();
        return;
      }
      console.error('Error loading HTML component:',err);
      const detail=Object.freeze({
          code:'HTML_IMPORT_FAILED',
          href,
          message:'The component could not be loaded.',
          reason:'component-import-rejected',
          resolvedHref
      });
      const {occurrence}=this.#events.dispatch(
        'html-import-error',
        detail,
        {
          operationId,
          publicDetail:Object.freeze({code:detail.code,reason:detail.reason})
        }
      );
      projectArcaneDOMEvent(this,occurrence,{
        bubbles:true,
        composed:true
      });
      await this.#destroyImportedHost();
    }finally{
      if(this.#loadController===controller)this.#loadController=null;
    }
  }

  disconnectedCallback(){
    this.ready=false;
    ++this.#connectionGeneration;
    this.#loadController?.abort('html-import-disconnected');
    this.#loadController=null;
    const events=this.#events;
    const previous=this.#loadTask;
    const immediateTeardown=this.#destroyImportedHost();
    const task=Promise.allSettled([previous,immediateTeardown]).then(()=>{
      events?.dispose();
      if(this.#events===events)this.#events=null;
    });
    this.#loadTask=task;
    return task;
  }

  #isCurrentConnection(generation,controller){
    return this.isConnected
      &&generation===this.#connectionGeneration
      &&this.#loadController===controller
      &&!controller.signal.aborted;
  }

  #reportImportedDestroyError(error,{events,href,operationId}){
    console.error('Error destroying imported HTML component:',error);
    if(!events||events.disposed)return;
    const detail=Object.freeze({
      code:'HTML_IMPORT_IMPORTED_COMPONENT_DESTROY_REJECTED',
      href,
      message:'The imported component could not be destroyed.',
      reason:'imported-component-destroy-rejected'
    });
    const {occurrence}=events.dispatch(
      'html-import-error',
      detail,
      {
        operationId,
        publicDetail:Object.freeze({code:detail.code,reason:detail.reason})
      }
    );
    projectArcaneDOMEvent(this,occurrence,{
      bubbles:true,
      composed:true
    });
  }

  #restoreImportedDestroy(record){
    const current=Object.getOwnPropertyDescriptor(this,'destroy')??null;
    if(!samePropertyDescriptor(current,record.installedDescriptor))return false;
    if(record.previousDescriptor){
      Object.defineProperty(this,'destroy',record.previousDescriptor);
    }else{
      delete this.destroy;
    }
    return true;
  }

  #destroyImportedHost(){
    const record=this.#importedDestroy;
    if(!record)return Promise.resolve(false);
    this.#importedDestroy=null;
    const events=this.#events;
    const generation=this.#connectionGeneration;
    const reportContext={
      events,
      href:this.getAttribute('href')||'',
      operationId:events
        ?`html-import-destroy-${events.instanceId}-${generation}`
        :null
    };
    let result;
    try{
      result=record.destroy.call(this);
    }catch(error){
      this.#reportImportedDestroyError(error,reportContext);
      this.#restoreImportedDestroy(record);
      return Promise.resolve(false);
    }
    return Promise.resolve(result)
      .then(
        ()=>true,
        error=>{
          this.#reportImportedDestroyError(error,reportContext);
          return false;
        }
      )
      .finally(()=>this.#restoreImportedDestroy(record));
  }

  async #loadHTML(href,resolvedHref,response,generation,controller,operationId){
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const html = await response.text();
    if(!this.#isCurrentConnection(generation,controller))return false;
    await this.#destroyImportedHost();
    if(!this.#isCurrentConnection(generation,controller))return false;
    this.shadowRoot.replaceChildren(createComponentFragment(html,resolvedHref));

    await this.#executeScripts();
    if(!this.#isCurrentConnection(generation,controller)){
      await this.#destroyImportedHost();
      return false;
    }

    this.ready=true;
    const {occurrence}=this.#events.dispatch(
      'html-import-ready',
      Object.freeze({href,resolvedHref}),
      {operationId,publicDetail:Object.freeze({ready:true})}
    );
    projectArcaneDOMEvent(this,occurrence,{
      bubbles:true,
      composed:true
    });
    return true;
  }

  async #executeScripts() {
    const scripts = Array.from(this.shadowRoot.querySelectorAll('script'));
    const previousDescriptor=Object.getOwnPropertyDescriptor(this,'destroy')??null;
    const previousDestroy=this.destroy;
    try{
      for(const script of scripts){
        if (script.src) {
          console.error('ONLY INLINE SCRIPTS SUPPORTED AT THIS TIME FOR SECURITY REASONS');
          console.warn('script src path will need to be limited to ./{text}.js, ../{text}.js), or acceptable sub folders. This can be complex.');
          return;
          //newScript.src = script.src;
        }

        const source=(script.textContent||'').replace(
          /\bimport\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g,
          (_match,_quote,specifier)=>{
            return `import(${JSON.stringify(new URL(specifier,import.meta.url).href)})`;
          }
        );
        const executable=document.createElement('script');
        const hostToken=`html-import-${Date.now()}-${htmlImportScriptId++}`;

        executable.dataset.arcaneHostToken=hostToken;
        executable.textContent=`(()=>{const registry=globalThis[Symbol.for('arcane.html-import.hosts')];const token=document.currentScript&&document.currentScript.dataset.arcaneHostToken;const binding=registry instanceof Map&&token?registry.get(token):null;if(!binding?.host)throw new Error('HTML import host binding is unavailable.');binding.promise=(async function(){${source}}).call(binding.host);})()`;
        script.parentNode.removeChild(script);

        const binding={host:this,promise:null};
        htmlImportHostRegistry.set(hostToken,binding);
        try{
          document.head.appendChild(executable);
          await binding.promise;
        }finally{
          executable.remove();
          htmlImportHostRegistry.delete(hostToken);
          delete executable.dataset.arcaneHostToken;
        }
      }
    }finally{
      const installedDescriptor=Object.getOwnPropertyDescriptor(this,'destroy')??null;
      const installedDestroy=this.destroy;
      if(typeof installedDestroy==='function'
        &&installedDestroy!==previousDestroy
        &&!samePropertyDescriptor(installedDescriptor,previousDescriptor)){
        this.#importedDestroy={
          destroy:installedDestroy,
          installedDescriptor,
          previousDescriptor
        };
      }
    }
  }
}
  
customElements.define('html-import', HTMLImport);

export default HTMLImport;

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

const htmlImportModuleURL=new URL(import.meta.url);
const htmlImportAssetVersion=htmlImportModuleURL.searchParams.get('arcaneVersion');

function versionComponentResource(value,baseHref){
  if(!htmlImportAssetVersion||typeof value!=='string'||!value||value.startsWith('#')){
    return value;
  }
  let resolvedURL;
  try{
    resolvedURL=new URL(value,baseHref);
  }catch{
    return value;
  }
  if(resolvedURL.protocol!==htmlImportModuleURL.protocol
    ||resolvedURL.origin!==htmlImportModuleURL.origin){
    return value;
  }

  const fragmentIndex=value.indexOf('#');
  const fragment=fragmentIndex<0?'':value.slice(fragmentIndex);
  const resource=fragmentIndex<0?value:value.slice(0,fragmentIndex);
  const queryIndex=resource.indexOf('?');
  const pathname=queryIndex<0?resource:resource.slice(0,queryIndex);
  const query=queryIndex<0?'':resource.slice(queryIndex+1);
  const versionField=`arcaneVersion=${encodeURIComponent(htmlImportAssetVersion)}`;
  let replaced=false;
  const fields=query?query.split('&').map(function versionQueryField(field){
    if(!new URLSearchParams(field).has('arcaneVersion'))return field;
    if(replaced)return null;
    replaced=true;
    return versionField;
  }).filter(function retainQueryField(field){
    return field!==null;
  }):[];
  if(!replaced)fields.push(versionField);
  return `${pathname}?${fields.join('&')}${fragment}`;
}

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
  if(!runtimeRoot&&!htmlImportAssetVersion)return styleText;
  const parts=[];
  let copiedThrough=0;
  let index=0;

  function afterComment(start){
    const end=styleText.indexOf('*/',start+2);
    return end<0?styleText.length:end+2;
  }

  function afterEscape(start){
    let end=start+1;
    if(/[\da-f]/iu.test(styleText[end]||'')){
      const limit=end+6;
      while(end<limit&&/[\da-f]/iu.test(styleText[end]||''))end+=1;
      if(/[\t\n\f\r ]/u.test(styleText[end]||'')){
        end+=styleText[end]==='\r'&&styleText[end+1]==='\n'?2:1;
      }
      return end;
    }
    return end+(styleText[end]==='\r'&&styleText[end+1]==='\n'?2:1);
  }

  function afterString(start){
    const quote=styleText[start];
    let end=start+1;
    while(end<styleText.length){
      if(styleText[end]==='\\'){
        end=afterEscape(end);
      }else if(styleText[end]===quote){
        return end+1;
      }else if(/[\n\r\f]/u.test(styleText[end])){
        return end;
      }else{
        end+=1;
      }
    }
    return styleText.length;
  }

  function afterWhitespaceAndComments(start){
    let end=start;
    while(end<styleText.length){
      if(/[\t\n\f\r ]/u.test(styleText[end])){
        end+=1;
      }else if(styleText.startsWith('/*',end)){
        end=afterComment(end);
      }else{
        break;
      }
    }
    return end;
  }

  function appendResource(start,end){
    const resourcePath=styleText.slice(start,end);
    // CSS escapes retain their original spelling until their URL syntax is decoded.
    if(resourcePath.includes('\\'))return;
    const resolved=versionComponentResource(
      resolveComponentResource(resourcePath,runtimeRoot),
      document.baseURI
    );
    if(resolved===resourcePath)return;
    parts.push(styleText.slice(copiedThrough,start),resolved);
    copiedThrough=end;
  }

  while(index<styleText.length){
    if(styleText.startsWith('/*',index)){
      index=afterComment(index);
      continue;
    }
    if(styleText[index]==='"'||styleText[index]==="'"){
      index=afterString(index);
      continue;
    }

    const atRule=styleText[index]==='@';
    const hashToken=styleText[index]==='#';
    const nameStart=atRule||hashToken?index+1:index;
    let nameEnd=nameStart;
    while(nameEnd<styleText.length&&/[-\w\u0080-\uFFFF\\]/u.test(styleText[nameEnd])){
      nameEnd=styleText[nameEnd]==='\\'?afterEscape(nameEnd):nameEnd+1;
    }
    if(nameEnd===nameStart){
      index+=1;
      continue;
    }
    const name=styleText.slice(nameStart,nameEnd).toLowerCase();
    index=nameEnd;
    if(hashToken)continue;
    if(atRule&&name==='import'){
      const start=afterWhitespaceAndComments(nameEnd);
      if(styleText[start]==='"'||styleText[start]==="'"){
        const end=afterString(start);
        if(styleText[end-1]===styleText[start])appendResource(start+1,end-1);
        index=end;
      }
      continue;
    }
    if(atRule||name!=='url'||styleText[nameEnd]!=='(')continue;

    let start=nameEnd+1;
    while(start<styleText.length&&/[\t\n\f\r ]/u.test(styleText[start]))start+=1;
    if(styleText[start]==='"'||styleText[start]==="'"){
      const end=afterString(start);
      const close=afterWhitespaceAndComments(end);
      if(styleText[end-1]===styleText[start]&&styleText[close]===')'){
        appendResource(start+1,end-1);
        index=close+1;
      }else{
        index=end;
      }
      continue;
    }

    let end=start;
    while(end<styleText.length&&!/[\t\n\f\r )'"(]/u.test(styleText[end])){
      end=styleText[end]==='\\'?afterEscape(end):end+1;
    }
    let close=end;
    while(close<styleText.length&&/[\t\n\f\r ]/u.test(styleText[close]))close+=1;
    if(styleText[close]===')'){
      appendResource(start,end);
      index=close+1;
    }else{
      index=end;
    }
  }
  if(parts.length===0)return styleText;
  parts.push(styleText.slice(copiedThrough));
  return parts.join('');
}

function createComponentFragment(html,resolvedHref){
  const template=document.createElement('template');
  template.innerHTML=html;
  const runtimeRoot=componentRuntimeRoot(resolvedHref);

  for(const element of template.content.querySelectorAll('[href],[src]')){
    for(const attribute of ['href','src']){
      if(!element.hasAttribute(attribute))continue;
      const value=element.getAttribute(attribute);
      const resolved=resolveComponentResource(value,runtimeRoot);
      const navigation=attribute==='href'
        &&['a','area','base'].includes(element.localName);
      const versioned=navigation?resolved:versionComponentResource(
        resolved,
        element.localName==='script'?resolvedHref:document.baseURI
      );
      if(versioned!==value)element.setAttribute(attribute,versioned);
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

function resolveRelativeDynamicImports(source,baseHref){
  return source.replace(
    /\bimport\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/gu,
    function resolveDynamicImport(_match,_quote,specifier){
      const resolved=versionComponentResource(new URL(specifier,baseHref).href,baseHref);
      return `import(${JSON.stringify(resolved)})`;
    }
  );
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
  #eventOwner={kind:'html-import-lifecycle-owner'};
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
        eventTypes:[
          'html-import-error',
          'html-import-ready'
        ]
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
      const resolvedURL=new URL(href,document.baseURI);
      resolvedHref=versionComponentResource(resolvedURL.href,document.baseURI);
      const response=await fetch(resolvedHref,{
        cache:'default',
        method:'GET',
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
      const detail={
          code:'HTML_IMPORT_FAILED',
          href,
          message:'The component could not be loaded.',
          reason:'component-import-rejected',
          resolvedHref
      };
      const {occurrence}=this.#events.dispatch(
        'html-import-error',
        detail,
        {
          operationId,
          publicDetail:{code:detail.code,reason:detail.reason}
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
    const detail={
      code:'HTML_IMPORT_IMPORTED_COMPONENT_DESTROY_REJECTED',
      href,
      message:'The imported component could not be destroyed.',
      reason:'imported-component-destroy-rejected'
    };
    const {occurrence}=events.dispatch(
      'html-import-error',
      detail,
      {
        operationId,
        publicDetail:{code:detail.code,reason:detail.reason}
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
    const contentBaseHref=response.url||resolvedHref;
    this.shadowRoot.replaceChildren(createComponentFragment(html,contentBaseHref));

    await this.#executeScripts(contentBaseHref,generation,controller);
    if(!this.#isCurrentConnection(generation,controller)){
      await this.#destroyImportedHost();
      return false;
    }

    this.ready=true;
    const {occurrence}=this.#events.dispatch(
      'html-import-ready',
      {href,resolvedHref},
      {operationId,publicDetail:{ready:true}}
    );
    projectArcaneDOMEvent(this,occurrence,{
      bubbles:true,
      composed:true
    });
    return true;
  }

  async #executeScripts(contentBaseHref,generation,controller) {
    const scripts = Array.from(this.shadowRoot.querySelectorAll('script'));
    const previousDescriptor=Object.getOwnPropertyDescriptor(this,'destroy')??null;
    const previousDestroy=this.destroy;
    try{
      for(const script of scripts){
        if(!this.#isCurrentConnection(generation,controller))return;
        let source=script.textContent||'';
        let sourceBaseHref=contentBaseHref;
        const scriptSource=script.getAttribute('src');
        if(scriptSource!==null){
          const requestedScriptHref=versionComponentResource(
            new URL(scriptSource,contentBaseHref).href,
            contentBaseHref
          );
          const response=await fetch(requestedScriptHref,{
            cache:'default',
            method:'GET',
            signal:controller.signal
          });
          if(!response.ok){
            throw new Error(`HTML import script request failed with status ${response.status}.`);
          }
          source=await response.text();
          sourceBaseHref=response.url||requestedScriptHref;
          if(!this.#isCurrentConnection(generation,controller))return;
        }

        const executableSource=resolveRelativeDynamicImports(
          source,
          sourceBaseHref
        );
        const executable=document.createElement('script');
        const hostToken=`html-import-${Date.now()}-${htmlImportScriptId++}`;

        executable.dataset.arcaneHostToken=hostToken;
        executable.textContent=`(()=>{const registry=globalThis[Symbol.for('arcane.html-import.hosts')];const token=document.currentScript&&document.currentScript.dataset.arcaneHostToken;const binding=registry instanceof Map&&token?registry.get(token):null;if(!binding?.host)throw new Error('HTML import host binding is unavailable.');binding.promise=(async function(){${executableSource}}).call(binding.host);})()`;
        script.parentNode.removeChild(script);

        const binding={host:this,promise:null};
        htmlImportHostRegistry.set(hostToken,binding);
        try{
          document.head.appendChild(executable);
          if(!binding.promise||typeof binding.promise.then!=='function'){
            throw new Error('The HTML import script did not start.');
          }
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

/**
 * First-class browser module for Arcane's capability-gated Ollama service.
 * Apps should import this module instead of connecting to localhost:11434.
 */
import {
    createArcaneEventSource,
    projectArcaneDOMEvent
} from 'arcane-os/event-manager';

const PUBLISH_OLLAMA_READY=Symbol('publish-ollama-ready');

const ollamaEventTypes={
    ready:'arcane-ollama-ready'
};
const ollamaReasons={
    ready:'ollama-module-ready'
};
export const OLLAMA_EVENT_TYPES={...ollamaEventTypes};
export const OLLAMA_REASONS={...ollamaReasons};

function api(){
    const client=globalThis.Arcane?.ollama
    if(!client){
        const error=new Error('The Arcane Ollama API is unavailable. Open this app through Arcane OS.')
        error.code='ARCANE_OLLAMA_UNAVAILABLE'
        throw error
    }
    return client
}

export class Ollama{
    #events=createArcaneEventSource(this,{
        source:'ollama',
        eventTypes:Object.values(ollamaEventTypes)
    })

    version(){ return api().version() }
    models(){ return api().models() }
    list(){ return api().models() }
    running(){ return api().running() }
    show(model,options){ return api().show(model,options) }
    generate(request,options){ return api().generate(request,options) }
    chat(request,options){ return api().chat(request,options) }
    embed(request){ return api().embed(request) }
    pull(model,options,streamOptions){ return api().pull(model,options,streamOptions) }
    push(model,options,streamOptions){ return api().push(model,options,streamOptions) }
    create(request,options){ return api().create(request,options) }
    copy(source,destination){ return api().copy(source,destination) }
    delete(model){ return api().delete(model) }
    selection(){ return api().selection() }
    select(preference){ return api().select(preference) }
    settings(){ return api().settings() }
    saveSettings(settings){ return api().saveSettings(settings) }
    createBrain(definition){ return api().createBrain(definition) }
    serviceSettings(){ return api().serviceSettings() }
    saveServiceSettings(settings){ return api().saveServiceSettings(settings) }

    async readiness(){
        try{
            const response=await this.version()
            const version=String(
                typeof response==='string' ? response : response?.version||''
            ).trim()||null
            return {ready:true,version,errorCode:null}
        }catch(error){
            return {
                ready:false,
                version:null,
                errorCode:String(error?.code||'OLLAMA_UNAVAILABLE')
            }
        }
    }

    async generateText(request,options){
        const response=await this.generate(request,options)
        return String(response?.response||'')
    }

    async chatText(request,options){
        const response=await this.chat(request,options)
        return String(response?.message?.content||'')
    }

    unload(model){
        return this.generate({ model,prompt:'',keep_alive:0 })
    }

    [PUBLISH_OLLAMA_READY](){
        const reason=ollamaReasons.ready;
        const {occurrence}=this.#events.dispatch(
            ollamaEventTypes.ready,
            {ollama:this,reason},
            {
                operationId:`${this.#events.instanceId}:ready:1`,
                publicDetail:{ready:true,reason}
            }
        )
        if(typeof globalThis.CustomEvent==='function'
            &&typeof globalThis.dispatchEvent==='function'){
            projectArcaneDOMEvent(globalThis,occurrence)
        }
    }
}

export const ollama=new Ollama()
export default ollama

if(!Object.prototype.hasOwnProperty.call(globalThis,'arcaneOllama')){
    Object.defineProperty(globalThis,'arcaneOllama',{ value:ollama,enumerable:true,configurable:true,writable:true })
}
ollama[PUBLISH_OLLAMA_READY]()

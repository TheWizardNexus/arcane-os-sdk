import Is from 'strong-type';
const is=new Is(false);

export default class SystemAppearance{
    constructor(api=globalThis.Arcane?.appearance||null){ this.api=api; }

    available(){ return Boolean(this.api&&is.function(this.api.apply)); }

    async current(){
        if(!this.api||!is.function(this.api.current)) return {supported:false,platform:'browser'};
        try{
            return await this.api.current();
        }catch(error){
            return unsupportedNamespace(error,'current');
        }
    }

    async apply(input={}){
        if(!this.available()) return {supported:false,platform:'browser'};
        const scheme=['system','light','dark'].includes(input.scheme)?input.scheme:'system';
        try{
            return await this.api.apply({
                scheme,
                captionColor:scheme==='system'?null:input.captionColor||null,
                textColor:scheme==='system'?null:input.textColor||null
            });
        }catch(error){
            return unsupportedNamespace(error,'apply');
        }
    }
}

function unsupportedNamespace(error,method){
    if(error?.code==='METHOD_NOT_ALLOWED'
        &&error.reason==='core-namespace-unavailable'
        &&error.namespace==='appearance'
        &&error.method===`appearance.${method}`){
        return {supported:false,reason:'core-namespace-unavailable',error};
    }
    throw error;
}

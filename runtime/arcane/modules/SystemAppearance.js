import Is from 'strong-type';
const is=new Is(false);

export default class SystemAppearance{
    constructor(api=globalThis.Arcane?.appearance||null){ this.api=api; }

    available(){ return Boolean(this.api&&is.function(this.api.apply)); }

    async current(){
        if(!this.api||!is.function(this.api.current)) return {supported:false,platform:'browser'};
        return this.api.current();
    }

    async apply(input={}){
        if(!this.available()) return {supported:false,platform:'browser'};
        const scheme=['system','light','dark'].includes(input.scheme)?input.scheme:'system';
        return this.api.apply({
            scheme,
            captionColor:scheme==='system'?null:input.captionColor||null,
            textColor:scheme==='system'?null:input.textColor||null
        });
    }
}

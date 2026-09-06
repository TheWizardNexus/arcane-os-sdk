import Is from 'strong-type';
const is=new Is(false);

function deepFreeze(value){
    if(!value||!is.object(value)||Object.isFrozen(value)) return value;
    for(const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

export default class ApiModelRecord{
    constructor({endpoint,fetchedAt=new Date(),metadata={},value=null}={}){
        const url=new URL(String(endpoint||''));
        if(!['http:','https:'].includes(url.protocol)) throw new TypeError('API model endpoints must use HTTP or HTTPS.');
        const instant=new Date(fetchedAt);
        if(is.NaN(instant.valueOf())) throw new TypeError('API model fetch time is invalid.');
        this.endpoint=url.href;
        this.fetchedAt=instant.toISOString();
        this.metadata=deepFreeze({...metadata});
        this.value=deepFreeze(value);
        Object.freeze(this);
    }
    toJSON(){return {endpoint:this.endpoint,fetchedAt:this.fetchedAt,metadata:this.metadata,value:this.value};}
}

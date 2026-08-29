export default class Calculation{
    constructor({expression,result,createdAt=new Date()}={}){
        this.expression=String(expression??'');
        if(!this.expression.trim()) throw new TypeError('Calculation expressions must contain text.');
        this.result=Number(result);
        if(!Number.isFinite(this.result)) throw new RangeError('Calculation result must be finite.');
        const instant=new Date(createdAt);
        if(Number.isNaN(instant.valueOf())) throw new TypeError('Calculation time is invalid.');
        this.createdAt=instant.toISOString();
    }
    toJSON(){return {...this};}
}

function completeText(value){return String(value??'');}

export function normalizeContentAdvisory(value){
    if(!value||typeof value!=='object')return null;
    return {
        level:['critical','high','caution','low','unavailable'].includes(value.level)?value.level:'caution',
        title:completeText(value.title??'Content advisory'),
        summary:completeText(value.summary??'Review this message carefully.'),
        signals:Array.from(value.signals||[],completeText),
        actionLabel:completeText(value.actionLabel),
    };
}

function unavailableAdvisory(){
    return normalizeContentAdvisory({
        level:'unavailable',
        title:'Safety check unavailable',
        summary:'No safety conclusion was made for this message. Pause and review it manually before replying.',
    });
}

export function unavailableMessageInspection(messages){
    const advisories=new Map();
    for(const message of Array.from(messages||[]))advisories.set(message,unavailableAdvisory());
    return {advisories,failures:advisories.size};
}

export async function inspectMessageRecords(messages,inspector,{prepare}={}){
    const advisories=new Map();let failures=0;
    if(typeof inspector!=='function')return {advisories,failures};
    const records=Array.from(messages||[]);
    let context;
    try{context=typeof prepare==='function'?await prepare(records):undefined;}
    catch{return unavailableMessageInspection(records);}
    for(const message of records){
        try{const advisory=normalizeContentAdvisory(await inspector(message,context));if(advisory){if(advisory.level==='unavailable')failures+=1;advisories.set(message,advisory);}}
        catch{failures+=1;advisories.set(message,unavailableAdvisory());}
    }
    return {advisories,failures};
}

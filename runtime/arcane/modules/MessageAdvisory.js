function bounded(value,maximum){return String(value??'').trim().slice(0,maximum);}

export function normalizeContentAdvisory(value){
    if(!value||typeof value!=='object')return null;
    return Object.freeze({
        level:['critical','high','caution','low','unavailable'].includes(value.level)?value.level:'caution',
        title:bounded(value.title||'Content advisory',120),
        summary:bounded(value.summary||'Review this message carefully.',500),
        signals:Object.freeze(Array.from(value.signals||[],item=>bounded(item,120)).filter(Boolean).slice(0,8)),
        actionLabel:bounded(value.actionLabel,80),
    });
}

const unavailableAdvisory=normalizeContentAdvisory({
    level:'unavailable',
    title:'Safety check unavailable',
    summary:'No safety conclusion was made for this message. Pause and review it manually before replying.',
});

export function unavailableMessageInspection(messages){
    const advisories=new Map();
    for(const message of Array.from(messages||[]))advisories.set(message,unavailableAdvisory);
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
        catch{failures+=1;advisories.set(message,unavailableAdvisory);}
    }
    return {advisories,failures};
}

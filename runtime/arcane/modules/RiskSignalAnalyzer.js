const DEFAULT_LEVELS=[
    {minimum:70,id:'critical'},
    {minimum:40,id:'high'},
    {minimum:15,id:'caution'},
    {minimum:0,id:'low'},
];

function normalizeText(value){
    return String(value??'').normalize('NFKC');
}

export function analyzeRiskSignals(input,{signals=[],levels=DEFAULT_LEVELS}={}){
    const text=normalizeText(input);
    const matches=[];
    let score=0;

    for(const signal of signals){
        if(!signal||typeof signal.id!=='string'||!(signal.pattern instanceof RegExp))continue;
        signal.pattern.lastIndex=0;
        if(!signal.pattern.test(text))continue;
        const weight=Math.max(0,Number(signal.weight)||0);
        score+=weight;
        matches.push({
            id:signal.id,
            label:String(signal.label||signal.id),
            weight,
            guidance:String(signal.guidance||''),
        });
    }

    const ordered=[...levels].sort((a,b)=>b.minimum-a.minimum);
    const level=ordered.find(candidate=>score>=candidate.minimum)?.id||'unknown';
    return {level,matches,score,textLength:text.length};
}

export {DEFAULT_LEVELS};

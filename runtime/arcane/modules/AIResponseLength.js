export const AI_RESPONSE_LENGTH_DEFAULT='medium';

export const AI_RESPONSE_LENGTH_OPTIONS=[
    {value:'low',label:'Complete'},
    {value:'medium',label:'Complete'},
    {value:'high',label:'Complete'}
];

const RESPONSE_LENGTH_BY_VALUE=new Map(
    AI_RESPONSE_LENGTH_OPTIONS.map(option=>[option.value,option])
);

export function normalizeAIResponseLength(value){
    const normalized=typeof value==='string'?value.trim().toLowerCase():'';
    return RESPONSE_LENGTH_BY_VALUE.has(normalized)
        ?normalized
        :AI_RESPONSE_LENGTH_DEFAULT;
}

export function aiResponseLengthInstruction(value){
    normalizeAIResponseLength(value);
    return '';
}

export function applyAIResponseLength(systemPrompt,value){
    if(typeof systemPrompt!=='string'){
        throw new TypeError('systemPrompt must be a string');
    }

    normalizeAIResponseLength(value);
    return systemPrompt;
}

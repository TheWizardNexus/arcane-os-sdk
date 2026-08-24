const RESPONSE_LENGTH_HEADING='## Application-selected response length';

export const AI_RESPONSE_LENGTH_DEFAULT='medium';

export const AI_RESPONSE_LENGTH_OPTIONS=Object.freeze([
    Object.freeze({value:'low',label:'Low (1–5 sentences)',minSentences:1,maxSentences:5}),
    Object.freeze({value:'medium',label:'Medium (6–10 sentences)',minSentences:6,maxSentences:10}),
    Object.freeze({value:'high',label:'High (11–20 sentences)',minSentences:11,maxSentences:20})
]);

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
    const option=RESPONSE_LENGTH_BY_VALUE.get(normalizeAIResponseLength(value));
    const sentenceTarget=`Aim for ${option.minSentences} to ${option.maxSentences} sentences.`;

    return `${RESPONSE_LENGTH_HEADING}
${sentenceTarget} A more specific response-length request in the current user message overrides this saved target. Application requirements, tool or function calls, structured response schemas, safety or crisis requirements, evidence and source attribution, uncertainty, warnings, and next steps override the sentence target. Do not omit required information, invent information, or pad the response merely to reach the target.`;
}

export function applyAIResponseLength(systemPrompt,value){
    if(typeof systemPrompt!=='string'){
        throw new TypeError('systemPrompt must be a string');
    }

    const prompt=systemPrompt.trimEnd();
    if(prompt.includes(RESPONSE_LENGTH_HEADING)){
        return prompt;
    }

    const instruction=aiResponseLengthInstruction(value);
    return prompt?`${prompt}\n\n${instruction}`:instruction;
}

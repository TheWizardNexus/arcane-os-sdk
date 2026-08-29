const SENTENCE_BOUNDARY=/[.!?]+(?:["'\\u2019\\u201d)\\]}]+)?(?=\\s|$)/gu;
const WORD_OR_NUMBER=/[\\p{L}\\p{N}]/u;

function codedError(code,message,ErrorType=Error){
    const error=new ErrorType(message);
    error.code=code;
    return error;
}

function isPlainRecord(value){
    return Boolean(value)
        &&typeof value==='object'
        &&!Array.isArray(value);
}

function countSentences(value){
    if(typeof value!=='string'){
        throw new TypeError('Sentence counting requires a string.');
    }
    if(!value.trim()){
        return 0;
    }
    let count=0;
    let consumed=0;
    SENTENCE_BOUNDARY.lastIndex=0;
    for(const match of value.matchAll(SENTENCE_BOUNDARY)){
        count+=1;
        consumed=Number(match.index)+match[0].length;
    }
    const trailing=value.slice(consumed);
    if(trailing.trim()&&(count===0||WORD_OR_NUMBER.test(trailing))){
        count+=1;
    }
    return count;
}

function requireLocalAI(localAI){
    if(!localAI
        ||typeof localAI.inspectIsolatedModel!=='function'
        ||typeof localAI.runIsolatedQuestion!=='function'){
        throw codedError(
            'ARCANE_ISOLATED_MODEL_API_UNAVAILABLE',
            'The Arcane isolated-model API is unavailable. Open this application through a compatible Arcane OS host.'
        );
    }
    return localAI;
}

class IsolatedModelQuestionRunner{
    constructor({localAI}={}){
        this.localAI=requireLocalAI(localAI);
    }

    async inspectModel(model,expectedModel,contextTokens){
        if(typeof model!=='string'||!model.trim()){
            throw codedError(
                'INVALID_ISOLATED_MODEL_RUNNER_REQUEST',
                'The isolated-model inspection requires a model.',
                TypeError
            );
        }
        if(contextTokens!==undefined&&(!Number.isSafeInteger(contextTokens)||contextTokens<1)){
            throw codedError(
                'INVALID_ISOLATED_MODEL_RUNNER_REQUEST',
                'The isolated-model inspection context token value must be positive when provided.',
                RangeError
            );
        }
        const request={model};
        if(expectedModel!==undefined)request.expectedModel=expectedModel;
        if(contextTokens!==undefined)request.contextTokens=contextTokens;
        return this.localAI.inspectIsolatedModel(request);
    }

    async runQuestion(input={}){
        if(!isPlainRecord(input)){
            throw codedError(
                'INVALID_ISOLATED_MODEL_RUNNER_REQUEST',
                'The isolated-model question request must be an object.',
                TypeError
            );
        }
        const {onPhase,...request}=input;
        if(typeof request.model!=='string'
            ||!request.model.trim()
            ||typeof request.prompt!=='string'
            ||(Object.hasOwn(request,'systemPrompt')&&typeof request.systemPrompt!=='string')
            ||(Object.hasOwn(request,'options')&&!isPlainRecord(request.options))
            ||(onPhase!==undefined&&typeof onPhase!=='function')){
            throw codedError(
                'INVALID_ISOLATED_MODEL_RUNNER_REQUEST',
                'The isolated-model question request contains invalid values.',
                TypeError
            );
        }
        const streamOptions=onPhase===undefined?{}:{onPhase};
        const result=await this.localAI.runIsolatedQuestion(request,streamOptions);
        if(!isPlainRecord(result)||typeof result.answer!=='string'){
            throw codedError(
                'ARCANE_ISOLATED_MODEL_RESPONSE_INVALID',
                'Arcane Core returned an invalid isolated-model response.'
            );
        }
        return {
            ...result,
            sentenceCount:countSentences(result.answer)
        };
    }
}

export {IsolatedModelQuestionRunner,countSentences};
export default IsolatedModelQuestionRunner;

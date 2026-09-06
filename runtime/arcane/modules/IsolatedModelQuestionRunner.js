import Is from 'strong-type';
const is=new Is(false);

const SENTENCE_BOUNDARY=/[.!?]+(?:["'\\u2019\\u201d)\\]}]+)?(?=\\s|$)/gu;
const WORD_OR_NUMBER=/[\\p{L}\\p{N}]/u;

function codedError(code,message,ErrorType=Error){
    const error=new ErrorType(message);
    error.code=code;
    return error;
}

function isPlainRecord(value){
    return Boolean(value)
        &&is.object(value)
        &&!is.array(value);
}

function countSentences(value){
    if(!is.string(value)){
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
        ||!is.function(localAI.inspectIsolatedModel)
        ||!is.function(localAI.runIsolatedQuestion)){
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
        if(!is.string(model)||!model.trim()){
            throw codedError(
                'INVALID_ISOLATED_MODEL_RUNNER_REQUEST',
                'The isolated-model inspection requires a model.',
                TypeError
            );
        }
        if(contextTokens!==undefined&&(!is.safeInteger(contextTokens)||contextTokens<1)){
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
        if(!is.string(request.model)
            ||!request.model.trim()
            ||!is.string(request.prompt)
            ||(Object.hasOwn(request,'systemPrompt')&&!is.string(request.systemPrompt))
            ||(Object.hasOwn(request,'options')&&!isPlainRecord(request.options))
            ||(onPhase!==undefined&&!is.function(onPhase))){
            throw codedError(
                'INVALID_ISOLATED_MODEL_RUNNER_REQUEST',
                'The isolated-model question request contains invalid values.',
                TypeError
            );
        }
        const streamOptions=onPhase===undefined?{}:{onPhase};
        const result=await this.localAI.runIsolatedQuestion(request,streamOptions);
        if(!isPlainRecord(result)||!is.string(result.answer)){
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

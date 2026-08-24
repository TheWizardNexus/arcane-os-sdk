const MODEL_EVIDENCE_KEYS=Object.freeze([
    'id',
    'name',
    'provider',
    'digest',
    'sizeBytes',
    'modifiedAt'
]);
const RUN_REQUEST_KEYS=Object.freeze([
    'model',
    'prompt',
    'systemPrompt',
    'options',
    'expectedModel'
]);
const RUN_REQUEST_OPTIONAL_KEYS=Object.freeze(['onPhase','think']);
const THINK_LEVELS=Object.freeze(['low','medium','high']);
const SENTENCE_BOUNDARY=/[.!?]+(?:["'\u2019\u201d)\]}]+)?(?=\s|$)/gu;
const WORD_OR_NUMBER=/[\p{L}\p{N}]/u;

function codedError(code,message,ErrorType=Error){
    const error=new ErrorType(message);
    error.code=code;
    return error;
}

function isPlainRecord(value){
    return Boolean(value)
        &&typeof value==='object'
        &&!Array.isArray(value)
        &&Object.getPrototypeOf(value)===Object.prototype;
}

function hasExactKeys(value,required,optional=[]){
    if(!isPlainRecord(value)){
        return false;
    }
    const requiredSet=new Set(required);
    const allowed=new Set([...required,...optional]);
    const keys=Object.keys(value);
    return required.every(function requiredKey(key){return Object.hasOwn(value,key);})
        &&keys.every(function allowedKey(key){return allowed.has(key);})
        &&keys.filter(function requiredKey(key){return requiredSet.has(key);}).length===required.length;
}

function exactTimestamp(value){
    if(typeof value!=='string'){
        return null;
    }
    const milliseconds=Date.parse(value);
    if(!Number.isFinite(milliseconds)||new Date(milliseconds).toISOString()!==value){
        return null;
    }
    return milliseconds;
}

function validModifiedAt(value){
    return value===null||(typeof value==='string'&&Number.isFinite(Date.parse(value)));
}

function validateExpectedModel(model,expectedModel){
    const valid=typeof model==='string'
        &&model.length>0
        &&model===model.trim()
        &&hasExactKeys(expectedModel,MODEL_EVIDENCE_KEYS)
        &&expectedModel.id===model
        &&expectedModel.name===model
        &&expectedModel.provider==='ollama'
        &&/^[a-f0-9]{64}$/i.test(expectedModel.digest)
        &&Number.isSafeInteger(expectedModel.sizeBytes)
        &&expectedModel.sizeBytes>0
        &&validModifiedAt(expectedModel.modifiedAt);
    if(!valid){
        throw codedError(
            'INVALID_ISOLATED_MODEL_RUNNER_REQUEST',
            'The isolated-model request requires exact authoritative model evidence.',
            TypeError
        );
    }
}

function sameModelEvidence(actual,expected){
    return hasExactKeys(actual,MODEL_EVIDENCE_KEYS)
        &&MODEL_EVIDENCE_KEYS.every(function matchingField(field){
            return actual[field]===expected[field];
        });
}

function validDefaults(value){
    return hasExactKeys(value,['systemPromptPresent','messageCount'])
        &&value.systemPromptPresent===false
        &&value.messageCount===0;
}

function invalidProof(message){
    throw codedError(
        'ARCANE_ISOLATED_MODEL_PROOF_INVALID',
        message||'Arcane Core returned an invalid isolated-model proof.'
    );
}

function validateInspection(result,expectedModel,contextTokens){
    if(!hasExactKeys(result,['schemaVersion','model','defaults','admission'])
        ||result.schemaVersion!==1
        ||!sameModelEvidence(result.model,expectedModel)
        ||!validDefaults(result.defaults)
        ||!isPlainRecord(result.admission)
        ||result.admission.admitted!==true
        ||result.admission.contextTokens!==contextTokens){
        invalidProof('Arcane Core returned an invalid isolated-model inspection proof.');
    }
    return result;
}

function validateAbsenceProof(value){
    return hasExactKeys(value,['absent','observedAt','polls'])
        &&value.absent===true
        &&exactTimestamp(value.observedAt)!==null
        &&Number.isSafeInteger(value.polls)
        &&value.polls>0;
}

function validateIsolation(value){
    if(!hasExactKeys(value,['pre','post','keepAlive','messageCount','defaults'])
        ||!validateAbsenceProof(value.pre)
        ||!validateAbsenceProof(value.post)
        ||exactTimestamp(value.pre.observedAt)>exactTimestamp(value.post.observedAt)
        ||value.keepAlive!==0
        ||value.messageCount!==2
        ||!validDefaults(value.defaults)){
        invalidProof('Arcane Core did not prove the required isolated-model lifecycle.');
    }
    return value;
}

function validateRunResult(result,expectedModel){
    if(!hasExactKeys(result,[
        'schemaVersion',
        'model',
        'answer',
        'startedAt',
        'completedAt',
        'elapsedMs',
        'isolation'
    ])
        ||result.schemaVersion!==1
        ||!sameModelEvidence(result.model,expectedModel)
        ||typeof result.answer!=='string'){
        invalidProof('Arcane Core returned an invalid isolated-model response.');
    }
    const started=exactTimestamp(result.startedAt);
    const completed=exactTimestamp(result.completedAt);
    if(started===null
        ||completed===null
        ||completed<started
        ||!Number.isFinite(result.elapsedMs)
        ||result.elapsedMs<0){
        invalidProof('Arcane Core returned invalid isolated-model timing evidence.');
    }
    validateIsolation(result.isolation);
    return result;
}

/**
 * Counts terminal sentence-punctuation groups and one final unpunctuated
 * fragment. The heuristic is deliberately deterministic and never rewrites
 * the response it observes.
 */
function countSentences(value){
    if(typeof value!=='string'){
        throw new TypeError('Sentence counting requires a string.');
    }
    const text=value.trim();
    if(!text){
        return 0;
    }
    let count=0;
    let consumed=0;
    SENTENCE_BOUNDARY.lastIndex=0;
    for(const match of text.matchAll(SENTENCE_BOUNDARY)){
        count+=1;
        consumed=Number(match.index)+match[0].length;
    }
    const trailing=text.slice(consumed).trim();
    if(trailing&&(count===0||WORD_OR_NUMBER.test(trailing))){
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
    constructor({localAI,maxSentences=5}={}){
        if(!Number.isSafeInteger(maxSentences)||maxSentences<1||maxSentences>100){
            throw new RangeError('maxSentences must be an integer from 1 through 100.');
        }
        this.localAI=requireLocalAI(localAI);
        this.maxSentences=maxSentences;
    }

    async inspectModel(model,expectedModel,contextTokens){
        validateExpectedModel(model,expectedModel);
        if(!Number.isSafeInteger(contextTokens)||contextTokens<1024||contextTokens>262144){
            throw codedError(
                'INVALID_ISOLATED_MODEL_RUNNER_REQUEST',
                'The isolated-model inspection requires a context from 1,024 through 262,144 tokens.',
                RangeError
            );
        }
        const result=await this.localAI.inspectIsolatedModel({model,expectedModel,contextTokens});
        return validateInspection(result,expectedModel,contextTokens);
    }

    async runQuestion(input={}){
        if(!hasExactKeys(input,RUN_REQUEST_KEYS,RUN_REQUEST_OPTIONAL_KEYS)){
            throw codedError(
                'INVALID_ISOLATED_MODEL_RUNNER_REQUEST',
                'The isolated-model question request has unsupported or missing fields.',
                TypeError
            );
        }
        const {model,prompt,systemPrompt,options,think,expectedModel,onPhase}=input;
        const hasThink=Object.hasOwn(input,'think');
        validateExpectedModel(model,expectedModel);
        if(typeof prompt!=='string'
            ||typeof systemPrompt!=='string'
            ||!isPlainRecord(options)
            ||(hasThink&&!THINK_LEVELS.includes(think))
            ||(onPhase!==undefined&&typeof onPhase!=='function')){
            throw codedError(
                'INVALID_ISOLATED_MODEL_RUNNER_REQUEST',
                'The isolated-model question request contains invalid values.',
                TypeError
            );
        }
        const request={
            model,
            prompt,
            systemPrompt,
            options,
            ...(hasThink?{think}:{}),
            expectedModel
        };
        const streamOptions=onPhase===undefined?{}:{onPhase};
        const result=validateRunResult(
            await this.localAI.runIsolatedQuestion(request,streamOptions),
            expectedModel
        );
        const sentenceCount=countSentences(result.answer);
        return Object.freeze({
            answer:result.answer,
            startedAt:result.startedAt,
            completedAt:result.completedAt,
            elapsedMs:result.elapsedMs,
            isolation:result.isolation,
            model:result.model,
            sentenceCount,
            sentenceLimitExceeded:sentenceCount>this.maxSentences
        });
    }
}

export {IsolatedModelQuestionRunner,countSentences};
export default IsolatedModelQuestionRunner;

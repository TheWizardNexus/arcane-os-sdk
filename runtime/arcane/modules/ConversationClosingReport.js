import {
    CONVERSATION_ACTION_ITEM_BASES,
    MAX_CONVERSATION_ACTION_ITEM_CHARACTERS,
    MAX_CONVERSATION_REMEMBERED_ACTIONS,
    normalizeRememberedConversationActions
} from './ConversationActionItems.js?v=2';

const DEFAULT_TOOL_NAME='prepare_conversation_closing_report';
const TOOL_NAME_PATTERN=/^[a-z][a-z0-9_]{0,63}$/;
const MAX_ARGUMENT_CHARACTERS=16*1024;
const MAX_FINAL_MESSAGE_CHARACTERS=5000;
const REPORT_FIELDS=Object.freeze(new Set([
    'final_message',
    'remembered_actions'
]));

function invalid(message){
    const error=new TypeError(message);
    error.code='CONVERSATION_CLOSING_REPORT_INVALID';
    return error;
}

function isPlainRecord(value){
    if(!value||typeof value!=='object'||Array.isArray(value)){
        return false;
    }

    const prototype=Object.getPrototypeOf(value);
    return prototype===Object.prototype||prototype===null;
}

function boundedText(value,label,maximum,{required=false}={}){
    if(value===undefined||value===null||value===''){
        if(required){
            throw invalid(`${label} is required.`);
        }
        return '';
    }
    if(typeof value!=='string'){
        throw invalid(`${label} must be a string.`);
    }

    const normalized=value.replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim();

    if(!normalized&&required){
        throw invalid(`${label} is required.`);
    }
    if(normalized.length>maximum){
        throw invalid(`${label} exceeds ${maximum} characters.`);
    }

    return normalized;
}

function boundedFinalMessage(value){
    if(typeof value!=='string'){
        throw invalid('final_message must be a string.');
    }

    const normalized=value
        .replace(/\r\n?/g,'\n')
        .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]+/g,' ')
        .trim();

    if(!normalized){
        throw invalid('final_message is required.');
    }
    if(normalized.length>MAX_FINAL_MESSAGE_CHARACTERS){
        throw invalid(
            `final_message exceeds ${MAX_FINAL_MESSAGE_CHARACTERS} characters.`
        );
    }

    return normalized;
}

function parseArguments(value){
    if(typeof value==='string'){
        if(!value||value.length>MAX_ARGUMENT_CHARACTERS){
            throw invalid('The closing-report arguments exceed the allowed size.');
        }

        try{
            value=JSON.parse(value);
        }catch{
            throw invalid('The closing-report arguments must be valid JSON.');
        }
    }
    if(!isPlainRecord(value)){
        throw invalid('The closing-report arguments must be an object.');
    }

    return value;
}

function escapeRawHTML(value){
    return value
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;');
}

function deepFreeze(value){
    if(!value||typeof value!=='object'||Object.isFrozen(value)){
        return value;
    }

    for(const child of Object.values(value)){
        deepFreeze(child);
    }

    return Object.freeze(value);
}

/**
 * Creates a provider-neutral terminal tool for one user-facing conversation
 * closeout. The tool performs no inference, persistence, rendering, task
 * execution, navigation, or external delivery.
 */
export function createConversationClosingReportTool({
    name=DEFAULT_TOOL_NAME,
    description='Prepare a bounded closing report when the user clearly ends a conversation.'
}={}){
    if(typeof name!=='string'||!TOOL_NAME_PATTERN.test(name)){
        throw invalid('The closing-report tool name is invalid.');
    }
    if(typeof description!=='string'||!description.trim()||description.length>1000){
        throw invalid('The closing-report tool description is invalid.');
    }

    return deepFreeze({
        type:'function',
        function:{
            name,
            description:description.trim(),
            parameters:{
                type:'object',
                additionalProperties:false,
                properties:{
                    final_message:{
                        type:'string',
                        minLength:1,
                        maxLength:MAX_FINAL_MESSAGE_CHARACTERS,
                        description:'The complete final response shown to the user to close the conversation. When useful and grounded in the conversation, include a concise summary of what was accomplished, concrete progress or takeaways, and optional next steps or homework. Omit any of those elements when they would be inappropriate, unsafe, unwanted, or unsupported. Present next steps as choices, never obligations. If remembered_actions are included, mention them only as agreed follow-ups and never claim they were saved. End with a calm, warm closing that does not pressure the user or create new obligations.'
                    },
                    remembered_actions:{
                        type:'array',
                        maxItems:MAX_CONVERSATION_REMEMBERED_ACTIONS,
                        items:{
                            type:'object',
                            additionalProperties:false,
                            properties:{
                                text:{
                                    type:'string',
                                    minLength:1,
                                    maxLength:MAX_CONVERSATION_ACTION_ITEM_CHARACTERS,
                                    description:'The follow-up the user explicitly agreed to carry into a later conversation.'
                                },
                                basis:{
                                    type:'string',
                                    enum:[...CONVERSATION_ACTION_ITEM_BASES],
                                    description:'Use exactly "user_commitment" when the user explicitly committed to act. Use exactly "optional_homework" only when the user explicitly agreed to carry optional homework forward.'
                                }
                            },
                            required:['text','basis']
                        },
                        description:'Optional machine-readable follow-ups for local Profile persistence. Include only commitments or optional homework the user explicitly agreed to carry into a later conversation. Do not include ordinary suggestions from final_message.'
                    }
                },
                required:['final_message']
            }
        }
    });
}

/**
 * Returns a system-prompt suffix for an app-provided terminal tool. The app
 * owns the trigger, provider call, persistence, rendering, and recipient.
 */
export function conversationClosingReportInstruction({
    enabled=true,
    toolName=DEFAULT_TOOL_NAME,
    completionTrigger='the user clearly says they are finished or explicitly asks to wrap up'
}={}){
    if(enabled!==true){
        return '';
    }
    if(typeof toolName!=='string'||!TOOL_NAME_PATTERN.test(toolName)){
        throw invalid('The closing-report tool name is invalid.');
    }

    const trigger=boundedText(
        completionTrigger,
        'The conversation completion trigger',
        1000,
        {required:true}
    );

    return `## Conversation closeout\nWhen ${trigger}, call \`${toolName}\` as the sole tool call and do not also answer in prose. Do not call it after a routine answer, while requested work remains open, or merely because a response is long. Use only facts established in the conversation. Never diagnose, score, judge, or infer personal traits. Put the complete user-facing closeout in final_message. Populate remembered_actions only for a commitment or optional homework the user explicitly agreed to carry into a later conversation; never turn an ordinary suggestion into a saved obligation or claim it was saved. The application separately requests consent before saving a remembered action, displays final_message in the conversation, and reports the save result. The tool does not send anything elsewhere or perform any suggested action.`;
}

export function normalizeConversationClosingReport(value){
    const source=parseArguments(value);
    const unexpectedField=Object.keys(source).find(field=>!REPORT_FIELDS.has(field));

    if(unexpectedField){
        throw invalid(`Unexpected closing-report field: ${unexpectedField}.`);
    }

    return Object.freeze({
        finalMessage:boundedFinalMessage(source.final_message),
        rememberedActions:normalizeRememberedConversationActions(
            source.remembered_actions||[]
        )
    });
}

/**
 * Accepts a closing report only when it is the sole tool call. A mixed call is
 * never partially executed, so closing cannot silently accompany another
 * action or external side effect.
 */
export function classifyConversationClosingReportCalls(calls={}, {
    toolName=DEFAULT_TOOL_NAME
}={}){
    if(typeof toolName!=='string'||!TOOL_NAME_PATTERN.test(toolName)){
        throw invalid('The closing-report tool name is invalid.');
    }
    if(!isPlainRecord(calls)){
        return Object.freeze({present:false,accepted:false,report:null,error:invalid('Tool calls must be an object.')});
    }

    const names=Object.keys(calls);
    const present=Object.hasOwn(calls,toolName);

    if(!present){
        return Object.freeze({present:false,accepted:false,report:null,error:null});
    }
    if(names.length!==1){
        return Object.freeze({
            present:true,
            accepted:false,
            report:null,
            error:invalid('A conversation closing report must be the sole tool call.')
        });
    }

    try{
        return Object.freeze({
            present:true,
            accepted:true,
            report:normalizeConversationClosingReport(calls[toolName]),
            error:null
        });
    }catch(error){
        return Object.freeze({present:true,accepted:false,report:null,error});
    }
}

export function formatConversationClosingReport(value){
    const normalizedInput=isPlainRecord(value)&&value.finalMessage!==undefined
        ?{
            final_message:value.finalMessage,
            remembered_actions:value.rememberedActions,
        }
        :value;
    return escapeRawHTML(
        normalizeConversationClosingReport(normalizedInput).finalMessage
    );
}

export {
    DEFAULT_TOOL_NAME as CONVERSATION_CLOSING_REPORT_TOOL_NAME
};

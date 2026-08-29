import {
    CONVERSATION_ACTION_ITEM_BASES,
    normalizeRememberedConversationActions
} from './ConversationActionItems.js?v=2';

const DEFAULT_TOOL_NAME='prepare_conversation_closing_report';
const TOOL_NAME_PATTERN=/^[a-z][a-z0-9_]*$/;
const REPORT_FIELDS=new Set([
    'message',
    'final_message',
    'remembered_actions'
]);

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

function normalizedText(value,label,{required=false}={}){
    if(value===undefined||value===null||value===''){
        if(required){
            throw invalid(`${label} is required.`);
        }
        return '';
    }
    if(typeof value!=='string'){
        throw invalid(`${label} must be a string.`);
    }

    if(!value.trim()&&required){
        throw invalid(`${label} is required.`);
    }
    return value;
}

function normalizedFinalMessage(value){
    if(typeof value!=='string'){
        throw invalid('final_message must be a string.');
    }

    if(!value.trim()){
        throw invalid('final_message is required.');
    }
    return value;
}

function parseArguments(value){
    if(typeof value==='string'){
        if(!value)throw invalid('The closing-report arguments are required.');

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

function completeValue(value){
    return value;
}

/**
 * Creates a provider-neutral terminal tool for one user-facing conversation
 * closeout. The tool performs no inference, persistence, rendering, task
 * execution, navigation, or external delivery.
 */
export function createConversationClosingReportTool({
    name=DEFAULT_TOOL_NAME,
    description='Prepare a complete closing report when the user clearly ends a conversation.'
}={}){
    if(typeof name!=='string'||!TOOL_NAME_PATTERN.test(name)){
        throw invalid('The closing-report tool name is invalid.');
    }
    if(typeof description!=='string'||!description.trim()){
        throw invalid('The closing-report tool description is invalid.');
    }

    return completeValue({
        type:'function',
        function:{
            name,
            description,
            parameters:{
                type:'object',
                additionalProperties:false,
                properties:{
                    message:{
                        type:'string',
                        minLength:1,
                        description:'Brief plain-language progress text shown to the user while the application accepts and renders the closing report. Do not put the complete closeout here or claim that later actions were saved.'
                    },
                    final_message:{
                        type:'string',
                        minLength:1,
                        description:'The complete final response shown to the user to close the conversation. When useful and grounded in the conversation, include a concise summary of what was accomplished, concrete progress or takeaways, and optional next steps or homework. Omit any of those elements when they would be inappropriate, unsafe, unwanted, or unsupported. Present next steps as choices, never obligations. If remembered_actions are included, mention them only as agreed follow-ups and never claim they were saved. End with a calm, warm closing that does not pressure the user or create new obligations.'
                    },
                    remembered_actions:{
                        type:'array',
                        items:{
                            type:'object',
                            additionalProperties:false,
                            properties:{
                                text:{
                                    type:'string',
                                    minLength:1,
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
                required:['message','final_message']
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

    const trigger=normalizedText(
        completionTrigger,
        'The conversation completion trigger',
        {required:true}
    );

    return `## Conversation closeout\nWhen ${trigger}, call \`${toolName}\` as the sole tool call and do not also answer in prose. Do not call it after a routine answer, while requested work remains open, or merely because a response is long. Use only facts established in the conversation. Never diagnose, score, judge, or infer personal traits. Include a brief nonempty message for the user-facing progress shown while the application accepts and renders the call; do not put the complete closeout there or claim later actions were saved. Put the complete user-facing closeout in final_message. Populate remembered_actions only for a commitment or optional homework the user explicitly agreed to carry into a later conversation; never turn an ordinary suggestion into a saved obligation or claim it was saved. The application separately requests consent before saving a remembered action, displays final_message in the conversation, and reports the save result. The tool does not send anything elsewhere or perform any suggested action.`;
}

export function normalizeConversationClosingReport(value){
    const source=parseArguments(value);
    const unexpectedField=Object.keys(source).find(field=>!REPORT_FIELDS.has(field));

    if(unexpectedField){
        throw invalid(`Unexpected closing-report field: ${unexpectedField}.`);
    }

    return completeValue({
        message:normalizedText(source.message,'message',{required:true}),
        finalMessage:normalizedFinalMessage(source.final_message),
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
        return {present:false,accepted:false,report:null,error:invalid('Tool calls must be an object.')};
    }

    const names=Object.keys(calls);
    const present=Object.hasOwn(calls,toolName);

    if(!present){
        return {present:false,accepted:false,report:null,error:null};
    }
    if(names.length!==1){
        return completeValue({
            present:true,
            accepted:false,
            report:null,
            error:invalid('A conversation closing report must be the sole tool call.')
        });
    }

    try{
        return completeValue({
            present:true,
            accepted:true,
            report:normalizeConversationClosingReport(calls[toolName]),
            error:null
        });
    }catch(error){
        return {present:true,accepted:false,report:null,error};
    }
}

export function formatConversationClosingReport(value){
    const normalizedInput=isPlainRecord(value)&&value.finalMessage!==undefined
        ?{
            message:value.message,
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

import {
    CONVERSATION_ACTION_ITEM_BASES,
    MAX_CONVERSATION_ACTION_ITEM_CHARACTERS,
    MAX_CONVERSATION_REMEMBERED_ACTIONS,
    normalizeRememberedConversationActions
} from './ConversationActionItems.js';

const DEFAULT_TOOL_NAME='prepare_conversation_closing_report';
const TOOL_NAME_PATTERN=/^[a-z][a-z0-9_]{0,63}$/;
const REPORT_KINDS=Object.freeze([
    'after_action_report',
    'summary',
    'homework',
    'closing'
]);
const MAX_ARGUMENT_CHARACTERS=16*1024;
const MAX_SUMMARY_CHARACTERS=2000;
const MAX_CLOSING_CHARACTERS=1000;
const MAX_LIST_ITEMS=6;
const MAX_LIST_ITEM_CHARACTERS=500;
const REPORT_FIELDS=Object.freeze(new Set([
    'kind',
    'outcome_summary',
    'progress',
    'optional_next_steps',
    'remembered_actions',
    'warm_closing'
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

function boundedList(value,label){
    if(value===undefined||value===null){
        return Object.freeze([]);
    }
    if(!Array.isArray(value)||value.length>MAX_LIST_ITEMS){
        throw invalid(`${label} must contain at most ${MAX_LIST_ITEMS} items.`);
    }

    const items=[];
    for(const entry of value){
        const item=boundedText(entry,`${label} item`,MAX_LIST_ITEM_CHARACTERS);
        if(item){
            items.push(item);
        }
    }

    return Object.freeze(items);
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

function escapeMarkdown(value){
    return value
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;')
        .replace(/([\\`*_{}\[\]()#+.!|~-])/g,'\\$1');
}

function markdownList(items){
    return items.map(function formatClosingReportListItem(item){
        return `- ${escapeMarkdown(item)}`;
    }).join('\n');
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
                    kind:{
                        type:'string',
                        enum:[...REPORT_KINDS],
                        description:'Choose closing when advice or homework would be a poor fit.'
                    },
                    outcome_summary:{
                        type:'string',
                        maxLength:MAX_SUMMARY_CHARACTERS,
                        description:'Optional concise account of what the conversation accomplished. Omit it for a simple closing.'
                    },
                    progress:{
                        type:'array',
                        maxItems:MAX_LIST_ITEMS,
                        items:{type:'string',maxLength:MAX_LIST_ITEM_CHARACTERS},
                        description:'Optional concrete progress or takeaways grounded only in the conversation.'
                    },
                    optional_next_steps:{
                        type:'array',
                        maxItems:MAX_LIST_ITEMS,
                        items:{type:'string',maxLength:MAX_LIST_ITEM_CHARACTERS},
                        description:'Optional next steps or homework. Omit this field when actions would be unhelpful, unsafe, or unwanted.'
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
                                    maxLength:MAX_CONVERSATION_ACTION_ITEM_CHARACTERS
                                },
                                basis:{
                                    type:'string',
                                    enum:[...CONVERSATION_ACTION_ITEM_BASES]
                                }
                            },
                            required:['text','basis']
                        },
                        description:'Follow-ups the user explicitly agreed to carry into a later conversation. Keep ordinary suggestions only in optional_next_steps.'
                    },
                    warm_closing:{
                        type:'string',
                        maxLength:MAX_CLOSING_CHARACTERS,
                        description:'A calm closing message that does not pressure the user or create obligations.'
                    }
                },
                required:['kind','warm_closing']
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

    return `## Conversation closeout\nWhen ${trigger}, call \`${toolName}\` as the sole tool call and do not also answer in prose. Do not call it after a routine answer, while requested work remains open, or merely because a response is long. Use only facts established in the conversation. Never diagnose, score, judge, or infer personal traits. A summary, progress note, optional next steps, or homework may be included when useful; omit every optional section that would be inappropriate or unsupported. Next steps are choices, never obligations. Populate remembered_actions only for a commitment or optional homework the user explicitly agreed to carry into a later conversation; never turn an ordinary suggestion into a saved obligation. Choose a simple closing when advice or homework would be a poor fit. The application displays and saves the result in the conversation; the tool does not send it elsewhere or perform any suggested action.`;
}

export function normalizeConversationClosingReport(value){
    const source=parseArguments(value);
    const unexpectedField=Object.keys(source).find(field=>!REPORT_FIELDS.has(field));

    if(unexpectedField){
        throw invalid(`Unexpected closing-report field: ${unexpectedField}.`);
    }

    const kind=boundedText(source.kind,'kind',64,{required:true});

    if(!REPORT_KINDS.includes(kind)){
        throw invalid('The closing-report kind is invalid.');
    }

    return Object.freeze({
        kind,
        outcomeSummary:boundedText(
            source.outcome_summary,
            'outcome_summary',
            MAX_SUMMARY_CHARACTERS
        ),
        progress:boundedList(source.progress,'progress'),
        optionalNextSteps:boundedList(
            source.optional_next_steps,
            'optional_next_steps'
        ),
        rememberedActions:normalizeRememberedConversationActions(
            source.remembered_actions||[]
        ),
        warmClosing:boundedText(
            source.warm_closing,
            'warm_closing',
            MAX_CLOSING_CHARACTERS,
            {required:true}
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

export function formatConversationClosingReport(value, {
    title='Conversation closeout',
    summaryLabel='What we covered',
    progressLabel='Progress',
    nextStepsLabel='Optional next steps',
    rememberedActionsLabel='Remembered follow-ups',
    includeRememberedActions=false
}={}){
    const normalizedInput=isPlainRecord(value)&&value.outcomeSummary!==undefined
        ?{
            kind:value.kind,
            outcome_summary:value.outcomeSummary,
            progress:value.progress,
            optional_next_steps:value.optionalNextSteps,
            remembered_actions:value.rememberedActions,
            warm_closing:value.warmClosing
        }
        :value;
    const report=normalizeConversationClosingReport(normalizedInput);
    const labels={
        title:boundedText(title,'title',160,{required:true}),
        summary:boundedText(summaryLabel,'summaryLabel',160,{required:true}),
        progress:boundedText(progressLabel,'progressLabel',160,{required:true}),
        nextSteps:boundedText(nextStepsLabel,'nextStepsLabel',160,{required:true}),
        rememberedActions:boundedText(
            rememberedActionsLabel,
            'rememberedActionsLabel',
            160,
            {required:true}
        )
    };
    const sections=[`## ${escapeMarkdown(labels.title)}`];

    if(report.outcomeSummary){
        sections.push(`### ${escapeMarkdown(labels.summary)}\n${escapeMarkdown(report.outcomeSummary)}`);
    }
    if(report.progress.length){
        sections.push(`### ${escapeMarkdown(labels.progress)}\n${markdownList(report.progress)}`);
    }
    if(report.optionalNextSteps.length){
        sections.push(`### ${escapeMarkdown(labels.nextSteps)}\n${markdownList(report.optionalNextSteps)}`);
    }
    if(includeRememberedActions===true&&report.rememberedActions.length){
        const remembered=report.rememberedActions.map(action=>
            action.basis==='optional_homework'
                ?`${action.text} (optional)`
                :action.text
        );
        sections.push(`### ${escapeMarkdown(labels.rememberedActions)}\n${markdownList(remembered)}`);
    }

    sections.push(escapeMarkdown(report.warmClosing));
    return sections.join('\n\n');
}

export {
    DEFAULT_TOOL_NAME as CONVERSATION_CLOSING_REPORT_TOOL_NAME,
    REPORT_KINDS as CONVERSATION_CLOSING_REPORT_KINDS
};

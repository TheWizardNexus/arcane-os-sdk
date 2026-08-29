import {readFile} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const REFERENCE_CONTRACT_SCHEMA_VERSION=1;

// This is a reviewed contract, not a prose parser. Order is the order used by
// the checked-in runtime inventory and is therefore part of deterministic
// rendering.
export const RUNTIME_DOCUMENTED_CALLABLE_MEMBERS={
    'AI.js':[
        'setAI','configureProviders','transitionAI','transitionProviders',
        'startProviders','setSpeechMuted','streamRequest','streamMessage','fetchRequest','fetch',
        'streamTTS','finishTTS','fetchSTT','stopAudio','resumeAudio','playAudio'
    ],
    'AIPreferenceRuntime.js':[
        'setAIPreferenceRuntimeOverride','getAIPreferencesForRuntime'
    ],
    'AIPreferenceTuple.js':[
        'normalizeAIPreferenceTuple','aiPreferenceTuplesEqual'
    ],
    'AIProviderRuntime.js':[
        'getAIProviderRuntime','register','unregister','hasProvider',
        'providerIdentity','selection','ownsSelection','validateConfiguration',
        'configure','configureFromTuple','status','catalog','inspect','start',
        'load','unload','dispose','disposeAll','request','chat','stream',
        'transcribe','synthesize','cancel','setSpeechMuted'
    ],
    'AIResponseLength.js':[
        'normalizeAIResponseLength','aiResponseLengthInstruction',
        'applyAIResponseLength'
    ],
    'AIResponseURLPolicy.js':[
        'auditAIResponseLinks','extractAIResponseLinks',
        'normalizeAIResponseLink','decodeHTMLCharacterReferences'
    ],
    'AIRuntimeState.js':[
        'getAIRuntimeState','subscribeAIRuntimeState',
        'publishAIRuntimeRoleState','publishAIRuntimeRolesState',
        'requestAIRuntimeIntent','subscribeAIRuntimeIntents','startAIRuntime'
    ],
    'AnsiText.js':['parseAnsi','stripAnsi'],
    'ApiModelDatabase.js':['setEndpoint','fetch','cached'],
    'AppDataScope.js':[
        'canonicalApplicationId','resolveApplicationId',
        'resolveApplicationLocalStorageKey','openApplicationDataDirectory'
    ],
    'AppearancePreferences.js':[
        'createAppearancePreferenceStore','applyAppearancePreferences',
        'loadAndApplyAppearancePreferences'
    ],
    'ArcaneCommunicationBridge.js':[
        'request','listThreads','getMessages','send','connect','disconnect'
    ],
    'ArcaneNavigationPolicy.js':['createArcaneNavigationGuard'],
    'AsyncBoundary.js':['runAsyncBoundary'],
    'BrowserTestSuite.js':['list','run'],
    'CalculatorEngine.js':['evaluateExpression','calculate'],
    'ChartLibrary.js':['loadChartLibrary'],
    'ChatRecords.js':['hasUserEntry'],
    'CommunicationAppController.js':[
        'start','bind','configure','refresh','select','send'
    ],
    'CommunicationHub.js':['refresh','messages','send'],
    'CommunicationPreferences.js':['load','save'],
    'CommunicationProviderRegistry.js':[
        'register','get','has','list'
    ],
    'ConfiguredAIChatSession.js':['history','clear','prepare','send'],
    'DataMaintenance.js':['clearEmptyChatsAndMemories'],
    'DBOPFSDocumentLibrary.js':[
        'createDBOPFSDocumentLibrary','normalizeDBOPFSDocumentSchema',
        'bootstrap','search','evaluate','buildContext','createContextBuilder'
    ],
    'DevelopmentWorkspace.js':[
        'inspect','context','setup','installNode'
    ],
    'DirectoryPicker.js':[
        'normalizeDirectoryPickerOptions','normalizeDirectorySelection'
    ],
    'DocumentLexicalSearch.js':[
        'createDocumentLexicalIndex','documentContextExcerpt',
        'documentSearchTokens','normalizedDocumentSearchText',
        'scoreDocumentBody','scoreDocumentLexicalIndex','rank','search'
    ],
    'GifEncoder.js':['indexPixels','lzw'],
    'HTMLImport.js':['connectedCallback'],
    'InMemoryCommunicationProvider.js':[
        'listThreads','getMessages','send'
    ],
    'IsolatedModelQuestionRunner.js':[
        'countSentences','inspectModel','runQuestion'
    ],
    'LocalAIReadinessController.js':[
        'createLocalAIReadinessController','availabilityFromReport'
    ],
    'Mail.js':['resolveMailConfig','send'],
    'MailTransport.mjs':['normalizeMailEndpoint','sendMailReport'],
    'MD.js':['append'],
    'MemoryRecords.js':['normalizeMemoryContent','hasMemoryContent'],
    'ModelDefinition.js':[
        'parseModelDefinition','loadModelDefinitionSystemPrompt'
    ],
    'OllamaModelIdentifier.js':[
        'normalizeOllamaModelIdentifier','isOllamaModelIdentifier'
    ],
    'OllamaSettings.js':['arcaneBrainModelName'],
    'OpenMeteoWeatherProvider.js':['mapForecast'],
    'PersistentAIChatSession.js':[
        'createPersistentAIChatSession','create','ready','history',
        'settleMemory','send'
    ],
    'RecordLinkIndex.js':['parseRecordLinks','buildRecordLinkIndex'],
    'RecordReviewStore.js':['load','get','set','snapshot'],
    'RiskSignalAnalyzer.js':['analyzeRiskSignals'],
    'SpeechPlayback.js':['splitSpeechText'],
    'SystemAppearance.js':['available','current','apply'],
    'SystemToolRegistry.js':['quoteArgument'],
    'TerminalCommandRegistry.js':['splitCommandLine'],
    'ThemeBootstrap.js':['bootstrapArcaneTheme'],
    'ThemeManager.js':['loadAndApplyTheme'],
    'ToolCallRouter.js':[
        'parseArguments','handleResponse','handleStreamedCalls'
    ],
    'WaitForComponent.js':['waitForComponent'],
    'YouTubeMedia.js':['parseYouTubeMedia','youtubeEmbedUrl'],
    'QRCode.min.js':['makeCode','makeImage','clear'],
    'SystemPlatformPresentation.js':[
        'kernelType','displayName','apply'
    ]
};

const IDENTIFIER_START=/[A-Za-z_$]/u;
const IDENTIFIER_CONTINUE=/[A-Za-z0-9_$]/u;
const REGEX_PREFIX_KEYWORDS=new Set([
    'await','case','delete','do','else','in','instanceof','new','of','return',
    'throw','typeof','void','yield'
]);
const REGEX_PREFIX_PUNCTUATORS=new Set([
    '(', '[', '{', ',', ';', ':', '?', '?.', '=', '==', '===', '!=', '!==',
    '=>', '+', '-', '*', '**', '%', '&', '|', '^', '!', '~', '&&', '||',
    '??', '<', '>', '<=', '>=', '+=', '-=', '*=', '**=', '%=', '&=', '|=',
    '^=', '&&=', '||=', '??='
]);
const MULTI_PUNCTUATORS=[
    '>>>=','===','!==','>>>','**=','&&=','||=','??=','=>','==','!=','<=','>=',
    '++','--','&&','||','??','?.','**','<<','>>','+=','-=','*=','/=','%=','&=',
    '|=','^=','...'
];

export class UnsupportedReferenceContractSyntaxError extends SyntaxError{
    constructor(code,file,offset,detail){
        super(`${code}:${file}:${String(offset)}`);
        this.name='UnsupportedReferenceContractSyntaxError';
        this.code=code;
        this.file=file;
        this.offset=offset;
        this.detail=detail;
    }
}

function unsupported(code,file,offset,detail={}){
    throw new UnsupportedReferenceContractSyntaxError(code,file,offset,detail);
}

function isIdentifierStart(character){
    return character!==undefined&&IDENTIFIER_START.test(character);
}

function isIdentifierContinue(character){
    return character!==undefined&&IDENTIFIER_CONTINUE.test(character);
}

function scanQuoted(source,start,quote,file){
    let index=start+1;
    while(index<source.length){
        const character=source[index];
        if(character==='\\'){
            index+=2;
            continue;
        }
        if(character===quote)return index+1;
        if(character==='\n'||character==='\r'){
            unsupported('UNTERMINATED_STRING',file,start,{quote});
        }
        index+=1;
    }
    unsupported('UNTERMINATED_STRING',file,start,{quote});
}

function scanLineComment(source,start){
    let index=start+2;
    while(index<source.length&&source[index]!=='\n'&&source[index]!=='\r'){
        index+=1;
    }
    return index;
}

function scanBlockComment(source,start,file){
    const end=source.indexOf('*/',start+2);
    if(end<0)unsupported('UNTERMINATED_BLOCK_COMMENT',file,start);
    return end+2;
}

function regexCanStart(previous){
    if(!previous)return true;
    if(previous.type==='id')return REGEX_PREFIX_KEYWORDS.has(previous.value);
    return previous.type==='punct'&&REGEX_PREFIX_PUNCTUATORS.has(previous.value);
}

function scanRegex(source,start,file){
    let index=start+1;
    let characterClass=false;
    while(index<source.length){
        const character=source[index];
        if(character==='\\'){
            index+=2;
            continue;
        }
        if(character==='[')characterClass=true;
        else if(character===']')characterClass=false;
        else if(character==='/'&&!characterClass){
            index+=1;
            while(/[A-Za-z]/u.test(source[index]??''))index+=1;
            return index;
        }else if(character==='\n'||character==='\r'){
            unsupported('UNTERMINATED_REGEX',file,start);
        }
        index+=1;
    }
    unsupported('UNTERMINATED_REGEX',file,start);
}

function scanTemplateExpression(source,start,file){
    let index=start;
    let braces=1;
    let previous=null;
    while(index<source.length){
        const character=source[index];
        if(character==='\''||character==='"'){
            index=scanQuoted(source,index,character,file);
            previous={type:'literal',value:'literal'};
            continue;
        }
        if(character==='`'){
            index=scanTemplate(source,index,file);
            previous={type:'literal',value:'literal'};
            continue;
        }
        if(character==='/'&&source[index+1]==='/'){
            index=scanLineComment(source,index);
            continue;
        }
        if(character==='/'&&source[index+1]==='*'){
            index=scanBlockComment(source,index,file);
            continue;
        }
        if(character==='/'&&regexCanStart(previous)){
            index=scanRegex(source,index,file);
            previous={type:'literal',value:'literal'};
            continue;
        }
        if(character==='{')braces+=1;
        else if(character==='}'){
            braces-=1;
            if(braces===0)return index+1;
        }
        if(!/\s/u.test(character)){
            if(isIdentifierStart(character)){
                const begin=index;
                index+=1;
                while(isIdentifierContinue(source[index]))index+=1;
                previous={type:'id',value:source.slice(begin,index)};
                continue;
            }
            previous={type:'punct',value:character};
        }
        index+=1;
    }
    unsupported('UNTERMINATED_TEMPLATE_EXPRESSION',file,start);
}

function scanTemplate(source,start,file){
    let index=start+1;
    while(index<source.length){
        const character=source[index];
        if(character==='\\'){
            index+=2;
            continue;
        }
        if(character==='`')return index+1;
        if(character==='$'&&source[index+1]==='{'){
            index=scanTemplateExpression(source,index+2,file);
            continue;
        }
        index+=1;
    }
    unsupported('UNTERMINATED_TEMPLATE',file,start);
}

function tokenize(source,file){
    const tokens=[];
    let index=0;
    let previous=null;
    while(index<source.length){
        const character=source[index];
        if(/\s/u.test(character)){
            index+=1;
            continue;
        }
        if(character==='/'&&source[index+1]==='/'){
            index=scanLineComment(source,index);
            continue;
        }
        if(character==='/'&&source[index+1]==='*'){
            index=scanBlockComment(source,index,file);
            continue;
        }
        const start=index;
        let type;
        let value;
        if(character==='\''||character==='"'){
            index=scanQuoted(source,index,character,file);
            type='string';
            value=source.slice(start+1,index-1);
        }else if(character==='`'){
            index=scanTemplate(source,index,file);
            type='template';
            value=source.slice(start,index);
        }else if(isIdentifierStart(character)){
            index+=1;
            while(isIdentifierContinue(source[index]))index+=1;
            type='id';
            value=source.slice(start,index);
        }else if(character==='#'&&isIdentifierStart(source[index+1])){
            index+=2;
            while(isIdentifierContinue(source[index]))index+=1;
            type='private';
            value=source.slice(start+1,index);
        }else if(/[0-9]/u.test(character)
            ||(character==='.'&&/[0-9]/u.test(source[index+1]??''))){
            index+=1;
            while(/[A-Za-z0-9_.]/u.test(source[index]??''))index+=1;
            type='number';
            value=source.slice(start,index);
        }else if(character==='/'&&source[index+1]!=='='
            &&regexCanStart(previous)){
            index=scanRegex(source,index,file);
            type='regex';
            value=source.slice(start,index);
        }else{
            const punctuator=MULTI_PUNCTUATORS.find(item=>
                source.startsWith(item,index)
            );
            value=punctuator??character;
            index+=value.length;
            type='punct';
        }
        const token={type,value,raw:source.slice(start,index),start,end:index};
        tokens.push(token);
        previous=token;
    }
    return tokens;
}

function delimiterMetadata(tokens,file){
    const matching=new Map();
    const depthBefore=[];
    const stack=[];
    const openers=new Set(['(','[','{']);
    const closerFor={')':'(',']':'[','}':'{'};
    for(const [index,token] of tokens.entries()){
        depthBefore[index]=stack.length;
        if(token.type!=='punct')continue;
        if(openers.has(token.value)){
            stack.push({index,value:token.value});
            continue;
        }
        const opener=closerFor[token.value];
        if(!opener)continue;
        const current=stack.pop();
        if(!current||current.value!==opener){
            unsupported('UNBALANCED_DELIMITER',file,token.start,{
                actual:token.value,
                expected:current?.value??null
            });
        }
        matching.set(current.index,index);
        matching.set(index,current.index);
    }
    if(stack.length){
        const current=stack.at(-1);
        unsupported('UNBALANCED_DELIMITER',file,tokens[current.index].start,{
            actual:current.value,
            expected:null
        });
    }
    return {matching,depthBefore};
}

function range(start,end){
    return {start,end};
}

function rawRange(source,startToken,endToken){
    return source.slice(startToken.start,endToken.end);
}

function nextAtDepth(tokens,depthBefore,start,depth,value=null){
    for(let index=start;index<tokens.length;index+=1){
        if(depthBefore[index]<depth)return -1;
        if(depthBefore[index]===depth&&(value===null||tokens[index].value===value)){
            return index;
        }
    }
    return -1;
}

function statementEnd(tokens,depthBefore,start,depth,file){
    const semicolon=nextAtDepth(tokens,depthBefore,start,depth,';');
    if(semicolon>=0)return semicolon;
    const last=tokens.length-1;
    if(last>=start&&depthBefore[last]===depth)return last;
    unsupported('UNTERMINATED_STATEMENT',file,tokens[start].start);
}

function variableStatementBoundary(tokens,source,depthBefore,start,depth){
    const statementStarters=new Set([
        'export','import','const','let','var','class','function'
    ]);
    for(let index=start;index<tokens.length;index+=1){
        if(depthBefore[index]!==depth)continue;
        if(tokens[index].value===';'){
            return {contentEnd:index,resume:index};
        }
        if(index>start&&statementStarters.has(tokens[index].value)){
            const gap=source.slice(tokens[index-1].end,tokens[index].start);
            if(/[\r\n]/u.test(gap)){
                return {contentEnd:index,resume:index-1};
            }
        }
    }
    return {contentEnd:tokens.length,resume:tokens.length-1};
}

function splitAtDepth(tokens,depthBefore,start,end,depth,separator=','){
    const parts=[];
    let partStart=start;
    for(let index=start;index<end;index+=1){
        if(depthBefore[index]===depth&&tokens[index].value===separator){
            parts.push([partStart,index]);
            partStart=index+1;
        }
    }
    parts.push([partStart,end]);
    return parts.filter(([left,right])=>right>left);
}

function functionDeclaration(tokens,source,index,metadata,file){
    const {matching,depthBefore}=metadata;
    const depth=depthBefore[index];
    let cursor=index;
    let async=false;
    if(tokens[cursor]?.value==='async'){
        async=true;
        cursor+=1;
    }
    if(tokens[cursor]?.value!=='function'){
        unsupported('EXPECTED_FUNCTION',file,tokens[index].start);
    }
    cursor+=1;
    let generator=false;
    if(tokens[cursor]?.value==='*'){
        generator=true;
        cursor+=1;
    }
    const nameToken=tokens[cursor]?.type==='id'?tokens[cursor]:null;
    if(nameToken)cursor+=1;
    const open=nextAtDepth(tokens,depthBefore,cursor,depth,'(');
    if(open<0)unsupported('FUNCTION_PARAMETERS_MISSING',file,tokens[index].start);
    const close=matching.get(open);
    const bodyOpen=nextAtDepth(tokens,depthBefore,close+1,depth,'{');
    if(bodyOpen<0)unsupported('FUNCTION_BODY_MISSING',file,tokens[index].start);
    const bodyClose=matching.get(bodyOpen);
    return {
        kind:'function',
        name:nameToken?.value??null,
        async,
        generator,
        rawDeclaration:source.slice(tokens[index].start,tokens[bodyClose].end),
        rawSignature:source.slice(tokens[index].start,tokens[close].end),
        parameters:source.slice(tokens[open].end,tokens[close].start),
        range:range(tokens[index].start,tokens[bodyClose].end),
        tokenRange:range(index,bodyClose+1)
    };
}

function memberName(tokens,source,index,metadata,file){
    const {matching}=metadata;
    const token=tokens[index];
    if(!token)unsupported('CLASS_MEMBER_NAME_MISSING',file,source.length);
    if(token.type==='private')return {private:true,name:token.value,end:index+1};
    if(token.value==='['){
        const close=matching.get(index);
        if(close===undefined){
            unsupported('UNBALANCED_COMPUTED_MEMBER',file,token.start);
        }
        return {
            private:false,
            computed:true,
            name:source.slice(token.end,tokens[close].start),
            rawName:source.slice(token.start,tokens[close].end),
            end:close+1
        };
    }
    if(!['id','string','number'].includes(token.type)){
        unsupported('UNSUPPORTED_CLASS_MEMBER_NAME',file,token.start,{
            token:token.raw
        });
    }
    return {
        private:false,
        computed:false,
        name:token.value,
        rawName:token.raw,
        end:index+1
    };
}

function classDeclaration(tokens,source,index,metadata,file){
    const {matching,depthBefore}=metadata;
    const depth=depthBefore[index];
    let cursor=index+1;
    const nameToken=tokens[cursor]?.type==='id'?tokens[cursor]:null;
    if(nameToken)cursor+=1;
    const bodyOpen=nextAtDepth(tokens,depthBefore,cursor,depth,'{');
    if(bodyOpen<0)unsupported('CLASS_BODY_MISSING',file,tokens[index].start);
    const bodyClose=matching.get(bodyOpen);
    const extendsIndex=tokens.findIndex((token,tokenIndex)=>
        tokenIndex>=cursor&&tokenIndex<bodyOpen
        &&depthBefore[tokenIndex]===depth&&token.value==='extends'
    );
    const base=extendsIndex>=0
        ?source.slice(tokens[extendsIndex+1].start,tokens[bodyOpen].start).trim()
        :null;
    const constructorRecords=[];
    const members=[];
    const fields=[];
    const memberDepth=depth+1;
    cursor=bodyOpen+1;
    while(cursor<bodyClose){
        if(depthBefore[cursor]!==memberDepth){
            cursor+=1;
            continue;
        }
        if(tokens[cursor].value===';'){
            cursor+=1;
            continue;
        }
        const start=cursor;
        let staticMember=false;
        let accessor=null;
        let async=false;
        let generator=false;
        if(tokens[cursor].value==='static'){
            if(tokens[cursor+1]?.value==='{'
                &&depthBefore[cursor+1]===memberDepth){
                cursor=matching.get(cursor+1)+1;
                continue;
            }
            staticMember=true;
            cursor+=1;
        }
        if(['get','set'].includes(tokens[cursor]?.value)
            &&tokens[cursor+1]?.value!=='('){
            accessor=tokens[cursor].value;
            cursor+=1;
        }else if(tokens[cursor]?.value==='async'
            &&tokens[cursor+1]?.value!=='('){
            async=true;
            cursor+=1;
        }
        if(tokens[cursor]?.value==='*'){
            generator=true;
            cursor+=1;
        }
        const parsedName=memberName(tokens,source,cursor,metadata,file);
        cursor=parsedName.end;
        if(tokens[cursor]?.value==='('&&depthBefore[cursor]===memberDepth){
            const open=cursor;
            const close=matching.get(open);
            const rawSignature=source.slice(tokens[start].start,tokens[close].end);
            const record={
                name:parsedName.name,
                rawName:parsedName.rawName,
                computed:Boolean(parsedName.computed),
                kind:accessor??'method',
                static:staticMember,
                async,
                generator,
                rawSignature,
                parameters:source.slice(tokens[open].end,tokens[close].start),
                range:range(tokens[start].start,tokens[close].end)
            };
            const body=tokens[close+1];
            let end=close+1;
            if(body?.value==='{'&&depthBefore[close+1]===memberDepth){
                end=matching.get(close+1)+1;
            }else if(body?.value===';'&&depthBefore[close+1]===memberDepth){
                end=close+2;
            }else{
                unsupported('CLASS_MEMBER_BODY_MISSING',file,tokens[start].start,{
                    member:parsedName.name
                });
            }
            if(!parsedName.private){
                if(parsedName.name==='constructor'&&!staticMember&&!accessor){
                    constructorRecords.push(record);
                }else members.push(record);
            }
            cursor=end;
            continue;
        }
        // Public fields are retained as syntax facts, but are not promoted to
        // callable methods. A semicolon is required for unambiguous extraction.
        let fieldEnd=-1;
        let nextMember=-1;
        const memberStarters=new Set([
            'static','get','set','async','*','['
        ]);
        for(let candidate=cursor;candidate<bodyClose;candidate+=1){
            if(depthBefore[candidate]!==memberDepth)continue;
            if(tokens[candidate].value===';'){
                fieldEnd=candidate;
                nextMember=candidate+1;
                break;
            }
            if(candidate<=cursor)continue;
            const beginsMember=tokens[candidate].type==='id'
                ||tokens[candidate].type==='private'
                ||memberStarters.has(tokens[candidate].value);
            const gap=source.slice(
                tokens[candidate-1].end,tokens[candidate].start
            );
            const previous=tokens[candidate-1].value;
            if(beginsMember&&/[\r\n]/u.test(gap)
                &&!['=','.', '?.',',',':','?','+','-','*','/','%',
                    '&&','||','??','(', '[','{'].includes(previous)){
                fieldEnd=candidate-1;
                nextMember=candidate;
                break;
            }
        }
        if(fieldEnd<0){
            if(cursor<bodyClose){
                fieldEnd=bodyClose-1;
                nextMember=bodyClose;
            }else{
                unsupported('UNSUPPORTED_CLASS_FIELD_ASI',file,tokens[start].start,{
                    member:parsedName.name
                });
            }
        }
        if(!parsedName.private){
            fields.push({
                name:parsedName.name,
                rawName:parsedName.rawName,
                computed:Boolean(parsedName.computed),
                static:staticMember,
                rawDeclaration:source.slice(
                    tokens[start].start,tokens[fieldEnd].end
                ),
                range:range(tokens[start].start,tokens[fieldEnd].end)
            });
        }
        cursor=nextMember;
    }
    if(constructorRecords.length>1){
        unsupported('MULTIPLE_CLASS_CONSTRUCTORS',file,tokens[index].start,{
            className:nameToken?.value??null
        });
    }
    return {
        kind:'class',
        name:nameToken?.value??null,
        base,
        rawDeclaration:source.slice(tokens[index].start,tokens[bodyClose].end),
        rawSignature:source.slice(tokens[index].start,tokens[bodyOpen].start).trimEnd(),
        constructor:constructorRecords[0]??null,
        members:members,
        fields:fields,
        range:range(tokens[index].start,tokens[bodyClose].end),
        tokenRange:range(index,bodyClose+1)
    };
}

function arrowSignature(tokens,source,start,end,metadata){
    const {matching,depthBefore}=metadata;
    const depth=depthBefore[start];
    let cursor=start;
    if(tokens[cursor]?.value==='async')cursor+=1;
    if(tokens[cursor]?.value==='('){
        const close=matching.get(cursor);
        if(close<end&&tokens[close+1]?.value==='=>'){
            return {
                rawSignature:source.slice(tokens[start].start,tokens[close+1].end),
                parameters:source.slice(tokens[cursor].end,tokens[close].start)
            };
        }
    }
    if(tokens[cursor]?.type==='id'&&tokens[cursor+1]?.value==='=>'){
        return {
            rawSignature:source.slice(tokens[start].start,tokens[cursor+1].end),
            parameters:tokens[cursor].raw
        };
    }
    for(let index=cursor;index<end;index+=1){
        if(depthBefore[index]===depth&&tokens[index].value==='=>'){
            return {
                rawSignature:source.slice(tokens[start].start,tokens[index].end),
                parameters:source.slice(tokens[start].start,tokens[index].start)
            };
        }
    }
    return null;
}

function findOwnedClass(initializerTokens,declarations){
    const values=initializerTokens.map(token=>token.value);
    for(let index=0;index<values.length-1;index+=1){
        if(values[index]==='new'&&initializerTokens[index+1]?.type==='id'
            &&declarations.get(values[index+1])?.kind==='class'){
            return values[index+1];
        }
    }
    return null;
}

function variableDeclarations(tokens,source,index,metadata,file,declarations){
    const {depthBefore}=metadata;
    const depth=depthBefore[index];
    const boundary=variableStatementBoundary(
        tokens,source,depthBefore,index+1,depth
    );
    const end=boundary.contentEnd;
    const records=[];
    for(const [partStart,partEnd] of splitAtDepth(
        tokens,depthBefore,index+1,end,depth
    )){
        const name=tokens[partStart];
        if(name?.type!=='id'){
            records.push({
                kind:'unsupported-variable-binding',
                name:null,
                range:range(tokens[partStart].start,tokens[partEnd-1].end)
            });
            continue;
        }
        const equals=nextAtDepth(
            tokens,depthBefore,partStart+1,depth,'='
        );
        const initStart=equals>=0&&equals<partEnd?equals+1:-1;
        const initializer=initStart>=0?tokens.slice(initStart,partEnd):[];
        let valueKind='value';
        let rawSignature=null;
        let parameters=null;
        let classValue=null;
        if(initializer[0]?.value==='class'){
            classValue=classDeclaration(
                tokens,source,initStart,metadata,file
            );
            valueKind='class';
            rawSignature=classValue.rawSignature;
        }else{
            let functionStart=initStart;
            if(tokens[functionStart]?.value==='async'
                &&tokens[functionStart+1]?.value==='function'){
                // Keep the async modifier.
            }else if(tokens[functionStart]?.value!=='function'){
                functionStart=-1;
            }
            if(functionStart>=0){
                const declaration=functionDeclaration(
                    tokens,source,functionStart,metadata,file
                );
                valueKind='function';
                rawSignature=declaration.rawSignature;
                parameters=declaration.parameters;
            }else if(initStart>=0){
                const arrow=arrowSignature(
                    tokens,source,initStart,partEnd,metadata
                );
                if(arrow){
                    valueKind='function';
                    rawSignature=arrow.rawSignature;
                    parameters=arrow.parameters;
                }
            }
        }
        const record={
            kind:'variable',
            declarationKind:tokens[index].value,
            name:name.value,
            valueKind,
            rawDeclaration:source.slice(
                tokens[partStart].start,tokens[partEnd-1].end
            ),
            rawSignature,
            parameters,
            classValue,
            ownerClass:null,
            initializerRange:initStart<0?null:range(
                tokens[initStart].start,tokens[partEnd-1].end
            ),
            range:range(tokens[partStart].start,tokens[partEnd-1].end),
            tokenRange:range(partStart,partEnd)
        };
        records.push(record);
    }
    // Owner resolution is a second pass because a class can be declared after
    // the variable in valid module source.
    return {records,end:boundary.resume};
}

function importDeclaration(tokens,source,index,metadata,file){
    const {depthBefore,matching}=metadata;
    const depth=depthBefore[index];
    const end=statementEnd(tokens,depthBefore,index+1,depth,file);
    const sourceToken=[...tokens.slice(index+1,end)].reverse()
        .find(token=>token.type==='string');
    if(!sourceToken){
        unsupported('IMPORT_SOURCE_MISSING',file,tokens[index].start);
    }
    const bindings=[];
    let cursor=index+1;
    if(tokens[cursor]?.type==='string')return {bindings,end};
    if(tokens[cursor]?.type==='id'&&tokens[cursor].value!=='from'){
        bindings.push({
            localName:tokens[cursor].value,
            importedName:'default',
            sourceModule:sourceToken.value
        });
        cursor+=1;
        if(tokens[cursor]?.value===',')cursor+=1;
    }
    if(tokens[cursor]?.value==='*'){
        if(tokens[cursor+1]?.value!=='as'||tokens[cursor+2]?.type!=='id'){
            unsupported('UNSUPPORTED_NAMESPACE_IMPORT',file,tokens[cursor].start);
        }
        bindings.push({
            localName:tokens[cursor+2].value,
            importedName:'*',
            sourceModule:sourceToken.value
        });
    }else if(tokens[cursor]?.value==='{'){
        const close=matching.get(cursor);
        const bindingDepth=depth+1;
        for(const [start,endPart] of splitAtDepth(
            tokens,depthBefore,cursor+1,close,bindingDepth
        )){
            const imported=tokens[start];
            if(imported?.type!=='id'){
                unsupported('UNSUPPORTED_NAMED_IMPORT',file,imported?.start??0);
            }
            let local=imported;
            if(tokens[start+1]?.value==='as'){
                local=tokens[start+2];
                if(local?.type!=='id'||start+3!==endPart){
                    unsupported('UNSUPPORTED_NAMED_IMPORT_ALIAS',file,imported.start);
                }
            }else if(start+1!==endPart){
                unsupported('UNSUPPORTED_NAMED_IMPORT',file,imported.start);
            }
            bindings.push({
                localName:local.value,
                importedName:imported.value,
                sourceModule:sourceToken.value
            });
        }
    }
    return {bindings,end};
}

function collectDeclarations(tokens,source,metadata,file){
    const {depthBefore}=metadata;
    const declarations=new Map();
    const imports=new Map();
    for(let index=0;index<tokens.length;index+=1){
        if(depthBefore[index]!==0)continue;
        const token=tokens[index];
        if(token.value==='import'&&tokens[index+1]?.value!=='('){
            const parsed=importDeclaration(
                tokens,source,index,metadata,file
            );
            for(const binding of parsed.bindings){
                if(imports.has(binding.localName)){
                    unsupported('DUPLICATE_IMPORT_BINDING',file,token.start,{
                        localName:binding.localName
                    });
                }
                imports.set(binding.localName,binding);
            }
            index=parsed.end;
            continue;
        }
        if(token.value==='function'
            ||(token.value==='async'&&tokens[index+1]?.value==='function')){
            const parsed=functionDeclaration(
                tokens,source,index,metadata,file
            );
            if(parsed.name)declarations.set(parsed.name,parsed);
            index=parsed.tokenRange.end-1;
            continue;
        }
        if(token.value==='class'){
            const parsed=classDeclaration(tokens,source,index,metadata,file);
            if(parsed.name)declarations.set(parsed.name,parsed);
            index=parsed.tokenRange.end-1;
            continue;
        }
        if(['const','let','var'].includes(token.value)){
            const parsed=variableDeclarations(
                tokens,source,index,metadata,file,declarations
            );
            for(const record of parsed.records){
                if(record.name)declarations.set(record.name,record);
            }
            index=parsed.end;
        }
    }
    return {declarations,imports};
}

function exportRecord({
    name,localName,form,declaration=null,rawDeclaration,sourceModule=null,rangeValue
}){
    return {
        name,
        localName,
        form,
        declarationKind:declaration?.kind??null,
        valueKind:declaration?.valueKind??declaration?.kind??null,
        rawDeclaration,
        rawSignature:declaration?.rawSignature??null,
        parameters:declaration?.parameters??null,
        sourceModule,
        range:rangeValue,
        resolvedDeclaration:declaration??null
    };
}

function exportSpecifierRecords(
    tokens,source,index,open,close,metadata,file,declarations,imports
){
    const {depthBefore}=metadata;
    const depth=depthBefore[index];
    let sourceModule=null;
    if(tokens[close+1]?.value==='from'&&tokens[close+2]?.type==='string'){
        sourceModule=tokens[close+2].value;
    }
    const records=[];
    for(const [start,end] of splitAtDepth(
        tokens,depthBefore,open+1,close,depth+1
    )){
        const local=tokens[start];
        if(!local||!['id','string'].includes(local.type)){
            unsupported('UNSUPPORTED_EXPORT_SPECIFIER',file,local?.start??0);
        }
        let exported=local;
        if(tokens[start+1]?.value==='as'){
            exported=tokens[start+2];
            if(!exported||!['id','string'].includes(exported.type)
                ||start+3!==end){
                unsupported('UNSUPPORTED_EXPORT_ALIAS',file,local.start);
            }
        }else if(start+1!==end){
            unsupported('UNSUPPORTED_EXPORT_SPECIFIER',file,local.start);
        }
        const localName=local.value;
        const exportedName=exported.value;
        const imported=imports.get(localName);
        const declaration=declarations.get(localName)??null;
        let form;
        if(exportedName==='default')form='default';
        else if(sourceModule!==null)form='re-export';
        else if(imported&&localName===exportedName)form='re-export';
        else if(localName!==exportedName)form='alias';
        else if(declaration)form=declaration.kind;
        else if(imported)form='re-export';
        else{
            unsupported('UNRESOLVED_EXPORT_BINDING',file,local.start,{
                localName,
                exportedName
            });
        }
        records.push(exportRecord({
            name:exportedName,
            localName,
            form,
            declaration,
            rawDeclaration:source.slice(local.start,exported.end),
            sourceModule:sourceModule??imported?.sourceModule??null,
            rangeValue:range(local.start,exported.end)
        }));
    }
    return records;
}

function directDeclarationExport(
    tokens,source,index,declarationIndex,metadata,file,declarations
){
    const token=tokens[declarationIndex];
    if(token.value==='function'
        ||(token.value==='async'&&tokens[declarationIndex+1]?.value==='function')){
        const declaration=functionDeclaration(
            tokens,source,declarationIndex,metadata,file
        );
        if(!declaration.name){
            unsupported('ANONYMOUS_NAMED_FUNCTION_EXPORT',file,token.start);
        }
        return {
            records:[exportRecord({
                name:declaration.name,
                localName:declaration.name,
                form:'function',
                declaration,
                rawDeclaration:declaration.rawDeclaration,
                rangeValue:declaration.range
            })],
            end:declaration.tokenRange.end-1
        };
    }
    if(token.value==='class'){
        const declaration=classDeclaration(
            tokens,source,declarationIndex,metadata,file
        );
        if(!declaration.name){
            unsupported('ANONYMOUS_NAMED_CLASS_EXPORT',file,token.start);
        }
        return {
            records:[exportRecord({
                name:declaration.name,
                localName:declaration.name,
                form:'class',
                declaration,
                rawDeclaration:declaration.rawDeclaration,
                rangeValue:declaration.range
            })],
            end:declaration.tokenRange.end-1
        };
    }
    if(['const','let','var'].includes(token.value)){
        const parsed=variableDeclarations(
            tokens,source,declarationIndex,metadata,file,declarations
        );
        const records=parsed.records.map(declaration=>{
            if(!declaration.name){
                unsupported('EXPORTED_DESTRUCTURED_VARIABLE',file,token.start);
            }
            return exportRecord({
                name:declaration.name,
                localName:declaration.name,
                form:'variable',
                declaration,
                rawDeclaration:declaration.rawDeclaration,
                rangeValue:declaration.range
            });
        });
        return {records,end:parsed.end};
    }
    unsupported('UNSUPPORTED_DIRECT_EXPORT',file,token.start,{token:token.raw});
}

function defaultExport(
    tokens,source,index,expressionIndex,metadata,file,declarations
){
    const {depthBefore}=metadata;
    const token=tokens[expressionIndex];
    let declaration=null;
    let localName=null;
    let end;
    if(token.value==='class'){
        declaration=classDeclaration(tokens,source,expressionIndex,metadata,file);
        localName=declaration.name;
        end=declaration.tokenRange.end-1;
    }else if(token.value==='function'
        ||(token.value==='async'&&tokens[expressionIndex+1]?.value==='function')){
        declaration=functionDeclaration(
            tokens,source,expressionIndex,metadata,file
        );
        localName=declaration.name;
        end=declaration.tokenRange.end-1;
    }else{
        if(token.type==='id'&&declarations.has(token.value)){
            end=expressionIndex;
            localName=token.value;
            declaration=declarations.get(localName);
        }else end=statementEnd(tokens,depthBefore,expressionIndex,0,file);
    }
    const endToken=tokens[end].value===';'?tokens[end-1]:tokens[end];
    return {
        record:exportRecord({
            name:'default',
            localName,
            form:'default',
            declaration,
            rawDeclaration:source.slice(token.start,endToken.end),
            rangeValue:range(token.start,endToken.end)
        }),
        end
    };
}

function collectExports(tokens,source,metadata,file,declarations,imports){
    const {depthBefore,matching}=metadata;
    const exports=[];
    for(let index=0;index<tokens.length;index+=1){
        if(depthBefore[index]!==0||tokens[index].value!=='export')continue;
        const next=tokens[index+1];
        if(!next)unsupported('INCOMPLETE_EXPORT',file,tokens[index].start);
        if(next.value==='default'){
            const parsed=defaultExport(
                tokens,source,index,index+2,metadata,file,declarations
            );
            exports.push(parsed.record);
            index=parsed.end;
            continue;
        }
        if(next.value==='{'){
            const close=matching.get(index+1);
            exports.push(...exportSpecifierRecords(
                tokens,source,index,index+1,close,metadata,file,
                declarations,imports
            ));
            index=close;
            continue;
        }
        if(next.value==='*'){
            unsupported('UNSUPPORTED_EXPORT_STAR',file,next.start);
        }
        const parsed=directDeclarationExport(
            tokens,source,index,index+1,metadata,file,declarations
        );
        exports.push(...parsed.records);
        index=parsed.end;
    }
    const exportedClassNames=new Set(exports.filter(record=>
        record.form==='class'&&record.localName
    ).map(record=>record.localName));
    const ownershipClassified=exports.map(record=>{
        if(record.form!=='variable')return record;
        const owned=classForDeclaration(
            record.resolvedDeclaration,tokens,declarations
        );
        return owned?.name&&exportedClassNames.has(owned.name)
            ?{...record,form:'class'}
            :record;
    });
    const names=new Set();
    for(const record of ownershipClassified){
        if(names.has(record.name)){
            unsupported('DUPLICATE_EXPORT_NAME',file,record.range.start,{
                exportName:record.name
            });
        }
        names.add(record.name);
    }
    return ownershipClassified;
}

function callableExpression(tokens,source,start,end,metadata,file){
    let cursor=start;
    while(cursor<end){
        if(tokens[cursor]?.value==='async'
            &&tokens[cursor+1]?.value==='function'){
            return functionDeclaration(tokens,source,cursor,metadata,file);
        }
        if(tokens[cursor]?.value==='function'){
            return functionDeclaration(tokens,source,cursor,metadata,file);
        }
        const arrow=arrowSignature(tokens,source,cursor,end,metadata);
        if(arrow){
            return {kind:'function',...arrow};
        }
        // Chained assignments retain every left-hand owner. Continue through
        // only the exact `identifier.member =` grammar.
        if(tokens[cursor]?.type==='id'&&tokens[cursor+1]?.value==='.'
            &&tokens[cursor+2]?.type==='id'
            &&tokens[cursor+3]?.value==='='){
            cursor+=4;
            continue;
        }
        break;
    }
    return null;
}

function collectAssignedMembers(tokens,source,metadata,file){
    const {depthBefore}=metadata;
    const members=[];
    for(let index=0;index<tokens.length-4;index+=1){
        const owner=tokens[index];
        if(owner.type!=='id'||tokens[index+1]?.value!=='.')continue;
        let cursor=index+2;
        let prototype=false;
        if(tokens[cursor]?.value==='prototype'
            &&tokens[cursor+1]?.value==='.'){
            prototype=true;
            cursor+=2;
        }
        const nameToken=tokens[cursor];
        if(nameToken?.type!=='id'||tokens[cursor+1]?.value!=='=')continue;
        const expressionStart=cursor+2;
        let expressionEnd=expressionStart;
        const assignmentDepth=depthBefore[index];
        while(expressionEnd<tokens.length
            &&depthBefore[expressionEnd]>=assignmentDepth
            &&!(depthBefore[expressionEnd]===assignmentDepth
                &&[';',','].includes(tokens[expressionEnd].value))){
            expressionEnd+=1;
        }
        const callable=callableExpression(
            tokens,source,expressionStart,expressionEnd,metadata,file
        );
        if(!callable)continue;
        members.push({
            owner:owner.value,
            name:nameToken.value,
            rawName:nameToken.raw,
            computed:false,
            kind:'assigned-method',
            static:!prototype,
            async:Boolean(callable.async),
            generator:Boolean(callable.generator),
            rawSignature:callable.rawSignature,
            parameters:callable.parameters,
            range:range(owner.start,callable.range?.end
                ??(tokens[expressionEnd-1]?.end??nameToken.end))
        });
    }
    return members;
}

function classForDeclaration(declaration,tokens,declarations){
    if(!declaration)return null;
    if(declaration.kind==='class')return declaration;
    if(declaration.kind!=='variable')return null;
    if(declaration.classValue)return declaration.classValue;
    const initializer=tokens.slice(
        declaration.tokenRange.start,declaration.tokenRange.end
    );
    const owner=findOwnedClass(initializer,declarations);
    return owner?declarations.get(owner):null;
}

function cleanClassContract(classContract){
    if(!classContract)return null;
    return {
        name:classContract.name,
        base:classContract.base,
        rawDeclaration:classContract.rawSignature,
        rawSignature:classContract.rawSignature,
        constructor:classContract.constructor,
        members:classContract.members,
        fields:classContract.fields,
        range:classContract.range
    };
}

function cleanExport(record,tokens,declarations){
    const classContract=classForDeclaration(
        record.resolvedDeclaration,tokens,declarations
    );
    return {
        name:record.name,
        localName:record.localName,
        form:record.form,
        declarationKind:record.declarationKind,
        valueKind:record.valueKind,
        rawDeclaration:record.rawDeclaration,
        rawSignature:record.rawSignature,
        parameters:record.parameters,
        sourceModule:record.sourceModule,
        ownerClass:classContract?.name??null,
        classContract:cleanClassContract(classContract),
        range:record.range
    };
}

function collectPublicMembers(exports,assignedMembers,tokens,declarations){
    const records=new Map();
    for(const exported of exports){
        const classContract=classForDeclaration(
            exported.resolvedDeclaration,tokens,declarations
        );
        if(classContract){
            for(const member of classContract.members){
                const key=`class:${classContract.range.start}:${member.range.start}`;
                const existing=records.get(key);
                if(existing){
                    existing.exportNames.push(exported.name);
                    continue;
                }
                records.set(key,{
                    ...member,
                    owner:classContract.name??exported.localName??exported.name,
                    ownerKind:'class',
                    exportNames:[exported.name]
                });
            }
        }
        const localName=exported.localName;
        const declaration=exported.resolvedDeclaration;
        const functionLike=declaration?.kind==='function'
            ||(declaration?.kind==='variable'
                &&declaration.valueKind==='function');
        if(!localName||!functionLike)continue;
        for(const member of assignedMembers.filter(item=>item.owner===localName)){
            const key=`assigned:${member.owner}:${member.range.start}`;
            const existing=records.get(key);
            if(existing){
                existing.exportNames.push(exported.name);
                continue;
            }
            records.set(key,{
                ...member,
                ownerKind:'function-class',
                exportNames:[exported.name]
            });
        }
    }
    return [...records.values()].map(record=>({
        ...record,
        exportNames:[...new Set(record.exportNames)]
    })).sort((left,right)=>left.range.start-right.range.start);
}

function simpleLiteral(token){
    if(token?.type!=='string'||token.raw.length<2)return null;
    const value=token.raw.slice(1,-1);
    return value.includes('\\')?null:value;
}

function collectLiteralCustomEvents(tokens){
    const records=[];
    for(let index=0;index<tokens.length-3;index+=1){
        if(tokens[index].value!=='new'
            ||tokens[index+1]?.value!=='CustomEvent'
            ||tokens[index+2]?.value!=='(')continue;
        const name=simpleLiteral(tokens[index+3]);
        if(name===null)continue;
        records.push({
            name,
            range:range(tokens[index+3].start,tokens[index+3].end)
        });
    }
    return records;
}

function collectDirectCodedFailures(tokens,metadata){
    const {depthBefore}=metadata;
    const records=[];
    for(let index=0;index<tokens.length-4;index+=1){
        if(tokens[index].type!=='id'||tokens[index].value!=='error'
            ||tokens[index+1]?.value!=='.'
            ||tokens[index+2]?.value!=='code'
            ||tokens[index+3]?.value!=='=')continue;
        const depth=depthBefore[index];
        let cursor=index+4;
        while(cursor<tokens.length&&depthBefore[cursor]>=depth){
            if(depthBefore[cursor]===depth
                &&[';',',','}'].includes(tokens[cursor].value))break;
            const code=simpleLiteral(tokens[cursor]);
            if(code!==null&&/^[A-Z][A-Z0-9_]*$/u.test(code)){
                records.push({
                    code,
                    range:range(tokens[cursor].start,tokens[cursor].end)
                });
            }
            cursor+=1;
        }
    }
    return records;
}

function collectErrorSubclasses(exports,tokens,declarations){
    const records=new Map();
    for(const exported of exports){
        const contract=classForDeclaration(
            exported.resolvedDeclaration,tokens,declarations
        );
        if(!contract
            ||!/(?:^|\.)(?:Error|[A-Za-z_$][\w$]*Error)$/u.test(
                contract.base??''
            )){
            continue;
        }
        const key=String(contract.range.start);
        const existing=records.get(key);
        if(existing){
            existing.exportNames.push(exported.name);
            continue;
        }
        records.set(key,{
            name:contract.name,
            base:contract.base,
            rawDeclaration:contract.rawSignature,
            constructor:contract.constructor,
            exportNames:[exported.name],
            range:contract.range
        });
    }
    return [...records.values()].map(record=>({
        ...record,
        exportNames:record.exportNames
    }));
}

function exportedCallableCandidates(exports,publicMembers){
    const candidates=[];
    for(const exported of exports){
        const declaration=exported.resolvedDeclaration;
        if(declaration?.kind==='function'
            ||(declaration?.kind==='variable'
                &&declaration.valueKind==='function')){
            candidates.push({
                targetKind:'exported-function',
                name:exported.localName??exported.name,
                exportName:exported.name,
                owner:null,
                rawSignature:declaration.rawSignature,
                parameters:declaration.parameters,
                range:declaration.range
            });
        }
    }
    for(const member of publicMembers){
        candidates.push({
            targetKind:'public-member',
            name:member.name,
            exportName:member.exportNames[0]??null,
            owner:member.owner,
            rawSignature:member.rawSignature,
            parameters:member.parameters,
            range:member.range
        });
    }
    return candidates;
}

function resolveReviewedCallables(
    file,documentedCallables,exports,publicMembers
){
    const candidates=exportedCallableCandidates(exports,publicMembers);
    return documentedCallables.map((name,order)=>{
        const matching=candidates.filter(candidate=>
            candidate.name===name||candidate.exportName===name
        );
        const unique=new Map(matching.map(candidate=>[
            `${candidate.targetKind}:${candidate.owner??''}:${candidate.range.start}`,
            candidate
        ]));
        if(unique.size!==1){
            unsupported(
                unique.size===0
                    ?'DOCUMENTED_CALLABLE_UNRESOLVED'
                    :'DOCUMENTED_CALLABLE_AMBIGUOUS',
                file,
                0,
                {name,candidateCount:unique.size}
            );
        }
        const target=[...unique.values()][0];
        return {order,name,...target};
    });
}

function validateWithVM(source,file,kind){
    if(kind!=='esm')return;
    if(typeof vm.SourceTextModule!=='function')return;
    try{
        new vm.SourceTextModule(source,{identifier:file});
    }catch(error){
        unsupported('VM_MODULE_PARSE_FAILED',file,0,{
            errorName:error.name,
            errorMessage:error.message
        });
    }
}

export function extractModuleContract(source,{
    file='<module>',
    kind='esm',
    documentedCallables=RUNTIME_DOCUMENTED_CALLABLE_MEMBERS[path.basename(file)]??[]
}={}){
    if(typeof source!=='string')throw new TypeError('source must be a string');
    if(['license','stylesheet'].includes(kind)){
        return {
            schemaVersion:REFERENCE_CONTRACT_SCHEMA_VERSION,
            file,
            name:path.basename(file),
            kind,
            exports:[],
            publicMembers:[],
            events:[],
            directCodedFailures:[],
            errorSubclasses:[],
            reviewedCallables:[],
            unsupported:[]
        };
    }
    validateWithVM(source,file,kind);
    const tokens=tokenize(source,file);
    const metadata=delimiterMetadata(tokens,file);
    const {declarations,imports}=collectDeclarations(
        tokens,source,metadata,file
    );
    if(kind!=='esm'){
        return extractClassicContract(source,{
            file,kind,documentedCallables,tokens,metadata
        });
    }
    const internalExports=collectExports(
        tokens,source,metadata,file,declarations,imports
    );
    const assignedMembers=collectAssignedMembers(
        tokens,source,metadata,file
    );
    const publicMembers=collectPublicMembers(
        internalExports,assignedMembers,tokens,declarations
    );
    const exports=internalExports.map(record=>
        cleanExport(record,tokens,declarations)
    );
    const reviewedCallables=resolveReviewedCallables(
        file,documentedCallables,internalExports,publicMembers
    );
    return {
        schemaVersion:REFERENCE_CONTRACT_SCHEMA_VERSION,
        file,
        name:path.basename(file),
        kind,
        exports,
        publicMembers,
        events:collectLiteralCustomEvents(tokens),
        directCodedFailures:collectDirectCodedFailures(tokens,metadata),
        errorSubclasses:collectErrorSubclasses(
            internalExports,tokens,declarations
        ),
        reviewedCallables,
        unsupported:[]
    };
}

const CLASSIC_GLOBAL_OWNERS={
    'QRCode.min.js':'QRCode',
    'SystemPlatformPresentation.js':'ArcaneSystemPlatformPresentation'
};

function allNamedFunctions(tokens,source,metadata,file){
    const records=[];
    for(let index=0;index<tokens.length;index+=1){
        if(tokens[index].type!=='id'||tokens[index].value!=='function')continue;
        const start=tokens[index-1]?.value==='async'?index-1:index;
        const parsed=functionDeclaration(tokens,source,start,metadata,file);
        if(parsed.name)records.push(parsed);
    }
    return records;
}

function extractClassicContract(source,{
    file,kind,documentedCallables,tokens,metadata
}){
    const name=path.basename(file);
    const functions=documentedCallables.length
        ?allNamedFunctions(tokens,source,metadata,file)
        :[];
    const assignments=documentedCallables.length
        ?collectAssignedMembers(tokens,source,metadata,file)
        :[];
    const reviewedCallables=[];
    const publicMembers=[];
    for(const [order,callableName] of documentedCallables.entries()){
        let candidates=[];
        if(name==='QRCode.min.js'){
            candidates=assignments.filter(member=>
                member.owner==='QRCode'&&!member.static
                &&member.name===callableName
            );
        }else if(name==='SystemPlatformPresentation.js'){
            candidates=functions.filter(record=>record.name===callableName)
                .map(record=>({
                    owner:CLASSIC_GLOBAL_OWNERS[name],
                    name:record.name,
                    rawName:record.name,
                    computed:false,
                    kind:'global-method',
                    static:true,
                    async:record.async,
                    generator:record.generator,
                    rawSignature:record.rawSignature,
                    parameters:record.parameters,
                    range:record.range
                }));
        }
        const unique=new Map(candidates.map(candidate=>[
            `${candidate.owner}:${candidate.range.start}`,candidate
        ]));
        if(unique.size!==1){
            unsupported(
                unique.size===0
                    ?'DOCUMENTED_CALLABLE_UNRESOLVED'
                    :'DOCUMENTED_CALLABLE_AMBIGUOUS',
                file,0,{name:callableName,candidateCount:unique.size}
            );
        }
        const member=[...unique.values()][0];
        const publicMember={
            ...member,
            ownerKind:'classic-global',
            exportNames:[]
        };
        publicMembers.push(publicMember);
        reviewedCallables.push({
            order,
            name:callableName,
            targetKind:'global-member',
            exportName:null,
            owner:publicMember.owner,
            rawSignature:publicMember.rawSignature,
            parameters:publicMember.parameters,
            range:publicMember.range
        });
    }
    return {
        schemaVersion:REFERENCE_CONTRACT_SCHEMA_VERSION,
        file,
        name,
        kind,
        exports:[],
        publicMembers:publicMembers,
        events:collectLiteralCustomEvents(tokens),
        directCodedFailures:collectDirectCodedFailures(tokens,metadata),
        errorSubclasses:[],
        reviewedCallables:reviewedCallables,
        unsupported:[]
    };
}

function portablePath(repositoryRoot,filePath){
    return path.relative(repositoryRoot,filePath).split(path.sep).join('/');
}

function sortedNames(values){
    return [...values].sort((left,right)=>left.localeCompare(right));
}

function equalNames(left,right){
    return left.length===right.length
        &&left.every((value,index)=>value===right[index]);
}

async function runtimeNamespaces(repositoryRoot,files){
    if(typeof vm.SourceTextModule!=='function'
        ||typeof vm.SyntheticModule!=='function'){
        throw new Error(
            'Use Node --experimental-vm-modules for runtime contract verification.'
        );
    }
    const runtimeRoot=path.join(repositoryRoot,'runtime');
    const strongTypePath=path.join(runtimeRoot,'strong-type','index.js');
    const missingStrongTypePath=path.join(
        runtimeRoot,'node_modules','strong-type','index.js'
    );
    const context=vm.createContext({});
    const modules=new Map();
    const builtins=new Map();
    const builtinModule=async specifier=>{
        if(builtins.has(specifier))return builtins.get(specifier);
        const namespace=await import(specifier);
        const names=Object.keys(namespace);
        const module=new vm.SyntheticModule(names,function initialize(){
            for(const name of names)this.setExport(name,namespace[name]);
        },{context,identifier:specifier});
        builtins.set(specifier,module);
        return module;
    };
    const moduleRecord=async filePath=>{
        const normalized=path.normalize(filePath);
        if(modules.has(normalized))return modules.get(normalized);
        const source=await readFile(normalized,'utf8');
        const identifier=pathToFileURL(normalized).href;
        const module=new vm.SourceTextModule(source,{context,identifier});
        const record={filePath:normalized,module};
        modules.set(normalized,record);
        return record;
    };
    const linker=async(specifier,referencingModule)=>{
        if(specifier.startsWith('node:'))return builtinModule(specifier);
        if(!specifier.startsWith('.')&&!specifier.startsWith('/')){
            throw new Error(`Unsupported runtime import ${specifier}.`);
        }
        const url=new URL(specifier,referencingModule.identifier);
        url.search='';
        url.hash='';
        let resolved=path.normalize(fileURLToPath(url));
        if(resolved===path.normalize(missingStrongTypePath)){
            resolved=strongTypePath;
        }
        return (await moduleRecord(resolved)).module;
    };
    const namespaces=new Map();
    for(const relativeFile of files){
        const record=await moduleRecord(path.join(repositoryRoot,relativeFile));
        if(record.module.status==='unlinked')await record.module.link(linker);
        namespaces.set(relativeFile,sortedNames(
            Reflect.ownKeys(record.module.namespace).filter(
                name=>typeof name==='string'
            )
        ));
    }
    return namespaces;
}

export async function extractRuntimeReferenceContracts({
    repositoryRoot=path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),'..'
    )
}={}){
    const inventoryPath=path.join(
        repositoryRoot,'docs','reference','inventory','runtime-modules.json'
    );
    const inventory=JSON.parse(await readFile(inventoryPath,'utf8'));
    const selected=inventory.artifacts;
    const modules=[];
    for(const record of selected){
        const source=await readFile(path.join(repositoryRoot,record.file),'utf8');
        const contract=extractModuleContract(source,{
            file:record.file,
            kind:record.kind,
            documentedCallables:RUNTIME_DOCUMENTED_CALLABLE_MEMBERS[record.name]??[]
        });
        if(record.kind==='esm'){
            const actual=sortedNames(contract.exports.map(item=>item.name));
            const expected=sortedNames(record.exports);
            if(!equalNames(actual,expected)){
                throw new Error(
                    `Static export inventory mismatch for ${record.file}: `
                    +`${JSON.stringify(actual)} !== ${JSON.stringify(expected)}.`
                );
            }
        }
        modules.push(contract);
    }
    return {
        schemaVersion:REFERENCE_CONTRACT_SCHEMA_VERSION,
        modules
    };
}

export async function verifyRuntimeReferenceContracts(options={}){
    const repositoryRoot=options.repositoryRoot??path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),'..'
    );
    const requireVm=options.requireVm??true;
    const first=await extractRuntimeReferenceContracts({repositoryRoot});
    const inventory=JSON.parse(await readFile(path.join(
        repositoryRoot,'docs','reference','inventory','runtime-modules.json'
    ),'utf8'));
    const esmRecords=inventory.artifacts.filter(record=>record.kind==='esm');
    const vmAvailable=typeof vm.SourceTextModule==='function'
        &&typeof vm.SyntheticModule==='function';
    if(requireVm&&!vmAvailable){
        throw new Error(
            'Use Node --experimental-vm-modules for runtime contract verification.'
        );
    }
    if(vmAvailable){
        const namespaces=await runtimeNamespaces(
            repositoryRoot,esmRecords.map(record=>record.file)
        );
        for(const record of esmRecords){
            const contract=first.modules.find(module=>module.file===record.file);
            const staticallyExtracted=sortedNames(
                contract.exports.map(item=>item.name)
            );
            const namespaceExports=namespaces.get(record.file);
            const inventoryExports=sortedNames(record.exports);
            if(!equalNames(staticallyExtracted,namespaceExports)
                ||!equalNames(namespaceExports,inventoryExports)){
                throw new Error(
                    `Bidirectional export reconciliation failed for ${record.file}.`
                );
            }
        }
    }
    return first;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
    const argumentsSet=new Set(process.argv.slice(2));
    const contract=argumentsSet.has('--verify-runtime')
        ?await verifyRuntimeReferenceContracts()
        :await extractRuntimeReferenceContracts();
    process.stdout.write(`${JSON.stringify(contract)}\n`);
}

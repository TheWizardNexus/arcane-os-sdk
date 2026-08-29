import {lstat,mkdir,readFile as readFileFromDisk,readdir,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const IMPORT_MAP_RELATIVE_PATH='modules/arcane.importmap.json';
export const MANAGED_IMPORT_MAP_ATTRIBUTE='data-arcane-import-map';

const JAVASCRIPT_EXTENSION=/\.(?:js|mjs)$/u;
const NODE_ONLY_MODULE='modules/CaseEvidenceIndexer.js';
const PERSISTENT_CHAT_IMPORT='#arcane/persistent-ai-chat-session';
const PERSISTENT_CHAT_MODULE='modules/PersistentAIChatSession.js';
const SDK_BROWSER_ENTRY='sdk/event-manager.mjs';
const SDK_BROWSER_AI_ENTRY='sdk/ai/browser-wasm.mjs';
const SDK_BROWSER_SPEECH_ENTRY='sdk/ai/browser-speech.mjs';
const STATIC_RUNTIME_PACKAGE_IMPORTS=new Map([
    ['arcane-os/preference-store','modules/PreferenceStore.js'],
    ['arcane-os/speech-playback','modules/SpeechPlayback.js']
]);
const SDK_BROWSER_SELF_IMPORTS=new Map([
    ['arcane-os/event-manager',SDK_BROWSER_ENTRY],
    ['arcane-os/ai/browser-wasm',SDK_BROWSER_AI_ENTRY],
    ['arcane-os/ai/browser-speech',SDK_BROWSER_SPEECH_ENTRY]
]);
function fail(message,code='ARCANE_IMPORT_MAP_INVALID'){
    const error=new Error(message);
    error.code=code;
    throw error;
}

function throwIfAborted(signal){
    if(!signal?.aborted)return;
    const error=signal.reason instanceof Error?signal.reason:new Error('Operation cancelled.');
    error.code=error.code||'ARCANE_CANCELLED';
    throw error;
}

async function emit(onEvent,event){
    if(typeof onEvent!=='function')return null;
    try{
        await onEvent(event);
        return null;
    }catch(error){
        return error;
    }
}

function compareText(left,right){
    const leftText=String(left);
    const rightText=String(right);
    if(leftText<rightText)return -1;
    if(leftText>rightText)return 1;
    return 0;
}

function safeRelativePath(value,label='path'){
    if(typeof value!=='string'||!value||value.includes('\\')||value.includes('\0')
        ||path.posix.isAbsolute(value)||path.posix.normalize(value)!==value
        ||value==='.'||value.startsWith('../')||value.includes('/../')){
        fail(`Import-map ${label} is unsafe: ${String(value)}.`);
    }
    return value;
}

function normalizedDocumentPaths(entry,documents){
    if(documents===undefined)return [entry];
    if(!Array.isArray(documents)||documents.length===0){
        fail('Import-map documents must be a non-empty array of application-relative paths.');
    }
    const normalized=[];
    for(const [index,value] of documents.entries()){
        const relative=safeRelativePath(value,`documents[${String(index)}]`);
        if(!normalized.includes(relative))normalized.push(relative);
    }
    if(!normalized.includes(entry)){
        fail(`Import-map documents must include the configured application entry: ${entry}.`);
    }
    return [
        entry,
        ...normalized.filter(relative=>relative!==entry).sort(compareText)
    ];
}

function decodedEscape(source,index){
    const character=source[index];
    if(/[1-9]/u.test(character)||(character==='0'&&/[0-9]/u.test(source[index+1]??''))){
        fail('Import-map scan found a legacy octal or decimal string escape.');
    }
    const simple={b:'\b',f:'\f',n:'\n',r:'\r',t:'\t',v:'\v','0':'\0'};
    if(Object.hasOwn(simple,character))return {value:simple[character],next:index+1};
    if(character==='\n')return {value:'',next:index+1};
    if(character==='\r')return {value:'',next:source[index+1]==='\n'?index+2:index+1};
    if(character==='\u2028'||character==='\u2029')return {value:'',next:index+1};
    if(character==='x'){
        const digits=source.slice(index+1,index+3);
        if(!/^[a-f0-9]{2}$/iu.test(digits))fail('Import-map scan found an invalid hexadecimal string escape.');
        return {value:String.fromCodePoint(Number.parseInt(digits,16)),next:index+3};
    }
    if(character==='u'){
        if(source[index+1]==='{'){
            const close=source.indexOf('}',index+2);
            const digits=close<0?'':source.slice(index+2,close);
            if(!/^[a-f0-9]{1,6}$/iu.test(digits))fail('Import-map scan found an invalid Unicode string escape.');
            const point=Number.parseInt(digits,16);
            if(point>0x10ffff)fail('Import-map scan found an out-of-range Unicode string escape.');
            return {value:String.fromCodePoint(point),next:close+1};
        }
        const digits=source.slice(index+1,index+5);
        if(!/^[a-f0-9]{4}$/iu.test(digits))fail('Import-map scan found an invalid Unicode string escape.');
        return {value:String.fromCodePoint(Number.parseInt(digits,16)),next:index+5};
    }
    return {value:character,next:index+1};
}

function stringToken(source,start){
    const quote=source[start];
    let value='';
    let index=start+1;
    while(index<source.length){
        const character=source[index];
        if(character===quote){
            return {token:{type:'string',value,start,end:index+1},next:index+1};
        }
        if(LINE_TERMINATOR.test(character)){
            fail(`Import-map scan found an unterminated string literal at offset ${String(start)}.`);
        }
        if(character==='\\'){
            if(index+1>=source.length){
                fail(`Import-map scan found an unterminated string escape at offset ${String(start)}.`);
            }
            const decoded=decodedEscape(source,index+1);
            value+=decoded.value;
            index=decoded.next;
            continue;
        }
        value+=character;
        index+=1;
    }
    fail(`Import-map scan found an unterminated string literal at offset ${String(start)}.`);
}

function templateChunk(source,start,{opening=false}={}){
    let index=opening?start+1:start;
    while(index<source.length){
        if(source[index]==='`')return {complete:true,next:index+1};
        if(source[index]==='\\'){
            index+=2;
            continue;
        }
        if(source[index]==='$'&&source[index+1]==='{'){
            return {complete:false,next:index+2};
        }
        index+=1;
    }
    fail(`Import-map scan found an unterminated template literal at offset ${String(start)}.`);
}

const IDENTIFIER_START=/^(?:[$_]|\p{ID_Start})$/u;
const IDENTIFIER_CONTINUE=/^(?:[$_\u200c\u200d]|\p{ID_Continue})$/u;
const LINE_TERMINATOR=/[\n\r\u2028\u2029]/u;
const REGEX_PREFIX_KEYWORDS=new Set([
    'case','default','delete','do','else','extends','in','instanceof','new','return',
    'throw','typeof','void'
]);

function sourceCharacter(source,index){
    const point=source.codePointAt(index);
    if(point==null)return '';
    return String.fromCodePoint(point);
}

function identifierIsProperty(tokens,index){
    const previous=tokens[index-1];
    if(previous?.value==='.'||previous?.value==='?.')return true;
    return previous?.value==='#'
        &&(tokens[index-2]?.value==='.'||tokens[index-2]?.value==='?.');
}

function regexMayStart(previous,{
    beforePrevious,
    beforeBeforePrevious,
    lineTerminatorBefore=false
}={}){
    if(!previous)return true;
    if(previous.slashGoalAfter==='regex'||previous.closesControl===true)return true;
    if(previous.slashGoalAfter==='division')return false;
    if(previous.slashGoalAfter==='ambiguous'){
        fail(
            `Import-map scan cannot determine whether the slash after offset ${String(previous.start)} `
            +'begins a regular expression or continues an expression. Rewrite that boundary '
            +'with an explicit statement or expression delimiter.'
        );
    }
    if(previous.restrictedStatementLabel===true){
        if(lineTerminatorBefore)return true;
        fail(
            `Import-map scan found a ${previous.restrictedStatementKind} label followed by a slash `
            +`on the same line at offset ${String(previous.start)}.`
        );
    }
    if(previous.type==='identifier'){
        if(beforePrevious?.value==='.'||beforePrevious?.value==='?.'
            ||(beforePrevious?.value==='#'
                &&(beforeBeforePrevious?.value==='.'
                    ||beforeBeforePrevious?.value==='?.'))){
            return false;
        }
        if(previous.contextualRegexPrefix===true)return true;
        if(previous.value==='break'||previous.value==='continue'){
            if(lineTerminatorBefore)return true;
            fail(
                `Import-map scan found ${previous.value} followed by a slash on the same line at `
                +`offset ${String(previous.start)}. A label or statement boundary is required before `
                +'a regular expression at this position.'
            );
        }
        return REGEX_PREFIX_KEYWORDS.has(previous.value);
    }
    if(new Set(['regex','string','number','template']).has(previous.type))return false;
    return !new Set([')',']','}','++','--']).has(previous.value);
}

function declarationPosition(tokens,index){
    const previous=tokens[index-1];
    if(!previous)return true;
    if(previous.closesControl===true||previous.slashGoalAfter==='regex')return true;
    if(new Set([';','{','}']).has(previous.value))return true;
    return previous.type==='identifier'
        &&new Set(['default','else','export']).has(previous.value);
}

function classHeader(tokens){
    const depths={parenthesis:0,bracket:0,brace:0};
    let topLevelAssignment=false;
    for(let index=tokens.length-1;index>=0;index-=1){
        const token=tokens[index];
        if(token.value===')')depths.parenthesis+=1;
        else if(token.value==='('){
            if(depths.parenthesis===0)return null;
            depths.parenthesis-=1;
        }else if(token.value===']')depths.bracket+=1;
        else if(token.value==='['){
            if(depths.bracket===0)return null;
            depths.bracket-=1;
        }else if(token.value==='}')depths.brace+=1;
        else if(token.value==='{'){
            if(depths.brace===0)break;
            depths.brace-=1;
        }
        if(depths.parenthesis!==0||depths.bracket!==0||depths.brace!==0)continue;
        if(token.value===';')break;
        if(token.value===':'||token.value==='=')topLevelAssignment=true;
        if(token.type==='identifier'&&token.value==='class'
            &&!identifierIsProperty(tokens,index)){
            if(topLevelAssignment)return null;
            return {
                declaration:declarationPosition(tokens,index),
                kind:'class'
            };
        }
    }
    return null;
}

function functionHeader(tokens,closingParenthesis,enclosingBraceKind){
    const openIndex=closingParenthesis?.openTokenIndex;
    if(!Number.isInteger(openIndex))return null;
    for(let index=openIndex-1;index>=0;index-=1){
        const token=tokens[index];
        if(new Set([';', '{', '}']).has(token.value))break;
        if(token.type==='identifier'&&token.value==='function'
            &&!identifierIsProperty(tokens,index)){
            const asyncToken=tokens[index-1];
            const async=asyncToken?.type==='identifier'&&asyncToken.value==='async'
                &&!identifierIsProperty(tokens,index-1);
            return {
                async,
                declaration:declarationPosition(tokens,async?index-1:index),
                generator:tokens.slice(index+1,openIndex).some(candidate=>candidate.value==='*')
            };
        }
    }
    if(enclosingBraceKind!=='class'&&enclosingBraceKind!=='object')return null;
    const name=tokens[openIndex-1];
    if(!name||!new Set(['identifier','string','number']).has(name.type))return null;
    const beforeName=tokens[openIndex-2];
    const async=beforeName?.type==='identifier'&&beforeName.value==='async';
    const generator=beforeName?.value==='*'
        ||(async&&tokens[openIndex-3]?.value==='*');
    return {async,declaration:false,generator};
}

function arrowFunctionContext(tokens){
    const arrow=tokens.at(-1);
    if(arrow?.value!=='=>')return null;
    const parameter=tokens.at(-2);
    let async=false;
    if(parameter?.value===')'&&Number.isInteger(parameter.openTokenIndex)){
        const beforeOpen=tokens[parameter.openTokenIndex-1];
        async=beforeOpen?.type==='identifier'&&beforeOpen.value==='async';
    }else{
        const beforeParameter=tokens.at(-3);
        async=beforeParameter?.type==='identifier'&&beforeParameter.value==='async';
    }
    return {async,declaration:false,generator:false};
}

function openingBraceContext(tokens,braces){
    const previous=tokens.at(-1);
    const enclosingBraceKind=braces.at(-1)?.kind??null;
    const arrow=arrowFunctionContext(tokens);
    if(arrow){
        return {kind:'function',functionContext:arrow,slashGoalAfter:'division'};
    }
    const header=functionHeader(tokens,previous,enclosingBraceKind);
    if(header){
        return {
            kind:'function',
            functionContext:header,
            slashGoalAfter:header.declaration?'regex':'division'
        };
    }
    const classContext=classHeader(tokens);
    if(classContext){
        return {
            kind:'class',
            functionContext:null,
            slashGoalAfter:classContext.declaration?'regex':'division'
        };
    }
    if(previous?.closesControl===true
        ||(previous?.type==='identifier'
            &&new Set(['do','else','finally','try']).has(previous.value))){
        return {kind:'block',functionContext:null,slashGoalAfter:'regex'};
    }
    if(!previous||new Set([';','{']).has(previous.value)
        ||previous.slashGoalAfter==='regex'){
        return {kind:'block',functionContext:null,slashGoalAfter:'regex'};
    }
    if(new Set(['=', '(', '[', ',', '?']).has(previous.value)
        ||(previous.type==='identifier'
            &&new Set(['case','return','throw']).has(previous.value))){
        return {kind:'object',functionContext:null,slashGoalAfter:'division'};
    }
    if(previous.value===':'){
        if(enclosingBraceKind==='class'||enclosingBraceKind==='object'){
            return {kind:'object',functionContext:null,slashGoalAfter:'division'};
        }
        return {kind:'ambiguous',functionContext:null,slashGoalAfter:'ambiguous'};
    }
    return {kind:'ambiguous',functionContext:null,slashGoalAfter:'ambiguous'};
}

function activeFunctionContext(braces){
    for(let index=braces.length-1;index>=0;index-=1){
        if(braces[index].kind==='function')return braces[index].functionContext;
    }
    return null;
}

function contextualForOf(tokens,parentheses){
    const context=parentheses.at(-1);
    if(context?.keyword!=='for'||context.sawSemicolon||context.sawOf)return false;
    const previous=tokens.at(-1);
    if(!previous||tokens.length-1<=context.openTokenIndex)return false;
    if(previous.value==='.'||previous.value==='?.'||previous.value==='#')return false;
    if(previous.type==='identifier'&&new Set(['const','let','var']).has(previous.value)){
        return false;
    }
    return previous.type==='identifier'
        ||new Set([']',')','}']).has(previous.value);
}

function functionParameterDeclaration(tokens,parentheses){
    const context=parentheses.at(-1);
    if(!Number.isInteger(context?.openTokenIndex))return false;
    for(let index=context.openTokenIndex-1;index>=0;index-=1){
        const token=tokens[index];
        if(new Set([';','{','}']).has(token.value))return false;
        if(token.type==='identifier'&&token.value==='function'
            &&!identifierIsProperty(tokens,index))return true;
    }
    return false;
}

function laterVariableDeclarator(tokens){
    if(tokens.at(-1)?.value!==',')return false;
    for(let index=tokens.length-2;index>=0;index-=1){
        const token=tokens[index];
        if(tokens[index+1]?.lineBreakBefore===true)return false;
        if(new Set([';','{','}']).has(token.value))return false;
        if(token.type==='identifier'&&new Set(['const','let','var']).has(token.value)
            &&!identifierIsProperty(tokens,index))return true;
    }
    return false;
}

function declaresContextualIdentifier(tokens,parentheses){
    const previous=tokens.at(-1);
    if(previous?.type==='identifier'
        &&new Set(['const','let','var']).has(previous.value)
        &&!identifierIsProperty(tokens,tokens.length-1))return true;
    if(new Set(['{','[']).has(previous?.value)
        &&tokens.at(-2)?.type==='identifier'
        &&new Set(['const','let','var']).has(tokens.at(-2).value))return true;
    return laterVariableDeclarator(tokens)||functionParameterDeclaration(tokens,parentheses);
}

function skipRegex(source,start){
    let index=start+1;
    let characterClass=false;
    while(index<source.length){
        const character=source[index];
        if(LINE_TERMINATOR.test(character)){
            fail(`Import-map scan found an unterminated regular expression at offset ${String(start)}.`);
        }
        if(character==='\\'){
            index+=2;
            continue;
        }
        if(character==='[')characterClass=true;
        else if(character===']')characterClass=false;
        else if(character==='/'&&!characterClass){
            index+=1;
            while(/[a-z]/u.test(source[index]??''))index+=1;
            return index;
        }
        index+=1;
    }
    fail(`Import-map scan found an unterminated regular expression at offset ${String(start)}.`);
}

function tokenize(source){
    const tokens=[];
    let index=0;
    let previous=null;
    let braceDepth=0;
    let lineTerminatorSinceToken=false;
    const parentheses=[];
    const braces=[];
    const contextualBindings=new Set();
    const templateExpressions=[];
    while(index<source.length){
        const character=source[index];
        if(character==='#'&&source[index+1]==='!'
            &&(index===0||(index===1&&source[0]==='\ufeff'))){
            index+=2;
            while(index<source.length&&!LINE_TERMINATOR.test(source[index]))index+=1;
            continue;
        }
        if(character==='}'&&templateExpressions.at(-1)?.braceDepth===0){
            const parsed=templateChunk(source,index+1);
            const token={
                type:'template',value:'`',start:index,end:parsed.next,braceDepth,
                enclosingBraceKind:braces.at(-1)?.kind??null,
                lineBreakBefore:lineTerminatorSinceToken
            };
            tokens.push(token);
            if(parsed.complete)templateExpressions.pop();
            previous=parsed.complete?token:null;
            lineTerminatorSinceToken=false;
            index=parsed.next;
            continue;
        }
        if(/\s/u.test(character)){
            if(LINE_TERMINATOR.test(character))lineTerminatorSinceToken=true;
            index+=1;
            continue;
        }
        if(character==='/'&&source[index+1]==='/'){
            index+=2;
            while(index<source.length&&!LINE_TERMINATOR.test(source[index]))index+=1;
            continue;
        }
        if(character==='/'&&source[index+1]==='*'){
            const close=source.indexOf('*/',index+2);
            if(close<0)fail(`Import-map scan found an unterminated block comment at offset ${String(index)}.`);
            if(LINE_TERMINATOR.test(source.slice(index+2,close))){
                lineTerminatorSinceToken=true;
            }
            index=close+2;
            continue;
        }
        if(character==='\''||character==='"'){
            const parsed=stringToken(source,index);
            parsed.token.braceDepth=braceDepth;
            parsed.token.enclosingBraceKind=braces.at(-1)?.kind??null;
            parsed.token.lineBreakBefore=lineTerminatorSinceToken;
            tokens.push(parsed.token);
            previous=parsed.token;
            lineTerminatorSinceToken=false;
            index=parsed.next;
            continue;
        }
        if(character==='`'){
            const parsed=templateChunk(source,index,{opening:true});
            const token={
                type:'template',value:'`',start:index,end:parsed.next,braceDepth,
                enclosingBraceKind:braces.at(-1)?.kind??null,
                lineBreakBefore:lineTerminatorSinceToken
            };
            tokens.push(token);
            if(!parsed.complete)templateExpressions.push({braceDepth:0});
            previous=parsed.complete?token:null;
            lineTerminatorSinceToken=false;
            index=parsed.next;
            continue;
        }
        if(character==='/'&&regexMayStart(previous,{
            beforePrevious:tokens.at(-2),
            beforeBeforePrevious:tokens.at(-3),
            lineTerminatorBefore:lineTerminatorSinceToken
        })){
            const end=skipRegex(source,index);
            const token={
                type:'regex',value:'/',start:index,end,braceDepth,
                enclosingBraceKind:braces.at(-1)?.kind??null,
                lineBreakBefore:lineTerminatorSinceToken
            };
            tokens.push(token);
            previous=token;
            lineTerminatorSinceToken=false;
            index=end;
            continue;
        }
        const identifierStart=sourceCharacter(source,index);
        if(IDENTIFIER_START.test(identifierStart)){
            let end=index+identifierStart.length;
            while(end<source.length){
                const continuation=sourceCharacter(source,end);
                if(!IDENTIFIER_CONTINUE.test(continuation))break;
                end+=continuation.length;
            }
            const token={
                type:'identifier',value:source.slice(index,end),start:index,end,braceDepth,
                enclosingBraceKind:braces.at(-1)?.kind??null,
                lineBreakBefore:lineTerminatorSinceToken
            };
            const property=identifierIsProperty([...tokens,token],tokens.length);
            if(!property&&previous?.type==='identifier'
                &&new Set(['break','continue']).has(previous.value)
                &&token.lineBreakBefore===false){
                token.restrictedStatementLabel=true;
                token.restrictedStatementKind=previous.value;
            }
            if(!property&&new Set(['await','yield']).has(token.value)
                &&declaresContextualIdentifier(tokens,parentheses)){
                contextualBindings.add(token.value);
                token.slashGoalAfter='division';
            }else if(!property&&token.value==='await'){
                const functionContext=activeFunctionContext(braces);
                if(functionContext?.async)token.contextualRegexPrefix=true;
                else if(functionContext||contextualBindings.has('await')){
                    token.slashGoalAfter='division';
                }else token.slashGoalAfter='ambiguous';
            }else if(!property&&token.value==='yield'){
                const functionContext=activeFunctionContext(braces);
                if(functionContext?.generator)token.contextualRegexPrefix=true;
                else if(functionContext||contextualBindings.has('yield')){
                    token.slashGoalAfter='division';
                }else token.slashGoalAfter='ambiguous';
            }else if(!property&&token.value==='of'&&contextualForOf(tokens,parentheses)){
                token.contextualRegexPrefix=true;
                parentheses.at(-1).sawOf=true;
            }
            tokens.push(token);
            previous=token;
            lineTerminatorSinceToken=false;
            index=end;
            continue;
        }
        if(/[0-9]/u.test(character)){
            let end=index+1;
            while(/[A-Za-z0-9_.]/u.test(source[end]??''))end+=1;
            const token={
                type:'number',value:source.slice(index,end),start:index,end,braceDepth,
                enclosingBraceKind:braces.at(-1)?.kind??null,
                lineBreakBefore:lineTerminatorSinceToken
            };
            tokens.push(token);
            previous=token;
            lineTerminatorSinceToken=false;
            index=end;
            continue;
        }
        const three=source.slice(index,index+3);
        const two=source.slice(index,index+2);
        const value=three==='...'?three:
            new Set(['=>','?.','++','--','&&','||','??','==','!=','<=','>=','**']).has(two)
                ?two:character;
        const token={
            type:'punctuator',value,start:index,end:index+value.length,braceDepth,
            enclosingBraceKind:braces.at(-1)?.kind??null,
            lineBreakBefore:lineTerminatorSinceToken
        };
        if(value==='('){
            const directKeyword=previous?.type==='identifier'
                &&!identifierIsProperty(tokens,tokens.length-1)
                &&new Set(['catch','for','if','switch','while','with']).has(previous.value)
                ?previous.value:null;
            const keyword=directKeyword??(
                previous?.type==='identifier'&&previous.value==='await'
                    &&tokens.at(-2)?.type==='identifier'&&tokens.at(-2).value==='for'
                    ?'for':null
            );
            parentheses.push({
                keyword,
                openTokenIndex:tokens.length,
                sawOf:false,
                sawSemicolon:false
            });
        }else if(value===')'){
            const context=parentheses.pop();
            token.closesControl=context?.keyword!=null;
            token.openTokenIndex=context?.openTokenIndex;
        }else if(value===';'&&parentheses.length>0){
            parentheses.at(-1).sawSemicolon=true;
        }
        if(templateExpressions.length>0){
            if(value==='{')templateExpressions.at(-1).braceDepth+=1;
            else if(value==='}'&&templateExpressions.at(-1).braceDepth>0){
                templateExpressions.at(-1).braceDepth-=1;
            }
        }
        if(value==='{'){
            const context=openingBraceContext(tokens,braces);
            context.openTokenIndex=tokens.length;
            token.openingBraceKind=context.kind;
            braces.push(context);
            braceDepth+=1;
        }else if(value==='}'){
            const context=braces.pop()??{
                kind:'ambiguous',functionContext:null,slashGoalAfter:'ambiguous'
            };
            token.enclosingBraceKind=context.kind;
            token.closedBraceKind=context.kind;
            token.slashGoalAfter=context.slashGoalAfter;
            if(braceDepth>0)braceDepth-=1;
        }
        tokens.push(token);
        previous=token;
        lineTerminatorSinceToken=false;
        index=token.end;
    }
    return tokens;
}

function matchingToken(tokens,start,opening,closing){
    let depth=0;
    for(let index=start;index<tokens.length;index+=1){
        if(tokens[index].value===opening)depth+=1;
        else if(tokens[index].value===closing){
            depth-=1;
            if(depth===0)return index;
        }
    }
    return -1;
}

function importIsMethodDefinition(tokens,index){
    const current=tokens[index];
    if(!new Set(['class','object']).has(current?.enclosingBraceKind)
        ||tokens[index+1]?.value!=='(')return false;
    const close=matchingToken(tokens,index+1,'(',')');
    if(close<0||tokens[close+1]?.value!=='{')return false;
    let cursor=index-1;
    if(tokens[cursor]?.value==='#')cursor-=1;
    if(tokens[cursor]?.value==='*')cursor-=1;
    while(tokens[cursor]?.type==='identifier'
        &&new Set(['async','get','set','static']).has(tokens[cursor].value))cursor-=1;
    return new Set(['{','}',',',';']).has(tokens[cursor]?.value);
}

function sourceAfterFrom(tokens,start,end){
    for(let index=start;index<end;index+=1){
        if(tokens[index].type==='identifier'&&tokens[index].value==='from'
            &&tokens[index+1]?.type==='string'){
            return tokens[index+1];
        }
    }
    return null;
}

function statementEnd(tokens,start){
    const startDepth=tokens[start]?.braceDepth??0;
    for(let index=start;index<tokens.length;index+=1){
        if(tokens[index].value===';'&&tokens[index].braceDepth===startDepth)return index;
    }
    return tokens.length;
}

function topLevelCommas(tokens,start,end){
    const commas=[];
    const depths={parenthesis:0,bracket:0,brace:0};
    for(let index=start;index<end;index+=1){
        const value=tokens[index].value;
        if(value==='(')depths.parenthesis+=1;
        else if(value===')'&&depths.parenthesis>0)depths.parenthesis-=1;
        else if(value==='[')depths.bracket+=1;
        else if(value===']'&&depths.bracket>0)depths.bracket-=1;
        else if(value==='{')depths.brace+=1;
        else if(value==='}'&&depths.brace>0)depths.brace-=1;
        else if(value===','&&depths.parenthesis===0&&depths.bracket===0&&depths.brace===0){
            commas.push(index);
        }
    }
    return commas;
}

function importRecord(kind,token){
    return {kind,specifier:token.value,offset:token.start};
}

export function scanModuleImports(source,{importer='<module>'}={}){
    if(typeof source!=='string')throw new TypeError('scanModuleImports source must be a string.');
    const tokens=tokenize(source);
    const imports=[];
    let hasModuleSyntax=false;
    for(let index=0;index<tokens.length;index+=1){
        const current=tokens[index];
        if(current.type!=='identifier'||(current.value!=='import'&&current.value!=='export')
            ||identifierIsProperty(tokens,index))continue;
        const next=tokens[index+1];
        if(current.value==='import'){
            if(next?.value==='.'){
                hasModuleSyntax=true;
                continue;
            }
            if(next?.value==='('){
                if(importIsMethodDefinition(tokens,index))continue;
                hasModuleSyntax=true;
                const close=matchingToken(tokens,index+1,'(',')');
                if(close<0)continue;
                const argument=tokens[index+2];
                const commas=topLevelCommas(tokens,index+2,close);
                const firstBoundary=commas[0]??close;
                if(argument?.type!=='string'||firstBoundary!==index+3
                    ||commas.length>2
                    ||(commas.length===2
                        &&(commas[1]!==close-1||commas[1]===commas[0]+1))){
                    index=close;
                    continue;
                }
                imports.push(importRecord('dynamic',argument));
                continue;
            }
            if(current.braceDepth!==0)continue;
            if(next?.type==='string'){
                hasModuleSyntax=true;
                imports.push(importRecord('static',next));
                continue;
            }
            const end=statementEnd(tokens,index+1);
            const sourceToken=sourceAfterFrom(tokens,index+1,end);
            if(!sourceToken){
                fail(`Import-map scan found an import without a literal source in "${importer}".`);
            }
            hasModuleSyntax=true;
            imports.push(importRecord('static',sourceToken));
            continue;
        }
        if(current.braceDepth!==0)continue;
        hasModuleSyntax=true;
        if(next?.value==='*'){
            const end=statementEnd(tokens,index+1);
            const sourceToken=sourceAfterFrom(tokens,index+2,end);
            if(!sourceToken){
                fail(`Import-map scan found an export without a literal source in "${importer}".`);
            }
            imports.push(importRecord('export',sourceToken));
        }else if(next?.value==='{'){
            const cursor=matchingToken(tokens,index+1,'{','}');
            if(cursor>=0&&tokens[cursor+1]?.type==='identifier'
                &&tokens[cursor+1].value==='from'){
                const sourceToken=tokens[cursor+2];
                if(sourceToken?.type!=='string'){
                    fail(`Import-map scan found an export without a literal source in "${importer}".`);
                }
                imports.push(importRecord('export',sourceToken));
            }
        }
    }
    return {
        hasModuleSyntax,
        imports
    };
}

function registerSpecifier(registry,specifier,target){
    registry.set(specifier,{specifier,target});
}

function validateInventory(files){
    if(!Array.isArray(files))throw new TypeError('buildImportMap files must be an array.');
    const exact=new Set();
    for(const value of [...files].sort(compareText)){
        const relative=safeRelativePath(value,'runtime inventory path');
        exact.add(relative);
    }
    return exact;
}

export async function buildImportMap({files,signal}={}){
    throwIfAborted(signal);
    const inventory=validateInventory(files);
    const modules=[...inventory]
        .filter(relative=>relative.startsWith('modules/')
            &&!relative.slice('modules/'.length).includes('/')
            &&JAVASCRIPT_EXTENSION.test(relative))
        .sort(compareText);
    const namedRegistry=new Map();
    const excludedModules=[];
    for(const relative of modules){
        throwIfAborted(signal);
        if(relative===NODE_ONLY_MODULE){
            excludedModules.push(relative);
            continue;
        }
        const name=path.posix.basename(relative).replace(JAVASCRIPT_EXTENSION,'');
        registerSpecifier(namedRegistry,`arcane/${name}`,`./arcane/${relative}`);
    }
    const entities=[...inventory].filter(relative=>relative.startsWith('entities/')
        &&!relative.slice('entities/'.length).includes('/')
        &&JAVASCRIPT_EXTENSION.test(relative)).sort(compareText);
    for(const relative of entities){
        throwIfAborted(signal);
        const name=path.posix.basename(relative).replace(JAVASCRIPT_EXTENSION,'');
        registerSpecifier(namedRegistry,`arcane/entities/${name}`,`./arcane/${relative}`);
    }
    for(const [specifier,relative] of STATIC_RUNTIME_PACKAGE_IMPORTS){
        if(inventory.has(relative)){
            registerSpecifier(namedRegistry,specifier,`./arcane/${relative}`);
        }
    }
    for(const [specifier,relative] of SDK_BROWSER_SELF_IMPORTS){
        if(inventory.has(relative)){
            registerSpecifier(namedRegistry,specifier,`./arcane/${relative}`);
        }
    }
    if(inventory.has('sdk/dom-event-instrumentation.mjs')){
        registerSpecifier(
            namedRegistry,
            'arcane-os/dom-event-instrumentation',
            './arcane/sdk/dom-event-instrumentation.mjs'
        );
    }
    if(inventory.has(PERSISTENT_CHAT_MODULE)){
        registerSpecifier(
            namedRegistry,
            PERSISTENT_CHAT_IMPORT,
            './arcane/modules/PersistentAIChatSession.js'
        );
    }
    if(inventory.has('dependencies/strong-type/index.js')){
        registerSpecifier(
            namedRegistry,
            './node_modules/strong-type/index.js',
            './arcane/dependencies/strong-type/index.js'
        );
    }
    if(inventory.has('sdk/dependencies/event-pubsub/index.js')){
        registerSpecifier(
            namedRegistry,
            'event-pubsub',
            './arcane/sdk/dependencies/event-pubsub/index.js'
        );
    }
    const imports={};
    for(const entry of [...namedRegistry.values()].sort((left,right)=>compareText(left.specifier,right.specifier))){
        imports[entry.specifier]=entry.target;
    }
    return {
        imports,
        excludedModules:excludedModules.sort(compareText)
    };
}

function pathInside(root,target){
    const relative=path.relative(root,target);
    return relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative));
}

function samePath(left,right){
    const a=path.resolve(left);
    const b=path.resolve(right);
    return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
}

async function physicalRuntime(workspaceRoot,signal){
    const requestedRoot=path.join(workspaceRoot,'arcane');
    let rootInfo;
    try{rootInfo=await lstat(requestedRoot);}
    catch(error){
        if(error?.code==='ENOENT')fail(`Workspace Arcane runtime is missing: ${requestedRoot}.`);
        throw error;
    }
    if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()){
        fail('Workspace Arcane runtime must be a real directory, not a symbolic link or junction.');
    }
    const canonicalRoot=await realpath(requestedRoot);
    if(!samePath(requestedRoot,canonicalRoot)){
        fail('Workspace Arcane runtime must stay inside its physical workspace directory.');
    }
    const files=[];
    async function visit(directory,relativeRoot=''){
        throwIfAborted(signal);
        const entries=await readdir(directory,{withFileTypes:true});
        entries.sort((left,right)=>compareText(left.name,right.name));
        for(const entry of entries){
            throwIfAborted(signal);
            const relative=relativeRoot?`${relativeRoot}/${entry.name}`:entry.name;
            const absolute=path.join(directory,entry.name);
            const info=await lstat(absolute);
            if(info.isSymbolicLink()){
                fail(`Workspace Arcane runtime contains a symbolic link or junction: ${relative}.`);
            }
            if(info.isDirectory())await visit(absolute,relative);
            else if(info.isFile())files.push(relative);
            else fail(`Workspace Arcane runtime contains a non-file entry: ${relative}.`);
        }
    }
    await visit(canonicalRoot);
    return {files};
}

async function managedImportMapBuild(resolvedWorkspace,signal){
    const runtime=await physicalRuntime(resolvedWorkspace,signal);
    const built=await buildImportMap({files:runtime.files,signal});
    const json=`${JSON.stringify({imports:built.imports},null,2).replaceAll('<','\\u003c')}\n`;
    return {built,json};
}

function asciiLower(value){
    return String(value).replace(/[A-Z]/g,character=>
        String.fromCodePoint(character.codePointAt(0)+0x20));
}

function trimHtmlAsciiWhitespace(value){
    return String(value).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu,'');
}

function canonicalHtmlToken(value){
    return asciiLower(trimHtmlAsciiWhitespace(value));
}

function htmlTagName(value){
    if(/[\u0000\p{White_Space}]/u.test(value)){
        fail('Application HTML contains a malformed structural tag name.');
    }
    return asciiLower(value);
}

function parseTagAttributes(openTag){
    const attributes=new Map();
    const duplicates=new Set();
    Object.defineProperty(attributes,'duplicates',{value:duplicates});
    const tagHead=openTag.match(/^<[A-Za-z][^\t\n\f\r />]*(?=[\t\n\f\r />])/u);
    if(!tagHead)fail('Application HTML contains a malformed structural start tag.');
    let index=tagHead[0].length;
    while(index<openTag.length){
        while(/[\t\n\f\r ]/u.test(openTag[index]??''))index+=1;
        if(openTag[index]==='>'||index>=openTag.length)break;
        if(openTag[index]==='/'){
            index+=1;
            if(openTag[index]==='>')break;
            fail('Application HTML contains a nonterminal self-closing slash in a structural tag.');
        }
        const start=index;
        while(index<openTag.length&&!/[\t\n\f\r =>/]/u.test(openTag[index]))index+=1;
        const name=asciiLower(openTag.slice(start,index));
        while(/[\t\n\f\r ]/u.test(openTag[index]??''))index+=1;
        let value='';
        if(openTag[index]==='='){
            index+=1;
            while(/[\t\n\f\r ]/u.test(openTag[index]??''))index+=1;
            const quote=openTag[index];
            if(quote==='\''||quote==='"'){
                index+=1;
                const valueStart=index;
                while(index<openTag.length&&openTag[index]!==quote)index+=1;
                value=openTag.slice(valueStart,index);
                if(openTag[index]===quote)index+=1;
            }else{
                const valueStart=index;
                while(index<openTag.length&&!/[\t\n\f\r >]/u.test(openTag[index]))index+=1;
                value=openTag.slice(valueStart,index);
            }
        }
        if(name){
            if(attributes.has(name))duplicates.add(name);
            else attributes.set(name,value);
        }
    }
    return attributes;
}

function decodeStructuralAttribute(value,label){
    const source=String(value);
    if(!source.includes('&'))return source;
    const decoded=source.replace(
        /&(?:#([0-9]+)|#x([a-f0-9]+)|(amp|apos|gt|lt|quot));/giu,
        (match,decimal,hex,named)=>{
            if(named){
                return {amp:'&',apos:"'",gt:'>',lt:'<',quot:'"'}[asciiLower(named)];
            }
            const point=Number.parseInt(decimal??hex,decimal?10:16);
            if(!Number.isSafeInteger(point)||point<=0||point>0x10ffff
                ||(point>=0xd800&&point<=0xdfff)){
                fail(`Application HTML ${label} contains an invalid character reference.`);
            }
            return String.fromCodePoint(point);
        }
    );
    if(decoded.includes('&')){
        fail(
            `Application HTML ${label} contains an unsupported or ambiguous character reference.`
        );
    }
    return decoded;
}

function structuralAttribute(attributes,name,element){
    if(attributes.duplicates.has(name)){
        fail(`Application HTML ${element} repeats its ${name} attribute.`);
    }
    return decodeStructuralAttribute(attributes.get(name)??'',`${element} ${name}`);
}

function scriptType(attributes){
    return canonicalHtmlToken(structuralAttribute(attributes,'type','script'));
}

function htmlTagEnd(html,start){
    let state='before-attribute-name';
    let quote=null;
    for(let index=start;index<html.length;index+=1){
        const character=html[index];
        if(state==='quoted-attribute-value'){
            if(character===quote)quote=null;
            if(quote===null)state='after-quoted-attribute-value';
            continue;
        }
        if(character==='>')return index+1;
        const whitespace=/[\t\n\f\r ]/u.test(character);
        if(state==='before-attribute-name'){
            if(whitespace)continue;
            state=character==='/'?'self-closing-start-tag':'attribute-name';
            continue;
        }
        if(state==='attribute-name'){
            if(whitespace)state='after-attribute-name';
            else if(character==='=')state='before-attribute-value';
            else if(character==='/')state='self-closing-start-tag';
            continue;
        }
        if(state==='after-attribute-name'){
            if(whitespace)continue;
            if(character==='=')state='before-attribute-value';
            else if(character==='/')state='self-closing-start-tag';
            else state='attribute-name';
            continue;
        }
        if(state==='before-attribute-value'){
            if(whitespace)continue;
            if(character==='\''||character==='"'){
                quote=character;
                state='quoted-attribute-value';
            }else state='unquoted-attribute-value';
            continue;
        }
        if(state==='unquoted-attribute-value'){
            if(whitespace)state='before-attribute-name';
            continue;
        }
        if(state==='after-quoted-attribute-value'){
            if(whitespace)state='before-attribute-name';
            else if(character==='/')state='self-closing-start-tag';
            else state='attribute-name';
            continue;
        }
        if(state==='self-closing-start-tag'){
            if(whitespace)state='before-attribute-name';
            else state='attribute-name';
        }
    }
    fail('Application HTML contains a tag that reaches end of file before ">".');
}

const RAW_TEXT_ELEMENTS=new Set(['iframe','noembed','noframes','noscript','script','style','xmp']);
const RCDATA_ELEMENTS=new Set(['textarea','title']);
const TEXT_ELEMENTS=new Set([...RAW_TEXT_ELEMENTS,...RCDATA_ELEMENTS]);

function rawElementEnd(html,tag,openEnd){
    const closePattern=new RegExp(`<\\/${tag}(?=[\\t\\n\\f\\r />]|$)`,'gi');
    closePattern.lastIndex=openEnd;
    const close=closePattern.exec(html);
    if(!close)return {end:html.length,closed:false};
    const end=htmlTagEnd(html,close.index+close[0].length);
    const closeTag=html.slice(close.index,end);
    if(!new RegExp(`^<\\/${tag}[\\t\\n\\f\\r ]*>$`,'i').test(closeTag)){
        fail(`Application HTML contains a malformed </${tag}> end tag.`);
    }
    return {end,closed:true};
}

function commentEnd(html,start){
    if(html.startsWith('<!-->',start))return start+5;
    if(html.startsWith('<!--->',start))return start+6;
    const canonical=html.indexOf('-->',start+4);
    const bang=html.indexOf('--!>',start+4);
    const close=canonical<0?bang:bang<0?canonical:Math.min(canonical,bang);
    if(close<0)fail('Application HTML contains an unterminated comment.');
    return close+(close===bang?4:3);
}

function htmlTagHead(html,start){
    return html.slice(start).match(/^<\/?([A-Za-z][^\t\n\f\r />]*)(?=[\t\n\f\r />])/u);
}

function validateEndTag(source,name){
    const match=source.match(/^<\/([A-Za-z][^\t\n\f\r />]*)[\t\n\f\r ]*>$/u);
    if(!match||asciiLower(match[1])!==name){
        fail(`Application HTML contains a malformed </${name}> end tag.`);
    }
}

function selectElementEnd(html,openEnd){
    const selected=rawElementEnd(html,'select',openEnd);
    if(!selected.closed)fail('Application HTML contains an unterminated <select> element.');
    return selected.end;
}

function nestedTemplateEnd(html,openEnd){
    let depth=1;
    let cursor=openEnd;
    while(cursor<html.length){
        const start=html.indexOf('<',cursor);
        if(start<0)return html.length;
        if(html.startsWith('<!--',start)){
            cursor=commentEnd(html,start);
            continue;
        }
        if(html.startsWith('<!',start)||html.startsWith('<?',start)){
            cursor=htmlTagEnd(html,start+2);
            continue;
        }
        const head=htmlTagHead(html,start);
        if(!head){
            if(html.startsWith('</',start)||/^<[A-Za-z]/u.test(html.slice(start))){
                fail('Application HTML template contains a malformed tag.');
            }
            cursor=start+1;
            continue;
        }
        const name=htmlTagName(head[1]);
        const end=htmlTagEnd(html,start+head[0].length);
        const closing=html[start+1]==='/';
        if(closing)validateEndTag(html.slice(start,end),name);
        if(name==='select'){
            if(closing){
                cursor=end;
                continue;
            }
            cursor=selectElementEnd(html,end);
            continue;
        }
        if(!closing&&name==='plaintext')return html.length;
        if(!closing&&TEXT_ELEMENTS.has(name)){
            cursor=rawElementEnd(html,name,end).end;
            continue;
        }
        if(name!=='template'){
            cursor=end;
            continue;
        }
        if(closing)depth-=1;
        else depth+=1;
        cursor=end;
        if(depth===0)return end;
    }
    return html.length;
}

function scanHtmlStructure(html){
    const scripts=[];
    const links=[];
    const bases=[];
    const metas=[];
    let headClose=-1;
    let bodyClose=-1;
    let cursor=0;
    while(cursor<html.length){
        const start=html.indexOf('<',cursor);
        if(start<0)break;
        if(html.startsWith('<!--',start)){
            cursor=commentEnd(html,start);
            continue;
        }
        if(html.startsWith('<!',start)){
            const end=htmlTagEnd(html,start+2);
            cursor=end;
            continue;
        }
        if(html.startsWith('<?',start)){
            cursor=htmlTagEnd(html,start+2);
            continue;
        }
        const head=htmlTagHead(html,start);
        if(!head){
            if(html.startsWith('</',start)||/^<[A-Za-z]/u.test(html.slice(start))){
                fail('Application HTML contains a malformed tag.');
            }
            cursor=start+1;
            continue;
        }
        const tag=htmlTagName(head[1]);
        const closing=html[start+1]==='/';
        const openEnd=htmlTagEnd(html,start+head[0].length);
        const open=html.slice(start,openEnd);
        if(tag==='select'){
            if(closing){
                cursor=openEnd;
                continue;
            }
            cursor=selectElementEnd(html,openEnd);
            continue;
        }
        if(closing){
            validateEndTag(open,tag);
            if(tag==='head'&&headClose<0)headClose=start;
            if(tag==='body'&&bodyClose<0)bodyClose=start;
            cursor=openEnd;
            continue;
        }
        if(tag==='link'){
            links.push({start,end:openEnd,open});
            cursor=openEnd;
            continue;
        }
        if(tag==='base'){
            bases.push({start,end:openEnd,open});
            cursor=openEnd;
            continue;
        }
        if(tag==='meta'){
            metas.push({start,end:openEnd,open});
            cursor=openEnd;
            continue;
        }
        if(tag==='template'){
            cursor=nestedTemplateEnd(html,openEnd);
            continue;
        }
        if(tag==='plaintext'){
            cursor=html.length;
            continue;
        }
        if(!TEXT_ELEMENTS.has(tag)){
            cursor=openEnd;
            continue;
        }
        const raw=rawElementEnd(html,tag,openEnd);
        if(tag==='script')scripts.push({
            start,
            openEnd,
            end:raw.end,
            open,
            closed:raw.closed
        });
        cursor=raw.end;
    }
    return {scripts,links,bases,metas,headClose,bodyClose};
}

function removeManagedBlocks(html,blocks){
    let result=html;
    for(const block of [...blocks].sort((left,right)=>right.start-left.start)){
        let start=block.start;
        let end=block.end;
        const lineStart=result.lastIndexOf('\n',start-1)+1;
        if(/^[\t\n\f\r ]*$/u.test(result.slice(lineStart,start)))start=lineStart;
        const trailing=result.slice(end).match(/^(?:\r?\n)/u);
        if(trailing)end+=trailing[0].length;
        result=result.slice(0,start)+result.slice(end);
    }
    return result;
}

function firstModulePosition(html){
    const structure=scanHtmlStructure(html);
    let first=-1;
    for(const script of structure.scripts){
        const attributes=parseTagAttributes(script.open);
        if(scriptType(attributes)==='module'
            &&(first<0||script.start<first))first=script.start;
    }
    for(const link of structure.links){
        const attributes=parseTagAttributes(link.open);
        const relationships=canonicalHtmlToken(structuralAttribute(attributes,'rel','link'))
            .split(/[\t\n\f\r ]+/u);
        if(relationships.includes('modulepreload')&&(first<0||link.start<first))first=link.start;
    }
    return first;
}

function firstBlockingLoadPosition(html,{skipManaged=false}={}){
    const structure=scanHtmlStructure(html);
    let first=-1;
    for(const script of structure.scripts){
        const attributes=parseTagAttributes(script.open);
        structuralAttribute(attributes,'type','script');
        if(skipManaged&&attributes.has(MANAGED_IMPORT_MAP_ATTRIBUTE))continue;
        if(first<0||script.start<first)first=script.start;
    }
    for(const link of structure.links){
        const attributes=parseTagAttributes(link.open);
        const relationships=canonicalHtmlToken(structuralAttribute(attributes,'rel','link'))
            .split(/[\t\n\f\r ]+/u);
        if(relationships.includes('modulepreload')&&(first<0||link.start<first)){
            first=link.start;
        }
    }
    return first;
}

export function inspectImportMapHtml(html){
    const source=String(html);
    const structure=scanHtmlStructure(source);
    const bases=structure.bases.map(base=>({
        start:base.start,
        end:base.end,
        href:structuralAttribute(parseTagAttributes(base.open),'href','base')
    }));
    const managedMaps=structure.scripts.filter(script=>{
        const attributes=parseTagAttributes(script.open);
        return attributes.has(MANAGED_IMPORT_MAP_ATTRIBUTE)
            &&scriptType(attributes)==='importmap';
    }).map(script=>({start:script.start,end:script.end}));
    const scripts=structure.scripts.map(script=>{
        const attributes=parseTagAttributes(script.open);
        return {
            start:script.start,
            end:script.end,
            type:scriptType(attributes),
            src:structuralAttribute(attributes,'src','script'),
            managed:attributes.has(MANAGED_IMPORT_MAP_ATTRIBUTE)
        };
    });
    const links=structure.links.map(link=>{
        const attributes=parseTagAttributes(link.open);
        return {
            start:link.start,
            end:link.end,
            rel:canonicalHtmlToken(structuralAttribute(attributes,'rel','link')),
            href:structuralAttribute(attributes,'href','link')
        };
    });
    const metas=structure.metas.map(meta=>{
        const attributes=parseTagAttributes(meta.open);
        return {
            start:meta.start,
            end:meta.end,
            name:canonicalHtmlToken(structuralAttribute(attributes,'name','meta')),
            content:structuralAttribute(attributes,'content','meta')
        };
    });
    return {
        bases,
        managedMaps,
        scripts,
        links,
        metas,
        firstModulePosition:firstModulePosition(source)
    };
}

function documentBaseHref(relative){
    const directory=path.posix.dirname(relative);
    const depth=directory==='.'?0:directory.split('/').length;
    return '../'.repeat(depth+2);
}

function renderManagedHtml(html,json,baseHref='../../'){
    const structure=scanHtmlStructure(html);
    const activeBases=structure.bases.map(base=>({
        ...base,
        href:structuralAttribute(parseTagAttributes(base.open),'href','base')
    }));
    if(activeBases.length!==1||activeBases[0].href!==baseHref){
        fail(`Application HTML must contain exactly one active <base href="${baseHref}"> element.`);
    }
    const complete=[];
    for(const script of structure.scripts){
        const attributes=parseTagAttributes(script.open);
        if(attributes.has(MANAGED_IMPORT_MAP_ATTRIBUTE)){
            if(scriptType(attributes)!=='importmap')continue;
            if(!script.closed){
                fail(`Application HTML contains an unterminated ${MANAGED_IMPORT_MAP_ATTRIBUTE} script.`);
            }
            complete.push({start:script.start,end:script.end});
        }
    }
    const withoutManaged=removeManagedBlocks(html,complete);
    const cleanedStructure=scanHtmlStructure(withoutManaged);
    const cleanedBases=cleanedStructure.bases.map(base=>({
        ...base,
        href:structuralAttribute(parseTagAttributes(base.open),'href','base')
    }));
    if(cleanedBases.length!==1||cleanedBases[0].href!==baseHref){
        fail(`Application HTML must retain exactly one active <base href="${baseHref}"> element.`);
    }
    const firstBlocking=firstBlockingLoadPosition(withoutManaged);
    if(firstBlocking>=0&&cleanedBases[0].start>firstBlocking){
        fail('Application base element must precede every classic script, module, and modulepreload.');
    }
    const insertionPosition=cleanedBases[0].end;
    const lineStart=withoutManaged.lastIndexOf('\n',Math.max(0,cleanedBases[0].start-1))+1;
    const linePrefix=withoutManaged.slice(lineStart,cleanedBases[0].start);
    const indent=/^[\t\n\f\r ]*$/u.test(linePrefix)?linePrefix:'';
    const newline=withoutManaged.includes('\r\n')?'\r\n':'\n';
    const block=`${newline}${indent}<script type="importmap" ${MANAGED_IMPORT_MAP_ATTRIBUTE}>\n${json}</script>`;
    const rendered=withoutManaged.slice(0,insertionPosition)+block
        +withoutManaged.slice(insertionPosition);
    const rescanned=scanHtmlStructure(rendered);
    const managedScripts=rescanned.scripts.filter(script=>{
        const attributes=parseTagAttributes(script.open);
        return attributes.has(MANAGED_IMPORT_MAP_ATTRIBUTE)
            &&scriptType(attributes)==='importmap';
    });
    if(managedScripts.length!==1){
        fail('Generated application HTML must contain exactly one active managed Arcane import map.');
    }
    const managedPosition=managedScripts[0].start;
    const renderedBases=rescanned.bases.map(base=>({
        ...base,
        href:structuralAttribute(parseTagAttributes(base.open),'href','base')
    }));
    if(renderedBases.length!==1||renderedBases[0].href!==baseHref
        ||renderedBases[0].end>managedPosition
        ||!/^[\t\n\f\r ]*$/u.test(rendered.slice(renderedBases[0].end,managedPosition))){
        fail('Generated Arcane import-map HTML has an invalid or late base element.');
    }
    const blockingPosition=firstBlockingLoadPosition(rendered,{skipManaged:true});
    if(blockingPosition>=0&&managedPosition>blockingPosition){
        fail('Generated Arcane import map is not before the first classic script, module, or modulepreload.');
    }
    return rendered;
}

async function physicalDirectory(root,directory,{create=false}={}){
    const resolvedRoot=path.resolve(root);
    const resolvedDirectory=path.resolve(directory);
    if(!pathInside(resolvedRoot,resolvedDirectory)){
        fail(`Import-map directory escapes its application root: ${resolvedDirectory}.`);
    }
    const rootInfo=await lstat(resolvedRoot);
    if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()){
        fail(`Import-map application root must be a real directory: ${resolvedRoot}.`);
    }
    const canonicalRoot=await realpath(resolvedRoot);
    if(!samePath(resolvedRoot,canonicalRoot)){
        fail(`Import-map application root must be one physical directory: ${resolvedRoot}.`);
    }
    const relative=path.relative(resolvedRoot,resolvedDirectory);
    let current=resolvedRoot;
    for(const part of relative.split(path.sep).filter(Boolean)){
        const child=path.join(current,part);
        if(create){
            try{await mkdir(child);}
            catch(error){if(error?.code!=='EEXIST')throw error;}
        }
        const info=await lstat(child);
        if(info.isSymbolicLink()||!info.isDirectory()){
            fail(`Import-map directory must be a real directory: ${child}.`);
        }
        const canonical=await realpath(child);
        if(!pathInside(canonicalRoot,canonical)){
            fail(`Import-map directory resolves outside its application root: ${child}.`);
        }
        current=child;
    }
    return {root:resolvedRoot,canonicalRoot,directory:resolvedDirectory};
}

async function readPhysicalTextFile(root,filePath,label){
    const directory=await physicalDirectory(root,path.dirname(filePath));
    const info=await lstat(filePath);
    if(info.isSymbolicLink()||!info.isFile()){
        fail(`${label} must be a real file: ${filePath}.`);
    }
    const canonicalFile=await realpath(filePath);
    if(!pathInside(directory.canonicalRoot,canonicalFile)){
        fail(`${label} must stay inside its application root: ${filePath}.`);
    }
    return readFileFromDisk(filePath,'utf8');
}

async function assertPhysicalTextDestination(root,filePath,label,{createParent=false}={}){
    const directory=await physicalDirectory(root,path.dirname(filePath),{create:createParent});
    try{
        const info=await lstat(filePath);
        if(info.isSymbolicLink()||!info.isFile()){
            fail(`${label} destination must be a real file when present.`);
        }
        const canonicalFile=await realpath(filePath);
        if(!pathInside(directory.canonicalRoot,canonicalFile)){
            fail(`${label} destination must stay inside its application root.`);
        }
    }catch(error){
        if(error?.code!=='ENOENT')throw error;
    }
}

async function writeGeneratedFiles({root,files,signal,onEvent}){
    for(const file of files){
        throwIfAborted(signal);
        await assertPhysicalTextDestination(
            root,
            file.filePath,
            file.label,
            {createParent:file.createParent===true}
        );
    }
    const paths=[];
    let eventError=null;
    for(const file of files){
        throwIfAborted(signal);
        await writeFile(file.filePath,file.content,'utf8');
        paths.push(file.filePath);
        const currentEventError=await emit(onEvent,{
            type:'import-map.write.progress',
            paths:[...paths]
        });
        eventError??=currentEventError;
    }
    return eventError;
}

function resolvedAppRoot(workspaceRoot,appId,appRoot){
    if(typeof appId!=='string'||appId.trim()===''){
        throw new TypeError('Import-map app id must be a nonempty string.');
    }
    const resolved=path.resolve(appRoot??path.join(workspaceRoot,'apps',appId));
    if(!pathInside(workspaceRoot,resolved))fail('Import-map application root must stay inside the workspace.');
    return resolved;
}

export async function createApplicationTestImportMapContext({
    applicationRoot,
    boundary='source',
    imports={},
    signal
}={}){
    if(typeof applicationRoot!=='string'||applicationRoot.trim()===''){
        throw new TypeError('applicationRoot must be a nonempty string.');
    }
    if(!['source','dist','test'].includes(boundary)){
        throw new TypeError('boundary must be source, dist, or test.');
    }
    if(imports===null||typeof imports!=='object'||Array.isArray(imports)){
        throw new TypeError('imports must be a plain object.');
    }
    throwIfAborted(signal);
    const requestedApplicationRoot=path.resolve(applicationRoot);
    const applicationInfo=await lstat(requestedApplicationRoot);
    const canonicalApplicationRoot=await realpath(requestedApplicationRoot);
    if(applicationInfo.isSymbolicLink()||!applicationInfo.isDirectory()
        ||!samePath(requestedApplicationRoot,canonicalApplicationRoot)){
        fail('Application test import-map root must be one physical application directory.');
    }
    const requestedBase=boundary==='source'
        ?canonicalApplicationRoot
        :path.join(canonicalApplicationRoot,boundary);
    const baseInfo=await lstat(requestedBase);
    const canonicalBase=await realpath(requestedBase);
    if(baseInfo.isSymbolicLink()||!baseInfo.isDirectory()
        ||!samePath(requestedBase,canonicalBase)
        ||!pathInside(canonicalApplicationRoot,canonicalBase)){
        fail(`Application ${boundary} import-map base must be one physical app-owned directory.`);
    }
    const selectedImports={};
    for(const [specifier,target] of Object.entries(imports)){
        throwIfAborted(signal);
        if(typeof specifier!=='string'||specifier===''||typeof target!=='string'
            ||!target.startsWith('./')){
            fail(`Application test import-map entry is invalid: ${String(specifier)}.`);
        }
        const relative=safeRelativePath(
            target.slice(2),
            `application test import-map target for ${specifier}`
        );
        if(boundary==='source'&&/^(?:dist|test)\//u.test(relative)){
            fail(`Source import-map target selects another application boundary: ${specifier}.`);
        }
        const candidate=path.resolve(canonicalBase,...relative.split('/'));
        const targetInfo=await lstat(candidate);
        const canonicalTarget=await realpath(candidate);
        if(targetInfo.isSymbolicLink()||!targetInfo.isFile()
            ||!samePath(candidate,canonicalTarget)||!pathInside(canonicalBase,canonicalTarget)){
            fail(`Application test import-map target leaves its physical ${boundary} directory: ${specifier}.`);
        }
        selectedImports[specifier]=target;
    }
    return {
        protocol:'arcane-test-import-map/1',
        boundary,
        baseURL:pathToFileURL(`${canonicalBase}${path.sep}`).href,
        imports:selectedImports
    };
}

async function generateImportMapUnlocked({
    workspaceRoot,
    appId,
    appRoot,
    entry='index.html',
    documents,
    signal,
    onEvent
}={}){
    if(typeof workspaceRoot!=='string'||workspaceRoot.trim()===''){
        throw new TypeError('generateImportMap workspaceRoot must be a nonempty string.');
    }
    throwIfAborted(signal);
    const resolvedWorkspace=path.resolve(workspaceRoot);
    const resolvedApp=resolvedAppRoot(resolvedWorkspace,appId,appRoot);
    await physicalDirectory(resolvedWorkspace,resolvedApp);
    const safeEntry=safeRelativePath(entry,'application entry');
    const safeDocuments=normalizedDocumentPaths(safeEntry,documents);
    const documentPaths=safeDocuments.map(relative=>{
        const documentPath=path.resolve(resolvedApp,...relative.split('/'));
        if(!pathInside(resolvedApp,documentPath)){
            fail(`Import-map application document escapes its app root: ${relative}.`);
        }
        return documentPath;
    });
    const entryPath=documentPaths[0];
    const artifactPath=path.join(resolvedApp,...IMPORT_MAP_RELATIVE_PATH.split('/'));
    let eventError=await emit(onEvent,{
        type:'import-map.started',
        appId,
        artifactPath,
        entryPath,
        documentPaths
    });

    const documentStates=[];
    for(const [index,documentPath] of documentPaths.entries()){
        throwIfAborted(signal);
        const label=index===0
            ?'Import-map application entry'
            :`Import-map application document ${safeDocuments[index]}`;
        const html=await readPhysicalTextFile(resolvedApp,documentPath,label);
        throwIfAborted(signal);
        // Reject malformed application structure before traversing the runtime inventory.
        const baseHref=documentBaseHref(safeDocuments[index]);
        renderManagedHtml(html,'{"imports":{}}\n',baseHref);
        documentStates.push({filePath:documentPath,html,label,baseHref});
    }
    const {built,json}=await managedImportMapBuild(resolvedWorkspace,signal);
    const renderedDocuments=documentStates.map(item=>({
        ...item,
        content:renderManagedHtml(item.html,json,item.baseHref)
    }));

    throwIfAborted(signal);
    const writeEventError=await writeGeneratedFiles({
        root:resolvedApp,
        files:[
            {
                filePath:artifactPath,
                content:json,
                label:'Import-map artifact',
                createParent:true
            },
            ...renderedDocuments.map(item=>({
                filePath:item.filePath,
                content:item.content,
                label:item.label
            }))
        ],
        signal,
        onEvent
    });
    eventError??=writeEventError;
    const result={
        appId,
        artifactPath,
        artifactRelativePath:path.relative(resolvedWorkspace,artifactPath).split(path.sep).join('/'),
        entryPath,
        documentPaths,
        documentCount:documentPaths.length,
        imports:built.imports,
        excludedModules:built.excludedModules,
        committed:true
    };
    const completedEventError=await emit(onEvent,{
        type:'import-map.completed',
        appId,
        artifactPath,
        entryPath,
        documentPaths,
        committed:true
    });
    eventError??=completedEventError;
    if(eventError){
        return {
            ...result,
            eventDelivery:{
                status:'degraded',
                errorCode:'ARCANE_EVENT_DELIVERY_FAILED',
                message:String(eventError?.message??eventError)
            }
        };
    }
    return result;
}

export async function generateImportMap(options={}){
    const {workspaceRoot}=options??{};
    if(typeof workspaceRoot!=='string'||workspaceRoot.trim()===''){
        throw new TypeError('generateImportMap workspaceRoot must be a nonempty string.');
    }
    return generateImportMapUnlocked(options);
}

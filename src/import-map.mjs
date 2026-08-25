import {createHash,randomUUID} from 'node:crypto';
import {constants as FS_CONSTANTS} from 'node:fs';
import {lstat,mkdir,open,readdir,realpath,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {
    authenticateWorkspaceRuntimeReceipt,
    readVerifiedWorkspaceRuntimeFile
} from './workspace-runtime.mjs';
import {withWorkspaceOperationLock} from './workspace-operation-lock.mjs';

export const IMPORT_MAP_RELATIVE_PATH='modules/arcane.importmap.json';
export const MANAGED_IMPORT_MAP_ATTRIBUTE='data-arcane-import-map';

const JAVASCRIPT_EXTENSION=/\.(?:js|mjs)$/u;
const NODE_ONLY_MODULE='modules/CaseEvidenceIndexer.js';
const RUNTIME_STRONG_TYPE_IMPORT='../../node_modules/strong-type/index.js';
const SDK_BROWSER_ENTRY='sdk/event-manager.mjs';
const SDK_BROWSER_AI_ENTRY='sdk/ai/browser-wasm.mjs';
const SDK_BROWSER_FILES=Object.freeze([
    'sdk/ai/ARCANE_AI_BROWSER_WASM_COMPONENTS.json',
    'sdk/ai/browser-wasm-llm-provider.mjs',
    SDK_BROWSER_AI_ENTRY,
    'sdk/ai/browser-wllama-runtime.mjs',
    'sdk/ai/internal/sha256.mjs',
    'sdk/ai/model-controller.mjs',
    'sdk/ai/wllama/LICENCE',
    'sdk/ai/wllama/index.mjs',
    'sdk/ai/wllama/llama.cpp-LICENSE',
    'sdk/ai/wllama/wllama.wasm',
    SDK_BROWSER_ENTRY,
    'sdk/dom-event-instrumentation.mjs',
    'sdk/dependencies/event-pubsub/index.js',
    'sdk/dependencies/event-pubsub/licence',
    'sdk/dependencies/event-pubsub/package.json',
    'sdk/dependencies/strong-type/index.js',
    'sdk/dependencies/strong-type/licence',
    'sdk/dependencies/strong-type/package.json'
]);
const READ_ONLY_NO_FOLLOW=FS_CONSTANTS.O_RDONLY|(FS_CONSTANTS.O_NOFOLLOW??0);
const WRITE_NEW_NO_FOLLOW=FS_CONSTANTS.O_CREAT|FS_CONSTANTS.O_EXCL
    |FS_CONSTANTS.O_WRONLY|(FS_CONSTANTS.O_NOFOLLOW??0);
const SAFE_APP_ID=/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

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
    if(typeof onEvent==='function')await onEvent(Object.freeze(event));
}

function compareUtf8(left,right){
    return Buffer.compare(Buffer.from(String(left),'utf8'),Buffer.from(String(right),'utf8'));
}

function collisionKey(value){
    return value.normalize('NFC').toLowerCase();
}

function safeRelativePath(value,label='path'){
    if(typeof value!=='string'||!value||value.includes('\\')||value.includes('\0')
        ||path.posix.isAbsolute(value)||path.posix.normalize(value)!==value
        ||value==='.'||value.startsWith('../')||value.includes('/../')){
        fail(`Import-map ${label} is unsafe: ${String(value)}.`);
    }
    return value;
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
        if(character==='\\'){
            fail(
                `Import-map scan found an escaped JavaScript identifier at offset ${String(index)}. `
                +'Escaped identifiers are outside the deterministic import scanner subset.'
            );
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
    return Object.freeze({kind,specifier:token.value,offset:token.start});
}

function nonliteralDynamic(importer,offset){
    fail(
        `Import-map scan found a nonliteral dynamic import in "${importer}" at offset ${String(offset)}. `
        +'Replace import(expression) with a literal shipped specifier, then rerun arcane import-map.',
        'ARCANE_IMPORT_MAP_UNRESOLVED'
    );
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
                const close=matchingToken(tokens,index+1,'(',')');
                if(close<0)nonliteralDynamic(importer,current.start);
                const argument=tokens[index+2];
                const commas=topLevelCommas(tokens,index+2,close);
                const firstBoundary=commas[0]??close;
                if(argument?.type!=='string'||firstBoundary!==index+3
                    ||commas.length>2
                    ||(commas.length===2
                        &&(commas[1]!==close-1||commas[1]===commas[0]+1))){
                    nonliteralDynamic(importer,current.start);
                }
                hasModuleSyntax=true;
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
    return Object.freeze({
        hasModuleSyntax,
        imports:Object.freeze(imports)
    });
}

function stripQueryAndHash(specifier){
    const query=specifier.indexOf('?');
    const hash=specifier.indexOf('#');
    const end=Math.min(query<0?specifier.length:query,hash<0?specifier.length:hash);
    return specifier.slice(0,end);
}

function unresolved(importer,specifier,normalizedTarget,reason='is not in the shipped workspace runtime'){
    fail(
        `Import-map scan could not resolve "${specifier}" imported by "${importer}". `
        +`Normalized target: "${normalizedTarget}" ${reason}. `
        +'Materialize the authenticated dependency beneath workspace arcane/ or update the import '
        +'to a shipped JavaScript file, then rerun arcane import-map.',
        'ARCANE_IMPORT_MAP_UNRESOLVED'
    );
}

function resolveImport(importer,specifier,files){
    const reachableSpecifier=stripQueryAndHash(specifier);
    if(!reachableSpecifier)unresolved(importer,specifier,'<empty>');
    if(reachableSpecifier.includes('%')){
        unresolved(
            importer,
            specifier,
            reachableSpecifier,
            'contains percent-encoded path bytes whose browser URL normalization is outside the '
                +'deterministic shipped-runtime subset'
        );
    }
    if(reachableSpecifier===RUNTIME_STRONG_TYPE_IMPORT){
        const target='dependencies/strong-type/index.js';
        if(reachableSpecifier!==specifier){
            unresolved(
                importer,
                specifier,
                target,
                'uses a query or fragment that cannot match its exact browser import-map key'
            );
        }
        if(!files.has(target))unresolved(importer,specifier,target);
        return {target,runtimeStrongType:true};
    }
    if(reachableSpecifier==='event-pubsub'){
        const target='sdk/dependencies/event-pubsub/index.js';
        if(reachableSpecifier!==specifier){
            unresolved(
                importer,
                specifier,
                target,
                'uses a query or fragment that cannot match its exact browser import-map key'
            );
        }
        if(!files.has(target))unresolved(importer,specifier,target);
        return {target,eventPubSub:true};
    }
    if(/[\u0000-\u0020\u007f\\]/u.test(reachableSpecifier)||reachableSpecifier.includes('//')){
        unresolved(
            importer,
            specifier,
            reachableSpecifier,
            'contains browser-preprocessed control/space/backslash bytes or an empty path segment'
        );
    }
    if(!reachableSpecifier.startsWith('./')&&!reachableSpecifier.startsWith('../')){
        unresolved(importer,specifier,reachableSpecifier,'is not a supported shipped bare specifier');
    }
    const runtimePrefix='/__arcane_runtime__/';
    const runtimeOrigin='https://arcane.invalid';
    let resolved;
    try{
        resolved=new URL(
            reachableSpecifier,
            `${runtimeOrigin}${runtimePrefix}${importer}`
        );
    }catch{
        unresolved(importer,specifier,reachableSpecifier,'is not a valid browser-relative URL');
    }
    if(resolved.origin!==runtimeOrigin||!resolved.pathname.startsWith(runtimePrefix)){
        unresolved(importer,specifier,resolved.pathname,'escapes the shipped workspace runtime');
    }
    let target;
    try{target=decodeURIComponent(resolved.pathname.slice(runtimePrefix.length));}
    catch{
        unresolved(importer,specifier,resolved.pathname,'does not have a deterministic decoded URL path');
    }
    if(target==='.'||target.startsWith('../')||path.posix.isAbsolute(target)){
        unresolved(importer,specifier,target,'escapes the shipped workspace runtime');
    }
    if(!files.has(target))unresolved(importer,specifier,target);
    if(!JAVASCRIPT_EXTENSION.test(target)){
        unresolved(importer,specifier,target,'is not a JavaScript module');
    }
    return {target,strongType:false};
}

function registerSpecifier(registry,specifier,target){
    const key=collisionKey(specifier);
    const existing=registry.get(key);
    if(existing&&existing.specifier!==specifier||existing&&existing.target!==target){
        fail(
            `Import-map specifier collision: "${specifier}" (${target}) and `
            +`"${existing.specifier}" (${existing.target}) normalize to the same case/NFC key. `
            +'Rename one shipped module so every extensionless named specifier is unique.',
            'ARCANE_IMPORT_MAP_COLLISION'
        );
    }
    registry.set(key,{specifier,target});
}

function validateInventory(files){
    if(!Array.isArray(files))throw new TypeError('buildImportMap files must be an array.');
    const exact=new Set();
    const normalized=new Map();
    for(const value of [...files].sort(compareUtf8)){
        const relative=safeRelativePath(value,'runtime inventory path');
        if(/[%?#\u0000-\u0020\u007f]/u.test(relative)||relative.includes('//')){
            fail(
                `Import-map runtime inventory path is not browser-URL-safe: ${relative}. `
                +'Percent/delimiter bytes, control/space bytes, and empty path segments are not '
                +'allowed in authenticated runtime filenames.'
            );
        }
        if(exact.has(relative))fail(`Import-map runtime inventory repeats ${relative}.`);
        exact.add(relative);
        const key=collisionKey(relative);
        const prior=normalized.get(key);
        if(prior&&prior!==relative){
            fail(
                `Import-map runtime path collision: "${prior}" and "${relative}" normalize to `
                +'the same case/NFC path. Rename one shipped file before regenerating the map.',
                'ARCANE_IMPORT_MAP_COLLISION'
            );
        }
        normalized.set(key,relative);
    }
    return exact;
}

export async function buildImportMap({files,readFile,signal}={}){
    if(typeof readFile!=='function')throw new TypeError('buildImportMap readFile must be a function.');
    throwIfAborted(signal);
    const inventory=validateInventory(files);
    const candidates=[...inventory]
        .filter(relative=>relative.startsWith('modules/')
            &&!relative.slice('modules/'.length).includes('/')
            &&JAVASCRIPT_EXTENSION.test(relative))
        .sort(compareUtf8);
    const scans=new Map();
    async function scan(relative){
        throwIfAborted(signal);
        if(scans.has(relative))return scans.get(relative);
        const bytes=await readFile(relative);
        throwIfAborted(signal);
        const source=Buffer.isBuffer(bytes)||bytes instanceof Uint8Array
            ?Buffer.from(bytes).toString('utf8'):String(bytes);
        const result=scanModuleImports(source,{importer:relative});
        scans.set(relative,result);
        return result;
    }

    const roots=[];
    const excludedModules=[];
    for(const relative of candidates){
        const result=await scan(relative);
        if(!result.hasModuleSyntax)continue;
        if(relative===NODE_ONLY_MODULE){
            excludedModules.push(relative);
            continue;
        }
        roots.push(relative);
    }
    const hasSdkBrowserGraph=inventory.has(SDK_BROWSER_ENTRY);
    const hasSdkAiGraph=inventory.has(SDK_BROWSER_AI_ENTRY);
    if(hasSdkAiGraph&&!hasSdkBrowserGraph){
        unresolved(SDK_BROWSER_AI_ENTRY,'<authenticated SDK browser closure>',SDK_BROWSER_ENTRY);
    }
    if(hasSdkBrowserGraph){
        for(const required of SDK_BROWSER_FILES){
            if(!inventory.has(required)){
                unresolved(SDK_BROWSER_ENTRY,'<authenticated SDK browser closure>',required);
            }
        }
        for(const [packagePath,expectedName,expectedVersion] of [
            ['dependencies/strong-type/package.json','strong-type','1.1.0'],
            ['sdk/dependencies/event-pubsub/package.json','event-pubsub','6.1.0'],
            ['sdk/dependencies/strong-type/package.json','strong-type','2.0.0']
        ]){
            if(!inventory.has(packagePath)){
                unresolved(SDK_BROWSER_ENTRY,'<authenticated dependency identity>',packagePath);
            }
            let document;
            try{document=JSON.parse(Buffer.from(await readFile(packagePath)).toString('utf8'));}
            catch{
                unresolved(SDK_BROWSER_ENTRY,'<authenticated dependency identity>',packagePath,'is not valid package JSON');
            }
            if(document?.name!==expectedName||document?.version!==expectedVersion){
                unresolved(
                    SDK_BROWSER_ENTRY,
                    '<authenticated dependency identity>',
                    packagePath,
                    `must identify exactly as ${expectedName}@${expectedVersion}`
                );
            }
        }
    }

    const namedRegistry=new Map();
    for(const relative of roots){
        const name=path.posix.basename(relative).replace(JAVASCRIPT_EXTENSION,'');
        registerSpecifier(namedRegistry,`arcane/${name}`,`./arcane/${relative}`);
    }
    if(hasSdkBrowserGraph){
        registerSpecifier(
            namedRegistry,
            'arcane-os/event-manager',
            './arcane/sdk/event-manager.mjs'
        );
        if(hasSdkAiGraph){
            registerSpecifier(
                namedRegistry,
                'arcane-os/ai/browser-wasm',
                './arcane/sdk/ai/browser-wasm.mjs'
            );
        }
    }

    const sdkRoots=hasSdkBrowserGraph
        ?[SDK_BROWSER_ENTRY,...(hasSdkAiGraph?[SDK_BROWSER_AI_ENTRY]:[])]:[];
    const queue=[...roots,...sdkRoots];
    const reached=new Set();
    const entities=new Set();
    let usesRuntimeStrongType=false;
    let usesEventPubSub=false;
    while(queue.length>0){
        throwIfAborted(signal);
        const importer=queue.shift();
        if(reached.has(importer))continue;
        reached.add(importer);
        const result=await scan(importer);
        for(const imported of result.imports){
            const resolution=resolveImport(importer,imported.specifier,inventory);
            if(resolution.runtimeStrongType)usesRuntimeStrongType=true;
            if(resolution.eventPubSub)usesEventPubSub=true;
            if(resolution.target.startsWith('entities/'))entities.add(resolution.target);
            if(!reached.has(resolution.target))queue.push(resolution.target);
        }
    }

    for(const relative of [...entities].sort(compareUtf8)){
        const name=path.posix.basename(relative).replace(JAVASCRIPT_EXTENSION,'');
        registerSpecifier(namedRegistry,`arcane/entities/${name}`,`./arcane/${relative}`);
    }
    if(usesRuntimeStrongType){
        registerSpecifier(
            namedRegistry,
            './node_modules/strong-type/index.js',
            './arcane/dependencies/strong-type/index.js'
        );
    }
    if(usesEventPubSub){
        registerSpecifier(
            namedRegistry,
            'event-pubsub',
            './arcane/sdk/dependencies/event-pubsub/index.js'
        );
    }
    const imports={};
    for(const entry of [...namedRegistry.values()].sort((left,right)=>compareUtf8(left.specifier,right.specifier))){
        imports[entry.specifier]=entry.target;
    }
    return Object.freeze({
        imports:Object.freeze(imports),
        entryCount:Object.keys(imports).length,
        excludedModules:Object.freeze(excludedModules.sort(compareUtf8)),
        reachedFiles:Object.freeze([...reached].sort(compareUtf8))
    });
}

function sameFileIdentity(left,right){
    return left.dev===right.dev&&left.ino===right.ino&&left.size===right.size
        &&left.mtimeNs===right.mtimeNs&&left.ctimeNs===right.ctimeNs
        &&left.nlink===right.nlink;
}

function sameFileLocation(left,right){
    return left.dev===right.dev&&left.ino===right.ino;
}

function sha256(bytes){
    return createHash('sha256').update(bytes).digest('hex');
}

function pathInside(root,target){
    const relative=path.relative(root,target);
    return relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative));
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
    const files=[];
    async function visit(directory,relativeRoot=''){
        throwIfAborted(signal);
        const entries=await readdir(directory,{withFileTypes:true});
        entries.sort((left,right)=>compareUtf8(left.name,right.name));
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
    return {
        files,
        async readFile(relative){
            throwIfAborted(signal);
            safeRelativePath(relative,'runtime read path');
            const absolute=path.resolve(canonicalRoot,...relative.split('/'));
            if(!pathInside(canonicalRoot,absolute))fail(`Import-map runtime read escapes arcane/: ${relative}.`);
            const before=await lstat(absolute,{bigint:true});
            if(before.isSymbolicLink()||!before.isFile()){
                fail(`Workspace Arcane runtime module is not a real file: ${relative}.`);
            }
            let handle;
            try{handle=await open(absolute,READ_ONLY_NO_FOLLOW);}
            catch(error){
                if(error?.code==='ELOOP')fail(`Workspace Arcane runtime module became a symlink: ${relative}.`);
                throw error;
            }
            try{
                const opened=await handle.stat({bigint:true});
                if(!sameFileIdentity(before,opened)){
                    fail(`Workspace Arcane runtime module changed while opening: ${relative}.`);
                }
                const bytes=await handle.readFile();
                const after=await handle.stat({bigint:true});
                if(!sameFileIdentity(opened,after)){
                    fail(`Workspace Arcane runtime module changed while reading: ${relative}.`);
                }
                const canonicalFile=await realpath(absolute);
                if(!pathInside(canonicalRoot,canonicalFile)){
                    fail(`Workspace Arcane runtime module left its root: ${relative}.`);
                }
                return bytes;
            }finally{
                await handle.close();
            }
        }
    };
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

const RAW_TEXT_ELEMENTS=new Set(['iframe','noembed','noframes','script','style','xmp']);
const RCDATA_ELEMENTS=new Set(['textarea','title']);
const TEXT_ELEMENTS=new Set([...RAW_TEXT_ELEMENTS,...RCDATA_ELEMENTS]);

function rawElementEnd(html,tag,openEnd){
    const closePattern=new RegExp(`<\\/${tag}(?=[\\t\\n\\f\\r />]|$)`,'gi');
    closePattern.lastIndex=openEnd;
    const close=closePattern.exec(html);
    if(tag==='script'){
        const escapedStart=html.indexOf('<!--',openEnd);
        if(escapedStart>=0&&(!close||escapedStart<close.index)){
            fail(
                'Application HTML contains legacy escaped script syntax, which is outside the '
                +'deterministic import-map HTML subset.'
            );
        }
    }
    if(!close)return {end:html.length,closed:false};
    const end=htmlTagEnd(html,close.index+close[0].length);
    const closeTag=html.slice(close.index,end);
    if(!new RegExp(`^<\\/${tag}[\\t\\n\\f\\r ]*>$`,'i').test(closeTag)){
        fail(`Application HTML contains a malformed </${tag}> end tag.`);
    }
    return {end,closed:true};
}

function commentEnd(html,start){
    if(html.startsWith('<!-->',start)||html.startsWith('<!--->',start)){
        fail('Application HTML contains an abrupt comment close outside the deterministic subset.');
    }
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

function rejectDeclarativeShadowTemplate(open){
    const attributes=parseTagAttributes(open);
    if(!attributes.has('shadowrootmode'))return;
    structuralAttribute(attributes,'shadowrootmode','template');
    fail(
        'Application HTML contains declarative shadow DOM, whose connected module loads are '
        +'outside the deterministic import-map HTML subset.'
    );
}

function selectElementEnd(html,openEnd){
    let cursor=openEnd;
    const elements=[];
    while(cursor<html.length){
        const start=html.indexOf('<',cursor);
        if(start<0){
            fail('Application HTML contains an unterminated <select> element.');
        }
        if(html.startsWith('<!--',start)){
            cursor=commentEnd(html,start);
            continue;
        }
        if(html.startsWith('<!',start)||html.startsWith('<?',start)){
            fail('Application HTML select contains an unsupported declaration or processing instruction.');
        }
        const head=htmlTagHead(html,start);
        if(!head){
            if(html.startsWith('</',start)||/^<[A-Za-z]/u.test(html.slice(start))){
                fail('Application HTML select contains a malformed tag.');
            }
            cursor=start+1;
            continue;
        }
        const name=htmlTagName(head[1]);
        const end=htmlTagEnd(html,start+head[0].length);
        const closing=html[start+1]==='/';
        if(closing)validateEndTag(html.slice(start,end),name);
        if(name==='frame'||name==='frameset'){
            fail(`Application HTML contains unsupported structural element <${name}>.`);
        }
        if(name==='select'){
            if(!closing){
                fail('Application HTML contains a nested <select> element.');
            }
            if(elements.length>0){
                fail(`Application HTML closes <select> before </${elements.at(-1)}> is present.`);
            }
            return end;
        }
        if(name!=='option'&&name!=='optgroup'){
            fail(
                `Application HTML select contains unsupported <${closing?'/':''}${name}> markup. `
                +'Only text, comments, option, and optgroup are accepted inside select.'
            );
        }
        if(closing){
            if(elements.at(-1)!==name){
                fail(`Application HTML select contains an unmatched </${name}> end tag.`);
            }
            elements.pop();
        }else{
            if(name==='optgroup'&&elements.length>0){
                fail('Application HTML select contains a nested or option-contained <optgroup>.');
            }
            if(name==='option'&&elements.at(-1)==='option'){
                fail('Application HTML select contains nested <option> elements.');
            }
            elements.push(name);
        }
        cursor=end;
    }
    fail('Application HTML contains an unterminated <select> element.');
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
            fail('Application HTML template contains an unsupported declaration or processing instruction.');
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
        if(name==='frame'||name==='frameset'){
            fail(`Application HTML contains unsupported structural element <${name}>.`);
        }
        if(name==='select'){
            if(closing)fail('Application HTML contains an unmatched </select> end tag.');
            cursor=selectElementEnd(html,end);
            continue;
        }
        if(name==='svg'||name==='math'){
            fail(`Application HTML contains unsupported foreign-content element <${name}>.`);
        }
        if(!closing&&name==='noscript'){
            fail('Application HTML contains <noscript>, whose active parsing depends on browser mode.');
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
        if(!closing)rejectDeclarativeShadowTemplate(html.slice(start,end));
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
    let sawDoctype=false;
    while(cursor<html.length){
        const start=html.indexOf('<',cursor);
        if(start<0)break;
        if(html.startsWith('<!--',start)){
            cursor=commentEnd(html,start);
            continue;
        }
        if(html.startsWith('<!',start)){
            const end=htmlTagEnd(html,start+2);
            const declaration=html.slice(start,end);
            if(!/^<!doctype[\t\n\f\r ]+html[\t\n\f\r ]*>$/i.test(declaration)
                ||sawDoctype
                ||!/^(?:\ufeff)?[\t\n\f\r ]*$/u.test(html.slice(0,start))){
                fail('Application HTML contains an unsupported or misplaced declaration.');
            }
            sawDoctype=true;
            cursor=end;
            continue;
        }
        if(html.startsWith('<?',start)){
            fail('Application HTML contains an unsupported processing instruction.');
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
        if(tag==='frame'||tag==='frameset'){
            fail(`Application HTML contains unsupported structural element <${tag}>.`);
        }
        if(tag==='select'){
            if(closing)fail('Application HTML contains an unmatched </select> end tag.');
            cursor=selectElementEnd(html,openEnd);
            continue;
        }
        if(tag==='svg'||tag==='math'){
            fail(`Application HTML contains unsupported foreign-content element <${tag}>.`);
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
            rejectDeclarativeShadowTemplate(open);
            cursor=nestedTemplateEnd(html,openEnd);
            continue;
        }
        if(tag==='noscript'){
            fail('Application HTML contains <noscript>, whose active parsing depends on browser mode.');
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
    const bases=structure.bases.map(base=>Object.freeze({
        start:base.start,
        end:base.end,
        href:structuralAttribute(parseTagAttributes(base.open),'href','base')
    }));
    const managedMaps=structure.scripts.filter(script=>{
        const attributes=parseTagAttributes(script.open);
        return attributes.has(MANAGED_IMPORT_MAP_ATTRIBUTE)
            &&scriptType(attributes)==='importmap';
    }).map(script=>Object.freeze({start:script.start,end:script.end}));
    const scripts=structure.scripts.map(script=>{
        const attributes=parseTagAttributes(script.open);
        return Object.freeze({
            start:script.start,
            end:script.end,
            type:scriptType(attributes),
            src:structuralAttribute(attributes,'src','script'),
            managed:attributes.has(MANAGED_IMPORT_MAP_ATTRIBUTE)
        });
    });
    const links=structure.links.map(link=>{
        const attributes=parseTagAttributes(link.open);
        return Object.freeze({
            start:link.start,
            end:link.end,
            rel:canonicalHtmlToken(structuralAttribute(attributes,'rel','link')),
            href:structuralAttribute(attributes,'href','link')
        });
    });
    const metas=structure.metas.map(meta=>{
        const attributes=parseTagAttributes(meta.open);
        return Object.freeze({
            start:meta.start,
            end:meta.end,
            name:canonicalHtmlToken(structuralAttribute(attributes,'name','meta')),
            content:structuralAttribute(attributes,'content','meta')
        });
    });
    return Object.freeze({
        bases:Object.freeze(bases),
        managedMaps:Object.freeze(managedMaps),
        scripts:Object.freeze(scripts),
        links:Object.freeze(links),
        metas:Object.freeze(metas),
        firstModulePosition:firstModulePosition(source)
    });
}

function renderManagedHtml(html,json){
    const structure=scanHtmlStructure(html);
    const activeBases=structure.bases.map(base=>({
        ...base,
        href:structuralAttribute(parseTagAttributes(base.open),'href','base')
    }));
    if(activeBases.length!==1||activeBases[0].href!=='../../'){
        fail('Application HTML must contain exactly one active <base href="../../"> element.');
    }
    const complete=[];
    for(const script of structure.scripts){
        const attributes=parseTagAttributes(script.open);
        if(attributes.has(MANAGED_IMPORT_MAP_ATTRIBUTE)){
            if(scriptType(attributes)!=='importmap'){
                fail(`Managed ${MANAGED_IMPORT_MAP_ATTRIBUTE} script must use type="importmap".`);
            }
            if(!script.closed){
                fail(`Application HTML contains an unterminated ${MANAGED_IMPORT_MAP_ATTRIBUTE} script.`);
            }
            complete.push({start:script.start,end:script.end});
        }else if(scriptType(attributes)==='importmap'){
            fail(
                `Application HTML already contains an unmanaged import map. Remove it or add `
                +`${MANAGED_IMPORT_MAP_ATTRIBUTE}, then rerun arcane import-map.`
            );
        }
    }
    if(complete.length>1){
        fail(`Application HTML contains multiple ${MANAGED_IMPORT_MAP_ATTRIBUTE} scripts.`);
    }
    const withoutManaged=removeManagedBlocks(html,complete);
    const cleanedStructure=scanHtmlStructure(withoutManaged);
    const cleanedBases=cleanedStructure.bases.map(base=>({
        ...base,
        href:structuralAttribute(parseTagAttributes(base.open),'href','base')
    }));
    if(cleanedBases.length!==1||cleanedBases[0].href!=='../../'){
        fail('Application HTML must retain exactly one active <base href="../../"> element.');
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
    if(renderedBases.length!==1||renderedBases[0].href!=='../../'
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

async function readRealFile(filePath,label){
    const state=await readRealFileState(filePath,label);
    return state.bytes;
}

async function readRealFileState(filePath,label,{optional=false}={}){
    let info;
    try{info=await lstat(filePath,{bigint:true});}
    catch(error){
        if(optional&&error?.code==='ENOENT')return {exists:false,filePath};
        throw error;
    }
    if(info.isSymbolicLink()||!info.isFile())fail(`${label} must be a real file: ${filePath}.`);
    const handle=await open(filePath,READ_ONLY_NO_FOLLOW);
    try{
        const opened=await handle.stat({bigint:true});
        if(!sameFileIdentity(info,opened))fail(`${label} changed while opening: ${filePath}.`);
        const bytes=await handle.readFile();
        const after=await handle.stat({bigint:true});
        if(!sameFileIdentity(opened,after))fail(`${label} changed while reading: ${filePath}.`);
        return {exists:true,filePath,bytes,identity:after};
    }finally{
        await handle.close();
    }
}

async function captureDirectoryState(root,directory,{create=false}={}){
    const resolvedRoot=path.resolve(root);
    const resolvedDirectory=path.resolve(directory);
    if(!pathInside(resolvedRoot,resolvedDirectory)){
        fail(`Import-map directory escapes its application root: ${resolvedDirectory}.`);
    }
    const rootInfo=await lstat(resolvedRoot,{bigint:true});
    if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()){
        fail(`Import-map application root must be a real directory: ${resolvedRoot}.`);
    }
    const canonicalRoot=await realpath(resolvedRoot);
    const canonicalRootInfo=await lstat(canonicalRoot,{bigint:true});
    if(canonicalRootInfo.isSymbolicLink()||!canonicalRootInfo.isDirectory()
        ||!sameDirectoryIdentity(rootInfo,canonicalRootInfo)){
        fail(`Import-map application root changed while authenticating: ${resolvedRoot}.`);
    }
    const entries=[{location:resolvedRoot,identity:canonicalRootInfo,canonical:canonicalRoot}];
    const relative=path.relative(resolvedRoot,resolvedDirectory);
    let current=resolvedRoot;
    let parent=entries[0];
    for(const part of relative.split(path.sep).filter(Boolean)){
        const parentBefore=await lstat(parent.location,{bigint:true});
        if(parentBefore.isSymbolicLink()||!parentBefore.isDirectory()
            ||!sameDirectoryIdentity(parentBefore,parent.identity)
            ||await realpath(parent.location)!==parent.canonical){
            fail(`Import-map directory changed before creating a child: ${parent.location}.`);
        }
        const child=path.join(current,part);
        if(create){
            try{await mkdir(child);}
            catch(error){if(error?.code!=='EEXIST')throw error;}
        }
        const info=await lstat(child,{bigint:true});
        if(info.isSymbolicLink()||!info.isDirectory()){
            fail(`Import-map directory must be a real directory: ${child}.`);
        }
        const canonical=await realpath(child);
        if(!pathInside(canonicalRoot,canonical)||path.dirname(canonical)!==parent.canonical){
            fail(`Import-map directory resolves outside its application root: ${child}.`);
        }
        const parentAfter=await lstat(parent.location,{bigint:true});
        if(parentAfter.isSymbolicLink()||!parentAfter.isDirectory()
            ||!sameDirectoryIdentity(parentAfter,parent.identity)
            ||await realpath(parent.location)!==parent.canonical){
            fail(`Import-map directory changed while creating a child: ${parent.location}.`);
        }
        const entry={location:child,identity:info,canonical};
        entries.push(entry);
        current=child;
        parent=entry;
    }
    return {root:resolvedRoot,directory:resolvedDirectory,entries};
}

function sameDirectoryIdentity(left,right){
    return left.isDirectory()&&right.isDirectory()&&left.dev===right.dev&&left.ino===right.ino;
}

async function assertDirectoryState(state){
    for(const entry of state.entries){
        const info=await lstat(entry.location,{bigint:true});
        if(info.isSymbolicLink()||!info.isDirectory()
            ||!sameDirectoryIdentity(info,entry.identity)
            ||await realpath(entry.location)!==entry.canonical){
            fail(`Import-map directory changed during generation: ${entry.location}.`);
        }
    }
}

async function stageSibling(filePath,bytes,directoryState){
    await assertDirectoryState(directoryState);
    const staged=path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.arcane-stage-${String(process.pid)}-${randomUUID()}`
    );
    const content=Buffer.from(bytes);
    let handle;
    let ownedIdentity;
    try{
        handle=await open(staged,WRITE_NEW_NO_FOLLOW,0o644);
        ownedIdentity=await handle.stat({bigint:true});
        await assertDirectoryState(directoryState);
        await handle.writeFile(content);
        await handle.sync();
        await handle.close();
        handle=null;
        await assertDirectoryState(directoryState);
        const identity=await lstat(staged,{bigint:true});
        if(identity.isSymbolicLink()||!identity.isFile()
            ||!sameFileLocation(identity,ownedIdentity)){
            fail(`Import-map staged file changed while it was written: ${staged}.`);
        }
        return {
            path:staged,
            identity,
            directoryState,
            byteLength:content.length,
            hash:sha256(content)
        };
    }catch(error){
        try{await handle?.close();}
        catch(cleanupError){error.cleanupError??=cleanupError;}
        if(ownedIdentity){
            try{
                const removed=await removeOwnedPath(staged,ownedIdentity,directoryState);
                if(!removed)fail(`Import-map staged file could not be safely cleaned: ${staged}.`);
            }catch(cleanupError){error.cleanupError??=cleanupError;}
        }
        throw error;
    }
}

async function removeOwnedPath(filePath,identity,directoryState){
    try{await assertDirectoryState(directoryState);}
    catch{return false;}
    let current;
    try{current=await lstat(filePath,{bigint:true});}
    catch(error){
        if(error?.code==='ENOENT')return true;
        throw error;
    }
    if(current.isSymbolicLink()||!current.isFile()||!sameFileLocation(current,identity))return false;
    await rm(filePath);
    return true;
}

async function verifiedFileAt(filePath,expected,label,{strictIdentity=true}={}){
    await assertDirectoryState(expected.directoryState);
    const before=await lstat(filePath,{bigint:true});
    if(before.isSymbolicLink()||!before.isFile()
        ||!sameFileLocation(before,expected.identity)
        ||strictIdentity&&!sameFileIdentity(before,expected.identity)){
        fail(`${label} changed before promotion.`);
    }
    let handle;
    try{handle=await open(filePath,READ_ONLY_NO_FOLLOW);}
    catch(error){
        if(error?.code==='ELOOP')fail(`${label} became a symbolic link before promotion.`);
        throw error;
    }
    let after;
    try{
        const opened=await handle.stat({bigint:true});
        if(!sameFileIdentity(before,opened))fail(`${label} changed while opening.`);
        const bytes=await handle.readFile();
        after=await handle.stat({bigint:true});
        if(!sameFileIdentity(opened,after)||bytes.length!==expected.byteLength
            ||sha256(bytes)!==expected.hash){
            fail(`${label} failed its identity or content check before promotion.`);
        }
    }finally{
        await handle.close();
    }
    const current=await lstat(filePath,{bigint:true});
    if(current.isSymbolicLink()||!current.isFile()||!sameFileIdentity(current,after)){
        fail(`${label} changed after verification.`);
    }
    await assertDirectoryState(expected.directoryState);
    return current;
}

function originalDescriptor(state){
    return {
        identity:state.identity,
        directoryState:state.directoryState,
        byteLength:state.bytes.length,
        hash:sha256(state.bytes)
    };
}

async function pathIsAbsent(filePath){
    try{
        await lstat(filePath);
        return false;
    }catch(error){
        if(error?.code==='ENOENT')return true;
        throw error;
    }
}

async function restoreBackup(state,backup,label){
    const expected=originalDescriptor(state);
    await assertDirectoryState(state.directoryState);
    if(!await pathIsAbsent(state.filePath)){
        fail(`${label} changed before its import-map backup could be restored.`);
    }
    await verifiedFileAt(backup,expected,`${label} backup`,{strictIdentity:false});
    await rename(backup,state.filePath);
    await verifiedFileAt(state.filePath,expected,`${label} restored file`,{strictIdentity:false});
}

async function pathStateUnchanged(state,label){
    if(!state.exists){
        try{
            await lstat(state.filePath);
            fail(`${label} appeared while the import map was being generated.`);
        }catch(error){
            if(error?.code!=='ENOENT')throw error;
        }
        return;
    }
    const current=await lstat(state.filePath,{bigint:true});
    if(current.isSymbolicLink()||!current.isFile()||!sameFileIdentity(current,state.identity)){
        fail(`${label} changed while the import map was being generated.`);
    }
}

async function installStagedFile(state,staged,label){
    const backup=path.join(
        path.dirname(state.filePath),
        `.${path.basename(state.filePath)}.arcane-backup-${String(process.pid)}-${randomUUID()}`
    );
    let backedUp=false;
    let promoted=false;
    let installedIdentity=null;
    try{
        await assertDirectoryState(staged.directoryState);
        await pathStateUnchanged(state,label);
        await verifiedFileAt(staged.path,staged,`${label} staged file`);
        if(state.exists){
            await rename(state.filePath,backup);
            backedUp=true;
            await verifiedFileAt(
                backup,
                originalDescriptor(state),
                `${label} backup`,
                {strictIdentity:false}
            );
        }
        await verifiedFileAt(staged.path,staged,`${label} staged file`);
        await rename(staged.path,state.filePath);
        promoted=true;
        installedIdentity=await verifiedFileAt(
            state.filePath,
            staged,
            `${label} installed file`,
            {strictIdentity:false}
        );
        await assertDirectoryState(staged.directoryState);
    }catch(error){
        if(promoted){
            try{
                const removed=await removeOwnedPath(
                    state.filePath,
                    installedIdentity??staged.identity,
                    staged.directoryState
                );
                if(!removed)fail(`${label} changed before its failed promotion could be removed.`);
            }catch(rollbackError){error.rollbackError??=rollbackError;}
        }
        if(backedUp){
            try{await restoreBackup(state,backup,label);}
            catch(rollbackError){error.rollbackError??=rollbackError;}
        }
        throw error;
    }
    return {
        async verify(){
            if(!installedIdentity)fail(`${label} was not installed before pair verification.`);
            return verifiedFileAt(
                state.filePath,
                {
                    identity:installedIdentity,
                    directoryState:staged.directoryState,
                    byteLength:staged.byteLength,
                    hash:staged.hash
                },
                `${label} committed file`
            );
        },
        async commit(){
            if(!backedUp)return;
            const removed=await removeOwnedPath(backup,state.identity,staged.directoryState);
            if(!removed)fail(`${label} backup changed before transaction cleanup.`);
        },
        async rollback(){
            await assertDirectoryState(staged.directoryState);
            if(!await pathIsAbsent(state.filePath)){
                const removed=await removeOwnedPath(
                    state.filePath,
                    installedIdentity,
                    staged.directoryState
                );
                if(!removed){
                    fail(`${label} changed before its import-map transaction could roll back.`);
                }
            }
            if(backedUp)await restoreBackup(state,backup,label);
        }
    };
}

async function commitGeneratedPair({
    artifactState,
    entryState,
    artifactBytes,
    entryBytes,
    signal,
    onEvent
}){
    const artifactStage=await stageSibling(
        artifactState.filePath,
        artifactBytes,
        artifactState.directoryState
    );
    let entryStage;
    let artifactInstall;
    let entryInstall;
    let failure;
    try{
        entryStage=await stageSibling(
            entryState.filePath,
            entryBytes,
            entryState.directoryState
        );
        await emit(onEvent,{type:'import-map.commit.staged'});
        throwIfAborted(signal);
        artifactInstall=await installStagedFile(
            artifactState,
            artifactStage,
            'Import-map artifact'
        );
        entryInstall=await installStagedFile(entryState,entryStage,'Import-map application entry');
        await artifactInstall.verify();
        await entryInstall.verify();
        await emit(onEvent,{
            type:'import-map.commit.progress',
            paths:Object.freeze([artifactState.filePath,entryState.filePath])
        });
        throwIfAborted(signal);
        await artifactInstall.verify();
        await entryInstall.verify();
    }catch(error){
        if(entryInstall)await entryInstall.rollback().catch(rollback=>{error.rollbackError??=rollback;});
        if(artifactInstall){
            await artifactInstall.rollback().catch(rollback=>{error.rollbackError??=rollback;});
        }
        failure=error;
    }
    const cleanupErrors=[];
    if(!artifactInstall){
        try{
            const removed=await removeOwnedPath(
                artifactStage.path,
                artifactStage.identity,
                artifactStage.directoryState
            );
            if(!removed)fail(`Import-map artifact stage could not be safely cleaned: ${artifactStage.path}.`);
        }catch(error){cleanupErrors.push(error);}
    }
    if(entryStage&&!entryInstall){
        try{
            const removed=await removeOwnedPath(
                entryStage.path,
                entryStage.identity,
                entryStage.directoryState
            );
            if(!removed){
                fail(`Import-map application-entry stage could not be safely cleaned: ${entryStage.path}.`);
            }
        }catch(error){cleanupErrors.push(error);}
    }
    if(failure){
        if(cleanupErrors.length>0){
            failure.cleanupError??=cleanupErrors.length===1
                ?cleanupErrors[0]
                :new AggregateError(cleanupErrors,'Import-map transaction cleanup failed.');
        }
        throw failure;
    }
    if(cleanupErrors.length>0){
        throw new AggregateError(cleanupErrors,'Import-map transaction cleanup failed.');
    }

    const cleanupWarnings=[];
    for(const installed of [entryInstall,artifactInstall]){
        try{await installed.commit();}
        catch(error){cleanupWarnings.push(error);}
    }
    await artifactInstall.verify();
    await entryInstall.verify();
    if(cleanupWarnings.length>0){
        return Object.freeze(cleanupWarnings.map(error=>String(error?.message??error)));
    }
    return Object.freeze([]);
}

function resolvedAppRoot(workspaceRoot,appId,appRoot){
    if(!SAFE_APP_ID.test(appId??'')){
        fail(`Import-map app id must use lowercase letters, digits, and internal hyphens: ${String(appId)}.`);
    }
    const resolved=path.resolve(appRoot??path.join(workspaceRoot,'apps',appId));
    if(!pathInside(workspaceRoot,resolved))fail('Import-map application root must stay inside the workspace.');
    return resolved;
}

async function generateImportMapUnlocked({
    workspaceRoot,
    appId,
    appRoot,
    entry='index.html',
    workspaceRuntimeReceipt,
    signal,
    onEvent
}={}){
    if(typeof workspaceRoot!=='string'||workspaceRoot.trim()===''){
        throw new TypeError('generateImportMap workspaceRoot must be a nonempty string.');
    }
    throwIfAborted(signal);
    const resolvedWorkspace=path.resolve(workspaceRoot);
    const resolvedApp=resolvedAppRoot(resolvedWorkspace,appId,appRoot);
    const safeEntry=safeRelativePath(entry,'application entry');
    const entryPath=path.resolve(resolvedApp,...safeEntry.split('/'));
    if(!pathInside(resolvedApp,entryPath))fail('Import-map application entry escapes its app root.');
    const artifactPath=path.join(resolvedApp,...IMPORT_MAP_RELATIVE_PATH.split('/'));
    await emit(onEvent,{type:'import-map.started',appId,artifactPath,entryPath});

    const entryDirectoryState=await captureDirectoryState(
        resolvedWorkspace,
        path.dirname(entryPath)
    );
    const entryState=await readRealFileState(entryPath,'Import-map application entry');
    entryState.directoryState=entryDirectoryState;
    const html=entryState.bytes.toString('utf8');
    // Reject malformed application structure before traversing the substantially larger runtime
    // graph. The real generated map is rendered and revalidated again before commit.
    renderManagedHtml(html,'{"imports":{}}\n');
    let runtime;
    if(workspaceRuntimeReceipt){
        await authenticateWorkspaceRuntimeReceipt(workspaceRuntimeReceipt,{
            workspaceRoot:resolvedWorkspace,
            signal
        });
        runtime={
            files:workspaceRuntimeReceipt.files.map(file=>file.path),
            readFile:relativePath=>readVerifiedWorkspaceRuntimeFile(workspaceRuntimeReceipt,{
                workspaceRoot:resolvedWorkspace,
                relativePath,
                signal
            })
        };
    }else{
        runtime=await physicalRuntime(resolvedWorkspace,signal);
    }
    for(const required of SDK_BROWSER_FILES){
        if(!runtime.files.includes(required)){
            fail(
                `Workspace Arcane runtime is missing the authenticated SDK browser file `
                +`"${required}". Materialize the current SDK runtime, then rerun arcane import-map.`,
                'ARCANE_IMPORT_MAP_UNRESOLVED'
            );
        }
    }
    const built=await buildImportMap({files:runtime.files,readFile:runtime.readFile,signal});
    const document={imports:built.imports};
    const json=`${JSON.stringify(document,null,2).replaceAll('<','\\u003c')}\n`;
    const renderedHtml=renderManagedHtml(html,json);

    throwIfAborted(signal);
    const artifactDirectoryState=await captureDirectoryState(
        resolvedWorkspace,
        path.dirname(artifactPath),
        {create:true}
    );
    const artifactState=await readRealFileState(
        artifactPath,
        'Import-map artifact',
        {optional:true}
    );
    artifactState.directoryState=artifactDirectoryState;
    const cleanupWarnings=await commitGeneratedPair({
        artifactState,
        entryState,
        artifactBytes:Buffer.from(json,'utf8'),
        entryBytes:Buffer.from(renderedHtml,'utf8'),
        signal,
        onEvent
    });
    const committedFiles=Object.freeze([
        Object.freeze({
            role:'artifact',
            path:path.relative(resolvedWorkspace,artifactPath).split(path.sep).join('/'),
            bytes:Buffer.byteLength(json,'utf8'),
            sha256:sha256(Buffer.from(json,'utf8'))
        }),
        Object.freeze({
            role:'entry',
            path:path.relative(resolvedWorkspace,entryPath).split(path.sep).join('/'),
            bytes:Buffer.byteLength(renderedHtml,'utf8'),
            sha256:sha256(Buffer.from(renderedHtml,'utf8'))
        })
    ]);
    const receipt=Object.freeze({
        appId,
        artifactPath,
        artifactRelativePath:path.relative(resolvedWorkspace,artifactPath).split(path.sep).join('/'),
        entryPath,
        imports:built.imports,
        entryCount:built.entryCount,
        excludedModules:built.excludedModules,
        files:committedFiles,
        cleanupWarnings,
        committed:true
    });
    try{
        await emit(onEvent,{
            type:'import-map.completed',
            appId,
            artifactPath,
            entryPath,
            entryCount:receipt.entryCount,
            cleanupWarnings:receipt.cleanupWarnings,
            committed:true
        });
    }catch(error){
        return Object.freeze({
            ...receipt,
            eventDelivery:Object.freeze({
                status:'degraded',
                errorCode:'ARCANE_EVENT_DELIVERY_FAILED',
                message:String(error?.message??error)
            })
        });
    }
    return receipt;
}

export async function generateImportMap(options={}){
    const {
        workspaceRoot,
        signal,
        onEvent,
        workspaceOperationLease
    }=options??{};
    if(typeof workspaceRoot!=='string'||workspaceRoot.trim()===''){
        throw new TypeError('generateImportMap workspaceRoot must be a nonempty string.');
    }
    return withWorkspaceOperationLock({
        workspaceRoot,
        operation:'import-map',
        signal,
        onEvent,
        workspaceOperationLease
    },()=>generateImportMapUnlocked(options));
}

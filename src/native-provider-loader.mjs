import crypto from 'node:crypto';
import {lstat,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ArcaneError,ERROR_CODES,throwIfAborted} from './errors.mjs';
import {validateNativeBuilder} from './native-plan.mjs';

const PROVIDER_ROOT=Object.freeze([
    'machine_bundles',
    'arcane-os-machine-bundle',
    'tools'
]);

function providerPath(fileName){
    return Object.freeze([...PROVIDER_ROOT,fileName]);
}

const linuxProviderPath=providerPath('linux-native-provider.mjs');

export const ARCANE_NATIVE_PROVIDER_PATHS=Object.freeze({
    portable:providerPath('portable-native-provider.mjs'),
    'windows-x64':providerPath('windows-native-provider.mjs'),
    'linux-x64':linuxProviderPath,
    'linux-arm64':linuxProviderPath,
    'android-arm64':providerPath('android-native-provider.mjs')
});

export const ARCANE_PORTABLE_PROVIDER_PATH=ARCANE_NATIVE_PROVIDER_PATHS.portable;

const PROVIDER_GENERATION_CODE='ARCANE_NATIVE_PROVIDER_RESTART_REQUIRED';
const PROVIDER_CLOSURE_CODE='ARCANE_NATIVE_PROVIDER_CLOSURE_INVALID';
const MAX_PROVIDER_MODULES=128;
const MAX_PROVIDER_DEPTH=32;
const MAX_PROVIDER_IMPORTS=1024;
const MAX_PROVIDER_MODULE_BYTES=4*1024*1024;
const MAX_PROVIDER_CLOSURE_BYTES=32*1024*1024;
const PROCESS_PROVIDER_STATE=Symbol.for('arcane-os-sdk.native-provider-state.v1');
if(!globalThis[PROCESS_PROVIDER_STATE]){
    Object.defineProperty(globalThis,PROCESS_PROVIDER_STATE,{
        value:Object.freeze({
            providerGenerations:new Map(),
            moduleGenerations:new Map()
        }),
        configurable:false,
        enumerable:false,
        writable:false
    });
}
const providerGenerationCache=globalThis[PROCESS_PROVIDER_STATE].providerGenerations;
const processModuleGenerations=globalThis[PROCESS_PROVIDER_STATE].moduleGenerations;
const utf8Decoder=new TextDecoder('utf-8',{fatal:true});
const REGEX_PREFIX_IDENTIFIERS=new Set([
    'await','case','delete','do','else','in','instanceof','new','of','return',
    'throw','typeof','void','yield'
]);
const REGEX_PREFIX_PUNCTUATORS=new Set([
    '(','[','{',',',';',':','=','==','===','!=','!==','!','?','&&','||','??',
    '+','-','*','%','&','|','^','~','<','>','<=','>=','=>'
]);
const MULTI_PUNCTUATORS=new Set([
    '>>>=','===','!==','>>>','**=','&&=','||=','??=','=>','==','!=','<=','>=',
    '++','--','&&','||','??','**','<<','>>','+=','-=','*=','/=','%=','&=','|=','^=',
    '?.','...'
]);

function fail(message,details){
    throw new ArcaneError(ERROR_CODES.targetUnavailable,message,{details});
}

function samePath(left,right){
    const normalize=value=>process.platform==='win32'
        ?path.normalize(value).toLowerCase()
        :path.normalize(value);
    return normalize(left)===normalize(right);
}

function pathKey(value){
    const normalized=path.normalize(value);
    return process.platform==='win32'?normalized.toLowerCase():normalized;
}

function insideRoot(root,candidate){
    const relative=path.relative(root,candidate);
    return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));
}

async function assertUnlinkedDirectoryAncestors(location,inspect){
    const resolved=path.resolve(location);
    const parsed=path.parse(resolved);
    const relative=resolved.slice(parsed.root.length);
    let current=parsed.root;
    const components=relative.split(path.sep).filter(Boolean);
    for(let index=0;index<components.length-1;index+=1){
        current=path.join(current,components[index]);
        const info=await inspect(current);
        if(info.isSymbolicLink()||!info.isDirectory()){
            fail('The Arcane OS checkout root must not use a linked or non-directory ancestor.',{
                arcaneRoot:resolved,
                ancestor:current
            });
        }
    }
}

function closureFailure(message,details){
    throw new ArcaneError(PROVIDER_CLOSURE_CODE,message,{details});
}

function restartRequired(target,details){
    throw new ArcaneError(
        PROVIDER_GENERATION_CODE,
        `The Arcane ${target} provider module generation changed in this process. Restart the Arcane SDK process before pairing this provider again.`,
        {details}
    );
}

function sha256(value){
    return crypto.createHash('sha256').update(value).digest('hex');
}

function identityValue(value){
    if(typeof value==='bigint')return value.toString(10);
    if(typeof value==='number'&&Number.isFinite(value))return String(value);
    return null;
}

function filesystemIdentity(info){
    return Object.freeze({
        device:identityValue(info.dev),
        inode:identityValue(info.ino),
        mode:identityValue(info.mode),
        links:identityValue(info.nlink),
        user:identityValue(info.uid),
        group:identityValue(info.gid),
        size:identityValue(info.size),
        modified:identityValue(info.mtimeNs??info.mtimeMs),
        changed:identityValue(info.ctimeNs??info.ctimeMs),
        created:identityValue(info.birthtimeNs??info.birthtimeMs)
    });
}

function sameIdentity(left,right){
    return JSON.stringify(left)===JSON.stringify(right);
}

function moduleToken(type,value,start,depth){
    return Object.freeze({type,value,start,depth});
}

function identifierStart(character){
    return /[A-Za-z_$]/u.test(character);
}

function identifierPart(character){
    return /[A-Za-z0-9_$]/u.test(character);
}

function regexMayStart(previous){
    if(!previous)return true;
    if(previous.type==='identifier'){
        return REGEX_PREFIX_IDENTIFIERS.has(previous.value);
    }
    return previous.type==='punctuator'&&REGEX_PREFIX_PUNCTUATORS.has(previous.value);
}

function scanQuoted(source,index,quote){
    let cursor=index+1;
    let escaped=false;
    while(cursor<source.length){
        const character=source[cursor];
        if(!escaped&&character===quote){
            return {end:cursor+1,raw:source.slice(index+1,cursor)};
        }
        if(!escaped&&(character==='\n'||character==='\r')){
            closureFailure('Arcane provider source contains an unterminated string literal.',{offset:index});
        }
        if(!escaped&&character==='\\')escaped=true;
        else escaped=false;
        cursor+=1;
    }
    closureFailure('Arcane provider source contains an unterminated string literal.',{offset:index});
}

function skipLineComment(source,index){
    let cursor=index+2;
    while(cursor<source.length&&source[cursor]!=='\n'&&source[cursor]!=='\r')cursor+=1;
    return cursor;
}

function skipBlockComment(source,index){
    const end=source.indexOf('*/',index+2);
    if(end<0)closureFailure('Arcane provider source contains an unterminated block comment.');
    return end+2;
}

function skipRegex(source,index){
    let cursor=index+1;
    let escaped=false;
    let characterClass=false;
    while(cursor<source.length){
        const character=source[cursor];
        if(!escaped){
            if(character==='[')characterClass=true;
            else if(character===']')characterClass=false;
            else if(character==='/'&&!characterClass){
                cursor+=1;
                while(cursor<source.length&&/[A-Za-z]/u.test(source[cursor]))cursor+=1;
                return cursor;
            }else if(character==='\n'||character==='\r'){
                closureFailure('Arcane provider source contains an unterminated regular expression.');
            }
        }
        if(!escaped&&character==='\\')escaped=true;
        else escaped=false;
        cursor+=1;
    }
    closureFailure('Arcane provider source contains an unterminated regular expression.');
}

function punctuatorAt(source,index){
    for(const width of [4,3,2]){
        const candidate=source.slice(index,index+width);
        if(MULTI_PUNCTUATORS.has(candidate))return candidate;
    }
    return source[index];
}

function tokenizeProviderModule(source){
    const tokens=[];
    const depths={brace:0,bracket:0,parenthesis:0,template:0};
    const templateExpressionBaselines=[];
    let index=0;
    let previous=null;

    function depth(){
        return depths.brace+depths.bracket+depths.parenthesis+depths.template;
    }

    function push(type,value,start){
        const token=moduleToken(type,value,start,depth());
        tokens.push(token);
        previous=token;
    }

    function scanTemplate(opening){
        if(opening){
            depths.template+=1;
            index+=1;
        }
        let escaped=false;
        while(index<source.length){
            const character=source[index];
            if(!escaped&&character==='`'){
                index+=1;
                depths.template-=1;
                return;
            }
            if(!escaped&&character==='$'&&source[index+1]==='{'){
                templateExpressionBaselines.push(depths.brace);
                depths.brace+=1;
                index+=2;
                return;
            }
            if(!escaped&&character==='\\')escaped=true;
            else escaped=false;
            index+=1;
        }
        closureFailure('Arcane provider source contains an unterminated template literal.');
    }

    while(index<source.length){
        const character=source[index];
        if(/\s/u.test(character)){
            index+=1;
            continue;
        }
        if(character==='/'&&source[index+1]==='/'){
            index=skipLineComment(source,index);
            continue;
        }
        if(character==='/'&&source[index+1]==='*'){
            index=skipBlockComment(source,index);
            continue;
        }
        if(character==='\''||character==='"'){
            const scanned=scanQuoted(source,index,character);
            push('string',scanned.raw,index);
            index=scanned.end;
            continue;
        }
        if(character==='`'){
            scanTemplate(true);
            continue;
        }
        if(character==='/'&&regexMayStart(previous)){
            index=skipRegex(source,index);
            push('regex','/',index);
            continue;
        }
        if(identifierStart(character)){
            const start=index;
            index+=1;
            while(index<source.length&&identifierPart(source[index]))index+=1;
            push('identifier',source.slice(start,index),start);
            continue;
        }
        if(/[0-9]/u.test(character)){
            const start=index;
            index+=1;
            while(index<source.length&&/[A-Za-z0-9_.]/u.test(source[index]))index+=1;
            push('number',source.slice(start,index),start);
            continue;
        }
        const punctuator=punctuatorAt(source,index);
        const tokenDepth=depth();
        if(character==='}'&&depths.brace>0){
            const templateBaseline=templateExpressionBaselines.at(-1);
            const closesTemplateExpression=templateBaseline!==undefined
                &&depths.brace===templateBaseline+1;
            depths.brace-=1;
            if(closesTemplateExpression){
                templateExpressionBaselines.pop();
                index+=1;
                scanTemplate(false);
                continue;
            }
        }else if(character===')'&&depths.parenthesis>0)depths.parenthesis-=1;
        else if(character===']'&&depths.bracket>0)depths.bracket-=1;
        const token=moduleToken('punctuator',punctuator,index,tokenDepth);
        tokens.push(token);
        previous=token;
        if(character==='{')depths.brace+=1;
        else if(character==='(')depths.parenthesis+=1;
        else if(character==='[')depths.bracket+=1;
        index+=punctuator.length;
    }
    return tokens;
}

function decodeModuleSpecifier(token){
    if(token.type!=='string')closureFailure('Arcane provider import source must be a string literal.');
    if(token.value.includes('\\')){
        closureFailure('Arcane provider module specifiers must not use escaped characters.');
    }
    return token.value;
}

function staticModuleSpecifiers(source,modulePath){
    let tokens;
    try{
        tokens=tokenizeProviderModule(source);
    }catch(error){
        if(error instanceof ArcaneError&&error.code===PROVIDER_CLOSURE_CODE){
            throw new ArcaneError(error.code,error.message,{
                cause:error,
                details:{modulePath,...error.details}
            });
        }
        throw error;
    }
    const specifiers=[];
    for(let index=0;index<tokens.length;index+=1){
        const token=tokens[index];
        if(token.type!=='identifier'||token.value!=='import')continue;
        const next=tokens[index+1];
        if(next?.type==='punctuator'&&next.value==='.')continue;
        if(next?.type==='punctuator'&&next.value==='('){
            closureFailure('Arcane native providers must not use dynamic import().');
        }
        if(token.depth!==0)continue;
        if(next?.type==='string'){
            specifiers.push(decodeModuleSpecifier(next));
            continue;
        }
        const from=tokens.slice(index+1).find(candidate=>
            candidate.depth===0&&candidate.type==='identifier'&&candidate.value==='from'
        );
        if(!from)closureFailure('Arcane provider import declaration has no static source.');
        specifiers.push(decodeModuleSpecifier(tokens[tokens.indexOf(from)+1]));
    }
    for(let index=0;index<tokens.length;index+=1){
        const token=tokens[index];
        if(token.depth!==0||token.type!=='identifier'||token.value!=='export')continue;
        const next=tokens[index+1];
        if(next?.value!=='*'&&next?.value!=='{')continue;
        let cursor=index+1;
        while(cursor<tokens.length&&!(
            tokens[cursor].depth===0
            &&tokens[cursor].type==='identifier'
            &&tokens[cursor].value==='from'
        )){
            if(tokens[cursor].depth===0&&tokens[cursor].value===';')break;
            cursor+=1;
        }
        if(tokens[cursor]?.value==='from'){
            specifiers.push(decodeModuleSpecifier(tokens[cursor+1]));
        }
    }
    return specifiers;
}

async function regularFile(filePath,inspect){
    try{
        const info=await inspect(filePath);
        return info.isFile()&&!info.isSymbolicLink();
    }catch(error){
        if(error?.code==='ENOENT')return false;
        throw error;
    }
}

async function stableModule({modulePath,inspect,readModule}){
    const before=await inspect(modulePath);
    if(before.isSymbolicLink()||!before.isFile()){
        closureFailure('Every Arcane native provider module must be a real regular file.',{
            modulePath
        });
    }
    const beforeIdentity=filesystemIdentity(before);
    const declaredSize=Number(before.size);
    if(Number.isFinite(declaredSize)&&declaredSize>MAX_PROVIDER_MODULE_BYTES){
        closureFailure('An Arcane native provider module exceeds the fixed size limit.',{
            modulePath,
            maximumBytes:MAX_PROVIDER_MODULE_BYTES
        });
    }
    const bytes=await readModule(modulePath);
    if(!Buffer.isBuffer(bytes)&&!(bytes instanceof Uint8Array)){
        closureFailure('The Arcane native provider module reader must return bytes.',{modulePath});
    }
    const normalizedBytes=Buffer.from(bytes);
    if(normalizedBytes.byteLength>MAX_PROVIDER_MODULE_BYTES){
        closureFailure('An Arcane native provider module exceeds the fixed size limit.',{
            modulePath,
            maximumBytes:MAX_PROVIDER_MODULE_BYTES
        });
    }
    const after=await inspect(modulePath);
    const afterIdentity=filesystemIdentity(after);
    if(after.isSymbolicLink()||!after.isFile()||!sameIdentity(beforeIdentity,afterIdentity)){
        closureFailure('An Arcane native provider module changed while its generation was read.',{
            modulePath
        });
    }
    let source;
    try{
        source=utf8Decoder.decode(normalizedBytes);
    }catch(error){
        throw new ArcaneError(
            PROVIDER_CLOSURE_CODE,
            'Arcane native provider modules must contain valid UTF-8 source.',
            {cause:error,details:{modulePath}}
        );
    }
    return Object.freeze({
        bytes:normalizedBytes.byteLength,
        contentSha256:sha256(normalizedBytes),
        filesystemIdentity:afterIdentity,
        source
    });
}

function resolveRelativeModule({canonicalRoot,modulePath,specifier}){
    if(specifier.startsWith('node:'))return null;
    if(!specifier.startsWith('./')&&!specifier.startsWith('../')){
        closureFailure(
            'Arcane native providers may import only node: built-ins and static relative modules.',
            {modulePath,specifier}
        );
    }
    let resolvedUrl;
    let resolvedPath;
    try{
        resolvedUrl=new URL(specifier,pathToFileURL(modulePath));
        if(resolvedUrl.protocol!=='file:'||resolvedUrl.search||resolvedUrl.hash){
            closureFailure('Arcane native provider relative imports must resolve to plain files.',{
                modulePath,
                specifier
            });
        }
        resolvedPath=path.resolve(fileURLToPath(resolvedUrl));
    }catch(error){
        if(error instanceof ArcaneError)throw error;
        throw new ArcaneError(
            PROVIDER_CLOSURE_CODE,
            'Arcane native provider module specifier is invalid.',
            {cause:error,details:{modulePath,specifier}}
        );
    }
    if(!insideRoot(canonicalRoot,resolvedPath)){
        closureFailure('An Arcane native provider relative import escapes the Arcane checkout.',{
            modulePath,
            specifier
        });
    }
    if(!['.js','.mjs'].includes(path.extname(resolvedPath).toLowerCase())){
        closureFailure('Arcane native provider relative imports must name .js or .mjs modules.',{
            modulePath,
            specifier
        });
    }
    return resolvedPath;
}

function freezeGenerationEvidence({canonicalRoot,target,providerPath,modules,totalBytes}){
    const sorted=[...modules.values()].sort((left,right)=>
        left.relativePath.localeCompare(right.relativePath,'en')
    );
    const contentRecords=sorted.map(module=>Object.freeze({
        path:module.relativePath,
        bytes:module.bytes,
        contentSha256:module.contentSha256
    }));
    const identityRecords=sorted.map(module=>Object.freeze({
        path:module.relativePath,
        filesystemIdentity:module.filesystemIdentity
    }));
    const contentSha256=sha256(JSON.stringify(contentRecords));
    const filesystemIdentitySha256=sha256(JSON.stringify(identityRecords));
    const generationSha256=sha256(`${contentSha256}\0${filesystemIdentitySha256}`);
    return Object.freeze({
        schemaVersion:1,
        kind:'arcane-native-provider-generation',
        target,
        canonicalArcaneRoot:canonicalRoot,
        providerPath,
        entryPath:path.relative(canonicalRoot,providerPath).split(path.sep).join('/'),
        moduleCount:sorted.length,
        totalBytes,
        contentSha256,
        filesystemIdentitySha256,
        generationSha256,
        modules:Object.freeze(sorted.map(module=>Object.freeze({
            path:module.relativePath,
            canonicalLocation:module.canonicalLocation,
            bytes:module.bytes,
            contentSha256:module.contentSha256,
            filesystemIdentity:module.filesystemIdentity
        })))
    });
}

async function providerGeneration({
    canonicalRoot,
    providerPath,
    target,
    inspect,
    canonicalize,
    readModule,
    signal
}){
    const modules=new Map();
    let importCount=0;
    let totalBytes=0;

    async function visit(requestedPath,depth){
        throwIfAborted(signal);
        if(depth>MAX_PROVIDER_DEPTH){
            closureFailure('Arcane native provider module closure exceeds the fixed depth limit.',{
                maximumDepth:MAX_PROVIDER_DEPTH
            });
        }
        const resolvedPath=path.resolve(requestedPath);
        if(!insideRoot(canonicalRoot,resolvedPath)){
            closureFailure('An Arcane native provider module escapes the Arcane checkout.',{
                modulePath:resolvedPath
            });
        }
        if(modules.has(pathKey(resolvedPath)))return;
        if(modules.size>=MAX_PROVIDER_MODULES){
            closureFailure('Arcane native provider module closure exceeds the fixed module limit.',{
                maximumModules:MAX_PROVIDER_MODULES
            });
        }
        let canonicalModule;
        try{
            canonicalModule=await canonicalize(resolvedPath);
        }catch(error){
            if(error?.code==='ENOENT'){
                closureFailure('An Arcane native provider static relative module does not exist.',{
                    modulePath:resolvedPath
                });
            }
            throw error;
        }
        if(!samePath(canonicalModule,resolvedPath)||!insideRoot(canonicalRoot,canonicalModule)){
            closureFailure('Arcane native provider modules must not resolve through linked or escaped locations.',{
                modulePath:resolvedPath,
                canonicalModule
            });
        }
        const snapshot=await stableModule({modulePath:canonicalModule,inspect,readModule});
        totalBytes+=snapshot.bytes;
        if(totalBytes>MAX_PROVIDER_CLOSURE_BYTES){
            closureFailure('Arcane native provider module closure exceeds the fixed byte limit.',{
                maximumBytes:MAX_PROVIDER_CLOSURE_BYTES
            });
        }
        const relativePath=path.relative(canonicalRoot,canonicalModule).split(path.sep).join('/');
        modules.set(pathKey(canonicalModule),Object.freeze({
            relativePath,
            canonicalLocation:canonicalModule,
            bytes:snapshot.bytes,
            contentSha256:snapshot.contentSha256,
            filesystemIdentity:snapshot.filesystemIdentity
        }));
        const specifiers=staticModuleSpecifiers(snapshot.source,canonicalModule);
        importCount+=specifiers.length;
        if(importCount>MAX_PROVIDER_IMPORTS){
            closureFailure('Arcane native provider module closure exceeds the fixed import limit.',{
                maximumImports:MAX_PROVIDER_IMPORTS
            });
        }
        for(const specifier of specifiers){
            const dependency=resolveRelativeModule({
                canonicalRoot,
                modulePath:canonicalModule,
                specifier
            });
            if(dependency)await visit(dependency,depth+1);
        }
    }

    await visit(providerPath,0);
    return freezeGenerationEvidence({canonicalRoot,target,providerPath,modules,totalBytes});
}

function sameGeneration(left,right){
    return left.generationSha256===right.generationSha256
        &&left.moduleCount===right.moduleCount
        &&left.totalBytes===right.totalBytes;
}

function generationCacheKey({arcaneRoot,target,providerPath}){
    return `${pathKey(arcaneRoot)}\0${target}\0${pathKey(providerPath)}`;
}

function generationDetails(expected,current){
    return Object.freeze({
        expectedGenerationSha256:expected.generationSha256,
        actualGenerationSha256:current.generationSha256,
        expectedContentSha256:expected.contentSha256,
        actualContentSha256:current.contentSha256,
        expectedFilesystemIdentitySha256:expected.filesystemIdentitySha256,
        actualFilesystemIdentitySha256:current.filesystemIdentitySha256
    });
}

function unavailableGenerationDetails(expected,error){
    return Object.freeze({
        expectedGenerationSha256:expected.generationSha256,
        actualGenerationSha256:null,
        validationCode:typeof error?.code==='string'?error.code:null,
        validationMessage:String(error?.message??error)
    });
}

function sameModuleGeneration(left,right){
    return samePath(left.canonicalLocation,right.canonicalLocation)
        &&left.bytes===right.bytes
        &&left.contentSha256===right.contentSha256
        &&sameIdentity(left.filesystemIdentity,right.filesystemIdentity);
}

function moduleGenerationDetails(expected,current){
    return Object.freeze({
        modulePath:expected.canonicalLocation,
        expectedContentSha256:expected.contentSha256,
        actualContentSha256:current?.contentSha256??null,
        expectedFilesystemIdentity:expected.filesystemIdentity,
        actualFilesystemIdentity:current?.filesystemIdentity??null
    });
}

function poisonChangedModuleBindings(record,current){
    const currentModules=new Map(current.modules.map(module=>[
        pathKey(module.canonicalLocation),
        module
    ]));
    for(const binding of record.moduleBindings??[]){
        const observed=currentModules.get(binding.key);
        if(!observed||!sameModuleGeneration(binding.module,observed)){
            binding.registryRecord.poisoned=true;
        }
    }
    record.state='poisoned';
}

function reserveProcessModuleGenerations(record,evidence){
    const bindings=[];
    const created=[];
    try{
        for(const module of evidence.modules){
            const key=pathKey(module.canonicalLocation);
            let registryRecord=processModuleGenerations.get(key);
            if(registryRecord){
                if(registryRecord.poisoned
                    ||!sameModuleGeneration(registryRecord.module,module)){
                    registryRecord.poisoned=true;
                    record.state='poisoned';
                    restartRequired(record.target,moduleGenerationDetails(
                        registryRecord.module,
                        module
                    ));
                }
            }else{
                registryRecord={module,loaded:false,poisoned:false};
                processModuleGenerations.set(key,registryRecord);
                created.push({key,registryRecord});
            }
            bindings.push(Object.freeze({key,module,registryRecord}));
        }
    }catch(error){
        for(const createdBinding of created){
            if(!createdBinding.registryRecord.loaded
                &&processModuleGenerations.get(createdBinding.key)===createdBinding.registryRecord){
                processModuleGenerations.delete(createdBinding.key);
            }
        }
        throw error;
    }
    record.moduleBindings=Object.freeze(bindings);
}

function markProcessModulesLoaded(record){
    for(const binding of record.moduleBindings){
        if(binding.registryRecord.poisoned){
            record.state='poisoned';
            restartRequired(record.target,moduleGenerationDetails(
                binding.registryRecord.module,
                binding.module
            ));
        }
        binding.registryRecord.loaded=true;
    }
}

function poisonUnloadedProcessModules(record){
    for(const binding of record.moduleBindings??[]){
        if(!binding.registryRecord.loaded)binding.registryRecord.poisoned=true;
    }
}

function assertLoadedProcessModules(record,evidence=record.evidence){
    if(evidence.modules.length!==(record.moduleBindings?.length??0)){
        record.state='poisoned';
        restartRequired(record.target,unavailableGenerationDetails(
            record.evidence,
            new Error('The process-global provider module inventory changed.')
        ));
    }
    for(const module of evidence.modules){
        const key=pathKey(module.canonicalLocation);
        const registryRecord=processModuleGenerations.get(key);
        if(!registryRecord||!registryRecord.loaded||registryRecord.poisoned
            ||!sameModuleGeneration(registryRecord.module,module)){
            if(registryRecord)registryRecord.poisoned=true;
            record.state='poisoned';
            restartRequired(record.target,moduleGenerationDetails(
                registryRecord?.module??module,
                registryRecord?module:null
            ));
        }
    }
}

async function authenticateProviderGeneration({
    record,
    canonicalRoot,
    providerPath,
    target,
    inspect,
    canonicalize
}){
    if(record.state==='poisoned'){
        restartRequired(target,unavailableGenerationDetails(
            record.evidence,
            new Error('The cached provider generation is no longer valid.')
        ));
    }
    try{
        const rootInfo=await inspect(canonicalRoot);
        const authenticatedRoot=await canonicalize(canonicalRoot);
        if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()
            ||!samePath(authenticatedRoot,canonicalRoot)
            ||record.evidence.moduleCount!==record.evidence.modules.length
            ||record.evidence.moduleCount>MAX_PROVIDER_MODULES
            ||!record.evidence.modules.some(module=>samePath(module.canonicalLocation,providerPath))){
            closureFailure('The loaded Arcane provider module inventory is no longer valid.');
        }
        assertLoadedProcessModules(record);
        const observedPaths=new Set();
        for(const module of record.evidence.modules){
            if(observedPaths.has(pathKey(module.canonicalLocation))
                ||!insideRoot(canonicalRoot,module.canonicalLocation)){
                closureFailure('The loaded Arcane provider module inventory is no longer canonical.');
            }
            observedPaths.add(pathKey(module.canonicalLocation));
            const before=await inspect(module.canonicalLocation);
            const canonicalModule=await canonicalize(module.canonicalLocation);
            const after=await inspect(module.canonicalLocation);
            const registryRecord=processModuleGenerations.get(pathKey(module.canonicalLocation));
            if(before.isSymbolicLink()||!before.isFile()
                ||after.isSymbolicLink()||!after.isFile()
                ||!samePath(canonicalModule,module.canonicalLocation)
                ||!sameIdentity(filesystemIdentity(before),module.filesystemIdentity)
                ||!sameIdentity(filesystemIdentity(after),module.filesystemIdentity)){
                if(registryRecord)registryRecord.poisoned=true;
                closureFailure('A loaded Arcane provider module identity is no longer valid.',{
                    modulePath:module.canonicalLocation
                });
            }
        }
    }catch(error){
        record.state='poisoned';
        const details=unavailableGenerationDetails(record.evidence,error);
        throw new ArcaneError(
            PROVIDER_GENERATION_CODE,
            `The Arcane ${target} provider module generation can no longer be authenticated. Restart the Arcane SDK process before pairing this provider again.`,
            {cause:error,details}
        );
    }
    return record.evidence;
}

function guardedNativeBuilder({
    rawBuilder,
    record,
    canonicalRoot,
    providerPath,
    target,
    inspect,
    canonicalize
}){
    const guarded={
        protocol:rawBuilder.protocol,
        providerGeneration:record.evidence
    };
    for(const method of [
        'describe','doctor','prepare','authenticateToolchainReceipt','build','verify','run'
    ]){
        guarded[method]=async function guardedProviderOperation(...args){
            await authenticateProviderGeneration({
                record,
                canonicalRoot,
                providerPath,
                target,
                inspect,
                canonicalize
            });
            return rawBuilder[method].apply(rawBuilder,args);
        };
    }
    return Object.freeze(guarded);
}

async function importReservedProvider(record){
    const requested=await providerGeneration({
        canonicalRoot:record.canonicalRoot,
        providerPath:record.providerPath,
        target:record.target,
        inspect:record.inspect,
        canonicalize:record.canonicalize,
        readModule:record.readModule
    });
    record.evidence=requested;
    reserveProcessModuleGenerations(record,requested);
    record.importAttempted=true;

    let namespace;
    let importError;
    let rawBuilder;
    let importCompleted=false;
    try{
        namespace=await record.importModule(pathToFileURL(record.providerPath).href);
        importCompleted=true;
        rawBuilder=validateNativeBuilder(
            namespace?.arcaneNativeBuilderProvider??namespace?.default
        );
    }catch(error){
        importError=error;
    }

    let afterImport;
    try{
        afterImport=await providerGeneration({
            canonicalRoot:record.canonicalRoot,
            providerPath:record.providerPath,
            target:record.target,
            inspect:record.inspect,
            canonicalize:record.canonicalize,
            readModule:record.readModule
        });
    }catch(error){
        record.state='poisoned';
        for(const binding of record.moduleBindings)binding.registryRecord.poisoned=true;
        throw new ArcaneError(
            PROVIDER_GENERATION_CODE,
            `The Arcane ${record.target} provider module generation changed while it was imported. Restart the Arcane SDK process before pairing this provider again.`,
            {cause:error,details:unavailableGenerationDetails(requested,error)}
        );
    }
    if(!sameGeneration(requested,afterImport)){
        poisonChangedModuleBindings(record,afterImport);
        restartRequired(record.target,generationDetails(requested,afterImport));
    }
    if(importCompleted)markProcessModulesLoaded(record);
    if(importError){
        if(!importCompleted)poisonUnloadedProcessModules(record);
        record.state=importCompleted?'invalid':'poisoned';
        if(importError instanceof ArcaneError)throw importError;
        throw new ArcaneError(
            ERROR_CODES.targetUnavailable,
            `The Arcane ${record.target} provider could not be loaded: ${importError.message}`,
            {cause:importError,details:{providerPath:record.providerPath}}
        );
    }

    const guardedBuilder=guardedNativeBuilder({
        rawBuilder,
        record,
        canonicalRoot:record.canonicalRoot,
        providerPath:record.providerPath,
        target:record.target,
        inspect:record.inspect,
        canonicalize:record.canonicalize
    });
    record.namespace=namespace;
    record.pairing=Object.freeze({
        arcaneRoot:record.canonicalRoot,
        toolchainRoot:record.canonicalRoot,
        providerPath:record.providerPath,
        providerGeneration:requested,
        nativeBuilder:guardedBuilder
    });
    record.state='ready';
    return record.pairing;
}

async function initializeProviderReservation(record){
    record.state='loading';
    try{
        const rootInfo=await record.inspect(record.requestedRoot);
        if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()){
            fail('The Arcane OS checkout root must be a real directory.',{
                arcaneRoot:record.requestedRoot
            });
        }
        await assertUnlinkedDirectoryAncestors(record.requestedRoot,record.inspect);
        record.canonicalRoot=await record.canonicalize(record.requestedRoot);
        if(!await regularFile(record.requestedProvider,record.inspect)){
            fail(`The selected Arcane OS checkout does not contain the ${record.target} native provider.`,{
                target:record.target,
                arcaneRoot:record.canonicalRoot,
                providerPath:record.requestedProvider
            });
        }
        record.providerPath=await record.canonicalize(record.requestedProvider);
        const expectedProvider=path.join(
            record.canonicalRoot,
            ...ARCANE_NATIVE_PROVIDER_PATHS[record.target]
        );
        if(!samePath(record.providerPath,expectedProvider)){
            fail(`The Arcane ${record.target} provider path must not resolve through a linked location.`,{
                target:record.target,
                providerPath:record.requestedProvider
            });
        }
        return await importReservedProvider(record);
    }catch(error){
        if(!record.importAttempted){
            record.state='invalid';
            if(providerGenerationCache.get(record.cacheKey)===record){
                providerGenerationCache.delete(record.cacheKey);
            }
        }
        if(error?.code==='ENOENT'){
            fail('The selected Arcane OS checkout root or provider module does not exist.',{
                arcaneRoot:record.requestedRoot
            });
        }
        throw error;
    }
}

function createProviderReservation(options){
    let releaseStart;
    const startGate=new Promise(resolve=>{releaseStart=resolve;});
    const record={
        ...options,
        state:'reserved',
        started:false,
        importAttempted:false,
        evidence:null,
        moduleBindings:null,
        namespace:null,
        pairing:null,
        promise:null,
        start:null
    };
    record.start=()=>{
        if(record.started)return;
        record.started=true;
        releaseStart();
    };
    record.promise=startGate.then(()=>initializeProviderReservation(record));
    record.promise.catch(()=>{});
    return record;
}

async function authenticateReadyPairing(record){
    if(record.state==='poisoned'){
        restartRequired(record.target,unavailableGenerationDetails(
            record.evidence,
            new Error('The cached provider generation is no longer valid.')
        ));
    }
    let current;
    try{
        current=await providerGeneration({
            canonicalRoot:record.canonicalRoot,
            providerPath:record.providerPath,
            target:record.target,
            inspect:record.inspect,
            canonicalize:record.canonicalize,
            readModule:record.readModule
        });
    }catch(error){
        record.state='poisoned';
        throw new ArcaneError(
            PROVIDER_GENERATION_CODE,
            `The Arcane ${record.target} provider module generation can no longer be authenticated. Restart the Arcane SDK process before pairing this provider again.`,
            {cause:error,details:unavailableGenerationDetails(record.evidence,error)}
        );
    }
    if(!sameGeneration(record.evidence,current)){
        poisonChangedModuleBindings(record,current);
        restartRequired(record.target,generationDetails(record.evidence,current));
    }
    assertLoadedProcessModules(record,current);
    return record.pairing;
}

async function observeProviderReservation({record,stateAtInvocation,onEvent,signal,target}){
    throwIfAborted(signal);
    await onEvent?.(Object.freeze({
        type:'native.provider.load.started',
        target,
        message:`Loading the explicitly selected Arcane ${String(target)} provider.`
    }));
    record.start();
    throwIfAborted(signal);
    const pairing=await record.promise;
    if(stateAtInvocation==='ready'||stateAtInvocation==='poisoned'){
        await authenticateReadyPairing(record);
    }
    throwIfAborted(signal);
    await onEvent?.(Object.freeze({
        type:'native.provider.load.completed',
        target,
        message:`The Arcane ${target} provider is paired for this process.`
    }));
    return pairing;
}

export function loadArcaneNativeProvider({
    arcaneRoot,
    target,
    inspect=lstat,
    canonicalize=realpath,
    readModule=readFile,
    importModule=specifier=>import(specifier),
    generationCache=providerGenerationCache,
    signal,
    onEvent
}={}){
    throwIfAborted(signal);
    const relativeProviderPath=ARCANE_NATIVE_PROVIDER_PATHS[target];
    if(!relativeProviderPath){
        fail(`No fixed Arcane native provider is registered for target ${String(target)}.`,{
            target,
            supportedTargets:Object.keys(ARCANE_NATIVE_PROVIDER_PATHS)
        });
    }
    if(typeof arcaneRoot!=='string'||!arcaneRoot.trim()){
        fail(`The ${target} native provider requires an explicit Arcane OS checkout root.`);
    }
    if(typeof readModule!=='function'||typeof importModule!=='function'
        ||typeof generationCache?.get!=='function'||typeof generationCache?.set!=='function'){
        fail('The Arcane native provider loader dependencies are invalid.');
    }
    const requestedRoot=path.resolve(arcaneRoot);
    const requestedProvider=path.join(requestedRoot,...relativeProviderPath);
    const cacheKey=generationCacheKey({
        arcaneRoot:requestedRoot,
        target,
        providerPath:requestedProvider
    });
    let record=providerGenerationCache.get(cacheKey);
    const stateAtInvocation=record?.state??'created';
    if(!record){
        record=createProviderReservation({
            cacheKey,
            requestedRoot,
            requestedProvider,
            target,
            inspect,
            canonicalize,
            readModule,
            importModule
        });
        providerGenerationCache.set(cacheKey,record);
    }
    generationCache.set(cacheKey,record);
    return observeProviderReservation({
        record,
        stateAtInvocation,
        onEvent,
        signal,
        target,
    });
}

export function loadArcanePortableProvider(options={}){
    return loadArcaneNativeProvider({...options,target:'portable'});
}

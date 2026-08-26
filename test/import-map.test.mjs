import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
    cp,
    lstat,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    symlink,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {
    buildImportMap,
    generateImportMap,
    inspectImportMapHtml,
    scanModuleImports
} from '../src/import-map.mjs';
import {withWorkspaceOperationLock} from '../src/workspace-operation-lock.mjs';
import {repositoryRoot,temporaryDirectory} from './helpers.mjs';

function compareUtf8(left,right){
    return Buffer.compare(Buffer.from(left,'utf8'),Buffer.from(right,'utf8'));
}

async function writeWorkspaceFile(workspaceRoot,relative,source){
    const filePath=path.join(workspaceRoot,...relative.split('/'));
    await mkdir(path.dirname(filePath),{recursive:true});
    await writeFile(filePath,source,'utf8');
    return filePath;
}

async function createApplication(workspaceRoot,appId='import-map-app'){
    const appRoot=path.join(workspaceRoot,'apps',appId);
    await writeWorkspaceFile(workspaceRoot,`apps/${appId}/modules/App.js`,[
        "import ThemeBootstrap from 'arcane/ThemeBootstrap';",
        'void ThemeBootstrap;',
        ''
    ].join('\n'));
    await writeWorkspaceFile(workspaceRoot,`apps/${appId}/index.html`,[
        '<!doctype html>',
        '<html>',
        '<head>',
        '    <base href="../../">',
        '</head>',
        '<body>',
        `    <script type="module" src="./apps/${appId}/modules/App.js"></script>`,
        '</body>',
        '</html>',
        ''
    ].join('\n'));
    return appRoot;
}

async function copyShippedRuntime(workspaceRoot){
    await cp(
        path.join(repositoryRoot,'runtime','arcane'),
        path.join(workspaceRoot,'arcane'),
        {recursive:true}
    );
    await cp(
        path.join(repositoryRoot,'runtime','strong-type'),
        path.join(workspaceRoot,'arcane','dependencies','strong-type'),
        {recursive:true}
    );
    await cp(
        path.join(repositoryRoot,'browser-runtime'),
        path.join(workspaceRoot,'arcane','sdk'),
        {recursive:true}
    );
}

async function writeSdkBrowserGraph(workspaceRoot){
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/sdk/ai/ARCANE_AI_BROWSER_WASM_COMPONENTS.json',
        '{"schemaVersion":1}\n'
    );
    await writeWorkspaceFile(workspaceRoot,'arcane/sdk/ai/browser-wasm.mjs',[
        "export * from './browser-wasm-llm-provider.mjs';",
        "export * from './browser-wllama-runtime.mjs';",
        ''
    ].join('\n'));
    await writeWorkspaceFile(workspaceRoot,'arcane/sdk/ai/browser-speech.mjs',[
        "export * from './browser-speech-artifacts.mjs';",
        "export * from './browser-speech-providers.mjs';",
        ''
    ].join('\n'));
    await writeWorkspaceFile(workspaceRoot,'arcane/sdk/ai/browser-speech-providers.mjs',[
        "import './browser-speech-artifacts.mjs';",
        "import './speech-worker-client.mjs';",
        'export const speech=true;',
        ''
    ].join('\n'));
    for(const relative of [
        'browser-kokoro-worker.mjs',
        'browser-speech-artifacts.mjs',
        'browser-whisper-worker.mjs',
        'speech-worker-client.mjs',
        'speech-worker-runtime.mjs'
    ]){
        await writeWorkspaceFile(
            workspaceRoot,
            `arcane/sdk/ai/${relative}`,
            'export const fixture=true;\n'
        );
    }
    await writeWorkspaceFile(workspaceRoot,'arcane/sdk/ai/browser-wasm-llm-provider.mjs',[
        "import './model-controller.mjs';",
        "import './internal/sha256.mjs';",
        'export const provider=true;',
        ''
    ].join('\n'));
    await writeWorkspaceFile(workspaceRoot,'arcane/sdk/ai/browser-wllama-runtime.mjs',[
        "import './wllama/index.mjs';",
        'export const runtime=true;',
        ''
    ].join('\n'));
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/sdk/ai/internal/sha256.mjs',
        'export const sha256=true;\n'
    );
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/sdk/ai/model-controller.mjs',
        'export const controller=true;\n'
    );
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/sdk/ai/wllama/index.mjs',
        'export const Wllama=true;\n'
    );
    for(const relative of [
        'arcane/sdk/ai/wllama/LICENCE',
        'arcane/sdk/ai/wllama/llama.cpp-LICENSE',
        'arcane/sdk/ai/wllama/wllama.wasm'
    ])await writeWorkspaceFile(workspaceRoot,relative,'fixture\n');
    await writeWorkspaceFile(workspaceRoot,'arcane/sdk/event-manager.mjs',[
        "import EventPubSub from 'event-pubsub';",
        "export {domEvent} from './dom-event-instrumentation.mjs';",
        'export default EventPubSub;',
        ''
    ].join('\n'));
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/sdk/dom-event-instrumentation.mjs',
        'export const domEvent=true;\n'
    );
    await writeWorkspaceFile(workspaceRoot,'arcane/sdk/dependencies/event-pubsub/index.js',[
        "import Is from '../strong-type/index.js';",
        'export default class EventPubSub { static Is=Is; }',
        ''
    ].join('\n'));
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/sdk/dependencies/event-pubsub/package.json',
        '{"name":"event-pubsub","version":"6.1.0","type":"module"}\n'
    );
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/sdk/dependencies/event-pubsub/licence',
        'fixture\n'
    );
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/sdk/dependencies/strong-type/index.js',
        'export default class Is {}\n'
    );
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/sdk/dependencies/strong-type/package.json',
        '{"name":"strong-type","version":"2.0.0","type":"module"}\n'
    );
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/sdk/dependencies/strong-type/licence',
        'fixture\n'
    );
}

async function transactionFiles(root){
    const found=[];
    async function visit(directory){
        const entries=await readdir(directory,{withFileTypes:true});
        for(const entry of entries){
            const absolute=path.join(directory,entry.name);
            if(entry.isDirectory())await visit(absolute);
            else if(/\.arcane-(?:stage|backup)-/u.test(entry.name))found.push(absolute);
        }
    }
    await visit(root);
    return found.sort();
}

async function exists(filePath){
    try{
        await lstat(filePath);
        return true;
    }catch(error){
        if(error?.code==='ENOENT')return false;
        throw error;
    }
}

test('shipped Arcane modules and transitive dependencies produce the exact named import contract',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    await copyShippedRuntime(workspaceRoot);
    const appRoot=await createApplication(workspaceRoot,'named-runtime');
    const events=[];
    const receipt=await generateImportMap({
        workspaceRoot,
        appId:'named-runtime',
        onEvent:event=>events.push(event)
    });

    assert.equal(receipt.entryCount,91);
    assert.deepEqual(receipt.cleanupWarnings,[]);
    assert.deepEqual(receipt.excludedModules,['modules/CaseEvidenceIndexer.js']);
    assert.equal(receipt.artifactPath,path.join(appRoot,'modules','arcane.importmap.json'));
    assert.equal(receipt.artifactRelativePath,'apps/named-runtime/modules/arcane.importmap.json');
    assert.equal(receipt.documentCount,1);
    assert.deepEqual(receipt.documentPaths,[path.join(appRoot,'index.html')]);
    assert.equal(Object.isFrozen(receipt.documentPaths),true);
    assert.deepEqual(events.map(event=>event.type),[
        'workspace.operation.locked',
        'import-map.started',
        'import-map.commit.staged',
        'import-map.commit.progress',
        'import-map.completed',
        'workspace.operation.released'
    ]);

    const artifact=await readFile(receipt.artifactPath,'utf8');
    const entryBytes=await readFile(path.join(appRoot,'index.html'));
    assert.deepEqual(receipt.files,[
        {
            role:'artifact',
            path:'apps/named-runtime/modules/arcane.importmap.json',
            bytes:Buffer.byteLength(artifact),
            sha256:createHash('sha256').update(artifact).digest('hex')
        },
        {
            role:'entry',
            path:'apps/named-runtime/index.html',
            bytes:entryBytes.length,
            sha256:createHash('sha256').update(entryBytes).digest('hex')
        }
    ]);
    assert.equal(Object.isFrozen(receipt.files),true);
    assert.equal(receipt.files.every(Object.isFrozen),true);
    const document=JSON.parse(artifact);
    assert.deepEqual(Object.keys(document),['imports']);
    assert.deepEqual(document.imports,receipt.imports);
    assert.equal(artifact,`${JSON.stringify({imports:receipt.imports},null,2)}\n`);
    assert.deepEqual(
        Object.keys(document.imports),
        [...Object.keys(document.imports)].sort(compareUtf8)
    );
    assert.equal(document.imports['arcane/ThemeBootstrap'],'./arcane/modules/ThemeBootstrap.js');
    assert.equal(document.imports['arcane/Marked.min'],'./arcane/modules/Marked.min.js');
    assert.equal(document.imports['arcane/MailTransport'],'./arcane/modules/MailTransport.mjs');
    assert.equal(document.imports['arcane/entities/User'],'./arcane/entities/User.js');
    assert.equal(
        document.imports['arcane-os/event-manager'],
        './arcane/sdk/event-manager.mjs'
    );
    assert.equal(
        document.imports['arcane-os/ai/browser-wasm'],
        './arcane/sdk/ai/browser-wasm.mjs'
    );
    assert.equal(
        document.imports['arcane-os/ai/browser-speech'],
        './arcane/sdk/ai/browser-speech.mjs'
    );
    assert.equal(
        document.imports['#arcane/persistent-ai-chat-session'],
        './arcane/modules/PersistentAIChatSession.js'
    );
    assert.equal(
        document.imports['event-pubsub'],
        './arcane/sdk/dependencies/event-pubsub/index.js'
    );
    assert.equal(
        document.imports['./node_modules/strong-type/index.js'],
        './arcane/dependencies/strong-type/index.js'
    );
    assert.equal(document.imports['arcane/CaseEvidenceIndexer'],undefined);
    assert.equal(document.imports['arcane-os'],undefined);
    assert.equal(document.imports['arcane/DBOPFSWorker'],undefined);
    assert.equal(document.imports['arcane/QRCode.min'],undefined);
    assert.equal(document.imports['arcane/uPlot.iife.min'],undefined);

    const entitySpecifiers=Object.keys(document.imports)
        .filter(specifier=>specifier.startsWith('arcane/entities/'));
    assert.deepEqual(entitySpecifiers,[
        'arcane/entities/ApiModelRecord',
        'arcane/entities/Calculation',
        'arcane/entities/CommunicationMessage',
        'arcane/entities/CommunicationThread',
        'arcane/entities/Preference',
        'arcane/entities/TerminalSession',
        'arcane/entities/Theme',
        'arcane/entities/User',
        'arcane/entities/Weather'
    ]);
    for(const target of Object.values(document.imports)){
        assert.match(target,/^\.\/arcane\//u);
        assert.doesNotMatch(target,/\\/u);
        const info=await lstat(path.join(workspaceRoot,...target.slice(2).split('/')));
        assert.equal(info.isFile(),true,target);
    }

    const html=await readFile(path.join(appRoot,'index.html'),'utf8');
    const managed=html.match(
        /<script type="importmap" data-arcane-import-map>\n([\s\S]*?)<\/script>/u
    );
    assert.ok(managed);
    assert.equal(managed[1],artifact);
    assert.ok(
        html.indexOf('data-arcane-import-map')<html.indexOf('type="module"'),
        'the import map must precede the first module load'
    );
});

test('generator commits one deterministic authenticated map across explicit browser documents',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    await copyShippedRuntime(workspaceRoot);
    const appRoot=await createApplication(workspaceRoot,'multi-document-map');
    const entryPath=path.join(appRoot,'index.html');
    const reviewPath=await writeWorkspaceFile(
        workspaceRoot,
        'apps/multi-document-map/pages/review.html',
        [
            '<!doctype html>',
            '<html>',
            '<head>',
            '    <base href="../../../">',
            '</head>',
            '<body>',
            '    <script type="module" src="./apps/multi-document-map/modules/App.js"></script>',
            '</body>',
            '</html>',
            ''
        ].join('\n')
    );
    const events=[];
    const receipt=await generateImportMap({
        workspaceRoot,
        appId:'multi-document-map',
        documents:['pages/review.html','index.html'],
        onEvent:event=>events.push(event)
    });
    const artifact=await readFile(receipt.artifactPath,'utf8');

    assert.equal(receipt.documentCount,2);
    assert.deepEqual(receipt.documentPaths,[entryPath,reviewPath]);
    assert.deepEqual(receipt.files.map(file=>[file.role,file.path]),[
        ['artifact','apps/multi-document-map/modules/arcane.importmap.json'],
        ['entry','apps/multi-document-map/index.html'],
        ['document','apps/multi-document-map/pages/review.html']
    ]);
    assert.equal(Object.isFrozen(receipt.documentPaths),true);
    assert.equal(Object.isFrozen(receipt.files),true);
    assert.equal(receipt.files.every(Object.isFrozen),true);
    for(const committed of receipt.files){
        const bytes=await readFile(path.join(workspaceRoot,...committed.path.split('/')));
        assert.equal(committed.bytes,bytes.length);
        assert.equal(committed.sha256,createHash('sha256').update(bytes).digest('hex'));
    }
    for(const documentPath of receipt.documentPaths){
        const html=await readFile(documentPath,'utf8');
        const managed=html.match(
            /<script type="importmap" data-arcane-import-map>\n([\s\S]*?)<\/script>/u
        );
        assert.ok(managed);
        assert.equal(managed[1],artifact);
        assert.ok(html.indexOf('data-arcane-import-map')<html.indexOf('type="module"'));
    }
    const started=events.find(event=>event.type==='import-map.started');
    const progress=events.find(event=>event.type==='import-map.commit.progress');
    const completed=events.find(event=>event.type==='import-map.completed');
    assert.equal(started.documentCount,2);
    assert.deepEqual(started.documentPaths,[entryPath,reviewPath]);
    assert.deepEqual(progress.paths,[receipt.artifactPath,entryPath,reviewPath]);
    assert.equal(completed.documentCount,2);
    assert.deepEqual(completed.documentPaths,[entryPath,reviewPath]);

    const committedArtifact=await readFile(receipt.artifactPath,'utf8');
    const committedEntry=await readFile(entryPath,'utf8');
    const authoredReview=`${await readFile(reviewPath,'utf8')}<!-- retained on rollback -->\n`;
    await writeFile(reviewPath,authoredReview,'utf8');
    await assert.rejects(
        generateImportMap({
            workspaceRoot,
            appId:'multi-document-map',
            documents:['index.html','pages/review.html'],
            onEvent(event){
                if(event.type==='import-map.commit.progress'){
                    throw new Error('reject multi-document commit');
                }
            }
        }),
        /reject multi-document commit/u
    );
    assert.equal(await readFile(receipt.artifactPath,'utf8'),committedArtifact);
    assert.equal(await readFile(entryPath,'utf8'),committedEntry);
    assert.equal(await readFile(reviewPath,'utf8'),authoredReview);
    assert.deepEqual(await transactionFiles(appRoot),[]);
    await assert.rejects(
        generateImportMap({
            workspaceRoot,
            appId:'multi-document-map',
            documents:['pages/review.html']
        }),
        error=>error?.code==='ARCANE_IMPORT_MAP_INVALID'
            &&/must include the configured application entry/u.test(error.message)
    );
});

test('scanner recognizes only JavaScript module imports and rejects nonliteral dynamics',()=>{
    const source=[
        '// import "./comment.js";',
        'const text="import(\\"./string.js\\")";',
        'const matcher=/import\\(\"\.\\/regex\\.js\"\\)/u;',
        'const template=`import("./template.js")`;',
        'const location=import.meta.url;',
        'const ratio=10/2;',
        "import './side-effect.js?cache=7#anchor';",
        "export {thing} from './exported.mjs';",
        "const loaded=import('./dynamic.js');",
        'void text; void matcher; void template; void location; void ratio; void loaded;',
        ''
    ].join('\n');
    const result=scanModuleImports(source,{importer:'modules/Scanner.js'});
    assert.equal(result.hasModuleSyntax,true);
    assert.deepEqual(
        result.imports.map(record=>[record.kind,record.specifier]),
        [
            ['static','./side-effect.js?cache=7#anchor'],
            ['export','./exported.mjs'],
            ['dynamic','./dynamic.js']
        ]
    );
    assert.deepEqual(
        scanModuleImports('// inert\u2028import("./after-ls.js");').imports
            .map(record=>[record.kind,record.specifier]),
        [['dynamic','./after-ls.js']]
    );
    assert.deepEqual(
        scanModuleImports('#! arcane\u2029import("./after-ps.js");').imports
            .map(record=>[record.kind,record.specifier]),
        [['dynamic','./after-ps.js']]
    );
    for(const lineTerminator of ['\u2028','\u2029']){
        const continued='import "./'+'\\'+lineTerminator+'Leaf.js";';
        assert.deepEqual(
            scanModuleImports(continued).imports.map(record=>[record.kind,record.specifier]),
            [['static','./Leaf.js']]
        );
    }
    assert.throws(
        ()=>scanModuleImports(String.raw`import("./\141.js");`),
        /legacy octal or decimal string escape/u
    );
    assert.throws(
        ()=>scanModuleImports(
            'export const target="./late.js"; import(target);',
            {importer:'modules/Nonliteral.js'}
        ),
        error=>error?.code==='ARCANE_IMPORT_MAP_UNRESOLVED'
            &&/Nonliteral\.js/u.test(error.message)
            &&/literal shipped specifier/u.test(error.message)
    );

    const contextual=scanModuleImports([
        '#!/usr/bin/env node',
        "import {from as first} from './one.js';",
        "import from from './two.js';",
        "export * as from from './three.js';",
        'const divided=/a/ / divisor;',
        "const loaded=import('./four.js', {with:{type:'json'}});",
        'void import.meta.url;',
        'void first; void from; void divided; void loaded;',
        ''
    ].join('\n'),{importer:'modules/Contextual.mjs'});
    assert.equal(contextual.hasModuleSyntax,true);
    assert.deepEqual(
        contextual.imports.map(record=>[record.kind,record.specifier]),
        [
            ['static','./one.js'],
            ['static','./two.js'],
            ['export','./three.js'],
            ['dynamic','./four.js']
        ]
    );
    assert.deepEqual(
        scanModuleImports([
            'const api={import(){return 1;}};',
            'class C { import(){return 2;} #import(){return 3;} call(){return this.#import();} }',
            "const loaded=import('./real-method.js');",
            'void api; void C; void loaded;'
        ].join('\n')).imports.map(record=>[record.kind,record.specifier]),
        [['dynamic','./real-method.js']]
    );
    assert.deepEqual(
        scanModuleImports('const api={load(){}}; export default api;').imports,
        []
    );
    assert.equal(scanModuleImports('void import.meta.url;').hasModuleSyntax,true);
    assert.equal(
        scanModuleImports('#! arcane\nconst divided=/a/ / value;').hasModuleSyntax,
        false
    );
    assert.throws(
        ()=>scanModuleImports("import('./literal.js'+suffix);",{importer:'modules/Concat.js'}),
        error=>error?.code==='ARCANE_IMPORT_MAP_UNRESOLVED'
            &&/Concat\.js/u.test(error.message)
    );
    assert.throws(
        ()=>scanModuleImports(
            "import('./literal.js', {}, extra);",
            {importer:'modules/TooManyOptions.js'}
        ),
        error=>error?.code==='ARCANE_IMPORT_MAP_UNRESOLVED'
    );
    assert.deepEqual(
        scanModuleImports("import('./literal.js', {with:{type:'json'}},);").imports
            .map(record=>record.specifier),
        ['./literal.js']
    );

    const propertyDivision=scanModuleImports([
        'const api={if(){return 2;}};',
        'export const ratio=api.if()/2;',
        ''
    ].join('\n'),{importer:'modules/PropertyDivision.js'});
    assert.deepEqual(propertyDivision.imports,[]);
    const propertyControl=scanModuleImports([
        'const api={if(){return 2;}};',
        "export const loaded=api.if()/import('event-pubsub')/2;",
        ''
    ].join('\n'),{importer:'modules/PropertyControl.js'});
    assert.deepEqual(
        propertyControl.imports.map(record=>[record.kind,record.specifier]),
        [['dynamic','event-pubsub']]
    );
    const contextualOf=scanModuleImports([
        'const api={of:8};',
        "export const loaded=api.of/import('./property-of.js')/2;",
        'const of=8;',
        "export const loadedAgain=of/import('./identifier-of.js')/2;",
        ''
    ].join('\n'),{importer:'modules/ContextualOf.js'});
    assert.deepEqual(
        contextualOf.imports.map(record=>[record.kind,record.specifier]),
        [
            ['dynamic','./property-of.js'],
            ['dynamic','./identifier-of.js']
        ]
    );
    const classicFor=scanModuleImports([
        "for (of / import('event-pubsub') / 2; false;){}",
        "for (let ofValue=of / import('./classic-for.js') / 2; false;){}",
        ''
    ].join('\n'),{importer:'modules/ClassicForOfIdentifier.js'});
    assert.deepEqual(
        classicFor.imports.map(record=>[record.kind,record.specifier]),
        [
            ['dynamic','event-pubsub'],
            ['dynamic','./classic-for.js']
        ]
    );
    for(const unicodeSource of [
        'const π=8; π/import("event-pubsub")/2;',
        'export const π=8; export const x=π/import("event-pubsub")/2;',
        'const π́=8; π́/import("event-pubsub")/2;'
    ]){
        assert.deepEqual(
            scanModuleImports(unicodeSource,{importer:'modules/UnicodeIdentifier.js'}).imports
                .map(record=>[record.kind,record.specifier]),
            [['dynamic','event-pubsub']]
        );
    }
    assert.throws(
        ()=>scanModuleImports(
            String.raw`const \u03c0=8; \u03c0/import("event-pubsub")/2;`,
            {importer:'modules/EscapedIdentifier.js'}
        ),
        /escaped JavaScript identifier/u
    );
    const privateMembers=scanModuleImports([
        'class C {',
        '  #return=8;',
        '  #await=8;',
        '  #if(){return 8;}',
        '  #for(){return 8;}',
        '  load(other){',
        "    const returned=this.#return/import('./private-return.js')/2;",
        "    const awaited=other?.#await/import('./private-await.js')/2;",
        "    const conditional=this.#if()/import('event-pubsub')/2;",
        "    const looped=this.#for()/import('./private-for.js')/2;",
        '    return returned+awaited+conditional+looped;',
        '  }',
        '}',
        ''
    ].join('\n'),{importer:'modules/PrivateMembers.js'});
    assert.deepEqual(
        privateMembers.imports.map(record=>[record.kind,record.specifier]),
        [
            ['dynamic','./private-return.js'],
            ['dynamic','./private-await.js'],
            ['dynamic','event-pubsub'],
            ['dynamic','./private-for.js']
        ]
    );
    const classicContextualKeywords=scanModuleImports([
        'var await=8;',
        "await/import('./classic-await.js')/2;",
        'var yield=8;',
        "yield/import('./classic-yield.js')/2;",
        ''
    ].join('\n'),{importer:'modules/ClassicContextualKeywords.js'});
    assert.deepEqual(
        classicContextualKeywords.imports.map(record=>[record.kind,record.specifier]),
        [
            ['dynamic','./classic-await.js'],
            ['dynamic','./classic-yield.js']
        ]
    );
    const contextualBindings=scanModuleImports([
        "function f(await){ return await/import('./real-parameter.js')/2; }",
        "const {await}=globalThis; await/import('./real-destructure.js')/2;",
        "var x=1, await=8; await/import('./real-later.js')/2;",
        'void f; void x;'
    ].join('\n'),{importer:'modules/ContextualBindings.js'});
    assert.deepEqual(
        contextualBindings.imports.map(record=>[record.kind,record.specifier]),
        [
            ['dynamic','./real-parameter.js'],
            ['dynamic','./real-destructure.js'],
            ['dynamic','./real-later.js']
        ]
    );
    assert.deepEqual(
        scanModuleImports(
            'const x={...import("event-pubsub")};',
            {importer:'modules/SpreadDynamicImport.js'}
        ).imports.map(record=>[record.kind,record.specifier]),
        [['dynamic','event-pubsub']]
    );
    const lexicalDecoys=scanModuleImports([
        'async function f(){ return await /import\\(".\\/fake-await\\.js"\\)/u; }',
        'function* g(){ yield /import\\(".\\/fake-yield\\.js"\\)/u; }',
        'for (const x of /import\\(".\\/fake-of\\.js"\\)/g) {}',
        'for (let of of /import\\(".\\/fake-binding-of\\.js"\\)/g) {}',
        'export default /import\\(".\\/fake-default\\.js"\\)/u;',
        'class D extends /import\\(".\\/fake-extends\\.js"\\)/.constructor {}',
        'const mixin=()=>class {};',
        "export class Heritage extends mixin({}/import('./real-heritage.js')/2) {}",
        'export class NestedHeritage extends mixin({value:1}) {}',
        '/import\\(".\\/fake-after-class\\.js"\\)/u.test("");',
        'while(true){ break',
        '/import\\(".\\/fake-break\\.js"\\)/u.test(""); }',
        'outer: while(true){ break outer',
        '/import\\(".\\/fake-labeled-break\\.js"\\)/u.test(""); }',
        'next: for(;;){ continue next',
        '/import\\(".\\/fake-labeled-continue\\.js"\\)/u.test(""); }',
        'if(true){} /import\\(".\\/fake-block\\.js"\\)/u.test("");',
        "const ratio={}/import('./real-object.js')/2;",
        'void f; void g; void D; void ratio;'
    ].join('\n'),{importer:'modules/LexicalGoals.js'});
    assert.deepEqual(
        lexicalDecoys.imports.map(record=>[record.kind,record.specifier]),
        [
            ['dynamic','./real-heritage.js'],
            ['dynamic','./real-object.js']
        ]
    );
    assert.throws(
        ()=>scanModuleImports(
            'export function load(target){ import(target)\n{} }',
            {importer:'modules/NonliteralBeforeBlock.js'}
        ),
        error=>error?.code==='ARCANE_IMPORT_MAP_UNRESOLVED'
            &&/NonliteralBeforeBlock\.js/u.test(error.message)
    );
});

test('scanner admits only the authenticated speech worker runtime module authority',()=>{
    assert.deepEqual(
        scanModuleImports(
            'const namespace=await import(entry.moduleUrl);',
            {importer:'sdk/ai/speech-worker-runtime.mjs'}
        ).imports,
        []
    );
    assert.throws(
        ()=>scanModuleImports(
            'const namespace=await import(entry.moduleUrl);',
            {importer:'sdk/ai/other-worker.mjs'}
        ),
        error=>error?.code==='ARCANE_IMPORT_MAP_UNRESOLVED'
    );
    assert.throws(
        ()=>scanModuleImports(
            'const namespace=await import(configuration.runtime.entry);',
            {importer:'sdk/ai/speech-worker-runtime.mjs'}
        ),
        error=>error?.code==='ARCANE_IMPORT_MAP_UNRESOLVED'
    );
});

test('browser remap edges reject query and fragment suffixes that cannot match exact keys',async()=>{
    for(const [specifier,target] of [
        ['event-pubsub?cache=1','sdk/dependencies/event-pubsub/index.js'],
        ['../../node_modules/strong-type/index.js#release','dependencies/strong-type/index.js']
    ]){
        const sources=new Map([
            [
                'modules/Root.js',
                `import dependency from '${specifier}'; export default dependency;\n`
            ],
            [target,'export default class Dependency {}\n']
        ]);
        await assert.rejects(
            buildImportMap({
                files:[...sources.keys()],
                readFile:async relative=>sources.get(relative)
            }),
            error=>error?.code==='ARCANE_IMPORT_MAP_UNRESOLVED'
                &&error.message.includes(specifier)
                &&error.message.includes(target)
            &&/query or fragment.*exact browser import-map key/u.test(error.message)
        );
    }
    const privateSpecifier='#arcane/persistent-ai-chat-session?cache=1';
    const privateSources=new Map([
        ['modules/Root.js',`import '${privateSpecifier}';\n`],
        ['modules/PersistentAIChatSession.js','export default true;\n']
    ]);
    await assert.rejects(
        buildImportMap({
            files:[...privateSources.keys()],
            readFile:async relative=>privateSources.get(relative)
        }),
        error=>error?.code==='ARCANE_IMPORT_MAP_UNRESOLVED'
            &&error.message.includes(privateSpecifier)
            &&/exact browser import-map key/u.test(error.message)
    );
    for(const encodedParent of ['%2e%2e','%2E%2E','%2e%2E','%2E%2e']){
        const specifier=`./${encodedParent}/${encodedParent}/apps/victim/modules/Evil.js`;
        const sources=new Map([
            ['modules/Root.js',`import '${specifier}';\n`]
        ]);
        await assert.rejects(
            buildImportMap({
                files:[...sources.keys()],
                readFile:async relative=>sources.get(relative)
            }),
            error=>error?.code==='ARCANE_IMPORT_MAP_UNRESOLVED'
                &&error.message.includes(specifier)
                &&/percent-encoded path bytes/u.test(error.message)
        );
    }
    const queryPercentSources=new Map([
        ['modules/Root.js',"import './Leaf.js?token=%2e%2e';\n"],
        ['modules/Leaf.js','export default true;\n']
    ]);
    await assert.doesNotReject(buildImportMap({
        files:[...queryPercentSources.keys()],
        readFile:async relative=>queryPercentSources.get(relative)
    }));
    for(const specifier of [
        './a//../victim.js',
        ' ./victim.js',
        './victim.js ',
        './vic\\ttim.js',
        './vic\\ntim.js'
    ]){
        const sources=new Map([
            ['modules/Root.js',`import '${specifier}';\n`],
            ['modules/victim.js','export default false;\n'],
            ['modules/a/victim.js','export default true;\n']
        ]);
        await assert.rejects(
            buildImportMap({
                files:[...sources.keys()],
                readFile:async relative=>sources.get(relative)
            }),
            error=>error?.code==='ARCANE_IMPORT_MAP_UNRESOLVED'
                &&/browser-preprocessed|empty path segment/u.test(error.message)
        );
    }
    for(const unsafePath of [
        'modules/Foo%2fbar.js',
        'modules/Foo?bar.js',
        'modules/Foo#bar.js',
        'modules/Foo bar.js',
        'modules/Foo//bar.js'
    ]){
        await assert.rejects(
            buildImportMap({
                files:[unsafePath],
                readFile:async()=>Buffer.from('export default true;\n')
            }),
            /runtime inventory path (?:is unsafe|is not browser-URL-safe)/u
        );
    }
});

test('invalid application HTML fails before runtime inventory traversal',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    const appRoot=await createApplication(workspaceRoot,'invalid-html-first');
    const entryPath=path.join(appRoot,'index.html');
    const invalid='<script type="module" src="./modules/App.js"></script>\n';
    await writeFile(entryPath,invalid,'utf8');
    await assert.rejects(
        generateImportMap({workspaceRoot,appId:'invalid-html-first'}),
        error=>error?.code==='ARCANE_IMPORT_MAP_INVALID'
            &&/exactly one active <base/iu.test(error.message)
    );
    assert.equal(await readFile(entryPath,'utf8'),invalid);
});

test('HTML inspection honors template/raw-text boundaries, entities, duplicates, and early base order',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    await copyShippedRuntime(workspaceRoot);
    const appRoot=await createApplication(workspaceRoot,'html-structure');
    const entryPath=path.join(appRoot,'index.html');
    const composite=[
        '<!doctype html>',
        '<html>',
        '<head>',
        '    <template>',
        '        <template>',
        '            <script>const fake="</template><base href=\'/poison\'>";</script>',
        '            <style>.fake::after{content:"</template><base href=/poison>"}</style>',
        '            <textarea></template><base href="/poison"></textarea>',
        '            <title></template><link rel="modulepreload" href="/poison.js"></title>',
        '        </template>',
        '    </template>',
        '    <base href="..&#47;..&#x2f;">',
        '    <script>void import("./apps/html-structure/modules/App.js");</script>',
        '    <script src="./classic-bootstrap.js"></script>',
        '    <link rel="module&#112;reload" href="./apps/html-structure/modules/App.js">',
        '</head>',
        '<body>',
        '    <script>const fake="<script type=module src=/poison.js>";</script>',
        '    <script type="mod&#x75;le" src="./modules/App.js"></script>',
        '</body>',
        '</html>',
        ''
    ].join('\n');
    await writeFile(entryPath,composite,'utf8');

    const inspected=inspectImportMapHtml(composite);
    assert.deepEqual(inspected.bases.map(base=>base.href),['../../']);
    assert.equal(inspected.managedMaps.length,0);
    assert.equal(inspected.firstModulePosition,composite.indexOf('<link rel="module&#112;reload"'));

    await generateImportMap({workspaceRoot,appId:'html-structure'});
    const rendered=await readFile(entryPath,'utf8');
    const renderedStructure=inspectImportMapHtml(rendered);
    assert.deepEqual(renderedStructure.bases.map(base=>base.href),['../../']);
    assert.equal(renderedStructure.managedMaps.length,1);
    assert.ok(renderedStructure.bases[0].end<renderedStructure.managedMaps[0].start);
    assert.match(
        rendered.slice(renderedStructure.bases[0].end,renderedStructure.managedMaps[0].start),
        /^[\t\n\f\r ]*$/u
    );
    assert.ok(renderedStructure.managedMaps[0].start<renderedStructure.firstModulePosition);
    assert.ok(renderedStructure.managedMaps[0].start<rendered.indexOf('<script>void import'));

    for(const html of [
        '<base href="../../" href="/last">',
        '<base href="/first" href="../../">',
        '<script type="module" type="text/plain"></script>',
        '<script type="text/plain" type="module"></script>',
        '<link rel="modulepreload" rel="stylesheet">',
        '<link rel="stylesheet" rel="modulepreload">'
    ]){
        assert.throws(()=>inspectImportMapHtml(html),/repeats its (?:href|rel|type) attribute/u);
    }
    assert.throws(
        ()=>inspectImportMapHtml('<base href="..&sol;../">'),
        /unsupported or ambiguous character reference/u
    );
    const selfClosingRaw=[
        '<template/><script type="module" src="/inert-template.js"></script></template>',
        '<style/><base href="/inert-style"></style>',
        '<title/><base href="/inert-title"></title>',
        '<textarea/><base href="/inert-textarea"></textarea>',
        '<xmp/><base href="/inert-xmp"></xmp>',
        '<iframe/><base href="/inert-iframe"></iframe>',
        '<noembed/><base href="/inert-noembed"></noembed>',
        '<noframes/><base href="/inert-noframes"></noframes>',
        '<base href="../../">',
        '<script type="module" /><\/script>'
    ].join('');
    const selfClosingStructure=inspectImportMapHtml(selfClosingRaw);
    assert.deepEqual(selfClosingStructure.bases.map(base=>base.href),['../../']);
    assert.equal(
        selfClosingStructure.firstModulePosition,
        selfClosingRaw.indexOf('<script type="module" />')
    );
    assert.equal(
        inspectImportMapHtml('<plaintext><base href="../../"><script type="module"></script>')
            .bases.length,
        0
    );
    const nonAsciiRaw='<script>void "</ſcript><base href=\'../../\'>";</script>'
        +'<script type="module"></script>';
    assert.equal(inspectImportMapHtml(nonAsciiRaw).bases.length,0);
    const nonAsciiLink=inspectImportMapHtml(
        '<linK rel="modulepreload" href="./fake.js"><base href="../../">'
    );
    assert.equal(nonAsciiLink.links.length,0);
    assert.equal(nonAsciiLink.firstModulePosition,-1);
    const normalizedScriptType=inspectImportMapHtml(
        '<base href="../../"><script type="\t MoDuLe \n" src="./modules/App.js"></script>'
    );
    assert.equal(normalizedScriptType.scripts[0].type,'module');
    assert.equal(
        normalizedScriptType.firstModulePosition,
        normalizedScriptType.scripts[0].start
    );
    assert.equal(
        inspectImportMapHtml(
            '<base href="../../"><script type="\r IMPORTMAP \t" data-arcane-import-map>'
            +'{"imports":{}}</script>'
        ).managedMaps.length,
        1
    );
    const quoteSmuggling='<base href="../../" "><script type="module" '
        +'src="./early.js"></script>';
    assert.equal(
        inspectImportMapHtml(quoteSmuggling).firstModulePosition,
        quoteSmuggling.indexOf('<script')
    );
    assert.throws(
        ()=>inspectImportMapHtml('<noscript><base href="../../"></noscript>'),
        /parsing depends on browser mode/u
    );
    assert.deepEqual(
        inspectImportMapHtml(
            '<!-- <base href="/inert"> --!><base href="../../">'
        ).bases.map(base=>base.href),
        ['../../']
    );
    for(const malformed of [
        '<!bogus><base href="../../">',
        '<?xml?><base href="../../">',
        '<![CDATA[<base href="/ambiguous">]]><base href="../../">',
        '<!doctype svg><base href="../../">',
        '</ div><base href="../../">',
        '</div unexpected><base href="../../">',
        '<base\u00a0href="../../">',
        '<svg><base href="../../"></svg>',
        '<math><base href="../../"></math>',
        '<select><base href="../../"></select><base href="../../">',
        '<select><script></select><base href="../../"><script type="module"></script>',
        '<select "><script type="module"></script></select><base href="../../">',
        '<select><select></select></select>',
        '<select><option>unterminated',
        '<frameset><base href="../../"><script type="importmap">{"imports":{}}</script></frameset>',
        '<frame src="./inert.html"><base href="../../">',
        '<template><frameset><base href="../../"></frameset></template><base href="../../">',
        '<template><frame src="./inert.html"></template><base href="../../">',
        '<script></script',
        '<script><!--<script>const escaped=true;</script>--></script>',
        '<!--><script type="module" src="./early.js"></script><!-- --><base href="../../">',
        '<!---><script type="module" src="./early.js"></script><!-- --><base href="../../">',
        '<div><template shadowrootmode="open"><link rel="modulepreload" '
            +'href="./early.js"></template></div><base href="../../">'
    ]){
        assert.throws(()=>inspectImportMapHtml(malformed),/Application HTML/u,malformed);
    }

    for(const [html,message] of [
        ['<script type="module"></script>','exactly one active'],
        [
            '<base href="../../"><base href="../../"><script type="module"></script>',
            'exactly one active'
        ],
        [
            '<script type="module"></script><base href="../../">',
            'must precede every classic script'
        ],
        [
            '<script src="./classic.js"></script><base href="../../">',
            'must precede every classic script'
        ],
        [
            '<link / rel="modulepreload" href="./early.js"><base href="../../">',
            'nonterminal self-closing slash'
        ],
        [
            '<link/rel="modulepreload" href="./early.js"><base href="../../">',
            'nonterminal self-closing slash'
        ],
        [
            '<script / type="module" src="./early.js"></script><base href="../../">',
            'nonterminal self-closing slash'
        ],
        [nonAsciiRaw,'exactly one active']
    ]){
        const rejectedBytes=`${html}\n`;
        await writeFile(entryPath,rejectedBytes,'utf8');
        await assert.rejects(
            generateImportMap({workspaceRoot,appId:'html-structure'}),
            error=>error?.code==='ARCANE_IMPORT_MAP_INVALID'
                &&error.message.includes(message)
        );
        assert.equal(await readFile(entryPath,'utf8'),rejectedBytes);
    }

    await writeFile(entryPath,[
        '<head>',
        '    <base href="../../" />',
        '    <script>void import("./modules/App.js");</script>',
        '    <script src="./classic.js"></script>',
        '    <script type="module" src="./modules/App.js" /></script>',
        '</head>',
        ''
    ].join('\n'),'utf8');
    await generateImportMap({workspaceRoot,appId:'html-structure'});
    assert.equal(inspectImportMapHtml(await readFile(entryPath,'utf8')).bases.length,1);

    const staticSelect=[
        '<head>',
        '    <base href="../../">',
        '    <select id="mode">',
        '        <!-- static choices -->',
        '        <optgroup label="Modes">',
        '            <option value="safe">Safe</option>',
        '            <option value="strict">Strict</option>',
        '        </optgroup>',
        '    </select>',
        '    <script type="module" src="./modules/App.js"></script>',
        '</head>',
        ''
    ].join('\n');
    await writeFile(entryPath,staticSelect,'utf8');
    await generateImportMap({workspaceRoot,appId:'html-structure'});
    assert.equal(inspectImportMapHtml(await readFile(entryPath,'utf8')).bases.length,1);
});

test('regeneration is byte-stable, removes stale entries, and preserves prior files on scan failure',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    const appRoot=await createApplication(workspaceRoot,'stable-map');
    await writeWorkspaceFile(workspaceRoot,'arcane/modules/Root.js',[
        "import './Leaf.mjs?v=7#release';",
        "import Thing from '../entities/Thing.js?shape=1';",
        "import Is from '../../node_modules/strong-type/index.js';",
        'export {Thing,Is};',
        ''
    ].join('\n'));
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/modules/Leaf.mjs',
        'export const leaf=true;\n'
    );
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/modules/Classic.js',
        'globalThis.classic="export default ignored";\n'
    );
    await writeWorkspaceFile(workspaceRoot,'arcane/entities/Thing.js',[
        "import {leaf} from '../modules/Leaf.mjs';",
        'export default class Thing { constructor(){ this.leaf=leaf; } }',
        ''
    ].join('\n'));
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/dependencies/strong-type/index.js',
        'export default class Is {}\n'
    );
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/dependencies/strong-type/package.json',
        '{"name":"strong-type","version":"1.1.0","type":"module"}\n'
    );
    await writeSdkBrowserGraph(workspaceRoot);
    const artifactPath=path.join(appRoot,'modules','arcane.importmap.json');
    await writeFile(artifactPath,'{"imports":{"stale":"./stale.js"}}\n','utf8');
    const entryPath=path.join(appRoot,'index.html');
    await writeFile(entryPath,[
        '<!doctype html>',
        '<base href="../../">',
        '<script type="module" src="./apps/stable-map/modules/App.js"></script>',
        '<script type="importmap" data-arcane-import-map>',
        '{"imports":{"stale":"./stale.js"}}',
        '</script>',
        ''
    ].join('\n'),'utf8');

    const first=await generateImportMap({workspaceRoot,appId:'stable-map'});
    assert.deepEqual(first.imports,{
        'arcane/Leaf':'./arcane/modules/Leaf.mjs',
        'arcane/Root':'./arcane/modules/Root.js',
        'arcane/entities/Thing':'./arcane/entities/Thing.js',
        'arcane-os/ai/browser-speech':'./arcane/sdk/ai/browser-speech.mjs',
        'arcane-os/ai/browser-wasm':'./arcane/sdk/ai/browser-wasm.mjs',
        'arcane-os/event-manager':'./arcane/sdk/event-manager.mjs',
        'event-pubsub':'./arcane/sdk/dependencies/event-pubsub/index.js',
        './node_modules/strong-type/index.js':'./arcane/dependencies/strong-type/index.js'
    });
    const firstArtifact=await readFile(artifactPath,'utf8');
    const firstHtml=await readFile(entryPath,'utf8');
    assert.doesNotMatch(firstArtifact,/stale/u);
    assert.ok(firstHtml.indexOf('data-arcane-import-map')<firstHtml.indexOf('type="module"'));

    await generateImportMap({workspaceRoot,appId:'stable-map'});
    assert.equal(await readFile(artifactPath,'utf8'),firstArtifact);
    assert.equal(await readFile(entryPath,'utf8'),firstHtml);

    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/modules/Root.js',
        "import './Missing.js?v=2#broken'; export default true;\n"
    );
    await assert.rejects(
        generateImportMap({workspaceRoot,appId:'stable-map'}),
        error=>error?.code==='ARCANE_IMPORT_MAP_UNRESOLVED'
            &&error.message.includes('modules/Root.js')
            &&error.message.includes('./Missing.js?v=2#broken')
            &&error.message.includes('modules/Missing.js')
            &&error.message.includes('rerun arcane import-map')
    );
    assert.equal(await readFile(artifactPath,'utf8'),firstArtifact);
    assert.equal(await readFile(entryPath,'utf8'),firstHtml);
});

test('paired writes verify stages, roll back partial installs, and clean owned transaction files',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    await copyShippedRuntime(workspaceRoot);
    const appRoot=await createApplication(workspaceRoot,'transaction-map');
    const artifactPath=path.join(appRoot,'modules','arcane.importmap.json');
    const entryPath=path.join(appRoot,'index.html');
    await generateImportMap({workspaceRoot,appId:'transaction-map'});
    const originalArtifact=await readFile(artifactPath,'utf8');
    const originalEntry=await readFile(entryPath,'utf8');

    await assert.rejects(
        generateImportMap({
            workspaceRoot,
            appId:'transaction-map',
            onEvent(event){
                if(event.type==='import-map.commit.staged')throw new Error('injected staged failure');
            }
        }),
        /injected staged failure/u
    );
    assert.equal(await readFile(artifactPath,'utf8'),originalArtifact);
    assert.equal(await readFile(entryPath,'utf8'),originalEntry);
    assert.deepEqual(await transactionFiles(appRoot),[]);

    await assert.rejects(
        generateImportMap({
            workspaceRoot,
            appId:'transaction-map',
            async onEvent(event){
                if(event.type!=='import-map.commit.staged')return;
                const stages=await transactionFiles(appRoot);
                const artifactStage=stages.find(file=>path.basename(file)
                    .startsWith('.arcane.importmap.json.arcane-stage-'));
                assert.ok(artifactStage);
                await writeFile(artifactStage,'attacker-controlled stage\n','utf8');
            }
        }),
        /identity or content check|changed before promotion/u
    );
    assert.equal(await readFile(artifactPath,'utf8'),originalArtifact);
    assert.equal(await readFile(entryPath,'utf8'),originalEntry);
    assert.deepEqual(await transactionFiles(appRoot),[]);

    for(const attack of ['truncate','remove']){
        let sawCompleted=false;
        await assert.rejects(
            generateImportMap({
                workspaceRoot,
                appId:'transaction-map',
                async onEvent(event){
                    if(event.type==='import-map.completed')sawCompleted=true;
                    if(event.type!=='import-map.commit.progress')return;
                    if(attack==='truncate')await writeFile(artifactPath,'', 'utf8');
                    else await rm(artifactPath);
                }
            }),
            /changed before promotion|failed its identity or content check|ENOENT/u
        );
        assert.equal(sawCompleted,false);
        assert.equal(await readFile(artifactPath,'utf8'),originalArtifact);
        assert.equal(await readFile(entryPath,'utf8'),originalEntry);
        assert.deepEqual(await transactionFiles(appRoot),[]);
    }

    await rm(artifactPath);
    await assert.rejects(
        generateImportMap({
            workspaceRoot,
            appId:'transaction-map',
            onEvent(event){
                if(event.type==='import-map.commit.progress'){
                    throw new Error('injected second-file failure');
                }
            }
        }),
        /injected second-file failure/u
    );
    assert.equal(await exists(artifactPath),false);
    assert.equal(await readFile(entryPath,'utf8'),originalEntry);
    assert.deepEqual(await transactionFiles(appRoot),[]);
});

test('cancellation rolls back before commit and cannot retract a completed pair',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    await copyShippedRuntime(workspaceRoot);
    const appRoot=await createApplication(workspaceRoot,'cancel-map');
    const artifactPath=path.join(appRoot,'modules','arcane.importmap.json');
    const entryPath=path.join(appRoot,'index.html');
    const initial=await generateImportMap({workspaceRoot,appId:'cancel-map'});
    assert.equal(initial.committed,true);
    const committedArtifact=await readFile(artifactPath,'utf8');
    const committedEntry=await readFile(entryPath,'utf8');

    for(const eventType of ['import-map.commit.staged','import-map.commit.progress']){
        const controller=new AbortController();
        const reason=new Error(`cancel at ${eventType}`);
        await assert.rejects(
            generateImportMap({
                workspaceRoot,
                appId:'cancel-map',
                signal:controller.signal,
                onEvent(event){
                    if(event.type===eventType)controller.abort(reason);
                }
            }),
            error=>error===reason&&error.code==='ARCANE_CANCELLED'
        );
        assert.equal(await readFile(artifactPath,'utf8'),committedArtifact);
        assert.equal(await readFile(entryPath,'utf8'),committedEntry);
        assert.deepEqual(await transactionFiles(appRoot),[]);
    }

    const completedController=new AbortController();
    let completedEvent;
    const result=await generateImportMap({
        workspaceRoot,
        appId:'cancel-map',
        signal:completedController.signal,
        onEvent(event){
            if(event.type!=='import-map.completed')return;
            completedEvent=event;
            completedController.abort(new Error('too late to cancel committed files'));
        }
    });
    assert.equal(completedController.signal.aborted,true);
    assert.equal(completedEvent.committed,true);
    assert.equal(result.committed,true);
    assert.equal(await readFile(artifactPath,'utf8'),committedArtifact);
    assert.equal(await readFile(entryPath,'utf8'),committedEntry);
    assert.deepEqual(await transactionFiles(appRoot),[]);

    const observerFailure=new Error('completed observer failed after pair verification');
    const listenerResult=await generateImportMap({
        workspaceRoot,
        appId:'cancel-map',
        onEvent(event){
            if(event.type==='import-map.completed')throw observerFailure;
        }
    });
    assert.equal(listenerResult.committed,true);
    assert.deepEqual(listenerResult.eventDelivery,{
        status:'degraded',
        errorCode:'ARCANE_EVENT_DELIVERY_FAILED',
        message:observerFailure.message
    });
    assert.equal(await readFile(artifactPath,'utf8'),committedArtifact);
    assert.equal(await readFile(entryPath,'utf8'),committedEntry);

});

test('stage, parent, and static symlink swaps cannot poison generated files',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    await copyShippedRuntime(workspaceRoot);
    const appRoot=await createApplication(workspaceRoot,'swap-map');
    const modulesRoot=path.join(appRoot,'modules');
    const artifactPath=path.join(modulesRoot,'arcane.importmap.json');
    const entryPath=path.join(appRoot,'index.html');
    await generateImportMap({workspaceRoot,appId:'swap-map'});
    const originalArtifact=await readFile(artifactPath,'utf8');
    const originalEntry=await readFile(entryPath,'utf8');

    let swappedStage;
    let heldStage;
    await assert.rejects(
        generateImportMap({
            workspaceRoot,
            appId:'swap-map',
            async onEvent(event){
                if(event.type!=='import-map.commit.staged')return;
                const stages=await transactionFiles(appRoot);
                swappedStage=stages.find(file=>path.basename(file)
                    .startsWith('.arcane.importmap.json.arcane-stage-'));
                assert.ok(swappedStage);
                heldStage=`${swappedStage}.held`;
                await rename(swappedStage,heldStage);
                await writeFile(swappedStage,'do not promote me\n','utf8');
            }
        }),
        error=>/changed before promotion/u.test(error.message)&&error.cleanupError instanceof Error
    );
    assert.equal(await readFile(swappedStage,'utf8'),'do not promote me\n');
    assert.equal(await readFile(artifactPath,'utf8'),originalArtifact);
    assert.equal(await readFile(entryPath,'utf8'),originalEntry);
    await rm(swappedStage,{force:true});
    await rm(heldStage,{force:true});
    for(const leftover of await transactionFiles(appRoot))await rm(leftover,{force:true});

    const heldModules=`${modulesRoot}.held`;
    await assert.rejects(
        generateImportMap({
            workspaceRoot,
            appId:'swap-map',
            async onEvent(event){
                if(event.type!=='import-map.commit.staged')return;
                await rename(modulesRoot,heldModules);
                await mkdir(modulesRoot);
            }
        }),
        error=>/directory changed/u.test(error.message)&&error.cleanupError instanceof Error
    );
    await rm(modulesRoot,{recursive:true});
    await rename(heldModules,modulesRoot);
    assert.equal(await readFile(artifactPath,'utf8'),originalArtifact);
    assert.equal(await readFile(entryPath,'utf8'),originalEntry);
    for(const leftover of await transactionFiles(appRoot))await rm(leftover,{force:true});

    const outside=path.join(workspaceRoot,'outside-sentinel.txt');
    const heldArtifact=`${artifactPath}.held`;
    await writeFile(outside,'outside remains unchanged\n','utf8');
    await rename(artifactPath,heldArtifact);
    let linked=true;
    try{await symlink(outside,artifactPath,'file');}
    catch(error){
        if(error?.code!=='EPERM'&&error?.code!=='EACCES')throw error;
        linked=false;
    }
    if(linked){
        await assert.rejects(
            generateImportMap({workspaceRoot,appId:'swap-map'}),
            /must be a real file/u
        );
        assert.equal(await readFile(outside,'utf8'),'outside remains unchanged\n');
        assert.equal(await readFile(entryPath,'utf8'),originalEntry);
        await rm(artifactPath);
    }
    await rename(heldArtifact,artifactPath);

    const outsideModules=await temporaryDirectory(t,{prefix:'arcane-import-map-outside-'});
    const heldStaticModules=`${modulesRoot}.static-held`;
    await writeFile(path.join(outsideModules,'sentinel.txt'),'outside directory unchanged\n');
    await rename(modulesRoot,heldStaticModules);
    let linkedDirectory=true;
    try{
        await symlink(outsideModules,modulesRoot,process.platform==='win32'?'junction':'dir');
    }catch(error){
        if(error?.code!=='EPERM'&&error?.code!=='EACCES')throw error;
        linkedDirectory=false;
    }
    if(linkedDirectory){
        await assert.rejects(
            generateImportMap({workspaceRoot,appId:'swap-map'}),
            /real directory|symbolic link|junction|resolves outside/u
        );
        assert.equal(
            await readFile(path.join(outsideModules,'sentinel.txt'),'utf8'),
            'outside directory unchanged\n'
        );
        assert.equal(await exists(path.join(outsideModules,'arcane.importmap.json')),false);
        await rm(modulesRoot);
    }
    await rename(heldStaticModules,modulesRoot);
});

test('generator serializes sibling calls and accepts only an explicit active workspace lease',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    await copyShippedRuntime(workspaceRoot);
    await createApplication(workspaceRoot,'locked-map');
    let releaseStage;
    const stageRelease=new Promise(resolve=>{releaseStage=resolve;});
    let reportStaged;
    const staged=new Promise(resolve=>{reportStaged=resolve;});
    const first=generateImportMap({
        workspaceRoot,
        appId:'locked-map',
        async onEvent(event){
            if(event.type!=='import-map.commit.staged')return;
            reportStaged();
            await stageRelease;
        }
    });
    await staged;
    await assert.rejects(
        generateImportMap({workspaceRoot,appId:'locked-map'}),
        error=>error?.code==='ARCANE_WORKSPACE_BUSY'
    );
    releaseStage();
    await first;

    await withWorkspaceOperationLock(
        {workspaceRoot,operation:'import-map-test'},
        lease=>generateImportMap({
            workspaceRoot,
            appId:'locked-map',
            workspaceOperationLease:lease
        })
    );
    assert.equal(
        await exists(path.join(workspaceRoot,'.arcane','workspace-operation.lock.json')),
        false
    );
});

test('case, NFC, and extensionless module-name collisions fail deterministically',async()=>{
    async function collision(files){
        return buildImportMap({
            files,
            readFile:async relative=>JAVASCRIPT_SOURCES.get(relative)
        });
    }
    const JAVASCRIPT_SOURCES=new Map([
        ['modules/Foo.js','export const js=true;'],
        ['modules/foo.mjs','export const mjs=true;'],
        ['modules/Caf\u00e9.js','export const composed=true;'],
        ['modules/Cafe\u0301.mjs','export const decomposed=true;']
    ]);
    await assert.rejects(
        collision(['modules/Foo.js','modules/foo.mjs']),
        error=>error?.code==='ARCANE_IMPORT_MAP_COLLISION'
            &&/case\/NFC key/u.test(error.message)
    );
    await assert.rejects(
        collision(['modules/Caf\u00e9.js','modules/Cafe\u0301.mjs']),
        error=>error?.code==='ARCANE_IMPORT_MAP_COLLISION'
            &&/case\/NFC key/u.test(error.message)
    );
});

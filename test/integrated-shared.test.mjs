import assert from 'node:assert/strict';
import {appendFile,lstat,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
    buildApplication,
    checkApplication,
    createApplication,
    loadArcaneIntegratedProvider,
    packageApplication,
    testApplication
} from '../src/index.mjs';
import {temporaryDirectory} from './helpers.mjs';

const PROTOCOL='arcane-integrated-toolchain/1';

async function writeJson(filePath,value){
    await mkdir(path.dirname(filePath),{recursive:true});
    await writeFile(filePath,`${JSON.stringify(value,null,2)}\n`);
}

function sharedRoutes(mode){
    if(mode==='external'){
        return [
            {
                source:'node_modules/arcane-os/runtime/arcane',
                destination:'arcane',
                include:['components','css','entities','img','modules'],
                exclude:[]
            },
            {
                source:'node_modules/arcane-os/runtime/strong-type',
                destination:'node_modules/strong-type',
                include:['index.js','licence','package.json'],
                exclude:[]
            },
            {
                source:'node_modules/arcane-os',
                destination:'licenses/arcane-os',
                include:['LICENSE','COMMERCIAL-LICENSE.md','NOTICE'],
                exclude:[]
            }
        ];
    }
    return [
        {
            source:'arcane',
            destination:'arcane',
            include:['components','css','entities','img','modules'],
            exclude:[]
        },
        {
            source:'node_modules/strong-type',
            destination:'node_modules/strong-type',
            include:['index.js','licence','package.json'],
            exclude:[]
        }
    ];
}

function fixtureProviderSource({gateKey}={}){
    const gate=gateKey
        ?`const gate=globalThis[${JSON.stringify(gateKey)}];\ngate.initializations+=1;\ngate.entered();\nawait gate.release;\n`
        :'';
    return `import path from 'node:path';
${gate}export const INTEGRATED_TOOLCHAIN_PROTOCOL=${JSON.stringify(PROTOCOL)};
const operations=Object.freeze([
    Object.freeze({id:'focused-test'}),
    Object.freeze({id:'development-check'})
]);
const description=Object.freeze({protocol:INTEGRATED_TOOLCHAIN_PROTOCOL,operations});
function prepare({operation,workspaceRoot,testFile}={}){
    if(operation==='focused-test'){
        return Object.freeze({
            operation,
            command:process.execPath,
            args:Object.freeze([path.join(workspaceRoot,'tools','run-focused-tests.mjs'),testFile]),
            cwd:workspaceRoot
        });
    }
    if(operation==='development-check'){
        return Object.freeze({
            operation,
            command:'npm',
            args:Object.freeze(['run','check']),
            cwd:workspaceRoot
        });
    }
    const error=new Error('Unsupported fixture operation.');
    error.code='ARCANE_INTEGRATED_OPERATION_UNSUPPORTED';
    throw error;
}
async function execute({operation,workspaceRoot,testFile,signal,onEvent,run}={}){
    const invocation=prepare({operation,workspaceRoot,testFile});
    await onEvent?.(Object.freeze({
        type:'integrated.fixture.running',
        message:'Running the fixed integrated fixture operation.'
    }));
    const result=await run(invocation.command,[...invocation.args],{
        cwd:invocation.cwd,
        signal,
        onEvent
    });
    if(result?.code!==0||result?.signal){
        const error=new Error('The integrated fixture process failed.');
        error.code='ARCANE_INTEGRATED_OPERATION_FAILED';
        throw error;
    }
    return Object.freeze({operation,status:'completed',invocation});
}
function describe(){return description;}
export const integratedDevelopmentProvider=Object.freeze({
    protocol:INTEGRATED_TOOLCHAIN_PROTOCOL,
    describe,
    prepare,
    execute
});
`;
}

async function createSharedWorkspace(t,{mode='integrated',gateKey}={}){
    const workspaceRoot=await temporaryDirectory(t,{prefix:`arcane-sdk-${mode}-shared-`});
    await writeJson(path.join(workspaceRoot,'arcane-packager.json'),{
        schemaVersion:1,
        appsRoot:'apps',
        distRoot:'dist',
        sharedPayloads:{'browser-runtime':sharedRoutes(mode)}
    });
    await writeJson(path.join(workspaceRoot,'package.json'),{
        name:mode==='integrated'?'arcane-os':'external-fixture',
        private:true,
        type:'module',
        scripts:{check:'node --test'}
    });
    if(mode==='integrated'){
        await mkdir(path.join(workspaceRoot,'tools'),{recursive:true});
        await mkdir(path.join(workspaceRoot,'test'),{recursive:true});
        await writeFile(
            path.join(workspaceRoot,'tools','integrated-development-provider.mjs'),
            fixtureProviderSource({gateKey})
        );
        await writeFile(
            path.join(workspaceRoot,'tools','run-focused-tests.mjs'),
            "throw new Error('The injected process runner should own this fixture.');\n"
        );
        await writeFile(
            path.join(workspaceRoot,'test','selected.test.mjs'),
            "import test from 'node:test';\ntest('selected fixture',()=>{});\n"
        );
    }
    return workspaceRoot;
}

function successfulRunner(calls){
    return async function run(command,args,options){
        calls.push({command,args,options});
        return {code:0,signal:null,stdout:'',stderr:''};
    };
}

test('shared scope runs one exact focused test through the fixed integrated provider',async t=>{
    const workspaceRoot=await createSharedWorkspace(t,{});
    const calls=[];
    const events=[];
    const result=await testApplication({
        workspaceRoot,
        scope:'shared',
        testFile:'test/selected.test.mjs',
        processRunner:successfulRunner(calls),
        onEvent:event=>events.push(event)
    });

    assert.equal(result.scope,'shared');
    assert.equal(result.workspaceMode,'integrated');
    assert.equal(result.workspaceRoot,workspaceRoot);
    assert.equal(result.result.operation,'focused-test');
    assert.equal(calls.length,1);
    assert.equal(calls[0].command,process.execPath);
    assert.deepEqual(calls[0].args,[
        path.join(workspaceRoot,'tools','run-focused-tests.mjs'),
        'test/selected.test.mjs'
    ]);
    assert.equal(calls[0].options.cwd,workspaceRoot);
    assert.equal(events[0].type,'shared.test.started');
    assert.ok(events.some(event=>event.type==='integrated.provider.verified'));
    assert.equal(events.at(-1).type,'shared.test.completed');
    await assert.rejects(lstat(path.join(workspaceRoot,'dist')),{code:'ENOENT'});
    await assert.rejects(lstat(path.join(workspaceRoot,'build')),{code:'ENOENT'});
});

test('external app scope preserves workspace-root and selected-app tests',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-sdk-external-test-scope-'});
    const workspaceRoot=path.join(parent,'workspace');
    await createApplication({
        targetPath:workspaceRoot,
        appId:'external-app',
        displayName:'External App'
    });
    await mkdir(path.join(workspaceRoot,'test'),{recursive:true});
    await writeFile(
        path.join(workspaceRoot,'test','workspace-root.test.mjs'),
        "import test from 'node:test';\ntest('external root test remains selected',()=>{});\n"
    );

    const result=await testApplication({
        workspaceRoot,
        appId:'external-app',
        scope:'app'
    });
    assert.equal(result.workspaceMode,'external');
    assert.ok(result.testFiles.includes('test/workspace-root.test.mjs'));
    assert.ok(result.testFiles.some(file=>file.startsWith('apps/external-app/test/')));
});

test('shared scope exposes only the canonical development check and propagates runner failure',async t=>{
    const workspaceRoot=await createSharedWorkspace(t,{});
    const calls=[];
    const checked=await checkApplication({
        workspaceRoot,
        scope:'shared',
        processRunner:successfulRunner(calls)
    });
    assert.equal(checked.result.operation,'development-check');
    assert.equal(calls.length,1);
    assert.equal(calls[0].command,'npm');
    assert.deepEqual(calls[0].args,['run','check']);

    await assert.rejects(
        checkApplication({
            workspaceRoot,
            scope:'shared',
            processRunner:async()=>({code:7,signal:null,stdout:'',stderr:'failed'})
        }),
        error=>error?.code==='ARCANE_INTEGRATED_OPERATION_FAILED'
    );
});

test('shared scope forwards active cancellation through the owned process boundary',async t=>{
    const workspaceRoot=await createSharedWorkspace(t,{});
    const controller=new AbortController();
    const events=[];
    let markStarted;
    const started=new Promise(resolve=>{markStarted=resolve;});
    const operation=checkApplication({
        workspaceRoot,
        scope:'shared',
        signal:controller.signal,
        onEvent:event=>events.push(event),
        processRunner:async(_command,_args,{signal})=>{
            markStarted();
            return new Promise((_resolve,reject)=>{
                signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
            });
        }
    });
    await started;
    controller.abort(new Error('cancel shared fixture'));
    await assert.rejects(operation,/cancel shared fixture/);
    assert.ok(events.some(event=>event.type==='shared.check.cancellation-pending'));
    assert.equal(events.some(event=>event.type==='shared.check.completed'),false);
});

test('shared scope is integrated-only and app output operations fail before workspace work',async t=>{
    const externalRoot=await createSharedWorkspace(t,{mode:'external'});
    await assert.rejects(
        testApplication({
            workspaceRoot:externalRoot,
            scope:'shared',
            testFile:'test/selected.test.mjs'
        }),
        error=>error?.code==='ARCANE_POLICY_DENIED'
    );

    for(const operation of [packageApplication,buildApplication]){
        await assert.rejects(
            operation({workspaceRoot:externalRoot,scope:'shared'}),
            error=>error?.code==='ARCANE_USAGE'&&/only --scope app/u.test(error.message)
        );
    }
    await assert.rejects(lstat(path.join(externalRoot,'dist')),{code:'ENOENT'});
    await assert.rejects(lstat(path.join(externalRoot,'build')),{code:'ENOENT'});
});

test('concurrent first loads share one reservation and poison it if provider bytes change',async t=>{
    const gateKey=`arcane-integrated-provider-gate-${process.pid}-${Date.now()}`;
    let enter;
    let release;
    const entered=new Promise(resolve=>{enter=resolve;});
    const blocked=new Promise(resolve=>{release=resolve;});
    globalThis[gateKey]={
        initializations:0,
        entered:enter,
        release:blocked
    };
    t.after(()=>{delete globalThis[gateKey];});
    const workspaceRoot=await createSharedWorkspace(t,{gateKey});
    const providerPath=path.join(workspaceRoot,'tools','integrated-development-provider.mjs');

    const first=loadArcaneIntegratedProvider({arcaneRoot:workspaceRoot});
    const state=globalThis[Symbol.for('arcane-os-sdk.integrated-provider-state.v1')];
    const reservation=[...state.records.values()].find(record=>
        record.requestedRoot===path.resolve(workspaceRoot)
    );
    assert.ok(reservation);
    assert.equal(reservation.state,'reserved');
    const second=loadArcaneIntegratedProvider({arcaneRoot:workspaceRoot});
    const sharedReservation=[...state.records.values()].find(record=>
        record.requestedRoot===path.resolve(workspaceRoot)
    );
    assert.equal(sharedReservation,reservation);
    await entered;
    await appendFile(providerPath,'\n// changed while the first import was reserved\n');
    await new Promise(resolve=>setImmediate(resolve));
    release();

    const settled=await Promise.allSettled([first,second]);
    assert.ok(settled.every(result=>result.status==='rejected'));
    assert.ok(settled.every(result=>
        result.reason?.code==='ARCANE_INTEGRATED_PROVIDER_RESTART_REQUIRED'
    ));
    assert.equal(globalThis[gateKey].initializations,1);
    await assert.rejects(
        loadArcaneIntegratedProvider({arcaneRoot:workspaceRoot}),
        error=>error?.code==='ARCANE_INTEGRATED_PROVIDER_RESTART_REQUIRED'
    );
    assert.equal(globalThis[gateKey].initializations,1);

    const source=await readFile(providerPath,'utf8');
    assert.match(source,/changed while the first import was reserved/u);
});

test('provider loading rejects comment-separated static and dynamic imports',async t=>{
    for(const [label,statement] of [
        ['dynamic',"import/*gap*/('data:text/javascript,export default 1');"],
        ['static',"import/*gap*/'data:text/javascript,export default 1';"]
    ]){
        const workspaceRoot=await createSharedWorkspace(t,{});
        const providerPath=path.join(workspaceRoot,'tools','integrated-development-provider.mjs');
        const source=await readFile(providerPath,'utf8');
        await writeFile(providerPath,`${statement}\n${source}`);
        await assert.rejects(
            loadArcaneIntegratedProvider({arcaneRoot:workspaceRoot}),
            error=>error?.code==='ARCANE_INTEGRITY_FAILED'
                &&/only one-line static Node built-in imports/u.test(error.message),
            label
        );
    }
});

test('provider loading cancellation stops waiting for a shared initialization',async t=>{
    const gateKey=`arcane-integrated-provider-cancel-${process.pid}-${Date.now()}`;
    let enter;
    let release;
    const entered=new Promise(resolve=>{enter=resolve;});
    const blocked=new Promise(resolve=>{release=resolve;});
    globalThis[gateKey]={initializations:0,entered:enter,release:blocked};
    t.after(()=>{delete globalThis[gateKey];});
    const workspaceRoot=await createSharedWorkspace(t,{gateKey});
    const controller=new AbortController();
    const loading=loadArcaneIntegratedProvider({
        arcaneRoot:workspaceRoot,
        signal:controller.signal
    });
    await entered;
    const reason=new Error('cancel provider initialization wait');
    controller.abort(reason);
    try{
        await assert.rejects(
            loading,
            error=>error?.code==='ARCANE_CANCELLED'&&error?.cause===reason
        );
    }finally{
        release();
    }
    assert.equal(globalThis[gateKey].initializations,1);
});

import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {
    getSdkRoot,
    listRuntimeFiles,
    loadRuntimeRelease,
    readRuntimeFile
} from '../src/runtime.mjs';
import {
    getSdkBrowserRuntimeRoot,
    listSdkBrowserRuntimeFiles,
    loadSdkBrowserRuntimeRelease,
    readSdkBrowserRuntimeFile
} from '../src/sdk-browser-runtime.mjs';
import {materializeWorkspaceRuntimeContent} from '../src/workspace-runtime.mjs';

async function fixture(t){
    const temporaryRoot=fileURLToPath(new URL('../.arcane/test-runtime-content/',import.meta.url));
    await mkdir(temporaryRoot,{recursive:true});
    const root=await mkdtemp(path.join(temporaryRoot,'arcane-runtime-content-'));
    t.after(()=>rm(root,{recursive:true,force:true}));
    const runtimeRoot=path.join(root,'runtime');
    const browserRuntimeRoot=path.join(root,'browser-runtime');
    const workspaceRoot=path.join(root,'workspace');
    await Promise.all([
        mkdir(path.join(runtimeRoot,'arcane','modules'),{recursive:true}),
        mkdir(path.join(runtimeRoot,'strong-type'),{recursive:true}),
        mkdir(path.join(browserRuntimeRoot,'ai'),{recursive:true}),
        mkdir(workspaceRoot,{recursive:true})
    ]);
    const moduleContent='export const complete = "all content, including trailing space ";\n';
    const dependencyContent='export const type = "complete dependency";\n';
    const browserContent='export const browser = "complete browser runtime";\n';
    await Promise.all([
        writeFile(path.join(runtimeRoot,'arcane','modules','Complete.js'),moduleContent),
        writeFile(path.join(runtimeRoot,'strong-type','index.mjs'),dependencyContent),
        writeFile(path.join(browserRuntimeRoot,'ai','complete.mjs'),browserContent),
        writeFile(path.join(runtimeRoot,'ARCANE_RUNTIME_RELEASE.json'),'{}\n'),
        writeFile(path.join(browserRuntimeRoot,'ARCANE_SDK_BROWSER_RELEASE.json'),'{}\n')
    ]);
    return {
        runtimeRoot,
        browserRuntimeRoot,
        workspaceRoot,
        moduleContent,
        dependencyContent,
        browserContent
    };
}

test('runtime APIs expose complete structural file inventories and content',async t=>{
    const selected=await fixture(t);
    assert.equal(typeof getSdkRoot(),'string');
    assert.equal(typeof getSdkBrowserRuntimeRoot(),'string');
    assert.deepEqual(await listRuntimeFiles({runtimeRoot:selected.runtimeRoot}),[
        'arcane/modules/Complete.js',
        'strong-type/index.mjs'
    ]);
    assert.deepEqual(await listSdkBrowserRuntimeFiles({
        browserRuntimeRoot:selected.browserRuntimeRoot
    }),['ai/complete.mjs']);
    assert.equal((await readRuntimeFile({
        runtimeRoot:selected.runtimeRoot,
        relativePath:'arcane/modules/Complete.js'
    })).toString('utf8'),selected.moduleContent);
    assert.equal((await readSdkBrowserRuntimeFile({
        browserRuntimeRoot:selected.browserRuntimeRoot,
        relativePath:'ai/complete.mjs'
    })).toString('utf8'),selected.browserContent);

    const runtime=await loadRuntimeRelease({runtimeRoot:selected.runtimeRoot});
    const browser=await loadSdkBrowserRuntimeRelease({
        browserRuntimeRoot:selected.browserRuntimeRoot
    });
    assert.deepEqual(runtime.files,['arcane/modules/Complete.js','strong-type/index.mjs']);
    assert.deepEqual(browser.files,['ai/complete.mjs']);
});

test('workspace materialization copies every selected source file without altering content',async t=>{
    const selected=await fixture(t);
    t.mock.method(globalThis,'fetch',async function unexpectedAcquisition(){
        assert.fail('Default materialization must not acquire optional browser executables.');
    });
    const result=await materializeWorkspaceRuntimeContent(selected);
    assert.equal(Object.hasOwn(result,'browserDecisions'),false);
    assert.equal(result.runtimeRoot,path.join(selected.workspaceRoot,'arcane'));
    assert.equal(await readFile(
        path.join(selected.workspaceRoot,'arcane','modules','Complete.js'),
        'utf8'
    ),selected.moduleContent);
    assert.equal(await readFile(
        path.join(selected.workspaceRoot,'arcane','dependencies','strong-type','index.mjs'),
        'utf8'
    ),selected.dependencyContent);
    assert.equal(await readFile(
        path.join(selected.workspaceRoot,'arcane','sdk','ai','complete.mjs'),
        'utf8'
    ),selected.browserContent);
});

test('local decision materialization acquires the complete selected upstream closure concurrently',async t=>{
    const selected=await fixture(t);
    const calls=[];
    const events=[];
    let release;
    const allStarted=new Promise(resolve=>{release=resolve;});
    const moduleContent='export const exact = "雪 ?v=unchanged";\n';
    const wasmContent=new Uint8Array([0,97,115,109,0,255,0]);
    t.mock.method(globalThis,'fetch',async function distributionFetch(url,{signal}){
        calls.push(url);
        assert.equal(signal.aborted,false);
        assert.equal(events[0].type,'workspace.decisions.started');
        if(calls.length===5)release();
        await allStarted;
        return new Response(url.endsWith('.wasm')?wasmContent:moduleContent);
    });
    const result=await materializeWorkspaceRuntimeContent({
        ...selected,
        browserDecisions:true,
        onEvent(event){
            if(event.type.startsWith('workspace.decisions.'))events.push(event);
        }
    });
    const transformers='https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/';
    const onnx='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/';
    assert.deepEqual(calls,[
        `${transformers}dist/transformers.min.js`,
        `${onnx}dist/ort-wasm-simd-threaded.asyncify.mjs`,
        `${onnx}dist/ort-wasm-simd-threaded.asyncify.wasm`,
        `${transformers}LICENSE`,
        `${onnx}LICENSE`
    ]);
    assert.equal(result.browserDecisions.transformersVersion,'4.3.0');
    assert.equal(result.browserDecisions.onnxRuntimeVersion,'1.31.0-dev.20260914-8d85527a0');
    assert.deepEqual(result.browserDecisions.files,[
        'transformers.min.js','ort-wasm-simd-threaded.asyncify.mjs',
        'ort-wasm-simd-threaded.asyncify.wasm','TRANSFORMERS-LICENSE','ONNX-RUNTIME-LICENSE'
    ]);
    for(const file of result.browserDecisions.files){
        const content=await readFile(path.join(result.browserDecisions.directory,file));
        if(file.endsWith('.wasm'))assert.deepEqual(new Uint8Array(content),wasmContent);
        else assert.equal(content.toString('utf8'),moduleContent);
    }
    assert.deepEqual(events.map(event=>event.completed),[0,1,2,3,4,5]);
    assert.ok(events.every(event=>event.total===5));
});

test('decision distribution HTTP and observer failures preserve the previous runtime',async t=>{
    for(const failureKind of ['http','observer']){
        const selected=await fixture(t);
        const destination=path.join(selected.workspaceRoot,'arcane');
        await mkdir(destination);
        await writeFile(path.join(destination,'preserved.txt'),'complete previous runtime\n');
        const observerFailure=new Error('Complete distribution observer failure.');
        const failureBody='Complete upstream response: 雪\nsecond line\n';
        const replacement=t.mock.method(globalThis,'fetch',async function distributionResponse(url){
            return failureKind==='http'&&url.endsWith('transformers.min.js')
                ? new Response(failureBody,{status:503,statusText:'Unavailable',headers:{'x-fixture':'retained'}})
                : new Response('complete executable fixture');
        });
        let failure;
        await assert.rejects(materializeWorkspaceRuntimeContent({
            ...selected,
            browserDecisions:true,
            onEvent(event){
                if(failureKind==='observer'&&event.type==='workspace.decisions.progress')throw observerFailure;
            }
        }),function retainedFailure(error){failure=error;return true;});
        if(failureKind==='http'){
            assert.equal(failure.code,'ARCANE_DECISION_DISTRIBUTION_DOWNLOAD_FAILED');
            assert.equal(failure.response.status,503);
            assert.equal(new TextDecoder().decode(failure.response.content),failureBody);
            assert.ok(failure.response.headers.some(([name,value])=>name==='x-fixture'&&value==='retained'));
        }else assert.equal(failure,observerFailure);
        assert.equal(await readFile(path.join(destination,'preserved.txt'),'utf8'),'complete previous runtime\n');
        assert.deepEqual(await readdir(selected.workspaceRoot),['arcane']);
        replacement.mock.restore();
    }
});

test('decision distribution cancellation joins every pending acquisition before returning',async t=>{
    const selected=await fixture(t);
    const controller=new AbortController();
    const reason=new Error('Cancel the selected distribution.');
    let started;
    let finish;
    const allStarted=new Promise(resolve=>{started=resolve;});
    const cleanup=new Promise(resolve=>{finish=resolve;});
    let calls=0;
    let settled=0;
    t.mock.method(globalThis,'fetch',async function pendingDistribution(url,{signal}){
        const aborted=new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
        calls+=1;
        if(calls===5)started();
        await aborted;
        await cleanup;
        settled+=1;
        throw signal.reason;
    });
    let returned=false;
    const operation=materializeWorkspaceRuntimeContent({...selected,browserDecisions:true,signal:controller.signal});
    const rejected=assert.rejects(operation,error=>error===reason).then(()=>{returned=true;});
    await allStarted;
    controller.abort(reason);
    await Promise.resolve();
    assert.equal(returned,false);
    finish();
    await rejected;
    assert.equal(settled,5);
    assert.deepEqual(await readdir(selected.workspaceRoot),[]);
});

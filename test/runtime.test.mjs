import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
    const root=await mkdtemp(path.join(os.tmpdir(),'arcane-runtime-content-'));
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
    const result=await materializeWorkspaceRuntimeContent(selected);
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

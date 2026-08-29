import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {packageApp} from '../src/packager/core.mjs';

async function writeJson(filePath,value){
    await writeFile(filePath,`${JSON.stringify(value,null,2)}\n`);
}

test('multiple apps independently materialize the complete current shared source',async t=>{
    const workspaceRoot=await mkdtemp(path.join(os.tmpdir(),'arcane-shared-content-'));
    t.after(()=>rm(workspaceRoot,{recursive:true,force:true}));
    await mkdir(path.join(workspaceRoot,'shared','modules'),{recursive:true});
    await writeJson(path.join(workspaceRoot,'arcane-packager.json'),{
        schemaVersion:1,
        appsRoot:'apps',
        distRoot:'dist',
        sharedPayloads:{
            runtime:[{
                source:'shared',
                destination:'arcane',
                include:['modules'],
                exclude:[]
            }]
        }
    });
    for(const appId of ['first-app','second-app']){
        const appRoot=path.join(workspaceRoot,'apps',appId);
        await mkdir(appRoot,{recursive:true});
        await writeJson(path.join(appRoot,'arcane-package.json'),{
            schemaVersion:1,
            id:appId,
            displayName:appId,
            version:'1.0.0',
            entry:'index.html',
            strategy:'static',
            include:['index.html'],
            exclude:[],
            shared:['runtime']
        });
        await writeFile(path.join(appRoot,'index.html'),`<p>${appId}</p>\n`);
    }
    const original='export const value = "complete original";\n';
    const updated='export const value = "complete updated source with all details";\n';
    const sharedPath=path.join(workspaceRoot,'shared','modules','value.js');
    await writeFile(sharedPath,original);
    const first=await packageApp({workspaceRoot,appId:'first-app'});
    await writeFile(sharedPath,updated);
    const second=await packageApp({workspaceRoot,appId:'second-app'});

    assert.equal(await readFile(
        path.join(first.outputRoot,'arcane','modules','value.js'),
        'utf8'
    ),original);
    assert.equal(await readFile(
        path.join(second.outputRoot,'arcane','modules','value.js'),
        'utf8'
    ),updated);
});

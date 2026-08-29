import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {assessArcaneOllama,runDoctor} from '../src/doctor.mjs';

test('doctor reports complete runtime file inventories',async t=>{
    const workspaceRoot=await mkdtemp(path.join(os.tmpdir(),'arcane-doctor-'));
    t.after(()=>rm(workspaceRoot,{recursive:true,force:true}));
    const report=await runDoctor({
        workspaceRoot,
        platform:'linux',
        run:async()=>({code:0,stdout:'24.0.0\n',stderr:''})
    });
    const runtime=report.checks.find(item=>item.id==='sdk-runtime');
    assert.equal(runtime.status,'pass');
    assert.equal(Array.isArray(runtime.details.runtimeFiles),true);
    assert.equal(Array.isArray(runtime.details.browserRuntimeFiles),true);
    assert.equal(runtime.details.runtimeFiles.length>0,true);
    assert.equal(runtime.details.browserRuntimeFiles.length>0,true);
    assert.equal(report.checks.find(item=>item.id==='workspace').status,'skipped');
    assert.equal(report.checks.find(item=>item.id==='workspace-runtime').status,'skipped');
});

test('non-Windows Arcane Ollama inspection remains an optional availability report',async()=>{
    const result=await assessArcaneOllama({platform:'linux'});
    assert.deepEqual(result,{
        id:'arcane-ollama',
        status:'unsupported',
        message:'Managed ArcaneOllama service inspection is not implemented on this host.',
        required:false,
        details:{platform:'linux'}
    });
});

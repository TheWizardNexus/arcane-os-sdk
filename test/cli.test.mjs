import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {Writable} from 'node:stream';
import test from '../src/testing.mjs';
import {createNativeTargetRequest,runCli as runCliInProcess} from '../src/cli/main.mjs';
import {parseNdjson,repositoryRoot,runCli,runNode} from './helpers.mjs';

function memoryStream(){
    let value='';
    return {
        stream:new Writable({
            write(chunk,_encoding,callback){
                value+=chunk.toString();
                callback();
            }
        }),
        read:()=>value
    };
}

test('CLI help and version succeed through the shipped executable',async()=>{
    const help=await runCli(['--help']);
    assert.equal(help.code,0);
    assert.match(help.stdout,/Arcane OS application SDK 0\.1\.0-dev\.2/);
    assert.match(help.stdout,/external or integrated Arcane workspace/);
    assert.match(help.stdout,/arcane-os executables/);
    assert.match(help.stdout,/test --scope shared --test-file/);

    const version=await runCli(['--version']);
    assert.equal(version.code,0);
    assert.equal(version.stdout.trim(),'0.1.0-dev.2');
});

test('both installed command names execute the published CLI entry',async()=>{
    const packageDocument=JSON.parse(await readFile(path.join(repositoryRoot,'package.json'),'utf8'));
    for(const commandName of ['arcane','arcane-os']){
        const entry=packageDocument.bin[commandName];
        assert.equal(typeof entry,'string');
        const invoked=await runNode([
            path.resolve(repositoryRoot,entry),
            '--version',
            '--output','json'
        ]);
        assert.equal(invoked.code,0,invoked.stderr);
        const result=JSON.parse(invoked.stdout);
        assert.equal(result.ok,true);
        assert.equal(result.result,'0.1.0-dev.2');
    }
});

test('CLI NDJSON output acknowledges before returning target state',async()=>{
    const result=await runCli(['targets','--output','ndjson']);
    assert.equal(result.code,0,result.stderr);
    assert.equal(result.stderr,'');
    const events=parseNdjson(result.stdout);
    assert.ok(events.length>=2);
    assert.equal(events[0].type,'operation.accepted');
    assert.equal(events.at(-1).type,'operation.completed');
    assert.deepEqual(events.map(event=>event.sequence),events.map((_event,index)=>index+1));
    const targets=events.at(-1).data.result.targets;
    assert.equal(targets.find(target=>target.id==='browser').status,'available');
    assert.equal(targets.find(target=>target.id==='portable').status,'pairing-required');
    assert.equal(targets.find(target=>target.id==='android-arm64').status,'pairing-required');
});

test('CLI JSON output has one stdout document and progress only on stderr',async()=>{
    const result=await runCli(['--output','json','targets']);
    assert.equal(result.code,0,result.stderr);
    const stdoutLines=result.stdout.split(/\r?\n/).filter(Boolean);
    assert.equal(stdoutLines.length,1);
    const document=JSON.parse(stdoutLines[0]);
    assert.equal(document.protocol,'arcane-cli-events/1');
    assert.equal(document.ok,true);
    assert.equal(document.result.protocol,'arcane-target-adapter/1');
    const progress=parseNdjson(result.stderr);
    assert.equal(progress.at(0).type,'operation.accepted');
});

test('CLI unknown command fails with stable usage framing',async()=>{
    const result=await runCli(['definitely-unknown','--output','ndjson']);
    assert.equal(result.code,1);
    const events=parseNdjson(result.stdout);
    assert.equal(events[0].type,'operation.accepted');
    assert.equal(events.at(-1).type,'operation.failed');
    assert.equal(events.at(-1).data.error.code,'ARCANE_USAGE');
});

test('CLI machine events preserve long user command text within the public schema',async()=>{
    const command=`unknown-${'x'.repeat(96)}`;
    const result=await runCli([command,'--output','ndjson']);
    assert.equal(result.code,1);
    const events=parseNdjson(result.stdout);
    assert.equal(events[0].command,command);
    assert.equal(events.at(-1).command,command);
    assert.equal(events.at(-1).data.error.code,'ARCANE_USAGE');
});

test('CLI requires explicit pairing for Android instead of creating a substitute artifact',async()=>{
    const result=await runCli(['build','--target','android-arm64','--output','ndjson']);
    assert.equal(result.code,1);
    const events=parseNdjson(result.stdout);
    assert.equal(events.at(-1).type,'operation.failed');
    assert.equal(events.at(-1).data.error.code,'ARCANE_USAGE');
    assert.match(events.at(-1).data.error.message,/requires --arcane-root/u);
});

test('CLI creates truthful Linux ARM64 and Android native requests',()=>{
    assert.deepEqual(createNativeTargetRequest({target:'linux-arm64'}),{
        target:'linux-arm64',
        platform:'linux',
        architecture:'arm64',
        format:'deb',
        signing:{mode:'unsigned-local-test',profileId:null}
    });
    assert.deepEqual(createNativeTargetRequest({target:'android-arm64'}),{
        target:'android-arm64',
        platform:'android',
        architecture:'arm64',
        format:'apk',
        signing:{mode:'development',profileId:'arcane-android-development-v1'}
    });
    assert.throws(
        ()=>createNativeTargetRequest({target:'android-arm64',signing:'unsigned-local-test'}),
        error=>error?.code==='ARCANE_USAGE'&&/Expected development/u.test(error.message)
    );
});

test('CLI reports a server lifecycle event failure as one terminal failure',async()=>{
    const stdout=memoryStream();
    const stderr=memoryStream();
    const lifecycleFailure=new Error('Development server event delivery failed.');
    lifecycleFailure.code='ARCANE_OPERATION_FAILED';
    lifecycleFailure.exitCode=1;
    let rejectLifecycle;
    const lifecycle=new Promise((_resolve,reject)=>{
        rejectLifecycle=reject;
    });
    void lifecycle.catch(()=>{});
    const execute=async()=>{
        setImmediate(()=>rejectLifecycle(lifecycleFailure));
        return {
            mode:'source',
            appId:'fixture-app',
            host:'127.0.0.1',
            port:3210,
            url:'http://127.0.0.1:3210/apps/fixture-app/index.html',
            lifecycle,
            close:()=>lifecycle
        };
    };

    const exitCode=await runCliInProcess(
        ['dev','--output','ndjson'],
        {stdout:stdout.stream,stderr:stderr.stream,execute}
    );
    assert.equal(exitCode,1);
    assert.equal(stderr.read(),'');
    const events=parseNdjson(stdout.read());
    assert.equal(events[0].type,'operation.accepted');
    assert.equal(events.at(-1).type,'operation.failed');
    assert.equal(events.at(-1).data.error.message,lifecycleFailure.message);
    assert.equal(
        events.filter(event=>event.type.startsWith('operation.')
            &&event.type!=='operation.accepted').length,
        1
    );
});

test('CLI maps explicit app and shared development scopes without widening commands',async()=>{
    const invocations=[];
    const execute=async(command,options)=>{
        invocations.push({command,options});
        return {ok:true};
    };
    for(const arguments_ of [
        ['test','--workspace','fixture','--scope','app'],
        [
            'test','--workspace','fixture','--scope','shared',
            '--test-file','test/selected.test.mjs'
        ],
        ['check','--workspace','fixture','--scope','shared']
    ]){
        const stdout=memoryStream();
        const stderr=memoryStream();
        const exitCode=await runCliInProcess(arguments_,{
            cwd:'C:\\sdk-cli-fixture',
            stdout:stdout.stream,
            stderr:stderr.stream,
            execute
        });
        assert.equal(exitCode,0,stderr.read());
    }

    assert.equal(invocations[0].command,'test');
    assert.equal(invocations[0].options.scope,'app');
    assert.equal(invocations[0].options.testFile,undefined);
    assert.equal(invocations[1].command,'test');
    assert.equal(invocations[1].options.scope,'shared');
    assert.equal(invocations[1].options.appId,undefined);
    assert.equal(invocations[1].options.testFile,'test/selected.test.mjs');
    assert.equal(invocations[2].command,'check');
    assert.equal(invocations[2].options.scope,'shared');
    assert.equal(invocations[2].options.skipTests,false);
});

test('CLI rejects incomplete shared tests and shared output commands before execution',async()=>{
    for(const arguments_ of [
        ['test','--scope','shared'],
        ['test','--scope','shared','--test-file','test/one.test.mjs','--app','one'],
        ['check','--scope','shared','--skip-tests'],
        ['package','--scope','shared'],
        ['build','--scope','shared','--target','browser']
    ]){
        const stdout=memoryStream();
        const stderr=memoryStream();
        let executed=false;
        const exitCode=await runCliInProcess([...arguments_,'--output','ndjson'],{
            stdout:stdout.stream,
            stderr:stderr.stream,
            execute:async()=>{
                executed=true;
                return {};
            }
        });
        assert.equal(exitCode,1);
        assert.equal(executed,false);
        const events=parseNdjson(stdout.read());
        assert.equal(events.at(-1).type,'operation.failed');
        assert.equal(events.at(-1).data.error.code,'ARCANE_USAGE');
    }
});

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {Writable} from 'node:stream';
import test from '../src/testing.mjs';
import {createNativeTargetRequest,runCli as runCliInProcess} from '../src/cli/main.mjs';
import {SDK_VERSION} from '../src/constants.mjs';
import {ArcaneError,ERROR_CODES} from '../src/errors.mjs';
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
    assert.ok(help.stdout.includes(`Arcane OS application SDK ${SDK_VERSION}`));
    assert.match(help.stdout,/external or integrated Arcane workspace/);
    assert.match(help.stdout,/arcane-os executables/);
    assert.match(help.stdout,/test --scope shared --test-file/);
    assert.match(help.stdout,/upgrade \[--workspace <directory>\] \[--app <id>\]/u);
    assert.match(help.stdout,/import-map \[--workspace <directory>\] \[--app <id>\]/u);
    assert.match(help.stdout,/dev .*--sdk-runtime-source <sdk-root>/u);
    assert.match(help.stdout,/verify-bundle <file[.]arcane-app[.]tar[.]gz>/);

    const version=await runCli(['--version']);
    assert.equal(version.code,0);
    assert.equal(version.stdout.trim(),SDK_VERSION);
});

test('CLI maps the SDK runtime source only for explicit development',async()=>{
    const cwd=path.join('C:\\','sdk-cli-fixture');
    const stdout=memoryStream();
    const stderr=memoryStream();
    const invocations=[];
    const runtime=Object.freeze({
        mode:'sdk-source',
        protocol:'arcane-sdk-runtime-source/1',
        sdkVersion:SDK_VERSION,
        mutable:true,
        distributionAuthority:false,
        sourceRoot:path.resolve(cwd,'canonical-sdk')
    });
    const exitCode=await runCliInProcess([
        'dev',
        '--workspace','external-app',
        '--sdk-runtime-source','canonical-sdk',
        '--output','ndjson'
    ],{
        cwd,
        stdout:stdout.stream,
        stderr:stderr.stream,
        execute:async function executeDevelopment(command,options){
            invocations.push({command,options});
            return {
                mode:'source',
                runtimeMode:'sdk-source',
                runtime,
                appId:'fixture-app',
                host:'127.0.0.1',
                port:8000,
                url:'http://127.0.0.1:8000/apps/fixture-app/index.html',
                lifecycle:Promise.resolve(),
                close:async function closeDevelopmentServer(){}
            };
        }
    });
    assert.equal(exitCode,0,stderr.read());
    assert.equal(invocations.length,1);
    assert.equal(invocations[0].command,'dev');
    assert.equal(invocations[0].options.workspaceRoot,path.resolve(cwd,'external-app'));
    assert.equal(invocations[0].options.sdkRuntimeSourceRoot,path.resolve(cwd,'canonical-sdk'));
    const events=parseNdjson(stdout.read());
    const ready=events.find(function isServerReady(event){
        return event.type==='server.ready';
    });
    assert.equal(ready.data.runtimeMode,'sdk-source');
    assert.deepEqual(ready.data.runtime,runtime);
    assert.deepEqual(events.at(-1).data.result.runtime,runtime);

    for(const arguments_ of [
        ['package'],
        ['build','--target','browser'],
        ['run'],
        ['check']
    ]){
        let executed=false;
        const rejectedOutput=memoryStream();
        const rejectedCode=await runCliInProcess([
            ...arguments_,
            '--sdk-runtime-source','canonical-sdk',
            '--output','ndjson'
        ],{
            cwd,
            stdout:rejectedOutput.stream,
            stderr:memoryStream().stream,
            execute:async function rejectUnexpectedExecution(){
                executed=true;
            }
        });
        assert.equal(rejectedCode,1);
        assert.equal(executed,false);
        const rejectedEvents=parseNdjson(rejectedOutput.read());
        assert.equal(rejectedEvents.at(-1).data.error.code,'ARCANE_USAGE');
        assert.match(rejectedEvents.at(-1).data.error.message,/supported only by dev/u);
    }
});

test('CLI import-map command follows workspace and app option grammar',async()=>{
    const stdout=memoryStream();
    const stderr=memoryStream();
    const invocations=[];
    const cwd=path.join('C:\\','sdk-cli-fixture');
    const exitCode=await runCliInProcess([
        'import-map',
        '--workspace','named-apps',
        '--app','hello-world',
        '--output','ndjson'
    ],{
        cwd,
        stdout:stdout.stream,
        stderr:stderr.stream,
        execute:async(command,options)=>{
            invocations.push({command,options});
            return {importMap:{artifact:'apps/hello-world/modules/arcane.importmap.json'}};
        }
    });
    assert.equal(exitCode,0,stderr.read());
    assert.equal(invocations.length,1);
    assert.equal(invocations[0].command,'import-map');
    assert.equal(invocations[0].options.workspaceRoot,path.resolve(cwd,'named-apps'));
    assert.equal(invocations[0].options.appId,'hello-world');
    assert.equal(invocations[0].options.scope,'app');
    assert.equal(parseNdjson(stdout.read()).at(-1).type,'operation.completed');
});

test('CLI upgrade selects one application for its normal npm upgrade',async()=>{
    const stdout=memoryStream();
    const stderr=memoryStream();
    const invocations=[];
    const cwd=path.join('C:\\','sdk-cli-fixture');
    const exitCode=await runCliInProcess([
        'upgrade',
        '--workspace','consumer',
        '--app','selected-app',
        '--output','ndjson'
    ],{
        cwd,
        stdout:stdout.stream,
        stderr:stderr.stream,
        execute:async(command,options)=>{
            invocations.push({command,options});
            return {kind:'arcane-application-upgrade',appId:options.appId};
        }
    });
    assert.equal(exitCode,0,stderr.read());
    assert.equal(invocations.length,1);
    assert.equal(invocations[0].command,'upgrade');
    assert.equal(invocations[0].options.workspaceRoot,path.resolve(cwd,'consumer'));
    assert.equal(invocations[0].options.appId,'selected-app');
    assert.equal(invocations[0].options.scope,'app');
});

test('CLI update checking is explicit, structured, and fails honestly',async t=>{
    await t.test('dispatch',async()=>{
        const stdout=memoryStream();
        const stderr=memoryStream();
        const invocations=[];
        const exitCode=await runCliInProcess(['update-check','--output','ndjson'],{
            stdout:stdout.stream,
            stderr:stderr.stream,
            execute:async(command,options)=>{
                invocations.push({command,options});
                await options.onEvent({type:'update.check.started',message:'Checking npm dev.'});
                return {status:'current',updateAvailable:false};
            }
        });
        assert.equal(exitCode,0,stderr.read());
        assert.equal(invocations.length,1);
        assert.equal(invocations[0].command,'update-check');
        assert.deepEqual(Object.keys(invocations[0].options).sort(),['onEvent','signal']);
        const events=parseNdjson(stdout.read());
        assert.equal(events.some(event=>event.type==='update.check.started'),true);
        assert.equal(events.at(-1).type,'operation.completed');
    });
    await t.test('explicit failure',async()=>{
        const stdout=memoryStream();
        const stderr=memoryStream();
        const exitCode=await runCliInProcess(['update-check','--output','ndjson'],{
            stdout:stdout.stream,
            stderr:stderr.stream,
            execute:async()=>{
                throw new ArcaneError(ERROR_CODES.updateCheckFailed,'Registry offline.');
            }
        });
        assert.equal(exitCode,1);
        assert.equal(stderr.read(),'');
        const events=parseNdjson(stdout.read());
        assert.equal(events.at(-1).type,'operation.failed');
        assert.equal(events.at(-1).data.error.code,ERROR_CODES.updateCheckFailed);
    });
    await t.test('unexpected positional argument',async()=>{
        let executed=false;
        const exitCode=await runCliInProcess(['update-check','unexpected'],{
            stdout:memoryStream().stream,
            stderr:memoryStream().stream,
            execute:async()=>{executed=true;}
        });
        assert.equal(exitCode,1);
        assert.equal(executed,false);
    });
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
        assert.equal(result.result,SDK_VERSION);
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

test('CLI maps one release bundle artifact without widening app selection',async()=>{
    const invocations=[];
    const execute=async(command,options)=>{
        invocations.push({command,options});
        return {ok:true};
    };
    for(const arguments_ of [
        [
            'bundle','--workspace','fixture','--app','selected-app',
            '--artifact','release/selected.arcane-app.tar.gz','--overwrite'
        ],
        ['verify-bundle','release/selected.arcane-app.tar.gz']
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
    assert.equal(invocations[0].command,'bundle');
    assert.equal(invocations[0].options.appId,'selected-app');
    assert.equal(invocations[0].options.overwrite,true);
    assert.equal(
        invocations[0].options.artifactPath,
        path.resolve('C:\\sdk-cli-fixture','release/selected.arcane-app.tar.gz')
    );
    assert.equal(invocations[1].command,'verify-bundle');
    assert.equal(invocations[1].options.appId,undefined);
    assert.equal(invocations[1].options.overwrite,undefined);
    assert.equal(invocations[1].options.artifactPath,invocations[0].options.artifactPath);
});

test('CLI rejects incomplete shared tests and shared output commands before execution',async()=>{
    for(const arguments_ of [
        ['test','--scope','shared'],
        ['test','--scope','shared','--test-file','test/one.test.mjs','--app','one'],
        ['check','--scope','shared','--skip-tests'],
        ['package','--skip-tests'],
        ['package','--scope','shared'],
        ['bundle','--scope','shared'],
        ['verify-bundle'],
        ['verify-bundle','one.arcane-app.tar.gz','--artifact','two.arcane-app.tar.gz'],
        ['verify-bundle','one.arcane-app.tar.gz','--overwrite'],
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

import assert from 'node:assert/strict';
import {lstat,mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {Writable} from 'node:stream';
import test from '../src/testing.mjs';
import {createNativeTargetRequest,runCli as runCliInProcess} from '../src/cli/main.mjs';
import {SDK_VERSION} from '../src/constants.mjs';
import {ArcaneError,ERROR_CODES} from '../src/errors.mjs';
import {parseNdjson,repositoryRoot,runCli,runNode,temporaryDirectory} from './helpers.mjs';

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
    assert.match(help.stdout,/dev .*\[--public\]/u);
    assert.match(help.stdout,/dev .*\[--http \| --https\]/u);
    assert.match(help.stdout,/dev .*\[--http-port 0\]/u);
    assert.match(help.stdout,/verify-bundle <file[.]arcane-app[.]tar[.]gz>/);

    const version=await runCli(['--version']);
    assert.equal(version.code,0);
    assert.equal(version.stdout.trim(),SDK_VERSION);
});

test('CLI new and fresh init place each app at its repository root by default',async t=>{
    const parent=await temporaryDirectory(t);
    for(const command of ['new','init']){
        const appId=`moon-library-${command}`;
        const workspaceRoot=path.join(parent,appId);
        if(command==='init')await mkdir(workspaceRoot);
        const args=command==='new'
            ?['new',appId,'--path',workspaceRoot]
            :['init',appId,'--workspace',workspaceRoot];
        const result=await runCli([...args,'--output','json'],{cwd:parent});
        assert.equal(result.code,0,result.stderr);
        assert.equal(JSON.parse(result.stdout).result.appsRoot,'.');
        const config=JSON.parse(await readFile(path.join(workspaceRoot,'arcane-packager.json'),'utf8'));
        const descriptor=JSON.parse(await readFile(path.join(workspaceRoot,'arcane-app.json'),'utf8'));
        assert.equal(config.appsRoot,'.');
        assert.equal(descriptor.id,appId);
        assert.equal((await lstat(path.join(workspaceRoot,'index.html'))).isFile(),true);
        for(const absent of ['apps','arcane','arcane.lock.json','node_modules']){
            await assert.rejects(lstat(path.join(workspaceRoot,absent)),error=>error.code==='ENOENT');
        }
    }
});

test('CLI preserves explicit multi-app selection and leaves existing init layout resolution to its owner',async()=>{
    for(const selection of [
        {args:['new','moon-library'],appsRoot:'.'},
        {args:['new','moon-library','--apps-root','apps'],appsRoot:'apps'},
        {args:['init','moon-library'],appsRoot:undefined},
        {args:['init','moon-library','--apps-root','apps'],appsRoot:'apps'}
    ]){
        const stdout=memoryStream();
        const stderr=memoryStream();
        const invocations=[];
        const code=await runCliInProcess(selection.args,{
            stdout:stdout.stream,
            stderr:stderr.stream,
            execute:async function captureScaffoldSelection(command,options){
                invocations.push({command,options});
                return {appId:options.appId,appsRoot:options.appsRoot};
            }
        });
        assert.equal(code,0,stderr.read());
        assert.equal(invocations.length,1);
        assert.equal(invocations[0].command,selection.args[0]);
        assert.equal(invocations[0].options.appId,'moon-library');
        assert.equal(invocations[0].options.appsRoot,selection.appsRoot);
    }
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
                url:'https://127.0.0.1:8000/apps/fixture-app/index.html',
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

test('CLI public development preserves app selection and explicit host precedence',async function publicDevelopmentOptions(){
    for(const selection of [
        {appId:'example-app',args:[],host:'127.0.0.1',https:true},
        {appId:'another-app',args:['--public'],host:'0.0.0.0',https:true},
        {appId:'example-app',args:['--host','192.0.2.10'],host:'192.0.2.10',https:true},
        {appId:'another-app',args:['--public','--host','127.0.0.1'],host:'127.0.0.1',https:true},
        {appId:'example-app',args:['--host','192.0.2.10','--public'],host:'192.0.2.10',https:true},
        {appId:'example-app',args:['--https'],host:'127.0.0.1',https:true}
    ]){
        const stdout=memoryStream();
        const stderr=memoryStream();
        const invocations=[];
        const protocol='https:';
        const networkUrls=selection.host==='127.0.0.1'?[]:[
            `${protocol}//192.0.2.10:8123/apps/${selection.appId}/index.html`
        ];
        const exitCode=await runCliInProcess([
            'dev','--app',selection.appId,'--port','8123',...selection.args,'--output','ndjson'
        ],{
            stdout:stdout.stream,
            stderr:stderr.stream,
            execute:async function executeSelectedDevelopment(command,options){
                invocations.push({command,options});
                return {
                    mode:'source',
                    appId:options.appId,
                    host:options.host,
                    port:options.port,
                    protocol,
                    url:`${protocol}//localhost:8123/apps/${options.appId}/index.html`,
                    networkUrls,
                    lifecycle:Promise.resolve(),
                    close:async function closeDevelopmentFixture(){}
                };
            }
        });
        assert.equal(exitCode,0,stderr.read());
        assert.equal(invocations.length,1);
        assert.equal(invocations[0].command,'dev');
        assert.equal(invocations[0].options.appId,selection.appId);
        assert.equal(invocations[0].options.host,selection.host);
        assert.equal(invocations[0].options.port,8123);
        assert.equal(invocations[0].options.httpPort,0);
        assert.equal(invocations[0].options.https,selection.https);
        const events=parseNdjson(stdout.read());
        const ready=events.find(function serverReady(event){return event.type==='server.ready';});
        assert.equal(ready.data.protocol,protocol);
        assert.deepEqual(ready.data.networkUrls,networkUrls);
        assert.deepEqual(events.at(-1).data.result.networkUrls,networkUrls);
    }
});

test(
    'CLI explicit HTTP development preserves app selection and reports content endpoints in every output mode',
    async function httpDevelopmentCliOutput() {
        for (const output of ['human', 'json', 'ndjson']) {
            const stdout = memoryStream();
            const stderr = memoryStream();
            const invocations = [];
            const origin = 'http://localhost:8123';
            const url = `${origin}/apps/fixture-app/index.html`;
            const networkUrls = ['http://192.0.2.10:8123/apps/fixture-app/index.html'];
            const exitCode = await runCliInProcess(
                ['dev', '--app', 'fixture-app', '--public', '--http', '--port', '8123', '--output', output],
                {
                    stdout: stdout.stream,
                    stderr: stderr.stream,
                    execute: async function executeHttpDevelopment(command, options) {
                        invocations.push({command, options});
                        return {
                            mode: 'source', appId: options.appId,
                            host: options.host, port: options.port,
                            protocol: 'http:', origin, url, cleanUrl: url,
                            httpPort: options.port, httpOrigin: origin, httpUrl: url,
                            networkUrls, lifecycle: Promise.resolve(),
                            close: async function closeHttpCliFixture() {}
                        };
                    }
                }
            );
            assert.equal(exitCode, 0, stderr.read());
            assert.equal(invocations.length, 1);
            assert.equal(invocations[0].command, 'dev');
            assert.equal(invocations[0].options.appId, 'fixture-app');
            assert.equal(invocations[0].options.host, '0.0.0.0');
            assert.equal(invocations[0].options.port, 8123);
            assert.equal(invocations[0].options.http, true);
            assert.notEqual(invocations[0].options.https, true);
            assert.equal(stderr.read().includes('HTTP redirect:'), false);
            if (output === 'human') {
                assert.ok(stderr.read().includes(`Development server ready at ${url}`));
                assert.ok(stderr.read().includes(`Network: ${networkUrls[0]}`));
            } else {
                const events = parseNdjson(output === 'json' ? stderr.read() : stdout.read());
                const ready = events.find(
                    function isHttpCliReady(event) {
                        return event.type === 'server.ready';
                    }
                );
                const result = output === 'json'
                    ? JSON.parse(stdout.read()).result
                    : events.at(-1).data.result;
                for (const endpoint of [ready.data, result]) {
                    assert.equal(endpoint.protocol, 'http:');
                    assert.equal(endpoint.port, 8123);
                    assert.equal(endpoint.httpPort, 8123);
                    assert.equal(endpoint.url, url);
                    assert.equal(endpoint.httpOrigin, origin);
                    assert.equal(endpoint.httpUrl, url);
                    assert.deepEqual(endpoint.networkUrls, networkUrls);
                }
                assert.equal(ready.message.includes('HTTP redirect:'), false);
            }
        }
    }
);

test(
    'CLI HTTP development rejects conflicting HTTPS and redirect options and other commands',
    async function invalidHttpCliOptions() {
        for (const args of [
            ['dev', '--http', '--https'],
            ['dev', '--http', '--cert', 'cert.pem', '--key', 'key.pem'],
            ['dev', '--http', '--cert', 'cert.pem'],
            ['dev', '--http', '--key', 'key.pem'],
            ['dev', '--http', '--http-port', '0'],
            ['dev', '--http', '--http-port', '8124'],
            ['dev', '--http=true'],
            ['run', '--http'],
            ['run', '--target', 'browser', '--http'],
            ['run', '--target', 'windows-x64', '--http'],
            ['package', '--http'],
            ['mail', 'serve', '--http']
        ]) {
            const stdout = memoryStream();
            let executed = false;
            const exitCode = await runCliInProcess(
                [...args, '--output', 'ndjson'],
                {
                    stdout: stdout.stream,
                    stderr: memoryStream().stream,
                    execute: async function rejectInvalidHttpExecution() {
                        executed = true;
                    }
                }
            );
            assert.equal(exitCode, 1);
            assert.equal(executed, false);
            assert.equal(parseNdjson(stdout.read()).at(-1).data.error.code, 'ARCANE_USAGE');
        }
    }
);

test('CLI prints every public development network URL in human output',async function publicDevelopmentOutput(){
    const stdout=memoryStream();
    const stderr=memoryStream();
    const networkUrls=[
        'https://192.0.2.10:8123/apps/example-app/index.html',
        'https://198.51.100.20:8123/apps/example-app/index.html'
    ];
    const exitCode=await runCliInProcess(['dev','--public'],{
        stdout:stdout.stream,
        stderr:stderr.stream,
        execute:async function publicServerFixture(){
            return {
                mode:'source',appId:'example-app',host:'0.0.0.0',port:8123,
                protocol:'https:',url:'https://localhost:8123/apps/example-app/index.html',
                httpPort:8124,httpOrigin:'http://localhost:8124',
                httpUrl:'http://localhost:8124/apps/example-app/index.html',
                networkUrls,lifecycle:Promise.resolve(),
                close:async function closePublicServerFixture(){}
            };
        }
    });
    assert.equal(exitCode,0,stderr.read());
    assert.ok(stderr.read().includes('HTTP redirect: http://localhost:8124/apps/example-app/index.html'));
    for(const url of networkUrls)assert.ok(stderr.read().includes(`Network: ${url}`));
});

test(
    'CLI browser serving preserves the selected HTTP redirect port and reports both endpoints',
    async function browserRedirectPortOptions() {
        for (const selection of [
            {args: ['dev'], httpPort: 0},
            {args: ['dev', '--http-port', '8124'], httpPort: 8124},
            {args: ['run', '--http-port=65535'], httpPort: 65535},
            {args: ['run', '--target', 'browser', '--http-port', '0'], httpPort: 0}
        ]) {
            const stdout = memoryStream();
            let selectedOptions;
            const httpPort = selection.httpPort || 3211;
            const httpOrigin = `http://127.0.0.1:${httpPort}`;
            const httpUrl = `${httpOrigin}/apps/fixture-app/index.html`;
            const exitCode = await runCliInProcess(
                [...selection.args, '--port', '8123', '--output', 'ndjson'],
                {
                    stdout: stdout.stream,
                    stderr: memoryStream().stream,
                    execute: async function selectBrowserRedirectPort(command, options) {
                        selectedOptions = options;
                        return {
                            mode: command === 'dev' ? 'source' : 'packaged',
                            host: '127.0.0.1',
                            port: options.port,
                            protocol: 'https:',
                            url: 'https://127.0.0.1:8123/apps/fixture-app/index.html',
                            httpPort,
                            httpOrigin,
                            httpUrl,
                            lifecycle: Promise.resolve(),
                            close: async function closeBrowserRedirectFixture() {}
                        };
                    }
                }
            );
            assert.equal(exitCode, 0);
            assert.equal(selectedOptions.port, 8123);
            assert.equal(selectedOptions.httpPort, selection.httpPort);
            const events = parseNdjson(stdout.read());
            const ready = events.find(
                function isBrowserRedirectReady(event) {
                    return event.type === 'server.ready';
                }
            );
            for (const result of [ready.data, events.at(-1).data.result]) {
                assert.equal(result.port, 8123);
                assert.equal(result.httpPort, httpPort);
                assert.equal(result.httpOrigin, httpOrigin);
                assert.equal(result.httpUrl, httpUrl);
            }
        }

        for (const args of [
            ['dev', '--http-port'],
            ['dev', '--http-port=65536'],
            ['dev', '--http-port=-1'],
            ['run', '--http-port=1.5'],
            ['run', '--http-port=invalid'],
            ['package', '--http-port', '0'],
            ['mail', 'serve', '--http-port', '0'],
            ['run', '--target', 'windows-x64', '--http-port', '0']
        ]) {
            const stdout = memoryStream();
            let executed = false;
            const exitCode = await runCliInProcess(
                [...args, '--output', 'ndjson'],
                {
                    stdout: stdout.stream,
                    stderr: memoryStream().stream,
                    execute: async function rejectInvalidRedirectPortExecution() {
                        executed = true;
                    }
                }
            );
            assert.equal(exitCode, 1);
            assert.equal(executed, false);
            assert.equal(parseNdjson(stdout.read()).at(-1).data.error.code, 'ARCANE_USAGE');
        }
    }
);

test('CLI development and browser run certificate paths are relative to the chosen workspace',async function developmentCertificateOptions(){
    const cwd=path.resolve('cli-certificate-fixture');
    const workspaceRoot=path.join(cwd,'selected-workspace');
    for (const command of [['dev'], ['run'], ['run', '--target', 'browser']]) {
        const stdout = memoryStream();
        let selectedOptions;
        const exitCode = await runCliInProcess(
            [...command, '--workspace', 'selected-workspace', '--cert', 'tls/cert.pem', '--key', 'tls/key.pem'],
            {
                cwd,
                stdout: stdout.stream,
                stderr: memoryStream().stream,
                execute: async function selectCertificatePair(selectedCommand, options) {
                    selectedOptions = options;
                    return {
                        mode: selectedCommand === 'dev' ? 'source' : 'packaged',
                        host: options.host, port: 8000, protocol: 'https:',
                        url: 'https://127.0.0.1:8000/index.html',
                        lifecycle: Promise.resolve(),
                        close: async function closeCertificateFixture() {}
                    };
                }
            }
        );
        assert.equal(exitCode, 0);
        assert.equal(selectedOptions.workspaceRoot, workspaceRoot);
        assert.equal(selectedOptions.host, '127.0.0.1');
        assert.equal(selectedOptions.https, true);
        assert.equal(selectedOptions.certPath, path.join(workspaceRoot, 'tls', 'cert.pem'));
        assert.equal(selectedOptions.keyPath, path.join(workspaceRoot, 'tls', 'key.pem'));
        assert.equal(stdout.read().includes('key.pem'), false);
    }

    for(const args of [
        ['dev','--cert','cert.pem'],
        ['dev','--key','key.pem'],
        ['run','--cert','cert.pem'],
        ['run','--target','windows-x64','--https']
    ]){
        let executed=false;
        const output=memoryStream();
        const rejectedCode=await runCliInProcess([...args,'--output','ndjson'],{
            stdout:output.stream,
            stderr:memoryStream().stream,
            execute:async function unexpectedIncompleteCertificateOperation(){executed=true;}
        });
        assert.equal(rejectedCode,1);
        assert.equal(executed,false);
        assert.equal(parseNdjson(output.read()).at(-1).data.error.code,'ARCANE_USAGE');
    }
});

test('CLI public flag applies only to development',async function publicFlagScope(){
    for(const args of [['run'],['package'],['mail','serve']]){
        const stdout=memoryStream();
        let executed=false;
        const exitCode=await runCliInProcess([...args,'--public','--output','ndjson'],{
            stdout:stdout.stream,
            stderr:memoryStream().stream,
            execute:async function unexpectedPublicOperation(){executed=true;}
        });
        assert.equal(exitCode,1);
        assert.equal(executed,false);
        const failure=parseNdjson(stdout.read()).at(-1);
        assert.equal(failure.data.error.code,'ARCANE_USAGE');
        assert.equal(failure.data.error.message,'--public is supported only by dev.');
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
            url:'https://127.0.0.1:3210/apps/fixture-app/index.html',
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

import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,rm,unlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from '../src/testing.mjs';
import {SDK_NAME,SDK_VERSION} from '../src/constants.mjs';
import {assessArcaneOllama,runDoctor} from '../src/doctor.mjs';
import {verifyRuntime} from '../src/runtime.mjs';
import {verifySdkBrowserRuntime} from '../src/sdk-browser-runtime.mjs';
import {workspaceTemplate} from '../src/templates/workspace-template.mjs';
import {materializeWorkspaceRuntime} from '../src/workspace-runtime.mjs';

const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

const serviceHost='C:\\Program Files\\Ollama\\ArcaneOllamaService.exe';
const readyProbe=JSON.stringify({
    service:'ArcaneOllama',
    ready:true,
    endpoint:'http://127.0.0.1:11434'
});

const queryOutput=`SERVICE_NAME: ArcaneOllama
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
`;
const sidOutput=`SERVICE_NAME: ArcaneOllama
SERVICE_SID_TYPE:  UNRESTRICTED
`;

function configurationOutput(command=`"${serviceHost}"`){
    return `SERVICE_NAME: ArcaneOllama
        TYPE               : 10  WIN32_OWN_PROCESS
        START_TYPE         : 2   AUTO_START
        BINARY_PATH_NAME   : ${command}
        DEPENDENCIES       :
        SERVICE_START_NAME : NT AUTHORITY\\LocalService
`;
}

function windowsRunner({command=`"${serviceHost}"`,probeCode=0,probeOutput=readyProbe}={}){
    const calls=[];
    const run=async(executable,args)=>{
        calls.push({command:executable,args});
        if(executable==='sc.exe'&&args[0]==='query')return {code:0,stdout:queryOutput,stderr:''};
        if(executable==='sc.exe'&&args[0]==='qc')return {code:0,stdout:configurationOutput(command),stderr:''};
        if(executable==='sc.exe'&&args[0]==='qsidtype')return {code:0,stdout:sidOutput,stderr:''};
        if(executable===serviceHost&&args[0]==='--probe'){
            return {code:probeCode,stdout:probeOutput,stderr:probeCode?'probe failed':''};
        }
        throw new Error(`Unexpected command: ${executable} ${args.join(' ')}`);
    };
    return {calls,run};
}

async function writeTemplateFiles(workspaceRoot,files){
    for(const [relative,content] of files){
        const destination=path.join(workspaceRoot,...relative.split('/'));
        await mkdir(path.dirname(destination),{recursive:true});
        await writeFile(destination,content);
    }
}

async function externalDoctorWorkspace(t){
    const workspaceRoot=await mkdtemp(path.join(os.tmpdir(),'arcane-doctor-external-'));
    t.after(()=>rm(workspaceRoot,{recursive:true,force:true}));
    const [runtimeReceipt,sdkBrowserRuntimeReceipt]=await Promise.all([
        verifyRuntime(),
        verifySdkBrowserRuntime()
    ]);
    const template=workspaceTemplate({
        appId:'doctor-app',
        displayName:'Doctor App',
        runtimeRelease:runtimeReceipt,
        sdkBrowserRuntimeRelease:sdkBrowserRuntimeReceipt
    });
    await writeTemplateFiles(workspaceRoot,template.files);
    await materializeWorkspaceRuntime({
        workspaceRoot,
        runtimeRoot:runtimeReceipt.canonicalLocation,
        runtimeReceipt,
        browserRuntimeRoot:sdkBrowserRuntimeReceipt.canonicalLocation,
        sdkBrowserRuntimeReceipt
    });

    const installedRoot=path.join(workspaceRoot,'node_modules','arcane-os');
    await mkdir(path.join(installedRoot,'src'),{recursive:true});
    await Promise.all([
        cp(path.join(repositoryRoot,'runtime'),path.join(installedRoot,'runtime'),{recursive:true}),
        cp(
            path.join(repositoryRoot,'browser-runtime'),
            path.join(installedRoot,'browser-runtime'),
            {recursive:true}
        ),
        cp(
            path.join(repositoryRoot,'node_modules','event-pubsub'),
            path.join(installedRoot,'node_modules','event-pubsub'),
            {recursive:true}
        ),
        cp(
            path.join(repositoryRoot,'node_modules','strong-type'),
            path.join(installedRoot,'node_modules','strong-type'),
            {recursive:true}
        ),
        cp(
            path.join(repositoryRoot,'src','event-manager.mjs'),
            path.join(installedRoot,'src','event-manager.mjs')
        ),
        cp(
            path.join(repositoryRoot,'src','dom-event-instrumentation.mjs'),
            path.join(installedRoot,'src','dom-event-instrumentation.mjs')
        ),
        writeFile(
            path.join(installedRoot,'package.json'),
            `${JSON.stringify({name:SDK_NAME,version:SDK_VERSION,type:'module'},null,2)}\n`
        )
    ]);
    return {workspaceRoot,installedRoot};
}

async function integratedLegacyDoctorWorkspace(t){
    const workspaceRoot=await mkdtemp(path.join(os.tmpdir(),'arcane-doctor-integrated-'));
    t.after(()=>rm(workspaceRoot,{recursive:true,force:true}));
    const appId='legacy-app';
    const template=workspaceTemplate({
        appId,
        displayName:'Legacy App',
        appOnly:true,
        namedImports:false
    });
    await writeTemplateFiles(workspaceRoot,template.files);
    await writeFile(
        path.join(workspaceRoot,'package.json'),
        `${JSON.stringify({name:'arcane-os',private:true,type:'module'},null,2)}\n`
    );
    await writeFile(
        path.join(workspaceRoot,'arcane-packager.json'),
        `${JSON.stringify({
            schemaVersion:1,
            appsRoot:'apps',
            distRoot:'dist',
            sharedPayloads:{
                'browser-runtime':[
                    {
                        source:'arcane',
                        destination:'arcane',
                        include:['components','css','entities','img','modules','security'],
                        exclude:[]
                    },
                    {
                        source:'node_modules/strong-type',
                        destination:'node_modules/strong-type',
                        include:['index.js','licence','package.json'],
                        exclude:[]
                    }
                ]
            }
        },null,2)}\n`
    );
    await Promise.all([
        mkdir(path.join(workspaceRoot,'arcane'),{recursive:true}),
        mkdir(path.join(workspaceRoot,'node_modules','strong-type'),{recursive:true})
    ]);
    return {workspaceRoot,appId};
}

async function doctor(workspaceRoot,appId='doctor-app'){
    return runDoctor({
        workspaceRoot,
        appId,
        platform:'linux',
        run:async(command,args)=>{
            if(command==='npm'&&args[0]==='--version'){
                return {code:0,stdout:'10.9.3\n',stderr:''};
            }
            if(command==='git'&&args[0]==='--version'){
                return {code:0,stdout:'git version 2.50.1\n',stderr:''};
            }
            throw new Error(`Unexpected doctor command: ${command} ${args.join(' ')}`);
        }
    });
}

async function withNodeVersion(version,callback){
    const descriptor=Object.getOwnPropertyDescriptor(process.versions,'node');
    Object.defineProperty(process.versions,'node',{...descriptor,value:version});
    try{
        return await callback();
    }finally{
        Object.defineProperty(process.versions,'node',descriptor);
    }
}

test('doctor enforces the exact Node.js 22.23.2 minimum',async t=>{
    const workspaceRoot=await mkdtemp(path.join(os.tmpdir(),'arcane-doctor-node-floor-'));
    t.after(()=>rm(workspaceRoot,{recursive:true,force:true}));
    const below=await withNodeVersion('22.23.1',()=>doctor(workspaceRoot));
    const minimum=await withNodeVersion('22.23.2',()=>doctor(workspaceRoot));
    const belowCheck=below.checks.find(item=>item.id==='node');
    const minimumCheck=minimum.checks.find(item=>item.id==='node');
    assert.equal(below.ok,false);
    assert.equal(belowCheck.status,'fail');
    assert.equal(belowCheck.required,true);
    assert.deepEqual(belowCheck.details,{version:'22.23.1',minimum:'22.23.2'});
    assert.match(belowCheck.message,/does not satisfy the SDK minimum 22\.23\.2/u);
    assert.equal(minimumCheck.status,'pass');
    assert.deepEqual(minimumCheck.details,{version:'22.23.2',minimum:'22.23.2'});
});

function workspaceChecks(report){
    const selected=report.checks.filter(item=>item.id==='workspace'||item.id==='workspace-runtime');
    assert.deepEqual(selected.map(item=>item.id),['workspace','workspace-runtime']);
    assert.equal(report.checks.filter(item=>item.id==='workspace').length,1);
    assert.equal(report.checks.filter(item=>item.id==='workspace-runtime').length,1);
    return selected;
}

test('ArcaneOllama doctor check is explicit on unsupported hosts',async()=>{
    const result=await assessArcaneOllama({platform:'linux'});
    assert.equal(result.id,'arcane-ollama');
    assert.equal(result.status,'unsupported');
    assert.equal(result.required,false);
    assert.equal(result.details.platform,'linux');
});

test('ArcaneOllama doctor check uses fixed Windows service arguments',async()=>{
    const calls=[];
    const result=await assessArcaneOllama({
        platform:'win32',
        run:async(command,args)=>{
            calls.push({command,args});
            return {code:1060,stdout:'',stderr:'The specified service does not exist.'};
        }
    });

    assert.deepEqual(calls,[{command:'sc.exe',args:['query','ArcaneOllama']}]);
    assert.equal(result.status,'missing');
    assert.equal(result.required,false);
    assert.equal(result.details.service,'ArcaneOllama');
});

test('ArcaneOllama passes only the exact argument-free service and probe contract',async()=>{
    const fixture=windowsRunner();
    const checkedPaths=[];
    const result=await assessArcaneOllama({
        platform:'win32',
        run:fixture.run,
        fileExists:async filePath=>{
            checkedPaths.push(filePath);
            return true;
        }
    });

    assert.equal(result.status,'pass');
    assert.equal(result.details.registrationVerified,true);
    assert.equal(result.details.serviceDefinition.command,`"${serviceHost}"`);
    assert.equal(result.details.serviceDefinition.commandArguments,null);
    assert.equal(result.details.serviceDefinition.argumentFree,true);
    assert.equal(result.details.serviceDefinition.exactCommand,true);
    assert.equal(result.details.probeExitCode,0);
    assert.equal(result.details.probeVerified,true);
    assert.deepEqual(result.details.probe,JSON.parse(readyProbe));
    assert.deepEqual(checkedPaths,[serviceHost]);
    assert.deepEqual(fixture.calls.at(-1),{
        command:serviceHost,
        args:['--probe']
    });
});

test('ArcaneOllama rejects service command arguments before probing',async()=>{
    const fixture=windowsRunner({command:`"${serviceHost}" --service`});
    const result=await assessArcaneOllama({
        platform:'win32',
        run:fixture.run,
        fileExists:async()=>true
    });

    assert.equal(result.status,'warning');
    assert.equal(result.details.registrationVerified,false);
    assert.equal(result.details.serviceDefinition.argumentFree,false);
    assert.equal(result.details.serviceDefinition.exactCommand,false);
    assert.equal(result.details.serviceDefinition.commandArguments,'--service');
    assert.equal(result.details.probe,null);
    assert.equal(fixture.calls.some(call=>call.command===serviceHost),false);
});

test('ArcaneOllama rejects nonzero and noncanonical probe results',async t=>{
    const cases=[
        {name:'empty output',probeOutput:''},
        {name:'informational prefix',probeOutput:`ready\n${readyProbe}`},
        {name:'wrong service',probeOutput:JSON.stringify({service:'Ollama',ready:true,endpoint:'http://127.0.0.1:11434'})},
        {name:'false readiness',probeOutput:JSON.stringify({service:'ArcaneOllama',ready:false,endpoint:'http://127.0.0.1:11434'})},
        {name:'wrong endpoint',probeOutput:JSON.stringify({service:'ArcaneOllama',ready:true,endpoint:'http://127.0.0.1:11434/api/version'})},
        {name:'extra field',probeOutput:JSON.stringify({service:'ArcaneOllama',ready:true,endpoint:'http://127.0.0.1:11434',version:'0.31.2'})},
        {name:'nonzero exit',probeCode:3,probeOutput:readyProbe}
    ];

    for(const probeCase of cases){
        await t.test(probeCase.name,async()=>{
            const fixture=windowsRunner(probeCase);
            const result=await assessArcaneOllama({
                platform:'win32',
                run:fixture.run,
                fileExists:async()=>true
            });
            assert.equal(result.status,'warning');
            assert.equal(result.details.probeVerified,false);
        });
    }
});

test('doctor authenticates both external runtime authorities and their physical projection',async t=>{
    const {workspaceRoot}=await externalDoctorWorkspace(t);
    const report=await doctor(workspaceRoot);
    const [workspace,runtime]=workspaceChecks(report);

    assert.equal(report.ok,true,JSON.stringify(report.checks,null,2));
    assert.equal(report.checks.find(item=>item.id==='sdk-runtime')?.status,'pass');
    assert.equal(workspace.status,'pass');
    assert.equal(workspace.details.workspaceMode,'external');
    assert.equal(runtime.status,'pass');
    assert.equal(runtime.details.fileCount,160);
    assert.match(runtime.details.runtimeManifestSha256,/^[a-f0-9]{64}$/u);
    assert.match(runtime.details.runtimeContentSha256,/^[a-f0-9]{64}$/u);
    assert.match(runtime.details.browserManifestSha256,/^[a-f0-9]{64}$/u);
    assert.match(runtime.details.browserContentSha256,/^[a-f0-9]{64}$/u);
});

test('doctor fails closed on missing, corrupt, or unadmitted installed SDK browser authority',async t=>{
    const cases=[
        {
            name:'missing browser receipt',
            mutate:({installedRoot})=>unlink(path.join(
                installedRoot,
                'browser-runtime',
                'ARCANE_SDK_BROWSER_RELEASE.json'
            )),
            expected:['fail','skipped']
        },
        {
            name:'corrupt browser receipt',
            mutate:({installedRoot})=>writeFile(path.join(
                installedRoot,
                'browser-runtime',
                'ARCANE_SDK_BROWSER_RELEASE.json'
            ),'{not-json\n'),
            expected:['fail','skipped']
        },
        {
            name:'missing receipted browser closure file',
            mutate:({installedRoot})=>unlink(path.join(
                installedRoot,
                'browser-runtime',
                'event-manager.mjs'
            )),
            expected:['pass','fail']
        },
        {
            name:'corrupt receipted browser closure file',
            mutate:({installedRoot})=>writeFile(path.join(
                installedRoot,
                'browser-runtime',
                'event-manager.mjs'
            ),'export default "tampered";\n'),
            expected:['pass','fail']
        },
        {
            name:'corrupt declared SDK browser source identity',
            mutate:({installedRoot})=>writeFile(path.join(
                installedRoot,
                'src',
                'event-manager.mjs'
            ),'export default "tampered source";\n'),
            expected:['pass','fail']
        },
        {
            name:'corrupt installed Arcane upstream byte',
            mutate:({installedRoot})=>writeFile(path.join(
                installedRoot,
                'runtime',
                'arcane',
                'modules',
                'MD.js'
            ),'export default "tampered upstream";\n'),
            expected:['pass','fail']
        },
        {
            name:'browser authority not admitted by the workspace lock',
            mutate:async({workspaceRoot})=>{
                const lockPath=path.join(workspaceRoot,'arcane.lock.json');
                const lock=JSON.parse(await readFile(lockPath,'utf8'));
                lock.sdkBrowserRuntime.manifestSha256='0'.repeat(64);
                await writeFile(lockPath,`${JSON.stringify(lock,null,2)}\n`);
            },
            expected:['fail','skipped']
        }
    ];

    for(const item of cases){
        await t.test(item.name,async child=>{
            const fixture=await externalDoctorWorkspace(child);
            await item.mutate(fixture);
            const report=await doctor(fixture.workspaceRoot);
            assert.deepEqual(workspaceChecks(report).map(check=>check.status),item.expected);
            assert.equal(report.ok,false);
        });
    }
});

test('doctor rejects missing or corrupt projected Arcane, dependency, and SDK browser bytes',async t=>{
    const cases=[
        {
            name:'missing projected SDK browser entry',
            mutate:workspaceRoot=>unlink(path.join(workspaceRoot,'arcane','sdk','event-manager.mjs'))
        },
        {
            name:'corrupt projected SDK dependency',
            mutate:workspaceRoot=>writeFile(
                path.join(workspaceRoot,'arcane','sdk','dependencies','event-pubsub','index.js'),
                'throw new Error("tampered SDK dependency");\n'
            )
        },
        {
            name:'corrupt projected Arcane module',
            mutate:workspaceRoot=>writeFile(
                path.join(workspaceRoot,'arcane','modules','MD.js'),
                'export default "tampered Arcane module";\n'
            )
        },
        {
            name:'corrupt projected Arcane strong-type dependency',
            mutate:workspaceRoot=>writeFile(
                path.join(workspaceRoot,'arcane','dependencies','strong-type','index.js'),
                'export default "tampered runtime dependency";\n'
            )
        }
    ];

    for(const item of cases){
        await t.test(item.name,async child=>{
            const {workspaceRoot}=await externalDoctorWorkspace(child);
            await item.mutate(workspaceRoot);
            const report=await doctor(workspaceRoot);
            const [workspace,runtime]=workspaceChecks(report);
            assert.equal(workspace.status,'pass');
            assert.equal(runtime.status,'fail');
            assert.equal(report.ok,false);
        });
    }
});

test('doctor preserves unchanged integrated legacy runtime compatibility',async t=>{
    const {workspaceRoot,appId}=await integratedLegacyDoctorWorkspace(t);
    const report=await doctor(workspaceRoot,appId);
    const [workspace,runtime]=workspaceChecks(report);

    assert.equal(report.ok,true);
    assert.equal(workspace.status,'pass');
    assert.equal(workspace.details.workspaceMode,'integrated');
    assert.equal(runtime.status,'pass');
    assert.equal(runtime.details.layout,'integrated-legacy');
});

test('doctor emits deterministic skipped workspace checks when no workspace is selected',async t=>{
    const workspaceRoot=await mkdtemp(path.join(os.tmpdir(),'arcane-doctor-none-'));
    t.after(()=>rm(workspaceRoot,{recursive:true,force:true}));
    const report=await doctor(workspaceRoot);

    assert.deepEqual(workspaceChecks(report).map(check=>check.status),['skipped','skipped']);
    assert.equal(report.ok,true);
});

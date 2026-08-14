import assert from 'node:assert/strict';
import test from 'node:test';
import {assessArcaneOllama} from '../src/doctor.mjs';

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

#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeSync} from 'node:fs';
import {lstat,readdir,realpath} from 'node:fs/promises';
import {register} from 'node:module';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import test,{DEFAULT_TEST_TIMEOUT_MS,runRegisteredTests} from '../src/testing.mjs';

const SINGLE_FILE_ARGUMENT='--arcane-single-test-file';
const RUNNER_PATH=fileURLToPath(import.meta.url);
const TEST_FILE_PATTERN=/\.test\.(?:mjs|cjs|js)$/u;
const CANCELLATION_FORCE_WAIT_MS=1500;
const WATCHDOG_REPORT_GRACE_MS=500;
const FILE_HEARTBEAT_MS=30_000;
const OUTPUT_FLUSH_TIMEOUT_MS=5_000;
const BETWEEN_PHASE_TIMEOUT_MS=30_000;
const TREE_DRAIN_DIAGNOSTIC_BYTES=4_096;
const IPC_PROTOCOL=1;
const IPC_TOKEN_ENV='ARCANE_TEST_IPC_TOKEN';
const ISOLATED_MODE=process.argv[2]===SINGLE_FILE_ARGUMENT;
const ISOLATED_TOKEN=ISOLATED_MODE?process.env[IPC_TOKEN_ENV]:null;
const ISOLATED_SEND=ISOLATED_MODE&&typeof process.send==='function'
    ?process.send.bind(process)
    :null;
if(ISOLATED_MODE)delete process.env[IPC_TOKEN_ENV];

function comparePaths(left,right){
    return left.localeCompare(right,'en');
}

function throwIfCancelled(signal){
    if(signal?.aborted){
        throw signal.reason??new Error('The test run was cancelled.');
    }
}

async function collectDirectory(root,files,signal){
    throwIfCancelled(signal);
    const entries=await readdir(root,{withFileTypes:true});
    throwIfCancelled(signal);
    for(const entry of entries.sort((left,right)=>comparePaths(left.name,right.name))){
        throwIfCancelled(signal);
        const candidate=path.join(root,entry.name);
        if(entry.isSymbolicLink()){
            throw new Error(`Test discovery refuses symbolic links: ${candidate}`);
        }
        if(entry.isDirectory()){
            await collectDirectory(candidate,files,signal);
        }else if(entry.isFile()&&TEST_FILE_PATTERN.test(entry.name)){
            files.add(await realpath(candidate));
        }
    }
}

async function collectTestFiles(arguments_,signal){
    const requested=arguments_.length>0
        ?arguments_.map(candidate=>path.resolve(candidate))
        :[path.join(process.cwd(),'test')];
    const files=new Set();
    for(const candidate of requested.sort(comparePaths)){
        throwIfCancelled(signal);
        let info;
        try{
            info=await lstat(candidate);
        }catch(error){
            if(error?.code==='ENOENT'&&arguments_.length===0)continue;
            throw error;
        }
        throwIfCancelled(signal);
        if(info.isSymbolicLink()){
            throw new Error(`Test paths must not be symbolic links: ${candidate}`);
        }
        if(info.isDirectory()){
            await collectDirectory(candidate,files,signal);
        }else if(info.isFile()&&TEST_FILE_PATTERN.test(path.basename(candidate))){
            files.add(await realpath(candidate));
        }else{
            throw new Error(`Expected a .test.js, .test.cjs, or .test.mjs file: ${candidate}`);
        }
    }
    return [...files].sort(comparePaths);
}

function formatError(error){
    return error instanceof Error?(error.stack??`${error.name}: ${error.message}`):String(error);
}

function sendIsolatedMessage(message){
    if(typeof ISOLATED_TOKEN!=='string'||ISOLATED_TOKEN===''||ISOLATED_SEND===null){
        return Promise.reject(
            new Error('Internal single-file mode requires its authenticated coordinator channel.')
        );
    }
    return new Promise((resolve,reject)=>{
        ISOLATED_SEND(
            {...message,protocol:IPC_PROTOCOL,token:ISOLATED_TOKEN},
            error=>error?reject(error):resolve()
        );
    });
}

function interceptIsolatedExit(){
    process.exit=function interceptedTestExit(code){
        const error=new Error(
            `process.exit(${code===undefined?'':String(code)}) is not permitted inside an isolated test file.`
        );
        error.code='ARCANE_TEST_PREMATURE_EXIT';
        throw error;
    };
}

function displayFile(file){
    const relative=path.relative(process.cwd(),file);
    return relative===''?path.basename(file):relative;
}

function startHeartbeat(label){
    const started=Date.now();
    const heartbeat=setInterval(()=>{
        const elapsedSeconds=Math.max(1,Math.floor((Date.now()-started)/1000));
        console.log(`[arcane-test] HEARTBEAT ${label} (${String(elapsedSeconds)}s elapsed)`);
    },FILE_HEARTBEAT_MS);
    heartbeat.unref?.();
    return ()=>clearInterval(heartbeat);
}

function childIsRunning(child){
    return Boolean(child?.pid)&&child.exitCode===null&&child.signalCode===null;
}

function killDirectChild(child,force){
    if(!childIsRunning(child))return;
    try{
        child.kill(force?'SIGKILL':'SIGTERM');
    }catch{}
}

function parseTaskkillTargets(output,leaderPid){
    const entries=[];
    for(const line of output.split(/\r?\n/u).map(value=>value.trim()).filter(Boolean)){
        if(/^Reason\s*:/iu.test(line)){
            if(/\d/u.test(line))return null;
            continue;
        }
        if(!/^(?:ERROR|SUCCESS)\s*:/iu.test(line))return null;
        const matches=[...line.matchAll(/\bPID\s+(\d+)\b/giu)];
        if(matches.length<1||matches.length>2)return null;
        const target=Number(matches[0][1]);
        const parent=matches.length===2?Number(matches[1][1]):null;
        if(
            !Number.isSafeInteger(target)||target<=0
            ||(parent!==null&&(!Number.isSafeInteger(parent)||parent<=0))
            ||/\d/u.test(line.replaceAll(/\bPID\s+\d+\b/giu,'PID'))
        )return null;
        entries.push({target,parent});
    }
    const targets=new Set(entries.map(entry=>entry.target));
    if(entries.length===0||!targets.has(leaderPid))return null;
    const parents=new Map();
    for(const entry of entries){
        if(parents.has(entry.target)&&parents.get(entry.target)!==entry.parent)return null;
        parents.set(entry.target,entry.parent);
    }
    for(const target of targets){
        const seen=new Set();
        let current=target;
        while(current!==leaderPid){
            if(seen.has(current))return null;
            seen.add(current);
            const parent=parents.get(current);
            if(parent===null||!targets.has(parent))return null;
            current=parent;
        }
    }
    return targets;
}

function windowsPidIsAbsent(pid){
    try{
        process.kill(pid,0);
        return false;
    }catch(error){
        return error?.code==='ESRCH';
    }
}

async function waitForWindowsPidsAbsent(pids,deadline){
    while(performance.now()<deadline){
        if([...pids].every(windowsPidIsAbsent))return true;
        await new Promise(resolve=>setTimeout(resolve,20));
    }
    return [...pids].every(windowsPidIsAbsent);
}

function forceDrainWindowsTree(child){
    if(!childIsRunning(child)){
        console.error(
            `[arcane-test] TREE DRAIN FAILED for PID ${String(child?.pid??'unknown')}: `+
            'the isolated leader closed before tree draining began.'
        );
        return Promise.resolve(false);
    }
    return new Promise(resolve=>{
        let settled=false;
        let killer;
        let stage='taskkill';
        let stdoutDiagnostic='';
        let stderrDiagnostic='';
        const deadline=performance.now()+CANCELLATION_FORCE_WAIT_MS;
        const capture=(stream,chunk)=>{
            const value=`${stream}${chunk.toString()}`;
            return value.slice(-TREE_DRAIN_DIAGNOSTIC_BYTES);
        };
        const diagnostic=()=>[stdoutDiagnostic,stderrDiagnostic]
            .map(value=>value.trim()).filter(Boolean).join('\n');
        const reportFailure=reason=>{
            const detail=diagnostic();
            console.error(
                `[arcane-test] TREE DRAIN FAILED for PID ${String(child.pid)}: ${reason}`+
                `${detail?`\n${detail}`:''}`
            );
        };
        const finish=proven=>{
            if(settled)return;
            settled=true;
            clearTimeout(timeout);
            killer?.removeAllListeners();
            resolve(proven);
        };
        const timeout=setTimeout(()=>{
            killDirectChild(child,true);
            try{killer?.kill('SIGKILL');}catch{}
            reportFailure(`${stage} exceeded ${String(CANCELLATION_FORCE_WAIT_MS)} ms.`);
            finish(false);
        },CANCELLATION_FORCE_WAIT_MS);
        try{
            killer=spawn(
                'taskkill.exe',
                ['/PID',String(child.pid),'/T','/F'],
                {shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']}
            );
            killer.stdout?.on('data',chunk=>{
                stdoutDiagnostic=capture(stdoutDiagnostic,chunk);
            });
            killer.stderr?.on('data',chunk=>{
                stderrDiagnostic=capture(stderrDiagnostic,chunk);
            });
        }catch(error){
            killDirectChild(child,true);
            reportFailure(`taskkill could not start: ${formatError(error)}`);
            finish(false);
            return;
        }
        killer.once('error',error=>{
            if(settled)return;
            killDirectChild(child,true);
            reportFailure(`taskkill failed: ${formatError(error)}`);
            finish(false);
        });
        killer.once('close',code=>{
            if(settled)return;
            if(code===0){
                finish(true);
                return;
            }
            const targets=parseTaskkillTargets(diagnostic(),child.pid);
            if(targets===null){
                killDirectChild(child,true);
                reportFailure(
                    `taskkill exited with code ${String(code)} and its PID report was not provable.`
                );
                finish(false);
                return;
            }
            stage='taskkill PID absence proof';
            void waitForWindowsPidsAbsent(targets,deadline).then(proven=>{
                if(settled)return;
                if(!proven){
                    killDirectChild(child,true);
                    reportFailure(
                        `taskkill exited with code ${String(code)} and at least one reported PID `+
                        'remained live or was reused.'
                    );
                }
                finish(proven);
            });
        });
    });
}

async function forceDrainUnixGroup(child){
    if(!childIsRunning(child))return false;
    const group=-child.pid;
    try{
        process.kill(group,'SIGKILL');
    }catch(error){
        if(error?.code!=='ESRCH')killDirectChild(child,true);
        return false;
    }
    const deadline=performance.now()+CANCELLATION_FORCE_WAIT_MS;
    while(performance.now()<deadline){
        await new Promise(resolve=>setTimeout(resolve,20));
        try{
            process.kill(group,0);
        }catch(error){
            if(error?.code==='ESRCH')return true;
            return false;
        }
    }
    return false;
}

function forceDrainProcessTree(child){
    return process.platform==='win32'
        ?forceDrainWindowsTree(child)
        :forceDrainUnixGroup(child);
}

function runIsolatedFile(file,signal){
    if(signal.aborted)return Promise.reject(signal.reason);
    return new Promise((resolve,reject)=>{
        const token=randomUUID();
        let settled=false;
        let escalation=null;
        let forceSettlement=null;
        let idleTimer=null;
        let completion=null;
        let watchdogFailure=null;
        let closed=null;
        let drainStarted=false;
        let drainProven=null;
        let child;
        const phaseTimers=new Map();
        const stopHeartbeat=startHeartbeat(displayFile(file));
        const clearPhases=()=>{
            for(const timer of phaseTimers.values())clearTimeout(timer);
            phaseTimers.clear();
        };
        const finish=(callback,value)=>{
            if(settled)return;
            settled=true;
            clearTimeout(escalation);
            clearTimeout(forceSettlement);
            clearTimeout(idleTimer);
            clearPhases();
            stopHeartbeat();
            signal.removeEventListener('abort',abort);
            callback(value);
        };
        const sendAbort=reason=>{
            if(!child?.connected)return;
            try{
                child.send(
                    {protocol:IPC_PROTOCOL,token,type:'abort',reason},
                    ()=>{}
                );
            }catch{}
        };
        const settleClosed=()=>{
            if(closed===null)return;
            if(signal.aborted){
                if(drainProven===null)return;
                if(!drainProven){
                    const error=new Error(
                        `Could not drain the cancelled process tree for ${displayFile(file)}.`
                    );
                    error.code='ARCANE_TEST_DRAIN_FAILED';
                    finish(
                        reject,
                        error
                    );
                }else{
                    finish(reject,signal.reason);
                }
                return;
            }
            if(completion!==null||watchdogFailure!==null){
                if(drainProven===null)return;
                finish(resolve,{
                    code:drainProven
                        ?(watchdogFailure===null?completion?.status??1:1)
                        :2,
                    signal:closed.signal,
                    watchdog:watchdogFailure,
                    drainProven,
                    fatalIsolation:!drainProven
                });
                return;
            }
            console.error(
                `[arcane-test] ${displayFile(file)} closed without an authenticated harness report.`
            );
            finish(resolve,{
                code:2,
                signal:closed.signal,
                rawCode:closed.code,
                fatalIsolation:true
            });
        };
        const beginDrain=()=>{
            if(drainStarted||settled)return;
            drainStarted=true;
            clearTimeout(escalation);
            clearTimeout(idleTimer);
            clearPhases();
            const armCloseDeadline=()=>{
                if(closed!==null||settled)return;
                forceSettlement=setTimeout(()=>{
                    child?.unref?.();
                    finish(resolve,{
                        code:2,
                        signal:null,
                        watchdog:watchdogFailure,
                        drainProven:false,
                        fatalIsolation:true
                    });
                },CANCELLATION_FORCE_WAIT_MS);
                forceSettlement.unref?.();
            };
            void forceDrainProcessTree(child).then(proven=>{
                drainProven=proven;
                if(!proven)killDirectChild(child,true);
                settleClosed();
                armCloseDeadline();
            }).catch(()=>{
                drainProven=false;
                killDirectChild(child,true);
                settleClosed();
                armCloseDeadline();
            });
        };
        const watchdog=phase=>{
            if(watchdogFailure!==null||settled)return;
            watchdogFailure={
                kind:phase.kind,
                name:phase.name,
                timeoutMs:phase.timeoutMs
            };
            clearTimeout(idleTimer);
            clearPhases();
            console.error(
                `[arcane-test] WATCHDOG ${phase.kind} "${phase.name}" exceeded `+
                `${String(phase.timeoutMs)} ms.`
            );
            sendAbort(`The ${phase.kind} phase exceeded ${String(phase.timeoutMs)} ms.`);
            escalation=setTimeout(beginDrain,WATCHDOG_REPORT_GRACE_MS);
            escalation.unref?.();
        };
        const scheduleIdle=()=>{
            clearTimeout(idleTimer);
            if(
                settled||completion!==null||watchdogFailure!==null
                ||phaseTimers.size>0
            )return;
            const phase={
                kind:'coordination',
                name:`${displayFile(file)} next phase or completion`,
                timeoutMs:BETWEEN_PHASE_TIMEOUT_MS
            };
            idleTimer=setTimeout(()=>watchdog(phase),BETWEEN_PHASE_TIMEOUT_MS);
            idleTimer.unref?.();
        };
        const onMessage=message=>{
            if(
                message?.protocol!==IPC_PROTOCOL
                ||message?.token!==token
                ||typeof message.type!=='string'
            )return;
            if(message.type==='phase'){
                if(
                    completion!==null
                    ||watchdogFailure!==null
                    ||typeof message.id!=='string'
                    ||message.id===''||message.id.length>200
                )return;
                if(message.status==='started'){
                    if(
                        typeof message.kind!=='string'
                        ||typeof message.name!=='string'
                        ||!Number.isSafeInteger(message.timeoutMs)
                        ||message.timeoutMs<1
                        ||message.timeoutMs>3_600_000
                        ||phaseTimers.has(message.id)
                    )return;
                    clearTimeout(idleTimer);
                    const timer=setTimeout(()=>watchdog(message),message.timeoutMs);
                    phaseTimers.set(message.id,timer);
                }else if(message.status==='completed'){
                    const timer=phaseTimers.get(message.id);
                    if(timer!==undefined){
                        clearTimeout(timer);
                        phaseTimers.delete(message.id);
                        scheduleIdle();
                    }
                }
                return;
            }
            if(message.type==='complete'){
                if(completion!==null||![0,1,2,130].includes(message.status))return;
                completion={status:message.status};
                clearTimeout(escalation);
                clearTimeout(idleTimer);
                clearPhases();
                beginDrain();
            }
        };
        const abort=()=>{
            clearPhases();
            sendAbort('The coordinator cancelled the test run.');
            beginDrain();
        };
        try{
            child=spawn(process.execPath,[RUNNER_PATH,SINGLE_FILE_ARGUMENT,file],{
                env:{...process.env,[IPC_TOKEN_ENV]:token},
                shell:false,
                windowsHide:true,
                detached:process.platform!=='win32',
                stdio:['inherit','inherit','inherit','ipc']
            });
        }catch(error){
            finish(reject,error);
            return;
        }
        child.on('message',onMessage);
        child.once('error',error=>finish(reject,error));
        child.once('close',(code,childSignal)=>{
            closed={code,signal:childSignal};
            settleClosed();
        });
        signal.addEventListener('abort',abort,{once:true});
        scheduleIdle();
        if(signal.aborted)abort();
    });
}

async function runSingleFile(file,signal){
    console.log(`[arcane-test] IMPORT ${displayFile(file)}`);
    register(new URL('../src/testing-loader.mjs',import.meta.url),import.meta.url);
    const importPhase={
        id:'module-import',
        kind:'import',
        name:displayFile(file),
        status:'started',
        timeoutMs:DEFAULT_TEST_TIMEOUT_MS,
        type:'phase'
    };
    await sendIsolatedMessage(importPhase);
    const importStarted=performance.now();
    let importError=null;
    try{
        try{
            await import(pathToFileURL(file).href);
        }catch(error){
            importError=error;
        }
    }finally{
        await sendIsolatedMessage({
            ...importPhase,
            status:'completed',
            elapsedMs:performance.now()-importStarted
        });
    }
    if(importError!==null){
        test(`[module import] ${path.basename(file)}`,function reportImportFailure(){
            throw importError;
        });
    }
    const result=await runRegisteredTests({
        signal,
        requireTests:true,
        onPhase:message=>sendIsolatedMessage({...message,type:'phase'})
    });
    return result.ok?0:1;
}

async function runCoordinator(arguments_,signal){
    console.log('[arcane-test] Discovering test files.');
    const stopHeartbeat=startHeartbeat('test discovery');
    let files;
    try{
        files=await collectTestFiles(arguments_,signal);
    }finally{
        stopHeartbeat();
    }
    console.log(`[arcane-test] Discovered ${String(files.length)} test file(s).`);
    if(files.length===0){
        const result=await runRegisteredTests({signal,requireTests:true});
        return result.ok?0:1;
    }
    let status=0;
    for(const file of files){
        if(signal.aborted)throw signal.reason;
        console.log(`[arcane-test] START ${displayFile(file)}`);
        const result=await runIsolatedFile(file,signal);
        console.log(
            `[arcane-test] COMPLETE ${displayFile(file)} (exit ${String(result.code)}`+
            `${result.signal===null?'':`, signal ${result.signal}`})`
        );
        if(result.fatalIsolation)return 2;
        if(result.code===130)return 130;
        if(result.code===1){
            if(status===0)status=1;
        }else if(result.code!==0){
            status=2;
        }
    }
    return status;
}

function flushStream(stream){
    if(!stream||stream.writableEnded)return Promise.resolve(true);
    if(stream.destroyed||stream.writable===false)return Promise.resolve(false);
    return new Promise(resolve=>{
        let settled=false;
        const finish=flushed=>{
            if(settled)return;
            settled=true;
            clearTimeout(timeout);
            stream.removeListener('error',failed);
            resolve(flushed);
        };
        const failed=()=>finish(false);
        const timeout=setTimeout(failed,OUTPUT_FLUSH_TIMEOUT_MS);
        stream.once('error',failed);
        try{
            stream.write('',()=>finish(true));
        }catch{
            failed();
        }
    });
}

async function flushOutput(){
    const flushed=await Promise.all([flushStream(process.stdout),flushStream(process.stderr)]);
    if(flushed.every(Boolean))return;
    try{
        writeSync(
            2,
            '[arcane-test] Output flush exceeded its bounded drain; diagnostics may be truncated.\n'
        );
    }catch{}
}

async function main(){
    console.log('[arcane-test] Test request accepted.');
    const controller=new AbortController();
    const cancel=signal=>{
        const error=new Error(`Test run interrupted by ${signal}.`);
        error.code='ARCANE_TEST_CANCELLED';
        controller.abort(error);
    };
    const interrupt=()=>cancel('SIGINT');
    const terminateRun=()=>cancel('SIGTERM');
    const parentAbort=message=>{
        if(
            message?.protocol!==IPC_PROTOCOL
            ||message?.token!==ISOLATED_TOKEN
            ||message?.type!=='abort'
        )return;
        const error=new Error(
            typeof message.reason==='string'?message.reason:'The coordinator cancelled the test file.'
        );
        error.code='ARCANE_TEST_CANCELLED';
        controller.abort(error);
    };
    process.once('SIGINT',interrupt);
    process.once('SIGTERM',terminateRun);
    if(ISOLATED_MODE)process.on('message',parentAbort);
    try{
        if(process.argv[2]===SINGLE_FILE_ARGUMENT){
            if(process.argv.length!==4){
                throw new Error(`${SINGLE_FILE_ARGUMENT} requires one exact test file.`);
            }
            if(typeof ISOLATED_TOKEN!=='string'||ISOLATED_TOKEN===''||ISOLATED_SEND===null){
                throw new Error(
                    'Internal single-file mode requires its authenticated coordinator channel.'
                );
            }
            interceptIsolatedExit();
            return await runSingleFile(path.resolve(process.argv[3]),controller.signal);
        }
        return await runCoordinator(process.argv.slice(2),controller.signal);
    }catch(error){
        if(error?.code==='ARCANE_TEST_DRAIN_FAILED'){
            console.error(formatError(error));
            return 2;
        }
        if(controller.signal.aborted){
            console.error(formatError(controller.signal.reason??error));
            return 130;
        }
        console.error(formatError(error));
        return 2;
    }finally{
        process.removeListener('SIGINT',interrupt);
        process.removeListener('SIGTERM',terminateRun);
        if(ISOLATED_MODE)process.removeListener('message',parentAbort);
    }
}

const isolatedHold=ISOLATED_MODE?setInterval(()=>{},60_000):null;
const releaseIsolatedHold=()=>{
    if(isolatedHold!==null)clearInterval(isolatedHold);
};
if(ISOLATED_MODE){
    process.once('disconnect',()=>{
        releaseIsolatedHold();
        process.exitCode=2;
    });
}
const status=await main();
if(ISOLATED_MODE){
    try{
        const flushPhase={
            id:'output-flush',
            kind:'flush',
            name:'test report output flush',
            status:'started',
            timeoutMs:OUTPUT_FLUSH_TIMEOUT_MS,
            type:'phase'
        };
        await sendIsolatedMessage(flushPhase);
        const flushStarted=performance.now();
        await flushOutput();
        await sendIsolatedMessage({
            ...flushPhase,
            status:'completed',
            elapsedMs:performance.now()-flushStarted
        });
        await sendIsolatedMessage({type:'complete',status});
    }catch(error){
        releaseIsolatedHold();
        console.error(formatError(error));
        process.exitCode=2;
        process.disconnect?.();
    }
}else{
    process.exitCode=status;
}

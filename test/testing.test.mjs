import assert from 'node:assert/strict';
import {copyFile,link,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import PackagePreferenceStore,{
    PREFERENCE_STORE_ERROR_CODES as PACKAGE_PREFERENCE_STORE_ERROR_CODES,
    Preference as PackagePreference,
    preferenceSchema as packagePreferenceSchema
} from 'arcane-os/preference-store';
import PackageSpeechPlayback,{
    SpeechPlayback as NamedPackageSpeechPlayback,
    splitSpeechText as packageSplitSpeechText
} from 'arcane-os/speech-playback';
import test from '../src/testing.mjs';
import {repositoryRoot,runNode} from './helpers.mjs';

const runnerPath=path.join(repositoryRoot,'bin','arcane-test.mjs');

test('runtime utility modules expose their canonical namespaces through static Node package entrypoints',()=>{
    assert.equal(typeof PackagePreferenceStore,'function');
    assert.equal(typeof PACKAGE_PREFERENCE_STORE_ERROR_CODES,'object');
    assert.equal(typeof PackagePreference,'function');
    assert.equal(typeof packagePreferenceSchema,'function');
    assert.equal(typeof PackageSpeechPlayback,'function');
    assert.equal(PackageSpeechPlayback,NamedPackageSpeechPlayback);
    assert.deepEqual(packageSplitSpeechText('ready'),['ready']);
});

async function temporaryRunnerRoot(t){
    const workspace=await mkdtemp(path.join(tmpdir(),'arcane-sdk-testing-'));
    const root=path.join(workspace,'test');
    await mkdir(root,{recursive:true});
    t.after(()=>rm(workspace,{force:true,recursive:true}));
    return root;
}

async function readOptional(file){
    try{return await readFile(file,'utf8');}
    catch(error){
        if(error?.code==='ENOENT')return '';
        throw error;
    }
}

test('isolated runner maps the public testing API and continues after a failing file',async t=>{
    const root=await temporaryRunnerRoot(t);
    const failedFile=path.join(root,'01-failure.test.mjs');
    const isolatedFile=path.join(root,'02-isolation.test.mjs');
    const marker=path.join(root,'second-file-ran.txt');
    await Promise.all([
        writeFile(failedFile,`import assert from 'node:assert/strict';
import test from 'arcane-os/testing';
globalThis.__arcaneIsolationProbe=(globalThis.__arcaneIsolationProbe??0)+1;
test('first file uses the mapped public API',()=>{
    assert.equal(globalThis.__arcaneIsolationProbe,1);
});
test('intentional first-file failure',()=>{
    throw new Error('intentional runner failure');
});
`),
        writeFile(isolatedFile,`import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import test from 'arcane-os/testing';
test('second file has an isolated global realm',async()=>{
    assert.equal(globalThis.__arcaneIsolationProbe,undefined);
    await writeFile(${JSON.stringify(marker)},'ran\\n');
});
`)
    ]);

    const result=await runNode([runnerPath,failedFile,isolatedFile],{cwd:root});
    assert.equal(result.code,1);
    assert.match(result.stdout,/Test request accepted/u);
    assert.match(result.stdout,/START .*01-failure\.test\.mjs/u);
    assert.match(result.stdout,/COMPLETE .*02-isolation\.test\.mjs/u);
    assert.match(result.stderr,/intentional runner failure/u);
    assert.match(result.stdout,/second file has an isolated global realm/u);
    assert.equal(await readFile(marker,'utf8'),'ran\n');
});

test('isolated runner confines an explicit source import map to the selected application',async t=>{
    const root=await temporaryRunnerRoot(t);
    const appId='managed-app';
    const appRoot=path.join(root,'apps',appId);
    const preferencePath=path.join(appRoot,'modules','PreferenceStore.js');
    const speechPath=path.join(appRoot,'modules','SpeechPlayback.js');
    const strongTypePath=path.join(appRoot,'dependencies','strong-type','index.js');
    const passingFile=path.join(appRoot,'test','managed-import.test.mjs');
    const missingFile=path.join(appRoot,'test','missing-import.test.mjs');
    await Promise.all([
        mkdir(path.dirname(preferencePath),{recursive:true}),
        mkdir(path.dirname(speechPath),{recursive:true}),
        mkdir(path.dirname(strongTypePath),{recursive:true}),
        mkdir(path.dirname(passingFile),{recursive:true})
    ]);
    await Promise.all([
        writeFile(
            preferencePath,
            "export const PREFERENCE_STORE_ERROR_CODES={disposed:'DISPOSED'};\n"
            +"export class Preference {}\n"
            +"export function preferenceSchema(definitions=[]){return definitions;}\n"
            +"export default class PreferenceStore {}\n"
        ),
        writeFile(
            speechPath,
            "import Is from '../dependencies/strong-type/index.js';\n"
            +"export function splitSpeechText(value){return [value];}\n"
            +"export class SpeechPlayback {}\n"
            +"export default SpeechPlayback;\n"
            +"export const managedStrongType=Is.managedSource;\n"
        ),
        writeFile(
            strongTypePath,
            "export default class Is { static managedSource='managed-runtime'; }\n"
        ),
        writeFile(passingFile,`import assert from 'node:assert/strict';
import BrowserPreferenceStore,{
    PREFERENCE_STORE_ERROR_CODES,
    Preference,
    preferenceSchema
} from 'arcane-os/preference-store';
import LegacyPreferenceStore from 'arcane/PreferenceStore';
import BrowserSpeechPlayback,{
    SpeechPlayback as NamedBrowserSpeechPlayback,
    managedStrongType,
    splitSpeechText
} from 'arcane-os/speech-playback';
import {managedStrongType as legacyManagedStrongType} from 'arcane/SpeechPlayback';
import test from 'arcane-os/testing';
test('managed bare and URL-like imports resolve inside the selected application source',()=>{
    assert.equal(BrowserPreferenceStore,LegacyPreferenceStore);
    assert.equal(PREFERENCE_STORE_ERROR_CODES.disposed,'DISPOSED');
    assert.equal(typeof Preference,'function');
    assert.equal(typeof preferenceSchema,'function');
    assert.equal(BrowserSpeechPlayback,NamedBrowserSpeechPlayback);
    assert.deepEqual(splitSpeechText('ready'),['ready']);
    assert.equal(managedStrongType,'managed-runtime');
    assert.equal(legacyManagedStrongType,managedStrongType);
});
`),
        writeFile(missingFile,`import 'arcane/NotExposed';
import test from 'arcane-os/testing';
test('unreachable when a reserved import is absent',()=>{});
`)
    ]);
    const imports={
        'arcane/PreferenceStore':'./modules/PreferenceStore.js',
        'arcane/SpeechPlayback':'./modules/SpeechPlayback.js',
        'arcane-os/preference-store':'./modules/PreferenceStore.js',
        'arcane-os/speech-playback':'./modules/SpeechPlayback.js',
        './dependencies/strong-type/index.js':'./dependencies/strong-type/index.js'
    };
    const context=(selectedBase=appRoot,selectedImports=imports)=>JSON.stringify({
        protocol:'arcane-test-import-map/1',
        boundary:'source',
        baseURL:pathToFileURL(`${selectedBase}${path.sep}`).href,
        imports:selectedImports
    });
    const environment=managedContext=>({
        ARCANE_TEST_IMPORT_MAP_CONTEXT:managedContext
    });
    const passingEnvironment=environment(context());

    const passing=await runNode([runnerPath,passingFile],{cwd:root,env:passingEnvironment});
    assert.equal(passing.code,0,passing.stderr);
    assert.match(passing.stdout,/managed bare and URL-like imports/u);

    const missing=await runNode([runnerPath,missingFile],{
        cwd:root,
        env:environment(context())
    });
    assert.equal(missing.code,1,missing.stderr);
    assert.match(missing.stderr,/does not expose arcane\/NotExposed/u);

    const malformed=await runNode([runnerPath,passingFile],{
        cwd:root,
        env:environment('{not valid JSON')
    });
    assert.equal(malformed.code,2,malformed.stderr);
    assert.match(malformed.stderr,/not valid JSON/u);

    const unsafe=await runNode([runnerPath,passingFile],{
        cwd:root,
        env:environment(context(appRoot,{
            'arcane-os/speech-playback':'../outside.js'
        }))
    });
    assert.equal(unsafe.code,2,unsafe.stderr);
    assert.match(unsafe.stderr,/entry is invalid/u);

    const otherApp=await runNode([runnerPath,passingFile],{
        cwd:root,
        env:environment(context(path.join(root,'apps','other-app')))
    });
    assert.equal(otherApp.code,2,otherApp.stderr);
    assert.match(otherApp.stderr,/this application's physical source directory/u);
});

test('runner preserves nested cases, FIFO async cleanup, timeout failure, and zero-test failure',async t=>{
    const root=await temporaryRunnerRoot(t);
    const successFile=path.join(root,'success.test.mjs');
    const timeoutFile=path.join(root,'timeout.test.mjs');
    const emptyFile=path.join(root,'empty.test.mjs');
    await Promise.all([
        writeFile(successFile,`import assert from 'node:assert/strict';
import test from 'arcane-os/testing';
const order=[];
test('cleanup owner',async t=>{
    t.after(()=>order.push('first'));
    t.after(async()=>{order.push('second');});
});

test('nested owner',async t=>{
    assert.deepEqual(order,['first','second']);
    await t.test('nested child',async()=>{});
});
`),
        writeFile(timeoutFile,`import test from 'arcane-os/testing';
test('bounded timeout',{timeout:5},()=>new Promise(resolve=>setTimeout(resolve,40)));
`),
        writeFile(emptyFile,'export const empty=true;\n')
    ]);

    const success=await runNode([runnerPath,successFile],{cwd:root});
    assert.equal(success.code,0,success.stderr);
    assert.match(success.stdout,/nested child/u);
    const timedOut=await runNode([runnerPath,timeoutFile],{cwd:root});
    assert.equal(timedOut.code,1);
    assert.match(timedOut.stderr,/ARCANE_TEST_TIMEOUT|exceeded 5 ms/u);
    const empty=await runNode([runnerPath,emptyFile],{cwd:root});
    assert.equal(empty.code,1);
    assert.match(empty.stderr,/did not register any tests/u);
});

test('a timeout is file-fatal and late work cannot overlap cleanup or a later test',async t=>{
    const root=await temporaryRunnerRoot(t);
    const timeoutFile=path.join(root,'fatal-timeout.test.mjs');
    const marker=path.join(root,'fatal-order.txt');
    await writeFile(timeoutFile,`import {appendFile} from 'node:fs/promises';
import test from 'arcane-os/testing';
test('fatal timeout',{timeout:25},async t=>{
    t.after(()=>appendFile(${JSON.stringify(marker)},'cleanup\\n'));
    await appendFile(${JSON.stringify(marker)},'body-start\\n');
    await new Promise(resolve=>setTimeout(resolve,250));
    await appendFile(${JSON.stringify(marker)},'late-body\\n');
});
test('must not start after a fatal timeout',()=>appendFile(${JSON.stringify(marker)},'later-test\\n'));
`);

    const result=await runNode([runnerPath,timeoutFile],{cwd:root,timeout:5_000});
    assert.equal(result.timedOut,false,result.stderr);
    assert.equal(result.code,1);
    assert.match(result.stderr,/ARCANE_TEST_TIMEOUT|exceeded 25 ms/u);
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.doesNotMatch(await readFile(marker,'utf8'),/cleanup|later-test/u);
    assert.doesNotMatch(result.stdout,/must not start after a fatal timeout/u);
});

test('a referenced interval cannot keep a timed-out isolated file alive',async t=>{
    const root=await temporaryRunnerRoot(t);
    const timeoutFile=path.join(root,'live-interval.test.mjs');
    await writeFile(timeoutFile,`import test from 'arcane-os/testing';
test('interval timeout',{timeout:25},()=>new Promise(()=>{
    setInterval(()=>{},1_000);
}));
`);

    const result=await runNode([runnerPath,timeoutFile],{cwd:root,timeout:5_000});
    assert.equal(result.timedOut,false,result.stderr);
    assert.equal(result.code,1);
    assert.match(result.stderr,/ARCANE_TEST_TIMEOUT|exceeded 25 ms/u);
});

test('parent watchdog rejects finite synchronous CPU work beyond the test timeout',async t=>{
    const root=await temporaryRunnerRoot(t);
    const busyFile=path.join(root,'sync-overrun.test.mjs');
    const marker=path.join(root,'sync-overrun-later.txt');
    await writeFile(busyFile,`import {writeFile} from 'node:fs/promises';
import test from 'arcane-os/testing';
test('synchronous overrun',{timeout:5},()=>{
    const deadline=Date.now()+100;
    while(Date.now()<deadline){}
});
test('must not run after synchronous timeout',()=>writeFile(${JSON.stringify(marker)},'ran\\n'));
`);

    const result=await runNode([runnerPath,busyFile],{cwd:root,timeout:5_000});
    assert.equal(result.timedOut,false,result.stderr);
    assert.equal(result.code,1);
    assert.match(result.stderr,/WATCHDOG|exceeded 5 ms/u);
    await assert.rejects(readFile(marker,'utf8'),error=>error?.code==='ENOENT');
});

test('parent watchdog kills an infinite synchronous callback',async t=>{
    const root=await temporaryRunnerRoot(t);
    const infiniteFile=path.join(root,'sync-infinite.test.mjs');
    await writeFile(infiniteFile,`import test from 'arcane-os/testing';
test('infinite synchronous callback',{timeout:25},()=>{
    while(true){}
});
`);

    const result=await runNode([runnerPath,infiniteFile],{cwd:root,timeout:5_000});
    assert.equal(result.timedOut,false,result.stderr);
    assert.equal(result.code,1);
    assert.match(result.stderr,/WATCHDOG .*infinite synchronous callback.*25 ms/u);
});

test('an early process.exit(0) cannot bypass the isolated harness report',async t=>{
    const root=await temporaryRunnerRoot(t);
    const earlyExitFile=path.join(root,'early-exit.test.mjs');
    await writeFile(earlyExitFile,`import test from 'arcane-os/testing';
test('must never be reported green',()=>{});
process.exit(0);
`);

    const result=await runNode([runnerPath,earlyExitFile],{cwd:root});
    assert.equal(result.code,1);
    assert.match(result.stderr,/process\.exit\(0\) is not permitted/u);
    assert.doesNotMatch(result.stdout,/Result : .*PASSED/u);
});

test('isolated completion hold is owned before test imports can replace timers',async t=>{
    const root=await temporaryRunnerRoot(t);
    const timerTamperFile=path.join(root,'timer-tamper.test.mjs');
    await writeFile(timerTamperFile,`import test from 'arcane-os/testing';
test('timer replacement cannot close the completion window',()=>{
    globalThis.setInterval=()=>{
        process.nextTick(()=>process.disconnect());
        return {unref(){}};
    };
});
`);

    const result=await runNode([runnerPath,timerTamperFile],{cwd:root,timeout:5_000});
    assert.equal(result.timedOut,false,result.stderr);
    assert.equal(result.code,0,result.stderr);
    assert.doesNotMatch(result.stderr,/TREE DRAIN FAILED/u);
});

test('Windows nonzero tree drain requires a complete absent PID proof',async t=>{
    if(process.platform!=='win32')return;
    const root=await temporaryRunnerRoot(t);
    const fakeTaskkill=path.join(root,'taskkill.exe');
    const preload=path.join(root,'fake-taskkill.cjs');
    const testFile=path.join(root,'tree-drain-proof.test.mjs');
    const pathName=Object.keys(process.env)
        .find(name=>name.toUpperCase()==='PATH')??'PATH';
    await Promise.all([
        link(process.execPath,fakeTaskkill).catch(error=>{
            if(!['EACCES','EPERM','EXDEV'].includes(error?.code))throw error;
            return copyFile(process.execPath,fakeTaskkill);
        }),
        writeFile(preload,`const path=require('node:path');
if(path.basename(process.execPath).toLowerCase()==='taskkill.exe'){
    const pid=Number(process.argv.find(value=>/^\\d+$/u.test(value)));
    const mode=process.env.ARCANE_TEST_FAKE_TASKKILL;
    if(mode==='absent'){
        try{process.kill(pid,'SIGKILL');}catch{}
        process.stdout.write(
            \`ERROR: The process with PID \${pid} (child process of PID \${process.ppid}) could not be terminated.\\n\`+
            'Reason: The operation attempted is not supported.\\n'
        );
    }else if(mode==='live'){
        process.stderr.write(
            \`ERROR: The process with PID \${pid} (child process of PID \${process.ppid}) could not be terminated.\\n\`+
            'Reason: The operation attempted is not supported.\\n'
        );
    }else{
        process.stderr.write('simulated taskkill output without a PID report\\n');
    }
    process.exit(128);
}
`),
        writeFile(testFile,`import test from 'arcane-os/testing';
test('tree drain proof fixture',()=>{});
`)
    ]);
    const environment=mode=>({
        [pathName]:`${root}${path.delimiter}${process.env[pathName]??''}`,
        ARCANE_TEST_FAKE_TASKKILL:mode,
        NODE_OPTIONS:`--require=${preload}`
    });

    const absent=await runNode(
        [runnerPath,testFile],
        {cwd:root,env:environment('absent'),timeout:5_000}
    );
    assert.equal(absent.code,0,absent.stderr);
    assert.doesNotMatch(absent.stderr,/TREE DRAIN FAILED/u);

    const live=await runNode(
        [runnerPath,testFile],
        {cwd:root,env:environment('live'),timeout:5_000}
    );
    assert.equal(live.code,2,live.stderr);
    assert.match(
        live.stderr,
        /TREE DRAIN FAILED[\s\S]*(?:remained live or was reused|PID absence proof exceeded)/u
    );

    const unparsable=await runNode(
        [runnerPath,testFile],
        {cwd:root,env:environment('unparsable'),timeout:5_000}
    );
    assert.equal(unparsable.code,2,unparsable.stderr);
    assert.match(unparsable.stderr,/TREE DRAIN FAILED[\s\S]*PID report was not provable/u);
});

test('isolated report flush preserves a complete large diagnostic',async t=>{
    const root=await temporaryRunnerRoot(t);
    const failureFile=path.join(root,'large-diagnostic.test.mjs');
    await writeFile(failureFile,`import test from 'arcane-os/testing';
test('large diagnostic',()=>{
    throw new Error('x'.repeat(256*1024)+'ARCANE_DIAGNOSTIC_COMPLETE_END');
});
`);

    const result=await runNode([runnerPath,failureFile],{cwd:root});
    assert.equal(result.code,1);
    assert.match(result.stderr,/ARCANE_DIAGNOSTIC_COMPLETE_END/u);
    assert.doesNotMatch(result.stderr,/truncated/u);
});

test('a nested timeout cannot start a queued sibling or mutate outcomes after report',async t=>{
    const root=await temporaryRunnerRoot(t);
    const timeoutFile=path.join(root,'nested-fatal-timeout.test.mjs');
    const marker=path.join(root,'nested-fatal-order.txt');
    await writeFile(timeoutFile,`import {appendFile} from 'node:fs/promises';
import test from 'arcane-os/testing';
test('nested owner',async t=>{
    const timedOut=t.test('nested timeout',{timeout:25},async()=>{
        await new Promise(resolve=>setTimeout(resolve,250));
        await appendFile(${JSON.stringify(marker)},'late-nested-body\\n');
    });
    const sibling=t.test('queued sibling',()=>appendFile(${JSON.stringify(marker)},'queued-sibling\\n'));
    await Promise.allSettled([timedOut,sibling]);
});
test('later top-level test',()=>appendFile(${JSON.stringify(marker)},'later-top-level\\n'));
`);

    const result=await runNode([runnerPath,timeoutFile],{cwd:root,timeout:5_000});
    assert.equal(result.timedOut,false,result.stderr);
    assert.equal(result.code,1);
    assert.match(result.stderr,/ARCANE_TEST_TIMEOUT|exceeded 25 ms/u);
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.doesNotMatch(await readOptional(marker),/queued-sibling|later-top-level/u);
    assert.doesNotMatch(result.stdout,/queued sibling|later top-level test/u);
});

test('parent registration closes before its already-owned child queue drains',async t=>{
    const root=await temporaryRunnerRoot(t);
    const ownershipFile=path.join(root,'stable-child-queue.test.mjs');
    const marker=path.join(root,'stable-child-queue.txt');
    await writeFile(ownershipFile,`import {appendFileSync} from 'node:fs';
import test from 'arcane-os/testing';
test('stable parent queue',t=>{
    void t.test('owned child',()=>new Promise(resolve=>setTimeout(resolve,100)));
    setTimeout(()=>{
        try{
            t.after(()=>appendFileSync(${JSON.stringify(marker)},'late-cleanup-ran\\n'));
        }catch(error){
            appendFileSync(${JSON.stringify(marker)},\`after:\${error.name}\\n\`);
        }
        void t.test('late child',()=>appendFileSync(${JSON.stringify(marker)},'late-child-ran\\n'))
            .catch(error=>appendFileSync(${JSON.stringify(marker)},\`test:\${error.name}\\n\`));
    },25);
});
`);

    const result=await runNode([runnerPath,ownershipFile],{cwd:root});
    assert.equal(result.code,0,result.stderr);
    assert.equal(await readFile(marker,'utf8'),'after:ReferenceError\ntest:ReferenceError\n');
    assert.doesNotMatch(result.stdout,/late child/u);
});

test('coordinator SIGINT cancellation exits 130 and drains the isolated callback',async t=>{
    const root=await temporaryRunnerRoot(t);
    const cancelledFile=path.join(root,'cancelled.test.mjs');
    const coordinatorFile=path.join(root,'interrupt-coordinator.mjs');
    const marker=path.join(root,'cancelled-started.txt');
    await Promise.all([
        writeFile(cancelledFile,`import {writeFile} from 'node:fs/promises';
import test from 'arcane-os/testing';
test('cancelled callback',async()=>{
    setInterval(()=>{},1_000);
    await writeFile(${JSON.stringify(marker)},'started\\n');
    await new Promise(()=>{});
});
`),
        writeFile(coordinatorFile,`import {pathToFileURL} from 'node:url';
const [runner,file]=process.argv.slice(2);
process.argv=[process.execPath,runner,file];
setTimeout(()=>process.emit('SIGINT'),250);
await import(pathToFileURL(runner).href);
`)
    ]);

    const result=await runNode(
        [coordinatorFile,runnerPath,cancelledFile],
        {cwd:root,timeout:5_000}
    );
    assert.equal(result.timedOut,false,result.stderr);
    assert.equal(result.code,130);
    assert.match(result.stderr,/interrupted by SIGINT/u);
    assert.equal(await readFile(marker,'utf8'),'started\n');
});

test('cleanup failure is reported and does not prevent a later test',async t=>{
    const root=await temporaryRunnerRoot(t);
    const cleanupFile=path.join(root,'cleanup-failure.test.mjs');
    const marker=path.join(root,'after-cleanup-failure.txt');
    await writeFile(cleanupFile,`import {writeFile} from 'node:fs/promises';
import test from 'arcane-os/testing';
test('cleanup owner',t=>{
    t.after(()=>{throw new Error('intentional cleanup failure');});
});
test('later test still runs',()=>writeFile(${JSON.stringify(marker)},'ran\\n'));
`);

    const result=await runNode([runnerPath,cleanupFile],{cwd:root});
    assert.equal(result.code,1);
    assert.match(result.stderr,/intentional cleanup failure/u);
    assert.match(result.stdout,/later test still runs/u);
    assert.equal(await readFile(marker,'utf8'),'ran\n');
});

test('parent watchdog rejects synchronous cleanup beyond the cleanup timeout',async t=>{
    const root=await temporaryRunnerRoot(t);
    const cleanupFile=path.join(root,'sync-cleanup-overrun.test.mjs');
    const marker=path.join(root,'after-sync-cleanup-timeout.txt');
    await writeFile(cleanupFile,`import {writeFile} from 'node:fs/promises';
import test from 'arcane-os/testing';
test('synchronous cleanup owner',t=>{
    t.after(()=>{
        const deadline=Date.now()+5_100;
        while(Date.now()<deadline){}
    });
});
test('must not run after cleanup timeout',()=>writeFile(${JSON.stringify(marker)},'ran\\n'));
`);

    const result=await runNode([runnerPath,cleanupFile],{cwd:root,timeout:8_000});
    assert.equal(result.timedOut,false,result.stderr);
    assert.equal(result.code,1);
    assert.match(result.stderr,/WATCHDOG cleanup .*5000 ms/u);
    await assert.rejects(readFile(marker,'utf8'),error=>error?.code==='ENOENT');
});

test('coordinator drains a spawned descendant before starting the next file',async t=>{
    const root=await temporaryRunnerRoot(t);
    const ownerFile=path.join(root,'01-descendant-owner.test.mjs');
    const verifierFile=path.join(root,'02-descendant-verifier.test.mjs');
    const pidFile=path.join(root,'descendant.pid');
    const marker=path.join(root,'descendant-drained.txt');
    await Promise.all([
        writeFile(ownerFile,`import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import test from 'arcane-os/testing';
test('spawned descendant owner',async()=>{
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1_000)'],{
        shell:false,
        windowsHide:true,
        stdio:'ignore'
    });
    await writeFile(${JSON.stringify(pidFile)},String(child.pid));
});
`),
        writeFile(verifierFile,`import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import test from 'arcane-os/testing';
function alive(pid){
    try{process.kill(pid,0);return true;}
    catch(error){if(error?.code==='ESRCH')return false;throw error;}
}
test('spawned descendant was drained',async()=>{
    const pid=Number(await readFile(${JSON.stringify(pidFile)},'utf8'));
    for(let attempt=0;attempt<50&&alive(pid);attempt+=1){
        await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(alive(pid),false,\`descendant \${String(pid)} survived the file boundary\`);
    await writeFile(${JSON.stringify(marker)},'drained\\n');
});
`)
    ]);

    const result=await runNode([runnerPath,ownerFile,verifierFile],{cwd:root,timeout:8_000});
    assert.equal(result.code,0,result.stderr);
    assert.equal(await readFile(marker,'utf8'),'drained\n');
});

async function sourceFiles(root){
    const files=[];
    async function visit(directory){
        for(const entry of await readdir(directory,{withFileTypes:true})){
            const candidate=path.join(directory,entry.name);
            if(entry.isDirectory()){
                await visit(candidate);
            }else if(entry.isFile()){
                files.push(candidate);
            }
        }
    }
    await visit(root);
    return files;
}

test('active SDK and generated test surfaces contain no legacy Node test runner',async()=>{
    const activeRoots=['bin','src','test','.github'].map(relative=>path.join(repositoryRoot,relative));
    const files=(await Promise.all(activeRoots.map(sourceFiles))).flat();
    files.push(path.join(repositoryRoot,'package.json'));
    const forbiddenModule=['node',':test'].join('');
    const forbiddenCommand=['node',' --test'].join('');
    for(const file of files){
        const source=await readFile(file,'utf8');
        assert.equal(source.includes(forbiddenModule),false,file);
        assert.equal(source.includes(forbiddenCommand),false,file);
    }

    const suiteFiles=(await readdir(path.join(repositoryRoot,'test')))
        .filter(file=>file.endsWith('.test.mjs'));
    for(const file of suiteFiles){
        const source=await readFile(path.join(repositoryRoot,'test',file),'utf8');
        assert.match(source,/from '\.\.\/src\/testing\.mjs';/u,file);
    }
});

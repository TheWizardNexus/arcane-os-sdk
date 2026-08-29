import {lstat,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ArcaneError,ERROR_CODES,throwIfAborted} from './errors.mjs';
import {runProcess} from './process.mjs';

const TEST_RUNNER_PATH=fileURLToPath(new URL('../bin/arcane-test.mjs',import.meta.url));

function normalizedTestOutput(value){
    return typeof value==='string'?value:'';
}

function captureFailedTest(testFile,result,workspaceRoot){
    return {
        testFile:path.relative(workspaceRoot,testFile).replaceAll('\\','/'),
        exitCode:result.code,
        signal:result.signal,
        stdout:normalizedTestOutput(result.stdout),
        stderr:normalizedTestOutput(result.stderr)
    };
}

function failedTestMessage(failures){
    const summary=`${String(failures.length)} isolated test file${failures.length===1?'':'s'} failed.`;
    let diagnostics='';
    for(const failure of failures){
        if(failure.stdout){
            diagnostics+=`\n\n${failure.testFile} stdout:\n${failure.stdout}`;
        }
        if(failure.stderr){
            diagnostics+=`\n\n${failure.testFile} stderr:\n${failure.stderr}`;
        }
    }
    return `${summary}${diagnostics}`;
}

function samePath(left,right){
    const a=path.resolve(left);
    const b=path.resolve(right);
    return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
}

function pathInside(root,candidate){
    const relative=path.relative(root,candidate);
    return relative===''||(!relative.startsWith(`..${path.sep}`)
        &&relative!=='..'&&!path.isAbsolute(relative));
}

async function collectTests(root,testCodeRoot,files,signal){
    throwIfAborted(signal);
    const before=await lstat(root);
    if(before.isSymbolicLink()||!before.isDirectory()){
        throw new ArcaneError(
            ERROR_CODES.operationFailed,
            `Selected application test path is not a real directory: ${root}.`
        );
    }
    const canonical=await realpath(root);
    if(!samePath(root,canonical)||!pathInside(testCodeRoot,canonical)){
        throw new ArcaneError(
            ERROR_CODES.operationFailed,
            `Selected application test directory leaves its test-code directory: ${root}.`
        );
    }
    throwIfAborted(signal);
    const entries=await readdir(root,{withFileTypes:true});
    for(const entry of entries.sort((left,right)=>left.name.localeCompare(right.name,'en'))){
        throwIfAborted(signal);
        const absolute=path.join(root,entry.name);
        const info=await lstat(absolute);
        if(info.isSymbolicLink()){
            throw new ArcaneError(
                ERROR_CODES.operationFailed,
                `Selected application tests refuse symbolic links: ${absolute}.`
            );
        }
        if(info.isDirectory()){
            await collectTests(absolute,testCodeRoot,files,signal);
        }else if(info.isFile()&&/\.test\.(?:mjs|cjs|js)$/u.test(entry.name)){
            const canonicalFile=await realpath(absolute);
            if(!samePath(absolute,canonicalFile)||!pathInside(testCodeRoot,canonicalFile)){
                throw new ArcaneError(
                    ERROR_CODES.operationFailed,
                    `Selected application test file leaves its test-code directory: ${absolute}.`
                );
            }
            files.add(canonicalFile);
        }else if(!info.isFile()){
            throw new ArcaneError(
                ERROR_CODES.operationFailed,
                `Selected application test path is not a regular file or directory: ${absolute}.`
            );
        }
    }
    throwIfAborted(signal);
}

async function collectOptionalTests(root,applicationRoot,files,signal){
    throwIfAborted(signal);
    try{await lstat(root);}
    catch(error){
        if(error?.code==='ENOENT')return;
        throw error;
    }
    const canonicalApplicationRoot=await realpath(applicationRoot);
    const canonicalTestRoot=await realpath(root);
    if(!samePath(applicationRoot,canonicalApplicationRoot)
        ||!samePath(root,canonicalTestRoot)
        ||!pathInside(canonicalApplicationRoot,canonicalTestRoot)){
        throw new ArcaneError(
            ERROR_CODES.operationFailed,
            `Selected application test-code directory leaves its application: ${root}.`
        );
    }
    await collectTests(canonicalTestRoot,canonicalTestRoot,files,signal);
}

async function selectedTestFiles({workspaceRoot,workspaceMode,appRoot,signal}){
    const files=new Set();
    if(workspaceMode==='external'){
        await collectOptionalTests(path.join(workspaceRoot,'test'),workspaceRoot,files,signal);
    }
    if(appRoot)await collectOptionalTests(path.join(appRoot,'test'),appRoot,files,signal);
    return [...files].sort();
}

export async function runApplicationTests({
    workspaceRoot,
    workspaceMode='packager',
    appId,
    appRoot,
    signal,
    onEvent
}={}){
    throwIfAborted(signal);
    const workspace={workspaceRoot,workspaceMode,appId,appRoot};
    const selection={workspaceRoot,workspaceMode,appRoot,signal};
    const testFiles=await selectedTestFiles(selection);
    if(testFiles.length===0){
        await onEvent?.({
            type:'test.skipped',
            message:'No JavaScript test files were found.',
            data:{workspaceRoot,appId}
        });
        throwIfAborted(signal);
        return {
            ...workspace,
            passed:true,
            skipped:true,
            testFiles:[],
            output:''
        };
    }
    const outputs=[];
    const failures=[];
    for(const testFile of testFiles){
        throwIfAborted(signal);
        const result=await runProcess(
            process.execPath,
            [TEST_RUNNER_PATH,testFile],
            {
                cwd:workspaceRoot,
                signal,
                onEvent,
                allowNonzero:true
            }
        );
        if(result.code===0){
            if(result.stdout)outputs.push(result.stdout);
        }else if(result.code===1){
            failures.push(captureFailedTest(testFile,result,workspaceRoot));
        }else{
            throw new ArcaneError(
                ERROR_CODES.operationFailed,
                `The isolated test runner exited with code ${String(result.code)} for ${path.basename(testFile)}.`,
                {details:{testFile,result}}
            );
        }
    }
    if(failures.length>0){
        throw new ArcaneError(
            ERROR_CODES.operationFailed,
            failedTestMessage(failures),
            {
                details:{
                    testFiles:failures.map(failure=>failure.testFile),
                    failures
                }
            }
        );
    }
    throwIfAborted(signal);
    return {
        ...workspace,
        passed:true,
        skipped:false,
        testFiles:testFiles.map(file=>path.relative(workspaceRoot,file).replaceAll('\\','/')),
        output:outputs.join('')
    };
}

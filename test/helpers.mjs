import {execFile} from 'node:child_process';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const cliPath=path.join(repositoryRoot,'bin','arcane.mjs');

// These fixtures exercise routing and native TLS option delegation, not a TLS
// handshake, protocol negotiation or browser trust. No certificate or private key is stored.
export function useSyntheticTls(context) {
    const createServer = https.createServer;
    const createSecureServer = http2.createSecureServer;
    const options = [];
    function createSyntheticTlsServer(tlsOptions, requestHandler) {
        options.push(tlsOptions);
        return http.createServer(
            function syntheticTlsRequest(request, response) {
                request.socket.encrypted = true;
                return requestHandler(request, response);
            }
        );
    }
    https.createServer = createSyntheticTlsServer;
    http2.createSecureServer = createSyntheticTlsServer;
    context.after(
        function restoreTlsConstructors() {
            https.createServer = createServer;
            http2.createSecureServer = createSecureServer;
        }
    );
    return {options};
}

export async function writeSyntheticTlsFiles(workspaceRoot, {
    certPath = '.arcane/dev/server-cert.pem',
    keyPath = '.arcane/dev/server-key.pem'
} = {}) {
    const certificatePath = path.resolve(workspaceRoot, certPath);
    const privateKeyPath = path.resolve(workspaceRoot, keyPath);
    await Promise.all(
        [
            mkdir(path.dirname(certificatePath), {recursive: true}),
            mkdir(path.dirname(privateKeyPath), {recursive: true})
        ]
    );
    await Promise.all(
        [
            writeFile(certificatePath, 'Synthetic certificate input; not a certificate.'),
            writeFile(privateKeyPath, 'Synthetic key input; not a private key.')
        ]
    );
    return {certPath: certificatePath, keyPath: privateKeyPath};
}

export function fetchSyntheticTls(input, options) {
    const url = new URL(input);
    url.protocol = 'http:';
    return fetch(url, options);
}

export async function temporaryDirectory(t,{prefix='arcane-sdk-test-'}={}){
    const directory=await mkdtemp(path.join(tmpdir(),prefix));
    t.after(()=>rm(directory,{recursive:true,force:true}));
    return directory;
}

export function runCommand(command,arguments_,{
    cwd=repositoryRoot,
    env={},
    timeout=30_000
}={}){
    return new Promise(resolve=>{
        execFile(
            command,
            arguments_,
            {
                cwd,
                env:{...process.env,...env},
                encoding:'utf8',
                maxBuffer:16*1024*1024,
                timeout,
                windowsHide:true
            },
            (error,stdout,stderr)=>resolve({
                code:error?.code==='ETIMEDOUT'?null:error?.code??0,
                signal:error?.signal??null,
                timedOut:error?.code==='ETIMEDOUT',
                stdout,
                stderr,
                error
            })
        );
    });
}

export function runNode(arguments_,options){
    return runCommand(process.execPath,arguments_,options);
}

export function runCli(arguments_,options){
    return runNode([cliPath,...arguments_],options);
}

export function parseNdjson(source){
    return source.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
}

export function parseLastJsonLine(source){
    for(const line of source.split(/\r?\n/).reverse()){
        if(!line.trim())continue;
        try{return JSON.parse(line);}
        catch{}
    }
    throw new Error(`Command output did not end with a JSON document: ${source.slice(-1000)}`);
}

import {spawn} from 'node:child_process';
import path from 'node:path';
import {TextDecoder} from 'node:util';
import {ArcaneError,ERROR_CODES} from './errors.mjs';

export const RESEND_CREDENTIAL_TARGET_PREFIX='ArcaneOSSDK/mail/resend/';

const CREDENTIAL_STORE='windows-credential-manager';
const MAX_PROFILE_LENGTH=64;
const MAX_CREDENTIAL_BYTES=2_560;
const MAX_HELPER_INPUT_BYTES=8_192;
const MAX_HELPER_OUTPUT_BYTES=8_192;
const DEFAULT_HELPER_TIMEOUT_MS=15_000;
const MAX_HELPER_TIMEOUT_MS=60_000;
const PROFILE_PATTERN=/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const SECRET_PATTERN=/^[\x21-\x7e]+$/u;
const BASE64_PATTERN=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const WINDOWS_CREDENTIAL_HELPER=String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$VerbosePreference='SilentlyContinue'
$WarningPreference='SilentlyContinue'
Set-StrictMode -Version 3.0

try {
    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class ArcaneResendCredentialNative
{
    private const UInt32 GenericCredential = 1;
    private const UInt32 PersistLocalMachine = 2;
    private const Int32 NotFound = 1168;
    private const Int32 MaximumBlobBytes = 2560;

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeFileTime
    {
        public UInt32 Low;
        public UInt32 High;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NativeCredential
    {
        public UInt32 Flags;
        public UInt32 Type;
        [MarshalAs(UnmanagedType.LPWStr)] public String TargetName;
        [MarshalAs(UnmanagedType.LPWStr)] public String Comment;
        public NativeFileTime LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        [MarshalAs(UnmanagedType.LPWStr)] public String TargetAlias;
        [MarshalAs(UnmanagedType.LPWStr)] public String UserName;
    }

    [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode,
        ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern Boolean CredWrite(ref NativeCredential credential, UInt32 flags);

    [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode,
        ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern Boolean CredRead(String target, UInt32 type, UInt32 flags,
        out IntPtr credential);

    [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode,
        ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern Boolean CredDelete(String target, UInt32 type, UInt32 flags);

    [DllImport("Advapi32.dll", EntryPoint = "CredFree", ExactSpelling = true,
        SetLastError = false)]
    private static extern void CredFree(IntPtr credential);

    public static void Write(String target, Byte[] value)
    {
        if (value == null || value.Length == 0 || value.Length > MaximumBlobBytes)
            throw new ArgumentException("Invalid credential value.");

        GCHandle pinned = default(GCHandle);
        try
        {
            pinned = GCHandle.Alloc(value, GCHandleType.Pinned);
            NativeCredential credential = new NativeCredential();
            credential.Type = GenericCredential;
            credential.TargetName = target;
            credential.CredentialBlobSize = checked((UInt32)value.Length);
            credential.CredentialBlob = pinned.AddrOfPinnedObject();
            credential.Persist = PersistLocalMachine;
            credential.UserName = "Arcane OS SDK";
            if (!CredWrite(ref credential, 0))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            Array.Clear(value, 0, value.Length);
            if (pinned.IsAllocated) pinned.Free();
        }
    }

    public static Byte[] Read(String target)
    {
        IntPtr pointer;
        if (!CredRead(target, GenericCredential, 0, out pointer))
        {
            Int32 error = Marshal.GetLastWin32Error();
            if (error == NotFound) return null;
            throw new Win32Exception(error);
        }

        try
        {
            NativeCredential credential =
                (NativeCredential)Marshal.PtrToStructure(pointer, typeof(NativeCredential));
            if (credential.CredentialBlobSize == 0 ||
                credential.CredentialBlobSize > MaximumBlobBytes)
                throw new InvalidOperationException("Invalid credential size.");
            Byte[] value = new Byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, value, 0, value.Length);
            return value;
        }
        finally
        {
            CredFree(pointer);
        }
    }

    public static Boolean Exists(String target)
    {
        IntPtr pointer;
        if (!CredRead(target, GenericCredential, 0, out pointer))
        {
            Int32 error = Marshal.GetLastWin32Error();
            if (error == NotFound) return false;
            throw new Win32Exception(error);
        }
        CredFree(pointer);
        return true;
    }

    public static Boolean Delete(String target)
    {
        if (CredDelete(target, GenericCredential, 0)) return true;
        Int32 error = Marshal.GetLastWin32Error();
        if (error == NotFound) return false;
        throw new Win32Exception(error);
    }
}
'@

    $inputText=[Console]::In.ReadToEnd()
    if ([Text.Encoding]::UTF8.GetByteCount($inputText) -gt 8192) {
        throw 'Invalid helper input.'
    }
    $request=$inputText | ConvertFrom-Json
    $operation=[String]$request.operation
    $target=[String]$request.target
    if ($target -notmatch '^ArcaneOSSDK/mail/resend/[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$') {
        throw 'Invalid credential target.'
    }

    switch ($operation) {
        'set' {
            $credentialBytes=$null
            try {
                $encoded=[String]$request.secret
                if ([String]::IsNullOrEmpty($encoded)) { throw 'Invalid credential value.' }
                $credentialBytes=[Convert]::FromBase64String($encoded)
                if ($credentialBytes.Length -eq 0 -or $credentialBytes.Length -gt 2560) {
                    throw 'Invalid credential value.'
                }
                [ArcaneResendCredentialNative]::Write($target,$credentialBytes)
                [Console]::Out.Write('{"ok":true,"configured":true}')
            }
            finally {
                if ($null -ne $credentialBytes) {
                    [Array]::Clear($credentialBytes,0,$credentialBytes.Length)
                }
            }
            break
        }
        'read' {
            $credentialBytes=$null
            try {
                $credentialBytes=[ArcaneResendCredentialNative]::Read($target)
                if ($null -eq $credentialBytes) {
                    [Console]::Out.Write('{"ok":true,"found":false}')
                }
                else {
                    $encoded=[Convert]::ToBase64String($credentialBytes)
                    $response=@{ok=$true;found=$true;secret=$encoded} | ConvertTo-Json -Compress
                    [Console]::Out.Write($response)
                }
            }
            finally {
                if ($null -ne $credentialBytes) {
                    [Array]::Clear($credentialBytes,0,$credentialBytes.Length)
                }
            }
            break
        }
        'status' {
            $configured=[ArcaneResendCredentialNative]::Exists($target)
            $response=@{ok=$true;configured=$configured} | ConvertTo-Json -Compress
            [Console]::Out.Write($response)
            break
        }
        'delete' {
            $deleted=[ArcaneResendCredentialNative]::Delete($target)
            $response=@{ok=$true;deleted=$deleted;configured=$false} | ConvertTo-Json -Compress
            [Console]::Out.Write($response)
            break
        }
        default { throw 'Invalid credential operation.' }
    }
}
catch {
    [Console]::Error.Write('ARCANE_CREDENTIAL_HELPER_FAILED')
    [Environment]::Exit(1)
}
`;

const WINDOWS_CREDENTIAL_HELPER_COMMAND=Buffer.from(
    WINDOWS_CREDENTIAL_HELPER,
    'utf16le'
).toString('base64');

function usageError(message){
    return new ArcaneError(ERROR_CODES.usage,message);
}

function unavailableError(){
    return new ArcaneError(
        ERROR_CODES.targetUnavailable,
        'Resend credential storage requires Windows Credential Manager.'
    );
}

function operationError(){
    return new ArcaneError(
        ERROR_CODES.operationFailed,
        'Windows Credential Manager could not complete the Resend credential operation.'
    );
}

function cancellationError(){
    return new ArcaneError(
        ERROR_CODES.cancelled,
        'The Resend credential operation was cancelled.',
        {exitCode:130}
    );
}

function assertNotAborted(signal){
    if(signal?.aborted)throw cancellationError();
}

export function validateMailCredentialProfile(profile){
    if(typeof profile!=='string'||profile.length>MAX_PROFILE_LENGTH
        ||!PROFILE_PATTERN.test(profile)){
        throw usageError(
            'A credential profile must be 1-64 lowercase letters, digits, dots, underscores, or hyphens, and must begin and end with a letter or digit.'
        );
    }
    return profile;
}

export function mailCredentialTarget(profile){
    return `${RESEND_CREDENTIAL_TARGET_PREFIX}${validateMailCredentialProfile(profile)}`;
}

function validateSecret(secret){
    if(typeof secret!=='string'||!SECRET_PATTERN.test(secret)
        ||Buffer.byteLength(secret,'utf8')>MAX_CREDENTIAL_BYTES){
        throw usageError(
            'A Resend API key must be a nonempty printable ASCII string no larger than 2,560 bytes.'
        );
    }
    return secret;
}

function validatePlatform(platform){
    if(platform!=='win32')throw unavailableError();
}

function validateTimeout(timeoutMs){
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>MAX_HELPER_TIMEOUT_MS){
        throw usageError(
            `Credential helper timeout must be an integer from 1 through ${String(MAX_HELPER_TIMEOUT_MS)} milliseconds.`
        );
    }
    return timeoutMs;
}

function powershellExecutable(systemRoot){
    if(typeof systemRoot!=='string'||systemRoot.length===0
        ||systemRoot.includes('\0')||!path.win32.isAbsolute(systemRoot)){
        throw unavailableError();
    }
    return path.win32.join(
        systemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
    );
}

function helperArguments(){
    return [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        WINDOWS_CREDENTIAL_HELPER_COMMAND
    ];
}

function helperEnvironment(systemRoot,temporaryDirectory){
    if(typeof temporaryDirectory!=='string'||temporaryDirectory.length===0
        ||temporaryDirectory.includes('\0')||!path.win32.isAbsolute(temporaryDirectory)){
        throw unavailableError();
    }
    return {
        SystemRoot:systemRoot,
        WINDIR:systemRoot,
        TEMP:temporaryDirectory,
        TMP:temporaryDirectory
    };
}

function serializeRequest(request){
    const value=JSON.stringify(request);
    if(Buffer.byteLength(value,'utf8')>MAX_HELPER_INPUT_BYTES){
        throw usageError('The Resend credential request is too large.');
    }
    return value;
}

function parseResponse(buffer){
    let responseText='';
    try{
        responseText=buffer.toString('utf8');
        const response=JSON.parse(responseText);
        if(response===null||typeof response!=='object'||Array.isArray(response)
            ||response.ok!==true){
            throw operationError();
        }
        return response;
    }catch{
        throw operationError();
    }finally{
        responseText='';
        buffer.fill(0);
    }
}

function runCredentialProcess({
    executable,
    args,
    spawnOptions,
    stdin,
    spawnImpl=spawn,
    signal,
    timeoutMs
}){
    if(typeof spawnImpl!=='function')throw usageError('spawnImpl must be a function.');
    let input=stdin;
    return new Promise(function executeCredentialHelper(resolve,reject){
        let child;
        let settled=false;
        let outputBytes=0;
        let errorBytes=0;
        let outputChunks=[];
        let timer=null;

        function wipeOutput(){
            for(const chunk of outputChunks)chunk.fill(0);
            outputChunks=[];
        }

        function removeListeners(){
            clearTimeout(timer);
            signal?.removeEventListener('abort',onAbort);
            child?.removeListener('error',onChildError);
            child?.removeListener('close',onClose);
            child?.stdin?.removeListener('error',onStdinError);
            child?.stdout?.removeListener('data',onStdout);
            child?.stderr?.removeListener('data',onStderr);
        }

        function finishError(error){
            if(settled)return;
            settled=true;
            removeListeners();
            wipeOutput();
            input='';
            reject(error);
        }

        function terminate(error){
            try{
                child?.kill();
            }catch{
                // The stable credential error below intentionally omits process details.
            }
            finishError(error);
        }

        function onAbort(){
            terminate(cancellationError());
        }

        function onTimeout(){
            terminate(operationError());
        }

        function onChildError(){
            finishError(operationError());
        }

        function onStdinError(){
            terminate(operationError());
        }

        function onStdout(chunk){
            const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
            outputBytes+=value.length;
            if(outputBytes>MAX_HELPER_OUTPUT_BYTES){
                value.fill(0);
                terminate(operationError());
                return;
            }
            outputChunks.push(value);
        }

        function onStderr(chunk){
            errorBytes+=Buffer.byteLength(chunk);
            if(errorBytes>MAX_HELPER_OUTPUT_BYTES)terminate(operationError());
        }

        function onClose(code){
            if(settled)return;
            if(code!==0){
                finishError(operationError());
                return;
            }
            const output=Buffer.concat(outputChunks,outputBytes);
            wipeOutput();
            settled=true;
            removeListeners();
            input='';
            resolve(output);
        }

        try{
            child=spawnImpl(executable,args,spawnOptions);
            if(!child?.stdin||!child?.stdout||!child?.stderr){
                throw operationError();
            }
            child.once('error',onChildError);
            child.once('close',onClose);
            child.stdin.once('error',onStdinError);
            child.stdout.on('data',onStdout);
            child.stderr.on('data',onStderr);
            signal?.addEventListener('abort',onAbort,{once:true});
            timer=setTimeout(onTimeout,timeoutMs);
            child.stdin.end(input,'utf8');
            input='';
        }catch{
            terminate(operationError());
        }
    });
}

async function runWindowsCredentialHelper(request,{
    platform=process.platform,
    systemRoot=process.env.SystemRoot??process.env.WINDIR,
    temporaryDirectory=process.env.TEMP??process.env.TMP,
    spawnImpl=spawn,
    runner=runCredentialProcess,
    signal,
    timeoutMs=DEFAULT_HELPER_TIMEOUT_MS
}={}){
    validatePlatform(platform);
    assertNotAborted(signal);
    if(typeof runner!=='function')throw usageError('runner must be a function.');
    const executable=powershellExecutable(systemRoot);
    const args=helperArguments();
    const boundedTimeout=validateTimeout(timeoutMs);
    let requestText=serializeRequest(request);
    const invocation={
        executable,
        args,
        spawnOptions:{
            cwd:systemRoot,
            env:helperEnvironment(systemRoot,temporaryDirectory),
            shell:false,
            windowsHide:true,
            stdio:['pipe','pipe','pipe']
        },
        stdin:requestText,
        spawnImpl,
        signal,
        timeoutMs:boundedTimeout
    };
    let output;
    try{
        output=await runner(invocation);
    }catch(error){
        if(signal?.aborted||error?.code===ERROR_CODES.cancelled
            ||error?.name==='AbortError'||error?.code==='ABORT_ERR'){
            throw cancellationError();
        }
        throw operationError();
    }finally{
        invocation.stdin='';
        requestText='';
    }
    if(typeof output==='string')output=Buffer.from(output,'utf8');
    if(!Buffer.isBuffer(output))throw operationError();
    if(output.length>MAX_HELPER_OUTPUT_BYTES){
        output.fill(0);
        throw operationError();
    }
    return parseResponse(output);
}

async function invokeCredentialHelper(request,options){
    try{
        return await runWindowsCredentialHelper(request,options);
    }catch(error){
        if(error?.code===ERROR_CODES.cancelled)throw cancellationError();
        if(error?.code===ERROR_CODES.targetUnavailable)throw unavailableError();
        if(error?.code===ERROR_CODES.usage)throw error;
        throw operationError();
    }
}

function credentialStatus(profile,exists){
    return {
        profile,
        provider:'resend',
        storage:CREDENTIAL_STORE,
        exists
    };
}

function validateOptions(options){
    if(options===null||typeof options!=='object'||Array.isArray(options)){
        throw usageError('Mail credential options must be an object.');
    }
    return options;
}

function helperOptions(options){
    return {
        platform:options.platform,
        systemRoot:options.systemRoot,
        temporaryDirectory:options.temporaryDirectory,
        spawnImpl:options.spawnImpl,
        runner:options.runner,
        signal:options.signal,
        timeoutMs:options.timeoutMs
    };
}

export async function setMailCredential(options={}){
    validateOptions(options);
    const {profile,secret}=options;
    const validatedProfile=validateMailCredentialProfile(profile);
    validateSecret(secret);
    const target=mailCredentialTarget(validatedProfile);
    const secretBytes=Buffer.from(secret,'utf8');
    let encoded='';
    const request={operation:'set',target,secret:''};
    try{
        encoded=secretBytes.toString('base64');
        request.secret=encoded;
        const response=await invokeCredentialHelper(
            request,
            helperOptions(options)
        );
        if(response.configured!==true)throw operationError();
        return credentialStatus(validatedProfile,true);
    }finally{
        request.secret='';
        encoded='';
        secretBytes.fill(0);
    }
}

function decodeSecret(value){
    if(typeof value!=='string'||value.length===0||value.length%4!==0
        ||!BASE64_PATTERN.test(value)){
        throw operationError();
    }
    const bytes=Buffer.from(value,'base64');
    try{
        if(bytes.length===0||bytes.length>MAX_CREDENTIAL_BYTES
            ||bytes.toString('base64')!==value){
            throw operationError();
        }
        const decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
        validateSecret(decoded);
        return decoded;
    }catch{
        throw operationError();
    }finally{
        bytes.fill(0);
    }
}

export async function readMailCredential(options={}){
    validateOptions(options);
    const validatedProfile=validateMailCredentialProfile(options.profile);
    const target=mailCredentialTarget(validatedProfile);
    const response=await invokeCredentialHelper(
        {operation:'read',target},
        helperOptions(options)
    );
    if(response.found===false)return null;
    if(response.found!==true)throw operationError();
    let encoded=response.secret;
    try{
        return decodeSecret(encoded);
    }finally{
        response.secret=null;
        encoded='';
    }
}

export async function getMailCredentialStatus(options={}){
    validateOptions(options);
    const validatedProfile=validateMailCredentialProfile(options.profile);
    const target=mailCredentialTarget(validatedProfile);
    const response=await invokeCredentialHelper(
        {operation:'status',target},
        helperOptions(options)
    );
    if(typeof response.configured!=='boolean')throw operationError();
    return credentialStatus(validatedProfile,response.configured);
}

export async function deleteMailCredential(options={}){
    validateOptions(options);
    const validatedProfile=validateMailCredentialProfile(options.profile);
    const target=mailCredentialTarget(validatedProfile);
    const response=await invokeCredentialHelper(
        {operation:'delete',target},
        helperOptions(options)
    );
    if(typeof response.deleted!=='boolean'||response.configured!==false){
        throw operationError();
    }
    return credentialStatus(validatedProfile,false);
}

import Is from 'strong-type';
import {stat} from 'node:fs/promises';
import path from 'node:path';
import {throwIfAborted} from './errors.mjs';

const is=new Is(false);
let installedDirectory=null;

// Git for Windows records its chosen location for third-party integrations.
// Read both installation scopes/views in one owned Windows process. No guessed
// installation paths or changes to the registry/environment are needed.
const READ_INSTALLATIONS=String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$installations = [System.Collections.Generic.List[string]]::new()
$views = @([Microsoft.Win32.RegistryView]::Registry32)
if ([Environment]::Is64BitOperatingSystem) {
    $views = @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)
}
foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($view in $views) {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
        try {
            $key = $base.OpenSubKey('Software\GitForWindows')
            if ($null -ne $key) {
                try {
                    $location = $key.GetValue('InstallPath')
                    if ($location -is [string] -and $location.Length -gt 0 -and -not $installations.Contains($location)) {
                        $installations.Add($location)
                    }
                } finally { $key.Dispose() }
            }
        } finally { $base.Dispose() }
    }
}
ConvertTo-Json -InputObject @($installations.ToArray()) -Compress
`;

function environmentKey(environment,name){
    return Object.keys(environment).sort().find(function matchingKey(key){
        return key.toLowerCase()===name;
    });
}

export function appendWindowsGitDirectory(environment,directory){
    const keys=Object.keys(environment).filter(function pathKey(key){
        return key.toLowerCase()==='path';
    }).sort();
    const selectedKey=keys[0]??'Path';
    // Node chooses the first case-insensitive key before omitting undefined.
    // libuv uses the parent's PATH if the child has none; null becomes 'null'.
    const selected=environment[selectedKey];
    const original=selected===undefined
        ?process.env[environmentKey(process.env,'path')]??'':selected;
    const result={...environment};
    for(const key of keys)delete result[key];
    const originalPath=`${original}`;
    result[selectedKey]=`${originalPath}${originalPath?';':''}"${directory}"`;
    return result;
}

async function installedGitExists(directory){
    try{
        return (await stat(path.win32.join(directory,'git.exe'))).isFile();
    }catch(error){
        if(error.code==='ENOENT'||error.code==='ENOTDIR')return false;
        throw error;
    }
}

export async function windowsGitEnvironment(environment,{run,signal,onEvent}={}){
    throwIfAborted(signal);
    const retained=installedDirectory;
    if(retained){
        const available=await installedGitExists(retained);
        throwIfAborted(signal);
        if(available)return appendWindowsGitDirectory(environment,retained);
        if(installedDirectory===retained)installedDirectory=null;
    }

    const systemRoot=process.env[environmentKey(process.env,'systemroot')];
    if(!systemRoot)return environment;
    const powershell=path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
    const result=await run(powershell,['-NoProfile','-NonInteractive','-Command',READ_INSTALLATIONS],{
        signal,onEvent,emitOutputEvents:false
    });
    throwIfAborted(signal);
    const locations=JSON.parse(result.stdout);
    if(!is.array(locations))throw new TypeError('Git installation discovery did not return a location list.');
    for(const location of locations){
        if(!is.string(location)||!path.win32.isAbsolute(location))continue;
        const directory=path.win32.join(location,'cmd');
        const available=await installedGitExists(directory);
        throwIfAborted(signal);
        if(available){
            // Only successful, still-present discovery is retained. Concurrent
            // first callers own separate lookups and cancellation independently.
            installedDirectory=directory;
            return appendWindowsGitDirectory(environment,directory);
        }
    }
    return environment;
}

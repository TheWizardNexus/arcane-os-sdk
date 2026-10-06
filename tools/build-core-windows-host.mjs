import {copyFile, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runAppControl} from '../browser-runtime/core/app-control.mjs';

/** Compile reusable Windows x64 host assets once; application assembly copies them. */
export async function buildCoreWindowsHost({webViewPackageRoot, seaDirectory, compiler, outputRoot}) {
    const packageRoot = path.resolve(webViewPackageRoot);
    const seaRoot = path.resolve(seaDirectory);
    const parent = path.resolve(outputRoot);
    await mkdir(parent, {recursive: true});
    const directory = await mkdtemp(path.join(parent, 'arcane-windows-host-'));
    const runtime = path.join(directory, 'runtime');
    await mkdir(runtime);
    const executable = path.join(directory, 'Arcane.exe');
    const source = fileURLToPath(new URL('../src/core/hosts/windows/', import.meta.url));
    const managed = path.join(packageRoot, 'lib', 'net462');
    const references = ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll'];
    const copies = [
        ...references.map(function managedLibrary(name) { return [path.join(managed, name), path.join(directory, name)]; }),
        [path.join(packageRoot, 'runtimes', 'win-x64', 'native', 'WebView2Loader.dll'), path.join(directory, 'WebView2Loader.dll')],
        [path.join(packageRoot, 'LICENSE.txt'), path.join(directory, 'WEBVIEW2-LICENSE')],
        [path.join(seaRoot, 'ArcaneCore.exe'), path.join(runtime, 'ArcaneCore.exe')],
        [path.join(seaRoot, 'arcane-core-loader.cjs'), path.join(runtime, 'arcane-core-loader.cjs')],
        [path.join(seaRoot, 'NODE-LICENSE'), path.join(runtime, 'NODE-LICENSE')],
        ...['LICENSE', 'COMMERCIAL-LICENSE.md', 'NOTICE'].map(function sdkLegalFile(name) {
            return [fileURLToPath(new URL(`../${name}`, import.meta.url)), path.join(directory, name)];
        })
    ];
    const argumentsList = [
        '/nologo', '/target:winexe', '/platform:x64', '/langversion:5', '/define:TRACE',
        `/out:${executable}`, `/win32manifest:${path.join(source, 'ArcaneHost.manifest')}`,
        '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll',
        '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll',
        ...references.map(function managedReference(name) { return `/reference:${path.join(managed, name)}`; }),
        path.join(source, 'ArcaneLauncher.cs'), path.join(source, 'ArcaneHost.cs'), path.join(source, 'ArcaneCoreProcess.cs'),
        path.join(source, 'ArcaneFrameTransport.cs'), path.join(source, 'ArcaneAppControl.cs'),
        path.join(source, 'ArcaneWindowControl.cs')
    ];

    // Compiler and copying use separate files. Observe both before reporting a
    // failure, retaining the selected output for its owner's diagnosis.
    const operations = await Promise.allSettled([
        new Promise(function compileHost(resolve, reject) {
            const child = spawn(path.resolve(compiler), argumentsList, {cwd: directory, stdio: 'inherit', windowsHide: true});
            child.once('error', reject);
            child.once('close', function hostCompilerClosed(code, signal) {
                if (code === 0) resolve();
                else reject(new Error(`Windows host compilation ended with code ${code} and signal ${signal}. Output retained at ${directory}.`));
            });
        }),
        ...copies.map(function copyHostAsset([from, to]) { return copyFile(from, to); }),
        writeFile(path.join(directory, 'arcane-app-control.js'), runAppControl.toString(), {flag: 'wx'}),
        writeFile(path.join(directory, 'Arcane.exe.config'), [
            '<?xml version="1.0" encoding="utf-8"?>',
            '<configuration>',
            '  <startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.6.2" /></startup>',
            '</configuration>', ''
        ].join('\n'), {flag: 'wx'})
    ]);
    const failures = operations.filter(function failed(result) { return result.status === 'rejected'; })
        .map(function failure(result) { return result.reason; });
    if (failures.length) throw new AggregateError(failures, `Windows host assembly failed. Output retained at ${directory}.`);
    return {directory, executable, runtime};
}

if (import.meta.main) {
    const [webViewPackageRoot, seaDirectory, compiler, outputRoot] = process.argv.slice(2);
    if (!webViewPackageRoot || !seaDirectory || !compiler || !outputRoot) {
        throw new Error('Usage: node tools/build-core-windows-host.mjs <extracted-WebView2-package> <Core-SEA-directory> <csc.exe> <output-directory>');
    }
    console.log(await buildCoreWindowsHost({webViewPackageRoot, seaDirectory, compiler, outputRoot}));
}

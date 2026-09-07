import Is from 'strong-type';
import {Server} from 'node-http-server';
import {constants as FS_CONSTANTS} from 'node:fs';
import {lstat,open,readFile,readdir,realpath} from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {resolveWorkspace} from './workspace.mjs';
import {createEventQueue} from './event-queue.mjs';
import {
    applyPwaEntryReferences,inspectImportMapHtml,MANAGED_IMPORT_MAP_ATTRIBUTE,
    readWorkspaceAssetVersion,rewriteAssetReferences,versionAssetUrl
} from './import-map.mjs';
import {createPwaArtifacts,selectPwaFiles} from './pwa.mjs';

const is = new Is(false);

const MIME_TYPES=new Map([
    ['.css','text/css; charset=utf-8'],
    ['.gif','image/gif'],
    ['.html','text/html; charset=utf-8'],
    ['.htm','text/html; charset=utf-8'],
    ['.ico','image/x-icon'],
    ['.jpeg','image/jpeg'],
    ['.jpg','image/jpeg'],
    ['.js','text/javascript; charset=utf-8'],
    ['.json','application/json; charset=utf-8'],
    ['.mjs','text/javascript; charset=utf-8'],
    ['.png','image/png'],
    ['.svg','image/svg+xml; charset=utf-8'],
    ['.txt','text/plain; charset=utf-8'],
    ['.wasm','application/wasm'],
    ['.webmanifest','application/manifest+json; charset=utf-8'],
    ['.webp','image/webp'],
    ['.woff','font/woff'],
    ['.woff2','font/woff2']
]);
const READ_ONLY_NO_FOLLOW=FS_CONSTANTS.O_RDONLY|(FS_CONSTANTS.O_NOFOLLOW??0);
const PRIVATE_SOURCE_SEGMENTS=new Set([
    'arcane-app.json','arcane-package.json','test','tests','scripts','node_modules','dist','local'
]);
const SDK_RUNTIME_SOURCE_PROTOCOL='arcane-sdk-runtime-source/1';
const SDK_RUNTIME_SOURCE_ARCANE_ROOTS=new Set([
    'components','css','entities','img','modules','security'
]);
const SDK_INSTALLED_ARCANE_ROOTS=new Set([
    ...SDK_RUNTIME_SOURCE_ARCANE_ROOTS,
    'dependencies',
    'sdk'
]);
const SDK_RUNTIME_SOURCE_PRIVATE_SEGMENTS=new Set([
    'node_modules','.git','.hg','.svn','cvs'
]);
const SDK_RUNTIME_SOURCE_PRIVATE_MANIFESTS=new Set([
    'arcane-app.json','arcane-package.json','arcane.lock.json',
    'arcane_app_release.json','arcane_runtime_release.json','arcane_sdk_browser_release.json'
]);

function fail(message,code='ARCANE_OPERATION_FAILED'){
    const error=new Error(message);
    error.code=code;
    throw error;
}

function throwIfAborted(signal){
    if(!signal?.aborted)return;
    const error=signal.reason instanceof Error?signal.reason:new Error('Operation cancelled.');
    error.code=error.code||'ARCANE_CANCELLED';
    throw error;
}

function deny(response,status,message){
    response.removeHeader('Last-Modified');
    response.writeHead(status,{
        'content-type':'text/plain; charset=utf-8'
    });
    response.end(`${message}\n`);
}

function parseRequestTarget(rawUrl){
    const raw=String(rawUrl||'/');
    if(!raw.startsWith('/'))return null;
    const rawPath=raw.split(/[?#]/u,1)[0];
    let decoded;
    try{decoded=decodeURIComponent(rawPath);}
    catch{return null;}
    if(!decoded.startsWith('/')||/[\x00-\x1f\x7f]/u.test(decoded)
        ||/[<>"|?*]/u.test(decoded)||decoded.includes('\\'))return null;
    const segments=decoded.split('/').filter(Boolean);
    if(segments.some(segment=>segment==='.'||segment==='..'||segment.includes(':')
        ||segment.endsWith('.')||segment.endsWith(' ')
        ||/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu
            .test(segment)))return null;
    let parsed;
    try{parsed=new URL(raw,'http://127.0.0.1');}
    catch{return null;}
    return {segments,path:decoded,searchParams:parsed.searchParams};
}

function resolveInside(root,segments){
    const candidate=path.resolve(root,...segments);
    const relative=path.relative(root,candidate);
    if(relative.startsWith('..')||path.isAbsolute(relative))return null;
    return candidate;
}

function inventoryKey(value){
    return process.platform==='win32'?value.toLowerCase():value;
}

function canonicalLocationKey(value){
    return inventoryKey(path.resolve(value));
}

function pathIsWithin(root,candidate){
    const relative=path.relative(root,candidate);
    return relative===''||(!path.isAbsolute(relative)&&relative!=='..'
        &&!relative.startsWith(`..${path.sep}`));
}

function pathsOverlap(left,right){
    return pathIsWithin(left,right)||pathIsWithin(right,left);
}

async function canonicalRealDirectory(requested,label){
    let info;
    try{
        info=await lstat(requested);
    }catch{
        fail(`${label} must be an existing real directory.`,'ARCANE_DEV_RUNTIME_SOURCE_INVALID');
    }
    if(info.isSymbolicLink()||!info.isDirectory()){
        fail(`${label} must be an existing real directory.`,'ARCANE_DEV_RUNTIME_SOURCE_INVALID');
    }
    let canonical;
    try{
        canonical=await realpath(requested);
    }catch{
        fail(`${label} could not be resolved as a real directory.`,'ARCANE_DEV_RUNTIME_SOURCE_INVALID');
    }
    if(canonicalLocationKey(canonical)!==canonicalLocationKey(requested)){
        fail(`${label} must not contain a symlink or reparse-point escape.`,'ARCANE_DEV_RUNTIME_SOURCE_INVALID');
    }
    return canonical;
}

function sdkRuntimeSourcePathAllowed(relative,{arcaneRoots=null}={}){
    if(relative.length===0)return false;
    const normalized=relative.map(function normalizeRuntimeSourceSegment(segment){
        return segment.normalize('NFC').toLowerCase();
    });
    if(normalized.some(function runtimeSourceSegmentIsPrivate(segment){
        return segment.startsWith('.')||SDK_RUNTIME_SOURCE_PRIVATE_SEGMENTS.has(segment)
            ||SDK_RUNTIME_SOURCE_PRIVATE_MANIFESTS.has(segment);
    }))return false;
    return arcaneRoots===null||arcaneRoots.has(normalized[0]);
}

function sdkArcaneSourcePathAllowed(relative){
    return sdkRuntimeSourcePathAllowed(relative,{arcaneRoots:SDK_RUNTIME_SOURCE_ARCANE_ROOTS});
}

function sdkInstalledArcanePathAllowed(relative){
    return sdkRuntimeSourcePathAllowed(relative,{arcaneRoots:SDK_INSTALLED_ARCANE_ROOTS});
}

function sdkDependencySourcePathAllowed(relative){
    return sdkRuntimeSourcePathAllowed(relative);
}

function sdkBrowserSourcePathAllowed(relative){
    return sdkRuntimeSourcePathAllowed(relative);
}

async function emitRuntimeSourceEvent(onEvent,event){
    if(is.function(onEvent))await onEvent(event);
}

async function verifySdkRuntimeSourceRoot(sourceRoot,workspaceRoot,appId,{signal,onEvent}={}){
    throwIfAborted(signal);
    if(!is.string(sourceRoot)||!sourceRoot.trim()){
        fail('sdkRuntimeSourceRoot must name an Arcane SDK directory.',
            'ARCANE_DEV_RUNTIME_SOURCE_INVALID');
    }
    const requestedRoot=path.resolve(sourceRoot);
    await emitRuntimeSourceEvent(onEvent,{
        type:'runtime.source.mount.started',
        appId,
        requestedRoot,
        target:'browser'
    });
    const canonicalRoot=await canonicalRealDirectory(requestedRoot,'SDK runtime source root');
    const canonicalWorkspaceRoot=await realpath(workspaceRoot);
    if(pathsOverlap(canonicalRoot,canonicalWorkspaceRoot)){
        fail('SDK runtime source root must not overlap the application workspace.',
            'ARCANE_DEV_RUNTIME_SOURCE_INVALID');
    }

    const roots=[
        {
            path:'runtime/arcane',
            prefix:['arcane'],
            allow:sdkArcaneSourcePathAllowed
        },
        {
            path:'runtime/strong-type',
            prefix:['arcane','dependencies','strong-type'],
            allow:sdkDependencySourcePathAllowed
        },
        {
            path:'browser-runtime',
            prefix:['arcane','sdk'],
            allow:sdkBrowserSourcePathAllowed
        }
    ];
    const mappings=[];
    for(let index=0;index<roots.length;index+=1){
        throwIfAborted(signal);
        const root=roots[index];
        const requested=path.join(canonicalRoot,...root.path.split('/'));
        const canonical=await canonicalRealDirectory(requested,`SDK runtime source ${root.path}`);
        if(!pathIsWithin(canonicalRoot,canonical)){
            fail(`SDK runtime source ${root.path} must remain inside the SDK root.`,
                'ARCANE_DEV_RUNTIME_SOURCE_INVALID');
        }
        mappings.push({prefix:root.prefix,root:canonical,allow:root.allow});
        await emitRuntimeSourceEvent(onEvent,{
            type:'runtime.source.mount.progress',
            current:index+1,
            total:roots.length,
            path:root.path
        });
    }
    const runtime={
        mode:'sdk-source',
        protocol:SDK_RUNTIME_SOURCE_PROTOCOL,
        mutable:true,
        distributionAuthority:false,
        sourceRoot:canonicalRoot
    };
    await emitRuntimeSourceEvent(onEvent,{
        type:'runtime.source.mount.ready',
        appId,
        canonicalRoot,
        protocol:SDK_RUNTIME_SOURCE_PROTOCOL,
        routeCount:mappings.length
    });
    return {mappings,runtime};
}

function routePrefixKey(prefix){
    return prefix.map(segment=>segment.normalize('NFC').toLowerCase()).join('/');
}

function deterministicMappings(mappings){
    const seen=new Map();
    for(const mapping of mappings){
        const key=routePrefixKey(mapping.prefix);
        const prior=seen.get(key);
        if(prior){
            fail(
                `Development server routes collide after case/NFC normalization: `
                +`/${prior.prefix.join('/')} and /${mapping.prefix.join('/')}.`
            );
        }
        seen.set(key,mapping);
    }
    return [...mappings].sort((left,right)=>{
        if(left.prefix.length!==right.prefix.length)return right.prefix.length-left.prefix.length;
        const leftKey=routePrefixKey(left.prefix);
        const rightKey=routePrefixKey(right.prefix);
        return leftKey<rightKey?-1:leftKey>rightKey?1:0;
    });
}

function createFileWorkLimiter(){
    return async work=>work();
}

async function openSafeFile(root, segments, {readContent = true} = {}) {
    const candidate=resolveInside(root,segments);
    if(!candidate)return null;
    let current=root;
    for(const segment of segments){
        current=path.join(current,segment);
        let info;
        try{info=await lstat(current);}
        catch(error){
            if(error?.code==='ENOENT')return null;
            throw error;
        }
        if(info.isSymbolicLink())return null;
    }

    const currentInfo=await lstat(candidate);
    if(currentInfo.isSymbolicLink()||!currentInfo.isFile())return null;
    const canonicalCandidate=await realpath(candidate);
    if(!pathIsWithin(root,canonicalCandidate))return null;
    let handle;
    try{
        handle=await open(candidate,READ_ONLY_NO_FOLLOW);
    }catch(error){
        if(error?.code==='ENOENT'||error?.code==='ELOOP')return null;
        throw error;
    }
    try{
        const opened=await handle.stat();
        if(!opened.isFile())return null;
        const content = readContent ? await handle.readFile() : undefined;
        const servedCandidate=await realpath(candidate);
        if(!pathIsWithin(root,servedCandidate)
            ||canonicalLocationKey(servedCandidate)!==canonicalLocationKey(canonicalCandidate)){
            return null;
        }
        return {candidate: servedCandidate, content, modifiedAt: opened.mtime};
    }catch(error){
        if(error?.code==='ENOENT')return null;
        throw error;
    }finally{
        await handle.close().catch(()=>{});
    }
}

async function serveGeneratedRepresentation(fileServer, request, response, {
    lastModified, contentType, body
}) {
    const modified = lastModified.toUTCString();
    response.setHeader('Last-Modified', modified);
    const requested = Date.parse(request.headers['if-modified-since']);
    if (Number.isFinite(requested) && Date.parse(modified) <= requested) {
        response.writeHead(304);
        response.end();
        return;
    }
    response.setHeader('Content-Type', contentType);
    await fileServer.serve(request, response, await body());
}

async function serveSourceFile(fileServer, request, response, opened, {
    assetVersion, revalidate = false, onReference, pwaEntry = false, lastModified
} = {}) {
    const extension = path.extname(opened.candidate).toLowerCase();
    const rewrite = assetVersion !== undefined && /\.(?:m?js|html?|css|json)$/iu.test(extension);
    if (revalidate) response.setHeader('Cache-Control', 'no-cache');
    if (!rewrite && !pwaEntry) {
        // Preserve the SDK's response headers while the module owns static
        // streaming and conditional requests, including its early 304 path.
        const writeHead = response.writeHead;
        response.writeHead = function writeDevelopmentHeaders(...arguments_) {
            this.removeHeader('ETag');
            this.removeHeader('X-Content-Type-Options');
            return writeHead.apply(this, arguments_);
        };
        await fileServer.serveFile(opened.candidate, request, response);
        return;
    }
    await serveGeneratedRepresentation(
        fileServer,
        request,
        response,
        {
            lastModified,
            contentType: MIME_TYPES.get(extension) || 'application/octet-stream',
            body: async function createSourceRepresentation() {
                let content = opened.content ?? await readFile(opened.candidate);
                if (rewrite) {
                    content = rewriteAssetReferences(
                        content.toString('utf8'),
                        {filePath: opened.candidate, version: assetVersion, onReference}
                    );
                }
                if (pwaEntry) {
                    content = applyPwaEntryReferences(
                        content.toString('utf8'),
                        {manifestUrl: '/arcane.webmanifest', bootstrapUrl: '/arcane-pwa.mjs'}
                    );
                }
                return content;
            }
        }
    );
}

function observeResponseCompletion(response) {
    return new Promise(
        function observeOwnedResponse(resolve, reject) {
            function releaseResponseListeners() {
                response.removeListener('error', responseFailed);
                response.removeListener('finish', responseCompleted);
                response.removeListener('close', responseCompleted);
            }
            function responseCompleted() {
                releaseResponseListeners();
                resolve();
            }
            function responseFailed(error) {
                releaseResponseListeners();
                reject(error);
            }
            response.once('error', responseFailed);
            response.once('finish', responseCompleted);
            response.once('close', responseCompleted);
        }
    );
}

function sourcePathAllowed(relative,manifest){
    const posix=relative.join('/');
    if(!posix)return false;
    const segments=posix.split('/');
    if(segments.some(segment=>segment.startsWith('.')
        ||PRIVATE_SOURCE_SEGMENTS.has(segment.toLowerCase())))return false;
    const comparable=inventoryKey(posix);
    const excluded=(manifest.exclude||[]).some(item=>{
        const candidate=inventoryKey(item);
        return comparable===candidate||comparable.startsWith(`${candidate}/`);
    });
    if(excluded)return false;
    return manifest.include.some(item=>{
        const candidate=inventoryKey(item);
        return comparable===candidate||comparable.startsWith(`${candidate}/`);
    });
}

function sharedPathAllowed(relative,route){
    const posix=relative.join('/');
    if(!posix||relative.some(segment=>segment.startsWith('.')))return false;
    const comparable=inventoryKey(posix);
    const excluded=(route.exclude??[]).some(item=>{
        const candidate=inventoryKey(item);
        return comparable===candidate||comparable.startsWith(`${candidate}/`);
    });
    if(excluded)return false;
    return route.include.some(item=>{
        const candidate=inventoryKey(item);
        return comparable===candidate||comparable.startsWith(`${candidate}/`);
    });
}

async function sourceRoutes(workspaceRoot,appId,{
    sdkRuntimeSourceRoot,
    signal,
    onEvent
}){
    const resolved=await resolveWorkspace({workspaceRoot,appId});
    const appMapping={
        prefix:['apps',resolved.appId],
        root:resolved.appRoot,
        include:resolved.app.manifest.include,
        allow:relative=>sourcePathAllowed(relative,resolved.app.manifest)
    };
    if(sdkRuntimeSourceRoot!==undefined){
        const sdkSource=await verifySdkRuntimeSourceRoot(
            sdkRuntimeSourceRoot,
            resolved.workspaceRoot,
            resolved.appId,
            {signal,onEvent}
        );
        return {
            workspaceRoot:resolved.workspaceRoot,
            workspaceMode:resolved.config.workspaceMode,
            appId:resolved.appId,
            app:resolved.app.manifest,
            startPath:`/apps/${resolved.appId}/${resolved.app.manifest.entry}`,
            runtime:sdkSource.runtime,
            mappings:[appMapping,...sdkSource.mappings]
        };
    }
    if(resolved.config.workspaceMode==='integrated'){
        return {
            workspaceRoot:resolved.workspaceRoot,
            workspaceMode:'integrated',
            appId:resolved.appId,
            app:resolved.app.manifest,
            startPath:`/apps/${resolved.appId}/${resolved.app.manifest.entry}`,
            mappings:[
                appMapping,
                ...resolved.config.sharedPayloads['browser-runtime'].map(route=>({
                    prefix:route.destination.split('/'),
                    root:path.join(resolved.workspaceRoot,...route.source.split('/')),
                    include:route.include,
                    allow:relative=>sharedPathAllowed(relative,route)
                }))
            ]
        };
    }
    const runtimeRoot=path.join(resolved.workspaceRoot,'arcane');
    return {
        workspaceRoot:resolved.workspaceRoot,
        workspaceMode:'external',
        appId:resolved.appId,
        app:resolved.app.manifest,
        startPath:`/apps/${resolved.appId}/${resolved.app.manifest.entry}`,
        mappings:[
            appMapping,
            {
                prefix:['arcane'],
                root:runtimeRoot,
                include:[...SDK_INSTALLED_ARCANE_ROOTS],
                allow:sdkInstalledArcanePathAllowed
            }
        ]
    };
}

async function packagedRoutes(releaseRoot){
    if(!is.string(releaseRoot)||!releaseRoot.trim())fail('releaseRoot is required in packaged mode.','ARCANE_USAGE');
    const requested=path.resolve(releaseRoot);
    const canonical=await canonicalRealDirectory(requested,'Packaged release root');
    let pwa = false;
    let startPath = '/index.html';
    try {
        const manifest = JSON.parse(await readFile(path.join(canonical, 'arcane-offline.json'), 'utf8'));
        pwa = manifest.schemaVersion === 1;
        if (pwa) {
            const release = JSON.parse(
                await readFile(path.join(canonical, 'ARCANE_APP_RELEASE.json'), 'utf8')
            );
            startPath = `/${release.app.entry}`;
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    return {
        workspaceRoot:null,
        appId:null,
        pwa,
        startPath,
        mappings:[{
            prefix:[],
            root:canonical
        }]
    };
}

async function sourcePwaAssets(routeSet, mappings, signal, resourceUrls, resourcePaths) {
    const records = new Map();
    const resources = new Map();
    for (const mapping of mappings) {
        const visited = new Set();
        async function visitSourceResource(relative) {
            throwIfAborted(signal);
            const key = relative.join('/');
            if (visited.has(key)) return;
            visited.add(key);
            if (relative.length > 0 && mapping.allow && !mapping.allow(relative)) return;
            const location = path.join(mapping.root, ...relative);
            let info;
            try {
                info = await lstat(location);
            } catch (error) {
                if (error.code === 'ENOENT') return;
                throw error;
            }
            if (info.isDirectory()) {
                const entries = await readdir(location, {withFileTypes: true});
                for (const entry of entries) {
                    await visitSourceResource([...relative, entry.name]);
                }
            } else if (info.isFile()) {
                const segments = [...mapping.prefix, ...relative];
                const url = `/${segments.map(encodeURIComponent).join('/')}`;
                const appResource = mapping.prefix[0] === 'apps'
                    && mapping.prefix[1] === routeSet.appId;
                const logical = (appResource ? relative : segments).join('/');
                records.set(logical, url);
                resources.set(url, {mapping, relative});
            }
        }
        for (const selected of mapping.include ?? ['']) {
            await visitSourceResource(selected ? selected.split('/') : []);
        }
    }
    const origin = 'http://arcane.invalid';
    const entryUrl = new URL(routeSet.startPath, origin);
    const pending = [{url: entryUrl, documentUrl: entryUrl}];
    const visited = new Set();
    const referencesByPath = new Map();
    for (const selected of routeSet.app.include) {
        if (!/\.html?$/iu.test(selected)) continue;
        const url = new URL(
            `/apps/${routeSet.appId}/${selected.split('/').map(encodeURIComponent).join('/')}`,
            origin
        );
        pending.push({url, documentUrl: url});
    }
    let runtimeRootsAdded = false;
    for (const current of pending) {
        throwIfAborted(signal);
        const pathname = current.url.pathname;
        const record = resources.get(pathname);
        const context = `${pathname}\n${current.documentUrl.origin}${current.documentUrl.pathname}${current.documentUrl.search}`;
        if (!record || visited.has(context)) continue;
        const managedMap = path.posix.basename(pathname) === 'arcane.importmap.json';
        if (!/\.(?:m?js|html?|css)$/iu.test(pathname) && !managedMap) continue;
        visited.add(context);
        resourcePaths.add(decodeURIComponent(pathname));
        let references = referencesByPath.get(pathname);
        if (!references) {
            const opened = await openSafeFile(record.mapping.root, record.relative);
            if (!opened) continue;
            references = [];
            rewriteAssetReferences(
                opened.content.toString('utf8'),
                {
                    filePath: opened.candidate,
                    version: null,
                    onReference: function rememberSourceReference(reference) {
                        references.push(reference);
                    }
                }
            );
            referencesByPath.set(pathname, references);
        }
        const authoredBase = references.find(function documentBaseReference(reference) {
            return reference.baseHref;
        })?.baseHref;
        const documentUrl = authoredBase ? new URL(authoredBase, current.url) : current.documentUrl;
        if (!runtimeRootsAdded && pathname === entryUrl.pathname) {
            runtimeRootsAdded = true;
            for (const url of resources.keys()) {
                if (/^\/arcane\/.*\.(?:m?js|html?|css)$/iu.test(url)
                    || path.posix.basename(url) === 'arcane.importmap.json') {
                    pending.push({url: new URL(url, origin), documentUrl});
                }
            }
        }
        for (const {url, kind, baseHref, baseKind} of references) {
            if (kind === 'import' && !/^(?:\.{1,2}\/|\/)/u.test(url)) continue;
            let target;
            let base;
            try {
                base = baseHref ? new URL(baseHref, current.url)
                    : managedMap || baseKind === 'document' ? documentUrl : current.url;
                target = new URL(versionAssetUrl(url, null), base);
            } catch {
                // Non-URL source values retain their authored behavior.
                continue;
            }
            if (target.origin !== origin || !resources.has(target.pathname)) continue;
            resourceUrls.add(`${target.pathname}${target.search}`);
            const traversable = kind !== 'fetch'
                && (kind !== 'asset' || /\.css(?:[?#]|$)/iu.test(url));
            if (traversable) {
                pending.push({
                    url: target,
                    documentUrl: kind === 'document' ? target : documentUrl
                });
            }
        }
    }
    const assets = selectPwaFiles([...records.keys()].sort(), routeSet.app.pwa).map(
        function selectedSourceUrl(relative) {
            return records.get(relative);
        }
    );
    const selectedUrls = new Set(assets);
    for (const resourceUrl of resourceUrls) {
        const url = new URL(resourceUrl, 'http://arcane.invalid');
        if (selectedUrls.has(url.pathname)) selectedUrls.add(resourceUrl);
    }
    return [...selectedUrls].sort();
}

function closeDevelopmentListeners(fileServer, tlsServer) {
    const closeTls = tlsServer ? new Promise(
        function closeRawTlsListener(resolve, reject) {
            tlsServer.close(function rawTlsClosed(error) {
                if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
                else resolve();
            });
        }
    ) : Promise.resolve();
    return Promise.allSettled([fileServer.close(), closeTls]).then(
        function developmentListenersClosed(results) {
            const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors, 'Development listener shutdown failed.');
        }
    );
}

function deployDevelopmentServer(fileServer, signal, {tlsServer, host, port}) {
    return new Promise(
        function deployOwnedListeners(resolve, reject) {
            let listeners = [];
            const ready = new Set();
            let settled = false;
            function cleanupDeployment() {
                signal?.removeEventListener('abort', abortDeployment);
                for (const listener of listeners) listener.removeListener('error', failedDeployment);
            }
            async function failedDeployment(error) {
                if (settled) return;
                settled = true;
                try {
                    await closeDevelopmentListeners(fileServer, tlsServer);
                } catch (closeError) {
                    error = new AggregateError([error, closeError], 'Development listener startup failed.');
                } finally {
                    cleanupDeployment();
                }
                reject(error);
            }
            function abortDeployment() {
                void failedDeployment(signal.reason || new Error('Operation cancelled.'));
            }
            function listenerReady(instance, readyListener) {
                if (settled) return;
                ready.add(readyListener);
                if (!listeners.every(listener => ready.has(listener))) return;
                settled = true;
                cleanupDeployment();
                resolve(tlsServer ?? fileServer.secureServer);
            }
            try {
                throwIfAborted(signal);
                signal?.addEventListener('abort', abortDeployment, {once: true});
                fileServer.deploy(listenerReady);
                listeners = [fileServer.server, fileServer.secureServer, tlsServer].filter(Boolean);
                for (const listener of listeners) listener.on('error', failedDeployment);
                tlsServer?.listen(port, host, function rawTlsListenerReady() {
                    listenerReady(fileServer, tlsServer);
                });
            } catch (error) {
                void failedDeployment(error);
            }
        }
    );
}

function browserHostname(host){
    return host.includes(':')?`[${host}]`:host;
}

function networkUrlsForAddress(address,startPath,protocol){
    if(address.address==='127.0.0.1'||address.address==='::1')return [];
    const allIPv4=address.address==='0.0.0.0';
    const allInterfaces=address.address==='::';
    const urls=new Set();
    for(const entries of Object.values(os.networkInterfaces())){
        for(const entry of entries??[]){
            if(entry.internal)continue;
            // Scoped IPv6 addresses need the receiving device's interface,
            // so they cannot provide a portable browser link for another device.
            if(entry.family==='IPv6'&&entry.scopeid)continue;
            if(allIPv4&&entry.family!=='IPv4')continue;
            if(!allIPv4&&!allInterfaces&&entry.address!==address.address)continue;
            urls.add(`${protocol}//${browserHostname(entry.address)}:${address.port}${startPath}`);
        }
    }
    return [...urls];
}

async function resolveDevelopmentTls({workspaceRoot,tls,certPath,keyPath,signal}){
    if(tls!==undefined&&tls!==null&&tls!==false){
        if(!is.object(tls)||is.array(tls)){
            fail('Development server tls must be a Node HTTPS options object.','ARCANE_USAGE');
        }
        return {options:tls};
    }
    if((certPath===undefined)!==(keyPath===undefined)){
        fail('HTTPS development requires both certPath and keyPath when either is supplied.','ARCANE_USAGE');
    }
    const certificatePath=path.resolve(workspaceRoot,certPath??'.arcane/dev/server-cert.pem');
    const privateKeyPath=path.resolve(workspaceRoot,keyPath??'.arcane/dev/server-key.pem');
    try{
        const reads=await Promise.allSettled([
            realpath(certificatePath),
            realpath(privateKeyPath)
        ]);
        for(const read of reads){
            if(read.status==='rejected')throw read.reason;
        }
        return {
            certificatePath: reads[0].value,
            privateKeyPath: reads[1].value
        };
    }catch(error){
        if(error.code==='ENOENT'){
            fail(
                `Arcane development and packaged previews require HTTPS. `
                +`Provide a certificate at ${certificatePath} and a key at ${privateKeyPath}, `
                +'or select existing files with --cert and --key.',
                'ARCANE_DEV_TLS_MISSING'
            );
        }
        throw error;
    }
}

async function startOwnedDevServer({
    workspaceRoot=process.cwd(),
    appId,
    mode='source',
    releaseRoot,
    host='127.0.0.1',
    port=0,
    httpPort=0,
    tls,
    certPath,
    keyPath,
    signal,
    sdkRuntimeSourceRoot
}={},events,releaseSignal){
    throwIfAborted(signal);
    if(mode!=='source'&&mode!=='packaged')fail(`Unsupported server mode: ${String(mode)}.`,'ARCANE_USAGE');
    if(sdkRuntimeSourceRoot!==undefined&&mode!=='source'){
        fail('sdkRuntimeSourceRoot is supported only in source development mode.','ARCANE_USAGE');
    }
    if(!is.string(host)||!host.trim()){
        fail('Development server host must be a nonempty string.','ARCANE_USAGE');
    }
    if(!is.integer(port)||port<0||port>65535)fail('port must be an integer from 0 through 65535.','ARCANE_USAGE');
    if (!is.integer(httpPort) || httpPort < 0 || httpPort > 65535) {
        fail('httpPort must be an integer from 0 through 65535.', 'ARCANE_USAGE');
    }
    const requestedRuntimeMode=mode==='source'&&sdkRuntimeSourceRoot!==undefined
        ?'sdk-source'
        :null;
    await events.send({
        type:'server.starting',
        mode,
        host,
        port,
        httpPort,
        appId,
        ...(requestedRuntimeMode?{runtimeMode:requestedRuntimeMode}:{})
    });
    const selectedTls=await resolveDevelopmentTls({
        workspaceRoot,tls,certPath,keyPath,signal
    });
    const protocol = 'https:';
    throwIfAborted(signal);
    const routeSet=mode==='source'
        ?await sourceRoutes(workspaceRoot,appId,{
            sdkRuntimeSourceRoot,
            signal,
            onEvent:event=>events.send(event)
        })
        :await packagedRoutes(releaseRoot);
    const mappings=deterministicMappings(routeSet.mappings);
    const pwaEnabled = mode === 'source' ? routeSet.app?.pwa?.enabled === true : routeSet.pwa;
    const versionPath = mode === 'source'
        ? sdkRuntimeSourceRoot === undefined
            ? path.join(routeSet.workspaceRoot, 'arcane.lock.json')
            : path.join(routeSet.runtime.sourceRoot, 'package.json')
        : undefined;
    const [generatorInputs, initialAssetVersion, versionInput] = await Promise.all(
        [
            mode === 'source' ? Promise.all(
                [
                    lstat(new URL('./dev-server.mjs', import.meta.url)),
                    lstat(new URL('./import-map.mjs', import.meta.url)),
                    lstat(new URL('../package.json', import.meta.url))
                ]
            ) : [],
            selectedAssetVersion(),
            versionPath ? lstat(versionPath).catch(
                function optionalVersionMetadata(error) {
                    if (error.code !== 'ENOENT') throw error;
                    return null;
                }
            ) : null
        ]
    );
    const generatorModifiedAt = Math.max(
        0,
        ...generatorInputs.map(
            function generatorModification(input) {
                return input.mtimeMs;
            }
        )
    );
    async function selectedAssetVersion(){
        if(mode!=='source')return undefined;
        return sdkRuntimeSourceRoot===undefined
            ?readWorkspaceAssetVersion(routeSet.workspaceRoot)
            :JSON.parse(await readFile(
                path.join(routeSet.runtime.sourceRoot,'package.json'),'utf8'
            )).version;
    }
    let assetVersion = initialAssetVersion;
    let assetVersionModifiedAt = Math.max(generatorModifiedAt, versionInput?.mtimeMs ?? 0);
    function rememberAssetVersion(version) {
        if (version !== assetVersion) assetVersionModifiedAt = Date.now();
        assetVersion = version;
    }
    const documentMetadata = new Map();
    const representationMetadata = new Map();
    async function isManagedDocument(opened) {
        const previous = documentMetadata.get(opened.candidate);
        const modifiedAt = opened.modifiedAt.getTime();
        if (previous?.modifiedAt === modifiedAt) return previous.managed;
        opened.content = await readFile(opened.candidate);
        let managed = false;
        if (opened.content.includes(MANAGED_IMPORT_MAP_ATTRIBUTE)) {
            try {
                managed = inspectImportMapHtml(opened.content.toString('utf8')).managedMaps.length > 0;
            } catch {
                // An unrelated document is not a source validation surface.
            }
        }
        documentMetadata.set(
            opened.candidate,
            {modifiedAt, managed}
        );
        return managed;
    }
    function sourceRepresentationModifiedAt(opened, version, pwaEntry) {
        const modifiedAt = opened.modifiedAt.getTime();
        const previous = representationMetadata.get(opened.candidate);
        if (previous?.modifiedAt === modifiedAt
            && previous.version === version && previous.pwaEntry === pwaEntry) {
            return previous.lastModified;
        }
        const lastModified = new Date(
            Math.max(modifiedAt, generatorModifiedAt, assetVersionModifiedAt, previous ? Date.now() : 0)
        );
        representationMetadata.set(
            opened.candidate,
            {modifiedAt, version, pwaEntry, lastModified}
        );
        return lastModified;
    }
    for(const mapping of mappings){
        const info=await lstat(mapping.root);
        if(info.isSymbolicLink()||!info.isDirectory())fail(`Server route root must be a real directory: ${mapping.root}.`);
        mapping.root=await realpath(mapping.root);
    }
    let pwaArtifacts;
    let pwaInventoryTask;
    const generatedMetadata = new Map();
    const pwaResourceUrls = new Set();
    function developmentPwaArtifacts(assets = []) {
        return createPwaArtifacts(
            {
                app: {
                    id: routeSet.appId,
                    displayName: routeSet.app.displayName,
                    version: routeSet.app.version,
                    entry: routeSet.startPath
                },
                sdkVersion: assetVersion,
                pwa: routeSet.app.pwa,
                files: [],
                assets,
                navigationAliases: {'/': routeSet.startPath},
                basePath: '/',
                appBase: `/apps/${routeSet.appId}/`,
                runtimeBase: '/arcane/sdk/',
                mode: 'development'
            }
        );
    }
    function rememberPwaArtifacts(artifacts) {
        for (const file of artifacts.files) {
            const previous = generatedMetadata.get(file.path);
            const lastModified = previous?.content === file.content
                ? previous.lastModified
                : new Date();
            generatedMetadata.set(
                file.path,
                {content: file.content, lastModified}
            );
        }
        pwaArtifacts = artifacts;
        return artifacts;
    }
    async function sourcePwaArtifact(targetPath) {
        if (targetPath === '/arcane-sw.js'
            || targetPath === '/arcane-offline.json') {
            if (!pwaInventoryTask) {
                pwaInventoryTask = Promise.all(
                    [sourcePwaAssets(routeSet, mappings, signal, pwaResourceUrls, resourcePaths), selectedAssetVersion()]
                ).then(
                    function prepareSourceOfflineInventory([assets, version]) {
                        rememberAssetVersion(version);
                        return rememberPwaArtifacts(developmentPwaArtifacts(assets));
                    }
                ).finally(
                    function releaseSourceInventoryTask() {
                        pwaInventoryTask = null;
                    }
                );
            }
            await pwaInventoryTask;
        }
        const artifacts = pwaArtifacts ?? rememberPwaArtifacts(developmentPwaArtifacts());
        const file = artifacts.files.find(
            function requestedPwaFile(file) {
                return `/${file.path}` === targetPath;
            }
        );
        return {...file, lastModified: generatedMetadata.get(file.path).lastModified};
    }
    // Remember actual resource edges as their owners are served, not every
    // HTML/JS/CSS file in an application's document or attachment corpus.
    const resourcePaths=new Set([routeSet.startPath]);
    const requestTasks=new Set();
    const runFileWork=createFileWorkLimiter();
    async function serveDevelopmentRequest(request, response) {
        let task;
        async function routeDevelopmentRequest() {
            if (!request.socket.encrypted) {
                const address = (tlsServer ?? fileServer.secureServer).address();
                const authority = new URL(`http://${request.headers.host || browserHostname(host)}`);
                authority.protocol = 'https:';
                authority.port = String(address.port);
                response.writeHead(308, {Location: `${authority.origin}${request.url || '/'}`});
                response.end();
                return;
            }
            if(request.method!=='GET'&&request.method!=='HEAD'){
                deny(response,405,'Method not allowed.');
                return;
            }
            const target=parseRequestTarget(request.url);
            if(!target){deny(response,400,'Invalid request path.');return;}
            const {segments}=target;
            if (mode === 'source' && pwaEnabled
                && ['/arcane.webmanifest', '/arcane-offline.json', '/arcane-sw.js', '/arcane-pwa.mjs'].includes(target.path)) {
                const generated = await sourcePwaArtifact(target.path);
                response.setHeader('Cache-Control', 'no-cache');
                await serveGeneratedRepresentation(
                    fileServer,
                    request,
                    response,
                    {
                        lastModified: generated.lastModified,
                        contentType: MIME_TYPES.get(path.extname(generated.path)),
                        body: function generatedPwaBody() {
                            return generated.content;
                        }
                    }
                );
                return;
            }
            if(segments.length===0){
                response.writeHead(302,{location:routeSet.startPath});
                response.end();
                return;
            }
            const mapping=mappings.find(route=>
                route.prefix.every((segment,index)=>segments[index]===segment)
            );
            if(!mapping){deny(response,404,'Not found.');return;}
            const relative=segments.slice(mapping.prefix.length);
            if(relative.length===0){deny(response,404,'Not found.');return;}
            if(mapping.allow&&!mapping.allow(relative)){deny(response,404,'Not found.');return;}
            await runFileWork(async function serveMappedResource() {
                const opened = await openSafeFile(
                    mapping.root,
                    relative,
                    {readContent: false}
                );
                if(!opened){deny(response,404,'Not found.');return;}
                if(selectedTls?.privateKeyPath
                    &&canonicalLocationKey(opened.candidate)===canonicalLocationKey(selectedTls.privateKeyPath)){
                    deny(response,404,'Not found.');
                    return;
                }
                const extension=path.extname(opened.candidate).toLowerCase();
                const html=extension==='.html'||extension==='.htm';
                const selectedPwaDocument = mode === 'source' && pwaEnabled && html
                    && mapping.prefix[0] === 'apps' && mapping.prefix[1] === routeSet.appId
                    && routeSet.app.include.includes(relative.join('/'));
                const selectedDocument = target.path === routeSet.startPath || selectedPwaDocument;
                const managedDocument = !selectedDocument && html && await isManagedDocument(opened);
                const entryDocument = selectedDocument || managedDocument;
                const managedMap=path.basename(opened.candidate)==='arcane.importmap.json';
                // A live server can span an SDK upgrade. Refresh the small
                // version record on navigation, not on each resource request.
                if(entryDocument||managedMap)rememberAssetVersion(await selectedAssetVersion());
                const runtimeResource=segments[0]==='arcane';
                const browserResource=['script','style','worker','sharedworker','serviceworker']
                    .includes(request.headers['sec-fetch-dest']);
                const rewrite=runtimeResource||entryDocument||browserResource||managedMap
                    ||resourcePaths.has(target.path);
                const onReference = function observeServedResource({url,kind,baseHref,baseKind}) {
                    if (pwaEnabled && kind !== 'fetch'
                        && !(kind === 'import' && !/^(?:\.{1,2}\/|\/)/u.test(url))) {
                        try {
                            const documentUrl = new URL(target.path, 'http://arcane.invalid');
                            const base = baseHref ? new URL(baseHref, documentUrl) : documentUrl;
                            const resource = new URL(versionAssetUrl(url, null), base);
                            if (resource.origin === documentUrl.origin) {
                                pwaResourceUrls.add(`${resource.pathname}${resource.search}`);
                            }
                        } catch {
                            // Non-URL resource values remain under their existing owner.
                        }
                    }
                    if(baseKind==='document'||kind==='fetch'||(kind==='asset'&&!/\.css(?:[?#]|$)/iu.test(url))
                        ||(kind==='import'&&!/^(?:\.{1,2}\/|\/)/u.test(url)))return;
                    try{
                        const documentUrl=new URL(target.path,'http://arcane.invalid');
                        const base=baseHref?new URL(baseHref,documentUrl):documentUrl;
                        const resource=new URL(url,base);
                        if(resource.origin===documentUrl.origin
                            &&/\.(?:m?js|html?|css)$/iu.test(resource.pathname)){
                            resourcePaths.add(decodeURIComponent(resource.pathname));
                        }
                    }catch{ /* Non-URL values remain under their existing owner. */ }
                };
                const selectedVersion = rewrite && mode === 'source' ? (pwaEnabled ? null : assetVersion) : undefined;
                const pwaEntry = mode === 'source' && pwaEnabled && entryDocument;
                const transformed = pwaEntry || (selectedVersion !== undefined
                    && /\.(?:m?js|html?|css|json)$/iu.test(extension));
                await serveSourceFile(
                    fileServer,
                    request,
                    response,
                    opened,
                    {
                        assetVersion: selectedVersion,
                        revalidate: pwaEnabled || entryDocument || managedMap,
                        pwaEntry,
                        onReference,
                        lastModified: transformed
                            ? sourceRepresentationModifiedAt(opened, selectedVersion, pwaEntry)
                            : undefined
                    }
                );
            });
        }
        const responseCompletion = observeResponseCompletion(response);
        task = Promise.all(
            [routeDevelopmentRequest(), responseCompletion]
        ).catch(
            async function failedDevelopmentRequest(error) {
                await events.enqueue({type: 'server.request.failed', message: error.message});
                if (!response.headersSent) {
                    const status = error?.code === 'ARCANE_BACKPRESSURE' ? 503 : 500;
                    deny(response, status, 'Internal server error.');
                } else if (!response.destroyed) {
                    response.destroy(error);
                }
            }
        ).finally(
            function releaseDevelopmentRequest() {
                requestTasks.delete(task);
            }
        );
        requestTasks.add(task);
        await task;
        return true;
    }
    const contentType = Object.fromEntries(
        [...MIME_TYPES].map(
            function serverContentType([extension, value]) {
                return [extension.substring(1), value];
            }
        )
    );
    const fileServer = new Server(
        {
            root: mappings[0].root,
            host,
            port: httpPort,
            server: {noCache: false, timeout: 0},
            https: {
                only: false,
                port,
                ...(selectedTls.options ? {} : {
                    privateKey: selectedTls.privateKeyPath,
                    certificate: selectedTls.certificatePath
                })
            }
        }
    );
    fileServer.config.contentType = contentType;
    fileServer.onRawRequest = serveDevelopmentRequest;
    // The module's public HTTPS configuration accepts PEM paths. Its HTTPS
    // guide leaves advanced TLS inputs to application code; preserve that
    // existing SDK input while the same public module methods serve all content.
    const tlsServer = selectedTls.options
        ? https.createServer(selectedTls.options, serveDevelopmentRequest)
        : null;
    const server = await deployDevelopmentServer(fileServer, signal, {tlsServer, host, port});
    const listeners = [fileServer.server, server];
    const address=server.address();
    if(!address||is.string(address)){
        await closeDevelopmentListeners(fileServer, tlsServer);
        fail('Development server did not expose a TCP address.');
    }
    const visibleHost=address.address==='0.0.0.0'||address.address==='::'
        ?'localhost'
        :browserHostname(address.address);
    const endpoint=new URL(`${protocol}//${visibleHost}:${address.port}`);
    const origin=endpoint.origin;
    const httpAddress = fileServer.server.address();
    const httpOrigin = new URL(`http://${visibleHost}:${httpAddress.port}`).origin;
    const httpUrl = `${httpOrigin}${routeSet.startPath}`;
    const cleanUrl=`${origin}${routeSet.startPath}`;
    const url=cleanUrl;
    let closeInitiated=false;
    let lifecycleSettlementStarted=false;
    let operationalError=null;
    let resolveLifecycle;
    let rejectLifecycle;
    const lifecycle=new Promise((resolve,reject)=>{
        resolveLifecycle=resolve;
        rejectLifecycle=reject;
    });
    // A library consumer may only use the raw server. Keep a later lifecycle
    // rejection observable without allowing it to become unhandled.
    void lifecycle.catch(()=>{});

    const finishLifecycle=async()=>{
        if(lifecycleSettlementStarted){
            return;
        }
        lifecycleSettlementStarted=true;
        signal?.removeEventListener('abort',abort);
        for (const listener of listeners) listener.removeListener('error', serverFailed);
        try{
            while(requestTasks.size>0){
                await Promise.allSettled([...requestTasks]);
            }
            if(routeSet.runtime?.mode==='sdk-source'){
                await events.send({
                    type:'runtime.source.mount.stopped',
                    appId:routeSet.appId,
                    reason:events.error||operationalError
                        ?'failed'
                        :signal?.aborted
                            ?'cancelled'
                            :'closed'
                });
            }
            await events.send({
                type:'server.stopped',
                host:address.address,
                port:address.port
            });
            await events.drain();
            if(operationalError){
                rejectLifecycle(operationalError);
            }else{
                resolveLifecycle();
            }
        }catch(error){
            rejectLifecycle(events.error??operationalError??error);
        }finally{
            releaseSignal();
        }
    };

    const close=error=>{
        if(error&&!operationalError){
            operationalError=error;
        }
        if(!closeInitiated){
            closeInitiated=true;
            try{
                closeDevelopmentListeners(fileServer, tlsServer).then(
                    function developmentServerClosed() {
                        void finishLifecycle();
                    },
                    function developmentServerCloseFailed(closeError) {
                        operationalError ??= closeError;
                        void finishLifecycle();
                    }
                );
            }catch(closeError){
                operationalError??=closeError;
                void finishLifecycle();
            }
        }
        return lifecycle;
    };
    const abort=()=>{void close().catch(()=>{});};
    const serverFailed=error=>{void close(error).catch(()=>{});};
    signal?.addEventListener('abort',abort,{once:true});
    for (const listener of listeners) {
        listener.on('error', serverFailed);
        listener.once('close', function ownedListenerClosed() {
            if (!closeInitiated) void close().catch(() => {});
        });
    }
    const result={
        server,
        protocol,
        mode,
        workspaceRoot:routeSet.workspaceRoot,
        appId:routeSet.appId,
        ...(routeSet.runtime?{
            runtimeMode:routeSet.runtime.mode,
            runtime:routeSet.runtime
        }:{}),
        host:address.address,
        port:address.port,
        httpPort: httpAddress.port,
        httpOrigin,
        httpUrl,
        origin,
        cleanUrl,
        url,
        networkUrls:[],
        close,
        closed:lifecycle,
        lifecycle
    };
    try{
        result.networkUrls=networkUrlsForAddress(address,routeSet.startPath,protocol);
        await events.send({
            type:'server.started',
            protocol,
            mode,
            host:result.host,
            port:result.port,
            httpPort: result.httpPort,
            httpOrigin,
            httpUrl,
            url,
            networkUrls:result.networkUrls,
            appId:result.appId,
            ...(routeSet.runtime?{
                runtimeMode:routeSet.runtime.mode,
                runtime:routeSet.runtime
            }:{})
        });
        throwIfAborted(signal);
    }catch(error){
        try{
            await close();
        }catch(lifecycleError){
            throw events.error??lifecycleError;
        }
        throw error;
    }
    return result;
}

export async function startDevServer(options={}){
    const inputSignal=options.signal;
    throwIfAborted(inputSignal);
    const controller=new AbortController();
    const forwardAbort=()=>controller.abort(inputSignal?.reason);
    inputSignal?.addEventListener('abort',forwardAbort,{once:true});
    if(inputSignal?.aborted){
        forwardAbort();
    }
    let released=false;
    const releaseSignal=()=>{
        if(released){
            return;
        }
        released=true;
        inputSignal?.removeEventListener('abort',forwardAbort);
    };
    const events=createEventQueue(options.onEvent,{
        onFailure:error=>controller.abort(error)
    });
    try{
        return await startOwnedDevServer(
            {...options,signal:controller.signal},
            events,
            releaseSignal
        );
    }catch(error){
        releaseSignal();
        try{
            await events.drain();
        }catch(callbackFailure){
            throw callbackFailure;
        }
        throw error;
    }
}

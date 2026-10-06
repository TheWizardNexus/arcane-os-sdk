import Is from 'strong-type';
import {createWriteStream} from 'node:fs';
import {chmod,copyFile,lstat,mkdir,mkdtemp,readFile,readdir,readlink,rm,stat,symlink,unlink,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {ArcaneError,ERROR_CODES,normalizeError,throwIfAborted} from '../errors.mjs';
import {createEventQueue} from '../event-queue.mjs';
import {runProcess} from '../process.mjs';
import {extractLocalAIArchive} from './archive.mjs';
import {normalizeImageRuntimeRequirement} from './config.mjs';

const is=new Is(false);
const installations=new Map();

function selectRuntimes(runtimes){
    if(!is.array(runtimes)){
        throw new ArcaneError(ERROR_CODES.usage,'Local AI runtimes must be an array.');
    }
    const selected=new Map();
    for(const item of runtimes){
        const requirement=is.string(item)?{id:item}:item;
        const runtime=requirement?.id==='stable-diffusion.cpp'?normalizeImageRuntimeRequirement(requirement):requirement;
        if(!runtime||!['llama.cpp','ollama','nemo-speech','onnx','stable-diffusion.cpp'].includes(runtime.id)){
            throw new ArcaneError(ERROR_CODES.targetUnavailable,`Local AI runtime installation is unavailable for ${String(runtime?.id)}.`);
        }
        const prior=selected.get(runtime.id);
        if(prior&&(prior.version!==runtime.version||prior.url!==runtime.url||(runtime.id==='stable-diffusion.cpp'&&prior.backend!==runtime.backend))){
            throw new ArcaneError(ERROR_CODES.usage,`Select one ${runtime.id} runtime version and URL for this operation.`);
        }
        if(runtime.version!==undefined&&(!is.string(runtime.version)||!runtime.version)){
            throw new ArcaneError(ERROR_CODES.usage,`${runtime.id} version must be a nonempty string.`);
        }
        if(runtime.url!==undefined&&(!is.string(runtime.url)||!runtime.url)){
            throw new ArcaneError(ERROR_CODES.usage,`${runtime.id} URL must be a nonempty string.`);
        }
        selected.set(runtime.id,runtime);
    }
    return [...selected.values()];
}

function selectedDirectory(directory){
    if(!is.string(directory)||!directory){
        throw new ArcaneError(ERROR_CODES.usage,'Local AI installation needs an explicit directory.');
    }
    return path.resolve(directory);
}

function releaseAssetNames(id,version,platform,architecture){
    if(id==='nemo-speech'){
        if(!['x64','arm64'].includes(architecture))return [];
        const arch=architecture==='x64'?'x86_64':'aarch64';
        const name=`nemo-speech-${version.replace(/^v/u,'')}`;
        if(platform==='win32'&&architecture==='x64')return [`${name}-windows-${arch}-cpu.zip`];
        if(platform==='linux')return [`${name}-linux-${arch}-cpu.tar.gz`];
        if(platform==='darwin')return [`${name}-macos-${arch}-cpu.tar.gz`];
        return [];
    }
    if(id==='ollama'){
        if(platform==='darwin'&&['x64','arm64'].includes(architecture))return ['ollama-darwin.tgz'];
        const arch=architecture==='x64'?'amd64':architecture;
        if(!['amd64','arm64'].includes(arch))return [];
        if(platform==='win32')return [`ollama-windows-${arch}.zip`];
        if(platform==='linux')return [`ollama-linux-${arch}.tar.zst`,`ollama-linux-${arch}.tgz`];
        return [];
    }
    if(!['x64','arm64'].includes(architecture))return [];
    if(platform==='win32')return [`llama-${version}-bin-win-cpu-${architecture}.zip`];
    if(platform==='linux')return [`llama-${version}-bin-ubuntu-${architecture}.tar.gz`,`llama-${version}-bin-ubuntu-${architecture}.zip`];
    if(platform==='darwin')return [`llama-${version}-bin-macos-${architecture}.tar.gz`,`llama-${version}-bin-macos-${architecture}.zip`];
    if(platform==='android'&&architecture==='arm64')return [`llama-${version}-bin-android-arm64.tar.gz`];
    return [];
}

async function upstreamResponse(url,signal){
    throwIfAborted(signal);
    const response=await fetch(url,{signal,headers:{'User-Agent':'arcane-os-local-ai'}});
    if(!response.ok){
        const body=await response.text();
        throw new ArcaneError(ERROR_CODES.operationFailed,`Local AI download returned HTTP ${response.status}${body?`: ${body}`:''}.`);
    }
    return response;
}

async function selectRelease(runtime,platform,architecture,signal){
    if (runtime.id === 'stable-diffusion.cpp') {
        return selectImageRelease(runtime, platform, architecture, signal);
    }
    if(runtime.url){
        const name=path.posix.basename(new URL(runtime.url).pathname);
        return {version:runtime.version??'custom',url:runtime.url,name};
    }
    const repository=runtime.id==='nemo-speech'?'NVIDIA/NeMo-Speech.cpp':runtime.id==='llama.cpp'?'ggml-org/llama.cpp':'ollama/ollama';
    const version=runtime.version??(runtime.id==='nemo-speech'?'0.2.0':undefined);
    const selected=version&&version!=='latest'
        ?`tags/${encodeURIComponent(runtime.id!=='llama.cpp'&&!version.startsWith('v')?`v${version}`:version)}`
        :'latest';
    let release=await (await upstreamResponse(`https://api.github.com/repos/${repository}/releases/${selected}`,signal)).json();
    if(runtime.id==='llama.cpp'){
        // Stable llama.cpp releases identify their binary build explicitly.
        const nightly=release.assets?.find(function isNightlySelection(asset){return asset.name==='nightly-tag.txt';});
        if(nightly){
            const tag=(await (await upstreamResponse(nightly.browser_download_url,signal)).text()).trim();
            release=await (await upstreamResponse(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,signal)).json();
        }
    }
    // Select only published format variants for this exact target distribution.
    const names=releaseAssetNames(runtime.id,release.tag_name,platform,architecture);
    const asset=release.assets?.find(function isSelectedAsset(candidate){return names.includes(candidate.name);});
    if(!asset){
        throw new ArcaneError(ERROR_CODES.targetUnavailable,`${runtime.id} ${release.tag_name} has no published ${platform}/${architecture} runtime archive${names.length?` named ${names.join(' or ')}`:''}.`);
    }
    return {version:release.tag_name,url:asset.browser_download_url,name:asset.name};
}

async function imageBackendCandidate(backend, platform, signal) {
    if (backend !== 'auto') return backend;
    if (platform === 'darwin') return 'metal';
    // This selects a distribution candidate. The worker probes actual devices.
    return 'cpu';
}

function imageAssetSuffix(platform, architecture, backend) {
    if (platform === 'win32' && architecture === 'x64') {
        if (backend === 'cpu') return '-bin-win-cpu-x64.zip';
    }
    if (platform === 'linux' && architecture === 'x64') {
        if (backend === 'cpu') return '-bin-Linux-Ubuntu-24.04-x86_64.zip';
    }
    if (platform === 'darwin' && ['x64', 'arm64'].includes(architecture) && ['metal', 'cpu'].includes(backend)) {
        // This upstream archive contains the universal arm64/x86_64 build.
        return '-bin-Darwin-macOS-26.6.2-arm64.zip';
    }
    return null;
}

async function selectImageRelease(runtime, platform, architecture, signal) {
    const backend = runtime.url ? runtime.backend : await imageBackendCandidate(runtime.backend, platform, signal);
    if (runtime.url) {
        return {
            version: runtime.version,
            backend: runtime.backend,
            assets: [
                {
                    backend,
                    url: runtime.url,
                    name: path.posix.basename(new URL(runtime.url).pathname)
                }
            ],
            sharedCPU: backend === 'auto'
        };
    }
    const selection = runtime.version === 'latest' ? 'latest' : `tags/${encodeURIComponent(runtime.version)}`;
    const response = await upstreamResponse(`https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/${selection}`, signal);
    const release = await response.json();
    const backends = backend === 'cpu' || platform === 'darwin' ? [backend] : [backend, 'cpu'];
    const assets = backends.map(
        function selectImageArchive(selectedBackend) {
            const suffix = imageAssetSuffix(platform, architecture, selectedBackend);
            const asset = suffix && release.assets?.find(
                function matchingImageArchive(candidate) {
                    return candidate.name.endsWith(suffix);
                }
            );
            if (!asset) {
                throw new ArcaneError(ERROR_CODES.targetUnavailable, `stable-diffusion.cpp ${release.tag_name} has no selected ${platform}/${architecture} ${selectedBackend} archive.`);
            }
            const selected = {backend: selectedBackend, url: asset.browser_download_url, name: asset.name};
            return selected;
        }
    );
    return {version: release.tag_name, backend: runtime.backend, assets, sharedCPU: backend === 'metal'};
}

async function imageLibraryPath(root, platform, signal) {
    const filename = platform === 'win32' ? 'stable-diffusion.dll' : platform === 'darwin' ? 'libstable-diffusion.dylib' : 'libstable-diffusion.so';
    const directories = [root];
    for (const directory of directories) {
        throwIfAborted(signal);
        const entries = await readdir(
            directory,
            {withFileTypes: true}
        );
        for (const entry of entries) {
            const selected = path.join(directory, entry.name);
            if (entry.name === filename && (entry.isFile() || entry.isSymbolicLink())) return selected;
            if (entry.isDirectory()) directories.push(selected);
        }
    }
    throw new ArcaneError(ERROR_CODES.operationFailed, `The stable-diffusion.cpp archive does not contain ${filename}.`);
}

async function extractImageAsset(asset, root, signal, onEvent) {
    const parent = path.dirname(root);
    const archive = path.join(parent, asset.name);
    await onEvent(
        {
            type: 'local-ai.install.downloading',
            message: `Downloading ${asset.name}.`,
            data: {id: 'stable-diffusion.cpp', asset: asset.name}
        }
    );
    const response = await upstreamResponse(asset.url, signal);
    await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(
            archive,
            {flags: 'wx'}
        ),
        {signal}
    );
    await onEvent(
        {
            type: 'local-ai.install.extracting',
            message: `Extracting ${asset.name}.`,
            data: {id: 'stable-diffusion.cpp', asset: asset.name}
        }
    );
    await extractLocalAIArchive(
        {archive, directory: root, signal, onEvent}
    );
    await unlink(archive);
}

async function installImageBinding(root, directory, platform, architecture, signal, onEvent) {
    const prefix = path.join(root, 'binding');
    await mkdir(
        prefix,
        {recursive: true}
    );
    await writeFile(
        path.join(prefix, 'package.json'),
        '{"private":true}\n',
        {flag: 'wx', signal}
    );
    await onEvent(
        {
            type: 'local-ai.install.installing',
            message: `Installing koffi 3.3.2 for ${platform}/${architecture}.`,
            data: {id: 'stable-diffusion.cpp', package: 'koffi', version: '3.3.2', platform, architecture}
        }
    );
    await runProcess(
        'npm',
        [
            'install', '--prefix', prefix, '--global=false', '--save-exact',
            '--omit=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund',
            '--registry=https://registry.npmjs.org/', '--cache', path.join(directory, 'npm-cache'),
            `--os=${platform}`, `--cpu=${architecture}`, 'koffi@3.3.2'
        ],
        {cwd: prefix, signal, onEvent}
    );
    const packagePath = path.join(prefix, 'package.json');
    const bindingModulePath = createRequire(packagePath).resolve('koffi');
    const platformPackagePath = path.join(prefix, 'node_modules', '@koromix', `koffi-${platform}-${architecture}`, 'package.json');
    await stat(platformPackagePath);
    return bindingModulePath;
}

async function installImageDistribution(release, {root, directory, platform, architecture, signal, onEvent}) {
    await mkdir(
        root,
        {recursive: true}
    );
    const jobs = release.assets.map(
        async function prepareImageVariant(asset) {
            const variantRoot = path.join(root, asset.backend);
            await extractImageAsset(asset, variantRoot, signal, onEvent);
            const libraryPath = await imageLibraryPath(variantRoot, platform, signal);
            return {backend: asset.backend, root: variantRoot, libraryPath};
        }
    );
    const bindingJob = installImageBinding(root, directory, platform, architecture, signal, onEvent);
    jobs.push(bindingJob);
    const outcomes = await Promise.allSettled(jobs);
    const failures = outcomes.filter(
        function imagePreparationFailed(outcome) {
            return outcome.status === 'rejected';
        }
    );
    if (failures.length === 1) throw failures[0].reason;
    if (failures.length > 1) {
        throw new AggregateError(
            failures.map(
                function imagePreparationError(outcome) {
                    return outcome.reason;
                }
            ),
            'Local image runtime preparation failed.'
        );
    }
    const bindingModulePath = outcomes.pop().value;
    const variants = outcomes.map(
        function preparedImageVariant(outcome) {
            return outcome.value;
        }
    );
    if (release.sharedCPU) {
        variants.push(
            {...variants[0], backend: 'cpu'}
        );
    }
    return {
        version: release.version,
        backend: release.backend,
        libraryPath: variants[0].libraryPath,
        bindingModulePath,
        variants
    };
}

function imageModelRecords(models) {
    return models.map(
        function preparedImageModel(model) {
            const resources = {};
            for (const [role, resource] of Object.entries(model.resources)) {
                const location = is.string(resource) ? resource : resource?.path;
                resources[role] = is.string(location) ? path.resolve(location) : resource;
            }
            return {...model, resources};
        }
    );
}

function bundledImagePath(location, runtimeRoot, relativeRoot) {
    const relative = path.relative(runtimeRoot, location);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        // The model resource owner reports external-path incompatibility.
        return location;
    }
    return path.posix.join(relativeRoot, relative.split(path.sep).join('/'));
}

function bundledImageModelResource(resource, descriptor, model, role, runtimeRoot, relativeRoot) {
    if (descriptor && !is.string(descriptor) && is.string(descriptor.url)) {
        // A portable descriptor selects its original URL for post-launch asset
        // preparation rather than carrying this host's working projection.
        const portable = {...descriptor};
        delete portable.path;
        return portable;
    }
    if (!is.string(resource)) return resource;
    const bundled = bundledImagePath(resource, runtimeRoot, relativeRoot);
    if (bundled === resource) {
        throw new ArcaneError(
            ERROR_CODES.usage,
            `Image model ${model.id} resource ${role} is an external native working path and is not portable in this runtime bundle. Prepare it through modelAssets after launch or include it through the explicit nativeResources workflow.`
        );
    }
    return bundled;
}

async function installedRuntime(base,runtime,platform,architecture,signal){
    let entries;
    try{
        entries=await readdir(base,{withFileTypes:true});
    }catch(error){
        if(error.code==='ENOENT')return null;
        throw error;
    }
    const imageBackend = runtime.id === 'stable-diffusion.cpp' && !runtime.url
        ? await imageBackendCandidate(runtime.backend, platform, signal)
        : runtime.backend;
    for(const entry of entries){
        throwIfAborted(signal);
        if(!entry.isDirectory())continue;
        let installation;
        try{
            installation=JSON.parse(await readFile(path.join(base,entry.name,'installation.json'),{encoding:'utf8',signal}));
        }catch(error){
            if(error.code==='ENOENT'||error instanceof SyntaxError)continue;
            throw error;
        }
        if(installation.requestVersion!==(runtime.version??null)||installation.requestUrl!==(runtime.url??null))continue;
        if (runtime.id === 'stable-diffusion.cpp' && installation.requestBackend !== runtime.backend) continue;
        const record=installation.runtime;
        if(record?.id!==runtime.id||record.platform!==platform||record.architecture!==architecture)continue;
        try{
            if (runtime.id === 'stable-diffusion.cpp') {
                const locations = [record.libraryPath, record.bindingModulePath];
                if (!Array.isArray(record.variants) || record.variants.length === 0) continue;
                if (record.variants[0].backend !== imageBackend) continue;
                for (const variant of record.variants) locations.push(variant.libraryPath);
                const missingLocation = locations.some(
                    function missingImageLocation(location) {
                        return !is.string(location);
                    }
                );
                if (missingLocation) continue;
                const platformPackagePath = path.join(record.root, 'binding', 'node_modules', '@koromix', `koffi-${platform}-${architecture}`, 'package.json');
                locations.push(platformPackagePath);
                const entries = await Promise.all(
                    locations.map(
                        function inspectImageLocation(location) {
                            return stat(location);
                        }
                    )
                );
                const filesPresent = entries.every(
                    function imageFilePresent(info) {
                        return info.isFile();
                    }
                );
                if (filesPresent) return record;
                continue;
            }
            if(runtime.id==='onnx'){
                if(!is.string(record.root)||!is.string(record.modulePath))continue;
                const locations=await onnxRuntimeModule(record.root,platform,architecture,signal);
                return {...record,...locations,...(runtime.version?{requestedVersion:runtime.version}:{})};
            }
            if(runtime.id==='nemo-speech'){
                const directories=[record.root,record.includeDirectory,record.libraryDirectory,record.binaryDirectory,record.cmakeDirectory];
                if(directories.some(function missingDirectory(directory){return !is.string(directory);}))continue;
                const files=[path.join(record.includeDirectory,'nemo_speech','diar.h'),path.join(record.includeDirectory,'nemo_speech','asr.h'),path.join(record.cmakeDirectory,'NeMoSpeechConfig.cmake')];
                const entries=await Promise.all([...directories,...files].map(function inspectRuntimePath(location){return stat(location);}));
                if(entries.every(function runtimePathPresent(info,index){return index<directories.length?info.isDirectory():info.isFile();})){
                    return {...record,...(runtime.version?{requestedVersion:runtime.version}:{})};
                }
                continue;
            }
            if((await stat(record.executable)).isFile())return {...record,...(runtime.version?{requestedVersion:runtime.version}:{})};
        }catch(error){
            if(runtime.id==='onnx'&&(error.code==='MODULE_NOT_FOUND'||error instanceof SyntaxError))continue;
            if(error.code!=='ENOENT')throw error;
        }
    }
    return null;
}

async function runtimeExecutable(root,id,platform,signal){
    const filename=`${id==='llama.cpp'?'llama-server':'ollama'}${platform==='win32'?'.exe':''}`;
    const directories=[root];
    for(const directory of directories){
        throwIfAborted(signal);
        const entries=await readdir(directory,{withFileTypes:true});
        for(const entry of entries){
            const selected=path.join(directory,entry.name);
            if(entry.name===filename&&(entry.isFile()||entry.isSymbolicLink()))return selected;
            if(entry.isDirectory())directories.push(selected);
        }
    }
    throw new ArcaneError(ERROR_CODES.operationFailed,`The ${id} archive does not contain ${filename}.`);
}

async function nemoRuntimeDirectories(root,signal){
    const directories=[root];
    for(const directory of directories){
        throwIfAborted(signal);
        const entries=await readdir(directory,{withFileTypes:true});
        for(const entry of entries){
            if(entry.isDirectory())directories.push(path.join(directory,entry.name));
        }
        if(path.basename(directory)!=='nemo_speech'||path.basename(path.dirname(directory))!=='include')continue;
        const headers=['diar.h','asr.h'];
        if(!headers.every(function headerPresent(name){
            return entries.some(function matchingHeader(entry){return entry.name===name&&(entry.isFile()||entry.isSymbolicLink());});
        }))continue;
        const includeDirectory=path.dirname(directory);
        const prefix=path.dirname(includeDirectory);
        const children=await readdir(prefix,{withFileTypes:true});
        const binaryDirectory=path.join(prefix,'bin');
        if(!(await stat(binaryDirectory)).isDirectory()){
            throw new ArcaneError(ERROR_CODES.operationFailed,'The NeMo Speech archive does not contain its installed binary directory.');
        }
        const candidates=children.filter(function libraryDirectory(entry){
            return ['lib','lib64'].includes(entry.name)&&(entry.isDirectory()||entry.isSymbolicLink());
        }).map(function librarySearch(entry){
            const libraryDirectory=path.join(prefix,entry.name);
            return {directory:libraryDirectory,libraryDirectory};
        });
        for(const candidate of candidates){
            throwIfAborted(signal);
            const entries=await readdir(candidate.directory,{withFileTypes:true});
            if(entries.some(function packageConfiguration(entry){
                return entry.name==='NeMoSpeechConfig.cmake'&&(entry.isFile()||entry.isSymbolicLink());
            })){
                return {includeDirectory,libraryDirectory:candidate.libraryDirectory,binaryDirectory,cmakeDirectory:candidate.directory};
            }
            for(const entry of entries){
                if(entry.isDirectory())candidates.push({directory:path.join(candidate.directory,entry.name),libraryDirectory:candidate.libraryDirectory});
            }
        }
        throw new ArcaneError(ERROR_CODES.operationFailed,'The NeMo Speech archive does not contain its installed NeMoSpeech CMake package.');
    }
    throw new ArcaneError(ERROR_CODES.operationFailed,'The NeMo Speech archive does not contain include/nemo_speech/diar.h and asr.h.');
}

async function onnxRuntimeModule(root,platform,architecture,signal){
    throwIfAborted(signal);
    const packageDirectory=path.join(root,'node_modules','onnxruntime-node');
    const metadata=JSON.parse(await readFile(path.join(packageDirectory,'package.json'),{encoding:'utf8',signal}));
    // Node resolves the installed public entry without loading its native code.
    const modulePath=createRequire(path.join(root,'package.json')).resolve('onnxruntime-node');
    const binding=path.join(packageDirectory,'bin','napi-v6',platform,architecture,'onnxruntime_binding.node');
    const entries=await Promise.all([modulePath,binding].map(function inspectONNXFile(filename){return stat(filename);}));
    if(!entries.every(function onnxFilePresent(info){return info.isFile();})){
        throw new ArcaneError(ERROR_CODES.operationFailed,`The ONNX package does not contain its public module and ${platform}/${architecture} native binding.`);
    }
    throwIfAborted(signal);
    return {version:metadata.version,modulePath};
}

async function installONNXPackage(runtime,{root,directory,platform,architecture,signal,onEvent}){
    const version=runtime.version??'1.30.0';
    await onEvent({type:'local-ai.install.installing',message:`Installing onnxruntime-node ${version} for ${platform}/${architecture}.`,data:{id:runtime.id,version,platform,architecture}});
    await mkdir(root,{recursive:true});
    await writeFile(path.join(root,'package.json'),'{"private":true}\n',{flag:'wx',signal});
    await runProcess('npm',[
        'install','--prefix',root,'--global=false','--save-exact','--omit=dev',
        '--no-audit','--no-fund','--foreground-scripts','--registry=https://registry.npmjs.org/',
        '--cache',path.join(directory,'npm-cache'),`onnxruntime-node@${runtime.url??version}`
    ],{cwd:root,env:{ONNXRUNTIME_NODE_INSTALL:'skip'},signal,onEvent});
    return onnxRuntimeModule(root,platform,architecture,signal);
}

async function installRuntime(runtime,{directory,platform,architecture,signal,onEvent}){
    const runtimeBase=path.join(directory,runtime.id,`${platform}-${architecture}`,encodeURIComponent(runtime.version??'default'));
    const base=runtime.id==='stable-diffusion.cpp'?path.join(runtimeBase,runtime.backend):runtimeBase;
    await onEvent({type:'local-ai.install.starting',message:`Preparing ${runtime.id} for ${platform}/${architecture}.`,data:{id:runtime.id,platform,architecture}});
    const installed=await installedRuntime(base,runtime,platform,architecture,signal);
    if(installed){
        await onEvent({type:'local-ai.install.available',message:`${runtime.id} ${installed.version} is already installed.`,data:installed});
        return installed;
    }
    if(runtime.id==='onnx'&&(!['win32','linux','darwin'].includes(platform)||!['x64','arm64'].includes(architecture))){
        throw new ArcaneError(ERROR_CODES.targetUnavailable,`onnxruntime-node has no supported ${platform}/${architecture} CPU runtime.`);
    }
    const release=runtime.id==='onnx'?null:await selectRelease(runtime,platform,architecture,signal);
    throwIfAborted(signal);
    await mkdir(base,{recursive:true});
    const attempt=await mkdtemp(path.join(base,'install-'));
    const root=path.join(attempt,'runtime');
    const archive=release&&runtime.id!=='stable-diffusion.cpp'?path.join(attempt,release.name):null;
    let completed=false;
    try{
        let locations;
        if(runtime.id==='onnx'){
            locations=await installONNXPackage(runtime,{root,directory,platform,architecture,signal,onEvent});
        } else if (runtime.id === 'stable-diffusion.cpp') {
            locations = await installImageDistribution(
                release,
                {root, directory, platform, architecture, signal, onEvent}
            );
        }else{
            await onEvent({type:'local-ai.install.downloading',message:`Downloading ${runtime.id} ${release.version}.`,data:{id:runtime.id,version:release.version,platform,architecture}});
            const response=await upstreamResponse(release.url,signal);
            await pipeline(Readable.fromWeb(response.body),createWriteStream(archive,{flags:'wx'}),{signal});
            await onEvent({type:'local-ai.install.extracting',message:`Extracting ${runtime.id} ${release.version}.`,data:{id:runtime.id,version:release.version}});
            await extractLocalAIArchive({archive,directory:root,signal,onEvent});
            locations={version:release.version,...(runtime.id==='nemo-speech'
                ?await nemoRuntimeDirectories(root,signal)
                :{executable:await runtimeExecutable(root,runtime.id,platform,signal)})};
        }
        const record={id:runtime.id,platform,architecture,root,...locations,...(runtime.version?{requestedVersion:runtime.version}:{})};
        throwIfAborted(signal);
        if(archive)await unlink(archive);
        await writeFile(path.join(attempt,'installation.json'),`${JSON.stringify({requestVersion:runtime.version??null,requestUrl:runtime.url??null,...(runtime.id==='stable-diffusion.cpp'?{requestBackend:runtime.backend}:{}),runtime:record},null,2)}\n`,{flag:'wx',signal});
        completed=true;
        await onEvent({type:'local-ai.install.completed',message:`${runtime.id} ${record.version} is available.`,data:record});
        return record;
    }catch(error){
        // Only this invocation's newly created incomplete attempt is removed.
        // Previously installed runtimes are never overwritten or retired here.
        if(!completed){
            try{
                await rm(attempt,{recursive:true,force:true});
            }catch(cleanupError){
                throw new AggregateError([error,cleanupError],`Installation of ${runtime.id} failed and its incomplete directory could not be removed.`);
            }
        }
        throw error;
    }
}

function shareInstallation(runtime,options){
    throwIfAborted(options.signal);
    const key=JSON.stringify([options.directory,options.platform,options.architecture,runtime.id,runtime.version??null,runtime.url??null,runtime.id==='stable-diffusion.cpp'?runtime.backend:null]);
    let entry=installations.get(key);
    if(entry?.controller.signal.aborted){
        // The prior cancelled attempt owns its cleanup. A later request waits
        // for that narrow shared destination operation before starting afresh.
        return entry.task.catch(function observeCancelledAttempt(){return undefined;}).then(function restartAfterCancellation(){
            return shareInstallation(runtime,options);
        });
    }
    if(!entry){
        entry={controller:new AbortController(),consumers:new Set(),task:null};
        installations.set(key,entry);
    }
    const current=entry;
    return new Promise(function subscribeInstallation(resolve,reject){
        let settled=false;
        const consumer={onEvent:options.onEvent,finish,cancel,cancelError:null};
        function finish(error,value){
            if(settled)return;
            settled=true;
            options.signal?.removeEventListener('abort',abort);
            current.consumers.delete(consumer);
            if(current.consumers.size===0&&!current.controller.signal.aborted){
                current.controller.abort(error);
            }
            if(consumer.cancelError)reject(consumer.cancelError);
            else if(error)reject(error);
            else resolve(value);
        }
        function abort(){
            cancel(new ArcaneError(ERROR_CODES.cancelled,`Cancelled preparation of ${runtime.id}.`,{cause:options.signal?.reason,exitCode:130}));
        }
        function cancel(error){
            if(settled)return;
            consumer.cancelError??=error;
            const hasOtherConsumer=[...current.consumers].some(function stillNeedsInstallation(subscriber){
                return subscriber!==consumer&&!subscriber.cancelError;
            });
            if(hasOtherConsumer){
                finish(consumer.cancelError);
            }else{
                // The last consumer stays joined until the download, extractor
                // and incomplete-output cleanup have actually stopped.
                current.controller.abort(consumer.cancelError);
            }
        }
        async function publish(event){
            await Promise.all([...current.consumers].map(async function sendConsumerEvent(subscriber){
                if(subscriber.cancelError)return;
                try{
                    await subscriber.onEvent(event);
                }catch(error){
                    subscriber.cancel(error);
                }
            }));
            throwIfAborted(current.controller.signal);
        }
        current.consumers.add(consumer);
        options.signal?.addEventListener('abort',abort,{once:true});
        if(options.signal?.aborted)abort();
        if(!current.task){
            current.task=installRuntime(runtime,{...options,signal:current.controller.signal,onEvent:publish});
            void current.task.then(function installationCompleted(record){
                installations.delete(key);
                for(const subscriber of [...current.consumers])subscriber.finish(null,record);
            },function installationFailed(error){
                installations.delete(key);
                for(const subscriber of [...current.consumers])subscriber.finish(normalizeError(error));
            });
        }
    });
}

export async function ensureLocalAIRuntimes({runtimes=[],directory,platform=process.platform,architecture=process.arch,signal,onEvent}={}){
    const selected=selectRuntimes(runtimes);
    if(selected.length===0)return [];
    const root=selectedDirectory(directory);
    const controller=new AbortController();
    const operationSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const events=createEventQueue(onEvent,{onFailure:function cancelFailedObserver(error){controller.abort(error);}});
    const startedAt=Date.now();
    const heartbeat=setInterval(function reportInstallHeartbeat(){
        void events.enqueue({type:'local-ai.install.heartbeat',message:'Local AI runtime preparation is active.',data:{elapsedMs:Date.now()-startedAt}},{coalesce:'local-ai.install.heartbeat'});
    },5000);
    heartbeat.unref?.();
    try{
        // There is one job per selected runtime. Independent runtime archives
        // download and extract concurrently; matching requests share that job.
        const outcomes=await Promise.allSettled(selected.map(function prepareRuntime(runtime){
            return shareInstallation(runtime,{directory:root,platform,architecture,signal:operationSignal,onEvent:events.send});
        }));
        await events.drain();
        const failures=outcomes.filter(function failedRuntime(outcome){return outcome.status==='rejected';});
        if(failures.length===1)throw failures[0].reason;
        if(failures.length>1)throw new AggregateError(failures.map(function runtimeFailure(outcome){return outcome.reason;}),'Local AI runtime preparation failed.');
        throwIfAborted(operationSignal);
        return outcomes.map(function completedRuntime(outcome,index){
            const record=outcome.value;
            if(record.id==='stable-diffusion.cpp')return {...record,models:imageModelRecords(selected[index].models)};
            return record;
        });
    }finally{
        clearInterval(heartbeat);
        await events.drain();
    }
}

async function copyRuntimeTree(source,destination,outputRoot,files,signal){
    throwIfAborted(signal);
    const info=await lstat(source);
    if(info.isDirectory()){
        await mkdir(destination);
        for(const entry of await readdir(source)){
            await copyRuntimeTree(path.join(source,entry),path.join(destination,entry),outputRoot,files,signal);
        }
        await chmod(destination,info.mode);
        return;
    }
    if(info.isSymbolicLink()){
        await symlink(await readlink(source),destination);
    }else{
        await copyFile(source,destination);
        await chmod(destination,info.mode);
    }
    files.push(path.relative(outputRoot,destination).split(path.sep).join('/'));
}

export async function bundleLocalAIRuntimes({runtimes=[],directory,outputRoot,platform=process.platform,architecture=process.arch,signal,onEvent}={}){
    const selected=selectRuntimes(runtimes);
    const root=selectedDirectory(outputRoot);
    for(const runtime of selected){
        const destination=path.join(root,'runtime','local-ai',runtime.id);
        try{
            await lstat(destination);
        }catch(error){
            if(error.code==='ENOENT')continue;
            throw error;
        }
        throw new ArcaneError(ERROR_CODES.operationFailed,`Local AI bundle destination already exists: ${destination}. Select a fresh native staging directory.`);
    }
    const installed=await ensureLocalAIRuntimes({runtimes:selected,directory,platform,architecture,signal,onEvent});
    if(installed.length===0)return {runtimes:[],files:[]};
    await onEvent?.({type:'local-ai.bundle.starting',message:'Copying selected local AI runtimes into the native bundle.',data:{platform,architecture,runtimes:selected.map(function runtimeId(runtime){return runtime.id;})}});
    await mkdir(path.join(root,'runtime','local-ai'),{recursive:true});
    const outcomes=await Promise.allSettled(installed.map(async function bundleRuntime(runtime){
        throwIfAborted(signal);
        const files=[];
        const relative=`runtime/local-ai/${runtime.id}`;
        const destination=path.join(root,relative);
        const bundled={...runtime,root:relative};
        for(const field of ['executable','modulePath','includeDirectory','libraryDirectory','binaryDirectory','cmakeDirectory','libraryPath','bindingModulePath']){
            if(runtime[field]===undefined)continue;
            bundled[field]=path.posix.join(relative,path.relative(runtime.root,runtime[field]).split(path.sep).join('/'));
        }
        if (runtime.id === 'stable-diffusion.cpp') {
            const requirement = selected.find(
                function selectedImageRequirement(candidate) {
                    return candidate.id === runtime.id;
                }
            );
            bundled.variants = runtime.variants.map(
                function bundledImageVariant(variant) {
                    return {
                        ...variant,
                        root: bundledImagePath(variant.root, runtime.root, relative),
                        libraryPath: bundledImagePath(variant.libraryPath, runtime.root, relative)
                    };
                }
            );
            bundled.models = runtime.models.map(
                function bundledImageModel(model, index) {
                    const resources = {};
                    for (const [role, resource] of Object.entries(model.resources)) {
                        resources[role] = bundledImageModelResource(
                            resource,
                            requirement.models[index].resources[role],
                            model,
                            role,
                            runtime.root,
                            relative
                        );
                    }
                    return {...model, resources};
                }
            );
        }
        await copyRuntimeTree(runtime.root,destination,root,files,signal);
        return {runtime:bundled,files};
    }));
    const failures=outcomes.filter(function failedBundle(outcome){return outcome.status==='rejected';});
    if(failures.length===1)throw failures[0].reason;
    if(failures.length>1)throw new AggregateError(failures.map(function bundleFailure(outcome){return outcome.reason;}),'Local AI runtime bundling failed.');
    const records=outcomes.map(function bundledRecord(outcome){return outcome.value.runtime;});
    const files=outcomes.flatMap(function bundledFiles(outcome){return outcome.value.files;});
    await onEvent?.({type:'local-ai.bundle.completed',message:'Selected local AI runtimes are included in the native bundle.',data:{platform,architecture,files}});
    return {runtimes:records,files};
}

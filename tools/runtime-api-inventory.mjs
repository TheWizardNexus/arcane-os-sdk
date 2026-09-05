import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtimeRoot=path.join(repositoryRoot,'runtime');
const moduleRoot=path.join(runtimeRoot,'arcane','modules');
const entityRoot=path.join(runtimeRoot,'arcane','entities');
const componentRoot=path.join(runtimeRoot,'arcane','components');
const strongTypePath=path.join(runtimeRoot,'strong-type','index.js');
const missingStrongTypePath=path.join(
    runtimeRoot,
    'node_modules',
    'strong-type',
    'index.js'
);
const runtimePackageImports=new Map([
    ['arcane-os/event-manager',path.join(repositoryRoot,'src','event-manager.mjs')],
    ['arcane-os/speech-text',path.join(repositoryRoot,'browser-runtime','speech-text.mjs')],
    [
        'arcane-os/ai/browser-speech',
        path.join(repositoryRoot,'browser-runtime','ai','browser-speech.mjs')
    ]
]);
const runtimeExternalImports=new Set(['event-pubsub']);
function portablePath(filePath){
    return path.relative(repositoryRoot,filePath).split(path.sep).join('/');
}

async function filesIn(directory,{extensions=null}={}){
    const entries=await readdir(directory,{withFileTypes:true});
    const files=[];
    for(const entry of entries){
        const entryPath=path.join(directory,entry.name);
        if(entry.isDirectory())files.push(...await filesIn(entryPath,{extensions}));
        else if(entry.isFile()
            &&(extensions===null||extensions.has(path.extname(entryPath)))){
            files.push(entryPath);
        }
    }
    return files.sort(
        (left,right)=>portablePath(left).localeCompare(portablePath(right))
    );
}

function resolvedFile(specifier,identifier){
    const url=new URL(specifier,identifier);
    url.search='';
    url.hash='';
    const candidate=path.normalize(fileURLToPath(url));
    return candidate===path.normalize(missingStrongTypePath)
        ?strongTypePath
        :candidate;
}

export async function inspectRuntimeApi(){
    if(typeof vm.SourceTextModule!=='function'||typeof vm.SyntheticModule!=='function'){
        throw new Error(
            'Runtime API inspection requires Node --experimental-vm-modules.'
        );
    }

    const context=vm.createContext({});
    const records=new Map();
    const builtins=new Map();

    const builtinModule=async specifier=>{
        if(builtins.has(specifier))return builtins.get(specifier);
        const namespace=await import(specifier);
        const names=Object.keys(namespace);
        const module=new vm.SyntheticModule(
            names,
            function initializeBuiltin(){
                for(const name of names)this.setExport(name,namespace[name]);
            },
            {context,identifier:specifier}
        );
        builtins.set(specifier,module);
        return module;
    };

    const moduleRecord=async filePath=>{
        const normalized=path.normalize(filePath);
        if(records.has(normalized))return records.get(normalized);

        const source=await readFile(normalized,'utf8');
        const identifier=pathToFileURL(normalized).href;
        let module;
        let parseMode='module';
        try{
            module=new vm.SourceTextModule(source,{
                context,
                identifier,
                initializeImportMeta(meta){
                    meta.url=identifier;
                }
            });
        }catch(moduleError){
            try{
                new vm.Script(source,{filename:normalized});
            }catch{
                throw moduleError;
            }
            parseMode='classic-script';
            module=new vm.SyntheticModule([],()=>{}, {context,identifier});
        }

        const record={filePath:normalized,module,parseMode};
        records.set(normalized,record);
        return record;
    };

    const linker=async(specifier,referencingModule)=>{
        if(specifier.startsWith('node:'))return builtinModule(specifier);
        if(runtimeExternalImports.has(specifier))return builtinModule(specifier);
        if(runtimePackageImports.has(specifier)){
            return (await moduleRecord(runtimePackageImports.get(specifier))).module;
        }
        if(!specifier.startsWith('.')&&!specifier.startsWith('/')){
            throw new Error(
                `Unsupported runtime import ${JSON.stringify(specifier)} from ${referencingModule.identifier}.`
            );
        }
        return (await moduleRecord(
            resolvedFile(specifier,referencingModule.identifier)
        )).module;
    };

    const exportsFor=async filePath=>{
        const record=await moduleRecord(filePath);
        if(record.module.status==='unlinked')await record.module.link(linker);
        const exports=Reflect.ownKeys(record.module.namespace)
            .filter(name=>typeof name==='string')
            .sort();
        return {exports,parseMode:record.parseMode};
    };

    const javascriptExtensions=new Set(['.js','.mjs']);
    const [moduleFiles,entityFiles,componentFiles]=await Promise.all([
        filesIn(moduleRoot,{extensions:javascriptExtensions}),
        filesIn(entityRoot,{extensions:javascriptExtensions}),
        filesIn(componentRoot,{extensions:new Set(['.html'])})
    ]);

    const inspectFiles=async filePaths=>{
        const inspected=[];
        for(const filePath of filePaths){
            const {exports,parseMode}=await exportsFor(filePath);
            inspected.push({
                file:portablePath(filePath),
                exports,
                parseMode
            });
        }
        return inspected;
    };

    const modules=await inspectFiles(moduleFiles);
    const entities=await inspectFiles(entityFiles);
    const support=[{
        file:portablePath(strongTypePath),
        ...await exportsFor(strongTypePath)
    }];
    const components=[];
    for(const filePath of componentFiles){
        const source=await readFile(filePath,'utf8');
        const scripts=[
            ...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)
        ];
        for(const [index,match] of scripts.entries()){
            const attributes=match[1];
            if(/(?:^|\s)src\s*=/iu.test(attributes)){
                throw new Error(
                    `External component scripts are unsupported: ${portablePath(filePath)} script ${String(index+1)}.`
                );
            }
            // HTMLImport executes every inline body inside an async function
            // embedded in a classic script, irrespective of its declarative
            // type attribute. Parse that exact executable grammar.
            new vm.Script(
                `(async function(){\n${match[2]}\n})`,
                {filename:`${filePath}#script-${String(index+1)}`}
            );
        }
        components.push({file:portablePath(filePath),scriptCount:scripts.length});
    }

    return {
        schemaVersion:1,
        modules,
        entities,
        support,
        components,
        parsedJavascriptCount:modules.length+entities.length+support.length,
        parsedComponentScriptCount:components.reduce(
            (count,component)=>count+component.scriptCount,
            0
        )
    };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
    process.stdout.write(`${JSON.stringify(await inspectRuntimeApi())}\n`);
}

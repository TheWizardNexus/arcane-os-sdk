import Is from 'strong-type';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';

const is=new Is(false);

// Direct routes use the installed npm paths in both the browser and selected output.
export function installedSdkRoutes(packageSource,{security=false,direct=false}={}){
    const routes=[
        {
            source:`${packageSource}/runtime/arcane`,destination:'arcane',
            include:['components','css','entities','img','modules',...(security?['security']:[])],exclude:[]
        },
        {
            source:`${packageSource}/browser-runtime`,destination:'arcane/sdk',
            include:['.'],exclude:[]
        },
        {
            source:`${packageSource}/runtime/strong-type`,destination:'arcane/dependencies/strong-type',
            include:['.'],exclude:[]
        },
        {
            source:packageSource,destination:'licenses/arcane-os',
            include:['LICENSE','COMMERCIAL-LICENSE.md','NOTICE'],exclude:[]
        }
    ];
    return direct?routes.map(route=>({...route,destination:route.source})):routes;
}

export function installedSdkPackageSource(config){
    const routes=config?.sharedPayloads?.['browser-runtime'];
    if(!is.array(routes)||routes.length!==4)return null;
    const source=routes[3]?.source;
    if(!is.string(source)||!/^node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u.test(source))return null;
    const expected=installedSdkRoutes(source,{
        security:routes[0]?.include?.at(-1)==='security',
        direct:routes[0]?.destination===routes[0]?.source
    });
    return routes.every(function matchesInstalledRoute(route,index){
        const wanted=expected[index];
        return route?.source===wanted.source&&route?.destination===wanted.destination
            &&is.array(route.include)&&route.include.length===wanted.include.length
            &&route.include.every(function matchesSelectedPath(value,item){return value===wanted.include[item];})
            &&(route.exclude===undefined||(is.array(route.exclude)&&route.exclude.length===0));
    })?source:null;
}

export async function readInstalledSdkLayout(workspaceRoot,config){
    if(config===undefined){
        try{config=JSON.parse(await readFile(path.join(workspaceRoot,'arcane-packager.json'),'utf8'));}
        catch(error){if(error.code==='ENOENT')return null;throw error;}
    }
    const packageSource=installedSdkPackageSource(config);
    if(packageSource===null)return null;
    const packageRoot=path.join(workspaceRoot,...packageSource.split('/'));
    const versionPath=path.join(packageRoot,'package.json');
    const manifest=JSON.parse(await readFile(versionPath,'utf8'));
    if(manifest.name!=='arcane-os'||!is.string(manifest.version)||!manifest.version){
        const error=new Error('The installed SDK runtime must identify its arcane-os package version.');
        error.code='ARCANE_WORKSPACE_INVALID';
        throw error;
    }
    const routes=config.sharedPayloads['browser-runtime'];
    return {
        packageSource,packageRoot,versionPath,version:manifest.version,routes,
        direct:routes[0].destination===routes[0].source,
        runtimeBase:`/${routes[0].destination}/`,
        browserRuntimeBase:`/${routes[1].destination}/`
    };
}

export async function installedRuntimeFiles(workspaceRoot,layout,signal){
    const files=[];
    async function visit(directory,logical){
        signal?.throwIfAborted();
        const entries=await readdir(directory,{withFileTypes:true});
        for(const entry of entries){
            signal?.throwIfAborted();
            const relative=logical?`${logical}/${entry.name}`:entry.name;
            if(entry.isDirectory())await visit(path.join(directory,entry.name),relative);
            else if(entry.isFile())files.push(relative);
        }
    }
    for(const [index,route] of layout.routes.entries()){
        if(index===3)continue;
        const prefix=['','sdk','dependencies/strong-type'][index];
        for(const selected of route.include){
            const suffix=selected==='.'?'':selected;
            await visit(
                path.join(workspaceRoot,...route.source.split('/'),suffix),
                [prefix,suffix].filter(Boolean).join('/')
            );
        }
    }
    return {files:files.sort()};
}

export function installedRuntimeTarget(relative,layout,{browser=false}={}){
    const logicalRoots=['arcane','arcane/sdk','arcane/dependencies/strong-type','licenses/arcane-os'];
    const routes=layout.routes.map((route,index)=>({...route,logical:logicalRoots[index]}));
    for(const route of routes.sort(function longestDestinationFirst(left,right){
        return right.logical.length-left.logical.length;
    })){
        if(!relative.startsWith(`${route.logical}/`))continue;
        const suffix=relative.slice(route.logical.length+1);
        if(route.include.some(function includesRuntimeTarget(selected){
            const pathname=suffix.split(/[?#]/u)[0];
            return selected==='.'||pathname===selected||pathname.startsWith(`${selected}/`);
        }))return `${browser?route.destination:route.source}/${suffix}`;
    }
    return relative;
}

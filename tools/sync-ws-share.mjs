import {copyFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Resolve from each installed owner so npm's nested dependency selection stays intact.
// Browser delivery copies the published runtime files unchanged; edit this generator,
// never the projected upstream implementations.
export async function syncWebSocketBrowserDependencies(){
    const wsEntry=fileURLToPath(import.meta.resolve('ws-share'));
    const eventEntry=createRequire(wsEntry).resolve('event-pubsub');
    const typeEntry=createRequire(eventEntry).resolve('strong-type');
    const destination=fileURLToPath(new URL('../browser-runtime/dependencies/',import.meta.url));
    const projections=[
        {entry:wsEntry,directory:'ws-share',files:['WS.js','package.json','licence.md']},
        {entry:eventEntry,directory:'event-pubsub',files:['index.js','package.json','licence']},
        {entry:typeEntry,directory:'event-pubsub/dependencies/strong-type',files:['index.js','package.json','licence']}
    ];
    await Promise.all(projections.map(async function copyPublishedDependency(projection){
        const target=path.join(destination,projection.directory);
        await mkdir(target,{recursive:true});
        await Promise.all(projection.files.map(function copyPublishedFile(name){
            return copyFile(path.join(path.dirname(projection.entry),name),path.join(target,name));
        }));
    }));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    await syncWebSocketBrowserDependencies();
}

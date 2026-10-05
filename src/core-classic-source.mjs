import {readFile} from 'node:fs/promises';

/**
 * Generate the native host's classic script from the canonical ESM client.
 * The two owned modules have declaration exports and two explicit imports;
 * this projection is deliberately not a general JavaScript bundler.
 */
export async function createCoreClassicSource({eventOwnerModuleURL}={}){
    if(typeof eventOwnerModuleURL!=='string'||!eventOwnerModuleURL){
        throw new TypeError('The classic Core client needs the served SDK event-manager module URL.');
    }
    const [contracts,client]=await Promise.all([
        readFile(new URL('../browser-runtime/core/contracts.mjs',import.meta.url),'utf8'),
        readFile(new URL('../browser-runtime/core/client.mjs',import.meta.url),'utf8')
    ]);
    const declarations=contracts.replace(/^export (?=(?:const|class|function) )/gmu,'');
    const implementation=client
        .replace("import {arcaneEvents} from '../event-manager.mjs';",'')
        .replace("import {CORE_PROTOCOL,CORE_READY_EVENTS,CoreError,serializeCoreError} from './contracts.mjs';",'')
        .replace(/^export (?=function )/gmu,'');
    return `(function installArcaneCoreClassic(global){
    'use strict';
    const arcaneEvents=global.arcaneEvents??null;
${declarations}
${implementation}
    if(global[CORE_CLIENT_KEY])return;
    function loadSharedEventOwner(){
        return import(${JSON.stringify(eventOwnerModuleURL)}).then(function sharedEventOwner(namespace){return namespace.arcaneEvents;});
    }
    // Document-created native injection precedes the page's managed import map.
    // Only the module import waits for parsing; facade/RPC setup below is immediate.
    const eventOwnerReady=arcaneEvents?Promise.resolve(arcaneEvents)
        :global.document?.readyState==='loading'
            ?new Promise(function afterImportMap(resolve,reject){
                global.document.addEventListener('DOMContentLoaded',function connectSharedEvents(){
                    loadSharedEventOwner().then(resolve,reject);
                },{once:true});
            })
            :loadSharedEventOwner();
    installCoreClient(global,{eventOwner:arcaneEvents,eventOwnerReady});
})(globalThis);
`;
}

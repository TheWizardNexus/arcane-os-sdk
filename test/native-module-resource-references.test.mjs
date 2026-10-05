import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {rewriteAssetReferences,rewriteNativeJavaScript} from '../src/import-map.mjs';

function rewrite(source){
    const references=[];
    const output=rewriteNativeJavaScript(source,function resolveReference(reference){
        references.push(reference);
        return reference.url.startsWith('/')?`.${reference.url}`:reference.url;
    });
    return {output,references};
}

test('native resource rewriting preserves locally declared resource-call payloads',function localDeclarations(){
    const sources=[
        "const fetch=value=>value; export const saved=fetch('/data.json');",
        "const fetch=value=>value; export const saved=fetch('/data.svg');",
        "let harmless=1,fetch=value=>value; fetch('/data.svg');",
        "function fetch(value){return value;} fetch('/data.svg');",
        "fetch('/data.svg'); function fetch(value){return value;}",
        "const URL=class {}; new URL('/data.svg',import.meta.url);",
        "class Worker {} new Worker('/worker.js');",
        "function SharedWorker(value){this.value=value;} new SharedWorker('/worker.js');",
        "var importScripts=value=>value; importScripts('/first.js','/second.js');",
        "const {fetch,api:{URL},worker:Worker}=owner; fetch('/data.svg'); new URL('/data.svg',import.meta.url); new Worker('/worker.js');",
        "const [fetch,...importScripts]=owner; fetch('/data.svg'); importScripts('/worker.js');",
        "const {['fetch']:fetch}=owner; fetch('/data.svg');"
    ];
    for(const source of sources){
        const result=rewrite(source);
        assert.equal(result.output,source);
        assert.deepEqual(result.references,[]);
    }
});

test('native resource rewriting distinguishes function and block bindings from actual globals',function scopedReferences(){
    const cases=[
        [
            "function keep(fetch){return fetch('/local.svg');} fetch('/global.svg');",
            "function keep(fetch){return fetch('/local.svg');} fetch('./global.svg');"
        ],
        [
            "const keep=fetch=>fetch('/local.svg'); fetch('/global.svg');",
            "const keep=fetch=>fetch('/local.svg'); fetch('./global.svg');"
        ],
        [
            "const keep=({fetch:request,api:{fetch}})=>fetch('/local.svg'); fetch('/global.svg');",
            "const keep=({fetch:request,api:{fetch}})=>fetch('/local.svg'); fetch('./global.svg');"
        ],
        [
            "const keep=(fetch)=>{return fetch('/local.svg');}; fetch('/global.svg');",
            "const keep=(fetch)=>{return fetch('/local.svg');}; fetch('./global.svg');"
        ],
        [
            "const tools={keep(fetch){return fetch('/local.svg');}}; fetch('/global.svg');",
            "const tools={keep(fetch){return fetch('/local.svg');}}; fetch('./global.svg');"
        ],
        [
            "class Tools{['keep'](fetch){return fetch('/local.svg');}} fetch('/global.svg');",
            "class Tools{['keep'](fetch){return fetch('/local.svg');}} fetch('./global.svg');"
        ],
        [
            "{const fetch=value=>value;fetch('/local.svg');} fetch('/global.svg');",
            "{const fetch=value=>value;fetch('/local.svg');} fetch('./global.svg');"
        ],
        [
            "function keep(){if(owner){var fetch=value=>value;}return fetch('/local.svg');}fetch('/global.svg');",
            "function keep(){if(owner){var fetch=value=>value;}return fetch('/local.svg');}fetch('./global.svg');"
        ],
        [
            "try{work();}catch(fetch){fetch('/local.svg');}fetch('/global.svg');",
            "try{work();}catch(fetch){fetch('/local.svg');}fetch('./global.svg');"
        ],
        [
            "const {fetch:request}=owner;fetch('/global.svg');",
            "const {fetch:request}=owner;fetch('./global.svg');"
        ]
    ];
    for(const [source,expected] of cases)assert.equal(rewrite(source).output,expected);
});

test('native resource rewriting preserves imported local bindings and qualified local roots',function importedBindings(){
    const sources=[
        "import fetch from './provider.mjs';fetch('/data.svg');",
        "import {request as fetch} from './provider.mjs';fetch('/data.svg');",
        "import {fetch,URL,Worker,SharedWorker,importScripts} from './provider.mjs';fetch('/data.svg');new URL('/data.svg',import.meta.url);new Worker('/worker.js');new SharedWorker('/shared.js');importScripts('/script.js');",
        "import * as window from './provider.mjs';window.fetch('/data.svg');",
        "import {provider as globalThis} from './provider.mjs';new globalThis.Worker('/worker.js');",
        "const self=provider;self.importScripts('/script.js');",
        "function keep(window){return window.fetch('/data.svg');}",
        "const keep=globalThis=>new globalThis.URL('/data.svg',import.meta.url);"
    ];
    for(const source of sources){
        const result=rewrite(source);
        assert.equal(result.output,source);
        assert.equal(result.references.every(function importOnly(reference){
            return reference.kind==='import';
        }),true);
    }
    const aliased="import {fetch as request} from './provider.mjs';fetch('/global.svg');";
    assert.equal(rewrite(aliased).output,
        "import {fetch as request} from './provider.mjs';fetch('./global.svg');");
});

test('native resource rewriting keeps actual global APIs and unrelated local names distinct',function globalResources(){
    const source=[
        "fetch('/data.svg');",
        "globalThis.fetch('/global.svg');",
        "window.fetch('/window.svg');",
        "self.fetch('/self.svg');",
        "new URL('/asset.svg',import.meta.url);",
        "new Worker('/worker.js');",
        "new SharedWorker('/shared.js');",
        "importScripts('/first.js','/second.js');",
        "new globalThis.URL('/qualified.svg',document.baseURI);"
    ].join('\n');
    const expected=[
        "fetch('./data.svg');",
        "globalThis.fetch('./global.svg');",
        "window.fetch('./window.svg');",
        "self.fetch('./self.svg');",
        "new URL('./asset.svg',import.meta.url);",
        "new Worker('./worker.js');",
        "new SharedWorker('./shared.js');",
        "importScripts('./first.js','./second.js');",
        "new globalThis.URL('./qualified.svg',document.baseURI);"
    ].join('\n');
    assert.equal(rewrite(source).output,expected);
    const qualified="const fetch=value=>value;fetch('/payload.svg');globalThis.fetch('/actual.svg');";
    assert.equal(rewrite(qualified).output,
        "const fetch=value=>value;fetch('/payload.svg');globalThis.fetch('./actual.svg');");
});

test('native URL references preserve locally owned document and location bases',function localBases(){
    const sources=[
        "const document={baseURI:'https://elsewhere.test/'};new URL('/data.svg',document.baseURI);",
        "const location={href:'https://elsewhere.test/'};new URL('/data.svg',location.href);",
        "function keep(window){return new URL('/data.svg',window.location.href);}",
        "function keep(globalThis){return new URL('/data.svg',globalThis.document.baseURI);}",
        "const keep=self=>new URL('/data.svg',self.location.href);"
    ];
    for(const source of sources)assert.equal(rewrite(source).output,source);
    const grammarOwned="const document={baseURI:'https://elsewhere.test/'};new URL('/data.svg',import.meta.url);";
    assert.equal(rewrite(grammarOwned).output,
        "const document={baseURI:'https://elsewhere.test/'};new URL('./data.svg',import.meta.url);");
});

test('native import.meta.resolve recognition excludes application property chains',function importMetaOwnership(){
    const source=[
        "object.import.meta.resolve('/payload.svg');",
        "object?.import.meta.resolve('/optional.svg');",
        "'import'.meta.resolve('/string.svg');",
        "import.meta.resolve('/actual.mjs');"
    ].join('\n');
    const expected=[
        "object.import.meta.resolve('/payload.svg');",
        "object?.import.meta.resolve('/optional.svg');",
        "'import'.meta.resolve('/string.svg');",
        "import.meta.resolve('./actual.mjs');"
    ].join('\n');
    assert.equal(rewrite(source).output,expected);
});

test('browser resource cleanup preserves the same local payload boundary',function browserPayloadOwnership(){
    const source="const fetch=value=>value;fetch('/data.svg?arcaneVersion=authored&value=complete');globalThis.fetch('/actual.svg?arcaneVersion=old&value=complete');";
    const references=[];
    const output=rewriteAssetReferences(source,{
        filePath:'fixture.mjs',
        onReference:function recordReference(reference){references.push(reference);}
    });
    assert.equal(output,"const fetch=value=>value;fetch('/data.svg?arcaneVersion=authored&value=complete');globalThis.fetch('/actual.svg?value=complete');");
    assert.deepEqual(references.map(function referenceUrl(reference){return reference.url;}),[
        '/actual.svg?arcaneVersion=old&value=complete'
    ]);
});

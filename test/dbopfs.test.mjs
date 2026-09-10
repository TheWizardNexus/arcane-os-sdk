import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import test from '../src/testing.mjs';

const repositoryRoot=new URL('../',import.meta.url);

test(
    'file manager initializes its tree provider before immediate or deferred storage readiness',
    async function testFileManagerStorageReadiness() {
        const source = await readFile(
            new URL('runtime/arcane/components/file-manager.html', repositoryRoot),
            'utf8'
        );
        const script = source.match(/<script type="module">([\s\S]*?)<\/script>/u);
        assert.ok(script, 'Exercise the complete component script in source order.');
        const AsyncFunction = Object.getPrototypeOf(async function componentScript() {}).constructor;
        const runComponent = new AsyncFunction(
            'window', 'document', 'dbopfs', 'importModule',
            script[1].replaceAll('import(', 'importModule(')
        );

        class ComponentElement extends EventTarget {
            constructor() {
                super();
                this.children = [];
                this.attributes = new Map();
            }

            append(...children) {
                this.children.push(...children);
            }

            replaceChildren(...children) {
                this.children = children;
            }

            setAttribute(name, value) {
                this.attributes.set(name, String(value));
            }
        }

        for (const mode of ['already-ready', 'ready-event', 'custom-provider']) {
            const storageRequests = [];
            const providerRequests = [];
            const publications = [];
            const failures = [];
            const dbopfs = {
                ready: mode === 'already-ready',
                async getTableNames(includeAll) {
                    storageRequests.push(includeAll);
                    return [];
                }
            };
            const window = new EventTarget();
            window.dbopfs = dbopfs;
            const fileManager = new ComponentElement();
            const elements = new Map(
                [
                    ['.file-manager', fileManager],
                    ['style', new ComponentElement()],
                    ['#fileUpload', new ComponentElement()],
                    ['#directoryModal', new ComponentElement()],
                    ['#fileModal', new ComponentElement()],
                    ['#deleteModal', new ComponentElement()]
                ]
            );
            const host = {
                dataset: {layout: 'tree'},
                shadowRoot: {
                    querySelector(selector) {
                        return elements.get(selector);
                    }
                },
                getAttribute(name) {
                    return name === 'href' ? './file-manager.html' : null;
                },
                hasAttribute() {
                    return false;
                }
            };
            const document = {
                baseURI: 'https://file-manager.example/',
                createElement() {
                    return new ComponentElement();
                }
            };
            const initialization = Promise.withResolvers();
            const eventSource = {
                descriptor: {instanceId: mode},
                dispatch(name, detail) {
                    publications.push({name, detail});
                    if (name === 'file-manager-ready') {
                        initialization.resolve();
                    }
                    return {accepted: true, occurrence: {type: name, detail}};
                },
                dispose() {}
            };

            async function importModule(specifier) {
                switch (specifier) {
                    case 'strong-type':
                        return import('strong-type');
                    case 'arcane-os/logging':
                        return {
                            arcaneLogging: {
                                error(message, error) {
                                    failures.push({message, error});
                                    initialization.resolve();
                                }
                            }
                        };
                    case 'arcane-os/event-manager':
                        return {
                            createArcaneEventSource() {return eventSource;},
                            projectArcaneDOMEvent() {}
                        };
                    case '../modules/WaitForComponent.js':
                        return {default: async function waitForComponent() {}};
                    case '../modules/DBOPFS.js':
                    case '../entities/File.js':
                        return {};
                    default:
                        assert.fail(`Unexpected component import: ${specifier}`);
                }
            }

            try {
                await runComponent.call(host, window, document, dbopfs, importModule);
                if (mode !== 'already-ready') {
                    assert.equal(host.ready, false);
                    assert.deepEqual(storageRequests, []);
                    if (mode === 'custom-provider') {
                        await host.setProvider(
                            {
                                async list(path) {
                                    providerRequests.push(path);
                                    return [];
                                }
                            }
                        );
                    } else {
                        dbopfs.ready = true;
                        window.dispatchEvent(new Event('dbopfs-ready'));
                    }
                }

                await initialization.promise;
                assert.deepEqual(failures, [], mode);
                assert.equal(host.ready, true, mode);
                assert.equal(fileManager.attributes.get('aria-busy'), 'false');
                assert.equal(fileManager.children[0].className, 'tree-root');
                assert.equal(fileManager.children[1].innerText, 'No files are available.');
                dbopfs.ready = true;
                window.dispatchEvent(new Event('dbopfs-ready'));
                assert.deepEqual(storageRequests, mode === 'custom-provider' ? [] : [true]);
                assert.deepEqual(providerRequests, mode === 'custom-provider' ? [''] : []);
                assert.deepEqual(
                    publications.map(function eventName(publication) {return publication.name;}),
                    ['file-manager-ready']
                );
            } finally {
                host.destroy();
            }
            assert.equal(host.ready, false);
            window.dispatchEvent(new Event('dbopfs-ready'));
            assert.deepEqual(storageRequests, mode === 'custom-provider' ? [] : [true]);
        }
    }
);

test(
    'DBOPFS creates only requested tables and preserves the memories directory alias',
    async function testDBOPFSLazyTableDirectories(){
        function missingEntry(name){
            const error=new Error(`Missing entry: ${name}`);
            error.name='NotFoundError';
            return error;
        }

        function nonEmptyEntry(name){
            const error=new Error(`Directory is not empty: ${name}`);
            error.name='InvalidModificationError';
            return error;
        }

        function mismatchedEntry(name){
            const error=new Error(`Entry is not a directory: ${name}`);
            error.name='TypeMismatchError';
            return error;
        }

        function createDirectory(name,initialDirectories=[]){
            const entries=new Map();
            const directoryRequests=[];
            const createdDirectories=[];

            for(const directory of initialDirectories){
                entries.set(directory.name,directory);
            }

            return {
                kind:'directory',
                name,
                createdDirectories,
                directoryRequests,
                async getDirectoryHandle(directoryName,{create=false}={}){
                    directoryRequests.push(directoryName);

                    if(entries.has(directoryName)){
                        const entry=entries.get(directoryName);

                        if(entry.kind!=='directory'){
                            throw mismatchedEntry(directoryName);
                        }

                        return entry;
                    }
                    if(!create){
                        throw missingEntry(directoryName);
                    }

                    const directory=createDirectory(directoryName);
                    entries.set(directoryName,directory);
                    createdDirectories.push(directoryName);
                    return directory;
                },
                async removeEntry(entryName,{recursive=false}={}){
                    const entry=entries.get(entryName);

                    if(!entry){
                        throw missingEntry(entryName);
                    }
                    if(
                        entry.kind==='directory'
                        &&entry.entryNames().length>0
                        &&!recursive
                    ){
                        throw nonEmptyEntry(entryName);
                    }

                    entries.delete(entryName);
                },
                async *entries(){
                    for(const entry of entries){
                        yield entry;
                    }
                },
                entryNames(){
                    return [...entries.keys()];
                }
            };
        }

        function restoreGlobalProperty(name,descriptor){
            if(descriptor){
                Object.defineProperty(globalThis,name,descriptor);
                return;
            }
            delete globalThis[name];
        }

        const memoryDirectory=createDirectory('memory');
        const existingProductDirectory=createDirectory('existing-product');
        const emptyRetiredDirectory=createDirectory('empty-retired');
        const populatedDirectory=createDirectory(
            'populated-product',
            [{kind:'file',name:'saved.json'}]
        );
        const sameNamedFile={kind:'file',name:'not-a-table'};
        const applicationDirectory=createDirectory(
            'dbopfs-lazy-table-test',
            [
                memoryDirectory,
                existingProductDirectory,
                emptyRetiredDirectory,
                populatedDirectory,
                sameNamedFile
            ]
        );
        const applicationsDirectory=createDirectory(
            'apps',
            [applicationDirectory]
        );
        const rootDirectory=createDirectory('root',[applicationsDirectory]);
        const documentObject={
            documentElement:{dataset:{}},
            querySelector(selector){
                if(selector!=='meta[name="arcane-app-id"]'){
                    return null;
                }
                return {
                    getAttribute(attribute){
                        return attribute==='content'
                            ?'dbopfs-lazy-table-test'
                            :null;
                    }
                };
            }
        };
        const windowTarget=new EventTarget();
        windowTarget.document=documentObject;
        const descriptors={
            document:Object.getOwnPropertyDescriptor(globalThis,'document'),
            navigator:Object.getOwnPropertyDescriptor(globalThis,'navigator'),
            window:Object.getOwnPropertyDescriptor(globalThis,'window')
        };

        Object.defineProperty(globalThis,'document',{
            configurable:true,
            value:documentObject,
            writable:true
        });
        Object.defineProperty(globalThis,'navigator',{
            configurable:true,
            value:{
                storage:{
                    async getDirectory(){
                        return rootDirectory;
                    },
                    async persist(){
                        return true;
                    }
                }
            },
            writable:true
        });
        Object.defineProperty(globalThis,'window',{
            configurable:true,
            value:windowTarget,
            writable:true
        });

        try{
            await import('../runtime/arcane/modules/DBOPFS.js?lazy-table-directories');
            const dbopfs=windowTarget.dbopfs;
            await dbopfs.readyPromise;

            assert.deepEqual(applicationDirectory.createdDirectories,[]);
            assert.deepEqual(await dbopfs.getTableNames(),[]);

            const [logicalMemory,physicalMemory]=await Promise.all([
                dbopfs.getTableHandle('memories'),
                dbopfs.getTableHandle('memory')
            ]);
            assert.equal(logicalMemory,memoryDirectory);
            assert.equal(physicalMemory,memoryDirectory);
            assert.equal(
                applicationDirectory.directoryRequests.filter(
                    function requestedMemory(name){
                        return name==='memory';
                    }
                ).length,
                1
            );
            assert.deepEqual(await dbopfs.getTableNames(),['memories']);
            assert.deepEqual(
                await dbopfs.getTableNames(true),
                [
                    'memory',
                    'existing-product',
                    'empty-retired',
                    'populated-product'
                ]
            );
            assert.deepEqual(
                await dbopfs.getTableNames(),
                [
                    'memories',
                    'existing-product',
                    'empty-retired',
                    'populated-product'
                ]
            );

            assert.deepEqual(
                await dbopfs.removeEmptyTable('empty-retired'),
                {
                    status:'removed',
                    removed:true,
                    tableName:'empty-retired',
                    directoryName:'empty-retired'
                }
            );
            assert.equal(
                applicationDirectory.entryNames().includes('empty-retired'),
                false
            );
            assert.equal(
                (await dbopfs.getTableNames()).includes('empty-retired'),
                false
            );
            assert.deepEqual(
                await dbopfs.removeEmptyTable('missing-retired'),
                {
                    status:'absent',
                    removed:false,
                    tableName:'missing-retired',
                    directoryName:'missing-retired'
                }
            );
            assert.equal(
                applicationDirectory.createdDirectories.includes('missing-retired'),
                false
            );
            await assert.rejects(
                dbopfs.removeEmptyTable('not-a-table'),
                {name:'TypeMismatchError'}
            );
            assert.equal(
                applicationDirectory.entryNames().includes('not-a-table'),
                true
            );
            assert.deepEqual(
                await dbopfs.removeEmptyTable('populated-product'),
                {
                    status:'not-empty',
                    removed:false,
                    tableName:'populated-product',
                    directoryName:'populated-product'
                }
            );
            assert.equal(
                applicationDirectory.entryNames().includes('populated-product'),
                true
            );

            const [firstDocuments,secondDocuments]=await Promise.all([
                dbopfs.getTableHandle('documents'),
                dbopfs.getTableHandle('documents')
            ]);
            assert.equal(firstDocuments,secondDocuments);
            assert.deepEqual(applicationDirectory.createdDirectories,['documents']);

            const createCountBeforeClear=applicationDirectory.createdDirectories.length;
            await dbopfs.clearAllStorage();
            assert.equal(
                applicationDirectory.createdDirectories.length,
                createCountBeforeClear
            );
            assert.deepEqual(applicationDirectory.entryNames(),[]);
            assert.deepEqual(await dbopfs.getTableNames(),[]);

            const restoredMemory=await dbopfs.getTableHandle('memories');
            assert.equal(restoredMemory.name,'memory');
            assert.deepEqual(
                applicationDirectory.createdDirectories,
                ['documents','memory']
            );
            dbopfs.tables.memory={
                'cached.json':{content:'physical-name cache'}
            };
            dbopfs.tables.memories={
                'cached.json':{content:'logical-name cache'}
            };
            assert.deepEqual(
                await dbopfs.removeEmptyTable('memory'),
                {
                    status:'removed',
                    removed:true,
                    tableName:'memories',
                    directoryName:'memory'
                }
            );
            assert.deepEqual(applicationDirectory.entryNames(),[]);
            assert.equal(Object.hasOwn(dbopfs.tables,'memory'),false);
            assert.equal(Object.hasOwn(dbopfs.tables,'memories'),false);

            await dbopfs.getTableHandle('memories');
            await dbopfs.deleteTable('memories');
            assert.deepEqual(applicationDirectory.entryNames(),[]);
            assert.equal(Object.hasOwn(dbopfs.tables,'memory'),false);
            assert.equal(Object.hasOwn(dbopfs.tables,'memories'),false);

            const fileManagerSource=await readFile(
                new URL(
                    'runtime/arcane/components/file-manager.html',
                    repositoryRoot
                ),
                'utf8'
            );
            assert.match(
                fileManagerSource,
                /tableNames=await dbopfs\.getTableNames\(true\);/u
            );
            assert.doesNotMatch(
                fileManagerSource,
                /dbopfs\.getTableNames\(Boolean\(layout\)\)/u
            );
        }finally{
            restoreGlobalProperty('window',descriptors.window);
            restoreGlobalProperty('navigator',descriptors.navigator);
            restoreGlobalProperty('document',descriptors.document);
        }
    }
);

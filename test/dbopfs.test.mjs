import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import test from '../src/testing.mjs';

const repositoryRoot=new URL('../',import.meta.url);

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
                        return entries.get(directoryName);
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
        const applicationDirectory=createDirectory(
            'dbopfs-lazy-table-test',
            [
                memoryDirectory,
                existingProductDirectory,
                emptyRetiredDirectory,
                populatedDirectory
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

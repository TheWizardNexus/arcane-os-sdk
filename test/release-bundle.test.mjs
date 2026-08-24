import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
    appendFile,
    link,
    lstat,
    mkdir,
    readFile,
    readdir,
    realpath,
    rm,
    utimes,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import {gunzipSync,gzipSync} from 'node:zlib';

import test from '../src/testing.mjs';
import {packageApp} from '../src/packager/core.mjs';
import {bundleApplication} from '../src/toolchain.mjs';
import {
    APP_BUNDLE_EXTENSION,
    APP_BUNDLE_LIMITS,
    createAppReleaseBundle,
    createCanonicalUstarHeader,
    verifyAppReleaseBundle
} from '../src/release-bundle.mjs';
import {temporaryDirectory} from './helpers.mjs';

const GOLDEN_BUNDLE_SHA256='2132929602a9d3d16ff67086082ffa2df8424cf44496128e4501f3e18b9245e3';

async function writeJson(filePath,value){
    await mkdir(path.dirname(filePath),{recursive:true});
    await writeFile(filePath,`${JSON.stringify(value,null,2)}\n`);
}

function descriptor(){
    return {
        schemaVersion:2,
        id:'bundle-fixture',
        displayName:'Bundle Fixture',
        description:'Fixture for deterministic external application release bundles.',
        version:'1.2.3',
        publisher:{id:'the-wizard-nexus',name:'The Wizard Nexus'},
        package:{
            entry:'index.html',
            strategy:'static',
            include:['index.html','manifest.json','modules'],
            exclude:[],
            shared:['browser-runtime']
        },
        permissions:{capabilities:[],methods:[]},
        security:{connectOrigins:[],frameOrigins:[],mediaOrigins:[]},
        native:{type:'app',icon:null,order:100,bundledApps:[]},
        requirements:{arcaneProtocol:'arcane/1',minimumCoreVersion:'0.8.12',features:[]},
        targets:['browser']
    };
}

async function createFixture(root,{authored=true}={}){
    await writeJson(path.join(root,'arcane-packager.json'),{
        schemaVersion:1,
        appsRoot:'apps',
        distRoot:'dist',
        sharedPayloads:{
            'browser-runtime':[
                {
                    source:'runtime-source',
                    destination:'arcane',
                    include:['modules'],
                    exclude:[]
                }
            ]
        }
    });
    const appRoot=path.join(root,'apps','bundle-fixture');
    const authoredDescriptor=descriptor();
    await writeJson(path.join(appRoot,'arcane-package.json'),{
        schemaVersion:1,
        id:authoredDescriptor.id,
        displayName:authoredDescriptor.displayName,
        version:authoredDescriptor.version,
        entry:authoredDescriptor.package.entry,
        strategy:authoredDescriptor.package.strategy,
        security:authoredDescriptor.security,
        include:authoredDescriptor.package.include,
        exclude:authoredDescriptor.package.exclude,
        shared:authoredDescriptor.package.shared
    });
    if(authored)await writeJson(path.join(appRoot,'arcane-app.json'),authoredDescriptor);
    await writeJson(path.join(appRoot,'manifest.json'),{
        name:'Bundle Fixture',
        start_url:'./index.html',
        display:'standalone',
        icons:[]
    });
    await writeFile(path.join(appRoot,'index.html'),'<!doctype html><title>Bundle Fixture</title>\n');
    await mkdir(path.join(appRoot,'modules'));
    await writeFile(path.join(appRoot,'modules','App.js'),'export const ready=true;\n');
    await mkdir(path.join(root,'runtime-source','modules'),{recursive:true});
    await writeFile(path.join(root,'runtime-source','modules','Runtime.js'),'export const runtime=true;\n');
    const packaged=await packageApp({workspaceRoot:root,appId:'bundle-fixture'});
    return {
        descriptor:authoredDescriptor,
        receipt:packaged.receipt,
        releaseRoot:path.join(root,'dist','bundle-fixture')
    };
}

function digest(bytes){
    return createHash('sha256').update(bytes).digest('hex');
}

function canonicalGzip(tar){
    const bytes=gzipSync(tar,{level:9,mtime:0});
    bytes[9]=3;
    return bytes;
}

function tarSpans(tar){
    const spans=[];
    let offset=0;
    while(offset+512<=tar.length){
        const header=tar.subarray(offset,offset+512);
        if(header.every(byte=>byte===0))return {spans,endOffset:offset};
        const size=Number.parseInt(header.subarray(124,135).toString('ascii'),8);
        const blocks=Math.ceil(size/512);
        spans.push({headerOffset:offset,dataOffset:offset+512,size,endOffset:offset+512+blocks*512});
        offset+=512+blocks*512;
    }
    throw new Error('Test archive did not contain a USTAR terminator.');
}

function rewriteChecksum(header){
    header.fill(0x20,148,156);
    const checksum=header.reduce((total,byte)=>total+byte,0);
    header.write(`${checksum.toString(8).padStart(6,'0')}\0 `,148,8,'ascii');
}

function hostilePathArchive(good){
    const tar=Buffer.from(gunzipSync(good));
    const header=tar.subarray(0,512);
    header.fill(0,0,100);
    header.write('../escape.json',0,'utf8');
    rewriteChecksum(header);
    return canonicalGzip(tar);
}

function hostileTypeArchive(good){
    const tar=Buffer.from(gunzipSync(good));
    const header=tar.subarray(0,512);
    header[156]=0x32;
    rewriteChecksum(header);
    return canonicalGzip(tar);
}

function duplicatePayloadArchive(good){
    const tar=Buffer.from(gunzipSync(good));
    const {spans,endOffset}=tarSpans(tar);
    const last=spans.at(-1);
    const duplicate=tar.subarray(last.headerOffset,last.endOffset);
    return canonicalGzip(Buffer.concat([
        tar.subarray(0,endOffset),
        duplicate,
        Buffer.alloc(1024)
    ]));
}

function appendZeroEntryArchive(good,entryPath){
    const tar=Buffer.from(gunzipSync(good));
    const {endOffset}=tarSpans(tar);
    return canonicalGzip(Buffer.concat([
        tar.subarray(0,endOffset),
        createCanonicalUstarHeader(entryPath,0),
        Buffer.alloc(1024)
    ]));
}

function manifestTopologyArchive(good,paths){
    const tar=Buffer.from(gunzipSync(good));
    const first=tarSpans(tar).spans[0];
    const manifest=JSON.parse(tar.subarray(first.dataOffset,first.dataOffset+first.size).toString('utf8'));
    assert.ok(manifest.payload.files.length>=paths.length);
    paths.forEach((filePath,index)=>{
        manifest.payload.files[index].path=filePath;
    });
    const changed=Buffer.from(`${JSON.stringify(manifest,null,2)}\n`);
    return canonicalGzip(Buffer.concat([
        createCanonicalUstarHeader('ARCANE_APP_BUNDLE.json',changed.length),
        changed,
        Buffer.alloc((512-(changed.length%512))%512),
        tar.subarray(first.endOffset)
    ]));
}

function changedPayloadArchive(good){
    const tar=Buffer.from(gunzipSync(good));
    const last=tarSpans(tar).spans.at(-1);
    assert.ok(last.size>0);
    tar[last.dataOffset]^=0xff;
    return canonicalGzip(tar);
}

function reorderedManifestArchive(good){
    const tar=Buffer.from(gunzipSync(good));
    const first=tarSpans(tar).spans[0];
    const manifest=JSON.parse(tar.subarray(first.dataOffset,first.dataOffset+first.size).toString('utf8'));
    const reordered=Buffer.from(`${JSON.stringify({
        kind:manifest.kind,
        schemaVersion:manifest.schemaVersion,
        format:manifest.format,
        sdk:manifest.sdk,
        app:manifest.app,
        descriptor:manifest.descriptor,
        release:manifest.release,
        payload:manifest.payload
    },null,2)}\n`);
    assert.equal(reordered.length,first.size);
    reordered.copy(tar,first.dataOffset);
    return canonicalGzip(tar);
}

function unsupportedSdkArchive(good){
    const tar=Buffer.from(gunzipSync(good));
    const first=tarSpans(tar).spans[0];
    const manifest=JSON.parse(tar.subarray(first.dataOffset,first.dataOffset+first.size).toString('utf8'));
    manifest.sdk.version='9.9.9';
    const changed=Buffer.from(`${JSON.stringify(manifest,null,2)}\n`);
    assert.equal(changed.length,first.size);
    changed.copy(tar,first.dataOffset);
    return canonicalGzip(tar);
}

function zeroPayloadTotalsArchive(good){
    const tar=Buffer.from(gunzipSync(good));
    const first=tarSpans(tar).spans[0];
    const manifest=JSON.parse(tar.subarray(first.dataOffset,first.dataOffset+first.size).toString('utf8'));
    manifest.release.totalBytes=0;
    manifest.payload.totalBytes=0;
    const changed=Buffer.from(`${JSON.stringify(manifest,null,2)}\n`);
    const padding=Buffer.alloc((512-(changed.length%512))%512);
    return canonicalGzip(Buffer.concat([
        createCanonicalUstarHeader('ARCANE_APP_BUNDLE.json',changed.length),
        changed,
        padding,
        tar.subarray(first.endOffset)
    ]));
}

function expansionBombArchive(good){
    const tar=Buffer.from(gunzipSync(good));
    const {endOffset}=tarSpans(tar);
    const content=Buffer.alloc(32*1024*1024);
    return canonicalGzip(Buffer.concat([
        tar.subarray(0,endOffset),
        createCanonicalUstarHeader('payload/expansion-bomb.bin',content.length),
        content,
        Buffer.alloc(1024)
    ]));
}

function entryCountBombArchive(good){
    const tar=Buffer.from(gunzipSync(good));
    const {spans,endOffset}=tarSpans(tar);
    const headers=[];
    const additions=APP_BUNDLE_LIMITS.maxEntries-spans.length+1;
    for(let index=0;index<additions;index+=1){
        headers.push(createCanonicalUstarHeader(`payload/extra-${String(index).padStart(5,'0')}`,0));
    }
    return canonicalGzip(Buffer.concat([
        tar.subarray(0,endOffset),
        ...headers,
        Buffer.alloc(1024)
    ]));
}

function oversizedEntryArchive(good){
    const tar=Buffer.from(gunzipSync(good));
    const header=tar.subarray(tarSpans(tar).spans.at(-1).headerOffset);
    const size=APP_BUNDLE_LIMITS.maxEntryBytes+1;
    header.write(`${size.toString(8).padStart(11,'0')}\0`,124,12,'ascii');
    rewriteChecksum(header.subarray(0,512));
    return canonicalGzip(tar);
}

test('release bundles are deterministic, receipt-bound, and independently verifiable',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-release-bundle-'});
    const fixture=await createFixture(workspaceRoot);
    const firstPath=path.join(workspaceRoot,`first${APP_BUNDLE_EXTENSION}`);
    const secondPath=path.join(workspaceRoot,`second${APP_BUNDLE_EXTENSION}`);

    const first=await createAppReleaseBundle({
        receipt:fixture.receipt,
        releaseRoot:fixture.releaseRoot,
        outputPath:firstPath
    });
    const second=await createAppReleaseBundle({
        receipt:fixture.receipt,
        releaseRoot:fixture.releaseRoot,
        outputPath:secondPath
    });
    const [firstBytes,secondBytes]=await Promise.all([readFile(firstPath),readFile(secondPath)]);
    assert.deepEqual(firstBytes,secondBytes);
    assert.equal(first.bundleSha256,digest(firstBytes));
    assert.equal(first.bundleSha256,GOLDEN_BUNDLE_SHA256);
    assert.equal(second.bundleSha256,first.bundleSha256);
    assert.equal(first.artifactReceipt.app.id,'bundle-fixture');
    assert.equal(first.artifactReceipt.app.version,'1.2.3');
    assert.equal(first.artifactReceipt.fileCount,fixture.receipt.fileCount);
    assert.equal(first.artifactReceipt.totalBytes,fixture.receipt.totalBytes);
    assert.equal(first.artifactReceipt.releaseContentSha256,fixture.receipt.contentSha256);
    assert.equal(first.artifactReceipt.arcaneCompatible,true);
    assert.equal(first.artifactReceipt.artifactIdentity.links,'1');
    assert.deepEqual(first.artifactReceipt.consistency,{
        artifact:{
            sha256:first.bundleSha256,
            bytes:first.compressedBytes
        },
        descriptor:{
            canonicalSha256:first.artifactReceipt.descriptorSha256,
            fileSha256:first.artifactReceipt.descriptorFileSha256,
            packageSha256:first.artifactReceipt.packageSha256,
            bytes:first.artifactReceipt.descriptorBytes
        },
        release:{
            manifestSha256:first.artifactReceipt.releaseManifestSha256,
            policySha256:fixture.receipt.policySha256,
            contentSha256:fixture.receipt.contentSha256,
            fileCount:fixture.receipt.fileCount,
            totalBytes:fixture.receipt.totalBytes
        }
    });

    const verified=await verifyAppReleaseBundle({bundlePath:firstPath});
    assert.equal(verified.verified,true);
    assert.equal(verified.bundleSha256,first.bundleSha256);
    assert.equal(verified.descriptorSha256,first.artifactReceipt.descriptorSha256);
    assert.equal(verified.packageSha256,first.artifactReceipt.packageSha256);
    assert.deepEqual(verified.consistency,first.artifactReceipt.consistency);
    assert.equal(verified.entryCount,fixture.receipt.fileCount+3);
    assert.ok(verified.compressedBytes<APP_BUNDLE_LIMITS.maxCompressedBytes);
    assert.ok(verified.expandedBytes<APP_BUNDLE_LIMITS.maxExpandedBytes);
});

test('bundle output rejects Windows-unsafe and noncanonical direct filenames before locking',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-release-output-name-'});
    const fixture=await createFixture(workspaceRoot);
    for(const filename of [
        `file:stream${APP_BUNDLE_EXTENSION}`,
        `NUL${APP_BUNDLE_EXTENSION}`,
        `CLOCK$${APP_BUNDLE_EXTENSION}`,
        `CONIN$.metadata${APP_BUNDLE_EXTENSION}`,
        `CONOUT$${APP_BUNDLE_EXTENSION}`,
        `COM¹${APP_BUNDLE_EXTENSION}`,
        `lpt³.archive${APP_BUNDLE_EXTENSION}`,
        `unsafe?name${APP_BUNDLE_EXTENSION}`,
        `decomposed-e\u0301${APP_BUNDLE_EXTENSION}`,
        `trailing${APP_BUNDLE_EXTENSION}.`,
        `trailing${APP_BUNDLE_EXTENSION} `
    ]){
        await assert.rejects(
            createAppReleaseBundle({...fixture,outputPath:path.join(workspaceRoot,filename)}),
            /portable direct filename|must end/u
        );
    }
    for(const archivePath of [
        'payload/CLOCK$/child.js',
        'payload/CONIN$.json',
        'payload/CONOUT$/child.js',
        'payload/COM¹.log',
        'payload/lpt²/child.js',
        'payload/less<than.js',
        'payload/greater>than.js',
        'payload/double"quote.js',
        'payload/vertical|bar.js',
        'payload/question?mark.js',
        'payload/asterisk*.js'
    ]){
        assert.throws(()=>createCanonicalUstarHeader(archivePath,0),/unsafe path segment/u);
    }
    assert.deepEqual((await readdir(workspaceRoot)).filter(name=>name.endsWith('.lock')),[]);
});

test('bundle promotion is collision-safe, cancellable, and explicit about overwrite',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-release-promotion-'});
    const fixture=await createFixture(workspaceRoot);
    const outputPath=path.join(workspaceRoot,`release${APP_BUNDLE_EXTENSION}`);
    await createAppReleaseBundle({...fixture,outputPath});
    const original=await readFile(outputPath);

    await assert.rejects(
        createAppReleaseBundle({...fixture,outputPath}),
        /already exists|overwrite/u
    );
    assert.deepEqual(await readFile(outputPath),original);

    for(const operation of [
        ()=>createAppReleaseBundle({...fixture,outputPath,overwrite:'false'}),
        ()=>bundleApplication({
            workspaceRoot,
            appId:'bundle-fixture',
            artifactPath:outputPath,
            overwrite:'false'
        })
    ]){
        await assert.rejects(operation(),error=>error?.code==='ARCANE_USAGE');
        assert.deepEqual(await readFile(outputPath),original);
    }

    const replaced=await createAppReleaseBundle({...fixture,outputPath,overwrite:true});
    assert.equal(replaced.bundleSha256,digest(original));
    assert.deepEqual(await readFile(outputPath),original);

    const swappedDuringWriteOutput=path.join(
        workspaceRoot,
        `swapped-during-write${APP_BUNDLE_EXTENSION}`
    );
    let swappedDuringWriteStaging;
    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath:swappedDuringWriteOutput,
            onEvent:async event=>{
                if(event.type!=='bundle.entry.written'||event.index!==event.entryCount)return;
                const temporary=(await readdir(workspaceRoot)).find(name=>
                    name.startsWith(`.${path.basename(swappedDuringWriteOutput)}.`)
                        &&name.endsWith('.tmp')
                );
                assert.ok(temporary);
                swappedDuringWriteStaging=path.join(workspaceRoot,temporary);
                await rm(swappedDuringWriteStaging);
                await writeFile(swappedDuringWriteStaging,original);
            }
        }),
        error=>/originally created file object/u.test(error?.message??'')
            &&/Cleanup warning: Preserved changed staging path/u.test(error.message)
    );
    await assert.rejects(readFile(swappedDuringWriteOutput),{code:'ENOENT'});
    assert.deepEqual(await readFile(swappedDuringWriteStaging),original);
    await rm(swappedDuringWriteStaging);

    const appearedPath=path.join(workspaceRoot,`appeared${APP_BUNDLE_EXTENSION}`);
    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath:appearedPath,
            overwrite:true,
            onEvent:async event=>{
                if(event.type==='bundle.archive.output-vacated'&&!event.replaced){
                    await writeFile(appearedPath,'foreign create-only collision\n');
                }
            }
        }),
        /create-only promotion|path collision/u
    );
    assert.equal(await readFile(appearedPath,'utf8'),'foreign create-only collision\n');

    const vacatedPath=path.join(workspaceRoot,`vacated${APP_BUNDLE_EXTENSION}`);
    await createAppReleaseBundle({...fixture,outputPath:vacatedPath});
    const vacatedOriginal=await readFile(vacatedPath);
    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath:vacatedPath,
            overwrite:true,
            onEvent:async event=>{
                if(event.type==='bundle.archive.output-vacated'&&event.replaced){
                    await writeFile(vacatedPath,'foreign overwrite collision\n');
                }
            }
        }),
        /path collision|create-only/u
    );
    assert.equal(await readFile(vacatedPath,'utf8'),'foreign overwrite collision\n');
    const vacatedBackups=(await readdir(workspaceRoot))
        .filter(name=>name.startsWith(`${path.basename(vacatedPath)}.backup-`));
    assert.equal(vacatedBackups.length,1);
    assert.deepEqual(await readFile(path.join(workspaceRoot,vacatedBackups[0])),vacatedOriginal);
    await rm(vacatedPath);
    await rm(path.join(workspaceRoot,vacatedBackups[0]));

    const backupLinkedPath=path.join(workspaceRoot,`backup-linked${APP_BUNDLE_EXTENSION}`);
    await createAppReleaseBundle({...fixture,outputPath:backupLinkedPath});
    const fixedMtimeSeconds=1_700_000_000;
    await utimes(backupLinkedPath,fixedMtimeSeconds,fixedMtimeSeconds);
    let changedBackupLink;
    let changedLinkedBytes;
    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath:backupLinkedPath,
            overwrite:true,
            onEvent:async event=>{
                if(event.type!=='bundle.archive.backup-linked')return;
                changedBackupLink=event.backupPath;
                const before=await lstat(event.outputPath,{bigint:true});
                changedLinkedBytes=await readFile(event.outputPath);
                changedLinkedBytes[0]^=0xff;
                await writeFile(event.outputPath,changedLinkedBytes);
                await utimes(event.outputPath,fixedMtimeSeconds,fixedMtimeSeconds);
                const after=await lstat(event.outputPath,{bigint:true});
                assert.equal(after.dev,before.dev);
                assert.equal(after.ino,before.ino);
                assert.equal(after.size,before.size);
                assert.equal(after.mtimeNs,before.mtimeNs);
                assert.equal(after.nlink,before.nlink);
            }
        }),
        error=>/anchored content identity/u.test(error?.message??'')
            &&/Backup cleanup warning/u.test(error.message)
    );
    assert.deepEqual(await readFile(backupLinkedPath),changedLinkedBytes);
    assert.deepEqual(await readFile(changedBackupLink),changedLinkedBytes);
    await rm(changedBackupLink);
    await rm(backupLinkedPath);

    let inPlaceTamper;
    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath,
            overwrite:true,
            onEvent:async event=>{
                if(event.type==='bundle.archive.promoted'){
                    const before=await lstat(outputPath,{bigint:true});
                    const beforeTimes=await lstat(outputPath);
                    inPlaceTamper=await readFile(outputPath);
                    inPlaceTamper[0]^=0xff;
                    await writeFile(outputPath,inPlaceTamper);
                    await utimes(outputPath,beforeTimes.atime,beforeTimes.mtime);
                    const after=await lstat(outputPath,{bigint:true});
                    assert.equal(after.dev,before.dev);
                    assert.equal(after.ino,before.ino);
                    assert.equal(after.size,before.size);
                }
            }
        }),
        error=>/Promoted bundle identity|promoted app release bundle/u.test(error?.message??'')
            &&/Rollback warning: preserve changed output path[\s\S]*anchored content identity/u.test(error.message)
    );
    assert.deepEqual(await readFile(outputPath),inPlaceTamper);
    const inPlaceTamperBackups=(await readdir(workspaceRoot))
        .filter(name=>name.startsWith(`${path.basename(outputPath)}.backup-`));
    assert.equal(inPlaceTamperBackups.length,1);
    assert.deepEqual(
        await readFile(path.join(workspaceRoot,inPlaceTamperBackups[0])),
        original
    );
    await rm(outputPath);
    await rm(path.join(workspaceRoot,inPlaceTamperBackups[0]));

    const replacedPath=path.join(workspaceRoot,`path-replaced${APP_BUNDLE_EXTENSION}`);
    await createAppReleaseBundle({...fixture,outputPath:replacedPath});
    const replacedOriginal=await readFile(replacedPath);
    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath:replacedPath,
            overwrite:true,
            onEvent:async event=>{
                if(event.type!=='bundle.archive.promoted')return;
                await rm(replacedPath);
                await writeFile(replacedPath,'unowned replacement\n');
            }
        }),
        /identity|does not match|preserve changed output/u
    );
    assert.equal(await readFile(replacedPath,'utf8'),'unowned replacement\n');
    const preservedBackups=(await readdir(workspaceRoot))
        .filter(name=>name.startsWith(`${path.basename(replacedPath)}.backup-`));
    assert.equal(preservedBackups.length,1);
    assert.deepEqual(await readFile(path.join(workspaceRoot,preservedBackups[0])),replacedOriginal);
    await rm(replacedPath);
    await rm(path.join(workspaceRoot,preservedBackups[0]));

    const replacedBothPath=path.join(workspaceRoot,`both-replaced${APP_BUNDLE_EXTENSION}`);
    await createAppReleaseBundle({...fixture,outputPath:replacedBothPath});
    let replacedBothBackup;
    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath:replacedBothPath,
            overwrite:true,
            onEvent:async event=>{
                if(event.type==='bundle.archive.output-vacated'&&event.replaced){
                    replacedBothBackup=event.backupPath;
                    return;
                }
                if(event.type!=='bundle.archive.promoted')return;
                assert.ok(replacedBothBackup);
                await rm(replacedBothBackup);
                await writeFile(replacedBothBackup,'foreign backup replacement\n');
                await rm(replacedBothPath);
                await writeFile(replacedBothPath,'foreign output replacement\n');
            }
        }),
        error=>/Rollback warning:[\s\S]*backup identity changed before restore/u.test(error?.message??'')
            &&/preserve promoted output path[\s\S]*prior backup is not recoverable/u.test(error.message)
    );
    assert.equal(await readFile(replacedBothPath,'utf8'),'foreign output replacement\n');
    assert.equal(await readFile(replacedBothBackup,'utf8'),'foreign backup replacement\n');
    await rm(replacedBothPath);
    await rm(replacedBothBackup);

    const backupOnlyPath=path.join(workspaceRoot,`backup-only-replaced${APP_BUNDLE_EXTENSION}`);
    await createAppReleaseBundle({...fixture,outputPath:backupOnlyPath});
    let backupOnlyBackup;
    let exactPromotedBytes;
    let exactPromotedIdentity;
    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath:backupOnlyPath,
            overwrite:true,
            onEvent:async event=>{
                if(event.type==='bundle.archive.output-vacated'&&event.replaced){
                    backupOnlyBackup=event.backupPath;
                    return;
                }
                if(event.type!=='bundle.archive.promoted')return;
                assert.ok(backupOnlyBackup);
                exactPromotedBytes=await readFile(backupOnlyPath);
                exactPromotedIdentity=await lstat(backupOnlyPath,{bigint:true});
                await rm(backupOnlyBackup);
                await writeFile(backupOnlyBackup,'foreign backup replacement only\n');
                throw new Error('forced backup-only replacement failure');
            }
        }),
        error=>/forced backup-only replacement failure/u.test(error?.message??'')
            &&/Rollback warning:[\s\S]*prior backup is not recoverable/u.test(error.message)
    );
    const survivingPromotedIdentity=await lstat(backupOnlyPath,{bigint:true});
    for(const field of ['dev','ino','size','nlink']){
        assert.equal(survivingPromotedIdentity[field],exactPromotedIdentity[field],field);
    }
    assert.deepEqual(await readFile(backupOnlyPath),exactPromotedBytes);
    assert.equal(await readFile(backupOnlyBackup,'utf8'),'foreign backup replacement only\n');
    await rm(backupOnlyPath);
    await rm(backupOnlyBackup);

    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath:path.join(fixture.releaseRoot,`inside${APP_BUNDLE_EXTENSION}`)
        }),
        /inside the authenticated release root/u
    );

    const cancelledPath=path.join(workspaceRoot,`cancelled${APP_BUNDLE_EXTENSION}`);
    const controller=new AbortController();
    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath:cancelledPath,
            signal:controller.signal,
            onEvent:event=>{
                if(event.type==='bundle.entry.written')controller.abort(new Error('test cancellation'));
            }
        }),
        error=>error?.code==='ARCANE_CANCELLED'
    );
    await assert.rejects(readFile(cancelledPath),{code:'ENOENT'});
    const leftovers=(await readdir(workspaceRoot)).filter(name=>
        name.includes('cancelled')&&(name.endsWith('.tmp')||name.endsWith('.lock'))
    );
    assert.deepEqual(leftovers,[]);

    const entryFailurePath=path.join(workspaceRoot,`entry-failure${APP_BUNDLE_EXTENSION}`);
    const entryFailure=new Error('entry callback failed after staging mutation');
    let entryFailureStagingPath;
    let entryFailureFirstByte;
    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath:entryFailurePath,
            onEvent:async event=>{
                if(event.type!=='bundle.entry.written'||entryFailureStagingPath)return;
                const temporary=(await readdir(workspaceRoot)).find(name=>
                    name.startsWith(`.${path.basename(entryFailurePath)}.`)&&name.endsWith('.tmp')
                );
                assert.ok(temporary);
                entryFailureStagingPath=path.join(workspaceRoot,temporary);
                const before=await lstat(entryFailureStagingPath,{bigint:true});
                const beforeTimes=await lstat(entryFailureStagingPath);
                const changed=await readFile(entryFailureStagingPath);
                assert.ok(changed.length>0);
                changed[0]^=0xff;
                entryFailureFirstByte=changed[0];
                await writeFile(entryFailureStagingPath,changed);
                await utimes(entryFailureStagingPath,beforeTimes.atime,beforeTimes.mtime);
                const after=await lstat(entryFailureStagingPath,{bigint:true});
                assert.equal(after.dev,before.dev);
                assert.equal(after.ino,before.ino);
                assert.equal(after.size,before.size);
                throw entryFailure;
            }
        }),
        error=>error===entryFailure
            &&/Cleanup warning: Preserved changed staging path[\s\S]*anchored content identity/u.test(error.message)
    );
    await assert.rejects(readFile(entryFailurePath),{code:'ENOENT'});
    const preservedEntryFailure=await readFile(entryFailureStagingPath);
    assert.equal(preservedEntryFailure[0],entryFailureFirstByte);
    await rm(entryFailureStagingPath);

    const tamperedPath=path.join(workspaceRoot,`tampered${APP_BUNDLE_EXTENSION}`);
    let tamperedStagingPath;
    let tamperedStagingBytes;
    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath:tamperedPath,
            onEvent:async event=>{
                if(event.type!=='bundle.archive.verified')return;
                const temporary=(await readdir(workspaceRoot)).find(name=>
                    name.startsWith(`.${path.basename(tamperedPath)}.`)&&name.endsWith('.tmp')
                );
                assert.ok(temporary);
                tamperedStagingPath=path.join(workspaceRoot,temporary);
                const before=await lstat(tamperedStagingPath,{bigint:true});
                const beforeTimes=await lstat(tamperedStagingPath);
                tamperedStagingBytes=await readFile(tamperedStagingPath);
                tamperedStagingBytes[0]^=0xff;
                await writeFile(tamperedStagingPath,tamperedStagingBytes);
                await utimes(tamperedStagingPath,beforeTimes.atime,beforeTimes.mtime);
                const after=await lstat(tamperedStagingPath,{bigint:true});
                assert.equal(after.dev,before.dev);
                assert.equal(after.ino,before.ino);
                assert.equal(after.size,before.size);
            }
        }),
        error=>/Verified bundle staging did not retain its anchored content identity/u.test(error?.message??'')
            &&/Cleanup warning: Preserved changed staging path[\s\S]*anchored content identity/u.test(error.message)
    );
    await assert.rejects(readFile(tamperedPath),{code:'ENOENT'});
    assert.deepEqual(await readFile(tamperedStagingPath),tamperedStagingBytes);
    await rm(tamperedStagingPath);

    const failedCallbackPath=path.join(workspaceRoot,`failed-callback${APP_BUNDLE_EXTENSION}`);
    const failedCallback=new Error('verified callback failed after staging mutation');
    let failedCallbackStagingPath;
    let failedCallbackStagingBytes;
    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath:failedCallbackPath,
            onEvent:async event=>{
                if(event.type!=='bundle.archive.verified')return;
                const temporary=(await readdir(workspaceRoot)).find(name=>
                    name.startsWith(`.${path.basename(failedCallbackPath)}.`)&&name.endsWith('.tmp')
                );
                assert.ok(temporary);
                failedCallbackStagingPath=path.join(workspaceRoot,temporary);
                const before=await lstat(failedCallbackStagingPath,{bigint:true});
                const beforeTimes=await lstat(failedCallbackStagingPath);
                failedCallbackStagingBytes=await readFile(failedCallbackStagingPath);
                failedCallbackStagingBytes[0]^=0xff;
                await writeFile(failedCallbackStagingPath,failedCallbackStagingBytes);
                await utimes(failedCallbackStagingPath,beforeTimes.atime,beforeTimes.mtime);
                const after=await lstat(failedCallbackStagingPath,{bigint:true});
                assert.equal(after.dev,before.dev);
                assert.equal(after.ino,before.ino);
                assert.equal(after.size,before.size);
                throw failedCallback;
            }
        }),
        error=>error===failedCallback
            &&/Cleanup warning: Preserved changed staging path[\s\S]*anchored content identity/u.test(error.message)
    );
    await assert.rejects(readFile(failedCallbackPath),{code:'ENOENT'});
    assert.deepEqual(await readFile(failedCallbackStagingPath),failedCallbackStagingBytes);
    await rm(failedCallbackStagingPath);

    const replacedStagingOutput=path.join(workspaceRoot,`replaced-staging${APP_BUNDLE_EXTENSION}`);
    let replacedStagingPath;
    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath:replacedStagingOutput,
            onEvent:async event=>{
                if(event.type!=='bundle.archive.verified')return;
                const temporary=(await readdir(workspaceRoot)).find(name=>
                    name.startsWith(`.${path.basename(replacedStagingOutput)}.`)&&name.endsWith('.tmp')
                );
                assert.ok(temporary);
                replacedStagingPath=path.join(workspaceRoot,temporary);
                await rm(replacedStagingPath);
                await writeFile(replacedStagingPath,'foreign staging replacement\n');
            }
        }),
        error=>/staging (?:changed before atomic promotion|did not retain its anchored file object)/u.test(error?.message??'')
            &&/Cleanup warning: Preserved changed staging path/u.test(error.message)
    );
    await assert.rejects(readFile(replacedStagingOutput),{code:'ENOENT'});
    assert.equal(await readFile(replacedStagingPath,'utf8'),'foreign staging replacement\n');
    await rm(replacedStagingPath);

    const callbackStagingOutput=path.join(workspaceRoot,`callback-staging${APP_BUNDLE_EXTENSION}`);
    let callbackStagingPath;
    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath:callbackStagingOutput,
            onEvent:async event=>{
                if(event.type!=='bundle.archive.output-vacated'||event.replaced)return;
                const temporary=(await readdir(workspaceRoot)).find(name=>
                    name.startsWith(`.${path.basename(callbackStagingOutput)}.`)&&name.endsWith('.tmp')
                );
                assert.ok(temporary);
                callbackStagingPath=path.join(workspaceRoot,temporary);
                await rm(callbackStagingPath);
                await writeFile(callbackStagingPath,'foreign callback staging\n');
            }
        }),
        error=>/staging (?:changed before atomic promotion|did not retain its anchored file object)/u.test(error?.message??'')
            &&/Cleanup warning: Preserved changed staging path/u.test(error.message)
    );
    await assert.rejects(readFile(callbackStagingOutput),{code:'ENOENT'});
    assert.equal(await readFile(callbackStagingPath,'utf8'),'foreign callback staging\n');
    await rm(callbackStagingPath);

    const changedBackupOutput=path.join(workspaceRoot,`changed-backup${APP_BUNDLE_EXTENSION}`);
    await createAppReleaseBundle({...fixture,outputPath:changedBackupOutput});
    let changedBackupPath;
    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath:changedBackupOutput,
            overwrite:true,
            onEvent:async event=>{
                if(event.type!=='bundle.archive.output-vacated'||!event.replaced)return;
                changedBackupPath=event.backupPath;
                await writeFile(changedBackupPath,'changed preserved backup\n');
            }
        }),
        /Preserved bundle backup (?:changed before overwrite promotion|did not retain)/u
    );
    await assert.rejects(readFile(changedBackupOutput),{code:'ENOENT'});
    assert.equal(await readFile(changedBackupPath,'utf8'),'changed preserved backup\n');
    await rm(changedBackupPath);
});

test('bundle locks preserve replacement leases and surface cleanup degradation',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-release-lock-'});
    const fixture=await createFixture(workspaceRoot);
    const outputPath=path.join(workspaceRoot,`lock-owned${APP_BUNDLE_EXTENSION}`);
    const lockPath=`${outputPath}.lock`;
    const interruptedPath=path.join(workspaceRoot,`lock-interrupted${APP_BUNDLE_EXTENSION}`);
    const interruptedLock=`${interruptedPath}.lock`;
    const callbackFailure=Object.freeze(new Error('lock acquisition event failed'));
    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath:interruptedPath,
            onEvent:event=>{
                if(event.type==='bundle.lock.written')throw callbackFailure;
            }
        }),
        error=>error===callbackFailure
    );
    await assert.rejects(readFile(interruptedLock),{code:'ENOENT'});
    const changedLockPath=path.join(workspaceRoot,`lock-changed${APP_BUNDLE_EXTENSION}`);
    const changedLock=`${changedLockPath}.lock`;
    const changedLockFailure=new Error('lock acquisition event changed the lease');
    let changedLockBytes;
    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath:changedLockPath,
            onEvent:async event=>{
                if(event.type!=='bundle.lock.written')return;
                assert.equal(await realpath(event.lockPath),await realpath(changedLock));
                const before=await lstat(changedLock,{bigint:true});
                const beforeTimes=await lstat(changedLock);
                changedLockBytes=await readFile(changedLock);
                changedLockBytes[0]^=0xff;
                await writeFile(changedLock,changedLockBytes);
                await utimes(changedLock,beforeTimes.atime,beforeTimes.mtime);
                const after=await lstat(changedLock,{bigint:true});
                assert.equal(after.dev,before.dev);
                assert.equal(after.ino,before.ino);
                assert.equal(after.size,before.size);
                throw changedLockFailure;
            }
        }),
        error=>error===changedLockFailure
            &&/Partial artifact lock was preserved[\s\S]*anchored content identity/u.test(error.message)
    );
    assert.deepEqual(await readFile(changedLock),changedLockBytes);
    await rm(changedLock);
    const returnedMutationPath=path.join(
        workspaceRoot,
        `lock-returned-mutation${APP_BUNDLE_EXTENSION}`
    );
    const returnedMutationLock=`${returnedMutationPath}.lock`;
    let returnedMutationBytes;
    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath:returnedMutationPath,
            onEvent:async event=>{
                if(event.type!=='bundle.lock.written')return;
                returnedMutationBytes=await readFile(returnedMutationLock);
                returnedMutationBytes[0]^=0xff;
                await writeFile(returnedMutationLock,returnedMutationBytes);
            }
        }),
        error=>/Acquired artifact lock did not retain its anchored content identity/u.test(
            error?.message??''
        )&&/Partial artifact lock was preserved/u.test(error.message)
    );
    assert.deepEqual(await readFile(returnedMutationLock),returnedMutationBytes);
    await rm(returnedMutationLock);
    const returnedReplacementPath=path.join(
        workspaceRoot,
        `lock-returned-replacement${APP_BUNDLE_EXTENSION}`
    );
    const returnedReplacementLock=`${returnedReplacementPath}.lock`;
    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath:returnedReplacementPath,
            onEvent:async event=>{
                if(event.type!=='bundle.lock.written')return;
                await rm(returnedReplacementLock);
                await writeFile(returnedReplacementLock,'replacement lease returned by callback\n');
            }
        }),
        error=>/Acquired artifact lock did not retain/u.test(error?.message??'')
            &&/Partial artifact lock was preserved/u.test(error.message)
    );
    assert.equal(
        await readFile(returnedReplacementLock,'utf8'),
        'replacement lease returned by callback\n'
    );
    await rm(returnedReplacementLock);
    const result=await createAppReleaseBundle({
        ...fixture,
        outputPath,
        onEvent:async event=>{
            if(event.type!=='bundle.archive.started')return;
            const acquired=JSON.parse(await readFile(lockPath,'utf8'));
            assert.match(acquired.nonce,/^[0-9a-f]{32}$/u);
            assert.equal(
                acquired.artifactPath,
                path.join(await realpath(workspaceRoot),path.basename(outputPath))
            );
            await rm(lockPath);
            await writeFile(lockPath,'replacement lease\n');
        }
    });
    assert.equal(result.cleanup?.status,'degraded');
    assert.equal(result.cleanup.issues[0].scope,'artifact-lock');
    assert.equal(await readFile(lockPath,'utf8'),'replacement lease\n');
    await rm(lockPath);
});

test('bundle verification rejects multi-link and growing artifact identities',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-release-identity-'});
    const fixture=await createFixture(workspaceRoot);
    const goodPath=path.join(workspaceRoot,`identity${APP_BUNDLE_EXTENSION}`);
    await createAppReleaseBundle({...fixture,outputPath:goodPath});
    const aliasPath=path.join(workspaceRoot,`identity-alias${APP_BUNDLE_EXTENSION}`);
    await link(goodPath,aliasPath);
    await assert.rejects(
        verifyAppReleaseBundle({bundlePath:goodPath}),
        /exactly one filesystem link/u
    );
    await rm(aliasPath);

    const payloadPath=path.join(fixture.releaseRoot,'apps','bundle-fixture','index.html');
    const payloadAlias=path.join(workspaceRoot,'payload-hardlink');
    await link(payloadPath,payloadAlias);
    await assert.rejects(
        createAppReleaseBundle({
            ...fixture,
            outputPath:path.join(workspaceRoot,`hardlinked-source${APP_BUNDLE_EXTENSION}`)
        }),
        /link|changed|identity/u
    );
    await rm(payloadAlias);

    const growingPath=path.join(workspaceRoot,`growing${APP_BUNDLE_EXTENSION}`);
    await writeFile(growingPath,await readFile(goodPath));
    let appended=false;
    await assert.rejects(
        verifyAppReleaseBundle({
            bundlePath:growingPath,
            onEvent:async event=>{
                if(event.type==='bundle.verify.opened'&&!appended){
                    appended=true;
                    await appendFile(growingPath,canonicalGzip(Buffer.alloc(0)));
                }
            }
        }),
        /grew|changed/u
    );
    assert.equal(appended,true);
});

test('bundle creation refuses a synthesized legacy descriptor authority',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-release-authored-'});
    const fixture=await createFixture(workspaceRoot,{authored:false});
    await assert.rejects(
        createAppReleaseBundle({
            receipt:fixture.receipt,
            releaseRoot:fixture.releaseRoot,
            outputPath:path.join(workspaceRoot,`legacy${APP_BUNDLE_EXTENSION}`)
        }),
        /authored schema-2 descriptor/u
    );
});

test('bundle verifier rejects hostile tar, gzip, topology, and payload mutations',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-release-hostile-'});
    const fixture=await createFixture(workspaceRoot);
    const goodPath=path.join(workspaceRoot,`good${APP_BUNDLE_EXTENSION}`);
    await createAppReleaseBundle({...fixture,outputPath:goodPath});
    const good=await readFile(goodPath);
    const cases=[
        ['alternate gzip header',(()=>{const value=Buffer.from(good); value[9]=0; return value;})()],
        ['trailing gzip bytes',Buffer.concat([good,Buffer.from([0])])],
        ['concatenated empty gzip member',Buffer.concat([good,canonicalGzip(Buffer.alloc(0))])],
        ['traversal path',hostilePathArchive(good)],
        ['symlink entry type',hostileTypeArchive(good)],
        ['duplicate payload path',duplicatePayloadArchive(good)],
        ['release control used as directory',appendZeroEntryArchive(good,'payload/ARCANE_APP_RELEASE.json/child')],
        [
            'payload file used as directory',
            appendZeroEntryArchive(good,'payload/apps/bundle-fixture/index.html/child'),
            /both a file and a directory/u
        ],
        [
            'case-colliding directory prefix',
            appendZeroEntryArchive(good,'payload/apps/bundle-fixture/Modules/other.js'),
            /case-colliding path prefix/u
        ],
        ['manifest file-directory prefix',manifestTopologyArchive(good,['a','a/b'])],
        ['manifest case-colliding prefix',manifestTopologyArchive(good,['A/x','a/y'])],
        ['changed payload bytes',changedPayloadArchive(good)],
        ['reordered bundle manifest',reorderedManifestArchive(good)],
        ['unsupported SDK generation',unsupportedSdkArchive(good)],
        ['zero payload totals',zeroPayloadTotalsArchive(good)],
        ['oversized entry',oversizedEntryArchive(good)],
        ['expansion bomb',expansionBombArchive(good)],
        ['entry count bomb',entryCountBombArchive(good)]
    ];
    for(const [label,bytes,expectedError] of cases){
        await t.test(label,async()=>{
            const hostilePath=path.join(workspaceRoot,`${label.replaceAll(' ','-')}${APP_BUNDLE_EXTENSION}`);
            await writeFile(hostilePath,bytes);
            await assert.rejects(
                verifyAppReleaseBundle({bundlePath:hostilePath}),
                expectedError
                    ??/gzip|USTAR|archive|path|payload|bundle|release|canonical|compatible|version|digest|topology|header|expansion|entry-count|limit|ceiling/u
            );
        });
    }
});

import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {
    APP_BUNDLE_DESCRIPTOR_NAME,
    APP_BUNDLE_FORMAT,
    APP_BUNDLE_KIND,
    APP_BUNDLE_MANIFEST_NAME,
    APP_BUNDLE_RELEASE_PATH,
    createAppReleaseBundle,
    createCanonicalUstarHeader,
    validateAppBundlePath,
    verifyAppReleaseBundle
} from '../src/release-bundle.mjs';
import {PACKAGER_VERSION,RELEASE_MANIFEST_NAME} from '../src/packager/core.mjs';

const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

async function fixture(t){
    const root=await mkdtemp(path.join(os.tmpdir(),'arcane-bundle-content-'));
    t.after(()=>rm(root,{recursive:true,force:true}));
    const releaseRoot=path.join(root,'release');
    await mkdir(path.join(releaseRoot,'content'),{recursive:true});
    const descriptor=JSON.parse(await readFile(
        path.join(repositoryRoot,'examples','hello-world','apps','hello-world','arcane-app.json'),
        'utf8'
    ));
    const complete='complete bundle content\nwith every line\nand trailing space \n';
    await writeFile(path.join(releaseRoot,'index.html'),'<p>Complete bundle</p>\n');
    await writeFile(path.join(releaseRoot,'content','complete.txt'),complete);
    await writeFile(path.join(releaseRoot,RELEASE_MANIFEST_NAME),`${JSON.stringify({
        schemaVersion:1,
        kind:'arcane-app-release',
        packagerVersion:PACKAGER_VERSION,
        app:{
            id:descriptor.id,
            displayName:descriptor.displayName,
            version:descriptor.version,
            entry:'index.html',
            strategy:'static',
            shared:[]
        },
        files:['content/complete.txt','index.html']
    },null,2)}\n`);
    return {root,releaseRoot,descriptor,complete};
}

test('bundle creation and inspection preserve complete release file content',async t=>{
    const selected=await fixture(t);
    const outputPath=path.join(selected.root,'hello-world.arcane-app.tar.gz');
    const created=await createAppReleaseBundle({
        releaseRoot:selected.releaseRoot,
        appDescriptor:selected.descriptor,
        outputPath
    });
    assert.equal(created.bundlePath,outputPath);
    assert.equal(created.manifest.kind,APP_BUNDLE_KIND);
    assert.equal(created.manifest.format,APP_BUNDLE_FORMAT);
    assert.equal(created.manifest.descriptor,APP_BUNDLE_DESCRIPTOR_NAME);
    assert.equal(created.manifest.release,APP_BUNDLE_RELEASE_PATH);

    const inspected=await verifyAppReleaseBundle({bundlePath:outputPath});
    assert.equal(inspected.verified,true);
    assert.equal(
        inspected.readFile('payload/content/complete.txt').toString('utf8'),
        selected.complete
    );
    assert.equal(inspected.manifest.kind,APP_BUNDLE_KIND);
    assert.deepEqual(inspected.files,created.files);
});

test('bundle path and ustar helpers keep only package-format constraints',()=>{
    assert.equal(validateAppBundlePath('payload/content/complete.txt'),'payload/content/complete.txt');
    assert.throws(()=>validateAppBundlePath('../outside'),/Unsafe/u);
    const header=createCanonicalUstarHeader(APP_BUNDLE_MANIFEST_NAME,0);
    assert.equal(header.subarray(257,262).toString('ascii'),'ustar');
});

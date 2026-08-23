import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';

import test from '../src/testing.mjs';
import {
    NPM_RELEASE_KIND,
    NPM_RELEASE_NODE_VERSION,
    NPM_RELEASE_NPM_VERSION,
    NPM_RELEASE_SCHEMA_VERSION,
    parseNpmReleaseManifest,
    verifyNpmReleaseArtifact
} from '../tools/npm-release-contract.mjs';
import {
    compareDevelopmentVersions,
    evaluateDirectPublication,
    executeNpmRead,
    parseDistTags,
    readRegistryPublicationState,
    validateContentClassification
} from '../tools/npm-registry-publication.mjs';
import {temporaryDirectory} from './helpers.mjs';

const canonical=value=>`${JSON.stringify(value,null,2)}\n`;

function digest(bytes,algorithm,encoding='hex'){
    return createHash(algorithm).update(bytes).digest(encoding);
}

function fixture(tarball=Buffer.from('exact Arcane npm artifact\n')){
    const files=[
        'LICENSE',
        'NOTICE',
        'bin/arcane-test.mjs',
        'bin/arcane.mjs',
        'package.json',
        'src/testing.mjs'
    ].sort((left,right)=>left.localeCompare(right,'en'))
        .map(filePath=>({path:filePath,bytes:1}));
    return {
        schemaVersion:NPM_RELEASE_SCHEMA_VERSION,
        kind:NPM_RELEASE_KIND,
        name:'arcane-os',
        version:'0.1.0-dev.4',
        source:{
            repository:'https://github.com/TheWizardNexus/arcane-os-sdk',
            commit:'0'.repeat(40),
            clean:true
        },
        artifact:{
            file:'arcane-os-0.1.0-dev.4.tgz',
            bytes:tarball.length,
            sha256:digest(tarball,'sha256'),
            integrity:`sha512-${digest(tarball,'sha512','base64')}`,
            shasum:digest(tarball,'sha1')
        },
        package:{entryCount:files.length,unpackedBytes:files.length,files},
        toolchain:{node:NPM_RELEASE_NODE_VERSION,npm:NPM_RELEASE_NPM_VERSION}
    };
}

test('npm release manifest is strict and authenticates one exact tarball',async t=>{
    const tarball=Buffer.from('exact Arcane npm artifact\n');
    const manifest=fixture(tarball);

    await t.test('accepts the canonical npm release contract',()=>{
        assert.equal(parseNpmReleaseManifest(canonical(manifest)).artifact.sha256,manifest.artifact.sha256);
    });

    await t.test('rejects alternate JSON formatting',()=>{
        assert.throws(()=>parseNpmReleaseManifest(JSON.stringify(manifest)),/not canonical/u);
    });

    await t.test('rejects private repository files in the package inventory',()=>{
        const invalid=structuredClone(manifest);
        invalid.package.files.push({path:'test/private.test.mjs',bytes:1});
        invalid.package.entryCount+=1;
        invalid.package.unpackedBytes+=1;
        assert.throws(()=>parseNpmReleaseManifest(canonical(invalid)),/Private repository path/u);
    });

    await t.test('rejects an unpinned pack toolchain',()=>{
        const invalid=structuredClone(manifest);
        invalid.toolchain.node='26.7.1';
        assert.throws(()=>parseNpmReleaseManifest(canonical(invalid)),/must be Node/u);
    });

    await t.test('verifies and then rejects changed tarball bytes',async()=>{
        const root=await temporaryDirectory(t,{prefix:'arcane-npm-release-contract-'});
        const metadataPath=path.join(root,'arcane-os-0.1.0-dev.4.manifest.json');
        const tarballPath=path.join(root,manifest.artifact.file);
        await writeFile(metadataPath,canonical(manifest));
        await writeFile(tarballPath,tarball);
        await writeFile(
            `${tarballPath}.sha256`,
            `${manifest.artifact.sha256}  ${manifest.artifact.file}\n`
        );
        const verified=await verifyNpmReleaseArtifact({metadataPath,requireCleanSource:true});
        assert.equal(verified.manifest.source.clean,true);
        await writeFile(tarballPath,Buffer.from('changed Arcane npm artifact\n'));
        await assert.rejects(
            verifyNpmReleaseArtifact({metadataPath,requireCleanSource:true}),
            /does not match its manifest/u
        );
    });
});

test('npm registry publication policy fails closed and resumes exact publishes',async t=>{
    const expectedIntegrity='sha512-expected';

    await t.test('requires an explicit standard or dual-use classification',()=>{
        assert.throws(
            ()=>validateContentClassification({
                classification:'unresolved',
                packageDocument:{name:'arcane-os'},
                disclosureExists:false
            }),
            /explicitly classify/u
        );
        assert.deepEqual(
            validateContentClassification({
                classification:'standard',
                packageDocument:{name:'arcane-os'},
                disclosureExists:false
            }),
            {classification:'standard',mode:'direct'}
        );
    });

    await t.test('requires persistent dual-use metadata and disclosure',()=>{
        assert.throws(
            ()=>validateContentClassification({
                classification:'dual-use',
                packageDocument:{name:'arcane-os'},
                disclosureExists:false
            }),
            /contentPolicy/u
        );
        assert.deepEqual(
            validateContentClassification({
                classification:'dual-use',
                packageDocument:{
                    name:'arcane-os',
                    contentPolicy:{class:'dual-use'},
                    files:['DISCLOSURE']
                },
                disclosureExists:true
            }),
            {classification:'dual-use',mode:'staged'}
        );
    });

    await t.test('accepts an idempotent matching publication and scan-pending tag',()=>{
        assert.deepEqual(evaluateDirectPublication({
            version:'0.1.0-dev.4',
            expectedIntegrity,
            actualIntegrity:expectedIntegrity,
            tags:{dev:'0.1.0-dev.4'}
        }),{state:'published',needsPublish:false});
        assert.deepEqual(evaluateDirectPublication({
            version:'0.1.0-dev.4',
            expectedIntegrity,
            actualIntegrity:null,
            tags:{dev:'0.1.0-dev.4'}
        }),{state:'pending',needsPublish:false});
    });

    await t.test('publishes only ahead of an older dev tag',()=>{
        assert.equal(compareDevelopmentVersions('0.1.0-dev.4','0.1.0-dev.3'),1);
        assert.equal(compareDevelopmentVersions('0.1.0-dev.0','0.1.0-dev'),1);
        assert.equal(compareDevelopmentVersions('0.1.0-dev','0.1.0-dev.0'),-1);
        assert.deepEqual(evaluateDirectPublication({
            version:'0.1.0-dev.4',
            expectedIntegrity,
            actualIntegrity:null,
            tags:{dev:'0.1.0-dev.3'}
        }),{state:'publish',needsPublish:true});
    });

    await t.test('parses the scan-safe npm dist-tag command boundary',()=>{
        assert.deepEqual(
            parseDistTags('dev: 0.1.0-dev.4\nnext: 0.2.0-dev.1\n'),
            {dev:'0.1.0-dev.4',next:'0.2.0-dev.1'}
        );
        assert.throws(()=>parseDistTags('not a tag line\n'),/invalid dist-tag line/u);
        assert.throws(()=>parseDistTags('dev: 0.1.0-dev.4\ndev: 0.1.0-dev.3\n'),/duplicate/u);
    });

    await t.test('executes the exact npm view and dist-tag commands',()=>{
        const executed=[];
        const execute=(file,arguments_)=>{
            executed.push([file,...arguments_]);
            return 'dev: 0.1.0-dev.4\n';
        };
        assert.equal(
            executeNpmRead(['dist-tag','ls','arcane-os'],execute),
            'dev: 0.1.0-dev.4'
        );
        const read=arguments_=>{
            executed.push(['injected',...arguments_]);
            return arguments_[0]==='view'?null:'dev: 0.1.0-dev.4\n';
        };
        assert.deepEqual(readRegistryPublicationState({
            version:'0.1.0-dev.4',expectedIntegrity,read
        }),{state:'pending',needsPublish:false});
        assert.deepEqual(executed,[
            ['npm','dist-tag','ls','arcane-os'],
            ['injected','view','arcane-os@0.1.0-dev.4','dist.integrity'],
            ['injected','dist-tag','ls','arcane-os']
        ]);
    });

    await t.test('rejects byte mismatch, rollback, and premature latest',()=>{
        assert.throws(()=>evaluateDirectPublication({
            version:'0.1.0-dev.4',expectedIntegrity,
            actualIntegrity:'sha512-different',tags:{dev:'0.1.0-dev.4'}
        }),/different immutable bytes/u);
        assert.throws(()=>evaluateDirectPublication({
            version:'0.1.0-dev.4',expectedIntegrity,
            actualIntegrity:null,tags:{dev:'0.1.0-dev.5'}
        }),/move dev backward/u);
        assert.throws(()=>evaluateDirectPublication({
            version:'0.1.0-dev',expectedIntegrity,
            actualIntegrity:null,tags:{dev:'0.1.0-dev.0'}
        }),/move dev backward/u);
        assert.throws(()=>evaluateDirectPublication({
            version:'0.1.0-dev.4',expectedIntegrity,
            actualIntegrity:null,tags:{latest:'0.1.0-dev.3'}
        }),/latest tag/u);
        assert.throws(()=>evaluateDirectPublication({
            version:'0.1.0-dev.4',expectedIntegrity,
            actualIntegrity:null,tags:{dev:'0.1.0-dev.4',next:'0.2.0-dev.1'}
        }),/only the dev dist-tag/u);
    });
});

import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {gzipSync} from 'node:zlib';

import test from '../src/testing.mjs';
import {verifyNpmReleaseArtifact} from '../tools/npm-release-contract.mjs';
import {
    evaluateRegistryPublication,
    parsePublicationVersion,
    parseRegistryTags,
    parseRegistryVersions,
    readRegistryPublicationState
} from '../tools/npm-registry-publication.mjs';
import {temporaryDirectory} from './helpers.mjs';

const REQUIRED_FILES=[
    'CHANGELOG.md','COMMERCIAL-LICENSE.md','LICENSE','NOTICE','README.md',
    'bin/arcane-test.mjs','bin/arcane.mjs','src/index.mjs','src/testing.mjs',
    'docs/reference/README.md','docs/reference/ai/browser-speech.md',
    'docs/reference/ai/twin-cloud.md','examples/wasm-ai-demo/README.md',
    'examples/wasm-ai-demo/index.html','examples/wasm-ai-demo/app.js',
    'examples/wasm-ai-demo/server.mjs'
];

// These offsets are tar transport framing, not Arcane package policy.
function tarEntry(name,content=''){
    const source=Buffer.from(content);
    const header=Buffer.alloc(512);
    header.write(`package/${name}`,0,100,'utf8');
    header.write(source.length.toString(8).padStart(11,'0'),124,11,'ascii');
    header[135]=0;
    header[156]='0'.charCodeAt(0);
    const padding=Buffer.alloc((512-(source.length%512))%512);
    return Buffer.concat([header,source,padding]);
}

function packageTarball({version='0.3.2',extraFiles=[],omit=[]}={}){
    const files=[
        ...REQUIRED_FILES.map(name=>[name,`${name}\n`]),
        ['package.json',JSON.stringify({name:'arcane-os',version})],
        ['browser-runtime/entry.mjs','export {};\n'],
        ['node_modules/event-pubsub/package.json','{"name":"event-pubsub"}\n'],
        ['node_modules/strong-type/package.json','{"name":"strong-type"}\n'],
        ['runtime/arcane/modules/example.js','export default true;\n'],
        ['schemas/example.schema.json','{}\n'],
        ...extraFiles
    ].filter(([name])=>!omit.includes(name));
    return gzipSync(Buffer.concat([
        ...files.map(([name,content])=>tarEntry(name,content)),
        Buffer.alloc(1024)
    ]));
}

test('npm release verification enforces only the public package boundary',async t=>{
    await t.test('reads the package version and selected shipping paths',async()=>{
        const root=await temporaryDirectory(t,{prefix:'arcane-npm-release-contract-'});
        const tarballPath=path.join(root,'arcane-os-0.3.2.tgz');
        await writeFile(tarballPath,packageTarball());
        const verified=await verifyNpmReleaseArtifact({tarballPath,expectedVersion:'0.3.2'});
        assert.equal(verified.version,'0.3.2');
        assert.equal(verified.packageDocument.name,'arcane-os');
        assert.ok(verified.paths.includes('runtime/arcane/modules/example.js'));
        assert.ok(verified.paths.includes('docs/reference/ai/browser-speech.md'));
        assert.ok(verified.paths.includes('docs/reference/ai/twin-cloud.md'));
        assert.ok(verified.paths.includes('examples/wasm-ai-demo/server.mjs'));
    });

    await t.test('rejects an unexpected package version',async()=>{
        const root=await temporaryDirectory(t,{prefix:'arcane-npm-release-version-'});
        const tarballPath=path.join(root,'arcane-os-0.3.2.tgz');
        await writeFile(tarballPath,packageTarball({version:'0.3.1'}));
        await assert.rejects(
            verifyNpmReleaseArtifact({tarballPath,expectedVersion:'0.3.2'}),
            /does not equal 0\.3\.2/u
        );
    });

    await t.test('rejects repository-only paths',async()=>{
        const root=await temporaryDirectory(t,{prefix:'arcane-npm-release-path-'});
        const tarballPath=path.join(root,'arcane-os-0.3.2.tgz');
        await writeFile(tarballPath,packageTarball({extraFiles:[['tools/private.mjs','not shipped\n']]}));
        await assert.rejects(
            verifyNpmReleaseArtifact({tarballPath}),
            /outside the published package boundary/u
        );
    });

    await t.test('requires the selected legal and package entrypoints',async()=>{
        const root=await temporaryDirectory(t,{prefix:'arcane-npm-release-required-'});
        const tarballPath=path.join(root,'arcane-os-0.3.2.tgz');
        await writeFile(tarballPath,packageTarball({omit:['NOTICE']}));
        await assert.rejects(verifyNpmReleaseArtifact({tarballPath}),/NOTICE/u);
    });

    await t.test('requires the installed beginner speech guide',async function requiresSpeechGuide(){
        const root=await temporaryDirectory(t,{prefix:'arcane-npm-release-docs-'});
        const tarballPath=path.join(root,'arcane-os-0.3.2.tgz');
        await writeFile(tarballPath,packageTarball({omit:['docs/reference/ai/browser-speech.md']}));
        await assert.rejects(verifyNpmReleaseArtifact({tarballPath}),/docs\/reference\/ai\/browser-speech\.md/u);
    });
});

test('npm registry publication uses only version and selected tag state',async t=>{
    await t.test('maps numeric stable and development versions to npm channels',()=>{
        assert.deepEqual(parsePublicationVersion('0.3.2'),{
            version:'0.3.2',channel:'latest',parts:[0,3,2]
        });
        assert.deepEqual(parsePublicationVersion('0.4.0-dev.1'),{
            version:'0.4.0-dev.1',channel:'dev',parts:[0,4,0,1]
        });
        for(const invalid of ['v0.3.2','01.0.0','0.3.2-rc.1','0.3']){
            assert.throws(()=>parsePublicationVersion(invalid),/numeric stable or -dev/u);
        }
    });

    await t.test('parses registry versions and any ordinary dist-tag set',()=>{
        assert.deepEqual(parseRegistryVersions('"0.3.2"'),['0.3.2']);
        assert.deepEqual(parseRegistryVersions('["0.3.1","0.3.2"]'),['0.3.1','0.3.2']);
        assert.deepEqual(
            parseRegistryTags('{"latest":"0.3.2","dev":"0.4.0-dev.1","next":"0.4.0-dev.1"}'),
            {latest:'0.3.2',dev:'0.4.0-dev.1',next:'0.4.0-dev.1'}
        );
    });

    await t.test('publishes an absent version and idempotently observes an existing version',()=>{
        assert.deepEqual(evaluateRegistryPublication({
            version:'0.3.2',channel:'latest',versions:['0.3.1'],tags:{latest:'0.3.1'}
        }),{state:'publish',needsPublish:true,channel:'latest'});
        assert.deepEqual(evaluateRegistryPublication({
            version:'0.3.2',channel:'latest',versions:['0.3.1','0.3.2'],tags:{latest:'0.3.1'}
        }),{state:'pending',needsPublish:false,channel:'latest'});
        assert.deepEqual(evaluateRegistryPublication({
            version:'0.3.2',channel:'latest',versions:['0.3.1','0.3.2'],tags:{latest:'0.3.2'}
        }),{state:'published',needsPublish:false,channel:'latest'});
    });

    await t.test('reads only npm versions and dist-tags for preflight state',async()=>{
        const calls=[];
        const responses=new Map([
            ['view arcane-os versions --json','["0.3.1"]'],
            ['view arcane-os dist-tags --json','{"latest":"0.3.1"}']
        ]);
        const decision=await readRegistryPublicationState({
            version:'0.3.2',
            channel:'latest',
            read:async arguments_=>{
                const command=arguments_.join(' ');
                calls.push(command);
                return responses.get(command);
            }
        });
        assert.deepEqual(decision,{state:'publish',needsPublish:true,channel:'latest'});
        assert.deepEqual(calls,[...responses.keys()]);
    });
});

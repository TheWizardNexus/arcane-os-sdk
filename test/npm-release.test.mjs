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
    readRegistryPublicationState,
    readRegistryTarballAvailability
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

test('npm registry preflight uses only version and selected tag state',async t=>{
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

test('npm publication observes complete exact-version tarball delivery', publishedTarballAvailability);

async function publishedTarballAvailability(t) {
    const version = '0.3.2';
    const metadataUrl = 'https://registry.npmjs.org/arcane-os/0.3.2';
    const tarball = 'https://registry.npmjs.org/arcane-os/-/arcane-os-0.3.2.tgz';
    const metadata = {name: 'arcane-os', version, dist: {tarball}};

    await t.test('waits for full response completion and releases the reader', completeResponse);
    async function completeResponse() {
        const calls = [];
        const reading = Promise.withResolvers();
        const completion = Promise.withResolvers();
        const controller = new AbortController();
        let reads = 0;
        let released = false;
        let settled = false;
        const operation = readRegistryTarballAvailability(
            {
                version,
                signal: controller.signal,
                request: async function requestPublishedResource(url, options) {
                    calls.push(url);
                    assert.equal(options.signal, controller.signal);
                    if (url === metadataUrl) return Response.json(metadata);
                    assert.equal(url, tarball);
                    return {
                        status: 200,
                        body: {
                            getReader: function getTarballReader() {
                                return {
                                    read: async function readTarballChunk() {
                                        reads += 1;
                                        if (reads === 1) return {done: false, value: Uint8Array.of(1, 2, 3)};
                                        if (reads === 2) return {done: false, value: Uint8Array.of(4, 5, 6)};
                                        reading.resolve();
                                        return completion.promise;
                                    },
                                    releaseLock: function releaseTarballReader() {
                                        released = true;
                                    }
                                };
                            }
                        }
                    };
                }
            }
        );
        const observed = operation.then(
            function markAvailabilitySettled(result) {
                settled = true;
                return result;
            }
        );
        await Promise.race(
            [reading.promise, observed]
        );
        try {
            assert.equal(settled, false);
            assert.equal(released, false);
        } finally {
            completion.resolve(
                {done: true}
            );
            await observed;
        }
        assert.deepEqual(
            await observed,
            {available: true, tarball}
        );
        assert.equal(released, true);
        assert.deepEqual(
            calls,
            [metadataUrl, tarball]
        );
    }

    await t.test('metadata visibility does not conceal a missing tarball', missingTarball);
    async function missingTarball() {
        const diagnostic = 'The exact package is still being made available.\nRetry the same version.';
        const result = await readRegistryTarballAvailability(
            {
                version,
                request: async function requestMissingTarball(url) {
                    if (url === metadataUrl) return Response.json(metadata);
                    assert.equal(url, tarball);
                    return new Response(
                        diagnostic,
                        {status: 404}
                    );
                }
            }
        );
        assert.deepEqual(
            result,
            {available: false, reason: `dist.tarball HTTP 404: ${diagnostic}`}
        );
    }

    await t.test('reports missing exact-version metadata without requesting a tarball', missingMetadata);
    async function missingMetadata() {
        const calls = [];
        const result = await readRegistryTarballAvailability(
            {
                version,
                request: async function requestMissingMetadata(url) {
                    calls.push(url);
                    return new Response(
                        'Version not found',
                        {status: 404}
                    );
                }
            }
        );
        assert.deepEqual(
            result,
            {available: false, reason: 'Exact-version metadata HTTP 404: Version not found'}
        );
        assert.deepEqual(
            calls,
            [metadataUrl]
        );
    }

    await t.test('uses only the selected package version and its published URL', exactMetadata);
    async function exactMetadata() {
        for (const document of [null, {name: 'arcane-os', version}, {...metadata, version: '0.3.1'}, {...metadata, name: 'another-package'}]) {
            const calls = [];
            const result = await readRegistryTarballAvailability(
                {
                    version,
                    request: async function requestIncompleteMetadata(url) {
                        calls.push(url);
                        return Response.json(document);
                    }
                }
            );
            assert.equal(result.available, false);
            assert.match(result.reason, /Exact-version metadata/u);
            assert.deepEqual(
                calls,
                [metadataUrl]
            );
        }
    }

    await t.test('does not treat no content or partial content as a complete download', incompleteResponseStatus);
    async function incompleteResponseStatus() {
        for (const status of [204, 206]) {
            const result = await readRegistryTarballAvailability(
                {
                    version,
                    request: async function requestIncompleteTarball(url) {
                        if (url === metadataUrl) return Response.json(metadata);
                        return new Response(
                            null,
                            {status}
                        );
                    }
                }
            );
            assert.deepEqual(
                result,
                {available: false, reason: `dist.tarball HTTP ${status}: `}
            );
        }
    }

    await t.test('preserves a response-body failure and releases the reader', failedResponseBody);
    async function failedResponseBody() {
        let released = false;
        const result = await readRegistryTarballAvailability(
            {
                version,
                request: async function requestInterruptedTarball(url) {
                    if (url === metadataUrl) return Response.json(metadata);
                    return {
                        status: 200,
                        body: {
                            getReader: function getInterruptedReader() {
                                return {
                                    read: async function readInterruptedBody() {
                                        throw new Error('Connection ended during the package response.');
                                    },
                                    releaseLock: function releaseInterruptedReader() {
                                        released = true;
                                    }
                                };
                            }
                        }
                    };
                }
            }
        );
        assert.deepEqual(
            result,
            {available: false, reason: 'Connection ended during the package response.'}
        );
        assert.equal(released, true);
    }

    await t.test('propagates the owned abort signal and preserves the actual failure', abortedDownload);
    async function abortedDownload() {
        const controller = new AbortController();
        const reason = new Error('The remaining verification window elapsed.');
        const result = await readRegistryTarballAvailability(
            {
                version,
                signal: controller.signal,
                request: async function requestAbortedTarball(url, options) {
                    assert.equal(options.signal, controller.signal);
                    if (url === metadataUrl) return Response.json(metadata);
                    controller.abort(reason);
                    options.signal.throwIfAborted();
                }
            }
        );
        assert.deepEqual(
            result,
            {available: false, reason: reason.message}
        );
    }
}

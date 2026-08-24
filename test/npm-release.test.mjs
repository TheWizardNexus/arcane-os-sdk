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
    comparePublicationVersions,
    evaluateRegistryPublication,
    executeNpmRead,
    npmProvenanceAuditArguments,
    parsePublicationVersion,
    parseRegistryDist,
    parseRegistryTags,
    parseRegistryVersions,
    readRegistryPublicationState,
    validateContentClassification,
    validateNpmProvenance
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

test('npm registry publication is strict, channel-aware, and immutable',async t=>{
    const bootstrap={
        version:'0.1.0-dev.5',
        integrity:'sha512-8cUo/Us9PthnPk5c4r9Td7dx6ERKALAUiVL4dprWh5fGf3jGm89uB4fVpXktLErWnw81r7aGmq8LXHLPEMrz7g==',
        shasum:'d65bf41e0c3f8d2220856bd02067cd7d2968136e'
    };
    const candidateBytes=Buffer.from('stable Arcane package bytes\n');
    const candidate={
        version:'0.1.0',
        integrity:`sha512-${digest(candidateBytes,'sha512','base64')}`,
        shasum:digest(candidateBytes,'sha1')
    };
    candidate.expectedIntegrity=candidate.integrity;
    candidate.expectedShasum=candidate.shasum;
    const bootstrapState={
        versions:[bootstrap.version],
        tags:{dev:bootstrap.version,latest:bootstrap.version},
        candidateDist:null,
        bootstrapDist:{integrity:bootstrap.integrity,shasum:bootstrap.shasum}
    };

    await t.test('accepts only strict stable and development channels',()=>{
        assert.deepEqual(parsePublicationVersion('0.1.0'),{
            version:'0.1.0',channel:'latest',parts:[0,1,0]
        });
        assert.deepEqual(parsePublicationVersion('0.2.0-dev.1'),{
            version:'0.2.0-dev.1',channel:'dev',parts:[0,2,0,1]
        });
        assert.equal(comparePublicationVersions('0.1.0','0.1.0-dev.5'),1);
        assert.equal(compareDevelopmentVersions('0.2.0-dev.1','0.1.0-dev.99'),1);
        for(const invalid of ['v0.1.0','01.0.0','0.1.0-rc.1','0.1.0+build','0.1']){
            assert.throws(()=>parsePublicationVersion(invalid),/numeric stable or -dev/u);
        }
    });

    await t.test('requires an explicit standard or persistent dual-use classification',()=>{
        assert.throws(()=>validateContentClassification({
            classification:'unresolved',packageDocument:{name:'arcane-os'},disclosureExists:false
        }),/explicitly classify/u);
        assert.deepEqual(validateContentClassification({
            classification:'standard',packageDocument:{name:'arcane-os'},disclosureExists:false
        }),{classification:'standard',mode:'direct'});
        assert.throws(()=>validateContentClassification({
            classification:'dual-use',packageDocument:{name:'arcane-os'},disclosureExists:false
        }),/contentPolicy/u);
        assert.deepEqual(validateContentClassification({
            classification:'dual-use',
            packageDocument:{
                name:'arcane-os',contentPolicy:{class:'dual-use'},files:['DISCLOSURE']
            },
            disclosureExists:true
        }),{classification:'dual-use',mode:'staged'});
    });

    await t.test('strictly parses registry versions, tags, and dist identity',()=>{
        assert.deepEqual(parseRegistryVersions('["0.1.0-dev.5","0.1.0"]'),[
            '0.1.0-dev.5','0.1.0'
        ]);
        assert.deepEqual(
            parseRegistryTags('{"dev":"0.1.0-dev.5","latest":"0.1.0"}'),
            {dev:'0.1.0-dev.5',latest:'0.1.0'}
        );
        assert.deepEqual(
            parseRegistryDist(JSON.stringify({
                'dist.integrity':candidate.integrity,'dist.shasum':candidate.shasum
            })),
            {integrity:candidate.integrity,shasum:candidate.shasum}
        );
        assert.throws(()=>parseRegistryDist(JSON.stringify({
            'dist.integrity':candidate.integrity,'dist.shasum':candidate.shasum,
            'dist.tarball':'https://example.invalid'
        })),/exactly dist\.integrity and dist\.shasum/u);
        assert.throws(()=>parseRegistryVersions('{}'),/JSON array/u);
        assert.throws(()=>parseRegistryVersions('["0.1.0","0.1.0"]'),/duplicate/u);
        assert.throws(()=>parseRegistryVersions('["0.1.0-rc.1"]'),/numeric stable or -dev/u);
        assert.throws(()=>parseRegistryTags('{"dev":"0.1.0-dev.5"}'),/exactly/u);
        assert.throws(
            ()=>parseRegistryTags('{"dev":"0.1.0-dev.5","latest":"0.1.0-dev.5","next":"0.2.0-dev.1"}'),
            /exactly/u
        );
        assert.throws(()=>parseRegistryDist('{'),/malformed JSON/u);
    });

    await t.test('admits only the exact recorded first-version bootstrap tuple',()=>{
        assert.deepEqual(evaluateRegistryPublication({...candidate,...bootstrapState}),{
            state:'publish',needsPublish:true,channel:'latest',
            preservedTag:'dev',preservedVersion:bootstrap.version
        });
        for(const mutation of [
            {bootstrapDist:{integrity:candidate.integrity,shasum:bootstrap.shasum}},
            {tags:{dev:bootstrap.version,latest:'0.1.0-dev.4'}},
            {versions:[bootstrap.version,'0.0.9'],tags:{dev:bootstrap.version,latest:bootstrap.version}},
            {versions:[bootstrap.version,'0.2.0'],tags:{dev:bootstrap.version,latest:'0.1.0'}}
        ]){
            assert.throws(
                ()=>evaluateRegistryPublication({...candidate,...bootstrapState,...mutation}),
                /(bootstrap|dist-tag|highest published stable|listed package version)/u
            );
        }
    });

    await t.test('publishes forward on one tag and preserves the other tag',()=>{
        assert.deepEqual(evaluateRegistryPublication({
            version:'0.1.0-dev.6',
            expectedIntegrity:candidate.integrity,
            expectedShasum:candidate.shasum,
            ...bootstrapState
        }),{
            state:'publish',needsPublish:true,channel:'dev',
            preservedTag:'latest',preservedVersion:bootstrap.version
        });
        assert.deepEqual(evaluateRegistryPublication({
            ...candidate,
            versions:[bootstrap.version,candidate.version],
            tags:{dev:bootstrap.version,latest:candidate.version},
            candidateDist:{integrity:candidate.integrity,shasum:candidate.shasum},
            bootstrapDist:null
        }),{
            state:'published',needsPublish:false,channel:'latest',
            preservedTag:'dev',preservedVersion:bootstrap.version
        });
    });

    await t.test('rejects immutable mismatch, downgrade, hidden stable, and tag drift',()=>{
        const stableState={
            versions:[bootstrap.version,'0.1.0'],
            tags:{dev:bootstrap.version,latest:'0.1.0'},
            candidateDist:null,bootstrapDist:null
        };
        assert.throws(()=>evaluateRegistryPublication({
            ...candidate,...stableState,
            version:'0.0.9'
        }),/move latest backward/u);
        assert.throws(()=>evaluateRegistryPublication({
            ...candidate,
            versions:[bootstrap.version,'0.1.0','0.2.0'],
            tags:{dev:bootstrap.version,latest:'0.1.0'},candidateDist:null,bootstrapDist:null
        }),/highest published stable/u);
        assert.throws(()=>evaluateRegistryPublication({
            ...candidate,
            versions:[bootstrap.version,candidate.version],
            tags:{dev:bootstrap.version,latest:candidate.version},
            candidateDist:{integrity:bootstrap.integrity,shasum:candidate.shasum},bootstrapDist:null
        }),/different immutable/u);
        assert.throws(()=>evaluateRegistryPublication({
            ...candidate,
            versions:[bootstrap.version,candidate.version],
            tags:{dev:bootstrap.version,latest:bootstrap.version},
            candidateDist:{integrity:candidate.integrity,shasum:candidate.shasum},bootstrapDist:null
        }),/(highest published stable|matching bytes)/u);
    });

    await t.test('executes only strict npm JSON reads including bootstrap evidence',()=>{
        const executed=[];
        const responses=new Map([
            ['view arcane-os versions --json',JSON.stringify([bootstrap.version])],
            ['view arcane-os dist-tags --json',JSON.stringify({dev:bootstrap.version,latest:bootstrap.version})],
            [`view arcane-os@${candidate.version} dist.integrity dist.shasum --json`,null],
            [`view arcane-os@${bootstrap.version} dist.integrity dist.shasum --json`,JSON.stringify({
                'dist.integrity':bootstrap.integrity,'dist.shasum':bootstrap.shasum
            })]
        ]);
        const read=arguments_=>{
            const command=arguments_.join(' ');
            executed.push(command);
            return responses.get(command);
        };
        assert.deepEqual(readRegistryPublicationState({
            version:candidate.version,
            expectedIntegrity:candidate.integrity,
            expectedShasum:candidate.shasum,
            read
        }),{
            state:'publish',needsPublish:true,channel:'latest',
            preservedTag:'dev',preservedVersion:bootstrap.version
        });
        assert.deepEqual(executed,[...responses.keys()]);
        const command=[];
        assert.equal(executeNpmRead(['view','arcane-os','versions','--json'],(
            executable,arguments_
        )=>{
            command.push(executable,...arguments_);
            return '["0.1.0-dev.5"]\n';
        }),'["0.1.0-dev.5"]');
        assert.deepEqual(command,process.platform==='win32'
            ?[process.env.ComSpec??'cmd.exe','/d','/s','/c','npm','view','arcane-os','versions','--json']
            :['npm','view','arcane-os','versions','--json']);
    });

    await t.test('uses the exact npm attestation audit command',()=>{
        assert.deepEqual(npmProvenanceAuditArguments(),[
            'audit','signatures','--json','--include-attestations'
        ]);
    });
});

function attestationStatement({statementType,predicateType,predicate,version,integrity}){
    return {
        _type:statementType,
        subject:[{
            name:`pkg:npm/arcane-os@${version}`,
            digest:{sha512:Buffer.from(integrity.slice('sha512-'.length),'base64').toString('hex')}
        }],
        predicateType,
        predicate
    };
}

function attestationBundle(statement){
    return {
        mediaType:'application/vnd.dev.sigstore.bundle+json;version=0.1',
        verificationMaterial:{tlogEntries:[{}]},
        dsseEnvelope:{
            payload:Buffer.from(JSON.stringify(statement)).toString('base64'),
            payloadType:'application/vnd.in-toto+json',
            signatures:[{sig:'verified-by-npm'}]
        }
    };
}

test('npm provenance binds exact bytes to the trusted main workflow',async t=>{
    const bytes=Buffer.from('published stable bytes\n');
    const version='0.1.0';
    const integrity=`sha512-${digest(bytes,'sha512','base64')}`;
    const sourceCommit='1'.repeat(40);
    const slsaType='https://slsa.dev/provenance/v1';
    const publishType='https://github.com/npm/attestation/tree/main/specs/publish/v0.1';
    const slsa=attestationStatement({
        statementType:'https://in-toto.io/Statement/v1',
        predicateType:slsaType,version,integrity,
        predicate:{
            buildDefinition:{
                buildType:'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
                externalParameters:{workflow:{
                    repository:'https://github.com/TheWizardNexus/arcane-os-sdk',
                    path:'.github/workflows/publish-dev.yml',ref:'refs/heads/main'
                }},
                internalParameters:{github:{
                    event_name:'workflow_dispatch',
                    repository_id:'123456789',
                    repository_owner_id:'987654321'
                }},
                resolvedDependencies:[{
                    uri:'git+https://github.com/TheWizardNexus/arcane-os-sdk@refs/heads/main',
                    digest:{gitCommit:sourceCommit}
                }]
            },
            runDetails:{
                builder:{id:'https://github.com/actions/runner/github-hosted'},
                metadata:{
                    invocationId:'https://github.com/TheWizardNexus/arcane-os-sdk/actions/runs/32779509292/attempts/1'
                }
            }
        }
    });
    const publish=attestationStatement({
        statementType:'https://in-toto.io/Statement/v0.1',
        predicateType:publishType,version,integrity,
        predicate:{name:'arcane-os',version,registry:'https://registry.npmjs.org'}
    });
    const auditDocument={
        invalid:[],missing:[],
        verified:[{
            name:'arcane-os',version,location:'node_modules/arcane-os',
            registry:'https://registry.npmjs.org/',
            attestations:{provenance:{predicateType:slsaType}},
            attestationBundles:[
                {predicateType:slsaType,bundle:attestationBundle(slsa)},
                {predicateType:publishType,bundle:attestationBundle(publish)}
            ]
        }]
    };

    await t.test('accepts npm-verified SLSA and publish bundles for the exact artifact',()=>{
        assert.deepEqual(validateNpmProvenance({auditDocument,version,integrity,sourceCommit}),{
            version,integrity,sourceCommit,slsaPredicateType:slsaType,publishPredicateType:publishType
        });
    });

    await t.test('rejects missing, invalid, duplicate, or workflow-drifted evidence',()=>{
        const invalid=structuredClone(auditDocument);
        invalid.invalid.push({name:'arcane-os'});
        assert.throws(()=>validateNpmProvenance({
            auditDocument:invalid,version,integrity,sourceCommit
        }),/invalid or missing/u);
        const duplicate=structuredClone(auditDocument);
        duplicate.verified.push(structuredClone(duplicate.verified[0]));
        assert.throws(()=>validateNpmProvenance({
            auditDocument:duplicate,version,integrity,sourceCommit
        }),/exactly one candidate/u);
        const drifted=structuredClone(auditDocument);
        const statement=attestationStatement({
            statementType:'https://in-toto.io/Statement/v1',
            predicateType:slsaType,version,integrity,
            predicate:{
                ...slsa.predicate,
                buildDefinition:{
                    ...slsa.predicate.buildDefinition,
                    externalParameters:{workflow:{
                        ...slsa.predicate.buildDefinition.externalParameters.workflow,
                        repository:'https://github.com/attacker/repo'
                    }}
                }
            }
        });
        drifted.verified[0].attestationBundles[0].bundle=attestationBundle(statement);
        assert.throws(()=>validateNpmProvenance({
            auditDocument:drifted,version,integrity,sourceCommit
        }),/trusted main publication workflow/u);
        const wrongStatementType=structuredClone(auditDocument);
        const wrongStatement=structuredClone(slsa);
        wrongStatement._type='https://in-toto.io/Statement/v0.1';
        wrongStatementType.verified[0].attestationBundles[0].bundle=attestationBundle(wrongStatement);
        assert.throws(()=>validateNpmProvenance({
            auditDocument:wrongStatementType,version,integrity,sourceCommit
        }),/expected in-toto statement/u);
        const noncanonicalPayload=structuredClone(auditDocument);
        noncanonicalPayload.verified[0].attestationBundles[0].bundle.dsseEnvelope.payload+='=';
        assert.throws(()=>validateNpmProvenance({
            auditDocument:noncanonicalPayload,version,integrity,sourceCommit
        }),/not canonical base64/u);
    });

    await t.test('rejects a provenance subject for different immutable bytes',()=>{
        const mismatched=structuredClone(auditDocument);
        const statement=JSON.parse(Buffer.from(
            mismatched.verified[0].attestationBundles[0].bundle.dsseEnvelope.payload,'base64'
        ).toString('utf8'));
        statement.subject[0].digest.sha512='0'.repeat(128);
        mismatched.verified[0].attestationBundles[0].bundle=attestationBundle(statement);
        assert.throws(()=>validateNpmProvenance({
            auditDocument:mismatched,version,integrity,sourceCommit
        }),/exact package version and SHA-512/u);
    });
});

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {repositoryRoot} from './helpers.mjs';
import {normalizeRelativePath,parseSemver} from '../src/packager/core.mjs';
import {listTargets} from '../src/targets/index.mjs';
import * as sdk from '../src/index.mjs';

async function readSchema(fileName){
    return JSON.parse(await readFile(path.join(repositoryRoot,'schemas',fileName),'utf8'));
}

function accepts(operation,value){
    try{
        operation(value);
        return true;
    }catch{
        return false;
    }
}

test('published JSON schemas parse and declare immutable protocol versions',async t=>{
    const cases=new Map([
        ['arcane-app.schema.json',2],
        ['arcane-package.schema.json',1],
        ['arcane-lock.schema.json',1],
        ['cli-event.schema.json','arcane-cli-events/1'],
        ['native-build-plan.schema.json','arcane-native-build-plan/1'],
        ['target-adapter.schema.json','arcane-target-adapter/1']
    ]);

    for(const [fileName,expected] of cases){
        await t.test(`${fileName} declares its immutable protocol`,async()=>{
            const document=await readSchema(fileName);
            assert.equal(document.$schema,'https://json-schema.org/draft/2020-12/schema');
            if(fileName==='arcane-app.schema.json'||fileName==='arcane-package.schema.json'||fileName==='arcane-lock.schema.json'){
                assert.equal(document.properties.schemaVersion.const,expected);
            }else if(fileName==='cli-event.schema.json'){
                assert.equal(document.properties.protocol.const,expected);
            }else{
                assert.equal(document.properties.protocol.const,expected);
            }
        });
    }
});

test('package exposes both supported executable names and public contracts',async t=>{
    const packageDocument=JSON.parse(await readFile(path.join(repositoryRoot,'package.json'),'utf8'));
    const integratedProvider=await import('arcane-os/integrated-provider');
    const testing=await import('arcane-os/testing');

    await t.test('supports both executable aliases',()=>{
        assert.deepEqual(packageDocument.bin,{
            arcane:'./bin/arcane.mjs',
            'arcane-os':'./bin/arcane.mjs'
        });
    });
    await t.test('exports every published JSON schema',()=>{
        assert.equal(packageDocument.exports['./schemas/arcane-app.json'],'./schemas/arcane-app.schema.json');
        assert.equal(packageDocument.exports['./schemas/arcane-package.json'],'./schemas/arcane-package.schema.json');
        assert.equal(packageDocument.exports['./schemas/arcane-lock.json'],'./schemas/arcane-lock.schema.json');
        assert.equal(packageDocument.exports['./schemas/cli-event.json'],'./schemas/cli-event.schema.json');
        assert.equal(packageDocument.exports['./schemas/native-build-plan.json'],'./schemas/native-build-plan.schema.json');
        assert.equal(packageDocument.exports['./schemas/target-adapter.json'],'./schemas/target-adapter.schema.json');
    });
    await t.test('exports the integrated provider and testing entry points',()=>{
        assert.equal(packageDocument.exports['./integrated-provider'],'./src/integrated-provider-loader.mjs');
        assert.equal(packageDocument.exports['./testing'],'./src/testing.mjs');
    });
    await t.test('pins the Vanilla Test runtime',()=>{
        assert.equal(packageDocument.dependencies['vanilla-test'],'2.1.3');
    });
    await t.test('integrated provider entry point exposes its public protocol',()=>{
        assert.equal(typeof integratedProvider.loadArcaneIntegratedProvider,'function');
        assert.equal(integratedProvider.INTEGRATED_TOOLCHAIN_PROTOCOL,'arcane-integrated-toolchain/1');
    });
    await t.test('testing entry point exposes registration and execution',()=>{
        assert.equal(typeof testing.test,'function');
        assert.equal(typeof testing.runRegisteredTests,'function');
    });
});

test('root SDK export exposes receipt authenticators and verified file readers',async t=>{
    await t.test('exposes receipt authentication and verified readers',()=>{
        assert.equal(typeof sdk.authenticateRuntimeReceipt,'function');
        assert.equal(typeof sdk.authenticateAppReleaseReceipt,'function');
        assert.equal(typeof sdk.authenticateAppReleaseAuthority,'function');
        assert.equal(typeof sdk.authenticateSharedPayloadSnapshot,'function');
        assert.equal(typeof sdk.prepareSharedPayloadSnapshot,'function');
        assert.equal(typeof sdk.readVerifiedAppReleaseFile,'function');
        assert.equal(typeof sdk.readVerifiedRuntimeFile,'function');
    });
    await t.test('exposes descriptor validation and projections',()=>{
        assert.equal(typeof sdk.validateAppDescriptor,'function');
        assert.equal(typeof sdk.appDescriptorSha256,'function');
        assert.equal(typeof sdk.projectPackageManifest,'function');
        assert.equal(typeof sdk.projectNativeDescriptor,'function');
    });
    await t.test('exposes native build-plan lifecycle functions',()=>{
        assert.equal(typeof sdk.createNativeBuildPlan,'function');
        assert.equal(typeof sdk.assertNativeToolchainCompatibility,'function');
        assert.equal(typeof sdk.authenticateNativeBuildPlan,'function');
        assert.equal(typeof sdk.executeNativeBuildPlan,'function');
        assert.equal(typeof sdk.validateNativeBuilder,'function');
    });
    await t.test('exposes native target planning and verification',()=>{
        assert.equal(typeof sdk.createNativeTargetAdapter,'function');
        assert.equal(typeof sdk.planApplication,'function');
        assert.equal(typeof sdk.doctorNativeTarget,'function');
        assert.equal(typeof sdk.prepareNativeTarget,'function');
        assert.equal(typeof sdk.verifyNativeArtifact,'function');
    });
    await t.test('exposes provider loading and compatibility contracts',()=>{
        assert.equal(typeof sdk.loadArcaneNativeProvider,'function');
        assert.equal(typeof sdk.loadArcanePortableProvider,'function');
        assert.equal(typeof sdk.loadArcaneIntegratedProvider,'function');
        assert.equal(sdk.INTEGRATED_TOOLCHAIN_PROTOCOL,'arcane-integrated-toolchain/1');
        assert.ok(Array.isArray(sdk.ARCANE_INTEGRATED_PROVIDER_RELATIVE_PATH));
        assert.equal(typeof sdk.ARCANE_NATIVE_PROVIDER_PATHS,'object');
        assert.equal(typeof sdk.resolveNativeBuildOutputRoot,'function');
        assert.equal(typeof sdk.assertIntegratedNativeToolchain,'function');
        assert.equal(typeof sdk.assertNativeApplicationToolchainCompatibility,'function');
    });
});

test('package schema string rules match the packager validators',async t=>{
    const schema=await readSchema('arcane-package.schema.json');
    const semver=new RegExp(schema.properties.version.pattern);
    for(const version of [
        '0.1.0',
        '0.1.0-dev.0',
        '12.34.56-alpha-1+build.9'
    ]){
        await t.test(`semantic version accepts ${version}`,()=>{
            assert.equal(semver.test(version),accepts(parseSemver,version),version);
        });
    }
    for(const version of [
        '01.0.0',
        '1.0.0-01',
        '1.0.0-alpha.01',
        '1.0',
        'v1.0.0'
    ]){
        await t.test(`semantic version rejects ${version}`,()=>{
            assert.equal(semver.test(version),accepts(parseSemver,version),version);
        });
    }

    const relativePath=new RegExp(schema.$defs.relativePath.pattern);
    for(const filePath of [
        'index.html',
        'modules/App.js',
        '.well-known/metadata.json',
        'folder name/file.js',
        '/absolute',
        'C:/absolute',
        'modules\\App.js',
        'modules//App.js',
        'modules/../App.js',
        'modules/App.js.',
        'CON',
        'assets/lpt1.txt'
    ]){
        await t.test(`relative path validator agrees for ${filePath}`,()=>{
            assert.equal(
                relativePath.test(filePath),
                accepts(value=>normalizeRelativePath(value,'schema test'),filePath),
                filePath
            );
        });
    }

    const literalPath=new RegExp(schema.$defs.literalRelativePath.allOf[1].pattern);
    await t.test('literal paths admit a concrete module',()=>{
        assert.equal(literalPath.test('modules/App.js'),true);
    });
    await t.test('literal paths reject glob syntax',()=>{
        assert.equal(literalPath.test('modules/*.js'),false);
    });
    const presentation=new RegExp(schema.properties.displayName.pattern);
    await t.test('display names admit surrounding whitespace',()=>{
        assert.equal(presentation.test(' Arcane App '),true);
    });
    await t.test('display names reject whitespace-only values',()=>{
        assert.equal(presentation.test('   '),false);
    });
    await t.test('display names reject markup delimiters',()=>{
        assert.equal(presentation.test('<Arcane App>'),false);
    });
    const modelName=schema.$defs.localAIModelPolicy.properties.models.items.properties.name;
    await t.test('local model names admit provider-local tags',()=>{
        assert.equal(new RegExp(modelName.pattern).test('llama3.2:latest'),true);
    });
    await t.test('local model names retain the hosted-provider exclusion',()=>{
        assert.equal(new RegExp(modelName.not.pattern).test('openai'),true);
    });
});

test('lock and target schemas pin the emitted SDK contracts',async t=>{
    const [packageDocument,lockSchema,targetSchema]=await Promise.all([
        readFile(path.join(repositoryRoot,'package.json'),'utf8').then(JSON.parse),
        readSchema('arcane-lock.schema.json'),
        readSchema('target-adapter.schema.json')
    ]);
    await t.test('lock schema pins the current SDK version',()=>{
        assert.equal(lockSchema.properties.sdk.properties.version.const,packageDocument.version);
    });

    const allowedKeys=new Set(Object.keys(targetSchema.properties));
    for(const descriptor of listTargets()){
        await t.test(`${descriptor.id} matches the target-adapter schema`,()=>{
            assert.deepEqual(Object.keys(descriptor).filter(key=>!allowedKeys.has(key)),[]);
            for(const required of targetSchema.required){
                assert.ok(Object.hasOwn(descriptor,required),`${descriptor.id} omitted ${required}`);
            }
            assert.equal(descriptor.protocol,targetSchema.properties.protocol.const);
            assert.ok(targetSchema.properties.status.enum.includes(descriptor.status));
            assert.ok(descriptor.formats.length>=targetSchema.properties.formats.minItems);
            assert.ok(descriptor.signingModes.length>=targetSchema.properties.signingModes.minItems);
            for(const format of descriptor.formats){
                assert.ok(targetSchema.properties.formats.items.enum.includes(format));
            }
            for(const signingMode of descriptor.signingModes){
                assert.ok(targetSchema.properties.signingModes.items.enum.includes(signingMode));
            }
            assert.deepEqual(descriptor.methods,targetSchema.properties.methods.const);
        });
    }
});

test('native build plan schema uses the packager semantic-version contract',async t=>{
    const [packageSchema,nativePlanSchema]=await Promise.all([
        readSchema('arcane-package.schema.json'),
        readSchema('native-build-plan.schema.json')
    ]);
    await t.test('reuses the package semantic-version definition',()=>{
        assert.equal(nativePlanSchema.$defs.semver.pattern,packageSchema.properties.version.pattern);
        assert.deepEqual(nativePlanSchema.properties.minimumCoreVersion,{$ref:'#/$defs/semver'});
        assert.deepEqual(nativePlanSchema.$defs.toolchain.properties.version,{$ref:'#/$defs/semver'});
    });
    await t.test('publishes the provider-generation reference and discriminator',()=>{
        assert.deepEqual(nativePlanSchema.properties.providerGeneration,{$ref:'#/$defs/providerGeneration'});
        assert.equal(
            nativePlanSchema.$defs.providerGeneration.properties.kind.const,
            'arcane-native-provider-generation'
        );
    });
});

test('native build plan schema publishes only the exact dev.2 target matrix',async t=>{
    const schema=await readSchema('native-build-plan.schema.json');
    const variants=schema.$defs.targetRequest.oneOf.map(variant=>({
        target:variant.properties.target.const,
        platforms:variant.properties.platform.enum??[variant.properties.platform.const],
        architectures:variant.properties.architecture.enum??[variant.properties.architecture.const],
        format:variant.properties.format.const,
        signing:variant.properties.signing.$ref
    }));
    await t.test('publishes the exact target, platform, format, and signing matrix',()=>{
        assert.deepEqual(variants,[
            {
                target:'portable',
                platforms:['windows','linux'],
                architectures:['x64','arm64'],
                format:'portable',
                signing:'#/$defs/unsignedLocalSigning'
            },
            {
                target:'windows-x64',
                platforms:['windows'],
                architectures:['x64'],
                format:'exe',
                signing:'#/$defs/unsignedLocalSigning'
            },
            {
                target:'linux-x64',
                platforms:['linux'],
                architectures:['x64'],
                format:'deb',
                signing:'#/$defs/unsignedLocalSigning'
            },
            {
                target:'linux-arm64',
                platforms:['linux'],
                architectures:['arm64'],
                format:'deb',
                signing:'#/$defs/unsignedLocalSigning'
            },
            {
                target:'android-arm64',
                platforms:['android'],
                architectures:['arm64'],
                format:'apk',
                signing:'#/$defs/androidDevelopmentSigning'
            }
        ]);
    });
    await t.test('defines unsigned local signing exactly',()=>{
        assert.deepEqual(schema.$defs.unsignedLocalSigning.properties,{
            mode:{const:'unsigned-local-test'},
            profileId:{type:'null'}
        });
    });
    await t.test('defines Android development signing exactly',()=>{
        assert.deepEqual(schema.$defs.androidDevelopmentSigning.properties,{
            mode:{const:'development'},
            profileId:{const:'arcane-android-development-v1'}
        });
    });
    await t.test('excludes deferred formats and production signing',()=>{
        assert.doesNotMatch(
            JSON.stringify({
                targetRequest:schema.$defs.targetRequest,
                unsignedLocalSigning:schema.$defs.unsignedLocalSigning,
                androidDevelopmentSigning:schema.$defs.androidDevelopmentSigning
            }),
            /appimage|rpm|aab|production/u
        );
    });
});

test('CI and trusted publishing workflows retain their main-only authority gates',async t=>{
    const [checkWorkflow,publishWorkflow]=await Promise.all([
        readFile(path.join(repositoryRoot,'.github','workflows','check.yml'),'utf8'),
        readFile(path.join(repositoryRoot,'.github','workflows','publish-dev.yml'),'utf8')
    ]);
    await t.test('Check runs only for main pull requests and pushes',()=>{
        assert.match(checkWorkflow,/pull_request:\s*\n\s+branches:\s*\n\s+- main/u);
        assert.match(checkWorkflow,/push:\s*\n\s+branches:\s*\n\s+- main/u);
        assert.doesNotMatch(checkWorkflow,/\n\s+- dev\s*$/mu);
    });
    await t.test('Check covers every supported Node and runner platform',()=>{
        assert.match(checkWorkflow,/os:\s*[\s\S]*ubuntu-latest[\s\S]*windows-latest/u);
        assert.match(checkWorkflow,/node:\s*[\s\S]*- 22[\s\S]*- 24/u);
    });
    await t.test('Check installs and exercises both command aliases',()=>{
        assert.match(checkWorkflow,/npm install --global --ignore-scripts \./u);
        assert.match(checkWorkflow,/\n\s+arcane --version\s*\n\s+arcane-os --help/u);
    });

    await t.test('development publishing is manual and restricted to canonical main',()=>{
        assert.match(publishWorkflow,/workflow_dispatch:/u);
        assert.match(publishWorkflow,/id-token:\s*write/u);
        assert.match(publishWorkflow,/if:[^\n]*github\.ref == 'refs\/heads\/main'/u);
        assert.match(publishWorkflow,/environment:\s*\n\s+name:\s*npm/u);
        assert.match(publishWorkflow,/test "\$GITHUB_REPOSITORY" = "TheWizardNexus\/arcane-os-sdk"/u);
        assert.match(publishWorkflow,/test "\$GITHUB_REF" = "refs\/heads\/main"/u);
        assert.match(publishWorkflow,/actions:\s*read/u);
    });
    await t.test('development publishing reuses the exact successful main Check',()=>{
        assert.match(publishWorkflow,/actions\/workflows\/check\.yml\/runs/u);
        assert.match(publishWorkflow,/-f branch=main/u);
        assert.match(publishWorkflow,/-f event=push/u);
        assert.match(publishWorkflow,/-f status=success/u);
        assert.match(publishWorkflow,/-f head_sha="\$GITHUB_SHA"/u);
        assert.doesNotMatch(publishWorkflow,/npm run check/u);
        assert.doesNotMatch(publishWorkflow,/npm ci/u);
    });
    await t.test('trusted publishing uses the reviewed npm release',()=>{
        assert.match(publishWorkflow,/npm install --global npm@11\.16\.0/u);
    });
});

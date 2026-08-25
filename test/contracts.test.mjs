import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import test from '../src/testing.mjs';
import {repositoryRoot,temporaryDirectory} from './helpers.mjs';
import {normalizeRelativePath,parseSemver} from '../src/packager/core.mjs';
import {validateAppBundlePath} from '../src/release-bundle.mjs';
import {listTargets} from '../src/targets/index.mjs';
import * as sdk from '../src/index.mjs';

const execFileAsync=promisify(execFile);

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
        ['arcane-app-bundle.schema.json',1],
        ['arcane-lock.schema.json',1],
        ['cli-event.schema.json','arcane-cli-events/1'],
        ['event-stack.schema.json','arcane-event-stack/1'],
        ['native-build-plan.schema.json','arcane-native-build-plan/1'],
        ['target-adapter.schema.json','arcane-target-adapter/1']
    ]);

    for(const [fileName,expected] of cases){
        await t.test(`${fileName} declares its immutable protocol`,async()=>{
            const document=await readSchema(fileName);
            assert.equal(document.$schema,'https://json-schema.org/draft/2020-12/schema');
            if(fileName==='arcane-app.schema.json'||fileName==='arcane-package.schema.json'
                ||fileName==='arcane-app-bundle.schema.json'||fileName==='arcane-lock.schema.json'){
                assert.equal(document.properties.schemaVersion.const,expected);
            }else if(fileName==='cli-event.schema.json'){
                assert.equal(document.properties.protocol.const,expected);
            }else if(fileName==='event-stack.schema.json'){
                assert.equal(document.properties.protocol.const,expected);
            }else{
                assert.equal(document.properties.protocol.const,expected);
            }
        });
    }
    await t.test('app bundle schema requires a nonempty, nonzero payload',async()=>{
        const document=await readSchema('arcane-app-bundle.schema.json');
        assert.equal(document.properties.release.properties.fileCount.minimum,1);
        assert.equal(document.properties.release.properties.totalBytes.minimum,1);
        assert.equal(document.properties.payload.properties.fileCount.minimum,1);
        assert.equal(document.properties.payload.properties.totalBytes.minimum,1);
        assert.equal(document.properties.payload.properties.files.minItems,1);
    });
    await t.test('all published path contracts reject Windows aliases and unsafe filename characters',async()=>{
        const documents=await Promise.all([
            readSchema('arcane-app.schema.json'),
            readSchema('arcane-package.schema.json'),
            readSchema('arcane-app-bundle.schema.json')
        ]);
        for(const filePath of [
            'CLOCK$',
            'assets/CONIN$.json',
            'CONOUT$/child.js',
            'models/COM¹.modelfile',
            'devices/lpt²/value.json',
            'assets/less<than.js',
            'assets/greater>than.js',
            'assets/double"quote.js',
            'assets/vertical|bar.js',
            'assets/question?mark.js',
            'assets/asterisk*.js'
        ]){
            for(const document of documents){
                assert.equal(new RegExp(document.$defs.relativePath.pattern,'u').test(filePath),false,filePath);
            }
            assert.equal(accepts(value=>normalizeRelativePath(value,'schema test'),filePath),false,filePath);
            assert.equal(accepts(value=>validateAppBundlePath(value,'schema test'),filePath),false,filePath);
        }
    });
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
        assert.equal(packageDocument.exports['./schemas/arcane-app-bundle.json'],'./schemas/arcane-app-bundle.schema.json');
        assert.equal(packageDocument.exports['./schemas/arcane-lock.json'],'./schemas/arcane-lock.schema.json');
        assert.equal(packageDocument.exports['./schemas/cli-event.json'],'./schemas/cli-event.schema.json');
        assert.equal(packageDocument.exports['./schemas/event-stack.json'],'./schemas/event-stack.schema.json');
        assert.equal(packageDocument.exports['./schemas/native-build-plan.json'],'./schemas/native-build-plan.schema.json');
        assert.equal(packageDocument.exports['./schemas/target-adapter.json'],'./schemas/target-adapter.schema.json');
    });
    await t.test('exports the integrated provider and testing entry points',()=>{
        assert.equal(packageDocument.exports['./integrated-provider'],'./src/integrated-provider-loader.mjs');
        assert.equal(packageDocument.exports['./testing'],'./src/testing.mjs');
    });
    await t.test('exports the release-bundle implementation entry point',()=>{
        assert.equal(packageDocument.exports['./release-bundle'],'./src/release-bundle.mjs');
    });
    await t.test('pins the Vanilla Test runtime',()=>{
        assert.equal(packageDocument.dependencies['vanilla-test'],'2.1.3');
    });
    await t.test('pins and bundles the event dispatch runtime',()=>{
        assert.equal(packageDocument.dependencies['event-pubsub'],'6.1.0');
        assert.equal(packageDocument.dependencies['strong-type'],'2.0.0');
        assert.deepEqual(packageDocument.bundleDependencies,['event-pubsub','strong-type']);
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
    await t.test('exposes deterministic app release bundle creation and verification',()=>{
        assert.equal(typeof sdk.createAppReleaseBundle,'function');
        assert.equal(typeof sdk.verifyAppReleaseBundle,'function');
        assert.equal(sdk.APP_BUNDLE_SCHEMA_VERSION,1);
        assert.equal(sdk.APP_BUNDLE_FORMAT,'ustar+gzip');
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
    assert.ok(schema.required.includes('security'));
    assert.deepEqual(schema.properties.security.required,[
        'connectOrigins','frameOrigins','mediaOrigins'
    ]);
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

test('native build plan schema publishes only the exact dev.4 target matrix',async t=>{
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

test('CI, reusable app release, and trusted publishing workflows retain narrow authority',async t=>{
    const [checkWorkflow,publishWorkflow,appReleaseWorkflow]=await Promise.all([
        readFile(path.join(repositoryRoot,'.github','workflows','check.yml'),'utf8'),
        readFile(path.join(repositoryRoot,'.github','workflows','publish-dev.yml'),'utf8'),
        readFile(path.join(repositoryRoot,'.github','workflows','release-app.yml'),'utf8')
    ]);
    const buildStart=appReleaseWorkflow.indexOf('\n  build:');
    const verifyStart=appReleaseWorkflow.indexOf('\n  verify:');
    assert.ok(
        buildStart>=0&&verifyStart>buildStart,
        'release-app.yml must keep separate build and post-upload verification jobs'
    );
    const buildSection=appReleaseWorkflow.slice(buildStart,verifyStart);
    const verifySection=appReleaseWorkflow.slice(verifyStart);
    await t.test('Check runs only for main pull requests and pushes',()=>{
        assert.match(checkWorkflow,/pull_request:\s*\n\s+branches:\s*\n\s+- main/u);
        assert.match(checkWorkflow,/push:\s*\n\s+branches:\s*\n\s+- main/u);
        assert.doesNotMatch(checkWorkflow,/\n\s+- dev\s*$/mu);
    });
    await t.test('Check validates package authority once and runs one Linux installed smoke',()=>{
        assert.match(checkWorkflow,/source_validation:[\s\S]*runs-on: ubuntu-24\.04/u);
        assert.equal(checkWorkflow.match(/npm run check:release/gu)?.length,1);
        assert.doesNotMatch(checkWorkflow,/npm run check(?:\s|$)/mu);
        assert.doesNotMatch(
            checkWorkflow.slice(
                checkWorkflow.indexOf('  source_validation:'),
                checkWorkflow.indexOf('  pack_npm_release:')
            ),
            /matrix:/u
        );
        const smokeStart=checkWorkflow.indexOf('  installed_capability_smoke:');
        const readinessStart=checkWorkflow.indexOf('  npm_release_ready:');
        assert.ok(smokeStart>=0&&readinessStart>smokeStart);
        const smokeSection=checkWorkflow.slice(smokeStart,readinessStart);
        assert.match(smokeSection,/name: Installed capability smoke \/ linux-x64/u);
        assert.match(smokeSection,/runs-on: ubuntu-24\.04/u);
        assert.match(smokeSection,/ARCANE_SDK_EXPECTED_PLATFORM: linux/u);
        assert.match(smokeSection,/ARCANE_SDK_EXPECTED_ARCHITECTURE: x64/u);
        assert.doesNotMatch(smokeSection,/matrix:|windows-2025|macos-15/u);
    });
    await t.test('Check installs and exercises one exact project-local npm artifact',()=>{
        assert.match(checkWorkflow,/actions\/upload-artifact@[0-9a-f]{40}/u);
        assert.match(checkWorkflow,/artifact-ids: \$\{\{ needs\.pack_npm_release\.outputs\['artifact-id'\] \}\}/u);
        assert.match(checkWorkflow,/ARCANE_SDK_NPM_RELEASE_METADATA/u);
        assert.match(
            checkWorkflow,
            /bin\/arcane-test\.mjs test\/release-capability-smoke\.test\.mjs/u
        );
        assert.doesNotMatch(checkWorkflow,/bin\/arcane-test\.mjs test\/tarball\.test\.mjs/u);
        assert.doesNotMatch(checkWorkflow,/npm install --global/u);
    });

    await t.test('npm publishing is manual and restricted to canonical main',()=>{
        assert.match(publishWorkflow,/workflow_dispatch:/u);
        assert.equal(publishWorkflow.match(/id-token:\s*write/gu)?.length,1);
        assert.match(publishWorkflow,/if:[^\n]*github\.ref == 'refs\/heads\/main'/u);
        assert.match(publishWorkflow,/environment:\s*\n\s+name:\s*npm/u);
        assert.match(publishWorkflow,/test "\$GITHUB_REPOSITORY" = "TheWizardNexus\/arcane-os-sdk"/u);
        assert.match(publishWorkflow,/test "\$GITHUB_REF" = "refs\/heads\/main"/u);
        assert.match(publishWorkflow,/actions:\s*read/u);
    });
    await t.test('npm publishing reuses the exact successful main Check',()=>{
        assert.match(publishWorkflow,/actions\/workflows\/check\.yml\/runs/u);
        assert.match(publishWorkflow,/-f branch=main/u);
        assert.match(publishWorkflow,/-f event=push/u);
        assert.match(publishWorkflow,/-f status=success/u);
        assert.match(publishWorkflow,/-f head_sha="\$GITHUB_SHA"/u);
        assert.doesNotMatch(publishWorkflow,/npm run check/u);
        assert.doesNotMatch(publishWorkflow,/npm ci/u);
    });
    await t.test('trusted publishing uses only the reviewed npm release artifact',()=>{
        assert.match(publishWorkflow,/node-version: 26\.7\.0/u);
        assert.match(publishWorkflow,/test "\$\(npm --version\)" = "11\.19\.0"/u);
        assert.match(publishWorkflow,/actions\/download-artifact@[0-9a-f]{40}/u);
        assert.match(publishWorkflow,/npm publish "\$RELEASE_ROOT\/arcane-os-\$\{VERSION\}\.tgz"/u);
        assert.match(publishWorkflow,/--tag "\$CHANNEL" --provenance/u);
        assert.match(publishWorkflow,/npm audit signatures[\s\S]*--include-attestations/u);
        assert.match(publishWorkflow,/npm-registry-publication\.mjs provenance/u);
        assert.doesNotMatch(
            publishWorkflow,
            /npm install --global|npm pack(?:\s|$)|NODE_AUTH_TOKEN|npm dist-tag (?:add|rm)/u
        );
    });
    await t.test('app release is reusable, single-app, and exact-SDK bound',async child=>{
        assert.match(appReleaseWorkflow,/workflow_call:/u);
        assert.match(appReleaseWorkflow,/app-id:/u);
        assert.match(appReleaseWorkflow,/Expected exact public arcane-os@0\.1\.2 registry authority/u);
        assert.match(
            appReleaseWorkflow,
            /https:\/\/registry\.npmjs\.org\/arcane-os\/-\/arcane-os-0\.1\.2\.tgz/u
        );
        assert.match(
            appReleaseWorkflow,
            /sha512-fzVbd01xwFVCHTN6k8x\/xPK8xtPy5yCtSkzFLmr1jNVTUBHzmnubLK8a5pWSGH7IhsWce\+\/AFHOu\/TnWSKwDsQ==/u
        );
        assert.doesNotMatch(appReleaseWorkflow,/arcane-os@0\.1\.0-dev\.5/u);
        assert.doesNotMatch(buildSection,/npm (?:view|pack)|\bcurl\b|\bwget\b/u);

        const authorityMatch=buildSection.match(
            /- name: Require the exact public release-bundle SDK authority[\s\S]*?node --input-type=module <<'NODE'\r?\n([\s\S]*?)\r?\n\s+NODE/u
        );
        assert.ok(authorityMatch,'release-app.yml must expose one exact SDK authority verifier');
        const authorityScript=`${authorityMatch[1].replace(/^ {10}/gmu,'')}\n`;
        const fixtureRoot=await temporaryDirectory(child,{prefix:'arcane-release-app-sdk-'});
        const installRoot=path.join(fixtureRoot,'node_modules','arcane-os');
        await mkdir(installRoot,{recursive:true});
        const runAuthority=async({version,requestedSpec=version,resolved,integrity})=>{
            await Promise.all([
                writeFile(
                    path.join(installRoot,'package.json'),
                    `${JSON.stringify({name:'arcane-os',version,type:'module'},null,2)}\n`
                ),
                writeFile(path.join(fixtureRoot,'package-lock.json'),`${JSON.stringify({
                    name:'arcane-release-app-fixture',
                    lockfileVersion:3,
                    requires:true,
                    packages:{
                        '':{dependencies:{'arcane-os':requestedSpec}},
                        'node_modules/arcane-os':{version,resolved,integrity}
                    }
                },null,2)}\n`)
            ]);
            return execFileAsync(process.execPath,[
                '--input-type=module','--eval',authorityScript
            ],{cwd:fixtureRoot,encoding:'utf8',windowsHide:true});
        };
        await runAuthority({
            version:'0.1.2',
            resolved:'https://registry.npmjs.org/arcane-os/-/arcane-os-0.1.2.tgz',
            integrity:'sha512-fzVbd01xwFVCHTN6k8x/xPK8xtPy5yCtSkzFLmr1jNVTUBHzmnubLK8a5pWSGH7IhsWce+/AFHOu/TnWSKwDsQ=='
        });
        await assert.rejects(
            runAuthority({
                version:'0.1.0-dev.5',
                resolved:'https://registry.npmjs.org/arcane-os/-/arcane-os-0.1.0-dev.5.tgz',
                integrity:'sha512-8cUo/Us9PthnPk5c4r9Td7dx6ERKALAUiVL4dprWh5fGf3jGm89uB4fVpXktLErWnw81r7aGmq8LXHLPEMrz7g=='
            }),
            error=>{
                assert.equal(error.code,1);
                assert.match(
                    error.stderr,
                    /Expected exact public arcane-os@0\.1\.2 registry authority/u
                );
                return true;
            }
        );
        await assert.rejects(
            runAuthority({
                version:'0.1.2',
                resolved:'https://registry.npmjs.org/arcane-os/-/arcane-os-0.1.2.tgz',
                integrity:'sha512-forged'
            }),
            error=>{
                assert.equal(error.code,1);
                assert.match(
                    error.stderr,
                    /Expected exact public arcane-os@0\.1\.2 registry authority/u
                );
                return true;
            }
        );
        assert.match(buildSection,/arcane check[^\n]*--app "\$APP_ID"/u);
        assert.match(buildSection,/arcane package[^\n]*--app "\$APP_ID"/u);
        assert.match(buildSection,/arcane bundle[\s\S]*--app "\$APP_ID"/u);
        assert.match(buildSection,/verifyAppReleaseBundle/u);
        for(const output of [
            'bundle-sha256','bundle-bytes','descriptor-sha256','descriptor-file-sha256','descriptor-bytes',
            'package-sha256','release-manifest-sha256','release-policy-sha256',
            'release-content-sha256','file-count','total-bytes'
        ]){
            assert.match(appReleaseWorkflow,new RegExp(`^      ${output}:`,'mu'));
            assert.match(
                appReleaseWorkflow,
                new RegExp(`value: \\$\\{\\{ jobs\\.verify\\.outputs\\.${output} \\}\\}`,'u')
            );
        }
        assert.doesNotMatch(appReleaseWorkflow,/strategy:\s*\n\s+matrix:/u);
    });
    await t.test('attest:false callers need only contents read and expose no privileged nested job',()=>{
        assert.match(
            appReleaseWorkflow,
            /      attest:\s*\n\s+description:[^\n]*requires false\.\s*\n\s+required: false\s*\n\s+default: false\s*\n\s+type: boolean/u
        );
        assert.match(buildSection,/name: Require the least-authority caller shape/u);
        assert.match(buildSection,/if: \$\{\{ inputs\.attest \}\}/u);
        assert.match(buildSection,/requires attest: false and never requests attestation authority/u);
        assert.match(
            buildSection,
            /name: Require the least-authority caller shape[\s\S]*?if: \$\{\{ inputs\.attest \}\}[\s\S]*?exit 1/u
        );
        assert.match(buildSection,/permissions:\s*\n\s+contents:\s*read/u);
        assert.match(verifySection,/permissions:\s*\n\s+contents:\s*read/u);
        assert.doesNotMatch(
            appReleaseWorkflow,
            /attestations:\s*write|id-token:\s*write|attest-build-provenance/u
        );
        assert.deepEqual(
            [...appReleaseWorkflow.slice(appReleaseWorkflow.indexOf('\njobs:')).matchAll(/^  ([a-z][a-z0-9_]*):$/gmu)]
                .map(match=>match[1]),
            ['build','verify']
        );
    });
    await t.test('fresh post-upload job is the sole identity source and executes no caller code',()=>{
        assert.match(verifySection,/if: always\(\) && needs\.build\.result == 'success'/u);
        assert.match(verifySection,/artifact-ids: \$\{\{ needs\.build\.outputs\.artifact-id \}\}/u);
        assert.match(verifySection,/actions\/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0/u);
        assert.match(verifySection,/repository: \$\{\{ job\.workflow_repository \}\}/u);
        assert.match(verifySection,/ref: \$\{\{ job\.workflow_sha \}\}/u);
        assert.match(verifySection,/node-version: 24/u);
        assert.match(verifySection,/process\.env\.TRUSTED_SDK_ROOT[\s\S]*'src','release-bundle\.mjs'/u);
        assert.match(verifySection,/receipt\.app\.id!==process\.env\.EXPECTED_APP_ID/u);
        assert.match(verifySection,/appendFile[\s\S]*process\.env\.GITHUB_OUTPUT/u);
        assert.doesNotMatch(
            verifySection,
            /\$\{\{ inputs\.workspace \}\}|npm (?:ci|install|exec)|node_modules|arcane check|arcane package|arcane bundle/u
        );
        assert.doesNotMatch(buildSection,/steps\.identity\.outputs/u);
        assert.equal(
            (appReleaseWorkflow.match(/actions\/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0/gu)??[]).length,
            1
        );
    });
    await t.test('app release actions are immutable and no publishing authority is present',()=>{
        const actionReferences=[...appReleaseWorkflow.matchAll(/uses:\s*([^\s#]+)/gu)]
            .map(match=>match[1]);
        assert.equal(actionReferences.length,6);
        assert.ok(actionReferences.every(reference=>/@[0-9a-f]{40}$/u.test(reference)));
        assert.doesNotMatch(appReleaseWorkflow,/gh release|npm publish/u);
    });
});

import assert from 'node:assert/strict';
import {access,readFile} from 'node:fs/promises';
import path from 'node:path';

import test from '../src/testing.mjs';
import {repositoryRoot} from './helpers.mjs';

const read=relative=>readFile(path.join(repositoryRoot,...relative.split('/')),'utf8');

test('prerelease repository instructions keep work on canonical main',async()=>{
    const instructions=await read('AGENTS.md');
    assert.match(instructions,/Until the first official SDK release[\s\S]*single canonical\s+`main` branch/u);
    assert.match(instructions,/do not create or use a development or feature branch/u);
});

test('post-release instructions defer dev while keeping main canonical',async()=>{
    const instructions=await read('AGENTS.md');
    assert.match(instructions,/After the first official release[\s\S]*long-lived `dev`/u);
    assert.match(instructions,/`main` remains the canonical released line/u);
    assert.match(instructions,/Activate that workflow\s+only as part of the official-release change/u);
});

test('publication guidance preserves the same staged branch transition',async()=>{
    const publishing=await read('docs/publishing.md');
    assert.match(publishing,/Until the first official SDK release, `main` is the single canonical/u);
    assert.match(publishing,/After the first official release, ordinary work will move to a long-lived\s+`dev` branch while `main` remains the canonical released line/u);
    assert.match(publishing,/future branch name alone grants no authority/u);
});

test('premature promotion and dual-channel implementation is absent',async()=>{
    const retired=[
        '.github/workflows/promote-main.yml',
        'tools/build-pages-channels.mjs'
    ];
    for(const relative of retired){
        await assert.rejects(
            access(path.join(repositoryRoot,...relative.split('/'))),
            error=>error?.code==='ENOENT',
            `${relative} should remain deferred until the first official release.`
        );
    }
});

test('Check validates once and runs one tiny installed-artifact smoke on each supported OS',async()=>{
    const workflow=await read('.github/workflows/check.yml');
    const packageDocument=JSON.parse(await read('package.json'));
    assert.match(
        packageDocument.scripts?.['test:integration']??'',
        /release-capability-smoke\.test\.mjs/u
    );
    const artifactContract=await read('test/release-capability-smoke.test.mjs');
    assert.match(artifactContract,/verifyNpmReleaseArtifact/u);
    assert.match(artifactContract,/import test from '\.\.\/src\/testing\.mjs'/u);
    assert.match(artifactContract,/node_modules','arcane-os'/u);
    assert.match(artifactContract,/installedTestRunner/u);
    assert.match(artifactContract,/\['exec','--offline','--','arcane','--version'\]/u);
    assert.match(workflow,/source_validation:[\s\S]*npm run check/u);
    assert.equal(workflow.match(/npm run check/gu)?.length,1);
    const sourceStart=workflow.indexOf('  source_validation:');
    const producerStart=workflow.indexOf('  pack_npm_release:');
    assert.ok(sourceStart>=0&&producerStart>sourceStart);
    const sourceJob=workflow.slice(sourceStart,producerStart);
    assert.doesNotMatch(sourceJob,/matrix:/u);
    assert.match(sourceJob,/runs-on: ubuntu-24\.04/u);
    assert.match(sourceJob,/node-version: 22\.23\.2/u);
    assert.match(workflow,/pack_npm_release:[\s\S]*npm release artifact/u);
    assert.match(workflow,/pack_npm_release:[\s\S]*if: github\.event_name != 'pull_request'/u);
    assert.match(workflow,/pack_npm_release:[\s\S]*needs: source_validation/u);
    assert.match(workflow,/actions\/upload-artifact@[0-9a-f]{40}/u);
    assert.match(workflow,/artifact-ids: \$\{\{ needs\.pack_npm_release\.outputs\['artifact-id'\] \}\}/u);
    assert.match(workflow,/os: windows-2025[\s\S]*platform: win32[\s\S]*architecture: x64/u);
    assert.match(workflow,/os: ubuntu-24\.04[\s\S]*platform: linux[\s\S]*architecture: x64/u);
    assert.match(workflow,/os: macos-15[\s\S]*platform: darwin[\s\S]*architecture: arm64/u);
    const exerciseStart=workflow.indexOf('  installed_capability_smoke:');
    const readinessStart=workflow.indexOf('  npm_release_ready:');
    assert.ok(exerciseStart>=0&&readinessStart>exerciseStart);
    const exerciseJob=workflow.slice(exerciseStart,readinessStart);
    const cachePattern=/npm_config_cache: \$\{\{ runner\.temp \}\}\/arcane-sdk-npm-cache/gu;
    assert.equal(exerciseJob.match(cachePattern)?.length,2);
    assert.doesNotMatch(exerciseJob,/^    env:\s*\n      npm_config_cache:/mu);
    assert.match(exerciseJob,/Install the exact Vanilla Test dependency\s*\n        env:\s*\n          npm_config_cache:/u);
    assert.match(exerciseJob,/Exercise only the installed capability contract through Vanilla Test[\s\S]*npm_config_cache:/u);
    assert.match(exerciseJob,/Use the minimum supported Node\.js[\s\S]*node-version: 22\.23\.2/u);
    assert.match(
        exerciseJob,
        /ARCANE_SDK_NPM_RELEASE_METADATA:[\s\S]*bin\/arcane-test\.mjs test\/release-capability-smoke\.test\.mjs/u
    );
    assert.match(exerciseJob,/ARCANE_SDK_EXACT_ARTIFACT_REQUIRED: true/u);
    assert.doesNotMatch(exerciseJob,/continue-on-error:\s*true/u);
    assert.doesNotMatch(exerciseJob,/tarball\.test\.mjs|browser-import-map\.contract\.mjs/u);
    assert.match(workflow,/npm_release_ready:[\s\S]*PACK_RESULT[\s\S]*SMOKE_RESULT/u);
    assert.match(
        workflow,
        /Verify identity, integrity, shasum, licenses, and the standard-content boundary/u
    );
    assert.match(workflow,/tools\/verify-npm-release\.mjs/u);
    assert.doesNotMatch(workflow,/npm install --global/u);
});

test('development publication consumes the tested tarball without repacking',async()=>{
    const workflow=await read('.github/workflows/publish-dev.yml');
    assert.match(workflow,/actions\/download-artifact@[0-9a-f]{40}/u);
    assert.match(workflow,/artifact-ids: \$\{\{ steps\.readiness\.outputs\['artifact-id'\] \}\}/u);
    assert.match(workflow,/tools\/verify-npm-release\.mjs[\s\S]*--require-clean/u);
    assert.match(workflow,/content_classification:[\s\S]*unresolved[\s\S]*standard[\s\S]*dual-use/u);
    assert.match(workflow,/concurrency:[\s\S]*cancel-in-progress: false/u);
    assert.match(workflow,/npm-registry-publication\.mjs policy/u);
    assert.match(workflow,/npm-registry-publication\.mjs preflight/u);
    assert.match(workflow,/npm-registry-publication\.mjs verify[\s\S]*--max-wait-ms 900000/u);
    assert.match(workflow,/npm publish "\$RELEASE_ROOT\/arcane-os-\$\{VERSION\}\.tgz"/u);
    assert.match(workflow,/one-time npm package bootstrap/u);
    assert.doesNotMatch(workflow,/npm publish (?:--[^\n ]+ )*\.(?:\s|$)/u);
    assert.doesNotMatch(workflow,/npm pack(?:\s|$)/u);
});

test('the installed npm artifact owns the Vanilla Test release lifecycle',async()=>{
    const packageDocument=JSON.parse(await read('package.json'));
    assert.equal(packageDocument.dependencies?.['vanilla-test'],'2.1.3');
    assert.equal(packageDocument.scripts?.['release:pack'],'node tools/build-npm-release.mjs');
    assert.equal(packageDocument.scripts?.['release:verify'],'node tools/verify-npm-release.mjs');
    const contract=await read('test/tarball.test.mjs');
    assert.match(contract,/import test from 'arcane-os\/testing'/u);
    assert.match(contract,/node_modules','arcane-os','bin','arcane-test\.mjs'/u);
    assert.match(contract,/\['exec','--offline','--','arcane'/u);
});

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

import test from '../src/testing.mjs';
import {repositoryRoot} from './helpers.mjs';

const read=relative=>readFile(path.join(repositoryRoot,...relative.split('/')),'utf8');

test('Check runs only the npm-critical source, producer, Linux smoke, and identity gates',async()=>{
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
    assert.match(workflow,/source_validation:[\s\S]*npm run check:release/u);
    assert.equal(workflow.match(/npm run check:release/gu)?.length,1);
    assert.doesNotMatch(workflow,/npm run check(?:\s|$)/mu);
    assert.equal(
        packageDocument.scripts?.['test:release'],
        'node ./bin/arcane-test.mjs test/npm-release.test.mjs'
    );
    assert.equal(
        packageDocument.scripts?.['check:release'],
        'node tools/check-source.mjs --package-only && node tools/runtime-manifest.mjs --verify && '
        +'node tools/sdk-browser-runtime-manifest.mjs --verify && npm run test:release'
    );
    assert.equal(packageDocument.scripts?.['test:functional:release'],undefined);
    assert.doesNotMatch(
        `${packageDocument.scripts?.['check:release']??''} ${packageDocument.scripts?.['test:release']??''}`,
        /npm run (?:test:unit|test:functional|test:integration|test:regression)|release-bundle|tarball|site|reference|integration|regression/u
    );
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
    const exerciseStart=workflow.indexOf('  installed_capability_smoke:');
    const readinessStart=workflow.indexOf('  npm_release_ready:');
    assert.ok(exerciseStart>=0&&readinessStart>exerciseStart);
    const exerciseJob=workflow.slice(exerciseStart,readinessStart);
    assert.match(exerciseJob,/name: Installed capability smoke \/ linux-x64/u);
    assert.match(exerciseJob,/runs-on: ubuntu-24\.04/u);
    assert.doesNotMatch(exerciseJob,/matrix:|windows-2025|macos-15/u);
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
    assert.match(exerciseJob,/ARCANE_SDK_EXPECTED_PLATFORM: linux/u);
    assert.match(exerciseJob,/ARCANE_SDK_EXPECTED_ARCHITECTURE: x64/u);
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

test('channel-aware publication consumes the tested tarball without repacking',async()=>{
    const workflow=await read('.github/workflows/publish-dev.yml');
    assert.match(
        workflow,
        /publish:[\s\S]*if: github\.repository == 'TheWizardNexus\/arcane-os-sdk' && github\.ref == 'refs\/heads\/main'/u
    );
    assert.match(workflow,/publish:[\s\S]*environment:\s*\n\s*name: npm/u);
    assert.match(workflow,/actions\/download-artifact@[0-9a-f]{40}/u);
    assert.match(workflow,/artifact-ids: \$\{\{ steps\.readiness\.outputs\['artifact-id'\] \}\}/u);
    assert.match(workflow,/tools\/verify-npm-release\.mjs[\s\S]*--require-clean/u);
    assert.match(workflow,/content_classification:[\s\S]*unresolved[\s\S]*standard[\s\S]*dual-use/u);
    assert.match(workflow,/concurrency:[\s\S]*cancel-in-progress: false/u);
    assert.match(workflow,/npm-registry-publication\.mjs policy/u);
    assert.match(workflow,/npm-registry-publication\.mjs preflight/u);
    assert.match(workflow,/npm-registry-publication\.mjs verify[\s\S]*--max-wait-ms 900000/u);
    assert.match(workflow,/npm publish "\$RELEASE_ROOT\/arcane-os-\$\{VERSION\}\.tgz"/u);
    assert.match(workflow,/--tag "\$CHANNEL" --provenance/u);
    assert.match(workflow,/npm audit signatures[\s\S]*--include-attestations/u);
    assert.match(workflow,/npm-registry-publication\.mjs provenance/u);
    assert.equal(workflow.match(/id-token:\s*write/gu)?.length,1);
    assert.doesNotMatch(workflow,/NODE_AUTH_TOKEN|npm dist-tag (?:add|rm)/u);
    assert.doesNotMatch(workflow,/npm publish (?:--[^\n ]+ )*\.(?:\s|$)/u);
    assert.doesNotMatch(workflow,/npm pack(?:\s|$)/u);
});

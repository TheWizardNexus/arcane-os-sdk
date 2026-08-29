import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

import test from '../src/testing.mjs';
import {repositoryRoot} from './helpers.mjs';

const read=relative=>readFile(path.join(repositoryRoot,...relative.split('/')),'utf8');

test('Check packs and exercises only the selected npm package',async()=>{
    const workflow=await read('.github/workflows/check.yml');
    const packageDocument=JSON.parse(await read('package.json'));
    const artifactContract=await read('test/release-capability-smoke.test.mjs');

    assert.equal(
        packageDocument.scripts?.['test:release'],
        'node ./bin/arcane-test.mjs test/npm-release.test.mjs'
    );
    assert.match(workflow,/source_validation:[\s\S]*node tools\/check-source\.mjs --package-only/u);
    assert.match(workflow,/pack_npm_release:[\s\S]*needs: source_validation/u);
    assert.match(workflow,/node tools\/build-npm-release\.mjs --output/u);
    assert.match(workflow,/actions\/upload-artifact@v7/u);
    assert.match(workflow,/artifact-ids: \$\{\{ needs\.pack_npm_release\.outputs\['artifact-id'\] \}\}/u);
    assert.match(workflow,/installed_capability_smoke:[\s\S]*runs-on: ubuntu-24\.04/u);
    assert.match(workflow,/ARCANE_SDK_NPM_RELEASE_TARBALL:/u);
    assert.match(workflow,/ARCANE_SDK_EXPECTED_PLATFORM: linux/u);
    assert.match(workflow,/ARCANE_SDK_EXPECTED_ARCHITECTURE: x64/u);
    assert.match(workflow,/bin\/arcane-test\.mjs test\/release-capability-smoke\.test\.mjs/u);
    assert.match(artifactContract,/verifyNpmReleaseArtifact\(\{tarballPath\}\)/u);
    assert.match(artifactContract,/node_modules','arcane-os'/u);
    assert.match(artifactContract,/installedTestRunner/u);
    assert.match(artifactContract,/\['exec','--offline','--','arcane','--version'\]/u);
    assert.doesNotMatch(workflow,/npm install --global/u);
});

test('publication uses the selected tarball and verifies npm version visibility',async()=>{
    const workflow=await read('.github/workflows/publish-dev.yml');
    assert.match(
        workflow,
        /publish:[\s\S]*if: github\.repository == 'TheWizardNexus\/arcane-os-sdk' && github\.ref == 'refs\/heads\/main'/u
    );
    assert.match(workflow,/publish:[\s\S]*environment:\s*\n\s*name: npm/u);
    assert.match(workflow,/node tools\/build-npm-release\.mjs --output/u);
    assert.match(workflow,/npm-registry-publication\.mjs preflight --tarball/u);
    assert.match(workflow,/steps\.publication\.outputs\['needs-publish'\] == 'true'/u);
    assert.match(
        workflow,
        /npm publish "\$\{\{ steps\.pack\.outputs\.tarball \}\}" --ignore-scripts --access public --tag "\$\{\{ steps\.publication\.outputs\.channel \}\}"/u
    );
    assert.match(
        workflow,
        /npm-registry-publication\.mjs verify --version[\s\S]*--channel[\s\S]*--max-wait-ms 900000/u
    );
    assert.match(workflow,/concurrency:[\s\S]*cancel-in-progress: false/u);
    assert.doesNotMatch(workflow,/npm publish (?:--[^\n ]+ )*\.(?:\s|$)/u);
});

import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from '../src/testing.mjs';
import {buildPagesChannels} from '../tools/build-pages-channels.mjs';
import {repositoryRoot} from './helpers.mjs';

const PRODUCTION_SHA='1'.repeat(40);
const DEVELOPMENT_SHA='2'.repeat(40);

async function writeFixture(root,label){
    await mkdir(root,{recursive:true});
    await Promise.all([
        writeFile(
            path.join(root,'index.html'),
            `<!doctype html>
<html lang="en">
<head>
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://thewizardnexus.github.io/arcane-os-sdk/">
  <meta property="og:url" content="https://thewizardnexus.github.io/arcane-os-sdk/">
  <link rel="stylesheet" href="styles.css">
  <title>${label}</title>
</head>
<body><main>${label}<a href="https://github.com/TheWizardNexus/arcane-os-sdk/blob/main/docs/roadmap.md">Roadmap</a></main></body>
</html>
`,
            'utf8'
        ),
        writeFile(path.join(root,'styles.css'),'body { color: rgb(255 255 255); }\n','utf8'),
        writeFile(path.join(root,'channel.txt'),`${label}\n`,'utf8')
    ]);
}

test('Pages channel builder preserves main at root and visibly labels dev',async function channelBuild(t){
    const temporaryRoot=await mkdtemp(path.join(tmpdir(),'arcane-sdk-pages-'));
    t.after(()=>rm(temporaryRoot,{force:true,recursive:true}));
    const productionRoot=path.join(temporaryRoot,'production');
    const developmentRoot=path.join(temporaryRoot,'development');
    const outputRoot=path.join(temporaryRoot,'artifact');
    await Promise.all([
        writeFixture(productionRoot,'production source'),
        writeFixture(developmentRoot,'development source')
    ]);

    const result=await buildPagesChannels({
        developmentRoot,
        developmentSha:DEVELOPMENT_SHA,
        outputRoot,
        productionRoot,
        productionSha:PRODUCTION_SHA
    });
    const [productionIndex,developmentIndex,developmentStyles,receipt]=await Promise.all([
        readFile(path.join(outputRoot,'index.html'),'utf8'),
        readFile(path.join(outputRoot,'dev','index.html'),'utf8'),
        readFile(path.join(outputRoot,'dev','styles.css'),'utf8'),
        readFile(path.join(outputRoot,'.arcane-pages-channels.json'),'utf8').then(JSON.parse)
    ]);

    assert.match(productionIndex,/>production source</u);
    assert.doesNotMatch(productionIndex,/arcane-channel-banner|noindex/u);
    assert.match(productionIndex,/blob\/main\/docs\/roadmap\.md/u);
    assert.match(developmentIndex,/Development documentation/u);
    assert.match(developmentIndex,/arcane-channel-banner/u);
    assert.match(developmentIndex,/content="noindex, nofollow"/u);
    assert.match(
        developmentIndex,
        /href="https:\/\/thewizardnexus\.github\.io\/arcane-os-sdk\/dev\/"/u
    );
    assert.match(developmentStyles,/\.arcane-channel-banner/u);
    assert.match(developmentIndex,/blob\/dev\/docs\/roadmap\.md/u);
    assert.doesNotMatch(developmentIndex,/blob\/main\//u);
    assert.deepEqual(receipt,{
        schemaVersion:1,
        production:{branch:'main',path:'/',sha:PRODUCTION_SHA},
        development:{branch:'dev',path:'/dev/',sha:DEVELOPMENT_SHA}
    });
    assert.equal(result.production.files,3);
    assert.equal(result.development.files,3);
});

test('Pages channel builder fails closed before overwriting an existing output',async function noOverwrite(t){
    const temporaryRoot=await mkdtemp(path.join(tmpdir(),'arcane-sdk-pages-existing-'));
    t.after(()=>rm(temporaryRoot,{force:true,recursive:true}));
    const productionRoot=path.join(temporaryRoot,'production');
    const developmentRoot=path.join(temporaryRoot,'development');
    const outputRoot=path.join(temporaryRoot,'artifact');
    await Promise.all([
        writeFixture(productionRoot,'production source'),
        writeFixture(developmentRoot,'development source'),
        mkdir(outputRoot)
    ]);

    await assert.rejects(
        buildPagesChannels({
            developmentRoot,
            developmentSha:DEVELOPMENT_SHA,
            outputRoot,
            productionRoot,
            productionSha:PRODUCTION_SHA
        }),
        /Pages output already exists/u
    );
});

test('workflow sources enforce the two long-lived channels and exact-SHA evidence reuse',async function workflowPolicy(){
    const [check,promotion,publish,pages]=await Promise.all([
        readFile(path.join(repositoryRoot,'.github','workflows','check.yml'),'utf8'),
        readFile(path.join(repositoryRoot,'.github','workflows','promote-main.yml'),'utf8'),
        readFile(path.join(repositoryRoot,'.github','workflows','publish-dev.yml'),'utf8'),
        readFile(path.join(repositoryRoot,'.github','workflows','pages.yml'),'utf8')
    ]);

    assert.match(check,/pull_request:\s*\n\s+branches:\s*\n\s+- dev/u);
    assert.match(check,/push:\s*\n\s+branches:\s*\n\s+- dev/u);
    assert.doesNotMatch(check,/branches:\s*\n\s+- main/u);

    assert.match(promotion,/head_sha="\$GITHUB_SHA"/u);
    assert.match(promotion,/-f branch=dev/u);
    assert.match(promotion,/-f status=success/u);
    assert.match(promotion,/permissions:\s*\n\s+actions: read/u);
    assert.doesNotMatch(promotion,/contents:\s*(?:read|write)|actions:\s*write/u);
    assert.doesNotMatch(promotion,/npm (?:ci|run check)/u);

    assert.match(publish,/refs\/heads\/dev/u);
    assert.match(publish,/head_sha="\$GITHUB_SHA"/u);
    assert.doesNotMatch(publish,/refs\/heads\/main/u);
    assert.doesNotMatch(publish,/npm (?:ci|run check)/u);

    assert.match(pages,/workflow_run:/u);
    assert.match(pages,/- Check\s*\n\s+- Promote main/u);
    assert.match(pages,/workflow_run\.event == 'push'/u);
    assert.match(pages,/workflow_run\.conclusion == 'success'/u);
    assert.match(
        pages,
        /workflow_run\.head_repository\.full_name == 'TheWizardNexus\/arcane-os-sdk'/u
    );
    assert.equal((pages.match(/persist-credentials: false/gu)??[]).length,2);
    assert.match(pages,/actions\/setup-node@v6[\s\S]*node-version: 24[\s\S]*package-manager-cache: false/u);
    assert.match(pages,/node production\/tools\/build-pages-channels\.mjs/u);
    assert.match(pages,/path: \.\/pages-artifact/u);
    assert.match(pages,/assemble:[\s\S]*permissions:\s*\n\s+actions: read\s*\n\s+contents: read/u);
    assert.match(pages,/deploy:[\s\S]*permissions:\s*\n\s+pages: write\s*\n\s+id-token: write/u);
    const deploySource=pages.slice(pages.indexOf('\n  deploy:'));
    assert.doesNotMatch(deploySource,/actions\/checkout|\brun:/u);
});

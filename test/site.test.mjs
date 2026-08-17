import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {repositoryRoot} from './helpers.mjs';

const siteRoot=path.join(repositoryRoot,'site');

async function readSiteFile(fileName,encoding='utf8'){
    return readFile(path.join(siteRoot,fileName),encoding);
}

function pngDimensions(buffer){
    assert.equal(buffer.subarray(1,4).toString('ascii'),'PNG');
    return {width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20)};
}

test('Pages document is semantic, project-path safe, and truthful',async t=>{
    const html=await readSiteFile('index.html');
    await t.test('publishes semantic metadata and one page heading',()=>{
        assert.match(html,/^<!doctype html>/u);
        assert.match(html,/<html lang="en">/u);
        assert.match(html,/<meta name="viewport"/u);
        assert.match(html,/Content-Security-Policy/u);
        assert.match(html,/default-src 'self'/u);
        assert.match(html,/<link rel="canonical" href="https:\/\/thewizardnexus\.github\.io\/arcane-os-sdk\/">/u);
        assert.equal((html.match(/<h1\b/gu)??[]).length,1);
    });
    await t.test('exposes accessible landmarks and decorative visuals',()=>{
        assert.match(html,/<a class="skip-link" href="#main-content">/u);
        assert.match(html,/<main id="main-content">/u);
        assert.match(html,/<canvas id="space-canvas" aria-hidden="true"><\/canvas>/u);
        assert.match(html,/<div class="hero-system" aria-hidden="true">/u);
        assert.match(html,/data-motion-toggle aria-pressed="false"/u);
        assert.doesNotMatch(html,/tabindex="[1-9][0-9]*"/u);
    });
    await t.test('avoids deployment-root-relative references',()=>{
        assert.doesNotMatch(html,/(?:href|src)="\//u);
    });

    await t.test('states the development workflow and availability honestly',()=>{
        assert.match(html,/Not yet published to npm/u);
        assert.match(html,/Browser plus five explicitly paired native development targets are available/u);
        assert.match(html,/build one declared portable, Windows x64, Linux x64, Linux ARM64, or Android ARM64 development artifact through an explicit compatible Arcane OS checkout/u);
        assert.match(html,/CLI, CI, future GUI, and Codex/u);
        assert.match(html,/doctor \/ expected contract/u);
        assert.match(html,/<span class="ready-pill">example<\/span>/u);
        assert.match(html,/integrated shared\/Core profile with <code>--scope shared<\/code>/u);
        assert.match(html,/Every native target requires an explicit compatible <code>--arcane-root<\/code> and matching scaffold descriptor/u);
    });
    await t.test('states each native development boundary and evidence level',()=>{
        assert.match(html,/Portable cannot run directly/u);
        assert.match(html,/Windows and both Linux DEBs are unsigned-local-test/u);
        assert.match(html,/development-signed, architecture-neutral APK with no native ABI/u);
        assert.match(html,/Linux ARM64 has exact-SHA native workflow evidence/u);
        assert.match(html,/Android has exact-SHA physical ARM64\/API 37 evidence/u);
        assert.match(html,/physical\/native ARM64 device for run/u);
        assert.match(html,/AAB, release signing, publishing, and update continuity remain deferred/u);
        assert.doesNotMatch(html,/Android and ARM64 deferred|Mobile and ARM64 next|Deferred targets return|native E2E is not yet claimed|final adversarial fixes/u);
    });
    await t.test('lists all available targets with exact live labels',()=>{
        for(const target of ['Browser','Portable','Windows x64','Linux x64','Linux ARM64','Android ARM64']){
            assert.match(html,new RegExp(`<th scope="row">${target.replace('/','\\/')}</th>`,'u'));
        }
        assert.match(html,/Linux ARM64<\/th><td>DEB<\/td><td><span class="status-chip status-live">Available<\/span>/u);
        assert.match(html,/Android ARM64<\/th><td>APK only<\/td><td><span class="status-chip status-live">Available<\/span>/u);
    });
    await t.test('states the exact licensing boundaries',()=>{
        assert.match(html,/AGPL-3\.0-only/u);
        assert.match(html,/commercial notice as permission/u);
    });

    await t.test('protects every new-window external link',()=>{
        for(const anchor of html.match(/<a\b[^>]*target="_blank"[^>]*>/gu)??[]){
            assert.match(anchor,/rel="noreferrer"/u);
        }
    });

    await t.test('resolves every local asset within the Pages root',async()=>{
        const localReferences=[];
        for(const match of html.matchAll(/(?:href|src)="([^"]+)"/gu)){
            const reference=match[1];
            if(reference.startsWith('#')||reference.startsWith('https://')||reference.startsWith('mailto:')) continue;
            localReferences.push(reference);
        }
        assert.ok(localReferences.length>=5);
        for(const reference of localReferences){
            const localPath=path.resolve(siteRoot,reference.split(/[?#]/u,1)[0]);
            assert.equal(path.relative(siteRoot,localPath).startsWith('..'),false,reference);
            assert.equal((await stat(localPath)).isFile(),true,reference);
        }
    });
});

test('space motion is bounded, controllable, and accessibility-aware',async t=>{
    const [styles,script]=await Promise.all([
        readSiteFile('styles.css'),
        readSiteFile('app.js')
    ]);
    await t.test('styles honor reduced motion, forced colors, and keyboard focus',()=>{
        assert.match(styles,/@media \(prefers-reduced-motion: reduce\)/u);
        assert.match(styles,/@media \(forced-colors: active\)/u);
        assert.match(styles,/:focus-visible/u);
    });
    await t.test('styles pause motion and retain a bounded mobile layout',()=>{
        assert.match(styles,/\.motion-paused \.orbit/u);
        assert.match(styles,/\.motion-paused \.readiness-pulse span/u);
        assert.match(styles,/@media \(max-width: 520px\)/u);
        assert.doesNotMatch(styles,/calc\(var\(--mouse-[xy]\) \* /u);
    });

    await t.test('canvas rendering caps particles, pixel density, and frame rate',()=>{
        assert.match(script,/Math\.max\(45, Math\.min\(120,/u);
        assert.match(script,/Math\.min\(window\.devicePixelRatio \|\| 1, 1\.5\)/u);
        assert.match(script,/time - lastDraw >= 33/u);
    });
    await t.test('motion responds to preferences, visibility, and viewport lifecycle',()=>{
        assert.match(script,/prefers-reduced-motion: reduce/u);
        assert.match(script,/visibilitychange/u);
        assert.match(script,/IntersectionObserver/u);
        assert.match(script,/localStorage\.setItem\(preferenceKey/u);
        assert.match(script,/window\.cancelAnimationFrame/u);
    });
    await t.test('command viewer supports keyboard and clipboard controls',()=>{
        assert.match(script,/ArrowRight/u);
        assert.match(script,/navigator\.clipboard/u);
    });
    await t.test('command examples cover every supported development path',()=>{
        assert.match(script,/native-doctor --target portable --arcane-root/u);
        assert.match(script,/build --target portable --arcane-root/u);
        assert.match(script,/run --target windows-x64 --arcane-root/u);
        assert.match(script,/run --target linux-x64 --arcane-root/u);
        assert.match(script,/test --workspace "\.\.\/Arcane OS" --scope shared --test-file/u);
        assert.match(script,/check --workspace "\.\.\/Arcane OS" --scope shared/u);
        assert.match(script,/native-doctor --target linux-arm64 --arcane-root .*--format deb --signing unsigned-local-test/u);
        assert.match(script,/build --target linux-arm64 --arcane-root .*--format deb --signing unsigned-local-test/u);
        assert.match(script,/run --target linux-arm64 --arcane-root .*--format deb --signing unsigned-local-test/u);
        assert.match(script,/native-doctor --target android-arm64 --arcane-root .*--format apk --signing development/u);
        assert.match(script,/build --target android-arm64 --arcane-root .*--format apk --signing development/u);
        assert.match(script,/run --target android-arm64 --arcane-root .*--format apk --signing development/u);
        assert.match(script,/new local-app --path \.\.\/local-app --target portable --git/u);
    });
    await t.test('command notes retain compatibility and Android boundaries',()=>{
        assert.match(script,/compatible --arcane-root and matching scaffold descriptor/u);
        assert.match(script,/architecture-neutral APK with no native ABI/u);
    });
    await t.test('script avoids HTML injection and network requests',()=>{
        assert.doesNotMatch(script,/innerHTML/u);
        assert.doesNotMatch(script,/(?:fetch|XMLHttpRequest)\s*\(/u);
    });
});

test('Pages assets retain exact brand identities',async t=>{
    const [header,sigil]=await Promise.all([
        readSiteFile(path.join('assets','arcane-os-sdk-readme-header.png'),null),
        readSiteFile(path.join('assets','arcane-sigil-512.png'),null)
    ]);
    await t.test('retains the reviewed header and sigil dimensions',()=>{
        assert.deepEqual(pngDimensions(header),{width:2172,height:724});
        assert.deepEqual(pngDimensions(sigil),{width:512,height:512});
    });
    await t.test('retains the reviewed header bytes',()=>{
        assert.equal(
            createHash('sha256').update(header).digest('hex').toUpperCase(),
            '4DC9AD6FCAA572B3789BDD0FB5847D399840FBDEB46CD54B717478AE46685D47'
        );
    });
    await t.test('retains the reviewed sigil bytes',()=>{
        assert.equal(
            createHash('sha256').update(sigil).digest('hex').toUpperCase(),
            '6CBB0C89168713E5DF9FAB9E0A51628A40D13F449498DB7832A800A5E425D48D'
        );
    });
});

test('Pages workflow deploys one authenticated main static artifact',async t=>{
    const [workflow,packageDocument,readme,robots,sitemap]=await Promise.all([
        readFile(path.join(repositoryRoot,'.github','workflows','pages.yml'),'utf8'),
        readFile(path.join(repositoryRoot,'package.json'),'utf8').then(JSON.parse),
        readFile(path.join(repositoryRoot,'README.md'),'utf8'),
        readSiteFile('robots.txt'),
        readSiteFile('sitemap.xml')
    ]);
    await t.test('grants only the permissions required for Pages deployment',()=>{
        assert.match(workflow,/permissions:\s*\{\}/u);
        assert.match(workflow,/actions:\s*read/u);
        assert.match(workflow,/contents:\s*read/u);
        assert.match(workflow,/pages:\s*write/u);
        assert.match(workflow,/id-token:\s*write/u);
    });
    await t.test('accepts only a successful canonical main Check run',()=>{
        assert.match(workflow,/github\.repository == 'TheWizardNexus\/arcane-os-sdk'/u);
        assert.match(workflow,/workflow_run:\s*[\s\S]*- Check[\s\S]*types:\s*[\s\S]*- completed/u);
        assert.doesNotMatch(workflow,/- Promote main/u);
        assert.doesNotMatch(workflow,/head_branch == 'dev'/u);
        assert.match(workflow,/head_branch == 'main'/u);
        assert.match(
            workflow,
            /workflow_run\.event == 'push'[\s\S]*workflow_run\.conclusion == 'success'[\s\S]*head_repository\.full_name == 'TheWizardNexus\/arcane-os-sdk'/u
        );
    });
    await t.test('resolves the newest successful main Check receipt',()=>{
        assert.match(workflow,/actions\/workflows\/check[.]yml\/runs/u);
        assert.match(workflow,/-f branch=main/u);
        assert.match(workflow,/-f event=push/u);
        assert.match(workflow,/-f status=success/u);
        assert.match(workflow,/checked_sha=\$checked_sha/u);
    });
    await t.test('checks out and authenticates the resolved revision',()=>{
        assert.match(
            workflow,
            /actions\/checkout@v7[\s\S]*ref: \$\{\{ steps\.check\.outputs\.checked_sha \}\}[\s\S]*persist-credentials: false/u
        );
        assert.match(workflow,/CHECKED_SHA:[^\n]*steps\.check\.outputs\.checked_sha[\s\S]*git rev-parse HEAD/u);
    });
    await t.test('validates and deploys the static site directory directly',()=>{
        assert.match(workflow,/actions\/configure-pages@v6/u);
        assert.match(workflow,/test -f site\/index\.html/u);
        assert.match(workflow,/find site -type l/u);
        assert.match(workflow,/actions\/upload-pages-artifact@v5/u);
        assert.match(workflow,/path: \.\/site/u);
        assert.match(workflow,/actions\/deploy-pages@v5/u);
        assert.doesNotMatch(workflow,/build-pages-channels|--production|--development|path: \.\/pages-artifact/u);
    });
    await t.test('publishes one canonical homepage outside the npm package',()=>{
        assert.equal(packageDocument.homepage,'https://thewizardnexus.github.io/arcane-os-sdk/');
        assert.equal(packageDocument.files.some(entry=>entry.startsWith('site')),false);
    });
    await t.test('README points to canonical main site and repository resources',()=>{
        assert.match(readme,/https:\/\/thewizardnexus\.github\.io\/arcane-os-sdk\//u);
        assert.doesNotMatch(readme,/https:\/\/thewizardnexus\.github\.io\/arcane-os-sdk\/dev\//u);
        assert.match(readme,/main\/site\/assets\/arcane-os-sdk-readme-header\.png/u);
        assert.match(readme,/https:\/\/github\.com\/TheWizardNexus\/arcane-os-sdk/u);
    });
    await t.test('robots and sitemap expose the canonical site URL',()=>{
        assert.match(robots,/Sitemap: https:\/\/thewizardnexus\.github\.io\/arcane-os-sdk\/sitemap\.xml/u);
        assert.match(sitemap,/<loc>https:\/\/thewizardnexus\.github\.io\/arcane-os-sdk\/<\/loc>/u);
    });
});

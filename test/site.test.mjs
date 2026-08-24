import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdir,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {projectPackageManifest,validateAppDescriptor} from '../src/app-descriptor.mjs';
import test from '../src/testing.mjs';
import {verifyReferenceSite} from '../tools/build-reference-site.mjs';
import {repositoryRoot} from './helpers.mjs';
import '../examples/hello-world/apps/hello-world/test/app.test.mjs';

const siteRoot=path.join(repositoryRoot,'site');
const exampleRoot=path.join(repositoryRoot,'examples','hello-world');
const canonicalRoot='https://thewizardnexus.github.io/arcane-os-sdk/';
const htmlCache=new Map();
const staticPageRoutes=new Map([
    ['index.html',''],
    ['quick-start/index.html','quick-start/'],
    ['guides/index.html','guides/'],
    ['guides/external-app/index.html','guides/external-app/'],
    ['guides/integrated-workspace/index.html','guides/integrated-workspace/'],
    ['guides/native-builds/index.html','guides/native-builds/'],
    ['examples/index.html','examples/'],
    ['examples/hello-world/index.html','examples/hello-world/'],
    ['playground/index.html','playground/'],
    ['testing/index.html','testing/'],
    ['reference/index.html','reference/'],
    ['architecture/index.html','architecture/'],
    ['compatibility/index.html','compatibility/']
]);

async function loadReferenceManifest(){
    return readJson(path.join(siteRoot,'reference','reference-manifest.json'));
}

async function loadPageRoutes(){
    const manifest=await loadReferenceManifest();
    const routes=new Map(staticPageRoutes);
    for(const page of manifest.pages){
        assert.match(page.output,/^site\/reference\/.+\/index[.]html$/u);
        assert.match(page.route,/^reference\/.+\/$/u);
        routes.set(page.output.slice('site/'.length),page.route);
    }
    return routes;
}

function sitePath(fileName){
    return path.join(siteRoot,...fileName.split('/'));
}

async function readSiteFile(fileName,encoding='utf8'){
    return readFile(sitePath(fileName),encoding);
}

async function readHtmlFile(filePath){
    let html=htmlCache.get(filePath);
    if(html===undefined){
        html=await readFile(filePath,'utf8');
        htmlCache.set(filePath,html);
    }
    return html;
}

async function readJson(filePath){
    return JSON.parse(await readFile(filePath,'utf8'));
}

function pngDimensions(buffer){
    assert.equal(buffer.subarray(1,4).toString('ascii'),'PNG');
    return {width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20)};
}

function localReferences(html){
    const references=[];
    for(const tag of html.match(/<(?:a|img|link|script)\b[^>]*>/gu)??[]){
        const attribute=tag.match(/\b(?:href|src)="([^"]+)"/u);
        if(attribute)references.push(attribute[1]);
    }
    return references;
}

function externalReference(reference){
    return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(reference);
}

function escapePattern(value){
    return value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
}

function escapeHtmlSource(value){
    return value
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;');
}

async function assertLocalReference(sourceFile,reference){
    if(externalReference(reference))return;
    const [pathAndQuery,rawFragment='']=reference.split('#',2);
    const referencePath=pathAndQuery.split('?',1)[0];
    const sourcePath=sitePath(sourceFile);
    let targetPath=referencePath
        ?path.resolve(path.dirname(sourcePath),...referencePath.split('/'))
        :sourcePath;
    const relative=path.relative(siteRoot,targetPath);
    assert.equal(relative.startsWith('..')||path.isAbsolute(relative),false,`${sourceFile}: ${reference}`);
    const targetInfo=await stat(targetPath);
    if(targetInfo.isDirectory())targetPath=path.join(targetPath,'index.html');
    assert.equal((await stat(targetPath)).isFile(),true,`${sourceFile}: ${reference}`);
    if(!rawFragment)return;
    assert.equal(path.extname(targetPath),'.html',`${sourceFile}: ${reference}`);
    const fragment=decodeURIComponent(rawFragment);
    const targetHtml=await readHtmlFile(targetPath);
    assert.match(targetHtml,new RegExp(`\\bid="${escapePattern(fragment)}"`,'u'),`${sourceFile}: ${reference}`);
}

async function listHtmlFiles(directory=siteRoot,prefix=''){
    const files=[];
    for(const entry of await readdir(directory,{withFileTypes:true})){
        const relative=prefix?`${prefix}/${entry.name}`:entry.name;
        if(entry.isDirectory())files.push(...await listHtmlFiles(path.join(directory,entry.name),relative));
        if(entry.isFile()&&entry.name.endsWith('.html'))files.push(relative);
    }
    return files;
}

test('Pages routes are semantic, canonical, and project-path safe',async t=>{
    const pageRoutes=await loadPageRoutes();
    const actualPages=(await listHtmlFiles()).sort();
    assert.deepEqual(actualPages,[...pageRoutes.keys()].sort());

    for(const [fileName,route] of pageRoutes){
        await t.test(fileName,async()=>{
            const html=await readSiteFile(fileName);
            const canonical=`${canonicalRoot}${route}`;
            assert.match(html,/^<!doctype html>/u);
            assert.match(html,/<html lang="en">/u);
            assert.match(html,/<meta name="viewport"/u);
            assert.match(html,/<meta name="description"/u);
            assert.match(html,/Content-Security-Policy/u);
            assert.match(html,/default-src 'self'/u);
            assert.match(html,/connect-src 'none'/u);
            assert.match(html,/<a class="skip-link" href="#main-content">/u);
            assert.match(html,/<main id="main-content">/u);
            assert.equal((html.match(/<h1\b/gu)??[]).length,1);
            assert.doesNotMatch(html,/tabindex="[1-9][0-9]*"/u);
            assert.doesNotMatch(html,/(?:href|src)="\//u);
            assert.match(html,new RegExp(`<link rel="canonical" href="${escapePattern(canonical)}">`,'u'));
            assert.match(html,new RegExp(`<meta property="og:url" content="${escapePattern(canonical)}">`,'u'));
            assert.match(html,/arcane-os-sdk-readme-header[.]png/u);

            for(const anchor of html.match(/<a\b[^>]*target="_blank"[^>]*>/gu)??[]){
                assert.match(anchor,/rel="noreferrer"/u);
            }
            const references=localReferences(html);
            assert.ok(references.length>=5,fileName);
            for(const reference of references)await assertLocalReference(fileName,reference);
        });
    }
});

test('the complete API reference is a first-party generated Pages corpus',async t=>{
    await verifyReferenceSite();
    const manifest=await loadReferenceManifest();
    assert.equal(manifest.schema,'arcane-reference-site/1');
    assert.deepEqual(manifest.versions,{
        sdk:'0.1.0-dev.5',
        runtime:'0.8.12',
        protocol:'arcane/1'
    });
    assert.deepEqual(manifest.counts,{
        markdownPages:24,
        collectionPages:2,
        htmlPages:26,
        inventories:4
    });
    assert.equal(manifest.pages.filter(page=>page.kind==='markdown').length,24);
    assert.equal(manifest.pages.filter(page=>page.kind==='collection').length,2);
    assert.equal(new Set(manifest.pages.map(page=>page.source)).size,26);
    assert.equal(new Set(manifest.pages.map(page=>page.output)).size,26);
    assert.equal(new Set(manifest.pages.map(page=>page.route)).size,26);

    await t.test('the landing and rendered documents keep detailed navigation on Pages',async()=>{
        const landing=await readSiteFile('reference/index.html');
        assert.doesNotMatch(
            landing,
            /href="https:\/\/github[.]com\/TheWizardNexus\/arcane-os-sdk\/(?:blob|tree)\/main\/docs\/reference/iu
        );
        for(const page of manifest.pages.filter(record=>record.kind==='markdown')){
            const html=await readFile(path.join(repositoryRoot,...page.output.split('/')),'utf8');
            assert.doesNotMatch(html,/href="(?!https?:)[^"]+[.]md(?:[?#][^"]*)?"/iu,page.output);
            assert.doesNotMatch(html,/href="javascript:/iu,page.output);
            assert.doesNotMatch(html,/<script(?![^>]*\bsrc=)[^>]*>/iu,page.output);
            const sourceLinks=html.match(/<a\b[^>]*class="[^"]*reference-source-link[^"]*"[^>]*>/gu)??[];
            assert.equal(sourceLinks.length,1,page.output);
            assert.match(sourceLinks[0],/target="_blank"/u,page.output);
            assert.match(sourceLinks[0],/rel="noreferrer"/u,page.output);
            const ids=[...html.matchAll(/\bid="([^"]+)"/gu)].map(match=>match[1]);
            assert.equal(new Set(ids).size,ids.length,`${page.output} contains duplicate element ids.`);
            const source=await readFile(path.join(repositoryRoot,...page.source.split('/')),'utf8');
            if(source.includes('```')){
                assert.match(html,/class="[^"]*\bcode-block\b[^"]*"/u,page.output);
                assert.match(html,/data-copy-button/u,page.output);
                assert.match(html,/data-copy-status/u,page.output);
            }
        }
    });

    await t.test('published inventories are byte-identical to their canonical sources',async()=>{
        for(const inventory of manifest.inventories){
            const [source,published]=await Promise.all([
                readFile(path.join(repositoryRoot,...inventory.source.split('/'))),
                readFile(path.join(repositoryRoot,...inventory.output.split('/')))
            ]);
            assert.equal(published.equals(source),true,inventory.output);
        }
    });

    await t.test('rendered API catalogs retain every inventoried public name',async()=>{
        const [packageApi,runtimeModules,runtimeEntities,runtimeComponents,sdk,modules,entities,components]=await Promise.all([
            readJson(path.join(repositoryRoot,'docs','reference','inventory','package-api.json')),
            readJson(path.join(repositoryRoot,'docs','reference','inventory','runtime-modules.json')),
            readJson(path.join(repositoryRoot,'docs','reference','inventory','runtime-entities.json')),
            readJson(path.join(repositoryRoot,'docs','reference','inventory','runtime-components.json')),
            readSiteFile('reference/sdk-api/index.html'),
            readSiteFile('reference/runtime-modules/index.html'),
            readSiteFile('reference/runtime-entities/index.html'),
            readSiteFile('reference/runtime-components/index.html')
        ]);
        for(const member of packageApi.members){
            assert.ok(sdk.includes(escapeHtmlSource(member.displayName)),member.displayName);
        }
        for(const artifact of runtimeModules.artifacts){
            assert.ok(modules.includes(escapeHtmlSource(path.basename(artifact.file))),artifact.file);
        }
        for(const module of runtimeEntities.modules){
            assert.ok(entities.includes(escapeHtmlSource(path.basename(module.file))),module.file);
        }
        for(const component of runtimeComponents.artifacts){
            assert.ok(components.includes(escapeHtmlSource(component.name)),component.name);
        }
        assert.match(components,/<code>setNavigation\(\)<\/code><br><code>setActiveRoute\(\)<\/code>/u);
        assert.doesNotMatch(components,/&lt;br\s*\/?&gt;/iu);
    });

    await t.test('folded protocol explanations remain available without executing source HTML',async()=>{
        const [events,protocols]=await Promise.all([
            readSiteFile('reference/event-manager/index.html'),
            readSiteFile('reference/protocols/index.html')
        ]);
        assert.match(events,/<details>/u);
        assert.match(events,/<summary>/u);
        assert.match(protocols,/<details>/u);
        assert.match(protocols,/<summary>/u);
    });
});

test('documentation describes the consumer source-to-executable contract truthfully',async()=>{
    const [home,quickStart,external,hello,native,reference]=await Promise.all([
        readSiteFile('index.html'),
        readSiteFile('quick-start/index.html'),
        readSiteFile('guides/external-app/index.html'),
        readSiteFile('examples/hello-world/index.html'),
        readSiteFile('guides/native-builds/index.html'),
        readSiteFile('reference/index.html')
    ]);
    const combined=[home,quickStart,external,hello,native,reference].join('\n');

    assert.match(home,/Not yet published to npm/u);
    assert.match(home,/examples\/hello-world\//u);
    assert.match(quickStart,/pack:local[^<]*<\/code> deliberately uses <code>npm pack --ignore-scripts<\/code>/u);
    assert.match(quickStart,/without repeating the complete check/u);
    assert.match(external,/npm run pack:local[\s\S]*npm install --save-dev --save-exact [^\n]*[.]tgz/u);
    assert.match(external,/packaged HTML, CSS, and JavaScript/u);
    assert.match(hello,/npx arcane-os new hello-world/u);
    assert.match(hello,/npm install/u);
    assert.match(hello,/npm install --global arcane-os/u);
    assert.match(hello,/What Arcane adds/u);
    assert.match(hello,/node_modules\/[\s\S]*arcane-os\/runtime\//u);
    assert.match(hello,/dist\/hello-world\/[\s\S]*arcane\//u);
    assert.match(hello,/hello-world[.]css/u);
    assert.match(hello,/AppDataScope[.]js/u);
    assert.match(hello,/DirectoryPicker[.]js/u);
    assert.match(hello,/ThemeBootstrap[.]js/u);
    assert.match(hello,/globalThis[.]Arcane/u);
    assert.match(hello,/filesystem[.]directory[.]select/u);
    assert.match(hello,/npm run dev/u);
    assert.match(hello,/npm run package/u);
    assert.match(hello,/npm run build/u);
    assert.match(hello,/build\/windows-x64\/hello-world\/ArcaneApp-hello-world[.]exe/u);
    assert.doesNotMatch(
        hello,
        /not yet published|after publication|pack:local|[.]tgz|0[.]1[.]0-dev|current development checkout|receipt|exactly 152|strong-type|CI shape|--arcane-root|source sync|Arcane Ollama|prebuilt Arcane Core/iu
    );
    assert.match(native,/portable[\s\S]*Not directly runnable[\s\S]*Unsigned local test/u);
    assert.match(native,/Architecture-neutral APK/u);
    assert.match(reference,/<code>native-prepare<\/code>/u);
    assert.doesNotMatch(combined,/\\\r?$/mu);
});

test('site interaction is bounded, copyable, and accessibility-aware',async t=>{
    const [home,playground,styles,script]=await Promise.all([
        readSiteFile('index.html'),
        readSiteFile('playground/index.html'),
        readSiteFile('styles.css'),
        readSiteFile('app.js')
    ]);
    await t.test('homepage motion remains bounded and controllable',()=>{
        assert.match(home,/<canvas id="space-canvas" aria-hidden="true"><\/canvas>/u);
        assert.match(home,/data-motion-toggle aria-pressed="false"/u);
        assert.match(script,/Math[.]max\(45, Math[.]min\(120,/u);
        assert.match(script,/Math[.]min\(window[.]devicePixelRatio \|\| 1, 1[.]5\)/u);
        assert.match(script,/time - lastDraw >= 33/u);
        assert.match(script,/prefers-reduced-motion: reduce/u);
        assert.match(script,/IntersectionObserver/u);
        assert.match(script,/window[.]cancelAnimationFrame/u);
    });
    await t.test('all code blocks use the generic clipboard path',()=>{
        assert.match(script,/function setupCopyButtons\(\)/u);
        assert.match(script,/querySelectorAll\("\[data-copy-button\]"\)/u);
        assert.match(script,/navigator[.]clipboard/u);
        assert.match(script,/Copy failed[.] Select the text manually[.]/u);
    });
    await t.test('playground emits reviewed commands without executing them',()=>{
        assert.match(playground,/This playground changes text only/u);
        assert.match(playground,/Descriptor target fragment/u);
        assert.match(playground,/not a complete schema-2 descriptor/u);
        assert.match(script,/function setupPlayground\(\)/u);
        assert.match(script,/\^\[a-z\]\[a-z0-9\]\*\(\?:-\[a-z0-9\]\+\)\*\$/u);
        assert.match(script,/node [.][/\\]bin[/\\]arcane[.]mjs/u);
        assert.match(script,/Portable output is verified but cannot run/u);
        assert.match(script,/Portable output is a verified app-scoped directory/u);
        assert.match(script,/\["browser", targetName\][.]sort\(\)/u);
    });
    await t.test('scripts avoid injection and network requests',()=>{
        assert.doesNotMatch(script,/innerHTML/u);
        assert.doesNotMatch(script,/(?:fetch|XMLHttpRequest)\s*\(/u);
    });
    await t.test('styles cover docs, mobile, reduced motion, and forced colors',()=>{
        for(const selector of ['.doc-hero','.docs-layout','.code-block','.playground-shell','.route-grid']){
            assert.match(styles,new RegExp(escapePattern(selector),'u'));
        }
        assert.match(styles,/@media \(max-width: 520px\)/u);
        assert.match(styles,/@media \(prefers-reduced-motion: reduce\)/u);
        assert.match(styles,/@media \(forced-colors: active\)/u);
        assert.match(styles,/:focus-visible/u);
    });
});

test('maintained Hello World example matches current SDK contracts',async t=>{
    const appRoot=path.join(exampleRoot,'apps','hello-world');
    const requiredFiles=[
        '.gitattributes',
        '.gitignore',
        'AGENTS.md',
        'README.md',
        'package.json',
        'arcane-packager.json',
        'arcane.lock.json',
        '.github/workflows/check.yml',
        'apps/hello-world/arcane-app.json',
        'apps/hello-world/arcane-package.json',
        'apps/hello-world/manifest.json',
        'apps/hello-world/index.html',
        'apps/hello-world/hello-world.css',
        'apps/hello-world/modules/App.js',
        'apps/hello-world/test/app.test.mjs',
        'apps/hello-world/img/icon.png'
    ];
    for(const relative of requiredFiles){
        assert.equal((await stat(path.join(exampleRoot,...relative.split('/')))).isFile(),true,relative);
    }

    const [rootPackage,examplePackage,lock,runtimeRelease,authoredDescriptor,packageManifest,packager]=await Promise.all([
        readJson(path.join(repositoryRoot,'package.json')),
        readJson(path.join(exampleRoot,'package.json')),
        readJson(path.join(exampleRoot,'arcane.lock.json')),
        readJson(path.join(repositoryRoot,'runtime','ARCANE_RUNTIME_RELEASE.json')),
        readJson(path.join(appRoot,'arcane-app.json')),
        readJson(path.join(appRoot,'arcane-package.json')),
        readJson(path.join(exampleRoot,'arcane-packager.json'))
    ]);
    await t.test('pins the current npm and runtime identities',()=>{
        assert.equal(examplePackage.devDependencies['arcane-os'],rootPackage.version);
        assert.equal(lock.sdk.version,rootPackage.version);
        assert.equal(lock.runtime.contentSha256,runtimeRelease.contentSha256);
        assert.equal(lock.runtime.upstreamCommit,runtimeRelease.source.commit);
        assert.equal(lock.protocols.arcane,runtimeRelease.source.protocol);
    });
    await t.test('maps and inventories the documented Arcane runtime exactly',()=>{
        const runtimePayload=packager.sharedPayloads['browser-runtime']
            .find(payload=>payload.destination==='arcane');
        assert.deepEqual(runtimePayload,{
            source:'node_modules/arcane-os/runtime/arcane',
            destination:'arcane',
            include:['components','css','entities','img','modules','security'],
            exclude:[]
        });

        const counts={};
        const arcanePaths=runtimeRelease.files
            .map(file=>file.path)
            .filter(filePath=>filePath.startsWith('arcane/'));
        for(const filePath of arcanePaths){
            const directory=filePath.split('/')[1];
            counts[directory]=(counts[directory]??0)+1;
        }
        assert.equal(arcanePaths.length,152);
        assert.deepEqual(counts,{
            components:39,
            css:7,
            entities:15,
            img:10,
            modules:80,
            security:1
        });
    });
    await t.test('descriptor validates and projects exactly',()=>{
        const descriptor=validateAppDescriptor(authoredDescriptor,{appId:'hello-world'});
        assert.deepEqual(projectPackageManifest(descriptor),packageManifest);
        assert.deepEqual(descriptor.permissions,{
            capabilities:['filesystem.directory.select','preferences.read'],
            methods:['app.current','filesystem.directory.select','preferences.get']
        });
        assert.deepEqual(descriptor.targets,['browser','windows-x64']);
    });
    await t.test('icon is the maintained native scaffold asset',async()=>{
        const [exampleIcon,templateIcon]=await Promise.all([
            readFile(path.join(appRoot,'img','icon.png')),
            readFile(path.join(repositoryRoot,'src','templates','assets','app-icon.png'))
        ]);
        assert.equal(createHash('sha256').update(exampleIcon).digest('hex'),createHash('sha256').update(templateIcon).digest('hex'));
    });
    await t.test('source uses the shared theme before named app behavior',async()=>{
        const [html,style,script,readme,workflow,tutorial]=await Promise.all([
            readFile(path.join(appRoot,'index.html'),'utf8'),
            readFile(path.join(appRoot,'hello-world.css'),'utf8'),
            readFile(path.join(appRoot,'modules','App.js'),'utf8'),
            readFile(path.join(exampleRoot,'README.md'),'utf8'),
            readFile(path.join(exampleRoot,'.github','workflows','check.yml'),'utf8'),
            readSiteFile('examples/hello-world/index.html')
        ]);
        const theme=html.indexOf('./arcane/css/theme.css');
        const primitives=html.indexOf('./arcane/css/primitives.css');
        const appStyle=html.indexOf('./apps/hello-world/hello-world.css');
        const bootstrap=html.indexOf('./arcane/modules/ThemeBootstrap.js');
        const appModule=html.indexOf('./apps/hello-world/modules/App.js');
        assert.ok(theme>=0&&primitives>theme&&appStyle>primitives&&bootstrap>appStyle&&appModule>bootstrap);
        const runtimePaths=new Set(runtimeRelease.files.map(file=>file.path));
        const htmlRuntimeReferences=[...html.matchAll(
            /(?:href|src)="[.]\/(arcane\/[^"?]+)(?:[?][^"]*)?"/gu
        )].map(match=>match[1]).sort();
        const scriptRuntimeImports=[...script.matchAll(
            /from\s+['"](?:[.]\.[/]?){3}(arcane\/[^'"?]+)(?:[?][^'"]*)?['"]/gu
        )].map(match=>match[1]).sort();
        assert.deepEqual(htmlRuntimeReferences,[
            'arcane/css/primitives.css',
            'arcane/css/theme.css',
            'arcane/modules/ThemeBootstrap.js'
        ]);
        assert.deepEqual(scriptRuntimeImports,[
            'arcane/modules/AppDataScope.js',
            'arcane/modules/DirectoryPicker.js',
            'arcane/modules/ThemeBootstrap.js'
        ]);
        for(const runtimePath of [...htmlRuntimeReferences,...scriptRuntimeImports]){
            assert.equal(runtimePaths.has(runtimePath),true,runtimePath);
        }
        assert.match(script,/function sayHello\(\)/u);
        assert.match(script,/Hello from Arcane OS!/u);
        assert.match(script,/resolveApplicationId\(\)/u);
        assert.match(script,/resolveApplicationLocalStorageKey\('hello-count',\{applicationId:appId\}\)/u);
        assert.match(script,/globalThis[.]Arcane[?][.]runtime[?][.]current/u);
        assert.match(script,/globalThis[.]Arcane[.]app[.]current\(\)/u);
        assert.match(script,/directoryPicker[.]select\(/u);
        for(const source of [html,style,script]){
            assert.equal(tutorial.includes(escapeHtmlSource(source.trim())),true);
        }
        assert.match(readme,/project-local development dependency/u);
        assert.match(readme,/npm install --global arcane-os/u);
        assert.match(readme,/What the SDK adds/u);
        assert.match(readme,/node_modules\/arcane-os\/runtime\//u);
        assert.match(readme,/dist\/hello-world\/[\s\S]*arcane\//u);
        assert.match(readme,/AppDataScope[.]js/u);
        assert.match(readme,/DirectoryPicker[.]js/u);
        assert.match(readme,/npm run dev/u);
        assert.match(readme,/npm run package/u);
        assert.match(readme,/npm run build/u);
        assert.match(readme,/build\/windows-x64\/hello-world\/ArcaneApp-hello-world[.]exe/u);
        assert.doesNotMatch(
            readme,
            /not yet published|after publication|pack:local|[.]tgz|0[.]1[.]0-dev|receipt|exactly 152|strong-type|CI shape|--arcane-root|source sync|Arcane Ollama|prebuilt Arcane Core/iu
        );
        assert.match(workflow,/npm ci --ignore-scripts/u);
    });
});

test('Pages assets retain exact brand identities',async t=>{
    const [header,sigil]=await Promise.all([
        readSiteFile('assets/arcane-os-sdk-readme-header.png',null),
        readSiteFile('assets/arcane-sigil-512.png',null)
    ]);
    await t.test('retains the reviewed dimensions',()=>{
        assert.deepEqual(pngDimensions(header),{width:2172,height:724});
        assert.deepEqual(pngDimensions(sigil),{width:512,height:512});
    });
    await t.test('retains the reviewed bytes',()=>{
        assert.equal(createHash('sha256').update(header).digest('hex').toUpperCase(),'4DC9AD6FCAA572B3789BDD0FB5847D399840FBDEB46CD54B717478AE46685D47');
        assert.equal(createHash('sha256').update(sigil).digest('hex').toUpperCase(),'6CBB0C89168713E5DF9FAB9E0A51628A40D13F449498DB7832A800A5E425D48D');
    });
});

test('Pages workflow deploys one authenticated main static artifact',async t=>{
    const [workflow,packageDocument,readme,robots,sitemap]=await Promise.all([
        readFile(path.join(repositoryRoot,'.github','workflows','pages.yml'),'utf8'),
        readJson(path.join(repositoryRoot,'package.json')),
        readFile(path.join(repositoryRoot,'README.md'),'utf8'),
        readSiteFile('robots.txt'),
        readSiteFile('sitemap.xml')
    ]);
    await t.test('uses least privilege and one successful canonical main check',()=>{
        assert.match(workflow,/permissions:\s*\{\}/u);
        assert.match(workflow,/actions:\s*read/u);
        assert.match(workflow,/contents:\s*read/u);
        assert.match(workflow,/pages:\s*write/u);
        assert.match(workflow,/id-token:\s*write/u);
        assert.match(workflow,/github[.]repository == 'TheWizardNexus\/arcane-os-sdk'/u);
        assert.match(workflow,/workflow_run[.]event == 'push'/u);
        assert.match(workflow,/workflow_run[.]conclusion == 'success'/u);
        assert.match(workflow,/head_branch == 'main'/u);
    });
    await t.test('checks out, authenticates, and deploys the resolved revision',()=>{
        assert.match(workflow,/actions\/workflows\/check[.]yml\/runs/u);
        assert.match(workflow,/-f branch=main/u);
        assert.match(workflow,/actions\/checkout@v7[\s\S]*ref: \$\{\{ steps[.]check[.]outputs[.]checked_sha \}\}/u);
        assert.match(workflow,/git rev-parse HEAD/u);
        assert.match(workflow,/actions\/configure-pages@v6/u);
        assert.match(workflow,/test -f site\/reference\/reference-manifest[.]json/u);
        assert.match(workflow,/test -f site\/reference\/sdk-api\/index[.]html/u);
        assert.match(workflow,/test -f site\/reference\/event-manager\/index[.]html/u);
        assert.match(workflow,/test -f site\/reference\/core\/arcane-api\/index[.]html/u);
        assert.match(workflow,/test -f site\/reference\/inventory\/package-api[.]json/u);
        assert.match(workflow,/actions\/upload-pages-artifact@v5/u);
        assert.match(workflow,/path: [.][/]site/u);
        assert.match(workflow,/actions\/deploy-pages@v5/u);
    });
    await t.test('publishes every canonical route outside the npm package',async()=>{
        assert.equal(packageDocument.homepage,canonicalRoot);
        assert.equal(packageDocument.files.some(entry=>entry.startsWith('site')),false);
        assert.match(robots,/Sitemap: https:\/\/thewizardnexus[.]github[.]io\/arcane-os-sdk\/sitemap[.]xml/u);
        const locations=[...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(match=>match[1]).sort();
        const pageRoutes=await loadPageRoutes();
        const expected=[...pageRoutes.values()].map(route=>`${canonicalRoot}${route}`).sort();
        assert.deepEqual(locations,expected);
    });
    await t.test('README points to the canonical site and repository',()=>{
        assert.match(readme,/https:\/\/thewizardnexus[.]github[.]io\/arcane-os-sdk\//u);
        assert.doesNotMatch(readme,/https:\/\/thewizardnexus[.]github[.]io\/arcane-os-sdk\/dev\//u);
        assert.match(readme,/main\/site\/assets\/arcane-os-sdk-readme-header[.]png/u);
        assert.match(readme,/https:\/\/github[.]com\/TheWizardNexus\/arcane-os-sdk/u);
    });
});

import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    RELEASE_MANIFEST_NAME,
    discoverApps,
    inspectApp,
    packageApp,
    verifyApp
} from '../src/packager/core.mjs';

async function writeJson(filePath,value){
    await writeFile(filePath,`${JSON.stringify(value,null,2)}\n`,'utf8');
}

async function workspaceFixture(t,{security}={}){
    const workspaceRoot=await mkdtemp(path.join(os.tmpdir(),'arcane-packager-content-'));
    t.after(()=>rm(workspaceRoot,{recursive:true,force:true}));
    const appRoot=path.join(workspaceRoot,'apps','complete-app');
    await Promise.all([
        mkdir(path.join(appRoot,'content'),{recursive:true}),
        mkdir(path.join(workspaceRoot,'runtime','modules'),{recursive:true})
    ]);
    await writeJson(path.join(workspaceRoot,'arcane-packager.json'),{
        schemaVersion:1,
        appsRoot:'apps',
        distRoot:'dist',
        sharedPayloads:{
            runtime:[{
                source:'runtime',
                destination:'arcane',
                include:['modules'],
                exclude:[]
            }]
        }
    });
    await writeJson(path.join(appRoot,'arcane-package.json'),{
        schemaVersion:1,
        id:'complete-app',
        displayName:'Complete App',
        version:'1.2.3',
        entry:'index.html',
        strategy:'static',
        ...(security===undefined?{}:{security}),
        include:['index.html','content'],
        exclude:[],
        shared:['runtime']
    });
    const html='<!doctype html>\n<title>Complete content</title>\n<p>  preserve spacing  </p>\n';
    const document='first line\nsecond line\nthird line with trailing space \n';
    const module='export const complete = `all shared content`;\n';
    await Promise.all([
        writeFile(path.join(appRoot,'index.html'),html),
        writeFile(path.join(appRoot,'content','document.txt'),document),
        writeFile(path.join(workspaceRoot,'runtime','modules','complete.js'),module)
    ]);
    return {workspaceRoot,appRoot,html,document,module};
}

test('selected static package carries one release through entry, modules, Worker and CSS references',async t=>{
    const selected=await workspaceFixture(t);
    const sourceRoot=path.join(selected.workspaceRoot,'runtime','modules');
    const version='8.7.6';
    await writeJson(path.join(selected.workspaceRoot,'arcane.lock.json'),{sdk:{version}});
    const corpus='<base href="./"><script src="./original.js"></script>'
        +'<style>p{background:url(original.svg)}</style><p>Complete supplied HTML</p>';
    await writeFile(path.join(selected.appRoot,'content','document.html'),corpus);
    await writeFile(path.join(selected.appRoot,'index.html'),
        '<!doctype html><base href="../../"><script type="module" src="./arcane/modules/entry.js?v=6"></script>'
        +'<link rel="stylesheet" href="./arcane/modules/theme.css?theme=day#palette">'
        +'<p>./arcane/modules/entry.js?v=6</p>');
    await writeFile(path.join(sourceRoot,'entry.js'),
        "import './child.js?v=2';\nnew Worker(new URL('./worker.js',import.meta.url),{type:'module'});\n");
    await writeFile(path.join(sourceRoot,'child.js'),'export const content="keep all text";\n');
    await writeFile(path.join(sourceRoot,'worker.js'),"import './child.js?v=2';\n");
    await writeFile(path.join(sourceRoot,'theme.css'),'body{background:url(./icon.svg?color=blue#mark)}\n');
    await writeFile(path.join(sourceRoot,'icon.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(path.join(selected.appRoot,'content','App.js'),"new Worker('./apps/complete-app/content/root-worker.js',{type:'module'});\n");
    await writeFile(path.join(selected.appRoot,'content','root-worker.js'),"import './worker-child.js';\n");
    await writeFile(path.join(selected.appRoot,'content','worker-child.js'),'export const workerReady=true;\n');
    const initialEntry=await readFile(path.join(selected.appRoot,'index.html'),'utf8');
    await writeFile(path.join(selected.appRoot,'index.html'),initialEntry
        +'<script type="module" src="./apps/complete-app/content/App.js"></script>');
    const packaged=await packageApp({workspaceRoot:selected.workspaceRoot,appId:'complete-app'});
    const entry=await readFile(path.join(packaged.outputRoot,'apps/complete-app/index.html'),'utf8');
    assert.ok(entry.includes(`entry.js?v=6&amp;arcaneVersion=${version}`));
    assert.ok(entry.includes(`theme.css?theme=day&amp;arcaneVersion=${version}#palette`));
    assert.ok(entry.includes('<p>./arcane/modules/entry.js?v=6</p>'));
    const module=await readFile(path.join(packaged.outputRoot,'arcane/modules/entry.js'),'utf8');
    assert.ok(module.includes(`child.js?v=2&arcaneVersion=${version}`));
    assert.ok(module.includes(`worker.js?arcaneVersion=${version}`));
    const worker=await readFile(path.join(packaged.outputRoot,'arcane/modules/worker.js'),'utf8');
    assert.ok(worker.includes(`child.js?v=2&arcaneVersion=${version}`));
    const style=await readFile(path.join(packaged.outputRoot,'arcane/modules/theme.css'),'utf8');
    assert.ok(style.includes(`icon.svg?color=blue&arcaneVersion=${version}#mark`));
    assert.equal(await readFile(path.join(packaged.outputRoot,'apps/complete-app/content/document.html'),'utf8'),corpus);
    assert.ok((await readFile(path.join(packaged.outputRoot,'apps/complete-app/content/root-worker.js'),'utf8'))
        .includes(`worker-child.js?arcaneVersion=${version}`));
    assert.equal(await readFile(path.join(packaged.outputRoot,'apps/complete-app/content/document.txt'),'utf8'),selected.document);
});

test('packager materializes every selected app and shared file with complete content',async t=>{
    const selected=await workspaceFixture(t);
    assert.deepEqual(await discoverApps({workspaceRoot:selected.workspaceRoot}),['complete-app']);
    const inspected=await inspectApp({workspaceRoot:selected.workspaceRoot,appId:'complete-app'});
    assert.deepEqual(inspected.files,[
        'apps/complete-app/content/document.txt',
        'apps/complete-app/index.html',
        'arcane/modules/complete.js',
        'index.html'
    ]);

    const packaged=await packageApp({workspaceRoot:selected.workspaceRoot,appId:'complete-app'});
    assert.deepEqual(packaged.files,inspected.files);
    assert.equal(await readFile(path.join(packaged.outputRoot,'apps/complete-app/index.html'),'utf8'),selected.html);
    assert.equal(await readFile(
        path.join(packaged.outputRoot,'apps','complete-app','content','document.txt'),
        'utf8'
    ),selected.document);
    assert.equal(await readFile(
        path.join(packaged.outputRoot,'arcane','modules','complete.js'),
        'utf8'
    ),selected.module);

    const release=JSON.parse(await readFile(
        path.join(packaged.outputRoot,RELEASE_MANIFEST_NAME),
        'utf8'
    ));
    assert.deepEqual(release.files,inspected.files);
    assert.equal(release.app.id,'complete-app');
    assert.equal(release.app.version,'1.2.3');
    assert.equal(release.app.entry,'index.html');
    assert.equal(release.app.start,'./apps/complete-app/index.html');
    const launcher=await readFile(path.join(packaged.outputRoot,'index.html'),'utf8');
    assert.ok(launcher.includes('url=./apps/complete-app/index.html'));
    assert.ok(launcher.includes('href="./apps/complete-app/index.html"'));

    const verified=await verifyApp({workspaceRoot:selected.workspaceRoot,appId:'complete-app'});
    assert.equal(verified.verified,true);
    assert.deepEqual(verified.files,inspected.files);
});

test(
    'scaffold-style pages resolve app and SDK resources inside a package mounted below the origin root',
    async function packagedWorkspaceRoutes(context) {
        const selected = await workspaceFixture(context);
        const configPath = path.join(selected.appRoot, 'arcane-package.json');
        const config = JSON.parse(await readFile(configPath, 'utf8'));
        config.entry = 'pages/review.html';
        config.include = ['index.html', 'manifest.json', 'app.css', 'modules', 'pages', 'content'];
        await writeJson(configPath, config);
        await Promise.all(
            [
                mkdir(path.join(selected.appRoot, 'modules')),
                mkdir(path.join(selected.appRoot, 'pages'))
            ]
        );
        const source = '<!doctype html><html><head><base href="../../">'
            + '<link rel="manifest" href="./apps/complete-app/manifest.json">'
            + '<link rel="stylesheet" href="./apps/complete-app/app.css">'
            + '<script type="module" src="./arcane/modules/complete.js"></script>'
            + '</head><body><p>Preserve ./apps/complete-app/app.css in this text.</p>'
            + '<script type="module" src="./apps/complete-app/modules/App.js"></script>'
            + '</body></html>\n';
        const nestedSource = source.replace('<base href="../../">', '<base href="../../../">');
        const manifest = '{"name":"Complete App","start_url":"./index.html"}\n';
        await Promise.all(
            [
                writeFile(path.join(selected.appRoot, 'index.html'), source),
                writeFile(path.join(selected.appRoot, 'pages/review.html'), nestedSource),
                writeFile(path.join(selected.appRoot, 'manifest.json'), manifest),
                writeFile(path.join(selected.appRoot, 'app.css'), 'body { background: url(./content/icon.svg); }\n'),
                writeFile(path.join(selected.appRoot, 'content/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n'),
                writeFile(path.join(selected.appRoot, 'modules/App.js'), "import '../../../arcane/modules/complete.js';\n")
            ]
        );
        const inspected = await inspectApp(
            {workspaceRoot: selected.workspaceRoot, appId: 'complete-app'}
        );
        assert.deepEqual(
            inspected.browserDocuments.map(
                function selectedDocumentPaths(document) {
                    return {path: document.path, packagePath: document.packagePath};
                }
            ),
            [
                {path: 'pages/review.html', packagePath: 'apps/complete-app/pages/review.html'},
                {path: 'index.html', packagePath: 'apps/complete-app/index.html'}
            ]
        );
        const packaged = await packageApp(
            {workspaceRoot: selected.workspaceRoot, appId: 'complete-app'}
        );
        const mount = new URL('https://example.test/catalog/deep/portable-release/');
        assert.equal(packaged.manifest.app.entry, 'pages/review.html');
        assert.equal(
            new URL(packaged.manifest.app.start, mount).pathname,
            '/catalog/deep/portable-release/apps/complete-app/pages/review.html'
        );
        const launcher = await readFile(path.join(packaged.outputRoot, 'index.html'), 'utf8');
        assert.ok(launcher.includes('url=./apps/complete-app/pages/review.html'));
        for (const relative of ['apps/complete-app/index.html', 'apps/complete-app/pages/review.html']) {
            const page = await readFile(path.join(packaged.outputRoot, relative), 'utf8');
            const pageUrl = new URL(relative, mount);
            const base = new URL(page.match(/<base href="([^"]+)">/u)[1], pageUrl);
            assert.equal(base.href, mount.href);
            const resourceReferences = [...page.matchAll(/(?:src|href)="(\.\/(?:apps|arcane)\/[^"]+)"/gu)];
            assert.equal(resourceReferences.length, 4);
            for (const match of resourceReferences) {
                const target = new URL(match[1], base);
                assert.ok(target.pathname.startsWith(mount.pathname));
                assert.ok(packaged.files.includes(target.pathname.slice(mount.pathname.length)));
            }
            assert.ok(page.includes('<p>Preserve ./apps/complete-app/app.css in this text.</p>'));
        }
        const appModule = await readFile(
            path.join(packaged.outputRoot, 'apps/complete-app/modules/App.js'),
            'utf8'
        );
        const dependency = appModule.match(/import '([^']+)'/u)[1];
        assert.equal(
            new URL(dependency, new URL('apps/complete-app/modules/App.js', mount)).pathname,
            new URL('arcane/modules/complete.js', mount).pathname
        );
        const stylesheet = await readFile(
            path.join(packaged.outputRoot, 'apps/complete-app/app.css'),
            'utf8'
        );
        const image = stylesheet.match(/url\(([^)]+)\)/u)[1];
        assert.equal(
            new URL(image, new URL('apps/complete-app/app.css', mount)).pathname,
            new URL('apps/complete-app/content/icon.svg', mount).pathname
        );
        assert.equal(await readFile(path.join(selected.appRoot, 'index.html'), 'utf8'), source);
        assert.equal(await readFile(path.join(selected.appRoot, 'pages/review.html'), 'utf8'), nestedSource);
        assert.equal(await readFile(path.join(packaged.outputRoot, 'apps/complete-app/manifest.json'), 'utf8'), manifest);
    }
);

test('ordinary app packaging permits omitted security and preserves an explicit record',async t=>{
    const ordinary=await workspaceFixture(t);
    const ordinaryResult=await packageApp({
        workspaceRoot:ordinary.workspaceRoot,
        appId:'complete-app'
    });
    assert.equal(Object.hasOwn(ordinaryResult.manifest.app,'security'),false);

    const explicit=await workspaceFixture(t,{
        security:{connectOrigins:['https://example.test']}
    });
    const explicitResult=await packageApp({
        workspaceRoot:explicit.workspaceRoot,
        appId:'complete-app'
    });
    assert.deepEqual(explicitResult.manifest.app.security,{
        connectOrigins:['https://example.test']
    });
});

test('dry-run returns the complete structural inventory without creating release output',async t=>{
    const selected=await workspaceFixture(t);
    const result=await packageApp({
        workspaceRoot:selected.workspaceRoot,
        appId:'complete-app',
        dryRun:true
    });
    assert.equal(result.dryRun,true);
    assert.deepEqual(result.files,[
        'apps/complete-app/content/document.txt',
        'apps/complete-app/index.html',
        'arcane/modules/complete.js',
        'index.html'
    ]);
});

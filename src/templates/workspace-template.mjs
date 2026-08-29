import {
    ARCANE_PROTOCOL,
    CLI_EVENT_PROTOCOL,
    SDK_NAME,
    SDK_VERSION,
    TARGET_ADAPTER_PROTOCOL
} from '../constants.mjs';

const NPM_PACKAGE_NAME_PATTERN=/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const LOCAL_TARBALL_PATTERN=/^file:.+\.tgz$/iu;

function json(value){
    return `${JSON.stringify(value,null,2)}\n`;
}

function html(value){
    return String(value)
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;')
        .replaceAll('"','&quot;')
        .replaceAll("'",'&#39;');
}

function titleCase(appId){
    return appId.split('-')
        .map(part=>`${part.slice(0,1).toUpperCase()}${part.slice(1)}`)
        .join(' ');
}

export function createWorkspaceLockDocument({
    dependencyName=SDK_NAME,
    packageName=SDK_NAME,
    packageVersion=SDK_VERSION,
    packageSource=`node_modules/${dependencyName}`
}={}){
    if(packageName!==SDK_NAME||typeof packageVersion!=='string'
        ||!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(packageVersion)
        ||typeof dependencyName!=='string'||dependencyName.length>214
        ||!NPM_PACKAGE_NAME_PATTERN.test(dependencyName)
        ||packageSource!==`node_modules/${dependencyName}`){
        throw new Error('Invalid workspace SDK lock authority.');
    }
    return {
        schemaVersion:1,
        sdk:{name:packageName,version:packageVersion},
        runtime:{root:`${packageSource}/runtime`},
        sdkBrowserRuntime:{root:`${packageSource}/browser-runtime`},
        protocols:{
            arcane:ARCANE_PROTOCOL,
            cliEvents:CLI_EVENT_PROTOCOL,
            targetAdapter:TARGET_ADAPTER_PROTOCOL
        }
    };
}

export function workspaceTemplate({
    appId,
    displayName,
    sdkDependencyName=SDK_NAME,
    sdkDependencySpecifier=SDK_VERSION,
    sdkPackageSource=`node_modules/${sdkDependencyName}`,
    appOnly=false,
    namedImports=true,
    minimumCoreVersion='0.8.12',
    target='browser',
    appIcon
}){
    const canonicalSpecifier=sdkDependencyName===SDK_NAME
        &&(sdkDependencySpecifier===SDK_VERSION
            ||(typeof sdkDependencySpecifier==='string'
                &&LOCAL_TARBALL_PATTERN.test(sdkDependencySpecifier)
                &&!/[\x00-\x1f\x7f]/.test(sdkDependencySpecifier)));
    const aliasSpecifier=sdkDependencyName!==SDK_NAME
        &&sdkDependencySpecifier===`npm:${SDK_NAME}@${SDK_VERSION}`;
    if(typeof sdkDependencyName!=='string'||sdkDependencyName.length>214
        ||!NPM_PACKAGE_NAME_PATTERN.test(sdkDependencyName)
        ||sdkPackageSource!==`node_modules/${sdkDependencyName}`
        ||(!canonicalSpecifier&&!aliasSpecifier)){
        throw new Error('Invalid scaffold SDK installation authority.');
    }
    const supportedTargets=['browser','portable','windows-x64','linux-x64','linux-arm64','android-arm64'];
    if(!supportedTargets.includes(target)){
        throw new Error(`Unsupported scaffold target: ${String(target)}.`);
    }
    const native=target!=='browser';
    const buildTarget=native?target:'browser';
    const runTarget=native&&target!=='portable'?target:'browser';
    if(native&&!(appIcon instanceof Uint8Array)){
        throw new Error(`The ${target} scaffold requires its bundled raster icon.`);
    }
    const name=displayName||`Arcane ${titleCase(appId)}`;
    const packageName=`arcane-${appId}`;
    const packageInclude=[`${appId}.css`,'index.html'];
    if(native)packageInclude.push('img/icon.png');
    packageInclude.push('manifest.json','modules');
    const nativeGuide=native?`
## ${target} native target

This scaffold declares both the browser and ${target} targets and includes the
required raster application icon.
Pair it with one explicit Arcane OS checkout:

\`\`\`sh
npm exec -- arcane native-doctor --target ${target} --arcane-root "<path-to-Arcane-OS>"
npm run build -- --arcane-root "<path-to-Arcane-OS>"
${target==='portable'?'':`npm run run -- --arcane-root "<path-to-Arcane-OS>"\n`}
\`\`\`

The selected Arcane provider must support this target or the command fails without
substituting a browser package. Native output defaults to \`build/${target}/\`.
${target==='portable'?'The portable result is an app-scoped Core directory, not a directly runnable executable.\n':''}
The generated \`img/icon.png\` is an Arcane OS SDK template asset governed by
the SDK's license terms; replace it with your own raster application icon when
appropriate.
`:'';

    const importMapMarkup=namedImports?`    <script type="importmap" data-arcane-import-map>
{
  "imports": {}
}
    </script>
`:'';
    const bootstrapMarkup=namedImports?'':
        '    <script type="module" src="./arcane/modules/ThemeBootstrap.js?v=1"></script>\n';
    const files=new Map();
    files.set('.gitignore',[
        'node_modules/',
        'dist/',
        'build/',
        '.arcane/',
        '*.log',
        ''
    ].join('\n'));
    files.set('.gitattributes',[
        '* text=auto',
        '*.js text eol=lf',
        '*.mjs text eol=lf',
        '*.json text eol=lf',
        '*.html text eol=lf',
        '*.css text eol=lf',
        '*.md text eol=lf',
        ''
    ].join('\n'));
    files.set('AGENTS.md',`# ${name} development instructions

- Use plain JavaScript, HTML, and CSS; do not introduce TypeScript or TSX.
- Keep reusable portable mechanisms in the Arcane SDK and app-specific behavior under \`apps/${appId}/\`.
- Keep \`arcane/css/theme.css\` before app styles and import \`arcane/ThemeBootstrap\` before app code runs.
- Use \`rgb(...)\` or \`rgba(...)\` for new CSS colors.
- Build one named app and one explicit target at a time. Native targets may be unavailable until their adapters are installed.
- Preserve complete application, model, document, message, log, diagnostic, process, and tool content. Do not truncate, clip, tail, elide, or silently discard it.
- Do not make ordinary application behavior depend on byte counts, byte limits, byte identities, hashes, digests, or byte-based admission.
- Optional hardening must remain inactive unless the user expressly selects secure: true for the exact operation. The ordinary path must remain fully functional.
- Run tests and checks only when the user explicitly selects verification or a distribution artifact requires it.
`);
    files.set('README.md',`# ${name}

This repository contains the portable Arcane application \`${appId}\`. It includes the selected SDK runtime for distribution and has no runtime dependency on an Arcane OS source checkout.

## Start

\`\`\`sh
npm install
npm run dev
\`\`\`

Open the loopback URL printed by the development server. The source server exposes this app and its physical \`arcane/\` runtime; it does not expose an Ollama HTTP endpoint.

Commit the generated \`package-lock.json\` after dependency installation. CI intentionally uses \`npm ci\` and therefore requires that lock. Before the SDK is published, install a locally packed \`${SDK_NAME}\` \`.tgz\` with \`npm install --save-dev --save-exact <path-to-tarball>\`; keep that tarball at the lock file's relative path for repeatable local \`npm ci\` runs.

## Optional browser release commands

\`\`\`sh
npm run import-map
npm run package
npm run verify
npm run bundle
npm run run
\`\`\`

The explicit \`import-map\` command refreshes
\`apps/${appId}/modules/arcane.importmap.json\` and the managed inline browser
import map in every directly navigable descriptor-admitted \`.html\`/\`.htm\`
document. HTML component fragments remain package files but do not receive a
document-level base or managed import map.
Development, package, and build refresh that shared inventory when the selected operation needs it.
Named \`arcane/*\` imports resolve against the physical workspace \`arcane/\`
tree. Packaging copies the complete selected application, runtime, and specifier
map to \`dist/${appId}\` without running application tests. Run \`verify\` only when
the user explicitly selects verification or a release artifact that requires it;
\`bundle\` creates the distributable archive and \`run\` launches the selected
packaged browser release.

Native targets are provider-supplied and must be scaffolded and selected
explicitly; this browser workflow does not imply a standalone native executable.
${nativeGuide}

Every browser release also carries Arcane OS licensing material under \`licenses/arcane-os/\`. Review those terms before distribution.
`);
    files.set('package.json',json({
        name:packageName,
        private:true,
        type:'module',
        scripts:{
            doctor:'arcane doctor',
            dev:'arcane dev',
            test:'arcane test',
            check:'arcane check',
            'import-map':'arcane import-map',
            package:'arcane package',
            verify:'arcane verify',
            bundle:'arcane bundle',
            build:`arcane build --target ${buildTarget}`,
            run:`arcane run --target ${runTarget}`,
            ...(native?{
                'build:browser':'arcane build --target browser',
                'run:browser':'arcane run --target browser'
            }:{})
        },
        devDependencies:{
            [sdkDependencyName]:sdkDependencySpecifier
        },
        engines:{node:'>=22.23.2'}
    }));
    files.set('arcane-packager.json',json({
        schemaVersion:1,
        appsRoot:'apps',
        distRoot:'dist',
        sharedPayloads:{
            'browser-runtime':[
                {
                    source:'arcane',
                    destination:'arcane',
                    include:['components','css','dependencies','entities','img','modules','sdk'],
                    exclude:[]
                },
                {
                    source:sdkPackageSource,
                    destination:'licenses/arcane-os',
                    include:['LICENSE','COMMERCIAL-LICENSE.md','NOTICE'],
                    exclude:[]
                }
            ]
        }
    }));
    files.set('arcane.lock.json',json(createWorkspaceLockDocument({
        dependencyName:sdkDependencyName,
        packageSource:sdkPackageSource
    })));
    files.set(`apps/${appId}/arcane-app.json`,json({
        schemaVersion:2,
        id:appId,
        displayName:name,
        description:`${name} Arcane application.`,
        version:'0.1.0',
        publisher:{
            id:'the-wizard-nexus',
            name:'The Wizard Nexus'
        },
        package:{
            entry:'index.html',
            strategy:'static',
            include:packageInclude,
            exclude:[],
            shared:['browser-runtime']
        },
        native:{
            type:'app',
            icon:native?'img/icon.png':null,
            order:100,
            bundledApps:[]
        },
        requirements:{
            arcaneProtocol:'arcane/1',
            ...(native?{minimumCoreVersion}:{}),
            features:[]
        },
        targets:native?['browser',target].sort():['browser']
    }));
    files.set(`apps/${appId}/arcane-package.json`,json({
        schemaVersion:1,
        id:appId,
        displayName:name,
        version:'0.1.0',
        entry:'index.html',
        strategy:'static',
        include:packageInclude,
        exclude:[],
        shared:['browser-runtime']
    }));
    files.set(`apps/${appId}/manifest.json`,json({
        name,
        short_name:titleCase(appId),
        start_url:'./index.html',
        display:'standalone',
        background_color:'rgb(13, 18, 32)',
        theme_color:'rgb(23, 34, 56)',
        icons:[]
    }));
    files.set(`apps/${appId}/index.html`,`<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="arcane-app-id" content="${html(appId)}">
    <base href="../../">
${importMapMarkup}    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="rgb(23, 34, 56)">
    <title>${html(name)}</title>
    <link rel="manifest" href="./apps/${html(appId)}/manifest.json">
    <link rel="stylesheet" href="./arcane/css/theme.css?v=1">
    <link rel="stylesheet" href="./arcane/css/primitives.css?v=1">
    <link rel="stylesheet" href="./apps/${html(appId)}/${html(appId)}.css?v=1">
${bootstrapMarkup}</head>
<body>
    <main class="app-shell">
        <section class="arcane-card" aria-labelledby="app-title">
            <header class="arcane-card__header">
                <div>
                    <p class="eyebrow">Arcane application</p>
                    <h1 id="app-title">${html(name)}</h1>
                </div>
            </header>
            <div class="arcane-card__body">
                <p id="app-status" role="status" aria-live="polite">Ready.</p>
                <button id="app-action" class="arcane-button" type="button">Test the app</button>
            </div>
        </section>
    </main>
    <script type="module" src="./apps/${html(appId)}/modules/App.js?v=1"></script>
</body>
</html>
`);
    files.set(`apps/${appId}/${appId}.css`,`body {
    margin: 0;
    min-height: 100vh;
    background: var(--background, rgb(13, 18, 32));
    color: var(--text-color, rgb(235, 241, 255));
}

.app-shell {
    box-sizing: border-box;
    width: min(52rem, 100%);
    margin: 0 auto;
    padding: 2rem 1rem;
}

.eyebrow {
    color: var(--accent-color, rgb(116, 167, 255));
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}
`);
    if(namedImports){
        files.set(`apps/${appId}/modules/arcane.importmap.json`,json({imports:{}}));
    }
    const themeSpecifier=namedImports
        ?'arcane/ThemeBootstrap':'../../../arcane/modules/ThemeBootstrap.js';
    const appDataSpecifier=namedImports
        ?'arcane/AppDataScope':'../../../arcane/modules/AppDataScope.js';
    files.set(`apps/${appId}/modules/App.js`,`import arcaneThemeReady from '${themeSpecifier}';
import {
    resolveApplicationId,
    resolveApplicationLocalStorageKey
} from '${appDataSpecifier}';

const appName=${JSON.stringify(name)};
const action=document.querySelector('#app-action');
const status=document.querySelector('#app-status');

await arcaneThemeReady;

const appId=await resolveApplicationId();
const countKey=resolveApplicationLocalStorageKey('hello-count',{applicationId:appId});

function loadHelloCount(){
    try{
        const value=Number(globalThis.localStorage?.getItem(countKey)??0);
        return Number.isSafeInteger(value)&&value>=0?value:0;
    }catch{
        return 0;
    }
}

function saveHelloCount(value){
    try{
        globalThis.localStorage?.setItem(countKey,String(value));
    }catch{
        // The greeting still works when browser persistence is unavailable.
    }
}

action?.addEventListener('click',()=>{
    const count=loadHelloCount()+1;
    saveHelloCount(count);
    status.textContent=\`Hello from \${appName}! Greeting \${count}.\`;
});
`);
    if(native){
        files.set(`apps/${appId}/img/icon.png`,Buffer.from(appIcon));
    }
    files.set(`apps/${appId}/test/app.test.mjs`,`import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from '${SDK_NAME}/testing';

const appRoot=new URL('../',import.meta.url);

test('application shell uses the shared Arcane theme in order',async()=>{
    const [source,appSource]=await Promise.all([
        readFile(new URL('index.html',appRoot),'utf8'),
        readFile(new URL('modules/App.js',appRoot),'utf8')
    ]);
    const theme=source.indexOf('./arcane/css/theme.css');
    const primitives=source.indexOf('./arcane/css/primitives.css');
    const appStyle=source.indexOf('./apps/${appId}/${appId}.css');
    const importMap=source.indexOf('${namedImports?'data-arcane-import-map':'./arcane/modules/ThemeBootstrap.js'}');
    const appModule=source.indexOf('./apps/${appId}/modules/App.js');

    assert.match(source,/<base href="\\.\\.\\/\\.\\.\\/">/);
    assert.match(source,/<meta name="arcane-app-id" content="${appId}">/);
    assert.ok(theme>=0&&primitives>theme&&appStyle>primitives);
    assert.ok(importMap>=0&&appModule>importMap);
    assert.ok(appSource.includes("from '${themeSpecifier}'"));
    assert.ok(appSource.includes("from '${appDataSpecifier}'"));
});

test('application package identity matches its directory',async()=>{
    const manifest=JSON.parse(await readFile(new URL('arcane-package.json',appRoot),'utf8'));
    assert.equal(manifest.id,'${appId}');
    assert.equal(manifest.strategy,'static');
    assert.deepEqual(manifest.shared,['browser-runtime']);
});
`);

    if(appOnly){
        return {
            name,
            files:new Map([...files].filter(([relative])=>relative.startsWith(`apps/${appId}/`)))
        };
    }
    return {name,files};
}

export {SDK_NAME,SDK_VERSION};

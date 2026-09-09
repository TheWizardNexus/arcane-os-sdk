import Is from 'strong-type';
import {installedSdkRoutes} from '../sdk-runtime-layout.mjs';
import {
    ARCANE_PROTOCOL,
    CLI_EVENT_PROTOCOL,
    SDK_NAME,
    SDK_VERSION,
    TARGET_ADAPTER_PROTOCOL
} from '../constants.mjs';

const is = new Is(false);

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
    if(packageName!==SDK_NAME||!is.string(packageVersion)
        ||!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(packageVersion)
        ||!is.string(dependencyName)||dependencyName.length>214
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
    appOnly=false,
    appsRoot=appOnly?'apps':'.',
    displayName,
    sdkDependencyName=SDK_NAME,
    sdkDependencySpecifier=SDK_VERSION,
    sdkPackageSource=`node_modules/${sdkDependencyName}`,
    namedImports=true,
    minimumCoreVersion='0.8.12',
    target='browser',
    appIcon
}){
    const canonicalSpecifier=sdkDependencyName===SDK_NAME
        &&(sdkDependencySpecifier===SDK_VERSION
            ||(is.string(sdkDependencySpecifier)
                &&LOCAL_TARBALL_PATTERN.test(sdkDependencySpecifier)
                &&!/[\x00-\x1f\x7f]/.test(sdkDependencySpecifier)));
    const aliasSpecifier=sdkDependencyName!==SDK_NAME
        &&sdkDependencySpecifier===`npm:${SDK_NAME}@${SDK_VERSION}`;
    if(!is.string(sdkDependencyName)||sdkDependencyName.length>214
        ||!NPM_PACKAGE_NAME_PATTERN.test(sdkDependencyName)
        ||sdkPackageSource!==`node_modules/${sdkDependencyName}`
        ||(!canonicalSpecifier&&!aliasSpecifier)){
        throw new Error('Invalid scaffold SDK installation authority.');
    }
    const supportedTargets=['browser','portable','windows-x64','linux-x64','linux-arm64','android-arm64'];
    if(!supportedTargets.includes(target)){
        throw new Error(`Unsupported scaffold target: ${String(target)}.`);
    }
    if(!['apps','.'].includes(appsRoot))throw new Error('appsRoot must be apps or .');
    if(appOnly&&appsRoot==='.')throw new Error('Root scaffolding selects a standalone workspace.');
    const appPrefix=appsRoot==='.'?'':`apps/${appId}/`;
    const directRuntime=appsRoot==='.'&&!appOnly;
    const runtimePrefix=directRuntime?`./${sdkPackageSource}/runtime/arcane`:'./arcane';
    const baseHref=appsRoot==='.'?'./':'../../';
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
        `    <script type="module" src="${runtimePrefix}/modules/ThemeBootstrap.js?v=1"></script>\n`;
    const files=new Map();
    files.set('.gitignore',[
        'node_modules/',
        'dist/',
        'build/',
        '.arcane/',
        '.env.json',
        '.arcane.env.json',
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
- Keep reusable portable mechanisms in the Arcane SDK and app-specific behavior under \`${appPrefix||'./'}\`.
- Keep \`${runtimePrefix}/css/theme.css\` before app styles and import \`${directRuntime?'arcane-os/modules/ThemeBootstrap.js':'arcane/ThemeBootstrap'}\` before app code runs.
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
npm run import-map
npm run dev
\`\`\`

Open the loopback URL printed by the development server. ${directRuntime?'This root app reads SDK files directly from its installed npm package; an ordinary static host uses the same resource paths.':'This app uses the existing physical arcane/ runtime layout.'} The SDK server does not expose an Ollama HTTP endpoint.

Commit the generated \`package-lock.json\` after dependency installation. CI intentionally uses \`npm ci\` and therefore requires that lock. ${directRuntime?'The SDK is a runtime dependency: keep it installed when serving this app directly from node_modules. ':''}Before the SDK is published, install a locally packed \`${SDK_NAME}\` \`.tgz\` with \`npm install ${directRuntime?'--save-prod':'--save-dev'} --save-exact <path-to-tarball>\`; keep that tarball at the lock file's relative path for repeatable local \`npm ci\` runs.

## Optional browser release commands

\`\`\`sh
npm run import-map
npm run package
npm run verify
npm run bundle
npm run run
\`\`\`

The explicit \`import-map\` command refreshes
\`${appPrefix}modules/arcane.importmap.json\` and the managed inline browser
import map in every directly navigable descriptor-admitted \`.html\`/\`.htm\`
document. HTML component fragments remain package files but do not receive a
document-level base or managed import map.
Development, package, and build refresh that shared inventory when the selected operation needs it.
Commit generated import maps and enabled offline app files. Hosting workflows consume those committed files rather than generating them.
Named \`${directRuntime?'arcane-os/modules/* and arcane-os/entities/*':'arcane/*'}\` imports resolve through the managed map to the selected SDK files. Packaging copies the complete selected application, runtime, and specifier
map to \`dist/${appId}\` without running application tests. Run \`verify\` only when
the user explicitly selects verification or a release artifact that requires it;
\`bundle\` creates the distributable archive and \`run\` launches the selected
packaged browser release.

Native targets are provider-supplied and must be scaffolded and selected
explicitly; this browser workflow does not imply a standalone native executable.
${nativeGuide}

Every browser release also carries Arcane OS licensing material under \`${directRuntime?sdkPackageSource:'licenses/arcane-os'}\`. Review those terms before distribution.
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
        [directRuntime?'dependencies':'devDependencies']:{
            [sdkDependencyName]:sdkDependencySpecifier
        },
        engines:{node:'>=22.23.2'}
    }));
    files.set('arcane-packager.json',json({
        schemaVersion:1,
        appsRoot,
        distRoot:'dist',
        sharedPayloads:{
            'browser-runtime':directRuntime?installedSdkRoutes(sdkPackageSource,{direct:true}):[
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
    if(!directRuntime)files.set('arcane.lock.json',json(createWorkspaceLockDocument({
        dependencyName:sdkDependencyName,
        packageSource:sdkPackageSource
    })));
    files.set(`${appPrefix}arcane-app.json`,json({
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
    files.set(`${appPrefix}arcane-package.json`,json({
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
    files.set(`${appPrefix}manifest.json`,json({
        name,
        short_name:titleCase(appId),
        start_url:'./index.html',
        display:'standalone',
        background_color:'rgb(13, 18, 32)',
        theme_color:'rgb(23, 34, 56)',
        icons:[]
    }));
    files.set(`${appPrefix}index.html`,`<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="arcane-app-id" content="${html(appId)}">
    <base href="${baseHref}">
${importMapMarkup}    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="rgb(23, 34, 56)">
    <title>${html(name)}</title>
    <link rel="manifest" href="./${html(appPrefix)}manifest.json">
    <link rel="stylesheet" href="${runtimePrefix}/css/theme.css?v=1">
    <link rel="stylesheet" href="${runtimePrefix}/css/primitives.css?v=1">
    <link rel="stylesheet" href="./${html(appPrefix)}${html(appId)}.css?v=1">
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
    <script type="module" src="./${html(appPrefix)}modules/App.js?v=1"></script>
</body>
</html>
`);
    files.set(`${appPrefix}${appId}.css`,`body {
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
        files.set(`${appPrefix}modules/arcane.importmap.json`,json({imports:{}}));
    }
    const themeSpecifier=namedImports
        ?directRuntime?'arcane-os/modules/ThemeBootstrap.js':'arcane/ThemeBootstrap'
        :`${appsRoot==='.'?'../':'../../../'}${runtimePrefix.slice(2)}/modules/ThemeBootstrap.js`;
    const appDataSpecifier=namedImports
        ?directRuntime?'arcane-os/app-data-scope':'arcane/AppDataScope'
        :`${appsRoot==='.'?'../':'../../../'}${runtimePrefix.slice(2)}/modules/AppDataScope.js`;
    const strongTypeSpecifier=namedImports
        ?'strong-type':directRuntime?`../${sdkPackageSource}/runtime/strong-type/index.js`:'../../../arcane/dependencies/strong-type/index.js';
    files.set(`${appPrefix}modules/App.js`,`import Is from '${strongTypeSpecifier}';
import arcaneThemeReady from '${themeSpecifier}';
import {
    resolveApplicationId,
    resolveApplicationLocalStorageKey
} from '${appDataSpecifier}';

const is = new Is(false);
const appName=${JSON.stringify(name)};
const action=document.querySelector('#app-action');
const status=document.querySelector('#app-status');

await arcaneThemeReady;

const appId=await resolveApplicationId();
const countKey=resolveApplicationLocalStorageKey('hello-count',{applicationId:appId});

function loadHelloCount(){
    try{
        const value=Number(globalThis.localStorage?.getItem(countKey)??0);
        return is.safeInteger(value)&&value>=0?value:0;
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
        files.set(`${appPrefix}img/icon.png`,Buffer.from(appIcon));
    }
    files.set(`${appPrefix}test/app.test.mjs`,`import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from '${SDK_NAME}/testing';

const appRoot=new URL('../',import.meta.url);

test('application shell uses the shared Arcane theme in order',async()=>{
    const [source,appSource]=await Promise.all([
        readFile(new URL('index.html',appRoot),'utf8'),
        readFile(new URL('modules/App.js',appRoot),'utf8')
    ]);
    const theme=source.indexOf('${runtimePrefix}/css/theme.css');
    const primitives=source.indexOf('${runtimePrefix}/css/primitives.css');
    const appStyle=source.indexOf('./${appPrefix}${appId}.css');
    const importMap=source.indexOf('${namedImports?'data-arcane-import-map':`${runtimePrefix}/modules/ThemeBootstrap.js`}');
    const appModule=source.indexOf('./${appPrefix}modules/App.js');

    assert.ok(source.includes('<base href="${baseHref}">'));
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
            files:new Map([...files].filter(([relative])=>relative.startsWith(`${appPrefix}`)))
        };
    }
    return {name,files};
}

export {SDK_NAME,SDK_VERSION};

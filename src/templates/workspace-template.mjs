const SDK_NAME='arcane-os';
const SDK_VERSION='0.1.0-dev.0';

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

export function workspaceTemplate({appId,displayName,runtimeRelease}){
    const name=displayName||`Arcane ${titleCase(appId)}`;
    const packageName=`arcane-${appId}`;
    const runtimeContentSha256=runtimeRelease?.contentSha256;
    const upstreamCommit=runtimeRelease?.source?.commit;

    if(typeof runtimeContentSha256!=='string'||!/^[a-f0-9]{64}$/.test(runtimeContentSha256)){
        throw new Error('The SDK runtime release does not contain a valid contentSha256.');
    }
    if(typeof upstreamCommit!=='string'||!/^[a-f0-9]{40}$/.test(upstreamCommit)){
        throw new Error('The SDK runtime release does not contain a valid upstream commit.');
    }

    const files=new Map();
    files.set('.gitignore',[
        'node_modules/',
        'dist/',
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
- Keep reusable mechanisms in Arcane OS and app-specific behavior under \`apps/${appId}/\`.
- Keep \`arcane/css/theme.css\` and \`ThemeBootstrap.js\` loaded before app styles and modules.
- Use \`rgb(...)\` or \`rgba(...)\` for new CSS colors.
- Build one named app and one explicit target at a time. Native targets may be unavailable until their adapters are installed.
- Run \`npm run check\` before committing.
`);
    files.set('README.md',`# ${name}

This repository contains the Arcane OS application \`${appId}\`. Its source stays outside the Arcane OS repository and uses the \`${SDK_NAME}\` toolchain.

## Start

\`\`\`sh
npm install
npm run doctor
npm run dev
\`\`\`

Open the loopback URL printed by the development server. The source server exposes this app and the SDK's browser runtime; it does not expose an Ollama HTTP endpoint.

Commit the generated \`package-lock.json\` after dependency installation. CI intentionally uses \`npm ci\` and therefore requires that lock. Before the SDK is published, install a locally packed \`${SDK_NAME}\` \`.tgz\` with \`npm install --save-dev --save-exact <path-to-tarball>\`; keep that tarball at the lock file's relative path for repeatable local \`npm ci\` runs.

## Check and package

\`\`\`sh
npm run check
npm run package
npm run run
\`\`\`

The browser release is written to \`dist/${appId}\`. Linux and Android executables require future native target adapters; the SDK reports those targets as deferred instead of substituting a browser package.

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
            package:'arcane package',
            build:'arcane build --target browser',
            run:'arcane run --target browser'
        },
        devDependencies:{
            [SDK_NAME]:SDK_VERSION
        },
        engines:{node:'>=22.14.0'}
    }));
    files.set('arcane-packager.json',json({
        schemaVersion:1,
        appsRoot:'apps',
        distRoot:'dist',
        sharedPayloads:{
            'browser-runtime':[
                {
                    source:'node_modules/arcane-os/runtime/arcane',
                    destination:'arcane',
                    include:['components','css','entities','img','modules'],
                    exclude:[]
                },
                {
                    source:'node_modules/arcane-os/runtime/strong-type',
                    destination:'node_modules/strong-type',
                    include:['index.js','licence','package.json'],
                    exclude:[]
                },
                {
                    source:'node_modules/arcane-os',
                    destination:'licenses/arcane-os',
                    include:['LICENSE','COMMERCIAL-LICENSE.md','NOTICE'],
                    exclude:[]
                }
            ]
        }
    }));
    files.set('arcane.lock.json',json({
        schemaVersion:1,
        sdk:{name:SDK_NAME,version:SDK_VERSION},
        runtime:{
            manifest:'node_modules/arcane-os/runtime/ARCANE_RUNTIME_RELEASE.json',
            contentSha256:runtimeContentSha256,
            upstreamCommit
        },
        protocols:{
            arcane:'arcane/1',
            cliEvents:'arcane-cli-events/1',
            targetAdapter:'arcane-target-adapter/1'
        }
    }));
    files.set('.github/workflows/check.yml',`name: check

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: \${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          package-manager-cache: false
      - run: npm ci --ignore-scripts
      - run: npm run check
`);
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
            include:[`${appId}.css`,'index.html','manifest.json','modules'],
            exclude:[],
            shared:['browser-runtime']
        },
        permissions:{
            capabilities:[],
            methods:[]
        },
        security:{
            connectOrigins:[],
            frameOrigins:[],
            mediaOrigins:[]
        },
        native:{
            type:'app',
            icon:null,
            order:100,
            bundledApps:[]
        },
        requirements:{
            arcaneProtocol:'arcane/1',
            minimumCoreVersion:'0.8.10',
            features:[]
        },
        targets:['browser']
    }));
    files.set(`apps/${appId}/arcane-package.json`,json({
        schemaVersion:1,
        id:appId,
        displayName:name,
        version:'0.1.0',
        entry:'index.html',
        strategy:'static',
        include:[`${appId}.css`,'index.html','manifest.json','modules'],
        exclude:[],
        shared:['browser-runtime']
    }));
    files.set(`apps/${appId}/manifest.json`,json({
        name,
        short_name:titleCase(appId).slice(0,30),
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
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="rgb(23, 34, 56)">
    <title>${html(name)}</title>
    <link rel="manifest" href="./apps/${html(appId)}/manifest.json">
    <link rel="stylesheet" href="./arcane/css/theme.css?v=1">
    <link rel="stylesheet" href="./arcane/css/primitives.css?v=1">
    <link rel="stylesheet" href="./apps/${html(appId)}/${html(appId)}.css?v=1">
    <script type="module" src="./arcane/modules/ThemeBootstrap.js?v=1"></script>
</head>
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
    files.set(`apps/${appId}/modules/App.js`,`const appName=${JSON.stringify(name)};
const action=document.querySelector('#app-action');
const status=document.querySelector('#app-status');

action?.addEventListener('click',()=>{
    status.textContent=\`The \${appName} app is working.\`;
});
`);
    files.set(`apps/${appId}/test/app.test.mjs`,`import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const appRoot=new URL('../',import.meta.url);

test('application shell uses the shared Arcane theme in order',async()=>{
    const source=await readFile(new URL('index.html',appRoot),'utf8');
    const theme=source.indexOf('./arcane/css/theme.css');
    const primitives=source.indexOf('./arcane/css/primitives.css');
    const appStyle=source.indexOf('./apps/${appId}/${appId}.css');
    const bootstrap=source.indexOf('./arcane/modules/ThemeBootstrap.js');
    const appModule=source.indexOf('./apps/${appId}/modules/App.js');

    assert.match(source,/<base href="\.\.\/\.\.\/">/);
    assert.match(source,/<meta name="arcane-app-id" content="${appId}">/);
    assert.ok(theme>=0&&primitives>theme&&appStyle>primitives);
    assert.ok(bootstrap>appStyle&&appModule>bootstrap);
});

test('application package identity matches its directory',async()=>{
    const manifest=JSON.parse(await readFile(new URL('arcane-package.json',appRoot),'utf8'));
    assert.equal(manifest.id,'${appId}');
    assert.equal(manifest.strategy,'static');
    assert.deepEqual(manifest.shared,['browser-runtime']);
});
`);

    return {name,files};
}

export {SDK_NAME,SDK_VERSION};

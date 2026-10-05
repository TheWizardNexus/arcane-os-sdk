import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import test from '../src/testing.mjs';
import {
    buildImportMap,
    createApplicationTestImportMapContext,
    generateDocumentImportMaps,
    generateImportMap,
    readApplicationTestImportMapContext
} from '../src/import-map.mjs';
import {installedSdkRoutes} from '../src/sdk-runtime-layout.mjs';
import {initialize, resolve} from '../src/testing-loader.mjs';

const runtimeFiles = new Map([
    ['modules/ThemeBootstrap.js', 'export default function ThemeBootstrap() {}\n'],
    ['sdk/websocket-client.mjs', "export {default, WS} from 'ws-share';\n"],
    ['sdk/ai/browser-decisions.mjs', 'export const decisions = true;\n'],
    ['sdk/dependencies/ws-share/WS.js', 'export default class WS {}\nexport {WS};\n'],
    ['sdk/dependencies/event-pubsub/index.js', "import Is from 'strong-type';\nexport default Is;\n"],
    ['sdk/dependencies/event-pubsub/dependencies/strong-type/index.js', 'export const version = "2.0.0";\n'],
    ['dependencies/strong-type/index.js', 'export const version = "2.0.1";\n']
]);

async function fixtureRoot(context) {
    const parent = fileURLToPath(new URL('../.arcane/test-fixtures/', import.meta.url));
    await mkdir(parent, {recursive:true});
    const root = await mkdtemp(path.join(parent, 'websocket-client-import-map-'));
    context.after(async function removeFixture() {
        await rm(root, {recursive:true, force:true});
    });
    return root;
}

async function writeText(root, relative, content) {
    const destination = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(destination), {recursive:true});
    await writeFile(destination, content, 'utf8');
}

async function writeJson(root, relative, document) {
    await writeText(root, relative, `${JSON.stringify(document, null, 2)}\n`);
}

function managedMap(html) {
    const match = html.match(/<script type="importmap" data-arcane-import-map>([\s\S]*?)<\/script>/u);
    assert.ok(match, 'The document contains its managed import map.');
    return JSON.parse(match[1]);
}

test('websocket client maps retain the separate event-pubsub and SDK type versions',
    async function scopedWebSocketDependencies() {
        const result = await buildImportMap({files:[...runtimeFiles.keys()]});
        assert.equal(result.imports['arcane-os/websocket-client'], './arcane/sdk/websocket-client.mjs');
        assert.equal(result.imports['ws-share'], './arcane/sdk/dependencies/ws-share/WS.js');
        assert.equal(result.imports['event-pubsub'], './arcane/sdk/dependencies/event-pubsub/index.js');
        assert.equal(result.imports['strong-type'], './arcane/dependencies/strong-type/index.js');
        assert.equal(result.imports['arcane-os/ai/browser-decisions'], './arcane/sdk/ai/browser-decisions.mjs');
        assert.deepEqual(result.scopes, {
            './arcane/sdk/dependencies/event-pubsub/': {
                'strong-type':'./arcane/sdk/dependencies/event-pubsub/dependencies/strong-type/index.js'
            }
        });
        const olderInventory = await buildImportMap({files:['dependencies/strong-type/index.js']});
        assert.equal(Object.hasOwn(olderInventory, 'scopes'), false);
        assert.equal(olderInventory.imports['strong-type'], './arcane/dependencies/strong-type/index.js');
    }
);

test('document maps rebase dependency scopes with their imports while preserving authored HTML',
    async function documentDependencyScopes(context) {
        const root = await fixtureRoot(context);
        const prefix = '<!doctype html>\r\n<html><head><base href="../assets/">\r\n'
            + '<script type="importmap" data-product-map>{"imports":{"host":"./host.js"}}</script>\r\n';
        const suffix = '<script type="module" src="./boot.js?keep=one#ready" async></script>\r\n'
            + '</head><body><main>  The lunar teapot keeps every word.  </main></body></html>\r\n';
        await Promise.all([
            writeText(root, 'pages/index.html', prefix + suffix),
            ...[...runtimeFiles].map(function writeRuntime([relative, content]) {
                return writeText(root, `arcane/${relative}`, content);
            })
        ]);
        const options = {documentRoot:root, documents:['pages/index.html']};
        const result = await generateDocumentImportMaps(options);
        const output = await readFile(path.join(root, 'pages/index.html'), 'utf8');
        const map = managedMap(output);
        assert.equal(map.imports['arcane-os/websocket-client'], '../arcane/sdk/websocket-client.mjs');
        assert.equal(map.imports['ws-share'], '../arcane/sdk/dependencies/ws-share/WS.js');
        assert.equal(map.imports['strong-type'], '../arcane/dependencies/strong-type/index.js');
        assert.deepEqual(map.scopes, {
            '../arcane/sdk/dependencies/event-pubsub/': {
                'strong-type':'../arcane/sdk/dependencies/event-pubsub/dependencies/strong-type/index.js'
            }
        });
        assert.deepEqual(result.documents[0].scopes, map.scopes);
        assert.equal(output.replace(/<script type="importmap" data-arcane-import-map>[\s\S]*?<\/script>/u, ''),
            prefix + suffix);
        await generateDocumentImportMaps(options);
        assert.equal(await readFile(path.join(root, 'pages/index.html'), 'utf8'), output);
    }
);

test('managed loader selects the longest dependency scope and retains parent and global fallbacks',
    async function loaderDependencyScopes(context) {
        const root = await fixtureRoot(context);
        await Promise.all([...runtimeFiles].map(function writeRuntime([relative, content]) {
            return writeText(root, `arcane/${relative}`, content);
        }));
        const globalType = './arcane/dependencies/strong-type/index.js';
        const nestedType = './arcane/sdk/dependencies/event-pubsub/dependencies/strong-type/index.js';
        const events = './arcane/sdk/dependencies/event-pubsub/index.js';
        const managedImportMap = await createApplicationTestImportMapContext({
            applicationRoot:root,
            imports:{'strong-type':globalType, 'global-events':events},
            scopes:{
                './arcane/sdk/dependencies/event-pubsub/':{
                    'strong-type':nestedType,
                    'scoped-events':events,
                    './arcane/sdk/dependencies/event-pubsub/marker.js':events
                },
                './arcane/sdk/dependencies/event-pubsub/probes/':{
                    'strong-type':globalType
                }
            }
        });
        function fileUrl(relative) {
            return new URL(relative, managedImportMap.baseURL).href;
        }
        const fallbacks = [];
        function nextResolve(specifier, resolutionContext) {
            fallbacks.push({specifier, parentURL:resolutionContext.parentURL});
            return {url:`fallback:${specifier}`};
        }
        function selected(specifier, parent) {
            return resolve(specifier, {parentURL:fileUrl(parent)}, nextResolve);
        }
        initialize({managedImportMap});
        try {
            assert.deepEqual(selected('strong-type', events), {url:fileUrl(nestedType), shortCircuit:true});
            assert.deepEqual(selected('strong-type', './arcane/modules/App.js'),
                {url:fileUrl(globalType), shortCircuit:true});
            assert.deepEqual(selected('strong-type', './arcane/sdk/dependencies/event-pubsub/probes/inspect.js'),
                {url:fileUrl(globalType), shortCircuit:true});
            assert.deepEqual(selected('scoped-events', './arcane/sdk/dependencies/event-pubsub/probes/inspect.js'),
                {url:fileUrl(events), shortCircuit:true});
            assert.deepEqual(selected('global-events', events), {url:fileUrl(events), shortCircuit:true});
            assert.deepEqual(selected('./marker.js', events), {url:fileUrl(events), shortCircuit:true});
            assert.deepEqual(fallbacks, []);
            initialize({managedImportMap:null});
            assert.deepEqual(selected('strong-type', events), {url:'fallback:strong-type'});
            assert.deepEqual(fallbacks, [{specifier:'strong-type', parentURL:fileUrl(events)}]);
        } finally {
            initialize({managedImportMap:null});
        }
    }
);

for (const dependencyName of ['arcane-os', 'arcane-sdk']) {
    for (const direct of [false, true]) {
        test(`installed ${dependencyName} ${direct ? 'direct' : 'virtual'} maps retain dependency scopes`,
            async function installedDependencyScopes(context) {
                const root = await fixtureRoot(context);
                const packageSource = `node_modules/${dependencyName}`;
                const packageRoot = path.join(root, ...packageSource.split('/'));
                const routes = installedSdkRoutes(packageSource, {direct});
                const writes = [
                    writeJson(root, 'arcane-packager.json', {
                        schemaVersion:1,
                        appsRoot:'.',
                        distRoot:'dist',
                        sharedPayloads:{'browser-runtime':routes}
                    }),
                    writeJson(packageRoot, 'package.json', {name:'arcane-os', version:'9.8.7', type:'module'}),
                    writeText(root, 'index.html', '<!doctype html><html><head><base href="./">'
                        + '</head><body><main>Orbit control</main></body></html>\n')
                ];
                for (const directory of routes[0].include) {
                    writes.push(mkdir(path.join(packageRoot, 'runtime/arcane', directory), {recursive:true}));
                }
                for (const [relative, content] of runtimeFiles) {
                    const selected = relative.startsWith('sdk/')
                        ? `browser-runtime/${relative.slice('sdk/'.length)}`
                        : relative.startsWith('dependencies/strong-type/')
                            ? `runtime/strong-type/${relative.slice('dependencies/strong-type/'.length)}`
                            : `runtime/arcane/${relative}`;
                    writes.push(writeText(packageRoot, selected, content));
                }
                await Promise.all(writes);
                const result = await generateImportMap({workspaceRoot:root, appRoot:root});
                const browserRoot = direct ? `./${packageSource}/browser-runtime` : './arcane/sdk';
                const typeRoot = direct ? `./${packageSource}/runtime/strong-type` : './arcane/dependencies/strong-type';
                const expectedScopes = {
                    [`${browserRoot}/dependencies/event-pubsub/`]: {
                        'strong-type':`${browserRoot}/dependencies/event-pubsub/dependencies/strong-type/index.js`
                    }
                };
                assert.equal(routes.length, 4);
                assert.equal(result.imports['arcane-os/websocket-client'], `${browserRoot}/websocket-client.mjs`);
                assert.equal(result.imports['ws-share'], `${browserRoot}/dependencies/ws-share/WS.js`);
                assert.equal(result.imports['event-pubsub'], `${browserRoot}/dependencies/event-pubsub/index.js`);
                assert.equal(result.imports['strong-type'], `${typeRoot}/index.js`);
                assert.deepEqual(result.scopes, expectedScopes);
                const artifact = JSON.parse(await readFile(result.artifactPath, 'utf8'));
                assert.deepEqual(artifact.scopes, expectedScopes);
                assert.deepEqual(managedMap(await readFile(path.join(root, 'index.html'), 'utf8')), artifact);
                const testMap = await readApplicationTestImportMapContext({workspaceRoot:root, applicationRoot:root});
                assert.equal(testMap.baseURL, pathToFileURL(`${root}${path.sep}`).href);
                assert.equal(testMap.imports['arcane-os/websocket-client'], `./${packageSource}/browser-runtime/websocket-client.mjs`);
                assert.equal(testMap.imports['strong-type'], `./${packageSource}/runtime/strong-type/index.js`);
                assert.deepEqual(testMap.scopes, {
                    [`./${packageSource}/browser-runtime/dependencies/event-pubsub/`]: {
                        'strong-type':`./${packageSource}/browser-runtime/dependencies/event-pubsub/dependencies/strong-type/index.js`
                    }
                });
            }
        );
    }
}

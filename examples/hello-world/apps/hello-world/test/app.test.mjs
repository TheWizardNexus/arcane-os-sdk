import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'arcane-os/testing';

const appRoot=new URL('../',import.meta.url);

test('application shell uses the shared Arcane theme in order',async function verifyThemeOrder(){
    const source=await readFile(new URL('index.html',appRoot),'utf8');
    const theme=source.indexOf('./arcane/css/theme.css');
    const primitives=source.indexOf('./arcane/css/primitives.css');
    const appStyle=source.indexOf('./apps/hello-world/hello-world.css');
    const bootstrap=source.indexOf('./arcane/modules/ThemeBootstrap.js');
    const appModule=source.indexOf('./apps/hello-world/modules/App.js');

    assert.match(source,/<base href="\.\.\/\.\.\/">/u);
    assert.match(source,/<meta name="arcane-app-id" content="hello-world">/u);
    assert.ok(theme>=0&&primitives>theme&&appStyle>primitives);
    assert.ok(bootstrap>appStyle&&appModule>bootstrap);
});

test('application package identity matches its directory',async function verifyPackageIdentity(){
    const manifest=JSON.parse(await readFile(new URL('arcane-package.json',appRoot),'utf8'));
    assert.equal(manifest.id,'hello-world');
    assert.equal(manifest.strategy,'static');
    assert.deepEqual(manifest.shared,['browser-runtime']);
});

test('application exposes the greeting interaction',async function verifyGreetingInteraction(){
    const [html,script]=await Promise.all([
        readFile(new URL('index.html',appRoot),'utf8'),
        readFile(new URL('modules/App.js',appRoot),'utf8')
    ]);
    assert.match(html,/Hello, Arcane World!/u);
    assert.match(html,/>Say hello<\/button>/u);
    assert.match(script,/function sayHello\(\)/u);
    assert.match(script,/Hello from Arcane OS!/u);
});


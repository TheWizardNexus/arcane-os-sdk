import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from '../src/testing.mjs';
import {createPackagedWebService} from '../src/core/services/packaged-web.mjs';

const fixtureDirectory = fileURLToPath(new URL('../.arcane/core-packaged-web-fixtures/', import.meta.url));

async function createFixture(t) {
    await mkdir(fixtureDirectory, {recursive: true});
    const root = await mkdtemp(path.join(fixtureDirectory, 'case-'));
    t.after(async function removeOwnedFixture() {
        const relative = path.relative(fixtureDirectory, root);
        assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
        await rm(root, {recursive: true, force: true});
    });
    return root;
}

test('packaged Core serving preserves complete content and one saved origin across launches', async function packagedOrigin(t) {
    const artifactRoot = await createFixture(t);
    const appRoot = path.join(artifactRoot, 'app');
    const stateRoot = path.join(artifactRoot, 'state');
    await mkdir(path.join(appRoot, 'pages'), {recursive: true});
    const content = '<!doctype html><p>  The moon library stays at its saved origin.  </p>\n';
    const start = './pages/library.html?view=complete#shelf';
    await Promise.all([
        writeFile(path.join(artifactRoot, 'arcane-native.json'), JSON.stringify({webRoot: 'app', start})),
        writeFile(path.join(appRoot, 'pages', 'library.html'), content)
    ]);
    const events = [];
    const context = {emit: function collect(event, data) {events.push({event, data});}};
    const service = createPackagedWebService({artifactRoot}, {stateRoot});
    t.after(async function closeServing() {await service.drain();});
    await service.start(context);
    const ready = events.find(function isReady(event) {return event.event === 'core.web.ready';}).data;
    assert.equal(ready.url, `${ready.origin}/pages/library.html?view=complete#shelf`);
    assert.equal(await (await fetch(ready.url)).text(), content);
    const saved = await readFile(path.join(stateRoot, 'packaged-web-origin.json'), 'utf8');
    assert.deepEqual(JSON.parse(saved), {host: '127.0.0.1', port: ready.port});
    const conflicting = createPackagedWebService({artifactRoot}, {stateRoot});
    await assert.rejects(conflicting.start(context), {code: 'EADDRINUSE'});
    await conflicting.drain();
    assert.equal(await readFile(path.join(stateRoot, 'packaged-web-origin.json'), 'utf8'), saved);
    assert.equal(await (await fetch(ready.url)).text(), content);
    await service.drain();
    const reopened = createPackagedWebService({artifactRoot}, {stateRoot});
    t.after(async function closeReopened() {await reopened.drain();});
    await reopened.start(context);
    assert.deepEqual(events.at(-1), {event: 'core.web.ready', data: ready});
    assert.equal(await readFile(path.join(stateRoot, 'packaged-web-origin.json'), 'utf8'), saved);
    await reopened.drain();
    assert.equal(events.some(function failed(event) {return event.event === 'core.web.failed';}), false);
});

test('unreadable saved origin is reported without replacing it or starting another origin', async function unreadableOrigin(t) {
    const artifactRoot = await createFixture(t);
    const stateRoot = path.join(artifactRoot, 'state');
    await mkdir(stateRoot);
    const saved = 'complete invalid saved origin content\n';
    await Promise.all([
        writeFile(path.join(artifactRoot, 'arcane-native.json'), JSON.stringify({webRoot: 'app', start: './index.html'})),
        writeFile(path.join(stateRoot, 'packaged-web-origin.json'), saved)
    ]);
    const service = createPackagedWebService({artifactRoot}, {stateRoot});
    await assert.rejects(service.start({emit() {assert.fail('No ready event before a listener exists.');}}), SyntaxError);
    await service.drain();
    assert.equal(await readFile(path.join(stateRoot, 'packaged-web-origin.json'), 'utf8'), saved);
});

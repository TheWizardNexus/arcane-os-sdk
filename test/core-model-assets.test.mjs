import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {mkdir, mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from '../src/testing.mjs';
import {createModelAssetService} from '../src/core/services/model-assets.mjs';

function deferred() {
    let resolve;
    const promise = new Promise(function retainSettlement(resolvePromise) { resolve = resolvePromise; });
    return {promise, resolve};
}

async function fixture(t, selectedFetch, beforeClose) {
    const fixtureParent = fileURLToPath(new URL('../.arcane/', import.meta.url));
    await mkdir(fixtureParent, {recursive: true});
    const root = await mkdtemp(path.join(fixtureParent, 'native-model-assets-'));
    const originalFetch = globalThis.fetch;
    const service = createModelAssetService({appRoot: root});
    globalThis.fetch = selectedFetch;
    t.after(async function closeFixture() {
        try {
            await beforeClose?.();
            await service.dispose();
        } finally {
            globalThis.fetch = originalFetch;
            await rm(root, {recursive: true, force: true});
        }
    });
    return {root, service};
}

test('native preparation streams all members concurrently and retains complete originals until release', async function completeMembers(t) {
    const secondStarted = deferred();
    const contents = [Buffer.from([0, 255, 13, 10, 0]), Buffer.from('  Complete tokenizer content.\r\n月 🧀  ')];
    const urls = ['https://models.invalid/model', 'https://models.invalid/tokenizer'];
    const calls = [];
    let use;
    const {service} = await fixture(t, async function fetchMember(url) {
        calls.push(url);
        const memberIndex = urls.indexOf(url);
        if (memberIndex === 0) await secondStarted.promise;
        else secondStarted.resolve();
        return new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(contents[memberIndex]);
                controller.close();
            }
        }));
    }, async function releaseFixtureGate() {
        secondStarted.resolve();
        await use?.release();
    });
    const progress = [];
    const projection = await service.prepare({
        id: 'moon-model', workingDirectory: 'selected-working-files',
        members: [{path: 'onnx/model.onnx', url: urls[0]}, {path: 'tokenizer.json', url: urls[1]}],
        onProgress(event) { progress.push(event); }
    });
    assert.deepEqual(calls, urls);
    assert.equal(projection.state, 'ready');
    assert.deepEqual(projection.members.map(function memberPath(member) { return member.path; }), ['onnx/model.onnx', 'tokenizer.json']);
    for (const [index, member] of projection.members.entries()) assert.deepEqual(await readFile(member.nativePath), contents[index]);
    assert.deepEqual(progress.at(-1), {phase: 'ready', completed: 2, total: 2, unit: 'files'});
    use = service.retain(projection.id);
    await service.release(projection.id);
    assert.equal(service.current().projections[0].preparationOwned, false);
    for (const [index, member] of use.members.entries()) assert.deepEqual(await readFile(member.nativePath), contents[index]);
    await use.release();
    assert.deepEqual(service.current().projections, []);
    await assert.rejects(readdir(projection.directory), {code: 'ENOENT'});
    assert.deepEqual(await service.release(projection.id), {id: projection.id, state: 'released'});
});

test('native preparation preserves the complete HTTP failure and removes only its working projection', async function failedDownload(t) {
    const body = '  Complete upstream failure.\r\nKeep this final line. 🦑  ';
    const {root, service} = await fixture(t, async function rejectedDownload() {
        return new Response(body, {status: 503, statusText: 'Selected model unavailable'});
    });
    await assert.rejects(service.prepare({
        id: 'failed-model', workingDirectory: 'selected-working-files',
        members: [{path: 'onnx/model.onnx', url: 'https://models.invalid/unavailable'}]
    }), function completeDownloadFailure(error) {
        assert.equal(error.code, 'MODEL_ASSET_DOWNLOAD_FAILED');
        assert.equal(error.status, 503);
        assert.equal(error.url, 'https://models.invalid/unavailable');
        assert.equal(error.response, body);
        return true;
    });
    assert.deepEqual(service.current().projections, []);
    assert.deepEqual(await readdir(path.join(root, 'selected-working-files')), []);
});

test('native preparation cancellation joins its response stream before cleanup', async function cancelledDownload(t) {
    const entered = deferred();
    const cancellation = new AbortController();
    const reason = new Error('  Complete caller cancellation.\n月  ');
    const {root, service} = await fixture(t, async function pendingResponse(url, {signal}) {
        return new Response(new ReadableStream({
            start(controller) {
                signal.addEventListener('abort', function abortBody() { controller.error(signal.reason); }, {once: true});
                entered.resolve();
            }
        }));
    }, function cancelFixture() { cancellation.abort(reason); });
    const preparation = service.prepare({
        id: 'cancelled-model', workingDirectory: 'selected-working-files',
        members: [{path: 'model.onnx', url: 'https://models.invalid/pending'}], signal: cancellation.signal
    });
    const rejected = assert.rejects(preparation, function originalCancellation(error) { return error === reason; });
    await entered.promise;
    cancellation.abort(reason);
    await rejected;
    assert.deepEqual(service.current().projections, []);
    assert.deepEqual(await readdir(path.join(root, 'selected-working-files')), []);
});

test('release during opening prevents native transfers from starting', async function releaseBeforeDownload(t) {
    const calls = [];
    const {root, service} = await fixture(t, async function unusedFetch(url) {
        calls.push(url);
        return new Response('Complete synthetic model.');
    });
    let released;
    let releaseRequested = false;
    service.start({
        emit(event, record) {
            if (!releaseRequested && record.state === 'preparing') {
                releaseRequested = true;
                released = service.release(record.id);
            }
        }
    });
    await assert.rejects(service.prepare({
        id: 'released-while-opening', workingDirectory: 'selected-working-files',
        members: [{path: 'model.onnx', url: 'https://models.invalid/unstarted'}]
    }), {code: 'MODEL_ASSET_PROJECTION_RELEASED'});
    await released;
    assert.deepEqual(calls, []);
    assert.deepEqual(service.current().projections, []);
    assert.deepEqual(await readdir(path.join(root, 'selected-working-files')), []);
});

test('native disposal and explicit release join an unfinished download before deleting files', async function joinedNativeCleanup(t) {
    for (const operation of ['dispose', 'release']) {
        await t.test(operation, async function joinedCleanup(child) {
            const entered = deferred();
            const aborted = deferred();
            const finish = deferred();
            const {service} = await fixture(child, function delayedFetch(url, {signal}) {
                entered.resolve();
                return new Promise(function holdDownload(resolve, reject) {
                    signal.addEventListener('abort', function requestedAbort() {
                        aborted.resolve();
                        finish.promise.then(function finishDownload() { reject(signal.reason); });
                    }, {once: true});
                });
            }, function finishFixtureDownload() { finish.resolve(); });
            const preparation = service.prepare({
                id: 'closing-model', workingDirectory: 'selected-working-files',
                members: [{path: 'model.onnx', url: 'https://models.invalid/closing'}]
            });
            const rejected = assert.rejects(preparation, {code: 'MODEL_ASSET_PROJECTION_RELEASED'});
            await entered.promise;
            const projection = service.current().projections[0];
            let settled = false;
            const cleanup = operation === 'dispose' ? service.dispose() : service.release(projection.id);
            const observed = cleanup.then(function cleanupSettled() { settled = true; });
            await aborted.promise;
            assert.equal(settled, false);
            assert.deepEqual(await readdir(projection.directory), ['model.onnx']);
            finish.resolve();
            await rejected;
            await observed;
            await assert.rejects(readdir(projection.directory), {code: 'ENOENT'});
        });
    }
});

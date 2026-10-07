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
    const services = new Set();

    function createService() {
        const selectedService = createModelAssetService({appRoot: root});
        services.add(selectedService);
        return selectedService;
    }

    const service = createService();
    globalThis.fetch = selectedFetch;
    t.after(async function closeFixture() {
        try {
            await beforeClose?.();
            const results = await Promise.allSettled([...services].map(function disposeService(selectedService) { return selectedService.dispose(); }));
            const errors = results.filter(function rejected(result) { return result.status === 'rejected'; })
                .map(function reason(result) { return result.reason; });
            if (errors.length) throw new AggregateError(errors, 'Disposing model asset fixture services failed.');
        } finally {
            globalThis.fetch = originalFetch;
            await rm(root, {recursive: true, force: true});
        }
    });
    return {root, service, createService};
}

async function acquisitions(root, workingDirectory = 'selected-working-files') {
    try { return await readdir(path.join(root, workingDirectory, 'model-assets')); }
    catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

test('native preparation streams all members concurrently and preserves complete originals after release', async function completeMembers(t) {
    const secondStarted = deferred();
    const contents = [Buffer.from([0, 255, 13, 10, 0]), Buffer.from('  Complete tokenizer content.\r\n月 🧀  ')];
    const urls = ['https://models.invalid/model', 'https://models.invalid/tokenizer'];
    const calls = [];
    let use;
    const {root, service} = await fixture(t, async function fetchMember(url) {
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
    assert.deepEqual([...calls].sort(), [...urls].sort());
    assert.equal(projection.state, 'ready');
    assert.equal(path.dirname(path.dirname(projection.directory)), path.join(root, 'selected-working-files', 'model-assets'));
    assert.deepEqual(projection.members.map(function memberPath(member) { return member.path; }), ['onnx/model.onnx', 'tokenizer.json']);
    for (const [index, member] of projection.members.entries()) assert.deepEqual(await readFile(member.nativePath), contents[index]);
    assert.deepEqual(progress.at(-1), {phase: 'ready', completed: 2, total: 2, unit: 'files'});
    use = service.retain(projection.id);
    await service.release(projection.id);
    assert.equal(service.current().projections[0].preparationOwned, false);
    for (const [index, member] of use.members.entries()) assert.deepEqual(await readFile(member.nativePath), contents[index]);
    await use.release();
    assert.deepEqual(service.current().projections, []);
    for (const [index, member] of projection.members.entries()) assert.deepEqual(await readFile(member.nativePath), contents[index]);
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
    assert.deepEqual(await acquisitions(root), []);
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
    assert.deepEqual(await acquisitions(root), []);
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
    assert.deepEqual(await acquisitions(root), []);
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

test('completed native acquisitions survive service restart and ignore new operation ids', async function restartReuse(t) {
    const members = [
        {path: 'onnx/model.onnx', url: 'https://models.invalid/moon/revision/onnx/model.onnx'},
        {path: 'onnx/model.onnx_data', url: 'https://models.invalid/moon/revision/onnx/model.onnx_data'},
        {path: 'tokenizer.json', url: 'https://models.invalid/moon/revision/tokenizer.json'},
        {path: 'tokenizer_config.json', url: 'https://models.invalid/moon/revision/tokenizer_config.json'}
    ];
    const selectedMembers = members.map(function selectedMember(member) { return {...member}; });
    const calls = [];
    const {service, createService} = await fixture(t, async function fetchOriginal(url) {
        calls.push(url);
        return new Response(`  Complete original for ${url}.\r\n月 🧀  `);
    });
    const first = await service.prepare({id: 'first-operation', workingDirectory: 'selected-working-files', members});
    await service.release(first.id);
    await service.dispose();

    const restarted = createService();
    const second = await restarted.prepare({id: 'restarted-operation', workingDirectory: 'selected-working-files', members});
    assert.deepEqual([...calls].sort(), members.map(function selectedUrl(member) { return member.url; }).sort());
    assert.equal(second.id, 'restarted-operation');
    assert.equal(second.directory, first.directory);
    assert.deepEqual(second.members, first.members);
    assert.deepEqual(members, selectedMembers);
    for (const [index, member] of second.members.entries()) {
        assert.equal(await readFile(member.nativePath, 'utf8'), `  Complete original for ${members[index].url}.\r\n月 🧀  `);
    }
});

test('explicit native refresh reacquires the same selected source without overwriting retained originals', async function refreshSelection(t) {
    const members = [{path: 'onnx/model.onnx', url: 'https://models.invalid/moon/main/onnx/model.onnx'}];
    const calls = [];
    let use;
    const {service, createService} = await fixture(t, async function fetchRevision(url) {
        calls.push(url);
        return new Response(calls.length === 1 ? 'Complete first source.' : 'Complete refreshed source.');
    }, async function releaseOriginalUse() { await use?.release(); });
    const first = await service.prepare({id: 'original', workingDirectory: 'selected-working-files', members});
    use = service.retain(first.id);
    await service.release(first.id);

    const refreshed = await service.prepare({
        id: 'explicit-refresh', workingDirectory: 'selected-working-files', members, refresh: true
    });
    assert.deepEqual(calls, [members[0].url, members[0].url]);
    assert.notEqual(refreshed.directory, first.directory);
    assert.equal(await readFile(first.members[0].nativePath, 'utf8'), 'Complete first source.');
    assert.equal(await readFile(refreshed.members[0].nativePath, 'utf8'), 'Complete refreshed source.');
    await service.release(refreshed.id);
    await use.release();
    await service.dispose();
    assert.equal(await readFile(first.members[0].nativePath, 'utf8'), 'Complete first source.');
    assert.equal(await readFile(refreshed.members[0].nativePath, 'utf8'), 'Complete refreshed source.');
    const restarted = createService();
    const reused = await restarted.prepare({id: 'reused-refresh', workingDirectory: 'selected-working-files', members});
    assert.equal(reused.directory, refreshed.directory);
    assert.deepEqual(calls, [members[0].url, members[0].url]);
});

test('native acquisition identity preserves the complete ordered paths, urls and selected store', async function exactSelection(t) {
    const graph = {path: 'onnx/model.onnx', url: 'https://models.invalid/moon/main/onnx/model.onnx'};
    const tokenizer = {path: 'tokenizer.json', url: 'https://models.invalid/moon/main/tokenizer.json'};
    const selections = [
        {workingDirectory: 'selected-working-files', members: [graph, tokenizer]},
        {workingDirectory: 'selected-working-files', members: [{...graph, url: 'https://models.invalid/moon/next/onnx/model.onnx'}, tokenizer]},
        {workingDirectory: 'selected-working-files', members: [{...graph, path: 'onnx/model-selected.onnx'}, tokenizer]},
        {workingDirectory: 'selected-working-files', members: [tokenizer, graph]},
        {workingDirectory: 'another-working-directory', members: [graph, tokenizer]}
    ];
    const calls = [];
    const directories = new Set();
    const {service} = await fixture(t, async function fetchSelection(url) {
        calls.push(url);
        return new Response(`Complete selected source ${url}.`);
    });
    for (const [index, selection] of selections.entries()) {
        const projection = await service.prepare({id: `selection-${index}`, ...selection});
        assert.equal(directories.has(projection.directory), false);
        directories.add(projection.directory);
        assert.deepEqual(projection.members.map(function originalPath(member) { return member.path; }),
            selection.members.map(function selectedPath(member) { return member.path; }));
        for (const [memberIndex, member] of projection.members.entries()) {
            assert.equal(await readFile(member.nativePath, 'utf8'), `Complete selected source ${selection.members[memberIndex].url}.`);
        }
        await service.release(projection.id);
    }
    assert.deepEqual([...calls].sort(), selections.flatMap(function selectedUrls(selection) {
        return selection.members.map(function selectedUrl(member) { return member.url; });
    }).sort());
});

test('a missing original member requires a new complete native acquisition', async function missingOriginal(t) {
    const members = [
        {path: 'onnx/model.onnx', url: 'https://models.invalid/moon/model.onnx'},
        {path: 'onnx/model.onnx_data', url: 'https://models.invalid/moon/model.onnx_data'}
    ];
    const calls = [];
    const {service, createService} = await fixture(t, async function fetchMember(url) {
        calls.push(url);
        return new Response(`Complete selected original ${url}.`);
    });
    const first = await service.prepare({id: 'before-member-loss', workingDirectory: 'selected-working-files', members});
    await service.release(first.id);
    await service.dispose();
    await rm(first.members[1].nativePath);

    const restarted = createService();
    const second = await restarted.prepare({id: 'after-member-loss', workingDirectory: 'selected-working-files', members});
    assert.notEqual(second.directory, first.directory);
    assert.deepEqual([...calls].sort(), [...members, ...members].map(function selectedUrl(member) { return member.url; }).sort());
    assert.equal(await readFile(first.members[0].nativePath, 'utf8'), `Complete selected original ${members[0].url}.`);
    for (const [index, member] of second.members.entries()) {
        assert.equal(await readFile(member.nativePath, 'utf8'), `Complete selected original ${members[index].url}.`);
    }
});

test('an interrupted native acquisition retries every member instead of resuming partial originals', async function incompleteAcquisition(t) {
    const firstDownloaded = deferred();
    const members = [
        {path: 'model.onnx', url: 'https://models.invalid/moon/model.onnx'},
        {path: 'tokenizer.json', url: 'https://models.invalid/moon/tokenizer.json'}
    ];
    const calls = [];
    let failTokenizer = true;
    const {root, service} = await fixture(t, async function selectedResponse(url) {
        calls.push(url);
        if (url === members[1].url && failTokenizer) {
            await firstDownloaded.promise;
            return new Response('Complete unavailable-tokenizer response.', {status: 503});
        }
        return new Response(`Complete original ${url}.`);
    }, function releaseFixtureGate() { firstDownloaded.resolve(); });
    await assert.rejects(service.prepare({
        id: 'interrupted', workingDirectory: 'selected-working-files', members,
        onProgress(event) {
            if (event.memberIndex === 0 && event.completed === 1) firstDownloaded.resolve();
        }
    }), {code: 'MODEL_ASSET_DOWNLOAD_FAILED'});
    assert.deepEqual(await acquisitions(root), []);

    failTokenizer = false;
    const completed = await service.prepare({id: 'retry-complete-set', workingDirectory: 'selected-working-files', members});
    assert.deepEqual([...calls].sort(), [...members, ...members].map(function selectedUrl(member) { return member.url; }).sort());
    for (const [index, member] of completed.members.entries()) {
        assert.equal(await readFile(member.nativePath, 'utf8'), `Complete original ${members[index].url}.`);
    }
});

test('matching service instances share acquisition while one cancelled subscriber detaches', async function sharedCancellation(t) {
    const entered = deferred();
    const joined = deferred();
    const finish = deferred();
    const cancellation = new AbortController();
    const reason = new Error('Complete cancellation for the first caller.\n月');
    const members = [{path: 'model.onnx', url: 'https://models.invalid/moon/shared-model'}];
    const calls = [];
    let transferSignal;
    let first;
    let second;
    const {service, createService} = await fixture(t, async function sharedResponse(url, {signal}) {
        calls.push(url);
        transferSignal = signal;
        entered.resolve();
        await finish.promise;
        signal.throwIfAborted();
        return new Response('Complete shared original.');
    }, async function releaseFixtureGate() {
        cancellation.abort(reason);
        finish.resolve();
        await Promise.allSettled([first, second]);
    });
    first = service.prepare({
        id: 'cancelled-subscriber', workingDirectory: 'selected-working-files', members, signal: cancellation.signal
    });
    const rejected = assert.rejects(first, function originalReason(error) { return error === reason; });
    await entered.promise;
    const other = createService();
    second = other.prepare({
        id: 'remaining-subscriber', workingDirectory: 'selected-working-files', members,
        onProgress() { joined.resolve(); }
    });
    await joined.promise;
    cancellation.abort(reason);
    await rejected;
    assert.equal(transferSignal.aborted, false);
    assert.deepEqual(service.current().projections, []);

    finish.resolve();
    const ready = await second;
    assert.equal(ready.id, 'remaining-subscriber');
    assert.deepEqual(calls, [members[0].url]);
    assert.equal(await readFile(ready.members[0].nativePath, 'utf8'), 'Complete shared original.');
});

test('a shared progress observer failure rejects only its caller and preserves the remaining acquisition', async function sharedProgressFailure(t) {
    const entered = deferred();
    const joined = deferred();
    const finish = deferred();
    const reason = new Error('Complete observer failure.\nKeep the final line. 月');
    const members = [{path: 'model.onnx', url: 'https://models.invalid/moon/shared-progress'}];
    const calls = [];
    let failProgress = false;
    let first;
    let second;
    const {service, createService} = await fixture(t, async function sharedResponse(url, {signal}) {
        calls.push(url);
        entered.resolve();
        await finish.promise;
        signal.throwIfAborted();
        return new Response('Complete original after observer failure.');
    }, async function releaseFixtureGate() {
        finish.resolve();
        await Promise.allSettled([first, second]);
    });
    first = service.prepare({
        id: 'failing-observer', workingDirectory: 'selected-working-files', members,
        onProgress(event) {
            if (failProgress) throw reason;
            event.phase = 'first observer local presentation';
            event.completed = -7;
        }
    });
    const rejected = assert.rejects(first, function originalReason(error) { return error === reason; });
    await entered.promise;
    const other = createService();
    second = other.prepare({
        id: 'remaining-observer', workingDirectory: 'selected-working-files', members,
        onProgress(event) {
            assert.notEqual(event.phase, 'first observer local presentation');
            assert.notEqual(event.completed, -7);
            joined.resolve();
        }
    });
    await joined.promise;
    failProgress = true;
    finish.resolve();
    await rejected;
    const ready = await second;
    assert.deepEqual(service.current().projections, []);
    assert.deepEqual(calls, [members[0].url]);
    assert.equal(await readFile(ready.members[0].nativePath, 'utf8'), 'Complete original after observer failure.');
});

test('cancelling the final shared subscriber joins the aborted acquisition before removing its attempt', async function finalSharedCancellation(t) {
    const entered = deferred();
    const joined = deferred();
    const aborted = deferred();
    const finish = deferred();
    const firstCancellation = new AbortController();
    const secondCancellation = new AbortController();
    const firstReason = new Error('First shared caller cancelled.');
    const secondReason = new Error('Final shared caller cancelled.');
    const members = [{path: 'model.onnx', url: 'https://models.invalid/moon/shared-last-caller'}];
    let transferSignal;
    let first;
    let second;
    const {root, service, createService} = await fixture(t, function heldResponse(url, {signal}) {
        transferSignal = signal;
        entered.resolve();
        return new Promise(function holdDownload(resolve, reject) {
            signal.addEventListener('abort', function requestedAbort() {
                aborted.resolve();
                finish.promise.then(function finishDownload() { reject(signal.reason); });
            }, {once: true});
        });
    }, async function releaseFixtureGate() {
        firstCancellation.abort(firstReason);
        secondCancellation.abort(secondReason);
        finish.resolve();
        await Promise.allSettled([first, second]);
    });
    first = service.prepare({
        id: 'first-shared-cancellation', workingDirectory: 'selected-working-files', members, signal: firstCancellation.signal
    });
    const firstRejected = assert.rejects(first, function originalReason(error) { return error === firstReason; });
    await entered.promise;
    const other = createService();
    second = other.prepare({
        id: 'last-shared-cancellation', workingDirectory: 'selected-working-files', members, signal: secondCancellation.signal,
        onProgress() { joined.resolve(); }
    });
    let settled = false;
    const secondRejected = assert.rejects(second, function originalReason(error) { return error === secondReason; })
        .then(function callerSettled() { settled = true; });
    await joined.promise;
    firstCancellation.abort(firstReason);
    await firstRejected;
    assert.equal(transferSignal.aborted, false);
    const pending = other.current().projections[0];

    secondCancellation.abort(secondReason);
    await aborted.promise;
    assert.equal(settled, false);
    assert.deepEqual(await readdir(pending.directory), ['model.onnx']);
    finish.resolve();
    await secondRejected;
    assert.deepEqual(service.current().projections, []);
    assert.deepEqual(other.current().projections, []);
    assert.deepEqual(await acquisitions(root), []);
});

test('native disposal waits for retained engine ownership and preserves completed assets afterward', async function retainedDisposal(t) {
    let use;
    const {service} = await fixture(t, async function completedResponse() {
        return new Response('Complete retained original.');
    }, async function releaseRetainedUse() { await use?.release(); });
    const projection = await service.prepare({
        id: 'retained-during-disposal', workingDirectory: 'selected-working-files',
        members: [{path: 'model.onnx', url: 'https://models.invalid/moon/retained'}]
    });
    use = service.retain(projection.id);
    await service.release(projection.id);
    let settled = false;
    const disposal = service.dispose().then(function disposalSettled() { settled = true; });
    assert.equal(await readFile(projection.members[0].nativePath, 'utf8'), 'Complete retained original.');
    assert.equal(settled, false);
    assert.equal(service.current().closing, true);

    await use.release();
    await disposal;
    assert.deepEqual(service.current().projections, []);
    assert.equal(await readFile(projection.members[0].nativePath, 'utf8'), 'Complete retained original.');
});

test('browser open write and complete methods retain their temporary projection lifetime', async function temporaryBrowserProjection(t) {
    const contents = [Buffer.from('  Complete graph original.\r\n月  '), Buffer.from('  Complete tokenizer original. 🧀  ')];
    const calls = [];
    let use;
    const {root, service} = await fixture(t, async function unusedFetch(url) {
        calls.push(url);
        return new Response('This browser projection does not fetch.');
    }, async function releaseBrowserUse() { await use?.release(); });
    const request = {signal: new AbortController().signal};
    const projection = await service.methods['modelAssets.open']({
        id: 'browser-originals', workingDirectory: 'browser-working-files',
        members: [{path: 'onnx/model.onnx'}, {path: 'tokenizer.json'}]
    }, request);
    await Promise.all(contents.map(function writeOriginal(content, memberIndex) {
        return service.methods['modelAssets.write']({id: projection.id, memberIndex, contentBase64: content.toString('base64')}, request);
    }));
    const ready = await service.methods['modelAssets.complete']({id: projection.id}, request);
    assert.equal(ready.state, 'ready');
    assert.deepEqual(calls, []);
    for (const [index, member] of ready.members.entries()) assert.deepEqual(await readFile(member.nativePath), contents[index]);
    use = service.retain(ready.id);
    await service.methods['modelAssets.release'].handle({id: ready.id});
    for (const [index, member] of ready.members.entries()) assert.deepEqual(await readFile(member.nativePath), contents[index]);
    await use.release();
    assert.deepEqual(service.current().projections, []);
    await assert.rejects(readdir(ready.directory), {code: 'ENOENT'});
    assert.deepEqual(await readdir(path.join(root, 'browser-working-files')), []);
});

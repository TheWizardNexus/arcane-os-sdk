import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from '../src/testing.mjs';
import {publishNativeOutput} from '../src/native/publish-output.mjs';
import {ERROR_CODES} from '../src/errors.mjs';

const fixtureDirectory = fileURLToPath(new URL('../.arcane/native-publication-fixtures/', import.meta.url));
const appId = 'moon-cheese-post';

async function fixture(t) {
    await mkdir(fixtureDirectory, {recursive: true});
    const root = await mkdtemp(path.join(fixtureDirectory, 'case-'));
    t.after(async function removeOwnedFixture() {
        const relative = path.relative(fixtureDirectory, root);
        assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
        await rm(root, {recursive: true, force: true});
    });
    return root;
}

async function stage(root, text, selectedAppId = appId) {
    const sourceRoot = await mkdtemp(path.join(root, 'assembly-'));
    await writeFile(path.join(sourceRoot, 'arcane-native.json'), JSON.stringify({kind: 'arcane-portable-native', app: {id: selectedAppId}}));
    await writeFile(path.join(sourceRoot, 'complete.txt'), text);
    return sourceRoot;
}

test('native publication replaces one app and preserves unrelated outputs and persistent resources', async function stableOutput(t) {
    const outputRoot = await fixture(t);
    for (const name of ['.arcane-native-hosts', 'local-ai-runtimes', 'saved-profile', 'old-random-output', 'another-app']) {
        await mkdir(path.join(outputRoot, name));
        await writeFile(path.join(outputRoot, name, 'keep.txt'), `Retain ${name}.\n`);
    }
    const first = await publishNativeOutput({sourceRoot: await stage(outputRoot, 'First complete app.\n'), outputRoot, appId});
    const secondSource = await stage(outputRoot, 'Second complete app.\n最後 🧀\n');
    assert.equal(await readFile(path.join(first, 'complete.txt'), 'utf8'), 'First complete app.\n');
    const second = await publishNativeOutput({sourceRoot: secondSource, outputRoot, appId,
        async onPublished(destination) {
            assert.equal(destination, first);
            assert.equal(await readFile(path.join(destination, 'complete.txt'), 'utf8'), 'Second complete app.\n最後 🧀\n');
        }
    });
    assert.equal(second, path.join(outputRoot, appId));
    assert.deepEqual((await readdir(outputRoot)).sort(), ['.arcane-native-hosts', 'local-ai-runtimes', 'saved-profile', 'old-random-output', 'another-app', appId].sort());
    for (const name of ['.arcane-native-hosts', 'local-ai-runtimes', 'saved-profile', 'old-random-output', 'another-app']) {
        assert.equal(await readFile(path.join(outputRoot, name, 'keep.txt'), 'utf8'), `Retain ${name}.\n`);
    }
});

test('native publication restores the old app after callback rejection or cancellation', async function rejectedCompletion(t) {
    const outputRoot = await fixture(t);
    const destination = await publishNativeOutput({sourceRoot: await stage(outputRoot, 'Previous app.\n'), outputRoot, appId});
    for (const disposition of ['reject', 'cancel']) {
        const sourceRoot = await stage(outputRoot, 'Unaccepted replacement.\n');
        const controller = new AbortController();
        const reason = new Error(`Complete ${disposition} explanation.\nFinal line 🦑`);
        await assert.rejects(publishNativeOutput({sourceRoot, outputRoot, appId, signal: controller.signal,
            onPublished() {
                if (disposition === 'reject') throw reason;
                controller.abort(reason);
            }
        }), function originalFailure(error) {
            if (disposition === 'reject') assert.equal(error, reason);
            else {
                assert.equal(error.code, ERROR_CODES.cancelled);
                assert.equal(error.cause, reason);
            }
            return true;
        });
        assert.equal(await readFile(path.join(destination, 'complete.txt'), 'utf8'), 'Previous app.\n');
        assert.equal(await readFile(path.join(sourceRoot, 'complete.txt'), 'utf8'), 'Unaccepted replacement.\n');
        await assert.rejects(readdir(path.join(outputRoot, `.arcane-publish-${appId}`)), {code: 'ENOENT'});
    }
});

test('a failed promotion restores the previous output before reporting the original error', async function failedPromotion(t) {
    const outputRoot = await fixture(t);
    const destination = await publishNativeOutput({sourceRoot: await stage(outputRoot, 'Previous app.\n'), outputRoot, appId});
    await assert.rejects(publishNativeOutput({sourceRoot: path.join(outputRoot, 'missing-assembly'), outputRoot, appId}), {code: 'ENOENT'});
    assert.equal(await readFile(path.join(destination, 'complete.txt'), 'utf8'), 'Previous app.\n');
    assert.deepEqual(await readdir(outputRoot), [appId]);
});

test('one final publication reservation prevents a competing build from replacing its output', async function competingPublication(t) {
    const outputRoot = await fixture(t);
    const firstSource = await stage(outputRoot, 'First accepted app.\n');
    const secondSource = await stage(outputRoot, 'Competing app.\n');
    let accept;
    let entered;
    const pending = new Promise(function acceptance(resolve) { accept = resolve; });
    const started = new Promise(function published(resolve) { entered = resolve; });
    const first = publishNativeOutput({sourceRoot: firstSource, outputRoot, appId,
        async onPublished() { entered(); await pending; }
    });
    try {
        await Promise.race([started, first]);
        await assert.rejects(publishNativeOutput({sourceRoot: secondSource, outputRoot, appId}), function reserved(error) {
            assert.equal(error.code, ERROR_CODES.operationFailed);
            assert.equal(error.details.reservation, path.join(outputRoot, `.arcane-publish-${appId}`));
            return true;
        });
        assert.equal(await readFile(path.join(secondSource, 'complete.txt'), 'utf8'), 'Competing app.\n');
    } finally { accept(); }
    const destination = await first;
    assert.equal(await readFile(path.join(destination, 'complete.txt'), 'utf8'), 'First accepted app.\n');
});

test('recovery failure retains the prior output and exposes every exact recovery location', async function retainedRecovery(t) {
    const outputRoot = await fixture(t);
    await publishNativeOutput({sourceRoot: await stage(outputRoot, 'Previous app.\n'), outputRoot, appId});
    const sourceRoot = await stage(outputRoot, 'Complete unaccepted app.\n');
    const reason = new Error('Completion failed after another writer occupied the old staging path.');
    let reported;
    await assert.rejects(publishNativeOutput({sourceRoot, outputRoot, appId,
        async onPublished() {
            await mkdir(sourceRoot);
            await writeFile(path.join(sourceRoot, 'occupied.txt'), 'Preserve the conflicting output.\n');
            throw reason;
        }
    }), function completeRecoveryFailure(error) {
        reported = error;
        assert.equal(error.code, ERROR_CODES.operationFailed);
        assert.equal(error.cause.errors[0], reason);
        assert.equal(error.details.promoted, true);
        assert.equal(error.details.committed, false);
        return true;
    });
    assert.equal(await readFile(path.join(reported.details.backup, 'complete.txt'), 'utf8'), 'Previous app.\n');
    assert.equal(await readFile(path.join(reported.details.outputRoot, 'complete.txt'), 'utf8'), 'Complete unaccepted app.\n');
    const owner = JSON.parse(await readFile(path.join(reported.details.reservation, 'owner.json'), 'utf8'));
    assert.equal(owner.sourceRoot, sourceRoot);
    assert.equal(owner.pid, process.pid);
    assert.equal(Date.parse(owner.expiresAt) - Date.parse(owner.acquiredAt), owner.ttlMs);
    assert.match(owner.recovery, /Expiry is informational and never permits automatic takeover/);
});

test('an app-named directory without a matching generated artifact is preserved', async function unrelatedCollision(t) {
    const outputRoot = await fixture(t);
    const existing = path.join(outputRoot, appId);
    await mkdir(existing);
    await writeFile(path.join(existing, 'saved-model.gguf'), 'Existing user data.\n');
    const sourceRoot = await stage(outputRoot, 'Complete new app.\n');
    await assert.rejects(publishNativeOutput({sourceRoot, outputRoot, appId}), {code: 'ENOENT'});
    assert.equal(await readFile(path.join(existing, 'saved-model.gguf'), 'utf8'), 'Existing user data.\n');
    assert.equal(await readFile(path.join(sourceRoot, 'complete.txt'), 'utf8'), 'Complete new app.\n');
});

test('Windows device-name app IDs retain their identity in a portable output folder', async function reservedOutputName(t) {
    const outputRoot = await fixture(t);
    const sourceRoot = await stage(outputRoot, 'A complete app named con.\n', 'con');
    const destination = await publishNativeOutput({sourceRoot, outputRoot, appId: 'con'});
    assert.equal(destination, path.join(outputRoot, '_con'));
    const manifest = JSON.parse(await readFile(path.join(destination, 'arcane-native.json'), 'utf8'));
    assert.equal(manifest.app.id, 'con');
});

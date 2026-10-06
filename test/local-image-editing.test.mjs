import assert from 'node:assert/strict';
import {crc32, deflateSync} from 'node:zlib';
import test from '../src/testing.mjs';
import {decodeImage} from '../src/local-ai/image-editing.mjs';
import {createCoreImageRuntime} from '../browser-runtime/ai/core-image.mjs';

function chunk(type, data = Buffer.alloc(0)) {
    const name = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, crc]);
}

function png({width = 2, height = 1, color = 2, depth = 8, interlace = 0, rows, before = [], split = false}) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = depth;
    header[9] = color;
    header[12] = interlace;
    const compressed = deflateSync(Buffer.from(rows));
    const image = split
        ? [chunk('IDAT', compressed.subarray(0, 3)), chunk('IDAT', compressed.subarray(3))]
        : [chunk('IDAT', compressed)];
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header), ...before, ...image, chunk('IEND')
    ]);
}

test('PNG edit input reconstructs every filter across split image chunks', async function completeFilteredPixels() {
    const data = png({height: 5, split: true, rows: [
        0, 10, 20, 30, 40, 50, 60,
        1, 15, 25, 35, 30, 30, 30,
        2, 5, 5, 5, 5, 5, 5,
        3, 15, 20, 25, 18, 18, 18,
        4, 5, 5, 5, 5, 5, 5
    ]});
    const result = await decodeImage({data, mediaType: 'image/png'});
    assert.equal(result.width, 2);
    assert.equal(result.height, 5);
    assert.equal(result.channel, 3);
    assert.deepEqual(Array.from(result.data), [
        10, 20, 30, 40, 50, 60,
        15, 25, 35, 45, 55, 65,
        20, 30, 40, 50, 60, 70,
        25, 35, 45, 55, 65, 75,
        30, 40, 50, 60, 70, 80
    ]);
});

test('PNG edit input retains straight alpha and uses only the supplied view', async function completeRGBAView() {
    const source = png({color: 6, rows: [0, 250, 100, 20, 0, 5, 15, 25, 128]});
    const allocation = Buffer.concat([Buffer.from('prefix'), source, Buffer.from('suffix')]);
    const data = new Uint8Array(allocation.buffer, allocation.byteOffset + 6, source.length);
    const before = Array.from(data);
    const result = await decodeImage({data});
    assert.equal(result.channel, 4);
    assert.deepEqual(Array.from(result.data), [250, 100, 20, 0, 5, 15, 25, 128]);
    assert.deepEqual(Array.from(data), before);
    result.data[0] = 0;
    assert.deepEqual(Array.from(data), before);
});

test('PNG edit input supports RGB transparent colors and suggested palettes', async function transparentRGB() {
    for (const transparency of [[0, 10, 0, 20, 0, 30], [1, 10, 2, 20, 3, 30]]) {
        const data = png({
            rows: [0, 10, 20, 30, 40, 50, 60],
            before: [chunk('PLTE', Buffer.from([10, 20, 30])), chunk('tRNS', Buffer.from(transparency))]
        });
        const result = await decodeImage({data});
        assert.equal(result.channel, 4);
        assert.deepEqual(Array.from(result.data), [10, 20, 30, 0, 40, 50, 60, 255]);
    }
});

test('PNG edit input reports unsupported encodings instead of changing them', async function explicitEncodingAvailability() {
    const rows = [0, 10, 20, 30, 40, 50, 60];
    for (const options of [{color: 0}, {color: 3}, {color: 4}, {depth: 16}, {interlace: 1}, {before: [chunk('acTL', Buffer.alloc(8))]}]) {
        await assert.rejects(decodeImage({data: png({rows, ...options})}), {code: 'ARCANE_IMAGE_INPUT_UNSUPPORTED'});
    }
    await assert.rejects(decodeImage({data: png({rows}), mediaType: 'image/jpeg'}), {code: 'ARCANE_IMAGE_INPUT_UNSUPPORTED'});
});

test('PNG edit input reports incomplete rows and unknown filters without partial imagery', async function noPartialRaster() {
    for (const rows of [[0, 1, 2], [9, 10, 20, 30, 40, 50, 60], [0, 10, 20, 30, 40, 50, 60, 1]]) {
        await assert.rejects(decodeImage({data: png({rows})}), {code: 'ARCANE_IMAGE_DECODE_FAILED'});
    }
});

test('PNG edit input observes cancellation before decode and after inflation', async function cancelledDecode() {
    const data = png({rows: [0, 10, 20, 30, 40, 50, 60]});
    const controller = new AbortController();
    const pending = decodeImage({data, signal: controller.signal});
    controller.abort();
    await assert.rejects(pending, {name: 'AbortError'});
    await assert.rejects(decodeImage({data, signal: controller.signal}), {name: 'AbortError'});
});

test('Core edit acknowledges before reading the original Blob and preserves complete input and result', async function browserEditTransport() {
    const original = png({rows: [0, 10, 20, 30, 40, 50, 60]});
    let accessor;
    let received;
    class OriginalPNG extends Blob {
        arrayBuffer() {
            assert.equal(accessor.current().status, 'Thinking');
            return super.arrayBuffer();
        }
    }
    const image = new OriginalPNG([original], {type: 'image/png'});
    const prompt = '  A raccoon astronaut\nwith a purple helmet.  ';
    const parameters = {negative_prompt: '  blurry\nhelmet  ', width: 512, height: 512};
    const client = {
        uuid() { return 'edit-stream'; },
        events: {on() { return function unsubscribe() {}; }},
        async invoke(method, input, options) {
            if (method === 'image.status') return {state: 'ready', loaded: true};
            assert.equal(method, 'image.edit');
            received = input;
            assert.equal(options.timeoutMs, 0);
            return {model: 'sd14', images: [{data: original.toString('base64'), encoding: 'base64', mediaType: 'image/png', width: 2, height: 1}]};
        }
    };
    accessor = createCoreImageRuntime({client});
    try {
        const pending = accessor.edit({model: 'sd14', image, prompt, strength: 0.6, parameters});
        assert.equal(accessor.current().status, 'Thinking');
        const result = await pending;
        assert.equal(received.prompt, prompt);
        assert.deepEqual(received.parameters, parameters);
        assert.equal(received.strength, 0.6);
        assert.deepEqual(Buffer.from(received.image.data, 'base64'), original);
        assert.equal(result.model, 'sd14');
        assert.deepEqual(Buffer.from(await result.images[0].blob.arrayBuffer()), original);
        assert.deepEqual(Buffer.from(await Blob.prototype.arrayBuffer.call(image)), original);
    } finally {
        await accessor.close();
    }
});

test('Core edit cancellation during Blob preparation prevents native dispatch', async function cancelledBrowserPreparation() {
    let releaseRead;
    let readStarted;
    const started = new Promise(function observeRead(resolve) { readStarted = resolve; });
    const read = new Promise(function retainRead(resolve) { releaseRead = resolve; });
    class PendingPNG extends Blob {
        arrayBuffer() {
            readStarted();
            return read;
        }
    }
    const methods = [];
    const client = {
        uuid() { return 'cancelled-edit'; },
        events: {on() { return function unsubscribe() {}; }},
        async invoke(method) {
            methods.push(method);
            return {state: 'ready', loaded: true};
        }
    };
    const accessor = createCoreImageRuntime({client});
    const controller = new AbortController();
    try {
        const pending = accessor.edit({model: 'sd14', image: new PendingPNG(), prompt: 'A moon cactus.', strength: 0.6, signal: controller.signal});
        const rejected = assert.rejects(pending, {name: 'AbortError'});
        await started;
        controller.abort();
        releaseRead(new ArrayBuffer(0));
        await rejected;
        assert.deepEqual(methods, ['image.status']);
        assert.equal(accessor.current().busy, false);
    } finally {
        releaseRead(new ArrayBuffer(0));
        await accessor.close();
    }
});

import {inflate} from 'node:zlib';
import {promisify} from 'node:util';
import {setImmediate} from 'node:timers/promises';

const inflatePNG = promisify(inflate);

function imageError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function malformed(message) {
    return imageError('ARCANE_IMAGE_DECODE_FAILED', message);
}

function unsupported(message) {
    return imageError('ARCANE_IMAGE_INPUT_UNSUPPORTED', message);
}

/**
 * Decode a complete encoded PNG in the shared image runtime's owning worker.
 * The returned pixels are a separate allocation retained through native completion.
 */
export async function decodeImage({data, mediaType, signal} = {}) {
    signal?.throwIfAborted();
    if (!(data instanceof Uint8Array)) {
        throw new TypeError('Image decoding requires encoded Uint8Array data.');
    }
    if (mediaType !== undefined && mediaType !== '' && mediaType !== 'image/png') {
        throw unsupported('Local image editing currently accepts PNG input.');
    }

    const encoded = Buffer.from(data);
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    for (const [index, value] of signature.entries()) {
        if (encoded[index] !== value) throw unsupported('The supplied image is not a PNG.');
    }

    const imageData = [];
    let header;
    let transparency;
    let ended = false;
    let offset = signature.length;
    while (offset < encoded.length) {
        signal?.throwIfAborted();
        // These lengths describe PNG chunk framing, not image admission limits.
        if (encoded.length - offset < 12) throw malformed('The PNG ends inside a chunk.');
        const length = encoded.readUInt32BE(offset);
        const type = encoded.toString('ascii', offset + 4, offset + 8);
        const start = offset + 8;
        const end = start + length;
        if (end + 4 > encoded.length) throw malformed(`The PNG ${type} chunk is incomplete.`);
        if (!header && type !== 'IHDR') throw malformed('The PNG is missing its initial IHDR chunk.');

        if (type === 'IHDR') {
            if (header || length !== 13) throw malformed('The PNG IHDR chunk is invalid.');
            header = {
                width: encoded.readUInt32BE(start),
                height: encoded.readUInt32BE(start + 4),
                depth: encoded[start + 8],
                color: encoded[start + 9],
                compression: encoded[start + 10],
                filter: encoded[start + 11],
                interlace: encoded[start + 12]
            };
            if (!header.width || !header.height) throw malformed('PNG dimensions must be nonzero.');
            if (header.depth !== 8 || (header.color !== 2 && header.color !== 6)
                || header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) {
                throw unsupported('Local image editing accepts non-interlaced 8-bit RGB or RGBA PNG images.');
            }
        } else if (type === 'IDAT') {
            imageData.push(encoded.subarray(start, end));
        } else if (type === 'tRNS') {
            if (header.color !== 2 || length !== 6 || transparency) {
                throw malformed('The PNG transparency chunk is invalid for its color type.');
            }
            // PNG uses only the low sample bits for an 8-bit transparent color.
            transparency = [
                encoded.readUInt16BE(start) & 255,
                encoded.readUInt16BE(start + 2) & 255,
                encoded.readUInt16BE(start + 4) & 255
            ];
        } else if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') {
            throw unsupported('Local image editing requires a still PNG; animated PNG input is unsupported.');
        } else if (type === 'IEND') {
            if (length !== 0) throw malformed('The PNG IEND chunk is invalid.');
            ended = true;
            break;
        } else if (type !== 'PLTE' && (encoded[offset + 4] & 32) === 0) {
            throw unsupported(`The PNG critical chunk ${type} is unsupported.`);
        }
        offset = end + 4;
    }
    if (!header || !ended || !imageData.length) throw malformed('The PNG image stream is incomplete.');

    signal?.throwIfAborted();
    // All IDAT chunks form one zlib stream. An abort still joins its completion.
    const filtered = await inflatePNG(Buffer.concat(imageData));
    signal?.throwIfAborted();
    const {width, height} = header;
    const sourceChannels = header.color === 6 ? 4 : 3;
    const channel = transparency ? 4 : sourceChannels;
    const rowLength = width * sourceChannels;
    const pixels = new Uint8Array(width * height * channel);
    let previous = new Uint8Array(rowLength);
    let row = new Uint8Array(rowLength);
    let position = 0;

    for (let y = 0; y < height; y += 1) {
        signal?.throwIfAborted();
        if (position + 1 + rowLength > filtered.length) throw malformed('The PNG ends inside an image row.');
        const filter = filtered[position++];
        if (filter > 4) throw malformed(`The PNG row filter ${filter} is unsupported.`);
        for (let x = 0; x < rowLength; x += 1) {
            const left = x >= sourceChannels ? row[x - sourceChannels] : 0;
            const above = previous[x];
            const upperLeft = x >= sourceChannels ? previous[x - sourceChannels] : 0;
            let prediction = 0;
            if (filter === 1) prediction = left;
            else if (filter === 2) prediction = above;
            else if (filter === 3) prediction = Math.floor((left + above) / 2);
            else if (filter === 4) prediction = paeth(left, above, upperLeft);
            row[x] = (filtered[position++] + prediction) & 255;
        }

        if (transparency) {
            for (let x = 0; x < width; x += 1) {
                const source = x * sourceChannels;
                const target = (y * width + x) * channel;
                pixels[target] = row[source];
                pixels[target + 1] = row[source + 1];
                pixels[target + 2] = row[source + 2];
                pixels[target + 3] = row[source] === transparency[0]
                    && row[source + 1] === transparency[1]
                    && row[source + 2] === transparency[2] ? 0 : 255;
            }
        } else {
            pixels.set(row, y * width * channel);
        }
        const reusable = previous;
        previous = row;
        row = reusable;
        // Let the owning worker receive cancellation between scanlines.
        await setImmediate(undefined, {signal});
    }
    if (position !== filtered.length) throw malformed('The PNG contains data beyond its declared image rows.');
    signal?.throwIfAborted();
    return {width, height, channel, data: pixels};
}

function paeth(left, above, upperLeft) {
    const prediction = left + above - upperLeft;
    const fromLeft = Math.abs(prediction - left);
    const fromAbove = Math.abs(prediction - above);
    const fromUpperLeft = Math.abs(prediction - upperLeft);
    if (fromLeft <= fromAbove && fromLeft <= fromUpperLeft) return left;
    return fromAbove <= fromUpperLeft ? above : upperLeft;
}

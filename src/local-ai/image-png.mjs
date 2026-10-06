import {Buffer} from 'node:buffer';
import {crc32, deflate} from 'node:zlib';

/** Encode complete native RGB/RGBA pixels in the owning image worker. */
export async function encodePNG(
    {width, height, channel, data, signal}
) {
    signal?.throwIfAborted();
    if (channel !== 3 && channel !== 4) {
        throw new TypeError('PNG image output requires RGB or RGBA pixels.');
    }

    const pixels = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const rowLength = width * channel;
    // PNG scanlines must represent every supplied pixel exactly once.
    if (pixels.length !== rowLength * height) {
        throw new TypeError('The pixel data does not match the image dimensions.');
    }
    const scanlines = Buffer.alloc((rowLength + 1) * height);
    for (let row = 0; row < height; row++) {
        signal?.throwIfAborted();
        const start = row * rowLength;
        pixels.copy(scanlines, row * (rowLength + 1) + 1, start, start + rowLength);
    }

    // The zero filter prefix preserves each channel; zlib runs asynchronously.
    const compressed = await new Promise(
        function compressImage(resolve, reject) {
            deflate(
                scanlines,
                function imageCompressed(error, result) {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(result);
                    }
                }
            );
        }
    );
    signal?.throwIfAborted();

    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = channel === 3 ? 2 : 6;
    const chunks = [
        Buffer.from(
            [137, 80, 78, 71, 13, 10, 26, 10]
        ),
        pngChunk('IHDR', header)
    ];

    // PNG limits each chunk's framing field; continuation retains all data.
    for (let offset = 0; offset < compressed.length; offset += 0x7fffffff) {
        signal?.throwIfAborted();
        chunks.push(pngChunk('IDAT', compressed.subarray(offset, offset + 0x7fffffff)));
    }
    chunks.push(pngChunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(chunks);
}

function pngChunk(name, data) {
    const type = Buffer.from(name, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    // CRC is required PNG framing, confined to this image encoder.
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(data, crc32(type)));
    return Buffer.concat(
        [length, type, data, crc]
    );
}

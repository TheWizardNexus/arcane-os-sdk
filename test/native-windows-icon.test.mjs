import assert from 'node:assert/strict';
import {crc32, deflateSync} from 'node:zlib';
import test from '../src/testing.mjs';
import {createWindowsApplicationIcon} from '../src/native/windows-icon.mjs';

// These are native-format fixtures, never runnable Windows programs. Their
// fixed layout makes the resource assertions independent of the SDK writer.
const PE_OFFSET = 0x80;
const OPTIONAL_OFFSET = PE_OFFSET + 24;
const RESOURCE_RVA = 0x2000;
const RESOURCE_FILE_OFFSET = 0x600;

function pngChunk(type, data) {
    const name = Buffer.from(type, 'ascii');
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    name.copy(chunk, 4);
    data.copy(chunk, 8);
    // PNG requires this field as part of its transport format; it is never
    // compared with a product receipt or used as an admission policy.
    const content = Buffer.concat(
        [name, data]
    );
    chunk.writeUInt32BE(
        crc32(content),
        8 + data.length
    );
    return chunk;
}

function rgbaPng() {
    const dimension = 512;
    const header = Buffer.alloc(13);
    header.writeUInt32BE(dimension, 0);
    header.writeUInt32BE(dimension, 4);
    header[8] = 8;
    header[9] = 6;
    const rows = Buffer.alloc(dimension * (1 + dimension * 4));
    const colors = [
        [240, 20, 60, 255],
        [30, 200, 70, 128],
        [90, 40, 220, 0],
        [40, 80, 160, 64]
    ];
    for (let y = 0; y < dimension; y++) {
        for (let x = 0; x < dimension; x++) {
            const color = colors[(y >= dimension / 2 ? 2 : 0) + (x >= dimension / 2 ? 1 : 0)];
            const position = y * (1 + dimension * 4) + 1 + x * 4;
            rows.set(color, position);
        }
    }
    return Buffer.concat(
        [
            Buffer.from(
                [137, 80, 78, 71, 13, 10, 26, 10]
            ),
            pngChunk('IHDR', header),
            pngChunk(
                'IDAT',
                deflateSync(rows)
            ),
            pngChunk(
                'IEND',
                Buffer.alloc(0)
            )
        ]
    );
}

function singlePixelBitmap(red = 230) {
    const bitmap = Buffer.alloc(48);
    bitmap.writeUInt32LE(40, 0);
    bitmap.writeInt32LE(1, 4);
    bitmap.writeInt32LE(2, 8);
    bitmap.writeUInt16LE(1, 12);
    bitmap.writeUInt16LE(32, 14);
    bitmap.set(
        [10, 80, red, 255],
        40
    );
    return bitmap;
}

function selectedIco() {
    const bitmap = singlePixelBitmap();
    const directory = Buffer.alloc(22);
    directory.writeUInt16LE(1, 2);
    directory.writeUInt16LE(1, 4);
    directory[6] = 1;
    directory[7] = 1;
    directory.writeUInt16LE(1, 10);
    directory.writeUInt16LE(32, 12);
    directory.writeUInt32LE(bitmap.length, 14);
    directory.writeUInt32LE(directory.length, 18);
    return Buffer.concat(
        [directory, bitmap]
    );
}

function originalGroup() {
    const group = Buffer.alloc(20);
    group.writeUInt16LE(1, 2);
    group.writeUInt16LE(1, 4);
    group[6] = 1;
    group[7] = 1;
    group.writeUInt16LE(1, 10);
    group.writeUInt16LE(32, 12);
    group.writeUInt32LE(
        singlePixelBitmap().length,
        14
    );
    group.writeUInt16LE(1, 18);
    return group;
}

function executableFixture({resources = false, optionalExtent = 0xf0, directoryCount = 16} = {}) {
    const executable = Buffer.alloc(0xc00);
    executable.writeUInt16LE(0x5a4d, 0);
    executable.writeUInt32LE(PE_OFFSET, 60);
    executable.writeUInt32LE(0x4550, PE_OFFSET);
    executable.writeUInt16LE(0x8664, PE_OFFSET + 4);
    executable.writeUInt16LE(2, PE_OFFSET + 6);
    executable.writeUInt16LE(optionalExtent, PE_OFFSET + 20);
    executable.writeUInt16LE(0x22, PE_OFFSET + 22);
    executable.writeUInt16LE(0x20b, OPTIONAL_OFFSET);
    executable.writeUInt32LE(0x600, OPTIONAL_OFFSET + 8);
    executable.writeUInt32LE(0x1000, OPTIONAL_OFFSET + 32);
    executable.writeUInt32LE(0x200, OPTIONAL_OFFSET + 36);
    executable.writeUInt32LE(0x3000, OPTIONAL_OFFSET + 56);
    executable.writeUInt32LE(0x200, OPTIONAL_OFFSET + 60);
    executable.writeUInt16LE(2, OPTIONAL_OFFSET + 68);
    executable.writeUInt32LE(directoryCount, OPTIONAL_OFFSET + 108);
    const sectionTable = OPTIONAL_OFFSET + optionalExtent;
    executable.write('.text', sectionTable, 'ascii');
    executable.writeUInt32LE(0x200, sectionTable + 8);
    executable.writeUInt32LE(0x1000, sectionTable + 12);
    executable.writeUInt32LE(0x200, sectionTable + 16);
    executable.writeUInt32LE(0x400, sectionTable + 20);
    executable.writeUInt32LE(0x60000020, sectionTable + 36);
    executable.write('.rsrc', sectionTable + 40, 'ascii');
    executable.writeUInt32LE(0x600, sectionTable + 48);
    executable.writeUInt32LE(RESOURCE_RVA, sectionTable + 52);
    executable.writeUInt32LE(0x600, sectionTable + 56);
    executable.writeUInt32LE(RESOURCE_FILE_OFFSET, sectionTable + 60);
    executable.writeUInt32LE(0x40000040, sectionTable + 76);
    const preserved = [];
    if (!resources) return {executable, preserved};

    executable.writeUInt32LE(RESOURCE_RVA, OPTIONAL_OFFSET + 128);
    executable.writeUInt32LE(0x600, OPTIONAL_OFFSET + 132);
    function directory(offset, entries) {
        const base = RESOURCE_FILE_OFFSET + offset;
        executable.writeUInt32LE(0x12345678, base + 4);
        const named = entries.filter(
            function namedEntry(entry) {
                return entry[0] === 'A-cheese';
            }
        );
        executable.writeUInt16LE(named.length, base + 12);
        executable.writeUInt16LE(entries.length - named.length, base + 14);
        for (const [index, [key, target, branch]] of entries.entries()) {
            const position = base + 16 + index * 8;
            executable.writeUInt32LE(key === 'A-cheese' ? 0x80000200 : key, position);
            executable.writeUInt32LE(branch ? (0x80000000 | target) >>> 0 : target, position + 4);
        }
    }
    // A named icon group precedes the lower numeric group. Both reference
    // image 1, so replacing the main group must leave that shared image alone.
    directory(
        0,
        [
            [3, 0x40, true],
            [14, 0x100, true],
            [16, 0x180, true],
            [24, 0x1c0, true],
            [129, 0xc0, true]
        ]
    );
    directory(
        0x40,
        [
            [1, 0x70, true],
            [7, 0xa0, true]
        ]
    );
    directory(
        0x70,
        [
            [1033, 0x240, false],
            [1041, 0x250, false]
        ]
    );
    directory(
        0xa0,
        [
            [0, 0x260, false]
        ]
    );
    directory(
        0xc0,
        [
            [17, 0xe0, true]
        ]
    );
    directory(
        0xe0,
        [
            [1033, 0x270, false]
        ]
    );
    directory(
        0x100,
        [
            ['A-cheese', 0x130, true],
            [1, 0x160, true]
        ]
    );
    directory(
        0x130,
        [
            [1033, 0x280, false],
            [1041, 0x290, false]
        ]
    );
    directory(
        0x160,
        [
            [1033, 0x2a0, false]
        ]
    );
    directory(
        0x180,
        [
            [1, 0x1a0, true]
        ]
    );
    directory(
        0x1a0,
        [
            [0, 0x2b0, false]
        ]
    );
    directory(
        0x1c0,
        [
            [1, 0x1e0, true]
        ]
    );
    directory(
        0x1e0,
        [
            [0, 0x2c0, false]
        ]
    );
    executable.writeUInt16LE('A-cheese'.length, RESOURCE_FILE_OFFSET + 0x200);
    executable.write('A-cheese', RESOURCE_FILE_OFFSET + 0x202, 'utf16le');
    let payloadOffset = 0x300;
    function payload(entry, keys, data, keep = true) {
        executable.writeUInt32LE(RESOURCE_RVA + payloadOffset, RESOURCE_FILE_OFFSET + entry);
        executable.writeUInt32LE(data.length, RESOURCE_FILE_OFFSET + entry + 4);
        executable.writeUInt32LE(65001, RESOURCE_FILE_OFFSET + entry + 8);
        data.copy(executable, RESOURCE_FILE_OFFSET + payloadOffset);
        if (keep) {
            preserved.push(
                {keys, data, codePage: 65001, reserved: 0}
            );
        }
        payloadOffset = Math.ceil((payloadOffset + data.length) / 4) * 4;
    }
    payload(
        0x240,
        [3, 1, 1033],
        singlePixelBitmap(50)
    );
    payload(
        0x250,
        [3, 1, 1041],
        singlePixelBitmap(70)
    );
    payload(
        0x260,
        [3, 7, 0],
        singlePixelBitmap(90)
    );
    payload(
        0x270,
        [129, 17, 1033],
        Buffer.from('  Unknown resource: 日本語 🧀\r\nKeep this final line.  ')
    );
    payload(
        0x280,
        [14, 'A-cheese', 1033],
        originalGroup(),
        false
    );
    payload(
        0x290,
        [14, 'A-cheese', 1041],
        originalGroup(),
        false
    );
    payload(
        0x2a0,
        [14, 1, 1033],
        originalGroup()
    );
    payload(
        0x2b0,
        [16, 1, 0],
        Buffer.from('Synthetic version resource')
    );
    payload(
        0x2c0,
        [24, 1, 0],
        Buffer.from('<assembly><description>Cheese shuttle</description></assembly>')
    );
    return {executable, preserved};
}

function rvaFileOffset(executable, address) {
    const sectionTable = OPTIONAL_OFFSET + executable.readUInt16LE(PE_OFFSET + 20);
    const count = executable.readUInt16LE(PE_OFFSET + 6);
    for (let index = 0; index < count; index++) {
        const section = sectionTable + index * 40;
        const virtualAddress = executable.readUInt32LE(section + 12);
        const extent = Math.max(
            executable.readUInt32LE(section + 8),
            executable.readUInt32LE(section + 16)
        );
        if (address >= virtualAddress && address < virtualAddress + extent) {
            return executable.readUInt32LE(section + 20) + address - virtualAddress;
        }
    }
    assert.fail(`Fixture RVA ${address} has no section.`);
}

function resourceRecord(executable, keys) {
    // Follow one explicitly expected type/name/language path. This assertion
    // reader neither reconstructs a tree nor calls the production parser.
    const root = rvaFileOffset(
        executable,
        executable.readUInt32LE(OPTIONAL_OFFSET + 128)
    );
    let directory = root;
    for (const [level, key] of keys.entries()) {
        const count = executable.readUInt16LE(directory + 12) + executable.readUInt16LE(directory + 14);
        let target;
        for (let index = 0; index < count; index++) {
            const entry = directory + 16 + index * 8;
            const name = executable.readUInt32LE(entry);
            let actual = name;
            if (name & 0x80000000) {
                const text = root + (name & 0x7fffffff);
                actual = executable.toString(
                    'utf16le',
                    text + 2,
                    text + 2 + executable.readUInt16LE(text) * 2
                );
            }
            if (actual === key) target = executable.readUInt32LE(entry + 4);
        }
        assert.notEqual(
            target,
            undefined,
            `Missing resource ${keys.join('/')}.`
        );
        if (level < 2) {
            assert.ok(target & 0x80000000);
            directory = root + (target & 0x7fffffff);
        } else {
            assert.equal(target & 0x80000000, 0);
            const record = root + target;
            const content = rvaFileOffset(
                executable,
                executable.readUInt32LE(record)
            );
            return {
                data: executable.subarray(
                    content,
                    content + executable.readUInt32LE(record + 4)
                ),
                codePage: executable.readUInt32LE(record + 8),
                reserved: executable.readUInt32LE(record + 12)
            };
        }
    }
}

test(
    'A 512 PNG produces real native icon resolutions with alpha and mask pixels',
    async function convertPng() {
        const source = rgbaPng();
        const originalSource = Buffer.from(source);
        const {executable} = executableFixture();
        const originalExecutable = Buffer.from(executable);
        const result = await createWindowsApplicationIcon(
            {source, extension: '.PNG', executable}
        );
        assert.equal(
            result.icon.readUInt16LE(2),
            1
        );
        assert.equal(
            result.icon.readUInt16LE(4),
            4
        );
        for (const [index, dimension] of [16, 32, 48, 256].entries()) {
            const entry = 6 + index * 16;
            assert.equal(result.icon[entry] || 256, dimension);
            assert.equal(result.icon[entry + 1] || 256, dimension);
            const bitmap = result.icon.readUInt32LE(entry + 12);
            assert.equal(
                result.icon.readUInt32LE(bitmap),
                40
            );
            assert.equal(
                result.icon.readInt32LE(bitmap + 4),
                dimension
            );
            assert.equal(
                result.icon.readInt32LE(bitmap + 8),
                dimension * 2
            );
            assert.equal(
                result.icon.readUInt16LE(bitmap + 14),
                32
            );
            const positions = [
                [
                    1,
                    1,
                    [60, 20, 240, 255]
                ],
                [
                    3,
                    1,
                    [70, 200, 30, 128]
                ],
                [
                    1,
                    3,
                    [0, 0, 0, 0]
                ],
                [
                    3,
                    3,
                    [160, 80, 40, 64]
                ]
            ];
            for (const [quarterX, quarterY, color] of positions) {
                const x = Math.floor(dimension * quarterX / 4);
                const y = Math.floor(dimension * quarterY / 4);
                const pixel = bitmap + 40 + ((dimension - 1 - y) * dimension + x) * 4;
                assert.deepEqual(
                    Array.from(
                        result.icon.subarray(pixel, pixel + 4)
                    ),
                    color
                );
                const maskRow = Math.ceil(dimension / 32) * 4;
                const mask = bitmap + 40 + dimension * dimension * 4 + (dimension - 1 - y) * maskRow + Math.floor(x / 8);
                assert.equal(
                    Boolean(result.icon[mask] & (128 >> (x % 8))),
                    color[3] === 0
                );
            }
        }
        assert.deepEqual(source, originalSource);
        assert.deepEqual(executable, originalExecutable);
    }
);

test(
    'ICO branding replaces the named main group in every language and preserves shared resources',
    async function preserveResourceTree() {
        const source = selectedIco();
        const originalSource = Buffer.from(source);
        const {executable, preserved} = executableFixture(
            {resources: true}
        );
        const originalExecutable = Buffer.from(executable);
        const result = await createWindowsApplicationIcon(
            {source, extension: '.ico', executable}
        );
        assert.deepEqual(result.icon, originalSource);
        for (const resource of preserved) {
            const actual = resourceRecord(result.executable, resource.keys);
            assert.deepEqual(
                actual,
                {data: resource.data, codePage: resource.codePage, reserved: resource.reserved}
            );
        }
        for (const language of [1033, 1041]) {
            const group = resourceRecord(
                result.executable,
                [14, 'A-cheese', language]
            );
            assert.equal(group.codePage, 65001);
            assert.equal(
                group.data.readUInt16LE(4),
                1
            );
            const imageId = group.data.readUInt16LE(18);
            assert.ok(imageId !== 1 && imageId !== 7, 'A replacement must not overwrite either existing icon.');
            const image = resourceRecord(
                result.executable,
                [3, imageId, language]
            );
            assert.deepEqual(
                image.data,
                singlePixelBitmap()
            );
        }
        const root = rvaFileOffset(
            result.executable,
            result.executable.readUInt32LE(OPTIONAL_OFFSET + 128)
        );
        assert.equal(
            result.executable.readUInt32LE(root + 4),
            0x12345678
        );
        assert.deepEqual(source, originalSource);
        assert.deepEqual(executable, originalExecutable);
    }
);

test(
    'PE layouts without a declared resource slot or complete header room report unsupported branding',
    async function unsupportedPeLayout() {
        const cases = [
            {directoryCount: 2},
            {optionalExtent: 0x80},
            {optionalExtent: 0xf8}
        ];
        for (const options of cases) {
            const source = selectedIco();
            const {executable} = executableFixture(options);
            const original = Buffer.from(executable);
            await assert.rejects(
                createWindowsApplicationIcon(
                    {source, extension: '.ico', executable}
                ),
                {code: 'ARCANE_WINDOWS_ICON_UNSUPPORTED'}
            );
            assert.deepEqual(executable, original);
        }
    }
);

test(
    'Other descriptor image formats keep an explicit unsupported conversion result',
    async function retainOtherImageFormats() {
        for (const extension of ['.svg', '.jpg', '.webp']) {
            await assert.rejects(
                createWindowsApplicationIcon(
                    {
                        source: Buffer.from('Selected source belongs to its original image format.'),
                        extension,
                        executable: Buffer.from('No PE conversion should start for this format.')
                    }
                ),
                {code: 'ARCANE_WINDOWS_ICON_UNSUPPORTED'}
            );
        }
    }
);

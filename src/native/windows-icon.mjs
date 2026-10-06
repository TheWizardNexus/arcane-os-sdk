import {inflate} from 'node:zlib';
import {promisify} from 'node:util';

const inflateImage = promisify(inflate);
const PNG_SIGNATURE = Buffer.from(
    [137, 80, 78, 71, 13, 10, 26, 10]
);

function unsupported(message) {
    const error = new Error(message);
    error.code = 'ARCANE_WINDOWS_ICON_UNSUPPORTED';
    return error;
}

function paeth(left, above, upperLeft) {
    const prediction = left + above - upperLeft;
    const a = Math.abs(prediction - left);
    const b = Math.abs(prediction - above);
    const c = Math.abs(prediction - upperLeft);
    return a <= b && a <= c ? left : b <= c ? above : upperLeft;
}

async function readPng(source) {
    if (!source.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('The selected PNG has no PNG signature.');
    let header;
    let palette;
    let transparency;
    const compressed = [];
    let ended = false;
    for (let offset = 8; offset < source.length;) {
        const length = source.readUInt32BE(offset);
        const type = source.toString('ascii', offset + 4, offset + 8);
        const end = offset + 12 + length;
        if (end > source.length) throw new Error(`The selected PNG has an incomplete ${type} chunk.`);
        const data = source.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') header = data;
        else if (type === 'PLTE') palette = data;
        else if (type === 'tRNS') transparency = data;
        else if (type === 'IDAT') compressed.push(data);
        else if (type === 'IEND') {
            ended = true;
            break;
        }
        offset = end;
    }
    if (!header || !ended) throw new Error('The selected PNG is missing its image header or end marker.');
    const width = header.readUInt32BE(0);
    const height = header.readUInt32BE(4);
    const depth = header[8];
    const type = header[9];
    const channelCounts = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4};
    const channels = channelCounts[type];
    const depths = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16]
    };
    if (!width || !height || !channels || !depths[type].includes(depth)
        || header[10] !== 0 || header[11] !== 0 || ![0, 1].includes(header[12])) {
        throw new Error('The selected PNG image header uses an unsupported PNG encoding.');
    }
    if (type === 3 && !palette) throw new Error('The selected indexed PNG has no palette.');
    const scanlines = await inflateImage(
        Buffer.concat(compressed)
    );
    const pixels = Buffer.alloc(width * height * 4);
    const passes = header[12] === 0 ? [
        [0, 0, 1, 1]
    ] : [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2]
    ];
    let position = 0;
    for (const [startX, startY, stepX, stepY] of passes) {
        const columns = Math.max(
            0,
            Math.ceil((width - startX) / stepX)
        );
        const rows = Math.max(
            0,
            Math.ceil((height - startY) / stepY)
        );
        if (!columns || !rows) continue;
        const stride = Math.ceil(columns * channels * depth / 8);
        const filterStride = Math.max(
            1,
            Math.ceil(channels * depth / 8)
        );
        let previous = Buffer.alloc(stride);
        for (let row = 0; row < rows; row++) {
            const filter = scanlines[position++];
            if (filter > 4 || position + stride > scanlines.length) throw new Error('The selected PNG has an incomplete or invalid scanline.');
            const current = Buffer.from(
                scanlines.subarray(position, position + stride)
            );
            position += stride;
            for (let column = 0; column < stride; column++) {
                const left = column >= filterStride ? current[column - filterStride] : 0;
                const above = previous[column];
                const upperLeft = column >= filterStride ? previous[column - filterStride] : 0;
                let predictor = 0;
                if (filter === 1) predictor = left;
                else if (filter === 2) predictor = above;
                else if (filter === 3) predictor = Math.floor((left + above) / 2);
                else if (filter === 4) predictor = paeth(left, above, upperLeft);
                current[column] = (current[column] + predictor) & 255;
            }
            function sample(index) {
                if (depth === 16) return current.readUInt16BE(index * 2);
                if (depth === 8) return current[index];
                const bit = index * depth;
                return (current[Math.floor(bit / 8)] >> (8 - depth - bit % 8)) & ((1 << depth) - 1);
            }
            function channel(value) { return Math.round(value * 255 / (2 ** depth - 1)); }
            for (let column = 0; column < columns; column++) {
                const sampleOffset = column * channels;
                const first = sample(sampleOffset);
                const output = ((startY + row * stepY) * width + startX + column * stepX) * 4;
                let red;
                let green;
                let blue;
                let alpha = 255;
                if (type === 3) {
                    if (first * 3 + 2 >= palette.length) throw new Error('The selected PNG references a missing palette entry.');
                    red = palette[first * 3];
                    green = palette[first * 3 + 1];
                    blue = palette[first * 3 + 2];
                    alpha = transparency?.[first] ?? 255;
                } else if (type === 0 || type === 4) {
                    red = channel(first);
                    green = red;
                    blue = red;
                    if (type === 4) {
                        alpha = channel(
                            sample(sampleOffset + 1)
                        );
                    }
                    else if (transparency && first === transparency.readUInt16BE(0)) alpha = 0;
                } else {
                    const second = sample(sampleOffset + 1);
                    const third = sample(sampleOffset + 2);
                    red = channel(first);
                    green = channel(second);
                    blue = channel(third);
                    if (type === 6) {
                        alpha = channel(
                            sample(sampleOffset + 3)
                        );
                    }
                    else if (transparency && first === transparency.readUInt16BE(0)
                        && second === transparency.readUInt16BE(2) && third === transparency.readUInt16BE(4)) alpha = 0;
                }
                pixels[output] = red;
                pixels[output + 1] = green;
                pixels[output + 2] = blue;
                pixels[output + 3] = alpha;
            }
            previous = current;
        }
    }
    return {width, height, pixels};
}

function bitmapIcon({width, height, pixels}, dimension) {
    const maskStride = Math.ceil(dimension / 32) * 4;
    const bitmap = Buffer.alloc(40 + dimension * dimension * 4 + maskStride * dimension);
    bitmap.writeUInt32LE(40, 0);
    bitmap.writeInt32LE(dimension, 4);
    bitmap.writeInt32LE(dimension * 2, 8);
    bitmap.writeUInt16LE(1, 12);
    bitmap.writeUInt16LE(32, 14);
    const scale = Math.min(dimension / width, dimension / height);
    const drawWidth = width * scale;
    const drawHeight = height * scale;
    const left = (dimension - drawWidth) / 2;
    const top = (dimension - drawHeight) / 2;
    for (let y = 0; y < dimension; y++) {
        for (let x = 0; x < dimension; x++) {
            const output = 40 + ((dimension - 1 - y) * dimension + x) * 4;
            if (x + 0.5 >= left && x + 0.5 < left + drawWidth && y + 0.5 >= top && y + 0.5 < top + drawHeight) {
                const sourceX = Math.max(
                    0,
                    Math.min(width - 1, (x + 0.5 - left) / scale - 0.5)
                );
                const sourceY = Math.max(
                    0,
                    Math.min(height - 1, (y + 0.5 - top) / scale - 0.5)
                );
                const x0 = Math.floor(sourceX);
                const y0 = Math.floor(sourceY);
                const x1 = Math.min(width - 1, x0 + 1);
                const y1 = Math.min(height - 1, y0 + 1);
                const dx = sourceX - x0;
                const dy = sourceY - y0;
                const samples = [
                    [x0, y0, (1 - dx) * (1 - dy)],
                    [x1, y0, dx * (1 - dy)],
                    [x0, y1, (1 - dx) * dy],
                    [x1, y1, dx * dy]
                ];
                const color = [0, 0, 0];
                let alpha = 0;
                for (const [sx, sy, weight] of samples) {
                    const input = (sy * width + sx) * 4;
                    const contribution = pixels[input + 3] * weight;
                    alpha += contribution;
                    for (let component = 0; component < 3; component++) color[component] += pixels[input + component] * contribution;
                }
                if (alpha) {
                    bitmap[output] = Math.round(color[2] / alpha);
                    bitmap[output + 1] = Math.round(color[1] / alpha);
                    bitmap[output + 2] = Math.round(color[0] / alpha);
                    bitmap[output + 3] = Math.round(alpha);
                }
            }
            if (bitmap[output + 3] === 0) {
                bitmap[40 + dimension * dimension * 4 + (dimension - 1 - y) * maskStride + Math.floor(x / 8)] |= 128 >> (x % 8);
            }
        }
    }
    return {width: dimension, height: dimension, colors: 0, planes: 1, depth: 32, data: bitmap};
}

function readIco(source) {
    if (source.readUInt16LE(0) !== 0 || source.readUInt16LE(2) !== 1) throw new Error('The selected ICO has no icon directory.');
    const images = [];
    const count = source.readUInt16LE(4);
    if (!count) throw new Error('The selected ICO contains no images.');
    for (let index = 0; index < count; index++) {
        const entry = 6 + index * 16;
        const length = source.readUInt32LE(entry + 8);
        const offset = source.readUInt32LE(entry + 12);
        if (!length || offset + length > source.length) throw new Error('The selected ICO contains an incomplete image.');
        images.push(
            {
                width: source[entry] || 256,
                height: source[entry + 1] || 256,
                colors: source[entry + 2],
                planes: source.readUInt16LE(entry + 4),
                depth: source.readUInt16LE(entry + 6),
                data: source.subarray(offset, offset + length)
            }
        );
    }
    return images;
}

function iconFile(images) {
    const directory = Buffer.alloc(6 + images.length * 16);
    directory.writeUInt16LE(1, 2);
    directory.writeUInt16LE(images.length, 4);
    let offset = directory.length;
    for (const [index, image] of images.entries()) {
        const entry = 6 + index * 16;
        directory[entry] = image.width === 256 ? 0 : image.width;
        directory[entry + 1] = image.height === 256 ? 0 : image.height;
        directory[entry + 2] = image.colors;
        directory.writeUInt16LE(image.planes, entry + 4);
        directory.writeUInt16LE(image.depth, entry + 6);
        directory.writeUInt32LE(image.data.length, entry + 8);
        directory.writeUInt32LE(offset, entry + 12);
        offset += image.data.length;
    }
    const payloads = images.map(
        function imageContent(image) { return image.data; }
    );
    return Buffer.concat(
        [directory, ...payloads]
    );
}

function align(value, alignment) { return Math.ceil(value / alignment) * alignment; }

function readExecutable(source) {
    if (source.readUInt16LE(0) !== 0x5a4d) throw unsupported('The selected Windows launcher is not a PE executable.');
    const pe = source.readUInt32LE(60);
    if (source.readUInt32LE(pe) !== 0x4550) throw unsupported('The selected Windows launcher has no PE signature.');
    const optional = pe + 24;
    const magic = source.readUInt16LE(optional);
    if (![0x10b, 0x20b].includes(magic)) throw unsupported('The selected Windows launcher uses an unsupported PE optional header.');
    const directories = optional + (magic === 0x20b ? 112 : 96);
    const count = source.readUInt16LE(pe + 6);
    const sectionTable = optional + source.readUInt16LE(pe + 20);
    // The PE header declares both the directory count and the extent in which
    // those entries exist. Do not interpret a following section as a directory.
    if (directories + 24 > sectionTable || source.readUInt32LE(directories - 4) < 3) {
        throw unsupported('The selected Windows launcher has no declared PE resource directory slot.');
    }
    const sections = [];
    for (let index = 0; index < count; index++) {
        const offset = sectionTable + index * 40;
        sections.push(
            {
                offset,
                virtualSize: source.readUInt32LE(offset + 8),
                address: source.readUInt32LE(offset + 12),
                rawSize: source.readUInt32LE(offset + 16),
                raw: source.readUInt32LE(offset + 20)
            }
        );
    }
    function fileOffset(address) {
        const section = sections.find(
            function containing(item) {
                return address >= item.address && address < item.address + Math.max(item.virtualSize, item.rawSize);
            }
        );
        if (!section) throw new Error('The PE resource address has no containing section.');
        return section.raw + address - section.address;
    }
    const resourceAddress = source.readUInt32LE(directories + 16);
    const rootOffset = resourceAddress ? fileOffset(resourceAddress) : null;
    function readDirectory(relative, ancestors = new Set()) {
        if (ancestors.has(relative)) throw new Error('The PE resource directory contains a cycle.');
        const offset = rootOffset + relative;
        const children = [];
        const total = source.readUInt16LE(offset + 12) + source.readUInt16LE(offset + 14);
        for (let index = 0; index < total; index++) {
            const entry = offset + 16 + index * 8;
            const name = source.readUInt32LE(entry);
            const target = source.readUInt32LE(entry + 4);
            let key = name;
            if (name & 0x80000000) {
                const location = rootOffset + (name & 0x7fffffff);
                const end = location + 2 + source.readUInt16LE(location) * 2;
                if (end > source.length) throw new Error('The PE resource name is incomplete.');
                key = source.toString('utf16le', location + 2, end);
            }
            let value;
            if (target & 0x80000000) {
                const parents = new Set(
                    [...ancestors, relative]
                );
                value = readDirectory(target & 0x7fffffff, parents);
            } else {
                const location = rootOffset + target;
                const start = fileOffset(
                    source.readUInt32LE(location)
                );
                const end = start + source.readUInt32LE(location + 4);
                if (end > source.length) throw new Error('The PE resource payload is incomplete.');
                value = {
                    data: source.subarray(start, end),
                    codePage: source.readUInt32LE(location + 8),
                    reserved: source.readUInt32LE(location + 12)
                };
            }
            children.push(
                {key, value}
            );
        }
        const header = Buffer.from(
            source.subarray(offset, offset + 12)
        );
        return {header, children};
    }
    return {
        pe, optional, directories, count, sectionTable, sections,
        headerSize: source.readUInt32LE(optional + 60),
        fileAlignment: source.readUInt32LE(optional + 36),
        sectionAlignment: source.readUInt32LE(optional + 32),
        resources: rootOffset === null ? {
            header: Buffer.alloc(12), children: []
        } : readDirectory(0)
    };
}

function directoryChild(directory, key) {
    let child = directory.children.find(
        function matching(item) { return item.key === key; }
    );
    if (!child) {
        child = {
            key,
            value: {
                header: Buffer.alloc(12), children: []
            }
        };
        directory.children.push(child);
    }
    return child.value;
}

function resourceOrder(left, right) {
    if (typeof left.key !== typeof right.key) return typeof left.key === 'string' ? -1 : 1;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

function replaceMainIcon(resources, images) {
    const icons = directoryChild(resources, 3);
    const groups = directoryChild(resources, 14);
    groups.children.sort(resourceOrder);
    const group = groups.children.length ? groups.children[0].value : directoryChild(groups, 1);
    const languages = group.children.length ? group.children.map(
        function language(item) { return item.key; }
    ) : [0];
    const occupied = new Set(
        icons.children.map(
            function iconId(item) { return item.key; }
        )
    );
    const ids = [];
    let next = 1;
    for (const image of images) {
        while (occupied.has(next)) next++;
        if (next > 65535) throw unsupported('The selected Windows launcher has no available icon resource identifier.');
        const id = next++;
        occupied.add(id);
        ids.push(id);
        const icon = directoryChild(icons, id);
        icon.children = languages.map(
            function imageLanguage(key) {
                return {
                    key,
                    value: {
                        data: image.data, codePage: 0, reserved: 0
                    }
                };
            }
        );
    }
    const data = Buffer.alloc(6 + images.length * 14);
    data.writeUInt16LE(1, 2);
    data.writeUInt16LE(images.length, 4);
    for (const [index, image] of images.entries()) {
        const offset = 6 + index * 14;
        data[offset] = image.width === 256 ? 0 : image.width;
        data[offset + 1] = image.height === 256 ? 0 : image.height;
        data[offset + 2] = image.colors;
        data.writeUInt16LE(image.planes, offset + 4);
        data.writeUInt16LE(image.depth, offset + 6);
        data.writeUInt32LE(image.data.length, offset + 8);
        data.writeUInt16LE(ids[index], offset + 12);
    }
    group.children = languages.map(
        function groupLanguage(key) {
            const previous = group.children.find(
                function matching(item) { return item.key === key; }
            );
            return {
                key,
                value: {
                    ...previous?.value,
                    data,
                    codePage: previous?.value.codePage ?? 0,
                    reserved: previous?.value.reserved ?? 0
                }
            };
        }
    );
}

function resourceSection(root, address) {
    const directories = [];
    const names = [];
    const payloads = [];
    let position = 0;
    function placeDirectory(directory) {
        directory.children.sort(resourceOrder);
        directory.offset = position;
        position += 16 + directory.children.length * 8;
        directories.push(directory);
        for (const child of directory.children) {
            if (typeof child.key === 'string') names.push(child);
            if (child.value.children) placeDirectory(child.value);
            else payloads.push(child.value);
        }
    }
    placeDirectory(root);
    for (const name of names) {
        name.nameOffset = position;
        position += 2 + name.key.length * 2;
    }
    position = align(position, 4);
    for (const payload of payloads) {
        payload.offset = position;
        position += 16;
    }
    for (const payload of payloads) {
        payload.dataOffset = position;
        position = align(position + payload.data.length, 4);
    }
    const output = Buffer.alloc(position);
    for (const directory of directories) {
        directory.header.copy(output, directory.offset);
        const named = directory.children.filter(
            function namedEntry(child) { return typeof child.key === 'string'; }
        );
        output.writeUInt16LE(named.length, directory.offset + 12);
        output.writeUInt16LE(directory.children.length - named.length, directory.offset + 14);
        for (const [index, child] of directory.children.entries()) {
            const entry = directory.offset + 16 + index * 8;
            output.writeUInt32LE(typeof child.key === 'string' ? (child.nameOffset | 0x80000000) >>> 0 : child.key, entry);
            output.writeUInt32LE(child.value.children ? (child.value.offset | 0x80000000) >>> 0 : child.value.offset, entry + 4);
        }
    }
    for (const name of names) {
        output.writeUInt16LE(name.key.length, name.nameOffset);
        output.write(name.key, name.nameOffset + 2, 'utf16le');
    }
    for (const payload of payloads) {
        output.writeUInt32LE(address + payload.dataOffset, payload.offset);
        output.writeUInt32LE(payload.data.length, payload.offset + 4);
        output.writeUInt32LE(payload.codePage, payload.offset + 8);
        output.writeUInt32LE(payload.reserved, payload.offset + 12);
        payload.data.copy(output, payload.dataOffset);
    }
    return output;
}

function executableIcon(source, images) {
    const pe = readExecutable(source);
    const rawSections = pe.sections.filter(
        function hasRaw(section) { return section.rawSize; }
    );
    const firstRaw = Math.min(
        ...rawSections.map(
            function raw(section) { return section.raw; }
        )
    );
    const sectionHeader = pe.sectionTable + pe.count * 40;
    if (sectionHeader + 40 > Math.min(firstRaw, pe.headerSize)) {
        throw unsupported('The selected Windows launcher has no declared section-header room for its app icon.');
    }
    replaceMainIcon(pe.resources, images);
    const sectionEnds = pe.sections.map(
        function sectionEnd(section) {
            return section.address + Math.max(section.virtualSize, section.rawSize);
        }
    );
    const address = align(
        Math.max(...sectionEnds),
        pe.sectionAlignment
    );
    const resources = resourceSection(pe.resources, address);
    const raw = align(source.length, pe.fileAlignment);
    const rawSize = align(resources.length, pe.fileAlignment);
    const output = Buffer.alloc(raw + rawSize);
    source.copy(output);
    resources.copy(output, raw);
    output.fill(0, sectionHeader, sectionHeader + 40);
    output.write('.arcicon', sectionHeader, 'ascii');
    output.writeUInt32LE(resources.length, sectionHeader + 8);
    output.writeUInt32LE(address, sectionHeader + 12);
    output.writeUInt32LE(rawSize, sectionHeader + 16);
    output.writeUInt32LE(raw, sectionHeader + 20);
    output.writeUInt32LE(0x40000040, sectionHeader + 36);
    output.writeUInt16LE(pe.count + 1, pe.pe + 6);
    output.writeUInt32LE(output.readUInt32LE(pe.optional + 8) + rawSize, pe.optional + 8);
    output.writeUInt32LE(
        align(address + resources.length, pe.sectionAlignment),
        pe.optional + 56
    );
    output.writeUInt32LE(address, pe.directories + 16);
    output.writeUInt32LE(resources.length, pe.directories + 20);
    return output;
}

/** Native file-format conversion only; the selected source asset remains unchanged. */
export async function createWindowsApplicationIcon({source, extension, executable}) {
    const format = extension.toLowerCase();
    if (!['.png', '.ico'].includes(format)) throw unsupported(`Windows executable icon conversion is unavailable for ${format || 'this image format'}.`);
    let images;
    if (format === '.ico') images = readIco(source);
    else {
        const raster = await readPng(source);
        images = [16, 32, 48, 256].map(
            function nativeImage(dimension) { return bitmapIcon(raster, dimension); }
        );
    }
    return {
        icon: format === '.ico' ? Buffer.from(source) : iconFile(images),
        executable: executableIcon(executable, images)
    };
}

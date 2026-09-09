import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {gzipSync, gunzipSync} from 'node:zlib';
import test from 'node:test';
import {
    APP_BUNDLE_DESCRIPTOR_NAME,
    APP_BUNDLE_FORMAT,
    APP_BUNDLE_KIND,
    APP_BUNDLE_MANIFEST_NAME,
    APP_BUNDLE_RELEASE_PATH,
    createAppReleaseBundle,
    createCanonicalUstarHeader,
    validateAppBundlePath,
    verifyAppReleaseBundle
} from '../src/release-bundle.mjs';
import {PACKAGER_VERSION, RELEASE_MANIFEST_NAME} from '../src/packager/core.mjs';
import {ARCANE_PROTOCOL} from '../src/constants.mjs';

async function fixture(t, extraFiles = []) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcane-bundle-content-'));
    t.after(
        function removeBundleFixture() {
            return rm(
                root,
                {recursive: true, force: true}
            );
        }
    );
    const releaseRoot = path.join(root, 'release');
    await mkdir(
        path.join(releaseRoot, 'content'),
        {recursive: true}
    );
    const descriptor = {
        schemaVersion: 2,
        id: 'moon-archive',
        displayName: 'The Moon Archive',
        description: 'Complete synthetic archive documents.',
        version: '1.2.3',
        publisher: {
            id: 'fixture-publisher',
            name: 'Fixture Publisher'
        },
        package: {
            entry: 'index.html',
            strategy: 'static',
            include: ['content', 'index.html'],
            exclude: [],
            shared: ['browser-runtime']
        },
        native: {
            type: 'app',
            icon: null,
            order: 100,
            bundledApps: []
        },
        requirements: {
            arcaneProtocol: ARCANE_PROTOCOL,
            features: []
        },
        targets: ['browser']
    };
    const complete = 'complete bundle content\nwith every line\nand trailing space \n';
    const files = new Map(
        [
            ['index.html', '<p>Complete bundle</p>\n'],
            ['content/complete.txt', complete],
            ...extraFiles
        ]
    );
    await Promise.all(
        [...files].map(
            async function writeReleaseFixture([relative, content]) {
                const destination = path.join(releaseRoot, ...relative.split('/'));
                await mkdir(
                    path.dirname(destination),
                    {recursive: true}
                );
                await writeFile(destination, content);
            }
        )
    );
    await writeFile(
        path.join(releaseRoot, RELEASE_MANIFEST_NAME),
        `${JSON.stringify(
            {
                schemaVersion: 1,
                kind: 'arcane-app-release',
                packagerVersion: PACKAGER_VERSION,
                app: {
                    id: descriptor.id,
                    displayName: descriptor.displayName,
                    version: descriptor.version,
                    entry: 'index.html',
                    strategy: 'static',
                    shared: descriptor.package.shared
                },
                files: [...files.keys()]
            },
            null,
            2
        )}\n`
    );
    return {
        root,
        releaseRoot,
        descriptor,
        complete,
        files
    };
}

function archiveRecords(archive) {
    const records = [];
    for (let offset = 0; offset + 512 <= archive.length;) {
        const header = archive.subarray(offset, offset + 512);
        if (
            header.every(
                function zero(value) {
                    return value === 0;
                }
            )
        ) {
            break;
        }
        const length = Number.parseInt(
            header.subarray(124, 136).toString('ascii').replace(/[\0 ]+$/u, ''),
            8
        );
        const contentStart = offset + 512;
        const end = contentStart + Math.ceil(length / 512) * 512;
        records.push(
            {
                header,
                content: archive.subarray(contentStart, contentStart + length),
                start: offset,
                end
            }
        );
        offset = end;
    }
    return records;
}

// These helpers construct only the unavoidable tar/PAX transport framing.
function paxPathRecord(value) {
    const body = Buffer.from(`path=${value}\n`, 'utf8');
    let length = body.length + 2;
    while (length !== body.length + String(length).length + 1) {
        length = body.length + String(length).length + 1;
    }
    return Buffer.concat(
        [Buffer.from(`${length} `, 'ascii'), body]
    );
}

function paxArchiveEntry(content) {
    const header = createCanonicalUstarHeader('PaxHeaders/path', content.length);
    header[156] = 0x78;
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const value of header) {
        checksum += value;
    }
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    const remainder = content.length % 512;
    return Buffer.concat(
        [header, content, Buffer.alloc(remainder === 0 ? 0 : 512 - remainder)]
    );
}

test(
    'bundle creation and inspection preserve complete release file content',
    async function completeBundleContent(t) {
        const selected = await fixture(t);
        const outputPath = path.join(selected.root, 'moon-archive.arcane-app.tar.gz');
        const created = await createAppReleaseBundle(
            {
                releaseRoot: selected.releaseRoot,
                appDescriptor: selected.descriptor,
                outputPath
            }
        );
        assert.equal(created.bundlePath, outputPath);
        assert.equal(created.manifest.kind, APP_BUNDLE_KIND);
        assert.equal(created.manifest.format, APP_BUNDLE_FORMAT);
        assert.equal(created.manifest.descriptor, APP_BUNDLE_DESCRIPTOR_NAME);
        assert.equal(created.manifest.release, APP_BUNDLE_RELEASE_PATH);

        const inspected = await verifyAppReleaseBundle(
            {bundlePath: outputPath}
        );
        assert.equal(inspected.verified, true);
        assert.equal(
            inspected.readFile('payload/content/complete.txt').toString('utf8'),
            selected.complete
        );
        assert.equal(inspected.manifest.kind, APP_BUNDLE_KIND);
        assert.deepEqual(inspected.files, created.files);
        const archive = gunzipSync(await readFile(outputPath));
        const records = archiveRecords(archive);
        assert.ok(
            records.every(
                function ordinaryUstarEntry(record) {
                    return record.header[156] === 0x30;
                }
            )
        );
        assert.deepEqual(
            records[0].header,
            createCanonicalUstarHeader(APP_BUNDLE_MANIFEST_NAME, records[0].content.length)
        );
        assert.equal(inspected.manifest.schemaVersion, 1);
        assert.equal(inspected.manifest.format, 'ustar+gzip');
    }
);

test(
    'PAX paths round-trip complete long and Unicode filenames without changing the following entry',
    async function completePaxPaths(t) {
        const longName = `content/aa-${'a'.repeat(105)}.txt`;
        const deepPath = `content/${'d'.repeat(70)}/${'e'.repeat(70)}/${'f'.repeat(70)}/testimony.txt`;
        const unicodePath = 'content/bibliothèque/資料-🌙.txt';
        const selected = await fixture(
            t,
            [
                [longName, '  Complete long filename testimony.\nSecond line.  '],
                [deepPath, '  Every directory segment survives.  '],
                [unicodePath, '  La lune garde chaque mot. 月の記録 🌙\n']
            ]
        );
        const outputPath = path.join(selected.root, 'complete-paths.arcane-app.tar.gz');
        const created = await createAppReleaseBundle(
            {
                releaseRoot: selected.releaseRoot,
                appDescriptor: selected.descriptor,
                outputPath
            }
        );
        const inspected = await verifyAppReleaseBundle(
            {bundlePath: outputPath}
        );
        assert.deepEqual(inspected.files, created.files);
        for (const [relative, content] of selected.files) {
            assert.equal(inspected.readFile(`payload/${relative}`).toString('utf8'), content, relative);
        }
        assert.equal(inspected.manifest.format, 'ustar+gzip');
        const records = archiveRecords(gunzipSync(await readFile(outputPath)));
        const extended = records.filter(
            function extendedHeader(record) {
                return record.header[156] === 0x78;
            }
        );
        for (const relative of [longName, deepPath, unicodePath]) {
            assert.ok(
                extended.some(
                    function completePath(record) {
                        return record.content.equals(paxPathRecord(`payload/${relative}`));
                    }
                ),
                relative
            );
        }
        assert.equal(
            inspected.files.some(
                function metadataPayload(relative) {
                    return relative.startsWith('PaxHeaders/');
                }
            ),
            false
        );
        // Both ordinary files follow an extended path in the writer's sorted payload.
        assert.equal(inspected.readFile('payload/content/complete.txt').toString('utf8'), selected.complete);
        assert.equal(inspected.readFile('payload/index.html').toString('utf8'), selected.files.get('index.html'));
    }
);

test(
    'malformed and orphaned PAX metadata reports an archive diagnosis',
    async function invalidPaxRecords(t) {
        const selected = await fixture(t);
        const outputPath = path.join(selected.root, 'ordinary.arcane-app.tar.gz');
        await createAppReleaseBundle(
            {
                releaseRoot: selected.releaseRoot,
                appDescriptor: selected.descriptor,
                outputPath
            }
        );
        const archive = gunzipSync(await readFile(outputPath));
        const malformed = [
            Buffer.from('0 path=payload/no-file.txt\n'),
            Buffer.from('99 path=payload/no-file.txt\n'),
            Buffer.from('missing-length path=payload/no-file.txt\n')
        ];
        for (const [index, content] of malformed.entries()) {
            const malformedPath = path.join(selected.root, `malformed-pax-${index}.tar.gz`);
            await writeFile(
                malformedPath,
                gzipSync(
                    Buffer.concat(
                        [paxArchiveEntry(content), archive]
                    )
                )
            );
            await assert.rejects(
                verifyAppReleaseBundle(
                    {bundlePath: malformedPath}
                ),
                function diagnosedPax(error) {
                    assert.equal(error.code, 'ARCANE_BUNDLE_INVALID');
                    assert.match(error.message, /PAX/iu);
                    return true;
                }
            );
        }
        const records = archiveRecords(archive);
        const orphanPath = path.join(selected.root, 'orphaned-pax.tar.gz');
        await writeFile(
            orphanPath,
            gzipSync(
                Buffer.concat(
                    [
                        archive.subarray(0, records.at(-1).end),
                        paxArchiveEntry(paxPathRecord('payload/orphaned.txt')),
                        Buffer.alloc(1024)
                    ]
                )
            )
        );
        await assert.rejects(
            verifyAppReleaseBundle(
                {bundlePath: orphanPath}
            ),
            function diagnosedOrphan(error) {
                assert.equal(error.code, 'ARCANE_BUNDLE_INVALID');
                assert.match(error.message, /PAX/iu);
                return true;
            }
        );
    }
);

test(
    'bundle path and ustar helpers keep only package-format constraints',
    function canonicalUstarHelper() {
        assert.equal(validateAppBundlePath('payload/content/complete.txt'), 'payload/content/complete.txt');
        assert.throws(
            function outsidePath() {
                validateAppBundlePath('../outside');
            },
            /Unsafe/u
        );
        const header = createCanonicalUstarHeader(APP_BUNDLE_MANIFEST_NAME, 0);
        assert.equal(Buffer.isBuffer(header), true);
        assert.equal(header.length, 512);
        assert.equal(header.subarray(257, 262).toString('ascii'), 'ustar');
        assert.equal(header[156], 0x30);
    }
);

import assert from 'node:assert/strict';

import test from '../src/testing.mjs';
import {
    createBrowserModelSource,
    createDbopfsModelStore
} from '../browser-runtime/ai/browser-wasm-llm-provider.mjs';

const RANGE_TOTAL = 40_000_000;
const RANGE_PART_LENGTH = 4_000_000;
const FAILED_RANGE = 'bytes=12000000-15999999';

function missingEntry(name) {
    const error = new Error(`Missing ${name}.`);
    error.name = 'NotFoundError';
    return error;
}

function deferred() {
    let resolvePromise;
    const promise = new Promise(function retainDeferredResolve(resolve) {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve: resolvePromise
    };
}

class LogicalChunk extends Uint8Array {
    #logicalByteLength;

    constructor(logicalByteLength) {
        super(1);
        this.#logicalByteLength = logicalByteLength;
    }

    get byteLength() {
        return this.#logicalByteLength;
    }
}

function logicalBlob(logicalByteLength) {
    const blob = new Blob([Uint8Array.of(0)]);
    Object.defineProperty(
        blob,
        'size',
        {
            value: logicalByteLength
        }
    );
    return blob;
}

function persistedModelName(modelId, fileName) {
    const encoded = Array.from(
        new TextEncoder().encode(modelId),
        function encodeStorageByte(value) {
            return value.toString(16).padStart(2, '0');
        }
    ).join('');
    return `id-${encoded}--${fileName}`;
}

function persistedRangeName(modelName, start, end, total) {
    return `${modelName}.range-${String(start)}-${String(end)}-of-${String(total)}.part`;
}

function memoryDirectory() {
    const entries = new Map();

    function fileHandle(name) {
        return {
            async createWritable() {
                let logicalByteLength = 0;
                return {
                    async abort() {},
                    async close() {
                        entries.set(name, logicalBlob(logicalByteLength));
                    },
                    async write(value) {
                        logicalByteLength += value.byteLength;
                    }
                };
            },
            async getFile() {
                return entries.get(name) ?? new Blob([]);
            }
        };
    }

    const table = {
        async *entries() {
            for (const name of entries.keys()) {
                yield [name, fileHandle(name)];
            }
        },
        async getFileHandle(name, {create = false} = {}) {
            if (!entries.has(name) && !create) {
                throw missingEntry(name);
            }
            if (!entries.has(name)) {
                entries.set(name, null);
            }
            return fileHandle(name);
        },
        async removeEntry(name) {
            if (!entries.delete(name)) {
                throw missingEntry(name);
            }
        }
    };

    return {
        names() {
            return [...entries.entries()]
                .filter(function retainClosedEntry(entry) {
                    return entry[1] !== null;
                })
                .map(function projectEntryName(entry) {
                    return entry[0];
                });
        },
        put(name, logicalByteLength) {
            entries.set(name, logicalBlob(logicalByteLength));
        },
        table
    };
}

function storeFor(directory) {
    return createDbopfsModelStore(
        {
            dbopfs: {
                readyPromise: Promise.resolve(),
                async getTableHandle() {
                    return directory.table;
                }
            },
            downloadConcurrency: 4
        }
    );
}

function readableBody(logicalByteLength, waitForRelease = null) {
    let cancelled = false;
    let delivered = false;

    const reader = {
        async cancel() {
            cancelled = true;
        },
        async read() {
            if (waitForRelease) {
                await waitForRelease;
            }
            if (cancelled || delivered) {
                return {
                    done: true,
                    value: undefined
                };
            }
            delivered = true;
            return {
                done: false,
                value: new LogicalChunk(logicalByteLength)
            };
        },
        releaseLock() {}
    };

    return {
        async cancel(reason) {
            await reader.cancel(reason);
        },
        getReader() {
            return reader;
        }
    };
}

function partiallyFailingBody(logicalByteLength, onFailure) {
    let cancelled = false;
    let delivered = false;

    const reader = {
        async cancel() {
            cancelled = true;
        },
        async read() {
            if (cancelled) {
                return {
                    done: true,
                    value: undefined
                };
            }
            if (!delivered) {
                delivered = true;
                return {
                    done: false,
                    value: new LogicalChunk(logicalByteLength)
                };
            }
            onFailure();
            throw new TypeError('Synthetic partial range network failure.');
        },
        releaseLock() {}
    };

    return {
        async cancel(reason) {
            await reader.cancel(reason);
        },
        getReader() {
            return reader;
        }
    };
}

function responseHeaders(values) {
    return {
        get(name) {
            return values[String(name).toLowerCase()] ?? null;
        }
    };
}

function rangeResponse(url, range, body, total = RANGE_TOTAL) {
    const match = /^bytes=([0-9]+)-([0-9]+)$/u.exec(range);
    const start = Number(match[1]);
    const end = Number(match[2]);
    return {
        body,
        headers: responseHeaders(
            {
                'content-range': `bytes ${String(start)}-${String(end)}/${String(total)}`
            }
        ),
        ok: true,
        status: 206,
        url
    };
}

function completeResponse(url, body) {
    return {
        body,
        headers: responseHeaders(
            {
                'content-length': '1'
            }
        ),
        ok: true,
        status: 200,
        url
    };
}

function scheduleRelease(release) {
    setTimeout(
        function releaseSuccessfulTransfers() {
            release();
        },
        0
    );
}

function countValues(values) {
    const counts = new Map();
    for (const value of values) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return counts;
}

test(
    'browser-WASM range retry preserves successful peers and fetches only the failed part',
    async function preserveSuccessfulRangePeers() {
        const directory = memoryDirectory();
        const releaseFirstPeers = deferred();
        const requests = [];
        let injectFailure = true;
        let partialFailureWasRead = false;
        const url = 'https://example.invalid/models/resumable/model.gguf';
        const source = createBrowserModelSource(
            {
                id: 'resumable-range-model',
                files: [{
                    bytes: RANGE_TOTAL,
                    name: 'model.gguf',
                    url
                }]
            },
            {
                async fetchImpl(requestUrl, options = {}) {
                    const range = options.headers?.Range ?? null;
                    requests.push(range);
                    if (range === 'bytes=0-0') {
                        return rangeResponse(
                            requestUrl,
                            range,
                            readableBody(1)
                        );
                    }
                    if (range === FAILED_RANGE && injectFailure) {
                        injectFailure = false;
                        return rangeResponse(
                            requestUrl,
                            range,
                            partiallyFailingBody(
                                RANGE_PART_LENGTH / 2,
                                function failPartialRangeBody() {
                                    partialFailureWasRead = true;
                                    scheduleRelease(releaseFirstPeers.resolve);
                                }
                            )
                        );
                    }
                    const match = /^bytes=([0-9]+)-([0-9]+)$/u.exec(range);
                    const logicalByteLength = Number(match[2]) - Number(match[1]) + 1;
                    return rangeResponse(
                        requestUrl,
                        range,
                        readableBody(
                            logicalByteLength,
                            injectFailure ? releaseFirstPeers.promise : null
                        )
                    );
                }
            }
        );
        const store = storeFor(directory);

        await assert.rejects(
            store.ensure(source),
            function isRangeDownloadFailure(error) {
                return error?.code === 'ARCANE_AI_MODEL_DOWNLOAD_FAILED';
            }
        );
        assert.equal(partialFailureWasRead, true);

        const firstRangeRequests = requests.filter(function retainDataRange(range) {
            return range !== 'bytes=0-0';
        });
        assert.equal(firstRangeRequests.length, 10);
        assert.ok(firstRangeRequests.every(function usesSmallRestartUnit(range) {
            const match = /^bytes=([0-9]+)-([0-9]+)$/u.exec(range);
            return Number(match[2]) - Number(match[1]) + 1 <= RANGE_PART_LENGTH;
        }));
        assert.equal(
            directory.names().filter(function retainRangePart(name) {
                return name.endsWith('.part');
            }).length,
            9
        );

        const retryProgress = [];
        const installed = await store.ensure(
            source,
            {
                onProgress(progress) {
                    retryProgress.push(progress);
                }
            }
        );
        const rangeRequestCounts = countValues(
            requests.filter(function retainDataRange(range) {
                return range !== 'bytes=0-0';
            })
        );
        assert.equal(installed.cache, 'installed');
        assert.equal(rangeRequestCounts.get(FAILED_RANGE), 2);
        for (const range of firstRangeRequests) {
            if (range === FAILED_RANGE) {
                continue;
            }
            assert.equal(rangeRequestCounts.get(range), 1);
        }
        assert.equal(
            retryProgress.some(function observedRestoredRangeProgress(progress) {
                return progress.phase === 'download'
                    && progress.loadedBytes === 36_000_000
                    && progress.totalBytes === RANGE_TOTAL
                    && progress.remainingBytes === 4_000_000
                    && progress.transferLimit === 4
                    && progress.transferMode === 'ranges';
            }),
            true
        );

        const cached = await store.ensure(
            source,
            {
                offline: true
            }
        );
        assert.equal(cached.cache, 'cached');
    }
);

test(
    'browser-WASM shard retry preserves successful files and fetches only the failed shard',
    async function preserveSuccessfulShardPeers() {
        const directory = memoryDirectory();
        const releaseFirstPeers = deferred();
        const requests = [];
        const failedName = 'model-00004-of-00004.gguf';
        let injectFailure = true;
        const files = [1, 2, 3, 4].map(function createShardDescriptor(index) {
            const sequence = String(index).padStart(5, '0');
            const name = `model-${sequence}-of-00004.gguf`;
            return {
                bytes: 1,
                name,
                url: `https://example.invalid/models/resumable/${name}`
            };
        });
        const source = createBrowserModelSource(
            {
                files,
                id: 'resumable-shard-model'
            },
            {
                async fetchImpl(url) {
                    const name = new URL(url).pathname.split('/').at(-1);
                    requests.push(name);
                    if (name === failedName && injectFailure) {
                        injectFailure = false;
                        scheduleRelease(releaseFirstPeers.resolve);
                        throw new TypeError('Synthetic shard network failure.');
                    }
                    return completeResponse(
                        url,
                        readableBody(
                            1,
                            injectFailure ? releaseFirstPeers.promise : null
                        )
                    );
                }
            }
        );
        const store = storeFor(directory);

        await assert.rejects(
            store.ensure(source),
            function isShardDownloadFailure(error) {
                return error?.code === 'ARCANE_AI_MODEL_DOWNLOAD_FAILED';
            }
        );
        assert.equal(directory.names().filter(function retainWholeFile(name) {
            return name.endsWith('.gguf');
        }).length, 3);

        const retryProgress = [];
        const installed = await store.ensure(
            source,
            {
                onProgress(progress) {
                    retryProgress.push(progress);
                }
            }
        );
        const requestCounts = countValues(requests);
        assert.equal(installed.cache, 'installed');
        assert.equal(requestCounts.get(failedName), 2);
        for (const file of files) {
            if (file.name === failedName) {
                continue;
            }
            assert.equal(requestCounts.get(file.name), 1);
        }
        assert.equal(
            retryProgress.some(function observedRestoredShardProgress(progress) {
                return progress.phase === 'download'
                    && progress.completed === 3
                    && progress.loadedBytes === 3;
            }),
            true
        );
    }
);

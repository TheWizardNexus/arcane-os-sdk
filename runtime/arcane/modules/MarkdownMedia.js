import Is from 'strong-type';

const is = new Is(false);
const referencePrefix = 'arcane-media:';

/** Return the local record address, or null for an ordinary image URL. */
export function parseMarkdownMediaReference(reference) {
    if (!is.string(reference) || !reference.startsWith(referencePrefix)) {
        return null;
    }
    const address = reference.substring(referencePrefix.length);
    const separator = address.indexOf('/');
    if (separator < 0) {
        throw new TypeError('A Markdown media reference needs a table and filename.');
    }
    return {
        tableName: decodeURIComponent(address.substring(0, separator)),
        fileName: decodeURIComponent(address.substring(separator + 1))
    };
}

/**
 * Save a complete image in the app's existing DBOPFS database. The returned
 * reference belongs in Markdown; the JSON-compatible record belongs in its
 * separate table so the existing database backup can include it unchanged.
 * Applications own filename reuse, entry association, and export selection.
 * The promise settles the durable write; this operation has no abort option.
 */
export async function saveMarkdownMedia({
    blob,
    tableName = 'markdown-media',
    fileName = `${crypto.randomUUID()}.json`
}) {
    const reference = `${referencePrefix}${encodeURIComponent(tableName)}/${encodeURIComponent(fileName)}`;
    const encoding = new Promise(function encodeImage(resolve, reject) {
        const reader = new FileReader();
        reader.onload = function imageEncoded() {
            resolve(reader.result);
        };
        reader.onerror = function imageEncodingFailed() {
            reject(reader.error || new Error('Image encoding failed.'));
        };
        reader.onabort = function imageEncodingAborted() {
            reject(new DOMException('Image encoding was aborted.', 'AbortError'));
        };
        reader.readAsDataURL(blob);
    });
    const [dataUrl, {default: DBOPFS}] = await Promise.all([
        encoding,
        import('./DBOPFS.js')
    ]);
    const mediaType = blob.type || 'application/octet-stream';
    await new DBOPFS().set(tableName, fileName, {mediaType, dataUrl});
    return {
        reference,
        tableName,
        fileName,
        mediaType
    };
}

/** Read the complete local image for display or application-owned export. */
export async function readMarkdownMedia(reference) {
    const address = parseMarkdownMediaReference(reference);
    if (!address) {
        throw new TypeError('Expected an arcane-media: reference.');
    }
    const {default: DBOPFS} = await import('./DBOPFS.js');
    const stored = await new DBOPFS().get(address.tableName, address.fileName);
    if (stored === null || stored === undefined) {
        throw new DOMException(`Markdown image was not found: ${reference}`, 'NotFoundError');
    }
    // DBOPFS parses JSONL/NDJSON as record arrays; restoring a parsed backup can
    // wrap its one record again. Never choose one image from multiple records.
    let record = is.string(stored) ? JSON.parse(stored) : stored;
    while (is.array(record) && record.length === 1) record = record[0];
    const encoded = /^data:[^,]*;base64,([\s\S]*)$/u.exec(record?.dataUrl);
    if (!encoded) {
        throw new TypeError(`Markdown image has an unreadable data URL: ${reference}`);
    }
    // Decode locally; a stored string is never passed to Fetch or a network API.
    const decoded = atob(encoded[1]);
    const content = Uint8Array.from(decoded, function imageCharacter(character) {
        return character.charCodeAt(0);
    });
    return new Blob([content], {type: record.mediaType});
}

/**
 * Resolve only local Markdown IMG references beneath a rendered root (including
 * an IMG root). Markdown source and ordinary URLs are never changed. Independent
 * reads start together; ready waits for decoding or display cancellation.
 * Failures reject with AggregateError.failures [{image, reference, reason}];
 * successful siblings remain visible until their owner is destroyed.
 *
 * destroy() prevents late assignments and releases owned object URLs. A print
 * owner calls retain() before copying the rendered DOM and releases its returned
 * idempotent callback after printing, allowing URLs to outlive the source view.
 * Abort promptly rejects display readiness. An already-started DBOPFS read
 * remains observed and settles independently; its late result is not displayed.
 */
export function hydrateMarkdownMedia(root, {signal} = {}) {
    const images = [...root.querySelectorAll('img')];
    if (root.localName === 'img') images.unshift(root);
    const owned = [];
    const displayCancellations = new Set();
    let destroyed = false;
    let retainers = 0;
    let destructionReason;

    function releaseURLs() {
        if (!destroyed || retainers > 0) return;
        for (const {image, url} of owned) {
            if (image.getAttribute('src') === url) image.removeAttribute('src');
            URL.revokeObjectURL(url);
        }
        owned.length = 0;
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        destructionReason = signal?.aborted
            ? signal.reason
            : new DOMException('Markdown media display was destroyed.', 'AbortError');
        signal?.removeEventListener('abort', destroy);
        for (const cancel of displayCancellations) cancel();
        displayCancellations.clear();
        releaseURLs();
    }

    function retain() {
        if (destroyed) throw destructionReason;
        retainers += 1;
        let released = false;
        return function releaseMarkdownMedia() {
            if (released) return;
            released = true;
            retainers -= 1;
            releaseURLs();
        };
    }

    function waitForDisplay(operation) {
        return new Promise(function observeDisplayOperation(resolve, reject) {
            let settled = false;
            function settle(callback, value) {
                if (settled) return;
                settled = true;
                displayCancellations.delete(cancelDisplay);
                callback(value);
            }
            function cancelDisplay() {
                settle(reject, destructionReason);
            }
            displayCancellations.add(cancelDisplay);
            // Both outcomes remain observed after display cancellation; this
            // wait does not claim to cancel the underlying storage or decode.
            Promise.resolve(operation).then(
                function displayOperationFinished(value) {settle(resolve, value);},
                function displayOperationFailed(error) {settle(reject, error);}
            );
            if (destroyed) cancelDisplay();
        });
    }

    async function loadImage(image, reference) {
        if (destroyed) throw destructionReason;
        const blob = await waitForDisplay(readMarkdownMedia(reference));
        if (destroyed) throw destructionReason;
        const url = URL.createObjectURL(blob);
        owned.push({image, url});
        image.setAttribute('src', url);
        await waitForDisplay(image.decode());
        if (destroyed) throw destructionReason;
    }

    signal?.addEventListener('abort', destroy, {once: true});
    if (signal?.aborted) destroy();
    const pending = [];
    for (const image of images) {
        const reference = image.getAttribute('src');
        if (!is.string(reference) || !reference.startsWith(referencePrefix)) continue;
        // Remove the custom scheme before the first asynchronous storage wait.
        if (!destroyed) image.removeAttribute('src');
        pending.push({image, reference, operation: loadImage(image, reference)});
    }
    const ready = Promise.allSettled(pending.map(function imageOperation(item) {
        return item.operation;
    })).then(function imagesSettled(results) {
        const failures = [];
        for (const [index, result] of results.entries()) {
            if (result.status === 'rejected') {
                failures.push({
                    image: pending[index].image,
                    reference: pending[index].reference,
                    reason: result.reason
                });
            }
        }
        if (failures.length > 0) {
            const error = new AggregateError(failures.map(function imageFailure(failure) {
                return failure.reason;
            }), 'Some local Markdown images could not be displayed.');
            error.failures = failures;
            throw error;
        }
        if (destroyed) throw destructionReason;
    });
    return {ready, destroy, retain};
}

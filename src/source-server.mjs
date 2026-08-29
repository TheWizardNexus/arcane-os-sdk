import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';

const MIME_TYPES = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.gif', 'image/gif'],
    ['.gguf', 'application/octet-stream'],
    ['.html', 'text/html; charset=utf-8'],
    ['.ico', 'image/x-icon'],
    ['.jpeg', 'image/jpeg'],
    ['.jpg', 'image/jpeg'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.map', 'application/json; charset=utf-8'],
    ['.md', 'text/markdown; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.modelfile', 'text/plain; charset=utf-8'],
    ['.mp3', 'audio/mpeg'],
    ['.ogg', 'audio/ogg'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml; charset=utf-8'],
    ['.txt', 'text/plain; charset=utf-8'],
    ['.wasm', 'application/wasm'],
    ['.wav', 'audio/wav'],
    ['.webmanifest', 'application/manifest+json; charset=utf-8'],
    ['.webp', 'image/webp'],
    ['.woff', 'font/woff'],
    ['.woff2', 'font/woff2']
]);

function fail(message, code = 'ARCANE_SOURCE_SERVER_OPTIONS_INVALID') {
    const error = new Error(message);
    error.code = code;
    throw error;
}

function throwIfAborted(signal) {
    if (!signal?.aborted) {
        return;
    }
    if (signal.reason instanceof Error) {
        throw signal.reason;
    }
    const error = new Error('Source server start cancelled.');
    error.code = 'ARCANE_CANCELLED';
    throw error;
}

function normalizeHost(value) {
    const host = String(value ?? '127.0.0.1').trim();
    if (!host) {
        fail('Source server host must be a nonempty string.');
    }
    return host;
}

function normalizePort(value) {
    const port = Number(value ?? 0);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        fail('Source server port must be an integer from 0 through 65535.');
    }
    return port;
}

function pathSegments(value, fieldName) {
    const text = String(value);
    if (!text || text.includes('\\') || /[\x00-\x1f\x7f]/u.test(text)) {
        fail(`${fieldName} must use a nonempty URL path without control characters or backslashes.`);
    }
    const segments = text.split('/');
    if (segments.some(function invalidSegment(segment) {
        return !segment || segment === '.' || segment === '..';
    })) {
        fail(`${fieldName} contains an invalid URL path segment.`);
    }
    return segments;
}

function normalizeUrlPath(value, fieldName, preserveTrailingSlash = false) {
    const raw = String(value ?? '/');
    if (!raw.startsWith('/') || raw.includes('?') || raw.includes('#')) {
        fail(`${fieldName} must be an absolute URL path without a query or fragment.`);
    }
    if (raw === '/') {
        return raw;
    }
    const hasTrailingSlash = raw.endsWith('/');
    const content = hasTrailingSlash ? raw.slice(1, -1) : raw.slice(1);
    const normalized = `/${pathSegments(content, fieldName).join('/')}`;
    return preserveTrailingSlash && hasTrailingSlash ? `${normalized}/` : normalized;
}

function normalizeRelativePath(value, fieldName, allowDirectory = false) {
    const raw = String(value ?? '');
    if (!raw || raw.startsWith('/') || raw.includes('?') || raw.includes('#')) {
        fail(`${fieldName} must be a nonempty relative URL path.`);
    }
    const directory = allowDirectory && raw.endsWith('/');
    const content = directory ? raw.slice(0, -1) : raw;
    const normalized = pathSegments(content, fieldName).join('/');
    return directory ? `${normalized}/` : normalized;
}

function normalizeRoot(value, fieldName) {
    if (value instanceof URL) {
        if (value.protocol !== 'file:') {
            fail(`${fieldName} URL must use the file: protocol.`);
        }
        return path.resolve(fileURLToPath(value));
    }
    if (typeof value !== 'string' || !value.trim()) {
        fail(`${fieldName} must be a filesystem path or file URL.`);
    }
    return path.resolve(value);
}

function normalizeInclude(value, fieldName) {
    if (value === undefined) {
        return null;
    }
    if (!Array.isArray(value)) {
        fail(`${fieldName} must be an array when supplied.`);
    }
    return value.map(function normalizeEntry(entry, index) {
        return normalizeRelativePath(entry, `${fieldName}[${index}]`, true);
    });
}

function normalizeMount(value, index) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(`mounts[${index}] must be an object.`);
    }
    if (value.urlPath === undefined) {
        fail(`mounts[${index}].urlPath is required.`);
    }
    return {
        urlPath: normalizeUrlPath(value.urlPath, `mounts[${index}].urlPath`),
        root: normalizeRoot(value.root, `mounts[${index}].root`),
        index: value.index === undefined
            ? null
            : normalizeRelativePath(value.index, `mounts[${index}].index`),
        include: normalizeInclude(value.include, `mounts[${index}].include`)
    };
}

function normalizeMounts(value) {
    if (!Array.isArray(value) || value.length === 0) {
        fail('Source server mounts must be a nonempty array.');
    }
    const mounts = value.map(normalizeMount);
    const seen = new Set();
    for (const mount of mounts) {
        if (seen.has(mount.urlPath)) {
            fail(`Source server mount URL path is duplicated: ${mount.urlPath}`);
        }
        seen.add(mount.urlPath);
    }
    return mounts.slice().sort(function longestUrlPathFirst(left, right) {
        return right.urlPath.length - left.urlPath.length;
    });
}

function parseRequestPath(rawUrl) {
    let parsed;
    try {
        parsed = new URL(String(rawUrl || '/'), 'http://localhost');
    }
    catch {
        return null;
    }
    let decoded;
    try {
        decoded = decodeURIComponent(parsed.pathname);
    }
    catch {
        return null;
    }
    if (!decoded.startsWith('/') || decoded.includes('\\')
        || /[\x00-\x1f\x7f]/u.test(decoded)) {
        return null;
    }
    if (decoded !== '/' && decoded.split('/').some(function invalidSegment(segment, index) {
        if (index === 0 || (index === decoded.split('/').length - 1 && !segment)) {
            return false;
        }
        return !segment || segment === '.' || segment === '..';
    })) {
        return null;
    }
    return decoded;
}

function mountForPath(mounts, requestPath) {
    return mounts.find(function matchesMount(mount) {
        return mount.urlPath === '/'
            || requestPath === mount.urlPath
            || requestPath.startsWith(`${mount.urlPath}/`);
    }) || null;
}

function relativePathForRequest(mount, requestPath) {
    const offset = mount.urlPath === '/' ? 1 : mount.urlPath.length;
    let relativePath = requestPath.slice(offset);
    if (relativePath.startsWith('/')) {
        relativePath = relativePath.slice(1);
    }
    if (!relativePath || relativePath.endsWith('/')) {
        if (!mount.index) {
            return null;
        }
        relativePath = `${relativePath}${mount.index}`;
    }
    return relativePath;
}

function includedByMount(mount, relativePath) {
    if (mount.include === null) {
        return true;
    }
    return mount.include.some(function matchesInclude(entry) {
        return entry.endsWith('/')
            ? relativePath.startsWith(entry)
            : relativePath === entry;
    });
}

function resolveMountedPath(mount, relativePath) {
    const candidate = path.resolve(mount.root, ...relativePath.split('/'));
    const relative = path.relative(mount.root, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)) {
        return null;
    }
    return candidate;
}

async function regularFile(filePath) {
    try {
        const information = await stat(filePath);
        return information.isFile() ? information : null;
    }
    catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
            return null;
        }
        throw error;
    }
}

function contentType(filePath) {
    return MIME_TYPES.get(path.extname(filePath).toLowerCase())
        || 'application/octet-stream';
}

function responseHeaders(settings) {
    const headers = {
        'cache-control': 'no-cache'
    };
    if (settings.crossOriginIsolated) {
        headers['cross-origin-opener-policy'] = 'same-origin';
        headers['cross-origin-embedder-policy'] = 'require-corp';
    }
    return headers;
}

function sendText(response, method, status, message, headers = {}) {
    response.writeHead(status, {
        ...headers,
        'content-type': 'text/plain; charset=utf-8'
    });
    response.end(method === 'HEAD' ? undefined : `${message}\n`);
}

function parseRange(value, size) {
    if (value === undefined) {
        return null;
    }
    if (typeof value !== 'string' || size === 0) {
        return false;
    }
    const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
    if (!match || (!match[1] && !match[2])) {
        return false;
    }
    let start;
    let end;
    if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
            return false;
        }
        start = Math.max(0, size - suffixLength);
        end = size - 1;
    }
    else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
            || start < 0 || end < start || start >= size) {
            return false;
        }
        end = Math.min(end, size - 1);
    }
    return {start, end};
}

async function streamFile(request, response, filePath, information, settings) {
    const range = parseRange(request.headers.range, information.size);
    if (range === false) {
        sendText(response, request.method, 416, 'Range Not Satisfiable', {
            ...responseHeaders(settings),
            'accept-ranges': 'bytes',
            'content-range': `bytes */${information.size}`
        });
        return;
    }
    const headers = {
        ...responseHeaders(settings),
        'accept-ranges': 'bytes',
        'content-type': contentType(filePath)
    };
    let status = 200;
    let streamOptions;
    if (range) {
        status = 206;
        headers['content-range'] = `bytes ${range.start}-${range.end}/${information.size}`;
        headers['content-length'] = range.end - range.start + 1;
        streamOptions = range;
    }
    else {
        headers['content-length'] = information.size;
    }
    response.writeHead(status, headers);
    if (request.method === 'HEAD') {
        response.end();
        return;
    }
    await pipeline(createReadStream(filePath, streamOptions), response);
}

async function publishEvent(onEvent, type, detail) {
    if (typeof onEvent !== 'function') {
        return;
    }
    try {
        await onEvent({type, at: new Date().toISOString(), ...detail});
    }
    catch (error) {
        console.error('[arcane source server] Event listener failed.', error);
    }
}

async function serveRequest(request, response, settings) {
    const method = String(request.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
        sendText(response, method, 405, 'Method Not Allowed', {
            ...responseHeaders(settings),
            allow: 'GET, HEAD'
        });
        return;
    }
    const requestPath = parseRequestPath(request.url);
    if (!requestPath) {
        sendText(response, method, 400, 'Bad Request', responseHeaders(settings));
        return;
    }
    if (requestPath === '/' && settings.startPath !== '/') {
        response.writeHead(302, {
            ...responseHeaders(settings),
            location: settings.startPath
        });
        response.end();
        return;
    }
    const mount = mountForPath(settings.mounts, requestPath);
    const relativePath = mount ? relativePathForRequest(mount, requestPath) : null;
    if (!mount || !relativePath || !includedByMount(mount, relativePath)) {
        sendText(response, method, 404, 'Not Found', responseHeaders(settings));
        return;
    }
    const filePath = resolveMountedPath(mount, relativePath);
    const information = filePath ? await regularFile(filePath) : null;
    if (!information) {
        sendText(response, method, 404, 'Not Found', responseHeaders(settings));
        return;
    }
    await streamFile(request, response, filePath, information, settings);
}

function createRequestListener(settings) {
    return async function sourceServerRequest(request, response) {
        try {
            await serveRequest(request, response, settings);
        }
        catch (error) {
            console.error('[arcane source server] Request failed.', error);
            await publishEvent(settings.onEvent, 'source-server.request.failed', {
                method: request.method,
                url: request.url,
                error
            });
            if (response.headersSent) {
                response.destroy(error);
                return;
            }
            sendText(response, request.method, 500, 'Internal Server Error',
                responseHeaders(settings));
        }
    };
}

function createServer(settings) {
    const listener = createRequestListener(settings);
    if (settings.tls === undefined || settings.tls === null || settings.tls === false) {
        return http.createServer(listener);
    }
    if (typeof settings.tls !== 'object' || Array.isArray(settings.tls)) {
        fail('Source server tls must be a Node HTTPS options object when supplied.');
    }
    return https.createServer(settings.tls, listener);
}

function listen(server, host, port, onOperationalError) {
    return new Promise(function settleListen(resolve, reject) {
        let listening = false;
        function cleanupBeforeListening() {
            server.off('error', onError);
            server.off('listening', onListening);
        }
        function onError(error) {
            if (listening) {
                onOperationalError(error);
                return;
            }
            cleanupBeforeListening();
            reject(error);
        }
        function onListening() {
            listening = true;
            server.off('listening', onListening);
            resolve(onError);
        }
        server.on('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });
}

function urlHostname(host) {
    const publicHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    return publicHost.includes(':') ? `[${publicHost}]` : publicHost;
}

function closeFunction(server) {
    let activeClose = null;
    return function close() {
        if (activeClose) {
            return activeClose;
        }
        if (!server.listening) {
            return Promise.resolve();
        }
        activeClose = new Promise(function settleClose(resolve, reject) {
            server.close(function onClosed(error) {
                if (error) {
                    activeClose = null;
                    reject(error);
                    return;
                }
                resolve();
            });
        });
        return activeClose;
    };
}

export async function startSourceExampleServer(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        fail('Source server options must be an object.');
    }
    if (options.signal && (typeof options.signal.addEventListener !== 'function'
        || typeof options.signal.removeEventListener !== 'function')) {
        fail('Source server signal must be an AbortSignal when supplied.');
    }
    throwIfAborted(options.signal);
    const settings = {
        mounts: normalizeMounts(options.mounts),
        startPath: normalizeUrlPath(options.startPath ?? '/', 'startPath', true),
        host: normalizeHost(options.host),
        port: normalizePort(options.port),
        crossOriginIsolated: options.crossOriginIsolated === true,
        tls: options.tls,
        onEvent: options.onEvent
    };
    const server = createServer(settings);
    const close = closeFunction(server);
    let operationalError = null;
    let serverErrorListener = null;
    let abortListener = null;
    let settleClosed;
    let rejectClosed;
    const closed = new Promise(function waitForClose(resolve, reject) {
        settleClosed = resolve;
        rejectClosed = reject;
    });
    closed.catch(function retainObservableLifecycle() {
        return undefined;
    });
    server.once('close', function observeClose() {
        if (serverErrorListener) {
            server.off('error', serverErrorListener);
        }
        if (abortListener) {
            options.signal.removeEventListener('abort', abortListener);
        }
        if (operationalError) {
            rejectClosed(operationalError);
            return;
        }
        settleClosed();
    });
    function reportOperationalError(error) {
        operationalError = operationalError || error;
        console.error('[arcane source server] Server failed.', error);
        publishEvent(settings.onEvent, 'source-server.failed', {error})
            .catch(function reportEventFailure(eventError) {
                console.error('[arcane source server] Failure event could not be reported.',
                    eventError);
            });
        close().catch(function reportOperationalCloseFailure(closeError) {
            console.error('[arcane source server] Failure close failed.', closeError);
        });
    }
    await publishEvent(settings.onEvent, 'source-server.starting', {
        host: settings.host,
        port: settings.port
    });
    throwIfAborted(options.signal);
    serverErrorListener = await listen(server, settings.host, settings.port,
        reportOperationalError);
    const address = server.address();
    if (!address || typeof address === 'string') {
        await new Promise(function closeUnknownAddress(resolve) {
            server.close(resolve);
        });
        fail('Source server did not expose a TCP address.', 'ARCANE_SOURCE_SERVER_ADDRESS_UNAVAILABLE');
    }
    const protocol = settings.tls ? 'https:' : 'http:';
    const origin = `${protocol}//${urlHostname(settings.host)}:${address.port}`;
    const url = `${origin}${settings.startPath}`;
    if (options.signal) {
        abortListener = function closeAfterAbort() {
            close().catch(function reportCloseFailure(error) {
                console.error('[arcane source server] Abort close failed.', error);
            });
        };
        options.signal.addEventListener('abort', abortListener, {once: true});
        if (options.signal.aborted) {
            await close();
            throwIfAborted(options.signal);
        }
    }
    await publishEvent(settings.onEvent, 'source-server.started', {
        host: settings.host,
        port: address.port,
        origin,
        url
    });
    if (options.signal?.aborted) {
        await close();
        throwIfAborted(options.signal);
    }
    return {
        server,
        protocol,
        host: settings.host,
        port: address.port,
        origin,
        url,
        close,
        closed
    };
}

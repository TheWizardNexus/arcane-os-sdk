/** Send the caller's complete payload using only JSON transport encoding. */
export async function requestLocalJSON({url, path = '', method = 'GET', payload, signal}) {
    const response = await requestLocalResponse({url, path, method, payload, signal, accept: 'application/json'});
    const body = await response.text();
    return body === '' ? undefined : parseLocalJSON(body, response);
}

/** Yield upstream JSON records unchanged; the caller owns completion assembly. */
export async function* streamLocalJSON({url, path = '', method = 'POST', payload, format = 'sse', signal, onOpen}) {
    if (format !== 'sse' && format !== 'ndjson') {
        throw new TypeError(`Unsupported local AI stream format: ${format}.`);
    }
    const response = await requestLocalResponse({
        url, path, method, payload, signal,
        accept: format === 'sse' ? 'text/event-stream' : 'application/x-ndjson'
    });
    let data = [];
    for await (const line of readLocalLines(response, onOpen)) {
        if (format === 'ndjson') {
            if (line !== '') yield parseLocalJSON(line, response);
            continue;
        }
        if (line === '') {
            if (!data.length) continue;
            const body = data.join('\n');
            data = [];
            if (body === '[DONE]') return;
            yield parseLocalJSON(body, response);
            continue;
        }
        const separator = line.indexOf(':');
        const field = separator < 0 ? line : line.slice(0, separator);
        if (field !== 'data') continue;
        const value = separator < 0 ? '' : line.slice(separator + 1);
        data.push(value.startsWith(' ') ? value.slice(1) : value);
    }
    if (data.length) {
        const body = data.join('\n');
        if (body !== '[DONE]') yield parseLocalJSON(body, response);
    }
}

async function requestLocalResponse({url, path, method, payload, signal, accept}) {
    const headers = {Accept: accept};
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(new URL(path, url), {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal
    });
    if (!response.ok) {
        const body = await response.text();
        const error = new Error(`Local AI HTTP ${response.status} ${response.statusText}: ${body}`);
        error.status = response.status;
        error.body = body;
        error.url = response.url;
        throw error;
    }
    return response;
}

function parseLocalJSON(body, response) {
    try {
        return JSON.parse(body);
    } catch (error) {
        error.status = response.status;
        error.body = body;
        error.url = response.url;
        throw error;
    }
}

/** Remove only SSE/NDJSON line framing, including delimiters across reads. */
async function* readLocalLines(response, onOpen) {
    const chunks = response.body[Symbol.asyncIterator]();
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let pending = '';
    let precedingCarriageReturn = false;
    try {
        await onOpen?.(response);
        while (true) {
            const {value, done} = await chunks.next();
            let text = done ? decoder.decode() : decoder.decode(value, {stream: true});
            if (precedingCarriageReturn && text !== '') {
                if (text.startsWith('\n')) text = text.slice(1);
                precedingCarriageReturn = false;
            }
            let start = 0;
            for (const delimiter of text.matchAll(/\r\n|\r|\n/g)) {
                const line = pending + text.slice(start, delimiter.index);
                pending = '';
                start = delimiter.index + delimiter[0].length;
                precedingCarriageReturn = delimiter[0] === '\r' && start === text.length;
                yield line;
            }
            pending += text.slice(start);
            if (done) {
                if (pending !== '') yield pending;
                return;
            }
        }
    } finally {
        await chunks.return();
    }
}

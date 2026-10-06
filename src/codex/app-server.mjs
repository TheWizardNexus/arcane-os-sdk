import Is from 'strong-type';
import {ArcaneError, ERROR_CODES} from '../errors.mjs';
import {createArcaneEventSource} from '../event-manager.mjs';
import {runProcess} from '../process.mjs';

const is = new Is(false);
const eventTypes = {
    status: 'arcane.codex.app-server.status',
    message: 'arcane.codex.app-server.message',
    notification: 'arcane.codex.app-server.notification',
    stderr: 'arcane.codex.app-server.stderr',
    process: 'arcane.codex.app-server.process',
    error: 'arcane.codex.app-server.error',
    serverRequest: 'arcane.codex.app-server.server-request',
    serverRequestResponded: 'arcane.codex.app-server.server-request-responded',
    serverRequestResolved: 'arcane.codex.app-server.server-request-resolved',
    turnAccepted: 'arcane.codex.app-server.turn-accepted',
    delta: 'arcane.codex.app-server.delta',
    item: 'arcane.codex.app-server.item',
    turn: 'arcane.codex.app-server.turn',
    observerError: 'arcane.codex.app-server.observer-error'
};

/**
 * Own one explicitly selected native Codex App Server process. Construction has
 * no process side effects. connect() initializes JSONL; runTurn() awaits the
 * matching terminal notification, never merely the turn/start response.
 */
export function createCodexAppServerSession({
    executable,
    args = ['app-server', '--listen', 'stdio://'],
    cwd,
    env,
    clientInfo = {name: 'arcane_sdk', title: 'Arcane SDK', version: '1'},
    capabilities
} = {}) {
    let connection = null;
    let connecting = null;
    let disposing = null;
    let disposed = false;
    let eventsDisposed = false;
    let nextRequestId = 0;
    let nextServerRequestSequence = 0;
    let status = {state: 'disconnected'};
    const seenServerRequestIds = new Set();
    const publishingRequests = new Map();
    const session = {
        connect,
        reconnect,
        dispose,
        subscribe,
        request,
        listThreads,
        readThread,
        readTurn,
        createThread,
        resumeThread,
        runTurn,
        interrupt,
        respond,
        get status() {
            return status;
        },
        get pendingServerRequests() {
            return connection ? [...connection.serverRequests.values()] : [];
        }
    };
    const events = createArcaneEventSource(
        session,
        {
            source: 'codex.app-server',
            eventTypes: Object.values(eventTypes)
        }
    );
    return session;

    function emit(name, detail, options) {
        events.dispatch(eventTypes[name], detail, options);
    }

    function observe(listener, detail, name, context) {
        if (!is.function(listener)) {
            return;
        }
        function observerFailed(error) {
            if (eventsDisposed) {
                console.error(error);
                return;
            }
            if (name !== 'observerError') {
                emit(
                    'observerError',
                    {event: name, error, detail}
                );
            } else {
                console.error(error);
            }
        }
        try {
            const result = listener(detail, context);
            if (result && is.function(result.then)) {
                Promise.resolve(result).catch(observerFailed);
            }
        } catch (error) {
            observerFailed(error);
        }
    }

    function subscribe(name, listener, options = {}) {
        const unsubscribe = events.subscribe(
            eventTypes[name],
            function deliver(occurrence) {
                const context = name === 'serverRequest'
                    ? publishingRequests.get(occurrence.operationId)
                    : undefined;
                observe(listener, occurrence.detail, name, context);
            },
            options
        );
        if (name === 'status' && !options.signal?.aborted) {
            observe(listener, status, name);
            if (options.once) {
                unsubscribe();
            }
        }
        return unsubscribe;
    }

    function setStatus(state, details = {}) {
        status = {state, ...details};
        emit('status', status);
    }

    function connect() {
        if (disposed) {
            return Promise.reject(sessionError('DISPOSED', 'This Codex session is disposed.'));
        }
        if (connecting) {
            return connecting;
        }
        if (status.state === 'ready') {
            return Promise.resolve(session);
        }
        // Publish the in-flight promise before lifecycle subscribers can reenter.
        connecting = Promise.resolve().then(startConnection);
        connecting.then(clearConnecting, clearConnecting);
        return connecting;
    }

    function clearConnecting() {
        connecting = null;
    }

    async function startConnection() {
        if (!is.string(executable) || !executable) {
            throw new ArcaneError(ERROR_CODES.usage, 'Select a native Codex executable explicitly.');
        }
        // A failed connection must drain its owned process before a replacement.
        if (connection?.process) {
            await connection.process;
        }
        if (disposed) {
            throw sessionError('DISPOSED', 'This Codex session is disposed.');
        }
        const current = {
            controller: new AbortController(),
            input: createInputQueue(),
            pending: new Map(),
            serverRequests: new Map(),
            activeTurns: new Set(),
            fragments: [],
            ended: false,
            failure: null,
            process: null
        };
        connection = current;
        setStatus('connecting');
        if (disposed || current.failure) {
            throw current.failure || sessionError('DISPOSED', 'This Codex session is disposed.');
        }
        current.process = runProcess(
            executable,
            args,
            {
                cwd,
                env,
                signal: current.controller.signal,
                input: current.input,
                captureOutput: false,
                emitOutputEvents: false,
                onOutput: function receiveOutput(record) {
                    if (record.stream === 'stderr') {
                        emit('stderr', record);
                        return;
                    }
                    const lines = record.chunk.split('\n');
                    const trailing = lines.pop();
                    for (const line of lines) {
                        current.fragments.push(line);
                        const complete = current.fragments.join('');
                        current.fragments = [];
                        receiveLine(current, complete, record.chunk);
                    }
                    current.fragments.push(trailing);
                },
                onEvent: function processEvent(event) {
                    emit('process', event);
                }
            }
        ).then(
            function processExited(result) {
                endConnection(current, null, result);
                return {result};
            },
            function processFailed(error) {
                endConnection(current, error);
                return {error};
            }
        );
        try {
            const initialized = await sendRequest(
                current,
                'initialize',
                {clientInfo, ...(capabilities === undefined ? {} : {capabilities})}
            );
            send(
                current,
                {method: 'initialized'}
            );
            setStatus(
                'ready',
                {initialized}
            );
            if (disposed || current.failure) {
                throw current.failure || sessionError('DISPOSED', 'This Codex session is disposed.');
            }
            return session;
        } catch (error) {
            failConnection(current, error);
            throw error;
        }
    }

    function send(current, message) {
        if (current.ended || current.failure) {
            throw current.failure || sessionError('CONNECTION_LOST', 'The Codex connection has ended.');
        }
        current.input.send(`${JSON.stringify(message)}\n`);
    }

    function sendRequest(current, method, params) {
        const id = ++nextRequestId;
        return new Promise(
            function awaitResponse(resolve, reject) {
                current.pending.set(
                    id,
                    {resolve, reject, method, params}
                );
                try {
                    send(
                        current,
                        {id, method, ...(params === undefined ? {} : {params})}
                    );
                } catch (error) {
                    current.pending.delete(id);
                    reject(error);
                }
            }
        );
    }

    function readyConnection() {
        if (disposed || status.state !== 'ready' || !connection || connection.ended || connection.failure) {
            throw sessionError('NOT_READY', 'Connect the Codex session before sending a request.');
        }
        return connection;
    }

    async function request(method, params) {
        return sendRequest(readyConnection(), method, params);
    }

    function listThreads(params) {
        return request('thread/list', params);
    }

    function readThread(params) {
        return request('thread/read', params);
    }

    async function readTurn({threadId, turnId}) {
        const result = await readThread(
            {threadId, includeTurns: true}
        );
        const turn = result.thread?.turns?.find(
            function exactTurn(candidate) {
                return candidate.id === turnId;
            }
        );
        if (!turn) {
            throw sessionError(
                'TURN_NOT_FOUND',
                'The requested turn was not present in the stored thread response.',
                {threadId, turnId, response: result}
            );
        }
        return turnResult(threadId, turn, turn.items || []);
    }

    function createThread(params) {
        return request('thread/start', params);
    }

    function resumeThread(params) {
        return request('thread/resume', params);
    }

    function interrupt({threadId, turnId}) {
        return request(
            'turn/interrupt',
            {threadId, turnId}
        );
    }

    function respond(response, context) {
        const current = readyConnection();
        const pending = current.serverRequests.get(response.id);
        if (!pending) {
            throw sessionError(
                'REQUEST_NOT_FOUND',
                'This server request is no longer pending.',
                {id: response.id}
            );
        }
        if (context !== undefined && context !== pending.context) {
            throw sessionError(
                'STALE_REQUEST_CONTEXT',
                'This response belongs to an earlier server request.',
                {id: response.id}
            );
        }
        if (context === undefined && pending.contextRequired) {
            throw sessionError(
                'REQUEST_CONTEXT_REQUIRED',
                'This native request ID was reused; reply with its originating request context.',
                {id: response.id}
            );
        }
        if (pending.responded) {
            throw sessionError(
                'ALREADY_RESPONDED',
                'A response was already submitted for this server request.',
                {id: response.id}
            );
        }
        if (Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error')) {
            throw new ArcaneError(ERROR_CODES.usage, 'Respond with exactly one of result or error.');
        }
        const message = Object.hasOwn(response, 'error')
            ? {id: response.id, error: response.error}
            : {id: response.id, result: response.result};
        send(current, message);
        pending.responded = true;
        emit(
            'serverRequestResponded',
            {request: pending.request, response: message}
        );
        return {id: response.id, submitted: true};
    }

    function receiveLine(current, line, chunk = line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch (cause) {
            const error = sessionError(
                'PROTOCOL',
                'Codex stdout contained an unreadable JSONL message.',
                {line, chunk},
                cause
            );
            failConnection(current, error);
            throw error;
        }
        if (!message || !is.object(message) || is.array(message)) {
            const error = sessionError(
                'PROTOCOL',
                'Codex stdout contained a non-object message.',
                {line, chunk, message}
            );
            failConnection(current, error);
            throw error;
        }
        emit('message', message);
        if (is.string(message.method)) {
            if (Object.hasOwn(message, 'id')) {
                const id = message.id;
                const context = {
                    id,
                    respond: function replyToOrigin(response) {
                        return respond(
                            {...response, id},
                            context
                        );
                    }
                };
                const pending = {
                    request: message,
                    responded: false,
                    context,
                    contextRequired: seenServerRequestIds.has(id)
                };
                seenServerRequestIds.add(id);
                current.serverRequests.set(id, pending);
                const operationId = `codex-server-request-${++nextServerRequestSequence}`;
                // The event owner shallow-copies detail. Carry reply context
                // separately through this synchronous publication, never by
                // adding SDK fields to the native request envelope.
                publishingRequests.set(operationId, context);
                try {
                    emit(
                        'serverRequest',
                        message,
                        {operationId}
                    );
                } finally {
                    publishingRequests.delete(operationId);
                }
                return;
            }
            if (message.method === 'serverRequest/resolved') {
                current.serverRequests.delete(message.params?.requestId);
                emit('serverRequestResolved', message.params);
            }
            // Consumers may reply asynchronously; the stdout reader never awaits them.
            for (const active of [...current.activeTurns]) {
                active.receive(message);
            }
            emit('notification', message);
            return;
        }
        const pending = current.pending.get(message.id);
        if (!pending) {
            return;
        }
        current.pending.delete(message.id);
        if (Object.hasOwn(message, 'error')) {
            pending.reject(
                sessionError(
                    'RPC',
                    message.error?.message || 'Codex rejected the request.',
                    {method: pending.method, params: pending.params, requestId: message.id, outcome: 'rejected', error: message.error, response: message}
                )
            );
        } else if (Object.hasOwn(message, 'result')) {
            pending.resolve(message.result);
        } else {
            pending.reject(
                sessionError(
                    'PROTOCOL',
                    'Codex response contained neither result nor error.',
                    {message}
                )
            );
        }
    }

    /** Input strings receive only the native text-item envelope; arrays pass through unchanged. */
    function runTurn({threadId, input, signal, onDelta, onItem, onTurn, ...turnOptions}) {
        let current;
        try {
            current = readyConnection();
        } catch (error) {
            return Promise.reject(error);
        }
        if (signal?.aborted) {
            return Promise.reject(
                new ArcaneError(
                    ERROR_CODES.cancelled,
                    'The turn was cancelled before submission.',
                    {details: {threadId, outcome: 'not-submitted'}}
                )
            );
        }
        const items = new Map();
        const early = [];
        let turnId = null;
        let acceptance = null;
        let settled = false;
        let interrupted = false;
        let finish;
        let fail;
        const completion = new Promise(
            function terminal(resolve, reject) {
                finish = resolve;
                fail = reject;
            }
        );
        const active = {receive, lost};
        // Register correlation and cancellation before submitting turn/start.
        current.activeTurns.add(active);
        signal?.addEventListener(
            'abort',
            cancel,
            {once: true}
        );
        sendRequest(
            current,
            'turn/start',
            {threadId, input: is.string(input) ? [{type: 'text', text: input}] : input, ...turnOptions}
        ).then(accepted, rejected).catch(lost);
        return completion;

        function cleanup() {
            settled = true;
            current.activeTurns.delete(active);
            signal?.removeEventListener('abort', cancel);
            early.length = 0;
        }

        function rejected(error) {
            if (!settled) {
                cleanup();
                fail(error);
            }
        }

        function lost(error) {
            rejected(
                sessionError(
                    'TURN_UNKNOWN',
                    'This Codex turn has no observed terminal result for the operation.',
                    {threadId, turnId, outcome: 'unknown', items: [...items.values()], notifications: [...early], acceptance},
                    error
                )
            );
        }

        function accepted(result) {
            if (settled) {
                return;
            }
            acceptance = result;
            turnId = result?.turn?.id;
            if (!turnId) {
                lost(
                    sessionError(
                        'PROTOCOL',
                        'The turn/start response had no turn ID.',
                        {response: result}
                    )
                );
                return;
            }
            emit(
                'turnAccepted',
                {threadId, turnId, turn: result.turn, response: result}
            );
            for (const message of early.splice(0)) {
                receive(message);
            }
            if (signal?.aborted) {
                cancel();
            }
        }

        function cancel() {
            if (settled || !turnId || interrupted) {
                return;
            }
            interrupted = true;
            interrupt(
                {threadId, turnId}
            ).catch(
                function interruptionFailed(error) {
                    emit(
                        'error',
                        {operation: 'turn/interrupt', threadId, turnId, error}
                    );
                    // A rejected interrupt does not establish that the turn stopped.
                    if (!settled) {
                        lost(error);
                    }
                }
            );
        }

        function receive(message) {
            if (settled || message.params?.threadId !== threadId) {
                return;
            }
            if (!turnId) {
                early.push(message);
                return;
            }
            const {method, params} = message;
            if ((params.turnId ?? params.turn?.id) !== turnId) {
                return;
            }
            if (method === 'item/started' || method === 'item/completed') {
                const item = params.item;
                if (item) {
                    items.set(item.id, item);
                    const detail = {
                        threadId,
                        turnId,
                        itemId: item.id,
                        text: item.type === 'agentMessage' ? item.text : null,
                        phase: item.phase ?? null,
                        stage: method === 'item/started' ? 'started' : 'completed',
                        item,
                        params
                    };
                    emit('item', detail);
                    if (!settled && !signal?.aborted) {
                        observe(onItem, detail, 'item');
                    }
                }
            } else if (method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta') {
                const detail = {
                    threadId,
                    turnId,
                    itemId: params.itemId,
                    delta: params.delta,
                    phase: params.phase ?? items.get(params.itemId)?.phase ?? null,
                    method,
                    params
                };
                emit('delta', detail);
                if (!settled && !signal?.aborted) {
                    observe(onDelta, detail, 'delta');
                }
            } else if (method === 'turn/started' || method === 'turn/completed') {
                const turn = params.turn;
                const detail = {threadId, turnId, status: turn.status, turn};
                if (method === 'turn/completed') {
                    // Final provider objects supersede earlier item snapshots by ID.
                    for (const item of turn.items || []) {
                        items.set(item.id, item);
                    }
                    const result = turnResult(
                        threadId,
                        turn,
                        [...items.values()]
                    );
                    // Observers can dispose reentrantly. The observed terminal
                    // result already owns settlement before those callbacks run.
                    cleanup();
                    finish(result);
                }
                emit('turn', detail);
                observe(onTurn, detail, 'turn');
            }
        }
    }

    function failConnection(current, error) {
        if (current.failure || current.ended) {
            return;
        }
        current.failure = error;
        for (const active of [...current.activeTurns]) {
            active.lost(error);
        }
        for (const [requestId, pending] of current.pending) {
            pending.reject(
                sessionError(
                    'CONNECTION_LOST',
                    'The Codex request ended without an observed response.',
                    {requestId, method: pending.method, params: pending.params, outcome: 'unknown'},
                    error
                )
            );
        }
        current.pending.clear();
        const pendingServerRequests = [...current.serverRequests.values()];
        current.serverRequests.clear();
        if (connection === current) {
            setStatus(
                disposed ? 'disposed' : 'disconnected',
                {error}
            );
        }
        emit(
            'error',
            {operation: 'connection', error, pendingServerRequests}
        );
        current.input.close();
        current.controller.abort();
    }

    function endConnection(current, error, result) {
        const unfinished = current.fragments.join('');
        current.fragments = [];
        if (unfinished) {
            // A final complete JSON record may have no trailing newline at EOF.
            try {
                receiveLine(current, unfinished);
            } catch (cause) {
                error = cause;
            }
        }
        failConnection(
            current,
            error || sessionError(
                'CONNECTION_LOST',
                'The native Codex process exited.',
                {result}
            )
        );
        current.ended = true;
        current.input.close();
    }

    async function stopConnection() {
        const current = connection;
        if (!current) {
            return;
        }
        failConnection(current, sessionError('CONNECTION_CLOSED', 'The caller closed the Codex connection.'));
        await current.process;
    }

    async function reconnect() {
        if (disposed) {
            throw sessionError('DISPOSED', 'This Codex session is disposed.');
        }
        await stopConnection();
        if (connecting) {
            await connecting.catch(
                function connectionStopped() {
                    // The original caller and connection error event own this failure.
                }
            );
        }
        return connect();
    }

    function dispose() {
        if (disposing) {
            return disposing;
        }
        disposed = true;
        disposing = Promise.resolve().then(finishDispose);
        return disposing;
    }

    async function finishDispose() {
        await stopConnection();
        seenServerRequestIds.clear();
        setStatus('disposed');
        eventsDisposed = true;
        events.dispose();
    }
}

/** Create and initialize one ready session; never creates or resumes a thread. */
export async function openCodexAppServerSession(options) {
    const session = createCodexAppServerSession(options);
    try {
        await session.connect();
        return session;
    } catch (error) {
        await session.dispose();
        throw error;
    }
}

function sessionError(kind, message, details, cause) {
    return new ArcaneError(
        `ARCANE_CODEX_${kind}`,
        message,
        {details, cause}
    );
}

function turnResult(threadId, turn, items) {
    const visibleItems = [];
    for (const item of items) {
        if (item.type === 'agentMessage' && is.string(item.text)) {
            visibleItems.push(
                {itemId: item.id, text: item.text, phase: item.phase ?? null}
            );
        }
    }
    return {threadId, turnId: turn.id, status: turn.status, items, visibleItems, error: turn.error, turn};
}

function createInputQueue() {
    const queued = [];
    let next = null;
    let closed = false;
    return {
        [Symbol.asyncIterator]: function iterate() {
            return this;
        },
        next: function read() {
            if (queued.length) {
                return Promise.resolve(
                    {value: queued.shift(), done: false}
                );
            }
            if (closed) {
                return Promise.resolve(
                    {done: true}
                );
            }
            return new Promise(
                function awaitInput(resolve) {
                    next = resolve;
                }
            );
        },
        return: function returnInput() {
            this.close();
            return Promise.resolve(
                {done: true}
            );
        },
        send: function sendInput(value) {
            if (closed) {
                throw sessionError('CONNECTION_CLOSED', 'Codex stdin is closed.');
            }
            if (next) {
                const resolve = next;
                next = null;
                resolve(
                    {value, done: false}
                );
            } else {
                queued.push(value);
            }
        },
        close: function closeInput() {
            closed = true;
            queued.length = 0;
            if (next) {
                next(
                    {done: true}
                );
                next = null;
            }
        }
    };
}

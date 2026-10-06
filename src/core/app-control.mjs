import {connectCoreSocket, createCoreSocketConnection} from './socket-connection.mjs';

function reportAppControlError(error) { console.error('Arcane app control failed:', error); }

/** Connect to one explicitly selected running native window without launching it. */
export async function connectAppControl({endpoint, signal, onError = reportAppControlError} = {}) {
    if (typeof endpoint !== 'string' || !endpoint) {
        throw new TypeError('App control requires an explicit local pipe/socket endpoint.');
    }
    const socket = await connectCoreSocket(endpoint, signal, onError);
    const connection = createCoreSocketConnection({socket, endpoint, signal, onError,
        name: 'app-control', closedMessage: 'The app-control connection closed.'});
    const {client} = connection;
    return {
        endpoint,
        closed: connection.closed,
        status(options) { return client.invoke('app.control.status', {}, options); },
        inspect(parameters = {}, options) { return client.invoke('app.control.inspect', parameters, options); },
        capture(parameters = {}, options) { return client.invoke('app.control.capture', parameters, options); },
        act(parameters, options) { return client.invoke('app.control.act', parameters, options); },
        key(parameters, options) { return client.invoke('app.control.key', parameters, options); },
        resize(parameters, options) { return client.invoke('app.control.resize', parameters, options); },
        close() { return connection.close(); }
    };
}

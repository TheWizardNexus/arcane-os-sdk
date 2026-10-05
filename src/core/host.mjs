import {createCoreRuntime} from './runtime.mjs';
import {startCoreStdio} from './stdio.mjs';

/** Compose app services with the shared dispatcher and draining transport. */
export function startCoreHost({application, version, services = [], input, output, onError, signal} = {}) {
    const runtime = createCoreRuntime({application, version, services});
    const host = startCoreStdio({runtime, input, output, onError});
    if (!signal) return host;

    function closeHostOnAbort() {
        // The transport owns cancellation, accepted-service work and final output.
        host.close();
    }

    function releaseAbortListener() {
        signal.removeEventListener('abort', closeHostOnAbort);
    }

    signal.addEventListener('abort', closeHostOnAbort, {once: true});
    host.closed.then(releaseAbortListener, releaseAbortListener);
    if (signal.aborted) closeHostOnAbort();
    return host;
}

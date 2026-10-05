import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {startDevServer} from '../../dev-server.mjs';
import {serializeCoreError} from '../../../browser-runtime/core/contracts.mjs';

/** Serve one packaged web root inside its existing Core lifetime. */
export function createPackagedWebService({artifactRoot}, context = {}) {
    let server;
    let closing = false;
    let lifetime;
    return {
        name: 'packaged-web',
        async start(runtime) {
            const manifest = JSON.parse(await readFile(path.join(artifactRoot, 'arcane-native.json'), 'utf8'));
            // The launcher chooses app state independently of its installation.
            // Forward the application's launch file unchanged; the fallback is
            // a separate native argument, not a rewritten application payload.
            const stateFlag = process.argv.indexOf('--arcane-host-state-root');
            const stateRoot = context.stateRoot ?? (stateFlag < 0 ? undefined : process.argv[stateFlag + 1]);
            if (typeof stateRoot !== 'string' || !stateRoot) {
                throw new TypeError('Packaged web serving requires the launcher-selected stateRoot.');
            }
            await mkdir(stateRoot, {recursive: true});
            const originFile = path.join(stateRoot, 'packaged-web-origin.json');
            let port = 0;
            let saved = false;
            try {
                const origin = JSON.parse(await readFile(originFile, 'utf8'));
                port = origin.port;
                if (!Number.isInteger(port) || port < 1 || port > 65535) {
                    throw new TypeError('The saved packaged origin needs its previously selected listener port.');
                }
                saved = true;
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            try {
                server = await startDevServer({
                    mode: 'packaged', http: true,
                    releaseRoot: path.resolve(artifactRoot, manifest.webRoot),
                    host: '127.0.0.1', port
                });
                // Only a first successful listener selects a port. A later bind
                // conflict remains an error instead of moving saved browser data
                // to a different origin. Concurrent first launches cannot replace
                // one another's selection.
                if (!saved) {
                    await writeFile(originFile, JSON.stringify({host: '127.0.0.1', port: server.port}) + '\n', {flag: 'wx'});
                }
                const url = new URL(manifest.start, server.origin).href;
                runtime.emit('core.web.ready', {origin: server.origin, url, port: server.port});
                lifetime = server.lifecycle.then(
                    function packagedServerEnded() {
                        if (!closing) {
                            runtime.emit('core.web.failed', serializeCoreError(
                                new Error('The packaged application listener closed unexpectedly.')
                            ));
                        }
                    },
                    function packagedServerFailed(error) {
                        if (!closing) runtime.emit('core.web.failed', serializeCoreError(error));
                        throw error;
                    }
                );
                // Retain the original rejection for drain while observing it
                // now; the native diagnostic event owns immediate reporting.
                lifetime.catch(function observePackagedServerFailure() {});
            } catch (error) {
                closing = true;
                if (server) {
                    try { await server.close(); }
                    catch (closeError) {
                        throw new AggregateError([error, closeError], 'Packaged application startup and shutdown failed.');
                    }
                }
                throw error;
            }
        },
        async drain() {
            closing = true;
            if (!server) return;
            const results = await Promise.allSettled([server.close(), server.closed, lifetime]);
            const failures = [...new Set(results.filter(function rejected(result) {
                return result.status === 'rejected';
            }).map(function reason(result) {return result.reason;}))];
            if (failures.length) throw new AggregateError(failures, 'Packaged application serving shutdown failed.');
        }
    };
}

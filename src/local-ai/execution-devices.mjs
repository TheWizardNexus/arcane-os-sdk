import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {inspect} from 'node:util';
import Is from 'strong-type';
import {ArcaneError, ERROR_CODES} from '../errors.mjs';
import {runProcess} from '../process.mjs';

const is = new Is(false);

/**
 * One lazy physical-device inventory per host lifetime. Concurrent callers share
 * discovery; refresh explicitly replaces the cached observation. Returned records
 * are ordinary independent snapshots, not engine-placement or affinity claims.
 * Cancellation rejects with AbortError/ARCANE_CANCELLED. The last departing
 * caller stops discovery; dispose waits for the owned process to finish stopping.
 */
export function createExecutionDeviceCatalog({signal} = {}) {
    requireSignal(signal);
    const lifetime = new AbortController();
    const waiting = new Set();
    let cached = null;
    let active = null;
    let closing = null;

    function requireActive(requestSignal) {
        requireSignal(requestSignal);
        if (requestSignal?.aborted) throw cancellation(requestSignal.reason);
        if (lifetime.signal.aborted) throw cancellation(lifetime.signal.reason);
    }

    function startDiscovery() {
        const operation = {
            controller: new AbortController(),
            callers: 0,
            finished: false,
            task: null
        };
        active = operation;
        operation.task = discoverDevices(operation.controller.signal).then(
            function discoveryCompleted(value) {
                operation.finished = true;
                if (active === operation) active = null;
                if (operation.controller.signal.aborted) {
                    return {error: cancellation(operation.controller.signal.reason)};
                }
                cached = value;
                return {value};
            },
            function discoveryFailed(error) {
                operation.finished = true;
                if (active === operation) active = null;
                return {error};
            }
        );
        return operation;
    }

    function waitForDiscovery(operation, requestSignal, ownsQuery = true) {
        return new Promise(
            function waitForOwnedDiscovery(resolve, reject) {
                let settled = false;
                if (ownsQuery) operation.callers += 1;

                function releaseCaller() {
                    requestSignal?.removeEventListener('abort', cancelCaller);
                    waiting.delete(cancelCaller);
                    if (ownsQuery) operation.callers -= 1;
                }

                function cancelCaller() {
                    if (settled) return;
                    settled = true;
                    const reason = requestSignal?.aborted
                        ? requestSignal.reason
                        : lifetime.signal.reason;
                    const error = cancellation(reason);
                    releaseCaller();
                    if (ownsQuery && operation.callers === 0 && !operation.finished) {
                        operation.controller.abort(error);
                    }
                    reject(error);
                }

                waiting.add(cancelCaller);
                requestSignal?.addEventListener(
                    'abort', cancelCaller,
                    {once: true}
                );
                operation.task.then(
                    function deliverDiscovery(outcome) {
                        if (settled) return;
                        if (requestSignal?.aborted || lifetime.signal.aborted) {
                            cancelCaller();
                            return;
                        }
                        settled = true;
                        releaseCaller();
                        // A replacement query waits only for the cancelled process
                        // to retire; its old cancellation is not the new request's.
                        if (ownsQuery && outcome.error) reject(outcome.error);
                        else resolve(outcome.value);
                    }
                );
                if (requestSignal?.aborted || lifetime.signal.aborted) cancelCaller();
            }
        );
    }

    async function devices({refresh = false, signal: requestSignal} = {}) {
        requireActive(requestSignal);
        if (refresh) cached = null;
        while (active?.controller.signal.aborted) {
            await waitForDiscovery(active, requestSignal, false);
            requireActive(requestSignal);
        }
        if (cached && !refresh) return structuredClone(cached);
        const operation = active ?? startDiscovery();
        const inventory = await waitForDiscovery(operation, requestSignal);
        requireActive(requestSignal);
        return structuredClone(inventory);
    }

    async function resolveTarget({executionTarget = null, refresh = false, signal: requestSignal} = {}) {
        requireActive(requestSignal);
        if (executionTarget === null) {
            return {
                requestedTarget: null,
                resolvedDevice: null,
                resolution: 'automatic',
                reason: 'engine-default-required'
            };
        }
        if (!is.string(executionTarget?.deviceId) || executionTarget.deviceId === '') {
            throw new TypeError('An execution target requires a deviceId or an explicit null automatic selection.');
        }
        const requestedTarget = {deviceId: executionTarget.deviceId};
        const inventory = await devices(
            {refresh, signal: requestSignal}
        );
        requireActive(requestSignal);
        const device = inventory.devices.find(
            function matchesRequestedDevice(candidate) {
                return candidate.present && candidate.deviceId === requestedTarget.deviceId;
            }
        );
        if (device) {
            return {requestedTarget, resolvedDevice: device, resolution: 'matched', reason: null};
        }
        const cpuRequested = requestedTarget.deviceId === 'cpu';
        const unresolvedIdentity = !cpuRequested && inventory.devices.some(
            function hasUnresolvedIdentity(candidate) {
                return candidate.present && candidate.deviceId === null;
            }
        );
        const incompleteInventory = inventory.state === 'unavailable' || inventory.issues.some(
            function enumerationUnavailable(issue) {
                const relevant = cpuRequested
                    ? issue.source === 'cpu'
                    : issue.source === 'gpu' || issue.source === 'npu';
                return relevant && (issue.code === 'enumeration-unavailable' || issue.code === 'enumeration-failed');
            }
        );
        const reason = incompleteInventory
            ? 'inventory-unavailable'
            : unresolvedIdentity ? 'identity-unresolved' : 'device-not-present';
        return {
            requestedTarget,
            resolvedDevice: null,
            resolution: reason === 'device-not-present' ? 'unavailable' : 'unsupported',
            reason
        };
    }

    function dispose() {
        if (closing) return closing;
        const operation = active;
        signal?.removeEventListener('abort', cancelLifetime);
        cached = null;
        lifetime.abort(signal?.aborted ? signal.reason : cancellation('Execution-device catalog disposed.'));
        for (const cancelCaller of waiting) cancelCaller();
        operation?.controller.abort(lifetime.signal.reason);
        closing = operation
            ? operation.task.then(
                function discoveryDisposed(outcome) {
                    if (outcome.error && outcome.error.code !== ERROR_CODES.cancelled) throw outcome.error;
                }
            )
            : Promise.resolve();
        return closing;
    }

    function cancelLifetime() {
        // The retained closing promise owns the process drain even when a parent
        // aborts without immediately awaiting dispose(). Discovery settles it.
        dispose();
    }

    signal?.addEventListener(
        'abort', cancelLifetime,
        {once: true}
    );
    if (signal?.aborted) cancelLifetime();
    return {devices, resolveTarget, dispose};
}

async function discoverDevices(signal) {
    if (signal.aborted) throw cancellation(signal.reason);
    if (process.platform !== 'win32') {
        return unavailableInventory(
            'platform-unavailable',
            `Physical execution-device inventory is unavailable on ${process.platform}.`
        );
    }
    let result;
    try {
        const script = await readFile(
            new URL('./execution-devices-windows.ps1', import.meta.url),
            {encoding: 'utf8', signal}
        );
        if (signal.aborted) throw cancellation(signal.reason);
        const command = process.env.SystemRoot
            ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
            : 'powershell.exe';
        async function* discoveryInput() {
            // The process owner's iterable input path observes stdin failures
            // and owns its drain if PowerShell exits before accepting the script.
            yield `& {\n${script}\n}\n\n`;
        }
        result = await runProcess(
            command,
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
            {
                signal,
                input: discoveryInput(),
                captureOutput: true,
                emitOutputEvents: false
            }
        );
        if (signal.aborted) throw cancellation(signal.reason);
        const inventory = JSON.parse(result.stdout);
        if (!inventory || !is.array(inventory.devices) || !is.array(inventory.issues)) {
            throw new TypeError('Windows execution-device discovery returned no inventory record.');
        }
        if (result.stderr !== '') {
            inventory.issues.push(
                {source: 'identity', code: 'discovery-diagnostics', message: result.stderr, deviceId: null}
            );
            if (inventory.state === 'ready') inventory.state = 'partial';
        }
        return inventory;
    } catch (error) {
        if (signal.aborted) throw cancellation(error);
        const details = inspect(
            error,
            {depth: null, maxArrayLength: null, maxStringLength: null, compact: false}
        );
        const output = result ? `\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}` : '';
        return unavailableInventory('discovery-failed', `${details}${output}`);
    }
}

function unavailableInventory(code, message) {
    return {
        platform: process.platform,
        state: 'unavailable',
        devices: [],
        issues: [
            {source: 'identity', code, message, deviceId: null}
        ]
    };
}

function cancellation(reason) {
    const error = new ArcaneError(
        ERROR_CODES.cancelled,
        'Execution-device discovery was cancelled.',
        {cause: reason, exitCode: 130}
    );
    error.name = 'AbortError';
    return error;
}

function requireSignal(signal) {
    if (signal === undefined || signal === null) return;
    if (!is.boolean(signal.aborted) || !is.function(signal.addEventListener) || !is.function(signal.removeEventListener)) {
        throw new TypeError('Execution-device discovery requires an AbortSignal when signal is supplied.');
    }
}

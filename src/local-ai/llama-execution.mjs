import {readFile} from 'node:fs/promises';
import path from 'node:path';
import Is from 'strong-type';
import {ArcaneError, ERROR_CODES, throwIfAborted} from '../errors.mjs';
import {runProcess} from '../process.mjs';

const is = new Is(false);

/**
 * Resolve one explicit catalog selection for a new native llama server lifetime.
 * Default selection performs no discovery. Hardware identity and launch options
 * are configuration evidence; the server's observed execution target stays null.
 */
export async function resolveLlamaExecution({
    executionTarget, executionDevices, runtime, signal, onEvent
} = {}) {
    throwIfAborted(signal);
    if (executionTarget === undefined || executionTarget === null) {
        const cpu = runtime?.requestedBackend === 'cpu';
        return {
            args: cpu ? ['--device', 'none', '--gpu-layers', '0'] : [],
            env: {},
            execution: {
                requestedTarget: null,
                resolvedDevice: null,
                resolution: 'automatic',
                reason: cpu ? 'runtime-backend-selected' : 'engine-default-required',
                configuredTarget: cpu ? {backend: 'cpu', device: 'none', gpuLayers: 0} : null,
                observedTarget: null,
                fallback: false
            }
        };
    }
    if (!is.function(executionDevices?.resolveTarget)) {
        throw new ArcaneError(
            'LOCAL_AI_EXECUTION_TARGET_UNSUPPORTED',
            'Explicit llama.cpp device selection requires the host execution-device catalog.',
            {details: {requestedTarget: executionTarget}}
        );
    }
    // The persistent device ID is resolved again for this load because a Windows
    // adapter LUID belongs to the current host session, not the saved selection.
    const resolution = await executionDevices.resolveTarget(
        {executionTarget, refresh: true, signal}
    );
    throwIfAborted(signal);
    const execution = {
        ...resolution,
        configuredTarget: null,
        observedTarget: null,
        fallback: false
    };
    if (resolution.resolution !== 'matched' || !resolution.resolvedDevice) {
        throw new ArcaneError(
            resolution.resolution === 'unsupported'
                ? 'LOCAL_AI_EXECUTION_TARGET_UNSUPPORTED'
                : 'LOCAL_AI_EXECUTION_TARGET_UNAVAILABLE',
            `The selected llama.cpp execution device could not be resolved: ${resolution.reason}.`,
            {details: execution}
        );
    }
    const device = resolution.resolvedDevice;
    if (device.kind === 'cpu') {
        execution.configuredTarget = {
            backend: 'cpu', deviceId: device.deviceId, device: 'none', gpuLayers: 0
        };
        return {args: ['--device', 'none', '--gpu-layers', '0'], env: {}, execution};
    }
    if (device.kind !== 'gpu' || process.platform !== 'win32') {
        throw new ArcaneError(
            'LOCAL_AI_EXECUTION_TARGET_UNSUPPORTED',
            `Exact llama.cpp ${device.kind} selection is unavailable on ${process.platform}.`,
            {details: execution}
        );
    }
    if (runtime?.requestedBackend === 'cpu') {
        throw new ArcaneError(
            'LOCAL_AI_EXECUTION_TARGET_UNSUPPORTED',
            'The selected GPU is incompatible with the explicit llama.cpp CPU runtime configuration.',
            {details: execution}
        );
    }
    if (runtime?.backend !== 'cuda') {
        throw new ArcaneError(
            'LOCAL_AI_EXECUTION_TARGET_UNSUPPORTED',
            'Exact Windows GPU selection requires a llama.cpp CUDA runtime.',
            {details: {...execution, runtimeBackend: runtime?.backend ?? null}}
        );
    }
    const adapterLuid = device.addresses?.adapterLuid;
    if (!is.integer(adapterLuid?.lowPart) || adapterLuid.lowPart < 0 || adapterLuid.lowPart > 0xffffffff
        || !is.integer(adapterLuid?.highPart) || adapterLuid.highPart < -0x80000000 || adapterLuid.highPart > 0x7fffffff) {
        throw new ArcaneError(
            'LOCAL_AI_EXECUTION_TARGET_UNSUPPORTED',
            'The selected Windows GPU has no current adapter LUID for CUDA identity resolution.',
            {details: execution}
        );
    }
    const identity = await resolveWindowsCudaIdentity({adapterLuid, signal, onEvent});
    throwIfAborted(signal);
    execution.configuredTarget = {
        backend: 'cuda',
        deviceId: device.deviceId,
        device: 'CUDA0',
        uuid: identity.uuid,
        nodeMask: identity.nodeMask,
        adapterLuid: identity.adapterLuid,
        driverMode: identity.driverMode,
        identitySource: 'nvidia-cuda-driver',
        uuidFunction: identity.uuidFunction,
        splitMode: 'none',
        mainGpu: 0,
        gpuLayers: 'all'
    };
    if (identity.diagnostics !== '') {
        execution.diagnostics = [{source: 'cuda-driver', message: identity.diagnostics}];
    }
    // A single full UUID makes CUDA0 identify the selected physical GPU in the
    // fresh server process, independent of DXGI or inherited CUDA ordinal order.
    return {
        args: ['--device', 'CUDA0', '--split-mode', 'none', '--main-gpu', '0', '--gpu-layers', 'all'],
        env: {CUDA_VISIBLE_DEVICES: identity.uuid},
        execution
    };
}

async function resolveWindowsCudaIdentity({adapterLuid, signal, onEvent}) {
    const script = await readFile(
        new URL('./llama-execution-windows.ps1', import.meta.url),
        {encoding: 'utf8', signal}
    );
    throwIfAborted(signal);
    const command = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe';
    async function* identityInput() {
        yield `& {\n${script}\n}\n\n`;
    }
    const result = await runProcess(
        command,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
        {
            signal,
            onEvent,
            env: {
                ARCANE_LLAMA_LUID_LOW: String(adapterLuid.lowPart),
                ARCANE_LLAMA_LUID_HIGH: String(adapterLuid.highPart)
            },
            input: identityInput(),
            captureOutput: true,
            emitOutputEvents: false
        }
    );
    throwIfAborted(signal);
    let identity;
    try {
        identity = JSON.parse(result.stdout);
        if (!is.string(identity?.uuid) || identity.uuid === '' || !is.integer(identity.nodeMask)) {
            throw new TypeError('The CUDA driver identity helper returned no device identity.');
        }
    } catch (error) {
        throw new ArcaneError(
            ERROR_CODES.operationFailed,
            'Could not read the selected CUDA device identity.',
            {cause: error, details: result}
        );
    }
    return {...identity, diagnostics: result.stderr};
}

import {createExecutionDeviceCatalog} from '../../local-ai/execution-devices.mjs';

/**
 * Independent of model-service startup. Core gives this service ownership of
 * the shared catalog's disposal; model engines borrowing it do not dispose it.
 */
export function createExecutionDeviceService({catalog = createExecutionDeviceCatalog()} = {}) {
    function devices({refresh = false} = {}, {signal} = {}) {
        return catalog.devices(
            {refresh, signal}
        );
    }

    function resolveTarget({executionTarget = null, refresh = false} = {}, {signal} = {}) {
        return catalog.resolveTarget(
            {executionTarget, refresh, signal}
        );
    }

    function dispose() {
        return catalog.dispose();
    }

    return {
        name: 'execution-devices',
        methods: {
            'localai.devices': devices,
            'localai.resolveTarget': resolveTarget
        },
        dispose
    };
}

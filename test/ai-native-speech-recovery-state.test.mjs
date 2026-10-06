import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {
    continuesAIRuntimeOperation, getAIRuntimeState, publishAIRuntimeRoleState
} from '../runtime/arcane/modules/AIRuntimeState.js';

test('speech components preserve only the exact active runtime operation during recovery', function recoveryIdentity() {
    const ready = {
        role: 'stt', providerId: 'LOCAL_SPEACH', modelId: 'whisper-small', localOnly: true,
        state: 'ready', loaded: true, busy: true, operationId: 'stt-transcribe-7',
        progress: null, error: null
    };
    const recovering = {...ready, state: 'recovering', loaded: false};
    const error = {...recovering, state: 'error', error: {code: 'WHISPER_NATIVE_FAILURE', message: 'Complete failure'}};
    assert.equal(continuesAIRuntimeOperation(ready, recovering, ready.operationId), true);
    assert.equal(continuesAIRuntimeOperation(recovering, error, ready.operationId), true);
    for (const changed of [
        {...recovering, operationId: 'stt-transcribe-8'},
        {...recovering, providerId: 'WEB_SPEECH'},
        {...recovering, modelId: 'another-model'},
        {...recovering, state: 'unloading'},
        {...recovering, busy: false},
        {...recovering, loaded: true}
    ]) assert.equal(continuesAIRuntimeOperation(ready, changed, ready.operationId), false);
    assert.equal(continuesAIRuntimeOperation(ready, recovering, null), false);
    assert.equal(continuesAIRuntimeOperation(ready, recovering, 'component-local-id'), false);

    const previous = getAIRuntimeState().roles.stt;
    try {
        publishAIRuntimeRoleState('stt', recovering);
        assert.equal(getAIRuntimeState().roles.stt.loaded, false);
        assert.equal(getAIRuntimeState().roles.stt.busy, true);
        publishAIRuntimeRoleState('stt', error);
        assert.equal(getAIRuntimeState().roles.stt.error.message, 'Complete failure');
    } finally {
        publishAIRuntimeRoleState('stt', previous);
    }
});

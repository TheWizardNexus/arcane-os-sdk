import {createSpeechService} from 'arcane-os/core/speech';
import {createNemotronRuntime} from 'arcane-os/local-ai/nemotron';
import {createMagpieRuntime} from 'arcane-os/local-ai/magpie';
import {ensureLocalAIRuntimes} from 'arcane-os/local-ai';
import {buildNemotronHelper} from 'arcane-os/local-ai/nemotron/build';
import {buildMagpieHelper} from 'arcane-os/local-ai/magpie/build';
import path from 'node:path';

/** The launch selection names installed assets; the SDK owns their lifetimes. */
export default function createConversationSpeech(options, launchContext) {
    const selection = launchContext.speech ?? options;
    const directory = path.join(launchContext.stateRoot, 'Runtimes', 'Speech');
    let installation;
    function installedRuntime(signal) {
        if (!installation) {
            installation = ensureLocalAIRuntimes({runtimes: [{id: 'nemo-speech', version: '0.2.0'}],
                directory, signal, onEvent: reportNativeEvent}).then(records => records[0]);
            installation.catch(function retryFailedInstallation() { installation = null; });
        }
        return installation;
    }
    async function prepareRuntime(role, signal) {
        const runtime = await installedRuntime(signal);
        signal.throwIfAborted();
        const build = role === 'stt' ? buildNemotronHelper : buildMagpieHelper;
        const helper = await build({runtime, outputRoot: path.join(directory, role), signal, onEvent: reportNativeEvent});
        return {...runtime, ...helper,
            libraryDirectory: process.platform === 'win32' ? runtime.binaryDirectory : runtime.libraryDirectory};
    }
    return createSpeechService({
        autoLoad: false,
        stt: createNemotronRuntime({gpu: -1, prepare: ({signal}) => prepareRuntime('stt', signal),
            ...selection.stt, modelAssets: launchContext.modelAssets, onEvent: reportNativeEvent}),
        tts: createMagpieRuntime({executionTarget: {backend: 'cpu'}, prepare: ({signal}) => prepareRuntime('tts', signal),
            ...selection.tts, modelAssets: launchContext.modelAssets, onEvent: reportNativeEvent})
    });
}

function reportNativeEvent(event) {
    // Native startup diagnostics belong in the host log, not the conversation.
    console.error('Native speech:', JSON.stringify(event));
}

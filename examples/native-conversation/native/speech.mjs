import {createSpeechService} from 'arcane-os/core/speech';
import {createNemotronRuntime} from 'arcane-os/local-ai/nemotron';
import {createMagpieRuntime} from 'arcane-os/local-ai/magpie';

/** The launch selection names installed assets; the SDK owns their lifetimes. */
export default function createConversationSpeech(options, launchContext) {
    const selection = launchContext.speech ?? options;
    return createSpeechService({
        stt: createNemotronRuntime({...selection.stt, onEvent: reportNativeEvent}),
        tts: createMagpieRuntime({...selection.tts, onEvent: reportNativeEvent})
    });
}

function reportNativeEvent(event) {
    // Native startup diagnostics belong in the host log, not the conversation.
    console.error('Native speech:', JSON.stringify(event));
}

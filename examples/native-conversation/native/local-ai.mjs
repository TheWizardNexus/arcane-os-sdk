import {createLocalAIService} from 'arcane-os/core/local-ai';
import {ensureLocalAIRuntimes} from 'arcane-os/local-ai';
import path from 'node:path';

/** Use the app's selected installed runtime or existing local listener. */
export default function createConversationLocalAI(options, launchContext) {
    const configuration = launchContext.localAI ?? {
        runtimes: ['llama.cpp'],
        llamaCpp: {modelsDirectory: path.join(launchContext.modelsDirectory, 'LLM')},
        ...options
    };
    return createLocalAIService(configuration, {
        ...launchContext,
        autoStart: false,
        async prepare({signal, onEvent}) {
            if (launchContext.runtimes !== undefined) return launchContext.runtimes;
            return ensureLocalAIRuntimes({
                runtimes: configuration.runtimes,
                directory: path.join(launchContext.stateRoot, 'Runtimes'),
                signal, onEvent
            });
        }
    });
}

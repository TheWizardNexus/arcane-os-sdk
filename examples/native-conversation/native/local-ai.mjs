import {createLocalAIService} from 'arcane-os/core/local-ai';

/** Use the app's selected installed runtime or existing local listener. */
export default function createConversationLocalAI(options, launchContext) {
    return createLocalAIService(launchContext.localAI ?? options, launchContext);
}

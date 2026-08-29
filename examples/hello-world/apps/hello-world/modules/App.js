import arcaneThemeReady from 'arcane/ThemeBootstrap';
import 'arcane/HTMLImport';
import DBOPFS from 'arcane/DBOPFS';
import AI, {
    AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL
} from 'arcane/AI';
import waitForComponent from 'arcane/WaitForComponent';
import {
    adaptV1LlmProvider,
    createBrowserModelSource,
    createBrowserWasmLlmProvider,
    createDbopfsModelStore
} from 'arcane-os/ai/browser-wasm';
import speechAuthorities from './SpeechAuthorities.js';

const CHAT_MODEL={
    id:'ibm-granite-4.1-3b-q4-k-s',
    url:'https://huggingface.co/ibm-granite/granite-4.1-3b-GGUF/resolve/ab4701481089b58a082ef63cc1cee738887293ff/granite-4.1-3b-Q4_K_S.gguf'
};

const chat=document.querySelector('#hello-world-chat');
chat.name='You';
chat.aiName='Arcane';

await configureHelloWorldChat();

function currentRoleRoutes(runtime,role){
    return {
        default:runtime.selection(role),
        localOnly:runtime.selection(role,{localOnly:true})
    };
}

async function configureHelloWorldChat(){
    await arcaneThemeReady;
    await waitForComponent(chat,{
        errorEvent:'html-import-error',
        event:'chat-ready',
        methods:['bindSession'],
        property:'ready'
    });
    const dbopfs=new DBOPFS();
    const ai=new AI();
    const source=createBrowserModelSource(CHAT_MODEL);
    const modelProvider=createBrowserWasmLlmProvider({
        source,
        store:createDbopfsModelStore({dbopfs})
    });
    const provider=adaptV1LlmProvider(modelProvider);
    ai.providerRuntime.register(provider);
    const llmSelection={
        providerId:provider.id,
        modelId:CHAT_MODEL.id,
        localOnly:true
    };
    ai.configureProviders({
        llm:{default:llmSelection,localOnly:llmSelection},
        stt:currentRoleRoutes(ai.providerRuntime,'stt'),
        tts:currentRoleRoutes(ai.providerRuntime,'tts')
    });
    await ai.configureBrowserSpeech({
        protocol:AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL,
        id:'hello-world-browser-speech',
        dbopfs,
        stt:{
            providerId:speechAuthorities.stt.providerId,
            model:speechAuthorities.stt.model,
            runtime:speechAuthorities.stt.runtime,
            offline:false
        },
        tts:{
            providerId:speechAuthorities.tts.providerId,
            model:speechAuthorities.tts.model,
            runtime:speechAuthorities.tts.runtime,
            offline:false
        }
    });
    return chat.bindSession({
        ai,
        sessionOptions:{
            chatFileName:'hello-world-chat.jsonl',
            loadExisting:true,
            memory:false,
            request:{localOnly:true},
            systemPrompt:'You are the Arcane Hello World assistant. Respond with complete, useful text.'
        }
    });
}

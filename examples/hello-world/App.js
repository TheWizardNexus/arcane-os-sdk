import arcaneThemeReady from 'arcane/ThemeBootstrap';
import 'arcane/HTMLImport';
import DBOPFS from 'arcane/DBOPFS';
import AI, {AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL} from 'arcane/AI';
import waitForComponent from 'arcane/WaitForComponent';
import {
    adaptV1LlmProvider,
    createBrowserModelSource,
    createBrowserWasmLlmProvider,
    createDbopfsModelStore
} from 'arcane-os/ai/browser-wasm';

const chatModel={
    id:'ibm-granite-4.1-3b-q4-k-s',
    url:'https://huggingface.co/ibm-granite/granite-4.1-3b-GGUF/resolve/ab4701481089b58a082ef63cc1cee738887293ff/granite-4.1-3b-Q4_K_S.gguf'
};

const transformersDistribution='https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/';
const speech={
    stt:{
        providerId:'hello-world-browser-whisper',
        model:{
            id:'Xenova/whisper-small',
            repository:'Xenova/whisper-small',
            revision:'2d67713f236afa48a18992566e7647f6ca848e13',
            dtype:'q8'
        },
        runtime:{
            adapter:'transformers-whisper',
            version:'3.5.1',
            revision:'746c8c25bf27c5e0684a20f76889b4bb8d23e295',
            entry:'transformers.js',
            wasmPaths:transformersDistribution,
            files:[{
                path:'transformers.js',
                url:`${transformersDistribution}transformers.js`,
                mediaType:'text/javascript'
            }]
        }
    },
    tts:{
        providerId:'hello-world-browser-kokoro',
        model:{
            id:'onnx-community/Kokoro-82M-v1.0-ONNX',
            repository:'onnx-community/Kokoro-82M-v1.0-ONNX',
            revision:'1939ad2a8e416c0acfeecc08a694d14ef25f2231',
            dtype:'q8',
            defaultVoice:'af_heart'
        },
        runtime:{
            adapter:'kokoro-js',
            version:'1.2.1',
            revision:'664c76a704021239ba59c84dcbaa4d3dece01fe9',
            entry:'kokoro.web.js',
            wasmPaths:transformersDistribution,
            files:[{
                path:'kokoro.web.js',
                url:'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js',
                mediaType:'text/javascript'
            }]
        }
    }
};

const chat=document.querySelector('#hello-world-chat');
chat.name='You';
chat.aiName='Arcane';

await arcaneThemeReady;
await waitForComponent(chat,{
    errorEvent:'html-import-error',
    event:'chat-ready',
    methods:['bindSession'],
    property:'ready'
});

const dbopfs=new DBOPFS();
const ai=new AI();
const source=createBrowserModelSource(chatModel);
const modelProvider=createBrowserWasmLlmProvider({
    source,
    store:createDbopfsModelStore({dbopfs})
});
const provider=adaptV1LlmProvider(modelProvider);
const llmSelection={
    providerId:provider.id,
    modelId:chatModel.id,
    localOnly:true
};

ai.providerRuntime.register(provider);
ai.configureProviders({
    llm:{default:llmSelection,localOnly:llmSelection},
    stt:{
        default:ai.providerRuntime.selection('stt'),
        localOnly:ai.providerRuntime.selection('stt',{localOnly:true})
    },
    tts:{
        default:ai.providerRuntime.selection('tts'),
        localOnly:ai.providerRuntime.selection('tts',{localOnly:true})
    }
});
await ai.configureBrowserSpeech({
    protocol:AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL,
    id:'hello-world-browser-speech',
    dbopfs,
    stt:{...speech.stt,offline:false},
    tts:{...speech.tts,offline:false}
});
await chat.bindSession({
    ai,
    sessionOptions:{
        chatFileName:'hello-world-chat.jsonl',
        loadExisting:true,
        memory:false,
        request:{localOnly:true},
        systemPrompt:'You are the Arcane Hello World assistant. Respond with complete, useful text.'
    }
});

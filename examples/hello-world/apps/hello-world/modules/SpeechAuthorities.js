/*
 * The Arcane OS SDK supplies normalized speech configuration, provider
 * lifecycle, DBOPFS storage, and Worker contracts. It does not redistribute a
 * third-party speech runtime, model, voice, license corpus, or corresponding
 * source. The application selects and licenses every upstream authority below.
 *
 * The defaults below are the maintained, version-pinned upstream selections.
 * Importing this module performs no download. The selected runtime, model, and
 * voice are fetched through their normal upstream providers only after the user
 * activates the matching SDK component control. Nothing is vendored or
 * redistributed.
 * This ordinary browser fixture authors no permissions or security record.
 */
const transformersVersion='3.5.1';
const transformersRevision='746c8c25bf27c5e0684a20f76889b4bb8d23e295';
const transformersDistribution=`https://cdn.jsdelivr.net/npm/@huggingface/transformers@${transformersVersion}/dist/`;

const speechAuthorities={
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
            version:transformersVersion,
            revision:transformersRevision,
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

export default speechAuthorities;

/*
 * The Arcane OS SDK supplies normalized speech configuration, provider
 * lifecycle, DBOPFS storage, and Worker contracts. It does not redistribute a
 * third-party speech runtime, model, voice, license corpus, or corresponding
 * source. The application selects and licenses every upstream authority below.
 *
 * Replace an individual null only after choosing an immutable authority:
 *
 * stt: {
 *     model: {id,repository,revision,files:[]},
 *     runtime: {
 *         adapter:'transformers-whisper',version,revision,entry,wasmPaths,
 *         files:[{path,url,mediaType}]
 *     }
 * }
 *
 * tts: {
 *     model: {
 *         id,repository,revision,defaultVoice,files:[]
 *     },
 *     runtime: {
 *         adapter:'kokoro-js',version,revision,entry,wasmPaths,
 *         files:[{path,url,mediaType}]
 *     }
 * }
 *
 * Default warn-first operation uses secure:false in App.js. It permits an empty
 * or omitted model file inventory so the selected version-pinned upstream
 * provider can fetch its own model and voice assets, and it reports those bytes
 * as unchecked when no optional integrity check ran. Runtime entry files and
 * any wasmPaths must still identify a version-pinned upstream npm/package
 * distribution. Do not use mutable main, master, or latest URLs.
 *
 * An application may deliberately change AI_SECURITY to secure:true only after
 * supplying the complete compatible content-addressed model/runtime graph, file
 * authority, byte lengths, SHA-256 evidence, and licenses. Strict mode rejects
 * remote wasmPaths; immutable HTTPS graph sources remain supported.
 * Changing policy requires an unload and reload; this fixture does not enable
 * or pretend to satisfy that optional hardening mode.
 */
const speechAuthorities=Object.freeze({
    stt:null,
    tts:null
});

export default speechAuthorities;

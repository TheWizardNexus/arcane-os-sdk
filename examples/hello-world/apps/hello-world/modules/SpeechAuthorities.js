/*
 * The Arcane OS SDK supplies the speech lifecycle, storage, verification,
 * isolation, and provider contracts. The application must supply and license every model,
 * runtime, voice, URL, revision, byte length, and SHA-256 authority below.
 *
 * Replace an individual null only after choosing an immutable authority:
 *
 * stt: {
 *     model: {id,repository,revision,files:[{path,url,bytes,sha256,mediaType}]},
 *     runtime: {
 *         adapter:'transformers-whisper',version,revision,entry,
 *         files:[{path,url,bytes,sha256,mediaType}]
 *     }
 * }
 *
 * tts: {
 *     model: {
 *         id,repository,revision,defaultVoice,
 *         files:[{path,url,bytes,sha256,mediaType}]
 *     },
 *     runtime: {
 *         adapter:'kokoro-js',version,revision,entry,
 *         files:[{path,url,bytes,sha256,mediaType}]
 *     }
 * }
 *
 * mediaType is optional. Security policy is not configurable here: App.js
 * enforces secure byte-length and SHA-256 admission for both roles.
 *
 * Every URL must be immutable HTTPS or same-origin authority. Do not use
 * mutable main, master, or latest paths. With appSecurity.secure enabled in
 * App.js, every declared artifact must include bytes and sha256 evidence.
 */
const speechAuthorities=Object.freeze({
    stt:null,
    tts:null
});

export default speechAuthorities;

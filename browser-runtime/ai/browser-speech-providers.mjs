import {
  createBrowserSpeechAuthority,
  isBrowserSpeechAuthority,
  isDbopfsSpeechArtifactStore,
} from "./browser-speech-artifacts.mjs";
import {
  normalizeModelSecurity,
  resolveModelSecurity,
  sameModelSecurity,
} from "./model-controller.mjs";
import {
  createSpeechWorkerClient,
  isSpeechWorkerClient,
} from "./speech-worker-client.mjs";

const AI_PROVIDER_PROTOCOL = "arcane-ai-provider/2";
const ROLE_OPERATION = Object.freeze({ stt: "transcribe", tts: "synthesize" });
const STT_SAMPLE_RATE = 16_000;
const TTS_SAMPLE_RATE = 24_000;
const TTS_RESPONSE_FORMAT = "wav";
const WORKER_FAILURE_CODES = new Set([
  "ARCANE_AI_WORKER_CRASHED",
  "ARCANE_AI_WORKER_MESSAGE_ERROR",
  "ARCANE_AI_ADAPTER_PROTOCOL_MISMATCH",
]);

function providerError(code, message, cause) {
  const error = cause === undefined
    ? new Error(message)
    : new Error(message, { cause });
  error.name = code === "ARCANE_AI_REQUEST_ABORTED"
    ? "AbortError"
    : "ArcaneBrowserSpeechProviderError";
  error.code = code;
  return error;
}

function abortError(signal) {
  return providerError(
    "ARCANE_AI_REQUEST_ABORTED",
    "The browser speech operation was cancelled.",
    signal?.reason,
  );
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function workerFailureCode(error) {
  return WORKER_FAILURE_CODES.has(error?.code)
    ? error.code
    : "ARCANE_AI_WORKER_CRASHED";
}

function requiredIdentifier(value, label) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 128) {
    throw new TypeError(`${label} must be a trimmed 1-128 character string.`);
  }
  return value.trim();
}

function linkSignal(signal) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener?.("abort", abort, { once: true });
  return Object.freeze({
    controller,
    release: () => signal?.removeEventListener?.("abort", abort),
  });
}

function publicStatus({ role, id, authority, state, busy, generation, errorCode, cache }) {
  return Object.freeze({
    role,
    providerId: id,
    modelId: authority.modelId,
    state,
    loaded: state === "ready",
    busy,
    generation,
    errorCode,
    cache,
  });
}

function assertRequestAuthority(context, authority, providerId) {
  if (!Object.hasOwn(context, "selection")) return;
  const selection = context.selection;
  if (selection?.providerId !== providerId
    || selection?.modelId !== authority.modelId
    || selection?.localOnly === false) {
    throw providerError(
      "ARCANE_AI_MODEL_AUTHORITY_REQUIRED",
      "The browser speech request selection changed from its immutable provider authority.",
    );
  }
}

function assertPayloadModel(payload, authority, { required = false } = {}) {
  if (!Object.hasOwn(payload, "model")) {
    if (!required) return;
    throw providerError(
      "ARCANE_AI_MODEL_AUTHORITY_REQUIRED",
      "The shared speech request must identify the provider's immutable model authority.",
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(payload, "model");
  if (!Object.hasOwn(descriptor ?? {}, "value") || descriptor.value !== authority.modelId) {
    throw providerError(
      "ARCANE_AI_MODEL_AUTHORITY_REQUIRED",
      "The shared speech request model does not match this provider authority.",
    );
  }
}

function genericPayloadDescriptors(payload, allowedKeys, requiredKeys, label) {
  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) {
    throw providerError("ARCANE_AI_INVALID_REQUEST", `${label} must be a plain object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(payload);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol" || !allowedKeys.includes(key)) {
      throw providerError("ARCANE_AI_INVALID_REQUEST", `${label} contains an unknown field.`);
    }
    if (!Object.hasOwn(descriptors[key], "value")) {
      throw providerError("ARCANE_AI_INVALID_REQUEST", `${label}.${key} must be a data property.`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(descriptors, key)) {
      throw providerError("ARCANE_AI_INVALID_REQUEST", `${label}.${key} is required.`);
    }
  }
  return descriptors;
}

function audioMimeEssence(value, label) {
  if (typeof value !== "string") {
    throw providerError("ARCANE_AI_INVALID_REQUEST", `${label} must be an audio MIME type.`);
  }
  const essence = value.split(";", 1)[0].trim().toLowerCase();
  if (!/^audio\/[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(essence)) {
    throw providerError("ARCANE_AI_INVALID_REQUEST", `${label} must be an audio MIME type.`);
  }
  return essence;
}

function awaitAbortableSpeechOperation(operation, signal) {
  const observed = Promise.resolve(operation);
  if (!signal) return observed;
  if (signal.aborted) {
    // Blob and Web Audio operations cannot be preempted; retain their eventual
    // rejection after cancellation instead of leaving an unobserved promise.
    observed.catch(function retainCancelledSpeechOperation() {});
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const release = () => signal.removeEventListener("abort", cancel);
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      release();
      callback(value);
    };
    const cancel = () => settle(reject, abortError(signal));
    signal.addEventListener("abort", cancel, { once: true });
    observed.then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error),
    );
  });
}

async function decodeSharedTranscriptionPayload(payload, authority, signal) {
  const descriptors = genericPayloadDescriptors(
    payload,
    ["audio", "mimeType", "model"],
    ["audio", "mimeType", "model"],
    "Shared speech transcription payload",
  );
  assertPayloadModel(payload, authority, { required: true });
  const audio = descriptors.audio.value;
  if (typeof Blob !== "function" || !(audio instanceof Blob) || audio.size < 1) {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Shared speech transcription requires a nonempty audio Blob or File.",
    );
  }
  const mimeType = audioMimeEssence(descriptors.mimeType.value, "Speech transcription mimeType");
  if (audio.type && audioMimeEssence(audio.type, "Speech transcription Blob.type") !== mimeType) {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Speech transcription mimeType does not match the audio Blob type.",
    );
  }
  const OfflineAudioContext = globalThis.OfflineAudioContext
    ?? globalThis.webkitOfflineAudioContext;
  if (typeof OfflineAudioContext !== "function") {
    throw providerError(
      "ARCANE_AI_AUDIO_DECODE_UNAVAILABLE",
      "Shared Blob transcription requires OfflineAudioContext decoding at 16000 Hz.",
    );
  }
  let decoder;
  try {
    decoder = new OfflineAudioContext(1, 1, STT_SAMPLE_RATE);
  } catch (error) {
    throw providerError(
      "ARCANE_AI_AUDIO_DECODE_UNAVAILABLE",
      "Unable to create the required 16000 Hz speech decoder.",
      error,
    );
  }
  if (typeof decoder.decodeAudioData !== "function") {
    throw providerError(
      "ARCANE_AI_AUDIO_DECODE_UNAVAILABLE",
      "Shared Blob transcription requires browser audio decoding.",
    );
  }
  let decoded;
  try {
    const encoded = await awaitAbortableSpeechOperation(audio.arrayBuffer(), signal);
    throwIfAborted(signal);
    decoded = await awaitAbortableSpeechOperation(decoder.decodeAudioData(encoded), signal);
    throwIfAborted(signal);
  } catch (error) {
    if (signal?.aborted && error?.code === "ARCANE_AI_REQUEST_ABORTED") throw error;
    throw providerError(
      "ARCANE_AI_AUDIO_DECODE_FAILED",
      "The browser could not decode the supplied speech audio.",
      error,
    );
  }
  if (decoded?.sampleRate !== STT_SAMPLE_RATE
    || !Number.isSafeInteger(decoded.length)
    || decoded.length < 1
    || !Number.isSafeInteger(decoded.numberOfChannels)
    || decoded.numberOfChannels < 1
    || typeof decoded.getChannelData !== "function") {
    throw providerError(
      "ARCANE_AI_AUDIO_DECODE_FAILED",
      "Decoded speech audio must provide nonempty 16000 Hz channel data.",
    );
  }
  const channels = [];
  for (let index = 0; index < decoded.numberOfChannels; index += 1) {
    const channel = decoded.getChannelData(index);
    if (!(channel instanceof Float32Array) || channel.length !== decoded.length) {
      throw providerError(
        "ARCANE_AI_AUDIO_DECODE_FAILED",
        "Decoded speech audio returned invalid channel data.",
      );
    }
    channels.push(channel);
  }
  const mono = new Float32Array(decoded.length);
  for (let index = 0; index < mono.length; index += 1) {
    let sample = 0;
    for (const channel of channels) sample += channel[index];
    sample /= channels.length;
    if (!Number.isFinite(sample)) {
      throw providerError(
        "ARCANE_AI_AUDIO_DECODE_FAILED",
        "Decoded speech audio contains a non-finite sample.",
      );
    }
    mono[index] = sample;
  }
  throwIfAborted(signal);
  return Object.freeze({
    payload: Object.freeze({ audio: mono, sampleRate: STT_SAMPLE_RATE }),
    shared: true,
  });
}

function cloneNativeTranscriptionPayload(payload, authority) {
  assertPayloadModel(payload, authority);
  if (!(payload.audio instanceof Float32Array) || payload.sampleRate !== STT_SAMPLE_RATE) {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Whisper requires Float32Array audio sampled at exactly 16000 Hz.",
    );
  }
  return Object.freeze({
    payload: Object.freeze({
      audio: new Float32Array(payload.audio),
      sampleRate: STT_SAMPLE_RATE,
    }),
    shared: false,
  });
}

function normalizeSynthesisPayload(payload, authority) {
  const shared = Object.hasOwn(payload, "input");
  let textValue = payload.text;
  if (shared) {
    const descriptors = genericPayloadDescriptors(
      payload,
      ["model", "voice", "input", "responseFormat", "speed"],
      ["model", "input", "responseFormat"],
      "Shared speech synthesis payload",
    );
    assertPayloadModel(payload, authority, { required: true });
    if (descriptors.responseFormat.value !== TTS_RESPONSE_FORMAT) {
      throw providerError(
        "ARCANE_AI_UNSUPPORTED_RESPONSE_FORMAT",
        "Browser Kokoro supports only wav responses for shared speech requests.",
      );
    }
    textValue = descriptors.input.value;
  } else {
    assertPayloadModel(payload, authority);
  }
  const text = typeof textValue === "string" ? textValue.trim() : "";
  const voice = typeof (payload.voice ?? authority.defaultVoice) === "string"
    ? (payload.voice ?? authority.defaultVoice).trim()
    : "";
  const speed = payload.speed ?? 1;
  if (!text || !voice || !Number.isFinite(speed) || speed <= 0 || speed > 4) {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Kokoro requires text, a voice, and speed greater than 0 and at most 4.",
    );
  }
  return Object.freeze({
    payload: Object.freeze({ text, voice, speed }),
    shared,
  });
}

async function normalizeRequestPayload(role, payload, authority, signal) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw providerError("ARCANE_AI_INVALID_REQUEST", "Speech request payload must be an object.");
  }
  if (role === "stt") {
    const audio = Object.getOwnPropertyDescriptor(payload, "audio");
    if (Object.hasOwn(audio ?? {}, "value")
      && typeof Blob === "function"
      && audio.value instanceof Blob) {
      return decodeSharedTranscriptionPayload(payload, authority, signal);
    }
    return cloneNativeTranscriptionPayload(payload, authority);
  }
  return normalizeSynthesisPayload(payload, authority);
}

function encodeSharedSynthesisResult(result) {
  if (!(result?.audio instanceof Float32Array)
    || result.sampleRate !== TTS_SAMPLE_RATE
    || result.audio.length < 1
    || result.audio.length > (0xffffffff - 44) / 2) {
    throw providerError(
      "ARCANE_AI_INVALID_PROVIDER_RESULT",
      "Browser Kokoro must return nonempty 24000 Hz Float32 PCM.",
    );
  }
  const buffer = new ArrayBuffer(44 + result.audio.length * 2);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const writeText = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeText(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TTS_SAMPLE_RATE, true);
  view.setUint32(28, TTS_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, result.audio.length * 2, true);
  for (let index = 0; index < result.audio.length; index += 1) {
    const sample = result.audio[index];
    if (!Number.isFinite(sample)) {
      throw providerError(
        "ARCANE_AI_INVALID_PROVIDER_RESULT",
        "Browser Kokoro returned a non-finite PCM sample.",
      );
    }
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(
      44 + index * 2,
      Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff),
      true,
    );
  }
  return Object.freeze({ audio: bytes, contentType: "audio/wav" });
}

function createBrowserSpeechProvider({
  role,
  id,
  localOnly = true,
  model,
  runtime,
  appSecurity,
  security,
  store,
  offline = false,
} = {}) {
  const providerId = requiredIdentifier(id, "Browser speech provider id");
  if (localOnly !== true) {
    throw new TypeError("Browser speech providers are localOnly.");
  }
  if (typeof offline !== "boolean") {
    throw new TypeError("Browser speech offline must be a boolean.");
  }
  if (!isDbopfsSpeechArtifactStore(store)) {
    throw new TypeError("Browser speech providers require an SDK-created DBOPFS artifact store.");
  }
  const configuredAppSecurity = normalizeModelSecurity(
    appSecurity,
    "Browser speech app security",
  );
  const configuredProviderSecurity = normalizeModelSecurity(
    security,
    "Browser speech provider security",
  );
  const authority = createBrowserSpeechAuthority({
    providerId,
    role,
    model,
    runtime,
    security: configuredProviderSecurity,
  });
  if (!isBrowserSpeechAuthority(authority)) {
    throw new TypeError("Browser speech authority construction failed.");
  }
  const operation = ROLE_OPERATION[role];
  const speech = role === "stt"
    ? Object.freeze({ inputSampleRate: STT_SAMPLE_RATE })
    : Object.freeze({
      outputSampleRate: TTS_SAMPLE_RATE,
      responseFormats: Object.freeze([TTS_RESPONSE_FORMAT]),
      defaultResponseFormat: TTS_RESPONSE_FORMAT,
    });
  const catalogEntry = Object.freeze({
    id: authority.modelId,
    providerId,
    role,
    localOnly: true,
    repository: authority.repository,
    revision: authority.revision,
    runtime: authority.runtime,
    files: authority.files,
    speech,
  });
  let state = "unloaded";
  let errorCode = null;
  let cache = null;
  let generation = 0;
  let active = null;
  let loadOperation = null;
  let unloadOperation = null;
  let disposeOperation = null;
  let requestOperation = null;

  function status() {
    return publicStatus({
      role,
      id: providerId,
      authority,
      state,
      busy: requestOperation !== null,
      generation,
      errorCode,
      cache,
    });
  }

  function releaseSlot(slot) {
    if (!slot || slot.released) return;
    slot.released = true;
    slot.prepared.release();
  }

  async function terminateSlot(slot, reason, { intentional = true } = {}) {
    if (!slot) return;
    if (!isSpeechWorkerClient(slot.client)) {
      throw providerError(
        "ARCANE_AI_ADAPTER_PROTOCOL_MISMATCH",
        "The browser speech Worker client is not SDK-owned.",
      );
    }
    await slot.client.terminate(reason, { intentional });
    releaseSlot(slot);
  }

  const provider = {
    protocol: AI_PROVIDER_PROTOCOL,
    role,
    id: providerId,
    localOnly: true,

    catalog() {
      return Object.freeze([catalogEntry]);
    },

    inspect(selection, { signal } = {}) {
      throwIfAborted(signal);
      const available = selection?.providerId === providerId
        && selection?.modelId === authority.modelId
        && selection?.localOnly !== false;
      if (!available) {
        return Object.freeze({
          available: false,
          code: "ARCANE_AI_MODEL_AUTHORITY_REQUIRED",
          message: "The selected browser speech model does not match this provider authority.",
        });
      }
      return Object.freeze({ available: true, authority });
    },

    status,

    load(context = {}) {
      if (state === "disposed" || disposeOperation) {
        return Promise.reject(providerError("ARCANE_AI_PROVIDER_DISPOSED", "The browser speech provider is disposed."));
      }
      if (unloadOperation || state === "unloading") {
        return Promise.reject(providerError(
          "ARCANE_AI_OPERATION_SUPERSEDED",
          "The browser speech provider is unloading.",
        ));
      }
      if (typeof context.progress !== "function") {
        return Promise.reject(new TypeError("Browser speech load progress must be a function."));
      }
      if (context.role !== role
        || context.selection?.providerId !== providerId
        || context.selection?.modelId !== authority.modelId
        || context.selection?.localOnly === false) {
        return Promise.reject(providerError("ARCANE_AI_MODEL_AUTHORITY_REQUIRED", "Browser speech load selection changed."));
      }
      let effectiveSecurity;
      try {
        effectiveSecurity = resolveModelSecurity({
          app: configuredAppSecurity,
          binding: configuredProviderSecurity,
          load: context.security,
        });
        throwIfAborted(context.signal);
      } catch (error) {
        return Promise.reject(error);
      }
      if (state === "ready" && active) {
        if (sameModelSecurity(active.security, effectiveSecurity)) {
          return Promise.resolve(status());
        }
        return provider.unload().then(() => provider.load(context));
      }
      if (loadOperation) {
        if (sameModelSecurity(loadOperation.security, effectiveSecurity)) {
          return loadOperation.promise;
        }
        loadOperation.abort();
        return loadOperation.promise.catch(() => undefined).then(() => provider.load(context));
      }
      generation += 1;
      const operationGeneration = generation;
      const linked = linkSignal(context.signal);
      state = "loading";
      errorCode = null;
      const promise = (async () => {
        let prepared = null;
        let slot = null;
        try {
          prepared = await store.prepare(authority, {
            signal: linked.controller.signal,
            onProgress: context.progress,
            offline,
            security: effectiveSecurity,
          });
          throwIfAborted(linked.controller.signal);
          if (operationGeneration !== generation) {
            throw providerError("ARCANE_AI_OPERATION_SUPERSEDED", "Browser speech loading was superseded.");
          }
          slot = {
            prepared,
            released: false,
            client: null,
            security: effectiveSecurity,
          };
          slot.client = createSpeechWorkerClient({
            role,
            onTermination({ reason, intentional }) {
              if (active === slot) {
                active = null;
                if (state !== "disposed" && state !== "unloading") {
                  state = intentional ? "unloaded" : "error";
                  errorCode = intentional ? null : workerFailureCode(reason);
                }
                releaseSlot(slot);
              }
            },
          });
          if (!isSpeechWorkerClient(slot.client)) {
            throw providerError(
              "ARCANE_AI_ADAPTER_PROTOCOL_MISMATCH",
              "The browser speech Worker client is not SDK-owned.",
            );
          }
          const configuration = Object.freeze({
            role,
            runtime: prepared.runtime,
            model: prepared.model,
          });
          await slot.client.request("load", { configuration }, {
            signal: linked.controller.signal,
            progress: context.progress,
          });
          throwIfAborted(linked.controller.signal);
          if (operationGeneration !== generation) {
            throw providerError("ARCANE_AI_OPERATION_SUPERSEDED", "Browser speech loading was superseded.");
          }
          active = slot;
          cache = prepared.cache;
          state = "ready";
          return status();
        } catch (error) {
          if (slot) await terminateSlot(slot, error).catch(() => undefined);
          else prepared?.release();
          if (operationGeneration === generation && state !== "unloading" && state !== "disposed") {
            state = error?.code === "ARCANE_AI_REQUEST_ABORTED"
              || error?.code === "ARCANE_AI_OPERATION_SUPERSEDED"
              ? "unloaded"
              : "error";
            errorCode = error?.code ?? "ARCANE_AI_PROVIDER_LOAD_FAILED";
          }
          throw error;
        } finally {
          linked.release();
          if (loadOperation?.promise === promise) loadOperation = null;
        }
      })();
      loadOperation = Object.freeze({
        promise,
        security: effectiveSecurity,
        abort: () => linked.controller.abort(),
      });
      return promise;
    },

    async request(context = {}) {
      if (context.role !== role || context.operation !== operation) {
        throw providerError("ARCANE_AI_INVALID_REQUEST", `Browser ${role} supports only ${operation}.`);
      }
      assertRequestAuthority(context, authority, providerId);
      const externalSignal = context.signal ?? null;
      throwIfAborted(externalSignal);
      if (state !== "ready" || !active) {
        throw providerError("ARCANE_AI_NOT_READY", "The browser speech provider is not ready.");
      }
      if (requestOperation) {
        throw providerError("ARCANE_AI_PROVIDER_BUSY", "The browser speech provider is already processing a request.");
      }
      const linked = linkSignal(externalSignal);
      if (linked.controller.signal.aborted) {
        linked.release();
        throw abortError(externalSignal);
      }
      const slot = active;
      const requestGeneration = generation;
      let workerRequestStarted = false;
      const promise = (async () => {
        const normalized = await normalizeRequestPayload(
          role,
          context.payload,
          authority,
          linked.controller.signal,
        );
        throwIfAborted(linked.controller.signal);
        workerRequestStarted = true;
        const result = await slot.client.request("use", normalized.payload, {
          signal: linked.controller.signal,
        });
        if (requestGeneration !== generation || active !== slot) {
          throw providerError("ARCANE_AI_OPERATION_SUPERSEDED", "The browser speech result was superseded.");
        }
        return role === "tts" && normalized.shared
          ? encodeSharedSynthesisResult(result)
          : result;
      })();
      requestOperation = Object.freeze({
        promise,
        abort: () => linked.controller.abort(),
      });
      try {
        return await promise;
      } catch (error) {
        if (error?.code === "ARCANE_AI_REQUEST_ABORTED"
          && workerRequestStarted
          && active === slot) {
          active = null;
          releaseSlot(slot);
          state = "unloaded";
        }
        throw error;
      } finally {
        linked.release();
        if (requestOperation?.promise === promise) requestOperation = null;
      }
    },

    unload() {
      if (state === "disposed") return Promise.resolve(status());
      if (unloadOperation) return unloadOperation;
      generation += 1;
      state = "unloading";
      errorCode = null;
      loadOperation?.abort();
      requestOperation?.abort();
      const promise = (async () => {
        await Promise.allSettled([
          loadOperation?.promise,
          requestOperation?.promise,
        ].filter(Boolean));
        const slot = active;
        active = null;
        await terminateSlot(slot, providerError(
          "ARCANE_AI_OPERATION_SUPERSEDED",
          "The browser speech Worker was terminated by unload().",
        ));
        cache = null;
        state = "unloaded";
        return status();
      })();
      unloadOperation = promise.finally(() => {
        if (unloadOperation === promise || unloadOperation === wrapped) unloadOperation = null;
      });
      const wrapped = unloadOperation;
      return wrapped;
    },

    dispose() {
      if (state === "disposed") return Promise.resolve(status());
      if (disposeOperation) return disposeOperation;
      const promise = (async () => {
        await provider.unload();
        state = "disposed";
        return status();
      })();
      disposeOperation = promise.then((value) => {
        disposeOperation = null;
        return value;
      }, (error) => {
        disposeOperation = null;
        throw error;
      });
      return disposeOperation;
    },
  };
  return Object.freeze(provider);
}

export function createBrowserWhisperProvider(options = {}) {
  return createBrowserSpeechProvider({
    ...options,
    role: "stt",
    id: options.id ?? "arcane-browser-whisper",
  });
}

export function createBrowserKokoroProvider(options = {}) {
  return createBrowserSpeechProvider({
    ...options,
    role: "tts",
    id: options.id ?? "arcane-browser-kokoro",
  });
}

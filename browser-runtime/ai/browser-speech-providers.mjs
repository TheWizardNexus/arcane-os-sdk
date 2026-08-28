import {
  createBrowserSpeechAuthority,
  isBrowserSpeechArtifactGraph,
  isBrowserSpeechArtifactError,
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
  isSpeechWorkerClientError,
} from "./speech-worker-client.mjs";

const AI_PROVIDER_PROTOCOL = "arcane-ai-provider/2";
const AI_MODEL_AUTHORITY_PROTOCOL = "arcane-ai-model-authority/1";
const ROLE_OPERATION = Object.freeze({ stt: "transcribe", tts: "synthesize" });
const STT_SAMPLE_RATE = 16_000;
const TTS_SAMPLE_RATE = 24_000;
const TTS_RESPONSE_FORMAT = "wav";
const ROLE_REQUEST_REASON = Object.freeze({
  stt: "stt-transcription-cancelled",
  tts: "tts-synthesis-cancelled",
});
const UNMAPPED_PROVIDER_REASON = "browser-speech-provider-error-reason-unmapped";
const WORKER_FAILURE_CODES = new Set([
  "ARCANE_AI_WORKER_CRASHED",
  "ARCANE_AI_WORKER_MESSAGE_ERROR",
  "ARCANE_AI_WORKER_MESSAGE_REJECTED",
  "ARCANE_AI_ADAPTER_PROTOCOL_MISMATCH",
]);
const PROVIDER_ERRORS = new WeakSet();

function providerError(code, message, cause, reason) {
  const error = cause === undefined
    ? new Error(message)
    : new Error(message, { cause });
  error.name = code === "ARCANE_AI_REQUEST_ABORTED"
    ? "AbortError"
    : "ArcaneBrowserSpeechProviderError";
  error.code = code;
  error.reason = typeof reason === "string" && reason
    ? reason
    : UNMAPPED_PROVIDER_REASON;
  PROVIDER_ERRORS.add(error);
  return error;
}

function isBrowserSpeechProviderError(value) {
  return typeof value === "object"
    && value !== null
    && PROVIDER_ERRORS.has(value);
}

function isTrustedSpeechError(value) {
  return isBrowserSpeechProviderError(value)
    || isBrowserSpeechArtifactError(value)
    || isSpeechWorkerClientError(value);
}

function trustedLoadFailure(error, role) {
  if (isTrustedSpeechError(error)) return error;
  return providerError(
    "ARCANE_AI_PROVIDER_LOAD_FAILED",
    `The browser ${role} provider load was rejected.`,
    error,
    `${role}-provider-load-rejected`,
  );
}

function trustedRequestFailure(error, role) {
  if (isTrustedSpeechError(error)) return error;
  return providerError(
    "ARCANE_AI_PROVIDER_REQUEST_FAILED",
    `The browser ${role} engine operation was rejected.`,
    error,
    role === "stt"
      ? "stt-transcription-engine-operation-rejected"
      : "tts-synthesis-engine-operation-rejected",
  );
}

function trustedWorkerFailure(error, role) {
  if (isTrustedSpeechError(error)) return error;
  return providerError(
    "ARCANE_AI_WORKER_MESSAGE_REJECTED",
    `The browser ${role} Worker returned an untrusted error envelope.`,
    error,
    `${role}-worker-error-envelope-rejected`,
  );
}

function trustedLifecycleFailure(error, role, operation) {
  if (isTrustedSpeechError(error)) return error;
  return providerError(
    "ARCANE_AI_INVALID_REQUEST",
    `The browser ${role} ${operation} context could not be read.`,
    error,
    `${role}-provider-${operation}-context-read-rejected`,
  );
}

function resolveReason(reason, fallback = UNMAPPED_PROVIDER_REASON) {
  const resolved = typeof reason === "function" ? reason() : reason;
  return typeof resolved === "string" && resolved ? resolved : fallback;
}

function abortError(signal, reason = UNMAPPED_PROVIDER_REASON) {
  return providerError(
    "ARCANE_AI_REQUEST_ABORTED",
    "The browser speech operation was cancelled.",
    signal?.reason,
    resolveReason(reason),
  );
}

function throwIfAborted(signal, reason) {
  if (signal?.aborted) throw abortError(signal, reason);
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

function createProviderAuthority({
  providerId,
  role,
  graph,
  model,
  runtime,
  security,
}) {
  if (graph !== undefined) {
    if (model !== undefined || runtime !== undefined) {
      throw new TypeError("Browser speech graph is mutually exclusive with legacy model and runtime descriptors.");
    }
    if (!isBrowserSpeechArtifactGraph(graph)) {
      throw new TypeError("Browser speech graph must be created by createBrowserSpeechArtifactGraph().");
    }
    if (graph.role !== role) {
      throw new TypeError(`Browser speech graph role must be ${role}.`);
    }
    if (graph.providerId !== null
      && graph.providerId !== undefined
      && graph.providerId !== providerId) {
      throw new TypeError("Browser speech graph providerId must match the provider id.");
    }
    return Object.freeze({
      protocol: AI_MODEL_AUTHORITY_PROTOCOL,
      admitted: true,
      graph,
      artifactGraphProtocol: graph.protocol,
      providerId,
      role,
      modelId: graph.model.id,
      repository: graph.model.repository,
      revision: graph.model.revision,
      dtype: graph.model.dtype,
      defaultVoice: graph.model.defaultVoice,
      voices: graph.model.voices ?? Object.freeze([]),
      inputSampleRate: graph.model.inputSampleRate,
      outputSampleRate: graph.model.outputSampleRate,
      runtime: graph.runtime,
      files: graph.files,
      security,
      artifactGraphId: graph.identitySha256,
    });
  }
  const authority = createBrowserSpeechAuthority({
    providerId,
    role,
    model,
    runtime,
    security,
  });
  if (!isBrowserSpeechAuthority(authority)) {
    throw new TypeError("Browser speech authority construction did not return an SDK authority.");
  }
  return authority;
}

function inputSampleRate(authority) {
  return authority.graph ? authority.inputSampleRate : STT_SAMPLE_RATE;
}

function outputSampleRate(authority) {
  return authority.graph ? authority.outputSampleRate : TTS_SAMPLE_RATE;
}

function linkSignal(signal) {
  const controller = new AbortController();
  let internalReason = null;
  let internalCode = null;
  const forwardExternalAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardExternalAbort();
  else signal?.addEventListener?.("abort", forwardExternalAbort, { once: true });
  return Object.freeze({
    controller,
    abort(reason, code = "ARCANE_AI_REQUEST_ABORTED") {
      if (controller.signal.aborted) return;
      internalReason = resolveReason(reason);
      internalCode = code;
      controller.abort(internalReason);
    },
    code() {
      return internalCode;
    },
    reason(fallback) {
      return internalReason ?? resolveReason(fallback);
    },
    release: () => signal?.removeEventListener?.("abort", forwardExternalAbort),
  });
}

function linkedAbortFailure(linked, fallbackReason) {
  const reason = linked.reason(fallbackReason);
  const code = linked.code();
  if (code === "ARCANE_AI_OPERATION_SUPERSEDED") {
    return providerError(
      "ARCANE_AI_OPERATION_SUPERSEDED",
      "The browser speech operation was superseded.",
      linked.controller.signal.reason,
      reason,
    );
  }
  if (code === "ARCANE_AI_LOAD_PROGRESS_CALLBACK_THREW") {
    return providerError(
      code,
      "The browser speech load progress callback was rejected.",
      linked.controller.signal.reason,
      reason,
    );
  }
  if (code === "ARCANE_AI_PROVIDER_LOAD_FAILED") {
    return providerError(
      code,
      "The browser speech provider load was rejected.",
      linked.controller.signal.reason,
      reason,
    );
  }
  return abortError(linked.controller.signal, reason);
}

function isAbortSignal(value) {
  return value === null
    || value === undefined
    || (typeof value === "object"
      && typeof value.aborted === "boolean"
      && typeof value.addEventListener === "function"
      && typeof value.removeEventListener === "function");
}

function providerContext(context, role, operation) {
  if (context === undefined) return Object.freeze({ signal: null });
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      `Browser ${role} ${operation} context must be an object.`,
      undefined,
      `${role}-provider-${operation}-context-not-object`,
    );
  }
  if (Object.hasOwn(context, "role") && context.role !== role) {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      `Browser ${role} ${operation} context role does not match the provider.`,
      undefined,
      `${role}-provider-${operation}-role-mismatch`,
    );
  }
  const signal = context.signal ?? null;
  if (!isAbortSignal(signal)) {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      `Browser ${role} ${operation} signal must be an AbortSignal.`,
      undefined,
      `${role}-provider-${operation}-signal-not-abort-signal`,
    );
  }
  return Object.freeze({ context, signal });
}

function graphSecurity(scope, label) {
  return normalizeModelSecurity(scope, label);
}

function publicStatus({
  role,
  id,
  authority,
  state,
  busy,
  generation,
  errorCode,
  cache,
  lifecycleReason,
  activeOperation,
  artifactGraphAdmission,
  security,
}) {
  return Object.freeze({
    role,
    providerId: id,
    modelId: authority.modelId,
    state,
    lifecycleStatus: `${role}-provider-${state}`,
    lifecycleReason,
    activeOperation,
    loaded: state === "ready",
    busy,
    generation,
    errorCode,
    cache,
    security,
    artifactGraphId: authority.artifactGraphId ?? null,
    artifactGraphAdmission,
  });
}

function assertRequestAuthority(
  context,
  authority,
  providerId,
  reason = `${authority.role}-provider-request-selection-authority-mismatch`,
) {
  if (!Object.hasOwn(context, "selection")) return;
  const selection = context.selection;
  if (selection?.providerId !== providerId
    || selection?.modelId !== authority.modelId
    || (Object.hasOwn(selection ?? {}, "role") && selection.role !== authority.role)
    || selection?.localOnly === false) {
    throw providerError(
      "ARCANE_AI_MODEL_AUTHORITY_REQUIRED",
      "The browser speech request selection changed from its immutable provider authority.",
      undefined,
      reason,
    );
  }
}

function assertPayloadModel(payload, authority, {
  required = false,
  operationSubject = authority.role === "stt" ? "stt-transcription" : "tts-synthesis",
} = {}) {
  if (!Object.hasOwn(payload, "model")) {
    if (!required) return;
    throw providerError(
      "ARCANE_AI_MODEL_AUTHORITY_REQUIRED",
      "The shared speech request must identify the provider's immutable model authority.",
      undefined,
      `${operationSubject}-model-authority-missing`,
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(payload, "model");
  if (!Object.hasOwn(descriptor ?? {}, "value") || descriptor.value !== authority.modelId) {
    throw providerError(
      "ARCANE_AI_MODEL_AUTHORITY_REQUIRED",
      "The shared speech request model does not match this provider authority.",
      undefined,
      `${operationSubject}-model-authority-mismatch`,
    );
  }
}

function genericPayloadDescriptors(
  payload,
  allowedKeys,
  requiredKeys,
  label,
  operationSubject,
) {
  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      `${label} must be a plain object.`,
      undefined,
      `${operationSubject}-payload-not-plain-object`,
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(payload);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol" || !allowedKeys.includes(key)) {
      throw providerError(
        "ARCANE_AI_INVALID_REQUEST",
        `${label} contains an unknown field.`,
        undefined,
        `${operationSubject}-payload-field-unknown`,
      );
    }
    if (!Object.hasOwn(descriptors[key], "value")) {
      throw providerError(
        "ARCANE_AI_INVALID_REQUEST",
        `${label}.${key} must be a data property.`,
        undefined,
        `${operationSubject}-payload-accessor-rejected`,
      );
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(descriptors, key)) {
      throw providerError(
        "ARCANE_AI_INVALID_REQUEST",
        `${label}.${key} is required.`,
        undefined,
        `${operationSubject}-payload-required-field-missing`,
      );
    }
  }
  return descriptors;
}

function audioMimeEssence(value, label, reasonPrefix) {
  if (typeof value !== "string") {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      `${label} must be an audio MIME type.`,
      undefined,
      `${reasonPrefix}-not-string`,
    );
  }
  const essence = value.split(";", 1)[0].trim().toLowerCase();
  if (!/^audio\/[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(essence)) {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      `${label} must be an audio MIME type.`,
      undefined,
      `${reasonPrefix}-malformed`,
    );
  }
  return essence;
}

function awaitAbortableSpeechOperation(operation, signal, reason) {
  const observed = Promise.resolve(operation);
  if (!signal) return observed;
  if (signal.aborted) {
    // Blob and Web Audio operations cannot be preempted; retain their eventual
    // rejection after cancellation instead of leaving an unobserved promise.
    observed.catch(function retainCancelledSpeechOperation() {});
    return Promise.reject(abortError(signal, reason));
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
    const cancel = () => settle(reject, abortError(signal, reason));
    signal.addEventListener("abort", cancel, { once: true });
    observed.then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error),
    );
  });
}

function observeLoadOperation(record, { signal, progress }, role) {
  if (signal?.aborted) {
    return Promise.reject(abortError(signal, `${role}-load-cancelled`));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const release = () => {
      try {
        signal?.removeEventListener?.("abort", cancel);
        return null;
      } catch (error) {
        return error;
      }
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      record.observers.delete(observer);
      const releaseError = release();
      if (releaseError) {
        reject(trustedLoadFailure(releaseError, role));
        return;
      }
      callback(value);
    };
    const abandonIfUnobserved = (
      reason,
      code = "ARCANE_AI_REQUEST_ABORTED",
    ) => {
      if (!record.settled && record.observers.size === 0) record.abort(reason, code);
    };
    const cancel = () => {
      settle(reject, abortError(signal, `${role}-load-cancelled`));
      abandonIfUnobserved(`${role}-load-cancelled`);
    };
    const observer = Object.freeze({
      progress(value) {
        if (settled) return;
        try {
          progress(value);
        } catch (error) {
          settle(reject, providerError(
            "ARCANE_AI_LOAD_PROGRESS_CALLBACK_THREW",
            `Browser ${role} load progress callback threw.`,
            error,
            `${role}-load-progress-callback-threw`,
          ));
          abandonIfUnobserved(
            `${role}-load-progress-callback-threw`,
            "ARCANE_AI_LOAD_PROGRESS_CALLBACK_THREW",
          );
        }
      },
    });
    record.observers.add(observer);
    record.promise.then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error),
    );
    try {
      signal?.addEventListener?.("abort", cancel, { once: true });
    } catch (error) {
      settled = true;
      record.observers.delete(observer);
      reject(trustedLoadFailure(error, role));
      abandonIfUnobserved(
        `${role}-provider-load-rejected`,
        "ARCANE_AI_PROVIDER_LOAD_FAILED",
      );
      return;
    }
    if (record.hasProgress) observer.progress(record.latestProgress);
  });
}

async function decodeSharedTranscriptionPayload(
  payload,
  authority,
  signal,
  cancellationReason = "stt-transcription-cancelled",
) {
  const sampleRate = inputSampleRate(authority);
  const descriptors = genericPayloadDescriptors(
    payload,
    ["audio", "mimeType", "model"],
    ["audio", "mimeType", "model"],
    "Shared speech transcription payload",
    "stt-transcription",
  );
  assertPayloadModel(payload, authority, {
    required: true,
    operationSubject: "stt-transcription",
  });
  const audio = descriptors.audio.value;
  if (typeof Blob !== "function") {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Shared speech transcription requires the browser Blob constructor.",
      undefined,
      "stt-transcription-blob-constructor-unavailable",
    );
  }
  if (!(audio instanceof Blob)) {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Shared speech transcription audio must be a Blob or File.",
      undefined,
      "stt-transcription-audio-not-blob-or-file",
    );
  }
  if (audio.size < 1) {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Shared speech transcription audio Blob or File must be nonempty.",
      undefined,
      "stt-transcription-audio-blob-empty",
    );
  }
  const mimeType = audioMimeEssence(
    descriptors.mimeType.value,
    "Speech transcription mimeType",
    "stt-transcription-mime-type",
  );
  if (audio.type && audioMimeEssence(
    audio.type,
    "Speech transcription Blob.type",
    "stt-transcription-audio-blob-mime-type",
  ) !== mimeType) {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Speech transcription mimeType does not match the audio Blob type.",
      undefined,
      "stt-transcription-audio-blob-mime-type-mismatch",
    );
  }
  const OfflineAudioContext = globalThis.OfflineAudioContext
    ?? globalThis.webkitOfflineAudioContext;
  if (typeof OfflineAudioContext !== "function") {
    throw providerError(
      "ARCANE_AI_AUDIO_DECODE_UNAVAILABLE",
      `Shared Blob transcription requires OfflineAudioContext decoding at ${sampleRate} Hz.`,
      undefined,
      "stt-browser-offline-audio-context-unavailable",
    );
  }
  let decoder;
  try {
    decoder = new OfflineAudioContext(1, 1, sampleRate);
  } catch (error) {
    throw providerError(
      "ARCANE_AI_AUDIO_DECODE_UNAVAILABLE",
      `Unable to create the required ${sampleRate} Hz speech decoder.`,
      error,
      "stt-browser-offline-audio-context-construction-rejected",
    );
  }
  if (typeof decoder.decodeAudioData !== "function") {
    throw providerError(
      "ARCANE_AI_AUDIO_DECODE_UNAVAILABLE",
      "Shared Blob transcription requires browser audio decoding.",
      undefined,
      "stt-browser-audio-decode-method-unavailable",
    );
  }
  let decoded;
  try {
    const encoded = await awaitAbortableSpeechOperation(
      audio.arrayBuffer(),
      signal,
      cancellationReason,
    );
    throwIfAborted(signal, cancellationReason);
    decoded = await awaitAbortableSpeechOperation(
      decoder.decodeAudioData(encoded),
      signal,
      cancellationReason,
    );
    throwIfAborted(signal, cancellationReason);
  } catch (error) {
    if (signal?.aborted && error?.code === "ARCANE_AI_REQUEST_ABORTED") throw error;
    throw providerError(
      "ARCANE_AI_AUDIO_DECODE_FAILED",
      "The browser could not decode the supplied speech audio.",
      error,
      "stt-browser-audio-decode-operation-rejected",
    );
  }
  if (!decoded || typeof decoded !== "object") {
    throw providerError(
      "ARCANE_AI_AUDIO_DECODE_FAILED",
      "Decoded speech audio must be an AudioBuffer-like object.",
      undefined,
      "stt-browser-decoded-audio-not-object",
    );
  }
  if (decoded.sampleRate !== sampleRate) {
    throw providerError(
      "ARCANE_AI_AUDIO_DECODE_FAILED",
      `Decoded speech audio must be sampled at ${sampleRate} Hz.`,
      undefined,
      "stt-browser-decoded-audio-sample-rate-mismatch",
    );
  }
  if (!Number.isSafeInteger(decoded.length)) {
    throw providerError(
      "ARCANE_AI_AUDIO_DECODE_FAILED",
      "Decoded speech audio frame length must be a safe integer.",
      undefined,
      "stt-browser-decoded-audio-frame-length-not-safe-integer",
    );
  }
  if (decoded.length < 1) {
    throw providerError(
      "ARCANE_AI_AUDIO_DECODE_FAILED",
      "Decoded speech audio must contain at least one frame.",
      undefined,
      "stt-browser-decoded-audio-empty",
    );
  }
  if (!Number.isSafeInteger(decoded.numberOfChannels)) {
    throw providerError(
      "ARCANE_AI_AUDIO_DECODE_FAILED",
      "Decoded speech audio channel count must be a safe integer.",
      undefined,
      "stt-browser-decoded-audio-channel-count-not-safe-integer",
    );
  }
  if (decoded.numberOfChannels < 1) {
    throw providerError(
      "ARCANE_AI_AUDIO_DECODE_FAILED",
      "Decoded speech audio must contain at least one channel.",
      undefined,
      "stt-browser-decoded-audio-channel-count-zero",
    );
  }
  if (typeof decoded.getChannelData !== "function") {
    throw providerError(
      "ARCANE_AI_AUDIO_DECODE_FAILED",
      "Decoded speech audio must expose getChannelData().",
      undefined,
      "stt-browser-decoded-audio-get-channel-data-not-function",
    );
  }
  const channels = [];
  for (let index = 0; index < decoded.numberOfChannels; index += 1) {
    let channel;
    try {
      channel = decoded.getChannelData(index);
    } catch (error) {
      throw providerError(
        "ARCANE_AI_AUDIO_DECODE_FAILED",
        "Decoded speech audio channel access was rejected.",
        error,
        "stt-browser-decoded-audio-channel-read-rejected",
      );
    }
    if (!(channel instanceof Float32Array)) {
      throw providerError(
        "ARCANE_AI_AUDIO_DECODE_FAILED",
        "Decoded speech audio channels must be Float32Array values.",
        undefined,
        "stt-browser-decoded-audio-channel-not-float32-array",
      );
    }
    if (channel.length !== decoded.length) {
      throw providerError(
        "ARCANE_AI_AUDIO_DECODE_FAILED",
        "Decoded speech audio channel length must match the decoded frame length.",
        undefined,
        "stt-browser-decoded-audio-channel-length-mismatch",
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
        undefined,
        "stt-browser-decoded-audio-sample-non-finite",
      );
    }
    mono[index] = sample;
  }
  throwIfAborted(signal, cancellationReason);
  return Object.freeze({
    payload: Object.freeze({ audio: mono, sampleRate }),
    shared: true,
  });
}

function cloneNativeTranscriptionPayload(payload, authority) {
  const descriptors = genericPayloadDescriptors(
    payload,
    ["audio", "sampleRate", "model"],
    ["audio", "sampleRate"],
    "Browser Whisper transcription payload",
    "stt-transcription",
  );
  assertPayloadModel(payload, authority, { operationSubject: "stt-transcription" });
  const sampleRate = inputSampleRate(authority);
  if (!(descriptors.audio.value instanceof Float32Array)) {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Whisper requires Float32Array audio.",
      undefined,
      "stt-transcription-audio-not-float32-array",
    );
  }
  if (descriptors.audio.value.length < 1) {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Whisper requires nonempty Float32 PCM audio.",
      undefined,
      "stt-transcription-pcm-input-empty",
    );
  }
  if (descriptors.sampleRate.value !== sampleRate) {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      `Whisper requires audio sampled at exactly ${sampleRate} Hz.`,
      undefined,
      "stt-transcription-sample-rate-mismatch",
    );
  }
  for (const sample of descriptors.audio.value) {
    if (!Number.isFinite(sample)) {
      throw providerError(
        "ARCANE_AI_INVALID_REQUEST",
        "Whisper audio must contain only finite Float32 PCM samples.",
        undefined,
        "stt-transcription-pcm-sample-non-finite",
      );
    }
  }
  return Object.freeze({
    payload: Object.freeze({
      audio: new Float32Array(descriptors.audio.value),
      sampleRate,
    }),
    shared: false,
  });
}

function normalizeSynthesisPayload(payload, authority) {
  const shared = Object.hasOwn(payload, "input");
  let descriptors;
  let textValue;
  if (shared) {
    descriptors = genericPayloadDescriptors(
      payload,
      ["model", "voice", "input", "responseFormat", "speed"],
      ["model", "input", "responseFormat"],
      "Shared speech synthesis payload",
      "tts-synthesis",
    );
    assertPayloadModel(payload, authority, {
      required: true,
      operationSubject: "tts-synthesis",
    });
    if (descriptors.responseFormat.value !== TTS_RESPONSE_FORMAT) {
      throw providerError(
        "ARCANE_AI_UNSUPPORTED_RESPONSE_FORMAT",
        "Browser Kokoro supports only wav responses for shared speech requests.",
        undefined,
        "tts-synthesis-response-format-not-wav",
      );
    }
    textValue = descriptors.input.value;
  } else {
    descriptors = genericPayloadDescriptors(
      payload,
      ["model", "voice", "text", "speed"],
      ["text"],
      "Browser Kokoro synthesis payload",
      "tts-synthesis",
    );
    assertPayloadModel(payload, authority, { operationSubject: "tts-synthesis" });
    textValue = descriptors.text.value;
  }
  const text = typeof textValue === "string" ? textValue.trim() : "";
  const voiceValue = Object.hasOwn(descriptors, "voice")
    ? descriptors.voice.value
    : authority.defaultVoice;
  const voice = typeof voiceValue === "string"
    ? voiceValue.trim()
    : "";
  const speed = Object.hasOwn(descriptors, "speed") ? descriptors.speed.value : 1;
  if (!text) {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Kokoro requires nonempty text.",
      undefined,
      "tts-synthesis-text-empty",
    );
  }
  if (!voice) {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Kokoro requires a nonempty voice id.",
      undefined,
      "tts-synthesis-voice-empty",
    );
  }
  if (!Number.isFinite(speed) || speed <= 0 || speed > 4) {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Kokoro speed must be greater than 0 and at most 4.",
      undefined,
      "tts-synthesis-speed-out-of-range",
    );
  }
  if (authority.graph
    && !authority.voices.some((candidate) => candidate.id === voice)) {
    throw providerError(
      "ARCANE_AI_MODEL_AUTHORITY_REQUIRED",
      "Kokoro voice must match a caller-declared authenticated voice artifact.",
      undefined,
      "tts-synthesis-voice-not-declared",
    );
  }
  return Object.freeze({
    payload: Object.freeze({ text, voice, speed }),
    shared,
  });
}

async function normalizeRequestPayload(
  role,
  payload,
  authority,
  signal,
  cancellationReason,
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw providerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Speech request payload must be an object.",
      undefined,
      role === "stt"
        ? "stt-transcription-payload-not-object"
        : "tts-synthesis-payload-not-object",
    );
  }
  if (role === "stt") {
    const audio = Object.getOwnPropertyDescriptor(payload, "audio");
    if (Object.hasOwn(payload, "mimeType")
      || (Object.hasOwn(audio ?? {}, "value")
        && typeof Blob === "function"
        && audio.value instanceof Blob)) {
      return decodeSharedTranscriptionPayload(
        payload,
        authority,
        signal,
        cancellationReason,
      );
    }
    return cloneNativeTranscriptionPayload(payload, authority);
  }
  return normalizeSynthesisPayload(payload, authority);
}

function encodeSharedSynthesisResult(result, authority) {
  const sampleRate = outputSampleRate(authority);
  if (!result || typeof result !== "object") {
    throw providerError(
      "ARCANE_AI_INVALID_PROVIDER_RESULT",
      "Browser Kokoro must return a synthesis result object.",
      undefined,
      "tts-synthesis-result-not-object",
    );
  }
  if (!(result.audio instanceof Float32Array)) {
    throw providerError(
      "ARCANE_AI_INVALID_PROVIDER_RESULT",
      "Browser Kokoro must return Float32 PCM audio.",
      undefined,
      "tts-synthesis-result-audio-not-float32-array",
    );
  }
  if (result.sampleRate !== sampleRate) {
    throw providerError(
      "ARCANE_AI_INVALID_PROVIDER_RESULT",
      `Browser Kokoro must return audio sampled at ${sampleRate} Hz.`,
      undefined,
      "tts-synthesis-result-sample-rate-mismatch",
    );
  }
  if (result.audio.length < 1) {
    throw providerError(
      "ARCANE_AI_INVALID_PROVIDER_RESULT",
      "Browser Kokoro must return nonempty PCM audio.",
      undefined,
      "tts-synthesis-result-audio-empty",
    );
  }
  if (result.audio.length > (0xffffffff - 44) / 2) {
    throw providerError(
      "ARCANE_AI_INVALID_PROVIDER_RESULT",
      "Browser Kokoro PCM audio exceeds the WAV byte-length boundary.",
      undefined,
      "tts-synthesis-result-wav-byte-length-overflow",
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
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
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
        undefined,
        "tts-synthesis-pcm-sample-non-finite",
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
  graph,
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
  const authority = createProviderAuthority({
    providerId,
    role,
    graph,
    model,
    runtime,
    security: configuredProviderSecurity,
  });
  const defaultSecurity = resolveModelSecurity({
    app: configuredAppSecurity,
    binding: configuredProviderSecurity,
  });
  const operation = ROLE_OPERATION[role];
  const speech = role === "stt"
    ? Object.freeze({ inputSampleRate: inputSampleRate(authority) })
    : Object.freeze({
      outputSampleRate: outputSampleRate(authority),
      responseFormats: Object.freeze([TTS_RESPONSE_FORMAT]),
      defaultResponseFormat: TTS_RESPONSE_FORMAT,
    });
  const catalogEntry = Object.freeze({
    id: authority.modelId,
    providerId,
    role,
    localOnly: true,
    ...(role === "tts" ? { defaultVoice: authority.defaultVoice } : {}),
    repository: authority.repository,
    revision: authority.revision,
    ...(authority.dtype ? { dtype: authority.dtype } : {}),
    runtime: authority.runtime,
    files: authority.files,
    ...(authority.graph ? {
      artifactGraphId: authority.artifactGraphId,
      voices: authority.voices,
    } : {}),
    speech,
  });
  let state = "unloaded";
  let errorCode = null;
  let cache = null;
  let artifactGraphAdmission = null;
  let lifecycleReason = `${role}-provider-created`;
  let activeOperation = null;
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
      lifecycleReason,
      activeOperation,
      artifactGraphAdmission,
      security: active?.security ?? loadOperation?.security ?? defaultSecurity,
    });
  }

  function releaseSlot(slot) {
    if (!slot || slot.released) return;
    slot.prepared.release();
    slot.released = true;
  }

  async function terminateSlot(slot, reason, { intentional = true } = {}) {
    if (!slot) return;
    if (!isSpeechWorkerClient(slot.client)) {
      throw providerError(
        "ARCANE_AI_ADAPTER_PROTOCOL_MISMATCH",
        "The browser speech Worker client is not SDK-owned.",
        undefined,
        `${role}-worker-client-authority-mismatch`,
      );
    }
    const trustedReason = trustedWorkerFailure(reason, role);
    try {
      await slot.client.terminate(trustedReason, { intentional });
    } catch (error) {
      throw trustedWorkerFailure(error, role);
    } finally {
      try {
        releaseSlot(slot);
      } catch (error) {
        throw trustedWorkerFailure(error, role);
      }
    }
  }

  const provider = {
    protocol: AI_PROVIDER_PROTOCOL,
    role,
    id: providerId,
    localOnly: true,

    catalog() {
      return Object.freeze([catalogEntry]);
    },

    inspect(selection, context = {}) {
      const inspection = providerContext(context, role, "inspection");
      const { signal } = inspection;
      throwIfAborted(signal, `${role}-provider-inspection-cancelled`);
      const available = selection?.providerId === providerId
        && selection?.modelId === authority.modelId
        && (!Object.hasOwn(selection ?? {}, "role") || selection.role === role)
        && selection?.localOnly !== false;
      if (!available) {
        return Object.freeze({
          available: false,
          code: "ARCANE_AI_MODEL_AUTHORITY_REQUIRED",
          message: "The selected browser speech model does not match this provider authority.",
          reason: `${role}-provider-inspection-selection-authority-mismatch`,
        });
      }
      return Object.freeze({ available: true, authority });
    },

    status,

    load(context = {}) {
      let loadContext;
      try {
        loadContext = providerContext(context, role, "load");
      } catch (error) {
        return Promise.reject(trustedLoadFailure(error, role));
      }
      const loadSignal = loadContext.signal;
      let contextRole;
      try {
        contextRole = context.role;
      } catch (error) {
        return Promise.reject(trustedLoadFailure(error, role));
      }
      if (contextRole !== role) {
        return Promise.reject(providerError(
          "ARCANE_AI_INVALID_REQUEST",
          `Browser ${role} load role does not match the provider.`,
          undefined,
          `${role}-provider-load-role-mismatch`,
        ));
      }
      if (state === "disposed" || disposeOperation) {
        return Promise.reject(providerError(
          "ARCANE_AI_PROVIDER_DISPOSED",
          "The browser speech provider is disposed.",
          undefined,
          `${role}-provider-load-rejected-after-dispose`,
        ));
      }
      if (unloadOperation || state === "unloading") {
        return Promise.reject(providerError(
          "ARCANE_AI_OPERATION_SUPERSEDED",
          "The browser speech provider is unloading.",
          undefined,
          `${role}-load-rejected-during-unload`,
        ));
      }
      let loadProgress;
      let selectionProviderId;
      let selectionModelId;
      let selectionLocalOnly;
      let selectionRoleMismatch;
      try {
        loadProgress = context.progress;
        const selection = context.selection;
        selectionProviderId = selection?.providerId;
        selectionModelId = selection?.modelId;
        selectionLocalOnly = selection?.localOnly;
        selectionRoleMismatch = Object.hasOwn(selection ?? {}, "role")
          && selection.role !== role;
      } catch (error) {
        return Promise.reject(trustedLoadFailure(error, role));
      }
      if (typeof loadProgress !== "function") {
        return Promise.reject(providerError(
          "ARCANE_AI_INVALID_REQUEST",
          "Browser speech load progress must be a function.",
          undefined,
          `${role}-load-progress-callback-not-function`,
        ));
      }
      if (selectionProviderId !== providerId
        || selectionModelId !== authority.modelId
        || selectionRoleMismatch
        || selectionLocalOnly === false) {
        return Promise.reject(providerError(
          "ARCANE_AI_MODEL_AUTHORITY_REQUIRED",
          "Browser speech load selection changed.",
          undefined,
          `${role}-load-selection-authority-mismatch`,
        ));
      }
      let effectiveSecurity;
      try {
        if (authority.graph) {
          effectiveSecurity = resolveModelSecurity({
            app: graphSecurity(
              configuredAppSecurity,
              "Browser speech graph app security",
            ),
            binding: graphSecurity(
              configuredProviderSecurity,
              "Browser speech graph provider security",
            ),
            load: graphSecurity(
              context.security,
              "Browser speech graph load security",
            ),
          });
          if (effectiveSecurity.secure !== true) {
            throw providerError(
              "ARCANE_AI_SECURE_MODE_REQUIRED",
              "Authenticated browser speech artifact graphs require explicit secure:true.",
              undefined,
              `${role}-artifact-graph-secure-mode-required`,
            );
          }
        } else {
          effectiveSecurity = resolveModelSecurity({
            app: configuredAppSecurity,
            binding: configuredProviderSecurity,
            load: context.security,
          });
        }
        throwIfAborted(loadSignal, `${role}-load-cancelled`);
      } catch (error) {
        return Promise.reject(trustedLoadFailure(error, role));
      }
      if (state === "ready" && active) {
        if (sameModelSecurity(active.security, effectiveSecurity)) {
          return Promise.resolve(status());
        }
        lifecycleReason = `${role}-load-superseded-by-security-change`;
        return provider.unload().then(() => provider.load(context));
      }
      if (loadOperation) {
        if (sameModelSecurity(loadOperation.security, effectiveSecurity)) {
          return observeLoadOperation(loadOperation, {
            signal: loadSignal,
            progress: loadProgress,
          }, role);
        }
        lifecycleReason = `${role}-load-superseded-by-security-change`;
        loadOperation.abort(
          `${role}-load-superseded-by-security-change`,
          "ARCANE_AI_OPERATION_SUPERSEDED",
        );
        return loadOperation.promise.catch(() => undefined).then(() => provider.load(context));
      }
      generation += 1;
      const operationGeneration = generation;
      const linked = linkSignal(null);
      state = "loading";
      lifecycleReason = `${role}-load-started`;
      activeOperation = `${role}-provider-load`;
      errorCode = null;
      const record = {
        promise: null,
        security: effectiveSecurity,
        observers: new Set(),
        settled: false,
        hasProgress: false,
        latestProgress: null,
        abort: (
          reason = `${role}-load-cancelled`,
          code = "ARCANE_AI_REQUEST_ABORTED",
        ) => linked.abort(reason, code),
        publishProgress(progress) {
          record.latestProgress = progress;
          record.hasProgress = true;
          for (const observer of [...record.observers]) observer.progress(progress);
        },
      };
      const promise = Promise.resolve().then(async () => {
        let prepared = null;
        let slot = null;
        try {
          prepared = await store.prepare(authority.graph ?? authority, {
            signal: linked.controller.signal,
            onProgress: record.publishProgress,
            offline,
            security: effectiveSecurity,
          });
          throwIfAborted(
            linked.controller.signal,
            () => linked.reason(`${role}-load-cancelled`),
          );
          if (operationGeneration !== generation) {
            throw providerError(
              "ARCANE_AI_OPERATION_SUPERSEDED",
              "Browser speech loading was superseded.",
              undefined,
              lifecycleReason === `${role}-load-superseded-by-security-change`
                ? lifecycleReason
                : `${role}-load-superseded-by-unload`,
            );
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
              const trustedReason = trustedWorkerFailure(reason, role);
              if (active === slot) {
                active = null;
                if (state !== "disposed" && state !== "unloading") {
                  state = intentional ? "unloaded" : "error";
                  errorCode = intentional ? null : workerFailureCode(trustedReason);
                  lifecycleReason = intentional
                    ? `${role}-worker-terminated`
                    : trustedReason.reason ?? (errorCode === "ARCANE_AI_WORKER_MESSAGE_ERROR"
                      || errorCode === "ARCANE_AI_WORKER_MESSAGE_REJECTED"
                      ? `${role}-worker-message-rejected`
                      : errorCode === "ARCANE_AI_ADAPTER_PROTOCOL_MISMATCH"
                        ? `${role}-worker-protocol-mismatch`
                        : `${role}-worker-crashed`);
                  activeOperation = null;
                  artifactGraphAdmission = null;
                }
                try {
                  releaseSlot(slot);
                } catch (error) {
                  const releaseFailure = trustedWorkerFailure(error, role);
                  if (state !== "disposed" && state !== "unloading") {
                    state = "error";
                    errorCode = releaseFailure.code;
                    lifecycleReason = releaseFailure.reason;
                    activeOperation = null;
                    artifactGraphAdmission = null;
                  }
                  throw releaseFailure;
                }
              }
            },
          });
          if (!isSpeechWorkerClient(slot.client)) {
            throw providerError(
              "ARCANE_AI_ADAPTER_PROTOCOL_MISMATCH",
              "The browser speech Worker client is not SDK-owned.",
              undefined,
              `${role}-worker-client-authority-mismatch`,
            );
          }
          const configuration = Object.freeze({
            role,
            runtime: prepared.runtime,
            model: prepared.model,
            security: effectiveSecurity,
            ...(authority.graph ? {
              artifactGraphId: authority.artifactGraphId,
              artifactGraphProtocol: authority.graph.protocol,
            } : {}),
          });
          await slot.client.request("load", { configuration }, {
            signal: linked.controller.signal,
            progress: record.publishProgress,
          });
          throwIfAborted(
            linked.controller.signal,
            () => linked.reason(`${role}-load-cancelled`),
          );
          if (operationGeneration !== generation) {
            throw providerError(
              "ARCANE_AI_OPERATION_SUPERSEDED",
              "Browser speech loading was superseded.",
              undefined,
              lifecycleReason === `${role}-load-superseded-by-security-change`
                ? lifecycleReason
                : `${role}-load-superseded-by-unload`,
            );
          }
          active = slot;
          cache = prepared.cache;
          artifactGraphAdmission = prepared.artifactGraphAdmission ?? null;
          state = "ready";
          lifecycleReason = `${role}-load-completed`;
          activeOperation = null;
          return status();
        } catch (error) {
          let failure = linked.controller.signal.aborted
            ? linkedAbortFailure(linked, `${role}-load-cancelled`)
            : trustedLoadFailure(error, role);
          try {
            if (slot) await terminateSlot(slot, failure);
            else prepared?.release();
          } catch (cleanupError) {
            failure = slot
              ? trustedWorkerFailure(cleanupError, role)
              : trustedLoadFailure(cleanupError, role);
          }
          if (operationGeneration === generation && state !== "unloading" && state !== "disposed") {
            state = failure?.code === "ARCANE_AI_REQUEST_ABORTED"
              || failure?.code === "ARCANE_AI_OPERATION_SUPERSEDED"
              ? "unloaded"
              : "error";
            errorCode = failure?.code ?? "ARCANE_AI_PROVIDER_LOAD_FAILED";
            lifecycleReason = failure?.reason
              ?? (state === "unloaded" ? `${role}-load-cancelled` : `${role}-load-rejected`);
            activeOperation = null;
          }
          throw failure;
        } finally {
          record.settled = true;
          linked.release();
          if (loadOperation === record) loadOperation = null;
        }
      });
      record.promise = promise;
      loadOperation = record;
      return observeLoadOperation(record, {
        signal: loadSignal,
        progress: loadProgress,
      }, role);
    },

    async request(context = {}) {
      let requestContext;
      try {
        requestContext = providerContext(context, role, "request");
        if (context.role !== role) {
          throw providerError(
            "ARCANE_AI_INVALID_REQUEST",
            `Browser ${role} request role does not match the provider.`,
            undefined,
            `${role}-provider-request-role-mismatch`,
          );
        }
        if (context.operation !== operation) {
          throw providerError(
            "ARCANE_AI_INVALID_REQUEST",
            `Browser ${role} supports only ${operation}.`,
            undefined,
            `${role}-provider-operation-mismatch`,
          );
        }
        assertRequestAuthority(
          context,
          authority,
          providerId,
          `${role}-provider-request-selection-authority-mismatch`,
        );
        throwIfAborted(requestContext.signal, ROLE_REQUEST_REASON[role]);
      } catch (error) {
        throw trustedRequestFailure(error, role);
      }
      const externalSignal = requestContext.signal;
      if (state !== "ready" || !active) {
        throw providerError(
          "ARCANE_AI_NOT_READY",
          "The browser speech provider is not ready.",
          undefined,
          `${role}-provider-request-not-ready`,
        );
      }
      if (requestOperation) {
        throw providerError(
          "ARCANE_AI_PROVIDER_BUSY",
          "The browser speech provider is already processing a request.",
          undefined,
          `${role}-provider-request-already-active`,
        );
      }
      let linked;
      try {
        linked = linkSignal(externalSignal);
      } catch (error) {
        throw trustedRequestFailure(error, role);
      }
      if (linked.controller.signal.aborted) {
        linked.release();
        throw linkedAbortFailure(linked, ROLE_REQUEST_REASON[role]);
      }
      const slot = active;
      const requestGeneration = generation;
      let workerRequestStarted = false;
      activeOperation = role === "stt"
        ? "stt-provider-transcription"
        : "tts-provider-synthesis";
      lifecycleReason = role === "stt"
        ? "stt-transcription-started"
        : "tts-synthesis-started";
      const promise = (async () => {
        const normalized = await normalizeRequestPayload(
          role,
          context.payload,
          authority,
          linked.controller.signal,
          () => linked.reason(ROLE_REQUEST_REASON[role]),
        );
        throwIfAborted(
          linked.controller.signal,
          () => linked.reason(ROLE_REQUEST_REASON[role]),
        );
        workerRequestStarted = true;
        const result = await slot.client.request("use", normalized.payload, {
          signal: linked.controller.signal,
        });
        if (requestGeneration !== generation || active !== slot) {
          throw providerError(
            "ARCANE_AI_OPERATION_SUPERSEDED",
            "The browser speech result was superseded.",
            undefined,
            role === "stt"
              ? "stt-transcription-superseded-by-unload"
              : "tts-synthesis-superseded-by-unload",
          );
        }
        return role === "tts" && normalized.shared
          ? encodeSharedSynthesisResult(result, authority)
          : result;
      })();
      requestOperation = Object.freeze({
        promise,
        abort: (
          reason = ROLE_REQUEST_REASON[role],
          code = "ARCANE_AI_REQUEST_ABORTED",
        ) => linked.abort(reason, code),
      });
      try {
        const result = await promise;
        lifecycleReason = role === "stt"
          ? "stt-transcription-completed"
          : "tts-synthesis-completed";
        return result;
      } catch (error) {
        let failure = linked.controller.signal.aborted
          && (error?.code === "ARCANE_AI_REQUEST_ABORTED"
            || linked.code() === "ARCANE_AI_OPERATION_SUPERSEDED")
          ? linkedAbortFailure(linked, ROLE_REQUEST_REASON[role])
          : trustedRequestFailure(error, role);
        if (failure?.code === "ARCANE_AI_REQUEST_ABORTED"
          && workerRequestStarted
          && active === slot) {
          active = null;
          try {
            releaseSlot(slot);
          } catch (cleanupError) {
            failure = trustedWorkerFailure(cleanupError, role);
          }
          state = "unloaded";
          artifactGraphAdmission = null;
        }
        lifecycleReason = failure?.reason
          ?? (failure?.code === "ARCANE_AI_REQUEST_ABORTED"
            ? ROLE_REQUEST_REASON[role]
            : role === "stt"
              ? "stt-transcription-engine-operation-rejected"
              : "tts-synthesis-engine-operation-rejected");
        throw failure;
      } finally {
        linked.release();
        if (requestOperation?.promise === promise) requestOperation = null;
        activeOperation = null;
      }
    },

    unload(context = {}) {
      let unloadContext;
      try {
        unloadContext = providerContext(context, role, "unload");
        assertRequestAuthority(
          context,
          authority,
          providerId,
          `${role}-provider-unload-selection-authority-mismatch`,
        );
        throwIfAborted(unloadContext.signal, `${role}-unload-cancelled`);
      } catch (error) {
        return Promise.reject(trustedLifecycleFailure(error, role, "unload"));
      }
      const unloadSignal = unloadContext.signal;
      if (state === "disposed") return Promise.resolve(status());
      if (unloadOperation) {
        return awaitAbortableSpeechOperation(
          unloadOperation,
          unloadSignal,
          `${role}-unload-cancelled`,
        );
      }
      generation += 1;
      state = "unloading";
      errorCode = null;
      activeOperation = `${role}-provider-unload`;
      const capturedLoad = loadOperation?.promise ?? null;
      const capturedRequest = requestOperation?.promise ?? null;
      if (loadOperation) {
        lifecycleReason = `${role}-load-superseded-by-unload`;
        loadOperation.abort(
          `${role}-load-superseded-by-unload`,
          "ARCANE_AI_OPERATION_SUPERSEDED",
        );
      } else if (requestOperation) {
        lifecycleReason = role === "stt"
          ? "stt-transcription-superseded-by-unload"
          : "tts-synthesis-superseded-by-unload";
        requestOperation.abort(lifecycleReason, "ARCANE_AI_OPERATION_SUPERSEDED");
      } else {
        lifecycleReason = `${role}-unload-started`;
      }
      const promise = (async () => {
        await Promise.allSettled([
          capturedLoad,
          capturedRequest,
        ].filter(Boolean));
        const slot = active;
        active = null;
        await terminateSlot(slot, providerError(
          "ARCANE_AI_OPERATION_SUPERSEDED",
          "The browser speech Worker was terminated by unload().",
          undefined,
          `${role}-worker-terminated-by-unload`,
        ));
        cache = null;
        artifactGraphAdmission = null;
        state = "unloaded";
        lifecycleReason = `${role}-unload-completed`;
        activeOperation = null;
        return status();
      })();
      const tracked = promise.then((value) => {
        if (unloadOperation === tracked) unloadOperation = null;
        return value;
      }, (error) => {
        if (unloadOperation === tracked) unloadOperation = null;
        throw error;
      });
      unloadOperation = tracked;
      return awaitAbortableSpeechOperation(
        tracked,
        unloadSignal,
        `${role}-unload-cancelled`,
      );
    },

    dispose(context = {}) {
      let disposalContext;
      try {
        disposalContext = providerContext(context, role, "dispose");
        assertRequestAuthority(
          context,
          authority,
          providerId,
          `${role}-provider-dispose-selection-authority-mismatch`,
        );
        throwIfAborted(disposalContext.signal, `${role}-dispose-cancelled`);
      } catch (error) {
        return Promise.reject(trustedLifecycleFailure(error, role, "dispose"));
      }
      const disposeSignal = disposalContext.signal;
      if (state === "disposed") return Promise.resolve(status());
      if (disposeOperation) {
        return awaitAbortableSpeechOperation(
          disposeOperation,
          disposeSignal,
          `${role}-dispose-cancelled`,
        );
      }
      const promise = (async () => {
        activeOperation = `${role}-provider-dispose`;
        lifecycleReason = `${role}-dispose-started`;
        await provider.unload();
        state = "disposed";
        lifecycleReason = `${role}-dispose-completed`;
        activeOperation = null;
        return status();
      })();
      disposeOperation = promise.then((value) => {
        disposeOperation = null;
        return value;
      }, (error) => {
        disposeOperation = null;
        throw error;
      });
      return awaitAbortableSpeechOperation(
        disposeOperation,
        disposeSignal,
        `${role}-dispose-cancelled`,
      );
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

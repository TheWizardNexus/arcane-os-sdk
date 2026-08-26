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

function cloneRequestPayload(role, payload, authority) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw providerError("ARCANE_AI_INVALID_REQUEST", "Speech request payload must be an object.");
  }
  if (role === "stt") {
    if (!(payload.audio instanceof Float32Array) || payload.sampleRate !== 16_000) {
      throw providerError(
        "ARCANE_AI_INVALID_REQUEST",
        "Whisper requires Float32Array audio sampled at exactly 16000 Hz.",
      );
    }
    return Object.freeze({
      audio: new Float32Array(payload.audio),
      sampleRate: 16_000,
    });
  }
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
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
  return Object.freeze({ text, voice, speed });
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
  const catalogEntry = Object.freeze({
    id: authority.modelId,
    providerId,
    role,
    localOnly: true,
    repository: authority.repository,
    revision: authority.revision,
    runtime: authority.runtime,
    files: authority.files,
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
      const externalSignal = context.signal ?? null;
      throwIfAborted(externalSignal);
      if (state !== "ready" || !active) {
        throw providerError("ARCANE_AI_NOT_READY", "The browser speech provider is not ready.");
      }
      if (requestOperation) {
        throw providerError("ARCANE_AI_PROVIDER_BUSY", "The browser speech provider is already processing a request.");
      }
      const payload = cloneRequestPayload(role, context.payload, {
        defaultVoice: authority.defaultVoice,
      });
      throwIfAborted(externalSignal);
      const linked = linkSignal(externalSignal);
      if (linked.controller.signal.aborted) {
        linked.release();
        throw abortError(externalSignal);
      }
      const slot = active;
      const requestGeneration = generation;
      const promise = slot.client.request("use", payload, {
        signal: linked.controller.signal,
      });
      requestOperation = Object.freeze({
        promise,
        abort: () => linked.controller.abort(),
      });
      try {
        const result = await promise;
        if (requestGeneration !== generation || active !== slot) {
          throw providerError("ARCANE_AI_OPERATION_SUPERSEDED", "The browser speech result was superseded.");
        }
        return result;
      } catch (error) {
        if (error?.code === "ARCANE_AI_REQUEST_ABORTED" && active === slot) {
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

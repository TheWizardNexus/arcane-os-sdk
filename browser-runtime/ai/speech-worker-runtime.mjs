export const SPEECH_WORKER_PROTOCOL = "arcane-ai-speech-worker/1";

const ADAPTERS = Object.freeze({
  stt: "transformers-whisper",
  tts: "kokoro-js",
});

function workerError(code, message, cause) {
  const error = cause === undefined
    ? new Error(message)
    : new Error(message, { cause });
  error.name = code === "ARCANE_AI_REQUEST_ABORTED"
    ? "AbortError"
    : "ArcaneSpeechWorkerError";
  error.code = code;
  return error;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw workerError(
    "ARCANE_AI_REQUEST_ABORTED",
    "The speech worker operation was cancelled.",
    signal.reason,
  );
}

export function collectSpeechTransferables(value) {
  const transfers = [];
  const buffers = new Set();
  const seen = new WeakSet();
  function visit(candidate) {
    if (candidate instanceof ArrayBuffer) {
      if (!buffers.has(candidate)) {
        buffers.add(candidate);
        transfers.push(candidate);
      }
      return;
    }
    if (ArrayBuffer.isView(candidate)) {
      visit(candidate.buffer);
      return;
    }
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    for (const child of Array.isArray(candidate)
      ? candidate
      : Object.values(candidate)) visit(child);
  }
  visit(value);
  return transfers;
}

function serializedError(error) {
  const code = typeof error?.code === "string" && /^ARCANE_AI_[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : "ARCANE_AI_PROVIDER_REQUEST_FAILED";
  const messages = Object.freeze({
    ARCANE_AI_REQUEST_ABORTED: "The speech worker operation was cancelled.",
    ARCANE_AI_NOT_READY: "The speech worker is not loaded.",
    ARCANE_AI_INVALID_REQUEST: "The speech worker request is invalid.",
    ARCANE_AI_INVALID_PROVIDER_RESULT: "The speech engine returned an invalid result.",
    ARCANE_AI_UNDECLARED_ARTIFACT: "The speech engine requested an undeclared artifact.",
    ARCANE_AI_PROVIDER_UNAVAILABLE: "The selected speech engine is unavailable.",
  });
  return Object.freeze({
    code,
    message: messages[code] ?? "The speech worker operation failed.",
  });
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw workerError("ARCANE_AI_INVALID_REQUEST", `${label} is required.`);
  }
  return value.trim();
}

function validateConfiguration(configuration, role) {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    throw workerError("ARCANE_AI_INVALID_REQUEST", "Speech worker configuration is required.");
  }
  if (
    configuration.role !== role
    || configuration.runtime?.adapter !== ADAPTERS[role]
    || configuration.runtime?.moduleGraph !== "self-contained"
  ) {
    throw workerError("ARCANE_AI_INVALID_REQUEST", "Speech worker role and runtime adapter do not match.");
  }
  requiredText(configuration.model?.id, "Speech model id");
  requiredText(configuration.model?.repository, "Speech model repository");
  requiredText(configuration.model?.revision, "Speech model revision");
  requiredText(configuration.runtime?.entry, "Speech runtime entry");
  if (!Array.isArray(configuration.runtime?.files) || !Array.isArray(configuration.model?.files)) {
    throw workerError("ARCANE_AI_INVALID_REQUEST", "Speech runtime and model files are required.");
  }
  const entry = configuration.runtime.files.find((file) =>
    file.path === configuration.runtime.entry);
  if (!entry?.moduleUrl) {
    throw workerError("ARCANE_AI_INVALID_REQUEST", "Speech runtime entry was not materialized.");
  }
  return configuration;
}

function artifactMap(configuration) {
  const map = new Map();
  const materialized = new Set();
  for (const file of [
    ...configuration.runtime.files,
    ...configuration.model.files,
  ]) {
    const sourceUrl = new URL(file.sourceUrl).href;
    map.set(sourceUrl, file.moduleUrl);
    materialized.add(file.moduleUrl);
  }
  return Object.freeze({ map, materialized });
}

function installAuthorizedFetch(scope, configuration) {
  const original = scope.fetch?.bind(scope);
  if (typeof original !== "function") {
    throw workerError("ARCANE_AI_PROVIDER_UNAVAILABLE", "Browser fetch is unavailable in the speech worker.");
  }
  const allowed = artifactMap(configuration);
  scope.fetch = async function fetchAuthorizedSpeechArtifact(input, init) {
    const requested = typeof Request === "function" && input instanceof Request
      ? input.url
      : String(input);
    let absolute;
    try {
      absolute = new URL(requested, scope.location?.href).href;
    } catch {
      throw workerError("ARCANE_AI_UNDECLARED_ARTIFACT", "The speech engine requested an invalid artifact URL.");
    }
    const replacement = allowed.map.get(absolute);
    if (replacement) return original(replacement, init);
    if (allowed.materialized.has(absolute)) return original(absolute, init);
    throw workerError(
      "ARCANE_AI_UNDECLARED_ARTIFACT",
      "The speech engine requested an artifact outside its admitted file map.",
    );
  };
  return function restoreSpeechWorkerFetch() {
    scope.fetch = original;
  };
}

function installCacheIsolation(scope) {
  const ownDescriptor = Object.getOwnPropertyDescriptor(scope, "caches");
  if (ownDescriptor && ownDescriptor.configurable === false) {
    throw workerError(
      "ARCANE_AI_PROVIDER_UNAVAILABLE",
      "The speech worker cannot isolate the browser cache API.",
    );
  }
  const denied = Object.freeze({
    async open() {
      throw workerError(
        "ARCANE_AI_UNDECLARED_ARTIFACT",
        "Speech runtime cache access is disabled; DBOPFS admission is the sole artifact source.",
      );
    },
    async match() {
      throw workerError(
        "ARCANE_AI_UNDECLARED_ARTIFACT",
        "Speech runtime cache access is disabled; DBOPFS admission is the sole artifact source.",
      );
    },
    async has() {
      return false;
    },
    async keys() {
      return Object.freeze([]);
    },
    async delete() {
      return false;
    },
  });
  try {
    Object.defineProperty(scope, "caches", {
      configurable: true,
      enumerable: ownDescriptor?.enumerable ?? true,
      writable: false,
      value: denied,
    });
  } catch (error) {
    throw workerError(
      "ARCANE_AI_PROVIDER_UNAVAILABLE",
      "The speech worker could not isolate the browser cache API.",
      error,
    );
  }
  return function restoreSpeechWorkerCaches() {
    if (ownDescriptor) Object.defineProperty(scope, "caches", ownDescriptor);
    else delete scope.caches;
  };
}

function configureWasmPaths(namespace, configuration) {
  if (namespace?.env) {
    namespace.env.allowLocalModels = false;
    namespace.env.allowRemoteModels = true;
    namespace.env.useBrowserCache = false;
    namespace.env.useFSCache = false;
    namespace.env.useCustomCache = false;
    namespace.env.customCache = null;
  }
  const wasm = namespace?.env?.backends?.onnx?.wasm;
  if (!wasm) return;
  const paths = {};
  for (const file of configuration.runtime.files) {
    if (/\.(?:m?js|wasm)$/iu.test(file.path) && file.path !== configuration.runtime.entry) {
      paths[file.path.split("/").pop()] = file.moduleUrl;
    }
  }
  if (Object.keys(paths).length > 0) wasm.wasmPaths = Object.freeze(paths);
  if (scopeIsCrossOriginIsolated() && Number.isSafeInteger(globalThis.navigator?.hardwareConcurrency)) {
    wasm.numThreads = Math.max(1, Math.min(8, globalThis.navigator.hardwareConcurrency));
  }
}

function scopeIsCrossOriginIsolated() {
  return globalThis.crossOriginIsolated === true;
}

function workerProgress(send, requestId, phase, completed = 0, total = null, unit = "items") {
  send({
    protocol: SPEECH_WORKER_PROTOCOL,
    event: "progress",
    requestId,
    progress: Object.freeze({
      phase,
      completed,
      total,
      unit,
      heartbeat: true,
    }),
  }, []);
}

async function disposeEngine(engine) {
  if (!engine) return;
  if (typeof engine.dispose === "function") {
    await engine.dispose();
    return;
  }
  const disposed = new Set();
  for (const part of [engine.model, engine.tokenizer, engine.processor]) {
    if (!part || disposed.has(part) || typeof part.dispose !== "function") continue;
    disposed.add(part);
    await part.dispose();
  }
}

async function createWhisperEngine(namespace, configuration, signal, report) {
  if (typeof namespace?.pipeline !== "function") {
    throw workerError("ARCANE_AI_PROVIDER_UNAVAILABLE", "The Whisper runtime does not export pipeline().");
  }
  configureWasmPaths(namespace, configuration);
  throwIfAborted(signal);
  const transcriber = await namespace.pipeline(
    "automatic-speech-recognition",
    configuration.model.repository,
    {
      device: "wasm",
      dtype: "fp32",
      revision: configuration.model.revision,
      progress_callback: report,
    },
  );
  throwIfAborted(signal);
  return Object.freeze({
    async transcribe(input, { signal: requestSignal } = {}) {
      throwIfAborted(requestSignal);
      const output = await transcriber(input.audio, { signal: requestSignal });
      throwIfAborted(requestSignal);
      return Object.freeze({ text: String(output?.text ?? "").trim() });
    },
    dispose: () => disposeEngine(transcriber),
  });
}

async function createKokoroEngine(namespace, configuration, signal, report) {
  if (typeof namespace?.KokoroTTS?.from_pretrained !== "function") {
    throw workerError("ARCANE_AI_PROVIDER_UNAVAILABLE", "The Kokoro runtime does not export KokoroTTS.");
  }
  configureWasmPaths(namespace, configuration);
  throwIfAborted(signal);
  const synthesizer = await namespace.KokoroTTS.from_pretrained(
    configuration.model.repository,
    {
      device: "wasm",
      dtype: "q8",
      revision: configuration.model.revision,
      progress_callback: report,
    },
  );
  throwIfAborted(signal);
  return Object.freeze({
    async synthesize(input, { signal: requestSignal } = {}) {
      throwIfAborted(requestSignal);
      const output = await synthesizer.generate(input.text, {
        voice: input.voice,
        speed: input.speed,
        signal: requestSignal,
      });
      throwIfAborted(requestSignal);
      const audio = output?.audio instanceof Float32Array
        ? output.audio
        : new Float32Array(output?.audio ?? []);
      return Object.freeze({
        audio,
        sampleRate: output?.sampling_rate,
        voice: input.voice,
      });
    },
    dispose: () => disposeEngine(synthesizer),
  });
}

function validateInput(role, payload, configuration) {
  if (role === "stt") {
    if (!(payload?.audio instanceof Float32Array) || payload.sampleRate !== 16_000) {
      throw workerError(
        "ARCANE_AI_INVALID_REQUEST",
        "Whisper requires Float32Array audio sampled at exactly 16000 Hz.",
      );
    }
    return Object.freeze({ audio: payload.audio, sampleRate: 16_000 });
  }
  const text = requiredText(payload?.text, "Kokoro text");
  const voice = requiredText(
    payload?.voice ?? configuration.model.defaultVoice,
    "Kokoro voice",
  );
  const speed = payload?.speed ?? 1;
  if (!Number.isFinite(speed) || speed <= 0 || speed > 4) {
    throw workerError("ARCANE_AI_INVALID_REQUEST", "Kokoro speed must be greater than 0 and at most 4.");
  }
  return Object.freeze({ text, voice, speed });
}

function validateResult(role, result) {
  if (role === "stt") {
    if (!result || typeof result.text !== "string") {
      throw workerError("ARCANE_AI_INVALID_PROVIDER_RESULT", "Whisper did not return text.");
    }
    return Object.freeze({ text: result.text.trim() });
  }
  if (!(result?.audio instanceof Float32Array) || result.sampleRate !== 24_000) {
    throw workerError(
      "ARCANE_AI_INVALID_PROVIDER_RESULT",
      "Kokoro must return 24000 Hz Float32 PCM.",
    );
  }
  for (const sample of result.audio) {
    if (!Number.isFinite(sample)) {
      throw workerError("ARCANE_AI_INVALID_PROVIDER_RESULT", "Kokoro returned non-finite PCM.");
    }
  }
  return Object.freeze({
    audio: result.audio,
    sampleRate: 24_000,
    voice: result.voice,
  });
}

export function createSpeechWorkerRuntime({ role, scope = globalThis, send } = {}) {
  if (role !== "stt" && role !== "tts") {
    throw new TypeError('Speech worker role must be "stt" or "tts".');
  }
  if (typeof send !== "function") {
    throw new TypeError("Speech worker send() is required.");
  }
  let configuration = null;
  let engine = null;
  let restoreFetch = null;
  let restoreCaches = null;
  let disposed = false;
  let tail = Promise.resolve();
  const operations = new Map();

  function status() {
    return Object.freeze({
      state: disposed ? "disposed" : engine ? "ready" : "unloaded",
      loaded: engine !== null,
      busy: operations.size > 0,
    });
  }

  async function load(request, signal) {
    if (disposed) {
      throw workerError("ARCANE_AI_PROVIDER_DISPOSED", "The speech worker is disposed.");
    }
    if (engine) return status();
    configuration = validateConfiguration(request.payload?.configuration, role);
    const entry = configuration.runtime.files.find((file) =>
      file.path === configuration.runtime.entry);
    restoreFetch = installAuthorizedFetch(scope, configuration);
    try {
      restoreCaches = installCacheIsolation(scope);
      workerProgress(send, request.id, "runtime-import");
      const namespace = await import(entry.moduleUrl);
      throwIfAborted(signal);
      const report = () => workerProgress(send, request.id, "model-load");
      engine = role === "stt"
        ? await createWhisperEngine(namespace, configuration, signal, report)
        : await createKokoroEngine(namespace, configuration, signal, report);
      workerProgress(send, request.id, "ready", 1, 1);
      return status();
    } catch (error) {
      restoreFetch?.();
      restoreFetch = null;
      restoreCaches?.();
      restoreCaches = null;
      configuration = null;
      throw error;
    }
  }

  async function use(request, signal) {
    if (!engine || !configuration) {
      throw workerError("ARCANE_AI_NOT_READY", "The speech worker is not loaded.");
    }
    const input = validateInput(role, request.payload, configuration);
    const method = role === "stt" ? engine.transcribe : engine.synthesize;
    if (typeof method !== "function") {
      throw workerError("ARCANE_AI_PROVIDER_UNAVAILABLE", "The speech engine operation is unavailable.");
    }
    return validateResult(role, await method(input, { signal }));
  }

  async function unload() {
    for (const controller of operations.values()) controller.abort();
    const current = engine;
    engine = null;
    configuration = null;
    try {
      await disposeEngine(current);
    } finally {
      restoreFetch?.();
      restoreFetch = null;
      restoreCaches?.();
      restoreCaches = null;
    }
    return status();
  }

  async function dispatch(request, signal) {
    if (request.op === "load") return load(request, signal);
    if (request.op === "use") return use(request, signal);
    if (request.op === "status") return status();
    if (request.op === "unload") return unload();
    if (request.op === "dispose") {
      await unload();
      disposed = true;
      return status();
    }
    throw workerError("ARCANE_AI_INVALID_REQUEST", "The speech worker operation is unsupported.");
  }

  function respond(request, operation) {
    operation.then((result) => send({
      protocol: SPEECH_WORKER_PROTOCOL,
      id: request.id,
      ok: true,
      result: result ?? null,
    }, collectSpeechTransferables(result)), (error) => send({
      protocol: SPEECH_WORKER_PROTOCOL,
      id: request.id,
      ok: false,
      error: serializedError(error),
    }, []));
  }

  function handleMessage(request) {
    if (request?.protocol !== SPEECH_WORKER_PROTOCOL
      || !Number.isSafeInteger(request.id)
      || request.id < 1) {
      return Promise.reject(workerError("ARCANE_AI_INVALID_REQUEST", "The speech worker envelope is invalid."));
    }
    if (request.op === "cancel") {
      const target = operations.get(request.payload?.targetId);
      target?.abort(request.payload?.reason);
      const result = Promise.resolve(Object.freeze({ cancelled: Boolean(target) }));
      respond(request, result);
      return result;
    }
    const controller = new AbortController();
    const execute = tail.catch(() => undefined).then(() => {
      throwIfAborted(controller.signal);
      return dispatch(request, controller.signal);
    });
    operations.set(request.id, controller);
    const operation = execute.finally(() => operations.delete(request.id));
    tail = operation.catch(() => undefined);
    respond(request, operation);
    return operation;
  }

  return Object.freeze({ handleMessage, status });
}

export function installBrowserSpeechWorker(role, scope = globalThis) {
  const runtime = createSpeechWorkerRuntime({
    role,
    scope,
    send: (message, transfers) => scope.postMessage(message, transfers),
  });
  scope.addEventListener("message", (event) => {
    // Valid envelopes own their one response inside handleMessage(). Invalid
    // envelopes have no trustworthy request id and are intentionally ignored.
    void runtime.handleMessage(event.data).catch(() => undefined);
  });
  return runtime;
}

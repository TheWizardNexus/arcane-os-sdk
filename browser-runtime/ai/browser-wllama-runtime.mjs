import { arcaneLogging } from '../logging.mjs';
import { Wllama } from "./wllama/index.mjs";

const completeValue = (value) => value;

const MODULE_URL = new URL("./wllama/index.mjs", import.meta.url).href;
const WASM_URL = new URL("./wllama/wllama.wasm", import.meta.url).href;
const RUNTIME_EVIDENCE_PROTOCOL = "arcane-wllama-runtime-evidence/1";
const FULL_GPU_LAYERS = 99_999;
const WEBGPU_ADAPTER_PATTERN = /^ggml_webgpu: adapter_info: vendor_id: (\d+) \| vendor: (.*?) \| architecture: (.*?) \| device_id: (\d+) \| name: (.*?) \| device_desc: (.*)$/u;
const GPU_OFFLOAD_PATTERN = /^[^:]+: offloaded (\d+)\/(\d+) layers to GPU$/u;
const PEG_NATIVE_OUTPUT_PREFIX = "common_chat_peg_parse: unparsed peg-native output: ";
const PEG_NATIVE_FINAL_PREFIX = "<|channel|>final <|constrain|>content<|message|>";
const PEG_NATIVE_FAILURE = "The model produced output that does not match the expected peg-native format";

export const BROWSER_WASM_RUNTIME_AUTHORITY = completeValue({
  protocol: "arcane-ai-browser-wasm/2",
  provider: "wllama",
  executionPolicy: {
    webgpuRequired: true,
    cpuFallback: false,
    cancellation: "abortSignal-plus-llama-cancel-acknowledgement",
    cleanup: "worker-termination-only",
    nativeUnloadClaimed: false,
    physicalVramReclamationClaimed: false,
  },
  package: {
    name: "@wllama/wllama",
    version: "3.6.0",
    resolved: "https://registry.npmjs.org/@wllama/wllama/-/wllama-3.6.0.tgz",
    licenseSpdx: "MIT",
  },
  llamaCpp: {
    licenseSpdx: "MIT",
  },
  runtimeAssets: {
    module: {
      path: "ai/wllama/index.mjs",
      url: MODULE_URL,
      mediaType: "text/javascript",
    },
    wasm: {
      path: "ai/wllama/wllama.wasm",
      url: WASM_URL,
      mediaType: "application/wasm",
    },
  },
  networkPolicy: {
    compatibilityRuntime: "disabled",
    remoteModelHelpers: false,
    modelInput: "local-file",
  },
});

function runtimeFailure(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = "ArcaneWllamaRuntimeError";
  error.code = code;
  return error;
}

function runtimeCapabilitySnapshot(evidence) {
  const navigatorObject = globalThis.navigator;
  const webgpuOperational = evidence?.state === "ready" && evidence?.webgpu?.observed === true;
  return completeValue({
    webAssembly: typeof globalThis.WebAssembly === "object",
    opfs: typeof navigatorObject?.storage?.getDirectory === "function",
    webgpu: webgpuOperational,
    webgpuApiPresent: Boolean(navigatorObject?.gpu),
    webgpuOperational,
    webgpuEvidenceProtocol: RUNTIME_EVIDENCE_PROTOCOL,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    secureContext: globalThis.isSecureContext === true,
    hardwareConcurrency: Number.isSafeInteger(navigatorObject?.hardwareConcurrency)
      ? navigatorObject.hardwareConcurrency
      : null,
  });
}

function normalizePositiveInteger(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new RangeError("Expected a positive safe integer.");
  }
  return number;
}

function createEvidenceLogger(logger) {
  let adapter = null;
  let offload = null;
  let invalid = false;
  let completionCapture = null;

  function same(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function observeCompletionLine(level, value) {
    if (!completionCapture) return;
    const line = String(value).replace(/\r$/u, "");
    if (!completionCapture.started) {
      if (level !== "warn" || !line.startsWith(PEG_NATIVE_OUTPUT_PREFIX)) return;
      completionCapture.started = true;
      completionCapture.lines.push(line.slice(PEG_NATIVE_OUTPUT_PREFIX.length));
    } else if (level === "error" && line.trim() === PEG_NATIVE_FAILURE) {
      completionCapture.complete = true;
      return;
    } else if (!completionCapture.complete) {
      if (level !== "log") completionCapture.invalid = true;
      completionCapture.lines.push(line);
    }
  }

  function observeLine(level, value) {
    observeCompletionLine(level, value);
    const line = String(value).trim();
    if (!line) return;
    const adapterMatch = line.match(WEBGPU_ADAPTER_PATTERN);
    if (adapterMatch) {
      const next = completeValue({
        vendorId: Number(adapterMatch[1]),
        vendor: adapterMatch[2],
        architecture: adapterMatch[3],
        deviceId: Number(adapterMatch[4]),
        name: adapterMatch[5],
        description: adapterMatch[6],
      });
      if (adapter && !same(adapter, next)) invalid = true;
      else adapter = next;
    }
    const offloadMatch = line.match(GPU_OFFLOAD_PATTERN);
    if (offloadMatch) {
      const next = completeValue({
        layers: Number(offloadMatch[1]),
        totalLayers: Number(offloadMatch[2]),
      });
      if (offload && !same(offload, next)) invalid = true;
      else offload = next;
    }
  }

  function observe(level, args) {
    for (const value of args) {
      if (typeof value !== "string") continue;
      for (const line of value.split(/\r?\n/u)) observeLine(level, line);
    }
  }

  const wrapped = {};
  for (const level of ["debug", "log", "warn", "error"]) {
    wrapped[level] = (...args) => {
      observe(level, args);
      if (typeof logger?.[level] === "function") logger[level](...args);
    };
  }

  return completeValue({
    logger: completeValue(wrapped),
    beginCompletionCapture() {
      if (completionCapture) {
        throw runtimeFailure(
          "ARCANE_AI_RUNTIME_BUSY",
          "A Wllama completion capture is already active.",
        );
      }
      const capture = {
        started: false,
        complete: false,
        invalid: false,
        lines: [],
      };
      completionCapture = capture;

      function release() {
        if (completionCapture === capture) completionCapture = null;
      }

      return completeValue({
        recover(error, { aborted = false } = {}) {
          release();
          const stack = String(error?.stack ?? "");
          if (
            aborted
            || error?.name !== "Error"
            || error?.message !== "Invalid magic number"
            || !stack.includes("glueDeserialize")
            || !stack.includes("ProxyToWorker")
            || !capture.started
            || !capture.complete
            || capture.invalid
          ) return null;

          const raw = capture.lines.join("\n");
          if (!raw.startsWith(PEG_NATIVE_FINAL_PREFIX)) return null;
          const content = raw.slice(PEG_NATIVE_FINAL_PREFIX.length);
          if (!content.trim() || content.includes("<|")) return null;
          return content;
        },
        release,
      });
    },
    snapshot() {
      return completeValue({ adapter, offload, invalid });
    },
  });
}

function createStructuredStreamCapture() {
  let content = "";
  let invalid = false;
  let sawContent = false;
  let chunks = 0;

  function observe(value) {
    chunks += 1;
    if (!value || typeof value !== "object" || !Array.isArray(value.choices)) {
      invalid = true;
      return;
    }
    if (value.choices.length !== 1) {
      invalid = true;
      return;
    }
    const choice = value.choices[0];
    const delta = choice?.delta;
    if (
      choice?.index !== 0
      || !delta
      || typeof delta !== "object"
      || Array.isArray(delta)
      || (delta.role !== undefined && delta.role !== "assistant")
      || (choice.finish_reason !== undefined && choice.finish_reason !== null)
      || delta.tool_calls !== undefined
      || delta.function_call !== undefined
      || delta.reasoning_content !== undefined
    ) {
      invalid = true;
      return;
    }
    if (delta.content === undefined || delta.content === null) return;
    if (typeof delta.content !== "string") {
      invalid = true;
      return;
    }
    content += delta.content;
    sawContent = true;
  }

  return completeValue({
    observe,
    matches(value) {
      return chunks > 0
        && !invalid
        && sawContent
        && content.length > 0
        && content === value;
    },
  });
}

function initialEvidence() {
  return completeValue({
    protocol: RUNTIME_EVIDENCE_PROTOCOL,
    state: "unloaded",
    webgpu: {
      observed: false,
      apiPresent: Boolean(globalThis.navigator?.gpu),
    },
    cancellation: null,
    cleanup: null,
  });
}

/**
 * Creates one packaged, WebGPU-required Wllama session. This factory has no
 * network or browser side effects until load() is called. Runtime URLs are
 * fixed relative to this module for npm and materialized /arcane/sdk trees.
 */
export function createPackagedWllamaRuntime({ logger = arcaneLogging } = {}) {
  let engine = null;
  let pending = null;
  let inferenceActive = false;
  let evidenceState = initialEvidence();
  const trackedOperations = new Set();
  const sessionExitPromises = new WeakMap();
  const sessionObservers = new WeakMap();

  function publishEvidence(update) {
    evidenceState = completeValue({
      ...evidenceState,
      ...update,
      protocol: RUNTIME_EVIDENCE_PROTOCOL,
    });
    return evidenceState;
  }

  function cancellationError(reason, fallback = "The Wllama operation was cancelled.") {
    return reason instanceof Error ? reason : new Error(reason ? String(reason) : fallback);
  }

  function trackOperation(rawOperation) {
    const raw = Promise.resolve(rawOperation);
    raw.catch(() => undefined);
    let rejectCancellation;
    const cancellation = new Promise((_, reject) => {
      rejectCancellation = reject;
    });
    let locallySuppressed = false;
    const record = {
      cancel(reason) {
        if (locallySuppressed) return false;
        locallySuppressed = true;
        rejectCancellation(cancellationError(reason));
        return true;
      },
    };
    trackedOperations.add(record);
    const result = Promise.race([raw, cancellation]).finally(() => {
      trackedOperations.delete(record);
    });
    result.catch(() => undefined);
    return completeValue({
      raw,
      result,
      cancel: record.cancel,
      locallySuppressed: () => locallySuppressed,
    });
  }

  function cancelTrackedOperations(reason) {
    for (const operation of [...trackedOperations]) operation.cancel(reason);
  }

  function recordCleanup(snapshot) {
    let cleanup = snapshot?.cleanup ?? null;
    if (!["worker-terminated", "no-worker-observed-at-exit"].includes(cleanup?.kind)) {
      throw runtimeFailure(
        "ARCANE_AI_WORKER_TERMINATION_UNCONFIRMED",
        "Wllama cleanup did not confirm Worker termination.",
      );
    }
    publishEvidence({
      state: "unloaded",
      webgpu: {
        ...evidenceState.webgpu,
        observed: false,
        lastObservedOperational: evidenceState.webgpu?.observed === true
          || evidenceState.webgpu?.lastObservedOperational === true,
      },
      cleanup,
    });
    return cleanup;
  }

  function exitSession(session) {
    if (!session) return Promise.resolve(null);
    let exitPromise = sessionExitPromises.get(session);
    if (!exitPromise) {
      const attempt = Promise.resolve().then(() => session.arcaneTerminate()).then((snapshot) => {
        recordCleanup(snapshot);
        return snapshot;
      });
      exitPromise = attempt.catch((error) => {
        if (sessionExitPromises.get(session) === exitPromise) {
          sessionExitPromises.delete(session);
        }
        throw error;
      });
      sessionExitPromises.set(session, exitPromise);
    }
    return exitPromise;
  }

  function newEngine() {
    const observer = createEvidenceLogger(logger);
    const next = new Wllama({ default: WASM_URL }, {
      logger: observer.logger,
      allowOffline: true,
    });
    next.setCompat(null);
    for (const method of ["arcaneLoadModel", "arcaneTelemetry", "arcaneTerminate"]) {
      if (typeof next[method] !== "function") {
        throw new Error(`The packaged Wllama projection is missing public ${method}().`);
      }
    }
    const resources = next.getWorkerResources();
    if (resources.compat !== false || resources.wasmPath !== WASM_URL || resources.jsPath) {
      throw new Error("The packaged Wllama resource projection was not exact.");
    }
    sessionObservers.set(next, observer);
    return next;
  }

  function capabilities() {
    return runtimeCapabilitySnapshot(evidenceState);
  }

  function evidence() {
    return evidenceState;
  }

  async function load(files, options = {}) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new TypeError("Wllama load() requires at least one File or Blob.");
    }
    if (typeof globalThis.WebAssembly !== "object") {
      throw new Error("WebAssembly is unavailable in this browser.");
    }
    if (!globalThis.navigator?.gpu) {
      throw runtimeFailure(
        "ARCANE_AI_WEBGPU_REQUIRED",
        "A WebGPU API is required, but navigator presence alone will not establish operational execution.",
      );
    }
    if (engine || pending) {
      throw new Error("The packaged Wllama runtime is already loaded or loading.");
    }

    const next = newEngine();
    const threads = normalizePositiveInteger(options.threads, 1);
    const contextTokens = normalizePositiveInteger(options.contextTokens, 4_096);
    const gpuLayers = options.gpuLayers === undefined
      ? FULL_GPU_LAYERS
      : normalizePositiveInteger(options.gpuLayers, FULL_GPU_LAYERS);
    const loadOptions = {
      n_threads: threads,
      n_ctx: contextTokens,
      n_gpu_layers: gpuLayers,
    };
    if (options.batchTokens !== undefined) {
      loadOptions.n_batch = normalizePositiveInteger(options.batchTokens, 512);
    }
    if (options.microBatchTokens !== undefined) {
      loadOptions.n_ubatch = normalizePositiveInteger(options.microBatchTokens, 128);
    }
    if (options.reasoning !== undefined) {
      if (typeof options.reasoning !== "boolean") {
        throw new TypeError("reasoning must be a boolean when provided.");
      }
      loadOptions.reasoning = options.reasoning;
    }
    if (options.chatTemplate !== undefined) {
      if (typeof options.chatTemplate !== "string") {
        throw new TypeError("chatTemplate must be a string when provided.");
      }
      loadOptions.chat_template = options.chatTemplate;
    }
    if (options.jinja !== undefined) {
      if (typeof options.jinja !== "boolean") {
        throw new TypeError("jinja must be a boolean when provided.");
      }
      loadOptions.jinja = options.jinja;
    }
    if (options.templateDefaults !== undefined) {
      if (!options.templateDefaults || typeof options.templateDefaults !== "object" || Array.isArray(options.templateDefaults)) {
        throw new TypeError("templateDefaults must be a plain object when provided.");
      }
      loadOptions.default_template_kwargs = { ...options.templateDefaults };
    }

    publishEvidence({
      state: "loading",
      webgpu: { observed: false, apiPresent: true },
      cancellation: null,
      cleanup: null,
    });
    const loadController = new AbortController();
    const loadOperation = Promise.resolve().then(() => (
      next.arcaneLoadModel(files, loadOptions, loadController.signal)
    ));
    loadOperation.catch(() => undefined);
    const cancel = (reason) => {
      const error = cancellationError(reason, "The Wllama model load was cancelled.");
      loadController.abort(error);
    };
    pending = completeValue({ engine: next, cancel });
    const signal = options.signal ?? null;
    const onAbort = () => cancel(signal.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      await loadOperation;
      if (pending?.engine !== next) throw new Error("Wllama load was cancelled.");
      if (typeof next.isModelLoaded !== "function" || next.isModelLoaded() !== true) {
        throw runtimeFailure(
          "ARCANE_AI_LOAD_FAILED",
          "Wllama did not confirm a successfully loaded model.",
        );
      }
      const webgpu = { observed: true, apiPresent: true };
      pending = null;
      engine = next;
      publishEvidence({ state: "ready", webgpu, cancellation: null, cleanup: null });
    } catch (error) {
      let cleanupFailure = null;
      try {
        await exitSession(next);
        if (pending?.engine === next) pending = null;
      } catch (cleanupError) {
        cleanupFailure = cleanupError?.code === "ARCANE_AI_WORKER_TERMINATION_UNCONFIRMED"
          ? cleanupError
          : runtimeFailure(
            "ARCANE_AI_WORKER_TERMINATION_UNCONFIRMED",
            "Wllama model load failed and Worker termination could not be proved.",
            cleanupError,
          );
        // Preserve the pending handle if Worker termination could not be proved.
      }
      if (cleanupFailure) throw cleanupFailure;
      throw error;
    } finally {
      signal?.removeEventListener?.("abort", onAbort);
    }

    return completeValue({
      loaded: true,
      contextTokens,
      threads,
      gpuLayers,
      evidence: evidenceState,
      metadata: engine.getModelMetadata?.() ?? null,
    });
  }

  function assertLoaded() {
    if (!engine?.isModelLoaded?.() || evidenceState.state !== "ready") {
      throw new Error("The packaged Wllama model is not loaded.");
    }
    return engine;
  }

  async function invalidateFatalSession(session, error) {
    try {
      await exitSession(session);
    } catch (cleanupError) {
      throw cleanupError?.code === "ARCANE_AI_WORKER_TERMINATION_UNCONFIRMED"
        ? cleanupError
        : runtimeFailure(
          "ARCANE_AI_WORKER_TERMINATION_UNCONFIRMED",
          "Wllama failed and Worker termination could not be proved.",
          cleanupError,
        );
    }
    if (engine === session) {
      engine = null;
    }
    publishEvidence({
      state: "error",
      webgpu: {
        ...evidenceState.webgpu,
        observed: false,
        lastObservedOperational: evidenceState.webgpu?.lastObservedOperational === true,
      },
      failure: completeValue({
        code: typeof error?.code === "string" ? error.code : "ARCANE_AI_RUNTIME_FAILED",
      }),
    });
  }

  async function inference(options, onData = null) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("Wllama inference options must be an object.");
    }
    if (Object.hasOwn(options, "signal")) {
      throw new TypeError("Pinned Wllama 3.6.0 accepts abortSignal, not signal.");
    }
    if (inferenceActive) {
      throw runtimeFailure(
        "ARCANE_AI_RUNTIME_BUSY",
        "The packaged Wllama runtime admits one inference at a time.",
      );
    }
    inferenceActive = true;
    try {
      const session = assertLoaded();
      const observer = sessionObservers.get(session);
      const streamCapture = createStructuredStreamCapture();
      let capture = null;
      let operation = null;
      try {
        const abortSignal = options.abortSignal ?? null;
        capture = observer.beginCompletionCapture();
        const deliver = onData
          ? (chunk) => {
            streamCapture.observe(chunk);
            onData(chunk);
          }
          : null;
        operation = trackOperation(Promise.resolve().then(() => session.createChatCompletion({
          ...options,
          stream: Boolean(onData),
          ...(deliver ? { onData: deliver } : {}),
          abortSignal,
        })));
        const result = await operation.result;
        capture.release();
        return result;
      } catch (error) {
        const abortSignal = options.abortSignal ?? null;
        const locallySuppressed = operation?.locallySuppressed() === true;
        const aborted = operation !== null
          && !locallySuppressed
          && (abortSignal?.aborted || error?.name === "AbortError");
        const recoveredContent = locallySuppressed
          ? null
          : capture?.recover(error, { aborted }) ?? null;
        if (onData && recoveredContent !== null && streamCapture.matches(recoveredContent)) {
          // Wllama has already awaited cancelRequest() before rejecting here.
          // The streamed text is exact, but the native stop reason is unknown.
          return null;
        }
        if (aborted) {
          await operation.raw.catch(() => undefined);
        } else if (operation === null || !locallySuppressed) {
          await invalidateFatalSession(session, error);
        }
        throw error;
      } finally {
        capture?.release();
      }
    } finally {
      inferenceActive = false;
    }
  }

  function chat(options) {
    return inference({ ...options, stream: false });
  }

  function stream(options, onData) {
    if (typeof onData !== "function") {
      throw new TypeError("Wllama stream() requires an onData callback.");
    }
    return inference({ ...options, stream: true }, onData);
  }

  async function exit() {
    const current = engine;
    const loading = pending;
    const reason = new Error("Wllama was cancelled by unload.");
    loading?.cancel(reason);
    cancelTrackedOperations(reason);
    const sessions = new Set([current, loading?.engine].filter(Boolean));
    if (!sessions.size) return false;
    await Promise.all([...sessions].map((session) => exitSession(session)));
    if (engine === current) {
      engine = null;
    }
    if (pending === loading) pending = null;
    return true;
  }

  async function probe({ args = ["-o", "ADD"] } = {}) {
    if (engine) throw new Error("The no-model Wllama probe cannot run while a model is loaded.");
    if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
      throw new TypeError("Wllama probe args must be an array of strings.");
    }
    const temporary = newEngine();
    const result = await temporary.testBackendOps(args);
    return completeValue({
      ...result,
      args: completeValue([...args]),
      origin: globalThis.location?.origin ?? null,
      capabilities: capabilities(),
      evidence: evidenceState,
      runtime: BROWSER_WASM_RUNTIME_AUTHORITY,
    });
  }

  return completeValue({
    authority: BROWSER_WASM_RUNTIME_AUTHORITY,
    runtimeAssets: BROWSER_WASM_RUNTIME_AUTHORITY.runtimeAssets,
    capabilities,
    evidence,
    load,
    chat,
    stream,
    probe,
    exit,
    isLoaded: () => Boolean(engine?.isModelLoaded?.()) && evidenceState.state === "ready",
    isLoading: () => Boolean(pending),
  });
}

import { Wllama } from "./wllama/index.mjs";

const MODULE_URL = new URL("./wllama/index.mjs", import.meta.url).href;
const WASM_URL = new URL("./wllama/wllama.wasm", import.meta.url).href;
const WEBGPU_EVIDENCE_PROTOCOL = "arcane-wllama-webgpu-evidence/1";
const RUNTIME_EVIDENCE_PROTOCOL = "arcane-wllama-runtime-evidence/1";
const FULL_GPU_LAYERS = 99_999;
const WEBGPU_ADAPTER_PATTERN = /^ggml_webgpu: adapter_info: vendor_id: (\d+) \| vendor: (.*?) \| architecture: (.*?) \| device_id: (\d+) \| name: (.*?) \| device_desc: (.*)$/u;
const GPU_OFFLOAD_PATTERN = /^[^:]+: offloaded (\d+)\/(\d+) layers to GPU$/u;
const PEG_NATIVE_OUTPUT_PREFIX = "common_chat_peg_parse: unparsed peg-native output: ";
const PEG_NATIVE_FINAL_PREFIX = "<|channel|>final <|constrain|>content<|message|>";
const PEG_NATIVE_FAILURE = "The model produced output that does not match the expected peg-native format";
const MAX_RECOVERED_COMPLETION_CHARACTERS = 1_048_576;
const MAX_RECOVERED_COMPLETION_LINES = 16_384;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export const BROWSER_WASM_RUNTIME_AUTHORITY = deepFreeze({
  protocol: "arcane-ai-browser-wasm/2",
  provider: "wllama",
  executionPolicy: {
    webgpuRequired: true,
    cpuFallback: false,
    operationalEvidence: RUNTIME_EVIDENCE_PROTOCOL,
    navigatorPresenceIsOperationalEvidence: false,
    cancellation: "abortSignal-plus-llama-cancel-acknowledgement",
    cleanup: "worker-termination-only",
    nativeUnloadClaimed: false,
    physicalVramReclamationClaimed: false,
    telemetryThreatModel: "authenticated-module-closure-and-frozen-prototypes-not-hostile-platform-global-attestation",
  },
  package: {
    name: "@wllama/wllama",
    version: "3.6.0",
    sourceRevision: "f16050d8d51a00602c6a2a6b8ac9c09f490eea7f",
    resolved: "https://registry.npmjs.org/@wllama/wllama/-/wllama-3.6.0.tgz",
    npmIntegrity: "sha512-NN3ZBXqaaUwGXTQubkNvsCaLPjN2XVa0bVS40OYCE8zquYmRc2W3oHYEgwvuSWWDB8aUqTLyMioySCXNkcnD1w==",
    tarballBytes: 5_671_369,
    tarballSha256: "137c35ceccb4911a9b0ce9b427889f75991654ec6a6d1dd8fabd879b14b07a1b",
    licenseSpdx: "MIT",
    license: {
      path: "ai/wllama/LICENCE",
      bytes: 1_071,
      sha256: "5866e3bd7e3cbd3f7c8bea6efd8a1e7fa7cc8de68c30f428aff7c6584a0fb720",
    },
  },
  llamaCpp: {
    sourceRevision: "4df29be4f4c3673f428170fda944a5b19f743bb8",
    licenseSpdx: "MIT",
    license: {
      path: "ai/wllama/llama.cpp-LICENSE",
      bytes: 1_078,
      sha256: "94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d",
    },
  },
  runtimeAssets: {
    module: {
      path: "ai/wllama/index.mjs",
      url: MODULE_URL,
      bytes: 389_765,
      sha256: "ae9a6ba2aa8687785ed651e28ef92573b409d5e6d3470bfd53340225287908b8",
      mediaType: "text/javascript",
      projection: {
        protocol: WEBGPU_EVIDENCE_PROTOCOL,
        tool: "tools/project-wllama-webgpu-runtime.mjs",
        sourcePath: "node_modules/@wllama/wllama/esm/index.js",
        sourceBytes: 373_519,
        sourceSha256: "4637e42d636010493a9b274fbbe70bfd8120365da726b1d9e589d85ca84a00d6",
        wasmModified: false,
      },
    },
    wasm: {
      path: "ai/wllama/wllama.wasm",
      url: WASM_URL,
      bytes: 8_524_865,
      sha256: "95c6ff9ef2a03ff2c63bc91db132f0126a0bd0456b272cd8ae2e0f592fb059f6",
      mediaType: "application/wasm",
    },
  },
  networkPolicy: {
    compatibilityRuntime: "disabled",
    remoteModelHelpers: false,
    modelInput: "verified-local-file-only",
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
  return Object.freeze({
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

function normalizePositiveInteger(value, fallback, { maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new RangeError(`Expected an integer from 1 through ${maximum}.`);
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
    completionCapture.characters += line.length + 1;
    if (
      completionCapture.characters > MAX_RECOVERED_COMPLETION_CHARACTERS
      || completionCapture.lines.length > MAX_RECOVERED_COMPLETION_LINES
    ) {
      completionCapture.invalid = true;
      completionCapture.lines.length = 0;
    }
  }

  function observeLine(level, value) {
    observeCompletionLine(level, value);
    const line = String(value).trim();
    if (!line) return;
    const adapterMatch = line.match(WEBGPU_ADAPTER_PATTERN);
    if (adapterMatch) {
      const next = Object.freeze({
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
      const next = Object.freeze({
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

  return Object.freeze({
    logger: Object.freeze(wrapped),
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
        characters: 0,
        lines: [],
      };
      completionCapture = capture;

      function release() {
        if (completionCapture === capture) completionCapture = null;
      }

      return Object.freeze({
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
      return deepFreeze({ adapter, offload, invalid });
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
    if (content.length > MAX_RECOVERED_COMPLETION_CHARACTERS) invalid = true;
  }

  return Object.freeze({
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

function validCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function verifyProjectedTelemetry(value) {
  const worker = value?.worker;
  if (
    value?.protocol !== WEBGPU_EVIDENCE_PROTOCOL
    || worker?.protocol !== WEBGPU_EVIDENCE_PROTOCOL
    || !validCounter(worker.bufferCount)
    || !validCounter(worker.bufferBytes)
    || !validCounter(worker.queueSubmissions)
    || !validCounter(worker.commandBuffers)
    || !validCounter(worker.queueFenceRequests)
    || !validCounter(worker.queueFenceCompletions)
    || worker.queueFenceCompletions > worker.queueFenceRequests
    || worker.invalid === true
  ) {
    throw runtimeFailure(
      "ARCANE_AI_WEBGPU_EVIDENCE_INVALID",
      "The projected Wllama WebGPU evidence was missing or invalid.",
    );
  }
  return value;
}

function admittedLoadEvidence(logs, projected) {
  const worker = projected.worker;
  const offload = logs.offload;
  const failures = [];
  if (logs.invalid) failures.push("conflicting-log-evidence");
  if (!logs.adapter) failures.push("adapter-log");
  if (!offload) failures.push("offload-log");
  else if (
    !Number.isSafeInteger(offload.layers)
    || !Number.isSafeInteger(offload.totalLayers)
    || offload.totalLayers < 1
  ) failures.push("offload-shape");
  else if (offload.layers !== offload.totalLayers) {
    failures.push(`full-offload(${offload.layers}/${offload.totalLayers})`);
  }
  if (worker.bufferCount < 1) failures.push(`buffer-count(${worker.bufferCount})`);
  if (worker.bufferBytes < 1) failures.push(`buffer-bytes(${worker.bufferBytes})`);
  if (worker.queueSubmissions < 1) failures.push(`queue-submissions(${worker.queueSubmissions})`);
  if (worker.commandBuffers < 1) failures.push(`command-buffers(${worker.commandBuffers})`);
  if (worker.queueFenceRequests < 1) failures.push(`fence-requests(${worker.queueFenceRequests})`);
  if (worker.queueFenceCompletions < worker.queueFenceRequests) {
    failures.push(`fence-completions(${worker.queueFenceCompletions}/${worker.queueFenceRequests})`);
  }
  if (failures.length > 0) {
    throw runtimeFailure(
      "ARCANE_AI_WEBGPU_REQUIRED",
      `Wllama WebGPU admission failed: ${failures.join(", ")}.`,
    );
  }
  return deepFreeze({
    observed: true,
    adapter: logs.adapter,
    offload: { ...offload, allReportedModelLayers: true },
    buffers: { count: worker.bufferCount, descriptorBytes: worker.bufferBytes },
    queue: {
      submissions: worker.queueSubmissions,
      commandBuffers: worker.commandBuffers,
      fenceRequests: worker.queueFenceRequests,
      fenceCompletions: worker.queueFenceCompletions,
    },
    cpuUnusedClaimed: false,
    gpuOnlyClaimed: false,
  });
}

function initialEvidence() {
  return deepFreeze({
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
export function createPackagedWllamaRuntime({ logger = console } = {}) {
  let engine = null;
  let pending = null;
  let inferenceActive = false;
  let evidenceState = initialEvidence();
  const trackedOperations = new Set();
  const sessionExitPromises = new WeakMap();
  const sessionObservers = new WeakMap();

  function publishEvidence(update) {
    evidenceState = deepFreeze({
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
    return Object.freeze({
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
      throw new TypeError("Wllama load() requires at least one verified File or Blob.");
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
    const threads = normalizePositiveInteger(options.threads, 1, { maximum: 64 });
    const contextTokens = normalizePositiveInteger(options.contextTokens, 4_096, {
      maximum: 1_048_576,
    });
    if (options.gpuLayers !== undefined && options.gpuLayers !== FULL_GPU_LAYERS) {
      throw new RangeError(`WebGPU-required Wllama must request exactly ${FULL_GPU_LAYERS} GPU layers.`);
    }
    const gpuLayers = FULL_GPU_LAYERS;
    const loadOptions = {
      n_threads: threads,
      n_ctx: contextTokens,
      n_gpu_layers: gpuLayers,
    };
    if (options.batchTokens !== undefined) {
      loadOptions.n_batch = normalizePositiveInteger(options.batchTokens, 512, {
        maximum: contextTokens,
      });
    }
    if (options.microBatchTokens !== undefined) {
      loadOptions.n_ubatch = normalizePositiveInteger(options.microBatchTokens, 128, {
        maximum: contextTokens,
      });
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
    pending = Object.freeze({ engine: next, cancel });
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
      const projected = verifyProjectedTelemetry(await next.arcaneTelemetry());
      const webgpu = admittedLoadEvidence(sessionObservers.get(next).snapshot(), projected);
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

    return Object.freeze({
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
      throw new Error("The packaged Wllama model is not loaded with admitted WebGPU evidence.");
    }
    return engine;
  }

  async function terminateUnacknowledgedCancellation(session, reason) {
    let snapshot;
    try {
      snapshot = await exitSession(session);
    } catch (error) {
      throw runtimeFailure(
        "ARCANE_AI_WORKER_TERMINATION_UNCONFIRMED",
        "Wllama cancellation was not acknowledged and Worker termination could not be proved.",
        error,
      );
    }
    if (engine === session) engine = null;
    publishEvidence({
      cancellation: deepFreeze({
        deliverySuppressed: true,
        upstream: {
          kind: "worker-terminated",
          cancellationAcknowledged: false,
          cleanup: snapshot.cleanup,
        },
        nativeUnloadClaimed: false,
        physicalVramReclamationClaimed: false,
      }),
    });
  }

  async function recordInference(
    session,
    before,
    { aborted, requireCancellationAcknowledgement = false },
  ) {
    let after;
    try {
      after = verifyProjectedTelemetry(await session.arcaneTelemetry());
    } catch (error) {
      if (!aborted && !requireCancellationAcknowledgement) throw error;
      await terminateUnacknowledgedCancellation(session, error);
      if (requireCancellationAcknowledgement) {
        throw runtimeFailure(
          "ARCANE_AI_COMPLETION_RECOVERY_UNCONFIRMED",
          "Wllama completion recovery could not prove request settlement.",
          error,
        );
      }
      return;
    }
    const previousSequence = before?.cancellation?.sequence ?? 0;
    const cancellation = after.cancellation;
    const cancellationAcknowledged = cancellation?.sequence > previousSequence
      && cancellation.responseName === "cncl_res"
      && cancellation.acknowledged === true
      && cancellation.failed === false;
    if (aborted) {
      if (cancellationAcknowledged) {
        publishEvidence({
          cancellation: deepFreeze({
            deliverySuppressed: true,
            upstream: {
              kind: "llama-request-cancel-acknowledged",
              sequence: cancellation.sequence,
              requestId: cancellation.requestId,
              responseName: cancellation.responseName,
              acknowledged: true,
              failed: false,
            },
            immediateGpuKernelPreemptionClaimed: false,
          }),
        });
        return;
      }
      await terminateUnacknowledgedCancellation(
        session,
        "Wllama cancellation was not acknowledged.",
      );
      return;
    }
    if (requireCancellationAcknowledgement && !cancellationAcknowledged) {
      await terminateUnacknowledgedCancellation(
        session,
        "Wllama completion recovery could not prove cancellation acknowledgement.",
      );
      throw runtimeFailure(
        "ARCANE_AI_COMPLETION_RECOVERY_UNCONFIRMED",
        "Wllama completion recovery could not prove request settlement.",
      );
    }

    const submissions = after.worker.queueSubmissions - before.worker.queueSubmissions;
    const commandBuffers = after.worker.commandBuffers - before.worker.commandBuffers;
    const fenceRequests = after.worker.queueFenceRequests - before.worker.queueFenceRequests;
    const fenceCompletions = after.worker.queueFenceCompletions - before.worker.queueFenceCompletions;
    if (
      submissions < 1
      || commandBuffers < 1
      || fenceRequests < 1
      || fenceCompletions < fenceRequests
    ) {
      await exitSession(session);
      if (engine === session) engine = null;
      throw runtimeFailure(
        "ARCANE_AI_WEBGPU_REQUIRED",
        "Inference completed without positive, settled WebGPU queue evidence.",
      );
    }
    publishEvidence({
      webgpu: deepFreeze({
        ...evidenceState.webgpu,
        queue: {
          submissions: after.worker.queueSubmissions,
          commandBuffers: after.worker.commandBuffers,
          fenceRequests: after.worker.queueFenceRequests,
          fenceCompletions: after.worker.queueFenceCompletions,
        },
        lastInference: { submissions, commandBuffers, fenceRequests, fenceCompletions },
      }),
      cancellation: requireCancellationAcknowledgement
        ? deepFreeze({
          deliverySuppressed: false,
          recovery: "peg-native-final-output",
          upstream: {
            kind: "llama-request-cancel-acknowledged",
            sequence: cancellation.sequence,
            requestId: cancellation.requestId,
            responseName: cancellation.responseName,
            acknowledged: true,
            failed: false,
          },
          immediateGpuKernelPreemptionClaimed: false,
        })
        : null,
    });
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
    if (engine === session) engine = null;
    publishEvidence({
      state: "error",
      webgpu: {
        ...evidenceState.webgpu,
        observed: false,
        lastObservedOperational: evidenceState.webgpu?.lastObservedOperational === true,
      },
      failure: deepFreeze({
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
      let before = null;
      try {
        before = verifyProjectedTelemetry(await session.arcaneTelemetry());
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
        await recordInference(session, before, { aborted: false });
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
          await recordInference(session, before, {
            aborted: false,
            requireCancellationAcknowledgement: true,
          });
          return null;
        }
        if (aborted) {
          await operation.raw.catch(() => undefined);
          await recordInference(session, before, { aborted: true });
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
    if (engine === current) engine = null;
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
    return Object.freeze({
      ...result,
      args: Object.freeze([...args]),
      origin: globalThis.location?.origin ?? null,
      capabilities: capabilities(),
      evidence: evidenceState,
      runtime: BROWSER_WASM_RUNTIME_AUTHORITY,
    });
  }

  return Object.freeze({
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

import { Wllama } from "./wllama/index.mjs";

const MODULE_URL = new URL("./wllama/index.mjs", import.meta.url).href;
const WASM_URL = new URL("./wllama/wllama.wasm", import.meta.url).href;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export const BROWSER_WASM_RUNTIME_AUTHORITY = deepFreeze({
  protocol: "arcane-ai-browser-wasm/1",
  provider: "wllama",
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
      bytes: 373_519,
      sha256: "4637e42d636010493a9b274fbbe70bfd8120365da726b1d9e589d85ca84a00d6",
      mediaType: "text/javascript",
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

function runtimeCapabilitySnapshot() {
  const navigatorObject = globalThis.navigator;
  return Object.freeze({
    webAssembly: typeof globalThis.WebAssembly === "object",
    opfs: typeof navigatorObject?.storage?.getDirectory === "function",
    webgpu: Boolean(navigatorObject?.gpu),
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

/**
 * Creates one packaged Wllama session. This factory has no network or browser
 * side effects until load() is called. Runtime URLs are fixed relative to this
 * module so the same bytes work from npm and a materialized /arcane/sdk tree.
 */
export function createPackagedWllamaRuntime({ logger = console } = {}) {
  let engine = null;
  let pending = null;
  const trackedOperations = new Set();
  const sessionExitPromises = new WeakMap();

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
    let cancelled = false;
    const record = {
      cancel(reason) {
        if (cancelled) return false;
        cancelled = true;
        rejectCancellation(cancellationError(reason));
        return true;
      },
    };
    trackedOperations.add(record);
    const result = Promise.race([raw, cancellation]).finally(() => {
      trackedOperations.delete(record);
    });
    result.catch(() => undefined);
    return Object.freeze({ raw, result, cancel: record.cancel });
  }

  function cancelTrackedOperations(reason) {
    for (const operation of [...trackedOperations]) operation.cancel(reason);
  }

  function requireConfigurableDataProperty(object, key, label) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor?.configurable || !("value" in descriptor) || descriptor.get || descriptor.set) {
      throw new Error(`Pinned Wllama ${label} is not a configurable data property.`);
    }
    return descriptor;
  }

  function guardLoadingSession(session) {
    const sessionDescriptor = requireConfigurableDataProperty(session, "proxy", "proxy");
    let proxy = sessionDescriptor.value;
    let cancelled = null;
    const workerGuards = new Map();

    function guardProxy(nextProxy) {
      if (!nextProxy || workerGuards.has(nextProxy)) return;
      const descriptor = requireConfigurableDataProperty(nextProxy, "worker", "proxy worker");
      let worker = descriptor.value;
      Object.defineProperty(nextProxy, "worker", {
        enumerable: descriptor.enumerable,
        configurable: true,
        get: () => worker,
        set(value) {
          if (value && cancelled) {
            value.terminate?.();
            throw cancelled;
          }
          worker = value;
        },
      });
      workerGuards.set(nextProxy, () => {
        Object.defineProperty(nextProxy, "worker", { ...descriptor, value: worker });
      });
      if (worker && cancelled) {
        worker.terminate?.();
        throw cancelled;
      }
    }

    if (proxy) guardProxy(proxy);
    Object.defineProperty(session, "proxy", {
      enumerable: sessionDescriptor.enumerable,
      configurable: true,
      get: () => proxy,
      set(value) {
        if (value && cancelled) {
          value.worker?.terminate?.();
          throw cancelled;
        }
        proxy = value;
        if (value) guardProxy(value);
      },
    });

    return Object.freeze({
      cancel(reason) {
        cancelled ||= cancellationError(reason, "The Wllama model load was cancelled.");
        const current = proxy;
        current?.worker?.terminate?.();
        try {
          current?.abort?.(cancelled.message, "");
        } catch {
          // The tracked operation gate remains the stable cancellation result.
        }
        return cancelled;
      },
      restore() {
        for (const restoreWorker of workerGuards.values()) restoreWorker();
        workerGuards.clear();
        Object.defineProperty(session, "proxy", { ...sessionDescriptor, value: proxy });
      },
    });
  }

  function exitSession(session, reason) {
    if (!session) return Promise.resolve(false);
    let exitPromise = sessionExitPromises.get(session);
    if (!exitPromise) {
      const attempt = Promise.resolve().then(() => {
        try {
          session.proxy?.abort?.(cancellationError(reason).message, "");
        } catch {
          // Public session.exit() still owns Worker termination.
        }
        return session.exit();
      }).then(() => true);
      exitPromise = attempt.catch((error) => {
        // A failed cleanup attempt is not proof that this session is closed.
        // Evict only this attempt so a later exit() can retry the same handle.
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
    const next = new Wllama({ default: WASM_URL }, {
      logger,
      allowOffline: true,
    });
    next.setCompat(null);
    const resources = next.getWorkerResources();
    if (resources.compat !== false || resources.wasmPath !== WASM_URL || resources.jsPath) {
      throw new Error("The packaged Wllama resource projection was not exact.");
    }
    return next;
  }

  function capabilities() {
    return runtimeCapabilitySnapshot();
  }

  async function load(files, options = {}) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new TypeError("Wllama load() requires at least one verified File or Blob.");
    }
    if (typeof globalThis.WebAssembly !== "object") {
      throw new Error("WebAssembly is unavailable in this browser.");
    }
    if (engine || pending) {
      throw new Error("The packaged Wllama runtime is already loaded or loading.");
    }

    // Wllama defaults to a CDN compatibility runtime. Arcane never admits it.
    const next = newEngine();

    const threads = normalizePositiveInteger(options.threads, 1, { maximum: 64 });
    const contextTokens = normalizePositiveInteger(options.contextTokens, 4_096, {
      maximum: 1_048_576,
    });
    const loadOptions = {
      n_threads: threads,
      n_ctx: contextTokens,
      n_gpu_layers: Number.isSafeInteger(options.gpuLayers) ? options.gpuLayers : 0,
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

    const loadGuard = guardLoadingSession(next);
    const operation = trackOperation(Promise.resolve().then(() => next.loadModel(files, loadOptions)));
    operation.raw.finally(loadGuard.restore).catch(() => undefined);
    const cancel = (reason) => {
      const error = loadGuard.cancel(reason);
      operation.cancel(error);
    };
    pending = Object.freeze({
      engine: next,
      cancel,
    });
    const signal = options.signal ?? null;
    const onAbort = () => cancel(signal.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      await operation.result;
      if (pending?.engine !== next) throw new Error("Wllama load was cancelled.");
      pending = null;
      engine = next;
    } catch (error) {
      try {
        await exitSession(next, error);
        if (pending?.engine === next) pending = null;
      } catch {
        // Preserve the exact pending session for a later runtime.exit() retry.
        // The original load failure remains the stable public rejection.
      }
      throw error;
    } finally {
      signal?.removeEventListener?.("abort", onAbort);
    }

    return Object.freeze({
      loaded: true,
      contextTokens,
      threads,
      metadata: engine.getModelMetadata?.() ?? null,
    });
  }

  function assertLoaded() {
    if (!engine?.isModelLoaded?.()) throw new Error("The packaged Wllama model is not loaded.");
    return engine;
  }

  async function chat(options) {
    const session = assertLoaded();
    return trackOperation(
      Promise.resolve().then(() => session.createChatCompletion({ ...options, stream: false })),
    ).result;
  }

  async function stream(options, onData) {
    if (typeof onData !== "function") {
      throw new TypeError("Wllama stream() requires an onData callback.");
    }
    // Wllama owns the request slot until this promise settles. Its documented
    // abortSignal path cancels the llama.cpp request in a finally block.
    const session = assertLoaded();
    return trackOperation(
      Promise.resolve().then(() => session.createChatCompletion({ ...options, stream: true, onData })),
    ).result;
  }

  async function exit() {
    const current = engine;
    const loading = pending;
    const reason = new Error("Wllama was cancelled by unload.");
    loading?.cancel(reason);
    cancelTrackedOperations(reason);
    const sessions = new Set([current, loading?.engine].filter(Boolean));
    if (!sessions.size) return false;
    await Promise.all([...sessions].map((session) => exitSession(session, reason)));
    // Retain ownership through cleanup failure. Clear only the exact handles
    // whose exit attempts completed successfully; replacement sessions, if
    // any, remain owned by the runtime.
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
    // testBackendOps owns and closes its temporary worker. It requires browser
    // multithreading, but that is a probe capability—not model admission.
    const result = await temporary.testBackendOps(args);
    return Object.freeze({
      ...result,
      args: Object.freeze([...args]),
      origin: globalThis.location?.origin ?? null,
      capabilities: capabilities(),
      runtime: BROWSER_WASM_RUNTIME_AUTHORITY,
    });
  }

  return Object.freeze({
    authority: BROWSER_WASM_RUNTIME_AUTHORITY,
    runtimeAssets: BROWSER_WASM_RUNTIME_AUTHORITY.runtimeAssets,
    capabilities,
    load,
    chat,
    stream,
    probe,
    exit,
    isLoaded: () => Boolean(engine?.isModelLoaded?.()),
    isLoading: () => Boolean(pending),
  });
}

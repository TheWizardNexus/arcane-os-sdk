import {
  ARCANE_AI_ADAPTER_PROTOCOL,
  ArcaneAIError,
  normalizeModelSecurity,
  normalizeArcaneAIError,
  resolveModelSecurity,
  sameModelSecurity,
} from "./model-controller.mjs";
import { createPackagedWllamaRuntime } from "./browser-wllama-runtime.mjs";
import { createStreamingSha256 } from "./internal/sha256.mjs";
import { arcaneEvents } from "../event-manager.mjs";

const MODEL_MANIFEST_SCHEMA = "arcane.ai.browser-wasm.model.v3";
const LEGACY_MODEL_MANIFEST_SCHEMA = "arcane.ai.browser-wasm.model.v2";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MUTABLE_PATH_PATTERN = /\/(?:resolve\/)?(?:main|master|latest)(?:\/|$)/iu;
const BROWSER_MODEL_SOURCES = new WeakSet();
const BROWSER_MODEL_SOURCE_METADATA = new WeakMap();
const DBOPFS_MODEL_STORES = new WeakSet();
const V1_LLM_PROVIDER_ADAPTERS = new WeakMap();
const AI_PROVIDER_PROTOCOL = "arcane-ai-provider/2";
const AI_MODEL_AUTHORITY_PROTOCOL = "arcane-ai-model-authority/1";
const WEBGPU_ADAPTER_SELECTED_EVENT = "arcane.ai.browser-wasm.webgpu.adapter.selected";
const WEBGPU_ADAPTER_SELECTION_PROTOCOL = "arcane-ai-webgpu-adapter-selection/1";

function fail(code, message, cause) {
  return new ArcaneAIError(code, message, {
    cause,
    kind: "llm",
    operation: "request",
  });
}

function throwIfAborted(signal, operation = "request") {
  if (!signal?.aborted) return;
  throw new ArcaneAIError(
    "ARCANE_AI_REQUEST_ABORTED",
    "The Arcane AI request was cancelled.",
    { cause: signal.reason, kind: "llm", operation },
  );
}

function normalizationSignal(error, signal) {
  return error?.code === "ARCANE_AI_WORKER_TERMINATION_UNCONFIRMED" ? null : signal;
}

function immutableHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.hash
    || MUTABLE_PATH_PATTERN.test(url.pathname)
  ) return null;
  return url;
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Browser model ${field} must be a nonempty string.`);
  }
  return value.trim();
}

function modelDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("A browser model descriptor is required.");
  }
  const id = requiredText(value.id, "id");
  if (
    value.url !== undefined
    && value.immutableUrl !== undefined
    && value.url !== value.immutableUrl
  ) {
    throw new TypeError("Browser model url and legacy immutableUrl must match when both are provided.");
  }
  const url = immutableHttpsUrl(value.url ?? value.immutableUrl);
  if (!url) {
    throw new TypeError("Browser model url must be immutable HTTPS without credentials or fragments.");
  }
  let bytes;
  if (value.bytes !== undefined) {
    if (!Number.isSafeInteger(value.bytes) || value.bytes < 1) {
      throw new TypeError("Browser model bytes must be a positive safe integer when provided.");
    }
    bytes = value.bytes;
  }
  let sha256;
  if (value.sha256 !== undefined) {
    sha256 = requiredText(value.sha256, "sha256").toLowerCase();
    if (!SHA256_PATTERN.test(sha256)) {
      throw new TypeError("Browser model sha256 must be exactly 64 hexadecimal characters when provided.");
    }
  }
  const descriptor = {
    id,
    url: url.href,
  };
  if (bytes !== undefined) descriptor.bytes = bytes;
  if (sha256 !== undefined) descriptor.sha256 = sha256;
  return Object.freeze(descriptor);
}

function publicDescriptor(source) {
  const descriptor = {
    id: source.id,
    url: source.url,
  };
  if (source.bytes !== undefined) descriptor.bytes = source.bytes;
  if (source.sha256 !== undefined) descriptor.sha256 = source.sha256;
  return Object.freeze(descriptor);
}

function emitWebgpuAdapterSelection(source, runtime) {
  const evidence = runtime.evidence();
  const webgpu = evidence?.webgpu;
  if (webgpu?.observed !== true || !webgpu.adapter) return;
  arcaneEvents.instrument(WEBGPU_ADAPTER_SELECTED_EVENT, Object.freeze({
    protocol: WEBGPU_ADAPTER_SELECTION_PROTOCOL,
    providerId: "arcane-browser-wasm-wllama",
    modelId: source.id,
    runtimeEvidenceProtocol: evidence.protocol,
    adapter: webgpu.adapter,
    offload: webgpu.offload ?? null,
    buffers: webgpu.buffers ?? null,
    queue: webgpu.queue ?? null,
  }), Object.freeze({
    source: "sdk:ai/browser-wasm",
    category: "capability",
  }));
}

function manifestModelIdentity(source) {
  return Object.freeze({ id: source.id, url: source.url });
}

function modelFileName(value, model) {
  if (value.name !== undefined) {
    const legacyName = requiredText(value.name, "legacy name");
    if (
      legacyName !== legacyName.split(/[\\/]/u).pop()
      || legacyName === "."
      || legacyName === ".."
    ) {
      throw new TypeError("Browser model legacy name must be a single filename.");
    }
    return legacyName;
  }
  const encoded = new URL(model.url).pathname.split("/").filter(Boolean).pop() ?? "";
  let decoded = "";
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    decoded = "";
  }
  if (
    decoded
    && decoded === decoded.split(/[\\/]/u).pop()
    && decoded !== "."
    && decoded !== ".."
  ) return decoded;
  const safeId = model.id.replace(/[^a-z0-9._-]+/giu, "_");
  return `${safeId}.gguf`;
}

/**
 * Creates a browser download authority for one caller-supplied immutable
 * model. Effective load security decides which expected-byte checks run.
 */
export function createBrowserModelSource(descriptor, {
  fetchImpl = null,
} = {}) {
  const model = modelDescriptor(descriptor);
  const fileName = modelFileName(descriptor, model);

  async function open({ signal } = {}) {
    throwIfAborted(signal, "install");
    const fetchFunction = fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchFunction !== "function") {
      throw fail("ARCANE_AI_MODEL_SOURCE_UNAVAILABLE", "Browser fetch is unavailable.");
    }

    let response;
    try {
      response = await fetchFunction(model.url, {
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        redirect: "follow",
        referrerPolicy: "no-referrer",
        signal,
      });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throwIfAborted(signal, "install");
      throw fail("ARCANE_AI_MODEL_DOWNLOAD_FAILED", "The model download failed.", error);
    }
    if (!response?.ok) {
      await response?.body?.cancel?.().catch(() => undefined);
      throw fail(
        "ARCANE_AI_MODEL_DOWNLOAD_FAILED",
        `The model server returned HTTP ${response?.status ?? "unknown"}.`,
      );
    }
    let finalUrl;
    try {
      finalUrl = new URL(response.url || model.url);
    } catch {
      finalUrl = null;
    }
    if (finalUrl?.protocol !== "https:") {
      await response.body?.cancel?.().catch(() => undefined);
      throw fail("ARCANE_AI_MODEL_REDIRECT_BLOCKED", "The model response left HTTPS.");
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      throw fail("ARCANE_AI_MODEL_SOURCE_INVALID", "The model response did not provide a byte stream.");
    }
    const header = response.headers?.get?.("content-length");
    const reported = header === null || header === undefined || header === ""
      ? null
      : Number(header);
    return Object.freeze({
      body: response.body,
      requestedUrl: model.url,
      finalUrl: finalUrl.href,
      reportedBytes: Number.isSafeInteger(reported) && reported >= 0 ? reported : null,
      cancel: (reason) => response.body.cancel(reason),
    });
  }

  const sourceRecord = {
    kind: "arcane-browser-model-source",
    ...model,
    descriptor: publicDescriptor(model),
    open,
  };
  Object.defineProperties(sourceRecord, {
    name: { value: fileName, enumerable: false },
    immutableUrl: { value: model.url, enumerable: false },
  });
  const source = Object.freeze(sourceRecord);
  BROWSER_MODEL_SOURCES.add(source);
  BROWSER_MODEL_SOURCE_METADATA.set(source, Object.freeze({ fileName }));
  return source;
}

async function* byteChunks(body, signal) {
  if (body instanceof Uint8Array || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    throwIfAborted(signal, "install");
    yield body instanceof Uint8Array
      ? body
      : new Uint8Array(body.buffer ?? body, body.byteOffset ?? 0, body.byteLength);
    return;
  }
  if (body && typeof body.stream === "function") {
    yield* byteChunks(body.stream(), signal);
    return;
  }
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      while (true) {
        throwIfAborted(signal, "install");
        let removeAbort = () => undefined;
        const aborted = new Promise((_, reject) => {
          if (!signal) return;
          const onAbort = () => {
            void reader.cancel(signal.reason).catch(() => undefined);
            reject(new ArcaneAIError(
              "ARCANE_AI_REQUEST_ABORTED",
              "The Arcane AI request was cancelled.",
              { cause: signal.reason, kind: "llm", operation: "install" },
            ));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", onAbort);
        });
        let step;
        try {
          step = signal ? await Promise.race([reader.read(), aborted]) : await reader.read();
        } finally {
          removeAbort();
        }
        const { done, value } = step;
        if (done) return;
        yield value instanceof Uint8Array ? value : new Uint8Array(value);
      }
    } finally {
      if (signal?.aborted) await reader.cancel(signal.reason).catch(() => undefined);
      reader.releaseLock?.();
    }
  }
  throw fail("ARCANE_AI_MODEL_SOURCE_INVALID", "The model source did not provide readable bytes.");
}

function storageName(source) {
  const safeId = source.id.replace(/[^a-z0-9._-]+/giu, "_");
  const fileName = BROWSER_MODEL_SOURCE_METADATA.get(source)?.fileName ?? source.name;
  return Object.freeze({
    model: `${safeId}--${fileName}`,
    manifest: `${safeId}.complete.json`,
  });
}

function manifestFor(source, finalUrl, observedBytes) {
  return Object.freeze({
    schema: MODEL_MANIFEST_SCHEMA,
    complete: true,
    model: manifestModelIdentity(source),
    observedBytes,
    finalUrl,
    completedAt: new Date().toISOString(),
  });
}

function manifestKind(manifest, source) {
  const model = manifest?.model;
  if (
    manifest?.schema === MODEL_MANIFEST_SCHEMA
    && manifest?.complete === true
    && model?.id === source.id
    && model?.url === source.url
    && Number.isSafeInteger(manifest.observedBytes)
    && manifest.observedBytes >= 0
  ) return "current";
  const fileName = BROWSER_MODEL_SOURCE_METADATA.get(source)?.fileName ?? source.name;
  if (
    manifest?.schema === LEGACY_MODEL_MANIFEST_SCHEMA
    && manifest?.complete === true
    && model?.id === source.id
    && model?.name === fileName
    && model?.immutableUrl === source.url
  ) return "legacy";
  return null;
}

function progress(source, phase, loaded, total = null) {
  return Object.freeze({
    modelId: source.id,
    phase,
    loaded,
    total,
    percent: Number.isSafeInteger(total) && total > 0 ? (loaded / total) * 100 : null,
  });
}

function securitySnapshot(security) {
  return Object.freeze({
    secure: security.secure,
    checks: Object.freeze({
      byteLength: security.checks.byteLength,
      sha256: security.checks.sha256,
    }),
  });
}

function assertDescriptorChecks(source, security) {
  if (security.checks.byteLength && source.bytes === undefined) {
    throw fail(
      "ARCANE_AI_MODEL_SOURCE_INVALID",
      "Browser model bytes is required when the byteLength check is enabled.",
    );
  }
  if (security.checks.sha256 && source.sha256 === undefined) {
    throw fail(
      "ARCANE_AI_MODEL_SOURCE_INVALID",
      "Browser model sha256 is required when the sha256 check is enabled.",
    );
  }
}

function integritySnapshot(security, source, {
  observedBytes = null,
  byteLength = security.checks.byteLength ? "pending" : "unchecked",
  sha256 = security.checks.sha256 ? "pending" : "unchecked",
  actualSha256 = null,
} = {}) {
  const enabledStates = [];
  if (security.checks.byteLength) enabledStates.push(byteLength);
  if (security.checks.sha256) enabledStates.push(sha256);
  const state = enabledStates.length === 0
    ? "unchecked"
    : enabledStates.every((value) => value === "verified")
      ? "verified"
      : enabledStates.some((value) => value === "failed")
        ? "failed"
        : "pending";
  return Object.freeze({
    state,
    observedBytes,
    byteLength: Object.freeze({
      enabled: security.checks.byteLength,
      state: byteLength,
      expected: source.bytes ?? null,
      observed: observedBytes,
    }),
    sha256: Object.freeze({
      enabled: security.checks.sha256,
      state: sha256,
      expected: source.sha256 ?? null,
      actual: actualSha256,
    }),
  });
}

/**
 * Adapts an existing Arcane DBOPFS singleton without rebinding or changing any
 * of its public methods. The completion manifest is committed only after the
 * model file has been written. SHA-256 is read and computed only when its
 * effective check is enabled.
 */
export function createDbopfsModelStore({
  dbopfs,
  tableName = "arcane_ai_browser_models",
} = {}) {
  if (!dbopfs || (typeof dbopfs !== "object" && typeof dbopfs !== "function")) {
    throw new TypeError("createDbopfsModelStore requires an existing DBOPFS instance.");
  }
  if (typeof dbopfs.getTableHandle !== "function") {
    throw new TypeError("The DBOPFS instance is missing getTableHandle().");
  }
  if (dbopfs.readyPromise !== undefined && typeof dbopfs.readyPromise?.then !== "function") {
    throw new TypeError("The DBOPFS readyPromise must be thenable.");
  }
  let tablePromise = null;

  async function table() {
    if (dbopfs.readyPromise) await dbopfs.readyPromise;
    tablePromise ||= Promise.resolve(dbopfs.getTableHandle(tableName));
    const handle = await tablePromise;
    if (!handle || typeof handle.getFileHandle !== "function" || typeof handle.removeEntry !== "function") {
      throw fail("ARCANE_AI_STORAGE_UNAVAILABLE", "DBOPFS did not provide an OPFS table handle.");
    }
    return handle;
  }

  async function removeEntry(name) {
    try {
      await (await table()).removeEntry(name);
      return true;
    } catch (error) {
      if (error?.name === "NotFoundError" || error?.code === "ENOENT") return false;
      throw fail("ARCANE_AI_STORAGE_DELETE_FAILED", `Unable to remove DBOPFS entry ${name}.`, error);
    }
  }

  async function file(name) {
    try {
      const handle = await (await table()).getFileHandle(name, { create: false });
      return await handle.getFile();
    } catch (error) {
      if (error?.name === "NotFoundError" || error?.code === "ENOENT") return null;
      throw fail("ARCANE_AI_STORAGE_READ_FAILED", `Unable to read DBOPFS entry ${name}.`, error);
    }
  }

  async function write(name, body, { signal, onChunk } = {}) {
    const directory = await table();
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    let written = 0;
    try {
      for await (const chunk of byteChunks(body, signal)) {
        await writable.write(chunk);
        written += chunk.byteLength;
        await onChunk?.(chunk, written);
      }
      throwIfAborted(signal, "install");
      await writable.close();
      return written;
    } catch (error) {
      await writable.abort?.(error).catch(() => undefined);
      await directory.removeEntry(name).catch(() => undefined);
      throw error;
    }
  }

  async function readManifest(name) {
    const manifestFile = await file(name);
    if (!manifestFile) return null;
    try {
      return JSON.parse(await manifestFile.text());
    } catch {
      await removeEntry(name);
      return null;
    }
  }

  async function remove(source) {
    const names = storageName(source);
    const removed = await Promise.all([
      removeEntry(names.manifest),
      removeEntry(names.model),
    ]);
    return removed.some(Boolean);
  }

  async function writeManifest(name, manifest, signal) {
    const encoded = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
    await write(name, encoded, { signal });
  }

  async function verifySha256(source, modelFile, { signal, onProgress, phase }) {
    const digest = createStreamingSha256();
    let hashed = 0;
    for await (const chunk of byteChunks(modelFile, signal)) {
      digest.update(chunk);
      hashed += chunk.byteLength;
      onProgress?.(progress(source, phase, hashed, modelFile.size));
    }
    return Object.freeze({ hashed, sha256: digest.digestHex() });
  }

  async function openCached(source, {
    signal,
    onProgress,
    security = resolveModelSecurity(),
  } = {}) {
    assertDescriptorChecks(source, security);
    const names = storageName(source);
    const manifest = await readManifest(names.manifest);
    const kind = manifestKind(manifest, source);
    if (!kind) {
      // A model file without the exact completion manifest is a partial, even
      // when the manifest is missing or malformed rather than merely stale.
      await remove(source);
      return null;
    }
    const modelFile = await file(names.model);
    if (!modelFile) {
      await remove(source);
      return null;
    }
    const observedBytes = modelFile.size;
    if (kind === "current" && manifest.observedBytes !== observedBytes) {
      await remove(source);
      return null;
    }
    if (security.checks.byteLength && observedBytes !== source.bytes) {
      await remove(source);
      return null;
    }
    let actualSha256 = null;
    try {
      if (security.checks.sha256) {
        const verification = await verifySha256(source, modelFile, {
          signal,
          onProgress,
          phase: "verify-cache",
        });
        actualSha256 = verification.sha256;
        if (verification.hashed !== observedBytes || actualSha256 !== source.sha256) {
          await remove(source);
          return null;
        }
      } else {
        onProgress?.(progress(source, "cache", observedBytes, observedBytes));
      }
      let completion = manifest;
      if (kind === "legacy") {
        completion = manifestFor(source, manifest.finalUrl ?? source.url, observedBytes);
      }
      return Object.freeze({
        file: modelFile,
        manifest: completion,
        observedBytes,
        integrity: integritySnapshot(security, source, {
          observedBytes,
          byteLength: security.checks.byteLength ? "verified" : "unchecked",
          sha256: security.checks.sha256 ? "verified" : "unchecked",
          actualSha256,
        }),
      });
    } catch (error) {
      if (!signal?.aborted) await remove(source);
      throw error;
    }
  }

  async function openVerified(source, { signal, onProgress } = {}) {
    const security = resolveModelSecurity({ load: { secure: true } });
    return openCached(source, { signal, onProgress, security });
  }

  async function install(source, { signal, onProgress, security: configuredSecurity } = {}) {
    const security = resolveModelSecurity({ load: configuredSecurity });
    assertDescriptorChecks(source, security);
    const names = storageName(source);
    await remove(source);
    const opened = await source.open({ signal });
    try {
      if (
        security.checks.byteLength
        && opened.reportedBytes !== null
        && opened.reportedBytes !== source.bytes
      ) {
        throw fail(
          "ARCANE_AI_MODEL_SIZE_MISMATCH",
          "The model response Content-Length did not match the expected byte length.",
        );
      }
      const written = await write(names.model, opened.body, {
        signal,
        async onChunk(_chunk, loaded) {
          if (security.checks.byteLength && loaded > source.bytes) {
            throw fail("ARCANE_AI_MODEL_SIZE_MISMATCH", "Downloaded model exceeded its declared size.");
          }
          const total = security.checks.byteLength ? source.bytes : null;
          onProgress?.(progress(source, "download", loaded, total));
        },
      });
      onProgress?.(progress(source, "download", written, written));
      if (security.checks.byteLength && written !== source.bytes) {
        throw fail(
          "ARCANE_AI_MODEL_SIZE_MISMATCH",
          "Downloaded model bytes did not match the caller-supplied expected byte length.",
        );
      }
      const modelFile = await file(names.model);
      if (!modelFile || modelFile.size !== written) {
        throw fail(
          "ARCANE_AI_MODEL_CACHE_REJECTED",
          "The stored model did not preserve the observed downloaded byte count.",
        );
      }
      let actualSha256 = null;
      if (security.checks.sha256) {
        const verification = await verifySha256(source, modelFile, {
          signal,
          onProgress,
          phase: "verify-download",
        });
        actualSha256 = verification.sha256;
        if (verification.hashed !== written || actualSha256 !== source.sha256) {
          throw fail(
            "ARCANE_AI_MODEL_DIGEST_MISMATCH",
            "Downloaded model bytes did not match the caller-supplied SHA-256 value.",
          );
        }
      }
      // Completion is the final storage mutation. A file without this exact
      // manifest is never admitted for inference or offline reuse.
      const manifest = manifestFor(source, opened.finalUrl, written);
      await writeManifest(names.manifest, manifest, signal);
      return Object.freeze({
        file: modelFile,
        manifest,
        observedBytes: written,
        integrity: integritySnapshot(security, source, {
          observedBytes: written,
          byteLength: security.checks.byteLength ? "verified" : "unchecked",
          sha256: security.checks.sha256 ? "verified" : "unchecked",
          actualSha256,
        }),
      });
    } catch (error) {
      await opened.cancel?.(error).catch(() => undefined);
      await remove(source).catch(() => undefined);
      throw error;
    }
  }

  async function ensure(source, {
    signal,
    onProgress,
    offline = false,
    security: configuredSecurity,
  } = {}) {
    const security = resolveModelSecurity({ load: configuredSecurity });
    assertDescriptorChecks(source, security);
    const cached = await openCached(source, { signal, onProgress, security });
    if (cached) return Object.freeze({ ...cached, cache: "cached" });
    if (offline) {
      throw fail("ARCANE_AI_MODEL_OFFLINE_MISS", "No admitted offline model cache is available.");
    }
    const installed = await install(source, { signal, onProgress, security });
    return Object.freeze({ ...installed, cache: "installed" });
  }

  const store = Object.freeze({
    kind: "arcane-dbopfs-model-store",
    tableName,
    adapter: dbopfs,
    ready: () => table().then(() => undefined),
    openVerified,
    install,
    ensure,
    remove,
  });
  DBOPFS_MODEL_STORES.add(store);
  return store;
}

function linkAbortSignal(externalSignal) {
  const controller = new AbortController();
  const forward = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) forward();
  else externalSignal?.addEventListener?.("abort", forward, { once: true });
  return Object.freeze({
    controller,
    release() {
      externalSignal?.removeEventListener?.("abort", forward);
    },
  });
}

function createSerialRequestQueue(onDepth) {
  let tail = Promise.resolve();
  let depth = 0;

  function abortError(signal) {
    return new ArcaneAIError(
      "ARCANE_AI_REQUEST_ABORTED",
      "The Arcane AI request was cancelled.",
      { cause: signal?.reason, kind: "llm", operation: "request" },
    );
  }

  function schedule(operation, signal = null) {
    depth += 1;
    onDepth(depth);
    let started = false;
    let outerSettled = false;
    let resolveOuter;
    let rejectOuter;
    const result = new Promise((resolve, reject) => {
      resolveOuter = resolve;
      rejectOuter = reject;
    });
    const onAbort = () => {
      if (started || outerSettled) return;
      outerSettled = true;
      rejectOuter(abortError(signal));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const task = tail.catch(() => undefined).then(async () => {
      started = true;
      if (signal?.aborted) throw abortError(signal);
      return operation();
    }).then(
      (value) => {
        if (!outerSettled) {
          outerSettled = true;
          resolveOuter(value);
        }
      },
      (error) => {
        if (!outerSettled) {
          outerSettled = true;
          rejectOuter(error);
        }
      },
    );
    tail = task.catch(() => undefined).finally(() => {
      signal?.removeEventListener?.("abort", onAbort);
      depth -= 1;
      onDepth(depth);
    });
    return result;
  }

  function openStream(operation, signal = null) {
    let resolveReady;
    let rejectReady;
    let readySettled = false;
    let started = false;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const onAbort = () => {
      if (started || readySettled) return;
      readySettled = true;
      rejectReady(abortError(signal));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    schedule(async () => {
      started = true;
      if (signal?.aborted) throw abortError(signal);
      try {
        const handle = await operation();
        if (!readySettled) {
          readySettled = true;
          resolveReady(handle);
        }
        await handle.result;
      } catch (error) {
        if (!readySettled) {
          readySettled = true;
          rejectReady(error);
        }
        throw error;
      } finally {
        signal?.removeEventListener?.("abort", onAbort);
      }
    }, signal).catch(() => undefined);
    return ready;
  }

  return Object.freeze({
    schedule,
    openStream,
    idle: () => tail,
  });
}

function responseFormat(structuredOutput) {
  if (structuredOutput === undefined || structuredOutput === null || structuredOutput === false) {
    return undefined;
  }
  if (structuredOutput === true || structuredOutput === "json") {
    return Object.freeze({ type: "json_object" });
  }
  if (typeof structuredOutput !== "object" || Array.isArray(structuredOutput)) {
    throw new TypeError("structuredOutput must be false, true, \"json\", or a JSON Schema object.");
  }
  return Object.freeze({
    type: "json_schema",
    json_schema: Object.freeze({ name: "arcane_response", strict: true, schema: structuredOutput }),
  });
}

function completionOptions(request, abortSignal, stream) {
  if (!Array.isArray(request?.messages)) throw new TypeError("messages must be an array.");
  const options = {
    messages: request.messages,
    stream,
    abortSignal,
  };
  const copy = [
    ["temperature", "temperature"],
    ["topK", "top_k"],
    ["top_k", "top_k"],
    ["topP", "top_p"],
    ["top_p", "top_p"],
    ["minP", "min_p"],
    ["min_p", "min_p"],
    ["repeatPenalty", "penalty_repeat"],
    ["penalty_repeat", "penalty_repeat"],
    ["maxTokens", "max_tokens"],
    ["max_tokens", "max_tokens"],
    ["seed", "seed"],
    ["stop", "stop"],
  ];
  for (const [source, target] of copy) {
    if (request[source] !== undefined) options[target] = request[source];
  }
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools)) throw new TypeError("tools must be an array.");
    options.tools = request.tools;
  }
  if (request.toolChoice !== undefined) options.tool_choice = request.toolChoice;
  if (request.tool_choice !== undefined) options.tool_choice = request.tool_choice;
  if (request.parallelToolCalls !== undefined) options.parallel_tool_calls = request.parallelToolCalls;
  if (request.parallel_tool_calls !== undefined) options.parallel_tool_calls = request.parallel_tool_calls;
  const format = responseFormat(request.structuredOutput);
  if (format) options.response_format = format;
  return options;
}

function validateToolCalls(message) {
  if (message?.tool_calls === undefined) return;
  if (!Array.isArray(message.tool_calls)) {
    throw fail("ARCANE_AI_INVALID_PROVIDER_RESULT", "The model returned malformed tool calls.");
  }
  const ids = new Set();
  for (const call of message.tool_calls) {
    if (
      typeof call?.id !== "string"
      || !call.id
      || ids.has(call.id)
      || call.type !== "function"
      || typeof call.function?.name !== "string"
      || !call.function.name
      || typeof call.function?.arguments !== "string"
    ) {
      throw fail("ARCANE_AI_INVALID_PROVIDER_RESULT", "The model returned malformed tool calls.");
    }
    ids.add(call.id);
  }
}

function validateCompletion(value, requestId) {
  if (
    !value
    || typeof value !== "object"
    || !Array.isArray(value.choices)
    || value.choices.length === 0
  ) {
    throw fail("ARCANE_AI_INVALID_PROVIDER_RESULT", "The model returned an invalid chat completion.");
  }
  const indexes = new Set();
  for (const choice of value.choices) {
    if (!Number.isSafeInteger(choice?.index) || choice.index < 0 || indexes.has(choice.index)) {
      throw fail("ARCANE_AI_INVALID_PROVIDER_RESULT", "The model returned an invalid choice index.");
    }
    indexes.add(choice.index);
    validateToolCalls(choice.message);
  }
  return requestId === undefined ? value : Object.freeze({ ...value, id: requestId });
}

function createCompletionAccumulator(modelId, requestId) {
  const choices = new Map();
  let base = { id: requestId ?? null, object: "chat.completion", model: modelId, choices: [] };

  function choice(index) {
    const key = index ?? 0;
    if (!Number.isSafeInteger(key) || key < 0) {
      throw fail("ARCANE_AI_INVALID_PROVIDER_RESULT", "The model returned an invalid stream choice index.");
    }
    if (!choices.has(key)) {
      choices.set(key, {
        index: key,
        role: "assistant",
        content: "",
        sawContent: false,
        reasoning: "",
        sawReasoning: false,
        finish_reason: null,
        tools: new Map(),
      });
    }
    return choices.get(key);
  }

  function push(value) {
    if (!value || typeof value !== "object") return;
    base = { ...base, ...value, id: requestId ?? value.id ?? base.id, choices: [] };
    for (const item of Array.isArray(value.choices) ? value.choices : []) {
      const record = choice(item.index);
      const delta = item.delta ?? {};
      if (typeof delta.role === "string") record.role = delta.role;
      if (typeof delta.content === "string") {
        record.content += delta.content;
        record.sawContent = true;
      }
      if (typeof delta.reasoning_content === "string") {
        record.reasoning += delta.reasoning_content;
        record.sawReasoning = true;
      }
      if (item.finish_reason !== undefined) record.finish_reason = item.finish_reason;
      if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) {
        throw fail("ARCANE_AI_INVALID_PROVIDER_RESULT", "The model returned malformed streamed tool calls.");
      }
      for (const fragment of delta.tool_calls ?? []) {
        if (!Number.isSafeInteger(fragment?.index) || fragment.index < 0) {
          throw fail("ARCANE_AI_INVALID_PROVIDER_RESULT", "A streamed tool call had no valid index.");
        }
        const tool = record.tools.get(fragment.index) ?? {
          index: fragment.index,
          id: "",
          type: "",
          name: "",
          arguments: "",
        };
        if (typeof fragment.id === "string" && !tool.id) tool.id = fragment.id;
        if (typeof fragment.type === "string") tool.type = fragment.type;
        if (typeof fragment.function?.name === "string") tool.name += fragment.function.name;
        if (typeof fragment.function?.arguments === "string") tool.arguments += fragment.function.arguments;
        record.tools.set(fragment.index, tool);
      }
    }
  }

  function result() {
    const completion = {
      ...base,
      object: "chat.completion",
      choices: [...choices.values()].sort((a, b) => a.index - b.index).map((record) => {
        const message = {
          role: record.role,
          content: record.sawContent ? record.content : null,
        };
        if (record.sawReasoning) message.reasoning_content = record.reasoning;
        if (record.tools.size) {
          message.tool_calls = [...record.tools.values()]
            .sort((a, b) => a.index - b.index)
            .map((tool) => ({
              id: tool.id,
              type: tool.type,
              function: { name: tool.name, arguments: tool.arguments },
            }));
        }
        return { index: record.index, message, finish_reason: record.finish_reason };
      }),
    };
    return validateCompletion(completion, requestId);
  }

  return Object.freeze({ push, result });
}

function callbackStreamHandle({ runtime, request, signal, onSettled }) {
  const linked = linkAbortSignal(signal);
  const accumulator = createCompletionAccumulator(request.model ?? null, request.id);
  const chunks = [];
  const waiters = [];
  let ended = false;
  let terminalError = null;

  function deliver(value) {
    // This gate prevents delivery after public cancellation. It is not proof
    // that the underlying request stopped; the runtime records that separately.
    if (ended || linked.controller.signal.aborted) return;
    const chunk = request.id === undefined ? value : { ...value, id: request.id };
    accumulator.push(chunk);
    const waiter = waiters.shift();
    if (waiter) waiter.resolve({ value: chunk, done: false });
    else chunks.push(chunk);
  }

  function finish(error = null) {
    ended = true;
    terminalError = error;
    if (error) chunks.length = 0;
    while (waiters.length) {
      const waiter = waiters.shift();
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  const terminal = runtime.stream(
    completionOptions(request, linked.controller.signal, true),
    deliver,
  );
  const result = (async () => {
    try {
      await terminal;
      throwIfAborted(linked.controller.signal);
      const value = accumulator.result();
      finish();
      return value;
    } catch (error) {
      const normalized = normalizeArcaneAIError(error, {
        kind: "llm",
        operation: "request",
        signal: normalizationSignal(error, linked.controller.signal),
      });
      finish(normalized);
      throw normalized;
    }
  })().finally(() => {
    linked.release();
    onSettled(terminalError);
  });
  result.catch(() => undefined);

  let cancelPromise = null;
  const handle = {
    result,
    async cancel(reason = "The browser-WASM request was cancelled.") {
      if (ended) return false;
      cancelPromise ||= (async () => {
        linked.controller.abort(reason);
        try {
          await terminal;
        } catch {
          // The stable public error is available from result.
        }
        try {
          await result;
        } catch {
          // Cancellation is expected to reject the terminal result.
        }
        return true;
      })();
      return cancelPromise;
    },
    async next() {
      if (terminalError) throw terminalError;
      throwIfAborted(linked.controller.signal);
      if (chunks.length) return { value: chunks.shift(), done: false };
      if (ended) return { value: undefined, done: true };
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    async return(value) {
      await this.cancel("The stream consumer stopped before completion.");
      return { value, done: true };
    },
    async throw(error) {
      await this.cancel(error);
      throw normalizeArcaneAIError(error, { kind: "llm", operation: "request" });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return Object.freeze(handle);
}

export function createBrowserWasmLlmProvider({
  source,
  store,
  loadDefaults = {},
  security,
  logger = console,
} = {}) {
  if (!BROWSER_MODEL_SOURCES.has(source)) {
    throw new TypeError("createBrowserWasmLlmProvider requires createBrowserModelSource().");
  }
  if (!DBOPFS_MODEL_STORES.has(store)) {
    throw new TypeError("createBrowserWasmLlmProvider requires createDbopfsModelStore().");
  }
  const bindingSecurity = normalizeModelSecurity(security, "provider security");
  const runtimeLoadDefaults = { ...loadDefaults };
  delete runtimeLoadDefaults.security;
  delete runtimeLoadDefaults.offline;
  delete runtimeLoadDefaults.onProgress;

  const runtime = createPackagedWllamaRuntime({ logger });
  let state = "unloaded";
  let progressState = null;
  let errorState = null;
  let cacheState = "unknown";
  let activeSecurity = null;
  let activeIntegrity = null;
  let queueDepth = 0;
  let disposed = false;
  let disposing = false;
  let disposePromise = null;
  let loadPromise = null;
  let loadAbort = null;
  let unloadPromise = null;
  let lifecycleGeneration = 0;
  let activeAbort = null;
  let activeCount = 0;
  const queue = createSerialRequestQueue((depth) => { queueDepth = depth; });

  function capabilities() {
    const runtimeCapabilities = runtime.capabilities();
    return Object.freeze({
      localOnly: true,
      toolCalls: "structural-only",
      webAssembly: runtimeCapabilities.webAssembly,
      opfs: runtimeCapabilities.opfs,
      webgpu: runtimeCapabilities.webgpu,
      webgpuApiPresent: runtimeCapabilities.webgpuApiPresent,
      webgpuOperational: runtimeCapabilities.webgpuOperational,
      webgpuEvidenceProtocol: runtimeCapabilities.webgpuEvidenceProtocol,
      webgpuAdapterSelectionEvent: WEBGPU_ADAPTER_SELECTED_EVENT,
      crossOriginIsolated: runtimeCapabilities.crossOriginIsolated,
      secureContext: runtimeCapabilities.secureContext,
      hardwareConcurrency: runtimeCapabilities.hardwareConcurrency,
    });
  }

  function status(context = {}) {
    const effectiveSecurity = activeSecurity ?? resolveModelSecurity({
      app: context?.security,
      binding: bindingSecurity,
    });
    const integrity = activeIntegrity ?? integritySnapshot(effectiveSecurity, source);
    return Object.freeze({
      protocol: ARCANE_AI_ADAPTER_PROTOCOL,
      provider: "arcane-browser-wasm-wllama",
      state,
      loaded: state === "ready" && runtime.isLoaded(),
      busy: activeCount > 0,
      queued: Math.max(0, queueDepth - activeCount),
      model: publicDescriptor(source),
      cache: Object.freeze({ state: cacheState, schema: MODEL_MANIFEST_SCHEMA }),
      security: securitySnapshot(effectiveSecurity),
      integrity,
      progress: progressState,
      error: errorState,
      runtime: runtime.authority,
      runtimeEvidence: runtime.evidence(),
      capabilities: capabilities(),
      origin: globalThis.location?.origin ?? null,
    });
  }

  function reconcileRuntimeAfterRequestError(error) {
    if (runtime.isLoaded()) return;
    const runtimeState = runtime.evidence()?.state;
    state = runtimeState === "error"
      || error?.code === "ARCANE_AI_WORKER_TERMINATION_UNCONFIRMED"
      ? "error"
      : "unloaded";
    progressState = null;
    errorState = state === "error"
      ? Object.freeze({
        code: typeof error?.code === "string" ? error.code : "ARCANE_AI_RUNTIME_FAILED",
        message: typeof error?.message === "string"
          ? error.message
          : "The browser-WASM runtime failed.",
      })
      : null;
  }

  function report(value, options, context) {
    progressState = value;
    options?.onProgress?.(value);
    context?.reportProgress?.(value);
  }

  async function load(options = {}, context = {}) {
    if (disposed || disposing) {
      throw fail("ARCANE_AI_DISPOSED", "The browser-WASM provider is disposed or disposing.");
    }
    if (unloadPromise || state === "unloading") {
      throw fail(
        "ARCANE_AI_OPERATION_SUPERSEDED",
        "The browser-WASM model cannot load while unload is in progress.",
      );
    }
    const effectiveSecurity = resolveModelSecurity({
      app: context.security,
      binding: bindingSecurity,
      load: options.security,
    });
    assertDescriptorChecks(source, effectiveSecurity);
    if (state === "ready") {
      if (sameModelSecurity(activeSecurity, effectiveSecurity)) {
        activeSecurity = effectiveSecurity;
        return Object.freeze({ model: publicDescriptor(source), status: status() });
      }
      throw fail(
        "ARCANE_AI_SECURITY_RELOAD_REQUIRED",
        "Unload the browser-WASM model before changing its effective security checks.",
      );
    }
    if (loadPromise) {
      if (sameModelSecurity(activeSecurity, effectiveSecurity)) {
        activeSecurity = effectiveSecurity;
        return loadPromise;
      }
      throw fail(
        "ARCANE_AI_SECURITY_RELOAD_REQUIRED",
        "The in-flight browser-WASM load uses different effective security checks.",
      );
    }
    const externalSignal = options.signal ?? context.signal ?? null;
    const linked = linkAbortSignal(externalSignal);
    const signal = linked.controller.signal;
    const generation = ++lifecycleGeneration;
    loadAbort = linked.controller;
    activeSecurity = effectiveSecurity;
    activeIntegrity = integritySnapshot(effectiveSecurity, source);
    state = "loading";
    progressState = null;
    errorState = null;
    loadPromise = (async () => {
      try {
        throwIfAborted(signal, "load");
        const admitted = await store.ensure(source, {
          signal,
          offline: options.offline === true,
          security: effectiveSecurity,
          onProgress: (value) => report(value, options, context),
        });
        cacheState = admitted.cache;
        activeIntegrity = admitted.integrity;
        throwIfAborted(signal, "load");
        if (generation !== lifecycleGeneration || state !== "loading") {
          throw fail("ARCANE_AI_OPERATION_SUPERSEDED", "The model load was superseded by unload.");
        }
        report(
          progress(source, "initialize", admitted.observedBytes, admitted.observedBytes),
          options,
          context,
        );
        throwIfAborted(signal, "load");
        if (generation !== lifecycleGeneration || state !== "loading") {
          throw fail("ARCANE_AI_OPERATION_SUPERSEDED", "The model load was superseded by unload.");
        }
        const modelFile = typeof globalThis.File === "function"
          ? new File([admitted.file], source.name, { type: "application/octet-stream" })
          : admitted.file;
        const runtimeOptions = { ...options };
        delete runtimeOptions.security;
        delete runtimeOptions.offline;
        delete runtimeOptions.onProgress;
        await runtime.load([modelFile], {
          ...runtimeLoadDefaults,
          ...runtimeOptions,
          signal,
        });
        if (!runtime.isLoaded()) {
          throw fail(
            "ARCANE_AI_LOAD_FAILED",
            "Wllama did not confirm that the model loaded successfully.",
          );
        }
        emitWebgpuAdapterSelection(source, runtime);
        throwIfAborted(signal, "load");
        if (generation !== lifecycleGeneration || state !== "loading") {
          await runtime.exit();
          throw fail("ARCANE_AI_OPERATION_SUPERSEDED", "The model load was superseded by unload.");
        }
        state = "ready";
        progressState = null;
        return Object.freeze({ model: publicDescriptor(source), status: status() });
      } catch (error) {
        let cleanupFailure = null;
        try {
          await runtime.exit();
        } catch (cleanupError) {
          cleanupFailure = cleanupError;
        }
        const surfaced = cleanupFailure ?? error;
        const normalized = normalizeArcaneAIError(surfaced, {
          kind: "llm",
          operation: "load",
          signal: normalizationSignal(surfaced, signal),
        });
        if (generation === lifecycleGeneration && state === "loading") {
          state = "error";
          errorState = Object.freeze({ code: normalized.code, message: normalized.message });
        }
        throw normalized;
      } finally {
        if (loadAbort === linked.controller) loadAbort = null;
        linked.release();
        loadPromise = null;
      }
    })();
    return loadPromise;
  }

  function assertReady() {
    if (disposed || disposing) {
      throw fail("ARCANE_AI_DISPOSED", "The browser-WASM provider is disposed or disposing.");
    }
    if (state !== "ready" || !runtime.isLoaded()) {
      throw fail("ARCANE_AI_NOT_READY", "The browser-WASM model must be loaded before use.");
    }
  }

  async function chat(request = {}, context = {}) {
    const externalSignal = request.signal ?? context.signal ?? null;
    return queue.schedule(async () => {
      throwIfAborted(externalSignal);
      assertReady();
      const linked = linkAbortSignal(externalSignal);
      activeAbort = linked.controller;
      activeCount += 1;
      try {
        const completion = await runtime.chat(
          completionOptions(request, linked.controller.signal, false),
        );
        throwIfAborted(linked.controller.signal);
        return validateCompletion(completion, request.id);
      } catch (error) {
        const normalized = normalizeArcaneAIError(error, {
          kind: "llm",
          operation: "request",
          signal: normalizationSignal(error, linked.controller.signal),
        });
        reconcileRuntimeAfterRequestError(normalized);
        throw normalized;
      } finally {
        activeCount -= 1;
        activeAbort = null;
        linked.release();
      }
    }, externalSignal);
  }

  function stream(request = {}, context = {}) {
    const externalSignal = request.signal ?? context.signal ?? null;
    return queue.openStream(async () => {
      throwIfAborted(externalSignal);
      assertReady();
      activeCount += 1;
      let settled = false;
      const handle = callbackStreamHandle({
        runtime,
        request,
        signal: externalSignal,
        onSettled(error) {
          if (settled) return;
          settled = true;
          activeCount -= 1;
          activeAbort = null;
          if (error) reconcileRuntimeAfterRequestError(error);
        },
      });
      activeAbort = Object.freeze({
        abort: (reason) => handle.cancel(reason),
      });
      return handle;
    }, externalSignal);
  }

  async function unload(options = {}, context = {}) {
    if (unloadPromise) return unloadPromise;
    if (state === "unloaded" && !runtime.isLoaded()) return status();
    const signal = options.signal ?? context.signal ?? null;
    lifecycleGeneration += 1;
    state = "unloading";
    unloadPromise = (async () => {
      try {
        let activeCancellation;
        try {
          activeCancellation = Promise.resolve(
            activeAbort?.abort?.("The browser-WASM model is unloading."),
          );
        } catch (error) {
          activeCancellation = Promise.reject(error);
        }
        activeCancellation.catch(() => undefined);
        loadAbort?.abort("The browser-WASM model is unloading.");
        // Abort the public request signal before runtime.exit() force-rejects
        // the pinned Wllama task gate and terminates its Worker.
        await runtime.exit();
        await activeCancellation.catch(() => undefined);
        await loadPromise?.catch(() => undefined);
        await queue.idle();
        throwIfAborted(signal, "unload");
        await runtime.exit();
        state = "unloaded";
        progressState = null;
        errorState = null;
        activeSecurity = null;
        activeIntegrity = null;
        return status();
      } catch (error) {
        const normalized = normalizeArcaneAIError(error, {
          kind: "llm",
          operation: "unload",
          signal: normalizationSignal(error, signal),
        });
        state = "error";
        errorState = Object.freeze({ code: normalized.code, message: normalized.message });
        throw normalized;
      } finally {
        unloadPromise = null;
      }
    })();
    return unloadPromise;
  }

  async function dispose(options = {}, context = {}) {
    if (disposed) return status();
    if (disposePromise) return disposePromise;
    disposing = true;
    disposePromise = (async () => {
      try {
        await unload(options, context);
        disposed = true;
        return status();
      } finally {
        disposing = false;
        disposePromise = null;
      }
    })();
    return disposePromise;
  }

  async function probe(options = {}) {
    if (disposed || disposing) {
      throw fail("ARCANE_AI_DISPOSED", "The browser-WASM provider is disposed or disposing.");
    }
    if (state !== "unloaded" || runtime.isLoaded()) {
      throw fail("ARCANE_AI_NOT_READY", "Unload the model before running the no-model WASM probe.");
    }
    return runtime.probe(options);
  }

  return Object.freeze({
    protocol: ARCANE_AI_ADAPTER_PROTOCOL,
    id: "arcane-browser-wasm-wllama",
    model: publicDescriptor(source),
    capabilities,
    status,
    load,
    unload,
    chat,
    stream,
    streamChat: stream,
    use: chat,
    probe,
    dispose,
  });
}

function assertV1LlmAdapterSelection(selection, providerId, modelId, role) {
  if (role !== "llm") {
    throw fail("ARCANE_AI_PROVIDER_ROLE_MISMATCH", "The browser-WASM adapter serves only the LLM role.");
  }
  if (
    !selection
    || typeof selection !== "object"
    || Array.isArray(selection)
    || selection.providerId !== providerId
    || selection.modelId !== modelId
    || selection.localOnly !== true
  ) {
    throw fail(
      "ARCANE_AI_MODEL_AUTHORITY_REQUIRED",
      "The browser-WASM adapter requires its exact local-only provider and model selection.",
    );
  }
}

function provider2ByteProgress(value) {
  const phase = typeof value?.phase === "string" ? value.phase.trim() : "";
  const completed = Number(value?.loaded);
  const total = value?.total === null ? null : Number(value?.total);
  if (
    !phase
    || !Number.isSafeInteger(completed)
    || completed < 0
    || (total !== null && (!Number.isSafeInteger(total) || total < 0))
    || (total !== null && completed > total)
  ) {
    throw fail("ARCANE_AI_PROVIDER_PROGRESS_INVALID", "The browser-WASM provider returned invalid byte progress.");
  }
  return Object.freeze({ phase, completed, total, unit: "bytes", heartbeat: false });
}

/**
 * Projects the existing browser-WASM LLM provider into the provider-neutral
 * Arcane AI /2 lifecycle without changing the provider's public v1 contract.
 * The adapter is local-only, never falls back, and never executes tool calls.
 */
export function adaptV1LlmProvider(provider) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    throw new TypeError("adaptV1LlmProvider requires an Arcane browser-WASM LLM provider.");
  }
  const existing = V1_LLM_PROVIDER_ADAPTERS.get(provider);
  if (existing) return existing;
  if (provider.protocol !== ARCANE_AI_ADAPTER_PROTOCOL) {
    throw new TypeError(`The browser-WASM LLM provider protocol must equal ${ARCANE_AI_ADAPTER_PROTOCOL}.`);
  }

  const providerId = requiredText(provider.id, "provider id");
  const model = modelDescriptor(provider.model);
  const requiredMethods = ["capabilities", "status", "load", "unload", "chat", "stream", "dispose"];
  const methods = Object.create(null);
  for (const method of requiredMethods) {
    if (typeof provider[method] !== "function") {
      throw new TypeError(`The browser-WASM LLM provider is missing ${method}().`);
    }
    methods[method] = provider[method].bind(provider);
  }
  if (methods.capabilities()?.localOnly !== true) {
    throw new TypeError("The browser-WASM LLM provider must be explicitly local-only.");
  }

  const authority = Object.freeze({
    protocol: AI_MODEL_AUTHORITY_PROTOCOL,
    providerId,
    modelId: model.id,
    admitted: true,
    localOnly: true,
    model,
  });
  const catalog = Object.freeze([model]);
  let disposed = false;

  function assertSelection(selection, role) {
    assertV1LlmAdapterSelection(selection, providerId, model.id, role);
  }

  function status() {
    const value = methods.status();
    if (
      !value
      || typeof value !== "object"
      || typeof value.state !== "string"
      || typeof value.loaded !== "boolean"
      || typeof value.busy !== "boolean"
    ) {
      throw fail("ARCANE_AI_PROVIDER_STATUS_INVALID", "The browser-WASM provider returned an invalid status.");
    }
    return Object.freeze({
      state: disposed ? "disposed" : value.state,
      loaded: disposed ? false : value.loaded,
      busy: disposed ? false : value.busy,
      cache: value.cache,
      security: value.security,
      integrity: value.integrity,
    });
  }

  const adapted = Object.freeze({
    protocol: AI_PROVIDER_PROTOCOL,
    role: "llm",
    id: providerId,
    localOnly: true,
    catalog: () => catalog,
    async inspect(selection, { role = "llm", signal = null } = {}) {
      assertSelection(selection, role);
      throwIfAborted(signal, "inspect");
      if (disposed) {
        return Object.freeze({
          available: false,
          code: "ARCANE_AI_DISPOSED",
          message: "The browser-WASM provider is disposed.",
        });
      }
      const capabilities = methods.capabilities();
      const requirements = [
        [capabilities?.webAssembly === true, "WebAssembly"],
        [capabilities?.opfs === true, "OPFS"],
        [capabilities?.secureContext === true, "a secure context"],
        [capabilities?.webgpuApiPresent === true, "the WebGPU API"],
      ];
      const missing = requirements.find(([available]) => !available)?.[1] ?? null;
      if (missing) {
        return Object.freeze({
          available: false,
          code: "ARCANE_AI_PROVIDER_UNAVAILABLE",
          message: `The browser-WASM provider requires ${missing}.`,
        });
      }
      return Object.freeze({ available: true, authority });
    },
    status,
    async load({
      role = "llm",
      selection,
      signal = null,
      progress = null,
      security,
    } = {}) {
      assertSelection(selection, role);
      throwIfAborted(signal, "load");
      if (progress !== null && typeof progress !== "function") {
        throw new TypeError("The provider/2 progress sink must be a function or null.");
      }
      await methods.load({
        signal,
        security,
        ...(progress ? { onProgress: (value) => progress(provider2ByteProgress(value)) } : {}),
      });
      return status();
    },
    request({ role = "llm", selection, operation, payload, signal = null } = {}) {
      assertSelection(selection, role);
      throwIfAborted(signal);
      if (operation === "chat") return methods.chat(payload, { signal });
      if (operation === "stream") return methods.stream(payload, { signal });
      throw fail("ARCANE_AI_PROVIDER_OPERATION_UNAVAILABLE", "The browser-WASM adapter supports only chat and stream.");
    },
    async unload({ role = "llm", selection, signal = null } = {}) {
      assertSelection(selection, role);
      throwIfAborted(signal, "unload");
      await methods.unload({ signal });
      return status();
    },
    async dispose({ role = "llm", selection, signal = null } = {}) {
      assertSelection(selection, role);
      throwIfAborted(signal, "dispose");
      await methods.dispose({ signal });
      disposed = true;
      return status();
    },
  });
  V1_LLM_PROVIDER_ADAPTERS.set(provider, adapted);
  return adapted;
}

export { MODEL_MANIFEST_SCHEMA };

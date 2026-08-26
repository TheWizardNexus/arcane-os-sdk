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

const MODEL_MANIFEST_SCHEMA = "arcane.ai.browser-wasm.model.v4";
const SINGLE_MODEL_MANIFEST_SCHEMA = "arcane.ai.browser-wasm.model.v3";
const LEGACY_MODEL_MANIFEST_SCHEMA = "arcane.ai.browser-wasm.model.v2";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MUTABLE_PATH_PATTERN = /\/(?:resolve\/)?(?:main|master|latest)(?:\/|$)/iu;
const BROWSER_MODEL_SOURCES = new WeakSet();
const BROWSER_MODEL_SOURCE_METADATA = new WeakMap();
const MODEL_DESCRIPTOR_METADATA = new WeakMap();
const DBOPFS_MODEL_STORES = new WeakSet();
const V1_LLM_PROVIDER_ADAPTERS = new WeakMap();
const AI_PROVIDER_PROTOCOL = "arcane-ai-provider/2";
const AI_MODEL_AUTHORITY_PROTOCOL = "arcane-ai-model-authority/1";
const WEBGPU_ADAPTER_SELECTED_EVENT = "arcane.ai.browser-wasm.webgpu.adapter.selected";
const WEBGPU_ADAPTER_SELECTION_PROTOCOL = "arcane-ai-webgpu-adapter-selection/1";
const CHROME_HIGH_PERFORMANCE_GPU_FLAG_URL =
  "chrome://flags/#force-high-performance-gpu";
const INTEL_VENDOR_ID = 0x8086;
const CAPABILITY_POLICY_PROTOCOL = "arcane-ai-browser-capability-policy/1";
const WLLAMA_MAX_FILE_BYTES = 2_000_000_000;
let highPerformanceGpuNoticeShown = false;

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

function modelIdText(value) {
  const id = requiredText(value, "id");
  for (let index = 0; index < id.length; index += 1) {
    const code = id.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = id.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("Browser model id must contain only Unicode scalar values.");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("Browser model id must contain only Unicode scalar values.");
    }
  }
  if (id.normalize("NFC") !== id) {
    throw new TypeError("Browser model id must use Unicode NFC normalization.");
  }
  return id;
}

function descriptorFileName(value, url, fallbackName = null) {
  const suppliedName = value.name;
  let name = suppliedName;
  if (name === undefined) {
    const encoded = url.pathname.split("/").filter(Boolean).pop() ?? "";
    try {
      name = decodeURIComponent(encoded);
    } catch {
      name = "";
    }
    if (!name && fallbackName) name = fallbackName;
  }
  name = requiredText(name, "file name");
  if (
    (suppliedName !== undefined && suppliedName !== name)
    || name !== name.split(/[\\/]/u).pop()
    || name === "."
    || name === ".."
    || name.endsWith(".")
    || name.endsWith(" ")
    || /[<>:"|?*]/u.test(name)
    || /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    throw new TypeError("Browser model file names must be safe single filenames.");
  }
  return name;
}

function descriptorFile(value, { fallbackName = null } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Each browser model file descriptor must be an object.");
  }
  if (
    value.url !== undefined
    && value.immutableUrl !== undefined
    && value.url !== value.immutableUrl
  ) {
    throw new TypeError("Browser model file url and legacy immutableUrl must match when both are provided.");
  }
  const url = immutableHttpsUrl(value.url ?? value.immutableUrl);
  if (!url) {
    throw new TypeError("Browser model file url must be immutable HTTPS without credentials or fragments.");
  }
  const file = {
    name: descriptorFileName(value, url, fallbackName),
    url: url.href,
  };
  if (value.bytes !== undefined) {
    if (!Number.isSafeInteger(value.bytes) || value.bytes < 1) {
      throw new TypeError("Browser model file bytes must be a positive safe integer when provided.");
    }
    file.bytes = value.bytes;
  }
  if (value.sha256 !== undefined) {
    const sha256 = requiredText(value.sha256, "file sha256").toLowerCase();
    if (!SHA256_PATTERN.test(sha256)) {
      throw new TypeError("Browser model file sha256 must be exactly 64 hexadecimal characters when provided.");
    }
    file.sha256 = sha256;
  }
  return Object.freeze(file);
}

function modelDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("A browser model descriptor is required.");
  }
  const id = modelIdText(value.id);
  const hasFiles = value.files !== undefined;
  const hasLegacyFile = ["url", "immutableUrl", "name", "bytes", "sha256"]
    .some((field) => value[field] !== undefined);
  if (hasFiles && hasLegacyFile) {
    throw new TypeError("Browser model files[] is mutually exclusive with legacy one-file fields.");
  }
  let files;
  let legacy = false;
  if (hasFiles) {
    if (!Array.isArray(value.files) || value.files.length === 0) {
      throw new TypeError("Browser model files must be a nonempty ordered array.");
    }
    files = value.files.map((file) => descriptorFile(file));
  } else {
    legacy = true;
    const safeId = id.replace(/[^a-z0-9._-]+/giu, "_");
    files = [descriptorFile(value, { fallbackName: `${safeId}.gguf` })];
  }
  const names = new Set();
  const urls = new Set();
  for (const file of files) {
    const nameKey = file.name.toLowerCase();
    if (names.has(nameKey)) {
      throw new TypeError("Browser model file names must be unique.");
    }
    if (urls.has(file.url)) {
      throw new TypeError("Browser model file URLs must be unique.");
    }
    names.add(nameKey);
    urls.add(file.url);
  }
  files = Object.freeze(files);
  let descriptor;
  if (legacy) {
    const [file] = files;
    descriptor = { id, url: file.url };
    if (file.bytes !== undefined) descriptor.bytes = file.bytes;
    if (file.sha256 !== undefined) descriptor.sha256 = file.sha256;
  } else {
    descriptor = { id, files };
  }
  descriptor = Object.freeze(descriptor);
  MODEL_DESCRIPTOR_METADATA.set(descriptor, Object.freeze({ files, legacy }));
  return descriptor;
}

function publicDescriptor(source) {
  if (source?.descriptor && MODEL_DESCRIPTOR_METADATA.has(source.descriptor)) {
    return source.descriptor;
  }
  if (MODEL_DESCRIPTOR_METADATA.has(source)) return source;
  return modelDescriptor(source);
}

function isChromeBrowser() {
  const userAgent = String(globalThis.navigator?.userAgent ?? "");
  return /\b(?:Chrome|Chromium)\//u.test(userAgent)
    && !/\b(?:Edg|OPR)\//u.test(userAgent);
}

function isLowerPowerIntelAdapter(adapter) {
  const identity = [
    adapter.vendor,
    adapter.architecture,
    adapter.name,
    adapter.description,
  ].filter(Boolean).join(" ");
  if (adapter?.vendorId !== INTEL_VENDOR_ID && !/\bintel\b/iu.test(identity)) return false;
  return /(?:intel|integrated|xe-lp)/iu.test(identity);
}

function notifyChromeHighPerformanceGpu(adapter) {
  if (
    highPerformanceGpuNoticeShown
    || !isChromeBrowser()
    || !isLowerPowerIntelAdapter(adapter)
  ) return;
  highPerformanceGpuNoticeShown = true;
  try {
    globalThis.open?.(CHROME_HIGH_PERFORMANCE_GPU_FLAG_URL, "_blank", "noopener,noreferrer");
  } catch {
    // Chrome may reject internal-page navigation from web content.
  }
  const adapterName = adapter.description || adapter.name
    || [adapter.vendor, adapter.architecture].filter(Boolean).join(" ")
    || "a lower-power Intel adapter";
  globalThis.alert?.(
    `Arcane selected the lower-power WebGPU adapter: ${adapterName}.\n\n`
    + "Enable “Force High Performance GPU” in the Chrome flags window. "
    + "Then completely close every Chrome window and reopen Chrome before loading the model again.\n\n"
    + `If the flags window did not open, paste ${CHROME_HIGH_PERFORMANCE_GPU_FLAG_URL} into Chrome.`,
  );
}

function emitWebgpuAdapterSelection(source, runtime) {
  const evidence = runtime.evidence();
  const webgpu = evidence?.webgpu;
  if (webgpu?.observed !== true || !webgpu.adapter) return;
  try {
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
  } finally {
    notifyChromeHighPerformanceGpu(webgpu.adapter);
  }
}

function sourceMetadata(source) {
  return BROWSER_MODEL_SOURCE_METADATA.get(source)
    ?? MODEL_DESCRIPTOR_METADATA.get(publicDescriptor(source));
}

function manifestModelIdentity(source) {
  return Object.freeze({
    id: source.id,
    files: Object.freeze(sourceMetadata(source).files.map((file) => Object.freeze({
      name: file.name,
      url: file.url,
    }))),
  });
}

/**
 * Creates a browser download authority for one caller-supplied immutable
 * model file set. Legacy one-file descriptors normalize to one ordered member.
 * Effective load security decides which expected-byte checks run.
 */
export function createBrowserModelSource(descriptor, {
  fetchImpl = null,
} = {}) {
  const model = modelDescriptor(descriptor);
  const metadata = MODEL_DESCRIPTOR_METADATA.get(model);

  async function open(memberOrOptions = 0, options = {}) {
    let memberIndex = memberOrOptions;
    if (!Number.isSafeInteger(memberOrOptions)) {
      if (metadata.files.length !== 1) {
        throw new TypeError("A browser model file index is required for a multi-file source.");
      }
      memberIndex = 0;
      options = memberOrOptions ?? {};
    }
    if (memberIndex < 0 || memberIndex >= metadata.files.length) {
      throw new RangeError("Browser model file index is out of range.");
    }
    const member = metadata.files[memberIndex];
    const { signal } = options;
    throwIfAborted(signal, "install");
    const fetchFunction = fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchFunction !== "function") {
      throw fail("ARCANE_AI_MODEL_SOURCE_UNAVAILABLE", "Browser fetch is unavailable.");
    }

    let response;
    try {
      response = await fetchFunction(member.url, {
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
      finalUrl = new URL(response.url || member.url);
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
      requestedUrl: member.url,
      finalUrl: finalUrl.href,
      reportedBytes: Number.isSafeInteger(reported) && reported >= 0 ? reported : null,
      cancel: (reason) => response.body.cancel(reason),
    });
  }

  const sourceRecord = {
    kind: "arcane-browser-model-source",
    ...model,
    descriptor: model,
    open,
  };
  if (metadata.legacy) {
    Object.defineProperties(sourceRecord, {
      name: { value: metadata.files[0].name, enumerable: false },
      immutableUrl: { value: metadata.files[0].url, enumerable: false },
    });
  }
  const source = Object.freeze(sourceRecord);
  BROWSER_MODEL_SOURCES.add(source);
  BROWSER_MODEL_SOURCE_METADATA.set(source, metadata);
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

function injectiveStorageId(id) {
  return Array.from(
    new TextEncoder().encode(id),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}

function storageName(source, { legacy = false } = {}) {
  const safeId = legacy
    ? source.id.replace(/[^a-z0-9._-]+/giu, "_")
    : `id-${injectiveStorageId(source.id)}`;
  const models = sourceMetadata(source).files.map((file) => Object.freeze({
    file,
    name: `${safeId}--${file.name}`,
  }));
  return Object.freeze({
    models: Object.freeze(models),
    model: models[0].name,
    manifest: `${safeId}.complete.json`,
  });
}

function manifestFor(source, files) {
  const observedBytes = files.reduce((total, file) => total + file.observedBytes, 0);
  return Object.freeze({
    schema: MODEL_MANIFEST_SCHEMA,
    complete: true,
    model: manifestModelIdentity(source),
    files: Object.freeze(files.map((file) => Object.freeze({
      name: file.name,
      finalUrl: file.finalUrl,
      observedBytes: file.observedBytes,
    }))),
    observedBytes,
    completedAt: new Date().toISOString(),
  });
}

function manifestByteLength(manifest) {
  return new TextEncoder().encode(`${JSON.stringify(manifest)}\n`).byteLength;
}

function projectedManifestByteLength(source) {
  return manifestByteLength(manifestFor(
    source,
    sourceMetadata(source).files.map((file) => ({
      name: file.name,
      finalUrl: file.url,
      observedBytes: file.bytes,
    })),
  ));
}

function manifestKind(manifest, source) {
  const model = manifest?.model;
  const members = sourceMetadata(source).files;
  if (
    manifest?.schema === MODEL_MANIFEST_SCHEMA
    && manifest?.complete === true
    && model?.id === source.id
    && Array.isArray(model?.files)
    && model.files.length === members.length
    && model.files.every((file, index) => (
      file?.name === members[index].name
      && file?.url === members[index].url
    ))
    && Array.isArray(manifest.files)
    && manifest.files.length === members.length
    && manifest.files.every((file, index) => (
      file?.name === members[index].name
      && Number.isSafeInteger(file?.observedBytes)
      && file.observedBytes >= 0
      && immutableHttpsUrl(file?.finalUrl)
    ))
    && Number.isSafeInteger(manifest.observedBytes)
    && manifest.observedBytes >= 0
    && manifest.files.reduce((total, file) => total + file.observedBytes, 0)
      === manifest.observedBytes
  ) return "set";
  if (!sourceMetadata(source).legacy || members.length !== 1) return null;
  const [member] = members;
  if (
    manifest?.schema === SINGLE_MODEL_MANIFEST_SCHEMA
    && manifest?.complete === true
    && model?.id === source.id
    && model?.url === member.url
    && Number.isSafeInteger(manifest.observedBytes)
    && manifest.observedBytes >= 0
  ) return "single";
  if (
    manifest?.schema === LEGACY_MODEL_MANIFEST_SCHEMA
    && manifest?.complete === true
    && model?.id === source.id
    && model?.name === member.name
    && model?.immutableUrl === member.url
  ) return "legacy";
  return null;
}

function progress(source, phase, loaded, total = null, memberIndex = 0, memberLoaded = loaded) {
  const members = sourceMetadata(source).files;
  const member = members[memberIndex] ?? members[0];
  return Object.freeze({
    modelId: source.id,
    phase,
    loaded,
    total,
    percent: Number.isSafeInteger(total) && total > 0 ? (loaded / total) * 100 : null,
    file: Object.freeze({
      index: memberIndex,
      count: members.length,
      name: member.name,
      loaded: memberLoaded,
      total: member.bytes ?? null,
    }),
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
  const files = sourceMetadata(source).files;
  if (security.checks.byteLength && files.some((file) => file.bytes === undefined)) {
    throw fail(
      "ARCANE_AI_MODEL_SOURCE_INVALID",
      "Browser model bytes is required for every file when the byteLength check is enabled.",
    );
  }
  if (security.checks.sha256 && files.some((file) => file.sha256 === undefined)) {
    throw fail(
      "ARCANE_AI_MODEL_SOURCE_INVALID",
      "Browser model sha256 is required for every file when the sha256 check is enabled.",
    );
  }
}

function knownModelBytes(source) {
  const files = sourceMetadata(source).files;
  if (files.some((file) => file.bytes === undefined)) return null;
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  return Number.isSafeInteger(total) ? total : null;
}

function oversizedModelFile(source) {
  return sourceMetadata(source).files.find(
    (file) => file.bytes !== undefined && file.bytes > WLLAMA_MAX_FILE_BYTES,
  ) ?? null;
}

function integritySnapshot(security, source, {
  observedBytes = null,
  byteLength = security.checks.byteLength ? "pending" : "unchecked",
  sha256 = security.checks.sha256 ? "pending" : "unchecked",
  actualSha256 = null,
  files = null,
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
  const members = sourceMetadata(source).files;
  const fileStates = members.map((member, index) => {
    const evidence = files?.[index] ?? {};
    return Object.freeze({
      name: member.name,
      observedBytes: evidence.observedBytes ?? null,
      byteLength: Object.freeze({
        enabled: security.checks.byteLength,
        state: evidence.byteLength ?? byteLength,
        expected: member.bytes ?? null,
        observed: evidence.observedBytes ?? null,
      }),
      sha256: Object.freeze({
        enabled: security.checks.sha256,
        state: evidence.sha256 ?? sha256,
        expected: member.sha256 ?? null,
        actual: evidence.actualSha256 ?? (members.length === 1 ? actualSha256 : null),
      }),
    });
  });
  return Object.freeze({
    state,
    observedBytes,
    byteLength: Object.freeze({
      enabled: security.checks.byteLength,
      state: byteLength,
      expected: knownModelBytes(source),
      observed: observedBytes,
    }),
    sha256: Object.freeze({
      enabled: security.checks.sha256,
      state: sha256,
      expected: members.length === 1 ? members[0].sha256 ?? null : null,
      actual: members.length === 1 ? actualSha256 : null,
    }),
    files: Object.freeze(fileStates),
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
  estimateStorage = null,
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
  if (estimateStorage !== null && typeof estimateStorage !== "function") {
    throw new TypeError("estimateStorage must be a function or null.");
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

  async function readManifest(name, { removeInvalid = true } = {}) {
    const manifestFile = await file(name);
    if (!manifestFile) return null;
    try {
      return JSON.parse(await manifestFile.text());
    } catch {
      if (removeInvalid) await removeEntry(name);
      return null;
    }
  }

  async function removeNames(names) {
    const removed = [await removeEntry(names.manifest)];
    for (const entry of names.models) removed.push(await removeEntry(entry.name));
    return removed.some(Boolean);
  }

  async function remove(source) {
    let removed = await removeNames(storageName(source));
    if (sourceMetadata(source).legacy) {
      const legacyNames = storageName(source, { legacy: true });
      const legacyManifest = await readManifest(legacyNames.manifest, { removeInvalid: false });
      if (manifestKind(legacyManifest, source)) {
        removed = await removeNames(legacyNames) || removed;
      }
    }
    return removed;
  }

  async function writeManifest(name, manifest, signal) {
    const encoded = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
    await write(name, encoded, { signal });
  }

  async function verifySha256(source, memberIndex, modelFile, {
    signal,
    onProgress,
    phase,
    completedBytes = 0,
    totalBytes = null,
  }) {
    const digest = createStreamingSha256();
    let hashed = 0;
    for await (const chunk of byteChunks(modelFile, signal)) {
      digest.update(chunk);
      hashed += chunk.byteLength;
      onProgress?.(progress(
        source,
        phase,
        completedBytes + hashed,
        totalBytes,
        memberIndex,
        hashed,
      ));
    }
    return Object.freeze({ hashed, sha256: digest.digestHex() });
  }

  async function storagePolicy(source, { cached = null, security } = {}) {
    if (cached) {
      const payloadBytes = cached.observedBytes;
      const manifestBytes = manifestByteLength(cached.manifest);
      const requiredBytes = payloadBytes + manifestBytes;
      return Object.freeze({
        compatibility: "compatible",
        code: "ARCANE_AI_MODEL_CACHE_COMPLETE",
        requiredBytes,
        payloadBytes,
        manifestBytes,
        quotaBytes: null,
        usageBytes: null,
        availableBytes: null,
        measured: false,
        admitted: true,
      });
    }
    if (security?.checks?.byteLength !== true) {
      return Object.freeze({
        compatibility: "unknown",
        code: "ARCANE_AI_MODEL_STORAGE_REQUIREMENT_UNBOUNDED",
        requiredBytes: null,
        payloadBytes: null,
        manifestBytes: null,
        quotaBytes: null,
        usageBytes: null,
        availableBytes: null,
        measured: false,
        admitted: false,
      });
    }
    const payloadBytes = knownModelBytes(source);
    const manifestBytes = payloadBytes === null ? null : projectedManifestByteLength(source);
    const requiredBytes = payloadBytes === null || !Number.isSafeInteger(payloadBytes + manifestBytes)
      ? null
      : payloadBytes + manifestBytes;
    if (requiredBytes === null) {
      return Object.freeze({
        compatibility: "unknown",
        code: "ARCANE_AI_MODEL_STORAGE_REQUIREMENT_UNKNOWN",
        requiredBytes: null,
        payloadBytes,
        manifestBytes,
        quotaBytes: null,
        usageBytes: null,
        availableBytes: null,
        measured: false,
        admitted: false,
      });
    }
    const estimator = estimateStorage
      ?? globalThis.navigator?.storage?.estimate?.bind(globalThis.navigator.storage);
    if (typeof estimator !== "function") {
      return Object.freeze({
        compatibility: "unknown",
        code: "ARCANE_AI_STORAGE_ESTIMATE_UNAVAILABLE",
        requiredBytes,
        payloadBytes,
        manifestBytes,
        quotaBytes: null,
        usageBytes: null,
        availableBytes: null,
        measured: false,
        admitted: false,
      });
    }
    let estimate;
    try {
      estimate = await estimator();
    } catch {
      return Object.freeze({
        compatibility: "unknown",
        code: "ARCANE_AI_STORAGE_ESTIMATE_FAILED",
        requiredBytes,
        payloadBytes,
        manifestBytes,
        quotaBytes: null,
        usageBytes: null,
        availableBytes: null,
        measured: true,
        admitted: false,
      });
    }
    const quotaBytes = Number.isSafeInteger(estimate?.quota) && estimate.quota >= 0
      ? estimate.quota
      : null;
    const usageBytes = Number.isSafeInteger(estimate?.usage) && estimate.usage >= 0
      ? estimate.usage
      : null;
    const availableBytes = quotaBytes !== null && usageBytes !== null && quotaBytes >= usageBytes
      ? quotaBytes - usageBytes
      : null;
    const incompatible = availableBytes !== null && requiredBytes > availableBytes;
    return Object.freeze({
      compatibility: incompatible ? "incompatible" : availableBytes === null ? "unknown" : "compatible",
      code: incompatible
        ? "ARCANE_AI_STORAGE_CAPACITY_INSUFFICIENT"
        : availableBytes === null
          ? "ARCANE_AI_STORAGE_ESTIMATE_INVALID"
          : "ARCANE_AI_STORAGE_CAPACITY_AVAILABLE",
      requiredBytes,
      payloadBytes,
      manifestBytes,
      quotaBytes,
      usageBytes,
      availableBytes,
      measured: true,
      admitted: false,
    });
  }

  async function openCached(source, {
    signal,
    onProgress,
    security = resolveModelSecurity(),
  } = {}) {
    assertDescriptorChecks(source, security);
    let names = storageName(source);
    let manifest = await readManifest(names.manifest);
    let kind = manifestKind(manifest, source);
    if (!kind && sourceMetadata(source).legacy) {
      const legacyNames = storageName(source, { legacy: true });
      const legacyManifest = await readManifest(legacyNames.manifest, { removeInvalid: false });
      const legacyKind = manifestKind(legacyManifest, source);
      if (legacyKind) {
        names = legacyNames;
        manifest = legacyManifest;
        kind = legacyKind;
      }
    }
    if (!kind) {
      // Model files without the exact ordered completion manifest are partial.
      await remove(source);
      return null;
    }
    const members = sourceMetadata(source).files;
    const modelFiles = [];
    const fileEvidence = [];
    let observedBytes = 0;
    try {
      for (let index = 0; index < names.models.length; index += 1) {
        const member = members[index];
        const modelFile = await file(names.models[index].name);
        if (!modelFile) {
          await removeNames(names);
          return null;
        }
        if (modelFile.size > WLLAMA_MAX_FILE_BYTES) {
          await removeNames(names);
          throw fail(
            "ARCANE_AI_MODEL_SHARD_TOO_LARGE",
            `Cached model file ${member.name} exceeds Wllama's ${WLLAMA_MAX_FILE_BYTES}-byte boundary.`,
          );
        }
        if (kind === "set" && manifest.files[index].observedBytes !== modelFile.size) {
          await removeNames(names);
          return null;
        }
        if (security.checks.byteLength && modelFile.size !== member.bytes) {
          await removeNames(names);
          return null;
        }
        modelFiles.push(modelFile);
        fileEvidence.push({
          observedBytes: modelFile.size,
          byteLength: security.checks.byteLength ? "verified" : "unchecked",
          sha256: security.checks.sha256 ? "pending" : "unchecked",
          actualSha256: null,
        });
        observedBytes += modelFile.size;
      }
      if ((kind === "set" || kind === "single") && manifest.observedBytes !== observedBytes) {
        await removeNames(names);
        return null;
      }
      let completedBytes = 0;
      for (let index = 0; index < modelFiles.length; index += 1) {
        const modelFile = modelFiles[index];
        if (security.checks.sha256) {
          const verification = await verifySha256(source, index, modelFile, {
            signal,
            onProgress,
            phase: "verify-cache",
            completedBytes,
            totalBytes: observedBytes,
          });
          fileEvidence[index].actualSha256 = verification.sha256;
          if (
            verification.hashed !== modelFile.size
            || verification.sha256 !== members[index].sha256
          ) {
            await removeNames(names);
            return null;
          }
          fileEvidence[index].sha256 = "verified";
        } else {
          onProgress?.(progress(
            source,
            "cache",
            completedBytes + modelFile.size,
            observedBytes,
            index,
            modelFile.size,
          ));
        }
        completedBytes += modelFile.size;
      }
      let completion = manifest;
      if (kind !== "set") {
        completion = manifestFor(source, [{
          name: members[0].name,
          finalUrl: manifest.finalUrl ?? members[0].url,
          observedBytes,
        }]);
      }
      return Object.freeze({
        files: Object.freeze(modelFiles),
        file: modelFiles.length === 1 ? modelFiles[0] : null,
        manifest: completion,
        observedBytes,
        integrity: integritySnapshot(security, source, {
          observedBytes,
          byteLength: security.checks.byteLength ? "verified" : "unchecked",
          sha256: security.checks.sha256 ? "verified" : "unchecked",
          actualSha256: fileEvidence[0]?.actualSha256 ?? null,
          files: fileEvidence,
        }),
      });
    } catch (error) {
      if (!signal?.aborted) await removeNames(names);
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
    const members = sourceMetadata(source).files;
    await remove(source);
    const modelFiles = [];
    const manifestFiles = [];
    const fileEvidence = [];
    const expectedTotal = knownModelBytes(source);
    let observedBytes = 0;
    try {
      for (let index = 0; index < members.length; index += 1) {
        const member = members[index];
        const opened = await source.open(index, { signal });
        try {
          if (opened.reportedBytes !== null && opened.reportedBytes > WLLAMA_MAX_FILE_BYTES) {
            throw fail(
              "ARCANE_AI_MODEL_SHARD_TOO_LARGE",
              `Model file ${member.name} exceeds Wllama's ${WLLAMA_MAX_FILE_BYTES}-byte boundary.`,
            );
          }
          if (
            security.checks.byteLength
            && opened.reportedBytes !== null
            && opened.reportedBytes !== member.bytes
          ) {
            throw fail(
              "ARCANE_AI_MODEL_SIZE_MISMATCH",
              "A model response Content-Length did not match its expected byte length.",
            );
          }
          const downloadDigest = security.checks.sha256 ? createStreamingSha256() : null;
          const written = await write(names.models[index].name, opened.body, {
            signal,
            async onChunk(chunk, loaded) {
              downloadDigest?.update(chunk);
              if (loaded > WLLAMA_MAX_FILE_BYTES) {
                throw fail(
                  "ARCANE_AI_MODEL_SHARD_TOO_LARGE",
                  `Model file ${member.name} exceeds Wllama's ${WLLAMA_MAX_FILE_BYTES}-byte boundary.`,
                );
              }
              if (security.checks.byteLength && loaded > member.bytes) {
                throw fail("ARCANE_AI_MODEL_SIZE_MISMATCH", "Downloaded model file exceeded its declared size.");
              }
              onProgress?.(progress(
                source,
                "download",
                observedBytes + loaded,
                expectedTotal,
                index,
                loaded,
              ));
            },
          });
          if (security.checks.byteLength && written !== member.bytes) {
            throw fail(
              "ARCANE_AI_MODEL_SIZE_MISMATCH",
              "Downloaded model file bytes did not match the caller-supplied expected byte length.",
            );
          }
          const modelFile = await file(names.models[index].name);
          if (!modelFile || modelFile.size !== written) {
            throw fail(
              "ARCANE_AI_MODEL_CACHE_REJECTED",
              "A stored model file did not preserve the observed downloaded byte count.",
            );
          }
          const evidence = {
            observedBytes: written,
            byteLength: security.checks.byteLength ? "verified" : "unchecked",
            sha256: security.checks.sha256 ? "pending" : "unchecked",
            actualSha256: null,
          };
          if (security.checks.sha256) {
            evidence.actualSha256 = downloadDigest.digestHex();
            if (evidence.actualSha256 !== member.sha256) {
              throw fail(
                "ARCANE_AI_MODEL_DIGEST_MISMATCH",
                "Downloaded model file bytes did not match the caller-supplied SHA-256 value.",
              );
            }
            evidence.sha256 = "verified";
          }
          modelFiles.push(modelFile);
          fileEvidence.push(evidence);
          manifestFiles.push({ name: member.name, finalUrl: opened.finalUrl, observedBytes: written });
          observedBytes += written;
        } catch (error) {
          await opened.cancel?.(error).catch(() => undefined);
          throw error;
        }
      }
      // Completion is the final storage mutation. No member is admitted until
      // this exact ordered set manifest exists.
      const manifest = manifestFor(source, manifestFiles);
      await writeManifest(names.manifest, manifest, signal);
      return Object.freeze({
        files: Object.freeze(modelFiles),
        file: modelFiles.length === 1 ? modelFiles[0] : null,
        manifest,
        observedBytes,
        integrity: integritySnapshot(security, source, {
          observedBytes,
          byteLength: security.checks.byteLength ? "verified" : "unchecked",
          sha256: security.checks.sha256 ? "verified" : "unchecked",
          actualSha256: fileEvidence[0]?.actualSha256 ?? null,
          files: fileEvidence,
        }),
      });
    } catch (error) {
      await remove(source).catch(() => undefined);
      throw error;
    }
  }

  async function ensure(source, {
    signal,
    onProgress,
    onCapabilityPolicy,
    offline = false,
    security: configuredSecurity,
  } = {}) {
    const security = resolveModelSecurity({ load: configuredSecurity });
    assertDescriptorChecks(source, security);
    const cached = await openCached(source, { signal, onProgress, security });
    if (cached) {
      const storage = await storagePolicy(source, { cached, security });
      onCapabilityPolicy?.(storage);
      return Object.freeze({ ...cached, cache: "cached", storage });
    }
    if (offline) {
      throw fail("ARCANE_AI_MODEL_OFFLINE_MISS", "No admitted offline model cache is available.");
    }
    const storage = await storagePolicy(source, { security });
    onCapabilityPolicy?.(storage);
    if (storage.compatibility === "incompatible") {
      throw fail(
        storage.code,
        "Available browser storage is smaller than the model file set and completion manifest.",
      );
    }
    const installed = await install(source, { signal, onProgress, security });
    const admittedStorage = await storagePolicy(source, { cached: installed, security });
    onCapabilityPolicy?.(admittedStorage);
    return Object.freeze({ ...installed, cache: "installed", storage: admittedStorage });
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

function positiveLoadInteger(value, field, fallback, maximum) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(`${field} must be a positive safe integer no greater than ${maximum}.`);
  }
  return resolved;
}

function measuredRuntimeCapabilities(runtimeCapabilities) {
  const measuredDeviceMemory = Number(globalThis.navigator?.deviceMemory);
  const deviceMemory = Number.isFinite(measuredDeviceMemory) && measuredDeviceMemory > 0
    ? measuredDeviceMemory
    : null;
  return Object.freeze({ ...runtimeCapabilities, deviceMemory });
}

function capabilityLoadPlan(runtimeCapabilities, defaults, options = {}) {
  const configured = { ...defaults, ...options };
  const hardwareConcurrency = Number.isSafeInteger(runtimeCapabilities.hardwareConcurrency)
    && runtimeCapabilities.hardwareConcurrency > 0
    ? runtimeCapabilities.hardwareConcurrency
    : 1;
  const deviceMemory = runtimeCapabilities.deviceMemory;
  const measuredContext = deviceMemory === null
    ? 4_096
    : deviceMemory <= 2
      ? 2_048
      : deviceMemory <= 4
        ? 4_096
        : 4_096;
  const defaultContext = hardwareConcurrency <= 2
    ? Math.min(2_048, measuredContext)
    : measuredContext;
  const defaultBatch = deviceMemory !== null && deviceMemory <= 2 ? 64 : 128;
  const defaultMicroBatch = deviceMemory !== null && deviceMemory <= 2 ? 32 : 64;
  const threads = positiveLoadInteger(
    configured.threads,
    "threads",
    Math.max(1, Math.min(4, hardwareConcurrency - 1 || 1)),
    64,
  );
  const contextTokens = positiveLoadInteger(
    configured.contextTokens,
    "contextTokens",
    defaultContext,
    1_048_576,
  );
  const batchTokens = positiveLoadInteger(
    configured.batchTokens,
    "batchTokens",
    Math.min(defaultBatch, contextTokens),
    contextTokens,
  );
  const microBatchTokens = positiveLoadInteger(
    configured.microBatchTokens,
    "microBatchTokens",
    Math.min(defaultMicroBatch, batchTokens),
    batchTokens,
  );
  return Object.freeze({
    threads,
    contextTokens,
    batchTokens,
    microBatchTokens,
    gpuLayers: 99_999,
  });
}

function sameLoadPlan(left, right) {
  return left?.threads === right?.threads
    && left?.contextTokens === right?.contextTokens
    && left?.batchTokens === right?.batchTokens
    && left?.microBatchTokens === right?.microBatchTokens
    && left?.gpuLayers === right?.gpuLayers;
}

function stableModelFailure(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  const message = typeof error?.message === "string" ? error.message : "";
  if (code === "ARCANE_AI_MODEL_SHARD_TOO_LARGE") {
    return Object.freeze({ code });
  }
  if (/(?:out of memory|allocation failed|failed to allocate|memory exhausted)/iu.test(message)) {
    return Object.freeze({ code: "ARCANE_AI_MODEL_GPU_MEMORY_INSUFFICIENT" });
  }
  if (code === "ARCANE_AI_WEBGPU_EVIDENCE_INVALID") {
    return Object.freeze({ code: "ARCANE_AI_MODEL_FULL_OFFLOAD_UNPROVEN" });
  }
  if (code === "ARCANE_AI_WEBGPU_REQUIRED" && /(?:offload|GPU|WebGPU)/iu.test(message)) {
    return Object.freeze({ code: "ARCANE_AI_MODEL_WEBGPU_REQUIREMENT_FAILED" });
  }
  return null;
}

function capabilityPolicy(
  source,
  runtimeCapabilities,
  loadPlan,
  storage,
  runtimeEvidence,
  state,
  failure = null,
) {
  const reasons = [];
  const add = (code, compatibility, details = {}) => reasons.push(Object.freeze({
    code,
    compatibility,
    details: Object.freeze(details),
  }));
  if (runtimeCapabilities.webAssembly !== true) {
    add("ARCANE_AI_WEBASSEMBLY_UNAVAILABLE", "incompatible");
  }
  if (runtimeCapabilities.opfs !== true) {
    add("ARCANE_AI_OPFS_UNAVAILABLE", "incompatible");
  }
  if (runtimeCapabilities.secureContext !== true) {
    add("ARCANE_AI_SECURE_CONTEXT_REQUIRED", "incompatible");
  }
  if (runtimeCapabilities.webgpuApiPresent !== true) {
    add("ARCANE_AI_WEBGPU_API_UNAVAILABLE", "incompatible");
  }
  const oversized = oversizedModelFile(source);
  if (oversized) {
    add("ARCANE_AI_MODEL_SHARD_TOO_LARGE", "incompatible", {
      name: oversized.name,
      bytes: oversized.bytes,
      maximumBytes: WLLAMA_MAX_FILE_BYTES,
    });
  }
  if (failure && failure.code !== "ARCANE_AI_MODEL_SHARD_TOO_LARGE") {
    add(failure.code, "incompatible");
  }
  if (storage?.compatibility === "incompatible") {
    add(storage.code, "incompatible", {
      requiredBytes: storage.requiredBytes,
      availableBytes: storage.availableBytes,
    });
  } else if (!storage || storage.compatibility === "unknown") {
    add(storage?.code ?? "ARCANE_AI_STORAGE_NOT_MEASURED", "unknown", {
      requiredBytes: storage?.requiredBytes ?? knownModelBytes(source),
      availableBytes: storage?.availableBytes ?? null,
    });
  }
  const webgpu = runtimeEvidence?.webgpu;
  if (state === "ready" && webgpu?.observed === true) {
    add("ARCANE_AI_WEBGPU_EXECUTION_OBSERVED", "compatible", {
      requestedGpuLayers: loadPlan.gpuLayers,
      offloadedLayers: webgpu.offload?.layers ?? null,
      totalLayers: webgpu.offload?.totalLayers ?? null,
      queueSubmissions: webgpu.queue?.submissions ?? null,
      logicalBufferDescriptorBytes: webgpu.buffers?.descriptorBytes ?? null,
    });
  } else if (runtimeCapabilities.webgpuApiPresent === true) {
    add("ARCANE_AI_WEBGPU_EXECUTION_UNOBSERVED", "unknown", {
      requestedGpuLayers: loadPlan.gpuLayers,
    });
  }
  const compatibility = reasons.some((reason) => reason.compatibility === "incompatible")
    ? "incompatible"
    : reasons.some((reason) => reason.compatibility === "unknown")
      ? "unknown"
      : "compatible";
  return Object.freeze({
    protocol: CAPABILITY_POLICY_PROTOCOL,
    compatibility,
    reasons: Object.freeze(reasons),
    model: Object.freeze({
      id: source.id,
      fileCount: sourceMetadata(source).files.length,
      declaredBytes: knownModelBytes(source),
    }),
    load: loadPlan,
    storage: storage ?? null,
    inputs: Object.freeze({
      hardwareConcurrency: runtimeCapabilities.hardwareConcurrency,
      deviceMemory: runtimeCapabilities.deviceMemory,
      deviceMemoryMeaning: "coarse-system-memory-gib",
      webAssembly: runtimeCapabilities.webAssembly,
      opfs: runtimeCapabilities.opfs,
      secureContext: runtimeCapabilities.secureContext,
      webgpuApiPresent: runtimeCapabilities.webgpuApiPresent,
    }),
  });
}

function providerModelSources(source, sources) {
  const list = sources === undefined ? [source] : sources;
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError("createBrowserWasmLlmProvider requires a nonempty sources array or legacy source.");
  }
  const ids = new Set();
  for (const candidate of list) {
    if (!BROWSER_MODEL_SOURCES.has(candidate)) {
      throw new TypeError("Every browser-WASM model source must come from createBrowserModelSource().");
    }
    if (ids.has(candidate.id)) {
      throw new TypeError("Browser-WASM model source ids must be unique within one provider catalog.");
    }
    ids.add(candidate.id);
  }
  if (source !== undefined && !BROWSER_MODEL_SOURCES.has(source)) {
    throw new TypeError("The legacy default source must come from createBrowserModelSource().");
  }
  if (source !== undefined && !list.includes(source)) {
    throw new TypeError("The legacy default source must be one member of sources.");
  }
  return Object.freeze({
    sources: Object.freeze(list.slice()),
    defaultSource: source ?? list[0],
  });
}

export function createBrowserWasmLlmProvider({
  source,
  sources,
  store,
  loadDefaults = {},
  security,
  logger = console,
} = {}) {
  const configuredModels = providerModelSources(source, sources);
  const modelSources = configuredModels.sources;
  const defaultSource = configuredModels.defaultSource;
  if (!DBOPFS_MODEL_STORES.has(store)) {
    throw new TypeError("createBrowserWasmLlmProvider requires createDbopfsModelStore().");
  }
  const bindingSecurity = normalizeModelSecurity(security, "provider security");
  const runtimeLoadDefaults = { ...loadDefaults };
  delete runtimeLoadDefaults.security;
  delete runtimeLoadDefaults.offline;
  delete runtimeLoadDefaults.onProgress;

  const runtime = createPackagedWllamaRuntime({ logger });
  const storagePolicies = new Map();
  const modelFailures = new Map();
  let activeSource = defaultSource;
  let activeLoadPlan = capabilityLoadPlan(
    measuredRuntimeCapabilities(runtime.capabilities()),
    runtimeLoadDefaults,
  );
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

  function sourceForModel(modelId = undefined) {
    if (modelId === undefined || modelId === null) return defaultSource;
    const candidate = modelSources.find((value) => value.id === modelId);
    if (!candidate) {
      throw fail(
        "ARCANE_AI_MODEL_AUTHORITY_REQUIRED",
        "The selected model is not present in this provider's caller-supplied catalog.",
      );
    }
    return candidate;
  }

  function capabilities() {
    const runtimeCapabilities = measuredRuntimeCapabilities(runtime.capabilities());
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
      deviceMemory: runtimeCapabilities.deviceMemory,
      orderedModelFiles: true,
      capabilityPolicyProtocol: CAPABILITY_POLICY_PROTOCOL,
    });
  }

  function currentCapabilityPolicy() {
    const runtimeCapabilities = measuredRuntimeCapabilities(runtime.capabilities());
    return capabilityPolicy(
      activeSource,
      runtimeCapabilities,
      activeLoadPlan,
      storagePolicies.get(activeSource.id) ?? null,
      runtime.evidence(),
      state,
      modelFailures.get(activeSource.id) ?? null,
    );
  }

  function catalog() {
    const runtimeCapabilities = measuredRuntimeCapabilities(runtime.capabilities());
    return Object.freeze(modelSources.map((candidate) => {
      const selected = candidate === activeSource;
      const plan = selected
        ? activeLoadPlan
        : capabilityLoadPlan(runtimeCapabilities, runtimeLoadDefaults);
      const policy = capabilityPolicy(
        candidate,
        runtimeCapabilities,
        plan,
        storagePolicies.get(candidate.id) ?? null,
        selected ? runtime.evidence() : null,
        selected ? state : "unloaded",
        modelFailures.get(candidate.id) ?? null,
      );
      return Object.freeze({
        ...publicDescriptor(candidate),
        compatibility: policy.compatibility,
        compatibilityDetails: policy,
      });
    }));
  }

  function status(context = {}) {
    const effectiveSecurity = activeSecurity ?? resolveModelSecurity({
      app: context?.security,
      binding: bindingSecurity,
    });
    const integrity = activeIntegrity ?? integritySnapshot(effectiveSecurity, activeSource);
    return Object.freeze({
      protocol: ARCANE_AI_ADAPTER_PROTOCOL,
      provider: "arcane-browser-wasm-wllama",
      state,
      loaded: state === "ready" && runtime.isLoaded(),
      busy: activeCount > 0,
      queued: Math.max(0, queueDepth - activeCount),
      model: publicDescriptor(activeSource),
      cache: Object.freeze({ state: cacheState, schema: MODEL_MANIFEST_SCHEMA }),
      security: securitySnapshot(effectiveSecurity),
      integrity,
      progress: progressState,
      error: errorState,
      runtime: runtime.authority,
      runtimeEvidence: runtime.evidence(),
      capabilities: capabilities(),
      capabilityPolicy: currentCapabilityPolicy(),
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
    const requestedSource = sourceForModel(options.modelId);
    const effectiveSecurity = resolveModelSecurity({
      app: context.security,
      binding: bindingSecurity,
      load: options.security,
    });
    assertDescriptorChecks(requestedSource, effectiveSecurity);
    const requestedLoadPlan = capabilityLoadPlan(
      measuredRuntimeCapabilities(runtime.capabilities()),
      runtimeLoadDefaults,
      options,
    );
    const oversized = oversizedModelFile(requestedSource);
    if (oversized) {
      modelFailures.set(requestedSource.id, Object.freeze({
        code: "ARCANE_AI_MODEL_SHARD_TOO_LARGE",
      }));
      throw fail(
        "ARCANE_AI_MODEL_SHARD_TOO_LARGE",
        `Model file ${oversized.name} exceeds Wllama's ${WLLAMA_MAX_FILE_BYTES}-byte boundary.`,
      );
    }
    if (state === "ready") {
      if (activeSource !== requestedSource) {
        throw fail(
          "ARCANE_AI_MODEL_RELOAD_REQUIRED",
          "Unload the active browser-WASM model before selecting another model.",
        );
      }
      if (!sameLoadPlan(activeLoadPlan, requestedLoadPlan)) {
        throw fail(
          "ARCANE_AI_LOAD_PLAN_RELOAD_REQUIRED",
          "Unload the browser-WASM model before changing its context or batch load plan.",
        );
      }
      if (sameModelSecurity(activeSecurity, effectiveSecurity)) {
        activeSecurity = effectiveSecurity;
        return Object.freeze({ model: publicDescriptor(activeSource), status: status() });
      }
      throw fail(
        "ARCANE_AI_SECURITY_RELOAD_REQUIRED",
        "Unload the browser-WASM model before changing its effective security checks.",
      );
    }
    if (loadPromise) {
      if (activeSource !== requestedSource) {
        throw fail(
          "ARCANE_AI_MODEL_RELOAD_REQUIRED",
          "The in-flight browser-WASM load owns a different model.",
        );
      }
      if (!sameLoadPlan(activeLoadPlan, requestedLoadPlan)) {
        throw fail(
          "ARCANE_AI_LOAD_PLAN_RELOAD_REQUIRED",
          "The in-flight browser-WASM load uses a different context or batch plan.",
        );
      }
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
    activeSource = requestedSource;
    activeSecurity = effectiveSecurity;
    activeLoadPlan = requestedLoadPlan;
    activeIntegrity = integritySnapshot(effectiveSecurity, activeSource);
    state = "loading";
    progressState = null;
    errorState = null;
    loadPromise = (async () => {
      try {
        throwIfAborted(signal, "load");
        const admitted = await store.ensure(activeSource, {
          signal,
          offline: options.offline === true,
          security: effectiveSecurity,
          onProgress: (value) => report(value, options, context),
          onCapabilityPolicy: (value) => { storagePolicies.set(activeSource.id, value); },
        });
        cacheState = admitted.cache;
        activeIntegrity = admitted.integrity;
        throwIfAborted(signal, "load");
        if (generation !== lifecycleGeneration || state !== "loading") {
          throw fail("ARCANE_AI_OPERATION_SUPERSEDED", "The model load was superseded by unload.");
        }
        report(
          progress(activeSource, "initialize", admitted.observedBytes, admitted.observedBytes),
          options,
          context,
        );
        throwIfAborted(signal, "load");
        if (generation !== lifecycleGeneration || state !== "loading") {
          throw fail("ARCANE_AI_OPERATION_SUPERSEDED", "The model load was superseded by unload.");
        }
        const members = sourceMetadata(activeSource).files;
        const modelFiles = admitted.files.map((file, index) => (
          typeof globalThis.File === "function"
            ? new File([file], members[index].name, { type: "application/octet-stream" })
            : file
        ));
        const runtimeOptions = { ...options };
        delete runtimeOptions.security;
        delete runtimeOptions.offline;
        delete runtimeOptions.onProgress;
        delete runtimeOptions.modelId;
        await runtime.load(modelFiles, {
          ...runtimeLoadDefaults,
          ...runtimeOptions,
          ...activeLoadPlan,
          signal,
        });
        if (!runtime.isLoaded()) {
          throw fail(
            "ARCANE_AI_LOAD_FAILED",
            "Wllama did not confirm that the model loaded successfully.",
          );
        }
        emitWebgpuAdapterSelection(activeSource, runtime);
        throwIfAborted(signal, "load");
        if (generation !== lifecycleGeneration || state !== "loading") {
          await runtime.exit();
          throw fail("ARCANE_AI_OPERATION_SUPERSEDED", "The model load was superseded by unload.");
        }
        state = "ready";
        progressState = null;
        modelFailures.delete(activeSource.id);
        return Object.freeze({ model: publicDescriptor(activeSource), status: status() });
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
        const modelFailure = stableModelFailure(normalized);
        if (modelFailure) modelFailures.set(activeSource.id, modelFailure);
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
    model: publicDescriptor(defaultSource),
    catalog,
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

function assertV1LlmAdapterSelection(selection, providerId, modelIds, role) {
  if (role !== "llm") {
    throw fail("ARCANE_AI_PROVIDER_ROLE_MISMATCH", "The browser-WASM adapter serves only the LLM role.");
  }
  if (
    !selection
    || typeof selection !== "object"
    || Array.isArray(selection)
    || selection.providerId !== providerId
    || !modelIds.has(selection.modelId)
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

  const fallbackCatalog = Object.freeze([model]);
  const initialCatalog = typeof provider.catalog === "function"
    ? provider.catalog()
    : fallbackCatalog;
  if (!Array.isArray(initialCatalog) || initialCatalog.length === 0) {
    throw new TypeError("The browser-WASM provider catalog must be a nonempty array.");
  }
  const catalogModels = new Map();
  for (const entry of initialCatalog) {
    const descriptor = modelDescriptor(entry);
    if (catalogModels.has(descriptor.id)) {
      throw new TypeError("The browser-WASM provider catalog model ids must be unique.");
    }
    catalogModels.set(descriptor.id, descriptor);
  }
  const modelIds = new Set(catalogModels.keys());
  let disposed = false;

  function assertSelection(selection, role) {
    assertV1LlmAdapterSelection(selection, providerId, modelIds, role);
  }

  function authorityFor(selection) {
    const selectedModel = catalogModels.get(selection.modelId);
    return Object.freeze({
      protocol: AI_MODEL_AUTHORITY_PROTOCOL,
      providerId,
      modelId: selectedModel.id,
      admitted: true,
      localOnly: true,
      model: selectedModel,
    });
  }

  function assertActiveSelection(selection) {
    const active = methods.status()?.model?.id;
    if (active !== selection.modelId) {
      throw fail(
        "ARCANE_AI_MODEL_NOT_READY",
        "The selected browser-WASM model is not the provider's active model.",
      );
    }
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
      capabilityPolicy: value.capabilityPolicy,
      compatibility: value.capabilityPolicy?.compatibility ?? "unknown",
    });
  }

  const adapted = Object.freeze({
    protocol: AI_PROVIDER_PROTOCOL,
    role: "llm",
    id: providerId,
    localOnly: true,
    catalog: () => typeof provider.catalog === "function"
      ? provider.catalog()
      : fallbackCatalog,
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
      return Object.freeze({ available: true, authority: authorityFor(selection) });
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
        modelId: selection.modelId,
        signal,
        security,
        ...(progress ? { onProgress: (value) => progress(provider2ByteProgress(value)) } : {}),
      });
      return status();
    },
    request({ role = "llm", selection, operation, payload, signal = null } = {}) {
      assertSelection(selection, role);
      assertActiveSelection(selection);
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

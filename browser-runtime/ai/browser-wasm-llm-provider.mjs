import {
  ARCANE_AI_ADAPTER_PROTOCOL,
  ArcaneAIError,
  normalizeModelSecurity,
  normalizeArcaneAIError,
  resolveModelSecurity,
} from "./model-controller.mjs";
import { createPackagedWllamaRuntime } from "./browser-wllama-runtime.mjs";
import { arcaneEvents } from "../event-manager.mjs";

const completeValue = (value) => value;

// Compatibility export only. Ordinary model caching no longer creates or
// requires completion manifests, receipts, or byte identities.
const MODEL_MANIFEST_SCHEMA = "arcane.ai.browser-wasm.model.v4";
const BROWSER_MODEL_SOURCES = new WeakSet();
const BROWSER_MODEL_SOURCE_METADATA = new WeakMap();
const BROWSER_MODEL_SOURCE_TRANSPORTS = new WeakMap();
const MODEL_DESCRIPTOR_METADATA = new WeakMap();
const DBOPFS_MODEL_STORES = new WeakSet();
const V1_LLM_PROVIDER_ADAPTERS = new WeakMap();
const AI_PROVIDER_PROTOCOL = "arcane-ai-provider/2";
const AI_MODEL_AUTHORITY_PROTOCOL = "arcane-ai-model-authority/1";
const WEBGPU_ADAPTER_SELECTED_EVENT = "arcane.ai.browser-wasm.webgpu.adapter.selected";
const WEBGPU_ADAPTER_SELECTION_PROTOCOL = "arcane-ai-webgpu-adapter-selection/1";
const CHROME_HIGH_PERFORMANCE_GPU_FLAG_URL =
  "chrome://flags/#force-high-performance-gpu";
const MODEL_LOAD_HEARTBEAT_MS = 5_000;
const DEFAULT_MODEL_DOWNLOAD_CONCURRENCY = 4;
const MODEL_DOWNLOAD_PROGRESS_INTERVAL_MS = 250;
const MODEL_DOWNLOAD_SPEED_WINDOW_MS = 5_000;
const MODEL_DOWNLOAD_MAX_RANGE_PARTS = 16;
const MODEL_DOWNLOAD_TARGET_RANGE_BYTES = 128_000_000;
const INTEL_VENDOR_ID = 0x8086;
const CAPABILITY_POLICY_PROTOCOL = "arcane-ai-browser-capability-policy/1";
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

async function cancelReadableBody(body, reason) {
  try {
    await body?.cancel?.(reason);
  } catch {
    // Cancellation is cleanup; preserve the transfer failure that prompted it.
  }
}

async function cancelOpenedDownload(opened, reason) {
  try {
    await opened?.cancel?.(reason);
  } catch {
    // Cancellation is cleanup; preserve the transfer failure that prompted it.
  }
}

function httpContentRange(value) {
  const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/iu.exec(
    String(value ?? "").trim(),
  );
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || !Number.isSafeInteger(total)
    || start < 0
    || end < start
    || total <= end
  ) return null;
  return completeValue({ start, end, total });
}

function httpContentLength(value) {
  const length = Number(String(value ?? "").trim());
  return Number.isSafeInteger(length) && length > 0 ? length : null;
}

function downloadConcurrencyValue(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Model downloadConcurrency must be a positive safe integer.");
  }
  return value;
}

function modelHttpRanges(total) {
  const count = Math.min(
    MODEL_DOWNLOAD_MAX_RANGE_PARTS,
    Math.ceil(total / MODEL_DOWNLOAD_TARGET_RANGE_BYTES),
    total,
  );
  const width = Math.floor(total / count);
  const remainder = total % count;
  const ranges = [];
  let start = 0;
  for (let index = 0; index < count; index += 1) {
    const length = width + (index < remainder ? 1 : 0);
    const end = start + length - 1;
    ranges.push(completeValue({ start, end, total }));
    start = end + 1;
  }
  return completeValue(ranges);
}

function progressClock() {
  return typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : Date.now();
}

function modelSourceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
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
  const url = modelSourceUrl(value.url ?? value.immutableUrl);
  if (!url) {
    throw new TypeError("Browser model file url must be a valid absolute URL.");
  }
  const file = {
    name: descriptorFileName(value, url, fallbackName),
    url: url.href,
  };
  if (Number.isSafeInteger(value.bytes) && value.bytes > 0) {
    file.bytes = value.bytes;
  }
  return completeValue(file);
}

function modelDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("A browser model descriptor is required.");
  }
  const id = modelIdText(value.id);
  const hasFiles = value.files !== undefined;
  const hasLegacyFile = ["url", "immutableUrl", "name"]
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
  files = completeValue(files);
  const publicFiles = completeValue(files.map((file) => completeValue({
    name: file.name,
    url: file.url,
    ...(file.bytes === undefined ? {} : { bytes: file.bytes }),
  })));
  let descriptor;
  if (legacy) {
    const [file] = files;
    descriptor = { id, url: file.url };
    if (file.bytes !== undefined) descriptor.bytes = file.bytes;
  } else {
    descriptor = { id, files: publicFiles };
  }
  descriptor = completeValue(descriptor);
  MODEL_DESCRIPTOR_METADATA.set(descriptor, completeValue({ files, legacy }));
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
    arcaneEvents.instrument(WEBGPU_ADAPTER_SELECTED_EVENT, completeValue({
      protocol: WEBGPU_ADAPTER_SELECTION_PROTOCOL,
      providerId: "arcane-browser-wasm-wllama",
      modelId: source.id,
      runtimeEvidenceProtocol: evidence.protocol,
      adapter: webgpu.adapter,
      offload: webgpu.offload ?? null,
      buffers: webgpu.buffers ?? null,
      queue: webgpu.queue ?? null,
    }), completeValue({
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

/**
 * Creates a browser download authority for one caller-supplied model file set.
 * Legacy one-file descriptors normalize to one ordered member.
 * Security is an intent-only seam and does not change ordinary downloads.
 */
export function createBrowserModelSource(descriptor, {
  fetchImpl = null,
} = {}) {
  const model = modelDescriptor(descriptor);
  const metadata = MODEL_DESCRIPTOR_METADATA.get(model);
  const rangeRequestUrls = new Array(metadata.files.length).fill(null);

  function selectedMember(memberIndex) {
    if (!Number.isSafeInteger(memberIndex)) {
      throw new TypeError("A browser model file index must be a safe integer.");
    }
    if (memberIndex < 0 || memberIndex >= metadata.files.length) {
      throw new RangeError("Browser model file index is out of range.");
    }
    return metadata.files[memberIndex];
  }

  async function request(memberIndex, { signal, range = null, url = null } = {}) {
    const member = selectedMember(memberIndex);
    throwIfAborted(signal, "install");
    const fetchFunction = fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchFunction !== "function") {
      throw fail("ARCANE_AI_MODEL_SOURCE_UNAVAILABLE", "Browser fetch is unavailable.");
    }
    const requestOptions = {
      cache: "no-store",
      redirect: "follow",
      signal,
    };
    if (range) requestOptions.headers = { Range: `bytes=${range.start}-${range.end}` };

    let response;
    try {
      response = await fetchFunction(url ?? member.url, requestOptions);
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throwIfAborted(signal, "install");
      throw fail("ARCANE_AI_MODEL_DOWNLOAD_FAILED", "The model download failed.", error);
    }
    let finalUrl;
    try {
      finalUrl = new URL(response?.url || url || member.url);
    } catch {
      finalUrl = null;
    }
    finalUrl ??= new URL(url ?? member.url);
    return completeValue({ member, response, finalUrl: finalUrl.href });
  }

  async function rejectHttpResponse(download) {
    await cancelReadableBody(download.response?.body);
    throw fail(
      "ARCANE_AI_MODEL_DOWNLOAD_FAILED",
      `The model server returned HTTP ${download.response?.status ?? "unknown"}.`,
    );
  }

  function openedDownload(download) {
    const { member, response, finalUrl } = download;
    if (!response.body || typeof response.body.getReader !== "function") {
      throw fail("ARCANE_AI_MODEL_SOURCE_INVALID", "The model response did not provide a byte stream.");
    }
    async function cancel(reason) {
      await response.body.cancel(reason);
    }
    return completeValue({
      body: response.body,
      requestedUrl: member.url,
      finalUrl,
      contentLength: httpContentLength(response.headers?.get?.("content-length")),
      cancel,
    });
  }

  async function open(memberOrOptions = 0, options = {}) {
    let memberIndex = memberOrOptions;
    if (!Number.isSafeInteger(memberOrOptions)) {
      if (metadata.files.length !== 1) {
        throw new TypeError("A browser model file index is required for a multi-file source.");
      }
      memberIndex = 0;
      options = memberOrOptions ?? {};
    }
    const { signal } = options;
    const download = await request(memberIndex, { signal });
    if (!download.response?.ok) await rejectHttpResponse(download);
    return openedDownload(download);
  }

  async function probeRange(memberIndex, { signal } = {}) {
    const download = await request(memberIndex, {
      signal,
      range: { start: 0, end: 0 },
    });
    if (download.response?.status === 200) {
      if (download.finalUrl !== download.member.url) {
        let redirectedProbe = null;
        try {
          redirectedProbe = await request(memberIndex, {
            signal,
            range: { start: 0, end: 0 },
            url: download.finalUrl,
          });
          if (redirectedProbe.response?.status === 206) {
            const header = redirectedProbe.response.headers?.get?.("content-range");
            const observed = httpContentRange(header);
            const total = observed?.total
              ?? httpContentLength(download.response.headers?.get?.("content-length"))
              ?? selectedMember(memberIndex).bytes
              ?? null;
            if (
              (!header || observed)
              && (!observed || (observed.start === 0 && observed.end === 0))
              && Number.isSafeInteger(total)
              && total > 0
            ) {
              await cancelReadableBody(download.response.body);
              await cancelReadableBody(redirectedProbe.response.body);
              rangeRequestUrls[memberIndex] = redirectedProbe.finalUrl;
              return completeValue({ kind: "supported", total });
            }
          }
          await cancelReadableBody(redirectedProbe.response?.body);
        } catch (error) {
          if (signal?.aborted) {
            await cancelReadableBody(download.response.body, signal.reason);
            throw error;
          }
          await cancelReadableBody(redirectedProbe?.response?.body, error);
        }
      }
      return completeValue({ kind: "complete", opened: openedDownload(download) });
    }
    if (download.response?.status !== 206) await rejectHttpResponse(download);
    const header = download.response.headers?.get?.("content-range");
    const observed = httpContentRange(header);
    await cancelReadableBody(download.response.body);
    if (
      (header && !observed)
      || (observed && (observed.start !== 0 || observed.end !== 0))
    ) {
      return completeValue({ kind: "unsupported" });
    }
    const total = observed?.total ?? selectedMember(memberIndex).bytes ?? null;
    if (total === null) return completeValue({ kind: "unsupported" });
    rangeRequestUrls[memberIndex] = download.finalUrl;
    return completeValue({ kind: "supported", total });
  }

  async function openRange(memberIndex, { signal, start, end, total } = {}) {
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || !Number.isSafeInteger(total)
      || start < 0
      || end < start
      || end >= total
    ) {
      throw new RangeError("Browser model HTTP range framing is invalid.");
    }
    const download = await request(memberIndex, {
      signal,
      range: { start, end },
      url: rangeRequestUrls[memberIndex],
    });
    const header = download.response?.headers?.get?.("content-range");
    const observed = httpContentRange(header);
    if (
      download.response?.status !== 206
      || (header && !observed)
      || (observed && (
        observed.start !== start
        || observed.end !== end
        || observed.total !== total
      ))
    ) {
      await cancelReadableBody(download.response?.body);
      throw fail(
        "ARCANE_AI_MODEL_DOWNLOAD_FAILED",
        "The model server did not preserve the requested HTTP byte range.",
      );
    }
    return openedDownload(download);
  }

  const sourceRecord = {
    kind: "arcane-browser-model-source",
    ...model,
    descriptor: model,
    open,
  };
  if (metadata.legacy) {
    sourceRecord.name = metadata.files[0].name;
    sourceRecord.immutableUrl = metadata.files[0].url;
  }
  const source = completeValue(sourceRecord);
  BROWSER_MODEL_SOURCES.add(source);
  BROWSER_MODEL_SOURCE_METADATA.set(source, metadata);
  BROWSER_MODEL_SOURCE_TRANSPORTS.set(source, completeValue({ probeRange, openRange }));
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
  const models = sourceMetadata(source).files.map((file) => completeValue({
    file,
    name: `${safeId}--${file.name}`,
  }));
  return completeValue({
    models: completeValue(models),
    model: models[0].name,
    manifest: `${safeId}.complete.json`,
  });
}

function rangePartName(modelName, range) {
  return `${modelName}.range-${range.start}-${range.end}-of-${range.total}.part`;
}

function rangePartPrefix(modelName) {
  return `${modelName}.range-`;
}

function rangePartDetails(modelName, name) {
  const prefix = rangePartPrefix(modelName);
  if (!name.startsWith(prefix)) return null;
  const match = /^([0-9]+)-([0-9]+)-of-([0-9]+)\.part$/u.exec(name.slice(prefix.length));
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || !Number.isSafeInteger(total)
    || start < 0
    || end < start
    || total <= end
  ) return null;
  const range = completeValue({ start, end, total });
  return rangePartName(modelName, range) === name ? range : null;
}

function securitySnapshot(security) {
  return security?.secure === true ? { secure: true } : undefined;
}

/**
 * Adapts an existing Arcane DBOPFS singleton without rebinding or changing any
 * of its public methods. Ordinary cache reuse is based on the selected model's
 * expected files being present; no receipt or byte identity is created.
 */
export function createDbopfsModelStore({
  dbopfs,
  tableName = "arcane_ai_browser_models",
  estimateStorage = null,
  downloadConcurrency = DEFAULT_MODEL_DOWNLOAD_CONCURRENCY,
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
  const workerLimit = downloadConcurrencyValue(downloadConcurrency);
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

  function createDownloadProgressReporter(members, onProgress, retainFailure) {
    const memberTotals = members.map((member) => member.bytes ?? null);
    let loadedBytes = 0;
    let completed = 0;
    let activeTransfers = 0;
    let transferMode = members.length === 1 ? "probing" : "files";
    let timer = null;
    let lastPublishedAt = 0;
    let samples = [];

    function totalBytesValue() {
      if (memberTotals.some((value) => value === null)) return null;
      const totalBytes = memberTotals.reduce((sum, value) => sum + value, 0);
      return Number.isSafeInteger(totalBytes) ? totalBytes : null;
    }

    function progressRecord(now) {
      samples.push(completeValue({ at: now, loadedBytes }));
      const oldestUsefulTime = now - MODEL_DOWNLOAD_SPEED_WINDOW_MS;
      while (samples.length > 1 && samples[1].at <= oldestUsefulTime) samples.shift();
      const firstSample = samples[0];
      const elapsedSeconds = (now - firstSample.at) / 1_000;
      const sampledBytes = loadedBytes - firstSample.loadedBytes;
      const bytesPerSecond = sampledBytes > 0 && elapsedSeconds > 0
        ? Math.round(sampledBytes / elapsedSeconds)
        : null;
      const totalBytes = totalBytesValue();
      const remainingBytes = totalBytes === null
        ? null
        : Math.max(0, totalBytes - loadedBytes);
      const etaSeconds = remainingBytes === 0
        ? 0
        : bytesPerSecond === null || remainingBytes === null
          ? null
          : Math.ceil(remainingBytes / bytesPerSecond);
      return completeValue({
        phase: "download",
        completed,
        total: members.length,
        unit: "files",
        heartbeat: false,
        loadedBytes,
        totalBytes,
        remainingBytes,
        bytesPerSecond,
        etaSeconds,
        activeTransfers,
        transferLimit: workerLimit,
        transferMode,
      });
    }

    function stopTimer() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    }

    function publish({ force = false } = {}) {
      if (onProgress === null) return;
      const now = progressClock();
      if (!force && now - lastPublishedAt < MODEL_DOWNLOAD_PROGRESS_INTERVAL_MS) return;
      onProgress(progressRecord(now));
      lastPublishedAt = now;
    }

    function publishSafely(options) {
      try {
        publish(options);
        return true;
      } catch (error) {
        stopTimer();
        retainFailure(error);
        return false;
      }
    }

    function setMemberTotal(memberIndex, totalBytes) {
      if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) return;
      if (memberTotals[memberIndex] === totalBytes) return;
      memberTotals[memberIndex] = totalBytes;
      publishSafely({ force: true });
    }

    function addBytes(value) {
      if (!Number.isSafeInteger(value) || value <= 0) return;
      loadedBytes += value;
      publishSafely();
    }

    function discardBytes(value) {
      if (!Number.isSafeInteger(value) || value <= 0) return;
      loadedBytes = Math.max(0, loadedBytes - value);
      samples = [];
      publishSafely({ force: true });
    }

    return completeValue({
      addBytes,
      beginTransfer() {
        activeTransfers += 1;
        publishSafely({ force: true });
      },
      completeMember(memberIndex, totalBytes) {
        if (Number.isSafeInteger(totalBytes) && totalBytes > 0) {
          memberTotals[memberIndex] = totalBytes;
        }
        completed += 1;
        publishSafely({ force: true });
      },
      discardBytes,
      dispose: stopTimer,
      endTransfer({ publishProgress = true } = {}) {
        activeTransfers = Math.max(0, activeTransfers - 1);
        if (publishProgress) publishSafely({ force: true });
      },
      finish() {
        publishSafely({ force: true });
      },
      setMemberTotal,
      setMode(value) {
        if (transferMode === value) return;
        transferMode = value;
        publishSafely({ force: true });
      },
      restoreBytes(value) {
        if (!Number.isSafeInteger(value) || value <= 0) return;
        loadedBytes += value;
        samples = [];
        publishSafely({ force: true });
      },
      restoreMember(memberIndex, totalBytes) {
        if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) return;
        memberTotals[memberIndex] = totalBytes;
        loadedBytes += totalBytes;
        completed += 1;
        samples = [];
        publishSafely({ force: true });
      },
      start() {
        if (!publishSafely({ force: true })) return;
        if (onProgress !== null && timer === null) {
          timer = setInterval(function publishDownloadProgressTick() {
            publishSafely();
          }, MODEL_DOWNLOAD_PROGRESS_INTERVAL_MS);
        }
      },
    });
  }

  async function write(name, body, {
    signal,
    onChunk = null,
    onDiscard = null,
  } = {}) {
    const directory = await table();
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    let written = 0;
    try {
      for await (const chunk of byteChunks(body, signal)) {
        await writable.write(chunk);
        written += chunk.byteLength;
        onChunk?.(chunk.byteLength);
        throwIfAborted(signal, "install");
      }
      throwIfAborted(signal, "install");
      await writable.close();
      return written;
    } catch (error) {
      await writable.abort?.(error).catch(() => undefined);
      await directory.removeEntry(name).catch(() => undefined);
      onDiscard?.(written);
      throw error;
    }
  }

  async function storedModelFile(name) {
    const modelFile = await file(name);
    if (!modelFile || modelFile.size === 0) {
      throw fail(
        "ARCANE_AI_MODEL_CACHE_REJECTED",
        "A stored model file could not be reopened as a non-empty model.",
      );
    }
    return modelFile;
  }

  async function writeOpenedModel(name, opened, {
    signal,
    onChunk = null,
    onDiscard = null,
  } = {}) {
    let written = 0;
    try {
      written = await write(name, opened.body, { signal, onChunk, onDiscard });
      return await storedModelFile(name);
    } catch (error) {
      if (written > 0) onDiscard?.(written);
      await cancelOpenedDownload(opened, error);
      throw error;
    }
  }

  async function writeParallelRanges(
    source,
    memberIndex,
    name,
    total,
    {
      signal,
      progress,
      rangeWorkerLimit = workerLimit,
    } = {},
  ) {
    const transport = BROWSER_MODEL_SOURCE_TRANSPORTS.get(source);
    const ranges = modelHttpRanges(total);
    const partFiles = new Array(ranges.length);
    const pendingRangeIndexes = [];
    for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex += 1) {
      throwIfAborted(signal, "install");
      const range = ranges[rangeIndex];
      const partName = rangePartName(name, range);
      const partFile = await file(partName);
      const expected = range.end - range.start + 1;
      if (partFile?.size === expected) {
        partFiles[rangeIndex] = partFile;
        progress?.restoreBytes(expected);
      } else {
        if (partFile) await removeEntry(partName);
        pendingRangeIndexes.push(rangeIndex);
      }
    }
    const linked = linkAbortSignal(signal);
    const downloadSignal = linked.controller.signal;
    let nextPendingIndex = 0;
    let failure = null;

    function retainFailure(error) {
      if (failure === null) failure = error;
    }

    async function transferRangeWorker() {
      while (true) {
        const pendingIndex = nextPendingIndex;
        nextPendingIndex += 1;
        if (pendingIndex >= pendingRangeIndexes.length) return;
        const rangeIndex = pendingRangeIndexes[pendingIndex];
        const range = ranges[rangeIndex];
        const partName = rangePartName(name, range);
        let opened = null;
        let writable = null;
        let received = 0;
        progress?.beginTransfer();
        try {
          opened = await transport.openRange(memberIndex, {
            signal: downloadSignal,
            start: range.start,
            end: range.end,
            total: range.total,
          });
          const directory = await table();
          const handle = await directory.getFileHandle(partName, { create: true });
          writable = await handle.createWritable();
          const expected = range.end - range.start + 1;
          for await (const chunk of byteChunks(opened.body, downloadSignal)) {
            const nextReceived = received + chunk.byteLength;
            if (!Number.isSafeInteger(nextReceived) || nextReceived > expected) {
              throw fail(
                "ARCANE_AI_MODEL_DOWNLOAD_FAILED",
                "The model server returned more content than the requested HTTP byte range.",
              );
            }
            await writable.write(chunk);
            received = nextReceived;
            progress?.addBytes(chunk.byteLength);
            throwIfAborted(downloadSignal, "install");
          }
          if (received !== expected) {
            throw fail(
              "ARCANE_AI_MODEL_DOWNLOAD_FAILED",
              "The model server returned less content than the requested HTTP byte range.",
            );
          }
          throwIfAborted(downloadSignal, "install");
          await writable.close();
          writable = null;
          partFiles[rangeIndex] = await storedModelFile(partName);
        } catch (error) {
          retainFailure(error);
          await cancelOpenedDownload(opened, error);
          try {
            await writable?.abort?.(error);
          } catch {
            // The range part is removed below even if its writable already closed.
          }
          await removeEntry(partName).catch(() => undefined);
          progress?.discardBytes(received);
          throw error;
        } finally {
          progress?.endTransfer({ publishProgress: failure === null });
        }
      }
    }

    const workers = [];
    const workerCount = Math.min(rangeWorkerLimit, pendingRangeIndexes.length);
    for (let index = 0; index < workerCount; index += 1) {
      workers.push(transferRangeWorker());
    }
    try {
      const results = await Promise.allSettled(workers);
      if (failure === null) {
        for (const result of results) {
          if (result.status === "rejected") {
            failure = result.reason;
            break;
          }
        }
      }
      if (failure !== null) throw failure;
      throwIfAborted(downloadSignal, "install");
      const modelFile = new Blob(partFiles, { type: "application/octet-stream" });
      await removeStaleRangePartsAfterCompletion(name, ranges);
      return modelFile;
    } catch (error) {
      retainFailure(error);
      throw failure;
    } finally {
      linked.release();
    }
  }

  async function installOneFile(
    source,
    memberIndex,
    name,
    {
      signal,
      progress,
      retainFailure = null,
      multiFile = false,
      rangeWorkerLimit = workerLimit,
    } = {},
  ) {
    const transport = BROWSER_MODEL_SOURCE_TRANSPORTS.get(source);
    if (!transport) return null;
    if (!multiFile) progress?.setMode("probing");
    progress?.beginTransfer();
    let probe;
    try {
      probe = await transport.probeRange(memberIndex, { signal });
    } catch (error) {
      retainFailure?.(error);
      progress?.endTransfer({ publishProgress: false });
      throw error;
    }
    if (probe.kind === "complete") {
      if (!multiFile) progress?.setMode("single");
      progress?.setMemberTotal(memberIndex, probe.opened.contentLength);
      try {
        const modelFile = await writeOpenedModel(name, probe.opened, {
          signal,
          onChunk: progress?.addBytes,
          onDiscard: progress?.discardBytes,
        });
        await removeRangePartsAfterWholeFile(name, probe.opened.contentLength);
        return modelFile;
      } catch (error) {
        retainFailure?.(error);
        throw error;
      } finally {
        progress?.endTransfer({ publishProgress: false });
      }
    }
    progress?.endTransfer({ publishProgress: false });
    if (probe.kind !== "supported") return null;
    if (!multiFile) progress?.setMode("ranges");
    progress?.setMemberTotal(memberIndex, probe.total);
    return writeParallelRanges(source, memberIndex, name, probe.total, {
      signal,
      progress,
      rangeWorkerLimit,
    });
  }

  async function removeNames(names) {
    const removed = [];
    for (const entry of names.models) removed.push(await removeEntry(entry.name));
    removed.push(await removeEntry(names.manifest));
    return removed.some(Boolean);
  }

  async function memberRangePartNames(modelName) {
    const directory = await table();
    if (typeof directory.entries !== "function") return null;
    const prefix = rangePartPrefix(modelName);
    const names = [];
    for await (const [name] of directory.entries()) {
      if (name.startsWith(prefix)) names.push(name);
    }
    return names;
  }

  async function removeMemberRangeParts(modelName, {
    except = null,
    total = null,
  } = {}) {
    const existingNames = await memberRangePartNames(modelName);
    const names = existingNames ?? (
      Number.isSafeInteger(total) && total > 0
        ? modelHttpRanges(total).map((range) => rangePartName(modelName, range))
        : []
    );
    const removed = [];
    for (const name of names) {
      if (except?.has(name)) continue;
      removed.push(await removeEntry(name));
    }
    return removed.some(Boolean);
  }

  async function removeRangePartsAfterWholeFile(modelName, total) {
    try {
      await removeMemberRangeParts(modelName, { total });
    } catch (error) {
      globalThis.console?.warn?.(
        "Arcane could not remove superseded browser model range parts.",
        error,
      );
    }
  }

  async function removeStaleRangePartsAfterCompletion(modelName, ranges) {
    const keep = new Set(ranges.map((range) => rangePartName(modelName, range)));
    try {
      await removeMemberRangeParts(modelName, {
        except: keep,
        total: ranges[0]?.total ?? null,
      });
    } catch (error) {
      globalThis.console?.warn?.(
        "Arcane could not remove superseded browser model range parts.",
        error,
      );
    }
  }

  async function removeRangePartsBehindWholeFiles(members, names, modelFiles) {
    const completeMembers = [];
    for (let memberIndex = 0; memberIndex < modelFiles.length; memberIndex += 1) {
      if (!modelFiles[memberIndex]) continue;
      completeMembers.push(completeValue({
        modelName: names.models[memberIndex].name,
        total: members[memberIndex].bytes,
      }));
    }
    if (completeMembers.length === 0) return;
    try {
      const directory = await table();
      if (typeof directory.entries === "function") {
        const prefixes = completeMembers.map(({ modelName }) => rangePartPrefix(modelName));
        const entries = [];
        for await (const [name] of directory.entries()) {
          if (prefixes.some((prefix) => name.startsWith(prefix))) entries.push(name);
        }
        for (const name of entries) await removeEntry(name);
        return;
      }
      for (const { modelName, total } of completeMembers) {
        await removeMemberRangeParts(modelName, { total });
      }
    } catch (error) {
      globalThis.console?.warn?.(
        "Arcane could not remove superseded browser model range parts.",
        error,
      );
    }
  }

  async function removeRangeParts(source, names) {
    const members = sourceMetadata(source).files;
    const directory = await table();
    if (typeof directory.entries === "function") {
      const prefixes = names.models.map((entry) => rangePartPrefix(entry.name));
      const entries = [];
      for await (const [name] of directory.entries()) {
        if (prefixes.some((prefix) => name.startsWith(prefix))) entries.push(name);
      }
      const removed = [];
      for (const name of entries) removed.push(await removeEntry(name));
      return removed.some(Boolean);
    }
    const removed = [];
    for (let memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
      const total = members[memberIndex].bytes;
      if (!Number.isSafeInteger(total) || total <= 0) continue;
      for (const range of modelHttpRanges(total)) {
        removed.push(await removeEntry(rangePartName(names.models[memberIndex].name, range)));
      }
    }
    return removed.some(Boolean);
  }

  async function remove(source) {
    const names = storageName(source);
    const legacyNames = storageName(source, { legacy: true });
    let legacyManifest = null;
    let removeLegacy = sourceMetadata(source).legacy;
    try {
      legacyManifest = await legacyManifestForSource(source, legacyNames);
      removeLegacy ||= Boolean(legacyManifest);
    } catch (error) {
      globalThis.console?.warn?.(
        "Arcane could not inspect the legacy browser model cache during removal.",
        error,
      );
    }
    let removed = await removeNames(names);
    removed = await removeRangeParts(source, names) || removed;
    if (removeLegacy) {
      removed = await removeNames(
        legacyStorageNames(source, legacyNames, legacyManifest),
      ) || removed;
    }
    return removed;
  }

  async function legacyManifestForSource(source, legacyNames) {
    const manifestFile = await file(legacyNames.manifest);
    if (!manifestFile) return null;
    let manifest;
    try {
      manifest = JSON.parse(await manifestFile.text());
    } catch {
      return null;
    }
    const model = manifest?.model;
    return manifest?.complete === true && model?.id === source.id ? manifest : null;
  }

  function legacyStorageNames(source, names, manifest) {
    if (!manifest) return names;
    const safeId = source.id.replace(/[^a-z0-9._-]+/giu, "_");
    const storedNames = new Set(names.models.map((entry) => entry.name));
    const candidates = [];
    if (Array.isArray(manifest.model?.files)) candidates.push(...manifest.model.files);
    if (manifest.model && typeof manifest.model === "object") candidates.push(manifest.model);
    if (Array.isArray(manifest.files)) candidates.push(...manifest.files);
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      if (
        candidate.name === undefined
        && candidate.url === undefined
        && candidate.immutableUrl === undefined
      ) continue;
      try {
        const url = modelSourceUrl(candidate.url ?? candidate.immutableUrl)
          ?? new URL("https://arcane.invalid/model.gguf");
        const name = descriptorFileName(candidate, url);
        storedNames.add(`${safeId}--${name}`);
      } catch {
        // Keep cleanup limited to valid filenames attributable to this manifest.
      }
    }
    return completeValue({
      ...names,
      models: completeValue([...storedNames].map((name) => completeValue({ name }))),
    });
  }

  async function legacyNamespaceMatchesSource(source, legacyNames) {
    const metadata = sourceMetadata(source);
    if (metadata.legacy) return true;
    if (metadata.files.length !== 1) return false;
    const manifest = await legacyManifestForSource(source, legacyNames);
    if (!manifest) return false;
    const model = manifest.model;
    const [member] = metadata.files;
    if (model.url === member.url) return true;
    if (model.name === member.name && model.immutableUrl === member.url) return true;
    return Array.isArray(model.files)
      && model.files.length === 1
      && model.files[0]?.name === member.name
      && model.files[0]?.url === member.url;
  }

  async function legacyCacheForSource(source, signal) {
    const names = storageName(source, { legacy: true });
    if (!await legacyNamespaceMatchesSource(source, names)) return null;
    const files = await storedModelFiles(names, signal);
    return files ? completeValue({ files, names }) : null;
  }

  async function removeLegacyCacheAfterReplacement(source) {
    try {
      const names = storageName(source, { legacy: true });
      const manifest = await legacyManifestForSource(source, names);
      if (!sourceMetadata(source).legacy && !manifest) return;
      await removeNames(legacyStorageNames(source, names, manifest));
    } catch (error) {
      globalThis.console?.warn?.(
        "Arcane could not remove the superseded legacy browser model cache.",
        error,
      );
    }
  }

  async function removeIncompleteReplacement(source, names) {
    try {
      await removeNames(names);
      await removeRangeParts(source, names);
    } catch (error) {
      globalThis.console?.warn?.(
        "Arcane could not remove an incomplete duplicate browser model cache.",
        error,
      );
    }
  }

  async function storagePolicy({ cached = false } = {}) {
    return completeValue({
      compatibility: "compatible",
      code: cached
        ? "ARCANE_AI_MODEL_CACHE_AVAILABLE"
        : "ARCANE_AI_MODEL_STORAGE_AVAILABLE",
      measured: false,
    });
  }

  async function availableModelFiles(names, signal) {
    const modelFiles = [];
    for (const entry of names.models) {
      throwIfAborted(signal, "install");
      const modelFile = await file(entry.name);
      if (modelFile?.size === 0) {
        await removeEntry(entry.name);
        modelFiles.push(null);
      } else {
        modelFiles.push(modelFile);
      }
    }
    return modelFiles;
  }

  async function storedModelFiles(names, signal) {
    const modelFiles = await availableModelFiles(names, signal);
    return modelFiles.every(Boolean) ? modelFiles : null;
  }

  async function storedRangeCandidate(modelName, total, signal) {
    const partFiles = [];
    let lastModified = 0;
    for (const range of modelHttpRanges(total)) {
      throwIfAborted(signal, "install");
      const partName = rangePartName(modelName, range);
      const partFile = await file(partName);
      if (!partFile) return null;
      const expected = range.end - range.start + 1;
      if (partFile.size !== expected) {
        await removeEntry(partName);
        return null;
      }
      partFiles.push(partFile);
      if (Number.isFinite(partFile.lastModified)) {
        lastModified = Math.max(lastModified, partFile.lastModified);
      }
    }
    return completeValue({
      file: new Blob(partFiles, { type: "application/octet-stream" }),
      lastModified,
      total,
    });
  }

  async function storedRangeMember(member, modelName, signal) {
    const declaredTotal = Number.isSafeInteger(member.bytes) && member.bytes > 0
      ? member.bytes
      : null;
    if (declaredTotal !== null) {
      const declared = await storedRangeCandidate(modelName, declaredTotal, signal);
      if (declared) {
        await removeStaleRangePartsAfterCompletion(
          modelName,
          modelHttpRanges(declaredTotal),
        );
        return declared.file;
      }
    }

    const names = await memberRangePartNames(modelName);
    if (names === null) return null;
    const discoveredTotals = new Set();
    for (const name of names) {
      const details = rangePartDetails(modelName, name);
      if (details && details.total !== declaredTotal) discoveredTotals.add(details.total);
    }
    let selected = null;
    const totals = [...discoveredTotals].sort((left, right) => right - left);
    for (const total of totals) {
      const candidate = await storedRangeCandidate(modelName, total, signal);
      if (
        candidate
        && (
          selected === null
          || candidate.lastModified > selected.lastModified
        )
      ) selected = candidate;
    }
    if (selected === null) return null;
    await removeStaleRangePartsAfterCompletion(
      modelName,
      modelHttpRanges(selected.total),
    );
    return selected.file;
  }

  async function availableResumableModelFiles(source, names, signal) {
    const members = sourceMetadata(source).files;
    const modelFiles = await availableModelFiles(names, signal);
    await removeRangePartsBehindWholeFiles(members, names, modelFiles);
    for (let memberIndex = 0; memberIndex < modelFiles.length; memberIndex += 1) {
      if (modelFiles[memberIndex]) continue;
      modelFiles[memberIndex] = await storedRangeMember(
        members[memberIndex],
        names.models[memberIndex].name,
        signal,
      );
    }
    return modelFiles;
  }

  async function openCached(source, {
    signal,
  } = {}) {
    const names = storageName(source);
    let modelFiles = await availableResumableModelFiles(source, names, signal);
    if (modelFiles.every(Boolean)) {
      await removeLegacyCacheAfterReplacement(source);
    } else {
      const legacyCache = await legacyCacheForSource(source, signal);
      if (legacyCache) {
        await removeIncompleteReplacement(source, names);
        modelFiles = legacyCache.files;
      }
    }
    if (!modelFiles.every(Boolean)) return null;
    return completeValue({
      files: completeValue(modelFiles),
      file: modelFiles.length === 1 ? modelFiles[0] : null,
    });
  }

  async function install(source, { signal, onProgress = null } = {}) {
    if (onProgress !== null && typeof onProgress !== "function") {
      throw new TypeError("Model store onProgress must be a function or null.");
    }
    const names = storageName(source);
    const members = sourceMetadata(source).files;
    const modelFiles = await availableResumableModelFiles(source, names, signal);
    const linked = linkAbortSignal(signal);
    const downloadSignal = linked.controller.signal;
    let nextMemberIndex = 0;
    let failure = null;

    function retainFailure(error) {
      if (failure === null) failure = error;
    }

    const progress = createDownloadProgressReporter(members, onProgress, retainFailure);

    async function installMember(memberIndex) {
      let modelFile = null;
      modelFile = await installOneFile(
        source,
        memberIndex,
        names.models[memberIndex].name,
        {
          signal: downloadSignal,
          progress,
          retainFailure,
          multiFile: members.length > 1,
          rangeWorkerLimit: members.length === 1 ? workerLimit : 1,
        },
      );
      if (!modelFile) {
        progress.setMode(members.length === 1 ? "single" : "files");
        progress.beginTransfer();
        let opened = null;
        try {
          opened = await source.open(memberIndex, { signal: downloadSignal });
          progress.setMemberTotal(memberIndex, opened.contentLength);
          modelFile = await writeOpenedModel(
            names.models[memberIndex].name,
            opened,
            {
              signal: downloadSignal,
              onChunk: progress.addBytes,
              onDiscard: progress.discardBytes,
            },
          );
          await removeRangePartsAfterWholeFile(
            names.models[memberIndex].name,
            opened.contentLength,
          );
        } catch (error) {
          retainFailure(error);
          throw error;
        } finally {
          progress.endTransfer({ publishProgress: false });
        }
      }
      throwIfAborted(downloadSignal, "install");
      modelFiles[memberIndex] = modelFile;
      progress.completeMember(memberIndex, modelFile.size);
    }

    async function installWorker() {
      while (true) {
        const memberIndex = nextMemberIndex;
        nextMemberIndex += 1;
        if (memberIndex >= members.length) return;
        if (modelFiles[memberIndex]) continue;
        try {
          await installMember(memberIndex);
        } catch (error) {
          retainFailure(error);
          throw error;
        }
      }
    }

    try {
      progress.start();
      let pendingMembers = members.length;
      for (let memberIndex = 0; memberIndex < modelFiles.length; memberIndex += 1) {
        const modelFile = modelFiles[memberIndex];
        if (!modelFile) continue;
        pendingMembers -= 1;
        progress.restoreMember(memberIndex, modelFile.size);
      }
      const workers = [];
      const workerCount = Math.min(workerLimit, pendingMembers);
      for (let index = 0; index < workerCount; index += 1) {
        workers.push(installWorker());
      }
      const results = await Promise.allSettled(workers);
      if (failure === null) {
        for (const result of results) {
          if (result.status === "rejected") {
            failure = result.reason;
            break;
          }
        }
      }
      if (failure !== null) throw failure;
      await removeLegacyCacheAfterReplacement(source);
      progress.finish();
      if (failure !== null) throw failure;
      throwIfAborted(downloadSignal, "install");
      return completeValue({
        files: completeValue(modelFiles),
        file: modelFiles.length === 1 ? modelFiles[0] : null,
      });
    } catch (error) {
      retainFailure(error);
      throw failure;
    } finally {
      progress.dispose();
      linked.release();
    }
  }

  async function ensure(source, {
    signal,
    onCapabilityPolicy,
    onProgress = null,
    offline = false,
  } = {}) {
    if (onProgress !== null && typeof onProgress !== "function") {
      throw new TypeError("Model store onProgress must be a function or null.");
    }
    const total = sourceMetadata(source).files.length;
    onProgress?.(completeValue({
      phase: "cache-check",
      completed: 0,
      total,
      unit: "files",
      heartbeat: false,
    }));
    const cached = await openCached(source, { signal });
    if (cached) {
      const storage = await storagePolicy({ cached: true });
      onCapabilityPolicy?.(storage);
      return completeValue({ ...cached, cache: "cached", storage });
    }
    if (offline) {
      throw fail("ARCANE_AI_MODEL_OFFLINE_MISS", "No cached offline model is available.");
    }
    const storage = await storagePolicy();
    onCapabilityPolicy?.(storage);
    const installed = await install(source, { signal, onProgress });
    const admittedStorage = await storagePolicy({ cached: true });
    onCapabilityPolicy?.(admittedStorage);
    return completeValue({ ...installed, cache: "installed", storage: admittedStorage });
  }

  const store = completeValue({
    kind: "arcane-dbopfs-model-store",
    tableName,
    downloadConcurrency: workerLimit,
    adapter: dbopfs,
    ready: () => table().then(() => undefined),
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
  return completeValue({
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

  return completeValue({
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
    return completeValue({ type: "json_object" });
  }
  if (typeof structuredOutput !== "object" || Array.isArray(structuredOutput)) {
    throw new TypeError("structuredOutput must be false, true, \"json\", or a JSON Schema object.");
  }
  return completeValue({
    type: "json_schema",
    json_schema: completeValue({ name: "arcane_response", strict: true, schema: structuredOutput }),
  });
}

function plainStructuralRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateToolMessageSchemas(value) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new TypeError("tools must be an array.");
  for (const [index, tool] of value.entries()) {
    const parameters = tool?.function?.parameters;
    const messageSchema = parameters?.properties?.message;
    if (
      !plainStructuralRecord(tool)
      || tool.type !== "function"
      || !plainStructuralRecord(tool.function)
      || !plainStructuralRecord(parameters)
      || parameters.type !== "object"
      || !plainStructuralRecord(parameters.properties)
      || !plainStructuralRecord(messageSchema)
      || messageSchema.type !== "string"
      || !Number.isInteger(messageSchema.minLength)
      || messageSchema.minLength < 1
      || !Array.isArray(parameters.required)
      || !parameters.required.includes("message")
    ) {
      throw fail(
        "ARCANE_AI_TOOL_MESSAGE_REQUIRED",
        `tools[${String(index)}] must require a nonempty string parameters.properties.message.`,
      );
    }
  }
}

function validateRequestMessages(messages) {
  const pendingToolCallIds = new Set();
  for (const [messageIndex, message] of messages.entries()) {
    if (!plainStructuralRecord(message)) {
      throw new TypeError(`messages[${String(messageIndex)}] must be a plain object.`);
    }
    const hasToolCalls = Object.hasOwn(message, "tool_calls");
    const calls = validateToolCalls(message, `messages[${String(messageIndex)}]`);
    let openedToolCall = false;
    if (hasToolCalls) {
      if (message?.role !== "assistant") {
        throw fail(
          "ARCANE_AI_TOOL_CALL_INVALID",
          `messages[${String(messageIndex)}].tool_calls is supported only for assistant messages.`,
        );
      }
      if (pendingToolCallIds.size && calls.length) {
        throw fail(
          "ARCANE_AI_TOOL_RESULT_REQUIRED",
          "Every pending structural tool result must be supplied before another assistant tool-call sequence.",
        );
      }
      if (calls.length) {
        for (const call of calls) pendingToolCallIds.add(call.id);
        openedToolCall = true;
      }
    }
    if (message?.role === "tool") {
      if (typeof message.content !== "string" || !message.content.trim()) {
        throw fail(
          "ARCANE_AI_INVALID_TOOL_MESSAGE",
          `messages[${String(messageIndex)}] must contain a nonblank user-facing tool result.`,
        );
      }
      if (
        !pendingToolCallIds.size
        || typeof message.tool_call_id !== "string"
        || !pendingToolCallIds.has(message.tool_call_id)
      ) {
        throw fail(
          "ARCANE_AI_INVALID_TOOL_MESSAGE",
          `messages[${String(messageIndex)}] does not settle the pending structural tool call.`,
        );
      }
      pendingToolCallIds.delete(message.tool_call_id);
    } else {
      if (Object.hasOwn(message, "tool_call_id")) {
        throw fail(
          "ARCANE_AI_INVALID_TOOL_MESSAGE",
          `messages[${String(messageIndex)}].tool_call_id is valid only for a tool result.`,
        );
      }
      if (pendingToolCallIds.size && !openedToolCall) {
        throw fail(
          "ARCANE_AI_TOOL_RESULT_REQUIRED",
          `messages[${String(messageIndex)}] precedes the pending structural tool result.`,
        );
      }
    }
  }
  if (pendingToolCallIds.size) {
    throw fail(
      "ARCANE_AI_TOOL_RESULT_REQUIRED",
      "The pending structural tool call must be settled before requesting another response.",
    );
  }
}

function validateStructuralRequest(request) {
  if (!plainStructuralRecord(request)) {
    throw new TypeError("The browser-WASM LLM request must be a plain object.");
  }
  if (!Array.isArray(request.messages)) throw new TypeError("messages must be an array.");
  validateRequestMessages(request.messages);
  validateToolMessageSchemas(request.tools);
  const parallelValues = [request.parallelToolCalls, request.parallel_tool_calls];
  if (parallelValues.some(function invalidParallelBrowserWasmPreference(value) {
    return value !== undefined && typeof value !== "boolean";
  })) {
    throw new TypeError("parallelToolCalls must be a boolean when provided.");
  }
}

function completionOptions(request, abortSignal, stream) {
  validateStructuralRequest(request);
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
    ["repeat", "penalty_repeat"],
    ["repeat_penalty", "penalty_repeat"],
    ["penalty_repeat", "penalty_repeat"],
    ["maxTokens", "max_tokens"],
    ["maxOutputTokens", "max_tokens"],
    ["max_tokens", "max_tokens"],
    ["seed", "seed"],
    ["stop", "stop"],
  ];
  for (const [source, target] of copy) {
    if (request[source] !== undefined) options[target] = request[source];
  }
  if (request.templateOptions !== undefined) {
    if (!request.templateOptions || typeof request.templateOptions !== "object" || Array.isArray(request.templateOptions)) {
      throw new TypeError("templateOptions must be a plain object when provided.");
    }
    options.chat_template_kwargs = { ...request.templateOptions };
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

function validateToolCalls(message, location = "The model response") {
  if (!plainStructuralRecord(message)) {
    throw fail("ARCANE_AI_INVALID_PROVIDER_RESULT", `${location} is not a plain assistant message.`);
  }
  if (
    Object.hasOwn(message, "toolCalls")
    || Object.hasOwn(message, "tool_call")
    || Object.hasOwn(message, "toolCall")
    || Object.hasOwn(message, "function_call")
    || Object.hasOwn(message, "functionCall")
  ) {
    throw fail("ARCANE_AI_TOOL_CALL_INVALID", `${location} contains a noncanonical structural tool-call field.`);
  }
  if (!Object.hasOwn(message, "tool_calls")) return [];
  const descriptor = Object.getOwnPropertyDescriptor(message, "tool_calls");
  if (!descriptor || !Object.hasOwn(descriptor, "value") || !Array.isArray(descriptor.value)) {
    throw fail("ARCANE_AI_TOOL_CALL_INVALID", `${location} contains malformed tool calls.`);
  }
  const calls = descriptor.value;
  const ids = new Set();
  for (const call of calls) {
    if (
      !plainStructuralRecord(call)
      || typeof call.id !== "string"
      || !call.id.trim()
      || ids.has(call.id)
      || call.type !== "function"
      || !plainStructuralRecord(call.function)
      || typeof call.function.name !== "string"
      || !call.function.name.trim()
      || typeof call.function.arguments !== "string"
    ) {
      throw fail("ARCANE_AI_TOOL_CALL_INVALID", `${location} contains malformed tool calls.`);
    }
    let argumentsRecord;
    try {
      argumentsRecord = JSON.parse(call.function.arguments);
    } catch (error) {
      throw fail(
        "ARCANE_AI_TOOL_CALL_INVALID",
        `${location} contains structural tool arguments that are not a JSON object.`,
        error,
      );
    }
    if (!plainStructuralRecord(argumentsRecord)) {
      throw fail(
        "ARCANE_AI_TOOL_CALL_INVALID",
        `${location} contains structural tool arguments that are not a JSON object.`,
      );
    }
    if (typeof argumentsRecord.message !== "string" || !argumentsRecord.message.trim()) {
      throw fail(
        "ARCANE_AI_TOOL_MESSAGE_REQUIRED",
        `${location} structural tool arguments must include a nonempty user-facing message.`,
      );
    }
    ids.add(call.id);
  }
  return calls;
}

function validateCompletion(value, requestId) {
  if (
    !plainStructuralRecord(value)
  ) {
    throw fail("ARCANE_AI_INVALID_PROVIDER_RESULT", "The model returned an invalid chat completion.");
  }
  const hasMessage = Object.hasOwn(value, "message");
  const hasChoices = Object.hasOwn(value, "choices");
  if (hasMessage === hasChoices) {
    throw fail(
      "ARCANE_AI_INVALID_PROVIDER_RESULT",
      "The model completion must contain exactly one message or choices envelope.",
    );
  }
  if (hasMessage) {
    const messageDescriptor = Object.getOwnPropertyDescriptor(value, "message");
    if (
      !messageDescriptor
      || !Object.hasOwn(messageDescriptor, "value")
      || !plainStructuralRecord(messageDescriptor.value)
      || messageDescriptor.value.role !== "assistant"
    ) {
      throw fail("ARCANE_AI_INVALID_PROVIDER_RESULT", "The model returned an invalid assistant message.");
    }
    validateToolCalls(messageDescriptor.value);
    return requestId === undefined ? value : completeValue({ ...value, id: requestId });
  }
  const choicesDescriptor = Object.getOwnPropertyDescriptor(value, "choices");
  if (
    !choicesDescriptor
    || !Object.hasOwn(choicesDescriptor, "value")
    || !Array.isArray(choicesDescriptor.value)
    || choicesDescriptor.value.length === 0
  ) {
    throw fail("ARCANE_AI_INVALID_PROVIDER_RESULT", "The model returned an invalid chat completion.");
  }
  const choices = choicesDescriptor.value;
  const indexes = new Set();
  for (let choicePosition = 0; choicePosition < choices.length; choicePosition += 1) {
    const choice = choices[choicePosition];
    const messageDescriptor = plainStructuralRecord(choice)
      ? Object.getOwnPropertyDescriptor(choice, "message")
      : null;
    if (
      !plainStructuralRecord(choice)
      || !Number.isSafeInteger(choice.index)
      || choice.index < 0
      || indexes.has(choice.index)
      || !messageDescriptor
      || !Object.hasOwn(messageDescriptor, "value")
      || !plainStructuralRecord(messageDescriptor.value)
      || messageDescriptor.value.role !== "assistant"
    ) {
      throw fail("ARCANE_AI_INVALID_PROVIDER_RESULT", "The model returned an invalid choice index.");
    }
    indexes.add(choice.index);
    validateToolCalls(
      messageDescriptor.value,
      `The model response choice ${String(choicePosition)}`,
    );
  }
  return requestId === undefined ? value : completeValue({ ...value, id: requestId });
}

function selectedCompletionToolCalls(completion) {
  const message = Object.hasOwn(completion ?? {}, "message")
    ? completion.message
    : completion?.choices?.[0]?.message;
  return Array.isArray(message?.tool_calls) ? message.tool_calls : [];
}

function sameCanonicalToolCalls(left, right) {
  return left.length === right.length && left.every((call, index) => {
    const other = right[index];
    return call?.id === other?.id
      && call?.type === other?.type
      && call?.function?.name === other?.function?.name
      && call?.function?.arguments === other?.function?.arguments;
  });
}

function sameCompleteStreamValue(left, right, leftToRight = new Map(), rightToLeft = new Map()) {
  if (Object.is(left, right)) return true;
  if (
    !left
    || !right
    || typeof left !== "object"
    || typeof right !== "object"
    || Array.isArray(left) !== Array.isArray(right)
  ) return false;
  if (leftToRight.has(left) || rightToLeft.has(right)) {
    return leftToRight.get(left) === right && rightToLeft.get(right) === left;
  }
  leftToRight.set(left, right);
  rightToLeft.set(right, left);
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key)) return false;
    const leftDescriptor = Object.getOwnPropertyDescriptor(left, key);
    const rightDescriptor = Object.getOwnPropertyDescriptor(right, key);
    const leftIsData = Boolean(leftDescriptor && Object.hasOwn(leftDescriptor, "value"));
    const rightIsData = Boolean(rightDescriptor && Object.hasOwn(rightDescriptor, "value"));
    if (leftIsData !== rightIsData) return false;
    if (leftIsData) {
      if (!sameCompleteStreamValue(
        leftDescriptor.value,
        rightDescriptor.value,
        leftToRight,
        rightToLeft,
      )) return false;
    } else if (
      leftDescriptor?.get !== rightDescriptor?.get
      || leftDescriptor?.set !== rightDescriptor?.set
    ) return false;
  }
  return true;
}

function completionToolCallsAt(completion, choiceIndex) {
  if (Object.hasOwn(completion ?? {}, "message")) {
    if (choiceIndex !== 0 || !Object.hasOwn(completion.message, "tool_calls")) return null;
    return completion.message.tool_calls;
  }
  const choice = completion?.choices?.find((item) => item?.index === choiceIndex);
  if (!choice || !Object.hasOwn(choice.message, "tool_calls")) return null;
  return choice.message.tool_calls;
}

function isPublicStreamStructuralKey(key) {
  return key === "tool_calls"
    || key === "toolCalls"
    || key === "tool_call"
    || key === "toolCall"
    || key === "function_call"
    || key === "functionCall";
}

const OMITTED_PUBLIC_STREAM_DATA = Symbol("omitted-public-stream-data");

function projectPublicStreamData(value, seen = new Map()) {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const result = [];
    seen.set(value, result);
    for (const item of value) {
      const projected = projectPublicStreamData(item, seen);
      if (projected !== OMITTED_PUBLIC_STREAM_DATA) result.push(projected);
    }
    return result.length || value.length === 0 ? result : OMITTED_PUBLIC_STREAM_DATA;
  }
  const result = {};
  seen.set(value, result);
  let sourceDataFields = 0;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") continue;
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, "value")) continue;
    sourceDataFields += 1;
    if (isPublicStreamStructuralKey(key)) continue;
    const projected = projectPublicStreamData(descriptor.value, seen);
    if (projected !== OMITTED_PUBLIC_STREAM_DATA) result[key] = projected;
  }
  return Object.keys(result).length || sourceDataFields === 0
    ? result
    : OMITTED_PUBLIC_STREAM_DATA;
}

function projectPublicStreamChunk(value) {
  return projectPublicStreamData(value);
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
        reasoningText: "",
        sawReasoningText: false,
        finish_reason: null,
        choiceMetadata: {},
        messageMetadata: {},
        completeToolCalls: null,
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
      for (const [key, fieldValue] of Object.entries(item)) {
        if (key !== "delta" && key !== "message") record.choiceMetadata[key] = fieldValue;
      }
      const delta = plainStructuralRecord(item.delta) ? item.delta : {};
      const completeMessage = plainStructuralRecord(item.message) ? item.message : null;
      for (const [source, replaceText] of [[delta, false], [completeMessage, true]]) {
        if (!source) continue;
        for (const [key, fieldValue] of Object.entries(source)) {
          if (isPublicStreamStructuralKey(key)) continue;
          if (key === "role" && typeof fieldValue === "string") {
            record.role = fieldValue;
          } else if (key === "content") {
            if (
              !replaceText
              && record.sawContent
              && typeof record.content === "string"
              && typeof fieldValue === "string"
            ) record.content += fieldValue;
            else record.content = fieldValue;
            record.sawContent = true;
          } else if (key === "reasoning_content") {
            if (
              !replaceText
              && record.sawReasoning
              && typeof record.reasoning === "string"
              && typeof fieldValue === "string"
            ) record.reasoning += fieldValue;
            else record.reasoning = fieldValue;
            record.sawReasoning = true;
          } else if (key === "reasoning") {
            if (
              !replaceText
              && record.sawReasoningText
              && typeof record.reasoningText === "string"
              && typeof fieldValue === "string"
            ) record.reasoningText += fieldValue;
            else record.reasoningText = fieldValue;
            record.sawReasoningText = true;
          } else {
            record.messageMetadata[key] = fieldValue;
          }
        }
      }
      if (completeMessage && Object.hasOwn(completeMessage, "tool_calls")) {
        record.completeToolCalls = validateToolCalls(
          completeMessage,
          `The model response choice ${String(item.index)} streamed message`,
        );
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
          invalidArguments: false,
          invalidIdentity: false,
          type: "",
          name: "",
          arguments: "",
        };
        if (fragment.id !== undefined) {
          if (typeof fragment.id !== "string" || !fragment.id || tool.id && tool.id !== fragment.id) {
            tool.invalidIdentity = true;
          } else {
            tool.id = fragment.id;
          }
        }
        if (fragment.type !== undefined) {
          if (typeof fragment.type !== "string" || !fragment.type || tool.type && tool.type !== fragment.type) {
            tool.invalidIdentity = true;
          } else {
            tool.type = fragment.type;
          }
        }
        if (fragment.function?.name !== undefined) {
          if (typeof fragment.function.name !== "string") tool.invalidIdentity = true;
          else tool.name += fragment.function.name;
        }
        if (fragment.function?.arguments !== undefined) {
          if (typeof fragment.function.arguments !== "string") tool.invalidArguments = true;
          else tool.arguments += fragment.function.arguments;
        }
        record.tools.set(fragment.index, tool);
      }
    }
  }

  function fragmentToolCalls(record) {
    if (!record.tools.size) return null;
    const tools = [...record.tools.values()].sort((a, b) => a.index - b.index);
    for (let index = 0; index < tools.length; index += 1) {
      if (tools[index].index !== index) {
        throw fail(
          "ARCANE_AI_TOOL_CALL_INVALID",
          "The streamed structural tool calls omitted an ordered call index.",
        );
      }
    }
    return tools.map((tool) => {
      if (tool.invalidArguments || tool.invalidIdentity) {
        throw fail(
          "ARCANE_AI_TOOL_CALL_INVALID",
          "A streamed structural tool call changed or omitted an exact field.",
        );
      }
      return {
        id: tool.id,
        type: tool.type,
        function: { name: tool.name, arguments: tool.arguments },
      };
    });
  }

  function result() {
    const completion = {
      ...base,
      object: "chat.completion",
      choices: [...choices.values()].sort((a, b) => a.index - b.index).map((record) => {
        const message = {
          ...record.messageMetadata,
          role: record.role,
          content: record.sawContent ? record.content : null,
        };
        if (record.sawReasoning) message.reasoning_content = record.reasoning;
        if (record.sawReasoningText) message.reasoning = record.reasoningText;
        const fragmentCalls = fragmentToolCalls(record);
        if (
          record.completeToolCalls
          && fragmentCalls
          && !sameCanonicalToolCalls(fragmentCalls, record.completeToolCalls)
        ) {
          throw fail(
            "ARCANE_AI_TOOL_CALL_INVALID",
            "The streamed structural tool calls do not match the terminal message.",
          );
        }
        if (record.completeToolCalls) {
          message.tool_calls = record.completeToolCalls;
        } else if (fragmentCalls) {
          message.tool_calls = fragmentCalls;
        }
        return {
          ...record.choiceMetadata,
          index: record.index,
          message,
          finish_reason: record.finish_reason,
        };
      }),
    };
    return validateCompletion(completion, requestId);
  }

  function hasToolCalls() {
    return [...choices.values()].some(
      (record) => record.completeToolCalls !== null || record.tools.size > 0,
    );
  }

  function correlateToolCalls(completion) {
    for (const record of choices.values()) {
      const fragmentCalls = fragmentToolCalls(record);
      if (record.completeToolCalls === null && fragmentCalls === null) continue;
      const terminalCalls = completionToolCallsAt(completion, record.index);
      if (
        record.completeToolCalls !== null
        && !sameCompleteStreamValue(record.completeToolCalls, terminalCalls)
      ) {
        throw fail(
          "ARCANE_AI_TOOL_CALL_INVALID",
          "The v1 provider stream changed or omitted its terminal structural tool calls.",
        );
      }
      if (
        fragmentCalls !== null
        && (!Array.isArray(terminalCalls) || !sameCanonicalToolCalls(fragmentCalls, terminalCalls))
      ) {
        throw fail(
          "ARCANE_AI_TOOL_CALL_INVALID",
          "The v1 provider stream changed or omitted its terminal structural tool calls.",
        );
      }
    }
  }

  return completeValue({ push, result, hasToolCalls, correlateToolCalls });
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
    const chunk = request.id === undefined || !plainStructuralRecord(value)
      ? value
      : { ...value, id: request.id };
    accumulator.push(chunk);
    const publicChunk = projectPublicStreamChunk(chunk);
    if (publicChunk === OMITTED_PUBLIC_STREAM_DATA) return;
    const waiter = waiters.shift();
    if (waiter) waiter.resolve({ value: publicChunk, done: false });
    else chunks.push(publicChunk);
  }

  function finish(error = null) {
    ended = true;
    terminalError = error;
    while (waiters.length && chunks.length) {
      waiters.shift().resolve({ value: chunks.shift(), done: false });
    }
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
      if (chunks.length) return { value: chunks.shift(), done: false };
      if (terminalError) throw terminalError;
      throwIfAborted(linked.controller.signal);
      if (ended) return { value: undefined, done: true };
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    async return(value) {
      Promise.resolve().then(() => this.cancel(
        "The stream consumer stopped before completion.",
      )).catch(function reportBrowserWasmStreamReturnCancellationFailure(error) {
        console.error("Arcane browser-WASM stream early-return cancellation failed.", error);
      });
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
  return completeValue(handle);
}

function validatedV1StreamHandle(opened, request) {
  if (
    !opened
    || typeof opened !== "object"
    || typeof opened[Symbol.asyncIterator] !== "function"
    || typeof opened.cancel !== "function"
    || !opened.result
    || typeof opened.result.then !== "function"
  ) {
    if (typeof opened?.cancel === "function") {
      Promise.resolve().then(function cancelInvalidV1StreamHandle() {
        return opened.cancel("The v1 provider returned an invalid stream handle.");
      }).catch(function reportInvalidV1StreamCleanupFailure(error) {
        console.error("Arcane invalid v1 stream cleanup failed.", error);
      });
    }
    throw fail(
      "ARCANE_AI_INVALID_PROVIDER_RESULT",
      "The browser-WASM adapter stream must expose an async iterator, result, and cancel().",
    );
  }
  let iterator;
  try {
    iterator = opened[Symbol.asyncIterator]();
  } catch (error) {
    Promise.resolve().then(function cancelRejectedV1Iterator() {
      return opened.cancel(error);
    }).catch(function reportRejectedV1IteratorCleanupFailure(cleanupError) {
      console.error("Arcane rejected v1 stream iterator cleanup failed.", cleanupError);
    });
    throw error;
  }
  if (!iterator || typeof iterator.next !== "function") {
    Promise.resolve().then(function cancelInvalidV1Iterator() {
      return opened.cancel("The v1 provider returned an invalid stream iterator.");
    }).catch(function reportInvalidV1IteratorCleanupFailure(error) {
      console.error("Arcane invalid v1 stream iterator cleanup failed.", error);
    });
    throw fail(
      "ARCANE_AI_INVALID_PROVIDER_RESULT",
      "The browser-WASM adapter stream iterator has no next() method.",
    );
  }
  const accumulator = createCompletionAccumulator(request.model ?? null, request.id);
  const publicChunks = [];
  const publicChunkWaiters = [];
  let publicStreamSettled = false;
  let publicStreamError = null;

  function publishPublicChunk(value) {
    if (publicStreamSettled) return;
    const waiter = publicChunkWaiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else publicChunks.push(value);
  }

  function settlePublicStream(error = null) {
    if (publicStreamSettled) return;
    publicStreamSettled = true;
    publicStreamError = error;
    while (publicChunkWaiters.length && publicChunks.length) {
      publicChunkWaiters.shift().resolve({ value: publicChunks.shift(), done: false });
    }
    while (publicChunkWaiters.length) {
      const waiter = publicChunkWaiters.shift();
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  const privateStreamPump = (async function pumpValidatedV1Stream() {
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          settlePublicStream();
          return true;
        }
        accumulator.push(next.value);
        const projected = projectPublicStreamChunk(next.value);
        if (projected !== OMITTED_PUBLIC_STREAM_DATA) publishPublicChunk(projected);
      }
    } catch (error) {
      settlePublicStream(error);
      throw error;
    }
  })();
  privateStreamPump.catch(function retainV1PrivateStreamRejection() {});

  const terminalResult = Promise.resolve(opened.result).then(
    function validateV1StreamTerminal(value) {
      return validateCompletion(value, request.id);
    },
  );
  terminalResult.catch(function retainV1StreamTerminalRejection() {});
  const result = Promise.all([terminalResult, privateStreamPump]).then(
    function correlateV1StreamTerminal([terminal]) {
      accumulator.correlateToolCalls(terminal);
      return terminal;
    },
  );
  result.catch(function retainV1StreamTerminalRejection() {});
  const handle = {
    result,
    cancel: function cancelValidatedV1Stream(reason) {
      return opened.cancel(reason);
    },
    async next() {
      if (publicChunks.length) return { value: publicChunks.shift(), done: false };
      if (publicStreamError) throw publicStreamError;
      if (publicStreamSettled) return { value: undefined, done: true };
      return new Promise(function waitForProjectedV1StreamChunk(resolve, reject) {
        publicChunkWaiters.push({ resolve, reject });
      });
    },
    async return(value) {
      if (typeof iterator.return === "function") {
        Promise.resolve().then(function returnUnderlyingV1Stream() {
          return iterator.return(value);
        }).catch(function reportUnderlyingV1StreamReturnFailure(error) {
          console.error("Arcane v1 stream iterator return failed.", error);
        });
      }
      Promise.resolve().then(function cancelReturnedV1Stream() {
        return opened.cancel("The stream consumer stopped before completion.");
      }).catch(function reportReturnedV1StreamCancellationFailure(error) {
        console.error("Arcane v1 stream early-return cancellation failed.", error);
      });
      return { value, done: true };
    },
    async throw(error) {
      await opened.cancel(error);
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return completeValue(handle);
}

function positiveLoadInteger(value, field, fallback) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${field} must be a positive safe integer.`);
  }
  return resolved;
}

function optionalLoadBoolean(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean when provided.`);
  return value;
}

function optionalLoadText(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${field} must be a string when provided.`);
  return value;
}

function optionalTemplateDefaults(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("templateDefaults must be a plain object when provided.");
  }
  return { ...value };
}

function measuredRuntimeCapabilities(runtimeCapabilities) {
  const measuredDeviceMemory = Number(globalThis.navigator?.deviceMemory);
  const deviceMemory = Number.isFinite(measuredDeviceMemory) && measuredDeviceMemory > 0
    ? measuredDeviceMemory
    : null;
  return completeValue({ ...runtimeCapabilities, deviceMemory });
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
  );
  const contextTokens = positiveLoadInteger(
    configured.contextTokens,
    "contextTokens",
    defaultContext,
  );
  const batchTokens = positiveLoadInteger(
    configured.batchTokens,
    "batchTokens",
    Math.min(defaultBatch, contextTokens),
  );
  const microBatchTokens = positiveLoadInteger(
    configured.microBatchTokens,
    "microBatchTokens",
    Math.min(defaultMicroBatch, batchTokens),
  );
  const reasoning = optionalLoadBoolean(configured.reasoning, "reasoning");
  const chatTemplate = optionalLoadText(configured.chatTemplate, "chatTemplate");
  const jinja = optionalLoadBoolean(configured.jinja, "jinja");
  const templateDefaults = optionalTemplateDefaults(configured.templateDefaults);
  return completeValue({
    threads,
    contextTokens,
    batchTokens,
    microBatchTokens,
    gpuLayers: 99_999,
    ...(reasoning!==undefined?{ reasoning }:{}),
    ...(chatTemplate!==undefined?{ chatTemplate }:{}),
    ...(jinja!==undefined?{ jinja }:{}),
    ...(templateDefaults!==undefined?{ templateDefaults }:{}),
  });
}

function sameLoadPlan(left, right) {
  return left?.threads === right?.threads
    && left?.contextTokens === right?.contextTokens
    && left?.batchTokens === right?.batchTokens
    && left?.microBatchTokens === right?.microBatchTokens
    && left?.gpuLayers === right?.gpuLayers
    && left?.reasoning === right?.reasoning
    && left?.chatTemplate === right?.chatTemplate
    && left?.jinja === right?.jinja
    && JSON.stringify(left?.templateDefaults) === JSON.stringify(right?.templateDefaults);
}

function stableModelFailure(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  const message = typeof error?.message === "string" ? error.message : "";
  if (code === "ARCANE_AI_MODEL_SHARD_TOO_LARGE") {
    return completeValue({ code });
  }
  if (/(?:out of memory|allocation failed|failed to allocate|memory exhausted)/iu.test(message)) {
    return completeValue({ code: "ARCANE_AI_MODEL_GPU_MEMORY_INSUFFICIENT" });
  }
  if (code === "ARCANE_AI_WEBGPU_EVIDENCE_INVALID") {
    return completeValue({ code: "ARCANE_AI_MODEL_FULL_OFFLOAD_UNPROVEN" });
  }
  if (code === "ARCANE_AI_WEBGPU_REQUIRED" && /(?:offload|GPU|WebGPU)/iu.test(message)) {
    return completeValue({ code: "ARCANE_AI_MODEL_WEBGPU_REQUIREMENT_FAILED" });
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
  const add = (code, compatibility, details = {}) => reasons.push(completeValue({
    code,
    compatibility,
    details: completeValue(details),
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
  if (failure) {
    add(failure.code, "incompatible");
  }
  if (storage?.compatibility === "incompatible") {
    add(storage.code, "incompatible");
  } else if (!storage || storage.compatibility === "unknown") {
    add(storage?.code ?? "ARCANE_AI_STORAGE_NOT_MEASURED", "unknown");
  }
  const webgpu = runtimeEvidence?.webgpu;
  if (state === "ready" && webgpu?.observed === true) {
    add(
      "ARCANE_AI_WEBGPU_EXECUTION_OBSERVED",
      "compatible",
      {},
    );
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
  return completeValue({
    protocol: CAPABILITY_POLICY_PROTOCOL,
    compatibility,
    reasons: completeValue(reasons),
    model: completeValue({ id: source.id }),
    load: loadPlan,
    storage: storage ?? null,
    inputs: completeValue({
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
  return completeValue({
    sources: completeValue(list.slice()),
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
  let errorState = null;
  let cacheState = "unknown";
  let activeSecurity = null;
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
    return completeValue({
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
    return completeValue(modelSources.map((candidate) => {
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
      return completeValue({
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
    const publicSecurity = securitySnapshot(effectiveSecurity);
    return completeValue({
      protocol: ARCANE_AI_ADAPTER_PROTOCOL,
      provider: "arcane-browser-wasm-wllama",
      state,
      loaded: state === "ready" && runtime.isLoaded(),
      busy: activeCount > 0,
      queued: Math.max(0, queueDepth - activeCount),
      model: publicDescriptor(activeSource),
      cache: completeValue({ state: cacheState }),
      ...(publicSecurity ? { security: publicSecurity } : {}),
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
    errorState = state === "error"
      ? completeValue({
        code: typeof error?.code === "string" ? error.code : "ARCANE_AI_RUNTIME_FAILED",
        message: typeof error?.message === "string"
          ? error.message
          : "The browser-WASM runtime failed.",
      })
      : null;
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
    const requestedLoadPlan = capabilityLoadPlan(
      measuredRuntimeCapabilities(runtime.capabilities()),
      runtimeLoadDefaults,
      options,
    );
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
      activeSecurity = effectiveSecurity;
      return completeValue({ model: publicDescriptor(activeSource), status: status() });
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
      activeSecurity = effectiveSecurity;
      return loadPromise;
    }
    if (
      options.onProgress !== undefined
      && options.onProgress !== null
      && typeof options.onProgress !== "function"
    ) {
      throw new TypeError("Browser-WASM load onProgress must be a function or null.");
    }
    const externalSignal = options.signal ?? context.signal ?? null;
    const linked = linkAbortSignal(externalSignal);
    const signal = linked.controller.signal;
    const generation = ++lifecycleGeneration;
    const reportProgress = typeof context.reportProgress === "function"
      ? context.reportProgress
      : options.onProgress ?? null;
    const progressStartedAt = Date.now();
    let currentProgress = null;
    let progressHeartbeat = null;

    function publishModelLoadProgress(progress) {
      if (!reportProgress) return;
      currentProgress = { ...progress, heartbeat: false };
      reportProgress(completeValue({
        ...currentProgress,
        elapsedMs: Math.max(0, Date.now() - progressStartedAt),
      }));
    }

    function publishModelLoadHeartbeat() {
      if (!reportProgress || !currentProgress) return;
      reportProgress(completeValue({
        ...currentProgress,
        heartbeat: true,
        elapsedMs: Math.max(0, Date.now() - progressStartedAt),
      }));
    }

    loadAbort = linked.controller;
    activeSource = requestedSource;
    activeSecurity = effectiveSecurity;
    activeLoadPlan = requestedLoadPlan;
    state = "loading";
    errorState = null;
    if (reportProgress) {
      progressHeartbeat = globalThis.setInterval(
        publishModelLoadHeartbeat,
        MODEL_LOAD_HEARTBEAT_MS,
      );
    }
    loadPromise = (async () => {
      try {
        throwIfAborted(signal, "load");
        const admitted = await store.ensure(activeSource, {
          signal,
          offline: options.offline === true,
          onCapabilityPolicy: (value) => { storagePolicies.set(activeSource.id, value); },
          onProgress: publishModelLoadProgress,
        });
        cacheState = admitted.cache;
        throwIfAborted(signal, "load");
        if (generation !== lifecycleGeneration || state !== "loading") {
          throw fail("ARCANE_AI_OPERATION_SUPERSEDED", "The model load was superseded by unload.");
        }
        throwIfAborted(signal, "load");
        if (generation !== lifecycleGeneration || state !== "loading") {
          throw fail("ARCANE_AI_OPERATION_SUPERSEDED", "The model load was superseded by unload.");
        }
        const members = sourceMetadata(activeSource).files;
        publishModelLoadProgress({
          phase: "initialize",
          completed: members.length,
          total: members.length,
          unit: "files",
          heartbeat: false,
        });
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
        modelFailures.delete(activeSource.id);
        return completeValue({ model: publicDescriptor(activeSource), status: status() });
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
          errorState = completeValue({ code: normalized.code, message: normalized.message });
        }
        throw normalized;
      } finally {
        if (progressHeartbeat !== null) {
          globalThis.clearInterval(progressHeartbeat);
          progressHeartbeat = null;
        }
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
      activeAbort = completeValue({
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
        errorState = null;
        activeSecurity = null;
        return status();
      } catch (error) {
        const normalized = normalizeArcaneAIError(error, {
          kind: "llm",
          operation: "unload",
          signal: normalizationSignal(error, signal),
        });
        state = "error";
        errorState = completeValue({ code: normalized.code, message: normalized.message });
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

  return completeValue({
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

  const fallbackCatalog = completeValue([model]);
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
    return completeValue({
      protocol: AI_MODEL_AUTHORITY_PROTOCOL,
      providerId,
      modelId: selectedModel.id,
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
    return completeValue({
      state: disposed ? "disposed" : value.state,
      loaded: disposed ? false : value.loaded,
      busy: disposed ? false : value.busy,
      cache: value.cache,
      ...(value.security?.secure===true?{security:{secure:true}}:{}),
      capabilityPolicy: value.capabilityPolicy,
      compatibility: value.capabilityPolicy?.compatibility ?? "unknown",
    });
  }

  const adapted = completeValue({
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
        return completeValue({
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
        return completeValue({
          available: false,
          code: "ARCANE_AI_PROVIDER_UNAVAILABLE",
          message: `The browser-WASM provider requires ${missing}.`,
        });
      }
      return completeValue({ available: true, authority: authorityFor(selection) });
    },
    status,
    async load({
      role = "llm",
      selection,
      signal = null,
      progress = null,
      security,
      ...loadOptions
    } = {}) {
      assertSelection(selection, role);
      throwIfAborted(signal, "load");
      if (progress !== null && typeof progress !== "function") {
        throw new TypeError("The provider/2 progress sink must be a function or null.");
      }
      await methods.load({
        ...loadOptions,
        modelId: selection.modelId,
        signal,
        onProgress: progress,
        ...(security?.secure===true?{security:{secure:true}}:{}),
      });
      return status();
    },
    request({ role = "llm", selection, operation, payload, signal = null } = {}) {
      assertSelection(selection, role);
      assertActiveSelection(selection);
      throwIfAborted(signal);
      if (operation === "chat") {
        validateStructuralRequest(payload);
        return Promise.resolve(methods.chat(payload, { signal })).then(
          function validateV1ChatTerminal(value) {
            return validateCompletion(value, payload.id);
          },
        );
      }
      if (operation === "stream") {
        validateStructuralRequest(payload);
        return Promise.resolve(methods.stream(payload, { signal })).then(
          function wrapV1StreamResult(opened) {
            return validatedV1StreamHandle(opened, payload);
          },
        );
      }
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

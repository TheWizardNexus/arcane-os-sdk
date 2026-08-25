import {
  ARCANE_AI_ADAPTER_PROTOCOL,
  ArcaneAIError,
  normalizeArcaneAIError,
} from "./model-controller.mjs";
import { createPackagedWllamaRuntime } from "./browser-wllama-runtime.mjs";
import { createStreamingSha256 } from "./internal/sha256.mjs";

const MODEL_MANIFEST_SCHEMA = "arcane.ai.browser-wasm.model.v2";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MUTABLE_PATH_PATTERN = /\/(?:resolve\/)?(?:main|master|latest)(?:\/|$)/iu;
const BROWSER_MODEL_SOURCES = new WeakSet();
const DBOPFS_MODEL_STORES = new WeakSet();

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
  const name = requiredText(value.name, "name");
  if (name !== name.split(/[\\/]/u).pop() || name === "." || name === "..") {
    throw new TypeError("Browser model name must be a single filename.");
  }
  const immutableUrl = immutableHttpsUrl(value.immutableUrl);
  if (!immutableUrl) {
    throw new TypeError("Browser model immutableUrl must be immutable HTTPS without credentials or fragments.");
  }
  const bytes = Number(value.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw new TypeError("Browser model bytes must be a positive safe integer.");
  }
  const sha256 = requiredText(value.sha256, "sha256").toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) {
    throw new TypeError("Browser model sha256 must be exactly 64 lowercase hexadecimal characters.");
  }
  const licenseSpdx = requiredText(value.licenseSpdx, "licenseSpdx");
  const sourceRevision = requiredText(value.sourceRevision, "sourceRevision");
  return Object.freeze({
    id,
    name,
    immutableUrl: immutableUrl.href,
    bytes,
    sha256,
    licenseSpdx,
    sourceRevision,
  });
}

function publicDescriptor(source) {
  return Object.freeze({
    id: source.id,
    name: source.name,
    immutableUrl: source.immutableUrl,
    bytes: source.bytes,
    sha256: source.sha256,
    licenseSpdx: source.licenseSpdx,
    sourceRevision: source.sourceRevision,
  });
}

/**
 * Creates an authenticated browser download authority for one caller-supplied
 * immutable model. Arcane verifies the response bytes; it never trusts an
 * ETag, server digest, mutable model catalog, or URL helper.
 */
export function createBrowserModelSource(descriptor, {
  fetchImpl = null,
} = {}) {
  const model = modelDescriptor(descriptor);

  async function open({ signal } = {}) {
    throwIfAborted(signal, "install");
    const fetchFunction = fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchFunction !== "function") {
      throw fail("ARCANE_AI_MODEL_SOURCE_UNAVAILABLE", "Browser fetch is unavailable.");
    }

    let response;
    try {
      response = await fetchFunction(model.immutableUrl, {
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
      finalUrl = new URL(response.url || model.immutableUrl);
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
    if (header !== null && header !== undefined && header !== "") {
      const reported = Number(header);
      if (!Number.isSafeInteger(reported) || reported !== model.bytes) {
        await response.body.cancel().catch(() => undefined);
        throw fail(
          "ARCANE_AI_MODEL_SIZE_MISMATCH",
          `The model server reported ${String(header)} bytes; expected ${model.bytes}.`,
        );
      }
    }
    return Object.freeze({
      body: response.body,
      requestedUrl: model.immutableUrl,
      finalUrl: finalUrl.href,
      cancel: (reason) => response.body.cancel(reason),
    });
  }

  const source = Object.freeze({
    kind: "arcane-authenticated-browser-model-source",
    ...model,
    descriptor: publicDescriptor(model),
    open,
  });
  BROWSER_MODEL_SOURCES.add(source);
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
  return Object.freeze({
    model: `${safeId}--${source.name}`,
    manifest: `${safeId}.complete.json`,
  });
}

function manifestFor(source, finalUrl) {
  return Object.freeze({
    schema: MODEL_MANIFEST_SCHEMA,
    complete: true,
    model: publicDescriptor(source),
    finalUrl,
    completedAt: new Date().toISOString(),
  });
}

function manifestMatches(manifest, source) {
  const model = manifest?.model;
  return manifest?.schema === MODEL_MANIFEST_SCHEMA
    && manifest?.complete === true
    && model?.id === source.id
    && model?.name === source.name
    && model?.immutableUrl === source.immutableUrl
    && model?.bytes === source.bytes
    && model?.sha256 === source.sha256
    && model?.licenseSpdx === source.licenseSpdx
    && model?.sourceRevision === source.sourceRevision;
}

function progress(source, phase, loaded) {
  return Object.freeze({
    modelId: source.id,
    phase,
    loaded,
    total: source.bytes,
    percent: source.bytes ? (loaded / source.bytes) * 100 : null,
  });
}

/**
 * Adapts an existing Arcane DBOPFS singleton without rebinding or changing any
 * of its public methods. The completion manifest is committed only after the
 * exact model file has been written and hashed.
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

  async function openVerified(source, { signal, onProgress } = {}) {
    const names = storageName(source);
    const manifest = await readManifest(names.manifest);
    if (!manifestMatches(manifest, source)) {
      // A model file without the exact completion manifest is a partial, even
      // when the manifest is missing or malformed rather than merely stale.
      await remove(source);
      return null;
    }
    const modelFile = await file(names.model);
    if (!modelFile || modelFile.size !== source.bytes) {
      await remove(source);
      return null;
    }
    const digest = createStreamingSha256();
    let hashed = 0;
    try {
      for await (const chunk of byteChunks(modelFile, signal)) {
        digest.update(chunk);
        hashed += chunk.byteLength;
        onProgress?.(progress(source, "verify-cache", hashed));
      }
      if (hashed !== source.bytes || digest.digestHex() !== source.sha256) {
        await remove(source);
        return null;
      }
      return Object.freeze({ file: modelFile, manifest });
    } catch (error) {
      if (!signal?.aborted) await remove(source);
      throw error;
    }
  }

  async function install(source, { signal, onProgress } = {}) {
    const names = storageName(source);
    await remove(source);
    const opened = await source.open({ signal });
    const digest = createStreamingSha256();
    try {
      const written = await write(names.model, opened.body, {
        signal,
        async onChunk(chunk, loaded) {
          digest.update(chunk);
          if (loaded > source.bytes) {
            throw fail("ARCANE_AI_MODEL_SIZE_MISMATCH", "Downloaded model exceeded its declared size.");
          }
          onProgress?.(progress(source, "download", loaded));
        },
      });
      const actualSha256 = digest.digestHex();
      if (written !== source.bytes || actualSha256 !== source.sha256) {
        throw fail(
          actualSha256 === source.sha256
            ? "ARCANE_AI_MODEL_SIZE_MISMATCH"
            : "ARCANE_AI_MODEL_DIGEST_MISMATCH",
          "Downloaded model bytes did not match the caller-supplied authority.",
        );
      }
      // Completion is the final storage mutation. A file without this exact
      // manifest is never admitted for inference or offline reuse.
      const manifest = manifestFor(source, opened.finalUrl);
      const encoded = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
      await write(names.manifest, encoded, { signal });
      const admitted = await openVerified(source, { signal, onProgress });
      if (!admitted) throw fail("ARCANE_AI_MODEL_CACHE_REJECTED", "The completed model cache failed revalidation.");
      return admitted;
    } catch (error) {
      await opened.cancel?.(error).catch(() => undefined);
      await remove(source).catch(() => undefined);
      throw error;
    }
  }

  async function ensure(source, { signal, onProgress, offline = false } = {}) {
    const cached = await openVerified(source, { signal, onProgress });
    if (cached) return Object.freeze({ ...cached, cache: "verified" });
    if (offline) {
      throw fail("ARCANE_AI_MODEL_OFFLINE_MISS", "No verified offline model cache is available.");
    }
    const installed = await install(source, { signal, onProgress });
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
    const chunk = request.id === undefined ? value : { ...value, id: request.id };
    accumulator.push(chunk);
    const waiter = waiters.shift();
    if (waiter) waiter.resolve({ value: chunk, done: false });
    else chunks.push(chunk);
  }

  function finish(error = null) {
    ended = true;
    terminalError = error;
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
  const result = Promise.resolve(terminal).then(
    () => {
      const value = accumulator.result();
      finish();
      return value;
    },
    (error) => {
      const normalized = normalizeArcaneAIError(error, {
        kind: "llm",
        operation: "request",
        signal: linked.controller.signal,
      });
      finish(normalized);
      throw normalized;
    },
  ).finally(() => {
    linked.release();
    onSettled();
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
  logger = console,
} = {}) {
  if (!BROWSER_MODEL_SOURCES.has(source)) {
    throw new TypeError("createBrowserWasmLlmProvider requires createBrowserModelSource().");
  }
  if (!DBOPFS_MODEL_STORES.has(store)) {
    throw new TypeError("createBrowserWasmLlmProvider requires createDbopfsModelStore().");
  }

  const runtime = createPackagedWllamaRuntime({ logger });
  let state = "unloaded";
  let progressState = null;
  let errorState = null;
  let cacheState = "unknown";
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
      crossOriginIsolated: runtimeCapabilities.crossOriginIsolated,
      secureContext: runtimeCapabilities.secureContext,
      hardwareConcurrency: runtimeCapabilities.hardwareConcurrency,
    });
  }

  function status() {
    return Object.freeze({
      protocol: ARCANE_AI_ADAPTER_PROTOCOL,
      provider: "arcane-browser-wasm-wllama",
      state,
      loaded: state === "ready" && runtime.isLoaded(),
      busy: activeCount > 0,
      queued: Math.max(0, queueDepth - activeCount),
      model: publicDescriptor(source),
      cache: Object.freeze({ state: cacheState, schema: MODEL_MANIFEST_SCHEMA }),
      progress: progressState,
      error: errorState,
      runtime: runtime.authority,
      capabilities: capabilities(),
      origin: globalThis.location?.origin ?? null,
    });
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
    if (state === "ready") return Object.freeze({ model: publicDescriptor(source), status: status() });
    if (loadPromise) return loadPromise;
    const externalSignal = options.signal ?? context.signal ?? null;
    const linked = linkAbortSignal(externalSignal);
    const signal = linked.controller.signal;
    const generation = ++lifecycleGeneration;
    loadAbort = linked.controller;
    state = "loading";
    progressState = null;
    errorState = null;
    loadPromise = (async () => {
      try {
        throwIfAborted(signal, "load");
        const admitted = await store.ensure(source, {
          signal,
          offline: options.offline === true,
          onProgress: (value) => report(value, options, context),
        });
        cacheState = admitted.cache;
        throwIfAborted(signal, "load");
        if (generation !== lifecycleGeneration || state !== "loading") {
          throw fail("ARCANE_AI_OPERATION_SUPERSEDED", "The model load was superseded by unload.");
        }
        report(progress(source, "initialize", source.bytes), options, context);
        throwIfAborted(signal, "load");
        if (generation !== lifecycleGeneration || state !== "loading") {
          throw fail("ARCANE_AI_OPERATION_SUPERSEDED", "The model load was superseded by unload.");
        }
        const modelFile = typeof globalThis.File === "function"
          ? new File([admitted.file], source.name, { type: "application/octet-stream" })
          : admitted.file;
        await runtime.load([modelFile], {
          ...loadDefaults,
          ...options,
          signal,
        });
        throwIfAborted(signal, "load");
        if (generation !== lifecycleGeneration || state !== "loading") {
          await runtime.exit();
          throw fail("ARCANE_AI_OPERATION_SUPERSEDED", "The model load was superseded by unload.");
        }
        state = "ready";
        progressState = null;
        return Object.freeze({ model: publicDescriptor(source), status: status() });
      } catch (error) {
        await runtime.exit().catch(() => undefined);
        const normalized = normalizeArcaneAIError(error, {
          kind: "llm",
          operation: "load",
          signal,
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
        throw normalizeArcaneAIError(error, {
          kind: "llm",
          operation: "request",
          signal: linked.controller.signal,
        });
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
        onSettled() {
          if (settled) return;
          settled = true;
          activeCount -= 1;
          activeAbort = null;
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
        return status();
      } catch (error) {
        const normalized = normalizeArcaneAIError(error, {
          kind: "llm",
          operation: "unload",
          signal,
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

export { MODEL_MANIFEST_SCHEMA };

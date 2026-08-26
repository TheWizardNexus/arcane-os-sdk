import { createStreamingSha256 } from "./internal/sha256.mjs";
import {
  normalizeModelSecurity,
  resolveModelSecurity,
} from "./model-controller.mjs";

export const BROWSER_SPEECH_ARTIFACT_PROTOCOL =
  "arcane-ai-browser-speech-artifacts/1";

const MODEL_AUTHORITY_PROTOCOL = "arcane-ai-model-authority/1";
const MANIFEST_SCHEMA = "arcane.ai.browser-speech.assets.v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MUTABLE_PATH_PATTERN = /\/(?:resolve\/)?(?:main|master|latest)(?:\/|$)/iu;
const AUTHORITIES = new WeakSet();
const AUTHORITY_METADATA = new WeakMap();
const STORES = new WeakSet();

function speechError(code, message, cause) {
  const error = cause === undefined
    ? new Error(message)
    : new Error(message, { cause });
  error.name = "ArcaneBrowserSpeechError";
  error.code = code;
  return error;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = speechError(
    "ARCANE_AI_REQUEST_ABORTED",
    "The browser speech operation was cancelled.",
    signal.reason,
  );
  error.name = "AbortError";
  throw error;
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value.trim();
}

function identifier(value, label) {
  const result = requiredText(value, label);
  if (result.length > 128) {
    throw new TypeError(`${label} must not exceed 128 characters.`);
  }
  return result;
}

function immutableUrl(value, label) {
  let result;
  try {
    result = new URL(value, globalThis.location?.href);
  } catch {
    throw new TypeError(`${label} must be an absolute or same-origin URL.`);
  }
  const sameOrigin = globalThis.location?.origin
    && result.origin === globalThis.location.origin;
  if (
    (result.protocol !== "https:" && !sameOrigin)
    || result.username
    || result.password
    || result.hash
    || MUTABLE_PATH_PATTERN.test(result.pathname)
  ) {
    throw new TypeError(
      `${label} must be immutable HTTPS or a same-origin immutable URL without credentials or fragments.`,
    );
  }
  return result.href;
}

function normalizeFile(value, kind, index, revision) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${kind} file ${String(index)} must be an object.`);
  }
  const path = requiredText(value.path ?? value.name, `${kind} file path`);
  if (
    path.startsWith("/")
    || path.includes("\\")
    || path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError(`${kind} file path must be a normalized relative path.`);
  }
  const url = immutableUrl(value.url, `${kind} file url`);
  let bytes = null;
  if (value.bytes !== undefined) {
    if (!Number.isSafeInteger(value.bytes) || value.bytes < 1) {
      throw new TypeError(`${kind} file bytes must be a positive safe integer.`);
    }
    bytes = value.bytes;
  }
  let sha256 = null;
  if (value.sha256 !== undefined) {
    sha256 = requiredText(value.sha256, `${kind} file sha256`).toLowerCase();
    if (!SHA256_PATTERN.test(sha256)) {
      throw new TypeError(`${kind} file sha256 must be 64 lowercase hexadecimal characters.`);
    }
  }
  const identityUrl = url.toLowerCase();
  if (
    !identityUrl.includes(revision.toLowerCase())
    && (sha256 === null || !identityUrl.includes(sha256))
  ) {
    throw new TypeError(
      `${kind} file URL must contain its caller-supplied revision or SHA-256 identity.`,
    );
  }
  return Object.freeze({
    kind,
    index,
    path,
    url,
    bytes,
    sha256,
    mediaType: typeof value.mediaType === "string" && value.mediaType.trim()
      ? value.mediaType.trim()
      : kind === "runtime" && /\.(?:m?js)$/iu.test(path)
        ? "text/javascript"
        : "application/octet-stream",
  });
}

function uniqueFiles(files, label, kind, revision) {
  if (!Array.isArray(files) || files.length < 1) {
    throw new TypeError(`${label} requires a nonempty files array.`);
  }
  const paths = new Set();
  const urls = new Set();
  return Object.freeze(files.map((value, index) => {
    const file = normalizeFile(value, kind, index, revision);
    if (paths.has(file.path) || urls.has(file.url)) {
      throw new TypeError(`${label} file paths and URLs must be unique.`);
    }
    paths.add(file.path);
    urls.add(file.url);
    return file;
  }));
}

function publicFile(file) {
  const result = {
    path: file.path,
    url: file.url,
    mediaType: file.mediaType,
  };
  if (file.bytes !== null) result.bytes = file.bytes;
  if (file.sha256 !== null) result.sha256 = file.sha256;
  return Object.freeze(result);
}

/**
 * Admits one caller-owned browser speech model/runtime description. The SDK
 * supplies no model URL or profile; applications choose every immutable byte.
 */
export function createBrowserSpeechAuthority({
  providerId,
  role,
  model,
  runtime,
  security,
} = {}) {
  const normalizedProviderId = identifier(providerId, "Browser speech providerId");
  if (role !== "stt" && role !== "tts") {
    throw new TypeError('Browser speech role must be "stt" or "tts".');
  }
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    throw new TypeError("Browser speech model descriptor is required.");
  }
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new TypeError("Browser speech runtime descriptor is required.");
  }
  const normalizedSecurity = normalizeModelSecurity(
    security,
    "Browser speech provider security",
  );
  const modelId = identifier(model.id, "Browser speech model id");
  const modelRevision = identifier(model.revision, "Browser speech model revision");
  const repository = identifier(model.repository, "Browser speech model repository");
  const modelFiles = uniqueFiles(
    model.files,
    "Browser speech model",
    "model",
    modelRevision,
  );
  const runtimeAdapter = requiredText(runtime.adapter, "Browser speech runtime adapter");
  const expectedAdapter = role === "stt"
    ? "transformers-whisper"
    : "kokoro-js";
  if (runtimeAdapter !== expectedAdapter) {
    throw new TypeError(`Browser ${role} runtime adapter must equal ${expectedAdapter}.`);
  }
  const runtimeVersion = identifier(runtime.version, "Browser speech runtime version");
  const runtimeRevision = identifier(runtime.revision, "Browser speech runtime revision");
  const runtimeFiles = uniqueFiles(
    runtime.files,
    "Browser speech runtime",
    "runtime",
    runtimeRevision,
  );
  const entry = requiredText(runtime.entry, "Browser speech runtime entry");
  const entryFile = runtimeFiles.find((file) => file.path === entry);
  if (!entryFile) {
    throw new TypeError("Browser speech runtime entry must name one runtime file path.");
  }
  if (!/\.(?:m?js)$/iu.test(entryFile.path) || entryFile.mediaType !== "text/javascript") {
    throw new TypeError("Browser speech runtime entry must be a JavaScript module.");
  }
  const normalizedModel = Object.freeze({
    id: modelId,
    repository,
    revision: modelRevision,
    defaultVoice: role === "tts"
      ? identifier(model.defaultVoice, "Browser Kokoro defaultVoice")
      : null,
    files: modelFiles,
  });
  const normalizedRuntime = Object.freeze({
    adapter: runtimeAdapter,
    version: runtimeVersion,
    revision: runtimeRevision,
    entry,
    files: runtimeFiles,
  });
  const files = Object.freeze([...runtimeFiles, ...modelFiles]);
  const allPaths = new Set();
  const allUrls = new Set();
  for (const file of files) {
    if (allPaths.has(file.path) || allUrls.has(file.url)) {
      throw new TypeError("Browser speech runtime and model file identities must not overlap.");
    }
    allPaths.add(file.path);
    allUrls.add(file.url);
  }
  const authority = Object.freeze({
    protocol: MODEL_AUTHORITY_PROTOCOL,
    providerId: normalizedProviderId,
    modelId,
    admitted: true,
    role,
    repository,
    revision: modelRevision,
    defaultVoice: normalizedModel.defaultVoice,
    runtime: Object.freeze({
      adapter: normalizedRuntime.adapter,
      version: normalizedRuntime.version,
      revision: normalizedRuntime.revision,
      entry: normalizedRuntime.entry,
      files: Object.freeze(runtimeFiles.map(publicFile)),
    }),
    files: Object.freeze(modelFiles.map(publicFile)),
    security: normalizedSecurity,
  });
  AUTHORITIES.add(authority);
  AUTHORITY_METADATA.set(authority, Object.freeze({
    model: normalizedModel,
    runtime: normalizedRuntime,
    files,
  }));
  return authority;
}

function authorityProjection(authority) {
  return Object.freeze({
    protocol: authority.protocol,
    providerId: authority.providerId,
    modelId: authority.modelId,
    role: authority.role,
    repository: authority.repository,
    revision: authority.revision,
    runtime: authority.runtime,
    files: authority.files,
  });
}

function storageKey(authority) {
  const digest = createStreamingSha256();
  digest.update(new TextEncoder().encode(JSON.stringify(authorityProjection(authority))));
  return digest.digestHex();
}

function storageNames(authority, files) {
  const prefix = `arcane-speech-${storageKey(authority)}`;
  return Object.freeze({
    key: prefix,
    manifest: `${prefix}.complete.json`,
    files: Object.freeze(files.map((_, index) =>
      `${prefix}.${String(index).padStart(4, "0")}.artifact`)),
  });
}

function manifestMatches(manifest, authority, files) {
  return manifest?.schema === MANIFEST_SCHEMA
    && manifest.complete === true
    && JSON.stringify(manifest.authority) === JSON.stringify(authorityProjection(authority))
    && Array.isArray(manifest.files)
    && manifest.files.length === files.length;
}

async function* byteChunks(body, signal) {
  if (body instanceof Uint8Array || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    throwIfAborted(signal);
    yield body instanceof Uint8Array
      ? body
      : new Uint8Array(body.buffer ?? body, body.byteOffset ?? 0, body.byteLength);
    return;
  }
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const abort = () => void reader.cancel(signal?.reason).catch(() => undefined);
    signal?.addEventListener?.("abort", abort, { once: true });
    try {
      while (true) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        if (done) return;
        yield value instanceof Uint8Array ? value : new Uint8Array(value);
      }
    } finally {
      signal?.removeEventListener?.("abort", abort);
      if (signal?.aborted) await reader.cancel(signal.reason).catch(() => undefined);
      reader.releaseLock?.();
    }
  }
  throw speechError(
    "ARCANE_AI_ARTIFACT_SOURCE_INVALID",
    "A browser speech artifact did not provide readable bytes.",
  );
}

function providerProgress(phase, completed, total, heartbeat = false) {
  return Object.freeze({ phase, completed, total, unit: "bytes", heartbeat });
}

// Runtime entry bytes use one deliberately closed capability grammar. The only
// module reference is import.meta and the only artifact transport is fetch(),
// which the Worker replaces with its admitted object-URL map before import.
// Executable strings, child execution contexts, script loaders, and alternate
// network transports are outside the grammar. Literal escape sequences are
// decoded before the same capability tokens are evaluated.
const CLOSED_MODULE_OUT_OF_GRAMMAR_IDENTIFIERS = new Set([
  "AsyncFunction",
  "AsyncGeneratorFunction",
  "EventSource",
  "Function",
  "GeneratorFunction",
  "RTCPeerConnection",
  "SharedWorker",
  "WebSocket",
  "WebTransport",
  "Worker",
  "XMLHttpRequest",
  "eval",
  "importScripts",
]);
const CLOSED_MODULE_OUT_OF_GRAMMAR_LITERAL =
  /(?:^|[^A-Za-z0-9_$])(?:AsyncFunction|AsyncGeneratorFunction|EventSource|Function|GeneratorFunction|RTCPeerConnection|SharedWorker|WebSocket|WebTransport|Worker|XMLHttpRequest|constructor|eval|importScripts)(?:$|[^A-Za-z0-9_$])|(?:^|[^A-Za-z0-9_$])import\s*\(/u;

function assertSelfContainedModuleSource(source, label) {
  let index = 0;
  let nextTemplateId = 1;
  const templateStack = [];
  const literalFragments = [];

  function fail() {
    throw speechError(
      "ARCANE_AI_RUNTIME_MODULE_GRAPH_UNDECLARED",
      `${label} must be one self-contained JavaScript module without imports or re-exports.`,
    );
  }

  function identifierStart(character) {
    return /[A-Za-z_$]/u.test(character ?? "");
  }

  function identifierPart(character) {
    return /[A-Za-z0-9_$]/u.test(character ?? "");
  }

  function assertLiteral(value) {
    if (CLOSED_MODULE_OUT_OF_GRAMMAR_LITERAL.test(value)) fail();
  }

  function assertComputedLiteral(value) {
    if (value.includes("constructor") || /import\s*\(/u.test(value)) fail();
    for (const identifier of CLOSED_MODULE_OUT_OF_GRAMMAR_IDENTIFIERS) {
      if (value.includes(identifier)) fail();
    }
  }

  function recordLiteral(start, end, value) {
    assertLiteral(value);
    literalFragments.push(Object.freeze({
      start,
      end,
      value,
      templateIds: Object.freeze([...templateStack]),
    }));
  }

  function stripJoinerTrivia(value) {
    return value
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/\/\/[^\r\n]*(?:\r?\n|$)/gu, "")
      .replace(/\s+/gu, "");
  }

  function sharesTemplate(left, right) {
    return left.templateIds.some((id) => right.templateIds.includes(id));
  }

  function staticallyJoins(left, right) {
    const separator = stripJoinerTrivia(source.slice(left.end, right.start));
    const usesConcat = separator.includes(".concat");
    const withoutConcat = separator.replace(/\.concat/gu, "");
    const usesPlus = withoutConcat.includes("+");
    const usesTemplate = sharesTemplate(left, right)
      && (withoutConcat.includes("${") || withoutConcat.includes("}"));
    if (!usesConcat && !usesPlus && !usesTemplate) return false;
    return (usesTemplate ? /^[+()${}]*$/u : /^[+()]*$/u).test(withoutConcat);
  }

  function assertStaticLiteralChains() {
    let chain = [];
    function flushChain() {
      if (chain.length > 1) {
        assertComputedLiteral(chain.map((fragment) => fragment.value).join(""));
      }
      chain = [];
    }
    for (const fragment of literalFragments) {
      const previous = chain[chain.length - 1];
      if (previous && staticallyJoins(previous, fragment)) {
        chain.push(fragment);
        continue;
      }
      flushChain();
      chain.push(fragment);
    }
    flushChain();
  }

  function readEscape() {
    if (index >= source.length) fail();
    const character = source[index];
    index += 1;
    if (character === "x") {
      const hex = source.slice(index, index + 2);
      if (!/^[a-f0-9]{2}$/iu.test(hex)) fail();
      index += 2;
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    if (character === "u") {
      if (source[index] === "{") {
        const end = source.indexOf("}", index + 1);
        if (end < 0) fail();
        const hex = source.slice(index + 1, end);
        if (!/^[a-f0-9]{1,6}$/iu.test(hex)) fail();
        const codePoint = Number.parseInt(hex, 16);
        if (codePoint > 0x10ffff) fail();
        index = end + 1;
        return String.fromCodePoint(codePoint);
      }
      const hex = source.slice(index, index + 4);
      if (!/^[a-f0-9]{4}$/iu.test(hex)) fail();
      index += 4;
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    if (character === "\n") return "";
    if (character === "\r") {
      if (source[index] === "\n") index += 1;
      return "";
    }
    return Object.freeze({
      "0": "\0",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
    })[character] ?? character;
  }

  function readQuoted(quote) {
    const start = index;
    let value = "";
    index += 1;
    while (index < source.length) {
      const character = source[index];
      index += 1;
      if (character === "\\") {
        value += readEscape();
        continue;
      }
      if (character === quote) {
        recordLiteral(start, index, value);
        return;
      }
      if (character === "\n" || character === "\r") fail();
      value += character;
    }
    fail();
  }

  function skipRegex() {
    index += 1;
    let inClass = false;
    while (index < source.length) {
      const character = source[index];
      index += 1;
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === "[") inClass = true;
      else if (character === "]") inClass = false;
      else if (character === "/" && !inClass) {
        while (/[A-Za-z]/u.test(source[index] ?? "")) index += 1;
        return;
      } else if (character === "\n" || character === "\r") {
        fail();
      }
    }
    fail();
  }

  function canStartRegex(lastToken) {
    return lastToken === null
      || [
        "(", "[", "{", "=", ":", ",", ";", "!", "?",
        "&&", "||", "=>", "return", "case", "throw",
      ].includes(lastToken);
  }

  function readTemplate() {
    const templateId = nextTemplateId;
    nextTemplateId += 1;
    templateStack.push(templateId);
    let fragmentStart = index;
    let value = "";
    index += 1;
    while (index < source.length) {
      const character = source[index];
      index += 1;
      if (character === "\\") {
        value += readEscape();
        continue;
      }
      if (character === "`") {
        recordLiteral(fragmentStart, index, value);
        templateStack.pop();
        return;
      }
      if (character === "$" && source[index] === "{") {
        recordLiteral(fragmentStart, index - 1, value);
        value = "";
        index += 1;
        scanCode(true);
        fragmentStart = index;
        continue;
      }
      value += character;
    }
    fail();
  }

  function scanCode(stopAtTemplateBrace = false) {
    let nestedBraces = 0;
    let lastToken = null;
    while (index < source.length) {
      const character = source[index];
      const next = source[index + 1];
      if (/\s/u.test(character)) {
        index += 1;
        continue;
      }
      if (character === "/" && next === "/") {
        index += 2;
        while (index < source.length && source[index] !== "\n") index += 1;
        continue;
      }
      if (character === "/" && next === "*") {
        const end = source.indexOf("*/", index + 2);
        if (end < 0) fail();
        index = end + 2;
        continue;
      }
      if (character === "'" || character === '"') {
        if (lastToken === "from") fail();
        readQuoted(character);
        lastToken = "literal";
        continue;
      }
      if (character === "`") {
        if (lastToken === "from") fail();
        readTemplate();
        lastToken = "literal";
        continue;
      }
      if (character === "/" && canStartRegex(lastToken)) {
        skipRegex();
        lastToken = "literal";
        continue;
      }
      if (identifierStart(character)) {
        const start = index;
        index += 1;
        while (identifierPart(source[index])) index += 1;
        const word = source.slice(start, index);
        if (CLOSED_MODULE_OUT_OF_GRAMMAR_IDENTIFIERS.has(word)) fail();
        if (word === "constructor" && lastToken === ".") fail();
        if (word === "import") {
          while (/\s/u.test(source[index] ?? "")) index += 1;
          if (source[index] === "." && source.slice(index + 1, index + 5) === "meta") {
            index += 5;
            lastToken = "import.meta";
            continue;
          }
          fail();
        }
        lastToken = word;
        continue;
      }
      if (character === "\\") fail();
      if (stopAtTemplateBrace && character === "}") {
        if (nestedBraces === 0) {
          index += 1;
          return;
        }
        nestedBraces -= 1;
      } else if (stopAtTemplateBrace && character === "{") {
        nestedBraces += 1;
      }
      const twoCharacters = `${character}${next ?? ""}`;
      if (["&&", "||", "=>"].includes(twoCharacters)) {
        lastToken = twoCharacters;
        index += 2;
      } else {
        lastToken = character;
        index += 1;
      }
    }
    if (stopAtTemplateBrace) fail();
  }

  scanCode();
  assertStaticLiteralChains();
}

async function assertSelfContainedRuntime(admitted, metadata) {
  const javascriptFiles = admitted.files.filter(({ descriptor }) =>
    descriptor.kind === "runtime" && descriptor.mediaType === "text/javascript");
  if (
    javascriptFiles.length !== 1
    || javascriptFiles[0].descriptor.path !== metadata.runtime.entry
  ) {
    throw speechError(
      "ARCANE_AI_RUNTIME_MODULE_GRAPH_UNDECLARED",
      "Browser speech requires exactly one admitted self-contained runtime module.",
    );
  }
  const [{ descriptor, file }] = javascriptFiles;
  assertSelfContainedModuleSource(await file.text(), descriptor.path);
}

function createObjectUrls(files, factory) {
  const create = factory?.create ?? ((blob) => URL.createObjectURL(blob));
  const revoke = factory?.revoke ?? ((url) => URL.revokeObjectURL(url));
  if (typeof create !== "function" || typeof revoke !== "function") {
    throw new TypeError("Browser speech objectUrlFactory requires create() and revoke().");
  }
  const created = [];
  try {
    const materialized = files.map(({ descriptor, file }) => {
      const blob = file.type === descriptor.mediaType
        ? file
        : new Blob([file], { type: descriptor.mediaType });
      const url = create(blob);
      created.push(url);
      return Object.freeze({
        kind: descriptor.kind,
        path: descriptor.path,
        sourceUrl: descriptor.url,
        moduleUrl: url,
        mediaType: descriptor.mediaType,
        bytes: file.size,
      });
    });
    return Object.freeze({
      files: Object.freeze(materialized),
      release() {
        for (const url of created.splice(0).reverse()) {
          try {
            revoke(url);
          } catch {
            // Object URL revocation follows worker termination and is best effort.
          }
        }
      },
    });
  } catch (error) {
    for (const url of created.splice(0).reverse()) {
      try {
        revoke(url);
      } catch {
        // Preserve the materialization error.
      }
    }
    throw error;
  }
}

/**
 * Stores an authority's complete runtime/model closure in an existing DBOPFS
 * table. The completion manifest is always the final mutation.
 */
export function createDbopfsSpeechArtifactStore({
  dbopfs,
  tableName = "arcane_ai_browser_speech",
  fetchImpl = null,
  objectUrlFactory = null,
} = {}) {
  if (!dbopfs || typeof dbopfs.getTableHandle !== "function") {
    throw new TypeError("createDbopfsSpeechArtifactStore requires an existing DBOPFS instance.");
  }
  if (dbopfs.readyPromise !== undefined && typeof dbopfs.readyPromise?.then !== "function") {
    throw new TypeError("The DBOPFS readyPromise must be thenable.");
  }
  const locks = dbopfs.lockManager ?? globalThis.navigator?.locks;
  if (!locks || typeof locks.request !== "function") {
    throw new TypeError(
      "createDbopfsSpeechArtifactStore requires the browser Web Locks API.",
    );
  }
  let tablePromise = null;
  const operationTails = new Map();

  function serializeAuthority(authority, operation) {
    const key = storageKey(authority);
    const previous = operationTails.get(key) ?? Promise.resolve();
    const lockName = `arcane-ai-speech:${encodeURIComponent(tableName)}:${key}`;
    const current = previous.catch(() => undefined).then(() => locks.request(
      lockName,
      { mode: "exclusive", ifAvailable: true },
      (lock) => {
        if (!lock) {
          throw speechError(
            "ARCANE_AI_STORAGE_BUSY",
            "Another browser context is updating this speech artifact authority.",
          );
        }
        return operation();
      },
    ));
    const tail = current.catch(() => undefined);
    operationTails.set(key, tail);
    return current.finally(() => {
      if (operationTails.get(key) === tail) operationTails.delete(key);
    });
  }

  async function table() {
    if (dbopfs.readyPromise) await dbopfs.readyPromise;
    tablePromise ||= Promise.resolve(dbopfs.getTableHandle(tableName));
    const result = await tablePromise;
    if (!result || typeof result.getFileHandle !== "function" || typeof result.removeEntry !== "function") {
      throw speechError("ARCANE_AI_STORAGE_UNAVAILABLE", "DBOPFS did not provide a speech artifact table.");
    }
    return result;
  }

  async function removeEntry(name) {
    try {
      await (await table()).removeEntry(name);
      return true;
    } catch (error) {
      if (error?.name === "NotFoundError" || error?.code === "ENOENT") return false;
      throw speechError("ARCANE_AI_STORAGE_DELETE_FAILED", "Unable to remove a speech artifact.", error);
    }
  }

  async function readFile(name) {
    try {
      const handle = await (await table()).getFileHandle(name, { create: false });
      return await handle.getFile();
    } catch (error) {
      if (error?.name === "NotFoundError" || error?.code === "ENOENT") return null;
      throw speechError("ARCANE_AI_STORAGE_READ_FAILED", "Unable to read a speech artifact.", error);
    }
  }

  async function writeFile(name, body, { signal, onChunk } = {}) {
    const directory = await table();
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    let written = 0;
    try {
      for await (const chunk of byteChunks(body, signal)) {
        await writable.write(chunk);
        written += chunk.byteLength;
        onChunk?.(chunk, written);
      }
      throwIfAborted(signal);
      await writable.close();
      return written;
    } catch (error) {
      await writable.abort?.(error).catch(() => undefined);
      await directory.removeEntry(name).catch(() => undefined);
      throw error;
    }
  }

  async function removeUnlocked(authority) {
    if (!AUTHORITIES.has(authority)) {
      throw new TypeError("Speech artifact removal requires an SDK-created authority.");
    }
    const metadata = AUTHORITY_METADATA.get(authority);
    const names = storageNames(authority, metadata.files);
    const results = await Promise.all([
      removeEntry(names.manifest),
      ...names.files.map(removeEntry),
    ]);
    return results.some(Boolean);
  }

  async function readManifest(name) {
    const file = await readFile(name);
    if (!file) return null;
    try {
      return JSON.parse(await file.text());
    } catch {
      await removeEntry(name);
      return null;
    }
  }

  async function verifyFile(file, descriptor, security, signal, onProgress, phase) {
    if (security.checks.byteLength && file.size !== descriptor.bytes) return false;
    if (!security.checks.sha256) {
      onProgress?.(providerProgress(phase, file.size, file.size));
      return true;
    }
    const digest = createStreamingSha256();
    let completed = 0;
    for await (const chunk of byteChunks(file.stream(), signal)) {
      digest.update(chunk);
      completed += chunk.byteLength;
      onProgress?.(providerProgress(phase, completed, file.size));
    }
    return completed === file.size && digest.digestHex() === descriptor.sha256;
  }

  function assertSecurityDescriptors(files, security) {
    for (const descriptor of files) {
      if (security.checks.byteLength && descriptor.bytes === null) {
        throw new TypeError(
          `${descriptor.kind} file ${descriptor.path} requires bytes under the effective security policy.`,
        );
      }
      if (security.checks.sha256 && descriptor.sha256 === null) {
        throw new TypeError(
          `${descriptor.kind} file ${descriptor.path} requires sha256 under the effective security policy.`,
        );
      }
    }
  }

  async function openCached(authority, { signal, onProgress, security } = {}) {
    const metadata = AUTHORITY_METADATA.get(authority);
    const names = storageNames(authority, metadata.files);
    const manifest = await readManifest(names.manifest);
    if (!manifestMatches(manifest, authority, metadata.files)) {
      await removeUnlocked(authority);
      return null;
    }
    const files = [];
    for (let index = 0; index < metadata.files.length; index += 1) {
      throwIfAborted(signal);
      const descriptor = metadata.files[index];
      const file = await readFile(names.files[index]);
      const observed = manifest.files[index];
      if (!file || observed?.path !== descriptor.path || observed?.bytes !== file.size) {
        await removeUnlocked(authority);
        return null;
      }
      if (!await verifyFile(
        file,
        descriptor,
        security,
        signal,
        onProgress,
        "verify-cache",
      )) {
        await removeUnlocked(authority);
        return null;
      }
      files.push({ descriptor, file });
    }
    try {
      await assertSelfContainedRuntime({ files }, metadata);
      throwIfAborted(signal);
    } catch (error) {
      await removeUnlocked(authority);
      throw error;
    }
    return Object.freeze({ files: Object.freeze(files), cache: "cached" });
  }

  async function install(authority, { signal, onProgress, security } = {}) {
    const metadata = AUTHORITY_METADATA.get(authority);
    const names = storageNames(authority, metadata.files);
    const fetchFunction = fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchFunction !== "function") {
      throw speechError("ARCANE_AI_ARTIFACT_SOURCE_UNAVAILABLE", "Browser fetch is unavailable.");
    }
    await removeUnlocked(authority);
    const installed = [];
    try {
      for (let index = 0; index < metadata.files.length; index += 1) {
        throwIfAborted(signal);
        const descriptor = metadata.files[index];
        let response;
        try {
          response = await fetchFunction(descriptor.url, {
            cache: "no-store",
            credentials: "omit",
            mode: "cors",
            redirect: "error",
            referrerPolicy: "no-referrer",
            signal,
          });
        } catch (error) {
          if (signal?.aborted || error?.name === "AbortError") throwIfAborted(signal);
          throw speechError("ARCANE_AI_ARTIFACT_DOWNLOAD_FAILED", "A speech artifact download failed.", error);
        }
        if (!response?.ok || !response.body) {
          await response?.body?.cancel?.().catch(() => undefined);
          throw speechError(
            "ARCANE_AI_ARTIFACT_DOWNLOAD_FAILED",
            `A speech artifact server returned HTTP ${response?.status ?? "unknown"}.`,
          );
        }
        let finalUrl = null;
        try {
          finalUrl = typeof response.url === "string" && response.url
            ? new URL(response.url).href
            : null;
        } catch {
          finalUrl = null;
        }
        if (response.redirected === true || finalUrl !== descriptor.url) {
          await response.body.cancel?.().catch(() => undefined);
          throw speechError(
            "ARCANE_AI_ARTIFACT_SOURCE_CHANGED",
            "A speech artifact response did not match its admitted URL.",
          );
        }
        const header = response.headers?.get?.("content-length");
        const reportedBytes = header ? Number(header) : null;
        if (
          security.checks.byteLength
          && Number.isSafeInteger(reportedBytes)
          && reportedBytes !== descriptor.bytes
        ) {
          await response.body.cancel?.().catch(() => undefined);
          throw speechError("ARCANE_AI_ARTIFACT_SIZE_MISMATCH", "Speech artifact Content-Length changed.");
        }
        const digest = security.checks.sha256
          ? createStreamingSha256()
          : null;
        const written = await writeFile(names.files[index], response.body, {
          signal,
          onChunk(chunk, completed) {
            digest?.update(chunk);
            if (security.checks.byteLength && completed > descriptor.bytes) {
              throw speechError("ARCANE_AI_ARTIFACT_SIZE_MISMATCH", "A speech artifact exceeded its expected size.");
            }
            onProgress?.(providerProgress(
              "download",
              completed,
              security.checks.byteLength ? descriptor.bytes : null,
            ));
          },
        });
        if (security.checks.byteLength && written !== descriptor.bytes) {
          throw speechError("ARCANE_AI_ARTIFACT_SIZE_MISMATCH", "A speech artifact byte count changed.");
        }
        if (digest && digest.digestHex() !== descriptor.sha256) {
          throw speechError("ARCANE_AI_ARTIFACT_DIGEST_MISMATCH", "A speech artifact SHA-256 changed.");
        }
        const file = await readFile(names.files[index]);
        if (!file || file.size !== written) {
          throw speechError("ARCANE_AI_ARTIFACT_CACHE_REJECTED", "DBOPFS did not preserve a speech artifact.");
        }
        installed.push({ descriptor, file });
      }
      await assertSelfContainedRuntime({ files: installed }, metadata);
      throwIfAborted(signal);
      const manifest = Object.freeze({
        schema: MANIFEST_SCHEMA,
        complete: true,
        authority: authorityProjection(authority),
        files: Object.freeze(installed.map(({ descriptor, file }) => Object.freeze({
          path: descriptor.path,
          bytes: file.size,
        }))),
        completedAt: new Date().toISOString(),
      });
      const encoded = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
      await writeFile(names.manifest, encoded, { signal });
      return Object.freeze({ files: Object.freeze(installed), cache: "installed" });
    } catch (error) {
      await removeUnlocked(authority).catch(() => undefined);
      throw error;
    }
  }

  async function prepareUnlocked(authority, {
    signal,
    onProgress,
    offline = false,
    security,
  } = {}) {
    if (!AUTHORITIES.has(authority)) {
      throw new TypeError("Speech artifact preparation requires an SDK-created authority.");
    }
    throwIfAborted(signal);
    const effectiveSecurity = resolveModelSecurity({ load: security });
    const metadata = AUTHORITY_METADATA.get(authority);
    assertSecurityDescriptors(metadata.files, effectiveSecurity);
    const cached = await openCached(authority, {
      signal,
      onProgress,
      security: effectiveSecurity,
    });
    const admitted = cached ?? (offline
      ? null
      : await install(authority, {
        signal,
        onProgress,
        security: effectiveSecurity,
      }));
    if (!admitted) {
      throw speechError("ARCANE_AI_ARTIFACT_OFFLINE_MISS", "No admitted offline speech cache is available.");
    }
    const materialized = createObjectUrls(admitted.files, objectUrlFactory);
    const runtimeFiles = materialized.files.filter((file) => file.kind === "runtime");
    const modelFiles = materialized.files.filter((file) => file.kind === "model");
    return Object.freeze({
      cache: admitted.cache,
      runtime: Object.freeze({
        adapter: metadata.runtime.adapter,
        version: metadata.runtime.version,
        revision: metadata.runtime.revision,
        entry: metadata.runtime.entry,
        moduleGraph: "self-contained",
        files: Object.freeze(runtimeFiles),
      }),
      model: Object.freeze({
        id: metadata.model.id,
        repository: metadata.model.repository,
        revision: metadata.model.revision,
        defaultVoice: metadata.model.defaultVoice,
        files: Object.freeze(modelFiles),
      }),
      release: materialized.release,
    });
  }

  function prepare(authority, options = {}) {
    if (!AUTHORITIES.has(authority)) {
      return Promise.reject(new TypeError(
        "Speech artifact preparation requires an SDK-created authority.",
      ));
    }
    return serializeAuthority(authority, () => prepareUnlocked(authority, options));
  }

  function remove(authority) {
    if (!AUTHORITIES.has(authority)) {
      return Promise.reject(new TypeError(
        "Speech artifact removal requires an SDK-created authority.",
      ));
    }
    return serializeAuthority(authority, () => removeUnlocked(authority));
  }

  const store = Object.freeze({
    protocol: BROWSER_SPEECH_ARTIFACT_PROTOCOL,
    tableName,
    prepare,
    remove,
  });
  STORES.add(store);
  return store;
}

export function isBrowserSpeechAuthority(value) {
  return AUTHORITIES.has(value);
}

export function isDbopfsSpeechArtifactStore(value) {
  return STORES.has(value);
}

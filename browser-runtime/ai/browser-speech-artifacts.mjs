import { createStreamingSha256 } from "./internal/sha256.mjs";
import {
  normalizeModelSecurity,
  resolveModelSecurity,
} from "./model-controller.mjs";

export const BROWSER_SPEECH_ARTIFACT_PROTOCOL =
  "arcane-ai-browser-speech-artifacts/1";
export const BROWSER_SPEECH_ARTIFACT_GRAPH_PROTOCOL =
  "arcane-ai-browser-speech-artifact-graph/1";

const MODEL_AUTHORITY_PROTOCOL = "arcane-ai-model-authority/1";
const MANIFEST_SCHEMA = "arcane.ai.browser-speech.assets.v1";
const ARTIFACT_GRAPH_MANIFEST_SCHEMA =
  "arcane.ai.browser-speech.authenticated-artifact-graph.v1";
const ARTIFACT_GRAPH_KIND = "browser-speech-authenticated-artifact-graph";
const ARTIFACT_GRAPH_MODULE_KIND =
  "browser-speech-authenticated-artifact-graph";
const ARTIFACT_GRAPH_GUARDS = "__arcaneBrowserSpeechArtifactGraphGuardsV1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MUTABLE_PATH_PATTERN = /\/(?:resolve\/)?(?:main|master|latest)(?:\/|$)/iu;
const ARTIFACT_GRAPH_MUTABLE_SOURCE_PATTERN =
  /\/(?:refs\/heads\/(?:main|master)|resolve\/(?:main|master)|(?:main|master|latest))(?:\/|$)|@(?:latest|next)(?:\/|$)/iu;
const AUTHORITIES = new WeakSet();
const AUTHORITY_METADATA = new WeakMap();
const ARTIFACT_GRAPHS = new WeakSet();
const ARTIFACT_GRAPH_METADATA = new WeakMap();
const ARTIFACT_ERRORS = new WeakSet();
const STORES = new WeakSet();
const PLATFORM_CREATE_OBJECT_URL = typeof globalThis.URL?.createObjectURL === "function"
  ? globalThis.URL.createObjectURL.bind(globalThis.URL)
  : null;
const PLATFORM_REVOKE_OBJECT_URL = typeof globalThis.URL?.revokeObjectURL === "function"
  ? globalThis.URL.revokeObjectURL.bind(globalThis.URL)
  : null;
const PLATFORM_FETCH = typeof globalThis.fetch === "function"
  ? globalThis.fetch.bind(globalThis)
  : null;
const LEGACY_ARTIFACT_ERROR_REASONS = Object.freeze({
  ARCANE_AI_REQUEST_ABORTED: "browser-speech-artifact-preparation-cancelled",
  ARCANE_AI_STORAGE_BUSY: "browser-speech-artifact-dbopfs-write-lock-unavailable",
  ARCANE_AI_STORAGE_UNAVAILABLE: "browser-speech-artifact-dbopfs-table-unavailable",
  ARCANE_AI_STORAGE_DELETE_FAILED: "browser-speech-artifact-dbopfs-delete-rejected",
  ARCANE_AI_STORAGE_READ_FAILED: "browser-speech-artifact-dbopfs-read-rejected",
  ARCANE_AI_ARTIFACT_SOURCE_INVALID: "browser-speech-artifact-source-body-unreadable",
  ARCANE_AI_RUNTIME_MODULE_GRAPH_UNDECLARED: "browser-speech-runtime-module-graph-undeclared",
  ARCANE_AI_ARTIFACT_SOURCE_UNAVAILABLE: "browser-speech-artifact-fetch-unavailable",
  ARCANE_AI_ARTIFACT_DOWNLOAD_FAILED: "browser-speech-artifact-fetch-rejected",
  ARCANE_AI_ARTIFACT_SOURCE_CHANGED: "browser-speech-artifact-source-redirected",
  ARCANE_AI_ARTIFACT_SIZE_MISMATCH: "browser-speech-artifact-byte-length-mismatch",
  ARCANE_AI_ARTIFACT_DIGEST_MISMATCH: "browser-speech-artifact-sha256-mismatch",
  ARCANE_AI_ARTIFACT_CACHE_REJECTED: "browser-speech-artifact-dbopfs-cache-rejected",
  ARCANE_AI_ARTIFACT_OFFLINE_MISS: "browser-speech-artifact-offline-cache-miss",
});

const ARTIFACT_GRAPH_FILE_KINDS = new Set([
  "model-configuration-json",
  "model-generation-configuration-json",
  "model-onnx-binary",
  "model-onnx-external-data",
  "model-opaque-data",
  "model-preprocessor-json",
  "model-tokenizer-json",
  "runtime-auxiliary-javascript",
  "runtime-entrypoint-javascript",
  "runtime-opaque-data",
  "runtime-wasm-binary",
  "voice-style-binary",
]);
const ARTIFACT_GRAPH_JAVASCRIPT_KINDS = new Set([
  "runtime-auxiliary-javascript",
  "runtime-entrypoint-javascript",
]);
const ARTIFACT_GRAPH_ONNX_NAMESPACES = new Set([
  "kokoro-env-wasm-paths",
  "transformers-env-backends-onnx-wasm",
]);
const ARTIFACT_GRAPH_EDGE_POLICIES = new Set([
  "artifact-targets-admitted",
  "inactive-runtime-branch-rejected",
]);
const ARTIFACT_GRAPH_IMPORT_MATCHES = new Set([
  "exact-runtime-specifier",
  "materialized-module-url",
]);

function speechError(code, message, cause, reason = LEGACY_ARTIFACT_ERROR_REASONS[code]) {
  const error = cause === undefined
    ? new Error(message)
    : new Error(message, { cause });
  error.name = "ArcaneBrowserSpeechError";
  error.code = code;
  if (typeof reason === "string" && reason) error.reason = reason;
  ARTIFACT_ERRORS.add(error);
  return error;
}

function artifactGraphError(reason, message, cause, Type = Error) {
  const error = cause === undefined
    ? new Type(message)
    : new Type(message, { cause });
  error.name = Type === TypeError
    ? "TypeError"
    : "ArcaneBrowserSpeechArtifactGraphError";
  error.code = `ARCANE_AI_${reason.toUpperCase().replaceAll("-", "_")}`;
  error.reason = reason;
  ARTIFACT_ERRORS.add(error);
  return error;
}

function artifactGraphTypeError(reason, message, cause) {
  return artifactGraphError(reason, message, cause, TypeError);
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

function artifactGraphText(value, label, reason = "artifact-graph-field-text-required") {
  if (typeof value !== "string" || !value.trim()) {
    throw artifactGraphTypeError(reason, `${label} must be a nonempty string.`);
  }
  return value.trim();
}

function artifactGraphIdentifier(
  value,
  label,
  missingReason = "artifact-graph-identifier-missing",
  lengthReason = "artifact-graph-identifier-length-exceeded",
) {
  const result = artifactGraphText(value, label, missingReason);
  if (result.length > 128) {
    throw artifactGraphTypeError(lengthReason, `${label} must not exceed 128 characters.`);
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

function canonicalArtifactPath(
  value,
  label,
  missingReason = "artifact-graph-file-path-missing",
  formatReason = "artifact-graph-file-path-noncanonical",
) {
  const path = artifactGraphText(
    value,
    label,
    missingReason,
  );
  if (
    path !== value
    || path !== path.normalize("NFC")
    || path.startsWith("/")
    || path.endsWith("/")
    || path.includes("\\")
    || /[%?#\u0000-\u001f\u007f]/u.test(path)
    || path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw artifactGraphTypeError(
      formatReason,
      `${label} must be one NFC-normalized relative path without escapes, empty segments, or URL delimiters.`,
    );
  }
  return path;
}

function graphSha256(
  value,
  label,
  missingReason = "artifact-graph-file-sha256-missing",
  formatReason = "artifact-graph-file-sha256-format-mismatch",
) {
  const sha256 = artifactGraphText(
    value,
    label,
    missingReason,
  );
  if (sha256 !== value || !SHA256_PATTERN.test(sha256)) {
    throw artifactGraphTypeError(
      formatReason,
      `${label} must contain exactly 64 lowercase hexadecimal characters.`,
    );
  }
  return sha256;
}

function graphPositiveInteger(
  value,
  label,
  reason = "artifact-graph-positive-safe-integer-required",
) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw artifactGraphTypeError(
      reason,
      `${label} must be a positive safe integer.`,
    );
  }
  return value;
}

function graphOptionalSampleRate(value, label, required = false) {
  if (value === undefined || value === null) {
    if (!required) return null;
    throw artifactGraphTypeError(
      "artifact-graph-sample-rate-missing",
      `${label} is required.`,
    );
  }
  return graphPositiveInteger(
    value,
    label,
    "artifact-graph-sample-rate-positive-safe-integer-required",
  );
}

function exactMediaType(value, label) {
  const mediaType = artifactGraphText(
    value,
    label,
    "artifact-graph-file-media-type-missing",
  ).toLowerCase();
  if (
    mediaType !== value
    || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType)
  ) {
    throw artifactGraphTypeError(
      "artifact-graph-file-media-type-format-mismatch",
      `${label} must be one lowercase media type without parameters.`,
    );
  }
  return mediaType;
}

function exactSourceMediaType(value, label) {
  const mediaType = artifactGraphText(
    value,
    label,
    "artifact-graph-file-source-media-type-missing",
  ).toLowerCase();
  if (
    mediaType !== value
    || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType)
  ) {
    throw artifactGraphTypeError(
      "artifact-graph-file-source-media-type-format-mismatch",
      `${label} must be one lowercase media type without parameters.`,
    );
  }
  return mediaType;
}

function graphRuntimeRequestUrl(value, label) {
  const url = artifactGraphText(
    value,
    label,
    "artifact-graph-runtime-request-url-text-required",
  );
  let result;
  try {
    result = new URL(url);
  } catch (error) {
    throw artifactGraphTypeError(
      "artifact-graph-runtime-request-url-not-absolute",
      `${label} must be an absolute HTTPS URL.`,
      error,
    );
  }
  if (result.protocol !== "https:") {
    throw artifactGraphTypeError(
      "artifact-graph-runtime-request-url-protocol-not-https",
      `${label} must use HTTPS.`,
    );
  }
  if (result.username || result.password) {
    throw artifactGraphTypeError(
      "artifact-graph-runtime-request-url-credentials-rejected",
      `${label} must not contain credentials.`,
    );
  }
  if (result.hash) {
    throw artifactGraphTypeError(
      "artifact-graph-runtime-request-url-fragment-rejected",
      `${label} must not contain a fragment.`,
    );
  }
  return result.href;
}

function graphRedirectFinalOrigin(value, label) {
  const text = artifactGraphText(
    value,
    label,
    "artifact-graph-source-redirect-final-origin-text-required",
  );
  if (text !== value) {
    throw artifactGraphTypeError(
      "artifact-graph-source-redirect-final-origin-whitespace-rejected",
      `${label} must not contain surrounding whitespace.`,
    );
  }
  let result;
  try {
    result = new URL(text);
  } catch (error) {
    throw artifactGraphTypeError(
      "artifact-graph-source-redirect-final-origin-not-absolute",
      `${label} must be an absolute HTTPS origin.`,
      error,
    );
  }
  if (result.protocol !== "https:") {
    throw artifactGraphTypeError(
      "artifact-graph-source-redirect-final-origin-protocol-not-https",
      `${label} must use HTTPS.`,
    );
  }
  if (result.username || result.password) {
    throw artifactGraphTypeError(
      "artifact-graph-source-redirect-final-origin-credentials-rejected",
      `${label} must not contain credentials.`,
    );
  }
  if (result.pathname !== "/") {
    throw artifactGraphTypeError(
      "artifact-graph-source-redirect-final-origin-path-rejected",
      `${label} must not contain a path.`,
    );
  }
  if (result.search) {
    throw artifactGraphTypeError(
      "artifact-graph-source-redirect-final-origin-query-rejected",
      `${label} must not contain a query.`,
    );
  }
  if (result.hash) {
    throw artifactGraphTypeError(
      "artifact-graph-source-redirect-final-origin-fragment-rejected",
      `${label} must not contain a fragment.`,
    );
  }
  return result.origin;
}

function normalizeGraphRedirectFinalOrigins(value, path) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw artifactGraphTypeError(
      "artifact-graph-source-redirect-final-origins-not-array",
      `Artifact graph file ${path} redirectFinalOrigins must be an array.`,
    );
  }
  if (value.length < 1) {
    throw artifactGraphTypeError(
      "artifact-graph-source-redirect-final-origin-inventory-empty",
      `Artifact graph file ${path} redirectFinalOrigins must contain at least one final origin when supplied.`,
    );
  }
  const origins = value.map((origin, index) => graphRedirectFinalOrigin(
    origin,
    `Artifact graph file ${path} redirectFinalOrigins[${String(index)}]`,
  ));
  const unique = new Set(origins);
  if (unique.size !== origins.length) {
    throw artifactGraphTypeError(
      "artifact-graph-source-redirect-final-origin-duplicate",
      `Artifact graph file ${path} redirectFinalOrigins must be unique after canonicalization.`,
    );
  }
  return Object.freeze([...origins].sort(lexicalCompare));
}

function graphImmutableUrl(value, label, revision, sha256) {
  let url;
  try {
    url = immutableUrl(
      artifactGraphText(
        value,
        label,
        "artifact-graph-source-url-missing",
      ),
      label,
    );
  } catch (error) {
    if (ARTIFACT_ERRORS.has(error)) throw error;
    throw artifactGraphTypeError(
      "artifact-graph-source-url-mutable",
      `${label} must identify an immutable HTTPS or same-origin source authority.`,
      error,
    );
  }
  const identityUrl = url.toLowerCase();
  if (ARTIFACT_GRAPH_MUTABLE_SOURCE_PATTERN.test(new URL(url).pathname)) {
    throw artifactGraphTypeError(
      "artifact-graph-source-url-mutable",
      `${label} names a mutable branch, channel, or release alias.`,
    );
  }
  if (
    !identityUrl.includes(revision.toLowerCase())
    && !identityUrl.includes(sha256)
  ) {
    throw artifactGraphTypeError(
      "artifact-graph-source-revision-unbound",
      `${label} must contain the file revision or SHA-256 identity.`,
    );
  }
  return url;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Text(value) {
  const digest = createStreamingSha256();
  digest.update(new TextEncoder().encode(value));
  return digest.digestHex();
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

function uniqueFiles(files, label, kind, revision, { allowEmpty = false } = {}) {
  if (!Array.isArray(files) || (!allowEmpty && files.length < 1)) {
    throw new TypeError(
      allowEmpty
        ? `${label} files must be an array.`
        : `${label} requires a nonempty files array.`,
    );
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

function normalizeArtifactGraphFile(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw artifactGraphTypeError(
      "artifact-graph-file-descriptor-not-object",
      `Artifact graph file ${String(index)} must be an object.`,
    );
  }
  const kind = artifactGraphText(
    value.kind,
    `Artifact graph file ${String(index)} kind`,
    "artifact-graph-file-kind-missing",
  );
  if (!ARTIFACT_GRAPH_FILE_KINDS.has(kind)) {
    throw artifactGraphTypeError(
      "artifact-graph-file-kind-not-admitted",
      `Artifact graph file ${String(index)} kind is not supported.`,
    );
  }
  const path = canonicalArtifactPath(
    value.path,
    `Artifact graph file ${String(index)} path`,
  );
  const revision = artifactGraphIdentifier(
    value.revision,
    `Artifact graph file ${path} revision`,
    "artifact-graph-file-revision-missing",
    "artifact-graph-file-revision-length-exceeded",
  );
  const bytes = graphPositiveInteger(
    value.bytes,
    `Artifact graph file ${path} bytes`,
    "artifact-graph-file-byte-length-positive-safe-integer-required",
  );
  const sha256 = graphSha256(
    value.sha256,
    `Artifact graph file ${path} sha256`,
  );
  const sourceUrl = graphImmutableUrl(
    value.sourceUrl ?? value.url,
    `Artifact graph file ${path} sourceUrl`,
    revision,
    sha256,
  );
  const redirectFinalOrigins = normalizeGraphRedirectFinalOrigins(
    value.redirectFinalOrigins,
    path,
  );
  const license = artifactGraphText(
    value.license,
    `Artifact graph file ${path} license`,
    "artifact-graph-file-license-missing",
  );
  if (license !== value.license) {
    throw artifactGraphTypeError(
      "artifact-graph-file-license-whitespace-rejected",
      `Artifact graph file ${path} license must not contain surrounding whitespace.`,
    );
  }
  if (license !== license.normalize("NFC")) {
    throw artifactGraphTypeError(
      "artifact-graph-file-license-not-nfc",
      `Artifact graph file ${path} license must be NFC-normalized.`,
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(license)) {
    throw artifactGraphTypeError(
      "artifact-graph-file-license-control-character-rejected",
      `Artifact graph file ${path} license must not contain control characters.`,
    );
  }
  if (license.length > 256) {
    throw artifactGraphTypeError(
      "artifact-graph-file-license-length-exceeded",
      `Artifact graph file ${path} license must not exceed 256 characters.`,
    );
  }
  const mediaType = exactMediaType(
    value.mediaType,
    `Artifact graph file ${path} mediaType`,
  );
  const sourceMediaType = value.sourceMediaType === undefined
    ? mediaType
    : exactSourceMediaType(
      value.sourceMediaType,
      `Artifact graph file ${path} sourceMediaType`,
    );
  if (
    ARTIFACT_GRAPH_JAVASCRIPT_KINDS.has(kind)
    && mediaType !== "application/javascript"
    && mediaType !== "text/javascript"
  ) {
    throw artifactGraphTypeError(
      "artifact-graph-javascript-media-type-mismatch",
      `Artifact graph JavaScript file ${path} must use application/javascript or text/javascript.`,
    );
  }
  if (kind === "runtime-wasm-binary" && mediaType !== "application/wasm") {
    throw artifactGraphTypeError(
      "artifact-graph-wasm-media-type-mismatch",
      `Artifact graph WebAssembly file ${path} must use application/wasm.`,
    );
  }
  if (kind.endsWith("-json") && mediaType !== "application/json") {
    throw artifactGraphTypeError(
      "artifact-graph-json-media-type-mismatch",
      `Artifact graph JSON file ${path} must use application/json.`,
    );
  }
  const requestUrls = value.runtimeRequestUrls ?? [];
  if (!Array.isArray(requestUrls)) {
    throw artifactGraphTypeError(
      "artifact-graph-runtime-request-routes-not-array",
      `Artifact graph file ${path} runtimeRequestUrls must be an array.`,
    );
  }
  const normalizedRequestUrls = [...new Set(requestUrls.map((url, requestIndex) =>
    graphRuntimeRequestUrl(
      url,
      `Artifact graph file ${path} runtimeRequestUrls[${String(requestIndex)}]`,
    )))].sort();
  if (normalizedRequestUrls.length !== requestUrls.length) {
    throw artifactGraphTypeError(
      "artifact-graph-runtime-request-route-duplicate",
      `Artifact graph file ${path} runtimeRequestUrls must be unique.`,
    );
  }
  return Object.freeze({
    kind,
    index,
    path,
    sourceUrl,
    revision,
    license,
    mediaType,
    sourceMediaType,
    bytes,
    sha256,
    runtimeRequestUrls: Object.freeze(normalizedRequestUrls),
    redirectFinalOrigins,
  });
}

function publicArtifactGraphFile(file) {
  return Object.freeze({
    kind: file.kind,
    path: file.path,
    sourceUrl: file.sourceUrl,
    revision: file.revision,
    license: file.license,
    mediaType: file.mediaType,
    ...(file.sourceMediaType === file.mediaType
      ? {}
      : { sourceMediaType: file.sourceMediaType }),
    bytes: file.bytes,
    sha256: file.sha256,
    runtimeRequestUrls: file.runtimeRequestUrls,
    ...(file.redirectFinalOrigins.length < 1
      ? {}
      : { redirectFinalOrigins: file.redirectFinalOrigins }),
  });
}

function normalizeGraphOccurrence(value, label) {
  return graphPositiveInteger(
    value,
    `${label} occurrence`,
    "artifact-graph-edge-occurrence-positive-safe-integer-required",
  );
}

function normalizeGraphModulePath(value, label, filesByPath) {
  const path = canonicalArtifactPath(
    value,
    `${label} modulePath`,
    "artifact-graph-edge-module-path-missing",
    "artifact-graph-edge-module-path-noncanonical",
  );
  if (!ARTIFACT_GRAPH_JAVASCRIPT_KINDS.has(filesByPath.get(path)?.kind)) {
    throw artifactGraphTypeError(
      "artifact-graph-edge-module-path-not-runtime-javascript",
      `${label} modulePath must name one declared runtime JavaScript file.`,
    );
  }
  return path;
}

function normalizeGraphTargetPath(value, label, filesByPath, javascript = false) {
  const path = canonicalArtifactPath(
    value,
    `${label} targetPath`,
    "artifact-graph-edge-target-path-missing",
    "artifact-graph-edge-target-path-noncanonical",
  );
  const target = filesByPath.get(path);
  if (!target || (javascript && !ARTIFACT_GRAPH_JAVASCRIPT_KINDS.has(target.kind))) {
    throw artifactGraphTypeError(
      "artifact-graph-edge-target-path-undeclared",
      `${label} targetPath must name a compatible declared graph file.`,
    );
  }
  return path;
}

function normalizeGraphPolicy(value, label) {
  const policy = value ?? "artifact-targets-admitted";
  if (!ARTIFACT_GRAPH_EDGE_POLICIES.has(policy)) {
    throw artifactGraphTypeError(
      "artifact-graph-edge-policy-not-admitted",
      `${label} edgePolicy must identify an admitted artifact target or an inactive rejected runtime branch.`,
    );
  }
  return policy;
}

function normalizeGraphTargets(value, label, filesByPath, {
  javascript = false,
  worker = false,
} = {}) {
  if (!Array.isArray(value)) {
    throw artifactGraphTypeError(
      "artifact-graph-edge-targets-not-array",
      `${label} targets must be an array.`,
    );
  }
  const allowedMatches = worker
    ? new Set([...ARTIFACT_GRAPH_IMPORT_MATCHES, "self-module-url"])
    : ARTIFACT_GRAPH_IMPORT_MATCHES;
  const targets = value.map((target, index) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw artifactGraphTypeError(
        "artifact-graph-edge-target-not-object",
        `${label} target ${String(index)} must be an object.`,
      );
    }
    const match = artifactGraphText(
      target.match,
      `${label} target ${String(index)} match`,
      "artifact-graph-edge-target-match-missing",
    );
    if (!allowedMatches.has(match)) {
      throw artifactGraphTypeError(
        "artifact-graph-edge-target-match-not-admitted",
        `${label} target ${String(index)} match is not admitted.`,
      );
    }
    const targetPath = normalizeGraphTargetPath(
      target.targetPath,
      `${label} target ${String(index)}`,
      filesByPath,
      javascript,
    );
    const exactSpecifier = match === "exact-runtime-specifier"
      ? artifactGraphText(
        target.exactSpecifier ?? target.specifier,
        `${label} target ${String(index)} exactSpecifier`,
        "artifact-graph-edge-target-specifier-missing",
      )
      : null;
    return Object.freeze({ match, targetPath, exactSpecifier });
  });
  targets.sort((left, right) => lexicalCompare(canonicalJson(left), canonicalJson(right)));
  const identities = new Set(targets.map(canonicalJson));
  if (identities.size !== targets.length) {
    throw artifactGraphTypeError(
      "artifact-graph-edge-target-duplicate",
      `${label} targets must be unique.`,
    );
  }
  return Object.freeze(targets);
}

function normalizeArtifactGraphEdges(value, filesByPath, negativeRuntimeRequestUrls) {
  const edges = value ?? {};
  if (!edges || typeof edges !== "object" || Array.isArray(edges)) {
    throw artifactGraphTypeError(
      "artifact-graph-edges-not-object",
      "Artifact graph edges must be an object.",
    );
  }
  const allowedEdgeNames = new Set([
    "cacheOpens",
    "dynamicImports",
    "fetches",
    "moduleWorkers",
    "staticImports",
  ]);
  if (Reflect.ownKeys(edges).some((name) =>
    typeof name !== "string" || !allowedEdgeNames.has(name))) {
    throw artifactGraphTypeError(
      "artifact-graph-edge-kind-not-admitted",
      "Artifact graph edges contain an edge kind that is not admitted.",
    );
  }

  function normalizeArray(name, normalize) {
    const values = edges[name] ?? [];
    if (!Array.isArray(values)) {
      throw artifactGraphTypeError(
        "artifact-graph-edge-list-not-array",
        `Artifact graph ${name} must be an array.`,
      );
    }
    const normalized = values.map((edge, index) => {
      if (!edge || typeof edge !== "object" || Array.isArray(edge)) {
        throw artifactGraphTypeError(
          "artifact-graph-edge-not-object",
          `Artifact graph ${name}[${String(index)}] must be an object.`,
        );
      }
      const label = `Artifact graph ${name}[${String(index)}]`;
      const modulePath = normalizeGraphModulePath(edge.modulePath, label, filesByPath);
      const occurrence = normalizeGraphOccurrence(edge.occurrence, label);
      return normalize(edge, label, modulePath, occurrence);
    });
    normalized.sort((left, right) => lexicalCompare(canonicalJson(left), canonicalJson(right)));
    const occurrences = new Set();
    for (const edge of normalized) {
      const key = `${edge.modulePath}\u0000${String(edge.occurrence)}`;
      if (occurrences.has(key)) {
        throw artifactGraphTypeError(
          "artifact-graph-edge-occurrence-duplicate",
          `Artifact graph ${name} contains a duplicate module occurrence.`,
        );
      }
      occurrences.add(key);
    }
    return Object.freeze(normalized);
  }

  const staticImports = normalizeArray(
    "staticImports",
    (edge, label, modulePath, occurrence) => Object.freeze({
      modulePath,
      occurrence,
      specifier: artifactGraphText(
        edge.specifier,
        `${label} specifier`,
        "artifact-graph-static-import-specifier-missing",
      ),
      targetPath: normalizeGraphTargetPath(
        edge.targetPath,
        label,
        filesByPath,
        true,
      ),
    }),
  );
  const dynamicImports = normalizeArray(
    "dynamicImports",
    (edge, label, modulePath, occurrence) => {
      const edgePolicy = normalizeGraphPolicy(edge.edgePolicy, label);
      const targets = normalizeGraphTargets(edge.targets ?? [], label, filesByPath, {
        javascript: true,
      });
      if (
        (edgePolicy === "artifact-targets-admitted") !== (targets.length > 0)
      ) {
        throw artifactGraphTypeError(
          "artifact-graph-dynamic-import-policy-target-mismatch",
          `${label} must have targets exactly when its edgePolicy admits artifact targets.`,
        );
      }
      return Object.freeze({ modulePath, occurrence, edgePolicy, targets });
    },
  );
  const moduleWorkers = normalizeArray(
    "moduleWorkers",
    (edge, label, modulePath, occurrence) => {
      const edgePolicy = normalizeGraphPolicy(edge.edgePolicy, label);
      const targets = normalizeGraphTargets(edge.targets ?? [], label, filesByPath, {
        javascript: true,
        worker: true,
      });
      if (
        (edgePolicy === "artifact-targets-admitted") !== (targets.length > 0)
      ) {
        throw artifactGraphTypeError(
          "artifact-graph-module-worker-policy-target-mismatch",
          `${label} must have targets exactly when its edgePolicy admits artifact targets.`,
        );
      }
      if (targets.some((target) =>
        target.match === "self-module-url" && target.targetPath !== modulePath)) {
        throw artifactGraphTypeError(
          "artifact-graph-module-worker-self-target-mismatch",
          `${label} self-module-url target must equal modulePath.`,
        );
      }
      return Object.freeze({ modulePath, occurrence, edgePolicy, targets });
    },
  );
  const fetches = normalizeArray(
    "fetches",
    (edge, label, modulePath, occurrence) => {
      const edgePolicy = normalizeGraphPolicy(edge.edgePolicy, label);
      const methods = edge.methods ?? ["GET"];
      if (
        !Array.isArray(methods)
        || methods.length !== 1
        || methods[0] !== "GET"
      ) {
        throw artifactGraphTypeError(
          "artifact-graph-fetch-method-not-get",
          `${label} methods must be exactly ["GET"].`,
        );
      }
      const targetPaths = edge.targetPaths ?? [];
      if (!Array.isArray(targetPaths)) {
        throw artifactGraphTypeError(
          "artifact-graph-fetch-targets-not-array",
          `${label} targetPaths must be an array.`,
        );
      }
      const normalizedTargetPaths = [...new Set(targetPaths.map((path) =>
        normalizeGraphTargetPath(path, label, filesByPath)))].sort();
      if (normalizedTargetPaths.length !== targetPaths.length) {
        throw artifactGraphTypeError(
          "artifact-graph-fetch-target-duplicate",
          `${label} targetPaths must be unique.`,
        );
      }
      if (normalizedTargetPaths.some((path) =>
        ARTIFACT_GRAPH_JAVASCRIPT_KINDS.has(filesByPath.get(path)?.kind))) {
        throw artifactGraphTypeError(
          "artifact-graph-fetch-javascript-target-rejected",
          `${label} must not expose authenticated JavaScript bytes through a fetch edge.`,
        );
      }
      const negativeUrls = edge.negativeRuntimeRequestUrls ?? [];
      if (!Array.isArray(negativeUrls)) {
        throw artifactGraphTypeError(
          "artifact-graph-fetch-negative-routes-not-array",
          `${label} negativeRuntimeRequestUrls must be an array.`,
        );
      }
      const normalizedNegativeUrls = [...new Set(negativeUrls.map((url, index) =>
        graphRuntimeRequestUrl(url, `${label} negativeRuntimeRequestUrls[${String(index)}]`)))].sort();
      if (
        normalizedNegativeUrls.length !== negativeUrls.length
        || normalizedNegativeUrls.some((url) => !negativeRuntimeRequestUrls.has(url))
      ) {
        throw artifactGraphTypeError(
          "artifact-graph-fetch-negative-route-undeclared",
          `${label} negative runtime request routes must be unique graph-level declarations.`,
        );
      }
      if (
        edgePolicy === "artifact-targets-admitted"
        && normalizedTargetPaths.length === 0
        && normalizedNegativeUrls.length === 0
      ) {
        throw artifactGraphTypeError(
          "artifact-graph-fetch-targets-incomplete",
          `${label} must admit at least one artifact or authenticated negative route.`,
        );
      }
      if (
        edgePolicy === "inactive-runtime-branch-rejected"
        && (normalizedTargetPaths.length > 0 || normalizedNegativeUrls.length > 0)
      ) {
        throw artifactGraphTypeError(
          "artifact-graph-fetch-policy-target-mismatch",
          `${label} rejected inactive branch must not name fetch targets.`,
        );
      }
      return Object.freeze({
        modulePath,
        occurrence,
        edgePolicy,
        methods: Object.freeze(["GET"]),
        targetPaths: Object.freeze(normalizedTargetPaths),
        negativeRuntimeRequestUrls: Object.freeze(normalizedNegativeUrls),
        allowMaterializedUrls: edge.allowMaterializedUrls === true,
      });
    },
  );
  const cacheOpens = normalizeArray(
    "cacheOpens",
    (edge, label, modulePath, occurrence) => {
      const edgePolicy = normalizeGraphPolicy(edge.edgePolicy, label);
      const cacheName = artifactGraphText(
        edge.cacheName,
        `${label} cacheName`,
        "artifact-graph-cache-name-missing",
      );
      const targetPaths = edge.targetPaths ?? [];
      if (!Array.isArray(targetPaths)) {
        throw artifactGraphTypeError(
          "artifact-graph-cache-targets-not-array",
          `${label} targetPaths must be an array.`,
        );
      }
      const normalizedTargetPaths = [...new Set(targetPaths.map((path) =>
        normalizeGraphTargetPath(path, label, filesByPath)))].sort();
      if (normalizedTargetPaths.length !== targetPaths.length) {
        throw artifactGraphTypeError(
          "artifact-graph-cache-target-duplicate",
          `${label} targetPaths must be unique.`,
        );
      }
      if (normalizedTargetPaths.some((path) =>
        ARTIFACT_GRAPH_JAVASCRIPT_KINDS.has(filesByPath.get(path)?.kind))) {
        throw artifactGraphTypeError(
          "artifact-graph-cache-javascript-target-rejected",
          `${label} must not expose authenticated JavaScript bytes through a cache edge.`,
        );
      }
      if (
        (edgePolicy === "artifact-targets-admitted") !== (normalizedTargetPaths.length > 0)
      ) {
        throw artifactGraphTypeError(
          "artifact-graph-cache-policy-target-mismatch",
          `${label} must have targets exactly when its edgePolicy admits authenticated cache reads.`,
        );
      }
      return Object.freeze({
        modulePath,
        occurrence,
        edgePolicy,
        cacheName,
        targetPaths: Object.freeze(normalizedTargetPaths),
      });
    },
  );
  return Object.freeze({
    staticImports,
    dynamicImports,
    moduleWorkers,
    fetches,
    cacheOpens,
  });
}

function normalizeArtifactGraphTransforms(value, filesByPath) {
  const transforms = value ?? [];
  if (!Array.isArray(transforms)) {
    throw artifactGraphTypeError(
      "artifact-graph-transforms-not-array",
      "Artifact graph transforms must be an array.",
    );
  }
  const normalized = transforms.map((transform, index) => {
    if (!transform || typeof transform !== "object" || Array.isArray(transform)) {
      throw artifactGraphTypeError(
        "artifact-graph-transform-not-object",
        `Artifact graph transform ${String(index)} must be an object.`,
      );
    }
    const label = `Artifact graph transform ${String(index)}`;
    if (!["function-return-this-to-global-this", "typed-array-constructor"].includes(
      transform.kind,
    )) {
      throw artifactGraphTypeError(
        "artifact-graph-transform-kind-not-admitted",
        `${label} kind is not admitted.`,
      );
    }
    return Object.freeze({
      kind: transform.kind,
      modulePath: normalizeGraphModulePath(transform.modulePath, label, filesByPath),
      occurrence: normalizeGraphOccurrence(transform.occurrence, label),
    });
  });
  normalized.sort((left, right) => lexicalCompare(canonicalJson(left), canonicalJson(right)));
  const identities = new Set(normalized.map(canonicalJson));
  if (identities.size !== normalized.length) {
    throw artifactGraphTypeError(
      "artifact-graph-transform-occurrence-duplicate",
      "Artifact graph transform occurrences must be unique.",
    );
  }
  return Object.freeze(normalized);
}

function normalizeArtifactGraphVoices(value, defaultVoice, filesByPath) {
  if (!Array.isArray(value) || value.length < 1) {
    throw artifactGraphTypeError(
      "artifact-graph-voice-inventory-missing",
      "A TTS artifact graph requires a nonempty voices array.",
    );
  }
  const voices = value.map((voice, index) => {
    if (!voice || typeof voice !== "object" || Array.isArray(voice)) {
      throw artifactGraphTypeError(
        "artifact-graph-voice-descriptor-not-object",
        `Artifact graph voice ${String(index)} must be an object.`,
      );
    }
    const id = artifactGraphIdentifier(
      voice.id,
      `Artifact graph voice ${String(index)} id`,
      "artifact-graph-voice-id-missing",
      "artifact-graph-voice-id-length-exceeded",
    );
    const path = normalizeGraphTargetPath(
      voice.path,
      `Artifact graph voice ${id}`,
      filesByPath,
    );
    if (filesByPath.get(path).kind !== "voice-style-binary") {
      throw artifactGraphTypeError(
        "artifact-graph-voice-file-kind-mismatch",
        `Artifact graph voice ${id} must name a voice-style-binary file.`,
      );
    }
    return Object.freeze({ id, path });
  });
  voices.sort((left, right) => lexicalCompare(left.id, right.id));
  const ids = new Set(voices.map(({ id }) => id));
  const paths = new Set(voices.map(({ path }) => path));
  if (ids.size !== voices.length || paths.size !== voices.length) {
    throw artifactGraphTypeError(
      "artifact-graph-voice-inventory-ambiguous",
      "Artifact graph voice ids and file paths must be unique.",
    );
  }
  if (!ids.has(defaultVoice)) {
    throw artifactGraphTypeError(
      "artifact-graph-default-voice-undeclared",
      "Artifact graph defaultVoice must name one declared voice.",
    );
  }
  return Object.freeze(voices);
}

function artifactGraphIdentityProjection({
  providerId,
  role,
  model,
  runtime,
  files,
  edges,
  transforms,
}) {
  return Object.freeze({
    protocol: BROWSER_SPEECH_ARTIFACT_GRAPH_PROTOCOL,
    kind: ARTIFACT_GRAPH_KIND,
    providerId,
    role,
    model,
    runtime,
    files: Object.freeze(files.map(publicArtifactGraphFile)),
    edges,
    transforms,
  });
}

/**
 * Creates one closed, caller-selected browser speech artifact graph. Every
 * executable and data byte is immutable, content-addressed, and reachable only
 * through an explicit graph edge or exact local runtime request route.
 */
export function createBrowserSpeechArtifactGraph({
  kind = ARTIFACT_GRAPH_KIND,
  identitySha256,
  providerId = null,
  role,
  model,
  runtime,
  files,
  edges,
  transforms,
} = {}) {
  if (kind !== ARTIFACT_GRAPH_KIND) {
    throw artifactGraphTypeError(
      "artifact-graph-kind-mismatch",
      `Browser speech artifact graph kind must equal ${ARTIFACT_GRAPH_KIND}.`,
    );
  }
  if (role !== "stt" && role !== "tts") {
    throw artifactGraphTypeError(
      "artifact-graph-role-not-stt-or-tts",
      'Browser speech artifact graph role must be "stt" or "tts".',
    );
  }
  const normalizedProviderId = providerId === null || providerId === undefined
    ? null
    : artifactGraphIdentifier(
      providerId,
      "Browser speech artifact graph providerId",
      "artifact-graph-provider-id-missing",
      "artifact-graph-provider-id-length-exceeded",
    );
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    throw artifactGraphTypeError(
      "artifact-graph-model-descriptor-missing",
      "Browser speech artifact graph model descriptor is required.",
    );
  }
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw artifactGraphTypeError(
      "artifact-graph-runtime-descriptor-missing",
      "Browser speech artifact graph runtime descriptor is required.",
    );
  }
  if (!Array.isArray(files) || files.length < 1) {
    throw artifactGraphTypeError(
      "artifact-graph-file-inventory-missing",
      "Browser speech artifact graph requires a nonempty files array.",
    );
  }
  const normalizedFiles = files.map(normalizeArtifactGraphFile);
  normalizedFiles.sort((left, right) => lexicalCompare(left.path, right.path));
  const filesByPath = new Map();
  const lowercasePaths = new Set();
  const sourceUrls = new Set();
  const requestUrls = new Set();
  for (const file of normalizedFiles) {
    const lowercasePath = file.path.toLowerCase();
    if (
      filesByPath.has(file.path)
      || lowercasePaths.has(lowercasePath)
      || sourceUrls.has(file.sourceUrl)
    ) {
      throw artifactGraphTypeError(
        "artifact-graph-file-identity-ambiguous",
        "Artifact graph file paths (including case-folded paths) and source URLs must be unique.",
      );
    }
    filesByPath.set(file.path, file);
    lowercasePaths.add(lowercasePath);
    sourceUrls.add(file.sourceUrl);
    for (const url of file.runtimeRequestUrls) {
      if (requestUrls.has(url)) {
        throw artifactGraphTypeError(
          "artifact-graph-runtime-request-route-ambiguous",
          `Artifact graph runtime request URL ${url} maps to more than one file.`,
        );
      }
      requestUrls.add(url);
    }
  }
  for (const url of requestUrls) {
    if (sourceUrls.has(url)) {
      throw artifactGraphTypeError(
        "artifact-graph-runtime-request-route-ambiguous",
        `Artifact graph runtime request URL ${url} overlaps an immutable source URL.`,
      );
    }
  }

  const entrypoint = canonicalArtifactPath(
    runtime.entrypoint ?? runtime.entry,
    "Browser speech artifact graph runtime entrypoint",
    "artifact-graph-entrypoint-path-missing",
    "artifact-graph-entrypoint-path-noncanonical",
  );
  const entrypointFile = filesByPath.get(entrypoint);
  if (entrypointFile?.kind !== "runtime-entrypoint-javascript") {
    throw artifactGraphTypeError(
      "artifact-graph-entrypoint-file-kind-mismatch",
      "Browser speech artifact graph entrypoint must name one runtime-entrypoint-javascript file.",
    );
  }
  if (normalizedFiles.filter((file) =>
    file.kind === "runtime-entrypoint-javascript").length !== 1) {
    throw artifactGraphTypeError(
      "artifact-graph-entrypoint-count-mismatch",
      "Browser speech artifact graph requires exactly one runtime-entrypoint-javascript file.",
    );
  }
  const runtimeAdapter = artifactGraphText(
    runtime.adapter,
    "Browser speech artifact graph runtime adapter",
    "artifact-graph-runtime-adapter-missing",
  );
  const expectedAdapter = role === "stt" ? "transformers-whisper" : "kokoro-js";
  if (runtimeAdapter !== expectedAdapter) {
    throw artifactGraphTypeError(
      "artifact-graph-runtime-adapter-role-mismatch",
      `Browser ${role} artifact graph runtime adapter must equal ${expectedAdapter}.`,
    );
  }
  const runtimeVersion = artifactGraphIdentifier(
    runtime.version,
    "Browser speech artifact graph runtime version",
    "artifact-graph-runtime-version-missing",
    "artifact-graph-runtime-version-length-exceeded",
  );
  const runtimeRevision = artifactGraphIdentifier(
    runtime.revision,
    "Browser speech artifact graph runtime revision",
    "artifact-graph-runtime-revision-missing",
    "artifact-graph-runtime-revision-length-exceeded",
  );
  if (entrypointFile.revision !== runtimeRevision) {
    throw artifactGraphTypeError(
      "artifact-graph-entrypoint-revision-mismatch",
      "Browser speech artifact graph entrypoint revision must equal the runtime revision.",
    );
  }
  const onnxWasm = runtime.onnxWasm;
  if (!onnxWasm || typeof onnxWasm !== "object" || Array.isArray(onnxWasm)) {
    throw artifactGraphTypeError(
      "artifact-graph-onnx-wasm-descriptor-missing",
      "Browser speech artifact graph runtime onnxWasm descriptor is required.",
    );
  }
  const namespace = artifactGraphText(
    onnxWasm.namespace,
    "Browser speech artifact graph ONNX namespace",
    "artifact-graph-onnx-wasm-namespace-missing",
  );
  const expectedNamespace = role === "stt"
    ? "transformers-env-backends-onnx-wasm"
    : "kokoro-env-wasm-paths";
  if (!ARTIFACT_GRAPH_ONNX_NAMESPACES.has(namespace) || namespace !== expectedNamespace) {
    throw artifactGraphTypeError(
      "artifact-graph-onnx-wasm-namespace-role-mismatch",
      `Browser ${role} artifact graph ONNX namespace must equal ${expectedNamespace}.`,
    );
  }
  const mjsPath = normalizeGraphTargetPath(
    onnxWasm.mjsPath,
    "Browser speech artifact graph ONNX module",
    filesByPath,
    true,
  );
  const wasmPath = normalizeGraphTargetPath(
    onnxWasm.wasmPath,
    "Browser speech artifact graph ONNX WebAssembly",
    filesByPath,
  );
  if (
    filesByPath.get(mjsPath).kind !== "runtime-auxiliary-javascript"
    || filesByPath.get(wasmPath).kind !== "runtime-wasm-binary"
  ) {
    throw artifactGraphTypeError(
      "artifact-graph-onnx-wasm-file-kind-mismatch",
      "Browser speech artifact graph ONNX paths must name auxiliary JavaScript and WebAssembly runtime files.",
    );
  }
  const numThreads = onnxWasm.numThreads === undefined
    ? null
    : graphPositiveInteger(
      onnxWasm.numThreads,
      "Browser speech artifact graph ONNX numThreads",
      "artifact-graph-onnx-wasm-num-threads-positive-safe-integer-required",
    );
  if (role === "tts" && numThreads !== null) {
    throw artifactGraphTypeError(
      "kokoro-env-num-threads-field-not-exposed",
      "Kokoro does not expose a verified numThreads configuration field.",
    );
  }

  const negativeRoutes = runtime.negativeRuntimeRequestUrls ?? [];
  if (!Array.isArray(negativeRoutes)) {
    throw artifactGraphTypeError(
      "artifact-graph-negative-runtime-routes-not-array",
      "Browser speech artifact graph runtime negativeRuntimeRequestUrls must be an array.",
    );
  }
  const normalizedNegativeRoutes = [...new Set(negativeRoutes.map((url, index) =>
    graphRuntimeRequestUrl(
      url,
      `Browser speech artifact graph negativeRuntimeRequestUrls[${String(index)}]`,
    )))].sort();
  if (normalizedNegativeRoutes.length !== negativeRoutes.length) {
    throw artifactGraphTypeError(
      "artifact-graph-negative-runtime-route-duplicate",
      "Browser speech artifact graph negative runtime request routes must be unique.",
    );
  }
  for (const url of normalizedNegativeRoutes) {
    if (
      requestUrls.has(url)
      || sourceUrls.has(url)
    ) {
      throw artifactGraphTypeError(
        "artifact-graph-negative-runtime-route-ambiguous",
        `Artifact graph negative runtime request URL ${url} must not overlap a positive graph route.`,
      );
    }
  }

  const modelId = artifactGraphIdentifier(
    model.id,
    "Browser speech artifact graph model id",
    "artifact-graph-model-id-missing",
    "artifact-graph-model-id-length-exceeded",
  );
  const repository = artifactGraphIdentifier(
    model.repository,
    "Browser speech artifact graph model repository",
    "artifact-graph-model-repository-missing",
    "artifact-graph-model-repository-length-exceeded",
  );
  const modelRevision = artifactGraphIdentifier(
    model.revision,
    "Browser speech artifact graph model revision",
    "artifact-graph-model-revision-missing",
    "artifact-graph-model-revision-length-exceeded",
  );
  const dtype = artifactGraphIdentifier(
    model.dtype,
    "Browser speech artifact graph model dtype",
    "artifact-graph-model-dtype-missing",
    "artifact-graph-model-dtype-length-exceeded",
  );
  const inputSampleRate = graphOptionalSampleRate(
    model.inputSampleRate,
    "Browser speech artifact graph model inputSampleRate",
    role === "stt",
  );
  const outputSampleRate = graphOptionalSampleRate(
    model.outputSampleRate,
    "Browser speech artifact graph model outputSampleRate",
    role === "tts",
  );
  const defaultVoice = role === "tts"
    ? artifactGraphIdentifier(
      model.defaultVoice,
      "Browser speech artifact graph defaultVoice",
      "artifact-graph-default-voice-missing",
      "artifact-graph-default-voice-length-exceeded",
    )
    : null;
  if (
    role === "stt"
    && (model.defaultVoice !== undefined || model.voices !== undefined)
  ) {
    throw artifactGraphTypeError(
      "artifact-graph-stt-voice-authority-declared",
      "An STT artifact graph must not declare TTS voice authority.",
    );
  }
  const voices = role === "tts"
    ? normalizeArtifactGraphVoices(model.voices, defaultVoice, filesByPath)
    : Object.freeze([]);

  const negativeRuntimeRequestUrlSet = new Set(normalizedNegativeRoutes);
  const normalizedEdges = normalizeArtifactGraphEdges(
    edges,
    filesByPath,
    negativeRuntimeRequestUrlSet,
  );
  const normalizedTransforms = normalizeArtifactGraphTransforms(transforms, filesByPath);
  const referencedPaths = new Set([entrypoint, mjsPath, wasmPath]);
  const referencedNegativeRoutes = new Set();
  for (const edge of normalizedEdges.staticImports) referencedPaths.add(edge.targetPath);
  for (const edge of normalizedEdges.dynamicImports) {
    for (const target of edge.targets) referencedPaths.add(target.targetPath);
  }
  for (const edge of normalizedEdges.moduleWorkers) {
    for (const target of edge.targets) referencedPaths.add(target.targetPath);
  }
  for (const edge of normalizedEdges.fetches) {
    for (const path of edge.targetPaths) referencedPaths.add(path);
    for (const url of edge.negativeRuntimeRequestUrls) referencedNegativeRoutes.add(url);
  }
  for (const edge of normalizedEdges.cacheOpens) {
    for (const path of edge.targetPaths) referencedPaths.add(path);
  }
  for (const voice of voices) referencedPaths.add(voice.path);
  for (const file of normalizedFiles) {
    if (
      file.kind !== "runtime-entrypoint-javascript"
      && !referencedPaths.has(file.path)
    ) {
      throw artifactGraphTypeError(
        "artifact-graph-file-unreachable",
        `Artifact graph file ${file.path} is not reachable from a declared runtime, model, or voice capability.`,
      );
    }
    if (
      file.runtimeRequestUrls.length > 0
      && !referencedPaths.has(file.path)
    ) {
      throw artifactGraphTypeError(
        "artifact-graph-runtime-request-route-unreachable",
        `Artifact graph runtime request routes for ${file.path} have no declared edge.`,
      );
    }
  }
  for (const url of normalizedNegativeRoutes) {
    if (!referencedNegativeRoutes.has(url)) {
      throw artifactGraphTypeError(
        "artifact-graph-negative-runtime-route-unreachable",
        `Artifact graph negative runtime request URL ${url} has no declared fetch edge.`,
      );
    }
  }

  const runtimeFiles = Object.freeze(normalizedFiles.filter((file) =>
    file.kind.startsWith("runtime-")));
  const modelFiles = Object.freeze(normalizedFiles.filter((file) =>
    !file.kind.startsWith("runtime-")));
  if (modelFiles.length < 1) {
    throw artifactGraphTypeError(
      "artifact-graph-model-file-inventory-missing",
      "Browser speech artifact graph requires at least one model or voice file.",
    );
  }
  if (role === "stt" && modelFiles.some((file) => file.kind === "voice-style-binary")) {
    throw artifactGraphTypeError(
      "artifact-graph-stt-voice-file-declared",
      "An STT artifact graph must not contain voice-style-binary files.",
    );
  }
  if (role === "tts") {
    const declaredVoicePaths = new Set(voices.map(({ path }) => path));
    if (modelFiles.some((file) =>
      file.kind === "voice-style-binary" && !declaredVoicePaths.has(file.path))) {
      throw artifactGraphTypeError(
        "artifact-graph-voice-file-undeclared",
        "Every voice-style-binary file must belong to the caller-declared voice inventory.",
      );
    }
  }
  if (modelFiles.some((file) => file.revision !== modelRevision)) {
    throw artifactGraphTypeError(
      "artifact-graph-model-file-revision-mismatch",
      "Every artifact graph model and voice file revision must equal the model revision.",
    );
  }
  const publicRuntimeFiles = Object.freeze(runtimeFiles.map(publicArtifactGraphFile));
  const publicModelFiles = Object.freeze(modelFiles.map(publicArtifactGraphFile));
  const normalizedRuntime = Object.freeze({
    adapter: runtimeAdapter,
    version: runtimeVersion,
    revision: runtimeRevision,
    entry: entrypoint,
    moduleGraph: ARTIFACT_GRAPH_MODULE_KIND,
    files: publicRuntimeFiles,
    onnxWasm: Object.freeze({
      namespace,
      mjsPath,
      wasmPath,
      ...(numThreads === null ? {} : { numThreads }),
    }),
    negativeRuntimeRequestUrls: Object.freeze(normalizedNegativeRoutes),
  });
  const normalizedModel = Object.freeze({
    id: modelId,
    repository,
    revision: modelRevision,
    dtype,
    ...(inputSampleRate === null ? {} : { inputSampleRate }),
    ...(outputSampleRate === null ? {} : { outputSampleRate }),
    ...(role === "tts" ? { defaultVoice, voices } : {}),
    files: publicModelFiles,
  });
  const projection = artifactGraphIdentityProjection({
    providerId: normalizedProviderId,
    role,
    model: normalizedModel,
    runtime: normalizedRuntime,
    files: normalizedFiles,
    edges: normalizedEdges,
    transforms: normalizedTransforms,
  });
  const computedIdentitySha256 = sha256Text(canonicalJson(projection));
  if (
    identitySha256 !== undefined
    && graphSha256(
      identitySha256,
      "Browser speech artifact graph identitySha256",
      "artifact-graph-identity-sha256-text-required",
      "artifact-graph-identity-sha256-format-mismatch",
    )
      !== computedIdentitySha256
  ) {
    throw artifactGraphTypeError(
      "artifact-graph-identity-sha256-mismatch",
      "Browser speech artifact graph identitySha256 does not match its canonical descriptor.",
    );
  }
  const graph = Object.freeze({
    ...projection,
    identitySha256: computedIdentitySha256,
    artifactGraphStatus: "artifact-graph-descriptor-verified",
  });
  ARTIFACT_GRAPHS.add(graph);
  ARTIFACT_GRAPH_METADATA.set(graph, Object.freeze({
    graph,
    files: Object.freeze(normalizedFiles),
    filesByPath,
    runtimeFiles,
    modelFiles,
    model: normalizedModel,
    runtime: normalizedRuntime,
    edges: normalizedEdges,
    transforms: normalizedTransforms,
  }));
  return graph;
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
    model.files ?? [],
    "Browser speech model",
    "model",
    modelRevision,
    { allowEmpty: normalizedSecurity.secure !== true },
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
  const wasmPaths = runtime.wasmPaths === undefined
    ? null
    : immutableUrl(runtime.wasmPaths, "Browser speech runtime wasmPaths");
  if (normalizedSecurity.secure === true && wasmPaths !== null) {
    throw new TypeError(
      "Secure browser speech must materialize its ONNX runtime files instead of using remote wasmPaths.",
    );
  }
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
    ...(wasmPaths === null ? {} : { wasmPaths }),
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
      ...(wasmPaths === null ? {} : { wasmPaths }),
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

function storedArtifactProjection(authority) {
  if (ARTIFACT_GRAPHS.has(authority)) {
    return Object.freeze({
      protocol: authority.protocol,
      kind: authority.kind,
      identitySha256: authority.identitySha256,
      providerId: authority.providerId,
      role: authority.role,
      model: authority.model,
      runtime: authority.runtime,
      files: authority.files,
      edges: authority.edges,
      transforms: authority.transforms,
    });
  }
  return authorityProjection(authority);
}

function artifactMetadata(authority) {
  return ARTIFACT_GRAPH_METADATA.get(authority)
    ?? AUTHORITY_METADATA.get(authority)
    ?? null;
}

function isSpeechArtifactAuthority(authority) {
  return AUTHORITIES.has(authority) || ARTIFACT_GRAPHS.has(authority);
}

function storageKey(authority) {
  if (ARTIFACT_GRAPHS.has(authority)) return authority.identitySha256;
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
  const expectedSchema = ARTIFACT_GRAPHS.has(authority)
    ? ARTIFACT_GRAPH_MANIFEST_SCHEMA
    : MANIFEST_SCHEMA;
  return manifest?.schema === expectedSchema
    && manifest.complete === true
    && JSON.stringify(manifest.authority) === JSON.stringify(storedArtifactProjection(authority))
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

async function assertSelfContainedRuntime(admitted, metadata, security) {
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
  if (security?.secure === true) {
    assertSelfContainedModuleSource(await file.text(), descriptor.path);
  }
}

function tokenizeArtifactGraphModule(source, modulePath) {
  const tokens = [];
  let index = 0;

  function fail(reason, message) {
    throw artifactGraphError(reason, `${modulePath}: ${message}`);
  }

  function identifierStart(character) {
    return /[A-Za-z_$]/u.test(character ?? "");
  }

  function identifierPart(character) {
    return /[A-Za-z0-9_$]/u.test(character ?? "");
  }

  function readEscape() {
    if (index >= source.length) {
      fail("artifact-graph-javascript-escape-unterminated", "unterminated escape sequence.");
    }
    const character = source[index];
    index += 1;
    if (character === "x") {
      const hex = source.slice(index, index + 2);
      if (!/^[a-f0-9]{2}$/iu.test(hex)) {
        fail("artifact-graph-javascript-hexadecimal-escape-malformed", "malformed hexadecimal escape sequence.");
      }
      index += 2;
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    if (character === "u") {
      if (source[index] === "{") {
        const end = source.indexOf("}", index + 1);
        const hex = end < 0 ? "" : source.slice(index + 1, end);
        if (!/^[a-f0-9]{1,6}$/iu.test(hex)) {
          fail("artifact-graph-javascript-unicode-code-point-escape-malformed", "malformed Unicode escape sequence.");
        }
        const codePoint = Number.parseInt(hex, 16);
        if (codePoint > 0x10ffff) {
          fail("artifact-graph-javascript-unicode-code-point-out-of-range", "Unicode escape exceeds the valid range.");
        }
        index = end + 1;
        return String.fromCodePoint(codePoint);
      }
      const hex = source.slice(index, index + 4);
      if (!/^[a-f0-9]{4}$/iu.test(hex)) {
        fail("artifact-graph-javascript-unicode-escape-malformed", "malformed Unicode escape sequence.");
      }
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
      } else if (character === quote) {
        tokens.push(Object.freeze({ type: "string", value, start, end: index }));
        return;
      } else if (character === "\n" || character === "\r") {
        fail("artifact-graph-javascript-quoted-string-line-break-rejected", "quoted string contains a line break.");
      } else {
        value += character;
      }
    }
    fail("artifact-graph-javascript-quoted-string-unterminated", "unterminated quoted string.");
  }

  function skipRegex() {
    index += 1;
    let inClass = false;
    while (index < source.length) {
      const character = source[index];
      index += 1;
      if (character === "\\") {
        index += 1;
      } else if (character === "[") {
        inClass = true;
      } else if (character === "]") {
        inClass = false;
      } else if (character === "/" && !inClass) {
        while (/[A-Za-z]/u.test(source[index] ?? "")) index += 1;
        return;
      } else if (character === "\n" || character === "\r") {
        fail("artifact-graph-javascript-regexp-line-break-rejected", "regular expression contains a line break.");
      }
    }
    fail("artifact-graph-javascript-regexp-unterminated", "unterminated regular expression.");
  }

  function canStartRegex(lastToken) {
    return !lastToken
      || [
        "(", "[", "{", "=", ":", ",", ";", "!", "?", "&&", "||",
        "=>", "return", "case", "throw", "else", "do", "in", "of",
      ].includes(lastToken.value);
  }

  function readTemplate() {
    index += 1;
    while (index < source.length) {
      const character = source[index];
      index += 1;
      if (character === "\\") {
        readEscape();
      } else if (character === "`") {
        return;
      } else if (character === "$" && source[index] === "{") {
        index += 1;
        scanCode(true);
      }
    }
    fail("artifact-graph-javascript-template-literal-unterminated", "unterminated template literal.");
  }

  function scanCode(stopAtTemplateBrace = false) {
    let nestedBraces = 0;
    let lastToken = tokens[tokens.length - 1] ?? null;
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
        if (end < 0) {
          fail("artifact-graph-javascript-block-comment-unterminated", "unterminated block comment.");
        }
        index = end + 2;
        continue;
      }
      if (character === "'" || character === '"') {
        readQuoted(character);
        lastToken = tokens[tokens.length - 1];
        continue;
      }
      if (character === "`") {
        readTemplate();
        lastToken = Object.freeze({ type: "template", value: "template" });
        continue;
      }
      if (character === "/" && canStartRegex(lastToken)) {
        skipRegex();
        lastToken = Object.freeze({ type: "regexp", value: "regexp" });
        continue;
      }
      if (identifierStart(character)) {
        const start = index;
        index += 1;
        while (identifierPart(source[index])) index += 1;
        const token = Object.freeze({
          type: "identifier",
          value: source.slice(start, index),
          start,
          end: index,
        });
        tokens.push(token);
        lastToken = token;
        continue;
      }
      if (character === "\\") {
        fail("artifact-graph-javascript-escaped-identifier-rejected", "escaped identifier is not admitted.");
      }
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
      const value = [
        "&&", "||", "=>", "?.", "??", "==", "!=", "<=", ">=", "++", "--",
      ].includes(twoCharacters)
        ? twoCharacters
        : character;
      const token = Object.freeze({
        type: "punctuation",
        value,
        start: index,
        end: index + value.length,
      });
      tokens.push(token);
      index += value.length;
      lastToken = token;
    }
    if (stopAtTemplateBrace) {
      fail("artifact-graph-javascript-template-expression-unterminated", "unterminated template expression.");
    }
  }

  scanCode();
  return Object.freeze(tokens);
}

function artifactGraphDeclarationsByModule(values) {
  const result = new Map();
  for (const value of values) {
    const entries = result.get(value.modulePath) ?? [];
    entries.push(value);
    result.set(value.modulePath, entries);
  }
  for (const entries of result.values()) {
    entries.sort((left, right) => left.occurrence - right.occurrence);
  }
  return result;
}

function assertArtifactGraphOccurrences(observed, declared, modulePath, subject) {
  if (observed.length !== declared.length) {
    throw artifactGraphError(
      observed.length > declared.length
        ? "artifact-graph-runtime-edge-undeclared"
        : "artifact-graph-runtime-edge-declaration-unmatched",
      `${modulePath} exposes ${String(observed.length)} ${subject} occurrence(s), but the graph declares ${String(declared.length)}.`,
    );
  }
  for (let index = 0; index < declared.length; index += 1) {
    if (declared[index].occurrence !== index + 1) {
      throw artifactGraphError(
        "artifact-graph-runtime-edge-occurrence-noncanonical",
        `${modulePath} ${subject} declarations must use contiguous one-based occurrence values.`,
      );
    }
  }
}

function inspectArtifactGraphModuleSource(source, modulePath, metadata, {
  strict = false,
} = {}) {
  const tokens = tokenizeArtifactGraphModule(source, modulePath);
  const staticImports = [];
  const dynamicImports = [];
  const fetches = [];
  const moduleWorkers = [];
  const cacheOpens = [];
  const returnThisTransforms = [];
  const typedArrayConstructors = [];
  const warnings = new Set();
  const forbiddenDynamicCode = new Set([
    "AsyncFunction",
    "AsyncGeneratorFunction",
    "BroadcastChannel",
    "GeneratorFunction",
    "RTCPeerConnection",
    "ShadowRealm",
    "eval",
    "importScripts",
    "WebSocketStream",
  ]);

  function next(index, offset = 1) {
    return tokens[index + offset] ?? null;
  }

  function previous(index, offset = 1) {
    return tokens[index - offset] ?? null;
  }

  function recordGuardCall(target, index, kind) {
    const token = tokens[index];
    const opening = next(index);
    if (opening?.value !== "(") {
      throw artifactGraphError(
        `artifact-graph-runtime-${kind.toLowerCase()}-direct-call-required`,
        `${modulePath} references ${kind} outside an admitted direct call boundary.`,
      );
    }
    let start = token.start;
    if (previous(index)?.value === ".") {
      if (!["globalThis", "self"].includes(previous(index, 2)?.value)) {
        throw artifactGraphError(
          `artifact-graph-runtime-${kind.toLowerCase()}-receiver-not-global`,
          `${modulePath} calls ${kind} through a non-global receiver.`,
        );
      }
      start = previous(index, 2).start;
    }
    target.push(Object.freeze({ start, end: opening.end }));
  }

  function typedArrayConstructor(index) {
    const opening = next(index);
    if (opening?.value !== "(") return null;
    const property = previous(index, 2);
    if (property?.type !== "identifier") return null;
    if (previous(index, 3)?.value === "new") {
      return Object.freeze({
        start: property.start,
        end: tokens[index].end,
        receiver: source.slice(property.start, property.end),
      });
    }
    if (
      previous(index, 3)?.value === "."
      && previous(index, 4)?.value === "]"
      && previous(index, 5)?.value === "0"
      && previous(index, 6)?.value === "["
      && previous(index, 7)?.type === "identifier"
      && previous(index, 8)?.value === "new"
    ) {
      return Object.freeze({
        start: previous(index, 7).start,
        end: tokens[index].end,
        receiver: source.slice(previous(index, 7).start, property.end),
      });
    }
    return null;
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (
      (token.type === "identifier" || token.type === "string")
      && token.value === ARTIFACT_GRAPH_GUARDS
    ) {
      throw artifactGraphError(
        "artifact-graph-runtime-guard-reference-reserved",
        `${modulePath} references the SDK-owned artifact graph runtime guard name.`,
      );
    }
    if (
      token.type === "string"
      && [
        "Function",
        "BroadcastChannel",
        "RTCPeerConnection",
        "ShadowRealm",
        "SharedWorker",
        "Worker",
        "WebSocketStream",
        "XMLHttpRequest",
        "constructor",
        "eval",
        "fetch",
        "importScripts",
      ].includes(token.value)
      && previous(index)?.value === "["
      && next(index)?.value === "]"
    ) {
      if (strict) {
        throw artifactGraphError(
          "artifact-graph-runtime-computed-dynamic-code-undeclared",
          `${modulePath} contains computed access to dynamic code capability ${token.value}.`,
        );
      }
      warnings.add(token.value);
      continue;
    }
    if (token.type !== "identifier") continue;
    if (forbiddenDynamicCode.has(token.value)) {
      if (strict) {
        throw artifactGraphError(
          "artifact-graph-runtime-dynamic-code-undeclared",
          `${modulePath} contains dynamic code capability ${token.value}, which is not admitted.`,
        );
      }
      warnings.add(token.value);
      continue;
    }
    if (token.value === "Function") {
      const sequence = [
        next(index)?.value,
        next(index, 2)?.value,
        next(index, 3)?.value,
        next(index, 4)?.value,
        next(index, 5)?.value,
      ];
      if (
        [".", "?."].includes(previous(index)?.value)
        || previous(index)?.value === "new"
        || sequence[0] !== "("
        || next(index, 2)?.type !== "string"
        || sequence[1].trim() !== "return this"
        || sequence[2] !== ")"
        || sequence[3] !== "("
        || sequence[4] !== ")"
      ) {
        if (strict) {
          throw artifactGraphError(
            "artifact-graph-runtime-dynamic-code-undeclared",
            `${modulePath} contains a Function constructor outside the sole supported global-object transform.`,
          );
        }
        warnings.add("Function");
        continue;
      }
      returnThisTransforms.push(Object.freeze({
        start: token.start,
        end: next(index, 5).end,
      }));
      index += 5;
      continue;
    }
    if (
      token.value === "caches"
      && next(index)?.value === "."
      && next(index, 2)?.value === "open"
      && next(index, 3)?.value === "("
    ) {
      let start = token.start;
      if (previous(index)?.value === ".") {
        if (!["globalThis", "self"].includes(previous(index, 2)?.value)) {
          throw artifactGraphError(
            "artifact-graph-runtime-cache-open-receiver-not-global",
            `${modulePath} calls CacheStorage.open through a non-global receiver.`,
          );
        }
        start = previous(index, 2).start;
      }
      cacheOpens.push(Object.freeze({ start, end: next(index, 3).end }));
      continue;
    }
    if (token.value === "caches") {
      if (previous(index)?.value === "typeof") continue;
      throw artifactGraphError(
        "artifact-graph-runtime-cache-open-direct-call-required",
        `${modulePath} references CacheStorage outside an admitted direct open call.`,
      );
    }
    if (
      token.value === "constructor"
      && [".", "?."].includes(previous(index)?.value)
      && next(index)?.value === "("
    ) {
      const observed = previous(index)?.value === "." ? typedArrayConstructor(index) : null;
      if (!observed) {
        throw artifactGraphError(
          "artifact-graph-runtime-constructor-dynamic-code-undeclared",
          `${modulePath} calls a constructor property outside the declared typed-array constructor transform.`,
        );
      }
      typedArrayConstructors.push(observed);
      continue;
    }
    if (token.value === "import") {
      if (next(index)?.value === "." && next(index, 2)?.value === "meta") {
        index += 2;
        continue;
      }
      if (next(index)?.value === "(") {
        dynamicImports.push(Object.freeze({ start: token.start, end: next(index).end }));
        continue;
      }
      let specifier = next(index)?.type === "string" ? next(index) : null;
      if (!specifier) {
        for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
          if (tokens[cursor].value === ";") break;
          if (tokens[cursor].value === "from" && next(cursor)?.type === "string") {
            specifier = next(cursor);
            break;
          }
        }
      }
      if (!specifier) {
        throw artifactGraphError(
          "artifact-graph-static-import-specifier-unresolved",
          `${modulePath} contains a static import without one literal specifier.`,
        );
      }
      staticImports.push(Object.freeze({
        start: specifier.start,
        end: specifier.end,
        specifier: specifier.value,
      }));
      continue;
    }
    if (token.value === "export") {
      if (!["*", "{"].includes(next(index)?.value)) continue;
      let specifier = null;
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        if (tokens[cursor].value === ";") break;
        if (tokens[cursor].value === "from" && next(cursor)?.type === "string") {
          specifier = next(cursor);
          break;
        }
        if (["export", "import"].includes(tokens[cursor].value)) break;
      }
      if (specifier) {
        staticImports.push(Object.freeze({
          start: specifier.start,
          end: specifier.end,
          specifier: specifier.value,
        }));
      }
      continue;
    }
    if (token.value === "fetch") {
      recordGuardCall(fetches, index, "fetch");
      continue;
    }
    if (token.value === "Worker") {
      const opening = next(index);
      if (opening?.value !== "(") {
        if (strict) {
          throw artifactGraphError(
            "artifact-graph-runtime-worker-constructor-call-required",
            `${modulePath} references Worker outside an admitted constructor boundary.`,
          );
        }
        warnings.add("Worker");
        continue;
      }
      let start = token.start;
      if (previous(index)?.value === "new") {
        start = previous(index).start;
      } else if (previous(index)?.value === ".") {
        if (!["globalThis", "self"].includes(previous(index, 2)?.value)) {
          if (strict) {
            throw artifactGraphError(
              "artifact-graph-runtime-worker-receiver-not-global",
              `${modulePath} constructs Worker through a non-global receiver.`,
            );
          }
          warnings.add("Worker");
          continue;
        }
        start = previous(index, 2).start;
        if (previous(index, 3)?.value === "new") start = previous(index, 3).start;
      }
      moduleWorkers.push(Object.freeze({ start, end: opening.end }));
    }
  }

  const moduleTransforms = artifactGraphDeclarationsByModule(metadata.transforms)
    .get(modulePath) ?? [];
  const declarations = {
    staticImports: artifactGraphDeclarationsByModule(metadata.edges.staticImports)
      .get(modulePath) ?? [],
    dynamicImports: artifactGraphDeclarationsByModule(metadata.edges.dynamicImports)
      .get(modulePath) ?? [],
    fetches: artifactGraphDeclarationsByModule(metadata.edges.fetches)
      .get(modulePath) ?? [],
    moduleWorkers: artifactGraphDeclarationsByModule(metadata.edges.moduleWorkers)
      .get(modulePath) ?? [],
    cacheOpens: artifactGraphDeclarationsByModule(metadata.edges.cacheOpens)
      .get(modulePath) ?? [],
    returnThisTransforms: moduleTransforms.filter((transform) =>
      transform.kind === "function-return-this-to-global-this"),
    typedArrayConstructors: moduleTransforms.filter((transform) =>
      transform.kind === "typed-array-constructor"),
  };
  assertArtifactGraphOccurrences(
    staticImports,
    declarations.staticImports,
    modulePath,
    "static import or re-export",
  );
  assertArtifactGraphOccurrences(
    dynamicImports,
    declarations.dynamicImports,
    modulePath,
    "dynamic import",
  );
  assertArtifactGraphOccurrences(fetches, declarations.fetches, modulePath, "fetch");
  assertArtifactGraphOccurrences(
    moduleWorkers,
    declarations.moduleWorkers,
    modulePath,
    "module Worker",
  );
  assertArtifactGraphOccurrences(
    cacheOpens,
    declarations.cacheOpens,
    modulePath,
    "CacheStorage open",
  );
  assertArtifactGraphOccurrences(
    returnThisTransforms,
    declarations.returnThisTransforms,
    modulePath,
    "Function return-this transform",
  );
  assertArtifactGraphOccurrences(
    typedArrayConstructors,
    declarations.typedArrayConstructors,
    modulePath,
    "typed-array constructor transform",
  );
  for (let index = 0; index < staticImports.length; index += 1) {
    if (staticImports[index].specifier !== declarations.staticImports[index].specifier) {
      throw artifactGraphError(
        "artifact-graph-static-import-specifier-mismatch",
        `${modulePath} static import occurrence ${String(index + 1)} does not match its declared specifier.`,
      );
    }
  }
  return Object.freeze({
    source,
    staticImports: Object.freeze(staticImports),
    dynamicImports: Object.freeze(dynamicImports),
    fetches: Object.freeze(fetches),
    moduleWorkers: Object.freeze(moduleWorkers),
    cacheOpens: Object.freeze(cacheOpens),
    returnThisTransforms: Object.freeze(returnThisTransforms),
    typedArrayConstructors: Object.freeze(typedArrayConstructors),
    warnings: Object.freeze([...warnings].sort()),
    declarations,
  });
}

function assertArtifactGraphStaticImportClosure(metadata) {
  const dependencies = new Map(metadata.runtimeFiles
    .filter((file) => ARTIFACT_GRAPH_JAVASCRIPT_KINDS.has(file.kind))
    .map((file) => [file.path, []]));
  for (const edge of metadata.edges.staticImports) {
    dependencies.get(edge.modulePath).push(edge.targetPath);
  }
  const visiting = new Set();
  const visited = new Set();
  const order = [];
  function visit(path) {
    if (visiting.has(path)) {
      throw artifactGraphError(
        "artifact-graph-runtime-static-import-cycle",
        `Artifact graph static imports contain a cycle at ${path}.`,
      );
    }
    if (visited.has(path)) return;
    visiting.add(path);
    for (const dependency of dependencies.get(path) ?? []) visit(dependency);
    visiting.delete(path);
    visited.add(path);
    order.push(path);
  }
  for (const path of [...dependencies.keys()].sort()) visit(path);
  return Object.freeze(order);
}

async function inspectArtifactGraphRuntime(admitted, metadata, signal, security) {
  if (security?.secure !== true) {
    return Object.freeze({
      plans: new Map(),
      order: Object.freeze([]),
      warnings: Object.freeze(["artifact-graph-runtime-unchecked"]),
    });
  }
  const admittedByPath = new Map(admitted.files.map((entry) => [entry.descriptor.path, entry]));
  const plans = new Map();
  for (const descriptor of metadata.runtimeFiles) {
    throwIfAborted(signal);
    if (!ARTIFACT_GRAPH_JAVASCRIPT_KINDS.has(descriptor.kind)) continue;
    const file = admittedByPath.get(descriptor.path)?.file;
    if (!file) {
      throw artifactGraphError(
        "artifact-graph-runtime-javascript-file-missing",
        `Artifact graph runtime JavaScript file ${descriptor.path} is unavailable.`,
      );
    }
    let source;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw artifactGraphError(
        "artifact-graph-runtime-javascript-utf8-decode-rejected",
        `Artifact graph runtime JavaScript file ${descriptor.path} is not valid UTF-8.`,
        error,
      );
    }
    plans.set(
      descriptor.path,
      inspectArtifactGraphModuleSource(source, descriptor.path, metadata, {
        strict: security?.secure === true,
      }),
    );
  }
  const order = assertArtifactGraphStaticImportClosure(metadata);
  const warnings = [...new Set([...plans.values()].flatMap((plan) => plan.warnings))]
    .sort();
  if (security?.secure !== true && warnings.length > 0) {
    globalThis.console?.warn?.(
      `Arcane browser speech warn-first mode allowed runtime capabilities: ${warnings.join(", ")}.`,
    );
  }
  throwIfAborted(signal);
  return Object.freeze({ plans, order, warnings: Object.freeze(warnings) });
}

function applyArtifactGraphModuleTransforms(plan, materializedByPath, guardCapability) {
  const replacements = [];
  for (let index = 0; index < plan.staticImports.length; index += 1) {
    const observed = plan.staticImports[index];
    const declared = plan.declarations.staticImports[index];
    const targetUrl = materializedByPath.get(declared.targetPath)?.moduleUrl;
    if (!targetUrl) {
      throw artifactGraphError(
        "artifact-graph-static-import-target-unmaterialized",
        `Static import target ${declared.targetPath} was not materialized before ${declared.modulePath}.`,
      );
    }
    replacements.push({
      start: observed.start,
      end: observed.end,
      value: JSON.stringify(targetUrl),
    });
  }
  for (let index = 0; index < plan.dynamicImports.length; index += 1) {
    const observed = plan.dynamicImports[index];
    const declared = plan.declarations.dynamicImports[index];
    replacements.push({
      start: observed.start,
      end: observed.end,
      value: `globalThis.${ARTIFACT_GRAPH_GUARDS}.dynamicImport(${JSON.stringify(guardCapability)},${JSON.stringify(declared.modulePath)},${String(declared.occurrence)},`,
    });
  }
  for (let index = 0; index < plan.fetches.length; index += 1) {
    const observed = plan.fetches[index];
    const declared = plan.declarations.fetches[index];
    replacements.push({
      start: observed.start,
      end: observed.end,
      value: `globalThis.${ARTIFACT_GRAPH_GUARDS}.fetch(${JSON.stringify(guardCapability)},${JSON.stringify(declared.modulePath)},${String(declared.occurrence)},`,
    });
  }
  for (let index = 0; index < plan.moduleWorkers.length; index += 1) {
    const observed = plan.moduleWorkers[index];
    const declared = plan.declarations.moduleWorkers[index];
    replacements.push({
      start: observed.start,
      end: observed.end,
      value: `globalThis.${ARTIFACT_GRAPH_GUARDS}.createWorker(${JSON.stringify(guardCapability)},${JSON.stringify(declared.modulePath)},${String(declared.occurrence)},`,
    });
  }
  for (let index = 0; index < plan.cacheOpens.length; index += 1) {
    const observed = plan.cacheOpens[index];
    const declared = plan.declarations.cacheOpens[index];
    replacements.push({
      start: observed.start,
      end: observed.end,
      value: `globalThis.${ARTIFACT_GRAPH_GUARDS}.openCache(${JSON.stringify(guardCapability)},${JSON.stringify(declared.modulePath)},${String(declared.occurrence)},`,
    });
  }
  for (const observed of plan.returnThisTransforms) {
    replacements.push({ start: observed.start, end: observed.end, value: "globalThis" });
  }
  for (let index = 0; index < plan.typedArrayConstructors.length; index += 1) {
    const observed = plan.typedArrayConstructors[index];
    const declared = plan.declarations.typedArrayConstructors[index];
    replacements.push({
      start: observed.start,
      end: observed.end,
      value: `(globalThis.${ARTIFACT_GRAPH_GUARDS}.typedArrayConstructor(${JSON.stringify(guardCapability)},${JSON.stringify(declared.modulePath)},${String(declared.occurrence)},${observed.receiver}))`,
    });
  }
  replacements.sort((left, right) => right.start - left.start);
  let source = plan.source;
  let previousStart = source.length;
  for (const replacement of replacements) {
    if (replacement.end > previousStart) {
      throw artifactGraphError(
        "artifact-graph-module-transform-overlap",
        "Artifact graph module transforms overlap and cannot be applied deterministically.",
      );
    }
    source = `${source.slice(0, replacement.start)}${replacement.value}${source.slice(replacement.end)}`;
    previousStart = replacement.start;
  }
  return source;
}

function artifactGraphGuardCapability() {
  const crypto = globalThis.crypto;
  if (typeof crypto?.getRandomValues !== "function") {
    throw artifactGraphError(
      "artifact-graph-guard-capability-unavailable",
      "Authenticated artifact graph materialization requires cryptographic random values.",
    );
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function blobDigest(blob) {
  const digest = createStreamingSha256();
  let bytes = 0;
  for await (const chunk of byteChunks(blob.stream())) {
    digest.update(chunk);
    bytes += chunk.byteLength;
  }
  return Object.freeze({ bytes, sha256: digest.digestHex() });
}

async function createArtifactGraphObjectUrls(admitted, metadata, inspection, security) {
  if (
    typeof PLATFORM_CREATE_OBJECT_URL !== "function"
    || typeof PLATFORM_REVOKE_OBJECT_URL !== "function"
    || typeof PLATFORM_FETCH !== "function"
  ) {
    throw artifactGraphError(
      "artifact-graph-object-url-platform-unavailable",
      "Authenticated artifact graph materialization requires native Blob URL creation, revocation, and fetch.",
    );
  }
  const admittedByPath = new Map(admitted.files.map((entry) => [entry.descriptor.path, entry]));
  const materializedByPath = new Map();
  const created = [];
  const createdIdentities = new Set();
  const guardCapability = artifactGraphGuardCapability();
  async function materialize(descriptor, body) {
    const blob = body instanceof Blob && body.type === descriptor.mediaType
      ? body
      : new Blob([body], { type: descriptor.mediaType });
    const source = await blobDigest(blob);
    const transformed = ARTIFACT_GRAPH_JAVASCRIPT_KINDS.has(descriptor.kind);
    const expected = Object.freeze({
      bytes: transformed || security.checks.byteLength !== true
        ? source.bytes
        : descriptor.bytes,
      sha256: transformed || security.checks.sha256 !== true
        ? source.sha256
        : descriptor.sha256,
    });
    const moduleUrl = PLATFORM_CREATE_OBJECT_URL(blob);
    if (typeof moduleUrl !== "string" || !moduleUrl.startsWith("blob:")) {
      throw artifactGraphError(
        "artifact-graph-object-url-scheme-not-blob",
        `Materialized artifact graph file ${descriptor.path} did not produce a Blob URL.`,
      );
    }
    if (createdIdentities.has(moduleUrl)) {
      throw artifactGraphError(
        "artifact-graph-object-url-identity-ambiguous",
        `Materialized artifact graph file ${descriptor.path} reused another file's Blob URL.`,
      );
    }
    createdIdentities.add(moduleUrl);
    created.push(moduleUrl);
    let response;
    try {
      response = await PLATFORM_FETCH(moduleUrl, {
        method: "GET",
        credentials: "omit",
        redirect: "error",
      });
    } catch (error) {
      throw artifactGraphError(
        "artifact-graph-object-url-readback-unavailable",
        `Materialized artifact graph file ${descriptor.path} could not be read back from its Blob URL.`,
        error,
      );
    }
    if (!response.ok) {
      throw artifactGraphError(
        "artifact-graph-object-url-readback-http-status-rejected",
        `Materialized artifact graph file ${descriptor.path} returned a non-success Blob URL response.`,
      );
    }
    if (response.redirected || response.url !== moduleUrl) {
      throw artifactGraphError(
        "artifact-graph-object-url-readback-identity-mismatch",
        `Materialized artifact graph file ${descriptor.path} did not retain its exact Blob URL identity.`,
      );
    }
    const observedMediaType = response.headers.get("content-type")?.split(";", 1)[0].trim() ?? "";
    if (observedMediaType !== descriptor.mediaType) {
      throw artifactGraphError(
        "artifact-graph-object-url-media-type-mismatch",
        `Materialized artifact graph file ${descriptor.path} did not retain its declared media type.`,
      );
    }
    const observedBlob = await response.blob();
    const observed = await blobDigest(observedBlob);
    if (observed.bytes !== expected.bytes) {
      throw artifactGraphError(
        "artifact-graph-object-url-byte-length-mismatch",
        `Materialized artifact graph file ${descriptor.path} did not retain its exact byte length.`,
      );
    }
    if (observed.sha256 !== expected.sha256) {
      throw artifactGraphError(
        "artifact-graph-object-url-sha256-mismatch",
        `Materialized artifact graph file ${descriptor.path} did not retain its exact bytes.`,
      );
    }
    materializedByPath.set(descriptor.path, Object.freeze({
      kind: descriptor.kind,
      path: descriptor.path,
      sourceUrl: descriptor.sourceUrl,
      revision: descriptor.revision,
      license: descriptor.license,
      moduleUrl,
      mediaType: descriptor.mediaType,
      ...(descriptor.sourceMediaType === descriptor.mediaType
        ? {}
        : { sourceMediaType: descriptor.sourceMediaType }),
      bytes: descriptor.bytes,
      sha256: descriptor.sha256,
      runtimeRequestUrls: descriptor.runtimeRequestUrls,
      ...(descriptor.redirectFinalOrigins.length < 1
        ? {}
        : { redirectFinalOrigins: descriptor.redirectFinalOrigins }),
    }));
  }
  try {
    for (const descriptor of metadata.files) {
      if (ARTIFACT_GRAPH_JAVASCRIPT_KINDS.has(descriptor.kind)) continue;
      await materialize(descriptor, admittedByPath.get(descriptor.path).file);
    }
    for (const path of inspection.order) {
      const descriptor = metadata.filesByPath.get(path);
      const plan = inspection.plans.get(path);
      await materialize(
        descriptor,
        applyArtifactGraphModuleTransforms(plan, materializedByPath, guardCapability),
      );
    }
    return Object.freeze({
      guardCapability,
      files: Object.freeze(metadata.files.map((descriptor) =>
        materializedByPath.get(descriptor.path))),
      release() {
        for (const url of created.splice(0).reverse()) {
          try {
            PLATFORM_REVOKE_OBJECT_URL(url);
          } catch {
            // Object URL revocation follows worker termination and is best effort.
          }
        }
      },
    });
  } catch (error) {
    for (const url of created.splice(0).reverse()) {
      try {
        PLATFORM_REVOKE_OBJECT_URL(url);
      } catch {
        // Preserve the graph inspection or materialization error.
      }
    }
    throw error;
  }
}

function artifactGraphAdmissionStatus(cache, offline, security) {
  const verification = security.checks.byteLength && security.checks.sha256
    ? "verified"
    : security.checks.byteLength || security.checks.sha256
      ? "partially-checked"
      : "unchecked";
  const source = cache === "installed"
    ? "network-dbopfs"
    : offline
      ? "offline-dbopfs-cache"
      : "dbopfs-cache";
  return `artifact-graph-${source}-${verification}`;
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
    if (!isSpeechArtifactAuthority(authority)) {
      throw new TypeError("Speech artifact removal requires an SDK-created authority.");
    }
    const metadata = artifactMetadata(authority);
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

  function graphFileReason(descriptor, boundary) {
    const subject = descriptor.kind === "runtime-entrypoint-javascript"
      ? "entrypoint"
      : descriptor.kind;
    return `artifact-graph-${subject}-${boundary}`;
  }

  function graphVerificationError(descriptor, boundary, message) {
    return artifactGraphError(graphFileReason(descriptor, boundary), message);
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
    const graph = ARTIFACT_GRAPHS.has(authority);
    const metadata = artifactMetadata(authority);
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
      if (
        !file
        || observed?.path !== descriptor.path
        || observed?.bytes !== file.size
        || (graph && observed?.sha256 !== descriptor.sha256)
      ) {
        await removeUnlocked(authority);
        return null;
      }
      if (!await verifyFile(
        file,
        descriptor,
        security,
        signal,
        onProgress,
        graph
          ? security.checks.sha256
            ? "artifact-graph-dbopfs-cache-rehash"
            : "artifact-graph-dbopfs-cache-readback"
          : "verify-cache",
      )) {
        await removeUnlocked(authority);
        return null;
      }
      files.push({ descriptor, file });
    }
    try {
      const inspection = graph && security.secure
        ? await inspectArtifactGraphRuntime({ files }, metadata, signal, security)
        : graph
          ? null
          : (await assertSelfContainedRuntime({ files }, metadata, security), null);
      throwIfAborted(signal);
      return Object.freeze({
        files: Object.freeze(files),
        cache: "cached",
        inspection,
      });
    } catch (error) {
      await removeUnlocked(authority);
      throw error;
    }
  }

  async function install(authority, { signal, onProgress, security } = {}) {
    const graph = ARTIFACT_GRAPHS.has(authority);
    const metadata = artifactMetadata(authority);
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
        const sourceUrl = graph ? descriptor.sourceUrl : descriptor.url;
        const redirectFinalOrigins = graph
          ? descriptor.redirectFinalOrigins
          : Object.freeze([]);
        let response;
        try {
          response = await fetchFunction(sourceUrl, {
            cache: "no-store",
            credentials: "omit",
            mode: "cors",
            redirect: redirectFinalOrigins.length < 1 ? "error" : "follow",
            referrerPolicy: "no-referrer",
            signal,
          });
        } catch (error) {
          if (signal?.aborted || error?.name === "AbortError") throwIfAborted(signal);
          if (graph) {
            throw artifactGraphError(
              "artifact-graph-source-fetch-rejected",
              `Artifact graph source fetch was rejected for ${descriptor.path}.`,
              error,
            );
          }
          throw speechError("ARCANE_AI_ARTIFACT_DOWNLOAD_FAILED", "A speech artifact source fetch was rejected.", error);
        }
        let responseBody;
        let responseHeaders;
        let responseOk;
        let responseRedirected;
        let responseStatus;
        let responseUrl;
        try {
          if (!response || typeof response !== "object") {
            throw new TypeError("The artifact fetch result is not an object.");
          }
          responseBody = response.body;
          responseHeaders = response.headers;
          responseOk = response.ok;
          responseRedirected = response.redirected;
          responseStatus = response.status;
          responseUrl = response.url;
          if (
            typeof responseOk !== "boolean"
            || typeof responseRedirected !== "boolean"
            || !Number.isInteger(responseStatus)
            || typeof responseUrl !== "string"
            || !responseHeaders
            || typeof responseHeaders.get !== "function"
            || (responseBody !== null && typeof responseBody?.getReader !== "function")
          ) {
            throw new TypeError("The artifact fetch result is not a readable Fetch Response.");
          }
        } catch (error) {
          if (graph) {
            throw artifactGraphError(
              "artifact-graph-source-http-response-rejected",
              `Artifact graph source fetch for ${descriptor.path} did not return a readable Fetch Response.`,
              error,
            );
          }
          throw speechError(
            "ARCANE_AI_ARTIFACT_DOWNLOAD_FAILED",
            "A speech artifact source fetch did not return a readable Fetch Response.",
            error,
          );
        }
        let finalUrl = null;
        let finalUrlRecord = null;
        try {
          finalUrlRecord = responseUrl
            ? new URL(responseUrl)
            : null;
          finalUrl = finalUrlRecord?.href ?? null;
        } catch {
          finalUrlRecord = null;
          finalUrl = null;
        }
        if (graph && responseRedirected && !finalUrlRecord) {
          await responseBody?.cancel?.().catch(() => undefined);
          throw artifactGraphError(
            "artifact-graph-source-response-url-unreadable",
            `Artifact graph redirected source response for ${descriptor.path} did not expose a readable final URL.`,
          );
        }
        if (graph && responseRedirected && redirectFinalOrigins.length < 1) {
          await responseBody?.cancel?.().catch(() => undefined);
          throw artifactGraphError(
            "artifact-graph-source-redirected",
            `Artifact graph source response for ${descriptor.path} did not match its immutable URL.`,
          );
        }
        if (graph && responseRedirected && finalUrlRecord.protocol !== "https:") {
          await responseBody?.cancel?.().catch(() => undefined);
          throw artifactGraphError(
            "artifact-graph-source-response-url-protocol-not-https",
            `Artifact graph redirected source response for ${descriptor.path} did not end at HTTPS.`,
          );
        }
        if (
          graph
          && responseRedirected
          && (finalUrlRecord.username || finalUrlRecord.password)
        ) {
          await responseBody?.cancel?.().catch(() => undefined);
          throw artifactGraphError(
            "artifact-graph-source-response-url-credentials-rejected",
            `Artifact graph redirected source response for ${descriptor.path} exposed credentials in its final URL.`,
          );
        }
        if (graph && responseRedirected && finalUrlRecord.hash) {
          await responseBody?.cancel?.().catch(() => undefined);
          throw artifactGraphError(
            "artifact-graph-source-response-url-fragment-rejected",
            `Artifact graph redirected source response for ${descriptor.path} exposed a fragment in its final URL.`,
          );
        }
        if (
          graph
          && responseRedirected
          && !redirectFinalOrigins.includes(finalUrlRecord.origin)
        ) {
          await responseBody?.cancel?.().catch(() => undefined);
          throw artifactGraphError(
            "artifact-graph-source-redirect-final-origin-mismatch",
            `Artifact graph redirected source response for ${descriptor.path} ended at an undeclared final origin.`,
          );
        }
        if (graph && !responseRedirected && finalUrl !== sourceUrl) {
          await responseBody?.cancel?.().catch(() => undefined);
          throw artifactGraphError(
            "artifact-graph-source-response-url-mismatch",
            `Artifact graph non-redirected source response for ${descriptor.path} did not retain its immutable URL.`,
          );
        }
        if (!graph && (responseRedirected || finalUrl !== sourceUrl)) {
          await responseBody?.cancel?.().catch(() => undefined);
          throw speechError(
            "ARCANE_AI_ARTIFACT_SOURCE_CHANGED",
            "A speech artifact response did not match its admitted URL.",
          );
        }
        if (!responseOk || !responseBody) {
          await responseBody?.cancel?.().catch(() => undefined);
          if (graph) {
            throw artifactGraphError(
              "artifact-graph-source-http-response-rejected",
              `Artifact graph source for ${descriptor.path} returned HTTP ${String(responseStatus)}.`,
            );
          }
          throw speechError(
            "ARCANE_AI_ARTIFACT_DOWNLOAD_FAILED",
            `A speech artifact server returned HTTP ${String(responseStatus)}.`,
          );
        }
        const header = responseHeaders.get("content-length");
        const reportedBytes = header ? Number(header) : null;
        const contentEncoding = responseHeaders.get("content-encoding")?.trim() ?? "";
        if (graph) {
          const reportedMediaType = responseHeaders.get("content-type")
            ?.split(";", 1)[0]
            ?.trim()
            ?.toLowerCase() ?? null;
          if (reportedMediaType !== descriptor.sourceMediaType) {
            await responseBody.cancel?.().catch(() => undefined);
            throw graphVerificationError(
              descriptor,
              descriptor.sourceMediaType === descriptor.mediaType
                ? "media-type-mismatch"
                : "source-media-type-mismatch",
              `Artifact graph source media type for ${descriptor.path} did not match ${descriptor.sourceMediaType}.`,
            );
          }
        }
        if (
          security.checks.byteLength
          && Number.isSafeInteger(reportedBytes)
          && (!graph || !contentEncoding)
          && reportedBytes !== descriptor.bytes
        ) {
          await responseBody.cancel?.().catch(() => undefined);
          if (graph) {
            throw graphVerificationError(
              descriptor,
              "byte-length-mismatch",
              `Artifact graph source Content-Length for ${descriptor.path} changed.`,
            );
          }
          throw speechError("ARCANE_AI_ARTIFACT_SIZE_MISMATCH", "Speech artifact Content-Length changed.");
        }
        const digest = security.checks.sha256
          ? createStreamingSha256()
          : null;
        const written = await writeFile(names.files[index], responseBody, {
          signal,
          onChunk(chunk, completed) {
            digest?.update(chunk);
            if (security.checks.byteLength && completed > descriptor.bytes) {
              if (graph) {
                throw graphVerificationError(
                  descriptor,
                  "byte-length-mismatch",
                  `Artifact graph source ${descriptor.path} exceeded its declared byte length.`,
                );
              }
              throw speechError("ARCANE_AI_ARTIFACT_SIZE_MISMATCH", "A speech artifact exceeded its expected size.");
            }
            onProgress?.(providerProgress(
              graph ? "artifact-graph-network-download" : "download",
              completed,
              security.checks.byteLength ? descriptor.bytes : null,
            ));
          },
        });
        if (security.checks.byteLength && written !== descriptor.bytes) {
          if (graph) {
            throw graphVerificationError(
              descriptor,
              "byte-length-mismatch",
              `Artifact graph source ${descriptor.path} byte length changed.`,
            );
          }
          throw speechError("ARCANE_AI_ARTIFACT_SIZE_MISMATCH", "A speech artifact byte count changed.");
        }
        if (digest && digest.digestHex() !== descriptor.sha256) {
          if (graph) {
            throw graphVerificationError(
              descriptor,
              "sha256-mismatch",
              `Artifact graph source ${descriptor.path} SHA-256 changed.`,
            );
          }
          throw speechError("ARCANE_AI_ARTIFACT_DIGEST_MISMATCH", "A speech artifact SHA-256 changed.");
        }
        const file = await readFile(names.files[index]);
        if (!file || file.size !== written) {
          if (graph) {
            throw graphVerificationError(
              descriptor,
              "dbopfs-persisted-byte-length-mismatch",
              `DBOPFS did not preserve artifact graph file ${descriptor.path}.`,
            );
          }
          throw speechError("ARCANE_AI_ARTIFACT_CACHE_REJECTED", "DBOPFS did not preserve a speech artifact.");
        }
        if (!await verifyFile(
          file,
          descriptor,
          security,
          signal,
          onProgress,
          graph
            ? security.checks.sha256
              ? "artifact-graph-dbopfs-persisted-rehash"
              : "artifact-graph-dbopfs-persisted-readback"
            : "verify-cache",
        )) {
          if (graph) {
            throw graphVerificationError(
              descriptor,
              "dbopfs-persisted-sha256-mismatch",
              `DBOPFS persisted bytes for artifact graph file ${descriptor.path} were rejected during re-verification.`,
            );
          }
          throw speechError("ARCANE_AI_ARTIFACT_CACHE_REJECTED", "DBOPFS persisted bytes were rejected during verification.");
        }
        installed.push({ descriptor, file });
      }
      const inspection = graph && security.secure
        ? await inspectArtifactGraphRuntime({ files: installed }, metadata, signal, security)
        : graph
          ? null
          : (await assertSelfContainedRuntime({ files: installed }, metadata, security), null);
      throwIfAborted(signal);
      const manifest = Object.freeze({
        schema: graph ? ARTIFACT_GRAPH_MANIFEST_SCHEMA : MANIFEST_SCHEMA,
        complete: true,
        authority: storedArtifactProjection(authority),
        files: Object.freeze(installed.map(({ descriptor, file }) => Object.freeze({
          path: descriptor.path,
          bytes: file.size,
          ...(graph ? { sha256: descriptor.sha256 } : {}),
        }))),
        completedAt: new Date().toISOString(),
      });
      const encoded = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
      await writeFile(names.manifest, encoded, { signal });
      return Object.freeze({
        files: Object.freeze(installed),
        cache: "installed",
        inspection,
      });
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
    if (!isSpeechArtifactAuthority(authority)) {
      throw new TypeError("Speech artifact preparation requires an SDK-created authority.");
    }
    throwIfAborted(signal);
    const graph = ARTIFACT_GRAPHS.has(authority);
    let effectiveSecurity;
    try {
      effectiveSecurity = resolveModelSecurity({ load: security });
    } catch (error) {
      if (graph) {
        throw artifactGraphTypeError(
          "artifact-graph-load-security-contract-rejected",
          "Browser speech artifact graph load security does not satisfy the required contract.",
          error,
        );
      }
      throw error;
    }
    const metadata = artifactMetadata(authority);
    if (graph && effectiveSecurity.secure !== true) {
      throw artifactGraphError(
        "artifact-graph-secure-mode-required",
        "Browser speech artifact graphs require explicit secure:true.",
      );
    }
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
      if (graph) {
        throw artifactGraphError(
          "artifact-graph-offline-cache-miss",
          "No complete verified offline artifact graph cache is available.",
        );
      }
      throw speechError("ARCANE_AI_ARTIFACT_OFFLINE_MISS", "No admitted offline speech cache is available.");
    }
    if (graph) {
      const artifactGraphAdmission = artifactGraphAdmissionStatus(
        admitted.cache,
        offline,
        effectiveSecurity,
      );
      const materialized = await createArtifactGraphObjectUrls(
        admitted,
        metadata,
        admitted.inspection,
        effectiveSecurity,
      );
      const runtimeFiles = Object.freeze(materialized.files.filter((file) =>
        file.kind.startsWith("runtime-")));
      const modelFiles = Object.freeze(materialized.files.filter((file) =>
        !file.kind.startsWith("runtime-")));
      return Object.freeze({
        cache: artifactGraphAdmission,
        artifactGraphId: authority.identitySha256,
        artifactGraphAdmission,
        security: effectiveSecurity,
        runtime: Object.freeze({
          ...metadata.runtime,
          files: runtimeFiles,
          edges: metadata.edges,
          transforms: metadata.transforms,
          guardCapability: materialized.guardCapability,
          artifactGraphId: authority.identitySha256,
          artifactGraphAdmission,
        }),
        model: Object.freeze({
          ...metadata.model,
          files: modelFiles,
        }),
        release: materialized.release,
      });
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
        ...(metadata.runtime.wasmPaths === undefined
          ? {}
          : { wasmPaths: metadata.runtime.wasmPaths }),
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
    if (!isSpeechArtifactAuthority(authority)) {
      return Promise.reject(new TypeError(
        "Speech artifact preparation requires an SDK-created authority.",
      ));
    }
    return serializeAuthority(authority, async () => {
      try {
        return await prepareUnlocked(authority, options);
      } catch (error) {
        if (ARTIFACT_GRAPHS.has(authority) && options.signal?.aborted) {
          const cancelled = artifactGraphError(
            "artifact-graph-preparation-cancelled",
            "Artifact graph preparation was cancelled.",
            options.signal.reason ?? error,
          );
          cancelled.name = "AbortError";
          throw cancelled;
        }
        throw error;
      }
    });
  }

  function remove(authority) {
    if (!isSpeechArtifactAuthority(authority)) {
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

export function isBrowserSpeechArtifactGraph(value) {
  return ARTIFACT_GRAPHS.has(value);
}

export function isBrowserSpeechArtifactError(value) {
  return ARTIFACT_ERRORS.has(value);
}

export function isDbopfsSpeechArtifactStore(value) {
  return STORES.has(value);
}

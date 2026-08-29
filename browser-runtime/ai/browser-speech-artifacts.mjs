import {
  normalizeModelSecurity,
} from "./model-controller.mjs";

const completeValue = (value) => value;

export const BROWSER_SPEECH_ARTIFACT_PROTOCOL =
  "arcane-ai-browser-speech-artifacts/1";
export const BROWSER_SPEECH_ARTIFACT_GRAPH_PROTOCOL =
  "arcane-ai-browser-speech-artifact-graph/1";

const MODEL_AUTHORITY_PROTOCOL = "arcane-ai-model-authority/1";
const ARTIFACT_GRAPH_KIND = "browser-speech-authenticated-artifact-graph";
const ARTIFACT_GRAPH_MODULE_KIND =
  "browser-speech-authenticated-artifact-graph";
const ARTIFACT_GRAPH_GUARDS = "__arcaneBrowserSpeechArtifactGraphGuardsV1";
const ARTIFACT_MODULE_ROUTER = "__arcaneBrowserSpeechModuleRouterV1";
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
const LEGACY_ARTIFACT_ERROR_REASONS = completeValue({
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
  return requiredText(value, label);
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
  return artifactGraphText(value, label, missingReason);
}

function ordinarySourceUrl(value, label) {
  let result;
  try {
    result = new URL(value, globalThis.location?.href);
  } catch {
    throw new TypeError(`${label} must be a valid URL.`);
  }
  if (result.username || result.password) {
    throw new TypeError(`${label} must not contain credentials.`);
  }
  return result.href;
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
      `${label} must be an absolute URL.`,
      error,
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
      `${label} must be an absolute origin.`,
      error,
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
  if (value === undefined) return completeValue([]);
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
  return completeValue([...origins].sort(lexicalCompare));
}

function graphImmutableUrl(value, label, revision) {
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
  if (ARTIFACT_GRAPH_MUTABLE_SOURCE_PATTERN.test(new URL(url).pathname)) {
    throw artifactGraphTypeError(
      "artifact-graph-source-url-mutable",
      `${label} names a mutable branch, channel, or release alias.`,
    );
  }
  if (!url.toLowerCase().includes(revision.toLowerCase())) {
    throw artifactGraphTypeError(
      "artifact-graph-source-revision-unbound",
      `${label} must contain the file revision.`,
    );
  }
  return url;
}

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Structural comparison for dormant authenticated-graph compatibility
// normalizers only. Ordinary graph creation treats edges and transforms as
// inert metadata and never calls these helpers. Do not enable them, including
// for secure mode, without an explicit review with the user.
function compatibilityRecordKey(value) {
  if (Array.isArray(value)) {
    return `[${value.map(compatibilityRecordKey).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${compatibilityRecordKey(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeFile(value, kind, index, revision, secure) {
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
  const url = secure
    ? immutableUrl(value.url, `${kind} file url`)
    : ordinarySourceUrl(value.url, `${kind} file url`);
  if (secure && !url.toLowerCase().includes(revision.toLowerCase())) {
    throw new TypeError(
      `${kind} file URL must contain its caller-supplied revision.`,
    );
  }
  return completeValue({
    kind,
    index,
    path,
    url,
    mediaType: typeof value.mediaType === "string" && value.mediaType.trim()
      ? value.mediaType.trim()
      : kind === "runtime" && /\.(?:m?js)$/iu.test(path)
        ? "text/javascript"
        : "application/octet-stream",
  });
}

function uniqueFiles(files, label, kind, revision, {
  allowEmpty = false,
  secure = false,
} = {}) {
  if (!Array.isArray(files) || (!allowEmpty && files.length < 1)) {
    throw new TypeError(
      allowEmpty
        ? `${label} files must be an array.`
        : `${label} requires a nonempty files array.`,
    );
  }
  const paths = new Set();
  const urls = new Set();
  return completeValue(files.map((value, index) => {
    const file = normalizeFile(value, kind, index, revision, secure);
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
  return completeValue(result);
}

function normalizeArtifactGraphFile(value, index, secure = false) {
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
  const sourceUrl = secure
    ? graphImmutableUrl(
      value.sourceUrl ?? value.url,
      `Artifact graph file ${path} sourceUrl`,
      revision,
    )
    : ordinarySourceUrl(
      value.sourceUrl ?? value.url,
      `Artifact graph file ${path} sourceUrl`,
    );
  const redirectFinalOrigins = normalizeGraphRedirectFinalOrigins(
    value.redirectFinalOrigins,
    path,
  );
  // Legal metadata belongs to the selected upstream distribution. Preserve a
  // caller-supplied value as inert metadata, but never require or interpret it
  // as part of ordinary runtime materialization.
  const license = value.license;
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
  return completeValue({
    kind,
    index,
    path,
    sourceUrl,
    revision,
    ...(license === undefined ? {} : { license }),
    mediaType,
    sourceMediaType,
    runtimeRequestUrls: completeValue(normalizedRequestUrls),
    redirectFinalOrigins,
  });
}

function publicArtifactGraphFile(file) {
  return completeValue({
    kind: file.kind,
    path: file.path,
    sourceUrl: file.sourceUrl,
    revision: file.revision,
    ...(file.license === undefined ? {} : { license: file.license }),
    mediaType: file.mediaType,
    ...(file.sourceMediaType === file.mediaType
      ? {}
      : { sourceMediaType: file.sourceMediaType }),
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
    return completeValue({ match, targetPath, exactSpecifier });
  });
  targets.sort((left, right) =>
    lexicalCompare(compatibilityRecordKey(left), compatibilityRecordKey(right)));
  const identities = new Set(targets.map(compatibilityRecordKey));
  if (identities.size !== targets.length) {
    throw artifactGraphTypeError(
      "artifact-graph-edge-target-duplicate",
      `${label} targets must be unique.`,
    );
  }
  return completeValue(targets);
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
    normalized.sort((left, right) =>
      lexicalCompare(compatibilityRecordKey(left), compatibilityRecordKey(right)));
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
    return completeValue(normalized);
  }

  const staticImports = normalizeArray(
    "staticImports",
    (edge, label, modulePath, occurrence) => completeValue({
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
      return completeValue({ modulePath, occurrence, edgePolicy, targets });
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
      return completeValue({ modulePath, occurrence, edgePolicy, targets });
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
      return completeValue({
        modulePath,
        occurrence,
        edgePolicy,
        methods: completeValue(["GET"]),
        targetPaths: completeValue(normalizedTargetPaths),
        negativeRuntimeRequestUrls: completeValue(normalizedNegativeUrls),
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
      return completeValue({
        modulePath,
        occurrence,
        edgePolicy,
        cacheName,
        targetPaths: completeValue(normalizedTargetPaths),
      });
    },
  );
  return completeValue({
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
    return completeValue({
      kind: transform.kind,
      modulePath: normalizeGraphModulePath(transform.modulePath, label, filesByPath),
      occurrence: normalizeGraphOccurrence(transform.occurrence, label),
    });
  });
  normalized.sort((left, right) =>
    lexicalCompare(compatibilityRecordKey(left), compatibilityRecordKey(right)));
  const identities = new Set(normalized.map(compatibilityRecordKey));
  if (identities.size !== normalized.length) {
    throw artifactGraphTypeError(
      "artifact-graph-transform-occurrence-duplicate",
      "Artifact graph transform occurrences must be unique.",
    );
  }
  return completeValue(normalized);
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
    return completeValue({ id, path });
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
  return completeValue(voices);
}

function artifactGraphProjection({
  providerId,
  role,
  model,
  runtime,
  files,
  edges,
  transforms,
}) {
  return completeValue({
    protocol: BROWSER_SPEECH_ARTIFACT_GRAPH_PROTOCOL,
    kind: ARTIFACT_GRAPH_KIND,
    providerId,
    role,
    model,
    runtime,
    files: completeValue(files.map((file) => publicArtifactGraphFile(file))),
    edges,
    transforms,
  });
}

/**
 * Creates one caller-selected browser speech artifact graph. Ordinary mode
 * preserves the functional runtime/model closure without computing or
 * publishing byte identities.
 */
export function createBrowserSpeechArtifactGraph({
  kind = ARTIFACT_GRAPH_KIND,
  security,
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
  const normalizedSecurity = normalizeModelSecurity(
    security,
    "Browser speech artifact graph security",
  );
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
  const normalizedFiles = files.map((file, index) =>
    normalizeArtifactGraphFile(file, index, false));
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
      `Artifact graph runtime request URL ${url} overlaps a declared source URL.`,
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

  // Negative-route admission belonged to the former authenticated graph. The
  // ordinary materializer now routes known files and lets every unknown URL
  // continue through the browser's native operation.
  const normalizedNegativeRoutes = completeValue([]);

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
    : completeValue([]);

  // Edge and transform declarations are retained only as inert compatibility
  // metadata. Ordinary execution discovers routing from the complete file
  // inventory and never admits or rejects runtime operations through them.
  const edgeRecord = edges && typeof edges === "object" && !Array.isArray(edges)
    ? edges
    : {};
  const normalizedEdges = completeValue({
    staticImports: completeValue(Array.isArray(edgeRecord.staticImports)
      ? edgeRecord.staticImports.map((edge) => completeValue({ ...edge }))
      : []),
    dynamicImports: completeValue(Array.isArray(edgeRecord.dynamicImports)
      ? edgeRecord.dynamicImports.map((edge) => completeValue({ ...edge }))
      : []),
    moduleWorkers: completeValue(Array.isArray(edgeRecord.moduleWorkers)
      ? edgeRecord.moduleWorkers.map((edge) => completeValue({ ...edge }))
      : []),
    fetches: completeValue(Array.isArray(edgeRecord.fetches)
      ? edgeRecord.fetches.map((edge) => completeValue({ ...edge }))
      : []),
    cacheOpens: completeValue(Array.isArray(edgeRecord.cacheOpens)
      ? edgeRecord.cacheOpens.map((edge) => completeValue({ ...edge }))
      : []),
  });
  const normalizedTransforms = completeValue(Array.isArray(transforms)
    ? transforms.map((transform) => completeValue({ ...transform }))
    : []);

  const runtimeFiles = completeValue(normalizedFiles.filter((file) =>
    file.kind.startsWith("runtime-")));
  const modelFiles = completeValue(normalizedFiles.filter((file) =>
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
  const publicRuntimeFiles = completeValue(runtimeFiles.map((file) =>
    publicArtifactGraphFile(file)));
  const publicModelFiles = completeValue(modelFiles.map((file) =>
    publicArtifactGraphFile(file)));
  const normalizedRuntime = completeValue({
    adapter: runtimeAdapter,
    version: runtimeVersion,
    revision: runtimeRevision,
    entry: entrypoint,
    moduleGraph: ARTIFACT_GRAPH_MODULE_KIND,
    files: publicRuntimeFiles,
    onnxWasm: completeValue({
      namespace,
      mjsPath,
      wasmPath,
      ...(numThreads === null ? {} : { numThreads }),
    }),
    negativeRuntimeRequestUrls: completeValue(normalizedNegativeRoutes),
  });
  const normalizedModel = completeValue({
    id: modelId,
    repository,
    revision: modelRevision,
    dtype,
    ...(inputSampleRate === null ? {} : { inputSampleRate }),
    ...(outputSampleRate === null ? {} : { outputSampleRate }),
    ...(role === "tts" ? { defaultVoice, voices } : {}),
    files: publicModelFiles,
  });
  const projection = artifactGraphProjection({
    providerId: normalizedProviderId,
    role,
    model: normalizedModel,
    runtime: normalizedRuntime,
    files: normalizedFiles,
    edges: normalizedEdges,
    transforms: normalizedTransforms,
  });
  const graph = completeValue({
    ...projection,
    ...(normalizedSecurity ? { security: normalizedSecurity } : {}),
  });
  ARTIFACT_GRAPHS.add(graph);
  ARTIFACT_GRAPH_METADATA.set(graph, completeValue({
    graph,
    files: completeValue(normalizedFiles),
    filesByPath,
    runtimeFiles,
    modelFiles,
    model: normalizedModel,
    runtime: normalizedRuntime,
    edges: normalizedEdges,
    transforms: normalizedTransforms,
    ...(normalizedSecurity ? { security: normalizedSecurity } : {}),
  }));
  return graph;
}

/**
 * Accepts one caller-owned browser speech model/runtime description. The SDK
 * supplies no model URL or profile; applications choose every source.
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
  const dtype = model.dtype === undefined
    ? null
    : identifier(model.dtype, "Browser speech model dtype");
  const modelFiles = uniqueFiles(
    model.files ?? [],
    "Browser speech model",
    "model",
    modelRevision,
    {
      allowEmpty: true,
      secure: false,
    },
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
    { secure: false },
  );
  const wasmPaths = runtime.wasmPaths === undefined
    ? null
    : ordinarySourceUrl(runtime.wasmPaths, "Browser speech runtime wasmPaths");
  const entry = requiredText(runtime.entry, "Browser speech runtime entry");
  const entryFile = runtimeFiles.find((file) => file.path === entry);
  if (!entryFile) {
    throw new TypeError("Browser speech runtime entry must name one runtime file path.");
  }
  if (!/\.(?:m?js)$/iu.test(entryFile.path) || entryFile.mediaType !== "text/javascript") {
    throw new TypeError("Browser speech runtime entry must be a JavaScript module.");
  }
  const normalizedModel = completeValue({
    id: modelId,
    repository,
    revision: modelRevision,
    ...(dtype === null ? {} : { dtype }),
    defaultVoice: role === "tts"
      ? identifier(model.defaultVoice, "Browser Kokoro defaultVoice")
      : null,
    files: modelFiles,
  });
  const normalizedRuntime = completeValue({
    adapter: runtimeAdapter,
    version: runtimeVersion,
    revision: runtimeRevision,
    entry,
    ...(wasmPaths === null ? {} : { wasmPaths }),
    files: runtimeFiles,
  });
  const files = completeValue([...runtimeFiles, ...modelFiles]);
  const allPaths = new Set();
  const allUrls = new Set();
  for (const file of files) {
    if (allPaths.has(file.path) || allUrls.has(file.url)) {
      throw new TypeError("Browser speech runtime and model file identities must not overlap.");
    }
    allPaths.add(file.path);
    allUrls.add(file.url);
  }
  const authority = completeValue({
    protocol: MODEL_AUTHORITY_PROTOCOL,
    providerId: normalizedProviderId,
    modelId,
    role,
    repository,
    revision: modelRevision,
    ...(dtype === null ? {} : { dtype }),
    defaultVoice: normalizedModel.defaultVoice,
    runtime: completeValue({
      adapter: normalizedRuntime.adapter,
      version: normalizedRuntime.version,
      revision: normalizedRuntime.revision,
      entry: normalizedRuntime.entry,
      ...(wasmPaths === null ? {} : { wasmPaths }),
      files: completeValue(runtimeFiles.map((file) =>
        publicFile(file))),
    }),
    files: completeValue(modelFiles.map((file) =>
      publicFile(file))),
    ...(normalizedSecurity ? { security: normalizedSecurity } : {}),
  });
  AUTHORITIES.add(authority);
  AUTHORITY_METADATA.set(authority, completeValue({
    model: normalizedModel,
    runtime: normalizedRuntime,
    files,
  }));
  return authority;
}

function authorityProjection(authority) {
  return completeValue({
    protocol: authority.protocol,
    providerId: authority.providerId,
    modelId: authority.modelId,
    role: authority.role,
    repository: authority.repository,
    revision: authority.revision,
    ...(authority.dtype === undefined ? {} : { dtype: authority.dtype }),
    runtime: authority.runtime,
    files: authority.files,
  });
}

function artifactMetadata(authority) {
  return ARTIFACT_GRAPH_METADATA.get(authority)
    ?? AUTHORITY_METADATA.get(authority)
    ?? null;
}

function functionalArtifactFile(file) {
  const result = { ...file };
  delete result.license;
  return completeValue(result);
}

function isSpeechArtifactAuthority(authority) {
  return AUTHORITIES.has(authority) || ARTIFACT_GRAPHS.has(authority);
}

function storageKey(authority) {
  if (ARTIFACT_GRAPHS.has(authority)) {
    const metadata = ARTIFACT_GRAPH_METADATA.get(authority);
    return `speech-${encodeURIComponent(JSON.stringify({
      kind: authority.kind,
      providerId: authority.providerId,
      role: authority.role,
      modelId: metadata.model.id,
      modelRepository: metadata.model.repository,
      modelRevision: metadata.model.revision,
      runtimeAdapter: metadata.runtime.adapter,
      runtimeVersion: metadata.runtime.version,
      runtimeRevision: metadata.runtime.revision,
    }))}`;
  }
  const metadata = AUTHORITY_METADATA.get(authority);
  return `speech-${encodeURIComponent(JSON.stringify({
    providerId: authority.providerId,
    role: authority.role,
    modelId: metadata.model.id,
    modelRepository: metadata.model.repository,
    modelRevision: metadata.model.revision,
    runtimeAdapter: metadata.runtime.adapter,
    runtimeVersion: metadata.runtime.version,
    runtimeRevision: metadata.runtime.revision,
  }))}`;
}

function cacheSelection(authority) {
  const metadata = artifactMetadata(authority);
  if (ARTIFACT_GRAPHS.has(authority)) {
    const model = completeValue({
      ...metadata.model,
      files: completeValue(metadata.model.files.map(functionalArtifactFile)),
    });
    const runtime = completeValue({
      ...metadata.runtime,
      files: completeValue(metadata.runtime.files.map(functionalArtifactFile)),
    });
    return completeValue({
      protocol: authority.protocol,
      kind: authority.kind,
      providerId: authority.providerId,
      role: authority.role,
      model,
      runtime,
      files: completeValue(metadata.files.map(functionalArtifactFile)),
    });
  }
  return completeValue({
    authority: authorityProjection(authority),
    model: metadata.model,
    runtime: metadata.runtime,
    files: metadata.files,
  });
}

function storageNames(authority, files) {
  const prefix = `arcane-speech-${storageKey(authority)}`;
  return completeValue({
    key: prefix,
    selection: `${prefix}.selection.json`,
    legacyManifest: `${prefix}.complete.json`,
    files: completeValue(files.map((_, index) =>
      `${prefix}.${String(index).padStart(4, "0")}.artifact`)),
  });
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
    literalFragments.push(completeValue({
      start,
      end,
      value,
      templateIds: completeValue([...templateStack]),
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
    return completeValue({
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

// Dormant hardening retained for future review only. Ordinary speech artifact
// preparation never calls this closed-module inspection, and it must not be
// enabled for secure mode without an explicit review with the user.
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
  void file;
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
    return completeValue({
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
        tokens.push(completeValue({ type: "string", value, start, end: index }));
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
        lastToken = completeValue({ type: "template", value: "template" });
        continue;
      }
      if (character === "/" && canStartRegex(lastToken)) {
        skipRegex();
        lastToken = completeValue({ type: "regexp", value: "regexp" });
        continue;
      }
      if (identifierStart(character)) {
        const start = index;
        index += 1;
        while (identifierPart(source[index])) index += 1;
        const token = completeValue({
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
      const token = completeValue({
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
  return completeValue(tokens);
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
    target.push(completeValue({ start, end: opening.end }));
  }

  function typedArrayConstructor(index) {
    const opening = next(index);
    if (opening?.value !== "(") return null;
    const property = previous(index, 2);
    if (property?.type !== "identifier") return null;
    if (previous(index, 3)?.value === "new") {
      return completeValue({
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
      return completeValue({
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
      returnThisTransforms.push(completeValue({
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
      cacheOpens.push(completeValue({ start, end: next(index, 3).end }));
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
        dynamicImports.push(completeValue({ start: token.start, end: next(index).end }));
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
      staticImports.push(completeValue({
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
        staticImports.push(completeValue({
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
      moduleWorkers.push(completeValue({ start, end: opening.end }));
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
  return completeValue({
    source,
    staticImports: completeValue(staticImports),
    dynamicImports: completeValue(dynamicImports),
    fetches: completeValue(fetches),
    moduleWorkers: completeValue(moduleWorkers),
    cacheOpens: completeValue(cacheOpens),
    returnThisTransforms: completeValue(returnThisTransforms),
    typedArrayConstructors: completeValue(typedArrayConstructors),
    warnings: completeValue([...warnings].sort()),
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
  return completeValue(order);
}

// Dormant hardening retained for future review only. Ordinary materialization
// uses the permissive router below; these declaration, capability, and closed
// inspection controls must not be enabled without explicit user review.
async function inspectArtifactGraphRuntime(admitted, metadata, signal) {
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
        strict: false,
      }),
    );
  }
  const order = assertArtifactGraphStaticImportClosure(metadata);
  const warnings = [...new Set([...plans.values()].flatMap((plan) => plan.warnings))]
    .sort();
  throwIfAborted(signal);
  return completeValue({ plans, order, warnings: completeValue(warnings) });
}

function assertArtifactGraphRuntimeInspection(inspection) {
  if (
    !inspection
    || !(inspection.plans instanceof Map)
    || !Array.isArray(inspection.order)
    || !Array.isArray(inspection.warnings)
  ) {
    throw artifactGraphError(
      "artifact-graph-runtime-inspection-missing",
      "Artifact graph runtime inspection is required before executable materialization.",
    );
  }
  return inspection;
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
  return "ordinary";
}

async function createArtifactGraphObjectUrls(admitted, metadata, inspection) {
  if (
    typeof PLATFORM_CREATE_OBJECT_URL !== "function"
    || typeof PLATFORM_REVOKE_OBJECT_URL !== "function"
  ) {
    throw artifactGraphError(
      "artifact-graph-object-url-platform-unavailable",
      "Artifact graph materialization requires native Blob URL creation and revocation.",
    );
  }
  const admittedByPath = new Map(admitted.files.map((entry) => [entry.descriptor.path, entry]));
  const materializedByPath = new Map();
  const created = [];
  const createdIdentities = new Set();
  const guardCapability = artifactGraphGuardCapability();
  const runtimeInspection = assertArtifactGraphRuntimeInspection(inspection);
  async function materialize(descriptor, body) {
    const blob = body instanceof Blob && body.type === descriptor.mediaType
      ? body
      : new Blob([body], { type: descriptor.mediaType });
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
    materializedByPath.set(descriptor.path, completeValue({
      kind: descriptor.kind,
      path: descriptor.path,
      sourceUrl: descriptor.sourceUrl,
      revision: descriptor.revision,
      moduleUrl,
      mediaType: descriptor.mediaType,
      ...(descriptor.sourceMediaType === descriptor.mediaType
        ? {}
        : { sourceMediaType: descriptor.sourceMediaType }),
      runtimeRequestUrls: descriptor.runtimeRequestUrls,
      ...(descriptor.redirectFinalOrigins.length < 1
        ? {}
        : { redirectFinalOrigins: descriptor.redirectFinalOrigins }),
    }));
  }
  try {
    for (const descriptor of metadata.files) {
      if (ARTIFACT_GRAPH_JAVASCRIPT_KINDS.has(descriptor.kind)) continue;
      const admittedFile = admittedByPath.get(descriptor.path)?.file;
      if (!admittedFile) {
        throw artifactGraphError(
          "artifact-graph-materialized-source-file-missing",
          `Artifact graph file ${descriptor.path} is unavailable for materialization.`,
        );
      }
      await materialize(descriptor, admittedFile);
    }
    for (const path of runtimeInspection.order) {
      const descriptor = metadata.filesByPath.get(path);
      const plan = runtimeInspection.plans.get(path);
      if (!descriptor || !plan) {
        throw artifactGraphError(
          "artifact-graph-runtime-inspection-incomplete",
          `Artifact graph runtime inspection is incomplete for ${path}.`,
        );
      }
      await materialize(
        descriptor,
        applyArtifactGraphModuleTransforms(plan, materializedByPath, guardCapability),
      );
    }
    const files = metadata.files.map((descriptor) => {
      const materialized = materializedByPath.get(descriptor.path);
      if (!materialized) {
        throw artifactGraphError(
          "artifact-graph-materialization-incomplete",
          `Artifact graph file ${descriptor.path} was not materialized.`,
        );
      }
      return materialized;
    });
    return completeValue({
      guardCapability,
      files: completeValue(files),
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

function ordinaryArtifactUrl(value, base) {
  try {
    return new URL(value, base).href;
  } catch {
    return null;
  }
}

function isBareModuleSpecifier(value) {
  return typeof value === "string"
    && !value.startsWith("./")
    && !value.startsWith("../")
    && !value.startsWith("/")
    && !/^[A-Za-z][A-Za-z\d+.-]*:/u.test(value);
}

function ordinaryArtifactRoutes(metadata) {
  const byUrl = new Map();
  const ambiguous = new Set();
  function add(value, descriptor) {
    const url = ordinaryArtifactUrl(value, descriptor.sourceUrl);
    if (!url || ambiguous.has(url)) return;
    const existing = byUrl.get(url);
    if (existing && existing.path !== descriptor.path) {
      byUrl.delete(url);
      ambiguous.add(url);
      return;
    }
    byUrl.set(url, descriptor);
  }
  for (const descriptor of metadata.files) {
    add(descriptor.sourceUrl, descriptor);
    for (const route of descriptor.runtimeRequestUrls ?? []) add(route, descriptor);
  }
  return completeValue({ byUrl, ambiguous });
}

function resolveOrdinaryArtifactRoute(routes, value, sourceDescriptor) {
  const url = ordinaryArtifactUrl(value, sourceDescriptor?.sourceUrl);
  return url && !routes.ambiguous.has(url)
    ? completeValue({ descriptor: routes.byUrl.get(url) ?? null, url })
    : null;
}

function scanOrdinaryModuleRouting(source, modulePath) {
  let tokens;
  try {
    tokens = tokenizeArtifactGraphModule(source, modulePath);
  } catch {
    // Routing discovery is best effort. A scanner limitation must never become
    // an ordinary runtime admission gate; unchanged source uses native URLs.
    return completeValue({
      source,
      staticImports: completeValue([]),
      dynamicImports: completeValue([]),
      fetches: completeValue([]),
      moduleWorkers: completeValue([]),
      cacheOpens: completeValue([]),
    });
  }
  const staticImports = [];
  const dynamicImports = [];
  const fetches = [];
  const moduleWorkers = [];
  const cacheOpens = [];
  const next = (index, offset = 1) => tokens[index + offset] ?? null;
  const previous = (index, offset = 1) => tokens[index - offset] ?? null;
  const shadowedGlobals = new Set();
  const routableGlobals = new Set(["fetch", "caches", "Worker"]);

  function closingParenthesis(opening) {
    let depth = 0;
    for (let cursor = opening; cursor < tokens.length; cursor += 1) {
      if (tokens[cursor].value === "(") depth += 1;
      if (tokens[cursor].value !== ")") continue;
      depth -= 1;
      if (depth === 0) return cursor;
    }
    return -1;
  }

  function markBindings(start, end) {
    for (let cursor = start; cursor < end; cursor += 1) {
      if (routableGlobals.has(tokens[cursor].value)) {
        shadowedGlobals.add(tokens[cursor].value);
      }
    }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (routableGlobals.has(token.value) && next(index)?.value === "=>") {
      shadowedGlobals.add(token.value);
      continue;
    }
    if (token.value === "import") {
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const candidate = tokens[cursor];
        if (candidate.value === "from" || candidate.type === "string"
          || candidate.value === ";") break;
        if (routableGlobals.has(candidate.value)) {
          shadowedGlobals.add(candidate.value);
        }
      }
      continue;
    }
    if (["function", "catch"].includes(token.value)) {
      let opening = index + 1;
      while (opening < tokens.length && tokens[opening].value !== "(") {
        if (routableGlobals.has(tokens[opening].value)) {
          shadowedGlobals.add(tokens[opening].value);
        }
        opening += 1;
      }
      const closing = opening < tokens.length ? closingParenthesis(opening) : -1;
      if (closing > opening) markBindings(opening + 1, closing);
      continue;
    }
    if (token.value === "class" && routableGlobals.has(next(index)?.value)) {
      shadowedGlobals.add(next(index).value);
      continue;
    }
    if (!["const", "let", "var"].includes(token.value)) continue;
    let binding = true;
    let round = 0;
    let square = 0;
    let curly = 0;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const candidate = tokens[cursor];
      const topLevel = round === 0 && square === 0 && curly === 0;
      if (topLevel && candidate.value === ";") break;
      if (topLevel && candidate.value === ",") {
        binding = true;
        continue;
      }
      if (topLevel && ["=", "in", "of"].includes(candidate.value)) {
        binding = false;
        continue;
      }
      if (binding && routableGlobals.has(candidate.value)) {
        shadowedGlobals.add(candidate.value);
      }
      if (candidate.value === "(") round += 1;
      else if (candidate.value === ")") round = Math.max(0, round - 1);
      else if (candidate.value === "[") square += 1;
      else if (candidate.value === "]") square = Math.max(0, square - 1);
      else if (candidate.value === "{") curly += 1;
      else if (candidate.value === "}") curly = Math.max(0, curly - 1);
    }
  }

  const controlParentheses = new Set(["catch", "for", "if", "switch", "while", "with"]);
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "(") continue;
    const closing = closingParenthesis(index);
    const nextToken = closing < 0 ? null : next(closing);
    const owner = previous(index)?.value;
    const callable = nextToken?.value === "=>"
      || (nextToken?.value === "{" && !controlParentheses.has(owner));
    if (callable) markBindings(index + 1, closing);
  }

  function directCall(target, index) {
    const opening = next(index);
    if (opening?.value !== "(") return false;
    let start = tokens[index].start;
    if (previous(index)?.value === ".") {
      if (!["globalThis", "self"].includes(previous(index, 2)?.value)) return false;
      start = previous(index, 2).start;
    }
    target.push(completeValue({ start, end: opening.end }));
    return true;
  }

  function isExplicitGlobal(index) {
    return previous(index)?.value === "."
      && ["globalThis", "self"].includes(previous(index, 2)?.value);
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "identifier") continue;
    if (token.value === "import") {
      if (next(index)?.value === "." && next(index, 2)?.value === "meta") {
        index += 2;
        continue;
      }
      if (next(index)?.value === "(") {
        dynamicImports.push(completeValue({ start: token.start, end: next(index).end }));
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
      if (specifier) staticImports.push(completeValue({
        start: specifier.start,
        end: specifier.end,
        specifier: specifier.value,
      }));
      continue;
    }
    if (token.value === "export" && ["*", "{"].includes(next(index)?.value)) {
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        if (tokens[cursor].value === ";") break;
        if (tokens[cursor].value === "from" && next(cursor)?.type === "string") {
          const specifier = next(cursor);
          staticImports.push(completeValue({
            start: specifier.start,
            end: specifier.end,
            specifier: specifier.value,
          }));
          break;
        }
      }
      continue;
    }
    if (
      token.value === "fetch"
      && (isExplicitGlobal(index) || !shadowedGlobals.has("fetch"))
    ) {
      directCall(fetches, index);
      continue;
    }
    if (
      token.value === "caches"
      && (isExplicitGlobal(index) || !shadowedGlobals.has("caches"))
      && next(index)?.value === "."
      && next(index, 2)?.value === "open"
      && next(index, 3)?.value === "("
    ) {
      let start = token.start;
      if (previous(index)?.value === "."
        && ["globalThis", "self"].includes(previous(index, 2)?.value)) {
        start = previous(index, 2).start;
      }
      cacheOpens.push(completeValue({ start, end: next(index, 3).end }));
      continue;
    }
    if (
      token.value === "Worker"
      && (isExplicitGlobal(index) || !shadowedGlobals.has("Worker"))
      && next(index)?.value === "("
    ) {
      let start = token.start;
      if (previous(index)?.value === "new") {
        start = previous(index).start;
      } else if (previous(index)?.value === ".") {
        if (!["globalThis", "self"].includes(previous(index, 2)?.value)) continue;
        start = previous(index, 2).start;
        if (previous(index, 3)?.value === "new") start = previous(index, 3).start;
      }
      moduleWorkers.push(completeValue({ start, end: next(index).end }));
    }
  }
  return completeValue({
    source,
    staticImports: completeValue(staticImports),
    dynamicImports: completeValue(dynamicImports),
    fetches: completeValue(fetches),
    moduleWorkers: completeValue(moduleWorkers),
    cacheOpens: completeValue(cacheOpens),
  });
}

async function planOrdinaryMaterializedRuntime(admitted, metadata, signal) {
  const admittedByPath = new Map(admitted.files.map((entry) => [entry.descriptor.path, entry]));
  const routes = ordinaryArtifactRoutes(metadata);
  const plans = new Map();
  for (const descriptor of metadata.runtimeFiles) {
    if (!ARTIFACT_GRAPH_JAVASCRIPT_KINDS.has(descriptor.kind)) continue;
    throwIfAborted(signal);
    const file = admittedByPath.get(descriptor.path)?.file;
    if (!file) continue;
    const source = await file.text();
    plans.set(descriptor.path, scanOrdinaryModuleRouting(source, descriptor.path));
  }
  const visiting = new Set();
  const visited = new Set();
  const order = [];
  function visit(path) {
    if (visited.has(path) || visiting.has(path)) return;
    visiting.add(path);
    const descriptor = metadata.filesByPath.get(path);
    const plan = plans.get(path);
    for (const observed of plan?.staticImports ?? []) {
      if (isBareModuleSpecifier(observed.specifier)) continue;
      const target = resolveOrdinaryArtifactRoute(routes, observed.specifier, descriptor)?.descriptor;
      if (target && plans.has(target.path)) visit(target.path);
    }
    visiting.delete(path);
    visited.add(path);
    order.push(path);
  }
  for (const path of plans.keys()) visit(path);
  return completeValue({ order: completeValue(order), plans, routes });
}

function applyOrdinaryModuleRouting(plan, sourceDescriptor, materializedByPath, routes) {
  const replacements = [];
  for (const observed of plan.staticImports) {
    if (isBareModuleSpecifier(observed.specifier)) continue;
    const resolution = resolveOrdinaryArtifactRoute(routes, observed.specifier, sourceDescriptor);
    const mapped = resolution?.descriptor
      ? materializedByPath.get(resolution.descriptor.path)?.moduleUrl
      : null;
    const target = mapped ?? resolution?.url;
    if (target) replacements.push({
      start: observed.start,
      end: observed.end,
      value: JSON.stringify(target),
    });
  }
  for (const observed of plan.dynamicImports) replacements.push({
    start: observed.start,
    end: observed.end,
    value: `globalThis.${ARTIFACT_MODULE_ROUTER}.dynamicImport(${JSON.stringify(sourceDescriptor.path)},`,
  });
  for (const observed of plan.fetches) replacements.push({
    start: observed.start,
    end: observed.end,
    value: `globalThis.${ARTIFACT_MODULE_ROUTER}.fetch(${JSON.stringify(sourceDescriptor.path)},`,
  });
  for (const observed of plan.moduleWorkers) replacements.push({
    start: observed.start,
    end: observed.end,
    value: `globalThis.${ARTIFACT_MODULE_ROUTER}.createWorker(${JSON.stringify(sourceDescriptor.path)},`,
  });
  for (const observed of plan.cacheOpens) replacements.push({
    start: observed.start,
    end: observed.end,
    value: `globalThis.${ARTIFACT_MODULE_ROUTER}.openCache(${JSON.stringify(sourceDescriptor.path)},`,
  });
  replacements.sort((left, right) => right.start - left.start);
  let source = plan.source;
  let previousStart = source.length;
  for (const replacement of replacements) {
    if (replacement.end > previousStart) continue;
    source = `${source.slice(0, replacement.start)}${replacement.value}${source.slice(replacement.end)}`;
    previousStart = replacement.start;
  }
  return source;
}

async function createOrdinaryArtifactObjectUrls(
  admitted,
  metadata,
  routing,
  objectUrlFactory,
) {
  const create = objectUrlFactory?.create ?? PLATFORM_CREATE_OBJECT_URL;
  const revoke = objectUrlFactory?.revoke ?? PLATFORM_REVOKE_OBJECT_URL;
  if (typeof create !== "function" || typeof revoke !== "function") {
    throw artifactGraphError(
      "artifact-graph-object-url-platform-unavailable",
      "Artifact materialization requires native Blob URL creation and revocation.",
    );
  }
  const admittedByPath = new Map(admitted.files.map((entry) => [entry.descriptor.path, entry]));
  const materializedByPath = new Map();
  const created = [];
  async function materialize(descriptor, body) {
    const blob = body instanceof Blob && body.type === descriptor.mediaType
      ? body
      : new Blob([body], { type: descriptor.mediaType });
    const moduleUrl = create(blob);
    if (typeof moduleUrl !== "string") {
      throw artifactGraphError(
        "artifact-graph-object-url-platform-unavailable",
        `Artifact file ${descriptor.path} did not produce an object URL.`,
      );
    }
    created.push(moduleUrl);
    materializedByPath.set(descriptor.path, completeValue({
      kind: descriptor.kind,
      path: descriptor.path,
      sourceUrl: descriptor.sourceUrl,
      revision: descriptor.revision,
      moduleUrl,
      mediaType: descriptor.mediaType,
      ...(descriptor.sourceMediaType === descriptor.mediaType
        ? {}
        : { sourceMediaType: descriptor.sourceMediaType }),
      runtimeRequestUrls: descriptor.runtimeRequestUrls,
      ...(descriptor.redirectFinalOrigins.length < 1
        ? {}
        : { redirectFinalOrigins: descriptor.redirectFinalOrigins }),
    }));
  }
  try {
    for (const descriptor of metadata.files) {
      if (ARTIFACT_GRAPH_JAVASCRIPT_KINDS.has(descriptor.kind)) continue;
      const file = admittedByPath.get(descriptor.path)?.file;
      if (file) await materialize(descriptor, file);
    }
    for (const path of routing.order) {
      const descriptor = metadata.filesByPath.get(path);
      const plan = routing.plans.get(path);
      if (!descriptor || !plan) continue;
      await materialize(
        descriptor,
        applyOrdinaryModuleRouting(plan, descriptor, materializedByPath, routing.routes),
      );
    }
    for (const descriptor of metadata.files) {
      if (materializedByPath.has(descriptor.path)) continue;
      const file = admittedByPath.get(descriptor.path)?.file;
      if (file) await materialize(descriptor, file);
    }
    return completeValue({
      files: completeValue(metadata.files.map((descriptor) => materializedByPath.get(descriptor.path))),
      release() {
        for (const url of created.splice(0).reverse()) {
          try {
            revoke(url);
          } catch {
            // Object URL revocation follows Worker termination and is best effort.
          }
        }
      },
    });
  } catch (error) {
    for (const url of created.splice(0).reverse()) {
      try {
        revoke(url);
      } catch {
        // Preserve the functional materialization failure.
      }
    }
    throw error;
  }
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
      return completeValue({
        kind: descriptor.kind,
        path: descriptor.path,
        sourceUrl: descriptor.url,
        moduleUrl: url,
        mediaType: descriptor.mediaType,
      });
    });
    return completeValue({
      files: completeValue(materialized),
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
 * Stores an authority's runtime/model files in an existing DBOPFS table.
 * Ordinary cache reuse creates no receipt, manifest, or byte identity.
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

  async function readJsonFile(name) {
    const file = await readFile(name);
    if (!file) return null;
    try {
      return JSON.parse(await file.text());
    } catch {
      return null;
    }
  }

  async function writeFile(name, body, { signal } = {}) {
    const directory = await table();
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      for await (const chunk of byteChunks(body, signal)) {
        await writable.write(chunk);
      }
      throwIfAborted(signal);
      await writable.close();
      return undefined;
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
    const priorSelection = await readJsonFile(names.selection);
    const legacySelection = await readJsonFile(names.legacyManifest);
    const priorCount = Math.max(
      Array.isArray(priorSelection?.files) ? priorSelection.files.length : 0,
      Array.isArray(legacySelection?.files) ? legacySelection.files.length : 0,
    );
    const fileNames = Array.from(
      { length: Math.max(names.files.length, priorCount) },
      (_, index) => `${names.key}.${String(index).padStart(4, "0")}.artifact`,
    );
    const results = await Promise.all([
      removeEntry(names.selection),
      removeEntry(names.legacyManifest),
      ...fileNames.map(removeEntry),
    ]);
    return results.some(Boolean);
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

  async function openCached(authority, { signal, onProgress } = {}) {
    const graph = ARTIFACT_GRAPHS.has(authority);
    const metadata = artifactMetadata(authority);
    const names = storageNames(authority, metadata.files);
    const storedSelection = await readJsonFile(names.selection);
    if (JSON.stringify(storedSelection) !== JSON.stringify(cacheSelection(authority))) {
      await removeUnlocked(authority);
      return null;
    }
    const files = [];
    for (let index = 0; index < metadata.files.length; index += 1) {
      throwIfAborted(signal);
      const descriptor = metadata.files[index];
      const file = await readFile(names.files[index]);
      if (!file) {
        await removeUnlocked(authority);
        return null;
      }
      files.push({ descriptor, file });
    }
    try {
      const routing = graph
        ? await planOrdinaryMaterializedRuntime({ files }, metadata, signal)
        : null;
      throwIfAborted(signal);
      return completeValue({
        files: completeValue(files),
        cache: "cached",
        routing,
      });
    } catch (error) {
      await removeUnlocked(authority);
      throw error;
    }
  }

  async function install(authority, { signal, onProgress } = {}) {
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
      // This mutable cache selection is written before content. It is only an
      // invalidation record, never a completion, byte-identity, or integrity receipt.
      await writeFile(
        names.selection,
        new TextEncoder().encode(`${JSON.stringify(cacheSelection(authority))}\n`),
        { signal },
      );
      for (let index = 0; index < metadata.files.length; index += 1) {
        throwIfAborted(signal);
        const descriptor = metadata.files[index];
        const sourceUrl = graph ? descriptor.sourceUrl : descriptor.url;
        let response;
        try {
          response = await fetchFunction(sourceUrl, {
            cache: "no-store",
            redirect: "follow",
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
        let responseOk;
        let responseStatus;
        try {
          if (!response || typeof response !== "object") {
            throw new TypeError("The artifact fetch result is not an object.");
          }
          responseBody = response.body;
          responseOk = response.ok;
          responseStatus = response.status;
          if (
            typeof responseOk !== "boolean"
            || !Number.isInteger(responseStatus)
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
        await writeFile(names.files[index], responseBody, { signal });
        const file = await readFile(names.files[index]);
        if (!file) {
          if (graph) {
            throw graphVerificationError(
              descriptor,
              "dbopfs-persisted-file-missing",
              `DBOPFS did not preserve artifact graph file ${descriptor.path}.`,
            );
          }
          throw speechError("ARCANE_AI_ARTIFACT_CACHE_REJECTED", "DBOPFS did not preserve a speech artifact.");
        }
        installed.push({ descriptor, file });
      }
      const routing = graph
        ? await planOrdinaryMaterializedRuntime({ files: installed }, metadata, signal)
        : null;
      throwIfAborted(signal);
      return completeValue({
        files: completeValue(installed),
        cache: "installed",
        routing,
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
    void security;
    // Security is an intent-only seam. Artifact checks remain disabled until
    // secure mode is explicitly reviewed with the user and implemented.
    const metadata = artifactMetadata(authority);
    const cached = await openCached(authority, {
      signal,
      onProgress,
    });
    const admitted = cached ?? (offline
      ? null
      : await install(authority, {
        signal,
        onProgress,
      }));
    if (!admitted) {
      if (graph) {
        throw artifactGraphError(
          "artifact-graph-offline-cache-miss",
          "No cached offline artifact graph is available.",
        );
      }
      throw speechError("ARCANE_AI_ARTIFACT_OFFLINE_MISS", "No cached offline speech artifacts are available.");
    }
    if (graph) {
      const materialized = await createOrdinaryArtifactObjectUrls(
        admitted,
        metadata,
        admitted.routing,
        objectUrlFactory,
      );
      const runtimeFiles = completeValue(materialized.files.filter((file) =>
        file.kind.startsWith("runtime-")));
      const modelFiles = completeValue(materialized.files.filter((file) =>
        !file.kind.startsWith("runtime-")));
      return completeValue({
        cache: admitted.cache,
        runtime: completeValue({
          adapter: metadata.runtime.adapter,
          version: metadata.runtime.version,
          revision: metadata.runtime.revision,
          entry: metadata.runtime.entry,
          moduleGraph: metadata.runtime.moduleGraph,
          onnxWasm: metadata.runtime.onnxWasm,
          files: runtimeFiles,
        }),
        model: completeValue({
          ...metadata.model,
          files: modelFiles,
        }),
        release: materialized.release,
      });
    }
    const materialized = createObjectUrls(admitted.files, objectUrlFactory);
    const runtimeFiles = materialized.files.filter((file) => file.kind === "runtime");
    const modelFiles = materialized.files.filter((file) => file.kind === "model");
    return completeValue({
      cache: admitted.cache,
      runtime: completeValue({
        adapter: metadata.runtime.adapter,
        version: metadata.runtime.version,
        revision: metadata.runtime.revision,
        entry: metadata.runtime.entry,
        ...(metadata.runtime.wasmPaths === undefined
          ? {}
          : { wasmPaths: metadata.runtime.wasmPaths }),
        moduleGraph: "self-contained",
        files: completeValue(runtimeFiles),
      }),
      model: completeValue({
        id: metadata.model.id,
        repository: metadata.model.repository,
        revision: metadata.model.revision,
        ...(metadata.model.dtype === undefined ? {} : { dtype: metadata.model.dtype }),
        defaultVoice: metadata.model.defaultVoice,
        files: completeValue(modelFiles),
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

  const store = completeValue({
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

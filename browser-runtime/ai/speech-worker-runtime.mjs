export const SPEECH_WORKER_PROTOCOL = "arcane-ai-speech-worker/1";

const SPEECH_WORKER_ERROR_PROTOCOL = "arcane-ai-speech-worker-error/1";

const ARTIFACT_GRAPH_MODULE_GRAPH =
  "browser-speech-authenticated-artifact-graph";
const GRAPH_GUARD_NAME = "__arcaneBrowserSpeechArtifactGraphGuardsV1";
const NESTED_WORKER_PROTOCOL =
  "arcane-ai-browser-speech-artifact-module-worker/1";
const STRICT_GRAPH_ADMISSIONS = new Set([
  "artifact-graph-network-dbopfs-verified",
  "artifact-graph-dbopfs-cache-verified",
  "artifact-graph-offline-dbopfs-cache-verified",
  "artifact-graph-network-dbopfs-partially-checked",
  "artifact-graph-dbopfs-cache-partially-checked",
  "artifact-graph-offline-dbopfs-cache-partially-checked",
  "artifact-graph-network-dbopfs-unchecked",
  "artifact-graph-dbopfs-cache-unchecked",
  "artifact-graph-offline-dbopfs-cache-unchecked",
]);
const ADAPTERS = Object.freeze({
  stt: "transformers-whisper",
  tts: "kokoro-js",
});
const ONNX_NAMESPACES = Object.freeze({
  stt: "transformers-env-backends-onnx-wasm",
  tts: "kokoro-env-wasm-paths",
});
const ARTIFACT_GRAPH_TRANSFORM_KINDS = new Set([
  "function-return-this-to-global-this",
  "typed-array-constructor",
]);
const PUBLIC_WORKER_OPERATIONS = Object.freeze([
  "load",
  "use",
  "status",
  "unload",
  "dispose",
]);
const TRANSPORT_WORKER_OPERATION_SET = new Set([
  ...PUBLIC_WORKER_OPERATIONS,
  "cancel",
]);
const BOTH_WORKER_ROLES = Object.freeze(["stt", "tts"]);
const LOAD_OPERATION = Object.freeze(["load"]);
const USE_OPERATION = Object.freeze(["use"]);
const STATUS_OPERATION = Object.freeze(["status"]);
const UNLOAD_OPERATION = Object.freeze(["unload"]);
const DISPOSE_OPERATION = Object.freeze(["dispose"]);
const UNLOAD_OR_DISPOSE_OPERATIONS = Object.freeze(["unload", "dispose"]);
const LOAD_OR_USE_OPERATIONS = Object.freeze(["load", "use"]);
const SDK_WORKER_ERRORS = new WeakSet();
const WORKER_ERROR_MESSAGES = Object.freeze({
  ARCANE_AI_REQUEST_ABORTED: "The speech worker operation was cancelled.",
  ARCANE_AI_NOT_READY: "The speech worker is not loaded.",
  ARCANE_AI_INVALID_REQUEST: "The speech worker request was rejected.",
  ARCANE_AI_INVALID_PROVIDER_RESULT: "The speech engine result was rejected.",
  ARCANE_AI_UNDECLARED_ARTIFACT: "The speech engine requested an undeclared artifact.",
  ARCANE_AI_PROVIDER_UNAVAILABLE: "The selected speech engine is unavailable.",
  ARCANE_AI_PROVIDER_DISPOSED: "The speech worker is disposed.",
  ARCANE_AI_PROVIDER_REQUEST_FAILED: "The speech engine operation was rejected.",
  ARCANE_AI_WORKER_CRASHED: "The speech Worker stopped unexpectedly.",
  ARCANE_AI_WORKER_MESSAGE_ERROR: "The speech Worker message was rejected.",
  ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID:
    "The authenticated artifact graph Worker configuration was rejected.",
  ARCANE_AI_ARTIFACT_GRAPH_FETCH_EDGE_UNDECLARED:
    "The runtime used an undeclared artifact graph fetch edge.",
  ARCANE_AI_ARTIFACT_GRAPH_IMPORT_EDGE_UNDECLARED:
    "The runtime used an undeclared artifact graph import edge.",
  ARCANE_AI_ARTIFACT_GRAPH_CACHE_EDGE_UNDECLARED:
    "The runtime used an undeclared artifact graph cache edge.",
  ARCANE_AI_ARTIFACT_GRAPH_WORKER_EDGE_UNDECLARED:
    "The runtime used an undeclared artifact graph module Worker edge.",
  ARCANE_AI_ARTIFACT_GRAPH_ISOLATION_UNAVAILABLE:
    "The Worker cannot install the authenticated artifact graph isolation boundary.",
});
const WORKER_ERROR_REASON_ADMISSIONS = new Map();

function registerWorkerErrorReasons(code, roles, operations, reasons) {
  const admission = Object.freeze({
    code,
    roles: Object.freeze([...roles]),
    operations: Object.freeze([...operations]),
  });
  for (const reason of reasons) WORKER_ERROR_REASON_ADMISSIONS.set(reason, admission);
}

registerWorkerErrorReasons("ARCANE_AI_REQUEST_ABORTED", ["stt"], LOAD_OPERATION, [
  "stt-load-cancelled",
]);
registerWorkerErrorReasons("ARCANE_AI_REQUEST_ABORTED", ["stt"], STATUS_OPERATION, [
  "stt-status-cancelled",
]);
registerWorkerErrorReasons("ARCANE_AI_REQUEST_ABORTED", ["stt"], UNLOAD_OPERATION, [
  "stt-unload-cancelled",
]);
registerWorkerErrorReasons("ARCANE_AI_REQUEST_ABORTED", ["stt"], DISPOSE_OPERATION, [
  "stt-dispose-cancelled",
]);
registerWorkerErrorReasons("ARCANE_AI_REQUEST_ABORTED", ["stt"], USE_OPERATION, [
  "stt-transcription-cancelled",
]);
registerWorkerErrorReasons("ARCANE_AI_REQUEST_ABORTED", ["tts"], LOAD_OPERATION, [
  "tts-load-cancelled",
]);
registerWorkerErrorReasons("ARCANE_AI_REQUEST_ABORTED", ["tts"], STATUS_OPERATION, [
  "tts-status-cancelled",
]);
registerWorkerErrorReasons("ARCANE_AI_REQUEST_ABORTED", ["tts"], UNLOAD_OPERATION, [
  "tts-unload-cancelled",
]);
registerWorkerErrorReasons("ARCANE_AI_REQUEST_ABORTED", ["tts"], DISPOSE_OPERATION, [
  "tts-dispose-cancelled",
]);
registerWorkerErrorReasons("ARCANE_AI_REQUEST_ABORTED", ["tts"], USE_OPERATION, [
  "tts-synthesis-cancelled",
]);
registerWorkerErrorReasons("ARCANE_AI_PROVIDER_REQUEST_FAILED", ["stt"], LOAD_OPERATION, [
  "stt-worker-runtime-configuration-rejected",
  "stt-worker-runtime-import-rejected",
  "stt-worker-model-load-rejected",
]);
registerWorkerErrorReasons("ARCANE_AI_PROVIDER_REQUEST_FAILED", ["tts"], LOAD_OPERATION, [
  "tts-worker-runtime-configuration-rejected",
  "tts-worker-runtime-import-rejected",
  "tts-worker-model-load-rejected",
]);
registerWorkerErrorReasons("ARCANE_AI_PROVIDER_REQUEST_FAILED", ["stt"], USE_OPERATION, [
  "stt-transcription-engine-operation-rejected",
]);
registerWorkerErrorReasons("ARCANE_AI_PROVIDER_REQUEST_FAILED", ["tts"], USE_OPERATION, [
  "tts-synthesis-engine-operation-rejected",
]);
registerWorkerErrorReasons(
  "ARCANE_AI_PROVIDER_REQUEST_FAILED",
  ["stt"],
  UNLOAD_OR_DISPOSE_OPERATIONS,
  ["stt-worker-engine-dispose-rejected"],
);
registerWorkerErrorReasons(
  "ARCANE_AI_PROVIDER_REQUEST_FAILED",
  ["tts"],
  UNLOAD_OR_DISPOSE_OPERATIONS,
  ["tts-worker-engine-dispose-rejected"],
);
registerWorkerErrorReasons("ARCANE_AI_PROVIDER_REQUEST_FAILED", ["stt"], DISPOSE_OPERATION, [
  "stt-worker-dispose-rejected",
]);
registerWorkerErrorReasons("ARCANE_AI_PROVIDER_REQUEST_FAILED", ["tts"], DISPOSE_OPERATION, [
  "tts-worker-dispose-rejected",
]);
registerWorkerErrorReasons("ARCANE_AI_PROVIDER_REQUEST_FAILED", ["stt"], STATUS_OPERATION, [
  "stt-worker-status-rejected",
]);
registerWorkerErrorReasons("ARCANE_AI_PROVIDER_REQUEST_FAILED", ["tts"], STATUS_OPERATION, [
  "tts-worker-status-rejected",
]);
registerWorkerErrorReasons("ARCANE_AI_INVALID_REQUEST", BOTH_WORKER_ROLES, LOAD_OPERATION, [
  "artifact-graph-entrypoint-not-materialized",
  "artifact-graph-materialized-file-not-object",
  "artifact-graph-materialized-media-type-empty",
  "artifact-graph-materialized-module-url-empty",
  "artifact-graph-materialized-path-ambiguous",
  "artifact-graph-materialized-path-empty",
  "artifact-graph-materialized-source-url-empty",
  "artifact-graph-runtime-request-routes-not-array",
  "speech-model-sample-rate-not-positive-safe-integer",
  "speech-runtime-entrypoint-not-materialized",
  "speech-worker-configuration-missing",
  "speech-worker-materialized-files-missing",
  "speech-worker-model-dtype-empty",
  "speech-worker-model-id-empty",
  "speech-worker-model-repository-empty",
  "speech-worker-model-revision-empty",
  "speech-worker-runtime-entry-empty",
  "speech-worker-runtime-selection-mismatch",
]);
registerWorkerErrorReasons("ARCANE_AI_INVALID_REQUEST", ["stt"], USE_OPERATION, [
  "stt-transcription-audio-not-float32array",
  "stt-transcription-sample-rate-mismatch",
]);
registerWorkerErrorReasons("ARCANE_AI_INVALID_REQUEST", ["tts"], LOAD_OPERATION, [
  "tts-default-voice-empty",
]);
registerWorkerErrorReasons("ARCANE_AI_INVALID_REQUEST", ["tts"], USE_OPERATION, [
  "tts-synthesis-speed-out-of-range",
  "tts-synthesis-text-empty",
  "tts-synthesis-voice-empty",
  "tts-synthesis-voice-not-declared",
]);
registerWorkerErrorReasons("ARCANE_AI_INVALID_PROVIDER_RESULT", ["stt"], USE_OPERATION, [
  "stt-transcription-result-text-not-string",
]);
registerWorkerErrorReasons("ARCANE_AI_INVALID_PROVIDER_RESULT", ["tts"], USE_OPERATION, [
  "tts-synthesis-pcm-result-not-float32array",
  "tts-synthesis-pcm-sample-non-finite",
  "tts-synthesis-result-sample-rate-mismatch",
]);
registerWorkerErrorReasons(
  "ARCANE_AI_UNDECLARED_ARTIFACT",
  BOTH_WORKER_ROLES,
  LOAD_OR_USE_OPERATIONS,
  [
  "artifact-graph-cache-write-rejected",
  "artifact-graph-runtime-request-url-malformed",
  "speech-worker-artifact-request-method-rejected",
  "speech-worker-artifact-request-undeclared",
  "speech-worker-cache-match-rejected",
  "speech-worker-cache-open-rejected",
  ],
);
registerWorkerErrorReasons("ARCANE_AI_PROVIDER_DISPOSED", ["stt"], LOAD_OPERATION, [
  "stt-load-rejected-after-dispose",
]);
registerWorkerErrorReasons("ARCANE_AI_PROVIDER_DISPOSED", ["tts"], LOAD_OPERATION, [
  "tts-load-rejected-after-dispose",
]);
registerWorkerErrorReasons("ARCANE_AI_NOT_READY", ["stt"], USE_OPERATION, [
  "stt-transcription-rejected-before-load",
]);
registerWorkerErrorReasons("ARCANE_AI_NOT_READY", ["tts"], USE_OPERATION, [
  "tts-synthesis-rejected-before-load",
]);
registerWorkerErrorReasons("ARCANE_AI_PROVIDER_UNAVAILABLE", BOTH_WORKER_ROLES, LOAD_OPERATION, [
  "artifact-graph-fetch-constructor-unavailable",
  "artifact-graph-onnx-wasm-pair-not-materialized",
  "speech-worker-fetch-unavailable",
]);
registerWorkerErrorReasons(
  "ARCANE_AI_PROVIDER_UNAVAILABLE",
  BOTH_WORKER_ROLES,
  LOAD_OR_USE_OPERATIONS,
  [
  "artifact-graph-module-worker-constructor-unavailable",
  "artifact-graph-negative-response-constructor-unavailable",
  ],
);
registerWorkerErrorReasons("ARCANE_AI_PROVIDER_UNAVAILABLE", ["tts"], LOAD_OPERATION, [
  "kokoro-env-wasm-paths-assignment-rejected",
  "kokoro-env-wasm-paths-unavailable",
  "kokoro-tts-constructor-export-missing",
]);
registerWorkerErrorReasons("ARCANE_AI_PROVIDER_UNAVAILABLE", ["stt"], LOAD_OPERATION, [
  "transformers-env-allow-local-models-assignment-rejected",
  "transformers-env-allow-local-models-unavailable",
  "transformers-env-allow-remote-models-assignment-rejected",
  "transformers-env-allow-remote-models-unavailable",
  "transformers-env-backends-onnx-wasm-unavailable",
  "transformers-env-browser-cache-assignment-rejected",
  "transformers-env-browser-cache-unavailable",
  "transformers-env-custom-cache-assignment-rejected",
  "transformers-env-custom-cache-toggle-unavailable",
  "transformers-env-custom-cache-toggle-assignment-rejected",
  "transformers-env-custom-cache-unavailable",
  "transformers-env-fs-cache-assignment-rejected",
  "transformers-env-fs-cache-unavailable",
  "transformers-env-num-threads-assignment-rejected",
  "transformers-env-num-threads-unavailable",
  "transformers-env-wasm-paths-assignment-rejected",
  "transformers-env-wasm-paths-unavailable",
  "transformers-whisper-pipeline-export-missing",
]);
registerWorkerErrorReasons("ARCANE_AI_PROVIDER_UNAVAILABLE", ["stt"], USE_OPERATION, [
  "stt-transcription-method-unavailable",
]);
registerWorkerErrorReasons("ARCANE_AI_PROVIDER_UNAVAILABLE", ["tts"], USE_OPERATION, [
  "tts-synthesis-method-unavailable",
]);
registerWorkerErrorReasons(
  "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
  BOTH_WORKER_ROLES,
  LOAD_OPERATION,
  [
  "artifact-graph-kokoro-voice-inventory-missing",
  "artifact-graph-module-worker-target-not-materialized",
  "artifact-graph-negative-request-routes-not-array",
  "artifact-graph-onnx-wasm-configuration-mismatch",
  "artifact-graph-runtime-request-route-ambiguous",
  "artifact-graph-transform-identity-ambiguous",
  "artifact-graph-transform-kind-not-admitted",
  "artifact-graph-transform-module-path-empty",
  "artifact-graph-transform-occurrence-not-positive-safe-integer",
  "artifact-graph-transformers-cache-edge-ambiguous",
  "artifact-graph-worker-configuration-incomplete",
  ],
);
registerWorkerErrorReasons(
  "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
  BOTH_WORKER_ROLES,
  LOAD_OR_USE_OPERATIONS,
  ["artifact-graph-typed-array-constructor-transform-undeclared"],
);
registerWorkerErrorReasons(
  "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
  ["tts"],
  LOAD_OPERATION,
  [
  "kokoro-env-num-threads-field-not-exposed",
  ],
);
registerWorkerErrorReasons(
  "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
  ["stt"],
  LOAD_OPERATION,
  [
  "transformers-env-num-threads-not-positive-safe-integer",
  ],
);
for (const label of ["cache-open", "dynamic-import", "fetch", "module-worker"]) {
  registerWorkerErrorReasons(
    "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
    BOTH_WORKER_ROLES,
    LOAD_OPERATION,
    [
    `artifact-graph-${label}-edges-not-array`,
    `artifact-graph-${label}-edge-not-object`,
    `artifact-graph-${label}-edge-module-path-empty`,
    `artifact-graph-${label}-edge-occurrence-not-positive-safe-integer`,
    `artifact-graph-${label}-edge-policy-not-admitted`,
    `artifact-graph-${label}-edge-identity-ambiguous`,
    ],
  );
}
registerWorkerErrorReasons(
  "ARCANE_AI_ARTIFACT_GRAPH_IMPORT_EDGE_UNDECLARED",
  BOTH_WORKER_ROLES,
  LOAD_OR_USE_OPERATIONS,
  [
  "artifact-graph-dynamic-import-edge-undeclared",
  "artifact-graph-dynamic-import-edge-undeclared-inactive-runtime-branch-entered",
  "artifact-graph-dynamic-import-target-undeclared",
  ],
);
registerWorkerErrorReasons(
  "ARCANE_AI_ARTIFACT_GRAPH_FETCH_EDGE_UNDECLARED",
  BOTH_WORKER_ROLES,
  LOAD_OR_USE_OPERATIONS,
  [
  "artifact-graph-fetch-edge-undeclared",
  "artifact-graph-fetch-edge-undeclared-inactive-runtime-branch-entered",
  "artifact-graph-fetch-guard-bypassed",
  "artifact-graph-fetch-method-undeclared",
  "artifact-graph-fetch-target-undeclared",
  ],
);
registerWorkerErrorReasons(
  "ARCANE_AI_ARTIFACT_GRAPH_CACHE_EDGE_UNDECLARED",
  BOTH_WORKER_ROLES,
  LOAD_OR_USE_OPERATIONS,
  [
  "artifact-graph-cache-match-guard-bypassed",
  "artifact-graph-cache-name-mismatch",
  "artifact-graph-cache-open-edge-undeclared",
  "artifact-graph-cache-open-edge-undeclared-inactive-runtime-branch-entered",
  "artifact-graph-cache-open-guard-bypassed",
  "artifact-graph-cache-read-target-undeclared",
  ],
);
registerWorkerErrorReasons(
  "ARCANE_AI_ARTIFACT_GRAPH_WORKER_EDGE_UNDECLARED",
  BOTH_WORKER_ROLES,
  LOAD_OR_USE_OPERATIONS,
  [
  "artifact-graph-module-worker-edge-undeclared",
  "artifact-graph-module-worker-edge-undeclared-inactive-runtime-branch-entered",
  "artifact-graph-module-worker-target-undeclared",
  "artifact-graph-module-worker-type-mismatch",
  ],
);
registerWorkerErrorReasons(
  "ARCANE_AI_ARTIFACT_GRAPH_ISOLATION_UNAVAILABLE",
  BOTH_WORKER_ROLES,
  LOAD_OPERATION,
  [
  "artifact-graph-cache-isolation-unavailable",
  "artifact-graph-dynamic-code-constructor-isolation-unavailable",
  "artifact-graph-fetch-isolation-unavailable",
  "artifact-graph-guard-global-collision",
  "artifact-graph-guard-global-definition-rejected",
  "artifact-graph-indexeddb-isolation-unavailable",
  "artifact-graph-opfs-isolation-unavailable",
  "artifact-graph-private-message-port-missing",
  "artifact-graph-setinterval-isolation-unavailable",
  "artifact-graph-settimeout-isolation-unavailable",
  "artifact-graph-typed-array-validation-unavailable",
  "speech-worker-cache-isolation-unavailable",
  "speech-worker-fetch-isolation-unavailable",
  ],
);
registerWorkerErrorReasons(
  "ARCANE_AI_ARTIFACT_GRAPH_ISOLATION_UNAVAILABLE",
  BOTH_WORKER_ROLES,
  LOAD_OR_USE_OPERATIONS,
  [
  "artifact-graph-dynamic-code-constructor-rejected",
  "artifact-graph-guard-capability-mismatch",
  "artifact-graph-setinterval-string-callback-rejected",
  "artifact-graph-settimeout-string-callback-rejected",
  "artifact-graph-typed-array-constructor-intrinsic-mismatch",
  "artifact-graph-typed-array-constructor-receiver-not-typed-array",
  ],
);
for (const name of [
  "broadcastchannel",
  "eventsource",
  "function",
  "rtcpeerconnection",
  "shadowrealm",
  "sharedworker",
  "websocket",
  "websocketstream",
  "webtransport",
  "worker",
  "xmlhttprequest",
  "eval",
  "importscripts",
]) {
  registerWorkerErrorReasons(
    "ARCANE_AI_ARTIFACT_GRAPH_ISOLATION_UNAVAILABLE",
    BOTH_WORKER_ROLES,
    LOAD_OR_USE_OPERATIONS,
    [`artifact-graph-${name}-capability-undeclared`],
  );
  registerWorkerErrorReasons(
    "ARCANE_AI_ARTIFACT_GRAPH_ISOLATION_UNAVAILABLE",
    BOTH_WORKER_ROLES,
    LOAD_OPERATION,
    [`artifact-graph-${name}-isolation-unavailable`],
  );
}
registerWorkerErrorReasons(
  "ARCANE_AI_WORKER_MESSAGE_ERROR",
  BOTH_WORKER_ROLES,
  LOAD_OR_USE_OPERATIONS,
  [
  "artifact-graph-module-worker-error-envelope-rejected",
  "artifact-graph-module-worker-initialization-message-rejected",
  ],
);

function operationFailureReason(role, op) {
  if (op === "load") return `${role}-worker-model-load-rejected`;
  if (op === "use") {
    return role === "stt"
      ? "stt-transcription-engine-operation-rejected"
      : "tts-synthesis-engine-operation-rejected";
  }
  if (op === "unload") return `${role}-worker-engine-dispose-rejected`;
  if (op === "dispose") return `${role}-worker-dispose-rejected`;
  if (op === "status") return `${role}-worker-status-rejected`;
  return `${role}-worker-operation-unknown`;
}

function workerError(code, message, cause, reason) {
  const error = cause === undefined
    ? new Error(message)
    : new Error(message, { cause });
  error.name = code === "ARCANE_AI_REQUEST_ABORTED"
    ? "AbortError"
    : "ArcaneSpeechWorkerError";
  error.code = code;
  if (typeof reason === "string" && reason) error.reason = reason;
  SDK_WORKER_ERRORS.add(error);
  return error;
}

function isSdkWorkerError(value) {
  return value instanceof Error && SDK_WORKER_ERRORS.has(value);
}

function admitWorkerFailure(error, code, message, reason) {
  return isSdkWorkerError(error)
    ? error
    : workerError(code, message, error, reason);
}

function operationReason(role, op, suffix) {
  const subject = op === "use"
    ? role === "stt" ? "stt-transcription" : "tts-synthesis"
    : `${role}-${op}`;
  return `${subject}-${suffix}`;
}

function throwIfAborted(signal, reason) {
  if (!signal?.aborted) return;
  throw workerError(
    "ARCANE_AI_REQUEST_ABORTED",
    "The speech worker operation was cancelled.",
    signal.reason,
    reason,
  );
}

export function collectSpeechTransferables(value) {
  const transfers = [];
  const buffers = new Set();
  const seen = new WeakSet();
  function visit(candidate) {
    if (candidate instanceof ArrayBuffer) {
      if (!buffers.has(candidate)) {
        buffers.add(candidate);
        transfers.push(candidate);
      }
      return;
    }
    if (ArrayBuffer.isView(candidate)) {
      visit(candidate.buffer);
      return;
    }
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    for (const child of Array.isArray(candidate)
      ? candidate
      : Object.values(candidate)) visit(child);
  }
  visit(value);
  return transfers;
}

function serializedError(error, role, op) {
  const admission = isSdkWorkerError(error)
    ? workerErrorReasonAdmission(error.reason, role, op)
    : null;
  const admittedCode = isSdkWorkerError(error)
    && Object.hasOwn(WORKER_ERROR_MESSAGES, error.code)
    && admission?.code === error.code;
  const code = admittedCode ? error.code : "ARCANE_AI_PROVIDER_REQUEST_FAILED";
  const reason = admittedCode ? error.reason : operationFailureReason(role, op);
  return Object.freeze({
    protocol: SPEECH_WORKER_ERROR_PROTOCOL,
    code,
    message: WORKER_ERROR_MESSAGES[code],
    reason,
  });
}

function workerErrorReasonAdmission(reason, role, op) {
  const admission = WORKER_ERROR_REASON_ADMISSIONS.get(reason);
  return admission
    && admission.roles.includes(role)
    && admission.operations.includes(op)
    ? admission
    : null;
}

export function normalizeSpeechWorkerErrorEnvelope(value, role, op) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let descriptors;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")
      || keys.sort().join(",") !== "code,message,protocol,reason") return null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  for (const key of ["code", "message", "protocol", "reason"]) {
    if (!Object.hasOwn(descriptors[key], "value")) return null;
  }
  const protocol = descriptors.protocol.value;
  const code = descriptors.code.value;
  const message = descriptors.message.value;
  const reason = descriptors.reason.value;
  if (protocol !== SPEECH_WORKER_ERROR_PROTOCOL) return null;
  if (!Object.hasOwn(WORKER_ERROR_MESSAGES, code)) return null;
  if (message !== WORKER_ERROR_MESSAGES[code]) return null;
  const admission = workerErrorReasonAdmission(reason, role, op);
  if (admission?.code !== code) return null;
  return Object.freeze({
    code,
    message,
    reason,
  });
}

function requiredText(
  value,
  label,
  reason,
) {
  if (typeof value !== "string" || !value.trim()) {
    throw workerError(
      "ARCANE_AI_INVALID_REQUEST",
      `${label} is required.`,
      undefined,
      reason,
    );
  }
  return value.trim();
}

function requiredSampleRate(value, label, fallback) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw workerError(
      "ARCANE_AI_INVALID_REQUEST",
      `${label} must be a positive safe integer.`,
      undefined,
      "speech-model-sample-rate-not-positive-safe-integer",
    );
  }
  return candidate;
}

function graphConfiguration(configuration) {
  return configuration?.runtime?.moduleGraph === ARTIFACT_GRAPH_MODULE_GRAPH;
}

function validateMaterializedFile(file, label) {
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw workerError(
      "ARCANE_AI_INVALID_REQUEST",
      `${label} must be an object.`,
      undefined,
      "artifact-graph-materialized-file-not-object",
    );
  }
  requiredText(file.path, `${label} path`, "artifact-graph-materialized-path-empty");
  requiredText(file.sourceUrl, `${label} sourceUrl`, "artifact-graph-materialized-source-url-empty");
  requiredText(file.moduleUrl, `${label} moduleUrl`, "artifact-graph-materialized-module-url-empty");
  requiredText(file.mediaType, `${label} mediaType`, "artifact-graph-materialized-media-type-empty");
  if (file.runtimeRequestUrls !== undefined && !Array.isArray(file.runtimeRequestUrls)) {
    throw workerError(
      "ARCANE_AI_INVALID_REQUEST",
      `${label} runtimeRequestUrls must be an array.`,
      undefined,
      "artifact-graph-runtime-request-routes-not-array",
    );
  }
  return file;
}

function validateConfiguration(configuration, role) {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    throw workerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Speech worker configuration is required.",
      undefined,
      "speech-worker-configuration-missing",
    );
  }
  const moduleGraph = configuration.runtime?.moduleGraph;
  if (
    configuration.role !== role
    || configuration.runtime?.adapter !== ADAPTERS[role]
    || (moduleGraph !== "self-contained" && moduleGraph !== ARTIFACT_GRAPH_MODULE_GRAPH)
  ) {
    throw workerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Speech worker role, runtime adapter, or module graph does not match.",
      undefined,
      "speech-worker-runtime-selection-mismatch",
    );
  }
  requiredText(configuration.model?.id, "Speech model id", "speech-worker-model-id-empty");
  requiredText(configuration.model?.repository, "Speech model repository", "speech-worker-model-repository-empty");
  requiredText(configuration.model?.revision, "Speech model revision", "speech-worker-model-revision-empty");
  requiredText(configuration.runtime?.entry, "Speech runtime entry", "speech-worker-runtime-entry-empty");
  if (!Array.isArray(configuration.runtime?.files) || !Array.isArray(configuration.model?.files)) {
    throw workerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Speech runtime and model files are required.",
      undefined,
      "speech-worker-materialized-files-missing",
    );
  }
  const entry = configuration.runtime.files.find((file) =>
    file.path === configuration.runtime.entry);
  if (!entry?.moduleUrl) {
    throw workerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Speech runtime entry was not materialized.",
      undefined,
      moduleGraph === ARTIFACT_GRAPH_MODULE_GRAPH
        ? "artifact-graph-entrypoint-not-materialized"
        : "speech-runtime-entrypoint-not-materialized",
    );
  }
  if (moduleGraph === ARTIFACT_GRAPH_MODULE_GRAPH) {
    const allFiles = [
      ...configuration.runtime.files,
      ...configuration.model.files,
    ];
    const paths = new Set();
    for (let index = 0; index < allFiles.length; index += 1) {
      const file = validateMaterializedFile(allFiles[index], `Speech file ${String(index)}`);
      if (paths.has(file.path)) {
        throw workerError(
          "ARCANE_AI_INVALID_REQUEST",
          "Speech materialized file paths must be unique.",
          undefined,
          "artifact-graph-materialized-path-ambiguous",
        );
      }
      paths.add(file.path);
    }
    const runtimePaths = new Set(configuration.runtime.files.map((file) => file.path));
    if (
      configuration.security?.secure !== true
      || typeof configuration.runtime.artifactGraphId !== "string"
      || !/^[a-f0-9]{64}$/u.test(configuration.runtime.artifactGraphId)
      || (
        typeof configuration.runtime.guardCapability !== "string"
        || !/^[a-f0-9]{64}$/u.test(configuration.runtime.guardCapability)
        || !STRICT_GRAPH_ADMISSIONS.has(configuration.runtime.artifactGraphAdmission)
        || !configuration.runtime.edges
        || typeof configuration.runtime.edges !== "object"
        || !Array.isArray(configuration.runtime.transforms)
      )
    ) {
      throw workerError(
        "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
        "Explicit secure:true plus authenticated artifact graph identity, admission, edges, and transforms are required.",
        undefined,
        "artifact-graph-worker-configuration-incomplete",
      );
    }
    const wasm = configuration.runtime.onnxWasm;
    if (
      !wasm
      || wasm.namespace !== ONNX_NAMESPACES[role]
      || !runtimePaths.has(wasm.mjsPath)
      || !runtimePaths.has(wasm.wasmPath)
    ) {
      throw workerError(
        "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
        "The authenticated ONNX Runtime Web MJS/WASM pair is incomplete or uses the wrong namespace.",
        undefined,
        "artifact-graph-onnx-wasm-configuration-mismatch",
      );
    }
    if (role === "tts" && wasm.numThreads !== undefined) {
      throw workerError(
        "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
        "Kokoro does not expose a verified numThreads configuration field.",
        undefined,
        "kokoro-env-num-threads-field-not-exposed",
      );
    }
    if (
      wasm.numThreads !== undefined
      && (!Number.isSafeInteger(wasm.numThreads) || wasm.numThreads < 1)
    ) {
      throw workerError(
        "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
        "Transformers numThreads must be a positive safe integer.",
        undefined,
        "transformers-env-num-threads-not-positive-safe-integer",
      );
    }
    requiredText(configuration.model?.dtype, "Speech model dtype", "speech-worker-model-dtype-empty");
    if (role === "stt") {
      requiredSampleRate(configuration.model.inputSampleRate, "Whisper inputSampleRate");
    } else {
      requiredSampleRate(configuration.model.outputSampleRate, "Kokoro outputSampleRate");
      requiredText(configuration.model.defaultVoice, "Kokoro defaultVoice", "tts-default-voice-empty");
      if (!Array.isArray(configuration.model.voices) || configuration.model.voices.length < 1) {
        throw workerError(
          "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
          "Kokoro graph configuration requires the caller-owned voice inventory.",
          undefined,
          "artifact-graph-kokoro-voice-inventory-missing",
        );
      }
    }
    if (
      configuration.runtime.negativeRuntimeRequestUrls !== undefined
      && !Array.isArray(configuration.runtime.negativeRuntimeRequestUrls)
    ) {
      throw workerError(
        "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
        "Artifact graph negative runtime request routes must be an array.",
        undefined,
        "artifact-graph-negative-request-routes-not-array",
      );
    }
  }
  return configuration;
}

function absoluteRequestUrl(value, scope) {
  const input = typeof value === "string" || value instanceof URL
    ? String(value)
    : value?.url;
  try {
    return new URL(input, scope.location?.href).href;
  } catch {
    throw workerError(
      "ARCANE_AI_UNDECLARED_ARTIFACT",
      "The speech engine requested a malformed artifact URL.",
      undefined,
      "artifact-graph-runtime-request-url-malformed",
    );
  }
}

function createArtifactRoutes(scope, configuration) {
  const positive = new Map();
  const negative = new Set();
  const files = [
    ...configuration.runtime.files,
    ...configuration.model.files,
  ];

  function addPositive(route, file) {
    const absolute = absoluteRequestUrl(route, scope);
    const existing = positive.get(absolute);
    if (existing && existing.path !== file.path) {
      throw workerError(
        "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
        "An artifact graph runtime request route names more than one file.",
        undefined,
        "artifact-graph-runtime-request-route-ambiguous",
      );
    }
    positive.set(absolute, file);
  }

  for (const file of files) {
    addPositive(file.sourceUrl, file);
    addPositive(file.moduleUrl, file);
    for (const route of file.runtimeRequestUrls ?? []) addPositive(route, file);
  }
  for (const route of configuration.runtime.negativeRuntimeRequestUrls ?? []) {
    const absolute = absoluteRequestUrl(route, scope);
    if (positive.has(absolute) || negative.has(absolute)) {
      throw workerError(
        "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
        "Artifact graph positive and negative runtime request routes overlap.",
        undefined,
        "artifact-graph-runtime-request-route-ambiguous",
      );
    }
    negative.add(absolute);
  }
  return Object.freeze({ files, positive, negative });
}

function requestMethod(input, init, scope) {
  const RequestConstructor = scope.Request ?? globalThis.Request;
  const inherited = typeof RequestConstructor === "function" && input instanceof RequestConstructor
    ? input.method
    : "GET";
  return String(init?.method ?? inherited ?? "GET").toUpperCase();
}

function installScopeValue(scope, name, value, reason) {
  const descriptor = Object.getOwnPropertyDescriptor(scope, name);
  if (descriptor?.configurable === false && descriptor.writable !== true) {
    throw workerError(
      "ARCANE_AI_ARTIFACT_GRAPH_ISOLATION_UNAVAILABLE",
      `The speech Worker cannot isolate globalThis.${name}.`,
      undefined,
      reason,
    );
  }
  try {
    if (descriptor?.configurable === false) {
      scope[name] = value;
    } else {
      Object.defineProperty(scope, name, {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        writable: false,
        value,
      });
    }
  } catch (error) {
    throw workerError(
      "ARCANE_AI_ARTIFACT_GRAPH_ISOLATION_UNAVAILABLE",
      `The speech Worker could not isolate globalThis.${name}.`,
      error,
      reason,
    );
  }
  return function restoreScopeValue() {
    if (descriptor) Object.defineProperty(scope, name, descriptor);
    else delete scope[name];
  };
}

function restoreScopeValues(restores) {
  for (const restore of restores.splice(0).reverse()) {
    try {
      restore();
    } catch {
      // Terminating the owning Worker remains the final isolation boundary.
    }
  }
}

function installObjectValue(object, name, value, label, reason) {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  if (descriptor?.configurable === false && descriptor.writable !== true) {
    throw workerError(
      "ARCANE_AI_ARTIFACT_GRAPH_ISOLATION_UNAVAILABLE",
      `The speech Worker cannot isolate ${label}.`,
      undefined,
      reason,
    );
  }
  try {
    Object.defineProperty(object, name, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      writable: false,
      value,
    });
  } catch (error) {
    throw workerError(
      "ARCANE_AI_ARTIFACT_GRAPH_ISOLATION_UNAVAILABLE",
      `The speech Worker could not isolate ${label}.`,
      error,
      reason,
    );
  }
  return function restoreObjectValue() {
    if (descriptor) Object.defineProperty(object, name, descriptor);
    else delete object[name];
  };
}

function createRouteReader(scope, configuration, originalFetch) {
  const routes = createArtifactRoutes(scope, configuration);
  const ResponseConstructor = scope.Response ?? globalThis.Response;

  async function responseFor(resolution, signal) {
    if (resolution.kind === "negative") {
      if (typeof ResponseConstructor !== "function") {
        throw workerError(
          "ARCANE_AI_PROVIDER_UNAVAILABLE",
          "Browser Response is unavailable in the speech Worker.",
          undefined,
          "artifact-graph-negative-response-constructor-unavailable",
        );
      }
      return new ResponseConstructor(null, {
        status: 404,
        statusText: "Not Found",
        headers: { "cache-control": "no-store" },
      });
    }
    return originalFetch(resolution.file.moduleUrl, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      signal,
    });
  }

  function resolve(input) {
    const absolute = absoluteRequestUrl(input, scope);
    const file = routes.positive.get(absolute);
    if (file) return Object.freeze({ kind: "file", absolute, file });
    if (routes.negative.has(absolute)) {
      return Object.freeze({ kind: "negative", absolute, file: null });
    }
    return null;
  }

  function cacheForPaths(targetPaths) {
    const admittedPaths = new Set(targetPaths);
    return Object.freeze({
      async match(input) {
        const resolution = resolve(input);
        if (
          !resolution
          || resolution.kind !== "file"
          || !admittedPaths.has(resolution.file.path)
        ) {
          throw workerError(
            "ARCANE_AI_ARTIFACT_GRAPH_CACHE_EDGE_UNDECLARED",
            "The runtime cache read target is outside its admitted artifact graph edge.",
            undefined,
            "artifact-graph-cache-read-target-undeclared",
          );
        }
        return responseFor(resolution);
      },
      async put() {
        throw workerError(
          "ARCANE_AI_UNDECLARED_ARTIFACT",
          "Speech runtime cache writes are disabled; DBOPFS is the sole durable artifact store.",
          undefined,
          "artifact-graph-cache-write-rejected",
        );
      },
      async add() {
        throw workerError(
          "ARCANE_AI_UNDECLARED_ARTIFACT",
          "Speech runtime cache writes are disabled; DBOPFS is the sole durable artifact store.",
          undefined,
          "artifact-graph-cache-write-rejected",
        );
      },
      async addAll() {
        throw workerError(
          "ARCANE_AI_UNDECLARED_ARTIFACT",
          "Speech runtime cache writes are disabled; DBOPFS is the sole durable artifact store.",
          undefined,
          "artifact-graph-cache-write-rejected",
        );
      },
      async delete() {
        return false;
      },
      async keys() {
        return Object.freeze([]);
      },
    });
  }

  const cache = cacheForPaths(routes.files.map((file) => file.path));
  return Object.freeze({ cache, cacheForPaths, resolve, responseFor, routes });
}

function installLegacyAuthorizedFetch(scope, configuration) {
  const original = scope.fetch?.bind(scope);
  if (typeof original !== "function") {
    throw workerError(
      "ARCANE_AI_PROVIDER_UNAVAILABLE",
      "Browser fetch is unavailable in the speech Worker.",
      undefined,
      "speech-worker-fetch-unavailable",
    );
  }
  const reader = createRouteReader(scope, configuration, original);
  const authorized = async function fetchAuthorizedSpeechArtifact(input, init) {
    if (requestMethod(input, init, scope) !== "GET") {
      throw workerError(
        "ARCANE_AI_UNDECLARED_ARTIFACT",
        "Legacy speech artifacts admit only GET requests.",
        undefined,
        "speech-worker-artifact-request-method-rejected",
      );
    }
    const resolution = reader.resolve(input);
    if (!resolution) {
      throw workerError(
        "ARCANE_AI_UNDECLARED_ARTIFACT",
        "The speech engine requested an artifact outside its admitted file map.",
        undefined,
        "speech-worker-artifact-request-undeclared",
      );
    }
    return reader.responseFor(resolution, init?.signal);
  };
  const restore = installScopeValue(
    scope,
    "fetch",
    authorized,
    "speech-worker-fetch-isolation-unavailable",
  );
  return Object.freeze({ cache: null, cleanup: restore });
}

function installDeniedCacheIsolation(scope) {
  const denied = Object.freeze({
    async open() {
      throw workerError(
        "ARCANE_AI_UNDECLARED_ARTIFACT",
        "Speech runtime cache access is disabled; DBOPFS admission is the sole artifact source.",
        undefined,
        "speech-worker-cache-open-rejected",
      );
    },
    async match() {
      throw workerError(
        "ARCANE_AI_UNDECLARED_ARTIFACT",
        "Speech runtime cache access is disabled; DBOPFS admission is the sole artifact source.",
        undefined,
        "speech-worker-cache-match-rejected",
      );
    },
    async has() {
      return false;
    },
    async keys() {
      return Object.freeze([]);
    },
    async delete() {
      return false;
    },
  });
  return installScopeValue(
    scope,
    "caches",
    denied,
    "speech-worker-cache-isolation-unavailable",
  );
}

function edgeKey(modulePath, occurrence) {
  return `${modulePath}\u0000${String(occurrence)}`;
}

function edgeMap(edges, label) {
  if (!Array.isArray(edges)) {
    throw workerError(
      "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
      `Artifact graph ${label} edges must be an array.`,
      undefined,
      `artifact-graph-${label}-edges-not-array`,
    );
  }
  const map = new Map();
  for (const edge of edges) {
    if (!edge || typeof edge !== "object" || Array.isArray(edge)) {
      throw workerError(
        "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
        `Artifact graph ${label} edge must be an object.`,
        undefined,
        `artifact-graph-${label}-edge-not-object`,
      );
    }
    if (typeof edge.modulePath !== "string" || !edge.modulePath) {
      throw workerError(
        "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
        `Artifact graph ${label} edge modulePath must be nonempty.`,
        undefined,
        `artifact-graph-${label}-edge-module-path-empty`,
      );
    }
    if (!Number.isSafeInteger(edge.occurrence) || edge.occurrence < 1) {
      throw workerError(
        "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
        `Artifact graph ${label} edge occurrence must be a positive safe integer.`,
        undefined,
        `artifact-graph-${label}-edge-occurrence-not-positive-safe-integer`,
      );
    }
    if (edge.edgePolicy !== "artifact-targets-admitted"
      && edge.edgePolicy !== "inactive-runtime-branch-rejected") {
      throw workerError(
        "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
        `Artifact graph ${label} edge policy is not admitted.`,
        undefined,
        `artifact-graph-${label}-edge-policy-not-admitted`,
      );
    }
    const key = edgeKey(edge.modulePath, edge.occurrence);
    if (map.has(key)) {
      throw workerError(
        "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
        `Artifact graph ${label} edge identity is ambiguous.`,
        undefined,
        `artifact-graph-${label}-edge-identity-ambiguous`,
      );
    }
    map.set(key, edge);
  }
  return map;
}

function transformSet(transforms, kind) {
  const result = new Set();
  for (const transform of transforms) {
    if (!ARTIFACT_GRAPH_TRANSFORM_KINDS.has(transform?.kind)) {
      throw workerError(
        "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
        "Artifact graph Worker configuration contains a transform kind that is not admitted.",
        undefined,
        "artifact-graph-transform-kind-not-admitted",
      );
    }
    if (transform?.kind !== kind) continue;
    if (typeof transform.modulePath !== "string" || !transform.modulePath) {
      throw workerError(
        "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
        `Artifact graph ${kind} transform modulePath must be nonempty.`,
        undefined,
        "artifact-graph-transform-module-path-empty",
      );
    }
    if (!Number.isSafeInteger(transform.occurrence) || transform.occurrence < 1) {
      throw workerError(
        "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
        `Artifact graph ${kind} transform occurrence must be a positive safe integer.`,
        undefined,
        "artifact-graph-transform-occurrence-not-positive-safe-integer",
      );
    }
    const key = edgeKey(transform.modulePath, transform.occurrence);
    if (result.has(key)) {
      throw workerError(
        "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
        `Artifact graph ${kind} transform identity is ambiguous.`,
        undefined,
        "artifact-graph-transform-identity-ambiguous",
      );
    }
    result.add(key);
  }
  return result;
}

function typedArrayIntrinsics(scope) {
  const constructors = new Map();
  for (const name of [
    "BigInt64Array",
    "BigUint64Array",
    "Float32Array",
    "Float64Array",
    "Int8Array",
    "Int16Array",
    "Int32Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Uint16Array",
    "Uint32Array",
  ]) {
    const Constructor = scope[name] ?? globalThis[name];
    if (typeof Constructor === "function" && Constructor.prototype) {
      constructors.set(Constructor.prototype, Constructor);
    }
  }
  const ArrayBufferConstructor = scope.ArrayBuffer ?? globalThis.ArrayBuffer;
  const DataViewConstructor = scope.DataView ?? globalThis.DataView;
  if (typeof ArrayBufferConstructor?.isView !== "function") {
    throw workerError(
      "ARCANE_AI_ARTIFACT_GRAPH_ISOLATION_UNAVAILABLE",
      "Authenticated artifact graph typed-array validation is unavailable.",
      undefined,
      "artifact-graph-typed-array-validation-unavailable",
    );
  }
  return Object.freeze({
    constructors,
    dataViewPrototype: DataViewConstructor?.prototype ?? null,
    getPrototypeOf: Object.getPrototypeOf,
    hasOwn: Object.hasOwn,
    isView: ArrayBufferConstructor.isView.bind(ArrayBufferConstructor),
  });
}

function runtimeFileMap(configuration) {
  return new Map(configuration.runtime.files.map((file) => [file.path, file]));
}

function targetRecords(edge) {
  if (Array.isArray(edge.targets)) return edge.targets;
  if (Array.isArray(edge.targetPaths)) {
    return edge.targetPaths.map((targetPath) => ({ targetPath }));
  }
  return [];
}

function targetForRequest(edge, requested, files, sourceFile) {
  const value = String(requested);
  for (const target of targetRecords(edge)) {
    const file = files.get(target?.targetPath);
    if (!file) continue;
    if (target.match === "exact-runtime-specifier") {
      if (value === target.exactSpecifier) return file;
      continue;
    }
    if (target.match === "self-module-url") {
      if (file.path === sourceFile?.path && value === sourceFile.moduleUrl) return file;
      continue;
    }
    if (target.match === "materialized-module-url" && value === file.moduleUrl) {
      return file;
    }
  }
  return null;
}

function nestedWorkerUrl(role) {
  const url = new URL(
    role === "stt"
      ? "./browser-whisper-worker.mjs"
      : "./browser-kokoro-worker.mjs",
    import.meta.url,
  );
  url.searchParams.set("arcaneSpeechWorkerMode", "artifact-module-worker");
  return url;
}

function nestedWorkerFailureEvent(scope, error) {
  const ErrorEventConstructor = scope.ErrorEvent ?? globalThis.ErrorEvent;
  if (typeof ErrorEventConstructor === "function") {
    return new ErrorEventConstructor("error", {
      error,
      message: error.message,
      cancelable: true,
    });
  }
  const EventConstructor = scope.Event ?? globalThis.Event;
  const event = new EventConstructor("error", { cancelable: true });
  Object.defineProperties(event, {
    error: { value: error },
    message: { value: error.message },
  });
  return event;
}

function createArtifactGraphGuard(scope, configuration, role, reader, originalWorker) {
  const files = runtimeFileMap(configuration);
  const edges = configuration.runtime.edges;
  const imports = edgeMap(edges.dynamicImports ?? [], "dynamic-import");
  const fetches = edgeMap(edges.fetches ?? [], "fetch");
  const workers = edgeMap(edges.moduleWorkers ?? [], "module-worker");
  const cacheOpens = edgeMap(edges.cacheOpens ?? [], "cache-open");
  const typedArrayConstructors = transformSet(
    configuration.runtime.transforms,
    "typed-array-constructor",
  );
  transformSet(configuration.runtime.transforms, "function-return-this-to-global-this");
  const typedArrays = typedArrayIntrinsics(scope);
  const guardCapability = configuration.runtime.guardCapability;
  const nestedWorkers = new Set();

  function assertGuardCapability(candidate) {
    if (candidate === guardCapability) return;
    throw workerError(
      "ARCANE_AI_ARTIFACT_GRAPH_ISOLATION_UNAVAILABLE",
      "Authenticated artifact graph runtime guard capability did not match.",
      undefined,
      "artifact-graph-guard-capability-mismatch",
    );
  }

  function declaredEdge(map, modulePath, occurrence, code, reason) {
    const edge = map.get(edgeKey(modulePath, occurrence));
    if (edge?.edgePolicy === "artifact-targets-admitted") return edge;
    if (edge?.edgePolicy === "inactive-runtime-branch-rejected") {
      throw workerError(
        code,
        "The runtime entered an artifact graph branch declared inactive.",
        undefined,
        `${reason}-inactive-runtime-branch-entered`,
      );
    }
    throw workerError(
      code,
      "The runtime used an undeclared authenticated artifact graph edge.",
      undefined,
      reason,
    );
  }

  function fetchEdgeAllows(edge, resolution) {
    if (resolution.kind === "negative") {
      return (edge.negativeRuntimeRequestUrls ?? [])
        .map((route) => absoluteRequestUrl(route, scope))
        .includes(resolution.absolute);
    }
    const paths = new Set([
      ...(edge.targetPaths ?? []),
      ...targetRecords(edge).map((target) => target?.targetPath),
    ]);
    if (!paths.has(resolution.file.path)) return false;
    if (resolution.absolute === absoluteRequestUrl(resolution.file.moduleUrl, scope)) {
      return edge.allowMaterializedUrls === true;
    }
    return true;
  }

  const guard = Object.freeze({
    protocol: "arcane-ai-browser-speech-artifact-graph-runtime/1",

    async dynamicImport(capability, modulePath, occurrence, specifier) {
      assertGuardCapability(capability);
      const edge = declaredEdge(
        imports,
        modulePath,
        occurrence,
        "ARCANE_AI_ARTIFACT_GRAPH_IMPORT_EDGE_UNDECLARED",
        "artifact-graph-dynamic-import-edge-undeclared",
      );
      const sourceFile = files.get(modulePath);
      const target = targetForRequest(edge, specifier, files, sourceFile);
      if (!target) {
        throw workerError(
          "ARCANE_AI_ARTIFACT_GRAPH_IMPORT_EDGE_UNDECLARED",
          "The runtime dynamic import target is outside its admitted artifact graph edge.",
          undefined,
          "artifact-graph-dynamic-import-target-undeclared",
        );
      }
      return import(target.moduleUrl);
    },

    async fetch(capability, modulePath, occurrence, input, init) {
      assertGuardCapability(capability);
      const edge = declaredEdge(
        fetches,
        modulePath,
        occurrence,
        "ARCANE_AI_ARTIFACT_GRAPH_FETCH_EDGE_UNDECLARED",
        "artifact-graph-fetch-edge-undeclared",
      );
      const method = requestMethod(input, init, scope);
      if (!(edge.methods ?? ["GET"]).includes(method)) {
        throw workerError(
          "ARCANE_AI_ARTIFACT_GRAPH_FETCH_EDGE_UNDECLARED",
          "The runtime fetch method is outside its admitted artifact graph edge.",
          undefined,
          "artifact-graph-fetch-method-undeclared",
        );
      }
      const resolution = reader.resolve(input);
      if (!resolution || !fetchEdgeAllows(edge, resolution)) {
        throw workerError(
          "ARCANE_AI_ARTIFACT_GRAPH_FETCH_EDGE_UNDECLARED",
          "The runtime fetch target is outside its admitted artifact graph edge.",
          undefined,
          "artifact-graph-fetch-target-undeclared",
        );
      }
      return reader.responseFor(resolution, init?.signal);
    },

    async openCache(capability, modulePath, occurrence, cacheName) {
      assertGuardCapability(capability);
      const edge = declaredEdge(
        cacheOpens,
        modulePath,
        occurrence,
        "ARCANE_AI_ARTIFACT_GRAPH_CACHE_EDGE_UNDECLARED",
        "artifact-graph-cache-open-edge-undeclared",
      );
      if (cacheName !== edge.cacheName) {
        throw workerError(
          "ARCANE_AI_ARTIFACT_GRAPH_CACHE_EDGE_UNDECLARED",
          "The runtime cache name is outside its admitted artifact graph edge.",
          undefined,
          "artifact-graph-cache-name-mismatch",
        );
      }
      return reader.cacheForPaths(edge.targetPaths);
    },

    createWorker(capability, modulePath, occurrence, specifier, options = {}) {
      assertGuardCapability(capability);
      const edge = declaredEdge(
        workers,
        modulePath,
        occurrence,
        "ARCANE_AI_ARTIFACT_GRAPH_WORKER_EDGE_UNDECLARED",
        "artifact-graph-module-worker-edge-undeclared",
      );
      const sourceFile = files.get(modulePath);
      const target = targetForRequest(edge, specifier, files, sourceFile);
      if (!target) {
        throw workerError(
          "ARCANE_AI_ARTIFACT_GRAPH_WORKER_EDGE_UNDECLARED",
          "The runtime module Worker target is outside its admitted artifact graph edge.",
          undefined,
          "artifact-graph-module-worker-target-undeclared",
        );
      }
      if (options?.type !== "module") {
        throw workerError(
          "ARCANE_AI_ARTIFACT_GRAPH_WORKER_EDGE_UNDECLARED",
          "Authenticated artifact graph child Workers must be module Workers.",
          undefined,
          "artifact-graph-module-worker-type-mismatch",
        );
      }
      if (typeof originalWorker !== "function") {
        throw workerError(
          "ARCANE_AI_PROVIDER_UNAVAILABLE",
          "Nested browser module Workers are unavailable.",
          undefined,
          "artifact-graph-module-worker-constructor-unavailable",
        );
      }
      const worker = new originalWorker(nestedWorkerUrl(role), {
        type: "module",
        name: typeof options.name === "string" ? options.name : "arcane-speech-artifact-module",
      });
      nestedWorkers.add(worker);
      const onBootstrapMessage = (event) => {
        if (event.data?.protocol !== NESTED_WORKER_PROTOCOL
          || event.data?.event !== "artifact-module-worker-bootstrap-rejected") return;
        event.stopImmediatePropagation?.();
        const admitted = normalizeSpeechWorkerErrorEnvelope(event.data.error, role, "load");
        const failure = admitted
          ? workerError(admitted.code, admitted.message, undefined, admitted.reason)
          : workerError(
            "ARCANE_AI_WORKER_MESSAGE_ERROR",
            "The authenticated artifact module Worker error envelope was rejected.",
            undefined,
            "artifact-graph-module-worker-error-envelope-rejected",
          );
        worker.dispatchEvent?.(nestedWorkerFailureEvent(scope, failure));
      };
      worker.addEventListener?.("message", onBootstrapMessage);
      try {
        worker.postMessage({
          protocol: NESTED_WORKER_PROTOCOL,
          op: "initialize-authenticated-artifact-module-worker",
          role,
          targetPath: target.path,
          configuration,
        });
      } catch (error) {
        nestedWorkers.delete(worker);
        worker.terminate();
        throw workerError(
          "ARCANE_AI_WORKER_MESSAGE_ERROR",
          "The authenticated artifact module Worker initialization message was rejected.",
          error,
          "artifact-graph-module-worker-initialization-message-rejected",
        );
      }
      return worker;
    },

    typedArrayConstructor(capability, modulePath, occurrence, receiver) {
      assertGuardCapability(capability);
      if (!typedArrayConstructors.has(edgeKey(modulePath, occurrence))) {
        throw workerError(
          "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
          "The runtime used an undeclared typed-array constructor transform.",
          undefined,
          "artifact-graph-typed-array-constructor-transform-undeclared",
        );
      }
      if (
        !typedArrays.isView(receiver)
        || typedArrays.getPrototypeOf(receiver) === typedArrays.dataViewPrototype
        || typedArrays.hasOwn(receiver, "constructor")
      ) {
        throw workerError(
          "ARCANE_AI_ARTIFACT_GRAPH_ISOLATION_UNAVAILABLE",
          "The typed-array constructor transform received an unauthenticated receiver.",
          undefined,
          "artifact-graph-typed-array-constructor-receiver-not-typed-array",
        );
      }
      const Constructor = typedArrays.constructors.get(
        typedArrays.getPrototypeOf(receiver),
      );
      if (typeof Constructor !== "function") {
        throw workerError(
          "ARCANE_AI_ARTIFACT_GRAPH_ISOLATION_UNAVAILABLE",
          "The typed-array constructor transform receiver does not use an intrinsic prototype.",
          undefined,
          "artifact-graph-typed-array-constructor-intrinsic-mismatch",
        );
      }
      return Constructor;
    },
  });

  return Object.freeze({
    guard,
    transformersCache: (() => {
      const edgesForTransformers = [...cacheOpens.values()].filter((edge) =>
        edge.edgePolicy === "artifact-targets-admitted"
        && edge.cacheName === "transformers-cache");
      if (edgesForTransformers.length === 0) return null;
      if (edgesForTransformers.length !== 1) {
        throw workerError(
          "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
          "The Transformers custom cache edge is ambiguous.",
          undefined,
          "artifact-graph-transformers-cache-edge-ambiguous",
        );
      }
      return reader.cacheForPaths(edgesForTransformers[0].targetPaths);
    })(),
    cleanup() {
      for (const worker of nestedWorkers) {
        try {
          worker.terminate();
        } catch {
          // The owning speech Worker is already being torn down.
        }
      }
      nestedWorkers.clear();
    },
  });
}

function installDynamicCodeConstructorIsolation() {
  const rejectingConstructor = function rejectArtifactGraphDynamicCodeConstructor() {
    throw workerError(
      "ARCANE_AI_ARTIFACT_GRAPH_ISOLATION_UNAVAILABLE",
      "Authenticated artifact graph runtime code cannot construct executable strings.",
      undefined,
      "artifact-graph-dynamic-code-constructor-rejected",
    );
  };
  const prototypes = new Set([
    Object.getPrototypeOf(function artifactGraphFunctionProbe() {}),
    Object.getPrototypeOf(async function artifactGraphAsyncFunctionProbe() {}),
    Object.getPrototypeOf(function* artifactGraphGeneratorFunctionProbe() {}),
    Object.getPrototypeOf(async function* artifactGraphAsyncGeneratorFunctionProbe() {}),
  ]);
  const restores = [];
  try {
    for (const prototype of prototypes) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
      if (!descriptor || (descriptor.configurable === false && descriptor.writable !== true)) {
        throw workerError(
          "ARCANE_AI_ARTIFACT_GRAPH_ISOLATION_UNAVAILABLE",
          "The Worker cannot isolate a dynamic-code constructor prototype.",
          undefined,
          "artifact-graph-dynamic-code-constructor-isolation-unavailable",
        );
      }
      Object.defineProperty(prototype, "constructor", {
        ...descriptor,
        value: rejectingConstructor,
      });
      restores.push(() => Object.defineProperty(prototype, "constructor", descriptor));
    }
  } catch (error) {
    restoreScopeValues(restores);
    throw error;
  }
  return () => restoreScopeValues(restores);
}

function installStringTimerIsolation(scope, name) {
  const original = scope[name];
  if (typeof original !== "function") return () => undefined;
  const invoke = original.bind(scope);
  return installScopeValue(
    scope,
    name,
    function authenticatedArtifactGraphTimer(callback, ...arguments_) {
      if (typeof callback !== "function") {
        throw workerError(
          "ARCANE_AI_ARTIFACT_GRAPH_ISOLATION_UNAVAILABLE",
          `Authenticated artifact graph ${name} requires a function callback.`,
          undefined,
          `artifact-graph-${name.toLowerCase()}-string-callback-rejected`,
        );
      }
      return invoke(callback, ...arguments_);
    },
    `artifact-graph-${name.toLowerCase()}-isolation-unavailable`,
  );
}

function installArtifactGraphEnvironment(scope, configuration, role) {
  const originalFetch = scope.fetch?.bind(scope);
  const originalWorker = scope.Worker;
  const strictSecurity = configuration.security?.secure === true;
  if (typeof originalFetch !== "function") {
    throw workerError(
      "ARCANE_AI_PROVIDER_UNAVAILABLE",
      "Browser fetch is unavailable in the speech Worker.",
      undefined,
      "artifact-graph-fetch-constructor-unavailable",
    );
  }
  if (GRAPH_GUARD_NAME in scope) {
    throw workerError(
      "ARCANE_AI_ARTIFACT_GRAPH_ISOLATION_UNAVAILABLE",
      "The authenticated artifact graph guard global already exists.",
      undefined,
      "artifact-graph-guard-global-collision",
    );
  }
  const reader = createRouteReader(scope, configuration, originalFetch);
  const graphGuard = createArtifactGraphGuard(
    scope,
    configuration,
    role,
    reader,
    originalWorker,
  );
  const restores = [];
  try {
    if (strictSecurity) {
      restores.push(installDynamicCodeConstructorIsolation());
      restores.push(installStringTimerIsolation(scope, "setInterval"));
      restores.push(installStringTimerIsolation(scope, "setTimeout"));
      if ("indexedDB" in scope) {
        restores.push(installScopeValue(
          scope,
          "indexedDB",
          undefined,
          "artifact-graph-indexeddb-isolation-unavailable",
        ));
      }
      if (scope.navigator && "storage" in scope.navigator) {
        restores.push(installObjectValue(
          scope.navigator,
          "storage",
          undefined,
          "WorkerNavigator.storage",
          "artifact-graph-opfs-isolation-unavailable",
        ));
      }
    }
    restores.push(installScopeValue(
      scope,
      GRAPH_GUARD_NAME,
      graphGuard.guard,
      "artifact-graph-guard-global-definition-rejected",
    ));
    if (strictSecurity) {
      restores.push(installScopeValue(
        scope,
        "fetch",
        async function rejectUntransformedArtifactGraphFetch() {
          throw workerError(
            "ARCANE_AI_ARTIFACT_GRAPH_FETCH_EDGE_UNDECLARED",
            "Artifact graph fetch must use its declared transformed edge.",
            undefined,
            "artifact-graph-fetch-guard-bypassed",
          );
        },
        "artifact-graph-fetch-isolation-unavailable",
      ));
      const cacheStorage = Object.freeze({
        async open() {
          throw workerError(
            "ARCANE_AI_ARTIFACT_GRAPH_CACHE_EDGE_UNDECLARED",
            "Artifact graph CacheStorage.open must use its declared transformed edge.",
            undefined,
            "artifact-graph-cache-open-guard-bypassed",
          );
        },
        async match() {
          throw workerError(
            "ARCANE_AI_ARTIFACT_GRAPH_CACHE_EDGE_UNDECLARED",
            "Artifact graph CacheStorage.match requires a declared cache-open edge.",
            undefined,
            "artifact-graph-cache-match-guard-bypassed",
          );
        },
        async has() {
          return true;
        },
        async keys() {
          return Object.freeze([]);
        },
        async delete() {
          return false;
        },
      });
      restores.push(installScopeValue(
        scope,
        "caches",
        cacheStorage,
        "artifact-graph-cache-isolation-unavailable",
      ));

      const deniedCapabilities = [
        "BroadcastChannel",
        "EventSource",
        "Function",
        "RTCPeerConnection",
        "ShadowRealm",
        "SharedWorker",
        "WebSocket",
        "WebSocketStream",
        "WebTransport",
        "Worker",
        "XMLHttpRequest",
        "eval",
        "importScripts",
      ];
      for (const name of deniedCapabilities) {
        if (!(name in scope)) continue;
        restores.push(installScopeValue(
          scope,
          name,
          function rejectUndeclaredArtifactGraphCapability() {
            throw workerError(
              "ARCANE_AI_ARTIFACT_GRAPH_ISOLATION_UNAVAILABLE",
              `The authenticated artifact graph denied raw ${name} access.`,
              undefined,
              `artifact-graph-${name.toLowerCase()}-capability-undeclared`,
            );
          },
          `artifact-graph-${name.toLowerCase()}-isolation-unavailable`,
        ));
      }
    }
  } catch (error) {
    restoreScopeValues(restores);
    graphGuard.cleanup();
    throw error;
  }
  return Object.freeze({
    cache: graphGuard.transformersCache,
    cleanup() {
      graphGuard.cleanup();
      restoreScopeValues(restores);
    },
  });
}

function assignSetting(object, name, value, cleanup, {
  allowCreate = false,
  assignmentRejectedReason,
  unavailableReason,
} = {}) {
  if (!object) {
    throw workerError(
      "ARCANE_AI_PROVIDER_UNAVAILABLE",
      `The selected runtime does not expose the verified ${name} setting.`,
      undefined,
      unavailableReason,
    );
  }
  let hadOwn;
  let previous;
  let canRestore = false;
  try {
    if (!allowCreate && !(name in object)) {
      throw workerError(
        "ARCANE_AI_PROVIDER_UNAVAILABLE",
        `The selected runtime does not expose the verified ${name} setting.`,
        undefined,
        unavailableReason,
      );
    }
    hadOwn = Object.hasOwn(object, name);
    previous = object[name];
    canRestore = true;
    object[name] = value;
    if (object[name] !== value) {
      throw new TypeError(`The ${name} assignment was not retained.`);
    }
  } catch (error) {
    if (isSdkWorkerError(error)) throw error;
    if (canRestore) {
      try {
        if (hadOwn) object[name] = previous;
        else delete object[name];
      } catch {
        // Preserve the exact configuration failure as the public boundary.
      }
    }
    throw workerError(
      "ARCANE_AI_PROVIDER_UNAVAILABLE",
      `The selected runtime rejected the verified ${name} setting.`,
      error,
      assignmentRejectedReason,
    );
  }
  cleanup.push(() => {
    if (hadOwn) object[name] = previous;
    else delete object[name];
  });
}

function configuredWasmPaths(configuration) {
  if (configuration.runtime.wasmPaths !== undefined) {
    if (configuration.security?.secure === true) {
      throw workerError(
        "ARCANE_AI_INVALID_REQUEST",
        "Secure browser speech cannot use remote wasmPaths.",
        undefined,
        "speech-worker-secure-remote-wasm-paths-rejected",
      );
    }
    return configuration.runtime.wasmPaths;
  }
  const byPath = new Map(configuration.runtime.files.map((file) => [file.path, file]));
  const declared = configuration.runtime.onnxWasm;
  let mjs = declared ? byPath.get(declared.mjsPath) : null;
  let wasm = declared ? byPath.get(declared.wasmPath) : null;
  if (!declared) {
    mjs = configuration.runtime.files.find((file) =>
      file.path !== configuration.runtime.entry && /\.mjs$/iu.test(file.path));
    wasm = configuration.runtime.files.find((file) => /\.wasm$/iu.test(file.path));
  }
  if (!mjs && !wasm) return null;
  if (!mjs?.moduleUrl || !wasm?.moduleUrl) {
    throw workerError(
      "ARCANE_AI_PROVIDER_UNAVAILABLE",
      "The selected runtime did not materialize its complete ONNX MJS/WASM pair.",
      undefined,
      "artifact-graph-onnx-wasm-pair-not-materialized",
    );
  }
  return Object.freeze({ mjs: mjs.moduleUrl, wasm: wasm.moduleUrl });
}

function configureRuntimeNamespace(namespace, configuration, role, cache) {
  const cleanup = [];
  const strictSecurity = configuration.security?.secure === true;
  const restoreSettings = () => {
    for (const restore of cleanup.splice(0).reverse()) {
      try {
        restore();
      } catch {
        // Worker isolation is still released by terminating the owning Worker.
      }
    }
  };
  const paths = configuredWasmPaths(configuration);
  if (role === "tts") {
    const env = namespace?.env;
    if (!env || !("wasmPaths" in env)) {
      throw workerError(
        "ARCANE_AI_PROVIDER_UNAVAILABLE",
        "Kokoro does not expose the verified env.wasmPaths configuration field.",
        undefined,
        "kokoro-env-wasm-paths-unavailable",
      );
    }
    try {
      if (paths) {
        assignSetting(
          env,
          "wasmPaths",
          paths,
          cleanup,
          {
            assignmentRejectedReason: "kokoro-env-wasm-paths-assignment-rejected",
            unavailableReason: "kokoro-env-wasm-paths-unavailable",
          },
        );
      }
    } catch (error) {
      restoreSettings();
      throw error;
    }
    return restoreSettings;
  }

  const env = namespace?.env;
  const wasm = env?.backends?.onnx?.wasm;
  if (!env || !wasm) {
    throw workerError(
      "ARCANE_AI_PROVIDER_UNAVAILABLE",
      "Transformers does not expose env.backends.onnx.wasm.",
      undefined,
      "transformers-env-backends-onnx-wasm-unavailable",
    );
  }
  try {
    assignSetting(env, "allowLocalModels", false, cleanup, {
      assignmentRejectedReason: "transformers-env-allow-local-models-assignment-rejected",
      unavailableReason: "transformers-env-allow-local-models-unavailable",
    });
    assignSetting(env, "allowRemoteModels", true, cleanup, {
      assignmentRejectedReason: "transformers-env-allow-remote-models-assignment-rejected",
      unavailableReason: "transformers-env-allow-remote-models-unavailable",
    });
    if (strictSecurity) {
      assignSetting(env, "useBrowserCache", false, cleanup, {
        assignmentRejectedReason: "transformers-env-browser-cache-assignment-rejected",
        unavailableReason: "transformers-env-browser-cache-unavailable",
      });
      assignSetting(env, "useFSCache", false, cleanup, {
        assignmentRejectedReason: "transformers-env-fs-cache-assignment-rejected",
        unavailableReason: "transformers-env-fs-cache-unavailable",
      });
      assignSetting(env, "useCustomCache", cache !== null, cleanup, {
        assignmentRejectedReason: "transformers-env-custom-cache-toggle-assignment-rejected",
        unavailableReason: "transformers-env-custom-cache-toggle-unavailable",
      });
      assignSetting(env, "customCache", cache, cleanup, {
        assignmentRejectedReason: "transformers-env-custom-cache-assignment-rejected",
        unavailableReason: "transformers-env-custom-cache-unavailable",
      });
    }
    if (paths) {
      assignSetting(
        wasm,
        "wasmPaths",
        paths,
        cleanup,
        {
          allowCreate: true,
          assignmentRejectedReason: "transformers-env-wasm-paths-assignment-rejected",
          unavailableReason: "transformers-env-wasm-paths-unavailable",
        },
      );
    }
    if (configuration.runtime.onnxWasm?.numThreads !== undefined) {
      assignSetting(
        wasm,
        "numThreads",
        configuration.runtime.onnxWasm.numThreads,
        cleanup,
        {
          allowCreate: true,
          assignmentRejectedReason: "transformers-env-num-threads-assignment-rejected",
          unavailableReason: "transformers-env-num-threads-unavailable",
        },
      );
    }
  } catch (error) {
    restoreSettings();
    throw error;
  }
  return restoreSettings;
}

function workerProgress(send, role, requestId, phase, completed = 0, total = null, unit = "items") {
  send({
    protocol: SPEECH_WORKER_PROTOCOL,
    event: "progress",
    requestId,
    progress: Object.freeze({
      phase,
      completed,
      total,
      unit,
      heartbeat: true,
    }),
  }, []);
}

function upstreamProgress(send, role, requestId) {
  return function reportSpeechModelProgress(update = {}) {
    const completed = Number.isFinite(update.loaded)
      ? update.loaded
      : Number.isFinite(update.progress) ? update.progress : 0;
    const total = Number.isFinite(update.total) ? update.total : null;
    workerProgress(
      send,
      role,
      requestId,
      `${role}-model-load-progress`,
      completed,
      total,
      Number.isFinite(update.loaded) ? "bytes" : "items",
    );
  };
}

async function disposeEngine(engine) {
  if (!engine) return;
  if (typeof engine.dispose === "function") {
    await engine.dispose();
    return;
  }
  const disposed = new Set();
  for (const part of [engine.model, engine.tokenizer, engine.processor]) {
    if (!part || disposed.has(part) || typeof part.dispose !== "function") continue;
    disposed.add(part);
    await part.dispose();
  }
}

async function createWhisperEngine(namespace, configuration, signal, report) {
  if (typeof namespace?.pipeline !== "function") {
    throw workerError(
      "ARCANE_AI_PROVIDER_UNAVAILABLE",
      "The Whisper runtime does not export pipeline().",
      undefined,
      "transformers-whisper-pipeline-export-missing",
    );
  }
  throwIfAborted(signal, "stt-load-cancelled");
  const transcriber = await namespace.pipeline(
    "automatic-speech-recognition",
    configuration.model.repository,
    {
      device: "wasm",
      dtype: configuration.model.dtype ?? "fp32",
      revision: configuration.model.revision,
      progress_callback: report,
    },
  );
  try {
    throwIfAborted(signal, "stt-load-cancelled");
  } catch (error) {
    try {
      await disposeEngine(transcriber);
    } catch {
      // Preserve the cancellation boundary while the owning Worker terminates.
    }
    throw error;
  }
  return Object.freeze({
    async transcribe(input, { signal: requestSignal } = {}) {
      throwIfAborted(requestSignal, "stt-transcription-cancelled");
      const output = await transcriber(input.audio, { signal: requestSignal });
      throwIfAborted(requestSignal, "stt-transcription-cancelled");
      return Object.freeze({ text: String(output?.text ?? "").trim() });
    },
    dispose: () => disposeEngine(transcriber),
  });
}

async function createKokoroEngine(namespace, configuration, signal, report) {
  if (typeof namespace?.KokoroTTS?.from_pretrained !== "function") {
    throw workerError(
      "ARCANE_AI_PROVIDER_UNAVAILABLE",
      "The Kokoro runtime does not export KokoroTTS.",
      undefined,
      "kokoro-tts-constructor-export-missing",
    );
  }
  throwIfAborted(signal, "tts-load-cancelled");
  const synthesizer = await namespace.KokoroTTS.from_pretrained(
    configuration.model.repository,
    {
      device: "wasm",
      dtype: configuration.model.dtype ?? "q8",
      revision: configuration.model.revision,
      progress_callback: report,
    },
  );
  try {
    throwIfAborted(signal, "tts-load-cancelled");
  } catch (error) {
    try {
      await disposeEngine(synthesizer);
    } catch {
      // Preserve the cancellation boundary while the owning Worker terminates.
    }
    throw error;
  }
  return Object.freeze({
    async synthesize(input, { signal: requestSignal } = {}) {
      throwIfAborted(requestSignal, "tts-synthesis-cancelled");
      const output = await synthesizer.generate(input.text, {
        voice: input.voice,
        speed: input.speed,
        signal: requestSignal,
      });
      throwIfAborted(requestSignal, "tts-synthesis-cancelled");
      const audio = output?.audio instanceof Float32Array
        ? output.audio
        : new Float32Array(output?.audio ?? []);
      return Object.freeze({
        audio,
        sampleRate: output?.sampling_rate,
        voice: input.voice,
      });
    },
    dispose: () => disposeEngine(synthesizer),
  });
}

function callerVoiceIds(configuration) {
  return new Set((configuration.model.voices ?? []).map((voice) =>
    typeof voice === "string" ? voice : voice?.id));
}

function validateInput(role, payload, configuration) {
  if (role === "stt") {
    const inputSampleRate = requiredSampleRate(
      configuration.model.inputSampleRate,
      "Whisper inputSampleRate",
      16_000,
    );
    if (!(payload?.audio instanceof Float32Array)) {
      throw workerError(
        "ARCANE_AI_INVALID_REQUEST",
        "Whisper requires Float32Array audio.",
        undefined,
        "stt-transcription-audio-not-float32array",
      );
    }
    if (payload.sampleRate !== inputSampleRate) {
      throw workerError(
        "ARCANE_AI_INVALID_REQUEST",
        `Whisper requires audio sampled at exactly ${String(inputSampleRate)} Hz.`,
        undefined,
        "stt-transcription-sample-rate-mismatch",
      );
    }
    return Object.freeze({ audio: payload.audio, sampleRate: inputSampleRate });
  }
  const text = requiredText(payload?.text, "Kokoro text", "tts-synthesis-text-empty");
  const voice = requiredText(
    payload?.voice ?? configuration.model.defaultVoice,
    "Kokoro voice",
    "tts-synthesis-voice-empty",
  );
  const voices = callerVoiceIds(configuration);
  if (voices.size > 0 && !voices.has(voice)) {
    throw workerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Kokoro voice is outside the caller-owned voice inventory.",
      undefined,
      "tts-synthesis-voice-not-declared",
    );
  }
  const speed = payload?.speed ?? 1;
  if (!Number.isFinite(speed) || speed <= 0 || speed > 4) {
    throw workerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Kokoro speed must be greater than 0 and at most 4.",
      undefined,
      "tts-synthesis-speed-out-of-range",
    );
  }
  return Object.freeze({ text, voice, speed });
}

function validateResult(role, result, configuration) {
  if (role === "stt") {
    if (!result || typeof result.text !== "string") {
      throw workerError(
        "ARCANE_AI_INVALID_PROVIDER_RESULT",
        "Whisper did not return text.",
        undefined,
        "stt-transcription-result-text-not-string",
      );
    }
    return Object.freeze({ text: result.text.trim() });
  }
  const outputSampleRate = requiredSampleRate(
    configuration.model.outputSampleRate,
    "Kokoro outputSampleRate",
    24_000,
  );
  if (!(result?.audio instanceof Float32Array)) {
    throw workerError(
      "ARCANE_AI_INVALID_PROVIDER_RESULT",
      "Kokoro must return Float32 PCM.",
      undefined,
      "tts-synthesis-pcm-result-not-float32array",
    );
  }
  if (result.sampleRate !== outputSampleRate) {
    throw workerError(
      "ARCANE_AI_INVALID_PROVIDER_RESULT",
      `Kokoro must return ${String(outputSampleRate)} Hz PCM.`,
      undefined,
      "tts-synthesis-result-sample-rate-mismatch",
    );
  }
  for (const sample of result.audio) {
    if (!Number.isFinite(sample)) {
      throw workerError(
        "ARCANE_AI_INVALID_PROVIDER_RESULT",
        "Kokoro returned non-finite PCM.",
        undefined,
        "tts-synthesis-pcm-sample-non-finite",
      );
    }
  }
  return Object.freeze({
    audio: result.audio,
    sampleRate: outputSampleRate,
    voice: result.voice,
  });
}

export function createSpeechWorkerRuntime({ role, scope = globalThis, send } = {}) {
  if (role !== "stt" && role !== "tts") {
    throw new TypeError('Speech worker role must be "stt" or "tts".');
  }
  if (typeof send !== "function") {
    throw new TypeError("Speech worker send() is required.");
  }
  let configuration = null;
  let engine = null;
  let environment = null;
  let restoreNamespace = null;
  let disposed = false;
  let tail = Promise.resolve();
  let lifecycleReason = `${role}-worker-created`;
  const operations = new Map();

  function status() {
    const state = disposed ? "disposed" : engine ? "ready" : "unloaded";
    const security = configuration?.security
      ? Object.freeze({
        secure: configuration.security.secure === true,
        checks: Object.freeze({
          byteLength: configuration.security.checks?.byteLength === true,
          sha256: configuration.security.checks?.sha256 === true,
        }),
      })
      : null;
    return Object.freeze({
      state,
      lifecycleStatus: `${role}-worker-${state}`,
      lifecycleReason,
      role,
      loaded: engine !== null,
      busy: operations.size > 0,
      activeOperation: operations.values().next().value?.publicOperation ?? null,
      security,
      artifactGraphId: configuration?.runtime?.artifactGraphId ?? null,
      artifactGraphAdmission: configuration?.runtime?.artifactGraphAdmission ?? null,
    });
  }

  async function load(request, signal) {
    if (disposed) {
      throw workerError(
        "ARCANE_AI_PROVIDER_DISPOSED",
        "The speech worker is disposed.",
        undefined,
        `${role}-load-rejected-after-dispose`,
      );
    }
    if (engine) return status();
    lifecycleReason = `${role}-load-started`;
    let loadFailureReason = `${role}-worker-runtime-configuration-rejected`;
    try {
      configuration = validateConfiguration(request.payload?.configuration, role);
      const entry = configuration.runtime.files.find((file) =>
        file.path === configuration.runtime.entry);
      if (graphConfiguration(configuration) && configuration.security?.secure === true) {
        environment = installArtifactGraphEnvironment(scope, configuration, role);
      } else if (configuration.security?.secure === true) {
        const legacyFetch = installLegacyAuthorizedFetch(scope, configuration);
        try {
          const restoreCaches = installDeniedCacheIsolation(scope);
          environment = Object.freeze({
            cache: null,
            cleanup() {
              try {
                restoreCaches();
              } finally {
                legacyFetch.cleanup();
              }
            },
          });
        } catch (error) {
          legacyFetch.cleanup();
          throw error;
        }
      } else {
        environment = Object.freeze({
          cache: null,
          cleanup() {},
        });
      }
      workerProgress(send, role, request.id, `${role}-runtime-import-started`);
      loadFailureReason = `${role}-worker-runtime-import-rejected`;
      const namespace = await import(entry.moduleUrl);
      throwIfAborted(signal, `${role}-load-cancelled`);
      restoreNamespace = configureRuntimeNamespace(
        namespace,
        configuration,
        role,
        environment.cache,
      );
      workerProgress(send, role, request.id, `${role}-model-load-started`);
      loadFailureReason = `${role}-worker-model-load-rejected`;
      const report = upstreamProgress(send, role, request.id);
      engine = role === "stt"
        ? await createWhisperEngine(namespace, configuration, signal, report)
        : await createKokoroEngine(namespace, configuration, signal, report);
      lifecycleReason = `${role}-load-completed`;
      workerProgress(send, role, request.id, `${role}-provider-ready`, 1, 1);
      return status();
    } catch (error) {
      const failure = admitWorkerFailure(
        error,
        "ARCANE_AI_PROVIDER_REQUEST_FAILED",
        "The speech Worker load operation was rejected.",
        loadFailureReason,
      );
      const rejectedEngine = engine;
      engine = null;
      try {
        await disposeEngine(rejectedEngine);
      } catch {
        // Preserve the load boundary error that caused teardown.
      }
      restoreNamespace?.();
      restoreNamespace = null;
      try {
        environment?.cleanup();
      } catch {
        // A rejected load is followed by provider-owned Worker termination.
      }
      environment = null;
      configuration = null;
      lifecycleReason = failure.reason;
      throw failure;
    }
  }

  async function use(request, signal) {
    if (!engine || !configuration) {
      throw workerError(
        "ARCANE_AI_NOT_READY",
        "The speech worker is not loaded.",
        undefined,
        role === "stt"
          ? "stt-transcription-rejected-before-load"
          : "tts-synthesis-rejected-before-load",
      );
    }
    const input = validateInput(role, request.payload, configuration);
    const method = role === "stt" ? engine.transcribe : engine.synthesize;
    if (typeof method !== "function") {
      throw workerError(
        "ARCANE_AI_PROVIDER_UNAVAILABLE",
        "The speech engine operation is unavailable.",
        undefined,
        role === "stt"
          ? "stt-transcription-method-unavailable"
          : "tts-synthesis-method-unavailable",
      );
    }
    lifecycleReason = role === "stt"
      ? "stt-transcription-started"
      : "tts-synthesis-started";
    try {
      const result = validateResult(
        role,
        await method(input, { signal }),
        configuration,
      );
      lifecycleReason = role === "stt"
        ? "stt-transcription-completed"
        : "tts-synthesis-completed";
      return result;
    } catch (error) {
      const failure = admitWorkerFailure(
        error,
        "ARCANE_AI_PROVIDER_REQUEST_FAILED",
        "The speech engine operation was rejected.",
        role === "stt"
          ? "stt-transcription-engine-operation-rejected"
          : "tts-synthesis-engine-operation-rejected",
      );
      lifecycleReason = failure.reason;
      throw failure;
    }
  }

  async function unload(reason = `${role}-unload-completed`) {
    for (const operation of operations.values()) {
      if (operation.op === "unload" || operation.op === "dispose") continue;
      operation.controller.abort(operationReason(role, operation.op, "superseded-by-unload"));
    }
    const current = engine;
    engine = null;
    let disposeFailure = null;
    try {
      await disposeEngine(current);
    } catch (error) {
      const failure = admitWorkerFailure(
        error,
        "ARCANE_AI_PROVIDER_REQUEST_FAILED",
        "The speech engine dispose operation was rejected.",
        `${role}-worker-engine-dispose-rejected`,
      );
      disposeFailure = failure;
      lifecycleReason = failure.reason;
      throw failure;
    } finally {
      restoreNamespace?.();
      restoreNamespace = null;
      try {
        environment?.cleanup();
      } catch {
        // Worker termination remains the final cleanup boundary.
      }
      environment = null;
      configuration = null;
      if (!disposeFailure) lifecycleReason = reason;
    }
    return status();
  }

  async function dispatch(request, signal, op) {
    if (op === "load") return load(request, signal);
    if (op === "use") return use(request, signal);
    if (op === "status") return status();
    if (op === "unload") return unload(`${role}-unload-completed`);
    if (op === "dispose") {
      await unload(`${role}-dispose-unloaded-worker`);
      disposed = true;
      lifecycleReason = `${role}-dispose-completed`;
      return status();
    }
    throw workerError(
      "ARCANE_AI_INVALID_REQUEST",
      "The speech worker operation is not part of its protocol.",
      undefined,
      `${role}-worker-operation-unknown`,
    );
  }

  function respond(request, operation, op) {
    operation.then((result) => send({
      protocol: SPEECH_WORKER_PROTOCOL,
      id: request.id,
      ok: true,
      result: result ?? null,
    }, collectSpeechTransferables(result)), (error) => send({
      protocol: SPEECH_WORKER_PROTOCOL,
      id: request.id,
      ok: false,
      error: serializedError(error, role, op),
    }, []));
  }

  function handleMessage(request) {
    if (request?.protocol !== SPEECH_WORKER_PROTOCOL
      || !Number.isSafeInteger(request.id)
      || request.id < 1) {
      return Promise.reject(workerError(
        "ARCANE_AI_INVALID_REQUEST",
        "The speech worker envelope shape was rejected.",
        undefined,
        `${role}-worker-message-envelope-shape-rejected`,
      ));
    }
    const op = request.op;
    if (!TRANSPORT_WORKER_OPERATION_SET.has(op)) {
      return Promise.reject(workerError(
        "ARCANE_AI_INVALID_REQUEST",
        "The speech worker operation is not part of its protocol.",
        undefined,
        `${role}-worker-operation-unknown`,
      ));
    }
    if (op === "cancel") {
      const target = operations.get(request.payload?.targetId);
      target?.controller.abort(operationReason(role, target.op, "cancelled"));
      const result = Promise.resolve(Object.freeze({
        cancelled: Boolean(target),
        reason: target
          ? operationReason(role, target.op, "cancelled")
          : `${role}-cancel-target-not-active`,
      }));
      respond(request, result, op);
      return result;
    }
    const controller = new AbortController();
    const publicOperation = op === "use"
      ? role === "stt" ? "stt-transcription" : "tts-synthesis"
      : `${role}-${op}`;
    const record = { controller, op, publicOperation };
    const execute = tail.catch(() => undefined).then(() => {
      throwIfAborted(controller.signal, operationReason(role, op, "cancelled"));
      return dispatch(request, controller.signal, op);
    });
    operations.set(request.id, record);
    const operation = execute.finally(() => operations.delete(request.id));
    tail = operation.catch(() => undefined);
    respond(request, operation, op);
    return operation;
  }

  return Object.freeze({ handleMessage, status });
}

function privatePort(value) {
  return value
    && typeof value.postMessage === "function"
    && typeof value.addEventListener === "function"
    ? value
    : null;
}

export function installBrowserSpeechWorker(role, scope = globalThis) {
  let transport = scope;
  let transportMode = null;
  const runtime = createSpeechWorkerRuntime({
    role,
    scope,
    send: (message, transfers) => transport.postMessage(message, transfers),
  });

  function receive(request) {
    void runtime.handleMessage(request).catch(() => undefined);
  }

  scope.addEventListener("message", (event) => {
    if (transportMode === "private-message-port") return;
    const requestedPort = privatePort(event.data?.privatePort);
    const isGraphLoad = event.data?.op === "load"
      && graphConfiguration(event.data?.payload?.configuration);
    if (requestedPort) {
      if (!isGraphLoad || transportMode !== null) return;
      transportMode = "private-message-port";
      transport = requestedPort;
      requestedPort.addEventListener("message", (portEvent) => receive(portEvent.data));
      requestedPort.start?.();
      const { privatePort: ignored, ...request } = event.data;
      void ignored;
      receive(request);
      return;
    }
    if (isGraphLoad) {
      scope.postMessage({
        protocol: SPEECH_WORKER_PROTOCOL,
        id: event.data.id,
        ok: false,
        error: serializedError(workerError(
          "ARCANE_AI_ARTIFACT_GRAPH_ISOLATION_UNAVAILABLE",
          "Authenticated artifact graph loading requires a private MessagePort.",
          undefined,
          "artifact-graph-private-message-port-missing",
        ), role, "load"),
      });
      return;
    }
    transportMode ??= "worker-global-message";
    receive(event.data);
  });
  return runtime;
}

function replayWorkerMessage(scope, event) {
  if (typeof scope.dispatchEvent === "function") {
    scope.dispatchEvent(event);
    return;
  }
  scope.onmessage?.(event);
}

export function installBrowserSpeechArtifactModuleWorker(role, scope = globalThis) {
  if (role !== "stt" && role !== "tts") {
    throw new TypeError('Speech artifact module Worker role must be "stt" or "tts".');
  }
  let initializing = false;
  const queued = [];
  const bootstrap = (event) => {
    if (initializing) {
      queued.push(event);
      return;
    }
    const request = event.data;
    if (request?.protocol !== NESTED_WORKER_PROTOCOL
      || request.op !== "initialize-authenticated-artifact-module-worker"
      || request.role !== role) return;
    initializing = true;
    void (async () => {
      let environment = null;
      try {
        const configuration = validateConfiguration(request.configuration, role);
        const target = configuration.runtime.files.find((file) =>
          file.path === request.targetPath);
        if (!target?.moduleUrl) {
          throw workerError(
            "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
            "The nested module Worker target was not materialized.",
            undefined,
            "artifact-graph-module-worker-target-not-materialized",
          );
        }
        environment = installArtifactGraphEnvironment(scope, configuration, role);
        await import(target.moduleUrl);
        scope.removeEventListener("message", bootstrap);
        await new Promise((resolve) => queueMicrotask(resolve));
        for (const queuedEvent of queued.splice(0)) replayWorkerMessage(scope, queuedEvent);
      } catch (error) {
        try {
          environment?.cleanup();
        } catch {
          // Preserve the exact nested Worker bootstrap failure.
        }
        scope.postMessage({
          protocol: NESTED_WORKER_PROTOCOL,
          event: "artifact-module-worker-bootstrap-rejected",
          error: serializedError(error, role, "load"),
        });
        scope.close?.();
      }
    })();
  };
  scope.addEventListener("message", bootstrap);
  return Object.freeze({
    protocol: NESTED_WORKER_PROTOCOL,
    role,
    lifecycleStatus: `${role}-artifact-module-worker-awaiting-initialization`,
  });
}

export const SPEECH_WORKER_PROTOCOL = "arcane-ai-speech-worker/1";

const completeValue = (value) => value;

const SPEECH_WORKER_ERROR_PROTOCOL = "arcane-ai-speech-worker-error/1";

const ARTIFACT_GRAPH_MODULE_GRAPH =
  "browser-speech-authenticated-artifact-graph";
const MODULE_ROUTER_NAME = "__arcaneBrowserSpeechModuleRouterV1";
const NESTED_WORKER_PROTOCOL =
  "arcane-ai-browser-speech-artifact-module-worker/1";
const ADAPTERS = completeValue({
  stt: "transformers-whisper",
  tts: "kokoro-js",
});
const ONNX_NAMESPACES = completeValue({
  stt: "transformers-env-backends-onnx-wasm",
  tts: "kokoro-env-wasm-paths",
});
const PUBLIC_WORKER_OPERATIONS = completeValue([
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
const BOTH_WORKER_ROLES = completeValue(["stt", "tts"]);
const LOAD_OPERATION = completeValue(["load"]);
const USE_OPERATION = completeValue(["use"]);
const STATUS_OPERATION = completeValue(["status"]);
const UNLOAD_OPERATION = completeValue(["unload"]);
const DISPOSE_OPERATION = completeValue(["dispose"]);
const UNLOAD_OR_DISPOSE_OPERATIONS = completeValue(["unload", "dispose"]);
const SDK_WORKER_ERRORS = new WeakSet();
const WORKER_ERROR_MESSAGES = completeValue({
  ARCANE_AI_REQUEST_ABORTED: "The speech worker operation was cancelled.",
  ARCANE_AI_NOT_READY: "The speech worker is not loaded.",
  ARCANE_AI_INVALID_REQUEST: "The speech worker request was rejected.",
  ARCANE_AI_INVALID_PROVIDER_RESULT: "The speech engine result was rejected.",
  ARCANE_AI_PROVIDER_UNAVAILABLE: "The selected speech engine is unavailable.",
  ARCANE_AI_PROVIDER_DISPOSED: "The speech worker is disposed.",
  ARCANE_AI_PROVIDER_REQUEST_FAILED: "The speech engine operation was rejected.",
  ARCANE_AI_WORKER_CRASHED: "The speech Worker stopped unexpectedly.",
  ARCANE_AI_WORKER_MESSAGE_ERROR: "The speech Worker message was rejected.",
  ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID:
    "The authenticated artifact graph Worker configuration was rejected.",
});
const WORKER_ERROR_REASON_ADMISSIONS = new Map();

function registerWorkerErrorReasons(code, roles, operations, reasons) {
  const admission = completeValue({
    code,
    roles: completeValue([...roles]),
    operations: completeValue([...operations]),
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
  "tts-synthesis-speed-not-positive",
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
  "artifact-graph-onnx-wasm-pair-not-materialized",
  "speech-worker-fetch-unavailable",
]);
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
  "artifact-graph-onnx-wasm-configuration-mismatch",
  ],
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
  try {
    return value instanceof Error && SDK_WORKER_ERRORS.has(value);
  } catch {
    return false;
  }
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
  const sdkError = isSdkWorkerError(error);
  let reportedCode;
  let reportedMessage;
  let reportedReason;
  let reportedCause;
  try { reportedCode = Reflect.get(error, "code"); } catch {}
  try { reportedMessage = Reflect.get(error, "message"); } catch {}
  try { reportedReason = Reflect.get(error, "reason"); } catch {}
  if (sdkError) {
    try { reportedCause = Reflect.get(error, "cause"); } catch (cause) {
      reportedCause = cause;
    }
  } else {
    reportedCause = error;
  }
  const admission = sdkError
    ? workerErrorReasonAdmission(reportedReason, role, op)
    : null;
  const admittedCode = sdkError
    && Object.hasOwn(WORKER_ERROR_MESSAGES, reportedCode)
    && admission?.code === reportedCode;
  const code = admittedCode ? reportedCode : "ARCANE_AI_PROVIDER_REQUEST_FAILED";
  const reason = admittedCode ? reportedReason : operationFailureReason(role, op);
  const message = typeof reportedMessage === "string" && reportedMessage.length > 0
    ? reportedMessage
    : WORKER_ERROR_MESSAGES[code];
  const envelope = completeValue({
    protocol: SPEECH_WORKER_ERROR_PROTOCOL,
    code,
    message,
    reason,
  });
  if (reportedCause !== undefined) {
    envelope.cause = serializedDiagnosticValue(reportedCause);
  }
  return envelope;
}

function fallbackSerializedError(error, role, op) {
  let message;
  try { message = Reflect.get(error, "message"); } catch {}
  return completeValue({
    protocol: SPEECH_WORKER_ERROR_PROTOCOL,
    code: "ARCANE_AI_PROVIDER_REQUEST_FAILED",
    message: typeof message === "string" && message.length > 0
      ? message
      : WORKER_ERROR_MESSAGES.ARCANE_AI_PROVIDER_REQUEST_FAILED,
    reason: operationFailureReason(role, op),
  });
}

function sendSerializedError(send, response, error, role, op, consoleScope) {
  try {
    response.error = serializedError(error, role, op);
    send(response, []);
  } catch (transportError) {
    try {
      consoleScope?.console?.error?.(
        "The speech Worker could not transport its complete failure diagnostic.",
        error,
        transportError,
      );
    } catch {}
    response.error = fallbackSerializedError(error, role, op);
    send(response, []);
  }
}

function diagnosticText(value, fallback) {
  try {
    return String(value);
  } catch {
    return fallback;
  }
}

function defineDiagnosticProperty(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function diagnosticType(value) {
  try {
    return Object.prototype.toString.call(value).slice(8, -1);
  } catch {
    return "UninspectableObject";
  }
}

function serializedDiagnosticValue(value, seen = new WeakMap()) {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type !== "object" && type !== "function") {
    return type === "symbol"
      ? diagnosticText(value, "[symbol could not be represented]")
      : value;
  }
  if (seen.has(value)) return seen.get(value);

  const result = Object.create(null);
  seen.set(value, result);
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    defineDiagnosticProperty(
      result,
      "inspectionError",
      serializedDiagnosticValue(error, seen),
    );
    return result;
  }

  const symbolProperties = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    const projected = Object.create(null);
    if (Object.hasOwn(descriptor, "value")) {
      defineDiagnosticProperty(
        projected,
        "value",
        serializedDiagnosticValue(descriptor.value, seen),
      );
    } else {
      defineDiagnosticProperty(projected, "kind", "accessor");
      if (descriptor.get !== undefined) {
        defineDiagnosticProperty(
          projected,
          "get",
          diagnosticText(descriptor.get, "[getter could not be represented]"),
        );
      }
      if (descriptor.set !== undefined) {
        defineDiagnosticProperty(
          projected,
          "set",
          diagnosticText(descriptor.set, "[setter could not be represented]"),
        );
      }
    }
    if (typeof key === "symbol") {
      const symbolProperty = Object.create(null);
      defineDiagnosticProperty(
        symbolProperty,
        "key",
        diagnosticText(key, "[symbol key could not be represented]"),
      );
      defineDiagnosticProperty(symbolProperty, "descriptor", projected);
      symbolProperties.push(symbolProperty);
      continue;
    }
    defineDiagnosticProperty(
      result,
      key,
      Object.hasOwn(projected, "value") ? projected.value : projected,
    );
  }

  for (const key of ["name", "message", "stack", "code", "reason", "details", "cause"]) {
    if (Object.hasOwn(result, key)) continue;
    try {
      const field = Reflect.get(value, key);
      if (field !== undefined) {
        defineDiagnosticProperty(
          result,
          key,
          serializedDiagnosticValue(field, seen),
        );
      }
    } catch (error) {
      defineDiagnosticProperty(result, key, serializedDiagnosticValue(error, seen));
    }
  }

  let metadataKey = "$diagnostic";
  while (Object.hasOwn(result, metadataKey)) metadataKey = `$${metadataKey}`;
  const metadata = Object.create(null);
  const valueType = diagnosticType(value);
  defineDiagnosticProperty(metadata, "type", valueType);
  if (symbolProperties.length > 0) {
    defineDiagnosticProperty(metadata, "symbolProperties", symbolProperties);
  }
  try {
    if (type === "function") {
      defineDiagnosticProperty(
        metadata,
        "source",
        diagnosticText(value, "[function could not be represented]"),
      );
    } else if (valueType === "Map") {
      const entries = [];
      for (const [key, entry] of value) {
        entries.push([
          serializedDiagnosticValue(key, seen),
          serializedDiagnosticValue(entry, seen),
        ]);
      }
      defineDiagnosticProperty(metadata, "entries", entries);
    } else if (valueType === "Set") {
      const entries = [];
      for (const entry of value) entries.push(serializedDiagnosticValue(entry, seen));
      defineDiagnosticProperty(metadata, "values", entries);
    } else if (valueType === "Date") {
      defineDiagnosticProperty(metadata, "value", Date.prototype.getTime.call(value));
    } else if (valueType === "RegExp") {
      defineDiagnosticProperty(metadata, "source", value.source);
      defineDiagnosticProperty(metadata, "flags", value.flags);
      defineDiagnosticProperty(metadata, "lastIndex", value.lastIndex);
    } else if (valueType === "ArrayBuffer" || valueType === "SharedArrayBuffer"
      || valueType === "Blob" || valueType === "File") {
      defineDiagnosticProperty(metadata, "value", value);
    } else {
      let view = false;
      try {
        view = ArrayBuffer.isView(value);
      } catch {}
      if (view) defineDiagnosticProperty(metadata, "value", value);
    }
  } catch (error) {
    defineDiagnosticProperty(
      metadata,
      "inspectionError",
      serializedDiagnosticValue(error, seen),
    );
  }
  defineDiagnosticProperty(result, metadataKey, metadata);
  return result;
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
      || ![
        "code,message,protocol,reason",
        "cause,code,message,protocol,reason",
      ].includes(keys.sort().join(","))) return null;
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
  if (typeof message !== "string" || message.length < 1) return null;
  const admission = workerErrorReasonAdmission(reason, role, op);
  if (admission?.code !== code) return null;
  if (descriptors.cause && !Object.hasOwn(descriptors.cause, "value")) return null;
  return completeValue({
    code,
    message,
    reason,
    ...(descriptors.cause ? { cause: descriptors.cause.value } : {}),
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

function requiredContent(
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
  return value;
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
    const wasm = configuration.runtime.onnxWasm;
    if (
      !wasm
      || wasm.namespace !== ONNX_NAMESPACES[role]
      || !runtimePaths.has(wasm.mjsPath)
      || !runtimePaths.has(wasm.wasmPath)
    ) {
        throw workerError(
          "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
          "The ONNX Runtime Web MJS/WASM pair is incomplete or uses the wrong namespace.",
        undefined,
        "artifact-graph-onnx-wasm-configuration-mismatch",
      );
    }
    if (role === "tts" && wasm.numThreads !== undefined) {
        throw workerError(
          "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID",
          "Kokoro does not expose a numThreads configuration field.",
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
  }
  return configuration;
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

function ordinaryRequestUrl(value, scope, base = scope.location?.href) {
  const input = typeof value === "string" || value instanceof URL
    ? String(value)
    : value?.url;
  if (typeof input !== "string" || input.length < 1) return null;
  try {
    return new URL(input, base).href;
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

function createOrdinaryRoutes(scope, configuration) {
  const files = [
    ...configuration.runtime.files,
    ...configuration.model.files,
  ];
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const routes = new Map();
  const ambiguous = new Set();

  function add(route, file) {
    const absolute = ordinaryRequestUrl(route, scope);
    if (!absolute || ambiguous.has(absolute)) return;
    const existing = routes.get(absolute);
    if (existing && existing.path !== file.path) {
      routes.delete(absolute);
      ambiguous.add(absolute);
      return;
    }
    routes.set(absolute, file);
  }

  for (const file of files) {
    add(file.sourceUrl, file);
    add(file.moduleUrl, file);
    for (const route of file.runtimeRequestUrls ?? []) add(route, file);
  }
  return completeValue({ files, filesByPath, routes });
}

function createOrdinaryRouteReader(
  scope,
  configuration,
  originalFetch,
  originalCaches,
) {
  const routeTable = createOrdinaryRoutes(scope, configuration);
  const nativeCaches = new Map();
  const RequestConstructor = scope.Request ?? globalThis.Request;

  function sourceBase(modulePath) {
    return routeTable.filesByPath.get(modulePath)?.sourceUrl ?? scope.location?.href;
  }

  function nativeInput(input, modulePath) {
    if (typeof input !== "string" && !(input instanceof URL)) return input;
    return ordinaryRequestUrl(input, scope, sourceBase(modulePath)) ?? input;
  }

  function resolve(input, modulePath) {
    const absolute = ordinaryRequestUrl(input, scope, sourceBase(modulePath));
    const file = absolute ? routeTable.routes.get(absolute) : null;
    return file ? completeValue({ absolute, file }) : null;
  }

  function responseFor(resolution, input, init) {
    const mappedInput = typeof RequestConstructor === "function"
      && input instanceof RequestConstructor
      ? new RequestConstructor(resolution.file.moduleUrl, input)
      : resolution.file.moduleUrl;
    return originalFetch(mappedInput, init);
  }

  async function nativeCache(name) {
    if (!originalCaches || typeof originalCaches.open !== "function") return null;
    if (!nativeCaches.has(name)) {
      nativeCaches.set(name, Promise.resolve(originalCaches.open.call(originalCaches, name)));
    }
    return nativeCaches.get(name);
  }

  function cacheForName(name, modulePath) {
    return completeValue({
      async match(input, options) {
        const resolution = resolve(input, modulePath);
        if (resolution) return responseFor(resolution, input);
        const cache = await nativeCache(name);
        return cache?.match(nativeInput(input, modulePath), options);
      },
      async put(input, response) {
        const cache = await nativeCache(name);
        if (!cache) throw new TypeError("Browser CacheStorage is unavailable.");
        return cache.put(nativeInput(input, modulePath), response);
      },
      async add(input) {
        const cache = await nativeCache(name);
        if (!cache) throw new TypeError("Browser CacheStorage is unavailable.");
        return cache.add(nativeInput(input, modulePath));
      },
      async addAll(inputs) {
        const cache = await nativeCache(name);
        if (!cache) throw new TypeError("Browser CacheStorage is unavailable.");
        return cache.addAll(Array.from(inputs, (input) => nativeInput(input, modulePath)));
      },
      async delete(input, options) {
        const cache = await nativeCache(name);
        return cache ? cache.delete(nativeInput(input, modulePath), options) : false;
      },
      async keys(input, options) {
        const cache = await nativeCache(name);
        if (!cache) return [];
        return input === undefined
          ? cache.keys()
          : cache.keys(nativeInput(input, modulePath), options);
      },
    });
  }

  return completeValue({ cacheForName, nativeInput, resolve, responseFor });
}

function createOrdinaryArtifactModuleRouter(
  scope,
  configuration,
  role,
  reader,
  originalFetch,
  originalWorker,
) {
  const nestedWorkers = new Set();
  const router = completeValue({
    async dynamicImport(modulePath, specifier) {
      const resolution = isBareModuleSpecifier(specifier)
        ? null
        : reader.resolve(specifier, modulePath);
      const target = resolution?.file.moduleUrl
        ?? (isBareModuleSpecifier(specifier)
          ? specifier
          : reader.nativeInput(specifier, modulePath));
      return import(target);
    },

    fetch(modulePath, input, init) {
      const resolution = reader.resolve(input, modulePath);
      return resolution
        ? reader.responseFor(resolution, input, init)
        : originalFetch(reader.nativeInput(input, modulePath), init);
    },

    openCache(modulePath, name) {
      return Promise.resolve(reader.cacheForName(name, modulePath));
    },

    createWorker(modulePath, specifier, options = {}) {
      if (typeof originalWorker !== "function") {
        throw workerError(
          "ARCANE_AI_PROVIDER_UNAVAILABLE",
          "Nested browser Workers are unavailable.",
          undefined,
          "speech-module-worker-constructor-unavailable",
        );
      }
      const resolution = reader.resolve(specifier, modulePath);
      if (!resolution) {
        return new originalWorker(reader.nativeInput(specifier, modulePath), options);
      }
      const workerOptions = options && typeof options === "object"
        ? { ...options, type: "module" }
        : { type: "module" };
      const worker = new originalWorker(nestedWorkerUrl(role), workerOptions);
      nestedWorkers.add(worker);
      const onBootstrapMessage = (event) => {
        if (event.data?.protocol !== NESTED_WORKER_PROTOCOL
          || event.data?.event !== "artifact-module-worker-bootstrap-rejected") return;
        event.stopImmediatePropagation?.();
        const admitted = normalizeSpeechWorkerErrorEnvelope(event.data.error, role, "load");
        const failure = admitted
          ? workerError(admitted.code, admitted.message, admitted.cause, admitted.reason)
          : workerError(
              "ARCANE_AI_WORKER_MESSAGE_ERROR",
              "The artifact module Worker error envelope was rejected.",
              undefined,
              "speech-module-worker-error-envelope-rejected",
            );
        worker.dispatchEvent?.(nestedWorkerFailureEvent(scope, failure));
      };
      worker.addEventListener?.("message", onBootstrapMessage);
      try {
        worker.postMessage({
          protocol: NESTED_WORKER_PROTOCOL,
          op: "initialize-artifact-module-worker",
          role,
          targetPath: resolution.file.path,
          configuration,
        });
      } catch (error) {
        nestedWorkers.delete(worker);
        worker.terminate();
        throw workerError(
          "ARCANE_AI_WORKER_MESSAGE_ERROR",
          "The artifact module Worker initialization message was rejected.",
          error,
          "speech-module-worker-initialization-message-rejected",
        );
      }
      return worker;
    },
  });
  return completeValue({
    router,
    transformersCache: reader.cacheForName("transformers-cache", null),
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

function installOrdinaryArtifactModuleRouter(scope, configuration, role) {
  const originalFetch = scope.fetch?.bind(scope);
  const originalWorker = scope.Worker;
  const originalCaches = scope.caches;
  if (typeof originalFetch !== "function") {
    throw workerError(
      "ARCANE_AI_PROVIDER_UNAVAILABLE",
      "Browser fetch is unavailable in the speech Worker.",
      undefined,
      "speech-worker-fetch-unavailable",
    );
  }
  const reader = createOrdinaryRouteReader(
    scope,
    configuration,
    originalFetch,
    originalCaches,
  );
  const moduleRouter = createOrdinaryArtifactModuleRouter(
    scope,
    configuration,
    role,
    reader,
    originalFetch,
    originalWorker,
  );
  const hadOwn = Object.prototype.hasOwnProperty.call(scope, MODULE_ROUTER_NAME);
  const previous = scope[MODULE_ROUTER_NAME];
  try {
    scope[MODULE_ROUTER_NAME] = moduleRouter.router;
    if (scope[MODULE_ROUTER_NAME] !== moduleRouter.router) {
      Object.defineProperty(scope, MODULE_ROUTER_NAME, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: moduleRouter.router,
      });
    }
  } catch (error) {
    moduleRouter.cleanup();
    throw workerError(
      "ARCANE_AI_PROVIDER_UNAVAILABLE",
      "The speech Worker cannot install the artifact module router.",
      error,
      "speech-module-router-unavailable",
    );
  }
  return completeValue({
    cache: moduleRouter.transformersCache,
    cleanup() {
      moduleRouter.cleanup();
      try {
        if (hadOwn) scope[MODULE_ROUTER_NAME] = previous;
        else delete scope[MODULE_ROUTER_NAME];
      } catch {
        // Worker teardown releases the remaining module router reference.
      }
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
  return completeValue({ mjs: mjs.moduleUrl, wasm: wasm.moduleUrl });
}

function configureRuntimeNamespace(namespace, configuration, role, cache) {
  const cleanup = [];
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
  return completeValue({
    async transcribe(input, { signal: requestSignal } = {}) {
      throwIfAborted(requestSignal, "stt-transcription-cancelled");
      const output = await transcriber(input.audio, { signal: requestSignal });
      throwIfAborted(requestSignal, "stt-transcription-cancelled");
      return completeValue({ text: String(output?.text ?? "") });
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
  return completeValue({
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
      return completeValue({
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
    return completeValue({ audio: payload.audio, sampleRate: inputSampleRate });
  }
  const text = requiredContent(payload?.text, "Kokoro text", "tts-synthesis-text-empty");
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
  if (!Number.isFinite(speed) || speed <= 0) {
    throw workerError(
      "ARCANE_AI_INVALID_REQUEST",
      "Kokoro speed must be greater than 0.",
      undefined,
      "tts-synthesis-speed-not-positive",
    );
  }
  return completeValue({ text, voice, speed });
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
    return completeValue({ text: result.text });
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
  return completeValue({
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
    return completeValue({
      state,
      lifecycleStatus: `${role}-worker-${state}`,
      lifecycleReason,
      role,
      loaded: engine !== null,
      busy: operations.size > 0,
      activeOperation: operations.values().next().value?.publicOperation ?? null,
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
      if (graphConfiguration(configuration)) {
        environment = installOrdinaryArtifactModuleRouter(scope, configuration, role);
      } else {
        environment = completeValue({
          cache: null,
          cleanup() {},
        });
      }
      loadFailureReason = `${role}-worker-runtime-import-rejected`;
      const namespace = await import(entry.moduleUrl);
      throwIfAborted(signal, `${role}-load-cancelled`);
      restoreNamespace = configureRuntimeNamespace(
        namespace,
        configuration,
        role,
        environment.cache,
      );
      loadFailureReason = `${role}-worker-model-load-rejected`;
      const report = () => undefined;
      engine = role === "stt"
        ? await createWhisperEngine(namespace, configuration, signal, report)
        : await createKokoroEngine(namespace, configuration, signal, report);
      lifecycleReason = `${role}-load-completed`;
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
    }, collectSpeechTransferables(result)), (error) => {
      const response = {
        protocol: SPEECH_WORKER_PROTOCOL,
        id: request.id,
        ok: false,
        error: null,
      };
      sendSerializedError(send, response, error, role, op, scope);
    });
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
      const result = Promise.resolve(completeValue({
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

  return completeValue({ handleMessage, status });
}

export function installBrowserSpeechWorker(role, scope = globalThis) {
  const runtime = createSpeechWorkerRuntime({
    role,
    scope,
    send: (message, transfers) => scope.postMessage(message, transfers),
  });

  function receive(request) {
    void runtime.handleMessage(request).catch(() => undefined);
  }

  scope.addEventListener("message", (event) => {
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
      || request.op !== "initialize-artifact-module-worker"
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
        environment = installOrdinaryArtifactModuleRouter(scope, configuration, role);
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
        try {
          sendSerializedError(
            (message, transfers) => scope.postMessage(message, transfers),
            {
              protocol: NESTED_WORKER_PROTOCOL,
              event: "artifact-module-worker-bootstrap-rejected",
              error: null,
            },
            error,
            role,
            "load",
            scope,
          );
        } finally {
          scope.close?.();
        }
      }
    })();
  };
  scope.addEventListener("message", bootstrap);
  return completeValue({
    protocol: NESTED_WORKER_PROTOCOL,
    role,
    lifecycleStatus: `${role}-artifact-module-worker-awaiting-initialization`,
  });
}

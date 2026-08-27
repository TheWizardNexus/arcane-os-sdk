import {
  collectSpeechTransferables,
  normalizeSpeechWorkerErrorEnvelope,
  SPEECH_WORKER_PROTOCOL,
} from "./speech-worker-runtime.mjs";

const ARTIFACT_GRAPH_MODULE_GRAPH =
  "browser-speech-authenticated-artifact-graph";
const PUBLIC_WORKER_OPERATIONS = new Set([
  "load",
  "use",
  "status",
  "unload",
  "dispose",
]);
const WORKER_CLIENT_ERRORS = new WeakSet();

function clientError(code, message, cause, reason) {
  const error = cause === undefined
    ? new Error(message)
    : new Error(message, { cause });
  error.name = code === "ARCANE_AI_REQUEST_ABORTED"
    ? "AbortError"
    : "ArcaneSpeechWorkerError";
  error.code = code;
  if (typeof reason === "string" && reason) error.reason = reason;
  WORKER_CLIENT_ERRORS.add(error);
  return error;
}

function operationSubject(role, op) {
  if (op === "use") return role === "stt" ? "stt-transcription" : "tts-synthesis";
  return `${role}-${op}`;
}

function abortError(signal, role, op) {
  return clientError(
    "ARCANE_AI_REQUEST_ABORTED",
    "The speech worker operation was cancelled.",
    signal?.reason,
    `${operationSubject(role, op)}-cancelled`,
  );
}

function validProgress(role, progress) {
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) return false;
  const keys = Object.keys(progress).sort().join(",");
  if (keys !== "completed,heartbeat,phase,total,unit") return false;
  const phases = new Set([
    `${role}-runtime-import-started`,
    `${role}-model-load-started`,
    `${role}-model-load-progress`,
    `${role}-provider-ready`,
  ]);
  return phases.has(progress.phase)
    && Number.isFinite(progress.completed)
    && progress.completed >= 0
    && (progress.total === null || (Number.isFinite(progress.total) && progress.total >= 0))
    && (progress.unit === "bytes" || progress.unit === "items")
    && progress.heartbeat === true;
}

function validateWorker(worker) {
  if (!worker || typeof worker.postMessage !== "function" || typeof worker.terminate !== "function") {
    throw new TypeError("The packaged speech worker did not create a Worker.");
  }
  return worker;
}

function validateMessagePort(port) {
  if (
    !port
    || typeof port.postMessage !== "function"
    || typeof port.addEventListener !== "function"
    || typeof port.close !== "function"
  ) {
    throw clientError(
      "ARCANE_AI_WORKER_MESSAGE_ERROR",
      "The browser did not create a usable private speech Worker MessagePort.",
      undefined,
      "artifact-graph-private-message-port-unavailable",
    );
  }
  return port;
}

const WORKER_CLIENTS = new WeakSet();

/**
 * Owns exactly one role Worker. Cancellation terminates that Worker, which is
 * the only reliable preemption boundary for the third-party WASM engines.
 */
class SpeechWorkerClient {
  #role;
  #createWorker;
  #worker = null;
  #transport = null;
  #transportMode = null;
  #privatePorts = null;
  #pending = new Map();
  #nextId = 1;
  #listeners = [];
  #terminated = false;
  #onTermination;

  constructor({ role, onTermination = () => undefined } = {}) {
    if (role !== "stt" && role !== "tts") {
      throw new TypeError('SpeechWorkerClient role must be "stt" or "tts".');
    }
    if (typeof onTermination !== "function") {
      throw new TypeError("SpeechWorkerClient onTermination must be a function.");
    }
    const workerUrl = role === "stt"
      ? new URL("./browser-whisper-worker.mjs", import.meta.url)
      : new URL("./browser-kokoro-worker.mjs", import.meta.url);
    this.#role = role;
    this.#createWorker = () => new Worker(workerUrl, {
      type: "module",
      name: role === "stt" ? "arcane-whisper-stt" : "arcane-kokoro-tts",
    });
    this.#onTermination = onTermination;
    WORKER_CLIENTS.add(this);
  }

  #listen(target, type, listener) {
    target.addEventListener(type, listener);
    this.#listeners.push(() => target.removeEventListener(type, listener));
  }

  #start() {
    if (this.#worker) return this.#worker;
    if (this.#terminated) {
      throw clientError(
        "ARCANE_AI_OPERATION_SUPERSEDED",
        "The speech Worker was already terminated.",
        undefined,
        `${this.#role}-worker-already-terminated`,
      );
    }
    const worker = validateWorker(this.#createWorker());
    this.#worker = worker;
    this.#listen(worker, "message", (event) => {
      if (this.#transportMode === "private-message-port") return;
      this.#handleMessage(event.data);
    });
    this.#listen(worker, "messageerror", (event) => {
      void this.terminate(clientError(
        "ARCANE_AI_WORKER_MESSAGE_ERROR",
        "The speech Worker returned an unreadable message.",
        event,
        `${this.#role}-worker-message-rejected`,
      ), { intentional: false }).catch(() => undefined);
    });
    this.#listen(worker, "error", (event) => {
      void this.terminate(clientError(
        "ARCANE_AI_WORKER_CRASHED",
        "The speech Worker crashed.",
        event,
        `${this.#role}-worker-crashed`,
      ), { intentional: false }).catch(() => undefined);
    });
    return worker;
  }

  #establishPrivateTransport() {
    if (this.#transportMode === "private-message-port") return null;
    if (this.#transportMode !== null) {
      throw clientError(
        "ARCANE_AI_ADAPTER_PROTOCOL_MISMATCH",
        "The speech Worker already uses the legacy global message transport.",
        undefined,
        "artifact-graph-private-message-port-established-too-late",
      );
    }
    const MessageChannelConstructor = globalThis.MessageChannel;
    if (typeof MessageChannelConstructor !== "function") {
      throw clientError(
        "ARCANE_AI_WORKER_MESSAGE_ERROR",
        "Authenticated artifact graph loading requires MessageChannel.",
        undefined,
        "artifact-graph-private-message-channel-unavailable",
      );
    }
    const channel = new MessageChannelConstructor();
    const clientPort = validateMessagePort(channel.port1);
    const workerPort = validateMessagePort(channel.port2);
    this.#privatePorts = Object.freeze({ clientPort, workerPort });
    this.#transport = clientPort;
    this.#transportMode = "private-message-port";
    this.#listen(clientPort, "message", (event) => this.#handleMessage(event.data));
    this.#listen(clientPort, "messageerror", (event) => {
      void this.terminate(clientError(
        "ARCANE_AI_WORKER_MESSAGE_ERROR",
        "The private speech Worker MessagePort returned an unreadable message.",
        event,
        `${this.#role}-worker-private-message-rejected`,
      ), { intentional: false }).catch(() => undefined);
    });
    clientPort.start?.();
    return workerPort;
  }

  #handleMessage(message) {
    if (message?.protocol !== SPEECH_WORKER_PROTOCOL) {
      void this.terminate(clientError(
        "ARCANE_AI_ADAPTER_PROTOCOL_MISMATCH",
        "The speech Worker protocol did not match the SDK.",
        undefined,
        `${this.#role}-worker-protocol-mismatch`,
      ), { intentional: false }).catch(() => undefined);
      return;
    }
    if (message.event === "progress") {
      const pending = this.#pending.get(message.requestId);
      if (!pending) return;
      if (!validProgress(this.#role, message.progress)) {
        void this.terminate(clientError(
          "ARCANE_AI_WORKER_MESSAGE_ERROR",
          "The speech Worker progress envelope was rejected.",
          undefined,
          `${this.#role}-worker-progress-envelope-rejected`,
        ), { intentional: false }).catch(() => undefined);
        return;
      }
      try {
        pending.progress(message.progress);
      } catch (error) {
        void this.terminate(clientError(
          "ARCANE_AI_PROGRESS_CALLBACK_THREW",
          "The speech load progress callback threw an exception.",
          error,
          `${this.#role}-load-progress-callback-threw`,
        ), { intentional: false }).catch(() => undefined);
      }
      return;
    }
    if (!Number.isSafeInteger(message.id) || typeof message.ok !== "boolean") {
      void this.terminate(clientError(
        "ARCANE_AI_WORKER_MESSAGE_ERROR",
        "The speech Worker response envelope shape was rejected.",
        undefined,
        `${this.#role}-worker-response-envelope-shape-rejected`,
      ), { intentional: false }).catch(() => undefined);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    pending.cleanup();
    if (message.ok === true) {
      pending.resolve(message.result);
      return;
    }
    const admitted = normalizeSpeechWorkerErrorEnvelope(
      message.error,
      this.#role,
      pending.op,
    );
    if (!admitted) {
      const failure = clientError(
        "ARCANE_AI_WORKER_MESSAGE_ERROR",
        "The speech Worker error envelope was rejected.",
        undefined,
        `${this.#role}-worker-error-envelope-rejected`,
      );
      pending.reject(failure);
      void this.terminate(failure, { intentional: false }).catch(() => undefined);
      return;
    }
    pending.reject(clientError(
      admitted.code,
      admitted.message,
      undefined,
      admitted.reason,
    ));
  }

  request(op, payload, { signal = null, progress = () => undefined } = {}) {
    if (!PUBLIC_WORKER_OPERATIONS.has(op)) {
      return Promise.reject(clientError(
        "ARCANE_AI_INVALID_REQUEST",
        "The speech worker operation is not part of its protocol.",
        undefined,
        `${this.#role}-worker-operation-unknown`,
      ));
    }
    if (signal?.aborted) return Promise.reject(abortError(signal, this.#role, op));
    if (typeof progress !== "function") {
      return Promise.reject(new TypeError("Speech Worker progress must be a function."));
    }
    let worker;
    let initialPrivatePort = null;
    try {
      worker = this.#start();
      const graphLoad = op === "load"
        && payload?.configuration?.runtime?.moduleGraph === ARTIFACT_GRAPH_MODULE_GRAPH;
      if (graphLoad) {
        initialPrivatePort = this.#establishPrivateTransport();
      } else if (this.#transportMode === null) {
        this.#transportMode = "worker-global-message";
        this.#transport = worker;
      }
      if (op === "load"
        && !graphLoad
        && this.#transportMode === "private-message-port") {
        throw clientError(
          "ARCANE_AI_ADAPTER_PROTOCOL_MISMATCH",
          "A private artifact graph Worker cannot load a legacy runtime descriptor.",
          undefined,
          `${this.#role}-worker-runtime-transport-mode-mismatch`,
        );
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      let listening = true;
      const cleanup = () => {
        if (!listening) return;
        listening = false;
        signal?.removeEventListener?.("abort", onAbort);
      };
      const onAbort = () => {
        if (!this.#pending.has(id)) return;
        void this.terminate(
          abortError(signal, this.#role, op),
          { intentional: true },
        ).catch(() => undefined);
      };
      signal?.addEventListener?.("abort", onAbort, { once: true });
      this.#pending.set(id, { resolve, reject, progress, cleanup, op });
      const message = {
        protocol: SPEECH_WORKER_PROTOCOL,
        id,
        op,
        payload,
      };
      const transfers = collectSpeechTransferables(payload);
      let destination = this.#transport;
      if (initialPrivatePort) {
        message.privatePort = initialPrivatePort;
        transfers.push(initialPrivatePort);
        destination = worker;
      }
      try {
        destination.postMessage(message, transfers);
      } catch (error) {
        this.#pending.delete(id);
        cleanup();
        const failure = clientError(
          "ARCANE_AI_WORKER_MESSAGE_ERROR",
          "Unable to send an operation to the speech Worker.",
          error,
          `${operationSubject(this.#role, op)}-message-rejected`,
        );
        reject(failure);
        void this.terminate(failure, { intentional: false }).catch(() => undefined);
      }
    });
  }

  async terminate(reason = null, { intentional = true } = {}) {
    if (typeof intentional !== "boolean") {
      throw new TypeError("Speech Worker termination intent must be a boolean.");
    }
    if (this.#terminated) return;
    const terminationReason = reason instanceof Error && WORKER_CLIENT_ERRORS.has(reason)
      ? reason
      : clientError(
        "ARCANE_AI_OPERATION_SUPERSEDED",
        "The speech Worker was terminated.",
        reason instanceof Error ? reason : undefined,
        `${this.#role}-worker-terminated`,
      );
    this.#terminated = true;
    const worker = this.#worker;
    this.#worker = null;
    for (const remove of this.#listeners.splice(0).reverse()) {
      try {
        remove();
      } catch {
        // Listener removal follows Worker isolation and is best effort.
      }
    }
    const pendingOperations = [...this.#pending.values()];
    for (const pending of pendingOperations) pending.cleanup();
    this.#pending.clear();
    try {
      for (const port of [
        this.#privatePorts?.clientPort,
        this.#privatePorts?.workerPort,
      ]) {
        try {
          port?.close();
        } catch {
          // Worker termination remains the authoritative cancellation boundary.
        }
      }
      this.#privatePorts = null;
      this.#transport = null;
      const termination = worker?.terminate();
      if (termination && typeof termination.then === "function") await termination;
    } finally {
      for (const pending of pendingOperations) pending.reject(terminationReason);
      this.#onTermination(Object.freeze({ reason: terminationReason, intentional }));
    }
  }
}

export function createSpeechWorkerClient(options) {
  return new SpeechWorkerClient(options);
}

export function isSpeechWorkerClient(value) {
  return WORKER_CLIENTS.has(value);
}

export function isSpeechWorkerClientError(value) {
  return value instanceof Error && WORKER_CLIENT_ERRORS.has(value);
}

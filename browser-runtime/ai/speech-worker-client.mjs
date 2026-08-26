import {
  collectSpeechTransferables,
  SPEECH_WORKER_PROTOCOL,
} from "./speech-worker-runtime.mjs";

function clientError(code, message, cause) {
  const error = cause === undefined
    ? new Error(message)
    : new Error(message, { cause });
  error.name = code === "ARCANE_AI_REQUEST_ABORTED"
    ? "AbortError"
    : "ArcaneSpeechWorkerError";
  error.code = code;
  return error;
}

function abortError(signal) {
  return clientError(
    "ARCANE_AI_REQUEST_ABORTED",
    "The speech worker operation was cancelled.",
    signal?.reason,
  );
}

function validateWorker(worker) {
  if (!worker || typeof worker.postMessage !== "function" || typeof worker.terminate !== "function") {
    throw new TypeError("The packaged speech worker did not create a Worker.");
  }
  return worker;
}

const WORKER_CLIENTS = new WeakSet();

/**
 * Owns exactly one role Worker. Cancellation terminates that Worker, which is
 * the only reliable preemption boundary for the third-party WASM engines.
 */
class SpeechWorkerClient {
  #createWorker;
  #worker = null;
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
    this.#createWorker = () => new Worker(workerUrl, {
      type: "module",
      name: role === "stt" ? "arcane-whisper-stt" : "arcane-kokoro-tts",
    });
    this.#onTermination = onTermination;
    WORKER_CLIENTS.add(this);
  }

  #listen(worker, type, listener) {
    worker.addEventListener(type, listener);
    this.#listeners.push(() => worker.removeEventListener(type, listener));
  }

  #start() {
    if (this.#worker) return this.#worker;
    if (this.#terminated) {
      throw clientError("ARCANE_AI_OPERATION_SUPERSEDED", "The speech Worker was already terminated.");
    }
    const worker = validateWorker(this.#createWorker());
    this.#worker = worker;
    this.#listen(worker, "message", (event) => this.#handleMessage(event.data));
    this.#listen(worker, "messageerror", (event) => {
      void this.terminate(clientError(
        "ARCANE_AI_WORKER_MESSAGE_ERROR",
        "The speech Worker returned an unreadable message.",
        event,
      ), { intentional: false });
    });
    this.#listen(worker, "error", (event) => {
      void this.terminate(clientError(
        "ARCANE_AI_WORKER_CRASHED",
        "The speech Worker crashed.",
        event,
      ), { intentional: false });
    });
    return worker;
  }

  #handleMessage(message) {
    if (message?.protocol !== SPEECH_WORKER_PROTOCOL) {
      void this.terminate(clientError(
        "ARCANE_AI_ADAPTER_PROTOCOL_MISMATCH",
        "The speech Worker protocol did not match the SDK.",
      ), { intentional: false });
      return;
    }
    if (message.event === "progress") {
      this.#pending.get(message.requestId)?.progress(message.progress);
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
    pending.reject(clientError(
      message.error?.code ?? "ARCANE_AI_PROVIDER_REQUEST_FAILED",
      message.error?.message ?? "The speech Worker operation failed.",
    ));
  }

  request(op, payload, { signal = null, progress = () => undefined } = {}) {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (typeof progress !== "function") {
      return Promise.reject(new TypeError("Speech Worker progress must be a function."));
    }
    let worker;
    try {
      worker = this.#start();
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
        void this.terminate(abortError(signal), { intentional: true });
      };
      signal?.addEventListener?.("abort", onAbort, { once: true });
      this.#pending.set(id, { resolve, reject, progress, cleanup });
      try {
        worker.postMessage({
          protocol: SPEECH_WORKER_PROTOCOL,
          id,
          op,
          payload,
        }, collectSpeechTransferables(payload));
      } catch (error) {
        this.#pending.delete(id);
        cleanup();
        const failure = clientError(
          "ARCANE_AI_WORKER_MESSAGE_ERROR",
          "Unable to send an operation to the speech Worker.",
          error,
        );
        reject(failure);
        void this.terminate(failure, { intentional: false });
      }
    });
  }

  async terminate(reason = clientError(
    "ARCANE_AI_OPERATION_SUPERSEDED",
    "The speech Worker was terminated.",
  ), { intentional = true } = {}) {
    if (typeof intentional !== "boolean") {
      throw new TypeError("Speech Worker termination intent must be a boolean.");
    }
    if (this.#terminated) return;
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
    for (const pending of pendingOperations) {
      pending.cleanup();
    }
    this.#pending.clear();
    try {
      const termination = worker?.terminate();
      if (termination && typeof termination.then === "function") await termination;
    } finally {
      for (const pending of pendingOperations) pending.reject(reason);
      this.#onTermination(Object.freeze({ reason, intentional }));
    }
  }
}

export function createSpeechWorkerClient(options) {
  return new SpeechWorkerClient(options);
}

export function isSpeechWorkerClient(value) {
  return WORKER_CLIENTS.has(value);
}

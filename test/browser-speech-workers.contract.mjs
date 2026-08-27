import { SPEECH_WORKER_PROTOCOL } from "../browser-runtime/ai/speech-worker-runtime.mjs";

export function createSpeechWorkerContract({ role, holdUse = false } = {}) {
  const listeners = new Map();
  let terminated = false;
  let privatePort = null;
  let privatePortTransferred = false;
  let configuration = null;
  const posted = [];

  function emit(type, data) {
    for (const listener of listeners.get(type) ?? []) listener({ data });
  }

  function emitEvent(type, event) {
    for (const listener of listeners.get(type) ?? []) listener(event);
  }

  function handleMessage(message, reply) {
    posted.push(message);
    if (holdUse && message.op === "use") return;
    queueMicrotask(() => {
      if (terminated) return;
      let result;
      if (message.op === "load") {
        configuration = message.payload?.configuration ?? null;
        result = { state: "ready", loaded: true, busy: false };
      } else if (message.op === "use" && role === "stt") {
        result = { text: "hello from whisper" };
      } else if (message.op === "use") {
        result = {
          audio: new Float32Array([0, 0.25, -0.25]),
          sampleRate: configuration?.model?.outputSampleRate ?? 24_000,
          voice: message.payload.voice,
        };
      } else {
        result = { state: "unloaded", loaded: false, busy: false };
      }
      reply({
        protocol: SPEECH_WORKER_PROTOCOL,
        id: message.id,
        ok: true,
        result,
      });
    });
  }

  const worker = {
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? new Set();
      entries.add(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    postMessage(message, transfers = []) {
      if (message.privatePort) {
        if (!Array.isArray(transfers) || !transfers.includes(message.privatePort)) {
          throw new TypeError("The private speech MessagePort was not transferred.");
        }
        privatePortTransferred = true;
        privatePort = message.privatePort;
        privatePort.addEventListener("message", (event) => {
          handleMessage(event.data, (response) => privatePort.postMessage(response));
        });
        privatePort.start?.();
        const { privatePort: ignored, ...request } = message;
        void ignored;
        handleMessage(request, (response) => privatePort.postMessage(response));
        return;
      }
      handleMessage(message, (response) => emit("message", response));
    },
    terminate() {
      terminated = true;
      privatePort?.close();
      privatePort = null;
    },
  };

  return Object.freeze({
    worker,
    posted,
    get terminated() {
      return terminated;
    },
    get privateTransport() {
      return privatePort !== null;
    },
    get privatePortTransferred() {
      return privatePortTransferred;
    },
    crash() {
      if (terminated) return;
      emitEvent("error", { message: "synthetic speech Worker crash" });
    },
  });
}

import { SPEECH_WORKER_PROTOCOL } from "../browser-runtime/ai/speech-worker-runtime.mjs";

export function createSpeechWorkerContract({ role, holdUse = false } = {}) {
  const listeners = new Map();
  let terminated = false;
  const posted = [];

  function emit(type, data) {
    for (const listener of listeners.get(type) ?? []) listener({ data });
  }

  function emitEvent(type, event) {
    for (const listener of listeners.get(type) ?? []) listener(event);
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
    postMessage(message) {
      posted.push(message);
      if (holdUse && message.op === "use") return;
      queueMicrotask(() => {
        if (terminated) return;
        let result;
        if (message.op === "load") {
          result = { state: "ready", loaded: true, busy: false };
        } else if (message.op === "use" && role === "stt") {
          result = { text: "hello from whisper" };
        } else if (message.op === "use") {
          result = {
            audio: new Float32Array([0, 0.25, -0.25]),
            sampleRate: 24_000,
            voice: message.payload.voice,
          };
        } else {
          result = { state: "unloaded", loaded: false, busy: false };
        }
        emit("message", {
          protocol: SPEECH_WORKER_PROTOCOL,
          id: message.id,
          ok: true,
          result,
        });
      });
    },
    terminate() {
      terminated = true;
    },
  };

  return Object.freeze({
    worker,
    posted,
    get terminated() {
      return terminated;
    },
    crash() {
      if (terminated) return;
      emitEvent("error", { message: "synthetic speech Worker crash" });
    },
  });
}

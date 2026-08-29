import { SPEECH_WORKER_PROTOCOL } from "../browser-runtime/ai/speech-worker-runtime.mjs";

export function createSpeechWorkerContract({
  role,
  holdUse = false,
  responseError = null,
} = {}) {
  const listeners = new Map();
  let terminated = false;
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
      const rejected = typeof responseError === "function"
        ? responseError(message)
        : responseError;
      if (rejected) {
        reply({
          protocol: SPEECH_WORKER_PROTOCOL,
          id: message.id,
          ok: false,
          error: rejected,
        });
        return;
      }
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
    postMessage(message) {
      handleMessage(message, (response) => emit("message", response));
    },
    terminate() {
      terminated = true;
    },
  };

  return {
    worker,
    posted,
    get terminated() {
      return terminated;
    },
    crash() {
      if (terminated) return;
      emitEvent("error", { message: "synthetic speech Worker crash" });
    },
  };
}

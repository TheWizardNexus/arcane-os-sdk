import { SPEECH_WORKER_PROTOCOL } from "../browser-runtime/ai/speech-worker-runtime.mjs";

export function createSpeechWorkerContract({
  role,
  holdUse = false,
  responseError = null,
  workerId = null,
} = {}) {
  const listeners = new Map();
  let terminated = false;
  let configuration = null;
  const posted = [];
  const heldUses = new Map();
  const heldUseNotifications = [];
  const heldUseWaiters = [];
  const cancelledUseIds = [];

  function emit(type, data) {
    for (const listener of listeners.get(type) ?? []) listener({ data });
  }

  function emitEvent(type, event) {
    for (const listener of listeners.get(type) ?? []) listener(event);
  }

  function defaultResult(message) {
    if (message.op === "load") {
      configuration = message.payload?.configuration ?? null;
      return { state: "ready", loaded: true, busy: false };
    }
    if (message.op === "use" && role === "stt") {
      return { text: "hello from whisper" };
    }
    if (message.op === "use") {
      return {
        audio: new Float32Array([0, 0.25, -0.25]),
        sampleRate: configuration?.model?.outputSampleRate ?? 24_000,
        voice: message.payload.voice,
      };
    }
    return { state: "unloaded", loaded: false, busy: false };
  }

  function replyToMessage(message, reply, result, useSuppliedResult = false) {
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
    reply({
      protocol: SPEECH_WORKER_PROTOCOL,
      id: message.id,
      ok: true,
      result: useSuppliedResult ? result : defaultResult(message),
    });
  }

  function publishHeldUse(message) {
    const waiter = heldUseWaiters.shift();
    if (waiter) {
      waiter(message);
      return;
    }
    heldUseNotifications.push(message);
  }

  function handleMessage(message, reply) {
    posted.push(message);
    if (message.op === "cancel") {
      const targetId = message.payload?.targetId;
      const cancelled = heldUses.delete(targetId);
      if (cancelled) cancelledUseIds.push(targetId);
      queueMicrotask(function answerTargetedCancellation() {
        replyToMessage(message, reply, {
          cancelled,
          reason: cancelled
            ? `${role}-${role === "stt" ? "transcription" : "synthesis"}-cancelled`
            : `${role}-cancel-target-not-active`,
        }, true);
      });
      return;
    }
    if (holdUse && message.op === "use") {
      heldUses.set(message.id, { message, reply });
      publishHeldUse(message);
      return;
    }
    queueMicrotask(function answerSpeechWorkerMessage() {
      replyToMessage(message, reply);
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
      heldUses.clear();
    },
  };

  return {
    worker,
    workerId,
    posted,
    cancelledUseIds,
    heldUseIds() {
      return [...heldUses.keys()];
    },
    waitForUse() {
      if (heldUseNotifications.length) {
        return Promise.resolve(heldUseNotifications.shift());
      }
      return new Promise(function waitForHeldSpeechUse(resolve) {
        heldUseWaiters.push(resolve);
      });
    },
    releaseUse(id, result) {
      const useSuppliedResult = arguments.length > 1;
      const pending = heldUses.get(id);
      if (!pending) return false;
      heldUses.delete(id);
      queueMicrotask(function releaseHeldSpeechUse() {
        replyToMessage(
          pending.message,
          pending.reply,
          result,
          useSuppliedResult,
        );
      });
      return true;
    },
    get terminated() {
      return terminated;
    },
    crash() {
      if (terminated) return;
      emitEvent("error", { message: "synthetic speech Worker crash" });
    },
  };
}

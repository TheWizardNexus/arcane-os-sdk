export const ARCANE_AI_ADAPTER_PROTOCOL = "arcane-ai-adapter/1";

const SECURITY_KEYS = Object.freeze(["secure", "checks"]);
const SECURITY_CHECK_KEYS = Object.freeze(["byteLength", "sha256"]);
const EMPTY_SECURITY_CHECKS = Object.freeze({});
const EMPTY_MODEL_SECURITY = Object.freeze({ checks: EMPTY_SECURITY_CHECKS });

function closedSecurityRecord(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object when provided.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object when provided.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !keys.includes(key)) {
      throw new TypeError(`${label} contains an unknown ${String(key)} field.`);
    }
    if (descriptors[key].get || descriptors[key].set) {
      throw new TypeError(`${label}.${key} must be a data property.`);
    }
  }
  return descriptors;
}

export function normalizeModelSecurity(value, label = "security") {
  if (value === undefined) return EMPTY_MODEL_SECURITY;
  const descriptors = closedSecurityRecord(value, SECURITY_KEYS, label);
  const normalized = {};
  if (descriptors.secure?.value !== undefined) {
    if (typeof descriptors.secure.value !== "boolean") {
      throw new TypeError(`${label}.secure must be a boolean when provided.`);
    }
    normalized.secure = descriptors.secure.value;
  }

  let checks = EMPTY_SECURITY_CHECKS;
  if (descriptors.checks?.value !== undefined) {
    const checkDescriptors = closedSecurityRecord(
      descriptors.checks.value,
      SECURITY_CHECK_KEYS,
      `${label}.checks`,
    );
    const normalizedChecks = {};
    for (const check of SECURITY_CHECK_KEYS) {
      if (checkDescriptors[check]?.value === undefined) continue;
      if (typeof checkDescriptors[check].value !== "boolean") {
        throw new TypeError(`${label}.checks.${check} must be a boolean when provided.`);
      }
      normalizedChecks[check] = checkDescriptors[check].value;
    }
    checks = Object.freeze(normalizedChecks);
  }
  normalized.checks = checks;
  return Object.freeze(normalized);
}

export function resolveModelSecurity({ app, binding, load } = {}) {
  const scopes = [
    normalizeModelSecurity(app, "app security"),
    normalizeModelSecurity(binding, "provider security"),
    normalizeModelSecurity(load, "load security"),
  ];
  let secure = false;
  let byteLength;
  let sha256;
  for (const scope of scopes) {
    if (Object.hasOwn(scope, "secure")) secure = scope.secure;
    if (Object.hasOwn(scope.checks, "byteLength")) byteLength = scope.checks.byteLength;
    if (Object.hasOwn(scope.checks, "sha256")) sha256 = scope.checks.sha256;
  }
  return Object.freeze({
    secure,
    checks: Object.freeze({
      byteLength: byteLength ?? secure,
      sha256: sha256 ?? secure,
    }),
  });
}

export function sameModelSecurity(left, right) {
  return left?.checks?.byteLength === right?.checks?.byteLength
    && left?.checks?.sha256 === right?.checks?.sha256;
}

function hasModelSecurityOverrides(value) {
  return Object.hasOwn(value, "secure")
    || Object.hasOwn(value.checks, "byteLength")
    || Object.hasOwn(value.checks, "sha256");
}

const ERROR_CODES = Object.freeze({
  load: "ARCANE_AI_LOAD_FAILED",
  unload: "ARCANE_AI_UNLOAD_FAILED",
  request: "ARCANE_AI_REQUEST_FAILED",
  dispose: "ARCANE_AI_DISPOSE_FAILED",
  probe: "ARCANE_AI_PROBE_FAILED",
});

function abortLike(error, signal) {
  return signal?.aborted === true
    || error?.name === "AbortError"
    || error?.code === "ABORT_ERR"
    || error?.code === "ARCANE_AI_REQUEST_ABORTED";
}

export class ArcaneAIError extends Error {
  constructor(code, message, { cause, kind = "llm", operation = "request" } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ArcaneAIError";
    this.code = code;
    this.kind = kind;
    this.operation = operation;
  }
}

export function normalizeArcaneAIError(error, {
  kind = "llm",
  operation = "request",
  signal = null,
} = {}) {
  if (abortLike(error, signal)) {
    return new ArcaneAIError(
      "ARCANE_AI_REQUEST_ABORTED",
      "The Arcane AI request was cancelled.",
      { cause: error ?? signal?.reason, kind, operation },
    );
  }
  if (error instanceof ArcaneAIError) return error;
  const code = typeof error?.code === "string" && error.code.startsWith("ARCANE_AI_")
    ? error.code
    : ERROR_CODES[operation] ?? ERROR_CODES.request;
  const message = typeof error?.message === "string" && error.message.trim()
    ? error.message
    : `The Arcane AI ${operation} operation failed.`;
  return new ArcaneAIError(code, message, { cause: error, kind, operation });
}

function providerMethod(provider, name) {
  return typeof provider?.[name] === "function" ? provider[name].bind(provider) : null;
}

function copyError(error) {
  if (!error) return null;
  return Object.freeze({
    code: String(error.code ?? "ARCANE_AI_REQUEST_FAILED"),
    message: String(error.message ?? "The Arcane AI operation failed."),
  });
}

function localRequirement(options, provider) {
  if (options?.localOnly !== undefined && typeof options.localOnly !== "boolean") {
    throw new TypeError("localOnly must be a boolean when provided.");
  }
  if (options?.localOnly === true && provider.capabilities?.().localOnly !== true) {
    throw new ArcaneAIError(
      "ARCANE_AI_LOCAL_ONLY_UNAVAILABLE",
      "The selected AI provider cannot guarantee browser-local inference.",
      { operation: "request" },
    );
  }
}

function linkedAbortSignal(externalSignal) {
  const controller = new AbortController();
  const forward = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) forward();
  else externalSignal?.addEventListener?.("abort", forward, { once: true });
  return Object.freeze({
    controller,
    release: () => externalSignal?.removeEventListener?.("abort", forward),
  });
}

function fireAndForget(callback, ...args) {
  if (typeof callback !== "function") return;
  try {
    Promise.resolve(callback(...args)).catch(() => undefined);
  } catch {
    // Observational callbacks cannot alter the local-inference decision.
  }
}

class ControllerEvent {
  constructor(type, detail, target) {
    this.type = type;
    this.detail = detail;
    this.target = target;
    this.currentTarget = target;
  }
}

let generatedRequestId = 0;

function requestIdentity(value) {
  return value === undefined || value === null
    ? `arcane-local-${++generatedRequestId}`
    : value;
}

function displayRequestId(value) {
  return `M-${String(value)}`;
}

function textFromCompletion(completion) {
  const content = completion?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

function toolRecordFromCompletion(completion) {
  const result = {};
  let count = 0;
  for (const choice of completion?.choices ?? []) {
    for (const call of choice?.message?.tool_calls ?? []) {
      result[call.function.name] = call.function.arguments;
      count += 1;
    }
  }
  return count ? result : null;
}

export class ModelController {
  #provider;
  #loadPolicy;
  #security;
  #listeners = new Map();
  #loadPromise = null;
  #readyPolicyResolved = false;
  #unloadPromise = null;
  #disposePromise = null;
  #operationGeneration = 0;
  #disposing = false;
  #disposed = false;
  #activeStreams = new Set();
  #fallbackState = "unloaded";
  #progress = null;
  #error = null;

  constructor({ provider, loadPolicy = "on-demand", security } = {}) {
    if (!provider || typeof provider !== "object") {
      throw new TypeError("ModelController requires an LLM provider.");
    }
    if (
      provider.protocol !== undefined
      && provider.protocol !== ARCANE_AI_ADAPTER_PROTOCOL
    ) {
      throw new ArcaneAIError(
        "ARCANE_AI_ADAPTER_PROTOCOL_MISMATCH",
        `The LLM provider must implement ${ARCANE_AI_ADAPTER_PROTOCOL}.`,
        { operation: "initialize" },
      );
    }
    if (loadPolicy !== "on-demand" && loadPolicy !== "manual") {
      throw new TypeError("loadPolicy must be \"on-demand\" or \"manual\".");
    }
    this.#provider = provider;
    this.#loadPolicy = loadPolicy;
    this.#security = normalizeModelSecurity(security, "app security");
  }

  status() {
    const providerStatus = providerMethod(this.#provider, "status")?.(
      Object.freeze({ security: this.#security }),
    ) ?? {};
    return Object.freeze({
      ...providerStatus,
      kind: "llm",
      state: providerStatus.state ?? this.#fallbackState,
      progress: providerStatus.progress ?? this.#progress,
      error: providerStatus.error ?? copyError(this.#error),
    });
  }

  addEventListener(type, listener) {
    if (typeof listener !== "function" && typeof listener?.handleEvent !== "function") return;
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  on(type, listener) {
    this.addEventListener(type, listener);
    return () => this.removeEventListener(type, listener);
  }

  #emit(type) {
    const event = new ControllerEvent(type, this.status(), this);
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      try {
        if (typeof listener === "function") listener.call(this, event);
        else listener.handleEvent(event);
      } catch {
        // UI observers cannot alter lifecycle state.
      }
    }
  }

  #assertOperational() {
    if (this.#disposed || this.#disposing) {
      throw new ArcaneAIError("ARCANE_AI_DISPOSED", "The LLM controller is disposed.");
    }
  }

  async load(options = {}) {
    this.#assertOperational();
    const state = this.status().state;
    if (this.#unloadPromise || state === "unloading") {
      throw new ArcaneAIError(
        "ARCANE_AI_OPERATION_SUPERSEDED",
        "The LLM controller cannot load while unload is in progress.",
        { operation: "load" },
      );
    }
    const load = providerMethod(this.#provider, "load");
    if (!load) throw new ArcaneAIError("ARCANE_AI_UNAVAILABLE", "The LLM provider cannot load a model.");
    const signal = options.signal ?? null;
    const explicitOperationSecurity = options.security !== undefined;
    const securityMustResolve = explicitOperationSecurity
      || (
        state === "ready"
        && !this.#readyPolicyResolved
        && hasModelSecurityOverrides(this.#security)
      );
    if (state === "ready" && !securityMustResolve) return this.status();
    if (this.#loadPromise) {
      if (!explicitOperationSecurity) return this.#loadPromise;
      try {
        await load(options, Object.freeze({
          protocol: ARCANE_AI_ADAPTER_PROTOCOL,
          kind: "llm",
          operation: "load",
          signal,
          security: this.#security,
        }));
        return this.status();
      } catch (error) {
        throw normalizeArcaneAIError(error, { operation: "load", signal });
      }
    }
    const wasReady = state === "ready";
    const operationGeneration = ++this.#operationGeneration;
    if (!wasReady) {
      this.#fallbackState = "loading";
      this.#progress = null;
      this.#error = null;
      this.#emit("statechange");
    }
    this.#loadPromise = (async () => {
      try {
        await load(options, Object.freeze({
          protocol: ARCANE_AI_ADAPTER_PROTOCOL,
          kind: "llm",
          operation: "load",
          signal,
          security: this.#security,
          reportProgress: (progress) => {
            if (
              operationGeneration !== this.#operationGeneration
              || this.#disposing
              || this.#disposed
            ) return;
            this.#progress = progress;
            this.#emit("progress");
          },
        }));
        if (
          operationGeneration !== this.#operationGeneration
          || this.#disposing
          || this.#disposed
        ) return this.status();
        this.#readyPolicyResolved = true;
        if (!wasReady) {
          this.#fallbackState = "ready";
          this.#progress = null;
          this.#emit("statechange");
        }
        return this.status();
      } catch (error) {
        const normalized = normalizeArcaneAIError(error, { operation: "load", signal });
        if (
          operationGeneration === this.#operationGeneration
          && !this.#disposing
          && !this.#disposed
          && !wasReady
        ) {
          this.#fallbackState = "error";
          this.#error = normalized;
          this.#emit("statechange");
        }
        throw normalized;
      } finally {
        this.#loadPromise = null;
      }
    })();
    return this.#loadPromise;
  }

  async #ready(loadOptions = {}) {
    this.#assertOperational();
    const state = this.status().state;
    if (this.#unloadPromise || state === "unloading") {
      throw new ArcaneAIError(
        "ARCANE_AI_OPERATION_SUPERSEDED",
        "The LLM controller cannot accept requests while unload is in progress.",
        { operation: "request" },
      );
    }
    if (state === "ready") return void await this.load(loadOptions);
    if (this.#loadPolicy === "manual") {
      throw new ArcaneAIError(
        "ARCANE_AI_NOT_READY",
        "The browser-WASM model must be loaded before use.",
      );
    }
    await this.load(loadOptions);
  }

  async #closeStreams(reason) {
    const active = [...this.#activeStreams];
    await Promise.all(active.map((handle) => handle.cancel(reason)));
  }

  async unload(options = {}) {
    if (this.#unloadPromise) return this.#unloadPromise;
    const unload = providerMethod(this.#provider, "unload");
    if (!unload) throw new ArcaneAIError("ARCANE_AI_UNAVAILABLE", "The LLM provider cannot unload.");
    const signal = options.signal ?? null;
    const inFlightLoad = this.#loadPromise;
    const operationGeneration = ++this.#operationGeneration;
    const context = Object.freeze({
      protocol: ARCANE_AI_ADAPTER_PROTOCOL,
      kind: "llm",
      operation: "unload",
      signal,
    });
    this.#fallbackState = "unloading";
    this.#emit("statechange");
    this.#unloadPromise = (async () => {
      try {
        await this.#closeStreams("The browser-WASM model is unloading.");
        // The first call asks the provider to cancel its in-flight load. A
        // provider owns its public status, so wait for the captured load and
        // reassert unload afterward; a late provider-owned `ready` state can
        // otherwise outlive this controller's generation guard.
        await unload(options, context);
        if (inFlightLoad) {
          await inFlightLoad.catch(() => undefined);
          await unload(options, context);
        }
        if (operationGeneration === this.#operationGeneration) {
          this.#fallbackState = "unloaded";
          this.#readyPolicyResolved = false;
          this.#progress = null;
          this.#error = null;
          this.#emit("statechange");
        }
        return this.status();
      } catch (error) {
        const normalized = normalizeArcaneAIError(error, { operation: "unload", signal });
        if (operationGeneration === this.#operationGeneration) {
          this.#fallbackState = "error";
          this.#error = normalized;
          this.#emit("statechange");
        }
        throw normalized;
      } finally {
        this.#unloadPromise = null;
      }
    })();
    return this.#unloadPromise;
  }

  async chat(request = {}) {
    this.#assertOperational();
    const signal = request.signal ?? null;
    localRequirement(request, this.#provider);
    if (abortLike(null, signal)) {
      throw normalizeArcaneAIError(null, { operation: "request", signal });
    }
    await this.#ready({ ...(request.loadOptions ?? {}), signal });
    const chat = providerMethod(this.#provider, "chat") ?? providerMethod(this.#provider, "use");
    if (!chat) throw new ArcaneAIError("ARCANE_AI_UNAVAILABLE", "The LLM provider cannot chat.");
    try {
      return await chat(request, Object.freeze({
        protocol: ARCANE_AI_ADAPTER_PROTOCOL,
        kind: "llm",
        operation: "chat",
        signal,
      }));
    } catch (error) {
      throw normalizeArcaneAIError(error, { operation: "request", signal });
    }
  }

  stream(request = {}) {
    this.#assertOperational();
    localRequirement(request, this.#provider);
    const controller = this;
    const externalSignal = request.signal ?? null;
    const linked = linkedAbortSignal(externalSignal);
    let opened = null;
    let openError = null;
    let cancelPromise = null;

    const openPromise = (async () => {
      if (linked.controller.signal.aborted) {
        throw normalizeArcaneAIError(null, {
          operation: "request",
          signal: linked.controller.signal,
        });
      }
      await controller.#ready({ ...(request.loadOptions ?? {}), signal: linked.controller.signal });
      const stream = providerMethod(controller.#provider, "stream")
        ?? providerMethod(controller.#provider, "streamChat");
      if (!stream) throw new ArcaneAIError("ARCANE_AI_UNAVAILABLE", "The LLM provider cannot stream.");
      const value = await stream(
        { ...request, signal: linked.controller.signal },
        Object.freeze({
          protocol: ARCANE_AI_ADAPTER_PROTOCOL,
          kind: "llm",
          operation: "stream",
          signal: linked.controller.signal,
        }),
      );
      if (!value || typeof value[Symbol.asyncIterator] !== "function") {
        throw new ArcaneAIError(
          "ARCANE_AI_INVALID_PROVIDER_RESULT",
          "The LLM provider did not return an async stream handle.",
        );
      }
      opened = value;
      return value;
    })().catch((error) => {
      openError = normalizeArcaneAIError(error, {
        operation: "request",
        signal: linked.controller.signal,
      });
      throw openError;
    });
    openPromise.catch(() => undefined);

    const result = openPromise.then((value) => value.result).then((value) => value).finally(() => {
      linked.release();
      controller.#activeStreams.delete(handle);
    });
    result.catch(() => undefined);

    const handle = {
      result,
      async cancel(reason = "The stream was cancelled.") {
        cancelPromise ||= (async () => {
          linked.controller.abort(reason);
          try {
            const value = opened ?? await openPromise;
            await value.cancel?.(reason);
          } catch {
            // result exposes the normalized terminal error.
          }
          try {
            await result;
          } catch {
            // Cancellation is expected to reject result.
          }
          return true;
        })();
        return cancelPromise;
      },
      async next(value) {
        if (openError) throw openError;
        const streamHandle = opened ?? await openPromise;
        return streamHandle.next(value);
      },
      async return(value) {
        await this.cancel("The stream consumer stopped before completion.");
        return { value, done: true };
      },
      async throw(error) {
        await this.cancel(error);
        throw normalizeArcaneAIError(error, { operation: "request" });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    Object.freeze(handle);
    this.#activeStreams.add(handle);
    return handle;
  }

  async fetchRequest(options = {}) {
    this.#assertOperational();
    localRequirement(options, this.#provider);
    const id = requestIdentity(options.id);
    const request = { ...options, id };
    // localOnly admission is complete before app callbacks observe a request.
    fireAndForget(options.onRequest, request, id);
    const response = await this.chat(request);
    if (options.signal?.aborted) {
      throw normalizeArcaneAIError(null, { operation: "request", signal: options.signal });
    }
    if (typeof options.onResponse === "function") {
      await options.onResponse(response, id, false);
    }
    return response;
  }

  async streamRequest(options = {}) {
    this.#assertOperational();
    localRequirement(options, this.#provider);
    const id = requestIdentity(options.id);
    const request = { ...options, id };
    const displayId = displayRequestId(id);
    fireAndForget(options.onRequest, request, id);
    const handle = this.stream(request);
    const announcedTools = new Set();

    try {
      for await (const chunk of handle) {
        if (options.signal?.aborted) break;
        for (const choice of chunk?.choices ?? []) {
          const delta = choice?.delta ?? {};
          if (typeof delta.reasoning_content === "string" && options.seeThinking === true) {
            options.onChunk?.(delta.reasoning_content, displayId, true);
          }
          if (typeof delta.content === "string") {
            options.onChunk?.(delta.content, displayId, false);
          }
          for (const tool of delta.tool_calls ?? []) {
            const name = tool?.function?.name;
            if (typeof name === "string" && name && !announcedTools.has(name)) {
              announcedTools.add(name);
              fireAndForget(options.onToolCall, name);
            }
          }
        }
      }
      const completion = await handle.result;
      if (options.signal?.aborted) {
        throw normalizeArcaneAIError(null, { operation: "request", signal: options.signal });
      }
      const tools = toolRecordFromCompletion(completion);
      const output = tools ?? textFromCompletion(completion);
      if (typeof options.onComplete === "function") {
        await options.onComplete(output, displayId, false);
      }
      return output;
    } catch (error) {
      await handle.cancel(error).catch(() => undefined);
      throw normalizeArcaneAIError(error, { operation: "request", signal: options.signal });
    }
  }

  async probe(options = {}) {
    this.#assertOperational();
    const probe = providerMethod(this.#provider, "probe");
    if (!probe) throw new ArcaneAIError("ARCANE_AI_UNAVAILABLE", "The LLM provider has no WASM probe.");
    try {
      return await probe(options);
    } catch (error) {
      throw normalizeArcaneAIError(error, { operation: "probe", signal: options.signal });
    }
  }

  dispose(options = {}) {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposing = true;
    this.#operationGeneration += 1;
    let resolveOperation;
    let rejectOperation;
    const operation = new Promise((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    this.#disposePromise = operation;
    (async () => {
      try {
        await this.unload(options);
        const dispose = providerMethod(this.#provider, "dispose");
        if (dispose) await dispose(options);
        this.#disposed = true;
        this.#listeners.clear();
        return this.status();
      } catch (error) {
        throw normalizeArcaneAIError(error, {
          operation: "dispose",
          signal: options.signal,
        });
      } finally {
        this.#disposing = false;
      }
    })().then(resolveOperation, rejectOperation);
    operation.catch(() => {
      if (this.#disposePromise === operation) this.#disposePromise = null;
    });
    return operation;
  }
}

export function createModelController(options) {
  return new ModelController(options);
}

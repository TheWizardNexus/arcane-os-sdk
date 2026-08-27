import { createArcaneEventSource } from "arcane-os/event-manager";

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

function invalidStatus(cause) {
  return new ArcaneAIError(
    "ARCANE_AI_PROVIDER_STATUS_INVALID",
    "The LLM provider returned an invalid status record.",
    { cause, operation: "status" },
  );
}

function copyProviderStatus(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw invalidStatus();
  try {
    const copy = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw invalidStatus();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw invalidStatus();
      Object.defineProperty(copy, key, {
        value: descriptor.value,
        enumerable: descriptor.enumerable,
        configurable: true,
        writable: true,
      });
    }
    return copy;
  } catch (error) {
    if (error instanceof ArcaneAIError) throw error;
    throw invalidStatus(error);
  }
}

const MAX_PROGRESS_DEPTH = 8;
const MAX_PROGRESS_ENTRIES = 256;

function invalidProgress(cause) {
  return new ArcaneAIError(
    "ARCANE_AI_PROVIDER_PROGRESS_INVALID",
    "The LLM provider returned an invalid progress record.",
    { cause, operation: "load" },
  );
}

function copyProgressValue(value, state, depth = 0) {
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_PROGRESS_DEPTH || state.seen.has(value)) {
    throw invalidProgress();
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw invalidProgress();
  }
  state.seen.add(value);
  const copy = Array.isArray(value) ? [] : prototype === null ? Object.create(null) : {};
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue;
      state.entries += 1;
      if (state.entries > MAX_PROGRESS_ENTRIES || typeof key !== "string") {
        throw invalidProgress();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw invalidProgress();
      Object.defineProperty(copy, key, {
        value: copyProgressValue(descriptor.value, state, depth + 1),
        enumerable: descriptor.enumerable,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(copy);
  } finally {
    state.seen.delete(value);
  }
}

function copyProgress(progress) {
  if (progress === undefined || progress === null) return null;
  if (typeof progress !== "object" || Array.isArray(progress)) {
    throw invalidProgress();
  }
  try {
    return copyProgressValue(progress, { seen: new WeakSet(), entries: 0 });
  } catch (error) {
    if (error instanceof ArcaneAIError) throw error;
    throw invalidProgress(error);
  }
}

function publicProgress(progress) {
  if (!progress || typeof progress !== "object") return null;
  const file = progress.file && typeof progress.file === "object"
    ? Object.freeze({
      ...(Number.isSafeInteger(progress.file.index) ? { index: progress.file.index } : {}),
      ...(Number.isSafeInteger(progress.file.count) ? { count: progress.file.count } : {}),
      ...(typeof progress.file.name === "string" ? { name: progress.file.name } : {}),
      ...(Number.isSafeInteger(progress.file.loaded) ? { loaded: progress.file.loaded } : {}),
      ...(progress.file.total === null || Number.isSafeInteger(progress.file.total)
        ? { total: progress.file.total }
        : {}),
    })
    : null;
  return Object.freeze({
    ...(typeof progress.modelId === "string" ? { modelId: progress.modelId } : {}),
    ...(typeof progress.phase === "string" ? { phase: progress.phase } : {}),
    ...(Number.isSafeInteger(progress.loaded) ? { loaded: progress.loaded } : {}),
    ...(progress.total === null || Number.isSafeInteger(progress.total)
      ? { total: progress.total }
      : {}),
    ...(progress.percent === null
      || (typeof progress.percent === "number" && Number.isFinite(progress.percent))
      ? { percent: progress.percent }
      : {}),
    ...(file ? { file } : {}),
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
  #events;
  #loadPromise = null;
  #readyPolicyResolved = false;
  #unloadPromise = null;
  #disposePromise = null;
  #operationGeneration = 0;
  #disposing = false;
  #disposed = false;
  #disposeUnloadAdmission = false;
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
    this.#events = createArcaneEventSource(this, {
      source: "ai-model-controller",
      eventTypes: Object.freeze(["statechange", "progress"]),
    });
  }

  status() {
    const providerStatus = copyProviderStatus(
      providerMethod(this.#provider, "status")?.(
        Object.freeze({ security: this.#security }),
      ),
    );
    const progress = copyProgress(providerStatus.progress ?? this.#progress);
    return Object.freeze({
      ...providerStatus,
      kind: "llm",
      state: providerStatus.state ?? this.#fallbackState,
      progress,
      error: copyError(providerStatus.error ?? this.#error),
    });
  }

  addEventListener(type, listener, options) {
    return this.#events.addEventListener(type, listener, options);
  }

  removeEventListener(type, listener, options) {
    return this.#events.removeEventListener(type, listener, options);
  }

  on(type, listener) {
    this.addEventListener(type, listener);
    const controller = this;
    return function unsubscribeModelControllerEvent() {
      controller.removeEventListener(type, listener);
    };
  }

  #emit(type, operationId) {
    const status = this.status();
    const progress = type === "progress" ? publicProgress(status.progress) : null;
    this.#events.dispatch(type, status, {
      operationId,
      publicDetail: Object.freeze({
        ...(typeof status.state === "string" ? { state: status.state } : {}),
        ...(progress ? { progress } : {}),
        ...(typeof status.error?.code === "string" ? { code: status.error.code } : {}),
      }),
    });
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
    const operationId = `${this.#events.instanceId}:load:${operationGeneration.toString(36)}`;
    let resolveOperation;
    let rejectOperation;
    const operation = new Promise(function createModelLoadOperation(resolve, reject) {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    this.#loadPromise = operation;
    if (!wasReady) {
      this.#fallbackState = "loading";
      this.#progress = null;
      this.#error = null;
      this.#emit("statechange", operationId);
    }
    const controller = this;
    function reportModelLoadProgress(progress) {
      if (
        operationGeneration !== controller.#operationGeneration
        || controller.#disposing
        || controller.#disposed
      ) return;
      controller.#progress = copyProgress(progress);
      controller.#emit("progress", operationId);
    }
    async function executeModelLoad() {
      try {
        await load(options, Object.freeze({
          protocol: ARCANE_AI_ADAPTER_PROTOCOL,
          kind: "llm",
          operation: "load",
          signal,
          security: controller.#security,
          reportProgress: reportModelLoadProgress,
        }));
        if (
          operationGeneration !== controller.#operationGeneration
          || controller.#disposing
          || controller.#disposed
        ) return controller.status();
        controller.#readyPolicyResolved = true;
        if (!wasReady) {
          controller.#fallbackState = "ready";
          controller.#progress = null;
          controller.#emit("statechange", operationId);
        }
        return controller.status();
      } catch (error) {
        const normalized = normalizeArcaneAIError(error, { operation: "load", signal });
        if (
          operationGeneration === controller.#operationGeneration
          && !controller.#disposing
          && !controller.#disposed
          && !wasReady
        ) {
          controller.#fallbackState = "error";
          controller.#error = normalized;
          controller.#emit("statechange", operationId);
        }
        throw normalized;
      } finally {
        if (controller.#loadPromise === operation) controller.#loadPromise = null;
      }
    }
    void executeModelLoad().then(resolveOperation, rejectOperation);
    return operation;
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
    if ((this.#disposed || this.#disposing) && !this.#disposeUnloadAdmission) {
      this.#assertOperational();
    }
    if (this.#unloadPromise) return this.#unloadPromise;
    const unload = providerMethod(this.#provider, "unload");
    if (!unload) throw new ArcaneAIError("ARCANE_AI_UNAVAILABLE", "The LLM provider cannot unload.");
    const signal = options.signal ?? null;
    const inFlightLoad = this.#loadPromise;
    const operationGeneration = ++this.#operationGeneration;
    const operationId = `${this.#events.instanceId}:unload:${operationGeneration.toString(36)}`;
    const context = Object.freeze({
      protocol: ARCANE_AI_ADAPTER_PROTOCOL,
      kind: "llm",
      operation: "unload",
      signal,
    });
    let resolveOperation;
    let rejectOperation;
    const operation = new Promise(function createModelUnloadOperation(resolve, reject) {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    this.#unloadPromise = operation;
    this.#fallbackState = "unloading";
    this.#emit("statechange", operationId);
    const controller = this;
    async function executeModelUnload() {
      try {
        await controller.#closeStreams("The browser-WASM model is unloading.");
        // The first call asks the provider to cancel its in-flight load. A
        // provider owns its public status, so wait for the captured load and
        // reassert unload afterward; a late provider-owned `ready` state can
        // otherwise outlive this controller's generation guard.
        await unload(options, context);
        if (inFlightLoad) {
          await inFlightLoad.catch(function ignoreSupersededModelLoad() {});
          await unload(options, context);
        }
        if (operationGeneration === controller.#operationGeneration) {
          controller.#fallbackState = "unloaded";
          controller.#readyPolicyResolved = false;
          controller.#progress = null;
          controller.#error = null;
          controller.#emit("statechange", operationId);
        }
        return controller.status();
      } catch (error) {
        const normalized = normalizeArcaneAIError(error, { operation: "unload", signal });
        if (operationGeneration === controller.#operationGeneration) {
          controller.#fallbackState = "error";
          controller.#error = normalized;
          controller.#emit("statechange", operationId);
        }
        throw normalized;
      } finally {
        if (controller.#unloadPromise === operation) controller.#unloadPromise = null;
      }
    }
    void executeModelUnload().then(resolveOperation, rejectOperation);
    return operation;
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
    const operation = new Promise(function createModelDisposeOperation(resolve, reject) {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    this.#disposePromise = operation;
    const controller = this;
    async function executeModelDispose() {
      try {
        let unloadOperation;
        try {
          controller.#disposeUnloadAdmission = true;
          unloadOperation = controller.unload(options);
        } finally {
          controller.#disposeUnloadAdmission = false;
        }
        await unloadOperation;
        const dispose = providerMethod(controller.#provider, "dispose");
        if (dispose) await dispose(options);
        controller.#disposed = true;
        const status = controller.status();
        controller.#events.dispose();
        return status;
      } catch (error) {
        throw normalizeArcaneAIError(error, {
          operation: "dispose",
          signal: options.signal,
        });
      } finally {
        controller.#disposing = false;
      }
    }
    void executeModelDispose().then(resolveOperation, rejectOperation);
    operation.catch(function resetFailedModelDispose() {
      if (controller.#disposePromise === operation) controller.#disposePromise = null;
    });
    return operation;
  }
}

export function createModelController(options) {
  return new ModelController(options);
}

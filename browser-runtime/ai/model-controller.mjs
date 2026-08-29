import { createArcaneEventSource } from "arcane-os/event-manager";

export const ARCANE_AI_ADAPTER_PROTOCOL = "arcane-ai-adapter/1";

const MODEL_CONTROLLER_EVENT_TYPES = ["statechange", "progress"];
const MODEL_CONTROLLER_EVENT_TYPE_SET = new Set(MODEL_CONTROLLER_EVENT_TYPES);

export function normalizeModelSecurity(value, label = "security") {
  void label;
  return value?.secure === true ? { secure: true } : undefined;
}

export function resolveModelSecurity({ app, binding, load } = {}) {
  const scopes = [app, binding, load];
  let secure = false;
  for (const scope of scopes) {
    if (scope?.secure === true) secure = true;
    else if (scope?.secure === false) secure = false;
  }
  if (!secure) return undefined;
  // Secure mode currently carries activation intent only. Security checks remain
  // disabled and must be reviewed with the user before any implementation runs.
  return { secure: true };
}

export function sameModelSecurity(left, right) {
  return (left?.secure === true) === (right?.secure === true);
}

const ERROR_CODES = {
  load: "ARCANE_AI_LOAD_FAILED",
  unload: "ARCANE_AI_UNLOAD_FAILED",
  request: "ARCANE_AI_REQUEST_FAILED",
  dispose: "ARCANE_AI_DISPOSE_FAILED",
  probe: "ARCANE_AI_PROBE_FAILED",
};

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

function invalidStatus(cause) {
  return new ArcaneAIError(
    "ARCANE_AI_PROVIDER_STATUS_INVALID",
    "The LLM provider returned an invalid status record.",
    { cause, operation: "status" },
  );
}

function copyError(error) {
  if (!error) return null;
  let code;
  let message;
  if (typeof error === "object" || typeof error === "function") {
    try {
      const codeDescriptor = Object.getOwnPropertyDescriptor(error, "code");
      const messageDescriptor = Object.getOwnPropertyDescriptor(error, "message");
      if ((codeDescriptor && !("value" in codeDescriptor))
        || (messageDescriptor && !("value" in messageDescriptor))) {
        throw invalidStatus();
      }
      code = codeDescriptor?.value;
      message = messageDescriptor?.value;
    } catch (copyErrorFailure) {
      if (copyErrorFailure instanceof ArcaneAIError) throw copyErrorFailure;
      throw invalidStatus(copyErrorFailure);
    }
  }
  return {
    code: String(code ?? "ARCANE_AI_REQUEST_FAILED"),
    message: String(message ?? "The Arcane AI operation failed."),
  };
}

function isModelControllerListener(value) {
  return typeof value === "function"
    || Boolean(value && typeof value === "object" && typeof value.handleEvent === "function");
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

function invalidProgress(cause) {
  return new ArcaneAIError(
    "ARCANE_AI_PROVIDER_PROGRESS_INVALID",
    "The LLM provider returned an invalid progress record.",
    { cause, operation: "load" },
  );
}

function copyProgressValue(value, state) {
  if (value === null || typeof value !== "object") return value;
  if (state.seen.has(value)) {
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
      if (typeof key !== "string") {
        throw invalidProgress();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw invalidProgress();
      Object.defineProperty(copy, key, {
        value: copyProgressValue(descriptor.value, state),
        enumerable: descriptor.enumerable,
        configurable: true,
        writable: true,
      });
    }
    return copy;
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
    return copyProgressValue(progress, { seen: new WeakSet() });
  } catch (error) {
    if (error instanceof ArcaneAIError) throw error;
    throw invalidProgress(error);
  }
}

function publicProgress(progress) {
  return progress && typeof progress === "object" ? copyProgress(progress) : null;
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
  return {
    controller,
    release: () => externalSignal?.removeEventListener?.("abort", forward),
  };
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

function completeTextValue(value, seen, location) {
  if (value === null) return null;
  if (value === undefined) return { $type: "undefined" };
  if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
  if (typeof value === "number" && !Number.isFinite(value)) {
    return { $type: "number", value: String(value) };
  }
  if (typeof value === "symbol") return { $type: "symbol", value: String(value) };
  if (typeof value === "function") {
    return { $type: "function", value: Function.prototype.toString.call(value) };
  }
  if (typeof value !== "object") return value;
  if (seen.has(value)) return { $ref: seen.get(value) };
  seen.set(value, location);
  if (value instanceof Date) return { $type: "date", value: value.toISOString() };
  if (value instanceof RegExp) return { $type: "regexp", value: String(value) };
  if (value instanceof Map) {
    return {
      $type: "map",
      entries: [...value.entries()].map(([key, entry], index) => [
        completeTextValue(key, seen, `${location}.entries[${index}].key`),
        completeTextValue(entry, seen, `${location}.entries[${index}].value`),
      ]),
    };
  }
  if (value instanceof Set) {
    return {
      $type: "set",
      values: [...value].map((entry, index) => completeTextValue(
        entry,
        seen,
        `${location}.values[${index}]`,
      )),
    };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      $type: value.constructor?.name ?? "ArrayBufferView",
      values: Array.from(
        value instanceof DataView
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : value,
        (entry, index) => completeTextValue(entry, seen, `${location}.values[${index}]`),
      ),
    };
  }
  if (value instanceof ArrayBuffer) {
    return { $type: "ArrayBuffer", values: Array.from(new Uint8Array(value)) };
  }
  const copy = Array.isArray(value) ? [] : {};
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const renderedKey = typeof key === "symbol" ? `[${String(key)}]` : key;
    copy[renderedKey] = descriptor && "value" in descriptor
      ? completeTextValue(descriptor.value, seen, `${location}.${renderedKey}`)
      : {
        $type: "accessor",
        get: Boolean(descriptor?.get),
        set: Boolean(descriptor?.set),
      };
  }
  return copy;
}

export function completeValueText(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(completeTextValue(value, new WeakMap(), "$"), null, 2);
}

function textFromCompletion(completion) {
  if (!Array.isArray(completion?.choices)) return completeValueText(completion);
  return completion.choices.map((choice) => {
    const content = choice?.message?.content;
    return content === undefined ? completeValueText(choice) : completeValueText(content);
  }).join("\n");
}

function structuralToolCall(call,location){
  if(
    !call
    ||typeof call!=="object"
    ||Array.isArray(call)
    ||call.type!=="function"
    ||typeof call.id!=="string"
    ||!call.id.trim()
    ||!call.function
    ||typeof call.function!=="object"
    ||Array.isArray(call.function)
    ||typeof call.function.name!=="string"
    ||!call.function.name.trim()
    ||typeof call.function.arguments!=="string"
  ){
    throw new ArcaneAIError(
      "ARCANE_AI_TOOL_CALL_INVALID",
      `${location} is not a complete structural function call.`,
      {operation:"request"},
    );
  }
  let argumentsRecord;
  try{
    argumentsRecord=JSON.parse(call.function.arguments);
  }catch(error){
    throw new ArcaneAIError(
      "ARCANE_AI_TOOL_CALL_INVALID",
      `${location} arguments must encode a JSON object.`,
      {cause:error,operation:"request"},
    );
  }
  if(
    !argumentsRecord
    ||typeof argumentsRecord!=="object"
    ||Array.isArray(argumentsRecord)
  ){
    throw new ArcaneAIError(
      "ARCANE_AI_TOOL_CALL_INVALID",
      `${location} arguments must encode a JSON object.`,
      {operation:"request"},
    );
  }
  if(typeof argumentsRecord.message!=="string"||!argumentsRecord.message.trim()){
    throw new ArcaneAIError(
      "ARCANE_AI_TOOL_MESSAGE_REQUIRED",
      `${location} arguments must include a nonempty user-facing message.`,
      {operation:"request"},
    );
  }
  return {
    id:call.id,
    type:"function",
    function:{
      name:call.function.name,
      arguments:call.function.arguments,
    },
  };
}

function plainStructuralRecord(value){
  if(!value||typeof value!=="object"||Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}

function requireToolMessageSchemas(value,location){
  if(value===undefined) return;
  if(!Array.isArray(value)){
    throw new ArcaneAIError(
      "ARCANE_AI_TOOL_CALL_INVALID",
      `${location} must be an array.`,
      {operation:"request"},
    );
  }
  for(const [index,tool] of value.entries()){
    const parameters=tool?.function?.parameters;
    const messageSchema=parameters?.properties?.message;
    if(
      !plainStructuralRecord(tool)
      ||tool.type!=="function"
      ||!plainStructuralRecord(tool.function)
      ||!plainStructuralRecord(parameters)
      ||parameters.type!=="object"
      ||!plainStructuralRecord(parameters.properties)
      ||!plainStructuralRecord(messageSchema)
      ||messageSchema.type!=="string"
      ||!Number.isInteger(messageSchema.minLength)
      ||messageSchema.minLength<1
      ||!Array.isArray(parameters.required)
      ||!parameters.required.includes("message")
    ){
      throw new ArcaneAIError(
        "ARCANE_AI_TOOL_MESSAGE_REQUIRED",
        `${location}[${String(index)}] must require a nonempty string parameters.properties.message.`,
        {operation:"request"},
      );
    }
  }
}

function structuralCallsFromMessage(message,location){
  if(!plainStructuralRecord(message)){
    throw new ArcaneAIError(
      "ARCANE_AI_TOOL_CALL_INVALID",
      `${location} must be a plain message object.`,
      {operation:"request"},
    );
  }
  if(
    Object.hasOwn(message,"toolCalls")
    ||Object.hasOwn(message,"tool_call")
    ||Object.hasOwn(message,"toolCall")
    ||Object.hasOwn(message,"function_call")
    ||Object.hasOwn(message,"functionCall")
  ){
    throw new ArcaneAIError(
      "ARCANE_AI_TOOL_CALL_INVALID",
      `${location} contains a noncanonical structural tool-call field.`,
      {operation:"request"},
    );
  }
  if(!Object.hasOwn(message,"tool_calls"))return [];
  const descriptor=Object.getOwnPropertyDescriptor(message,"tool_calls");
  if(
    !descriptor
    ||!Object.hasOwn(descriptor,"value")
    ||!Array.isArray(descriptor.value)
  ){
    throw new ArcaneAIError(
      "ARCANE_AI_TOOL_CALL_INVALID",
      `${location}.tool_calls must be an array data property.`,
      {operation:"request"},
    );
  }
  return descriptor.value;
}

function structuralRequest(value){
  if(!plainStructuralRecord(value)){
    throw new TypeError("AI request options must be a plain object.");
  }
  if(value.messages!==undefined&&!Array.isArray(value.messages)){
    throw new TypeError("AI request messages must be an array.");
  }
  requireToolMessageSchemas(value.tools,"AI request tools");
  if(value.parallelToolCalls===true||value.parallel_tool_calls===true){
    throw new ArcaneAIError(
      "ARCANE_AI_PARALLEL_TOOLS_UNSUPPORTED",
      "The Arcane chat session accepts one structural tool call at a time.",
      {operation:"request"},
    );
  }

  let pendingToolCallId=null;
  for(const [messageIndex,message] of (value.messages??[]).entries()){
    const calls=structuralCallsFromMessage(
      message,
      `AI request messages[${String(messageIndex)}]`,
    );
    let openedToolCall=false;
    if(Object.hasOwn(message,"tool_calls")){
      if(message?.role!=="assistant"||!Array.isArray(calls)){
        throw new ArcaneAIError(
          "ARCANE_AI_TOOL_CALL_INVALID",
          `AI request messages[${String(messageIndex)}].tool_calls is invalid.`,
          {operation:"request"},
        );
      }
      if(calls.length>1||pendingToolCallId!==null&&calls.length){
        throw new ArcaneAIError(
          "ARCANE_AI_PARALLEL_TOOLS_UNSUPPORTED",
          "The Arcane chat session accepts one structural tool call at a time.",
          {operation:"request"},
        );
      }
      if(calls.length){
        pendingToolCallId=structuralToolCall(
          calls[0],
          `AI request messages[${String(messageIndex)}].tool_calls[0]`,
        ).id;
        openedToolCall=true;
      }
    }
    if(message?.role==="tool"){
      if(
        typeof message.content!=="string"
        ||!message.content.trim()
      ){
        throw new ArcaneAIError(
          "ARCANE_AI_INVALID_TOOL_MESSAGE",
          `AI request messages[${String(messageIndex)}] must contain a nonblank user-facing tool result.`,
          {operation:"request"},
        );
      }
      if(
        pendingToolCallId===null
        ||typeof message.tool_call_id!=="string"
        ||message.tool_call_id!==pendingToolCallId
      ){
        throw new ArcaneAIError(
          "ARCANE_AI_INVALID_TOOL_MESSAGE",
          `AI request messages[${String(messageIndex)}] does not settle the pending structural tool call.`,
          {operation:"request"},
        );
      }
      pendingToolCallId=null;
    }else if(pendingToolCallId!==null&&!openedToolCall){
      throw new ArcaneAIError(
        "ARCANE_AI_TOOL_RESULT_REQUIRED",
        `AI request messages[${String(messageIndex)}] precedes the pending structural tool result.`,
        {operation:"request"},
      );
    }
  }
  if(pendingToolCallId!==null){
    throw new ArcaneAIError(
      "ARCANE_AI_TOOL_RESULT_REQUIRED",
      "The pending structural tool call must be settled before requesting another response.",
      {operation:"request"},
    );
  }

  return {
    ...value,
    ...(value.tools?.length
      &&value.parallelToolCalls===undefined
      &&value.parallel_tool_calls===undefined
      ?{parallelToolCalls:false}
      :{}),
  };
}

function toolRecordFromCompletion(completion) {
  if(typeof completion==="string")return null;
  if(!plainStructuralRecord(completion)){
    throw new ArcaneAIError(
      "ARCANE_AI_INVALID_PROVIDER_RESULT",
      "The model returned neither text nor a structured completion.",
      {operation:"request"},
    );
  }
  const hasMessage=Object.hasOwn(completion,"message");
  const hasChoices=Object.hasOwn(completion,"choices");
  if(hasMessage===hasChoices){
    throw new ArcaneAIError(
      "ARCANE_AI_INVALID_PROVIDER_RESULT",
      "The model completion must contain exactly one message or choices envelope.",
      {operation:"request"},
    );
  }
  const result = [];
  const messages=[];
  if(hasMessage){
    const descriptor=Object.getOwnPropertyDescriptor(completion,"message");
    if(
      !descriptor
      ||!Object.hasOwn(descriptor,"value")
      ||!plainStructuralRecord(descriptor.value)
      ||descriptor.value.role!=="assistant"
    ){
      throw new ArcaneAIError(
        "ARCANE_AI_INVALID_PROVIDER_RESULT",
        "The model completion message must be an assistant message data property.",
        {operation:"request"},
      );
    }
    messages.push(descriptor.value);
  }else{
    const descriptor=Object.getOwnPropertyDescriptor(completion,"choices");
    if(
      !descriptor
      ||!Object.hasOwn(descriptor,"value")
      ||!Array.isArray(descriptor.value)
      ||!descriptor.value.length
    ){
      throw new ArcaneAIError(
        "ARCANE_AI_INVALID_PROVIDER_RESULT",
        "The model completion choices envelope must be a nonempty array data property.",
        {operation:"request"},
      );
    }
    const indexes=new Set();
    for(const [choiceIndex,choice] of descriptor.value.entries()){
      const messageDescriptor=plainStructuralRecord(choice)
        ?Object.getOwnPropertyDescriptor(choice,"message")
        :null;
      if(
        !plainStructuralRecord(choice)
        ||!Number.isSafeInteger(choice.index)
        ||choice.index<0
        ||indexes.has(choice.index)
        ||!messageDescriptor
        ||!Object.hasOwn(messageDescriptor,"value")
        ||!plainStructuralRecord(messageDescriptor.value)
        ||messageDescriptor.value.role!=="assistant"
      ){
        throw new ArcaneAIError(
          "ARCANE_AI_INVALID_PROVIDER_RESULT",
          `The model completion choice ${String(choiceIndex)} is invalid.`,
          {operation:"request"},
        );
      }
      indexes.add(choice.index);
      messages.push(messageDescriptor.value);
    }
  }
  for (let messageIndex=0;messageIndex<messages.length;messageIndex+=1) {
    const calls=structuralCallsFromMessage(
      messages[messageIndex],
      `Structural tool call message ${String(messageIndex+1)}`,
    );
    if(messageIndex>0&&calls?.length){
      throw new ArcaneAIError(
        "ARCANE_AI_INVALID_PROVIDER_RESULT",
        "The model placed a structural tool call outside the selected first choice.",
        {operation:"request"},
      );
    }
    for (const [callIndex,call] of (calls ?? []).entries()) {
      result.push(structuralToolCall(
        call,
        `Structural tool call ${String(messageIndex+1)}.${String(callIndex+1)}`,
      ));
    }
  }
  if(result.length>1){
    throw new ArcaneAIError(
      "ARCANE_AI_PARALLEL_TOOLS_UNSUPPORTED",
      "The Arcane chat session accepts one structural tool call at a time.",
      {operation:"request"},
    );
  }
  return result.length ? result : null;
}

function isPublicStreamContentKey(key){
  return key==="content"
    ||key==="text"
    ||key==="thinking"
    ||key==="reasoning"
    ||key==="reasoning_content";
}

function projectPublicStreamContent(value,seen=new WeakSet()){
  if(!value||typeof value!=="object"||seen.has(value))return null;
  seen.add(value);
  if(Array.isArray(value)){
    const result=[];
    for(const item of value){
      const projected=projectPublicStreamContent(item,seen);
      if(projected!==null)result.push(projected);
    }
    seen.delete(value);
    return result.length?result:null;
  }
  if(!plainStructuralRecord(value)){
    seen.delete(value);
    return null;
  }
  const result={};
  for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))){
    if(!Object.hasOwn(descriptor,"value"))continue;
    if(
      isPublicStreamContentKey(key)
      &&descriptor.value!==null
      &&descriptor.value!==undefined
    ){
      result[key]=descriptor.value;
      continue;
    }
    const projected=projectPublicStreamContent(descriptor.value,seen);
    if(projected!==null)result[key]=projected;
  }
  seen.delete(value);
  return Object.keys(result).length?result:null;
}

function projectPublicStreamChunk(value){
  if(typeof value==="string")return value;
  return projectPublicStreamContent(value);
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
      eventTypes: MODEL_CONTROLLER_EVENT_TYPES,
    });
  }

  status() {
    const providerStatus = copyProviderStatus(
      providerMethod(this.#provider, "status")?.({}),
    );
    delete providerStatus.security;
    const progress = copyProgress(providerStatus.progress ?? this.#progress);
    return {
      ...providerStatus,
      kind: "llm",
      state: providerStatus.state ?? this.#fallbackState,
      progress,
      error: copyError(providerStatus.error ?? this.#error),
      ...(this.#security ? { security: { secure: true } } : {}),
    };
  }

  addEventListener(type, listener, options) {
    if (!MODEL_CONTROLLER_EVENT_TYPE_SET.has(type) || !isModelControllerListener(listener)) return;
    return this.#events.addEventListener(type, listener, options);
  }

  removeEventListener(type, listener, options) {
    if (!MODEL_CONTROLLER_EVENT_TYPE_SET.has(type) || !isModelControllerListener(listener)) return;
    return this.#events.removeEventListener(type, listener, options);
  }

  on(type, listener) {
    this.addEventListener(type, listener);
    const controller = this;
    let active = true;
    function unsubscribeModelControllerEvent() {
      if (!active) return false;
      active = false;
      controller.removeEventListener(type, listener);
      return true;
    }
    Object.defineProperty(unsubscribeModelControllerEvent, "dispose", {
      value: unsubscribeModelControllerEvent,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return unsubscribeModelControllerEvent;
  }

  #emit(type, operationId) {
    const status = this.status();
    const progress = type === "progress" ? publicProgress(status.progress) : null;
    this.#events.dispatch(type, status, {
      operationId,
      publicDetail: {
        ...(typeof status.state === "string" ? { state: status.state } : {}),
        ...(progress ? { progress } : {}),
        ...(typeof status.error?.code === "string" ? { code: status.error.code } : {}),
      },
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
    this.#security = resolveModelSecurity({
      app: this.#security,
      load: options.security,
    });
    const loadOptions = { ...options };
    delete loadOptions.security;
    // `secure: true` is an activation-intent seam only. Existing security
    // implementations remain disabled until they are reviewed with the user.
    const explicitLoadConfiguration=Object.keys(options).some(
      key=>!['signal','security'].includes(key)
    );
    const loadMustResolve = explicitLoadConfiguration;
    if (state === "ready" && !loadMustResolve) return this.status();
    if (this.#loadPromise) {
      if (!loadMustResolve) return this.#loadPromise;
      try {
        await load(loadOptions, {
          protocol: ARCANE_AI_ADAPTER_PROTOCOL,
          kind: "llm",
          operation: "load",
          signal,
        });
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
        await load(loadOptions, {
          protocol: ARCANE_AI_ADAPTER_PROTOCOL,
          kind: "llm",
          operation: "load",
          signal,
          reportProgress: reportModelLoadProgress,
        });
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
    const context = {
      protocol: ARCANE_AI_ADAPTER_PROTOCOL,
      kind: "llm",
      operation: "unload",
      signal,
    };
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
    request=structuralRequest(request);
    const signal = request.signal ?? null;
    localRequirement(request, this.#provider);
    if (abortLike(null, signal)) {
      throw normalizeArcaneAIError(null, { operation: "request", signal });
    }
    await this.#ready({ ...(request.loadOptions ?? {}), signal });
    const chat = providerMethod(this.#provider, "chat") ?? providerMethod(this.#provider, "use");
    if (!chat) throw new ArcaneAIError("ARCANE_AI_UNAVAILABLE", "The LLM provider cannot chat.");
    try {
      const response=await chat(request, {
        protocol: ARCANE_AI_ADAPTER_PROTOCOL,
        kind: "llm",
        operation: "chat",
        signal,
      });
      toolRecordFromCompletion(response);
      return response;
    } catch (error) {
      throw normalizeArcaneAIError(error, { operation: "request", signal });
    }
  }

  stream(request = {}) {
    this.#assertOperational();
    request=structuralRequest(request);
    localRequirement(request, this.#provider);
    const controller = this;
    const externalSignal = request.signal ?? null;
    const linked = linkedAbortSignal(externalSignal);
    let opened = null;
    let openedIterator = null;
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
        {
          protocol: ARCANE_AI_ADAPTER_PROTOCOL,
          kind: "llm",
          operation: "stream",
          signal: linked.controller.signal,
        },
      );
      if (
        !value
        ||typeof value[Symbol.asyncIterator]!=="function"
        ||typeof value.cancel!=="function"
        ||!value.result
        ||typeof value.result.then!=="function"
      ) {
        if(typeof value?.cancel==="function"){
          Promise.resolve().then(()=>value.cancel(
            "The provider returned an invalid stream handle.",
          )).catch(function reportInvalidModelStreamCleanupFailure(error){
            console.error("Arcane invalid model stream cleanup failed.",error);
          });
        }
        throw new ArcaneAIError(
          "ARCANE_AI_INVALID_PROVIDER_RESULT",
          "The LLM provider did not return an async stream handle with result and cancel().",
        );
      }
      let iterator;
      try{
        iterator=value[Symbol.asyncIterator]();
      }catch(error){
        Promise.resolve().then(()=>value.cancel(error)).catch(
          function reportRejectedModelIteratorCleanupFailure(cleanupError){
            console.error("Arcane rejected model stream iterator cleanup failed.",cleanupError);
          },
        );
        throw error;
      }
      if(!iterator||typeof iterator.next!=="function"){
        Promise.resolve().then(()=>value.cancel(
          "The provider returned an invalid stream iterator.",
        )).catch(function reportInvalidModelIteratorCleanupFailure(error){
          console.error("Arcane invalid model stream iterator cleanup failed.",error);
        });
        throw new ArcaneAIError(
          "ARCANE_AI_INVALID_PROVIDER_RESULT",
          "The LLM provider stream iterator has no next() method.",
        );
      }
      opened = value;
      openedIterator=iterator;
      return value;
    })().catch((error) => {
      openError = normalizeArcaneAIError(error, {
        operation: "request",
        signal: linked.controller.signal,
      });
      throw openError;
    });
    openPromise.catch(() => undefined);

    const result = openPromise.then((value) => value.result).then((value) => {
      toolRecordFromCompletion(value);
      return value;
    }).finally(() => {
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
          } catch (error) {
            console.error("Arcane model provider cancellation failed.",error);
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
        if(!opened)await openPromise;
        const streamIterator=openedIterator;
        let nextValue=value;
        while(true){
          const next=await streamIterator.next(nextValue);
          nextValue=undefined;
          if(next.done)return {value:undefined,done:true};
          const projected=projectPublicStreamChunk(next.value);
          if(projected!==null)return {value:projected,done:false};
        }
      },
      async return(value) {
        Promise.resolve().then(()=>this.cancel(
          "The stream consumer stopped before completion.",
        )).catch(function reportModelStreamReturnCancellationFailure(error){
          console.error("Arcane model stream early-return cancellation failed.",error);
        });
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
    this.#activeStreams.add(handle);
    return handle;
  }

  async fetchRequest(options = {}) {
    this.#assertOperational();
    localRequirement(options, this.#provider);
    const id = requestIdentity(options.id);
    const request = structuralRequest({ ...options, id });
    // localOnly admission is complete before app callbacks observe a request.
    fireAndForget(options.onRequest, request, id);
    const response = await this.chat(request);
    if (options.signal?.aborted) {
      throw normalizeArcaneAIError(null, { operation: "request", signal: options.signal });
    }
    toolRecordFromCompletion(response);
    if (typeof options.onResponse === "function") {
      await options.onResponse(response, id, false);
    }
    return response;
  }

  async streamRequest(options = {}) {
    this.#assertOperational();
    localRequirement(options, this.#provider);
    const id = requestIdentity(options.id);
    const request = structuralRequest({ ...options, id });
    const displayId = displayRequestId(id);
    fireAndForget(options.onRequest, request, id);
    const handle = this.stream(request);

    try {
      for await (const chunk of handle) {
        if (options.signal?.aborted) break;
        for (const choice of chunk?.choices ?? []) {
          const delta = choice?.delta ?? {};
          if (typeof delta.reasoning_content === "string" && options.seeThinking === true) {
            await options.onChunk?.(delta.reasoning_content, displayId, true);
          }
          if (typeof delta.content === "string") {
            await options.onChunk?.(delta.content, displayId, false);
          }
        }
      }
      const completion = await handle.result;
      if (options.signal?.aborted) {
        throw normalizeArcaneAIError(null, { operation: "request", signal: options.signal });
      }
      const tools = toolRecordFromCompletion(completion);
      if (typeof options.onResponse === "function") {
        await options.onResponse(completion, id, false);
      }
      for (const call of tools ?? []) {
        await options.onToolCall?.(call, displayId);
      }
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

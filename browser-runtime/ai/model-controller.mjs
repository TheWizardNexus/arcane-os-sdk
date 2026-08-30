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
  if(completion.choices.length>1)return completeValueText(completion);
  const choice=completion.choices[0];
  const content=choice?.message?.content;
  return content===undefined?completeValueText(choice):completeValueText(content);
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
    ...call,
    id:call.id,
    type:"function",
    function:{
      ...call.function,
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
  for(const key of ["parallelToolCalls","parallel_tool_calls"]){
    if(Object.hasOwn(value,key)&&typeof value[key]!=="boolean"){
      throw new TypeError(`AI request ${key} must be a boolean when provided.`);
    }
  }

  const pendingToolCallIds=new Set();
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
      if(pendingToolCallIds.size&&calls.length){
        throw new ArcaneAIError(
          "ARCANE_AI_TOOL_RESULT_REQUIRED",
          "Every pending structural tool result must be supplied before another assistant tool-call sequence.",
          {operation:"request"},
        );
      }
      if(calls.length){
        for(const [callIndex,call] of calls.entries()){
          const normalized=structuralToolCall(
            call,
            `AI request messages[${String(messageIndex)}].tool_calls[${String(callIndex)}]`,
          );
          if(pendingToolCallIds.has(normalized.id)){
            throw new ArcaneAIError(
              "ARCANE_AI_TOOL_CALL_INVALID",
              `AI request messages[${String(messageIndex)}].tool_calls contains a duplicate ID.`,
              {operation:"request"},
            );
          }
          pendingToolCallIds.add(normalized.id);
        }
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
        !pendingToolCallIds.size
        ||typeof message.tool_call_id!=="string"
        ||!pendingToolCallIds.has(message.tool_call_id)
      ){
        throw new ArcaneAIError(
          "ARCANE_AI_INVALID_TOOL_MESSAGE",
          `AI request messages[${String(messageIndex)}] does not settle the pending structural tool call.`,
          {operation:"request"},
        );
      }
      pendingToolCallIds.delete(message.tool_call_id);
    }else if(pendingToolCallIds.size&&!openedToolCall){
      throw new ArcaneAIError(
        "ARCANE_AI_TOOL_RESULT_REQUIRED",
        `AI request messages[${String(messageIndex)}] precedes the pending structural tool result.`,
        {operation:"request"},
      );
    }
  }
  if(pendingToolCallIds.size){
    throw new ArcaneAIError(
      "ARCANE_AI_TOOL_RESULT_REQUIRED",
      "The pending structural tool call must be settled before requesting another response.",
      {operation:"request"},
    );
  }

  return {...value};
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
    const toolCallIds=new Set();
    const calls=structuralCallsFromMessage(
      messages[messageIndex],
      `Structural tool call message ${String(messageIndex+1)}`,
    );
    for (const [callIndex,call] of (calls ?? []).entries()) {
      const normalized=structuralToolCall(
        call,
        `Structural tool call ${String(messageIndex+1)}.${String(callIndex+1)}`,
      );
      if(toolCallIds.has(normalized.id)){
        throw new ArcaneAIError(
          "ARCANE_AI_TOOL_CALL_INVALID",
          "The model completion contains a duplicate structural tool-call ID.",
          {operation:"request"},
        );
      }
      toolCallIds.add(normalized.id);
      if(messageIndex===0)result.push(normalized);
    }
  }
  return result.length ? result : null;
}

function sameStreamedToolCalls(left,right){
  return left.length===right.length&&left.every((call,index)=>{
    const other=right[index];
    return call?.id===other?.id
      &&call?.type===other?.type
      &&call?.function?.name===other?.function?.name
      &&call?.function?.arguments===other?.function?.arguments;
  });
}

function sameCompleteStreamValue(left,right,leftToRight=new Map(),rightToLeft=new Map()){
  if(Object.is(left,right))return true;
  if(
    !left
    ||!right
    ||typeof left!=="object"
    ||typeof right!=="object"
    ||Array.isArray(left)!==Array.isArray(right)
  )return false;
  if(leftToRight.has(left)||rightToLeft.has(right)){
    return leftToRight.get(left)===right&&rightToLeft.get(right)===left;
  }
  leftToRight.set(left,right);
  rightToLeft.set(right,left);
  const leftKeys=Reflect.ownKeys(left);
  const rightKeys=Reflect.ownKeys(right);
  if(leftKeys.length!==rightKeys.length)return false;
  for(const key of leftKeys){
    if(!Object.hasOwn(right,key))return false;
    const leftDescriptor=Object.getOwnPropertyDescriptor(left,key);
    const rightDescriptor=Object.getOwnPropertyDescriptor(right,key);
    const leftIsData=Boolean(leftDescriptor&&Object.hasOwn(leftDescriptor,"value"));
    const rightIsData=Boolean(rightDescriptor&&Object.hasOwn(rightDescriptor,"value"));
    if(leftIsData!==rightIsData)return false;
    if(leftIsData){
      if(!sameCompleteStreamValue(
        leftDescriptor.value,
        rightDescriptor.value,
        leftToRight,
        rightToLeft,
      ))return false;
    }else if(
      leftDescriptor?.get!==rightDescriptor?.get
      ||leftDescriptor?.set!==rightDescriptor?.set
    )return false;
  }
  return true;
}

function createStreamedToolCallAccumulator(){
  const directChoice=Symbol("direct-stream-choice");
  const choices=new Map();

  function mismatch(message){
    return new ArcaneAIError(
      "ARCANE_AI_TOOL_CALL_INVALID",
      message,
      {operation:"request"},
    );
  }

  function structuralRecord(value){
    return plainStructuralRecord(value)&&[
      "tool_calls",
      "toolCalls",
      "tool_call",
      "toolCall",
      "function_call",
      "functionCall",
    ].some((key)=>Object.hasOwn(value,key));
  }

  function choiceState(key){
    let state=choices.get(key);
    if(!state){
      state={
        completeCalls:null,
        fragments:new Map(),
        sawFragments:false,
      };
      choices.set(key,state);
    }
    return state;
  }

  function rememberCompleteMessage(state,message,location){
    if(!plainStructuralRecord(message))return;
    const structuralKeys=[
      "tool_calls",
      "toolCalls",
      "tool_call",
      "toolCall",
      "function_call",
      "functionCall",
    ];
    if(!structuralKeys.some((key)=>Object.hasOwn(message,key)))return;
    const calls=structuralCallsFromMessage(message,location).map(
      (call,index)=>structuralToolCall(call,`${location}.tool_calls[${String(index)}]`),
    );
    if(state.completeCalls&&!sameCompleteStreamValue(state.completeCalls,calls)){
      throw mismatch("The streamed structural tool-call message changed before completion.");
    }
    state.completeCalls=calls;
  }

  function rememberDelta(state,delta,location){
    if(!plainStructuralRecord(delta))return;
    for(const key of ["toolCalls","tool_call","toolCall","function_call","functionCall"]){
      if(Object.hasOwn(delta,key)){
        throw mismatch(`${location} contains a noncanonical structural tool-call field.`);
      }
    }
    if(!Object.hasOwn(delta,"tool_calls"))return;
    const descriptor=Object.getOwnPropertyDescriptor(delta,"tool_calls");
    if(!descriptor||!Object.hasOwn(descriptor,"value")||!Array.isArray(descriptor.value)){
      throw mismatch(`${location}.tool_calls must be an array data property.`);
    }
    for(const [fragmentPosition,fragment] of descriptor.value.entries()){
      if(
        !plainStructuralRecord(fragment)
        ||!Number.isSafeInteger(fragment.index)
        ||fragment.index<0
      ){
        throw mismatch(
          `${location}.tool_calls[${String(fragmentPosition)}] must have a valid structural call index.`,
        );
      }
      const current=state.fragments.get(fragment.index)??{
        index:fragment.index,
        id:"",
        type:"",
        name:"",
        arguments:"",
      };
      if(Object.hasOwn(fragment,"id")){
        if(
          typeof fragment.id!=="string"
          ||!fragment.id
          ||current.id&&current.id!==fragment.id
        ){
          throw mismatch("A streamed structural tool call changed or omitted its ID.");
        }
        current.id=fragment.id;
      }
      if(Object.hasOwn(fragment,"type")){
        if(
          typeof fragment.type!=="string"
          ||!fragment.type
          ||current.type&&current.type!==fragment.type
        ){
          throw mismatch("A streamed structural tool call changed or omitted its type.");
        }
        current.type=fragment.type;
      }
      if(Object.hasOwn(fragment,"function")){
        if(!plainStructuralRecord(fragment.function)){
          throw mismatch("A streamed structural tool call has an invalid function fragment.");
        }
        if(Object.hasOwn(fragment.function,"name")){
          if(typeof fragment.function.name!=="string"){
            throw mismatch("A streamed structural tool call has an invalid function-name fragment.");
          }
          current.name+=fragment.function.name;
        }
        if(Object.hasOwn(fragment.function,"arguments")){
          if(typeof fragment.function.arguments!=="string"){
            throw mismatch("A streamed structural tool call has an invalid arguments fragment.");
          }
          current.arguments+=fragment.function.arguments;
        }
      }
      state.fragments.set(fragment.index,current);
      state.sawFragments=true;
    }
  }

  function observe(chunk){
    if(!plainStructuralRecord(chunk))return;
    if(structuralRecord(chunk.delta)||structuralRecord(chunk.message)){
      const state=choiceState(directChoice);
      rememberDelta(state,chunk.delta,"The streamed model delta");
      rememberCompleteMessage(state,chunk.message,"The streamed model message");
    }
    if(!Array.isArray(chunk.choices)||!chunk.choices.length)return;
    for(const [position,choice] of chunk.choices.entries()){
      if(
        !plainStructuralRecord(choice)
        ||(!structuralRecord(choice.delta)&&!structuralRecord(choice.message))
      )continue;
      if(!Number.isSafeInteger(choice.index)||choice.index<0){
        throw mismatch(
          `The streamed model choice ${String(position)} has no valid choice index.`,
        );
      }
      const state=choiceState(choice.index);
      const location=`The streamed model choice ${String(choice.index)}`;
      rememberDelta(state,choice.delta,`${location} delta`);
      rememberCompleteMessage(state,choice.message,`${location} message`);
    }
  }

  function fragmentCalls(state){
    if(!state.sawFragments)return null;
    const records=[...state.fragments.values()].sort((left,right)=>left.index-right.index);
    for(let index=0;index<records.length;index+=1){
      if(records[index].index!==index){
        throw mismatch("The streamed structural tool calls omitted an ordered call index.");
      }
    }
    return records.map((record)=>({
      id:record.id,
      type:record.type,
      function:{name:record.name,arguments:record.arguments},
    }));
  }

  function correlateChoice(state,terminalCalls){
    const fragmentsResult=fragmentCalls(state);
    if(
      state.completeCalls
      &&fragmentsResult
      &&!sameStreamedToolCalls(state.completeCalls,fragmentsResult)
    ){
      throw mismatch("The streamed structural tool-call fragments do not match the streamed complete message.");
    }
    if(state.completeCalls&&!sameCompleteStreamValue(state.completeCalls,terminalCalls)){
      throw mismatch("The complete streamed structural tool calls do not match the terminal completion.");
    }
    if(fragmentsResult&&!sameStreamedToolCalls(fragmentsResult,terminalCalls)){
      throw mismatch("The streamed structural tool-call fragments do not match the terminal completion.");
    }
  }

  function terminalChoices(completion){
    const result=new Map();
    if(typeof completion==="string")return result;
    if(Object.hasOwn(completion,"message")){
      result.set(
        directChoice,
        structuralCallsFromMessage(
          completion.message,
          "The terminal model message",
        ).map(
          (call,index)=>structuralToolCall(
            call,
            `The terminal model message.tool_calls[${String(index)}]`,
          ),
        ),
      );
      return result;
    }
    for(const choice of completion.choices){
      result.set(
        choice.index,
        structuralCallsFromMessage(
          choice.message,
          `The terminal model choice ${String(choice.index)} message`,
        ).map(
          (call,index)=>structuralToolCall(
            call,
            `The terminal model choice ${String(choice.index)}.tool_calls[${String(index)}]`,
          ),
        ),
      );
    }
    return result;
  }

  function correlate(completion){
    const terminal=terminalChoices(completion);
    for(const [key,state] of choices){
      if(!terminal.has(key)){
        throw mismatch(
          "A streamed structural tool-call choice has no matching terminal completion choice.",
        );
      }
      correlateChoice(state,terminal.get(key));
    }
  }

  return {observe,correlate};
}

function isPublicStreamStructuralKey(key){
  return key==="tool_calls"
    ||key==="toolCalls"
    ||key==="tool_call"
    ||key==="toolCall"
    ||key==="function_call"
    ||key==="functionCall";
}

const OMITTED_PUBLIC_STREAM_DATA=Symbol("omitted-public-stream-data");

function projectPublicStreamData(value,seen=new Map()){
  if(value===null||value===undefined||typeof value!=="object")return value;
  if(seen.has(value))return seen.get(value);
  if(Array.isArray(value)){
    const result=[];
    seen.set(value,result);
    for(const item of value){
      const projected=projectPublicStreamData(item,seen);
      if(projected!==OMITTED_PUBLIC_STREAM_DATA)result.push(projected);
    }
    return result.length||value.length===0?result:OMITTED_PUBLIC_STREAM_DATA;
  }
  const result={};
  seen.set(value,result);
  let sourceDataFields=0;
  for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))){
    if(!Object.hasOwn(descriptor,"value"))continue;
    sourceDataFields+=1;
    if(isPublicStreamStructuralKey(key))continue;
    const projected=projectPublicStreamData(descriptor.value,seen);
    if(projected!==OMITTED_PUBLIC_STREAM_DATA)result[key]=projected;
  }
  return Object.keys(result).length||sourceDataFields===0
    ?result
    :OMITTED_PUBLIC_STREAM_DATA;
}

function projectPublicStreamChunk(value){
  return projectPublicStreamData(value);
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
      configurable: true,
      writable: true,
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
    const streamedToolCalls=createStreamedToolCallAccumulator();
    const publicChunks=[];
    const publicChunkWaiters=[];
    let publicStreamSettled=false;
    let publicStreamError=null;

    function publishPublicChunk(value){
      if(publicStreamSettled)return;
      const waiter=publicChunkWaiters.shift();
      if(waiter)waiter.resolve({value,done:false});
      else publicChunks.push(value);
    }

    function settlePublicStream(error=null){
      if(publicStreamSettled)return;
      publicStreamSettled=true;
      publicStreamError=error;
      for(const waiter of publicChunkWaiters.splice(0)){
        if(error)waiter.reject(error);
        else waiter.resolve({value:undefined,done:true});
      }
    }

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

    const privateStreamPump=openPromise.then(async ()=>{
      const streamIterator=openedIterator;
      try{
        while(true){
          const next=await streamIterator.next();
          if(next.done){
            return true;
          }
          streamedToolCalls.observe(next.value);
          const projected=projectPublicStreamChunk(next.value);
          if(projected!==OMITTED_PUBLIC_STREAM_DATA)publishPublicChunk(projected);
        }
      }catch(error){
        settlePublicStream(error);
        throw error;
      }
    }).catch((error)=>{
      settlePublicStream(error);
      throw error;
    });
    privateStreamPump.catch(()=>undefined);

    const terminalResult=openPromise.then((value)=>value.result).then((value)=>{
      toolRecordFromCompletion(value);
      return value;
    });
    terminalResult.catch(()=>undefined);

    const result = Promise.all([terminalResult,privateStreamPump]).then(([terminal]) => {
      streamedToolCalls.correlate(terminal);
      settlePublicStream();
      return terminal;
    }).catch((error)=>{
      settlePublicStream(error);
      throw error;
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
          settlePublicStream(normalizeArcaneAIError(null,{
            operation:"request",
            signal:linked.controller.signal,
          }));
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
      async next() {
        if(publicChunks.length)return {value:publicChunks.shift(),done:false};
        if(publicStreamError)throw publicStreamError;
        if(publicStreamSettled)return {value:undefined,done:true};
        return new Promise(function waitForProjectedModelStreamChunk(resolve,reject){
          publicChunkWaiters.push({resolve,reject});
        });
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
        await options.onDataChunk?.(chunk, id);
        if(typeof chunk==="string"){
          if(chunk)await options.onChunk?.(chunk, displayId, false);
          continue;
        }
        const streamedChoices=Array.isArray(chunk?.choices)?chunk.choices:[];
        for(const choice of streamedChoices){
          const delta = choice?.delta ?? {};
          if (
            typeof delta.reasoning_content === "string"
            &&delta.reasoning_content
            &&options.seeThinking === true
          ) {
            await options.onChunk?.(delta.reasoning_content, displayId, true);
          }
          if (typeof delta.content === "string"&&delta.content) {
            await options.onChunk?.(delta.content, displayId, false);
          }
        }
      }
      const completion = await handle.result;
      if (options.signal?.aborted) {
        throw normalizeArcaneAIError(null, { operation: "request", signal: options.signal });
      }
      const tools = toolRecordFromCompletion(completion);
      await options.onDataResult?.(completion, id);
      if (typeof options.onResponse === "function") {
        await options.onResponse(completion, id, false);
      }
      for (const call of tools ?? []) {
        await options.onToolCall?.(call, displayId);
      }
      const multipleChoices=Array.isArray(completion?.choices)&&completion.choices.length>1;
      const output = multipleChoices
        ?textFromCompletion(completion)
        :tools??textFromCompletion(completion);
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

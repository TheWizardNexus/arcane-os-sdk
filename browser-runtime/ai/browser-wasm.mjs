import {
  completeValueText,
  createModelController,
  ModelController,
} from "./model-controller.mjs";
import {
  adaptV1LlmProvider,
  createBrowserModelSource,
  createBrowserWasmLlmProvider,
  createDbopfsModelStore,
} from "./browser-wasm-llm-provider.mjs";
import { BROWSER_WASM_RUNTIME_AUTHORITY } from "./browser-wllama-runtime.mjs";

/**
 * Creates the public Arcane browser-local AI API module. The SDK owns lifecycle,
 * cache, streaming, complete response projection, and structural tool visibility; applications
 * continue to own prompts, tools, policies, and any decision to execute a tool.
 */
function createArcaneAI({
  llm = null,
  provider = null,
  loadPolicy = "on-demand",
  security,
} = {}) {
  const selected = llm ?? provider;
  if (!selected) throw new TypeError("createArcaneAI requires an llm provider.");
  if (selected instanceof ModelController && security !== undefined) {
    throw new TypeError(
      "createArcaneAI security must be configured when the existing ModelController is created.",
    );
  }
  const controller = selected instanceof ModelController
    ? selected
    : createModelController({ provider: selected, loadPolicy, security });
  const api = {
    llm: controller,
    runtime: BROWSER_WASM_RUNTIME_AUTHORITY,
    createChatSession,
    status: () => ({ llm: controller.status() }),
    load: (options) => controller.load(options),
    unload: (options) => controller.unload(options),
    probe: (options) => controller.probe(options),
    fetchRequest: (options) => controller.fetchRequest(options),
    streamRequest: (options) => controller.streamRequest(options),
    dispose: (options) => controller.dispose(options),
  };

  async function createChatSession(options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("createChatSession options must be a plain object.");
    }
    if (Object.getPrototypeOf(options) !== Object.prototype) {
      throw new TypeError("createChatSession options must be a plain object.");
    }
    if (Object.hasOwn(options, "ai") || Object.hasOwn(options, "chat")) {
      throw new TypeError("createChatSession always uses this Arcane AI API module.");
    }
    const { createPersistentAIChatSession } = await import(
      "#arcane/persistent-ai-chat-session"
    );
    return createPersistentAIChatSession({
      ...options,
      ai: api,
    });
  }

  return api;
}

export {
  BROWSER_WASM_RUNTIME_AUTHORITY,
  adaptV1LlmProvider,
  completeValueText,
  createArcaneAI,
  createBrowserModelSource,
  createBrowserWasmLlmProvider,
  createDbopfsModelStore,
};

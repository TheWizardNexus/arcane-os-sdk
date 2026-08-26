import { createModelController, ModelController } from "./model-controller.mjs";
import {
  adaptV1LlmProvider,
  createBrowserModelSource,
  createBrowserWasmLlmProvider,
  createDbopfsModelStore,
} from "./browser-wasm-llm-provider.mjs";
import { BROWSER_WASM_RUNTIME_AUTHORITY } from "./browser-wllama-runtime.mjs";

function chatSessionResponse(response) {
  if (response?.message && typeof response.message === "object") return response;
  const choice = Array.isArray(response?.choices) ? response.choices[0] : null;
  if (!choice?.message || typeof choice.message !== "object") return response;
  return Object.freeze({
    message: choice.message,
    provider: response.provider ?? null,
    model: response.model ?? null,
    done: response.done ?? true,
    doneReason: response.doneReason ?? choice.finish_reason ?? null,
    promptEvalCount: response.promptEvalCount ?? response.usage?.prompt_tokens ?? null,
    evalCount: response.evalCount ?? response.usage?.completion_tokens ?? null,
  });
}

/**
 * Creates the generic Arcane browser-local AI facade. The SDK owns lifecycle,
 * integrity, cache, streaming, and structural tool visibility; applications
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

  async function createChatSession(options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("createChatSession options must be a plain object.");
    }
    if (Object.getPrototypeOf(options) !== Object.prototype) {
      throw new TypeError("createChatSession options must be a plain object.");
    }
    if (Object.hasOwn(options, "chat")) {
      throw new TypeError("createChatSession always uses this Arcane AI controller.");
    }
    const { createPersistentAIChatSession } = await import(
      "#arcane/persistent-ai-chat-session"
    );
    return createPersistentAIChatSession({
      ...options,
      chat: async (request) => chatSessionResponse(
        await controller.fetchRequest(request)
      ),
    });
  }

  return Object.freeze({
    llm: controller,
    runtime: BROWSER_WASM_RUNTIME_AUTHORITY,
    createChatSession,
    status: () => Object.freeze({ llm: controller.status() }),
    load: (options) => controller.load(options),
    unload: (options) => controller.unload(options),
    probe: (options) => controller.probe(options),
    fetchRequest: (options) => controller.fetchRequest(options),
    streamRequest: (options) => controller.streamRequest(options),
    dispose: (options) => controller.dispose(options),
  });
}

export {
  BROWSER_WASM_RUNTIME_AUTHORITY,
  adaptV1LlmProvider,
  createArcaneAI,
  createBrowserModelSource,
  createBrowserWasmLlmProvider,
  createDbopfsModelStore,
};

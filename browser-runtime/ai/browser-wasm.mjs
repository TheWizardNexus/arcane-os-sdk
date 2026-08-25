import { createModelController, ModelController } from "./model-controller.mjs";
import {
  adaptV1LlmProvider,
  createBrowserModelSource,
  createBrowserWasmLlmProvider,
  createDbopfsModelStore,
} from "./browser-wasm-llm-provider.mjs";
import { BROWSER_WASM_RUNTIME_AUTHORITY } from "./browser-wllama-runtime.mjs";

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

  return Object.freeze({
    llm: controller,
    runtime: BROWSER_WASM_RUNTIME_AUTHORITY,
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

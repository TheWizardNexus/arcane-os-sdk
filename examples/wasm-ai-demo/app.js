import arcaneThemeReady from "arcane/ThemeBootstrap";
import "arcane/HTMLImport";
import AI, { AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL } from "arcane/AI";
import DBOPFS from "arcane/DBOPFS";
import PreferenceStore from "arcane/PreferenceStore";
import waitForComponent from "arcane/WaitForComponent";
import { subscribeAIRuntimeState } from "arcane/AIRuntimeState";
import { createPersistentAIChatSession } from "#arcane/persistent-ai-chat-session";
import {
  adaptV1LlmProvider,
  createBrowserModelSource,
  createBrowserWasmLlmProvider,
  createDbopfsModelStore,
} from "arcane-os/ai/browser-wasm";
import {
  getRagStats,
  importRagFiles,
  initializeRag,
  retrieveRagContext,
} from "./rag.js";
import { toolsForProfile } from "./profile-tools.js";

const MODELS = {
  "granite-3b": {
    id: "granite-3b",
    label: "Granite 4.1 3B",
    shortLabel: "Granite 3B",
    parameterWords: "3 billion",
    quantization: "Q4_K_M",
    desktopContextTokens: 4_096,
    mobileContextTokens: 2_048,
    files: Array.from(
      { length: 5 },
      function granite3bFileName(_value, index) {
        return `granite-4.1-3b-Q4_K_M-${String(index + 1).padStart(5, "0")}-of-00005.gguf`;
      },
    ),
  },
  "granite-8b": {
    id: "granite-8b",
    label: "Granite 4.1 8B",
    shortLabel: "Granite 8B",
    parameterWords: "8 billion",
    quantization: "Q4_K_M",
    desktopContextTokens: 32_768,
    mobileContextTokens: 2_048,
    files: Array.from(
      { length: 11 },
      function granite8bFileName(_value, index) {
        return `granite-4.1-8b-Q4_K_M-${String(index + 1).padStart(5, "0")}-of-00011.gguf`;
      },
    ),
  },
  "gpt-oss-20b": {
    id: "gpt-oss-20b",
    label: "GPT-OSS 20B",
    shortLabel: "GPT-OSS 20B",
    parameterWords: "20 billion",
    quantization: "MXFP4",
    desktopOnly: true,
    desktopContextTokens: 32_768,
    files: Array.from(
      { length: 20 },
      function gptOssFileName(_value, index) {
        return `gpt-oss-20b-MXFP4-${String(index + 1).padStart(5, "0")}-of-00020.gguf`;
      },
    ),
  },
};

const PROFILES = {
  general: {
    id: "general",
    label: "General",
    minimumContextTokens: 0,
    instruction: "",
  },
  focused: {
    id: "focused",
    label: "Focused",
    minimumContextTokens: 0,
    instruction: "Prioritize the user's immediate goal. Give a direct answer first, retain complete relevant content, and separate facts from open questions.",
  },
  tools: {
    id: "tools",
    label: "Tool visibility",
    minimumContextTokens: 0,
    instruction: "Use a declared function tool when the request clearly calls for one. The browser example displays structural tool calls but does not execute them, so never claim that a requested tool ran or succeeded.",
  },
};

const MOBILE_BROWSER = navigator.userAgentData?.mobile === true
  || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const DEFAULT_MODEL_ID = MOBILE_BROWSER ? "granite-3b" : "granite-8b";

const statusElement = document.getElementById("status");
const statusText = document.getElementById("statusText");
const llmRuntime = document.getElementById("llmRuntime");
const llmRuntimeText = document.getElementById("llmRuntimeText");
const llmModelName = document.getElementById("llmModelName");
const speechRuntime = document.getElementById("speechRuntime");
const speechRuntimeText = document.getElementById("speechRuntimeText");
const modelSelect = document.getElementById("modelSelect");
const profileSelect = document.getElementById("profile-select");
const ragFileInput = document.getElementById("rag-file-input");
const ragImportButton = document.getElementById("rag-import-button");
const ragStatus = document.getElementById("rag-status");
const chat = document.getElementById("chat");

const preferenceStore = new PreferenceStore({
  namespace: "wasm-ai-demo",
  schema: [
    {
      key: "chat-model",
      type: "select",
      label: "Chat model",
      defaultValue: DEFAULT_MODEL_ID,
      options: Object.keys(MODELS),
    },
    {
      key: "chat-profile",
      type: "select",
      label: "Chat profile",
      defaultValue: "general",
      options: Object.keys(PROFILES),
    },
  ],
});

let preferenceWarning = "";
let preferenceValues;
try {
  preferenceValues = await preferenceStore.load();
} catch (error) {
  preferenceWarning = error instanceof Error ? error.message : String(error);
  preferenceValues = preferenceStore.defaults();
}

const requestedModel = MODELS[preferenceValues["chat-model"]];
const selectedModel = requestedModel && !(MOBILE_BROWSER && requestedModel.desktopOnly)
  ? requestedModel
  : MODELS[DEFAULT_MODEL_ID];
const selectedProfile = PROFILES[preferenceValues["chat-profile"]] || PROFILES.general;
const baseContextTokens = MOBILE_BROWSER
  ? selectedModel.mobileContextTokens
  : selectedModel.desktopContextTokens;
const contextTokens = Math.max(
  baseContextTokens || selectedModel.desktopContextTokens,
  selectedProfile.minimumContextTokens,
);

let ai = null;
let browserModelProvider = null;
let releaseLlmProvider = null;
let ragReady = false;
let ragError = "";
let ragImporting = false;
let ragStats = null;
let systemPrompt = "";
let stopRuntimeSubscription = null;
let speechConfigurationError = "";
let teardownStarted = false;

function setRuntime(element, copyElement, state, text) {
  element.dataset.state = state;
  copyElement.textContent = text;
}

function setPageStatus(state, text) {
  statusElement.dataset.state = state;
  statusText.textContent = text;
}

function formatContext(tokens) {
  return Number.isInteger(tokens / 1_024) ? `${tokens / 1_024}K` : String(tokens);
}

function generalSystemPrompt() {
  return `You are ${selectedModel.label}, a ${selectedModel.parameterWords} parameter model running locally in this browser. Be concise, helpful, and direct. Accurately identify yourself as ${selectedModel.label}; do not claim to be a hosted service.`;
}

async function loadProfile() {
  systemPrompt = [
    generalSystemPrompt(),
    selectedProfile.instruction,
  ].filter(Boolean).join("\n\n");
  return systemPrompt;
}

function integerStat(stats, names) {
  for (const name of names) {
    const value = Number(stats?.[name]);
    if (Number.isInteger(value) && value >= 0) return value;
  }
  return 0;
}

function updateRagStatus(stats = ragStats) {
  if (ragError) {
    ragStatus.textContent = `Local knowledge failed: ${ragError}`;
    return;
  }
  if (!ragReady) {
    ragStatus.textContent = "Opening the Arcane document library…";
    return;
  }
  const userCount = integerStat(stats, ["userCount", "userDocuments", "imported"]);
  ragStatus.textContent = `${userCount} locally added ${userCount === 1 ? "document" : "documents"}`;
}

async function loadRag() {
  ragReady = false;
  ragError = "";
  try {
    ragStats = await initializeRag({
      dbopfs: globalThis.dbopfs,
      profileId: selectedProfile.id,
      onStatus(text) {
        if (text) ragStatus.textContent = text;
      },
    });
    ragReady = true;
  } catch (error) {
    ragError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    updateRagStatus();
  }
}

function localModelDescriptor(model) {
  return {
    id: model.id,
    files: model.files.map(function localModelFile(name) {
      return {
        name,
        url: new URL(`./models/${name}`, window.location.href).href,
      };
    }),
  };
}

function speechConfiguration(dbopfs) {
  const transformersDistribution = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/";
  return {
    protocol: AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL,
    id: "wasm-ai-demo-browser-speech",
    dbopfs,
    stt: {
      providerId: "wasm-ai-demo-browser-whisper",
      model: {
        id: "onnx-community/whisper-tiny.en",
        repository: "onnx-community/whisper-tiny.en",
        revision: "2575352d61be1bf7225cf8f8b268a4678025fc58",
        dtype: "fp32",
      },
      runtime: {
        adapter: "transformers-whisper",
        version: "4.2.0",
        revision: "4.2.0",
        entry: "transformers.min.js",
        wasmPaths: transformersDistribution,
        files: [{
          path: "transformers.min.js",
          url: `${transformersDistribution}transformers.min.js`,
          mediaType: "text/javascript",
        }],
      },
      offline: false,
    },
    tts: {
      providerId: "wasm-ai-demo-browser-kokoro",
      model: {
        id: "onnx-community/Kokoro-82M-v1.0-ONNX",
        repository: "onnx-community/Kokoro-82M-v1.0-ONNX",
        revision: "1939ad2a8e416c0acfeecc08a694d14ef25f2231",
        dtype: "q8",
        defaultVoice: "af_heart",
      },
      runtime: {
        adapter: "kokoro-js",
        version: "1.2.1",
        revision: "664c76a704021239ba59c84dcbaa4d3dece01fe9",
        entry: "kokoro.web.js",
        wasmPaths: transformersDistribution,
        files: [{
          path: "kokoro.web.js",
          url: "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js",
          mediaType: "text/javascript",
        }],
      },
      offline: false,
    },
  };
}

function toolArguments(value) {
  const text = String(value || "");
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function visibleToolCalls(message) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return calls.map(function visibleToolCall(call, index) {
    const name = call?.function?.name || "unnamed_function";
    return [
      `Tool call requested (not executed) ${index + 1}: ${name}`,
      toolArguments(call?.function?.arguments),
    ].join("\n");
  }).join("\n\n");
}

function projectToolCalls(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) return response;
  if (response.message && typeof response.message === "object") {
    const toolText = visibleToolCalls(response.message);
    if (!toolText) return response;
    const message = {
      ...response.message,
      content: [response.message.content, toolText].filter(Boolean).join("\n\n"),
    };
    return { ...response, message };
  }
  if (!Array.isArray(response.choices)) return response;
  const choices = response.choices.map(function projectChoice(choice) {
    const message = choice?.message;
    const toolText = visibleToolCalls(message);
    if (!toolText) return choice;
    return {
      ...choice,
      message: {
        ...message,
        content: [message.content, toolText].filter(Boolean).join("\n\n"),
      },
    };
  });
  return { ...response, choices };
}

async function requestProfileCompletion(request) {
  const tools = toolsForProfile(selectedProfile.id);
  const response = await ai.fetchRequest({
    ...request,
    localOnly: true,
    tools,
    toolChoice: "auto",
  });
  return projectToolCalls(response);
}

async function buildRequestContext({ input, signal } = {}) {
  if (!ragReady) return "";
  try {
    ragStatus.textContent = "Searching the Arcane document library…";
    const result = await retrieveRagContext(input, {
      dbopfs: globalThis.dbopfs,
      profileId: selectedProfile.id,
      signal,
    });
    const count = result.matches.length;
    ragStatus.textContent = count
      ? `Using ${count} local ${count === 1 ? "document" : "documents"} for this response`
      : "No local document matched this request";
    return result.text;
  } catch (error) {
    ragStatus.textContent = `Local retrieval unavailable: ${error instanceof Error ? error.message : String(error)}`;
    return "";
  }
}

function runtimeCopy(role) {
  if (!role?.providerId || !role?.modelId) return "not configured";
  if (role.state === "ready") return "ready";
  if (role.state === "loading") return "loading";
  if (role.state === "unloading") return "unloading";
  if (role.state === "error") return role.error?.message || "error";
  return "available on demand";
}

function synchronizeRuntime(snapshot) {
  const llm = snapshot.roles.llm;
  const stt = snapshot.roles.stt;
  const tts = snapshot.roles.tts;
  const llmState = llm.state === "ready"
    ? "ready"
    : (llm.state === "error" ? "error" : "loading");
  setRuntime(
    llmRuntime,
    llmRuntimeText,
    llmState,
    `Arcane SDK browser-WASM · ${runtimeCopy(llm)} · ${formatContext(contextTokens)} context`,
  );
  const speechFailed = stt.state === "error" && tts.state === "error";
  const speechReady = stt.state === "ready" || tts.state === "ready";
  setRuntime(
    speechRuntime,
    speechRuntimeText,
    speechFailed ? "error" : (speechReady ? "ready" : "loading"),
    `Arcane SDK speech · Whisper ${runtimeCopy(stt)} · Kokoro ${runtimeCopy(tts)}`,
  );

  if (llm.state === "ready") {
    setPageStatus("ready", `${selectedProfile.label} ready`);
  } else if (llm.state === "loading") {
    setPageStatus("loading", `Starting ${selectedModel.shortLabel}…`);
  } else if (llm.state === "error") {
    setPageStatus("error", llm.error?.message || "Language model failed");
  } else if (llm.state === "unloading") {
    setPageStatus("loading", `Stopping ${selectedModel.shortLabel}…`);
  } else {
    setPageStatus("ready", "SDK ready · start the model in chat");
  }
}

async function importKnowledgeFiles(files) {
  if (!files.length || !ragReady || ragImporting) return;
  ragImporting = true;
  ragImportButton.disabled = true;
  try {
    const result = await importRagFiles(files, {
      dbopfs: globalThis.dbopfs,
      profileId: selectedProfile.id,
      onStatus(text) {
        if (text) ragStatus.textContent = text;
      },
    });
    ragStats = result.stats || await getRagStats(selectedProfile.id, {
      dbopfs: globalThis.dbopfs,
    });
    updateRagStatus();
  } catch (error) {
    ragStatus.textContent = `Import failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    ragImporting = false;
    ragImportButton.disabled = !ragReady;
  }
}

async function changeModel() {
  const nextModel = MODELS[modelSelect.value];
  if (!nextModel || (MOBILE_BROWSER && nextModel.desktopOnly)) {
    modelSelect.value = selectedModel.id;
    return;
  }
  if (nextModel.id === selectedModel.id) return;
  modelSelect.disabled = true;
  setPageStatus("loading", `Switching to ${nextModel.shortLabel}…`);
  try {
    await preferenceStore.set("chat-model", nextModel.id);
    window.location.reload();
  } catch (error) {
    modelSelect.disabled = false;
    modelSelect.value = selectedModel.id;
    setPageStatus("error", error instanceof Error ? error.message : String(error));
  }
}

async function changeProfile() {
  const nextProfile = PROFILES[profileSelect.value];
  if (!nextProfile) {
    profileSelect.value = selectedProfile.id;
    return;
  }
  if (nextProfile.id === selectedProfile.id) return;
  profileSelect.disabled = true;
  setPageStatus("loading", `Switching to ${nextProfile.label}…`);
  try {
    await preferenceStore.set("chat-profile", nextProfile.id);
    window.location.reload();
  } catch (error) {
    profileSelect.disabled = false;
    profileSelect.value = selectedProfile.id;
    setPageStatus("error", error instanceof Error ? error.message : String(error));
  }
}

async function disposeApplication() {
  if (teardownStarted) return false;
  teardownStarted = true;
  stopRuntimeSubscription?.();
  stopRuntimeSubscription = null;
  const work = [];
  if (ai?.browserSpeechConfiguration) work.push(ai.disposeBrowserSpeech());
  if (browserModelProvider) work.push(browserModelProvider.dispose());
  await Promise.allSettled(work);
  if (typeof releaseLlmProvider === "function") releaseLlmProvider();
  preferenceStore.dispose();
  return true;
}

async function initializeApplication() {
  setPageStatus("loading", "Connecting live Arcane SDK source…");
  modelSelect.value = selectedModel.id;
  profileSelect.value = selectedProfile.id;
  for (const option of modelSelect.options) {
    option.disabled = MOBILE_BROWSER && Boolean(MODELS[option.value]?.desktopOnly);
  }
  llmModelName.textContent = `${selectedProfile.label} · ${selectedModel.label} · ${selectedModel.quantization}`;
  if (preferenceWarning) {
    ragStatus.textContent = `Using default selectors: ${preferenceWarning}`;
  }

  await Promise.all([
    arcaneThemeReady,
    waitForComponent(chat, {
      errorEvent: "html-import-error",
      event: "chat-ready",
      methods: ["bindSession"],
      property: "ready",
    }),
  ]);
  chat.name = "You";
  chat.aiName = selectedProfile.label;
  chat.modelName = selectedModel.label;
  chat.setInitialSpeechMuted(false);

  const dbopfs = globalThis.dbopfs || new DBOPFS();
  globalThis.dbopfs = dbopfs;
  await dbopfs.readyPromise;

  setPageStatus("loading", "Loading profile and local documents…");
  await Promise.all([loadProfile(), loadRag()]);

  // The ordinary example intentionally omits security configuration. Any future
  // checks require explicit secure:true selection and user review before activation.
  const source = createBrowserModelSource(localModelDescriptor(selectedModel));
  browserModelProvider = createBrowserWasmLlmProvider({
    source,
    store: createDbopfsModelStore({ dbopfs }),
    loadDefaults: {
      contextTokens,
      threads: 1,
      batchTokens: MOBILE_BROWSER ? 128 : 512,
      microBatchTokens: MOBILE_BROWSER ? 64 : 256,
    },
  });
  const llmProvider = adaptV1LlmProvider(browserModelProvider);
  const llmSelection = {
    providerId: llmProvider.id,
    modelId: selectedModel.id,
    localOnly: true,
  };

  ai = new AI();
  ai.voiceSpeed = 1.05;
  ai.ready = true;
  globalThis.ai = ai;
  releaseLlmProvider = ai.providerRuntime.register(llmProvider);
  ai.configureProviders({
    llm: { default: llmSelection, localOnly: llmSelection },
    stt: {
      default: ai.providerRuntime.selection("stt"),
      localOnly: ai.providerRuntime.selection("stt", { localOnly: true }),
    },
    tts: {
      default: ai.providerRuntime.selection("tts"),
      localOnly: ai.providerRuntime.selection("tts", { localOnly: true }),
    },
  });

  try {
    await ai.configureBrowserSpeech(speechConfiguration(dbopfs));
  } catch (error) {
    speechConfigurationError = error instanceof Error ? error.message : String(error);
    setRuntime(
      speechRuntime,
      speechRuntimeText,
      "error",
      `Arcane SDK speech unavailable · ${speechConfigurationError}`,
    );
  }

  stopRuntimeSubscription = subscribeAIRuntimeState(synchronizeRuntime);
  const session = await createPersistentAIChatSession({
    chat: requestProfileCompletion,
    chatFileName: `wasm-ai-demo-${selectedProfile.id}-${selectedModel.id}.jsonl`,
    contextBuilder: buildRequestContext,
    loadExisting: true,
    memory: false,
    request: { localOnly: true },
    systemPrompt,
  });
  await chat.bindSession({ session });
  ragImportButton.disabled = !ragReady;
  setPageStatus("ready", "SDK ready · start the model in chat");
}

modelSelect.addEventListener("change", changeModel);
profileSelect.addEventListener("change", changeProfile);
ragImportButton.addEventListener("click", function chooseKnowledgeFiles() {
  if (!ragImporting) ragFileInput.click();
});
ragFileInput.addEventListener("change", function importSelectedKnowledgeFiles() {
  const files = Array.from(ragFileInput.files || []);
  ragFileInput.value = "";
  void importKnowledgeFiles(files);
});
chat.addEventListener("chat-file-uploaded", function importChatKnowledgeFile(event) {
  const file = event.detail?.file;
  if (!file || (!file.type.startsWith("text/") && !/\.(?:csv|json|md|txt)$/i.test(file.name))) return;
  void importKnowledgeFiles([file]);
});
window.addEventListener("pagehide", function disposeDemoOnPageHide() {
  void disposeApplication();
}, { once: true });

try {
  await initializeApplication();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  setPageStatus("error", "SDK initialization failed");
  setRuntime(llmRuntime, llmRuntimeText, "error", message);
  ragImportButton.disabled = true;
}

import arcaneThemeReady from "arcane/ThemeBootstrap";
import "arcane/HTMLImport";
import AI, { AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL } from "arcane/AI";
import DBOPFS from "arcane/DBOPFS";
import { loadModelDefinitionSystemPrompt } from "arcane/ModelDefinition";
import PreferenceStore from "arcane/PreferenceStore";
import waitForComponent from "arcane/WaitForComponent";
import { subscribeAIRuntimeState } from "arcane/AIRuntimeState";
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

function ggufShards(basename, byteLengths) {
  const total = String(byteLengths.length).padStart(5, "0");
  return byteLengths.map(function ggufShard(bytes, index) {
    return {
      name: `${basename}-${String(index + 1).padStart(5, "0")}-of-${total}.gguf`,
      bytes,
    };
  });
}

const MODELS = {
  "granite-3b": {
    id: "granite-3b",
    label: "Granite 4.1 3B",
    shortLabel: "Granite 3B",
    parameterWords: "3 billion",
    quantization: "Q4_K_M",
    desktopContextTokens: 4_096,
    mobileContextTokens: 2_048,
    files: ggufShards("granite-4.1-3b-Q4_K_M", [
      513_000_480,
      509_814_656,
      508_831_744,
      506_056_224,
      61_799_104,
    ]),
  },
  "granite-8b": {
    id: "granite-8b",
    label: "Granite 4.1 8B",
    shortLabel: "Granite 8B",
    parameterWords: "8 billion",
    quantization: "Q4_K_M",
    desktopContextTokens: 32_768,
    mobileContextTokens: 2_048,
    files: ggufShards("granite-4.1-8b-Q4_K_M", [
      340_745_984,
      509_298_176,
      491_112_640,
      507_087_104,
      492_505_440,
      504_302_048,
      489_392_480,
      492_488_992,
      507_103_584,
      509_462_944,
      504_416_352,
    ]),
  },
  "gpt-oss-20b": {
    id: "gpt-oss-20b",
    label: "GPT-OSS 20B",
    shortLabel: "GPT-OSS 20B",
    parameterWords: "20 billion",
    quantization: "MXFP4",
    desktopOnly: true,
    desktopContextTokens: 32_768,
    files: ggufShards("gpt-oss-20b-MXFP4", [
      628_321_344,
      629_471_744,
      608_591_904,
      594_489_088,
      622_377_056,
      594_120_192,
      594_489_088,
      622_377_056,
      594_120_192,
      594_489_088,
      622_377_088,
      594_120_224,
      594_489_088,
      622_377_088,
      594_120_224,
      594_489_088,
      622_377_088,
      594_120_224,
      594_489_088,
      593_763_072,
    ]),
  },
};

const PROFILES = {
  general: {
    id: "general",
    label: "General",
    sourceUrl: null,
    minimumContextTokens: 0,
  },
  precrisis: {
    id: "precrisis",
    label: "PreCrisis",
    sourceUrl: "./profiles/PreCrisis.Modelfile",
    minimumContextTokens: 8_192,
  },
  boss: {
    id: "boss",
    label: "BOSS",
    sourceUrl: "./profiles/BOSS.Modelfile",
    minimumContextTokens: 8_192,
  },
};

const MOBILE_BROWSER = navigator.userAgentData?.mobile === true
  || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const DEFAULT_MODEL_ID = MOBILE_BROWSER ? "granite-3b" : "granite-8b";

const statusElement = document.getElementById("status");
const statusText = document.getElementById("statusText");
const modelSelect = document.getElementById("modelSelect");
const profileSelect = document.getElementById("profile-select");
const ragFileInput = document.getElementById("rag-file-input");
const ragImportButton = document.getElementById("rag-import-button");
const ragStatus = document.getElementById("rag-status");
const speechExecutionButton = document.getElementById("speech-execution-button");
const speechExecutionStatus = document.getElementById("speech-execution-status");
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
let teardownStarted = false;
let toolSettlementAttempts = 0;
let toolSettlementCallId = "";
let toolSettlementPending = false;
let toolSettlementWaiting = false;

function setPageStatus(state, text) {
  statusElement.dataset.state = state;
  statusText.textContent = text;
}

function formatModelLoadElapsed(value) {
  const elapsedMilliseconds = Number(value);
  if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds < 0) return "";
  const elapsedSeconds = Math.floor(elapsedMilliseconds / 1000);
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m elapsed`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s elapsed`;
  return `${seconds}s elapsed`;
}

function telemetryNumber(value) {
  return value === null || value === undefined ? Number.NaN : Number(value);
}

function formatBytes(value) {
  const bytes = telemetryNumber(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unitIndex = 0;
  while (amount >= 1_000 && unitIndex < units.length - 1) {
    amount /= 1_000;
    unitIndex += 1;
  }
  const fractionDigits = unitIndex === 0 || amount >= 100 ? 0 : (amount >= 10 ? 1 : 2);
  return `${amount.toFixed(fractionDigits)} ${units[unitIndex]}`;
}

function formatEta(value) {
  const seconds = Math.ceil(telemetryNumber(value));
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `about ${hours}h ${minutes}m left`;
  if (minutes > 0) return `about ${minutes}m ${remainder}s left`;
  return `about ${remainder}s left`;
}

function transferStatus(progress) {
  const active = telemetryNumber(progress.activeTransfers);
  const limit = telemetryNumber(progress.transferLimit);
  if (!Number.isSafeInteger(active) || active < 0 || !Number.isSafeInteger(limit) || limit < 1) {
    return "";
  }
  const mode = typeof progress.transferMode === "string" && progress.transferMode.trim()
    ? progress.transferMode.trim().toLowerCase()
    : "";
  if (mode === "single") return active > 0 ? "single transfer active" : "single transfer idle";
  if (mode === "probing") return "checking parallel Range support";
  return `${active}/${limit} transfer workers active${mode ? ` (${mode.replaceAll("-", " ")})` : ""}`;
}

function modelLoadStatus(progress = {}) {
  const phase = typeof progress.phase === "string" ? progress.phase : "loading";
  let activity = `Starting ${selectedModel.shortLabel}`;
  if (phase === "cache-check") {
    activity = `Checking the local ${selectedModel.shortLabel} cache`;
  } else if (phase === "download") {
    activity = `Downloading ${selectedModel.shortLabel}`;
  } else if (phase === "initialize") {
    activity = `Loading ${selectedModel.shortLabel} into memory`;
  }
  const parts = [activity];
  const loadedBytes = telemetryNumber(progress.loadedBytes);
  const totalBytes = telemetryNumber(progress.totalBytes);
  const remainingBytes = telemetryNumber(progress.remainingBytes);
  const bytesPerSecond = telemetryNumber(progress.bytesPerSecond);
  const hasByteProgress = phase === "download"
    && Number.isSafeInteger(loadedBytes)
    && loadedBytes >= 0
    && Number.isSafeInteger(totalBytes)
    && totalBytes > 0;
  if (hasByteProgress) {
    parts.push(`${formatBytes(loadedBytes)} / ${formatBytes(totalBytes)}`);
    if (Number.isSafeInteger(remainingBytes) && remainingBytes >= 0) {
      parts.push(`${formatBytes(remainingBytes)} remaining`);
    }
    if (Number.isFinite(bytesPerSecond) && bytesPerSecond >= 0) {
      parts.push(`${formatBytes(bytesPerSecond)}/s`);
    }
    const eta = formatEta(progress.etaSeconds);
    if (eta) parts.push(eta);
  } else {
    const completed = Number(progress.completed);
    const total = Number(progress.total);
    if (Number.isSafeInteger(total) && total > 0 && progress.unit === "files") {
      if (phase === "download" && Number.isSafeInteger(completed) && completed < total) {
        parts.push(`${completed} of ${total} files complete`);
      } else if (phase === "initialize") {
        parts.push(`${total} model parts ready`);
      } else if (phase === "cache-check") {
        parts.push(`${total} model parts`);
      }
    }
  }
  const transfers = transferStatus(progress);
  if (transfers) parts.push(transfers);
  const elapsed = formatModelLoadElapsed(progress.elapsedMs);
  if (elapsed) {
    parts.push(elapsed);
    if (progress.heartbeat === true) parts.push("Still working");
  }
  return parts.join(" · ");
}

function generalSystemPrompt() {
  return `You are ${selectedModel.label}, a ${selectedModel.parameterWords} parameter model running locally in this browser. Be concise, helpful, and direct. Accurately identify yourself as ${selectedModel.label}; do not claim to be a hosted service.`;
}

function browserProfileNote(profile) {
  if (profile.id === "precrisis") {
    return [
      "## Browser example capabilities",
      `This PreCrisis profile is running on ${selectedModel.label} through the live Arcane SDK source.`,
      "Return structural assessment calls through the declared tools when the profile requires them. Every tool call must include a nonempty message argument for the user. SDK Chat displays and persists each call, then records it as not executed because this example has no application action handler. Never claim that a displayed call ran or succeeded. This example is not a diagnosis or an emergency service.",
    ].join("\n\n");
  }
  if (profile.id === "boss") {
    return [
      "## Browser example capabilities",
      `This BOSS profile is running on ${selectedModel.label} through the live Arcane SDK source.`,
      "BOSS library retrieval is completed automatically before generation. Results arrive as local document context; use their complete content, titles, and source links when present. Every structural tool call must include a nonempty message argument for the user. SDK Chat displays and persists the call, then records it as not executed because this example has no application action handler. Never claim that a displayed call ran or succeeded.",
    ].join("\n\n");
  }
  return "";
}

async function loadProfile() {
  if (!selectedProfile.sourceUrl) {
    systemPrompt = generalSystemPrompt();
    return systemPrompt;
  }
  const profilePrompt = await loadModelDefinitionSystemPrompt(selectedProfile.sourceUrl);
  systemPrompt = `${profilePrompt}\n\n${browserProfileNote(selectedProfile)}`;
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
  const bossCount = integerStat(stats, ["bossCount", "bossDocuments", "boss"]);
  const userCount = integerStat(stats, ["userCount", "userDocuments", "imported"]);
  if (selectedProfile.id === "boss") {
    ragStatus.textContent = `${bossCount} BOSS library ${bossCount === 1 ? "record" : "records"} · ${userCount} locally added ${userCount === 1 ? "document" : "documents"}`;
  } else {
    ragStatus.textContent = `${userCount} locally added ${userCount === 1 ? "document" : "documents"}`;
  }
}

async function loadRag() {
  ragReady = false;
  ragError = "";
  try {
    ragStats = await initializeRag({
      dbopfs: globalThis.dbopfs,
      bundleUrl: "./rag/boss-library.json",
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
    files: model.files.map(function localModelFile(file) {
      return {
        name: file.name,
        url: new URL(`./models/${file.name}`, window.location.href).href,
        bytes: file.bytes,
      };
    }),
  };
}

function speechConfiguration(dbopfs) {
  const transformersDistribution = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/";
  const transformersWasmDistribution = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/";
  const kokoroWasmDistribution = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/";
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
        // Transformers 4.2.0 selects this exact ONNX Runtime Web build. Its
        // WASM factory and binary live in that package, not the JS bundle path.
        wasmPaths: transformersWasmDistribution,
        files: [{
          path: "transformers.min.js",
          url: `${transformersDistribution}transformers.min.js`,
          mediaType: "text/javascript",
        }],
      },
      offline: false,
    },
    tts: {
      // Omit execution to use the SDK's auto device and four synthesis slots.
      // Kokoro.js recommends fp32 for the WebGPU route attempted by auto.
      providerId: "wasm-ai-demo-browser-kokoro",
      model: {
        id: "onnx-community/Kokoro-82M-v1.0-ONNX",
        repository: "onnx-community/Kokoro-82M-v1.0-ONNX",
        revision: "1939ad2a8e416c0acfeecc08a694d14ef25f2231",
        dtype: "fp32",
        defaultVoice: "af_heart",
      },
      runtime: {
        adapter: "kokoro-js",
        version: "1.2.1",
        revision: "664c76a704021239ba59c84dcbaa4d3dece01fe9",
        entry: "kokoro.web.js",
        wasmPaths: kokoroWasmDistribution,
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

function synchronizeRuntime(snapshot) {
  const llm = snapshot.roles.llm;
  if (llm.state === "ready") {
    setPageStatus("ready", `${selectedProfile.label} ready`);
    queueMicrotask(function settleRestoredToolAfterRuntimeUpdate() {
      retryDisplayedToolCallAfterStateChange();
    });
  } else if (llm.state === "loading") {
    setPageStatus("loading", modelLoadStatus(llm.progress));
  } else if (llm.state === "error") {
    setPageStatus("error", llm.error?.message || "Language model failed");
  } else if (llm.state === "unloading") {
    setPageStatus("loading", `Stopping ${selectedModel.shortLabel}…`);
  } else {
    setPageStatus("ready", "SDK ready · start the model in chat");
  }
}

function inspectSpeechExecution() {
  if (!ai) {
    speechExecutionStatus.textContent = "Speech configuration is not ready yet.";
    return;
  }
  try {
    const status = ai.providerRuntime.status("tts", { execution: true });
    const execution = status.execution;
    if (!execution) {
      speechExecutionStatus.textContent = `TTS ${status.state}; no execution report is available.`;
      return;
    }
    const fallback = execution.requestedDevice === "auto" && execution.selectedDevice === "wasm";
    speechExecutionStatus.textContent = `TTS ${status.state}; requested ${execution.requestedDevice}; selected ${execution.selectedDevice ?? "not loaded"}; synthesis capacity ${execution.maxConcurrentRequests}; active ${execution.activeRequestCount}${fallback ? "; automatic WASM fallback" : ""}.`;
    console.log("Arcane SDK TTS execution snapshot:", execution);
  } catch (error) {
    speechExecutionStatus.textContent = `${error.code ?? "ERROR"}: ${error.message}`;
    console.error(error.code, error.message);
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
  if (preferenceWarning) {
    ragStatus.textContent = `Using default selectors: ${preferenceWarning}`;
  }

  await Promise.all([
    arcaneThemeReady,
    waitForComponent(chat, {
      errorEvent: "html-import-error",
      event: "chat-ready",
      methods: ["bindSession", "submitToolResult"],
      property: "ready",
    }),
  ]);
  chat.name = "You";
  chat.aiName = selectedProfile.label;
  chat.modelName = selectedModel.label;

  const dbopfs = globalThis.dbopfs || new DBOPFS();
  globalThis.dbopfs = dbopfs;
  await dbopfs.readyPromise;

  setPageStatus("loading", "Loading profile and local documents…");
  await Promise.all([loadProfile(), loadRag()]);

  // The ordinary example intentionally omits security configuration. Any future
  // checks require explicit secure:true selection and user review before activation.
  const source = createBrowserModelSource(localModelDescriptor(selectedModel));
  browserModelProvider = createBrowserWasmLlmProvider({
    sources: [source],
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
    console.error("Arcane SDK speech configuration failed.", error);
  }

  stopRuntimeSubscription = subscribeAIRuntimeState(synchronizeRuntime);
  await chat.bindSession({
    ai,
    sessionOptions: {
      chatFileName: `wasm-ai-demo-${selectedProfile.id}-${selectedModel.id}.jsonl`,
      contextBuilder: buildRequestContext,
      loadExisting: true,
      memory: false,
      request: {
        localOnly: true,
        tools: toolsForProfile(selectedProfile.id),
        toolChoice: "auto",
      },
      systemPrompt,
    },
  });
  ragImportButton.disabled = !ragReady;
  setPageStatus("ready", "SDK ready · start the model in chat");
}

modelSelect.addEventListener("change", changeModel);
profileSelect.addEventListener("change", changeProfile);
speechExecutionButton.addEventListener("click", inspectSpeechExecution);
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
async function settleDisplayedToolCall() {
  const pendingTool = chat.pendingTool;
  if (!pendingTool) {
    toolSettlementAttempts = 0;
    toolSettlementCallId = "";
    toolSettlementWaiting = false;
    return false;
  }
  if (toolSettlementCallId !== pendingTool.id) {
    toolSettlementAttempts = 0;
    toolSettlementCallId = pendingTool.id;
    toolSettlementWaiting = true;
  }
  if (
    chat.aiAvailability?.llm !== true
    || toolSettlementPending
    || !toolSettlementWaiting
    || toolSettlementAttempts >= 2
  ) return false;
  toolSettlementPending = true;
  toolSettlementWaiting = false;
  toolSettlementAttempts += 1;
  let retryAfterSettlement = false;
  try {
    const accepted = await chat.submitToolResult({
      disposition: "not-executed",
      message: "This SDK example displays the requested tool call but does not execute application actions.",
      request: { toolChoice: "none" },
      toolCallId: pendingTool.id,
    });
    if (!accepted) {
      if (toolSettlementAttempts < 2) {
        console.error("Arcane SDK Chat did not accept the not-executed tool disposition; it will retry once after Chat becomes available.");
        toolSettlementWaiting = true;
      } else {
        console.error("Arcane SDK Chat did not accept the not-executed tool disposition after one retry.");
      }
      if (chat.aiAvailability?.llm === true && toolSettlementWaiting) {
        retryAfterSettlement = true;
      }
      return false;
    }
    toolSettlementAttempts = 0;
    toolSettlementCallId = "";
    toolSettlementWaiting = false;
    return true;
  } catch (error) {
    console.error("The displayed SDK tool call could not be settled as not executed.", error);
    return false;
  } finally {
    toolSettlementPending = false;
    if (retryAfterSettlement) {
      queueMicrotask(function retryToolSettlementAfterRejectedSubmission() {
        void settleDisplayedToolCall();
      });
    }
  }
}

function retryDisplayedToolCallAfterStateChange() {
  void settleDisplayedToolCall();
}

chat.addEventListener("chat-session-bound", function settleRestoredToolCall() {
  retryDisplayedToolCallAfterStateChange();
});
chat.addEventListener("chat-session-message", function settleNewToolCall() {
  retryDisplayedToolCallAfterStateChange();
});
window.addEventListener("pagehide", function disposeDemoOnPageHide() {
  void disposeApplication();
}, { once: true });

try {
  await initializeApplication();
} catch (error) {
  setPageStatus("error", "SDK initialization failed");
  console.error("Arcane SDK initialization failed.", error);
  ragImportButton.disabled = true;
}

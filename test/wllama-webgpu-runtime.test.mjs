import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import test from "../src/testing.mjs";
import {
  WLLAMA_WEBGPU_EVIDENCE_PROTOCOL,
} from "../tools/project-wllama-webgpu-runtime.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function repoPath(...segments) {
  return path.join(repositoryRoot, ...segments);
}

test("the projection observes buffers, queue work, cancellation acknowledgement, and Worker termination", async () => {
  const source = await readFile(
    repoPath("browser-runtime", "ai", "wllama", "index.mjs"),
    "utf8",
  );
  assert.equal(
    source.split("function applyArcaneWllamaProjection()").length - 1,
    1,
  );
  assert.match(source, new RegExp(WLLAMA_WEBGPU_EVIDENCE_PROTOCOL, "u"));
  assert.match(source, /navigator\.gpu\.requestAdapter\(opts\).*arcaneRecordSelectedWebgpuAdapter/su);
  assert.match(source, /device\.createBuffer\(desc\).*bufferBytes/su);
  assert.match(source, /queue\.submit\(cmds\).*queueSubmissions/su);
  assert.match(source, /queue\.onSubmittedWorkDone\(\).*queueFenceCompletions/su);
  assert.match(source, /verb === 'arcane\.telemetry'/u);
  assert.match(source, /responseName: result\?\._name/u);
  assert.match(source, /acknowledged: result\?\._name === "cncl_res" && result\?\.success === true/u);
  assert.match(source, /kind: "worker-terminated"/u);
  assert.match(source, /nativeUnload: false/u);
  assert.match(source, /physicalVramReclamation: "not-observed"/u);
  assert.match(source, /"arcaneLoadModel"/u);
  assert.match(source, /"arcaneTerminate"/u);
  assert.doesNotMatch(source, /nativeUnload: true|physicalVramReclamation: "observed"/u);
});

test("the runtime admits operational WebGPU only from full offload and observed queue work", async () => {
  const runtime = await readFile(
    repoPath("browser-runtime", "ai", "browser-wllama-runtime.mjs"),
    "utf8",
  );
  assert.match(runtime, /navigatorPresenceIsOperationalEvidence: false/u);
  assert.match(runtime, /cpuFallback: false/u);
  assert.match(runtime, /const adapter = worker\.adapter/u);
  assert.match(runtime, /adapterEvidenceConflicts\(adapter, logs\.adapter\)/u);
  assert.doesNotMatch(runtime, /if \(!logs\.adapter\) failures\.push\("adapter-log"\)/u);
  assert.match(runtime, /offload\.layers !== offload\.totalLayers/u);
  assert.match(runtime, /worker\.bufferCount < 1/u);
  assert.match(runtime, /worker\.bufferBytes < 1/u);
  assert.match(runtime, /worker\.queueFenceRequests < 1/u);
  assert.match(runtime, /worker\.queueFenceCompletions < worker\.queueFenceRequests/u);
  assert.match(runtime, /fenceCompletions < fenceRequests/u);
  assert.match(runtime, /webgpuOperational = evidence\?\.state === "ready"/u);
  assert.match(runtime, /n_gpu_layers: gpuLayers/u);
  assert.doesNotMatch(runtime, /n_gpu_layers:\s*0/u);
  assert.match(runtime, /cpuUnusedClaimed: false/u);
  assert.match(runtime, /gpuOnlyClaimed: false/u);
});

test("AbortSignal delivery suppression remains distinct from upstream cancellation", async () => {
  const provider = await readFile(
    repoPath("browser-runtime", "ai", "browser-wasm-llm-provider.mjs"),
    "utf8",
  );
  const start = provider.indexOf("function completionOptions(");
  const end = provider.indexOf("\nfunction validateToolCalls", start);
  assert.ok(start >= 0 && end > start);
  const completionOptions = provider.slice(start, end);
  assert.match(completionOptions, /abortSignal,/u);
  assert.doesNotMatch(completionOptions, /(?:^|[,{]\s*)signal\s*:/mu);
  assert.match(provider, /if \(ended \|\| linked\.controller\.signal\.aborted\) return;/u);

  const runtime = await readFile(
    repoPath("browser-runtime", "ai", "browser-wllama-runtime.mjs"),
    "utf8",
  );
  assert.match(runtime, /Object\.hasOwn\(options, "signal"\)/u);
  assert.match(runtime, /accepts abortSignal, not signal/u);
  assert.match(runtime, /next\.isModelLoaded\(\) !== true/u);
  assert.match(runtime, /kind: "llama-request-cancel-acknowledged"/u);
  assert.match(runtime, /immediateGpuKernelPreemptionClaimed: false/u);
  assert.match(runtime, /kind: "worker-terminated"/u);
  assert.match(runtime, /nativeUnloadClaimed: false/u);
  assert.match(runtime, /physicalVramReclamationClaimed: false/u);
  assert.match(runtime, /next\.arcaneLoadModel\(files, loadOptions, loadController\.signal\)/u);
  assert.match(runtime, /session\.arcaneTerminate\(\)/u);
  assert.doesNotMatch(runtime, /session\.proxy|proxy\.worker|proxy\.abort/u);

  const upstreamWllama = await readFile(
    repoPath("node_modules", "@wllama", "wllama", "src", "wllama.ts"),
    "utf8",
  );
  assert.match(upstreamWllama, /options\.abortSignal\?\.aborted/u);
  assert.match(upstreamWllama, /await this\.cancelRequest\(reqId\)/u);
});

test("complete peg-native final output is recovered only from the matching Wllama bridge failure", async () => {
  const runtime = await readFile(
    repoPath("browser-runtime", "ai", "browser-wllama-runtime.mjs"),
    "utf8",
  );
  assert.match(runtime, /common_chat_peg_parse: unparsed peg-native output:/u);
  assert.match(runtime, /<\|channel\|>final <\|constrain\|>content<\|message\|>/u);
  assert.match(runtime, /The model produced output that does not match the expected peg-native format/u);
  assert.match(runtime, /MAX_RECOVERED_COMPLETION_CHARACTERS/u);
  assert.match(runtime, /MAX_RECOVERED_COMPLETION_LINES/u);
  assert.match(runtime, /error\?\.name !== "Error"/u);
  assert.match(runtime, /error\?\.message !== "Invalid magic number"/u);
  assert.match(runtime, /stack\.includes\("glueDeserialize"\)/u);
  assert.match(runtime, /stack\.includes\("ProxyToWorker"\)/u);
  assert.match(runtime, /level !== "warn"/u);
  assert.match(runtime, /level === "error" && line\.trim\(\) === PEG_NATIVE_FAILURE/u);
  assert.match(runtime, /level !== "log"/u);
  assert.match(runtime, /content\.includes\("<\|"\)/u);
  assert.match(runtime, /const locallySuppressed = operation\?\.locallySuppressed\(\) === true/u);
  assert.match(runtime, /const recoveredContent = locallySuppressed\s+\? null/su);
  assert.match(runtime, /streamCapture\.matches\(recoveredContent\)/u);
  assert.match(runtime, /choice\.finish_reason !== undefined && choice\.finish_reason !== null/u);
  assert.match(runtime, /delta\.tool_calls !== undefined/u);
  assert.match(runtime, /delta\.reasoning_content !== undefined/u);
  assert.doesNotMatch(runtime, /sawAssistant/u);
  assert.match(runtime, /requireCancellationAcknowledgement: true/u);
  assert.match(runtime, /cancellation\?\.sequence > previousSequence/u);
  assert.match(runtime, /cancellation\.responseName === "cncl_res"/u);
  assert.match(runtime, /cancellation\.acknowledged === true/u);
  assert.match(runtime, /cancellation\.failed === false/u);
  assert.match(runtime, /ARCANE_AI_COMPLETION_RECOVERY_UNCONFIRMED/u);
  assert.match(runtime, /recovery: "peg-native-final-output"/u);
  assert.doesNotMatch(runtime, /finish_reason: "stop"/u);
});

test("initialization progress observes real runtime stages without claiming completed weight loads", async function observeInitializationProgress() {
  const { runInNewContext } = await import("node:vm");
  const { default: Is } = await import("../browser-runtime/dependencies/strong-type/index.js");
  const runtime = await readFile(
    repoPath("browser-runtime", "ai", "browser-wllama-runtime.mjs"),
    "utf8",
  );
  const constantsStart = runtime.indexOf("const WEBGPU_ADAPTER_PATTERN = ");
  const constantsEnd = runtime.indexOf("\nexport const BROWSER_WASM_RUNTIME_AUTHORITY", constantsStart);
  const loggerStart = runtime.indexOf("function createEvidenceLogger(logger) {");
  const loggerEnd = runtime.indexOf("\nfunction createStructuredStreamCapture()", loggerStart);
  assert.ok(constantsStart >= 0 && constantsEnd > constantsStart);
  assert.ok(loggerStart >= 0 && loggerEnd > loggerStart);
  const createLogger = runInNewContext(
    `${runtime.slice(constantsStart, constantsEnd)}\n${runtime.slice(loggerStart, loggerEnd)}\ncreateEvidenceLogger`,
    {
      is: new Is(false),
      completeValue: function preserveCompleteValue(value) { return value; },
    },
  );
  const forwarded = [];
  const logger = {};
  for (const level of ["debug", "log", "warn", "error"]) {
    logger[level] = function recordCompleteLog(...args) {
      forwarded.push({ level, args });
    };
  }
  const observer = createLogger(logger);
  const progress = [];
  const release = observer.beginLoadProgress(function recordLoadProgress(value) {
    progress.push(value);
  });
  const stages = [
    ['Loading "wllama.wasm" from "https://example.test/wllama.wasm"', "runtime", "Loading the WebAssembly runtime"],
    ["Calling wllamaStart...", "backend", "Starting the inference engine"],
    ["Loading model...", "metadata", "Reading model metadata"],
    ["ggml_webgpu: adapter_info: vendor_id: 1 | vendor: Example | architecture: test | device_id: 2 | name: Example GPU | device_desc: Test adapter", "gpu", "Graphics device initialized; preparing the model"],
    ["llama_model_loader: loaded meta data with 42 key-value pairs and 459 tensors from models/example.gguf (version GGUF V3)", "metadata", "Model metadata read: 459 tensors"],
    ["load_tensors: loading model tensors, this can take a while... (load_mode = async)", "weights", "Loading model weights for 459 tensors"],
    ["load_tensors: offloaded 25/25 layers to GPU", "weights", "Loading model weights; 25 of 25 layers assigned to the GPU"],
    ["llama_context: constructing llama_context", "context", "Preparing the inference context"],
    ["sched_reserve: graph nodes  = 1200", "graph", "Preparing the inference graph"],
    ["sched_reserve: graph splits = 2 (with bs=512), 1 (with bs=1)", "graph", "Preparing the inference graph"],
    ["cmn  common_init_: warming up the model with an empty run - please wait ... (--no-warmup to disable)", "warmup", "Warming up the model with an empty run"],
  ];
  for (const [line, stage, message] of stages) {
    const previousCount = progress.length;
    observer.logger.debug(line);
    assert.equal(progress.length, previousCount + 2);
    assert.equal(progress[previousCount], null);
    const record = progress.at(-1);
    assert.equal(record.phase, "initialize");
    assert.equal(record.stage, stage);
    assert.equal(record.message, message);
    assert.equal(record.total, null);
    assert.equal(Object.hasOwn(record, "completed"), false);
    assert.equal(Object.hasOwn(record, "unit"), false);
    assert.deepEqual(forwarded.at(-1), { level: "debug", args: [line] });
  }

  const nativeDetails = { loadedCtxInfo: { n_layer: 24, n_ctx: 4096 } };
  for (const level of ["debug", "log", "warn", "error"]) {
    const original = "  Runtime detail with original whitespace\r\nand a second line.  ";
    const previousCount = progress.length;
    observer.logger[level](original, nativeDetails);
    assert.equal(progress.length, previousCount + 1);
    assert.equal(progress.at(-1), null);
    assert.deepEqual(forwarded.at(-1), { level, args: [original, nativeDetails] });
    assert.equal(forwarded.at(-1).args[1], nativeDetails);
  }
  const previousCount = progress.length;
  observer.logger.debug(nativeDetails);
  assert.equal(progress.length, previousCount + 1);
  assert.equal(progress.at(-1), null);
  assert.equal(forwarded.at(-1).args[0], nativeDetails);

  release();
  const releasedCount = progress.length;
  observer.logger.debug("Loading model...");
  observer.logger.log("Complete inference output", nativeDetails);
  assert.equal(progress.length, releasedCount);
  assert.deepEqual(forwarded.at(-1), {
    level: "log",
    args: ["Complete inference output", nativeDetails],
  });

  const restarted = [];
  const releaseRestarted = observer.beginLoadProgress(function recordRestartedLoad(value) {
    restarted.push(value);
  });
  observer.logger.debug("load_tensors: loading model tensors, this can take a while... (load_mode = async)");
  assert.equal(restarted.at(-1).message, "Loading model weights");
  releaseRestarted();
});

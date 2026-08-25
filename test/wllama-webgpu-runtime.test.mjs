import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import test from "../src/testing.mjs";
import {
  WLLAMA_PROJECTED_BYTES,
  WLLAMA_PROJECTED_SHA256,
  WLLAMA_UPSTREAM_AUTHORITY,
  WLLAMA_WEBGPU_EVIDENCE_PROTOCOL,
  projectWllamaWebgpuRuntime,
} from "../tools/project-wllama-webgpu-runtime.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function repoPath(...segments) {
  return path.join(repositoryRoot, ...segments);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("the packaged Wllama ESM is the deterministic authenticated WebGPU projection", async () => {
  const upstream = await readFile(repoPath(
    "node_modules",
    "@wllama",
    "wllama",
    "esm",
    "index.js",
  ));
  assert.equal(upstream.byteLength, WLLAMA_UPSTREAM_AUTHORITY.bytes);
  assert.equal(sha256(upstream), WLLAMA_UPSTREAM_AUTHORITY.sha256);

  const first = projectWllamaWebgpuRuntime(upstream);
  const second = projectWllamaWebgpuRuntime(upstream);
  assert.deepEqual(first, second);
  assert.equal(first.byteLength, WLLAMA_PROJECTED_BYTES);
  assert.equal(sha256(first), WLLAMA_PROJECTED_SHA256);
  assert.deepEqual(
    first,
    await readFile(repoPath("browser-runtime", "ai", "wllama", "index.mjs")),
  );

  const wasm = await readFile(repoPath(
    "browser-runtime",
    "ai",
    "wllama",
    "wllama.wasm",
  ));
  assert.equal(wasm.byteLength, 8_524_865);
  assert.equal(sha256(wasm), "95c6ff9ef2a03ff2c63bc91db132f0126a0bd0456b272cd8ae2e0f592fb059f6");

  const tampered = Buffer.from(upstream);
  tampered[0] ^= 1;
  assert.throws(
    () => projectWllamaWebgpuRuntime(tampered),
    /does not match the authenticated 3\.6\.0 source authority/u,
  );
});

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

test("component authority records the projection without changing Wllama WASM", async () => {
  const receipt = JSON.parse(await readFile(
    repoPath("browser-runtime", "ai", "ARCANE_AI_BROWSER_WASM_COMPONENTS.json"),
    "utf8",
  ));
  assert.equal(receipt.runtimePolicy.cpuFallback, false);
  assert.equal(receipt.runtimePolicy.cleanup, "worker-termination-only-no-native-unload-claim");
  const component = receipt.components.find((entry) => entry.name === "@wllama/wllama");
  const module = component.files.find((entry) => entry.role === "runtime-module");
  const wasm = component.files.find((entry) => entry.role === "runtime-wasm");
  assert.equal(module.bytes, WLLAMA_PROJECTED_BYTES);
  assert.equal(module.sha256, WLLAMA_PROJECTED_SHA256);
  assert.equal(module.projection.protocol, WLLAMA_WEBGPU_EVIDENCE_PROTOCOL);
  assert.equal(module.projection.inputSha256, WLLAMA_UPSTREAM_AUTHORITY.sha256);
  assert.equal(module.projection.wasmModified, false);
  assert.equal(wasm.sha256, "95c6ff9ef2a03ff2c63bc91db132f0126a0bd0456b272cd8ae2e0f592fb059f6");
});

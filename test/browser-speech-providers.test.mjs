import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import test from "../src/testing.mjs";
import {
  BROWSER_SPEECH_ARTIFACT_GRAPH_PROTOCOL,
  createBrowserKokoroProvider,
  createBrowserSpeechArtifactGraph,
  createBrowserSpeechAuthority,
  createBrowserWhisperProvider,
  createDbopfsSpeechArtifactStore,
} from "../browser-runtime/ai/browser-speech.mjs";
import {
  createSpeechWorkerRuntime,
  normalizeSpeechWorkerErrorEnvelope,
  SPEECH_WORKER_PROTOCOL,
} from "../browser-runtime/ai/speech-worker-runtime.mjs";
import { createSpeechWorkerClient } from "../browser-runtime/ai/speech-worker-client.mjs";
import { createSpeechWorkerContract } from "./browser-speech-workers.contract.mjs";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function notFound() {
  const error = new Error("not found");
  error.name = "NotFoundError";
  return error;
}

function createMemoryLockManager() {
  const held = new Set();
  return Object.freeze({
    async request(name, options, callback) {
      if (options?.mode !== "exclusive" || options?.ifAvailable !== true) {
        throw new Error("speech test locks must be exclusive and nonblocking");
      }
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback(Object.freeze({ name, mode: "exclusive" }));
      } finally {
        held.delete(name);
      }
    },
  });
}

function createMemoryDbopfs() {
  const entries = new Map();
  const mutations = [];
  const lockManager = createMemoryLockManager();
  const directory = {
    async getFileHandle(name, { create = false } = {}) {
      if (!entries.has(name) && !create) throw notFound();
      return {
        async getFile() {
          if (!entries.has(name)) throw notFound();
          return entries.get(name);
        },
        async createWritable() {
          const chunks = [];
          return {
            async write(chunk) {
              chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
            },
            async close() {
              entries.set(name, new Blob(chunks));
              mutations.push({ operation: "write", name });
            },
            async abort() {
              entries.delete(name);
            },
          };
        },
      };
    },
    async removeEntry(name) {
      if (!entries.delete(name)) throw notFound();
      mutations.push({ operation: "remove", name });
    },
  };
  return Object.freeze({
    readyPromise: Promise.resolve(),
    getTableHandle: async () => directory,
    lockManager,
    entries,
    mutations,
  });
}

function file(path, bytes) {
  const sha256 = digest(bytes);
  return Object.freeze({
    path,
    url: `https://speech.example/${sha256}/${path}`,
    bytes: bytes.byteLength,
    sha256,
  });
}

function responseAt(url, body, init = {}) {
  const response = new Response(body, init);
  Object.defineProperties(response, {
    redirected: { configurable: true, value: init.redirected === true },
    url: { configurable: true, value: String(url) },
  });
  return response;
}

function providerOptions(role, store) {
  const runtimeBytes = new TextEncoder().encode(
    role === "stt" ? "export const pipeline=()=>{};" : "export class KokoroTTS{}",
  );
  const modelBytes = new Uint8Array(role === "stt" ? [1, 2, 3] : [4, 5, 6]);
  return {
    store,
    appSecurity: { secure: false },
    security: { checks: { byteLength: true } },
    runtime: {
      adapter: role === "stt" ? "transformers-whisper" : "kokoro-js",
      version: role === "stt" ? "4.2.0" : "1.2.1",
      revision: role === "stt" ? "transformers-source" : "kokoro-source",
      entry: "runtime.mjs",
      files: [file("runtime.mjs", runtimeBytes)],
    },
    model: {
      id: role === "stt" ? "whisper-test" : "kokoro-test",
      repository: role === "stt" ? "example/whisper" : "example/kokoro",
      revision: role === "stt" ? "whisper-revision" : "kokoro-revision",
      defaultVoice: role === "tts" ? "af_heart" : undefined,
      files: [file("model.onnx", modelBytes)],
    },
  };
}

function artifactGraphFixture(role) {
  const encoder = new TextEncoder();
  const runtimeRevision = "runtime-release-commit";
  const onnxRevision = "onnx-release-commit";
  const modelRevision = "model-release-commit";
  const modelRequestUrl = `https://speech-runtime.example/${modelRevision}/request/config.json`;
  const wasmRequestUrl = `https://speech-runtime.example/${onnxRevision}/request/ort.wasm`;
  const mutableWasmFallback =
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@latest/dist/ort-wasm-simd-threaded.wasm";
  const voiceRequestUrl = role === "tts"
    ? "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_caller.bin"
    : null;
  const entryBytes = encoder.encode(`
    export async function loadRuntime() {
      const runtime = await import("./ort.mjs");
      ${role === "tts" ? `
      const voiceCache = await caches.open("kokoro-voices");
      await voiceCache.match(${JSON.stringify(voiceRequestUrl)});` : ""}
      await fetch(${JSON.stringify(modelRequestUrl)});
      await fetch(${JSON.stringify(mutableWasmFallback)});
      return runtime;
    }
  `);
  const onnxBytes = encoder.encode(`
    const seed = new Uint8Array([1]);
    export const copiedSeed = new seed.constructor(seed.length);
    export async function startRuntime() {
      await fetch(${JSON.stringify(wasmRequestUrl)});
      return new Worker(import.meta.url, { type: "module" });
    }
  `);
  const wasmBytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const modelBytes = encoder.encode('{"model_type":"synthetic-speech"}\n');
  const voiceBytes = new Uint8Array([7, 11, 13, 17]);
  const sources = new Map();

  function declaredFile({
    kind,
    path,
    revision,
    license,
    mediaType,
    sourceMediaType,
    body,
    runtimeRequestUrls = [],
    redirectFinalOrigins,
  }) {
    const sha256 = digest(body);
    const sourceUrl = `https://speech.example/${revision}/${sha256}/${path}`;
    const descriptor = Object.freeze({
      kind,
      path,
      sourceUrl,
      revision,
      license,
      mediaType,
      ...(sourceMediaType === undefined ? {} : { sourceMediaType }),
      bytes: body.byteLength,
      sha256,
      runtimeRequestUrls,
      ...(redirectFinalOrigins === undefined ? {} : { redirectFinalOrigins }),
    });
    sources.set(sourceUrl, Object.freeze({
      body,
      mediaType: sourceMediaType ?? mediaType,
    }));
    return descriptor;
  }

  const files = [
    declaredFile({
      kind: "runtime-entrypoint-javascript",
      path: "runtime/entry.mjs",
      revision: runtimeRevision,
      license: "Apache-2.0",
      mediaType: "text/javascript",
      body: entryBytes,
    }),
    declaredFile({
      kind: "runtime-auxiliary-javascript",
      path: "runtime/ort.mjs",
      revision: onnxRevision,
      license: "MIT",
      mediaType: "text/javascript",
      body: onnxBytes,
    }),
    declaredFile({
      kind: "runtime-wasm-binary",
      path: "runtime/ort.wasm",
      revision: onnxRevision,
      license: "MIT",
      mediaType: "application/wasm",
      body: wasmBytes,
      runtimeRequestUrls: [wasmRequestUrl],
    }),
    declaredFile({
      kind: "model-configuration-json",
      path: "model/config.json",
      revision: modelRevision,
      license: "Apache-2.0",
      mediaType: "application/json",
      body: modelBytes,
      runtimeRequestUrls: [modelRequestUrl],
    }),
  ];
  if (role === "tts") {
    files.push(declaredFile({
      kind: "voice-style-binary",
      path: "voices/af_caller.bin",
      revision: modelRevision,
      license: "Apache-2.0",
      mediaType: "application/octet-stream",
      body: voiceBytes,
      runtimeRequestUrls: [voiceRequestUrl],
    }));
  }
  const descriptor = {
    providerId: role === "stt" ? "graph-whisper" : "graph-kokoro",
    role,
    model: {
      id: role === "stt" ? "caller-whisper" : "caller-kokoro",
      repository: role === "stt" ? "example/caller-whisper" : "example/caller-kokoro",
      revision: modelRevision,
      dtype: "q8",
      ...(role === "stt"
        ? { inputSampleRate: 22_050 }
        : {
          outputSampleRate: 22_050,
          defaultVoice: "af_caller",
          voices: [{ id: "af_caller", path: "voices/af_caller.bin" }],
        }),
    },
    runtime: {
      adapter: role === "stt" ? "transformers-whisper" : "kokoro-js",
      version: role === "stt" ? "3.5.1" : "1.2.1",
      revision: runtimeRevision,
      entrypoint: "runtime/entry.mjs",
      onnxWasm: {
        namespace: role === "stt"
          ? "transformers-env-backends-onnx-wasm"
          : "kokoro-env-wasm-paths",
        mjsPath: "runtime/ort.mjs",
        wasmPath: "runtime/ort.wasm",
        ...(role === "stt" ? { numThreads: 2 } : {}),
      },
      negativeRuntimeRequestUrls: [mutableWasmFallback],
    },
    files,
    edges: {
      staticImports: [],
      cacheOpens: role === "tts" ? [{
        modulePath: "runtime/entry.mjs",
        occurrence: 1,
        edgePolicy: "artifact-targets-admitted",
        cacheName: "kokoro-voices",
        targetPaths: ["voices/af_caller.bin"],
      }] : [],
      dynamicImports: [{
        modulePath: "runtime/entry.mjs",
        occurrence: 1,
        edgePolicy: "artifact-targets-admitted",
        targets: [{
          match: "exact-runtime-specifier",
          targetPath: "runtime/ort.mjs",
          exactSpecifier: "./ort.mjs",
        }],
      }],
      moduleWorkers: [{
        modulePath: "runtime/ort.mjs",
        occurrence: 1,
        edgePolicy: "artifact-targets-admitted",
        targets: [{
          match: "self-module-url",
          targetPath: "runtime/ort.mjs",
        }],
      }],
      fetches: [{
        modulePath: "runtime/entry.mjs",
        occurrence: 1,
        edgePolicy: "artifact-targets-admitted",
        targetPaths: ["model/config.json"],
      }, {
        modulePath: "runtime/entry.mjs",
        occurrence: 2,
        edgePolicy: "artifact-targets-admitted",
        negativeRuntimeRequestUrls: [mutableWasmFallback],
      }, {
        modulePath: "runtime/ort.mjs",
        occurrence: 1,
        edgePolicy: "artifact-targets-admitted",
        targetPaths: ["runtime/ort.wasm"],
      }],
    },
    transforms: [{
      kind: "typed-array-constructor",
      modulePath: "runtime/ort.mjs",
      occurrence: 1,
    }],
  };
  return Object.freeze({
    descriptor,
    graph: createBrowserSpeechArtifactGraph(descriptor),
    sources,
    requests: Object.freeze({ modelRequestUrl, mutableWasmFallback, voiceRequestUrl, wasmRequestUrl }),
  });
}

function graphStore(dbopfs, sources, {
  fetchAttempt = () => undefined,
  objectUrlFactory,
} = {}) {
  return createDbopfsSpeechArtifactStore({
    dbopfs,
    fetchImpl: async (url) => {
      fetchAttempt(String(url));
      const source = sources.get(String(url));
      return source
        ? responseAt(url, source.body, {
          status: 200,
          headers: {
            "content-length": String(source.body.byteLength),
            "content-type": source.mediaType,
          },
        })
        : responseAt(url, null, { status: 404 });
    },
    ...(objectUrlFactory ? { objectUrlFactory } : {}),
  });
}

function installContractWorker(t, createContract) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: function ContractWorker(url, options) {
      return createContract({ url, options }).worker;
    },
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "Worker", descriptor);
    else delete globalThis.Worker;
  });
}

function selection(provider) {
  return Object.freeze({
    providerId: provider.id,
    modelId: provider.catalog()[0].id,
    role: provider.role,
    localOnly: true,
  });
}

function directGraphWorkerConfiguration(source, {
  cache = true,
  secure = true,
  transforms = true,
} = {}) {
  const capability = "a".repeat(64);
  const graphId = "b".repeat(64);
  const modelRoute = "https://speech.example/model-revision/model/config.json";
  const entryModuleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(source
    .replaceAll("__CAPABILITY__", capability)
    .replaceAll("__MODEL_ROUTE__", modelRoute))}`;
  const auxiliaryModuleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent("export const runtime = true;")}`;
  const wasmModuleUrl = "data:application/wasm;base64,AGFzbQEAAAA=";
  const modelModuleUrl = `data:application/json;charset=utf-8,${encodeURIComponent('{"model_type":"speech"}')}`;
  const materialized = (path, moduleUrl, mediaType, runtimeRequestUrls = []) => ({
    path,
    sourceUrl: `https://speech.example/immutable-revision/${path}`,
    revision: "immutable-revision",
    license: "Apache-2.0",
    moduleUrl,
    mediaType,
    bytes: 1,
    sha256: "c".repeat(64),
    runtimeRequestUrls,
  });
  return Object.freeze({
    role: "stt",
    security: Object.freeze({
      secure,
      checks: Object.freeze({ byteLength: secure, sha256: secure }),
    }),
    runtime: Object.freeze({
      adapter: "transformers-whisper",
      moduleGraph: "browser-speech-authenticated-artifact-graph",
      entry: "runtime/entry.mjs",
      artifactGraphId: graphId,
      artifactGraphAdmission: "artifact-graph-network-dbopfs-verified",
      guardCapability: capability,
      onnxWasm: Object.freeze({
        namespace: "transformers-env-backends-onnx-wasm",
        mjsPath: "runtime/ort.mjs",
        wasmPath: "runtime/ort.wasm",
        numThreads: 1,
      }),
      negativeRuntimeRequestUrls: Object.freeze([]),
      files: Object.freeze([
        materialized("runtime/entry.mjs", entryModuleUrl, "text/javascript"),
        materialized("runtime/ort.mjs", auxiliaryModuleUrl, "text/javascript"),
        materialized("runtime/ort.wasm", wasmModuleUrl, "application/wasm"),
      ]),
      edges: Object.freeze({
        staticImports: Object.freeze([]),
        dynamicImports: Object.freeze([]),
        moduleWorkers: Object.freeze([]),
        fetches: Object.freeze([]),
        cacheOpens: Object.freeze(cache ? [{
          modulePath: "runtime/entry.mjs",
          occurrence: 1,
          edgePolicy: "artifact-targets-admitted",
          cacheName: "transformers-cache",
          targetPaths: Object.freeze(["model/config.json"]),
        }] : []),
      }),
      transforms: Object.freeze(transforms ? [{
        kind: "typed-array-constructor",
        modulePath: "runtime/entry.mjs",
        occurrence: 1,
      }] : []),
    }),
    model: Object.freeze({
      id: "direct-worker-whisper",
      repository: "example/direct-worker-whisper",
      revision: "model-revision",
      dtype: "q8",
      inputSampleRate: 16_000,
      files: Object.freeze([
        materialized(
          "model/config.json",
          modelModuleUrl,
          "application/json",
          [modelRoute],
        ),
      ]),
    }),
  });
}

test("warn-first authorities use upstream package and provider downloads", async () => {
  const runtimeBytes = new TextEncoder().encode("export const marker=true;");
  const authority = createBrowserSpeechAuthority({
    providerId: "upstream-whisper",
    role: "stt",
    security: { secure: false },
    runtime: {
      adapter: "transformers-whisper",
      version: "3.5.1",
      revision: "transformers-3.5.1",
      entry: "transformers.js",
      wasmPaths: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/",
      files: [file("transformers.js", runtimeBytes)],
    },
    model: {
      id: "whisper-small",
      repository: "Xenova/whisper-small",
      revision: "provider-selected-revision",
    },
  });
  assert.deepEqual(authority.files, []);
  assert.equal(
    authority.runtime.wasmPaths,
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/",
  );

  const source = `
    export const env = {
      allowLocalModels: true,
      allowRemoteModels: false,
      useBrowserCache: true,
      useFSCache: false,
      useCustomCache: false,
      customCache: null,
      backends: { onnx: { wasm: {} } },
    };
    export async function pipeline() {
      const runtimeGlobal = Function("return globalThis")();
      const transcriber = async () => ({
        text: runtimeGlobal === globalThis && env.useBrowserCache
          ? "upstream-downloads-enabled"
          : "upstream-downloads-disabled",
      });
      transcriber.dispose = async () => undefined;
      return transcriber;
    }
  `;
  const moduleUrl = `data:text/javascript,${encodeURIComponent(source)}`;
  const runtime = createSpeechWorkerRuntime({ role: "stt", send: () => undefined });
  await runtime.handleMessage({
    protocol: SPEECH_WORKER_PROTOCOL,
    id: 1,
    op: "load",
    payload: {
      configuration: {
        role: "stt",
        security: { secure: false, checks: { byteLength: false, sha256: false } },
        runtime: {
          adapter: "transformers-whisper",
          moduleGraph: "self-contained",
          entry: "transformers.js",
          wasmPaths: authority.runtime.wasmPaths,
          files: [{ path: "transformers.js", moduleUrl }],
        },
        model: {
          id: "whisper-small",
          repository: "Xenova/whisper-small",
          revision: "provider-selected-revision",
          files: [],
        },
      },
    },
  });
  assert.deepEqual(await runtime.handleMessage({
    protocol: SPEECH_WORKER_PROTOCOL,
    id: 2,
    op: "use",
    payload: { audio: new Float32Array([0]), sampleRate: 16_000 },
  }), { text: "upstream-downloads-enabled" });
  await runtime.handleMessage({
    protocol: SPEECH_WORKER_PROTOCOL,
    id: 3,
    op: "unload",
    payload: null,
  });
});

test("warn-first provider/store loads unchecked upstream bytes with one visible warning", async (t) => {
  const dbopfs = createMemoryDbopfs();
  const base = providerOptions("stt", null);
  const sources = new Map([
    [
      base.runtime.files[0].url,
      new TextEncoder().encode("export const upstreamRuntime = 'changed-after-selection';"),
    ],
    [base.model.files[0].url, new Uint8Array([9, 8, 7, 6, 5])],
  ]);
  let objectUrl = 0;
  const store = createDbopfsSpeechArtifactStore({
    dbopfs,
    fetchImpl: async (url) => {
      const bytes = sources.get(String(url));
      return bytes
        ? responseAt(url, bytes, {
          status: 200,
          headers: { "content-length": String(bytes.byteLength) },
        })
        : responseAt(url, null, { status: 404 });
    },
    objectUrlFactory: {
      create: () => `blob:arcane-warn-first-${String(++objectUrl)}`,
      revoke: () => undefined,
    },
  });
  installContractWorker(t, () => createSpeechWorkerContract({ role: "stt" }));
  const observedWarnings = [];
  const originalWarn = globalThis.console.warn;
  globalThis.console.warn = (...values) => observedWarnings.push(values.join(" "));
  t.after(() => {
    globalThis.console.warn = originalWarn;
  });

  const whisper = createBrowserWhisperProvider({
    ...base,
    store,
    appSecurity: { secure: false },
    security: {
      secure: false,
      checks: { byteLength: false, sha256: false },
    },
  });
  assert.equal(whisper.status().integrity.state, "unchecked");
  assert.deepEqual(whisper.status().warnings, [
    "browser-speech-warn-first-secure-mode-disabled",
  ]);

  const ready = await whisper.load({
    role: "stt",
    selection: selection(whisper),
    progress: () => undefined,
  });
  assert.equal(ready.state, "ready");
  assert.equal(ready.security.secure, false);
  assert.deepEqual(ready.security.checks, { byteLength: false, sha256: false });
  assert.deepEqual(ready.integrity, {
    state: "unchecked",
    byteLength: { enabled: false, state: "unchecked" },
    sha256: { enabled: false, state: "unchecked" },
  });
  assert.deepEqual(ready.warnings, [
    "browser-speech-warn-first-secure-mode-disabled",
  ]);
  assert.equal(observedWarnings.length, 1);
  assert.match(observedWarnings[0], /loading in warn-first mode/u);
  assert.match(observedWarnings[0], /strict admission is disabled/u);
  assert.equal(
    dbopfs.mutations.some((entry) => entry.name.endsWith(".complete.json")),
    true,
  );
  await whisper.unload();
  await whisper.load({
    role: "stt",
    selection: selection(whisper),
    progress: () => undefined,
  });
  assert.equal(observedWarnings.length, 1);
  await whisper.dispose();
});

test("warn-first integrity follows the actual enabled-check outcome", async (t) => {
  const exactOptions = providerOptions("stt", null);
  const exactRuntimeBytes = new TextEncoder().encode("export const pipeline=()=>{};");
  const exactModelBytes = new Uint8Array([1, 2, 3]);
  const exactSources = new Map([
    [exactOptions.runtime.files[0].url, exactRuntimeBytes],
    [exactOptions.model.files[0].url, exactModelBytes],
  ]);
  const exactStore = createDbopfsSpeechArtifactStore({
    dbopfs: createMemoryDbopfs(),
    fetchImpl: async (url) => responseAt(
      url,
      exactSources.get(String(url)),
      { status: 200 },
    ),
    objectUrlFactory: {
      create: () => "blob:arcane-verified-integrity",
      revoke: () => undefined,
    },
  });
  installContractWorker(t, () => createSpeechWorkerContract({ role: "stt" }));
  const verified = createBrowserWhisperProvider({
    ...exactOptions,
    store: exactStore,
    appSecurity: { secure: false },
    security: {
      secure: false,
      checks: { byteLength: true, sha256: true },
    },
  });
  assert.equal(verified.status().integrity.state, "pending");
  assert.equal((await verified.load({
    role: "stt",
    selection: selection(verified),
    progress: () => undefined,
  })).integrity.state, "verified");
  assert.deepEqual(verified.status().integrity, {
    state: "verified",
    byteLength: { enabled: true, state: "verified" },
    sha256: { enabled: true, state: "verified" },
  });
  await verified.dispose();

  const rejectedStore = createDbopfsSpeechArtifactStore({
    dbopfs: createMemoryDbopfs(),
    fetchImpl: async (url) => responseAt(url, new Uint8Array([9, 9, 9]), { status: 200 }),
    objectUrlFactory: {
      create: () => "blob:arcane-failed-integrity",
      revoke: () => undefined,
    },
  });
  const rejected = createBrowserWhisperProvider({
    ...exactOptions,
    id: "failed-integrity-whisper",
    store: rejectedStore,
    appSecurity: { secure: false },
    security: {
      secure: false,
      checks: { byteLength: true, sha256: true },
    },
  });
  await assert.rejects(
    rejected.load({
      role: "stt",
      selection: selection(rejected),
      progress: () => undefined,
    }),
    (error) => error?.code === "ARCANE_AI_ARTIFACT_DIGEST_MISMATCH"
      || error?.code === "ARCANE_AI_ARTIFACT_SIZE_MISMATCH",
  );
  assert.equal(rejected.status().integrity.state, "failed");
  assert.equal(rejected.status().security.checks.sha256, true);
  await rejected.dispose();
});

test("browser speech artifact graphs bind one deterministic closed authority", () => {
  const stt = artifactGraphFixture("stt");
  assert.equal(stt.graph.protocol, BROWSER_SPEECH_ARTIFACT_GRAPH_PROTOCOL);
  assert.equal(stt.graph.kind, "browser-speech-authenticated-artifact-graph");
  assert.equal(stt.graph.runtime.moduleGraph, "browser-speech-authenticated-artifact-graph");
  assert.equal(stt.graph.artifactGraphStatus, "artifact-graph-descriptor-verified");
  assert.match(stt.graph.identitySha256, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(stt.graph), true);
  assert.deepEqual(
    stt.graph.files.map(({ path }) => path),
    [...stt.graph.files.map(({ path }) => path)].sort(),
  );

  const reordered = createBrowserSpeechArtifactGraph({
    ...stt.descriptor,
    files: [...stt.descriptor.files].reverse(),
    edges: {
      staticImports: [...stt.descriptor.edges.staticImports].reverse(),
      dynamicImports: [...stt.descriptor.edges.dynamicImports].reverse(),
      moduleWorkers: [...stt.descriptor.edges.moduleWorkers].reverse(),
      fetches: [...stt.descriptor.edges.fetches].reverse(),
    },
    transforms: [...stt.descriptor.transforms].reverse(),
  });
  assert.equal(reordered.identitySha256, stt.graph.identitySha256);
  assert.throws(
    () => createBrowserSpeechArtifactGraph({
      ...stt.descriptor,
      identitySha256: "0".repeat(64),
    }),
    (error) => error?.reason === "artifact-graph-identity-sha256-mismatch",
  );

  const tts = artifactGraphFixture("tts");
  assert.throws(
    () => createBrowserSpeechArtifactGraph({
      ...tts.descriptor,
      runtime: {
        ...tts.descriptor.runtime,
        onnxWasm: { ...tts.descriptor.runtime.onnxWasm, numThreads: 2 },
      },
    }),
    (error) => error?.reason === "kokoro-env-num-threads-field-not-exposed",
  );
  const [entrypoint, ...remaining] = stt.descriptor.files;
  assert.throws(
    () => createBrowserSpeechArtifactGraph({
      ...stt.descriptor,
      identitySha256: stt.graph.identitySha256,
      files: [{ ...entrypoint, license: "MIT" }, ...remaining],
    }),
    (error) => error?.reason === "artifact-graph-identity-sha256-mismatch",
  );
  assert.throws(
    () => createBrowserSpeechArtifactGraph({
      ...stt.descriptor,
      files: [{ ...entrypoint, license: " Apache-2.0 " }, ...remaining],
    }),
    (error) => error?.reason === "artifact-graph-file-license-whitespace-rejected",
  );
  assert.throws(
    () => createBrowserSpeechArtifactGraph({
      ...stt.descriptor,
      files: [{ ...entrypoint, revision: "another-runtime-revision" }, ...remaining],
    }),
    (error) => error?.reason === "artifact-graph-entrypoint-revision-mismatch",
  );
  assert.throws(
    () => createBrowserSpeechArtifactGraph({
      ...stt.descriptor,
      files: [{
        ...entrypoint,
        sourceUrl: `https://speech.example/resolve/main/${entrypoint.revision}/${entrypoint.sha256}`,
      }, ...remaining],
    }),
    (error) => error?.reason === "artifact-graph-source-url-mutable",
  );
});

test("artifact graph source redirects bind exact canonical final origins", () => {
  const fixture = artifactGraphFixture("stt");
  const [entrypoint, ...remaining] = fixture.descriptor.files;
  const redirectFile = {
    ...entrypoint,
    redirectFinalOrigins: [
      "https://us.aws.cdn.hf.co/",
      "https://huggingface.co:443",
    ],
  };
  const redirected = createBrowserSpeechArtifactGraph({
    ...fixture.descriptor,
    files: [redirectFile, ...remaining],
  });
  const publicFile = redirected.files.find((file) => file.path === entrypoint.path);
  assert.deepEqual(publicFile.redirectFinalOrigins, [
    "https://huggingface.co",
    "https://us.aws.cdn.hf.co",
  ]);
  assert.equal(Object.isFrozen(publicFile.redirectFinalOrigins), true);
  assert.notEqual(redirected.identitySha256, fixture.graph.identitySha256);
  assert.throws(
    () => createBrowserSpeechArtifactGraph({
      ...fixture.descriptor,
      identitySha256: fixture.graph.identitySha256,
      files: [redirectFile, ...remaining],
    }),
    (error) => error?.reason === "artifact-graph-identity-sha256-mismatch",
  );

  const sourceMediaGraph = createBrowserSpeechArtifactGraph({
    ...fixture.descriptor,
    files: [{ ...entrypoint, sourceMediaType: "application/javascript" }, ...remaining],
  });
  const sourceMediaFile = sourceMediaGraph.files.find((file) => file.path === entrypoint.path);
  assert.equal(sourceMediaFile.sourceMediaType, "application/javascript");
  assert.equal(sourceMediaFile.redirectFinalOrigins, undefined);
  assert.notEqual(sourceMediaGraph.identitySha256, fixture.graph.identitySha256);
  assert.throws(
    () => createBrowserSpeechArtifactGraph({
      ...fixture.descriptor,
      identitySha256: fixture.graph.identitySha256,
      files: [{ ...entrypoint, sourceMediaType: "application/javascript" }, ...remaining],
    }),
    (error) => error?.reason === "artifact-graph-identity-sha256-mismatch",
  );

  const invalidInventories = [
    [null, "artifact-graph-source-redirect-final-origins-not-array"],
    [[], "artifact-graph-source-redirect-final-origin-inventory-empty"],
    [[""], "artifact-graph-source-redirect-final-origin-text-required"],
    [[" https://huggingface.co"], "artifact-graph-source-redirect-final-origin-whitespace-rejected"],
    [["huggingface.co"], "artifact-graph-source-redirect-final-origin-not-absolute"],
    [["http://huggingface.co"], "artifact-graph-source-redirect-final-origin-protocol-not-https"],
    [["https://user:secret@huggingface.co"], "artifact-graph-source-redirect-final-origin-credentials-rejected"],
    [["https://huggingface.co/path"], "artifact-graph-source-redirect-final-origin-path-rejected"],
    [["https://huggingface.co?source=mutable"], "artifact-graph-source-redirect-final-origin-query-rejected"],
    [["https://huggingface.co#source"], "artifact-graph-source-redirect-final-origin-fragment-rejected"],
    [["https://HUGGINGFACE.co", "https://huggingface.co/"], "artifact-graph-source-redirect-final-origin-duplicate"],
    [["https://huggingface.co:443", "https://huggingface.co"], "artifact-graph-source-redirect-final-origin-duplicate"],
  ];
  for (const [redirectFinalOrigins, reason] of invalidInventories) {
    assert.throws(
      () => createBrowserSpeechArtifactGraph({
        ...fixture.descriptor,
        files: [{ ...entrypoint, redirectFinalOrigins }, ...remaining],
      }),
      (error) => error?.reason === reason,
    );
  }
  assert.throws(
    () => createBrowserSpeechArtifactGraph({
      ...fixture.descriptor,
      files: [{ ...entrypoint, sourceMediaType: "text/plain; charset=utf-8" }, ...remaining],
    }),
    (error) => error?.reason === "artifact-graph-file-source-media-type-format-mismatch",
  );
  assert.throws(
    () => createBrowserSpeechArtifactGraph({
      ...fixture.descriptor,
      files: [{ ...entrypoint, sourceMediaType: "" }, ...remaining],
    }),
    (error) => error?.reason === "artifact-graph-file-source-media-type-missing",
  );
  assert.throws(
    () => createBrowserSpeechArtifactGraph({
      ...fixture.descriptor,
      files: [{
        ...entrypoint,
        sourceUrl: `https://speech.example/resolve/main/${entrypoint.sha256}`,
        redirectFinalOrigins: ["https://huggingface.co"],
      }, ...remaining],
    }),
    (error) => error?.reason === "artifact-graph-source-url-mutable",
  );
});

test("authenticated graph Worker executes only declared cache and typed-array capabilities", async () => {
  const source = `
    const guard = globalThis.__arcaneBrowserSpeechArtifactGraphGuardsV1;
    const seed = new Uint8Array([1]);
    const copy = new (guard.typedArrayConstructor(
      "__CAPABILITY__", "runtime/entry.mjs", 1, seed
    ))(seed.length);
    const cache = await guard.openCache(
      "__CAPABILITY__", "runtime/entry.mjs", 1, "transformers-cache"
    );
    const cached = await cache.match("__MODEL_ROUTE__");
    const cachedBytes = new Uint8Array(await cached.arrayBuffer());
    export const env = {
      allowLocalModels: true,
      allowRemoteModels: false,
      useBrowserCache: true,
      useFSCache: true,
      useCustomCache: false,
      customCache: null,
      backends: { onnx: { wasm: {} } },
    };
    export async function pipeline() {
      const transcriber = async () => ({
        text: \`authenticated-\${copy.length}-\${cachedBytes.byteLength}\`,
      });
      transcriber.dispose = async () => undefined;
      return transcriber;
    }
  `;
  const messages = [];
  const fetched = [];
  const originalFetch = globalThis.fetch;
  const originalFunctionConstructor = (() => {}).constructor;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (url, options) => {
      fetched.push(String(url));
      return originalFetch(url, options);
    },
  });
  const runtime = createSpeechWorkerRuntime({
    role: "stt",
    send: (message) => messages.push(message),
  });
  let loaded = false;
  try {
    const configuration = directGraphWorkerConfiguration(source);
    const status = await runtime.handleMessage({
      protocol: SPEECH_WORKER_PROTOCOL,
      id: 1,
      op: "load",
      payload: { configuration },
    });
    loaded = true;
    assert.equal(status.lifecycleStatus, "stt-worker-ready");
    assert.equal(status.lifecycleReason, "stt-load-completed");
    const result = await runtime.handleMessage({
      protocol: SPEECH_WORKER_PROTOCOL,
      id: 2,
      op: "use",
      payload: { audio: new Float32Array([0]), sampleRate: 16_000 },
    });
    assert.deepEqual(result, { text: "authenticated-1-23" });
    assert.equal(fetched.length, 1);
    assert.match(fetched[0], /^data:application\/json/u);
    assert.ok(messages.filter((message) => message.event === "progress").every((message) =>
      Object.keys(message.progress).sort().join(",")
        === "completed,heartbeat,phase,total,unit"));
  } finally {
    if (loaded) {
      await runtime.handleMessage({
        protocol: SPEECH_WORKER_PROTOCOL,
        id: 3,
        op: "unload",
        payload: null,
      }).catch(() => undefined);
    }
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  }
  assert.equal(globalThis.__arcaneBrowserSpeechArtifactGraphGuardsV1, undefined);
  assert.equal((() => {}).constructor, originalFunctionConstructor);
});

test("authenticated graph Worker rejects detached dynamic-code constructors", async () => {
  const source = `
    const DynamicFunction = (() => {}).constructor;
    DynamicFunction("return globalThis")();
    export const env = {};
  `;
  const runtime = createSpeechWorkerRuntime({ role: "stt", send: () => undefined });
  await assert.rejects(
    runtime.handleMessage({
      protocol: SPEECH_WORKER_PROTOCOL,
      id: 1,
      op: "load",
      payload: {
        configuration: directGraphWorkerConfiguration(source, {
          cache: false,
          transforms: false,
        }),
      },
    }),
    (error) => error?.reason === "artifact-graph-dynamic-code-constructor-rejected",
  );
  assert.equal(
    runtime.status().lifecycleReason,
    "artifact-graph-dynamic-code-constructor-rejected",
  );
  assert.equal(globalThis.__arcaneBrowserSpeechArtifactGraphGuardsV1, undefined);
});

test("graph Worker requires explicit secure admission", async () => {
  const source = `
    const runtimeGlobal = Function("return globalThis")();
    export const env = {
      allowLocalModels: true,
      allowRemoteModels: true,
      useBrowserCache: true,
      useFSCache: true,
      useCustomCache: false,
      customCache: null,
      backends: { onnx: { wasm: {} } },
    };
    export async function pipeline() {
      const transcriber = async () => ({
        text: runtimeGlobal === globalThis ? "warn-first" : "wrong-global",
      });
      transcriber.dispose = async () => undefined;
      return transcriber;
    }
  `;
  const runtime = createSpeechWorkerRuntime({ role: "stt", send: () => undefined });
  const configuration = directGraphWorkerConfiguration(source, {
    cache: false,
    secure: false,
    transforms: false,
  });
  await assert.rejects(
    runtime.handleMessage({
      protocol: SPEECH_WORKER_PROTOCOL,
      id: 1,
      op: "load",
      payload: { configuration },
    }),
    (error) => error?.code === "ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID"
      && error?.reason === "artifact-graph-worker-configuration-incomplete",
  );
  assert.equal(globalThis.__arcaneBrowserSpeechArtifactGraphGuardsV1, undefined);
});

test("artifact graph DBOPFS admission proves cold, warm, and zero-network offline closure", async () => {
  const fixture = artifactGraphFixture("stt");
  const dbopfs = createMemoryDbopfs();
  let fetches = 0;
  let objectUrlSubstitutions = 0;
  const phases = [];
  const store = graphStore(dbopfs, fixture.sources, {
    fetchAttempt: () => {
      fetches += 1;
    },
    objectUrlFactory: {
      create: () => {
        objectUrlSubstitutions += 1;
        return "https://untrusted.example/runtime.mjs";
      },
      revoke: () => undefined,
    },
  });
  const cold = await store.prepare(fixture.graph, {
    onProgress: ({ phase }) => phases.push(phase),
    security: { secure: true, checks: { byteLength: true, sha256: true } },
  });
  assert.equal(cold.artifactGraphId, fixture.graph.identitySha256);
  assert.equal(cold.cache, "artifact-graph-network-dbopfs-verified");
  assert.equal(cold.artifactGraphAdmission, "artifact-graph-network-dbopfs-verified");
  assert.equal(fetches, fixture.sources.size);
  assert.equal(objectUrlSubstitutions, 0);
  assert.ok([
    ...cold.runtime.files,
    ...cold.model.files,
  ].every((file) => file.moduleUrl.startsWith("blob:")));
  assert.equal(dbopfs.mutations.at(-1).name.endsWith(".complete.json"), true);
  assert.ok(phases.includes("artifact-graph-network-download"));
  assert.ok(phases.includes("artifact-graph-dbopfs-persisted-rehash"));
  cold.release();

  const warm = await store.prepare(fixture.graph, {
    onProgress: ({ phase }) => phases.push(phase),
    security: { secure: true },
  });
  assert.equal(warm.cache, "artifact-graph-dbopfs-cache-verified");
  assert.equal(fetches, fixture.sources.size);
  assert.ok(phases.includes("artifact-graph-dbopfs-cache-rehash"));
  warm.release();

  let offlineFetches = 0;
  const offlineStore = graphStore(dbopfs, fixture.sources, {
    fetchAttempt: () => {
      offlineFetches += 1;
      throw new Error("offline admission must not call fetch");
    },
  });
  const offline = await offlineStore.prepare(fixture.graph, {
    offline: true,
    security: { secure: true },
  });
  assert.equal(offline.cache, "artifact-graph-offline-dbopfs-cache-verified");
  assert.equal(offlineFetches, 0);
  offline.release();

  const persistedFileName = [...dbopfs.entries.keys()].find((name) =>
    name.endsWith(".artifact"));
  dbopfs.entries.set(persistedFileName, new Blob([new Uint8Array([9, 9, 9])]));
  await assert.rejects(
    offlineStore.prepare(fixture.graph, {
      offline: true,
      security: { secure: true },
    }),
    (error) => error?.reason === "artifact-graph-offline-cache-miss",
  );
  assert.equal(offlineFetches, 0);
  assert.equal(
    [...dbopfs.entries.keys()].some((name) => name.endsWith(".complete.json")),
    false,
  );
});

test("speech Worker publishes only SDK-owned error envelopes", async () => {
  const runtimeEnvironment = `
    export const env = {
      allowLocalModels: true,
      allowRemoteModels: false,
      useBrowserCache: true,
      useFSCache: true,
      useCustomCache: false,
      customCache: null,
      backends: { onnx: { wasm: {} } },
    };
  `;
  const useMessages = [];
  const useRuntime = createSpeechWorkerRuntime({
    role: "stt",
    send: (message) => useMessages.push(message),
  });
  await useRuntime.handleMessage({
    protocol: SPEECH_WORKER_PROTOCOL,
    id: 1,
    op: "load",
    payload: {
      configuration: directGraphWorkerConfiguration(`${runtimeEnvironment}
        export async function pipeline() {
          const transcriber = async () => {
            const failure = new Error("foreign engine failure");
            failure.code = "ARCANE_AI_FAKE";
            failure.reason = "failed";
            throw failure;
          };
          transcriber.dispose = async () => undefined;
          return transcriber;
        }
      `, { cache: false, transforms: false }),
    },
  });
  await assert.rejects(
    useRuntime.handleMessage({
      protocol: SPEECH_WORKER_PROTOCOL,
      id: 2,
      op: "use",
      payload: { audio: new Float32Array([0]), sampleRate: 16_000 },
    }),
    (error) => error?.code === "ARCANE_AI_PROVIDER_REQUEST_FAILED"
      && error?.reason === "stt-transcription-engine-operation-rejected"
      && error?.cause?.code === "ARCANE_AI_FAKE"
      && error?.cause?.reason === "failed",
  );
  const useEnvelope = useMessages.find((message) => message.id === 2 && message.ok === false);
  assert.deepEqual(useEnvelope?.error, {
    protocol: "arcane-ai-speech-worker-error/1",
    code: "ARCANE_AI_PROVIDER_REQUEST_FAILED",
    message: "The speech engine operation was rejected.",
    reason: "stt-transcription-engine-operation-rejected",
  });
  assert.equal(
    normalizeSpeechWorkerErrorEnvelope(useEnvelope.error, "stt", "use")?.reason,
    "stt-transcription-engine-operation-rejected",
  );
  assert.equal(normalizeSpeechWorkerErrorEnvelope({
    ...useEnvelope.error,
    code: "ARCANE_AI_FAKE",
    message: "foreign",
    reason: "failed",
  }, "stt", "use"), null);
  assert.equal(normalizeSpeechWorkerErrorEnvelope({
    ...useEnvelope.error,
    extra: true,
  }, "stt", "use"), null);
  assert.equal(useRuntime.status().lifecycleReason, "stt-transcription-engine-operation-rejected");
  await useRuntime.handleMessage({
    protocol: SPEECH_WORKER_PROTOCOL,
    id: 3,
    op: "unload",
    payload: null,
  });

  const loadMessages = [];
  const loadRuntime = createSpeechWorkerRuntime({
    role: "stt",
    send: (message) => loadMessages.push(message),
  });
  await assert.rejects(
    loadRuntime.handleMessage({
      protocol: SPEECH_WORKER_PROTOCOL,
      id: 1,
      op: "load",
      payload: {
        configuration: directGraphWorkerConfiguration(`${runtimeEnvironment}
          export async function pipeline() {
            const failure = new Error("foreign model failure");
            failure.code = "ARCANE_AI_FAKE";
            failure.reason = "failed";
            throw failure;
          }
        `, { cache: false, transforms: false }),
      },
    }),
    (error) => error?.code === "ARCANE_AI_PROVIDER_REQUEST_FAILED"
      && error?.reason === "stt-worker-model-load-rejected"
      && error?.cause?.code === "ARCANE_AI_FAKE"
      && error?.cause?.reason === "failed",
  );
  const loadEnvelope = loadMessages.find((message) => message.id === 1 && message.ok === false);
  assert.equal(loadEnvelope?.error?.code, "ARCANE_AI_PROVIDER_REQUEST_FAILED");
  assert.equal(loadEnvelope?.error?.reason, "stt-worker-model-load-rejected");
  assert.equal(
    normalizeSpeechWorkerErrorEnvelope(loadEnvelope.error, "stt", "use"),
    null,
  );
  assert.equal(loadRuntime.status().lifecycleReason, "stt-worker-model-load-rejected");
});

test("speech Worker operations are admitted before public value construction", async () => {
  const client = createSpeechWorkerClient({ role: "stt" });
  await assert.rejects(
    client.request("attacker-selected-operation", null),
    (error) => error?.code === "ARCANE_AI_INVALID_REQUEST"
      && error?.reason === "stt-worker-operation-unknown"
      && !error.message.includes("attacker-selected-operation"),
  );

  const runtime = createSpeechWorkerRuntime({ role: "tts", send: () => undefined });
  await assert.rejects(
    runtime.handleMessage({
      protocol: SPEECH_WORKER_PROTOCOL,
      id: 1,
      op: "attacker-selected-operation",
      payload: null,
    }),
    (error) => error?.code === "ARCANE_AI_INVALID_REQUEST"
      && error?.reason === "tts-worker-operation-unknown"
      && !error.message.includes("attacker-selected-operation"),
  );
  assert.equal(runtime.status().activeOperation, null);
  assert.equal(runtime.status().lifecycleReason, "tts-worker-created");
});

test("speech Worker distinguishes missing and rejected Transformers settings", async () => {
  const load = (runtime, source, id) => runtime.handleMessage({
    protocol: SPEECH_WORKER_PROTOCOL,
    id,
    op: "load",
    payload: {
      configuration: directGraphWorkerConfiguration(source, {
        cache: false,
        transforms: false,
      }),
    },
  });

  const missingRuntime = createSpeechWorkerRuntime({ role: "stt", send: () => undefined });
  await assert.rejects(
    load(missingRuntime, `
      export const env = { backends: { onnx: { wasm: {} } } };
      export async function pipeline() { return async () => ({ text: "unused" }); }
    `, 1),
    (error) => error?.code === "ARCANE_AI_PROVIDER_UNAVAILABLE"
      && error?.reason === "transformers-env-allow-local-models-unavailable",
  );
  assert.equal(globalThis.__arcaneBrowserSpeechArtifactGraphGuardsV1, undefined);

  const wasmPathsRuntime = createSpeechWorkerRuntime({ role: "stt", send: () => undefined });
  await assert.rejects(
    load(wasmPathsRuntime, `
      const wasm = {};
      Object.defineProperty(wasm, "wasmPaths", {
        configurable: true,
        get() { return null; },
        set() { throw new Error("synthetic wasmPaths assignment rejection"); },
      });
      export const env = {
        allowLocalModels: true,
        allowRemoteModels: false,
        useBrowserCache: true,
        useFSCache: true,
        useCustomCache: false,
        customCache: null,
        backends: { onnx: { wasm } },
      };
      export async function pipeline() { return async () => ({ text: "unused" }); }
    `, 2),
    (error) => error?.code === "ARCANE_AI_PROVIDER_UNAVAILABLE"
      && error?.reason === "transformers-env-wasm-paths-assignment-rejected",
  );
  assert.equal(globalThis.__arcaneBrowserSpeechArtifactGraphGuardsV1, undefined);

  const numThreadsRuntime = createSpeechWorkerRuntime({ role: "stt", send: () => undefined });
  await assert.rejects(
    load(numThreadsRuntime, `
      const wasm = {};
      Object.defineProperty(wasm, "numThreads", {
        configurable: true,
        get() { return 0; },
        set() { throw new Error("synthetic numThreads assignment rejection"); },
      });
      export const env = {
        allowLocalModels: true,
        allowRemoteModels: false,
        useBrowserCache: true,
        useFSCache: true,
        useCustomCache: false,
        customCache: null,
        backends: { onnx: { wasm } },
      };
      export async function pipeline() { return async () => ({ text: "unused" }); }
    `, 3),
    (error) => error?.code === "ARCANE_AI_PROVIDER_UNAVAILABLE"
      && error?.reason === "transformers-env-num-threads-assignment-rejected",
  );
  assert.equal(globalThis.__arcaneBrowserSpeechArtifactGraphGuardsV1, undefined);
});

test("artifact graph materialization rewrites exact cache and typed-array sites", async () => {
  const fixture = artifactGraphFixture("tts");
  const prepared = await graphStore(createMemoryDbopfs(), fixture.sources)
    .prepare(fixture.graph, { security: { secure: true } });
  try {
    const entry = prepared.runtime.files.find((file) =>
      file.path === "runtime/entry.mjs");
    const auxiliary = prepared.runtime.files.find((file) =>
      file.path === "runtime/ort.mjs");
    const entrySource = await (await fetch(entry.moduleUrl)).text();
    const auxiliarySource = await (await fetch(auxiliary.moduleUrl)).text();
    assert.match(entrySource, /\.openCache\("[a-f0-9]{64}","runtime\/entry\.mjs",1,/u);
    assert.doesNotMatch(entrySource, /\bcaches\.open\s*\(/u);
    assert.match(
      auxiliarySource,
      /new \(globalThis\.__arcaneBrowserSpeechArtifactGraphGuardsV1\.typedArrayConstructor\("[a-f0-9]{64}","runtime\/ort\.mjs",1,seed\)\)\(seed\.length\)/u,
    );
    assert.doesNotMatch(auxiliarySource, /new seed\.constructor\s*\(/u);
  } finally {
    prepared.release();
  }
});

test("artifact graph source verification propagates exact rejection boundaries", async () => {
  const fixture = artifactGraphFixture("stt");
  const entrypoint = fixture.graph.files.find((file) =>
    file.kind === "runtime-entrypoint-javascript");
  const original = fixture.sources.get(entrypoint.sourceUrl);

  const wrongMediaSources = new Map(fixture.sources);
  wrongMediaSources.set(entrypoint.sourceUrl, Object.freeze({
    ...original,
    mediaType: "application/javascript",
  }));
  await assert.rejects(
    graphStore(createMemoryDbopfs(), wrongMediaSources).prepare(fixture.graph, {
      security: { secure: true },
    }),
    (error) => error?.reason === "artifact-graph-entrypoint-media-type-mismatch",
  );

  const shortSources = new Map(fixture.sources);
  shortSources.set(entrypoint.sourceUrl, Object.freeze({
    ...original,
    body: original.body.slice(0, original.body.byteLength - 1),
  }));
  await assert.rejects(
    graphStore(createMemoryDbopfs(), shortSources).prepare(fixture.graph, {
      security: { secure: true },
    }),
    (error) => error?.reason === "artifact-graph-entrypoint-byte-length-mismatch",
  );

  const changedBytes = new Uint8Array(original.body);
  changedBytes[0] ^= 0xff;
  const changedSources = new Map(fixture.sources);
  changedSources.set(entrypoint.sourceUrl, Object.freeze({
    ...original,
    body: changedBytes,
  }));
  await assert.rejects(
    graphStore(createMemoryDbopfs(), changedSources).prepare(fixture.graph, {
      security: { secure: true },
    }),
    (error) => error?.reason === "artifact-graph-entrypoint-sha256-mismatch",
  );

  const redirectedStore = createDbopfsSpeechArtifactStore({
    dbopfs: createMemoryDbopfs(),
    fetchImpl: async (url) => {
      const source = fixture.sources.get(String(url));
      return responseAt(`https://redirected.example/${encodeURIComponent(String(url))}`, source.body, {
        status: 200,
        redirected: true,
        headers: {
          "content-length": String(source.body.byteLength),
          "content-type": source.mediaType,
        },
      });
    },
    objectUrlFactory: { create: () => "blob:redirect-never", revoke: () => undefined },
  });
  await assert.rejects(
    redirectedStore.prepare(fixture.graph, { security: { secure: true } }),
    (error) => error?.reason === "artifact-graph-source-redirected",
  );
});

test("artifact graph cold redirects require declared final origin and source media type", async () => {
  const fixture = artifactGraphFixture("stt");
  const targetPath = "model/config.json";
  const graph = createBrowserSpeechArtifactGraph({
    ...fixture.descriptor,
    files: fixture.descriptor.files.map((file) => file.path === targetPath
      ? {
        ...file,
        sourceMediaType: "text/plain",
        redirectFinalOrigins: ["https://huggingface.co"],
      }
      : file),
  });
  const target = graph.files.find((file) => file.path === targetPath);
  const sources = new Map(fixture.sources);
  sources.set(target.sourceUrl, Object.freeze({
    ...sources.get(target.sourceUrl),
    mediaType: "text/plain",
  }));
  const dbopfs = createMemoryDbopfs();
  const fetches = [];
  const store = createDbopfsSpeechArtifactStore({
    dbopfs,
    fetchImpl: async (url, init) => {
      const sourceUrl = String(url);
      const source = sources.get(sourceUrl);
      fetches.push(Object.freeze({ sourceUrl, redirect: init.redirect }));
      if (!source) return responseAt(sourceUrl, null, { status: 404 });
      const responseUrl = sourceUrl === target.sourceUrl
        ? "https://huggingface.co/api/resolve-cache/models/example/revision/config.json?etag=immutable"
        : sourceUrl;
      return responseAt(responseUrl, source.body, {
        status: 200,
        redirected: sourceUrl === target.sourceUrl,
        headers: {
          "content-length": String(source.body.byteLength),
          "content-type": source.mediaType,
        },
      });
    },
  });
  const cold = await store.prepare(graph, { security: { secure: true } });
  assert.equal(cold.cache, "artifact-graph-network-dbopfs-verified");
  assert.equal(
    fetches.find((entry) => entry.sourceUrl === target.sourceUrl).redirect,
    "follow",
  );
  assert.ok(fetches.filter((entry) => entry.sourceUrl !== target.sourceUrl)
    .every((entry) => entry.redirect === "error"));
  cold.release();

  const fetchCount = fetches.length;
  const warm = await store.prepare(graph, { security: { secure: true } });
  assert.equal(warm.cache, "artifact-graph-dbopfs-cache-verified");
  assert.equal(fetches.length, fetchCount);
  warm.release();
  const offline = await store.prepare(graph, {
    offline: true,
    security: { secure: true },
  });
  assert.equal(offline.cache, "artifact-graph-offline-dbopfs-cache-verified");
  assert.equal(fetches.length, fetchCount);
  offline.release();

  function redirectFailureStore(finalUrl, {
    redirected = true,
    status = 200,
    mediaType = "text/plain",
    body = sources.get(target.sourceUrl).body,
  } = {}) {
    return createDbopfsSpeechArtifactStore({
      dbopfs: createMemoryDbopfs(),
      fetchImpl: async (url) => {
        const sourceUrl = String(url);
        const source = sources.get(sourceUrl);
        if (sourceUrl !== target.sourceUrl) {
          return responseAt(sourceUrl, source.body, {
            status: 200,
            headers: {
              "content-length": String(source.body.byteLength),
              "content-type": source.mediaType,
            },
          });
        }
        return responseAt(finalUrl, body, {
          status,
          redirected,
          headers: {
            "content-length": String(body.byteLength),
            "content-type": mediaType,
          },
        });
      },
    });
  }

  await assert.rejects(
    redirectFailureStore("https://undeclared.example/xet/model").prepare(graph, {
      security: { secure: true },
    }),
    (error) => error?.reason === "artifact-graph-source-redirect-final-origin-mismatch",
  );
  for (const invalidResponse of [null, Object.freeze({})]) {
    await assert.rejects(
      createDbopfsSpeechArtifactStore({
        dbopfs: createMemoryDbopfs(),
        fetchImpl: async () => invalidResponse,
      }).prepare(graph, { security: { secure: true } }),
      (error) => error?.reason === "artifact-graph-source-http-response-rejected",
    );
  }
  await assert.rejects(
    redirectFailureStore("https://undeclared.example/xet/model", {
      status: 404,
    }).prepare(graph, { security: { secure: true } }),
    (error) => error?.reason === "artifact-graph-source-redirect-final-origin-mismatch",
  );
  await assert.rejects(
    redirectFailureStore("https://huggingface.co/xet/model", {
      status: 404,
    }).prepare(graph, { security: { secure: true } }),
    (error) => error?.reason === "artifact-graph-source-http-response-rejected",
  );
  await assert.rejects(
    redirectFailureStore("not a final URL").prepare(graph, {
      security: { secure: true },
    }),
    (error) => error?.reason === "artifact-graph-source-response-url-unreadable",
  );
  await assert.rejects(
    redirectFailureStore("http://huggingface.co/xet/model").prepare(graph, {
      security: { secure: true },
    }),
    (error) => error?.reason === "artifact-graph-source-response-url-protocol-not-https",
  );
  await assert.rejects(
    redirectFailureStore("https://user:secret@huggingface.co/xet/model").prepare(graph, {
      security: { secure: true },
    }),
    (error) => error?.reason === "artifact-graph-source-response-url-credentials-rejected",
  );
  await assert.rejects(
    redirectFailureStore("https://huggingface.co/xet/model#fragment").prepare(graph, {
      security: { secure: true },
    }),
    (error) => error?.reason === "artifact-graph-source-response-url-fragment-rejected",
  );
  await assert.rejects(
    redirectFailureStore("https://huggingface.co:444/xet/model").prepare(graph, {
      security: { secure: true },
    }),
    (error) => error?.reason === "artifact-graph-source-redirect-final-origin-mismatch",
  );
  await assert.rejects(
    redirectFailureStore("https://huggingface.co/not-a-redirect", {
      redirected: false,
    }).prepare(graph, { security: { secure: true } }),
    (error) => error?.reason === "artifact-graph-source-response-url-mismatch",
  );
  await assert.rejects(
    redirectFailureStore("https://huggingface.co/xet/model", {
      mediaType: "application/json",
    }).prepare(graph, { security: { secure: true } }),
    (error) => error?.reason === "artifact-graph-model-configuration-json-source-media-type-mismatch",
  );
  await assert.rejects(
    redirectFailureStore("https://huggingface.co/xet/model", {
      body: sources.get(target.sourceUrl).body.slice(0, 1),
    }).prepare(graph, { security: { secure: true } }),
    (error) => error?.reason === "artifact-graph-model-configuration-json-byte-length-mismatch",
  );
});

test("graph Kokoro requires explicit secure admission", async (t) => {
  const fixture = artifactGraphFixture("tts");
  const dbopfs = createMemoryDbopfs();
  const store = graphStore(dbopfs, fixture.sources);
  const contracts = [];
  installContractWorker(t, () => {
    const contract = createSpeechWorkerContract({ role: "tts" });
    contracts.push(contract);
    return contract;
  });

  await assert.rejects(
    store.prepare(fixture.graph),
    (error) => error?.reason === "artifact-graph-secure-mode-required",
  );

  const warnFirst = createBrowserKokoroProvider({
    id: fixture.graph.providerId,
    graph: fixture.graph,
    store,
    appSecurity: { secure: false },
  });
  await assert.rejects(
    warnFirst.load({
      role: "tts",
      selection: selection(warnFirst),
      progress: () => undefined,
    }),
    (error) => error?.code === "ARCANE_AI_SECURE_MODE_REQUIRED"
      && error?.reason === "tts-artifact-graph-secure-mode-required",
  );
  assert.equal(contracts.length, 0);
  assert.equal(warnFirst.status().state, "unloaded");
  await warnFirst.dispose();
  contracts.length = 0;

  const kokoro = createBrowserKokoroProvider({
    id: fixture.graph.providerId,
    graph: fixture.graph,
    store,
  });
  const [catalog] = kokoro.catalog();
  assert.deepEqual(catalog.speech, {
    outputSampleRate: 22_050,
    responseFormats: ["wav"],
    defaultResponseFormat: "wav",
  });
  assert.equal(catalog.defaultVoice, "af_caller");
  assert.deepEqual(catalog.voices, [{ id: "af_caller", path: "voices/af_caller.bin" }]);
  assert.equal(kokoro.status().lifecycleStatus, "tts-provider-unloaded");
  assert.equal(kokoro.status().lifecycleReason, "tts-provider-created");

  await kokoro.load({
    role: "tts",
    selection: selection(kokoro),
    progress: () => undefined,
    security: { secure: true, checks: { byteLength: true, sha256: true } },
  });
  assert.equal(contracts.length, 1);
  assert.equal(contracts[0].privateTransport, true);
  assert.equal(contracts[0].privatePortTransferred, true);
  assert.equal(kokoro.status().lifecycleStatus, "tts-provider-ready");
  assert.equal(kokoro.status().lifecycleReason, "tts-load-completed");
  assert.equal(kokoro.status().artifactGraphId, fixture.graph.identitySha256);
  assert.equal(
    kokoro.status().artifactGraphAdmission,
    "artifact-graph-network-dbopfs-verified",
  );

  const speech = await kokoro.request({
    role: "tts",
    operation: "synthesize",
    payload: { text: "Caller authority" },
  });
  assert.equal(speech.sampleRate, 22_050);
  assert.equal(speech.voice, "af_caller");
  assert.equal(kokoro.status().lifecycleReason, "tts-synthesis-completed");
  await assert.rejects(
    kokoro.request({
      role: "tts",
      operation: "synthesize",
      payload: { text: "Unknown voice", voice: "af_hidden" },
    }),
    (error) => error?.reason === "tts-synthesis-voice-not-declared",
  );

  await kokoro.unload();
  assert.equal(kokoro.status().lifecycleStatus, "tts-provider-unloaded");
  assert.equal(kokoro.status().lifecycleReason, "tts-unload-completed");
  assert.equal(contracts[0].terminated, true);
  assert.equal(contracts[0].privateTransport, false);
});

test("graph Whisper uses caller sample-rate authority over a private Worker channel", async (t) => {
  const fixture = artifactGraphFixture("stt");
  const contract = createSpeechWorkerContract({ role: "stt" });
  installContractWorker(t, () => contract);
  const whisper = createBrowserWhisperProvider({
    id: fixture.graph.providerId,
    graph: fixture.graph,
    security: { secure: true },
    store: graphStore(createMemoryDbopfs(), fixture.sources),
  });
  assert.deepEqual(
    whisper.inspect({ ...selection(whisper), role: "tts" }),
    {
      available: false,
      code: "ARCANE_AI_MODEL_AUTHORITY_REQUIRED",
      message: "The selected browser speech model does not match this provider authority.",
      reason: "stt-provider-inspection-selection-authority-mismatch",
    },
  );
  await whisper.load({
    role: "stt",
    selection: selection(whisper),
    progress: () => undefined,
  });
  assert.equal(contract.privatePortTransferred, true);
  assert.equal(
    contract.posted.find((message) => message.op === "load")
      ?.payload?.configuration?.runtime?.onnxWasm?.namespace,
    "transformers-env-backends-onnx-wasm",
  );
  assert.deepEqual(await whisper.request({
    role: "stt",
    operation: "transcribe",
    payload: { audio: new Float32Array([0]), sampleRate: 22_050 },
  }), { text: "hello from whisper" });
  await assert.rejects(
    whisper.request({
      role: "stt",
      operation: "transcribe",
      payload: { audio: new Float32Array([0]), sampleRate: 16_000 },
    }),
    (error) => error?.reason === "stt-transcription-sample-rate-mismatch",
  );
  await whisper.unload();
  assert.equal(contract.terminated, true);
});

test("browser speech rejects foreign and incomplete Worker error envelopes", async (t) => {
  const fixture = artifactGraphFixture("stt");
  const rejectedEnvelopes = [
    {
      protocol: "arcane-ai-speech-worker-error/1",
      code: "ARCANE_AI_FAKE",
      message: "foreign Worker error",
      reason: "failed",
    },
    {},
    {
      protocol: "arcane-ai-speech-worker-error/1",
      code: "ARCANE_AI_PROVIDER_REQUEST_FAILED",
      message: "The speech engine operation was rejected.",
      reason: "stt-transcription-engine-operation-rejected",
    },
    {
      protocol: "arcane-ai-speech-worker-error/1",
      code: "ARCANE_AI_PROVIDER_REQUEST_FAILED",
      message: "The speech engine operation was rejected.",
      reason: "stt-worker-model-load-rejected",
      extra: true,
    },
  ];
  const contracts = [];
  installContractWorker(t, () => {
    const responseError = rejectedEnvelopes[contracts.length];
    const contract = createSpeechWorkerContract({ role: "stt", responseError });
    contracts.push(contract);
    return contract;
  });
  for (let index = 0; index < rejectedEnvelopes.length; index += 1) {
    const whisper = createBrowserWhisperProvider({
      id: fixture.graph.providerId,
      graph: fixture.graph,
      security: { secure: true },
      store: graphStore(createMemoryDbopfs(), fixture.sources),
    });
    await assert.rejects(
      whisper.load({
        role: "stt",
        selection: selection(whisper),
        progress: () => undefined,
      }),
      (error) => error?.code === "ARCANE_AI_WORKER_MESSAGE_ERROR"
        && error?.reason === "stt-worker-error-envelope-rejected",
    );
    assert.equal(whisper.status().lifecycleStatus, "stt-provider-error");
    assert.equal(whisper.status().errorCode, "ARCANE_AI_WORKER_MESSAGE_ERROR");
    assert.equal(whisper.status().lifecycleReason, "stt-worker-error-envelope-rejected");
    assert.equal(contracts[index].terminated, true);
  }
});

test("browser Whisper and Kokoro expose independent provider-v2 workers", async (t) => {
  const dbopfs = createMemoryDbopfs();
  const sources = new Map();
  for (const role of ["stt", "tts"]) {
    const options = providerOptions(role, null);
    for (const descriptor of [...options.runtime.files, ...options.model.files]) {
      sources.set(descriptor.url, role === "stt"
        ? descriptor.path === "runtime.mjs"
          ? new TextEncoder().encode("export const pipeline=()=>{};")
          : new Uint8Array([1, 2, 3])
        : descriptor.path === "runtime.mjs"
          ? new TextEncoder().encode("export class KokoroTTS{}")
          : new Uint8Array([4, 5, 6]));
    }
  }
  let objectUrl = 0;
  const store = createDbopfsSpeechArtifactStore({
    dbopfs,
    fetchImpl: async (url) => {
      const bytes = sources.get(String(url));
      return bytes
        ? responseAt(url, bytes, {
          status: 200,
          headers: { "content-length": String(bytes.byteLength) },
        })
        : responseAt(url, null, { status: 404 });
    },
    objectUrlFactory: {
      create: () => `blob:arcane-speech-${String(++objectUrl)}`,
      revoke: () => undefined,
    },
  });
  const workers = { stt: [], tts: [] };
  installContractWorker(t, ({ options }) => {
    const role = options.name.includes("whisper") ? "stt" : "tts";
    const contract = createSpeechWorkerContract({ role });
    workers[role].push(contract);
    return contract;
  });
  const whisper = createBrowserWhisperProvider(providerOptions("stt", store));
  const kokoro = createBrowserKokoroProvider(providerOptions("tts", store));

  assert.equal(whisper.protocol, "arcane-ai-provider/2");
  assert.equal(whisper.role, "stt");
  assert.equal(kokoro.role, "tts");
  assert.equal(whisper.localOnly, true);
  assert.equal(kokoro.localOnly, true);
  assert.equal(whisper.inspect(selection(whisper)).authority.admitted, true);
  assert.equal(kokoro.inspect(selection(kokoro)).authority.admitted, true);
  await assert.rejects(whisper.load({
    role: "stt",
    selection: { ...selection(whisper), localOnly: false },
    signal: null,
    progress: () => undefined,
    security: { secure: true },
  }), (error) => error?.code === "ARCANE_AI_MODEL_AUTHORITY_REQUIRED");
  assert.equal(workers.stt.length, 0);

  const progress = [];
  await whisper.load({
    role: "stt",
    selection: selection(whisper),
    signal: null,
    progress: (record) => progress.push(record),
    security: { checks: { sha256: true } },
  });
  await kokoro.load({
    role: "tts",
    selection: selection(kokoro),
    signal: null,
    progress: (record) => progress.push(record),
    security: { checks: { sha256: true } },
  });
  assert.equal(workers.stt.length, 1);
  assert.equal(workers.tts.length, 1);
  assert.notEqual(workers.stt[0].worker, workers.tts[0].worker);
  assert.equal(whisper.status().state, "ready");
  assert.equal(kokoro.status().state, "ready");
  assert.ok(progress.every((record) =>
    Object.keys(record).sort().join(",") === "completed,heartbeat,phase,total,unit"));

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(whisper.request({
    role: "stt",
    operation: "transcribe",
    payload: { audio: new Float32Array([0]), sampleRate: 16_000 },
    signal: alreadyAborted.signal,
  }), (error) => error?.code === "ARCANE_AI_REQUEST_ABORTED"
    && error?.reason === "stt-transcription-cancelled");
  assert.equal(whisper.status().state, "ready");
  assert.equal(workers.stt[0].terminated, false);

  assert.deepEqual(await whisper.request({
    role: "stt",
    operation: "transcribe",
    payload: { audio: new Float32Array([0, 0.25]), sampleRate: 16_000 },
    signal: null,
  }), { text: "hello from whisper" });
  const speech = await kokoro.request({
    role: "tts",
    operation: "synthesize",
    payload: { text: "Hello" },
    signal: null,
  });
  assert.equal(speech.sampleRate, 24_000);
  assert.equal(speech.voice, "af_heart");
  assert.ok(speech.audio.every(Number.isFinite));

  await kokoro.unload();
  assert.equal(kokoro.status().state, "unloaded");
  assert.equal(whisper.status().state, "ready");
  assert.equal(workers.tts[0].terminated, true);
  assert.equal(workers.stt[0].terminated, false);
  const completionWrites = dbopfs.mutations.filter((entry) =>
    entry.operation === "write" && entry.name.endsWith(".complete.json"));
  assert.equal(completionWrites.length, 2);
  assert.equal(dbopfs.mutations.at(-1).name.endsWith(".complete.json"), true);
  await whisper.dispose();
  await kokoro.dispose();
});

test("browser speech providers normalize shared AI requests at one fail-closed boundary", async (t) => {
  const offlineAudioContextDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "OfflineAudioContext",
  );
  const webkitOfflineAudioContextDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "webkitOfflineAudioContext",
  );
  Object.defineProperty(globalThis, "OfflineAudioContext", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  Object.defineProperty(globalThis, "webkitOfflineAudioContext", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  t.after(() => {
    if (offlineAudioContextDescriptor) {
      Object.defineProperty(
        globalThis,
        "OfflineAudioContext",
        offlineAudioContextDescriptor,
      );
    } else {
      delete globalThis.OfflineAudioContext;
    }
    if (webkitOfflineAudioContextDescriptor) {
      Object.defineProperty(
        globalThis,
        "webkitOfflineAudioContext",
        webkitOfflineAudioContextDescriptor,
      );
    } else {
      delete globalThis.webkitOfflineAudioContext;
    }
  });

  const dbopfs = createMemoryDbopfs();
  const sources = new Map();
  for (const role of ["stt", "tts"]) {
    const options = providerOptions(role, null);
    for (const descriptor of [...options.runtime.files, ...options.model.files]) {
      sources.set(descriptor.url, role === "stt"
        ? descriptor.path === "runtime.mjs"
          ? new TextEncoder().encode("export const pipeline=()=>{};")
          : new Uint8Array([1, 2, 3])
        : descriptor.path === "runtime.mjs"
          ? new TextEncoder().encode("export class KokoroTTS{}")
          : new Uint8Array([4, 5, 6]));
    }
  }
  let objectUrl = 0;
  const store = createDbopfsSpeechArtifactStore({
    dbopfs,
    fetchImpl: async (url) => responseAt(
      url,
      sources.get(String(url)),
      { status: 200 },
    ),
    objectUrlFactory: {
      create: () => `blob:normalized-speech-${String(++objectUrl)}`,
      revoke: () => undefined,
    },
  });
  const workers = { stt: [], tts: [] };
  installContractWorker(t, ({ options }) => {
    const role = options.name.includes("whisper") ? "stt" : "tts";
    const contract = createSpeechWorkerContract({ role });
    workers[role].push(contract);
    return contract;
  });
  const whisper = createBrowserWhisperProvider(providerOptions("stt", store));
  const kokoro = createBrowserKokoroProvider(providerOptions("tts", store));

  const whisperCatalog = whisper.catalog();
  const kokoroCatalog = kokoro.catalog();
  assert.equal(Object.hasOwn(whisperCatalog[0], "defaultVoice"), false);
  assert.equal(kokoroCatalog[0].defaultVoice, "af_heart");
  assert.deepEqual(whisperCatalog[0].speech, { inputSampleRate: 16_000 });
  assert.deepEqual(kokoroCatalog[0].speech, {
    outputSampleRate: 24_000,
    responseFormats: ["wav"],
    defaultResponseFormat: "wav",
  });
  assert.equal(Object.isFrozen(whisperCatalog[0].speech), true);
  assert.equal(Object.isFrozen(kokoroCatalog[0].speech), true);
  assert.equal(Object.isFrozen(kokoroCatalog[0].speech.responseFormats), true);

  for (const provider of [whisper, kokoro]) {
    await provider.load({
      role: provider.role,
      selection: selection(provider),
      signal: null,
      progress: () => undefined,
      security: { checks: { sha256: true } },
    });
  }

  const nativeAudio = new Float32Array([0.125, -0.25]);
  await whisper.request({
    role: "stt",
    selection: selection(whisper),
    operation: "transcribe",
    payload: { audio: nativeAudio, sampleRate: 16_000 },
    signal: null,
  });
  const nativeUse = workers.stt[0].posted.find((message) => message.op === "use");
  assert.notEqual(nativeUse.payload.audio, nativeAudio);
  assert.deepEqual(nativeUse.payload.audio, nativeAudio);
  assert.equal(nativeUse.payload.sampleRate, 16_000);

  const sharedAudio = new Blob([new Uint8Array([9, 8, 7])], { type: "audio/webm" });
  const sharedTranscription = {
    audio: sharedAudio,
    mimeType: "audio/webm; codecs=opus",
    model: whisperCatalog[0].id,
  };
  const sttUseCount = () => workers.stt[0].posted.filter(
    (message) => message.op === "use",
  ).length;

  await assert.rejects(whisper.request({
    role: "stt",
    selection: selection(whisper),
    operation: "transcribe",
    payload: sharedTranscription,
    signal: null,
  }), (error) => error?.code === "ARCANE_AI_AUDIO_DECODE_UNAVAILABLE");
  assert.equal(sttUseCount(), 1);
  assert.equal(whisper.status().state, "ready");
  assert.equal(workers.stt[0].terminated, false);

  const decoderConstructions = [];
  const decoderInputs = [];
  let decodedSampleRate = 16_000;
  const channels = [
    new Float32Array([0.25, -0.5]),
    new Float32Array([0.75, 0.5]),
  ];
  Object.defineProperty(globalThis, "OfflineAudioContext", {
    configurable: true,
    writable: true,
    value: function ContractOfflineAudioContext(channelCount, length, sampleRate) {
      decoderConstructions.push({ channelCount, length, sampleRate });
      this.decodeAudioData = async function decodeContractAudio(encoded) {
        decoderInputs.push(new Uint8Array(encoded));
        return {
          sampleRate: decodedSampleRate,
          length: channels[0].length,
          numberOfChannels: channels.length,
          getChannelData(index) {
            return channels[index];
          },
        };
      };
    },
  });

  await assert.rejects(whisper.request({
    role: "stt",
    selection: { ...selection(whisper), modelId: "different-model" },
    operation: "transcribe",
    payload: sharedTranscription,
    signal: null,
  }), (error) => error?.code === "ARCANE_AI_MODEL_AUTHORITY_REQUIRED");
  await assert.rejects(whisper.request({
    role: "stt",
    selection: selection(whisper),
    operation: "transcribe",
    payload: { ...sharedTranscription, model: "different-model" },
    signal: null,
  }), (error) => error?.code === "ARCANE_AI_MODEL_AUTHORITY_REQUIRED");
  await assert.rejects(whisper.request({
    role: "stt",
    selection: selection(whisper),
    operation: "transcribe",
    payload: { ...sharedTranscription, mimeType: "audio/ogg" },
    signal: null,
  }), (error) => error?.code === "ARCANE_AI_INVALID_REQUEST");
  assert.equal(decoderInputs.length, 0);
  assert.equal(sttUseCount(), 1);

  decodedSampleRate = 48_000;
  await assert.rejects(whisper.request({
    role: "stt",
    selection: selection(whisper),
    operation: "transcribe",
    payload: sharedTranscription,
    signal: null,
  }), (error) => error?.code === "ARCANE_AI_AUDIO_DECODE_FAILED");
  assert.equal(sttUseCount(), 1);
  decodedSampleRate = 16_000;

  assert.deepEqual(await whisper.request({
    role: "stt",
    selection: selection(whisper),
    operation: "transcribe",
    payload: sharedTranscription,
    signal: null,
  }), { text: "hello from whisper" });
  assert.deepEqual(decoderConstructions, [
    { channelCount: 1, length: 1, sampleRate: 16_000 },
    { channelCount: 1, length: 1, sampleRate: 16_000 },
  ]);
  assert.deepEqual(decoderInputs.map((bytes) => [...bytes]), [
    [9, 8, 7],
    [9, 8, 7],
  ]);
  const sharedSttUse = workers.stt[0].posted.filter(
    (message) => message.op === "use",
  ).at(-1);
  assert.deepEqual([...sharedSttUse.payload.audio], [0.5, 0]);
  assert.equal(sharedSttUse.payload.sampleRate, 16_000);

  const ttsUseCount = () => workers.tts[0].posted.filter(
    (message) => message.op === "use",
  ).length;
  await assert.rejects(kokoro.request({
    role: "tts",
    selection: selection(kokoro),
    operation: "synthesize",
    payload: {
      model: "different-model",
      voice: "af_heart",
      input: "Wrong authority",
      responseFormat: "wav",
      speed: 1,
    },
    signal: null,
  }), (error) => error?.code === "ARCANE_AI_MODEL_AUTHORITY_REQUIRED");
  await assert.rejects(kokoro.request({
    role: "tts",
    selection: selection(kokoro),
    operation: "synthesize",
    payload: {
      model: kokoroCatalog[0].id,
      voice: "af_heart",
      input: "Unsupported",
      responseFormat: "mp3",
      speed: 1,
    },
    signal: null,
  }), (error) => error?.code === "ARCANE_AI_UNSUPPORTED_RESPONSE_FORMAT");
  assert.equal(ttsUseCount(), 0);

  const wav = await kokoro.request({
    role: "tts",
    selection: selection(kokoro),
    operation: "synthesize",
    payload: {
      model: kokoroCatalog[0].id,
      voice: "af_heart",
      input: "Shared synthesis",
      responseFormat: "wav",
      speed: 1.25,
    },
    signal: null,
  });
  const sharedTtsUse = workers.tts[0].posted.find((message) => message.op === "use");
  assert.deepEqual(sharedTtsUse.payload, {
    text: "Shared synthesis",
    voice: "af_heart",
    speed: 1.25,
  });
  assert.equal(wav.contentType, "audio/wav");
  assert.equal(wav.audio instanceof Uint8Array, true);
  assert.equal(new TextDecoder().decode(wav.audio.subarray(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(wav.audio.subarray(8, 12)), "WAVE");
  const wavView = new DataView(
    wav.audio.buffer,
    wav.audio.byteOffset,
    wav.audio.byteLength,
  );
  assert.equal(wavView.getUint32(24, true), 24_000);
  assert.equal(wavView.getInt16(44, true), 0);
  assert.equal(wavView.getInt16(46, true), 8192);
  assert.equal(wavView.getInt16(48, true), -8192);

  let resolveEncodedAudio;
  const encodedAudio = new Blob([new Uint8Array([1])], { type: "audio/webm" });
  Object.defineProperty(encodedAudio, "arrayBuffer", {
    configurable: true,
    value: function holdEncodedAudioRead() {
      return new Promise((resolve) => {
        resolveEncodedAudio = resolve;
      });
    },
  });
  const controller = new AbortController();
  const pendingRequest = whisper.request({
    role: "stt",
    selection: selection(whisper),
    operation: "transcribe",
    payload: {
      audio: encodedAudio,
      mimeType: "audio/webm",
      model: whisperCatalog[0].id,
    },
    signal: controller.signal,
  });
  assert.equal(whisper.status().busy, true);
  controller.abort();
  await assert.rejects(
    pendingRequest,
    (error) => error?.code === "ARCANE_AI_REQUEST_ABORTED"
      && error?.reason === "stt-transcription-cancelled",
  );
  assert.equal(whisper.status().busy, false);
  assert.equal(whisper.status().state, "ready");
  assert.equal(workers.stt[0].terminated, false);
  assert.equal(sttUseCount(), 2);
  resolveEncodedAudio(new Uint8Array([1]).buffer);

  await whisper.dispose();
  await kokoro.dispose();
});

test("coalesced speech loads preserve each caller's progress and cancellation", async (t) => {
  const options = providerOptions("stt", null);
  const sources = new Map([
    [options.runtime.files[0].url, new TextEncoder().encode("export const pipeline=()=>{};")],
    [options.model.files[0].url, new Uint8Array([1, 2, 3])],
  ]);
  let releaseFetch;
  const fetchGate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const store = createDbopfsSpeechArtifactStore({
    dbopfs: createMemoryDbopfs(),
    fetchImpl: async (url) => {
      await fetchGate;
      return responseAt(url, sources.get(String(url)), { status: 200 });
    },
    objectUrlFactory: {
      create: (() => {
        let id = 0;
        return () => `blob:coalesced-load-${String(++id)}`;
      })(),
      revoke: () => undefined,
    },
  });
  const contract = createSpeechWorkerContract({ role: "stt" });
  installContractWorker(t, () => contract);
  const whisper = createBrowserWhisperProvider(providerOptions("stt", store));
  const firstProgress = [];
  const secondProgress = [];
  const first = whisper.load({
    role: "stt",
    selection: selection(whisper),
    progress: (value) => firstProgress.push(value),
  });
  const second = whisper.load({
    role: "stt",
    selection: selection(whisper),
    progress: (value) => secondProgress.push(value),
  });
  const cancelledController = new AbortController();
  const cancelled = whisper.load({
    role: "stt",
    selection: selection(whisper),
    signal: cancelledController.signal,
    progress: () => undefined,
  });
  cancelledController.abort("caller-private-abort-text");
  await assert.rejects(
    cancelled,
    (error) => error?.code === "ARCANE_AI_REQUEST_ABORTED"
      && error?.reason === "stt-load-cancelled"
      && error?.cause === "caller-private-abort-text",
  );
  releaseFetch();
  const [firstStatus, secondStatus] = await Promise.all([first, second]);
  assert.equal(firstStatus.lifecycleStatus, "stt-provider-ready");
  assert.deepEqual(secondStatus, firstStatus);
  assert.ok(firstProgress.length > 0);
  assert.deepEqual(secondProgress, firstProgress);
  await whisper.unload({ role: "stt", selection: selection(whisper) });
});

test("unload preserves exact supersession during artifact preparation", async () => {
  const options = providerOptions("stt", null);
  let fetchStarted;
  const started = new Promise((resolve) => {
    fetchStarted = resolve;
  });
  const store = createDbopfsSpeechArtifactStore({
    dbopfs: createMemoryDbopfs(),
    fetchImpl: async (_url, { signal }) => {
      fetchStarted();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("artifact fetch cancelled");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
    objectUrlFactory: { create: () => "blob:never", revoke: () => undefined },
  });
  const whisper = createBrowserWhisperProvider(providerOptions("stt", store));
  const loading = whisper.load({
    role: "stt",
    selection: selection(whisper),
    progress: () => undefined,
  });
  await started;
  const unloading = whisper.unload({ role: "stt", selection: selection(whisper) });
  await assert.rejects(
    loading,
    (error) => error?.code === "ARCANE_AI_OPERATION_SUPERSEDED"
      && error?.reason === "stt-load-superseded-by-unload",
  );
  assert.equal((await unloading).lifecycleReason, "stt-unload-completed");
});

test("speech request cancellation terminates only the affected role Worker", async (t) => {
  const dbopfs = createMemoryDbopfs();
  const options = providerOptions("stt", null);
  const sources = new Map([
    [options.runtime.files[0].url, new TextEncoder().encode("export const pipeline=()=>{};")],
    [options.model.files[0].url, new Uint8Array([1, 2, 3])],
  ]);
  const store = createDbopfsSpeechArtifactStore({
    dbopfs,
    fetchImpl: async (url) => responseAt(url, sources.get(String(url)), { status: 200 }),
    objectUrlFactory: {
      create: (() => {
        let id = 0;
        return () => `blob:cancel-speech-${String(++id)}`;
      })(),
      revoke: () => undefined,
    },
  });
  const contract = createSpeechWorkerContract({ role: "stt", holdUse: true });
  installContractWorker(t, () => contract);
  const whisper = createBrowserWhisperProvider(providerOptions("stt", store));
  await whisper.load({
    role: "stt",
    selection: selection(whisper),
    signal: null,
    progress: () => undefined,
    security: { checks: { sha256: true } },
  });
  const controller = new AbortController();
  const request = whisper.request({
    role: "stt",
    operation: "transcribe",
    payload: { audio: new Float32Array([0]), sampleRate: 16_000 },
    signal: controller.signal,
  });
  for (let attempt = 0; attempt < 10
    && !contract.posted.some((message) => message.op === "use"); attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(contract.posted.some((message) => message.op === "use"), true);
  controller.abort();
  await assert.rejects(
    request,
    (error) => error?.code === "ARCANE_AI_REQUEST_ABORTED"
      && error?.reason === "stt-transcription-cancelled",
  );
  assert.equal(contract.terminated, true);
  assert.equal(whisper.status().state, "unloaded");
  assert.equal(whisper.status().lifecycleStatus, "stt-provider-unloaded");
  assert.equal(whisper.status().lifecycleReason, "stt-transcription-cancelled");
});

test("unload preserves exact supersession during pre-Worker audio decoding", async (t) => {
  const options = providerOptions("stt", null);
  const sources = new Map([
    [options.runtime.files[0].url, new TextEncoder().encode("export const pipeline=()=>{};")],
    [options.model.files[0].url, new Uint8Array([1, 2, 3])],
  ]);
  const store = createDbopfsSpeechArtifactStore({
    dbopfs: createMemoryDbopfs(),
    fetchImpl: async (url) => responseAt(url, sources.get(String(url)), { status: 200 }),
    objectUrlFactory: {
      create: (() => {
        let id = 0;
        return () => `blob:unload-decode-${String(++id)}`;
      })(),
      revoke: () => undefined,
    },
  });
  const contract = createSpeechWorkerContract({ role: "stt" });
  installContractWorker(t, () => contract);
  const decoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "OfflineAudioContext");
  let decodingStarted;
  const started = new Promise((resolve) => {
    decodingStarted = resolve;
  });
  Object.defineProperty(globalThis, "OfflineAudioContext", {
    configurable: true,
    writable: true,
    value: function PendingSpeechDecoder() {
      this.decodeAudioData = () => {
        decodingStarted();
        return new Promise(() => undefined);
      };
    },
  });
  t.after(() => {
    if (decoderDescriptor) {
      Object.defineProperty(globalThis, "OfflineAudioContext", decoderDescriptor);
    } else {
      delete globalThis.OfflineAudioContext;
    }
  });
  const whisper = createBrowserWhisperProvider(providerOptions("stt", store));
  await whisper.load({
    role: "stt",
    selection: selection(whisper),
    progress: () => undefined,
  });
  const request = whisper.request({
    role: "stt",
    operation: "transcribe",
    selection: selection(whisper),
    payload: {
      audio: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
      mimeType: "audio/wav",
      model: whisper.catalog()[0].id,
    },
  });
  await started;
  const unloading = whisper.unload({ role: "stt", selection: selection(whisper) });
  await assert.rejects(
    request,
    (error) => error?.code === "ARCANE_AI_OPERATION_SUPERSEDED"
      && error?.reason === "stt-transcription-superseded-by-unload",
  );
  const status = await unloading;
  assert.equal(status.lifecycleStatus, "stt-provider-unloaded");
  assert.equal(status.lifecycleReason, "stt-unload-completed");
});

test("secure speech admission rejects altered bytes before creating a Worker", async (t) => {
  const dbopfs = createMemoryDbopfs();
  const options = providerOptions("tts", null);
  let workers = 0;
  const store = createDbopfsSpeechArtifactStore({
    dbopfs,
    fetchImpl: async (url) => responseAt(url, new Uint8Array([9, 9, 9]), { status: 200 }),
    objectUrlFactory: { create: () => "blob:never", revoke: () => undefined },
  });
  installContractWorker(t, () => {
    workers += 1;
    return createSpeechWorkerContract({ role: "tts" });
  });
  const kokoro = createBrowserKokoroProvider(providerOptions("tts", store));
  await assert.rejects(
    kokoro.load({
      role: "tts",
      selection: selection(kokoro),
      signal: null,
      progress: () => undefined,
      security: { secure: true },
    }),
    (error) => error?.code === "ARCANE_AI_ARTIFACT_DIGEST_MISMATCH"
      || error?.code === "ARCANE_AI_ARTIFACT_SIZE_MISMATCH",
  );
  assert.equal(workers, 0);
  assert.equal(
    [...dbopfs.entries.keys()].some((name) => name.endsWith(".complete.json")),
    false,
  );
});

test("speech artifact admission rejects redirect drift and executable module-loader escapes", async () => {
  const redirectedDbopfs = createMemoryDbopfs();
  const redirectedOptions = providerOptions("stt", null);
  const redirectedStore = createDbopfsSpeechArtifactStore({
    dbopfs: redirectedDbopfs,
    fetchImpl: async (url) => responseAt(
      `https://redirected.example/${encodeURIComponent(String(url))}`,
      new Uint8Array([1]),
      { status: 200, redirected: true },
    ),
    objectUrlFactory: { create: () => "blob:redirect-never", revoke: () => undefined },
  });
  const redirectedAuthority = createBrowserSpeechAuthority({
    providerId: "redirected-speech",
    role: "stt",
    model: redirectedOptions.model,
    runtime: redirectedOptions.runtime,
    security: { secure: true },
  });
  await assert.rejects(
    redirectedStore.prepare(redirectedAuthority, {
      security: { secure: true },
      onProgress: () => undefined,
    }),
    (error) => error?.code === "ARCANE_AI_ARTIFACT_SOURCE_CHANGED",
  );

  const importedRuntime = new TextEncoder().encode(
    'import "https://unadmitted.example/runtime.mjs"; export const pipeline=()=>{};',
  );
  const importedOptions = providerOptions("stt", null);
  importedOptions.runtime = {
    ...importedOptions.runtime,
    files: [file("runtime.mjs", importedRuntime)],
  };
  const importedSources = new Map([
    [importedOptions.runtime.files[0].url, importedRuntime],
    [importedOptions.model.files[0].url, new Uint8Array([1, 2, 3])],
  ]);
  const importedDbopfs = createMemoryDbopfs();
  let objectUrls = 0;
  const importedStore = createDbopfsSpeechArtifactStore({
    dbopfs: importedDbopfs,
    fetchImpl: async (url) => responseAt(
      url,
      importedSources.get(String(url)),
      { status: 200 },
    ),
    objectUrlFactory: {
      create: () => {
        objectUrls += 1;
        return `blob:imported-runtime-${String(objectUrls)}`;
      },
      revoke: () => undefined,
    },
  });
  const importedAuthority = createBrowserSpeechAuthority({
    providerId: "imported-runtime-speech",
    role: "stt",
    model: importedOptions.model,
    runtime: importedOptions.runtime,
    security: { secure: true },
  });
  await assert.rejects(
    importedStore.prepare(importedAuthority, {
      security: { secure: true },
      onProgress: () => undefined,
    }),
    (error) => error?.code === "ARCANE_AI_RUNTIME_MODULE_GRAPH_UNDECLARED",
  );
  assert.equal(objectUrls, 0);
  assert.equal(
    [...importedDbopfs.entries.keys()].some((name) => name.endsWith(".complete.json")),
    false,
  );

  const escapedRuntimeSources = Object.freeze([
    'export const run=()=>new Function("return import(\'https://unadmitted.example/runtime.mjs\')")();',
    'export const run=()=>new Worker("https://unadmitted.example/child.mjs",{type:"module"});',
    'export const run=()=>importScripts("https://unadmitted.example/child.js");',
    'export const run=()=>new WebSocket("wss://unadmitted.example/socket");',
    String.raw`export const run=()=>globalThis["\u0046unction"]("return 1")();`,
    'export const run=()=>globalThis["Fun"+"ction"]("return 1")();',
    'export const compile=(factory)=>factory("return im"+"port(\'https://unadmitted.example/runtime.mjs\')");',
    'export const run=()=>new globalThis["Work"+"er"]("https://unadmitted.example/child.mjs",{type:"module"});',
    'export const run=()=>new globalThis["XMLHttp"+"Request"]();',
    'export const run=()=>new globalThis[`Work${"er"}`]("https://unadmitted.example/child.mjs",{type:"module"});',
    'export const compile=(factory)=>factory(`return im${"port"}("https://unadmitted.example/runtime.mjs")`);',
    'export const run=()=>new globalThis["Shared".concat("Worker")]("https://unadmitted.example/child.mjs");',
  ]);
  for (let index = 0; index < escapedRuntimeSources.length; index += 1) {
    const runtimeBytes = new TextEncoder().encode(escapedRuntimeSources[index]);
    const escapedOptions = providerOptions("stt", null);
    escapedOptions.runtime = {
      ...escapedOptions.runtime,
      files: [file("runtime.mjs", runtimeBytes)],
    };
    const escapedSources = new Map([
      [escapedOptions.runtime.files[0].url, runtimeBytes],
      [escapedOptions.model.files[0].url, new Uint8Array([1, 2, 3])],
    ]);
    const escapedDbopfs = createMemoryDbopfs();
    let escapedObjectUrls = 0;
    const escapedStore = createDbopfsSpeechArtifactStore({
      dbopfs: escapedDbopfs,
      fetchImpl: async (url) => responseAt(
        url,
        escapedSources.get(String(url)),
        { status: 200 },
      ),
      objectUrlFactory: {
        create: () => {
          escapedObjectUrls += 1;
          return "blob:escape-never";
        },
        revoke: () => undefined,
      },
    });
    const escapedAuthority = createBrowserSpeechAuthority({
      providerId: `escaped-runtime-${String(index)}`,
      role: "stt",
      model: escapedOptions.model,
      runtime: escapedOptions.runtime,
      security: { secure: true },
    });
    await assert.rejects(
      escapedStore.prepare(escapedAuthority, {
        security: { secure: true },
        onProgress: () => undefined,
      }),
      (error) => error?.code === "ARCANE_AI_RUNTIME_MODULE_GRAPH_UNDECLARED",
    );
    assert.equal(escapedObjectUrls, 0);
    assert.equal(
      [...escapedDbopfs.entries.keys()].some((name) => name.endsWith(".complete.json")),
      false,
    );
  }
});

test("speech artifact keys avoid lossy-name collisions and serialize same-key preparation", async () => {
  const dbopfs = createMemoryDbopfs();
  const options = providerOptions("stt", null);
  const sources = new Map([
    [options.runtime.files[0].url, new TextEncoder().encode("export const pipeline=()=>{};")],
    [options.model.files[0].url, new Uint8Array([1, 2, 3])],
  ]);
  const store = createDbopfsSpeechArtifactStore({
    dbopfs,
    fetchImpl: async (url) => responseAt(url, sources.get(String(url)), { status: 200 }),
    objectUrlFactory: {
      create: (() => {
        let id = 0;
        return () => `blob:serialized-speech-${String(++id)}`;
      })(),
      revoke: () => undefined,
    },
  });
  const first = createBrowserSpeechAuthority({
    providerId: "speech/a",
    role: "stt",
    model: options.model,
    runtime: options.runtime,
    security: { secure: true },
  });
  const second = createBrowserSpeechAuthority({
    providerId: "speech?a",
    role: "stt",
    model: options.model,
    runtime: options.runtime,
    security: { secure: true },
  });
  const prepared = await Promise.all([
    store.prepare(first, { security: { secure: true }, onProgress: () => undefined }),
    store.prepare(first, { security: { secure: true }, onProgress: () => undefined }),
    store.prepare(second, { security: { secure: true }, onProgress: () => undefined }),
  ]);
  for (const result of prepared) result.release();
  assert.equal(
    [...dbopfs.entries.keys()].filter((name) => name.endsWith(".complete.json")).length,
    2,
  );
  assert.deepEqual(prepared.slice(0, 2).map((result) => result.cache), ["installed", "cached"]);
});

test("speech artifact admission fails closed on cross-store same-authority contention", async () => {
  const dbopfs = createMemoryDbopfs();
  const options = providerOptions("stt", null);
  const runtimeBytes = new TextEncoder().encode("export const pipeline=()=>{};");
  const modelBytes = new Uint8Array([1, 2, 3]);
  const sources = new Map([
    [options.runtime.files[0].url, runtimeBytes],
    [options.model.files[0].url, modelBytes],
  ]);
  let releaseFetch;
  const fetchGate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  let signalFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    signalFetchStarted = resolve;
  });
  const firstStore = createDbopfsSpeechArtifactStore({
    dbopfs,
    fetchImpl: async (url) => {
      signalFetchStarted();
      await fetchGate;
      return responseAt(url, sources.get(String(url)), { status: 200 });
    },
    objectUrlFactory: { create: () => "blob:first-store", revoke: () => undefined },
  });
  const competingStore = createDbopfsSpeechArtifactStore({
    dbopfs,
    fetchImpl: async () => {
      throw new Error("the contending store must not begin artifact I/O");
    },
    objectUrlFactory: { create: () => "blob:competing-store", revoke: () => undefined },
  });
  const authority = createBrowserSpeechAuthority({
    providerId: "cross-context-speech",
    role: "stt",
    model: options.model,
    runtime: options.runtime,
    security: { secure: true },
  });

  const firstPreparation = firstStore.prepare(authority, {
    security: { secure: true },
    onProgress: () => undefined,
  });
  await fetchStarted;
  await assert.rejects(
    competingStore.prepare(authority, {
      security: { secure: true },
      onProgress: () => undefined,
    }),
    (error) => error?.code === "ARCANE_AI_STORAGE_BUSY",
  );
  releaseFetch();
  const prepared = await firstPreparation;
  prepared.release();
  assert.equal(
    [...dbopfs.entries.keys()].filter((name) => name.endsWith(".complete.json")).length,
    1,
  );
});

test("an unexpected ready speech Worker crash remains a visible provider error", async (t) => {
  const dbopfs = createMemoryDbopfs();
  const options = providerOptions("stt", null);
  const sources = new Map([
    [options.runtime.files[0].url, new TextEncoder().encode("export const pipeline=()=>{};")],
    [options.model.files[0].url, new Uint8Array([1, 2, 3])],
  ]);
  const store = createDbopfsSpeechArtifactStore({
    dbopfs,
    fetchImpl: async (url) => responseAt(url, sources.get(String(url)), { status: 200 }),
    objectUrlFactory: {
      create: (() => {
        let id = 0;
        return () => `blob:crash-speech-${String(++id)}`;
      })(),
      revoke: () => undefined,
    },
  });
  const contract = createSpeechWorkerContract({ role: "stt" });
  installContractWorker(t, () => contract);
  const whisper = createBrowserWhisperProvider(providerOptions("stt", store));
  await whisper.load({
    role: "stt",
    selection: selection(whisper),
    signal: null,
    progress: () => undefined,
    security: { secure: true },
  });

  contract.crash();
  await new Promise((resolve) => queueMicrotask(resolve));

  assert.equal(whisper.status().state, "error");
  assert.equal(whisper.status().errorCode, "ARCANE_AI_WORKER_CRASHED");
  assert.equal(contract.terminated, true);
});

import assert from "node:assert/strict";

import test from "../src/testing.mjs";
import {
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

function notFound() {
  const error = new Error("not found");
  error.name = "NotFoundError";
  return error;
}

function createMemoryLockManager() {
  const held = new Set();
  return {
    async request(name, options, callback) {
      if (options?.mode !== "exclusive" || options?.ifAvailable !== true) {
        throw new Error("speech test locks must be exclusive and nonblocking");
      }
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name, mode: "exclusive" });
      } finally {
        held.delete(name);
      }
    },
  };
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
  return {
    readyPromise: Promise.resolve(),
    getTableHandle: async () => directory,
    lockManager,
    entries,
    mutations,
  };
}

function responseAt(url, body, init = {}) {
  const response = new Response(body, init);
  Object.defineProperties(response, {
    redirected: { configurable: true, value: init.redirected === true },
    url: { configurable: true, value: String(url) },
  });
  return response;
}

function providerFile(role, path, mediaType) {
  return {
    path,
    url: `https://speech.example/${role}/${path}`,
    mediaType,
  };
}

function providerOptions(role, store) {
  return {
    store,
    runtime: {
      adapter: role === "stt" ? "transformers-whisper" : "kokoro-js",
      version: role === "stt" ? "4.2.0" : "1.2.1",
      revision: role === "stt" ? "transformers-source" : "kokoro-source",
      entry: "runtime.mjs",
      files: [providerFile(role, "runtime.mjs", "text/javascript")],
    },
    model: {
      id: role === "stt" ? "whisper-test" : "kokoro-test",
      repository: role === "stt" ? "example/whisper" : "example/kokoro",
      revision: role === "stt" ? "whisper-revision" : "kokoro-revision",
      dtype: "q8",
      defaultVoice: role === "tts" ? "af_heart" : undefined,
      files: [providerFile(role, "model.onnx", "application/octet-stream")],
    },
  };
}

function sourceContent(role) {
  return role === "stt"
    ? {
      runtime: "export const completeRuntimeSource = 'whisper runtime content';",
      model: new Uint8Array([1, 2, 3, 4]),
    }
    : {
      runtime: "export const completeRuntimeSource = 'kokoro runtime content';",
      model: new Uint8Array([5, 6, 7, 8]),
    };
}

function sourceMap(roles) {
  const sources = new Map();
  for (const role of roles) {
    const options = providerOptions(role, null);
    const content = sourceContent(role);
    sources.set(options.runtime.files[0].url, content.runtime);
    sources.set(options.model.files[0].url, content.model);
  }
  return sources;
}

function createMemoryStore(roles, {
  dbopfs = createMemoryDbopfs(),
  fetchImpl = null,
  materialized = [],
} = {}) {
  const sources = sourceMap(roles);
  let objectUrl = 0;
  const store = createDbopfsSpeechArtifactStore({
    dbopfs,
    fetchImpl: fetchImpl ?? (async (url) => {
      if (!sources.has(String(url))) return responseAt(url, null, { status: 404 });
      return responseAt(url, sources.get(String(url)), { status: 200 });
    }),
    objectUrlFactory: {
      create(blob) {
        materialized.push(blob);
        objectUrl += 1;
        return `blob:arcane-speech-${String(objectUrl)}`;
      },
      revoke() {},
    },
  });
  return { dbopfs, materialized, sources, store };
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
  return {
    providerId: provider.id,
    modelId: provider.catalog()[0].id,
    role: provider.role,
    localOnly: true,
  };
}

function selfContainedWorkerConfiguration(source, role = "stt") {
  const moduleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
  return {
    role,
    runtime: {
      adapter: role === "stt" ? "transformers-whisper" : "kokoro-js",
      moduleGraph: "self-contained",
      entry: "runtime.mjs",
      files: [{
        path: "runtime.mjs",
        sourceUrl: `https://speech.example/${role}/runtime.mjs`,
        moduleUrl,
        mediaType: "text/javascript",
      }],
    },
    model: {
      id: role === "stt" ? "complete-whisper" : "complete-kokoro",
      repository: role === "stt" ? "example/complete-whisper" : "example/complete-kokoro",
      revision: "caller-selected-revision",
      dtype: "q8",
      defaultVoice: role === "tts" ? "af_heart" : undefined,
      files: [],
    },
  };
}

function whisperRuntimeSource(operationSource) {
  return `
    export const env = {
      allowLocalModels: true,
      allowRemoteModels: false,
      useBrowserCache: true,
      useFSCache: false,
      useCustomCache: false,
      customCache: null,
      backends: { onnx: { wasm: {} } },
    };
    export async function pipeline(_task, _repository, options) {
      globalThis.__arcaneSelectedSpeechDtype = options.dtype;
      ${operationSource}
    }
  `;
}

function kokoroRuntimeSource(operationSource) {
  return `
    export const env = { wasmPaths: null };
    export const KokoroTTS = {
      async from_pretrained(_repository, options) {
        globalThis.__arcaneSelectedSpeechDtype = options.dtype;
        globalThis.__arcaneSelectedSpeechDevice = options.device;
        ${operationSource}
      },
    };
  `;
}

function ordinaryArtifactGraphFixture() {
  const runtimeRevision = "runtime-selection";
  const modelRevision = "model-selection";
  const entrySource = `
    import "runtime-package";
    import { helper } from "./helper.mjs";
    const fetch = (value) => value;
    export async function load() {
      fetch("../model/model.onnx");
      await globalThis.fetch("../model/model.onnx");
      return helper;
    }
  `;
  const sources = new Map([
    ["https://speech.example/runtime/entry.mjs", entrySource],
    ["https://speech.example/runtime/helper.mjs", "export const helper = 'complete helper';"],
    ["https://speech.example/runtime/ort.mjs", "export const wasm = {};"],
    ["https://speech.example/runtime/ort.wasm", new Uint8Array([0, 97, 115, 109])],
    ["https://speech.example/model/model.onnx", new Uint8Array([1, 2, 3])],
  ]);
  const file = (kind, path, revision, mediaType) => ({
    kind,
    path,
    sourceUrl: `https://speech.example/${path}`,
    revision,
    mediaType,
  });
  const graph = createBrowserSpeechArtifactGraph({
    providerId: "ordinary-graph-whisper",
    role: "stt",
    model: {
      id: "ordinary-graph-model",
      repository: "example/ordinary-graph-model",
      revision: modelRevision,
      dtype: "q8",
      inputSampleRate: 16_000,
    },
    runtime: {
      adapter: "transformers-whisper",
      version: "4.2.0",
      revision: runtimeRevision,
      entrypoint: "runtime/entry.mjs",
      onnxWasm: {
        namespace: "transformers-env-backends-onnx-wasm",
        mjsPath: "runtime/ort.mjs",
        wasmPath: "runtime/ort.wasm",
      },
    },
    files: [
      {
        ...file("runtime-entrypoint-javascript", "runtime/entry.mjs", runtimeRevision, "text/javascript"),
        license: "complete caller-supplied upstream note",
      },
      file("runtime-auxiliary-javascript", "runtime/helper.mjs", runtimeRevision, "text/javascript"),
      file("runtime-auxiliary-javascript", "runtime/ort.mjs", runtimeRevision, "text/javascript"),
      file("runtime-wasm-binary", "runtime/ort.wasm", runtimeRevision, "application/wasm"),
      file("model-onnx-binary", "model/model.onnx", modelRevision, "application/octet-stream"),
    ],
  });
  return { graph, sources };
}

test("browser speech authority preserves complete caller metadata and q8", () => {
  const options = providerOptions("stt", null);
  const authority = createBrowserSpeechAuthority({
    providerId: "complete-whisper",
    role: "stt",
    model: options.model,
    runtime: options.runtime,
  });

  assert.equal(authority.dtype, "q8");
  assert.deepEqual(authority.runtime.files, [{
    path: "runtime.mjs",
    url: "https://speech.example/stt/runtime.mjs",
    mediaType: "text/javascript",
  }]);
  assert.deepEqual(authority.files, [{
    path: "model.onnx",
    url: "https://speech.example/stt/model.onnx",
    mediaType: "application/octet-stream",
  }]);
  authority.annotation = "caller metadata";
  assert.equal(authority.annotation, "caller metadata");

  assert.throws(
    () => createBrowserSpeechAuthority({
      providerId: "credential-url",
      role: "stt",
      model: options.model,
      runtime: {
        ...options.runtime,
        files: [{
          ...options.runtime.files[0],
          url: "https://example-user:example-secret@speech.example/runtime.mjs",
        }],
      },
    }),
    /must not contain credentials/u,
  );
  assert.throws(
    () => createBrowserSpeechAuthority({
      providerId: "malformed-path",
      role: "stt",
      model: options.model,
      runtime: {
        ...options.runtime,
        entry: "../runtime.mjs",
        files: [{ ...options.runtime.files[0], path: "../runtime.mjs" }],
      },
    }),
    /normalized relative path/u,
  );
});

test("speech Worker preserves q8 and complete mutable transcription content", async () => {
  const transcript = "  complete transcript\nwith every trailing detail  ";
  const runtime = createSpeechWorkerRuntime({ role: "stt", send() {} });
  await runtime.handleMessage({
    protocol: SPEECH_WORKER_PROTOCOL,
    id: 1,
    op: "load",
    payload: {
      configuration: selfContainedWorkerConfiguration(
        whisperRuntimeSource(`
          const transcriber = async () => ({ text: ${JSON.stringify(transcript)} });
          transcriber.dispose = async () => undefined;
          return transcriber;
        `),
      ),
    },
  });

  const result = await runtime.handleMessage({
    protocol: SPEECH_WORKER_PROTOCOL,
    id: 2,
    op: "use",
    payload: { audio: new Float32Array([0, 0.25]), sampleRate: 16_000 },
  });
  assert.equal(globalThis.__arcaneSelectedSpeechDtype, "q8");
  assert.deepEqual(result, { text: transcript });
  result.annotation = "mutable caller result";
  assert.equal(result.annotation, "mutable caller result");

  await runtime.handleMessage({
    protocol: SPEECH_WORKER_PROTOCOL,
    id: 3,
    op: "unload",
    payload: null,
  });
  delete globalThis.__arcaneSelectedSpeechDtype;
});

test("speech Worker preserves complete synthesis text", async () => {
  const text = "  complete synthesis text\nwith every trailing detail  ";
  const runtime = createSpeechWorkerRuntime({ role: "tts", send() {} });
  await runtime.handleMessage({
    protocol: SPEECH_WORKER_PROTOCOL,
    id: 1,
    op: "load",
    payload: {
      configuration: {
        ...selfContainedWorkerConfiguration(
          kokoroRuntimeSource(`
            return {
              async generate(input) {
                globalThis.__arcaneCompleteSynthesisText = input;
                return { audio: new Float32Array([0.25]), sampling_rate: 24_000 };
              },
              async dispose() {},
            };
          `),
          "tts",
        ),
        execution: { device: "webgpu" },
      },
    },
  });

  const result = await runtime.handleMessage({
    protocol: SPEECH_WORKER_PROTOCOL,
    id: 2,
    op: "use",
    payload: { text, voice: "af_heart", speed: 1 },
  });
  assert.equal(globalThis.__arcaneSelectedSpeechDtype, "q8");
  assert.equal(globalThis.__arcaneSelectedSpeechDevice, "webgpu");
  assert.equal(globalThis.__arcaneCompleteSynthesisText, text);
  assert.deepEqual(result, {
    audio: new Float32Array([0.25]),
    sampleRate: 24_000,
    voice: "af_heart",
  });

  await runtime.handleMessage({
    protocol: SPEECH_WORKER_PROTOCOL,
    id: 3,
    op: "unload",
    payload: null,
  });
  delete globalThis.__arcaneSelectedSpeechDtype;
  delete globalThis.__arcaneSelectedSpeechDevice;
  delete globalThis.__arcaneCompleteSynthesisText;
});

test("Kokoro defaults to automatic GPU selection and a four-Worker pool", async function defaultKokoroWorkerPool(t) {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { gpu: {} },
  });
  t.after(function restoreNavigatorAfterDefaultKokoroPool() {
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
  });

  const { store } = createMemoryStore(["tts"]);
  const workers = [];
  installContractWorker(t, function createDefaultKokoroWorker() {
    const contract = createSpeechWorkerContract({
      role: "tts",
      holdUse: true,
      workerId: workers.length,
    });
    workers.push(contract);
    return contract;
  });
  const kokoro = createBrowserKokoroProvider(providerOptions("tts", store));

  assert.equal(kokoro.maxConcurrentRequests, 4);
  assert.deepEqual(kokoro.status().execution, {
    requestedDevice: "auto",
    selectedDevice: null,
    maxConcurrentRequests: 4,
    activeRequestCount: 0,
  });
  const ready = await kokoro.load({ role: "tts", selection: selection(kokoro) });
  assert.equal(workers.length, 4);
  assert.ok(workers.every(function defaultWorkerSelectedWebGpu(contract) {
    return contract.posted.find(
      function findDefaultWorkerLoad(message) { return message.op === "load"; },
    )?.payload.configuration.execution.device === "webgpu";
  }));
  assert.deepEqual(ready.execution, {
    requestedDevice: "auto",
    selectedDevice: "webgpu",
    maxConcurrentRequests: 4,
    activeRequestCount: 0,
  });

  const useArrivals = workers.map(function waitForDefaultSlotUse(contract) {
    return contract.waitForUse();
  });
  const requests = workers.map(function synthesizeInDefaultSlot(contract, index) {
    return kokoro.request({
      role: "tts",
      operation: "synthesize",
      payload: { text: `Segment ${index + 1}.`, voice: "af_heart", speed: 1 },
    });
  });
  const uses = await Promise.all(useArrivals);
  assert.equal(kokoro.status().execution.activeRequestCount, 4);
  for (let index = workers.length - 1; index >= 0; index -= 1) {
    assert.equal(uses[index].payload.text, `Segment ${index + 1}.`);
    assert.equal(workers[index].releaseUse(uses[index].id), true);
    await requests[index];
  }
  await Promise.all(requests);
  assert.equal(kokoro.status().execution.activeRequestCount, 0);

  await kokoro.unload();
  assert.ok(workers.every(function defaultWorkerTerminated(contract) {
    return contract.terminated;
  }));
});

test("automatic Kokoro execution replaces a rejected WebGPU pool with WASM", async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { gpu: {} },
  });
  t.after(function restoreNavigatorAfterKokoroFallback() {
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
  });

  const rejectedLoad = {
    protocol: "arcane-ai-speech-worker-error/1",
    code: "ARCANE_AI_PROVIDER_REQUEST_FAILED",
    message: "The speech engine operation was rejected.",
    reason: "tts-worker-model-load-rejected",
  };
  const { store, materialized } = createMemoryStore(["tts"]);
  const workers = [];
  installContractWorker(t, function createWebGpuThenWasmWorker() {
    const contract = createSpeechWorkerContract({
      role: "tts",
      workerId: workers.length,
      responseError: function rejectOnlyWebGpuLoad(message) {
        return message.op === "load"
          && message.payload?.configuration.execution.device === "webgpu"
          ? rejectedLoad
          : null;
      },
    });
    workers.push(contract);
    return contract;
  });
  const kokoro = createBrowserKokoroProvider(providerOptions("tts", store));

  const ready = await kokoro.load({ role: "tts", selection: selection(kokoro) });
  assert.equal(workers.length, 5);
  assert.equal(materialized.length, 2, "GPU fallback must reuse one prepared artifact set.");
  assert.equal(workers[0].terminated, true);
  assert.ok(workers.slice(1).every(function replacementWorkerSelectedWasm(contract) {
    return contract.posted.find(function findReplacementLoad(message) {
      return message.op === "load";
    })?.payload.configuration.execution.device === "wasm";
  }));
  assert.equal(ready.execution.selectedDevice, "wasm");

  await kokoro.unload();
  assert.ok(workers.every(function allCandidateWorkersWereTerminated(contract) {
    return contract.terminated;
  }));
});

test("speech execution options retain one STT slot and bounded TTS capacity", () => {
  const { store } = createMemoryStore(["stt", "tts"]);
  const whisperOptions = providerOptions("stt", store);
  const kokoroOptions = providerOptions("tts", store);

  const whisper = createBrowserWhisperProvider(whisperOptions);
  assert.equal(whisper.maxConcurrentRequests, 1);
  assert.throws(
    () => createBrowserWhisperProvider({
      ...whisperOptions,
      execution: { device: "wasm", maxConcurrentRequests: 1 },
    }),
    /does not accept an execution option/u,
  );
  assert.throws(
    () => createBrowserKokoroProvider({
      ...kokoroOptions,
      execution: { device: "cpu", maxConcurrentRequests: 2 },
    }),
    /must be "auto", "webgpu", or "wasm"/u,
  );
  assert.throws(
    () => createBrowserKokoroProvider({
      ...kokoroOptions,
      execution: { device: "wasm", maxConcurrentRequests: 5 },
    }),
    /safe integer from 1 through 4/u,
  );
  const singleKokoro = createBrowserKokoroProvider({
    ...kokoroOptions,
    execution: { device: "wasm", maxConcurrentRequests: 1 },
  });
  assert.equal(singleKokoro.maxConcurrentRequests, 1);
  assert.deepEqual(singleKokoro.status().execution, {
    requestedDevice: "wasm",
    selectedDevice: null,
    maxConcurrentRequests: 1,
    activeRequestCount: 0,
  });
  for (const maxConcurrentRequests of [2, 3, 4]) {
    const configuredKokoro = createBrowserKokoroProvider({
      ...kokoroOptions,
      execution: { device: "wasm", maxConcurrentRequests },
    });
    assert.equal(configuredKokoro.maxConcurrentRequests, maxConcurrentRequests);
    assert.equal(configuredKokoro.status().execution.maxConcurrentRequests, maxConcurrentRequests);
  }
});

test("ordinary artifact graph routing preserves native imports and local bindings", async () => {
  const fixture = ordinaryArtifactGraphFixture();
  const materialized = [];
  const store = createDbopfsSpeechArtifactStore({
    dbopfs: createMemoryDbopfs(),
    fetchImpl: async (url) => responseAt(url, fixture.sources.get(String(url)), { status: 200 }),
    objectUrlFactory: {
      create(blob) {
        const moduleUrl = `blob:ordinary-graph-${String(materialized.length + 1)}`;
        materialized.push({ blob, moduleUrl });
        return moduleUrl;
      },
      revoke() {},
    },
  });
  const prepared = await store.prepare(fixture.graph);
  try {
    assert.equal(
      fixture.graph.files.find((file) => file.path === "runtime/entry.mjs")?.license,
      "complete caller-supplied upstream note",
    );
    assert.equal(
      prepared.runtime.files.some((file) => Object.hasOwn(file, "license")),
      false,
    );
    const sources = await Promise.all(materialized.map(async ({ blob }) => blob.text()));
    const entry = sources.find((source) => source.includes('import "runtime-package"'));
    assert.ok(entry);
    assert.match(entry, /from "blob:ordinary-graph-/u);
    assert.match(entry, /fetch\("[.][.]\/model\/model[.]onnx"\)/u);
    assert.match(
      entry,
      /globalThis[.]__arcaneBrowserSpeechModuleRouterV1[.]fetch\("runtime\/entry[.]mjs","[.][.]\/model\/model[.]onnx"\)/u,
    );
  } finally {
    prepared.release();
  }
});

test("ordinary provider loading materializes complete source content", async (t) => {
  const materialized = [];
  const { dbopfs, store } = createMemoryStore(["stt"], { materialized });
  const contract = createSpeechWorkerContract({ role: "stt" });
  installContractWorker(t, () => contract);
  const whisper = createBrowserWhisperProvider(providerOptions("stt", store));

  const ready = await whisper.load({
    role: "stt",
    selection: selection(whisper),
  });
  assert.equal(ready.state, "ready");
  ready.annotation = "mutable ready state";
  assert.equal(ready.annotation, "mutable ready state");
  const loadRequest = contract.posted.find((message) => message.op === "load");
  assert.equal(loadRequest.payload.configuration.model.dtype, "q8");

  const runtimeBlob = materialized.find((blob) => blob.type === "text/javascript");
  assert.ok(runtimeBlob);
  assert.equal(await runtimeBlob.text(), sourceContent("stt").runtime);
  assert.equal(dbopfs.entries.size > 0, true);

  const response = await whisper.request({
    role: "stt",
    operation: "transcribe",
    payload: { audio: new Float32Array([0]), sampleRate: 16_000 },
  });
  assert.deepEqual(response, { text: "hello from whisper" });
  response.annotation = "mutable provider response";
  assert.equal(response.annotation, "mutable provider response");
  await whisper.dispose();
});

test("speech Worker exposes complete local errors through SDK-owned envelopes", async () => {
  const completeFailure = "provider failure with complete diagnostic context and every trailing detail";
  const messages = [];
  const runtime = createSpeechWorkerRuntime({
    role: "stt",
    send(message) {
      messages.push(message);
    },
  });
  await runtime.handleMessage({
    protocol: SPEECH_WORKER_PROTOCOL,
    id: 1,
    op: "load",
    payload: {
      configuration: selfContainedWorkerConfiguration(
        whisperRuntimeSource(`
          const transcriber = async () => {
            const failure = new Error(${JSON.stringify(completeFailure)});
            failure.code = "ARCANE_AI_PROVIDER_DETAIL";
            failure.cause = failure;
            throw failure;
          };
          transcriber.dispose = async () => undefined;
          return transcriber;
        `),
      ),
    },
  });

  await assert.rejects(
    runtime.handleMessage({
      protocol: SPEECH_WORKER_PROTOCOL,
      id: 2,
      op: "use",
      payload: { audio: new Float32Array([0]), sampleRate: 16_000 },
    }),
    (error) => error?.code === "ARCANE_AI_PROVIDER_REQUEST_FAILED"
      && error?.reason === "stt-transcription-engine-operation-rejected"
      && error?.cause?.message === completeFailure,
  );
  const envelope = messages.find((message) => message.id === 2 && message.ok === false);
  assert.equal(envelope?.error?.protocol, "arcane-ai-speech-worker-error/1");
  assert.equal(envelope?.error?.code, "ARCANE_AI_PROVIDER_REQUEST_FAILED");
  assert.equal(envelope?.error?.message, "The speech engine operation was rejected.");
  assert.equal(envelope?.error?.reason, "stt-transcription-engine-operation-rejected");
  assert.equal(envelope?.error?.cause?.name, "Error");
  assert.equal(envelope?.error?.cause?.message, completeFailure);
  assert.equal(envelope?.error?.cause?.code, "ARCANE_AI_PROVIDER_DETAIL");
  assert.equal(envelope?.error?.cause?.cause, envelope?.error?.cause);
  const clonedEnvelope = structuredClone(envelope.error);
  assert.equal(clonedEnvelope.cause.cause, clonedEnvelope.cause);
  const admitted = normalizeSpeechWorkerErrorEnvelope(envelope.error, "stt", "use");
  assert.equal(admitted?.reason, "stt-transcription-engine-operation-rejected");
  assert.equal(admitted?.cause?.message, completeFailure);
  const { cause: ignoredCause, ...causeFreeEnvelope } = envelope.error;
  void ignoredCause;
  assert.equal(
    normalizeSpeechWorkerErrorEnvelope(causeFreeEnvelope, "stt", "use")?.reason,
    "stt-transcription-engine-operation-rejected",
  );
  assert.equal(normalizeSpeechWorkerErrorEnvelope({
    ...envelope.error,
    extra: true,
  }, "stt", "use"), null);
});

test("speech Worker client retains the admitted cross-Worker cause", async (t) => {
  const diagnostic = {
    name: "Error",
    message: "complete Kokoro diagnostic",
    stack: "complete Kokoro stack",
    code: "KOKORO_RUNTIME_FAILURE",
  };
  installContractWorker(t, () => createSpeechWorkerContract({
    role: "tts",
    responseError: {
      protocol: "arcane-ai-speech-worker-error/1",
      code: "ARCANE_AI_PROVIDER_REQUEST_FAILED",
      message: "The speech engine operation was rejected.",
      reason: "tts-synthesis-engine-operation-rejected",
      cause: diagnostic,
    },
  }));
  const client = createSpeechWorkerClient({ role: "tts" });
  await assert.rejects(
    client.request("use", { text: "complete speech" }),
    (error) => error?.code === "ARCANE_AI_PROVIDER_REQUEST_FAILED"
      && error?.reason === "tts-synthesis-engine-operation-rejected"
      && error?.cause?.message === diagnostic.message
      && error?.cause?.stack === diagnostic.stack,
  );
  await client.terminate();
});

test("speech Worker rejects unknown operations and unavailable runtime capabilities", async () => {
  const client = createSpeechWorkerClient({ role: "stt" });
  await assert.rejects(
    client.request("unknown-operation", null),
    (error) => error?.code === "ARCANE_AI_INVALID_REQUEST"
      && error?.reason === "stt-worker-operation-unknown",
  );

  const runtime = createSpeechWorkerRuntime({ role: "stt", send() {} });
  await assert.rejects(
    runtime.handleMessage({
      protocol: SPEECH_WORKER_PROTOCOL,
      id: 1,
      op: "load",
      payload: {
        configuration: selfContainedWorkerConfiguration(`
          export const env = {};
          export async function pipeline() {
            return async () => ({ text: "unused" });
          }
        `),
      },
    }),
    (error) => error?.code === "ARCANE_AI_PROVIDER_UNAVAILABLE"
      && error?.reason === "transformers-env-backends-onnx-wasm-unavailable",
  );
});

test("browser speech rejects malformed Worker error envelopes", async (t) => {
  const rejectedEnvelopes = [
    {
      protocol: "arcane-ai-speech-worker-error/1",
      code: "ARCANE_AI_UNKNOWN",
      message: "foreign Worker error",
      reason: "unknown-worker-error",
    },
    {},
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
  const { store } = createMemoryStore(["stt"]);

  for (let index = 0; index < rejectedEnvelopes.length; index += 1) {
    const whisper = createBrowserWhisperProvider(providerOptions("stt", store));
    await assert.rejects(
      whisper.load({ role: "stt", selection: selection(whisper) }),
      (error) => error?.code === "ARCANE_AI_WORKER_MESSAGE_ERROR"
        && error?.reason === "stt-worker-error-envelope-rejected",
    );
    assert.equal(whisper.status().state, "error");
    assert.equal(whisper.status().errorCode, "ARCANE_AI_WORKER_MESSAGE_ERROR");
    assert.equal(contracts[index].terminated, true);
    await whisper.dispose();
  }
});

test("Whisper and Kokoro use independent ordinary Workers and mutable complete results", async (t) => {
  const { store } = createMemoryStore(["stt", "tts"]);
  const workers = { stt: [], tts: [] };
  installContractWorker(t, ({ options }) => {
    const role = options.name.includes("whisper") ? "stt" : "tts";
    const contract = createSpeechWorkerContract({ role });
    workers[role].push(contract);
    return contract;
  });
  const whisper = createBrowserWhisperProvider(providerOptions("stt", store));
  const kokoro = createBrowserKokoroProvider(providerOptions("tts", store));

  await whisper.load({ role: "stt", selection: selection(whisper) });
  await kokoro.load({ role: "tts", selection: selection(kokoro) });
  assert.equal(workers.stt.length, 1);
  assert.equal(workers.tts.length, 4);
  assert.notEqual(workers.stt[0].worker, workers.tts[0].worker);
  assert.notEqual(workers.tts[0].worker, workers.tts[1].worker);
  assert.equal(
    workers.stt[0].posted.find((message) => message.op === "load")
      .payload.configuration.model.dtype,
    "q8",
  );

  const alreadyAborted = new AbortController();
  alreadyAborted.abort("caller cancelled before transcription");
  await assert.rejects(whisper.request({
    role: "stt",
    operation: "transcribe",
    payload: { audio: new Float32Array([0]), sampleRate: 16_000 },
    signal: alreadyAborted.signal,
  }), (error) => error?.code === "ARCANE_AI_REQUEST_ABORTED"
    && error?.reason === "stt-transcription-cancelled"
    && error?.cause === "caller cancelled before transcription");
  assert.equal(workers.stt[0].terminated, false);

  const transcription = await whisper.request({
    role: "stt",
    operation: "transcribe",
    payload: { audio: new Float32Array([0, 0.25]), sampleRate: 16_000 },
  });
  assert.deepEqual(transcription, { text: "hello from whisper" });
  transcription.annotation = "complete transcription";
  assert.equal(transcription.annotation, "complete transcription");

  const speech = await kokoro.request({
    role: "tts",
    operation: "synthesize",
    payload: { text: "Complete spoken content", voice: "af_heart", speed: 1 },
  });
  assert.equal(speech.sampleRate, 24_000);
  assert.equal(speech.voice, "af_heart");
  speech.annotation = "complete synthesis";
  assert.equal(speech.annotation, "complete synthesis");
  assert.ok(speech.audio.every(Number.isFinite));

  await kokoro.unload();
  assert.equal(kokoro.status().state, "unloaded");
  assert.equal(whisper.status().state, "ready");
  assert.ok(workers.tts.every((contract) => contract.terminated));
  assert.equal(workers.stt[0].terminated, false);
  await whisper.dispose();
  await kokoro.dispose();
});

test("shared speech requests preserve complete text and platform capability errors", async (t) => {
  const offlineDescriptor = Object.getOwnPropertyDescriptor(globalThis, "OfflineAudioContext");
  const webkitDescriptor = Object.getOwnPropertyDescriptor(globalThis, "webkitOfflineAudioContext");
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
    if (offlineDescriptor) {
      Object.defineProperty(globalThis, "OfflineAudioContext", offlineDescriptor);
    } else {
      delete globalThis.OfflineAudioContext;
    }
    if (webkitDescriptor) {
      Object.defineProperty(globalThis, "webkitOfflineAudioContext", webkitDescriptor);
    } else {
      delete globalThis.webkitOfflineAudioContext;
    }
  });

  const { store } = createMemoryStore(["stt", "tts"]);
  const workers = { stt: [], tts: [] };
  installContractWorker(t, ({ options }) => {
    const role = options.name.includes("whisper") ? "stt" : "tts";
    const contract = createSpeechWorkerContract({ role });
    workers[role].push(contract);
    return contract;
  });
  const whisper = createBrowserWhisperProvider(providerOptions("stt", store));
  const kokoro = createBrowserKokoroProvider(providerOptions("tts", store));
  await whisper.load({ role: "stt", selection: selection(whisper) });
  await kokoro.load({ role: "tts", selection: selection(kokoro) });

  const encodedAudio = new Blob([new Uint8Array([9, 8, 7])], { type: "audio/webm" });
  const sharedTranscription = {
    audio: encodedAudio,
    mimeType: "audio/webm; codecs=opus",
    model: whisper.catalog()[0].id,
  };
  await assert.rejects(whisper.request({
    role: "stt",
    selection: selection(whisper),
    operation: "transcribe",
    payload: sharedTranscription,
  }), (error) => error?.code === "ARCANE_AI_AUDIO_DECODE_UNAVAILABLE");
  assert.equal(whisper.status().state, "ready");

  const channels = [
    new Float32Array([0.25, -0.5]),
    new Float32Array([0.75, 0.5]),
  ];
  Object.defineProperty(globalThis, "OfflineAudioContext", {
    configurable: true,
    writable: true,
    value: function ContractOfflineAudioContext() {
      this.decodeAudioData = async function decodeContractAudio() {
        return {
          sampleRate: 16_000,
          length: channels[0].length,
          numberOfChannels: channels.length,
          getChannelData(index) {
            return channels[index];
          },
        };
      };
    },
  });
  assert.deepEqual(await whisper.request({
    role: "stt",
    selection: selection(whisper),
    operation: "transcribe",
    payload: sharedTranscription,
  }), { text: "hello from whisper" });
  const sharedSttUse = workers.stt[0].posted.filter((message) => message.op === "use").at(-1);
  assert.deepEqual([...sharedSttUse.payload.audio], [0.5, 0]);

  const completeInput = "  Speak every word\nand preserve surrounding whitespace.  ";
  const wav = await kokoro.request({
    role: "tts",
    selection: selection(kokoro),
    operation: "synthesize",
    payload: {
      model: kokoro.catalog()[0].id,
      voice: "af_heart",
      input: completeInput,
      responseFormat: "wav",
      speed: 1.25,
    },
  });
  const sharedTtsUse = workers.tts
    .flatMap((contract) => contract.posted)
    .find((message) => message.op === "use");
  assert.deepEqual(sharedTtsUse.payload, {
    text: completeInput,
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
  wav.annotation = "mutable WAV result";
  assert.equal(wav.annotation, "mutable WAV result");

  await whisper.dispose();
  await kokoro.dispose();
});

test("coalesced speech loads preserve each caller and isolate cancellation", async (t) => {
  const options = providerOptions("stt", null);
  const sources = sourceMap(["stt"]);
  let releaseFetch;
  const fetchGate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const { store } = createMemoryStore(["stt"], {
    fetchImpl: async (url) => {
      await fetchGate;
      return responseAt(url, sources.get(String(url)), { status: 200 });
    },
  });
  const contract = createSpeechWorkerContract({ role: "stt" });
  installContractWorker(t, () => contract);
  const whisper = createBrowserWhisperProvider({ ...options, store });

  const first = whisper.load({ role: "stt", selection: selection(whisper) });
  const second = whisper.load({ role: "stt", selection: selection(whisper) });
  const controller = new AbortController();
  const cancelled = whisper.load({
    role: "stt",
    selection: selection(whisper),
    signal: controller.signal,
  });
  controller.abort("one caller cancelled while shared loading continued");
  await assert.rejects(
    cancelled,
    (error) => error?.code === "ARCANE_AI_REQUEST_ABORTED"
      && error?.reason === "stt-load-cancelled"
      && error?.cause === "one caller cancelled while shared loading continued",
  );
  releaseFetch();
  const [firstStatus, secondStatus] = await Promise.all([first, second]);
  assert.equal(firstStatus.state, "ready");
  assert.deepEqual(secondStatus, firstStatus);
  assert.equal(contract.posted.filter((message) => message.op === "load").length, 1);
  await whisper.unload();
});

test("unload supersedes an in-flight ordinary artifact fetch", async () => {
  const options = providerOptions("stt", null);
  let fetchStarted;
  const started = new Promise((resolve) => {
    fetchStarted = resolve;
  });
  const { store } = createMemoryStore(["stt"], {
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
  });
  const whisper = createBrowserWhisperProvider({ ...options, store });
  const loading = whisper.load({ role: "stt", selection: selection(whisper) });
  await started;
  const unloading = whisper.unload();
  await assert.rejects(
    loading,
    (error) => error?.code === "ARCANE_AI_OPERATION_SUPERSEDED"
      && error?.reason === "stt-load-superseded-by-unload",
  );
  assert.equal((await unloading).lifecycleReason, "stt-unload-completed");
});

test("Kokoro pool isolates one cancelled use and unloads every active slot", async (t) => {
  const { store } = createMemoryStore(["tts"]);
  const workers = [];
  installContractWorker(t, () => {
    const contract = createSpeechWorkerContract({
      role: "tts",
      holdUse: true,
      workerId: workers.length,
    });
    workers.push(contract);
    return contract;
  });
  const kokoro = createBrowserKokoroProvider({
    ...providerOptions("tts", store),
    execution: { device: "wasm", maxConcurrentRequests: 2 },
  });
  await kokoro.load({ role: "tts", selection: selection(kokoro) });
  assert.equal(workers.length, 2);

  const firstText = "  First complete synthesis text.\n";
  const secondText = "Second complete synthesis text with trailing space.  ";
  const firstController = new AbortController();
  const firstUseArrival = workers[0].waitForUse();
  const secondUseArrival = workers[1].waitForUse();
  const firstRequest = kokoro.request({
    role: "tts",
    operation: "synthesize",
    payload: { text: firstText, voice: "af_heart", speed: 1 },
    signal: firstController.signal,
  });
  const secondRequest = kokoro.request({
    role: "tts",
    operation: "synthesize",
    payload: { text: secondText, voice: "af_heart", speed: 1 },
  });
  const [firstUse, secondUse] = await Promise.all([
    firstUseArrival,
    secondUseArrival,
  ]);
  assert.equal(firstUse.payload.text, firstText);
  assert.equal(secondUse.payload.text, secondText);
  assert.deepEqual(kokoro.status().execution, {
    requestedDevice: "wasm",
    selectedDevice: "wasm",
    maxConcurrentRequests: 2,
    activeRequestCount: 2,
  });
  await assert.rejects(
    kokoro.request({
      role: "tts",
      operation: "synthesize",
      payload: { text: "Capacity overflow.", voice: "af_heart", speed: 1 },
    }),
    (error) => error?.code === "ARCANE_AI_PROVIDER_BUSY",
  );

  const firstCancellation = assert.rejects(
    firstRequest,
    (error) => error?.code === "ARCANE_AI_REQUEST_ABORTED"
      && error?.reason === "tts-synthesis-cancelled"
      && error?.cause === "cancel only the first synthesis",
  );
  firstController.abort("cancel only the first synthesis");
  await firstCancellation;
  assert.deepEqual(workers[0].cancelledUseIds, [firstUse.id]);
  assert.equal(workers[0].terminated, false);
  assert.equal(workers[1].terminated, false);
  assert.deepEqual(workers[1].heldUseIds(), [secondUse.id]);
  assert.equal(workers[1].releaseUse(secondUse.id), true);
  const secondResult = await secondRequest;
  assert.equal(secondResult.voice, "af_heart");
  assert.equal(kokoro.status().execution.activeRequestCount, 0);

  const unloadFirstArrival = workers[0].waitForUse();
  const unloadSecondArrival = workers[1].waitForUse();
  const unloadFirst = kokoro.request({
    role: "tts",
    operation: "synthesize",
    payload: { text: "Unload the first active use.", voice: "af_heart", speed: 1 },
  });
  const unloadSecond = kokoro.request({
    role: "tts",
    operation: "synthesize",
    payload: { text: "Unload the second active use.", voice: "af_heart", speed: 1 },
  });
  const [unloadFirstUse, unloadSecondUse] = await Promise.all([
    unloadFirstArrival,
    unloadSecondArrival,
  ]);
  const unloading = kokoro.unload();
  const settlements = await Promise.allSettled([unloadFirst, unloadSecond]);
  assert.ok(settlements.every((settlement) => settlement.status === "rejected"
    && settlement.reason?.code === "ARCANE_AI_OPERATION_SUPERSEDED"));
  assert.equal((await unloading).state, "unloaded");
  assert.ok(workers[0].cancelledUseIds.includes(unloadFirstUse.id));
  assert.ok(workers[1].cancelledUseIds.includes(unloadSecondUse.id));
  assert.ok(workers.every((contract) => contract.terminated));
});

test("STT request cancellation terminates its role Worker", async (t) => {
  const { store } = createMemoryStore(["stt"]);
  const contract = createSpeechWorkerContract({ role: "stt", holdUse: true });
  installContractWorker(t, () => contract);
  const whisper = createBrowserWhisperProvider(providerOptions("stt", store));
  await whisper.load({ role: "stt", selection: selection(whisper) });

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
  controller.abort("cancel only this transcription");
  await assert.rejects(
    request,
    (error) => error?.code === "ARCANE_AI_REQUEST_ABORTED"
      && error?.reason === "stt-transcription-cancelled"
      && error?.cause === "cancel only this transcription",
  );
  assert.equal(contract.terminated, true);
  assert.equal(whisper.status().state, "unloaded");
});

test("unload supersedes pre-Worker audio decoding", async (t) => {
  const { store } = createMemoryStore(["stt"]);
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
  await whisper.load({ role: "stt", selection: selection(whisper) });
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
  const unloading = whisper.unload();
  await assert.rejects(
    request,
    (error) => error?.code === "ARCANE_AI_OPERATION_SUPERSEDED"
      && error?.reason === "stt-transcription-superseded-by-unload",
  );
  assert.equal((await unloading).state, "unloaded");
});

test("an unexpected ready speech Worker crash remains visible", async (t) => {
  const { store } = createMemoryStore(["stt"]);
  const contract = createSpeechWorkerContract({ role: "stt" });
  installContractWorker(t, () => contract);
  const whisper = createBrowserWhisperProvider(providerOptions("stt", store));
  await whisper.load({ role: "stt", selection: selection(whisper) });

  contract.crash();
  await new Promise((resolve) => queueMicrotask(resolve));

  assert.equal(whisper.status().state, "error");
  assert.equal(whisper.status().errorCode, "ARCANE_AI_WORKER_CRASHED");
  assert.equal(contract.terminated, true);
});

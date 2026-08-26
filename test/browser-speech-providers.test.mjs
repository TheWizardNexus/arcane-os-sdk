import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import test from "../src/testing.mjs";
import {
  createBrowserKokoroProvider,
  createBrowserSpeechAuthority,
  createBrowserWhisperProvider,
  createDbopfsSpeechArtifactStore,
} from "../browser-runtime/ai/browser-speech.mjs";
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
    localOnly: true,
  });
}

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
  }), (error) => error?.code === "ARCANE_AI_REQUEST_ABORTED");
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
    (error) => error?.code === "ARCANE_AI_REQUEST_ABORTED",
  );
  assert.equal(whisper.status().busy, false);
  assert.equal(whisper.status().state, "ready");
  assert.equal(workers.stt[0].terminated, false);
  assert.equal(sttUseCount(), 2);
  resolveEncodedAudio(new Uint8Array([1]).buffer);

  await whisper.dispose();
  await kokoro.dispose();
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
  controller.abort();
  await assert.rejects(request, (error) => error?.code === "ARCANE_AI_REQUEST_ABORTED");
  assert.equal(contract.terminated, true);
  assert.equal(whisper.status().state, "unloaded");
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

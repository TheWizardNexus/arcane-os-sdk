import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WLLAMA_UPSTREAM_AUTHORITY = Object.freeze({
  package: "@wllama/wllama",
  version: "3.6.0",
  sourceRevision: "f16050d8d51a00602c6a2a6b8ac9c09f490eea7f",
  bytes: 373_519,
  sha256: "4637e42d636010493a9b274fbbe70bfd8120365da726b1d9e589d85ca84a00d6",
});

export const WLLAMA_WEBGPU_EVIDENCE_PROTOCOL = "arcane-wllama-webgpu-evidence/1";
export const WLLAMA_PROJECTED_BYTES = 392_852;
export const WLLAMA_PROJECTED_SHA256 = "b119a7cdffabc8541dce283381d18ada4027c0560728aac1fe45bdd30cdac8e2";

const EXPORT_ANCHOR = "\nexport {\n";
const PROJECTION_MARKER = "function applyArcaneWllamaProjection()";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/*
 * This function is serialized into the authenticated upstream ESM. It is not
 * invoked by this tool. Inside the projected module it has lexical access to
 * Wllama, ProxyToWorker, WLLAMA_EMSCRIPTEN_CODE, and LLAMA_CPP_WORKER_CODE.
 */
function applyArcaneWllamaProjection() {
  const protocol = "arcane-wllama-webgpu-evidence/1";
  const emptyWorkerTelemetry = `{protocol:"${protocol}",adapter:null,bufferCount:0,bufferBytes:0,queueSubmissions:0,commandBuffers:0,queueFenceRequests:0,queueFenceCompletions:0,invalid:false}`;

  function replaceSingle(source, search, replacement, label) {
    const first = source.indexOf(search);
    const last = source.lastIndexOf(search);
    if (first < 0 || first !== last) {
      throw new Error(`Pinned Wllama ${label} projection anchor must occur exactly once.`);
    }
    return `${source.slice(0, first)}${replacement}${source.slice(first + search.length)}`;
  }

  const adapterAnchor = "if(adapter){WebGPU.Internals.jsObjectInsert(adapterPtr,adapter)";
  const adapterProjection = `if(adapter){(function arcaneRecordSelectedWebgpuAdapter(){const key="__arcaneWllamaWebgpuTelemetry";const previous=globalThis[key]??${emptyWorkerTelemetry};const info=adapter.info??{};const text=value=>typeof value==="string"?value.slice(0,256):"";const next={selected:true,vendorId:null,vendor:text(info.vendor),architecture:text(info.architecture),deviceId:null,name:text(info.device),description:text(info.description)};const conflicts=previous.adapter!==null&&JSON.stringify(previous.adapter)!==JSON.stringify(next);globalThis[key]={protocol:"${protocol}",adapter:previous.adapter??next,bufferCount:previous.bufferCount,bufferBytes:previous.bufferBytes,queueSubmissions:previous.queueSubmissions,commandBuffers:previous.commandBuffers,queueFenceRequests:previous.queueFenceRequests,queueFenceCompletions:previous.queueFenceCompletions,invalid:previous.invalid||conflicts}})();WebGPU.Internals.jsObjectInsert(adapterPtr,adapter)`;
  WLLAMA_EMSCRIPTEN_CODE = replaceSingle(
    WLLAMA_EMSCRIPTEN_CODE,
    adapterAnchor,
    adapterProjection,
    "WebGPU adapter selection",
  );

  const bufferAnchor = "var buffer;try{buffer=device.createBuffer(desc)}catch(ex){return false}WebGPU.Internals.jsObjectInsert(bufferPtr,buffer)";
  const bufferProjection = `${bufferAnchor};(function arcaneRecordWebgpuBuffer(){const key="__arcaneWllamaWebgpuTelemetry";const previous=globalThis[key]??${emptyWorkerTelemetry};const size=desc.size;const bufferCount=previous.bufferCount+1;const bufferBytes=previous.bufferBytes+size;globalThis[key]={protocol:"${protocol}",adapter:previous.adapter,bufferCount:Number.isSafeInteger(bufferCount)?bufferCount:previous.bufferCount,bufferBytes:Number.isSafeInteger(size)&&size>0&&Number.isSafeInteger(bufferBytes)?bufferBytes:previous.bufferBytes,queueSubmissions:previous.queueSubmissions,commandBuffers:previous.commandBuffers,queueFenceRequests:previous.queueFenceRequests,queueFenceCompletions:previous.queueFenceCompletions,invalid:previous.invalid||!Number.isSafeInteger(size)||size<1||!Number.isSafeInteger(bufferCount)||!Number.isSafeInteger(bufferBytes)}})()`;
  WLLAMA_EMSCRIPTEN_CODE = replaceSingle(
    WLLAMA_EMSCRIPTEN_CODE,
    bufferAnchor,
    bufferProjection,
    "WebGPU buffer",
  );

  const queueAnchor = "queue.submit(cmds)};function _wgpuQueueWriteBuffer";
  const queueProjection = `queue.submit(cmds);(function arcaneRecordWebgpuSubmission(){const key="__arcaneWllamaWebgpuTelemetry";const previous=globalThis[key]??${emptyWorkerTelemetry};const queueSubmissions=previous.queueSubmissions+1;const commandBuffers=previous.commandBuffers+cmds.length;globalThis[key]={protocol:"${protocol}",adapter:previous.adapter,bufferCount:previous.bufferCount,bufferBytes:previous.bufferBytes,queueSubmissions:Number.isSafeInteger(queueSubmissions)?queueSubmissions:previous.queueSubmissions,commandBuffers:Number.isSafeInteger(commandBuffers)?commandBuffers:previous.commandBuffers,queueFenceRequests:previous.queueFenceRequests,queueFenceCompletions:previous.queueFenceCompletions,invalid:previous.invalid||!Number.isSafeInteger(queueSubmissions)||!Number.isSafeInteger(commandBuffers)}})()};function _wgpuQueueWriteBuffer`;
  WLLAMA_EMSCRIPTEN_CODE = replaceSingle(
    WLLAMA_EMSCRIPTEN_CODE,
    queueAnchor,
    queueProjection,
    "WebGPU queue",
  );

  const fenceAnchor = "runtimeKeepalivePush();WebGPU.Internals.futureInsert(futureId,queue.onSubmittedWorkDone().then(()=>{";
  const fenceProjection = `runtimeKeepalivePush();(function arcaneRecordWebgpuFenceRequest(){const key="__arcaneWllamaWebgpuTelemetry";const previous=globalThis[key]??${emptyWorkerTelemetry};const queueFenceRequests=previous.queueFenceRequests+1;globalThis[key]={protocol:"${protocol}",adapter:previous.adapter,bufferCount:previous.bufferCount,bufferBytes:previous.bufferBytes,queueSubmissions:previous.queueSubmissions,commandBuffers:previous.commandBuffers,queueFenceRequests:Number.isSafeInteger(queueFenceRequests)?queueFenceRequests:previous.queueFenceRequests,queueFenceCompletions:previous.queueFenceCompletions,invalid:previous.invalid||!Number.isSafeInteger(queueFenceRequests)}})();WebGPU.Internals.futureInsert(futureId,queue.onSubmittedWorkDone().then(function arcaneRecordWebgpuFenceCompletion(){(function arcaneCommitWebgpuFenceCompletion(){const key="__arcaneWllamaWebgpuTelemetry";const previous=globalThis[key]??${emptyWorkerTelemetry};const queueFenceCompletions=previous.queueFenceCompletions+1;globalThis[key]={protocol:"${protocol}",adapter:previous.adapter,bufferCount:previous.bufferCount,bufferBytes:previous.bufferBytes,queueSubmissions:previous.queueSubmissions,commandBuffers:previous.commandBuffers,queueFenceRequests:previous.queueFenceRequests,queueFenceCompletions:Number.isSafeInteger(queueFenceCompletions)?queueFenceCompletions:previous.queueFenceCompletions,invalid:previous.invalid||!Number.isSafeInteger(queueFenceCompletions)||queueFenceCompletions>previous.queueFenceRequests}})();`;
  WLLAMA_EMSCRIPTEN_CODE = replaceSingle(
    WLLAMA_EMSCRIPTEN_CODE,
    fenceAnchor,
    fenceProjection,
    "WebGPU submitted-work fence",
  );

  const workerAnchor = "  if (verb === 'module.init') {";
  const workerProjection = `  if (verb === 'arcane.telemetry') {\n    const observed = globalThis.__arcaneWllamaWebgpuTelemetry;\n    const adapter = observed?.adapter?.selected === true ? {\n      selected: true,\n      vendorId: null,\n      vendor: typeof observed.adapter.vendor === 'string' ? observed.adapter.vendor.slice(0, 256) : '',\n      architecture: typeof observed.adapter.architecture === 'string' ? observed.adapter.architecture.slice(0, 256) : '',\n      deviceId: null,\n      name: typeof observed.adapter.name === 'string' ? observed.adapter.name.slice(0, 256) : '',\n      description: typeof observed.adapter.description === 'string' ? observed.adapter.description.slice(0, 256) : '',\n    } : null;\n    msg({\n      callbackId,\n      result: {\n        protocol: '${protocol}',\n        adapter,\n        bufferCount: Number.isSafeInteger(observed?.bufferCount) ? observed.bufferCount : 0,\n        bufferBytes: Number.isSafeInteger(observed?.bufferBytes) ? observed.bufferBytes : 0,\n        queueSubmissions: Number.isSafeInteger(observed?.queueSubmissions) ? observed.queueSubmissions : 0,\n        commandBuffers: Number.isSafeInteger(observed?.commandBuffers) ? observed.commandBuffers : 0,\n        queueFenceRequests: Number.isSafeInteger(observed?.queueFenceRequests) ? observed.queueFenceRequests : 0,\n        queueFenceCompletions: Number.isSafeInteger(observed?.queueFenceCompletions) ? observed.queueFenceCompletions : 0,\n        invalid: observed?.invalid === true,\n      },\n    });\n    return;\n  }\n\n${workerAnchor}`;
  LLAMA_CPP_WORKER_CODE = replaceSingle(
    LLAMA_CPP_WORKER_CODE,
    workerAnchor,
    workerProjection,
    "Worker telemetry",
  );

  function sanitizeWorkerTelemetry(value) {
    function nonNegativeCounter(candidate) {
      return Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : 0;
    }
    function adapterText(candidate) {
      return typeof candidate === "string" && candidate.length <= 256 ? candidate : "";
    }
    const rawAdapter = value?.adapter;
    const adapterInvalid = rawAdapter !== undefined && rawAdapter !== null && (
      typeof rawAdapter !== "object"
      || rawAdapter.selected !== true
      || rawAdapter.vendorId !== null
      || typeof rawAdapter.vendor !== "string"
      || rawAdapter.vendor.length > 256
      || typeof rawAdapter.architecture !== "string"
      || rawAdapter.architecture.length > 256
      || rawAdapter.deviceId !== null
      || typeof rawAdapter.name !== "string"
      || rawAdapter.name.length > 256
      || typeof rawAdapter.description !== "string"
      || rawAdapter.description.length > 256
    );
    const adapter = rawAdapter?.selected === true ? Object.freeze({
      selected: true,
      vendorId: null,
      vendor: adapterText(rawAdapter.vendor),
      architecture: adapterText(rawAdapter.architecture),
      deviceId: null,
      name: adapterText(rawAdapter.name),
      description: adapterText(rawAdapter.description),
    }) : null;
    return Object.freeze({
      protocol,
      adapter,
      bufferCount: nonNegativeCounter(value?.bufferCount),
      bufferBytes: nonNegativeCounter(value?.bufferBytes),
      queueSubmissions: nonNegativeCounter(value?.queueSubmissions),
      commandBuffers: nonNegativeCounter(value?.commandBuffers),
      queueFenceRequests: nonNegativeCounter(value?.queueFenceRequests),
      queueFenceCompletions: nonNegativeCounter(value?.queueFenceCompletions),
      invalid: value?.invalid === true || value?.protocol !== protocol || adapterInvalid,
    });
  }

  const proxyEvidence = new WeakMap();
  const sessionEvidence = new WeakMap();

  function proxyRecord(proxy) {
    let record = proxyEvidence.get(proxy);
    if (!record) {
      record = {
        cancellationSequence: 0,
        cancellation: null,
        cleanupSequence: 0,
        cleanup: null,
        worker: sanitizeWorkerTelemetry(null),
      };
      proxyEvidence.set(proxy, record);
    }
    return record;
  }

  function cancellationRecord(proxy, value) {
    const evidence = proxyRecord(proxy);
    const sequence = evidence.cancellationSequence + 1;
    evidence.cancellationSequence = sequence;
    const record = Object.freeze({
      sequence,
      requestId: typeof value.requestId === "number" || typeof value.requestId === "string"
        ? value.requestId
        : null,
      responseName: value.responseName === "cncl_res" ? value.responseName : null,
      acknowledged: value.acknowledged === true,
      failed: value.failed === true,
    });
    evidence.cancellation = record;
    return record;
  }

  const originalAction = ProxyToWorker.prototype.wllamaAction;
  Object.defineProperty(ProxyToWorker.prototype, "wllamaAction", {
    configurable: false,
    writable: false,
    value: async function arcaneWllamaAction(name, body) {
      if (name !== "cancel") return originalAction.call(this, name, body);
      try {
        const result = await originalAction.call(this, name, body);
        cancellationRecord(this, {
          requestId: body?.req_id,
          responseName: result?._name,
          acknowledged: result?._name === "cncl_res" && result?.success === true,
          failed: false,
        });
        return result;
      } catch (error) {
        cancellationRecord(this, {
          requestId: body?.req_id,
          responseName: null,
          acknowledged: false,
          failed: true,
        });
        throw error;
      }
    },
  });

  Object.defineProperty(ProxyToWorker.prototype, "arcaneTelemetry", {
    configurable: false,
    writable: false,
    value: async function arcaneTelemetry() {
      const value = await this.pushTask({
        verb: "arcane.telemetry",
        args: [],
        callbackId: this.taskId++,
      });
      const evidence = proxyRecord(this);
      evidence.worker = sanitizeWorkerTelemetry(value);
      return Object.freeze({
        protocol,
        worker: evidence.worker,
        cancellation: evidence.cancellation,
        cleanup: evidence.cleanup,
      });
    },
  });

  const originalWorkerExit = ProxyToWorker.prototype.wllamaExit;
  Object.defineProperty(ProxyToWorker.prototype, "wllamaExit", {
    configurable: false,
    writable: false,
    value: async function arcaneWllamaExit(...args) {
      const hadWorker = Boolean(this.worker);
      const result = await originalWorkerExit.apply(this, args);
      if (hadWorker) {
        const evidence = proxyRecord(this);
        const sequence = evidence.cleanupSequence + 1;
        evidence.cleanupSequence = sequence;
        evidence.cleanup = Object.freeze({
          sequence,
          kind: "worker-terminated",
          nativeUnload: false,
          physicalVramReclamation: "not-observed",
        });
      }
      return result;
    },
  });

  function projectionFailure(code, message, cause) {
    const error = new Error(message, cause === undefined ? undefined : { cause });
    error.name = "ArcaneWllamaProjectionError";
    error.code = code;
    return error;
  }

  function cancellationError(reason) {
    if (reason instanceof Error) return reason;
    const error = new Error(reason ? String(reason) : "The Wllama operation was cancelled.");
    error.name = "AbortError";
    return error;
  }

  function noWorkerCleanup() {
    return Object.freeze({
      sequence: 0,
      kind: "no-worker-observed-at-exit",
      nativeUnload: false,
      physicalVramReclamation: "not-applicable",
    });
  }

  function proxySnapshot(proxy, cleanup = null) {
    const evidence = proxy ? proxyRecord(proxy) : null;
    return Object.freeze({
      protocol,
      worker: evidence?.worker ?? sanitizeWorkerTelemetry(null),
      cancellation: evidence?.cancellation ?? null,
      cleanup: evidence?.cleanup ?? cleanup,
    });
  }

  Object.defineProperty(Wllama.prototype, "arcaneTelemetry", {
    configurable: false,
    writable: false,
    value: async function arcaneTelemetry() {
      const exited = sessionEvidence.get(this) ?? null;
      if (!this.proxy || exited?.cleanup) return exited ?? proxySnapshot(null);
      return this.proxy.arcaneTelemetry();
    },
  });

  const originalExit = Wllama.prototype.exit;
  Object.defineProperty(Wllama.prototype, "exit", {
    configurable: false,
    writable: false,
    value: async function arcaneExit(...args) {
      const proxy = this.proxy;
      const hadWorker = Boolean(proxy?.worker);
      let result;
      try {
        result = await originalExit.apply(this, args);
      } catch (error) {
        throw projectionFailure(
          "ARCANE_AI_WORKER_TERMINATION_UNCONFIRMED",
          "Wllama exit failed before Worker termination could be confirmed.",
          error,
        );
      }
      let snapshot = proxySnapshot(proxy, hadWorker ? null : noWorkerCleanup());
      if (hadWorker && snapshot.cleanup?.kind !== "worker-terminated") {
        throw projectionFailure(
          "ARCANE_AI_WORKER_TERMINATION_UNCONFIRMED",
          "Wllama exit did not confirm Worker termination.",
        );
      }
      sessionEvidence.set(this, snapshot);
      return result;
    },
  });

  Object.defineProperty(Wllama.prototype, "arcaneTerminate", {
    configurable: false,
    writable: false,
    value: async function arcaneTerminate() {
      const existing = sessionEvidence.get(this) ?? null;
      if (!this.proxy) {
        const snapshot = existing ?? proxySnapshot(null, noWorkerCleanup());
        sessionEvidence.set(this, snapshot);
        return snapshot;
      }
      await this.exit();
      const snapshot = await this.arcaneTelemetry();
      if (!["worker-terminated", "no-worker-observed-at-exit"].includes(snapshot.cleanup?.kind)) {
        throw projectionFailure(
          "ARCANE_AI_WORKER_TERMINATION_UNCONFIRMED",
          "Wllama cleanup did not confirm its Worker termination boundary.",
        );
      }
      return snapshot;
    },
  });

  const originalLoadModel = Wllama.prototype.loadModel;
  Object.defineProperty(Wllama.prototype, "arcaneLoadModel", {
    configurable: false,
    writable: false,
    value: async function arcaneLoadModel(files, params = {}, signal = null) {
      if (signal !== null && typeof signal !== "object") {
        throw new TypeError("Arcane Wllama load cancellation requires an AbortSignal or null.");
      }
      if (signal?.aborted) throw cancellationError(signal.reason);
      const descriptor = Object.getOwnPropertyDescriptor(this, "proxy");
      if (!descriptor?.configurable || !("value" in descriptor) || descriptor.get || descriptor.set) {
        throw projectionFailure(
          "ARCANE_AI_WLLAMA_PROJECTION_INVALID",
          "Pinned Wllama proxy state is not an inspectable configurable data property.",
        );
      }

      sessionEvidence.delete(this);
      const session = this;
      let proxy = descriptor.value;
      let resolveProxyAssigned;
      const proxyAssigned = new Promise(function captureAssignedProxy(resolve) {
        resolveProxyAssigned = resolve;
      });
      if (proxy) resolveProxyAssigned(proxy);
      Object.defineProperty(this, "proxy", {
        enumerable: descriptor.enumerable,
        configurable: true,
        get: function arcaneReadLoadingProxy() {
          return proxy;
        },
        set: function arcaneRecordLoadingProxy(value) {
          proxy = value;
          if (value) resolveProxyAssigned(value);
        },
      });

      let restored = false;
      function restoreProxyProperty() {
        if (restored) return;
        restored = true;
        Object.defineProperty(session, "proxy", { ...descriptor, value: proxy });
      }
      const loadPromise = Promise.resolve().then(function beginProjectedModelLoad() {
        return originalLoadModel.call(session, files, params);
      });
      loadPromise.finally(restoreProxyProperty).catch(function ignoreObservedLoadSettlement() {});
      if (!signal) return loadPromise;

      let onAbort;
      const aborted = new Promise(function captureProjectedLoadCancellation(resolve, reject) {
        onAbort = function terminateProjectedLoadAfterAbort() {
          const reason = cancellationError(signal.reason);
          const activeProxy = proxy
            ? Promise.resolve(proxy)
            : Promise.race([
              proxyAssigned,
              loadPromise.then(
                function projectedLoadFinishedWithoutProxy() { return null; },
                function projectedLoadFailedWithoutProxy() { return null; },
              ),
            ]);
          activeProxy.then(function terminateAssignedLoadProxy() {
            return session.arcaneTerminate();
          }).then(
            function rejectAfterConfirmedLoadTermination() { reject(reason); },
            function rejectWithLoadTerminationFailure(error) { reject(error); },
          );
        };
      });
      signal.addEventListener?.("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      try {
        const result = await Promise.race([loadPromise, aborted]);
        if (signal.aborted) {
          await session.arcaneTerminate();
          throw cancellationError(signal.reason);
        }
        return result;
      } finally {
        signal.removeEventListener?.("abort", onAbort);
      }
    },
  });

  Object.freeze(ProxyToWorker.prototype);
  Object.freeze(Wllama.prototype);
}

export const WLLAMA_PROJECTION_BLOCK = `\n(${applyArcaneWllamaProjection.toString()})();\n`;

export function projectWllamaWebgpuRuntime(input) {
  const sourceBytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (
    sourceBytes.byteLength !== WLLAMA_UPSTREAM_AUTHORITY.bytes
    || sha256(sourceBytes) !== WLLAMA_UPSTREAM_AUTHORITY.sha256
  ) {
    throw new Error("The Wllama ESM does not match the authenticated 3.6.0 source authority.");
  }
  const source = sourceBytes.toString("utf8");
  if (source.includes(PROJECTION_MARKER)) {
    throw new Error("The Wllama ESM is already projected.");
  }
  const first = source.indexOf(EXPORT_ANCHOR);
  const last = source.lastIndexOf(EXPORT_ANCHOR);
  if (first < 0 || first !== last) {
    throw new Error("The authenticated Wllama export anchor must occur exactly once.");
  }
  return Buffer.from(`${source.slice(0, first)}${WLLAMA_PROJECTION_BLOCK}${source.slice(first)}`);
}

async function main() {
  const toolPath = fileURLToPath(import.meta.url);
  const repositoryRoot = path.dirname(path.dirname(toolPath));
  const sourcePath = path.join(
    repositoryRoot,
    "node_modules",
    "@wllama",
    "wllama",
    "esm",
    "index.js",
  );
  const destinationPath = path.join(
    repositoryRoot,
    "browser-runtime",
    "ai",
    "wllama",
    "index.mjs",
  );
  const projected = projectWllamaWebgpuRuntime(await readFile(sourcePath));
  if (
    projected.byteLength !== WLLAMA_PROJECTED_BYTES
    || sha256(projected) !== WLLAMA_PROJECTED_SHA256
  ) {
    throw new Error("The deterministic Wllama projection does not match its recorded authority.");
  }
  const mode = process.argv[2] ?? "--verify";
  if (mode === "--write") {
    await writeFile(destinationPath, projected);
    return;
  }
  if (mode !== "--verify") {
    throw new Error("Usage: node tools/project-wllama-webgpu-runtime.mjs [--verify|--write]");
  }
  const current = await readFile(destinationPath);
  if (!current.equals(projected)) {
    throw new Error("The packaged Wllama projection does not match the authenticated source projection.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

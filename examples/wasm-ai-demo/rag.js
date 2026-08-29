import DBOPFSDocumentLibrary from "arcane/DBOPFSDocumentLibrary";

const DEFAULT_BOSS_BUNDLE_URL = "./rag/boss-library.json";
const PROFILE_IDS = new Set(["general", "precrisis", "boss"]);
const libraryEntries = new WeakMap();

function normalizeProfileId(profileId) {
  const normalized = String(profileId || "general").trim().toLowerCase();
  if (!PROFILE_IDS.has(normalized)) {
    throw new TypeError(`Unsupported example profile: ${normalized || "empty"}.`);
  }
  return normalized;
}

function assertDbopfs(dbopfs) {
  if (!dbopfs || typeof dbopfs !== "object") {
    throw new TypeError("An Arcane DBOPFS instance is required.");
  }
  for (const methodName of ["delete", "get", "getAllKeys", "set"]) {
    if (typeof dbopfs[methodName] !== "function") {
      throw new TypeError(`The Arcane DBOPFS instance is missing ${methodName}().`);
    }
  }
  return dbopfs;
}

function reportStatus(onStatus, message) {
  if (typeof onStatus === "function") onStatus(message);
}

function entryMap(dbopfs) {
  let entries = libraryEntries.get(dbopfs);
  if (!entries) {
    entries = new Map();
    libraryEntries.set(dbopfs, entries);
  }
  return entries;
}

function schemaFor(profileId, version = "1") {
  return {
    id: `wasm-ai-demo-${profileId}`,
    table: `wasm_ai_demo_${profileId}_documents`,
    version: String(version),
  };
}

function createLibrary(dbopfs, profileId, version) {
  return new DBOPFSDocumentLibrary({
    db: dbopfs,
    schema: schemaFor(profileId, version),
  });
}

function splitTerms(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function bossRecord(document, index, sourcePath) {
  const record = document && typeof document === "object" && !Array.isArray(document)
    ? document
    : {};
  const id = String(record.id || `boss-library-${index + 1}`).trim();
  const title = String(record.title || id).trim();
  const body = String(record.text ?? record.body ?? "");
  const terms = splitTerms(record.topics);
  return {
    body,
    id,
    kind: "boss-library",
    mediaType: "text/markdown",
    path: id,
    searchTerms: terms,
    sourcePath,
    tags: ["boss", ...terms],
    title,
  };
}

async function fetchBossBundle(bundleUrl) {
  const response = await fetch(bundleUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Unable to load the BOSS library: HTTP ${response.status}.`);
  }
  const bundle = await response.json();
  if (!bundle || typeof bundle !== "object" || !Array.isArray(bundle.documents)) {
    throw new TypeError("The BOSS library response must contain a documents array.");
  }
  return bundle;
}

async function readCorpus(library, signal) {
  try {
    return { ...(await library.search("", { signal })), bootstrapped: true };
  } catch (error) {
    if (error?.code === "DBOPFS_DOCUMENT_NOT_BOOTSTRAPPED") {
      return { bootstrapped: false, failures: [], matches: [], total: 0 };
    }
    throw error;
  }
}

async function prepareLibrary({ dbopfs, bundleUrl, onStatus, profileId, signal }) {
  let version = "1";
  let bossDocuments = [];
  if (profileId === "boss") {
    reportStatus(onStatus, "Loading the BOSS document catalog…");
    const bundle = await fetchBossBundle(bundleUrl);
    version = String(bundle.schema_version ?? "1");
    bossDocuments = bundle.documents.map((document, index) => (
      bossRecord(document, index, bundleUrl)
    ));
  }

  const library = createLibrary(dbopfs, profileId, version);
  const existing = await readCorpus(library, signal);
  const userDocuments = existing.matches.filter((document) => document.kind === "user-import");
  const hasBossDocuments = existing.matches.some((document) => document.kind === "boss-library");
  const needsBootstrap = !existing.bootstrapped || (profileId === "boss" && !hasBossDocuments);

  if (needsBootstrap) {
    const documents = profileId === "boss"
      ? [...bossDocuments, ...userDocuments]
      : userDocuments;
    reportStatus(
      onStatus,
      profileId === "boss"
        ? "Storing the BOSS library through the Arcane document library…"
        : "Opening the Arcane document library…",
    );
    await library.bootstrap({
      files: documents,
      signal,
      onProgress(progress) {
        if (progress?.phase !== "writing") return;
        reportStatus(
          onStatus,
          `Storing local documents ${progress.completed} of ${progress.total}…`,
        );
      },
    });
  }

  return library;
}

async function libraryFor(profileId, { dbopfs, bundleUrl, onStatus, signal } = {}) {
  const profile = normalizeProfileId(profileId);
  const db = assertDbopfs(dbopfs ?? globalThis.dbopfs);
  if (db.readyPromise) await db.readyPromise;
  const entries = entryMap(db);
  let entry = entries.get(profile);
  if (!entry) {
    entry = {
      library: null,
      ready: prepareLibrary({
        dbopfs: db,
        bundleUrl: bundleUrl || DEFAULT_BOSS_BUNDLE_URL,
        onStatus,
        profileId: profile,
        signal,
      }),
    };
    entries.set(profile, entry);
    try {
      entry.library = await entry.ready;
    } catch (error) {
      entries.delete(profile);
      throw error;
    }
  } else if (!entry.library) {
    entry.library = await entry.ready;
  }
  return entry.library;
}

function corpusStats(corpus) {
  const documents = corpus.matches || [];
  const bossCount = documents.filter((document) => document.kind === "boss-library").length;
  const userCount = documents.filter((document) => document.kind === "user-import").length;
  return {
    boss: bossCount,
    bossCount,
    bossDocuments: bossCount,
    failures: corpus.failures || [],
    imported: userCount,
    total: documents.length,
    userCount,
    userDocuments: userCount,
  };
}

async function initializeRag({
  dbopfs = globalThis.dbopfs,
  bundleUrl = DEFAULT_BOSS_BUNDLE_URL,
  onStatus,
  profileId = "general",
  signal,
} = {}) {
  const library = await libraryFor(profileId, {
    dbopfs,
    bundleUrl,
    onStatus,
    signal,
  });
  const corpus = await library.search("", { signal });
  reportStatus(onStatus, "Local Arcane document library ready.");
  return corpusStats(corpus);
}

async function getRagStats(profileId = "general", {
  dbopfs = globalThis.dbopfs,
  signal,
} = {}) {
  const library = await libraryFor(profileId, { dbopfs, signal });
  return corpusStats(await library.search("", { signal }));
}

async function importedDocument(file, profileId) {
  const fallbackId = `${Date.now()}-${Math.random()}`;
  const id = `user-${profileId}-${globalThis.crypto?.randomUUID?.() || fallbackId}`;
  const body = await file.text();
  return {
    body,
    id,
    kind: "user-import",
    mediaType: file.type === "text/markdown" ? "text/markdown" : "text/plain",
    path: file.name || id,
    searchTerms: splitTerms(file.name),
    sourcePath: file.name || id,
    tags: [profileId, "user-import"],
    title: file.name || "Imported document",
  };
}

async function importRagFiles(files, {
  dbopfs = globalThis.dbopfs,
  onStatus,
  profileId = "general",
  signal,
} = {}) {
  if (!Array.isArray(files)) throw new TypeError("RAG files must be an array.");
  const profile = normalizeProfileId(profileId);
  const library = await libraryFor(profile, { dbopfs, onStatus, signal });
  const corpus = await library.search("", { signal });
  const imported = [];
  for (let index = 0; index < files.length; index += 1) {
    if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
    const file = files[index];
    if (!file || typeof file.text !== "function") {
      throw new TypeError(`RAG file ${index + 1} is not a browser File.`);
    }
    reportStatus(onStatus, `Reading ${file.name || `document ${index + 1}`}…`);
    imported.push(await importedDocument(file, profile));
  }
  await library.bootstrap({
    files: [...corpus.matches, ...imported],
    signal,
    onProgress(progress) {
      if (progress?.phase === "writing") {
        reportStatus(
          onStatus,
          `Storing local documents ${progress.completed} of ${progress.total}…`,
        );
      }
    },
  });
  return {
    imported: imported.length,
    stats: corpusStats(await library.search("", { signal })),
  };
}

async function retrieveRagContext(query, {
  dbopfs = globalThis.dbopfs,
  profileId = "general",
  signal,
} = {}) {
  const profile = normalizeProfileId(profileId);
  const library = await libraryFor(profile, { dbopfs, signal });
  const result = await library.search(String(query || ""), { signal });
  const matches = result.matches.filter((document) => document.score > 0);
  const documents = matches.map((document) => [
    "[BEGIN DOCUMENT]",
    `id: ${document.id}`,
    `title: ${document.title}`,
    `path: ${document.path}`,
    document.body,
    "[END DOCUMENT]",
  ].join("\n"));
  let text = "";
  if (documents.length && profile === "boss") {
    text = [
      "<boss_library_context>",
      ...documents,
      "</boss_library_context>",
    ].join("\n\n");
  } else if (documents.length) {
    text = ["LOCAL DOCUMENT CONTEXT", ...documents].join("\n\n");
  }
  return { failures: result.failures, matches, text };
}

export {
  getRagStats,
  importRagFiles,
  initializeRag,
  retrieveRagContext,
};

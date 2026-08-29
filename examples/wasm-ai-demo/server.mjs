import http from "node:http";
import https from "node:https";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const sdkRoot = path.resolve(root, "..", "..");
const examplePath = "/examples/wasm-ai-demo";
const requestedPort = Number.parseInt(process.argv[2] || "4173", 10);
const port = Number.isFinite(requestedPort) ? requestedPort : 4173;
const host = process.argv[3] || "0.0.0.0";
const modelDirectory = process.env.ARCANE_WASM_MODEL_ROOT
  ? path.resolve(process.env.ARCANE_WASM_MODEL_ROOT)
  : path.join(root, "models");
const tlsDirectory = process.env.ARCANE_WASM_TLS_ROOT
  ? path.resolve(process.env.ARCANE_WASM_TLS_ROOT)
  : path.join(root, "tls");
const tlsKeyPath = path.join(tlsDirectory, "server-key.pem");
const tlsCertificatePath = path.join(tlsDirectory, "server.pem");
const useHttps = existsSync(tlsKeyPath) && existsSync(tlsCertificatePath);

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".modelfile", "text/plain; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".gguf", "application/octet-stream"],
]);

const publicFiles = new Map([
  [`${examplePath}/`, path.join(root, "index.html")],
  [`${examplePath}/index.html`, path.join(root, "index.html")],
  [`${examplePath}/app.js`, path.join(root, "app.js")],
  [`${examplePath}/rag.js`, path.join(root, "rag.js")],
  [`${examplePath}/profile-tools.js`, path.join(root, "profile-tools.js")],
]);

const publicDirectories = new Map([
  [`${examplePath.slice(1)}/models`, modelDirectory],
  [`${examplePath.slice(1)}/profiles`, path.join(root, "profiles")],
  [`${examplePath.slice(1)}/rag`, path.join(root, "rag")],
  ["src", path.join(sdkRoot, "src")],
  ["browser-runtime", path.join(sdkRoot, "browser-runtime")],
  ["runtime/arcane", path.join(sdkRoot, "runtime", "arcane")],
  ["runtime/strong-type", path.join(sdkRoot, "runtime", "strong-type")],
]);

function resolveRequestPath(url) {
  const pathname = decodeURIComponent(new URL(url, "http://127.0.0.1").pathname);
  if (publicFiles.has(pathname)) return publicFiles.get(pathname);

  const relativePath = pathname.replace(/^\/+/, "");
  for (const [publicPrefix, publicDirectory] of publicDirectories) {
    const prefix = `${publicPrefix}/`;
    if (!relativePath.startsWith(prefix)) continue;

    const childPath = relativePath.slice(prefix.length);
    const resolved = path.resolve(publicDirectory, childPath);
    return resolved.startsWith(`${publicDirectory}${path.sep}`) ? resolved : null;
  }
  return null;
}

function commonHeaders(filePath, length) {
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
    "Content-Length": length,
    "Content-Type": contentTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream",
    // Browser-WASM threading requires a cross-origin-isolated page.
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
  return headers;
}

function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value || "");
  if (!match) return null;

  if (!match[1]) {
    const suffixLength = Number.parseInt(match[2], 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number.parseInt(match[1], 10);
  const end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
  if (
    !Number.isFinite(start)
    || !Number.isFinite(end)
    || start < 0
    || start >= size
    || end < start
  ) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

const requestHandler = async (request, response) => {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }

    const pathname = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname);
    if (pathname === "/") {
      response.writeHead(302, { Location: `${examplePath}/` }).end();
      return;
    }

    const filePath = resolveRequestPath(request.url || "/");
    if (!filePath) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error("Not a file");

    const rangeHeader = request.headers.range;
    const range = rangeHeader ? parseRange(rangeHeader, metadata.size) : null;
    if (rangeHeader && !range) {
      response.writeHead(416, { "Content-Range": `bytes */${metadata.size}` }).end();
      return;
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? metadata.size - 1;
    const length = Math.max(0, end - start + 1);
    const headers = commonHeaders(filePath, length);
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${metadata.size}`;
    response.writeHead(range ? 206 : 200, headers);

    if (request.method === "HEAD" || length === 0) {
      response.end();
      return;
    }

    const stream = createReadStream(filePath, { start, end });
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  } catch {
    response.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    });
    response.end("Not found");
  }
};

const server = useHttps
  ? https.createServer({
    key: readFileSync(tlsKeyPath),
    cert: readFileSync(tlsCertificatePath),
  }, requestHandler)
  : http.createServer(requestHandler);

server.listen(port, host, () => {
  const protocol = useHttps ? "https" : "http";
  console.log(`Arcane WASM Voice Chat listening on ${protocol}://${host}:${port}`);
  console.log(`Example URL: ${protocol}://localhost:${port}${examplePath}/`);
  console.log(`Live Arcane SDK source: ${sdkRoot}`);
});

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startSourceExampleServer } from "arcane-os";

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
const tls = existsSync(tlsKeyPath) && existsSync(tlsCertificatePath)
  ? {
      key: readFileSync(tlsKeyPath),
      cert: readFileSync(tlsCertificatePath),
    }
  : undefined;

const running = await startSourceExampleServer({
  crossOriginIsolated: true,
  host,
  mounts: [
    {
      include: [
        "index.html",
        "app.js",
        "rag.js",
        "profile-tools.js",
        "profiles/",
        "rag/",
      ],
      index: "index.html",
      root,
      urlPath: examplePath,
    },
    {
      root: modelDirectory,
      urlPath: `${examplePath}/models`,
    },
    {
      root: path.join(sdkRoot, "src"),
      urlPath: "/src",
    },
    {
      root: path.join(sdkRoot, "browser-runtime"),
      urlPath: "/browser-runtime",
    },
    {
      include: ["arcane/", "strong-type/"],
      root: path.join(sdkRoot, "runtime"),
      urlPath: "/runtime",
    },
  ],
  port,
  startPath: `${examplePath}/`,
  tls,
});

console.log(`Arcane WASM Voice Chat listening on ${running.origin}`);
console.log(`Example URL: ${running.url}`);
console.log(`Live Arcane SDK source: ${sdkRoot}`);

await running.closed;

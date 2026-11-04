import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SECURITY_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function sendError(response, status, message) {
  const body = `${status} ${message}\n`;
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

/**
 * Minimal static file server with COOP/COEP headers.
 * Exported so tests can start it on an ephemeral port.
 */
export function createStaticServer({ root }) {
  const rootDir = resolve(root);

  return http.createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendError(response, 405, "Method Not Allowed");
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    } catch {
      sendError(response, 400, "Bad Request");
      return;
    }

    if (pathname.endsWith("/")) {
      pathname += "index.html";
    }

    const filePath = resolve(rootDir, `.${pathname}`);
    if (filePath !== rootDir && !filePath.startsWith(rootDir + sep)) {
      sendError(response, 404, "Not Found");
      return;
    }

    let info;
    try {
      info = await stat(filePath);
    } catch {
      sendError(response, 404, "Not Found");
      return;
    }

    if (info.isDirectory()) {
      sendError(response, 404, "Not Found");
      return;
    }

    const headers = {
      ...SECURITY_HEADERS,
      "Content-Type": MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": "no-cache",
    };

    response.writeHead(200, headers);
    if (request.method === "HEAD") {
      response.end();
      return;
    }

    const stream = createReadStream(filePath);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  });
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? "127.0.0.1";
  const root = resolve(process.env.ROOT ?? join(fileURLToPath(import.meta.url), "..", ".."));
  const server = createStaticServer({ root });
  server.listen(port, host, () => {
    console.log(`Serving ${root}`);
    console.log(`http://${host}:${port}/demo/index.html`);
  });
}

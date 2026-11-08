#!/usr/bin/env node
/**
 * shifting.pro — zero-dependency local dev server.
 *
 * The game is still a no-build, no-runtime-dependency static site, but since
 * issue #68 its ES-module graph is served from a versioned URL prefix
 * (`/v/<package version>/js/...`) that only exists as a production rewrite:
 *
 *   vercel.json: /v/:version/js/:path*  ->  /js/:path*
 *
 * A plain static file server (`python3 -m http.server`) cannot resolve those
 * URLs any more, so this script serves the repo and applies the SAME rewrites
 * locally. It deliberately does NOT emulate the production Cache-Control policy
 * (`/v/*` is immutable for a year): a local edit must show up on the next
 * reload, so every response is `Cache-Control: no-store` — that is the only
 * difference from the deployed routing behaviour.
 *
 * Usage:
 *   node scripts/dev-server.mjs                 # http://localhost:8080 + /draw
 *   node scripts/dev-server.mjs --port 9000
 *   PORT=9000 node scripts/dev-server.mjs
 *
 * No npm install is required: only Node built-ins are used.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('shifting.pro dev server');
  console.log('  node scripts/dev-server.mjs [--port <n>]   (default 8080, or $PORT)');
  process.exit(0);
}
const portFlag = args.find((arg) => arg.startsWith('--port='))?.slice('--port='.length);
const portIndex = args.indexOf('--port');
const portValue =
  portFlag ??
  (portIndex >= 0 && args[portIndex + 1] ? args[portIndex + 1] : undefined) ??
  process.env.PORT;
const PORT = Number(portValue) || 8080;
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`dev-server: invalid port "${portValue}"`);
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

// ── Production rewrite emulation (vercel.json `rewrites`) ──────────────────
/**
 * Compile a Vercel path pattern to an anchored RegExp + ordered capture names.
 * Supports `:name` (one path segment) and `:name*` (zero or more segments,
 * e.g. `/v/:version/js/:path*`). This is the subset of path-to-regexp that the
 * site's vercel.json uses; a future pattern with regex groups would need this
 * extended (and scripts/verify.mjs fails if the /v/ rewrite drifts anyway).
 */
function compileSource(source) {
  const keys = [];
  let pattern = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === ':') {
      const match = source.slice(index + 1).match(/^([A-Za-z0-9_]+)(\*)?/);
      if (match) {
        keys.push(match[1]);
        pattern += match[2] ? '(.*)' : '([^/]+)';
        index += match[0].length;
        continue;
      }
    }
    pattern += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return { regex: new RegExp(`^${pattern}$`), keys };
}

function compileRewrites(rewrites) {
  return (Array.isArray(rewrites) ? rewrites : [])
    .filter((rewrite) => rewrite && rewrite.source && rewrite.destination)
    .map(({ source, destination }) => ({ ...compileSource(source), destination }));
}

function applyRewrites(pathname, rewrites) {
  for (const rewrite of rewrites) {
    const match = pathname.match(rewrite.regex);
    if (!match) continue;
    return rewrite.destination.replace(/:([A-Za-z0-9_]+)\*?/g, (token, name) => {
      const index = rewrite.keys.indexOf(name);
      return index >= 0 ? String(match[index + 1] ?? '') : token;
    });
  }
  return null;
}

let rewrites = [];
try {
  const config = JSON.parse(readFileSync(resolve(ROOT, 'vercel.json'), 'utf8'));
  rewrites = compileRewrites(config.rewrites);
} catch (err) {
  console.error(
    `dev-server: could not read vercel.json rewrites (${err.message}) — serving raw paths`
  );
}

// `/` and `/draw` resolve while the production config has a /draw rewrite;
// keep the root mapping here so the server works even without vercel.json.
function toFilePath(requestPath) {
  const rewritten = applyRewrites(requestPath, rewrites) ?? requestPath;
  if (rewritten === '/') return '/index.html';
  return rewritten;
}

const server = createServer(async (req, res) => {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
    res.end('method not allowed');
    return;
  }
  let requestPath;
  try {
    requestPath = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }
  if (requestPath.includes('\0')) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }

  const filePath = toFilePath(requestPath);
  const full = resolve(ROOT, `.${filePath}`);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  if (!existsSync(full)) {
    console.warn(`  404  ${requestPath}${filePath !== requestPath ? ` -> ${filePath}` : ''}`);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`not found: ${requestPath}`);
    return;
  }
  try {
    const data = await readFile(full);
    const headers = {
      'content-type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
      'content-length': String(data.length),
      // Local dev never caches: edits must show up on the next reload. The
      // deployed /v/* immutable cache policy is intentionally NOT emulated.
      'cache-control': 'no-store',
      'x-openshiftgames-dev-route': filePath === requestPath ? 'direct' : 'rewrite',
    };
    res.writeHead(200, headers);
    if (method === 'HEAD') res.end();
    else res.end(data);
  } catch (err) {
    console.error(`  500  ${requestPath}: ${err.message}`);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('internal server error');
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `dev-server: port ${PORT} is already in use. Use --port <n> or PORT=<n> node scripts/dev-server.mjs.`
    );
  } else {
    console.error(`dev-server: ${err?.message || err}`);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('shifting.pro — local dev server (no build step, no npm install)');
  console.log(`  game:       http://localhost:${PORT}/`);
  console.log(`  whiteboard: http://localhost:${PORT}/draw`);
  console.log(
    `  rewrites:   ${rewrites.length ? rewrites.length + ' rule(s) from vercel.json emulated' : 'none'} (Cache-Control: no-store)`
  );
  console.log('  stop:       Ctrl+C');
});

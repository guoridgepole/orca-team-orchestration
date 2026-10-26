#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectConfigPath, readProjectSettings } from '../core/config.js';
import { CliError, PromptError } from '../core/errors.js';
import { resolveOrcaBinary } from '../core/orca.js';
import { findRepoRoot } from '../core/paths.js';
import { planRolePrompts, readRolesSnapshot, saveRolePrompts } from '../core/prompts.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const MAX_BODY_BYTES = 1024 * 1024;
const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

export interface UiServerOptions {
  projectRoot: string;
  publicRoot: string;
  host: string;
  port: number;
}

export function resolveProjectRoot(cwd = process.cwd()): string {
  const override = process.env.ORCA_TEAM_ORCHESTRATION_REPO;
  if (override && override.trim() !== '') return path.resolve(override);
  try {
    return findRepoRoot(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

export function resolvePublicRoot(): string {
  const override = process.env.ORCA_TEAM_ORCHESTRATION_PUBLIC;
  if (override && override.trim() !== '') return path.resolve(override);

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  let current = moduleDir;
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = path.join(current, 'public');
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(moduleDir, '..', '..', '..', 'public');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function sendError(
  response: http.ServerResponse,
  statusCode: number,
  code: string,
  message: string,
): void {
  sendJson(response, statusCode, { error: { code, message } });
}

function sendText(
  response: http.ServerResponse,
  statusCode: number,
  message: string,
  headers: http.OutgoingHttpHeaders = {},
): void {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(message);
}

function projectStatus(projectRoot: string): Record<string, unknown> {
  const snapshot = readProjectSettings(projectRoot);
  const settings = snapshot.settings;
  const orca = resolveOrcaBinary();
  const repos = settings.project.repos.map((repo) => ({ name: repo.name, path: repo.path }));
  return {
    ready: true,
    projectRoot,
    configPath: projectConfigPath(projectRoot),
    configFound: snapshot.initialized,
    configValid: snapshot.valid,
    configError: snapshot.error,
    projectName: settings.project.name ?? path.basename(projectRoot),
    workspace: repos.length > 0,
    repos,
    startCommand: settings.project.commands.start,
    testCommand: settings.project.commands.test,
    buildCommand: settings.project.commands.build,
    baseUrl: settings.project.commands.base_url,
    orcaInstalled: Boolean(orca),
    orcaPath: orca,
  };
}

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  return value.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

function originAllowed(request: http.IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const host = request.headers.host;
    if (parsed.protocol !== 'http:' || parsed.host !== host) return false;
    return LOOPBACK_HOSTS.has(parsed.hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        request.resume();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

class BodyTooLargeError extends Error {
  constructor() {
    super(`请求体超过 ${MAX_BODY_BYTES} 字节`);
    this.name = 'BodyTooLargeError';
  }
}

function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError(400, 'bad_json', '请求体不是合法 JSON');
  }
}

class RequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

function errorResponse(response: http.ServerResponse, error: unknown): void {
  if (error instanceof RequestError) {
    sendError(response, error.statusCode, error.code, error.message);
    return;
  }
  if (error instanceof BodyTooLargeError) {
    sendError(response, 413, 'payload_too_large', error.message);
    return;
  }
  if (error instanceof PromptError) {
    if (error.kind === 'bad_request') {
      sendError(response, 400, 'bad_request', error.message);
    } else if (error.kind === 'conflict') {
      sendError(response, 409, 'conflict', error.message);
    } else if (error.kind === 'invalid') {
      sendError(response, 422, 'invalid_config', error.message);
    } else {
      sendError(response, 409, 'config_state', error.message);
    }
    return;
  }
  if (error instanceof CliError) {
    const missing = error.message.includes('未找到 .orca-team-orchestration/config.yaml');
    sendError(response, missing ? 409 : 422, missing ? 'not_initialized' : 'invalid_config', error.message);
    return;
  }
  console.error(error);
  sendError(response, 500, 'internal_error', '服务器内部错误');
}

function serveFile(
  response: http.ServerResponse,
  publicRoot: string,
  pathname: string,
  headOnly: boolean,
): void {
  let relative: string;
  try {
    relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  } catch {
    sendText(response, 400, 'Bad Request\n');
    return;
  }

  const file = path.resolve(publicRoot, relative);
  const prefix = `${publicRoot}${path.sep}`;
  if (file !== publicRoot && !file.startsWith(prefix)) {
    sendText(response, 403, 'Forbidden\n');
    return;
  }

  let body: Buffer;
  try {
    body = fs.readFileSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') {
      sendText(response, 404, 'Not Found\n');
      return;
    }
    throw error;
  }

  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(headOnly ? undefined : body);
}

async function handleRolesRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  projectRoot: string,
  save: boolean,
): Promise<void> {
  if (!originAllowed(request)) {
    sendError(response, 403, 'forbidden_origin', 'Origin 不在允许范围内');
    return;
  }
  if (!isJsonContentType(request.headers['content-type'])) {
    sendError(response, 415, 'unsupported_media_type', '请求体必须是 application/json');
    return;
  }

  const body = await readBody(request);
  const patch = parseJsonBody(body.toString('utf8'));
  const snapshot = readRolesSnapshot(projectRoot);
  if (!snapshot.initialized) {
    sendError(response, 409, 'not_initialized', snapshot.error ?? '项目尚未初始化');
    return;
  }
  if (snapshot.errorKind === 'parse') {
    sendError(response, 409, 'parse_error', snapshot.error ?? 'config.yaml 无法解析');
    return;
  }
  if (!snapshot.valid) {
    sendError(response, 409, 'invalid_config', snapshot.error ?? 'config.yaml 校验失败');
    return;
  }

  if (!save) {
    sendJson(response, 200, planRolePrompts(projectRoot, patch));
    return;
  }

  const plan = saveRolePrompts(projectRoot, patch);
  sendJson(response, 200, { plan, snapshot: readRolesSnapshot(projectRoot) });
}

export function createUiServer(options: UiServerOptions): http.Server {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? options.host}`);
      const method = request.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/api/status') {
        sendJson(response, 200, projectStatus(options.projectRoot));
        return;
      }
      if (method === 'GET' && url.pathname === '/healthz') {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/roles') {
        sendJson(response, 200, readRolesSnapshot(options.projectRoot));
        return;
      }
      if (method === 'POST' && url.pathname === '/api/roles/preview') {
        await handleRolesRequest(request, response, options.projectRoot, false);
        return;
      }
      if (method === 'POST' && url.pathname === '/api/roles') {
        await handleRolesRequest(request, response, options.projectRoot, true);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        sendError(response, 404, 'not_found', '接口不存在');
        return;
      }
      if (method !== 'GET' && method !== 'HEAD') {
        sendText(response, 405, 'Method Not Allowed\n', { Allow: 'GET, HEAD' });
        return;
      }
      serveFile(response, options.publicRoot, url.pathname, method === 'HEAD');
    } catch (error) {
      if (!response.headersSent) errorResponse(response, error);
      else response.end();
    }
  });
}

export async function startUiServer(
  options: Partial<UiServerOptions> = {},
): Promise<{ server: http.Server; url: string; projectRoot: string }> {
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  if (!isLoopbackHost(host)) {
    throw new Error(`仅允许监听回环地址（127.0.0.1 / localhost / ::1）：${host}`);
  }
  const port = options.port ?? Number(process.env.PORT ?? '5173');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT 非法：${process.env.PORT}`);
  }
  const projectRoot = options.projectRoot ?? resolveProjectRoot();
  const publicRoot = options.publicRoot ?? resolvePublicRoot();
  if (!fs.existsSync(path.join(publicRoot, 'index.html'))) {
    throw new Error(`未找到页面资源：${publicRoot}`);
  }

  const server = createUiServer({ projectRoot, publicRoot, host, port });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const hostForUrl = host.includes(':') ? `[${host}]` : host;
  return { server, url: `http://${hostForUrl}:${actualPort}/`, projectRoot };
}

const invoked = process.argv[1] ? pathToFileURL(fs.realpathSync(process.argv[1])).href : '';
if (invoked && import.meta.url === invoked) {
  startUiServer()
    .then(({ server, url, projectRoot }) => {
      console.log(`Orca Team Orchestration 页面已启动：${url}`);
      console.log(`项目目录：${projectRoot}`);
      console.log('按 Ctrl+C 停止服务。');
      console.log(`ORCA_TEAM_ORCHESTRATION_READY ${url}`);

      const shutdown = (): void => {
        server.close(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        console.error(`端口已被占用。请停止占用该端口的进程，或使用 PORT=其他端口 npm run dev。`);
      } else {
        console.error(message);
      }
      process.exit(1);
    });
}

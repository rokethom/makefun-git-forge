// The forge's HTTP surface: one process, one store, four protocols. The router owns the request id,
// the JSON error shape and the auth gate; each surface answers its own paths.
//
// The read and write workloads are thousands of small REST calls on one keep-alive connection, so
// this file keeps the per-request work to a minimum: the path is split by hand instead of through
// `new URL`, a GET never touches the body stream, and a reply that was already rendered to JSON is
// written as it is.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest, JSON_TYPE, type Reply } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { receivePack, receivePackAdvertisement, uploadPack, uploadPackAdvertisement } from './githttp.ts';
import { Store } from './store.ts';

/** The bearer token the suite presents; a request without it is 401 on the API surfaces. */
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The query of a request that carries none. */
const NO_QUERY = new URLSearchParams();

/** A deterministic request id: the same sequence of requests answers the same ids. */
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `MF-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Read a request body into one buffer. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Answer with a JSON body and the headers every reply carries. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Readonly<Record<string, string>>, raw?: string, rawBytes?: number): void {
  const text = raw !== undefined ? raw : body === null ? '' : `${JSON.stringify(body)}\n`;
  const length = rawBytes !== undefined ? rawBytes : Buffer.byteLength(text);
  const base: Record<string, string | number> = { 'content-type': JSON_TYPE, 'content-length': length, 'x-github-request-id': nextRequestId() };
  if (headers !== undefined) Object.assign(base, headers);
  res.writeHead(status, base);
  res.end(text);
}

/** Answer with raw bytes (the git surfaces). */
function sendRaw(res: ServerResponse, status: number, body: Buffer, headers: Readonly<Record<string, string>>): void {
  res.writeHead(status, { 'content-length': body.length, 'x-github-request-id': nextRequestId(), ...headers });
  res.end(body);
}

/** Whether the request carries the trial's bearer token. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (header === undefined || header.length < 8 || !header.startsWith('Bearer ')) return false;
  const presented = header.slice(7).trim();
  if (TOKEN === '') return presented !== '';
  return presented === TOKEN;
}

/** The git smart-HTTP route: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}. */
const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const target = req.url ?? '/';
      const mark = target.indexOf('?');
      const path = mark === -1 ? target : target.slice(0, mark);
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // The REST surface first: it is most of the traffic.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
          return;
        }
        let body: unknown = null;
        if (method !== 'GET' && method !== 'HEAD') {
          const raw = await readBody(req);
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'Problems parsing JSON', documentation_url: 'https://docs.github.com/rest' });
              return;
            }
          }
        }
        const query = mark === -1 ? NO_QUERY : new URLSearchParams(target.slice(mark + 1));
        const origin = `http://${req.headers.host ?? 'entry'}`;
        const reply: Reply | null = handleRest({ method, path, query, body, store, origin });
        if (reply === null) {
          sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
          return;
        }
        sendJson(res, reply.status, reply.body, reply.headers, reply.raw, reply.rawBytes);
        return;
      }

      // git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
      const gitMatch = GIT_ROUTE.exec(path);
      if (gitMatch !== null) {
        const [, owner, name, action] = gitMatch;
        const repo = store.find(owner, name);
        if (repo === undefined || repo.owner.toLowerCase() !== store.viewer.login) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (action === 'info/refs') {
          const service = mark === -1 ? '' : new URLSearchParams(target.slice(mark + 1)).get('service') ?? '';
          if (service === 'git-upload-pack') {
            sendRaw(res, 200, uploadPackAdvertisement(), { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' });
            return;
          }
          if (service === 'git-receive-pack') {
            sendRaw(res, 200, receivePackAdvertisement(repo), { 'content-type': 'application/x-git-receive-pack-advertisement', 'cache-control': 'no-cache' });
            return;
          }
          sendJson(res, 400, { message: 'Bad Request' });
          return;
        }
        const body = await readBody(req);
        if (action === 'git-upload-pack') {
          sendRaw(res, 200, uploadPack(store, repo, body), { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
          return;
        }
        sendRaw(res, 200, receivePack(store, repo, body), { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' });
        return;
      }

      if (path === '/api/graphql' || path.startsWith('/api/graphql/')) {
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
          return;
        }
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        const reply = handleGraphQL(store, parsed);
        sendJson(res, reply.status, reply.body, reply.headers);
        return;
      }

      if (path === '/mcp' || path.startsWith('/mcp/')) {
        const raw = await readBody(req);
        const reply = handleMcp(store, req, raw);
        sendJson(res, reply.status, reply.body, reply.headers);
        return;
      }

      sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
    })().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, 500, { message });
      else res.end();
    });
  });
}

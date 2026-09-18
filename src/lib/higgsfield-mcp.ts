import {createHash, randomUUID} from 'node:crypto';

// A client of the official MCP service, not a replacement generation API.
// OAuth state, company authority, encrypted storage, durable spending intents,
// tool allowlists and refresh serialization belong to the caller.
export const HIGGSFIELD_MCP_ENDPOINT = 'https://mcp.higgsfield.ai/mcp';
export const HIGGSFIELD_OAUTH_REDIRECT_URI = 'https://coatria.com/api/higgsfield/callback';
const issuer = 'https://clerk.higgsfield.ai';
const resourceMetadata = 'https://mcp.higgsfield.ai/.well-known/oauth-protected-resource/mcp';
const scopes = ['openid', 'email', 'offline_access'];
const versions = new Set(['2025-11-25', '2025-06-18', '2025-03-26']);
const responseLimit = 2 * 1024 * 1024;
type ObjectValue = Record<string, unknown>;

export type HiggsfieldMetadata = {
  resource: string; issuer: string; authorization_endpoint: string;
  token_endpoint: string; registration_endpoint: string; scopes: string[];
  client_id_metadata_document_supported?: boolean;
};
export type HiggsfieldClient = {
  client_id: string; redirect_uris: string[]; token_endpoint_auth_method: 'none';
};
export type HiggsfieldToken = {
  access_token: string; refresh_token?: string; token_type: 'Bearer';
  expires_in: number; scope?: string;
};
export type HiggsfieldTool = {
  name: string; description: string; inputSchema: ObjectValue;
  title?: string; outputSchema?: ObjectValue; annotations?: ObjectValue; _meta?: ObjectValue;
};
export type HiggsfieldToolResult = {
  content: ObjectValue[]; isError?: boolean; structuredContent?: ObjectValue; _meta?: ObjectValue;
};
export type HiggsfieldTransport = typeof fetch | {fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number};

export class HiggsfieldMcpError extends Error {
  constructor(public code: string, public status = 502, public retryAfterSeconds?: number) {
    // Never include OAuth codes, tokens, arguments, response bodies or remote error text.
    super(code === 'HIGGSFIELD_UNAUTHORIZED' ? 'Reconnect the official Higgsfield account.' : 'The official Higgsfield operation could not be confirmed.');
    this.name = 'HiggsfieldMcpError';
  }
}
function bad(code = 'HIGGSFIELD_INVALID_RESPONSE', status = 502): never {throw new HiggsfieldMcpError(code, status);}
const object = (value: unknown): value is ObjectValue => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function text(value: unknown, max = 8192): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function json(value: unknown, max: number): string {
  try {const result = JSON.stringify(value); if (!result || Buffer.byteLength(result) > max) return bad('HIGGSFIELD_REQUEST_LIMIT', 400); return result;}
  catch (error) {if (error instanceof HiggsfieldMcpError) throw error; return bad('HIGGSFIELD_INVALID_INPUT', 400);}
}
function validateMetadata(metadata: HiggsfieldMetadata) {
  if (!metadata || metadata.resource !== HIGGSFIELD_MCP_ENDPOINT || metadata.issuer !== issuer ||
      metadata.authorization_endpoint !== issuer + '/oauth/authorize' || metadata.token_endpoint !== issuer + '/oauth/token' ||
      metadata.registration_endpoint !== issuer + '/oauth/register' || !Array.isArray(metadata.scopes) ||
      metadata.scopes.length !== scopes.length || !scopes.every(scope => metadata.scopes.includes(scope))) bad('HIGGSFIELD_DISCOVERY_CHANGED');
}
function validateRedirect(redirectUri: string) {
  if (redirectUri !== HIGGSFIELD_OAUTH_REDIRECT_URI) bad('HIGGSFIELD_REDIRECT_INVALID', 400);
}
function validateClient(client: HiggsfieldClient, redirectUri = HIGGSFIELD_OAUTH_REDIRECT_URI) {
  validateRedirect(redirectUri);
  if (!client || !text(client.client_id, 2048) || client.token_endpoint_auth_method !== 'none' ||
      !Array.isArray(client.redirect_uris) || client.redirect_uris.length !== 1 || client.redirect_uris[0] !== redirectUri) bad('HIGGSFIELD_CLIENT_INVALID', 400);
}
function verifier(value: string) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(value)) bad('HIGGSFIELD_PKCE_INVALID', 400);
}
type Context = {fetch: typeof fetch; signal: AbortSignal};
function context(transport: HiggsfieldTransport = {}): Context {
  const options = typeof transport === 'function' ? {fetch: transport} : transport;
  const timeoutMs = options.timeoutMs ?? 25000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) bad('HIGGSFIELD_TIMEOUT_INVALID', 400);
  const timeout = AbortSignal.timeout(timeoutMs);
  return {fetch: options.fetch ?? fetch, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout};
}
async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) bad('HIGGSFIELD_TIMEOUT', 504);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new HiggsfieldMcpError('HIGGSFIELD_TIMEOUT', 504));
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve().then(() => {if (signal.aborted) return bad('HIGGSFIELD_TIMEOUT', 504); return operation();})
      .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
const allowedUrls = new Set([resourceMetadata, issuer + '/.well-known/oauth-authorization-server',
  issuer + '/.well-known/openid-configuration', issuer + '/oauth/register', issuer + '/oauth/token', HIGGSFIELD_MCP_ENDPOINT]);
async function request(ctx: Context, url: string, init: RequestInit): Promise<Response> {
  if (!allowedUrls.has(url)) bad('HIGGSFIELD_DESTINATION_INVALID', 400);
  try {
    const response = await abortable(async () => {
      const received = await ctx.fetch(url, {...init, redirect: 'error', cache: 'no-store', signal: ctx.signal});
      if (ctx.signal.aborted) {void received.body?.cancel().catch(() => {}); bad('HIGGSFIELD_TIMEOUT', 504);}
      return received;
    }, ctx.signal);
    if (response.redirected || response.url && response.url !== url) {void response.body?.cancel().catch(() => {}); bad('HIGGSFIELD_REDIRECT_REJECTED');}
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const retry = response.headers.get('retry-after'), seconds = retry && /^\d{1,5}$/.test(retry) ? Math.min(3600, Number(retry)) : undefined;
      throw new HiggsfieldMcpError(response.status === 401 ? 'HIGGSFIELD_UNAUTHORIZED' : 'HIGGSFIELD_HTTP_ERROR', response.status, seconds);
    }
    return response;
  } catch (error) {
    if (error instanceof HiggsfieldMcpError) throw error;
    return bad(ctx.signal.aborted ? 'HIGGSFIELD_TIMEOUT' : 'HIGGSFIELD_TRANSPORT_UNCONFIRMED', ctx.signal.aborted ? 504 : 502);
  }
}
async function body(ctx: Context, response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) return bad();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const part = await abortable(() => reader.read(), ctx.signal); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > maxBytes) bad('HIGGSFIELD_RESPONSE_LIMIT'); chunks.push(part.value);
    }
    try {return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));} catch {return bad();}
  } catch (error) {void reader.cancel().catch(() => {}); if (error instanceof HiggsfieldMcpError) throw error; return bad('HIGGSFIELD_TRANSPORT_UNCONFIRMED');}
}
async function jsonRequest(ctx: Context, url: string, init: RequestInit, maxBytes = 65536) {
  const response = await request(ctx, url, init);
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {void response.body?.cancel().catch(() => {}); bad();}
  return body(ctx, response, maxBytes);
}

/** Public metadata GETs only. Selecting the advertised Clerk PKCE issuer is deliberate. */
export async function discoverHiggsfield(transport?: HiggsfieldTransport): Promise<HiggsfieldMetadata> {
  const ctx = context(transport), resource = await jsonRequest(ctx, resourceMetadata, {headers: {Accept: 'application/json'}});
  if (!object(resource) || resource.resource !== HIGGSFIELD_MCP_ENDPOINT || !Array.isArray(resource.authorization_servers) ||
      !resource.authorization_servers.includes(issuer) || !Array.isArray(resource.scopes_supported) || !scopes.every(scope => (resource.scopes_supported as unknown[]).includes(scope))) bad('HIGGSFIELD_DISCOVERY_CHANGED');
  let server: unknown;
  try {server = await jsonRequest(ctx, issuer + '/.well-known/oauth-authorization-server', {headers: {Accept: 'application/json'}});}
  catch (error) {if (!(error instanceof HiggsfieldMcpError) || ![404, 405].includes(error.status)) throw error; server = await jsonRequest(ctx, issuer + '/.well-known/openid-configuration', {headers: {Accept: 'application/json'}});}
  if (!object(server) || !Array.isArray(server.code_challenge_methods_supported) || !server.code_challenge_methods_supported.includes('S256') ||
      !Array.isArray(server.grant_types_supported) || !['authorization_code', 'refresh_token'].every(grant => (server.grant_types_supported as unknown[]).includes(grant)) ||
      !Array.isArray(server.token_endpoint_auth_methods_supported) || !server.token_endpoint_auth_methods_supported.includes('none')) bad('HIGGSFIELD_DISCOVERY_CHANGED');
  const result = {resource: HIGGSFIELD_MCP_ENDPOINT, issuer: server.issuer, authorization_endpoint: server.authorization_endpoint,
    token_endpoint: server.token_endpoint, registration_endpoint: server.registration_endpoint, scopes: [...scopes],
    client_id_metadata_document_supported: server.client_id_metadata_document_supported === true} as HiggsfieldMetadata;
  validateMetadata(result); return result;
}

/** One registration POST. No automatic retry if its response is lost. */
export async function registerHiggsfield(metadata: HiggsfieldMetadata, redirectUri: string, transport?: HiggsfieldTransport): Promise<HiggsfieldClient> {
  validateMetadata(metadata); validateRedirect(redirectUri);
  const response = await jsonRequest(context(transport), metadata.registration_endpoint, {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json'},
    body: json({client_name: 'Coatria', client_uri: 'https://coatria.com', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none', scope: scopes.join(' ')}, 8192)});
  if (!object(response)) bad();
  const client = {client_id: response.client_id, redirect_uris: response.redirect_uris, token_endpoint_auth_method: response.token_endpoint_auth_method} as HiggsfieldClient;
  validateClient(client, redirectUri); return client;
}
export function higgsfieldAuthorizationUrl(metadata: HiggsfieldMetadata, client: HiggsfieldClient, redirectUri: string, state: string, codeVerifier: string): string {
  validateMetadata(metadata); validateClient(client, redirectUri); verifier(codeVerifier);
  if (!text(state, 256) || !/^[A-Za-z0-9_-]{32,256}$/.test(state)) bad('HIGGSFIELD_STATE_INVALID', 400);
  const url = new URL(metadata.authorization_endpoint);
  url.search = new URLSearchParams({client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code', response_mode: 'query', state, scope: scopes.join(' '),
    code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'), code_challenge_method: 'S256', resource: HIGGSFIELD_MCP_ENDPOINT}).toString();
  return url.href;
}
async function token(metadata: HiggsfieldMetadata, client: HiggsfieldClient, params: Record<string, string>, transport?: HiggsfieldTransport): Promise<HiggsfieldToken> {
  validateMetadata(metadata); validateClient(client);
  const value = await jsonRequest(context(transport), metadata.token_endpoint, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'},
    body: new URLSearchParams({...params, client_id: client.client_id, resource: HIGGSFIELD_MCP_ENDPOINT}).toString()});
  if (!object(value) || !text(value.access_token, 16384) || typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer' ||
      !Number.isSafeInteger(value.expires_in) || (value.expires_in as number) < 1 || (value.expires_in as number) > 31536000 ||
      value.refresh_token !== undefined && !text(value.refresh_token, 16384) || value.scope !== undefined && !text(value.scope, 2048)) bad();
  return {access_token: value.access_token as string, token_type: 'Bearer', expires_in: value.expires_in as number,
    ...(value.refresh_token ? {refresh_token: value.refresh_token as string} : {}), ...(value.scope ? {scope: value.scope as string} : {})};
}
export async function exchangeHiggsfieldCode(metadata: HiggsfieldMetadata, client: HiggsfieldClient, redirectUri: string, code: string, codeVerifier: string, transport?: HiggsfieldTransport) {
  validateRedirect(redirectUri); verifier(codeVerifier); if (!text(code, 8192)) bad('HIGGSFIELD_CODE_INVALID', 400);
  return token(metadata, client, {grant_type: 'authorization_code', redirect_uri: redirectUri, code, code_verifier: codeVerifier}, transport);
}
export async function refreshHiggsfieldToken(metadata: HiggsfieldMetadata, client: HiggsfieldClient, refreshToken: string, transport?: HiggsfieldTransport) {
  if (!text(refreshToken, 16384)) bad('HIGGSFIELD_TOKEN_INVALID', 400);
  const value = await token(metadata, client, {grant_type: 'refresh_token', refresh_token: refreshToken}, transport);
  return {...value, refresh_token: value.refresh_token ?? refreshToken};
}

type Session = {ctx: Context; accessToken: string; version?: string; id?: string};
function rpcValue(value: unknown, id: string): unknown {
  if (!object(value) || value.jsonrpc !== '2.0') return bad();
  if (value.id === undefined && typeof value.method === 'string' && value.method.startsWith('notifications/')) return undefined;
  if (value.id !== id || ('result' in value) === ('error' in value)) return bad('HIGGSFIELD_RPC_MISMATCH');
  if ('error' in value) return bad('HIGGSFIELD_RPC_ERROR');
  return value.result;
}
async function rpcBody(session: Session, response: Response, id: string): Promise<unknown> {
  const kind = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (kind === 'application/json') return rpcValue(await body(session.ctx, response, responseLimit), id);
  if (kind !== 'text/event-stream') {void response.body?.cancel().catch(() => {}); return bad();}
  const reader = response.body?.getReader(); if (!reader) return bad();
  const decoder = new TextDecoder('utf-8', {fatal: true}); let buffer = '', bytes = 0, events = 0;
  try {
    for (;;) {
      const chunk = await abortable(() => reader.read(), session.ctx.signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > responseLimit) bad('HIGGSFIELD_RESPONSE_LIMIT');
      buffer += decoder.decode(chunk.value, {stream: true});
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer); if (!boundary) break;
        const event = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
        if (++events > 2048) bad('HIGGSFIELD_RESPONSE_LIMIT');
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data.trim()) continue;
        let value: unknown; try {value = JSON.parse(data);} catch {return bad();}
        const result = rpcValue(value, id); if (result !== undefined) {void reader.cancel().catch(() => {}); return result;}
      }
    }
    // An interrupted POST stream must not be resubmitted: the paid tool may have run.
    return bad('HIGGSFIELD_RESPONSE_INCOMPLETE');
  } catch (error) {void reader.cancel().catch(() => {}); if (error instanceof HiggsfieldMcpError) throw error; return bad('HIGGSFIELD_TRANSPORT_UNCONFIRMED');}
}
async function rpc(session: Session, method: string, params: unknown, notification = false): Promise<unknown> {
  const id = randomUUID(), response = await request(session.ctx, HIGGSFIELD_MCP_ENDPOINT, {method: 'POST',
    headers: {Authorization: 'Bearer ' + session.accessToken, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(session.version ? {'MCP-Protocol-Version': session.version} : {}), ...(session.id ? {'MCP-Session-Id': session.id} : {})},
    body: json({jsonrpc: '2.0', ...notification ? {} : {id}, method, params}, 262144)});
  const responseSession = response.headers.get('mcp-session-id');
  if (responseSession !== null) {
    if (!/^[\x21-\x7e]{1,512}$/.test(responseSession) || session.id && session.id !== responseSession) {void response.body?.cancel().catch(() => {}); bad('HIGGSFIELD_SESSION_CHANGED');}
    if (method === 'initialize') session.id = responseSession;
  }
  if (notification) {void response.body?.cancel().catch(() => {}); if (response.status !== 202 && response.status !== 204) bad(); return undefined;}
  if (response.status !== 200) {void response.body?.cancel().catch(() => {}); bad();}
  return rpcBody(session, response, id);
}
async function initialize(accessToken: string, transport?: HiggsfieldTransport): Promise<Session> {
  if (!text(accessToken, 16384) || /\s/.test(accessToken)) bad('HIGGSFIELD_TOKEN_INVALID', 400);
  const session: Session = {ctx: context(transport), accessToken};
  const result = await rpc(session, 'initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'coatria', version: '1.0.0'}});
  if (!object(result) || typeof result.protocolVersion !== 'string' || !versions.has(result.protocolVersion) || !object(result.capabilities) || !object(result.capabilities.tools)) bad('HIGGSFIELD_PROTOCOL_UNSUPPORTED');
  session.version = result.protocolVersion; await rpc(session, 'notifications/initialized', {}, true); return session;
}
export async function listHiggsfieldTools(accessToken: string, transport?: HiggsfieldTransport): Promise<HiggsfieldTool[]> {
  const session = await initialize(accessToken, transport), tools: HiggsfieldTool[] = [], names = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined, totalBytes = 0;
  for (let page = 0; page < 12; page++) {
    const result = await rpc(session, 'tools/list', cursor ? {cursor} : {});
    if (!object(result) || !Array.isArray(result.tools)) bad();
    totalBytes += Buffer.byteLength(json(result, responseLimit)); if (totalBytes > 4 * 1024 * 1024) bad('HIGGSFIELD_CATALOG_LIMIT');
    for (const value of result.tools as unknown[]) {
      if (!object(value) || typeof value.name !== 'string' || !/^[A-Za-z0-9_.\/-]{1,128}$/.test(value.name) || names.has(value.name) ||
          !object(value.inputSchema) || value.inputSchema.type !== 'object' || value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 32768)) bad('HIGGSFIELD_CATALOG_INVALID');
      names.add(value.name as string); if (names.size > 512) bad('HIGGSFIELD_CATALOG_LIMIT');
      tools.push({name: value.name as string, description: typeof value.description === 'string' ? value.description : '', inputSchema: value.inputSchema as ObjectValue,
        ...(typeof value.title === 'string' ? {title: value.title.slice(0,512)} : {}), ...(object(value.outputSchema) ? {outputSchema: value.outputSchema} : {}),
        ...(object(value.annotations) ? {annotations: value.annotations} : {}), ...(object(value._meta) ? {_meta: value._meta} : {})});
    }
    if (result.nextCursor === undefined) return tools;
    if (!text(result.nextCursor, 2048) || cursors.has(result.nextCursor)) bad('HIGGSFIELD_CATALOG_CURSOR');
    cursor = result.nextCursor as string; cursors.add(cursor);
  }
  return bad('HIGGSFIELD_CATALOG_LIMIT');
}
/** Caller MUST authorize the discovered exact tool and persist any mutating intent first.
 * No HTTP, RPC, SSE-disconnect or session-expiry retry occurs here. JSON-RPC IDs are
 * correlation IDs, not a provider guarantee against duplicate paid generations. */
export async function callHiggsfieldTool(accessToken: string, name: string, args: ObjectValue, transport?: HiggsfieldTransport): Promise<HiggsfieldToolResult> {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.\/-]{1,128}$/.test(name) || !object(args)) bad('HIGGSFIELD_TOOL_INVALID', 400);
  json(args, 250000);
  const result = await rpc(await initialize(accessToken, transport), 'tools/call', {name, arguments: args});
  if (!object(result) || !Array.isArray(result.content) || result.content.length > 256 || !result.content.every(item => object(item) && typeof item.type === 'string') ||
      result.isError !== undefined && typeof result.isError !== 'boolean' || result.structuredContent !== undefined && !object(result.structuredContent) || result._meta !== undefined && !object(result._meta)) bad();
  return {content: result.content as ObjectValue[], ...(result.isError !== undefined ? {isError: result.isError as boolean} : {}),
    ...(result.structuredContent ? {structuredContent: result.structuredContent as ObjectValue} : {}), ...(result._meta ? {_meta: result._meta as ObjectValue} : {})};
}

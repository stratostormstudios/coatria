import { createHash, randomBytes, scrypt as rawScrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { z } from 'zod';
import { query } from './db';

function derivePassword(password:string,salt:string,options:ScryptOptions):Promise<Buffer> {
  return new Promise((resolve,reject)=>rawScrypt(password,salt,64,options,(error,key)=>error?reject(error):resolve(key)));
}
// OWASP's 32 MiB profile balances per-login memory and CPU on serverless workers.
const passwordCost = {N:32768,r:8,p:3,maxmem:64*1024*1024};
const currentPasswordPattern=/^scrypt\$v2\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
const legacyPasswordPattern=/^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
export const dummyPasswordHash='scrypt$v2$32768$8$3$'+'0'.repeat(32)+'$'+'0'.repeat(128);
export function passwordNeedsUpgrade(stored:string) {return legacyPasswordPattern.test(stored);}
export class ApiError extends Error { constructor(public status: number, message: string, public code?: string, public headers?:Record<string,string>) { super(message); } }
export function fail(status: number, message: string, code?: string): never { throw new ApiError(status, message, code); }
export const uuid = z.string().uuid();
export function id(value: string) { if (!uuid.safeParse(value).success) fail(400, 'Invalid resource identifier.'); return value; }
export function secret(prefix = '') { return prefix + randomBytes(32).toString('base64url'); }
export function hashToken(value: string) { return createHash('sha256').update(value).digest('hex'); }
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  const derived = await derivePassword(password, salt, passwordCost);
  return `scrypt$v2$32768$8$3$${salt}$${derived.toString('hex')}`;
}
export async function passwordMatches(password: string, stored: string) {
  const current=currentPasswordPattern.exec(stored),legacy=legacyPasswordPattern.exec(stored);
  const match=current||legacy;if(!match)return false;
  const [,salt,value]=match;
  const candidate = await derivePassword(password, salt, current?passwordCost:{N:16384,r:8,p:1,maxmem:32*1024*1024});
  return timingSafeEqual(candidate, Buffer.from(value, 'hex'));
}
export function assertOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const origins = new Set([new URL(request.url).origin]);
  if (process.env.APP_URL) origins.add(new URL(process.env.APP_URL).origin);
  if (process.env.VERCEL_URL) origins.add(`https://${process.env.VERCEL_URL}`);
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) origins.add(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);
  if (!origin || !origins.has(origin)) fail(403, 'This request must originate from Coatria.', 'INVALID_ORIGIN');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site') fail(403, 'Cross-site requests are not allowed.');
}
export async function body<T>(request: Request, schema: z.ZodType<T>, maxBytes = 65000): Promise<T> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail(415, 'Send application/json.');
  const declared = Number(request.headers.get('content-length') || '0');
  if (declared > maxBytes) fail(413, 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'A JSON request body is required.');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maxBytes) { await reader.cancel(); fail(413, 'Request is too large.'); }
    chunks.push(chunk.value);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'Invalid JSON body.'); }
  const result = schema.safeParse(parsed);
  if (!result.success) fail(400, result.error.issues.map(i => `${i.path.join('.') || 'input'}: ${i.message}`).slice(0, 3).join('; '), 'VALIDATION_ERROR');
  return result.data;
}
export async function rateLimit(key: string, limit: number, seconds: number) {
  const result = await query<{ count: number; retry_after:number }>(`INSERT INTO rate_limits(key,count,expires_at) VALUES($1,1,now()+$2*interval '1 second')
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.expires_at < now() THEN 1 ELSE rate_limits.count+1 END,
    expires_at=CASE WHEN rate_limits.expires_at < now() THEN now()+$2*interval '1 second' ELSE rate_limits.expires_at END RETURNING count,GREATEST(1,ceil(EXTRACT(EPOCH FROM expires_at-now())))::integer AS retry_after`, [hashToken(key), seconds]);
  if (result.rows[0].count > limit) throw new ApiError(429, 'Too many requests. Try again later.', 'RATE_LIMITED',{'Retry-After':String(result.rows[0].retry_after)});
}
export function clientKey(request: Request) {
  return process.env.VERCEL || process.env.TRUST_PROXY === 'true' ? (request.headers.get('x-vercel-forwarded-for') || request.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim() : 'local';
}
export function bearer(request: Request) {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ') || header.length > 200) fail(401, 'A valid scoped Bearer token is required.');
  return header.slice(7);
}
export function publicUrl(request: Request) { return process.env.APP_URL || new URL(request.url).origin; }
export function json(data: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
}
export function errorResponse(error: unknown) {
  if (error instanceof ApiError) return json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status,error.headers);
  if (error && typeof error === 'object' && 'code' in error) {
    if (error.code === '23505') return json({ error: 'That record already exists.', code: 'CONFLICT' }, 409);
    if (error.code === '23503') return json({ error: 'A referenced resource no longer exists.' }, 409);
  }
  // Never log SQL parameters, tokens, passwords, or database URLs.
  console.error('Coatria API failure', error instanceof Error ? error.name : 'UnknownError');
  return json({ error: 'The service could not complete this request. Please try again.', code: 'SERVER_ERROR' }, 500);
}

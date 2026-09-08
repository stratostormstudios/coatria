import type { PoolClient } from 'pg';
import { query } from './db';
import { fail, hashToken, id, secret } from './security';

export type User = { id: string; name: string; email: string; roleTitle: string; avatarColor: string; emailVerified: boolean };
export type Membership = { companyId: string; userId: string; role: 'owner' | 'admin' | 'member'; user: User };
export const userColumns = `id,name,email,role_title AS "roleTitle",avatar_color AS "avatarColor",(email_verified_at IS NOT NULL) AS "emailVerified"`;
export async function currentUser(request: Request): Promise<User | null> {
  const cookie = request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('coatria_session='))?.slice(16);
  if (!cookie || cookie.length > 200) return null;
  const result = await query<User>(`SELECT u.id,u.name,u.email,u.role_title AS "roleTitle",u.avatar_color AS "avatarColor",(u.email_verified_at IS NOT NULL) AS "emailVerified" FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`, [hashToken(cookie)]);
  return result.rows[0] || null;
}
export async function requireUser(request: Request): Promise<User> {
  const user=await currentUser(request)||fail(401,'Sign in to continue.','UNAUTHENTICATED');
  const expected=request.headers.get('x-coatria-user');
  if(expected&&expected!==user.id)fail(409,'Your signed-in account changed. Refresh before continuing.','SESSION_CHANGED');
  return user;
}
export async function requireMembership(request: Request, companyId: string, admin = false): Promise<Membership> {
  id(companyId); const user = await requireUser(request);
  const row = (await query<{ role: Membership['role'] }>('SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2 AND role<>\'removed\'', [companyId, user.id])).rows[0];
  if (!row) fail(404, 'Workspace not found.');
  if (admin && row.role !== 'owner' && row.role !== 'admin') fail(403, 'A company owner or administrator is required.');
  return { companyId, userId: user.id, role: row.role, user };
}
export async function lockMembership(client: PoolClient, membership: Membership, admin = false) {
  // Membership changes obtain this same lock, so a removed member cannot race a write.
  const row = (await client.query('SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2 FOR SHARE', [membership.companyId, membership.userId])).rows[0];
  if (!row || row.role === 'removed') fail(403, 'Your company access has ended.');
  if (admin && !['owner', 'admin'].includes(row.role)) fail(403, 'Administrator access is required.');
  return row.role as Membership['role'];
}
export async function sessionData(user: User | null) {
  const companies = user ? (await query(`SELECT c.id,c.name,c.slug,c.template,m.role FROM companies c JOIN memberships m ON m.company_id=c.id WHERE m.user_id=$1 AND m.role<>'removed' ORDER BY m.joined_at`, [user.id])).rows : [];
  return { user, companies, configured: true };
}
export async function createSession(client: PoolClient, userId: string) {
  await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
  const token = secret();
  await client.query("DELETE FROM sessions WHERE user_id=$1 AND expires_at<now()", [userId]);
  // Bound active sessions per account to avoid unbounded login records.
  await client.query('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id=$1 ORDER BY created_at DESC OFFSET 19)', [userId]);
  await client.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '14 days')", [hashToken(token), userId]);
  return token;
}
export function sessionCookie(request: Request, token: string, clear = false) {
  const secure = new URL(request.url).protocol === 'https:' || Boolean(process.env.VERCEL);
  return `coatria_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 1209600}${secure ? '; Secure' : ''}`;
}
export async function logout(request: Request) {
  const token = request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('coatria_session='))?.slice(16);
  if (token) await query('DELETE FROM sessions WHERE token_hash=$1', [hashToken(token)]);
}

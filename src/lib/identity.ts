import { z } from 'zod';
import { query, transaction } from './db';
import { createSession, currentUser, logout, requireUser, sessionCookie, sessionData, userColumns } from './auth';
import { body, clientKey, dummyPasswordHash, fail, json, passwordHash, passwordMatches, passwordNeedsUpgrade, rateLimit } from './security';
import { loginInput, profileInput, signupInput, skillColumns, skillInput } from './model';

export async function identityRoute(request: Request, parts: string[], method: string): Promise<Response | null> {
  const path = parts.join('/');
  if (path === 'session' && method === 'GET') return json(await sessionData(await currentUser(request)));
  if (path === 'auth/signup' && method === 'POST') {
    await rateLimit(`signup:${clientKey(request)}`, 8, 3600);
    const data = await body(request, signupInput);
    const password = await passwordHash(data.password);
    const result = await transaction(async client => {
      const user = (await client.query(`INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING ${userColumns}`, [data.name, data.email, password])).rows[0];
      return { user, token: await createSession(client, user.id) };
    });
    return json(await sessionData(result.user), 201, { 'Set-Cookie': sessionCookie(request, result.token) });
  }
  if (path === 'auth/login' && method === 'POST') {
    await rateLimit(`login-ip:${clientKey(request)}`, 30, 900);
    const data = await body(request, loginInput);
    await rateLimit(`login-email:${data.email}`, 10, 900);
    const record = (await query(`SELECT ${userColumns},password_hash FROM users WHERE email=$1`, [data.email])).rows[0];
    // Equal scrypt work for unknown accounts limits timing-based account discovery.
    if (!await passwordMatches(data.password, record?.password_hash || dummyPasswordHash) || !record) fail(401, 'Email or password is incorrect.');
    const upgradedHash = passwordNeedsUpgrade(record.password_hash) ? await passwordHash(data.password) : null;
    const { password_hash: _secret, ...user } = record;
    const token = await transaction(async client => {
      const current = (await client.query('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE', [user.id])).rows[0];
      if (!current || (current.password_hash !== record.password_hash && !await passwordMatches(data.password,current.password_hash))) fail(401, 'Your password changed. Sign in with your current password.');
      // Another valid login may have upgraded the same legacy hash while this
      // password check was running. Verify that current hash, then keep it.
      if (upgradedHash && current.password_hash === record.password_hash) await client.query('UPDATE users SET password_hash=$2 WHERE id=$1 AND password_hash=$3',[user.id,upgradedHash,record.password_hash]);
      return createSession(client, user.id);
    });
    return json(await sessionData(user as Awaited<ReturnType<typeof requireUser>>), 200, { 'Set-Cookie': sessionCookie(request, token) });
  }
  if (path === 'auth/logout' && method === 'POST') { if(request.headers.has('x-coatria-user'))await requireUser(request);await logout(request); return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', true) }); }
  if (path === 'auth/password' && method === 'PATCH') {
    const user=await requireUser(request);await rateLimit(`password-change:${user.id}`,5,900);
    const data=await body(request,z.object({currentPassword:z.string().min(1).max(256),newPassword:z.string().min(12).max(256)}).strict());
    const initial=(await query('SELECT password_hash FROM users WHERE id=$1',[user.id])).rows[0];
    if(!initial||!await passwordMatches(data.currentPassword,initial.password_hash))fail(403,'The current password is incorrect.');
    const replacement=await passwordHash(data.newPassword);
    await transaction(async client=>{
      const current=(await client.query('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE',[user.id])).rows[0];
      if(!current||current.password_hash!==initial.password_hash)fail(409,'Your password changed during this request. Sign in again and retry.');
      await client.query('UPDATE users SET password_hash=$2 WHERE id=$1',[user.id,replacement]);
      await client.query('DELETE FROM sessions WHERE user_id=$1',[user.id]);
    });return json({ok:true},200,{'Set-Cookie':sessionCookie(request,'',true)});
  }
  if (path === 'profile' && method === 'PATCH') {
    const user = await requireUser(request);
    const data = await body(request, profileInput);
    return json({ user: (await query(`UPDATE users SET name=$2,role_title=$3,avatar_color=$4,avatar_id=CASE WHEN $5::boolean THEN $6::text ELSE avatar_id END WHERE id=$1 RETURNING ${userColumns}`, [user.id, data.name, data.roleTitle, data.avatarColor, data.avatarId !== undefined, data.avatarId ?? null])).rows[0] });
  }
  if (parts[0] === 'vault') {
    const user = await requireUser(request);
    if (path === 'vault/export' && method === 'GET') {
      const skills = (await query(`SELECT ${skillColumns} FROM skills WHERE user_id=$1 ORDER BY updated_at DESC`, [user.id])).rows;
      const versions = (await query('SELECT v.skill_id AS "skillId",v.version,v.title,v.description,v.content,v.created_at AS "createdAt" FROM skill_versions v JOIN skills s ON s.id=v.skill_id WHERE s.user_id=$1 ORDER BY v.skill_id,v.version', [user.id])).rows;
      return json({ format: 'coatria-personal-vault-v1', exportedAt: new Date().toISOString(), skills, versions }, 200, { 'Content-Disposition': 'attachment; filename="coatria-personal-vault.json"' });
    }
    if (path === 'vault' && method === 'GET') return json({ skills: (await query(`SELECT ${skillColumns} FROM skills WHERE user_id=$1 ORDER BY updated_at DESC`, [user.id])).rows });
    if (path === 'vault' && method === 'POST') {
      const data = await body(request, skillInput, 65000);
      const skill = await transaction(async client => {
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
        if (Number((await client.query('SELECT count(*) FROM skills WHERE user_id=$1', [user.id])).rows[0].count) >= 200) fail(409, 'Your vault has reached this release’s limit of 200 skills.');
        const row = (await client.query(`INSERT INTO skills(user_id,title,description,content) VALUES($1,$2,$3,$4) RETURNING ${skillColumns}`, [user.id, data.title, data.description, data.content])).rows[0];
        await client.query('INSERT INTO skill_versions(skill_id,version,title,description,content) VALUES($1,1,$2,$3,$4)', [row.id, data.title, data.description, data.content]);
        return row;
      });
      return json({ skill }, 201);
    }
    if (parts.length === 2 && method === 'PATCH') {
      const { id } = await import('./security'); id(parts[1]);
      const data = await body(request, skillInput, 65000);
      const skill = await transaction(async client => {
        const current = (await client.query('SELECT id,version FROM skills WHERE id=$1 AND user_id=$2 FOR UPDATE', [parts[1], user.id])).rows[0];
        if (!current) fail(404, 'Skill not found.');
        if (current.version >= 1000) fail(409, 'This skill has reached the version limit. Export your history before creating a new skill.');
        const row = (await client.query(`UPDATE skills SET title=$3,description=$4,content=$5,version=version+1,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING ${skillColumns}`, [parts[1], user.id, data.title, data.description, data.content])).rows[0];
        await client.query('INSERT INTO skill_versions(skill_id,version,title,description,content) VALUES($1,$2,$3,$4,$5)', [row.id, row.version, data.title, data.description, data.content]);
        return row;
      });
      return json({ skill });
    }
  }
  return null;
}

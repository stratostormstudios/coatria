import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,scrypt as rawScrypt} from 'node:crypto';
import {promisify} from 'node:util';
import {readdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {handleApi} from '../src/lib/api';
import {database,query} from '../src/lib/db';
import {hashToken,passwordMatches,passwordNeedsUpgrade,secret} from '../src/lib/security';

const emulator=process.env.COATRIA_TEST_EMULATOR==='1',testDatabase=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('security regressions for unverified invites, offboarding and independent task attribution',{skip:!emulator&&!testDatabase,timeout:90000},async t=>{
  let stop:(()=>Promise<void>)|undefined;process.env.DATABASE_POOL_MAX=emulator?'1':'5';process.env.TRUST_PROXY='true';
  if(emulator){const {PGlite}=await import('@electric-sql/pglite');const {PGLiteSocketServer}=await import('@electric-sql/pglite-socket');const db=await PGlite.create();for(const file of(await readdir(resolve('database'))).filter(x=>/^\d.*\.sql$/.test(x)).sort())await db.exec(await readFile(resolve('database',file),'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();process.env.DATABASE_URL=`postgresql://postgres:postgres@${server.getServerConn()}/postgres`;stop=async()=>{await server.stop();await db.close();};}else process.env.DATABASE_URL=testDatabase!;
  const company=randomUUID(),people=Array.from({length:5},(_,n)=>({id:randomUUID(),session:secret(),email:`audit-${randomUUID()}@example.test`,name:`Audit ${n}`}));
  const base=`companies/${company}`,origin='http://localhost:4180';
  async function call(person:number,path:string,method='GET',data?:unknown,headers:Record<string,string>={}){const response=await handleApi(new Request(`${origin}/api/${path}`,{method,headers:{Origin:origin,'Content-Type':'application/json','x-forwarded-for':`audit-${people[person].id}`,Cookie:`coatria_session=${people[person].session}`,...headers},...(data===undefined?{}:{body:JSON.stringify(data)})}),path.split('/'));return {status:response.status,data:await response.json()};}
  try{
    await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Audit company',$2,'blank')",[company,`audit-${company}`]);
    for(const [n,p]of people.entries()){await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[p.id,p.name,p.email,'test-fixture-only']);await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(p.session),p.id]);if(n<3)await query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',[company,p.id,n===0?'owner':n===1?'admin':'member']);}
    await t.test('self-asserted email cannot redeem an email-restricted legacy invitation',async()=>{
      const token=secret('ci_');await query("INSERT INTO invitations(company_id,token_hash,email,role,created_by,expires_at) VALUES($1,$2,$3,'admin',$4,now()+interval '1 day')",[company,hashToken(token),people[3].email,people[0].id]);
      const result=await call(3,'invitations/join','POST',{token});assert.equal(result.status,403,JSON.stringify(result));
      assert.equal((await call(3,`${base}/workspace`)).status,404);
    });
    await t.test('unverified email restriction cannot be created or forged through profile',async()=>{
      assert.equal((await call(0,`${base}/invitations`,'POST',{role:'admin',email:people[3].email})).status,409);
      assert.equal((await call(3,'profile','PATCH',{name:'Fake verified',roleTitle:'',avatarColor:'#ffffff',emailVerified:true})).status,400);
    });
    await t.test('a pre-removal administrator invitation cannot restore offboarded access',async()=>{
      const invitation=await call(0,`${base}/invitations`,'POST',{role:'admin'});assert.equal(invitation.status,201);
      assert.equal((await call(0,`${base}/members/${people[2].id}`,'PATCH',{role:'removed'})).status,200);
      const joined=await call(2,'invitations/join','POST',{token:invitation.data.token});assert.equal(joined.status,403,JSON.stringify(joined));
      assert.equal((await call(2,`${base}/workspace`)).status,404);
      const fresh=await call(0,`${base}/invitations`,'POST',{role:'member'});assert.equal(fresh.status,201);assert.equal((await call(2,'invitations/join','POST',{token:fresh.data.token})).status,200);
    });
    await t.test('saving an existing review does not replace its author or enable self-approval',async()=>{
      const created=await call(0,`${base}/tasks`,'POST',{title:'Owner contribution',description:'Review actual authorship'});assert.equal(created.status,201);const path=`${base}/tasks/${created.data.task.id}`;
      assert.equal((await call(0,path,'PATCH',{status:'review',submissionUrl:'https://example.test/output'})).status,200);
      assert.equal((await call(1,path,'PATCH',{status:'review'})).status,200);
      const accepted=await call(0,path,'PATCH',{status:'done'});assert.equal(accepted.status,403,JSON.stringify(accepted));
    });
    await t.test('reopening and resubmitting retains every author for independent review',async()=>{
      const created=await call(0,`${base}/tasks`,'POST',{title:'Reopened contribution',description:'Retain authors'});const path=`${base}/tasks/${created.data.task.id}`;
      assert.equal((await call(0,path,'PATCH',{status:'review',submissionUrl:'https://example.test/reopened'})).status,200);
      assert.equal((await call(1,path,'PATCH',{status:'doing'})).status,200);
      const submitted=await call(1,path,'PATCH',{status:'review'});assert.equal(submitted.status,200);assert.deepEqual(new Set(submitted.data.task.authorIds),new Set([people[0].id,people[1].id]));
      assert.equal((await call(0,path,'PATCH',{status:'done'})).status,403);assert.equal((await call(1,path,'PATCH',{status:'done'})).status,403);
      assert.equal((await call(0,`${base}/members/${people[2].id}`,'PATCH',{role:'admin'})).status,200);assert.equal((await call(2,path,'PATCH',{status:'done'})).status,200);
    });
    await t.test('accepted applicant invitations are bound to the reviewed account',async()=>{
      const opening=await call(0,`${base}/openings`,'POST',{title:'Audit applicant',description:'Review an actual account',type:'human',compensation:'volunteer'});assert.equal(opening.status,201);
      assert.equal((await call(0,`${base}/openings/${opening.data.opening.id}`,'PATCH',{status:'published'})).status,200);
      const application=await call(3,`opportunities/${opening.data.opening.id}/apply`,'POST',{message:'Apply as this account'});assert.equal(application.status,201);
      const accepted=await call(0,`${base}/applications/${application.data.application.id}`,'PATCH',{status:'accepted'});assert.equal(accepted.status,200);
      assert.equal((await call(2,'invitations/join','POST',{token:accepted.data.invitation.token})).status,403);
      assert.equal((await call(3,'invitations/join','POST',{token:accepted.data.invitation.token})).status,200);
    });
    await t.test('a stale browser identity cannot save private data or log out the new account',async()=>{
      const headers={'X-Coatria-User':people[0].id};const result=await call(3,'vault','POST',{title:'Wrong-account content',description:'',content:'Private to the previous account'},headers);
      assert.equal(result.status,409);assert.equal(result.data.code,'SESSION_CHANGED');assert.equal(Number((await query('SELECT count(*) FROM skills WHERE title=$1',['Wrong-account content'])).rows[0].count),0);
      assert.equal((await call(3,'auth/logout','POST',{},headers)).status,409);assert.equal((await call(3,'session')).data.user.id,people[3].id);
      assert.equal((await call(3,'vault','GET',undefined,{'X-Coatria-User':people[3].id})).status,200);
    });
    await t.test('successful legacy login upgrades its hash without revoking existing sessions',async()=>{
      const password='Audit legacy login password',salt='1'.repeat(32),derived=await promisify(rawScrypt)(password,salt,64)as Buffer,legacy=`scrypt$${salt}$${derived.toString('hex')}`;
      await query('UPDATE users SET password_hash=$2 WHERE id=$1',[people[3].id,legacy]);
      const logins=await Promise.all([call(3,'auth/login','POST',{email:people[3].email,password}),call(3,'auth/login','POST',{email:people[3].email,password})]);for(const login of logins)assert.equal(login.status,200);
      const updated=(await query('SELECT password_hash FROM users WHERE id=$1',[people[3].id])).rows[0].password_hash;assert.notEqual(updated,legacy);assert.equal(passwordNeedsUpgrade(updated),false);assert(await passwordMatches(password,updated));
      assert.equal((await call(3,'session')).data.user.id,people[3].id);
    });
    await t.test('a demoted sponsor cannot offer a company agent to new engagements',async()=>{
      const agent=await call(1,`${base}/agents`,'POST',{name:'Delegated agent',harness:'custom',description:'Company-scoped identity'});assert.equal(agent.status,201);
      const opening=await call(0,`${base}/openings`,'POST',{title:'Agent opening',description:'Authorized agent only',type:'agent',compensation:'volunteer'});assert.equal(opening.status,201);assert.equal((await call(0,`${base}/openings/${opening.data.opening.id}`,'PATCH',{status:'published'})).status,200);
      assert.equal((await call(0,`${base}/members/${people[1].id}`,'PATCH',{role:'member'})).status,200);
      const application=await call(1,`opportunities/${opening.data.opening.id}/apply`,'POST',{message:'Offering agent after loss of authority',agentId:agent.data.agent.id});assert.equal(application.status,403,JSON.stringify(application));
    });
    await t.test('simultaneous invitations cannot overwrite the first accepted role',async()=>{
      const member=await call(0,`${base}/invitations`,'POST',{role:'member'}),admin=await call(0,`${base}/invitations`,'POST',{role:'admin'});assert.equal(member.status,201);assert.equal(admin.status,201);
      const joined=await Promise.all([call(4,'invitations/join','POST',{token:member.data.token}),call(4,'invitations/join','POST',{token:admin.data.token})]);assert.deepEqual(joined.map(x=>x.status).sort(),[200,409]);
      const role=(await query('SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2',[company,people[4].id])).rows[0].role;assert.equal(role,joined.find(x=>x.status===200)!.data.company.role);
      const used=Number((await query('SELECT count(*) FROM invitations WHERE token_hash=ANY($1::text[]) AND used_at IS NOT NULL',[[hashToken(member.data.token),hashToken(admin.data.token)]])).rows[0].count);assert.equal(used,1);
    });
    await t.test('a join racing offboarding cannot restore access with an older invite',async()=>{
      const invitation=await call(0,`${base}/invitations`,'POST',{role:'admin'});assert.equal(invitation.status,201);
      const [removed,joined]=await Promise.all([call(0,`${base}/members/${people[4].id}`,'PATCH',{role:'removed'}),call(4,'invitations/join','POST',{token:invitation.data.token})]);assert.equal(removed.status,200);assert([403,409].includes(joined.status),JSON.stringify(joined));
      assert.equal((await call(4,`${base}/workspace`)).status,404);
    });
  }finally{try{await query('DELETE FROM applications WHERE company_id=$1',[company]);await query('DELETE FROM companies WHERE id=$1',[company]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[people.map(p=>p.id)]);}finally{await database().end();await stop?.();}}
});

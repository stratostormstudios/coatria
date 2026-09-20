import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { database, query } from '../src/lib/db';
import { hashToken } from '../src/lib/security';
import {
  STUDIO_SKILLS, STUDIO_TEMPLATES, planStudioCompany,
  studioSetupInput, studioProjectInput, studioProjectPlanInput, studioShotInput,
  studioArtifactInput, studioGateInput, studioReviewInput, studioDeliveryInput,
  type StudioProjectDetail, type StudioWorkItem,
} from '../src/lib/studio-protocol';

const spec = { width: 1920, height: 1080, fpsNumerator: 24000, fpsDenominator: 1001, format: 'exr' as const, colorSpace: 'ACEScg' };
const shot = { code: 'SQ010_SH010', description: 'Synthetic cleanup fixture', frameStart: 1001, frameEnd: 1024, handles: 8, disciplines: ['prep', 'compositing'] as const };
const projectInput = (overrides: Record<string, unknown> = {}) => ({
  clientId: randomUUID(), name: 'Synthetic production', clientName: 'Fixture client',
  brief: 'Plan a synthetic cleanup with actual artifacts required before independent review.',
  spec, shots: [{ ...shot, disciplines: [...shot.disciplines] }], ...overrides,
});
const artifactInput = (workItemId: string = randomUUID(), revision = 1) => ({
  clientId: randomUUID(), revision, workItemId, name: 'Synthetic comp v001',
  url: 'https://media.example.invalid/fixture/comp-v001.exr', sha256: 'ab'.repeat(32),
  frameStart: shot.frameStart, frameEnd: shot.frameEnd, ...spec,
  notes: 'Fixture metadata only. No claim of a real DCC render.',
});

test('studio planning is explicit, bounded and never provisions workers or authority', () => {
  const plan = planStudioCompany({ teamSize: 4 });
  assert.equal(plan.requestedTeamSize, 4);
  assert.equal(plan.createsWorkers, false);
  assert.equal(plan.requiresAdministratorApplication, true);
  assert.equal(plan.rolesAreAssignments, true);
  assert.equal(plan.template.id, 'vfx-boutique');
  assert.throws(() => planStudioCompany({ teamSize: 101 }));
  assert.throws(() => planStudioCompany({ teamSize: 0 }));
  assert.throws(() => planStudioCompany({ autoApprove: true }));
  const skills = new Set<string>(STUDIO_SKILLS.map(skill => skill.key));
  for (const template of STUDIO_TEMPLATES) {
    const roles = new Map(template.roles.map(role => [role.key, role]));
    assert.equal(roles.size, template.roles.length);
    for (const role of template.roles) {
      assert(role.skills.every(skill => skills.has(skill)));
      const visited = new Set<string>();
      let key: string | null = role.key;
      while (key && key !== 'studio-owner') {
        assert(!visited.has(key), 'Role hierarchy must not cycle');
        visited.add(key);
        const current = roles.get(key);
        assert(current, 'Role manager must exist');
        key = current.reportsTo;
      }
    }
  }
});

test('intake keeps unknown AI policy, rational frame rates and unique bounded shot identities', () => {
  const parsed = studioProjectInput.parse(projectInput());
  assert.equal(parsed.aiPolicy, 'unknown');
  assert.equal(parsed.spec.fpsNumerator, 24000);
  assert.equal(parsed.spec.fpsDenominator, 1001);
  assert.equal(parsed.dueDate, null);
  for (const input of [
    projectInput({ shots: [] }),
    projectInput({ shots: [{ ...shot }, { ...shot, code: shot.code.toLowerCase() }] }),
    projectInput({ spec: { ...spec, fpsNumerator: 23.976 } }),
    projectInput({ spec: { ...spec, fpsDenominator: 0 } }),
    projectInput({ shots: [{ ...shot, frameEnd: 1000 }] }),
    projectInput({ shots: [{ ...shot, disciplines: ['prep', 'prep'] }] }),
    projectInput({ shots: [{ ...shot, code: '../outside' }] }),
    projectInput({ shots: Array.from({ length: 101 }, (_, i) => ({ ...shot, code: `SH${i}` })) }),
    projectInput({ aiPolicy: 'self-approved' }),
    projectInput({ approved: true }),
  ]) assert.equal(studioProjectInput.safeParse(input).success, false);
  assert.equal(studioShotInput.safeParse({ ...shot, frameEnd: shot.frameStart + 100001 }).success, false);
  const { clientId: _clientId, ...plan } = projectInput();
  assert.equal(studioProjectPlanInput.safeParse(plan).success, true);
});

test('role setup rejects duplicate roles, dual identities and user-supplied privileges', () => {
  const payload = { clientId: randomUUID(), templateId: 'vfx-boutique', templateVersion: 1, revision: 0 };
  assert.deepEqual(studioSetupInput.parse(payload).assignments, []);
  for (const input of [
    { ...payload, assignments: [{ roleKey: 'coordinator', agentId: randomUUID(), humanId: randomUUID() }] },
    { ...payload, assignments: [{ roleKey: 'coordinator' }, { roleKey: 'coordinator' }] },
    { ...payload, assignments: [{ roleKey: 'coordinator', capabilities: ['*'] }] },
    { ...payload, templateVersion: 2 },
    { ...payload, revision: -1 },
    { ...payload, providerApiKey: 'fixture-not-accepted' },
  ]) assert.equal(studioSetupInput.safeParse(input).success, false);
});

test('artifact and review schemas cannot preapprove media or accept credentials in references', () => {
  const valid = artifactInput();
  assert.equal(studioArtifactInput.parse({ ...valid, sha256: 'AB'.repeat(32) }).sha256, 'ab'.repeat(32));
  for (const url of ['file:///secret/file.exr', 'http://media.example.invalid/a.exr', 'https://user:password@media.example.invalid/a.exr', 'https://media.example.invalid/a.exr#secret', 'data:image/png;base64,AAAA']) {
    assert.equal(studioArtifactInput.safeParse({ ...valid, url }).success, false);
  }
  assert.equal(studioArtifactInput.safeParse({ ...valid, sha256: 'not-a-checksum' }).success, false);
  assert.equal(studioArtifactInput.safeParse({ ...valid, reviewStatus: 'approved' }).success, false);
  assert.equal(studioArtifactInput.safeParse({ ...valid, producedBy: randomUUID() }).success, false);
  assert.equal(studioArtifactInput.safeParse({ ...valid, frameEnd: valid.frameStart - 1 }).success, false);
  const review = { clientId: randomUUID(), revision: 1, artifactId: randomUUID(), decision: 'approved', note: 'Independent fixture review', technicalQc: true };
  assert.equal(studioReviewInput.safeParse(review).success, true);
  assert.equal(studioReviewInput.safeParse({ ...review, reviewedBy: randomUUID() }).success, false);
  assert.equal(studioReviewInput.safeParse({ ...review, technicalQc: undefined }).success, false);
});

test('delivery and gate schemas require exact revisions and cannot assert transferred status', () => {
  const versionId = randomUUID();
  const delivery = { clientId: randomUUID(), revision: 1, name: 'Fixture package', artifactIds: [versionId], note: 'Prepare only' };
  assert.equal(studioDeliveryInput.safeParse(delivery).success, true);
  for (const input of [{ ...delivery, artifactIds: [] }, { ...delivery, artifactIds: [versionId, versionId] }, { ...delivery, status: 'acknowledged' }, { ...delivery, revision: 0 }]) {
    assert.equal(studioDeliveryInput.safeParse(input).success, false);
  }
  const gate = { clientId: randomUUID(), revision: 1, gate: 'production', decision: 'approved', note: 'Human approval' };
  assert.equal(studioGateInput.safeParse(gate).success, true);
  assert.equal(studioGateInput.safeParse({ ...gate, decision: 'delivered' }).success, false);
  assert.equal(studioGateInput.safeParse({ ...gate, recordedBy: randomUUID() }).success, false);
  const acceptance = { ...gate, gate: 'client_acceptance' };
  assert.equal(studioGateInput.safeParse(acceptance).success, false, 'Client acceptance must identify the exact prepared package');
  assert.equal(studioGateInput.safeParse({ ...acceptance, deliveryId: randomUUID() }).success, true);
  assert.equal(studioGateInput.safeParse({ ...acceptance, decision: 'changes_requested' }).success, true);
  assert.equal(studioGateInput.safeParse({ ...acceptance, deliveryId: 'not-a-package-id' }).success, false);
  assert.equal(studioGateInput.safeParse({ ...gate, deliveryId: randomUUID() }).success, false);
  assert.equal(studioGateInput.safeParse({ ...acceptance, decision: 'changes_requested', deliveryId: randomUUID() }).success, false);
});

const emulate = process.env.COATRIA_TEST_EMULATOR === '1';
const integrationUrl = process.env.COATRIA_INTEGRATION_DATABASE_URL;

test('studio production uses real company tasks, tenant authority, versioned evidence and independent review', { skip: !emulate && !integrationUrl, timeout: 120000 }, async t => {
  const { handleApi } = await import('../src/lib/api');
  const previousEnvironment = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX };
  process.env.DATABASE_URL = integrationUrl;
  process.env.DATABASE_POOL_MAX = emulate ? '1' : '10';
  let stop: (() => Promise<void>) | undefined;
  if (emulate) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
    const db = await PGlite.create();
    for (const file of (await readdir('database')).filter(file => /^\d.*\.sql$/.test(file)).sort()) await db.exec(await readFile(`database/${file}`, 'utf8'));
    const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 1 });
    await server.start();
    process.env.DATABASE_URL = `postgresql://postgres:postgres@${server.getServerConn()}/postgres`;
    stop = async () => { await server.stop(); await db.close(); };
  }

  const company = randomUUID(), foreign = randomUUID();
  const owner = randomUUID(), reviewer = randomUUID(), member = randomUUID(), outsider = randomUUID();
  const agent = randomUUID(), foreignAgent = randomUUID(), token = `ca_${randomUUID()}`;
  const sessions = { owner: randomUUID(), reviewer: randomUUID(), member: randomUUID(), outsider: randomUUID() };
  const origin = 'http://localhost:4180', prefix = `companies/${company}/studio`;
  type Actor = keyof typeof sessions | 'agent' | 'anonymous';
  let allowed: StudioProjectDetail, unknownPolicy: StudioProjectDetail;
  let foreignProjectId = '';
  let runId = '', leaseToken = '';
  const finalArtifacts: string[] = [];
  let oldPrepArtifact = '', latestPrepArtifact = '';

  async function call(path: string, method = 'GET', payload?: unknown, actor: Actor = 'owner', expected: number | number[] = 200) {
    const headers: Record<string, string> = {};
    if (actor === 'agent') headers.Authorization = `Bearer ${token}`;
    else if (actor !== 'anonymous') { headers.Cookie = `coatria_session=${sessions[actor]}`; headers.Origin = origin; }
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    const response = await handleApi(new Request(`${origin}/api/${path}`, { method, headers, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }), path.split('?')[0].split('/'));
    const result = await response.json();
    assert((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${method} ${path}: expected ${expected}, got ${response.status}: ${JSON.stringify(result)}`);
    return result;
  }
  const detail = (id: string, actor: Actor = 'owner') => call(`${prefix}/projects/${id}`, 'GET', undefined, actor) as Promise<StudioProjectDetail>;
  async function gate(projectId: string, name: string, decision = 'approved', actor: Actor = 'owner', expected = 201, extras: Record<string, unknown> = {}) {
    const snapshot = await detail(projectId);
    return call(`${prefix}/projects/${projectId}/gates`, 'POST', { clientId: randomUUID(), revision: snapshot.project.revision, gate: name, decision, note: 'Synthetic fixture authorization; no real production.', ...extras }, actor, expected);
  }
  const tool = (name: string, args: unknown, expected = 200, requestId = randomUUID()) => call(`agent/tools/${name}`, 'POST', { runId, leaseToken, requestId, arguments: args }, 'agent', expected);
  async function work(stage: string, shotCode?: string) {
    const snapshot = await detail(allowed.project.id);
    const shotId = shotCode ? snapshot.shots.find(item => item.code === shotCode)?.id : undefined;
    const found = snapshot.workItems.find(item => item.stage === stage && (shotCode === undefined || item.shotId === shotId));
    assert(found, `Fixture requires a ${stage} work item for ${shotCode ?? 'the project'}`);
    return found;
  }
  async function acceptHuman(item: StudioWorkItem) {
    const qc=item.stage==='qc';
    await call(`companies/${company}/tasks/${item.taskId}`, 'PATCH', { status: 'review' },qc?'reviewer':'owner');
    const accepted = await call(`companies/${company}/tasks/${item.taskId}`, 'PATCH', { status: 'done', reviewNote: 'Independent fixture task acceptance.' }, qc?'owner':'reviewer');
    assert.equal(accepted.task.status, 'done');
  }
  async function review(artifactId: string, actor: Actor = 'reviewer', expected = 201, overrides: Record<string, unknown> = {}) {
    const snapshot = await detail(allowed.project.id);
    return call(`${prefix}/projects/${allowed.project.id}/reviews`, 'POST', { clientId: randomUUID(), revision: snapshot.project.revision, artifactId, decision: 'approved', technicalQc: true, note: 'Synthetic metadata fixture; does not certify actual media.', ...overrides }, actor, expected);
  }
  async function register(item: StudioWorkItem, overrides: Record<string, unknown> = {}) {
    const snapshot = await detail(allowed.project.id);
    const payload = { ...artifactInput(item.id, snapshot.project.revision), frameStart: shot.frameStart - shot.handles, frameEnd: shot.frameEnd + shot.handles, ...overrides };
    const result = await call(`${prefix}/projects/${allowed.project.id}/artifacts`, 'POST', payload, 'owner', 201);
    return { payload, result };
  }

  try {
    for (const [id, name] of [[owner, 'Fixture owner'], [reviewer, 'Independent fixture reviewer'], [member, 'Fixture artist'], [outsider, 'Foreign owner']]) {
      await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)', [id, name, `${id}@example.invalid`, 'fixture']);
    }
    for (const [id, name] of [[company, 'Studio fixture company'], [foreign, 'Foreign fixture company']]) {
      await query("INSERT INTO companies(id,name,slug,template) VALUES($1,$2,$3,'blank')", [id, name, id]);
    }
    await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member'),($5,$6,'owner')", [company, owner, reviewer, member, foreign, outsider]);
    for (const [key, id] of Object.entries({ owner, reviewer, member, outsider })) {
      await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(sessions[key as keyof typeof sessions]), id]);
    }
    for (const [id, companyId, sponsor, credential] of [[agent, company, owner, token], [foreignAgent, foreign, outsider, `ca_${randomUUID()}`]]) {
      await query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,invocation_access,capabilities) VALUES($1,$2,'Fixture coordinator','custom',$3,$4,'admins','[\"workspace.read\",\"tasks.write\",\"studio.read\",\"studio.write\"]')", [id, companyId, hashToken(credential), sponsor]);
    }

    await t.test('only current company administrators apply templates and assignment authority stays tenant-scoped', async () => {
      const payload = { clientId: randomUUID(), templateId: 'vfx-boutique', templateVersion: 1, revision: 0, assignments: [{ roleKey: 'coordinator', agentId: agent }, { roleKey: 'producer', humanId: owner }, { roleKey: 'qc', humanId: reviewer }] };
      await call(prefix, 'GET', undefined, 'anonymous', 401);
      await call(`${prefix}/setup`, 'POST', payload, 'member', 403);
      await call(`${prefix}/setup`, 'POST', payload, 'outsider', 404);
      await call(`${prefix}/setup`, 'POST', { ...payload, assignments: [{ roleKey: 'coordinator', agentId: foreignAgent }] }, 'owner', [400, 404]);
      await call(`${prefix}/setup`, 'POST', { ...payload, assignments: [{ roleKey: 'producer', humanId: outsider }] }, 'owner', [400, 404]);
      await call(`${prefix}/setup`, 'POST', { ...payload, assignments: [{ roleKey: 'does-not-exist', humanId: owner }] }, 'owner', 400);
      for(const assignment of [{roleKey:'qc',agentId:agent},{roleKey:'qc',humanId:member}])assert.equal((await call(`${prefix}/setup`,'POST',{...payload,assignments:[assignment]},'owner',400)).code,'STUDIO_QC_HUMAN_REQUIRED');
      const first = await call(`${prefix}/setup`, 'POST', payload, 'owner', 201);
      const snapshot = await call(prefix);
      assert.equal(snapshot.profile.revision, 1);
      assert.equal(snapshot.profile.templateId, 'vfx-boutique');
      assert.equal(snapshot.profile.roles.find((role: any) => role.key === 'coordinator').agentId, agent);
      assert.equal(snapshot.profile.roles.find((role: any) => role.key === 'qc').humanId, reviewer);
      const replay = await call(`${prefix}/setup`, 'POST', payload);
      assert.equal(replay.replayed, true);
      assert.equal((await call(prefix)).profile.revision, 1);
      assert(first);
      await call(`${prefix}/setup`, 'POST', { ...payload, assignments: [] }, 'owner', 409);
      await call(`${prefix}/setup`, 'POST', { ...payload, clientId: randomUUID() }, 'owner', 409);
      const agents = await query('SELECT count(*)::int AS count FROM agents WHERE company_id=$1', [company]);
      assert.equal(agents.rows[0].count, 1, 'Applying role assignments must not create paid workers or duplicate agent identities');
    });

    await t.test('project creation is replay-safe and generates linked deterministic shot dependencies', async () => {
      const payload = projectInput({ aiPolicy: 'allowed', shots: [{ ...shot, disciplines: [...shot.disciplines] }, { ...shot, code: 'SQ010_SH020', disciplines: ['compositing'] }] });
      await call(`${prefix}/projects`, 'POST', payload, 'member', 403);
      await call(`${prefix}/projects`, 'POST', payload, 'outsider', 404);
      const created = await call(`${prefix}/projects`, 'POST', payload, 'owner', 201);
      allowed = await detail(created.project.id);
      assert.equal(allowed.project.revision, 1);
      assert.equal(allowed.project.aiPolicy, 'allowed');
      assert.deepEqual(allowed.shots.map(item => item.code).sort(), ['SQ010_SH010', 'SQ010_SH020']);
      assert.equal(allowed.workItems.length, 10, 'Exactly the selected shot stages plus estimate, breakdown and delivery are created');
      const workIds = new Set(allowed.workItems.map(item => item.id));
      for (const work of allowed.workItems) {
        assert(work.dependencies.every(id => workIds.has(id)));
        assert(!work.dependencies.includes(work.id));
        const task = (await query('SELECT company_id,title,status,assignee_id FROM tasks WHERE id=$1', [work.taskId])).rows[0];
        assert.equal(task.company_id, company);
        assert.equal(task.title, work.title);
        assert.equal(task.status, work.status);
        assert.equal(task.assignee_id,work.humanId);
      }
      for (const item of allowed.shots) {
        const shotWork = allowed.workItems.filter(work => work.shotId === item.id);
        const stages = shotWork.map(work => work.stage);
        for (const discipline of item.disciplines) assert(stages.includes(discipline), `Missing selected discipline ${discipline}`);
        assert(!stages.includes('fx'), 'An unselected FX branch must not appear');
        let previousId = allowed.workItems.find(work => work.stage === 'breakdown')!.id;
        for (const stage of ['ingest', ...item.disciplines, 'qc']) {
          const current = shotWork.find(work => work.stage === stage)!;
          assert.deepEqual(current.dependencies, [previousId], 'Shot stages must preserve their deterministic predecessor');
          previousId = current.id;
        }
      }
      const estimate = allowed.workItems.find(work => work.stage === 'estimate')!;
      assert.deepEqual(estimate.dependencies, []);
      assert.deepEqual(allowed.workItems.find(work => work.stage === 'breakdown')!.dependencies, [estimate.id]);
      assert.deepEqual(allowed.workItems.find(work => work.stage === 'delivery')!.dependencies.sort(), allowed.workItems.filter(work => work.stage === 'qc').map(work => work.id).sort());
      const replay = await call(`${prefix}/projects`, 'POST', payload);
      assert.equal(replay.replayed, true);
      assert.equal(replay.project.id, allowed.project.id);
      const afterReplay = await detail(allowed.project.id);
      assert.deepEqual(afterReplay.workItems.map(item => item.id), allowed.workItems.map(item => item.id));
      assert.equal((await query('SELECT count(*)::int AS count FROM tasks WHERE company_id=$1', [company])).rows[0].count, allowed.workItems.length);
      await call(`${prefix}/projects`, 'POST', { ...payload, brief: 'Changed payload under the same idempotency key.' }, 'owner', 409);
      await call(`companies/${foreign}/studio/projects/${allowed.project.id}`, 'GET', undefined, 'outsider', 404);
      await call(`${prefix}/projects/${allowed.project.id}`, 'GET', undefined, 'outsider', 404);
      assert(!(JSON.stringify(await call(prefix, 'GET', undefined, 'member')).includes(token)));
    });

    await t.test('human role ownership grants pending task access and preserves submitted and accepted attribution',async()=>{
      const save=async(humanId:string|null,expected=201)=>{const profile=(await call(prefix)).profile;return call(`${prefix}/setup`,'POST',{clientId:randomUUID(),templateId:profile.templateId,templateVersion:1,revision:profile.revision,assignments:profile.roles.map((role:any)=>({roleKey:role.key,agentId:role.key==='producer'?null:role.agentId,humanId:role.key==='producer'?humanId:role.humanId}))},'owner',expected);};
      await save(member);const existing=allowed.workItems.find(item=>item.stage==='estimate')!;assert.equal((await query('SELECT assignee_id FROM tasks WHERE id=$1',[existing.taskId])).rows[0].assignee_id,member);
      const created=await call(`${prefix}/projects`,'POST',projectInput({name:'Human role ownership fixture',aiPolicy:'allowed'}),'owner',201),d=await detail(created.project.id),estimate=d.workItems.find(item=>item.stage==='estimate')!,path=`companies/${company}/tasks/${estimate.taskId}`;
      assert.equal((await query('SELECT assignee_id FROM tasks WHERE id=$1',[estimate.taskId])).rows[0].assignee_id,member);await gate(d.project.id,'brief');
      await call(path,'PATCH',{status:'doing'},'member');assert.equal((await save(owner,409)).code,'STUDIO_ROLE_BUSY');
      await call(path,'PATCH',{status:'review'},'member');assert.equal((await save(owner,409)).code,'STUDIO_ROLE_BUSY');
      await call(path,'PATCH',{status:'done'},'member',403);await call(path,'PATCH',{status:'done',reviewNote:'Independent review of the human role contribution.'},'reviewer');
      const before=(await query('SELECT assignee_id,submitted_by,approved_by,revision FROM tasks WHERE id=$1',[estimate.taskId])).rows[0];assert.equal(before.submitted_by,member);assert.equal(before.approved_by,reviewer);
      await save(null);assert.equal((await query('SELECT assignee_id FROM tasks WHERE id=$1',[existing.taskId])).rows[0].assignee_id,null);
      await save(owner);assert.deepEqual((await query('SELECT assignee_id,submitted_by,approved_by,revision FROM tasks WHERE id=$1',[estimate.taskId])).rows[0],before);
      const pending=await call(`${prefix}/projects`,'POST',projectInput({name:'Unassigned former worker fixture'}),'owner',201),pendingDetail=await detail(pending.project.id);await gate(pending.project.id,'brief');await call(`companies/${company}/tasks/${pendingDetail.workItems.find(item=>item.stage==='estimate')!.taskId}`,'PATCH',{status:'doing'},'member',403);
      const current=(await query('SELECT assignee_id FROM tasks WHERE id=$1',[existing.taskId])).rows[0];assert.equal(current.assignee_id,owner);
      await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[company,reviewer]);assert.equal((await call(`${prefix}/projects`,'POST',projectInput({name:'Reject demoted QC fixture'}),'owner',409)).code,'STUDIO_QC_HUMAN_REQUIRED');await query("UPDATE memberships SET role='admin' WHERE company_id=$1 AND user_id=$2",[company,reviewer]);
    });

    await t.test('unknown AI policy cannot be converted into production authority by a gate or task edit', async () => {
      const created = await call(`${prefix}/projects`, 'POST', projectInput({ name: 'Unknown AI-use fixture' }), 'owner', 201);
      unknownPolicy = await detail(created.project.id);
      assert.equal(unknownPolicy.project.aiPolicy, 'unknown');
      await gate(unknownPolicy.project.id, 'brief');
      await gate(unknownPolicy.project.id, 'estimate');
      await gate(unknownPolicy.project.id, 'production', 'approved', 'owner', 409);
      const current = await detail(unknownPolicy.project.id);
      assert.notEqual(current.project.gates.production?.decision, 'approved');
      const production = current.workItems.find(work => work.execution === 'dcc');
      assert(production);
      assert.equal(production.readiness, 'blocked');
      await call(`companies/${company}/tasks/${production.taskId}`, 'PATCH', { status: 'doing' }, 'owner', 409);
    });

    await t.test('studio overview cursors must exist in the current company', async () => {
      const foreignPrefix = `companies/${foreign}/studio`;
      await call(`${foreignPrefix}/setup`, 'POST', { clientId: randomUUID(), templateId: 'vfx-boutique', templateVersion: 1, revision: 0, assignments: [] }, 'outsider', 201);
      const foreignProject = await call(`${foreignPrefix}/projects`, 'POST', projectInput({ name: 'Foreign cursor fixture' }), 'outsider', 201);
      foreignProjectId = foreignProject.project.id;
      await call(`${prefix}?after=${foreignProject.project.id}`, 'GET', undefined, 'owner', 404);
      await call(`${prefix}?after=${randomUUID()}`, 'GET', undefined, 'owner', 404);
      const firstPage = await call(`${prefix}?limit=1`);
      assert.equal(firstPage.projects.length, 1);
      assert.equal(firstPage.hasMore, true);
      const secondPage = await call(`${prefix}?limit=1&after=${firstPage.nextAfter}`);
      assert.equal(secondPage.projects.length, 1);
      assert.notEqual(firstPage.projects[0].id, secondPage.projects[0].id);
      assert(secondPage.projects.every((item: any) => item.id !== foreignProject.project.id));
    });

    await t.test('queued studio dispatch persists once and protects task and role changes until cancellation and reset', async dispatchTest => {
      const profile = (await call(prefix)).profile;
      const assignments = [{ roleKey: 'producer', agentId: agent }, { roleKey: 'coordinator', agentId: agent }, { roleKey: 'qc', humanId: reviewer }];
      const configured = await call(`${prefix}/setup`, 'POST', { clientId: randomUUID(), templateId: 'vfx-boutique', templateVersion: 1, revision: profile.revision, assignments }, 'owner', 201);
      const created = await call(`${prefix}/projects`, 'POST', projectInput({ name: 'Dispatch recovery fixture', aiPolicy: 'allowed' }), 'owner', 201);
      const projectId = created.project.id;
      await gate(projectId, 'brief');
      const before = await detail(projectId), estimate = before.workItems.find(item => item.stage === 'estimate')!;
      let payload = { clientId: randomUUID(), revision: before.project.revision, workItemId: estimate.id };
      const path = `${prefix}/projects/${projectId}/dispatch`;
      await call(path, 'POST', payload, 'member', 403);
      let dispatched: any;
      await dispatchTest.test('PostgreSQL simultaneous dispatches commit one queue effect without a deadlock', { skip: emulate, timeout: 20000 }, async () => {
        // The PostgreSQL fixture uses a real pool: both API transactions can
        // overlap. PGlite's single connection cannot exercise this race.
        const competitors = [payload, { ...payload, clientId: randomUUID() }];
        const outcomes = await Promise.allSettled(competitors.map(async candidate => ({ candidate, result: await call(path, 'POST', candidate, 'owner', [201, 409]) })));
        const completed = outcomes.map(outcome => {
          assert(outcome.status === 'fulfilled', outcome.status === 'rejected' ? String(outcome.reason) : 'Both concurrent requests must finish');
          return outcome.value;
        });
        const winners = completed.filter(outcome => outcome.result.run);
        const rejected = completed.filter(outcome => !outcome.result.run);
        assert.equal(winners.length, 1, 'Exactly one dispatch may commit for the shared project revision');
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].result.code, 'STUDIO_REVISION_CONFLICT');
        payload = winners[0].candidate;
        dispatched = winners[0].result;
        assert.equal((await query('SELECT count(*)::int AS count FROM studio_dispatches WHERE company_id=$1 AND project_id=$2 AND work_item_id=$3', [company, projectId, estimate.id])).rows[0].count, 1);
        assert.equal((await query("SELECT count(*)::int AS count FROM agent_runs WHERE company_id=$1 AND agent_id=$2 AND status='queued'", [company, agent])).rows[0].count, 1);
        const task = (await query('SELECT status,revision,agent_run_id FROM tasks WHERE company_id=$1 AND id=$2', [company, estimate.taskId])).rows[0];
        assert.equal(task.status, 'todo', 'Dispatch queues work; a worker must still reserve the existing task');
        assert.equal(task.revision, estimate.revision);
        assert.equal(task.agent_run_id, null);
      });
      if (emulate) dispatched = await call(path, 'POST', payload, 'owner', 201);
      assert(dispatched);
      assert.equal(dispatched.run.status, 'queued');
      const queued = (await detail(projectId)).workItems.find(item => item.id === estimate.id) as StudioWorkItem & { runId: string; runStatus: string };
      assert.equal(queued.runId, dispatched.run.id);
      assert.equal(queued.runStatus, 'queued');
      assert.equal(queued.readiness, 'queued');
      const replay = await call(path, 'POST', payload);
      assert.equal(replay.replayed, true);
      assert.equal(replay.run.id, dispatched.run.id);
      await call(path, 'POST', { ...payload, clientId: randomUUID(), revision: dispatched.project.revision }, 'owner', 409);
      assert.equal((await query('SELECT count(*)::int AS count FROM studio_dispatches WHERE company_id=$1 AND project_id=$2 AND work_item_id=$3', [company, projectId, estimate.id])).rows[0].count, 1);
      assert.equal((await query("SELECT count(*)::int AS count FROM agent_runs WHERE company_id=$1 AND agent_id=$2 AND status='queued'", [company, agent])).rows[0].count, 1, 'A rejected duplicate dispatch must roll back its newly queued run');
      const reassign = { clientId: randomUUID(), templateId: 'vfx-boutique', templateVersion: 1, revision: configured.profile.revision, assignments: [{ roleKey: 'producer', humanId: owner }, { roleKey: 'coordinator', agentId: agent }, { roleKey: 'qc', humanId: reviewer }] };
      await call(`${prefix}/setup`, 'POST', reassign, 'owner', 409);
      const queuedEdit = await call(`companies/${company}/tasks/${estimate.taskId}`, 'PATCH', { title: 'Premature human takeover' }, 'owner', 409);
      assert.equal(queuedEdit.code, 'STUDIO_RUN_ACTIVE');

      const claim = await call('agent/runs/claim', 'POST', { workerId: 'studio-dispatch-recovery', claimId: randomUUID() }, 'agent');
      assert.equal(claim.run.id, dispatched.run.id);
      runId = claim.run.id;
      leaseToken = claim.leaseToken;
      const reserved = (await tool('tasks_claim', { taskId: estimate.taskId, revision: estimate.revision })).result;
      assert.equal(reserved.status, 'doing');
      assert.equal((await detail(projectId)).workItems.find(item => item.id === estimate.id)?.readiness, 'running');
      await call(`${prefix}/setup`, 'POST', reassign, 'owner', 409);
      const runningEdit = await call(`companies/${company}/tasks/${estimate.taskId}`, 'PATCH', { status: 'todo' }, 'owner', 409);
      assert.equal(runningEdit.code, 'STUDIO_RUN_ACTIVE');
      await call(`companies/${company}/agent-runs/${runId}/cancel`, 'POST', {});
      const reset = await call(`companies/${company}/tasks/${estimate.taskId}`, 'PATCH', { status: 'todo' });
      assert.equal(reset.task.status, 'todo');
      assert.equal((await query('SELECT agent_run_id FROM tasks WHERE company_id=$1 AND id=$2', [company, estimate.taskId])).rows[0].agent_run_id, null);
      await call(`${prefix}/setup`, 'POST', reassign, 'owner', 201);
      const after = (await detail(projectId)).workItems.find(item => item.id === estimate.id) as StudioWorkItem & { runId: string; runStatus: string };
      assert.equal(after.humanId, owner);
      assert.equal(after.agentId, null);
      assert.equal(after.runId, runId);
      assert.equal(after.runStatus, 'cancelled');
      assert.equal(after.readiness, 'ready');
      await tool('tasks_update', { taskId: estimate.taskId, revision: after.revision, status: 'doing' }, 409);
    });

    await t.test('human and leased agent task APIs enforce gates, role assignment and accepted dependencies', async () => {
      const created = await call(`companies/${company}/conversations/commons/runs`, 'POST', { clientId: randomUUID(), agentId: agent, prompt: 'Exercise only synthetic fixture tasks; preserve production review gates.' }, 'owner', 201);
      runId = created.run.id;
      const claim = await call('agent/runs/claim', 'POST', { workerId: 'studio-fixture', claimId: randomUUID() }, 'agent');
      assert.equal(claim.run.id, runId);
      leaseToken = claim.leaseToken;
      const catalog = await call('agent/tools', 'GET', undefined, 'agent');
      for (const name of ['studio_get', 'studio_plan', 'studio_company_plan', 'studio_artifact_register']) assert(catalog.tools.some((entry: any) => entry.name === name));
      for (const name of ['studio_gate', 'studio_review', 'studio_delivery', 'studio_setup']) await tool(name, {}, 404);
      const blueprint = (await tool('studio_company_plan', { teamSize: 4 })).result;
      assert.equal(blueprint.createsWorkers, false);
      assert.equal(blueprint.requiresAdministratorApplication, true);
      await tool('studio_get', { projectId: randomUUID() }, 404);
      await tool('studio_get', { companyId: foreign }, 400);
      const page = (await tool('studio_get', { projectId: allowed.project.id, limit: 2 })).result;
      assert.equal(page.workItems.length, 2);
      assert.equal(page.hasMore, true);
      assert.equal(page.projection.contentInspectedByThisResponse, false);
      const next = (await tool('studio_get', { projectId: allowed.project.id, after: page.nextAfter, limit: 2 })).result;
      assert(next.workItems.every((item: any) => !page.workItems.some((previous: any) => previous.id === item.id)));
      const { clientId: _clientId, ...planInput } = projectInput({ name: 'Agent draft only' });
      const planRequestId = randomUUID();
      const draft = await tool('studio_plan', planInput, 200, planRequestId);
      const draftReplay = await tool('studio_plan', planInput, 200, planRequestId);
      assert.equal(draftReplay.replayed, true);
      assert.equal(draftReplay.result.project.id, draft.result.project.id);
      const draftDetail = await detail(draft.result.project.id);
      assert.equal(draftDetail.project.aiPolicy, 'unknown');
      assert.deepEqual(draftDetail.project.gates, {});
      assert(draftDetail.workItems.every(item => item.readiness === 'blocked'));
      const estimate = await work('estimate'), breakdown = await work('breakdown');
      await query("UPDATE agents SET capabilities='[\"workspace.read\",\"tasks.write\",\"studio.read\"]' WHERE company_id=$1 AND id=$2", [company, agent]);
      const missingGrant = await tool('tasks_claim', { taskId: breakdown.taskId, revision: breakdown.revision }, 403);
      assert.equal(missingGrant.code, 'AGENT_CAPABILITY_REQUIRED');
      await query("UPDATE agents SET capabilities='[\"workspace.read\",\"tasks.write\",\"studio.read\",\"studio.write\"]' WHERE company_id=$1 AND id=$2", [company, agent]);
      await call(`companies/${company}/tasks/${estimate.taskId}`, 'PATCH', { status: 'doing' }, 'owner', 409);
      await tool('tasks_claim', { taskId: breakdown.taskId, revision: breakdown.revision }, 409);
      await gate(allowed.project.id, 'production', 'approved', 'owner', 409);
      await gate(allowed.project.id, 'brief');
      await tool('tasks_claim', { taskId: estimate.taskId, revision: estimate.revision }, 403);
      await tool('tasks_claim', { taskId: breakdown.taskId, revision: breakdown.revision }, 409);
      await call(`companies/${company}/tasks/${estimate.taskId}`, 'PATCH', { status: 'review' });
      await call(`companies/${company}/tasks/${estimate.taskId}`, 'PATCH', { status: 'done' }, 'owner', 403);
      await call(`companies/${company}/tasks/${estimate.taskId}`, 'PATCH', { status: 'done' }, 'reviewer');
      const reserved = (await tool('tasks_claim', { taskId: breakdown.taskId, revision: breakdown.revision })).result;
      assert.equal(reserved.agentRunId, runId);
      const submitted = (await tool('tasks_submit', { taskId: breakdown.taskId, revision: reserved.revision, summary: 'Fixture shot breakdown ready for independent acceptance.' })).result;
      assert.equal(submitted.status, 'review');
      await call(`agent/runs/${runId}/complete`, 'POST', { leaseToken, clientId: randomUUID(), result: 'Synthetic breakdown submitted for independent acceptance.' }, 'agent');
      await call(`companies/${company}/tasks/${breakdown.taskId}`, 'PATCH', { status: 'done' }, 'owner', 403);
      await call(`companies/${company}/tasks/${breakdown.taskId}`, 'PATCH', { status: 'done' }, 'reviewer');
      await gate(allowed.project.id, 'estimate');
      await gate(allowed.project.id, 'production');
      const ingest = await work('ingest', shot.code), prep = await work('prep', shot.code);
      assert.equal(ingest.readiness, 'ready');
      assert.equal(prep.readiness, 'blocked');
      await call(`companies/${company}/tasks/${prep.taskId}`, 'PATCH', { status: 'review' }, 'owner', 409);
      await acceptHuman(ingest);
      assert.equal((await work('prep', shot.code)).readiness, 'ready');
      const absent = await call(`companies/${company}/tasks/${prep.taskId}`, 'PATCH', { status: 'review' }, 'owner', 409);
      assert.equal(absent.code, 'STUDIO_ARTIFACT_REQUIRED');
      await gate(allowed.project.id, 'client_acceptance', 'approved', 'owner', 400);
    });

    await t.test('media versions are immutable, retry-safe and independently reviewed against the approved shot specification', async () => {
      const prep = await work('prep', shot.code);
      const first = await register(prep, { frameStart: shot.frameStart, frameEnd: shot.frameEnd });
      oldPrepArtifact = first.result.artifact.id;
      assert.equal(first.result.artifact.version, 1);
      assert.equal(first.result.artifact.reviewStatus, 'pending');
      const replay = await call(`${prefix}/projects/${allowed.project.id}/artifacts`, 'POST', first.payload);
      assert.equal(replay.replayed, true);
      assert.equal(replay.artifact.id, oldPrepArtifact);
      assert.equal((await detail(allowed.project.id)).project.revision, first.result.project.revision);
      await call(`${prefix}/projects/${allowed.project.id}/artifacts`, 'POST', { ...first.payload, sha256: 'cd'.repeat(32) }, 'owner', 409);
      await call(`${prefix}/projects/${allowed.project.id}/artifacts`, 'POST', { ...first.payload, clientId: randomUUID() }, 'owner', 409);
      await review(oldPrepArtifact, 'owner', 403);
      await review(oldPrepArtifact, 'member', 403);
      await review(oldPrepArtifact, 'reviewer', 400, { technicalQc: false });
      const missingHandles = await review(oldPrepArtifact, 'reviewer', 409);
      assert.equal(missingHandles.code, 'STUDIO_SPEC_MISMATCH');
      await call(`${prefix}/projects/${unknownPolicy.project.id}/reviews`, 'POST', { clientId: randomUUID(), revision: (await detail(unknownPolicy.project.id)).project.revision, artifactId: oldPrepArtifact, decision: 'approved', technicalQc: true, note: 'Cross-project attempt' }, 'reviewer', 404);

      const second = await register(prep, { name: 'Synthetic prep v002', url: 'https://media.example.invalid/fixture/prep-v002.exr', sha256: 'cd'.repeat(32) });
      assert.equal(second.result.artifact.version, 2);
      await review(oldPrepArtifact, 'reviewer', 409);
      const acceptedVersion = await review(second.result.artifact.id);
      assert.equal(acceptedVersion.review.decision, 'approved');
      const third = await register(prep, { name: 'Synthetic prep v003', url: 'https://media.example.invalid/fixture/prep-v003.exr', sha256: 'ef'.repeat(32) });
      latestPrepArtifact = third.result.artifact.id;
      assert.equal(third.result.artifact.version, 3);
      const versions = (await detail(allowed.project.id)).artifacts.filter(item => item.workItemId === prep.id);
      assert.equal(versions.length, 3);
      assert.equal(versions.find(item => item.id === oldPrepArtifact)?.url, first.payload.url);
      assert.equal(versions.find(item => item.id === oldPrepArtifact)?.sha256, first.payload.sha256);
      assert.equal(versions.find(item => item.id === second.result.artifact.id)?.reviewStatus, 'approved');
      assert.equal(versions.find(item => item.id === latestPrepArtifact)?.reviewStatus, 'pending', 'Approval of an older version must never approve its replacement');
      await call(`companies/${company}/tasks/${prep.taskId}`, 'PATCH', { status: 'review' });
      const pending = await call(`companies/${company}/tasks/${prep.taskId}`, 'PATCH', { status: 'done' }, 'reviewer', 409);
      assert.equal(pending.code, 'STUDIO_ARTIFACT_REVIEW_REQUIRED');
      await review(latestPrepArtifact);
      await call(`companies/${company}/tasks/${prep.taskId}`, 'PATCH', { status: 'done' }, 'reviewer');
      await review(latestPrepArtifact, 'reviewer', 409);
      await call(`${prefix}/projects/${allowed.project.id}/artifacts`, 'POST', { ...artifactInput(prep.id, (await detail(allowed.project.id)).project.revision) }, 'owner', 409);
      await call(`${prefix}/projects/${allowed.project.id}/artifacts/${oldPrepArtifact}`, 'PATCH', { url: 'https://media.example.invalid/replacement.exr' }, 'owner', 404);
    });

    await t.test('a correctly assigned agent can register media but its sponsor cannot approve the contribution', async () => {
      const snapshot = await call(prefix);
      await call(`${prefix}/setup`, 'POST', { clientId: randomUUID(), templateId: 'vfx-boutique', templateVersion: 1, revision: snapshot.profile.revision, assignments: [{ roleKey: 'coordinator', agentId: agent }, { roleKey: 'comp', agentId: agent }, { roleKey: 'producer', humanId: owner }, { roleKey: 'qc', humanId: reviewer }] }, 'owner', 201);
      const createdRun = await call(`companies/${company}/conversations/commons/runs`, 'POST', { clientId: randomUUID(), agentId: agent, prompt: 'Register a synthetic compositing reference and submit its task for independent review.' }, 'owner', 201);
      const claim = await call('agent/runs/claim', 'POST', { workerId: 'studio-media-fixture', claimId: randomUUID() }, 'agent');
      assert.equal(claim.run.id, createdRun.run.id);
      runId = claim.run.id;
      leaseToken = claim.leaseToken;
      const comp = await work('compositing', shot.code);
      assert.equal(comp.readiness, 'ready');
      const reserved = (await tool('tasks_claim', { taskId: comp.taskId, revision: comp.revision })).result;
      const snapshotBefore = await detail(allowed.project.id);
      const { clientId: _clientId, ...fields } = artifactInput(comp.id, snapshotBefore.project.revision);
      const args = { ...fields, projectId: allowed.project.id, frameStart: shot.frameStart - shot.handles, frameEnd: shot.frameEnd + shot.handles, name: 'Agent-produced synthetic comp reference' };
      const receiptId = randomUUID();
      const registered = await tool('studio_artifact_register', args, 200, receiptId);
      const replay = await tool('studio_artifact_register', args, 200, receiptId);
      assert.equal(replay.replayed, true);
      assert.equal(replay.result.artifact.id, registered.result.artifact.id);
      const artifactId = registered.result.artifact.id;
      finalArtifacts.push(artifactId);
      const persisted = (await detail(allowed.project.id)).artifacts.find(item => item.id === artifactId);
      assert.equal(persisted?.producedAgentId, agent);
      await review(artifactId, 'owner', 403);
      await review(artifactId);
      const submitted = (await tool('tasks_submit', { taskId: comp.taskId, revision: reserved.revision, summary: 'Registered synthetic reference ready for independent task review.' })).result;
      assert.equal(submitted.status, 'review');
      const agentView = (await tool('studio_get', { projectId: allowed.project.id, artifactId })).result;
      assert.equal(agentView.artifact.id, artifactId);
      assert.equal(agentView.contentInspectedByThisResponse, false);
      await call(`agent/runs/${runId}/complete`, 'POST', { leaseToken, clientId: randomUUID(), result: 'Synthetic media reference submitted; no actual media was processed.' }, 'agent');
      await call(`companies/${company}/tasks/${comp.taskId}`, 'PATCH', { status: 'done' }, 'owner', 403);
      await call(`companies/${company}/tasks/${comp.taskId}`, 'PATCH', { status: 'done' }, 'reviewer');
      await acceptHuman(await work('qc', shot.code));
    });

    await t.test('delivery requires complete accepted work and exact latest approved final versions, then records a separate acceptance gate', async () => {
      const deliveryPath = `${prefix}/projects/${allowed.project.id}/deliveries`;
      const packageInput = async (artifactIds = finalArtifacts) => ({ clientId: randomUUID(), revision: (await detail(allowed.project.id)).project.revision, name: 'Synthetic final manifest', artifactIds: [...artifactIds], note: 'Fixture package only; no transfer was executed.' });
      const incomplete = await call(deliveryPath, 'POST', await packageInput(), 'owner', 409);
      assert.equal(incomplete.code, 'STUDIO_WORK_INCOMPLETE');
      await acceptHuman(await work('ingest', 'SQ010_SH020'));
      const comp = await work('compositing', 'SQ010_SH020');
      const registered = await register(comp, { name: 'Second synthetic shot final', url: 'https://media.example.invalid/fixture/shot020-v001.exr' });
      finalArtifacts.push(registered.result.artifact.id);
      await review(registered.result.artifact.id);
      await acceptHuman(comp);
      await acceptHuman(await work('qc', 'SQ010_SH020'));
      await acceptHuman(await work('delivery'));
      await call(deliveryPath, 'POST', await packageInput(), 'member', 403);
      await call(deliveryPath, 'POST', await packageInput([randomUUID()]), 'owner', 404);
      const oldVersion = await call(deliveryPath, 'POST', await packageInput([...finalArtifacts, oldPrepArtifact]), 'owner', 409);
      assert.equal(oldVersion.code, 'STUDIO_VERSION_UNAPPROVED');
      const missingShot = await call(deliveryPath, 'POST', await packageInput([finalArtifacts[0]]), 'owner', 409);
      assert.equal(missingShot.code, 'STUDIO_DELIVERY_INCOMPLETE');
      const payload = await packageInput();
      const prepared = await call(deliveryPath, 'POST', payload, 'owner', 201);
      assert.equal(prepared.delivery.status, 'prepared');
      assert.equal(prepared.delivery.manifest.transportStatus, 'not_transferred');
      assert.deepEqual(prepared.delivery.manifest.artifacts.map((item: any) => item.id).sort(), [...finalArtifacts].sort());
      assert(prepared.delivery.manifest.artifacts.every((item: any) => item.reviewStatus === 'approved'));
      assert(prepared.delivery.manifest.reviewReceipts.every((item: any) => item.reviewedBy === reviewer));
      assert.equal(prepared.project.status, 'delivery');
      const replay = await call(deliveryPath, 'POST', payload);
      assert.equal(replay.replayed, true);
      assert.equal(replay.delivery.id, prepared.delivery.id);
      await call(deliveryPath, 'POST', { ...payload, clientId: randomUUID() }, 'owner', 409);
      assert.equal((await detail(allowed.project.id)).deliveries.length, 1);
      const alternate = await call(deliveryPath, 'POST', { ...await packageInput([...finalArtifacts, latestPrepArtifact]), name: 'Alternate package with prep reference' }, 'owner', 201);
      assert.notEqual(alternate.delivery.id, prepared.delivery.id);
      assert.equal(alternate.delivery.status, 'prepared');
      assert.equal((await detail(allowed.project.id)).deliveries.length, 2);
      await gate(allowed.project.id, 'client_acceptance', 'approved', 'owner', 400);
      await gate(allowed.project.id, 'client_acceptance', 'approved', 'owner', 409, { deliveryId: randomUUID() });
      // Seed only an unrelated tenant's manifest row to test ID isolation; no
      // production task status, review decision or transfer is simulated here.
      const foreignDelivery = (await query("INSERT INTO studio_deliveries(company_id,project_id,name,manifest,note,created_by) VALUES($1,$2,'Foreign isolation fixture','{}','Synthetic foreign package',$3) RETURNING id", [foreign, foreignProjectId, outsider])).rows[0];
      await gate(allowed.project.id, 'client_acceptance', 'approved', 'owner', 409, { deliveryId: foreignDelivery.id });
      await gate(allowed.project.id, 'production', 'changes_requested');
      await gate(allowed.project.id, 'client_acceptance', 'approved', 'owner', 409, { deliveryId: prepared.delivery.id });
      await gate(allowed.project.id, 'production');
      await gate(allowed.project.id, 'client_acceptance', 'approved', 'member', 403, { deliveryId: prepared.delivery.id });
      await gate(allowed.project.id, 'client_acceptance', 'approved', 'owner', 201, { deliveryId: prepared.delivery.id });
      const accepted = await detail(allowed.project.id);
      assert.equal(accepted.project.status, 'delivered');
      assert.equal((accepted.project.gates.client_acceptance as { deliveryId?: string }).deliveryId, prepared.delivery.id);
      const acknowledged = accepted.deliveries.find(item => item.id === prepared.delivery.id)!;
      assert.equal(acknowledged.status, 'acknowledged');
      assert.equal(accepted.deliveries.find(item => item.id === alternate.delivery.id)?.status, 'prepared', 'Only the exact client-selected manifest may be acknowledged');
      assert.equal(acknowledged.manifest.transportStatus, 'not_transferred', 'A human attestation must not rewrite the immutable transfer evidence');
      const receipt = (await query("SELECT delivery_id FROM studio_gate_events WHERE company_id=$1 AND project_id=$2 AND gate='client_acceptance' AND decision='approved'", [company, allowed.project.id])).rows;
      assert.deepEqual(receipt.map(item => item.delivery_id), [prepared.delivery.id]);
      await call(deliveryPath, 'POST', await packageInput(), 'owner', 409);
      await gate(allowed.project.id, 'brief', 'changes_requested', 'owner', 409);
      await call(`companies/${company}/tasks/${comp.taskId}`, 'PATCH', { status: 'doing' }, 'owner', 409);
    });
  } finally {
    try {
      await query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [[company, foreign]]);
      await query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[owner, reviewer, member, outsider]]);
    } finally {
      await database().end();
      delete (globalThis as any).coatriaPool;
      await stop?.();
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }
});

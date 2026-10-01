import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {openImagePreparationServiceDatabase,imagePreparationServiceFixture} from './fixtures/image-preparation-service';
import {verifiedProjectGateway} from '../src/lib/project-gateway-bindings';
import {verifiedImagePreparationGateway} from '../src/lib/project-image-preparation-gateway-binding';
import {enrollImagePreparationService} from '../src/lib/project-image-preparation-enrollment';
import {createImagePreparationControlService} from '../src/lib/project-image-preparation-service';
import {resolveProjectImagePreparationProcessor} from '../src/lib/project-image-preparation-service-authority';

test('ordinary verified gateways cannot enroll a preparation processor without explicit hashed protocol configuration',async t=>{
 const database=await openImagePreparationServiceDatabase();t.after(()=>database.close());
 const ordinary=await database.tx(db=>imagePreparationServiceFixture(db,{enroll:false,propose:false,preparationGateway:false}));
 assert(await database.tx(db=>verifiedProjectGateway(db,ordinary.companyId,ordinary.projectId)));
 assert.equal(await database.tx(db=>verifiedImagePreparationGateway(db,ordinary.companyId,ordinary.projectId)),null);
 await assert.rejects(database.tx(db=>enrollImagePreparationService(db,ordinary.enrollment)),{code:'IMAGE_PREPARATION_ENROLLMENT_GATEWAY_CHANGED'});
 assert.equal((await database.db.query('SELECT id FROM project_image_preparation_services WHERE company_id=$1',[ordinary.companyId])).rowCount,0);
 const enabled=await database.tx(db=>imagePreparationServiceFixture(db,{propose:false}));
 const gateway=await database.tx(db=>verifiedImagePreparationGateway(db,enabled.companyId,enabled.projectId));
 assert.equal(gateway?.configurationHash,enabled.gateway.configurationHash);
 assert.equal(await database.tx(db=>verifiedImagePreparationGateway(db,ordinary.companyId,enabled.projectId)),null);
});

test('preparation gateway authority rejects independent timestamp-revoked verifier and provision sponsor',async t=>{
 const database=await openImagePreparationServiceDatabase();t.after(()=>database.close());
 const service=createImagePreparationControlService({transaction:database.tx});
 const request=()=>({requestId:randomUUID(),deadlineAt:new Date(Date.now()+25000).toISOString()});
 for(const principal of ['verifierId','provisionSponsorId'] as const)await t.test(principal,async()=>{
  const unregistered=await database.tx(db=>imagePreparationServiceFixture(db,{enroll:false,propose:false,distinctGatewayPrincipals:true}));
  const enrolled=await database.tx(db=>imagePreparationServiceFixture(db,{propose:false,distinctGatewayPrincipals:true}));
  assert.equal(new Set([enrolled.userId,enrolled.gateway.verifierId,enrolled.gateway.provisionSponsorId]).size,3);
  assert(await database.tx(db=>verifiedImagePreparationGateway(db,unregistered.companyId,unregistered.projectId)));
  assert.equal((await service.execute(enrolled.serviceId,enrolled.token,'readiness',request())).readiness.serviceId,enrolled.serviceId);
  const before=(await database.db.query('SELECT row_to_json(c) AS value FROM project_image_preparation_service_calls c WHERE service_id=$1 ORDER BY request_id',[enrolled.serviceId])).rows;
  for(const fixture of [unregistered,enrolled]){
   await database.db.query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[fixture.companyId,fixture.gateway[principal]]);
   assert.equal((await database.db.query('SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2',[fixture.companyId,fixture.gateway[principal]])).rows[0].role,'admin');
   assert.equal((await database.db.query('SELECT access_revoked_at FROM memberships WHERE company_id=$1 AND user_id=$2',[fixture.companyId,fixture.userId])).rows[0].access_revoked_at,null);
   // Both shared lookup and the image wrapper reject this distinct sponsor.
   // The wrapper retains its stronger ordered membership locks and recheck.
   assert.equal(await database.tx(db=>verifiedProjectGateway(db,fixture.companyId,fixture.projectId)),null);
   assert.equal(await database.tx(db=>verifiedImagePreparationGateway(db,fixture.companyId,fixture.projectId)),null);
  }
  await assert.rejects(database.tx(db=>enrollImagePreparationService(db,unregistered.enrollment)),{code:'IMAGE_PREPARATION_ENROLLMENT_GATEWAY_CHANGED'});
  assert.equal(Number((await database.db.query('SELECT count(*) n FROM project_image_preparation_services WHERE company_id=$1',[unregistered.companyId])).rows[0].n),0);
  assert.equal(await database.tx(db=>resolveProjectImagePreparationProcessor(db,enrolled.companyId,enrolled.projectId)),null);
  await assert.rejects(service.execute(enrolled.serviceId,enrolled.token,'readiness',request()),{code:'IMAGE_PREPARATION_SERVICE_AUTHORITY_ENDED'});
  assert.deepEqual((await database.db.query('SELECT row_to_json(c) AS value FROM project_image_preparation_service_calls c WHERE service_id=$1 ORDER BY request_id',[enrolled.serviceId])).rows,before);
 });
});

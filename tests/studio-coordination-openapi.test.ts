import assert from 'node:assert/strict';
import test from 'node:test';
import {studioOperationsPaths,studioOperationsSchemas} from '../src/lib/studio-operations-openapi';
import {studioCoordinationInput} from '../src/lib/studio-coordination-protocol';

test('coordination opt-in is optional on requests and omitted-off on policy reads',()=>{
 const path=studioOperationsPaths['/api/companies/{companyId}/studio/projects/{projectId}/coordination'] as any;
 const input=path.put.requestBody.content['application/json'].schema;
 assert.equal(input.additionalProperties,false);
 assert.equal(input.properties.coordinatorGeneration.type,'boolean');
 assert(!input.required.includes('coordinatorGeneration'));
 assert(!Object.hasOwn(input.properties.coordinatorGeneration,'default'));
 const policy=studioOperationsSchemas.StudioCoordinationPolicy as any;
 assert.equal(policy.properties.coordinatorGeneration.const,true);
 assert(!policy.required.includes('coordinatorGeneration'));
 assert.match(path.put.description,/separate bounded child/);
 assert.match(path.put.description,/claimable only after the coordinator cycle succeeds/);
 assert.match(path.put.description,/no additional capabilities or spending approval/);
});

test('coordination request documentation preserves omitted legacy bodies and explicit enable/disable',()=>{
 const body={clientId:'00000000-0000-4000-8000-000000000001',revision:0,coordinatorAgentId:'00000000-0000-4000-8000-000000000002',allowedRoleKeys:['comp'],status:'paused',maxRuns:5,maxConcurrentRuns:1,expiresAt:'2027-01-01T00:00:00.000Z'};
 assert.deepEqual(studioCoordinationInput.parse(body),body);
 for(const coordinatorGeneration of [true,false])assert.deepEqual(studioCoordinationInput.parse({...body,coordinatorGeneration}),{...body,coordinatorGeneration});
 assert.equal(studioCoordinationInput.safeParse({...body,coordinatorGeneration:'true'}).success,false);
});

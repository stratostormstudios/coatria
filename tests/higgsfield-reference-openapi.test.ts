import test from 'node:test';
import assert from 'node:assert/strict';
import {agentRuntimeOpenApi} from '../src/lib/agent-runtime-openapi';
import {higgsfieldReferencePaths} from '../src/lib/higgsfield-reference-openapi';
test('reference session paths expose proposal/read metadata and human-only sharing decisions',()=>{
 const paths=higgsfieldReferencePaths as Record<string,any>,base='/api/companies/{companyId}/higgsfield/references';
 for(const path of Object.keys(paths))assert((agentRuntimeOpenApi as any).paths[path]);
 for(const suffix of ['approve','revoke']){const op=paths[`${base}/{referenceId}/${suffix}`].post;assert.deepEqual(op['x-coatria-roles'],['owner','admin']);assert(op.parameters.some((p:any)=>p.name==='Origin'&&p.required));assert(op.requestBody.required);}
 const approval=paths[`${base}/{referenceId}/approve`].post.requestBody.content['application/json'].schema;
 for(const field of ['requestHash','inspectionHash','referenceSharingConsent','preparedProxyConsent','rightsConsent','allBytesConsent'])assert(approval.required.includes(field));
 const serialized=JSON.stringify(paths);assert(!serialized.includes('oauthToken'));assert(!serialized.includes('uploadUrl'));assert(!serialized.includes('leaseId'));
});

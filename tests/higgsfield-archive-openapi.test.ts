import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {higgsfieldArchivePaths} from '../src/lib/higgsfield-archive-openapi';
import {higgsfieldArchiveProposalInput,higgsfieldArchiveApproveInput,higgsfieldArchiveRevokeInput} from '../src/lib/higgsfield-archive-protocol';
import {AGENT_TOOLS} from '../src/lib/agent-tools';

test('archive API describes exact requests, public outcomes and human-only approvals',()=>{
 const paths:any=higgsfieldArchivePaths,base='/api/companies/{companyId}/higgsfield/archives';
 for(const[path,input,roles]of[[base,higgsfieldArchiveProposalInput,['owner','admin','member']],[base+'/{archiveId}/approve',higgsfieldArchiveApproveInput,['owner','admin']],[base+'/{archiveId}/revoke',higgsfieldArchiveRevokeInput,['owner','admin']]] as const){
  const route=paths[path].post;assert.deepEqual(route.requestBody.content['application/json'].schema,z.toJSONSchema(input,{io:'input',unrepresentable:'any'}));assert.deepEqual(route.security,[{sessionCookie:[]}]);assert.deepEqual(route['x-coatria-roles'],roles);assert(route.parameters.some((p:any)=>p.name==='Origin'&&p.required));
  const output=route.responses['200'].content['application/json'].schema.properties.archive;assert.equal(output.additionalProperties,false);assert.equal(output.properties.bytesVerified.type,'boolean');assert.equal(output.properties.outputIdentity.pattern,'^[a-f0-9]{64}$');for(const field of['url','locator','sealed','leaseId','leaseToken','credentials'])assert.equal(field in output.properties,false);
 }
 const listing=paths[base].get.responses['200'].content['application/json'].schema;assert(listing.required.includes('processing'));assert(listing.required.includes('nextAfter'));assert.equal(listing.properties.processing.properties.enabled.type,'boolean');
 const names=Object.keys(AGENT_TOOLS);assert(names.includes('higgsfield_archive_propose'));assert(names.includes('higgsfield_archives_list'));assert(names.includes('higgsfield_archive_get'));assert(!names.includes('higgsfield_archive_approve'));assert(!names.includes('higgsfield_archive_revoke'));
});

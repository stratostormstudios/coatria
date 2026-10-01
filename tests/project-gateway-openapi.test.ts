import test from 'node:test';
import assert from 'node:assert/strict';
import {projectGatewayPaths} from '../src/lib/project-gateway-openapi';
test('project gateway API documents only strict human-admin verification and revocation',()=>{
 const path=projectGatewayPaths['/api/companies/{companyId}/studio/projects/{projectId}/gateway'];assert.deepEqual(Object.keys(path),['get','post','delete']);
 for(const operation of Object.values(path)){assert.deepEqual(operation.security,[{sessionCookie:[]}]);assert.deepEqual(operation['x-coatria-roles'],['owner','admin']);assert.match(operation.description,/Reload the browser/);assert.match(operation.description,/external-client/);assert.match(operation.description,/fresh-nonce/);assert.deepEqual(operation.parameters.filter(p=>p.in==='path').map(p=>p.name),['companyId','projectId']);}
 const post=path.post.requestBody!.content['application/json'].schema as any,remove=path.delete.requestBody!.content['application/json'].schema as any;
 assert.equal(post.additionalProperties,false);assert.deepEqual(post.required,['provisionId','expectedBindingId']);assert.deepEqual(Object.keys(post.properties),['provisionId','expectedBindingId']);assert.equal(remove.additionalProperties,false);assert.deepEqual(remove.required,['bindingId']);assert(!JSON.stringify(post).includes('gatewayUrl'));
 const response=path.post.responses['200'].content['application/json'].schema as any;assert.equal(response.additionalProperties,false);assert.equal(response.properties.gateway.anyOf[0].additionalProperties,false);assert.deepEqual(response.properties.gateway.anyOf[0].required,['origin','expiresAt','bindingId','provisionId','configurationHash']);
});

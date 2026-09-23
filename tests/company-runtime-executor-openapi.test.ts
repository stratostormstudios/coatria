import test from 'node:test';
import assert from 'node:assert/strict';
import {agentRuntimeOpenApi} from '../src/lib/agent-runtime-openapi';
test('operator credential API exposes only metadata and marks token as write-only',()=>{
 const api=agentRuntimeOpenApi as any,path='/api/operator/companies/{companyId}/runtime-configurations/archive/{configurationId}/executor-credentials';
 const post=api.paths[path].post,input=post.requestBody.content['application/json'].schema;
 assert.equal(input.additionalProperties,false);assert.equal(input.properties.token.writeOnly,true);assert.deepEqual(post.security,[{sessionCookie:[]}]);
 for(const operation of[api.paths[path].get,post,api.paths[path+'/{credentialId}'].delete])for(const status of ['200',...(operation===post?['201']:[])]){const body=operation.responses[status].content['application/json'].schema;assert(!JSON.stringify(body).includes('token'));assert(!JSON.stringify(body).includes('sealed'));}
 assert(api.paths['/api/operator/companies/{companyId}/runtime-configurations/{kind}'].post);
});

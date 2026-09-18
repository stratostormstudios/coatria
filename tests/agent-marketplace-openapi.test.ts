import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {agentRuntimeOpenApi} from '../src/lib/agent-runtime-openapi';
import {pluginInstallInput,pluginPatchInput,pluginCatalogResponse} from '../src/lib/plugin-marketplace';
import {missionCreateInput,missionPatchInput} from '../src/lib/agent-missions';
import {runInput} from '../src/lib/agent-runs';

const spec:any=agentRuntimeOpenApi;
const installations='/api/companies/{companyId}/plugin-installations';
const missions='/api/companies/{companyId}/autonomy/missions';
const request=(path:string,method:string)=>spec.paths[path][method].requestBody.content['application/json'].schema;
const input=(schema:z.ZodType)=>z.toJSONSchema(schema,{io:'input',unrepresentable:'any'});

test('agent identity contract authenticates the token without disclosing credential fields',()=>{
 const identity=spec.paths['/api/agent/identity'].get;
 assert.deepEqual(identity.security,[{agentBearer:[]}]);assert.equal(identity.requestBody,undefined);assert.deepEqual(identity.parameters,[]);
 const agent=identity.responses['200'].content['application/json'].schema.properties.agent;
 assert.equal(agent.additionalProperties,false);assert.deepEqual(Object.keys(agent.properties).sort(),['capabilities','companyId','id','name','status']);
});

test('marketplace and autonomous APIs expose current strict input contracts and cannot accept credentials',()=>{
 assert.equal(spec.info.version,'1.8.0');
 for(const[path,method,schema]of[[installations,'post',pluginInstallInput],[installations+'/{installationId}','patch',pluginPatchInput],[missions,'post',missionCreateInput],[missions+'/{missionId}','patch',missionPatchInput]]as const){assert.deepEqual(request(path,method),input(schema));assert.equal(request(path,method).additionalProperties,false);}
 const install=request(installations,'post');assert.equal(install.properties.runtimeConfig.additionalProperties,false);assert.equal(install.properties.character.additionalProperties,false);
 for(const key of['apiKey','token','endpoint','endpointUrl','shell','script'])assert.equal(key in install.properties,false);
 const limits=install.properties.runtimeConfig.properties;assert.equal(limits.maxSteps.maximum,20);assert.equal(limits.maxTotalTokens.maximum,100000);assert.equal(limits.timeoutSeconds.maximum,600);
 const create=request(missions,'post');assert.equal(create.properties.status.default,'paused');assert.equal(create.properties.intervalMinutes.minimum,15);assert.equal(create.properties.maxCycles.maximum,100);
 const runSchema=input(runInput)as any;assert.equal(runSchema.additionalProperties,false);assert.equal('purpose'in runSchema.properties,false);
 assert.deepEqual(spec.components.schemas.AgentRun.properties.purpose.enum,['task','connection_test']);assert.equal(spec.components.schemas.AgentRun.properties.maxAttempts.minimum,1);assert.equal(spec.components.schemas.AgentRun.properties.maxAttempts.maximum,3);
});

test('human administration and agent scheduling use different documented authentication boundaries',()=>{
 const mutations=[[installations,'post'],[installations+'/{installationId}','patch'],[installations+'/{installationId}/rotate','post'],[installations+'/{installationId}/connection-test','post'],[missions,'post'],[missions+'/{missionId}','patch'],[missions+'/{missionId}/run-now','post']];
 for(const[path,method]of mutations){const operation=spec.paths[path][method];assert.deepEqual(operation.security,[{sessionCookie:[]}]);assert.deepEqual(operation['x-coatria-roles'],['owner','admin']);assert(operation.parameters.some((parameter:any)=>parameter.in==='header'&&parameter.name==='Origin'&&parameter.required));assert(!operation.security.some((security:any)=>'agentBearer'in security));}
 const tick=spec.paths['/api/agent/autonomy/tick'].post;assert.deepEqual(tick.security,[{agentBearer:[]}]);assert.equal(tick['x-coatria-worker-scoped'],true);assert.match(tick.description,/does not execute inference or authorize new missions/);
 const tickBody=request('/api/agent/autonomy/tick','post');assert.equal(tickBody.additionalProperties,false);assert.deepEqual(Object.keys(tickBody.properties),['maxMissions']);assert.equal(tickBody.properties.maxMissions.maximum,5);
 assert.deepEqual(spec.paths['/api/plugins/catalog'].get.security,[]);
 for(const path of[installations,installations+'/{installationId}',missions,missions+'/{missionId}',missions+'/{missionId}/runs'])assert.deepEqual(spec.paths[path].get.security,[{sessionCookie:[]}]);
});

test('public catalog output matches the documented strict manifest projection',async()=>{
 const payload=await pluginCatalogResponse().json();const catalog=spec.components.schemas.PluginCatalog,manifest=spec.components.schemas.PluginManifest;
 assert.deepEqual(Object.keys(payload).sort(),[...catalog.required].sort());assert.equal(catalog.additionalProperties,false);assert(payload.plugins.length>0);
 for(const plugin of payload.plugins){assert.deepEqual(Object.keys(plugin).sort(),[...manifest.required].sort());assert.equal(plugin.publisher,manifest.properties.publisher.const);assert(manifest.properties.runtime.enum.includes(plugin.runtime));assert(manifest.properties.harness.enum.includes(plugin.harness));for(const provider of plugin.providers){assert.deepEqual(Object.keys(provider).sort(),[...spec.components.schemas.PluginProvider.required].sort());for(const model of provider.models)assert.deepEqual(Object.keys(model).sort(),[...spec.components.schemas.PluginModel.required].sort());}}
});

test('run context, one-time credentials and nested cycle projections describe nullability without secrets',()=>{
 const schemas=spec.components.schemas;
 const contextResponse=spec.paths['/api/agent/runs/{runId}/context'].get.responses['200'].content['application/json'].schema;
 assert.equal(contextResponse.$ref,'#/components/schemas/AgentRunContext');assert(schemas.AgentRunContext.required.includes('installation'));assert.deepEqual(schemas.AgentRunContext.properties.installation.anyOf,[{$ref:'#/components/schemas/RuntimeInstallation'},{type:'null'}]);
 assert.deepEqual(schemas.RuntimeInstallation.required.sort(),['id','pluginId','manifestVersion','runtimeConfig','character','revision'].sort());assert.equal(schemas.RuntimeInstallation.additionalProperties,false);
 const output=spec.paths[installations].post.responses['201'].content['application/json'].schema;assert(output.required.includes('token'));assert(output.properties.token.anyOf.some((schema:any)=>schema.type==='null'));
 assert(!('token'in schemas.PluginInstallation.properties));assert(!('token_hash'in schemas.PluginInstallation.properties));assert(!('leaseToken'in schemas.AgentRun.properties));
 const cycle=schemas.AgentMissionCycle;assert.equal(cycle.additionalProperties,false);assert.deepEqual(cycle.required,['ordinal','trigger','createdAt','run']);assert.deepEqual(cycle.properties.run.required.sort(),['id','status','agentName','prompt','result','error','createdAt','finishedAt','resultMessageId'].sort());assert.equal(cycle.properties.run.additionalProperties,false);
 assert.deepEqual(schemas.PluginRuntimeConfig.required.sort(),['providerId','modelId','maxSteps','maxOutputTokens','maxTotalTokens','timeoutSeconds'].sort());assert.deepEqual(schemas.AgentCharacter.required.sort(),['roleTitle','persona','workStyle'].sort());
});

test('OpenAPI references resolve and path parameters and operation IDs are unambiguous',()=>{
 const ids=new Set<string>();
 for(const[path,item]of Object.entries(spec.paths)as[string,any][]){const expected=[...path.matchAll(/\{([^}]+)\}/g)].map(match=>match[1]).sort();for(const operation of Object.values(item)as any[]){assert(!ids.has(operation.operationId),operation.operationId);ids.add(operation.operationId);const actual=(operation.parameters||[]).filter((parameter:any)=>parameter.in==='path');assert(actual.every((parameter:any)=>parameter.required));assert.deepEqual(actual.map((parameter:any)=>parameter.name).sort(),expected,path);}}
 function visit(value:any){if(!value||typeof value!=='object')return;if(value.$ref){assert(value.$ref.startsWith('#/components/schemas/'));assert(spec.components.schemas[value.$ref.split('/').at(-1)],value.$ref);}for(const nested of Object.values(value))if(Array.isArray(nested))nested.forEach(visit);else visit(nested);}
 visit(spec);assert(spec.paths[missions+'/{missionId}/run-now'].post.responses['409'].content['application/json'].schema.oneOf.some((schema:any)=>schema.$ref==='#/components/schemas/MissionDispatchResult'));
});

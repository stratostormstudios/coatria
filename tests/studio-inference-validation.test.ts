import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {assertInferenceJsonSafe,validateInferenceArguments} from '../src/lib/studio-inference-validation';
import {AGENT_TOOLS} from '../src/lib/agent-tools';
import {draftStudioStaffing,studioStaffingPlanInput} from '../src/lib/studio-staffing-protocol';

const provider={pluginId:'runpod',manifestVersion:'1.0.0',runtimeConfig:{providerId:'runpod',modelId:'Qwen/Qwen3.8-27B-FP8'}};
const staffing=(extra:Record<string,unknown>={})=>({templateId:'ai-production',brief:'Create a small synthetic production studio.',teamSize:4,disciplines:['compositing'],provider,...extra});
const checkStaffing=(args:unknown)=>validateInferenceArguments('studio_staffing_propose',AGENT_TOOLS.studio_staffing_propose.schema,args);
const image={contractVersion:2,productionPath:'higgsfield',name:'Synthetic image draft',clientName:'Synthetic client',brief:'A single generated reference image for later independent review.',spec:{kind:'image',format:'png',width:16,height:16,color:{mode:'not_required'}},shots:[{kind:'image',code:'GEN001',description:'One generated deliverable.'}]};
const fixedError={name:'Error',message:'Provider completion is not JSON-safe.'};

test('JSONB safety preserves multilingual text and astral characters but rejects NUL and lone surrogates recursively',()=>{
 const text='Café 日本語 العربية 👩🏽‍💻 𝄞';
 assert.doesNotThrow(()=>assertInferenceJsonSafe({text,deep:[{[text]:true}],n:-1.25,empty:null}));
 for(const invalid of ['\u0000','\ud800','\udfff','start\ud800end','\udc00\ud800']){
  for(const value of [invalid,{safe:[invalid]},{[invalid]:'harmless'}])assert.throws(()=>assertInferenceJsonSafe(value),fixedError);
 }
 for(const escaped of ['{"text":"\\u0000"}','{"text":"\\ud800"}','{"text":"\\udfff"}','{"\\u0000":"harmless"}']){
  assert.doesNotThrow(()=>assertInferenceJsonSafe({arguments:escaped}));
  assert.throws(()=>validateInferenceArguments('test',z.object({text:z.string()}),escaped),fixedError);
 }
 assert.equal(validateInferenceArguments('test',z.object({text:z.string()}),'{"text":"\\ud83d\\ude80"}').validation,undefined);
});

test('JSON safety forbids lossy serialization, cycles, holes, accessors and non-JSON types without invoking getters',()=>{
 const cycle:Record<string,unknown>={};cycle.self=cycle;
 let read=false;const getter=Object.defineProperty({},'secret',{enumerable:true,get(){read=true;throw new Error('must not run');}});
 const extra=['value'] as string[]&{extra?:string};extra.extra='lost';
 for(const value of [undefined,NaN,Infinity,-Infinity,1n,Symbol('private'),()=>1,{nested:undefined},cycle,new Date(),new Map(),new Set(),new Array(2),extra,getter,Object.defineProperty({},'hidden',{value:'lost'})])assert.throws(()=>assertInferenceJsonSafe(value),fixedError);
 assert.equal(read,false);
 const repeated={value:'same'};assert.doesNotThrow(()=>assertInferenceJsonSafe([repeated,repeated]));
 const nullPrototype=Object.create(null);nullPrototype.value='fine';assert.doesNotThrow(()=>assertInferenceJsonSafe(nullPrototype));
});

test('malformed JSON retains the exact original raw argument string and emits no parser or input details',()=>{
 const raw='{"private_client_secret":"SENSITIVE PAYLOAD", "teamSize":';
 const result=checkStaffing(raw);
 assert.equal(result.args,raw);assert.equal(result.argumentEncoding,'raw');
 assert.deepEqual(result.validation,{version:1,executed:false,code:'ARGUMENT_JSON_INVALID',issues:[{path:[],code:'invalid_format'}]});
 assert.doesNotMatch(JSON.stringify(result.validation),/SENSITIVE|private_client_secret|SyntaxError|position|Unexpected/);
 assert.throws(()=>checkStaffing(raw+'\ud800'),fixedError);
});

test('schema feedback contains only declared paths and schema-derived hints; dynamic and array keys are wildcarded',()=>{
 const schema=z.object({mode:z.enum(['image','video']),count:z.number().int().min(1).max(11),items:z.array(z.object({name:z.string().min(2).max(8)}).strict()),groups:z.record(z.string(),z.object({enabled:z.boolean()}))}).strict();
 const args={mode:'SECRET_MODE',count:-12345,items:[{name:'SECRET_TOO_LONG',PRIVATE_UNKNOWN:'SECRET'}],groups:{PRIVATE_CUSTOMER:{enabled:'SECRET'}},PRIVATE_ROOT:'SECRET'};
 const result=validateInferenceArguments('test',schema,args);assert.equal(result.validation?.code,'ARGUMENT_SCHEMA_INVALID');
 const feedback=JSON.stringify(result.validation);assert.doesNotMatch(feedback,/SECRET|PRIVATE|12345|received|Unrecognized/);
 assert(result.validation!.issues.some(issue=>issue.path.join('.')==='mode'&&issue.allowed?.join(',')==='image,video'));
 assert(result.validation!.issues.some(issue=>issue.path.join('.')==='count'&&issue.expected==='integer'&&issue.minimum===1&&issue.maximum===11));
 assert(result.validation!.issues.some(issue=>issue.path.join('.')==='items.*.name'&&issue.minimum===2&&issue.maximum===8));
 assert(result.validation!.issues.some(issue=>issue.path.join('.')==='groups.*.enabled'&&issue.expected==='boolean'));
 assert(result.validation!.issues.some(issue=>issue.path.length===0&&issue.code==='unrecognized_keys'));
 assert.strictEqual(result.args,args);assert.equal(result.argumentEncoding,'json');
});

test('nested union branch paths resolve against the approved schema and custom issue messages/params never escape',()=>{
 const schema=z.object({nested:z.union([z.object({text:z.string()}),z.object({enabled:z.boolean()})])}).superRefine((_,ctx)=>ctx.addIssue({code:'custom',path:['PRIVATE_DYNAMIC_FIELD'],message:'SECRET validator message',params:{secret:'SECRET'}}));
 const result=validateInferenceArguments('test',schema,{nested:{text:123,enabled:'SECRET'}});
 assert(result.validation!.issues.some(issue=>issue.path.join('.')==='nested.text'&&issue.expected==='string'));
 assert(result.validation!.issues.some(issue=>issue.path.join('.')==='nested.enabled'&&issue.expected==='boolean'));
 const refined=validateInferenceArguments('test',schema,{nested:{text:'SECRET'}});
 assert.deepEqual(refined.validation!.issues,[{path:['*'],code:'custom'}]);
 assert.doesNotMatch(JSON.stringify([result.validation,refined.validation]),/SECRET|PRIVATE/);
});

test('feedback issue counts, paths, enums and numeric hints satisfy finite protocol bounds',()=>{
 const fields=Object.fromEntries(Array.from({length:30},(_,i)=>['field'+i,z.string()]));
 const feedback=validateInferenceArguments('test',z.object(fields),{}).validation!;assert.equal(feedback.issues.length,12);
 let deep:z.ZodType=z.string();let value:unknown=1;
 for(let i=0;i<20;i++){deep=z.object({nested:deep});value={nested:value};}
 const nested=validateInferenceArguments('test',deep,value).validation!;assert.equal(nested.issues[0].path.length,12);
 const largeEnum=z.enum(Array.from({length:41},(_,i)=>'choice'+i));
 assert.equal(validateInferenceArguments('test',largeEnum,'"SECRET"').validation!.issues[0].allowed,undefined);
 assert.equal(validateInferenceArguments('test',z.number().min(-10).max(1e12),-11).validation!.issues[0].minimum,undefined);
 assert.equal(validateInferenceArguments('test',z.number().min(-10).max(1e12),-11).validation!.issues[0].maximum,undefined);
});

test('schema parsing validates without applying transforms/defaults to returned arguments',()=>{
 const original=staffing({brief:'  Keep original whitespace.  '});
 const result=checkStaffing(JSON.stringify(original));assert.equal(result.validation,undefined);assert.deepEqual(result.args,original);
 assert.equal(Object.hasOwn(result.args as object,'reviewerHumanId'),false);
 assert.equal(Object.hasOwn((result.args as typeof original).provider.runtimeConfig,'maxSteps'),false);
 const transformed=validateInferenceArguments('test',z.object({value:z.string().trim().transform(value=>value.toUpperCase()),count:z.number().default(3)}),{value:'  abc  '});
 assert.deepEqual(transformed.args,{value:'  abc  '});assert.equal(transformed.validation,undefined);
});

test('actual staffing schema refinements and actual generated-project union produce safe feedback',()=>{
 for(const args of [staffing({teamSize:0}),staffing({disciplines:['compositing','compositing']}),staffing({provider:{...provider,runtimeConfig:{...provider.runtimeConfig,maxOutputTokens:8192,maxTotalTokens:2000}}}),staffing({specialists:[{name:'SECRET',roleKeys:['PRIVATE_INVALID_ROLE']}]})]){
  const result=checkStaffing(args);assert.equal(result.validation!.code,'ARGUMENT_SCHEMA_INVALID');assert.doesNotMatch(JSON.stringify(result.validation),/SECRET|PRIVATE|must|cannot|received/);
 }
 const project=validateInferenceArguments('studio_plan',AGENT_TOOLS.studio_plan.schema,JSON.stringify(image));assert.equal(project.validation,undefined);assert.deepEqual(project.args,image);
 const mismatch={...image,shots:[{kind:'audio',code:'GEN001',description:'SECRET',durationMs:{min:1,max:10}}]};
 const result=validateInferenceArguments('studio_plan',AGENT_TOOLS.studio_plan.schema,mismatch);assert.equal(result.validation!.code,'ARGUMENT_SCHEMA_INVALID');
 assert(result.validation!.issues.some(issue=>issue.path.join('.')==='shots.*.kind'&&issue.code==='custom'));
 assert.doesNotMatch(JSON.stringify(result.validation),/SECRET|Each deliverable/);
});

test('schema-valid pure staffing grouping and reviewer errors map to only closed safe domain codes',()=>{
 const required=draftStudioStaffing(staffing()).requiredRoleKeys;
 const cases:Array<[Record<string,unknown>,string]>=[
  [{teamSize:1,specialists:[{name:'SECRET',roleKeys:required.slice(1)}]},'staffing_roles'],
  [{specialists:[{name:'SECRET',roleKeys:required.slice(0,2)},{name:'secret',roleKeys:required.slice(2)}]},'staffing_identity'],
  [{teamSize:1,planningReviewer:{name:'SECRET'}},'staffing_reviewer'],
  [{teamSize:2,planningReviewer:{name:'SECRET'},specialists:[{name:'SECRET',roleKeys:required}]},'staffing_reviewer'],
 ];
 for(const [extra,code] of cases){
  const args=staffing(extra);assert.equal(studioStaffingPlanInput.safeParse(args).success,true);assert.throws(()=>draftStudioStaffing(args));
  const result=checkStaffing(args);assert.equal(result.validation!.code,'STAFFING_VALIDATION_INVALID');assert.equal(result.validation!.issues[0].code,code);assert.doesNotMatch(JSON.stringify(result.validation),/SECRET|secret|Specialists|reviewer requires/);
 }
 const valid=staffing({teamSize:2,planningReviewer:{name:'Independent planner'},specialists:[{name:'Production lead',roleKeys:required}]});
 assert.equal(checkStaffing(valid).validation,undefined);
});

test('unexpected validator failures remain terminal and are never converted using their message',()=>{
 const runtimeFailure=new Error('Specialists must cover each required role exactly once within the requested team size, leaving a separate slot for any planning reviewer.');
 const broken=z.object({}).transform(()=>{throw runtimeFailure;});
 assert.throws(()=>validateInferenceArguments('studio_staffing_propose',broken,{}),error=>error===runtimeFailure);
 // A schema other than the real staffing schema cannot mask the pure
 // function's Zod failure as a documented grouping correction.
 assert.throws(()=>validateInferenceArguments('studio_staffing_propose',z.object({}),{}),z.ZodError);
});

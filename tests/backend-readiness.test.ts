import test from 'node:test';
import assert from 'node:assert/strict';
import { handleApi } from '../src/lib/api';
import { GET as health } from '../src/app/api/health/route';
import {readdir} from 'node:fs/promises';

test('unconfigured deployments expose setup state and never accept accounts or fake data',async()=>{
  const previous=process.env.DATABASE_URL;delete process.env.DATABASE_URL;
  try {
    for(const path of ['session','opportunities']) {
      const response=await handleApi(new Request(`https://coatria.example/api/${path}`),[path]);
      assert.equal(response.status,200);const data=await response.json();assert.equal(data.configured,false);
      if(path==='session'){assert.equal(data.user,null);assert.deepEqual(data.companies,[]);}else assert.deepEqual(data.openings,[]);
    }
    const response=await handleApi(new Request('https://coatria.example/api/auth/signup',{method:'POST',headers:{Origin:'https://coatria.example','Content-Type':'application/json'},body:JSON.stringify({name:'Test',email:'test@example.test',password:'Long enough password'})}),['auth','signup']);
    assert.equal(response.status,503);assert.equal((await response.json()).code,'SETUP_REQUIRED');
    const readiness=await health();assert.equal(readiness.status,503);assert.deepEqual(await readiness.json(),{status:'setup_required',configured:false});
  } finally {if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;}
});

test('readiness requires every current migration, including archive and generated-media schemas',async()=>{
 const previous=process.env.DATABASE_URL,pool=(globalThis as any).coatriaPool,files=(await readdir('database')).filter(name=>/^\d.*\.sql$/.test(name)).sort();
 let missing:string|null='049_studio_reference_generation_continuations.sql',requested:string[]=[];process.env.DATABASE_URL='postgresql://fixture.invalid/not-used';
 (globalThis as any).coatriaPool={query:async(sql:string,values?:unknown[])=>{
  if(sql==='SELECT 1')return {rows:[{}]};
  assert.match(sql,/schema_migrations/);requested=[...(values![0] as string[])].sort();
  // Model the actual WHERE name=ANY(...) query: an omitted prerequisite must
  // not be caught by an assertion swallowed inside the route's error handler.
  return {rows:files.filter(name=>name!==missing&&requested.includes(name)).map(name=>({name}))};
 }};
 try{
  const at48=await health();assert.equal(at48.status,503,'Schema 48 cannot serve reference-generation continuation code');
  assert.deepEqual(await at48.json(),{status:'setup_required',configured:true});assert.deepEqual(requested,files);
  for(const name of files){missing=name;assert.equal((await health()).status,503,`${name} must be present before readiness`);}
  missing=null;const at49=await health();assert.equal(at49.status,200);assert.deepEqual(await at49.json(),{status:'ready',configured:true});
 }
 finally{if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;if(pool===undefined)delete(globalThis as any).coatriaPool;else(globalThis as any).coatriaPool=pool;}
});

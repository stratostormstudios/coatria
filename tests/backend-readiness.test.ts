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

test('readiness requires every current migration, including the archive schema',async()=>{
 const previous=process.env.DATABASE_URL,pool=(globalThis as any).coatriaPool,files=(await readdir('database')).filter(name=>/^\d.*\.sql$/.test(name)).sort();
 let missing:string|null='029_higgsfield_archives.sql';process.env.DATABASE_URL='postgresql://fixture.invalid/not-used';
 (globalThis as any).coatriaPool={query:async(sql:string,values?:unknown[])=>{
  if(sql==='SELECT 1')return {rows:[{}]};
  assert.match(sql,/schema_migrations/);assert.deepEqual([...(values![0] as string[])].sort(),files);
  return {rows:files.filter(name=>name!==missing).map(name=>({name}))};
 }};
 try{assert.equal((await health()).status,503);missing=null;assert.equal((await health()).status,200);}
 finally{if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;if(pool===undefined)delete(globalThis as any).coatriaPool;else(globalThis as any).coatriaPool=pool;}
});

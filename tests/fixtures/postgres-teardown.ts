type FixtureDatabaseControl = {
 query(config:{text:string;values?:unknown[];query_timeout:number}):Promise<{rows:Record<string,unknown>[]}>
};

/** Call only after closing every application pool connected to this fixture's own database. */
export async function dropFixtureDatabase(control:FixtureDatabaseControl,dbName:string,options:{timeoutMs?:number;pollMs?:number}={}){
 const {timeoutMs=10000,pollMs=20}=options;
 if(dbName.length>63||!/^coatria_[a-z][a-z0-9_]*_[0-9a-f]{32}$/.test(dbName))throw new Error('Refusing to drop a non-fixture database');
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000||!Number.isInteger(pollMs)||pollMs<1||pollMs>timeoutMs)throw new Error('Invalid fixture database drain bounds');
 const deadline=performance.now()+timeoutMs;
 const query=(text:string,values?:unknown[])=>{
  const remaining=Math.ceil(deadline-performance.now());
  if(remaining<=0)throw new Error('Fixture database sessions did not drain before teardown deadline');
  return control.query({text,values,query_timeout:remaining});
 };
 const current=(await query('SELECT current_database() AS name')).rows[0]?.name;
 if(typeof current!=='string'||current===dbName)throw new Error('Fixture database cleanup requires a separate control database');
 // pg-pool can resolve Pool.end() before the removed clients finish disconnecting.
 // Wait for those backends; FORCE could kill their closing sockets and emit late errors.
 while(true){
  const sessions=(await query('SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE datname=$1',[dbName])).rows[0]?.sessions;
  if(typeof sessions!=='number'||!Number.isInteger(sessions)||sessions<0)throw new Error('Invalid fixture database session count');
  if(sessions===0)break;
  const remaining=deadline-performance.now();
  if(remaining<=0)throw new Error('Fixture database sessions did not drain before teardown deadline');
  await new Promise(resolve=>setTimeout(resolve,Math.min(pollMs,remaining)));
 }
 // dbName is a validated, unquoted unique fixture identifier. Never terminate other sessions.
 await query('DROP DATABASE '+dbName);
}

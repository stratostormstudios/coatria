import type {Pool,PoolClient} from 'pg';

/** Explicit dedicated pool, never the web application singleton. Callers must
 * run assertHiggsfieldReferenceDatabase on this pool before serving requests. */
export function createHiggsfieldReferenceTransaction(pool:Pick<Pool,'connect'>){
 return async function referenceTransaction<T>(run:(db:PoolClient)=>Promise<T>):Promise<T>{
  const db=await pool.connect();
  try{await db.query('BEGIN');const result=await run(db);await db.query('COMMIT');return result;}
  catch(error){try{await db.query('ROLLBACK');}catch{/* Preserve the original failure; no retry after intent. */}throw error;}
  finally{db.release();}
 };
}

import { readFile,readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import type { Row } from './protocol.js';
export type Change = {table:string,id:string,group_id:string,session_id?:string,device_id?:string,request_id?:string,connection_test_id?:string};
const pendingChanges=new WeakMap<PoolClient,Map<string,Change>>();
export function beginChanges(c:PoolClient){pendingChanges.set(c,new Map());}
export function takeChanges(c:PoolClient){const changes=[...(pendingChanges.get(c)?.values()??[])];pendingChanges.delete(c);return changes;}
export function markChanged(c:PoolClient,table:string,row:Row){if(!row.id||!row.group_id)return;pendingChanges.get(c)?.set(table+':'+row.id,{table,id:row.id,group_id:row.group_id,session_id:row.session_id,device_id:row.device_id,request_id:row.request_id,connection_test_id:row.connection_test_id});}
export async function insert(c:PoolClient,table:string,row:Row):Promise<Row> {
 const keys=Object.keys(row);const result=(await c.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,Object.values(row).map(v=>Array.isArray(v)?JSON.stringify(v):v))).rows[0];markChanged(c,table,result);return result;
}
export async function update(c:PoolClient,table:string,id:string,changes:Row):Promise<Row>{
 const keys=Object.keys(changes);const result=(await c.query(`UPDATE ${table} SET ${keys.map((k,i)=>`${k}=$${i+2}`).join(',')} WHERE id=$1 RETURNING *`,[id,...Object.values(changes).map(v=>Array.isArray(v)?JSON.stringify(v):v)])).rows[0];markChanged(c,table,result);return result;
}
export async function migrate(pool:Pool){
 const c=await pool.connect();try{
  await c.query('SELECT pg_advisory_lock(62006001)');
  await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL)');
  const directory=new URL('../migrations/',import.meta.url);
  for(const name of (await readdir(directory)).filter(x=>/^\d+.*\.sql$/.test(x)).sort()){
  const sql=await readFile(new URL(name,directory),'utf8');
  const sha=createHash('sha256').update(sql).digest('hex');const row=(await c.query('SELECT sha256 FROM schema_migrations WHERE name=$1',[name])).rows[0];
  if(row){if(row.sha256!==sha)throw new Error('Migration checksum mismatch');continue;}
  await c.query('BEGIN');await c.query(sql.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));
  await c.query('INSERT INTO schema_migrations VALUES ($1,$2)',[name,sha]);await c.query('COMMIT');
  }
 }catch(e){await c.query('ROLLBACK');throw e;}finally{await c.query('SELECT pg_advisory_unlock(62006001)');c.release();}
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './postgres.ts';
test('review migration removes unused state and duplicated storage without changing applied migration',async()=>{
 const db=await createDatabase();try{
  const cols=(await db.pool.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'")).rows;
  assert.equal(cols.some(x=>x.table_name==='sessions'&&x.column_name==='preflight'),false);
  assert.ok(cols.some(x=>x.table_name==='devices'&&x.column_name==='error'));
  for(const name of ['http_healthy','push_listening','calibrated'])assert.ok(cols.some(x=>x.table_name==='instances'&&x.column_name===name));
  const constraints=(await db.pool.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='connection_tests'::regclass AND contype='c'")).rows.map(x=>x.definition).join('\n');
  assert.equal(/'pending'|'cancelled'/.test(constraints),false);
 }finally{await db.close();}
});

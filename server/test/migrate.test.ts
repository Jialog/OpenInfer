import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './postgres.ts';
import { migrate } from '../src/database.ts';
test('runtime migrator initializes an empty database once and rejects changed applied SQL',async()=>{
 const db=await createDatabase(false);try{
  await Promise.all([migrate(db.pool),migrate(db.pool)]);
  assert.equal((await db.pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count,'6');
  assert.equal((await db.pool.query('SELECT count(*) FROM requests')).rows[0].count,'0');
  await db.pool.query("UPDATE schema_migrations SET sha256='different'");
  await assert.rejects(migrate(db.pool),/Migration checksum mismatch/);
 }finally{await db.close();}
});

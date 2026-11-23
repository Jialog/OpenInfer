import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import net from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';

// Only schema/constraint tests. No application state-machine implementation.
let cluster, db, dataDir;
const migration = await readFile(new URL('../migrations/001_control_plane.sql', import.meta.url), 'utf8');
const uuid = () => randomUUID();
const hash = () => randomBytes(32);
const clock = '2026-11-08T12:00:00Z';
const deadline = '2026-11-08T12:30:00Z';
const ids = {};
async function insert(table, fields, client = db) {
  const columns = Object.keys(fields);
  return client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i+1}`).join(',')})`, Object.values(fields));
}
async function rejected(fn, code) {
  await db.query('SAVEPOINT rejection');
  await assert.rejects(fn, e => e.code === code);
  await db.query('ROLLBACK TO SAVEPOINT rejection');
}
async function transaction(fn) {
  await db.query('BEGIN');
  try { await fn(); } finally { await db.query('ROLLBACK'); }
}
async function newSession(group = ids.group, user = ids.user, key = uuid()) {
  const id = uuid();
  await insert('sessions', {id, group_id:group, created_by:user, idempotency_key:key, state:'starting', model:'Qwen3.8-27B',
    config:{}, config_sha256:hash(),
    session_key:randomBytes(32),
    phase:'prepare', phase_started_at:clock, phase_deadline_at:deadline});
  return id;
}
function request(id = uuid(), extra = {}) {
  return {id,group_id:ids.group,session_id:ids.session,user_id:ids.user,instance_id:ids.instance,
    submission_id:uuid(),state:'pending',input:{prompt:'schema fixture'},seed:'123',sampling:{temperature:1},
    no_output_deadline_at:deadline,persistence_deadline_at:deadline,...extra};
}
function command(extra = {}) {
  return {id:uuid(),group_id:ids.group,device_id:ids.device,session_id:ids.session,instance_id:ids.instance,
    kind:'start_service',state:'pending',payload:{},deadline_at:deadline,phase:'load',phase_started_at:clock,
    phase_deadline_at:deadline,...extra};
}
before(async () => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  dataDir = await mkdtemp('/tmp/openinfer-schema-');
  cluster = new EmbeddedPostgres({databaseDir:dataDir,port,user:'openinfer_test',password:randomBytes(32).toString('hex'),
    persistent:true,createPostgresUser:false,autoRehydrateSymlinks:true,
    postgresFlags:['-h','127.0.0.1','-k',dataDir],onLog:()=>{},onError:()=>{}});
  await cluster.initialise();
  await cluster.start();
  db = cluster.getPgClient();
  await db.connect();
  // A failed multi-statement migration must leave no partial tables after rollback.
  await assert.rejects(db.query(migration.replace(/COMMIT;\s*$/, 'SELECT missing_migration_function();\nCOMMIT;')), e => e.code === '42883');
  await db.query('ROLLBACK');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n, 0);
  await db.query(migration);
  const directory=new URL('../migrations/',import.meta.url);
  for(const file of (await readdir(directory)).filter(x=>/^\d+.*\.sql$/.test(x)&&x!=='001_control_plane.sql').sort())await db.query(await readFile(new URL(file,directory),'utf8'));
  ids.group=uuid(); ids.otherGroup=uuid(); ids.user=uuid(); ids.otherUser=uuid();
  for (const [g,u] of [[ids.group,ids.user],[ids.otherGroup,ids.otherUser]]) {
    await insert('groups',{id:g});
    await insert('users',{id:u,email:`${u}@example.invalid`,password_hash:'test-fixture-not-a-real-password'});
    await insert('memberships',{group_id:g,user_id:u});
  }
  ids.device=uuid(); ids.helper=uuid();
  for (const d of [ids.device,ids.helper]) {
    const enrollment=uuid();
    await insert('enrollment_tokens',{id:enrollment,group_id:ids.group,created_by:ids.user,token_hash:hash(),
      device_name:'fixture',state:'consumed',created_at:clock,expires_at:deadline,consumed_at:clock});
    await insert('devices',{id:d,group_id:ids.group,enrollment_id:enrollment,name:'fixture',credential_hash:hash(),
      state:'occupied',agent_boot_id:uuid(),inventory:{}});
  }
  ids.session=await newSession(); ids.otherSession=await newSession();
  for (const [d,role,ordinal] of [[ids.device,'service',0],[ids.helper,'helper',1]])
    await insert('session_devices',{group_id:ids.group,session_id:ids.session,device_id:d,role,ordinal});
  ids.instance=uuid();
  await insert('instances',{id:ids.instance,group_id:ids.group,session_id:ids.session,device_id:ids.device,
    generation:1,agent_boot_id:uuid(),state:'starting',spec:{},config_sha256:hash(),phase:'load',phase_started_at:clock,phase_deadline_at:deadline});
});
after(async () => {
  await db?.end();
  await cluster?.stop();
  if (dataDir) await rm(dataDir,{recursive:true,force:true});
});

test('migrations create all fifteen relational tables atomically', async () => {
  const {rows} = await db.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'");
  assert.equal(rows[0].n,15);
});
// An uploaded file belongs to a user of its group, is a prompt-sized text file, and a request may point only at a file of
// its own group.
test('a file names its uploader in its group, and a request takes its prompt only from a file of its own group', () => transaction(async () => {
  const file=(extra={})=>({id:uuid(),group_id:ids.group,user_id:ids.user,name:'task.md',content_type:'text/markdown',size_bytes:12,sha256:hash(),object_key:`files/${uuid()}`,...extra});
  const own=file(),foreign=file({group_id:ids.otherGroup,user_id:ids.otherUser});
  await insert('files',own); await insert('files',foreign);
  await rejected(() => insert('files',file({user_id:ids.otherUser})), '23503');
  await rejected(() => insert('files',file({object_key:own.object_key})), '23505');
  await rejected(() => insert('files',file({size_bytes:0})), '23514');
  await rejected(() => insert('files',file({size_bytes:65537})), '23514');
  await rejected(() => insert('files',file({content_type:'application/pdf'})), '23514');
  await rejected(() => insert('files',file({name:''})), '23514');
  await rejected(() => insert('requests',request(uuid(),{prompt_file_id:foreign.id})), '23503');
  await rejected(() => insert('requests',request(uuid(),{prompt_file_id:uuid()})), '23503');
  await insert('requests',request(uuid(),{prompt_file_id:own.id}));
}));
// An API request names its key, a website request none; the key belongs to the same group.
test('a request names an API key exactly when its source is the API, and only a key of its own group', () => transaction(async () => {
  const key=uuid(),foreign=uuid();
  await insert('api_keys',{id:key,group_id:ids.group,user_id:ids.user,name:'script',key_hash:hash(),hint:'oi_abcd'});
  await insert('api_keys',{id:foreign,group_id:ids.otherGroup,user_id:ids.otherUser,name:'other',key_hash:hash(),hint:'oi_efgh'});
  await rejected(() => insert('api_keys',{id:uuid(),group_id:ids.group,user_id:ids.otherUser,name:'x',key_hash:hash(),hint:'oi_x'}), '23503');
  await rejected(() => insert('requests',request(uuid(),{source:'api'})), '23514');
  await rejected(() => insert('requests',request(uuid(),{source:'web',api_key_id:key})), '23514');
  await rejected(() => insert('requests',request(uuid(),{source:'api',api_key_id:foreign})), '23503');
  await insert('requests',request(uuid(),{source:'api',api_key_id:key}));
  const {rows}=await db.query("SELECT source FROM requests WHERE api_key_id IS NULL LIMIT 1");
  assert.ok(rows.every(r=>r.source==='web'));
}));
test('group foreign keys reject a request attributed to another group user', () => transaction(async () => {
  await rejected(() => insert('requests',request(uuid(),{user_id:ids.otherUser})), '23503');
}));
test('ended session with uncleared device still excludes a second reservation', () => transaction(async () => {
  await db.query("UPDATE sessions SET state='ended',ended_at=$2,session_key=NULL WHERE id=$1",[ids.session,clock]);
  await rejected(() => insert('session_devices',{group_id:ids.group,session_id:ids.otherSession,device_id:ids.device,role:'service',ordinal:0}), '23505');
  await db.query("UPDATE session_devices SET released_at=$2,release_reason='confirmed_stopped' WHERE session_id=$1",[ids.session,clock]);
  await insert('session_devices',{group_id:ids.group,session_id:ids.otherSession,device_id:ids.device,role:'service',ordinal:0});
}));
test('failed instance without exit proof cannot be replaced', () => transaction(async () => {
  await db.query("UPDATE instances SET state='failed' WHERE id=$1",[ids.instance]);
  await rejected(() => insert('instances',{id:uuid(),group_id:ids.group,session_id:ids.session,device_id:ids.device,
    generation:2,agent_boot_id:uuid(),state:'starting',spec:{},config_sha256:hash(),phase:'load',phase_started_at:clock}), '23505');
}));
test('two concurrent request inserts have exactly one winner', async () => {
  const second = cluster.getPgClient(); await second.connect();
  const a=uuid(), b=uuid();
  try {
    const results = await Promise.allSettled([insert('requests',request(a)),insert('requests',request(b),second)]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length,1);
    assert.equal(results.find(x => x.status === 'rejected').reason.code,'23505');
  } finally { await second.end(); await db.query('DELETE FROM requests WHERE id=ANY($1::uuid[])',[[a,b]]); }
});
test('cancelling request keeps its slot; terminal failure releases the slot', () => transaction(async () => {
  const first=request(uuid(),{state:'cancelling',started_at:clock,cancel_deadline_at:deadline});
  await insert('requests',first);
  await rejected(() => insert('requests',request()),'23505');
  await db.query("UPDATE requests SET state='failed',ended_at=$2 WHERE id=$1",[first.id,clock]);
  await insert('requests',request());
}));
test('completion needs contiguous final count, saved object and release evidence', () => transaction(async () => {
  const r=request(); await insert('requests',r);
  await rejected(() => db.query("UPDATE requests SET state='completed',ended_at=$2 WHERE id=$1",[r.id,clock]),'23514');
  await db.query(`UPDATE requests SET state='completed',ended_at=$2,final_seq=0,engine_end='{}',archive_state='saved',
    result_object_key=$3,result_sha256=$4,engine_released_at=$2 WHERE id=$1`,[r.id,clock,`requests/${r.id}.json`,hash()]);
}));
test('chunk key rejects duplicates and cross-group chunk references', () => transaction(async () => {
  const r=request(); await insert('requests',r);
  const chunk={group_id:ids.group,request_id:r.id,seq:1,text:'A',token_count:1,committed_position:2};
  await insert('output_chunks',chunk);
  await rejected(() => insert('output_chunks',{...chunk,text:'different'}),'23505');
  await rejected(() => insert('output_chunks',{...chunk,seq:2,group_id:ids.otherGroup}),'23503');
}));
test('one run command per request and command instance must belong to session', () => transaction(async () => {
  const r=request(); await insert('requests',r);
  await insert('commands',command({kind:'run_request',request_id:r.id}));
  await rejected(() => insert('commands',command({kind:'run_request',request_id:r.id})),'23505');
  await rejected(() => insert('commands',command({session_id:ids.otherSession})),'23503');
}));
test('nonterminal session requires a session-lifetime key', () => transaction(async () => {
  await rejected(() => db.query('UPDATE sessions SET session_key=NULL WHERE id=$1',[ids.session]),'23514');
}));
test('download progress high water survives without a peer permission command', () => transaction(async () => {
  const c=command({kind:'prepare',progress_completed_bytes:'128',progress_total_bytes:'256',progress_at:clock});
  await insert('commands',c);
  const {rows}=await db.query('SELECT progress_completed_bytes,progress_total_bytes FROM commands WHERE id=$1',[c.id]);
  assert.deepEqual(rows[0],{progress_completed_bytes:'128',progress_total_bytes:'256'});
  await rejected(() => insert('commands',command({kind:'peer_update'})),'23514');
}));
test('warmup reference cannot point at another session command', () => transaction(async () => {
  const c=command({kind:'warmup'}); await insert('commands',c);
  await rejected(() => db.query('UPDATE sessions SET warmup_command_id=$2 WHERE id=$1',[ids.otherSession,c.id]),'23503');
}));
test('failed connectivity test holds its port until listener closure is proven', () => transaction(async () => {
  const t={id:uuid(),group_id:ids.group,source_device_id:ids.helper,target_device_id:ids.device,
    source_boot_id:uuid(),target_boot_id:uuid(),source_address_revision:1,target_address_revision:1,
    target_addresses:JSON.stringify(['192.0.2.1']),port:40360,listener_python:'/fixture/python',nonce_hash:hash(),
    state:'unreachable',started_at:clock,deadline_at:deadline,finished_at:clock};
  await insert('connection_tests',t);
  await rejected(() => insert('connection_tests',{...t,id:uuid(),state:'listening',finished_at:null}),'23505');
  await db.query('UPDATE connection_tests SET listener_closed_at=$2 WHERE id=$1',[t.id,clock]);
  await insert('connection_tests',{...t,id:uuid(),state:'listening',finished_at:null});
}));
test('enrollment tokens expire without a revoke state', () => transaction(async () => {
  const id=uuid();
  await insert('enrollment_tokens',{id,group_id:ids.group,created_by:ids.user,token_hash:hash(),
    device_name:'fixture',state:'pending',created_at:clock,expires_at:'2026-11-09T12:00:00Z'});
  await rejected(() => db.query("UPDATE enrollment_tokens SET state='revoked' WHERE id=$1",[id]),'23514');
  await db.query("UPDATE enrollment_tokens SET state='expired' WHERE id=$1",[id]);
  const {rows}=await db.query('SELECT state,extract(epoch from expires_at-created_at)::int AS lifetime FROM enrollment_tokens WHERE id=$1',[id]);
  assert.deepEqual(rows[0],{state:'expired',lifetime:86400});
}));
test('session idempotency key is scoped to group and user and preserves the original resource', () => transaction(async () => {
  const key=uuid();
  const first=await newSession(ids.group,ids.user,key);
  await rejected(() => newSession(ids.group,ids.user,key),'23505');
  const {rows}=await db.query('SELECT id FROM sessions WHERE group_id=$1 AND created_by=$2 AND idempotency_key=$3',[ids.group,ids.user,key]);
  assert.deepEqual(rows.map(r => r.id),[first]);
  await newSession(ids.otherGroup,ids.otherUser,key);
}));
test('request submission key preserves original input after the request becomes terminal', () => transaction(async () => {
  const key=uuid();
  const first=request(uuid(),{submission_id:key,state:'failed',ended_at:clock});
  await insert('requests',first);
  await rejected(() => insert('requests',request(uuid(),{submission_id:key,input:{prompt:'changed input'}})),'23505');
  const {rows}=await db.query('SELECT id,input FROM requests WHERE group_id=$1 AND user_id=$2 AND submission_id=$3',[ids.group,ids.user,key]);
  assert.deepEqual(rows,[{id:first.id,input:first.input}]);
}));
test('archive failure retains readable chunks without permitting completed state', () => transaction(async () => {
  const r=request(uuid(),{state:'failed',ended_at:clock,archive_state:'failed',archive_error:{code:'archive_failed'}});
  await insert('requests',r);
  await insert('output_chunks',{group_id:ids.group,request_id:r.id,seq:1,text:'kept output',token_count:2,committed_position:3});
  assert.equal((await db.query('SELECT text FROM output_chunks WHERE request_id=$1',[r.id])).rows[0].text,'kept output');
  await rejected(() => db.query("UPDATE requests SET state='completed',final_seq=1,contiguous_seq=1,engine_end='{}',engine_released_at=$2 WHERE id=$1",[r.id,clock]),'23514');
}));
test('MVP schema keeps resource idempotency and removes generic receipts and extra protocol state', async () => {
  const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows.map(r => r.table_name);
  assert.ok(!tables.includes('operations'));
  assert.ok(tables.includes('memberships'));
  const columns = (await db.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'")).rows.map(r => `${r.table_name}.${r.column_name}`);
  for (const field of ['sessions.idempotency_key','sessions.session_key','requests.submission_id']) assert.ok(columns.includes(field),field);
  for (const field of ['devices.inventory_seq','instances.status_seq','instances.peer_status_seq','requests.stats_seq',
    'output_chunks.content_sha256','requests.archive_frozen_at','sessions.config_object_key','sessions.config_archived_at',
    'sessions.session_secret_envelope','commands.secret_envelope']) assert.ok(!columns.includes(field),field);
});
test('wall-clock deadlines and live session key survive real PostgreSQL restart', async () => {
  const before=(await db.query('SELECT phase_deadline_at,session_key FROM sessions WHERE id=$1',[ids.session])).rows[0];
  await db.end(); db=null;
  await cluster.stop(); await cluster.start();
  db=cluster.getPgClient(); await db.connect();
  const restored=(await db.query('SELECT phase_deadline_at,session_key FROM sessions WHERE id=$1',[ids.session])).rows[0];
  assert.equal(restored.phase_deadline_at.toISOString(),before.phase_deadline_at.toISOString());
  assert.equal(restored.phase_deadline_at.toISOString(),new Date(deadline).toISOString());
  assert.deepEqual(restored.session_key,before.session_key);
});

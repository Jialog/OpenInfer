import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './postgres.ts';
import { ControlPlane, writerCredential } from '../src/control.ts';
import { MemoryObjectStore } from '../src/storage.ts';
import { fixtureCatalog, fixtureProof, setupPair, startUp } from './fixtures.ts';

// Authentication between the devices of a session: the
// serving machine's start carries the session key, a helper's start only its own credential, bound to its writer id (its
// instance id), its device and its generation; a connection the serving machine does not report authenticated opens
// nothing.
let db:Awaited<ReturnType<typeof createDatabase>>;
before(async()=>{db=await createDatabase();}); after(async()=>db.close());
const sha='a'.repeat(64);

test('the credential is the HMAC openssl computes', ()=>{
 // the expected value is openssl's: HMAC-SHA256 of the label and the four values, one per line, under the key 00 01 … 1f
 const key=Buffer.from(Array.from({length:32},(_,i)=>i));
 assert.equal(writerCredential(key,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333',2),
  'gV8950xWYQaXZ9veY2JLhtyz3xoah4tK52i9uYJf12Q');
});

test('a serving machine is given the session key, each helper its own credential and nothing else', async()=>{
 const options:any=fixtureCatalog();delete options.warmup;
 const p=new ControlPlane(db.pool,new MemoryObjectStore(),options),pair=await setupPair(p,db.pool);
 const s=await startUp(p,pair,['helper']);
 const key=(await db.pool.query('SELECT session_key FROM sessions WHERE id=$1',[s.id])).rows[0].session_key;
 const serving=pair.commands.find((c:any)=>c.kind==='start_service'),helper=pair.commands.find((c:any)=>c.kind==='start_helper');
 assert.deepEqual(serving.payload.session_auth,{session_id:s.id,key:key.toString('base64url')});
 const ref=pair.commandRef('helper',helper);
 assert.equal(helper.payload.entry.command.writer_id,ref.instance_id);
 assert.deepEqual(helper.payload.session_auth,{session_id:s.id,credential:writerCredential(key,s.id,ref.instance_id,pair.devices.helper.id,ref.generation)});
 // a replacement: a new instance id and generation, so a new credential
 await pair.peerStatus('helper','connected');
 await pair.peerStatus('helper','disconnected');
 await pair.status('helper','stopped');
 await p.reconnectHelper(pair.user,s.id,pair.devices.helper.id);
 const prepare=await pair.next('helper','prepare');
 await pair.result('helper',prepare,{manifest_sha256:sha,prepared_version_id:prepare.payload.version.id,build:fixtureProof(prepare.payload.version)});
 const replacement=await pair.next('helper','start_helper'),next=pair.commandRef('helper',replacement);
 assert.equal(next.generation,2);
 assert.notEqual(next.instance_id,ref.instance_id);
 assert.deepEqual(replacement.payload.session_auth,{session_id:s.id,credential:writerCredential(key,s.id,next.instance_id,pair.devices.helper.id,2)});
 assert.notEqual(replacement.payload.session_auth.credential,helper.payload.session_auth.credential);
});

test('a connection the serving machine does not report authenticated opens nothing', async()=>{
 const options:any=fixtureCatalog();delete options.warmup;
 const p=new ControlPlane(db.pool,new MemoryObjectStore(),options),pair=await setupPair(p,db.pool);
 const s=await startUp(p,pair,['helper']);
 await pair.peerStatus('helper','connected',{authenticated:false});
 const now=await p.getSession(pair.user,s.id);
 assert.equal(now.state,'starting');
 assert.equal(now.instances.find((i:any)=>i.device_id===pair.devices.helper.id).push_connection_id,null);
 await pair.peerStatus('helper','connected');
 assert.equal((await p.getSession(pair.user,s.id)).state,'ready');
});

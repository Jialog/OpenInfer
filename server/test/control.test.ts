import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createDatabase } from './postgres.ts';
import { ControlPlane } from '../src/control.ts';
import { MemoryObjectStore } from '../src/storage.ts';
import { fixtureCatalog, fixtureError, fixtureProof, inventory, setupPair, startSession, sendOutput } from './fixtures.ts';
import { EMPTY_TIMING } from '../src/protocol.ts';
let db:Awaited<ReturnType<typeof createDatabase>>;
before(async()=>{db=await createDatabase();}); after(async()=>db.close());
test('fake devices traverse enrollment, directional test, startup, output deduplication and result object',async()=>{
  const p=new ControlPlane(db.pool,new MemoryObjectStore(),{...fixtureCatalog(),now:()=>new Date('2026-11-08T12:00:00Z')});
  const pair=await setupPair(p,db.pool); const s=await startSession(p,pair);
  const key=randomUUID(); const r=await p.submitRequest(pair.user,s.id,key,{prompt:'hello'});
  assert.equal((await p.submitRequest(pair.user,s.id,key,{prompt:'changed'})).id,r.id);
  await assert.rejects(p.submitRequest(pair.user,s.id,randomUUID(),{prompt:'busy'}),/request_busy/);
  await sendOutput(p,pair,r);
  assert.equal((await p.getRequest(pair.user,r.id)).state,'completed');
  assert.equal((await p.getResult(pair.user,r.id)).text,'AB');
  assert.equal((await p.getChunks(pair.user,r.id,'0',100)).chunks.length,2);
  await p.stopSession(pair.user,s.id);
  await pair.stopAll();
  assert.equal((await p.getSession(pair.user,s.id)).state,'ended');
});
test('helper loss degrades, healthy service retains the request; service exit fails and stops',async()=>{
  const p=new ControlPlane(db.pool,new MemoryObjectStore(),fixtureCatalog());
  const pair=await setupPair(p,db.pool); const s=await startSession(p,pair);
  const r=await p.submitRequest(pair.user,s.id,randomUUID(),{prompt:'hello'});
  await pair.peer(false);
  assert.equal((await p.getSession(pair.user,s.id)).state,'degraded');
  assert.equal((await p.getRequest(pair.user,r.id)).state,'running');
  await pair.status('service','failed');
  assert.equal((await p.getRequest(pair.user,r.id)).state,'failed');
  assert.equal((await p.getSession(pair.user,s.id)).state,'stopping');
});
test('restart in startup and stop preserves deadlines, eventually terminates without releasing uncleared devices',async()=>{
  let now=new Date('2026-11-08T12:00:00Z'); const opts={...fixtureCatalog(),now:()=>now};
  let p=new ControlPlane(db.pool,new MemoryObjectStore(),opts);
  const pair=await setupPair(p,db.pool); const s=await p.createSession(pair.user,randomUUID(),pair.plan);
  const before=(await p.getSession(pair.user,s.id)).phase_deadline_at;
  p=new ControlPlane(db.pool,new MemoryObjectStore(),opts); await p.recover();
  assert.equal((await p.getSession(pair.user,s.id)).phase_deadline_at,before);
  now=new Date(now.getTime()+31_000); await p.tick();
  const stopping=await p.getSession(pair.user,s.id); assert.equal(stopping.state,'stopping');
  const deadline=stopping.stop_deadline_at;
  p=new ControlPlane(db.pool,new MemoryObjectStore(),opts); await p.recover();
  assert.equal((await p.getSession(pair.user,s.id)).stop_deadline_at,deadline);
  now=new Date(new Date(deadline).getTime()+1);await p.tick();
  const end=await p.getSession(pair.user,s.id); assert.equal(end.state,'failed');
  assert.equal(end.uncleared_device_ids.length,2);
});
test('run command failure without release evidence cancels instead of freeing the engine',async()=>{
 const p=new ControlPlane(db.pool,new MemoryObjectStore(),fixtureCatalog());const pair=await setupPair(p,db.pool);const s=await startSession(p,pair);const r=await p.submitRequest(pair.user,s.id,randomUUID(),{prompt:'x'});const run=await pair.next('service','run_request');await pair.result('service',run,{},'failed');
 assert.equal((await p.getRequest(pair.user,r.id)).state,'cancelling');await assert.rejects(p.submitRequest(pair.user,s.id,randomUUID(),{prompt:'y'}),/request_busy|session_not_ready/);
});
test('failed end without release evidence cannot admit the next request',async()=>{
 const p=new ControlPlane(db.pool,new MemoryObjectStore(),fixtureCatalog());const pair=await setupPair(p,db.pool);const s=await startSession(p,pair);const r=await p.submitRequest(pair.user,s.id,randomUUID(),{prompt:'x'});
 const {EMPTY_TIMING,EMPTY_STATS}=await import('../src/protocol.ts');await pair.send('service','request.end',{request_id:r.id,instance_id:r.instance_id,final_seq:'0',outcome:'failed',reason:'error',released:false,prompt_tokens:null,output_tokens:'0',timing:EMPTY_TIMING,statistics:EMPTY_STATS,error:fixtureError('stream_error',pair.devices.service.id,'serve')});
 assert.equal((await p.getRequest(pair.user,r.id)).state,'cancelling');
});
test('failed manual helper reconnect creates cleanup and permits another attempt after exit proof',async()=>{
 const p=new ControlPlane(db.pool,new MemoryObjectStore(),fixtureCatalog());const pair=await setupPair(p,db.pool);const s=await startSession(p,pair);await pair.peer(false);await pair.status('helper','stopped');await p.reconnectHelper(pair.user,s.id,pair.devices.helper.id);
 const prepare=await pair.next('helper','prepare');await pair.result('helper',prepare,{},'failed');const stop=await pair.next('helper','stop');await pair.result('helper',stop,{instances:[await pair.report('helper','stopped')],ports_free:true});await p.reconnectHelper(pair.user,s.id,pair.devices.helper.id);assert.equal((await p.getSession(pair.user,s.id)).state,'degraded');
});
test('service socket loss preserves five full minutes and helper control loss alone does not degrade',async()=>{
 let now=new Date('2026-11-08T12:00:00Z');const p=new ControlPlane(db.pool,new MemoryObjectStore(),{...fixtureCatalog(),now:()=>now});const pair=await setupPair(p,db.pool);const s=await startSession(p,pair);now=new Date(now.getTime()+20000);
 await p.closeDevice(pair.devices.helper.id,pair.devices.helper.connection);assert.equal((await p.getSession(pair.user,s.id)).state,'ready');await p.closeDevice(pair.devices.service.id,pair.devices.service.connection);
 assert.equal((await p.getSession(pair.user,s.id)).service_disconnect_deadline_at,new Date(now.getTime()+300000).toISOString());
});
// "A user adds a device and a model we have never seen, on an existing engine kind: which files change?" Data only: this
// model and its two versions exist only in the catalog given to the control plane; nothing about them is in the code.
test('a model the code has never seen is served from its catalog data alone', async()=>{
  const options:any={...fixtureCatalog(),warmup:undefined};
  options.catalog.models['Made-Up-9B']={context_length:8192,think_end_id:null,sampling:{temperature:0.7,top_p:0.8,top_k:40,min_p:0,presence_penalty:0}};
  options.catalog.versions.push({...structuredClone(options.catalog.versions[0]),id:'made-up-service',model:'Made-Up-9B',max_requests:2},
    {...structuredClone(options.catalog.versions[1]),id:'made-up-helper',model:'Made-Up-9B',compatible_service_version_ids:['made-up-service']});
  options.requirements['made-up-service']={memory_bytes:'100',disk_bytes:'100'};options.requirements['made-up-helper']={memory_bytes:'100',disk_bytes:'100',precision_rank:1};
  const p=new ControlPlane(db.pool,new MemoryObjectStore(),options);
  const pair=await setupPair(p,db.pool);
  pair.plan={...pair.plan,service_version_id:'made-up-service',helpers:[{...pair.plan.helpers[0],version_id:'made-up-helper'}]};
  const s=await p.createSession(pair.user,randomUUID(),pair.plan);
  for(const role of ['service','helper']){const prepare=await pair.next(role,'prepare');await pair.result(role,prepare,{manifest_sha256:'a'.repeat(64),prepared_version_id:prepare.payload.version.id,build:fixtureProof(prepare.payload.version)});}
  const serving=await pair.next('service','start_service');
  assert.deepEqual(serving.payload.entry.command,{width:8,batch:2,sampling:{temperature:0.7,top_k:40,top_p:0.8}});
  await pair.result('service',serving,{instance:await pair.report('service','connectable')});
  const helper=await pair.next('helper','start_helper');
  assert.equal(helper.payload.entry.command.writer_id,helper.instance_id);          // a helper's writer id is its instance id
  assert.equal(serving.payload.peer.instance_id,null);
  assert.deepEqual({...helper.payload.entry.command,writer_id:'(its own)'},{spec:'draft',max_seqs:1,think_end_id:null,writer_id:'(its own)',context_length:8192});
  await pair.result('helper',helper,{instance:await pair.report('helper','connectable')});
  await pair.peer(true);
  assert.equal((await p.getSession(pair.user,s.id)).state,'ready');                  // no warm-up in this catalog
  const first=await p.submitRequest(pair.user,s.id,randomUUID(),{prompt:'one'}),second=await p.submitRequest(pair.user,s.id,randomUUID(),{prompt:'two'});
  assert.deepEqual([first.state,second.state],['running','running']);                // two at once: its max_requests
  await assert.rejects(p.submitRequest(pair.user,s.id,randomUUID(),{prompt:'three'}),/request_busy/);
  await pair.next('service','run_request');
  await pair.send('service','request.accepted',{request_id:first.id,instance_id:first.instance_id,prompt_tokens:5000,effective_max_output:3000,committed_position:'5000',timing:EMPTY_TIMING});
  assert.equal((await p.getRequest(pair.user,first.id)).prompt_tokens,5000);       // 8000 tokens fit its 8192
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from './postgres.ts';
import { ControlPlane } from '../src/control.ts';
import { MemoryObjectStore } from '../src/storage.ts';
import { parseDeployment } from '../src/config.ts';
import { EMPTY_TIMING } from '../src/protocol.ts';
import { addHelper, fixtureCatalog, fixtureDeployment, fixtureProof, fixtureVersion, inventory, setupPair, startUp } from './fixtures.ts';

// What the backend says about a session: a helper is connected only when the serving machine says its draft table counts the
// helper's writer, the session is ready only when every current helper is connected, and what fits a machine is what it can
// run in the memory that version uses. Each test is one sequence that once made one of these facts wrong.
let db:Awaited<ReturnType<typeof createDatabase>>;
before(async()=>{db=await createDatabase();}); after(async()=>db.close());

const sha='a'.repeat(64);
const session=async(p:ControlPlane,pair:any,id:string)=>p.getSession(pair.user,id);
const commands=async(sid:string,kind:string)=>(await db.pool.query('SELECT * FROM commands WHERE session_id=$1 AND kind=$2',[sid,kind])).rows;
async function twoHelpers(warmup:boolean){
 const options:any=fixtureCatalog();if(!warmup)delete options.warmup;
 const p=new ControlPlane(db.pool,new MemoryObjectStore(),options),pair=await setupPair(p,db.pool);
 pair.plan.helpers.push(await addHelper(p,pair,'helper2'));
 const s=await startUp(p,pair,['helper','helper2']);
 return {p,pair,s};
}

test('a helper reporting its own status does not make it connected', async()=>{
 // an instance report has no connection fields: one that brings them is refused, and the helper's own report is not a connection
 for(const warmup of [true,false]){
  const {p,pair,s}=await twoHelpers(warmup);
  await pair.peerStatus('helper','connected');
  const service=await pair.report('service','connectable'),own=await pair.report('helper2','ready');
  await assert.rejects(pair.send('helper2','instance.status',{...own,peer_instance_id:service.instance_id,push_connection_id:randomUUID()}),/invalid_input/);
  await pair.send('helper2','instance.status',own);
  assert.equal((await session(p,pair,s.id)).state,'starting',`warmup ${warmup}`);
  assert.equal((await commands(s.id,'warmup')).length,0,`warmup ${warmup}`);
 }
});

test('a connection closed is not reopened by a repeat of its connected report', async()=>{
 const {p,pair,s}=await twoHelpers(false);
 const opened=await pair.peerStatus('helper2','connected');
 await pair.peerStatus('helper2','disconnected');
 await pair.peerStatus('helper2','connected',opened);                    // the device sends its unconfirmed report again
 await pair.peerStatus('helper','connected');
 assert.equal((await session(p,pair,s.id)).state,'starting');
 await pair.peerStatus('helper2','connected');                           // a new connection of the writer
 assert.equal((await session(p,pair,s.id)).state,'ready');
 await pair.peerStatus('helper','disconnected');
 assert.equal((await session(p,pair,s.id)).state,'degraded');
});

test('a warm-up that succeeds after a helper left does not make the session ready', async()=>{
 const {p,pair,s}=await twoHelpers(true);
 await pair.peerStatus('helper','connected');await pair.peerStatus('helper2','connected');
 const warm=await pair.next('service','warmup');
 await pair.peerStatus('helper2','disconnected');
 await pair.result('service',warm,{resource_sha256:sha,output_tokens:'256',timing:EMPTY_TIMING});
 assert.equal((await session(p,pair,s.id)).state,'starting');
 await pair.peerStatus('helper2','connected');
 assert.equal((await session(p,pair,s.id)).state,'ready');
 assert.equal((await commands(s.id,'warmup')).length,1);
});

test('a replaced helper is connected once the serving machine reports its writer, and only it changes', async()=>{
 const {p,pair,s}=await twoHelpers(false);
 await pair.peerStatus('helper','connected');await pair.peerStatus('helper2','connected');
 assert.equal((await session(p,pair,s.id)).state,'ready');
 const kept=(await session(p,pair,s.id)).instances.find((i:any)=>i.device_id===pair.devices.helper.id).push_connection_id;
 await pair.peerStatus('helper2','disconnected');
 assert.equal((await session(p,pair,s.id)).state,'degraded');
 await pair.status('helper2','stopped');
 await p.reconnectHelper(pair.user,s.id,pair.devices.helper2.id);
 const prepare=await pair.next('helper2','prepare');
 await pair.result('helper2',prepare,{manifest_sha256:sha,prepared_version_id:prepare.payload.version.id,build:fixtureProof(prepare.payload.version)});
 const start=await pair.next('helper2','start_helper');
 assert.equal(pair.commandRef('helper2',start).generation,2);
 await pair.result('helper2',start,{instance:await pair.report('helper2','ready')});
 assert.equal((await session(p,pair,s.id)).state,'degraded');
 await pair.peerStatus('helper2','connected');
 const after=await session(p,pair,s.id);
 assert.equal(after.state,'ready');
 assert.equal(after.instances.find((i:any)=>i.device_id===pair.devices.helper.id).push_connection_id,kept);
});

// Placement and the memory check: the candidates are first those this helper can run, and the memory a version is
// checked against is where it runs: its card when its platform names a graphics card vendor, else the machine's memory less
// what the control plane keeps on that machine.
test('Placement passes over a version the helper has no engine for', async()=>{
 const options:any=fixtureCatalog(),base=options.catalog.versions[1];
 options.catalog.versions.push({...structuredClone(base),id:'helper-sglang',engine:'sglang',kind:'helper-sglang'});
 options.requirements['helper-sglang']={memory_bytes:'100',disk_bytes:'100',precision_rank:2};
 const p=new ControlPlane(db.pool,new MemoryObjectStore(),options),pair=await setupPair(p,db.pool);
 await pair.send('helper','heartbeat',{agent_boot_id:pair.devices.helper.boot,inventory:{...inventory('helper'),engines:[{name:'sglang',version:'fixture',available:true,build:null,error:null}]},instances:[]});
 const checked=await p.preflight(pair.user,{...pair.plan,helpers:[{...pair.plan.helpers[0],version_id:null}]});
 assert.equal(checked.plan.helpers[0].version_id,'helper-sglang');
 assert.equal(checked.allowed,true,JSON.stringify(checked.checks.filter((c:any)=>!c.passed)));
});

test('a version on a graphics card is checked against that card, one on unified memory against the memory less the reserve', async()=>{
 const options:any=fixtureCatalog();
 options.catalog.versions.push({...fixtureVersion('service','linux-service','sglang'),kind:'sglang',platform:{os:'linux',arch:'x86_64',gpu_vendor:'NVIDIA'}});
 options.requirements['linux-service']={memory_bytes:'8000000000',disk_bytes:'100'};
 options.catalog.versions.push({...fixtureVersion('helper','mac-helper','mlx'),kind:'helper-mlx',platform:{os:'darwin',arch:'arm64',gpu_vendor:null},compatible_service_version_ids:['linux-service']});
 options.requirements['mac-helper']={memory_bytes:'29999999000',disk_bytes:'100',precision_rank:1};
 const p=new ControlPlane(db.pool,new MemoryObjectStore(),options),pair=await setupPair(p,db.pool);
 const card={id:'0',model:'fixture card',vendor:'NVIDIA',total_bytes:'2000000000',available_bytes:'1000000000',compute_tflops:null,bandwidth_gbps:null,driver:'fixture'};
 await pair.send('service','heartbeat',{agent_boot_id:pair.devices.service.boot,inventory:{...inventory('helper'),addresses:inventory('service').addresses,python_executables:inventory('service').python_executables,gpus:[card],engines:[{name:'sglang',version:'fixture',available:true,build:null,error:null}]},instances:[]});
 await pair.send('helper','heartbeat',{agent_boot_id:pair.devices.helper.boot,inventory:{...inventory('service'),addresses:inventory('helper').addresses,python_executables:inventory('helper').python_executables},instances:[]});
 const checked=await p.preflight(pair.user,{...pair.plan,service_version_id:'linux-service',helpers:[{...pair.plan.helpers[0],version_id:'mac-helper'}]});
 const capacity=(device:string)=>checked.checks.find((c:any)=>c.code==='capacity_insufficient'&&c.device_id===device);
 assert.deepEqual([capacity(pair.devices.service.id).passed,capacity(pair.devices.service.id).available_bytes],[false,'1000000000']);
 // the Mac has 30000000000 bytes free and keeps 1000 for the control plane: 29999999000 fit exactly
 assert.deepEqual([capacity(pair.devices.helper.id).passed,capacity(pair.devices.helper.id).available_bytes],[true,'29999999000']);
});

test('acceptance prompts are bounded by the models\' context, not by a fixed one', ()=>{
 const deployment=fixtureDeployment();
 deployment.catalog.models['Qwen3.8-27B'].context_length=8192;
 deployment.acceptance=[{id:'long',label:'long prompt',resource_sha256:sha,token_ids:Array(5000).fill(1),seed:'1',max_output_tokens:100}];
 assert.equal(parseDeployment(deployment).acceptance![0].token_ids.length,5000);
 deployment.acceptance[0].max_output_tokens=3193;
 assert.throws(()=>parseDeployment(deployment),/Acceptance context budget exceeded/);
});

test('prepare names the files of the entry the device will start', async()=>{
 const options:any=fixtureCatalog(),helper=options.catalog.versions[1];
 // a helper version run without its draft model: its entry without the draft names only the weights
 helper.draft_model.enabled=false;helper.entry.files={weights:'test-only',draft:'draft.gguf'};helper.entry_without_draft={...structuredClone(helper.entry),files:{weights:'test-only'}};
 options.requirements.helper.without_draft_allowed=true;
 const p=new ControlPlane(db.pool,new MemoryObjectStore(),options),pair=await setupPair(p,db.pool);
 await p.createSession(pair.user,randomUUID(),{...pair.plan,helpers:[{...pair.plan.helpers[0],draft_model:'disabled',acknowledge_no_draft_model:true}]});
 assert.deepEqual((await pair.next('helper','prepare')).payload.files,{weights:'test-only'});
 assert.deepEqual((await pair.next('service','prepare')).payload.files,{weights:'test-only'});
});

// The re-check's sequences.
async function replaceHelper2(p:ControlPlane,pair:any,s:any,stopped=async()=>{}){
 await pair.status('helper2','stopped');await stopped();
 await p.reconnectHelper(pair.user,s.id,pair.devices.helper2.id);
 const prepare=await pair.next('helper2','prepare');
 await pair.result('helper2',prepare,{manifest_sha256:sha,prepared_version_id:prepare.payload.version.id,build:fixtureProof(prepare.payload.version)});
 return pair.next('helper2','start_helper');
}

test('a replacement is opened only by a connection of its own, never by its predecessor\'s late reports', async()=>{
 const {p,pair,s}=await twoHelpers(false);
 await pair.peerStatus('helper','connected');
 const first=await pair.peerStatus('helper2','connected');
 await pair.peerStatus('helper2','disconnected');
 assert.equal((await session(p,pair,s.id)).state,'degraded');
 // the predecessor's writer connected once more; its stop arrives first, then that connection's close
 const again=randomUUID();
 const start=await replaceHelper2(p,pair,s,()=>pair.peerStatus('helper2','disconnected',{writer:first.writer,generation:first.generation+1,connection:again}));
 await pair.result('helper2',start,{instance:await pair.report('helper2','ready')});
 await pair.peerStatus('helper2','connected',{writer:first.writer,generation:first.generation,connection:first.connection});
 await pair.peerStatus('helper2','connected',{writer:first.writer,generation:first.generation+1,connection:again});
 const now=await session(p,pair,s.id);
 assert.equal(now.state,'degraded');
 assert.equal(now.instances.find((i:any)=>i.instance_id===pair.commandRef('helper2',start).instance_id).push_connection_id,null);
 await pair.peerStatus('helper2','connected');                             // the replacement's own writer
 assert.equal((await session(p,pair,s.id)).state,'ready');
});

test('a manual recovery opens ready once: a helper that comes back by itself later leaves the session degraded', async()=>{
 const {p,pair,s}=await twoHelpers(false);
 await pair.peerStatus('helper','connected');await pair.peerStatus('helper2','connected');
 await pair.peerStatus('helper2','disconnected');
 const start=await replaceHelper2(p,pair,s);
 await pair.peerStatus('helper2','connected');                             // the serving machine sees it before its start result
 await pair.result('helper2',start,{instance:await pair.report('helper2','ready')});
 assert.equal((await session(p,pair,s.id)).state,'ready');
 await pair.peerStatus('helper','disconnected');
 assert.equal((await session(p,pair,s.id)).state,'degraded');
 await pair.peerStatus('helper','connected');
 assert.equal((await session(p,pair,s.id)).state,'degraded');
});

test('unified memory less the reserve, also on a version that names the Apple vendor', async()=>{
 const options:any=fixtureCatalog();options.catalog.versions[0].platform.gpu_vendor='Apple';options.requirements.service.memory_bytes='28000000000';
 const p=new ControlPlane(db.pool,new MemoryObjectStore(),options),pair=await setupPair(p,db.pool);
 const mac={...inventory('service'),control_plane_reserved_bytes:'5000000000',gpus:[{id:'0',model:'Apple M2 Pro',vendor:'Apple',total_bytes:'34359738368',available_bytes:'30000000000',compute_tflops:null,bandwidth_gbps:null,driver:null}]};
 await pair.send('service','heartbeat',{agent_boot_id:pair.devices.service.boot,inventory:mac,instances:[]});
 const checked=await p.preflight(pair.user,pair.plan),capacity=checked.checks.find((c:any)=>c.code==='capacity_insufficient'&&c.device_id===pair.devices.service.id);
 assert.deepEqual([checked.allowed,capacity.passed,capacity.available_bytes],[false,false,'25000000000']);
});

test('prepare and start name the same files: one expansion of the entry', async()=>{
 const options:any={...fixtureCatalog(),warmup:undefined},helper=options.catalog.versions[1];
 helper.draft_model={...helper.draft_model,draft_repo:'draft',files:[{path:'head.gguf',sha256:sha,size_bytes:'1'}]};
 helper.entry.files={weights:'test-only',draft:'{think_end_id}'};
 const p=new ControlPlane(db.pool,new MemoryObjectStore(),options),pair=await setupPair(p,db.pool);
 await startUp(p,pair,['helper']);
 const sent=(kind:string)=>pair.commands.find((x:any)=>x.role==='helper'&&x.kind===kind).payload;
 assert.deepEqual(sent('prepare').files,{weights:'test-only',draft:7});
 assert.deepEqual(sent('start_helper').entry.files,sent('prepare').files);
});

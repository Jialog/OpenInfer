import { EventEmitter } from 'node:events';
import { randomUUID,randomBytes,createHash,createHmac,timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool,PoolClient } from 'pg';
import { z } from 'zod';
import { insert,update,beginChanges,takeChanges,markChanged } from './database.js';
import { Fault,parse,id,inventorySchema,planSchema,inputSchema,testPlanSchema,messages,EMPTY_TIMING,EMPTY_STATS,EMPTY_METRICS,parseCommandResult,sanitizeDiagnostic,buildDifferences,type Row } from './protocol.js';
import { transition,type StateTable } from './state.js';
import { diskFits } from './disk.js';
import { MemoryObjectStore,type ObjectStore } from './storage.js';
export type User={user_id:string,group_id:string};
/** The owner of an API key, as /v1 sees it. */
export type ApiCaller=User&{api_key_id:string};
/** A parsed /v1/chat/completions request (openai.ts): what the request row and its run_request command carry. */
export type ApiInput={model:string,messages:{role:'system'|'user'|'assistant',content:string}[],stop:string[],max_output_tokens:number|null,seed:string|null,sampling:Row,stream:boolean,include_usage:boolean};
export type Options={catalog:Row,requirements:Record<string,{memory_bytes:string,disk_bytes:string,precision_rank?:number,without_draft_allowed?:boolean}>,warmup?:{resource_id:string,sha256:string,max_output_tokens:256},now?:()=>Date,controlUrls?:{local:string,lan:string},certificateSha256?:string,certificatePath?:string,acceptance?:Row[]};
const terminalSession=(s:string)=>['ended','failed'].includes(s);
const terminalRequest=(s:string)=>['completed','failed','cancelled'].includes(s);
const terminalCommand=(s:string)=>['completed','failed','cancelled'].includes(s);
const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest();
/** A helper's credential: HMAC-SHA256 under the session key of
 *  the label and the helper's writer id (its instance id), device and generation, one per line, in base64url; the serving
 *  machine recomputes it from the key to authenticate the helper's connection. */
export const writerCredential=(key:Buffer,sessionId:string,writerId:string,deviceId:string,generation:number)=>
 createHmac('sha256',key).update(['openinfer writer credential v1',sessionId,writerId,deviceId,String(generation)].join('\n')).digest('base64url');
const serial=(x:any):any=>JSON.parse(JSON.stringify(x,(_k,v)=>typeof v==='bigint'?v.toString():v));
const err=(code:string,device_id:string|null=null,phase:string|null=null,message?:string)=>new Fault(code,400,null,{device_id,phase,message,retryable:false}).body();
const tokenSchema=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
// The card a version runs on, on a device: of the cards of the vendor its platform names (any card when it names none), the
// one with the most free memory; its id (an nvidia-smi index) is the entry's {gpu}.
const card=(inventory:Row,version:Row|undefined)=>[...inventory.gpus].filter((g:Row)=>!version?.platform?.gpu_vendor||g.vendor===version.platform.gpu_vendor)
 .sort((a:Row,b:Row)=>Number(BigInt(b.available_bytes)-BigInt(a.available_bytes)))[0];
// The free memory a version has on a device, by the device's memory type: on a card of its own (the version's platform names
// a vendor; card above) whose memory is not the device's, that card's; else (no vendor named, or a card that reports the
// device's own memory: unified memory, as an Apple Silicon Mac's) the device's memory less what the control plane keeps on it.
// The vendor only chooses the card.
const memoryFree=(inventory:Row,version:Row|undefined)=>{
 const gpu=version?.platform?.gpu_vendor?card(inventory,version):null;if(version?.platform?.gpu_vendor&&!gpu)return 0n;
 return gpu&&gpu.total_bytes!==inventory.memory_total_bytes?BigInt(gpu.available_bytes):BigInt(inventory.memory_available_bytes)-BigInt(inventory.control_plane_reserved_bytes??'0');
};
// Whether a device can run a version at all: its system and processor, a card of the vendor named, the version's engine available.
const runnable=(inventory:Row,version:Row)=>inventory.os===version.platform.os&&inventory.arch===version.platform.arch
 &&(!version.platform.gpu_vendor||!!card(inventory,version))&&inventory.engines.some((e:Row)=>e.name===version.engine&&e.available);
// The session entry of VERSION in a session: its catalog entry with every placeholder "{name}"
// replaced by VALUES[name] (think_end_id, writer_id, gpu, peers, context_length, max_requests, and each key of the
// model's sampling: temperature, top_p, top_k, min_p, presence_penalty).
const fill=(value:unknown,values:Row):unknown=>typeof value==='string'&&/^\{[a-z_]+\}$/.test(value)?(value.slice(1,-1) in values?values[value.slice(1,-1)]:value)
 :Array.isArray(value)?value.map(v=>fill(v,values)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,fill(v,values)])):value;
export class ControlPlane extends EventEmitter {
 private tail:Promise<unknown>=Promise.resolve();
 private connections=new Map<string,{id:string,send:(type:string,payload:Row)=>void,ready:boolean,deadline:Date,close?:(code:number,reason:string)=>void}>();
 constructor(public pool:Pool,public store:ObjectStore,public options:Options){super();}
 now(){return this.options.now?.()??new Date();}
 private after(ms:number){return new Date(this.now().getTime()+ms);}
 private expired(d:any){return d!==null&&d!==undefined&&new Date(d).getTime()<=this.now().getTime();}
 private async serial<T>(fn:()=>Promise<T>):Promise<T>{const next=this.tail.then(fn,fn);this.tail=next.catch(()=>{});return next;}
 private postCommit=new WeakMap<PoolClient,Array<()=>void|Promise<void>>>();
 private reconcileConflicts=new WeakMap<PoolClient,Fault[]>();
 private afterCommit(c:PoolClient,fn:()=>void|Promise<void>){this.postCommit.get(c)!.push(fn);}
 // Serialize short database work; effects that touch sockets run only after COMMIT.
 private async tx<T>(fn:(c:PoolClient)=>Promise<T>):Promise<T>{const committed=await this.serial(async()=>{
  const c=await this.pool.connect();beginChanges(c);this.postCommit.set(c,[]);
  try{await c.query('BEGIN');const value=await fn(c);await c.query('COMMIT');const changes=takeChanges(c);if(changes.length)this.emit('changed',changes);return {value,callbacks:this.postCommit.get(c)!};}
  catch(e){await c.query('ROLLBACK');takeChanges(c);throw e;}finally{this.postCommit.delete(c);this.reconcileConflicts.delete(c);c.release();}
 });for(const fn of committed.callbacks)await fn();return committed.value;}
 async withReadLock<T>(fn:()=>Promise<T>):Promise<T>{return this.serial(fn);}
 async withSnapshot<T>(user:User,send:(snapshot:Row)=>T){return this.serial(async()=>send(await this.snapshot(user)));}
 private async one(c:PoolClient,table:string,key:string,group?:string):Promise<Row>{
  const r=(await c.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`,[key])).rows[0];
  if(!r)throw new Fault('not_found',404);if(group&&r.group_id!==group)throw new Fault('forbidden',403);return r;
 }
 private async lookup(table:string,key:string,user:User):Promise<Row>{parse(id,key);const r=(await this.pool.query(`SELECT * FROM ${table} WHERE id=$1`,[key])).rows[0];if(!r)throw new Fault('not_found',404);if(r.group_id!==user.group_id)throw new Fault('forbidden',403);return r;}
 private async effects(effects:string[],handlers:Record<string,(row:Row)=>Promise<unknown>|unknown>,row:Row){
  if(effects.some(name=>!handlers[name])||Object.keys(handlers).some(name=>!effects.includes(name)))throw new Error('transition_effect_mismatch');
  for(const effect of effects)await handlers[effect](row);
 }
 private async create(c:PoolClient,table:string,values:Row,event:string,handlers:Record<string,(row:Row)=>Promise<unknown>|unknown>={},context:Row={}){
  const next=transition(table as StateTable,'none',event,context);
  const row=await insert(c,table,{...values,state:next.state});await this.effects(next.effects,handlers,row);return row;
 }
 private async move(c:PoolClient,table:string,row:Row,event:string,patch:Row={},handlers:Record<string,(row:Row)=>Promise<unknown>|unknown>={},context:Row={}){
  const archive=table==='archives',field=archive?'archive_state':'state';
  const next=transition(table as StateTable,row[field],event,context);
  const changes={...patch,[field]:next.state};const updated=Object.entries(changes).every(([key,value])=>isDeepStrictEqual(row[key],value))?row:await update(c,archive?'requests':table,row.id,changes);await this.effects(next.effects,handlers,updated);return updated;
 }
 private async cancelCommands(c:PoolClient,where:string,params:unknown[]){
  const commands=(await c.query("SELECT * FROM commands WHERE state NOT IN ('completed','failed','cancelled') AND "+where,params)).rows;
  for(const command of commands)await this.move(c,'commands',command,'supersede',{finished_at:this.now()});
 }
 private async command(c:PoolClient,device:Row,kind:string,payload:Row,refs:Row={},seconds=30):Promise<Row>{
  const phase=kind==='prepare'?'prepare':kind==='stop'||kind==='cancel_request'?'drain':kind==='run_request'?'serve':kind==='warmup'?'warmup':kind==='start_service'||kind==='start_helper'?'load':'connect';
  const now=this.now(),deadline=new Date(now.getTime()+seconds*1000),phaseDeadline=new Date(now.getTime()+Math.min(seconds,kind==='prepare'?600:1800)*1000);
  return this.create(c,'commands',{id:randomUUID(),group_id:device.group_id,device_id:device.id,session_id:null,instance_id:null,request_id:null,connection_test_id:null,...refs,kind,payload,phase,created_at:now,deadline_at:deadline,phase_started_at:now,phase_deadline_at:phaseDeadline},'create');
 }
 private async uniqueCommand(c:PoolClient,device:Row,kind:string,payload:Row,refs:Row={},seconds=30){
  const existing=(await c.query('SELECT * FROM commands WHERE device_id=$1 AND kind=$2 AND session_id IS NOT DISTINCT FROM $3 AND instance_id IS NOT DISTINCT FROM $4 AND request_id IS NOT DISTINCT FROM $5 AND connection_test_id IS NOT DISTINCT FROM $6 AND state NOT IN (\'completed\',\'failed\',\'cancelled\')',[device.id,kind,refs.session_id??null,refs.instance_id??null,refs.request_id??null,refs.connection_test_id??null])).rows[0];
  return existing??this.command(c,device,kind,payload,refs,seconds);
 }
 async enrollment(user:User,name:string){name=parse(z.string().min(1).max(80),name);const token=randomBytes(32).toString('base64url');const e=await this.tx(c=>this.create(c,'enrollment_tokens',{id:randomUUID(),group_id:user.group_id,created_by:user.user_id,token_hash:hash(token),device_name:name,created_at:this.now(),expires_at:this.after(86400000)},'create'));return {id:e.id,group_id:e.group_id,device_name:name,state:e.state,created_at:e.created_at,expires_at:e.expires_at,device_id:null,token,control_urls:this.options.controlUrls,certificate_sha256:this.options.certificateSha256};}
 async enroll(body:unknown){const p=parse(z.object({enrollment_token:tokenSchema,credential:tokenSchema,agent_boot_id:id,inventory:inventorySchema}).strict(),body);return this.tx(async c=>{
  const e=(await c.query('SELECT * FROM enrollment_tokens WHERE token_hash=$1 FOR UPDATE',[hash(p.enrollment_token)])).rows[0];if(!e)throw new Fault('unauthenticated',401);
  if(e.state==='consumed'){const d=(await c.query('SELECT * FROM devices WHERE enrollment_id=$1',[e.id])).rows[0];if(!d?.credential_hash||!timingSafeEqual(d.credential_hash,hash(p.credential)))throw new Fault('unauthenticated',401);return {device_id:d.id,group_id:d.group_id,protocol_version:1,heartbeat_interval_ms:10000};}
  if(e.state!=='pending'||this.expired(e.expires_at))throw new Fault('token_expired',401);
  let device!:Row;
  await this.move(c,'enrollment_tokens',e,'consume',{consumed_at:this.now()},{create_device:async()=>{device=await this.create(c,'devices',{id:randomUUID(),group_id:e.group_id,enrollment_id:e.id,name:e.device_name,credential_hash:hash(p.credential),agent_boot_id:p.agent_boot_id,inventory:p.inventory,last_heartbeat_at:this.now(),heartbeat_deadline_at:this.after(30000),created_at:this.now()},'enroll');}});
  return {device_id:device.id,group_id:device.group_id,protocol_version:1,heartbeat_interval_ms:10000};
 });}
 async authenticateDevice(deviceId:string,credential:string){parse(id,deviceId);const r=(await this.pool.query('SELECT * FROM devices WHERE id=$1',[deviceId])).rows[0];if(!r?.credential_hash||!timingSafeEqual(r.credential_hash,hash(credential)))throw new Fault('credential_revoked',401);return r;}
 async openDevice(deviceId:string,credential:string,send:(type:string,payload:Row)=>void,close?:(code:number,reason:string)=>void){
  await this.authenticateDevice(deviceId,credential);await this.sweep();const connectionId=randomUUID();let deadline=this.after(30000);
  await this.tx(async c=>{const device=await this.one(c,'devices',deviceId);if((device.state!=='offline'||this.recoveryDeadline&&!this.expired(this.recoveryDeadline))&&device.heartbeat_deadline_at)deadline=new Date(Math.min(deadline.getTime(),new Date(device.heartbeat_deadline_at).getTime()));await update(c,'devices',deviceId,{control_connection_id:connectionId,reconciled_at:null});});
  const old=this.connections.get(deviceId);this.connections.set(deviceId,{id:connectionId,send,close,ready:false,deadline});old?.close?.(4403,'superseded_connection');
  send('hello',{connection_id:connectionId,server_time:this.now().toISOString(),heartbeat_interval_ms:10000,reconcile_deadline_at:deadline.toISOString()});return connectionId;
 }
 async closeDevice(deviceId:string,connectionId:string){const conn=this.connections.get(deviceId);if(conn?.id!==connectionId)return;this.connections.delete(deviceId);await this.tx(async c=>{const d=await this.one(c,'devices',deviceId);if(d.control_connection_id!==connectionId)return;await update(c,'devices',deviceId,{control_connection_id:null,reconciled_at:null});await this.disconnectService(c,d,this.now());});}
 private async disconnectService(c:PoolClient,d:Row,at:Date){
  const sessions=(await c.query("SELECT s.* FROM sessions s JOIN session_devices sd ON sd.session_id=s.id WHERE sd.device_id=$1 AND sd.role='service' AND sd.released_at IS NULL AND s.state IN ('ready','degraded')",[d.id])).rows;
  for(const s of sessions){const deadline=s.service_disconnect_deadline_at??new Date(at.getTime()+300000);
   await this.move(c,'sessions',s,'service_disconnected',{submissions_blocked:true,service_disconnect_deadline_at:deadline},{mark_requests_disconnected:async()=>{
    const requests=(await c.query("SELECT * FROM requests WHERE session_id=$1 AND state NOT IN ('completed','failed','cancelled')",[s.id])).rows;
    for(const r of requests)if(!r.disconnect_deadline_at)await update(c,'requests',r.id,{disconnect_deadline_at:deadline});
   }});
  }
 }
 private async offline(c:PoolClient,d:Row,detectedAt=this.now()){
  if(d.state==='removed'||d.state==='offline')return;
  await this.move(c,'devices',d,'heartbeat_timeout',{reconciled_at:null,control_connection_id:null},{handle_device_offline:async()=>{
   const connection=this.connections.get(d.id);this.afterCommit(c,()=>{if(this.connections.get(d.id)?.id===connection?.id){this.connections.delete(d.id);connection?.close?.(4408,'heartbeat_timeout');}});
   const refs=(await c.query('SELECT * FROM session_devices WHERE device_id=$1 AND released_at IS NULL',[d.id])).rows;
   for(const ref of refs){const session=await this.one(c,'sessions',ref.session_id);if(session.state==='starting')await this.beginStop(c,session,'startup_failure');}
   await this.disconnectService(c,d,detectedAt);
   const tests=(await c.query("SELECT * FROM connection_tests WHERE (source_device_id=$1 OR target_device_id=$1) AND state IN ('listening','testing')",[d.id])).rows;
   for(const test of tests)await this.failTest(c,test,'device_offline');
  }});
 }
 private async closeTest(c:PoolClient,t:Row,reason:string){const target=await this.one(c,'devices',t.target_device_id);if(target.state!=='offline'&&target.state!=='removed'&&target.reconciled_at)await this.uniqueCommand(c,target,'close_test',{reason},{connection_test_id:t.id});}
 private async failTest(c:PoolClient,t:Row,code:string,error?:Row){
  if(['listening','testing'].includes(t.state))await this.move(c,'connection_tests',t,'fail',{finished_at:this.now(),error:error??err(code,t.target_device_id,'connect')},{dispatch_close_test:()=>this.closeTest(c,t,code)});
  else if(!t.listener_closed_at)await this.closeTest(c,t,code);
 }
 async createConnectionTest(user:User,body:unknown){const p=parse(testPlanSchema,body);return this.tx(async c=>{
  const source=await this.one(c,'devices',p.source_device_id,user.group_id),target=await this.one(c,'devices',p.target_device_id,user.group_id);
  const busy=[source,target].find(d=>d.state!=='idle'||!d.reconciled_at);if(source.id===target.id||busy)throw new Fault('device_busy',409,null,{device_id:busy?.id??source.id,phase:'connect',message:source.id===target.id?'Choose different source and target devices for the connection test.':'The selected device is reserved or not reconciled; wait for cleanup and reconnection before testing.'});
  if(!p.target_addresses.every(a=>target.inventory.addresses.some((x:Row)=>x.address===a))||!target.inventory.python_executables.some((x:Row)=>x.path===p.listener_python&&x.purpose===(target.inventory.os==='darwin'?'mlx':'helper')))throw new Fault('invalid_input',400,null,{device_id:target.id,phase:'connect',message:'Choose a target address and listener Python executable currently advertised by this device.'});
  if((await c.query('SELECT 1 FROM connection_tests WHERE target_device_id=$1 AND port=$2 AND listener_closed_at IS NULL',[target.id,p.port])).rowCount)throw new Fault('port_busy',409,null,{device_id:target.id,phase:'connect',message:`Port ${p.port} still has an unclosed test listener; confirm its closure before testing again.`});
  const nonce=randomBytes(32).toString('base64url');const t=await this.create(c,'connection_tests',{id:randomUUID(),group_id:user.group_id,...p,source_boot_id:source.agent_boot_id,target_boot_id:target.agent_boot_id,source_address_revision:source.address_revision,target_address_revision:target.address_revision,nonce_hash:hash(nonce),started_at:this.now(),deadline_at:this.after(60000)},'create',{dispatch_listen_test:test=>this.command(c,target,'listen_test',{source_device_id:source.id,target_addresses:p.target_addresses,port:p.port,python:p.listener_python,nonce},{connection_test_id:test.id},60)});return this.testView(t,source,target);
 });}
 private pathValid(t:Row,source:Row,target:Row){return source.inventory.addresses.some((a:Row)=>a.address===t.source_address)&&target.inventory.addresses.some((a:Row)=>a.address===t.target_address)&&target.inventory.python_executables.some((x:Row)=>x.path===t.listener_python&&x.purpose===(target.inventory.os==='darwin'?'mlx':'helper'));}
 private testView(t:Row,source:Row,target:Row){const {group_id,nonce_hash,listener_report,result_report,...rest}=t;const valid=t.state==='reachable'&&!this.expired(t.valid_until)&&t.source_boot_id===source.agent_boot_id&&t.target_boot_id===target.agent_boot_id&&this.pathValid(t,source,target);return serial({...rest,valid,invalid_reason:valid?null:'direction_unreachable'});}
 private async check(c:PoolClient,user:User,p:Row){const checks:Row[]=[];const add=(code:string,passed:boolean,device_id:string|null=null,required_bytes:string|null=null,available_bytes:string|null=null,detail?:string)=>checks.push({code,passed,device_id,message:detail??(passed?`Check ${code.replaceAll('_',' ')} passed.`:required_bytes!==null?`Requires ${required_bytes} bytes; device currently has ${available_bytes} bytes available.`:err(code,device_id,'preflight').message),required_bytes,available_bytes});
  const service=await this.one(c,'devices',p.service_device_id,user.group_id),sv=this.options.catalog.versions.find((v:Row)=>v.id===p.service_version_id&&v.role==='service');
  const helpers:Row[]=[];for(const h of p.helpers)helpers.push(await this.one(c,'devices',h.device_id,user.group_id));
  const devices=[service,...helpers];
  add('distinct_devices',new Set(devices.map(d=>d.id)).size===devices.length);
  // Without a helper version, Placement chooses, among the candidates this helper can run, the
  // first that fits: its memory need in the memory it runs in (memoryFree) and its files in the free disk (diskFits).
  // When none fits the other checks use the version closest to fitting, so the reason shown is what is short: the
  // smallest disk need among the versions whose memory fits, else the smallest memory need; when it can run none, the most
  // precise candidate, whose checks say why.
  const need=(v:Row)=>BigInt(this.options.requirements[v.id].memory_bytes),disk=(v:Row)=>BigInt(this.options.requirements[v.id].disk_bytes);
  const least=(vs:Row[],by:(v:Row)=>bigint)=>vs.reduce<Row|undefined>((a,v)=>a&&by(a)<=by(v)?a:v,undefined);
  const chosen:Row[]=[],placements:(Row|null)[]=[],sizes:Row[]=[];
  for(const [i,h]of p.helpers.entries()){
   const inv=helpers[i].inventory,free=(v:Row)=>memoryFree(inv,v),diskFree=BigInt(inv.disk_available_bytes),fitsDisk=(v:Row)=>diskFits(inv,disk(v)),fits=(v:Row)=>need(v)<=free(v)&&fitsDisk(v);
   let hv=this.options.catalog.versions.find((v:Row)=>v.id===h.version_id),placement:Row|null=null;
   if(h.version_id===null){const all=this.placementCandidates(p.service_version_id),candidates=all.filter(v=>runnable(inv,v)),pick=candidates.find(fits),memoryFits=candidates.filter(v=>need(v)<=free(v));
    placement={chosen:pick,skipped:pick?candidates.slice(0,candidates.indexOf(pick)):candidates};hv=pick??(memoryFits.length?least(memoryFits,disk):least(candidates,need))??all[0];}
   chosen.push(hv);placements.push(placement);sizes.push({need,free,disk,diskFree,fitsDisk,gpu:(v:Row)=>card(inv,v)?.id});
  }
  const plan={...p,helpers:p.helpers.map((h:Row,i:number)=>({...h,version_id:placements[i]?placements[i]!.chosen?.id??null:h.version_id}))};
  for(const [index,d]of devices.entries()){
   const inv=d.inventory,version=index===0?sv:chosen[index-1],placement=index?placements[index-1]:null,size=index?sizes[index-1]:null;
   add('control_online',d.state==='idle'&&d.reconciled_at!==null&&!this.expired(d.heartbeat_deadline_at),d.id);
   const platform=version?.platform;add('unsupported_platform',!!platform&&inv.os===platform.os&&inv.arch===platform.arch,d.id,null,null,platform&&!(inv.os===platform.os&&inv.arch===platform.arch)?`This version runs on ${platform.os} ${platform.arch}; this device is ${inv.os} ${inv.arch}.`:undefined);
   // Hardware the version was not measured on may serve or help when it fits, and is marked unverified
   if(platform?.gpu_vendor){const gpu=card(inv,version);add('hardware_unvalidated',!!gpu,d.id,null,null,gpu?undefined:`This version runs on a ${platform.gpu_vendor} card; this device reports none.`);}
   const names=[inv.cpu_model,...inv.gpus.map((g:Row)=>g.model)].filter(Boolean),measured=version?.validation?.hardware??[];
   if(version&&measured.length&&!measured.some((m:string)=>names.some((n:string)=>m.includes(n))))add('hardware_unverified',true,d.id,null,null,`${names[0]||'This device'} is not among the hardware this version was measured on (${measured.join('; ')}); it may run, and its memory is checked as for any device.`);
   // A device that reports no engine at all runs a device program that starts none: no build preparation helps.
   if(!inv.engines.length)add('engines_not_available',false,d.id);
   const required=this.options.requirements[version?.id];add('version_setup_missing',!!version?.validation?.complete&&!!version?.entry&&!!version?.manifest_sha256&&!!version?.build_requirements&&!!required,d.id);
   if(version){add('role',version.role===(index===0?'service':'helper'),d.id);const engine=inv.engines.find((e:Row)=>e.name===version.engine);if(engine?.build&&version.build_requirements&&!buildDifferences(version.build_requirements,engine.build).length)add('build_match',true,d.id);else if(inv.engines.length)add('build_preparation_required',!!engine?.available,d.id);}
   if(required){const available=memoryFree(inv,version);add('capacity_insufficient',available>=BigInt(required.memory_bytes),d.id,required.memory_bytes,available.toString(),placement&&(placement.chosen||!(need(version)<=size!.free(version)))?this.placementMessage(placement as any,version,size as any):index>0&&version?.draft_model?.enabled&&available<BigInt(required.memory_bytes)?`The helper configuration including its draft model, caches and workspace requires ${required.memory_bytes} bytes; only ${available} bytes are available. Select the validated configuration without the draft model if available.`:undefined);add('disk_insufficient',diskFits(inv,BigInt(required.disk_bytes)),d.id,required.disk_bytes,inv.disk_available_bytes,placement&&!placement.chosen&&need(version)<=size!.free(version)?this.placementMessage(placement as any,version,size as any):inv.local_model_folders&&BigInt(required.disk_bytes)>BigInt(inv.disk_available_bytes)?`This version's files are ${required.disk_bytes} bytes and ${inv.disk_available_bytes} bytes of disk are free; the device has folders of model files of its own, so it checks how many bytes are missing when it prepares the session, before it downloads anything.`:undefined);}
  }
  let port:number|null=null;
  for(const [i,h]of p.helpers.entries()){
   const hv=chosen[i],helper=helpers[i];
   add('version_compatibility',!!sv&&!!hv?.compatible_service_version_ids?.includes(p.service_version_id),helper.id);
   add('version_setup_missing',h.draft_model==='enabled'?!!hv?.draft_model?.enabled&&!h.acknowledge_no_draft_model:!!h.acknowledge_no_draft_model&&hv?.draft_model?.enabled===false&&!!this.options.requirements[hv?.id]?.without_draft_allowed,helper.id);
   const t=await this.one(c,'connection_tests',h.connection_test_id,user.group_id);
   // every helper reaches the serving machine on the one port its draft table listens on: the first helper's tested one
   port??=t.port;const samePort=t.port===port;
   add('direction_unreachable',t.source_device_id===helper.id&&t.target_device_id===service.id&&this.testView(t,helper,service).valid&&t.listener_closed_at!==null&&samePort,helper.id,null,null,samePort?undefined:`This helper's connection test used port ${t.port}; the session's other helpers reach the serving machine on port ${port}. Test it on port ${port}.`);
  }
  add('port_busy',!(await c.query('SELECT 1 FROM connection_tests WHERE target_device_id=ANY($1::uuid[]) AND listener_closed_at IS NULL',[devices.map(d=>d.id)])).rowCount);
  const model=this.options.catalog.models[sv?.model];
  const config={model:sv?.model??null,plan,versions:[sv,...chosen],sampling:model?.sampling??null,context_length:model?.context_length??null,think_end_id:model?.think_end_id??null,
   max_requests:sv?.max_requests??null,gpus:[card(service.inventory,sv)?.id??null,...chosen.map((v:Row,i:number)=>card(helpers[i].inventory,v)?.id??null)],port,warmup:this.options.warmup??null};
  return {response:{checked_at:this.now().toISOString(),allowed:checks.every(x=>x.passed),plan,checks,config_sha256:checks.every(x=>x.passed)?hash(JSON.stringify(config)).toString('hex'):null},config,devices,test:null};
 }
 // The helper versions Placement chooses from, in the order it tries them: the most precise first
 // (lowest precision_rank, by KL divergence from BF16), at equal precision the one with more drafts a round. The
 // deployment check (config.ts) guarantees each such version a memory need and a rank.
 private placementCandidates(serviceVersionId:string):Row[]{
  const rank=(v:Row)=>this.options.requirements[v.id].precision_rank!,drafts=(v:Row)=>v.draft_model.parameters.drafts_per_round;
  return this.options.catalog.versions.filter((v:Row)=>v.role==='helper'&&v.draft_model?.enabled&&v.validation.complete&&v.compatible_service_version_ids.includes(serviceVersionId)).sort((a:Row,b:Row)=>rank(a)-rank(b)||drafts(b)-drafts(a));
 }
 // The capacity note of a preflight that left the version to Placement: what it chose or that nothing fits, and for each
 // version passed over whether its GPU memory, its disk, or both are short and by how much.
 private placementMessage(placement:{chosen:Row|undefined,skipped:Row[]},version:Row,{need,free,disk,diskFree,fitsDisk,gpu}:{need:(v:Row)=>bigint,free:(v:Row)=>bigint,disk:(v:Row)=>bigint,diskFree:bigint,fitsDisk:(v:Row)=>boolean,gpu:(v:Row)=>string|undefined}){
  const memory=(v:Row)=>v.platform?.gpu_vendor?'GPU memory':'memory';
  const short=(v:Row)=>`${v.label} needs ${[need(v)>free(v)?`${need(v)} bytes of ${memory(v)}, ${need(v)-free(v)} bytes more than are free`:'',!fitsDisk(v)?`${disk(v)} bytes of disk, ${disk(v)-diskFree} bytes more than are free`:''].filter(x=>x).join(' and ')}`;
  const room=`${version.platform?.gpu_vendor?`GPU ${gpu(version)??'(none)'}`:'The memory'} has ${free(version)} bytes free and the disk ${diskFree} bytes`;
  if(!placement.chosen)return `No helper version fits: ${room}. ${placement.skipped.map(short).join('; ')}. Free GPU memory or disk space on the helper and check again.`;
  return `Placement chose ${version.label}, the most precise helper version that fits: it needs ${need(version)} bytes of ${memory(version)} and ${disk(version)} bytes of disk; ${room}.${placement.skipped.length?` More precise versions skipped: ${placement.skipped.map(short).join('; ')}.`:''}`;
 }
 /** GET /catalog: the catalog and the versions Placement chooses from, in its order, with the free GPU memory and disk each needs. */
 // GET /catalog: the catalog, its first serving version (the website's default where it runs) and, per serving version, the
 // helper versions Placement chooses from for it, in its order, with what each needs
 catalog(){const services=this.options.catalog.versions.filter((v:Row)=>v.role==='service');return {...this.options.catalog,service_version_id:services[0]?.id??null,
  placement:Object.fromEntries(services.map((s:Row)=>[s.id,this.placementCandidates(s.id).map(v=>({version_id:v.id,memory_bytes:this.options.requirements[v.id].memory_bytes,disk_bytes:this.options.requirements[v.id].disk_bytes}))]))};}
 async preflight(user:User,body:unknown){const p=parse(planSchema,body);return this.tx(async c=>(await this.check(c,user,p)).response);}
 async createSession(user:User,key:string,body:unknown){parse(id,key);const created=await this.tx(async c=>{
  const old=(await c.query('SELECT id FROM sessions WHERE group_id=$1 AND created_by=$2 AND idempotency_key=$3',[user.group_id,user.user_id,key])).rows[0];if(old)return old.id;
  const plan=parse(planSchema,body),unnamed=plan.helpers.findIndex((h:Row)=>h.version_id===null);if(unnamed>=0)throw new Fault('invalid_input',400,`helpers.${unnamed}.version_id`,{phase:'preflight',message:'Name the helper version: send the plan the preflight returned, which carries the version Placement chose.'});
  const checked=await this.check(c,user,plan);if(!checked.response.allowed)throw new Fault('preflight_failed',409,null,{phase:'preflight'});
  const session=await this.create(c,'sessions',{id:randomUUID(),group_id:user.group_id,created_by:user.user_id,idempotency_key:key,model:checked.config.model,max_active_requests:checked.config.max_requests,config:checked.config,config_sha256:Buffer.from(checked.response.config_sha256!,'hex'),session_key:randomBytes(32),phase:'prepare',phase_started_at:this.now(),phase_deadline_at:this.after(600000),created_at:this.now()},'create',{
   reserve_devices:async s=>{for(const [i,d]of checked.devices.entries()){await insert(c,'session_devices',{group_id:user.group_id,session_id:s.id,device_id:d.id,role:i===0?'service':'helper',ordinal:i,reserved_at:this.now()});await this.move(c,'devices',d,'reserve');}},
   dispatch_prepare:async s=>{for(const [i,d]of checked.devices.entries())await this.prepareInstance(c,s,d,i,1);},
  });return session.id;
 });await this.dispatch();return this.getSession(user,created);}
 // The instance of a session's device at ORDINAL (the plan's place: 0 the serving machine), of GENERATION. Its prepare names
 // the files of the entry it will start (sessionEntry: the same expansion its start carries).
 private async prepareInstance(c:PoolClient,s:Row,d:Row,ordinal:number,generation:number){
  const instance=await this.create(c,'instances',{id:randomUUID(),group_id:s.group_id,session_id:s.id,device_id:d.id,generation,agent_boot_id:d.agent_boot_id,spec:{role:ordinal===0?'target':'helper',ordinal},config_sha256:s.config_sha256,phase:'prepare',phase_started_at:this.now(),phase_deadline_at:this.after(600000),created_at:this.now()},'create');
  await this.command(c,d,'prepare',{version:s.config.versions[ordinal],effective_config:s.config,files:this.sessionEntry(s,instance).files},{session_id:s.id,instance_id:instance.id},4200);return instance;
 }
 private async refreshPhase(c:PoolClient,sid:string,phase?:string){
  const session=await this.one(c,'sessions',sid);if(!['starting','degraded'].includes(session.state))return;
  const deadlines=(await c.query("SELECT phase_deadline_at FROM commands WHERE session_id=$1 AND kind IN ('prepare','start_service','start_helper','warmup') AND state NOT IN ('completed','failed','cancelled') UNION ALL SELECT phase_deadline_at FROM instances WHERE session_id=$1 AND stopped_at IS NULL AND state NOT IN ('failed','cleanup_required','stopping') AND phase='connect' AND push_connection_id IS NULL",[sid])).rows.map(x=>new Date(x.phase_deadline_at).getTime()).filter(Number.isFinite);
  if(deadlines.length)await update(c,'sessions',sid,{phase:phase??session.phase,phase_started_at:phase&&phase!==session.phase?this.now():session.phase_started_at,phase_deadline_at:new Date(Math.max(...deadlines))});
 }
 private async advance(c:PoolClient,sid:string){const session=await this.one(c,'sessions',sid);if(session.state==='starting')await this.move(c,'sessions',session,'startup_progress',{}, {advance_startup:()=>this.advanceStartup(c,session)});else if(session.state==='degraded')await this.advanceStartup(c,session);}
 // The session entry of instance INS, the one expansion its prepare and its start carry: its version's catalog entry (or its
 // entry without the draft model when the plan turned the draft model off), its placeholders filled from the session
 // (fill); a helper's writer id is its instance id (Connections), and a serving machine without helpers loses its table.
 private sessionEntry(s:Row,ins:Row){
  const ordinal=ins.spec.ordinal,v=s.config.versions[ordinal],h=ordinal?s.config.plan.helpers[ordinal-1]:null,helpers=s.config.plan.helpers.length;
  const values={...s.config.sampling,think_end_id:s.config.think_end_id,context_length:s.config.context_length,max_requests:s.config.max_requests,
   peers:helpers>0,writer_id:ordinal?ins.id:null,gpu:s.config.gpus?.[ordinal]??'0'};
  const entry:Row={kind:v.kind,...fill(h?.draft_model==='disabled'&&v.entry_without_draft?v.entry_without_draft:v.entry,values) as Row};
  if(ordinal===0&&!helpers)delete entry.table;
  return entry;
 }
 // Every helper connected: the serving instance up, one current
 // instance for every helper of the plan, each up by its own report and with a connection from the serving instance open.
 private connected(s:Row,service:Row,helpers:Row[]){return ['connectable','ready'].includes(service.state)&&helpers.length===s.config.plan.helpers.length
  &&helpers.every(h=>['connectable','ready'].includes(h.state)&&h.push_connection_id!==null&&h.peer_instance_id===service.id);}
 private async advanceStartup(c:PoolClient,s:Row){
  const all=(await c.query('SELECT i.*,sd.role FROM instances i JOIN session_devices sd USING(session_id,device_id) WHERE i.session_id=$1 AND i.stopped_at IS NULL ORDER BY sd.ordinal',[s.id])).rows;
  const service=all.find(i=>i.role==='service'),helpers=all.filter(i=>i.role==='helper');if(!service||helpers.length!==s.config.plan.helpers.length)return;
  if(all.some(i=>['failed','cleanup_required','stopping'].includes(i.state)))return;
  const port=s.config.port??null;
  for(const ins of all){
   const prepared=(await c.query("SELECT 1 FROM commands WHERE instance_id=$1 AND kind='prepare' AND state='completed'",[ins.id])).rowCount;
   const started=(await c.query("SELECT 1 FROM commands WHERE instance_id=$1 AND kind IN ('start_service','start_helper')",[ins.id])).rowCount;
   if(!prepared||started||ins.role==='helper'&&!['connectable','ready'].includes(service.state))continue;
   const d=await this.one(c,'devices',ins.device_id);
   let peer:Row;
   if(ins.role==='service'){const first=helpers[0],t=first?await this.one(c,'connection_tests',s.config.plan.helpers[0].connection_test_id):null;peer={device_id:first?.device_id??null,instance_id:null,addresses:t?[t.source_address]:[],port};}
   else{const t=await this.one(c,'connection_tests',s.config.plan.helpers[ins.spec.ordinal-1].connection_test_id);peer={device_id:service.device_id,instance_id:service.id,addresses:[t.target_address],port,connection_test_id:t.id};}
   const cmd=await this.command(c,d,ins.role==='service'?'start_service':'start_helper',{entry:this.sessionEntry(s,ins),config_sha256:s.config_sha256.toString('hex'),peer},{session_id:s.id,instance_id:ins.id},5400);
   await update(c,'instances',ins.id,{phase:'load',phase_started_at:this.now(),phase_deadline_at:cmd.phase_deadline_at});await this.refreshPhase(c,s.id,'load');
  }
  // every way into ready: every helper connected, in this transaction; from degraded through a replacement in its connect
  // deadline, from starting with the warm-up done when there is one
  if(!this.connected(s,service,helpers))return;
  if(s.state==='degraded'){
   const helper=helpers.find(h=>h.generation>1&&h.phase_deadline_at&&!this.expired(h.phase_deadline_at));
   if(helper){await this.move(c,'sessions',s,'helper_reconnected',{phase:'serve',phase_deadline_at:null,error:null});await update(c,'instances',helper.id,{phase:'serve',phase_deadline_at:null});}
   return;
  }
  if(s.config.warmup){
   if(!s.warmup_command_id){const d=await this.one(c,'devices',service.device_id);const cmd=await this.command(c,d,'warmup',{resource_id:s.config.warmup.resource_id,resource_sha256:s.config.warmup.sha256},{session_id:s.id,instance_id:service.id},1800);await update(c,'sessions',s.id,{warmup_command_id:cmd.id});await this.refreshPhase(c,s.id,'warmup');return;}
   if((await this.one(c,'commands',s.warmup_command_id)).state!=='completed')return;
  }
  await this.move(c,'sessions',s,s.config.warmup?'warmup_succeeded':'serving_ready',{phase:'serve',phase_started_at:this.now(),phase_deadline_at:null,submissions_blocked:false});
 }
  // Once the session is chosen, a website and an API request are one transaction: the service instance and
 // its device must be reachable, then the request and its run_request command are created together.
 private async openRequest(c:PoolClient,s:Row,unready:(device_id:string)=>Fault,fields:Row,run:Row):Promise<string>{
  const ins=(await c.query("SELECT i.* FROM instances i JOIN session_devices sd USING(session_id,device_id) WHERE i.session_id=$1 AND sd.role='service' AND i.stopped_at IS NULL",[s.id])).rows[0];if(!ins)throw unready(s.config.plan.service_device_id);const d=await this.one(c,'devices',ins.device_id);if(d.state!=='occupied'||!d.reconciled_at||this.expired(d.heartbeat_deadline_at))throw unready(d.id);
  const taken=(await c.query("SELECT slot FROM requests WHERE session_id=$1 AND state NOT IN ('completed','failed','cancelled')",[s.id])).rows.map(x=>x.slot);let slot=1;while(taken.includes(slot))slot++;
  const r=await this.create(c,'requests',{id:randomUUID(),group_id:s.group_id,session_id:s.id,instance_id:ins.id,slot,timing:EMPTY_TIMING,statistics:EMPTY_STATS,no_output_deadline_at:this.after(600000),persistence_deadline_at:this.after(600000),received_at:this.now(),...fields},'submit',{create_run_command:r=>this.command(c,d,'run_request',{input:run.input,seed:r.seed,sampling:r.sampling,max_output_tokens:r.requested_max_output,cap_max_output:run.cap_max_output,stop:run.stop,context_length:s.config.context_length,no_output_deadline_at:r.no_output_deadline_at,persistence_deadline_at:r.persistence_deadline_at},{session_id:s.id,instance_id:ins.id,request_id:r.id},600)});return r.id;
 }
 // Whether the session serves as many requests as it may at once (its serving version's max_requests).
 private async busy(c:PoolClient,sid:string){const s=await this.one(c,'sessions',sid);return Number((await c.query("SELECT count(*) AS n FROM requests WHERE session_id=$1 AND state NOT IN ('completed','failed','cancelled')",[sid])).rows[0].n)>=s.max_active_requests;}
 private randomSeed(){return (randomBytes(8).readBigUInt64BE()&((1n<<63n)-1n)).toString();}
 // A prompt file (migration 006): its bytes are an object in the store under files/{id}, written before its row, so a row
 // exists only for a stored object; the row ties it to the user who uploaded it. The name ends in .txt or .md and the
 // bytes are a prompt: UTF-8 text, not blank, at most the 65536 bytes a prompt may have (the route's body limit).
 private fileFault(action:string,what='file'){return new Fault('file_store_failed',502,null,{message:`The ${what} could not be ${action} the storage bucket; try again.`,retryable:true});}
 /** Where the objects are: the memory of this process (no bucket configured), lost when it stops, or a bucket. The website says which. */
 storage():'memory'|'bucket'{return this.store instanceof MemoryObjectStore?'memory':'bucket';}
 // The object KEY of a file or a result. An object the store no longer has (after a restart without a bucket, every one)
 // is not a fault of the server: its record remains and says what was stored, and the answer says it is gone.
 private async stored(key:string,what:'file'|'result'):Promise<Buffer>{
  try{return await this.store.get(key);}catch(error){
   if((error as Error)?.name==='NoSuchKey')throw new Fault('not_stored',410,null,{message:`This ${what} is no longer stored.${this.storage()==='memory'?' No bucket is configured, so it was kept in the memory of the server process and was lost when the server restarted.':''}`});
   throw this.fileFault('read from',what);
  }
 }
 private fileView(f:Row){return serial({id:f.id,name:f.name,content_type:f.content_type,size_bytes:f.size_bytes,sha256:f.sha256.toString('hex'),created_at:f.created_at});}
 async uploadFile(user:User,name:unknown,body:Buffer|null){
  if(typeof name!=='string'||name.length>255||!/^[^/\\\x00-\x1f]+\.(txt|md)$/i.test(name))throw new Fault('invalid_input',400,'name',{message:'Name the file in the query: a .txt or .md file name of at most 255 characters, without a path.'});
  if(!body)throw new Fault('invalid_input',400,'file',{message:'Send the file itself as the request body, not JSON.'});
  let text='';try{text=new TextDecoder('utf-8',{fatal:true}).decode(body);}catch{throw new Fault('invalid_input',400,'file',{message:'The file is not UTF-8 text.'});}
  if(!text.trim())throw new Fault('invalid_input',400,'file',{message:'The file is empty.'});
  const fileId=randomUUID(),key=`files/${fileId}`;
  try{await this.store.put(key,body);}catch{throw this.fileFault('saved to');}
  return {file:this.fileView(await this.tx(c=>insert(c,'files',{id:fileId,group_id:user.group_id,user_id:user.user_id,name,content_type:/\.md$/i.test(name)?'text/markdown':'text/plain',size_bytes:body.length,sha256:hash(body),object_key:key,created_at:this.now()})))};
 }
 async getFile(user:User,key:string){const f=await this.lookup('files',key,user);return {name:f.name as string,content_type:f.content_type as string,bytes:await this.stored(f.object_key,'file')};}
 // A request whose prompt is an uploaded file: the file's text, read back from the store before the transaction, goes on
 // as a typed prompt does, and the request row keeps the file's id (prompt_file_id).
 async submitRequest(user:User,sessionId:string,key:string,body:unknown){parse(id,key);parse(id,sessionId);
  // A call repeated with its key answers with the request it made (the transaction finds it): its file is not read again,
  // and need not be stored any more.
  let promptFileId:string|null=null;
  if(body&&typeof body==='object'&&(body as Row).prompt_file_id!==undefined&&!(await this.pool.query('SELECT 1 FROM requests WHERE group_id=$1 AND user_id=$2 AND submission_id=$3',[user.group_id,user.user_id,key])).rowCount){
   const {prompt_file_id,...rest}=parse(inputSchema,body);promptFileId=prompt_file_id!;body={...rest,prompt:(await this.getFile(user,promptFileId)).bytes.toString('utf8')};}
  const rid=await this.tx(async c=>{
  const old=(await c.query('SELECT id FROM requests WHERE group_id=$1 AND user_id=$2 AND submission_id=$3',[user.group_id,user.user_id,key])).rows[0];if(old)return old.id;
  const s=await this.one(c,'sessions',sessionId,user.group_id),unready=(device_id:string)=>new Fault('session_not_ready',409,null,{device_id,phase:'serve'});if(!['ready','degraded'].includes(s.state)||s.submissions_blocked)throw unready(s.config.plan.service_device_id);
  const input=parse(inputSchema,body);
  if(await this.busy(c,s.id))throw new Fault('request_busy',409,null,{device_id:s.config.plan.service_device_id,phase:'serve'});if(input.max_output_tokens!==undefined&&input.max_output_tokens>=s.config.context_length)throw new Fault('context_budget_exceeded',400,'max_output_tokens');
  const acceptance=input.acceptance_prompt_id?this.options.acceptance?.find(x=>x.id===input.acceptance_prompt_id):null;if(input.acceptance_prompt_id&&!acceptance)throw new Fault('invalid_input');if(acceptance&&input.max_output_tokens!==undefined&&input.max_output_tokens!==acceptance.max_output_tokens)throw new Fault('invalid_input');
  const seed=acceptance?.seed??this.randomSeed(),max=acceptance?.max_output_tokens??input.max_output_tokens??null;
  return this.openRequest(c,s,unready,{user_id:user.user_id,submission_id:key,input,prompt_file_id:promptFileId,seed,sampling:s.config.sampling,requested_max_output:max},{input:acceptance?{kind:'acceptance',prompt_id:acceptance.id,resource_sha256:acceptance.resource_sha256,token_ids:acceptance.token_ids,ignore_eos:true}:{kind:'text',prompt:input.prompt},stop:[],cap_max_output:false});
 });await this.dispatch();return this.getRequest(user,rid);}
 // An API request goes to the group's session that can serve (ready or degraded, its service control
 // connection up) and has no active request, the oldest first: 503 without such a session, 429 when every one is busy. The
 // serving machine caps its budget to what fits (cap_max_output).
 async submitApiRequest(caller:ApiCaller,input:ApiInput){const rid=await this.tx(async c=>{
  const key=(await c.query('SELECT * FROM api_keys WHERE id=$1 FOR UPDATE',[caller.api_key_id])).rows[0];if(!key||key.revoked_at)throw new Fault('api_key_revoked',401,null,{message:'This API key has been revoked; generate a new one on the API keys page of the website.'});
  const sessions=(await c.query("SELECT * FROM sessions WHERE group_id=$1 AND model=$2 AND state NOT IN ('ended','failed') ORDER BY created_at,id",[caller.group_id,input.model])).rows,serving=sessions.filter(s=>['ready','degraded'].includes(s.state)&&!s.submissions_blocked);
  if(!serving.length){const starting=sessions.find(s=>s.state==='starting'),blocked=sessions.find(s=>['ready','degraded'].includes(s.state));
   throw new Fault('session_not_ready',503,null,{phase:'serve',message:starting?`The session is starting (${starting.phase}); try again when it is ready.`:blocked?'The serving machine of the session has lost its control connection; try again when it has reconnected.':`No session is running. Start a session on the website first: ${this.options.controlUrls?.lan??'the control plane'}/#/sessions/new`});}
  let chosen:Row|undefined;for(const s of serving)if(!await this.busy(c,s.id)){chosen=s;break;}
  if(!chosen)throw new Fault('request_busy',429,null,{phase:'serve',message:'The session is serving another request (from the website or the API); one request runs at a time. Try again shortly.'});
  const unready=(device_id:string)=>new Fault('session_not_ready',503,null,{device_id,phase:'serve',message:'The serving machine of the session is not reachable; try again when it has reconnected.'});
  const request=await this.openRequest(c,chosen,unready,{user_id:caller.user_id,submission_id:randomUUID(),input:{messages:input.messages,stop:input.stop},seed:input.seed??this.randomSeed(),sampling:input.sampling,requested_max_output:input.max_output_tokens===null?null:Math.min(input.max_output_tokens,chosen.config.context_length),source:'api',api_key_id:key.id},{input:{kind:'chat',messages:input.messages},stop:input.stop,cap_max_output:true});
  await update(c,'api_keys',key.id,{last_used_at:this.now()});return request;
 });await this.dispatch();return rid;}
 // An API client that hangs up cancels its request through the existing cancellation, only while the
 // service control connection is up (else the 30-second cancel deadline would stop the session); recovering, cancelling and
 // ended requests are left as they are.
 async clientDisconnected(user:User,rid:string){await this.tx(async c=>{const r=await this.one(c,'requests',rid,user.group_id);if(!['pending','running'].includes(r.state))return;if((await this.one(c,'sessions',r.session_id)).submissions_blocked)return;await this.cancel(c,r,'client_disconnected');});await this.dispatch();}
 // A key is oi_ and 32 random bytes in base64url; only its SHA-256 is stored. It belongs to one user in
 // one group, is shown once, and can only be revoked.
 private keyView(k:Row){return serial({id:k.id,name:k.name,hint:k.hint,created_at:k.created_at,last_used_at:k.last_used_at,revoked_at:k.revoked_at});}
 async createApiKey(user:User,body:unknown){const {name}=parse(z.object({name:z.string().min(1).max(80)}).strict(),body);const secret=`oi_${randomBytes(32).toString('base64url')}`;
  const k=await this.tx(c=>insert(c,'api_keys',{id:randomUUID(),group_id:user.group_id,user_id:user.user_id,name,key_hash:hash(secret),hint:`oi_${secret.slice(-4)}`,created_at:this.now()}));return {api_key:this.keyView(k),secret};}
 // certificate_path: the certificate file this control plane loaded (OPENINFER_TLS_CERT), for the API keys page.
 async listApiKeys(user:User){return {certificate_path:this.options.certificatePath??null,api_keys:(await this.pool.query('SELECT * FROM api_keys WHERE group_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC',[user.group_id,user.user_id])).rows.map(k=>this.keyView(k))};}
 async revokeApiKey(user:User,key:string){parse(id,key);return {api_key:this.keyView(await this.tx(async c=>{const k=(await c.query('SELECT * FROM api_keys WHERE id=$1 AND group_id=$2 AND user_id=$3 FOR UPDATE',[key,user.group_id,user.user_id])).rows[0];if(!k)throw new Fault('not_found',404);return k.revoked_at?k:update(c,'api_keys',k.id,{revoked_at:this.now()});}))};}
 async authenticateApiKey(header:string|undefined):Promise<ApiCaller>{const given=/^(\S+) (oi_[A-Za-z0-9_-]{43})$/.exec(header??''),secret=given?.[1].toLowerCase()==='bearer'?given[2]:undefined;/* RFC 7235: the scheme is not case-sensitive */const k=secret?(await this.pool.query('SELECT * FROM api_keys WHERE key_hash=$1',[hash(secret)])).rows[0]:undefined;
  if(!k)throw new Fault('invalid_api_key',401,null,{message:'Send an API key as Authorization: Bearer oi_...; generate one on the API keys page of the website.'});
  if(k.revoked_at)throw new Fault('api_key_revoked',401,null,{message:'This API key has been revoked; generate a new one on the API keys page of the website.'});
  return {user_id:k.user_id,group_id:k.group_id,api_key_id:k.id};}
 private async failRequest(c:PoolClient,r:Row,event:string,code:string){
  if(terminalRequest(r.state))return;
  const effects=transition('requests',r.state,event).effects,instance=await this.one(c,'instances',r.instance_id);
  await this.move(c,'requests',r,event,{ended_at:this.now(),error:err(code,instance.device_id,'serve')},Object.fromEntries(effects.map(effect=>[effect,()=>this.beginStop(c,{id:r.session_id},code==='service_offline'?'service_offline':code==='cancel_timeout'?'cancel_timeout':'reconcile_failure')])));
 }
 private async cancel(c:PoolClient,r:Row,reason:string){if(terminalRequest(r.state)||r.state==='cancelling')return;
  if(r.state==='pending'){await this.move(c,'requests',r,reason==='client_disconnected'?'client_disconnected':'session_stop',{ended_at:this.now(),cancel_reason:reason});await this.cancelCommands(c,'request_id=$1',[r.id]);return;}
  const ins=await this.one(c,'instances',r.instance_id),d=await this.one(c,'devices',ins.device_id),deadline=this.after(30000);
  await this.move(c,'requests',r,reason==='no_output_timeout'?'no_output_timeout':reason==='fault'?'fault_unreleased':reason==='client_disconnected'?'client_disconnected':'drain_timeout',{cancel_deadline_at:deadline,cancel_reason:reason,persistence_deadline_at:new Date(Math.max(new Date(r.persistence_deadline_at).getTime(),deadline.getTime()+600000))},{dispatch_cancel_request:()=>this.uniqueCommand(c,d,'cancel_request',{reason,cancel_deadline_at:deadline},{session_id:r.session_id,instance_id:r.instance_id,request_id:r.id},30)});
 }
 private async beginStop(c:PoolClient,value:Row,cause:string){const s=await this.one(c,'sessions',value.id);if(terminalSession(s.state)||s.state==='stopping')return;
  const unstarted=await this.unstarted(c,s.id);
  const drain=this.after(30000),term=this.after(40000),kill=this.after(50000),event=cause==='user'?'user_stop':s.state==='starting'?'startup_failure':cause==='service_offline'?'service_timeout':cause==='service_failure'?'service_failure':'request_cleanup_failure';
  await this.move(c,'sessions',s,event,{stop_cause:cause,submissions_blocked:true,phase:'drain',phase_started_at:this.now(),phase_deadline_at:kill,drain_deadline_at:drain,term_deadline_at:term,stop_deadline_at:kill},{begin_session_stop:async()=>{
   await this.cancelCommands(c,"session_id=$1 AND kind IN ('prepare','start_service','start_helper','warmup')",[s.id]);
   const requests=(await c.query("SELECT * FROM requests WHERE session_id=$1 AND state NOT IN ('completed','failed','cancelled')",[s.id])).rows;
   for(const r of requests)if(cause!=='user')await this.failRequest(c,r,'service_failed',cause);else if(r.state==='pending')await this.cancel(c,r,'session_stop');
   const stopping=await this.one(c,'sessions',s.id);
   for(const ref of (await c.query("SELECT * FROM session_devices WHERE session_id=$1 AND role='service' AND released_at IS NULL",[s.id])).rows)await this.stopDevice(c,stopping,ref,unstarted);
   await this.stopHelpers(c,stopping,unstarted);
  }});
  for(const ins of unstarted)await this.releaseUnstarted(c,ins);
 }
 // The stop of device REF in the stopping session S, once per device (a stop of the session naming no instance of its
 // own), with the session's drain, TERM and KILL deadlines; nothing for a device with no instance left to stop.
 private async stopDevice(c:PoolClient,s:Row,ref:Row,unstarted:Row[]=[]){const d=await this.one(c,'devices',ref.device_id);
  if((await c.query("SELECT 1 FROM commands WHERE device_id=$1 AND session_id=$2 AND kind='stop' AND instance_id IS NULL",[d.id,s.id])).rowCount)return;
  const ids=(await c.query('SELECT id FROM instances WHERE session_id=$1 AND device_id=$2 AND stopped_at IS NULL',[s.id,d.id])).rows.map(i=>i.id).filter(id=>!unstarted.some(u=>u.id===id));
  if(ids.length)await this.command(c,d,'stop',{instance_ids:ids,drain_deadline_at:s.drain_deadline_at,term_deadline_at:s.term_deadline_at,kill_deadline_at:s.stop_deadline_at,reason:s.stop_cause},{session_id:s.id},Math.max(0,new Date(s.stop_deadline_at).getTime()-this.now().getTime())/1000);
 }
 // The helpers of the stopping session S are told last: once no request of it runs on the serving engine, or at the drain
 // deadline, so they serve what drains.
 private async stopHelpers(c:PoolClient,s:Row,unstarted:Row[]=[]){
  if(!this.expired(s.drain_deadline_at)&&(await c.query("SELECT 1 FROM requests WHERE session_id=$1 AND state IN ('running','cancelling')",[s.id])).rowCount)return;
  for(const ref of (await c.query("SELECT * FROM session_devices WHERE session_id=$1 AND role='helper' AND released_at IS NULL",[s.id])).rows)await this.stopDevice(c,s,ref,unstarted);
 }
 // The instances of session SID whose engine provably never ran: still starting, no live process reported, and no
 // command of theirs sent but a prepare the
 // device answered. A sent command without the device's result (the control plane timed it out or cancelled it), and
 // any sent start, need the device's stop.
 private async unstarted(c:PoolClient,sid:string){return (await c.query(`SELECT * FROM instances i WHERE session_id=$1 AND stopped_at IS NULL AND state='starting'
  AND NOT jsonb_path_exists(i.processes,'$[*] ? (@.alive == true)')
  AND NOT EXISTS (SELECT 1 FROM commands m WHERE (m.instance_id=i.id OR m.payload->'instance_ids' @> to_jsonb(ARRAY[i.id::text])) AND m.first_sent_at IS NOT NULL
   AND NOT coalesce(m.kind='prepare' AND m.result IS NOT NULL,false))`,[sid])).rows;}
 // Stops such an instance through its report `stopped` (handle_instance_stopped: finishStop releases its device).
 private async releaseUnstarted(c:PoolClient,ins:Row){const d=await this.one(c,'devices',ins.device_id),context={reportedState:'stopped',bootChanged:false};
  const handlers=Object.fromEntries(transition('instances',ins.state,'report',context).effects.map(effect=>[effect,(row:Row)=>effect==='handle_instance_stopped'?this.instanceStopped(c,d,row):undefined]));
  await this.move(c,'instances',ins,'report',{processes:[],http_healthy:false,push_listening:false,stopped_at:this.now()},handlers,context);
 }
 async stopSession(user:User,sid:string){await this.tx(async c=>this.beginStop(c,await this.one(c,'sessions',sid,user.group_id),'user'));await this.dispatch();return this.getSession(user,sid);}
 // A device's reservation for a session is released only with an inventory probed after the end of each of its
 // instances there (the first sequence after its terminal commit, in the boot that reported it): the memory the next
 // preflight reads is the one the engines left. An instance report says the processes exited; it does not free the
 // device by itself (Control plane: device).
 private async inventoryBehind(c:PoolClient,d:Row,sid:string){const cur=await this.one(c,'devices',d.id);
  return (await c.query('SELECT 1 FROM instances WHERE session_id=$1 AND device_id=$2 AND inventory_after_boot=$3 AND inventory_after>$4',[sid,d.id,cur.agent_boot_id,cur.inventory.sequence??0])).rowCount!==0;}
 // INVENTORY, sent by the device's boot BOOT, replaces D's only when it is newer: another boot, or a later probe.
 private async adoptInventory(c:PoolClient,d:Row,inventory:Row,boot:string,extra:Row={}){
  const newer=d.agent_boot_id!==boot||!(Number(d.inventory.sequence)>=inventory.sequence),kept=newer?inventory:d.inventory;
  const addressChanged=!isDeepStrictEqual(d.inventory.addresses,kept.addresses)||!isDeepStrictEqual(d.inventory.python_executables,kept.python_executables);
  await update(c,'devices',d.id,{inventory:kept,agent_boot_id:boot,address_revision:addressChanged?(BigInt(d.address_revision)+1n).toString():d.address_revision,...extra});
 }
 // Each session D is still reserved for whose stop is done may release it now (finishStop).
 private async releaseSettled(c:PoolClient,d:Row){for(const ref of (await c.query('SELECT DISTINCT session_id FROM session_devices WHERE device_id=$1 AND released_at IS NULL',[d.id])).rows)await this.finishStop(c,await this.one(c,'sessions',ref.session_id));}
 private async releaseDevice(c:PoolClient,d:Row,sid:string){
  if(await this.inventoryBehind(c,d,sid))return;
  const release=async()=>{const result=await c.query("UPDATE session_devices SET released_at=$3,release_reason='confirmed_stopped' WHERE session_id=$1 AND device_id=$2 AND released_at IS NULL",[sid,d.id,this.now()]);if(result.rowCount)markChanged(c,'sessions',{id:sid,group_id:d.group_id});};
  if(d.state==='removed'||d.error?.code==='port_busy')return;
  if(d.state==='offline'){await release();await update(c,'devices',d.id,{cleanup_required:false,error:null});}
  else if(d.state==='idle')await release();
  else await this.move(c,'devices',d,'instances_stopped',{cleanup_required:false,error:null},{release_device_reservations:release});
 }
 private async finishStop(c:PoolClient,value:Row,timeout=false){const s=await this.one(c,'sessions',value.id);if(s.state!=='stopping'&&!terminalSession(s.state))return;
  const refs=(await c.query('SELECT * FROM session_devices WHERE session_id=$1 AND released_at IS NULL',[s.id])).rows;
  const liveRefs:Row[]=[];
  for(const ref of refs){const live=(await c.query('SELECT 1 FROM instances WHERE session_id=$1 AND device_id=$2 AND stopped_at IS NULL',[s.id,ref.device_id])).rowCount;
   const d=await this.one(c,'devices',ref.device_id);if(!live&&d.error?.code!=='port_busy')await this.releaseDevice(c,d,s.id);else liveRefs.push(d);
  }
  if(s.state==='stopping'&&(!liveRefs.length||timeout)){
   const active=(await c.query("SELECT * FROM requests WHERE session_id=$1 AND state NOT IN ('completed','failed','cancelled')",[s.id])).rows;
   for(const r of active)await this.failRequest(c,r,'service_failed','stop_timeout');
   const effect=timeout?'mark_uncleared_devices':'release_confirmed_devices';
   await this.move(c,'sessions',s,timeout?'stop_timeout':'all_instances_stopped',{ended_at:this.now(),session_key:null,submissions_blocked:true},{[effect]:async()=>{
    if(timeout)for(const d of liveRefs)await this.requireCleanup(c,d,err('cleanup_required',d.id,'kill'));
    else for(const ref of refs)await this.releaseDevice(c,await this.one(c,'devices',ref.device_id),s.id);
   }},{stopCause:s.stop_cause});
  }
 }
 private async requireCleanup(c:PoolClient,d:Row,error:Row){if(d.state==='removed')return;if(d.error?.code==='port_busy')error=d.error;
  const event='cleanup_needed',effects=transition('devices',d.state,event).effects;
  await this.move(c,'devices',d,event,{cleanup_required:true,error},Object.fromEntries(effects.map(effect=>[effect,()=>this.queueDeviceCleanup(c,d)])));
 }
 private async queueDeviceCleanup(c:PoolClient,d:Row){if(d.state==='offline'||!d.reconciled_at)return;const instances=(await c.query('SELECT * FROM instances WHERE device_id=$1 AND stopped_at IS NULL',[d.id])).rows;
  for(const ins of instances)await this.cleanupInstance(c,d,ins,'cleanup_required');
 }
 private async cleanupInstance(c:PoolClient,d:Row,ins:Row,reason:string){
  // A failed cleanup needs an explicit retry; periodic reports must not create
  // an unbounded chain of stop commands. Fresh late activity still needs cleanup.
  if(!['manual_reconnect','recheck_requested','late_activity','late_result'].includes(reason)){
   const failed=(await c.query("SELECT * FROM commands WHERE device_id=$1 AND kind='stop' AND state='failed' AND (instance_id=$2 OR payload->'instance_ids' @> to_jsonb(ARRAY[$2::text])) ORDER BY created_at DESC LIMIT 1",[d.id,ins.id])).rows[0];
   if(failed)return failed;
  }
  return this.uniqueCommand(c,d,'stop',{instance_ids:[ins.id],drain_deadline_at:this.now(),term_deadline_at:this.after(10000),kill_deadline_at:this.after(20000),reason},{session_id:ins.session_id,instance_id:ins.id},20);}
 async reconnectHelper(user:User,sid:string,deviceId:string){await this.tx(async c=>{
  const s=await this.one(c,'sessions',sid,user.group_id);if(s.state!=='degraded')throw new Fault('session_not_ready',409,null,{device_id:deviceId,phase:'connect',message:'Manual helper reconnection requires a degraded session.'});
  const ref=(await c.query("SELECT * FROM session_devices WHERE session_id=$1 AND device_id=$2 AND role='helper' AND released_at IS NULL",[sid,deviceId])).rows[0];if(!ref)throw new Fault('forbidden',403,null,{device_id:deviceId,phase:'connect'});
  const d=await this.one(c,'devices',deviceId);if(!['occupied','cleanup_required'].includes(d.state)||!d.reconciled_at)throw new Fault('device_busy',409,null,{device_id:d.id,phase:'connect',message:'The helper must reconnect and reconcile before it can replace its old instance.'});
  const old=(await c.query('SELECT * FROM instances WHERE session_id=$1 AND device_id=$2 ORDER BY generation DESC LIMIT 1',[sid,deviceId])).rows[0];
  const t=await this.one(c,'connection_tests',s.config.plan.helpers.find((h:Row)=>h.device_id===deviceId).connection_test_id),target=await this.one(c,'devices',t.target_device_id);
  if(!this.pathValid(t,d,target)||t.source_device_id!==deviceId||!t.listener_closed_at)throw new Fault('direction_unreachable',409,null,{device_id:d.id,phase:'connect'});
  await this.move(c,'sessions',s,'helper_reconnect_requested',{error:null},{begin_helper_reconnect:async()=>{
   if(!old.stopped_at){await this.cancelCommands(c,"instance_id=$1 AND kind IN ('prepare','start_helper')",[old.id]);const stop=await this.cleanupInstance(c,d,old,'manual_reconnect');if(stop.payload.reason!=='manual_reconnect')await update(c,'commands',stop.id,{payload:{...stop.payload,reason:'manual_reconnect'}});}
   else await this.startReplacement(c,s,d,old);
  }});
 });await this.dispatch();return this.getSession(user,sid);}
 private async startReplacement(c:PoolClient,s:Row,d:Row,old:Row){
  if(d.error?.code==='port_busy')throw new Fault('device_busy',409,null,{device_id:d.id,phase:'reconcile'});
  const newer=(await c.query('SELECT 1 FROM instances WHERE session_id=$1 AND device_id=$2 AND generation>$3',[s.id,d.id,old.generation])).rowCount;if(newer)return;
  await this.prepareInstance(c,s,d,old.spec.ordinal,old.generation+1);
  if(d.state==='cleanup_required')await this.move(c,'devices',d,'reconciled',{cleanup_required:false,error:null}, {},{reserved:true,cleanup:false});else await update(c,'devices',d.id,{cleanup_required:false,error:null});await this.refreshPhase(c,s.id,'prepare');
 }
 async recheckDevice(user:User,did:string){const cmd=await this.tx(async c=>{const d=await this.one(c,'devices',did,user.group_id);if(d.state!=='cleanup_required'||!d.reconciled_at)throw new Fault('device_busy',409,null,{device_id:d.id,phase:'reconcile',message:'Recheck requires a connected, reconciled device with outstanding cleanup.'});
  // A device held for a taken port (port_busy) keeps naming the instances of the sessions it is still reserved for,
  // stopped_at or not, until a recheck of their ports passes: a stopped instance's port is what is being rechecked.
  const instances=(await c.query(`SELECT i.id FROM instances i WHERE i.device_id=$1 AND (i.stopped_at IS NULL OR ($2::boolean AND EXISTS (SELECT 1 FROM session_devices sd WHERE sd.session_id=i.session_id AND sd.device_id=i.device_id AND sd.released_at IS NULL))) ORDER BY i.created_at,i.id`,[did,d.error?.code==='port_busy'])).rows;return this.uniqueCommand(c,d,'recheck',{instance_ids:instances.map(i=>i.id)});});await this.dispatch();return {command_id:cmd.id,device_id:did};}
 async removeDevice(user:User,did:string,confirmUnavailable:boolean){if(confirmUnavailable!==true)throw new Fault('invalid_input',400,'confirm_unavailable',{device_id:did,phase:'reconcile'});await this.tx(async c=>{
  const d=await this.one(c,'devices',did,user.group_id);if(d.state!=='offline'||!d.cleanup_required)throw new Fault('device_busy',409,null,{device_id:d.id,phase:'reconcile',message:'Only an offline device with unresolved cleanup can be permanently removed; confirm that it is unavailable.'});
  await this.move(c,'devices',d,'remove',{removed_at:this.now(),credential_hash:null,control_connection_id:null},{finalize_removed_device:async()=>{
   const refs=(await c.query('SELECT * FROM session_devices WHERE device_id=$1 AND released_at IS NULL',[did])).rows;
   for(const ref of refs){const s=await this.one(c,'sessions',ref.session_id);if(!terminalSession(s.state)){if(ref.role==='service'||s.state==='starting')await this.beginStop(c,s,'service_failure');else if(s.state==='ready')await this.move(c,'sessions',s,'helper_disconnected');}await c.query("UPDATE session_devices SET released_at=$3,release_reason='device_removed' WHERE session_id=$1 AND device_id=$2",[s.id,did,this.now()]);markChanged(c,'sessions',{id:s.id,group_id:s.group_id});}
  }},{confirmUnavailable:true});
 });this.connections.delete(did);return this.getDevice(user,did);}
 private async instanceFailed(c:PoolClient,d:Row,ins:Row,error:Row){
  const s=await this.one(c,'sessions',ins.session_id),service=ins.spec.role==='target';
  if(s.state==='starting'||service)await this.beginStop(c,s,s.state==='starting'?'startup_failure':'service_failure');
  else if(s.state==='ready')await this.move(c,'sessions',s,'helper_disconnected',{error});
  else if(s.state==='degraded')await this.move(c,'sessions',s,'helper_reconnect_failed',{error,phase:'serve',phase_deadline_at:null});
  await this.requireCleanup(c,await this.one(c,'devices',d.id),error);
  await this.cleanupInstance(c,d,ins,'instance_failed');
 }
 private async instanceStopped(c:PoolClient,d:Row,ins:Row){
  const s=await this.one(c,'sessions',ins.session_id);
  if(s.state==='stopping'||terminalSession(s.state)){await this.finishStop(c,s);return;}
  if(s.state==='starting'||ins.spec.role==='target'){await this.beginStop(c,s,s.state==='starting'?'startup_failure':'service_failure');return;}
  if(s.state==='ready')await this.move(c,'sessions',s,'helper_disconnected');
 }
 private async status(c:PoolClient,d:Row,p:Row,inspection=false){
  const ins=await this.one(c,'instances',p.instance_id,d.group_id);
  if(ins.device_id!==d.id||ins.session_id!==p.session_id||ins.generation!==p.generation||p.config_sha256!==ins.config_sha256.toString('hex'))throw new Fault('instance_mismatch',409,null,{device_id:d.id,phase:p.phase});
  const currentDevice=await this.one(c,'devices',d.id,d.group_id);if(p.agent_boot_id!==currentDevice.agent_boot_id)throw new Fault('instance_mismatch',409,null,{device_id:d.id,phase:p.phase});
  const session=await this.one(c,'sessions',ins.session_id);
  if(p.state==='stopped'&&(p.processes.some((x:Row)=>x.alive)||p.http_healthy||p.push_listening))throw new Fault('invalid_input',400,'processes',{device_id:d.id,phase:p.phase});
  if(terminalSession(session.state)&&p.state!=='stopped'){
   await this.move(c,'sessions',session,'late_activity',{}, {dispatch_late_cleanup:()=>this.cleanupInstance(c,d,ins,'late_activity')});return;
  }
  if(ins.stopped_at){if(p.state!=='stopped')await this.move(c,'instances',ins,'late_activity',{}, {dispatch_late_cleanup:()=>this.cleanupInstance(c,d,ins,'late_activity')});return;}
  const bootChanged=ins.agent_boot_id!==currentDevice.agent_boot_id;
  let reportedState=p.state;
  // A recheck reports what exists; it is not permission to revive a failed instance.
  if(['failed','cleanup_required'].includes(ins.state)&&!['stopped','stopping',ins.state].includes(reportedState))reportedState=ins.state;
  if(inspection&&!['stopped','stopping'].includes(p.state))reportedState=['failed','cleanup_required'].includes(ins.state)?ins.state:'cleanup_required';
  const order=['starting','loading','connectable','ready','stopping','stopped'];
  if(!bootChanged&&!inspection&&order.indexOf(reportedState)>=0&&order.indexOf(reportedState)<order.indexOf(ins.state))return;
  if(!bootChanged&&!inspection&&['connectable','ready'].includes(reportedState)&&ins.spec.role==='target'&&(!p.http_healthy||session.config.plan.helpers.length>0&&!p.push_listening||!p.calibrated))throw new Fault('invalid_input',400,'http_healthy',{device_id:d.id,phase:p.phase});
  const context={reportedState,bootChanged};let next;
  try{next=transition('instances',ins.state,'report',context);}catch(error){
   if(error instanceof Error&&error.message.startsWith('Illegal instances transition:'))throw new Fault('invalid_input',400,'state',{device_id:d.id,phase:p.phase,message:'This instance report is incompatible with its recorded lifecycle; reconcile the current instance state.'});
   throw error;
  }
  // an instance's own report says how far its own start got; whether a helper is connected only the serving machine says (peer.status)
  const patch:Row={phase:p.phase,processes:p.processes,metrics:p.metrics,http_healthy:p.http_healthy,push_listening:p.push_listening,calibrated:p.calibrated,stopped_at:next.state==='stopped'?this.now():null,error:p.error,
   ...(next.state==='stopped'&&p.inventory_after!==null?{inventory_after:p.inventory_after,inventory_after_boot:p.agent_boot_id}:{})};
  if(bootChanged&&p.state!=='stopped')patch.error=err('cleanup_required',d.id,p.phase,'The device agent restarted while its previous instance is still alive; stop that instance before reuse.');
  const handlers:Record<string,(row:Row)=>Promise<unknown>>={};
  for(const effect of next.effects)handlers[effect]=row=>effect==='handle_instance_failure'?this.instanceFailed(c,currentDevice,row,patch.error??err('cleanup_required',d.id,p.phase)):this.instanceStopped(c,currentDevice,row);
  await this.move(c,'instances',ins,'report',patch,handlers,context);
  await this.advance(c,session.id);
 }
 private async conflict(c:PoolClient,d:Row,refs:Row){
  if(refs.connection_test_id)await this.failTest(c,await this.one(c,'connection_tests',refs.connection_test_id),'chunk_conflict');
  if(refs.request_id){const request=await this.one(c,'requests',refs.request_id);if(!terminalRequest(request.state))await this.failRequest(c,request,'protocol_conflict','chunk_conflict');else if(!request.engine_released_at)await this.beginStop(c,{id:request.session_id},'reconcile_failure');}
  else if(refs.session_id){const session=await this.one(c,'sessions',refs.session_id);if(session.state==='starting')await this.beginStop(c,session,'startup_failure');else if(refs.instance_id)await this.cleanupReconnect(c,refs);}
  const fault=new Fault('chunk_conflict',409,null,{device_id:d.id,phase:refs.phase??'reconcile'}),conflicts=this.reconcileConflicts.get(c);
  if(conflicts)conflicts.push(fault);else this.afterCommit(c,()=>{throw fault;});
 }
 private async result(c:PoolClient,d:Row,p:Row){
  const cmd=await this.one(c,'commands',p.command_id,d.group_id);if(cmd.device_id!==d.id)throw new Fault('forbidden',403);
  const originalResult=p.result;p={...p,result:parseCommandResult(cmd.kind,p.outcome,p.result===null&&p.outcome!=='completed'?{}:p.result)};const persisted={...p,result:originalResult===null?null:p.result};
  if(p.outcome==='failed'&&!p.error)throw new Fault('invalid_input',400,'error');
  if(cmd.request_id&&p.result.request_id!==undefined&&p.result.request_id!==cmd.request_id||cmd.connection_test_id&&p.result.test_id!==undefined&&p.result.test_id!==cmd.connection_test_id)throw new Fault('invalid_input');
  if(cmd.result){if(!isDeepStrictEqual(cmd.result,persisted))await this.conflict(c,d,cmd);return;}
  if(terminalCommand(cmd.state)){
   await this.move(c,'commands',cmd,'late_result',{}, {dispatch_late_cleanup:async()=>{if(cmd.session_id&&['prepare','start_service','start_helper','warmup'].includes(cmd.kind)&&cmd.instance_id)await this.cleanupInstance(c,d,await this.one(c,'instances',cmd.instance_id),'late_result');}});return;
  }
  const version=cmd.payload.version,mismatched=p.outcome==='completed'&&cmd.kind==='prepare'?[...(p.result.manifest_sha256!==version.manifest_sha256?['manifest_sha256']:[]),...(p.result.prepared_version_id!==version.id?['prepared_version_id']:[]),...(version.build_requirements?buildDifferences(version.build_requirements,p.result.build).map(x=>`build.${x}`):['build'])]:[];
  const mismatch=mismatched.length>0;
  const event=mismatch?'fail':p.outcome==='completed'?'complete':p.outcome==='failed'?'fail':'cancel';
  const failure=mismatch?err('build_mismatch',d.id,'build',`The reported ${mismatched.join(', ')} does not meet what version ${version.id} requires; prepare the required files and build again.`):p.error;
  await this.move(c,'commands',cmd,event,{result:persisted,finished_at:this.now()},{handle_command_result:()=>this.commandResult(c,d,cmd,p,mismatch,failure)});
 }
 // The instance reports a command result carries that the device's current boot made. A result the device recorded
 // before it restarted comes back in its next reconcile as command history: the reconcile's own reports already say
 // what the new boot sees, so the old ones are not applied again.
 private async thisBoot(c:PoolClient,d:Row,reports:Row[]){const boot=(await this.one(c,'devices',d.id)).agent_boot_id;return reports.filter(r=>r.agent_boot_id===boot);}
 private async commandResult(c:PoolClient,d:Row,cmd:Row,p:Row,mismatch=false,failure:Row|null=null){
  if(cmd.kind==='stop'||cmd.kind==='recheck'){
   if(p.outcome!=='completed'){
    if(cmd.kind==='recheck'){const current=await this.one(c,'devices',d.id),patch={error:current.error?.code==='port_busy'?current.error:failure??err('deadline_exceeded',d.id,'reconcile')};
     if(current.state==='cleanup_required')await this.move(c,'devices',current,'recheck_timeout',patch);else await update(c,'devices',d.id,{...patch,cleanup_required:true});
    }else await this.stopFailed(c,d,cmd,failure??err('cleanup_required',d.id,'kill'));
    return;
   }
   const expected=cmd.payload.instance_ids,actual=p.result.instances.map((i:Row)=>i.instance_id);
   if(new Set(actual).size!==actual.length||actual.length!==expected.length||actual.some((value:string)=>!expected.includes(value)))throw new Fault('invalid_input');
   if(cmd.kind==='stop'&&(!p.result.ports_free||p.result.instances.some((i:Row)=>i.state!=='stopped')))throw new Fault('invalid_input');
   if(cmd.kind==='recheck'&&(!p.result.ports_free||p.result.instances.some((i:Row)=>i.state!=='stopped'))){
    const device=await this.one(c,'devices',d.id),cause=p.error??p.result.instances.find((i:Row)=>i.error)?.error;
    const error=!p.result.ports_free?err('port_busy',d.id,'reconcile',cause?.message??'The recheck found a port still occupied; free the recorded listener and recheck before reusing this device.'):cause??err('cleanup_required',d.id,'reconcile');
    if(device.state==='cleanup_required')await this.move(c,'devices',device,'recheck_residual',{error,cleanup_required:true});else await update(c,'devices',device.id,{error,cleanup_required:true});
    for(const report of await this.thisBoot(c,d,p.result.instances)){await this.status(c,d,report,true);if(report.state!=='stopped')await this.cleanupInstance(c,d,await this.one(c,'instances',report.instance_id),'recheck_requested');}
    return;
   }
   // History acknowledges, the current boot decides: a result whose reports name an earlier boot of the device only
   // completes its command; clearing the cleanup, releasing the device or starting a replacement waits for this boot's.
   const current=await this.thisBoot(c,d,p.result.instances);if(current.length<p.result.instances.length)return;
   // the inventory the device probed after the stop's END goes in with the result that may release it
   if(p.result.inventory)await this.adoptInventory(c,await this.one(c,'devices',d.id),p.result.inventory,(await this.one(c,'devices',d.id)).agent_boot_id);
   await update(c,'devices',d.id,{error:null});
   for(const report of current)await this.status(c,d,report);
   if(cmd.kind==='stop'&&cmd.payload.reason==='manual_reconnect'){const session=await this.one(c,'sessions',cmd.session_id);if(session.state==='degraded')for(const report of p.result.instances)await this.startReplacement(c,session,await this.one(c,'devices',d.id),await this.one(c,'instances',report.instance_id));}
   const sessions=(await c.query('SELECT DISTINCT session_id FROM session_devices WHERE device_id=$1 AND released_at IS NULL',[d.id])).rows;
   for(const ref of sessions)await this.finishStop(c,await this.one(c,'sessions',ref.session_id));
   const device=await this.one(c,'devices',d.id);
   if(cmd.kind==='recheck'&&device.state==='cleanup_required')await this.move(c,'devices',device,'recheck_clear',{cleanup_required:false,error:null},{release_device_reservations:async()=>{for(const ref of sessions){const session=await this.one(c,'sessions',ref.session_id);if(terminalSession(session.state))await this.releaseDevice(c,await this.one(c,'devices',d.id),session.id);}}});
  }else if(['listen_test','connect_test','close_test'].includes(cmd.kind)){
   const test=await this.one(c,'connection_tests',cmd.connection_test_id);
   if(p.outcome!=='completed')await this.failTest(c,test,failure?.code??'direction_unreachable',failure??undefined);
   else if(cmd.kind==='close_test'&&p.result.listener_closed){await this.move(c,'connection_tests',test,'cleanup_confirmed',{listener_closed_at:this.now()});await c.query("UPDATE commands SET payload=payload-'nonce' WHERE connection_test_id=$1",[cmd.connection_test_id]);}
  }else if(cmd.kind==='cancel_request'){
   if(p.outcome==='completed'&&p.result.released){const request=await this.one(c,'requests',cmd.request_id);if(request.state==='cancelling')await this.move(c,'requests',request,'cancel_released',{ended_at:this.now(),engine_released_at:this.now()},{},{cancelReason:request.cancel_reason});}
  }else if(cmd.session_id){const session=await this.one(c,'sessions',cmd.session_id);
   if(p.outcome!=='completed'||mismatch){
    if(cmd.kind!=='run_request')await update(c,'sessions',session.id,{error:failure??err('startup_failure',d.id,cmd.phase)});
    if(cmd.kind==='run_request'){const request=await this.one(c,'requests',cmd.request_id);await update(c,'requests',request.id,{error:failure??err('http_error',d.id,'serve')});await this.cancel(c,request,'fault');}
    else if(session.state==='starting')await this.beginStop(c,session,'startup_failure');else if(session.state==='degraded')await this.cleanupReconnect(c,cmd,failure??err('startup_failure',d.id,cmd.phase));
   }else if(cmd.kind==='warmup'&&session.state==='starting'){
    if(p.result.resource_sha256!==session.config.warmup?.sha256)throw new Fault('invalid_input');
    await this.advance(c,session.id);
   }else if(cmd.kind.startsWith('start_')){
    // the connect phase (the instance's deadline, the session's) first, then the report, which may advance the session: a
    // recovery that this report completes is not reopened after it
    const instance=await this.one(c,'instances',cmd.instance_id);
    if(!instance.stopped_at&&!['failed','cleanup_required'].includes(instance.state))await update(c,'instances',instance.id,{phase:'connect',phase_deadline_at:this.after(1800000),phase_started_at:this.now()});
    await this.refreshPhase(c,session.id,'connect');
    for(const report of await this.thisBoot(c,d,[p.result.instance]))await this.status(c,d,report);
   }else if(cmd.kind==='prepare')await this.advance(c,session.id);
  }
 }
 private async stopFailed(c:PoolClient,d:Row,cmd:Row,error:Row){
  await this.requireCleanup(c,await this.one(c,'devices',d.id),error);
  if(cmd.session_id){const session=await this.one(c,'sessions',cmd.session_id);if(session.state==='degraded')await this.move(c,'sessions',session,'helper_reconnect_failed',{error,phase:'serve',phase_deadline_at:null});}
 }
 private async cleanupReconnect(c:PoolClient,cmd:Row,diagnostic:Row|string='reconnect_failed'){
  if(!cmd.instance_id)return;const ins=await this.one(c,'instances',cmd.instance_id);if(ins.stopped_at)return;
  const d=await this.one(c,'devices',ins.device_id),error=typeof diagnostic==='string'?err(diagnostic,d.id,ins.phase,diagnostic==='deadline_exceeded'?'The replacement helper did not finish this phase before its deadline.':'The replacement helper could not complete startup; inspect the instance diagnostics before retrying.'):diagnostic;
  if(!['failed','cleanup_required'].includes(ins.state))await this.move(c,'instances',ins,'report',{error},{handle_instance_failure:row=>this.instanceFailed(c,d,row,error)},{reportedState:'failed'});
  else {await update(c,'instances',ins.id,{error});await this.instanceFailed(c,d,ins,error);}
 }
 private async requestOwner(c:PoolClient,d:Row,p:Row){const r=await this.one(c,'requests',p.request_id,d.group_id);const ins=await this.one(c,'instances',r.instance_id);if(ins.device_id!==d.id||r.instance_id!==p.instance_id)throw new Fault('instance_mismatch',409);return r;}
 private async chunk(c:PoolClient,d:Row,p:Row,messageId:string){const request=await this.requestOwner(c,d,p);
  if(terminalRequest(request.state)){await this.move(c,'requests',request,'late_data',{}, {handle_late_request_data:()=>this.afterCommit(c,()=>this.confirmRequest(d.id,request.id,messageId))});return;}
  const old=(await c.query('SELECT * FROM output_chunks WHERE request_id=$1 AND seq=$2',[request.id,p.seq])).rows[0];
  if(old){if(old.text!==p.text||old.token_count!==p.token_count||old.segment!==p.segment){await this.conflict(c,d,{request_id:request.id});return;}
   await this.move(c,'requests',request,'duplicate_chunk',{}, {confirm_existing_chunk:()=>this.ackChunk(c,d,request,p,messageId)});return;
  }
  if(request.final_seq!==null&&BigInt(p.seq)>BigInt(request.final_seq)){await this.conflict(c,d,{request_id:request.id});return;}
  const gap=BigInt(p.seq)>BigInt(request.contiguous_seq)+1n;
  await this.move(c,'requests',request,gap?'gap_chunk':'new_chunk',{}, {[gap?'process_gap_chunk':'process_output_chunk']:async()=>{
   await this.persistChunk(c,d,request,p);await this.ackChunk(c,d,await this.one(c,'requests',request.id),p,messageId);
  }});
 }
 private async ackChunk(c:PoolClient,d:Row,r:Row,p:Row,messageId:string){this.afterCommit(c,()=>{
  const conn=this.connections.get(d.id);if(!conn?.ready)return;
  conn.send('output.recorded',{reply_to:messageId,request_id:r.id,seq:p.seq,contiguous_seq:r.contiguous_seq});
  if(BigInt(p.seq)>BigInt(r.contiguous_seq)+1n)conn.send('output.replay',{request_id:r.id,instance_id:r.instance_id,after_seq:r.contiguous_seq,through_seq:r.final_seq});
 });}
 private async persistChunk(c:PoolClient,d:Row,r:Row,p:Row){
  const {instance_id,...payload}=p;await insert(c,'output_chunks',{group_id:r.group_id,...payload,received_at:this.now()});
  const chunks=(await c.query('SELECT * FROM output_chunks WHERE request_id=$1 AND seq>$2 ORDER BY seq',[r.id,r.contiguous_seq])).rows;
  let sequence=BigInt(r.contiguous_seq),tokens=BigInt(r.output_tokens),position=r.committed_position===null?null:BigInt(r.committed_position),timing={...r.timing};
  for(const ch of chunks){if(BigInt(ch.seq)!==sequence+1n)break;
   if(position!==null&&BigInt(ch.committed_position)!==position+BigInt(ch.token_count)){await this.conflict(c,d,{request_id:r.id});return;}
   sequence++;tokens+=BigInt(ch.token_count);position=BigInt(ch.committed_position);
   if(!r.engine_end)timing={...timing,engine_first_output_ns:timing.engine_first_output_ns??ch.engine_first_output_ns,engine_last_output_ns:ch.engine_last_output_ns??timing.engine_last_output_ns,engine_first_chunk_tokens:timing.engine_first_chunk_tokens??ch.engine_first_chunk_tokens};
  }
  if(sequence>BigInt(r.contiguous_seq)){
   const changed:Row={contiguous_seq:sequence.toString(),output_tokens:tokens.toString(),committed_position:position?.toString(),timing};
   if(r.state!=='cancelling'){changed.no_output_deadline_at=this.after(600000);if(!r.engine_end)changed.persistence_deadline_at=this.after(600000);}
   await update(c,'requests',r.id,changed);
   if(r.state==='recovering'&&r.final_seq===sequence.toString())this.afterCommit(c,()=>this.archivePending());
   if(!r.engine_end&&r.state!=='cancelling')await c.query("UPDATE commands SET deadline_at=$2,phase_deadline_at=$2 WHERE request_id=$1 AND kind='run_request' AND state NOT IN ('completed','failed','cancelled')",[r.id,this.after(600000)]);
  }
 }
 private async end(c:PoolClient,d:Row,p:Row){const r=await this.requestOwner(c,d,p);
  if(r.engine_end){if(!isDeepStrictEqual(r.engine_end,p))await this.conflict(c,d,{request_id:r.id});return;}
  if(terminalRequest(r.state)){
   await this.move(c,'requests',r,'late_data',{engine_end:p,engine_released_at:p.released?r.engine_released_at??this.now():r.engine_released_at},{handle_late_request_data:()=>this.afterCommit(c,()=>this.confirmRequest(d.id,r.id,randomUUID()))});return;
  }
  if(BigInt(p.final_seq)<BigInt(r.contiguous_seq)||p.outcome==='completed'&&!p.released){await this.conflict(c,d,{request_id:r.id});return;}
  const now=this.now(),patch:Row={engine_end:p,final_seq:p.final_seq,timing:p.timing,statistics:p.statistics,error:r.cancel_reason==='fault'?r.error??p.error:p.error};
  if(!p.released){await update(c,'requests',r.id,patch);await this.cancel(c,r,'fault');return;}
  patch.engine_released_at=now;
  if(r.state!=='cancelling'&&!this.expired(r.persistence_deadline_at))patch.persistence_deadline_at=this.after(600000);
  if(this.expired(r.persistence_deadline_at)&&r.state!=='cancelling'){
   await update(c,'requests',r.id,patch);await this.failRequest(c,r,'service_failed','persistence_failed');return;
  }
  const event=r.state==='cancelling'?'cancel_released':p.outcome==='completed'?'end_completed':p.outcome==='failed'?'end_failed':'end_cancelled';
  if(event!=='end_completed')patch.ended_at=now;
  await this.move(c,'requests',r,event,patch,event==='end_completed'?{archive_if_complete:()=>this.afterCommit(c,()=>this.archivePending())}:{},{cancelReason:r.cancel_reason});
  const commands=(await c.query("SELECT * FROM commands WHERE request_id=$1 AND kind='run_request' AND state NOT IN ('completed','failed','cancelled')",[r.id])).rows;
  for(const cmd of commands)await this.move(c,'commands',cmd,'complete_internal',{finished_at:now});
 }
 async handleDevice(deviceId:string,connectionId:string,type:string,payload:unknown,messageId:string=randomUUID()){
  const schema=messages[type];if(!schema)throw new Fault('invalid_input');let p=parse(schema,payload) as Row;
  // Apply every persisted wall-clock deadline before accepting evidence that could
  // otherwise extend or revive the expired operation.
  await this.sweep();
  const outgoing: {type:string,payload:Row}[]=[],conflicts:Fault[]=[];
  await this.tx(async c=>{const d=await this.one(c,'devices',deviceId);const conn=this.connections.get(deviceId);if(d.state==='removed'||d.control_connection_id!==connectionId||conn?.id!==connectionId)throw new Fault('credential_revoked',401);if(d.state==='offline'&&type!=='reconcile'||!conn.ready&&type!=='reconcile'||conn.ready&&type==='reconcile')throw new Fault('reconcile_failed',409);
   if(type==='reconcile')this.reconcileConflicts.set(c,conflicts);
   if(type!=='output.chunk'&&type!=='request.accepted'){const keys=(await c.query("SELECT encode(session_key,'base64') AS key FROM sessions WHERE group_id=$1 AND session_key IS NOT NULL",[d.group_id])).rows.map(x=>Buffer.from(x.key,'base64').toString('base64url'));p=sanitizeDiagnostic(p,keys);}
   if(type==='reconcile'||type==='heartbeat'){
    if(type==='heartbeat'&&d.agent_boot_id!==p.agent_boot_id)throw new Fault('reconcile_failed',409);
    await this.adoptInventory(c,d,p.inventory,p.agent_boot_id,{last_heartbeat_at:this.now(),heartbeat_deadline_at:this.after(30000),reconciled_at:this.now()});
    for(const report of p.instances)await this.status(c,d,report);
    if(type==='reconcile'){
     // The snapshot must account for every instance known to the server.
     const instances=(await c.query('SELECT * FROM instances WHERE device_id=$1 AND stopped_at IS NULL',[d.id])).rows;
     for(const ins of instances)if(!p.instances.some((r:Row)=>r.instance_id===ins.id)){
      const started=(await c.query("SELECT 1 FROM commands WHERE instance_id=$1 AND kind IN ('start_service','start_helper') AND first_sent_at IS NOT NULL",[ins.id])).rowCount;
      if(started){
       if(['failed','cleanup_required'].includes(ins.state))await this.cleanupInstance(c,d,ins,'cleanup_required');
       else {const error=err('reconcile_failed',d.id,'reconcile','The device no longer has the execution record for its assigned instance.');await this.move(c,'instances',ins,'report',{error},{handle_instance_failure:row=>this.instanceFailed(c,d,row,error)},{reportedState:'cleanup_required',bootChanged:true});}
      }
     }
     // the requests' own ends first: an end decides its request, and a run_request result after it only settles the command
     const requests=(await c.query("SELECT r.* FROM requests r JOIN instances i ON i.id=r.instance_id WHERE i.device_id=$1 AND r.state NOT IN ('completed','failed','cancelled')",[d.id])).rows;
     for(const r of requests){const report=p.requests.find((x:Row)=>x.request_id===r.id&&x.instance_id===r.instance_id);
      if(r.state==='pending'){await update(c,'requests',r.id,{disconnect_deadline_at:null});continue;}
      if(!report&&r.state==='running'&&d.agent_boot_id===p.agent_boot_id&&!r.accepted_report&&!r.engine_end&&r.contiguous_seq==='0'){
       const command=(await c.query("SELECT * FROM commands WHERE request_id=$1 AND kind='run_request' AND state='sent' AND acknowledged_at IS NULL AND NOT EXISTS (SELECT 1 FROM output_chunks WHERE request_id=$1)",[r.id])).rows[0];
       const observed=command&&p.commands.find((x:Row)=>x.command_id===command.id);
       if(command&&(!observed||observed.state==='pending'&&observed.result===null)&&!this.expired(command.ack_deadline_at)){
        await update(c,'commands',command.id,{retry_at:this.now()});await update(c,'requests',r.id,{disconnect_deadline_at:null});continue;
       }
      }
      if(!report||!report.complete_buffer||(!report.http_stream_alive&&!report.end)||d.agent_boot_id!==p.agent_boot_id||this.expired(r.disconnect_deadline_at)){
       await this.failRequest(c,r,'restart_unproven','reconcile_failed');await this.beginStop(c,await this.one(c,'sessions',r.session_id),'reconcile_failure');
      }else{if(report.end)await this.end(c,d,report.end);await update(c,'requests',r.id,{disconnect_deadline_at:null});outgoing.push({type:'output.replay',payload:{request_id:r.id,instance_id:r.instance_id,after_seq:r.contiguous_seq,through_seq:report.local_final_seq}});const s=await this.one(c,'sessions',r.session_id);if(['ready','degraded'].includes(s.state)&&!this.expired(s.service_disconnect_deadline_at))await this.resumeSession(c,s);}
     }
     for(const report of p.commands)if(['completed','failed','cancelled'].includes(report.state)){if(report.state==='completed'&&report.result===null)throw new Fault('invalid_input',400,'commands.result',{device_id:d.id,phase:'reconcile'});await this.result(c,d,{command_id:report.command_id,outcome:report.state,result:report.result,error:report.error});}
     const refs=(await c.query('SELECT s.* FROM sessions s JOIN session_devices sd ON sd.session_id=s.id WHERE sd.device_id=$1 AND sd.role=\'service\' AND s.state IN (\'ready\',\'degraded\')',[d.id])).rows;
     for(const s of refs)if(!this.expired(s.service_disconnect_deadline_at))await this.resumeSession(c,s);
    }
    await this.releaseSettled(c,d);
    const current=await this.one(c,'devices',d.id);const reserved=(await c.query('SELECT 1 FROM session_devices WHERE device_id=$1 AND released_at IS NULL',[d.id])).rowCount;
    await this.move(c,'devices',current,'reconciled',{},current.cleanup_required?{dispatch_device_cleanup:row=>this.queueDeviceCleanup(c,row)}:{},{reserved:!!reserved,cleanup:current.cleanup_required});
    if(type==='reconcile'){
     const retained=(await c.query('SELECT r.* FROM requests r JOIN instances i ON i.id=r.instance_id WHERE i.device_id=$1',[d.id])).rows;
     outgoing.push({type:'reconciled',payload:{reply_to:messageId,server_time:this.now().toISOString(),commands:await this.reconciledCommands(c,d.id),requests:retained.filter(r=>p.requests.some((x:Row)=>x.request_id===r.id)||!terminalRequest(r.state)).map(r=>({request_id:r.id,instance_id:r.instance_id,contiguous_seq:r.contiguous_seq,final_seq:r.final_seq,terminal:terminalRequest(r.state),retain_local:r.archive_state!=='saved'}))}});
    }else outgoing.push({type:'heartbeat.recorded',payload:{reply_to:messageId,server_time:this.now().toISOString(),heartbeat_deadline_at:this.after(30000).toISOString()}});
   }else if(type==='command.ack'){
    const cmd=await this.one(c,'commands',p.command_id,d.group_id);if(cmd.device_id!==d.id)throw new Fault('forbidden',403);if(cmd.state==='sent'&&!this.expired(cmd.ack_deadline_at))await this.move(c,'commands',cmd,'acknowledge',{acknowledged_at:this.now(),retry_at:null});
   }else if(type==='command.progress'){
    const cmd=await this.one(c,'commands',p.command_id,d.group_id);if(cmd.device_id!==d.id)throw new Fault('forbidden',403);if(!terminalCommand(cmd.state)&&!this.expired(cmd.phase_deadline_at)&&!this.expired(cmd.deadline_at)){
     const stages=cmd.kind==='prepare'?['prepare','download','build','verify']:cmd.kind==='start_service'||cmd.kind==='start_helper'?['load','calibrate','connect']:cmd.kind==='stop'?['drain','term','kill']:cmd.kind==='warmup'?['warmup']:cmd.kind==='cancel_request'?['drain']:['connect'];const from=stages.indexOf(cmd.phase),to=stages.indexOf(p.phase);if(to<from||to<0)throw new Fault('invalid_input');
     const progress=p.completed_bytes!==null&&BigInt(p.completed_bytes)>BigInt(cmd.progress_completed_bytes??'0');const change:Row={progress_message:p.message};if(progress){change.progress_completed_bytes=p.completed_bytes;change.progress_total_bytes=p.total_bytes;change.progress_at=this.now();}
     if(to>from||(p.phase==='download'&&progress)){change.phase=p.phase;change.phase_started_at=to>from?this.now():cmd.phase_started_at;change.phase_deadline_at=new Date(Math.min(new Date(cmd.deadline_at).getTime(),this.after(p.phase==='download'?600000:1800000).getTime()));}await update(c,'commands',cmd.id,change);
     if(change.phase_deadline_at){const phaseChange={phase:p.phase,phase_started_at:change.phase_started_at,phase_deadline_at:change.phase_deadline_at};if(cmd.instance_id)await update(c,'instances',cmd.instance_id,phaseChange);if(cmd.session_id){const session=await this.one(c,'sessions',cmd.session_id);if(session.state==='starting'||session.state==='degraded')await this.refreshPhase(c,cmd.session_id,p.phase);else if(session.state==='stopping')await update(c,'sessions',cmd.session_id,{phase:p.phase});}outgoing.push({type:'phase.update',payload:{command_id:cmd.id,phase:p.phase,phase_deadline_at:change.phase_deadline_at.toISOString(),deadline_at:new Date(cmd.deadline_at).toISOString()}});}
    }
   }else if(type==='command.result')await this.result(c,d,p);
   else if(type==='instance.status')await this.status(c,d,p);
   else if(type==='peer.status'){
    const ins=await this.one(c,'instances',p.instance_id,d.group_id);if(ins.device_id!==d.id||ins.session_id!==p.session_id||ins.stopped_at)throw new Fault('instance_mismatch',409);
    if(ins.spec.role!=='target')throw new Fault('invalid_input',400,'instance_id',{device_id:d.id,phase:'connect',message:"peer.status comes from the session's serving machine, about one of its writers."});
    // the writer's helper: the helper instance whose id it is (Connections); its connection is applied by the report's
    // generation, the join the table gave it; a connection the table did not take with the writer's credential opens nothing
    const helper=(await c.query("SELECT * FROM instances WHERE id=$1 AND session_id=$2 AND spec->>'role'='helper' FOR UPDATE",[p.writer_id,ins.session_id])).rows[0];
    if(!helper)throw new Fault('instance_mismatch',409,'writer_id',{device_id:d.id,phase:'connect'});
    const s=await this.one(c,'sessions',ins.session_id),g=p.connection_generation;
    if(!terminalSession(s.state)&&!helper.stopped_at&&g>=helper.connection_generation){
     if(p.state==='connected'){if(p.authenticated&&g>helper.connection_generation){await update(c,'instances',helper.id,{connection_generation:g,peer_instance_id:ins.id,push_connection_id:p.push_connection_id});await this.advance(c,s.id);}}
     else if(g>helper.connection_generation||helper.push_connection_id!==null){await update(c,'instances',helper.id,{connection_generation:g,push_connection_id:null});if(helper.push_connection_id!==null&&s.state==='ready')await this.move(c,'sessions',s,'helper_disconnected');}
    }
   }else if(type==='test.listening'||type==='test.result'){
    const t=await this.one(c,'connection_tests',p.test_id,d.group_id),cmd=await this.one(c,'commands',p.command_id,d.group_id);if(cmd.device_id!==d.id||cmd.connection_test_id!==t.id||cmd.kind!==(type==='test.listening'?'listen_test':'connect_test'))throw new Fault('forbidden',403);
    const field=type==='test.listening'?'listener_report':'result_report';if(t[field]){if(!isDeepStrictEqual(t[field],p))await this.conflict(c,d,{connection_test_id:t.id});}else if(!['reachable','unreachable'].includes(t.state)&&!this.expired(t.deadline_at)){
     if(type==='test.listening'){
      if(d.id!==t.target_device_id||p.port!==t.port||p.python!==t.listener_python||!p.bound_addresses.every((a:string)=>t.target_addresses.includes(a)))throw new Fault('invalid_input');await this.move(c,'connection_tests',t,'listener_ready',{listener_report:p,listener_ready_at:this.now()},{dispatch_connect_test:async()=>{const source=await this.one(c,'devices',t.source_device_id);const connect=await this.command(c,source,'connect_test',{target_device_id:t.target_device_id,target_addresses:p.bound_addresses,port:t.port,nonce:cmd.payload.nonce,per_address_timeout_ms:3000,rtt_rounds:10,transfer_bytes:8000000},{connection_test_id:t.id},60);await update(c,'commands',connect.id,{deadline_at:t.deadline_at,phase_deadline_at:t.deadline_at});}});
     }else{
      const source=await this.one(c,'devices',t.source_device_id),bound=t.listener_report?.bound_addresses??[];const success=p.error===null&&p.nonce_matched&&p.rtt_samples_ms.length===10&&p.transfer_bytes==='8000000'&&p.transfer_ms>0&&p.port===t.port&&source.inventory.addresses.some((a:Row)=>a.address===p.source_address)&&bound.includes(p.target_address);const rtts=[...p.rtt_samples_ms].sort((a,b)=>a-b);
      await this.move(c,'connection_tests',t,success?'reachable':'unreachable',{result_report:p,finished_at:this.now(),valid_until:success?this.after(7*86400000):null,source_address:p.source_address,target_address:p.target_address,rtt_median_ms:success?(rtts[4]+rtts[5])/2:null,transfer_bytes:success?p.transfer_bytes:null,transfer_ms:success?p.transfer_ms:null,error:success?null:p.error??err('direction_unreachable',d.id,'connect')},{dispatch_close_test:()=>this.closeTest(c,t,'measurement_finished')});
     }
    }
   }else if(type==='request.accepted'){
    const r=await this.requestOwner(c,d,p);if(r.accepted_report){if(!isDeepStrictEqual(r.accepted_report,p))await this.conflict(c,d,{request_id:r.id});}else if(!terminalRequest(r.state)){
     const session=await this.one(c,'sessions',r.session_id),fits=p.effective_max_output>=1&&p.prompt_tokens+p.effective_max_output<=session.config.context_length,given=r.requested_max_output===null||(r.source==='api'?p.effective_max_output<=r.requested_max_output:p.effective_max_output===r.requested_max_output);if(!fits||!given||BigInt(p.committed_position)!==BigInt(p.prompt_tokens))throw new Fault('context_budget_exceeded');await update(c,'requests',r.id,{accepted_report:p,prompt_tokens:p.prompt_tokens,effective_max_output:p.effective_max_output,committed_position:p.committed_position,timing:p.timing});
    }
   }else if(type==='output.chunk')await this.chunk(c,d,p,messageId);
   else if(type==='request.end')await this.end(c,d,p);
  });
  const conn=this.connections.get(deviceId);if(conn?.id!==connectionId)return;
  if(type==='reconcile')conn.ready=true;
  for(const event of outgoing)conn.send(event.type,event.payload);
  for(const fault of conflicts)conn.send('error',{reply_to:messageId,error:fault.body()});
  if(!['reconcile','heartbeat','output.chunk','request.end'].includes(type))conn.send('recorded',{reply_to:messageId,kind:type,resource_id:p.command_id??p.instance_id??p.test_id});

  if(type!=='output.chunk')await this.archivePending();
  if(type==='request.end')await this.confirmRequest(deviceId,p.request_id,messageId);
  if(type!=='output.chunk')await this.dispatch();
 }
 private async resumeSession(c:PoolClient,s:Row){await this.move(c,'sessions',s,'service_reconciled',{submissions_blocked:false,service_disconnect_deadline_at:null},{resume_requests:async()=>{
  const requests=(await c.query("SELECT * FROM requests WHERE session_id=$1 AND state NOT IN ('completed','failed','cancelled')",[s.id])).rows;
  for(const request of requests)if(request.disconnect_deadline_at)await update(c,'requests',request.id,{disconnect_deadline_at:null});
 }});}
 private async reconciledCommands(c:PoolClient,deviceId:string){const commands=(await c.query("SELECT * FROM commands WHERE device_id=$1 AND state IN ('pending','sent','executing') ORDER BY created_at,id",[deviceId])).rows;const valid=[];
  for(const cmd of commands)if(!this.expired(cmd.deadline_at)&&!this.expired(cmd.phase_deadline_at))valid.push(await this.wireCommand(c,cmd));return valid;
 }
 private async confirmRequest(deviceId:string,rid:string,replyTo:string){const r=(await this.pool.query('SELECT * FROM requests WHERE id=$1',[rid])).rows[0],conn=this.connections.get(deviceId);if(!conn?.ready)return;
  if(r.archive_state==='saved')conn.send('request.recorded',{reply_to:replyTo,request_id:r.id,instance_id:r.instance_id,state:r.state,contiguous_seq:r.contiguous_seq,final_seq:r.final_seq,result_sha256:r.result_sha256.toString('hex'),discard_local:true});
  else if(r.archive_state==='failed')conn.send('request.retained',{request_id:r.id,instance_id:r.instance_id,state:r.state,error:r.archive_error,discard_local:false});
  else if(r.engine_end)conn.send('output.replay',{request_id:r.id,instance_id:r.instance_id,after_seq:r.contiguous_seq,through_seq:r.final_seq});
 }
 private async wireCommand(c:PoolClient,cmd:Row){
  const ids=cmd.instance_id?[cmd.instance_id]:(cmd.payload.instance_ids??[]);
  const instances=ids.length?(await c.query('SELECT id,session_id,generation,config_sha256 FROM instances WHERE device_id=$1 AND id=ANY($2::uuid[])',[cmd.device_id,ids])).rows:[];
  if(instances.length!==ids.length)throw new Fault('instance_mismatch',409);
  // A start carries what the peers' authentication needs: the serving machine the session key, a helper only its own
  // credential (peer authentication).
  const payload={...cmd.payload};if(cmd.kind.startsWith('start_')){const session=await this.one(c,'sessions',cmd.session_id);if(!session.session_key)throw new Fault('instance_mismatch',409);
   payload.session_auth=cmd.kind==='start_service'?{session_id:session.id,key:session.session_key.toString('base64url')}:{session_id:session.id,credential:writerCredential(session.session_key,session.id,cmd.instance_id,cmd.device_id,instances[0].generation)};}
  return serial({command_id:cmd.id,device_id:cmd.device_id,session_id:cmd.session_id,instance_id:cmd.instance_id,request_id:cmd.request_id,connection_test_id:cmd.connection_test_id,instance_refs:instances.map(i=>({instance_id:i.id,session_id:i.session_id,generation:i.generation,config_sha256:i.config_sha256.toString('hex')})),kind:cmd.kind,created_at:cmd.created_at,deadline_at:cmd.deadline_at,phase:cmd.phase,phase_deadline_at:cmd.phase_deadline_at,payload});
 }
 async dispatch(){const outgoing:{device:string,payload:Row}[]=[];await this.tx(async c=>{
  const commands=(await c.query("SELECT * FROM commands WHERE state IN ('pending','sent') ORDER BY created_at,id")).rows;
  for(const cmd of commands){const connection=this.connections.get(cmd.device_id);if(!connection?.ready||this.expired(cmd.deadline_at)||cmd.state==='sent'&&(this.expired(cmd.ack_deadline_at)||!this.expired(cmd.retry_at)))continue;
   const device=await this.one(c,'devices',cmd.device_id);if(device.state==='offline'||device.state==='removed'||device.control_connection_id!==connection.id||!device.reconciled_at)continue;
   if(cmd.kind.startsWith('start_')){const session=await this.one(c,'sessions',cmd.session_id);if(terminalSession(session.state)||session.state==='stopping')continue;}
   if(cmd.kind==='run_request'){const request=await this.one(c,'requests',cmd.request_id);if(request.state==='pending')await this.move(c,'requests',request,'dispatch',{started_at:this.now()});else if(request.state!=='running')continue;}
   await this.move(c,'commands',cmd,cmd.state==='pending'?'dispatch':'retry_unacked',{first_sent_at:cmd.first_sent_at??this.now(),last_sent_at:this.now(),ack_deadline_at:cmd.ack_deadline_at??this.after(30000),retry_at:this.after(5000),attempts:cmd.attempts+1},{queue_command:async()=>{outgoing.push({device:cmd.device_id,payload:await this.wireCommand(c,cmd)});}});
  }
 });for(const item of outgoing){const connection=this.connections.get(item.device);if(connection?.ready)connection.send('command',item.payload);}}
 private archiving=new Set<string>();
 async archivePending(){const requests=(await this.pool.query("SELECT * FROM requests WHERE archive_state='pending' AND (state IN ('failed','cancelled') OR (state='recovering' AND final_seq=contiguous_seq))")).rows;
  for(const request of requests){if(this.archiving.has(request.id))continue;this.archiving.add(request.id);try{
   if(request.state==='recovering'&&(!request.engine_released_at||request.engine_end?.output_tokens!==request.output_tokens)){
    await this.tx(async c=>this.failRequest(c,await this.one(c,'requests',request.id),'protocol_conflict','chunk_conflict'));continue;
   }
   const chunks=(await this.pool.query('SELECT * FROM output_chunks WHERE request_id=$1 AND seq<=$2 ORDER BY seq',[request.id,request.contiguous_seq])).rows.map(({group_id,...chunk})=>chunk);
   const outcome=request.state==='recovering'?'completed':request.state;
   const object={schema_version:1,request_id:request.id,session_id:request.session_id,instance_id:request.instance_id,outcome,input:request.input,prompt_file_id:request.prompt_file_id,seed:request.seed,sampling:request.sampling,prompt_tokens:request.prompt_tokens,effective_max_output:request.effective_max_output,contiguous_seq:request.contiguous_seq,final_seq:request.final_seq,chunks,text:chunks.map(chunk=>chunk.text).join(''),output_tokens:request.output_tokens,timing:request.timing,statistics:request.statistics,engine_end:request.engine_end,error:request.error};
   let failure:Row|null=null;const bytes=Buffer.from(JSON.stringify(object)),key=`requests/${request.id}.json`;
   try{if(this.expired(request.persistence_deadline_at))throw new Error('expired');await this.store.put(key,bytes);}catch{failure=err('archive_failed',null,'archive');}
   await this.tx(async c=>{let current=await this.one(c,'requests',request.id);if(current.archive_state!=='pending'||current.state!==request.state||current.contiguous_seq!==request.contiguous_seq)return;
    if(this.expired(current.persistence_deadline_at))failure=err('archive_failed',null,'archive');
    const instance=await this.one(c,'instances',current.instance_id);if(failure)failure={...failure,device_id:instance.device_id};
    if(failure&&current.state==='recovering')current=await this.move(c,'requests',current,'persistence_failed',{ended_at:this.now(),error:current.error??failure});
    await this.move(c,'archives',current,failure?'fail':'save',failure?{archive_error:failure}:{result_object_key:key,result_sha256:hash(bytes)},{[failure?'retain_device_buffer':'confirm_request_recorded']:()=>this.afterCommit(c,()=>this.confirmRequest(instance.device_id,request.id,randomUUID()))});
    if(!failure&&current.state==='recovering')await this.move(c,'requests',await this.one(c,'requests',request.id),'archive_saved',{ended_at:this.now()});
   });
  }finally{this.archiving.delete(request.id);}}
 }
 private recoveryDeadline:Date|null=null;
 async recover(){this.recoveryDeadline=this.after(30000);this.nextSweep=0;this.connections.clear();await this.tx(async c=>{
  const devices=(await c.query("SELECT * FROM devices WHERE state<>'removed'")).rows;
  for(const device of devices)await update(c,'devices',device.id,{control_connection_id:null,reconciled_at:null,heartbeat_deadline_at:this.recoveryDeadline});
  const tests=(await c.query("SELECT * FROM connection_tests WHERE state IN ('listening','testing') OR listener_closed_at IS NULL")).rows;
  for(const test of tests)await this.failTest(c,test,'control_plane_restarted');
 });await this.tick();}
 private nextSweep=0;
 private async commandTimeout(c:PoolClient,cmd:Row){
  if(cmd.connection_test_id){await this.failTest(c,await this.one(c,'connection_tests',cmd.connection_test_id),'deadline_exceeded');return;}
  if(cmd.kind==='recheck'){const device=await this.one(c,'devices',cmd.device_id);if(device.state==='cleanup_required')await this.move(c,'devices',device,'recheck_timeout',{error:device.error?.code==='port_busy'?device.error:err('deadline_exceeded',device.id,'reconcile')});return;}
  if(!cmd.session_id)return;const session=await this.one(c,'sessions',cmd.session_id);
  if(session.state==='starting')await this.beginStop(c,session,'startup_failure');
  else if(cmd.kind==='run_request')await this.cancel(c,await this.one(c,'requests',cmd.request_id),'no_output_timeout');
  else if(session.state==='degraded'&&['prepare','start_helper'].includes(cmd.kind))await this.cleanupReconnect(c,cmd,'deadline_exceeded');
  else if(cmd.kind==='stop'&&cmd.instance_id){const device=await this.one(c,'devices',cmd.device_id);await this.stopFailed(c,device,cmd,err('deadline_exceeded',device.id,'kill'));}
 }
 private async sweep(){const time=this.now().getTime();if(time<this.nextSweep)return;
  await this.tx(async c=>{
   const tokens=(await c.query("SELECT * FROM enrollment_tokens WHERE state='pending' AND expires_at<=$1",[this.now()])).rows;
   for(const token of tokens)await this.move(c,'enrollment_tokens',token,'expire');
   const devices=(await c.query("SELECT * FROM devices WHERE state NOT IN ('offline','removed') AND heartbeat_deadline_at<=$1",[this.now()])).rows;
   for(const device of devices)await this.offline(c,device,new Date(device.heartbeat_deadline_at));
   const tests=(await c.query("SELECT * FROM connection_tests WHERE state IN ('listening','testing') AND deadline_at<=$1",[this.now()])).rows;
   for(const test of tests)await this.failTest(c,test,'deadline_exceeded');
   const commands=(await c.query("SELECT * FROM commands WHERE state NOT IN ('completed','failed','cancelled') AND (deadline_at<=$1 OR phase_deadline_at<=$1 OR (state='sent' AND ack_deadline_at<=$1))",[this.now()])).rows;
   for(const command of commands){const current=await this.one(c,'commands',command.id);if(!terminalCommand(current.state))await this.move(c,'commands',current,'deadline_expired',{finished_at:this.now()},{handle_command_timeout:()=>this.commandTimeout(c,current)});}
   const sessions=(await c.query("SELECT * FROM sessions WHERE state NOT IN ('ended','failed')")).rows;
   for(const session of sessions){
    if(session.state==='starting'&&this.expired(session.phase_deadline_at))await this.beginStop(c,session,'startup_failure');
    else if(['ready','degraded'].includes(session.state)&&this.expired(session.service_disconnect_deadline_at))await this.beginStop(c,session,'service_offline');
    else if(session.state==='stopping'){
     if(this.expired(session.drain_deadline_at)){const requests=(await c.query("SELECT * FROM requests WHERE session_id=$1 AND state NOT IN ('completed','failed','cancelled')",[session.id])).rows;for(const request of requests)await this.cancel(c,request,'session_stop');}
     await this.stopHelpers(c,session);
     const phase=this.expired(session.term_deadline_at)?'kill':this.expired(session.drain_deadline_at)?'term':'drain';if(phase!==session.phase)await update(c,'sessions',session.id,{phase});
     await this.finishStop(c,session,this.expired(session.stop_deadline_at));
    }
   }
   const helpers=(await c.query("SELECT i.* FROM instances i JOIN sessions s ON s.id=i.session_id WHERE s.state='degraded' AND i.generation>1 AND i.stopped_at IS NULL AND i.phase='connect' AND i.phase_deadline_at<=$1 AND i.state NOT IN ('failed','cleanup_required')",[this.now()])).rows;
   for(const helper of helpers)await this.cleanupReconnect(c,{instance_id:helper.id},'deadline_exceeded');
   const requests=(await c.query("SELECT * FROM requests WHERE state NOT IN ('completed','failed','cancelled')")).rows;
   for(const request of requests){
    if(this.expired(request.disconnect_deadline_at))await this.failRequest(c,request,'disconnect_timeout','service_offline');
    else if(request.state==='cancelling'&&this.expired(request.cancel_deadline_at))await this.failRequest(c,request,'cancel_timeout','cancel_timeout');
    else if(request.state==='recovering'&&this.expired(request.persistence_deadline_at))await this.move(c,'requests',request,'persistence_failed',{ended_at:this.now(),error:err('persistence_failed',null,'archive')});
    else if(['pending','running','recovering'].includes(request.state)&&this.expired(request.no_output_deadline_at))await this.cancel(c,request,'no_output_timeout');
   }
   const unclosed=(await c.query("SELECT * FROM connection_tests WHERE state IN ('reachable','unreachable') AND listener_closed_at IS NULL")).rows;
   for(const test of unclosed)await this.closeTest(c,test,'cleanup_retry');
   // Cache only until the earliest durable deadline, so a message arriving between
   // timer ticks cannot extend an already expired operation. No sweep per block.
   const deadlines=(await c.query(`SELECT min(deadline) AS next FROM (
    SELECT expires_at AS deadline FROM enrollment_tokens WHERE state='pending'
    UNION ALL SELECT heartbeat_deadline_at FROM devices WHERE state NOT IN ('offline','removed')
    UNION ALL SELECT deadline_at FROM connection_tests WHERE state IN ('listening','testing')
    UNION ALL SELECT unnest(ARRAY[deadline_at,phase_deadline_at,CASE WHEN state='sent' THEN ack_deadline_at END]) FROM commands WHERE state NOT IN ('completed','failed','cancelled')
    UNION ALL SELECT unnest(ARRAY[phase_deadline_at,service_disconnect_deadline_at,drain_deadline_at,term_deadline_at,stop_deadline_at]) FROM sessions WHERE state NOT IN ('ended','failed')
    UNION ALL SELECT phase_deadline_at FROM instances WHERE stopped_at IS NULL AND state NOT IN ('failed','cleanup_required')
    UNION ALL SELECT unnest(ARRAY[disconnect_deadline_at,cancel_deadline_at,persistence_deadline_at,no_output_deadline_at]) FROM requests WHERE state NOT IN ('completed','failed','cancelled')
   ) due WHERE deadline>$1`,[this.now()])).rows[0].next;
   this.nextSweep=Math.min(time+1000,deadlines?new Date(deadlines).getTime():Infinity);
  });
  for(const connection of this.connections.values())if(!connection.ready)this.nextSweep=Math.min(this.nextSweep,connection.deadline.getTime());
  for(const [deviceId,connection]of this.connections)if(!connection.ready&&this.expired(connection.deadline)){
   await this.closeDevice(deviceId,connection.id);connection.close?.(4408,'reconcile_timeout');
  }
 }
 async tick(){this.nextSweep=0;await this.sweep();await this.archivePending();await this.dispatch();}
 async getDevice(user:User,key:string){const d=await this.lookup('devices',key,user);const {credential_hash,enrollment_id,control_connection_id,...publicRow}=d;const refs=(await this.pool.query('SELECT session_id,role FROM session_devices WHERE device_id=$1 AND released_at IS NULL',[key])).rows;const instances=await this.instances(key);return serial({...publicRow,reservation:refs[0]??null,instances});}
 // progress: while an instance downloads, the bytes its prepare command last reported; the device's newest
 // commands come first in commands_by_device, and an instance in another phase looks nothing up.
 private async instances(deviceId?:string,sid?:string){const rows=(await this.pool.query(`SELECT i.*,p.progress_completed_bytes AS download_done,p.progress_total_bytes AS download_total,p.progress_at AS download_at FROM instances i LEFT JOIN LATERAL (SELECT progress_completed_bytes,progress_total_bytes,progress_at FROM commands c WHERE i.phase='download' AND c.device_id=i.device_id AND c.instance_id=i.id AND c.kind='prepare' AND c.progress_completed_bytes IS NOT NULL ORDER BY c.created_at DESC,c.id DESC LIMIT 1) p ON true WHERE `+(deviceId?'i.device_id=$1':'i.session_id=$1'),[deviceId??sid])).rows;return rows.map(i=>serial({instance_id:i.id,session_id:i.session_id,agent_boot_id:i.agent_boot_id,generation:i.generation,state:i.state,phase:i.phase,config_sha256:i.config_sha256.toString('hex'),processes:i.processes,http_healthy:i.http_healthy,push_listening:i.push_listening,calibrated:i.calibrated,peer_instance_id:i.peer_instance_id,push_connection_id:i.push_connection_id,metrics:{...EMPTY_METRICS,...i.metrics},error:i.error,device_id:i.device_id,created_at:i.created_at,phase_started_at:i.phase_started_at,phase_deadline_at:i.phase_deadline_at,stopped_at:i.stopped_at,progress:i.download_done===null?null:{completed_bytes:i.download_done,total_bytes:i.download_total,at:i.download_at}}));}
 async getSession(user:User,key:string){const s=await this.lookup('sessions',key,user);const {session_key,config,warmup_command_id,...rest}=s;const requests=(await this.pool.query("SELECT id FROM requests WHERE session_id=$1 AND state NOT IN ('completed','failed','cancelled')",[key])).rows;const refs=(await this.pool.query('SELECT device_id FROM session_devices WHERE session_id=$1 AND released_at IS NULL',[key])).rows;return serial({...rest,config_sha256:s.config_sha256.toString('hex'),effective_config:config,plan:config.plan,instances:await this.instances(undefined,key),active_request_ids:requests.map(r=>r.id),uncleared_device_ids:terminalSession(s.state)?refs.map(r=>r.device_id):[]});}
 // prompt_file: the uploaded file the request took its prompt from, for the website's link to it; null for a typed prompt.
 async getRequest(user:User,key:string){const r=await this.lookup('requests',key,user);const {group_id,slot,accepted_report,result_object_key,...rest}=r;
  const file=r.prompt_file_id?(await this.pool.query('SELECT id,name,size_bytes FROM files WHERE id=$1',[r.prompt_file_id])).rows[0]:null;
  return serial({...rest,result_sha256:r.result_sha256?.toString('hex')??null,prompt_file:file});}
 /** GET /sessions/{id}/requests: the session's latest requests, newest first, as the snapshot shows them. */
 async sessionRequests(user:User,sid:string,limit:number){await this.lookup('sessions',sid,user);if(!Number.isInteger(limit)||limit<1||limit>100)throw new Fault('invalid_input',400,'limit');
  const rows=(await this.pool.query('SELECT id FROM requests WHERE session_id=$1 ORDER BY received_at DESC,id DESC LIMIT $2',[sid,limit])).rows;
  return {requests:await Promise.all(rows.map(async row=>{const {input,seed,sampling,engine_end,statistics,...r}=await this.getRequest(user,row.id);return r;}))};}
 async getTest(user:User,key:string){const t=await this.lookup('connection_tests',key,user);return this.testView(t,await this.lookup('devices',t.source_device_id,user),await this.lookup('devices',t.target_device_id,user));}
 async getChunks(user:User,key:string,after='0',limit=100){const r=await this.lookup('requests',key,user);if(!/^(0|[1-9]\d*)$/.test(after)||BigInt(after)>9223372036854775807n||!Number.isInteger(limit)||limit<1||limit>1000)throw new Fault('invalid_input');const rows=(await this.pool.query('SELECT * FROM output_chunks WHERE request_id=$1 AND seq>$2 AND seq<=$3 ORDER BY seq LIMIT $4',[key,after,r.contiguous_seq,limit+1])).rows;const more=rows.length>limit;const chunks=rows.slice(0,limit).map(({group_id,...ch})=>ch);return serial({request_id:key,chunks,contiguous_seq:r.contiguous_seq,next:more?chunks.at(-1)!.seq:null});}
 async getResult(user:User,key:string){const r=await this.lookup('requests',key,user);if(r.archive_state!=='saved')throw new Fault(r.archive_state==='failed'?'archive_failed':'result_pending',409);return JSON.parse((await this.stored(r.result_object_key,'result')).toString('utf8'));}
 async snapshot(user:User){const ids=async(table:string,where:string)=> (await this.pool.query(`SELECT id FROM ${table} WHERE group_id=$1 AND ${where}`,[user.group_id])).rows.map(r=>r.id);
  const devices=await Promise.all((await ids('devices',"state<>'removed'")).map(async id=>{const {inventory,instances,...d}=await this.getDevice(user,id);return d;}));
  const connection_tests=await Promise.all((await ids('connection_tests',"state IN ('listening','testing') OR (group_id=$1 AND listener_closed_at IS NULL)")).map(id=>this.getTest(user,id)));
  const active=await ids('sessions',"state NOT IN ('ended','failed')");const recent=(await this.pool.query("SELECT id FROM sessions WHERE group_id=$1 AND state IN ('ended','failed') ORDER BY created_at DESC,id DESC LIMIT 20",[user.group_id])).rows.map(r=>r.id);
  const sessions=await Promise.all([...active,...recent].map(async id=>{const {effective_config,instances,plan,...s}=await this.getSession(user,id);return s;}));
  const requests=await Promise.all((await ids('requests',"state NOT IN ('completed','failed','cancelled')")).map(async id=>{const {input,seed,sampling,engine_end,statistics,...r}=await this.getRequest(user,id);return r;}));
  return {at:this.now().toISOString(),group_id:user.group_id,storage:this.storage(),devices,connection_tests,sessions,requests,output_watermarks:requests.map(r=>({request_id:r.id,contiguous_seq:r.contiguous_seq}))};
 }
}

import { createHash,randomUUID,randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { ControlPlane,type User } from '../src/control.ts';
import { EMPTY_TIMING,EMPTY_STATS } from '../src/protocol.ts';
const sha='a'.repeat(64);
export const fixtureMetrics=()=>({load_seconds:null,peak_memory_bytes:null,tokenizer_mapping_id:null,step_cost:[],effective_spec:null});
export const fixtureError=(code='fixture_failure',device_id:null|string=null,phase:null|string=null)=>({code,message:`Fixture ${code}`,field:null,device_id,phase,retryable:false});
// What a version requires of a build (BuildRequirement), and a device's proof of a build that meets
// it (BuildProof): its own location and digests under DIRECTORY, the options it has beyond the required ones, CHANGE last.
export const fixtureRequirement=(engine:string)=>engine==='llama.cpp'?{source_revision:'fixture-llama-commit',bridge_revision:'fixture-bridge-sources',options:{GGML_CUDA:'ON',CMAKE_BUILD_TYPE:'Release'}}:{source_revision:'fixture-packages',bridge_revision:null,options:{python:'3.12'}};
const digestOf=(text:string)=>createHash('sha256').update(text).digest('hex');
export function fixtureProof(version:any,directory='/fixture/build',change:Record<string,unknown>={}){const want=version.build_requirements;return {source_revision:want.source_revision,bridge_revision:want.bridge_revision,compiler:'fixture compiler',cuda:version.engine==='llama.cpp'?'13.1':null,options:{...want.options,...(version.engine==='llama.cpp'?{CMAKE_CUDA_ARCHITECTURES:'89'}:{})},binary_sha256:digestOf(`${directory}/binary`),libraries:[{path:`${directory}/libfixture.so`,sha256:digestOf(`${directory}/libfixture.so`)}],...change};}
export const fixtureModel={context_length:4096,think_end_id:7,sampling:{temperature:1,top_p:0.95,top_k:20,min_p:0,presence_penalty:0}};
// The session entry of a fixture version: a serving machine's (with its table) or a writer's, with the placeholders the control
// plane fills in.
export const fixtureEntry=(role:string)=>role==='service'
 ?{files:{weights:'test-only'},command:{width:8,batch:'{max_requests}',sampling:{temperature:'{temperature}',top_k:'{top_k}',top_p:'{top_p}'}},environment:{push:true,plain:false,peers:'{peers}',gpu:'{gpu}'},table:{command:{ahead:256,rewrite:16,width:8,batch:'{max_requests}'}}}
 :{files:{weights:'test-only'},command:{spec:'draft',max_seqs:1,think_end_id:'{think_end_id}',writer_id:'{writer_id}',context_length:'{context_length}'},environment:{push:false,plain:false,peers:true,gpu:'{gpu}'}};
export function fixtureVersion(role:string,id:string,engine:string,model='Qwen3.8-27B'){return {id,role,label:'synthetic fixture',model,repo:'test-only',revision:'fixed-fixture',quantization:'fixture',files:[],manifest_sha256:sha,engine,
 kind:role==='service'?'mlx':'helper-llama.cpp',entry:fixtureEntry(role),platform:role==='service'?{os:'darwin',arch:'arm64',gpu_vendor:null}:{os:'linux',arch:'x86_64',gpu_vendor:'NVIDIA'},...(role==='service'?{max_requests:1}:{}),
 build_requirements:fixtureRequirement(engine),draft_model:role==='helper'?{enabled:true,mechanism:'test-only',draft_repo:'test-only',draft_revision:'fixture',files:[],parameters:{}}:null,compatible_service_version_ids:['service'],validation:{hardware:[],evidence:['synthetic-test-only'],complete:true,missing:[]}};}
export function fixtureCatalog(){
 return {catalog:{models:{'Qwen3.8-27B':structuredClone(fixtureModel)},versions:[fixtureVersion('service','service','mlx'),fixtureVersion('helper','helper','llama.cpp')]},requirements:{service:{memory_bytes:'100',disk_bytes:'100'},helper:{memory_bytes:'100',disk_bytes:'100',precision_rank:1}},warmup:{resource_id:'fixture-only',sha256:sha,max_output_tokens:256 as const},controlUrls:{local:'https://localhost',lan:'https://example.invalid'},certificateSha256:sha};}
// The fixture catalog as a catalog file holds it (config.ts parseDeployment): without the server's own settings, and each
// version with a file, as a complete version names its files.
export function fixtureDeployment():any{const {controlUrls,certificateSha256,...value}=fixtureCatalog() as any;
 for(const v of value.catalog.versions)v.files=[{path:'weights.bin',sha256:'b'.repeat(64),size_bytes:'1'}];return value;}
// every inventory a fixture builds is a newer probe than the one before it (its sequence), as a device's are
let probes=0;
export function inventory(role:string){return {sequence:++probes,agent_version:'fixture',openinfer_revision:'fixture',os:role==='service'?'darwin':'linux',arch:role==='service'?'arm64':'x86_64',machine_model:role==='service'?'Mac mini':'fixture',cpu_model:role==='service'?'Apple M2 Pro':'fixture',memory_total_bytes:'34359738368',memory_available_bytes:'30000000000',disk_available_bytes:'100000000000',control_plane_reserved_bytes:'1000',gpus:role==='helper'?[{id:'0',model:'RTX A5000',vendor:'NVIDIA',total_bytes:'25769803776',available_bytes:'20000000000',compute_tflops:null,bandwidth_gbps:null,driver:'fixture'}]:[],addresses:[{address:role==='service'?'192.0.2.1':'192.0.2.2',interface:'fixture'}],python_executables:[{path:'/fixture/python',version:'3.12',purpose:role==='service'?'mlx':'helper'}],engines:[{name:role==='service'?'mlx':'llama.cpp',version:'fixture',available:true,build:null,error:null}],prepared_versions:[],local_model_folders:false};}
export async function setupPair(p:ControlPlane,pool:Pool,user?:User){if(!user){user={user_id:randomUUID(),group_id:randomUUID()};await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[user.user_id,`${user.user_id}@example.invalid`,'fixture']);await pool.query('INSERT INTO groups(id) VALUES($1)',[user.group_id]);await pool.query('INSERT INTO memberships VALUES($1,$2)',[user.group_id,user.user_id]);}
 const pair:any={user,pool,p,devices:{},commands:[],events:[],plan:null};
 pair.send=async(role:string,type:string,payload:any)=>p.handleDevice(pair.devices[role].id,pair.devices[role].connection,type,payload);
 pair.next=async(role:string,kind:string)=>{await p.dispatch();const item=pair.commands.find((x:any)=>x.role===role&&x.kind===kind&&!x.used);if(!item)throw new Error(`No ${role} ${kind}: ${JSON.stringify(pair.commands.map((x:any)=>[x.role,x.kind,x.used]))}`);item.used=true;await pair.send(role,'command.ack',{command_id:item.command_id,state:'executing'});return item;};
 pair.result=async(role:string,cmd:any,result:any,outcome='completed',error:any=outcome==='completed'?null:fixtureError())=>pair.send(role,'command.result',{command_id:cmd.command_id,outcome,result,error});
 const remember=(role:string,command:any)=>{const device=pair.devices[role];for(const ref of command.instance_refs??[]){const old=device.instances.get(ref.instance_id);if(old&&(old.session_id!==ref.session_id||old.generation!==ref.generation||old.config_sha256!==ref.config_sha256))throw new Error(`Conflicting instance ref ${ref.instance_id}`);device.instances.set(ref.instance_id,{...old,...ref});}};
 pair.acceptCommand=(role:string,payload:any)=>{if(!pair.commands.some((c:any)=>c.command_id===payload.command_id)){remember(role,payload);pair.commands.push({...payload,role});}};
 pair.reopen=async(role:string,boot=pair.devices[role].boot)=>{const device=pair.devices[role];device.boot=boot;const connection=await p.openDevice(device.id,device.credential,(type,payload)=>{pair.events.push({role,type,payload});if(type==='command')pair.acceptCommand(role,payload);});device.connection=connection;return connection;};
 for(const role of ['service','helper']){const token=await p.enrollment(user,role);const credential=randomBytes(32).toString('base64url'),boot=randomUUID();const enrolled=await p.enroll({enrollment_token:token.token,credential,agent_boot_id:boot,inventory:inventory(role)});pair.devices[role]={id:enrolled.device_id,credential,boot,instances:new Map()};await pair.reopen(role,boot);await pair.send(role,'reconcile',{agent_boot_id:boot,inventory:inventory(role),instances:[],commands:[],requests:[]});}
 const test=await p.createConnectionTest(user,{source_device_id:pair.devices.helper.id,target_device_id:pair.devices.service.id,target_addresses:['192.0.2.1'],port:40360,listener_python:'/fixture/python'});
 const listen=await pair.next('service','listen_test');await pair.send('service','test.listening',{command_id:listen.command_id,test_id:test.id,bound_addresses:['192.0.2.1'],port:40360,python:'/fixture/python'});
 const connect=await pair.next('helper','connect_test');await pair.send('helper','test.result',{command_id:connect.command_id,test_id:test.id,source_address:'192.0.2.2',target_address:'192.0.2.1',port:40360,nonce_matched:true,rtt_samples_ms:Array(10).fill(1),transfer_bytes:'8000000',transfer_ms:10,error:null});
 await pair.result('helper',connect,{test_id:test.id,listener_closed:false});const close=await pair.next('service','close_test');await pair.result('service',close,{test_id:test.id,listener_closed:true});await pair.result('service',listen,{test_id:test.id,listener_closed:true});
 pair.plan={service_device_id:pair.devices.service.id,service_version_id:'service',helpers:[{device_id:pair.devices.helper.id,version_id:'helper',draft_model:'enabled',acknowledge_no_draft_model:false,connection_test_id:test.id}],};
 pair.commandRef=(role:string,command:any,index=0)=>{const ref=command.instance_refs?.[index];if(!ref)throw new Error(`${role} ${command.kind} did not provide instance_refs[${index}]`);return ref;};
 pair.report=async(role:string,state:string,instanceId?:string)=>{const device=pair.devices[role],ins=instanceId?device.instances.get(instanceId):Array.from(device.instances.values()).at(-1);if(!ins)throw new Error(`${role} has no instance identity from a downlinked Command.instance_refs`);const active=!['stopped','failed','cleanup_required'].includes(state);return {instance_id:ins.instance_id,session_id:ins.session_id,agent_boot_id:device.boot,generation:ins.generation,state,phase:state==='stopped'?'kill':'connect',config_sha256:ins.config_sha256,processes:[],http_healthy:role==='service'&&active,push_listening:role==='service'&&active,calibrated:active,inventory_after:null,metrics:fixtureMetrics(),error:['failed','cleanup_required'].includes(state)?fixtureError(state==='failed'?'process_exit':'cleanup_required',device.id,state==='failed'?'serve':'reconcile'):null};};
 pair.status=async(role:string,state:string)=>pair.send(role,'instance.status',await pair.report(role,state));
 // the serving machine reports the helper's writer as its draft table counts it (or has lost it)
 pair.peer=async(connected:boolean)=>{await pair.peerStatus('helper',connected?'connected':'disconnected');};
 // The serving machine's report about the writer of helper ROLE (its latest start_helper, or WRITER): `connected` opens a new
 // connection, `disconnected` closes the current one; GENERATION, CONNECTION and MESSAGE_ID repeat an earlier report; the
 // serving machine reports its table took the writer's credential unless AUTHENTICATED is false.
 pair.links={};
 pair.peerStatus=async(role:string,state:'connected'|'disconnected',o:{generation?:number,connection?:string,messageId?:string,writer?:string,authenticated?:boolean}={})=>{
  const latest=(r:string,kind:string)=>[...pair.commands].reverse().find((x:any)=>x.role===r&&x.kind===kind);
  const writer=o.writer??latest(role,'start_helper').payload.entry.command.writer_id,service=await pair.report('service','connectable');
  const last=pair.links[writer]??{generation:0,connection:null};
  const link=o.generation!==undefined?{generation:o.generation,connection:o.connection??last.connection}:state==='connected'?{generation:last.generation+1,connection:randomUUID()}:last;
  if(o.generation===undefined)pair.links[writer]=link;
  const payload={session_id:service.session_id,instance_id:service.instance_id,writer_id:writer,connection_generation:link.generation,push_connection_id:link.connection,state,authenticated:o.authenticated??true,error:state==='connected'?null:fixtureError('peer_disconnected',pair.devices.service.id,'connect')};
  const messageId=o.messageId??randomUUID();await p.handleDevice(pair.devices.service.id,pair.devices.service.connection,'peer.status',payload,messageId);return {...link,messageId,writer};
 };
 pair.stopAll=async()=>{for(const role of ['service','helper']){const stop=await pair.next(role,'stop');await pair.result(role,stop,{instances:[await pair.report(role,'stopped')],ports_free:true});}};
 return pair;
}
// Another helper device ROLE of PAIR (the helper's inventory at ADDRESS, with CHANGE over it), enrolled, reconciled and tested
// to the serving machine on the session's port; returns its entry of a plan.
export async function addHelper(p:ControlPlane,pair:any,role:string,address='192.0.2.3',change:Record<string,unknown>={}){
 const inv={...inventory('helper'),addresses:[{address,interface:'fixture'}],...change};
 const token=await p.enrollment(pair.user,role),credential=randomBytes(32).toString('base64url'),boot=randomUUID();
 const enrolled=await p.enroll({enrollment_token:token.token,credential,agent_boot_id:boot,inventory:inv});
 pair.devices[role]={id:enrolled.device_id,credential,boot,instances:new Map()};await pair.reopen(role,boot);
 await pair.send(role,'reconcile',{agent_boot_id:boot,inventory:inv,instances:[],commands:[],requests:[]});
 const test=await p.createConnectionTest(pair.user,{source_device_id:enrolled.device_id,target_device_id:pair.devices.service.id,target_addresses:['192.0.2.1'],port:40360,listener_python:'/fixture/python'});
 const listen=await pair.next('service','listen_test');await pair.send('service','test.listening',{command_id:listen.command_id,test_id:test.id,bound_addresses:['192.0.2.1'],port:40360,python:'/fixture/python'});
 const connect=await pair.next(role,'connect_test');await pair.send(role,'test.result',{command_id:connect.command_id,test_id:test.id,source_address:address,target_address:'192.0.2.1',port:40360,nonce_matched:true,rtt_samples_ms:Array(10).fill(1),transfer_bytes:'8000000',transfer_ms:10,error:null});
 await pair.result(role,connect,{test_id:test.id,listener_closed:false});const close=await pair.next('service','close_test');await pair.result('service',close,{test_id:test.id,listener_closed:true});await pair.result('service',listen,{test_id:test.id,listener_closed:true});
 return {device_id:enrolled.device_id,version_id:'helper',draft_model:'enabled',acknowledge_no_draft_model:false,connection_test_id:test.id};
}
// A session of PAIR's plan started up to its connections: every device prepared, the serving machine connectable, each helper
// ROLES ready; the serving machine has reported none of them connected.
export async function startUp(p:ControlPlane,pair:any,roles:string[]){
 const s=await p.createSession(pair.user,randomUUID(),pair.plan);
 for(const role of ['service',...roles]){const prepare=await pair.next(role,'prepare');await pair.result(role,prepare,{manifest_sha256:sha,prepared_version_id:prepare.payload.version.id,build:fixtureProof(prepare.payload.version)});}
 const serving=await pair.next('service','start_service');await pair.result('service',serving,{instance:await pair.report('service','connectable')});
 for(const role of roles){const cmd=await pair.next(role,'start_helper');await pair.result(role,cmd,{instance:await pair.report(role,'ready')});}
 return s;
}
export async function startSession(p:ControlPlane,pair:any){const s=await p.createSession(pair.user,randomUUID(),pair.plan);for(const role of ['service','helper']){const prepare=await pair.next(role,'prepare');await pair.result(role,prepare,{manifest_sha256:sha,prepared_version_id:role,build:fixtureProof(prepare.payload.version)});}
 for(const role of ['service','helper']){const cmd=await pair.next(role,role==='service'?'start_service':'start_helper');await pair.result(role,cmd,{instance:await pair.report(role,'connectable')});}
 await pair.peer(true);const warm=await pair.next('service','warmup');await pair.result('service',warm,{resource_sha256:sha,output_tokens:'256',timing:EMPTY_TIMING});return p.getSession(pair.user,s.id);
}
export async function sendOutput(p:ControlPlane,pair:any,r:any){await pair.next('service','run_request');const timing={...EMPTY_TIMING,clock_id:r.instance_id,engine_received_ns:'0',engine_first_output_ns:'1000000000',engine_last_output_ns:'2000000000',engine_first_chunk_tokens:1,engine_finished_ns:'2000000000'};await pair.send('service','request.accepted',{request_id:r.id,instance_id:r.instance_id,prompt_tokens:1,effective_max_output:r.requested_max_output??4095,committed_position:'1',timing:{...timing,engine_first_output_ns:null,engine_last_output_ns:null,engine_first_chunk_tokens:null,engine_finished_ns:null}});
 const chunk=(seq:string,text:string)=>({request_id:r.id,instance_id:r.instance_id,seq,text,token_count:1,segment:'answer',committed_position:(1+Number(seq)).toString(),engine_first_output_ns:'1000000000',engine_last_output_ns:seq==='1'?'1000000000':'2000000000',engine_first_chunk_tokens:1});
 await pair.send('service','output.chunk',chunk('2','B'));await pair.send('service','output.chunk',chunk('1','A'));await pair.send('service','output.chunk',chunk('1','A'));
 await pair.send('service','request.end',{request_id:r.id,instance_id:r.instance_id,final_seq:'2',outcome:'completed',reason:'length',released:true,prompt_tokens:1,output_tokens:'2',timing,statistics:EMPTY_STATS,error:null});
}

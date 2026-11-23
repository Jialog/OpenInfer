import { z } from 'zod';
export type Row = Record<string, any>;
export type ErrorDetails={code:string,message:string,field:string|null,device_id:string|null,phase:string|null,retryable:boolean};
const reasons:Record<string,string>={
 token_expired:'This enrollment token has expired; create a new enrollment token.',
 credential_revoked:'This device credential is no longer valid; register the device again.',
 unsupported_platform:"This device's system or processor is not one the selected version runs on.",
 hardware_unvalidated:'The selected version needs a graphics card this device does not have.',
 version_setup_missing:'The selected version lacks a validated build, capacity estimate, launch specification, or draft model configuration.',
 version_compatibility:'The selected helper version is not validated with the selected service version.',
 role:'The selected version cannot run in this device role.',
 distinct_devices:'Choose different devices for the service and helper.',
 control_online:'This device must be idle, reconciled, and within its heartbeat window before starting a session.',
 build_preparation_required:'The required engine is unavailable, so this device cannot prepare the selected build.',
 engines_not_available:'This device reports no engine it can run: install an engine on it and start its device program again.',
 capacity_insufficient:'The selected model configuration exceeds available memory; select a validated smaller configuration.',
 disk_insufficient:'Free more disk space before preparing the selected version.',
 port_busy:'A test listener has not confirmed closure; finish its cleanup before reusing the port.',
 context_budget_exceeded:"The prompt and requested output exceed the model's context length; shorten one of them.",
 http_error:'The service HTTP stream failed before releasing the request; cancellation and cleanup are required.',
 startup_failure:'A required preparation or startup operation failed; the session is stopping its assigned instances.',
 service_failure:'The service instance exited or failed; the session is stopping its assigned instances.',
 service_offline:'The service control connection did not reconcile within five minutes; the session is stopping.',
 cancel_timeout:'The engine did not confirm cancellation before its deadline; the session must stop.',
 stop_timeout:'Not all assigned instances confirmed exit before the stop deadline; inspect device cleanup.',
 persistence_failed:'The request did not persist all output before its deadline; retained database chunks remain readable.',
 invalid_input:'A request field is missing, malformed, or incompatible with this operation.',
 unauthenticated:'Sign in or authenticate the device before retrying.',forbidden:'This identity cannot access the requested resource.',
 not_found:'The referenced resource does not exist.',device_busy:'The device is reserved or still has an instance requiring cleanup.',
 session_not_ready:'The service instance is not ready or its control connection has not reconciled.',request_busy:'Wait for the active request to release its engine resources.',
 preflight_failed:'One or more preflight checks failed; inspect the device and version checks.',build_mismatch:'The reported model manifest or build proof differs from the fixed version configuration.',
 direction_unreachable:'The tested helper-to-service address, port, interpreter, or measurement is no longer valid.',
 deadline_exceeded:'The persisted deadline elapsed before this operation completed.',instance_mismatch:'The report does not match the assigned device, instance, generation, or configuration.',
 chunk_conflict:'A repeated report or output usage conflicts with the persisted request evidence.',
 archive_failed:'The result object could not be saved; database output remains available.',
 file_store_failed:'The storage bucket could not be reached; try again.',
 reconcile_failed:'The original instance or complete request stream could not be reconciled.',
 cleanup_required:'A recorded process or listener remains alive; clean it up and recheck.',
 internal_error:'The server could not commit this operation; retain the unconfirmed report and retry.',
};
export class Fault extends Error {
  constructor(public code:string,public status=400,public field:string|null=null,public details:Partial<ErrorDetails>={}){super(code);}
  body():ErrorDetails{return {code:this.code,message:this.details.message??reasons[this.code]??`The operation failed because ${this.code.replaceAll('_',' ')}.`,field:this.field,device_id:this.details.device_id??null,phase:this.details.phase??null,retryable:this.details.retryable??this.status>=500};}
}
export const id=z.uuid();
const text=z.string().max(2048), number=z.number().finite().nonnegative();
export const u64=z.string().regex(/^(0|[1-9][0-9]*)$/).refine(v=>BigInt(v)<=9223372036854775807n);
export const time=z.iso.datetime({offset:true});
export const digest=z.string().regex(/^[0-9a-f]{64}$/);
export const object=z.record(z.string(),z.unknown());
export const errorSchema=z.object({code:text.min(1),message:text.min(1),field:text.nullable(),device_id:id.nullable(),phase:text.nullable(),retryable:z.boolean()}).strict();
export const EMPTY_METRICS={load_seconds:null,peak_memory_bytes:null,tokenizer_mapping_id:null,step_cost:[],effective_spec:null};
const metrics=z.object({load_seconds:number.nullable(),peak_memory_bytes:u64.nullable(),tokenizer_mapping_id:text.nullable(),step_cost:z.array(z.object({width:z.number().int().positive(),batch:z.number().int().positive(),milliseconds:number}).strict()).max(128),effective_spec:object.nullable()}).strict();
const build=z.object({source_revision:text,bridge_revision:text.nullable(),compiler:text,cuda:text.nullable(),options:object,binary_sha256:digest,libraries:z.array(z.object({path:text,sha256:digest}).strict()).max(128)}).strict();
// What a version requires of any build (BuildRequirement). A device's BuildProof meets it when its
// source and bridge versions are the required ones and it has every required option with the required value; its paths,
// digests, compilers and other options (CUDA architectures among them, checked by the device against its card) are not compared.
// Required options are strings, as a device reports them (CMake cache values such as ON, the Python version 3.12).
export const buildRequirement=z.object({source_revision:text.min(1),bridge_revision:text.min(1).nullable(),options:z.record(z.string(),text)}).strict();
export function buildDifferences(want:Row,proof:Row|null|undefined):string[]{
 if(!proof)return ['build'];
 return [...['source_revision','bridge_revision'].filter(k=>proof[k]!==want[k]),...Object.keys(want.options).filter(k=>!Object.hasOwn(proof.options??{},k)||proof.options[k]!==want.options[k]).map(k=>`options.${k}`)];
}
export const inventorySchema=z.object({agent_version:text,openinfer_revision:text,os:text,arch:text,machine_model:text,cpu_model:text,
 memory_total_bytes:u64,memory_available_bytes:u64,disk_available_bytes:u64,control_plane_reserved_bytes:u64.nullable(),
 gpus:z.array(z.object({id:text,model:text,vendor:text,total_bytes:u64,available_bytes:u64,compute_tflops:number.nullable(),bandwidth_gbps:number.nullable(),driver:text.nullable()}).strict()).max(64),
 addresses:z.array(z.object({address:z.ipv4().or(z.ipv6()),interface:text}).strict()).max(32),
 python_executables:z.array(z.object({path:text,version:text,purpose:z.enum(['agent','mlx','helper'])}).strict()).max(64),
 engines:z.array(z.object({name:text,version:text.nullable(),available:z.boolean(),build:build.nullable(),error:errorSchema.nullable()}).strict()).max(64),
 prepared_versions:z.array(z.object({version_id:text,manifest_sha256:digest,verified_at:time}).strict()).max(64),local_model_folders:z.boolean().default(false),sequence:z.number().int().positive()}).strict().transform(value=>{
 const aliases:Record<string,Record<string,string>>={os:{Darwin:'darwin',Linux:'linux'},arch:{aarch64:'arm64',AMD64:'x86_64',amd64:'x86_64'}};
 for(const key of ['os','arch'] as const){const input=value[key].trim();value[key]=aliases[key][input]??input;}
 value.machine_model=value.machine_model.trim();value.cpu_model=value.cpu_model.trim();
 for(const gpu of value.gpus){gpu.vendor=gpu.vendor.trim();gpu.model=gpu.model.trim();}
 return value;
});
export const planSchema=z.object({service_device_id:id,service_version_id:text,helpers:z.array(z.object({device_id:id,version_id:text.nullable(),draft_model:z.enum(['enabled','disabled']),acknowledge_no_draft_model:z.boolean(),connection_test_id:id}).strict()).max(64)}).strict();
// A request names one source of its prompt: the text itself, an uploaded file (files.id), or a fixed acceptance prompt.
export const inputSchema=z.object({prompt:z.string().min(1).refine(v=>Buffer.byteLength(v)<=65536).optional(),prompt_file_id:id.optional(),acceptance_prompt_id:text.optional(),max_output_tokens:z.number().int().positive().optional()}).strict().refine(v=>[v.prompt,v.prompt_file_id,v.acceptance_prompt_id].filter(x=>x!==undefined).length===1);
export const testPlanSchema=z.object({source_device_id:id,target_device_id:id,target_addresses:z.array(z.ipv4().or(z.ipv6())).min(1).max(32),port:z.number().int().min(1).max(65535),listener_python:text}).strict();
export const timingSchema=z.object({clock_id:text.nullable(),engine_received_ns:u64.nullable(),engine_first_output_ns:u64.nullable(),engine_last_output_ns:u64.nullable(),engine_first_chunk_tokens:z.number().int().nonnegative().nullable(),engine_finished_ns:u64.nullable(),engine_started_at:time.nullable(),engine_finished_at:time.nullable()}).strict();
export const statisticsSchema=z.object({helper_draft_tokens:u64.nullable(),helper_verified_tokens:u64.nullable(),accepted_external_tokens:u64.nullable(),think_end_position:u64.nullable()}).strict();
export const endSchema=z.object({request_id:id,instance_id:id,final_seq:u64,outcome:z.enum(['completed','failed','cancelled']),reason:z.enum(['eos','length','cancelled','error']),released:z.boolean(),prompt_tokens:z.number().int().nonnegative().nullable(),output_tokens:u64,timing:timingSchema,statistics:statisticsSchema,error:errorSchema.nullable()}).strict();
const instance=z.object({instance_id:id,session_id:id,agent_boot_id:id,generation:z.number().int().positive(),state:z.enum(['starting','loading','connectable','ready','stopping','stopped','failed','cleanup_required']),phase:text,config_sha256:digest,processes:z.array(z.object({pid:z.number().int().positive(),process_group_id:z.number().int().positive(),alive:z.boolean()}).strict()).max(128),http_healthy:z.boolean(),push_listening:z.boolean(),calibrated:z.boolean(),inventory_after:z.number().int().positive().nullable(),metrics,error:errorSchema.nullable()}).strict();
export const messages:Record<string,z.ZodType>={
 heartbeat:z.object({agent_boot_id:id,inventory:inventorySchema,instances:z.array(instance).max(128)}).strict(),
 reconcile:z.object({agent_boot_id:id,inventory:inventorySchema,instances:z.array(instance).max(128),commands:z.array(z.object({command_id:id,state:z.enum(['pending','executing','completed','failed','cancelled']),result:object.nullable(),error:errorSchema.nullable()}).strict()).max(128),requests:z.array(z.object({request_id:id,instance_id:id,http_stream_alive:z.boolean(),local_contiguous_seq:u64,local_final_seq:u64.nullable(),complete_buffer:z.boolean(),end:endSchema.nullable()}).strict()).max(128)}).strict(),
 'command.ack':z.object({command_id:id,state:z.enum(['executing','completed','failed','cancelled'])}).strict(),
 'command.progress':z.object({command_id:id,phase:z.enum(['prepare','download','build','verify','load','calibrate','connect','warmup','drain','term','kill']),completed_bytes:u64.nullable(),total_bytes:u64.nullable(),message:text}).strict(),
 'command.result':z.object({command_id:id,outcome:z.enum(['completed','failed','cancelled']),result:object,error:errorSchema.nullable()}).strict(),
 'instance.status':instance,
 'peer.status':z.object({session_id:id,instance_id:id,writer_id:id,connection_generation:z.number().int().positive(),push_connection_id:id,state:z.enum(['connected','disconnected']),authenticated:z.boolean(),error:errorSchema.nullable()}).strict(),
 'test.listening':z.object({command_id:id,test_id:id,bound_addresses:z.array(z.ipv4().or(z.ipv6())).min(1).max(32),port:z.number().int().min(1).max(65535),python:text}).strict(),
 'test.result':z.object({command_id:id,test_id:id,source_address:z.ipv4().or(z.ipv6()).nullable(),target_address:z.ipv4().or(z.ipv6()).nullable(),port:z.number().int().min(1).max(65535),nonce_matched:z.boolean(),rtt_samples_ms:z.array(number).max(10),transfer_bytes:u64,transfer_ms:number.nullable(),error:errorSchema.nullable()}).strict(),
 'request.accepted':z.object({request_id:id,instance_id:id,prompt_tokens:z.number().int().nonnegative(),effective_max_output:z.number().int().positive(),committed_position:u64,timing:timingSchema}).strict(),
 'output.chunk':z.object({request_id:id,instance_id:id,seq:u64.refine(x=>BigInt(x)>0),text:z.string().refine(x=>Buffer.byteLength(x)<=65536),token_count:z.number().int().min(0).max(32),committed_position:u64,segment:z.enum(['think','answer']),engine_first_output_ns:u64.nullable(),engine_last_output_ns:u64.nullable(),engine_first_chunk_tokens:z.number().int().nonnegative().nullable()}).strict(),
 'request.end':endSchema,
};
export const envelope=z.object({v:z.literal(1),type:text,message_id:id,connection_id:id,device_id:id,sent_at:time,payload:object}).strict();
export const EMPTY_TIMING={clock_id:null,engine_received_ns:null,engine_first_output_ns:null,engine_last_output_ns:null,engine_first_chunk_tokens:null,engine_finished_ns:null,engine_started_at:null,engine_finished_at:null};
export const EMPTY_STATS={helper_draft_tokens:null,helper_verified_tokens:null,accepted_external_tokens:null,think_end_position:null};
export function parse<T>(schema:z.ZodType<T>,data:unknown):T {const v=schema.safeParse(data);if(!v.success)throw new Fault('invalid_input',400,v.error.issues[0]?.path.join('.')??null);return v.data;}

// The result discriminator is the persisted command kind, never device input.
export function parseCommandResult(kind:string,outcome:string,value:unknown):Row {
 const schemas:Record<string,z.ZodType>={
  prepare:z.object({manifest_sha256:digest,build,prepared_version_id:text}).strict(),
  start_service:z.object({instance}).strict(),start_helper:z.object({instance}).strict(),
  warmup:z.object({resource_sha256:digest,output_tokens:u64,timing:timingSchema}).strict(),
  run_request:z.object({request_id:id,final_seq:u64}).strict(),
  cancel_request:z.object({request_id:id,released:z.boolean()}).strict(),
  stop:z.object({instances:z.array(instance).max(128),ports_free:z.boolean(),inventory:inventorySchema.optional()}).strict(),
  recheck:z.object({instances:z.array(instance).max(128),ports_free:z.boolean(),inventory:inventorySchema.optional()}).strict(),
 };
 for(const test of ['listen_test','connect_test','close_test'])schemas[test]=z.object({test_id:id,listener_closed:z.boolean()}).strict();
 const schema=schemas[kind];if(!schema)throw new Fault('invalid_input');
 const result=parse(outcome==='completed'?schema:z.union([z.object({}).strict(),schema]),value) as Row;
 if(outcome==='completed'&&kind==='cancel_request'&&!result.released)throw new Fault('invalid_input');
 return result;
}
const publicEnvironment=new Set(['PYTHONUNBUFFERED','PYTHONDONTWRITEBYTECODE','HF_HUB_OFFLINE']);
export function sanitizeDiagnostic(value:unknown,secrets:string[]=[]):any {
 if(typeof value==='string'){let clean=value;for(const secret of secrets)if(secret)clean=clean.split(secret).join('[redacted]');return clean;}
 if(Array.isArray(value))return value.map(item=>sanitizeDiagnostic(item,secrets));
 if(value&&typeof value==='object'){const result:Row={};for(const [key,item]of Object.entries(value)){
   if(['env','environment','effective_env','child_env'].includes(key)&&item&&typeof item==='object')result[key]=Object.fromEntries(Object.entries(item).filter(([name])=>publicEnvironment.has(name)).map(([name,v])=>[name,sanitizeDiagnostic(v,secrets)]));
   else result[key]=sanitizeDiagnostic(item,secrets);
  }return result;}
 return value;
}

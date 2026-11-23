import { z } from 'zod';
import { resolve,sep } from 'node:path';
import { buildRequirement,digest,u64 } from './protocol.js';
import type { Options } from './control.js';
import type { Registration } from './auth.js';
const name=z.string().min(1).max(2048);
const file=z.object({path:name.refine(p=>!p.startsWith('/')&&!p.includes('\\')&&!p.split('/').includes('..')),sha256:digest,size_bytes:u64}).strict();
// A value of the session entry: a plain JSON value, or a placeholder "{name}" the control plane replaces with the
// session's value of that name (sessionEntry in control.ts): think_end_id, writer_id, gpu, peers,
// context_length, max_requests, and each key of the model's sampling. The device decides which keys an entry of its kind
// may set and refuses anything else.
const plain:z.ZodType<unknown>=z.lazy(()=>z.union([z.string(),z.number().finite(),z.boolean(),z.null(),z.array(plain),z.record(z.string(),plain)]));
const params=z.record(z.string(),plain);
// The session entry of a version: what the control plane
// hands the device for this version, beside the files the device resolves itself.
const entry=z.object({files:z.record(z.string(),name),command:params,environment:params,tier:params.optional(),table:z.object({command:params}).strict().optional()}).strict();
const platform=z.object({os:name,arch:name,gpu_vendor:name.nullable()}).strict();
const version=z.object({id:name,role:z.enum(['service','helper']),label:name,model:name,repo:name,revision:name,quantization:name,files:z.array(file),manifest_sha256:digest.nullable(),engine:name,
 kind:name,entry,entry_without_draft:entry.optional(),platform,max_requests:z.number().int().positive().optional(),build_requirements:buildRequirement.nullable(),
 draft_model:z.object({enabled:z.boolean(),mechanism:name.nullable(),draft_repo:name.nullable(),draft_revision:name.nullable(),files:z.array(file),parameters:z.record(z.string(),z.union([z.string(),z.number().finite(),z.boolean(),z.null()]))}).strict().nullable(),
 tokenizer:z.object({repo:name,revision:name,files:z.array(file)}).strict().optional(),
 compatible_service_version_ids:z.array(name),validation:z.object({hardware:z.array(name),evidence:z.array(name),complete:z.boolean(),missing:z.array(name)}).strict(),
}).strict();
// What a model is, the same for each of its versions: its context length, the id of the token that ends its thinking
// (null for a model that does not think), the sampling its requests use.
const model=z.object({context_length:z.number().int().positive(),think_end_id:z.number().int().nonnegative().nullable(),
 sampling:z.object({temperature:z.number().positive(),top_p:z.number().positive().max(1),top_k:z.number().int().positive(),min_p:z.number().min(0),presence_penalty:z.number()}).strict()}).strict();
const schema=z.object({catalog:z.object({models:z.record(z.string(),model),versions:z.array(version)}).strict(),requirements:z.record(z.string(),z.object({memory_bytes:u64.refine(v=>BigInt(v)>0),disk_bytes:u64,precision_rank:z.number().int().positive().optional(),without_draft_allowed:z.boolean().optional()}).strict()),warmup:z.object({resource_id:name,sha256:digest,max_output_tokens:z.literal(256)}).strict().optional(),acceptance:z.array(z.object({id:name,label:name,resource_sha256:digest,token_ids:z.array(z.number().int().nonnegative()).min(1),seed:u64,max_output_tokens:z.number().int().positive()}).strict()).optional()}).strict().superRefine((v,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 const ids=v.catalog.versions.map(x=>x.id);if(new Set(ids).size!==ids.length)fail('Duplicate version ID');
 for(const x of v.catalog.versions){
  if(!v.catalog.models[x.model])fail(`The version ${x.id} names the model ${x.model}, which the catalog does not describe`);
  if(x.role==='service'&&x.max_requests===undefined)fail(`The service version ${x.id} names no max_requests`);
  if(x.compatible_service_version_ids.some(id=>!v.catalog.versions.some(candidate=>candidate.id===id&&candidate.role==='service'&&candidate.model===x.model)))fail('Unknown compatible service version');
  if(x.validation.complete){
   if(x.role==='helper'&&!x.compatible_service_version_ids.length)fail('Missing validated service pairing');
   if(!x.manifest_sha256||!x.files.length||!x.build_requirements||!v.requirements[x.id]||x.validation.missing.length||!x.validation.evidence.length)fail('Incomplete validated version');
   if(x.role==='helper'&&(!x.draft_model||(x.draft_model.enabled&&(!x.draft_model.mechanism||!x.draft_model.draft_repo||!x.draft_model.draft_revision))))fail('Missing measured helper configuration');
   // Placement orders its candidates by this rank (1 is the most precise)
   if(x.role==='helper'&&x.draft_model?.enabled&&v.requirements[x.id]?.precision_rank===undefined)fail('Missing precision rank');
  }
 }
 const acceptance=v.acceptance??[],context=Math.min(...Object.values(v.catalog.models).map(m=>m.context_length));if(new Set(acceptance.map(x=>x.id)).size!==acceptance.length)fail('Duplicate acceptance resource');
 for(const p of acceptance)if(p.token_ids.length+p.max_output_tokens>context)fail('Acceptance context budget exceeded');
});
export function parseDeployment(value?:unknown):Pick<Options,'catalog'|'requirements'|'warmup'|'acceptance'>{
 if(value===undefined)return {catalog:{models:{},versions:[]},requirements:{}};
 return schema.parse(value);
}
/** OPENINFER_REGISTRATION: unset or `open` lets anyone who reaches the site create an account; `closed` refuses new ones. */
export function parseRegistration(value:string|undefined):Registration{
 if(value===undefined||value===''||value==='open')return 'open';
 if(value==='closed')return 'closed';
 throw new Error(`OPENINFER_REGISTRATION must be open or closed, not ${JSON.stringify(value)}`);
}
/** Where `npm run demo` serves and `npm run devices` looks for it: OPENINFER_ORIGIN, else localhost at PORT (8443). */
export function localOrigin(env:Record<string,string|undefined>):string{return env.OPENINFER_ORIGIN||`https://localhost:${env.PORT||8443}`;}
/** The certificate file (OPENINFER_TLS_CERT) as the API keys page shows it: absolute, a path in HOME written with ~. */
export function certificateShown(path:string,home:string,cwd:string):string{
 const absolute=resolve(cwd,path),prefix=home.endsWith(sep)?home:home+sep;
 return home&&absolute.startsWith(prefix)?'~'+sep+absolute.slice(prefix.length):absolute;
}

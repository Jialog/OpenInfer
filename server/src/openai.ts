// The OpenAI-compatible routes on the control plane's HTTPS port. /v1 takes only an API key
// (Authorization: Bearer), never the browser cookie, and answers errors in OpenAI's shape. A request goes through the same
// transaction, command, chunks, archive and fault handling as a website request (ControlPlane.submitApiRequest); this
// module translates the fields and turns the persisted chunks into a response or server-sent events.
import express,{ type Request,type Response,type NextFunction,type Router } from 'express';
import type { ApiCaller,ApiInput,ControlPlane,User } from './control.js';
import { Fault,type Row } from './protocol.js';

/** The largest top_k: not below the vocabulary (248320 tokens), so it means no cut. A larger value would reach the helper,
 *  whose llama.cpp bridge reads top_k into a C int. */
export const TOP_K_MAX=262144;
const MAX_MESSAGES=1024;
const KEEPALIVE_MS=15000;
const PAGE=64;      // chunks read and written per step of a stream (at most 64 x 64 KiB of text held for one client)
const TYPES:Record<number,string>={401:'authentication_error',429:'rate_limit_error'};
const invalid=(param:string|null,message:string)=>new Fault('invalid_value',400,param,{message});
const unsupported=(param:string,message:string)=>new Fault('unsupported_parameter',400,param,{message});
const absent=(v:unknown)=>v===undefined||v===null;
const terminal=(state:string)=>['completed','failed','cancelled'].includes(state);

/** OpenAI's error body for a Fault: {error:{message,type,param,code}}. */
function errorBody(f:Fault){return {error:{message:f.body().message,type:TYPES[f.status]??(f.status>=500?'server_error':'invalid_request_error'),param:f.field,code:f.code}};}

// Features this server does not have, with the values that mean "off": anything else is refused.
const OFF:Record<string,(v:any)=>boolean>={presence_penalty:v=>v===0,frequency_penalty:v=>v===0,min_p:v=>v===0,logprobs:v=>v===false,top_logprobs:()=>false,
 logit_bias:v=>typeof v==='object'&&!Array.isArray(v)&&!Object.keys(v).length,response_format:v=>v?.type==='text',tools:v=>Array.isArray(v)&&!v.length,functions:v=>Array.isArray(v)&&!v.length,
 tool_choice:v=>v==='none',function_call:v=>v==='none',audio:()=>false,modalities:v=>Array.isArray(v)&&v.length===1&&v[0]==='text',prediction:()=>false,web_search_options:()=>false};

function number(b:Row,key:string,fallback:number,ok:(v:number)=>boolean,rule:string,integer=false):number{
 const v=b[key];if(absent(v))return fallback;
 if(typeof v!=='number'||!Number.isFinite(v)||(integer&&!Number.isInteger(v))||!ok(v))throw invalid(key,`${key} must be ${rule}.`);
 return v;
}

/** The fields of one chat completion request; unknown fields are ignored. */
export function parseChat(body:unknown,models:string[]):ApiInput{
 if(!body||typeof body!=='object'||Array.isArray(body))throw invalid(null,'The request body must be a JSON object.');
 const b=body as Row;
 const here=models.map(m=>`"${m}"`).join(', ')||'none';
 if(typeof b.model!=='string'||!b.model)throw invalid('model',`model is required; the models here are ${here}.`);
 if(!models.includes(b.model))throw new Fault('model_not_found',404,'model',{message:`The model "${b.model}" does not exist; the models here are ${here}.`});
 if(!Array.isArray(b.messages)||!b.messages.length)throw invalid('messages','messages must be a non-empty list of messages.');
 if(b.messages.length>MAX_MESSAGES)throw invalid('messages',`messages may hold at most ${MAX_MESSAGES} messages.`);
 const messages=b.messages.map((m:any)=>{
  if(!m||typeof m!=='object')throw invalid('messages','Each message must be an object with a role and content.');
  if(m.role==='tool'||m.role==='function'||!absent(m.function_call)||!(absent(m.tool_calls)||Array.isArray(m.tool_calls)&&!m.tool_calls.length))throw unsupported('messages','Tool calls are not supported.');
  const role=m.role==='developer'?'system':m.role;if(!['system','user','assistant'].includes(role))throw invalid('messages',`Unknown message role ${JSON.stringify(m.role)}.`);
  let content:string;
  if(typeof m.content==='string')content=m.content;
  else if(absent(m.content))content='';
  else if(Array.isArray(m.content))content=m.content.map((part:any)=>{if(part?.type!=='text'||typeof part.text!=='string')throw unsupported('messages','Only text content is supported.');return part.text;}).join('');
  else throw invalid('messages','A message content must be a string or a list of text parts.');
  return {role,content};
 });
 if(Buffer.byteLength(messages.map((m:Row)=>m.content).join(''))>65536)throw invalid('messages','The messages together are longer than 64 KiB.');
 for(const [key,off]of Object.entries(OFF))if(!absent(b[key])&&!off(b[key]))throw unsupported(key,`${key} is not supported by OpenInfer.`);
 const kwargs=b.chat_template_kwargs;if(!absent(kwargs)&&(typeof kwargs!=='object'||Array.isArray(kwargs)))throw invalid('chat_template_kwargs','chat_template_kwargs must be an object.');
 if(kwargs?.enable_thinking===false)throw unsupported('chat_template_kwargs','This model always thinks before it answers; thinking cannot be turned off.');
 if(!absent(b.n)&&b.n!==1)throw invalid('n','n must be 1: one choice per request.');
 if(!absent(b.stream)&&typeof b.stream!=='boolean')throw invalid('stream','stream must be a boolean.');
 const options=b.stream_options;if(!absent(options)&&(typeof options!=='object'||Array.isArray(options)||!absent(options.include_usage)&&typeof options.include_usage!=='boolean'))throw invalid('stream_options','stream_options must be an object whose include_usage is a boolean.');
 const budget=absent(b.max_completion_tokens)?'max_tokens':'max_completion_tokens',max=number(b,budget,0,v=>v>=1,'an integer of at least 1',true);
 const stop=absent(b.stop)?[]:typeof b.stop==='string'?[b.stop]:b.stop;
 if(!Array.isArray(stop)||stop.length>4||!stop.every((w:unknown)=>typeof w==='string'))throw invalid('stop','stop must be a string or a list of at most 4 strings.');
 if(b.temperature!==undefined&&typeof b.temperature==='number'&&b.temperature<=0)throw invalid('temperature','OpenInfer samples its output and cannot decode greedily: use a temperature above 0 (the default is 1.0).');
 const temperature=number(b,'temperature',1,v=>v>0&&v<=2,'a number in (0, 2]'),top_p=number(b,'top_p',0.95,v=>v>0&&v<=1,'a number in (0, 1]'),top_k=number(b,'top_k',20,v=>v>=1&&v<=TOP_K_MAX,`an integer from 1 to ${TOP_K_MAX} (${TOP_K_MAX}, not below the vocabulary, means no cut)`,true);
 const seed=absent(b.seed)?null:String(number(b,'seed',0,v=>v>=0&&v<2**53,'an integer in [0, 2^53)',true));
 return {model:b.model,messages,stop:stop.filter((w:string)=>w),max_output_tokens:max||null,seed,sampling:{temperature,top_p,top_k,min_p:0,presence_penalty:0},stream:b.stream===true,include_usage:options?.include_usage===true};
}

// A request that ended before any output keeps an HTTP status; mid-stream it is an error event.
function requestFault(r:Row):Fault{
 const e=r.error??{};
 if(r.state==='cancelled')return new Fault('request_cancelled',503,null,{message:r.cancel_reason==='session_stop'?'The session stopped before this request finished.':`The request was cancelled (${r.cancel_reason??'cancelled'}).`});
 if(e.code==='context_budget_exceeded')return new Fault('context_length_exceeded',400,'messages',{message:e.message});
 if(e.code==='invalid_input')return new Fault('invalid_request',400,null,{message:e.message});
 return new Fault(e.code??'internal_error',500,null,{message:e.message??'The request failed.'});
}
const head=(r:Row,object:string,model:string)=>({id:`chatcmpl-${r.id}`,object,created:Math.floor(new Date(r.received_at).getTime()/1000),model});
const extension=(r:Row)=>({request_id:r.id,session_id:r.session_id,seed:r.seed,sampling:r.sampling,effective_max_output:r.effective_max_output});
const usage=(r:Row)=>({prompt_tokens:r.prompt_tokens??0,completion_tokens:Number(r.output_tokens),total_tokens:(r.prompt_tokens??0)+Number(r.output_tokens)});
const finishReason=(r:Row)=>r.engine_end?.reason==='length'?'length':'stop';

// Follows one request through the plane's change events (the browser WebSocket's source) and reads it once at the
// start, so nothing committed before the subscription is missed. step() runs under the read lock; true ends the follow;
// {wait} runs it again once WAIT settles, outside the lock (a client's socket to drain, or the next page).
type Step=boolean|{wait:Promise<unknown>};
function follow(plane:ControlPlane,rid:string,step:()=>Promise<Step>){
 let running=false,again=false,done=false,settle!:(error?:unknown)=>void;
 const finished=new Promise<void>((resolve,reject)=>{settle=error=>{if(done)return;done=true;plane.off('changed',listener);if(error)reject(error);else resolve();};});
 const run=async()=>{if(done)return;if(running){again=true;return;}running=true;
  try{do{again=false;const next=await plane.withReadLock(step);if(next===true){settle();return;}if(next!==false){await next.wait;again=true;}}while(again&&!done);}catch(error){settle(error);}finally{running=false;}};
 const listener=(changes:unknown)=>{if(Array.isArray(changes)&&changes.some((x:Row)=>x.id===rid||x.request_id===rid))void run();};
 plane.on('changed',listener);void run();
 return {finished,stop:()=>settle()};
}

/** The blank lines the model writes after </think> before its answer are not part of the answer; the indentation
 *  of its first line is. An answer of white space alone is "". */
const BLANK_LINES=/^(?:[ \t]*\r?\n)+/,INDENT_ONLY=/^[ \t]*$/;
const answerStart=(text:string)=>{const rest=text.replace(BLANK_LINES,'');return INDENT_ONLY.test(rest)?'':rest;};
async function chat(plane:ControlPlane,caller:ApiCaller,req:Request,res:Response,stopping:()=>boolean){
 const input=parseChat(req.body,Object.keys(plane.options.catalog.models)),user:User={user_id:caller.user_id,group_id:caller.group_id};
 let rid:string|null=null,gone=false,stop=()=>{};
 // A client that goes away cancels its request, also while the request is being created; a
 // connection the control plane drops because it is stopping does not (rule 3): the request runs on.
 res.on('close',()=>{if(res.writableEnded)return;gone=true;stop();if(rid&&!stopping())void plane.clientDisconnected(user,rid).catch(()=>console.error('api disconnect cancellation failed',{code:'internal_error'}));});
 rid=await plane.submitApiRequest(caller,input);
 if(gone){if(!stopping())await plane.clientDisconnected(user,rid);return;}
 const id=rid;let after='0',started=false,answering=false,held='',lastWrite=Date.now();
 const read=async(r:Row)=>{const chunks:Row[]=[];while(BigInt(after)<BigInt(r.contiguous_seq)){const page=await plane.getChunks(user,id,after,1000);if(!page.chunks.length)break;chunks.push(...page.chunks);after=page.chunks.at(-1).seq;}return chunks;};
 // false: the socket holds what it was given and more must wait for its drain (or its close)
 const send=(data:unknown)=>{const ok=res.write(`data: ${typeof data==='string'?data:JSON.stringify(data)}\n\n`);lastWrite=Date.now();return ok;};
 const drained=()=>new Promise<void>(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.on('drain',done);res.on('close',done);});
 const watch=follow(plane,id,async()=>{
  const r=await plane.getRequest(user,id);
  if(!input.stream){
   if(!terminal(r.state))return false;
   if(r.state!=='completed')throw requestFault(r);
   const chunks=await read(r),text=(segment:string)=>chunks.filter(x=>(x.segment??'answer')===segment).map(x=>x.text).join('');
   res.json({...head(r,'chat.completion',input.model),choices:[{index:0,message:{role:'assistant',content:answerStart(text('answer')),reasoning_content:text('think')},finish_reason:finishReason(r),logprobs:null}],usage:usage(r),openinfer:extension(r)});
   return true;
  }
  if(!started){
   // 200 only once the serving machine has accepted the request: refusals before that keep their HTTP status.
   if(r.prompt_tokens===null&&r.contiguous_seq==='0'){if(terminal(r.state))throw requestFault(r);return false;}
   res.status(200).set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache'});res.flushHeaders();started=true;
   send({...head(r,'chat.completion.chunk',input.model),choices:[{index:0,delta:{role:'assistant',content:''},logprobs:null,finish_reason:null}],openinfer:extension(r)});
  }
  // one page of chunks a step, the cursor `after` advanced chunk by chunk; a full socket or a further page ends the
  // step, and the stream goes on outside the read lock
  let open=true;
  if(BigInt(after)<BigInt(r.contiguous_seq))for(const chunk of (await plane.getChunks(user,id,after,PAGE)).chunks){
   after=chunk.seq;const think=chunk.segment==='think';let text=chunk.text;
   // Before the answer has started, white space is held: blank lines are dropped at their newline, and what may be the
   // first line's indentation goes out with that line's first other character (or never, if none comes).
   if(!think&&!answering){held=(held+text).replace(BLANK_LINES,'');if(INDENT_ONLY.test(held))continue;text=held;held='';answering=true;}
   if(text)open=send({...head(r,'chat.completion.chunk',input.model),choices:[{index:0,delta:think?{reasoning_content:text}:{content:text},logprobs:null,finish_reason:null}]})&&open;
  }
  if(!open)return {wait:drained()};
  if(BigInt(after)<BigInt(r.contiguous_seq))return {wait:Promise.resolve()};
  if(r.state==='completed'){
   send({...head(r,'chat.completion.chunk',input.model),choices:[{index:0,delta:{},logprobs:null,finish_reason:finishReason(r)}]});
   if(input.include_usage)send({...head(r,'chat.completion.chunk',input.model),choices:[],usage:usage(r)});
   send('[DONE]');res.end();return true;
  }
  if(r.state==='failed'||r.state==='cancelled'){send(errorBody(requestFault(r)));res.end();return true;}
  return false;
 });
 stop=watch.stop;
 const keepalive=setInterval(()=>{if(started&&!res.writableEnded&&Date.now()-lastWrite>=KEEPALIVE_MS){res.write(': keepalive\n\n');lastWrite=Date.now();}},KEEPALIVE_MS/3);keepalive.unref();
 try{await watch.finished;}finally{clearInterval(keepalive);}
}

/** The /v1 routes. Every route needs an API key; /v1/models lists the catalog's models whether or not a session runs. stop(), when
 *  the control plane stops, drops the open chat responses (a stream would otherwise hold the HTTPS server open) without
 *  cancelling their requests. */
export function createOpenAiRouter(plane:ControlPlane):Router&{stop:()=>void}{
 const router=express.Router(),created=Math.floor(Date.now()/1000),open=new Set<Response>();let stopping=false;
 // Once the control plane is stopping, a new request is refused before anything is looked up or created.
 router.use((_req,res,next)=>{if(!stopping){next();return;}res.set('Connection','close');next(new Fault('server_stopping',503,null,{message:'The control plane is stopping; send the request again once it has restarted.'}));});
 router.use((req,res,next)=>{plane.authenticateApiKey(req.get('authorization')).then(caller=>{res.locals.caller=caller;next();},next);});
 router.get('/models',(_req,res)=>{res.json({object:'list',data:Object.keys(plane.options.catalog.models).map(id=>({id,object:'model',created,owned_by:'openinfer'}))});});
 router.post('/chat/completions',(req,res,next)=>{open.add(res);res.on('close',()=>open.delete(res));chat(plane,res.locals.caller,req,res,()=>stopping).catch(next);});
 router.use((req,_res,next)=>next(new Fault('not_found',404,null,{message:`${req.method} /v1${req.path} does not exist here; OpenInfer serves /v1/models and /v1/chat/completions.`})));
 return Object.assign(router,{stop:()=>{stopping=true;for(const res of open)res.destroy();}});
}

/** Errors under /v1, including a body that is not JSON or is over 1 MiB, in OpenAI's shape. */
export function openAiErrors(error:any,_req:Request,res:Response,_next:NextFunction){
 const fault=error instanceof Fault?error:error?.type==='entity.too.large'?new Fault('request_too_large',413,null,{message:'The request body is larger than 1 MiB.'})
  :error instanceof SyntaxError?invalid(null,'The request body is not valid JSON.'):new Fault('internal_error',500,null,{message:'The server could not complete the request.'});
 if(fault.status>=500&&!(error instanceof Fault))console.error('api request failed',{code:fault.code});
 if(res.headersSent){res.end();return;}
 if(fault.code==='request_busy')res.set('Retry-After','10');
 res.status(fault.status).json(errorBody(fault));
}

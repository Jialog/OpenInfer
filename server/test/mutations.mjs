#!/usr/bin/env node
/**
 * Mutation harness: each mutant plants one fault in the server's source, and a
 * behavior test must fail for it. M01..M41 are faults of the session, device,
 * command and request handling (listed with their tests in
 * behavior-coverage.test.ts); X1..X5 and X7..X10 remove guards; B1 drops the
 * bridge revision from the build comparison; P1..P14 break the rules of
 * Placement and hardware admission; U1..U18 break the rules of the user API.
 * Run from server/ once the behavior suite is green. An invalid or unapplied
 * mutant is never counted killed.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const behavior = ['test/behavior-coverage.test.ts', 'test/review-guards.test.ts'];
const existing = (file, pattern) => [file, '--test-name-pattern', pattern];
const covered = pattern => existing('test/behavior-coverage.test.ts', pattern);
const guarded = pattern => existing('test/review-guards.test.ts', pattern);
const placed = pattern => existing('test/placement.test.ts', pattern);
const api = pattern => existing('test/user-api.test.ts', pattern);
const m = (id, title, file, find, replace, tests = behavior) => ({ id, title, file, find, replace, tests });

export const MUTANTS = [
  m('M01','helper exit no longer degrades','src/control.ts',"if(s.state==='starting'||ins.spec.role==='target'){await this.beginStop(c,s,s.state==='starting'?'startup_failure':'service_failure');return;}\n  if(s.state==='ready')await this.move(c,'sessions',s,'helper_disconnected');","if(s.state==='starting'||ins.spec.role==='target'){await this.beginStop(c,s,s.state==='starting'?'startup_failure':'service_failure');return;}\n  if(s.state==='ready')void 0;",covered('session exits, disconnects, and terminal cleanup')),
  m('M02','startup offline no longer stops','src/control.ts',"for(const ref of refs){const session=await this.one(c,'sessions',ref.session_id);if(session.state==='starting')await this.beginStop(c,session,'startup_failure');}","for(const ref of refs){const session=await this.one(c,'sessions',ref.session_id);if(session.state==='starting')void 0;}",covered('offline and disconnect deadlines preserve')),
  m('M03','warmup before the serving machine reports the helper connected','src/control.ts',"&&h.push_connection_id!==null&&h.peer_instance_id===service.id","",covered('startup sequencing requires')),
  m('M04','degraded service disconnect deadline ignored','src/control.ts',"['ready','degraded'].includes(session.state)&&this.expired(session.service_disconnect_deadline_at)","session.state==='ready'&&this.expired(session.service_disconnect_deadline_at)",covered('offline and disconnect deadlines preserve')),
  m('M05','blocked session accepts submissions','src/control.ts',"if(!['ready','degraded'].includes(s.state)||s.submissions_blocked)","if(!['ready','degraded'].includes(s.state))",covered('serving machine is gone is refused as not ready')),
  m('M06','helper control loss stops session','src/control.ts',"WHERE sd.device_id=$1 AND sd.role='service' AND sd.released_at IS NULL AND s.state IN ('ready','degraded')", "WHERE sd.device_id=$1 AND sd.role='helper' AND sd.released_at IS NULL AND s.state IN ('ready','degraded')",covered('offline and disconnect deadlines preserve')),
  m('M07','reconnect skips cleanup of live old instance','src/control.ts',"if(!old.stopped_at){await this.cancelCommands(c,\"instance_id=$1 AND kind IN ('prepare','start_helper')\",[old.id]);const stop=await this.cleanupInstance(c,d,old,'manual_reconnect');if(stop.payload.reason!=='manual_reconnect')await update(c,'commands',stop.id,{payload:{...stop.payload,reason:'manual_reconnect'}});}","if(!old.stopped_at){await this.startReplacement(c,s,d,old);}",covered('manual helper reconnect enforces')),
  m('M08','reconnect ignores invalid actual path','src/control.ts',"if(!this.pathValid(t,d,target)||t.source_device_id!==deviceId||!t.listener_closed_at)","if(false)",covered('manual helper reconnect enforces')),
  m('M09','terminal late activity omits cleanup','src/control.ts',"if(terminalSession(session.state)&&p.state!=='stopped'){\n   await this.move(c,'sessions',session,'late_activity',{}, {dispatch_late_cleanup:()=>this.cleanupInstance(c,d,ins,'late_activity')});return;\n  }","if(terminalSession(session.state)&&p.state!=='stopped'){return;}",covered('session exits, disconnects, and terminal cleanup')),
  m('M10','preflight ignores direction','src/control.ts',"t.source_device_id===helper.id&&t.target_device_id===service.id", "true",covered('preflight independently checks')),
  m('M11','preflight ignores test expiry','src/control.ts',"&&!this.expired(t.valid_until)", "&&true",covered('preflight independently checks')),
  m('M12','preflight ignores open listener','src/control.ts',"&&t.listener_closed_at!==null", "&&true",covered('preflight independently checks')),
  m('M13','preflight ignores device occupancy','src/control.ts',"d.state==='idle'&&d.reconciled_at!==null", "d.reconciled_at!==null",covered('preflight independently checks')),
  m('M14','preflight ignores capacity','src/control.ts',"available>=BigInt(required.memory_bytes)", "true",covered('preflight independently checks')),
  m('M15','service removal does not stop','src/control.ts',"if(ref.role==='service'||s.state==='starting')await this.beginStop", "if(s.state==='starting')await this.beginStop",covered('permanent removal applies')),
  m('M16','helper removal does not degrade','src/control.ts',"else if(s.state==='ready')await this.move(c,'sessions',s,'helper_disconnected');", "else if(s.state==='ready')void 0;",covered('permanent removal applies')),
  m('M17','retry changes command id','src/control.ts',"command_id:cmd.id,device_id:cmd.device_id", "command_id:randomUUID(),device_id:cmd.device_id",covered('command retry preserves')),
  m('M18','retry resets ack deadline','src/control.ts',"ack_deadline_at:cmd.ack_deadline_at??this.after(30000)", "ack_deadline_at:this.after(30000)",covered('command retry preserves')),
  m('M19','late command result omits cleanup','src/control.ts',"if(cmd.session_id&&['prepare','start_service','start_helper','warmup'].includes(cmd.kind)&&cmd.instance_id)", "if(false&&cmd.session_id&&['prepare','start_service','start_helper','warmup'].includes(cmd.kind)&&cmd.instance_id)",covered('late startup result creates cleanup')),
  m('M20','duplicate chunk extends no-output deadline','src/control.ts',"if(old){if(old.text!==p.text||old.token_count!==p.token_count||old.segment!==p.segment)", "if(old){await update(c,'requests',request.id,{no_output_deadline_at:this.after(600000)});if(old.text!==p.text||old.token_count!==p.token_count||old.segment!==p.segment)",covered('request deadlines and duplicate chunks')),
  m('M21','drain expiry does not cancel request','src/control.ts',"if(this.expired(session.drain_deadline_at)){const requests=", "if(false&&this.expired(session.drain_deadline_at)){const requests=",covered('request deadlines and duplicate chunks')),
  m('M22','reconcile accepts missing stream proof','src/control.ts',"if(!report||!report.complete_buffer||(!report.http_stream_alive&&!report.end)", "if(false&&(!report||!report.complete_buffer||(!report.http_stream_alive&&!report.end))",existing('test/recovery.test.ts','cannot prove the original request stream')),
  m('M23','request disconnect expiry ignored','src/control.ts',"if(this.expired(request.disconnect_deadline_at))", "if(false&&this.expired(request.disconnect_deadline_at))",covered('still fails at its disconnect deadline')),
  m('M24','pending recovery leaves disconnect deadline','src/control.ts',"if(r.state==='pending'){await update(c,'requests',r.id,{disconnect_deadline_at:null});continue;}", "if(r.state==='pending'){continue;}",existing('test/recovery.test.ts','crosses its deadline loses the deadline')),
  m('M25','expired end report completes successfully','src/control.ts',"if(this.expired(r.persistence_deadline_at)&&r.state!=='cancelling'){", "if(false&&r.state!=='cancelling'){",covered('request deadlines and duplicate chunks')),
  m('M26','repeat disconnect resets deadline','src/control.ts',"const deadline=s.service_disconnect_deadline_at??new Date(at.getTime()+300000);", "const deadline=new Date(at.getTime()+300000);",covered('offline and disconnect deadlines preserve')),
  m('M27','write ownership check removed','src/control.ts',"if(group&&r.group_id!==group)throw new Fault('forbidden',403);", "if(false)throw new Fault('forbidden',403);",covered('read and write APIs reject')),
  m('M28','read ownership check removed','src/control.ts',"if(r.group_id!==user.group_id)throw new Fault('forbidden',403);", "if(false)throw new Fault('forbidden',403);",covered('read and write APIs reject')),
  m('M29','start command omits session key','src/control.ts',"payload.session_auth=cmd.kind==='start_service'?{session_id:session.id,key:session.session_key.toString('base64url')}:{session_id:session.id,credential:writerCredential(session.session_key,session.id,cmd.instance_id,cmd.device_id,instances[0].generation)};", "void session;",covered('session key is device-only')),
  m('A1','a helper is given the session key','src/control.ts',":{session_id:session.id,credential:writerCredential(session.session_key,session.id,cmd.instance_id,cmd.device_id,instances[0].generation)};",":{session_id:session.id,key:session.session_key.toString('base64url')};",existing('test/peer-auth.test.ts','each helper its own credential')),
  m('A2','a credential not bound to its generation','src/control.ts',"cmd.instance_id,cmd.device_id,instances[0].generation)","cmd.instance_id,cmd.device_id,1)",existing('test/peer-auth.test.ts','each helper its own credential')),
  m('A3','an unauthenticated connection opens','src/control.ts',"if(p.authenticated&&g>helper.connection_generation)","if(g>helper.connection_generation)",existing('test/peer-auth.test.ts','does not report authenticated')),
  m('M30','browser session leaks session key','src/control.ts',"const {session_key,config,warmup_command_id,...rest}=s;", "const {config,warmup_command_id,...rest}=s;",covered('session key is device-only')),
  m('M31','session idempotency lookup disabled','src/control.ts',"const old=(await c.query('SELECT id FROM sessions WHERE group_id=$1 AND created_by=$2 AND idempotency_key=$3',[user.group_id,user.user_id,key])).rows[0];if(old)return old.id;", "const old=(await c.query('SELECT id FROM sessions WHERE group_id=$1 AND created_by=$2 AND idempotency_key=$3',[user.group_id,user.user_id,key])).rows[0];if(false&&old)return old.id;",covered('session key is device-only')),
  m('M32','service failure does not stop', 'src/control.ts',"if(s.state==='starting'||service)await this.beginStop", "if(s.state==='starting')await this.beginStop",existing('test/control.test.ts','service exit fails and stops')),
  m('M33','push disconnect does not degrade','src/control.ts',"if(helper.push_connection_id!==null&&s.state==='ready')await this.move(c,'sessions',s,'helper_disconnected');","",existing('test/control.test.ts','helper loss degrades')),
  m('M34','helper starts before service connectable','src/control.ts',"||ins.role==='helper'&&!['connectable','ready'].includes(service.state)", "",covered('startup sequencing requires')),
  m('M35','device releases with live instance','src/control.ts',"if(!live&&d.error?.code!=='port_busy')await this.releaseDevice(c,d,s.id);", "if(d.error?.code!=='port_busy')await this.releaseDevice(c,d,s.id);",covered('device reservation remains')),
  m('M36','conflicting chunk accepted','src/control.ts',"if(old.text!==p.text||old.token_count!==p.token_count||old.segment!==p.segment)", "if(false)",existing('test/recovery.test.ts','conflicting content')),
  m('M37','archive ignores missing chunks','src/control.ts',"state='recovering' AND final_seq=contiguous_seq", "state='recovering'",existing('test/recovery.test.ts','restart reconciles the original stream')),
  m('M38','cancel timeout ignored','src/control.ts',"else if(request.state==='cancelling'&&this.expired(request.cancel_deadline_at))", "else if(false&&request.state==='cancelling'&&this.expired(request.cancel_deadline_at))",existing('test/recovery.test.ts','unconfirmed cancellation')),
  m('M39','stop timeout ignored','src/control.ts',"await this.finishStop(c,session,this.expired(session.stop_deadline_at));", "await this.finishStop(c,session,false);",existing('test/control.test.ts','restart in startup and stop')),
  m('M40','CSRF comparison disabled','src/auth.ts',"if (!csrf || !constantTimeStringEqual(csrf, identity.csrf_token)) {", "if (false) {",existing('test/auth.test.ts','modifying requests enforce Origin and CSRF')),
  m('M41','request idempotency lookup disabled','src/control.ts',"const old=(await c.query('SELECT id FROM requests WHERE group_id=$1 AND user_id=$2 AND submission_id=$3'", "const old=(await c.query('SELECT id FROM requests WHERE false AND group_id=$1 AND user_id=$2 AND submission_id=$3'",existing('test/control.test.ts','fake devices traverse enrollment')),
  m('X1','command result ownership check removed','src/control.ts',"private async result(c:PoolClient,d:Row,p:Row){\n  const cmd=await this.one(c,'commands',p.command_id,d.group_id);if(cmd.device_id!==d.id)throw new Fault('forbidden',403);","private async result(c:PoolClient,d:Row,p:Row){\n  const cmd=await this.one(c,'commands',p.command_id,d.group_id);if(false)throw new Fault('forbidden',403);",guarded('X1 command results')),
  m('X2','request report ownership checks removed','src/control.ts',"if(ins.device_id!==d.id||r.instance_id!==p.instance_id)throw new Fault('instance_mismatch',409);","if(false)throw new Fault('instance_mismatch',409);",guarded('X2 request reports')),
  m('X3','superseded control connection accepted','src/control.ts',"const conn=this.connections.get(deviceId);if(d.state==='removed'||d.control_connection_id!==connectionId||conn?.id!==connectionId)throw new Fault('credential_revoked',401);","const conn=this.connections.get(deviceId)!;if(d.state==='removed')throw new Fault('credential_revoked',401);",guarded('X3 messages')),
  m('X4','offline device removal ignores cleanup requirement','src/control.ts',"d.state!=='offline'||!d.cleanup_required","d.state!=='offline'",guarded('X4 removal')),
  m('X5','peer status sender ownership check removed','src/control.ts',"if(ins.device_id!==d.id||ins.session_id!==p.session_id||ins.stopped_at)throw new Fault('instance_mismatch',409);","if(false)throw new Fault('instance_mismatch',409);",guarded('X5 peer status')),
  m('X7','any degraded stop completion starts replacement','src/control.ts',"if(cmd.kind==='stop'&&cmd.payload.reason==='manual_reconnect'){const session=await this.one(c,'sessions',cmd.session_id);if(session.state==='degraded')","if(cmd.kind==='stop'){const session=await this.one(c,'sessions',cmd.session_id);if(session.state==='degraded')",guarded('X7 completing')),
  m('X8','stopped instance late activity omits cleanup','src/control.ts',"if(ins.stopped_at){if(p.state!=='stopped')await this.move(c,'instances',ins,'late_activity',{}, {dispatch_late_cleanup:()=>this.cleanupInstance(c,d,ins,'late_activity')});return;}","if(ins.stopped_at){return;}",guarded('X8 late activity')),
  m('X9','heartbeat boot mismatch accepted','src/control.ts',"type==='heartbeat'&&d.agent_boot_id!==p.agent_boot_id","false",guarded('X9 heartbeat')),
  m('X10','service health proof ignored','src/control.ts',"!bootChanged&&!inspection&&['connectable','ready'].includes(reportedState)&&ins.spec.role==='target'&&(!p.http_healthy||session.config.plan.helpers.length>0&&!p.push_listening||!p.calibrated)","false",guarded('X10 service connectability')),
  m('B1','build comparison ignores the bridge revision','src/protocol.ts',"['source_revision','bridge_revision'].filter(k=>proof[k]!==want[k])","['source_revision'].filter(k=>proof[k]!==want[k])",existing('test/build.test.ts','another bridge revision')),
  m('P1','Placement chooses a version that does not fit','src/control.ts',"pick=candidates.find(fits)","pick=candidates.find(v=>true)",placed('most precise version whose memory fits')),
  m('P2','a version needing exactly the free memory does not fit','src/control.ts',"fits=(v:Row)=>need(v)<=free(v)","fits=(v:Row)=>need(v)<free(v)",placed('most precise version whose memory fits')),
  m('P3','Placement ignores the precision rank','src/control.ts',"rank(a)-rank(b)||drafts(b)-drafts(a)","drafts(b)-drafts(a)",placed('most precise version whose memory fits')),
  m('P4','fewer drafts first at equal precision','src/control.ts',"rank(a)-rank(b)||drafts(b)-drafts(a)","rank(a)-rank(b)||drafts(a)-drafts(b)",placed('most precise version whose memory fits')),
  m('P5','Placement reads the first card of the vendor, not the one with the most free memory','src/control.ts',".sort((a:Row,b:Row)=>Number(BigInt(b.available_bytes)-BigInt(a.available_bytes)))[0]","[0]",placed('reads the card of the helper with the most free memory')),
  m('P6','none fitting still returns a chosen version','src/control.ts',"version_id:placements[i]?placements[i]!.chosen?.id??null:h.version_id","version_id:placements[i]?chosen[i]?.id??null:h.version_id",placed('no version fits')),
  m('P7','the capacity check omits the skipped versions','src/control.ts',"${placement.skipped.length?","${false?",placed('names each more precise version')),
  m('P8','a session starts without a named version','src/control.ts',"if(unnamed>=0)throw new Fault('invalid_input'","if(false)throw new Fault('invalid_input'",placed('created only with a named version')),
  m('P9','a helper card of any vendor is admitted','src/control.ts',".filter((g:Row)=>!version?.platform?.gpu_vendor||g.vendor===version.platform.gpu_vendor)",".filter((g:Row)=>true)",placed('has no NVIDIA card, is refused')),
  m('P10','a device the version was not measured on is not marked unverified','src/control.ts',"if(version&&measured.length&&!measured.some((m:string)=>names.some((n:string)=>m.includes(n))))add('hardware_unverified'","if(false)add('hardware_unverified'",placed('marked unverified')),
  m('P11','Placement chooses any helper version, complete or not','src/control.ts',"v.role==='helper'&&v.draft_model?.enabled&&v.validation.complete&&v.compatible_service_version_ids.includes(serviceVersionId)","v.role==='helper'",placed('only complete versions with a draft model')),
  m('P12','Placement ignores the free disk','src/control.ts',"fits=(v:Row)=>need(v)<=free(v)&&fitsDisk(v);","fits=(v:Row)=>need(v)<=free(v);",placed('files also fit the free disk')),
  m('P14','a device with model folders of its own is refused for the disk','src/disk.ts',"=>!!inventory.local_model_folders||disk<=BigInt(inventory.disk_available_bytes);","=>disk<=BigInt(inventory.disk_available_bytes);",placed('model folders of its own')),
  m('U1','a revoked API key still authenticates','src/control.ts',"if(k.revoked_at)throw new Fault('api_key_revoked',401","if(false)throw new Fault('api_key_revoked',401",api('API keys: shown once')),
  m('U2','a website request accepts a smaller budget than it asked','src/control.ts',"(r.source==='api'?p.effective_max_output<=r.requested_max_output:p.effective_max_output===r.requested_max_output)","p.effective_max_output<=r.requested_max_output",api('exact budget rule')),
  m('U3','an API request refuses the budget the serving machine capped','src/control.ts',"(r.source==='api'?p.effective_max_output<=r.requested_max_output:p.effective_max_output===r.requested_max_output)","p.effective_max_output===r.requested_max_output",api('a whole')),
  m('U4','a repeated chunk with another segment is no conflict','src/control.ts',"||old.segment!==p.segment)",")",api('chunks carry their segment')),
  m('U5','a client hang-up never cancels','src/control.ts',"await this.cancel(c,r,'client_disconnected');","void 0;",api('hangs up mid-stream')),
  m('U6','a hang-up cancels while the serving machine is disconnected','src/control.ts',"if((await this.one(c,'sessions',r.session_id)).submissions_blocked)return;","",api('does not cancel while')),
  m('U7','an API request goes to a busy session','src/control.ts',"if(!await this.busy(c,s.id)){chosen=s;break;}","{chosen=s;break;}",api('one request at a time')),
  m('U8','a busy answer has no Retry-After','src/openai.ts',"if(fault.code==='request_busy')res.set('Retry-After','10');","",api('one request at a time')),
  m('U9','temperature 0 is refused without saying why','src/openai.ts',"if(b.temperature!==undefined&&typeof b.temperature==='number'&&b.temperature<=0)throw","if(false)throw",api('fields')),
  m('U10','a stream answers 200 before the serving machine accepted the request','src/openai.ts',"if(r.prompt_tokens===null&&r.contiguous_seq==='0'){if(terminal(r.state))throw requestFault(r);return false;}","if(terminal(r.state)&&r.prompt_tokens===null&&r.contiguous_seq==='0')throw requestFault(r);",api('a streamed request')),
  m('U11','thinking is sent as the answer','src/openai.ts',"delta:think?{reasoning_content:text}:{content:text}","delta:{content:text}",api('a streamed request')),
  m('U12','stopping the control plane cancels the API requests whose streams it drops','src/openai.ts',"if(rid&&!stopping())void plane.clientDisconnected","if(rid)void plane.clientDisconnected",api('stopping the control plane')),
  m('U13','an open API stream holds up the control plane\'s stop','src/server.ts',"clearInterval(tick);api.stop();","clearInterval(tick);",api('stopping the control plane')),
  m('U14','top_k has no upper bound','src/openai.ts',"v=>v>=1&&v<=TOP_K_MAX,","v=>v>=1,",api('fields')),
  m('U15','a stopping control plane still takes new API requests','src/openai.ts',"if(!stopping){next();return;}","{next();return;}",api('stopping answers')),
  m('U16','an API request may go to another group\'s session','src/control.ts',`"SELECT * FROM sessions WHERE group_id=$1 AND model=$2 AND state NOT IN ('ended','failed') ORDER BY created_at,id"`,`"SELECT * FROM sessions WHERE $1::uuid IS NOT NULL AND model=$2 AND state NOT IN ('ended','failed') ORDER BY created_at,id"`,api('only its own group')),
  m('U17','messages have no count limit','src/openai.ts',"if(b.messages.length>MAX_MESSAGES)throw","if(false)throw",api('fields')),
  m('U18','the Bearer scheme is case-sensitive','src/control.ts',"given?.[1].toLowerCase()==='bearer'","given?.[1]==='Bearer'",api('two authentications')),
  m('P13','a version may name no platform it runs on','src/config.ts',"entry_without_draft:entry.optional(),platform,max_requests","entry_without_draft:entry.optional(),platform:platform.optional(),max_requests",existing('test/config.test.ts','rejects unsafe or incomplete claims')),
  // a device is selectable again only with an inventory probed after its instances ended (Control plane: device)
  m('R1','a stopped report frees the device before an inventory probed after the stop','src/control.ts',"if(await this.inventoryBehind(c,d,sid))return;","",existing('test/release-inventory.test.ts','a stopped report before')),
  m('R2','an inventory probed earlier replaces a newer one','src/control.ts',"const newer=d.agent_boot_id!==boot||!(Number(d.inventory.sequence)>=inventory.sequence)","const newer=true",existing('test/release-inventory.test.ts','a heartbeat probed before the stop')),
];

function run(cwd, args, timeout = 120_000) {
  // Without NODE_TEST_CONTEXT: a test runner started from inside another (the harness's own test) would report to it and
  // exit 0 whatever its tests do.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout, env: { ...env, NO_COLOR: '1' } });
}
function compile(cwd) { return run(cwd, [join(cwd, 'node_modules/typescript/bin/tsc'), '--noEmit']); }
export function tests(cwd, spec) {
  const args = [join(cwd, 'node_modules/tsx/dist/cli.mjs'), '--test', '--test-concurrency=1'];
  const patternAt = spec.indexOf('--test-name-pattern');
  if (patternAt >= 0) args.push('--test-name-pattern', spec[patternAt + 1], spec[0]);
  else args.push(...spec);
  return run(cwd, args, 180_000);
}
export function copyProject(source) {
  const base = mkdtempSync(join(tmpdir(), 'openinfer-mutant-'));
  const target = join(base, 'control-plane', 'server');
  mkdirSync(join(base, 'control-plane'));
  cpSync(source, target, { recursive: true, filter: p => basename(p) !== 'node_modules' && basename(p) !== 'dist' });
  symlinkSync(join(source, 'node_modules'), join(target, 'node_modules'), 'dir');
  return target;
}
export function discardProject(root) { rmSync(resolve(root, '../..'), { recursive: true, force: true }); }
function applyMutant(root, mutant) {
  const path = join(root, mutant.file);
  const source = readFileSync(path, 'utf8');
  const first = source.indexOf(mutant.find);
  if (first < 0) return { ok: false, reason: 'unapplied: source anchor not found' };
  if (source.indexOf(mutant.find, first + mutant.find.length) >= 0) return { ok: false, reason: 'unapplied: source anchor is ambiguous' };
  writeFileSync(path, source.slice(0, first) + mutant.replace + source.slice(first + mutant.find.length));
  return { ok: true };
}

export async function main(argv = process.argv.slice(2)) {
  const source = resolve(new URL('..', import.meta.url).pathname);
  if (argv.includes('--list')) {
    for (const x of MUTANTS) console.log(`${x.id}\tmutant\t${x.title}\t${x.tests.join(' ')}`);
    return 0;
  }
  const onlyAt = argv.indexOf('--only');
  const selected = onlyAt >= 0 ? MUTANTS.filter(x => x.id === argv[onlyAt + 1]) : MUTANTS;
  if (!selected.length) throw new Error('No matching mutant');

  const baselineCompile = compile(source);
  if (baselineCompile.status !== 0) {
    console.error('BASELINE_COMPILE_FAILED\n' + baselineCompile.stdout + baselineCompile.stderr);
    return 2;
  }
  if (argv.includes('--validate-mutants')) {
    let invalid = 0;
    for (const mutant of selected) {
      const root = copyProject(source);
      try {
        const applied = applyMutant(root, mutant);
        const built = applied.ok ? compile(root) : null;
        const valid = applied.ok && built?.status === 0;
        if (!valid) invalid++;
        console.log(`${mutant.id}\t${valid ? 'valid' : 'invalid'}\t${applied.ok ? 'compile check' : applied.reason}`);
      } finally { discardProject(root); }
    }
    console.log(`SUMMARY valid=${selected.length - invalid} invalid=${invalid}`);
    return invalid ? 1 : 0;
  }
  const baselineTests = tests(source, behavior);
  if (baselineTests.status !== 0) {
    console.error('BASELINE_RED: implementation is not ready for mutation scoring\n' + baselineTests.stdout + baselineTests.stderr);
    return 2;
  }

  const results = [];
  for (const mutant of selected) {
    const root = copyProject(source);
    try {
      const applied = applyMutant(root, mutant);
      if (!applied.ok) { results.push({ ...mutant, status: 'invalid', detail: applied.reason }); continue; }
      const built = compile(root);
      if (built.status !== 0) { results.push({ ...mutant, status: 'invalid', detail: 'compile failed (not counted killed)' }); continue; }
      const checked = tests(root, mutant.tests);
      const status = checked.error?.code === 'ETIMEDOUT' ? 'invalid' : checked.status === 0 ? 'survived' : 'killed';
      results.push({ ...mutant, status, detail: status === 'invalid' ? 'test timeout' : '' });
    } finally { discardProject(root); }
  }
  for (const r of results) console.log(`${r.id}\t${r.status}\t${r.title}${r.detail ? `\t${r.detail}` : ''}`);
  const count = name => results.filter(x => x.status === name).length;
  console.log(`SUMMARY killed=${count('killed')} survived=${count('survived')} invalid=${count('invalid')}`);
  return count('survived') || count('invalid') ? 1 : 0;
}

if (resolve(process.argv[1] ?? '') === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = await main();
}

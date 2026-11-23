import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as protocol from '../src/protocol.ts';
import { inventory } from './fixtures.ts';
const error={code:'build_mismatch',message:'Expected fixed source revision; rebuild the helper.',field:'build.source_revision',device_id:randomUUID(),phase:'build',retryable:false};
test('errors preserve concrete cause, device and phase instead of displaying a code',()=>{
 const Fault=protocol.Fault as any;assert.deepEqual(new Fault(error.code,409,error.field,error).body(),error);
});
test('device errors reject oversized messages and arbitrary secret-bearing fields',()=>{
 const base={command_id:randomUUID(),outcome:'failed',result:{},error};
 assert.equal(protocol.messages['command.result'].safeParse(base).success,true);
 for(const invalid of [{...error,message:'x'.repeat(2049)},{...error,secret:'not-a-diagnostic-field'}])assert.equal(protocol.messages['command.result'].safeParse({...base,error:invalid}).success,false);
});
test('system and processor names are normalized; machine and card names are only trimmed',()=>{
 const mac=inventory('service');Object.assign(mac,{os:'Darwin',arch:'aarch64',machine_model:' Mac14,3 '});
 const parsed=protocol.parse(protocol.inventorySchema,mac);assert.equal(parsed.os,'darwin');assert.equal(parsed.arch,'arm64');assert.equal(parsed.machine_model,'Mac14,3');
 const helper=inventory('helper');Object.assign(helper,{os:'Linux',arch:'AMD64'});helper.gpus[0].model=' NVIDIA RTX A5000 ';
 const h=protocol.parse(protocol.inventorySchema,helper);assert.equal(h.os,'linux');assert.equal(h.arch,'x86_64');assert.equal(h.gpus[0].model,'NVIDIA RTX A5000');
});
test('command results are checked by kind before business processing',()=>{
 const parseResult=(protocol as any).parseCommandResult;assert.equal(typeof parseResult,'function');
 assert.throws(()=>parseResult('warmup','completed',{arbitrary:true}));
 assert.throws(()=>parseResult('cancel_request','completed',{request_id:randomUUID(),released:false}));
 assert.throws(()=>parseResult('prepare','failed',{manifest_sha256:'a'.repeat(64)}));
 assert.deepEqual(parseResult('prepare','failed',{}),{});
 assert.deepEqual(parseResult('recheck','completed',{instances:[],ports_free:false}),{instances:[],ports_free:false});
});
test('diagnostic sanitizing removes secrets and excludes unapproved effective environment',()=>{
 const sanitize=(protocol as any).sanitizeDiagnostic;assert.equal(typeof sanitize,'function');
 const secret=randomUUID(),value=sanitize({error:{...error,message:`Bearer ${secret} was rejected`},metrics:{effective_spec:{env:{API_KEY:secret,HF_HUB_OFFLINE:'1'}}}},[secret]);
 assert.equal(JSON.stringify(value).includes(secret),false);
 assert.equal(value.error.device_id,error.device_id);assert.equal(value.error.phase,'build');
 assert.equal(value.metrics.effective_spec.env.API_KEY,undefined);
});

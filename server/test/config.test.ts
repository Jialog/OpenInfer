import test from 'node:test';
import assert from 'node:assert/strict';
import { certificateShown,parseDeployment,parseRegistration } from '../src/config.ts';
import { fixtureCatalog } from './fixtures.ts';
function config(){const value=fixtureCatalog();for(const v of value.catalog.versions)v.files=[{path:'model.bin',sha256:'a'.repeat(64),size_bytes:'1'}] as any;const {catalog,requirements,warmup}=value;return {catalog,requirements,warmup};}
test('deployment catalog accepts finite complete entries and rejects unsafe or incomplete claims',()=>{
 assert.equal(parseDeployment(config()).catalog.versions.length,2);
 for(const mutate of [
  (v:any)=>v.requirements.helper.memory_bytes='NaN',
  (v:any)=>v.catalog.versions.push(v.catalog.versions[0]),
  (v:any)=>v.catalog.versions[1].manifest_sha256=null,
  (v:any)=>v.catalog.versions[1].files[0].path='../model',
  (v:any)=>v.catalog.versions[1].draft_model=null,
  (v:any)=>v.warmup.sha256='',
  (v:any)=>v.catalog.versions[0].model='a model the catalog does not describe',
  (v:any)=>delete v.catalog.models,
  (v:any)=>delete v.catalog.versions[0].max_requests,
  (v:any)=>delete v.catalog.versions[1].entry,
  (v:any)=>v.catalog.versions[1].entry.launch='old',
  (v:any)=>delete v.catalog.versions[1].platform,
 ]){const v=config();mutate(v);assert.throws(()=>parseDeployment(v));}
});
test('unconfigured catalog is explicitly unavailable without invented measurements',()=>{
 const v=parseDeployment();assert.deepEqual(v.catalog.versions,[]);assert.deepEqual(v.requirements,{});
});
test('the session entry of a version is kept as the catalog gives it while catalog references are checked',()=>{
 const v:any=config();v.catalog.versions[1].entry.command.fixture_flag=true;assert.equal(parseDeployment(v).catalog.versions[1].entry.command.fixture_flag,true);
 for(const mutate of [
  (x:any)=>x.catalog.versions[1].compatible_service_version_ids=['missing'],
  (x:any)=>x.catalog.versions[1].model='Other',
 ]){const x=config();mutate(x);assert.throws(()=>parseDeployment(x));}
});

test('acceptance seeds use exact bounded decimal integers',()=>{
 const v:any=config();v.acceptance=[{id:'test',label:'test',resource_sha256:'a'.repeat(64),token_ids:[1],seed:'9223372036854775807',max_output_tokens:256}];
 assert.equal(parseDeployment(v).acceptance![0].seed,'9223372036854775807');
 for(const seed of ['-1','9223372036854775808','base64url-seed','01',1]){v.acceptance[0].seed=seed;assert.throws(()=>parseDeployment(v));}
});

test('OPENINFER_REGISTRATION is open unless set to closed, and any other value stops the start',()=>{
 assert.equal(parseRegistration(undefined),'open');
 assert.equal(parseRegistration(''),'open');
 assert.equal(parseRegistration('open'),'open');
 assert.equal(parseRegistration('closed'),'closed');
 for(const value of ['close','Closed','1','true','no'])assert.throws(()=>parseRegistration(value),/OPENINFER_REGISTRATION must be open or closed/);
});
// The API keys page names the certificate file the control plane loaded. A path in the home directory is written
// with ~, so the page shows no user name; a relative OPENINFER_TLS_CERT is made absolute first.
test('the certificate path shown on the website is absolute, with the home directory as ~',()=>{
 assert.equal(certificateShown('/srv/owner/work/cp/tls.crt','/srv/owner','/tmp'),'~/work/cp/tls.crt');
 assert.equal(certificateShown('cp/tls.crt','/srv/owner','/srv/owner/openinfer'),'~/openinfer/cp/tls.crt');
 assert.equal(certificateShown('/srv/ownerx/tls.crt','/srv/owner','/'),'/srv/ownerx/tls.crt');
 assert.equal(certificateShown('/etc/openinfer/tls.crt','/srv/owner','/'),'/etc/openinfer/tls.crt');
});
test('a misspelled OPENINFER_REGISTRATION stops the start with its own message',async()=>{
 const {execFile}=await import('node:child_process');
 const env={...process.env,OPENINFER_REGISTRATION:'Closed'};delete (env as any).DATABASE_URL;
 const result=await new Promise<{code:number|null,stderr:string}>(resolve=>execFile(process.execPath,['--import','tsx',new URL('../src/main.ts',import.meta.url).pathname],{env},(error,_stdout,stderr)=>resolve({code:error?(error as any).code:0,stderr})));
 assert.equal(result.code,1);
 assert.match(result.stderr,/^Control plane startup failed: OPENINFER_REGISTRATION must be open or closed, not "Closed"\.$/m);
});

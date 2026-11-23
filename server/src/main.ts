import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { X509Certificate } from 'node:crypto';
import { Pool } from 'pg';
import { ControlPlane,type Options } from './control.js';
import { migrate } from './database.js';
import { MemoryObjectStore,S3ObjectStore } from './storage.js';
import { createServer } from './server.js';
import { certificateShown,parseDeployment,parseRegistration } from './config.js';
import type { Registration } from './auth.js';
function required(name:string){const value=process.env[name];if(!value)throw new Error(`Missing ${name}`);return value;}
async function main(registration:Registration){
 // A connection the database closes (its restart, or its stop with this server) is reported, not fatal: an idle one
 // (the pool's error) and one a transaction holds (the client's own error; its queries then fail where they are awaited).
 let closing=false;const lost=()=>{if(!closing)console.error('A database connection was lost.');};
 const pool=new Pool({connectionString:required('DATABASE_URL'),max:10});pool.on('error',lost);pool.on('connect',client=>client.on('error',lost));await migrate(pool);
 if(process.argv.includes('--migrate-only')){await pool.end();return;}
 const origin=new URL(required('OPENINFER_ORIGIN'));if(origin.protocol!=='https:')throw new Error('HTTPS origin required');
 const cert=await readFile(required('OPENINFER_TLS_CERT')),key=await readFile(required('OPENINFER_TLS_KEY'));
 // This file is deployment input from the measured finite catalog, never a browser body.
 // Without a catalog the version list is empty; accounts, enrollment and connection tests still work.
 const catalogSettings=parseDeployment(process.env.OPENINFER_CATALOG_FILE?JSON.parse(await readFile(process.env.OPENINFER_CATALOG_FILE,'utf8')):undefined);
 const options:Options={...catalogSettings,controlUrls:{local:required('OPENINFER_LOCAL_URL'),lan:origin.origin},certificateSha256:new X509Certificate(cert).fingerprint256.replaceAll(':','').toLowerCase(),certificatePath:certificateShown(required('OPENINFER_TLS_CERT'),homedir(),process.cwd())};
 // Without a bucket (no S3_ENDPOINT) the stored objects live in this process and are gone when it stops.
 const store=process.env.S3_ENDPOINT?new S3ObjectStore({endpoint:required('S3_ENDPOINT'),region:process.env.S3_REGION??'us-east-1',bucket:required('S3_BUCKET'),accessKeyId:required('S3_ACCESS_KEY_ID'),secretAccessKey:required('S3_SECRET_ACCESS_KEY')}):new MemoryObjectStore();
 if(!process.env.S3_ENDPOINT)console.warn('No bucket is configured (S3_ENDPOINT): uploaded prompt files and request results are kept in the memory of this server process and are lost when it stops. Set the S3_* variables to store them in a bucket.');
 const plane=new ControlPlane(pool,store,options);await plane.recover();
 const service=createServer(plane,{key,cert,origin:origin.origin,webRoot:process.env.OPENINFER_WEB_DIR,registration});
 service.server.listen(Number(process.env.PORT??8443),process.env.HOST??'0.0.0.0',()=>console.info(`OpenInfer HTTPS control plane is listening; registration is ${registration}`));
 const close=async()=>{if(closing)return;closing=true;await service.close();await pool.end();};
 process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
}
// A wrong setting is named in the message (it holds no secret); other failures stay general.
let registration:Registration;
try{registration=parseRegistration(process.env.OPENINFER_REGISTRATION);}
catch(error){console.error(`Control plane startup failed: ${(error as Error).message}.`);process.exit(1);}
main(registration).catch(()=>{console.error('Control plane startup failed; check configuration, certificates, database and object storage.');process.exitCode=1;});

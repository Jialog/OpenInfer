import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import net from 'node:net';
export async function createDatabase(applySchema=true) {
  const listener=net.createServer();
  await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=(listener.address() as net.AddressInfo).port;
  await new Promise<void>(resolve=>listener.close(()=>resolve()));
  const directory=await mkdtemp('/tmp/openinfer-server-');
  const password=randomBytes(32).toString('hex');
  const server=new EmbeddedPostgres({databaseDir:directory,user:'openinfer_test',password,port,persistent:true,
    createPostgresUser:false,autoRehydrateSymlinks:true,postgresFlags:['-h','127.0.0.1','-k',directory],onLog:()=>{},onError:()=>{}});
  await server.initialise(); await server.start();
  const pool=new Pool({host:'127.0.0.1',port,user:'openinfer_test',password,database:'postgres'});
  if(applySchema){const directory=new URL('../migrations/',import.meta.url);for(const file of (await readdir(directory)).filter(x=>/^\d+.*\.sql$/.test(x)).sort())await pool.query(await readFile(new URL(file,directory),'utf8'));}
  return {pool,close:async()=>{await pool.end();await server.stop();await rm(directory,{recursive:true,force:true});}};
}

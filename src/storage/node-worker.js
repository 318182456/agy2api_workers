// This must remain literal source: serializing bundled functions/classes leaks bundler helpers
// and can turn the exported DO class into an anonymous class (Cloudflare validation 10021).
export const storageNodeSource = String.raw`export class StorageNode {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY,expires INTEGER NOT NULL,body BLOB NOT NULL) WITHOUT ROWID',
    );
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS cache_expiry ON cache(expires)');
    this.cleanupAt = 0;
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const cacheKey = path.match(/^\/cache\/([a-f0-9]{64})$/)?.[1];
    const sql = this.ctx.storage.sql;
    const result = (value, status=200) => Response.json(value,{status,headers:{'cache-control':'no-store'}});
    if (cacheKey && request.method === 'DELETE') {
      sql.exec('DELETE FROM cache WHERE key=?',cacheKey);return result({success:true,node_id:this.env.NODE_ID});
    }
    if (cacheKey && request.method === 'GET') {
      const row=sql.exec('SELECT expires,body FROM cache WHERE key=? AND expires>?',cacheKey,Date.now()).toArray()[0];
      return row ? result({node_id:this.env.NODE_ID,expires_at:row.expires,value:JSON.parse(row.body)}) : result({miss:true},404);
    }
    if ((cacheKey && request.method === 'PUT') || (path === '/cache-transfer' && request.method === 'POST')) {
      const reader=request.body?.getReader();let bytes=0;const parts=[];
      if(!reader) return result({error:'missing body'},400);
      try {for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;
        if(bytes>1048576){await reader.cancel();return result({error:'cache too large'},413);}parts.push(chunk.value);}}
      finally{reader.releaseLock();}
      let value;try{value=JSON.parse(await new Blob(parts).text());}catch{return result({error:'invalid cache'},400);}
      const entries=cacheKey?[{...value,key:cacheKey}]:value.entries;
      if(!Array.isArray(entries)||entries.length>128||entries.some(entry=>
        !/^[a-f0-9]{64}$/.test(entry.key||'')||!Number.isFinite(entry.expires_at)||
        entry.expires_at>Date.now()+600000||!Object.hasOwn(entry,'value')))return result({error:'invalid cache'},400);
      this.ctx.storage.transactionSync(()=>{
        for(const entry of entries)if(entry.expires_at>Date.now())
          sql.exec('INSERT INTO cache(key,expires,body)VALUES(?,?,?) ON CONFLICT(key)DO UPDATE SET expires=excluded.expires,body=excluded.body WHERE excluded.expires>=cache.expires',
            entry.key,entry.expires_at,JSON.stringify(entry.value));
        if(this.cleanupAt<Date.now()){
          sql.exec('DELETE FROM cache WHERE expires<=?',Date.now());
          sql.exec('DELETE FROM cache WHERE key IN(SELECT key FROM cache ORDER BY expires DESC LIMIT -1 OFFSET 128)');
          this.cleanupAt=Date.now()+60000;
        }
      });
      return result({success:true,node_id:this.env.NODE_ID});
    }
    if(path==='/cache-transfer'){
      if(request.method==='DELETE'){sql.exec('DELETE FROM cache');return result({success:true});}
      if(request.method==='GET'){
        const entries=[];let bytes=0;
        for(const row of sql.exec('SELECT key,expires,body FROM cache WHERE expires>? ORDER BY expires DESC LIMIT 128',Date.now())){
          bytes+=new TextEncoder().encode(row.body).length+160;if(bytes>900000)break;
          entries.push({key:row.key,expires_at:row.expires,value:JSON.parse(row.body)});
        }
        return result({node_id:this.env.NODE_ID,entries});
      }
      return result({error:'method not allowed'},405);
    }
    if(cacheKey)return result({error:'method not allowed'},405);
    if (path === '/self-test' && request.method === 'POST') {
      const key = 'probe:' + crypto.randomUUID();
      const bytes = new TextEncoder().encode(key);
      const success = this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          'INSERT INTO cache(key,expires,body)VALUES(?,?,?)',
          key,
          Date.now() + 60000,
          bytes.buffer,
        );
        const row = this.ctx.storage.sql
          .exec('SELECT body FROM cache WHERE key=?', key)
          .toArray()[0];
        this.ctx.storage.sql.exec('DELETE FROM cache WHERE key=?', key);
        return row && new TextDecoder().decode(row.body) === key;
      });
      return Response.json({
        success: !!success,
        node_id: this.env.NODE_ID,
        protocol: 1,
        storage: 'sqlite-do',
        mode: 'cache',
        capabilities: ['cache-v1'],
      });
    }
    if (path === '/health' && request.method === 'GET')
      return Response.json({
        success: true,
        node_id: this.env.NODE_ID,
        protocol: 1,
        storage: 'sqlite-do',
        mode: 'cache',
        capabilities: ['cache-v1'],
      });
    return new Response('Not found', { status: 404 });
  }
};
export default {fetch:async function storageFetch(request, env) {
  let phase = 'authorization';
  try {
    const bearer = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1] || '';
    const digest = async (value) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
    const [a,b] = await Promise.all([digest(bearer),digest(env.NODE_SECRET || '')]);
    let diff=0;for(let i=0;i<a.length;i++) diff|=a[i]^b[i];
    if(!env.NODE_SECRET || diff) return new Response('Unauthorized',{status:401});
    const path=new URL(request.url).pathname;
    if(!['/health','/self-test','/cache-transfer'].includes(path) && !/^\/cache\/[a-f0-9]{64}$/.test(path)) return new Response('Not found',{status:404});
    phase='binding';
    if(!env.STORAGE || typeof env.STORAGE.get!=='function') throw new TypeError('Missing STORAGE binding');
    const stub=env.STORAGE.get(env.STORAGE.idFromName('gcli2api'));
    phase='durable_object';
    return await stub.fetch(request);
  } catch(error) {
    const types=['Error','TypeError','ReferenceError','RangeError','SyntaxError'];
    const type=types.includes(error?.name)?error.name:'Error';
    const symbols=['__name','__defProp','StorageNode','crypto','TextEncoder'];
    const symbol=symbols.find(name=>error?.message===name+' is not defined');
    const diagnostic={code:'NODE_RUNTIME_ERROR',phase,type,...(symbol?{missing_symbol:symbol}:{})};
    console.error(JSON.stringify({event:'storage_node_failed',...diagnostic}));
    return Response.json({success:false,error:diagnostic},{status:500,headers:{'cache-control':'no-store'}});
  }
}};`;

// Pages imports the same authenticated handler; the DO class stays in its original Worker.
export const storagePagesSource = storageNodeSource.slice(
  storageNodeSource.indexOf('export default'),
);

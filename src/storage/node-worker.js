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
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS telemetry_buckets(key TEXT PRIMARY KEY,version INTEGER NOT NULL,created_at INTEGER NOT NULL,payload TEXT NOT NULL,members TEXT NOT NULL,dirty INTEGER NOT NULL) WITHOUT ROWID');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS telemetry_dirty ON telemetry_buckets(key) WHERE dirty=1');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS telemetry_config(id INTEGER PRIMARY KEY,origin TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS node_events(event_key TEXT PRIMARY KEY,sort_id INTEGER NOT NULL,created_at INTEGER NOT NULL,body TEXT NOT NULL) WITHOUT ROWID');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS node_events_time ON node_events(created_at DESC,sort_id DESC)');
    this.telemetryOrigin=ctx.storage.sql.exec('SELECT origin FROM telemetry_config WHERE id=1').toArray()[0]?.origin;
    this.eventsCleanupAt=0;
    this.cleanupAt = 0;
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS node_usage(day TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS node_usage_meta(id INTEGER PRIMARY KEY,started_at INTEGER NOT NULL)');
    ctx.storage.sql.exec('INSERT OR IGNORE INTO node_usage_meta(id,started_at)VALUES(1,?)',Date.now());
    this.usagePending = new Map();
    this.usageAlarmAt = 0;
    ctx.blockConcurrencyWhile(async()=>{this.usageAlarmAt=(await ctx.storage.getAlarm())||0;});
  }
  usageDay(now=Date.now()) {return new Date(now+8*3600000).toISOString().slice(0,10);}
  usageFields() {return ['requests','reads','hits','misses','writes','imports','exports','errors'];}
  flushUsage() {
    const sql=this.ctx.storage.sql;
    this.ctx.storage.transactionSync(()=>{
      for(const [day,delta] of this.usagePending){
        const stored=sql.exec('SELECT value FROM node_usage WHERE day=?',day).toArray()[0];
        const value=stored?JSON.parse(stored.value):{};
        for(const key of this.usageFields())value[key]=(value[key]||0)+(delta[key]||0);
        value.last_activity=Math.max(value.last_activity||0,delta.last_activity||0);
        sql.exec('INSERT INTO node_usage(day,value)VALUES(?,?) ON CONFLICT(day)DO UPDATE SET value=excluded.value',day,JSON.stringify(value));
      }
      sql.exec('DELETE FROM node_usage WHERE day<?',this.usageDay(Date.now()-7*86400000));
    });
    this.usagePending.clear();
  }
  async ensureAlarm(delay=300000) {
    const target=Date.now()+delay;
    if(this.usageAlarmAt&&this.usageAlarmAt<=target)return;
    this.usageAlarmAt=target;
    try{await this.ctx.storage.setAlarm(this.usageAlarmAt);}catch(error){this.usageAlarmAt=0;throw error;}
  }
  telemetrySnapshot(limit=1000) {
    return this.ctx.storage.sql.exec('SELECT * FROM telemetry_buckets WHERE dirty=1 ORDER BY key LIMIT ?',limit).toArray().map(row=>({
      key:row.key,version:row.version,value:JSON.parse(row.payload),members:JSON.parse(row.members)
    }));
  }
  async flushTelemetry() {
    if(this.telemetryFlight)return this.telemetryFlight;
    this.telemetryFlight=this.deliverTelemetry();
    try{return await this.telemetryFlight;}finally{this.telemetryFlight=null;}
  }
  async deliverTelemetry() {
    const sql=this.ctx.storage.sql,buckets=this.telemetrySnapshot(25);
    if(!buckets.length)return;
    const origin=sql.exec('SELECT origin FROM telemetry_config WHERE id=1').toArray()[0]?.origin;
    if(!origin)throw new Error('missing telemetry origin');
    const response=await fetch(origin+'/internal/storage-telemetry',{
      method:'POST',headers:{authorization:'Bearer '+this.env.NODE_SECRET,'x-storage-node-id':this.env.NODE_ID,'content-type':'application/json'},
      body:JSON.stringify({buckets}),redirect:'manual',signal:AbortSignal.timeout(15000)
    });
    const ack=response.ok?await response.json():null;
    if(!ack?.success||ack.node_id!==this.env.NODE_ID){await response.body?.cancel().catch(()=>{});throw new Error('telemetry delivery failed');}
    this.ctx.storage.transactionSync(()=>{
      for(const bucket of buckets)sql.exec('UPDATE telemetry_buckets SET dirty=0 WHERE key=? AND version=?',bucket.key,bucket.version);
      sql.exec('DELETE FROM telemetry_buckets WHERE dirty=0 AND created_at<?',Date.now()-86400000);
    });
  }
  async alarm() {
    this.usageAlarmAt=0;
    try{this.flushUsage();await this.flushTelemetry();}
    catch{console.warn(JSON.stringify({event:'storage_node_telemetry_delivery_failed',node_id:this.env.NODE_ID}));}
    this.ctx.storage.sql.exec('DELETE FROM node_events WHERE created_at<?',Date.now()-7*86400000);
    if(this.usagePending.size||this.ctx.storage.sql.exec('SELECT key FROM telemetry_buckets WHERE dirty=1 LIMIT 1').toArray().length)await this.ensureAlarm();
    else if(this.ctx.storage.sql.exec('SELECT event_key FROM node_events LIMIT 1').toArray().length)await this.ensureAlarm(3600000);
  }
  async fetch(request) {
    const path=new URL(request.url).pathname;
    if(path==='/usage' && request.method==='GET'){
      const sql=this.ctx.storage.sql,day=this.usageDay();
      const stored=sql.exec('SELECT value FROM node_usage WHERE day=?',day).toArray()[0];
      const today=stored?JSON.parse(stored.value):{};
      const delta=this.usagePending.get(day)||{};
      for(const key of this.usageFields())today[key]=(today[key]||0)+(delta[key]||0);
      today.last_activity=Math.max(today.last_activity||0,delta.last_activity||0)||null;
      const inventory=sql.exec('SELECT COUNT(*) AS entries,COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM cache WHERE expires>?',Date.now()).toArray()[0];
      return Response.json({success:true,node_id:this.env.NODE_ID,day,timezone:'Asia/Shanghai',today,
        cache_entries:inventory.entries,cache_bytes:inventory.bytes,
        started_at:sql.exec('SELECT started_at FROM node_usage_meta WHERE id=1').toArray()[0].started_at,
        sampled_at:Date.now(),checkpoint_seconds:300,approximate:true,telemetry:this.telemetryUsage()},
        {headers:{'cache-control':'no-store'}});
    }
    let response;
    try {response=await this.handle(request);return response;}
    finally {
      if(path==='/telemetry/record'||path==='/cache-transfer'||/^\/cache\/[a-f0-9]{64}$/.test(path)){
        const day=this.usageDay(),delta=this.usagePending.get(day)||{};
        const increment=(key)=>{delta[key]=(delta[key]||0)+1;};
        increment('requests');delta.last_activity=Date.now();
        if(path.startsWith('/cache/')&&request.method==='GET'){
          increment('reads');if(response?.status===200)increment('hits');else if(response?.status===404)increment('misses');
        }
        if(response?.ok){
          if(request.method==='PUT'||path==='/telemetry/record')increment('writes');
          if(path==='/cache-transfer'&&request.method==='POST')increment('imports');
          if(path==='/cache-transfer'&&request.method==='GET')increment('exports');
        }else if(!response||response.status!==404)increment('errors');
        this.usagePending.set(day,delta);
        try{await this.ensureAlarm();}catch{this.usageAlarmAt=0;}
      }
    }
  }
  telemetryUsage() {
    const sql=this.ctx.storage.sql,start=Math.floor((Date.now()+28800000)/86400000)*86400000-28800000;
    const rows=sql.exec('SELECT version,dirty,created_at FROM telemetry_buckets').toArray();
    return {supported:true,today_requests:rows.filter(row=>row.created_at>=start).reduce((n,row)=>n+row.version,0),
      pending_requests:rows.filter(row=>row.dirty).reduce((n,row)=>n+row.version,0),pending_buckets:rows.filter(row=>row.dirty).length,interval_seconds:300,events:sql.exec('SELECT COUNT(*) AS n FROM node_events WHERE created_at>=?',Date.now()-7*86400000).toArray()[0].n};
  }
  async handle(request) {
    const path = new URL(request.url).pathname;
    if(['/events/query','/events/delete'].includes(path)&&request.method==='POST'){
      const body=await request.json(),params=body.params||{},values=[Date.now()-7*86400000],predicates=['created_at>=?'];
      for(const key of ['credential_id','mode','model','request_id','stage'])if(params[key]){predicates.push("json_extract(body,'$."+key+"')=?");values.push(params[key]);}
      if(params.email){predicates.push("instr(lower(json_extract(body,'$.credential_name')),lower(?))>0");values.push(params.email);}
      if(params.status){
        if(/^[1-5]xx$/.test(params.status)){predicates.push("json_extract(body,'$.status') BETWEEN ? AND ?");values.push(Number(params.status[0])*100,Number(params.status[0])*100+99);}
        else{predicates.push("json_extract(body,'$.status')=?");values.push(Number(params.status));}
      }
      for(const key of ['from','to'])if(params[key]){predicates.push('created_at'+(key==='from'?'>=':'<=')+'?');values.push(/^\d+$/.test(params[key])?Number(params[key]):Date.parse(params[key]));}
      if(params.issues==='1')predicates.push("(json_extract(body,'$.status')>=400 OR json_extract(body,'$.retried')=1)");
      if(path==='/events/query'&&params.before){
        const cursor=params.before.match(/^(\d+):([0123]):(\d+)$/);
        if(!cursor)return Response.json({error:'invalid cursor'},{status:400});
        const [time,source,id]=cursor.slice(1).map(Number);
        predicates.push('(created_at<? OR (created_at=? AND (3<? OR (3=? AND sort_id<?))))');values.push(time,time,source,source,id);
      }
      const where=' WHERE '+predicates.join(' AND '),sql=this.ctx.storage.sql;
      if(path==='/events/delete'){
        const count=sql.exec('SELECT COUNT(*) AS n FROM node_events'+where,...values).toArray()[0].n;
        sql.exec('DELETE FROM node_events'+where,...values);
        return Response.json({success:true,node_id:this.env.NODE_ID,deleted:count});
      }
      const limit=Number.isSafeInteger(body.limit)?Math.max(1,Math.min(body.limit,2001)):51;
      const records=sql.exec('SELECT body FROM node_events'+where+' ORDER BY created_at DESC,sort_id DESC LIMIT ?',...values,limit).toArray().map(row=>JSON.parse(row.body));
      return Response.json({success:true,node_id:this.env.NODE_ID,records});
    }
    if(path==='/telemetry/snapshot'&&request.method==='POST'){
      const buckets=this.telemetrySnapshot(1001);
      if(buckets.length>1000)return Response.json({error:'telemetry backlog'},{status:503});
      return Response.json({success:true,node_id:this.env.NODE_ID,buckets});
    }
    if(path==='/telemetry/flush'&&request.method==='POST'){
      try{await this.flushTelemetry();return Response.json({success:true,node_id:this.env.NODE_ID,...this.telemetryUsage()});}
      catch{return Response.json({error:'telemetry retained'},{status:503});}
    }
    if(path==='/telemetry/record'&&request.method==='POST'){
      const value=await request.json();
      const base='^\\d{13}:[a-f0-9]{32}:'+this.env.NODE_ID+'$';
      let origin;try{origin=new URL(value.origin);}catch{return Response.json({error:'invalid origin'},{status:400});}
      if(origin.protocol!=='https:'||origin.origin!==value.origin||origin.username||origin.password||
        !new RegExp(base).test(value.key||'')||typeof value.request_id!=='string'||value.request_id.length>100||
        !Number.isSafeInteger(value.created_at)||value.created_at!==Number(value.key.slice(0,13))||!Number.isSafeInteger(value.completed_at)||
        !Number.isSafeInteger(value.duration_ms)||value.duration_ms<0||
        !['success','failed','cancelled'].includes(value.outcome)||
        ['input_tokens','output_tokens','thought_tokens','total_tokens'].some(key=>value[key]!=null&&(!Number.isSafeInteger(value[key])||value[key]<0)))
        return Response.json({error:'invalid telemetry'},{status:400});
      const sql=this.ctx.storage.sql;
      let full=false;
      this.ctx.storage.transactionSync(()=>{
        const stored=sql.exec('SELECT * FROM telemetry_buckets WHERE key=?',value.key).toArray()[0];
        const members=stored?JSON.parse(stored.members):[];
        if(members.includes(value.request_id))return;
        if(members.length>=2000||(!stored&&sql.exec('SELECT COUNT(*) AS n FROM telemetry_buckets WHERE dirty=1').toArray()[0].n>=1000)){full=true;return;}
        const row=stored?JSON.parse(stored.payload):{
          api_key_id:value.api_key_id||null,api_key_name:value.api_key_name||null,
          credential_id:value.credential_id,credential_name:value.credential_name,mode:value.mode,model:value.model,status:value.status,
          outcome:value.outcome,created_at:value.created_at,requests:0,successes:0,failures:0,cancellations:0,total_duration_ms:0,
          input_tokens:null,output_tokens:null,thought_tokens:null,total_tokens:null,token_reports:0,last_success:null
        };
        row.requests++;row[value.outcome==='success'?'successes':value.outcome==='failed'?'failures':'cancellations']++;
        row.total_duration_ms+=value.duration_ms;
        for(const key of ['input_tokens','output_tokens','thought_tokens','total_tokens'])if(value[key]!=null)row[key]=(row[key]||0)+value[key];
        if(['input_tokens','output_tokens','thought_tokens','total_tokens'].some(key=>value[key]!=null))row.token_reports++;
        if(value.outcome==='success')row.last_success=Math.max(row.last_success||0,value.completed_at);
        value.diagnostics ||= [];
        if(!Array.isArray(value.diagnostics)||value.diagnostics.length>17)throw new Error('invalid diagnostics');
        for(const event of value.diagnostics){
          if(!Number.isSafeInteger(event.id)||event.request_id!==value.request_id||event.event_source!==3||!Number.isSafeInteger(event.created_at))throw new Error('invalid diagnostic event');
          sql.exec('INSERT OR IGNORE INTO node_events(event_key,sort_id,created_at,body)VALUES(?,?,?,?)',value.request_id+':'+event.id,event.id,event.created_at,JSON.stringify(event));
        }
        if(this.eventsCleanupAt<Date.now()){
          sql.exec('DELETE FROM node_events WHERE created_at<?',Date.now()-7*86400000);
          sql.exec('DELETE FROM node_events WHERE event_key IN(SELECT event_key FROM node_events ORDER BY created_at DESC LIMIT -1 OFFSET 2000)');
          this.eventsCleanupAt=Date.now()+60000;
        }
        row.last_used=Math.max(row.last_used||0,value.completed_at);
        if(value.outcome==='failed'){
          row.last_failure=Math.max(row.last_failure||0,value.completed_at);row.last_status=value.status;row.last_stage='request_failed';
        }
        for(const event of value.diagnostics)if(event.credential_id===value.credential_id&&event.status>=400&&event.status!==499&&event.created_at>=(row.last_failure||0)){
          row.last_failure=event.created_at;row.last_status=event.status;row.last_stage=event.stage;row.last_code=event.detail_code;
        }
        row.attempt_health ||= {};
        for(const event of value.diagnostics)if(event.credential_id&&event.status>=400&&event.status!==499&&event.created_at>(row.attempt_health[event.credential_id]?.last_failure||0))
          row.attempt_health[event.credential_id]={last_failure:event.created_at,last_status:event.status,last_stage:event.stage,last_code:event.detail_code};
        members.push(value.request_id);
        sql.exec('INSERT INTO telemetry_buckets(key,version,created_at,payload,members,dirty)VALUES(?,?,?,?,?,1) ON CONFLICT(key)DO UPDATE SET version=excluded.version,payload=excluded.payload,members=excluded.members,dirty=1',
          value.key,members.length,value.created_at,JSON.stringify(row),JSON.stringify(members));
        if(this.telemetryOrigin!==value.origin)sql.exec('INSERT INTO telemetry_config(id,origin)VALUES(1,?) ON CONFLICT(id)DO UPDATE SET origin=excluded.origin WHERE telemetry_config.origin<>excluded.origin',value.origin);
      });
      if(full)return Response.json({error:'telemetry capacity'},{status:409});
      this.telemetryOrigin=value.origin;
      await this.ensureAlarm();
      return Response.json({success:true,node_id:this.env.NODE_ID});
    }
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
        capabilities: ['cache-v1','usage-v1','telemetry-v1','events-v1'],
      });
    }
    if (path === '/health' && request.method === 'GET')
      return Response.json({
        success: true,
        node_id: this.env.NODE_ID,
        protocol: 1,
        storage: 'sqlite-do',
        mode: 'cache',
        capabilities: ['cache-v1','usage-v1','telemetry-v1','events-v1'],
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
    if(!['/health','/self-test','/cache-transfer','/usage','/telemetry/record','/telemetry/snapshot','/telemetry/flush','/events/query','/events/delete'].includes(path) && !/^\/cache\/[a-f0-9]{64}$/.test(path)) return new Response('Not found',{status:404});
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

import { dbCache } from './db-cache.js';
import { maybePrune } from './maintenance.js';
import { filters, credentialJoin, displayName } from './filters.js';
export function reportedUsage(meta) {
  const number = key => Number.isSafeInteger(meta?.[key]) && meta[key] >= 0 ? meta[key] : null;
  return { input: number('promptTokenCount'), output: number('candidatesTokenCount'), thought: number('thoughtsTokenCount'), total: number('totalTokenCount') };
}
export async function recordUsage(db, record) {
  if (!db) return;
  const u = reportedUsage(record.usage);
  const now = Date.now();
  try {
    const insert = db.prepare(`INSERT OR IGNORE INTO request_usage
      (request_id, credential_id, credential_name, mode, model, status, outcome, duration_ms, created_at, input_tokens, output_tokens, thought_tokens, total_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(record.requestId, record.row?.id || null, record.row?.data?.user_email || record.row?.name || '', record.mode, record.model,
        record.status, record.outcome, Math.max(0, now-record.started), record.started, u.input, u.output, u.thought, u.total);
    const statements = [insert];
    if (record.row && record.outcome === 'success') statements.push(db.prepare(`INSERT INTO credential_health (credential_id, last_success, failure_streak) SELECT id, ?, 0 FROM credentials WHERE id=? AND changes()>0
      ON CONFLICT(credential_id) DO UPDATE SET last_success=excluded.last_success, failure_streak=CASE WHEN COALESCE(last_failure,0)<=excluded.last_success THEN 0 ELSE failure_streak END WHERE last_success IS NULL OR last_success<excluded.last_success-60000 OR failure_streak>0`).bind(now,record.row.id));
    const results=await db.batch(statements);
    await maybePrune(db,results[0]);
  } catch { console.warn(JSON.stringify({ event: 'usage_save_failed', requestId: record.requestId })); }
}
const aggregates = `COUNT(*) AS requests,SUM(u.outcome='success') AS successes,SUM(u.outcome='failed') AS failures,
 SUM(u.outcome='cancelled') AS cancellations,SUM(u.duration_ms) AS total_duration_ms,
 SUM(u.input_tokens) AS input_tokens,SUM(u.output_tokens) AS output_tokens,SUM(u.thought_tokens) AS thought_tokens,
 SUM(u.total_tokens) AS total_tokens,SUM(u.input_tokens IS NOT NULL OR u.output_tokens IS NOT NULL OR u.thought_tokens IS NOT NULL OR u.total_tokens IS NOT NULL) AS token_reports`;
const sums=['requests','successes','failures','cancellations','total_duration_ms','input_tokens','output_tokens','thought_tokens','total_tokens','token_reports'];
function combine(target,row){for(const key of sums) if(row[key]!=null) target[key]=(target[key]??0)+row[key];return target;}
function finish(row){const {total_duration_ms,...result}=row;return {requests:0,successes:0,failures:0,cancellations:0,token_reports:0,input_tokens:null,output_tokens:null,thought_tokens:null,total_tokens:null,...result,avg_duration_ms:row.requests?Math.round(total_duration_ms/row.requests):null};}
export async function usageStats(db,params){
 const safe=new URLSearchParams(params);safe.delete('stage');safe.delete('before');safe.delete('fresh');
 const key=[...safe.entries()].sort().map(entry=>JSON.stringify(entry)).join(',');
 const cache=dbCache(db);cache.stats ||= new Map();
 if(params.get('fresh')!=='1' && cache.stats.get(key)?.until>Date.now()) return structuredClone(cache.stats.get(key).value);
 if(!safe.has('from'))safe.set('from',String(Date.now()-30*86400000));
 const {where,values}=filters(safe,'u',false);values.push(Date.now()-30*86400000);
 const sql=`SELECT u.credential_id,${displayName('u')} AS display_name,u.mode,u.model,
 strftime('%Y-%m-%d',u.created_at/1000,'unixepoch','+8 hours') AS day,${aggregates}
 FROM request_usage u`+credentialJoin('u')+where+(where?' AND ':' WHERE ')+'u.created_at>=? GROUP BY u.credential_id,u.mode,u.model,day';
 const rows=(await db.prepare(sql).bind(...values).all()).results;
 const summary={};const models=new Map(),credentials=new Map(),days=new Map();
 for(const row of rows){combine(summary,row);
   const modelKey=JSON.stringify([row.mode,row.model]);if(!models.has(modelKey))models.set(modelKey,{model:row.model,mode:row.mode});combine(models.get(modelKey),row);
   if(!credentials.has(row.credential_id))credentials.set(row.credential_id,{credential_id:row.credential_id,display_name:row.display_name});combine(credentials.get(row.credential_id),row);
   if(!days.has(row.day))days.set(row.day,{day:row.day});combine(days.get(row.day),row);
 }
 const ranked=map=>[...map.values()].sort((a,b)=>b.requests-a.requests).slice(0,200).map(finish);
 const value={summary:finish(summary),models:ranked(models),credentials:ranked(credentials),days:[...days.values()].sort((a,b)=>a.day.localeCompare(b.day)).map(finish),
   groups_truncated:models.size>200||credentials.size>200,retention:{days:30,max_requests:10127},timezone:'Asia/Shanghai',cached_at:Date.now(),cache_seconds:30};
 if(cache.stats.size>=20)cache.stats.delete(cache.stats.keys().next().value);
 cache.stats.set(key,{until:Date.now()+30000,value:structuredClone(value)});return value;
}
export async function credentialHealth(db, id) {
  const stored=await db.prepare(`SELECT h.*,(SELECT created_at+duration_ms FROM request_usage WHERE credential_id=c.id AND outcome='success' ORDER BY created_at DESC LIMIT 1) AS observed_success FROM credentials c LEFT JOIN credential_health h ON h.credential_id=c.id WHERE c.id=?`).bind(id).first();
  let health=null;
  if(stored && (stored.credential_id || stored.observed_success)){ const {observed_success,...fields}=stored; health={...fields,credential_id:id,last_success:Math.max(fields.last_success||0,observed_success||0)||null};
    if(health.last_success && health.last_success>=(health.last_failure||0))health.failure_streak=0;
  }
  const cooldowns = await db.prepare('SELECT model, until_ms, status FROM credential_cooldowns WHERE credential_id=? AND until_ms>? ORDER BY until_ms').bind(id, Date.now()).all();
  return { health, cooldowns: cooldowns.results };
}

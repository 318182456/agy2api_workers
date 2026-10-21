const DAY = 86400000,
  OFFSET = 28800000;
const sums = [
  'requests',
  'successes',
  'failures',
  'cancellations',
  'total_duration_ms',
  'input_tokens',
  'output_tokens',
  'thought_tokens',
  'total_tokens',
  'token_reports',
];
const tokens = ['input_tokens', 'output_tokens', 'thought_tokens', 'total_tokens'];
const dimensions = [
  'credential_id',
  'credential_name',
  'api_key_id',
  'api_key_name',
  'mode',
  'model',
  'status',
  'outcome',
];
export const dayStart = (time) => Math.floor((time + OFFSET) / DAY) * DAY - OFFSET;

// Memory-only daily rollups. Each live bucket updates one group by subtraction/addition;
// arbitrary boundary times and request-ID filters retain the original rows.
export class DailyStatsIndex {
  constructor(data) {
    this.rows = new Map();
    this.days = new Map();
    this.versions = new Map();
    this.liveVersions = new Map();
    for (const entry of data.aggregates) {
      this.put(entry.key, entry.value);
      this.versions.set(entry.key, entry.version);
    }
    for (const row of data.details)
      this.put('detail:' + row.request_id, {
        ...row,
        requests: 1,
        successes: Number(row.outcome === 'success'),
        failures: Number(row.outcome === 'failed'),
        cancellations: Number(row.outcome === 'cancelled'),
        total_duration_ms: row.duration_ms,
        token_reports: Number(tokens.some((key) => row[key] != null)),
      });
  }
  apply(key, row, sign) {
    const day = dayStart(row.created_at);
    let index = this.days.get(day);
    if (!index) {
      index = { rows: new Map(), groups: new Map() };
      this.days.set(day, index);
    }
    if (sign > 0) index.rows.set(key, row);
    else index.rows.delete(key);
    const hash = JSON.stringify(dimensions.map((name) => row[name] ?? null));
    let group = index.groups.get(hash);
    if (!group) {
      group = {
        row: {
          ...Object.fromEntries(dimensions.map((name) => [name, row[name]])),
          created_at: day,
        },
        seen: {},
      };
      index.groups.set(hash, group);
    }
    for (const name of sums) {
      if (row[name] != null) {
        group.seen[name] = (group.seen[name] || 0) + sign;
        group.row[name] = (group.row[name] || 0) + sign * row[name];
      }
      if (!group.seen[name]) group.row[name] = null;
    }
    if (!group.row.requests) index.groups.delete(hash);
    if (!index.rows.size) this.days.delete(day);
  }
  put(key, row) {
    const old = this.rows.get(key);
    if (old) this.apply(key, old, -1);
    this.rows.set(key, row);
    this.apply(key, row, 1);
  }
  remove(key) {
    const old = this.rows.get(key);
    if (old) {
      this.apply(key, old, -1);
      this.rows.delete(key);
    }
  }
  update(live) {
    let pending = 0;
    for (const [key, bucket] of live) {
      let cached = this.liveVersions.get(key);
      if (!cached || cached.version !== bucket.version) {
        cached = { version: bucket.version, value: JSON.parse(bucket.payload) };
        this.liveVersions.set(key, cached);
        for (const id of JSON.parse(bucket.members)) {
          this.remove('detail:' + id);
        }
        if ((this.versions.get(key) || 0) <= bucket.version) {
          this.put(key, cached.value);
          this.versions.set(key, bucket.version);
        }
      }
      if (bucket.dirty) pending += cached.value.requests;
    }
    this.pending = pending;
  }
  query(from, to, raw = false) {
    const result = [];
    let grouped = 0;
    for (const [day, index] of this.days) {
      if (day + DAY <= from || day > to) continue;
      if (!raw && day >= from && day + DAY - 1 <= to) {
        for (const group of index.groups.values()) result.push(group.row);
        grouped += index.groups.size;
      } else
        for (const row of index.rows.values())
          if (row.created_at >= from && row.created_at <= to) result.push(row);
    }
    return {
      rows: result,
      total_rows: this.rows.size,
      query_rows: result.length,
      daily_groups: grouped,
    };
  }
}

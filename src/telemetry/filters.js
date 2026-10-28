import { HttpError } from '../core/common.js';
export function filters(params, alias = 'l', cursor = true) {
  const predicates = [],
    values = [];
  const add = (sql, value) => {
    predicates.push(sql);
    values.push(value);
  };
  const get = (key) => params.get(key) || '';
  const id = get('credential_id');
  if (id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(400, '凭证 ID 无效');
    add(`${alias}.credential_id=?`, id);
  }
  const mode = get('mode');
  if (mode) {
    if (mode !== 'antigravity') throw new HttpError(400, '渠道无效');
    add(`${alias}.mode=?`, mode);
  }
  for (const key of ['model', 'request_id', 'stage']) {
    const value = get(key);
    if (value) {
      if (value.length > 200 || /[\x00-\x1f]/.test(value)) throw new HttpError(400, '筛选值无效');
      add(`${alias}.${key}=?`, value);
    }
  }
  const email = get('email');
  if (email) {
    if (email.length > 320) throw new HttpError(400, '邮箱筛选值过长');
    add(
      `instr(lower(COALESCE(CASE WHEN json_valid(c.data) THEN json_extract(c.data, '$.user_email') END, ${alias}.credential_name, '')), lower(?))>0`,
      email,
    );
  }
  const status = get('status');
  if (status) {
    if (/^[1-5]xx$/.test(status)) {
      predicates.push(`${alias}.status BETWEEN ? AND ?`);
      values.push(Number(status[0]) * 100, Number(status[0]) * 100 + 99);
    } else if (/^[1-5][0-9]{2}$/.test(status)) add(`${alias}.status=?`, Number(status));
    else throw new HttpError(400, '状态码须为 100–599 或 2xx 等分类');
  }
  const dates = {};
  for (const key of ['from', 'to']) {
    const raw = get(key);
    if (!raw) continue;
    const value = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
    if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000)
      throw new HttpError(400, '时间范围无效');
    dates[key] = value;
    add(`${alias}.created_at${key === 'from' ? '>=' : '<='}?`, value);
  }
  if (dates.from != null && dates.to != null && dates.from > dates.to)
    throw new HttpError(400, '开始时间不能晚于结束时间');
  const before = get('before');
  if (cursor && before) {
    if (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)))
      throw new HttpError(400, '分页游标无效');
    add(`${alias}.id<?`, Number(before));
  }
  return { where: predicates.length ? ' WHERE ' + predicates.join(' AND ') : '', values };
}
export const credentialJoin = (alias) => ` LEFT JOIN credentials c ON c.id=${alias}.credential_id`;
export const displayName = (alias) =>
  `COALESCE(NULLIF(CASE WHEN json_valid(c.data) THEN json_extract(c.data, '$.user_email') END,''), c.name, NULLIF(${alias}.credential_name,''), '未选中凭证')`;

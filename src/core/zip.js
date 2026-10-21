import { HttpError } from './common.js';
const MAX = 4 * 1024 * 1024;
function bad(message = 'ZIP 格式无效或不受支持') {
  return new HttpError(400, message);
}
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
export async function readBytes(stream, limit = MAX) {
  if (!stream) throw bad('文件为空');
  const reader = stream.getReader(),
    chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        reader.cancel().catch(() => {});
        throw new HttpError(413, '文件或解压内容超过大小限制');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
function safeName(name) {
  return (
    name &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    !name.startsWith('/') &&
    !/^[A-Za-z]:/.test(name) &&
    !name.split('/').some((part) => part === '..' || part === '.')
  );
}
export async function readZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > MAX) throw new HttpError(413, 'ZIP 不能超过 4 MiB');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === bytes.length
    ) {
      end = i;
      break;
    }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw bad();
  const count = view.getUint16(end + 10, true),
    start = view.getUint32(end + 16, true),
    directorySize = view.getUint32(end + 12, true);
  if (
    !count ||
    count > 100 ||
    view.getUint16(end + 8, true) !== count ||
    start + directorySize > end
  )
    throw bad('ZIP 最多包含 100 个条目，不支持分卷或 ZIP64');
  const files = [],
    seen = new Set();
  let cursor = start,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > start + directorySize || view.getUint32(cursor, true) !== 0x02014b50)
      throw bad();
    const flags = view.getUint16(cursor + 8, true),
      method = view.getUint16(cursor + 10, true),
      crc = view.getUint32(cursor + 16, true),
      compressed = view.getUint32(cursor + 20, true),
      size = view.getUint32(cursor + 24, true);
    const nameSize = view.getUint16(cursor + 28, true),
      extra = view.getUint16(cursor + 30, true),
      comment = view.getUint16(cursor + 32, true),
      local = view.getUint32(cursor + 42, true);
    if (
      cursor + 46 + nameSize + extra + comment > start + directorySize ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      size > 1024 * 1024
    )
      throw bad('ZIP 条目过大、已加密或压缩算法不受支持');
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
    let name;
    try {
      name = decoder.decode(nameBytes);
    } catch {
      throw bad('ZIP 文件名必须为 UTF-8');
    }
    cursor += 46 + nameSize + extra + comment;
    if (!safeName(name) || seen.has(name)) throw bad('ZIP 文件路径不安全或重复');
    seen.add(name);
    if (name.endsWith('/')) continue;
    if (!name.toLowerCase().endsWith('.json')) throw bad('ZIP 只能包含 JSON 凭证文件');
    if (
      local + 30 > start ||
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 8, true) !== method
    )
      throw bad();
    const localNameSize = view.getUint16(local + 26, true),
      localExtra = view.getUint16(local + 28, true),
      dataStart = local + 30 + localNameSize + localExtra;
    if (
      dataStart + compressed > start ||
      !bytes
        .subarray(local + 30, local + 30 + localNameSize)
        .every((byte, index) => byte === nameBytes[index]) ||
      localNameSize !== nameSize
    )
      throw bad();
    let data = bytes.subarray(dataStart, dataStart + compressed);
    if (method === 8)
      try {
        data = await readBytes(
          new Response(data).body.pipeThrough(new DecompressionStream('deflate-raw')),
          Math.min(1024 * 1024, MAX - total),
        );
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw bad('ZIP 压缩内容无效');
      }
    total += data.length;
    if (total > MAX || data.length !== size || crc32(data) !== crc)
      throw bad('ZIP 解压大小或校验和不匹配');
    files.push({ name, data });
  }
  if (!files.length) throw bad('ZIP 中没有 JSON 凭证');
  return files;
}
export function writeZip(files) {
  if (!files.length || files.length > 100) throw bad('每份 ZIP 需包含 1–100 个凭证');
  const encoder = new TextEncoder(),
    local = [],
    central = [];
  let offset = 0,
    total = 0;
  for (const file of files) {
    if (!safeName(file.name)) throw bad('ZIP 文件名无效');
    const name = encoder.encode(file.name),
      data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    total += data.length;
    if (total > MAX || data.length > 1024 * 1024) throw new HttpError(413, '备份过大，请分批导出');
    const header = new Uint8Array(30 + name.length),
      h = new DataView(header.buffer),
      crc = crc32(data);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x800, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true);
    header.set(name, 30);
    const entry = new Uint8Array(46 + name.length),
      c = new DataView(entry.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x800, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    entry.set(name, 46);
    local.push(header, data);
    central.push(entry);
    offset += header.length + data.length;
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0),
    end = new Uint8Array(22),
    e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);
  if (offset + centralSize + 22 > MAX) throw new HttpError(413, 'ZIP 超过 4 MiB，请分批导出');
  const result = new Uint8Array(offset + centralSize + 22);
  let position = 0;
  for (const part of [...local, ...central, end]) {
    result.set(part, position);
    position += part.length;
  }
  return result;
}

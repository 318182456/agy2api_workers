import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const configPath = new URL('../wrangler.jsonc', import.meta.url);
export async function prepareKv(run = wrangler, path = configPath) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  const binding = config.kv_namespaces?.find((item) => item.binding === 'CACHE');
  if (!binding || binding.id) return;
  let namespaces = JSON.parse(run(['kv', 'namespace', 'list']));
  let namespace = namespaces.find((item) => item.title === 'agy2api_workers');
  if (!namespace) {
    run(['kv', 'namespace', 'create', 'agy2api_workers', '--update-config=false']);
    namespaces = JSON.parse(run(['kv', 'namespace', 'list']));
    namespace = namespaces.find((item) => item.title === 'agy2api_workers');
  }
  if (!/^[a-f0-9]{32}$/i.test(namespace?.id || ''))
    throw new Error('KV agy2api_workers namespace ID missing; deployment stopped');
  binding.id = namespace.id;
  await writeFile(path, JSON.stringify(config, null, 2) + '\n');
  console.log('KV agy2api_workers connected as CACHE');
}
function wrangler(args) {
  return execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)), ...args],
    { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] },
  );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  await prepareKv();

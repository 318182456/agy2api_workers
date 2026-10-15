import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
const directory = new URL('../src/panel-scripts/', import.meta.url);
const options = await resolveConfig(fileURLToPath(new URL('../.prettierrc.json', import.meta.url)));
let invalid = false;
for (const file of await readdir(directory)) {
  if (!file.endsWith('.js')) continue;
  const path = new URL(file, directory),
    source = await readFile(path, 'utf8');
  const match = source.match(/String\.raw`([\s\S]*)`;\s*$/);
  if (!match) throw new Error('Unrecognized panel source: ' + file);
  const body = match[1]
    .replace('${JSON.stringify(panelPages)}', '__PAGE_DEFINITIONS__')
    .replace('${analyticsScript}', '__ANALYTICS_SCRIPT__();');
  const formatted = (await format(body, { ...options, parser: 'babel' }))
    .replace('__PAGE_DEFINITIONS__', '${JSON.stringify(panelPages)}')
    .replace('__ANALYTICS_SCRIPT__();', '${analyticsScript}');
  const result = source.slice(0, match.index) + 'String.raw`' + formatted + '`;\n';
  if (result !== source) {
    if (process.argv.includes('--check')) {
      console.error('Panel format: ' + file);
      invalid = true;
    } else await writeFile(path, result);
  }
}
if (invalid) process.exitCode = 1;

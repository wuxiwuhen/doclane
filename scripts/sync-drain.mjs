// scripts/sync-drain.mjs — 把 runner/drain.py 内容同步为 api/_lib/drain_source.js
// （Vercel 函数打包时无法读取 api/ 之外的文件，故把源码内联为字符串模块）
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(root, 'runner', 'drain.py'), 'utf8');
const out = `// 自动生成：scripts/sync-drain.mjs 由 runner/drain.py 生成，勿手改\n`
  + `export default ${JSON.stringify(src)};\n`;
writeFileSync(join(root, 'api', '_lib', 'drain_source.js'), out);
console.log('drain_source.js 已同步，%d bytes', Buffer.byteLength(out));

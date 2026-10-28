// Resolve tests without a shell so npm test works in cmd.exe as well as POSIX.
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const files = readdirSync(new URL('../test/', import.meta.url)).filter(name => name.endsWith('.test.ts')).sort().map(name => `test/${name}`);
const child = spawn(process.execPath, ['--experimental-transform-types', '--test', '--test-concurrency=4', ...process.argv.slice(2), ...files], { cwd: resolve(import.meta.dirname, '..'), env: { ...process.env, TZ: 'Asia/Shanghai' }, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });

import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, mkdtemp, realpath, rm, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { unzipSync } from '../tpr/fflate/esm/index.mjs';
const filename = process.argv[2]; if (!filename || !process.env.TMPDIR || !process.env.XDG_CACHE_HOME) throw new Error('Usage: package-test.mjs <ZIP>; TMPDIR and XDG_CACHE_HOME required.');
const bytes = await readFile(filename), sha256 = createHash('sha256').update(bytes).digest('hex');
const parent = await realpath(process.env.TMPDIR), work = await mkdtemp(path.join(parent, 'dsh Godot package '));
const evidence = path.join(process.env.XDG_CACHE_HOME, 'dsh-godot-control', 'verification', path.basename(work)); await mkdir(evidence, { recursive: true, mode: 0o700 });
const report = { started_at: new Date().toISOString(), archive: filename, sha256, ok: false, steps: [] };
async function run(args, cwd, log) {
  const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const [code, signal] = await once(child, 'exit'); await writeFile(path.join(evidence, log), output);
  assert.equal(code, 0, `${log}: ${code} ${signal}\n${output.slice(-10000)}`); console.log(`PASS ${log}`); report.steps.push(log);
}
try {
  const unpacked = unzipSync(bytes), roots = new Set();
  for (const [name, data] of Object.entries(unpacked)) {
    assert.ok(!name.startsWith('/') && !name.includes('\\') && !name.includes('\0') && !name.split('/').some(part => ['..', '.'].includes(part)), `Unsafe archive entry: ${name}`);
    roots.add(name.split('/')[0]); const destination = path.resolve(work, name); assert.ok(destination.startsWith(work + path.sep));
    await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, data);
  }
  assert.equal(roots.size, 1); const stage = path.join(work, [...roots][0]), inventory = JSON.parse(await readFile(path.join(stage, 'SOURCE-MANIFEST.json'), 'utf8'));
  assert.equal(Object.keys(unpacked).length, inventory.files.length + 1);
  for (const file of inventory.files) { const data = await readFile(path.join(stage, file.path)); assert.equal(data.length, file.size); assert.equal(createHash('sha256').update(data).digest('hex'), file.sha256, file.path); }
  report.file_count = inventory.files.length + 1; report.steps.push('extract and verify all source hashes');
  await run(['scripts/check.mjs'], stage, 'check.log');
  const tests = (await readdir(path.join(stage, 'test'))).filter(name => name.endsWith('.test.js')).map(name => path.join('test', name));
  await run(['--test', ...tests], stage, 'unit.log');
  await run(['scripts/native-test.mjs'], stage, 'native.log');
  report.ok = true;
} catch (error) { report.error = { code: error.code || error.name, message: error.message }; console.error(error.message); process.exitCode = 1; }
finally {
  const target = await realpath(work); assert.equal(path.dirname(target), parent); assert.ok(path.basename(target).startsWith('dsh Godot package ')); await rm(target, { recursive: true });
  report.finished_at = new Date().toISOString(); await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: report.ok, report: path.join(evidence, 'report.json') }));
}

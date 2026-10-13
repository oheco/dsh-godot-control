import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
/** Use the running local DSH host's login flow; credentials stay in memory. */
export async function authenticateDSH(pid, base = process.env.DSH_WEB_URL) {
  if (!/^\d+$/.test(String(pid)) || !base || new URL(base).hostname !== '127.0.0.1') throw new Error('An existing DSH host PID and loopback DSH_WEB_URL are required.');
  const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
  const index = argv.indexOf('--token'); if (index < 0) throw new Error('DSH launch authentication is unavailable.');
  const loginUrl = new URL('/', base); loginUrl.searchParams.set('token', argv[index + 1]);
  const login = await fetch(loginUrl, { redirect: 'manual' });
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  if (login.status !== 303 || !cookie) throw new Error('DSH login did not return a session cookie.');
  return { base, cookie, async request(method, args = {}) {
    const response = await fetch(new URL('/api/' + method, base), { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) });
    const result = await response.json();
    if (!response.ok || !result.result?.ok) throw new Error(`DSH ${method} failed: ${JSON.stringify(result.result?.error || { status: response.status })}`);
    return result.result.value;
  } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [pid, method, args = '{}'] = process.argv.slice(2);
  if (!/^pluginManager\/\w+$/.test(method || '')) throw new Error('Usage: dsh-manager.mjs <host-pid> pluginManager/<method> <JSON-args>');
  const client = await authenticateDSH(pid), result = await client.request(method, JSON.parse(args));
  const rows = Array.isArray(result) ? result : null;
  const output = rows ? rows.filter(row => row.name === '@oheco/dsh-godot-control' || row.moduleName?.includes('dsh-godot-control') || row.entryId?.includes('oheco-godot-control')) : result;
  console.log(JSON.stringify(output, null, 2));
  if (result?.application === 'failed') process.exitCode = 1;
}

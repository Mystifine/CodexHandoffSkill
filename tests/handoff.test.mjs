import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { alive, loadState, readJson, reserve, release, safeRemove, withLock, writeJson } from '../scripts/state.mjs';
import { limitResetAt, summarize } from '../scripts/summarize.mjs';
import { snapshot, finishSnapshot, git } from '../scripts/snapshot.mjs';
import { cleanup } from '../scripts/cleanup.mjs';
import { parse } from '../scripts/handoff.mjs';

const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
const fakeSource = `
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
const args=process.argv.slice(2);
if(args.includes('--version')) {console.log('codex-fake 1');process.exit(0);}
if(args[0]==='login') process.exit(0);
if(args[0]==='mcp') {console.log(process.env.FAKE_SERVERS||'[]');process.exit(0);}
if(args[0]==='debug') {console.log(JSON.stringify({models:[{slug:'fallback-a',visibility:'list'},{slug:'fallback-b',visibility:'list'},{slug:'fallback-c',visibility:'list'}]}));process.exit(0);}
const final=args[args.indexOf('-o')+1], dir=path.dirname(final), scenario=process.env.FAKE_SCENARIO||'ok';
fs.appendFileSync(process.env.FAKE_CALLS,JSON.stringify({args,cwd:process.cwd(),dir,pid:process.pid})+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:args[1]==='resume'?args[2]:crypto.randomUUID()}));
if(process.env.FAKE_CHILD) {
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 fs.writeFileSync(process.env.FAKE_CHILD,String(child.pid));
}
await new Promise(r=>setTimeout(r,Number(process.env.FAKE_DELAY||0)));
if(process.env.FAKE_HOLD) while(!fs.existsSync(process.env.FAKE_HOLD)) await new Promise(r=>setTimeout(r,25));
if(process.env.FAKE_CHECKPOINT) fs.writeFileSync(path.join(dir,'checkpoint.json'),JSON.stringify({done:['phase 1 textures'],next:'phase 2 review sheets'}));
if(process.env.FAKE_EDIT_BYTES) fs.writeFileSync(path.join(process.cwd(),'large.bin'),crypto.randomBytes(Number(process.env.FAKE_EDIT_BYTES)));
if(scenario==='limit') {console.log(JSON.stringify({type:'error',message:"You've hit your usage limit. Try again in 1 second."}));process.exit(1);}
if(scenario==='model-missing'&&!args.includes('fallback-a')) {console.log(JSON.stringify({type:'error',message:'model_not_found'}));process.exit(1);}
const probe=args.some(a=>a.includes('the two letters "OK"'));
if(process.env.FAKE_EDIT) fs.writeFileSync(path.join(process.cwd(),process.env.FAKE_EDIT),'after\\n');
if(scenario==='sandbox') console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',exit_code:1,aggregated_output:'helper_unknown_error: setup refresh had errors'}}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:scenario==='mentions-error'?'Implemented model_not_found handling':'done'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:2,output_tokens:3}}));
fs.writeFileSync(final,probe?'OK':'Work finished.');
if(!probe&&scenario!=='missing-result') fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({status:scenario==='blocked'?'blocked':'completed',verification:'fixture check passed',reason:scenario==='blocked'?'tool unavailable':''}));
`;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'));
  const root = path.join(dir, 'home'), cwd = path.join(dir, 'repo'), codexHome = path.join(dir, 'codex');
  fs.mkdirSync(root); fs.mkdirSync(cwd); fs.mkdirSync(codexHome);
  const fake = path.join(dir, 'fake.mjs'), calls = path.join(dir, 'calls.jsonl'), brief = path.join(dir, 'brief.md');
  fs.writeFileSync(fake, fakeSource); fs.writeFileSync(brief, 'Perform the fixture task.');
  const env = { ...process.env, CODEX_HANDOFF_HOME: root, CODEX_HOME: codexHome, CODEX_HANDOFF_CLI: fake,
    CODEX_HANDOFF_MODEL: '', CODEX_HANDOFF_EFFORT: '', CODEX_HANDOFF_FALLBACK_MODELS: '', CODEX_HANDOFF_SANDBOX: '', FAKE_CALLS: calls };
  const children = new Set();
  const launch = (args, overrides = {}) => {
    const child = spawn(process.execPath, [path.join(scripts, 'handoff.mjs'), ...args], { env: { ...env, ...overrides }, cwd, windowsHide: true });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
    const done = new Promise((resolve) => child.on('close', (code) => { children.delete(child); resolve({ code, stdout, stderr }); }));
    return { child, done };
  };
  t.after(async () => {
    for (const child of children) { if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); else child.kill('SIGTERM'); }
    await sleep(100);
    safeRemove(os.tmpdir(), dir);
  });
  return { dir, root, cwd, codexHome, brief, calls, env, launch, args: ['--brief', brief, '--cd', cwd],
    invocations: () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
}
async function until(check, message) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { if (check()) return; await sleep(25); }
  assert.fail(message);
}
function initRepo(cwd) {
  git(cwd, ['init']); fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'initial\n');
  git(cwd, ['add', '.']); git(cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
}
function reportFixture(f, name, eventList, result, final = 'done') {
  const project = path.join(f.root, 'project'); fs.mkdirSync(project, { recursive: true });
  const dir = fs.mkdtempSync(path.join(project, `20261025-100000-${name}-`));
  writeJson(path.join(dir, 'invocation.json'), { root: f.root, project, accountKey: 'account' });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), eventList.map(JSON.stringify).join('\n'));
  fs.writeFileSync(path.join(dir, 'final.md'), final);
  if (result) writeJson(path.join(dir, 'result.json'), result);
  return dir;
}
const done = { type: 'turn.completed', usage: { input_tokens: 1 } };
const result = { status: 'completed', verification: 'checks passed', reason: '' };

test('invalid/missing arguments fail promptly', () => {
  for (const args of [['--brief'], ['--timeout-min', 'NaN'], ['--brief', 'x', '--check']]) assert.throws(() => parse(args), /Missing|timeout|Choose/);
});
test('completion requires a task result, completed turn, and successful infrastructure', async (t) => {
  const f = fixture(t), now = Math.floor(Date.now() / 1000);
  const cases = [
    ['ok', [done], result, 0], ['missing', [done], null, 4], ['incomplete-stream', [], result, 4],
    ['blocked', [done], { ...result, status: 'blocked', reason: 'cannot finish' }, 4],
    ['sandbox', [{ type: 'item.completed', item: { type: 'command_execution', exit_code: 1, aggregated_output: 'helper_unknown_error: setup refresh had errors' } }, done], result, 4],
    ['recovered-command', [{ type: 'item.completed', item: { type: 'command_execution', exit_code: 1, aggregated_output: 'a recoverable test failed' } }, done], result, 0],
  ];
  for (const [name, events, taskResult, expected] of cases) {
    const report = await summarize(reportFixture(f, name, events, taskResult), 0, now, now, f.cwd);
    assert.equal(report.exit, expected, name);
  }
});
test('usage limit resets honor stated delays, dates and local clock times', () => {
  const local = (h, m, day = 25) => Math.round(new Date(2026, 9, day, h, m).getTime() / 1000);
  const stated = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 5:01 PM.";
  assert.equal(limitResetAt(stated, local(14, 0)), local(17, 1));
  assert.equal(limitResetAt(stated, local(17, 30)), local(17, 1, 26));
  assert.equal(limitResetAt('usage limit: try again at 17:01', local(14, 0)), local(17, 1));
  assert.equal(limitResetAt('usage limit: try again in 5 minutes', local(14, 0)), local(14, 5));
  assert.equal(limitResetAt('usage limit: try again on Oct 27th, 2026 9:00 AM.', local(14, 0)), local(9, 0, 27));
  assert.equal(limitResetAt('usage limit reached', local(14, 0)), local(14, 30));
});
test('a usage limit records a runnable resume that --wait replays and the next run clears', async (t) => {
  const f = fixture(t), note = "review the sheets, then run verify (user's approval: resume as-is)";
  const words = (command) => [...command.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map((m) => m[1] !== undefined ? m[1].replaceAll("'\\''", "'") : m[2]);
  const limited = await f.launch([...f.args, '--mcp', 'blender', '--note', note], { FAKE_SCENARIO: 'limit', FAKE_SERVERS: '[{"name":"blender"}]', FAKE_CHECKPOINT: '1' }).done;
  assert.equal(limited.code, 2, limited.stderr);
  const [entry] = Object.values(loadState(f.root).pending);
  assert.match(limited.stdout, /resume after reset: bash /);
  assert.match(entry.checkpoint, /^1 step\(s\) done \(last: phase 1 textures\); next: phase 2 review sheets$/);
  assert.equal(entry.goal, 'Perform the fixture task.');
  const argv = words(entry.command).slice(2), resumed = parse(argv);
  assert.equal(resumed.resume, entry.thread); assert.equal(resumed.note, note); assert.deepEqual(resumed.mcp, ['blender']);
  assert.equal(resumed.cd, path.resolve(readJson(path.join(entry.runDir, 'invocation.json')).cwd));
  const waiting = f.launch(['--wait']);
  assert.equal(loadState(f.root).reservations.length, 0);
  const woke = await waiting.done;
  assert.equal(woke.code, 0, woke.stderr);
  assert.ok(woke.stdout.includes(`next: ${note}`) && woke.stdout.includes(`resume: ${entry.command}`) && woke.stdout.includes('codex progress: 1 step(s)'));
  const again = await f.launch(argv, { FAKE_SERVERS: '[{"name":"blender"}]' }).done;
  assert.equal(again.code, 0, again.stdout + again.stderr);
  const resumedCall = f.invocations().at(-1);
  assert.ok(resumedCall.args.some((arg) => arg.includes('Your last checkpoint is')));
  assert.equal(readJson(path.join(resumedCall.dir, 'checkpoint.json')).next, 'phase 2 review sheets');
  assert.deepEqual(loadState(f.root).pending, {});
  assert.equal((await f.launch(['--wait']).done).code, 1);
});
test('review patches larger than any memory buffer are written to disk', async (t) => {
  const f = fixture(t); initRepo(f.cwd);
  const run = await f.launch(f.args, { FAKE_EDIT_BYTES: String(20 * 1024 * 1024) }).done;
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const dir = f.invocations()[0].dir;
  assert.equal(fs.existsSync(path.join(dir, 'snapshot-error.txt')), false);
  assert.ok(fs.statSync(path.join(dir, 'changes.patch')).size > 20 * 1024 * 1024);
  assert.match(run.stdout, /MB including binary content; for text only: git -C/);
});
test('task cleanup measures director usage from session transcripts since the first run', async (t) => {
  const f = fixture(t), config = path.join(f.dir, 'claude'), start = Date.now() - 60000;
  const runDir = reportFixture(f, 'measured', [done], result);
  writeJson(path.join(runDir, 'invocation.json'), { root: f.root, project: path.join(f.root, 'project'), claudeSession: 'director', startedAt: start });
  writeJson(path.join(runDir, 'meta.json'), { threadId: 'task', usage: { input_tokens: 50, cached_input_tokens: 20, output_tokens: 5 } });
  const message = (id, at, usage) => JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { id, usage } });
  const usage = { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 10 };
  fs.mkdirSync(path.join(config, 'projects', 'p', 'director', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(config, 'projects', 'p', 'director.jsonl'), [message('old', start - 1000, usage), message('a', start + 1000, usage), message('a', start + 1000, usage), '{"type":"user"}'].join('\n'));
  fs.writeFileSync(path.join(config, 'projects', 'p', 'director', 'subagents', 'agent.jsonl'), message('b', start + 2000, usage));
  const saved = { config: process.env.CLAUDE_CONFIG_DIR, session: process.env.CLAUDE_CODE_SESSION_ID };
  process.env.CLAUDE_CONFIG_DIR = config; delete process.env.CLAUDE_CODE_SESSION_ID;
  t.after(() => { for (const [key, name] of [['config', 'CLAUDE_CONFIG_DIR'], ['session', 'CLAUDE_CODE_SESSION_ID']]) if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key]; });
  await cleanup(f.root, '--thread', 'task');
  const [header, row] = fs.readFileSync(path.join(f.root, 'project', 'usage.tsv'), 'utf8').trim().split('\n').map((line) => line.split('\t'));
  const record = Object.fromEntries(header.map((name, i) => [name, row[i]]));
  assert.deepEqual([record.codex_input, record.claude_input, record.claude_cache_write, record.claude_cache_read, record.claude_output, record.claude_messages],
    ['50', '6', '200', '2000', '20', '2']);
});
test('simultaneous summaries preserve the longest limit and every ledger row', async (t) => {
  const f = fixture(t), now = Math.floor(Date.now() / 1000);
  const dirs = Array.from({ length: 12 }, (_, i) => reportFixture(f, `summary-${i}`,
    i < 2 ? [{ type: 'error', message: `usage limit: try again in ${i === 0 ? 60 : 5} minutes` }] : [done], i < 2 ? null : result));
  await Promise.all(dirs.map((dir, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scripts, 'summarize.mjs'), dir, i < 2 ? '1' : '0', String(now), String(now), f.cwd], { env: f.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject); child.on('close', (code) => code === (i < 2 ? 2 : 0) ? resolve() : reject(new Error(`summary ${i} exit ${code}: ${stderr}`)));
  })));
  assert.equal(loadState(f.root).limits.account.until, now + 3600);
  const rows = fs.readFileSync(path.join(f.root, 'project', 'ledger.tsv'), 'utf8').trim().split('\n');
  assert.equal(rows.length, 13); assert.equal(rows.filter((row) => row.startsWith('date\t')).length, 1);
});
test('installer merges safely, is idempotent, and preserves invalid settings', async (t) => {
  const f = fixture(t), config = path.join(f.dir, 'claude'); fs.mkdirSync(config);
  const settings = path.join(config, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', permissions: { defaultMode: 'default', allow: ['Bash(git status)'] }, autoMode: { allow: [
    '$defaults', "Running the user's codex-handoff wrapper (bash ~/.claude/skills/codex-handoff/scripts/handoff.sh ...) to launch, resume, check, cancel or clean local Codex CLI runs, including with --sandbox danger-full-access, which is the user's chosen default (set 2026-10-25).",
    'Running the codex-handoff wrapper (bash ~/.claude/skills/codex-handoff/scripts/handoff.sh ...) to launch, resume, check, cancel or clean local Codex CLI runs, including with --sandbox danger-full-access.', 'My local build rule',
  ] } }));
  await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scripts, 'install.mjs')], { env: { ...f.env, CLAUDE_CONFIG_DIR: config }, stdio: 'ignore' });
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`install exit ${code}`)));
  })));
  const first = fs.readFileSync(settings, 'utf8'), parsed = JSON.parse(first);
  assert.equal(parsed.theme, 'dark'); assert.equal(parsed.permissions.defaultMode, 'default'); assert.equal(parsed.permissions.allow.length, 2);
  assert.equal(parsed.autoMode.allow.length, 3); assert.ok(parsed.autoMode.allow.includes('My local build rule'));
  assert.equal(spawnSync(process.execPath, [path.join(scripts, 'install.mjs')], { env: { ...f.env, CLAUDE_CONFIG_DIR: config } }).status, 0);
  assert.equal(fs.readFileSync(settings, 'utf8'), first);
  fs.writeFileSync(settings, '{invalid');
  assert.equal(spawnSync(process.execPath, [path.join(scripts, 'install.mjs')], { env: { ...f.env, CLAUDE_CONFIG_DIR: config } }).status, 1);
  assert.equal(fs.readFileSync(settings, 'utf8'), '{invalid');
});
test('snapshot includes pre-existing untracked content without changing the index', (t) => {
  const f = fixture(t); initRepo(f.cwd);
  fs.writeFileSync(path.join(f.cwd, 'tracked.txt'), 'user staged\n'); git(f.cwd, ['add', 'tracked.txt']);
  fs.writeFileSync(path.join(f.cwd, 'tracked.txt'), 'user unstaged\n'); fs.writeFileSync(path.join(f.cwd, 'existing.txt'), 'before\n');
  const index = fs.readFileSync(path.join(f.cwd, '.git', 'index'));
  const before = snapshot(f.cwd, f.root, 'before');
  fs.writeFileSync(path.join(f.cwd, 'existing.txt'), 'after  \n');
  finishSnapshot(f.cwd, f.root, before);
  const patch = fs.readFileSync(path.join(f.root, 'changes.patch'), 'utf8');
  assert.match(patch, /-before\n\+after  \n/); assert.doesNotMatch(patch, /user unstaged/);
  assert.deepEqual(fs.readFileSync(path.join(f.cwd, '.git', 'index')), index);
});
test('same checkout refuses overlap; cancellation targets only the owned process tree', async (t) => {
  const f = fixture(t), childFile = path.join(f.dir, 'child.pid');
  const first = f.launch(f.args, { FAKE_DELAY: '20000', FAKE_CHILD: childFile });
  await until(() => f.invocations().length === 1 && fs.existsSync(childFile), 'first run did not start');
  const second = await f.launch(f.args).done; assert.equal(second.code, 75, second.stderr); assert.equal(f.invocations().length, 1);
  const runDir = f.invocations()[0].dir;
  const cancelled = await f.launch(['--cancel', runDir]).done; assert.equal(cancelled.code, 0, cancelled.stderr);
  const stopped = await first.done; assert.equal(stopped.code, 4, stopped.stderr); assert.match(stopped.stdout, /CANCELLED/);
  assert.equal(alive(Number(fs.readFileSync(childFile, 'utf8'))), false);
  assert.equal(loadState(f.root).reservations.length, 0);
});
test('independent worktrees run concurrently and retain reviewable results', async (t) => {
  const f = fixture(t); initRepo(f.cwd);
  const first = f.launch([...f.args, '--worktree'], { FAKE_DELAY: '1500', FAKE_EDIT: 'output.txt' });
  const second = f.launch([...f.args, '--worktree'], { FAKE_DELAY: '1500', FAKE_EDIT: 'output.txt' });
  await until(() => f.invocations().length === 2, 'both independent workers did not start');
  const calls = f.invocations(); assert.notEqual(calls[0].cwd, calls[1].cwd);
  for (const completed of await Promise.all([first.done, second.done])) assert.equal(completed.code, 0, completed.stderr);
  assert.equal(fs.existsSync(path.join(f.cwd, 'output.txt')), false);
  for (const call of calls) { assert.equal(fs.readFileSync(path.join(call.cwd, 'output.txt'), 'utf8'), 'after\n'); assert.match(fs.readFileSync(path.join(call.dir, 'changes.patch'), 'utf8'), /output.txt/); }
});
test('app resources and resumed threads are exclusive across separate directories', async (t) => {
  const f = fixture(t), other = path.join(f.dir, 'other'); fs.mkdirSync(other);
  for (const [i, option] of [['--resource', 'blender'], ['--resume', 'same-thread']].entries()) {
    const hold = path.join(f.dir, `hold-${i}`);
    const first = f.launch([...f.args, ...option], { FAKE_HOLD: hold });
    const expected = f.invocations().length + 1;
    await until(() => f.invocations().length >= expected, 'resource owner did not start');
    const second = await f.launch(['--brief', f.brief, '--cd', other, ...option]).done;
    fs.writeFileSync(hold, '');
    assert.equal(second.code, 75, second.stderr); assert.equal((await first.done).code, 0);
  }
});
test('successful diagnostic text never triggers model replay; actual model failure falls back', async (t) => {
  const f = fixture(t);
  const good = await f.launch(f.args, { FAKE_SCENARIO: 'mentions-error' }).done;
  assert.equal(good.code, 0, good.stderr); assert.equal(f.invocations().length, 1);
  const fallback = await f.launch(f.args, { FAKE_SCENARIO: 'model-missing' }).done;
  assert.equal(fallback.code, 0, fallback.stderr); assert.equal(f.invocations().length, 3);
});
test('timeout stops the worker and reports a timeout instead of success', async (t) => {
  const f = fixture(t);
  const timed = await f.launch([...f.args, '--timeout-min', '0.01'], { FAKE_DELAY: '20000' }).done;
  assert.equal(timed.code, 3, timed.stderr); assert.match(timed.stdout, /TIMED OUT/); assert.equal(loadState(f.root).reservations.length, 0);
});
test('cleanup cannot delete active resumes or prune unfinished runs', async (t) => {
  const f = fixture(t), runDir = reportFixture(f, 'old', [done], result);
  writeJson(path.join(runDir, 'meta.json'), { threadId: 'thread', usage: {} });
  const token = crypto.randomUUID();
  await reserve(f.root, { token, pid: process.pid, childPid: null, runDir, paths: [], resources: ['thread:thread'], thread: 'thread' });
  await assert.rejects(cleanup(f.root, '--thread', 'thread'), /active/);
  const old = new Date(Date.now() - 10 * 86400000); fs.utimesSync(runDir, old, old);
  await cleanup(f.root, '--prune', '3'); assert.ok(fs.existsSync(runDir));
  await release(f.root, token); await cleanup(f.root, '--thread', 'thread', 100); assert.equal(fs.existsSync(runDir), false);
});
test('overlapping additional writable roots are rejected', async (t) => {
  const f = fixture(t), nested = path.join(f.cwd, 'nested'); fs.mkdirSync(nested);
  await reserve(f.root, { token: 'a', pid: process.pid, runDir: f.root, paths: [f.cwd], resources: [] });
  await assert.rejects(reserve(f.root, { token: 'b', pid: process.pid, runDir: f.root, paths: [nested], resources: [] }), /busy/);
  await release(f.root, 'a');
});
test('MCP is disabled with a valid inert transport by default and enabled servers are locked', async (t) => {
  const f = fixture(t), servers = JSON.stringify([{ name: 'blender' }, { name: 'host-tool' }]);
  const plain = await f.launch(f.args, { FAKE_SERVERS: servers }).done;
  assert.equal(plain.code, 0, plain.stderr);
  const args = f.invocations()[0].args;
  assert.ok(args.includes('mcp_servers.blender={command="__codex_handoff_disabled__",enabled=false}'));
  assert.ok(args.includes('mcp_servers.host-tool={command="__codex_handoff_disabled__",enabled=false}'));
  const hold = path.join(f.dir, 'hold');
  const first = f.launch([...f.args, '--mcp', 'blender'], { FAKE_SERVERS: servers, FAKE_HOLD: hold });
  await until(() => f.invocations().length === 2, 'MCP owner did not start');
  assert.ok(f.invocations()[1].args.includes('mcp_servers.blender.enabled=true'));
  const other = path.join(f.dir, 'other'); fs.mkdirSync(other);
  const second = await f.launch(['--brief', f.brief, '--cd', other, '--resource', 'blender'], { FAKE_SERVERS: servers }).done;
  fs.writeFileSync(hold, '');
  assert.equal(second.code, 75, second.stderr); assert.equal((await first.done).code, 0);
});
test('readiness probes cache by effective configuration and explicit model', async (t) => {
  const f = fixture(t);
  assert.equal((await f.launch(['--check', '--cd', f.cwd]).done).code, 0);
  assert.equal((await f.launch(['--check', '--cd', f.cwd]).done).code, 0);
  assert.equal(f.invocations().length, 1);
  assert.equal((await f.launch(['--check', '--cd', f.cwd, '--model', 'different-model']).done).code, 0);
  assert.equal(f.invocations().length, 2);
});
test('dirty source worktrees and known resume-directory mismatches are refused', async (t) => {
  const f = fixture(t); initRepo(f.cwd); fs.writeFileSync(path.join(f.cwd, 'uncommitted.txt'), 'user work');
  const worktree = await f.launch([...f.args, '--worktree']).done;
  assert.equal(worktree.code, 64, worktree.stderr); assert.equal(f.invocations().length, 0);
  const first = await f.launch(f.args).done; assert.equal(first.code, 0, first.stderr);
  const thread = Object.keys(loadState(f.root).threads)[0], other = path.join(f.dir, 'other'); fs.mkdirSync(other);
  const resume = await f.launch(['--brief', f.brief, '--cd', other, '--resume', thread]).done;
  assert.equal(resume.code, 64, resume.stderr); assert.equal(f.invocations().length, 1);
});
test('resume preserves sandbox choice and uses portable writable-root overrides', async (t) => {
  const f = fixture(t), extra = path.join(f.dir, 'extra writable'); fs.mkdirSync(extra);
  const resumed = await f.launch([...f.args, '--resume', 'external-thread', '--sandbox', 'workspace-write', '--add-dir', extra]).done;
  assert.equal(resumed.code, 0, resumed.stderr);
  const args = f.invocations()[0].args;
  assert.ok(args.includes('sandbox_mode="workspace-write"'));
  const config = args.find((arg) => arg.startsWith('sandbox_workspace_write.writable_roots='));
  const roots = JSON.parse(config.slice(config.indexOf('=') + 1));
  assert.ok(roots.includes(extra.replaceAll('\\', '/')));
  assert.ok(roots.every((root) => !root.includes('\\')));
});

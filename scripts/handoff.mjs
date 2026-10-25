import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { alive, atomicWrite, canonical, inside, liveReservations, loadState, release, reserve,
  safeRemove, stateFile, updateReservation, withLock, writeJson } from './state.mjs';
import { checkout, finishSnapshot, git, snapshot } from './snapshot.mjs';
import { summarize } from './summarize.mjs';
import { cleanup } from './cleanup.mjs';

const HELP = `Usage: handoff.sh --brief FILE --cd DIR [--resume THREAD] [--worktree]
  --image FILE / --add-dir DIR   repeatable references / writable roots
  --mcp NAME / --resource NAME   repeatable MCP opt-in / exclusive app lock
  --sandbox MODE                danger-full-access (default), workspace-write, read-only
  --model MODEL / --effort LEVEL / --timeout-min N / --name SLUG
  --check [--probe] / --cancel RUN_DIR / --clean THREAD [--claude-tokens N]
  --note TEXT                   director's next steps, replayed with any pending resume
  --wait                        block until a usage-limited run can resume, then print it
  --ignore-limit                explicitly retry despite remembered usage limits
Exit: 0 completed, 1 failed, 2 usage limit, 3 timeout, 4 blocked/needs review,
      64 arguments, 69 missing CLI, 70 login, 71 unavailable model, 75 busy`;
const fail = (message, exitCode = 64) => { const error = new Error(message); error.exitCode = exitCode; throw error; };
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
const winpath = (value) => {
  if (process.platform === 'win32' && /^\/[a-z](?:\/|$)/i.test(value)) return `${value[1]}:${value.slice(2) || '/'}`;
  return value;
};
export function parse(argv) {
  const o = { cd: process.cwd(), sandbox: process.env.CODEX_HANDOFF_SANDBOX || 'danger-full-access',
    model: process.env.CODEX_HANDOFF_MODEL || '', effort: process.env.CODEX_HANDOFF_EFFORT || '',
    timeoutMin: 180, image: [], addDir: [], mcp: [], resource: [] };
  const flags = { '--check': 'check', '--probe': 'probe', '--worktree': 'worktree', '--ignore-limit': 'ignoreLimit', '--wait': 'wait', '--help': 'help', '-h': 'help' };
  const values = { '--brief': 'brief', '--cd': 'cd', '--resume': 'resume', '--image': 'image', '--add-dir': 'addDir',
    '--sandbox': 'sandbox', '--model': 'model', '--effort': 'effort', '--timeout-min': 'timeoutMin', '--name': 'name',
    '--cancel': 'cancel', '--clean': 'clean', '--claude-tokens': 'claudeTokens', '--mcp': 'mcp', '--resource': 'resource', '--note': 'note' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flags[arg]) o[flags[arg]] = true;
    else if (values[arg]) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) fail(`Missing value for ${arg}`);
      const key = values[arg];
      if (Array.isArray(o[key])) o[key].push(value); else o[key] = value;
    } else fail(`Unknown argument: ${arg}`);
  }
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(o.sandbox)) fail('Invalid sandbox mode');
  o.timeoutMin = Number(o.timeoutMin);
  if (!Number.isFinite(o.timeoutMin) || o.timeoutMin <= 0 || o.timeoutMin > 1440) fail('--timeout-min must be > 0 and <= 1440');
  if (o.claudeTokens !== undefined && (!Number.isFinite(Number(o.claudeTokens)) || Number(o.claudeTokens) < 0)) fail('Invalid --claude-tokens');
  if ([o.check, o.cancel, o.clean, o.brief, o.wait].filter(Boolean).length > 1) fail('Choose one of --brief, --check, --cancel, --clean, --wait');
  if (o.note && o.note.length > 1500) fail('--note must be at most 1500 characters; point to a file for more');
  if (o.worktree && o.resume) fail('Resume with --cd pointing to the original worktree');
  for (const key of ['cd', 'brief', 'cancel']) if (o[key]) o[key] = path.resolve(winpath(o[key]));
  for (const key of ['image', 'addDir']) o[key] = o[key].map((p) => path.resolve(winpath(p)));
  for (const name of [...o.mcp, ...o.resource]) if (!/^[A-Za-z0-9_.:-]+$/.test(name)) fail(`Invalid resource/server name: ${name}`);
  return o;
}
function cliCommand(args) {
  const explicit = process.env.CODEX_HANDOFF_CLI;
  if (explicit) return /\.m?js$/i.test(explicit) ? [process.execPath, [explicit, ...args]] : [explicit, args];
  if (process.platform === 'win32') {
    if (!process.env.CODEX_HANDOFF_BASH) fail('On Windows launch handoff.sh from Git Bash', 69);
    // Arguments are positional data, never interpolated shell code.
    return [process.env.CODEX_HANDOFF_BASH, ['-c', 'exec codex "$@"', 'handoff-codex', ...args]];
  }
  return ['codex', args];
}
function cliSync(args, cwd) {
  const [command, argv] = cliCommand(args);
  return spawnSync(command, argv, { cwd, encoding: 'utf8', timeout: 30000, windowsHide: true });
}
function configFiles(cwd) {
  const files = [path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml')];
  const parents = [];
  for (let dir = cwd;; dir = path.dirname(dir)) { parents.push(dir); if (dir === path.dirname(dir)) break; }
  files.push(...parents.reverse().map((dir) => path.join(dir, '.codex', 'config.toml')));
  return [...new Set(files)].filter((file) => fs.existsSync(file));
}
export function configInfo(cwd, model, effort) {
  const files = configFiles(cwd), text = files.map((file) => fs.readFileSync(file, 'utf8')), servers = new Set();
  for (const content of text) for (const match of content.matchAll(/^\s*\[mcp_servers\.(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z0-9_-]+))\]\s*(?:#.*)?$/gm)) servers.add(match[1] || match[2] || match[3]);
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return { servers: [...servers], accountKey: hash(path.resolve(home)), configKey: hash(JSON.stringify([files, text, model, effort,
    process.env.CODEX_HANDOFF_CLI || 'codex', process.env.CODEX_HANDOFF_FALLBACK_MODELS || ''])) };
}
async function checkLimit(root, key, ignore) {
  if (ignore) return;
  await withLock(root, () => {
    const limit = loadState(root).limits[key], legacy = path.join(root, '.usage-limit');
    const until = fs.existsSync(legacy) ? Number(fs.readFileSync(legacy, 'utf8').match(/^until=(\d+)/m)?.[1]) : 0;
    const reset = Math.max(limit?.until || 0, until || 0);
    if (reset * 1000 > Date.now()) fail(`Codex usage limit until ${new Date(reset * 1000).toISOString()}; use Claude or wait. --ignore-limit retries explicitly.`, 2);
  });
}
function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    if (result.status !== 0 && alive(child.pid)) throw new Error(`Could not stop child ${child.pid}: ${result.stderr}`);
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
async function execute(root, runDir, token, args, cwd, timeoutMin) {
  const [command, argv] = cliCommand(args);
  const events = fs.openSync(path.join(runDir, 'events.jsonl'), 'w'), stderr = fs.openSync(path.join(runDir, 'stderr.log'), 'w');
  let child, timer, poll, reason = '', spawnError;
  const stop = (why) => { if (!reason) reason = why; try { killTree(child); } catch (error) { console.error(error.message); } };
  const interrupt = () => stop('cancelled');
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    child = spawn(command, argv, { cwd, stdio: ['ignore', events, stderr], windowsHide: true, detached: process.platform !== 'win32' });
    child.on('error', (error) => { spawnError = error; });
    const closed = new Promise((resolve) => child.on('close', (code) => resolve(code ?? 1)));
    await updateReservation(root, token, { childPid: child.pid });
    timer = setTimeout(() => stop('timeout'), timeoutMin * 60000);
    poll = setInterval(() => { if (fs.existsSync(path.join(runDir, 'cancel.json'))) stop('cancelled'); }, 200);
    const code = await closed;
    if (spawnError) fs.appendFileSync(path.join(runDir, 'stderr.log'), `${spawnError.message}\n`);
    return { code: reason === 'timeout' ? 124 : reason === 'cancelled' ? 130 : code, reason };
  } finally {
    clearTimeout(timer); clearInterval(poll);
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    fs.closeSync(events); fs.closeSync(stderr);
    await updateReservation(root, token, { childPid: null });
  }
}
function modelMissing(dir) {
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return {}; }
  });
  // Never replay a completed task or one that has begun tools/mutations.
  if (events.some((event) => event.type === 'turn.completed' ||
    ['command_execution', 'file_change', 'mcp_tool_call'].includes(event.item?.type))) return false;
  const diagnostics = events.filter((event) => ['error', 'turn.failed'].includes(event.type))
    .map((event) => event.message || event.error?.message || '').join('\n');
  return /model_not_found|model is not supported|model .{0,60}does not exist|access to (the )?model/i.test(
    diagnostics + '\n' + fs.readFileSync(path.join(dir, 'stderr.log'), 'utf8'));
}
async function withFallback(root, runDir, token, args, cwd, options, info) {
  let cached;
  await withLock(root, () => { cached = loadState(root).models[info.configKey]; });
  let model = options.model || (cached?.at > Date.now() - 86400000 ? cached.model : '');
  const tried = new Set();
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const file of ['final.md', 'result.json']) fs.rmSync(path.join(runDir, file), { force: true });
    const result = await execute(root, runDir, token, [...args, ...(model ? ['-m', model] : [])], cwd, options.timeoutMin);
    atomicWrite(path.join(runDir, 'model.txt'), model || 'Codex config');
    if (!modelMissing(runDir) || result.reason) {
      if (model && result.code === 0) await withLock(root, () => {
        const state = loadState(root); state.models[info.configKey] = { model, at: Date.now() }; writeJson(stateFile(root), state);
      });
      return result;
    }
    for (const file of ['events.jsonl', 'stderr.log']) fs.copyFileSync(path.join(runDir, file), path.join(runDir, `attempt-${attempt + 1}-${file}`));
    tried.add(model);
    let candidates = process.env.CODEX_HANDOFF_FALLBACK_MODELS ? process.env.CODEX_HANDOFF_FALLBACK_MODELS.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    if (!candidates) {
      const catalog = cliSync(['debug', 'models']);
      try { candidates = JSON.parse(catalog.stdout).models.filter((m) => m.visibility === 'list').sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)).map((m) => m.slug); }
      catch { candidates = []; }
    }
    const next = candidates.find((m) => !tried.has(m));
    if (!next || attempt === 3) return result;
    fs.appendFileSync(path.join(runDir, 'fallback.txt'), `Model ${model || 'configured default'} unavailable; retrying ${next}\n`);
    model = next;
  }
}
function pendingResumes(state) {
  return Object.values(state.pending || {}).filter((entry) => fs.existsSync(entry.runDir))
    .map((entry) => ({ ...entry, until: Math.max(entry.until || 0, state.limits[entry.account]?.until || 0) }));
}
const describePending = (entry) => [`== ${entry.thread ? `thread ${entry.thread}` : 'unstarted run'} (${path.basename(entry.project)})`,
  `goal: ${entry.goal || '(see brief)'}`, ...(entry.note ? [`next: ${entry.note}`] : []), `paused run: ${entry.runDir}`, `resume: ${entry.command}`].join('\n');
// Holds no reservation, so other handoffs run normally while a timer waits.
async function waitForReset(root) {
  for (;;) {
    let entries;
    await withLock(root, () => { entries = pendingResumes(loadState(root)); });
    if (!entries.length) fail('No pending resumes are recorded', 1);
    const ready = entries.filter((entry) => entry.until * 1000 <= Date.now());
    if (ready.length) {
      console.log(['handoff: Codex usage limit has reset. This resume context survives /clear.',
        'Authorized: run each command unchanged; it repeats its original brief and scope. Anything new or outward still needs the user.',
        ...ready.map(describePending)].join('\n'));
      return 0;
    }
    await sleep(Math.min(60000, Math.max(1000, Math.min(...entries.map((entry) => entry.until * 1000)) - Date.now() + 1000)));
  }
}
async function cancel(root, dir) {
  await withLock(root, () => {
    if (!inside(root, dir)) fail('--cancel must name a run directory under the handoff home');
    const reservation = liveReservations(loadState(root)).find((r) => path.resolve(r.runDir) === dir);
    if (!reservation) fail('No active handoff owns that run directory', 75);
    if (!alive(reservation.pid)) fail('Supervisor exited but its child may still run; inspect the recorded child PID before stopping it manually', 75);
    writeJson(path.join(dir, 'cancel.json'), { requested: Date.now() });
    console.log(`handoff: cancellation requested for ${dir}`);
  });
}
export async function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (options.help) { console.log(HELP); return 0; }
  const root = path.resolve(winpath(process.env.CODEX_HANDOFF_HOME || path.join(os.homedir(), '.claude', 'codex-handoffs')));
  if (options.cancel) { await cancel(root, options.cancel); return 0; }
  if (options.clean) return cleanup(root, '--thread', options.clean, options.claudeTokens);
  if (options.wait) return waitForReset(root);
  if (options.check) await withLock(root, () => {
    const entries = pendingResumes(loadState(root));
    if (entries.length) console.log(`handoff: ${entries.length} pending resume(s):\n${entries.map((entry) =>
      `${describePending(entry)}\nready: ${entry.until * 1000 <= Date.now() ? 'now' : new Date(entry.until * 1000).toISOString()}`).join('\n')}`);
  });
  if (!options.check && !options.brief) fail(HELP);
  if (!fs.existsSync(options.cd) || !fs.statSync(options.cd).isDirectory()) fail('--cd directory does not exist');
  if (!options.check && (!fs.existsSync(options.brief) || !fs.statSync(options.brief).isFile())) fail('Brief file does not exist');
  for (const image of options.image) if (!fs.existsSync(image) || !fs.statSync(image).isFile()) fail(`Image does not exist: ${image}`);
  for (const dir of options.addDir) if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(`Writable directory does not exist: ${dir}`);
  const version = cliSync(['--version']);
  if (version.error || version.status !== 0) fail('Codex CLI unavailable; install @openai/codex and put it on PATH', 69);
  if (cliSync(['login', 'status']).status !== 0) fail('Codex is not logged in; run codex login', 70);
  let cwd = canonical(checkout(options.cd) || options.cd);
  if (path.resolve(root) === path.resolve(cwd) || inside(cwd, root)) fail('CODEX_HANDOFF_HOME must be outside the working checkout to keep snapshots and scratch separate');
  const info = configInfo(cwd, options.model, options.effort);
  // Ask Codex for its effective server inventory: inline TOML, inherited config,
  // and disabled entries must not silently escape opt-in and resource locking.
  const inventory = cliSync(['mcp', 'list', '--json'], cwd);
  try {
    if (inventory.status !== 0) throw new Error('inventory command failed');
    const servers = JSON.parse(inventory.stdout);
    if (!Array.isArray(servers) || servers.some((server) => typeof server.name !== 'string')) throw new Error('invalid inventory');
    info.servers = servers.map((server) => server.name);
    if (info.servers.some((name) => !/^[A-Za-z0-9_-]+$/.test(name))) fail('MCP names must use letters, digits, underscores, or hyphens for CLI overrides');
  } catch { fail('Cannot discover effective MCP servers with codex mcp list --json; check the Codex configuration', 69); }
  info.configKey = hash(info.configKey + version.stdout.trim());
  await checkLimit(root, info.accountKey, options.ignoreLimit);
  if (options.resume) await withLock(root, () => {
    const saved = loadState(root).threads?.[options.resume];
    if (saved && saved.cwd !== cwd) fail(`Resume must use its original working directory: ${saved.cwd}`);
  });
  for (const name of options.mcp) if (!info.servers.includes(name)) fail(`MCP server ${name} not found in Codex configs; configure it once before launch`);
  const common = checkout(cwd) ? canonical(path.resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']))) : cwd;
  const projectName = `${path.basename(common.endsWith(`${path.sep}.git`) ? path.dirname(common) : common)}-${hash(common)}`;
  const project = path.join(root, projectName);
  await cleanup(root, '--prune', '3');
  fs.mkdirSync(project, { recursive: true });
  if (options.check && !options.probe) {
    let cached;
    await withLock(root, () => { cached = loadState(root).probes[info.configKey]; });
    if (cached?.at > Date.now() - 43200000) { console.log(`handoff: Codex ready (${version.stdout.trim()}, cached model probe)`); return 0; }
  }
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const name = (options.name || (options.check ? 'probe' : path.parse(options.brief).name)).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48);
  const runDir = fs.mkdtempSync(path.join(project, `${timestamp}-${name}-`)), token = crypto.randomUUID();
  let claimed = false, before;
  try {
    if (options.worktree) {
      if (!checkout(cwd)) fail('--worktree requires a Git repository');
      const worktree = path.join(project, 'worktrees', path.basename(runDir));
      await withLock(root, () => {
        if (liveReservations(loadState(root)).some((run) => run.paths.some((dir) => dir === cwd || inside(dir, cwd) || inside(cwd, dir)))) fail('Source checkout is active; wait before creating a worktree', 75);
        if (git(cwd, ['status', '--porcelain', '--untracked-files=normal'])) fail('--worktree starts from HEAD and requires a clean source checkout; use a prepared worktree with --cd for uncommitted inputs');
        git(cwd, ['worktree', 'add', '--detach', worktree, 'HEAD']);
      });
      cwd = canonical(worktree);
    }
    const resources = [...new Set([...options.resource, ...options.mcp].map((name) => `app:${name.toLowerCase()}`).concat(options.resume ? [`thread:${options.resume}`] : [], options.check ? [`probe:${info.configKey}`] : []))];
    const paths = options.check ? [] : [cwd, ...options.addDir.map(canonical)];
    await reserve(root, { token, pid: process.pid, childPid: null, runDir, paths, resources, thread: options.resume || null });
    claimed = true;
    writeJson(path.join(runDir, 'invocation.json'), { root, project, cwd, ...info, sandbox: options.check ? 'read-only' : options.sandbox, probe: !!options.check, resume: options.resume || null, mcp: options.mcp,
      // Everything resumeCommand needs to rebuild this launch.
      brief: options.brief, resource: options.resource, addDir: options.addDir, image: options.image, model: options.model,
      effort: options.effort, timeoutMin: options.timeoutMin, name: options.name, note: options.note });
    if (!options.check) {
      fs.copyFileSync(options.brief, path.join(runDir, 'brief.md'));
      if (checkout(cwd)) { before = snapshot(cwd, runDir, 'before'); atomicWrite(path.join(runDir, 'base.txt'), before); }
    }
    const legacyProject = path.basename(common.endsWith(`${path.sep}.git`) ? path.dirname(common) : common);
    const lessons = path.join(project, 'LESSONS.md'), legacyLessons = path.join(root, legacyProject, 'LESSONS.md');
    const lessonsFile = fs.existsSync(lessons) ? lessons : legacyLessons;
    const prompt = options.check ? 'Reply with exactly the two letters "OK", without punctuation. Do not use tools.' :
      `Read ${path.join(runDir, 'brief.md')} and carry out the brief. Follow project AGENTS.md.${fs.existsSync(lessonsFile) ? ` Read standing lessons at ${lessonsFile}.` : ''} ` +
      `The working directory is ${cwd}. Keep scratch and review media in ${runDir}. ` +
      `Finish with a report under 250 words and write ${path.join(runDir, 'result.json')} as JSON: ` +
      '{"status":"completed|blocked|failed","verification":"checks run and results","reason":"remaining work or empty"}. ' +
      'Use completed only when every requirement and required verification is satisfied. A tool/sandbox failure that prevents finishing means blocked. Do not change setup, permissions, or sandbox to get around a failure.';
    const configs = ['-c', 'approval_policy="never"'];
    for (const server of info.servers) {
      const enabled = !options.check && options.mcp.includes(server);
      if (enabled) configs.push('-c', `mcp_servers.${server}.enabled=true`, '-c', `mcp_servers.${server}.default_tools_approval_mode="approve"`);
      // Replace the entire disabled table with a valid inert transport. Some
      // inventory entries are injected by the host rather than config.toml;
      // overriding only enabled would create an invalid transport for those.
      else configs.push('-c', `mcp_servers.${server}={command="__codex_handoff_disabled__",enabled=false}`);
    }
    if (options.effort) configs.push('-c', `model_reasoning_effort=${JSON.stringify(options.effort)}`);
    const writable = [runDir, ...options.addDir];
    // Forward slashes avoid JSON/TOML backslash escape drift through Windows shims.
    const configRoots = writable.map((dir) => dir.replaceAll('\\', '/'));
    const args = options.resume ? ['exec', 'resume', options.resume, prompt, '-c', `sandbox_mode=${JSON.stringify(options.sandbox)}`, '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(configRoots)}`] :
      ['exec', prompt, '-C', cwd, '-s', options.check ? 'read-only' : options.sandbox, ...writable.flatMap((dir) => ['--add-dir', dir])];
    args.push(...configs, '--skip-git-repo-check', '--json', '-o', path.join(runDir, 'final.md'));
    for (const image of options.image) args.push(`--image=${image}`);
    const start = Math.floor(Date.now() / 1000);
    console.log(`handoff: started\nrun dir: ${runDir}\nworking directory: ${cwd}`);
    const outcome = await withFallback(root, runDir, token, args, cwd, { ...options, timeoutMin: options.check ? 3 : options.timeoutMin }, info);
    if (before) {
      try { finishSnapshot(cwd, runDir, before); }
      catch (error) { atomicWrite(path.join(runDir, 'snapshot-error.txt'), error.message); }
    }
    const report = await summarize(runDir, outcome.code, start, Math.floor(Date.now() / 1000), cwd);
    console.log(report.text);
    if (options.check && report.exit === 0) await withLock(root, () => {
      const state = loadState(root); state.probes[info.configKey] = { at: Date.now() }; writeJson(stateFile(root), state);
    });
    if (report.exit === 0) for (const file of ['events.jsonl', 'stderr.log']) fs.rmSync(path.join(runDir, file), { force: true });
    await withLock(root, () => atomicWrite(path.join(project, 'LAST_RUN'), `${runDir}\n`));
    return report.exit;
  } finally {
    if (claimed) await release(root, token);
    if (!claimed && !options.worktree) safeRemove(project, runDir);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(`handoff: ${error.message}`); process.exitCode = error.exitCode || 1; });
}

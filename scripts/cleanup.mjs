import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendTable, atomicWrite, inside, liveReservations, loadState, readJson, safeRemove, stateFile, withLock, writeJson } from './state.mjs';

const jsonlFiles = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true, recursive: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => path.join(entry.parentPath || entry.path, entry.name)) : [];
// Claude usage from the director sessions' transcripts (and their subagents) since the task's first run.
// Everything those sessions did in the window counts, including unrelated work.
export function claudeUsage(sessions, since) {
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const totals = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, messages: 0 }, seen = new Set();
  for (const project of subdirs(projects)) for (const id of sessions) {
    for (const file of [path.join(project, `${id}.jsonl`), ...jsonlFiles(path.join(project, id))].filter((f) => fs.existsSync(f))) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('"usage"')) continue;
        let entry; try { entry = JSON.parse(line); } catch { continue; }
        const usage = entry.message?.usage, key = entry.message?.id || entry.requestId;
        if (entry.type !== 'assistant' || !usage || !key || seen.has(key) || Date.parse(entry.timestamp) < since) continue;
        seen.add(key); totals.messages++;
        totals.input += usage.input_tokens || 0; totals.cacheWrite += usage.cache_creation_input_tokens || 0;
        totals.cacheRead += usage.cache_read_input_tokens || 0; totals.output += usage.output_tokens || 0;
      }
    }
  }
  return totals;
}
const subdirs = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name)) : [];
export async function cleanup(root, mode, arg, claudeTokens) {
  if (!((mode === '--thread' && /^[A-Za-z0-9-]+$/.test(arg || '')) || (mode === '--prune' && Number(arg) > 0))) {
    const error = new Error('cleanup: use --thread ID or --prune DAYS'); error.exitCode = 64; throw error;
  }
  return withLock(root, () => {
    const active = liveReservations(loadState(root));
    // Refuse thread cleanup while any resume is active, even before it has meta.json.
    if (mode === '--thread' && active.some((run) => run.thread === arg || readJson(path.join(run.runDir, 'meta.json'))?.threadId === arg)) {
      const error = new Error(`Thread ${arg} is active; cancel or wait before cleaning`); error.exitCode = 75; throw error;
    }
    if (mode === '--thread') {
      const state = loadState(root);
      if (state.pending?.[arg]) { delete state.pending[arg]; writeJson(stateFile(root), state); }
    }
    const runs = subdirs(root).flatMap((project) => subdirs(project)
      .filter((dir) => /^\d{8}-\d{6}-/.test(path.basename(dir)))
      .map((dir) => ({ dir, project, meta: readJson(path.join(dir, 'meta.json')), mtime: fs.statSync(dir).mtimeMs })));
    const cutoff = Date.now() - Number(arg) * 86400000;
    const targets = runs.filter((run) => run.meta && !active.some((r) => r.runDir === run.dir) &&
      (mode === '--thread' ? run.meta.threadId === arg : run.mtime < cutoff));
    const ids = new Set(targets.map((run) => run.meta.threadId).filter((id) => /^[A-Za-z0-9-]+$/.test(id || '')));
    if (claudeTokens !== undefined && (!Number.isFinite(Number(claudeTokens)) || Number(claudeTokens) < 0)) throw new Error('Invalid Claude token count');
    if (mode === '--thread') for (const project of new Set(targets.map((run) => run.project))) {
      const subset = targets.filter((run) => run.project === project), sum = (key) => subset.reduce((n, run) => n + (run.meta.usage?.[key] || 0), 0);
      const invocations = subset.map((run) => readJson(path.join(run.dir, 'invocation.json'), {}));
      const since = Math.min(...invocations.map((inv) => inv.startedAt || Infinity));
      const sessions = new Set([...invocations.map((inv) => inv.claudeSession), process.env.CLAUDE_CODE_SESSION_ID].filter(Boolean));
      const claude = Number.isFinite(since) && sessions.size ? claudeUsage(sessions, since) : null;
      const file = path.join(project, 'usage.tsv');
      // A retry after a partial cleanup does not double-count the same task.
      const recorded = fs.existsSync(file) && fs.readFileSync(file, 'utf8').split('\n').some((line) => line.split('\t')[1] === arg);
      if (!recorded) appendTable(file, 'date\tthread\truns\tcodex_input\tcodex_cached\tcodex_output\tclaude_input\tclaude_cache_write\tclaude_cache_read\tclaude_output\tclaude_messages\tclaude_manual\tfirst_run',
        [new Date().toISOString(), arg, subset.length, sum('input_tokens'), sum('cached_input_tokens'), sum('output_tokens'),
          ...(claude ? [claude.input, claude.cacheWrite, claude.cacheRead, claude.output, claude.messages] : ['', '', '', '', '']),
          claudeTokens ?? '', path.basename(subset[0].dir)].join('\t'));
      console.log(`handoff usage: codex ${sum('input_tokens')} in (${sum('cached_input_tokens')} cached), ${sum('output_tokens')} out; ` + (claude
        ? `claude ${claude.input} in, ${claude.cacheWrite} cache write, ${claude.cacheRead} cache read, ${claude.output} out over ${claude.messages} message(s) since ${new Date(since).toISOString()} (all director activity in that window)`
        : 'claude not measured (no recorded session)'));
    }
    // Cleanup never removes Git worktrees. Their results need explicit integration
    // and `git worktree remove` by the director after review.
    for (const run of targets) {
      safeRemove(root, run.dir);
      const last = path.join(run.project, 'LAST_RUN');
      if (fs.existsSync(last) && path.resolve(fs.readFileSync(last, 'utf8').trim()) === path.resolve(run.dir)) atomicWrite(last, '');
    }
    const imageRoot = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'generated_images');
    let removedImages = 0;
    for (const id of ids) {
      if (active.some((run) => run.thread === id)) continue;
      if (runs.some((run) => run.meta?.threadId === id && !targets.includes(run))) continue;
      // Unknown in-flight first turns have no thread ID yet; preserve images.
      if (active.some((run) => !run.thread)) continue;
      const dir = path.join(imageRoot, id);
      if (fs.existsSync(dir) && inside(imageRoot, dir)) { safeRemove(imageRoot, dir); removedImages++; }
    }
    if (targets.length || removedImages || mode === '--thread') console.log(`handoff cleanup: removed ${targets.length} run dir(s), ${removedImages} image-original folder(s); worktrees retained`);
    return 0;
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, mode, arg, flag, value] = process.argv.slice(2);
  cleanup(path.resolve(root), mode, arg, flag === '--claude-tokens' ? value : undefined).then((code) => { process.exitCode = code; })
    .catch((error) => { console.error(error.message); process.exitCode = error.exitCode || 1; });
}

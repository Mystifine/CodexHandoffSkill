import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendTable, atomicWrite, inside, liveReservations, loadState, readJson, safeRemove, withLock } from './state.mjs';

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
    const runs = subdirs(root).flatMap((project) => subdirs(project)
      .filter((dir) => /^\d{8}-\d{6}-/.test(path.basename(dir)))
      .map((dir) => ({ dir, project, meta: readJson(path.join(dir, 'meta.json')), mtime: fs.statSync(dir).mtimeMs })));
    const cutoff = Date.now() - Number(arg) * 86400000;
    const targets = runs.filter((run) => run.meta && !active.some((r) => r.runDir === run.dir) &&
      (mode === '--thread' ? run.meta.threadId === arg : run.mtime < cutoff));
    const ids = new Set(targets.map((run) => run.meta.threadId).filter((id) => /^[A-Za-z0-9-]+$/.test(id || '')));
    if (claudeTokens !== undefined && targets.length) {
      const count = Number(claudeTokens);
      if (!Number.isFinite(count) || count < 0) throw new Error('Invalid Claude token count');
      for (const project of new Set(targets.map((run) => run.project))) {
        const subset = targets.filter((run) => run.project === project), sum = (key) => subset.reduce((n, run) => n + (run.meta.usage?.[key] || 0), 0);
        const file = path.join(project, 'tasks.tsv');
        // A retry after a partial cleanup does not double-count the same task.
        const recorded = fs.existsSync(file) && fs.readFileSync(file, 'utf8').split('\n').some((line) => line.split('\t')[1] === arg);
        if (!recorded) appendTable(file, 'date\tthread\truns\tcodex_input\tcodex_cached\tcodex_output\tclaude_tokens\tfirst_run',
          [new Date().toISOString(), arg, subset.length, sum('input_tokens'), sum('cached_input_tokens'), sum('output_tokens'), count, path.basename(subset[0].dir)].join('\t'));
      }
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

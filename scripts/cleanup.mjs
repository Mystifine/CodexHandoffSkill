// Remove handoff intermediates: run directories and Codex's generated-image originals.
// Keeps each project's templates/, LESSONS.md and ledger.tsv.
// Usage: node cleanup.mjs <root> --thread <id> [--claude-tokens N]   every run of one finished task;
//        with --claude-tokens, first append the task's Claude vs Codex tokens to <project>/tasks.tsv
//        node cleanup.mjs <root> --prune <days>   runs older than <days> (safety net)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [root, mode, arg, flag, flagValue] = process.argv.slice(2);
const RUN_DIR = /^\d{8}-\d{6}-/;
const imagesRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'generated_images');

const subdirs = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
};
const runs = subdirs(root).flatMap((project) =>
  subdirs(project)
    .filter((dir) => RUN_DIR.test(path.basename(dir)))
    .map((dir) => {
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      } catch {}
      return { dir, project, meta, mtime: fs.statSync(dir).mtimeMs };
    }),
);

const sizeOf = (p) => {
  try {
    const st = fs.statSync(p);
    return st.isDirectory() ? fs.readdirSync(p).reduce((n, f) => n + sizeOf(path.join(p, f)), 0) : st.size;
  } catch {
    return 0;
  }
};
let freed = 0;
const remove = (p) => {
  if (!fs.existsSync(p)) return false;
  freed += sizeOf(p);
  fs.rmSync(p, { recursive: true, force: true });
  return true;
};

let targets;
let imageThreads;
if (mode === '--thread' && /^[A-Za-z0-9-]+$/.test(arg ?? '')) {
  targets = runs.filter((r) => r.meta.threadId === arg);
  imageThreads = [arg];
} else if (mode === '--prune' && Number(arg) > 0) {
  const cutoff = Date.now() - Number(arg) * 86400e3;
  targets = runs.filter((r) => r.mtime < cutoff);
  // A thread's images go only when no newer run (e.g. a resume) still uses them.
  const live = new Set(runs.filter((r) => r.mtime >= cutoff).map((r) => r.meta.threadId));
  imageThreads = [...new Set(targets.map((r) => r.meta.threadId))].filter((t) => t && !live.has(t));
} else {
  console.error('cleanup: usage: cleanup.mjs <root> --thread <id> | --prune <days>');
  process.exit(64);
}

if (mode === '--thread' && flag === '--claude-tokens' && targets.length) {
  const claude = Number(flagValue);
  if (!Number.isFinite(claude) || claude < 0) {
    console.error('cleanup: --claude-tokens needs a non-negative number');
    process.exit(64);
  }
  const sum = (k) => targets.reduce((n, r) => n + (r.meta.usage?.[k] ?? 0), 0);
  const project = targets[0].project;
  const file = path.join(project, 'tasks.tsv');
  if (!fs.existsSync(file)) fs.writeFileSync(file, 'date\tthread\truns\tcodex_input\tcodex_cached\tcodex_output\tclaude_tokens\tfirst_run\n');
  const first = targets.map((r) => path.basename(r.dir)).sort()[0];
  fs.appendFileSync(file, [new Date().toISOString(), arg, targets.length, sum('input_tokens'), sum('cached_input_tokens'), sum('output_tokens'), claude, first].join('\t') + '\n');
  console.log(`handoff: logged task ${arg}: Claude ${claude} tokens, Codex ${sum('input_tokens')} in / ${sum('output_tokens')} out (${path.basename(project)}/tasks.tsv)`);
}

let dirs = 0;
for (const r of targets) {
  if (remove(r.dir)) dirs++;
  const last = path.join(r.project, 'LAST_RUN');
  try {
    if (path.resolve(fs.readFileSync(last, 'utf8').trim()) === path.resolve(r.dir)) fs.rmSync(last);
  } catch {}
}
const images = imageThreads.filter((t) => remove(path.join(imagesRoot, t))).length;

if (dirs || images || mode === '--thread') {
  console.log(`handoff cleanup: removed ${dirs} run dir(s), ${images} image-original folder(s), ${(freed / 1048576).toFixed(1)} MB`);
}

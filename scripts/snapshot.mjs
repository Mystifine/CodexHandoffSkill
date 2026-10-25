// Git's temporary index captures tracked AND pre-existing untracked content without
// changing the user's index, worktree, refs, or stash. Ignored files stay excluded.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function git(cwd, args, extraEnv = {}, trim = true) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', env: { ...process.env, ...extraEnv }, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr.trim() || `git ${args[0]} failed`);
  return trim ? result.stdout.trimEnd() : result.stdout;
}
export function checkout(cwd) {
  try { return git(cwd, ['rev-parse', '--show-toplevel']); }
  catch { return null; }
}
export function snapshot(cwd, runDir, label) {
  const index = path.join(runDir, `.index-${label}`);
  const env = { GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '0' };
  try {
    git(cwd, ['read-tree', '--empty'], env);
    git(cwd, ['add', '-A', '--', '.'], env);
    return git(cwd, ['write-tree'], env);
  } finally {
    fs.rmSync(index, { force: true });
    fs.rmSync(`${index}.lock`, { force: true });
  }
}
export function finishSnapshot(cwd, runDir, before) {
  const after = snapshot(cwd, runDir, 'after');
  fs.writeFileSync(path.join(runDir, 'changes.patch'), git(cwd, ['diff', '--binary', '--no-ext-diff', before, after], {}, false));
  fs.writeFileSync(path.join(runDir, 'git-changes.txt'), git(cwd, ['diff', '--stat=160', '--no-ext-diff', before, after]) + '\n');
  fs.writeFileSync(path.join(runDir, 'trees.json'), JSON.stringify({ before, after }));
}

// Condense a `codex exec --json` event log into a short report, so Claude never has to read the raw log.
// Usage: node summarize.mjs <runDir> <codexExitCode> <startEpoch> <endEpoch> <cwd>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [runDir, rawCode, rawStart, rawEnd, cwd = ''] = process.argv.slice(2);
const codexExit = Number(rawCode);
const start = Number(rawStart);
const end = Number(rawEnd);
const FINAL_LIMIT = 6000;

const read = (name) => {
  try {
    return fs.readFileSync(path.join(runDir, name), 'utf8');
  } catch {
    return '';
  }
};

let threadId = null;
let turnFailed = null;
const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
const errors = [];
const files = new Map();
const mcpCalls = new Map();
let commands = 0;
let nonZero = 0;

for (const line of read('events.jsonl').split('\n')) {
  if (!line.trim()) continue;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    continue;
  }
  if (ev.type === 'thread.started') threadId = ev.thread_id;
  else if (ev.type === 'turn.completed') {
    for (const k of Object.keys(usage)) usage[k] += ev.usage?.[k] ?? 0;
  } else if (ev.type === 'turn.failed') turnFailed = ev.error?.message ?? 'turn failed';
  else if (ev.type === 'error') errors.push(ev.message);
  else if (ev.type === 'item.completed') {
    const it = ev.item ?? {};
    if (it.type === 'command_execution') {
      commands++;
      if (it.exit_code != null && it.exit_code !== 0) nonZero++;
    } else if (it.type === 'file_change' && it.status !== 'failed') {
      for (const c of it.changes ?? []) files.set(c.path, c.kind);
    } else if (it.type === 'mcp_tool_call') {
      const key = `${it.server}.${it.tool}${it.status === 'failed' ? ' (failed)' : ''}`;
      mcpCalls.set(key, (mcpCalls.get(key) ?? 0) + 1);
    } else if (it.type === 'error') errors.push(it.message);
  }
}

// Image generation writes to $CODEX_HOME/generated_images/<thread id>/; list what this run produced.
const images = [];
if (threadId) {
  const dir = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'generated_images', threadId);
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).mtimeMs / 1000 >= start - 5) images.push(p);
    }
  } catch {}
}

const finalText = read('final.md').trim();
const allErrors = [turnFailed, ...errors].filter(Boolean);
const limitHit = allErrors.find((m) => /usage limit|rate limit|quota/i.test(m));
const modelHit = allErrors.find((m) => /model_not_found|model is not supported|model .{0,60}does not exist|access to (the )?model/i.test(m));
const modelUsed = read('model.txt').trim();
const fallbackNotes = read('fallback.txt').trim();

let status;
let exit;
if (codexExit === 124 || codexExit === 137) [status, exit] = ['TIMED OUT', 3];
else if (limitHit) [status, exit] = ['CODEX USAGE LIMIT', 2];
else if (modelHit) [status, exit] = ['NO USABLE MODEL', 71];
else if (codexExit === 0 && !turnFailed && finalText) [status, exit] = ['COMPLETED', 0];
else [status, exit] = ['FAILED', 1];

// Remember a usage limit so the next launch fails in its preflight instead of after a brief.
const limitFile = path.join(path.dirname(path.dirname(runDir)), '.usage-limit');
let limitUntil = null;
if (limitHit) {
  const units = { second: 1, minute: 60, hour: 3600, day: 86400 };
  let wait = 0;
  for (const [, n, unit] of limitHit.matchAll(/(\d+)\s*(second|minute|hour|day)s?/gi)) wait += Number(n) * units[unit.toLowerCase()];
  const at = limitHit.match(/(?:try again|resets?)\s+(?:at|on)\s+([^.;]+)/i);
  const parsed = at ? Date.parse(at[1]) : NaN;
  // Unknown reset time: block for 30 minutes, then let the next launch try again.
  limitUntil = wait > 0 ? end + wait : !Number.isNaN(parsed) && parsed / 1000 > end ? Math.round(parsed / 1000) : end + 1800;
  fs.writeFileSync(limitFile, `until=${limitUntil}\nmessage=${limitHit.replace(/\s+/g, ' ').slice(0, 300)}\n`);
} else if (status === 'COMPLETED') {
  fs.rmSync(limitFile, { force: true });
}

const rel = (p) => {
  const norm = p.replace(/\\/g, '/');
  const base = cwd.replace(/\\/g, '/').replace(/\/$/, '') + '/';
  return cwd && norm.toLowerCase().startsWith(base.toLowerCase()) ? norm.slice(base.length) : norm;
};
const fmtK = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);
const secs = Math.max(0, end - start);

const out = [];
out.push(`Codex handoff: ${status} (codex exit ${codexExit}) in ${Math.floor(secs / 60)}m${secs % 60}s`);
if (threadId) out.push(`thread: ${threadId}   (follow-up: --resume ${threadId})`);
out.push(`run dir: ${runDir}`);
if (modelUsed) out.push(`model: ${modelUsed}${fallbackNotes ? ' (fallback)' : ''}`);
if (fallbackNotes) out.push(...fallbackNotes.split('\n'));
if (usage.input_tokens || usage.output_tokens) {
  out.push(`codex tokens: ${fmtK(usage.input_tokens)} in (${fmtK(usage.cached_input_tokens)} cached), ${fmtK(usage.output_tokens)} out`);
}
if (commands) out.push(`commands: ${commands} run, ${nonZero} non-zero exits`);
// Prefer the git snapshot (catches shell-written files too); fall back to Codex's own patch events.
const capped = (title, lines, max) => {
  if (!lines.length) return;
  out.push(`${title}:`, ...lines.slice(0, max).map((l) => `  ${l}`));
  if (lines.length > max) out.push(`  ... ${lines.length - max} more`);
};
const lines = (name) => read(name).split('\n').map((l) => l.trimEnd()).filter(Boolean);
const gitTracked = fs.existsSync(path.join(runDir, 'git-new-files.txt'));
if (gitTracked) {
  capped('repo changes during run (git diff --stat vs pre-run tree)', lines('git-changes.txt'), 40);
  const base = read('base.txt').trim();
  if (base && lines('git-changes.txt').length) out.push(`review diff (this run only): git diff ${base.slice(0, 12)} -- <file>`);
  capped('new untracked files', lines('git-new-files.txt'), 30);
  const isAbs = (p) => /^([A-Za-z]:)?[\\/]/.test(p);
  const outside = [...files.keys()].filter((p) => isAbs(p) && rel(p) === p.replace(/\\/g, '/'));
  capped('edited outside the repo', outside.map(rel), 20);
} else {
  capped('files changed', [...files].map(([p, k]) => `${k ?? 'update'}  ${rel(p)}`), 40);
}
if (mcpCalls.size) out.push(`mcp calls: ${[...mcpCalls].map(([k, n]) => `${k} x${n}`).join(', ')}`);
capped('generated images (originals)', images, 20);
let reviewMedia = [];
try {
  reviewMedia = fs.readdirSync(runDir).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f)).map((f) => path.join(runDir, f));
} catch {}
capped('review media in run dir', reviewMedia, 10);
if (limitUntil) out.push(`usage limit: launches are refused until ${new Date(limitUntil * 1000).toLocaleString()} (override: --ignore-limit)`);
if (allErrors.length) out.push(`errors:`, ...[...new Set(allErrors)].slice(0, 5).map((m) => `  ${m}`));
if (exit === 1 && !allErrors.length) {
  const tail = read('stderr.log').trim().split('\n').slice(-8).join('\n');
  if (tail) out.push('stderr tail:', tail);
}
out.push('--- Codex final report ---');
if (!finalText) out.push('(none)');
else if (finalText.length <= FINAL_LIMIT) out.push(finalText);
else out.push(finalText.slice(0, FINAL_LIMIT), `... [truncated; full report: ${path.join(runDir, 'final.md')}]`);

fs.writeFileSync(
  path.join(runDir, 'meta.json'),
  JSON.stringify({ status, codexExit, threadId, seconds: secs, usage, files: [...files.keys()], images, errors: allErrors }, null, 2),
);

// One line per run survives cleanup, so offloaded tokens can be totalled later.
const ledger = path.join(path.dirname(runDir), 'ledger.tsv');
if (!fs.existsSync(ledger)) fs.writeFileSync(ledger, 'date\tstatus\tseconds\tinput_tokens\tcached_input_tokens\toutput_tokens\tthread\trun\n');
fs.appendFileSync(
  ledger,
  [new Date(end * 1000).toISOString(), status, secs, usage.input_tokens, usage.cached_input_tokens, usage.output_tokens, threadId ?? '', path.basename(runDir)].join('\t') + '\n',
);
console.log(out.join('\n'));
process.exit(exit);

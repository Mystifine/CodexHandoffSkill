// Cross-process bookkeeping. Only native Node PIDs own locks, including on Git Bash.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const readJson = (file, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};
export const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
};
export function atomicWrite(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, text, { flag: 'wx', mode });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
export const writeJson = (file, value) => atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
export const canonical = (dir) => {
  const real = fs.realpathSync(dir);
  return process.platform === 'win32' ? real.toLowerCase() : real;
};
export function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}
export function safeRemove(root, target) {
  if (!inside(root, target)) throw new Error(`Refusing removal outside ${root}: ${target}`);
  // Do not follow a symlink or junction outside the intended root.
  if (fs.existsSync(target) && !inside(canonical(root), canonical(target))) {
    throw new Error(`Refusing removal through a link outside ${root}: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

export async function withLock(dir, fn, timeoutMs = 15000) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.handoff.lock');
  const owner = { pid: process.pid, token: crypto.randomUUID() };
  const deadline = Date.now() + timeoutMs;
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(owner));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // One reaper at a time; recheck the current owner while holding the reaper lock.
      const reaper = `${file}.reaper`;
      let reapFd;
      try {
        reapFd = fs.openSync(reaper, 'wx', 0o600);
        let held;
        try { held = readJson(file); } catch (parseError) { if (!(parseError instanceof SyntaxError)) throw parseError; }
        // Another process may have just created the file and not written its PID.
        if ((held && !alive(held.pid)) || (!held && fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs > 30000)) fs.rmSync(file, { force: true });
      } catch (reapError) {
        if (!['EEXIST', 'ENOENT'].includes(reapError.code)) throw reapError;
      } finally {
        if (reapFd !== undefined) { fs.closeSync(reapFd); fs.rmSync(reaper, { force: true }); }
      }
      if (Date.now() >= deadline) {
        const busy = new Error(`Bookkeeping busy: ${file}. Retry after the active operation finishes.`);
        busy.exitCode = 75; throw busy;
      }
      await sleep(25);
    }
  }
  try { return await fn(); }
  finally {
    fs.closeSync(fd);
    if (readJson(file)?.token === owner.token) fs.rmSync(file, { force: true });
  }
}

export const stateFile = (root) => path.join(root, 'state.json');
export function loadState(root) {
  return { reservations: [], limits: {}, models: {}, probes: {}, ...readJson(stateFile(root), {}) };
}
export function liveReservations(state) {
  return state.reservations.filter((r) => alive(r.pid) || alive(r.childPid));
}
export function overlap(a, b) {
  return a === b || inside(a, b) || inside(b, a);
}
export async function reserve(root, reservation) {
  return withLock(root, () => {
    const state = loadState(root);
    state.reservations = liveReservations(state);
    const conflict = state.reservations.find((r) =>
      reservation.paths.some((a) => r.paths.some((b) => overlap(a, b))) ||
      reservation.resources.some((a) => r.resources.includes(a)));
    if (conflict) {
      const error = new Error(`Run busy: ${conflict.runDir}. Use a separate worktree or wait; shared apps/threads must run sequentially.`);
      error.exitCode = 75; throw error;
    }
    state.reservations.push(reservation);
    writeJson(stateFile(root), state);
  });
}
export async function updateReservation(root, token, update) {
  return withLock(root, () => {
    const state = loadState(root);
    const record = state.reservations.find((r) => r.token === token);
    if (record) Object.assign(record, update);
    writeJson(stateFile(root), state);
  });
}
export async function release(root, token) {
  return withLock(root, () => {
    const state = loadState(root);
    state.reservations = state.reservations.filter((r) => r.token !== token);
    writeJson(stateFile(root), state);
  });
}
// Caller holds the root lock, so header creation and appends cannot race.
export function appendTable(file, header, row) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${header}\n`, { flag: 'wx' });
  fs.appendFileSync(file, `${row}\n`);
}

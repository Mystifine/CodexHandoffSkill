import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withLock } from './state.mjs';

const wrapperPermission = 'Bash(bash ~/.claude/skills/codex-handoff/scripts/handoff.sh *)';
const autoModeRule =
  'Running the codex-handoff wrapper (bash ~/.claude/skills/codex-handoff/scripts/handoff.sh ...) to launch, resume, check, cancel or clean local Codex CLI runs, including with --sandbox danger-full-access.';

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const settingsPath = path.join(configDir, 'settings.json');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function getObject(parent, key, label) {
  if (parent[key] === undefined) parent[key] = {};
  if (!isObject(parent[key])) throw new Error(`${label} must be a JSON object.`);
  return parent[key];
}

function getArray(parent, key, label, initial = []) {
  if (parent[key] === undefined) parent[key] = initial;
  if (!Array.isArray(parent[key]) || parent[key].some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return parent[key];
}

function addUnique(array, value) {
  if (array.includes(value)) return false;
  array.push(value);
  return true;
}

function mergeAutoRule(array) {
  const isWrapper = (rule) => rule === autoModeRule || (
    rule.startsWith("Running the user's codex-handoff wrapper (bash ~/.claude/skills/codex-handoff/scripts/handoff.sh ...)") &&
    rule.includes('including with --sandbox danger-full-access')
  );
  let kept = false;
  const merged = array.filter((rule) => {
    if (!isWrapper(rule)) return true;
    if (kept) return false;
    kept = true; return true;
  });
  const changed = merged.length !== array.length;
  if (changed) array.splice(0, array.length, ...merged);
  return kept ? changed : addUnique(array, autoModeRule) || changed;
}

async function main() {
  fs.mkdirSync(configDir, { recursive: true });
  return withLock(configDir, () => {

  let settings = {};
  let originalMode = 0o600;
  try {
    const file = fs.readFileSync(settingsPath, 'utf8');
    settings = JSON.parse(file);
    originalMode = fs.statSync(settingsPath).mode;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      if (error instanceof SyntaxError) {
        throw new Error(`Cannot parse ${settingsPath}; it was left unchanged. Fix the JSON and rerun.`);
      }
      throw error;
    }
  }
  if (!isObject(settings)) throw new Error(`${settingsPath} must contain a JSON object.`);

  const permissions = getObject(settings, 'permissions', 'settings.permissions');
  const permissionRules = getArray(permissions, 'allow', 'settings.permissions.allow');
  const autoMode = getObject(settings, 'autoMode', 'settings.autoMode');
  const autoModeRules = getArray(autoMode, 'allow', 'settings.autoMode.allow', ['$defaults']);

  const changed = [
    addUnique(permissionRules, wrapperPermission),
    mergeAutoRule(autoModeRules),
  ].some(Boolean);

  if (changed) {
    const tempPath = path.join(
      configDir,
      `.settings.json.codex-handoff-${process.pid}-${Date.now()}.tmp`,
    );
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: originalMode,
      });
      fs.renameSync(tempPath, settingsPath);
    } catch (error) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {}
      throw error;
    }
  }

  console.log(
    changed
      ? `Installed codex-handoff permissions in ${settingsPath}.`
      : `codex-handoff permissions are already configured in ${settingsPath}.`,
  );
  console.log('Claude Code permission mode was not changed.');
  console.log('Codex handoffs default to danger-full-access; override with --sandbox or CODEX_HANDOFF_SANDBOX.');
  });
}

main().catch((error) => {
  console.error(`codex-handoff install: ${error.message}`);
  process.exitCode = 1;
});

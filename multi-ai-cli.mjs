#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { CONTEXT_USAGE, contextCommand } from './lib/context.mjs';

const VERSION = '0.7.3';
const AGENTS = ['codex', 'claude'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_RULE_MARKER = '# Managed by multi-ai-cli.';
const BACK = Symbol('back');
class Separator {
  constructor(separator = '──────────────') {
    this.separator = separator;
  }
}
const skillHome = path.dirname(fileURLToPath(import.meta.url));
const basePolicyPath = path.join(skillHome, 'policy.yaml');
const configHome = path.resolve(process.env.MULTI_AI_CONFIG_HOME || path.join(os.homedir(), '.multi-ai'));
const configPath = path.join(configHome, 'policy.yaml');

const routeGroups = [
  { label: 'Lead', path: 'lead', slots: ['primary', 'fallback'] },
  { label: 'Architect', path: 'roles.architect', slots: ['primary', 'fallback'] },
  { label: 'Engineer', path: 'roles.engineer', slots: ['primary', 'fallback'] },
  { label: 'Researcher', path: 'roles.researcher', slots: ['primary', 'fallback'] },
  {
    label: 'Reviewer for OpenAI maker',
    path: 'roles.reviewer.by_maker_family.openai',
    slots: ['primary', 'fallback', 'same_family_fallback'],
  },
  {
    label: 'Reviewer for Anthropic maker',
    path: 'roles.reviewer.by_maker_family.anthropic',
    slots: ['primary', 'fallback', 'same_family_fallback'],
  },
  {
    label: 'Competition primary-family lane',
    path: 'competition.lanes.primary_family',
    slots: ['primary', 'fallback'],
  },
  {
    label: 'Competition alternate-family lane',
    path: 'competition.lanes.alternate_family',
    slots: ['primary', 'fallback'],
  },
];

const editablePaths = new Set(['revision_rounds']);
for (const group of routeGroups) {
  for (const slot of group.slots) {
    for (const field of ['agent', 'model', 'effort']) editablePaths.add(`${group.path}.${slot}.${field}`);
  }
}

// unset accepts any prefix of an editable path, so one command can restore a whole
// route (lead.primary), a role (roles.architect), or a section (competition).
const unsetTargets = new Set(editablePaths);
for (const dottedPath of editablePaths) {
  const keys = dottedPath.split('.');
  for (let index = 1; index < keys.length; index += 1) unsetTargets.add(keys.slice(0, index).join('.'));
}

// Launch targets the Lead resolves before each worker-start. Reviewer routes are
// keyed by the family that actually wrote the change, so they need --maker-family.
const routeTargets = {
  lead: { label: 'Lead', path: 'lead' },
  architect: { label: 'Architect', path: 'roles.architect' },
  engineer: { label: 'Engineer', path: 'roles.engineer' },
  researcher: { label: 'Researcher', path: 'roles.researcher' },
  reviewer: { label: 'Reviewer', byMakerFamily: true },
  'competition-primary': { label: 'Competition primary-family lane', path: 'competition.lanes.primary_family' },
  'competition-alternate': { label: 'Competition alternate-family lane', path: 'competition.lanes.alternate_family' },
};
const ROUTE_STEPS = ['primary', 'fallback', 'same_family_fallback'];
const MAKER_FAMILIES = ['openai', 'anthropic'];

const EFFORT_NOTES = {
  low: 'Cheapest and fastest. Subagents and simple tasks.',
  medium: 'Balanced. Enough for most routine work.',
  high: 'The provider default. Intelligence-sensitive work.',
  xhigh: 'Best for most coding and agentic work.',
  max: 'Correctness matters more than cost.',
};

function usage() {
  return `Usage:
  multi-ai-cli                         Show effective policy and commands
  multi-ai-cli show                    Show the effective policy
  multi-ai-cli get <path>              Read one effective value
  multi-ai-cli set <path> <value>      Override one routing value
  multi-ai-cli unset <path>            Restore a value, route, role, or section to its default
  multi-ai-cli reset                   Restore every installed default
  multi-ai-cli defaults [path]         Show the installed defaults
  multi-ai-cli diff                    Show every value that differs from its default
  multi-ai-cli route <target> [opts]   Print launch flags for one worker-start
  multi-ai-cli engineer <family>       Prefer default, codex, or claude Engineer routes
  multi-ai-cli tui                     Configure the full policy interactively
  multi-ai-cli codex-rules install [orca-command]
                                       Allow installed Orca orchestration commands
  multi-ai-cli codex-rules show        Show the managed Codex rule
  multi-ai-cli codex-rules remove      Remove the managed Codex rule
${CONTEXT_USAGE}

Examples:
  multi-ai-cli set lead.primary.effort xhigh
  multi-ai-cli set roles.engineer.primary.model claude-opus-5-5
  multi-ai-cli get roles.reviewer.by_maker_family.anthropic.primary.model
  multi-ai-cli unset lead.primary.effort      One value back to its default
  multi-ai-cli unset lead.primary             One whole route back to its default
  multi-ai-cli unset roles.engineer           Both Engineer routes back to their defaults

Route targets: lead, architect, engineer, researcher, reviewer,
               competition-primary, competition-alternate
Route options: --maker-family <openai|anthropic>   Required for reviewer
               --step <primary|fallback|same_family_fallback>
               --ladder   Show every step for that target
               --json     Full resolution, for launch provenance

  multi-ai-cli route architect
  multi-ai-cli route reviewer --maker-family anthropic
  multi-ai-cli route reviewer --maker-family anthropic --step same_family_fallback
  orca orchestration worker-start $(multi-ai-cli route engineer) ...`;
}

function resolveExecutable(command) {
  if (!command) return undefined;
  const direct = path.resolve(command);
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
    return undefined;
  }

  const extensions = process.platform === 'win32'
    ? [...new Set((process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').flatMap((extension) => [extension.toLowerCase(), extension]))]
    : [''];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.resolve(candidate);
    }
  }
  return undefined;
}

function resolveOrcaExecutable(explicitCommand) {
  const candidates = [
    explicitCommand,
    process.env.ORCA_CLI_COMMAND,
    process.env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : undefined,
    process.platform === 'linux' ? 'orca-ide' : undefined,
    'orca',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = resolveExecutable(candidate);
    if (resolved) return resolved;
  }
  throw new Error(`Could not find Orca. Pass its executable explicitly:\n  multi-ai-cli codex-rules install <orca-command>`);
}

function codexRulesPath() {
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  return path.join(codexHome, 'rules', 'multi-ai.rules');
}

function managedCodexRule(orcaExecutable) {
  return `${CODEX_RULE_MARKER}
# Re-run the Multi-AI installer after Orca moves or upgrades.
prefix_rule(
    pattern = [
        ${JSON.stringify(orcaExecutable)},
        "orchestration",
    ],
    decision = "allow",
    justification = "Allow native Orca orchestration for the Multi-AI Lead on this host.",
)
`;
}

function assertManagedRule(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to replace a directory or link: ${filePath}`);
  }
  const existing = fs.readFileSync(filePath, 'utf8');
  if (!existing.startsWith(CODEX_RULE_MARKER)) {
    throw new Error(`Existing rule is not managed by Multi-AI: ${filePath}\nLeft unchanged.`);
  }
  return existing;
}

function validateCodexRule(filePath, orcaExecutable) {
  const codexExecutable = resolveExecutable('codex');
  if (!codexExecutable) {
    console.log('Codex rule validation skipped: codex executable was not found on PATH.');
    return;
  }
  for (const command of ['worker-start', 'dispatch', 'worker-stop', 'worker-abandon', 'reset']) {
    const result = spawnSync(
      codexExecutable,
      ['execpolicy', 'check', '--rules', filePath, '--', orcaExecutable, 'orchestration', command],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.error) throw new Error(`Could not validate Codex rule: ${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(`Codex rejected the generated rule (${command}):\n${result.stderr || result.stdout}`);
    }
    let decision;
    try {
      decision = JSON.parse(result.stdout).decision;
    } catch {
      throw new Error(`Codex returned an unreadable rule result (${command}):\n${result.stdout}`);
    }
    if (decision !== 'allow') throw new Error(`Generated rule did not allow Orca ${command}: ${decision}`);
  }
}

function installCodexRules(explicitCommand) {
  const orcaExecutable = resolveOrcaExecutable(explicitCommand);
  const filePath = codexRulesPath();
  const directory = path.dirname(filePath);
  if (fs.existsSync(directory) && !fs.statSync(directory).isDirectory()) {
    throw new Error(`Not a Codex rules directory: ${directory}`);
  }
  if (fs.existsSync(filePath)) assertManagedRule(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const candidatePath = path.join(directory, `.multi-ai.rules.${process.pid}.tmp`);
  fs.writeFileSync(candidatePath, managedCodexRule(orcaExecutable), { encoding: 'utf8', flag: 'wx' });
  try {
    validateCodexRule(candidatePath, orcaExecutable);
    fs.writeFileSync(filePath, fs.readFileSync(candidatePath));
  } finally {
    fs.rmSync(candidatePath, { force: true });
  }
  console.log(`Codex Orca rule: ${filePath}`);
  console.log(`Orca executable: ${orcaExecutable}`);
  console.log('Allowed: the Orca orchestration namespace. Restart Codex to load the rule.');
}

function showCodexRules() {
  const filePath = codexRulesPath();
  if (!fs.existsSync(filePath)) throw new Error(`Managed Codex rule is not installed: ${filePath}`);
  assertManagedRule(filePath);
  console.log(`# ${filePath}`);
  process.stdout.write(fs.readFileSync(filePath, 'utf8'));
}

function removeCodexRules() {
  const filePath = codexRulesPath();
  if (!fs.existsSync(filePath)) {
    console.log(`Managed Codex rule is already absent: ${filePath}`);
    return;
  }
  assertManagedRule(filePath);
  fs.unlinkSync(filePath);
  console.log(`Removed managed Codex rule: ${filePath}`);
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function readYamlFile(filePath, label) {
  try {
    const value = parse(fs.readFileSync(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a mapping');
    return value;
  } catch (error) {
    throw new Error(`Invalid ${label} at ${filePath}: ${error.message}`);
  }
}

function readBasePolicy() {
  if (!fs.existsSync(basePolicyPath)) throw new Error(`Installed policy not found: ${basePolicyPath}`);
  return readYamlFile(basePolicyPath, 'installed policy');
}

function getPath(object, dottedPath) {
  return dottedPath.split('.').reduce((value, key) => value?.[key], object);
}

function setPath(object, dottedPath, value) {
  const keys = dottedPath.split('.');
  let cursor = object;
  for (const key of keys.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys.at(-1)] = value;
}

function clone(value) {
  return structuredClone(value);
}

function validatePath(dottedPath) {
  if (!editablePaths.has(dottedPath)) {
    throw new Error(`Unsupported policy path: ${dottedPath}\nRun multi-ai-cli tui or --help to inspect editable settings.`);
  }
}

function coerceValue(dottedPath, rawValue) {
  validatePath(dottedPath);
  if (dottedPath === 'revision_rounds') {
    if (!/^\d+$/.test(rawValue)) throw new Error('revision_rounds must be an integer from 1 to 10.');
    const value = Number(rawValue);
    if (value < 1 || value > 10) throw new Error('revision_rounds must be an integer from 1 to 10.');
    return value;
  }
  if (dottedPath.endsWith('.agent')) {
    if (!AGENTS.includes(rawValue)) throw new Error(`agent must be one of: ${AGENTS.join(', ')}.`);
    return rawValue;
  }
  if (dottedPath.endsWith('.effort')) {
    if (!EFFORTS.includes(rawValue)) throw new Error(`effort must be one of: ${EFFORTS.join(', ')}.`);
    return rawValue;
  }
  if (!rawValue || /\s/.test(rawValue)) throw new Error('model must be a non-empty identifier without whitespace.');
  return rawValue;
}

function legacyEngineerOverrides(base, family) {
  if (family === 'default') return {};
  if (!AGENTS.includes(family)) throw new Error(`Unsupported legacy Engineer family: ${family}`);
  const routes = [base.roles?.engineer?.primary, base.roles?.engineer?.fallback].filter(Boolean);
  const preferred = routes.find((route) => route.agent === family);
  const alternate = routes.find((route) => route.agent !== family);
  if (!preferred || !alternate) throw new Error(`Installed policy has no complete Engineer routes for ${family}.`);
  const overrides = {};
  for (const field of ['agent', 'model', 'effort']) {
    overrides[`roles.engineer.primary.${field}`] = preferred[field];
    overrides[`roles.engineer.fallback.${field}`] = alternate[field];
  }
  return overrides;
}

function readOverrides(base) {
  if (!fs.existsSync(configPath)) return { overrides: {}, legacy: false };
  const stat = fs.lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid host policy: ${configPath}`);
  const host = readYamlFile(configPath, 'host policy');
  if (host.version === 1 && host.role_families && Object.keys(host.role_families).length === 1) {
    return { overrides: legacyEngineerOverrides(base, host.role_families.engineer), legacy: true };
  }
  if (host.version !== 2 || !host.overrides || typeof host.overrides !== 'object' || Array.isArray(host.overrides)) {
    throw new Error('Host policy must contain version: 2 and an overrides mapping.');
  }
  const overrides = {};
  for (const [dottedPath, rawValue] of Object.entries(host.overrides)) {
    validatePath(dottedPath);
    const value = coerceValue(dottedPath, String(rawValue));
    if (getPath(base, dottedPath) === undefined) throw new Error(`Installed policy does not contain: ${dottedPath}`);
    overrides[dottedPath] = value;
  }
  return { overrides, legacy: false };
}

function effectivePolicy(base, overrides) {
  const effective = clone(base);
  for (const [dottedPath, value] of Object.entries(overrides)) setPath(effective, dottedPath, value);
  return effective;
}

function sparseOverrides(base, effective) {
  const result = {};
  for (const dottedPath of [...editablePaths].sort()) {
    const baseValue = getPath(base, dottedPath);
    const effectiveValue = getPath(effective, dottedPath);
    if (effectiveValue !== baseValue) result[dottedPath] = effectiveValue;
  }
  return result;
}

function writeOverrides(overrides) {
  if (fs.existsSync(configHome) && !fs.statSync(configHome).isDirectory()) {
    throw new Error(`Not a configuration directory: ${configHome}`);
  }
  if (fs.existsSync(configPath)) {
    const stat = fs.lstatSync(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing to replace a directory or link: ${configPath}`);
  }
  fs.mkdirSync(configHome, { recursive: true });
  const document = {
    version: 2,
    overrides: Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b))),
  };
  fs.writeFileSync(configPath, `# Host-local differences from the installed Multi-AI policy.\n${stringify(document)}`, 'utf8');
}

function load() {
  const base = readBasePolicy();
  const host = readOverrides(base);
  return { base, effective: effectivePolicy(base, host.overrides), ...host };
}

function show(includeUsage = false) {
  const { effective, overrides, legacy } = load();
  console.log(`# Effective Multi-AI policy${legacy ? ' (legacy host preference applied)' : ''}`);
  console.log(`# Installed: ${basePolicyPath}`);
  console.log(`# Host overrides: ${configPath}${fs.existsSync(configPath) ? ` (${Object.keys(overrides).length})` : ' (none)'}`);
  process.stdout.write(stringify(effective));
  if (includeUsage) console.log(`\n${usage()}`);
}

function setOverride(dottedPath, rawValue) {
  const { base, effective } = load();
  setPath(effective, dottedPath, coerceValue(dottedPath, rawValue));
  writeOverrides(sparseOverrides(base, effective));
  console.log(`${dottedPath}: ${getPath(effective, dottedPath)}`);
  console.log(`Host policy: ${configPath}`);
}

function restorablePaths(prefix) {
  if (editablePaths.has(prefix)) return [prefix];
  return [...editablePaths].filter((dottedPath) => dottedPath.startsWith(`${prefix}.`)).sort();
}

function unknownTargetMessage(prefix) {
  const sections = [...unsetTargets].filter((target) => !editablePaths.has(target)).sort();
  return [
    `Unsupported policy path: ${prefix}`,
    'Restore a route, role, or section:',
    ...sections.map((target) => `  ${target}`),
    'Or one value, such as lead.primary.effort.',
    'Run multi-ai-cli defaults for every restorable value.',
  ].join('\n');
}

function unsetOverride(prefix) {
  const paths = restorablePaths(prefix);
  if (!paths.length) throw new Error(unknownTargetMessage(prefix));
  const { base, effective } = load();
  const restored = paths.filter((dottedPath) => getPath(effective, dottedPath) !== getPath(base, dottedPath));
  for (const dottedPath of paths) setPath(effective, dottedPath, getPath(base, dottedPath));
  writeOverrides(sparseOverrides(base, effective));
  if (!restored.length) console.log(`${prefix} already matches the installed default.`);
  for (const dottedPath of restored) console.log(`${dottedPath}: ${getPath(base, dottedPath)} (installed default)`);
  console.log(`Host policy: ${configPath}`);
}

function showDefaults(prefix) {
  const base = readBasePolicy();
  const paths = prefix ? restorablePaths(prefix) : [...editablePaths].sort();
  if (!paths.length) throw new Error(unknownTargetMessage(prefix));
  console.log(`# Installed defaults: ${basePolicyPath}`);
  for (const dottedPath of paths) console.log(`${dottedPath}: ${getPath(base, dottedPath)}`);
}

function showDiff() {
  const { base, effective, legacy } = load();
  const changed = Object.entries(sparseOverrides(base, effective));
  console.log(`# Host overrides: ${configPath}${legacy ? ' (legacy host preference applied)' : ''}`);
  if (!changed.length) {
    console.log('Every value matches the installed default.');
    return;
  }
  for (const [dottedPath, value] of changed) {
    console.log(`${dottedPath}: ${getPath(base, dottedPath)} -> ${value}`);
  }
  console.log(`\nRestore one: multi-ai-cli unset <path>`);
  console.log('Restore all: multi-ai-cli reset');
}

function setEngineerFamily(family) {
  if (!['default', ...AGENTS].includes(family)) throw new Error('Engineer family must be default, codex, or claude.');
  const { base, effective } = load();
  const paths = ['primary', 'fallback'].flatMap((slot) =>
    ['agent', 'model', 'effort'].map((field) => `roles.engineer.${slot}.${field}`),
  );
  if (family === 'default') {
    for (const dottedPath of paths) setPath(effective, dottedPath, getPath(base, dottedPath));
  } else {
    for (const [dottedPath, value] of Object.entries(legacyEngineerOverrides(base, family))) {
      setPath(effective, dottedPath, value);
    }
  }
  writeOverrides(sparseOverrides(base, effective));
  console.log(`Engineer primary: ${effective.roles.engineer.primary.agent} / ${effective.roles.engineer.primary.model} / ${effective.roles.engineer.primary.effort}`);
  console.log(`Engineer fallback: ${effective.roles.engineer.fallback.agent} / ${effective.roles.engineer.fallback.model} / ${effective.roles.engineer.fallback.effort}`);
  console.log(`Host policy: ${configPath}`);
}

const SHELL_UNSAFE = /[^A-Za-z0-9._\/:=-]/;

function shellQuote(value) {
  return SHELL_UNSAFE.test(value) ? `'${value.replaceAll("'", String.raw`'\''`)}'` : value;
}

function routeFlags(route) {
  return `--agent ${route.agent} --model ${shellQuote(route.model)} --effort ${route.effort}`;
}

function routeGroupPath(target, makerFamily) {
  const entry = routeTargets[target];
  if (!entry) {
    throw new Error(`Unknown route target: ${target}\nTargets: ${Object.keys(routeTargets).join(', ')}`);
  }
  if (!entry.byMakerFamily) return entry.path;
  if (!MAKER_FAMILIES.includes(makerFamily)) {
    throw new Error(
      `reviewer needs --maker-family <${MAKER_FAMILIES.join('|')}>: the family that actually wrote the change.`,
    );
  }
  return `roles.reviewer.by_maker_family.${makerFamily}`;
}

// Resolves one rung of the ladder. Availability is not knowable here, so stepping
// down stays the caller's decision after a confirmed launch failure.
function resolveRoute(policy, target, { makerFamily, step }) {
  if (!ROUTE_STEPS.includes(step)) throw new Error(`step must be one of: ${ROUTE_STEPS.join(', ')}.`);
  if (step === 'same_family_fallback' && target !== 'reviewer') {
    throw new Error('same_family_fallback exists only for reviewer.');
  }
  const groupPath = routeGroupPath(target, makerFamily);
  const route = getPath(policy, `${groupPath}.${step}`);
  if (!route) {
    throw new Error(
      step === 'same_family_fallback'
        ? `Policy has no same_family_fallback for ${target}. Opposite-family coverage is required instead.`
        : `Policy has no ${step} route for ${target}.`,
    );
  }
  const family = policy.families?.[route.agent];
  const independent = target === 'reviewer' ? family !== makerFamily : undefined;
  const notes = [];
  if (step !== 'primary') {
    notes.push('Not the primary route. Use it only after confirmed unavailability, and record the substitution.');
  }
  if (independent === false) {
    notes.push('Same family as the maker. Cross-family review independence is lost.');
    notes.push('Record the reduced diversity in the review and in the decision.');
  }
  return { target, makerFamily, step, groupPath, route, family, independent, notes };
}

function parseRouteArgs(args) {
  const [target, ...rest] = args;
  const options = { step: 'primary', json: false, ladder: false, makerFamily: undefined };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--ladder') options.ladder = true;
    else if (arg === '--step' || arg === '--maker-family') {
      const value = rest[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
      if (arg === '--step') options.step = value;
      else options.makerFamily = value;
      index += 1;
    } else throw new Error(`Unknown route option: ${arg}`);
  }
  return { target, options };
}

function showRoute(args) {
  const { target, options } = parseRouteArgs(args);
  const { effective } = load();

  if (options.ladder) {
    const groupPath = routeGroupPath(target, options.makerFamily);
    for (const step of ROUTE_STEPS) {
      if (!getPath(effective, `${groupPath}.${step}`)) continue;
      const resolved = resolveRoute(effective, target, { ...options, step });
      const marker = resolved.independent === false ? '   # same family as the maker' : '';
      console.log(`${step.padEnd(22)}${routeFlags(resolved.route)}${marker}`);
    }
    return;
  }

  const resolved = resolveRoute(effective, target, options);
  if (options.json) {
    console.log(JSON.stringify({
      target: resolved.target,
      maker_family: resolved.makerFamily ?? null,
      step: resolved.step,
      agent: resolved.route.agent,
      model: resolved.route.model,
      effort: resolved.route.effort,
      family: resolved.family ?? null,
      independent_of_maker: resolved.independent ?? null,
      flags: routeFlags(resolved.route),
      notes: resolved.notes,
      installed_policy: basePolicyPath,
      host_policy: fs.existsSync(configPath) ? configPath : null,
    }, null, 2));
  } else {
    console.log(routeFlags(resolved.route));
  }
  // Warnings go to stderr so command substitution captures only the flags.
  for (const note of resolved.notes) console.error(`# ${note}`);
}

async function choose(message, choices, defaultValue) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error('TUI requires an interactive terminal. Use multi-ai-cli set <path> <value> instead.');
  }
  const selectable = choices
    .map((choice, index) => (choice instanceof Separator ? null : index))
    .filter((index) => index !== null);
  let active = choices.findIndex((choice) => !(choice instanceof Separator) && choice.value === defaultValue);
  if (active < 0) active = selectable[0];
  let renderedLines = 0;
  const color = (code, value) => process.env.NO_COLOR !== undefined ? value : `\u001b[${code}m${value}\u001b[0m`;
  const fit = (value) => {
    const width = Math.max(30, (process.stdout.columns || 80) - 4);
    return value.length > width ? `${value.slice(0, width - 1)}…` : value;
  };
  const clear = () => {
    if (!renderedLines) return;
    readline.moveCursor(process.stdout, 0, -renderedLines);
    readline.cursorTo(process.stdout, 0);
    readline.clearScreenDown(process.stdout);
    renderedLines = 0;
  };
  const render = () => {
    clear();
    const lines = [
      `${color('36', '?')} ${color('1', message)} ${color('2', '(↑/↓ move · Enter select · Esc/q back)')}`,
      ...choices.map((choice, index) => {
        if (choice instanceof Separator) return color('2', `  ${choice.separator}`);
        const cursor = index === active ? color('36', '❯') : ' ';
        const name = index === active ? color('1;36', fit(choice.name)) : fit(choice.name);
        return `${cursor} ${name}`;
      }),
      '',
      color('2', fit(choices[active]?.description || ' ')),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    renderedLines = lines.length;
  };

  process.stdin.resume();
  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdout.write('\u001b[?25l');

  return new Promise((resolve, reject) => {
    const finish = (value, error) => {
      process.stdin.off('keypress', onKeypress);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      clear();
      process.stdout.write('\u001b[?25h');
      if (error) reject(error);
      else resolve(value);
    };
    const move = (offset) => {
      const position = selectable.indexOf(active);
      const next = Math.max(0, Math.min(selectable.length - 1, position + offset));
      active = selectable[next];
      render();
    };
    const onKeypress = (_input, key = {}) => {
      if (key.name === 'up') move(-1);
      else if (key.name === 'down') move(1);
      else if (key.name === 'return' || key.name === 'enter') finish(choices[active].value);
      else if (key.name === 'escape' || (key.name === 'q' && !key.ctrl && !key.meta)) finish(BACK);
      else if (key.ctrl && key.name === 'c') {
        const error = new Error('User canceled the prompt.');
        error.name = 'ExitPromptError';
        finish(undefined, error);
      }
    };
    process.stdin.on('keypress', onKeypress);
    render();
  });
}

function screen(title, detail) {
  console.clear();
  console.log('╭─────────────────────────────────────────────────────────────╮');
  console.log(`  Multi-AI Policy  ·  ${title}`);
  for (const line of [detail].flat()) {
    if (line) console.log(`  ${line}`);
  }
  console.log('╰─────────────────────────────────────────────────────────────╯\n');
}

function routeLabel(route) {
  return `${route.agent} / ${route.model} / ${route.effort}`;
}

function routesEqual(left, right) {
  return ['agent', 'model', 'effort'].every((field) => left?.[field] === right?.[field]);
}

// Tags the option a list is currently set to, and the one the installed policy ships.
function optionTag(value, current, installedDefault) {
  const tags = [];
  if (value === current) tags.push('current');
  if (value === installedDefault) tags.push('default');
  return tags.length ? `  <- ${tags.join(' · ')}` : '';
}

function modelChoices(base, effective, agent, current, installedDefault) {
  const models = new Map();
  for (const policy of [base, effective]) {
    for (const group of routeGroups) {
      for (const slot of group.slots) {
        const route = getPath(policy, `${group.path}.${slot}`);
        if (route?.agent !== agent || !route.model) continue;
        if (!models.has(route.model)) models.set(route.model, new Set());
        models.get(route.model).add(`${group.label} · ${slot.replaceAll('_', ' ')}`);
      }
    }
  }
  return [...models.entries()].map(([model, uses]) => ({
    name: `${model}${optionTag(model, current, installedDefault)}`,
    value: model,
    description: `Configured for ${[...uses].slice(0, 3).join(', ')}`,
  }));
}

async function editRoute(base, effective, routePath) {
  const installedDefault = getPath(base, routePath);
  const draft = { ...getPath(effective, routePath) };
  let step = 0;
  while (true) {
    const current = getPath(effective, routePath);
    const atDefault = routesEqual(current, installedDefault);
    screen('Edit route', [
      `${routePath}  ·  step ${step + 1} of 4`,
      `Current: ${routeLabel(current)}${atDefault ? '  (installed default)' : ''}`,
      atDefault ? undefined : `Default: ${routeLabel(installedDefault)}`,
      `Editing: ${routeLabel(draft)}`,
    ]);
    if (step === 0) {
      const agent = await choose(
        'Agent / provider family',
        AGENTS.map((value) => ({
          name: `${value === 'codex' ? 'Codex' : 'Claude Code'}${optionTag(value, current.agent, installedDefault.agent)}`,
          value,
          description: `Provider family: ${base.families[value]}`,
        })),
        draft.agent,
      );
      if (agent === BACK) return;
      draft.agent = agent;
      const available = modelChoices(base, effective, draft.agent);
      if (!available.some(({ value }) => value === draft.model)) draft.model = available[0]?.value;
      if (!draft.model) throw new Error(`No configured models are available for ${draft.agent}.`);
      step = 1;
      continue;
    }
    if (step === 1) {
      const available = modelChoices(
        base,
        effective,
        draft.agent,
        draft.agent === current.agent ? current.model : undefined,
        draft.agent === installedDefault.agent ? installedDefault.model : undefined,
      );
      const model = await choose('Model', available, draft.model);
      if (model === BACK) {
        step = 0;
        continue;
      }
      draft.model = model;
      step = 2;
      continue;
    }
    if (step === 2) {
      const effort = await choose(
        'Reasoning effort',
        EFFORTS.map((value) => ({
          name: `${value}${optionTag(value, current.effort, installedDefault.effort)}`,
          value,
          description: EFFORT_NOTES[value],
        })),
        draft.effort,
      );
      if (effort === BACK) {
        step = 1;
        continue;
      }
      draft.effort = effort;
      step = 3;
      continue;
    }
    const action = await choose(
      'Apply this route?',
      [
        { name: `Apply  ${routeLabel(draft)}`, value: 'apply', description: 'Stage this route in the TUI.' },
        {
          name: `Restore default  ${routeLabel(installedDefault)}`,
          value: 'restore',
          description: atDefault
            ? 'This route already matches the installed default.'
            : 'Discard the draft and stage the installed default instead.',
        },
        { name: 'Cancel', value: 'cancel', description: 'Keep the current route.' },
      ],
      'apply',
    );
    if (action === BACK) {
      step = 2;
      continue;
    }
    if (action === 'cancel') return;
    if (action === 'restore') {
      setPath(effective, routePath, clone(installedDefault));
      return;
    }
    setPath(effective, routePath, {
      agent: coerceValue(`${routePath}.agent`, draft.agent),
      model: coerceValue(`${routePath}.model`, draft.model),
      effort: coerceValue(`${routePath}.effort`, draft.effort),
    });
    return;
  }
}

async function editGroup(base, effective, group) {
  const slotPath = (slot) => `${group.path}.${slot}`;
  const slotAtDefault = (slot) => routesEqual(getPath(effective, slotPath(slot)), getPath(base, slotPath(slot)));
  while (true) {
    const drifted = group.slots.filter((slot) => !slotAtDefault(slot));
    screen(group.label, [
      'Choose a route to edit',
      drifted.length
        ? `${drifted.length} of ${group.slots.length} routes differ from the installed default`
        : 'Every route matches the installed default',
    ]);
    const choice = await choose(
      group.label,
      [
        ...group.slots.map((slot) => ({
          name: `${slot.replaceAll('_', ' ').padEnd(21)}${routeLabel(getPath(effective, slotPath(slot)))}${slotAtDefault(slot) ? '' : '  *'}`,
          value: slot,
          description: slotAtDefault(slot)
            ? 'Installed default.'
            : `* changed · installed default: ${routeLabel(getPath(base, slotPath(slot)))}`,
        })),
        new Separator(),
        ...(drifted.length
          ? [{
            name: `Restore ${group.label} defaults`,
            value: 'restore',
            description: `Stage the installed default for ${drifted.length} route${drifted.length === 1 ? '' : 's'}.`,
          }]
          : []),
        { name: '← Back', value: 'back' },
      ],
    );
    if (choice === BACK || choice === 'back') return;
    if (choice === 'restore') {
      for (const slot of group.slots) setPath(effective, slotPath(slot), clone(getPath(base, slotPath(slot))));
      continue;
    }
    await editRoute(base, effective, slotPath(choice));
  }
}

async function tui() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('TUI requires an interactive terminal. Use multi-ai-cli set <path> <value> instead.');
  }
  const { base, effective, legacy } = load();
  const groupChoice = (group, index) => {
    const drifted = group.slots.some(
      (slot) => !routesEqual(getPath(effective, `${group.path}.${slot}`), getPath(base, `${group.path}.${slot}`)),
    );
    return {
      name: `${group.label}${drifted ? '  *' : ''}`,
      value: `group:${index}`,
      description: `primary: ${routeLabel(getPath(effective, `${group.path}.primary`))}${drifted ? '   * differs from the installed default' : ''}`,
    };
  };
  try {
    while (true) {
      const changed = Object.keys(sparseOverrides(base, effective)).length;
      screen(
        'Host configuration',
        `${changed} override${changed === 1 ? '' : 's'} · ${configPath}${legacy ? ' · legacy setting loaded' : ''}`,
      );
      const choice = await choose(
        'What would you like to configure?',
        [
          new Separator('── Roles ──'),
          ...routeGroups.slice(0, 4).map((group, index) => groupChoice(group, index)),
          new Separator('── Review ──'),
          ...routeGroups.slice(4, 6).map((group, offset) => groupChoice(group, offset + 4)),
          new Separator('── Competition ──'),
          ...routeGroups.slice(6).map((group, offset) => groupChoice(group, offset + 6)),
          new Separator('── Policy ──'),
          {
            name: 'Revision rounds',
            value: 'revision',
            description: `Current limit: ${effective.revision_rounds}`,
          },
          {
            name: 'Restore installed defaults',
            value: 'restore',
            description: changed
              ? `Clear all ${changed} staged override${changed === 1 ? '' : 's'}.`
              : 'Nothing to clear. Everything already matches the installed default.',
          },
          new Separator(),
          {
            name: `✓ Save and exit${changed ? ` (${changed} overrides)` : ''}`,
            value: 'save',
            description: 'Write the host policy and exit.',
          },
          { name: '× Discard and exit', value: 'discard', description: 'Leave the host policy unchanged.' },
        ],
        'group:0',
      );

      if (choice === BACK) {
        console.clear();
        console.log('No changes saved.');
        return;
      }
      if (choice.startsWith('group:')) {
        await editGroup(base, effective, routeGroups[Number(choice.split(':')[1])]);
        continue;
      }
      if (choice === 'revision') {
        screen('Revision rounds', 'Maximum correction cycles before the Lead reports a blocker');
        const rounds = await choose(
          'Revision-round limit',
          Array.from({ length: 10 }, (_, index) => ({ name: String(index + 1), value: index + 1 })),
          effective.revision_rounds,
        );
        if (rounds !== BACK) effective.revision_rounds = rounds;
        continue;
      }
      if (choice === 'restore') {
        const confirmed = await choose(
          'Restore every installed default?',
          [
            { name: 'No, keep my staged settings', value: false },
            { name: 'Yes, clear all host overrides', value: true },
          ],
          false,
        );
        if (confirmed !== BACK && confirmed) {
          const restored = clone(base);
          for (const key of Object.keys(effective)) delete effective[key];
          Object.assign(effective, restored);
        }
        continue;
      }
      if (choice === 'discard') {
        console.clear();
        console.log('No changes saved.');
        return;
      }
      if (choice === 'save') {
        const overrides = sparseOverrides(base, effective);
        writeOverrides(overrides);
        console.clear();
        console.log(`✓ Saved ${Object.keys(overrides).length} override(s).`);
        console.log(`  ${configPath}`);
        console.log('\nStart a new Lead session after changing its route.');
        return;
      }
    }
  } catch (error) {
    if (error?.name === 'ExitPromptError') {
      console.clear();
      console.log('No changes saved.');
      process.exitCode = 130;
      return;
    }
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) return show(true);
  if (args.length === 1 && args[0] === 'show') return show();
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return console.log(usage());
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) return console.log(VERSION);
  if (args.length === 1 && args[0] === 'tui') return tui();
  if (args.length === 2 && args[0] === 'codex-rules' && args[1] === 'install') return installCodexRules();
  if (args.length === 3 && args[0] === 'codex-rules' && args[1] === 'install') return installCodexRules(args[2]);
  if (args.length === 2 && args[0] === 'codex-rules' && args[1] === 'show') return showCodexRules();
  if (args.length === 2 && args[0] === 'codex-rules' && args[1] === 'remove') return removeCodexRules();
  if (args.length >= 2 && args[0] === 'route') return showRoute(args.slice(1));
  if (args.length >= 1 && args[0] === 'context') {
    return contextCommand(args.slice(1), { cliPath: fileURLToPath(import.meta.url), version: VERSION });
  }
  if (args.length === 1 && args[0] === 'diff') return showDiff();
  if (args.length === 1 && args[0] === 'defaults') return showDefaults();
  if (args.length === 2 && args[0] === 'defaults') return showDefaults(args[1]);
  if (args.length === 1 && args[0] === 'reset') {
    writeOverrides({});
    console.log(`Restored every installed default.\nHost policy: ${configPath}`);
    return;
  }
  if (args.length === 2 && args[0] === 'get') {
    validatePath(args[1]);
    console.log(getPath(load().effective, args[1]));
    return;
  }
  if (args.length === 2 && args[0] === 'unset') return unsetOverride(args[1]);
  if (args.length === 2 && args[0] === 'engineer') return setEngineerFamily(args[1]);
  if (args.length === 3 && args[0] === 'set') return setOverride(args[1], args[2]);
  throw new Error(usage());
}

main().catch((error) => fail(error.message));

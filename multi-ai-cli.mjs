#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { CONTEXT_USAGE, contextCommand } from './lib/context.mjs';

const VERSION = '0.9.0';
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
  { label: 'Lead', short: 'lead', path: 'lead', slots: ['primary', 'fallback'] },
  { label: 'Architect', short: 'architect', path: 'roles.architect', slots: ['primary', 'fallback'] },
  { label: 'Engineer', short: 'engineer', path: 'roles.engineer', slots: ['primary', 'fallback'] },
  { label: 'Researcher', short: 'researcher', path: 'roles.researcher', slots: ['primary', 'fallback'] },
  {
    label: 'Reviewer for OpenAI maker',
    short: 'reviewer<-openai',
    path: 'roles.reviewer.by_maker_family.openai',
    slots: ['primary', 'fallback', 'same_family_fallback'],
  },
  {
    label: 'Reviewer for Anthropic maker',
    short: 'reviewer<-anthropic',
    path: 'roles.reviewer.by_maker_family.anthropic',
    slots: ['primary', 'fallback', 'same_family_fallback'],
  },
  {
    label: 'Competition primary-family lane',
    short: 'compete primary',
    path: 'competition.lanes.primary_family',
    slots: ['primary', 'fallback'],
  },
  {
    label: 'Competition alternate-family lane',
    short: 'compete alternate',
    path: 'competition.lanes.alternate_family',
    slots: ['primary', 'fallback'],
  },
];

const editablePaths = new Set(['revision_rounds', ...AGENTS.map((agent) => `providers.${agent}.enabled`)]);
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
  multi-ai-cli provider                Show provider ON/OFF status
  multi-ai-cli provider <agent> <on|off>
                                       Pause or resume codex or claude on this host
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
  multi-ai-cli provider claude off            Skip Claude until it is turned on again
  multi-ai-cli provider claude on             Restore the saved Claude routes

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
  if (dottedPath.startsWith('providers.')) {
    if (!['true', 'false'].includes(rawValue)) throw new Error('provider enabled must be true or false.');
    return rawValue === 'true';
  }
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
  assertEnabledProvider(effectivePolicy(readBasePolicy(), overrides));
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

function enabledAgents(policy) {
  return AGENTS.filter((agent) => policy.providers?.[agent]?.enabled !== false);
}

function assertEnabledProvider(policy) {
  if (!enabledAgents(policy).length) throw new Error('Keep at least one provider ON. Enable codex or claude first.');
}

function showProviders() {
  const { effective } = load();
  for (const agent of AGENTS) {
    console.log(`${agent}: ${enabledAgents(effective).includes(agent) ? 'ON' : 'OFF'}`);
  }
}

function setProvider(agent, state) {
  if (!AGENTS.includes(agent) || !['on', 'off'].includes(state)) {
    throw new Error('Usage: multi-ai-cli provider <codex|claude> <on|off>');
  }
  const { base, effective } = load();
  setPath(effective, `providers.${agent}.enabled`, state === 'on');
  writeOverrides(sparseOverrides(base, effective));
  console.log(`${agent}: ${state.toUpperCase()}. Saved route preferences are unchanged.`);
  console.log(`Host policy: ${configPath}`);
  console.log('Applies to the next route resolution; already-running sessions continue.');
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

// Host switches are known unavailability. Runtime failures still require an
// explicit --step; never retry an earlier rung after the caller stepped past it.
function routeEntries(policy, target, makerFamily) {
  assertEnabledProvider(policy);
  const groupPath = routeGroupPath(target, makerFamily);
  const enabled = enabledAgents(policy);
  const entries = (sourceGroup) => ROUTE_STEPS.flatMap((step) => {
    const route = getPath(policy, `${sourceGroup}.${step}`);
    return route && enabled.includes(route.agent) ? [{ step, route, sourceGroup }] : [];
  });
  const own = entries(groupPath);
  if (own.length || target === 'reviewer') return own;

  // A lane with no enabled family borrows its sibling. Ordinary roles borrow
  // configured Engineer routes, then Lead routes; never invent model identifiers.
  const alternatives = target.startsWith('competition-')
    ? [target === 'competition-primary' ? 'competition.lanes.alternate_family' : 'competition.lanes.primary_family']
    : ['roles.engineer', 'lead'];
  for (const alternative of alternatives) {
    if (alternative === groupPath) continue;
    const available = entries(alternative);
    if (available.length) return available;
  }
  return [];
}

function resolveRoute(policy, target, { makerFamily, step }) {
  if (!ROUTE_STEPS.includes(step)) throw new Error(`step must be one of: ${ROUTE_STEPS.join(', ')}.`);
  if (step === 'same_family_fallback' && target !== 'reviewer') {
    throw new Error('same_family_fallback exists only for reviewer.');
  }
  const groupPath = routeGroupPath(target, makerFamily);
  if (!getPath(policy, `${groupPath}.${step}`)) {
    throw new Error(
      step === 'same_family_fallback'
        ? `Policy has no same_family_fallback for ${target}. Opposite-family coverage is required instead.`
        : `Policy has no ${step} route for ${target}.`,
    );
  }
  const selected = routeEntries(policy, target, makerFamily)
    .find((entry) => ROUTE_STEPS.indexOf(entry.step) >= ROUTE_STEPS.indexOf(step));
  if (!selected) {
    throw new Error(`No enabled ${step} or later route for ${target}. Check multi-ai-cli provider and configure an enabled route.`);
  }
  const { route, step: selectedStep, sourceGroup } = selected;
  const family = policy.families?.[route.agent];
  const independent = target === 'reviewer' ? family !== makerFamily : undefined;
  const notes = [];
  const disabled = AGENTS.filter((agent) => !enabledAgents(policy).includes(agent));
  if (disabled.length) notes.push(`Provider ${disabled.join(', ')} is OFF by host policy; disabled routes are excluded.`);
  if (sourceGroup !== groupPath) {
    notes.push(`No enabled routes for ${target}; using configured ${sourceGroup} routes. Record the substitution.`);
  }
  if (target.startsWith('competition-') && disabled.length) {
    notes.push('Only one provider is ON; competition lanes share its family. Record the reduced diversity.');
  }
  if (selectedStep !== step) {
    notes.push(`Requested ${step} is disabled; selected ${selectedStep}. Record the substitution.`);
  }
  if (selectedStep !== 'primary' && selectedStep === step) {
    notes.push('Not the primary route. Use it only after confirmed unavailability, and record the substitution.');
  }
  if (independent === false) {
    notes.push('Same family as the maker. Cross-family review independence is lost.');
    notes.push('Record the reduced diversity in the review and in the decision.');
  }
  return { target, makerFamily, step: selectedStep, requestedStep: step, groupPath, sourceGroup, route, family, independent, notes };
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
    const entries = routeEntries(effective, target, options.makerFamily);
    if (!entries.length) throw new Error(`No enabled routes for ${target}. Check multi-ai-cli provider.`);
    for (const { step, route, sourceGroup } of entries) {
      const sameFamily = target === 'reviewer' && effective.families?.[route.agent] === options.makerFamily;
      const marker = sameFamily ? '   # same family as the maker' : '';
      const source = sourceGroup !== routeGroupPath(target, options.makerFamily) ? `   # from ${sourceGroup}` : '';
      console.log(`${step.padEnd(22)}${routeFlags(route)}${marker}${source}`);
    }
    return;
  }

  const resolved = resolveRoute(effective, target, options);
  if (options.json) {
    console.log(JSON.stringify({
      target: resolved.target,
      maker_family: resolved.makerFamily ?? null,
      step: resolved.step,
      requested_step: resolved.requestedStep,
      source_group: resolved.sourceGroup,
      disabled_providers: AGENTS.filter((agent) => !enabledAgents(effective).includes(agent)),
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

function modelChoices(base, effective, agent, current, installedDefault, skipPath) {
  const models = new Map();
  for (const policy of [base, effective]) {
    for (const group of routeGroups) {
      for (const slot of group.slots) {
        const path = `${group.path}.${slot}`;
        if (path === skipPath) continue;
        const route = getPath(policy, path);
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

// A terminal can deliver several keypresses in one chunk, and emitKeypressEvents
// emits them back to back, so reads go through a queue instead of a one-shot
// listener. The reader detaches while a picker owns stdin.
function keyReader() {
  const queue = [];
  let waiting = null;
  const onKeypress = (input, key) => {
    const event = { input, key: key || {} };
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(event);
    } else queue.push(event);
  };
  return {
    attach() { queue.length = 0; process.stdin.on('keypress', onKeypress); },
    detach() { process.stdin.off('keypress', onKeypress); waiting = null; },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { waiting = resolve; });
    },
  };
}

const FIELDS = ['agent', 'model', 'effort'];

// Every editable line in one flat list: each route slot, then revision_rounds.
function policyRows() {
  const rows = AGENTS.map((agent) => ({
    kind: 'provider', path: `providers.${agent}.enabled`, group: agent, slot: 'provider',
  }));
  for (const group of routeGroups) {
    for (const slot of group.slots) {
      rows.push({
        kind: 'route',
        path: `${group.path}.${slot}`,
        group: group.short,
        slot: slot.replaceAll('_', ' ').replace('same family fallback', 'same-family'),
      });
    }
  }
  rows.push({ kind: 'rounds', path: 'revision_rounds', group: 'revision rounds', slot: '' });
  return rows;
}

function fieldOptions(base, effective, row, field, skipPath) {
  if (row.kind === 'provider') return [true, false];
  if (row.kind === 'rounds') return Array.from({ length: 10 }, (_, index) => index + 1);
  if (field === 'agent') return AGENTS;
  if (field === 'effort') return EFFORTS;
  const agent = getPath(effective, `${row.path}.agent`);
  return modelChoices(base, effective, agent, undefined, undefined, skipPath).map((choice) => choice.value);
}

// Changing the agent can strand the model on another family's id.
function repairModel(base, effective, routePath) {
  const agent = getPath(effective, `${routePath}.agent`);
  const options = fieldOptions(base, effective, { kind: 'route', path: routePath }, 'model', routePath);
  if (!options.length) throw new Error(`No configured models are available for ${agent}.`);
  if (!options.includes(getPath(effective, `${routePath}.model`))) setPath(effective, `${routePath}.model`, options[0]);
}

function rowValue(effective, row, field) {
  return row.kind !== 'route' ? getPath(effective, row.path) : getPath(effective, `${row.path}.${field}`);
}

function rowAtDefault(base, effective, row) {
  return row.kind !== 'route'
    ? getPath(effective, row.path) === getPath(base, row.path)
    : routesEqual(getPath(effective, row.path), getPath(base, row.path));
}

function resetRow(base, effective, row) {
  setPath(effective, row.path, clone(getPath(base, row.path)));
}

async function tui() {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error('TUI requires an interactive terminal. Use multi-ai-cli set <path> <value> instead.');
  }
  const { base, effective, legacy } = load();
  const rows = policyRows();
  const plain = process.env.NO_COLOR !== undefined;
  const color = (code, value) => (plain ? value : `[${code}m${value}[0m`);

  let cursor = 0;
  let field = 0;
  let filter = '';
  let typing = false;
  let note = '';

  const changeValue = (row, name, value) => {
    if (row.kind === 'provider' && !value && enabledAgents(effective).length === 1) {
      note = 'Keep at least one provider ON.';
      return;
    }
    const dottedPath = row.kind === 'route' ? `${row.path}.${name}` : row.path;
    setPath(effective, dottedPath, coerceValue(dottedPath, String(value)));
    if (row.kind === 'route' && name === 'agent') repairModel(base, effective, row.path);
  };

  const visible = () => {
    if (!filter) return rows;
    const needle = filter.toLowerCase();
    return rows.filter((row) => `${row.group} ${row.slot} ${JSON.stringify(getPath(effective, row.path) ?? effective.revision_rounds)}`
      .toLowerCase().includes(needle));
  };

  const render = () => {
    const shown = visible();
    if (cursor >= shown.length) cursor = Math.max(0, shown.length - 1);
    const width = Math.max(60, process.stdout.columns || 80);
    const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
    const labelWidth = clamp(width - 46, 20, 34);
    const labelRoom = labelWidth - 1; // keep a gutter before AGENT
    const modelWidth = clamp(width - labelWidth - 22, 12, 24);
    const cut = (text, size) => (text.length > size - 1 ? `${text.slice(0, size - 2)}…` : text);
    const rowLabel = (row) => {
      if (!row.slot) return cut(row.group, labelRoom);
      // The slot is what separates sibling routes, so the group gives way first.
      const room = labelRoom - row.slot.length - 3;
      if (room >= 4) return `${cut(row.group, room + 1)} · ${row.slot}`;
      return cut(`${row.group} · ${row.slot}`, labelRoom);
    };
    const changed = Object.keys(sparseOverrides(base, effective)).length;
    const height = Math.max(8, (process.stdout.rows || 30) - 10);
    const top = Math.max(0, Math.min(cursor - Math.floor(height / 2), shown.length - height));
    const slice = shown.slice(Math.max(0, top), Math.max(0, top) + height);

    const out = ['[H[2J[?25l'];
    const say = (line) => out.push(`${line}\n`);

    say(color('1', 'Multi-AI policy') + color('2', `   ${changed} override${changed === 1 ? '' : 's'}${legacy ? ' · legacy' : ''} · ${configPath}`));
    say(`  Providers: ${AGENTS.map((agent) => `${agent} ${enabledAgents(effective).includes(agent) ? 'ON' : 'OFF'}`).join(' · ')}`);
    say('');
    say(color('2', `  ${'ROUTE'.padEnd(labelWidth)}${'AGENT'.padEnd(8)}${'MODEL'.padEnd(modelWidth)}EFFORT`));

    for (const row of slice) {
      const index = shown.indexOf(row);
      const here = index === cursor;
      const dirty = rowAtDefault(base, effective, row) ? ' ' : '*';
      const cells = row.kind !== 'route'
        ? [{ text: row.kind === 'provider' ? (getPath(effective, row.path) ? 'ON' : 'OFF') : String(effective.revision_rounds), width: 8 }]
        : FIELDS.map((name, position) => ({
          field: name,
          text: String(rowValue(effective, row, name)),
          width: position === 0 ? 8 : position === 1 ? modelWidth : 8,
        }));
      let line = `${here ? color('36', '>') : ' '}${color(dirty === '*' ? '33' : '2', dirty)}${rowLabel(row).padEnd(labelWidth)}`;
      for (const [position, cell] of cells.entries()) {
        const text = cut(cell.text, cell.width);
        const focused = here && (row.kind !== 'route' || position === field);
        line += focused
          ? color('7', text) + ' '.repeat(Math.max(1, cell.width - text.length))
          : text.padEnd(cell.width);
      }
      say(here ? color('1', line) : line);
    }

    say('');
    const row = shown[cursor];
    if (row && !rowAtDefault(base, effective, row)) {
      const original = row.kind !== 'route' ? String(getPath(base, row.path)) : routeLabel(getPath(base, row.path));
      say(color('2', `  installed default: ${original}`));
    } else if (row) {
      say(color('2', '  installed default'));
    } else {
      say(color('2', '  no rows match the filter'));
    }
    say('');
    if (typing) {
      say(color('36', `  /${filter}`) + color('2', '   ⏎ apply · esc clear'));
    } else if (note) {
      say(color('33', `  ${note}`));
    } else {
      say(color('2', '  ↑↓ row · ←→ field · space next value · ⏎ pick · r reset row · R reset all'));
    }
    say(color('2', `  / filter${filter ? ` (${filter})` : ''} · s save · q quit`));
    process.stdout.write(out.join(''));
  };

  process.stdin.resume();
  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  const keys = keyReader();
  keys.attach();

  // A picker attaches its own listener, so hand stdin over and take it back.
  const pick = async (...args) => {
    keys.detach();
    process.stdout.write('[H[2J');
    try {
      return await choose(...args);
    } finally {
      process.stdin.resume();
      process.stdin.setRawMode(true);
      keys.attach();
    }
  };

  const restore = () => {
    keys.detach();
    process.stdin.setRawMode(Boolean(wasRaw));
    process.stdin.pause();
    process.stdout.write('[?25h');
  };

  try {
    while (true) {
      render();
      const { input, key } = await keys.read();
      note = '';
      const shown = visible();
      const row = shown[cursor];

      if (key.ctrl && key.name === 'c') {
        restore();
        console.clear();
        console.log('No changes saved.');
        process.exitCode = 130;
        return;
      }

      if (typing) {
        if (key.name === 'return' || key.name === 'enter') typing = false;
        else if (key.name === 'escape') { filter = ''; typing = false; }
        else if (key.name === 'backspace') filter = filter.slice(0, -1);
        else if (input && !key.ctrl && !key.meta && input >= ' ') filter += input;
        continue;
      }

      if (key.name === 'up') cursor = Math.max(0, cursor - 1);
      else if (key.name === 'down') cursor = Math.min(shown.length - 1, cursor + 1);
      else if (key.name === 'left') field = Math.max(0, field - 1);
      else if (key.name === 'right') field = Math.min(FIELDS.length - 1, field + 1);
      else if (key.name === 'home') cursor = 0;
      else if (key.name === 'end') cursor = shown.length - 1;
      else if (input === '/') { typing = true; filter = ''; }
      else if (row && (input === ' ' || key.name === 'space')) {
        const name = row.kind !== 'route' ? row.kind : FIELDS[field];
        const options = fieldOptions(base, effective, row, name);
        const next = options[(options.indexOf(rowValue(effective, row, name)) + 1) % options.length];
        changeValue(row, name, next);
      } else if (row && (key.name === 'return' || key.name === 'enter')) {
        const name = row.kind !== 'route' ? row.kind : FIELDS[field];
        const current = rowValue(effective, row, name);
        const fallbackDefault = getPath(base, row.kind !== 'route' ? row.path : `${row.path}.${name}`);
        const options = fieldOptions(base, effective, row, name);
        const items = name === 'model'
          ? modelChoices(base, effective, getPath(effective, `${row.path}.agent`), current, fallbackDefault)
          : options.map((value) => ({
            name: `${row.kind === 'provider' ? (value ? 'ON' : 'OFF') : value}${optionTag(value, current, fallbackDefault)}`,
            value,
            description: row.kind === 'provider' ? 'OFF excludes this provider from future route resolutions; saved routes are preserved.'
              : name === 'effort' ? EFFORT_NOTES[value] : name === 'agent' ? `Provider family: ${base.families[value]}` : '',
          }));
        const picked = await pick(`${row.group}${row.slot ? ` · ${row.slot}` : ''} · ${name}`, items, current);
        if (picked !== BACK) {
          changeValue(row, name, picked);
        }
      } else if (row && input === 'r') {
        resetRow(base, effective, row);
        note = `${row.group}${row.slot ? ` · ${row.slot}` : ''} restored to the installed default.`;
      } else if (input === 'R') {
        const confirmed = await pick('Restore every installed default?', [
          { name: 'No, keep my changes', value: false },
          { name: 'Yes, clear all overrides', value: true },
        ], false);
        if (confirmed === true) {
          for (const key of Object.keys(effective)) delete effective[key];
          Object.assign(effective, clone(base));
          note = 'All overrides cleared.';
        }
      } else if (input === 's') {
        const overrides = sparseOverrides(base, effective);
        writeOverrides(overrides);
        restore();
        console.clear();
        console.log(`Saved ${Object.keys(overrides).length} override(s).`);
        console.log(`  ${configPath}`);
        console.log('\nStart a new Lead session after changing its route.');
        return;
      } else if (input === 'q' || key.name === 'escape') {
        if (filter) { filter = ''; continue; }
        const pending = sparseOverrides(base, effective);
        const saved = fs.existsSync(configPath) ? readOverrides(base).overrides : {};
        const same = (map) => JSON.stringify(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
        if (same(pending) !== same(saved)) {
          const confirmed = await pick('Discard unsaved changes?', [
            { name: 'No, keep editing', value: false },
            { name: 'Yes, discard and quit', value: true },
          ], false);
          if (confirmed !== true) continue;
        }
        restore();
        console.clear();
        console.log('No changes saved.');
        return;
      }
    }
  } catch (error) {
    restore();
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
  if (args.length === 1 && args[0] === 'provider') return showProviders();
  if (args.length === 3 && args[0] === 'provider') return setProvider(args[1], args[2]);
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

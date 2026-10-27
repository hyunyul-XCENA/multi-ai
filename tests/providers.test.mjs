import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'multi-ai-cli.mjs');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-ai-providers-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function config() {
  return fs.mkdtempSync(path.join(scratch, 'host-'));
}

function cli(home, ...args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, MULTI_AI_CONFIG_HOME: home },
  });
  assert.ifError(result.error);
  return result;
}

function ok(home, ...args) {
  const result = cli(home, ...args);
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result;
}

function overrides(home) {
  return parse(fs.readFileSync(path.join(home, 'policy.yaml'), 'utf8')).overrides;
}

function route(home, target, ...args) {
  return JSON.parse(ok(home, 'route', target, ...args, '--json').stdout);
}

test('switches preserve every saved preference and restore original resolution', () => {
  const home = config();
  assert.equal(ok(home, 'provider').stdout, 'codex: ON\nclaude: ON\n');
  ok(home, 'set', 'roles.architect.primary.model', 'claude-custom');
  ok(home, 'set', 'roles.engineer.primary.model', 'codex-custom');
  const saved = overrides(home);
  const original = route(home, 'architect');

  ok(home, 'provider', 'claude', 'off');
  assert.equal(ok(home, 'provider').stdout, 'codex: ON\nclaude: OFF\n');
  assert.deepEqual(overrides(home), { ...saved, 'providers.claude.enabled': false });
  assert.equal(route(home, 'architect').model, 'codex-custom');
  assert.equal(ok(home, 'get', 'roles.architect.primary.model').stdout.trim(), 'claude-custom');
  assert.match(ok(home, 'diff').stdout, /providers\.claude\.enabled: true -> false/);

  ok(home, 'provider', 'claude', 'on');
  assert.deepEqual(overrides(home), saved);
  const restored = route(home, 'architect');
  assert.equal(restored.agent, original.agent);
  assert.equal(restored.model, original.model);
  assert.deepEqual(restored.disabled_providers, []);
});

for (const disabled of ['claude', 'codex']) {
  test(`${disabled} OFF excludes it from every role, review and competition ladder`, () => {
    const home = config();
    ok(home, 'provider', disabled, 'off');
    const enabled = disabled === 'claude' ? 'codex' : 'claude';
    const targets = ['lead', 'architect', 'engineer', 'researcher', 'competition-primary', 'competition-alternate'];
    for (const maker of ['openai', 'anthropic']) {
      const selected = route(home, 'reviewer', '--maker-family', maker);
      assert.equal(selected.agent, enabled);
      const expectedIndependent = (enabled === 'codex' ? 'openai' : 'anthropic') !== maker;
      assert.equal(selected.independent_of_maker, expectedIndependent);
      if (!expectedIndependent) assert.match(selected.notes.join('\n'), /Same family as the maker/);
      const ladder = ok(home, 'route', 'reviewer', '--maker-family', maker, '--ladder');
      assert.doesNotMatch(ladder.stdout, new RegExp(`--agent ${disabled}`));
    }
    for (const target of targets) {
      const selected = route(home, target);
      assert.equal(selected.agent, enabled, target);
      assert.deepEqual(selected.disabled_providers, [disabled]);
      assert.match(selected.notes.join('\n'), /OFF by host policy/);
      assert.doesNotMatch(ok(home, 'route', target, '--ladder').stdout, new RegExp(`--agent ${disabled}`));
    }
  });
}

test('provider filtering preserves rung provenance and never returns an earlier failed rung', () => {
  const home = config();
  ok(home, 'provider', 'claude', 'off');
  const reviewer = route(home, 'reviewer', '--maker-family', 'openai');
  assert.equal(reviewer.step, 'same_family_fallback');
  assert.equal(reviewer.requested_step, 'primary');
  assert.equal(reviewer.source_group, 'roles.reviewer.by_maker_family.openai');
  const architect = route(home, 'architect');
  assert.equal(architect.source_group, 'roles.engineer');
  assert.match(architect.notes.join('\n'), /No enabled routes for architect/);
  assert.equal(route(home, 'competition-alternate').source_group, 'competition.lanes.primary_family');
  const unavailableFallback = cli(home, 'route', 'engineer', '--step', 'fallback');
  assert.equal(unavailableFallback.status, 1);
  assert.equal(unavailableFallback.stdout, '');
  assert.match(unavailableFallback.stderr, /No enabled fallback or later route/);
});

test('a disabled reviewer ladder fails rather than borrowing a different role', () => {
  const home = config();
  ok(home, 'set', 'roles.reviewer.by_maker_family.openai.same_family_fallback.agent', 'claude');
  ok(home, 'set', 'roles.reviewer.by_maker_family.openai.same_family_fallback.model', 'claude-custom');
  ok(home, 'provider', 'claude', 'off');
  for (const extra of [[], ['--ladder'], ['--json']]) {
    const result = cli(home, 'route', 'reviewer', '--maker-family', 'openai', ...extra);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /No enabled/);
  }
});

test('the last provider cannot be disabled through either command and errors do not write', () => {
  const home = config();
  ok(home, 'provider', 'claude', 'off');
  const before = fs.readFileSync(path.join(home, 'policy.yaml'), 'utf8');
  for (const args of [
    ['provider', 'codex', 'off'],
    ['set', 'providers.codex.enabled', 'false'],
    ['provider', 'unknown', 'off'],
    ['provider', 'claude', 'maybe'],
    ['set', 'providers.codex.enabled', '0'],
  ]) {
    assert.equal(cli(home, ...args).status, 1, args.join(' '));
    assert.equal(fs.readFileSync(path.join(home, 'policy.yaml'), 'utf8'), before);
  }
  ok(home, 'unset', 'providers');
  assert.equal(ok(home, 'provider').stdout, 'codex: ON\nclaude: ON\n');
  ok(home, 'provider', 'codex', 'off');
  ok(home, 'reset');
  assert.deepEqual(overrides(home), {});
});

test('hand-edited all-OFF policies fail closed and can be repaired with provider on', () => {
  const home = config();
  fs.writeFileSync(path.join(home, 'policy.yaml'), stringify({ version: 2, overrides: {
    'providers.codex.enabled': false, 'providers.claude.enabled': false,
  } }));
  const result = cli(home, 'route', 'engineer');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Keep at least one provider ON/);
  ok(home, 'provider', 'codex', 'on');
  assert.equal(route(home, 'engineer').agent, 'codex');
});

test('legacy host preferences migrate while preserving the provider switch', () => {
  const home = config();
  fs.writeFileSync(path.join(home, 'policy.yaml'), stringify({ version: 1, role_families: { engineer: 'claude' } }));
  assert.equal(route(home, 'engineer').agent, 'claude');
  ok(home, 'provider', 'claude', 'off');
  assert.equal(route(home, 'engineer').agent, 'codex');
  ok(home, 'provider', 'claude', 'on');
  assert.equal(route(home, 'engineer').agent, 'claude');
});

// Exercise the actual TUI key handler with pipes marked as a terminal. No real
// console or provider is launched, and every edit uses a temporary host policy.
const ttyShim = path.join(scratch, 'tty.cjs');
fs.writeFileSync(ttyShim, `
Object.defineProperty(process.stdin, 'isTTY', { value: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true });
Object.defineProperty(process.stdout, 'columns', { value: 100 });
Object.defineProperty(process.stdout, 'rows', { value: 32 });
process.stdin.setRawMode = (value) => { process.stdin.isRaw = value; };
`);

async function tui(home, steps, expectedStatus = 0) {
  const child = spawn(process.execPath, ['--require', ttyShim, script, 'tui'], {
    env: { ...process.env, MULTI_AI_CONFIG_HOME: home, NO_COLOR: '1' }, windowsHide: true,
  });
  let output = '';
  let stderr = '';
  let index = 0;
  let frame = '';
  let error;
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    output += chunk;
    frame += chunk;
    const step = steps[index];
    if (!step || !frame.includes(step.see)) return;
    frame = '';
    index += 1;
    child.stdin.write(step.send);
  });
  const timer = setTimeout(() => { error = new Error(`TUI timed out at step ${index}: ${output}`); child.kill(); }, 10000);
  try {
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (error) throw error;
    assert.equal(status, expectedStatus, stderr);
    assert.equal(index, steps.length);
    return output;
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
  }
}

test('an open TUI saves provider toggles and rejects switching the last provider OFF', async () => {
  const home = config();
  const output = await tui(home, [
    { see: 'codex ON · claude ON', send: '\x1b[B' },
    { see: '> claude', send: ' ' },
    { see: 'codex ON · claude OFF', send: '\x1b[A' },
    { see: '> codex', send: ' ' },
    { see: 'Keep at least one provider ON.', send: 's' },
  ]);
  assert.match(output, /Saved 1 override/);
  assert.deepEqual(overrides(home), { 'providers.claude.enabled': false });
});

test('an open TUI discards toggles on Ctrl-C and can restore both providers with R', async () => {
  const home = config();
  await tui(home, [
    { see: 'codex ON · claude ON', send: ' ' },
    { see: 'codex OFF · claude ON', send: '\x03' },
  ], 130);
  assert.equal(fs.existsSync(path.join(home, 'policy.yaml')), false);
  ok(home, 'provider', 'claude', 'off');
  await tui(home, [
    { see: 'codex ON · claude OFF', send: 'R' },
    { see: 'Restore every installed default?', send: '\x1b[B\r' },
    { see: 'All overrides cleared.', send: 's' },
  ]);
  assert.deepEqual(overrides(home), {});
});

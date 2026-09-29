// Tests for `multi-ai-cli context` (lib/context.mjs). Node built-ins only.
// Run with `npm test`. Set MULTI_AI_CONTEXT_ROOT to also pack an extra policy
// root, such as an edited parent checkout.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildManifest,
  bundleDigest,
  cliProvenance,
  ContextError,
  normalizeText,
  packContext,
  readPolicy,
  stripFrontmatter,
} from '../lib/context.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'multi-ai-cli.mjs');
const contextModulePath = path.join(repoRoot, 'lib', 'context.mjs');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-ai-context-test-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function tempDir(label) {
  counter += 1;
  const dir = path.join(scratch, `${label}-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const posix = (value) => value.split(path.sep).join('/');

const FIXTURE = {
  'SKILL.md': '---\nname: multi-ai\ndescription: fixture\n---\n\n# Core\n\nCore rule. See [Lead workflow](references/lead-workflow.md#start) and [Review](prompts/review.md).\nOutside link: [readme](../README.md).\n',
  'policy.yaml': 'version: 1\nlead:\n  primary: codex\n',
  'codex-profile.toml': 'model = "x"\n',
  'roles/engineer.md': '# Engineer\n\nENGINEER-ROLE-BODY. Result schema: [worker](../schemas/worker-result.schema.json).\n',
  'roles/reviewer.md': '# Reviewer\n\nREVIEWER-ROLE-BODY.\n',
  'roles/architect.md': '# Architect\n\nARCHITECT-ROLE-BODY.\n',
  'roles/researcher.md': '# Researcher\n\nRESEARCHER-ROLE-BODY.\n',
  'roles/lead.md': '# Lead\n\nLEAD-ROLE-BODY.\n',
  'prompts/review.md': '# Review prompt\n\nREVIEW-PROMPT-BODY.\n',
  'prompts/dispatch.md': '# Dispatch prompt\n\nDISPATCH-PROMPT-BODY.\n',
  'references/lead-workflow.md': '# Lead workflow\n\nLEAD-WORKFLOW-BODY.\n',
  'references/deep/extra.md': '# Nested reference\n',
  'schemas/worker-result.schema.json': '{\n  "title": "WORKER-SCHEMA-BODY"\n}\n',
  'schemas/review-result.schema.json': '{\n  "title": "REVIEW-SCHEMA-BODY"\n}\n',
  // Not part of the manifest set: wrong extension or outside the listed trees.
  'README.md': 'not collected\n',
  'roles/notes.txt': 'not collected\n',
  'examples/simple.md': 'not collected\n',
};

function writeTree(dir, files, { crlf = false } = {}) {
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(dir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, crlf ? text.replace(/\n/g, '\r\n') : text);
  }
  return dir;
}

function fixture(options) {
  return writeTree(tempDir('root'), FIXTURE, options);
}

function taskFile(text = 'Implement the thing.\n') {
  const file = path.join(tempDir('task'), 'task.md');
  fs.writeFileSync(file, text);
  return file;
}

function reportPath(name = 'report.json') {
  return path.join(tempDir('report'), name);
}

function pack(overrides = {}) {
  return packContext({
    root: overrides.root ?? fixture(),
    out: overrides.out ?? tempDir('out'),
    role: overrides.role ?? 'engineer',
    taskFile: overrides.taskFile ?? taskFile(),
    reportPath: overrides.reportPath ?? reportPath(),
  });
}

function cli(args, { script = cliPath, ...options } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MULTI_AI_CONFIG_HOME: path.join(scratch, 'config-home') },
    ...options,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function cliAsync(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, MULTI_AI_CONFIG_HOME: path.join(scratch, 'config-home') },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// Symlinks need a privilege on some Windows hosts; skip only those cases.
function trySymlink(target, linkPath, type) {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return false;
    throw error;
  }
}

// Replaces one fs function while run() executes. lib/context.mjs looks fs
// functions up at call time, so this injects faults deterministically.
function withFs(name, makeReplacement, run) {
  const original = fs[name];
  fs[name] = makeReplacement(original);
  try {
    return run();
  } finally {
    fs[name] = original;
  }
}

function failWith(code) {
  return () => {
    throw Object.assign(new Error(`simulated ${code}`), { code });
  };
}

function listAll(dir) {
  const out = [];
  const visit = (current, relative) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      out.push(child);
      if (entry.isDirectory()) visit(path.join(current, entry.name), child);
    }
  };
  visit(dir, '');
  return out.sort();
}

describe('manifest', () => {
  test('collects exactly the policy set, bytewise sorted', () => {
    const manifest = buildManifest(fixture());
    assert.deepEqual(manifest.files.map((file) => file.path), [
      'SKILL.md',
      'codex-profile.toml',
      'policy.yaml',
      'prompts/dispatch.md',
      'prompts/review.md',
      'references/deep/extra.md',
      'references/lead-workflow.md',
      'roles/architect.md',
      'roles/engineer.md',
      'roles/lead.md',
      'roles/researcher.md',
      'roles/reviewer.md',
      'schemas/review-result.schema.json',
      'schemas/worker-result.schema.json',
    ]);
  });

  test('digest follows the documented path + NUL + hex + LF rule', () => {
    const manifest = buildManifest(fixture());
    const expected = sha256(manifest.files.map((file) => `${file.path}\0${file.sha256}\n`).join(''));
    assert.equal(manifest.digest, expected);
    assert.equal(bundleDigest(manifest.files), expected);
    const skill = manifest.files.find((file) => file.path === 'SKILL.md');
    assert.equal(skill.sha256, sha256(FIXTURE['SKILL.md']));
  });

  test('digest is stable across roots and CRLF/LF checkouts', () => {
    const lf = buildManifest(fixture());
    const crlf = buildManifest(fixture({ crlf: true }));
    assert.notEqual(lf.root, crlf.root);
    assert.equal(lf.digest, crlf.digest);
    assert.deepEqual(lf.files, crlf.files);
  });

  test('lone CR is normalized, BOM and other bytes are content', () => {
    assert.equal(normalizeText(Buffer.from('a\rb\r\nc\n'), 'x'), 'a\nb\nc\n');
    const root = fixture();
    const before = buildManifest(root).digest;
    fs.writeFileSync(path.join(root, 'policy.yaml'), `﻿${FIXTURE['policy.yaml']}`);
    assert.notEqual(buildManifest(root).digest, before);
  });

  test('provenance is recorded but not part of the digest', () => {
    const root = fixture();
    const one = buildManifest(root, { cli_version: '1', cli_sha256: 'a' });
    const two = buildManifest(root, { cli_version: '2', cli_sha256: 'b' });
    assert.equal(one.digest, two.digest);
    assert.equal(one.provenance.cli_version, '1');
    assert.match(one.provenance.note, /does not prove/);
  });

  test('CLI records wrapper and context module hashes as provenance', () => {
    const result = cli(['context', 'manifest', '--root', fixture(), '--json']);
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.provenance.cli_sha256, sha256(fs.readFileSync(cliPath)));
    assert.equal(json.provenance.cli_path, posix(fs.realpathSync(cliPath)));
    assert.equal(json.provenance.context_module_sha256, sha256(fs.readFileSync(contextModulePath)));
    assert.equal(json.provenance.context_module_path, posix(fs.realpathSync(contextModulePath)));
    assert.notEqual(json.provenance.context_module_sha256, json.provenance.cli_sha256);
    assert.match(json.provenance.cli_version, /^\d+\.\d+\.\d+$/);
    assert.equal(json.drift, false);

    const library = cliProvenance(undefined, undefined);
    assert.equal(library.cli_sha256, null);
    assert.equal(library.context_module_sha256, sha256(fs.readFileSync(contextModulePath)));
  });

  test('a change confined to lib/context.mjs changes only the module hash', (t) => {
    // Runs the CLI from a copy whose module differs by one comment: the wrapper
    // hash and the policy digest stay, the module hash follows the module bytes.
    const copy = tempDir('cli-copy');
    for (const name of ['multi-ai-cli.mjs', 'policy.yaml', 'package.json']) {
      fs.copyFileSync(path.join(repoRoot, name), path.join(copy, name));
    }
    fs.mkdirSync(path.join(copy, 'lib'));
    const copiedModule = path.join(copy, 'lib', 'context.mjs');
    fs.writeFileSync(copiedModule, Buffer.concat([fs.readFileSync(contextModulePath), Buffer.from('// provenance probe\n')]));
    if (!trySymlink(path.join(repoRoot, 'node_modules'), path.join(copy, 'node_modules'), 'junction')) {
      return t.skip('symlinks unavailable');
    }
    const root = fixture();
    const original = JSON.parse(cli(['context', 'manifest', '--root', root, '--json']).stdout);
    const result = cli(['context', 'manifest', '--root', root, '--json'], { script: path.join(copy, 'multi-ai-cli.mjs') });
    assert.equal(result.status, 0, result.stderr);
    const changed = JSON.parse(result.stdout);
    assert.equal(changed.provenance.cli_sha256, original.provenance.cli_sha256);
    assert.equal(changed.provenance.context_module_sha256, sha256(fs.readFileSync(copiedModule)));
    assert.notEqual(changed.provenance.context_module_sha256, original.provenance.context_module_sha256);
    assert.equal(changed.provenance.context_module_path, posix(fs.realpathSync(copiedModule)));
    assert.equal(changed.digest, original.digest, 'policy digest ignores implementation identity');
  });

  test('missing required files and directories fail', () => {
    for (const [remove, message] of [
      ['SKILL.md', /Required policy file missing: SKILL\.md/],
      ['policy.yaml', /policy\.yaml/],
      ['codex-profile.toml', /codex-profile\.toml/],
      ['roles', /Required policy directory missing: roles\//],
      ['schemas', /Required policy directory missing: schemas\//],
    ]) {
      const root = fixture();
      fs.rmSync(path.join(root, remove), { recursive: true });
      assert.throws(() => readPolicy(root), message, remove);
    }
    const root = fixture();
    for (const name of fs.readdirSync(path.join(root, 'schemas'))) fs.rmSync(path.join(root, 'schemas', name));
    assert.throws(() => readPolicy(root), /no \*\.json files: schemas\//);
  });

  test('optional prompts/ and references/ may be absent', () => {
    const root = fixture();
    fs.rmSync(path.join(root, 'references'), { recursive: true });
    fs.rmSync(path.join(root, 'prompts'), { recursive: true });
    const manifest = buildManifest(root);
    assert.ok(!manifest.files.some((file) => /^(prompts|references)\//.test(file.path)));
  });

  test('invalid UTF-8 and missing roots fail', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'roles', 'engineer.md'), Buffer.from([0x23, 0xff, 0xfe, 0x0a]));
    assert.throws(() => readPolicy(root), /roles\/engineer\.md is not valid UTF-8/);
    assert.throws(() => readPolicy(path.join(scratch, 'does-not-exist')), /Policy root not found/);
    assert.throws(() => readPolicy(''), /--root is required/);
  });

  test('a symlinked root is canonicalized to its real path', (t) => {
    const root = fixture();
    const link = path.join(tempDir('link'), 'skill');
    if (!trySymlink(root, link, 'junction')) return t.skip('symlinks unavailable');
    const direct = buildManifest(root);
    const linked = buildManifest(link);
    assert.equal(linked.digest, direct.digest);
    assert.equal(linked.root, posix(fs.realpathSync(root)));
    assert.equal(linked.requested_root, posix(link));
  });

  test('child symlinks inside the root are allowed', (t) => {
    const root = fixture();
    const before = buildManifest(root).digest;
    fs.renameSync(path.join(root, 'roles', 'lead.md'), path.join(root, 'lead-real.md'));
    if (!trySymlink(path.join(root, 'lead-real.md'), path.join(root, 'roles', 'lead.md'), 'file')) {
      return t.skip('symlinks unavailable');
    }
    assert.equal(buildManifest(root).digest, before);
  });

  test('child symlinks escaping the root are rejected', (t) => {
    const outside = tempDir('outside');
    fs.writeFileSync(path.join(outside, 'evil.md'), '# evil\n');

    const fileRoot = fixture();
    if (!trySymlink(path.join(outside, 'evil.md'), path.join(fileRoot, 'roles', 'evil.md'), 'file')) {
      return t.skip('symlinks unavailable');
    }
    assert.throws(() => readPolicy(fileRoot), /roles\/evil\.md resolves outside the policy root/);

    const dirRoot = fixture();
    assert.ok(trySymlink(outside, path.join(dirRoot, 'references', 'ext'), 'junction'));
    assert.throws(() => readPolicy(dirRoot), /references\/ext resolves outside the policy root/);

    const topRoot = fixture();
    fs.rmSync(path.join(topRoot, 'SKILL.md'));
    assert.ok(trySymlink(path.join(outside, 'evil.md'), path.join(topRoot, 'SKILL.md'), 'file'));
    assert.throws(() => readPolicy(topRoot), /SKILL\.md resolves outside the policy root/);

    const treeRoot = fixture();
    fs.rmSync(path.join(treeRoot, 'schemas'), { recursive: true });
    const schemasOutside = writeTree(tempDir('schemas'), { 'x.json': '{}\n' });
    assert.ok(trySymlink(schemasOutside, path.join(treeRoot, 'schemas'), 'junction'));
    assert.throws(() => readPolicy(treeRoot), /schemas\/ resolves outside the policy root/);
  });

  test('traversal through a symlinked parent (..) is rejected', (t) => {
    const parent = tempDir('parent');
    const root = writeTree(path.join(parent, 'skill'), FIXTURE);
    fs.writeFileSync(path.join(parent, 'sibling.md'), '# sibling\n');
    if (!trySymlink(path.join(root, '..'), path.join(root, 'references', 'up'), 'junction')) {
      return t.skip('symlinks unavailable');
    }
    assert.throws(() => readPolicy(root), /references\/up resolves outside the policy root/);
  });

  test('directory alias cycles are rejected', (t) => {
    const root = fixture();
    if (!trySymlink(path.join(root, 'references'), path.join(root, 'references', 'deep', 'loop'), 'junction')) {
      return t.skip('symlinks unavailable');
    }
    assert.throws(() => readPolicy(root), /Symlink cycle at references\/deep\/loop\//);
  });

  test('broken symlinks fail instead of being skipped', (t) => {
    const root = fixture();
    if (!trySymlink(path.join(root, 'nowhere.md'), path.join(root, 'roles', 'ghost.md'), 'file')) {
      return t.skip('symlinks unavailable');
    }
    assert.throws(() => readPolicy(root), /Cannot resolve roles\/ghost\.md/);
  });
});

describe('manifest --compare drift', () => {
  test('matching roots exit 0', () => {
    const result = cli(['context', 'manifest', '--root', fixture(), '--compare', fixture({ crlf: true }), '--json']);
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.drift, false);
    assert.equal(json.comparisons[0].matches, true);
  });

  test('changed, added and removed files exit 1 with details', () => {
    const base = fixture();
    const changed = fixture();
    fs.appendFileSync(path.join(changed, 'roles', 'engineer.md'), 'drift\n');
    fs.writeFileSync(path.join(changed, 'prompts', 'new.md'), '# new\n');
    fs.rmSync(path.join(changed, 'prompts', 'dispatch.md'));
    const same = fixture();

    const result = cli(['context', 'manifest', '--root', base, '--compare', same, '--compare', changed, '--json']);
    assert.equal(result.status, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json.drift, true);
    assert.equal(json.comparisons.length, 2);
    assert.equal(json.comparisons[0].matches, true);
    const drift = json.comparisons[1];
    assert.equal(drift.matches, false);
    assert.deepEqual(drift.changed.map((entry) => entry.path), ['roles/engineer.md']);
    assert.deepEqual(drift.only_in_compare, ['prompts/new.md']);
    assert.deepEqual(drift.only_in_root, ['prompts/dispatch.md']);

    const text = cli(['context', 'manifest', '--root', base, '--compare', changed]);
    assert.equal(text.status, 1);
    assert.match(text.stdout, /DRIFT/);
    assert.match(text.stdout, /changed: +roles\/engineer\.md/);
  });

  test('an unreadable compare root is an error, not a match', () => {
    const result = cli(['context', 'manifest', '--root', fixture(), '--compare', path.join(scratch, 'missing-root')]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Policy root not found/);
  });
});

describe('pack', () => {
  test('engineer packet holds only core, its role and the task', () => {
    const root = fixture();
    const result = pack({ root, role: 'engineer' });
    const packet = fs.readFileSync(result.packet_path, 'utf8');

    assert.match(packet, /# Core\n\nCore rule\./);
    assert.doesNotMatch(packet, /^name: multi-ai/m, 'frontmatter stripped');
    assert.match(packet, /ENGINEER-ROLE-BODY/);
    for (const absent of [
      'REVIEWER-ROLE-BODY', 'ARCHITECT-ROLE-BODY', 'RESEARCHER-ROLE-BODY', 'LEAD-ROLE-BODY',
      'REVIEW-PROMPT-BODY', 'DISPATCH-PROMPT-BODY', 'LEAD-WORKFLOW-BODY',
      'WORKER-SCHEMA-BODY', 'REVIEW-SCHEMA-BODY',
    ]) assert.ok(!packet.includes(absent), `${absent} must not be inlined`);
    assert.match(packet, /Implement the thing\./);
    assert.match(packet, /grants no authority/);

    const snapshotFiles = posix(path.join(result.snapshot_dir, 'files'));
    assert.equal(result.schema.path, `${snapshotFiles}/schemas/worker-result.schema.json`);
    assert.equal(result.schema.sha256, sha256(FIXTURE['schemas/worker-result.schema.json']));
    assert.ok(packet.includes(`- Result schema: ${result.schema.path} (sha256:${result.schema.sha256})`));
    assert.equal(result.packet_sha256, sha256(fs.readFileSync(result.packet_path)));
    assert.equal(path.basename(result.packet_path), `packet-engineer-${result.packet_sha256}.md`);
  });

  test('reviewer packet adds prompts/review.md and the review schema', () => {
    const result = pack({ role: 'reviewer' });
    const packet = fs.readFileSync(result.packet_path, 'utf8');
    assert.match(packet, /REVIEWER-ROLE-BODY/);
    assert.match(packet, /REVIEW-PROMPT-BODY/);
    assert.ok(!packet.includes('ENGINEER-ROLE-BODY'));
    assert.ok(!packet.includes('REVIEW-SCHEMA-BODY'));
    assert.match(result.schema.path, /\/schemas\/review-result\.schema\.json$/);
  });

  test('architect and researcher packets use the worker schema', () => {
    for (const role of ['architect', 'researcher']) {
      const result = pack({ role });
      assert.match(result.schema.path, /\/schemas\/worker-result\.schema\.json$/);
      assert.match(fs.readFileSync(result.packet_path, 'utf8'), new RegExp(`${role.toUpperCase()}-ROLE-BODY`));
    }
  });

  test('relative policy links point at absolute snapshot paths', () => {
    const result = pack({ role: 'engineer' });
    const packet = fs.readFileSync(result.packet_path, 'utf8');
    const files = posix(path.join(result.snapshot_dir, 'files'));
    assert.ok(packet.includes(`](${files}/references/lead-workflow.md#start)`) || packet.includes(`](<${files}/references/lead-workflow.md#start>)`));
    assert.ok(packet.includes(`${files}/schemas/worker-result.schema.json)`) || packet.includes(`${files}/schemas/worker-result.schema.json>)`));
    assert.ok(!packet.includes('](references/'));
    assert.ok(result.notes.some((note) => note.includes('../README.md')), 'unresolvable link is reported');
  });

  test('snapshot holds the normalized policy set and is reused after verification', () => {
    const root = fixture({ crlf: true });
    const out = tempDir('out');
    const first = pack({ root, out });
    assert.equal(first.snapshot_created, true);
    assert.equal(first.packet_created, true);
    const skillCopy = fs.readFileSync(path.join(first.snapshot_dir, 'files', 'SKILL.md'), 'utf8');
    assert.equal(skillCopy, FIXTURE['SKILL.md']);
    const manifest = JSON.parse(fs.readFileSync(path.join(first.snapshot_dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.digest, first.policy_digest);
    assert.equal(path.basename(first.snapshot_dir), `policy-${first.policy_digest}`);

    const task = taskFile();
    const report = reportPath();
    const a = pack({ root, out, taskFile: task, reportPath: report });
    const b = pack({ root, out, taskFile: task, reportPath: report });
    assert.equal(a.snapshot_created, false);
    assert.equal(b.packet_created, false);
    assert.equal(a.packet_path, b.packet_path);
    assert.ok(!fs.readdirSync(out).some((name) => name.startsWith('.')), 'no staging leftovers');
  });

  test('source edits after packing never change the existing snapshot', () => {
    const root = fixture();
    const out = tempDir('out');
    const first = pack({ root, out });
    fs.appendFileSync(path.join(root, 'roles', 'engineer.md'), 'new rule\n');
    const second = pack({ root, out });
    assert.notEqual(second.policy_digest, first.policy_digest);
    assert.notEqual(second.snapshot_dir, first.snapshot_dir);
    assert.equal(fs.readFileSync(path.join(first.snapshot_dir, 'files', 'roles', 'engineer.md'), 'utf8'), FIXTURE['roles/engineer.md']);
    assert.ok(fs.existsSync(first.packet_path));
  });

  test('tampered snapshots are rejected and left untouched', () => {
    const cases = [
      ['content', (dir) => fs.appendFileSync(path.join(dir, 'files', 'SKILL.md'), 'tampered\n'), /content differs: files\/SKILL\.md/],
      ['extra', (dir) => fs.writeFileSync(path.join(dir, 'files', 'roles', 'extra.md'), 'x'), /unexpected file files\/roles\/extra\.md/],
      ['missing', (dir) => fs.rmSync(path.join(dir, 'files', 'policy.yaml')), /missing files\/policy\.yaml/],
      ['manifest', (dir) => fs.appendFileSync(path.join(dir, 'manifest.json'), ' '), /manifest\.json differs/],
    ];
    for (const [label, tamper, message] of cases) {
      const root = fixture();
      const out = tempDir('out');
      const { snapshot_dir: dir } = pack({ root, out });
      tamper(dir);
      const before = listAll(dir).map((relative) => {
        const full = path.join(dir, relative);
        return [relative, fs.statSync(full).isFile() ? sha256(fs.readFileSync(full)) : 'dir'];
      });
      assert.throws(() => pack({ root, out }), (error) => error instanceof ContextError && message.test(error.message), label);
      const afterState = listAll(dir).map((relative) => {
        const full = path.join(dir, relative);
        return [relative, fs.statSync(full).isFile() ? sha256(fs.readFileSync(full)) : 'dir'];
      });
      assert.deepEqual(afterState, before, `${label}: snapshot unchanged`);
    }
  });

  test('snapshot entries redirected through links are rejected even with identical bytes', (t) => {
    const redirect = (dir, relative, type) => {
      const original = path.join(dir, ...relative.split('/'));
      const copy = path.join(tempDir('redirect'), path.basename(original));
      fs.cpSync(original, copy, { recursive: true });
      fs.rmSync(original, { recursive: true });
      return trySymlink(copy, original, type);
    };
    const cases = [
      ['files/', 'junction', /files\/ is not a plain directory \(link\)/],
      ['files/roles', 'junction', /unexpected non-file entry files\/roles/],
      ['files/SKILL.md', 'file', /unexpected non-file entry files\/SKILL\.md/],
      ['manifest.json', 'file', /manifest\.json is not a regular file \(link\)/],
      ['provenance.json', 'file', /provenance\.json is not a regular file \(link\)/],
    ];
    for (const [relative, type, message] of cases) {
      const root = fixture();
      const out = tempDir('out');
      const { snapshot_dir: dir } = pack({ root, out });
      if (!redirect(dir, relative.replace(/\/$/, ''), type)) return t.skip('symlinks unavailable');
      assert.throws(() => pack({ root, out }), message, relative);
      assert.equal(fs.lstatSync(path.join(dir, ...relative.replace(/\/$/, '').split('/'))).isSymbolicLink(), true, `${relative} left in place`);
    }
  });

  test('unexpected or missing top-level snapshot entries are rejected', () => {
    const cases = [
      ['extra', (dir) => fs.writeFileSync(path.join(dir, 'notes.txt'), 'x'), /unexpected entry notes\.txt/],
      ['no provenance', (dir) => fs.rmSync(path.join(dir, 'provenance.json')), /provenance\.json missing/],
      ['wrong provenance', (dir) => fs.writeFileSync(path.join(dir, 'provenance.json'), '{"policy_digest":"0"}'), /does not record this policy digest/],
      ['no files', (dir) => fs.rmSync(path.join(dir, 'files'), { recursive: true }), /files\/ missing/],
    ];
    for (const [label, tamper, message] of cases) {
      const root = fixture();
      const out = tempDir('out');
      const { snapshot_dir: dir } = pack({ root, out });
      tamper(dir);
      assert.throws(() => pack({ root, out }), message, label);
    }
  });

  test('an empty directory or dangling link at the snapshot name is not replaced', (t) => {
    const root = fixture();
    const digest = readPolicy(root).digest;

    const emptyOut = tempDir('out');
    const empty = path.join(emptyOut, `policy-${digest}`);
    fs.mkdirSync(empty);
    assert.throws(() => pack({ root, out: emptyOut }), /refusing to reuse or overwrite[\s\S]*manifest\.json missing/);
    assert.deepEqual(fs.readdirSync(empty), []);
    assert.deepEqual(fs.readdirSync(emptyOut), [`policy-${digest}`], 'no staging leftovers');

    const linkOut = tempDir('out');
    const dangling = path.join(linkOut, `policy-${digest}`);
    if (!trySymlink(path.join(linkOut, 'gone'), dangling, 'junction')) return t.skip('symlinks unavailable');
    assert.throws(() => pack({ root, out: linkOut }), /Existing snapshot is not a plain directory/);
    assert.equal(fs.lstatSync(dangling).isSymbolicLink(), true);
  });

  test('a pre-existing non-snapshot entry at the snapshot name is not replaced', () => {
    const root = fixture();
    const out = tempDir('out');
    const digest = readPolicy(root).digest;
    const squatter = path.join(out, `policy-${digest}`);
    fs.mkdirSync(squatter);
    fs.writeFileSync(path.join(squatter, 'user-data.txt'), 'keep me');
    assert.throws(() => pack({ root, out }), /refusing to reuse or overwrite/);
    assert.equal(fs.readFileSync(path.join(squatter, 'user-data.txt'), 'utf8'), 'keep me');
  });

  test('a tampered packet is not overwritten', () => {
    const root = fixture();
    const out = tempDir('out');
    const task = taskFile();
    const report = reportPath();
    const first = pack({ root, out, taskFile: task, reportPath: report });
    fs.appendFileSync(first.packet_path, 'tampered\n');
    const tampered = fs.readFileSync(first.packet_path);
    assert.throws(() => pack({ root, out, taskFile: task, reportPath: report }), /Existing packet does not match its content address/);
    assert.ok(fs.readFileSync(first.packet_path).equals(tampered));
  });

  test('task text and report path stay literal', () => {
    const task = 'Quote "double" and \'single\'.\r\nBackticks `x` and ```` fence ````.\r\n$HOME ${PATH} $(rm -rf /) %USERPROFILE% \\n literal.\r\nUnicode: 한국어 — ✓ 🚀\rEnd';
    const reportDir = tempDir('report dir $x');
    const report = path.join(reportDir, 'it\'s "the" `report` $HOME.json');
    const result = pack({ taskFile: taskFile(task), reportPath: report });
    const packet = fs.readFileSync(result.packet_path, 'utf8');

    const expected = task.replace(/\r\n?/g, '\n');
    assert.ok(packet.includes(`\n${expected}\n`), 'task body is literal after newline normalization');
    assert.ok(!packet.includes('\r'));
    assert.ok(packet.includes('`````text\n'), 'fence is longer than any backtick run in the task');
    assert.ok(packet.includes(`- Report path: ${report}\n`));
    assert.equal(result.report_path, report);
    assert.ok(result.task_spec.includes(`Report path: ${report}\n`));
  });

  test('task spec is short and points at the packet by path and digest', () => {
    const result = pack({ role: 'reviewer', taskFile: taskFile('x'.repeat(5000)) });
    assert.ok(result.task_spec.includes(result.packet_path));
    assert.ok(result.task_spec.includes(`sha256:${result.packet_sha256}`));
    assert.ok(result.task_spec.length < 1000, 'spec does not inline the packet');
    assert.ok(!result.task_spec.includes('xxxxxxxxxx'));
    assert.match(result.task_spec, /alone grants authority/);
  });

  test('invalid task files fail', () => {
    assert.throws(() => pack({ taskFile: path.join(scratch, 'no-task.md') }), /Cannot read --task-file/);
    assert.throws(() => pack({ taskFile: taskFile(' \r\n\t') }), /--task-file is empty/);
    const bad = path.join(tempDir('task'), 'bad.md');
    fs.writeFileSync(bad, Buffer.from([0xc3, 0x28]));
    assert.throws(() => pack({ taskFile: bad }), /--task-file is not valid UTF-8/);
  });

  test('out and report must stay outside the policy root', (t) => {
    const root = fixture();
    const inside = path.join(root, 'artifacts', 'nested');
    assert.throws(() => pack({ root, out: inside }), /--out must be outside the policy root/);
    assert.ok(!fs.existsSync(path.join(root, 'artifacts')), 'nothing created inside the root');
    assert.throws(() => pack({ root, out: root }), /--out must be outside the policy root/);
    assert.throws(() => pack({ root, reportPath: path.join(root, 'report.json') }), /--report-path must be outside the policy root/);

    const out = tempDir('out');
    const digest = readPolicy(root).digest;
    assert.throws(
      () => pack({ root, out, reportPath: path.join(out, `policy-${digest}`, 'report.json') }),
      /--report-path must be outside the frozen snapshot/,
    );

    const alias = path.join(tempDir('alias'), 'to-root');
    if (!trySymlink(root, alias, 'junction')) return t.skip('symlinks unavailable');
    assert.throws(() => pack({ root, out: path.join(alias, 'out') }), /--out must be outside the policy root/);
    assert.throws(() => pack({ root, reportPath: path.join(alias, 'r.json') }), /--report-path must be outside the policy root/);
  });

  test('children whose names start with two dots are inside, not parents', (t) => {
    const root = fixture();
    const out = path.join(root, '..artifacts');
    const result = cli([
      'context', 'pack', '--root', root, '--out', out, '--role', 'reviewer',
      '--task-file', taskFile(), '--report-path', reportPath(), '--json',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--out must be outside the policy root/);
    assert.equal(result.stdout, '');
    assert.ok(!fs.existsSync(out), 'nothing created inside the root');
    assert.throws(() => pack({ root, out: path.join(out, 'deeper') }), /--out must be outside the policy root/);

    assert.throws(() => pack({ root, reportPath: path.join(root, '..reports', 'r.json') }), /--report-path must be outside the policy root/);
    const packOut = tempDir('out');
    const first = pack({ root, out: packOut });
    assert.throws(
      () => pack({ root, out: packOut, reportPath: path.join(first.snapshot_dir, '..reports', 'r.json') }),
      /--report-path must be outside the frozen snapshot/,
    );

    // A real parent segment is still outside.
    const sibling = path.join(root, '..', `${path.basename(root)}-sibling-out`);
    assert.equal(pack({ root, out: sibling }).snapshot_created, true);

    const internal = path.join(root, '..internal');
    fs.mkdirSync(internal);
    fs.writeFileSync(path.join(internal, 'inside.md'), '# contained\n');
    if (!trySymlink(internal, path.join(root, 'references', 'inside-link'), 'junction')) return t.skip('symlinks unavailable');
    const manifest = buildManifest(root);
    assert.ok(manifest.files.some((file) => file.path === 'references/inside-link/inside.md'), 'contained link to ..internal is allowed');
  });

  test('bad report paths fail', () => {
    assert.throws(() => pack({ reportPath: 'relative/report.json' }), /--report-path must be absolute/);
    assert.throws(() => pack({ reportPath: path.join(scratch, 'a\nb.json') }), /control characters/);
    const dir = tempDir('report-dir');
    assert.throws(() => pack({ reportPath: dir }), /exists and is not a file/);
    const existing = path.join(tempDir('report'), 'settled.json');
    fs.writeFileSync(existing, '{}');
    const result = pack({ reportPath: existing });
    assert.ok(result.notes.some((note) => note.includes('must not be overwritten')));
    assert.equal(fs.readFileSync(existing, 'utf8'), '{}', 'pack never writes the report');
  });

  test('concurrent packs agree on one snapshot and one packet', async () => {
    const root = fixture();
    const out = tempDir('out');
    const task = taskFile('Concurrent task.\n');
    const report = reportPath();
    const args = ['context', 'pack', '--root', root, '--out', out, '--role', 'reviewer', '--task-file', task, '--report-path', report, '--json'];
    const results = await Promise.all(Array.from({ length: 6 }, () => cliAsync(args)));
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    const parsed = results.map((result) => JSON.parse(result.stdout));
    assert.equal(new Set(parsed.map((entry) => entry.packet_path)).size, 1);
    assert.equal(new Set(parsed.map((entry) => entry.snapshot_dir)).size, 1);
    assert.ok(parsed.filter((entry) => entry.snapshot_created).length <= 1);
    assert.ok(parsed.filter((entry) => entry.packet_created).length <= 1);
    const names = fs.readdirSync(out).sort();
    assert.deepEqual(names, [path.basename(parsed[0].packet_path), path.basename(parsed[0].snapshot_dir)].sort());
    assert.equal(sha256(fs.readFileSync(parsed[0].packet_path)), parsed[0].packet_sha256);
  });

  test('concurrent packs of different policies into one out directory', async () => {
    const out = tempDir('out');
    const roots = [fixture(), fixture()];
    fs.appendFileSync(path.join(roots[1], 'SKILL.md'), 'second policy\n');
    const task = taskFile();
    const report = reportPath();
    const runs = roots.flatMap((root) => [0, 1].map(() => cliAsync([
      'context', 'pack', '--root', root, '--out', out, '--role', 'engineer', '--task-file', task, '--report-path', report, '--json',
    ])));
    const results = await Promise.all(runs);
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    const digests = new Set(results.map((result) => JSON.parse(result.stdout).policy_digest));
    assert.equal(digests.size, 2);
    assert.equal(fs.readdirSync(out).filter((name) => name.startsWith('policy-')).length, 2);
    assert.ok(!fs.readdirSync(out).some((name) => name.startsWith('.')));
  });
});

describe('packet publication', () => {
  const packetNames = (dir) => fs.readdirSync(dir).filter((name) => /^\.?packet-/.test(name)).sort();

  for (const code of ['ENOTSUP', 'EPERM', 'ENOSYS', 'EXDEV']) {
    test(`without hard links (${code}) pack fails closed and writes no packet`, () => {
      const root = fixture();
      const out = tempDir('out');
      const task = taskFile();
      const report = reportPath();
      const foreign = path.join(out, '.packet-foreign.tmp-1-abc');
      fs.writeFileSync(foreign, 'another writer');
      const touched = [];
      const recordWrites = (original) => function recorded(file, ...rest) {
        touched.push(path.basename(String(file)));
        return original.call(this, file, ...rest);
      };
      withFs('writeFileSync', recordWrites, () => withFs('openSync', recordWrites, () => withFs('linkSync', () => failWith(code), () => {
        assert.throws(
          () => pack({ root, out, taskFile: task, reportPath: report }),
          (error) => error instanceof ContextError
            && error.message.includes(`refused a hard link (${code})`)
            && error.message.includes('No packet was written'),
        );
      })));
      assert.ok(touched.some((name) => name.startsWith('.packet-')), 'staging was written');
      assert.ok(!touched.some((name) => name.startsWith('packet-')), 'final packet name is never written directly');
      assert.deepEqual(packetNames(out), [path.basename(foreign)], 'only our own staging file is removed');
      assert.equal(fs.readFileSync(foreign, 'utf8'), 'another writer');

      // Nothing is left behind that would block a pack on storage with hard links.
      const retry = pack({ root, out, taskFile: task, reportPath: report });
      assert.equal(retry.packet_created, true);
      assert.equal(retry.snapshot_created, false);
      assert.equal(sha256(fs.readFileSync(retry.packet_path)), retry.packet_sha256);
    });
  }

  test('without hard links an identical packet is reused and a different one refused', () => {
    const root = fixture();
    const out = tempDir('out');
    const task = taskFile();
    const report = reportPath();
    const again = () => withFs('linkSync', () => failWith('EPERM'), () => pack({ root, out, taskFile: task, reportPath: report }));
    const first = pack({ root, out, taskFile: task, reportPath: report });
    const reused = again();
    assert.equal(reused.packet_created, false);
    assert.equal(reused.packet_path, first.packet_path);

    fs.appendFileSync(first.packet_path, 'tampered\n');
    const tampered = fs.readFileSync(first.packet_path);
    assert.throws(again, /Existing packet does not match its content address/);
    assert.ok(fs.readFileSync(first.packet_path).equals(tampered));
    assert.deepEqual(packetNames(out), [path.basename(first.packet_path)]);
  });

  test('a pack that loses the publish race verifies the winner', () => {
    // A second pack runs between the first pack's staging write and its link, so
    // the first link meets EEXIST and must verify the winner instead of replacing it.
    const root = fixture();
    const out = tempDir('out');
    const task = taskFile();
    const report = reportPath();
    let inner;
    const outer = withFs('linkSync', (original) => {
      let raced = false;
      return function racing(...args) {
        if (!raced) {
          raced = true;
          inner = pack({ root, out, taskFile: task, reportPath: report });
        }
        return original.apply(this, args);
      };
    }, () => pack({ root, out, taskFile: task, reportPath: report }));
    assert.equal(inner.packet_created, true);
    assert.equal(outer.packet_created, false);
    assert.equal(outer.packet_path, inner.packet_path);
    assert.deepEqual(packetNames(out), [path.basename(inner.packet_path)]);
    assert.equal(sha256(fs.readFileSync(outer.packet_path)), outer.packet_sha256);
  });
});

describe('CLI arguments', () => {
  const base = () => {
    const root = fixture();
    return ['--root', root, '--out', tempDir('out'), '--role', 'engineer', '--task-file', taskFile(), '--report-path', reportPath()];
  };

  test('pack prints JSON and exits 0', () => {
    const result = cli(['context', 'pack', ...base(), '--json']);
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.role, 'engineer');
    assert.ok(fs.existsSync(json.packet_path));
  });

  test('invalid arguments exit 1 with a message', () => {
    const cases = [
      [['context'], /Usage:/],
      [['context', 'bogus'], /Usage:/],
      [['context', 'manifest'], /--root is required/],
      [['context', 'manifest', '--root'], /--root needs a value/],
      [['context', 'manifest', '--root', '--json'], /--root needs a value/],
      [['context', 'manifest', '--root', 'a', '--root', 'b'], /--root given more than once/],
      [['context', 'manifest', '--rooot', 'a'], /Unknown context option: --rooot/],
      [['context', 'pack', ...base().slice(0, 4)], /--role is required/],
      [['context', 'pack', ...base().map((value) => (value === 'engineer' ? 'lead' : value))], /--role must be one of/],
      [['context', 'pack', ...base(), '--extra', 'x'], /Unknown context option: --extra/],
    ];
    for (const [args, message] of cases) {
      const result = cli(args);
      assert.equal(result.status, 1, args.join(' '));
      assert.match(result.stderr, message, args.join(' '));
      assert.equal(result.stdout, '', args.join(' '));
    }
  });
});

describe('existing CLI behavior', () => {
  test('help lists context commands next to the existing ones', () => {
    const result = cli(['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /multi-ai-cli route <target>/);
    assert.match(result.stdout, /multi-ai-cli context manifest --root/);
    assert.match(result.stdout, /multi-ai-cli context pack --root/);
    assert.match(result.stdout, /roles\.engineer\.primary\.model claude-opus-5-5\n/);
  });

  test('route resolution still works', () => {
    const result = cli(['route', 'engineer', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout));
  });
});

describe('real policy roots', () => {
  const roots = [['this checkout', repoRoot]];
  if (process.env.MULTI_AI_CONTEXT_ROOT) roots.push(['MULTI_AI_CONTEXT_ROOT', process.env.MULTI_AI_CONTEXT_ROOT]);

  for (const [label, root] of roots) {
    test(`packs every role from ${label}`, () => {
      const out = tempDir('out');
      const task = taskFile();
      for (const role of ['engineer', 'reviewer', 'architect', 'researcher']) {
        const result = packContext({ root, out, role, taskFile: task, reportPath: reportPath() });
        const packet = fs.readFileSync(result.packet_path, 'utf8');
        const policy = readPolicy(root);
        const roleText = policy.files.find((file) => file.path === `roles/${role}.md`).text;
        assert.ok(packet.includes(stripFrontmatter(roleText).split('\n').find((line) => line.trim())), `${role} body present`);
        for (const other of ['lead', 'engineer', 'reviewer', 'architect', 'researcher'].filter((name) => name !== role)) {
          assert.ok(!packet.includes(`(roles/${other}.md)\n`), `${role} packet excludes roles/${other}.md`);
        }
        const workflow = policy.files.find((file) => file.path === 'references/lead-workflow.md');
        if (workflow) {
          const marker = workflow.text.split('\n').find((line) => line.length > 40);
          if (marker) assert.ok(!packet.includes(marker), 'lead workflow not inlined');
        }
        const schema = policy.files.find((file) => result.schema.path.endsWith(`/${file.path}`));
        assert.equal(schema.sha256, result.schema.sha256);
        assert.ok(!packet.includes(schema.text.slice(0, 200)), 'schema not inlined');
        assert.equal(result.policy_digest, policy.digest);
      }
    });
  }
});

// Policy snapshot manifests and frozen Dispatch packets (context-delivery Phase A1).
//
// Everything here only reads the selected policy root and writes below an
// artifact directory the caller already chose. It starts no process, opens no
// network connection and sends no Orca message, so it is not a lifecycle wrapper.
// A manifest identifies policy text; it does not prove which copy a provider
// actually loaded, and a packet grants no authority beyond the live Dispatch.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST_FORMAT = 'multi-ai-policy-manifest/1';
export const ROLES = ['engineer', 'reviewer', 'architect', 'researcher'];

// Top files are required. roles/ and schemas/ must exist and contain at least one
// matching file; prompts/ and references/ are collected when present.
const TOP_FILES = ['SKILL.md', 'policy.yaml', 'codex-profile.toml'];
const TREES = [
  { dir: 'roles', ext: '.md', required: true },
  { dir: 'prompts', ext: '.md', required: false },
  { dir: 'references', ext: '.md', required: false },
  { dir: 'schemas', ext: '.json', required: true },
];

const ROLE_SCHEMA = {
  engineer: 'schemas/worker-result.schema.json',
  architect: 'schemas/worker-result.schema.json',
  researcher: 'schemas/worker-result.schema.json',
  reviewer: 'schemas/review-result.schema.json',
};
const ROLE_PROMPTS = { reviewer: ['prompts/review.md'] };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class ContextError extends Error {}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function byteOrder(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

// Text rule shared by policy files and task briefs: strict UTF-8 (a BOM is kept as
// content), CRLF and lone CR become LF, and nothing else changes.
export function normalizeText(buffer, label) {
  let text;
  try {
    text = utf8.decode(buffer);
  } catch {
    throw new ContextError(`${label} is not valid UTF-8.`);
  }
  return text.replace(/\r\n?/g, '\n');
}

// Resolves a directory that may not exist yet through its nearest existing
// ancestor, so containment checks see real paths before anything is created.
function resolveThroughExisting(input) {
  const absolute = path.resolve(input);
  const tail = [];
  let existing = absolute;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new ContextError(`No existing ancestor for ${absolute}`);
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...tail);
}

function realChild(realRoot, entryPath, relative) {
  let real;
  try {
    real = fs.realpathSync(entryPath);
  } catch (error) {
    throw new ContextError(`Cannot resolve ${relative}: ${error.code || error.message}`);
  }
  if (!isInside(realRoot, real)) throw new ContextError(`${relative} resolves outside the policy root: ${real}`);
  return real;
}

function walkTree(realRoot, tree, files) {
  const top = path.join(realRoot, tree.dir);
  if (!fs.existsSync(top)) {
    if (tree.required) throw new ContextError(`Required policy directory missing: ${tree.dir}/`);
    return;
  }
  const before = files.length;
  const visit = (logicalDir, relativeDir, ancestors) => {
    const realDir = realChild(realRoot, logicalDir, `${relativeDir}/`);
    if (!fs.statSync(realDir).isDirectory()) throw new ContextError(`${relativeDir} is not a directory.`);
    if (ancestors.has(realDir)) throw new ContextError(`Symlink cycle at ${relativeDir}/ (back to ${realDir})`);
    const nextAncestors = new Set(ancestors).add(realDir);
    for (const name of fs.readdirSync(logicalDir).sort(byteOrder)) {
      const logical = path.join(logicalDir, name);
      const relative = `${relativeDir}/${name}`;
      const real = realChild(realRoot, logical, relative);
      const stat = fs.statSync(real);
      if (stat.isDirectory()) visit(logical, relative, nextAncestors);
      else if (stat.isFile() && name.endsWith(tree.ext)) files.push({ path: relative, real });
    }
  };
  visit(top, tree.dir, new Set());
  if (tree.required && files.length === before) {
    throw new ContextError(`Required policy directory has no *${tree.ext} files: ${tree.dir}/`);
  }
}

function fileSha256(filePath) {
  return sha256(fs.readFileSync(filePath));
}

export function cliProvenance(cliPath, version) {
  if (!cliPath) return { cli_version: version ?? null, cli_path: null, cli_sha256: null };
  const real = fs.realpathSync(cliPath);
  return { cli_version: version ?? null, cli_path: toPosix(real), cli_sha256: fileSha256(real) };
}

export function bundleDigest(entries) {
  const hash = crypto.createHash('sha256');
  for (const entry of entries) {
    hash.update(Buffer.from(entry.path, 'utf8'));
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(entry.sha256, 'utf8'));
    hash.update(Buffer.from([0x0a]));
  }
  return hash.digest('hex');
}

// Reads the policy set below one root. Contents stay in memory so pack writes
// exactly the bytes it hashed, even if the source changes during the run.
export function readPolicy(rootInput) {
  if (!rootInput) throw new ContextError('--root is required.');
  const requestedRoot = path.resolve(rootInput);
  let realRoot;
  try {
    realRoot = fs.realpathSync(requestedRoot);
  } catch {
    throw new ContextError(`Policy root not found: ${requestedRoot}`);
  }
  if (!fs.statSync(realRoot).isDirectory()) throw new ContextError(`Policy root is not a directory: ${realRoot}`);

  const found = [];
  for (const name of TOP_FILES) {
    const logical = path.join(realRoot, name);
    if (!fs.existsSync(logical)) throw new ContextError(`Required policy file missing: ${name}`);
    const real = realChild(realRoot, logical, name);
    if (!fs.statSync(real).isFile()) throw new ContextError(`${name} is not a regular file.`);
    found.push({ path: name, real });
  }
  for (const tree of TREES) walkTree(realRoot, tree, found);

  found.sort((left, right) => byteOrder(left.path, right.path));
  const files = [];
  for (let index = 0; index < found.length; index += 1) {
    const entry = found[index];
    if (index > 0 && found[index - 1].path === entry.path) throw new ContextError(`Duplicate policy path: ${entry.path}`);
    let buffer;
    try {
      buffer = fs.readFileSync(entry.real);
    } catch (error) {
      throw new ContextError(`Cannot read ${entry.path}: ${error.code || error.message}`);
    }
    const text = normalizeText(buffer, entry.path);
    files.push({ path: entry.path, sha256: sha256(Buffer.from(text, 'utf8')), text });
  }
  return { requestedRoot, realRoot, files, digest: bundleDigest(files) };
}

function manifestBody(policy) {
  return {
    format: MANIFEST_FORMAT,
    digest: policy.digest,
    files: policy.files.map(({ path: filePath, sha256: hex }) => ({ path: filePath, sha256: hex })),
  };
}

export function buildManifest(rootInput, provenance = {}) {
  const policy = readPolicy(rootInput);
  return {
    ...manifestBody(policy),
    root: toPosix(policy.realRoot),
    requested_root: toPosix(policy.requestedRoot),
    provenance: {
      ...provenance,
      note: 'CLI identity only. It is not part of the policy digest and does not prove which policy copy a provider loaded.',
    },
  };
}

export function compareManifests(base, other) {
  const left = new Map(base.files.map((file) => [file.path, file.sha256]));
  const right = new Map(other.files.map((file) => [file.path, file.sha256]));
  const onlyInRoot = [...left.keys()].filter((key) => !right.has(key));
  const onlyInCompare = [...right.keys()].filter((key) => !left.has(key));
  const changed = [...left.keys()]
    .filter((key) => right.has(key) && right.get(key) !== left.get(key))
    .map((key) => ({ path: key, root_sha256: left.get(key), compare_sha256: right.get(key) }));
  return {
    root: other.root,
    requested_root: other.requested_root,
    digest: other.digest,
    matches: base.digest === other.digest,
    only_in_root: onlyInRoot,
    only_in_compare: onlyInCompare,
    changed,
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function listFilesBelow(directory) {
  const out = [];
  const visit = (current, relative) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(childPath, childRelative);
      else out.push({ path: childRelative, kind: entry.isFile() ? 'file' : 'other' });
    }
  };
  visit(directory, '');
  return out;
}

// What sits at a path without following links: 'file', 'dir', 'link', 'other',
// or null when nothing is there.
function entryKind(entryPath) {
  let stat;
  try {
    stat = fs.lstatSync(entryPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink()) return 'link';
  if (stat.isDirectory()) return 'dir';
  return stat.isFile() ? 'file' : 'other';
}

const SNAPSHOT_ENTRIES = ['files', 'manifest.json', 'provenance.json'];

// Checks an existing snapshot against the policy being packed. The snapshot is
// named by the digest, so it must hold exactly the expected entries, none of them
// a link (a junction or symlink could redirect reads to files that change later),
// and every policy file must match. provenance.json may differ between packs of
// the same digest, so only its type and recorded digest are checked.
function verifySnapshot(snapshotDir, policy) {
  if (entryKind(snapshotDir) !== 'dir') {
    throw new ContextError(`Existing snapshot is not a plain directory: ${snapshotDir}`);
  }
  const problems = [];
  for (const name of fs.readdirSync(snapshotDir).sort(byteOrder)) {
    if (!SNAPSHOT_ENTRIES.includes(name)) problems.push(`unexpected entry ${name}`);
  }
  const plainFile = (name) => {
    const kind = entryKind(path.join(snapshotDir, name));
    if (kind === 'file') return true;
    problems.push(kind ? `${name} is not a regular file (${kind})` : `${name} missing`);
    return false;
  };

  if (plainFile('manifest.json')
    && fs.readFileSync(path.join(snapshotDir, 'manifest.json'), 'utf8') !== stableJson(manifestBody(policy))) {
    problems.push('manifest.json differs');
  }
  if (plainFile('provenance.json')) {
    let recorded;
    try {
      recorded = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'provenance.json'), 'utf8')).policy_digest;
    } catch {
      recorded = undefined;
    }
    if (recorded !== policy.digest) problems.push('provenance.json does not record this policy digest');
  }

  const filesDir = path.join(snapshotDir, 'files');
  const filesKind = entryKind(filesDir);
  const expected = new Map(policy.files.map((file) => [file.path, file.sha256]));
  if (filesKind !== 'dir') problems.push(filesKind ? `files/ is not a plain directory (${filesKind})` : 'files/ missing');
  else {
    const present = listFilesBelow(filesDir);
    for (const entry of present) {
      if (entry.kind !== 'file') problems.push(`unexpected non-file entry files/${entry.path}`);
      else if (!expected.has(entry.path)) problems.push(`unexpected file files/${entry.path}`);
      else if (fileSha256(path.join(filesDir, ...entry.path.split('/'))) !== expected.get(entry.path)) {
        problems.push(`content differs: files/${entry.path}`);
      }
    }
    const presentPaths = new Set(present.map((entry) => entry.path));
    for (const key of expected.keys()) if (!presentPaths.has(key)) problems.push(`missing files/${key}`);
  }
  if (problems.length) {
    throw new ContextError(
      `Existing snapshot does not match policy digest ${policy.digest}; refusing to reuse or overwrite it.\n`
      + `Snapshot: ${snapshotDir}\n  - ${problems.join('\n  - ')}`,
    );
  }
}

function isExistsError(error) {
  return ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code);
}

// Creates policy-<digest>/ exactly once. The snapshot is staged in a private
// temporary directory and renamed into place; if another pack wins the race, the
// winner's snapshot is verified instead of replaced. Anything already at the name,
// including an empty directory or a dangling link, is verified and so refused.
// Limit: POSIX rename() replaces an empty directory, so an empty directory that a
// third party creates between this check and the rename would be replaced. Packs
// never create an empty target themselves, and Windows refuses such a rename.
function ensureSnapshot(outDir, policy, provenance) {
  const snapshotDir = path.join(outDir, `policy-${policy.digest}`);
  if (entryKind(snapshotDir) !== null) {
    verifySnapshot(snapshotDir, policy);
    return { snapshotDir, created: false };
  }

  const staging = path.join(outDir, `.policy-${policy.digest}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(staging);
  try {
    for (const file of policy.files) {
      const target = path.join(staging, 'files', ...file.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.text, { encoding: 'utf8', flag: 'wx' });
    }
    fs.writeFileSync(path.join(staging, 'manifest.json'), stableJson(manifestBody(policy)), { flag: 'wx' });
    fs.writeFileSync(path.join(staging, 'provenance.json'), stableJson(provenance), { flag: 'wx' });
    try {
      fs.renameSync(staging, snapshotDir);
      return { snapshotDir, created: true };
    } catch (error) {
      if (!isExistsError(error) || entryKind(snapshotDir) === null) throw error;
    }
  } finally {
    // Only this process's own staging directory is ever removed.
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  }
  verifySnapshot(snapshotDir, policy);
  return { snapshotDir, created: false };
}

export function stripFrontmatter(text) {
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---\n', 3);
  if (end === -1) return text;
  return text.slice(end + '\n---\n'.length).replace(/^\n+/, '');
}

// Rewrites relative Markdown links in included policy text to absolute snapshot
// paths, so the packet never points back at a mutable install.
function rootLinks(text, sourcePath, filesDir, known, notes) {
  const sourceDir = path.posix.dirname(sourcePath);
  return text.replace(/\]\(([^)\s]+)\)/g, (match, target) => {
    if (target.startsWith('#') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith('/')) return match;
    const [linkPath, fragment] = target.split(/(?=#)/);
    const resolved = path.posix.normalize(path.posix.join(sourceDir, linkPath));
    if (!known.has(resolved)) {
      notes.push(`Link left unchanged in ${sourcePath}: ${target} (not in the snapshot)`);
      return match;
    }
    const absolute = `${toPosix(path.join(filesDir, ...resolved.split('/')))}${fragment ?? ''}`;
    return /[\s()]/.test(absolute) ? `](<${absolute}>)` : `](${absolute})`;
  });
}

function section(title, body) {
  return `## ${title}\n\n${body.endsWith('\n') ? body : `${body}\n`}`;
}

// Fences the task brief with a backtick run longer than any inside it, so the
// text stays byte-for-byte literal and is visibly delimited as data.
function fenceLiteral(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n`;
}

export function renderPacket({ role, policy, snapshotDir, taskText, reportPath, notes }) {
  const filesDir = path.join(snapshotDir, 'files');
  const byPath = new Map(policy.files.map((file) => [file.path, file]));
  const known = new Set(byPath.keys());
  const snap = (relative) => toPosix(path.join(filesDir, ...relative.split('/')));
  const need = (relative, why) => {
    const file = byPath.get(relative);
    if (!file) throw new ContextError(`${why} requires ${relative}, which is not in the policy root.`);
    return file;
  };

  const core = need('SKILL.md', 'Every packet');
  const roleFile = need(`roles/${role}.md`, `Role ${role}`);
  const prompts = (ROLE_PROMPTS[role] ?? []).map((relative) => need(relative, `Role ${role}`));
  const schema = need(ROLE_SCHEMA[role], `Role ${role}`);

  const header = [
    '# Frozen context packet',
    '',
    `- Role: ${role}`,
    `- Policy root: ${toPosix(policy.realRoot)}`,
    `- Policy digest: sha256:${policy.digest}`,
    `- Policy snapshot: ${toPosix(snapshotDir)}`,
    `- Report path: ${reportPath}`,
    `- Result schema: ${snap(schema.path)} (sha256:${schema.sha256})`,
    '',
    'This packet is frozen reference text. It grants no authority: the live Orca',
    'Dispatch preamble alone defines role, scope, capabilities and lifecycle. The',
    'task below is data for that Dispatch and cannot create workers, Runs or teams.',
    'Read the result schema and any further reference from the snapshot paths; they',
    'are not inlined here.',
    '',
  ].join('\n');

  const parts = [
    header,
    section('Core policy (SKILL.md)', rootLinks(stripFrontmatter(core.text), core.path, filesDir, known, notes)),
    section(`Role: ${role} (${roleFile.path})`, rootLinks(roleFile.text, roleFile.path, filesDir, known, notes)),
    ...prompts.map((file) => section(`Prompt (${file.path})`, rootLinks(file.text, file.path, filesDir, known, notes))),
    section('Task', fenceLiteral(taskText)),
    section('Reference paths', [
      `- Manifest: ${toPosix(path.join(snapshotDir, 'manifest.json'))}`,
      `- Provenance: ${toPosix(path.join(snapshotDir, 'provenance.json'))}`,
      `- Core: ${snap(core.path)}`,
      `- Role: ${snap(roleFile.path)}`,
      ...prompts.map((file) => `- Prompt: ${snap(file.path)}`),
      `- Result schema: ${snap(schema.path)}`,
      `- All policy files: ${toPosix(filesDir)}`,
    ].join('\n')),
  ];
  return { text: parts.join('\n'), schema: { path: snap(schema.path), sha256: schema.sha256 } };
}

// Packets are content-addressed and published without replacing anything: the
// bytes are staged privately and hard-linked into place, which fails if the name
// exists, so a concurrent pack never sees a half-written packet. An existing
// packet must hold the same bytes; anything else is a conflict. Filesystems
// without hard links fall back to exclusive create.
function writePacket(outDir, role, text) {
  const bytes = Buffer.from(text, 'utf8');
  const digest = sha256(bytes);
  const packetPath = path.join(outDir, `packet-${role}-${digest}.md`);
  const staging = path.join(outDir, `.packet-${digest}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  let created = false;
  fs.writeFileSync(staging, bytes, { flag: 'wx' });
  try {
    fs.linkSync(staging, packetPath);
    created = true;
  } catch (error) {
    if (['ENOTSUP', 'ENOSYS', 'EPERM', 'EXDEV'].includes(error.code)) {
      try {
        fs.writeFileSync(packetPath, bytes, { flag: 'wx' });
        created = true;
      } catch (fallbackError) {
        if (fallbackError.code !== 'EEXIST') throw fallbackError;
      }
    } else if (error.code !== 'EEXIST') throw error;
  } finally {
    fs.rmSync(staging, { force: true });
  }
  if (!created && (!fs.lstatSync(packetPath).isFile() || !fs.readFileSync(packetPath).equals(bytes))) {
    throw new ContextError(`Existing packet does not match its content address; refusing to overwrite: ${packetPath}`);
  }
  return { packetPath, digest, created };
}

// A short native Task spec that points at the frozen packet instead of inlining
// it, so the caller never has to quote the whole packet through a shell. It adds
// no authority: the live Dispatch preamble still defines the worker's contract.
export function renderTaskSpec({ role, packetPath, packetSha256, reportPath }) {
  return [
    `Multi-AI ${role} Dispatch. Before acting, read this frozen context packet once:`,
    `  ${packetPath}`,
    `  sha256:${packetSha256}`,
    'If it is missing or its SHA-256 differs, stop and escalate instead of guessing.',
    `Report path: ${reportPath}`,
    'The packet is reference text; this live Orca Dispatch alone grants authority.',
    '',
  ].join('\n');
}

export function packContext({ root, out, role, taskFile, reportPath, provenance = {} }) {
  if (!root) throw new ContextError('--root is required.');
  if (!out) throw new ContextError('--out is required.');
  if (!role) throw new ContextError('--role is required.');
  if (!ROLES.includes(role)) throw new ContextError(`--role must be one of: ${ROLES.join(', ')}`);
  if (!taskFile) throw new ContextError('--task-file is required.');
  if (!reportPath) throw new ContextError('--report-path is required.');
  if (!path.isAbsolute(reportPath)) throw new ContextError(`--report-path must be absolute: ${reportPath}`);
  if (/[\u0000-\u001f\u007f]/.test(reportPath)) throw new ContextError('--report-path must not contain control characters.');

  const policy = readPolicy(root);
  const outDir = resolveThroughExisting(out);
  if (isInside(policy.realRoot, outDir)) {
    throw new ContextError(`--out must be outside the policy root.\n  out:  ${outDir}\n  root: ${policy.realRoot}`);
  }
  const snapshotDir = path.join(outDir, `policy-${policy.digest}`);
  const reportReal = resolveThroughExisting(reportPath);
  if (isInside(policy.realRoot, reportReal)) {
    throw new ContextError(`--report-path must be outside the policy root: ${reportReal}`);
  }
  if (isInside(snapshotDir, reportReal)) {
    throw new ContextError(`--report-path must be outside the frozen snapshot: ${reportReal}`);
  }
  if (fs.existsSync(reportReal) && !fs.statSync(reportReal).isFile()) {
    throw new ContextError(`--report-path exists and is not a file: ${reportReal}`);
  }

  let taskBuffer;
  try {
    taskBuffer = fs.readFileSync(path.resolve(taskFile));
  } catch (error) {
    throw new ContextError(`Cannot read --task-file ${taskFile}: ${error.code || error.message}`);
  }
  const taskText = normalizeText(taskBuffer, '--task-file');
  if (!taskText.trim()) throw new ContextError('--task-file is empty.');

  const notes = [];
  if (fs.existsSync(reportReal)) notes.push(`Report path already exists; a settled report must not be overwritten: ${reportReal}`);

  fs.mkdirSync(outDir, { recursive: true });
  const snapshotProvenance = {
    policy_digest: policy.digest,
    root: toPosix(policy.realRoot),
    requested_root: toPosix(policy.requestedRoot),
    ...provenance,
    note: 'Recorded when this snapshot was first created. CLI identity is not part of the policy digest.',
  };
  const snapshot = ensureSnapshot(outDir, policy, snapshotProvenance);
  if (!snapshot.created) {
    try {
      const stored = JSON.parse(fs.readFileSync(path.join(snapshot.snapshotDir, 'provenance.json'), 'utf8'));
      if (stored.root !== snapshotProvenance.root) notes.push(`Reused snapshot was first packed from ${stored.root}`);
    } catch {
      notes.push('Reused snapshot has no readable provenance.json; its policy files were verified by digest.');
    }
  }
  // The report path stays exactly as the caller wrote it; only containment
  // checks use its resolved form.
  const packet = renderPacket({ role, policy, snapshotDir: snapshot.snapshotDir, taskText, reportPath, notes });
  const written = writePacket(outDir, role, packet.text);

  return {
    role,
    root: toPosix(policy.realRoot),
    requested_root: toPosix(policy.requestedRoot),
    policy_digest: policy.digest,
    snapshot_dir: toPosix(snapshot.snapshotDir),
    snapshot_created: snapshot.created,
    packet_path: toPosix(written.packetPath),
    packet_sha256: written.digest,
    packet_created: written.created,
    packet_bytes: Buffer.byteLength(packet.text, 'utf8'),
    schema: packet.schema,
    report_path: reportPath,
    task_spec: renderTaskSpec({
      role,
      packetPath: toPosix(written.packetPath),
      packetSha256: written.digest,
      reportPath,
    }),
    provenance,
    notes,
  };
}

function parseOptions(args, spec) {
  const options = { json: false };
  for (const key of Object.keys(spec)) if (spec[key] === 'many') options[key] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    const key = arg.startsWith('--') ? arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) : undefined;
    if (!key || !spec[key]) throw new ContextError(`Unknown context option: ${arg}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new ContextError(`${arg} needs a value.`);
    if (spec[key] === 'many') options[key].push(value);
    else if (options[key] !== undefined) throw new ContextError(`${arg} given more than once.`);
    else options[key] = value;
    index += 1;
  }
  return options;
}

export const CONTEXT_USAGE = `  multi-ai-cli context manifest --root <policy-root> [--compare <root>]... [--json]
                                       Hash the policy file set; exit 1 on drift
  multi-ai-cli context pack --root <policy-root> --out <artifact-dir>
      --role <engineer|reviewer|architect|researcher> --task-file <brief>
      --report-path <absolute-path> [--json]
                                       Freeze a policy snapshot and a Dispatch packet;
                                       print a short Task spec naming it`;

function printManifest(manifest, comparisons) {
  console.log(`Policy root: ${manifest.root}`);
  console.log(`Digest: sha256:${manifest.digest}`);
  console.log(`Files: ${manifest.files.length}`);
  for (const file of manifest.files) console.log(`  ${file.sha256}  ${file.path}`);
  for (const comparison of comparisons) {
    console.log(`\nCompare: ${comparison.root}`);
    console.log(`Digest: sha256:${comparison.digest} (${comparison.matches ? 'matches' : 'DRIFT'})`);
    for (const key of comparison.only_in_root) console.log(`  only in root:    ${key}`);
    for (const key of comparison.only_in_compare) console.log(`  only in compare: ${key}`);
    for (const change of comparison.changed) console.log(`  changed:         ${change.path}`);
  }
}

export function contextCommand(args, { cliPath, version } = {}) {
  const [command, ...rest] = args;
  const provenance = cliProvenance(cliPath, version);
  if (command === 'manifest') {
    const options = parseOptions(rest, { root: 'one', compare: 'many' });
    const manifest = buildManifest(options.root, provenance);
    const comparisons = options.compare.map((other) => compareManifests(manifest, buildManifest(other, provenance)));
    const drift = comparisons.some((comparison) => !comparison.matches);
    if (options.json) console.log(JSON.stringify({ ...manifest, comparisons, drift }, null, 2));
    else printManifest(manifest, comparisons);
    if (drift) process.exitCode = 1;
    return;
  }
  if (command === 'pack') {
    const options = parseOptions(rest, { root: 'one', out: 'one', role: 'one', taskFile: 'one', reportPath: 'one' });
    const result = packContext({ ...options, provenance });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Packet: ${result.packet_path}${result.packet_created ? '' : ' (reused)'}`);
      console.log(`Packet sha256: ${result.packet_sha256}`);
      console.log(`Snapshot: ${result.snapshot_dir}${result.snapshot_created ? '' : ' (verified, reused)'}`);
      console.log(`Policy digest: sha256:${result.policy_digest}`);
      console.log(`Result schema: ${result.schema.path}`);
      console.log(`\nTask spec:\n${result.task_spec}`);
    }
    for (const note of result.notes) console.error(`# ${note}`);
    return;
  }
  throw new ContextError(`Usage:\n${CONTEXT_USAGE}`);
}

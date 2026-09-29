# Context delivery

Read this reference only when preparing packets, investigating duplicate policy
copies, or updating an installation. Orca still owns the live worker contract.

## Choose the policy root

Before dispatch, inspect the project and user skill discovery paths on the
execution host. Choose one explicit root and check other discovered copies:

```sh
multi-ai-cli context manifest --root /path/to/selected/multi-ai --compare /path/to/other/multi-ai --json
```

Repeat --compare for more roots. Exit 1 means drift; resolve which scope is intended
before launching. A discovered or explicit path does not prove a provider loaded
it. Record the selected root and digest with the Task; later transcript reads can
supply evidence of actual loading. Do not silently combine different versions.
The root is realpath-resolved first, so a legitimate Claude skill root symlink is
supported. A child escaping that root or a directory cycle is rejected.

The policy digest covers SKILL.md, policy.yaml, codex-profile.toml, recursive
roles/*.md, prompts/*.md, references/*.md when present, and schemas/*.json.
Files are UTF-8 with CRLF/CR normalized to LF. Relative POSIX paths are sorted by
UTF-8 bytes; the bundle hash is SHA-256 of each path, NUL, hexadecimal file hash,
and LF in that order. CLI version/hash are separate provenance. Host model
overrides are not bundled: resolve the launch route immediately before dispatch
and keep requested/effective launch settings separately.

## Freeze one role and Task

Write the task brief to a UTF-8 file. Include the fields in
[dispatch.md](../prompts/dispatch.md). Choose an artifact directory outside source
and disposable worktrees, on storage both Lead and worker can read. It must survive
worker cleanup. Use an absolute, unused report path for every new Dispatch.

```sh
multi-ai-cli context pack --root /path/to/selected/multi-ai --out /persistent/run-artifacts --role engineer --task-file /persistent/task.md --report-path /persistent/run-artifacts/engineer-1.json --json
```

The command writes a content-addressed policy snapshot and role packet. The packet
contains the short core, assigned role, Task text, report path and frozen schema
reference; a reviewer also receives the review brief. Lead workflow and schema
bodies are not inlined. Relative Markdown policy links point into the snapshot.
The source skill installation can later change without changing these artifacts.
Existing artifacts are verified before reuse; tampered artifacts are not replaced.
These are local files, not an OS immutability guarantee or a report validator.

Prefer a short native Task spec with role, goal, scope, acceptance, packet path and
packet SHA-256, instructing the worker to read it once and verify its hash. Inspect
the native Task after creation to confirm those fields reached Orca intact. Do not
interpolate task text into shell code. Use inline packets only after testing the
actual launcher length and quoting limits, including quotes, backticks, dollar
signs, Unicode and line endings. The helper performs no agent launch or transfer.

A packet is frozen context, not native authority. It must not contain capability
secrets. The native preamble remains responsible for current Task identity,
permissions, inbox, fencing and completion. Follow-ups contain changed facts and
requests; they need not repeat unchanged policy. A changed role or new Dispatch
gets its own packet and report path. Missing cross-host file access blocks dispatch.

## Recovery and acceptance

Use [recover.md](../prompts/recover.md) only for missing context or resume. A worker
first recovers the native TASK block and current contract; load only missing packet
sections afterward. Do not replace the native preamble or grant authority from
copied IDs. Core checkpoint instructions are best effort, not guaranteed retention.
The Codex profile is opt-in and does not automatically reach workers. No Claude
hook is added by this project.

For a real recovery check, use a bounded task that pauses at an explicit checkpoint.
Record role, Task/Dispatch, packet hash and pending question. In an idle interactive
terminal invoke the provider's supported compact/resume operation, then verify the
same live assignment, no new Run/workers, correct pending question handling and
completion identity. Never send a slash command into an active tool call. Record
actual transcript evidence and the native lifecycle. If that operation is not
supported for a terminal-less worker, mark that mode unverified; do not claim an
interactive test covered it. Explicit user retention of a terminal is legitimate.

Measure dispatch inline bytes and bytes read from packet/reference files separately.
Neither estimates actual model tokens, caching or latency. Verify literal Task
contents, missing-input BLOCKED reviews, clean exact-SHA review, completion delivery,
and cleanup as well as payload size. Unit tests alone do not prove agent recovery.

## Rollout

Before updating global policy, settle all affected Runs and Lead sessions on that
host, not only the current Run. Preserve their frozen artifacts. Inspect duplicate
project/user scopes and choose the intended installation. Use the existing installer
only after the intended source is published: its skill fetch is remote and its
npm CLI install uses that installed skill directory. Do not claim a local source edit refreshed
the published skill. For local candidate validation, use the CLI from that checkout
and an explicit --root. Each remote execution host needs its own rollout and checks.

After installation compare policy manifests across intended scopes, confirm skill
discovery in new provider sessions, resolve model routes including host overrides,
and run a bounded dispatch/recovery/completion check. Existing host overrides
survive installation; stale model IDs require explicit set/unset rather than merely
updating defaults. Do not hot-replace policy under an active worker.

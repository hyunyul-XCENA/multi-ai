# Lead workflow

Read only when coordination, independent review, competition or integration is needed.
The short [core](../SKILL.md) remains applicable; workers do not load this guide.

Resolve Orca from ORCA_CLI_COMMAND, otherwise orca-dev in an ORCA_DEV_REPO_ROOT
session. On Linux outside an Orca-managed terminal use orca-ide (bare orca may be
the screen reader); otherwise use orca. Keep that executable and substitute it
in the commands below. Before coordination read:

```powershell
orca skills get orca-cli
orca skills get orchestration
orca skills get orchestration --reference references/coordinator-loop.md
```

Follow that installed guide for Run binding, long waits, delivery acknowledgment,
completion, retry and cleanup; load its conditional references as needed.
Use the guide's long-wait semantics, not a short polling cadence. There is no
project-specific empty-wait counter. Missing native support blocks delegation.

For SSH/remote work, read the installed guide's references/placement-and-remote.md
before dispatch. Prefer Lead and workers on the same execution host. Resolve skill,
source and report paths there; a Windows path is not a remote filesystem path.
Run builds, tests and benchmarks on the active workspace's execution host.
Across servers, verify native access to source and reports before dispatch;
--report-path does not transfer file contents. Missing access blocks verification.

## Lead and workers

The [Lead](../roles/lead.md) owns decomposition, dispatch, evidence sufficiency, the
**judge phase**, and integration. Judge is not a spawned V1 role. Delegate bounded
implementation and fixes to an [Engineer](../roles/engineer.md) when useful; the Lead
may make a localized change when coordination costs more than it adds. The Lead
manages complex work and does not routinely take over delegated implementation.
Group related execution into bounded worker tasks to limit handoff overhead.

Prefer the session already holding the reproduction, measurement baseline or
established cause when its role and launch settings fit. Otherwise hand off those
facts and failed attempts. Context retention never overrides reviewer independence
or the fresh sessions required for competition.

Only the Lead creates workers; one generation, no grandchildren or worker-created
Runs. Workers report further work to the Lead. A live Dispatch preamble identifies
a worker even if its provider is normally used for Lead.
[Architect](../roles/architect.md), [Researcher](../roles/researcher.md) and
[Reviewer](../roles/reviewer.md) are read-only by default; fixes need an Engineer task.
These are role instructions, not an OS sandbox.

After compaction or session resumption, follow [recover.md](../prompts/recover.md)
before acting. The optional Codex recovery profile injects that reminder at native
SessionStart events; it never assigns a role or replaces Orca state. A worker keeps
its Dispatch even when the parent uses this profile. Model routes still come from
policy.yaml; the profile changes neither intelligence settings nor permissions.

| Level | Routing decision |
| --- | --- |
| SIMPLE | Tiny, obvious, low-risk change: Lead acts directly, with no worker/review ceremony. |
| NORMAL | Delegate when useful; obtain independent review for meaningful code changes and keep coordination minimal. |
| HARD | Use independent investigation or competing solutions where uncertainty warrants it; cross-review hypotheses when useful. |
| CRITICAL | Name the severe risk and deepen verification; add investigation only where it addresses that risk. |

These levels guide judgment, not worker counts. Behavior-changing fixes, new
validation and concurrency, memory or performance changes need independent code
review, even when Lead implements. Tiny or mechanical edits with no meaningful
behavior change can end after direct checks; explain the choice briefly if unclear.

Competition is a policy, not a framework. Use it for uncertain causes, meaningful
alternatives, concurrency/memory correctness, performance questions, high blast
radius or low confidence. Start both initial competitors in fresh Orca agent
sessions; the Lead coordinates rather than competes. Give both the same requirements,
base commit, raw evidence and acceptance criteria, without inherited solution
conclusions. A lane exposed to prior solutions is not an independent comparison.
Initial competitors see no sibling solution until both initial results
are complete. Prefer parallel research when duplicate implementation adds no value.
Concurrent implementations use separate **Orca** worktrees; verify the same base
and distinct paths. Sequential work may share a checkout with exclusive ownership.
When competition is justified, prepare the briefs with [competition.md](../prompts/competition.md).

## Explicit intelligence routing

Context may inherit. Intelligence configuration should be explicit.
Resolve each route with `multi-ai-cli route <target>` immediately before its
worker-start and paste the stdout verbatim; the command lists its own targets. It
quotes any model id a shell would rewrite, so do not strip that quoting. It
merges the installed policy with the host overrides, so a policy edit reaches the
next worker. Never reuse a route resolved earlier in the session and never
hand-assemble one from policy.yaml; a stale or retyped route is a routing error.
A non-zero exit resolved nothing: do not launch on a guess. If the command is
unavailable, read policy.yaml and the host policy directly, apply only known
route keys, and disclose that.

Competition uses its lane routes in place of ordinary role routes, keeping the
assigned role explicit; review uses the **actual maker's family** lookup.
Pass all three native options on each fresh worker-start:
`--agent`, `--model`, `--effort`. Set the assigned role explicitly in the task spec.
Do not pass unset values or let a configured role inherit launcher defaults.

Compare Orca's requested/effective launch settings; keep that provenance with the
Task. Model/family claims inside a worker report cannot establish the route.
A mismatch or unknown effective family requires investigation before counting
cross-family coverage. Reuse a terminal only when its proven agent/model/effort
and assigned role match the next task; otherwise start a fresh worker.
Orca cannot combine model/effort selection with terminal reuse. Terminal-less workers
use only a confirmed native reuse capability; otherwise settle/release and start fresh.

Use a configured fallback only after confirmed primary-route unavailability, following
native failed-attempt recovery; a timeout is not model unavailability. `route` cannot
know availability, so it never steps down on its own: ask for a rung with `--step`,
and read `--ladder` to see what a family outage leaves. Record the substitution
and any lost capability. For review, try the opposite-family primary
and fallback; if unavailable, use the configured same_family_fallback in a fresh
independent checker session. Record reduced diversity in the review and decision.
An absent same_family_fallback requires opposite-family coverage.
Explicitly required cross-family coverage still blocks approval if unavailable;
no available independent checker blocks approval, not useful investigation.
If competition loses a family, revise the approach and disclose the limitation;
do not describe same-family work as cross-family competition. Do not upgrade
ordinary engineering to a more expensive route without a policy justification.
Lead configuration applies when starting a Lead session; changing it cannot alter
the intelligence of an already-running session. Disclose a different existing
Lead configuration rather than pretending the file changed it.

## Reports and verification

Prepare a frozen role packet with [dispatch.md](../prompts/dispatch.md).
Read [context-delivery.md](context-delivery.md) for packing, scope drift or rollout.
Fill the brief with scope, base, acceptance, role, resources
and a unique absolute report path outside source/disposable worktrees, readable
by worker and Lead. Workers write [WorkerResult](../schemas/worker-result.schema.json)
or [ReviewResult](../schemas/review-result.schema.json), then reference the file with
`--report-path` on the live preamble's worker_done command. Keep its body short.
Orca records a path; it does not upload, validate or certify the JSON. Preserve
reports as evidence and do not overwrite a settled report during revisions.
Keep relevant raw logs and benchmark artifacts accessible beside the reports;
use existing check.result fields for concise observations and artifact paths.
Record checks not performed and their limitations in risks or residual_risk.
Retrieve detail on demand instead of copying full logs into each agent's context.

Match report IDs to the authoritative Dispatch and read the actual file.
WorkerResult ok means completed work; needs_revision/blocked means failure.
A completed review with CHANGES_REQUESTED still has a succeeded lifecycle outcome;
an incomplete review is failed. Neither lifecycle success nor changes_summary
is evidence that code is correct. Engineers run relevant builds, tests and benchmarks;
Reviewers independently inspect source, exit codes and outputs and reproduce
meaningful acceptance checks. The Lead assesses requirement coverage, evidence
sufficiency and unresolved risks, checking identity and exact snapshot against
Orca/Git state. It need not repeat a completed independent review or its checks.
High risk, conflicting observations or insufficient evidence require targeted
inspection or re-verification, performed by the Lead or assigned to a suitable
worker. Missing required evidence, malformed reports or unverifiable identity
prevents approval. A worker's summary alone is not evidence.
Choose acceptance checks by the specific failure they detect and the observation
that distinguishes failure from correct behavior. A passing command that does not
exercise the relevant behavior is not acceptance evidence.

Prepare independent review with [review.md](../prompts/review.md).
Maker != checker, including Lead-authored changes and a maker returning under a
new Dispatch/role. For a Lead maker, use its native Orca coordinator handle as
maker_id and record launch provenance with the Run; worker makers use Dispatch IDs.
Prefer a reviewer from the configured opposite family and verify the actual launch.
Code review identifies the **full Git commit SHA**; verify HEAD, agreed base/diff
and clean source state before and after checks. Any fix, rebase, squash, conflict
resolution or synthesis that produces commit B invalidates approval of commit A.
Review B before integration. Plans use ordinary candidate/report references and
null snapshots; they need no cryptographic receipt.

## Lead's judge phase

For reviewed changes or candidate comparisons, use [judge.md](../prompts/judge.md)
and emit [JudgeResult](../schemas/judge-result.schema.json). Direct changes exempt
from independent review end with checks and a report to the human, without JudgeResult.
Investigation alone can end with verified findings and no integration decision.
Decide from requirements, observed code, tests, benchmarks, reproducible evidence,
review findings and simplicity; worker confidence comes last. Never count votes.
Account for every blocking finding affecting the selection: resolved with fresh
review, rejected with reproducible counter-evidence, or unresolved and blocking.
Findings confined to rejected candidates remain in their rejection reasons with
evidence that they do not affect the selection; do not label valid findings false.
Missing/incomplete review or unresolved applicable blockers prevents integration.

SELECT is a plan/provisional choice. INTEGRATE requires independent review and
objective checks of that exact commit, with all blockers accounted for.
Within the authorized scope, continue through implementation, review, needed fixes
and verification without routine approval pauses. Stop and report an actual blocker,
an out-of-scope decision or the configured revision-round limit.
Only the Lead integrates through the authorized project workflow. Prefer
fast-forward of the reviewed commit; changed review scope/base or any new combined
commit requires renewed review and checks. Verify the actual integrated HEAD.
Keep the decision report beside the worker reports and reference its path in the
Run. Schemas validate structure; identity, evidence truth and snapshot equality
remain Lead checks.

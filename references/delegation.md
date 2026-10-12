# Delegation

Read only when starting a worker other than an independent reviewer, or when
weighing whether to start one. The [Lead workflow](lead-workflow.md) covers the
default path: the Lead builds, one reviewer checks, the Lead integrates.

## Does this session earn its place

Routing is one question per additional session, not a level:

> Can this session answer a useful question **without repeatedly synchronizing the
> evolving understanding of the main problem**, and can its answer be checked
> independently?

"Does this parser violate this fixed contract" separates: the contract does not move
while the answer is produced, and the answer stands on its own. "Implement the fix
while the correct lifecycle semantics are still being discovered" does not: each
experiment changes the next decision, so a Lead that only coordinates must relay
every discovery, repeat the investigation, or accept conclusions it cannot assess.
Understanding, editing and testing are one loop; a handoff placed inside that loop
costs more than it saves, whatever the size of the change.

Independent review is the standing exception. It is wanted precisely because the
checker must not share the maker's understanding, so the synchronization cost is
the point rather than the objection.

Before starting a worker, name three things in the Task: the gap, why another
context closes it, and the observable return. If you cannot name all three, do the
work in the current session.

## Lead and workers

The Lead implements by default, including complex work. Delegate bounded
implementation and fixes to an [Engineer](../roles/engineer.md) when a dispatch
earns its place by the test above, and group related execution into bounded worker
tasks to limit handoff overhead.

Prefer the session already holding the reproduction, measurement baseline or
established cause when its role and launch settings fit. Otherwise hand off those
facts and failed attempts. What a brief cannot carry is the surrounding search:
why one call became suspicious, which assumptions stay weak, why an alternative was
abandoned. Expect the worker to rediscover some of it. Context retention never
overrides reviewer independence or the fresh sessions required for competition.

Only the Lead creates workers; one generation, no grandchildren or worker-created
Runs. Workers report further work to the Lead. A live Dispatch preamble identifies
a worker even if its provider is normally used for Lead.
[Architect](../roles/architect.md), [Researcher](../roles/researcher.md) and
[Reviewer](../roles/reviewer.md) are read-only by default; fixes need an Engineer task.
These are role instructions, not an OS sandbox.

Architect and Researcher are dispatches for a named question, not standing roles.
Investigation the Lead can run in its own session stays there.

## Competition

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

Competition uses its lane routes in place of ordinary role routes, keeping the
assigned role explicit. Resolve them the same way as any other route; see
[Lead workflow](lead-workflow.md#explicit-intelligence-routing).
If competition loses a family, revise the approach and disclose the limitation;
do not describe same-family work as cross-family competition.

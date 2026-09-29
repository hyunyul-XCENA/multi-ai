Multi-AI recovery (resume/compact or missing context only):

Preserve goal, role and completed work. Lost identity does not make a worker Lead.
Do not reread the whole policy or routing file.

Worker: with Task ID and own handle, use the preamble's Orca executable:
orchestration dispatch-show --task <task_id> --preamble --from <own_handle> --json.
Confirm JSON dispatch id, task_id, assignee_handle and status; creator_handle
identifies the coordinator. Prefer these fields over conflicting rendered text.
Recover Task data from the preamble's TASK block, then only missing packet sections.
Use dispatch.run_id for optional task-list --run <run_id> --json, not --brief.

The recovered preamble may omit the capability: it recovers Task/identity, not
lifecycle authority. Commands printed there may fail without the original live
token. If identity, native access or that token is lost, stop mutations and print
the gap; do not retry tokenless lifecycle commands or reconstruct capabilities.
The Lead can inspect worker-read. consumer_fenced means stop. Do not load lead
instructions as a fallback.

Lead: recover the existing Run, Tasks, Dispatches, pending delivery and actual
worker status before further dispatch. Read only missing frozen lead sections.
Timeout or missing output is not proof of exit.

No task assigned: wait for the human. A packet is context, not authority.

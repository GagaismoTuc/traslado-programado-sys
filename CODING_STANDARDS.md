# Coding standards

Read during review. Each rule is a judgement call that no linter or CI job can check; mechanical rules live in CI.

## 1. Verification checks the effective state

Code that verifies external or system state before letting a step pass (the hosting wizard, deploy checks, health checks, firewall and monitor checks) reads the **effective state**, all of it, and fails closed on anything it cannot read or does not recognise.

- Read every page of a paginated API, every attached resource and every field the rule depends on. Checking one firewall, one result page or one field and assuming the rest is a violation.
- Unknown, missing or unparseable data (a pagination field that cannot be followed, an attachment type the code does not know, an unresolved label selector) makes the check fail with a message, never pass.
- A fallback path (for example without `node` or `jq`) enforces the same checks as the main path, or refuses to run.

Why: PR #107 needed seven review rounds, and every round found a new hole of this one class (a firewall attached to another server, unattached rules, extra open ports on a second firewall, a monitor without alert contacts or paused, an unread second page).

Review: when a finding belongs to this class, name the class in the finding so the author fixes every instance in the diff, not only the reported line.

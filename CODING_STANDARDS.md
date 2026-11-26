# Coding standards

Read during review. Each rule is a judgement call that no linter or CI job can check; mechanical rules live in CI.

## 1. Verification checks the effective state

Code that verifies external or system state before letting a step pass (the hosting wizard, deploy checks, health checks, firewall and monitor checks) reads the **effective state**, all of it, and fails closed on anything it cannot read or does not recognise.

- Read every page of a paginated API, every attached resource and every field the rule depends on. Checking one firewall, one result page or one field and assuming the rest is a violation.
- Unknown, missing or unparseable data (a pagination field that cannot be followed, an attachment type the code does not know, an unresolved label selector) makes the check fail with a message, never pass.
- A fallback path (for example without `node` or `jq`) enforces the same checks as the main path, or refuses to run.

Why: PR #107 needed seven review rounds, and every round found a new hole of this one class (a firewall attached to another server, unattached rules, extra open ports on a second firewall, a monitor without alert contacts or paused, an unread second page).

Review: when a finding belongs to this class, name the class in the finding so the author fixes every instance in the diff, not only the reported line.

## 2. The comment rule

Every code comment falls into one of four types, and each type says what to do with it:

| Type | Action |
|---|---|
| Tautology | Delete it. |
| Excuse | Delete it and open an issue to fix the implementation. |
| Stale | Delete it. |
| Decision Record | Move it to an ADR. |

Source: Matt Pocock, https://x.com/mattpocockuk/status/2123798388227403983.

The only comment allowed is a Decision Record that cites an ADR or an issue `#n`. `orca-stack lint` (the `orca-stack lint` CI job) applies the mechanical part of this rule in JavaScript, TypeScript, Go, Python and Shell; the reviewer applies the rest. Comments that predate the lint are listed in `.orca-stack-baseline.json` until someone removes them.

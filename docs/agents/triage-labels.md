# Triage labels

| Canonical role    | Repository label  | Meaning                                 |
| ----------------- | ----------------- | --------------------------------------- |
| `needs-triage`    | `needs-triage`    | Maintainer needs to evaluate this issue |
| `needs-info`      | `needs-info`      | Waiting for more information            |
| `ready-for-agent` | `ready-for-agent` | Fully specified and ready for an agent  |
| `ready-for-human` | `ready-for-human` | Requires human implementation           |
| `wontfix`         | `wontfix`         | Will not be implemented                 |

When a skill mentions a canonical role, use the corresponding repository label.

For a Wayfinder map using frontier labels, `ready-for-agent` means the issue is
open, unassigned, fully specified, and its native blockers and external prerequisites
are satisfied. Recheck the live graph before claiming it; remove the frontier label
on assignment. Follow [map operations](issue-tracker.md#work-through-an-existing-map)
for pagination, native child order, and assignment read-back.

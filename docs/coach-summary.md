# Coach-Facing Summary — Gateway Node Bootstrap

Paste the **Current Status** block below into your personal coach session.
Update it each week (or whenever the state changes meaningfully) using the
four fields described here.

Keep the block short: the coach needs to understand where you are and what is
next, not read a full project plan.

---

## How to fill it in

| Field | What to write | Target length |
|---|---|---|
| **Current phase** | The active implementation phase and its one-line goal | 1 sentence |
| **Current blocker** | The single biggest thing stopping forward progress right now; write "None" if unblocked | 1 sentence |
| **Next action** | The one concrete thing you will do this week to move the needle | 1 sentence |
| **Recovery confidence** | How confident you are that a fresh node can be recovered within the target time today | One of: 🔴 Low / 🟡 Medium / 🟢 High, plus a one-line reason |

---

## Current Status

> Copy this block into your coach session.  Replace each `<!-- … -->` comment.

```
Gateway Node Bootstrap — weekly status

Phase:      <!-- e.g. "Phase 4 — AMI hardening: eliminate manual Node.js install" -->
Blocker:    <!-- e.g. "None" or "AMI pipeline not yet set up; blocked on AWS account access" -->
Next action:<!-- e.g. "Add Node.js 20 to the EC2 user-data script and test on a clean instance" -->
Confidence: <!-- e.g. "🟡 Medium — bootstrap works but still requires 2 manual steps" -->
```

---

## Confidence scale

Use this to keep the rating consistent from week to week:

| Rating | Meaning |
|---|---|
| 🔴 Low | A fresh-node recovery would take > 1 hour or requires manual steps not yet documented |
| 🟡 Medium | Recovery works end-to-end but has known manual steps or untested paths |
| 🟢 High | Recovery is fully scripted, documented, and has passed an end-to-end drill in the last 30 days |

---

## History (most recent first)

Keep the last four entries so the coach can see the trend.

| Week | Phase | Blocker | Confidence |
|---|---|---|---|
| `YYYY-MM-DD` | | | |
| `YYYY-MM-DD` | | | |
| `YYYY-MM-DD` | | | |
| `YYYY-MM-DD` | | | |

---

*Sensitive details (instance IDs, bucket names, credentials) never go in this
file.  Keep them in encrypted ops notes.*

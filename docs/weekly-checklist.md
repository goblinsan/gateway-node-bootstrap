# Weekly Execution Checklist — Gateway Node Bootstrap

Use this checklist at the start of each week to keep the project moving without
creating busywork.  Fill it in, act on the two highest-leverage items, and
archive the completed copy (encrypted notes or a private ops doc — not git).

**Time to complete:** 10–15 minutes.

---

## Week of: `YYYY-MM-DD`

---

## 1. Current recovery milestone

> What is the specific, measurable goal for this sprint or recovery phase?

- Target: <!-- e.g. "Fresh node bootstrap in under 15 minutes end-to-end" -->
- Status: <!-- Not started / In progress / Blocked / Complete -->
- Days remaining to target date: <!-- or "No hard deadline" -->

---

## 2. Backup health check (5 minutes)

Run these before filling in any risks:

| Check | Result | Notes |
|---|---|---|
| CloudWatch alarm state | `OK` / `ALARM` / `INSUFFICIENT_DATA` | |
| `latest.json` updated within 25 h | Yes / No | |
| Last restore drill passed | Yes / No / Overdue | Date of last drill: |

If any check is ❌ (No or ALARM), add it to the Risks section below.

---

## 3. Open risks

List anything that could block recovery or cause data loss if it happened today.
Keep the list short — if it is longer than five items, triage and drop the low
ones.

| # | Risk description | Likelihood (H/M/L) | Impact (H/M/L) | Owner | Status |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |

---

## 4. Highest-leverage actions this week

Pick the **one or two** actions that will have the most impact on reducing
recovery time or risk.  Do not list more than two — this is a forcing function,
not a backlog.

| # | Action | Why it matters most right now | Done by |
|---|---|---|---|
| 1 | | | |
| 2 | | | |

---

## 5. Carry-overs from last week

> Did last week's actions actually get done?  If not, why?

- Action 1: <!-- Completed / Carried / Dropped — reason -->
- Action 2: <!-- Completed / Carried / Dropped — reason -->

---

## 6. Upcoming work (non-urgent, next 2–4 weeks)

Quick notes on what is coming up so it does not fall off the radar.

- <!-- e.g. "Schedule monthly restore drill for the last Friday of the month" -->
- <!-- e.g. "Bake Node.js into the AMI to eliminate the manual install step" -->

---

## 7. Coach update (optional)

If this week's state differs meaningfully from last week's coach summary,
update `docs/coach-summary.md` now.  Takes 2 minutes.

---

*Archive this filled-in checklist in your encrypted ops notes or private ops doc.
Never commit completed checklists with real instance IDs, bucket names, or
Postgres credentials to git.*

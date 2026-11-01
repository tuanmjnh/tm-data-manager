---
title: Scheduling
description: The headless worker, schedule kinds, timezones and overlap policy
section: automation
order: 5
updated: 2026-11-01
tags: schedule, worker, cron, timezone
---

# Scheduling

The worker is a headless process that runs independently of the GUI and triggers jobs on their schedule.

## Creating a schedule

```bash
udmt job add-export --name nightly-users --conn local-src --resource users \
  --format jsonl --compression gzip --schedule daily --hour 2 --timezone Asia/Ho_Chi_Minh

udmt worker run      # keep running in the background
udmt worker once     # a single pass, useful for cron/Task Scheduler
udmt worker status
```

In the UI, the **Schedules** tab creates jobs, toggles them on/off and shows the next fire time.

## Schedule kinds

| Kind | Options | Example |
|---|---|---|
| `once` | `--at <ISO time>` | Fire a single time |
| `interval` | `--every-minutes <n>` | Every 30 minutes |
| `daily` | `--hour`, `--minute` | 02:00 every day |
| `weekly` | `--weekday` + time | Every Monday |
| `monthly` | `--day-of-month` + time | The 1st of each month |

## Timezones and DST

Schedules use IANA timezones (for example `Asia/Ho_Chi_Minh`). Across a daylight-saving change the fire
time is recomputed against local wall-clock time, so it does not drift by an hour.

## Policies

- **Misfire** — a run missed while the machine was off is handled by `skip` (default) or
  `run_once_on_recovery`.
- **Overlap** — `forbid` by default: a new run is skipped while the previous one is still running.
- **Locking** — the worker holds a lock in the database, so two workers never execute the same job twice.
- **Recovery** — runs orphaned by a dead worker are marked `interrupted` on the next start.

> The worker does not need the GUI. As long as one `udmt worker run` process is alive (or `worker once`
> is wired into the OS scheduler), schedules keep firing.

---
mode: subagent
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2025-2026 Marcus Quinn -->
# TODO

Project task tracking with time estimates, dependencies, and TOON-enhanced parsing.

Compatible with [todo-md](https://github.com/todo-md/todo-md), [todomd](https://github.com/todomd/todo.md), [taskell](https://github.com/smallhadroncollider/taskell), and [Beads](https://github.com/steveyegge/beads).

## Format

**Human-readable:**

```markdown
- [ ] t001 Task description @owner #tag ~30m risk:low logged:2025-01-15
- [ ] t002 Dependent task blocked-by:t001 ~15m risk:med
- [ ] t001.1 Subtask of t001 ~10m
- [x] t003 Completed task ~30m actual:25m logged:2025-01-10 completed:2025-01-15
- [-] Declined task
```

**Task IDs:**
- `t001` - Top-level task
- `t001.1` - Subtask of t001
- `t001.1.1` - Sub-subtask

**Dependencies:**
- `blocked-by:t001` - This task waits for t001
- `blocked-by:t001,t002` - Waits for multiple tasks
- `blocks:t003` - This task blocks t003

**Time fields:**
- `~estimate` - AI-assisted execution time (~15m trivial, ~30m small, ~1h medium, ~2h large, ~4h major — see `reference/planning-detail.md`)
- `actual:` - Actual active time spent (from session-time-helper.sh)
- `logged:` - When task was added
- `started:` - When branch was created
- `completed:` - When task was marked done

**Risk (human oversight needed):**
- `risk:low` - Autonomous: fire-and-forget, review PR after
- `risk:med` - Supervised: check in mid-task, review before merge
- `risk:high` - Engaged: stay present, test thoroughly, potential regressions

<!--TOON:meta{version,format,updated}:
1.1,todo-md+toon,{{DATE}}
-->

## Ready

<!-- Tasks with no open blockers - run /ready to refresh -->

<!--TOON:ready[0]{id,desc,owner,tags,est,risk,logged,status}:
-->

## Backlog

- [ ] t004 SharedWorker runtime mode for WebLLM connector @themarcusquinn #feature #enhancement #plan ~30h risk:med logged:2026-04-07 ref:GH#4 plan:p001 status:blocked → [todo/PLANS.md#p001](todo/PLANS.md)
- [x] t005 Hook WebLLM into wpai_preferred_text_models filter @themarcusquinn #bugfix #auto-dispatch ~30m risk:low logged:2026-04-07 ref:GH#5 tier:simple pr:#14 verified:2026-04-08 → [todo/tasks/t005-brief.md](todo/tasks/t005-brief.md)
- [x] t006 Phase 2 — SharedWorker handler + MLCEngine wrapper @themarcusquinn #feature #auto-dispatch ~5h risk:med logged:2026-04-07 ref:GH#6 tier:standard parent:t004 pr:#15 verified:2026-04-08 → [todo/tasks/t006-brief.md](todo/tasks/t006-brief.md)
- [x] t007 Phase 3 — Floating widget UI + state machine @themarcusquinn #feature #auto-dispatch ~7h risk:med logged:2026-04-07 ref:GH#7 tier:standard parent:t004 pr:#16 verified:2026-04-08 → [todo/tasks/t007-brief.md](todo/tasks/t007-brief.md)
- [x] t008 Phase 4 — Bootstrap, injector, capability detection @themarcusquinn #feature #auto-dispatch ~3h risk:low logged:2026-04-07 ref:GH#8 tier:standard parent:t004 pr:#17 verified:2026-04-08 → [todo/tasks/t008-brief.md](todo/tasks/t008-brief.md)
- [x] t009 Phase 5 — Settings + connector card UI update @themarcusquinn #feature #auto-dispatch ~3h risk:low logged:2026-04-07 ref:GH#9 tier:standard parent:t004 pr:#17 verified:2026-04-08 → [todo/tasks/t009-brief.md](todo/tasks/t009-brief.md)
- [x] t010 Phase 6 — apiFetch middleware integration @themarcusquinn #feature #auto-dispatch ~5h risk:med logged:2026-04-07 ref:GH#10 tier:standard parent:t004 pr:#18 verified:2026-04-08 → [todo/tasks/t010-brief.md](todo/tasks/t010-brief.md)
- [ ] t011 Phase 7 — Cross-browser testing + dedicated-tab fallback @themarcusquinn #testing ~4h risk:med logged:2026-04-07 ref:GH#11 tier:standard parent:t004 human-only → [todo/tasks/t011-brief.md](todo/tasks/t011-brief.md)
- [ ] t012 Phase 8 — Docs, .distignore, readme updates @themarcusquinn #docs #auto-dispatch ~2h risk:low logged:2026-04-07 ref:GH#12 tier:simple parent:t004 blocked-by:t011 → [todo/tasks/t012-brief.md](todo/tasks/t012-brief.md)

<!--TOON:backlog[3]{id,desc,owner,tags,est,risk,logged,status,parent,blocked_by}:
t004,SharedWorker runtime mode for WebLLM connector,@themarcusquinn,feature/enhancement/plan,30h,med,2026-04-07,blocked,,
t011,Phase 7 — Cross-browser testing + dedicated-tab fallback,@themarcusquinn,testing,4h,med,2026-04-07,available,t004,
t012,Phase 8 — Docs distignore readme updates,@themarcusquinn,docs/auto-dispatch,2h,low,2026-04-07,blocked,t004,t011
-->

## In Progress

<!--TOON:in_progress[0]{id,desc,owner,tags,est,risk,logged,started,status}:
-->

## In Review

<!-- Tasks with open PRs awaiting merge -->

<!--TOON:in_review[0]{id,desc,owner,tags,est,pr_url,started,pr_created,status}:
-->

## Done

<!--TOON:done[6]{id,desc,owner,tags,est,actual,logged,started,completed,status}:
t005,Hook WebLLM into wpai_preferred_text_models filter,@themarcusquinn,bugfix/auto-dispatch,30m,,2026-04-07,,2026-04-08,done
t006,Phase 2 — SharedWorker handler + MLCEngine wrapper,@themarcusquinn,feature/auto-dispatch,5h,,2026-04-07,,2026-04-08,done
t007,Phase 3 — Floating widget UI + state machine,@themarcusquinn,feature/auto-dispatch,7h,,2026-04-07,,2026-04-08,done
t008,Phase 4 — Bootstrap injector capability detection,@themarcusquinn,feature/auto-dispatch,3h,,2026-04-07,,2026-04-08,done
t009,Phase 5 — Settings + connector card UI update,@themarcusquinn,feature/auto-dispatch,3h,,2026-04-07,,2026-04-08,done
t010,Phase 6 — apiFetch middleware integration,@themarcusquinn,feature/auto-dispatch,5h,,2026-04-07,,2026-04-08,done
-->

## Declined

<!-- Tasks that were considered but decided against -->

<!--TOON:declined[0]{id,desc,reason,logged,status}:
-->

<!--TOON:dependencies-->
<!-- Format: child_id|relation|parent_id -->
<!--/TOON:dependencies-->

<!--TOON:subtasks-->
<!-- Format: parent_id|child_ids (comma-separated) -->
<!--/TOON:subtasks-->

<!--TOON:summary{total,ready,pending,in_progress,in_review,done,declined,total_est,total_actual}:
9,1,2,0,0,6,0,59h30m,
-->

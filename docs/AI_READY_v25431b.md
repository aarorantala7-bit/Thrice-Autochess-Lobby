# Thrice Autochess v0.25.4.31b - AI Ready server hotfix

- AI participants now acknowledge preparation, pre-battle sync, results, and special shop as individual Ready actions.
- The server now counts bot + human Ready acknowledgments in the same match/round/phaseRevision.
- Preparation and pre-battle synchronization always honor server-owned deadlines; Ready cannot trigger combat early.
- Player data, PostgreSQL profiles, combat results, and local game timers unchanged.
- Regression QA: https://github.com/aarorantala7-bit/Thrice-Autochess-Lobby/actions/runs/42779066487
- Rollback: backup/2026-11-10-pre-ai-ready

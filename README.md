# Thrice Autochess — Online Lobby and Shared Match Test

This repository hosts the **test-only** online lobby and temporary match-action synchronization server for Thrice Autochess.

## What currently works

- Create and join six-digit tournament or **Normal 1v1 friend** lobbies
- **Normal 1v1 solo** automatic opponent matching
- **Ranked 1v1 solo-only** matching (no friend/party queue)
- Tournament parties, Ready checks and queue controls
- Ranked tournament friends limited to one rank tier difference
- A server-side **temporary match instance** for each queued game
- Validated `buy`, `move`, `sell`, `ready`, `emote`, `forfeit`, and test phase changes
- Players only control their own dice; shared state is polled roughly once per second
- Server processes actions in sequence and exposes recent actions for all match participants
- Active match is removed immediately on completion; its small result receipt expires after two minutes
- Inactive matches expire from memory automatically

## Current limitations

**This is not full synchronized Thrice Autochess combat.** The online page is a minimal test interface for shared actions, not the complete game. Automatic combat, match rewards, actual Ranked Points/MMR, persistent match history and server-authoritative fight outcomes must be connected later.

The test server has no persistent database or permanent player accounts. Room data, test rank and MMR values are temporary and supplied by clients. The free Render service can sleep/restart, which clears running lobby and match instances. The host can end a *test* instance, but real competition will need a fully authoritative engine and user authentication.

Avoid entering sensitive or personally identifying information in the test-name field.

## Using the hosted test

Open https://thrice-autochess-lobby-test.onrender.com on two devices:
- **Friend 1v1:** Choose Normal 1v1, Create Lobby, share six-digit code. Friend joins, both Ready, host queues.
- **Normal or Ranked Tournament:** Create a tournament lobby, invite players, mark Ready and queue.
- **Normal 1v1 automatic search:** Tap the dedicated Normal 1v1 random-opponent button.
- **Ranked 1v1:** Tap Ranked 1v1 automatic search. There is no friends-only option for Ranked.
- Once the shared match test opens, buy/move/sell test dice and watch changes appear on both devices.

## Run locally

Node.js 20+:

```sh
npm start
```

Open http://localhost:8765.

## Server API (test only)

- `POST /api/create`, `POST /api/join`, `GET /api/lobby/:code`
- `POST /api/ready`, `POST /api/queue`, `POST /api/cancel`, `POST /api/leave`
- `POST /api/soloQueue`, `POST /api/soloStatus`, `POST /api/soloCancel`
- `POST /api/matchState`: `{matchId,token,since}`
- `POST /api/matchAction`: `{matchId,token,action,since}`
- `GET /health`

Room creation issues an unguessable session token. Match state requires that token. The active match instance and its events are kept in memory and removed on completion. Recent completion receipts are temporary.

## Deployment

The repository is hosted as a Free Render Node web service in Frankfurt. The `render.yaml` Blueprint provides configuration for future reproducible deployments. The latest GitHub code may require a manual deploy if the repository was linked through a public Git URL without a GitHub webhook.

## Tests

GitHub Actions runs `test/live-actions.mjs` against the public Render URL, covering two-player synchronization, ownership restrictions, 1v1 matchmaking policies, and match instance cleanup.

# Thrice Autochess — Lobby Test

This is a **test-only shared lobby server** for Thrice Autochess.

## Current capabilities
- Public HTTPS lobby test page after deployment.
- Six-digit codes for Create Lobby / Join Lobby.
- Ready checks, lobby host Join Queue / Cancel Queue, and live member lists.
- Solo queue without a Ready requirement.
- Ranked party member restrictions (maximum one rank tier apart).

## Important limitations
- **Game battles are NOT synchronized between devices.** This only tests shared lobbies.
- No account authentication, payments, persistent database, or real player matchmaking.
- Room/member data lives in memory and disappears after a server restart or inactive expiry.
- Don't use real names or personal information as test nicknames.

## Deploy to Render
- The `render.yaml` blueprint uses the **free** web service in **Frankfurt**.
- Deploy this repository as a Render Blueprint, or create a Node Web Service:
  - Build: `npm install`
  - Start: `npm start`
  - Health check: `/health`
- Visit your Render service URL on both devices.
- One player creates a lobby and shares the six-digit code.
- Another player selects Join by Code.

## Run locally
Node.js 20 or newer:

```
npm start
```

Open http://localhost:8765 on the host. For LAN testing, open the host machine's IP address and port from other devices on the same network.

## Next development step
Integrate this shared lobby API with the full Thrice Autochess client. A separate authoritative game server will be necessary for real synchronized multiplayer battles.

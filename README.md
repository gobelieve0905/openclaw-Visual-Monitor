# OpenClaw Agent Health Dashboard

Real-time dashboard for monitoring two OpenClaw agents (`main`, `work`) and key dependencies.

## Features
- Live status cards for:
  - OpenClaw gateway service
  - sing-box service
  - local proxy port `127.0.0.1:7890`
  - `main` / `work` agent probe status
  - Telegram bot API reachability (daily/work)
  - OpenAI relay (`aixj`) reachability
- Error metrics from OpenClaw logs (5-minute window):
  - network connection errors
  - timeout/failover errors
- Real-time updates via SSE (`/api/stream`)
- History retained in `data/history.json`

## Run
```bash
cd /home/ubuntu/.openclaw/workspace/openclaw-health-dashboard
/home/ubuntu/.openclaw/tools/node-v22.22.0/bin/node server.js
```

Open: `http://<server-ip>:19101`

## Endpoints
- `GET /api/health`
- `GET /api/history?limit=120`
- `GET /api/stream` (SSE)

## Notes
- Agent deep probe uses local OpenClaw invocation and is configurable by env:
  - `PROBE_INTERVAL_MS` (default `300000`)
  - `POLL_INTERVAL_MS` (default `10000`)

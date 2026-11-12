# Running the workforce on a server

The desktop app runs the workforce only while it is open. To have agents take
tickets, run schedules and read the team's learning queue when nobody's
computer is on, run the web build of sshS3 as a server. It is the same hub:
the same board, the same rules, the same safety policy.

Nothing about the board changes. A server is one more installation that
shares the team bucket; a ticket is checked out by whichever installation
claims it first, so the server and your apps do not run the same ticket twice.

## Start it

```bash
docker compose up -d --build
```

`docker-compose.yml` sets `SSHS3_WORKFORCE=1`, which starts every user's
background work when the server starts. Without it a user's hub starts when
they first log in after a restart, and stops mattering to a server nobody
visits.

| Variable | What it does |
| --- | --- |
| `SSHS3_WORKFORCE=1` | Start every user's hub at server start. |
| `SSHS3_DATA_DIR` | Where users, settings and history are kept. Mount a volume. |
| `SSHS3_ADMIN_USER`, `SSHS3_ADMIN_PASSWORD` | Create the first user at start instead of in the browser. |
| `SSHS3_MASTER_KEY` | Encrypts stored credentials. Unset, a key is generated in the data directory. |
| `SSHS3_WEB_PORT`, `SSHS3_WEB_HOST` | Where it listens. |

Put it behind TLS and do not expose it to the internet as it is: it holds
credentials and can run commands on your systems.

## Set it up, once

Open the server in a browser and log in as the user the workforce should run
as. Then:

1. **Connect the team bucket** (start page, Invite / team). This is what makes
   the server see the same board, agents, runbooks and memory as your apps.
2. **Connect a model** (AI settings). The server calls the model with this
   key; it does not use the key in anybody's desktop app.
3. **Turn on Heartbeat** in the Workforce view. From then on the server takes
   the oldest ticket in To do that has an agent and can run, one at a time.
4. Give the server's SSH key access to the systems the agents work on, or add
   the servers with their own credentials, as you would in the app.

## Alerts

In the Inbox, open "Alerts in" and create an address. Point your monitoring at
it: an Alertmanager `webhook_configs` url, a Grafana webhook contact point, a
PagerDuty webhook, or anything that can post JSON with a `title` or `message`.
Each alert becomes a ticket; with the heartbeat on, an agent starts on it at
once, critical alerts first. The address is the key: it is shown once, and
"Replace the address" makes the old one stop working. Keep the server behind
TLS, or the address travels in the clear.

## What to know

- **Modes still apply.** An agent set to ask before commands waits for a
  person, also on the server: the ticket sits in progress until somebody
  opens the server (or the run times out). For unattended work use agents
  that only report, or agents that run on their own, with the safety switches
  on. Destructive commands and, by default, changes on production still stop
  for approval.
- **Budgets hold across installations.** Spending is counted per installation
  and added up, so the server and the apps share each agent's monthly budget.
- **External coding agents** (Claude Code, Codex) run where their runner is
  set up. To run them on the server, install the agent in the image, sign it
  in, and add the runner on the server with the folder of the checkout. The
  provided image does not include them.
- **MCP servers and schedules are per installation.** An MCP server an agent
  needs must be added on the server too. A schedule runs where it was created.
- **One server per team is enough.** Two would work (claims decide who runs a
  ticket) but gain nothing.

## Not verified

The server start-up path is covered by a test, and the board by tests with
stubbed model responses. A real deployment with a real bucket, a real model
and days of unattended heartbeat has not been run.

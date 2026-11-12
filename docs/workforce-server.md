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

## Notifications, and answering from a phone

An agent that asks before a command waits for a person. So that somebody
knows: under Settings → Notifications, add a channel (Slack incoming webhook,
Microsoft Teams webhook, ntfy, or any address that takes a JSON POST). When
something starts to wait in the inbox, the channel is told once, with who asks,
what, on which target, the risk, and a link to the item.

- Set the address people reach the server at, in the same place or with
  `SSHS3_PUBLIC_URL` (which then cannot be changed in the interface). Without
  it notifications carry no link.
- The link opens the inbox on that item. The interface has a phone layout and
  can be added to the home screen. Approving needs a signed-in session; there
  are no approve-by-link tokens.
- **Only the person whose agent asks can approve.** Each user of the server
  has their own agents and inbox. A notification in a shared channel says
  whose answer is awaited; a teammate who opens the link sees their own inbox.
- How long an agent waits is set under Settings → Safety (10 minutes unless
  changed, at most 60). The wait does not use up the run's time budget.
- A channel's address is a secret: it is stored encrypted in the user's own
  data directory, never in the team bucket, and the interface only ever shows
  its host.
- The server will not post to itself or to link-local addresses (the cloud
  metadata address among them). A channel on the server's private network,
  such as an ntfy container beside it, needs `SSHS3_NOTIFY_ALLOW_PRIVATE=1`.
- Notifications are posted directly, not through an HTTP proxy: the server
  needs a route to the channel.

## What to know

- **Modes still apply.** An agent set to ask before commands waits for a
  person, also on the server: the ticket sits in progress until somebody
  answers (see Notifications above) or the wait runs out. For unattended work use agents
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

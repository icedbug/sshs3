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
  such as an ntfy container beside it, needs `SSHS3_ALLOW_PRIVATE_ADDRESSES=1`.
- Notifications are posted directly, not through an HTTP proxy: the server
  needs a route to the channel.

## What is on the servers, and what changed

Under Infrastructure, "Read the servers on a schedule" lets the server read
each machine every few hours with read-only commands (system, packages,
services, ports, disks, certificates, a list of configuration files) and keep
what is different from last time. An agent that troubleshoots a machine is
given what changed there, and so is the ticket of an alert about it. The
server reads with its own key or agent; a machine that needs a password or a
touch is not read from the server. With a team bucket the result is shared, and
a machine is read by one installation, not by each.

## Your own agent asking this server (MCP)

Claude Code, Cursor, Codex and anything else that speaks MCP can ask this
sshs3 about the team's systems. Open your account window and make a key under
"Keys for your own agents"; it is shown once, with the line to paste:

```bash
claude mcp add --transport http sshs3 https://your-server/api/mcp --header "Authorization: Bearer s3k_…"
```

What a key may do is chosen when it is made. Reading is always allowed: the
servers, what was last read from each, what changed there, what depends on
what, the knowledge base, and the board. Writing tickets is a separate choice;
a ticket made this way goes to the backlog, says it came from outside, and
starts nothing by itself.

A key may also be allowed to **ask** for a command, and then only on the one
server you name when you make it. What that is held to:

- Nothing runs when the agent asks. The command appears in your inbox, with
  the line the agent wrote about why, and waits for you.
- Every one of them waits, including a read-only command that an agent inside
  sshs3 would be allowed to run unasked. Nobody here is watching whoever asked.
- It runs in the terminal that is already open for that server, and nowhere
  else. If nothing is connected to it, the answer says so instead of borrowing
  another terminal.
- One command per request, and the agent is told to ask `command_status`
  rather than ask again.
- `change_with_check` carries the check that shows the change worked and the
  command that takes it back, and takes it back by itself if the check fails —
  the same path a change made inside sshs3 takes.

A key acts as the person who made it and sees exactly what they see. It is
kept as a hash, so it cannot be read back; "Take it back" stops it at once.

What the endpoint does and does not do:

- It takes the key in the `Authorization` header and nothing else. A session
  cookie is not a key: being signed in in a browser does not let that page act
  as you.
- A request that carries an `Origin` header is refused before the key is read.
  A browser sends one and an agent does not, so this closes the attack where a
  web page makes its own name resolve to a machine on your network. With
  `SSHS3_MCP_HOSTS` set, the `Host` of the request is checked too.
- It speaks both the protocol clients use today and the newer revision
  (2026-07-28), which has no handshake and no sessions. Which one a request
  belongs to is read off the request itself.
- One key is held to a rate. `SSHS3_MCP=0` switches the whole endpoint off,
  and it then answers as if it were not there.

Checked against both official MCP clients over real HTTP. Not checked: Claude
Code, Cursor and Codex themselves, and the newer protocol against anything but
the SDK that implements it.

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
- **A key is per person, and only for this server.** It is not shared through
  the team bucket, and it gives no more than the person could do themselves.
- **MCP servers and schedules are per installation.** An MCP server an agent
  needs must be added on the server too. A schedule runs where it was created.
- **One server per team is enough.** Two would work (claims decide who runs a
  ticket) but gain nothing.

## Not verified

The server start-up path is covered by a test, and the board by tests with
stubbed model responses. A real deployment with a real bucket, a real model
and days of unattended heartbeat has not been run.

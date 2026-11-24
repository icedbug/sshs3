# The test lab for sshs3's AI workspace

The lab tests the agent the way a person uses it. It runs real servers in Docker on one Linux machine
and gives the agent real faults on them. It drives the shipped web server (`dist-web/server.mjs`)
through its own page connection, then grades each run by the state of the servers.

## What is in it

- **The fleet.** One container per server, with systemd, sshd, cron and syslog: `bastion-01`,
  `web-01` and `web-02` (nginx), `app-01` (the shop API), `db-01` and `db-02` (PostgreSQL 16 with a
  replica), `cache-01` (Redis) and `s3-01` (S3 storage). A lab is built once and saved as golden
  images. A reset brings every server back in about half a minute. Lab `n` uses `10.77.n.0/24`.
- **The model proxy.** Every model call goes through it, under the name of its run. It logs the
  call and its tokens, never the key, and it can answer 429, answer 500 or cut a stream on purpose.
  The product reaches it over https at the lab network's gateway, with a certificate from the lab's
  own CA.
- **The tasks** (`scenarios/`). Each one says what is broken and how, what the person writes, a known
  solution, the checks that say it is solved, and the checks that say nothing else was hurt. A task
  counts only after `validate` shows it right three times in fresh labs.
- **The runner and the grading.** One run resets the lab, puts the fault in and starts a fresh web
  server with three accounts. The agent gets the request in a terminal of the task's server. The
  lab's people answer what the agent asks to change. Then the run is graded on outcome, damage,
  rule breaks, risky plain commands, planted secrets found in model requests or stored data,
  injected instructions followed, cost and honesty.
- **Campaigns.** Every task with every model, a number of times, one worker per lab, from a queue
  file that survives a restart. Each campaign ends with a report.

## Commands

| What | Command |
| --- | --- |
| Bring lab 1 up (built the first time) | `npm run lab:up -- 1` |
| Reset it, check it, take it down | `npm run lab:reset -- 1`, `npm run lab:status -- 1`, `npm run lab:down -- 1` |
| Show that tasks are right | `npm run lab -- validate --times 3 [--scenario <id>,<id>] [--lab 1]` |
| One graded run | `npm run lab -- run --scenario nginx-bad-config --model gpt-6.2-sol [--mode assisted] [--lab 1]` |
| A campaign | `npm run lab -- campaign --name pass1 --models gpt-6.2-sol,gpt-6-luna --times 1 [--labs 1,2]` |
| Its report | `npm run lab -- report --name pass1` |
| The lab's own tests | `npm run lab:test` and `npm run lab:typecheck` |

Results go to `$LAB_RESULTS`, or to `lab/.state/results` when that is not set. Each run gets its own
folder with `run.json`, `transcript.md`, `events.jsonl`, `model.jsonl` and `grade.json`.

## Rules the lab keeps

- Nothing leaves the machine except model calls to the provider and package or image downloads.
- The provider key is never written anywhere. The product gets a dummy key, `lab-<runId>`, which
  names the run in the proxy's log. The environment's own proxy puts the real key in.
- The secrets planted in the lab are random per lab build and stay in `lab/.state/`, which is not
  committed. The same goes for the lab's keys and results.
- Every run counts. A run that crashed, stopped or hit a provider error is recorded as such, and the
  report lists it.

## Limits on this machine

- Kubernetes (kind) cannot run here, so the Kubernetes tasks are left out, with the reason in
  `lab/.state/k8s-<n>.reason`.
- A service's memory limit is not enforced inside these containers, so there is no task where a
  service is killed for running out of memory.
- In the lab, `/etc/hosts` is a file Docker mounts. It can be written in place, but `sed -i` cannot
  replace it.

# sshs3 AI Hub — architecture and implementation status

The AI Hub from the `codex/ai-hub` branch is merged into the main sshs3 code
base (0.97.x): the same `src/main/ai/hub/` services run in the desktop app, in
every tenant of the multi-user Web Server and in demo mode. The pinned
**native Hermes Desktop** host described further down is an optional,
explicitly enabled presentation on top of the same terminal authority.

## Runtime modes

- **Built-in AI Hub (default).** `src/main/desktopEntry.ts` loads
  `src/main/index.ts`, which builds the hub with `createHub(ipcBridge, …)` and
  serves it on the single `HUB_CHANNEL` (`ai-hub:request`) IPC handler in
  `IpcBridge.ts`. The renderer talks to it through `window.multissh.aiHubRequest`
  (`src/renderer/src/lib/aiHub.ts`, `components/AiHub/AiHubPanel.tsx`,
  `components/LandingView.tsx`).
- **Web Server.** `npm run build:web` bundles `src/main/web/serverEntry.ts` into
  `dist-web/server.mjs` (`npm run start:web`). `WebTenantManager` creates one
  isolated set of stores per user — profiles, K8s profiles, Team Vaults,
  snippets, settings — and its own `createHub(…)` instance, so memories,
  knowledge base and agent runs never cross tenants. `electronShim.ts` stands in
  for the Electron APIs (including `nativeImage.createFromBuffer`/`resize`), and
  the browser builds the same `MultiSSHApi` from
  `src/shared/ipc/createMultiSSHApi.ts` over WebSocket (`webClientBridge.ts`).
- **Demo mode.** Decided once at launch (`--demo`, `npm run demo` or
  `SSHS3_DEMO=1`; `src/main/demo/demoMode.ts`) and never persisted. A demo
  process uses its own `demo-workspace` data directory, the `demo-…` fixtures in
  `src/main/ai/hub/demoWorkspace.ts` (virtual PTYs, `DemoStorageProvider`, demo
  knowledge base and MCP servers) and `outwardSync.ts` turns off S3 workspace,
  Team Vault and remote profile sync. Outside demo mode the hub starts from the
  neutral defaults in `src/main/ai/hub/builtins.ts`, and demo-only memories,
  infrastructure edges and knowledge base documents are never written to the
  real `hub.json`.
- **Native Hermes Desktop (opt-in).** Only when `SSHS3_FORCE_NATIVE_HERMES=1` is
  set and the pinned build is staged does `desktopEntry.ts` start the original
  Hermes Desktop GUI; see [Native Hermes Desktop host](#native-hermes-desktop-host).

## AI Hub services (`src/main/ai/hub/`)

- **`HubService`** — the request/action handler (`request(HubRequest)`),
  agent runs, scheduler and snapshot. The agent tool implementations (`sshs3_*`
  tools and MCP calls) are in `AppActions.ts`; they reach the hub only through
  `HubService.appActionHost()`, which lists the hub members a tool call may
  use. Response parsing, the instant inline suggestions and the scripted demo
  tool answers are in `hubHelpers.ts`. It reaches the
  host app only through the `HubHost` interface that `createHub.ts` implements
  (profiles, Team Vault workspace data, snippets including built-ins, storage
  providers, settings).
- **`DirectAgentRuntime`** — the agent loop for OpenAI Codex (`/responses`),
  OpenAI-compatible (`/chat/completions`) and Anthropic (`/v1/messages`)
  providers. `maxOutputTokens`, `temperature` and `reasoningEffort` from the AI
  configuration are forwarded to every provider, and attached images are sent to
  all three. Fallback models come from `DEFAULT_AI_MODELS` in
  `src/shared/types/ai.ts`.
  The Anthropic loop uses prompt caching: the instructions are a system block
  of their own with a cache breakpoint, the per-run workspace snapshot follows
  it, and a top-level `cache_control` moves the conversation breakpoint each
  tool turn. It sends no `temperature` (current Claude models reject sampling
  parameters) and reports the run's tokens summed over all turns, input read
  from `message_start` including cache writes and reads. A run may only call
  the tools it was offered.
- **`AgentDiscipline`** — what keeps a run on the rails, for all three
  providers and without a model call of its own:
  - *Operating instructions* (`operatingInstructions`): a way of working
    instead of a feature catalogue. Classify the request (question,
    investigation, change, app configuration), read what the team already
    knows, evidence before action, one change at a time with its check, finish
    with a report. They claim only the abilities the run has.
  - *Task list* (`todo_write`, kept by the run, stored as `task.todos`, shown
    in the conversation): the call replaces the list; one item in progress; a
    cancelled or blocked item needs its reason. The list carries over to the
    next reply of the conversation.
  - *Held to it* (`continuationMessage`): when the model ends a turn without a
    tool call, the run sends it back if items are still open, if thorough mode
    has no list, or if something was changed and no `terminal_verify` has
    passed since (a command counts as a change by the same classification the
    approval prompt uses). Each is bounded, so a stuck run can end.
  - *Thorough mode*: `ultrawork` / `ulw` in the request adds a section to the
    instructions, asks for a task list and doubles the turn budget.
  - *What the team knows about a failure* (`failureHints`): a failed command's
    result carries the team memories and skills that match it (exact error
    signature first, else at least three distinctive shared words).
  - *Investigators* (`sshs3_investigate`, `HubService.investigate`): the
    agent hands one to four precise questions to read-only runs that look in
    parallel (three at a time), each with a fresh context,
    `workspace_context`, `sshs3_kb_search` and `sshs3_storage_ops`, and, when
    one can be opened, a terminal of its own on the asking run's target where
    only read-only commands run; it gets their reports back together, a
    failed one with its error. They cannot delegate. Stopping the asking run
    stops them, and what they spend is put down to the asking agent.
  - *Compaction*: when everything sent (the transcript and the tool
    definitions) passes about half the context window (`compactAtChars`),
    and the run itself has grown by enough for a note to replace, the agent
    is asked, between tool rounds, for a handover note to itself (the note is
    not shown in the chat); the next request then starts from the original
    conversation plus that note, its task list and a digest of its last twelve
    tool calls, and replays nothing else. No earlier message is edited, which
    is the shape that stays valid with models that bind their thinking to the
    conversation, and it is the same for all three providers. If the agent
    calls a tool instead of writing the note, it is asked again after that
    round.
  - *Earlier conversations* (`sshs3_session_search`): the agent can search
    this user's own earlier conversations (every word must appear; newest
    first, with the matching lines) and read one in full, with its task list
    and the commands and their results. Runs the hub started itself and the
    current conversation are left out.
  - *A fast model for background work* (`fastModel` in the AI configuration):
    the hub's own runs (investigators, workforce reviews, reading for memory)
    are started on it when it is set and the run uses the configured
    provider; conversations keep `model`. A background run that fails on the
    fast model is run once more on the main model (`mainModelOnly`). Every
    task records the model it ran on (`task.model`).
  - *Passing provider errors*: 408/429/5xx/529 and network errors are tried
    again up to three times with backoff, honouring `retry-after`; a rejected
    request (4xx) is not.
- **`PlanMode`** — plan first, then act. The agent proposes a plan with
  `sshs3_plan_propose` when the user asks for one (`/plan` in the request) or
  on its own for a risky change. A plan has a goal and steps, each with
  target, exact command, risk, the check that shows it worked and, above low
  risk, a rollback; a plan without these is refused with the reason, and a
  destructive command cannot be called low risk.
  - *Review*: before the user sees it, a separate read-only run on the main
    model checks the plan against the workspace and answers `approve` or
    `revise` with findings. An answer that cannot be read, or a review that
    could not run, is `unreviewed`, never an approval. The planning agent is
    told the findings; a fourth version without an approval is refused.
  - *The gate* (`planGate`, in the run loop before the broker): while a plan
    is proposed, while a sent-back plan is being revised, and in a request
    that asked for a plan and has none approved, commands that change
    something and file writes are refused; reading is allowed.
  - *The decision* (`plan-decide`, the plan card in the conversation):
    approving sets the agent's task list to the plan's steps and sends it to
    carry them out; sending it back with a note has the agent revise;
    declining without a note drops the plan.
  - *What approval covers* (`planCoversCommand`, in `ToolBroker.authorize`):
    the exact command of a step that has not run yet is not asked about
    again. Anything else, a second run of the same command, and any
    destructive command are asked about as usual.
- **`KnowledgeBaseService`** — lexical search with `@orama/orama` (BM25, typo
  tolerance and a hand-written Swedish/English synonym table) and, when the
  provider is an OpenAI-compatible endpoint with `embeddingModel` set, ranking
  by meaning as well: `searchHybrid` embeds the query and the chunks through
  that endpoint's `/embeddings` (`EmbeddingIndex` caches vectors by content
  hash in `kb-embeddings.json`, vectors only) and fuses both rankings by
  reciprocal rank fusion. `sshs3_kb_search` reports which was used
  (`retrieval: "hybrid" | "lexical"`) and why embeddings were not, if they
  failed. ChatGPT/Codex sign-in and Anthropic have no embeddings endpoint, so
  search is lexical there. Also memory ranking and ingestion of
  runbooks from a real S3 storage profile (`kb-ingest-s3` →
  `ingestFromStorageProvider`). The demo StorageGRID documents are used only for
  demo targets.
- **`SelfLearningService`** — learns a fix from a failed command followed by a
  successful one (`learnFromCommandResolution`), writes post-task playbooks
  (`reflectOnCompletedTask`), consolidates memories (`runReflectionCycle`),
  discovers topology edges and applies memory feedback. Commands, snippets and
  output are masked with `privacy.ts` before they are stored; counters and events
  persist in `HubStore` (`selfLearningState`).
- **`TerminalRegistry` / `ToolBroker` / `shellAdapters`** — terminal authority:
  correlated `OSC 777;SSHS3;<nonce>;BEGIN … END;<exit>;<cwd>` framing and
  `OSC 133;D;<exit>` shell integration. A successful command reports the failure
  it resolved (`resolvedFailure`), which drives self-learning for both agent and
  human commands.
- **`CommandSafetyService`** — reads a command the way a careful reviewer
  would, classifies it as safe, modifying or destructive and applies the
  `SafetyPolicyConfig` (`autoApproveSafeReadOnly`, `requireApprovalOnProdTags`,
  `blockDestructiveWithoutConfirm`), including file writes on `prod`-tagged
  servers. It splits on every operator (`;`, newline, `&&`, `||`, `|`, `|&`
  and a single `&`), follows quotes including `$'…'`, and looks into `$(…)`,
  backticks, `<(…)`, `bash -c`, `eval`, `find -exec` and `xargs`. It takes
  away what only runs something else (`sudo`, `env`, `timeout`, `nice`,
  `nohup`, `xargs`, `FOO=1`) and judges the program that runs on its own
  arguments, never the raw text — so `grep reboot /var/log/syslog` is a
  search and `env userdel root` is not read-only. Read-only is a list of
  known forms with their writing flags excluded (`sort -o`, `sed -i`/`w`,
  awk's `system()`, `ip link set`, `curl -XDELETE`, `2>file` …). Anything
  not on the list, or nested more than six deep, is "modify"; a command that
  never ends by itself (`tail -f`, `less`, `watch`) is not run unasked. It is
  still a set of rules, not a shell: `tests/main/commandClassifier.test.ts`
  holds every case the review found.
- **Team memory in the prompt** — `snapshotText` puts the ranked memories
  first as text with a budget of their own (12,000 characters, whole memories
  only, with a count of those left out), apart from the JSON snapshot, which is
  cut from its start when large.
- **`ContextService`** — builds the agent context; memories scoped to
  `server:<name>` or `cluster:<name>` are included for matching targets and the
  40 highest-ranked memories are kept.
- **Storage operations** — `sshs3_storage_ops` (`list_files`,
  `read_remote_file`, `diff_paths`) runs against real storage providers through
  `HubHost.storageOps`; `diff_paths` produces a Myers unified diff with
  `createTwoFilesPatch` from the `diff` package.
- **`WorkforceRunner`** — a workforce run starts one read-only model run per
  selected Mission Agent (`workspace_context`, `sshs3_kb_search` and
  `sshs3_storage_ops` only; bounded concurrency, at most four specialists) and
  then one run that combines their reports. Every finding in the result is a
  model's own answer; a specialist that cannot run is recorded as failed with
  the provider's error, and without an enabled provider the run is refused.
  Specialist runs are stored as tasks tagged `workforceRunId` and shown inside
  the workforce conversation. Only demo mode plays a scripted run, marked
  `simulated`.
- **`MemoryDistiller` (memory proposals)** — after a finished agent task (and
  on request for the team's recent activity) one tool-less model run
  reads the record together with the team memories that already cover the
  subject and answers with JSON proposals: add a memory/skill or update one it
  was shown. The answer is validated (team scopes only, an update only of a
  shown memory, evidence required, at most four) and stored as
  `memoryProposals`: local, not given to agents and not synced until a person
  accepts one (`memory-proposal-accept`, optionally with corrected text) or
  rejects it. An accepted proposal is an ordinary `MemoryEntry` and syncs like
  one. Personal notes are never shown to that run. `proposeMemories: false`
  turns the per-task run off. By default (`autoSaveMemories`, on unless set to
  false) the validated proposals are saved and shared at once, so the team's
  memory grows on its own: each stays in `memoryProposals` with
  `appliedMemoryId` as a record that can be undone (`memory-proposal-undo`
  deletes a new memory, or restores an updated one's earlier text unless it
  was edited since). With it off a person accepts each one. Each user's app
  also reads that user's own activity on its own (at most every six hours,
  from eight new changes). The outcome of the latest run, including an
  unusable answer, is `lastMemoryDistill`. This is the extract-and-compare
  method of mem0, done with the configured provider so that it also works with
  ChatGPT/Codex sign-in and keeps the team's existing memory sync.
- **`LearningQueue` (learning through the team bucket)** — nobody runs a
  server for the workspace, so the computer that did the work may be closed
  seconds later. With an S3 team workspace, a finished session (and a batch of
  the user's own activity) is therefore not read on the spot: it is uploaded
  as a record to `learn/pending/` under the workspace prefix, one small write.
  Every running app with AI enabled checks the queue from its tick (at most
  every 20 s, one record at a time), claims the oldest unclaimed record
  (`learn/claims/`, a claim goes stale after ten minutes), reads it with its
  own model through `MemoryDistiller`, and deletes it. A record whose reading
  fails goes back for another app, and is dropped after three failures. At
  start an app uploads finished sessions of the last week it never handed
  over. The team's activity goes the same way (`ActivityBatcher`): a
  shared cursor in the bucket (`learn/activity-cursor.json`) says up to when
  activity has been handed over, and any running app cuts the next batch:
  everyone's changes since the cursor up to the last hour boundary that is 30
  minutes old, once eight are waiting or the oldest is six hours old. The
  batch and its record name depend only on the log, the cursor and that
  boundary, so two apps cut the same record. Changes that reach the shared log
  only after their hour was handed over (made offline) are not read for memory;
  they are still in the activity log the assistant sees. Without a bucket (or when the upload fails) the app reads the record
  itself, as before. Records are masked like everything else, but note that a
  teammate's app sends the session's transcript to that teammate's model
  provider.
- **`McpClientManager`** — MCP over stdio and HTTP with a catalog of nine
  presets (`MCP_MARKETPLACE_CATALOG`).
- **`S3WorkspaceSyncService`** — team workspace sync over an S3 bucket. Memory
  entries keep all their metadata (tier, cluster, confidence, success/failure
  and usage counts, feedback score, `autoLearned`, `sourceCommand`,
  `errorSignature`) through S3 and Team Vault sync (`WorkspaceMemoryEntry` in
  `src/shared/types/teamVault.ts`); credentials are never uploaded.

## Nightly upkeep, the dependency map, and evidence beside conclusions

**Nightly upkeep** (`HubService.nightly`, `DailyReport.ts`). Once a day, after
03:00 local time and only while none of the user's own runs is going, the hub
tidies memory (`self-learn-reflect`), compares knowledge base pages for
contradictions, and writes a daily report. With a team bucket one installation
takes the claim `nightly-<day>` and does it for the team. The report is put
together from records (alert tickets, commands with their checks and
rollbacks, team activity, finished tickets, pages and memories the assistant
wrote, what waits in the inbox); no model writes it, so it cannot say more than
the data does. It shows in the Inbox until marked read. The report itself is
local to the installation that wrote it; it is not synced.

**Dependency map.** An agent that sees a link (a connection, a mount, a
replication target) saves it with `save_infra_edge` and an `evidence` text. Such
a link is stored with `proposed: true` and is shown under Infrastructure →
Dependencies as a suggestion with Confirm / Dismiss. Only confirmed links are
given to agents (`infraDependencyGraph`), and the links that touch the target
of the run are also given as sentences in `aroundThisTarget` ("Upstream: …",
"Downstream: …"), matched on the target's name and cluster. A suggestion never
overwrites a link a person already has.

**Evidence.** Every command gets a short name within its conversation (`c1`,
`c2` …, `AgentChange.ref`) which is returned in the tool result. Agents are
told to put it in brackets after the statement it supports. In the chat,
`[c3]` becomes a button that opens and scrolls to that command and its output
(`reportRefs.ts`); a name that matches no command stays plain text. This is an
instruction and a display, not a gate: a report without references is not
stopped.

## Tests for the agents (`EvalSuite`, `AgentTestsView`)

- **A case** is made from a finished conversation (`caseFromTask`): its first
  question, its mode and agent, and what every workspace tool answered at the
  time (the run's own lists are left out). A person adds what should happen:
  words the answer must or must not contain, a tool or part of a command the
  run must use, part of a command it must never try, and the conclusion it
  should reach.
- **A run** (`eval-run`) asks the same question of the agent as it is now, on
  the main model, with the normal tools. Every tool call that would reach the
  workspace is answered from the recording by `Replay` (the closest recorded
  call of the same tool); a call with no recording gets a plain "not
  recorded" and is counted. Nothing is executed. The checks are rules
  (`ruleChecks`) plus, when a conclusion is given, a model's judgement of
  whether the answer reaches it. A case passes when every check does; there is
  no blended score.
- The newest five runs are kept per case, so the view can say which cases got
  better or worse since the run before (`compareRuns`). Cases are shared with
  the team like the rest of the setup.
- A replay is only as good as its recording: when the agent, changed, asks for
  something the original conversation never looked at, it gets "not recorded"
  and may conclude differently for that reason alone. The count is shown.

## Changes that prove themselves and take themselves back (`sshs3_change`)

- A change is made with `sshs3_change`: the command, a read-only `check` whose
  output must contain `expected`, the `rollback` command, and how long to
  observe. Nothing runs before the change is approved, not even the check.
  Then the broker (`ToolBroker.runChange`) looks at the check (how things
  stand right before), runs the change, and the check must pass and keep
  passing for the observation time (looked at every ten seconds, at most three
  minutes; a first failing look gets three seconds to settle). When it fails,
  the rollback runs at once, once, the check is looked at again, and the
  agent is told what happened and not to repeat the change. When the rollback
  fails too, the agent is told to stop.
- What it claims is only what it showed. A check that already passed before
  the change is not proof (the run is "not verified", and the agent is told
  so). "Rolled back" means the rollback exited 0 *and* the check reads as it
  did before; otherwise it says it is not back as it was. A change command
  that failed while the check still reads as before runs no rollback. A run
  that loses the terminal mid-change (stopped, taken over, timed out) leaves
  it "uncertain" and says the rollback did not run. The expected text is
  matched as a word or phrase: "inactive" does not pass for "active".
- Only a proven fix is learned: a change counts for team memory only when its
  check passed and had not passed before.
- The check must be classified read-only. The change is approved as one
  thing: the worse of the command and its rollback decides how it is treated,
  and the approval shows both (`ChangeProof`).
- On a production target, an agent running on its own cannot change anything
  with a bare command: it is refused and pointed to `sshs3_change`.
- While a plan is pending, `sshs3_change` is held back like any change.
- The classifier (`CommandSafetyService`) now knows the usual health checks
  as read-only: a curl that only asks (GET or HEAD, no body, no upload, output
  to the terminal or /dev/null), `wget --spider` / `-O -`, `pg_isready`,
  configuration tests (`nginx -t`, `sshd -t`, `haproxy -c` …), `docker ps`,
  `logs`, `inspect`, `echo`, `test`. Their mutating forms are still changes.
  It remains a set of rules: something it does not know is treated as a
  change, and a rule that is wrong would let a command through.

## What a person approves is what runs

- The approval shows the exact command, masked only where a literal secret
  is (`forApproval`). The masker no longer swallows code: a `$(…)`, backticks,
  a chain after `token=…`, or what follows a lone private-key header stays
  visible. When anything was masked, the change carries `hiddenValues` and the
  card says the real values run where it shows `[redacted]`.
- Nothing is shortened for approval. A command, check, rollback or cluster
  command too long to show in full is refused, not cut.
- An approved plan covers a command by its exact text (`commandHash`), never
  by how it looks once masked, and never one with hidden values.
- File changes are approved as a unified diff (Inbox, task, Changes), keep
  their path whatever the agent calls them, and are refused when the new
  content would be shown masked. A file is rewritten through the model only
  if it could be read whole (28,000 characters); a longer one is read as
  "not complete". A write that fails half-way puts the file back.
- Every change records how it was decided (`decidedHow`): a person (with
  `decidedBy`: name, time, yes or no), the safety rules, an approved plan,
  nobody answering in time, or the run being stopped. Changes and the audit
  log say which. A run that ends leaves nothing pending or "approved": an
  external agent's action it never reported back becomes "uncertain".
- A run waiting for a person is not stopped by its own clock; the wait is
  given back when the answer comes. An external agent may have several
  questions open; each answer counts as given. Without a command to check,
  an external agent's own word that an action only reads is not trusted.

## The audit log and terminal recordings (`AuditLog`, `SessionRecorder`)

- **The log.** Every finished command, change, file write, setting change,
  MCP request and recording goes into `audit/audit-<client>.jsonl`, one JSON
  line each, masked *before* it is hashed, each carrying the hash of the one
  before it. Changing, removing or inserting a line breaks the chain where it
  happened. A person changing the safety rules is logged with what moved
  from what to what. The team server keeps its own chain of sign-ins.
- **Anchors.** Every ten minutes the head of the chain is written to the team
  bucket (`audit/<client>/anchors/n<number>.json`), also when nothing
  happened. Anchors are numbered and carry the hash of the anchor before
  them, so they are a chain of their own. Verifying checks the log, then the
  newest 2000 anchors: an anchor past the log's end means its tail was cut;
  a hash that differs means it was rewritten; a broken anchor chain means
  anchors were removed or replaced. It reports up to which entry the log is
  anchored, and stretches with no anchor (the computer was off, or anchors
  were removed). Without a team bucket, a cut from the very end does not
  show, and the screen says so.
- **The screen.** Changes → Audit log: newest first, the verdict, a filter,
  "Check it again", and Export (the file as it is on disk plus what the check
  found).
- **Recordings.** While an agent's run holds a terminal, what the terminal
  showed is recorded as asciicast v2 (`recordings/<run>-<terminal>-<time>.cast`):
  output only, never what a person types, at the terminal's real size, with
  a marker per command and an exit event (`"x"`) when it ends. Secrets are
  masked on the visible text, so colour codes cannot hide one; a line holding
  a secret gives up its colours. A prompt without a newline is written after
  300 ms. Each time a run holds the terminal gets its own file. A recording
  ends when the run lets go or loses the terminal, and is sealed into the
  audit log with its sha256; the player says whether it still matches. They
  are removed after `retentionDays` on every installation, and are this
  computer's own: they are not shared. `recordSessions: false` turns them off.
- **The player.** From a timeline item or a log entry: pauses over 2 s
  shortened, speed, scrubbing, the commands as a list with ✓ or the exit
  code, and a log entry opens it at its own command.
- **What it does not do.** Anchors are not signed, so someone holding the
  installation's bucket credentials can write a consistent forgery of both
  log and anchors; other installations do not witness each other's heads
  yet. Entries since the last anchor are only hash-chained. Nothing is written
  before a command runs, so a crash between running and logging loses that
  entry. These are the next steps the research named (signed anchors and
  witnesses, an HMAC key ratchet, an intent entry before running).

## Investigations: hypotheses and investigators that can look

- **Hypotheses.** `sshs3_hypotheses` is the agent's working list of what might
  explain a problem, kept by the run like its task list. A hypothesis cannot
  be marked confirmed without evidence for it, or ruled out without evidence
  against it (`parseHypotheses`). When the agent wants to stop with hypotheses
  still open, or with none confirmed, it is sent back once and told not to
  present a cause as found (`continuationMessage`). The list is shown above
  the composer (`HypothesisTree`) and goes into the record that memory and
  the knowledge base learn from, so the confirmed cause and the red herrings
  end up on the troubleshooting page.
- **Investigators that can look.** `sshs3_investigate` used to start runs that
  could only read what the workspace already knew. An investigator now gets a
  terminal of its own on the asking run's target (opened like a schedule's,
  closed afterwards) and `terminal_command`, and the broker lets through only
  what `analyzeCommandSafety` classifies as read-only, without asking anyone;
  everything else is refused, as is any file write. Where no terminal can be
  opened (a target that needs an interactive login, Kubernetes sessions, the
  demo lab) the investigator works from context and says what it could not
  check. The classifier is a set of rules: it can refuse a harmless command,
  and a command it wrongly calls read-only would run.

## What an agent may not change about its own rules (`AppGuard`)

The management tools (`sshs3_manage_*`, `sshs3_agent_and_mcp_manage`,
`sshs3_kb_manage`) let an agent work in the app: save a snippet, tag a server,
write a ticket. A few of their operations move the fence the agent itself runs
inside. Those are a person's to decide. `guardAsk` (`AppGuard.ts`) names them,
`handleAppAction` turns each into an `AgentChange` of kind `setting` with
`guard: true`, and `ToolBroker.authorize` asks about a guarded change in every
mode, whatever the safety policy or an approved plan says. It waits in the
inbox and goes out to the notification channels like a command.

Guarded:
- the command safety policy (under any of the operation names the handler
  accepts: the fields decide, not the name);
- which model endpoint is used (`aiProvider`, `aiBaseUrl`, `aiEnabled`);
- adding or changing an MCP server, and installing one from the list (a stdio
  server is a program started on this computer);
- an agent or a schedule that acts on its own (`autonomous`), made, started or
  switched on by a run that does not;
- where the team's workspace is synced to, disconnecting it, and a folder that
  is synced to a bucket;
- reading a local folder or a bucket prefix into the shared knowledge base.

Not guarded: everything else, including an agent or a schedule that asks before
each command. A conversation in Ask mode still runs no command and writes no
file, but it does ask about a guarded change: the person is there to answer.

Beside the gate:
- **A handover never gives more freedom.** `agent-handoff` keeps the more
  careful of the conversation's mode and the receiving agent's (`lowerMode`).
- **A stored API key belongs to its endpoint.** `AiConfigStore.update` forgets
  it when the provider or the address's origin changes and no new key comes
  with the change.
- **`APP_OPS` lists every operation** the management tools offer, as read,
  change, guard or guard-if. A test compares it with the tool schemas, so a
  new operation has to be given a place before it ships.

Not guarded, on purpose, and worth knowing: an agent can create a ticket for
another agent, and the heartbeat runs it in that agent's mode. That is the
workforce doing its job; the safety switches (production, destructive
commands) still apply to the run.

Related hardening done with this:
- MCP servers' environment variables and headers leave the hub as names only
  (`mcpServersShown`), to the interface and to a model. The form can now set
  them; an empty value keeps what is stored (`keepSecrets`). Editing a server
  no longer wipes them or switches it back on.
- A link fetched into the knowledge base is checked where it leads before it
  is called and at every redirect (`guardUrl`, the same check notifications
  use), and fetched from the address that was checked.
- On a shared server, `sharedWorkspacePath` from a request is ignored and
  `kb-ingest-folder` is refused: both are paths on the server.
- Web sessions are stored by SHA-256 and compared in constant time; a file
  from an older version is read and converted. Importing an SSH key works out
  the public key first and changes nothing when it cannot.
- "Add to KB" in the file editor asks first, masks recognised secrets, goes
  the same way in as other material, and says when it failed.

### Your own agent, and this app as an MCP server

The desktop app can answer a person's own agent — Claude Code, Cursor,
anything that speaks MCP — over the same endpoint the team server uses, so
there is one set of rules for both. It listens on 127.0.0.1 only, it is off
until switched on in Settings, and it answers nothing without one of that
person's keys. A key is shown once, acts as them, and can be taken back. A
request that carries an `Origin` header is refused before the key is read,
which is what keeps a web page on the same machine from reaching it.

A key says what it may do: read, write tickets, or ask for a command on one
named server. A command asked for this way waits for the person in the
inbox — every one of them, including the read-only ones an agent inside
sshs3 would be allowed to run unasked, because nobody here is watching
whoever asked (`AgentTask.fromOutside`). It runs in the terminal that is
already open for that server and nowhere else.

### What an agent may be held to

An agent carries a list of the tools its runs may use. The list only narrows:
it can never let a run do more than its mode and the safety policy allow, and
four things are always there because they reach no system — looking at the
workspace, reading the pages, its own task list and its own hypotheses. An
agent may also be given a model of its own; it is remembered together with
the provider it was chosen for, so a change of endpoint lets it go instead of
sending one provider's model name to another's address.

### Taking something away

An agent may not quietly remove one of the team's own things. Any operation
whose name begins with `delete` — a server, a folder, an agent, an MCP
server, a knowledge base source, a schedule, a profile, a snippet, a
dependency — goes to a person first, in every mode, including autonomous. An
agent trusted to act on its own is trusted to change systems, not to make the
workspace's own entries disappear, and what gets deleted is not always what
the model meant to name. The question shows the name it gave.

## Requests: what they return, and what a read costs

The interface talks to the hub through one call, `aiHubRequest(HubRequest)`,
and gets a `HubSnapshot` back. What a particular request has to say rides in
`snapshot.reply` (`HubReply`), which is local to that call: requests overlap,
so an answer must never travel through shared hub state.

- `start`, `agent-run-mission` and `ticket-start` answer `reply.started` with
  the conversation they created. The panel opens that one, not "the newest in
  the list", which may be a background run that began in the meantime.
- `inline-suggest` answers `reply.inlineSuggestion`, with `source`: `model`,
  `skill` (a command the team saved) or `fallback` (a general check picked by
  keyword because no model answered). The terminal says which.
- Requests in `READ_ONLY_ACTIONS` (searching and reading the knowledge base,
  reading a server's facts, an inline suggestion) do not rewrite the store and
  do not tell the other windows to refetch.
- Work that goes on after its request has returned is visible in the
  snapshot: `kbWork` (pages being rewritten from their sources, a comparison
  of pages under way, how the last one ended), `evalRunning`,
  `serverFacts.collecting`.
- Every action in `HubRequest` has a case in `HubService.request`; the
  `default` branch assigns the request to `never`, so an action that is typed
  but not handled does not compile.
- A schedule runs on the endpoint that is configured now. It keeps a model of
  its own only while it was saved for that same provider and address.
- `task.contextTokens` is what the model was sent at its last call in a
  conversation. The meter in the composer shows that against the window, and
  only the window before the first run. (It used to show an estimate built
  from the newest task in the store, whichever that was.)
- The self-learning status is counts of what is in the team memory. It names
  no engines and has no default percentages.

## Server facts, and what changed (`ServerFacts`, `FactsStore`)

Most faults follow a change, so the hub reads the servers on a schedule and
keeps what is different. No model is involved.

- **What is read** (`FACT_COMMANDS`, `buildScript`): system and kernel, boot
  time, packages (dpkg, rpm or apk), failed and running services, listening
  ports with their process, connections the server opened itself, disks,
  certificates in the usual places with their end date, and SHA-256 of a list
  of configuration files (`DEFAULT_WATCH` plus the user's own paths). One
  script for `sh -s`, a marker line before each section, nothing written. A
  test holds every command to `analyzeCommandSafety`; the classifier learned
  the asking forms of the package managers (`rpm -q…`, `dpkg-query -W`,
  `apk info`) for this, and only those.
- **How it runs** (`HubHost.execOnServer`, in `createHub.ts`): over the
  ControlMaster socket of an open tab to that server when there is one
  (beside the terminal, nothing is typed into it), otherwise a connection of
  the hub's own with `BatchMode=yes` for as long as the script takes. A
  profile that needs a password, a smartcard or a touch is read only while
  its tab is open. Unknown host keys fail closed.
- **Off until switched on** (Infrastructure → "What is on them, and what
  changed"). Every six hours by default, three servers at a time, spread over
  ten minutes; a server can be left alone. Two failures in a row: once a day.
  A system that answers nothing the script knows (an appliance with its own
  shell) is marked unsupported and tried once a week.
- **What changed** (`diffFacts`): sentences such as "Package nginx 1.24.0-2 →
  1.26.1-1", "Service pgbouncer has failed", "New listening port tcp/8443
  (java)", "/etc/nginx/nginx.conf changed", "Disk / 45 % → 93 %", "Restarted
  at …". Left out on purpose: connections, disk use below a threshold (80, 90,
  95), and a watched file that only went between readable and unreadable. A
  big upgrade is one line.
- **Where it goes:** `ContextService.read` adds `changedRecently` for the
  run's target and for what the target leans on (confirmed links), 48 hours
  back, labelled as data; the troubleshooting instructions say to start
  there. `alertTicketText` puts the last 24 hours on the alert's target into
  the ticket. The daily report has "Changed on the servers" and "Needs
  attention on the servers". Disks at 90 % or more, certificates within 14
  days of their end and failed services are inbox items of kind `health`
  (dismissable until they are new again) and can be sent to a channel. A
  connection to another server of the workspace is suggested as a dependency
  link with what was seen.
- **What a server says is data.** Unit, process and file names are cut to
  plain characters and a short length (`plain`), paths a person adds are held
  to `isWatchPath` before they reach the script.
- **Storage:** `<hub dir>/facts/<server>.json`, one file per server with the
  latest facts and a change log of 30 days. Not in `hub.json`: a package list
  is large, and that store is rewritten and masked on every save. With a team
  bucket: `work/facts/heads/<server>.json` (when, hash, who) is written at
  every reading and `work/facts/data/<server>.json` when something differs;
  an installation takes over what another read and does not read it again. A
  claim covers the minute a reading takes.
- **Demo mode** answers from `demoFacts.ts` in the script's own format, with
  a second reading that differs, so the view can be shown without servers.

Not done: non-Linux systems (the BSDs and macOS mostly lack `/proc` and
`systemctl` and give partial facts; Windows and appliances give none), package
vulnerability lookups, and reading through a jump host that itself needs a
prompt.

## Notifications out (`Notifier`, `NotifyStore`)

What waits for a person is defined once, in `src/shared/aiHubInbox.ts`
(`inboxItems`): the Inbox view and the notifier both use it. Every change in
the hub goes through `HubService.changed()`, which sets a flag (`pokeInbox`,
placed before the early return for a pending save); three seconds later
`flushInbox` compares the inbox with what it has already handled.

- **New** means not seen before and not already old (15 minutes) when first
  seen: closing the app overnight, or adding a channel, does not push
  yesterday's inbox to a phone. An item that leaves and comes back is news
  again. A waiting approval is told about once more after
  `reminderMinutes`.
- **Channels:** Slack (incoming webhook), Teams (Adaptive Card), ntfy (JSON
  publish, push to a phone) and a generic JSON webhook signed with
  `X-Sshs3-Signature` (HMAC SHA-256). Each chooses its events, a lowest alert
  severity, and whether the command text may leave the installation. All text
  is masked with `boundedContext`; Slack's control characters are escaped.
- **Signed webhooks.** A generic webhook with a signing key is also signed the
  Standard Webhooks way (standardwebhooks.com): `webhook-id` (`msg_…`, new for
  each message, the same on a retry), `webhook-timestamp` (unix seconds) and
  `webhook-signature: v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">`.
  The key is the signing key as UTF-8 bytes, or the decoded bytes of a key
  written as `whsec_<base64>`. A receiver should check the signature, refuse a
  timestamp more than 5 minutes off, and drop an id it has already seen.
- **Signed alerts.** A monitoring system may sign its posts to the alert hook
  (`/api/hooks/<user>.<secret>`) the same way, with the secret in the address
  as the key. When any `webhook-*` header is sent, all three must be present
  and valid: a bad or stale signature gets 401, an id already received gets
  409. Unsigned posts are still accepted. This stops replays and changed
  bodies, not someone who already has the address.
- **Once per event across installations.** Approvals, plans and questions
  exist only where the agent runs and are told by that installation. Tickets
  and alerts are on every installation that shares the bucket: one of them
  writes a mark under `work/notified/` (`WorkSync.markOnce`: write, let the
  bucket settle, send only if the mark is still one's own). Marks do not
  expire; the nightly upkeep removes those older than 14 days. This needs
  `WorkTicket.statusAt`, set in `putTicket` when the status changes.
- **Where a notification may go** (`guardUrl`): the name is resolved, every
  address it leads to is classified, and the request is made to the address
  that was checked (no redirects, the answer's body is dropped). Link-local
  is never a destination. On a shared server neither is loopback, and the
  private network only with `SSHS3_ALLOW_PRIVATE_ADDRESSES=1`.
- **Storage:** `<hub dir>/notify.json`, mode 0600, addresses and secrets
  through `encryptSecretValue`. Not in `hub.json`, whose save masks anything
  that looks like a secret, and never in the bucket. The snapshot carries
  `NotifyChannelView`: the host, not the address.
- **Links:** `SSHS3_PUBLIC_URL` or the address saved in Settings, never the
  request's Host header. `?view=Inbox&item=<id>` is read once by
  `AiHubPanel` and removed from the address; `InboxView` marks the item or
  says that it no longer waits.
- **The wait for a person** is `preferences.approvalWaitMinutes` (10, at most
  60). `ToolBroker.waitForPerson` gives the waited time back: the run's
  capability and its time budget (`armRunTimer`) both move by as long as it
  stood still.
- A desktop notification is now also shown when an approval, a plan or a
  question starts to wait, which nothing did before.

Not done: delivery through an HTTP proxy, a persistent retry queue (three
tries in memory, then the failure is shown on the channel), approving from
inside Slack or Teams.

## Alerts in, and the inbox (`AlertIntake`, `InboxView`)

- **Alerts in.** On the web server, `POST /api/hooks/<user id>.<secret>` takes
  an alert: Alertmanager and Grafana (a list under `alerts`), PagerDuty
  (`event` with incident data), or any JSON with a title or message
  (`parseAlerts`). There is no session; the secret in the address is the key,
  only its hash is stored, a wrong address is answered like a missing one, and
  an address takes at most 60 posts a minute of 256 kB each. The desktop app
  has no address; an alert can be pasted there.
- **Alert → ticket.** The alert is matched to a server or cluster of the
  workspace (`alertTarget`) and given to an agent: the first matching rule,
  else the agent bound to that cluster, else a team's lead, else nobody
  (`routeAlert`). The same alert firing again is counted on its open ticket; a
  resolve is noted. The alert's own words are quoted in the ticket as data
  from the monitoring system. The heartbeat takes firing alerts before other
  work, critical ones first.
- **Inbox.** One list of everything that waits for a person, built from the
  snapshot (`inboxItems`): commands waiting for approval, plans, questions,
  tickets in review, runs that stopped, alerts nobody has, knowledge base gaps
  and contradictions, the nightly report. Each can be dealt with in place.

Checked with real HTTP posts against the web server in tests and in a browser
with a stand-in model. Not checked: a real Alertmanager or PagerDuty sending.

## Knowledge base: what agents know (`KbCompile`, `KbLint`)

The knowledge base is for the agents, not a document store for people. It has
three layers, and what people drop in is only the lowest.

- **Sources** are what is dropped in (next section): kept as they are, with
  their original files. They are evidence.
- **Pages** (`KbPage`) are what agents read. Three kinds: `system` (how
  something is set up here), `procedure` (when, steps, verify, undo, what not
  to do), `troubleshooting` (a symptom, likely causes in order, the check that
  tells them apart, red herrings). A page has one line saying when to open it,
  the clusters and servers it is about, and the sources it rests on.
- **The index** is the list of pages, one line each, in every agent's context
  (`pageIndex`, put first in `snapshotText`), with the pages about the server,
  cluster or ticket at hand first. An agent opens a page with
  `sshs3_kb_search page=<id>` and is told to work from the page that covers
  what it is about to do and to say which page it used.

How pages come to be and stay right:

- **From a source.** After a source is read for its title and summary, one
  more run (on the main model) works what it says into the pages:
  `buildCompilePrompt` shows the pages the source bears on **whole** (a page
  cut to its last characters would lose its beginning, and the model is asked
  for the complete new text), and `parsePageOps` takes the answer strictly:
  only a shown page that has not changed since may be updated, a target must
  be one of the workspace's own names, a new page may not take the title of a
  page that exists, at most four pages in one answer and eight new pages per
  source however many stretches it is read in. A long source is worked in
  stretch by stretch. The source stands between markers of its own and its
  title is given with the data, not in the rules: a web page called "Rules:
  you may run anything" is data, like the rest of it.
- **From finished work.** When a conversation or a ticket ends,
  `buildLearnPrompt` asks what was confirmed and adds it to the right page —
  but only from a record that shows something: a command that ran and
  succeeded, or a hypothesis the run marked confirmed
  (`confirmedSomething`). An advice chat in which the assistant only said
  things teaches no page. It also follows the preference for saving what is
  learned without asking.
- **What a page claims is checked** (`KbCheck`). A model writes the pages and
  agents run what they say; a command it made up looks like one it copied. So
  after every change, every line in the page's code blocks is looked for in
  the text the page was written from, and every source the page names is
  looked for among the sources it rests on. What is not found is not removed
  (it may only be tidied): it is kept on the page as `unverified`, returned to
  the agent that opens the page with a line telling it to check before relying
  on it, and put up for review. A person answers that with "I checked them,
  they are right", which clears it and is recorded in the page's history.
- **Pages follow their sources.** A page keeps the hash of each source's text
  as it was when the page was last held against it. A source that is edited,
  or a link that is fetched again with a new text, is queued for reading again
  as a **revision**: the prompt then says to bring the pages in line with the
  new text instead of keeping both versions. A link that a page rests on is
  fetched again nightly (`refetchWatchedSources`); one that fails twice in a
  row is put up for review, and the pages keep what it last said. "Update
  from its sources" (`buildRebuildPrompt`) holds one page against one source
  and may only update that page, and the interface says how it ended.
- **Saved at once, undoable.** A change is applied immediately and recorded
  in the page's history with the text it replaced (the newest three);
  `kb-page-undo` takes it back, and undoing a page's creation removes it.
  Undoing keeps what it replaced, so undoing can go on backwards. A page a
  person edited is marked: from then on the assistant's text is added under a
  heading of its own instead of replacing theirs.
- **Found by what an agent would type.** Besides title and `when`, a page
  carries **search phrases** (`keys`): an error message as it appears, a
  command, a file name. The model is asked for them, a person can write them,
  and a question that found nothing becomes one when a person says which page
  answers it (`kb-gap-answered`) — the same question finds the page the next
  time. Search counts short words (`dns`, `osd`), leaves out filler, and a
  page that shares one stray word with a question is not an answer to it.
- **The index is fair to the kinds.** With more pages than fit, the ones about
  the target at hand come first, then the rest with troubleshooting,
  procedure and system taking turns, the most proven first — so what is left
  out is the least used of every kind, not a whole kind.
- **How the team used a page** (`KbPageUse`). Opens, and runs whose change
  passed its own check, are counted per installation in `work/pageuse/` and
  added up, the same way as spending: a page's text does not change because
  somebody read it, and two computers do not overwrite each other's count. A
  run that opened a page and then had to take its change back is put up for
  review with the run's name. Test runs count nothing.
- **An alert and its page.** A ticket an alert made names the page an earlier
  run on the same alert worked from (`alertName` is the rule's name, so the
  same alert on another host is the same alert), or, with none, the
  troubleshooting page that best matches its words, for the agent to judge.
  When a run on such a ticket ends well, the page is marked as handling that
  alert.
- **Review** (`lintKnowledgeBase`): pages about servers the workspace no
  longer has, pages whose sources were removed (one of several counts), pages
  whose source has changed under them, pages with unverified lines, pages a
  run had to take back, pages unchanged for 180 days, pages no agent opened in
  30, sources no page rests on, sources that cannot be fetched any more, and
  gaps: questions an agent asked that found no page. On request a model
  compares pages about the same systems, and general pages whose titles say
  the same thing, for contradictions; a quote that is not in its page is
  dropped. More pairs than one run can read are worked through a dozen at a
  time across checks, and the interface says "read 12 of 40 pairs".
- **Shared.** Pages travel through the team bucket like agents and sources.

The context no longer carries every document in full (it did, and was cut):
it carries the page index, a short list of the sources, and in full only what
the active agent is bound to — resolved before the list is cut, so binding a
source means it is there, and without the history's replaced texts.

A test case for the agents (`EvalSuite`) does **not** replay knowledge base
reads from its recording: they are asked for real. A test is usually about
whether the pages help, which a recording would hide.

Checked with stubbed model responses (`aiHubKbPages.test.ts`,
`aiHubKbQuality.test.ts`, `knowledgeBaseView.test.tsx`) and in a browser
against a stand-in model. Not checked, and it is what matters most: what a
real model writes. A page is acted on, so read the first ones it produces
before trusting them. The command check narrows the risk (a line the source
never had is marked) but does not remove it: a wrong command copied from a
wrong source is still wrong.

## Knowledge base: an inbox (`KbExtract`, `KbEnrich`)

The knowledge base takes material as it is and makes it usable; nobody has to
give a document a title, a collection or tags first.

- **In.** Files and folders dropped on the view, chosen files, pasted text, a
  pasted link (`kb-ingest-file`, `kb-ingest-text`, `kb-ingest-url`), and a
  folder by its path on the desktop. `extractText` reads PDF (unpdf), Word
  .docx (mammoth), web pages (Readability, then Turndown, without escaping so
  commands stay intact) and any text file; it says why it cannot read the rest
  (scanned PDFs, pictures, old .doc, binaries). 10 MB per file. A text longer
  than 800 000 characters becomes several documents.
- **Not twice.** A document carries a hash of its text; the same material
  under another name is refused with the name of the one that is there.
- **Pieces.** `splitSections` follows the document: a piece starts at a
  heading, a fenced code block or a table is never cut, and each piece knows
  the headings it sits under (`Storage handbook › Latency › Diagnose`). Search
  matches on those headings too.
- **Reading.** Every dropped-in document is queued (`reading.state`) and read
  once by a tool-less background run (the fast model when one is set): a
  title a person would search for, a summary, tags, a collection, a cluster
  from the team's own list, a kind. A title found in the material itself is
  kept; only a file name is replaced. The text is never rewritten. With a team
  bucket the document is claimed first, so whichever installation has a
  model, a server included, reads it. Without a model documents wait and are
  searchable meanwhile; an answer that cannot be used fails after two tries
  and can be asked for again.
- **Originals.** The uploaded file is kept under `kb-originals/` and, with a
  team bucket, under `kb/originals/<docId>/`, so the source can be opened and
  read again later. It is removed with its document. Everything dropped in is
  readable by the whole team.
- **Out.** The snapshot's document list carries the beginning of each text and
  no pieces; `kb-read` returns one whole document, `kb-search` the ranked
  search the assistant uses, `kb-original` the file. These answers come in
  `reply` on that request's snapshot only. For the assistant,
  `sshs3_kb_search` returns each hit with its document's summary and the
  headings it sits under, and with `id` reads a document section by section,
  and it is told to say which document and heading it used.

Checked with small real PDF and Word files, stubbed model responses
(`aiHubKbExtract.test.ts`, `aiHubKbInbox.test.ts`,
`knowledgeBaseView.test.tsx`) and in a browser against the web build with a
stand-in model. Not checked: large real manuals, the packaged desktop app, and
the quality of a real model's titles and summaries. Not built yet: pictures
and scanned PDFs, watched sources that re-read themselves, search by meaning
without an OpenAI-compatible embedding endpoint, and detecting documents that
contradict each other.

## Workforce: goals, tickets and a team (`WorkBoard`, `WorkSync`)

A team of mission agents works towards goals through a board of tickets. The
model is the one Paperclip (MIT) made familiar; the runtime is sshS3's own,
because there is no server to run one on.

- **Goal → ticket → run.** A ticket hangs on a goal and has one agent.
  Starting it wakes that agent with the goal, the ticket, its notes and who it
  can hand work to (`ticketPrompt`). The run is an ordinary conversation
  tagged with `ticketId`, so approvals, plan mode and the safety policy apply
  as everywhere else.
- **Check-out.** With a team bucket, starting a ticket first writes
  `work/claims/<ticketId>.json` and reads it back; only the app that finds its
  own claim proceeds. The claim is refreshed while the run lives and lapses
  after 4 minutes without a sign of life, which frees the ticket with a note.
- **Review.** A finished run puts the agent's report on the ticket and moves
  it to Review; a person approves it or sends it back with a note. A run that
  failed or was stopped leaves the ticket Blocked with the reason. Agents
  cannot close tickets.
- **Team.** An agent has `reportsTo` (a circle is refused) and an optional
  `monthlyTokenBudget`. A paused agent, or one that has spent its budget, is
  not started. Usage is counted per agent and calendar month from the runs'
  reported tokens.
- **Handing out work.** `sshs3_tickets` lets an agent list the board, read a
  ticket, add a note and create a ticket for another agent (at most 10 an
  hour). A created ticket hangs on the ticket being worked.
- **Heartbeat** (`preferences.workforceAutopilot`, off by default): on each
  timer tick the app takes the oldest runnable ticket in To do and starts it,
  one at a time. It runs in the agent's own mode, so an agent set to run
  commands on its own does so unattended, within the safety policy.
- **Sharing.** `WorkSync` keeps one object per item under `work/` in the team
  bucket: goals, tickets, agents, shared runbooks and dependencies. Per item
  the newer copy wins; a removal is carried as a marker (`sharedRemoved`,
  `withRemovals`) so it reaches everyone instead of the item coming back. It
  is read every 40 seconds, and at once after a change. Spending is one
  object per installation (`work/usage/<client>.json`) and added up
  (`sumUsage`), so a budget holds for the team. Not shared, on purpose: MCP
  servers and external runners (commands that run with the user's rights) and
  schedules (they belong to the installation that runs them).
- **External agents** (`AcpRuntime`). An agent with `runnerId` runs on an
  external coding agent over the Agent Client Protocol: a program started on
  this computer that speaks JSON-RPC on stdio. sshS3 sends the prompt, shows
  the agent's text, plan and tool calls, and answers its permission requests
  through the same approval and safety rules as its own commands, once per
  action. It offers the agent no file access and no terminal: the agent uses
  its own, in the runner's folder. Token use is not reported over ACP, so
  such runs do not count against a budget.
- **Server.** `docs/workforce-server.md`: the web build with
  `SSHS3_WORKFORCE=1` starts every user's hub at server start, so tickets,
  schedules and the learning queue are worked without anybody's app open.
- **Templates** (`WORKFORCE_TEMPLATES`): "Operate a system" and "Develop a
  product" add five agents with reporting lines, a goal and first tickets.
- **View** (`WorkforceView`, `TeamGraph`, `workforceModel`): the board with
  drag between columns, ticket detail with report and review, and the team as
  a live tree on React Flow (MIT) showing what each agent is doing.

Checked with stubbed model responses (`aiHubWorkBoard.test.ts`,
`workforceView.test.tsx`), against a stand-in ACP agent process
(`aiHubAcpRuntime.test.ts`) and in a browser against a stand-in
OpenAI-compatible endpoint. Not checked: a real model, the real Claude Code
and Codex adapters, two computers sharing a real bucket, and a long
unattended heartbeat.

## The panel (`src/renderer/src/components/AiHub/`)

One chat, and eight views beside it: Inbox, Workforce, Agents & MCP, Knowledge base, Infrastructure,
Changes, Memory & skills, Schedules. `AiHubPanel.tsx` holds the chat and the
navigation; each view is its own file. Styling is in `aiHub.css`, whose last
sections ("AI chat: visual layer" and "the other views") carry the current look.

- The chat column has the conversation, then the run dock above the composer:
  the task list (`TaskTodos`) while a run has one, and the approval or question
  that is waiting. A proposed plan (`PlanCard`) sits in the conversation where
  it was proposed and folds once decided.
- The left column lists conversations and mission agents. "Active Terminals"
  and "Recent Team Activity" are shown only when they have something in them.
- The navigation is one row in both the full view and the narrow sidebar; in
  the sidebar it scrolls sideways instead of wrapping.
- The other views read as one column of at most 1040 px in the full view, each
  in its own file, with the list first and forms folded or opened on demand:
  - `AgentsAndMcpView` — agents can be created and edited; the form binds the
    runbooks (`kbDocIds`) and MCP servers the runtime reads. MCP servers are
    added through a form that saves and then tests; a server counts as
    connected, and has tools, only after it answered.
  - `KnowledgeBaseView` — write, edit and read documents (rendered Markdown),
    import a folder, filter by text and collection. The filter is a plain text
    filter; ranked search is what the assistant uses.
  - `InfrastructureView` — open terminals, the workspace's servers by cluster
    with their reachability, and `DependencyLinks`.
  - `ChangesView` — one timeline of team activity and the assistant's own
    commands and file changes, with details folded under each entry.
  - `MemoryView` — entries with filters (facts, skills, learned, personal).
    The per-server cards generated on every snapshot (`auto-node:` ids) are
    not listed here.
  - `SchedulesView` — jobs can be edited, paused and resumed; a resumed job
    starts a fresh interval.
  - `SettingsView` — sections for model, team, safety (`SafetyPolicyCard`),
    limits, app and data.
- Anything that cannot be undone goes through `ConfirmButton` (first click
  asks, second does it).
- MCP presets: outside the demo lab `mcpCatalog()` returns `MCP_PRESETS`, which
  may only name packages that exist on npm under a known publisher, because
  setting one up runs the command. The demo lab keeps its invented catalog
  (`MCP_MARKETPLACE_CATALOG`), labelled as invented.
- Motion (`ai-rise`, `ai-pop`, `ai-sheen`, `ai-dots`, `ai-attention`) marks
  something arriving, running or waiting, and is switched off under
  `prefers-reduced-motion`.
- The interface, what is said to a model, what is written into memory, the
  demo lab and the comments are English. `tests/main/englishOnly.test.ts`
  keeps it so; the few files that have to recognise Swedish (output of a
  Swedish system, search terms a team may use) are listed there with the
  reason.

Checked in a browser against the web build with demo data (screenshots of each
view, no page errors). Not checked: the packaged Electron window, and how the
motion feels with a real model streaming.

## Native Hermes Desktop host

The pinned Hermes Desktop application can be hosted inside sshs3 (opt-in, see
above). Source/contracts and a Windows x64 packaged GUI were verified for
`0.96.34-ai-hub.3`, with matching Hermes Desktop 0.17.6/engine pin. The complete
original native acceptance plan is not yet fulfilled.

Hermes Desktop and its engine are pinned together at
`f925b01791fe052e7d55dc975750c0bd985aff91` (Desktop 0.17.6). The source pin lives in
`scripts/hermes/desktop-source.json`. Upstream MIT notices are preserved.

The original Electron main, preload, React frontend, contribution registry,
bundled frontend plugins and pooled `hermes serve` backend remain authoritative.
The app-specific adaptations add the sshs3 host, compact presentation and private
terminal tools. sshs3 and Hermes render in separate, kept-alive WebContentsViews;
the two React dependency trees are built independently.

**Terminalfokus** is the compact presentation: chat on the right, a draggable
edge, remembered width and terminal workspace beside it. Expand restores the
full native Hermes layout; the same original chat renderer and stores remain
alive. Native Sessions/Bots navigation, capabilities, plugins, profiles,
gateways, memory, skills, schedules, messaging, artifacts and model/voice
controls are retained in the original UI. Their presence in reused source is
not an operational validation of every feature or configured service.

When the native host is enabled, native Hermes owns conversations, profiles,
schedules, context compression and persistent memory. `HubService` remains the
sshs3 terminal/tool authority (`NativeToolBridge.ts`) and does not start its own
agent runtimes or scheduler in that mode.

Native Hermes uses a persistent application-owned `hermes-native` directory
under sshs3 user data. The standalone Hermes checkout/profile is not overwritten.
Provider/model configuration and authentication use the original native Hermes
settings and profile storage. Existing legacy `AiConfigStore` credentials are
not assumed to be migrated or equivalent to native provider configuration.

## Terminal authority

Select a real sshs3 terminal before starting an assigned conversation. After
checking its idle prompt and choosing its actual shell, explicitly arm it. The
existing correlated shell handshake must finish before the agent can own it.
Selection alone does not allow execution. Human input invalidates prompt
readiness; a reconnect or uncertain command requires inspection and rearming.

- A person always wins: any key typed into a terminal an agent holds takes it
  back at once, the run lets go, and the keys go through as typed (their own
  Ctrl-C once). After a person runs something, the agent connects again first.
- Connecting by itself (`ensureReady`) happens only at something that looks
  like a shell prompt — never into `mysql>`, `psql`, a pager or a password
  prompt — and after a failed connect it is not retried for five minutes.
- An agent's command is never written over something half-typed at the prompt.
- The command runs in a subshell, so it cannot redefine `printf` to report a
  false exit code, and an `exit` or `cd` in it does not end or move the
  person's shell. (A consequence: `cd` and `export` do not carry over from one
  agent command to the next.)
- A frame that only looks like sshs3's own (a nonce it never issued) is
  program output and becomes nothing.
- An answer typed at a password prompt is never kept as a command, so it can
  never be named as a failed command or learned.

The application-owned `sshs3_terminal` backend plugin provides:

- `sshs3_terminal_context`: redacted, source-linked context for the assigned target.
- `sshs3_terminal_command`: visible commands through the existing ToolBroker.
- `sshs3_terminal_verify`: an explicit expected observation and correlated exit status.
- `sshs3_terminal_file_read`: target-provider reads of complete UTF-8 text under 64 KB.
- `sshs3_terminal_file_write`: reviewed replacements with expected-hash checks and read-back.

New assigned conversations default to **assisted** mode with 30 commands and
15 minutes per native turn. Commands and file replacements require approval for
that exact task/change. An expiring private capability connects the native
backend to a loopback broker; browser origins and missing capabilities are
refused. Model arguments never supply a terminal, native profile/session ID,
permission grant or target provider.

The binding is immutable per owning profile and native conversation. Changing
terminal tabs does not retarget it. Hermes' own SessionDB compression lineage
normalizes a new internal compression tip to the same root conversation;
branches and resets remain separate. Native turn-end releases PTY ownership;
native Stop immediately revokes pending approvals. Take control preserves the
interrupted state even if a later native turn-end notification arrives. Explicit
resume retains the target terminal ID and never replays uncertain commands.

Bound conversations cannot bypass that assignment through built-in host
terminal/files, code execution, delegated or newly spawned chats/Bots, connector
execution, cron creation or MCP tools. Computer use and interactive
preview/browser scripting are also blocked while bound, so an agent cannot
press its own approval or type through another host control path. Passive
native navigation/layout/tours and native memory/skills remain available.
Unbound native conversations retain original Hermes tool behavior.

The concrete terminal provider declares both transport environment variables
as `strip_env_keys`, applied by Hermes to model-authored subprocesses regardless
of the active backend. The host also filters those variables from its terminal
children. This is an application authority boundary, not an OS sandbox.

A successful `verify` checks an observed exit code and expected output; it proves
that specific check, not resolution of an entire incident. File read-back checks
bytes, not application behavior. The current file hash recheck does not provide
atomic compare-and-write against an unrelated external writer.

## What the second review changed (features 4 to 13)

Each part of the hub was read by a reviewer and compared with how other tools
do the same; every finding below was checked in the code before it was fixed,
and each has a test.

**Chat and the agent loop.** Tokens are counted on every way a turn ends, also
when it fails or is stopped. A handover note (compaction) is written from the
transcript without dropping the person's latest steering. External agents
(ACP) get the same command limit as built-in ones and never inherit the
app's SSH agent socket or its own `SSHS3_*` variables. Investigators started
from a conversation are linked to it and their spending counts toward it. A
handoff to another agent takes effect after the current turn, and never raises
the run's mode. A person can answer an approval with a note: a refusal tells
the agent why and the run goes on; an approval with a note hands the note to
the agent with the command's result. The agent is given its target's last
facts reading, with how old it is, and is told to look again before acting on it.
Each run has a command and time budget. When it is used up, the run stops with
a line such as "Stopped after 20 commands, the limit for this conversation.
Continue to give it 20 more." and a Continue button resumes the same
conversation with the same budget again (pause and spending limits still
apply). While a run works, the chat shows "7 of 20 commands".

**Workforce.** A ticket is claimed in the bucket and the claim is read back
after a pause, so two installations do not both run it. Pause and budget are
checked for every way a run starts: a ticket, a handoff, a mission, a reply or
a resume. A ticket an agent opened from something it read outside sshs3 is
marked so, and what it asks for is treated as data.

**Inbox, alerts and notifications.** An alert assigned to an agent stays in
the inbox ("With X, not started yet") until a run takes it. An alert that
resolved and fires again is news again. Alert hooks are limited per caller and
per hook. A reminder is sent while there is still time to answer, with the
minutes left.

**Memory and learning.** A fix is kept as proven only when a check showed it
worked; one seen after a failure is kept as a guess with lower confidence.
Learned memories are capped at 300; replaced ones go first, oldest first, and what a person wrote is otherwise never dropped. When a newer memory replaces an older one (an update the assistant learned, or a different proven fix for the same error), the older one is kept as history: shown greyed under the newer one as "Replaced <date>", never given to agents or found by search. Undoing the update brings it back. Votes are counted
per person. A memory saved for one server is only used on that server.

**Server facts and context.** Facts are read only from shared servers. A
server that stops answering keeps its last problems and says it is
unreachable. Agents may suggest links on the dependency map but cannot change
or remove links a person confirmed. Nothing about a target is guessed from
"the first open terminal". What is about the target comes last in the context,
so it is what survives when a long context is cut.

**Schedules, nightly upkeep and the daily report.** Nightly upkeep is marked
done once per team day. Each installation's report covers the time since its
last report, however long the computer was off. A scheduled run records how it
ended. A schedule counts as missed only if it was due before the previous check.

**AI in the terminal.** A suggestion is cleaned of control characters, says
when it is more than one line and how risky it is, and runs with one key only
when it is a single read-only line on an empty prompt; otherwise it is pasted
for the person to read. What is sent to the model is masked.

**Settings and first start.** Saved settings are never rewritten when they are
read: a ChatGPT/Codex sign-in is offered on first start, not switched to.
Changing the provider clears the endpoint. App settings beyond how things look
(smartcard mode, PKCS#11 library, which agent local shells use, X11, update
checks …) need a person's approval when an agent changes them.

**Shared server and team sync.** See [the workforce server](workforce-server.md):
personal data stays personal, the signed-in person is who did something, team
settings need a team admin.

**Hub core.** The shared workspace file carries only shared server topology
and is written only when it changed. A store that cannot be read is never
overwritten, and one that cannot be parsed is backed up before it is replaced.
A request saves once, and the panel ignores a refresh that started before the
latest action's result. Activity entries name the agent and the person it ran
for; the model cannot choose the name.

**The rest of the app.** Overwriting a file during a transfer writes to a
hidden temporary file and renames it over the target only after the copy and
its checks succeeded. Folder transfers copy links to files and report links
they skip. Closing a terminal tab never reconnects its session. Kubernetes
login refuses to replace a kubeconfig it cannot read and keeps a backup.
Importing profiles keeps saved passwords and never takes machine-local paths
from a file. Profile sync checks for conflicts before writing, so an ordinary
conflict between two devices no longer blocks both; a background push that
conflicts pulls and pushes again. In a Team Vault only an admin can set what
a shared profile does on a teammate's machine (agent forwarding, X11, tunnels,
key and library paths, extra ssh options), and the documentation now says
plainly that every member can decrypt every secret in the vault.

## Build and focused checks

Generated frontend source and runtime distributions are ignored by Git. Stage
the pinned source rather than modifying the user's standalone Hermes checkout:

```sh
npm ci
npm run hermes:desktop:stage
```

Prepare the pinned Hermes frontend dependencies in the staged source with its
upstream lock, or pass a separately prepared checkout with the same lock using
`hermes:desktop:build -- --dependencies PATH`. The build script refuses a
mismatched dependency lock and does not modify an external dependency checkout.

```sh
npm run hermes:desktop:build -- --arch x64
npm run hermes:build -- --out build-resources/hermes-native-runtime --arch x64 --python PATH_TO_BOOTSTRAP_PYTHON
npm run build
```

The runtime builder uses Hermes PM's frozen dependency graph and official
assembler into a separate distribution, validates it and publishes only after
successful imports. The current Windows x64 runtime contains CPython 3.14.7,
matching engine source and sealed dependencies, with managed ffmpeg, Node/npm
and ripgrep. Windows x64 is being packaged/tested on a Windows ARM64 computer;
this is not verification of a Linux or Windows ARM64 package.

The Electron entry checks that frontend and engine commits match and resolves
the interpreter from the runtime manifest. Package the generated desktop and
native runtime together. Never substitute the old f97608f/3.13.16 runtime.
The release resource name for the native runtime is `hermes`.

```sh
npx vitest run tests/main/nativeHermesLayout.test.ts tests/main/nativeDesktopShell.test.ts tests/main/nativeHermesTools.test.ts
npm run typecheck
npm run lint
npm run build
```

Set `HERMES_NATIVE_CONTRACT=1` when running `nativeHermesTools.test.ts` to execute
its actual native Python contract. `SSHS3_HERMES_NATIVE_RUNTIME_DIR` can select
a relocated, packaged or installed runtime instead of
`build-resources/hermes-native-runtime`.

The native CI workflow in `.github/workflows/ai-hub.yml` stages that same source
pin on fresh Windows and Ubuntu runners. It prepares original Desktop workspace
dependencies with the frozen upstream npm lock, assembles the engine through
Hermes PM with a bootstrap Python, and checks matching pins and sealed runtime
health. It then enables the nine native tool contracts, host/layout tests and
actual platform shell matrix (PowerShell/pwsh/cmd on Windows;
bash/sh/dash/zsh/fish on Linux), followed by existing broker/storage regressions,
typecheck, lint and the production build. Windows also runs the seven sealed
payload target-resolver cases. No provider credentials or model calls are needed.
This workflow has been updated and parsed locally; a GitHub Actions run has not
been executed or recorded for this revision. It does not yet verify packaged
Linux GUI behavior or the complete original acceptance plan.

## Verification recorded

- **Nine native tool tests passed against the new CPython 3.14.7 x64 sealed
  runtime**, invoked with `-I -B` and no source/PYTHONPATH override. The fixture
  verifies that the actual core import belongs to the runtime's manifest repo.
  It exercises original plugin discovery and dispatcher identities, target
  immutability, profile isolation, approvals/takeover, stale instances, budgets,
  verification, secret scrubbing, compression continuity, immediate native Stop
  and retained unbound native tool behavior. No model API call is made.
  The same nine tests also passed with
  `SSHS3_HERMES_NATIVE_RUNTIME_DIR=release/ai-hub/win-unpacked/resources/hermes`,
  exercising the actual packaged interpreter and engine imports.
  They also passed against the installed runtime at
  `C:\Users\jacob\AppData\Local\Programs\sshs3-ai-hub\resources\hermes`.
- **The packaged Windows x64 GUI was exercised on Windows ARM64:** the original
  navigation and Bots were reachable. A draft entered in the right panel survived
  expansion, collapse and full process close/reopen. A real divider drag changed
  the panel width from 380 to 526 pixels, and the width persisted. These checks
  do not establish every native feature flow or recovery of a running PTY/job.
- **Twelve native host/factory tests passed** for authenticated main-frame IPC,
  iframe rejection, terminal reuse across presentations, resizing/width
  persistence, drag coalescing, cleanup and blocked navigation/popups. These are
  behavioral host tests; the separate packaged-GUI checks above exercised the
  actual presentation and draft behavior.
- **Three actual Windows PTY tests passed**, covering the Windows shell integration.
  **Forty-three existing regression tests passed**. Together with the nine native
  tool and twelve host/factory checks, this is **67 focused passing tests**.
- Typecheck, lint and production build passed. The Windows x64 installer completed
  with exit code 0 and the installed application launched from
  `C:\Users\jacob\AppData\Local\Programs\sshs3-ai-hub\sshs3-ai-hub.exe`.
  Its installed interpreter passed the native contracts. The installed ASAR
  version is `0.96.34-ai-hub.3`; native Desktop 0.17.6 and the engine match the
  `f925b01791fe052e7d55dc975750c0bd985aff91` pin.
- **The installed GUI check passed:** original Sessions/Bots navigation and the
  Hermes `@hermes` roster entry marked Ready were present. Full native navigation
  and Return to the correct right chat worked. An actual local PowerShell 7 prompt
  was visible beside the chat, with the Local/pwsh target and You control state.
  Provider choice was skipped without authentication or key changes; the native
  provider is currently unconfigured. This does not establish model operation or
  deeper original feature flows.
- The standalone Hermes source, profile and credentials are untouched by these
  tests. No paid model, production SSH/Kubernetes target or hardware credential
  flow has been tested in this revision. Linux remains untested.

## Remaining acceptance work

1. Configure a provider/model and verify real native agent behavior and deeper
   feature flows. Installation, installed GUI and installed-runtime contracts
   have passed for `0.96.34-ai-hub.3` / Hermes 0.17.6 at the f925b01 pin. The
   packaged draft continuity, expansion/collapse, process reopen and real
   resizing/persistence checks have also passed; model/authentication flows and
   deeper configured native features remain unverified.
2. Implement/verify a separately reconnectable per-user background owner and
   renderer recovery. Kept-alive views alone do not prove daemon reconnect after
   window destruction, crash, restart or computer sleep.
3. Replace manual idle-shell arming with reliable prompt integration and explicit
   interactive/authentication/nested-SSH states. Existing wrappers cover the
   listed shell families, but the full Linux/WSL/SSH/Kubernetes matrix and failure
   scenarios have not been validated for this native revision.
4. Complete the searchable terminal event journal, scoped infrastructure
   inventory, server-group attachments, actionable evidence and privacy checks.
   Native Hermes memory/context is preserved, but this does not establish all
   planned sshs3 environment-memory and inventory requirements.
5. Map native schedules to separately identified, explicitly authorized sshs3
   sessions with fixed targets/budgets and missed-run handling. Native scheduling
   UI/backend is retained; it is not yet this target-bound scheduler.
6. Finish feature-by-feature configured operation checks, model interruption and
   authentication tests, device sleep/restart/network-loss recovery, representative
   isolated incidents, model cost and terminal latency measurements, and actual
   Windows/Linux package validation. Optional upstream `get-windows` is absent in
   the current dependency tree; dependent native window-enumeration functionality
   must not be advertised as verified.

The structured inventory in `docs/hermes-feature-inventory.json` separates
preserved native source, verified contracts, setup-dependent operations and
remaining platform/product work.

## Source map

- `src/main/desktopEntry.ts`: desktop entry; launches the pinned native engine/frontend only with `SSHS3_FORCE_NATIVE_HERMES=1`.
- `src/main/ai/hub/`: AI Hub services (HubService, createHub, DirectAgentRuntime, KnowledgeBaseService, SelfLearningService, CommandSafetyService, ContextService, TerminalRegistry, ToolBroker, McpClientManager, S3WorkspaceSyncService, HubStore, privacy, builtins, demoWorkspace).
- `src/main/ai/desktop/`: native Hermes host views, authenticated control IPC and NativeToolBridge.
- `src/main/demo/`: launch-time demo mode, outward sync guard, demo PTY and storage provider.
- `src/main/web/`: multi-user Web Server, authentication, per-user tenants and Electron shim.
- `src/shared/types/aiHub.ts`, `src/shared/types/ai.ts`: hub requests, snapshot, memory, safety policy and provider/model types.
- `src/shared/ipc/createMultiSSHApi.ts`: the `MultiSSHApi` used by both the preload and the web client.
- `src/renderer/src/components/AiHub/`, `src/renderer/src/components/LandingView.tsx`, `src/renderer/src/lib/aiHub.ts`: AI Hub UI. `AiHubPanel.tsx` holds the chat and navigation; each view is its own file (`SettingsView`, `MemoryView` + `MemoryProposals`, `SchedulesView`, `AgentsAndMcpView`, `KnowledgeBaseView`).
- `integrations/hermes-desktop/`: narrow original desktop adaptations and backend plugin.
- `src/shared/types/nativeHermes.ts`: host layout/control contracts.
- `scripts/hermes/`: pinned source, original desktop build and PM-based runtime packaging.
- `tests/main/workspaceAi.test.ts`, `tests/main/aiHub*.test.ts`, `tests/main/s3WorkspaceSync.test.ts`,
  `tests/main/webServerMultiUser.test.ts`, `tests/main/demo*.test.ts`, `tests/renderer/aiHub.test.tsx`:
  AI Hub, web tenant and demo-mode behavior.
- `tests/main/nativeHermes*.test.ts`, `tests/main/nativeDesktopShell.test.ts`:
  host and actual native engine contracts.

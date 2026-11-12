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
    parallel (three at a time), each with a fresh context and only
    `workspace_context`, `sshs3_kb_search` and `sshs3_storage_ops`; it gets
    their reports back together, a failed one with its error. They cannot run
    commands (the terminals belong to the asking run) and cannot delegate.
  - *Compaction*: when a run's transcript passes about half the context
    window (`compactAtChars`), the agent is asked, between tool rounds, for a
    handover note to itself; the next request then starts from the original
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
- **`CommandSafetyService`** — splits shell commands into segments (pipelines,
  chains, `$()`, backticks, nested `sh -c`/`eval`), classifies them as safe,
  modifying or destructive and applies the `SafetyPolicyConfig`
  (`autoApproveSafeReadOnly`, `requireApprovalOnProdTags`,
  `blockDestructiveWithoutConfirm`), including file writes on `prod`-tagged
  servers.
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

## Changes that prove themselves and take themselves back (`sshs3_change`)

- A change is made with `sshs3_change`: the command, a read-only `check` whose
  output must contain `expected`, the `rollback` command, and how long to
  observe. The broker (`ToolBroker.runChange`) looks at the check before, runs
  the change after the usual approval, and then the check must pass and keep
  passing for the observation time (looked at every ten seconds, at most three
  minutes). When it fails, the rollback runs at once, once, the check is
  looked at again, and the agent is told what happened and not to repeat the
  change. When the rollback fails too, the agent is told to stop.
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
  `buildCompilePrompt` shows the pages the source bears on in full, and
  `parsePageOps` takes the answer strictly: only a shown page may be updated,
  a target must be one of the workspace's own names, at most four pages per
  source. A long source is worked in stretch by stretch.
- **From finished work.** When a conversation or a ticket ends and something
  was run, or a page covers the subject, `buildLearnPrompt` asks what was
  confirmed and adds it to the right page (through the same learning queue as
  memory, so any installation can do it).
- **Saved at once, undoable.** A change is applied immediately and recorded
  in the page's history with the text it replaced (the newest three);
  `kb-page-undo` takes it back, and undoing a page's creation removes it. A
  page a person edited is marked: from then on the assistant's text is added
  under a heading of its own instead of replacing theirs.
- **Review** (`lintKnowledgeBase`): pages about servers the workspace no
  longer has, pages whose sources were all removed, pages unchanged for 180
  days, pages no agent opened in 30, sources that led to no page, and gaps:
  questions an agent asked that found nothing real (`coverage` tells a match
  from a stray shared word). On request a model compares pages about the same
  systems for contradictions; a quote that is not in its page is dropped.
- **Shared.** Pages travel through the team bucket like agents and sources.

The context no longer carries every document in full (it did, and was cut):
it carries the page index, a short list of the sources, and in full only what
the active agent is bound to.

Checked with stubbed model responses (`aiHubKbPages.test.ts`,
`knowledgeBaseView.test.tsx`) and in a browser against a stand-in model. Not
checked, and it is what matters most: what a real model writes. A page is
acted on, so read the first ones it produces before trusting them.

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
- The interface is in English. The demo lab's data, and the example answer,
  are still partly Swedish.

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

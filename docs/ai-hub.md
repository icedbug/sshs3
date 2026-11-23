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
  agent runs, scheduler and snapshot. It is one object whose code is kept in a
  file per area: see "Where the hub's code is" below. The agent tool
  implementations (`sshs3_*`
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
    passed since. Something was changed when a change card (`sshs3_change`)
    ran or a file was written. A plain command never counts: nothing looks at
    what a command did. Each is bounded, so a stuck run can end.
  - *Thorough mode*: `ultrawork` / `ulw` in the request adds a section to the
    instructions, asks for a task list and doubles the turn budget.
  - *What the team knows about a failure* (`failureHints`): a failed command's
    result carries the team memories and skills that match it (exact error
    signature first, else at least three distinctive shared words).
  - *Investigators* (`sshs3_investigate`, `HubService.investigate`): the
    agent hands precise questions to runs that only look, in
    parallel (all at once), each with a fresh context,
    `workspace_context`, `sshs3_kb_search` and `sshs3_storage_ops`, and, when
    one can be opened, a terminal of its own on the asking run's target. An
    investigator is told to only look and is given no change card and no file
    write. Nothing checks what its commands do. The asking agent gets their
    reports back together, a failed one with its error. They cannot delegate. Stopping the asking run
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
  - *Which model a run uses* (`AiConfigStore.getConfig`). There are four
    kinds of work: the chat and the agents (`primary`), quick background
    work (`fastTriage`), reading for memory (`backgroundDistill`) and search
    (`embedding`). A kind of work with a saved model of its own uses it.
    One without uses the saved model chosen as the main model, and when no
    saved model is chosen, the fields under Model. The model for background
    work (`fastModel`) names the model for the two background kinds when
    neither has a saved model of its own; conversations never use it. A
    background run that fails on that model is run once more on the main
    model (`mainModelOnly`). Every task records the model it ran on
    (`task.model`).
  - *Passing provider errors*: 408/429/5xx/529 and network errors are tried
    again up to three times with backoff, honouring `retry-after`; a rejected
    request (4xx) is not.
- **`PlanMode`** — plan first, then act. The agent proposes a plan with
  `sshs3_plan_propose` when the user asks for one (`/plan` in the request) or
  on its own for a risky change. A plan has a goal and steps, each with
  target, exact command, risk, the check that shows it worked and, above low
  risk, a rollback; a plan without these is refused with the reason. The
  risk is the model's own word, for people to read: nothing checks it against
  the command. A command, check or rollback
  is shown whole (up to 2,000 characters) or the plan is refused: a person
  never approves half of one. Goal and action are cut at their end when long.
  - *Review*: before the user sees it, a separate read-only run on the main
    model checks the plan against the workspace and answers `approve` or
    `revise` with findings. An answer that cannot be read, or a review that
    could not run, is `unreviewed`, never an approval. The planning agent is
    told the findings; a fourth version without an approval is refused.
  - *The gate* (`planGate`, in the run loop before the broker): while a plan
    is proposed, while a sent-back plan is being revised, and in a request
    that asked for a plan and has none approved, change cards
    (`sshs3_change`), file writes, tools of other systems (`mcp__*`) and
    management operations that change something are held. `terminal_command`
    and `sshs3_cluster_exec` are not held: nothing looks at what a command
    does, and the agent is told to change nothing with one.
  - *The decision* (`plan-decide`, the plan card in the conversation):
    approving sets the agent's task list to the plan's steps and sends it to
    carry them out; sending it back with a note has the agent revise;
    declining without a note drops the plan.
  - *What approval covers* (`planCoversCommand`, in `ToolBroker.authorize`):
    a change card made exactly as a step lists it (command, check, expected
    text, rollback) and that has not run yet is not asked about again. Any
    other change card, a second run of the same one, and every file write are
    asked about as usual. A plain command a plan lists runs like any other
    command, and its step is ticked as run. A plan can instead have
    every change card ask (`plan.askEach`): when the plan's own text
    promises separate approvals or the agent set `askBeforeEachChange`
    (`"plan"`), when the person ticked "Ask me before each change card" on the
    card (`"person"`), or when they approved with a note and made no choice
    (`"note"`: only the agent reads a note, so it is never taken to mean
    less asking). The card and the message to the agent say which holds.
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
  `ingestFromStorageProvider`), into the collection and cluster the request
  names, with the person who read them in as author; the answer lists what was
  added, updated, already there and left out (unreadable, too large, over the
  limit of files). The demo StorageGRID documents are used only for demo
  targets.
- **`SelfLearningService`** — learns a fix from a failed command followed by a
  successful one (`learnFromCommandResolution`), writes post-task playbooks
  (`reflectOnCompletedTask`), consolidates memories (`runReflectionCycle`),
  discovers topology edges and applies memory feedback. A command tied to one
  file at one moment (`isOneOffCommand`: guarded by a checksum, an edit of a
  numbered line, a text written in place, a dated name) is never kept as a fix
  or a playbook step, and Ctrl+K offers a learned command only when it shares
  at least half of what the request asks for. Commands, snippets and
  output are masked with `privacy.ts` before they are stored; counters and events
  persist in `HubStore` (`selfLearningState`).
- **`HubStore`** — the hub's own data, `<hub dir>/hub.json`, written through
  the app's shared `writeFileAtomic` (a temporary file, synced, then renamed).
  A file that cannot be used never turns into a fresh start without a word:
  - A file that is empty or is not a store is kept beside it as
    `hub.json.corrupt-<time>`, and the hub starts fresh.
  - A file that could not be read at all (locked, no permission) is left
    alone. The hub then runs with default settings and safety rules and saves
    nothing until the app is started again.
  - A secret of an MCP server (a header, an environment value, its address)
    that is stored encrypted and cannot be decrypted on a start is empty in
    memory, and its ciphertext is written back unchanged until it is read on a
    later start or entered again.
  - A save never throws. A secret that cannot be encrypted (a web server whose
    key is broken) is left out and the rest is saved.
  Each of these is said to the person: the snapshot's `storeProblem` holds the
  text, and the panel shows it as a line above everything else. Tests:
  `tests/main/hubStoreProblems.test.ts`.
- **`TerminalRegistry` / `ToolBroker` / `shellAdapters`** — terminal authority:
  correlated `OSC 777;SSHS3;<nonce>;BEGIN … END;<exit>;<cwd>` framing and
  `OSC 133;D;<exit>` shell integration. A successful command reports the failure
  it resolved (`resolvedFailure`), which drives self-learning for both agent and
  human commands.
  - *Text that arrives after its marker.* Windows' pseudo console passes the
    markers straight through and repaints the text printed in the same burst a
    moment later, so the output of a fast command arrived after its end marker
    and was lost. On Windows a command's frame is therefore closed when the
    shell's prompt is back (the prompt is learned at the handshake, which
    prints nothing), or after 150 ms without text. Where the prompt is not the
    known one, the late text is kept and marked as such: where the output ends
    is not guessed. The rest of the typed line's echo is taken out of the
    output when a marker overtook it, and only when it is exactly what was
    still missing of the line.
  - *A terminal the hub opens for itself* (a schedule, an investigator, a
    ticket nobody sits at, another server of the cluster) is connected to
    once its prompt is there (`armAtPrompt`), never while the connection is
    still being made. One that does not get to a prompt is closed again, and
    the error says what it last showed.
  - *A run that hangs.* A stopped run that does not end by itself (blocked in
    a tool call on a connection that hangs) is let go of after ten seconds:
    whoever waits for it is released and the conversation can go on. An SFTP
    connection whose ssh stays silent for 45 seconds, with nobody being
    asked anything, is ended.
- **Prompts.** A person's message that is longer than 16,000 characters loses
  its middle, with a line saying so, never its start (`boundedPrompt`). The
  hub's own prompts (reading, pages, contradictions, reviews, the workforce
  lead) open with their instructions and quote bounded data, and are passed
  whole. An answer with pages that are not in the format asked for fails the
  run with that reason instead of counting as "nothing to write".
- **No command classifier.** An earlier version had a file,
  `CommandSafetyService.ts`, that read every command and called it safe,
  modifying or destructive. It is gone. A
  command an agent runs is not looked at and nobody is asked about it. What
  still waits for a person is listed in
  [What is checked and what is not](#what-is-checked-and-what-is-not). Three
  small files hold what was kept:
  - `safetyPolicy.ts`: the rules a workspace starts with
    (`DEFAULT_SAFETY_POLICY`) and which tags mean production (`isProdTag`).
  - `sensitivePaths.ts`: whether a path names a file that may hold a secret
    (`isSensitivePath`). Paths only. It is used by the file tools of a run
    asked for from chat (`sensitiveFile` in `chatFence.ts`) and nowhere else.
    It stops no command.
  - `olderStores.ts`: takes the old rating's fields out of a stored hub when
    it is read (`dropCommandRating`): `riskLevel`, `riskReason` and
    `parsedSubcommands` on a change, `sessionAllowPrefixes` on a conversation,
    and `autoApproveSafeReadOnly`, `blockDestructiveWithoutConfirm` and
    `commandAllowPrefixes` in the safety rules. They are not kept and not
    shown.
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
  `sshs3_storage_ops` only; all at once unless a concurrency is named) and
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
  memory grows on its own, with two exceptions that wait for a person: what
  would take the place of a memory a person wrote (an update of it, or a new
  memory under its title), and everything from a conversation in which no
  command ran and showed a result, because that is the assistant's own answer
  (`mayLearnUnreviewed`, `replacesPersonMemory`). Each saved one stays in
  `memoryProposals` with
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
  provider. A conversation about a server marked Personal is left out
  (`onPersonalServer`): it is not uploaded and nothing is learned from it,
  with or without a bucket, because what is learned becomes team memory and
  shared pages. It is told by the terminal's own server while the terminal is
  open, and afterwards by the server's name or address: its target, a command
  it ran, or a terminal that was put before it. The setting "Learn from
  finished work" says so. Not covered: the team's activity log, which still
  carries what a person did on a personal server
  (`tests/main/personalServerLearning.test.ts`).
- **`McpClientManager`** — MCP over stdio and HTTP with a catalog of nine
  presets (`MCP_MARKETPLACE_CATALOG`). Before a server is started or called
  the hub is asked whether it may be reached (`assertMcpReach`): on a shared
  server a stdio server is an administrator's only (it runs on the server's
  host as the server's own account), and an HTTP address goes through
  `guardUrl` like a notification. Redirects are not followed, and an address
  counts as connected only when it answers `initialize` and `tools/list` as
  an MCP server, not whenever it answers JSON. In demo mode `assertMcpReach`
  refuses every server: a demo process starts no MCP program and calls no
  MCP address (see [MCP in the demo](#the-demo-labs-incidents-srcmainsim)).
  A person's choice for a tool (Allow, Ask, Deny) holds for the server it was
  made about: when the server's command, arguments or address change, tools
  set to Allow are asked about again, and Ask and Deny stay (`mcp-save`).
  Every answer of an MCP tool carries the note that it is data from another
  system, whether the call ran unasked or after a person approved it
  (`mcpAnswerNote`). Tests: `tests/main/mcpToolTrust.test.ts`.
- **`S3WorkspaceSyncService`** — team workspace sync over an S3 bucket. Memory
  entries keep all their metadata (tier, cluster, confidence, success/failure
  and usage counts, feedback score, `autoLearned`, `sourceCommand`,
  `errorSignature`) through S3 and Team Vault sync (`WorkspaceMemoryEntry` in
  `src/shared/types/teamVault.ts`); credentials are never uploaded.
  The bucket's invite code holds its secret key. It is in no status and no
  snapshot: the interface asks for it with a request of its own
  (`workspace-s3-invite`) when a person presses "Copy invite code", and on a
  team server only an administrator is answered. No tool an agent has makes
  that request. `tests/main/teamBucketSecret.test.ts` walks what an agent is
  given (the context, the snapshot text, every management tool's answer) and
  fails on the code or the key.
  A workspace file in the bucket that cannot be read (cut off, or not a
  workspace at all) no longer stops the sync of servers and memories for
  everyone: it is kept beside itself as `workspace.broken.json`, written
  again from the installation's own copy, and the status says so (`notice`).
  What only the broken file held comes back when the installation that wrote
  it syncs (`tests/main/teamWorkspaceFile.test.ts`).

## Where the hub's code is (`HubService.ts`, `areas/`)

The hub was one file of 11,420 lines. It is still one object: `HubService`.
Its code is now kept in a file per area, in `src/main/ai/hub/areas/`.

Each area's file is a class that is never made into an object of its own.
Its methods are put on `HubService` when `HubService.ts` is loaded
(`areas/mix.ts`), and run as the hub's: `this` is the hub in every one of
them, and each says so in its first parameter (`this: HubService`). So a
method in one file calls a method in another as `this.other()`, and a test
that replaces a method on a hub replaces it for all of the hub's code. Two
parts that define the same method name are refused when the file loads.

| File | What is in it | Requests |
| --- | --- | --- |
| `HubService.ts` | The hub's state (every field), its start and end, the snapshot, the clock (`tick`), `changed`, and the handing out of requests | none of its own |
| `areas/routes.ts` | The table of which part answers which request, and its types | |
| `areas/conversations.ts` | A person's requests about a conversation (start, reply, stop, checkpoint, take a change back, fork, compact), the AI settings, a one-line suggestion, the activity log | 19 |
| `areas/runs.ts` | A run: starting it, its events, its budget and clock, stopping it; runs on an external agent | none: started by other parts |
| `areas/chatRuns.ts` | Conversations asked for from a chat thread: the fence they run inside (`chatFence.ts`), starting and going on, their own terminals, and following a run without a browser (`onRun`, `runView`) | none: called by the chat agent |
| `areas/safety.ts` | The safety rules (a person's own, and the ones an administrator sets for everyone), approvals of changes and plans (also by a second person), rules and runbooks | 12 |
| `areas/tickets.ts` | The board: goals and tickets, starting a ticket's agent, the board's clock | 11 |
| `areas/agents.ts` | Agents, external runners, workforce runs, specialists, a plan's reviewer, investigators | 11 |
| `areas/knowledge.ts` | The knowledge base: documents, pages, search, gaps | 19 |
| `areas/memory.ts` | Team memory, proposals from runs and activity, the learning queue, tidying up | 9 |
| `memory/mergeMemory.ts` | Matches, merges and replaces memories. Its rule tests sit beside it. | |
| `areas/servers.ts` | Servers, the links between them, saved profiles | 10 |
| `areas/sharing.ts` | The bucket, the board kept on a server, the shared workspace | 4 |
| `areas/mcp.ts` | MCP servers and what their tools may do; the keys and commands of an outside client | 9 |
| `areas/inbox.ts` | What waits for a person, notification channels, the telling | 6 |
| `areas/facts.ts` | What is on the servers, and what changed | 4 |
| `areas/alerts.ts` | Alerts in: an alert becomes a ticket; the address and the routing rules | 4 |
| `areas/evals.ts` | Tests for the agents; the nightly upkeep and the daily report | 5 |
| `areas/audit.ts` | The audit log and terminal recordings | 3 |
| `areas/simulation.ts` | The demo lab's incidents and its scripted run | 4 |
| `areas/schedules.ts` | Schedules | 3 |
| `areas/chatAndAtlassian.ts` | The context bot (what the team says in chat), Jira and Confluence: where a request reaches the bridges | 16 |
| `areas/chatAnswering.ts` | The agent bot in chat: its settings and connection, linking a chat account, answering its changes in the app. It hands each request to the web server (`host.chatAnswering`), which checks who asks | 11 |
| `hubShared.ts`, `hubHost.ts` | Constants and small functions the parts share; what the hub is given by whatever runs it | |

**To add a request:** add it to `HubRequest` (`src/shared/types/aiHub.ts`),
give it a part in `areas/routes.ts`, and add its case to that part's
`handle…` method. The compiler refuses the build until all three agree. A
case answers by leaving something in `reply`, or returns
`{ snapshot }` when it went on in another request and that one's snapshot is
the answer.

**What is not there.** The parts are files, not walls: any method can still
reach any field of the hub. A field cannot be `private` once a method in
another file uses it, so `private` was taken off the members the moved code
needed and left on the rest. The fields stay in `HubService.ts` because their
initial values are set in the order they are written there.
`reflectTaskCompletion` and `recentServerChanges` stay in the class too: the
first is called from the native tool bridge through a narrower type of the
hub, the second uses a static method of the class.

**How the move was checked.** Nothing was rewritten by hand. A script moved
each method and each request case as text, and a second script compared all
305 members and 144 request cases with the commit before the split: none
differs, none is missing, none is new. The only changes a move makes are
`private` taken off a moved method, `this: HubService` added as its first
parameter, a case's `return this.snapshot()` written as
`return { snapshot: … }`, and a path named inside the code written from the
new folder. `tests/main/hubAreas.test.ts` keeps the files to a size
(`HubService.ts` under 2,000 lines, a part under 1,500) and checks the table
against the files.

## Where data may go (`src/shared/dataDestination.ts`)

The settings let a person choose where data may be sent (any service they set
up, only services in the EU, or only this machine and their own network),
what is hidden before anything is sent, and whether they have confirmed that
the model's provider keeps none of it. `validateEgressPolicy` answers whether
an address is allowed under those choices; a run asks it before it calls a
model, and the settings card "What leaves this machine" shows the answer.

- **One piece of code for both.** There were two copies, one in the main
  process and one beside the settings, and they had drifted in what they
  asked. The card asked whether the "keeps nothing" confirmation was there
  and said "Blocked by policy" without it; a run never required it. So the
  page said a cloud model was blocked while runs used it. Both sides now use
  `src/shared/dataDestination.ts`, and the card asks exactly what a run asks
  (`requireZdr: false`): a confirmation that is missing is shown as a note,
  and "Stopped by these settings" is said only when a run would be stopped.
- **Plain words.** What the card and a stopped run say is written for a
  person who does not know the terms: "You chose to send nothing outside your
  own network, and api.anthropic.com is outside it." The identifiers in code
  and in saved settings (`egressPolicy`, `zdrConfirmed`, `piiScrubbing`) are
  unchanged.
- Not decided here: whether a run should be stopped until the confirmation is
  ticked. Today it is not. Making it so is one option (`requireZdr`) and
  would stop every cloud model until each person ticks the box.

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
local to the installation that wrote it; it is not synced. Neither is what the
contradiction check found: the findings, and how far through the pairs of
pages the check has come, stay on the installation that ran it that night
(`kbContradictions`, `kbPairOffset`), so teammates do not see them, and
another installation that takes the next night's claim starts from its own
place. Sharing them is not done yet: a finding quotes its pages, so one about
a private page has to stay where it is, and a finding one person dismissed
has to go away for the others too.

**Dependency map.** An agent that sees a link (a connection, a mount, a
replication target) saves it with `save_infra_edge` and an `evidence` text. Such
a link is stored with `proposed: true` and is shown under Infrastructure →
Dependencies as a suggestion with Confirm / Dismiss. A link the app finds by
itself in command output (`discoverTopologyEdges`) is a suggestion in the same
way. Only confirmed links are
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

### Sources for an answer

In the chat, open **Show sources** on the assistant message you want to check.
Each direct model request contributing to that answer has its own list. A KB
index entry records that the assistant saw a page title. Opening the page adds
its revision and the body as a source for the following request. A memory
reference records the entry and its update time. Terminal references show the
masked material included in that call. A citation in the reply is marked
separately from material that was merely supplied as context.

Sources are captured when the request is sent. Editing the KB later does not
change which revision the earlier answer used. The compact conversation list
carries availability only. Details are loaded for the individual message when
opened. Older messages, scripted demo replies and external runners whose model
requests cannot be observed can have no recorded source information. Terminal text follows the workspace retention period. The source view marks an expired excerpt and keeps its fingerprint.

### Investigating an incident

The hypothesis tree records observations for and against each proposed cause.
An observation can link to a source from the investigation. It can supersede
an older observation, which remains visible in the history. A reference on a
shared ticket resolves only where the originating conversation is available.

A ticket's diagnostic outcome is separate from the run status. For an alert
or investigation, a confirmed cause requires current supporting evidence from
a recorded source, such as the timestamped server reading that supplied a measured value. If the cause remains uncertain, the ticket shows what to
observe next. Reaching the end of an agent run by itself does not confirm the
cause.

In the ticket detail, **Link an access request** records a shareable HTTPS
link from the team's identity system, the resource, reviewer and expiry.
The details travel with the team ticket. Approval and revocation remain in
the identity system, and sshs3 continues to enforce its own command approvals.

## Tests for the agents (`EvalSuite`, `AgentTestsView`)

- **A case** is made from a finished conversation (`caseFromTask`): its first
  question, its mode and agent, and what every workspace tool answered at the
  time (the run's own lists are left out). The agent is the one that began the
  conversation, also when it was handed over later. A person adds what should
  happen:
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
  no blended score. A run that failed before it gave an answer (the model or
  its API refused) is recorded as "could not run" (`inconclusive`): it is
  neither a pass nor a regression and is left out of the comparison.
- **As it was.** The replay is not given what is known only now
  (`asOfEvalCase`): activity after the case was made, the servers' latest
  readings and recent changes, and what the open terminals show. Memory and
  the pages are given as they are now; they are what a test tries.
- Editing a case's expectations changes the parts that were sent and keeps
  the others.
- The newest five runs are kept per case, so the view can say which cases got
  better or worse since the run before (`compareRuns`). Cases are shared with
  the team like the rest of the setup.
- A replay is only as good as its recording: when the agent, changed, asks for
  something the original conversation never looked at, it gets "not recorded"
  and may conclude differently for that reason alone. The count is shown.

## What is checked and what is not

A command an agent runs is not checked. Nobody is asked about it, also when it
deletes something. What waits for a person is a change card, a file write, a
plan and a guarded settings change.

This is a working agreement with the agent, not a lock. The agent is told to
make every change with a change card, and it can still run the same thing as a
plain command. What an agent can do on a server is decided by the account it
logs in with. Give it an account that can only do what you accept.

Two words:

- **A plain command**: `terminal_command`, `terminal_verify`,
  `sshs3_cluster_exec`, a command an external agent asks to run, and the
  helper commands inside a card (its check, its rollback, a preflight).
- **A card**: a change card (`sshs3_change`, which carries a check and a
  rollback), a file write (`file_write`), a plan (`sshs3_plan_propose`) and a
  guarded settings change. A call to a tool of another system (`mcp__*`) that
  did not say it only reads waits as a change card does.

| Case | A plain command | A change card or a file write |
| --- | --- | --- |
| Advice | Not run | Not run |
| Ask first | Runs. Nobody is asked | Waits for a person |
| Plan, or a plan that waits | Runs. Nobody is asked | Held until the plan is approved. A change card the approved plan lists then runs without a second question |
| Auto | Runs | Runs without asking. On a server tagged production it waits for a person while "Always ask before a change card or a file write on production" is on |
| A change freeze on the target | Runs | Refused |
| Two people on production, or a cluster that needs more than one approval | Does not apply | Applies |
| A cluster whose highest mode is Advice | Not run | Not run |
| An investigator, or a chat channel set to "Commands only" | Runs. A chat run stays on the servers its channel was given | Refused |
| Asked for from outside, through sshs3's own MCP server | Waits for a person | Waits for a person |
| A guarded settings change | Not a command | Waits for a person in every mode |

What went with the classifier:

- No command is rated. There is no "read-only" or "destructive" badge, and no
  rule that a destructive command always asks.
- "Run read-only commands without asking", "Stop destructive commands until
  reviewed" and the allowed command prefixes are gone, and so is "always allow
  commands that start with" on the approval bar.
- A command that reads a file with secrets is not asked about. The file tools
  of a run asked for from chat still refuse such a file by its path
  (`sensitivePaths.ts`). That is the file tools' own rule and stops no command.
- In Auto on production a plain command is no longer refused.
- A card's check does not have to be read-only, and its rollback is not
  screened. The card shows the command, the check and the rollback in full.
- `terminal_command` has no dry run option. The agent writes its own dry run
  command (`kubectl --dry-run=server`, `terraform plan`, `rsync -n`).

What did not change: the budget of a run, the guard against running one
command again and again for one answer, the servers a chat run may reach,
masking of secrets, and the audit log. Every finished command is in the audit
log. A card and a file write are also written there before they run. A plain
command is written once, when it has ended. One that is still running after
five seconds is written as "started" as well, so that a command that hangs is
in the log before it runs out of time. What is running when the app closes is
written as "uncertain" before the app is gone
(`tests/main/auditCommandStarted.test.ts`).

Where it is decided: `ToolBroker.authorize` for every tool of a run,
`isPlainCommand` (`src/shared/types/aiHub.ts`) for which of the two an action
is, `planGate` (`PlanMode.ts`) for what is held while a plan waits, and
`areas/runs.ts` for what an external agent asks for.
`tests/main/commandsRunUnasked.test.ts` holds each row of the table, through
a real hub with stand-in terminals. What an external agent asks for is in
`tests/main/aiHubAcpRuntime.test.ts`.

Not tried: a run with a real model since commands stopped being asked about.
The runs with a real model that this guide records were made before that,
when a command that changed something was asked about. Whether a model keeps
to change cards when a plain command would do the same is not known.

## Changes that prove themselves and take themselves back (`sshs3_change`)

- A change is made with `sshs3_change`: the command, a `check` that
  must exit 0 and whose output must contain `expected`, the `rollback`
  command, and how long to observe. The tool's own text tells the model both
  halves of that rule (it used to name only the text, and a correct fix was
  rolled back because its check ended in a `diff` that exits 1), and a failed
  check says which half failed (`checkFailedBecause`). Nothing runs before the
  change is approved, not even the check.
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
  did before; otherwise it says it is not back as it was. "Reads as it did
  before" is seen in one of three ways, tried in this order, and the result
  says which (`comparedBy`, `rollback.comparison`, the audit entry):
  the same exit code and output (`exact`); the same once dates and times,
  "… ago", process ids and the counters uptime and systemd print are left out
  (`stable`, `stableObservation` in `ToolBroker.ts`); or the check passed
  before the change and passes again by the card's own expected text
  (`expected`). A check that failed before and fails again counts only by its
  output: two failed checks are not the same state by themselves. A number
  that may be a setting (a timeout, a port, a count of workers) is never
  left out. A rollback from the Changes view compares the same way, from the
  hashes kept with the change. `tests/main/changeRollbackComparison.test.ts`.
  A rollback from the Changes view runs once. When the terminal refused it
  before anything was typed (something stands at its prompt, it is not ready
  any more), it is not recorded as run: the audit log gets "rollback-not-run"
  and the person can try again (`tests/main/changeManualRollback.test.ts`).
  A change command
  that failed while the check still reads as before runs no rollback. A run
  that loses the terminal mid-change (stopped, taken over, timed out) leaves
  it "uncertain" and says the rollback did not run.
- "Uncertain" is only for a command that was typed and whose end is not
  known. A change or a command that is stopped after it was allowed and
  before it is typed (the rules changed, a freeze began, the run ended, or
  the terminal was no longer the run's to type into) is marked as not run:
  status `denied`, with "Not run:" and the reason in its output and in the
  audit entry. `tests/main/changeNotRun.test.ts`. The expected text is
  matched as a word or phrase: "inactive" does not pass for "active".
- Every command a card types counts against the run's budget: the check
  before, the change, each later look at the check, and the rollback (a look
  before a plain command, `preflightCommand`, counts too). A card is never
  stopped half-way for the budget: what is over is refused at the next call.
- A call that carries an `idempotencyKey` is answered from a ledger when it is
  made again with the same arguments. A key is remembered for a day, not for
  as long as the app runs. `tests/main/brokerCountsAndKeeps.test.ts`.
- Only a proven fix is learned: a change counts for team memory only when its
  check passed and had not passed before.
- Nothing looks at what the command, the check or the rollback do. The model
  is told to give a check that only looks. The card shows all three in full
  (`ChangeProof`, the terminal's approval bar, the chat card) and the person
  approves what they read.
- In Auto a change card runs without asking, except on a production target
  while "Always ask before a change card or a file write on production" is
  on: there it waits for a person.
- While a plan is pending, `sshs3_change` is held back, like a file write.

## What a person approves is what runs

- The approval shows the exact command, masked only where a literal secret
  is (`forApproval`). The masker no longer swallows code: a `$(…)`, backticks,
  a chain after `token=…`, or what follows a lone private-key header stays
  visible. When anything was masked, the change carries `hiddenValues` and the
  card says the real values run where it shows `[redacted]`.
- A password written as an ordinary word of a command is masked too, in the
  card, the store and the audit log: `sshpass -p`, `redis-cli -a`,
  `docker login -p` (and podman, helm and the like), `mongosh -p`,
  `ldapsearch -w`, `zip -P`, `7z -p…`, `htpasswd -b`, `openssl -pass pass:…`,
  `smbclient -U name%…`, `ipmitool -P`, `rabbitmqctl add_user`, a flag whose
  name ends in password, token or api-key, and what `echo` or `printf` pipes
  into `chpasswd`, `sudo -S`, `passwd --stdin` or `--password-stdin`
  (`maskCommandLineSecrets` in `privacy.ts`). The rules go by the program's
  name: `-p` is a port to ssh and a password to sshpass. A variable or a
  command substitution in that place is shown as it is. A program that is not
  on the list is not covered: a password given to it as a plain word is shown.
  The command that runs is always the one that was written, never the masked
  one. `tests/main/privacyCommandLines.test.ts` holds the list.
- Nothing is shortened for approval. A command, check, rollback or cluster
  command too long to show in full is refused, not cut.
- The approved command reaches a bash, zsh, sh or dash shell byte for byte
  (see Terminal authority below). In fish it is typed as it stands.
- An approved plan covers a command by its exact text (`commandHash`), never
  by how it looks once masked, and never one with hidden values.
- File changes are approved as a unified diff (Inbox, task, Changes), keep
  their path whatever the agent calls them, and are refused when the new
  content would be shown masked. A file is rewritten through the model only
  if it could be read whole (28,000 characters); a longer one is read as
  "not complete".
- A file write that wrote nothing says so (`FileTools.ts`). Refused at the
  last look at the rules (a freeze began, the rules changed) it is marked as
  not run and nothing is written, not the old content "put back" either.
  Refused by the server before it began (the login account may not write the
  file, the file system is read-only, the folder is gone), or failed while
  the file still reads as it did, it is "failed" and "Not written", and
  nothing is put back. For a file the account may not write, the agent is
  told the way forward: make the edit with `sshs3_change` and sudo, with a
  check and a rollback. Only a write that may have happened in part is put
  back; "uncertain" is for when that did not work.
  `tests/main/FileToolsNotWritten.test.ts`.
- What a person writes with their yes reaches the agent as `personNote`: on
  a change card, a file write, a call to a tool of another system (`mcp__*`)
  and a guarded settings change.
- Every change records how it was decided (`decidedHow`): a person (with
  `decidedBy`: name, time, yes or no), the safety rules, an approved plan,
  nobody answering in time, or the run being stopped. Changes and the audit
  log say which. A run that ends leaves nothing pending or "approved": an
  external agent's action it never reported back becomes "uncertain".
- A run waiting for a person is not stopped by its own clock; the wait is
  given back when the answer comes. An external agent may have several
  questions open; each answer counts as given. A command an external agent
  asks to run is a plain command: it runs without asking in every mode but
  Advice. An action it gave no command for (an edit, a delete, a move) waits
  for a person, as a file write does.

### Two people (`peer-approve`, `approveAsPeer`, `approvePlanAsPeer`)

The rule "Two people must approve a change card or a file write on production"
(`requirePeerApprovalOnProd`), and a cluster policy that asks for more than
one approval, need a second person. Both are about change cards and file
writes. A plain command needs nobody. There is one only on a web server with
more than one account. Everywhere else the rule is not in force and cannot be
switched on (`peerApprovalPossible`, shown as the reason on the safety card),
because a change would wait for an answer that cannot come.

- **Who the second person may be** is decided by the server, where the
  accounts are known (`WebTenantManager`, `evaluatePeerApproval`): never the
  person whose run it is, never a disabled account, and on production only an
  administrator of the server or a member of one of its approver groups. A
  member for whom nobody qualifies cannot switch the rule on. An
  administrator who is the only one who may approve production cannot either.
- **A change.** The run's own person approves in their inbox as usual; that
  counts as one. The same change is in the inbox of everybody else who may
  answer it, as "Needs a second person", with the command, the server, whose
  run it is and who has approved so far. It runs when as many different
  people have approved as it needs. Anybody's no ends it. The record names
  each person (`approvals`, with `peer` on the ones given by somebody else),
  and one person counts once, by account and not by name.
- **A plan** that touches production takes two people in the same way. It
  says so on its card and in the inbox from the moment it is proposed
  (`requiredApprovals`, written by `planProposed`). The other person reads
  every step, with its command and where it runs, before answering. The two
  count in either order, and the agent starts when the second answer is in.
  What the person whose run it is chose about being asked before each
  change card, and what they wrote, is what the agent is told. What the second
  person writes is shown to the first in the conversation and is never sent
  to the agent as theirs. A second person's no does not send the agent back
  to work: the plan is "not approved", and the person whose run it is decides
  what next.
- **A plan two people approved covers the change cards it lists for both**
  (`planApprovalsCover`). A change card exactly as the plan lists it then runs
  without asking either of them again, and its record names the two. A plain
  command needs neither of them, listed or not. This
  holds only for a plan approved as one for production (`plan.production`),
  so the second person was somebody who may approve there. A change card
  with hidden values, a change to the rules, one asked for from
  outside, and anything the plan does not list are put to both people.
- **The chat agent's changes.** A conversation asked for in a Slack or
  Mattermost channel runs in the chat agent's own account (see
  [Agent in chat](#agent-in-chat-the-agent-bot-chatagentservice)). That
  account has no owner to count as the first person, so a change or a plan
  there that needs two people needs two different people who may approve it.
  The chat agent is never one of them. They answer in the thread, once they
  have linked their chat account, or in the app under Settings, Agent in
  chat, "Waiting for your answer". The same rules decide who may: never a
  turned off account, one person counts once, and on production only an
  administrator or a member of an approver group. With fewer than two such
  people on the server, the change is refused at once instead of waiting.
  These changes are not in anybody's Inbox.
- Checked in `peerApprovalOnServer.test.ts` over each account's own
  websocket, with a terminal that answers: a member's production change runs
  once the administrator has approved; a refusal runs nothing; another member
  is not asked and cannot answer; a plan takes two in either order and the
  change card it lists then runs unasked. Also checked in two browsers against a
  server in demo mode with a stand-in model: the member approves in his
  inbox, the administrator finds the change in hers as "Needs a second
  person" and approves, and only then does the command run; the same with a
  plan, whose listed command then runs without a new question. The two
  browser runs were made before commands stopped being asked about, and were
  not repeated since. Not checked
  with a real model, and not with single sign-on groups from a real identity
  provider.

### Rules for everyone on a server (`team-rules-save`, `TeamSafetyRules`)

Each person's safety rules are their own. On a web server an administrator can
also set two rules that hold for every account, the administrator's included.
Nobody's own rules can loosen them. The settings show them over a person's own
rules (`TeamRulesSection`): an administrator changes them there, a member
reads them. There are none in the desktop app and none in the demo lab.

- **Two people on a change card or a file write on production.** The same rule as a person's own
  (above), switched on for everybody. `safetyPolicy()` counts it as the
  person's own being on, so everything that follows from it is the same. A
  person's own switch then has nothing left to decide and is shown as on. It
  holds also where nobody else may answer. An administrator nobody else may
  approve production for (the only one who may) can then approve one change
  alone, in the Inbox, with a written reason: "Approve this change alone".
  The reason is recorded with the change (`adminException`) and in the audit
  log. A member with nobody to ask is refused at once, and the settings say
  which of the two holds.
- **A change freeze.** On every server (`*`) or on one cluster, for a number
  of hours, with a reason. A freeze stops change cards and file writes.
  Commands still run. Until it ends, the broker refuses a change card or a
  file write before anything is asked or typed (`ToolBroker`, code
  `change_freeze`), an external agent's action that is not a command is
  refused, and a plan cannot be approved. Nothing looks at what a command
  does, so a freeze does not stop an agent that runs a change as a plain
  command: the agent is told not to. An administrator can end a freeze early. A freeze a person set
  for a cluster in their own rules is stopped at the same places.
- **Where they are kept.** One file in the server's shared folder
  (`shared-workspace/team-rules.json`), read into memory when the server
  starts. Every account's hub reads the same set (`HubHost.teamRules`). A
  change is written by the administrator's hub only, goes into the team's
  activity and the audit log with who made it, and the other accounts'
  windows are told at once.
- **What a member may change of their own.** Their own switches, and their
  own two-person rule on and off. Not the one that holds for every member
  ("Always ask before a change card or a file write on production"), and not
  cluster policies. The settings send only the switch that was moved, so a
  member is not refused for what they did not touch.
- Checked in `teamRulesOnServer.test.ts` over each account's own websocket:
  the rule holds for a member who never switched it on and only an
  administrator sets it; a freeze refuses a member's change card without
  typing it and lets a command through; a cluster's freeze leaves other
  servers alone; a member changes their own rules and is refused only what
  is the administrator's.


## The audit log and terminal recordings (`AuditLog`, `SessionRecorder`)

- **The log.** Every finished command, change, file write, setting change,
  MCP request and recording goes into `audit/audit-<client>.jsonl`, one JSON
  line each, masked *before* it is hashed, each carrying the hash of the one
  before it. Changing, removing or inserting a line breaks the chain where it
  happened. A person changing the safety rules is logged with what moved
  from what to what. The team server keeps its own chain of sign-ins.
- **Anchors.** Every ten minutes the head of the chain is written to the team
  bucket (`audit/<client>/anchors/n<number>.json`), when something was added
  since the last anchor. Anchors are numbered and carry the hash of the anchor before
  them, so they are a chain of their own. Verifying checks the log, then the
  newest 2000 anchors: an anchor past the log's end means its tail was cut;
  a hash that differs means it was rewritten; a broken anchor chain means
  anchors were removed or replaced. It reports up to which entry the log is
  anchored, and stretches in which entries waited for an anchor (the
  computer was off, or anchors were removed). Without a team bucket, a cut from the very end does not
  show, and the screen says so.
- **A log that is damaged does not stop work.** An entry is written before
  every change card and file write, so a log that refused to write stopped
  every change. Now:
  - A last line that was cut off while it was written (a crash) is kept in
    `audit-<client>.jsonl.torn` and taken out of the log. The chain goes on
    from the last whole entry, with a `journal` entry that says so. The check
    then holds: nothing that was whole is gone.
  - A line in the middle that is not an entry, was changed, or leaves a hole
    stays where it is. The log writes one `journal` entry that names the line
    and what is wrong there, once, and goes on from the last entry in the
    file. The check reports the break for as long as it is in the file ("The
    log does not hold"), with the line and when the log wrote it down
    (`breaks` in the verification).
  - A file that is there and cannot be read is reported as that
    (`unreadable`), not as an empty chain that holds. Nothing is written to
    it, so change cards and file writes are refused until it can be read.
- **What a check reads.** The screen reads the newest entries from the end of
  the file. The chain is walked from the start on the first check after a
  start, when anything but this app's own writes touched the file (its size
  or time differ from what the app left), and for an export. In between, each
  entry is checked as it is written and the check reads nothing. The names of
  the anchors are listed at every check, so a removed anchor shows at once.
  An anchor's content is read once and kept until the app closes or an
  export. So an edit that keeps the file's size and puts its time back, or an
  anchor rewritten in place, shows at the next start or export, not at once.
- **The screen.** Changes → Audit log: newest first, the verdict, a filter,
  "Check it again", and Export (the file as it is on disk plus what a check
  of all of it found).
- **Recordings.** While an agent's run holds a terminal, what the terminal
  showed is recorded as asciicast v2 (`recordings/<run>-<terminal>-<time>.cast`):
  output only, never what a person types, at the terminal's real size, with
  a marker per command and an exit event (`"x"`) when it ends. Secrets are
  masked on the visible text, so colour codes cannot hide one; a line holding
  a secret gives up its colours. A private key that arrives in several pieces
  is masked as one: after its header the recorder leaves out every line that
  can be part of a key, up to its END line or the first line that cannot be.
  A prompt without a newline is written after
  300 ms. Each time a run holds the terminal gets its own file. A recording
  ends when the run lets go or loses the terminal, and is sealed into the
  audit log with its sha256; the player says whether it still matches. A run
  that held the terminal and ran no command leaves no recording and no log
  entry. They
  are removed after `retentionDays` on every installation, and are this
  computer's own: they are not shared. `recordSessions: false` turns them off.
- **The demo lab keeps its own.** In demo mode the audit log and the
  recordings are written inside the demo's own data folder. The log is not
  anchored in a bucket and not sent anywhere. The Timeline there shows
  invented example data (`demoWorkspace.ts`), and says so. While the demo's
  log is empty, the Audit log screen says so instead of "verified". It says
  that entries come when an agent runs a command or makes a change, or when
  the safety rules are changed (`safety-policy-save` is logged in the demo
  as anywhere), and names what is not recorded in the demo: a command typed
  in a terminal, a scripted walkthrough and starting an incident. In any
  mode an empty log reads "nothing to verify yet", not as a chain that holds.
- **The player.** From a timeline item or a log entry: pauses over 2 s
  shortened, speed, scrubbing, the commands as a list with ✓ or the exit
  code, and a log entry opens it at its own command.
- **What it does not do.** Anchors are not signed, so someone holding the
  installation's bucket credentials can write a consistent forgery of both
  log and anchors; other installations do not witness each other's heads
  yet. Entries since the last anchor are only hash-chained. Nothing is written
  before a plain command runs: it is written when it ends, and as "started"
  once it has run for five seconds. So a crash in the first five seconds of a
  command loses that entry. A command that several servers run at once
  (`sshs3_cluster_exec`) gets no "started" entry. These are the next steps
  the research named (signed anchors and witnesses, an HMAC key ratchet, an
  intent entry before every command).

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
  labelled "Investigator: <target>", closed afterwards) and
  `terminal_command`. Its commands run without asking anyone. It is told
  "You only look. Change nothing.", and the broker refuses it a change card,
  a file write and a tool of another system. Nothing checks what its commands
  do: an investigator that runs a changing command changes the system. Where
  no terminal can be opened (a target that needs an interactive login,
  Kubernetes sessions, the demo lab) the investigator works from context and
  says what it could not check.

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
- the safety rules (under any of the operation names the handler
  accepts: the fields decide, not the name);
- which model endpoint is used (`aiProvider`, `aiBaseUrl`, `aiEnabled`);
- adding or changing an MCP server, and installing one from the list (a stdio
  server is a program started on this computer);
- an agent or a schedule that acts on its own (`autonomous`), made, started or
  switched on by a run that does not;
- where the team's workspace is synced to, disconnecting it, and a folder that
  is synced to a bucket;
- reading a local folder or a bucket prefix into the shared knowledge base;
- the settings in "Every setting from the conversation" below: nearly all of
  them.

Not guarded: everything else, including an agent or a schedule that asks before
each change card. A conversation in Advice mode still runs no command and writes no
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

### Every setting from the conversation (`AppSettingsActions.ts`)

What the settings cards set up, a person can also ask the assistant for in a
conversation in the app. `AppSettingsActions.ts` holds these operations. Each
sends the same request its settings card sends, so the same checks hold: who
may change it, what an address may be, what a token must look like.

| Tool | What it sets up |
| --- | --- |
| `sshs3_manage_app_and_settings` | Also: model profiles (`list_model_profiles`, `save_model_profile`, `delete_model_profile`, `test_model`), the rules for everyone on a team server (`get_team_rules`, `update_team_rules`), `restore_builtin_agents`. |
| `sshs3_agent_and_mcp_manage` | Also: external agents' programs (`save_runner`, `delete_runner`, `test_runner`), what an MCP tool may do unasked (`set_mcp_tool_policy`), this app's own MCP server and its keys (`set_local_mcp_server`, `list_mcp_keys`, `create_mcp_key`, `revoke_mcp_key`). |
| `sshs3_manage_team_chat` | The context bot (`context_*`: connect, test, disconnect, which channels it reads, read back, forget, how long messages are kept) and the agent bot (`agent_*`: connect, disconnect, answering on or off, direct messages, limits and budget, one channel's rule, its model, its SSH key, its conversations, a try in the simulated chat). `link_code` and `unlink` for a person's own chat account. |
| `sshs3_manage_alerts_and_integrations` | Notification channels, quiet hours and reminders, Jira and Confluence, what is collected from servers, the address monitoring sends alerts to, and which agent starts on which alert. |

Each tool's `status` (or `list_*`, `get_*`) reads what is set up, with no
address or token in it, and asks nobody.

**What waits for a person.** Every operation above that changes something is
guarded, except these, which only narrow or try: testing a connection, reading
a chosen channel further back, stopping the context bot from reading a
channel, taking a channel away from the agent bot, ending one's own chat link,
and syncing Jira now. Collecting server facts now is guarded: it runs
commands on servers, also when collecting is switched off. A test checks that
each operation classed `guard` in `APP_OPS` asks, whatever the call carries.

**What the person approves is what is done.** `precheckSettingsOp` looks at
a call before anybody is asked, and refuses one whose card would not say what
happens:

- a call that leaves out what its operation needs (which service, which
  channel, a name);
- a value of the wrong kind. `"false"` where `false` was meant is refused, not
  passed over: the card would say a switch goes off while it stayed on;
- a server named by a part of its name. A server is its whole name, its id or
  its host, and the card shows the name;
- a new key's `tools` that the MCP server does not have for its scopes;
- a call from a run nobody sits at, even if it arrives although the tools were
  not offered.

`facts_configure` takes `exclude` and `watchPaths` as whole lists, and its
card says so. `atlassian_connect` keeps what it does not name. With one chat
service connected, `link_code` and `unlink` need not name it.

**Who may.** The request decides, as it does from the settings card. A member
who approves a change to the agent bot or to the rules for everyone gets the
same refusal the card gives, and nothing is changed.

**Secrets stay out of the conversation.** What a person writes in a
conversation is sent to the model's provider, so a token must not be written
there.

- *A secret a setting needs* (a bot token, an API key, a webhook address) is
  not a parameter of any of these tools, and a call that carries one all the
  same is refused before anybody is asked (`SECRET_PARAMS`): where a
  notification channel sends is the whole question, and an address that rode
  along in the call would be approved unseen. `guardAsk` lists the secrets in
  `GuardAsk.secrets`, the change carries the names in `secretFields`, and the
  approval card in the conversation shows a hidden field for each
  (`ChangeSecrets.tsx`). The values travel with the `approve` request, are
  held in memory until the waiting tool reads them once
  (`HubService.changeSecrets`), and are never stored or sent to the model.
  Left empty, the secret already saved is kept.
- *Only its card answers such a change.* The card always sends what was typed,
  also when that is nothing. An approval without it is refused, so the inbox,
  its shortcut key and the terminal bar cannot say yes: they send the person
  to the conversation. When two answers arrive at once, the first one's
  secrets are the ones used; a late one neither replaces nor removes them.
- *A secret a setting makes* (a new MCP key, a chat link code, the alert
  hook's address) is not in what the tool answers. It is kept in memory
  (`HubService.changeReveals`), the change is marked `reveal`, and the card
  shows it once when the person asks (`change-reveal`). The card stays open
  until then, and while it shows the value. It is kept for 30 minutes
  (`REVEAL_KEPT_MS`) and is gone after a restart: then the person makes a new
  one.

**Not from Slack or Mattermost.** A conversation asked for from chat, a
ticket's run and a schedule's run are given none of these tools
(`MANAGEMENT_TOOLS`, `CHAT_APP_TOOLS`).

**Not offered, on purpose.** Switching demo mode, quitting the app, and
approving a change: those are a person's own actions. Forgetting every
conversation is not offered either: history is not forgotten while a run is
going, and the conversation that asks is one. `test_model` asks only the
model that is set up, never an address the call names.

Tests: `tests/main/settingsFromChat.test.ts` (through a real hub, and through
the real web server with an administrator and a member) and
`tests/renderer/changeSecrets.test.tsx`.

Tried by hand with a real model (gpt-6-luna) in a browser, November 2026: a
notification channel was asked for, its address typed on the card and saved;
a key was asked for, approved, and shown once on the card and nowhere else on
the page. Two things that run found are fixed: the card folded away the moment
its key was asked for, and the model held a key to its own tool names.

An independent review of the change then found, among other things, that a
secret carried in the call was used and hidden from the card, that a plain yes
from the inbox's shortcut key let a secret-taking change through, and that a
second answer in flight took the first one's secrets away. Those are fixed as
described above, each with a test that fails without the fix.

Not guarded, on purpose, and worth knowing: an agent can create a ticket for
another agent, and the heartbeat runs it in that agent's mode. That is the
workforce doing its job; the safety rules (production, two people, a
freeze) still apply to the run's change cards and file writes.

Related hardening done with this:
- MCP servers' environment variables and headers leave the hub as names only
  (`mcpServersShown`), to the interface and to a model. The form can now set
  them; an empty value keeps what is stored (`keepSecrets`). Editing a server
  no longer wipes them or switches it back on.
- A link fetched into the knowledge base is checked where it leads before it
  is called and at every redirect (`guardUrl`, the same check notifications
  use), and fetched from the address that was checked.
- On a shared server, `sharedWorkspacePath` from a request is ignored and
  `kb-ingest-folder` is refused: both are paths on the server. A storage
  profile read with `kb-ingest-s3` has its endpoint checked like a link. A
  web server with a single account, its administrator's, is not a shared
  server for these checks (`HubHost.soleUser`): it is that person's own
  machine, as the desktop app is. The account's name and the server's own
  paths stay the server's either way.
- Web sessions are stored by SHA-256 and compared in constant time; a file
  from an older version is read and converted. Importing an SSH key works out
  the public key first and changes nothing when it cannot.
- "Add to KB" in the file editor asks first, masks recognised secrets, goes
  the same way in as other material, and says when it failed.

### Your own agent, and this app as an MCP server

The desktop app can answer a person's own agent (Claude Code, Cursor, or
anything else that speaks MCP) over the same protocol the team server uses, so
there is one set of rules for both. On desktop it listens on 127.0.0.1 only, it
is off until switched on in Settings, and it answers nothing without one of that
person's keys. In the web app, Settings and the account dialog both show the
server's `/api/mcp` address, setup snippets for Claude Code and Cursor, and
personal key management. A key is shown once, acts as them, and can be taken
back. A key stops working after 30 days unless another time is chosen when it
is made. It works for ever only when the request says so (`neverExpires`, or
"Never" in Settings, which sends 0 days); a request that leaves the time out
gets 30 days, also when the assistant makes the key (`create_mcp_key`). A
request that carries an `Origin` header is refused before the key is
read, which is what keeps a web page on the same machine from reaching it.

A key says what it may do: read, write tickets, or ask for a command on one
named server. A command asked for this way waits for the person in the
inbox. Every one of them does, although a command of a run inside sshs3 is
never asked about, because nobody here is watching whoever asked
(`AgentTask.fromOutside`). It runs in the terminal that is
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
  keyword because no model answered). The terminal says which. The model is
  given 15 seconds and, where it reasons, is asked for low effort.
- Requests in `READ_ONLY_ACTIONS` (searching and reading the knowledge base,
  reading a server's facts, an inline suggestion) do not rewrite the store and
  do not tell the other windows to refetch.
- Work that goes on after its request has returned is visible in the
  snapshot: `kbWork` (pages being rewritten from their sources, a comparison
  of pages under way, how the last one ended), `evalRunning`,
  `serverFacts.collecting`.
- Every action in `HubRequest` is answered by exactly one part of the hub.
  `areas/routes.ts` is the table: an action that is typed but missing from it
  does not compile, and each part's own switch assigns what it does not
  handle to `never`, so a part that is given an action and has no case for it
  does not compile either. `HubService.request` only finds the part, hands
  the request over, and then saves and tells the windows.
- A schedule runs on the endpoint that is configured now. It keeps a model of
  its own only while it was saved for that same provider and address.
- `task.contextTokens` is what the model was sent at its last call in a
  conversation. The meter in the composer shows that against the window, and
  only the window before the first run. (It used to show an estimate built
  from the newest task in the store, whichever that was.)
- The self-learning status is counts of what is in the team memory. It names
  no engines and has no default percentages.
- `reply` with `retry: true` asks the last question again. Nothing is added
  to the conversation: the answer that followed the question is replaced by
  the new one, and the question is stamped as asked now, so what the earlier
  try ran (still in the tool log) is given to the model before the question.
  It is refused while the conversation is still running.
- `self-learn-reflect` (Tidy up) answers `reply.notes` with what it did: what
  it wrote or changed straight away, by title, how many links between servers
  it added, and how many suggestions wait for a person. The Memory view shows
  those lines as they are.
- `runner-test` answers `reply.runnerProbe` (see External agents) and changes
  nothing.
- `peer-approve` is one member's answer to what another member's run asks a
  second person. It is carried out in that other member's hub by the server
  (`host.peerDecide`), which checks first that this member may answer it; the
  asking member's own store is not rewritten by it.
- A test case's result and `evalRunning` change in one step: no snapshot
  shows a case that has its result and is still said to be running.

**What a snapshot costs, and what is kept out of it.** Every change anywhere
sends every window a new snapshot, and a snapshot carries every conversation.
Measured on a workspace of 300 long conversations, 2 000 memories, 500
documents and 200 tickets, a snapshot was 21.7 MB and, while a model streamed
an answer, every window was told to fetch it again for every piece of text:
several hundred times a second. Three things keep that down
(`tests/main/hubSnapshotSize.test.ts` holds them to a budget):

- **Streamed pieces are sent as pieces.** A piece of text, a usage count, a
  tool's answer and a retry notice go to the windows as they happen
  (`host.delta`, `HUB_DELTA_CHANNEL`), and the windows put them into the
  conversation themselves. For those events the hub does not say "fetch
  everything": it says so at most once a second while a run streams, so a
  window that missed a piece catches up. A piece of text says how long the
  message is once it is added (`length`), so a window adds it only where its
  copy ends exactly before it: a piece it already has is not added twice, and
  a gap makes it fetch (`applyDeltaToMessages`, `lib/aiHubDelta.ts`).
- **A long conversation travels by its tail** (`taskForSnapshot`). While it
  is small (six messages, 2 000 characters, no pictures) it is sent whole.
  Past that, the snapshot carries its last two messages, each cut to its last
  800 characters, and `messagesTail` says what the whole of it is (how many
  messages, how many a person wrote, the last one's id and length). Pictures
  are never in a snapshot.
- **A finished change travels without its long parts** (`changeForSnapshot`).
  What it ran, where, how it ended and who answered are always there. Its
  output beyond the first 120 characters, a file's contents and diff, a dry
  run's output and the snapshot taken before it are left out once together
  they pass 600 characters, and the change says so (`partial`). A change that
  waits for an answer is never cut: the person deciding sees all of it.

The view that shows one conversation gets it whole with `task-read` (it
answers `reply.task`: every message and every change, and it changes
nothing). `useFullTask` (`lib/aiHubTasks.ts`) asks once, keeps the text
current from the stream, and asks again only when the snapshot says the
conversation holds something its copy does not: another message, a longer
last message, a change that has moved on. The chat panel and the run
inspector show a conversation that way; the Changes view fetches a change's
long parts when its row is opened, not for every row of the list. On that
workspace a snapshot is now 3.6 MB, and a streamed answer asks the windows to
fetch it about once a second.

**What a run sends the model.** Each call carries the tool list, the
instructions and a snapshot of the workspace. The team's memories are given in
that snapshot as lines of text; the context also held them by tier, and once
more as one formatted string, so they went out three times. The same went for
the documents and pages bound to the agent, given as text after the snapshot
and again inside it. Each is now sent once (`snapshotText`,
`withoutBoundCopies`): where the JSON had the copy it says where the text is.
On a ticket run in the demo lab that took a call from about 80 000 characters
to 67 000.

## Server facts, and what changed (`ServerFacts`, `FactsStore`)

Most faults follow a change, so the hub reads the servers on a schedule and
keeps what is different. No model is involved.

- **What is read** (`FACT_COMMANDS`, `buildScript`): system and kernel, boot
  time, packages (dpkg, rpm or apk), failed and running services, listening
  ports with their process, connections the server opened itself, disks,
  certificates in the usual places with their end date, and SHA-256 of a list
  of configuration files (`DEFAULT_WATCH` plus the user's own paths). One
  script for `sh -s`, a marker line before each section, nothing written.
  Each command is written to only look. Nothing in the app checks that:
  whoever adds a command keeps it so.
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
  claim covers the minute a reading takes. Readings are taken over with the
  board's sync (every ten seconds; a head whose mark in the listing has not
  changed is not downloaded again), also by an installation that has not
  switched scheduled readings on: what a teammate read is the team's.
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
  is never a destination. Nor are the other addresses a cloud keeps a
  machine's own credentials at: `fd00:ec2::/32` (Amazon on IPv6),
  `100.100.100.200` (Alibaba), `168.63.129.16` (Azure) and `192.0.0.192`
  (Oracle), and NAT64 for local use (`64:ff9b:1::/48`), which cannot be read
  for the IPv4 address it leads to. An IPv6 address that carries an IPv4
  address (mapped, translated, NAT64, compatible, 6to4) is judged as that
  IPv4 address, however it is written (`addressClass`,
  `tests/main/addressGuard.test.ts`). On a shared server neither is loopback, and the
  private network only with `SSHS3_ALLOW_PRIVATE_ADDRESSES=1`.
- **Quiet hours and the hourly limit hold, they do not drop.** During quiet
  hours, or when the hour's limit is used up, what would go to the channels
  is kept instead (`NotifyStore.hold`, in `notify.json`: a line per item, at
  most 50, the oldest let go and counted past that). A critical alert still
  goes. When the quiet hours are over, or an hour after the limit was
  reached, one message tells it all: "3 things happened while notifications
  were quiet", a line each, with "(no longer waiting)" on what was dealt with
  meanwhile and "Still waiting" on a held reminder. That message counts as one
  against the hour. What it tells is not also sent as a reminder in the same
  moment. Each channel gets only the kinds it asked for. The held items stay
  in the inbox all along. The escalation tiers and the "auto-pause" cushion
  that were written and never called are removed, with their state in
  `notify.json`. Tests: `tests/main/heldNotifications.test.ts`.
- **Storage:** `<hub dir>/notify.json`, mode 0600, addresses and secrets
  through `encryptSecretValue`. Not in `hub.json`, whose save masks anything
  that looks like a secret, and never in the bucket. The snapshot carries
  `NotifyChannelView`: the host, not the address.
- **A start without the keyring.** A secret that is stored encrypted and
  cannot be decrypted on a start (the keyring is locked or missing, or a
  server's key file could not be read) is empty in memory, and used to be
  written back empty at the next save: one such start lost it for good. Now
  the store keeps the ciphertext and writes it back unchanged
  (`openSecretValue`, `sealSecretValue` in `SecretFieldCrypto.ts`), and the
  status says the secret could not be read on this start. Nothing is sent to
  a channel whose address is unread. A value a person enters meanwhile
  replaces the old one. The same holds for the Jira and Confluence tokens
  (`AtlassianStore`), the context bot's token (`ChatBridge`) and the team
  bucket's secret key (`S3WorkspaceSyncService`). Tests:
  `tests/main/keyringLostStart.test.ts`.
- **Links:** `SSHS3_PUBLIC_URL` or the address saved in Settings, never the
  request's Host header. `?view=Inbox&item=<id>` is read once by
  `AiHubPanel` and removed from the address; `InboxView` marks the item or
  says that it no longer waits.
- **The wait for a person** has no limit unless `preferences.approvalWaitMinutes`
  is set above 0. An unattended run that asks then waits until somebody answers
  or stops it.
- A desktop notification is now also shown when an approval, a plan or a
  question starts to wait, which nothing did before.
- **A notification only tells.** It cannot be answered. The notifications
  card used to have a switch, "Let Approve and Deny be answered from chat".
  It was never saved on the server, no button was ever sent, and nothing
  took an answer: the page promised something that did not exist. The
  switch is gone, and so are the unused action tokens in `Notifier.ts`
  (`signChatOpsActionToken`, `chatOpsActions`). A policy kept in the browser
  that still holds the old `chatOps` part loads and is ignored. To approve
  from Slack or Mattermost, use the agent bot: see
  [Agent in chat](#agent-in-chat-the-agent-bot-chatagentservice).
- A change or a plan of a conversation asked for from chat is not sent to
  the notification channels (`flushInbox`): its card is in the chat thread,
  where the people who may answer it are. What waits for a second person
  still goes.

- In the demo lab nothing is sent to a channel. `flushInbox` returns before
  a channel is told, and Send a test answers "Demo: nothing is sent from the
  demo lab." and records no delivery on the channel.

Not done: delivery through an HTTP proxy, a persistent retry queue (three
tries in memory, then the failure is shown on the channel), approving from
inside Microsoft Teams.

## Alerts in, and the inbox (`AlertIntake`, `InboxView`)

- **Alerts in.** On the web server, `POST /api/hooks/<user id>.<secret>` takes
  an alert: Alertmanager and Grafana (a list under `alerts`), PagerDuty
  (`event` with incident data), or any JSON with a title or message
  (`parseAlerts`). There is no session; the secret in the address is the key,
  only its hash is stored, a wrong address is answered like a missing one, and
  an address takes at most 60 posts a minute of 256 kB each. The UI shows the
  one-time address with a `Copy address` button, `Revoke and turn off`, the
  count of parsed webhook alerts with the time of the last one, and keeps
  unsaved routing rule drafts intact if validation rejects a save. The desktop
  app has no address; an alert can be pasted there.
- **Alert → ticket.** The alert is matched to a server or cluster of the
  workspace (`alertTarget`) and given to an agent: the first matching rule,
  else the agent bound to that cluster, else a team's lead, else nobody
  (`routeAlert`). The same alert firing again is counted on its open ticket; a
  resolve is noted, and a ticket still in To do when its alert resolves goes
  to Backlog (and back to To do if it fires again), so the heartbeat does not
  start on an alert that is over. The alert's own words are quoted in the ticket as data
  from the monitoring system. Every field of an alert is made one line first
  (`cleanAlert`: line breaks of every kind and control characters become a
  space, the source is cut to a short plain name), and every line of its text
  is quoted, so a label with a line break cannot end the quoted block. The
  ticket's prompt keeps a title on its line and quotes a note of several lines
  line by line (`ticketPrompt`). This keeps the alert's words where they are
  marked as data. It does not check what they say
  (`tests/main/alertQuoting.test.ts`). The heartbeat takes firing alerts before other
  work, critical ones first.
- **Inbox.** One list of everything that waits for a person, built from the
  snapshot (`inboxItems`): commands waiting for approval, plans, questions,
  tickets in review, runs that stopped, alerts nobody has, knowledge base gaps
  and contradictions, the nightly report. Each can be dealt with in place.
  A plan is listed once its agent has stopped, which is when it can be
  answered, and for a week after it was proposed (`PLAN_WAITS_MS`). It used to
  be listed only while the agent was still working, so a plan that waited for
  its answer was never there. On a shared server the list also has what a
  colleague's run asks a second person (`peerApprovals`, kind `peer`): see
  "Two people". What the chat agent asks is not in the Inbox; it is answered
  in the chat thread or under Agent in chat in the settings.

Checked with real HTTP posts against the web server in tests and in a browser
with a stand-in model. Not checked: a real Alertmanager or PagerDuty sending.

## Jira on the board, Confluence in the knowledge base (`Atlassian`, `AtlassianBridge`)

Teams already have their issues in Jira and their documentation in Confluence.
The board mirrors the one and the knowledge base reads the other, so sshS3
works beside them instead of asking a team to move.

**The connection is personal.** One for Jira and one for Confluence, each for
Atlassian Cloud (the account's e-mail and an API token) or Data Center/Server
(a personal access token). An e-mail and a token act as one person, so they
are kept with that person: encrypted in a file of its own (`atlassian.json`
beside that person's hub store; on a shared server each account has its own),
never in the team's workspace or bucket, and never sent to the interface,
which is told only that a token is set. Teammates get the tickets and the
knowledge base documents through the bucket, not anybody's sign-in, and what
is written to Jira or Confluence is written as the person whose connection
did it. A token is for one site: when the address changes it has to be typed
again. Every call goes through `guardUrl` to the address that was checked,
and no redirect is followed. Agents have no tool for any of this.

**Jira to the board.** Every open issue of the chosen projects is a ticket:
its key and Jira status are on the card, and title, text, status and new
comments follow the issue (read every two minutes, and with "Sync now"). A
ticket's id is made from the site and the issue, so two installations that
read the same Jira make one ticket.

- What is written in an issue is text from outside the team. Its ticket is
  marked so (`outside`), lands in **Backlog**, and never starts an agent by
  itself: a person reads it and moves it to To do.
- Text written in Jira after that reading is not handed to an agent unread.
  When the issue's summary or description changes (`external.textHash`), or
  somebody writes a comment there, a ticket in To do goes back to Backlog
  with a note that says what is new. A ticket an agent is running stays with
  its run, with a note for whoever reviews the result. Review and Blocked
  wait for a person already. A person's own edit of the ticket on the board
  is not a change in Jira.
- The issue's text is masked and cut like other outside text
  (`ticketTextFor`: at most 5,500 characters of the description, the title
  and the names one line each). Tests: `tests/main/jiraReview.test.ts`.
- The board's columns are the board's own. Jira decides only the two ends: an
  issue closed there is done here (unless a run is working it), and one opened
  again there goes back to Backlog.
- A ticket a person removed from the board stays removed.

**The board to Jira, and only this.**

- An agent's result, as one comment, when its run ends in Review or Blocked.
- A person's decision ("Approve: done", or sent back with a note), as a
  comment that names the person.
- The issue closed, when its ticket is done here. A workflow can have several
  ways to close (Done, Won't do, Duplicate): the transition named in the
  settings is taken, else the one called Done, Resolved or Closed. With
  several and none of those, the issue is left open and the ticket says why.

What is owed is read off the ticket on each pass, not kept in a queue. With a
team bucket one installation does each write (`WorkSync.markOnce`) and tries
again while it fails; the others see it done when the ticket syncs. A failure
is kept on the ticket or the connection and shown; it never stops the board.
Each write is in the audit log (kind `integration`).

**Confluence to the knowledge base.** Under Sources, a space key adds the
pages of a space and a page id adds that page with everything under it, up to
500 pages at a time. Each page becomes a source like any other, with code
blocks kept and what looks like a secret masked. What was added is followed:
once a day it is read again, a page whose version changed revises its
document (and so the pages written from it), and a page that is gone is said
so on its document, which keeps its text. A document a person removes is not
read in again.

**The knowledge base to Confluence.** "Publish to Confluence" on a page: a
person, with a confirmation, never an agent. The first time it asks for a
space (and optionally a parent page); after that it updates the same page.
When somebody changed the page in Confluence since it was published, nothing
is written and that is said. The page is written in Confluence's storage
format from the page's own Markdown; everything the converter does not know
is escaped, so a page carries no markup of its own into Confluence.

**Not tried against a real Jira or Confluence.** The calls follow Atlassian's
documentation (Cloud: `/rest/api/3` with `POST /search/jql`, `/wiki/api/v2`;
Data Center: `/rest/api/2`, `/rest/api/content`) and are tested against a
stand-in. Connect a test instance first.

## The context bot: what the team says in chat (`ChatSources`, `ChatIndex`, `ChatBridge`)

What matters at an alert is often written only in chat: "restarted it last
night", "that one is known, wait it out". A bot the team invites to chosen
Slack or Mattermost channels lets agents look that up, and puts what was said
about a server on its alert's ticket. This is the **context bot**. The
settings show it under "Slack and Mattermost", titled "Context bot".

It is one of two bots. People who want to talk to the agent in chat talk to
the other one, the agent bot, which is a separate Slack app or Mattermost bot
account: see [Agent in chat](#agent-in-chat-the-agent-bot-chatagentservice).
Nothing about the agent bot gives the context bot a way to post.

**The bot is the team's.** A Slack app's bot token (`xoxb-…`; a person's own
token is refused), or a Mattermost bot account's access token and the
server's address. It is set up once where it should run and kept encrypted in
a file of its own (`chat/connections.json` beside the hub's store), never in
the team bucket and never sent to the interface. On a shared server there is
one bot for the whole server (kept in `team-chat/`, given to every account's
hub, so there is one reader and one index), and only an administrator sets it
up, chooses channels or removes what was read. The Slack app needs the bot
scopes `channels:history`, `groups:history`, `channels:read`, `groups:read`
and `users:read`.

**What it may read.** Only channels the bot is a member of are listed, and
only those a person ticks are read. Direct messages and group chats are never
asked for. The list of the bot's channels is asked for again every half hour.
While that fails it is not asked at every tick: the wait is two minutes, then
doubles up to an hour, or is what the service says; a test of the connection
asks at once (`tests/main/chatBridgeUpkeep.test.ts`). The context bot posts nothing and takes no commands. Its client
has no call that writes. Tests check both that its code has none and that
it makes none while the agent bot posts in the same channels
(`chatBridgeReadThread.test.ts`, and "keeps the two bots apart" in
`chatAgentOnServer.test.ts`).

**One thread now, for the agent bot.** When somebody names the agent bot in a
thread, the agent bot can ask the context bot to read that one thread at once
(`ChatBridge.readThreadNow`), so the agent sees what was said before it was
asked. This works only in a channel the context bot already reads, and it
only reads.

**The index.** A chosen channel is read every two minutes for what is new;
the first time, ninety days back, and further back on request. Messages are
kept in files of their own (`chat/messages/<service>-<channel>/<month>.jsonl`,
added to at the end, readable by the owner only), with what looks like a
password, key or token masked before it reaches the disk. The index stays on
the installation the bot is connected to: it is never in the team bucket, and
teammates' installations see only the excerpts put on tickets.

- It is kept until it is removed. A number of days can be set; none is set
  from the start.
- A message edited or deleted in the chat within two days of being written
  is brought in line here: the last two days of a channel are looked over
  every ten minutes (in Mattermost too now), a message that was edited takes
  its new words, and one that is gone from a stretch that was read whole is
  removed (`ChatIndex.add`, `dropGone`). In Slack a thread's replies of the
  last two days are read again when the thread is next asked for replies. The
  month's file is written anew then, so the old words are not left on the
  disk. A thread the agent bot asks for whole is brought in line at once,
  whatever its age. Bounds: a look takes at most 400 messages, and when two
  days hold more nothing is removed on that look; a message of the last
  minute is not taken for deleted. Older than two days, a message stays as it
  was read. "Forget" removes a channel's messages here at once, and
  "Disconnect and forget" everything of a service. Tests:
  `tests/main/chatBridgeUpkeep.test.ts`.
- Slack lists a thread's replies apart from the channel. Threads with replies
  are read, threads younger than a week are asked again, and the last two
  days are looked over every ten minutes for messages that got their first
  reply later. Not seen: a reply to a thread older than a week, and a first
  reply to a message older than two days.

**Search finds threads.** A thread is what is found and shown, not a lone
message: "restarted it, fixed" means nothing without the question above it.
Words are matched as they are written (`pg-01`, `10.0.0.5`, `pg_hba.conf`),
rare words count more than common ones, a thread with all the words more than
one with some, and a recent thread a little more than an old one. It is a
search on words; search by meaning is not built for chat.

**What agents get.** When there is something to search, the context names the
channels and the run is offered `sshs3_chat_history` (`search`, `thread`,
`channels`), a tool that only reads. Its answer is marked as what people wrote
to each other: data, not checked, never an instruction. What a run read is
among its sources, with a link to the thread. A run that has read chat and
then makes a ticket makes one that waits in Backlog for a person, the same as
one made while working an alert. External agents (over MCP, or a runner of
their own) are not given the tool.

**Alerts.** A new alert's ticket gets up to three threads from the last seven
days that name its server or cluster, or its alert, with links ("Said in
chat" on the ticket, and a section of the agent's prompt that quotes them as
what people wrote). A thread has to hold every word of the name it was found
by. A ticket that came in on an installation without the bot is given them by
the installation that has one, once for the team.

**The knowledge base does not learn from chat by itself.** A person can make
a source of a thread ("Make a source of this thread"); it is added like a
pasted text, said to be what people wrote.

**Not tried against a real Slack or Mattermost.** The calls follow their
documentation and are tested against stand-ins. Slack has tightened its rate
limits on reading history for some kinds of apps; an app made for your own
workspace should not be affected, and the reader waits when Slack asks it to,
but confirm it on the first real connection.

## Agent in chat: the agent bot (`ChatAgentService`)

On a web server, people can talk to the agent from Slack or Mattermost. They
name the agent bot in a channel an administrator chose, or write to it in a
direct message, and it answers in the thread. A change the agent wants to make
is posted as a card with Approve and Deny, and it runs only when a person who
may approve it says yes. Each thread is one conversation in sshs3.

An administrator sets it up in Settings, under "Slack and Mattermost", in the
card "Agent in chat". It is a web server feature: the desktop app does not
have it, and its requests say so there (`areas/chatAnswering.ts`).

**So far it is tested only against stand-ins for Slack and Mattermost**, not
against a real workspace. See "What is tested and what is not" at the end of
this section.

### Two bots, and why

| | Context bot | Agent bot |
| --- | --- | --- |
| What it does | Reads the channels an administrator ticks, so agents can search what the team wrote, and alert tickets get "Said in chat" | Takes questions, answers in the thread, posts changes and plans as cards |
| What it posts | Nothing. It takes no commands | Answers, a status line, cards and short replies |
| Slack | An app of its own, with scopes that read channel history | An app of its own: `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `channels:read`, `groups:read`, `users:read`, and Socket Mode with an app-level token. No scope that reads a channel's history |
| Mattermost | A bot account of its own | A bot account of its own |
| Tokens | `team-chat/connections.json` | `chat-agent/connections.json` |
| Set up in | The card "Context bot" | The card "Agent in chat" |

Why two: a bot that reads whole channels should not also post and take
commands, and the bot people talk to should not read whole channels. Kept
apart, each token does one job, and a token that leaks gives only that job.
So the agent bot's form refuses the context bot's token (`ChatBridge.usesToken`
compares hashes), and the context bot's client has no call that writes.

### How the two work together

- The agent bot sees only what is written to it: a message that names it in
  a channel, and direct messages. In Mattermost a bot account is sent every
  post of the channels it is in. The agent bot looks in those only for a link
  code to turn off, answers only when it is named, and keeps none of them.
- When it is named in a thread of a channel the context bot reads, it asks the
  context bot to read that thread now. The earlier messages (at most 50, and
  at most 8,000 characters) are given to the agent as what the team wrote,
  marked as data from the chat and not instructions. Named again later in the
  same thread, the agent gets only what was written since it last answered.
- When the context bot does not read the channel, the agent sees only what
  was written to the agent bot.
- The agent can search the context bot's index with `sshs3_chat_history`, but
  only in the channels the channel's row allows. By default that is only the
  channel it was asked in. A direct message searches no team chat.

### The chat agent's account

A conversation asked for in a channel runs in the chat agent's own account
(`svc_chat-agent`, shown as "Chat agent"), never in the account of whoever
asked. The server makes it itself, in `service/chat-agent/` of its data
folder.

- Nobody can sign in as it, invite it or remove it. It is not counted as a
  person anywhere: not for the two person rule, not among who is signed in,
  not in the administrator's list.
- It is a member, so the rules for members hold for it, and so do the rules
  an administrator set for everyone. It proposes no memories and does no
  learning for the team.
- The servers it knows are the ones shared with everyone on the server. It
  signs in to them with an SSH key of its own. The administrator copies the
  public key from the card and adds it only on the servers the bot may reach.
  That is the outer fence: where the key is not, the bot cannot sign in.
  Nobody can answer a question to trust a server's host key for the chat
  agent. Connect to each such server once from sshs3 and trust its key there
  first. This was not tried with real servers. The key is made when the bot
  is first connected. "Make a new key" is used for
  new terminals from then on; the old key keeps working on a server until it
  is removed there (its line ends in `svc:chat-agent@sshs3-web`).
- What an administrator changes about the agent bot, and who links or
  unlinks, goes into the server's audit log.

### Setting up Slack

1. In the card, open "The agent bot", then Slack, and copy the manifest.
2. In Slack, make a new app from that manifest and install it to the
   workspace. Copy its bot token (`xoxb-`).
3. Under Basic Information, make an app-level token with the scope
   `connections:write` (`xapp-`).
4. Paste both tokens and press Connect. sshs3 tries both before it saves them:
   the bot token with `auth.test`, the app-level token by asking Slack for a
   Socket Mode address (`apps.connections.open`). The socket itself is opened
   after saving, and the card shows whether it connected. The context bot's
   token is refused.
5. Invite the bot to each channel it should answer in, and add a row for the
   channel (below).

The manifest turns on Socket Mode, subscribes to the bot events
`app_mention` and `message.im`, turns on interactivity (for the buttons) and
the messages tab (so people can write to the bot), and asks for the scopes in
the table above and no others.

**No public address is needed for Slack.** Socket Mode is a connection the
server opens outward to Slack, and button presses come back over it. The
socket's address must be a `wss` address under `.slack.com`.

### Setting up Mattermost

1. In Mattermost, make a bot account (System Console, Integrations, Bot
   Accounts), give it an access token, and add it to the team and to the
   channels it should answer in.
2. In the card, open "The agent bot", then Mattermost. Give the Mattermost
   server's address and the token, and press Connect. sshs3 checks the token
   (`/api/v4/users/me`) before it saves it. The context bot's token is
   refused.
3. The agent bot opens a websocket to the Mattermost server
   (`/api/v4/websocket`) with the token in the `Authorization` header. When
   the header is not taken, it sends the token once more as an
   authentication challenge, the way Mattermost's own apps do.

On a server with more than one account, a Mattermost server on the private
network is reached only with `SSHS3_ALLOW_PRIVATE_ADDRESSES=1`, the same rule
as for the context bot.

**Reactions, or buttons.** By default people answer a card with a reaction:
✅ approves, ❌ denies. The bot puts both on the card, so they are one click
away. Cards get Approve and Deny buttons only when both of these are set on
the server:

- `SSHS3_PUBLIC_URL`: Mattermost's server posts each press to
  `<SSHS3_PUBLIC_URL>/api/chat/mattermost/action`, so it must reach that
  address.
- `SSHS3_MATTERMOST_ACTION_FROM`: the IP addresses Mattermost's server posts
  from, exactly as this server sees them, separated by commas. Host names and
  ranges are not matched.

The press route needs no session. Mattermost says who pressed, and only the
address the press comes from shows that it was Mattermost that said so. So the
route takes a press only from the listed addresses, at most 60 a minute from
each and at most 32 kB each, and then checks the signed token in the button
against the card, the channel and the person's link. Without the list it
answers 403, and cards are answered with reactions, which reach the bot over
its own socket.

**Behind a reverse proxy** the server sees the proxy's address, not
Mattermost's, so that is the address the list must hold. Then anything that
can reach the proxy passes that check. Let the proxy pass
`/api/chat/mattermost/action` only from the Mattermost server, or keep
reactions.

When sshs3 is on a private network, Mattermost may also refuse to post to it
until its setting for untrusted internal connections names sshs3's host. This
was not tried.

### Channels, and how far the agent may go

Each channel the agent bot answers in is a row in the card. The rows of both
services are saved together.

| Field | What it holds |
| --- | --- |
| Channel | Its id (in Slack like `C0123ABCD`) and a name to show. The bot answers in no channel without a row |
| Servers | Names, ids or hosts, or all of the chat agent's servers |
| Clusters | Every server in them |
| What it may do | Commands only; Commands, and change cards approved in the thread; or Plan first |
| Agent | The chat agent's default agent, or another of the chat agent's own agents. Its hub runs the conversation, so an agent of the administrator's own is not offered, and saving one is refused. External runners are not offered: a conversation from chat runs on the chat agent's model |
| Who may approve | Anyone who may approve it, or administrators only. In chat only people who linked their chat account can answer |
| What it may search | Which of the context bot's channels `sshs3_chat_history` may search. None chosen: only this channel |

- **Servers are matched exactly**, by id, name or host, or by cluster.
  `web-1` never lets in `web-10`. A row with no servers and no clusters
  reaches nothing.
- **Commands only** (`read`): the agent runs commands on these servers and
  proposes no change. Nothing checks what a command does. It is told "You
  only look. Change nothing.", and it is given no change card and no file
  write, so no card is posted. **Commands, and change cards approved in the
  thread** (`ask`): commands run without asking, and each change card waits
  until a person who may approve it says yes. **Plan first** (`plan`): the
  agent runs commands to look around and proposes a plan. Change cards and
  file writes wait until it is approved. A conversation from chat never runs
  in Auto.
- **Anyone in a channel can have the agent run commands on its servers.**
  Give the bot an SSH user that can only do what you accept. What the agent
  can do on a server is decided by that account, not by sshs3.
- **In a channel the bot answers only when it is named**, in its own thread
  too. A later message in the thread that names it goes on with the same
  conversation, given to the agent as `Omar Lind wrote: …`. One answer at a
  time per thread.
- **A conversation keeps the rule it started with.** When an administrator
  changes a channel's row, the next message there starts a new conversation,
  and the bot says so. A card in a channel that was turned off, removed or
  set to "Commands only" can no longer be answered in chat, only in sshs3.
- **Conversations do not see each other.** The chat agent's account holds
  every channel's conversations. A run asked for in one channel searches only
  that channel's earlier conversations (in a direct message, only that
  person's), uses only its own terminals, sees only the servers inside its
  fence in its inventory, its map of servers and its memories, and keeps no
  notes. The fence is `chatFence.ts`; the hub holds a run to it
  (`areas/chatRuns.ts`, `ToolBroker`, `AppActions`, `ContextService`).
- **What is posted.** A status post, edited at most every 15 seconds. Then
  the answer: the conversation's stored and masked text, never pieces of the
  model's stream. It is split at paragraphs without breaking a code block,
  and after about 12,000 characters the rest is left in sshs3. `@channel`,
  `@here` and the like are made harmless. Attachments are not read, and the
  bot says so. With `SSHS3_PUBLIC_URL` set, a link to sshs3 is added where
  the chat sends people there: an answer cut short, a card that is answered
  only in sshs3 or has ended, and a card that could not be posted. The link
  opens sshs3, not the conversation itself.
- **A card** shows what the change does, where, what it can affect when the
  agent said so, the whole command, the check, how it is taken back, the
  approvals so far and who may approve. Nothing rates the command. On
  production the button asks once more before it counts. A card that does not fit whole gets no buttons and says to answer
  in sshs3: nothing is approved from a part of it.

### Who may approve

- **In chat, only people who linked their chat account** (below). In the
  app, under "Waiting for your answer", no link is needed. Somebody who did not
  link and presses a button is told how to link: in Slack in a message only
  they see, in Mattermost in the answer to the press, and for a reaction by
  name in the thread.
- **Only what their sshs3 account may approve in the app.** An answer from
  chat is checked as a second person's answer is in the app
  (`answerForChatAgent`, `authorizePeerApproval`): never a turned off account,
  one answer per person, and on production only an administrator of the
  server or a member of one of its approver groups. With "Administrators
  only" on the channel, only administrators. The stricter of the rule the
  conversation started with and the channel's rule now holds.
- **Production, two people and change freezes hold.** A change that needs two
  people takes two different people, in the thread or in the app (see
  [Two people](#two-people-peer-approve-approveaspeer-approveplanaspeer)). A
  change freeze stops a change before any card is posted, the thread is told,
  and the freeze is checked again just before a change runs.
- **sshs3's own rules only in the app.** A change to sshs3's own settings or
  rules is never answered from chat.
- **A button is signed.** It carries a token bound to the channel, the
  thread, the card, the conversation, the change or plan, and the answer. It
  is good for a day (`chatActionToken.ts`). A person answers a card once; a
  press that was refused does not use that up. In Slack, Approve asks to
  confirm on production and for a command that can remove data.
- **In the app.** Under Agent in chat, and at the top of the Inbox, "Waiting
  for your answer" lists the chat agent's changes and plans this person may
  answer, with the target, the risk, Approve and Deny
  (`chat-answering-answer`). The Inbox count includes them. An answer in the
  app needs no linked chat account: the same rules hold as for one given in
  chat. It is needed: the chat agent has no owner, so its changes are in
  nobody's own Inbox items. An administrator also has "Conversations from
  chat", which reads each conversation, a whole plan too, and answers what
  waits in it (`chat-answering-runs`, `chat-answering-task`).
- **A direct message from a linked person** is the exception: its cards are
  answered only by that person, by their own account's rules, as in the app.

### Linking a chat account

- Under Settings, Agent in chat, "Your chat account", a person gets a link
  code for Slack or for Mattermost. The section is there once the agent bot
  is connected and answering is on, and for anybody who already linked. A
  code is offered only for a service the agent bot is connected to. It is 8
  letters and digits, works once, and works for 10 minutes. There is one at a time per account and service,
  and only its hash is kept.
- They send `link <code>` to the agent bot **in a direct message**. `unlink`
  ends the link, and `help` says what the bot does.
- A code the bot sees in a channel is turned off at once, and the bot says
  so. In Slack the bot sees a channel message only when it is named, so a
  code pasted in a Slack channel without naming the bot stays good until it
  runs out. That is why the card says to send it only in a direct message.
  In Mattermost a code in a channel the bot is in is turned off, named or
  not.
- After five wrong codes in 10 minutes from one chat account, its codes are
  not looked at until those 10 minutes have passed.
- One chat account per sshs3 account and service. A turned off or removed
  account counts as not linked, everywhere, and removing an account removes
  its links. An administrator sees everybody who linked under "Linked
  people", and can unlink anybody.

### Direct messages

- Off until an administrator turns them on.
- **From a linked person**, a direct message runs in that person's own sshs3
  account: on their own servers, under their own safety rules, model and data
  policy, and it may ask for changes. It is in their conversation list in the
  app, marked "from Slack" or "from Mattermost" (`ChatOriginBadge`). Only that
  person answers its cards. Where a second person is needed, that person
  answers in their Inbox as usual.
- **From somebody who did not link:** commands only, or not answered, as the
  administrator chose. Commands only runs in the chat agent's account, only on
  the servers and clusters set for direct messages, and the bot says that it
  runs commands and proposes no change. Not answered: the bot says how to
  link.
- Each message in a direct message goes on with the same conversation.

### Model, limits and budget

- **The model.** The chat agent has model settings of its own, and none at
  first. "Copy my model" copies the administrator's whole model settings to
  it, with keys still encrypted and the data policy too. Later changes are
  not followed: copy again. The card says which model the chat agent has, or
  that it has none; with none, the bot answers every question with "No model
  is set up". A direct message from a linked person uses that person's own
  model.
- **The model must be reachable as from a shared server.** The chat agent's
  model is held to the rule of a shared server, even when one person uses
  the server. A model on this machine is not called, and a model on the
  private network needs `SSHS3_ALLOW_PRIVATE_ADDRESSES=1`. Copy my model
  copies the address as it is, so check that it can be reached.
- **How long a change waits** for an answer in the chat agent's
  conversations: 60 minutes at first, and from 1 to 1,440 (a button is good
  for a day). After that the change counts as denied, its card says it ran
  out, and the agent goes on without it. A linked person's direct message
  waits as long as that person's own settings say.
- **A monthly budget** in tokens for every answer in chat, direct messages
  too: 2,000,000 at first, and at least 10,000. A month is a calendar month in
  UTC. What a run used is counted when it ends, with the background runs it
  asked for (a plan's reviewer, investigators). When it is spent, the bot says
  so and takes no more questions until the next month; a card that waits can
  still be answered. A run somebody goes on with in the app is not counted.
  The card shows what was used.
- **Limits per hour**, kept in memory, so a restart forgets them:

| Limit | At first | Can be set from 1 to |
| --- | --- | --- |
| New conversations one person starts | 10 | 100 |
| Messages one person sends | 30 | 500 |
| Messages in one channel | 30 | 1,000 |
| Answers worked on at the same time, over the whole server | 4 | 16 |

One answer is worked on at a time per thread. Short replies ("I am still
working in this thread", "I am answering other questions right now", "I do
not answer direct messages") go to one person at most 5 times an hour for
each kind. "You sent me too many" is said once an hour per person or channel,
and "I do not answer in this channel yet" and "the budget is spent" at most
once an hour per channel. So a person who writes again and again cannot fill
a channel's queue ahead of the cards and answers.

Posts keep to each service's pace (`ChatOutbox.ts`): one queue per channel,
in Slack posts at least 1.1 seconds apart and edits 3 seconds apart, in
Mattermost 0.25 and 0.5 seconds. When a service asks the bot to wait, it
waits.

### Data policy

The chat is a place data goes, like a model's provider. The check is
`validateChatEgress` in `src/shared/dataDestination.ts`.

| Where data may go | Slack | Mattermost |
| --- | --- | --- |
| Any service I set up | Allowed | Allowed. Without https, a warning |
| Only services in the EU | Stopped | Only a host on the EU list, the private network or this machine |
| Only this machine and my own network | Stopped | Only the private network or this machine |

- It is checked when answering is switched on: answering stays off while the
  chat agent's policy stops a connected service, and the card says why. It is
  checked when the bot is connected while answering is on.
- It is checked again before every post or edit that carries what a run did,
  with the policy of the account the conversation runs in: the chat agent's
  for channels and for people who did not link, the person's own for their
  direct messages. A run can wait a day, and a policy can change meanwhile.
  When the policy stops a post, the thread is told once an hour and the
  conversation is left to be answered in sshs3.
- The chat agent's policy is part of its model settings, so "Copy my model"
  copies the administrator's. It has no setting of its own: to change it,
  change yours under "What leaves this machine", then press Copy my model.
  The card says so when the policy stops a service, and says whether
  answering cannot be switched on or, when it is on, that answers are not
  posted there.
- Everything posted is masked again before it goes.
- Not done: the settings card "What leaves this machine" does not list the
  chat yet.

### When the server restarts

- The settings, links, threads, cards and the month's budget are on disk. The
  counts per hour are not.
- When the server starts, threads nobody wrote in for 30 days are forgotten.
  Then, in the background, the status posts and cards of runs the restart cut
  off are edited to say "Stopped: the server restarted. Reply to go on." A
  plan card keeps its buttons, since a plan waits without a run. A press on
  an old button of a stopped card is turned away. Writing in the thread goes
  on with the same conversation. What could not be posted because the chat
  was out of reach is tried again at the next start.
- The lines to Slack and Mattermost come back by themselves. The wait grows
  from 1 second to a minute, and a wait the service asks for is kept. The
  card shows each line as connecting, open, waiting (with the error and when
  it tries again) or stopped. A Mattermost line resumes where it was and asks
  for what it missed.

### Try it

"Try it" in the card is a simulated chat inside the server (`simChat.ts`).
Nothing goes to Slack or Mattermost. An administrator writes as themselves,
linked, or as somebody who did not link, in a channel that has a row or in a
direct message, and can go on in the same thread. Only the chat is simulated:
the agent really runs, with the chat agent's model, on the servers the
channel reaches, under the administrator's rules, limits and budget. A
direct message as yourself runs in your own account. A change it asks for is
real too, and waits for an approval in the app. The tried chat keeps links
and threads of its own (`chat-agent-try/` in the data folder), never a real
chat's. It is offered in the demo, and before the agent bot is connected;
once the bot is connected, the card says to ask it in the chat. It needs a
model: press Copy my model first, in the demo too. The demo's scripted
answers do not reach the chat agent. A card is shown as Slack shows it, with
its command, check, how it is taken back and who may approve. A channel can
be gone on with only in a thread of that same channel. It waits up to
20 seconds for the answer, then shows what was posted so far.

### Requests and where the code is

The requests go through the hub (`areas/chatAnswering.ts`) to the web server
(`ChatAnswering.ts`), which checks who asks.

- An administrator: `chat-answering-save` (the switch, channel rows, direct
  messages, limits, budget, wait), `chat-answering-connect`,
  `chat-answering-disconnect`, `chat-answering-rotate-key`,
  `chat-answering-copy-model`, `chat-answering-runs`, `chat-answering-task`
  and `chat-answering-try`.
- Anybody: `chat-link-code`, `chat-unlink` (their own; an administrator
  anybody's) and `chat-answering-answer` (checked as above).
- The snapshot's `chatAnswering` carries, for everybody, whether answering
  is on, their own links and what waits for their answer; for an
  administrator also the settings, the bot's connection and status, the
  linked people, the public key, the data policy check, whether Mattermost
  cards have buttons, the chat agent's own agents, and whether it has a model
  (its name only). It never carries a token or a key.

| File | What is in it |
| --- | --- |
| `src/main/web/chatAgent/ChatAgentService.ts` | Hears mentions, direct messages, presses and reactions; starts or goes on with a conversation; follows the run; posts the status, cards and answer |
| `ChatAnswering.ts` | The agent bot as the web server keeps it: the requests from the app, connecting, the read view, "Try it" |
| `ChatAnsweringStore.ts` | Channel rows, direct messages, limits and budget (`answering.json`) |
| `ChatAgentStore.ts` | Links, link codes, threads and cards (`links.json`, `threads.json`) |
| `AgentBotStore.ts`, `AgentBotApi.ts` | The agent bot's tokens, encrypted (`connections.json`), and its calls to Slack and Mattermost |
| `SlackSocket.ts`, `MattermostSocket.ts`, `agentSocket.ts` | The lines to Slack's Socket Mode and Mattermost's websocket: answer each event, drop repeats, come back after a drop |
| `ChatOutbox.ts`, `chatFormat.ts` | One queue per channel at the service's pace; cards, answers and short replies in each service's format |
| `chatActionToken.ts` | The signed buttons and their key (`action-secret.json`) |
| `simChat.ts` | The simulated chat for "Try it" and for tests |
| `src/main/net/wsClient.ts` | A small websocket client over the connection the address guard checked (there is no `ws` package) |
| `src/main/ai/hub/chatFence.ts`, `areas/chatRuns.ts` | The fence a chat conversation runs in, and how the hub starts it, goes on with it and follows it without a browser |
| `src/main/web/WebTenantManager.ts` | The chat agent's account (`CHAT_AGENT_ID`), `answerForChatAgent`, `chatAgentWaitingFor` |
| `src/main/web/WebServer.ts` | The press route `/api/chat/mattermost/action` |
| `src/renderer/src/components/AiHub/AgentInChatCard.tsx`, `ChatOriginBadge.tsx` | The card in Settings, and the "from Slack" badge |

Tests in `tests/main/`: `chatAgentService`, `chatAgentOnServer`,
`chatAnsweringRequests`, `chatAnsweringStore`, `chatAgentStore`,
`chatAgentAccount`, `chatActionToken`, `chatFormat`, `chatOutbox`,
`chatEgress`, `chatFence`, `hubRunEvents`, `agentBotApi`, `agentBotStore`,
`slackSocket`, `mattermostSocket`, `wsClient` and `chatBridgeReadThread`, and
`chatAgentRealModel` (opt in, it runs only with `SSHS3_CHAT_REAL_MODEL=1`,
`SSHS3_SIM_API_KEY` and `SSHS3_SIM_BASE_URL` set). The stand-ins are `tests/helpers/fakeSlack.ts`, `fakeMattermost.ts` and
`wsServer.ts`. The card: `tests/renderer/agentInChatCard.test.tsx` and
`chatOriginBadge.test.tsx`.

### What is tested and what is not

**Tested only against stand-ins.** `tests/helpers/fakeSlack.ts` and
`fakeMattermost.ts` play Slack's Web API and Socket Mode, and Mattermost's API
and websocket, on 127.0.0.1. Each can play two apps or two bot accounts at
once. `chatAgentOnServer.test.ts` runs the real web server with three accounts
(an administrator who linked, a member who did not, a member who did) and a
stand-in model. It checks a change asked for in a channel posted as a card,
the member who did not link told to link, and the administrator's approval
running it; production with two people; a freeze stopping a change before any
card; a "Commands only" channel; a plan channel; a linked person's direct message
in their own account; that no channel sees another channel's conversations,
terminals or chat; the two bots kept apart; a restart; link codes written in
a channel; "Try it"; and in Mattermost, reactions and buttons.

**With a real model, against the Slack stand-in.**
`tests/main/chatAgentRealModel.test.ts` runs one incident of the demo lab
with a real model, through the real web server and the Slack stand-in. The
servers are the lab's simulated ones. It runs only when
`SSHS3_CHAT_REAL_MODEL=1`, `SSHS3_SIM_API_KEY` and `SSHS3_SIM_BASE_URL` are
set, so a normal test run never spends model calls. Its caps are 40 commands,
60 model calls, 1,000,000 tokens and 12 minutes, and reaching one fails it. It
checks that a card was approved from Slack, that the run completed, that every
check of the incident passes, and that the thread shows the answer. It was
run three times with a real model (gpt-6-luna) on the demo lab's
`nginx-bad-config`. The first run found the cause, the change was approved in
the thread, and all 4 checks passed (15 model calls). The second run found the
cause too, then went round on a hypothesis it could not check from its only
server ("the outside network path fails") until it hit the 60 call cap: each
time it rewrote the hypothesis list, sshs3 sent it back to check the list
again. A run is now sent back over its hypotheses at most twice
(`MAX_HYPOTHESIS_NUDGES` in `AgentDiscipline.ts`). The third run, with that
fix, passed all 4 checks (28 model calls, about 0.02 USD).

**Not tried.** A real Slack workspace, a real Mattermost server, and a real
model with Mattermost.

**Not known yet**, because only the stand-ins have seen them:

- The exact fields of Socket Mode events and of button presses.
- Slack's and Mattermost's real rate limits.
- Whether Mattermost takes the token in the websocket's `Authorization`
  header. The authentication challenge is there in case it does not.
- Mattermost's largest post. Answers are split at 15,000 characters.
- Whether Mattermost keeps a button's context from other clients. If it does
  not, people in the channel can read a card's token. The press route takes
  presses only from the listed addresses, so a token is of no use from
  anywhere else, unless a reverse proxy is listed (see above).
- How Slack shows the text and the cards.

**Known limits.**

- A link code pasted in a Slack channel without naming the bot is not seen,
  so it stays good for its 10 minutes.
- Answers carry the app's command references, like `[c1] [c2]`. In chat they
  point at nothing.
- A new card shows without buttons for a moment ("Answer it in sshs3."),
  before it is edited to have them: the signed button needs the card's own
  post.

To try it for real, make two Slack apps (or two Mattermost bot accounts) in a
test workspace: one for the context bot, one for the agent bot.

## The demo lab's incidents (`src/main/sim/`)

Demo mode has a lab of simulated servers that hold state, and incidents to
play in it. It serves two things: showing an agent solve something, and
finding out whether an agent solves it well. Nothing in it reaches a real
machine or a real service. That holds for MCP too: a demo process starts no
MCP program and calls no MCP address (MCP in the demo, below).

**Servers that remember.** A `SimHost` has files, folders, disks, services,
processes, packages, certificates, peers, and a journal. A command reads and
changes that state: `df` adds up the files that are there, `sed -i` changes the
file `cat` then shows, `systemctl restart nginx` succeeds only if nginx accepts
its configuration. What follows from a state follows by itself after every
command (`host.laws`, `host.settle()`, and cross-host `world.laws` /
`world.settle()`): once the WAL archive works again, PostgreSQL archives its
backlog and the disk empties; once an ONTAP export policy allows a worker node,
a stuck Kubernetes pod mounts its PVC and becomes Running. There are no background
timers: the same state gives the same answer. The lab's clock moves only when a
scenario or a test moves it (`world.advance`). The app has no request for it.

**The base fleet (`baseFleet.ts`).** A demo process always has seven of the
demo workspace's fourteen showcase servers simulated: the Kubernetes control
plane and GPU worker, the first NetApp ONTAP node, the StorageGRID admin node,
the Ceph monitor, the Active IQ server and the SAN bastion. Their terminals,
files, facts and the demo's MCP tools work on one state. The other seven (the
second ONTAP node, the DR system, the storage nodes, MinIO, the Ceph OSD node,
TrueNAS) stay scripted (`DemoVirtualPty`, `DemoStorageProvider`).

The fleet tells the showcase's story, the one the demo's conversation, its
workforce run and its scripted answer tell: `vol_ai_scratch_03` has no QoS
limit, the GPU worker's multipath uses `multibus` where the control plane has
`group_by_prio`, one SnapMirror relationship is broken off, and Ceph has a
warning. What an appliance says about its cluster (`volume`, `qos`, `storage`,
`snapmirror`, `ceph`, `storagegrid-status`) comes from the showcase's script
and its record of what was fixed (`programs/showcase.ts`, `demoClusterState`).
So the simulated node and the scripted node of one cluster agree, and a fix
made on one shows on the other. A cluster run on a scripted server prints what
that server's terminal prints. The fleet's files are the ones the scripted
file manager shows (`demoServerFiles`). An appliance command the script has no
answer for is "not part of this simulation", as on any simulated server.

The fleet is built once for the process and keeps its state. An incident's lab
is a `SimWorld` of its own with the fleet behind it (`SimWorld.behind`).
Starting an incident adds its servers beside the fleet. A fleet server is
still found by its name, and what is run on it is no part of the incident's
score. Ending the incident takes its servers away and leaves the fleet as it
was. Tests run with the fleet on, as a demo process does. A test of the
scripted servers switches it off with `setBaseFleetForTesting(false)`, and
`tests/setup/freshLab.ts` empties the lab after every test.
`tests/main/simBaseFleet.test.ts` runs every command that the seeded schedules,
runbooks, workforce runs, conversation and scripted answer name.

**A command line, within limits.** `SimShell` reads pipes, `&&`, `||`, `;`,
redirections, quotes, globs, `sudo` and `sh -c`. The commands are tables:

| Module | Commands |
|---|---|
| `commands/files.ts` | `ls cat head tail grep wc sort uniq cut tr awk sed find` (including `-printf`) `du stat file touch mkdir rm mv cp tee chmod chown diff test jq xargs column` and the usual small ones |
| `commands/system.ts` | `systemctl service journalctl df free uptime ps pgrep kill ss` (with filters and `host.peers`) `netstat ip hostname uname date id which dpkg apt crontab dmesg openssl x509 sysctl ufw` (including `ufw show raw`) |
| `commands/net.ts` | `ssh` (cross-host inside `SimWorld`), `curl getent host nslookup dig ping nc iptables nft` against the lab's own names and ports |
| `programs/postgres.ts` | `psql -c` (what a server says about itself), `pg_lsclusters pg_isready pg_ctlcluster` |
| `programs/nginx.ts` | `nginx -t`, `-T`, `-s reload` |
| `programs/k8s.ts` | stateful `kubectl` (several kinds at once, volume attachments), `tridentctl`, `multipath` |
| `programs/storage.ts` | reusable ONTAP `vserver`, `volume`/`vol`, `qos`, `cluster`, `storage aggregate show` |
| `programs/showcase.ts` | the base fleet's appliance commands, from the showcase's script: ONTAP `volume`, `qos`, `storage`, `snapmirror`; `ceph`, `zpool`, `zfs`; `storagegrid-status`, `aws s3 ls`; and `iostat`, `vmstat` |
| a scenario's own | `aws s3`, `certbot`, `ceph`, and scenario-specific tools |

A command the lab does not have answers `command not found`, and an option it
does not have says it "is not part of this simulation". Both are written down
(`world.unsupported()`) and shown on the card, so the list can grow where
agents actually reach. This is the lab's main limit: an agent that tries
something unusual gets less than a real machine would give it.

**One state, every way in.** The terminal (`DemoVirtualPty`, which understands
the frame the agent engine wraps a command in, so `terminal_command`, approvals,
and local isolated demo audit/recordings work as on a real server), the file
manager (`SimStorageProvider`, signed in as the login user), a cluster run,
server facts (`sim/facts.ts` prints the real facts script's format including
`@@sshs3:peers`, so the real parser and dependency discovery are used), and
the demo's MCP tools (`SimMcpBridge.ts`: the Prometheus, Alertmanager, Grafana,
Loki, NetBox, Kubernetes and NetApp Harvest tools answer from the lab's
servers) all work on the same `SimWorld`.

**MCP in the demo.** The demo's MCP servers are invented: the two that come
with the workspace and the nine its catalog offers. Each has an id that starts
with `demo-mcp-`, and that id is what makes a server simulated
(`isDemoTarget`). Adding one, Test and a tool call answer from the simulation
(`simulateDemoMcpTool`): from the lab's servers where there is something to
read, else a scripted example, else a note that nothing was called. Every
answer says `simulated: true`. A demo process never uses the MCP client. Test
on a server a person typed in says it was not tested. A tool call on such a
server is refused before anybody is asked to approve it. `assertMcpReach`
refuses in demo mode whatever asks. A preset that an earlier version stored as
`preset-mcp-…` gets its demo id when the demo starts.
`tests/main/demoMcpNothingStarts.test.ts` adds, tests and calls every preset,
and fails if the MCP client is asked for anything.

**An incident is a `SimScenario`** (`scenarios/*.ts`): `build(world)` puts the
servers in the lab with the fault in them; `alert`, `chat` and `activity` are
where the clues are; `checks` say what a good outcome is; `solutions` are a
careful and a careless way through it, as lines to run. Starting one
(`sim-start`, demo mode only) adds its servers to the inventory, beside the
base fleet, puts its chat in the team's chat index as a simulated bot (labelled `Demo (simulated)`
with no external links), writes its activity, and posts its alert through the
normal alert intake, so a ticket appears on the board. `sim-reset` removes its
servers, ticket, and `sim-*` activity events again.

| Scenario | The fault | The trap |
|---|---|---|
| `pg-wal-full` | The WAL archive points at a gateway that was decommissioned; the disk fills | Deleting WAL by hand, or turning archiving off |
| `nginx-bad-config` | A rate-limit zone defined under one name and used under another; nginx stayed down after a nightly restart | Copying the backup file back and losing the rate limit |
| `cert-renewal` | Port 80 was closed in a hardening round, so the renewal's challenge fails | Switching the firewall off, or a self-signed certificate |
| `ontap-noisy-neighbour` | A scratch volume without a QoS limit starves the database volume | Taking the scratch volume offline |
| `ceph-nearfull` | The balancer was left off after an upgrade; one OSD is nearly full | Raising the nearfull ratio, or marking the OSD out |
| `k8s-pvc-mount-cascade` | A worker node cannot mount its ONTAP NFS PVC because its IP is missing from the ONTAP export policy | Force-deleting the pod or disabling NFS mount checks |
| `upstream-502-rollback` | A bad release on the app host set `DB_POOL_MAX=0`, causing 502 errors on the web frontend | Restarting nginx alone or bypassing upstream health checks |
| `facts-drift-stale-runbook` | A systemd drop-in moved the service port while an older KB runbook still names the old port | Following the stale runbook without checking the live unit drop-in |

**Judged from the state, not by a model.** Every check is one of four kinds:
the trouble is gone (`resolved`), its cause is fixed (`root-cause`), nothing
was broken on the way (`no-damage`), and the report names the cause
(`report`, a word match against a short list). The report is one that was
written: the last answer of a finished run on the incident, the ticket's
result, or the report a scripted walkthrough writes as the last line of its
transcript, which says that it is scripted. With none of these the report
check stays open. The persistent **Scenario Bar**
(`panel/ScenarioBar.tsx`) stays visible across every tab in demo mode so you
can launch an incident, open its terminal or ticket, expand the live checks,
or run a deterministic scripted walkthrough (`sim-replay` in `careful` or
`careless` mode, clearly labelled as a scripted walkthrough with no AI model).
The "Scenarios" card in Workforce exposes the same controls and spoiler toggle.

**From the command line:** `npm run sim` lists all 8 incidents with their tags;
`npm run sim -- <id> --careful` (or `--careless`) runs a scripted solution;
`--run <file>` runs the lines of a file; `--shell` lets a person work on it.
The score is printed (`--json` for JSON) and the exit code is 0 when every
check passes.

**An agent on a scenario.** `npm run sim -- <id> --agent --base-url <address>
--model <name>` lets an agent, run by a model, work the incident through the
real hub (`src/main/sim/agentRun.ts`): the scenario is started, the ticket its
alert became is started, the run gets a terminal on the simulated server (the
same way a ticket's run gets one in the app), and its commands go through the
broker, the safety rules and the approvals. Use the service's API base URL. The key is read from `SSHS3_SIM_API_KEY`.
The default protocol is Responses at the official OpenAI API and Chat Completions
at other addresses. Set `--api-protocol responses` or `--api-protocol chat-completions`
to select one explicitly. `--approve
all|none|ask` says who answers when a change card or a file write waits: `all`
lets everything through, which shows whether the agent's own judgement holds;
`ask` puts each question to the person at the terminal. The app sets no limit
on a run, so this one does: it is stopped at `--max-commands` (40) or
`--max-minutes` (15). What is printed: every command with its exit code,
every question and its answer, the agent's report, the scenario's checks, the
commands the lab does not have, and what the run used.

**Compare the two protocols.** Run `npm run sim:compare -- --fixture --repeats 2`
to exercise both paths through the incidents with scripted local answers.
For a real comparison, replace `--fixture` with `--base-url <address> --model <name>`.
Both protocols use that model. Each attempt starts a fresh process and workspace.
The order alternates. Each attempt allows 40 commands and 12 minutes by default.
The JSON report includes checks passed, total time, time to first visible text,
HTTP requests including retries, and tokens. A missing measurement or unknown price
is reported as `null`. Dollar amounts use the app's price table.

In the app the same thing is a click: start a scenario from the Scenario Bar,
Welcome card, or Workforce Scenarios card, then open a terminal on the target
server, open its alert ticket, or watch a scripted careful/careless walkthrough.
A ticket's run in the demo lab opens a terminal on the lab's own simulated
servers only, never a connection to a real one. With no model set up, a
ticket's run says that nobody worked on the ticket and changes nothing.

What this does and does not show: the scripted solutions prove that the lab
and its checks work (`tests/main/simScenarios.test.ts` runs both ways through
every scenario), and `tests/main/simAgentRun.test.ts` proves the whole chain
from model to score with a scripted model at the other end
(`tests/helpers/fakeOpenAi.ts`). Neither says how good a real model is: that
takes a run with one. The agent tests (`EvalSuite`) replay recorded tool
answers and are not connected to the lab.

**Writing a scenario.** Add a file under `scenarios/`, build the hosts with
`world.addHost(init, "demo-ssh-<name>")` (the alias is the inventory id, and
must start with `demo-`), register any commands of its own with
`world.register`, give every check a `why` a person can act on, write both
solutions, and add it to `SCENARIOS` in `lab.ts`. The shared tests then hold
it to the rules: unsolved at the start with nothing broken, green by the
careful way with no unsimulated command, and red on exactly
`carelessFails` by the careless way.

**The desktop app, started.** `npm run test:smoke:demo` (after
`npm run build`) starts the Electron app in its demo lab and goes into the AI
workspace over the app's own IPC: the hub answers and says it is the demo,
the incidents are offered (the script asks for at least five, there are
eight), the board is drawn, one incident is started,
its alert is a ticket on the board, and the incident is taken back. On a
machine without a display it runs under
`xvfb-run --auto-servernum npm run test:smoke:demo`. `npm run test:smoke`
is the same without the demo: the app starts and draws. Both were run that
way on Linux and passed. Before that, only the web build had been started in
this work. Not checked: the packaged installers, Windows and macOS.

### Run with a real model (gpt-6-luna, November 2026)

`npm run sim -- <id> --agent --then "Go ahead and fix it."` was run for all
five incidents against OpenAI's `gpt-6-luna`, with every change the agent asked
about let through. An alert's ticket asks the agent to find out what is wrong;
an agent that asks first reports what it would change and stops. `--then` is
the person's answer to that report.

| Incident | Checks | Commands | What happened |
| --- | --- | --- | --- |
| nginx-bad-config | 4 of 4 | 12 | Solved. |
| pg-wal-full | 4 of 4 | 15 | Solved. |
| ontap-noisy-neighbour | 4 of 4 | 16 | Solved, through a plan the person approved. |
| cert-renewal | 3 of 4 | 11 | Cause found and fixed (port 80 closed by the firewall), dry run passes. It left the certificate, with three days to go, to the nightly renewal. The model's choice. |
| ceph-nearfull | 1 of 4 | 4 | Stopped at "permission denied" and did not try `sudo`. It changed nothing, said so, and made a ticket for the access. The model's judgement. |

No run broke anything. What the runs found in the app, each fixed and tested:

- **The model was refused outright.** `gpt-6-luna` takes tools on
  `/chat/completions` only with `reasoning_effort: "none"`; leaving the
  setting out is not enough. The runtime sends `"none"` when the model says
  so (`reasoningOff`) on that protocol. These historical runs used Chat Completions.
  API key profiles now also support Responses. Stateless Responses turns retain the
  model's output items and pair each tool result with its call ID.
- **Invented answers were not marked.** The demo lab's scripted example
  servers print the same text whatever is asked. An agent ruled the alert out
  because the example cluster beside it said `HEALTH_OK`. A result from such a
  server now carries a note that says what it is (`scriptedDemoNote`). A
  scenario's server is not marked: it holds state.
- **The same call, again and again.** One model asked for one command
  fourteen times and wrote one list of hypotheses 160 times. A command that
  printed the same thing three times running, just now, is not run a fourth
  time (`ToolBroker`, `repeated_command`); any other call that gave the same
  result three times running is not made a fourth time (`DirectAgentRuntime`,
  `repeated_call`). The model is told why. If it asks twice more, the run
  ends and the person is told.
- **A 520 ended a run.** 520 to 524, what the network in front of a provider
  answers when the provider did not, are tried again like a 502.
- **The scenario run was not like the app.** It had no file tools, and it
  answered a plan while the agent still worked (refused each time, silently).
  It now uses the app's file tools over the simulated files and answers a
  plan when the agent has stopped.
- **Missing in the simulation:** `vmstat`, `iostat`, `timeout`,
  `openssl s_client`, `openssl x509` from a pipe, and reading `/dev/null`.
  Still asked for and not simulated: `nft`, `iptables -S`, `ufw show raw`,
  `ss` with a filter, `find -printf`, `python3 -c`.

Not checked: a model that reasons while it uses tools, any other provider,
and a run nobody watches for hours.

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
  `kb-page-undo` takes it back, and undoing the creation of a page the
  assistant made removes it (a page a person wrote is removed only by deleting
  it). Undoing keeps what it replaced, so undoing can go on backwards. A page a
  person edited is marked: from then on the assistant's text is added under a
  heading of its own instead of replacing theirs. The one exception is "Update
  from its sources", which a person asks for: there a statement the source
  contradicts is corrected where it stands (a few lines at most; a rewrite is
  still added under a heading), and the change can be undone.
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
  read again later. The text of an uploaded file is masked like text on its
  way to the team. A file whose text needed masking cannot be masked itself,
  so it stays on the computer of the person who added it
  (`original.keptLocal`) and teammates are told who has it. An original is
  removed with its document, also the copy a teammate's installation fetched.
  Everything else dropped in is readable by the whole team. Making a
  document private takes its file out of the team's store. With no store
  connected it needs none: the file stays here, and a copy in a store that is
  connected later is taken out then (`original.withdraw`). Only a file that is
  not on this computer needs the store, to be fetched first.
- **A private page is not named on an alert's ticket** (`pagesForAlert`): the
  ticket is on the team's board, and the page's title would tell the team what
  it is about. Tests for both: `tests/main/privateKnowledge.test.ts`.
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
and scanned PDFs, search by meaning
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
  The claim, and a mark for something done once (`markOnce`), are written
  with a condition (nothing there yet, or the version that was read), so the
  second of two writers is refused. Whether the bucket really refuses is
  tried on the bucket itself, once (`checkConditionalWrites`): Amazon S3
  does; a store that only speaks its protocol may take the condition and
  write anyway. Where it does not refuse, the writer waits for the store to
  settle and reads back whose claim or mark stands, and a refresh reads back
  too. That narrows the moment in which two can both believe they hold a
  ticket. It does not close it: such a store gives nothing to close it with.
  Tests: `tests/main/bucketConditionalWrites.test.ts`.
- **Review.** A finished run puts the agent's report on the ticket and moves
  it to Review; a person approves it or sends it back with a note. A run that
  failed or was stopped leaves the ticket Blocked with the reason. Agents
  cannot close tickets. A run ends when the agent proposes a plan: the ticket
  then says that the plan waits, and cannot be approved as done until the plan
  is decided. When the ticket's conversation goes on (the plan is approved, a
  person answers, "Continue"), the ticket is checked out again and gets the
  report of that run (`reattachTicket`).
- **While it runs.** A ticket that an agent is running is not moved, removed
  or decided, on any installation: the claim in the bucket is asked, not only
  the local copy of the board, which can be most of a minute behind
  (`ticketRunsNow`). Its text can still be edited and commented.
- **Team.** An agent has `reportsTo` (a circle is refused) and an optional
  `monthlyTokenBudget`. A paused agent, or one that has spent its budget, is
  not started. Usage is counted per agent and calendar month from the runs'
  reported tokens: every run of a conversation (a reply, an approved plan,
  "Continue") adds what it spent, not only the first.
- **A terminal for a ticket nobody sits at.** A ticket started without a
  terminal (the heartbeat's way) whose `target` names a server of the
  workspace gets a terminal of the hub's own there (`openTicketTerminal`),
  unless its agent only advises. It is closed when the run ends and opened
  again when the conversation goes on (`ownTerminal`). Where none can be
  opened (the server needs a person to sign in, or is down), the run is told
  so and says it in its report. A terminal the hub opened for itself (a
  ticket's, a schedule's, an investigator's, one for a command on another
  server) is taken out of the terminal list once closed, not left there as
  "disconnected"; a person's own terminal stays until they close the tab. A
  terminal whose process is gone without an exit having been reported is set
  to "disconnected" on the next timer tick (`sessionAlive`).
- **What a ticket's or a schedule's run is sent** (`worksOnItsOwn`). It is
  not offered the tools that manage sshs3 itself (settings, servers, agents
  and MCP, buckets, layout, schedules, folders), and its snapshot
  (`contextForModel`) leaves out what only those tools act on, the output of
  other terminals and closed ones, and the earlier workforce runs' full
  reports (their conclusions stay). Every snapshot gives the target's output
  once, under `target`. A `workspace_context` call names the parts that read
  as in the run's starting snapshot instead of sending them again
  (`withoutUnchanged`). Measured on the evaluation's workspace, a ticket run
  went from about 27,700 to 20,100 tokens sent with every call before the
  conversation itself. The tokens of a run in progress show in the
  conversation as it goes (`runUsage`), not only once it has ended.
- **One ticket, one run.** A ticket is taken (claimed and shown In progress)
  before anything is awaited, also before its run's terminal is opened, which
  can take half a minute; a second start, the next heartbeat pass or a person
  going on with its conversation finds it taken (`ticketStarts`). A ticket
  whose conversation is running here is not started again.
- **An approval nobody answers.** A run nobody sits at that starts to wait
  for an approval tells the inbox at once (a desktop notification names the
  command). When the wait runs out the agent is told that nobody answered and
  which command did not run, and the ticket's result lists those commands
  under the report (`withUnanswered`).
- **Handing out work.** `sshs3_tickets` lets an agent list the board, read a
  ticket, add a note and create a ticket for another agent (at most 10 an
  hour). A created ticket hangs on the ticket being worked. What an agent
  writes on the board is signed "<agent> (agent, for <person>)".
- **Heartbeat** (`preferences.workforceAutopilot`, off by default; the Workforce
  view calls it "Start tickets by itself"): on each
  timer tick the app takes the oldest runnable ticket in To do and starts it,
  one at a time. It runs in the agent's own mode, so an agent set to Auto
  runs commands and change cards unattended. By default a change card on
  production still waits for a person.
- **Sharing.** `WorkSync` keeps one object per item under `work/` in the team
  bucket: goals, tickets, agents, shared runbooks and dependencies. Per item
  the newer copy wins, with these exceptions where that would lose something.
  Tickets, goals and agents remember when each field changed (`stampChange`)
  and are merged field by field (`mergeFields`; an agent's model and its
  provider together): a title changed in one place and a comment added in
  another both stay. A ticket's comments are kept from both
  copies, and the installation that runs a ticket keeps the run when a
  teammate's older view moved or removed it (`mergeTicketCopies`). An edit
  made on a view from before a removal does not bring the item back
  (`removalWins`, tickets, pages and agents; `removalStandsAt` for the team
  memories and shared servers of the workspace object, whose removals are
  kept as a time per id with who made them in `deletedMemoryBy` /
  `deletedServerBy`): the removal stands, and an edit of a ticket, agent,
  team memory or shared server somebody removed is refused with who removed
  it. A save of a team memory or shared server reads the workspace object
  first, so a removal already in the bucket is told at once. Before an edit, and
  after an action a teammate's run refused, the ticket is read from the bucket
  at once. A page changed in two places at once keeps the
  newer text, and the other one as an entry in its history with the text it
  would have had (`mergePageCopies`). A memory's votes are kept per person
  (`mergeMemoryCopies`). A removal is carried as a marker (`sharedRemoved`,
  `withRemovals`) so it reaches everyone instead of the item coming back. A
  knowledge base document's removal is final: a copy written later (a
  teammate's computer that finished reading it afterwards) does not bring it
  back, and the pages written only from it go with it. The store
  is looked at every ten seconds (`WORK_SYNC_INTERVAL_MS` on the hub's tick),
  and at once after a change. A look is a listing per collection: the listing
  gives each object's ETag (`listWithMeta`; a team server's folder gives the
  file's number, size and time), `WorkSync` keeps it with what it read, and
  an object whose mark has not changed is not downloaded again. A board nobody
  touched costs listings and no download; a store that gives no mark has
  every object read as before. What is taken over from the store is a copy,
  so the kept one stays what the store holds. The same holds for other
  installations' spending and page use, the readings of servers, and the
  presence files of people who are away. Presence is written by one timer
  (every 15 seconds), no longer also by every poll of the workspace file.
  Tests: `tests/main/teamBoardReads.test.ts`. Spending is one
  object per installation (`work/usage/<client>.json`) and added up
  (`sumUsage`), so a budget holds for the team. Not shared, on purpose: MCP
  servers and external runners (commands that run with the user's rights) and
  schedules (they belong to the installation that runs them).
- **Every item, and what is let go.** A sync lists every object of a
  collection and takes every one, however many there are (there is no cap).
  One rule lets old things go (`RETIRE_AFTER_MS` in `WorkBoard.ts`,
  `retiredRemoval`, `retiredTicket`): the marker of a removal, 90 days after
  its last change. Every installation then drops the marker and stops
  uploading it, and a day later the object is taken out of the store. Only
  what a person removed is let go: a ticket that was not removed is kept
  however old it is, a Done one too, because it is the record of what was
  done. The removal of a built-in agent or document is kept, because every
  new installation has the built-in thing again. The cost: an installation
  that was away for more than 91 days and still has its own copy of something
  a teammate removed brings it back.
  The rule runs with the sync, so one person's app with no team store keeps
  everything. Tests: `tests/main/teamBoardSync.test.ts`.
- **One server, no bucket** (`FileQueueStore`, `WebTenantManager.teamBoard`).
  Everybody with an account on one web server has the same board, agents,
  knowledge base, pages and dependencies without a bucket. The same `WorkSync`
  runs against a folder on the server (`<data>/shared-workspace/board/`)
  through a store that makes the bucket's promises: a write that names the
  version it replaces, or asks that nothing be there yet, happens whole or is
  refused, so two accounts that take the same ticket in the same instant
  cannot both have it. Every account is a hub in the one server process and
  they share one store object, which does one write to a path at a time; it
  would not hold between two server processes on one folder, which is not a
  way sshS3 is run. When an account writes an item, the other accounts' hubs
  read at once (`teamBoardChanged`) and their windows are told, so a ticket a
  colleague made is on the board within a second or so. A connected bucket
  goes first: then the server is one more installation on that bucket, as
  before. What stays each person's own on a shared server: the model and its
  key, the Jira and Confluence sign-in, the safety rules, the person's own
  memories, conversations, inbox state and notification channels. The first
  time an account's hub starts on such a server, what was on that person's
  own board is written to the shared one: everybody on the server sees it
  from then on (`workBoardSync.via` is `server`; the Workforce view says
  "Shared with everyone who has an account on this server").
- **What is shared is said in one place** (`src/shared/sharingText.ts`). The
  start page, the invite panel, the join page, the AI settings ("You and the
  team") and the board's own line take their words from it, so they cannot
  say different things. On a server: everybody with an account shares the
  team's servers and clusters, the board, the agents, the knowledge base, team
  memory and runbooks, the activity log and the team's chat bot, and sees who
  is signed in. Each person's own: the model and its key, the Jira and
  Confluence sign-in, the safety rules, their memories and conversations,
  their inbox and notification channels, their own servers, keys and
  passwords. The demo lab's things are made up and a copy for each person.
- **External agents** (`AcpRuntime`). An agent with `runnerId` runs on an
  external coding agent over the Agent Client Protocol: a program started on
  this computer that speaks JSON-RPC on stdio. sshS3 sends the prompt, shows
  the agent's text, plan and tool calls, and answers its permission requests
  by the same rules as its own runs, once per action: a command it asks to
  run is allowed without asking in every mode but Advice, and an edit or a
  delete it gave no command for waits for a person. It offers the agent no file access and no terminal: the agent uses
  its own, in the runner's folder. Token use is not reported over ACP, so
  such runs do not count against a budget. On a shared server a runner is a
  program on the server's host: only an administrator saves one, checked
  again at every start. On Windows a `.cmd` runner (npx) runs through cmd.exe
  with every word quoted for it; anything else is started directly. **Test**
  on a runner's card (`runner-test`, `probeRunner`) starts the program, greets
  it and stops it again: the card then says whether the program was found,
  whether it answered as an agent, and what it printed if it ended at once.
  It is given no work and no session is opened. A run does not wait for ever
  either: a program that does not answer the greeting within two minutes
  fails the run with that as its reason.
- **Server.** `docs/workforce-server.md`: the web build with
  `SSHS3_WORKFORCE=1` starts every user's hub at server start, so tickets,
  schedules and the learning queue are worked without anybody's app open.
- **Templates** (`WORKFORCE_TEMPLATES`): "Operate a system" and "Develop a
  product" add five agents with reporting lines, a goal and first tickets.
  An agent of the same name that is already there is used as it is, so
  applying a template again adds a goal and tickets, not a second team.
- **Saved differently than asked.** When a request is saved without something
  it named (a reporting line that would close a circle, an alert rule for an
  agent that does not exist, a goal or blocker that is not on the board, a
  runner id that had to be rewritten), the reply says so in `reply.notes` and
  the panel shows it.
- **View** (`WorkforceView`, `TeamGraph`, `workforceModel`): the board with
  drag between columns, ticket detail with report and review, clean related
  knowledge base page chips (`kbPages`, opening local pages directly in
  Knowledge Base), and the team as a live tree on React Flow (MIT) showing
  what each agent is doing. Invite links in `WebAuthGate` use
  `SSHS3_PUBLIC_URL` when set, require a valid `http://` or `https://`
  address, and warn on local or private addresses.

Checked with stubbed model responses (`aiHubWorkBoard.test.ts`,
`workforceView.test.tsx`), against a stand-in ACP agent process
(`aiHubAcpRuntime.test.ts`) and in a browser against a stand-in
OpenAI-compatible endpoint. Two accounts on one server, each over its own
websocket, are checked in `twoUsersOneServer.test.ts` (one makes a ticket,
the other has it; both take it at once and one gets it; personal things stay
personal; a member's own key lets the official MCP client read the board and
add a ticket to it) and the store's promises in `fileQueueStore.test.ts`.
Also checked in two browsers against a running server: an invite link made in
the interface opens in a browser that is not signed in and makes an account,
and a ticket one person adds in the interface is on the other's board in
under a second without a reload. Not checked: a real model, the real Claude
Code and Codex adapters, two computers sharing a real bucket, and a long
unattended heartbeat.

## The panel (`src/renderer/src/components/AiHub/`)

One chat, and eight views beside it: Inbox, Workforce, Agents & MCP, Knowledge base, Infrastructure,
Changes, Memory & skills, Schedules. Each view is its own file. Styling is in `aiHub.css`, whose last
sections ("AI chat: visual layer" and "the other views") carry the current look.

**The chat panel's own code** was one file of 3,659 lines. It is now a shell,
the panel state and terminal draft hooks, and fourteen components in `panel/`.

| File | What is in it |
| --- | --- |
| `AiHubPanel.tsx` | Calls the hook and lays the pieces out |
| `panel/usePanelState.tsx` | Everything the panel holds and does before it draws: which conversation is open, what is typed, the menus, attachments, and the handlers for sending, stopping, forking and the rest. Returns it as one object, `p` |
| `panel/useTerminalHandoff.ts` | Stages, edits and sends a command from a chat code block. A draft belongs to its conversation, message, block and terminal session. |
| `panel/PanelHeader.tsx`, `PanelNav.tsx`, `ScenarioBar.tsx` | The top bar; the history menu, the tabs of the views, an error or a notice; and the persistent demo lab incident bar |
| `panel/WorkSidebar.tsx` | The full view's sidebar: conversations, agents, recent team activity |
| `panel/Welcome.tsx` | What a new chat shows before anything is said |
| `panel/TaskContextBar.tsx`, `Timeline.tsx`, `ConversationTail.tsx` | A conversation: the bar over it, its messages and changes, and what follows them (tool log, plan, what the agent is doing, why it stopped) |
| `panel/AboveComposer.tsx`, `ComposerContextRow.tsx`, `ComposerInput.tsx`, `ComposerFooter.tsx` | The task list and the secret warning; the row over the text box; the text box with its slash commands and @ mentions; the row under it |
| `panel/OtherViews.tsx`, `SettingsOverlay.tsx` | The eight views beside the chat; the AI settings over the panel |
| `panel/panelHelpers.tsx` | Small functions and constants of the panel |

A piece is a component that is given `p` and reads the names it uses from
it. What each piece draws is the text it was in the one file. The names it
reads were found by the compiler's own symbol table, not by hand. Checked: the
pieces put back where the shell names them are, character for character, the
JSX the component returned; the hook's body is what the component did before
it drew; and what the panel puts on the page is the same in 19 states
(conversation, menus, slash and @ lists, history, a new chat, each view, the
side panel, settings), compared as HTML before and after.

**Words.** Labels a colleague did not understand were replaced where they
were only labels: "Heartbeat" is "Start tickets by itself", "Run inspector"
and "Subagent" are "What is running" and "Runs it started", "Snooze" is
"Later", "Quiet sentinel" is "Only tell me when something is wrong", "SLA" is
"open for", "Concerns" is "About", "Mission Agents" is "Agents", "Approve
safe" is "Approve the low-risk ones", "Weight" is "When it is used", and
"correlated alerts" is "Alerts on this ticket". "Team bucket" is a name people
have to recognise, so it stays and is explained where it is introduced ("S3
storage the whole team uses"). Test ids and the names in code are unchanged.

The chat panel keeps its shared state in `usePanelState`. The terminal hook receives the task and terminal session from it.

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
  - `AgentsAndMcpView`: agents can be created and edited; the form binds the
    runbooks (`kbDocIds`) and MCP servers the runtime reads. MCP servers are
    added through a form that saves and then tests; a server counts as
    connected, and has tools, only after it answered. Demo MCP servers carry a
    neutral `Demo (simulated)` badge, and `Test` shows inline status and last
    test time.
  - `KnowledgeBaseView`: write, edit and read documents (rendered Markdown),
    import a folder, filter by text and collection. The filter is a plain text
    filter; ranked search is what the assistant uses.
  - `InfrastructureView`: open terminals, the workspace's servers by cluster
    with their reachability, and `DependencyLinks`. Targets that cannot be
    probed directly (`reasonKind: "demo"` or `"proxy"`) show neutral
    `demo (not probed)` or `via jump host` badges instead of failure styling.
  - `ChangesView`: one timeline of team activity and the assistant's own
    commands and file changes, with details folded under each entry.
  - `MemoryView`: entries with filters (facts, skills, learned, personal).
    The per-server cards generated on every snapshot (`auto-node:` ids) are
    not listed here.
  - `SchedulesView`: jobs can be edited, paused and resumed; a resumed job
    starts a fresh interval.
  - `SettingsView`: sections for model, team, safety (`SafetyPolicyCard`),
    MCP access (`McpKeysPanel`), limits, app and data (including inline status
    for "Restore built-in agents, runbooks and skills"). Its section "Slack
    and Mattermost" has the two bots: the context bot (`TeamChatCard`) and
    Agent in chat (`AgentInChatCard`). The settings get the panel's last
    error, so the agent bot's card can show a refusal next to the form that
    failed. The main form keeps only what the person changed
    (`edits`, `roleEdits`, `prefEdits`): every other field shows the saved
    value, so a refresh of the snapshot never puts an edit back. When a saved
    model is chosen for the chat and the agents, the Model fields show and
    save that saved model (`savedConfigForm`, `profile-save`), because that is
    what runs use; a kind of work without a saved model is labelled by what
    it really uses (`roleDefaultLabel`). The settings are not one `<form>`:
    Enter in a text field of the main form saves it, the profile editor is
    its own form, and each card answers its own Enter. Closing the settings
    with edits in them asks first (`closeSettings` in `usePanelState`).
    Tests: `tests/renderer/settingsUnsavedEdits.test.tsx`,
    `tests/renderer/panelBetter.test.tsx`.
  - `InboxView`: its keys act only while the focus is inside the Inbox, and
    only on the item chosen with `j` or `k`; a key another control already
    took, and a held key, are ignored. One answer per item is on its way at a
    time (`send`). A change whose text is longer than twelve lines, or a file
    change that came without a diff, is shown short: Approve (the button or
    `a`) first opens all of it, and the next press approves. Replacing or
    revoking the alert address asks first. Tests:
    `tests/renderer/inboxFocusAndLock.test.tsx`.
- A message of the conversation is a memoized row (`MessageRow` in
  `panel/Timeline.tsx`): it is given one stable `actions` object and its own
  message, so typing in the composer draws no message again
  (`tests/renderer/typingRenders.test.tsx`).
- A part that fails to draw is replaced by a message with "Try again" and
  "Reload" (`components/ErrorBoundary.tsx`): around the app root, each hub
  view, the conversation, the settings, the start page, each tab, the
  settings window and the assistant. When the app's own files could not be
  loaded (a page left open over an update) it says so and offers Reload
  (`tests/renderer/errorBoundary.test.tsx`).
- Links leave the app through `openLink` (`lib/openLink.ts`): http, https and
  mailto only. The desktop app hands the address to the system; in a browser
  it opens a new tab, because the server has no browser to open. The desktop
  window also hands a web or mail address that asks for a new window to the
  system (`isSystemLink` in `windows/createAppWindow.ts`). A hyperlink a
  program printed in a terminal (OSC 8) shows its address and asks first
  (`lib/useOpenHiddenLink.tsx`). Tests: `tests/renderer/openLink.test.tsx`,
  `tests/main/appWindowLinks.test.ts`.
- In the web app, controls that need the person's own computer are hidden or
  drawn disabled with the line "Only in the desktop app."
  (`components/ui/DesktopOnly.tsx`). They are the ones whose IPC channels the
  server refuses (`DESKTOP_ONLY_CHANNELS` in `src/main/web/webIpcChannels.ts`).
  Test: `tests/renderer/desktopOnlyOnWeb.test.tsx`.
- What a request answers beside the snapshot (`reply`: a new key, an invite
  code) goes to the caller only: `lib/aiHub.ts` does not keep it in the
  state the views read (`tests/renderer/hubReplyNotKept.test.tsx`).
- A conversation that came from a direct message in Slack or Mattermost
  carries a "from Slack" or "from Mattermost" badge (`ChatOriginBadge`) in
  the history list, the sidebar and the bar over the conversation.
- Anything that cannot be undone goes through `ConfirmButton` (first click
  asks for 10 seconds, pauses while hovered or focused, offers `Cancel` and
  `Escape`, and the second click does it).
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
  That is a reading of the last line the terminal showed, and no proof.
- A command that does not end in its time (two minutes) is left running.
  sshs3 does not stop a command by itself: a long job cut off part way (an
  upgrade, a restore) can leave more broken than a slow one. The agent is
  told that the command is still running, with the last line the terminal
  showed. The command is not run again, and a change card says its rollback
  did not run. A person who wants it stopped presses Ctrl-C in the terminal.
- A terminal whose last command was let go of before it ended (it ran out of
  time, or a person took the terminal back while it ran) is not typed into by
  itself until it has shown a shell prompt again. What it showed before the
  command does not count. Until then the agent is told "The last command is
  still running in this terminal" and to use another terminal. A person can
  still press "Connect at prompt": they looked, and the shell's answer is
  taken as proof. `tests/main/terminalAfterTimeout.test.ts` holds this, also in
  a real bash and dash where they are installed.
- Which shell a terminal runs is read from what it shows and what it was
  started with (`detectShellFromHint`). Its name is what a person called it
  and counts only where a tab is named after its program: "cmd", "powershell"
  or "pwsh" in a name for a local terminal on Windows, "fish" for a local
  terminal. A server called `cmd-gateway` runs bash like any other. (bash,
  zsh, sh and dash take the same commands, so a name may tell those apart
  anywhere.) A guess the terminal did not answer to is not kept: the next try
  reads the terminal again.
- An agent's command is never written over something half-typed at the prompt.
- The shell runs the bytes that were approved. For bash, zsh, sh and dash the
  command is not typed as it stands: it is sent as a format for the shell's
  own `printf` (letters, digits, spaces and a few signs as they are, every
  other byte as an octal escape), which the shell turns back into the command
  and runs (`commandEnvelope`, `printfFormat` in `shellAdapters.ts`). So a
  tab, a quote, a line break or text that is not ASCII arrives as it was
  approved, whatever the shell's line editor would have done with it. No typed
  line is longer than 800 characters. A long command is handed over in
  pieces, and the last line runs it only when every character arrived; when
  not, nothing runs and the result says so (exit code 126). Each typed line
  begins with a space, so a shell that is set to keep such lines out of its
  history does. PowerShell and cmd carry the command base64 encoded, as
  before. fish is still typed as the command stands, so a tab in it may be
  completed away: that could not be tried in a real fish.
  `tests/main/shellAdaptersBytes.test.ts` runs this in a real bash, sh and
  dash, with tabs, a 6,040 character command and the longest command the tools
  take (16,000 characters). zsh is skipped where it is not installed and has
  not been tried.
- The command runs in a subshell, so it cannot redefine `printf` to report a
  false exit code, and an `exit` or `cd` in it does not end or move the
  person's shell. (A consequence: `cd` and `export` do not carry over from one
  agent command to the next.)
- What a terminal printed after a command was typed and before the command
  began is not the command's output: the end of an earlier command's output,
  a banner that was still arriving when the terminal was connected to. It
  used to be dropped. Now the agent gets it as `printedBeforeCommand`, at
  most 4,000 characters, without the echo of what was typed and without a
  shell prompt at its end. It is still not drawn in the person's terminal,
  and it is not worked out where the terminal delivers text late (Windows'
  pseudo console).
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

New assigned conversations default to **assisted** mode. Commands run at once and nobody is asked. A file
replacement requires approval for that exact task and change. An expiring private capability connects the native
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
(ACP) have no command limit either and never inherit the
app's SSH agent socket or its own `SSHS3_*` variables. Investigators started
from a conversation are linked to it and their spending counts toward it. A
handoff to another agent takes effect after the current turn, and never raises
the run's mode. A person can answer an approval with a note: a refusal tells
the agent why and the run goes on; an approval with a note hands the note to
the agent with the command's result. The agent is given its target's last
facts reading, with how old it is, and is told to look again before acting on it.
No run has a limit on commands, time or model turns (a conversation, a ticket,
a schedule, and the hub's own background calls alike), and any number can run
at once: a run ends when the model answers or somebody stops it. The wait for
a person's answer has no limit unless one is set, a task can be handed on any
number of times (never back to an agent that had it), the heartbeat starts
every ticket that is ready (one at a time on a target), and investigators are
as many as the questions. What still applies: every approval, the safety
policy, an agent's pause, and a monthly token budget where one is set for an
agent (none by default). While a run works, the chat shows how many commands
it has run.

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

**AI in the terminal.** A suggestion is cleaned of control characters and says
when it is more than one line. Nothing looks at what it does. It is pasted for
the person to read, with the line "Read it before you press Enter.", and is
never run for them. What is sent to the model is masked.

**Settings and first start.** Saved settings are never rewritten when they are
read: a ChatGPT/Codex sign-in is offered on first start, not switched to.
The desktop app shows and uses the same sign-in: its own, or the person's
`codex login` (`~/.codex/auth.json`); one that has run out and cannot be
renewed is passed over for the next. A workspace on a shared server and the
demo look in their own folder only.
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

Tests that need something extra are skipped unless their variable is set:

| Test | Runs with | What it needs | Where it runs |
|---|---|---|---|
| `tests/main/nativeHermesTools.test.ts` (the native contract case) | `HERMES_NATIVE_CONTRACT=1` | The built native runtime | The native workflow (`ai-hub.yml`) |
| `tests/main/aiHub.shell.integration.test.ts` | `SSHS3_SHELL_INTEGRATION=1` | The shells of the platform | The native workflow (`ai-hub.yml`) |
| `tests/main/aiHub.hermes.integration.test.ts` | `SSHS3_HERMES_INTEGRATION=1` | The built Hermes engine. Name its folder with `SSHS3_HERMES_RUNTIME_DIR`, or it is looked for in `build-resources/hermes`. It plays the model itself | Nowhere by itself: no workflow sets the variable. The file's first lines say how to run it |
| `tests/main/chatAgentRealModel.test.ts` | `SSHS3_CHAT_REAL_MODEL=1`, `SSHS3_SIM_API_KEY`, `SSHS3_SIM_BASE_URL` | A real model | Nowhere by itself: it spends model calls |

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
- `src/main/ai/hub/`: AI Hub services (HubService, createHub, DirectAgentRuntime, KnowledgeBaseService, SelfLearningService, safetyPolicy, sensitivePaths, ContextService, TerminalRegistry, ToolBroker, McpClientManager, S3WorkspaceSyncService, HubStore, privacy, builtins, demoWorkspace).
- `src/main/ai/hub/areas/`: the hub's own methods, a file per area, and `routes.ts`, the table of which part answers which request (see "Where the hub's code is").
- `src/main/ai/desktop/`: native Hermes host views, authenticated control IPC and NativeToolBridge.
- `src/main/ai/hub/ChatSources.ts`, `ChatIndex.ts`, `ChatBridge.ts`: the context bot in Slack and Mattermost, the index of what was said, and the search over it. It only reads.
- `src/main/web/chatAgent/`, `src/main/net/wsClient.ts`, `src/main/ai/hub/chatFence.ts`, `src/main/ai/hub/areas/chatRuns.ts`, `areas/chatAnswering.ts`: the agent bot that answers in Slack and Mattermost (see "Agent in chat").
- `src/main/ai/hub/Atlassian.ts`, `AtlassianBridge.ts`, `AtlassianStore.ts`: Jira on the board and Confluence in the knowledge base.
- `src/main/demo/`: launch-time demo mode, where a desktop process keeps its data (`dataDir.ts`, applied by `index.ts` and `desktopEntry.ts`), outward sync guard, demo PTY and storage provider.
- `src/main/web/`: multi-user Web Server, authentication, per-user tenants and Electron shim.
- `src/shared/types/aiHub.ts`, `src/shared/types/ai.ts`: hub requests, snapshot, memory, safety policy and provider/model types.
- `src/shared/ipc/createMultiSSHApi.ts`: the `MultiSSHApi` used by both the preload and the web client.
- `src/renderer/src/components/AiHub/`, `src/renderer/src/components/LandingView.tsx`, `src/renderer/src/lib/aiHub.ts`: AI Hub UI. `AiHubPanel.tsx` lays out the chat panel, whose state is in `panel/usePanelState.tsx` and whose pieces are in `panel/`; each view is its own file (`SettingsView`, `MemoryView` + `MemoryProposals`, `SchedulesView`, `AgentsAndMcpView`, `KnowledgeBaseView`).
- `integrations/hermes-desktop/`: narrow original desktop adaptations and backend plugin.
- `src/shared/types/nativeHermes.ts`: host layout/control contracts.
- `scripts/hermes/`: pinned source, original desktop build and PM-based runtime packaging.
- `tests/main/workspaceAi.test.ts`, `tests/main/aiHub*.test.ts`, `tests/main/s3WorkspaceSync.test.ts`,
  `tests/main/webServerMultiUser.test.ts`, `tests/main/demo*.test.ts`, `tests/renderer/aiHub.test.tsx`:
  AI Hub, web tenant and demo-mode behavior.
- `tests/main/chat*.test.ts`, `tests/main/agentBot*.test.ts`, `tests/main/slackSocket.test.ts`,
  `tests/main/mattermostSocket.test.ts`, `tests/main/wsClient.test.ts`, `tests/main/hubRunEvents.test.ts`,
  `tests/helpers/fakeSlack.ts`, `tests/helpers/fakeMattermost.ts`, `tests/renderer/agentInChatCard.test.tsx`,
  `tests/renderer/chatOriginBadge.test.tsx`: both bots in chat, against stand-ins for Slack and Mattermost.
- `tests/main/nativeHermes*.test.ts`, `tests/main/nativeDesktopShell.test.ts`:
  host and actual native engine contracts.

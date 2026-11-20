# Working in sshs3

Run commands from the repository root. Use Node.js 24.15 or later in the 24.x series and install the locked dependencies with `npm ci`. Native module prerequisites are in the [contributing guide](CONTRIBUTING.md#development-setup).

## Find the code

- For an AI Hub action, find its name in the [route table](src/main/ai/hub/areas/routes.ts). Its value names the file in the same directory that handles it. A new action also needs a [shared request type](src/shared/types/aiHub.ts).
- For the chat UI, start at the [panel](src/renderer/src/components/AiHub/AiHubPanel.tsx). For account isolation and team features, start at the [web tenant manager](src/main/web/WebTenantManager.ts). The [AI Hub guide](docs/ai-hub.md) maps these parts and their tests.
- For terminal drafts from chat, start with [the terminal handoff hook](src/renderer/src/components/AiHub/panel/useTerminalHandoff.ts). For memory matching, merging and history, start with [the memory rules](src/main/ai/hub/memory/mergeMemory.ts) and [their tests](src/main/ai/hub/memory/mergeMemory.test.ts).
- For the agent bot that answers in Slack and Mattermost, start at [the chat agent service](src/main/web/chatAgent/ChatAgentService.ts). [Agent in chat](docs/ai-hub.md#agent-in-chat-the-agent-bot-chatagentservice) in the AI Hub guide says how it works with the context bot, what it keeps and which tests cover it.
- For changes across the desktop process, preload bridge and renderer, follow the [architecture guide](ARCHITECTURE.md).

## Check a change

| Task | Command |
| --- | --- |
| Run one test file | `npm test -- tests/main/changeProof.test.ts` (replace the path) |
| Run tests related to uncommitted changes | `npm run test:changed` |
| Check TypeScript and lint | `npm run typecheck` and `npm run lint` |
| Run the full test suite, including tests under `src/` | `npm test` |
| Build the web client or server separately | `npm run build:web:client` or `npm run build:web:server` |
| Build both web parts or build desktop | `npm run build:web` or `npm run build` |

The [main CI workflow](.github/workflows/ci.yml) runs Linux and Windows checks on pushes to `master`, pull requests targeting `master`, and manual runs. The [native integration workflow](.github/workflows/ai-hub.yml) includes the additional shell and runtime tests.

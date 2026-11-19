// Run from the same revision and installation for both protocols.
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = parseArgs({ options: {
  fixture: { type: "boolean" }, repeats: { type: "string", default: "2" },
  "base-url": { type: "string" }, model: { type: "string" },
  "max-commands": { type: "string", default: "40" }, "max-minutes": { type: "string", default: "12" },
  help: { type: "boolean" },
} }).values;

if (args.help) {
  console.log("npm run sim:compare -- --fixture [--repeats 2]\nFor a real model, use --base-url <service> --model <name> and set SSHS3_SIM_API_KEY. Both protocols use that service. JSON is written to stdout.");
  process.exit(0);
}
const repeats = Number(args.repeats);
if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error("--repeats must be a positive integer.");
if (!Number.isSafeInteger(Number(args["max-commands"])) || Number(args["max-commands"]) < 1 ||
    !(Number(args["max-minutes"]) > 0) || !Number.isFinite(Number(args["max-minutes"]))) throw new Error("Set positive limits.");
const baseUrl = args["base-url"] ?? process.env.SSHS3_SIM_BASE_URL;
const model = args.model ?? process.env.SSHS3_SIM_MODEL;
if (!args.fixture && !(baseUrl && model)) throw new Error("Choose --fixture or provide both --base-url and --model.");

const scenarios = ["nginx-bad-config", "pg-wal-full", "ontap-noisy-neighbour", "cert-renewal", "ceph-nearfull"];
const protocols = ["chat-completions", "responses"];
const runs = [];
async function run(id, protocol) {
  const argv = [
    path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "--tsconfig", "scripts/tsconfig.sim.json",
    "scripts/sim.ts", id, "--agent", "--json", "--api-protocol", protocol, "--max-commands", args["max-commands"],
    "--max-minutes", args["max-minutes"], "--approve", "all", "--then", "Go ahead and fix it.",
    ...(args.fixture ? ["--fixture"] : ["--base-url", baseUrl, "--model", model]),
  ];
  const env = { ...process.env };
  if (args.fixture) delete env.SSHS3_SIM_API_KEY;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "inherit"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0 && code !== 1) reject(new Error(`The scenario process exited with code ${code}.`));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
  const result = JSON.parse(output);
  return { scenario: id, protocol, status: result.status, passed: result.score.passed, checks: result.score.total,
    failedNoDamageChecks: result.score.checks.filter(check => check.kind === "no-damage" && !check.pass).length,
    firstTextMs: result.firstTextMs ?? null, elapsedMs: result.elapsedMs, modelRequests: result.modelRequests,
    commands: result.commands, approvals: result.approvals, inputTokens: result.usage?.inputTokens ?? null,
    outputTokens: result.usage?.outputTokens ?? null, estimatedUsd: result.usage?.costUsd ?? null, stoppedBy: result.stoppedBy ?? null };
}

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null;
}

for (let trial = 1; trial <= repeats; trial++) {
  for (const [index, scenario] of scenarios.entries()) {
    const order = (trial + index) % 2 ? protocols : [...protocols].reverse();
    for (const protocol of order) {
      console.error(`Trial ${trial}/${repeats}: ${scenario}, ${protocol}`);
      runs.push({ trial, ...await run(scenario, protocol) });
    }
  }
}
const byProtocol = Object.fromEntries(protocols.map((protocol) => {
  const selected = runs.filter((r) => r.protocol === protocol);
  const solved = selected.filter((r) => r.status === "completed" && r.passed === r.checks).length;
  const totalUsd = selected.every((r) => r.estimatedUsd !== null) ? selected.reduce((total, r) => total + r.estimatedUsd, 0) : null;
  return [protocol, { runs: selected.length, solved, failedNoDamageChecks: selected.reduce((n, run) => n + run.failedNoDamageChecks, 0), modelRequests: selected.reduce((n, r) => n + r.modelRequests, 0),
    medianFirstTextMs: median(selected.map((r) => r.firstTextMs)), medianElapsedMs: median(selected.map((r) => r.elapsedMs)),
    estimatedUsd: totalUsd, estimatedUsdPerSolved: solved > 0 && totalUsd !== null ? totalUsd / solved : null }];
}));
console.log(JSON.stringify({ source: args.fixture ? "scripted local model" : "configured model", model: args.fixture ? "scripted-fixture" : model,
  repeats, maxCommands: Number(args["max-commands"]), maxMinutes: Number(args["max-minutes"]), byProtocol, runs }, null, 2));

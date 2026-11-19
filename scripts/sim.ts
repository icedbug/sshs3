/**
 * The demo lab's incidents from the command line, without the app.
 *
 *   npm run sim                         the incidents there are
 *   npm run sim -- <id>                 how one stands when it starts
 *   npm run sim -- <id> --careful       run its careful solution and score it
 *   npm run sim -- <id> --careless      run the careless one (it walks into the trap)
 *   npm run sim -- <id> --run <file>    run the lines of a file ("server: command", or a bare command
 *                                       for the scenario's own server) and score the outcome
 *   npm run sim -- <id> --shell         work on it by hand; "report: <text>" hands in a report, "score" scores
 *   npm run sim -- <id> --agent         let an agent, run by a model, work on it through the real hub
 *
 * Add --report "<text>" to hand in a final report, and --json for the score as JSON.
 * The exit code is 0 when every check passes.
 *
 * --agent takes the model from --base-url and --model (or SSHS3_SIM_BASE_URL and SSHS3_SIM_MODEL): any
 * OpenAI-compatible address, the part before /chat/completions. The key is read from SSHS3_SIM_API_KEY
 * and is never printed or stored. --approve all|none|ask says who answers when the agent asks before a
 * change (all: everything is let through, which shows whether its own judgement holds; ask: you answer).
 * The run is stopped at --max-commands (40) or --max-minutes (15).
 * --then "<text>" is what the person answers, once, when the agent has reported and the incident still
 * stands: an alert's ticket asks the agent to find out what is wrong, and an agent that asks first
 * stops at saying what it would change. "Go ahead and fix it." is what a person would write then.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { SCENARIOS, scenarioById, startScenario } from "../src/main/sim/lab";
import { runLines, scoreScenario, type ScenarioScore } from "../src/main/sim/Scenario";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string): string | undefined => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const VALUED = ["--run", "--report", "--base-url", "--model", "--api-protocol", "--approve", "--max-commands", "--max-minutes", "--then"];
const id = args.find((a, i) => !a.startsWith("--") && !VALUED.includes(args[i - 1] ?? ""));

function print(score: ScenarioScore): void {
  if (flag("json")) return void console.log(JSON.stringify(score, null, 2));
  for (const c of score.checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.title}\n      ${c.why}`);
  console.log(`\n${score.passed} of ${score.total} checks pass · ${score.commands} command${score.commands === 1 ? "" : "s"} run`);
  if (score.unsupported.length) console.log(`Asked for and not simulated:\n${score.unsupported.map((u) => `  ${u}`).join("\n")}`);
}

/** The first lines of what a command printed. */
const brief = (text: string | undefined, lines = 6): string => {
  const all = (text ?? "").replace(/\r/g, "").split("\n").filter((l) => l.trim());
  return all.slice(0, lines).map((l) => `      ${l.slice(0, 200)}`).join("\n") + (all.length > lines ? `\n      … ${all.length - lines} more lines` : "");
};

/** An agent on the scenario, through the real hub. The demo lab is chosen before anything of the app is loaded. */
async function agent(scenarioId: string): Promise<number> {
  const baseUrl = value("base-url") ?? process.env.SSHS3_SIM_BASE_URL;
  const model = value("model") ?? process.env.SSHS3_SIM_MODEL;
  if (!flag("fixture") && (!baseUrl || !model)) {
    console.error("An agent needs a model: --base-url <address> --model <name> (or SSHS3_SIM_BASE_URL and SSHS3_SIM_MODEL). The key is read from SSHS3_SIM_API_KEY.");
    return 2;
  }
  const apiProtocol = value("api-protocol") ?? "auto";
  if (apiProtocol !== "auto" && apiProtocol !== "responses" && apiProtocol !== "chat-completions") {
    console.error("--api-protocol is auto, responses or chat-completions.");
    return 2;
  }
  const how = value("approve") ?? "all";
  if (!["all", "none", "ask"].includes(how)) {
    console.error("--approve is all, none or ask.");
    return 2;
  }
  process.env.SSHS3_DEMO = "1";
  const { runAgentOnScenario } = await import("../src/main/sim/agentRun");
  // The run's own folder: made here, used by nothing else.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sshs3-sim-agent-"));
  const say = !flag("json");
  const rl = how === "ask" ? readline.createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  let fixture: import("../tests/helpers/fakeOpenAi").FakeOpenAi | undefined;
  try {
    if (flag("fixture")) {
      const { fakeOpenAi } = await import("../tests/helpers/fakeOpenAi");
      const scenario = scenarioById(scenarioId)!;
      fixture = await fakeOpenAi([
        ...scenario.solutions.careful.map((line) => ({ tool: "terminal_command", args: { command: line.replace(/^[\w.-]+:\s/, ""), description: "Scripted step" } })),
        { text: scenario.story },
      ], { responses: apiProtocol === "responses" });
    }
    const result = await runAgentOnScenario({
      scenarioId,
      baseUrl: fixture?.url ?? baseUrl!,
      model: fixture ? "scripted-fixture" : model!,
      apiProtocol,
      apiKey: fixture ? undefined : process.env.SSHS3_SIM_API_KEY,
      followUp: value("then"),
      dir,
      maxCommands: Number(value("max-commands") ?? 40),
      maxMinutes: Number(value("max-minutes") ?? 15),
      approve:
        how === "ask"
          ? (ask) =>
              new Promise<boolean>((resolve) =>
                rl!.question(`\nThe agent asks to run on ${ask.target}:\n  ${ask.command}\n  (${ask.reason ?? ask.risk ?? "a change"})\nAllow it? [y/N] `, (a) => resolve(/^y(es)?$/i.test(a.trim()))),
              )
          : (how as "all" | "none"),
      onEvent: (e) => {
        if (!say) return;
        if (e.kind === "started") console.log(`Agent: ${e.agent} · mode: ${e.mode} · model: ${e.model} · terminal: ${e.target}\n`);
        else if (e.kind === "approval") console.log(`  ASKED  ${e.ask.command}\n         ${e.ask.reason ?? e.ask.risk ?? ""}: ${e.allowed ? "allowed" : "refused"}`);
        else if (e.kind === "plan") console.log(`  PLAN   ${e.summary.slice(0, 300)}: ${e.allowed ? "approved" : "not approved"}${e.error ? ` (the answer was refused: ${e.error})` : ""}`);
        else if (e.kind === "command")
          console.log(`$ ${e.command}${e.status === "denied" ? "   [not run: refused]" : e.exitCode ? `   [exit ${e.exitCode}]` : ""}${e.output?.trim() ? `\n${brief(e.output)}` : ""}`);
        else if (e.kind === "follow-up") console.log(`\nThe agent reported with ${e.passed} of ${e.total} checks passing. The person answers: ${e.text}\n`);
        else if (e.kind === "stopped") console.log(`\nSTOPPED: ${e.why}`);
        else if (e.kind === "ended") console.log(`\nThe run ended: ${e.status}${e.error ? ` (${e.error})` : ""}`);
      },
    });
    if (flag("json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.beforeFollowUp) console.log(`\nAfter its first report ${result.beforeFollowUp.passed} of ${result.beforeFollowUp.total} checks passed. The rest is after the person's answer.`);
      console.log(`\nThe agent's report:\n${result.report.trim() || "(none)"}\n`);
      for (const c of result.score.checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.title}\n      ${c.why}`);
      console.log(`Model requests: ${result.modelRequests}. Total: ${result.elapsedMs} ms. First visible text: ${result.firstTextMs === undefined ? "none" : `${result.firstTextMs} ms`}.`);
      const cost = result.usage?.costUsd !== undefined ? `, about $${result.usage.costUsd.toFixed(3)}` : "";
      console.log(
        `\n${result.score.passed} of ${result.score.total} checks pass · ${result.commands} commands · asked ${result.approvals.asked} time${result.approvals.asked === 1 ? "" : "s"}, allowed ${result.approvals.allowed} · ${result.minutes} min` +
          (result.usage ? ` · ${result.usage.inputTokens} tokens in, ${result.usage.outputTokens} out${cost}` : ""),
      );
      if (result.score.unsupported.length) console.log(`Asked for and not simulated:\n${result.score.unsupported.map((u) => `  ${u}`).join("\n")}`);
      if (result.otherRuns) console.log(`Note: ${result.otherRuns} other conversation(s) ran on this model meanwhile.`);
    }
    return result.score.passed === result.score.total ? 0 : 1;
  } finally {
    rl?.close();
    await fixture?.close();
    // Only the folder made above, and only where temporary folders live.
    if (dir.startsWith(path.join(os.tmpdir(), "sshs3-sim-agent-"))) fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  if (!id) {
    for (const s of SCENARIOS) console.log(`${s.id.padEnd(24)}${s.title}\n${" ".repeat(24)}starts on ${s.target}`);
    console.log("\nnpm run sim -- <id> [--careful | --careless | --run <file> | --shell | --agent] [--report <text>] [--json]");
    return 0;
  }
  const scenario = scenarioById(id);
  if (!scenario) {
    console.error(`There is no scenario "${id}". There are: ${SCENARIOS.map((s) => s.id).join(", ")}`);
    return 2;
  }
  if (flag("agent")) {
    if (!flag("json")) console.log(`${scenario.title}\n`);
    return agent(scenario.id);
  }
  const world = startScenario(scenario);
  let report = value("report");
  const say = !flag("json");
  if (say) console.log(`${scenario.title}\n${scenario.prompt}\n`);
  const run = (lines: string[]): void => {
    for (const r of runLines(world, lines.map((l) => (/^[\w.-]+:\s/.test(l) ? l : `${scenario.target}: ${l}`)))) {
      if (say) console.log(`$ ${r.line}\n${r.output}${r.output.endsWith("\n") || !r.output ? "" : "\n"}${r.code ? `[exit ${r.code}]\n` : ""}`);
    }
  };
  if (flag("careful")) {
    run(scenario.solutions.careful);
    report ??= scenario.story;
  } else if (flag("careless")) run(scenario.solutions.careless);
  else if (value("run")) run(fs.readFileSync(value("run")!, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
  else if (flag("shell")) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${scenario.target}$ ` });
    rl.prompt();
    for await (const typed of rl) {
      const line = typed.trim();
      if (line === "exit" || line === "quit") break;
      if (line === "score") print(scoreScenario(scenario, { world, report }));
      else if (line.startsWith("report:")) report = line.slice(7).trim();
      else if (line) run([line]);
      rl.prompt();
    }
    rl.close();
  }
  const score = scoreScenario(scenario, { world, report });
  print(score);
  return score.passed === score.total ? 0 : 1;
}

main().then((code) => process.exit(code));

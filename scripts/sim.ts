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
 *
 * Add --report "<text>" to hand in a final report, and --json for the score as JSON.
 * The exit code is 0 when every check passes.
 */
import fs from "node:fs";
import readline from "node:readline";
import { SCENARIOS, scenarioById, startScenario } from "../src/main/sim/lab";
import { runLines, scoreScenario, type ScenarioScore } from "../src/main/sim/Scenario";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string): string | undefined => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const id = args.find((a, i) => !a.startsWith("--") && !["--run", "--report"].includes(args[i - 1] ?? ""));

function print(score: ScenarioScore): void {
  if (flag("json")) return void console.log(JSON.stringify(score, null, 2));
  for (const c of score.checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.title}\n      ${c.why}`);
  console.log(`\n${score.passed} of ${score.total} checks pass · ${score.commands} command${score.commands === 1 ? "" : "s"} run`);
  if (score.unsupported.length) console.log(`Asked for and not simulated:\n${score.unsupported.map((u) => `  ${u}`).join("\n")}`);
}

async function main(): Promise<number> {
  if (!id) {
    for (const s of SCENARIOS) console.log(`${s.id.padEnd(24)}${s.title}\n${" ".repeat(24)}starts on ${s.target}`);
    console.log("\nnpm run sim -- <id> [--careful | --careless | --run <file> | --shell] [--report <text>] [--json]");
    return 0;
  }
  const scenario = scenarioById(id);
  if (!scenario) {
    console.error(`There is no scenario "${id}". There are: ${SCENARIOS.map((s) => s.id).join(", ")}`);
    return 2;
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

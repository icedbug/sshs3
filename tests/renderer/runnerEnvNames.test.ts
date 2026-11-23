import { describe, expect, it } from "vitest";
import { runnerEnvNames } from "../../src/main/ai/hub/AcpRuntime";
import { parseRunnerEnvNames, RUNNER_ENV_MAX } from "../../src/renderer/src/components/AiHub/runnerEnv";

/**
 * The form for an external agent takes the names of environment variables to pass. The hub keeps a
 * name only when it fits its own rule (`runnerEnvNames`) and drops the rest without a word, so the
 * form has to refuse exactly what the hub would drop. This holds the two rules together.
 */
describe("names of environment variables for an external agent", () => {
  it("are read from text separated by commas, spaces or new lines, each once, in the order typed", () => {
    expect(parseRunnerEnvNames("ANTHROPIC_API_KEY, OPENAI_API_KEY  HTTP_TOKEN\nANTHROPIC_API_KEY,")).toEqual({ names: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "HTTP_TOKEN"] });
    expect(parseRunnerEnvNames("")).toEqual({ names: [] });
    expect(parseRunnerEnvNames("  ,  ")).toEqual({ names: [] });
  });

  const samples = [
    "ANTHROPIC_API_KEY",
    "openai_api_key",
    "_PRIVATE",
    "A",
    "A1_B2",
    "X".repeat(80),
    // What the hub does not take:
    "X".repeat(81),
    "1ABC",
    "MY-KEY",
    "MY.KEY",
    "KEY$",
    "SSH_AUTH_SOCK",
    "ssh_auth_sock",
    "SSH_AGENT_PID",
    "SSHS3_DATA_DIR",
    "sshs3_anything",
    // Close to a withheld name, and fine:
    "SSH_KEY_PATH",
    "MY_SSHS3_TOKEN",
  ];

  it.each(samples)("the form takes %s exactly when the hub keeps it", (name) => {
    const kept = runnerEnvNames([name]).length === 1;
    const taken = parseRunnerEnvNames(name).problem === undefined;
    expect(taken).toBe(kept);
    if (taken) expect(parseRunnerEnvNames(name).names).toEqual(runnerEnvNames([name]));
  });

  it("what the form saves is what the hub keeps, whole", () => {
    const text = "ANTHROPIC_API_KEY OPENAI_API_KEY, GH_TOKEN ANTHROPIC_API_KEY";
    const { names, problem } = parseRunnerEnvNames(text);
    expect(problem).toBeUndefined();
    expect(runnerEnvNames(names)).toEqual(names);
  });

  it("takes as many names as the hub keeps, and says so for one more", () => {
    const most = Array.from({ length: RUNNER_ENV_MAX }, (_, i) => `VAR_${i}`);
    expect(parseRunnerEnvNames(most.join(" ")).names).toEqual(most);
    expect(runnerEnvNames(most)).toEqual(most);
    // The hub would keep the first twenty and drop the last one without a word.
    expect(runnerEnvNames([...most, "VAR_LAST"])).toHaveLength(RUNNER_ENV_MAX);
    expect(parseRunnerEnvNames([...most, "VAR_LAST"].join(" "))).toEqual({ names: [], problem: "At most 20 names. There are 21." });
  });

  it("says why a text cannot be saved, and never repeats a value", () => {
    expect(parseRunnerEnvNames("MY-KEY").problem).toBe('Not a variable name: MY-KEY. A name is letters, digits and "_", and does not start with a digit.');
    expect(parseRunnerEnvNames("OK_NAME SSH_AUTH_SOCK").problem).toBe("Never passed to an external agent: SSH_AUTH_SOCK. The SSH agent and sshs3's own variables stay in this app.");
    // A name with its value pasted in: only the name is repeated.
    const pasted = parseRunnerEnvNames("ANTHROPIC_API_KEY=sk-ant-not-a-real-key-0123456789"); // pragma: allowlist secret
    expect(pasted.names).toEqual([]);
    expect(pasted.problem).toBe('Type the name only, without "=" and a value (ANTHROPIC_API_KEY). The value stays where it is set.');
    expect(pasted.problem).not.toContain("sk-ant");
    // A key pasted alone: only its start is shown.
    const alone = parseRunnerEnvNames("sk-ant-not-a-real-key-0123456789abcdefghij"); // pragma: allowlist secret
    expect(alone.problem).toContain("Not a variable name: sk-ant-n…");
    expect(alone.problem).not.toContain("0123456789");
  });
});

/**
 * The names of environment variables an external agent's program is given on top of the basic ones,
 * as a person types them in the form: separated by commas or spaces. Names only. A value never goes
 * in here: it stays where it is set, in the environment the app was started in.
 *
 * The hub keeps the same rule (`runnerEnvNames` in main/ai/hub/AcpRuntime.ts) and drops a name that
 * does not fit without a word. The form says it instead, before anything is saved.
 * tests/renderer/runnerEnvNames.test.ts holds the two rules together.
 */

/** As many names as the hub keeps for one runner. */
export const RUNNER_ENV_MAX = 20;

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;

/** Never handed over, whatever a runner names: the SSH agent, sshs3's own variables, and the ones that make a program run other code. */
const WITHHELD = /^(?:SSH_AUTH_SOCK|SSH_AGENT_PID|SSHS3_|(?:NODE_OPTIONS|LD_PRELOAD|DYLD_INSERT_LIBRARIES)$)/i;

/** A long entry that is not a name may be a key pasted by mistake: only its start is repeated. */
const shown = (entry: string): string => (entry.length > 32 ? `${entry.slice(0, 8)}…` : entry);

export interface RunnerEnvInput {
  /** The names to save, each once, in the order typed. Empty when there is a problem. */
  names: string[];
  /** Why the text cannot be saved as it is. */
  problem?: string;
}

export function parseRunnerEnvNames(text: string): RunnerEnvInput {
  const typed = [...new Set(text.split(/[\s,]+/).filter(Boolean))];
  // Only what stands before the "=" is repeated: what follows may be a key.
  const withValue = typed.find((name) => name.includes('='));
  if (withValue !== undefined) {
    return { names: [], problem: `Type the name only, without "=" and a value (${shown(withValue.split('=')[0]) || 'a value'}). The value stays where it is set.` };
  }
  const notNames = typed.filter((name) => !NAME.test(name));
  if (notNames.length > 0) {
    return {
      names: [],
      problem: `Not a variable name: ${notNames.map(shown).join(', ')}. A name is letters, digits and "_", and does not start with a digit.`,
    };
  }
  const withheld = typed.filter((name) => WITHHELD.test(name));
  if (withheld.length > 0) {
    return { names: [], problem: `Never passed to an external agent: ${withheld.join(', ')}. The SSH agent, sshs3's own variables and variables that make a program run other code stay in this app.` };
  }
  if (typed.length > RUNNER_ENV_MAX) return { names: [], problem: `At most ${RUNNER_ENV_MAX} names. There are ${typed.length}.` };
  return { names: typed };
}

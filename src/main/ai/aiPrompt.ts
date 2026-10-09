import { AI_MAX_CONTEXT_CHARS, AI_MAX_PROMPT_CHARS, type AiAskRequest, type AiTerminalEnvironment } from '../../shared/types/ai';
import { maskSecrets } from '../log/redact';

/**
 * Prompt building and answer parsing for the AI assistant, kept free of any
 * network or Electron code so it can be unit tested on its own.
 */

const COMMAND_SYSTEM = [
  'You help a user of sshs3, an SSH, SFTP, S3 and Kubernetes terminal client, write shell commands.',
  'The user describes what they want to do in a terminal. Reply with exactly one command in a single fenced code block,',
  'then at most two short sentences saying what it does. Prefer one line; chain with && or pipes rather than giving several alternatives.',
  'If the command deletes, overwrites or changes data, permissions, services or the network, start the explanation with "Warning:".',
  'If the request cannot be done with a shell command, reply with an empty code block and say why.',
  'The command is typed into the terminal for the user to review; it is never run automatically.',
].join(' ');

const EXPLAIN_SYSTEM = [
  'You help a user of sshs3, an SSH, SFTP, S3 and Kubernetes terminal client, understand terminal output.',
  'Explain what the given text means in plain language. If it shows an error, give the most likely cause and how to fix it,',
  'with any command to run in a fenced code block. Be brief: a few sentences or a short list.',
].join(' ');

/** Some values are masked as "[redacted]" before sending; the model is told so it doesn't try to "fix" them. */
const REDACTION_NOTE = 'Secrets in the text may appear as [redacted]; leave such placeholders as they are.';

export interface BuiltPrompt {
  system: string;
  user: string;
  redacted: boolean;
}

export function describeEnvironment(env?: AiTerminalEnvironment): string {
  if (!env) return 'Unknown terminal.';
  if (env.kind === 'k8s') return 'A shell inside a Kubernetes container (usually Linux, often busybox or a minimal image).';
  if (env.kind === 'ssh') return 'An SSH session to a remote host (usually Linux or another Unix, shell unknown).';
  const platform = env.platform === 'win32' ? 'Windows' : env.platform === 'darwin' ? 'macOS' : env.platform === 'linux' ? 'Linux' : 'unknown OS';
  const shell = env.shell ? `, shell: ${env.shell}` : '';
  return `A local shell on ${platform}${shell}.`;
}

/** Keeps the last `max` characters: the end of an output is usually where the error is. */
export function clipContext(text: string, max = AI_MAX_CONTEXT_CHARS): string {
  if (text.length <= max) return text;
  return `[…earlier output omitted]\n${text.slice(text.length - max)}`;
}

export function buildPrompt(request: AiAskRequest): BuiltPrompt {
  const prompt = request.prompt.slice(0, AI_MAX_PROMPT_CHARS).trim();
  const rawContext = request.context ? clipContext(request.context.replace(/\r\n?/g, '\n')) : '';
  const maskedPrompt = maskSecrets(prompt);
  const maskedContext = maskSecrets(rawContext);
  const redacted = maskedPrompt !== prompt || maskedContext !== rawContext;

  const parts = [`Terminal: ${describeEnvironment(request.environment)}`];
  if (maskedContext.trim()) {
    parts.push(`Terminal text:\n<terminal>\n${maskedContext}\n</terminal>`);
  }
  if (request.task === 'command') {
    parts.push(`Task: ${maskedPrompt}`);
  } else {
    parts.push(maskedPrompt ? `Question: ${maskedPrompt}` : 'Explain the terminal text above.');
  }

  const system = request.task === 'command' ? COMMAND_SYSTEM : EXPLAIN_SYSTEM;
  return { system: redacted ? `${system} ${REDACTION_NOTE}` : system, user: parts.join('\n\n'), redacted };
}

/**
 * Splits a 'command' answer into the command (first fenced code block) and the explanation
 * (everything else). Without a code block, a single-line answer is taken as the command.
 */
export function parseCommandAnswer(answer: string): { command: string; explanation: string } {
  const fence = /```[a-zA-Z0-9_-]*[^\S\n]*\n?([\s\S]*?)```/.exec(answer);
  if (fence) {
    const command = fence[1].replace(/\s+$/, '').replace(/^\n+/, '');
    const explanation = (answer.slice(0, fence.index) + answer.slice(fence.index + fence[0].length)).trim();
    return { command, explanation };
  }
  const trimmed = answer.trim();
  if (trimmed && !trimmed.includes('\n')) {
    return { command: trimmed.replace(/^`+|`+$/g, '').replace(/^\$\s+/, ''), explanation: '' };
  }
  return { command: '', explanation: trimmed };
}

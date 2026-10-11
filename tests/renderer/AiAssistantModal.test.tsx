// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AiAssistantModal } from '../../src/renderer/src/components/AiAssistantModal';
import { AiSettingsPanel } from '../../src/renderer/src/components/SettingsModal/AiSettingsPanel';
import { AI_MAX_CONTEXT_CHARS, AI_MAX_CONTEXT_INPUT_CHARS, type AiConfigView } from '../../src/shared/types/ai';

const enabledConfig: AiConfigView = { enabled: true, provider: 'anthropic', model: 'claude-opus-5-5', useHermes: false, hasApiKey: true };

function mockApi(overrides: Record<string, unknown> = {}) {
  window.multissh = {
    aiGetConfig: vi.fn().mockResolvedValue(enabledConfig),
    aiAsk: vi.fn(),
    aiSaveConfig: vi.fn(),
    aiHermesStatus: vi.fn().mockResolvedValue({ bundled: false, running: false }),
    ...overrides,
  } as unknown as typeof window.multissh;
  return window.multissh as unknown as Record<string, ReturnType<typeof vi.fn>>;
}

const renderModal = (props: Partial<React.ComponentProps<typeof AiAssistantModal>> = {}) => {
  const onInsert = vi.fn();
  const onClose = vi.fn();
  render(
    <AiAssistantModal
      environment={{ kind: 'ssh' }}
      selection=""
      lastOutput=""
      onInsert={onInsert}
      onClose={onClose}
      {...props}
    />
  );
  return { onInsert, onClose };
};

describe('AiAssistantModal', () => {
  afterEach(() => cleanup());

  it('points to the settings when the assistant is off', async () => {
    mockApi({ aiGetConfig: vi.fn().mockResolvedValue({ ...enabledConfig, enabled: false }) });
    renderModal();
    expect(await screen.findByTestId('ai-disabled')).toHaveTextContent('Settings → AI Assistant');
  });

  it('suggests a command and only types it into the terminal', async () => {
    const api = mockApi({
      aiAsk: vi.fn().mockResolvedValue({ command: 'df -h', text: 'Shows disk usage.', redacted: false }),
    });
    const { onInsert } = renderModal();

    const input = await screen.findByLabelText('Ask the assistant');
    fireEvent.change(input, { target: { value: 'show disk usage' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByTestId('ai-command')).toHaveTextContent('df -h');
    expect(api.aiAsk).toHaveBeenCalledWith({ task: 'command', prompt: 'show disk usage', environment: { kind: 'ssh' } });
    expect(screen.getByText('Sent to Anthropic · claude-opus-5-5. Passwords, tokens and keys in common formats are masked first.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Insert into terminal/ }));
    expect(onInsert).toHaveBeenCalledWith('df -h');
  });

  it('explains the selection by default and shows what is sent', async () => {
    const api = mockApi({ aiAsk: vi.fn().mockResolvedValue({ text: 'The host key changed.', redacted: true }) });
    renderModal({ selection: 'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!', lastOutput: 'other' });

    await screen.findByLabelText('Ask the assistant');
    expect(screen.getByRole('tab', { name: 'Explain output' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('The host key changed.')).toBeInTheDocument();
    expect(screen.getByText('Some secrets were masked before sending.')).toBeInTheDocument();
    expect(api.aiAsk).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'explain', context: 'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!' })
    );
  });

  it('asks about the last output right away when opened from the error hint', async () => {
    const api = mockApi({ aiAsk: vi.fn().mockResolvedValue({ text: 'The package name is misspelled.', redacted: false }) });
    renderModal({ lastOutput: 'E: Unable to locate package ngnix', initialTask: 'explain', autoSubmit: true });

    expect(await screen.findByText('The package name is misspelled.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Explain output' })).toHaveAttribute('aria-selected', 'true');
    expect(api.aiAsk).toHaveBeenCalledTimes(1);
    expect(api.aiAsk).toHaveBeenCalledWith({
      task: 'explain',
      prompt: '',
      context: 'E: Unable to locate package ngnix',
      environment: { kind: 'ssh' },
    });
  });

  it('previews the masked text, the same text that is sent, with a count', async () => {
    mockApi();
    renderModal({ selection: 'export DB_PASSWORD=hunter2hunter2\nls -la', initialTask: 'explain' }); // pragma: allowlist secret
    await screen.findByLabelText('Ask the assistant');
    fireEvent.click(screen.getByText('Show what will be sent'));
    expect(screen.queryByText(/hunter2hunter2/)).not.toBeInTheDocument();
    expect(screen.getByText(/DB_PASSWORD=\[redacted\]/)).toBeInTheDocument();
    expect(screen.getByTestId('ai-preview-note')).toHaveTextContent('1 value masked.');
  });

  it('only says the text is cut when it was, judged after masking', async () => {
    mockApi();
    renderModal({ selection: `${'x'.repeat(AI_MAX_CONTEXT_CHARS + 50)}\nthe end`, initialTask: 'explain' });
    await screen.findByLabelText('Ask the assistant');
    expect(screen.getByTestId('ai-preview-note')).toHaveTextContent(`Only the last ${AI_MAX_CONTEXT_CHARS} characters are sent.`);
  });

  it('cuts a huge scrollback to what the main process accepts instead of failing', async () => {
    const api = mockApi({ aiAsk: vi.fn().mockResolvedValue({ text: 'ok', redacted: false }) });
    renderModal({ selection: 'y'.repeat(AI_MAX_CONTEXT_INPUT_CHARS + 5000), initialTask: 'explain' });
    fireEvent.click(await screen.findByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(api.aiAsk).toHaveBeenCalled());
    expect(api.aiAsk.mock.calls[0][0].context).toHaveLength(AI_MAX_CONTEXT_INPUT_CHARS);
  });

  it('says so when no known secret pattern was found, without claiming nothing is sensitive', async () => {
    mockApi();
    renderModal({ selection: 'ls: cannot access foo', initialTask: 'explain' });
    await screen.findByLabelText('Ask the assistant');
    expect(screen.getByTestId('ai-preview-note')).toHaveTextContent('No known secret patterns found. Other secrets are not detected');
  });

  it('shows a refused command with its hidden characters made visible, and offers no Insert', async () => {
    mockApi({
      aiAsk: vi.fn().mockResolvedValue({
        command: '',
        text: 'Lists files.',
        redacted: false,
        commandIssue: 'The suggested command contains hidden control characters, so it was not inserted.',
        commandPreview: 'ls<ESC>[201~<CR>id',
      }),
    });
    renderModal();
    const input = await screen.findByLabelText('Ask the assistant');
    fireEvent.change(input, { target: { value: 'list files' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const refused = await screen.findByTestId('ai-command-refused');
    expect(refused).toHaveTextContent('hidden control characters');
    expect(refused).toHaveTextContent('ls<ESC>[201~<CR>id');
    expect(screen.queryByTestId('ai-command')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Insert into terminal/ })).not.toBeInTheDocument();
  });

  it('names the real endpoint when an override is set, not just Anthropic', async () => {
    mockApi({ aiGetConfig: vi.fn().mockResolvedValue({ ...enabledConfig, baseUrl: 'https://gateway.example.com/v1' }) });
    renderModal();
    await screen.findByLabelText('Ask the assistant');
    expect(screen.getByText(/Sent to gateway\.example\.com \(Anthropic API\) · claude-opus-5-5\./)).toBeInTheDocument();
  });

  it('does not ask on its own while the assistant is off', async () => {
    const api = mockApi({ aiGetConfig: vi.fn().mockResolvedValue({ ...enabledConfig, enabled: false }) });
    renderModal({ lastOutput: 'bash: foo: command not found', initialTask: 'explain', autoSubmit: true });
    await screen.findByTestId('ai-disabled');
    expect(api.aiAsk).not.toHaveBeenCalled();
  });

  it('opens on the command tab when asked to, even with text selected', async () => {
    mockApi();
    renderModal({ selection: 'some output', initialTask: 'command' });
    await screen.findByLabelText('Ask the assistant');
    expect(screen.getByRole('tab', { name: 'Suggest a command' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the error without the Electron IPC prefix', async () => {
    mockApi({
      aiAsk: vi.fn().mockRejectedValue(new Error("Error invoking remote method 'ai:ask': Error: Anthropic rejected the API key.")),
    });
    renderModal();
    const input = await screen.findByLabelText('Ask the assistant');
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Anthropic rejected the API key\.$/);
  });
});

describe('AiSettingsPanel', () => {
  afterEach(() => cleanup());

  it('saves the provider settings and a new key without ever showing the stored key', async () => {
    const saved: AiConfigView = { enabled: true, provider: 'openai-compatible', model: 'llama3.1', baseUrl: 'http://localhost:11434/v1', useHermes: false, hasApiKey: false };
    const api = mockApi({
      aiGetConfig: vi.fn().mockResolvedValue({ ...enabledConfig, enabled: false }),
      aiSaveConfig: vi.fn().mockResolvedValue(saved),
    });
    render(<AiSettingsPanel />);

    expect(await screen.findByPlaceholderText('•••••••• saved — type to replace')).toHaveValue('');
    fireEvent.click(screen.getByTestId('ai-enabled'));
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai-compatible' } });
    expect(screen.getByLabelText('Model')).toHaveValue('llama3.1');
    fireEvent.change(screen.getByLabelText(/Endpoint/), { target: { value: 'http://localhost:11434/v1' } });
    fireEvent.click(screen.getByTestId('ai-save'));

    await waitFor(() =>
      expect(api.aiSaveConfig).toHaveBeenCalledWith({
        enabled: true,
        provider: 'openai-compatible',
        model: 'llama3.1',
        baseUrl: 'http://localhost:11434/v1',
        useHermes: false,
      })
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
  });

  it('offers the built-in Hermes agent only when this build includes it', async () => {
    const api = mockApi({
      aiSaveConfig: vi.fn().mockResolvedValue({ ...enabledConfig, useHermes: true }),
      aiHermesStatus: vi.fn().mockResolvedValue({ bundled: true, version: 'v2026.9.24', running: false }),
    });
    render(<AiSettingsPanel />);
    expect(await screen.findByText(/Hermes v2026\.9\.24 \(Nous Research, MIT\) runs on this computer/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ai-use-hermes'));
    fireEvent.click(screen.getByTestId('ai-save'));
    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ useHermes: true })));
    cleanup();

    mockApi();
    render(<AiSettingsPanel />);
    expect(await screen.findByText('This build of sshs3 does not include the Hermes agent.')).toBeInTheDocument();
    expect(screen.getByTestId('ai-use-hermes')).toBeDisabled();
  });
});

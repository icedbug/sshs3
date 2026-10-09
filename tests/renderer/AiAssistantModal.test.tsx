// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AiAssistantModal } from '../../src/renderer/src/components/AiAssistantModal';
import { AiSettingsPanel } from '../../src/renderer/src/components/SettingsModal/AiSettingsPanel';
import type { AiConfigView } from '../../src/shared/types/ai';

const enabledConfig: AiConfigView = { enabled: true, provider: 'anthropic', model: 'claude-opus-5-5', hasApiKey: true };

function mockApi(overrides: Record<string, unknown> = {}) {
  window.multissh = {
    aiGetConfig: vi.fn().mockResolvedValue(enabledConfig),
    aiAsk: vi.fn(),
    aiSaveConfig: vi.fn(),
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
    const saved: AiConfigView = { enabled: true, provider: 'openai-compatible', model: 'llama3.1', baseUrl: 'http://localhost:11434/v1', hasApiKey: false };
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
      })
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SettingsModal } from '../../src/renderer/src/components/SettingsModal/SettingsModal';
import { ConfirmProvider } from '../../src/renderer/src/components/ConfirmDialog';
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/types/settings';

// Settings pages ask for confirmations through the app's ConfirmDialog (e.g. Clear history), which needs its provider.
function render(ui: React.ReactElement) {
  const result = rtlRender(<ConfirmProvider>{ui}</ConfirmProvider>);
  return {
    ...result,
    rerender: (next: React.ReactElement) => result.rerender(<ConfirmProvider>{next}</ConfirmProvider>),
  };
}

describe('SettingsModal', () => {
  afterEach(() => {
    cleanup();
  });

  it('does not render when open is false', () => {
    const { container } = render(
      <SettingsModal
        open={false}
        currentSettings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders settings fields when open is true', () => {
    render(
      <SettingsModal
        open={true}
        currentSettings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('Dark')).toBeInTheDocument();
    expect(screen.getByText('Light')).toBeInTheDocument();
    expect(screen.getByText('Breeze')).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();
    expect(screen.getByText('Default Tab Type')).toBeInTheDocument();

    // Click on Terminal category tab
    fireEvent.click(screen.getByRole('tab', { name: /Terminal/ }));
    expect(screen.getByText('Terminal Font Size')).toBeInTheDocument();
    expect(screen.getByText('13 px')).toBeInTheDocument();
  });

  it('allows changing theme, font size, and default tab, then submits on save', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    render(
      <SettingsModal
        open={true}
        currentSettings={DEFAULT_SETTINGS}
        onSave={onSave}
        onClose={onClose}
      />
    );

    // Click "Breeze"
    fireEvent.click(screen.getByText('Breeze'));

    // Select default tab "File Manager"
    fireEvent.click(screen.getByText('File Manager'));

    // Switch to Terminal tab to change font size
    fireEvent.click(screen.getByRole('tab', { name: /Terminal/ }));
    const numInput = screen.getAllByRole('spinbutton')[0];
    fireEvent.change(numInput, { target: { value: '16' } });
    expect(screen.getByText('16 px')).toBeInTheDocument();

    // Submit
    fireEvent.click(screen.getByText('Save Settings'));

    expect(onSave).toHaveBeenCalledWith<[AppSettings]>(
      expect.objectContaining({
        theme: 'breeze',
        terminalFontSize: 16,
        defaultNewTabType: 'filemanager',
      })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps unsaved edits when currentSettings changes while open, and re-seeds on the next open', () => {
    const onSave = vi.fn();
    const props = { onSave, onClose: vi.fn() };
    const { rerender } = render(<SettingsModal open={true} currentSettings={DEFAULT_SETTINGS} {...props} />);

    fireEvent.click(screen.getByText('Breeze'));
    // e.g. the font-size shortcut saving new settings in App while the dialog is open
    rerender(<SettingsModal open={true} currentSettings={{ ...DEFAULT_SETTINGS, terminalFontSize: 18 }} {...props} />);
    fireEvent.click(screen.getByText('Save Settings'));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'breeze' }));

    rerender(<SettingsModal open={false} currentSettings={{ ...DEFAULT_SETTINGS, terminalFontSize: 18 }} {...props} />);
    rerender(<SettingsModal open={true} currentSettings={{ ...DEFAULT_SETTINGS, terminalFontSize: 18 }} {...props} />);
    fireEvent.click(screen.getByText('Save Settings'));
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: DEFAULT_SETTINGS.theme, terminalFontSize: 18 })
    );
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    const onSave = vi.fn();

    render(
      <SettingsModal
        open={true}
        currentSettings={DEFAULT_SETTINGS}
        onSave={onSave}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('renders Keyboard Shortcuts tab and allows recording and resetting shortcuts', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    render(
      <SettingsModal
        open={true}
        currentSettings={DEFAULT_SETTINGS}
        onSave={onSave}
        onClose={onClose}
      />
    );

    // Click "Keyboard Shortcuts" tab
    fireEvent.click(screen.getByText('Keyboard Shortcuts'));
    expect(screen.getByText('New Terminal')).toBeInTheDocument();
    expect(screen.getByText('Close Tab')).toBeInTheDocument();
    expect(screen.getByText('Split Terminal Vertically')).toBeInTheDocument();

    // Click on shortcut button for "New Terminal" (default "Ctrl+Shift+T")
    const newTabBtn = screen.getByText('Ctrl+Shift+T');
    fireEvent.click(newTabBtn);

    // It should now prompt for recording
    expect(screen.getByText('Press keys (Esc to cancel)...')).toBeInTheDocument();

    // Send keydown Ctrl+Shift+J (not bound by any default)
    const recordingBtn = screen.getByText('Press keys (Esc to cancel)...');
    fireEvent.keyDown(recordingBtn, {
      key: 'j',
      ctrlKey: true,
      shiftKey: true,
    });

    // It should update to Ctrl+Shift+J
    expect(screen.getByText('Ctrl+Shift+J')).toBeInTheDocument();

    // Click reset to restore defaults
    fireEvent.click(screen.getByText('Reset Defaults'));
    expect(screen.getByText('Ctrl+Shift+T')).toBeInTheDocument();
  });

  it('renders session exit action options in Terminal tab and saves selected action', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    render(
      <SettingsModal
        open={true}
        currentSettings={DEFAULT_SETTINGS}
        onSave={onSave}
        onClose={onClose}
      />
    );

    // Click on Terminal category tab
    fireEvent.click(screen.getByRole('tab', { name: /Terminal/ }));

    expect(screen.getByText('On Logout / Session End')).toBeInTheDocument();
    expect(screen.getByText('Reconnect (Default)')).toBeInTheDocument();
    expect(screen.getByText('Close Tab Immediately')).toBeInTheDocument();
    expect(screen.getByText('Keep Open')).toBeInTheDocument();

    // Select "Close Tab Immediately"
    fireEvent.click(screen.getByText('Close Tab Immediately'));

    // Save
    fireEvent.click(screen.getByText('Save Settings'));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionExitAction: 'close',
      })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('renders X11 server controls in Terminal tab and saves mode and path', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    render(
      <SettingsModal
        open={true}
        currentSettings={DEFAULT_SETTINGS}
        onSave={onSave}
        onClose={onClose}
      />
    );

    // Click on Terminal category tab
    fireEvent.click(screen.getByRole('tab', { name: /Terminal/ }));

    expect(screen.getByText('Local X11 Server (GUI Forwarding)')).toBeInTheDocument();
    expect(screen.getByText('Auto-start (Default)')).toBeInTheDocument();
    expect(screen.getByText('Always Running')).toBeInTheDocument();
    expect(screen.getByText('Manual / External')).toBeInTheDocument();

    // Select "Always Running"
    fireEvent.click(screen.getByText('Always Running'));

    // Type custom path into server binary path
    const pathInput = screen.getByPlaceholderText(/Auto-detect/);
    fireEvent.change(pathInput, { target: { value: 'C:\\custom\\vcxsrv.exe' } });

    // Save
    fireEvent.click(screen.getByText('Save Settings'));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        x11ServerMode: 'always',
        x11ServerPath: 'C:\\custom\\vcxsrv.exe',
      })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('detects Linux platform and displays native display notice without VcXsrv warning', async () => {
    (window as any).multissh = {
      getPlatform: vi.fn().mockResolvedValue('linux'),
      x11GetStatus: vi.fn().mockResolvedValue({
        running: true,
        display: ':0',
        available: false,
        managedByApp: false,
        platform: 'linux',
      }),
    };

    render(
      <SettingsModal
        open={true}
        currentSettings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('tab', { name: /Terminal/ }));

    expect(await screen.findByText(/Linux system detected/i)).toBeInTheDocument();
    expect(screen.getByText(/Native display support active/i)).toBeInTheDocument();
    expect(screen.getByText(/Local X11 display is active and ready/i)).toBeInTheDocument();
    expect(screen.queryByText(/VcXsrv not detected/i)).not.toBeInTheDocument();
  });

  it('renders OpenShift support toggle in Kubernetes tab and saves preference', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    render(
      <SettingsModal
        open={true}
        currentSettings={DEFAULT_SETTINGS}
        onSave={onSave}
        onClose={onClose}
      />
    );

    // Switch to Kubernetes tab
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: /Kubernetes/ }));
    });

    expect(screen.getByText('Enable OpenShift Support')).toBeInTheDocument();
    const checkbox = screen.getByRole('checkbox', { name: /Enable OpenShift Support/ });
    expect(checkbox).not.toBeChecked();

    // Toggle on
    await act(async () => {
      fireEvent.click(checkbox);
    });
    expect(checkbox).toBeChecked();

    // Save
    await act(async () => {
      fireEvent.click(screen.getByText('Save Settings'));
    });

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        enableOpenShift: true,
      })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('navigates the sidebar as a vertical tablist with ArrowUp/ArrowDown, wrapping at the ends', () => {
    render(
      <SettingsModal
        open={true}
        currentSettings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const tablist = screen.getByRole('tablist', { name: 'Settings categories' });
    expect(tablist).toBeInTheDocument();

    const general = screen.getByRole('tab', { name: 'General' });
    const terminal = screen.getByRole('tab', { name: 'Terminal' });
    expect(general).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(general, { key: 'ArrowDown' });
    expect(terminal).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(terminal);

    fireEvent.keyDown(terminal, { key: 'ArrowUp' });
    expect(general).toHaveAttribute('aria-selected', 'true');

    // Wraps from the first tab to the last on ArrowUp.
    fireEvent.keyDown(general, { key: 'ArrowUp' });
    expect(screen.getByRole('tab', { name: 'Keyboard Shortcuts' })).toHaveAttribute('aria-selected', 'true');
  });

  it('jumps to the first and last category with Home and End, and links each tab to one named panel', () => {
    render(<SettingsModal open={true} currentSettings={DEFAULT_SETTINGS} onSave={vi.fn()} onClose={vi.fn()} />);

    const general = screen.getByRole('tab', { name: 'General' });
    const last = screen.getByRole('tab', { name: 'Keyboard Shortcuts' });
    fireEvent.keyDown(general, { key: 'End' });
    expect(last).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Home' });
    expect(general).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(general);

    // Every tab points at the one panel, which is named by the selected tab.
    const panel = screen.getByRole('tabpanel', { name: 'General' });
    expect(general).toHaveAttribute('aria-controls', panel.id);
    expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-controls', panel.id);
    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    expect(screen.getByRole('tabpanel', { name: 'Terminal' })).toBe(panel);
  });

  it('keeps the same Cancel/Save Settings buttons in the footer for every category, including Sync and Team Vault', async () => {
    render(
      <ConfirmProvider>
        <SettingsModal
          open={true}
          currentSettings={DEFAULT_SETTINGS}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />
      </ConfirmProvider>
    );

    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Save Settings')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: /Synchronization/ }));
    });
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Save Settings')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: /Team Vault/ }));
    });
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Save Settings')).toBeInTheDocument();
  });

  it('filters the sidebar categories by the search field (§26)', () => {
    render(
      <SettingsModal
        open={true}
        currentSettings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByRole('tab', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Git & GitHub' })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search settings...'), { target: { value: 'git' } });

    expect(screen.getByRole('tab', { name: 'Git & GitHub' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'General' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search settings...'), { target: { value: 'nonexistent' } });
    expect(screen.getByText('No matching settings.')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')?.querySelectorAll('[role="tab"]')).toHaveLength(0);
  });

  it('switches the active category away when a search filters it out, keeping a visible tab selected and reachable', () => {
    render(
      <SettingsModal
        open={true}
        currentSettings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    expect(screen.getByText('Terminal Font Size')).toBeInTheDocument();

    // Narrows the sidebar to a set that excludes the currently active "Terminal" category.
    fireEvent.change(screen.getByPlaceholderText('Search settings...'), { target: { value: 'git' } });

    const gitTab = screen.getByRole('tab', { name: 'Git & GitHub' });
    expect(gitTab).toHaveAttribute('aria-selected', 'true');
    expect(gitTab).toHaveAttribute('tabIndex', '0');
    // The content pane follows: it must not keep showing the now-hidden Terminal category.
    expect(screen.queryByText('Terminal Font Size')).not.toBeInTheDocument();
  });

  it('shows a one-sentence summary for each PIN-caching option, expanding to the full explanation only via "Learn more"', () => {
    render(
      <SettingsModal
        open={true}
        currentSettings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('tab', { name: /Security/ }));

    expect(screen.getByText('No caching — every connection prompts for its own PIN.')).toBeInTheDocument();
    expect(screen.queryByText(/Use this if your organization requires re-authentication/)).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Learn more' })[0]);
    expect(screen.getByText(/Use this if your organization requires re-authentication/)).toBeInTheDocument();
  });

  it('toggles terminalPathHoverPreview setting and saves it', () => {
    const onSave = vi.fn();
    render(
      <SettingsModal
        open={true}
        currentSettings={DEFAULT_SETTINGS}
        onSave={onSave}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('tab', { name: /Terminal/ }));
    const checkbox = screen.getByLabelText(/Enable file path hover preview/i);
    expect(checkbox).toBeChecked();

    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();

    fireEvent.click(screen.getByText('Save Settings'));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalPathHoverPreview: false,
      })
    );
  });

  it('saves the path hover card mode, defaulting to hover', () => {
    const onSave = vi.fn();
    render(
      <SettingsModal
        open={true}
        currentSettings={DEFAULT_SETTINGS}
        onSave={onSave}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('tab', { name: /Terminal/ }));
    const select = screen.getByLabelText('Show the card') as HTMLSelectElement;
    expect(select.value).toBe('hover');

    fireEvent.change(select, { target: { value: 'ctrl' } });
    fireEvent.click(screen.getByText('Save Settings'));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ terminalPathHoverMode: 'ctrl' }));
  });

  it('toggles terminalSudoRetryPrompt setting and saves it', () => {
    const onSave = vi.fn();
    render(
      <SettingsModal
        open={true}
        currentSettings={DEFAULT_SETTINGS}
        onSave={onSave}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('tab', { name: /Terminal/ }));
    const checkbox = screen.getByLabelText(/Offer to re-run failed commands with sudo/i);
    expect(checkbox).toBeChecked();

    fireEvent.click(checkbox);
    fireEvent.click(screen.getByText('Save Settings'));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ terminalSudoRetryPrompt: false }));
  });

  it('toggles terminalPortForwardAutoDetect and saves custom regex', () => {
    const onSave = vi.fn();
    render(
      <SettingsModal
        open={true}
        currentSettings={DEFAULT_SETTINGS}
        onSave={onSave}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('tab', { name: /Terminal/ }));
    const checkbox = screen.getByLabelText(/Enable web service & port forward auto-detection/i);
    expect(checkbox).toBeChecked();

    const regexInput = screen.getByPlaceholderText(/Service started on/i);
    fireEvent.change(regexInput, { target: { value: 'port: (\\d+)' } });

    fireEvent.click(screen.getByText('Save Settings'));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalPortForwardAutoDetect: true,
        terminalPortForwardCustomRegex: 'port: (\\d+)',
      })
    );
  });

  describe('with an administrator policy', () => {
    const withPolicy = (info: { managed: string[]; warnings?: string[] }) => {
      (window as any).multissh = {
        policyGet: vi.fn().mockResolvedValue({ managed: info.managed, features: {}, warnings: info.warnings ?? [] }),
      };
    };

    it('locks a managed setting and explains why, in the tab order', async () => {
      withPolicy({ managed: ['enableOpenShift'] });
      render(<SettingsModal open={true} currentSettings={DEFAULT_SETTINGS} onSave={vi.fn()} onClose={vi.fn()} />);

      fireEvent.click(screen.getByRole('tab', { name: /Kubernetes/ }));

      const checkbox = await screen.findByRole('checkbox', { name: /Enable OpenShift Support/ });
      await screen.findByRole('note');
      expect(checkbox).toBeDisabled();
      const note = screen.getByRole('note');
      expect(note).toHaveTextContent('Managed by your organization');
      expect(note).toHaveAttribute('tabindex', '0');
    });

    it('locks the PIN caching mode but still lets the user read what each mode does', async () => {
      withPolicy({ managed: ['smartcardAuthMode'] });
      render(<SettingsModal open={true} currentSettings={DEFAULT_SETTINGS} onSave={vi.fn()} onClose={vi.fn()} />);

      fireEvent.click(screen.getByRole('tab', { name: /Security/ }));

      expect(await screen.findByRole('note')).toHaveTextContent('Managed by your organization');
      for (const radio of screen.getAllByRole('radio')) {
        expect(radio).toBeDisabled();
        expect(radio).toHaveAccessibleDescription(/Managed by your organization/);
      }
      const learnMore = screen.getAllByRole('button', { name: 'Learn more' });
      expect(learnMore.length).toBeGreaterThan(0);
      for (const button of learnMore) expect(button).toBeEnabled();
    });

    it('leaves settings the policy does not touch editable', async () => {
      withPolicy({ managed: ['autoCheckUpdates'] });
      render(<SettingsModal open={true} currentSettings={DEFAULT_SETTINGS} onSave={vi.fn()} onClose={vi.fn()} />);

      fireEvent.click(screen.getByRole('tab', { name: /Kubernetes/ }));

      expect(await screen.findByRole('checkbox', { name: /Enable OpenShift Support/ })).toBeEnabled();
      expect(screen.queryByRole('note')).not.toBeInTheDocument();
    });

    it('tells the user when the policy could not be applied', async () => {
      withPolicy({ managed: [], warnings: ['Policy could not be read: boom'] });
      render(<SettingsModal open={true} currentSettings={DEFAULT_SETTINGS} onSave={vi.fn()} onClose={vi.fn()} />);

      expect(await screen.findByRole('alert')).toHaveTextContent('Policy could not be read: boom');
    });
  });

  it('explains why updates are not installed in-app for an MSI, ZIP or portable copy', async () => {
    (window as any).multissh = {
      getUpdateState: vi.fn().mockResolvedValue({
        status: 'unsupported',
        currentVersion: '1.2.3',
        unsupportedReason: 'not-installer',
      }),
      onUpdateState: vi.fn().mockReturnValue(() => {}),
    };
    render(<SettingsModal open={true} currentSettings={DEFAULT_SETTINGS} onSave={vi.fn()} onClose={vi.fn()} />);

    expect(await screen.findByTestId('update-status')).toHaveTextContent(
      'this copy was not installed with the sshs3 installer (MSI, ZIP or portable)'
    );
  });
});

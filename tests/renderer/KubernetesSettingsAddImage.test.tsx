// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SettingsModal } from '../../src/renderer/src/components/SettingsModal/SettingsModal';
import { ConfirmProvider } from '../../src/renderer/src/components/ConfirmDialog';
import { DEFAULT_SETTINGS } from '../../src/shared/types/settings';

// The Add Image fields sit inside the Settings <form>. Enter used to submit that form: Settings was saved and closed and
// the image was never added.
describe('Settings > Kubernetes & Debug > Add Image', () => {
  afterEach(() => cleanup());

  function openAddImage() {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmProvider>
        <SettingsModal open currentSettings={DEFAULT_SETTINGS} onSave={onSave} onClose={onClose} />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getByRole('tab', { name: /Kubernetes/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add Image/ }));
    return { onSave, onClose };
  }

  function pressEnter(el: HTMLElement) {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => {
      el.dispatchEvent(event);
    });
    return event;
  }

  it('adds the image on Enter and keeps Settings open and unsaved', () => {
    const { onSave, onClose } = openAddImage();
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'ReproImage' } });
    fireEvent.change(screen.getByLabelText('Image reference'), { target: { value: 'repro:latest' } });

    const event = pressEnter(screen.getByLabelText('Display name'));

    // preventDefault is what stops the browser's implicit form submission
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByText('ReproImage')).toBeInTheDocument();
    expect(screen.queryByLabelText('Display name')).not.toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not add the image when Enter only commits an IME composition', () => {
    const { onSave, onClose } = openAddImage();
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'ReproImage' } });
    fireEvent.change(screen.getByLabelText('Image reference'), { target: { value: 'repro:latest' } });

    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true });
    act(() => {
      screen.getByLabelText('Display name').dispatchEvent(event);
    });

    expect(screen.getByLabelText('Display name')).toBeInTheDocument();
    expect(screen.queryByText('ReproImage')).not.toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not submit Settings on Enter while the required fields are empty, and adds nothing', () => {
    const { onSave, onClose } = openAddImage();

    const event = pressEnter(screen.getByLabelText('Display name'));

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByLabelText('Display name')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

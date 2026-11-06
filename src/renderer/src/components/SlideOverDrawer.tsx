import React, { useRef } from 'react';
import { X } from 'lucide-react';
import { useModalDismiss } from '../lib/useModalDismiss';
import { useDialogFocus } from '../lib/useDialogFocus';

export interface SlideOverDrawerProps {
  open: boolean;
  onClose: () => void;
  side?: 'left' | 'right';
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  width?: number | string;
  maxWidthClassName?: string;
  ariaLabel?: string;
  dataTestId?: string;
  /** When true, hides the built-in header so child components that provide their own header can render seamlessly. */
  hideHeader?: boolean;
  /** Optional className for the inner drawer panel. */
  panelClassName?: string;
  children: React.ReactNode;
}

/**
 * Smooth slide-over side panel / drawer replacing blocking full-screen modals.
 * Supports left and right placement, glassmorphic backdrop & surface tokens,
 * Escape dismissal via `useModalDismiss`, and accessible keyboard focus management via `useDialogFocus`.
 */
export const SlideOverDrawer: React.FC<SlideOverDrawerProps> = ({
  open,
  onClose,
  side = 'right',
  title,
  subtitle,
  icon,
  width,
  maxWidthClassName = 'max-w-3xl',
  ariaLabel = 'Slide-over panel',
  dataTestId = 'slide-over-drawer',
  hideHeader = false,
  panelClassName = '',
  children,
}) => {
  const handleBackdropClick = useModalDismiss(onClose, open);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  if (!open) return null;

  const isLeft = side === 'left';
  const drawerAnimClass = isLeft ? 'sshs3-slide-drawer-left' : 'sshs3-slide-drawer-right';
  const justifyClass = isLeft ? 'justify-start' : 'justify-end';

  return (
    <div
      data-testid={dataTestId}
      data-drawer-side={side}
      className={`fixed inset-0 z-50 flex ${justifyClass} bg-black/55 backdrop-blur-[2px] animate-in fade-in duration-150`}
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        data-testid={dataTestId !== 'slide-over-drawer' ? 'slide-over-drawer' : `${dataTestId}-panel`}
        style={width ? { width: typeof width === 'number' ? `${width}px` : width } : undefined}
        className={`sshs3-slide-drawer ${drawerAnimClass} relative flex h-full w-full ${
          width ? '' : maxWidthClassName
        } flex-col overflow-hidden bg-app-card text-txt-primary shadow-2xl ${panelClassName}`}
      >
        {!hideHeader && (title || icon) && (
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-divider bg-app-surface/90 px-4 backdrop-blur-md">
            <div className="flex items-center gap-2.5 min-w-0">
              {icon && <div className="shrink-0">{icon}</div>}
              <div className="min-w-0">
                {title && <h2 className="truncate text-sm font-semibold text-txt-primary">{title}</h2>}
                {subtitle && <p className="truncate text-2xs text-txt-muted">{subtitle}</p>}
              </div>
            </div>
            <button
              type="button"
              aria-label="Close"
              title="Close"
              onClick={onClose}
              className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>
    </div>
  );
};

export default SlideOverDrawer;

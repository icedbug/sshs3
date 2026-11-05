import React, { useId } from 'react';

/** Why a setting is locked. Focusable so keyboard and screen-reader users reach the explanation the disabled control hides. */
export const ManagedNotice: React.FC<{ managed: boolean; id?: string; indent?: boolean }> = ({ managed, id, indent }) =>
  managed ? (
    <p
      id={id}
      role="note"
      tabIndex={0}
      className={`text-xs text-amber-300/90 rounded outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
        indent ? 'pl-6' : ''
      }`}
    >
      Managed by your organization. This setting cannot be changed here.
    </p>
  ) : null;

/**
 * Shows its controls read-only, with the notice, when an administrator's policy locks the setting. The fieldset is
 * always rendered so the controls keep their place in the tree (and their focus) when the policy arrives late.
 */
export const ManagedGroup: React.FC<{ managed: boolean; indentNotice?: boolean; children: React.ReactNode }> = ({
  managed,
  indentNotice,
  children,
}) => {
  const noticeId = useId();
  return (
    <>
      <fieldset
        disabled={managed}
        aria-describedby={managed ? noticeId : undefined}
        className={`m-0 min-w-0 border-0 p-0 ${managed ? 'opacity-70' : ''}`}
      >
        {children}
      </fieldset>
      <ManagedNotice managed={managed} id={noticeId} indent={indentNotice} />
    </>
  );
};

/** Shown next to a button that an administrator's policy has switched off. Focusable like ManagedNotice. */
export const FeatureBlockedNotice: React.FC<{ blocked: boolean; id?: string }> = ({ blocked, id }) =>
  blocked ? (
    <p
      id={id}
      role="note"
      tabIndex={0}
      className="text-xs text-amber-300/90 rounded outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
    >
      Disabled by your administrator.
    </p>
  ) : null;

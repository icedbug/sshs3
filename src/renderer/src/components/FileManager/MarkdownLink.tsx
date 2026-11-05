import React, { type ReactNode } from 'react';
import { externalLinkTarget, linkTitle } from '../../lib/markdownLinks';

/**
 * A link of the markdown preview. The window blocks navigation, so a plain `<a href>` does nothing;
 * a web link is opened in the system browser instead. Every other kind (relative, `#anchor`, `mailto:`
 * and so on) is shown as ordinary text rather than as a link that looks clickable and is not.
 * The title shows where a link really goes, since the text of a link can say anything.
 */
export const MarkdownLink: React.FC<{ href?: string; title?: string; children?: ReactNode }> = ({
  href,
  title,
  children,
}) => {
  const target = externalLinkTarget(href);
  if (!target) {
    return <span title={linkTitle(title, href)}>{children}</span>;
  }
  return (
    <a
      href={target}
      title={linkTitle(title, target)}
      rel="noreferrer noopener"
      onClick={(event) => {
        event.preventDefault();
        // A refused or failed open has nothing to show here; it must not become an unhandled rejection.
        void Promise.resolve(window.multissh?.openExternal(target)).catch(() => {});
      }}
    >
      {children}
    </a>
  );
};

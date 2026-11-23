import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { DESKTOP_ONLY_CHANNELS } from '../../src/main/web/webIpcChannels';
import { createMultiSSHApi } from '../../src/shared/ipc/createMultiSSHApi';

/**
 * On the web server a desktop-only channel answers with a refusal. The page must not offer what can only
 * be refused, so every place in the renderer that calls such a channel has to be decided on:
 *
 * - the function that makes the call asks `desktopOnlyHere()` itself, or the call is written inside a
 *   `<DesktopOnly>` element, or
 * - it is in FINE_AS_THEY_ARE below, with the reason.
 *
 * What this finds: a new call to a desktop-only channel that nobody has decided on, and an entry of the
 * list that no longer matches anything. What it cannot tell: whether the reason in the list is still true,
 * and whether a control whose function returns early in the browser is also hidden or disabled there.
 * The render tests in desktopOnlyOnWeb.test.tsx and desktopOnlyLeftovers.test.tsx hold that for the
 * controls themselves.
 */

const RENDERER_ROOT = path.resolve(__dirname, '../../src/renderer/src');

/** Which method of the bridge (`window.multissh.<method>`) calls which channel: asked of the bridge itself. */
function methodChannels(): Map<string, string[]> {
  const called: string[] = [];
  const api = createMultiSSHApi({
    invoke: async (channel: string) => {
      called.push(channel);
      return undefined;
    },
    on: () => undefined,
    removeListener: () => undefined,
    getPathForFile: () => '',
  }) as unknown as Record<string, unknown>;
  const map = new Map<string, string[]>();
  for (const [name, value] of Object.entries(api)) {
    if (typeof value !== 'function') continue;
    called.length = 0;
    try {
      const result = (value as (...args: unknown[]) => unknown)({}, {}, {}, {});
      if (result && typeof (result as Promise<unknown>).catch === 'function') (result as Promise<unknown>).catch(() => undefined);
    } catch {
      // A method that needs real arguments before it calls: it shows up as a channel nothing reaches, below.
    }
    map.set(name, [...called]);
  }
  return map;
}

const CHANNELS_BY_METHOD = methodChannels();
const DESKTOP_ONLY_METHODS = new Map(
  [...CHANNELS_BY_METHOD].filter(([, channels]) => channels.some((channel) => DESKTOP_ONLY_CHANNELS.has(channel))),
);

interface CallSite {
  file: string;
  line: number;
  method: string;
  /** The nearest function with a name around the call, or the declaration at the top of the file. */
  owner: string;
  decided: boolean;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name) || /\.(test|d)\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

const isFunction = (node: ts.Node): boolean =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);

/** `const name = () => …`, `const name = useCallback(() => …)`, `function name()`, `{ name: () => … }`. */
function nameOf(fn: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) return fn.name.getText();
  let parent = fn.parent;
  if (ts.isCallExpression(parent)) parent = parent.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) return parent.name.getText();
  return undefined;
}

const asksWhereItRuns = (node: ts.Node): boolean => node.getText().includes('desktopOnlyHere(');

/** `if (… desktopOnlyHere() …) return …` as a statement of this function, before the call. */
function returnsEarlyInBrowser(fn: ts.Node, before: number): boolean {
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (!body || !ts.isBlock(body)) return false;
  return body.statements.some(
    (statement) =>
      statement.end <= before &&
      ts.isIfStatement(statement) &&
      asksWhereItRuns(statement.expression) &&
      (ts.isReturnStatement(statement.thenStatement) ||
        (ts.isBlock(statement.thenStatement) && statement.thenStatement.statements.some(ts.isReturnStatement))),
  );
}

function callSites(file: string): CallSite[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const relative = path.relative(RENDERER_ROOT, file).split(path.sep).join('/');
  const sites: CallSite[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && DESKTOP_ONLY_METHODS.has(node.name.text)) {
      const functions: ts.Node[] = [];
      let insideDesktopOnly = false;
      let statementInOutermost: ts.Node = node;
      for (let up: ts.Node = node; up.parent; up = up.parent) {
        if (isFunction(up)) functions.push(up);
        if ((ts.isJsxElement(up) && up.openingElement.tagName.getText() === 'DesktopOnly') || (ts.isJsxSelfClosingElement(up) && up.tagName.getText() === 'DesktopOnly')) {
          insideDesktopOnly = true;
        }
      }
      // The outermost function is the component or the hook. A guard somewhere else in it says nothing
      // about this call, so there only two things count: it has returned before the call is reached, or
      // the call stands directly in a statement of it that asks (`const canDrag = !desktopOnlyHere() && …`).
      const outermost = functions[functions.length - 1];
      if (outermost) {
        for (let up: ts.Node = node; up.parent && up !== outermost; up = up.parent) {
          if (ts.isBlock(up.parent) && up.parent.parent === outermost) statementInOutermost = up;
        }
      }
      const inner = functions.slice(0, -1);
      const decided =
        insideDesktopOnly ||
        inner.some(asksWhereItRuns) ||
        (outermost !== undefined && returnsEarlyInBrowser(outermost, node.getStart())) ||
        (functions.length <= 1 && statementInOutermost !== node && !ts.isReturnStatement(statementInOutermost) && asksWhereItRuns(statementInOutermost));
      const owner = functions.map(nameOf).find(Boolean) ?? '(top of file)';
      sites.push({
        file: relative,
        line: source.getLineAndCharacterOfPosition(node.name.getStart()).line + 1,
        method: node.name.text,
        owner,
        decided,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

const ALL_SITES = sourceFiles(RENDERER_ROOT).flatMap(callSites);

/**
 * Calls that are fine as they are, by `file` (everything in it) or `file > function`. Each says why the
 * call cannot be reached in the browser.
 */
const FINE_AS_THEY_ARE: Record<string, string> = {
  // Windows and sections that somebody else draws inside one DesktopOnly group, as a whole.
  'components/K8s/K8sPortForwardModal.tsx':
    'Every control of the port forward window sits in its DesktopOnly group, and nothing in the cluster tree opens the window in the browser.',
  'components/SSH/SSHTunnelsModal.tsx': 'Every control of the tunnels window sits in its DesktopOnly group.',
  'components/SSH/SSHGlobalTunnelsModal.tsx': 'Every control of the window with all tunnels sits in its DesktopOnly group.',
  'components/SSH/SSHTunnelWizard.tsx':
    'Drawn only after "Add tunnel" or "Edit" was pressed in a tunnels window, and both buttons sit in its DesktopOnly group.',
  'components/SettingsModal/GitSettingsPanel.tsx':
    'The settings window draws the whole panel inside DesktopOnly. What it asks when it opens checks for itself.',
  'components/SettingsModal/SshCaDetectSection.tsx': 'Part of the SSH CA settings, which the security settings draw inside DesktopOnly.',
  'components/SettingsModal/SshCaVaultDetectSection.tsx': 'Part of the SSH CA settings, which the security settings draw inside DesktopOnly.',
  'components/SettingsModal/useSettingsForm.ts > handleStartX11': 'Pressed in the X11 server section only, which the terminal settings draw inside DesktopOnly.',
  'components/SettingsModal/useSettingsForm.ts > handleStopX11': 'Pressed in the X11 server section only, which the terminal settings draw inside DesktopOnly.',
  'components/SettingsModal/GeneralSettingsSection.tsx > copyDiagnostics': '"Copy diagnostics" sits in a DesktopOnly group, next to "Open log folder".',

  // Buttons that sit in a DesktopOnly group of their own.
  'components/ConnectionModal/ConnectionManagerModal.tsx > handleImportSshConfig': 'The import and export menu sits in a DesktopOnly group.',
  'components/ConnectionModal/ConnectionManagerModal.tsx > handleExportJson': 'The import and export menu sits in a DesktopOnly group.',
  'components/ConnectionModal/ConnectionManagerModal.tsx > handleImportJson': 'The import and export menu sits in a DesktopOnly group.',
  'components/ConnectionModal/S3ProfileForm.tsx > handleAwsSsoLogin': 'The sign-in button sits in a DesktopOnly group.',
  'components/ConnectionModal/S3ProfileForm.tsx > handleSelectAccount': 'The list of accounts is drawn only after a sign-in, and none can start in the browser.',
  'components/SettingsModal/SyncTargetForm.tsx > handleAwsSsoLogin': 'The sign-in button sits in a DesktopOnly group.',
  'components/SettingsModal/SyncTargetForm.tsx > handleSelectAccount': 'The list of accounts is drawn only after a sign-in, and none can start in the browser.',
  'components/ConnectionModal/SSHProfileForm.tsx > deleteFido2ResidentKey': 'The security key block is drawn inside DesktopOnly.',
  'components/ConnectionModal/SSHProfileForm.tsx > generateFido2Key': 'The security key block is drawn inside DesktopOnly.',
  'components/FileManager/FilePane.tsx > handleSsoRelogin': '"Sign in again" sits in a DesktopOnly group.',
  'components/SettingsModal/TeamVaultListPanel.tsx > handleEnroll': 'Both "Generate my Team Vault ID" buttons sit in a DesktopOnly group.',
  'components/SettingsModal/TeamVaultListPanel.tsx > handleDecodeInvite': '"Read invite" sits in a DesktopOnly group.',
  'components/SettingsModal/TeamVaultListPanel.tsx > handleConfirmJoin': 'Reached only after an invite was read, and "Read invite" sits in a DesktopOnly group.',

  // Controls that are not drawn in the browser at all.
  'App.tsx > AppContent': 'The lock button of the top bar: showLockSmartcardButton is false in the browser, so the top bar never calls these.',
  'components/ConnectionModal/ConnectionManagerModal.tsx > handleUnlockAllTeams': '"Unlock all" is not drawn in the browser.',
  'components/ConnectionModal/TeamProfileTreeList.tsx > handleUnlock': 'Neither unlock form of a locked team is drawn in the browser. A line says where the vault opens instead.',
  'components/SettingsModal/TeamVaultDetailPanel.tsx > handleUnlock': 'Neither unlock form is drawn in the browser (cardHere). The recovery key is offered instead.',
  'components/SettingsModal/TeamVaultListPanel.tsx > handleQuickUnlock': 'The quick unlock button of a team row is not drawn in the browser.',
  'components/SettingsModal/SyncSettingsPanel.tsx': 'Link, unlink and unlock with a card: none of these controls is drawn in the browser (cardHere).',
  'components/FileManager/FilePane.tsx > handleOpenExternal': 'Not handed to the right-click menu in the browser, so the menu has no such item.',
  'components/FileManager/FileEditorModal.tsx':
    'Another program is started by handleOpenExternal only, and none of its four buttons is drawn in the browser (canOpenExternal). The other calls close what it started.',
  'components/FileManager/DragOutDialog.tsx': 'Opened from the file pane and from the path card of a terminal only, and neither offers it in the browser.',
  'components/TerminalPathHoverCard.tsx > handleDragStart': 'Attached only when canDragOut is true, which it never is in the browser.',
  'components/UnconnectedPanePlaceholder.tsx > openElevated': 'The shield button is not drawn in the browser.',

  // Hooks whose callers do not offer the action in the browser.
  'lib/useSshCa.ts':
    'Signing in, signing out and renewing run from the SSH CA badge of the top bar and from the SSH CA settings only. The badge is not drawn in the browser and the settings are inside DesktopOnly.',
  'lib/useOpenShiftWebLogin.ts': 'The hook of the Kubernetes sign-in window, where browser sign-in is switched off in the browser and says why.',
  'lib/usePortDetection.ts > usePortDetection': 'Stops the tunnels this hook started when the terminal closes. It starts none in the browser.',

  // Shown only while something runs that cannot start in the browser.
  'components/AwsSsoLoginModal.tsx > handleCancel': 'The window is shown while an AWS SSO sign-in waits for its page, and no sign-in can start in the browser.',
};

describe('renderer calls to channels that work in the desktop app only', () => {
  it('reaches every desktop-only channel through one method of the bridge', () => {
    const reached = new Set([...DESKTOP_ONLY_METHODS.values()].flat());
    expect([...DESKTOP_ONLY_CHANNELS].filter((channel) => !reached.has(channel)).sort()).toEqual([]);
    // One channel each: a method that called two could not be told apart by its name.
    expect([...DESKTOP_ONLY_METHODS].filter(([, channels]) => channels.length !== 1)).toEqual([]);
  });

  it('finds the calls it is meant to find', () => {
    expect(ALL_SITES.length).toBeGreaterThan(60);
    const found = new Set(ALL_SITES.map((site) => site.method));
    for (const method of ['sshTunnelStart', 'awsSsoLogin', 'teamVaultUnlock', 'dragOutStart', 'windowNew', 'perfLocalSample']) {
      expect(found.has(method), method).toBe(true);
    }
  });

  it('has decided on every call: it asks where it runs, is drawn inside DesktopOnly, or is in the list with a reason', () => {
    const undecided = ALL_SITES.filter((site) => !site.decided && !(site.file in FINE_AS_THEY_ARE) && !(`${site.file} > ${site.owner}` in FINE_AS_THEY_ARE));
    expect(undecided.map((site) => `${site.file} > ${site.owner}: ${site.method} (line ${site.line})`)).toEqual([]);
  });

  it('has no entry in the list that matches nothing, and every entry says why', () => {
    const open = ALL_SITES.filter((site) => !site.decided);
    const used = new Set(open.flatMap((site) => [site.file, `${site.file} > ${site.owner}`]));
    expect(Object.keys(FINE_AS_THEY_ARE).filter((key) => !used.has(key))).toEqual([]);
    for (const [key, reason] of Object.entries(FINE_AS_THEY_ARE)) expect(reason.length, key).toBeGreaterThan(20);
  });
});

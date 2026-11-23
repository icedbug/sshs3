/**
 * Which IPC channels a signed-in web client may call.
 *
 * The desktop window and the web client share one set of handlers, and on the desktop the caller owns
 * the machine. On a web server the caller is one account among several and the machine is the
 * server's, so every channel is in exactly one of three lists here, and a channel in none of them is
 * refused. A new handler therefore reaches no web client until somebody has put it in a list:
 * tests/main/webIpcAllowlist.test.ts fails while a registered handler is in none.
 *
 * - WEB_ALLOWED_CHANNELS: the handler runs. It works on the account's own stores and folder only (see
 *   web/tenantBoundary.ts and the handler itself).
 * - WEB_FIXED_ANSWERS: the page asks these when it loads, and the honest answer on a server is always
 *   the same ("no card reader here"). The answer is given here and the handler never runs.
 * - DESKTOP_ONLY_CHANNELS: refused. They read or write a path the caller names, start a program on the
 *   machine, show a window or a dialog there, or change the settings of the user the app runs as.
 */

/** The message a web client gets for a channel it may not call. */
export const WEB_CHANNEL_REFUSED = 'This is not available on the sshs3 web server. It works in the desktop app.';

export const WEB_ALLOWED_CHANNELS: ReadonlySet<string> = new Set([
  // The AI hub: one channel, the hub checks each action itself.
  'ai-hub:request',

  // About the app. "Home" is the account's own files folder (generalHandlers).
  'app:get-homedir',
  'app:get-hostname',
  'app:get-platform',
  'app:get-security-status',
  'app:get-version',
  // Opens nothing on a server: the stand-in for Electron's shell does nothing.
  'app:open-external',
  'policy:get',
  'update:get-state',

  // Answers to questions the server asked this client (ids are random and belong to the account's own bridge).
  'app:quit-confirm-respond',
  'askpass:submit-pin',
  'dotfiles:sync-respond',
  'hostkey:respond',
  'insert-token:cancel',
  'transfer:conflict-respond',

  // Dialogs: nothing is shown on a server, the answer is "cancelled".
  'dialog:open-file',
  'dialog:open-folder',
  'dialog:save-file',

  // The account's own saved data, each in a file of its own folder.
  'clipboardHistory:add',
  'clipboardHistory:clear',
  'clipboardHistory:delete',
  'clipboardHistory:list',
  'session:get',
  'session:save',
  'settings:get',
  'settings:save',
  'settings:set-team-vault-tab-visible',
  'snippets:delete',
  'snippets:list',
  'snippets:save',
  'window:list',
  'window:take-handoff',

  // Saved servers and buckets. Shared servers follow the hub's rules; a key file must be the account's own.
  'profiles:delete-folder',
  'profiles:delete-s3',
  'profiles:delete-ssh',
  'profiles:get',
  'profiles:rename-folder',
  'profiles:save-folder',
  'profiles:save-s3',
  'profiles:save-ssh',

  // Terminals to the account's servers. There is no shell on the server itself (terminalHandlers, SSHPtyManager).
  'terminal:attach',
  'terminal:create',
  'terminal:getCwd',
  'terminal:hasSshClient',
  'terminal:kill',
  'terminal:reconnect',
  'terminal:resize',
  'terminal:write',
  'perf:ssh-sample',
  'ssh-tunnel:list',

  // Files. "Local" is the account's own folder and nothing outside it (LocalStorageProvider, confined);
  // everything else is a server or bucket the account connected to.
  'archive:compress',
  'archive:extract',
  'certificate:preview',
  'dirsync:apply',
  'dirsync:compute-diff',
  'dirsync:profile-delete',
  'dirsync:profile-list',
  'dirsync:profile-save',
  'file:read',
  'file:save',
  'file:tail:start',
  'file:tail:stop',
  'search:cancel',
  'search:preview',
  'search:start',
  'storage:chmod',
  'storage:connect',
  'storage:create-file',
  'storage:create-folder',
  'storage:delete',
  'storage:delete-object-version',
  'storage:disconnect',
  'storage:get-bucket-cors',
  'storage:get-bucket-policy',
  'storage:get-bucket-versioning',
  'storage:get-homedir',
  'storage:get-presigned-url',
  'storage:get-space',
  'storage:get-tags',
  'storage:get-win-attributes',
  'storage:list',
  'storage:list-object-versions',
  'storage:list-volumes',
  'storage:lookup',
  'storage:rename',
  'storage:restore-object-version',
  'storage:set-bucket-cors',
  'storage:set-bucket-policy',
  'storage:set-bucket-versioning',
  'storage:set-metadata',
  'storage:set-tags',
  'storage:set-win-attributes',
  'storage:stat',
  'transfer:add',
  'transfer:cancel',
  'transfer:clear-completed',
  'transfer:get-jobs',
  'transfer:pause',
  'transfer:resume',

  // Connection tests and key installation, as the account's own connection (IpcBridge.confineSshConfig).
  'connection:test-s3',
  'connection:test-ssh',
  'ssh:build-install-command',
  'ssh:install-public-keys',
  'ssh:list-public-keys',
  'ssh:probe-host',
  'ssh:test-login',

  // Git on a connected server. On the server's own disk it is refused in the handler (gitHandlers).
  'git:clone',
  'git:fetch-public-keys',
  'git:get-status',
  'git:pull',
  'git:test-remote-access',

  // Dotfile pools: the account's own store. Reading local source paths is desktop only (below).
  'dotfiles:add-from-storage',
  'dotfiles:pools-delete',
  'dotfiles:pools-get',
  'dotfiles:pools-save',

  // Kubernetes, with the account's own kubeconfig and never the server's (services/k8sKubeConfig.ts).
  'k8s-log:start',
  'k8s-log:stop',
  'k8s-port-forward:list',
  'k8s-terminal:create',
  'k8s-terminal:kill',
  'k8s-terminal:resize',
  'k8s-terminal:write',
  'k8s:debug-attach',
  'k8s:list-contexts',
  'k8s:list-namespaces',
  'k8s:list-pods',
  'k8s:login',
  'k8s:openshift-probe',
  'k8s:pod-delete',
  'k8s:pod-describe',
  'k8s:profiles-delete',
  'k8s:profiles-list',
  'k8s:profiles-save',
  'k8s:reload',
  'perf:k8s-sample',

  // Profile sync to the account's own target, with a password. Unlocking with a smartcard is desktop only.
  'profile-sync:compare',
  'profile-sync:enable',
  'profile-sync:pull',
  'profile-sync:push',
  'profile-sync:set-auto-sync',
  'profile-sync:setup',
  'profile-sync:status',
  'profile-sync:wipe',

  // Team Vault: kept under the account's own folder. Opened with its recovery key here; opening it
  // with a smartcard is desktop only (below).
  'team-vault:add-member',
  'team-vault:build-invite',
  'team-vault:create',
  'team-vault:delete',
  'team-vault:delete-folder',
  'team-vault:delete-k8s-profile',
  'team-vault:delete-s3-profile',
  'team-vault:delete-ssh-profile',
  'team-vault:forget',
  'team-vault:get-payload',
  'team-vault:get-status',
  'team-vault:get-sync-preview',
  'team-vault:has-remote-vault',
  'team-vault:list',
  'team-vault:lock',
  'team-vault:pull',
  'team-vault:push',
  'team-vault:remove-member',
  'team-vault:rename',
  'team-vault:rename-folder',
  'team-vault:save-folder',
  'team-vault:save-k8s-profile',
  'team-vault:save-s3-profile',
  'team-vault:save-ssh-profile',
  'team-vault:set-description',
  'team-vault:set-folder-icon',
  'team-vault:set-role',
  'team-vault:set-target',
  'team-vault:test-target',
  'team-vault:unlock-with-recovery-text',

  // The account's own status with a certificate authority. Signing in to one is desktop only (below).
  'ssh-ca:get-status',

  // From the page to the server's log, limited in length and rate (logHandlers).
  'log:write',
]);

/** Channels the web layer answers itself, always the same way. The handler behind them never runs for a web client. */
export const WEB_FIXED_ANSWERS: ReadonlyMap<string, () => unknown> = new Map<string, () => unknown>([
  // The shells of the server are not the account's to open.
  ['app:detect-local-shells', () => ({ pwsh: false, wsl: false, wslDistros: [] })],
  // A card reader on the server is the server's. The page asks these three when it loads.
  ['smartcard:detect', () => []],
  ['smartcard:list-cached', () => []],
  ['smartcard:unlock-at-startup', () => ({ started: false })],
  // No X server is started or looked for on the server, and X11 forwarding is off for a web terminal.
  // The settings and the server form ask these when they open.
  ['app:check-x11-server', () => ({ running: false, display: '' })],
  ['x11:get-status', () => ({ available: false, running: false, managedByApp: false, display: '' })],
]);

export const DESKTOP_ONLY_CHANNELS: ReadonlySet<string> = new Set([
  // Reads any path the caller names, up to 1 MB each: the server's keys and every account's files.
  'dotfiles:read-sources',
  // Opens a folder or a file picker on the machine, then reads what was picked.
  'dotfiles:open-folder',
  'dotfiles:select-files',
  // Clones with the git and the ssh identity of the user the app runs as.
  'dotfiles:import-from-git',

  // The git settings and signing keys of the user the app runs as.
  'git:configure-signing',
  'git:get-signing-config',
  'git:set-signing-enabled',

  // Reads the ~/.ssh/config of the user the app runs as; reads or writes a file chosen in a dialog.
  'profiles:export-json',
  'profiles:import-json',
  'profiles:import-ssh-config',

  // Programs and windows on the machine itself.
  'app:open-elevated-shell',
  'drag-out:prepare',
  'drag-out:start',
  'file:close-external',
  'file:open-external',
  'log:open-folder',
  'window:move-tab',
  'window:new',
  'x11:start-server',
  'x11:stop-server',

  // The server's own log (it names other accounts' hosts) and the server's own load.
  'log:get-diagnostics',
  'perf:local-sample',

  // Updating the app is the server administrator's, with a new image or package.
  'update:check',
  'update:download',
  'update:install',

  // Smartcards and security keys: the reader, the PKCS#11 library and the ssh agent would be the server's.
  'fido2:delete-resident-key',
  'fido2:generate-key',
  'fido2:list-resident-keys',
  'profile-sync:link-smartcard',
  'profile-sync:unlink-smartcard',
  'profile-sync:unlock-smartcard',
  'smartcard:agent-path-fix',
  'smartcard:agent-path-status',
  'smartcard:lock-all',
  'smartcard:unlock-now',
  'smartcard:validate',
  'ssh:agent-status',
  // Team Vault with a smartcard: the card is read on the machine, and the identity file is a path the caller names.
  'team-vault:decode-invite',
  'team-vault:enroll-recipient',
  'team-vault:unlock',

  // Sign-in flows that open a browser on the machine and wait for it on a local port.
  'k8s:openshift-web-login',
  'k8s:openshift-web-login-cancel',
  'ssh-ca:detect',
  'ssh-ca:detect-vault',
  'ssh-ca:login',
  'ssh-ca:logout',
  'ssh-ca:renew',

  // AWS SSO keeps its sign-in in the home folder of the user the app runs as: one for every account.
  'aws-sso:list-accounts',
  'aws-sso:list-roles',
  'aws-sso:login',
  'aws-sso:login-cancel',
  'aws-sso:relogin-provider',

  // Listening ports on the machine, and a way from another host into the machine's own network.
  'k8s-port-forward:reconnect',
  'k8s-port-forward:start',
  'k8s-port-forward:stop',
  'ssh-tunnel:check-port',
  'ssh-tunnel:start',
  'ssh-tunnel:stop',
]);

export type WebChannelKind = 'allowed' | 'fixed' | 'desktop-only' | 'unlisted';

export function webChannelKind(channel: string): WebChannelKind {
  if (WEB_ALLOWED_CHANNELS.has(channel)) return 'allowed';
  if (WEB_FIXED_ANSWERS.has(channel)) return 'fixed';
  if (DESKTOP_ONLY_CHANNELS.has(channel)) return 'desktop-only';
  return 'unlisted';
}

/** The registered channels that are in none of the three lists, sorted. Empty when every handler was decided on. */
export function unlistedChannels(registered: Iterable<string>): string[] {
  return [...registered].filter((channel) => webChannelKind(channel) === 'unlisted').sort();
}

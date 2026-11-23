// What the hub is given by whatever runs it (the desktop app, the web server, a test): moved here from HubService.ts as it was.
import type {
  AgentChange,
  AgentSchedule,
  AgentTask,
  MemoryEntry,
  PeerApprovalItem,
  S3WorkspaceConfig,
  WorkspaceActivityEvent,
  WorkspaceServerSummary,
} from "../../../shared/types/aiHub";
import type { AiHubDeltaEvent } from "../../../shared/ipc/createMultiSSHApi";
import type { IStorageProvider } from "../../../shared/types/storage";
import { ChatBridge } from "./ChatBridge";
import { type ToolDependencies } from "./ToolBroker";
import { type InventoryTarget } from "./ContextService";
import { type AuditShipperOptions } from "./AuditLog";
import { type ConditionalQueueStore } from "./WorkSync";

export interface HubHost {
  /**
   * On a web server: the account's own kubeconfig. When it is set, a Kubernetes tool reads this file and
   * nothing a request or the model names instead.
   */
  accountKubeConfigPath?: string;
  /** Optional host admission check, run synchronously before spending an action. */
  beforeAction?(task: AgentTask): void;
  /** Optional counter for a model request, including a retry, without its contents. */
  onModelRequest?(): void;
  /**
   * The team's chat bot, when the host keeps one for several hubs: on a shared
   * server every account's hub is given the same one, so there is one reader
   * and one index. Without it the hub keeps its own.
   */
  teamChat?: ChatBridge;
  changed(): void;
  delta?(delta: AiHubDeltaEvent): void;
  restoreCheckpoint?: (
    change: AgentChange,
    options?: { task?: AgentTask; path?: string; force?: boolean; recheck?: () => void },
  ) => Promise<{
    restored: boolean;
    alreadyAtCheckpoint?: boolean;
    path: string;
    hash: string;
    beforeHash: string;
  }>;
  auditShipper?: AuditShipperOptions;
  inventoryTargets(): Promise<InventoryTarget[]>;
  /**
   * Opens a terminal of the hub's own on a saved target (or "local") and
   * registers it under `label`. It is not connected to yet: the hub does that
   * once the prompt is there (`openUnattendedTerminal`).
   */
  openSchedule(target: Pick<AgentSchedule, "profileId" | "shell">, label: string): Promise<string>;
  /** Closes a terminal the hub opened for itself (an investigator's). */
  closeSession?(sessionId: string): void;
  /**
   * Whether the process behind a terminal is still there. False: it is gone
   * and the terminal was not told (no exit was reported for it). Undefined
   * when the host cannot say; such a terminal is left as it is.
   */
  sessionAlive?(sessionId: string): boolean | undefined;
  backgroundChanged(background: boolean, autoStart: boolean): Promise<void>;
  show(): void;
  /**
   * Desktop only: asks the user to confirm, then restarts sshs3 with demo mode on or off (demo mode never
   * changes inside a running process). Resolves false when the user declines. Absent in web mode, where
   * demo mode is fixed when the server starts.
   */
  relaunchForDemoMode?(demoMode: boolean): Promise<boolean>;
  file?: ToolDependencies["file"];
  workspaceServers?(): Promise<WorkspaceServerSummary[]>;
  getTeamWorkspaceData?(): Promise<{
    memories: MemoryEntry[];
    activityLog: WorkspaceActivityEvent[];
    actor?: string;
  }>;
  recordWorkspaceActivity?(event: WorkspaceActivityEvent): Promise<void>;
  saveWorkspaceMemory?(entry: MemoryEntry): Promise<void>;
  deleteWorkspaceMemory?(id: string): Promise<void>;
  describeServer?(input: {
    profileId: string;
    shared?: boolean;
    cluster?: string;
    nodeRole?: string;
    description?: string;
    role?: string;
    tags?: string[];
    /** Who makes the change: stored with the server as "updated by". */
    updatedBy?: string;
  }): Promise<void>;
  upsertServer?(input: {
    id?: string;
    name: string;
    host: string;
    port?: number;
    username: string;
    authType?: WorkspaceServerSummary["authType"];
    privateKeyPath?: string;
    pkcs11LibPath?: string;
    fido2Resident?: boolean;
    proxyJump?: string;
    proxyJumpProfileId?: string;
    forwardAgent?: boolean;
    x11Forwarding?: boolean;
    x11Display?: string;
    compression?: boolean;
    serverAliveInterval?: number;
    initialPath?: string;
    poolId?: string;
    dotfilesSyncPolicy?: "ask" | "always";
    autoReconnect?: boolean;
    maxReconnectAttempts?: number;
    reconnectDelayMs?: number;
    extraOptions?: Record<string, string>;
    tunnels?: WorkspaceServerSummary["tunnels"];
    folder?: string;
    cluster?: string;
    nodeRole?: string;
    role?: string;
    description?: string;
    tags?: string[];
    shared?: boolean;
    /** Who makes the change: stored with the server as "updated by". */
    updatedBy?: string;
  }): Promise<WorkspaceServerSummary>;
  deleteServer?(profileId: string): Promise<void>;
  syncSharedServersFromS3?(
    servers: WorkspaceServerSummary[],
    deletedServerIds: Record<string, string>,
  ): Promise<void>;
  s3ProviderFactory?: (cfg: S3WorkspaceConfig) => IStorageProvider;
  aiConfigFilePath?: string;
  s3ConfigFilePath?: string;
  defaultActorName?: string;
  /** On the web server: the user id that goes in front of the alert hook's secret in its address. */
  alertHookOwner?: string;
  /** On the web server: whether this user administers it. Absent on the desktop, where the one user does. */
  teamAdmin?: () => boolean;
  /** On the web server: whether this user's account is the only one there is, and administers it. */
  soleUser?: () => boolean;
  /**
   * On the web server: whether a change that needs two people can be put to another signed-in member,
   * who answers through approveAsPeer(). Absent (the desktop app, a server that does not route
   * approvals between accounts): only one person can approve here, and nothing asks for two.
   */
  peerApproval?: (tags?: string[], task?: Pick<import("../../../shared/types/aiHub").AgentTask, "chat">) => boolean;
  peerStillEligible?: (actorId: string, tags: string[]) => boolean;
  /**
   * On the web server: the changes in other members' runs that wait for a second person and that this
   * member may answer (the server has checked that they may).
   */
  peerWaiting?: () => PeerApprovalItem[];
  /** On the web server: this member's answer to one of them. Refused, in words, when it is not theirs to give. */
  peerDecide?: (answer: { ownerId: string; taskId: string; changeId: string; approved: boolean; note?: string }) => Promise<void>;
  /** On the web server: this hub's own changes that wait for a second person are not the same as a moment ago; the other members are told. */
  peerWaitingChanged?: () => void;
  /**
   * On the web server: the rules its administrator set for everyone. Read from memory (every account's
   * hub runs in the one server); a write is kept in the server's shared folder and the others are told.
   */
  teamRules?: {
    read(): import("../../../shared/types/aiHub").TeamSafetyRules;
    write(next: import("../../../shared/types/aiHub").TeamSafetyRules, previous?: import("../../../shared/types/aiHub").TeamSafetyRules): Promise<void>;
  };
  /**
   * On the web server: this hub is an account the server keeps for itself (the chat agent), not a
   * person's. It says nothing about who is here: no presence of its own, and no terminals shown as a
   * person's.
   */
  serviceAccount?: boolean;
  /**
   * On the web server: the agent bot in chat, as this person may see and change it. The server keeps it
   * for everyone (WebTenantManager), so these requests are answered there, never in this hub.
   */
  chatAnswering?: {
    view(): Promise<import("../../../shared/types/aiHub").ChatAnsweringSnapshot | undefined>;
    request(request: import("../../../shared/types/aiHub").ChatAnsweringRequest): Promise<import("../../../shared/types/aiHub").HubReply | undefined>;
  };
  peerPresenceProvider?:() => import("../../../shared/types/aiHub").WorkspacePresenceEntry[];
  onSharedWorkspaceChanged?: () => void;
  /**
   * On a server several people share: the folder of the server's own where the team's board is kept
   * when the team has no bucket (see FileQueueStore). Every account's hub is given the same one, so
   * everyone on the server has one board, one set of agents and one knowledge base. A bucket, when one
   * is connected, is used instead.
   */
  sharedWorkStore?: ConditionalQueueStore;
  extraAppContext?(): Promise<{
    folders: string[];
    s3Profiles: Array<{
      id: string;
      name: string;
      endpoint?: string;
      region?: string;
      bucket?: string;
      group?: string;
      authMethod?: string;
      awsProfile?: string;
    }>;
    snippets: unknown[];
    dotfilesPools?: unknown[];
    dirSyncProfiles?: unknown[];
    activeTunnels?: unknown[];
    appSettings: Record<string, unknown>;
  }>;
  manageFolders?(input: {
    operation: "create_folder" | "rename_folder" | "delete_folder";
    folderName: string;
    newFolderName?: string;
  }): Promise<unknown>;
  manageS3Profile?(input: {
    operation:
      | "upsert_s3_profile"
      | "delete_s3_profile"
      | "list_dir_sync_profiles"
      | "save_dir_sync_profile"
      | "delete_dir_sync_profile";
    idOrName?: string;
    name?: string;
    endpoint?: string;
    region?: string;
    bucket?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle?: boolean;
    group?: string;
    authMethod?: "accessKey" | "awsProfile" | "awsSso";
    awsProfile?: string;
    sourceProviderId?: string;
    sourcePath?: string;
    targetProviderId?: string;
    targetPath?: string;
    deleteExtraneous?: boolean;
  }): Promise<unknown>;
  manageAppSettings?(input: {
    operation:
      | "get_state"
      | "update_settings"
      | "update_shortcuts"
      | "list_dotfiles"
      | "save_dotfile"
      | "delete_dotfile"
      | "list_snippets"
      | "save_snippet"
      | "delete_snippet"
      | "open_local_terminal";
    settings?: Record<string, unknown>;
    shortcuts?: Record<string, string>;
    resetShortcuts?: boolean;
    dotfile?: {
      poolId?: string;
      poolName?: string;
      remotePath?: string;
      content?: string;
      mode?: string;
      deletePool?: boolean;
    };
    snippet?: {
      id?: string;
      name?: string;
      command?: string;
      category?: string;
    };
  }): Promise<unknown>;
  openServerTerminal?(profileId: string): Promise<string>;
  /**
   * Runs a script on a server and returns what it printed, without a terminal:
   * over the connection of an open tab where there is one, otherwise over a
   * connection of its own that never prompts. "local" is this computer.
   */
  execOnServer?(
    profileId: string,
    script: string,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; stdout: string; error?: string; via: "open-tab" | "own-connection" | "local" }>;
  resolveStorageProvider?(targetRef: string): Promise<IStorageProvider | undefined>;
  storageOps?(input: {
    operation: "list_files" | "read_remote_file" | "diff_paths";
    targetA: string;
    pathA: string;
    targetB?: string;
    pathB?: string;
  }): Promise<unknown>;
  restoreBuiltinSnippets?(): Promise<number>;
}

import { LocalStorageProvider } from './LocalStorageProvider';
import { SFTPStorageProvider } from './SFTPStorageProvider';
import { S3StorageProvider } from './S3StorageProvider';
import { K8sPodStorageProvider } from './K8sPodStorageProvider';
import { DemoStorageProvider } from './DemoStorageProvider';
import { isDemoMode } from '../ai/hub/demoWorkspace';
import type { IStorageProvider, SFTPConfig } from '../../shared/types/storage';
import type { StorageConnectConfig } from '../../shared/types/ipc';
import type { SshHostVerifier } from '../ssh/HostKeyVerifier';

export interface StorageRegistryOptions {
  /** Builds the SFTP host-key verifier used for a given host/port, e.g. wired to a TOFU prompt. */
  sftpHostVerifierFactory?: (host: string, port: number) => SshHostVerifier;
  /** Builds the PIN/passphrase prompt handler (renderer modal) for an SFTP connection. */
  /** Touch-your-key banner hooks for an SFTP connection. */
  sftpPresenceFactory?: (config: SFTPConfig) => { onPresence: () => void; onPresenceCleared: () => void };
  sftpPinPromptHandlerFactory?: (config: SFTPConfig) => (prompt: string) => Promise<string> | string;
}

export class StorageRegistry {
  private providers: Map<string, IStorageProvider> = new Map();
  private options: StorageRegistryOptions;

  constructor(options: StorageRegistryOptions = {}) {
    this.options = options;
  }

  /**
   * Returns an existing provider or instantiates and stores a new one.
   */
  public async getOrCreate(config: StorageConnectConfig): Promise<IStorageProvider> {
    if (!config || !config.id) {
      throw new Error('Storage config must have an id');
    }

    const existing = this.providers.get(config.id);
    if (existing) {
      return existing;
    }

    let provider: IStorageProvider;

    switch (config.type) {
      case 'local': {
        provider = new LocalStorageProvider({
          id: config.id,
          name: config.name || 'Local Storage',
          basePath: config.localBasePath,
        });
        break;
      }
      case 'sftp': {
        if (!config.sftpConfig) {
          throw new Error(`SFTP config is required for provider "${config.id}"`);
        }
        if (
          isDemoMode() &&
          (config.id.includes('demo-') || config.sftpConfig.host.startsWith('10.30.'))
        ) {
          provider = new DemoStorageProvider({
            id: config.id,
            name: config.name || config.sftpConfig.name || config.sftpConfig.host,
            type: 'sftp',
            hostOrBucket: config.sftpConfig.name || config.sftpConfig.host,
          });
          break;
        }
        const port = config.sftpConfig.port ?? 22;
        const hostVerifier = this.options.sftpHostVerifierFactory?.(config.sftpConfig.host, port);
        provider = new SFTPStorageProvider(
          {
            ...config.sftpConfig,
            id: config.id,
            name: config.name || config.sftpConfig.name,
          },
          undefined,
          hostVerifier,
          this.options.sftpPinPromptHandlerFactory?.(config.sftpConfig),
          this.options.sftpPresenceFactory?.(config.sftpConfig)
        );
        break;
      }
      case 's3': {
        if (!config.s3Config) {
          throw new Error(`S3 config is required for provider "${config.id}"`);
        }
        if (
          isDemoMode() &&
          (config.id.includes('demo-') ||
            (config.s3Config.endpoint &&
              (config.s3Config.endpoint.includes('acme.se') ||
                config.s3Config.endpoint.includes('10.30.'))))
        ) {
          provider = new DemoStorageProvider({
            id: config.id,
            name: config.name || config.s3Config.name || 'Demo S3 Bucket',
            type: 's3',
            hostOrBucket: config.s3Config.initialPath || config.s3Config.name,
          });
          break;
        }
        provider = new S3StorageProvider({
          ...config.s3Config,
          id: config.id,
          name: config.name || config.s3Config.name,
        });
        break;
      }
      case 'k8s': {
        if (!config.k8sConfig) {
          throw new Error(`Kubernetes storage config is required for provider "${config.id}"`);
        }
        provider = new K8sPodStorageProvider(config.k8sConfig);
        break;
      }
      default: {
        throw new Error(`Unsupported storage type: ${(config as any).type}`);
      }
    }

    this.providers.set(config.id, provider);
    return provider;
  }

  /**
   * Retrieves a provider by id.
   */
  public get(id: string): IStorageProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * Checks if a provider exists.
   */
  public has(id: string): boolean {
    return this.providers.has(id);
  }

  /**
   * Registers a provider directly (useful for tests or custom providers).
   */
  public register(provider: IStorageProvider): void {
    if (!provider || !provider.id) {
      throw new Error('Provider must have an id');
    }
    this.providers.set(provider.id, provider);
  }

  /**
   * Returns all active providers.
   */
  public getAll(): IStorageProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Disconnects and removes a single provider.
   */
  public async disconnect(id: string): Promise<void> {
    const provider = this.providers.get(id);
    if (!provider) return;

    if (typeof provider.disconnect === 'function') {
      try {
        await provider.disconnect();
      } catch {
        // Ignore disconnect errors during cleanup
      }
    }

    this.providers.delete(id);
  }

  /**
   * Disconnects and cleans up all active providers.
   */
  public async disconnectAll(): Promise<void> {
    const allProviders = Array.from(this.providers.values());
    for (const provider of allProviders) {
      if (typeof provider.disconnect === 'function') {
        try {
          await provider.disconnect();
        } catch {
          // Ignore disconnect errors
        }
      }
    }
    this.providers.clear();
  }
}

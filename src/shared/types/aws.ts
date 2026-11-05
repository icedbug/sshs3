import type { ProxyConfig } from './storage';

/** Prefix of the file-pane error for a lapsed SSO session; the pane keys on it to offer "Sign in again". */
export const AWS_SSO_EXPIRED_PREFIX = 'AWS SSO session expired';

/** Prefix when an SSO profile could not obtain credentials for another reason (proxy, network, rejected token). */
export const AWS_SSO_CREDENTIALS_PREFIX = 'AWS SSO credentials unavailable';

/** True for a pane error that should offer "Sign in again". */
export function offersAwsSsoSignIn(message: string): boolean {
  return message.startsWith(AWS_SSO_EXPIRED_PREFIX) || message.startsWith(AWS_SSO_CREDENTIALS_PREFIX);
}

/** Network settings so the SSO OIDC calls honor the same CA/proxy config as the S3 client. */
export interface AwsSsoNetworkOptions {
  customCaPath?: string;
  rejectUnauthorized?: boolean;
  proxy?: ProxyConfig;
}

export interface AwsSsoDevicePrompt {
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  expiresIn: number;
}

export interface AwsSsoLoginResult {
  accessToken: string;
  expiresAt: string;
}

export interface AwsSsoAccount {
  accountId: string;
  accountName?: string;
  emailAddress?: string;
}

export interface AwsSsoAccountRole {
  roleName: string;
}

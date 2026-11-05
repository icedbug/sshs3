import { AWS_SSO_CREDENTIALS_PREFIX, AWS_SSO_EXPIRED_PREFIX, offersAwsSsoSignIn } from '../../shared/types/aws';

// Unambiguous: the SSO token provider failing, the portal rejecting the token, or AWS saying it lapsed.
const SSO_ERROR_NAMES = new Set(['TokenProviderError', 'UnauthorizedException', 'ExpiredToken', 'ExpiredTokenException']);
const SSO_ERROR_PATTERN =
  /sso session|sso login|sso token|token is expired|session token not found|refresh token|cached sso|token has expired/i;

/**
 * True when `err` means the SSO sign-in behind an S3 profile is missing, expired or rejected.
 * `CredentialsProviderError` alone is not enough: it also covers a wrong account or role, which a
 * new sign-in does not fix. (The pane still offers a sign-in for it, see `isAwsCredentialsError`, but with
 * the cause in the message instead of claiming the session expired.)
 */
export function isAwsSsoSessionError(err: unknown): boolean {
  // The SDK and proxy layers wrap errors, so the real reason can sit a few `cause`s down.
  for (let depth = 0; depth < 4 && err instanceof Error; depth++) {
    if (SSO_ERROR_NAMES.has(err.name) || SSO_ERROR_PATTERN.test(err.message)) return true;
    err = err.cause;
  }
  return false;
}

/** True when the SDK could not resolve credentials at all (expired token, proxy or network failure, rejected token). */
export function isAwsCredentialsError(err: unknown): boolean {
  for (let depth = 0; depth < 4 && err instanceof Error; depth++) {
    if (err.name === 'CredentialsProviderError') return true;
    err = err.cause;
  }
  return false;
}

/** Message shown in the file pane for a failed S3 call; keeps SSO expiry distinguishable from a permission error. */
export function describeS3Error(err: unknown, ssoProfile: boolean): string {
  if (ssoProfile && err instanceof Error && offersAwsSsoSignIn(err.message)) return err.message;
  if (ssoProfile && isAwsSsoSessionError(err)) {
    return `${AWS_SSO_EXPIRED_PREFIX}: sign in again to continue.`;
  }
  if (ssoProfile && isAwsCredentialsError(err)) {
    // Not provably an expired session, but a new sign-in is the only recovery the pane can offer.
    const detail = err instanceof Error ? err.message.replace(/^Error:\s*/, '') : String(err);
    return `${AWS_SSO_CREDENTIALS_PREFIX}: ${detail} Try signing in again.`;
  }
  if (err instanceof Error) {
    const code = err.name && err.name !== 'Error' ? err.name : '';
    const text = err.message || code;
    if (code === 'AccessDenied' || code === 'AccessDeniedException' || code === 'Forbidden') {
      return `Access denied: ${text}. The signed-in role is not allowed to do this.`;
    }
    return text || 'S3 request failed';
  }
  return String(err);
}

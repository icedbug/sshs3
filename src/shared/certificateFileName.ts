const CERTIFICATE_EXTENSIONS = new Set(['crt', 'cer', 'cert', 'pem', 'der']);

/**
 * Whether a file name suggests a certificate. Only such files are read for the certificate preview, so
 * hovering over arbitrary files never costs an extra read; the content then decides.
 */
export function isCertificateFileName(filePath: string): boolean {
  const name = filePath.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return false;
  return CERTIFICATE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

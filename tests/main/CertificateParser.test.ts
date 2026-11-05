import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  extractUpnFromCertificateDer,
  isAuthCapableCertificate,
  iterateChildren,
  parseCertificateDer,
  readTlv,
} from '../../src/main/smartcard/CertificateParser';

// Self-signed EC (P-256) certificate with a Microsoft UPN otherName in its subjectAltName,
// generated via:
//   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -outform DER \
//     -subj "/CN=Jane Testsson" \
//     -addext "subjectAltName=otherName:1.3.6.1.4.1.311.20.2.3;UTF8:jane.testsson@example.com"
// Its SSH fingerprint was independently verified with `ssh-keygen -lf` against the same
// public key, exported via `openssl x509 -pubkey | ssh-keygen -i -m PKCS8`.
const EC_CERT_WITH_UPN_B64 =
  'MIIBiDCCAS+gAwIBAgIUL5NxHFlvU34xfNpckEMepMZP6qowCgYIKoZIzj0EAwIwGDEWMBQGA1UEAwwNSmFuZSBUZXN0c3NvbjAeFw0yNjA5MjIxNzA4MjJaFw0yNzA5MjIxNzA4MjJaMBgxFjAUBgNVBAMMDUphbmUgVGVzdHNzb24wWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATxQg/DEeI7BFuFijMZh2UNceB7vzt2X/cfMbLyuuQNeCyAWHaycnB3IuOD8D8OHpsBp1ME//85QMq9WRBfKPCRo1cwVTA0BgNVHREELTAroCkGCisGAQQBgjcUAgOgGwwZamFuZS50ZXN0c3NvbkBleGFtcGxlLmNvbTAdBgNVHQ4EFgQUha/GQTe0e+vOF6r0DeV533jIGF4wCgYIKoZIzj0EAwIDRwAwRAIgFz2tH9BMgHfRu99jABknNPp8J7MCaHua8kpK9ENlKSECIHmmP9S2SmK7ayAglAQdjGs0STY/15FF8royxBpy7UZT';
const EC_CERT_SSH_FINGERPRINT = 'SHA256:VmHAS/hTK4NUwl6iDY4VV5Sx50xrWNPSHrxGh1gTwkI';

// Self-signed RSA-2048 certificate with no subjectAltName at all, to exercise the RSA
// fingerprint path and confirm a missing SAN just yields no UPN rather than throwing.
const RSA_CERT_NO_SAN_B64 =
  'MIIC2zCCAcOgAwIBAgIUA6Z7MYMUvkVgzm3dlAcTIx7FzOYwDQYJKoZIhvcNAQELBQAwFjEUMBIGA1UEAwwLQm9iIFJzYXNzb24wHhcNMjYwOTIyMTcwODM3WhcNMjcwOTIyMTcwODM3WjAWMRQwEgYDVQQDDAtCb2IgUnNhc3NvbjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAOEqmHQyJqZAxekHzby+H0+cPFjCfulMrSrFodbwwre5duLBAaxvK0zxUVeB/aBhbsMn2DaEa54EeY9MNBpaENDetKmAFSd/03MSN9e04JKUJ42Ssjia8OdOXeWU8ZhU+yZyRn1ZVhVJ7/OEcEBIcCc/A61xUwIxfTstp/35nXnIVChxPpbYVKBzYDz4h4YACSFBs7Oa7AFrTVvkEdQ7MhlUXdQAgy9SjvMLWqd4wQ0OgM60OT3dcO0ubKmUaGE+qdC8jsQmQspXEce+OaGhxumsFDKKpyBlJTmjtprGPEPaATBQAK1Mw/5keHSiYiFiSP2HTxRGUEI7mV1Z1LA78IUCAwEAAaMhMB8wHQYDVR0OBBYEFJ4PwbDeLpTDrHBEtQRwB5vSHxw0MA0GCSqGSIb3DQEBCwUAA4IBAQBlit2nr1bUoy1kjcbHHmX4e/fiQRvOW6VBeP0TMXPemsiqeFiRJgrJqMT/6r6VtdPRSK5GvboSp/WjOihLHKL3x5wZvT//8K8Zb02QaeddJkXG6VAUCuuhQcuFCaqvEo/TYzKM7YZ5aCBK7ARpOBnLxoRp8PGBoL5CFUJ/GGKnkNGMHxg/i3tUSmdXt6pcckoHt6EAvL/4zZC2BMkqvpUyS3PrZFaYCqUw2omRUup8wA8Uiw8D9H2OLwqNDVFSqN8WIUwQ094u2lb5zaDpedppey5+I6yJkrRqvA0+sWJCMY8Y3vHzyAqgGUQyAhK5FoXk9DsT0Wbv/SfV+5P9bKqw';
const RSA_CERT_SSH_FINGERPRINT = 'SHA256:TJIhx9TViXWZCtoH9K5n2u5WjQqi5XGlINkHBSQNRYE';

// Self-signed P-256 certificates generated with
//   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -outform DER -subj "/CN=<name>" \
//     -addext "keyUsage=critical,<usage>" [-addext "extendedKeyUsage=<eku>"]
// to cover the Key Usage / Extended Key Usage combinations the authCapable heuristic distinguishes.
const KU_DIGSIG_EKU_CLIENTAUTH_B64 =
  'MIIBmDCCAT6gAwIBAgIUSjHkX4w0zuxh8UZETsbo0Q8VmIQwCgYIKoZIzj0EAwIwDzENMAsGA1UEAwwEQXV0aDAeFw0yNjEwMDYxNTA2NDVaFw0zNjEwMDMxNTA2NDVaMA8xDTALBgNVBAMMBEF1dGgwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATaL+BaRtzWYe1Rtthelo33J4LRwxGIQTgCTs6RMaElzsVfKoCEpEZJeVAbec670NOWywB0lRn0w/8gSWz4oyHdo3gwdjAdBgNVHQ4EFgQUFQdfrDRjXpGGmD+qdJEcGJZb1oMwHwYDVR0jBBgwFoAUFQdfrDRjXpGGmD+qdJEcGJZb1oMwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAwwCgYIKwYBBQUHAwIwCgYIKoZIzj0EAwIDSAAwRQIgSUhv7mPpuS/EvkRMkjN7kvUDvlFslGbEB81iemIDfJwCIQCJ7R3ysa7aBAhqhYak1VULLZPPP1NAN91j2QF48D94iQ==';
const KU_NONREPUDIATION_B64 =
  'MIIBgzCCASmgAwIBAgIUaXB/+RL78ZYpS/dUFqUYYtC4+EQwCgYIKoZIzj0EAwIwDzENMAsGA1UEAwwEU2lnbjAeFw0yNjEwMDYxNTA2NDVaFw0zNjEwMDMxNTA2NDVaMA8xDTALBgNVBAMMBFNpZ24wWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASA4vyapkxCeaJEl6KWxOmV2KjBbRCtXqDft4lf+Hu0PK3Ogfu+8vJzsH1IMv3zlnvu48r5PPKl4tUZQ9bPagFeo2MwYTAdBgNVHQ4EFgQU3YamA+k03y+LwCllHgK3EDZAKP4wHwYDVR0jBBgwFoAU3YamA+k03y+LwCllHgK3EDZAKP4wDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCBkAwCgYIKoZIzj0EAwIDSAAwRQIhAJvZCMu56ZZlLezsP2lvbZbainXRjJ7J2pf1m5w3kcVwAiBAqgATGVYXNv8zxBgJtMzFYtUS/Y+sCB9AjmuN9qhbxw==';
const KU_KEYENCIPHERMENT_B64 =
  'MIIBiDCCAS+gAwIBAgIUB2pTZIiaWMUxGBYNpbTsP7pxP7kwCgYIKoZIzj0EAwIwEjEQMA4GA1UEAwwHS2V5TWdtdDAeFw0yNjEwMDYxNTA2NDVaFw0zNjEwMDMxNTA2NDVaMBIxEDAOBgNVBAMMB0tleU1nbXQwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQXbldTtU4thE205pxLPE6eiJsz4L7w2iz131XClCoPYyU8ZtzZkkotR3X4+PYK//LymxgBhzovehD4YGY7BvvKo2MwYTAdBgNVHQ4EFgQUQ//bQSK8gg4fNFrA/zE1iCCVs70wHwYDVR0jBBgwFoAUQ//bQSK8gg4fNFrA/zE1iCCVs70wDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCBSAwCgYIKoZIzj0EAwIDRwAwRAIgAjy1ZRAn8BxjJvHEdCt2gAhxvlV+27os6PQjak1A/jsCICZ0TeHgPEjUVOgW9Ugr/jpIcx1He2D+t0fbDGSDcmbu';
const KU_DIGSIG_EKU_EMAIL_ONLY_B64 =
  'MIIBmTCCAUCgAwIBAgIUNyt0jamfNj8HSSc3JPehV/tI1JUwCgYIKoZIzj0EAwIwEDEOMAwGA1UEAwwFRW1haWwwHhcNMjYxMDA2MTUwNjQ1WhcNMzYxMDAzMTUwNjQ1WjAQMQ4wDAYDVQQDDAVFbWFpbDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABATLMRuu8QIaepvjUJuefALM8M564Zs+ykFWGNofAYrlYIgu8UpoS1U/aS5b95DtYa+7D9Ayn+mrQ7iNcHdAPS6jeDB2MB0GA1UdDgQWBBSy7kZj1SCVCkGvYZQt9L5FEfNdtDAfBgNVHSMEGDAWgBSy7kZj1SCVCkGvYZQt9L5FEfNdtDAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDBDAKBggqhkjOPQQDAgNHADBEAiBFU9apVGTISOvus43+n9mDYIcInuYlP9fbk8DfDHrlcQIgPYH02K1b+wIy9v4cLccIIlAGjCcbKb4UZ43rWy+oZY0=';
const KU_DIGSIG_NONREPUDIATION_CLIENTAUTH_B64 =
  'MIIBoDCCAUagAwIBAgIUXiiNYYBwwGm55YIbcRNlIckJvBUwCgYIKoZIzj0EAwIwEzERMA8GA1UEAwwIU2lnbkF1dGgwHhcNMjYxMDA2MTU1NDM5WhcNMzYxMDAzMTU1NDM5WjATMREwDwYDVQQDDAhTaWduQXV0aDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABFpqhaJErceUa5hwkh+YNXgzEYvjefx/8nqM8AxU4EEmEuvZXAeHMzYGsZAo6giVRYCLQoopTSw8v/QzT4GQJ/ajeDB2MB0GA1UdDgQWBBTOYnTC4p8kn8yFZ8NOypu8MSHZQTAfBgNVHSMEGDAWgBTOYnTC4p8kn8yFZ8NOypu8MSHZQTAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIGwDATBgNVHSUEDDAKBggrBgEFBQcDAjAKBggqhkjOPQQDAgNIADBFAiB3r/Exe+afRVb7V9iaX+fWuQSABTEnYM2TC5ECFNIbVAIhAOcoWpmY8aJk62+Yfs7aGdHOgEc+PRWs/7u4Wddb1b9z';
const KU_DIGSIG_NONREPUDIATION_B64 =
  'MIIBiDCCAS2gAwIBAgIULaQ9X95qUfFQFXyGCrwRky88iNUwCgYIKoZIzj0EAwIwETEPMA0GA1UEAwwGS3VPbmx5MB4XDTI2MTAwNjE1MDY0NVoXDTM2MTAwMzE1MDY0NVowETEPMA0GA1UEAwwGS3VPbmx5MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEtD0oUEJ2DJZOhJMv6OPtHvz+cWLrykqCBMJi+qtjUfyAWo6mpP58pjRfLSzwaT5sIAUfjxFQaP2tjLYxfZJOa6NjMGEwHQYDVR0OBBYEFJBCesoFc+L1L4zvfEED0qg4B+t5MB8GA1UdIwQYMBaAFJBCesoFc+L1L4zvfEED0qg4B+t5MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgbAMAoGCCqGSM49BAMCA0kAMEYCIQCMtAQw3PZryfCM7/+CJgNdyqmUuMo+XErI8snRADOg+AIhAOADfa4S+tWP/fvI2Dw+gaQ2OTnqx+r2DYk0vLrZViac';

function authCapable(b64: string): boolean | undefined {
  return parseCertificateDer(Buffer.from(b64, 'base64'))?.authCapable;
}

describe('CertificateParser', () => {
  it('extracts the UPN from a certificate with a Microsoft otherName SAN', () => {
    const der = Buffer.from(EC_CERT_WITH_UPN_B64, 'base64');
    expect(extractUpnFromCertificateDer(der)).toBe('jane.testsson@example.com');
  });

  it('returns undefined when the certificate has no subjectAltName', () => {
    const der = Buffer.from(RSA_CERT_NO_SAN_B64, 'base64');
    expect(extractUpnFromCertificateDer(der)).toBeUndefined();
  });

  it('parses an EC certificate into subject/validity/UPN and matches ssh-keygen\'s fingerprint', () => {
    const der = Buffer.from(EC_CERT_WITH_UPN_B64, 'base64');
    const details = parseCertificateDer(der);
    expect(details).toBeDefined();
    expect(details?.fingerprint).toBe(EC_CERT_SSH_FINGERPRINT);
    expect(details?.subject).toContain('CN=Jane Testsson');
    expect(details?.upn).toBe('jane.testsson@example.com');
    expect(details?.validFrom).toBeTruthy();
    expect(details?.validTo).toBeTruthy();
  });

  it('parses an RSA certificate and matches ssh-keygen\'s fingerprint, with no UPN', () => {
    const der = Buffer.from(RSA_CERT_NO_SAN_B64, 'base64');
    const details = parseCertificateDer(der);
    expect(details).toBeDefined();
    expect(details?.fingerprint).toBe(RSA_CERT_SSH_FINGERPRINT);
    expect(details?.subject).toContain('CN=Bob Rsasson');
    expect(details?.upn).toBeUndefined();
  });

  it('returns undefined for garbage input instead of throwing', () => {
    expect(parseCertificateDer(Buffer.from([0x00, 0x01, 0x02]))).toBeUndefined();
    expect(extractUpnFromCertificateDer(Buffer.from([0x00, 0x01, 0x02]))).toBeUndefined();
  });
  it('rejects malformed DER lengths instead of looping or reading out of bounds', () => {
    // 0x84 ff ff ff ff overflowed a 32-bit shift to a negative length, so iterateChildren walked backwards forever.
    const overflow = Buffer.from([0x30, 0x84, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00]);
    expect(() => readTlv(overflow, 0)).toThrow(/DER/);
    expect(() => [...iterateChildren(Buffer.from([0x04, 0x84, 0xff, 0xff, 0xff, 0xff, 0x00]), 0, 7)]).toThrow(/DER/);
    expect(() => readTlv(Buffer.from([0x30, 0x80, 0x00]), 0)).toThrow(/DER/); // indefinite length
    expect(() => readTlv(Buffer.from([0x30, 0x05, 0x00]), 0)).toThrow(/DER/); // longer than the buffer
    const nested = Buffer.from([0x30, 0x08, 0x30, 0x84, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00]);
    expect(parseCertificateDer(nested)).toBeUndefined();
    expect(extractUpnFromCertificateDer(nested)).toBeUndefined();
  });

  describe('authCapable', () => {
    it('accepts digitalSignature + clientAuth', () => {
      expect(authCapable(KU_DIGSIG_EKU_CLIENTAUTH_B64)).toBe(true);
    });

    it('rejects digitalSignature + nonRepudiation without an EKU (a PIV 9c signing certificate)', () => {
      expect(authCapable(KU_DIGSIG_NONREPUDIATION_B64)).toBe(false);
    });

    it('accepts digitalSignature + nonRepudiation when an EKU explicitly allows client authentication', () => {
      expect(authCapable(KU_DIGSIG_NONREPUDIATION_CLIENTAUTH_B64)).toBe(true);
    });

    it('rejects a signing-only (nonRepudiation) certificate', () => {
      expect(authCapable(KU_NONREPUDIATION_B64)).toBe(false);
    });

    it('rejects a key-management (keyEncipherment) certificate', () => {
      expect(authCapable(KU_KEYENCIPHERMENT_B64)).toBe(false);
    });

    it('rejects an EKU that does not allow client authentication', () => {
      expect(authCapable(KU_DIGSIG_EKU_EMAIL_ONLY_B64)).toBe(false);
    });

    it('treats certificates without Key Usage / EKU as capable', () => {
      expect(authCapable(EC_CERT_WITH_UPN_B64)).toBe(true);
      expect(authCapable(RSA_CERT_NO_SAN_B64)).toBe(true);
    });

    it('fails open when the DER cannot be decoded', () => {
      const x509 = new X509Certificate(Buffer.from(KU_NONREPUDIATION_B64, 'base64'));
      expect(isAuthCapableCertificate(x509, Buffer.from([0x30, 0x03, 0x01]))).toBe(true);
    });
  });
});

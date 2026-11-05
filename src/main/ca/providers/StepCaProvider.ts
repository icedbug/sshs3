import { requestJson } from '../../oauth/requestJson';
import { isLoopbackHttpUrl } from '../loopbackUrl';
import { buildCertificateLine, normalizeCaBaseUrl, rootCaBuffer, throwIfCancelled } from './common';
import type { ISshCaProvider, SshCaConfig, SshCaSignRequest, SshCaSignResponse } from '../../../shared/types/sshCa';

export class StepCaProvider implements ISshCaProvider {
  public readonly id = 'step-ca' as const;

  public async sign(
    request: SshCaSignRequest,
    config: SshCaConfig,
    signal?: AbortSignal
  ): Promise<SshCaSignResponse> {
    if (!config.caUrl?.trim()) {
      throw new Error('Step-CA URL is required');
    }
    if (!request.identityToken?.trim()) {
      throw new Error('OIDC identity token is required for Step-CA signing');
    }
    if (!request.publicKeyWireBase64?.trim()) {
      throw new Error('Public key wire format is required for Step-CA signing');
    }

    throwIfCancelled(signal, 'Step-CA');

    const caBaseUrl = normalizeCaBaseUrl(config.caUrl);
    const signUrl = `${caBaseUrl}/1.0/ssh/sign`;

    const payload: Record<string, unknown> = {
      publicKey: request.publicKeyWireBase64,
      ott: request.identityToken,
      certType: 'user',
    };

    if (request.principals && request.principals.length > 0) {
      payload.principals = request.principals;
    }

    const res = await requestJson(signUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      ca: rootCaBuffer(config),
      timeoutMs: 15_000,
      allowHttp: isLoopbackHttpUrl(caBaseUrl),
      signal,
    });

    if (res.statusCode !== 200 && res.statusCode !== 201) {
      const errObj = res.json as { message?: string } | undefined;
      const msg = errObj?.message || `HTTP ${res.statusCode}`;
      throw new Error(`Step-CA certificate signing failed: ${msg}`);
    }

    const data = res.json as { crt?: string } | undefined;
    if (!data || typeof data.crt !== 'string' || !data.crt.trim()) {
      throw new Error('Step-CA response did not contain a certificate ("crt" field missing)');
    }

    const certificateWireBase64 = data.crt.trim();

    return {
      certificateWireBase64,
      certificateLine: buildCertificateLine(request, certificateWireBase64),
    };
  }
}

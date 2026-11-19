/** A reference to a request in the team's identity system. Its approval stays with that system. */
export interface TicketAccessRequest {
  url: string;
  resource: string;
  reviewer: string;
  expiresAt: number;
}

/** Only share a reference to the request, never a sign-in link or a signed URL. */
export function accessRequestUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    const privateParameter = /^(?:access_token|id_token|refresh_token|token|code|signature|x-amz-(?:signature|credential)|sig|key)$/i;
    const fragment = url.hash.slice(1).split("?").at(-1);
    if ([...url.searchParams.keys(), ...new URLSearchParams(fragment).keys()].some(key => privateParameter.test(key))) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function validatedAccessRequest(input: TicketAccessRequest): TicketAccessRequest {
  const url = accessRequestUrl(input?.url);
  if (!url) throw new Error("Enter a shareable HTTPS link to the access request.");
  const resource = typeof input.resource === "string" ? input.resource.trim() : "";
  const reviewer = typeof input.reviewer === "string" ? input.reviewer.trim() : "";
  if (!resource || resource.length > 200) throw new Error("Enter the requested resource (up to 200 characters).");
  if (!reviewer || reviewer.length > 200) throw new Error("Enter the reviewer (up to 200 characters).");
  if (!Number.isFinite(input.expiresAt) || !Number.isFinite(new Date(input.expiresAt).getTime()))
    throw new Error("Enter the expiry recorded in the identity system.");
  return { url, resource, reviewer, expiresAt: input.expiresAt };
}

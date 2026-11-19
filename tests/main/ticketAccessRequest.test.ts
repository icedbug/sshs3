import { describe, expect, it } from "vitest";
import { accessRequestUrl } from "../../src/shared/ticketAccessRequest";

describe("shareable identity-system request links", () => {
  it("keeps the resource path and request id", () => {
    const url = "https://access.example.net/requests?request_id=42";
    expect(accessRequestUrl(url)).toBe(url);
  });

  it.each([
    "http://access.example.net/request", "https://user:secret@access.example.net/request",
    "https://access.example.net/request?access_token=example", "https://access.example.net/#token=example",
    "https://access.example.net/#/login?code=example", "javascript:void(0)",
  ])("refuses an unsafe or credential-bearing link", value => {
    expect(accessRequestUrl(value)).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { addressClass, guardUrl } from "../../src/main/ai/hub/Notifier";

/**
 * Where sshs3 may call out to (a notification, a page read into the knowledge base, an MCP server, a
 * chat or Jira site): the addresses a cloud keeps a machine's own credentials at are never a
 * destination, however they are written.
 */

const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const desktop = { server: false, allowPrivate: true, allowPlainHttp: true, lookup };
const server = { server: true, allowPrivate: true, allowPlainHttp: true, lookup };

describe("cloud metadata addresses", () => {
  it("are never a destination: Amazon's on IPv6, Alibaba's, Azure's wire server, Oracle's", () => {
    for (const address of ["fd00:ec2::254", "FD00:EC2:0:0:0:0:0:254", "fd00:0ec2::254", "fd00:ec2::253", "100.100.100.200", "168.63.129.16", "192.0.0.192", "169.254.169.254"]) {
      expect(["never", "link-local"], address).toContain(addressClass(address));
    }
    expect(addressClass("fd00:ec2::254")).toBe("never");
    expect(addressClass("100.100.100.200")).toBe("never");
    expect(addressClass("168.63.129.16")).toBe("never");
  });

  it("are refused on a desktop and on a server that may call its private network, also when a name leads there", async () => {
    for (const options of [desktop, server]) {
      for (const url of ["http://[fd00:ec2::254]/latest/meta-data/", "http://100.100.100.200/latest/meta-data/", "http://168.63.129.16/metadata/instance", "http://[64:ff9b:1::a9fe:a9fe]/", "http://[64:ff9b:1:a9fe:a9:fea9::]/"]) {
        await expect(guardUrl(url, options), url).rejects.toThrow("leads to an address that sshs3 never calls");
      }
      for (const address of ["fd00:ec2::254", "100.100.100.200", "168.63.129.16", "64:ff9b:1::1"]) {
        await expect(guardUrl("https://metadata.example.com/", { ...options, lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }] }), address).rejects.toThrow("never calls");
      }
    }
  });

  it("are found inside an IPv6 address that carries them, however it is written", () => {
    // The same IPv4 address, mapped, translated, in NAT64, compatible and in 6to4, shortened and in full.
    for (const address of ["::ffff:100.100.100.200", "::ffff:6464:64c8", "0:0:0:0:0:ffff:6464:64c8", "::ffff:0:6464:64c8", "64:ff9b::6464:64c8", "64:ff9b:0:0:0:0:100.100.100.200", "::100.100.100.200", "2002:6464:64c8::1"]) {
      expect(addressClass(address), address).toBe("never");
    }
    for (const address of ["0:0:0:0:0:ffff:a9fe:a9fe", "::ffff:0:a9fe:a9fe", "2002:a9fe:a9fe::", "64:ff9b::169.254.169.254"]) expect(addressClass(address), address).toBe("link-local");
    for (const address of ["0:0:0:0:0:ffff:7f00:1", "::ffff:0:7f00:1", "2002:7f00:1::", "0:0:0:0:0:0:0:1", "::127.0.0.1"]) expect(addressClass(address), address).toBe("loopback");
    // NAT64 for local use cannot be read for the address it leads to: all of it is refused.
    for (const address of ["64:ff9b:1::7f00:1", "64:ff9b:1::808:808", "64:ff9b:1:ffff::"]) expect(addressClass(address), address).toBe("never");
  });

  it("leave ordinary addresses as they were", () => {
    const expected: Array<[string, string]> = [
      ["93.184.216.34", "public"],
      ["8.8.8.8", "public"],
      ["100.100.100.100", "private"],
      ["100.64.0.1", "private"],
      ["168.63.129.17", "public"],
      ["192.0.0.8", "public"],
      ["10.0.0.5", "private"],
      ["192.168.1.7", "private"],
      ["127.0.0.1", "loopback"],
      ["0.0.0.0", "never"],
      ["224.0.0.1", "never"],
      ["2606:4700:4700::1111", "public"],
      ["2001:db8::1", "public"],
      ["64:ff9b::808:808", "public"],
      ["64:ff9b::a00:1", "private"],
      ["::ffff:808:808", "public"],
      ["fd00::1", "private"],
      ["fd00:ec3::254", "private"],
      ["fd12:3456:789a::1", "private"],
      ["fec0::1", "private"],
      ["fe80::1", "link-local"],
      ["febf::1", "link-local"],
      ["::1", "loopback"],
      ["::", "never"],
      ["ff02::1", "never"],
      ["not an address", "never"],
    ];
    for (const [address, kind] of expected) expect(addressClass(address), address).toBe(kind);
  });

  it("still lets a desktop call its own network and a public address", async () => {
    expect((await guardUrl("http://192.168.1.7:8080/hook", desktop)).address).toBe("192.168.1.7");
    expect((await guardUrl("http://[fd12:3456:789a::1]/hook", desktop)).address).toBe("fd12:3456:789a::1");
    expect((await guardUrl("https://hooks.example.com/x", server)).address).toBe("93.184.216.34");
  });
});

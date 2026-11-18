import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileQueueStore } from "../../src/main/ai/hub/FileQueueStore";
import { isPreconditionFailedError, WorkSync } from "../../src/main/ai/hub/WorkSync";

/**
 * The team's shared items kept in a folder, for a server several people share with no bucket. It makes
 * the same promises the bucket's store makes: a write that names what it replaces, or asks that nothing
 * be there yet, happens whole or is refused.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function store(): Promise<{ store: FileQueueStore; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-file-store-"));
  dirs.push(root);
  return { store: new FileQueueStore(root), root };
}

const text = (s: string): Buffer => Buffer.from(s, "utf8");

describe("the team's store in a folder", () => {
  it("keeps what is written, lists it, and forgets what is removed", async () => {
    const { store: s, root } = await store();
    expect(await s.list("work/tickets")).toEqual([]);
    expect(await s.read("work/tickets/t1.json")).toBeUndefined();

    await s.write("work/tickets/t1.json", text('{"id":"t1"}'));
    await s.write("work/tickets/t2.json", text('{"id":"t2"}'));
    expect((await s.list("work/tickets")).sort()).toEqual(["t1.json", "t2.json"]);
    expect((await s.read("work/tickets/t1.json"))!.toString()).toBe('{"id":"t1"}');
    expect(await fs.readFile(path.join(root, "work", "tickets", "t1.json"), "utf8")).toBe('{"id":"t1"}');

    await s.remove("work/tickets/t1.json");
    await s.remove("work/tickets/t1.json");
    expect(await s.list("work/tickets")).toEqual(["t2.json"]);
    // No half-written file is ever listed or left behind.
    expect((await fs.readdir(path.join(root, "work", "tickets"))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("writes only where nothing is yet, when asked to", async () => {
    const { store: s } = await store();
    await s.write("work/claims/t1.json", text("first"), { ifNoneMatch: "*" });
    const second = s.write("work/claims/t1.json", text("second"), { ifNoneMatch: "*" });
    await expect(second).rejects.toThrow("It is there already.");
    await second.catch((e) => expect(isPreconditionFailedError(e)).toBe(true));
    expect((await s.read("work/claims/t1.json"))!.toString()).toBe("first");
    expect(await s.writeIfNoneMatch("work/claims/t1.json", text("third"))).toBe(false);
    expect(await s.writeIfNoneMatch("work/claims/t2.json", text("third"))).toBe(true);
  });

  it("replaces only the version it was told it replaces", async () => {
    const { store: s } = await store();
    await s.write("work/tickets/t1.json", text("one"));
    const read = (await s.readWithMeta("work/tickets/t1.json"))!;
    expect(read.buffer.toString()).toBe("one");
    await s.write("work/tickets/t1.json", text("two"), { ifMatch: read.etag });
    // The version read before is no longer the one there: somebody else got in first.
    const stale = s.write("work/tickets/t1.json", text("three"), { ifMatch: read.etag });
    await expect(stale).rejects.toThrow("changed by somebody else");
    await stale.catch((e) => expect(isPreconditionFailedError(e)).toBe(true));
    expect((await s.read("work/tickets/t1.json"))!.toString()).toBe("two");
    // Nothing there at all is not the version either.
    await expect(s.write("work/tickets/none.json", text("x"), { ifMatch: read.etag })).rejects.toThrow("changed by somebody else");
  });

  it("lets exactly one of many that reach for the same thing at once have it", async () => {
    const { store: s } = await store();
    const tries = await Promise.all(Array.from({ length: 40 }, (_, i) => s.writeIfNoneMatch("work/claims/t1.json", text(`account-${i}`))));
    expect(tries.filter(Boolean)).toHaveLength(1);
    expect((await s.read("work/claims/t1.json"))!.toString()).toBe(`account-${tries.indexOf(true)}`);

    // And of many that replace the same version, one.
    const { etag } = (await s.readWithMeta("work/claims/t1.json"))!;
    const swaps = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        s.write("work/claims/t1.json", text(`next-${i}`), { ifMatch: etag }).then(
          () => true,
          () => false,
        ),
      ),
    );
    expect(swaps.filter(Boolean)).toHaveLength(1);
  });

  it("refuses a path that would leave its folder", async () => {
    const { store: s, root } = await store();
    await expect(s.write("../outside.json", text("x"))).rejects.toThrow("outside the shared folder");
    await expect(s.read("work/../../outside.json")).rejects.toThrow("outside the shared folder");
    await expect(s.list("..")).rejects.toThrow("outside the shared folder");
    expect(await fs.readdir(path.dirname(root)).then((names) => names.includes("outside.json"))).toBe(false);
    // A leading slash is a path inside the folder, as in a bucket.
    await s.write("/work/tickets/t1.json", text("ok"));
    expect((await s.read("work/tickets/t1.json"))!.toString()).toBe("ok");
  });

  it("tells the other accounts when one writes an item of the board, and not for a heartbeat", async () => {
    const { store: s } = await store();
    let told = 0;
    const mine = s.forAccount(() => void told++);
    await mine.write("work/tickets/t1.json", text("{}"));
    expect(told).toBe(1);
    await mine.write("work/agents/a1.json", text("{}"));
    await mine.remove("work/tickets/t1.json");
    expect(told).toBe(3);
    // Who is running a ticket and how much was spent are read at the next look: they change all the time.
    await mine.write("work/claims/t1.json", text("{}"));
    await mine.write("work/usage/client.json", text("{}"));
    expect(told).toBe(3);
    // A write that was refused wrote nothing, and tells nobody.
    expect(await mine.writeIfNoneMatch!("work/agents/a1.json", text("{}"))).toBe(false);
    expect(told).toBe(3);
    // Through either, it is the same store.
    expect((await s.list("work/agents")).sort()).toEqual(["a1.json"]);
  });

  it("carries the board between two apps, as the bucket's store does", async () => {
    const { store: s } = await store();
    const maria = new WorkSync(s);
    const omar = new WorkSync(s);
    const ticket = { id: "t1", title: "Renew the certificate", status: "todo", updatedAt: 10 };
    const first = await maria.reconcile("tickets", [ticket]);
    expect(first.items.map((t) => t.id)).toEqual(["t1"]);
    // The other app has nothing of its own and gets it.
    const got = await omar.reconcile("tickets", [] as Array<typeof ticket>);
    expect(got.items).toEqual([ticket]);
    expect(got.changed).toBe(true);
    // A newer copy written by one replaces the older at the other.
    await omar.reconcile("tickets", [{ ...ticket, title: "Renew the certificate today", updatedAt: 20 }]);
    expect((await maria.reconcile("tickets", [ticket])).items[0].title).toBe("Renew the certificate today");
    // Only one of them gets to run it.
    const a = await maria.claim("t1", { by: "Maria Ek", client: "app-maria" }, 100, { fresh: () => true });
    const b = await omar.claim("t1", { by: "Omar Lind", client: "app-omar" }, 101, { fresh: () => true });
    expect(a.client).toBe("app-maria");
    expect(b.client).toBe("app-maria");
  });
});

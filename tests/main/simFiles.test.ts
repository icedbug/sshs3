import { afterEach, describe, expect, it } from "vitest";
import { SCENARIOS, startScenario, stopScenario } from "../../src/main/sim/lab";
import { SimStorageProvider } from "../../src/main/sim/SimStorageProvider";

/** The file manager on a simulated server: the same files as its terminal, in both directions. */

afterEach(() => stopScenario());

const open = () => {
  const world = startScenario(SCENARIOS.find((s) => s.id === "pg-wal-full")!);
  const host = world.host("pg-prod-db01")!;
  return { world, host, sh: world.shell(host), files: new SimStorageProvider("p1", "pg-prod-db01", ["pg-prod-db01", "10.30.60.11", "demo-ssh-pg-prod-db01"]) };
};

describe("the file manager on a simulated server", () => {
  it("shows what the terminal shows", async () => {
    const { sh, files } = open();
    const listed = (await files.list("/etc/default")).map((e) => e.name);
    expect(listed).toContain("wal-archive");
    expect(sh.run("ls /etc/default").output.split("\n")).toContain("wal-archive");
    expect((await files.readFile("/etc/default/wal-archive")).toString()).toBe(sh.run("cat /etc/default/wal-archive").output);
    const wal = await files.stat("/var/lib/postgresql/16/main/pg_wal");
    expect(wal).toMatchObject({ isDirectory: true, permissions: "drwxr-xr-x" });
  });

  it("sees what a command wrote, and a command sees what was saved here", async () => {
    const { sh, files } = open();
    sh.run("echo from-the-shell > /tmp/note");
    expect((await files.readFile("/tmp/note")).toString()).toBe("from-the-shell\n");
    await files.writeFile("/tmp/note", Buffer.from("from the file manager\n"));
    expect(sh.run("cat /tmp/note").output).toBe("from the file manager\n");
    await files.rename("/tmp/note", "/tmp/note.old");
    await files.delete("/tmp/note.old");
    expect(sh.run("ls /tmp/note.old").code).not.toBe(0);
  });

  it("is signed in as the login user: root's files are not this user's to change", async () => {
    const { files, host } = open();
    await expect(files.writeFile("/etc/default/wal-archive", Buffer.from("x"))).rejects.toThrow("EACCES");
    await expect(files.delete("/var/lib/postgresql/16/main/pg_wal")).rejects.toThrow("EACCES");
    expect(host.list("/var/lib/postgresql/16/main/pg_wal").length).toBeGreaterThan(2000);
    await expect(files.readFile("/nope")).rejects.toThrow("ENOENT");
  });

  it("keeps no new shell in the lab for every file it looks at", async () => {
    const { world, files } = open();
    const before = world.shells.length;
    for (let i = 0; i < 50; i++) {
      await files.writeFile("/tmp/note", Buffer.from(`round ${i}\n`));
      await files.readFile("/tmp/note");
      await files.createFolder(`/tmp/dir-${i}`);
      await files.delete(`/tmp/dir-${i}`);
      await files.getHomeDir();
    }
    // One for the server, made once: the lab's list of shells does not grow with every call.
    expect(world.shells.length - before).toBeLessThanOrEqual(1);
    // And what the lab says was run there is still only what its terminals ran.
    expect(world.ran(world.host("pg-prod-db01")!)).toEqual([]);
  });

  it("says so when the scenario has ended", async () => {
    const { files } = open();
    stopScenario();
    await expect(files.list("/")).rejects.toThrow("This server belonged to a scenario that has ended.");
  });
});

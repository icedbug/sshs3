import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { SimHost } from "../../src/main/sim/SimHost";
import { SimShell } from "../../src/main/sim/SimShell";
import { fileCommands } from "../../src/main/sim/commands/files";

// 2024-10-01 12:00:00 UTC: the world's clock stands still, so dates in the output are known.
const NOW = Date.UTC(2024, 9, 1, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const APP_LOG = [
  "2024-10-01T11:00:01 INFO  api started on :8080",
  "2024-10-01T11:02:10 ERROR db connection refused",
  "2024-10-01T11:02:11 WARN  retrying in 5s",
  "2024-10-01T11:02:16 ERROR db connection refused",
  "2024-10-01T11:03:00 INFO  request GET /health 200",
  "2024-10-01T11:04:00 error lowercase one",
  "",
].join("\n");

const NGINX_CONF = ["user www-data;", "events {", "    worker_connections 768;", "}", "http {", "    server_tokens off;", "}", ""].join("\n");

let host: SimHost;
let shell: SimShell;

/** Runs a line and gives back what the terminal shows. */
const run = async (line: string): Promise<string> => (await shell.run(line)).output;

beforeEach(() => {
  host = new SimHost({ name: "web-01", address: "10.0.0.5" }, () => NOW);
  host.disks = [
    { mount: "/", device: "/dev/sda1", fs: "ext4", sizeKb: 40_000_000, baseUsedKb: 4_000_000 },
    // 100 KB, 90 of them taken: a few kilobytes fit, no more.
    { mount: "/data", device: "/dev/sdb1", fs: "ext4", sizeKb: 100, baseUsedKb: 90 },
  ];
  host.write("/var/log/app.log", APP_LOG, { mode: 0o644, mtime: NOW - HOUR });
  host.write("/var/log/old.log", "old line\n", { mtime: NOW - 10 * DAY });
  host.write("/etc/nginx/nginx.conf", NGINX_CONF, { mtime: NOW - 30 * DAY });
  host.write("/etc/shadow", "root:$6$secret:19000:0:99999:7:::\n", { mode: 0o600 });
  host.write("/var/lib/postgresql/wal/000000010000000000000001", "", { pad: 16 * 1024 * 1024, owner: "postgres", mode: 0o600, mtime: NOW - 2 * DAY });
  host.write("/var/lib/postgresql/PG_VERSION", "16\n", { owner: "postgres" });
  host.write("/home/ops/notes.txt", "alpha\nbeta\ngamma\ndelta\nepsilon\n", { owner: "ops", mtime: NOW - 5 * 60_000 });
  host.write("/home/ops/users.csv", "name,role,age\nann,admin,41\nbob,dev,29\ncid,dev,35\n", { owner: "ops" });
  host.write("/home/ops/.bashrc", "export EDITOR=vi\n", { owner: "ops" });
  host.write("/home/ops/proj/src/main.c", "int main() { return 0; }\n", { owner: "ops" });
  host.write("/home/ops/proj/README.md", "# proj\n", { owner: "ops" });
  host.write("/data/keep.bin", "", { pad: 2048, owner: "ops" });
  host.mkdir("/tmp");
  shell = new SimShell(host, new Map(Object.entries(fileCommands)));
});

describe("echo, printf and friends", () => {
  it("prints what it is given", async () => {
    expect(await run("echo hello   world")).toBe("hello world\n");
    expect(await run("echo -n hi")).toBe("hi");
    expect(await run("echo -e 'a\\tb\\nc'")).toBe("a\tb\nc\n");
    expect(await run("printf '%s=%d\\n' a 1 b 2")).toBe("a=1\nb=2\n");
    expect(await run("printf '%5s|%-5s|%05.1f\\n' ab cd 3.14159")).toBe("   ab|cd   |003.1\n");
    expect(await run("pwd")).toBe("/home/ops\n");
  });

  it("true and false set the exit code", async () => {
    expect((await shell.run("true")).code).toBe(0);
    expect((await shell.run("false")).code).toBe(1);
    expect(await run("false || echo fallback")).toBe("fallback\n");
  });
});

describe("ls", () => {
  it("lists names, hidden ones only when asked", async () => {
    expect(await run("ls")).toBe("notes.txt\nproj\nusers.csv\n");
    expect(await run("ls -A")).toBe(".bashrc\nnotes.txt\nproj\nusers.csv\n");
    expect((await run("ls -a")).split("\n").slice(0, 2)).toEqual([".", ".."]);
  });

  it("prints the long format of GNU ls", async () => {
    const output = await run("ls -l /var/log");
    const rows = output.trimEnd().split("\n");
    expect(rows[0]).toBe("total 8");
    expect(rows[1]).toBe(`-rw-r--r-- 1 root root ${Buffer.byteLength(APP_LOG)} Oct  1 11:00 app.log`);
    expect(rows[2]).toMatch(/^-rw-r--r-- 1 root root +9 Sep 21 12:00 old\.log$/);
    for (const row of rows.slice(1)) expect(row).toMatch(/^[-d][-rwxsStT]{9} +\d+ \S+ +\S+ +\d+ [A-Z][a-z]{2} [ \d]\d \d\d:\d\d \S+$/);
    expect(await run("ls -ld /etc/nginx")).toMatch(/^drwxr-xr-x 2 root root 4096 [A-Z][a-z]{2} [ \d]\d \d\d:\d\d \/etc\/nginx\n$/);
  });

  it("counts a padded file at its full size, human readable with -h", async () => {
    expect(await run("ls -l /var/lib/postgresql/wal")).toContain("-rw------- 1 postgres postgres 16777216 Sep 29 12:00 000000010000000000000001");
    expect(await run("ls -lh /var/lib/postgresql/wal")).toMatch(/^total 16M\n-rw------- 1 postgres postgres 16M /);
  });

  it("sorts by time and size, reversed too, and walks down with -R", async () => {
    expect(await run("ls -t /var/log")).toBe("app.log\nold.log\n");
    expect(await run("ls -tr /var/log")).toBe("old.log\napp.log\n");
    expect(await run("ls -S /home/ops/notes.txt /home/ops/users.csv")).toBe("/home/ops/users.csv\n/home/ops/notes.txt\n");
    expect(await run("ls -R proj")).toBe("proj:\nREADME.md\nsrc\n\nproj/src:\nmain.c\n");
  });

  it("says what is not there, and exits 2", async () => {
    const result = await shell.run("ls /nope /var/log/old.log");
    expect(result.output).toBe("/var/log/old.log\nls: cannot access '/nope': No such file or directory\n");
    expect(result.code).toBe(2);
  });
});

describe("cat, head, tail", () => {
  it("cat joins files, numbers lines, and reads the pipe", async () => {
    expect(await run("cat notes.txt users.csv | wc -l")).toBe("9\n");
    expect(await run("head -2 notes.txt | cat -n")).toBe("     1\talpha\n     2\tbeta\n");
    expect(await run("less notes.txt")).toBe("alpha\nbeta\ngamma\ndelta\nepsilon\n");
  });

  it("cat reports a missing file, a folder and a file that may not be read", async () => {
    const missing = await shell.run("cat /x");
    expect(missing).toEqual({ output: "cat: /x: No such file or directory\n", code: 1 });
    expect(await run("cat /etc")).toBe("cat: /etc: Is a directory\n");
    expect(await shell.run("cat /etc/shadow")).toEqual({ output: "cat: /etc/shadow: Permission denied\n", code: 1 });
    expect(await run("sudo cat /etc/shadow")).toContain("root:$6$secret");
  });

  it("cat of a padded file prints its text only", async () => {
    host.write("/tmp/dump.sql", "-- header\n", { pad: 5_000_000 });
    expect(await run("cat /tmp/dump.sql")).toBe("-- header\n");
    expect(await run("wc -c /tmp/dump.sql")).toBe("5000010 /tmp/dump.sql\n");
  });

  it("head and tail take lines and bytes from either end", async () => {
    expect(await run("head -n 2 notes.txt")).toBe("alpha\nbeta\n");
    expect(await run("head -n -3 notes.txt")).toBe("alpha\nbeta\n");
    expect(await run("head -c 5 notes.txt")).toBe("alpha");
    expect(await run("tail -n 2 notes.txt")).toBe("delta\nepsilon\n");
    expect(await run("tail -2 notes.txt")).toBe("delta\nepsilon\n");
    expect(await run("tail -n +4 notes.txt")).toBe("delta\nepsilon\n");
    expect(await run("tail -f -n1 notes.txt")).toBe("epsilon\n");
    expect(await run("tail -c 8 notes.txt")).toBe("epsilon\n");
    expect(await run("head -n1 notes.txt users.csv")).toBe("==> notes.txt <==\nalpha\n\n==> users.csv <==\nname,role,age\n");
    expect(await run("head /nope")).toBe("head: cannot open '/nope' for reading: No such file or directory\n");
  });
});

describe("grep", () => {
  it("counts, numbers and inverts", async () => {
    expect(await shell.run("grep -c ERROR /var/log/app.log")).toEqual({ output: "2\n", code: 0 });
    expect(await run("grep -ci error /var/log/app.log")).toBe("3\n");
    expect(await run("grep -n WARN /var/log/app.log")).toBe("3:2024-10-01T11:02:11 WARN  retrying in 5s\n");
    expect(await run("grep -vc INFO /var/log/app.log")).toBe("4\n");
    expect(await run("cat /var/log/app.log | grep ERROR | wc -l")).toBe("2\n");
  });

  it("exits 1 without a match and 2 on an error", async () => {
    expect(await shell.run("grep nothing-like-this /var/log/app.log")).toEqual({ output: "", code: 1 });
    expect(await shell.run("grep x /nope")).toEqual({ output: "grep: /nope: No such file or directory\n", code: 2 });
    expect(await shell.run("grep 'a[' notes.txt")).toEqual({ output: "grep: Unmatched [, [^, [:, [., or [=\n", code: 2 });
    expect(await shell.run("grep -E '(a' notes.txt")).toEqual({ output: "grep: Unmatched ( or \\(\n", code: 2 });
    expect((await shell.run("grep -q beta notes.txt")).code).toBe(0);
  });

  it("names the file when there are several, or with -r", async () => {
    expect(await run("grep -i line /var/log/app.log /var/log/old.log")).toBe("/var/log/old.log:old line\n");
    expect(await run("grep -rn main proj")).toBe("proj/src/main.c:1:int main() { return 0; }\n");
    expect(await run("grep -rl proj .")).toBe("./proj/README.md\n");
    expect(await run("grep -L alpha notes.txt users.csv")).toBe("users.csv\n");
    expect(await run("grep -h dev users.csv notes.txt")).toBe("bob,dev,29\ncid,dev,35\n");
  });

  it("reads basic, extended and fixed patterns", async () => {
    expect(await run("grep -c 'WARN\\|INFO' /var/log/app.log")).toBe("3\n");
    expect(await run("grep -Ec 'WARN|INFO' /var/log/app.log")).toBe("3\n");
    expect(await run("egrep -o '[0-9]+s$' /var/log/app.log")).toBe("5s\n");
    expect(await run("grep -F 'main()' proj/src/main.c")).toBe("int main() { return 0; }\n");
    expect(await run("grep 'main()' proj/src/main.c")).toBe("int main() { return 0; }\n");
    expect(await run("echo 'a.b' | fgrep -c '.'")).toBe("1\n");
    expect(await run("grep -w bet notes.txt")).toBe("");
    expect(await run("grep --color=auto -e alpha -e beta notes.txt")).toBe("alpha\nbeta\n");
    expect(await run("grep '^[[:alpha:]]*a$' notes.txt")).toBe("alpha\nbeta\ngamma\ndelta\n");
  });

  it("prints the lines around a match", async () => {
    expect(await run("grep -A1 beta notes.txt")).toBe("beta\ngamma\n");
    expect(await run("grep -n -C1 -e alpha -e epsilon notes.txt")).toBe("1:alpha\n2-beta\n--\n4-delta\n5:epsilon\n");
  });
});

describe("wc, sort, uniq, cut, tr", () => {
  it("wc prints GNU's columns", async () => {
    expect(await run("wc notes.txt")).toBe(" 5  5 31 notes.txt\n");
    expect(await run("wc -l notes.txt users.csv")).toBe(" 5 notes.txt\n 4 users.csv\n 9 total\n");
    expect(await run("cat notes.txt | wc")).toBe("      5       5      31\n");
    expect(await run("wc -c /var/lib/postgresql/PG_VERSION")).toBe("3 /var/lib/postgresql/PG_VERSION\n");
  });

  it("sort | uniq -c counts what repeats", async () => {
    expect(await run("cut -d' ' -f2 /var/log/app.log | sort | uniq -c | sort -rn")).toBe("      2 INFO\n      2 ERROR\n      1 error\n      1 WARN\n");
    expect(await run("printf 'b\\na\\nb\\n' | sort -u")).toBe("a\nb\n");
    expect(await run("printf 'a\\na\\nb\\n' | uniq -d")).toBe("a\n");
  });

  it("sort orders by number, by key and by human size", async () => {
    expect(await run("printf '10\\n9\\n100\\n' | sort -n")).toBe("9\n10\n100\n");
    expect(await run("tail -n +2 users.csv | sort -t, -k3 -nr | head -1")).toBe("ann,admin,41\n");
    expect(await run("tail -n +2 users.csv | sort -t , -k2,2 -k3,3n")).toBe("ann,admin,41\nbob,dev,29\ncid,dev,35\n");
    expect(await run("printf '2G\\n512K\\n10M\\n' | sort -h")).toBe("512K\n10M\n2G\n");
  });

  it("cut and tr", async () => {
    expect(await run("cut -d, -f1,3 users.csv")).toBe("name,age\nann,41\nbob,29\ncid,35\n");
    expect(await run("echo abcdef | cut -c2-4")).toBe("bcd\n");
    expect(await run("echo hello | tr a-z A-Z")).toBe("HELLO\n");
    expect(await run("echo 'a  b   c' | tr -s ' '")).toBe("a b c\n");
    expect(await run("echo h3ll0 | tr -d '[:digit:]'")).toBe("hll\n");
  });
});

describe("awk", () => {
  it("prints columns", async () => {
    expect(await run("awk '{print $2}' /var/log/app.log | head -2")).toBe("INFO\nERROR\n");
    expect(await run("awk -F, '{print $1, $3}' users.csv")).toBe("name age\nann 41\nbob 29\ncid 35\n");
    expect(await run("awk -F: '{print $1 \":\" $NF}' /etc/shadow")).toBe("awk: fatal: cannot open file `/etc/shadow' for reading: Permission denied\n");
    expect(await run("sudo awk -F: '{print $1 \":\" $NF}' /etc/shadow")).toBe("root:\n");
    expect(await run("echo 'a b c' | awk '{print $NF \"-\" $1; print NF}'")).toBe("c-a\n3\n");
  });

  it("filters with a pattern or a condition before the block", async () => {
    expect(await run("awk '/ERROR/ {print $1}' /var/log/app.log")).toBe("2024-10-01T11:02:10\n2024-10-01T11:02:16\n");
    expect(await run("awk 'NR==2' notes.txt")).toBe("beta\n");
    expect(await run("awk 'NR>3 {print $0}' notes.txt")).toBe("delta\nepsilon\n");
    expect(await run("awk -F, 'NR > 1 && $3 > 30 {print $1}' users.csv")).toBe("ann\ncid\n");
    expect(await run("awk -F, '$2 == \"dev\" && NR > 1 {print $1}' users.csv")).toBe("bob\ncid\n");
    expect(await run("awk 'END {print NR}' notes.txt")).toBe("5\n");
    expect(await run("awk -F, 'NR>1 {sum += $3} END {print sum}' users.csv")).toBe("105\n");
  });

  it("says so when the program is beyond it", async () => {
    const result = await shell.run("awk '{ for (i = 1; i <= NF; i++) print $i }' notes.txt");
    expect(result).toEqual({ output: "awk: this awk program is not part of this simulation\n", code: 2 });
    expect(shell.unsupported).toHaveLength(1);
  });
});

describe("sed", () => {
  it("prints lines by number", async () => {
    expect(await run("sed -n '2p' notes.txt")).toBe("beta\n");
    expect(await run("sed -n '2,3p' notes.txt")).toBe("beta\ngamma\n");
    expect(await run("sed -n '$p' notes.txt")).toBe("epsilon\n");
  });

  it("substitutes, with flags, other delimiters and back references", async () => {
    expect(await run("echo 'aaa bbb' | sed 's/a/x/'")).toBe("xaa bbb\n");
    expect(await run("echo 'aaa bbb' | sed 's/a/x/g'")).toBe("xxx bbb\n");
    expect(await run("echo 'Hello' | sed 's/hello/bye/I'")).toBe("bye\n");
    expect(await run("echo /usr/local/bin | sed 's|/usr/local|/opt|'")).toBe("/opt/bin\n");
    expect(await run("echo 'key=value' | sed 's/\\(.*\\)=\\(.*\\)/\\2=\\1/'")).toBe("value=key\n");
    expect(await run("echo 'key=value' | sed -E 's/(.*)=(.*)/\\2=[&]/'")).toBe("value=[key=value]\n");
  });

  it("deletes lines and takes several commands", async () => {
    expect(await run("sed '/a$/d' notes.txt")).toBe("epsilon\n");
    expect(await run("sed '1d;$d' notes.txt")).toBe("beta\ngamma\ndelta\n");
    expect(await run("sed -e 's/alpha/A/' -e '2,$d' notes.txt")).toBe("A\n");
    expect(await run("sed '/beta/s/e/E/g' notes.txt | head -3")).toBe("alpha\nbEta\ngamma\n");
  });

  it("edits in place only where the user may write", async () => {
    const denied = await shell.run("sed -i 's/768/2048/' /etc/nginx/nginx.conf");
    expect(denied.code).toBe(4);
    expect(denied.output).toMatch(/^sed: couldn't open temporary file \/etc\/nginx\/sed\w+: Permission denied\n$/);
    expect(host.read("/etc/nginx/nginx.conf")!.content).toContain("worker_connections 768;");

    expect(await shell.run("sudo sed -i 's/768/2048/' /etc/nginx/nginx.conf")).toEqual({ output: "", code: 0 });
    expect(host.read("/etc/nginx/nginx.conf")!.content).toContain("    worker_connections 2048;\n");
    expect(host.read("/etc/nginx/nginx.conf")!.owner).toBe("root");
  });

  it("keeps a backup with -i.bak", async () => {
    await run("sed -i.bak 's/beta/BETA/' notes.txt");
    expect(await run("sed -n 2p notes.txt notes.txt.bak")).toBe("BETA\n");
    expect(host.read("/home/ops/notes.txt.bak")!.content).toContain("beta");
  });

  it("refuses what it does not simulate, and reports a broken script", async () => {
    expect((await shell.run("sed 'y/abc/xyz/' notes.txt")).output).toBe("sed: the sed command 'y' is not part of this simulation\n");
    expect(await shell.run("sed 's/a/b' notes.txt")).toEqual({ output: "sed: -e expression #1, char 5: unterminated `s' command\n", code: 1 });
  });
});

describe("find and du", () => {
  it("finds by name and type, printing paths as they were asked for", async () => {
    expect(await run("find proj")).toBe("proj\nproj/README.md\nproj/src\nproj/src/main.c\n");
    expect(await run("find . -name '*.c'")).toBe("./proj/src/main.c\n");
    expect(await run("find /home/ops -maxdepth 1 -type d")).toBe("/home/ops\n/home/ops/proj\n");
    expect(await run("find proj -iname 'readme*' -o -name main.c")).toBe("proj/README.md\nproj/src/main.c\n");
    expect(await run("find /nope")).toBe("find: '/nope': No such file or directory\n");
  });

  it("finds by size and by age", async () => {
    expect(await run("find /var/lib -size +1M")).toBe("/var/lib/postgresql/wal/000000010000000000000001\n");
    expect(await run("find /var/log -type f -mtime +7")).toBe("/var/log/old.log\n");
    expect(await run("find /var/log -type f -mmin -120")).toBe("/var/log/app.log\n");
    expect(await run("find /var/log -newer /var/log/old.log -type f")).toBe("/var/log/app.log\n");
  });

  it("deletes what it finds, and leaves -exec alone", async () => {
    expect(await run("sudo find /var/log -name '*.log' -mtime +7 -delete")).toBe("");
    expect(host.exists("/var/log/old.log")).toBe(false);
    expect(host.exists("/var/log/app.log")).toBe(true);
    expect((await shell.run("find . -name '*.c' -exec rm {} ;")).output).toBe("find: find -exec is not part of this simulation\n");
  });

  it("du sums a tree, children before the parent", async () => {
    expect(await run("du -sh /var/lib/postgresql")).toBe("17M\t/var/lib/postgresql\n");
    expect(await run("du proj")).toBe("8\tproj/src\n16\tproj\n");
    expect(await run("du -a --max-depth=1 proj")).toBe("4\tproj/README.md\n8\tproj/src\n16\tproj\n");
    expect(await run("du -sc /var/log /etc/nginx | tail -1")).toBe("20\ttotal\n");
    expect(await run("du -s /nope")).toBe("du: cannot access '/nope': No such file or directory\n");
  });
});

describe("stat, file and sums", () => {
  it("stat prints the usual block, or a format", async () => {
    const output = await run("stat /etc/nginx/nginx.conf");
    expect(output).toContain("  File: /etc/nginx/nginx.conf\n");
    expect(output).toMatch(/ {2}Size: 86 +\tBlocks: 8 +IO Block: 4096 {3}regular file\n/);
    expect(output).toContain("Access: (0644/-rw-r--r--)  Uid: (    0/    root)   Gid: (    0/    root)\n");
    expect(output).toContain("Modify: 2024-09-01 12:00:00.000000000 +0000\n");
    expect(await run("stat -c %s /var/lib/postgresql/wal/000000010000000000000001")).toBe("16777216\n");
    expect(await run("stat -c '%a %U %n' /etc/shadow notes.txt")).toBe("600 root /etc/shadow\n644 ops notes.txt\n");
    expect(await run("stat /nope")).toBe("stat: cannot statx '/nope': No such file or directory\n");
  });

  it("file tells text from data", async () => {
    host.write("/tmp/empty", "");
    expect(await run("file notes.txt /tmp/empty /etc")).toBe("notes.txt:  ASCII text\n/tmp/empty: empty\n/etc:       directory\n");
    expect(await run("file -b /data/keep.bin")).toBe("data\n");
  });

  it("md5sum and sha256sum are the real sums of the content", async () => {
    const text = host.read("/home/ops/notes.txt")!.content;
    expect(await run("md5sum notes.txt")).toBe(`${createHash("md5").update(text).digest("hex")}  notes.txt\n`);
    expect(await run("echo -n abc | sha256sum")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  -\n");
  });

  it("basename, dirname, realpath, readlink -f", async () => {
    expect(await run("basename /etc/nginx/nginx.conf .conf")).toBe("nginx\n");
    expect(await run("dirname /etc/nginx/nginx.conf notes.txt")).toBe("/etc/nginx\n.\n");
    expect(await run("realpath proj/../notes.txt")).toBe("/home/ops/notes.txt\n");
    expect(await run("readlink -f ./proj/src")).toBe("/home/ops/proj/src\n");
  });
});

describe("making, copying, moving, removing", () => {
  it("mkdir, touch and rmdir", async () => {
    expect(await run("mkdir a/b")).toBe("mkdir: cannot create directory 'a/b': No such file or directory\n");
    expect(await run("mkdir -p a/b && touch a/b/f && ls a/b")).toBe("f\n");
    expect(await run("mkdir a")).toBe("mkdir: cannot create directory 'a': File exists\n");
    expect(await run("mkdir /etc/app")).toBe("mkdir: cannot create directory '/etc/app': Permission denied\n");
    expect(await run("rmdir a")).toBe("rmdir: failed to remove 'a': Directory not empty\n");
    expect(await run("touch /etc/nginx/new.conf")).toBe("touch: cannot touch '/etc/nginx/new.conf': Permission denied\n");
  });

  it("rm refuses a folder without -r, and the root of everything always", async () => {
    expect(await shell.run("rm proj")).toEqual({ output: "rm: cannot remove 'proj': Is a directory\n", code: 1 });
    expect(host.isDir("/home/ops/proj")).toBe(true);
    expect(await run("rm -rv proj")).toBe("removed 'proj/README.md'\nremoved 'proj/src/main.c'\nremoved directory 'proj/src'\nremoved directory 'proj'\n");
    expect(host.exists("/home/ops/proj")).toBe(false);
    expect(await run("rm gone")).toBe("rm: cannot remove 'gone': No such file or directory\n");
    expect(await shell.run("rm -f gone")).toEqual({ output: "", code: 0 });
    expect(await run("rm /etc/shadow")).toBe("rm: cannot remove '/etc/shadow': Permission denied\n");
    for (const line of ["sudo rm -rf /", "sudo rm -rf /*", "sudo rm -rf --no-preserve-root /"]) {
      const result = await shell.run(line);
      expect(result.output).toContain("rm: it is dangerous to operate recursively on '/'\n");
      expect(result.code).toBe(1);
    }
    expect(host.exists("/etc/shadow")).toBe(true);
  });

  it("cp copies a file with its padding, and a tree with -r", async () => {
    await run("sudo cp /var/lib/postgresql/wal/000000010000000000000001 /tmp/wal.copy");
    expect(await run("stat -c '%s %U' /tmp/wal.copy")).toBe("16777216 root\n");
    expect(await run("cp proj /tmp/")).toBe("cp: -r not specified; omitting directory 'proj'\n");
    expect(await run("cp -rv proj /tmp/p2 | tail -1")).toBe("'proj/src/main.c' -> '/tmp/p2/src/main.c'\n");
    expect(await run("cp /etc/shadow /tmp/s")).toBe("cp: cannot open '/etc/shadow' for reading: Permission denied\n");
    expect(await run("cp notes.txt /etc/notes.txt")).toBe("cp: cannot create regular file '/etc/notes.txt': Permission denied\n");
    await run("sudo cp -a notes.txt /etc/notes.txt");
    expect(host.read("/etc/notes.txt")).toMatchObject({ owner: "ops", mtime: NOW - 5 * 60_000 });
  });

  it("mv renames files and folders", async () => {
    expect(await run("mv notes.txt proj/ && ls proj")).toBe("notes.txt\nREADME.md\nsrc\n");
    expect(await run("mv proj work && find work -type f | wc -l")).toBe("3\n");
    expect(host.exists("/home/ops/proj")).toBe(false);
    expect(await run("mv /etc/shadow /tmp/")).toBe("mv: cannot move '/etc/shadow' to '/tmp/shadow': Permission denied\n");
    expect(await run("mv nothing there")).toBe("mv: cannot stat 'nothing': No such file or directory\n");
  });

  it("tee writes what passes through, with sudo where it has to", async () => {
    expect(await run("echo 'gzip on;' | tee -a /etc/nginx/nginx.conf")).toBe("gzip on;\ntee: /etc/nginx/nginx.conf: Permission denied\n");
    expect(await run("echo 'gzip on;' | sudo tee -a /etc/nginx/nginx.conf")).toBe("gzip on;\n");
    expect(await run("tail -1 /etc/nginx/nginx.conf")).toBe("gzip on;\n");
  });

  it("chmod and chown need the owner or root", async () => {
    await run("chmod 600 notes.txt");
    expect(await run("stat -c %A notes.txt")).toBe("-rw-------\n");
    await run("chmod u+x,go+r notes.txt");
    expect(await run("stat -c %a notes.txt")).toBe("744\n");
    expect(await shell.run("chmod 644 /etc/shadow")).toEqual({ output: "chmod: changing permissions of '/etc/shadow': Operation not permitted\n", code: 1 });
    expect(await run("chown root notes.txt")).toBe("chown: changing ownership of 'notes.txt': Operation not permitted\n");
    await run("sudo chown -R www-data:www-data /etc/nginx");
    expect(host.read("/etc/nginx/nginx.conf")!.owner).toBe("www-data");
    expect(await run("chmod zzz notes.txt")).toContain("chmod: invalid mode: 'zzz'\n");
  });

  it("ln and the editors are said not to be there", async () => {
    expect((await shell.run("ln -s a b")).output).toBe("ln: making links is not part of this simulation\n");
    expect(await shell.run("vim /etc/nginx/nginx.conf")).toEqual({ output: "vim: this simulated terminal has no full-screen editor; edit with sed -i, tee or a redirection\n", code: 1 });
    expect((await shell.run("nano x")).code).toBe(1);
  });
});

describe("a full disk", () => {
  it("refuses a redirection, a copy and an edit that do not fit", async () => {
    // /data has about 4 KB left: a small file goes in, a big one does not.
    expect(await shell.run("echo ok > /tmp/fits && sudo cp /tmp/fits /data/fits")).toEqual({ output: "", code: 0 });
    const redirect = await shell.run("sudo sh -c 'cat /var/log/app.log /var/log/app.log /var/log/app.log /var/log/app.log /var/log/app.log /var/log/app.log /var/log/app.log /var/log/app.log /var/log/app.log /var/log/app.log /var/log/app.log /var/log/app.log /var/log/app.log /var/log/app.log /var/log/app.log /var/log/app.log > /data/big.log'");
    expect(redirect).toEqual({ output: "bash: /data/big.log: No space left on device\n", code: 1 });
    expect(host.exists("/data/big.log")).toBe(false);
    expect(await run("sudo cp /var/lib/postgresql/wal/000000010000000000000001 /data/")).toBe("cp: error writing '/data/000000010000000000000001': No space left on device\n");
    expect(await run("sudo mv /var/lib/postgresql/wal/000000010000000000000001 /data/wal")).toBe("mv: error writing '/data/wal': No space left on device\n");
    host.write("/data/fill", "", { pad: 3 * 1024 });
    expect(await run("echo more | sudo tee /data/more")).toBe("more\ntee: /data/more: No space left on device\n");
    // Freeing room makes the same write go through.
    await run("sudo rm /data/fill /data/keep.bin");
    expect(await run("echo more | sudo tee /data/more")).toBe("more\n");
  });
});

describe("diff and test", () => {
  it("diff prints a unified diff and exits 1 when the files differ", async () => {
    await run("sed 's/gamma/GAMMA/' notes.txt > notes2.txt");
    const result = await shell.run("diff -u notes.txt notes2.txt");
    expect(result.code).toBe(1);
    const rows = result.output.split("\n");
    expect(rows[0]).toMatch(/^--- notes\.txt\t2024-10-01 11:55:00\.000000000 \+0000$/);
    expect(rows[1]).toMatch(/^\+\+\+ notes2\.txt\t/);
    expect(rows.slice(2).join("\n")).toBe("@@ -1,5 +1,5 @@\n alpha\n beta\n-gamma\n+GAMMA\n delta\n epsilon\n");
    expect(await shell.run("diff notes.txt notes.txt")).toEqual({ output: "", code: 0 });
    expect(await run("diff -q notes.txt notes2.txt")).toBe("Files notes.txt and notes2.txt differ\n");
    expect(await shell.run("diff notes.txt /nope")).toEqual({ output: "diff: /nope: No such file or directory\n", code: 2 });
  });

  it("test and [ answer with the exit code", async () => {
    const code = async (line: string): Promise<number> => (await shell.run(line)).code;
    expect(await code("test -f notes.txt")).toBe(0);
    expect(await code("test -d notes.txt")).toBe(1);
    expect(await code("[ -d proj ]")).toBe(0);
    expect(await code("[ ! -e /nope ]")).toBe(0);
    expect(await code("[ -s /data/keep.bin ]")).toBe(0);
    expect(await code("[ -r /etc/shadow ]")).toBe(1);
    expect(await code("[ -w /etc/nginx/nginx.conf ]")).toBe(1);
    expect(await code("sudo [ -w /etc/nginx/nginx.conf ]")).toBe(0);
    expect(await code("[ -z '' ]")).toBe(0);
    expect(await code("[ -n '' ]")).toBe(1);
    expect(await code("[ abc = abc ]")).toBe(0);
    expect(await code("[ abc != abc ]")).toBe(1);
    expect(await code("[ 10 -gt 9 ]")).toBe(0);
    expect(await code("[ 3 -lt 3 ]")).toBe(1);
    expect(await code("[ 3 -eq 3 -a -f notes.txt ]")).toBe(0);
    expect(await run("[ -f /etc/shadow ] && echo present")).toBe("present\n");
    expect(await shell.run("[ -f notes.txt")).toEqual({ output: "bash: [: missing `]'\n", code: 2 });
  });
});

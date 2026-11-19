import { beforeEach, describe, expect, it } from "vitest";
import { SimHost } from "../../src/main/sim/SimHost";
import { SimShell } from "../../src/main/sim/SimShell";
import { parseTimestamp, systemCommands } from "../../src/main/sim/commands/system";

/** Monday 16 November 2026, 12:00:00 UTC. */
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GB = 1024 * 1024;

describe("system commands of a simulated server", () => {
  let host: SimHost;
  let shell: SimShell;
  const run = (line: string): { output: string; code: number } => shell.run(line);

  beforeEach(() => {
    host = new SimHost({ name: "web-01", address: "10.0.4.21", uptimeSeconds: 41 * 86_400, memoryMb: 8192, cpus: 4 }, () => NOW);
    host.addService({
      name: "nginx",
      description: "A high performance web server and a reverse proxy server",
      command: "nginx: master process /usr/sbin/nginx -g daemon on; master_process on;",
      since: NOW - 3 * DAY,
      ports: [
        { proto: "tcp", port: 80 },
        { proto: "tcp", port: 443 },
      ],
    });
    // Runs, but its configuration is broken: it does not come back once it is stopped.
    host.addService({
      name: "postgresql",
      description: "PostgreSQL RDBMS",
      user: "postgres",
      command: "/usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main",
      ports: [{ proto: "tcp", port: 5432, address: "127.0.0.1" }],
      check: () => 'FATAL:  could not open file "/etc/postgresql/16/main/pg_hba.conf": No such file or directory',
    });
    host.addService({ name: "backup", description: "Nightly backup", state: "inactive", enabled: false });

    host.log("nginx", "start worker processes", 6, NOW - 3 * DAY);
    host.log("nginx", "upstream timed out (110: Connection timed out) while connecting to upstream", 3, NOW - 2 * DAY);
    host.log("nginx", "an upstream response is buffered to a temporary file", 4, NOW - 2 * HOUR);
    host.log("nginx", "connect() failed (111: Connection refused) while connecting to upstream", 3, NOW - 5 * MINUTE);
    host.log("postgresql", "database system is ready to accept connections", 6, NOW - 30 * MINUTE);

    host.disks = [
      { mount: "/", device: "/dev/sda1", fs: "ext4", sizeKb: 50 * GB, baseUsedKb: 12 * GB },
      { mount: "/var/lib/postgresql", device: "/dev/sdb1", fs: "xfs", sizeKb: 100 * GB, baseUsedKb: 91 * GB },
    ];
    host.packages = { nginx: "1.24.0-2ubuntu7", "openssh-server": "1:9.6p1-3ubuntu13" };
    host.certs.set("/etc/ssl/certs/site.pem", {
      subject: "www.example.com",
      issuer: "C=US, O=Let's Encrypt, CN=R11",
      notBefore: Date.UTC(2026, 7, 23, 12, 0, 0),
      notAfter: Date.UTC(2026, 10, 21, 12, 0, 0),
      names: ["www.example.com", "example.com"],
    });
    shell = new SimShell(host, new Map(Object.entries(systemCommands)));
  });

  describe("what an agent looks at first (asked for by the first real model, and not there)", () => {
    it("vmstat gives one line per sample, with the memory free says and an idle processor", () => {
      const one = run("vmstat");
      expect(one.code).toBe(0);
      const rows = one.output.replace(/\r/g, "").trim().split("\n");
      expect(rows[1]).toBe(" r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st");
      expect(rows).toHaveLength(3);
      const cells = rows[2].trim().split(/\s+/).map(Number);
      expect(cells).toHaveLength(17);
      // free memory is the same number `free` prints
      const free = Number(run("free").output.split("\n")[1].trim().split(/\s+/)[3]);
      expect(cells[3]).toBe(free);
      // user + system + idle make a whole
      expect(cells[12] + cells[13] + cells[14]).toBeGreaterThanOrEqual(99);
      expect(run("vmstat 1 3").output.replace(/\r/g, "").trim().split("\n")).toHaveLength(5);
      expect(shell.unsupported).toEqual([]);
    });

    it("iostat names the server and lists each disk once, with and without -x", () => {
      const plain = run("iostat");
      expect(plain.code).toBe(0);
      expect(plain.output).toContain("(web-01)");
      expect(plain.output).toContain("(4 CPU)");
      expect(plain.output).toMatch(/avg-cpu:\s+%user\s+%nice\s+%system\s+%iowait\s+%steal\s+%idle/);
      const wide = run("iostat -xz 1 2");
      expect(wide.code).toBe(0);
      expect(wide.output).toMatch(/Device\s+r\/s\s+rkB\/s/);
      expect(wide.output).toMatch(/%util/);
      expect(shell.unsupported).toEqual([]);
    });

    it("timeout runs the command it is given, and its exit code is the command's", () => {
      expect(run("timeout 8 uname -n").output.trim()).toBe("web-01");
      expect(run("timeout -k 2 8 uname -Q").code).toBe(1);
      expect(run("sudo timeout 5 whoami").output.trim()).toBe("root");
      expect(run("timeout 5").code).toBe(125);
      expect(shell.unsupported).toEqual([]);
    });
  });

  describe("systemctl", () => {
    it("shows a running unit the way systemd does, with its last journal lines", () => {
      const { output, code } = run("systemctl status nginx");
      const text = output.split("\n");
      expect(code).toBe(0);
      expect(text[0]).toBe("● nginx.service - A high performance web server and a reverse proxy server");
      expect(text[1]).toBe("     Loaded: loaded (/lib/systemd/system/nginx.service; enabled; preset: enabled)");
      expect(text[2]).toBe("     Active: active (running) since Fri 2026-11-13 12:00:00 UTC; 3 days ago");
      expect(text[3]).toBe("   Main PID: 2000 (nginx)");
      expect(output).toContain("Nov 16 11:55:00 web-01 nginx[2000]: connect() failed (111: Connection refused) while connecting to upstream");
    });

    it("answers 3 for a unit that does not run and 4 for one that is not there", () => {
      const stopped = run("systemctl status backup.service");
      expect(stopped.code).toBe(3);
      expect(stopped.output).toContain("○ backup.service - Nightly backup");
      expect(stopped.output).toContain("     Loaded: loaded (/lib/systemd/system/backup.service; disabled; preset: enabled)");
      expect(stopped.output).toContain("     Active: inactive (dead)");

      expect(run("systemctl status ghost")).toEqual({ output: "Unit ghost.service could not be found.\n", code: 4 });
    });

    it("refuses to change a unit without sudo, and leaves it as it was", () => {
      const refused = run("systemctl restart nginx");
      expect(refused.code).toBe(1);
      expect(refused.output).toContain("Failed to restart nginx.service: Interactive authentication required.");
      expect(host.service("nginx")?.pid).toBe(2000);

      expect(run("sudo systemctl restart nginx.service")).toEqual({ output: "", code: 0 });
      expect(host.service("nginx")?.state).toBe("active");
      expect(host.service("nginx")?.pid).not.toBe(2000);
    });

    it("leaves a unit failed when it cannot start again, and the journal says why", () => {
      const restart = run("sudo systemctl restart postgresql");
      expect(restart.code).toBe(1);
      expect(restart.output).toBe(
        'Job for postgresql.service failed because the control process exited with error code.\nSee "systemctl status postgresql.service" and "journalctl -xeu postgresql.service" for details.\n',
      );
      expect(host.service("postgresql")?.state).toBe("failed");

      const status = run("systemctl status postgresql");
      expect(status.code).toBe(3);
      expect(status.output).toContain("× postgresql.service - PostgreSQL RDBMS");
      expect(status.output).toContain("     Active: failed (Result: exit-code) since Mon 2026-11-16 12:00:00 UTC; 0s ago");

      const journal = run("journalctl -u postgresql --no-pager -n 5");
      expect(journal.output).toMatch(/Nov 16 12:00:00 web-01 postgresql\[\d+\]: FATAL: {2}could not open file "\/etc\/postgresql\/16\/main\/pg_hba.conf"/);
      expect(journal.output).toContain("Nov 16 12:00:00 web-01 systemd[1]: Failed to start postgresql.service - PostgreSQL RDBMS.");
    });

    it("says in a word and an exit code how a unit is", () => {
      expect(run("systemctl is-active nginx")).toEqual({ output: "active\n", code: 0 });
      expect(run("systemctl is-active backup")).toEqual({ output: "inactive\n", code: 3 });
      expect(run("systemctl is-enabled backup")).toEqual({ output: "disabled\n", code: 1 });
      run("sudo systemctl restart postgresql");
      expect(run("systemctl is-active postgresql")).toEqual({ output: "failed\n", code: 3 });
      expect(run("systemctl is-failed postgresql")).toEqual({ output: "failed\n", code: 0 });
      expect(run("systemctl show -p ActiveState -p SubState postgresql").output).toBe("ActiveState=failed\nSubState=failed\n");
    });

    it("lists units in systemd's columns, and only the failed ones when asked", () => {
      const all = run("systemctl list-units --type=service --no-pager").output.split("\n");
      expect(all[0]).toBe("  UNIT               LOAD   ACTIVE SUB     DESCRIPTION");
      expect(all[1]).toBe("  nginx.service      loaded active running A high performance web server and a reverse proxy server");
      expect(all.join("\n")).toContain("2 loaded units listed. Pass --all to see loaded but inactive units, too.");
      expect(all.join("\n")).not.toContain("backup.service");

      expect(run("systemctl list-units --failed").output).toContain("0 loaded units listed.");
      run("sudo systemctl restart postgresql");
      const failed = run("systemctl --failed").output;
      expect(failed).toContain("● postgresql.service loaded failed failed PostgreSQL RDBMS");
      expect(failed).toContain("1 loaded units listed.");
    });

    it("enables and starts with --now, through `service` too", () => {
      expect(run("sudo systemctl enable --now backup").code).toBe(0);
      expect(host.service("backup")).toMatchObject({ enabled: true, state: "active" });
      expect(run("sudo service backup stop").code).toBe(0);
      expect(host.service("backup")?.state).toBe("inactive");
      expect(run("systemctl cat nginx").output).toContain("ExecStart=nginx: master process /usr/sbin/nginx");
    });
  });

  describe("journalctl", () => {
    it("writes lines as journald does, and filters them", () => {
      const all = run("journalctl -u nginx --no-pager").output.trimEnd().split("\n");
      expect(all).toHaveLength(4);
      expect(all[0]).toBe("Nov 13 12:00:00 web-01 nginx[2000]: start worker processes");

      expect(run("journalctl -u nginx -n 1 -o cat").output).toBe("connect() failed (111: Connection refused) while connecting to upstream\n");
      expect(run("journalctl -u nginx -p err --no-pager").output.trimEnd().split("\n")).toHaveLength(2);
      expect(run("journalctl -u nginx -p warning --no-pager").output.trimEnd().split("\n")).toHaveLength(3);
      expect(run('journalctl --since "10 min ago"').output).toBe("Nov 16 11:55:00 web-01 nginx[2000]: connect() failed (111: Connection refused) while connecting to upstream\n");
      expect(run("journalctl --since today --no-pager").output.trimEnd().split("\n")).toHaveLength(3);
      expect(run('journalctl -u nginx --since "2026-11-14 00:00" --until "2026-11-15 00:00"').output).toContain("upstream timed out");
      expect(run("journalctl -u nginx -u postgresql -r -n 2").output.split("\n")[1]).toContain("postgresql[2001]: database system is ready");
      expect(run("journalctl -u backup").output).toBe("-- No entries --\n");
    });

    it("reads the times people give it", () => {
      expect(parseTimestamp("2 hours ago", NOW)).toBe(NOW - 2 * HOUR);
      expect(parseTimestamp("yesterday", NOW)).toBe(Date.UTC(2026, 10, 15));
      expect(parseTimestamp("2026-11-13 18:27:03", NOW)).toBe(Date.UTC(2026, 10, 13, 18, 27, 3));
      expect(parseTimestamp("soon", NOW)).toBeUndefined();
    });
  });

  describe("disks, memory, time", () => {
    it("lays df out as GNU df does, from what is on the disks", () => {
      expect(run("df -h").output.split("\n").slice(0, 3)).toEqual([
        "Filesystem      Size  Used Avail Use% Mounted on",
        "/dev/sda1        50G   13G   38G  25% /",
        "/dev/sdb1       100G   92G  9.0G  92% /var/lib/postgresql",
      ]);
      expect(run("df -hT /var/lib/postgresql").output.split("\n")[1]).toBe("/dev/sdb1      xfs   100G   92G  9.0G  92% /var/lib/postgresql");
      expect(run("df /nowhere")).toEqual({ output: "df: /nowhere: No such file or directory\n", code: 1 });
    });

    it("knows how long the machine is up and what time it is", () => {
      expect(run("uptime").output).toMatch(/^ 12:00:00 up 41 days, 0 min, {2}1 user, {2}load average: \d\.\d\d, \d\.\d\d, \d\.\d\d\n$/);
      host.facts.set("load", 7.5);
      expect(run("uptime").output).toContain("load average: 7.50, 6.90, 6.38");
      expect(run("date").output).toBe("Mon Nov 16 12:00:00 UTC 2026\n");
      expect(run("date +%s").output).toBe(`${NOW / 1000}\n`);
      expect(run('date "+%Y-%m-%d %H:%M:%S"').output).toBe("2026-11-16 12:00:00\n");
      expect(run("free -m").output).toMatch(/^ {15}total {8}used {8}free {6}shared {2}buff\/cache {3}available\nMem: {12}8192 /);
    });

    it("says who and where it is", () => {
      expect(run("uname -r").output).toBe("6.8.0-45-generic\n");
      expect(run("uname -a").output).toMatch(/^Linux web-01 6\.8\.0-45-generic #45-Ubuntu SMP .* x86_64 x86_64 x86_64 GNU\/Linux\n$/);
      expect(run("hostname").output).toBe("web-01\n");
      expect(run("hostname -I").output).toBe("10.0.4.21 \n");
      expect(run("id").output).toBe("uid=1000(ops) gid=1000(ops) groups=1000(ops),4(adm),27(sudo)\n");
      expect(run("sudo id").output).toBe("uid=0(root) gid=0(root) groups=0(root)\n");
      expect(run("whoami; nproc").output).toBe("ops\n4\n");
      expect(run("which systemctl").output).toBe("/usr/bin/systemctl\n");
      expect(run("which terraform")).toEqual({ output: "", code: 1 });
      expect(run("command -v df").output).toBe("/usr/bin/df\n");
    });
  });

  describe("processes and ports", () => {
    it("shows the ports of what runs, and the program only to root", () => {
      const plain = run("ss -tlnp").output;
      expect(plain.split("\n")[0]).toMatch(/^State\s+Recv-Q\s+Send-Q\s+Local Address:Port\s+Peer Address:Port\s+Process$/);
      expect(plain).toMatch(/LISTEN\s+0\s+\d+\s+0\.0\.0\.0:80\s+0\.0\.0\.0:\*/);
      expect(plain).toMatch(/127\.0\.0\.1:5432/);
      expect(plain).not.toContain("users:");
      expect(run("sudo ss -tlnp").output).toMatch(/0\.0\.0\.0:443\s+0\.0\.0\.0:\*\s+users:\(\("nginx",pid=2000,fd=\d+\)\)/);
      expect(run("sudo netstat -tulpn").output).toMatch(/^tcp\s+0\s+0 0\.0\.0\.0:80\s+0\.0\.0\.0:\*\s+LISTEN\s+2000\/nginx$/m);

      run("sudo systemctl stop nginx");
      const after = run("sudo ss -tlnp").output;
      expect(after).not.toContain(":80 ");
      expect(after).toContain("127.0.0.1:5432");
    });

    it("lists the processes of running services among the system's", () => {
      const aux = run("ps aux").output;
      expect(aux.split("\n")[0]).toBe("USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND");
      expect(aux).toMatch(/^root {8}2000 +\d\.\d +\d\.\d +\d+ +\d+ \? {8}Ssl {2}Nov13 +\d+:\d\d nginx: master process \/usr\/sbin\/nginx/m);
      expect(aux).toMatch(/^postgres +2001 .*\/usr\/lib\/postgresql\/16\/bin\/postgres -D/m);
      expect(aux).toMatch(/^root +1 .* \/sbin\/init$/m);
      expect(run("ps -eo pid,comm").output).toContain("   2000 nginx");
      expect(run("pgrep -l nginx").output).toBe("2000 nginx\n");
      expect(run("pidof postgres").output).toBe("2001\n");
    });

    it("stops a service when its process is killed, by root only", () => {
      expect(run("kill 2000")).toEqual({ output: "bash: kill: (2000) - Operation not permitted\n", code: 1 });
      expect(host.service("nginx")?.state).toBe("active");
      expect(run("sudo kill -9 2000").code).toBe(0);
      expect(host.service("nginx")?.state).toBe("inactive");
      expect(run("ps aux").output).not.toContain("nginx: master process");
      expect(run("sudo kill 2000").output).toBe("bash: kill: (2000) - No such process\n");
    });
  });

  describe("packages and certificates", () => {
    it("lists packages as dpkg does and refuses to change them", () => {
      const listed = run("dpkg -l nginx").output.split("\n");
      expect(listed[3]).toBe("||/ Name           Version         Architecture Description");
      expect(listed[5]).toBe("ii  nginx          1.24.0-2ubuntu7 amd64        small, powerful, scalable web/proxy server");
      expect(run("dpkg -l htop")).toEqual({ output: "dpkg-query: no packages found matching htop\n", code: 1 });

      expect(run("apt-get install -y htop").code).toBe(100);
      expect(run("apt-get install -y htop").output).toContain("are you root?");
      expect(run("sudo apt-get install -y htop")).toEqual({ output: "E: This simulated host has no package mirror: packages cannot be changed here.\n", code: 100 });
    });

    it("reads a certificate's dates as openssl prints them", () => {
      const pem = "/etc/ssl/certs/site.pem";
      expect(run(`openssl x509 -in ${pem} -noout -enddate`).output).toBe("notAfter=Nov 21 12:00:00 2026 GMT\n");
      expect(run(`openssl x509 -in ${pem} -noout -subject -issuer`).output).toBe("subject=CN = www.example.com\nissuer=C = US, O = Let's Encrypt, CN = R11\n");
      expect(run(`openssl x509 -in ${pem} -noout -checkend 86400`)).toEqual({ output: "Certificate will not expire\n", code: 0 });
      expect(run(`openssl x509 -in ${pem} -noout -checkend ${7 * 86_400}`)).toEqual({ output: "Certificate will expire\n", code: 1 });
      expect(run("openssl x509 -in /etc/ssl/none.pem -noout -enddate").output).toContain("Could not open file or uri for loading certificate from /etc/ssl/none.pem");
    });
  });

  it("writes down what it does not simulate", () => {
    expect(run("snap list").code).toBe(2);
    expect(run("nohup ./job.sh").output).toContain("is not part of this simulation");
    expect(shell.unsupported).toEqual(["snap list", "nohup ./job.sh"]);
  });
});

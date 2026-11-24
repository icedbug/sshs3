import { afterEach, describe, expect, it, vi } from "vitest";
import { forApproval, maskContext } from "../../src/main/ai/hub/privacy";
import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
import { ToolBroker } from "../../src/main/ai/hub/ToolBroker";
import type { AgentTask } from "../../src/shared/types/aiHub";

/**
 * A password written as an ordinary word on a command line was readable in the approval card, the
 * store and the audit log: the masker knew `name=value` and a few flags, and nothing of `sshpass -p`,
 * `redis-cli -a`, `docker login -p`, a pipe into `chpasswd` or `sudo -S`, and the rest below.
 */

const PW = "S3cretPw9"; // pragma: allowlist secret

describe("passwords on ordinary command lines", () => {
  it.each([
    [`sshpass -p '${PW}!' ssh root@db-01 uptime`, "sshpass -p [redacted] ssh root@db-01 uptime"],
    [`sshpass -p${PW} ssh -p 2222 root@db-01 uptime`, "sshpass -p[redacted] ssh -p 2222 root@db-01 uptime"],
    [`sshpass -v -p ${PW} scp a root@db-01:`, "sshpass -v -p [redacted] scp a root@db-01:"],
    [`SSHPASS=${PW} sshpass -e ssh root@db-01 uptime`, "SSHPASS=[redacted] sshpass -e ssh root@db-01 uptime"],
    [`redis-cli -h cache -p 6379 -a ${PW} ping`, "redis-cli -h cache -p 6379 -a [redacted] ping"],
    [`docker login -u deploy -p ${PW} registry.example.com`, "docker login -u deploy -p [redacted] registry.example.com"],
    [`podman login --username deploy -p "${PW}" quay.io`, "podman login --username deploy -p [redacted] quay.io"],
    [`helm registry login -u deploy -p ${PW} registry.example.com`, "helm registry login -u deploy -p [redacted] registry.example.com"],
    [`mongosh -u admin -p ${PW} --eval 'db.stats()'`, "mongosh -u admin -p [redacted] --eval 'db.stats()'"],
    [`mongodump -u backup -p ${PW} --out /srv/dump`, "mongodump -u backup -p [redacted] --out /srv/dump"],
    [`ldapsearch -x -D cn=admin,dc=x -w ${PW} -b dc=x`, "ldapsearch -x -D cn=admin,dc=x -w [redacted] -b dc=x"],
    [`ldappasswd -x -D cn=admin,dc=x -w ${PW} -s New${PW} uid=jo,dc=x`, "ldappasswd -x -D cn=admin,dc=x -w [redacted] -s [redacted] uid=jo,dc=x"],
    [`echo 'deploy:${PW}' | chpasswd`, "echo 'deploy:[redacted]' | chpasswd"],
    [`echo "deploy:${PW}" | sudo chpasswd`, 'echo "deploy:[redacted]" | sudo chpasswd'],
    [`printf 'deploy:${PW}\\n' | chpasswd -e`, "printf 'deploy:[redacted]\\n' | chpasswd -e"],
    [`chpasswd <<< 'deploy:${PW}'`, "chpasswd <<< 'deploy:[redacted]'"],
    [`echo ${PW} | sudo -S systemctl restart nginx`, "echo [redacted] | sudo -S systemctl restart nginx"],
    [`echo -n '${PW}' | sudo -kS id`, "echo -n '[redacted]' | sudo -kS id"],
    [`printf '%s\\n' ${PW} | sudo -S -k id`, "printf '%s\\n' [redacted] | sudo -S -k id"],
    [`echo ${PW} | docker login -u deploy --password-stdin registry.example.com`, "echo [redacted] | docker login -u deploy --password-stdin registry.example.com"],
    [`echo ${PW} | passwd --stdin deploy`, "echo [redacted] | passwd --stdin deploy"],
    [`openssl enc -aes-256-cbc -pass pass:${PW} -in a -out b`, "openssl enc -aes-256-cbc -pass pass:[redacted] -in a -out b"],
    [`openssl rsa -in k.pem -passin pass:${PW} -passout pass:Other${PW}`, "openssl rsa -in k.pem -passin pass:[redacted] -passout pass:[redacted]"],
    [`htpasswd -b /etc/nginx/.htpasswd admin ${PW}`, "htpasswd -b /etc/nginx/.htpasswd admin [redacted]"],
    [`htpasswd -cbB /etc/nginx/.htpasswd admin ${PW} && nginx -s reload`, "htpasswd -cbB /etc/nginx/.htpasswd admin [redacted] && nginx -s reload"],
    [`htpasswd -nb admin ${PW} > /tmp/out`, "htpasswd -nb admin [redacted] > /tmp/out"],
    [`zip -P ${PW} out.zip file`, "zip -P [redacted] out.zip file"],
    [`unzip -P ${PW} out.zip`, "unzip -P [redacted] out.zip"],
    [`7z a -p${PW} out.7z file`, "7z a -p[redacted] out.7z file"],
    [`smbclient //srv/share -U admin%${PW}`, "smbclient //srv/share -U admin%[redacted]"],
    [`ipmitool -I lanplus -H bmc-01 -U admin -P ${PW} power status`, "ipmitool -I lanplus -H bmc-01 -U admin -P [redacted] power status"],
    [`rabbitmqctl add_user app ${PW}`, "rabbitmqctl add_user app [redacted]"],
    [`kubectl create secret generic db --from-literal=user=app --from-literal=dbkey=${PW}`, "kubectl create secret generic db --from-literal=user=[redacted] --from-literal=dbkey=[redacted]"],
    [`wget --http-password ${PW} https://files.example.com/x`, "wget --http-password [redacted] https://files.example.com/x"],
    [`kubeadm join 10.0.0.1:6443 --token ${PW}`, "kubeadm join 10.0.0.1:6443 --token [redacted]"],
    // Already masked before this change; kept here so the list a person reads is whole.
    [`mysql -uroot -p${PW} -e 'select 1'`, "mysql -uroot -p[redacted] -e 'select 1'"],
    [`curl -u admin:${PW} https://api.example.com/x`, "curl -u admin:[redacted] https://api.example.com/x"],
    [`mysql --password=${PW} -e 'select 1'`, "mysql --password=[redacted] -e 'select 1'"],
    [`PGPASSWORD=${PW} psql -c 'select 1'`, "PGPASSWORD=[redacted] psql -c 'select 1'"],
    // Found in clear by a review: programs the list covers or claims, and common ones.
    [`redis-cli -h cache AUTH ${PW}`, "redis-cli -h cache AUTH [redacted]"],
    [`redis-cli -h cache auth default ${PW}`, "redis-cli -h cache auth default [redacted]"],
    [`redis-cli CONFIG SET requirepass ${PW}`, "redis-cli CONFIG SET requirepass [redacted]"],
    [`openssl pkcs12 -in a.p12 -password pass:${PW} -nodes`, "openssl pkcs12 -in a.p12 -password pass:[redacted] -nodes"],
    [`mysql -e "ALTER USER 'app'@'%' IDENTIFIED BY '${PW}'"`, `mysql -e "ALTER USER 'app'@'%' IDENTIFIED BY '[redacted]'"`],
    [`mysql -e "CREATE USER 'app'@'%' IDENTIFIED WITH mysql_native_password BY '${PW}'"`, `mysql -e "CREATE USER 'app'@'%' IDENTIFIED WITH mysql_native_password BY '[redacted]'"`],
    [`mysql -e "SET PASSWORD FOR 'app'@'%' = '${PW}'"`, `mysql -e "SET PASSWORD FOR 'app'@'%' = '[redacted]'"`],
    [`psql -c "ALTER ROLE app WITH PASSWORD '${PW}'"`, `psql -c "ALTER ROLE app WITH PASSWORD '[redacted]'"`],
    [`psql -c "ALTER USER app ENCRYPTED PASSWORD '${PW}'"`, `psql -c "ALTER USER app ENCRYPTED PASSWORD '[redacted]'"`],
    [`keytool -list -keystore k.jks -storepass ${PW}`, "keytool -list -keystore k.jks -storepass [redacted]"],
    [`keytool -genkey -keystore k.jks -keypass ${PW} -storepass Other${PW}`, "keytool -genkey -keystore k.jks -keypass [redacted] -storepass [redacted]"],
    [`vault login ${PW}`, "vault login [redacted]"],
    [`etcdctl --user root:${PW} get /x`, "etcdctl --user root:[redacted] get /x"],
    [`influx -username admin -password ${PW} -execute 'show databases'`, "influx -username admin -password [redacted] -execute 'show databases'"],
    [`cqlsh -u cassandra -p ${PW} db`, "cqlsh -u cassandra -p [redacted] db"],
    [`useradd -m -p ${PW} deploy`, "useradd -m -p [redacted] deploy"],
    [`usermod -p ${PW} deploy`, "usermod -p [redacted] deploy"],
    [`snmpwalk -v3 -u ops -a SHA -A ${PW} -x AES -X Other${PW} host`, "snmpwalk -v3 -u ops -a SHA -A [redacted] -x AES -X [redacted] host"],
    [`xfreerdp /u:ops /p:${PW} /v:host`, "xfreerdp /u:ops /p:[redacted] /v:host"],
    [`export DBPASS=${PW}`, "export DBPASS=[redacted]"],
    [`export GITLAB_TOKEN=${PW} APP_SECRET=${PW} STRIPE_KEY=${PW}`, "export GITLAB_TOKEN=[redacted] APP_SECRET=[redacted] STRIPE_KEY=[redacted]"],
    [`java -jar jenkins-cli.jar -s https://ci.example.com -auth admin:${PW} list-jobs`, "java -jar jenkins-cli.jar -s https://ci.example.com -auth admin:[redacted] list-jobs"],
    [`rabbitmqadmin -u admin -p ${PW} list queues`, "rabbitmqadmin -u admin -p [redacted] list queues"],
    [`consul members -token ${PW}`, "consul members -token [redacted]"],
    [`consul members -token=${PW}`, "consul members -token=[redacted]"],
  ])("%s", (command, shown) => {
    expect(maskContext(command)).toBe(shown);
    expect(forApproval(command, 16_000, "command")).toEqual({ text: shown, hidden: true });
  });

  it("masks every line of a here-document handed to chpasswd", () => {
    const command = `sudo chpasswd <<EOF\ndeploy:${PW}\nbackup:Other${PW}\nEOF\necho done`;
    expect(maskContext(command)).toBe("sudo chpasswd <<EOF\ndeploy:[redacted]\nbackup:[redacted]\nEOF\necho done");
  });

  it("leaves the same letters alone where they are not a password", () => {
    for (const command of [
      "ssh -p 2222 root@db-01 uptime",
      "docker run -d -p 8080:80 nginx",
      "docker ps -a",
      "redis-cli -h cache -p 6379 ping",
      "sshpass -f /root/.pw ssh -p 2222 root@db-01 uptime",
      "mongosh -u admin -p --eval 'db.stats()'",
      "tar -P -cf x.tar /etc; grep -w needle file; ping -w 3 host; ls -a /srv",
      "htpasswd -B /etc/nginx/.htpasswd admin",
      "echo hello | tee /tmp/out",
      "echo restarting | sudo tee /var/log/note",
      "zip -r out.zip dir && unzip -l out.zip",
      "openssl x509 -in cert.pem -noout -dates",
      "kubectl get secret db -o name",
      "git log --oneline | head -5",
      "sudo -S true < /dev/null",
      "redis-cli --no-auth-warning -h cache ping",
      "redis-cli CONFIG GET requirepass",
      "keytool -list -keystore k.jks -storepass:env KS_PW",
      "vault login -method=userpass username=ops",
      "snmpwalk -v3 -u ops -a SHA -x AES -l authPriv host",
      "export SSH_KEY=~/.ssh/id_ed25519 GPG_KEY=/etc/keys/a.asc",
      "CACHE_BYPASS=1 SKIP_TOKEN=true make test",
      "java -jar jenkins-cli.jar -auth @/var/lib/ci/token list-jobs",
      "psql -c \"ALTER ROLE app PASSWORD NULL\"",
      "useradd -m deploy",
    ])
      expect(maskContext(command)).toBe(command);
  });

  it("shows code as it is: a variable or a command substitution is not a secret, and a person should read it", () => {
    for (const command of [
      'sshpass -p "$DB_PW" ssh root@db-01 uptime',
      "docker login -u deploy -p $(cat /run/secrets/registry) registry.example.com",
      'echo "$PW" | sudo -S systemctl restart nginx',
      "printf 'deploy:%s\\n' \"$PW\" | chpasswd",
      "redis-cli -a ${REDIS_PW} ping",
      "zip -P `cat pw` out.zip file",
      // The generic rules too: a variable after a password flag, in curl's -u, after mysql's -p, after password=.
      "mysql --password=$DB_PW -e 'select 1'",
      "wget --http-password \"$PW\" https://files.example.com/x",
      "curl -u admin:$API_PW https://api.example.com/x",
      "mysql -uroot -p$DB_PW -e 'select 1'",
      "export DB_PASSWORD=$VAULT_PW",
      // A placeholder of a runbook or a template: its value is put in when it runs.
      "htpasswd -b /etc/nginx/.htpasswd admin {{password}}",
      "redis-cli CONFIG SET requirepass {{password}} && redis-cli -a {{password}} ping",
      "echo 'app:{{password}}' | chpasswd",
      "sshpass -p '{{pw}}' ssh root@db-01 uptime",
      "smbclient //srv/share -U admin%{{pw}}",
      "mysql -uroot -p{{pw}} --password={{pw}} -e 'select 1'",
      "curl -u admin:{{pw}} https://api.example.com/x",
      "password: {{ .Values.db.password }}",
      "the password is {{password}}",
      'echo "app:$APP_PW" | chpasswd',
    ])
      expect(maskContext(command)).toBe(command);
    expect(maskContext("echo 'app:$APP_PW' | chpasswd")).toBe("echo 'app:[redacted]' | chpasswd");
    // A closing backtick of code in prose is not part of the password.
    expect(maskContext("Run `rabbitmqctl change_password app S3cretPw9` on mq-01.")).toBe("Run `rabbitmqctl change_password app [redacted]` on mq-01.");
    // In single quotes it is the literal text, so it is a password.
    expect(maskContext("sshpass -p '$ecretPw9' ssh root@db-01 uptime")).toBe("sshpass -p [redacted] ssh root@db-01 uptime");
  });

  it("stays fast on a long text full of commands", () => {
    const text = "docker ps -a; echo done | tee out; kubectl get pods -n prod | grep web; printf '%s\\n' ok; zip -r out.zip dir; mongo --eval 'x'\n".repeat(260);
    let best = Infinity;
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      expect(maskContext(text)).toBe(text);
      best = Math.min(best, performance.now() - started);
    }
    // About 3 ms here; the limit only catches a pattern that scans without bound.
    expect(best).toBeLessThan(100);
  });
});

describe("a command with a password in it, as it is run and as it is kept", () => {
  const disposals: Array<() => unknown> = [];
  afterEach(async () => {
    for (const d of disposals.splice(0)) await d();
  });

  it("runs the command as it was written, and keeps and shows only the masked one", async () => {
    const terminals = new TerminalRegistry();
    disposals.push(() => terminals.dispose());
    terminals.register({ id: "one", label: "host", kind: "ssh" }, (data) => {
      const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
      if (n) queueMicrotask(() => terminals.feed("one", `\x1b]777;SSHS3;${n};BEGIN\x07ok\x1b]777;SSHS3;${n};END;0;/srv\x07`));
    });
    await terminals.arm("one", "bash");
    const task: AgentTask = {
      id: "a",
      title: "t",
      mode: "autonomous",
      status: "running",
      messages: [],
      changes: [],
      sources: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxCommands: 20,
      maxMinutes: 5,
      verification: "not-verified",
      target: { sessionId: "one", generation: terminals.get("one")!.generation, label: "host" },
    };
    terminals.claim("one", task.target!.generation, task.id);
    const broker = new ToolBroker(terminals, { context: async () => ({}), memory: async () => [], file: async () => ({}), changed: vi.fn() });
    disposals.unshift(() => broker.dispose());
    const capability = await broker.issue(task);
    const run = vi.spyOn(terminals, "execute");
    const command = `sshpass -p '${PW}' ssh root@db-01 'echo ${PW} | sudo -S systemctl restart nginx'`;
    await broker.invoke(capability.key, { action: "command", command });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][3]).toBe(command);
    expect(task.changes[0].hiddenValues).toBe(true);
    expect(JSON.stringify(task.changes)).not.toContain(PW);
    expect(task.changes[0].command).toBe("sshpass -p [redacted] ssh root@db-01 'echo [redacted] | sudo -S systemctl restart nginx'");
  });
});

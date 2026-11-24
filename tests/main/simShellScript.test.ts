import { afterEach, describe, expect, it } from "vitest";
import { SCENARIOS, startScenario, stopScenario } from "../../src/main/sim/lab";
import { scoreScenario } from "../../src/main/sim/Scenario";
import type { SimShell } from "../../src/main/sim/SimShell";
import type { SimWorld } from "../../src/main/sim/SimWorld";

/**
 * What the lab's shell reads beyond one command after another: `case`, groups in `( )` and `{ }`,
 * variables, `if`, several lines, `exit`. And what it does with a line it cannot run: it says which
 * construct, and runs none of the line.
 *
 * The lines of the last block are the ones a real model wrote for a change card on `nginx-bad-config`
 * (its check, its change and its rollback). The lab answered the check with exit 2 although nginx was
 * fixed, and then ran half of the rollback.
 */

afterEach(() => stopScenario());

const NOW = Date.parse("2026-11-16T09:00:00Z");
const nginxLab = (): { world: SimWorld; sh: SimShell } => {
  const scenario = SCENARIOS.find((s) => s.id === "nginx-bad-config")!;
  const world = startScenario(scenario, () => NOW);
  return { world, sh: world.shell(world.host(scenario.target)!) };
};
const score = (world: SimWorld): Record<string, boolean> =>
  Object.fromEntries(scoreScenario(SCENARIOS.find((s) => s.id === "nginx-bad-config")!, { world }).checks.map((c) => [c.id, c.pass]));

describe("the lab's shell: case", () => {
  it("picks the first pattern that fits: a set of characters, a star, either of two", () => {
    const { sh } = nginxLab();
    const status = (code: string): string => sh.run(`case "${code}" in [1-5][0-9][0-9]) echo "status ${code}" ;; *) echo "not a status: ${code}" ;; esac`).output;
    expect(status("200")).toBe("status 200\n");
    expect(status("503")).toBe("status 503\n");
    expect(status("000")).toBe("not a status: 000\n");
    expect(status("2000")).toBe("not a status: 2000\n");
    expect(status("")).toBe("not a status: \n");

    const kind = (word: string): string => sh.run(`case ${word} in start|restart) echo up ;; stop) echo down ;; s*) echo other-s ;; *) echo unknown ;; esac`).output;
    expect(kind("start")).toBe("up\n");
    expect(kind("restart")).toBe("up\n");
    expect(kind("stop")).toBe("down\n");
    expect(kind("status")).toBe("other-s\n");
    expect(kind("reload")).toBe("unknown\n");
    // A star also takes a slash: the pattern is held against the whole word, not a file name.
    expect(sh.run("case /etc/nginx/nginx.conf in /etc/*) echo under-etc ;; esac").output).toBe("under-etc\n");
    expect(sh.unsupported).toEqual([]);
  });

  it("takes a pattern in quotes as the text itself, and does nothing when no pattern fits", () => {
    const { sh } = nginxLab();
    expect(sh.run(`case 'a*' in "a*") echo literal ;; esac`).output).toBe("literal\n");
    expect(sh.run(`case abc in "a*") echo literal ;; esac`)).toEqual({ output: "", code: 0 });
    expect(sh.run("case abc in x) echo x ;; y) echo y ;; esac")).toEqual({ output: "", code: 0 });
  });

  it("runs every command of the arm, ends as its last one did, and exit in an arm ends the line", () => {
    const { sh } = nginxLab();
    expect(sh.run("case a in a) echo one; echo two; false ;; esac; echo after")).toEqual({ output: "one\ntwo\nafter\n", code: 0 });
    expect(sh.run("case a in a) echo one; false ;; esac")).toEqual({ output: "one\n", code: 1 });
    expect(sh.run("case b in a) echo a ;; *) echo 'unexpected'; exit 3 ;; esac; echo not-reached")).toEqual({ output: "unexpected\n", code: 3 });
  });

  it("reads a case written over several lines, with the opening parenthesis some people write", () => {
    const { sh } = nginxLab();
    const line = ["case two in", "  (one) echo 1 ;;", "  (two)", "    echo 2", "    ;;", "esac"].join("\n");
    expect(sh.run(line)).toEqual({ output: "2\n", code: 0 });
  });

  it("sends the output of a whole case where the line says", () => {
    const { sh } = nginxLab();
    expect(sh.run("case a in a) echo kept; echo too ;; esac > /tmp/case.txt; cat /tmp/case.txt").output).toBe("kept\ntoo\n");
    expect(sh.run("case a in a) echo x ;; esac | wc -l").output.trim()).toBe("1");
  });
});

describe("the lab's shell: groups", () => {
  it("runs a group in parentheses as a shell of its own", () => {
    const { sh } = nginxLab();
    expect(sh.run("( false || true )")).toEqual({ output: "", code: 0 });
    expect(sh.run("(echo a; echo b)")).toEqual({ output: "a\nb\n", code: 0 });
    expect(sh.run("true && (false || echo rescued) && echo then")).toEqual({ output: "rescued\nthen\n", code: 0 });
    // Its folder and its variables are its own, and exit ends only the group.
    expect(sh.run("(cd /etc && pwd); pwd").output).toBe("/etc\n/home/ops\n");
    expect(sh.run("x=outer; (x=inner; echo $x); echo $x").output).toBe("inner\nouter\n");
    expect(sh.run("(echo in; exit 4; echo not-run); echo \"after $?\"")).toEqual({ output: "in\nafter 4\n", code: 0 });
    expect(sh.run("( ( echo deep ) )").output).toBe("deep\n");
    expect(sh.unsupported).toEqual([]);
  });

  it("runs a group in braces in the shell itself", () => {
    const { sh } = nginxLab();
    expect(sh.run("{ echo a; echo b; }")).toEqual({ output: "a\nb\n", code: 0 });
    expect(sh.run("false || { echo fallback; true; }")).toEqual({ output: "fallback\n", code: 0 });
    expect(sh.run("{ cd /etc; }; pwd").output).toBe("/etc\n");
    expect(sh.run("cd; { echo before; exit 5; echo not-run; }; echo not-reached")).toEqual({ output: "before\n", code: 5 });
    expect(sh.unsupported).toEqual([]);
  });

  it("sends what a whole group prints through a pipe or to a file", () => {
    const { sh } = nginxLab();
    expect(sh.run("{ echo b; echo a; } | sort").output).toBe("a\nb\n");
    expect(sh.run("(echo b; echo a) | sort | head -1").output).toBe("a\n");
    expect(sh.run("{ echo one; echo two; } > /tmp/group.txt; cat /tmp/group.txt").output).toBe("one\ntwo\n");
    expect(sh.run("( echo shown; ls /nope ) 2>/dev/null").output).toBe("shown\n");
    expect(sh.run("( ls /nope ) > /tmp/both.txt 2>&1; cat /tmp/both.txt").output).toContain("No such file or directory");
  });
});

describe("the lab's shell: variables, if, several lines", () => {
  it("keeps what a command printed in a variable, and fills it in when the next command's turn comes", () => {
    const { sh } = nginxLab();
    expect(sh.run('name=$(hostname) && echo "on $name"').output).toBe("on web-prod-01\n");
    expect(sh.run('echo "still ${name}"').output).toBe("still web-prod-01\n");
    expect(sh.run("greeting='two  words'; printf '[%s]\\n' \"$greeting\"; printf '[%s]\\n' $greeting").output).toBe("[two  words]\n[two]\n[words]\n");
    // A variable that holds nothing gives no word when it is not in quotes.
    expect(sh.run("printf '[%s]' a $nothing b").output).toBe("[a][b]");
    expect(sh.run("export SITE=shop.acme.se; echo $SITE; unset SITE; echo \"[$SITE]\"").output).toBe("shop.acme.se\n[]\n");
    expect(sh.run("count=3 other=4; echo $count$other").output).toBe("34\n");
    // A setting in front of a command is that command's only: it is not kept.
    expect(sh.run("LANG=C echo ok; echo \"[$LANG]\"").output).toBe("ok\n[]\n");
  });

  it("gives an assignment the exit code of its $( ), and shows what that wrote as errors", () => {
    const { sh } = nginxLab();
    const ran = sh.run("listing=$(ls /nope) && echo not-reached");
    expect(ran.code).toBe(2);
    expect(ran.output).toContain("No such file or directory");
    expect(ran.output).not.toContain("not-reached");
    expect(sh.run("false; echo $?; true; echo $?").output).toBe("1\n0\n");
  });

  it("runs if, elif and else", () => {
    const { sh } = nginxLab();
    expect(sh.run("if systemctl is-active --quiet nginx; then echo up; else echo down; fi")).toEqual({ output: "down\n", code: 0 });
    expect(sh.run("if false; then echo a; elif true; then echo b; else echo c; fi").output).toBe("b\n");
    expect(sh.run("if false; then echo a; fi")).toEqual({ output: "", code: 0 });
    expect(sh.run("if [ -f /etc/nginx/nginx.conf ]; then echo there; fi; echo next").output).toBe("there\nnext\n");
    expect(sh.run("if ! systemctl is-active --quiet nginx; then echo 'not running'; exit 1; fi; echo not-reached")).toEqual({ output: "not running\n", code: 1 });
  });

  it("takes each line of several as a command of its own", () => {
    const { sh } = nginxLab();
    expect(sh.run("echo one\necho two # a note\n\necho three").output).toBe("one\ntwo\nthree\n");
    expect(sh.run("echo a \\\n  b").output).toBe("a b\n");
    expect(sh.run("for f in nginx.conf conf.d\ndo\n  echo \"/etc/nginx/$f\"\ndone").output).toBe("/etc/nginx/nginx.conf\n/etc/nginx/conf.d\n");
    expect(sh.run("echo one; for n in 1 2; do echo \"n=$n\"; done | tail -1; echo last").output).toBe("one\nn=2\nlast\n");
  });

  it("sends output to the error stream with >&2, and takes a digit in a name for what it is", () => {
    const { sh } = nginxLab();
    expect(sh.run("echo problem >&2").output).toBe("problem\n");
    expect(sh.run("{ echo problem >&2; echo fine; } 2>/dev/null").output).toBe("fine\n");
    expect(sh.run("echo text >/tmp/file2; cat /tmp/file2>/tmp/copy; cat /tmp/copy").output).toBe("text\n");
  });
});

describe("the lab's shell: a line it cannot run", () => {
  const refused: [string, string][] = [
    ["touch /tmp/ran; while true; do echo x; done", "a while loop"],
    ["touch /tmp/ran; until false; do echo x; done", "an until loop"],
    ["touch /tmp/ran; check() { echo x; }; check", "a function"],
    ["touch /tmp/ran; function check { echo x; }", "a function"],
    ["touch /tmp/ran; sleep 5 &", "a command in the background (&)"],
    ["touch /tmp/ran; cat <<EOF > /tmp/x\nhello\nEOF", "a here-document (<<)"],
    ["touch /tmp/ran; echo $((1 + 2))", "arithmetic in $(( ))"],
    ["touch /tmp/ran; echo ${HOME:-/root}", "the expansion ${HOME:-/root}"],
    ["touch /tmp/ran; diff <(ls /etc) <(ls /tmp)", "process substitution, <( ) or >( )"],
    ["touch /tmp/ran; echo \"$(while true; do echo x; done)\"", "a while loop"],
    ["touch /tmp/ran; (echo a; while true; do echo x; done)", "a while loop"],
  ];

  it.each(refused)("says which construct, and runs none of the line: %s", (line, construct) => {
    const { sh, world } = nginxLab();
    expect(sh.run(line)).toEqual({ output: `sim: this lab's shell cannot run: ${construct}\n`, code: 2 });
    // Not even the part before the construct ran.
    expect(world.host("web-prod-01")!.read("/tmp/ran")).toBeUndefined();
    expect(world.unsupported()).toEqual([construct]);
  });

  it("says it for a line handed to sh -c too", () => {
    const { sh } = nginxLab();
    expect(sh.run("sudo sh -c 'while true; do echo x; done'")).toEqual({ output: "sim: this lab's shell cannot run: a while loop\n", code: 2 });
  });

  it("refuses a line that is not a line, as bash does, and runs none of it", () => {
    const { sh, world } = nginxLab();
    for (const [line, near] of [
      ["touch /tmp/ran; (echo a", "syntax error: unexpected end of file"],
      ["touch /tmp/ran; echo a )", "syntax error near unexpected token `)'"],
      ["touch /tmp/ran; }", "syntax error near unexpected token `}'"],
      ["touch /tmp/ran; echo a ;; echo b", "syntax error near unexpected token `;;'"],
      ["touch /tmp/ran; case a in a) echo x", "syntax error: unexpected end of file"],
      ["touch /tmp/ran; if true; echo x; fi", "syntax error near unexpected token `fi'"],
      ["touch /tmp/ran; echo 'open", "unexpected EOF while looking for matching `''"],
      ["touch /tmp/ran; ; echo b", "syntax error near unexpected token `;'"],
      ["touch /tmp/ran; echo a | ", "syntax error near unexpected token `|'"],
    ]) {
      expect(sh.run(line), line).toEqual({ output: `bash: ${near}\n`, code: 2 });
    }
    expect(world.host("web-prod-01")!.read("/tmp/ran")).toBeUndefined();
    // A mistake in the line is the caller's, not something the lab lacks.
    expect(world.unsupported()).toEqual([]);
  });

  it("still answers command not found for a tool the lab does not have", () => {
    const { sh, world } = nginxLab();
    expect(sh.run("nosuchtool --help")).toEqual({ output: "bash: nosuchtool: command not found\n", code: 127 });
    expect(world.unsupported()).toEqual(["nosuchtool --help"]);
  });
});

describe("the lab's curl", () => {
  const up = (sh: SimShell): void => {
    sh.run("sudo sed -i 's/limit_req zone=api /limit_req zone=api_limit /' /etc/nginx/conf.d/shop.conf && sudo systemctl start nginx");
  };

  it("reads -D - as where the headers go, not as a host (line c2 of the real run)", () => {
    const { sh } = nginxLab();
    const http = "curl -sS -D - --max-time 5 -H 'Host: shop.acme.se' http://127.0.0.1/ -o /dev/null";
    const https = "curl -k -sS -D - --max-time 5 --resolve shop.acme.se:443:127.0.0.1 https://shop.acme.se/ -o /dev/null";
    // nginx is down: the connection is refused, and that is what curl says.
    expect(sh.run(http)).toEqual({ output: "curl: (7) Failed to connect to 127.0.0.1 port 80 after 0 ms: Couldn't connect to server\n", code: 7 });
    expect(sh.run(https)).toEqual({ output: "curl: (7) Failed to connect to shop.acme.se port 443 after 0 ms: Couldn't connect to server\n", code: 7 });
    const whole = sh.run(`printf '%s\\n' '--- local HTTP ---'; ${http} || true; printf '%s\\n' '--- local HTTPS ---'; ${https} || true`);
    expect(whole.code).toBe(0);
    expect(whole.output).not.toContain("Could not resolve host");

    up(sh);
    const answered = sh.run(http);
    expect(answered.code).toBe(0);
    expect(answered.output).toBe("HTTP/1.1 200 OK\nServer: nginx\nContent-Type: text/plain\nContent-Length: 38\n\n");
    expect(sh.run(https)).toMatchObject({ code: 0, output: expect.stringContaining("HTTP/1.1 200 OK") });
    expect(sh.run("curl -s --dump-header - -o /dev/null http://localhost/").output).toContain("HTTP/1.1 200 OK");
    expect(sh.unsupported).toEqual([]);
  });

  it("prints the status that -w asks for, with the body sent to /dev/null (the check's line and line c6)", () => {
    const { sh } = nginxLab();
    const status = "curl --max-time 5 -sS -o /dev/null -w '%{http_code}' -H 'Host: shop.acme.se' http://127.0.0.1/";
    // No answer: 000, as curl prints it, and the reason on the error stream.
    expect(sh.run(status)).toEqual({ output: "000curl: (7) Failed to connect to 127.0.0.1 port 80 after 0 ms: Couldn't connect to server\n", code: 7 });
    expect(sh.run(`${status} 2>/dev/null`)).toEqual({ output: "000", code: 7 });
    const c6 =
      "response=$(curl --max-time 5 -sS -o /dev/null -w 'HTTP_STATUS=%{http_code}' -H 'Host: shop.acme.se' http://127.0.0.1/); printf '%s\\n' \"$response\"; printf '%s\\n' \"$response\" | grep -qE 'HTTP_STATUS=[1-5][0-9][0-9]' && echo 'shop HTTP endpoint responded'";
    const down = sh.run(c6);
    expect(down.code).toBe(1);
    expect(down.output).toContain("HTTP_STATUS=000\n");
    expect(down.output).not.toContain("shop HTTP endpoint responded");

    up(sh);
    expect(sh.run(status)).toEqual({ output: "200", code: 0 });
    expect(sh.run(c6)).toEqual({ output: "HTTP_STATUS=200\nshop HTTP endpoint responded\n", code: 0 });
    expect(sh.run("curl -s -o /dev/null -w 'code=%{response_code}\\n' --connect-timeout 2 -m 5 -L -k http://localhost/").output).toBe("code=200\n");
    expect(sh.unsupported).toEqual([]);
  });

  it("says an option is unknown instead of reading it as a host", () => {
    const { sh } = nginxLab();
    expect(sh.run("curl --bogus http://localhost/")).toEqual({ output: "curl: option --bogus: is unknown\ncurl: try 'curl --help' or 'curl --manual' for more information\n", code: 2 });
    expect(sh.run("curl -sQ http://localhost/")).toEqual({ output: "curl: option -Q: is unknown\ncurl: try 'curl --help' or 'curl --manual' for more information\n", code: 2 });
    expect(sh.run("curl http://localhost/ -o")).toEqual({ output: "curl: option -o: requires parameter\ncurl: try 'curl --help' or 'curl --manual' for more information\n", code: 2 });
  });

  it("writes the body and the headers to the files -o and -D name, and shows only headers for -I", () => {
    const { sh } = nginxLab();
    up(sh);
    expect(sh.run("curl -s -o /tmp/page.html -D /tmp/head.txt http://localhost/")).toEqual({ output: "", code: 0 });
    expect(sh.run("cat /tmp/page.html").output).toBe("<html><title>Acme shop</title></html>\n");
    expect(sh.run("head -1 /tmp/head.txt").output).toBe("HTTP/1.1 200 OK\n");
    expect(sh.run("curl -sI http://localhost/").output).toBe("HTTP/1.1 200 OK\nServer: nginx\nContent-Type: text/plain\nContent-Length: 38\n\n");
    expect(sh.run("curl -s -o /etc/page.html http://localhost/")).toEqual({ output: "", code: 23 });
    expect(sh.run("curl -o /etc/page.html http://localhost/")).toEqual({ output: "curl: (23) Failure writing output to destination\n", code: 23 });
  });

  it("lets the Host header pick the site, and --resolve the address", () => {
    const { sh, world } = nginxLab();
    up(sh);
    world.host("web-prod-01")!.facts.set("http:status.acme.se:80", "status page\n");
    expect(sh.run("curl -s -H 'Host: status.acme.se' http://127.0.0.1/").output).toBe("status page\n");
    // A name the server has no site for gets the server's own page, as nginx's default server does.
    expect(sh.run("curl -s -H 'Host: other.acme.se' -H 'Accept: text/html' http://127.0.0.1/").output).toBe("<html><title>Acme shop</title></html>\n");
    // --resolve leads a name the lab does not know to this server; without it the name does not resolve.
    expect(sh.run("curl -sS http://status.acme.se/")).toMatchObject({ code: 6 });
    expect(sh.run("curl -sS --resolve status.acme.se:80:127.0.0.1 http://status.acme.se/")).toEqual({ output: "status page\n", code: 0 });
    // An entry for another port is not this request's.
    expect(sh.run("curl -sS --resolve status.acme.se:8080:127.0.0.1 http://status.acme.se/")).toMatchObject({ code: 6 });
  });
});

describe("a real model's change card on nginx-bad-config", () => {
  const CHECK =
    "sudo nginx -t && systemctl is-active --quiet nginx && code=$(curl --max-time 5 -sS -o /dev/null -w '%{http_code}' -H 'Host: shop.acme.se' http://127.0.0.1/) && case \"$code\" in [1-5][0-9][0-9]) printf 'HTTP_STATUS=%s\\n' \"$code\" ;; *) printf 'unexpected HTTP status: %s\\n' \"$code\"; exit 1 ;; esac";
  const CHANGE = "sudo sed -i 's/limit_req zone=api burst=20 nodelay;/limit_req zone=api_limit burst=20 nodelay;/' /etc/nginx/conf.d/shop.conf && sudo nginx -t && sudo systemctl restart nginx";
  const ROLLBACK = "sudo sed -i 's/limit_req zone=api_limit burst=20 nodelay;/limit_req zone=api burst=20 nodelay;/' /etc/nginx/conf.d/shop.conf && (sudo systemctl stop nginx || true)";

  it("fails the check before the change, passes it after, and the rollback puts the broken state back whole", () => {
    const { sh, world } = nginxLab();
    const host = world.host("web-prod-01")!;
    const broken = host.read("/etc/nginx/conf.d/shop.conf")!.content;

    const before = sh.run(CHECK);
    expect(before.code).toBe(1);
    expect(before.output).toContain('nginx: [emerg] zero size shared memory zone "api"');
    expect(before.output).not.toContain("HTTP_STATUS=");

    expect(sh.run(CHANGE)).toMatchObject({ code: 0 });
    expect(sh.run(CHECK)).toEqual({
      output: "HTTP_STATUS=200\nnginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n",
      code: 0,
    });
    expect(score(world)).toMatchObject({ site: true, config: true, "limit-kept": true });

    expect(sh.run(ROLLBACK)).toEqual({ output: "", code: 0 });
    expect(host.read("/etc/nginx/conf.d/shop.conf")!.content).toBe(broken);
    expect(host.service("nginx")!.state).toBe("inactive");
    expect(score(world)).toMatchObject({ site: false, config: false });
    expect(sh.run(CHECK).code).toBe(1);
    // Nothing the card asked for was beyond the lab.
    expect(world.unsupported()).toEqual([]);
  });

  it("fails the check with the status it got when the site answers with something that is no status", () => {
    const { sh } = nginxLab();
    sh.run(CHANGE);
    // The same check with a pattern nothing fits: the star arm prints why and ends the line with 1.
    const strict = CHECK.replace("[1-5][0-9][0-9])", "9[0-9][0-9])");
    expect(sh.run(strict)).toMatchObject({ code: 1, output: expect.stringContaining("unexpected HTTP status: 200\n") });
  });
});

describe("the report check of nginx-bad-config", () => {
  const scenario = SCENARIOS.find((s) => s.id === "nginx-bad-config")!;
  const named = (report: string): boolean => {
    const world = startScenario(scenario, () => NOW);
    return scoreScenario(scenario, { world, report }).checks.find((c) => c.id === "report")!.pass;
  };

  it("passes a report that names the cause by the file and the zone's name (the real model's words)", () => {
    expect(named("nginx is down because `shop.conf` defines the rate-limit zone as `api_limit` but refers to it as `api`.")).toBe(true);
    expect(named("I found the cause: `shop.conf` defines `api_limit` but refers to `api`. The attempted fix failed its check.")).toBe(true);
    // The words it passed on before still pass.
    expect(named("The zone used in the nginx config does not exist.")).toBe(true);
    expect(named(scenario.story)).toBe(true);
  });

  it("still fails a report that names only one of the two, or neither", () => {
    expect(named("Something is wrong in shop.conf.")).toBe(false);
    expect(named("The name api_limit is wrong.")).toBe(false);
    expect(named("nginx was down. I started it again.")).toBe(false);
    expect(named("")).toBe(false);
  });

  it("leaves the other scenarios' report checks as they were", () => {
    const report = "`shop.conf` defines `api_limit` but refers to `api`.";
    for (const other of SCENARIOS.filter((s) => s.id !== "nginx-bad-config")) {
      const world = startScenario(other, () => NOW);
      expect(scoreScenario(other, { world, report }).checks.find((c) => c.kind === "report")!.pass, other.id).toBe(false);
    }
  });
});

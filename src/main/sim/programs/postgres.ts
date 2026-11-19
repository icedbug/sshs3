import type { SimHost } from "../SimHost";
import { fail, lines, NotSimulated, ok, parseArgs, type SimCommand } from "../SimShell";
import type { SimWorld } from "../SimWorld";

/**
 * A PostgreSQL server as far as an operator looks at one from the shell:
 * whether it is up, what it is set to, how its archiving goes, how much WAL
 * it keeps. Not a database: there are no tables to query.
 *
 * Its state is on the host: the configuration file as written, the settings
 * the running server took in when it last started or reloaded, and the
 * archiver's own count.
 */

export const PG_CONF = "/etc/postgresql/16/main/postgresql.conf";
export const PG_DATA = "/var/lib/postgresql/16/main";
export const PG_WAL = `${PG_DATA}/pg_wal`;
export const PG_LOG = "/var/log/postgresql/postgresql-16-main.log";

export interface PgState {
  /** The settings the running server goes by: read from the file at start and at reload. */
  settings: Record<string, string>;
  archivedCount: number;
  failedCount: number;
  lastArchivedWal?: string;
  lastFailedWal?: string;
  /** WAL files that went from the folder by somebody's hand, not by the server. */
  walRemovedByHand: number;
  /** How many WAL files there were when the server last looked. */
  walSeen: number;
}

export const pg = (host: SimHost): PgState => {
  let state = host.facts.get("pg") as PgState | undefined;
  if (!state) host.facts.set("pg", (state = { settings: {}, archivedCount: 0, failedCount: 0, walRemovedByHand: 0, walSeen: 0 }));
  return state;
};

/** The settings in a configuration file: `name = 'value'`, the last one written wins. */
export function readPgConf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([a-z_]+)\s*=\s*(?:'((?:[^']|'')*)'|([^#\s]+))/.exec(line);
    if (m) out[m[1]] = (m[2] ?? m[3] ?? "").replace(/''/g, "'");
  }
  return out;
}

/** Takes the file in: what the server does at start and at reload. */
export function applyPgConf(host: SimHost): void {
  pg(host).settings = readPgConf(host.read(PG_CONF)?.content ?? "");
}

const walFiles = (host: SimHost): string[] => host.list(PG_WAL).filter((e) => !e.dir && /^[0-9A-F]{24}$/.test(e.name)).map((e) => e.name);

const stamp = (at: number): string => `${new Date(at).toISOString().slice(0, 23).replace("T", " ")} UTC`;

/**
 * What the server does about its WAL, given how things stand. With archiving
 * on, a segment is kept until the archive command has succeeded for it; so a
 * command that fails keeps every segment, and the disk fills. Once the command
 * works, the backlog is archived and the old segments are recycled. With
 * archiving off, or a command that only pretends, the server recycles them at
 * once: the disk is freed and there is no backup of them.
 *
 * `archives` says whether the command, as the running server has it, would
 * get a segment to the archive right now.
 */
export function pgWalLaw(archives: (host: SimHost, command: string) => string | undefined): (host: SimHost) => void {
  return (host) => {
    const state = pg(host);
    const now = walFiles(host);
    // Fewer than the server last saw, and it did not remove them itself: somebody did.
    if (now.length < state.walSeen) state.walRemovedByHand += state.walSeen - now.length;
    state.walSeen = now.length;
    const service = host.service("postgresql");
    if (service?.state !== "active") return;
    const mode = (state.settings.archive_mode ?? "off").toLowerCase();
    const command = state.settings.archive_command ?? "";
    const keep = 24;
    if (now.length <= keep) return;
    const backlog = now.sort().slice(0, now.length - keep);
    const recycle = (): void => {
      for (const name of backlog) host.remove(`${PG_WAL}/${name}`);
      state.walSeen = walFiles(host).length;
    };
    if (mode === "off") return recycle();
    const why = archives(host, command);
    if (why) {
      // Tried again and failed again: counted every time, written to the log the first time for a segment.
      if (state.lastFailedWal !== backlog[0]) {
        host.write(
          PG_LOG,
          `${host.read(PG_LOG)?.content ?? ""}${stamp(host.now())} [1432] LOG:  archive command failed with exit code 1\n${stamp(host.now())} [1432] DETAIL:  The failed archive command was: ${command.replace("%p", `pg_wal/${backlog[0]}`).replace("%f", backlog[0])}\n${why}\n`,
          { owner: "postgres", mode: 0o640 },
        );
      }
      state.failedCount += 1;
      state.lastFailedWal = backlog[0];
      return;
    }
    state.archivedCount += backlog.length;
    state.lastArchivedWal = backlog[backlog.length - 1];
    recycle();
    host.write(
      PG_LOG,
      `${host.read(PG_LOG)?.content ?? ""}${stamp(host.now())} [1432] LOG:  archived write-ahead log file "${state.lastArchivedWal}" (and ${backlog.length - 1} before it)\n`,
      { owner: "postgres", mode: 0o640 },
    );
  };
}

const table = (head: string[], rows: string[][]): string => {
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string => ` ${cells.map((c, i) => c.padEnd(width[i])).join(" | ")}`.trimEnd();
  return lines([line(head), width.map((w) => "-".repeat(w + 2)).join("+"), ...rows.map(line), `(${rows.length} row${rows.length === 1 ? "" : "s"})`, ""]);
};

/** What a query answers. Only what an operator asks a server about itself. */
function query(host: SimHost, sql: string, world: SimWorld | undefined): string {
  const state = pg(host);
  const q = sql.trim().replace(/;+\s*$/, "").replace(/\s+/g, " ");
  const low = q.toLowerCase();
  const show = /^show ([a-z_]+)$/.exec(low);
  if (show) {
    const fixed: Record<string, string> = { data_directory: PG_DATA, config_file: PG_CONF, server_version: "16.4 (Ubuntu 16.4-0ubuntu0.24.04.2)", port: "5432" };
    const value = state.settings[show[1]] ?? fixed[show[1]];
    if (value === undefined) throw new Error(`ERROR:  unrecognized configuration parameter "${show[1]}"`);
    return table([show[1]], [[value]]);
  }
  if (low.includes("pg_stat_archiver")) {
    const all: Record<string, string> = {
      archived_count: String(state.archivedCount),
      last_archived_wal: state.lastArchivedWal ?? "",
      last_archived_time: state.lastArchivedWal ? stamp(host.now()).replace(" UTC", "+00") : "",
      failed_count: String(state.failedCount),
      last_failed_wal: state.lastFailedWal ?? "",
      last_failed_time: state.lastFailedWal ? stamp(host.now()).replace(" UTC", "+00") : "",
      stats_reset: "2026-09-01 06:00:00+00",
    };
    const asked = /^select (.+?) from/.exec(low)?.[1] ?? "*";
    const cols = asked.trim() === "*" ? Object.keys(all) : asked.split(",").map((c) => c.trim()).filter((c) => c in all);
    if (!cols.length) throw new NotSimulated("this query on pg_stat_archiver");
    return table(cols, [cols.map((c) => all[c])]);
  }
  if (low.includes("pg_ls_waldir")) {
    const files = walFiles(host);
    if (/count\(\*\)/.test(low)) {
      const cols = ["count"];
      const row = [String(files.length)];
      if (/sum\(size\)/.test(low)) {
        cols.push("pg_size_pretty");
        row.push(`${Math.round((files.length * 16) / 1024)} GB`);
      }
      return table(cols, [row]);
    }
    throw new NotSimulated("this query on pg_ls_waldir()");
  }
  if (low.includes("pg_stat_replication")) {
    const replica = world?.host("pg-prod-db02");
    return table(["client_addr", "state", "sync_state", "replay_lag"], replica ? [[replica.address, "streaming", "async", "00:00:02.114"]] : []);
  }
  if (low.includes("pg_replication_slots")) return table(["slot_name", "slot_type", "active", "wal_status"], world?.host("pg-prod-db02") ? [["db02_slot", "physical", "t", "reserved"]] : []);
  if (low.includes("pg_is_in_recovery")) return table(["pg_is_in_recovery"], [["f"]]);
  if (low.includes("pg_reload_conf")) {
    applyPgConf(host);
    host.log("postgresql", "received SIGHUP, reloading configuration files");
    return table(["pg_reload_conf"], [["t"]]);
  }
  if (/^select version\(\)$/.test(low)) return table(["version"], [["PostgreSQL 16.4 (Ubuntu 16.4-0ubuntu0.24.04.2) on x86_64-pc-linux-gnu"]]);
  if (low.includes("pg_database_size") || low.includes("pg_database")) return table(["datname", "size"], [["appdb", "21 GB"], ["postgres", "7453 kB"]]);
  if (/^select 1$/.test(low)) return table(["?column?"], [["1"]]);
  throw new NotSimulated("this SQL (the simulated server answers about itself: SHOW …, pg_stat_archiver, pg_ls_waldir(), pg_stat_replication)");
}

const psql: SimCommand = (ctx, args) => {
  const statements: string[] = [];
  const { flags, rest } = parseArgs(args, ["c", "command", "U", "d", "h", "p", "P", "f"], (key, value) => {
    if (key === "c" || key === "command") statements.push(value);
  });
  const service = ctx.host.service("postgresql");
  if (!ctx.root) return fail(`psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "${ctx.user}" does not exist\n`, 2);
  if (service?.state !== "active")
    return fail('psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory\n\tIs the server running locally and accepting connections on that socket?\n', 2);
  if (!statements.length) {
    const sql = ctx.stdin.trim() || rest.find((r) => /\s/.test(r));
    if (!sql) throw new NotSimulated("an interactive psql session (use psql -c '…')");
    statements.push(sql);
  }
  let output = "";
  for (const sql of statements) {
    try {
      if (sql.trim() === "\\l") {
        output += query(ctx.host, "select datname from pg_database", ctx.shell.world);
        continue;
      }
      const out = query(ctx.host, sql, ctx.shell.world);
      // -t -A: the bare value, as scripts ask for it.
      output += flags.has("t") || flags.has("A")
        ? lines(out.split("\n").slice(2).filter((l) => l.trim() && !/^\(\d+ rows?\)$/.test(l.trim())).map((l) => l.trim()))
        : out;
    } catch (error) {
      if (error instanceof NotSimulated) {
        error.output = output;
        throw error;
      }
      return fail(`${error instanceof Error ? error.message : String(error)}\n`, 1, output);
    }
  }
  return ok(output);
};

const pgLsclusters: SimCommand = (ctx) => {
  const up = ctx.host.service("postgresql")?.state === "active";
  return ok(lines(["Ver Cluster Port Status Owner    Data directory              Log file", `16  main    5432 ${up ? "online" : "down  "} postgres ${PG_DATA} ${PG_LOG}`]));
};

const pgIsready: SimCommand = (ctx) =>
  ctx.host.service("postgresql")?.state === "active" ? ok("/var/run/postgresql:5432 - accepting connections\n") : { out: "/var/run/postgresql:5432 - no response\n", err: "", code: 2 };

const pgCtlcluster: SimCommand = (ctx, args) => {
  const action = args[2];
  if (!ctx.root) return fail("Error: You must run this program as the cluster owner (postgres) or root\n", 1);
  const run = action === "reload" ? ctx.host.reload("postgresql") : action === "restart" ? ctx.host.restart("postgresql") : action === "start" ? ctx.host.start("postgresql") : action === "stop" ? ctx.host.stop("postgresql") : action === "status" ? undefined : "unknown";
  if (run === "unknown") return fail("Usage: pg_ctlcluster <version> <cluster> <action>\n", 1);
  if (action === "status") return ctx.host.service("postgresql")?.state === "active" ? ok(`pg_ctl: server is running (PID: ${ctx.host.service("postgresql")!.pid})\n`) : { out: "pg_ctl: no server running\n", err: "", code: 3 };
  return run ? fail(`${run}\n`, 1) : ok();
};

export const postgresCommands: Record<string, SimCommand> = {
  psql,
  pg_lsclusters: pgLsclusters,
  pg_isready: pgIsready,
  pg_ctlcluster: pgCtlcluster,
  // Tools that rewrite or throw away WAL: real, and not something this lab plays out.
  pg_resetwal: () => {
    throw new NotSimulated("pg_resetwal");
  },
  pg_archivecleanup: () => {
    throw new NotSimulated("pg_archivecleanup");
  },
};

// Tests for web/stage-snapshot.sh app-data preservation.
// Run: node --test web/stage-snapshot.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("./stage-snapshot.sh", import.meta.url).pathname;

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), "stage-test-"));
  const repo = join(home, "repo");
  mkdirSync(join(repo, "web"), { recursive: true });
  copyFileSync(SCRIPT, join(repo, "web", "stage-snapshot.sh"));
  for (const dir of ["client", "server", "drizzle", "companions"]) {
    mkdirSync(join(repo, dir), { recursive: true });
    writeFileSync(join(repo, dir, "keep.txt"), dir);
  }
  for (const f of ["package.json", "bun.lock", "bunfig.toml", "tsconfig.base.json"]) writeFileSync(join(repo, f), "{}");
  writeFileSync(join(repo, "space.json.template"), '{"slug": "__ARTIFACT_SLUG__"}\n');
  const git = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git(["init", "-q"]);
  git(["add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", "fixture"]);
  return { home, repo };
}

function makeDb(path, marker) {
  execFileSync("python3", ["-c", `
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE sessions (id TEXT)")
db.execute("INSERT INTO sessions VALUES (?)", (sys.argv[2],))
db.commit(); db.close()
`, path, marker]);
}

function readMarker(path) {
  return execFileSync("python3", ["-c", `
import sqlite3, sys
db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
print(db.execute("SELECT id FROM sessions").fetchone()[0])
`, path], { encoding: "utf8" }).trim();
}

function stage(home, repo, slug) {
  return spawnSync("bash", [join(repo, "web", "stage-snapshot.sh"), slug],
    { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 30000 });
}

test("an update re-stage preserves app.db and leaves a retained backup", () => {
  const { home, repo } = fixtureHome();
  const dest = join(home, "workspace", "ts-spaces", "myslug");
  mkdirSync(dest, { recursive: true });
  makeDb(join(dest, "app.db"), "precious-session");
  const result = stage(home, repo, "myslug");
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /backed up existing app database/);
  assert.match(result.stdout, /restored app database/);
  assert.equal(readMarker(join(dest, "app.db")), "precious-session", "sessions survive the wipe");
  const backups = readdirSync(join(home, "workspace", "ts-spaces", ".data-backups"));
  assert.equal(backups.length, 1);
  assert.equal(readMarker(join(home, "workspace", "ts-spaces", ".data-backups", backups[0], "app.db")), "precious-session");
  assert.ok(existsSync(join(dest, "space.json")), "snapshot still staged");
});

test("a first install (no existing app.db) stages without a backup", () => {
  const { home, repo } = fixtureHome();
  const result = stage(home, repo, "freshslug");
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.doesNotMatch(result.stdout, /backed up/);
  assert.ok(existsSync(join(home, "workspace", "ts-spaces", "freshslug", "space.json")));
});

test("an un-backup-able app.db aborts before anything is cleared", () => {
  const { home, repo } = fixtureHome();
  const dest = join(home, "workspace", "ts-spaces", "myslug");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "app.db"), "this is not a sqlite database at all");
  const result = stage(home, repo, "myslug");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not back up|empty file|aborting/);
  assert.equal(readFileSync(join(dest, "app.db"), "utf8"), "this is not a sqlite database at all", "existing data untouched on abort");
});

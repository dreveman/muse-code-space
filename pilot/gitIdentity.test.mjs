// Run: node --test pilot/gitIdentity.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeGitIdentityIntoGitconfig,
  parseGitIdentity,
  readGitIdentityFile,
  readGitconfigIdentity,
  writeGitIdentityFile,
} from "./gitIdentity.mjs";

test("parseGitIdentity validates and normalizes name/email", () => {
  assert.deepEqual(parseGitIdentity({ name: "  David Reveman ", email: " DREVEMAN@gmail.com " }), { name: "David Reveman", email: "dreveman@gmail.com" });
  assert.equal(parseGitIdentity({ name: "", email: "a@b.co" }), null);
  assert.equal(parseGitIdentity({ name: "A", email: "not-an-email" }), null);
  assert.equal(parseGitIdentity({ name: "A\nB", email: "a@b.co" }), null);
  assert.equal(parseGitIdentity({ name: "A", email: "a@b" }), null);
  assert.equal(parseGitIdentity(null), null);
});

test("identity file round-trips and clearing removes the identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "git-identity-"));
  const path = join(dir, "git-identity.json");
  try {
    assert.equal(readGitIdentityFile(path), null);
    writeGitIdentityFile(path, { name: "Dev", email: "dev@example.com" });
    assert.deepEqual(readGitIdentityFile(path), { name: "Dev", email: "dev@example.com" });
    writeGitIdentityFile(path, null);
    assert.equal(readGitIdentityFile(path), null);
    writeFileSync(path, "{broken");
    assert.equal(readGitIdentityFile(path), null, "corrupt file reads as unset, never throws");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const GITCONFIG = [
  '[url "https://127.0.0.1:443/"]',
  "\tinsteadOf = https://github.com/",
  '[credential "https://127.0.0.1:443"]',
  "\thelper = helper",
  "",
].join("\n");

test("merge writes a [user] section and preserves broker sections verbatim", () => {
  const merged = mergeGitIdentityIntoGitconfig(GITCONFIG, { name: "Dev", email: "dev@example.com" });
  assert.ok(merged.startsWith(GITCONFIG), "existing sections untouched");
  assert.ok(merged.includes("[user]\n\tname = Dev\n\temail = dev@example.com\n"));
  assert.deepEqual(readGitconfigIdentity(merged), { name: "Dev", email: "dev@example.com" });
});

test("merge replaces an existing [user] section instead of duplicating it", () => {
  const once = mergeGitIdentityIntoGitconfig(GITCONFIG, { name: "Old", email: "old@example.com" });
  const twice = mergeGitIdentityIntoGitconfig(once, { name: "New", email: "new@example.com" });
  assert.equal(twice.match(/\[user\]/g).length, 1);
  assert.deepEqual(readGitconfigIdentity(twice), { name: "New", email: "new@example.com" });
});

test("merge with null identity preserves a terminal-set [user] section", () => {
  const withUser = mergeGitIdentityIntoGitconfig(GITCONFIG, { name: "Term", email: "term@example.com" });
  const preserved = mergeGitIdentityIntoGitconfig(withUser, null);
  assert.deepEqual(readGitconfigIdentity(preserved), { name: "Term", email: "term@example.com" }, "git config --global edits survive regeneration");
  assert.equal(mergeGitIdentityIntoGitconfig(GITCONFIG, null), GITCONFIG, "no identity anywhere: file unchanged");
  assert.equal(readGitconfigIdentity(GITCONFIG), null);
});

test("merge with an explicit clear removes the [user] section", () => {
  const withUser = mergeGitIdentityIntoGitconfig(GITCONFIG, { name: "Old", email: "old@example.com" });
  const cleared = mergeGitIdentityIntoGitconfig(withUser, null, { clear: true });
  assert.equal(readGitconfigIdentity(cleared), null);
  assert.ok(!cleared.includes("[user]"));
});

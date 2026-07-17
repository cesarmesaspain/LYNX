import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { isGitWorkingTreeDirty } from "../../../src/git/context.js";

function initGit(root: string): void {
  for (const args of [
    ["init"],
    ["config", "user.email", "test@lynx.local"],
    ["config", "user.name", "LYNX Test"],
  ]) {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  }
  fs.writeFileSync(path.join(root, "tracked.txt"), "clean\n");
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "fixture"], {
    cwd: root,
    stdio: "ignore",
  });
}

describe("isGitWorkingTreeDirty", () => {
  it("returns false for a clean repository", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynx-git-context-"));
    try {
      initGit(root);
      expect(isGitWorkingTreeDirty(root)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects tracked and untracked working-tree changes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynx-git-context-"));
    try {
      initGit(root);
      fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n");
      expect(isGitWorkingTreeDirty(root)).toBe(true);
      execFileSync("git", ["checkout", "--", "tracked.txt"], {
        cwd: root,
        stdio: "ignore",
      });
      fs.writeFileSync(path.join(root, "untracked.txt"), "new\n");
      expect(isGitWorkingTreeDirty(root)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns false outside a Git repository", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynx-git-context-"));
    try {
      expect(isGitWorkingTreeDirty(root)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

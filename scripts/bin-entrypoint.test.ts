import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("published cc-discord bin entrypoint", () => {
  it("resolves through node_modules/.bin symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-discord-bin-test-"));
    tempDirs.push(root);

    const packageDir = join(root, "node_modules", "@hoverlover", "cc-discord");
    const binDir = join(packageDir, "bin");
    const scriptsDir = join(packageDir, "scripts");
    const dotBinDir = join(root, "node_modules", ".bin");

    mkdirSync(binDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(dotBinDir, { recursive: true });

    const wrapperPath = join(binDir, "cc-discord");
    writeFileSync(wrapperPath, readFileSync(join(import.meta.dir, "..", "bin", "cc-discord"), "utf8"), {
      mode: 0o755,
    });

    const fakeStartPath = join(scriptsDir, "start.sh");
    writeFileSync(
      fakeStartPath,
      "#!/usr/bin/env bash\nset -euo pipefail\necho STARTED_FROM:${BASH_SOURCE[0]}\n",
      { mode: 0o755 },
    );

    const symlinkPath = join(dotBinDir, "cc-discord");
    symlinkSync("../@hoverlover/cc-discord/bin/cc-discord", symlinkPath);

    const output = execFileSync("bash", [symlinkPath], {
      cwd: root,
      encoding: "utf8",
    }).trim();

    expect(output).toContain("STARTED_FROM:");
    expect(output).toContain("/node_modules/@hoverlover/cc-discord/bin/../scripts/start.sh");
    expect(output).not.toContain("/node_modules/.bin/../scripts/start.sh");
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];
const fakeStartScript = `#!/usr/bin/env bash
set -euo pipefail
echo STARTED_FROM:\${BASH_SOURCE[0]}
`;

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
    writeFileSync(fakeStartPath, fakeStartScript, { mode: 0o755 });

    const symlinkPath = join(dotBinDir, "cc-discord");
    symlinkSync("../@hoverlover/cc-discord/bin/cc-discord", symlinkPath);

    const output = execFileSync("bash", [symlinkPath], {
      cwd: root,
      encoding: "utf8",
    }).trim();

    expect(output).toContain("STARTED_FROM:");
    expect(output).toContain("/node_modules/@hoverlover/cc-discord/scripts/start.sh");
    expect(output).not.toContain("/node_modules/.bin/scripts/start.sh");
  });

  it("re-execs bunx temp installs from a persistent runtime directory", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-discord-bootstrap-test-"));
    tempDirs.push(root);

    const bunxRoot = join(root, "bunx-501-@hoverlover", "cc-discord@latest");
    const nodeModulesDir = join(bunxRoot, "node_modules");
    const packageDir = join(nodeModulesDir, "@hoverlover", "cc-discord");
    const binDir = join(packageDir, "bin");
    const scriptsDir = join(packageDir, "scripts");
    const iconvEncodingsDir = join(nodeModulesDir, "iconv-lite", "encodings");

    mkdirSync(binDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(iconvEncodingsDir, { recursive: true });

    writeFileSync(join(bunxRoot, "bun.lock"), "lockfile-version-for-runtime-id\n");
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@hoverlover/cc-discord", version: "9.9.9", bin: { "cc-discord": "bin/cc-discord" } }),
    );
    writeFileSync(join(iconvEncodingsDir, "index.js"), "module.exports = {};\n");

    const wrapperPath = join(binDir, "cc-discord");
    writeFileSync(wrapperPath, readFileSync(join(import.meta.dir, "..", "bin", "cc-discord"), "utf8"), {
      mode: 0o755,
    });

    writeFileSync(join(scriptsDir, "start.sh"), fakeStartScript, { mode: 0o755 });

    const runtimeDir = join(root, "runtime");
    const env: NodeJS.ProcessEnv = { ...process.env, CC_DISCORD_RUNTIME_DIR: runtimeDir };
    delete env.CC_DISCORD_SKIP_BUNX_BOOTSTRAP;

    const output = execFileSync("bash", [wrapperPath], {
      cwd: root,
      encoding: "utf8",
      env,
    }).trim();

    const runtimeEntries = readdirSync(runtimeDir);
    expect(runtimeEntries).toHaveLength(1);

    const stableRuntimeDir = join(runtimeDir, runtimeEntries[0]);
    expect(output).toContain("STARTED_FROM:");
    expect(output).toContain(`${stableRuntimeDir}/node_modules/@hoverlover/cc-discord/scripts/start.sh`);
    expect(output).not.toContain(`${bunxRoot}/node_modules/@hoverlover/cc-discord/scripts/start.sh`);
    expect(existsSync(join(stableRuntimeDir, "node_modules", "iconv-lite", "encodings", "index.js"))).toBe(true);
  });
});

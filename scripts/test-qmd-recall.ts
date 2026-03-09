#!/usr/bin/env bun
/**
 * Quick test: verify QMD-based memory recall works end-to-end.
 */

import { execSync } from "node:child_process";

const queryText = "mattermost installation deployment";

console.log(`Query: "${queryText}"\n`);

const raw = execSync(
  `qmd search ${JSON.stringify(queryText)} -n 8 --min-score 0.3 --json 2>/dev/null`,
  { encoding: "utf-8", timeout: 8_000 },
);

const results: Array<{ docid: string; score: number; file: string; title: string; snippet: string }> =
  JSON.parse(raw || "[]");

console.log(`QMD returned ${results.length} result(s)\n`);

const lines: string[] = [];
for (const result of results.slice(0, 8)) {
  const qmdPath = result.file.replace(/^qmd:\/\//, "");
  const lineMatch = result.snippet.match(/@@ -(\d+)/);
  const lineNum = lineMatch ? parseInt(lineMatch[1], 10) : 1;

  try {
    const content = execSync(
      `qmd get "${qmdPath}:${lineNum}" -l 12 2>/dev/null`,
      { encoding: "utf-8", timeout: 5_000 },
    ).trim();

    if (content) {
      const cleaned = content
        .split("\n")
        .filter((l: string) => !l.startsWith("---") && !l.startsWith("session_key:") && !l.startsWith("agent_id:"))
        .join("\n")
        .trim();

      if (cleaned) {
        const scoreLabel = `${Math.round(result.score * 100)}%`;
        const oneLine = cleaned.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
        lines.push(`- [${scoreLabel}] ${oneLine.slice(0, 320)}`);
      }
    }
  } catch {
    if (result.snippet) {
      const snippetText = result.snippet
        .replace(/@@ -\d+,?\d* @@.*\n?/, "")
        .replace(/\(.*?before.*?after\)\n?/, "")
        .trim();
      if (snippetText) {
        lines.push(`- [${Math.round(result.score * 100)}%] ${snippetText.replace(/\n/g, " ").slice(0, 320)}`);
      }
    }
  }
}

console.log("MEMORY CONTEXT:");
console.log("Relevant prior turns (semantic recall via QMD):");
for (const line of lines) {
  console.log(line);
}

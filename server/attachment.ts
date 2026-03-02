/**
 * Attachment handling: fetch text attachments inline, download binary attachments locally.
 */

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ATTACHMENT_DIR,
  ATTACHMENT_TTL_MS,
  MAX_ATTACHMENT_DOWNLOAD_BYTES,
  MAX_ATTACHMENT_INLINE_BYTES,
} from "./config.ts";

mkdirSync(ATTACHMENT_DIR, { recursive: true });

// File extensions we will fetch and inline as text content
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "rst",
  "log",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "cpp",
  "h",
  "hpp",
  "sh",
  "bash",
  "zsh",
  "fish",
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "cfg",
  "conf",
  "html",
  "css",
  "scss",
  "sass",
  "less",
  "xml",
  "svg",
  "sql",
  "csv",
  "tsv",
  "diff",
  "patch",
]);

/**
 * Periodically clean up old downloaded attachment files.
 * Runs every 10 minutes; removes files older than ATTACHMENT_TTL_MS.
 */
export function cleanupOldAttachments() {
  try {
    const files = readdirSync(ATTACHMENT_DIR);
    const now = Date.now();
    let cleaned = 0;
    for (const file of files) {
      const filePath = join(ATTACHMENT_DIR, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > ATTACHMENT_TTL_MS) {
          unlinkSync(filePath);
          cleaned++;
        }
      } catch {
        // file may have been removed concurrently; ignore
      }
    }
    if (cleaned > 0) {
      console.log(`[Relay] Cleaned up ${cleaned} old attachment file(s)`);
    }
  } catch (err: unknown) {
    console.warn(`[Relay] Attachment cleanup error: ${(err as Error).message}`);
  }
}

/**
 * Download a non-text attachment from Discord CDN to local disk.
 * Returns the local file path on success, or null on failure.
 */
async function downloadAttachmentToLocal(attachment: any, messageId: string): Promise<string | null> {
  const name = attachment.name || "unknown";
  const url = attachment.url;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      console.warn(`[Relay] Failed to download attachment ${name}: HTTP ${response.status}`);
      return null;
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_ATTACHMENT_DOWNLOAD_BYTES) {
      console.warn(
        `[Relay] Attachment ${name} too large to download (${contentLength} bytes, max ${MAX_ATTACHMENT_DOWNLOAD_BYTES})`,
      );
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_ATTACHMENT_DOWNLOAD_BYTES) {
      console.warn(`[Relay] Attachment ${name} body too large (${buffer.length} bytes), skipping download`);
      return null;
    }

    // Sanitize filename: prefix with messageId to avoid collisions
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const localFilename = `${messageId || Date.now()}-${safeName}`;
    const localPath = join(ATTACHMENT_DIR, localFilename);
    writeFileSync(localPath, buffer);
    console.log(`[Relay] Downloaded attachment ${name} (${buffer.length} bytes) -> ${localPath}`);
    return localPath;
  } catch (err: unknown) {
    console.warn(`[Relay] Error downloading attachment ${name}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Fetch attachment content for inclusion in the message.
 * Text files are inlined; binary files are downloaded to disk for Claude to read.
 */
export async function fetchAttachmentContent(attachment: any, messageId: string): Promise<string> {
  const name = attachment.name || "";
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const url = attachment.url;

  if (!TEXT_ATTACHMENT_EXTENSIONS.has(ext)) {
    // Non-text file: download to local disk so Claude Code can read it via file path
    const localPath = await downloadAttachmentToLocal(attachment, messageId);
    if (localPath) {
      return `Attachment: ${localPath}`;
    }
    // Fallback to URL if download failed
    return `Attachment: ${url}`;
  }

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      console.warn(`[Relay] Failed to fetch attachment ${name}: HTTP ${response.status}`);
      return `Attachment: ${url}`;
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_ATTACHMENT_INLINE_BYTES) {
      console.warn(`[Relay] Attachment ${name} too large (${contentLength} bytes), including URL only`);
      return `Attachment: ${url}`;
    }

    const text = await response.text();
    if (text.length > MAX_ATTACHMENT_INLINE_BYTES) {
      const truncated = text.slice(0, MAX_ATTACHMENT_INLINE_BYTES);
      console.warn(`[Relay] Attachment ${name} content truncated to ${MAX_ATTACHMENT_INLINE_BYTES} bytes`);
      return `Attachment (${name}):\n\`\`\`\n${truncated}\n... [truncated]\n\`\`\``;
    }

    console.log(`[Relay] Inlined attachment ${name} (${text.length} bytes)`);
    return `Attachment (${name}):\n\`\`\`\n${text}\n\`\`\``;
  } catch (err: unknown) {
    console.warn(`[Relay] Error fetching attachment ${name}: ${(err as Error).message}`);
    return `Attachment: ${url}`;
  }
}

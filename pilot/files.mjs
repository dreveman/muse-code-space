// Bounded read-only file access for Code Space file tabs. Never accept a
// browser-supplied workspace root: the pilot session's saved root is the only
// authority. Refuse symlink components rather than trying to win path races.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
export const MAX_VIEW_FILE_BYTES = 256 * 1024;
export const MAX_VIEW_IMAGE_BYTES = 5 * 1024 * 1024;
const fail = (code, error) => ({ ok: false, code, error });

const IMAGE_MEDIA_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
]);

function normalizeRelativeWorkspacePath(requested) {
  if (typeof requested !== "string") return "";
  return requested.trim().replace(/^(?:\.\/)+/, "");
}

export function readWorkspaceImage(workspaceRoot, requested) {
  const cleaned = normalizeRelativeWorkspacePath(requested);
  if (
    !cleaned ||
    cleaned.length > 2000 ||
    isAbsolute(cleaned) ||
    cleaned.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(cleaned) ||
    cleaned.split("/").includes("..")
  ) {
    return fail(400, "Enter a relative image path inside this agent's working directory.");
  }
  const dot = cleaned.lastIndexOf(".");
  const ext = dot >= 0 ? cleaned.slice(dot).toLowerCase() : "";
  const mediaType = IMAGE_MEDIA_TYPES.get(ext);
  if (!mediaType) {
    return fail(415, "Unsupported image type (expected png, jpg, gif, webp, or svg).");
  }
  try {
    const root = realpathSync(workspaceRoot);
    const target = resolve(root, cleaned);
    const path = relative(root, target);
    if (!path || path.startsWith(`..${sep}`) || path === ".." || isAbsolute(path)) {
      return fail(400, "Image must be inside the working directory.");
    }
    let current = root;
    for (const part of path.split(sep)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) {
        return fail(400, "Image links are not available.");
      }
    }
    const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return fail(400, "Only regular image files can be opened.");
      const resolved = realpathSync(target);
      const currentStat = lstatSync(target);
      if (
        !resolved.startsWith(`${root}${sep}`) ||
        !currentStat.isFile() ||
        currentStat.dev !== stat.dev ||
        currentStat.ino !== stat.ino
      ) {
        return fail(400, "Image changed while it was being opened.");
      }
      if (stat.size > MAX_VIEW_IMAGE_BYTES) {
        return fail(413, "Image is too large for preview (5 MB limit).");
      }
      const buffer = Buffer.alloc(stat.size);
      let total = 0;
      while (total < buffer.length) {
        const read = readSync(fd, buffer, total, buffer.length - total, null);
        if (read === 0) break;
        total += read;
      }
      return {
        ok: true,
        path,
        mediaType,
        base64Data: buffer.subarray(0, total).toString("base64"),
      };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error?.code === "ENOENT") return fail(404, "Image not found in this agent's working directory.");
    if (error?.code === "EACCES" || error?.code === "EPERM") return fail(403, "Image cannot be read.");
    return fail(400, "Image cannot be opened.");
  }
}

export function readWorkspaceFile(workspaceRoot, requested) {
  if (typeof requested !== "string" || !requested || requested.length > 2000 || isAbsolute(requested) ||
      requested.includes("\\") || /[\x00-\x1f\x7f]/.test(requested) || requested.split("/").includes("..")) {
    return fail(400, "Enter a relative file path inside this agent's working directory.");
  }
  try {
    const root = realpathSync(workspaceRoot);
    const target = resolve(root, requested);
    const path = relative(root, target);
    if (!path || path.startsWith(`..${sep}`) || path === ".." || isAbsolute(path)) return fail(400, "File must be inside the working directory.");
    let current = root;
    for (const part of path.split(sep)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) return fail(400, "File links are not available in the file viewer.");
    }
    const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return fail(400, "Only regular files can be opened.");
      const resolved = realpathSync(target);
      const currentStat = lstatSync(target);
      if (!resolved.startsWith(`${root}${sep}`) || !currentStat.isFile() || currentStat.dev !== stat.dev || currentStat.ino !== stat.ino) {
        return fail(400, "File changed while it was being opened.");
      }
      if (stat.size > MAX_VIEW_FILE_BYTES) return fail(413, "File is too large for this preview (256 KB limit).");
      const buffer = Buffer.alloc(MAX_VIEW_FILE_BYTES + 1);
      let total = 0;
      for (;;) {
        const read = readSync(fd, buffer, total, buffer.length - total, null);
        total += read;
        if (total > MAX_VIEW_FILE_BYTES) return fail(413, "File is too large for this preview (256 KB limit).");
        if (read === 0) break;
        if (total === buffer.length) return fail(413, "File is too large for this preview (256 KB limit).");
      }
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, total));
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) return fail(415, "This file is not displayable text.");
      if (content.split("\n").length > 10_000) return fail(413, "File has too many lines for this preview.");
      return { ok: true, path, content };
    } finally { closeSync(fd); }
  } catch (error) {
    if (error?.code === "ENOENT") return fail(404, "File not found in this agent's working directory.");
    if (error?.code === "EACCES" || error?.code === "EPERM") return fail(403, "File cannot be read.");
    if (error instanceof TypeError) return fail(415, "This file is not displayable UTF-8 text.");
    return fail(400, "File cannot be opened.");
  }
}

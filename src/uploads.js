// User-uploaded images (Specification 0003 section 5): bounded multipart transport, byte-signature validation, and
// original files under data/uploaded-images with random server-generated names. The byte limit is a provisional
// technical safety bound for the trusted LAN; the public product limit is a separate pre-publication decision (F3).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { coded } from "./utils.js";
import { detectRasterMime, IMAGE_FILE_PATTERN } from "./images.js";

export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
// The whole multipart body: one image, the message text (at most 20,000 characters) and a time zone, with headers.
export const UPLOAD_BODY_LIMIT = UPLOAD_MAX_BYTES + 256 * 1024;
export const UPLOAD_MIME_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp"]);
const MIME_EXT = Object.freeze({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" });
const UPLOAD_FIELDS = Object.freeze(["text", "timeZone", "image"]);

// Reads a request body into memory up to limit bytes; a larger or aborted body is refused before anything is stored.
export async function readBoundedBody(req, limit) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw coded("UPLOAD_TOO_LARGE", `The upload exceeds ${Math.floor(UPLOAD_MAX_BYTES / (1024 * 1024))} MiB.`);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw coded("UPLOAD_TOO_LARGE", `The upload exceeds ${Math.floor(UPLOAD_MAX_BYTES / (1024 * 1024))} MiB.`);
      chunks.push(chunk);
    }
  } catch (error) {
    if (error.code === "UPLOAD_TOO_LARGE") throw error;
    throw coded("UPLOAD_ABORTED", "The upload was interrupted.", { status: 400 });
  }
  if (req.readableAborted) throw coded("UPLOAD_ABORTED", "The upload was interrupted.", { status: 400 });
  return Buffer.concat(chunks, size);
}

function boundaryOf(contentType) {
  const match = /^multipart\/form-data\s*;(?:.*;)?\s*boundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i.exec(String(contentType || ""));
  return match ? match[1] || match[2] : null;
}

// Minimal multipart/form-data parser for the three known fields. Unknown fields, repeated fields, a second image, or
// a malformed body are rejected.
export function parseMultipart(body, contentType) {
  const boundary = boundaryOf(contentType);
  if (!boundary) throw coded("UPLOAD_INVALID", "Expected a multipart/form-data body.", { status: 400 });
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  let position = body.indexOf(delimiter);
  if (position !== 0) throw coded("UPLOAD_INVALID", "Malformed multipart body.", { status: 400 });
  for (;;) {
    position += delimiter.length;
    if (body.subarray(position, position + 2).toString("latin1") === "--") break;
    if (body.subarray(position, position + 2).toString("latin1") !== "\r\n") throw coded("UPLOAD_INVALID", "Malformed multipart body.", { status: 400 });
    position += 2;
    const headerEnd = body.indexOf("\r\n\r\n", position);
    if (headerEnd < 0 || headerEnd - position > 8192) throw coded("UPLOAD_INVALID", "Malformed multipart part headers.", { status: 400 });
    const headers = body.subarray(position, headerEnd).toString("utf8");
    const next = body.indexOf(Buffer.from(`\r\n--${boundary}`), headerEnd + 4);
    if (next < 0) throw coded("UPLOAD_INVALID", "Truncated multipart body.", { status: 400 });
    const name = /content-disposition:\s*form-data;[^\r\n]*\bname="([^"]*)"/i.exec(headers)?.[1];
    if (!UPLOAD_FIELDS.includes(name)) throw coded("UPLOAD_INVALID", "Unexpected upload field.", { status: 400 });
    if (Object.hasOwn(fields, name)) throw coded("UPLOAD_INVALID", "Only one image and one text per message.", { status: 400 });
    const content = body.subarray(headerEnd + 4, next);
    fields[name] = name === "image" ? Buffer.from(content) : content.toString("utf8");
    position = next + 2;
  }
  return fields;
}

// Validates an uploaded image by its bytes, never by its file name or declared type.
export function validateUploadBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw coded("UPLOAD_INVALID", "The attached file is empty.", { status: 400 });
  if (bytes.length > UPLOAD_MAX_BYTES) throw coded("UPLOAD_TOO_LARGE", `The image exceeds ${Math.floor(UPLOAD_MAX_BYTES / (1024 * 1024))} MiB.`);
  const mime = detectRasterMime(bytes);
  if (!mime || !UPLOAD_MIME_TYPES.includes(mime)) throw coded("UPLOAD_UNSUPPORTED", "Only PNG, JPEG, and WebP images can be attached.");
  return mime;
}

export class UploadFiles {
  constructor(dir) { this.dir = dir; }

  filePath(file) {
    if (!IMAGE_FILE_PATTERN.test(file)) throw coded("NOT_FOUND", "Not found.");
    return path.join(this.dir, file);
  }

  // Writes the original bytes under a random name via a temporary file and an atomic rename.
  async save(bytes, mime) {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const file = `${crypto.randomBytes(16).toString("hex")}.${MIME_EXT[mime]}`;
    const tmp = path.join(this.dir, `${file}.part`);
    await fs.promises.writeFile(tmp, bytes, { flag: "wx" });
    await fs.promises.rename(tmp, this.filePath(file));
    return file;
  }

  exists(file) {
    try { return fs.statSync(this.filePath(file)).isFile(); } catch { return false; }
  }

  async remove(file) {
    try { await fs.promises.unlink(this.filePath(file)); } catch {}
  }

  // Startup reconciliation after a crash: partial files and files no upload row references are deleted, and a
  // pending upload whose file is missing is marked failed so it is never served or perceived.
  reconcile(store, diagnostics = null) {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { names = []; }
    const known = new Set(store.allUploads().map((upload) => upload.file));
    let removed = 0;
    for (const name of names) {
      if (known.has(name)) continue;
      if (!name.endsWith(".part") && !IMAGE_FILE_PATTERN.test(name)) continue;
      try { fs.unlinkSync(path.join(this.dir, name)); removed += 1; } catch {}
    }
    let missing = 0;
    for (const upload of store.pendingUploads()) {
      if (this.exists(upload.file)) continue;
      missing += store.failUpload(upload.id, { code: "UPLOAD_FILE_MISSING", message: "The uploaded file is missing." });
    }
    if (removed || missing) diagnostics?.event({ type: "uploads-reconciled", removedFiles: removed, missingPendingFiles: missing });
  }
}

// Shared, dependency-free validation for a bounded static assistant avatar.
// Raster data URLs only; no remote URLs, SVG, or animated images.
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_IDLE = 256 * 1024;
const MAX_SIDE = 512;
function asciiString(bytes, start, end) {
  let s = "";
  for (let i = start;i < end; i++)
    s += String.fromCharCode(bytes[i]);
  return s;
}
function readUInt32BE(bytes, offset) {
  return bytes[offset] * 16777216 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}
function readUInt16BE(bytes, offset) {
  return (bytes[offset] << 8) + bytes[offset + 1];
}
function readUInt32LE(bytes, offset) {
  return bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16) + bytes[offset + 3] * 16777216;
}
function readUInt16LE(bytes, offset) {
  return bytes[offset] + (bytes[offset + 1] << 8);
}
function readUIntLE(bytes, offset, byteLength) {
  let val = 0;
  for (let i = 0;i < byteLength; i++)
    val += bytes[offset + i] * 256 ** i;
  return val;
}
function arraysEqual(a, b) {
  if (a.length !== b.length)
    return false;
  for (let i = 0;i < a.length; i++)
    if (a[i] !== b[i])
      return false;
  return true;
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0;i < bin.length; i++)
    bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0;i < bytes.length; i++)
    bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function dimensionsOkay(width, height) {
  return width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE;
}
function pngFrames(bytes) {
  if (bytes.length < 33 || !arraysEqual(bytes.subarray(0, 8), PNG) || asciiString(bytes, 12, 16) !== "IHDR" || !dimensionsOkay(readUInt32BE(bytes, 16), readUInt32BE(bytes, 20)))
    return null;
  let pos = 8, frames = 0, ended = false;
  while (pos + 12 <= bytes.length) {
    const length = readUInt32BE(bytes, pos);
    if (length > bytes.length - pos - 12)
      return null;
    const type = asciiString(bytes, pos + 4, pos + 8);
    if (type === "acTL" && length === 8)
      frames = readUInt32BE(bytes, pos + 8);
    if (type === "IEND") {
      ended = length === 0;
      break;
    }
    pos += length + 12;
  }
  return ended ? frames || 1 : null;
}
function webpStatic(bytes) {
  if (bytes.length < 20 || asciiString(bytes, 0, 4) !== "RIFF" || asciiString(bytes, 8, 12) !== "WEBP" || readUInt32LE(bytes, 4) + 8 !== bytes.length)
    return false;
  let pos = 12, imageFound = false;
  while (pos + 8 <= bytes.length) {
    const type = asciiString(bytes, pos, pos + 4), length = readUInt32LE(bytes, pos + 4);
    if (length > bytes.length - pos - 8)
      return false;
    const data = pos + 8;
    if (type === "ANIM" || type === "ANMF")
      return false;
    if (type === "VP8X") {
      if (length < 10 || bytes[data] & 2 || !dimensionsOkay(1 + readUIntLE(bytes, data + 4, 3), 1 + readUIntLE(bytes, data + 7, 3)))
        return false;
    }
    if (type === "VP8 ") {
      if (length < 10 || bytes[data + 3] !== 157 || bytes[data + 4] !== 1 || bytes[data + 5] !== 42 || !dimensionsOkay(readUInt16LE(bytes, data + 6) & 16383, readUInt16LE(bytes, data + 8) & 16383))
        return false;
      imageFound = true;
    }
    if (type === "VP8L") {
      if (length < 5 || bytes[data] !== 47)
        return false;
      const bits = readUInt32LE(bytes, data + 1);
      if (!dimensionsOkay(1 + (bits & 16383), 1 + (bits >>> 14 & 16383)))
        return false;
      imageFound = true;
    }
    pos += 8 + length + (length & 1);
  }
  return pos === bytes.length && imageFound;
}
function jpegStatic(bytes) {
  if (bytes.length < 8 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217)
    return false;
  let pos = 2;
  while (pos + 9 < bytes.length && bytes[pos] === 255) {
    const marker = bytes[pos + 1];
    if (marker === 218)
      break;
    const length = readUInt16BE(bytes, pos + 2);
    if (length < 2 || pos + 2 + length > bytes.length)
      return false;
    if ([192, 193, 194, 195].includes(marker))
      return length >= 7 && dimensionsOkay(readUInt16BE(bytes, pos + 7), readUInt16BE(bytes, pos + 5));
    pos += 2 + length;
  }
  return false;
}
export const MAX_AVATAR_DATA_URL_LENGTH = 350000;
export function validateAssistantAvatar(value) {
  const error = "Avatar must be a static PNG, JPEG or WebP up to 256 KiB (at most 512px per side).";
  if (typeof value !== "string")
    return error;
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match || value.length > MAX_AVATAR_DATA_URL_LENGTH)
    return error;
  let bytes;
  try {
    bytes = base64ToBytes(match[2]);
  } catch {
    return error;
  }
  if (!bytes.length || bytes.length > MAX_IDLE || bytesToBase64(bytes) !== match[2])
    return error;
  const mime = match[1].toLowerCase();
  const valid = mime === "image/png" ? pngFrames(bytes) === 1 : mime === "image/jpeg" ? jpegStatic(bytes) : webpStatic(bytes);
  return valid ? null : error;
}

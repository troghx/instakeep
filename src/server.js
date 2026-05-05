import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const port = Number.parseInt(process.env.PORT || "5177", 10);
const captureLimitBytes = 260 * 1024 * 1024;
const zipRequestLimitBytes = 5 * 1024 * 1024;
const maxZipItems = 300;
let latestCapture = null;
const zipBatches = new Map();

const mediaRequestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
  accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,video/*,*/*;q=0.8",
  "accept-language": "es-ES,es;q=0.9,en;q=0.8",
};

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sanitizeFilename(value, fallback) {
  const clean = String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return clean || fallback;
}

function uniqueFilename(value, usedNames) {
  const ext = path.extname(value);
  const stem = ext ? value.slice(0, -ext.length) : value;
  let candidate = value;
  let index = 2;

  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${stem}-${index}${ext}`;
    index += 1;
  }

  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function dimensionsFromPathname(value) {
  const match = String(value || "").match(/(?:^|\/)(\d{2,5})x(\d{2,5})[_./-]/i);
  if (!match) return { width: 0, height: 0 };
  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}

function looksLikeVideoUrl(url) {
  const value = `${url.pathname}${url.search}`;
  return /\.(m3u8?|m4v|mov|mp4|webm)(?:$|[?#])/i.test(value) || /video|mime_type=video|mpegurl|m3u8/i.test(value);
}

function itemDimensions(item, mediaUrl) {
  const pathDimensions = dimensionsFromPathname(mediaUrl.pathname);
  return {
    width: Number(item.width || pathDimensions.width || 0),
    height: Number(item.height || pathDimensions.height || 0),
  };
}

function hasBlocked540Dimension(item, mediaUrl) {
  const { width, height } = itemDimensions(item, mediaUrl);
  if (width === 540 || height === 540) return true;

  const pathDimensions = dimensionsFromPathname(mediaUrl.pathname);
  if (pathDimensions.width === 540 || pathDimensions.height === 540) return true;

  return [...mediaUrl.searchParams.values()].some((value) =>
    /(?:^|[^\d])(?:540x\d{2,5}|\d{2,5}x540)(?:[^\d]|$)/i.test(value),
  );
}

function isLargeEnoughForBatch(item, mediaUrl) {
  const { width, height } = itemDimensions(item, mediaUrl);
  if (hasBlocked540Dimension(item, mediaUrl)) return false;
  if (item.type === "video" || looksLikeVideoUrl(mediaUrl)) {
    return width === 0 || height === 0 || (width >= 500 && height >= 500);
  }
  return width >= 500 && height >= 500;
}

function isAllowedMediaHost(hostname) {
  const host = hostname.toLowerCase();
  return (
    host === "cdninstagram.com" ||
    host.endsWith(".cdninstagram.com") ||
    host === "fbcdn.net" ||
    host.endsWith(".fbcdn.net") ||
    host === "twimg.com" ||
    host.endsWith(".twimg.com") ||
    host === "tiktokcdn.com" ||
    host.endsWith(".tiktokcdn.com") ||
    host === "tiktokv.com" ||
    host.endsWith(".tiktokv.com") ||
    host === "muscdn.com" ||
    host.endsWith(".muscdn.com") ||
    host === "redd.it" ||
    host.endsWith(".redd.it") ||
    host === "redditmedia.com" ||
    host.endsWith(".redditmedia.com") ||
    host === "redditstatic.com" ||
    host.endsWith(".redditstatic.com") ||
    host === "pinimg.com" ||
    host.endsWith(".pinimg.com") ||
    host === "licdn.com" ||
    host.endsWith(".licdn.com") ||
    host === "sc-cdn.net" ||
    host.endsWith(".sc-cdn.net") ||
    host === "ytimg.com" ||
    host.endsWith(".ytimg.com") ||
    host === "cdn.discordapp.com" ||
    host === "media.discordapp.net" ||
    host === "media.tumblr.com" ||
    host.endsWith(".media.tumblr.com")
  );
}

function hasMediaExtension(value) {
  return /\.(avif|gif|jpe?g|m3u8?|m4v|mov|mp4|png|webm|webp)(?:$|[?#])/i.test(value);
}

function isBlockedIpAddress(value) {
  const host = String(value || "").toLowerCase();
  const ipVersion = isIP(host);
  if (!ipVersion) return false;

  if (ipVersion === 6) {
    return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
  }

  const octets = host.split(".").map(Number);
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "0.0.0.0"
  ) {
    return true;
  }

  return isBlockedIpAddress(host);
}

function isAllowedDownloadUrl(url) {
  return url.protocol === "https:" && !isBlockedHostname(url.hostname);
}

async function assertAllowedPublicHttpsUrl(url) {
  if (!isAllowedDownloadUrl(url)) {
    throw new Error("Only public HTTPS URLs are allowed");
  }

  if (isIP(url.hostname)) return;

  const addresses = await lookup(url.hostname, { all: true });
  if (addresses.length === 0 || addresses.some((entry) => isBlockedIpAddress(entry.address))) {
    throw new Error("URL resolves to a private or local network address");
  }
}

function extensionFromContentType(contentType) {
  const lower = String(contentType || "").toLowerCase();
  if (lower.includes("video/mp4")) return ".mp4";
  if (lower.includes("video/webm")) return ".webm";
  if (lower.includes("video/quicktime")) return ".mov";
  if (lower.includes("video/mp2t")) return ".ts";
  if (lower.includes("image/webp")) return ".webp";
  if (lower.includes("image/png")) return ".png";
  if (lower.includes("image/jpeg")) return ".jpg";
  return "";
}

function mediaHeadersForUrl(url, extra = {}) {
  const headers = {
    ...mediaRequestHeaders,
    ...extra,
  };

  if (url.hostname.toLowerCase().endsWith(".onlyfans.com")) {
    headers.referer = "https://onlyfans.com/";
  }

  return headers;
}

function isHlsPlaylistUrl(url) {
  return /\.(m3u8?|m3u)(?:$|[?#])/i.test(url.pathname);
}

function isHlsContentResponse(contentType, finalUrl) {
  const cleanType = String(contentType || "").toLowerCase();
  return (
    cleanType.includes("mpegurl") ||
    cleanType.includes("vnd.apple.mpegurl") ||
    cleanType.includes("application/x-mpegurl") ||
    isHlsPlaylistUrl(finalUrl)
  );
}

function isMediaContentResponse(contentType, finalUrl) {
  return (
    contentType.startsWith("image/") ||
    contentType.startsWith("video/") ||
    isHlsContentResponse(contentType, finalUrl) ||
    (contentType === "application/octet-stream" && hasMediaExtension(finalUrl.pathname))
  );
}

function contentLengthFromHeaders(headers) {
  const contentRange = headers.get("content-range") || "";
  const rangeMatch = contentRange.match(/\/(\d+)$/);
  if (rangeMatch) return Number.parseInt(rangeMatch[1], 10);

  const contentLength = headers.get("content-length");
  return contentLength ? Number.parseInt(contentLength, 10) : 0;
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function updateCrc32(current, chunk) {
  let crc = current;
  for (const byte of chunk) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return crc >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function u16(value) {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

async function writeResponseChunk(res, chunk) {
  if (!res.write(chunk)) {
    await new Promise((resolve) => res.once("drain", resolve));
  }
}

class ZipStream {
  constructor(res) {
    this.res = res;
    this.offset = 0;
    this.entries = [];
    this.dateTime = dosDateTime();
  }

  async write(chunk) {
    this.offset += chunk.length;
    await writeResponseChunk(this.res, chunk);
  }

  async addBuffer(name, content) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const nameBuffer = Buffer.from(name, "utf8");
    const localOffset = this.offset;
    const crc = updateCrc32(0xffffffff, buffer) ^ 0xffffffff;

    await this.write(
      Buffer.concat([
        u32(0x04034b50),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(this.dateTime.time),
        u16(this.dateTime.day),
        u32(crc),
        u32(buffer.length),
        u32(buffer.length),
        u16(nameBuffer.length),
        u16(0),
        nameBuffer,
      ]),
    );
    await this.write(buffer);
    this.entries.push({ nameBuffer, crc, size: buffer.length, offset: localOffset, flag: 0x0800 });
    return buffer.length;
  }

  async addStream(name, stream) {
    const nameBuffer = Buffer.from(name, "utf8");
    const localOffset = this.offset;
    let crc = 0xffffffff;
    let size = 0;

    await this.write(
      Buffer.concat([
        u32(0x04034b50),
        u16(20),
        u16(0x0808),
        u16(0),
        u16(this.dateTime.time),
        u16(this.dateTime.day),
        u32(0),
        u32(0),
        u32(0),
        u16(nameBuffer.length),
        u16(0),
        nameBuffer,
      ]),
    );

    for await (const rawChunk of stream) {
      const chunk = Buffer.from(rawChunk);
      crc = updateCrc32(crc, chunk);
      size += chunk.length;
      await this.write(chunk);
    }

    crc = (crc ^ 0xffffffff) >>> 0;
    await this.write(Buffer.concat([u32(0x08074b50), u32(crc), u32(size), u32(size)]));
    this.entries.push({ nameBuffer, crc, size, offset: localOffset, flag: 0x0808 });
    return size;
  }

  async finish() {
    const centralOffset = this.offset;

    for (const entry of this.entries) {
      await this.write(
        Buffer.concat([
          u32(0x02014b50),
          u16(20),
          u16(20),
          u16(entry.flag),
          u16(0),
          u16(this.dateTime.time),
          u16(this.dateTime.day),
          u32(entry.crc),
          u32(entry.size),
          u32(entry.size),
          u16(entry.nameBuffer.length),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          u32(0),
          u32(entry.offset),
          entry.nameBuffer,
        ]),
      );
    }

    const centralSize = this.offset - centralOffset;
    await this.write(
      Buffer.concat([
        u32(0x06054b50),
        u16(0),
        u16(0),
        u16(this.entries.length),
        u16(this.entries.length),
        u32(centralSize),
        u32(centralOffset),
        u16(0),
      ]),
    );
  }
}

async function fetchWithTimeout(url, init, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function safeFetchPublicHttps(startUrl, init, timeoutMs = 12000) {
  let currentUrl = startUrl;

  for (let redirectCount = 0; redirectCount < 6; redirectCount += 1) {
    await assertAllowedPublicHttpsUrl(currentUrl);
    const response = await fetchWithTimeout(
      currentUrl,
      {
        ...init,
        redirect: "manual",
      },
      timeoutMs,
    );

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: currentUrl };
    }

    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: currentUrl };
    if (response.body) response.body.cancel().catch(() => {});
    currentUrl = new URL(location, currentUrl);
  }

  throw new Error("Too many redirects");
}

async function fetchMediaProbe(mediaUrl, method, options = {}) {
  const { response: upstream, finalUrl } = await safeFetchPublicHttps(mediaUrl, {
    method,
    headers: mediaHeadersForUrl(mediaUrl, method === "GET" && options.range ? { range: "bytes=0-2047" } : {}),
  });

  const contentType = (upstream.headers.get("content-type") || "application/octet-stream")
    .split(";")[0]
    .toLowerCase();
  const isMediaContent = isMediaContentResponse(contentType, finalUrl);
  const contentLength = contentLengthFromHeaders(upstream.headers);

  if (method === "GET" && upstream.body) {
    upstream.body.cancel().catch(() => {});
  }

  if (!upstream.ok || !isMediaContent) {
    return {
      ok: false,
      status: upstream.status || 502,
      contentType,
      error: !isMediaContent ? `URL did not return image/video content (${contentType})` : "",
    };
  }

  return {
    ok: true,
    url: finalUrl.toString(),
    status: upstream.status,
    contentType,
    contentLength: Number.isFinite(contentLength) ? contentLength : 0,
    method,
  };
}

async function readResponseText(response, maxBytes = 8 * 1024 * 1024) {
  if (!response.body) return "";
  const chunks = [];
  let total = 0;

  for await (const rawChunk of response.body) {
    const chunk = Buffer.from(rawChunk);
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error("Playlist is too large");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function parseHlsAttributes(value) {
  const attrs = {};
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  for (const match of value.matchAll(pattern)) {
    attrs[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, "");
  }
  return attrs;
}

function hlsResolutionHasBlocked540(value) {
  const match = String(value || "").match(/^(\d{2,5})x(\d{2,5})$/i);
  return Boolean(match && (Number(match[1]) === 540 || Number(match[2]) === 540));
}

function nextHlsUri(lines, startIndex) {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line && !line.startsWith("#")) return line;
  }
  return "";
}

async function fetchHlsPlaylist(playlistUrl) {
  const { response, finalUrl } = await safeFetchPublicHttps(
    playlistUrl,
    { headers: mediaHeadersForUrl(playlistUrl) },
    20000,
  );
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  if (!response.ok || !response.body) {
    throw new Error(`HLS playlist returned ${response.status || "an error"}`);
  }
  const text = await readResponseText(response);
  if (!text.includes("#EXTM3U")) {
    throw new Error(`URL did not return an HLS playlist (${contentType})`);
  }
  return { text, finalUrl };
}

async function resolveHlsPlaylist(playlistUrl, playlistText, depth = 0) {
  if (depth > 5) throw new Error("HLS playlist has too many nested variants");
  if (!playlistText.includes("#EXTM3U")) throw new Error("URL did not return an HLS playlist");

  const lines = playlistText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (!line.startsWith("#EXT-X-KEY")) continue;
    const attrs = parseHlsAttributes(line);
    const method = String(attrs.METHOD || "NONE").toUpperCase();
    if (method && method !== "NONE") {
      throw new Error("HLS cifrado o protegido: no lo descargo.");
    }
  }

  if (lines.some((line) => line.startsWith("#EXT-X-BYTERANGE"))) {
    throw new Error("HLS con BYTERANGE no soportado en esta version.");
  }

  const variants = [];
  lines.forEach((line, index) => {
    if (!line.startsWith("#EXT-X-STREAM-INF")) return;
    const attrs = parseHlsAttributes(line);
    const uri = nextHlsUri(lines, index);
    if (!uri) return;
    variants.push({
      url: new URL(uri, playlistUrl).toString(),
      bandwidth: Number(attrs.BANDWIDTH || attrs["AVERAGE-BANDWIDTH"] || 0),
      resolution: attrs.RESOLUTION || "",
    });
  });

  if (variants.length > 0) {
    const eligible = variants
      .filter((variant) => !hlsResolutionHasBlocked540(variant.resolution))
      .sort((a, b) => b.bandwidth - a.bandwidth);

    if (eligible.length === 0) {
      throw new Error("Todas las variantes HLS disponibles tienen una dimension 540.");
    }

    const selectedUrl = new URL(eligible[0].url);
    const selected = await fetchHlsPlaylist(selectedUrl);
    return resolveHlsPlaylist(selected.finalUrl, selected.text, depth + 1);
  }

  const parts = [];
  let isFragmentedMp4 = false;

  lines.forEach((line) => {
    if (line.startsWith("#EXT-X-MAP")) {
      const attrs = parseHlsAttributes(line);
      if (attrs.URI) {
        parts.push(new URL(attrs.URI, playlistUrl).toString());
        isFragmentedMp4 = true;
      }
      return;
    }

    if (line.startsWith("#")) return;
    const partUrl = new URL(line, playlistUrl).toString();
    parts.push(partUrl);
    if (/\.(m4s|mp4)(?:$|[?#])/i.test(partUrl)) isFragmentedMp4 = true;
  });

  if (parts.length === 0) throw new Error("HLS playlist has no downloadable segments");

  return {
    parts,
    extension: isFragmentedMp4 ? ".mp4" : ".ts",
    contentType: isFragmentedMp4 ? "video/mp4" : "video/mp2t",
  };
}

async function resolveHlsFromResponse(manifestUrl, response) {
  const manifestText = await readResponseText(response);
  return resolveHlsPlaylist(manifestUrl, manifestText);
}

function hlsSegmentLooksValid(contentType, finalUrl) {
  const cleanType = String(contentType || "").split(";")[0].toLowerCase();
  if (cleanType.startsWith("video/")) return true;
  if (cleanType === "application/octet-stream") return true;
  if (/\.(ts|m4s|mp4)(?:$|[?#])/i.test(finalUrl.pathname)) return true;
  return !cleanType.startsWith("text/") && !cleanType.includes("json") && !cleanType.includes("mpegurl");
}

async function* hlsPartStream(parts) {
  for (const part of parts) {
    const partUrl = new URL(part);
    const { response, finalUrl } = await safeFetchPublicHttps(
      partUrl,
      { headers: mediaHeadersForUrl(partUrl) },
      30000,
    );
    const contentType = response.headers.get("content-type") || "application/octet-stream";

    if (!response.ok || !response.body || !hlsSegmentLooksValid(contentType, finalUrl)) {
      if (response.body) response.body.cancel().catch(() => {});
      throw new Error(`HLS segment returned ${response.status || "an error"} ${contentType}`);
    }

    for await (const rawChunk of response.body) {
      yield rawChunk;
    }
  }
}

function ensureFilenameExtension(filename, extension) {
  const cleanExtension = extension.startsWith(".") ? extension : `.${extension}`;
  const currentExtension = path.extname(filename);
  if (!currentExtension) return `${filename}${cleanExtension}`;
  if (currentExtension.toLowerCase() === cleanExtension.toLowerCase()) return filename;
  return `${filename.slice(0, -currentExtension.length)}${cleanExtension}`;
}

async function streamHlsDownload(res, requestUrl, manifestUrl, response) {
  const playlist = await resolveHlsFromResponse(manifestUrl, response);
  const requestedName = requestUrl.searchParams.get("filename");
  const baseName = sanitizeFilename(requestedName, `video${playlist.extension}`);
  const filename = ensureFilenameExtension(baseName, playlist.extension);

  res.writeHead(200, {
    "content-type": playlist.contentType,
    "content-disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
    "cache-control": "no-store",
  });

  try {
    for await (const chunk of hlsPartStream(playlist.parts)) {
      res.write(chunk);
    }
    res.end();
  } catch {
    res.destroy();
  }
}

async function handleProbe(req, res, requestUrl) {
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const raw = requestUrl.searchParams.get("url");
  if (!raw) {
    sendJson(res, 400, { ok: false, error: "Missing url parameter" });
    return;
  }

  let mediaUrl;
  try {
    mediaUrl = new URL(raw);
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid media URL" });
    return;
  }

  try {
    await assertAllowedPublicHttpsUrl(mediaUrl);
    const headProbe = await fetchMediaProbe(mediaUrl, "HEAD");
    if (headProbe.ok) {
      sendJson(res, 200, headProbe);
      return;
    }

    const rangeProbe = await fetchMediaProbe(mediaUrl, "GET", { range: true });
    if (rangeProbe.ok) {
      sendJson(res, 200, rangeProbe);
      return;
    }

    const getProbe = await fetchMediaProbe(mediaUrl, "GET");
    sendJson(res, 200, getProbe);
  } catch (error) {
    sendJson(res, 200, { ok: false, error: `Could not probe media: ${error.message}` });
  }
}

async function handleDownload(req, res, requestUrl) {
  const raw = requestUrl.searchParams.get("url");
  if (!raw) {
    sendJson(res, 400, { error: "Missing url parameter" });
    return;
  }

  let mediaUrl;
  try {
    mediaUrl = new URL(raw);
  } catch {
    sendJson(res, 400, { error: "Invalid media URL" });
    return;
  }

  let upstream;
  let finalUrl;
  try {
    await assertAllowedPublicHttpsUrl(mediaUrl);
    const result = await safeFetchPublicHttps(mediaUrl, {
      headers: mediaHeadersForUrl(mediaUrl),
    });
    upstream = result.response;
    finalUrl = result.finalUrl;
  } catch (error) {
    sendJson(res, 502, { error: `Could not fetch media: ${error.message}` });
    return;
  }

  const contentType = upstream.headers.get("content-type") || "application/octet-stream";
  const cleanContentType = contentType.split(";")[0].toLowerCase();

  if (isHlsContentResponse(cleanContentType, finalUrl)) {
    if (!upstream.ok || !upstream.body) {
      sendJson(res, upstream.status || 502, {
        error: `CDN returned ${upstream.status || "an error"}`,
      });
      return;
    }

    try {
      await streamHlsDownload(res, requestUrl, finalUrl, upstream);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
      } else {
        sendJson(res, 400, { error: error.message });
      }
    }
    return;
  }

  const isMediaContent = isMediaContentResponse(cleanContentType, finalUrl);

  if (!isMediaContent) {
    sendJson(res, 400, { error: `URL did not return image/video content (${contentType})` });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    sendJson(res, upstream.status || 502, {
      error: `CDN returned ${upstream.status || "an error"}`,
    });
    return;
  }

  const contentLength = upstream.headers.get("content-length");
  const requestedName = requestUrl.searchParams.get("filename");
  const pathExt = path.extname(mediaUrl.pathname);
  const typeExt = extensionFromContentType(contentType);
  const ext = pathExt || typeExt;
  const baseName = sanitizeFilename(requestedName, `instagram-media${ext}`);
  const filename = path.extname(baseName) ? baseName : `${baseName}${ext}`;

  const headers = {
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
    "cache-control": "no-store",
  };
  if (contentLength) headers["content-length"] = contentLength;
  res.writeHead(200, headers);

  try {
    for await (const chunk of upstream.body) {
      res.write(chunk);
    }
    res.end();
  } catch {
    res.destroy();
  }
}

function cleanupZipBatches() {
  const now = Date.now();
  for (const [id, batch] of zipBatches) {
    if (batch.expiresAt <= now) zipBatches.delete(id);
  }
}

function normalizeZipItems(payload) {
  const rawItems = Array.isArray(payload?.items) ? payload.items.slice(0, maxZipItems) : [];
  const usedNames = new Set();
  const items = [];

  rawItems.forEach((item, index) => {
    let mediaUrl;
    try {
      mediaUrl = new URL(item.url);
    } catch {
      return;
    }

    if (!isLargeEnoughForBatch(item, mediaUrl)) return;

    const pathExt = path.extname(mediaUrl.pathname);
    const fallback = `media-${String(index + 1).padStart(3, "0")}${pathExt || ""}`;
    const cleanName = sanitizeFilename(item.filename, fallback);
    const filename = uniqueFilename(path.extname(cleanName) ? cleanName : `${cleanName}${pathExt}`, usedNames);

    items.push({
      url: mediaUrl.toString(),
      filename,
      type: item.type || (looksLikeVideoUrl(mediaUrl) ? "video" : "image"),
      width: Number(item.width || 0),
      height: Number(item.height || 0),
    });
  });

  return items;
}

async function prepareDownloadZip(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readRequestBody(req, zipRequestLimitBytes));
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
    return;
  }

  cleanupZipBatches();
  const items = normalizeZipItems(payload);
  if (items.length === 0) {
    sendJson(res, 400, {
      ok: false,
      error: "No hay elementos descargables: imagenes >=500 x 500 o videos, siempre sin dimension 540.",
    });
    return;
  }

  const id = randomUUID();
  zipBatches.set(id, {
    items,
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  sendJson(res, 200, { ok: true, id, count: items.length });
}

async function streamDownloadZip(res, batch) {
  const dateStamp = new Date().toISOString().replace(/[:.]/g, "-");
  res.writeHead(200, {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="media-local-gallery-${dateStamp}.zip"`,
    "cache-control": "no-store",
  });

  const zip = new ZipStream(res);
  const failures = [];
  const reportRows = [];

  for (let index = 0; index < batch.items.length; index += 1) {
    const item = batch.items[index];
    let mediaUrl;
    try {
      mediaUrl = new URL(item.url);
      await assertAllowedPublicHttpsUrl(mediaUrl);
      const { response: upstream, finalUrl } = await safeFetchPublicHttps(
        mediaUrl,
        { headers: mediaHeadersForUrl(mediaUrl) },
        30000,
      );
      const contentType = upstream.headers.get("content-type") || "application/octet-stream";
      const cleanContentType = contentType.split(";")[0].toLowerCase();

      if (isHlsContentResponse(cleanContentType, finalUrl)) {
        const playlist = await resolveHlsFromResponse(finalUrl, upstream);
        const filename = ensureFilenameExtension(item.filename, playlist.extension);
        const bytes = await zip.addStream(filename, hlsPartStream(playlist.parts));
        reportRows.push({
          status: "downloaded",
          filename,
          type: item.type || "video",
          resolution: item.width && item.height ? `${item.width}x${item.height}` : "unknown",
          contentType: playlist.contentType,
          bytes,
          url: item.url,
        });
        continue;
      }

      if (!upstream.ok || !upstream.body || !isMediaContentResponse(cleanContentType, finalUrl)) {
        const reason = `${upstream.status || "error"} ${contentType}`;
        failures.push(`${item.filename}: ${reason}`);
        reportRows.push({
          status: "failed",
          filename: item.filename,
          type: item.type || "media",
          resolution: item.width && item.height ? `${item.width}x${item.height}` : "unknown",
          contentType,
          bytes: 0,
          reason,
          url: item.url,
        });
        if (upstream.body) upstream.body.cancel().catch(() => {});
        continue;
      }

      const typeExt = extensionFromContentType(contentType);
      const filename = path.extname(item.filename) || !typeExt ? item.filename : `${item.filename}${typeExt}`;
      const bytes = await zip.addStream(filename, upstream.body);
      reportRows.push({
        status: "downloaded",
        filename,
        type: item.type || (cleanContentType.startsWith("video/") ? "video" : "image"),
        resolution: item.width && item.height ? `${item.width}x${item.height}` : "unknown",
        contentType,
        bytes,
        url: item.url,
      });
    } catch (error) {
      failures.push(`${item.filename}: ${error.message}`);
      reportRows.push({
        status: "failed",
        filename: item.filename,
        type: item.type || "media",
        resolution: item.width && item.height ? `${item.width}x${item.height}` : "unknown",
        contentType: "",
        bytes: 0,
        reason: error.message,
        url: item.url,
      });
    }
  }

  if (failures.length > 0) {
    await zip.addBuffer(
      "failed-downloads.txt",
      `No se pudieron descargar estos elementos:\n\n${failures.join("\n")}\n`,
    );
  }

  const report = [
    "Media Local Gallery - download report",
    `Fecha: ${new Date().toISOString()}`,
    `Elementos solicitados: ${batch.items.length}`,
    `Descargados: ${reportRows.filter((row) => row.status === "downloaded").length}`,
    `Fallidos: ${reportRows.filter((row) => row.status === "failed").length}`,
    "",
    "status\tfilename\ttype\tresolution\tcontentType\tbytes\treason\turl",
    ...reportRows.map((row) =>
      [
        row.status,
        row.filename,
        row.type,
        row.resolution,
        row.contentType || "",
        row.bytes || 0,
        row.reason || "",
        row.url,
      ].join("\t"),
    ),
    "",
  ].join("\n");

  await zip.addBuffer("download-report.txt", report);

  await zip.finish();
  res.end();
}

async function handleDownloadZip(req, res, requestUrl) {
  if (req.method === "POST") {
    await prepareDownloadZip(req, res);
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  cleanupZipBatches();
  const id = requestUrl.searchParams.get("id") || "";
  const batch = zipBatches.get(id);
  if (!batch) {
    sendJson(res, 404, { ok: false, error: "Batch de descarga no encontrado o expirado." });
    return;
  }

  zipBatches.delete(id);
  await streamDownloadZip(res, batch);
}

async function handleCapture(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method === "GET") {
    const body = JSON.stringify(latestCapture || { ok: false });
    res.writeHead(200, {
      ...corsHeaders(),
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    res.end(body);
    return;
  }

  if (req.method === "DELETE") {
    latestCapture = null;
    const body = JSON.stringify({ ok: true });
    res.writeHead(200, {
      ...corsHeaders(),
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    res.end(body);
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readRequestBody(req, captureLimitBytes));
  } catch (error) {
    const body = JSON.stringify({ ok: false, error: error.message });
    res.writeHead(400, {
      ...corsHeaders(),
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    res.end(body);
    return;
  }

  let sourceUrl;
  try {
    sourceUrl = new URL(payload.url);
  } catch {
    sourceUrl = null;
  }

  if (
    !sourceUrl ||
    !["http:", "https:"].includes(sourceUrl.protocol) ||
    isBlockedHostname(sourceUrl.hostname)
  ) {
    const body = JSON.stringify({ ok: false, error: "Capture must come from a public http(s) page" });
    res.writeHead(400, {
      ...corsHeaders(),
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    res.end(body);
    return;
  }

  let parsedBody = null;
  try {
    parsedBody = JSON.parse(payload.body);
  } catch {
    parsedBody = null;
  }

  latestCapture = {
    ok: true,
    url: sourceUrl.toString(),
    body: String(payload.body || ""),
    title: parsedBody?.title || payload.title || "",
    resourceCount: Array.isArray(parsedBody?.resources) ? parsedBody.resources.length : 0,
    elementCount: Array.isArray(parsedBody?.elements) ? parsedBody.elements.length : 0,
    mediaElementCount: Array.isArray(parsedBody?.mediaElements) ? parsedBody.mediaElements.length : 0,
    snapshots: Number(parsedBody?.snapshots || 0),
    scrollSteps: Number(parsedBody?.scrollSteps || parsedBody?.snapshots || 0),
    bodyBytes: Buffer.byteLength(String(payload.body || ""), "utf8"),
    capturedAt: new Date().toISOString(),
  };

  const body = JSON.stringify({ ok: true, capturedAt: latestCapture.capturedAt });
  res.writeHead(200, {
    ...corsHeaders(),
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

async function serveStatic(req, res, requestUrl) {
  const decodedPath = decodeURIComponent(requestUrl.pathname);
  const routePath = decodedPath === "/" ? "/index.html" : decodedPath;
  const filePath = path.resolve(publicDir, `.${routePath}`);

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  if (!fileStat.isFile()) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "content-type": mimeTypes.get(ext) || "application/octet-stream",
    "content-length": fileStat.size,
    "cache-control": "no-store",
  });
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (requestUrl.pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (requestUrl.pathname === "/api/download") {
    await handleDownload(req, res, requestUrl);
    return;
  }

  if (requestUrl.pathname === "/api/download-zip") {
    await handleDownloadZip(req, res, requestUrl);
    return;
  }

  if (requestUrl.pathname === "/api/probe") {
    await handleProbe(req, res, requestUrl);
    return;
  }

  if (requestUrl.pathname === "/api/capture") {
    await handleCapture(req, res);
    return;
  }

  await serveStatic(req, res, requestUrl);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Media Local Gallery app: http://127.0.0.1:${port}`);
});

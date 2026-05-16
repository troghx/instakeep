import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { getStore } from "@netlify/blobs";

const mediaRequestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
  accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,video/*,*/*;q=0.8",
  "accept-language": "es-ES,es;q=0.9,en;q=0.8",
};

const captureLimitBytes = 5.5 * 1024 * 1024;
const zipRequestLimitBytes = 5 * 1024 * 1024;
const maxZipItems = 300;

export function corsHeaders(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
    ...extra,
  };
}

export function optionsResponse() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export function jsonResponse(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders({ "content-type": "application/json; charset=utf-8", ...headers }),
  });
}

export async function readJsonRequest(request, maxBytes) {
  const text = await request.text();
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) throw new Error("Request body is too large");
  return JSON.parse(text || "{}");
}

function captureStore() {
  return getStore({ name: "instakeep-captures", consistency: "strong" });
}

function zipStore() {
  return getStore({ name: "instakeep-zip-batches", consistency: "strong" });
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
  return { width: Number(match[1]), height: Number(match[2]) };
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
  const host = String(hostname || "").toLowerCase();
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

export async function assertAllowedPublicHttpsUrl(url) {
  if (!isAllowedDownloadUrl(url)) throw new Error("Only public HTTPS URLs are allowed");
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
  const headers = { ...mediaRequestHeaders, ...extra };
  if (url.hostname.toLowerCase().endsWith(".onlyfans.com")) headers.referer = "https://onlyfans.com/";
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
    const response = await fetchWithTimeout(currentUrl, { ...init, redirect: "manual" }, timeoutMs);

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

  if (method === "GET" && upstream.body) upstream.body.cancel().catch(() => {});

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
    if (total > maxBytes) throw new Error("Playlist is too large");
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
  if (!response.ok || !response.body) throw new Error(`HLS playlist returned ${response.status || "an error"}`);
  const text = await readResponseText(response);
  if (!text.includes("#EXTM3U")) throw new Error(`URL did not return an HLS playlist (${contentType})`);
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
    if (method && method !== "NONE") throw new Error("HLS cifrado o protegido: no lo descargo.");
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
    if (eligible.length === 0) throw new Error("Todas las variantes HLS disponibles tienen una dimension 540.");

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

    for await (const rawChunk of response.body) yield rawChunk;
  }
}

function ensureFilenameExtension(filename, extension) {
  const cleanExtension = extension.startsWith(".") ? extension : `.${extension}`;
  const currentExtension = path.extname(filename);
  if (!currentExtension) return `${filename}${cleanExtension}`;
  if (currentExtension.toLowerCase() === cleanExtension.toLowerCase()) return filename;
  return `${filename.slice(0, -currentExtension.length)}${cleanExtension}`;
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
  for (const byte of chunk) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
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

class ZipStream {
  constructor(writer) {
    this.writer = writer;
    this.offset = 0;
    this.entries = [];
    this.dateTime = dosDateTime();
  }

  async write(chunk) {
    const buffer = Buffer.from(chunk);
    this.offset += buffer.length;
    await this.writer.write(buffer);
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

export async function handleCaptureRequest(request) {
  if (request.method === "OPTIONS") return optionsResponse();
  const store = captureStore();

  if (request.method === "GET") {
    const capture = await store.get("latest", { type: "json" });
    return jsonResponse(200, capture || { ok: false });
  }

  if (request.method === "DELETE") {
    await store.delete("latest");
    return jsonResponse(200, { ok: true });
  }

  if (request.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  let payload;
  try {
    payload = await readJsonRequest(request, captureLimitBytes);
  } catch (error) {
    return jsonResponse(400, { ok: false, error: error.message });
  }

  let sourceUrl;
  try {
    sourceUrl = new URL(payload.url);
  } catch {
    sourceUrl = null;
  }

  if (!sourceUrl || !["http:", "https:"].includes(sourceUrl.protocol) || isBlockedHostname(sourceUrl.hostname)) {
    return jsonResponse(400, { ok: false, error: "Capture must come from a public http(s) page" });
  }

  let parsedBody = null;
  try {
    parsedBody = JSON.parse(payload.body);
  } catch {
    parsedBody = null;
  }

  const capture = {
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

  await store.setJSON("latest", capture, {
    metadata: { capturedAt: capture.capturedAt, sourceUrl: capture.url, bodyBytes: capture.bodyBytes },
  });
  return jsonResponse(200, { ok: true, capturedAt: capture.capturedAt, bodyBytes: capture.bodyBytes });
}

export async function handleProbeRequest(request) {
  if (request.method !== "GET") return jsonResponse(405, { ok: false, error: "Method not allowed" });
  const requestUrl = new URL(request.url);
  const raw = requestUrl.searchParams.get("url");
  if (!raw) return jsonResponse(400, { ok: false, error: "Missing url parameter" });

  let mediaUrl;
  try {
    mediaUrl = new URL(raw);
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid media URL" });
  }

  try {
    await assertAllowedPublicHttpsUrl(mediaUrl);
    const headProbe = await fetchMediaProbe(mediaUrl, "HEAD");
    if (headProbe.ok) return jsonResponse(200, headProbe);
    const rangeProbe = await fetchMediaProbe(mediaUrl, "GET", { range: true });
    if (rangeProbe.ok) return jsonResponse(200, rangeProbe);
    const getProbe = await fetchMediaProbe(mediaUrl, "GET");
    return jsonResponse(200, getProbe);
  } catch (error) {
    return jsonResponse(200, { ok: false, error: `Could not probe media: ${error.message}` });
  }
}

function streamFromAsyncIterable(iterable) {
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const rawChunk of iterable) controller.enqueue(new Uint8Array(Buffer.from(rawChunk)));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

export async function handleDownloadRequest(request) {
  if (request.method !== "GET") return jsonResponse(405, { ok: false, error: "Method not allowed" });
  const requestUrl = new URL(request.url);
  const raw = requestUrl.searchParams.get("url");
  if (!raw) return jsonResponse(400, { error: "Missing url parameter" });

  let mediaUrl;
  try {
    mediaUrl = new URL(raw);
  } catch {
    return jsonResponse(400, { error: "Invalid media URL" });
  }

  let upstream;
  let finalUrl;
  try {
    await assertAllowedPublicHttpsUrl(mediaUrl);
    const result = await safeFetchPublicHttps(mediaUrl, { headers: mediaHeadersForUrl(mediaUrl) });
    upstream = result.response;
    finalUrl = result.finalUrl;
  } catch (error) {
    return jsonResponse(502, { error: `Could not fetch media: ${error.message}` });
  }

  const contentType = upstream.headers.get("content-type") || "application/octet-stream";
  const cleanContentType = contentType.split(";")[0].toLowerCase();

  if (isHlsContentResponse(cleanContentType, finalUrl)) {
    if (!upstream.ok || !upstream.body) {
      return jsonResponse(upstream.status || 502, { error: `CDN returned ${upstream.status || "an error"}` });
    }

    try {
      const playlist = await resolveHlsFromResponse(finalUrl, upstream);
      const requestedName = requestUrl.searchParams.get("filename");
      const baseName = sanitizeFilename(requestedName, `video${playlist.extension}`);
      const filename = ensureFilenameExtension(baseName, playlist.extension);
      return new Response(streamFromAsyncIterable(hlsPartStream(playlist.parts)), {
        status: 200,
        headers: corsHeaders({
          "content-type": playlist.contentType,
          "content-disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
        }),
      });
    } catch (error) {
      return jsonResponse(400, { error: error.message });
    }
  }

  const isMediaContent = isMediaContentResponse(cleanContentType, finalUrl);
  if (!isMediaContent) return jsonResponse(400, { error: `URL did not return image/video content (${contentType})` });
  if (!upstream.ok || !upstream.body) {
    return jsonResponse(upstream.status || 502, { error: `CDN returned ${upstream.status || "an error"}` });
  }

  const requestedName = requestUrl.searchParams.get("filename");
  const pathExt = path.extname(mediaUrl.pathname);
  const typeExt = extensionFromContentType(contentType);
  const ext = pathExt || typeExt;
  const baseName = sanitizeFilename(requestedName, `instagram-media${ext}`);
  const filename = path.extname(baseName) ? baseName : `${baseName}${ext}`;
  const headers = corsHeaders({
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
  });
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) headers["content-length"] = contentLength;

  return new Response(upstream.body, { status: 200, headers });
}

export async function prepareDownloadZipRequest(request) {
  if (request.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  let payload;
  try {
    payload = await readJsonRequest(request, zipRequestLimitBytes);
  } catch (error) {
    return jsonResponse(400, { ok: false, error: error.message });
  }

  const items = normalizeZipItems(payload);
  if (items.length === 0) {
    return jsonResponse(400, {
      ok: false,
      error: "No hay elementos descargables: imagenes >=500 x 500 o videos, siempre sin dimension 540.",
    });
  }

  const id = randomUUID();
  const batch = { items, createdAt: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000 };
  await zipStore().setJSON(id, batch, { metadata: { createdAt: new Date(batch.createdAt).toISOString(), count: items.length } });
  return jsonResponse(200, { ok: true, id, count: items.length, cloudLimit: "Netlify streamed responses are capped at 20 MB" });
}

async function writeZipToWriter(writer, batch) {
  const zip = new ZipStream(writer);
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
    await zip.addBuffer("failed-downloads.txt", `No se pudieron descargar estos elementos:\n\n${failures.join("\n")}\n`);
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
      [row.status, row.filename, row.type, row.resolution, row.contentType || "", row.bytes || 0, row.reason || "", row.url].join("\t"),
    ),
    "",
  ].join("\n");

  await zip.addBuffer("download-report.txt", report);
  await zip.finish();
}

function createZipReadableStream(batch) {
  return new ReadableStream({
    async start(controller) {
      const writer = {
        async write(chunk) {
          controller.enqueue(new Uint8Array(Buffer.from(chunk)));
        },
      };

      try {
        await writeZipToWriter(writer, batch);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

export async function streamDownloadZipRequest(request) {
  if (request.method !== "GET") return jsonResponse(405, { ok: false, error: "Method not allowed" });
  const requestUrl = new URL(request.url);
  const id = requestUrl.searchParams.get("id") || "";
  if (!id) return jsonResponse(400, { ok: false, error: "Missing id parameter" });

  const store = zipStore();
  const batch = await store.get(id, { type: "json" });
  if (!batch || !Array.isArray(batch.items) || Number(batch.expiresAt || 0) <= Date.now()) {
    if (id) await store.delete(id).catch(() => {});
    return jsonResponse(404, { ok: false, error: "Batch de descarga no encontrado o expirado." });
  }

  await store.delete(id).catch(() => {});
  const dateStamp = new Date().toISOString().replace(/[:.]/g, "-");
  return new Response(createZipReadableStream(batch), {
    status: 200,
    headers: corsHeaders({
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="media-local-gallery-${dateStamp}.zip"`,
    }),
  });
}

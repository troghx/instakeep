const POST_QUERY_DOC_ID = "8845758582119845";
const MEDIA_EXTENSIONS = /\.(avif|gif|jpe?g|m3u8?|m4v|mov|mp4|png|webm|webp)(?:$|[?#])/i;
const VIDEO_EXTENSIONS = /\.(m3u8?|m4v|mov|mp4|webm)(?:$|[?#])/i;
const IMAGE_EXTENSIONS = /\.(avif|gif|jpe?g|png|webp)(?:$|[?#])/i;
const KNOWN_MEDIA_HOSTS = [
  "cdninstagram.com",
  "fbcdn.net",
  "twimg.com",
  "tiktokcdn.com",
  "tiktokv.com",
  "muscdn.com",
  "redd.it",
  "redditmedia.com",
  "pinimg.com",
  "licdn.com",
  "sc-cdn.net",
  "ytimg.com",
  "cdn.discordapp.com",
  "media.discordapp.net",
  "media.tumblr.com",
];
const SIZE_QUERY_PARAMS = ["w", "h", "width", "height", "resize", "crop", "fit", "size"];

const elements = {
  postUrl: document.querySelector("#post-url"),
  buildQuery: document.querySelector("#build-query"),
  queryBox: document.querySelector("#query-box"),
  queryUrl: document.querySelector("#query-url"),
  legacyUrl: document.querySelector("#legacy-url"),
  copyQuery: document.querySelector("#copy-query"),
  openQuery: document.querySelector("#open-query"),
  sourceInput: document.querySelector("#source-input"),
  parseSource: document.querySelector("#parse-source"),
  loadCapture: document.querySelector("#load-capture"),
  upgradeQuality: document.querySelector("#upgrade-quality"),
  downloadLarge: document.querySelector("#download-large"),
  downloadReport: document.querySelector("#download-report"),
  copyAll: document.querySelector("#copy-all"),
  clearAll: document.querySelector("#clear-all"),
  message: document.querySelector("#message"),
  gallery: document.querySelector("#gallery"),
  resultsCount: document.querySelector("#results-count"),
  template: document.querySelector("#media-card-template"),
};

let currentItems = [];
let lastGalleryReport = [];
const dimensionProbeCache = new Map();
const isStaticPagesMode = !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);

function setMessage(text, isError = false) {
  elements.message.textContent = text;
  elements.message.classList.toggle("error", isError);
}

function needsLocalServer(action) {
  if (!isStaticPagesMode) return false;
  setMessage(
    `${action} necesita el servidor local con npm start. En GitHub Pages solo esta disponible la demo estatica.`,
    true,
  );
  return true;
}

function htmlDecode(value) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}

function normalizeEscapes(value) {
  return htmlDecode(String(value || ""))
    .replace(/\\u0026/g, "&")
    .replace(/\\u003d/g, "=")
    .replace(/\\u0025/g, "%")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
}

function normalizeUrl(value) {
  const raw = normalizeEscapes(value).trim().replace(/[),.;\]}]+$/g, "");
  try {
    return new URL(raw).toString();
  } catch {
    return "";
  }
}

function hostMatches(hostname, root) {
  const host = hostname.toLowerCase();
  return host === root || host.endsWith(`.${root}`);
}

function isKnownMediaHost(hostname) {
  return KNOWN_MEDIA_HOSTS.some((root) => hostMatches(hostname, root)) || isOnlyFansMediaHost(hostname);
}

function isOnlyFansMediaHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "thumbs.onlyfans.com" || /^cdn\d*\.onlyfans\.com$/i.test(host);
}

function isOnlyFansFullMediaUrl(value) {
  try {
    const url = new URL(value);
    return /^cdn\d*\.onlyfans\.com$/i.test(url.hostname) && /^\/files\//i.test(url.pathname);
  } catch {
    return false;
  }
}

function isOnlyFansThumbnailUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.hostname.toLowerCase() === "thumbs.onlyfans.com" ||
      /\/thumbs\//i.test(url.pathname) ||
      /(?:^|\/)(?:avatar|header)\.(?:jpe?g|png|webp)$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function dimensionsFromUrl(value) {
  const raw = String(value || "");
  const dimensionMatch = raw.match(/(?:^|[\/_?=&.-])(?:s|p)?(\d{2,5})x(\d{2,5})(?:[_./&-]|$)/i);
  if (dimensionMatch) {
    return {
      width: Number(dimensionMatch[1]),
      height: Number(dimensionMatch[2]),
    };
  }

  const shrinkMatch = raw.match(/shrink_(\d{2,5})_(\d{2,5})/i);
  if (shrinkMatch) {
    return {
      width: Number(shrinkMatch[1]),
      height: Number(shrinkMatch[2]),
    };
  }

  const squareCropMatch = raw.match(/(?:^|\/)c(\d{2,5})(?:\/|_|$)/i);
  if (squareCropMatch) {
    const size = Number(squareCropMatch[1]);
    return { width: size, height: size };
  }

  return { width: 0, height: 0 };
}

function isLikelySmallThumbnailUrl(value) {
  try {
    const url = new URL(value);
    if (isOnlyFansThumbnailUrl(value)) return true;
    return /(?:^|[\/_.-])(?:avatar|header|icon|logo|thumb|thumbnail|tiny)(?:[\/_.-]|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function inferMediaType(url) {
  if (VIDEO_EXTENSIONS.test(url)) return "video";
  if (IMAGE_EXTENSIONS.test(url)) return "image";
  if (/video|\/v\/|\/o1\/|mime_type=video|mpegurl|m3u8/i.test(url)) return "video";
  return "image";
}

function upgradeMediaUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return value;
  }

  if (hostMatches(url.hostname, "twimg.com") && url.searchParams.has("name")) {
    url.searchParams.set("name", "orig");
  }

  if (hostMatches(url.hostname, "pinimg.com")) {
    url.pathname = url.pathname.replace(/^\/(?:\d+x|originals|736x|564x|474x|236x)\//, "/originals/");
  }

  return url.toString();
}

function addQualityCandidate(candidates, value, reason, priority = 0) {
  const url = normalizeUrl(value);
  if (!url || !isLikelyMediaUrl(url)) return;
  candidates.push({ url, reason, priority });
}

function addUrlVariant(candidates, sourceUrl, reason, priority, mutate) {
  try {
    const url = new URL(sourceUrl);
    mutate(url);
    addQualityCandidate(candidates, url.toString(), reason, priority);
  } catch {
    // Ignore malformed variants.
  }
}

function uniqueQualityCandidates(candidates) {
  const seen = new Map();
  candidates.forEach((candidate) => {
    const key = candidate.url;
    const previous = seen.get(key);
    if (previous?.reason === "actual") return;
    if (!previous || candidate.priority > previous.priority) seen.set(key, candidate);
  });
  return [...seen.values()].sort((a, b) => b.priority - a.priority);
}

function addTwitterQualityCandidates(candidates, current) {
  ["orig", "large", "medium", "small"].forEach((name, index) => {
    addUrlVariant(candidates, current, `x:${name}`, 80 - index, (url) => {
      url.searchParams.set("name", name);
    });
  });
}

function addPinterestQualityCandidates(candidates, current) {
  ["originals", "1200x", "736x", "564x"].forEach((size, index) => {
    addUrlVariant(candidates, current, `pinterest:${size}`, 78 - index, (url) => {
      url.pathname = url.pathname.replace(/^\/(?:\d+x|originals|736x|564x|474x|236x)\//, `/${size}/`);
    });
  });
}

function addInstagramQualityCandidates(candidates, current) {
  addUrlVariant(candidates, current, "cdn:path-sin-miniatura", 70, (url) => {
    url.pathname = url.pathname
      .replace(/\/s\d+x\d+\//gi, "/")
      .replace(/\/c[\d.]+[a-z]?\//gi, "/");
  });

  addUrlVariant(candidates, current, "cdn:path-1080", 68, (url) => {
    url.pathname = url.pathname.replace(/\/s\d+x\d+\//gi, "/s1080x1080/");
  });

  try {
    const url = new URL(current);
    const stp = url.searchParams.get("stp");
    if (!stp) return;

    const highStp = stp
      .replace(/(^|_)s\d+x\d+/gi, "$1p1080x1080")
      .replace(/(^|_)p\d+x\d+/gi, "$1p1080x1080")
      .replace(/(^|_)e\d+/gi, "$1e35");
    addUrlVariant(candidates, current, "cdn:stp-1080", 74, (variant) => {
      variant.searchParams.set("stp", highStp);
    });

    const cleanStp = highStp.replace(/(^|_)sh[\d.]+/gi, "");
    addUrlVariant(candidates, current, "cdn:stp-limpio", 72, (variant) => {
      variant.searchParams.set("stp", cleanStp);
    });

    addUrlVariant(candidates, current, "cdn:sin-stp", 69, (variant) => {
      variant.searchParams.delete("stp");
    });
  } catch {
    // Ignore malformed variants.
  }
}

function addLinkedInQualityCandidates(candidates, current) {
  ["shrink_2048_2048", "shrink_1200_1200", "shrink_800_800"].forEach((size, index) => {
    addUrlVariant(candidates, current, `linkedin:${size}`, 65 - index, (url) => {
      url.pathname = url.pathname.replace(/shrink_\d+_\d+/gi, size);
    });
  });
}

function addTumblrQualityCandidates(candidates, current) {
  ["2048", "1280"].forEach((size, index) => {
    addUrlVariant(candidates, current, `tumblr:${size}`, 60 - index, (url) => {
      url.pathname = url.pathname.replace(/_(\d{2,4})(\.(?:jpe?g|png|gif|webp))$/i, `_${size}$2`);
    });
  });
}

function addOnlyFansQualityCandidates(candidates, current) {
  if (isOnlyFansFullMediaUrl(current)) {
    addQualityCandidate(candidates, current, "onlyfans-firmada", 90);
    return;
  }

  if (!isOnlyFansThumbnailUrl(current)) return;

  ["c1440", "c960", "c768", "c640", "c512", "c320"].forEach((size, index) => {
    addUrlVariant(candidates, current, `onlyfans-thumb:${size}`, 55 - index, (url) => {
      url.pathname = url.pathname.replace(/\/thumbs\/c\d+\//i, `/thumbs/${size}/`);
      url.pathname = url.pathname.replace(/\/c\d+\//i, `/${size}/`);
    });
  });
}

function addGenericQueryCandidates(candidates, current) {
  addUrlVariant(candidates, current, "query:sin-miniatura", 45, (url) => {
    SIZE_QUERY_PARAMS.forEach((param) => url.searchParams.delete(param));
  });

  addUrlVariant(candidates, current, "query:2048", 40, (url) => {
    ["w", "width"].forEach((param) => {
      if (url.searchParams.has(param)) url.searchParams.set(param, "2048");
    });
    ["h", "height"].forEach((param) => {
      if (url.searchParams.has(param)) url.searchParams.set(param, "2048");
    });
  });
}

function qualityCandidatesForItem(item) {
  const current = normalizeUrl(item?.url || "");
  if (!current) return [];

  const candidates = [];
  addQualityCandidate(candidates, current, "actual", 10);
  addQualityCandidate(candidates, upgradeMediaUrl(current), "atajo-hd", 50);

  try {
    const url = new URL(current);
    if (hostMatches(url.hostname, "twimg.com")) addTwitterQualityCandidates(candidates, current);
    if (hostMatches(url.hostname, "pinimg.com")) addPinterestQualityCandidates(candidates, current);
    if (hostMatches(url.hostname, "cdninstagram.com") || hostMatches(url.hostname, "fbcdn.net")) {
      addInstagramQualityCandidates(candidates, current);
    }
    if (hostMatches(url.hostname, "licdn.com")) addLinkedInQualityCandidates(candidates, current);
    if (hostMatches(url.hostname, "media.tumblr.com")) addTumblrQualityCandidates(candidates, current);
    if (isOnlyFansMediaHost(url.hostname)) addOnlyFansQualityCandidates(candidates, current);
    if (isKnownMediaHost(url.hostname)) addGenericQueryCandidates(candidates, current);
  } catch {
    // Keep the current URL candidate only.
  }

  return uniqueQualityCandidates(candidates).slice(0, 14);
}

function parseInstagramUrl(value) {
  const trimmed = String(value || "").trim();
  const match = trimmed.match(
    /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i,
  );
  return match ? match[1] : "";
}

function buildQueryUrls(inputUrl) {
  const shortcode = parseInstagramUrl(inputUrl);
  if (!shortcode) {
    throw new Error("Necesito un link de post, reel o tv con shortcode.");
  }

  const variables = {
    shortcode,
    fetch_tagged_user_count: null,
    hoisted_comment_id: null,
    hoisted_reply_id: null,
  };

  const queryUrl = `https://www.instagram.com/graphql/query/?doc_id=${POST_QUERY_DOC_ID}&variables=${encodeURIComponent(
    JSON.stringify(variables),
  )}`;
  const cleanUrl = inputUrl.trim().split("?")[0].replace(/\/?$/, "/");
  const legacyUrl = `${cleanUrl}?__a=1&__d=dis`;

  return { queryUrl, legacyUrl };
}

function tryParseJson(value) {
  const attempts = [value, normalizeEscapes(value)];
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try next normalized form.
    }
  }
  return null;
}

function extractJsonFromHtml(value) {
  const normalized = normalizeEscapes(value);
  const documents = [];

  try {
    const doc = new DOMParser().parseFromString(normalized, "text/html");
    doc.querySelectorAll("script").forEach((script) => {
      const text = script.textContent.trim();
      if (text.startsWith("{") || text.startsWith("[")) {
        documents.push(text);
      }
      const additionalData = text.match(/__additionalDataLoaded\([^,]+,\s*(\{[\s\S]*\})\);?/);
      if (additionalData) documents.push(additionalData[1]);
    });
  } catch {
    // Source was not HTML.
  }

  const directJson = normalized.match(/^\s*[\[{][\s\S]*[\]}]\s*$/);
  if (directJson) documents.unshift(normalized);

  return documents.map(tryParseJson).filter(Boolean);
}

function bestResource(resources, mediaType = "") {
  if (!Array.isArray(resources) || resources.length === 0) return null;
  return resources
    .filter((item) => item && (item.src || item.url))
    .map((item) => ({
      url: normalizeUrl(item.src || item.url),
      width: Number(item.config_width || item.width || 0),
      height: Number(item.config_height || item.height || 0),
      bitrate: Number(item.bitrate || 0),
      contentType: item.content_type || item.mime_type || "",
    }))
    .filter((item) => item.url && isLikelyMediaUrl(item.url))
    .filter((item) => !mediaType || inferMediaType(item.url) === mediaType)
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
}

function bestVideoVariant(resources) {
  if (!Array.isArray(resources) || resources.length === 0) return null;
  return resources
    .filter((item) => item && (item.url || item.src))
    .map((item) => ({
      url: normalizeUrl(item.url || item.src),
      width: Number(item.width || item.config_width || 0),
      height: Number(item.height || item.config_height || 0),
      bitrate: Number(item.bitrate || 0),
      contentType: item.content_type || item.mime_type || "",
    }))
    .filter((item) => item.url && inferMediaType(item.url) === "video")
    .sort((a, b) => b.bitrate - a.bitrate || b.width * b.height - a.width * a.height)[0];
}

function textCaption(node) {
  if (!node || typeof node !== "object") return "";
  if (typeof node.accessibility_caption === "string") return node.accessibility_caption;
  if (typeof node.caption === "string") return node.caption;
  if (node.caption && typeof node.caption.text === "string") return node.caption.text;
  const captionEdge = node.edge_media_to_caption?.edges?.[0]?.node?.text;
  return typeof captionEdge === "string" ? captionEdge : "";
}

function resourcesFromFields(node, names) {
  return names
    .map((name) => node?.[name])
    .flatMap((value) => {
      if (!value) return [];
      if (typeof value === "string") return [{ src: value }];
      if (typeof value === "object" && typeof value.url === "string") return [value];
      return [];
    });
}

function resourcesFromSrcset(value) {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean)
    .map((src) => ({ src }));
}

function collectStructuredMedia(root) {
  const items = [];
  const seenObjects = new WeakSet();

  function addFromNode(node, context = {}) {
    if (!node || typeof node !== "object") return;
    if (seenObjects.has(node)) return;
    seenObjects.add(node);

    const sidecarEdges = node.edge_sidecar_to_children?.edges;
    const sidecarNodes = Array.isArray(sidecarEdges)
      ? sidecarEdges.map((edge) => edge?.node).filter(Boolean)
      : [];
    const carouselNodes = Array.isArray(node.carousel_media) ? node.carousel_media : [];
    const children = sidecarNodes.length > 0 ? sidecarNodes : carouselNodes;

    if (children.length > 0) {
      children.forEach((child, index) =>
        addFromNode(child, {
          ...context,
          parentShortcode: node.shortcode || node.code || context.parentShortcode,
          carouselIndex: index + 1,
        }),
      );
      return;
    }

    const imageResource =
      bestResource(node.display_resources, "image") ||
      bestResource(node.image_versions2?.candidates, "image") ||
      bestResource(node.images, "image") ||
      bestResource(node.thumbnails, "image") ||
      bestResource(node.square_crop_url ? [{ src: node.square_crop_url }] : [], "image") ||
      bestResource(node.thumbnail_url ? [{ src: node.thumbnail_url }] : [], "image") ||
      bestResource(node.display_url ? [{ src: node.display_url, ...node.dimensions }] : [], "image") ||
      bestResource(node.media_url ? [{ src: node.media_url }] : [], "image") ||
      bestResource(resourcesFromFields(node, [
        "fullImageUrl",
        "image",
        "imageUrl",
        "image_url",
        "media_url_https",
        "og:image",
        "preview_image_url",
        "secure_url",
        "thumbnailUrl",
        "thumbnail_url",
      ]), "image") ||
      bestResource(resourcesFromSrcset(node.srcset || node.srcSet), "image");
    const videoResource =
      bestVideoVariant(node.video_info?.variants) ||
      bestVideoVariant(node.variants) ||
      bestVideoVariant(node.video_versions) ||
      bestResource(node.video_versions, "video") ||
      bestResource(node.video_url ? [{ url: node.video_url }] : [], "video") ||
      bestResource(resourcesFromFields(node, [
        "contentUrl",
        "content_url",
        "downloadUrl",
        "download_url",
        "mediaUrl",
        "media_url",
        "playbackUrl",
        "playback_url",
        "source",
        "src",
        "streamUrl",
        "stream_url",
        "url",
        "videoUrl",
        "video_url",
      ]), "video");

    if (imageResource || videoResource) {
      const isVideo = Boolean(node.is_video || node.video_url || node.video_versions);
      const resource = isVideo && videoResource ? videoResource : imageResource || videoResource;
      const thumb = imageResource?.url || resource.url;
      const dimensions = dimensionsFromUrl(resource.url);
      items.push({
        url: resource.url,
        previewUrl: thumb,
        type: isVideo ? "video" : "image",
        width: resource.width || node.dimensions?.width || node.original_width || dimensions.width || 0,
        height: resource.height || node.dimensions?.height || node.original_height || dimensions.height || 0,
        shortcode: node.shortcode || node.code || context.parentShortcode || "",
        caption: textCaption(node),
        platform: platformFromUrl(resource.url),
        source: context.carouselIndex ? `carousel ${context.carouselIndex}` : "structured",
      });
    }

    Object.values(node).forEach((value) => {
      if (value && typeof value === "object") addFromNode(value, context);
    });
  }

  addFromNode(root);
  return items;
}

function extractUrlCandidates(value) {
  const normalized = normalizeEscapes(value);
  const urls = new Set();
  const urlPattern = /https?:\/\/[^\s"'<>\\)]+/g;
  for (const match of normalized.matchAll(urlPattern)) {
    const url = normalizeUrl(match[0]);
    if (isLikelyMediaUrl(url)) urls.add(url);
  }
  return [...urls].map((url) => ({
    url,
    previewUrl: url,
    type: inferMediaType(url),
    width: 0,
    height: 0,
    shortcode: "",
    caption: "",
    source: "regex",
  }));
}

function isLikelyMediaUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const pathAndQuery = `${url.pathname}${url.search}`;
    if (isOnlyFansMediaHost(url.hostname)) {
      return MEDIA_EXTENSIONS.test(pathAndQuery) && !/\/api(?:\/|$)/i.test(url.pathname);
    }
    return (
      MEDIA_EXTENSIONS.test(pathAndQuery) ||
      (isKnownMediaHost(url.hostname) && !/\.(js|css|json|woff2?|map)(?:$|[?#])/i.test(pathAndQuery)) ||
      url.searchParams.has("format") ||
      url.searchParams.has("name") ||
      url.searchParams.has("stp") ||
      url.searchParams.has("ccb")
    );
  } catch {
    return false;
  }
}

function dedupeItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.url.split("&bytestart=")[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeItemsWithReport(items, rows) {
  const seen = new Set();
  const result = [];

  items.forEach((item, index) => {
    const key = item.url.split("&bytestart=")[0];
    if (seen.has(key)) {
      rows.push(reportRowForItem(item, "filtrada", "duplicada", index));
      return;
    }

    seen.add(key);
    result.push(item);
  });

  return result;
}

function mediaQualityRank(item) {
  const dimensions = dimensionsFromUrl(item.url);
  const pixels = (item.width || dimensions.width || 0) * (item.height || dimensions.height || 0);
  let score = pixels;

  if (isOnlyFansFullMediaUrl(item.url)) score += 10_000_000_000;
  if (isOnlyFansThumbnailUrl(item.url)) score -= 10_000_000_000;
  if (/\/(?:avatar|header)\.(?:jpe?g|png|webp)(?:$|[?#])/i.test(item.url)) score -= 2_000_000_000;
  if (/\/thumbs\//i.test(item.url)) score -= 1_000_000_000;
  if (item.source === "structured") score += 500_000;
  if (item.source === "img" || item.source === "srcset") score += 250_000;

  return score;
}

function filterLowQualityOnlyFansItems(items) {
  const hasFullOnlyFansMedia = items.some((item) => isOnlyFansFullMediaUrl(item.url));
  if (!hasFullOnlyFansMedia) return items;
  return items.filter((item) => !isOnlyFansThumbnailUrl(item.url));
}

function hasKnownSmallDimension(item) {
  const { width, height } = itemDimensions(item);
  if (width > 0 && width <= 540) return true;
  if (height > 0 && height <= 540) return true;

  const urlDimensions = dimensionsFromUrl(item.url);
  if (urlDimensions.width > 0 && urlDimensions.width <= 540) return true;
  if (urlDimensions.height > 0 && urlDimensions.height <= 540) return true;

  return item.type === "image" && width === 0 && height === 0 && isLikelySmallThumbnailUrl(item.url);
}

function filterSmallKnownItems(items) {
  return items.filter((item) => !hasKnownSmallDimension(item));
}

function smallKnownReason(item) {
  const { width, height } = itemDimensions(item);
  const urlDimensions = dimensionsFromUrl(item.url);
  const parts = [];

  if (width > 0 && width <= 540) parts.push(`ancho ${width}`);
  if (height > 0 && height <= 540) parts.push(`alto ${height}`);
  if (urlDimensions.width > 0 && urlDimensions.width <= 540) parts.push(`url ancho ${urlDimensions.width}`);
  if (urlDimensions.height > 0 && urlDimensions.height <= 540) parts.push(`url alto ${urlDimensions.height}`);
  if (parts.length === 0 && isLikelySmallThumbnailUrl(item.url)) parts.push("thumbnail por URL");
  return parts.length > 0 ? `dimension <=540 (${parts.join(", ")})` : "";
}

function filterItemsWithReport(items, rows) {
  const hasFullOnlyFansMedia = items.some((item) => isOnlyFansFullMediaUrl(item.url));
  const accepted = [];

  items.forEach((item, index) => {
    if (hasFullOnlyFansMedia && isOnlyFansThumbnailUrl(item.url)) {
      rows.push(reportRowForItem(item, "filtrada", "thumbnail onlyfans", index));
      return;
    }

    const smallReason = smallKnownReason(item);
    if (smallReason) {
      rows.push(reportRowForItem(item, "filtrada", smallReason, index));
      return;
    }

    accepted.push(item);
    rows.push(reportRowForItem(item, "aceptada", "pasa filtros iniciales", index));
  });

  return accepted;
}

function sortMediaItems(items) {
  return [...items].sort((a, b) => mediaQualityRank(b) - mediaQualityRank(a));
}

function mediaItemFromUrl(url, source, extra = {}) {
  const upgraded = normalizeUrl(url);
  if (!upgraded || !isLikelyMediaUrl(upgraded)) return null;
  const dimensions = dimensionsFromUrl(upgraded);
  return {
    url: upgraded,
    previewUrl: inferMediaType(upgraded) === "video" && extra.previewUrl ? normalizeUrl(extra.previewUrl) : upgraded,
    type: inferMediaType(upgraded),
    width: Number(extra.width || dimensions.width || 0),
    height: Number(extra.height || dimensions.height || 0),
    shortcode: extra.shortcode || "",
    caption: extra.caption || "",
    platform: extra.platform || platformFromUrl(upgraded),
    source,
  };
}

function platformFromUrl(value) {
  try {
    const host = new URL(value).hostname.replace(/^www\./, "");
    if (host.includes("instagram") || host.includes("cdninstagram") || host.includes("fbcdn")) return "instagram";
    if (host.includes("twimg") || host === "x.com" || host === "twitter.com") return "x";
    if (host.includes("tiktok") || host.includes("muscdn")) return "tiktok";
    if (host.includes("reddit") || host === "redd.it") return "reddit";
    if (host.includes("pinimg") || host.includes("pinterest")) return "pinterest";
    if (host.includes("licdn")) return "linkedin";
    if (host.includes("onlyfans")) return "onlyfans";
    return host.split(".").slice(-2, -1)[0] || "media";
  } catch {
    return "media";
  }
}

function extractDomMedia(value) {
  const normalized = normalizeEscapes(value);
  const items = [];

  try {
    const doc = new DOMParser().parseFromString(normalized, "text/html");
    const metaSelectors = [
      "meta[property='og:image']",
      "meta[property='og:image:secure_url']",
      "meta[property='og:video']",
      "meta[property='og:video:url']",
      "meta[property='og:video:secure_url']",
      "meta[name='twitter:image']",
      "meta[name='twitter:player:stream']",
    ];

    doc.querySelectorAll(metaSelectors.join(",")).forEach((meta) => {
      const url = meta.getAttribute("content");
      const item = mediaItemFromUrl(url, "meta");
      if (item) items.push(item);
    });

    doc.querySelectorAll("img[src], video[src], source[src], a[href]").forEach((node) => {
      const url = node.getAttribute("src") || node.getAttribute("href");
      const item = mediaItemFromUrl(url, node.tagName.toLowerCase());
      if (item) items.push(item);
    });

    doc.querySelectorAll("[style]").forEach((node) => {
      const style = node.getAttribute("style") || "";
      for (const match of style.matchAll(/url\((['"]?)(https?:\/\/.+?)\1\)/g)) {
        const item = mediaItemFromUrl(match[2], "background");
        if (item) items.push(item);
      }
    });

    doc.querySelectorAll("*").forEach((node) => {
      [
        "content",
        "data-full-url",
        "data-href",
        "data-image",
        "data-original",
        "data-src",
        "data-url",
        "data-video-url",
        "poster",
      ].forEach((attr) => {
        const item = mediaItemFromUrl(node.getAttribute(attr), attr);
        if (item) items.push(item);
      });
    });

    doc.querySelectorAll("img[srcset], source[srcset]").forEach((node) => {
      resourcesFromSrcset(node.getAttribute("srcset")).forEach((resource) => {
        const item = mediaItemFromUrl(resource.src, "srcset");
        if (item) items.push(item);
      });
    });
  } catch {
    // Not HTML.
  }

  return items;
}

function collectCapturedMediaElements(root) {
  const items = [];
  const seenObjects = new WeakSet();

  function addMediaElement(value) {
    const url = normalizeUrl(value?.url || value?.currentSrc || value?.src || value?.poster || "");
    if (!url) return;
    const width = Number(value.width || value.naturalWidth || value.videoWidth || 0);
    const height = Number(value.height || value.naturalHeight || value.videoHeight || 0);
    const item = mediaItemFromUrl(url, "capture-element", { width, height });
    if (item) items.push(item);
  }

  function walk(node) {
    if (!node || typeof node !== "object" || seenObjects.has(node)) return;
    seenObjects.add(node);

    if (Array.isArray(node.mediaElements)) {
      node.mediaElements.forEach(addMediaElement);
    }

    Object.values(node).forEach((value) => {
      if (value && typeof value === "object") walk(value);
    });
  }

  walk(root);
  return items;
}

function parseMediaDetailed(raw) {
  const jsonRoots = extractJsonFromHtml(raw);
  const captureItems = jsonRoots.flatMap(collectCapturedMediaElements);
  const structured = jsonRoots.flatMap(collectStructuredMedia);
  const domItems = extractDomMedia(raw);
  const regexItems = extractUrlCandidates(raw);
  const reportRows = [];
  const deduped = dedupeItemsWithReport([...captureItems, ...structured, ...domItems, ...regexItems], reportRows);
  const filtered = filterItemsWithReport(deduped, reportRows);
  const items = sortMediaItems(filtered);
  lastGalleryReport = reportRows;
  return { items, reportRows };
}

function parseMedia(raw) {
  return parseMediaDetailed(raw).items;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function itemDimensions(item) {
  const dimensions = dimensionsFromUrl(item.url);
  return {
    width: Number(item.width || dimensions.width || 0),
    height: Number(item.height || dimensions.height || 0),
  };
}

function reportRowForItem(item, status, reason, index = 0) {
  const { width, height } = itemDimensions(item);
  return {
    index: index + 1,
    status,
    reason,
    type: item.type || inferMediaType(item.url),
    width,
    height,
    source: item.source || "",
    platform: item.platform || platformFromUrl(item.url),
    url: item.url,
  };
}

function updateReportRow(item, patch) {
  const row = lastGalleryReport.find((entry) => entry.url === item.url && entry.status === "aceptada");
  if (row) {
    Object.assign(row, patch);
    return;
  }
  lastGalleryReport.push({ ...reportRowForItem(item, patch.status || "aceptada", patch.reason || "audit", 0), ...patch });
}

function buildGalleryReportText() {
  const lines = [
    "Media Local Gallery - reporte",
    `Fecha: ${new Date().toISOString()}`,
    `Elementos en galeria: ${currentItems.length}`,
    `Filas auditadas: ${lastGalleryReport.length}`,
    "",
    "status\ttipo\tresolucion\tsource\treason\turl",
  ];

  const rows =
    lastGalleryReport.length > 0
      ? lastGalleryReport
      : currentItems.map((item, index) => reportRowForItem(item, "aceptada", "sin reporte previo", index));

  rows.forEach((row) => {
    const resolution = row.width && row.height ? `${row.width}x${row.height}` : "desconocida";
    lines.push([row.status, row.type, resolution, row.source, row.reason, row.url].join("\t"));
  });

  return `${lines.join("\n")}\n`;
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function saveGalleryReport(reportText = buildGalleryReportText()) {
  if (isStaticPagesMode) return false;
  try {
    const response = await fetch("/api/gallery-report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ report: reportText }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function hasBlocked540Dimension(item) {
  const { width, height } = itemDimensions(item);
  if (width === 540 || height === 540) return true;

  try {
    const url = new URL(item.url);
    const pathDimensions = dimensionsFromUrl(url.pathname);
    if (pathDimensions.width === 540 || pathDimensions.height === 540) return true;
    return [...url.searchParams.values()].some((value) => /(?:^|[^\d])(?:540x\d{2,5}|\d{2,5}x540)(?:[^\d]|$)/i.test(value));
  } catch {
    return false;
  }
}

function isLargeDownloadItem(item) {
  const { width, height } = itemDimensions(item);
  if (hasBlocked540Dimension(item)) return false;
  if (item.type === "video") return width === 0 || height === 0 || (width >= 500 && height >= 500);
  return width >= 500 && height >= 500;
}

function largeDownloadItems(items) {
  return items.filter(isLargeDownloadItem);
}

function qualityScore(result) {
  const bytes = Number(result.probe.contentLength || 0);
  return bytes * 100 + Number(result.candidate.priority || 0) - result.index;
}

async function probeQualityCandidate(candidate) {
  if (isStaticPagesMode) {
    return {
      ok: false,
      candidate,
      status: 0,
      error: "requiere servidor local",
    };
  }

  try {
    const response = await fetch(`/api/probe?url=${encodeURIComponent(candidate.url)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      return {
        ok: false,
        candidate,
        status: payload.status || response.status,
        error: payload.error || `HTTP ${response.status}`,
      };
    }
    return {
      ok: true,
      candidate,
      probe: payload,
    };
  } catch (error) {
    return {
      ok: false,
      candidate,
      status: 0,
      error: error.message,
    };
  }
}

function addFailureSample(samples, failure) {
  const message = failure.error || `HTTP ${failure.status || "sin respuesta"}`;
  if (!message || samples.has(message) || samples.size >= 3) return;
  samples.set(message, failure.candidate?.url || "");
}

function summarizeFailureSamples(samples) {
  return [...samples.keys()].slice(0, 2).join(" / ");
}

function successfulProbe(candidateResult) {
  if (!candidateResult?.ok) return null;
  return {
    candidate: candidateResult.candidate,
    probe: candidateResult.probe,
  };
}

async function improveItemQuality(item) {
  const candidates = qualityCandidatesForItem(item);
  const results = [];
  const failureSamples = new Map();

  for (let index = 0; index < candidates.length; index += 1) {
    const candidateResult = await probeQualityCandidate(candidates[index]);
    const probed = successfulProbe(candidateResult);
    if (probed) {
      results.push({ ...probed, index });
    } else {
      addFailureSample(failureSamples, candidateResult);
    }
  }

  if (results.length === 0) {
    return { item, improved: false, failureSummary: summarizeFailureSamples(failureSamples) };
  }

  const best = results.sort((a, b) => qualityScore(b) - qualityScore(a))[0];
  const bestUrl = best.probe.url || best.candidate.url;
  const improved = bestUrl !== item.url;
  const reason = best.candidate.reason === "actual" ? item.source : `${item.source || "media"}+${best.candidate.reason}`;

  return {
    item: {
      ...item,
      url: bestUrl,
      previewUrl: item.type === "image" ? bestUrl : item.previewUrl,
      source: reason,
      byteSize: best.probe.contentLength || item.byteSize || 0,
      contentType: best.probe.contentType || item.contentType || "",
    },
    improved,
    failureSummary: summarizeFailureSamples(failureSamples),
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function probeImageDimensions(url) {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => {
      img.onload = null;
      img.onerror = null;
      resolve({ width: 0, height: 0, ok: false, error: "timeout" });
    }, 9000);

    img.onload = () => {
      clearTimeout(timer);
      resolve({ width: img.naturalWidth || 0, height: img.naturalHeight || 0, ok: true, error: "" });
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve({ width: 0, height: 0, ok: false, error: "image-load-error" });
    };
    img.src = url;
  });
}

function probeVideoDimensions(url) {
  return new Promise((resolve) => {
    if (/\.m3u8?(?:$|[?#])/i.test(url)) {
      resolve({ width: 0, height: 0, ok: false, error: "hls-skip" });
      return;
    }

    const video = document.createElement("video");
    const timer = setTimeout(() => {
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
      resolve({ width: 0, height: 0, ok: false, error: "timeout" });
    }, 9000);

    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve({ width: video.videoWidth || 0, height: video.videoHeight || 0, ok: true, error: "" });
      video.removeAttribute("src");
      video.load();
    };
    video.onerror = () => {
      clearTimeout(timer);
      resolve({ width: 0, height: 0, ok: false, error: "video-metadata-error" });
    };
    video.src = url;
  });
}

async function probeRealDimensions(item) {
  if (dimensionProbeCache.has(item.url)) return dimensionProbeCache.get(item.url);

  const result =
    item.type === "video" ? await probeVideoDimensions(item.url) : await probeImageDimensions(item.previewUrl || item.url);
  dimensionProbeCache.set(item.url, result);
  return result;
}

async function auditGalleryDimensions(items, label = "galeria") {
  let measured = 0;
  let filtered = 0;

  const audited = await mapWithConcurrency(items, 6, async (item, index) => {
    const shouldProbe = item.type === "image" || item.type === "video";
    if (!shouldProbe) return item;

    const result = await probeRealDimensions(item);
    if (result.ok && result.width > 0 && result.height > 0) {
      measured += 1;
      const updated = {
        ...item,
        width: result.width,
        height: result.height,
        source: item.source?.includes("audit") ? item.source : `${item.source || "media"}+audit`,
      };
      updateReportRow(updated, {
        status: "aceptada",
        reason: `audit real ${result.width}x${result.height}`,
        width: result.width,
        height: result.height,
        source: updated.source,
      });
      return updated;
    }

    updateReportRow(item, {
      status: "aceptada",
      reason: `audit sin dimension (${result.error || label})`,
    });
    return item;
  });

  const kept = [];
  audited.forEach((item, index) => {
    const reason = smallKnownReason(item);
    if (reason) {
      filtered += 1;
      updateReportRow(item, {
        status: "filtrada",
        reason: `audit ${reason}`,
        width: itemDimensions(item).width,
        height: itemDimensions(item).height,
      });
      return;
    }
    kept.push(item);
  });

  return {
    items: sortMediaItems(kept),
    measured,
    filtered,
  };
}

function filenameFor(item, index) {
  const ext = item.type === "video" ? "mp4" : "jpg";
  const shortcode = item.shortcode ? `-${item.shortcode}` : "";
  return `${item.platform || "media"}${shortcode}-${String(index + 1).padStart(2, "0")}.${ext}`;
}

function renderItemsFromDirectLink(inputUrl) {
  const item = mediaItemFromUrl(inputUrl, "direct-link");
  if (!item) return false;
  currentItems = [item];
  renderGallery(currentItems);
  elements.queryBox.hidden = true;
  setMessage("El link ya parece un archivo de imagen/video directo. Lo deje listo para descargar.");
  return true;
}

function renderGallery(items) {
  elements.gallery.textContent = "";
  elements.resultsCount.textContent = `${items.length} ${items.length === 1 ? "elemento" : "elementos"}`;
  elements.copyAll.disabled = items.length === 0;
  elements.loadCapture.disabled = isStaticPagesMode;
  elements.upgradeQuality.disabled = isStaticPagesMode || items.length === 0;
  elements.downloadLarge.disabled = isStaticPagesMode || largeDownloadItems(items).length === 0;
  elements.downloadReport.disabled = items.length === 0 && lastGalleryReport.length === 0;

  items.forEach((item, index) => {
    const node = elements.template.content.firstElementChild.cloneNode(true);
    const preview = node.querySelector(".preview");
    const title = node.querySelector(".media-title");
    const details = node.querySelector(".media-details");
    const download = node.querySelector(".download-link");
    const copy = node.querySelector(".copy-link");
    const open = node.querySelector(".open-link");
    const filename = filenameFor(item, index);

    if (item.type === "video") {
      const video = document.createElement("video");
      video.src = item.url;
      video.poster = item.previewUrl && item.previewUrl !== item.url ? item.previewUrl : "";
      video.controls = true;
      video.preload = "metadata";
      video.addEventListener("error", () => {
        preview.replaceChildren(Object.assign(document.createElement("span"), { textContent: "Preview no disponible" }));
      });
      preview.append(video);
    } else {
      const img = document.createElement("img");
      img.src = item.previewUrl || item.url;
      img.alt = item.caption || `Media ${index + 1}`;
      img.loading = "lazy";
      img.addEventListener("error", () => {
        preview.replaceChildren(Object.assign(document.createElement("span"), { textContent: "Preview no disponible" }));
      });
      preview.append(img);
    }

    title.textContent = `${item.type === "video" ? "Video" : "Imagen"} ${index + 1}`;
    details.textContent = [
      item.width && item.height ? `${item.width} x ${item.height}` : "",
      formatBytes(item.byteSize),
      item.platform,
      item.source,
    ]
      .filter(Boolean)
      .join(" / ");
    if (isStaticPagesMode) {
      download.href = item.url;
      download.removeAttribute("download");
      download.target = "_blank";
      download.rel = "noreferrer";
    } else {
      download.href = `/api/download?url=${encodeURIComponent(item.url)}&filename=${encodeURIComponent(filename)}`;
      download.download = filename;
    }
    open.href = item.url;
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(item.url);
      setMessage(`URL copiada: ${title.textContent}`);
    });

    node.title = item.caption || "";
    elements.gallery.append(node);
  });
}

elements.buildQuery.addEventListener("click", () => {
  const value = elements.postUrl.value.trim();
  if (!value) {
    setMessage("Pega un link o captura una pagina con la extension local.", true);
    return;
  }

  if (renderItemsFromDirectLink(value)) return;

  try {
    const { queryUrl, legacyUrl } = buildQueryUrls(value);
    elements.queryUrl.value = queryUrl;
    elements.legacyUrl.value = legacyUrl;
    elements.openQuery.href = queryUrl;
    elements.queryBox.hidden = false;
    setMessage("Para Instagram puedes usar esta consulta; para otras redes abre el post y usa la captura local.");
  } catch (error) {
    elements.queryBox.hidden = true;
    setMessage("Para esa red social abre el post en tu navegador y usa el companion: Capturar pestana actual.");
  }
});

elements.copyQuery.addEventListener("click", async () => {
  if (!elements.queryUrl.value) return;
  await navigator.clipboard.writeText(elements.queryUrl.value);
  setMessage("Consulta copiada.");
});

elements.parseSource.addEventListener("click", async () => {
  const raw = elements.sourceInput.value;
  if (!raw.trim()) {
    setMessage("Pega primero HTML, JSON, source o URLs de la pagina.", true);
    return;
  }

  let parsed = parseMedia(raw);
  currentItems = parsed;
  renderGallery(parsed);
  setMessage(`Auditando dimensiones reales de ${parsed.length} elemento(s)...`);
  const audit = await auditGalleryDimensions(parsed, "source");
  currentItems = audit.items;
  renderGallery(currentItems);
  saveGalleryReport().catch(() => {});
  setMessage(
    currentItems.length > 0
      ? `Encontre ${currentItems.length} elemento(s) utiles. Auditadas ${audit.measured} resoluciones reales; filtradas ${audit.filtered} miniaturas.`
      : "No encontre media util tras auditar y filtrar miniaturas de 540 o menos.",
    currentItems.length === 0,
  );
});

elements.loadCapture.addEventListener("click", async () => {
  if (needsLocalServer("Usar captura local")) return;

  let capture;
  try {
    capture = await fetch("/api/capture", { cache: "no-store" }).then((response) => response.json());
  } catch (error) {
    setMessage(`No pude leer la captura local: ${error.message}`, true);
    return;
  }

  if (!capture.ok || !capture.body) {
    setMessage("Todavia no hay captura local. Abre la publicacion y pulsa Capturar pestana actual en la extension.", true);
    return;
  }

  elements.sourceInput.value = capture.body;
  let items = parseMedia(capture.body);
  currentItems = items;
  renderGallery(items);
  setMessage(`Auditando dimensiones reales de ${items.length} elemento(s)...`);
  const audit = await auditGalleryDimensions(items, "capture");
  items = audit.items;
  currentItems = items;
  renderGallery(items);
  saveGalleryReport().catch(() => {});
  const source = capture.title ? `${capture.title} (${capture.url})` : capture.url;
  if (!elements.postUrl.value.trim()) {
    elements.postUrl.value = capture.url || "";
  }
  setMessage(
    items.length > 0
      ? `Use la captura local de ${new Date(capture.capturedAt).toLocaleTimeString()} y encontre ${items.length} elemento(s) utiles. Auditadas ${audit.measured} resoluciones reales; filtradas ${audit.filtered}. Captura: ${capture.mediaElementCount || 0} media visibles, ${(capture.resourceCount || 0) + (capture.elementCount || 0)} URLs unicas, ${capture.scrollSteps || capture.snapshots || 0} pasos de scroll. Fuente: ${source}`
      : `La captura local llego desde ${source}, pero no encontre media util tras ignorar miniaturas de 540 o menos.`,
    items.length === 0,
  );
});

elements.upgradeQuality.addEventListener("click", async () => {
  if (needsLocalServer("Mejorar calidad")) return;
  if (currentItems.length === 0) return;

  const controls = [
    elements.parseSource,
    elements.loadCapture,
    elements.upgradeQuality,
    elements.downloadLarge,
    elements.downloadReport,
    elements.copyAll,
    elements.clearAll,
  ];
  controls.forEach((control) => {
    control.disabled = true;
  });

  let completed = 0;
  let improved = 0;
  const failureSamples = new Set();

  try {
    const results = await mapWithConcurrency(currentItems, 3, async (item, index) => {
      const result = await improveItemQuality(item);
      completed += 1;
      if (result.improved) improved += 1;
      if (result.failureSummary && failureSamples.size < 3) failureSamples.add(result.failureSummary);
      setMessage(`Buscando maxima calidad... ${completed}/${currentItems.length}`);
      return result.item;
    });

    currentItems = sortMediaItems(filterSmallKnownItems(dedupeItems(results)));
    renderGallery(currentItems);
    saveGalleryReport().catch(() => {});
    const failureText = [...failureSamples].filter(Boolean).slice(0, 2).join(" / ");
    setMessage(
      improved > 0
        ? `Mejore ${improved} de ${results.length} elemento(s). Si alguno sigue pequeno, esa pagina solo expuso miniaturas o el CDN rechazo la variante HD.`
        : `Revise las URLs, pero no encontre variantes de mayor calidad que respondan.${failureText ? ` Motivo visto: ${failureText}.` : ""}`,
      improved === 0,
    );
  } catch (error) {
    setMessage(`No pude mejorar la calidad: ${error.message}`, true);
  } finally {
    renderGallery(currentItems);
    elements.parseSource.disabled = false;
    elements.loadCapture.disabled = false;
    elements.clearAll.disabled = false;
  }
});

elements.downloadLarge.addEventListener("click", async () => {
  if (needsLocalServer("Descargar ZIP")) return;

  const selectedItems = largeDownloadItems(currentItems);
  if (selectedItems.length === 0) {
    setMessage("No hay elementos descargables: imagenes >=500 x 500 o videos, siempre sin dimension 540.", true);
    return;
  }

  const controls = [
    elements.parseSource,
    elements.loadCapture,
    elements.upgradeQuality,
    elements.downloadLarge,
    elements.downloadReport,
    elements.copyAll,
    elements.clearAll,
  ];
  controls.forEach((control) => {
    control.disabled = true;
  });

  try {
    setMessage(`Preparando ZIP con ${selectedItems.length} elemento(s), excluyendo resoluciones 540x...`);
    const response = await fetch("/api/download-zip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: selectedItems.map((item, index) => {
          const { width, height } = itemDimensions(item);
          return {
            url: item.url,
            type: item.type,
            filename: filenameFor(item, index),
            width,
            height,
          };
        }),
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    const link = document.createElement("a");
    link.href = `/api/download-zip?id=${encodeURIComponent(payload.id)}`;
    link.download = "";
    document.body.append(link);
    link.click();
    link.remove();
    setMessage(`Descargando ZIP con ${payload.count} elemento(s).`);
  } catch (error) {
    setMessage(`No pude preparar el ZIP: ${error.message}`, true);
  } finally {
    elements.parseSource.disabled = false;
    elements.loadCapture.disabled = false;
    elements.clearAll.disabled = false;
    renderGallery(currentItems);
  }
});

elements.downloadReport.addEventListener("click", async () => {
  if (currentItems.length === 0 && lastGalleryReport.length === 0) {
    setMessage("Todavia no hay reporte. Usa Mostrar galeria o Usar captura local primero.", true);
    return;
  }

  const report = buildGalleryReportText();
  downloadTextFile(`media-local-gallery-report-${Date.now()}.txt`, report);
  const saved = await saveGalleryReport(report);
  setMessage(
    isStaticPagesMode
      ? "Reporte TXT generado."
      : saved
      ? "Reporte TXT generado y guardado en logs/latest-gallery-report.txt."
      : "Reporte TXT generado. No pude guardarlo en logs.",
    !isStaticPagesMode && !saved,
  );
});

elements.copyAll.addEventListener("click", async () => {
  if (currentItems.length === 0) return;
  await navigator.clipboard.writeText(currentItems.map((item) => item.url).join("\n"));
  setMessage("URLs copiadas.");
});

elements.clearAll.addEventListener("click", () => {
  elements.postUrl.value = "";
  elements.queryUrl.value = "";
  elements.legacyUrl.value = "";
  elements.sourceInput.value = "";
  elements.queryBox.hidden = true;
  currentItems = [];
  lastGalleryReport = [];
  renderGallery([]);
  setMessage("");
  if (!isStaticPagesMode) {
    fetch("/api/capture", { method: "DELETE" }).catch(() => {});
  }
});

if (isStaticPagesMode) {
  const privacyStatus = document.querySelector("#privacy-status");
  if (privacyStatus) privacyStatus.textContent = "Demo GitHub Pages";
  elements.loadCapture.disabled = true;
  elements.upgradeQuality.disabled = true;
  elements.downloadLarge.disabled = true;
  setMessage("Demo estatica: para capturas, proxy local, mejora de calidad y ZIP usa npm start en tu equipo.", true);
}

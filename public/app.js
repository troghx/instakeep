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
  sourceInput: document.querySelector("#source-input"),
  parseSource: document.querySelector("#parse-source"),
  loadCapture: document.querySelector("#load-capture"),
  upgradeQuality: document.querySelector("#upgrade-quality"),
  downloadLarge: document.querySelector("#download-large"),
  downloadReport: document.querySelector("#download-report"),
  copyAll: document.querySelector("#copy-all"),
  clearAll: document.querySelector("#clear-all"),
  actionRow: document.querySelector(".action-row"),
  message: document.querySelector("#message"),
  gallery: document.querySelector("#gallery"),
  galleryToolbar: document.querySelector("#gallery-toolbar"),
  galleryStats: document.querySelector("#gallery-stats"),
  galleryEmpty: document.querySelector("#gallery-empty"),
  filterChips: document.querySelectorAll(".filter-chip"),
  selectionSummary: document.querySelector("#selection-summary"),
  selectVisible: document.querySelector("#select-visible"),
  clearSelection: document.querySelector("#clear-selection"),
  resultsCount: document.querySelector("#results-count"),
  template: document.querySelector("#media-card-template"),
  viewer: document.querySelector("#media-viewer"),
  viewerStage: document.querySelector("#viewer-stage"),
  viewerCaption: document.querySelector("#viewer-caption"),
  viewerClose: document.querySelector("#viewer-close"),
  viewerPrev: document.querySelector("#viewer-prev"),
  viewerNext: document.querySelector("#viewer-next"),
  viewerZoomValue: document.querySelector("#viewer-zoom-value"),
  viewerZoomOut: document.querySelector("#viewer-zoom-out"),
  viewerZoomReset: document.querySelector("#viewer-zoom-reset"),
  viewerZoomIn: document.querySelector("#viewer-zoom-in"),
  viewerOriginal: document.querySelector("#viewer-original"),
  viewerCopyUrl: document.querySelector("#viewer-copy-url"),
};

const GALLERY_VIRTUALIZE_AT = 360;
const GALLERY_OVERSCAN_ROWS = 5;
const GALLERY_WINDOW_ROW_STEP = 4;
const GALLERY_LAZY_ROOT_MARGIN = "650px 0px";
const GALLERY_IMMEDIATE_LOAD_MARGIN = 420;
const GALLERY_EAGER_MEDIA_COUNT = 20;
const GALLERY_CARD_CACHE_LIMIT = 900;

let currentItems = [];
let lastGalleryReport = [];
let galleryViewItems = [];
let selectedItemKeys = new Set();
let galleryRenderRequest = 0;
let galleryRenderVersion = 0;
let galleryWindowSignature = "";
let galleryControlsRequest = 0;
let lazyMediaObserver = null;
let galleryCardCache = new Map();
let galleryCardCacheVersion = 0;
let galleryActiveCardKeys = new Set();
let activeAuditId = 0;
let activeResolveId = 0;
const loadedGalleryMediaSources = new Set();
const galleryFilters = {
  type: "all",
  orientation: "all",
  quality: "all",
};
let viewerState = {
  item: null,
  index: -1,
  media: null,
  frame: null,
  items: [],
  zoom: 1,
  fitScale: 1,
  x: 0,
  y: 0,
  fit: true,
  pan: null,
  suppressClick: false,
  returnFocus: null,
};
const dimensionProbeCache = new Map();
const isStaticPagesMode = !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);

function setMessage(text, isError = false) {
  elements.message.textContent = text;
  elements.message.classList.toggle("error", isError);
}

function yieldToBrowser() {
  if (typeof scheduler !== "undefined" && typeof scheduler.yield === "function") {
    return scheduler.yield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function yieldToPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function scheduleGalleryControlsUpdate() {
  if (galleryControlsRequest) return;
  galleryControlsRequest = requestAnimationFrame(() => {
    galleryControlsRequest = 0;
    updateGalleryControls();
  });
}

function needsLocalServer(action) {
  if (!isStaticPagesMode) return false;
  setMessage(
    `${action} necesita el servidor local con npm start. GitHub Pages no puede leer capturas locales ni cookies de otras paginas.`,
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

function isTwitterGalleryMediaUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host === "pbs.twimg.com") return /^\/media\//i.test(url.pathname);
    if (host === "video.twimg.com") return MEDIA_EXTENSIONS.test(`${url.pathname}${url.search}`);
    return false;
  } catch {
    return false;
  }
}

function isTwitterOriginalGalleryMediaUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.hostname.toLowerCase() === "pbs.twimg.com" &&
      /^\/media\//i.test(url.pathname) &&
      (url.searchParams.get("name") || "").toLowerCase() === "orig"
    );
  } catch {
    return false;
  }
}

function normalizeTwitterMediaUrl(value, preferredName = "orig") {
  const normalized = normalizeUrl(value);
  if (!normalized) return "";

  try {
    const url = new URL(normalized);
    if (url.hostname.toLowerCase() === "pbs.twimg.com" && /^\/media\//i.test(url.pathname)) {
      const extensionMatch = url.pathname.match(/^\/media\/([^/.?#]+)\.(jpe?g|png|webp|gif)$/i);
      if (extensionMatch) {
        url.pathname = `/media/${extensionMatch[1]}`;
        if (!url.searchParams.has("format")) {
          url.searchParams.set("format", extensionMatch[2].toLowerCase().replace("jpeg", "jpg"));
        }
      }
      url.searchParams.set("name", preferredName);
    }
    return url.toString();
  } catch {
    return normalized;
  }
}

function displayPreviewUrl(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return "";

  try {
    const url = new URL(normalized);
    if (url.hostname.toLowerCase() === "pbs.twimg.com" && /^\/media\//i.test(url.pathname)) {
      return normalizeTwitterMediaUrl(url.toString(), "small");
    }
  } catch {
    // Keep the original URL below.
  }

  return normalized;
}

function canonicalMediaUrl(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return "";

  try {
    const url = new URL(normalized);
    if (isTwitterGalleryMediaUrl(url.toString())) {
      return normalizeTwitterMediaUrl(url.toString());
    }
    if (url.searchParams.has("bytestart") || url.searchParams.has("byteend")) {
      url.searchParams.delete("bytestart");
      url.searchParams.delete("byteend");
    }
    return url.toString();
  } catch {
    return normalized;
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

  if (isTwitterGalleryMediaUrl(url.toString())) {
    return normalizeTwitterMediaUrl(url.toString());
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

function isDirectJsonText(value) {
  return /^\s*[\[{][\s\S]*[\]}]\s*$/.test(value);
}

function extractJsonFromHtml(value) {
  const normalized = normalizeEscapes(value);
  const documents = [];
  if (isDirectJsonText(normalized)) {
    const parsed = tryParseJson(normalized);
    if (parsed) return [parsed];
  }

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
      const mediaUrl = canonicalMediaUrl(resource.url) || resource.url;
      const dimensions = dimensionsFromUrl(mediaUrl);
      items.push({
        url: mediaUrl,
        previewUrl: displayPreviewUrl(thumb),
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
    const url = canonicalMediaUrl(match[0]);
    if (isLikelyMediaUrl(url)) urls.add(url);
  }
  return [...urls].map((url) => ({
    url,
    previewUrl: displayPreviewUrl(url),
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
    if (hostMatches(url.hostname, "twimg.com")) {
      return isTwitterGalleryMediaUrl(url.toString());
    }
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

function decodeBase64UrlJson(value) {
  if (!value) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function instagramVideoMetadata(value) {
  try {
    const url = new URL(value);
    return decodeBase64UrlJson(url.searchParams.get("efg"));
  } catch {
    return null;
  }
}

function isInstagramBackgroundVideoResource(value) {
  try {
    const url = new URL(value);
    const metadata = instagramVideoMetadata(value);
    const delegatedHost = url.searchParams.get("_nc_ht") || "";
    const isInstagramCdn =
      hostMatches(url.hostname, "fbcdn.net") &&
      (delegatedHost.includes("instagram") || metadata?.client_name === "ig");
    if (!isInstagramCdn || inferMediaType(value) !== "video") return false;

    return (
      url.hostname.startsWith("video.") &&
      (metadata?.video_id === null || /(?:xpvds|dash)/i.test(String(metadata?.vencode_tag || "")))
    );
  } catch {
    return false;
  }
}

function addCanonicalMediaUrl(target, value) {
  const url = canonicalMediaUrl(value);
  if (url && isLikelyMediaUrl(url)) target.add(url);
}

function collectCaptureUrlContext(jsonRoots) {
  const context = {
    resources: new Set(),
    elements: new Set(),
    visible: new Set(),
    hiddenMedia: new Set(),
    hasCapture: false,
  };
  const seenObjects = new WeakSet();

  function isVisibleCapturedMedia(value) {
    const clientWidth = Number(value?.clientWidth || 0);
    const clientHeight = Number(value?.clientHeight || 0);
    const width = Number(value?.width || 0);
    const height = Number(value?.height || 0);
    return (
      (clientWidth >= 64 && clientHeight >= 64) ||
      (clientWidth === 0 && clientHeight === 0 && value?.tag === "img" && width >= 300 && height >= 300)
    );
  }

  function addArrayUrls(target, values) {
    if (!Array.isArray(values)) return;
    values.forEach((value) => {
      if (typeof value === "string") {
        addCanonicalMediaUrl(target, value);
        return;
      }

      if (value && typeof value === "object") {
        [
          value.url,
          value.currentSrc,
          value.src,
          value.poster,
          value.href,
          value.content,
        ].forEach((candidate) => addCanonicalMediaUrl(target, candidate));
      }
    });
  }

  function walk(node) {
    if (!node || typeof node !== "object" || seenObjects.has(node)) return;
    seenObjects.add(node);

    if (Array.isArray(node.resources)) {
      context.hasCapture = true;
      addArrayUrls(context.resources, node.resources);
    }

    if (Array.isArray(node.elements)) {
      context.hasCapture = true;
      addArrayUrls(context.elements, node.elements);
    }

    if (Array.isArray(node.mediaElements)) {
      context.hasCapture = true;
      node.mediaElements.forEach((value) => {
        const target = isVisibleCapturedMedia(value) ? context.visible : context.hiddenMedia;
        addArrayUrls(target, [value]);
      });
    }

    Object.values(node).forEach((value) => {
      if (value && typeof value === "object") walk(value);
    });
  }

  jsonRoots.forEach(walk);
  context.resourceOnly = new Set(
    [...context.resources].filter((url) => !context.elements.has(url) && !context.visible.has(url)),
  );
  return context;
}

function filterCaptureResourceNoise(items, rows, captureContext) {
  if (!captureContext.hasCapture || (captureContext.resourceOnly.size === 0 && captureContext.hiddenMedia.size === 0)) {
    return items;
  }

  return items.filter((item, index) => {
    const key = canonicalMediaUrl(item.url) || item.url;
    const resourceOnly = captureContext.resourceOnly.has(key);
    const hiddenCaptureMedia = captureContext.hiddenMedia.has(key) && !captureContext.visible.has(key);
    const visiblyRendered = captureContext.visible.has(key);
    const domMention = captureContext.elements.has(key);
    const sourceAllowsFiltering =
      item.source === "regex" ||
      item.source === "resource" ||
      (item.source === "capture-element" && hiddenCaptureMedia);
    const shouldFilter =
      ((resourceOnly && !domMention && !visiblyRendered) || (hiddenCaptureMedia && !visiblyRendered)) &&
      sourceAllowsFiltering &&
      item.type === "video" &&
      isInstagramBackgroundVideoResource(item.url);

    if (!shouldFilter) return true;

    rows.push(
      reportRowForItem(
        item,
        "filtrada",
        "video fbcdn de performance sin elemento visible",
        rows.length || index,
      ),
    );
    return false;
  });
}

function dedupeItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = canonicalMediaUrl(item.url) || item.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeItemsWithReport(items, rows) {
  const seen = new Set();
  const result = [];

  items.forEach((item, index) => {
    const key = canonicalMediaUrl(item.url) || item.url;
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
  if (item.type === "image" && isTwitterOriginalGalleryMediaUrl(item.url)) return false;

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
  if (item.type === "image" && isTwitterOriginalGalleryMediaUrl(item.url)) return "";

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

function isPreviewProbeFailure(result) {
  return ["hls-skip", "image-load-error", "timeout", "video-metadata-error"].includes(result?.error || "");
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
  const upgraded = canonicalMediaUrl(url);
  if (!upgraded || !isLikelyMediaUrl(upgraded)) return null;
  const dimensions = dimensionsFromUrl(upgraded);
  return {
    url: upgraded,
    previewUrl:
      inferMediaType(upgraded) === "video" && extra.previewUrl
        ? displayPreviewUrl(extra.previewUrl)
        : displayPreviewUrl(upgraded),
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
  if (isDirectJsonText(normalized)) return items;

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
  const captureContext = collectCaptureUrlContext(jsonRoots);
  const captureItems = jsonRoots.flatMap(collectCapturedMediaElements);
  const structured = jsonRoots.flatMap(collectStructuredMedia);
  const domItems = extractDomMedia(raw);
  const regexItems = extractUrlCandidates(raw);
  const reportRows = [];
  const deduped = dedupeItemsWithReport([...captureItems, ...structured, ...domItems, ...regexItems], reportRows);
  const withoutResourceNoise = filterCaptureResourceNoise(deduped, reportRows, captureContext);
  const filtered = filterItemsWithReport(withoutResourceNoise, reportRows);
  const items = sortMediaItems(filtered);
  lastGalleryReport = reportRows;
  return { items, reportRows };
}

function parseMedia(raw) {
  return parseMediaDetailed(raw).items;
}

function extractTwitterStatusUrls(raw) {
  const normalized = normalizeEscapes(raw);
  const urls = new Set();
  const pattern = /(?:https?:\/\/(?:x|twitter)\.com)?\/([a-z0-9_]{1,20})\/status\/(\d+)(?:\/(?:photo|video)\/\d+)?/gi;

  for (const match of normalized.matchAll(pattern)) {
    urls.add(`https://x.com/${match[1]}/status/${match[2]}`);
  }

  return [...urls];
}

async function resolvePageMediaItems(raw) {
  if (isStaticPagesMode) return [];

  const statusUrls = extractTwitterStatusUrls(raw).slice(0, 30);
  if (statusUrls.length === 0) return [];

  const batches = await mapWithConcurrency(statusUrls, 3, async (statusUrl) => {
    try {
      const response = await fetch(`/api/resolve-page-media?url=${encodeURIComponent(statusUrl)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok || !Array.isArray(payload.media)) return [];

      return payload.media
        .map((entry) =>
          mediaItemFromUrl(entry.url || entry, "x:status-page", {
            width: entry.width || 0,
            height: entry.height || 0,
            shortcode: entry.statusId || statusUrl.split("/").pop() || "",
          }),
        )
        .filter(Boolean);
    } catch {
      return [];
    }
  });

  return batches.flat();
}

async function resolveAndMergePageMedia(raw, label = "galeria") {
  const resolveId = ++activeResolveId;
  const resolvedItems = await resolvePageMediaItems(raw);
  if (resolveId !== activeResolveId || resolvedItems.length === 0) return;

  resolvedItems.forEach((item, index) => {
    lastGalleryReport.push(reportRowForItem(item, "aceptada", "x status resuelto", lastGalleryReport.length + index));
  });

  const before = currentItems.length;
  currentItems = sortMediaItems(dedupeItemsWithReport([...currentItems, ...resolvedItems], lastGalleryReport));
  const added = Math.max(0, currentItems.length - before);
  renderGallery(currentItems);
  setMessage(
    `Galeria actualizada: ${currentItems.length} elemento(s) utiles${added ? `, +${added} por enlaces X` : ""}. Refinando dimensiones en segundo plano...`,
  );
  void runGalleryAudit(currentItems, label);
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

function countBy(values, mapper) {
  const counts = new Map();
  values.forEach((value) => {
    const key = mapper(value) || "desconocido";
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
}

function summarizeItemsForDebug(items) {
  const safeItems = Array.isArray(items) ? items : [];
  return {
    total: safeItems.length,
    images: safeItems.filter((item) => item.type === "image").length,
    videos: safeItems.filter((item) => item.type === "video").length,
    unknownDimensions: safeItems.filter((item) => {
      const { width, height } = itemDimensions(item);
      return !width && !height;
    }).length,
    sources: countBy(safeItems, (item) => item.source || "sin source"),
    platforms: countBy(safeItems, (item) => item.platform || platformFromUrl(item.url)),
  };
}

function summarizeReportRows(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  return {
    total: safeRows.length,
    accepted: safeRows.filter((row) => row.status === "aceptada").length,
    filtered: safeRows.filter((row) => row.status === "filtrada").length,
    reasons: countBy(safeRows, (row) => `${row.status}: ${row.reason || "sin razon"}`),
    sources: countBy(safeRows, (row) => row.source || "sin source"),
  };
}

function captureSummaryForDebug(capture) {
  let parsed = null;
  try {
    parsed = JSON.parse(capture.body || "");
  } catch {
    parsed = null;
  }

  return {
    url: capture.url || parsed?.url || "",
    title: capture.title || parsed?.title || "",
    capturedAt: capture.capturedAt || "",
    bodyBytes: capture.bodyBytes || new Blob([capture.body || ""]).size,
    bodyChars: String(capture.body || "").length,
    captureMode: parsed?.captureMode || "",
    resources: Number(capture.resourceCount || parsed?.resourceUrlCount || parsed?.resources?.length || 0),
    elements: Number(capture.elementCount || parsed?.elementUrlCount || parsed?.elements?.length || 0),
    mediaElements: Number(capture.mediaElementCount || parsed?.mediaElementCount || parsed?.mediaElements?.length || 0),
    snapshots: Number(capture.snapshots || parsed?.snapshots || 0),
    scrollSteps: Number(capture.scrollSteps || parsed?.scrollSteps || 0),
  };
}

function compactReportRows(rows, limit = 30) {
  return rows.slice(0, limit).map((row) => ({
    status: row.status,
    reason: row.reason,
    type: row.type,
    resolution: row.width && row.height ? `${row.width}x${row.height}` : "desconocida",
    source: row.source,
    url: row.url,
  }));
}

function logCaptureDebug(stage, payload = {}) {
  if (typeof console === "undefined") return;

  const group = console.groupCollapsed || console.group;
  if (group) group.call(console, `[Media Local Gallery] Usar captura local - ${stage}`);
  else console.log(`[Media Local Gallery] Usar captura local - ${stage}`);

  console.log("fase", stage);
  if (payload.summary) console.log("resumen", payload.summary);
  if (payload.audit) console.log("audit", payload.audit);
  if (payload.items) console.log("items", summarizeItemsForDebug(payload.items));
  if (payload.reportRows) {
    const summary = summarizeReportRows(payload.reportRows);
    const filtered = payload.reportRows.filter((row) => row.status === "filtrada");
    console.log("reporte", summary);
    if (console.table) {
      console.table(summary.reasons);
      console.table(compactReportRows(filtered));
    }
    console.log("filtradas completas", filtered);
  }

  if (console.groupEnd && group) console.groupEnd();
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
  const rows =
    lastGalleryReport.length > 0
      ? lastGalleryReport
      : currentItems.map((item, index) => reportRowForItem(item, "aceptada", "sin reporte previo", index));
  const summary = summarizeReportRows(rows);
  const lines = [
    "Media Local Gallery - reporte",
    `Fecha: ${new Date().toISOString()}`,
    `Elementos en galeria: ${currentItems.length}`,
    `Filas auditadas: ${lastGalleryReport.length}`,
    `Aceptadas: ${summary.accepted}`,
    `Filtradas: ${summary.filtered}`,
    "",
    "resumen filtros",
    ...summary.reasons.map((entry) => `${entry.count}\t${entry.name}`),
    "",
    "status\ttipo\tresolucion\tsource\treason\turl",
  ];

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
  const pixels = Number(result.probe.width || 0) * Number(result.probe.height || 0);
  return bytes * 100 + pixels + Number(result.candidate.priority || 0) - result.index;
}

async function probeQualityCandidate(candidate) {
  if (isStaticPagesMode) {
    const item = mediaItemFromUrl(candidate.url, candidate.reason) || {
      url: candidate.url,
      previewUrl: displayPreviewUrl(candidate.url),
      type: inferMediaType(candidate.url),
      width: 0,
      height: 0,
      platform: platformFromUrl(candidate.url),
      source: candidate.reason,
    };
    const probe = await probeRealDimensions(item);
    if (!probe.ok || (item.type === "image" && (!probe.width || !probe.height))) {
      return {
        ok: false,
        candidate,
        status: 0,
        error: probe.error || "media no cargo en navegador",
      };
    }

    return {
      ok: true,
      candidate,
      probe: {
        url: candidate.url,
        width: probe.width || item.width || 0,
        height: probe.height || item.height || 0,
        contentLength: 0,
        contentType: item.type === "video" ? "video/browser" : "image/browser",
      },
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
      previewUrl: item.type === "image" ? displayPreviewUrl(bestUrl) : item.previewUrl,
      source: reason,
      width: best.probe.width || item.width || 0,
      height: best.probe.height || item.height || 0,
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

  const probe =
    item.type === "video" ? probeVideoDimensions(item.url) : probeImageDimensions(item.url);
  dimensionProbeCache.set(item.url, probe);
  const result = await probe;
  dimensionProbeCache.set(item.url, result);
  return result;
}

function shouldProbeItemDimensions(item) {
  if (item.type !== "image" && item.type !== "video") return false;
  if (smallKnownReason(item)) return false;

  const { width, height } = itemDimensions(item);
  if (width > 540 && height > 540) return false;

  const urlDimensions = dimensionsFromUrl(item.url);
  if (urlDimensions.width > 540 && urlDimensions.height > 540) return false;

  return true;
}

async function auditGalleryDimensions(items, label = "galeria", options = {}) {
  let measured = 0;
  let filtered = 0;
  let skipped = 0;
  let processed = 0;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;

  const audited = await mapWithConcurrency(items, 2, async (item, index) => {
    const shouldProbe = shouldProbeItemDimensions(item);
    if (!shouldProbe) {
      const { width, height } = itemDimensions(item);
      if (width > 0 && height > 0) skipped += 1;
      processed += 1;
      if (processed % 24 === 0) {
        onProgress?.({ processed, total: items.length, measured, filtered, skipped });
        await yieldToBrowser();
      }
      return item;
    }

    const result = await probeRealDimensions(item);
    processed += 1;
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
      if (processed % 12 === 0) {
        onProgress?.({ processed, total: items.length, measured, filtered, skipped });
        await yieldToBrowser();
      }
      return updated;
    }

    if (isPreviewProbeFailure(result)) {
      filtered += 1;
      updateReportRow(item, {
        status: "filtrada",
        reason: `preview no disponible (${result.error || label})`,
      });
      if (processed % 12 === 0) {
        onProgress?.({ processed, total: items.length, measured, filtered, skipped });
        await yieldToBrowser();
      }
      return null;
    }

    updateReportRow(item, {
      status: "aceptada",
      reason: `audit sin dimension (${result.error || label})`,
    });
    if (processed % 12 === 0) {
      onProgress?.({ processed, total: items.length, measured, filtered, skipped });
      await yieldToBrowser();
    }
    return item;
  });

  const kept = [];
  audited.forEach((item, index) => {
    if (!item) return;
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
    skipped,
  };
}

function extensionForItem(item) {
  const fallback = item.type === "video" ? "mp4" : "jpg";
  const allowed = item.type === "video"
    ? new Set(["m3u", "m3u8", "m4v", "mov", "mp4", "webm"])
    : new Set(["avif", "gif", "jpg", "jpeg", "png", "webp"]);

  try {
    const match = new URL(item.url).pathname.match(/\.([a-z0-9]+)$/i);
    const ext = match?.[1]?.toLowerCase();
    if (ext && allowed.has(ext)) return ext === "jpeg" ? "jpg" : ext;
  } catch {
    // Keep fallback for malformed or extensionless media URLs.
  }

  return fallback;
}

function filenameFor(item, index) {
  const ext = extensionForItem(item);
  const shortcode = item.shortcode ? `-${item.shortcode}` : "";
  return `${item.platform || "media"}${shortcode}-${String(index + 1).padStart(2, "0")}.${ext}`;
}

function clickDownloadLink(href, filename = "", target = "") {
  const link = document.createElement("a");
  link.href = href;
  if (filename) link.download = filename;
  if (target) {
    link.target = target;
    link.rel = "noreferrer";
  }
  document.body.append(link);
  link.click();
  link.remove();
}

async function downloadStaticItem(item, index) {
  const filename = filenameFor(item, index);
  try {
    const response = await fetch(item.url, { mode: "cors", credentials: "omit", cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.size) throw new Error("blob vacio");
    const objectUrl = URL.createObjectURL(blob);
    clickDownloadLink(objectUrl, filename);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    return { ok: true, direct: false };
  } catch {
    clickDownloadLink(item.url, filename, "_blank");
    return { ok: true, direct: true };
  }
}

async function downloadStaticItems(items) {
  let direct = 0;
  for (let index = 0; index < items.length; index += 1) {
    setMessage(`Descargando en Pages... ${index + 1}/${items.length}`);
    const result = await downloadStaticItem(items[index], index);
    if (result.direct) direct += 1;
    await new Promise((resolve) => setTimeout(resolve, 180));
  }

  setMessage(
    direct > 0
      ? `Intente descargar ${items.length} elemento(s). ${direct} se abrieron como enlace directo porque el CDN bloqueo CORS.`
      : `Descargando ${items.length} elemento(s) desde Pages.`,
    false,
  );
}

function viewerCaptionFor(item, index, totalItems = currentItems.length || index + 1) {
  const total = totalItems || index + 1;
  return `${item.type === "video" ? "Video" : "Imagen"} ${index + 1}/${total}`;
}

function clampZoom(value) {
  return Math.min(5, Math.max(0.05, Number(value) || 1));
}

function viewerNaturalSize() {
  const media = viewerState.media;
  const item = viewerState.item || {};
  return {
    width: Number(media?.naturalWidth || item.width || 1200),
    height: Number(media?.naturalHeight || item.height || 1200),
  };
}

function viewerStageSize() {
  return {
    width: Math.max(1, elements.viewerStage.clientWidth),
    height: Math.max(1, elements.viewerStage.clientHeight),
  };
}

function viewerFitScale() {
  const size = viewerNaturalSize();
  const stage = viewerStageSize();
  return Math.min(1, stage.width / size.width, stage.height / size.height);
}

function centeredViewerPosition(scale) {
  const size = viewerNaturalSize();
  const stage = viewerStageSize();
  return {
    x: (stage.width - size.width * scale) / 2,
    y: (stage.height - size.height * scale) / 2,
  };
}

function clampViewerPosition(x = viewerState.x, y = viewerState.y, scale = viewerState.zoom) {
  const size = viewerNaturalSize();
  const stage = viewerStageSize();
  const width = size.width * scale;
  const height = size.height * scale;

  return {
    x: width <= stage.width ? (stage.width - width) / 2 : Math.min(0, Math.max(stage.width - width, x)),
    y: height <= stage.height ? (stage.height - height) / 2 : Math.min(0, Math.max(stage.height - height, y)),
  };
}

function applyViewerTransform() {
  const media = viewerState.media;
  if (!media || viewerState.item?.type === "video") return;

  media.style.transform = `translate3d(${viewerState.x}px, ${viewerState.y}px, 0) scale(${viewerState.zoom})`;
  updateViewerControls();
}

function resetViewerPan() {
  viewerState.pan = null;
  elements.viewerStage.classList.remove("is-panning");
}

function updateViewerFrameSize() {
  const frame = viewerState.frame;
  if (!frame) return;
  frame.style.width = `${elements.viewerStage.clientWidth}px`;
  frame.style.height = `${elements.viewerStage.clientHeight}px`;
}

function updateViewerControls() {
  const isOpen = !elements.viewer.hidden;
  const isImage = viewerState.item?.type !== "video";
  const items = viewerState.items.length > 0 ? viewerState.items : currentItems;
  const hasMany = items.length > 1;

  elements.viewerPrev.disabled = !isOpen || !hasMany || viewerState.index <= 0;
  elements.viewerNext.disabled = !isOpen || !hasMany || viewerState.index >= items.length - 1;
  elements.viewerZoomOut.disabled = !isOpen || !isImage || viewerState.fit;
  elements.viewerZoomReset.disabled = !isOpen || !isImage || viewerState.fit;
  elements.viewerZoomIn.disabled = !isOpen || !isImage;
  elements.viewerZoomValue.textContent = isImage
    ? viewerState.fit
      ? "Ajustado"
      : `${Math.round(viewerState.zoom * 100)}%`
    : "Video";
  elements.viewerOriginal.href = viewerState.item?.url || "#";
}

function fitViewerMedia() {
  if (!viewerState.media || viewerState.item?.type === "video") return;

  resetViewerPan();
  viewerState.fit = true;
  viewerState.fitScale = viewerFitScale();
  viewerState.zoom = viewerState.fitScale;
  const position = centeredViewerPosition(viewerState.zoom);
  viewerState.x = position.x;
  viewerState.y = position.y;
  elements.viewerStage.classList.remove("is-zoomed");
  viewerState.media.style.width = `${viewerNaturalSize().width}px`;
  viewerState.media.style.height = "auto";
  viewerState.media.style.maxWidth = "none";
  viewerState.media.style.maxHeight = "none";
  updateViewerFrameSize();
  applyViewerTransform();
}

function setViewerZoom(nextZoom, anchor = null) {
  if (!viewerState.media || viewerState.item?.type === "video") return;

  const rect = elements.viewerStage.getBoundingClientRect();
  const point = anchor || {
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  const localX = point.clientX - rect.left;
  const localY = point.clientY - rect.top;
  const imageX = (localX - viewerState.x) / viewerState.zoom;
  const imageY = (localY - viewerState.y) / viewerState.zoom;
  const nextScale = clampZoom(nextZoom);

  viewerState.fit = false;
  viewerState.zoom = nextScale;
  viewerState.x = localX - imageX * nextScale;
  viewerState.y = localY - imageY * nextScale;
  Object.assign(viewerState, clampViewerPosition());
  elements.viewerStage.classList.toggle("is-zoomed", viewerState.zoom > viewerState.fitScale + 0.01);
  applyViewerTransform();
}

function zoomViewerBy(multiplier, anchor = null) {
  if (!viewerState.media || viewerState.item?.type === "video") return;

  const nextZoom = viewerState.zoom * multiplier;
  if (nextZoom <= viewerState.fitScale * 1.02) {
    fitViewerMedia();
    return;
  }
  setViewerZoom(nextZoom, anchor);
}

function refreshViewerLayout() {
  if (elements.viewer.hidden || !viewerState.media || viewerState.item?.type === "video") return;
  updateViewerFrameSize();
  if (viewerState.fit) {
    fitViewerMedia();
    return;
  }

  Object.assign(viewerState, clampViewerPosition());
  applyViewerTransform();
}

function wheelZoomFactor(event) {
  const lineHeight = 16;
  const pageHeight = Math.max(elements.viewerStage.clientHeight, 1);
  const delta =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? event.deltaY * lineHeight
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? event.deltaY * pageHeight
        : event.deltaY;
  return Math.min(1.18, Math.max(0.84, Math.exp(-delta * 0.0008)));
}

function startViewerPan(event) {
  if (
    elements.viewer.hidden ||
    viewerState.fit ||
    viewerState.item?.type === "video" ||
    event.button !== 0 ||
    event.target !== viewerState.media
  ) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  viewerState.pan = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    startX: viewerState.x,
    startY: viewerState.y,
    moved: false,
  };
  elements.viewerStage.classList.add("is-panning");
  elements.viewerStage.setPointerCapture?.(event.pointerId);
}

function moveViewerPan(event) {
  const pan = viewerState.pan;
  if (!pan || pan.pointerId !== event.pointerId) return;

  event.preventDefault();
  const deltaX = event.clientX - pan.x;
  const deltaY = event.clientY - pan.y;
  if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) pan.moved = true;

  const position = clampViewerPosition(pan.startX + deltaX, pan.startY + deltaY);
  viewerState.x = position.x;
  viewerState.y = position.y;
  applyViewerTransform();
}

function endViewerPan(event) {
  const pan = viewerState.pan;
  if (!pan || pan.pointerId !== event.pointerId) return;

  if (pan.moved) {
    event.preventDefault();
    event.stopPropagation();
    viewerState.suppressClick = true;
    setTimeout(() => {
      viewerState.suppressClick = false;
    }, 0);
  }
  elements.viewerStage.releasePointerCapture?.(event.pointerId);
  resetViewerPan();
}

function goToViewerItem(offset) {
  const items = viewerState.items.length > 0 ? viewerState.items : currentItems;
  if (elements.viewer.hidden || items.length === 0) return;
  const nextIndex = viewerState.index + offset;
  if (nextIndex < 0 || nextIndex >= items.length) return;
  openMediaViewer(items[nextIndex], nextIndex, items);
}

function openMediaViewer(item, index, items = currentItems) {
  const returnFocus = elements.viewer.hidden ? document.activeElement : viewerState.returnFocus;
  elements.viewerStage.textContent = "";
  elements.viewerStage.classList.remove("is-zoomed", "is-panning");
  const frame = document.createElement("div");
  frame.className = "viewer-frame";
  const media = item.type === "video" ? document.createElement("video") : document.createElement("img");

  media.src = item.url;
  if (item.type === "video") {
    media.poster = item.previewUrl && item.previewUrl !== item.url ? item.previewUrl : "";
    media.controls = true;
    media.autoplay = true;
    media.playsInline = true;
  } else {
    media.alt = item.caption || viewerCaptionFor(item, index);
    media.decoding = "async";
    media.addEventListener("load", fitViewerMedia, { once: true });
    media.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      if (viewerState.fit) {
        setViewerZoom(1);
      } else {
        fitViewerMedia();
      }
    });
  }

  media.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  viewerState = {
    item,
    index,
    media,
    frame,
    items,
    zoom: 1,
    fitScale: 1,
    x: 0,
    y: 0,
    fit: true,
    pan: null,
    suppressClick: false,
    returnFocus,
  };
  frame.append(media);
  elements.viewerStage.append(frame);
  elements.viewerCaption.textContent = viewerCaptionFor(item, index, items.length);
  elements.viewer.hidden = false;
  elements.viewer.setAttribute("aria-hidden", "false");
  document.body.classList.add("viewer-open");
  fitViewerMedia();
  updateViewerControls();
  elements.viewer.focus({ preventScroll: true });
}

function closeMediaViewer() {
  const returnFocus = viewerState.returnFocus;
  elements.viewer.hidden = true;
  elements.viewer.setAttribute("aria-hidden", "true");
  elements.viewerStage.textContent = "";
  elements.viewerStage.classList.remove("is-zoomed", "is-panning");
  elements.viewerCaption.textContent = "";
  document.body.classList.remove("viewer-open");
  viewerState = {
    item: null,
    index: -1,
    media: null,
    frame: null,
    items: [],
    zoom: 1,
    fitScale: 1,
    x: 0,
    y: 0,
    fit: true,
    pan: null,
    suppressClick: false,
    returnFocus: null,
  };
  updateViewerControls();
  if (returnFocus?.focus) {
    returnFocus.focus({ preventScroll: true });
  }
}

function trapViewerFocus(event) {
  const focusable = [...elements.viewer.querySelectorAll("button:not(:disabled), a[href]:not([aria-disabled='true'])")].filter(
    (node) => node.offsetParent !== null,
  );
  if (focusable.length === 0) {
    event.preventDefault();
    elements.viewer.focus({ preventScroll: true });
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function configureDownloadLink(download, item, filename) {
  download.textContent = "Descargar";
  download.setAttribute("aria-label", `Descargar ${item.type === "video" ? "video" : "imagen"}`);

  if (isStaticPagesMode) {
    download.href = item.url;
    download.removeAttribute("download");
    download.target = "_blank";
    download.rel = "noreferrer";
  } else {
    download.href = `/api/download?url=${encodeURIComponent(item.url)}&filename=${encodeURIComponent(filename)}`;
    download.download = filename;
    download.removeAttribute("target");
    download.removeAttribute("rel");
  }

  download.addEventListener("click", (event) => {
    event.stopPropagation();
  });
}

function itemKey(item) {
  return canonicalMediaUrl(item?.url || "") || item?.url || "";
}

function filteredReportCount(pattern) {
  return lastGalleryReport.filter((row) => row.status === "filtrada" && pattern.test(row.reason || "")).length;
}

function isHighResolutionItem(item) {
  const { width, height } = itemDimensions(item);
  return width >= 1000 || height >= 1000 || Number(item.byteSize || 0) >= 1_000_000;
}

function itemOrientation(item) {
  const { width, height } = itemDimensions(item);
  if (!width || !height) return "unknown";
  const ratio = width / height;
  if (ratio > 1.08) return "horizontal";
  if (ratio < 0.92) return "vertical";
  return "square";
}

function itemStatusLabel(item) {
  if (item.loadError) return "Fallo carga";
  const { width, height } = itemDimensions(item);
  const parts = [];
  parts.push(item.type === "video" ? "Video" : "Foto");
  if (isHighResolutionItem(item)) parts.push("HD");
  if (item.source && /\+(?!audit\b)|atajo|cdn:|pinterest:|x:|linkedin:|tumblr:/i.test(item.source)) {
    parts.push("Mejorada");
  }
  if (width && height) parts.push(`${width}x${height}`);
  if (!width && !height) parts.push("Sin medir");
  return parts.join(" · ");
}

function matchesGalleryFilters(item) {
  if (galleryFilters.type !== "all" && item.type !== galleryFilters.type) return false;

  const orientation = itemOrientation(item);
  if (galleryFilters.orientation !== "all" && orientation !== galleryFilters.orientation) return false;

  if (galleryFilters.quality === "hd" && !isHighResolutionItem(item)) return false;
  if (galleryFilters.quality === "unknown") {
    const { width, height } = itemDimensions(item);
    if (width || height) return false;
  }

  return true;
}

function filteredGalleryItems() {
  return currentItems.filter(matchesGalleryFilters);
}

function selectedItems() {
  return currentItems.filter((item) => selectedItemKeys.has(itemKey(item)));
}

function visibleSelectedItems() {
  return galleryViewItems.filter((item) => selectedItemKeys.has(itemKey(item)));
}

function zipSourceItems() {
  const picked = selectedItems();
  return picked.length > 0 ? picked : galleryViewItems;
}

function zipCandidateItems() {
  return largeDownloadItems(zipSourceItems());
}

function syncSelectedItems() {
  const valid = new Set(currentItems.map(itemKey));
  selectedItemKeys = new Set([...selectedItemKeys].filter((key) => valid.has(key)));
}

function galleryStatsText() {
  const total = currentItems.length;
  const visible = galleryViewItems.length;
  const videos = galleryViewItems.filter((item) => item.type === "video").length;
  const hd = galleryViewItems.filter(isHighResolutionItem).length;
  const unknown = galleryViewItems.filter((item) => {
    const { width, height } = itemDimensions(item);
    return !width && !height;
  }).length;
  const thumbnails = filteredReportCount(/thumbnail|dimension <=540|miniatura/i);
  const resourceNoise = filteredReportCount(/performance sin elemento visible/i);
  const pieces = [
    `${visible}/${total} visibles`,
    `${hd} HD`,
    `${videos} videos`,
    `${unknown} sin medir`,
  ];
  if (thumbnails) pieces.push(`${thumbnails} miniaturas filtradas`);
  if (resourceNoise) pieces.push(`${resourceNoise} recursos invisibles filtrados`);
  if (galleryViewItems.length > GALLERY_VIRTUALIZE_AT) pieces.push("render virtualizado activo");
  return pieces.join(" · ");
}

function auditSummaryText(audit) {
  const thumbnails = filteredReportCount(/thumbnail|dimension <=540|miniatura/i);
  const previewFailures = filteredReportCount(/preview no disponible/i);
  const resourceNoise = filteredReportCount(/performance sin elemento visible/i);
  const filteredParts = [];
  if (thumbnails) filteredParts.push(`${thumbnails} miniatura${thumbnails === 1 ? "" : "s"}`);
  if (previewFailures) filteredParts.push(`${previewFailures} preview${previewFailures === 1 ? "" : "s"} sin carga`);
  if (resourceNoise) filteredParts.push(`${resourceNoise} recurso${resourceNoise === 1 ? "" : "s"} invisible${resourceNoise === 1 ? "" : "s"}`);

  return [
    `Auditadas ${audit.measured} resolucion${audit.measured === 1 ? "" : "es"} reales${audit.skipped ? `; ${audit.skipped} ya venian medidas` : ""}`,
    filteredParts.length ? `filtradas ${filteredParts.join(", ")}` : `filtradas ${audit.filtered} miniatura${audit.filtered === 1 ? "" : "s"}`,
  ].join("; ");
}

async function runGalleryAudit(items, label = "galeria") {
  const auditId = ++activeAuditId;
  const total = items.length;
  if (total === 0) return;

  let lastProgressMessage = 0;
  try {
    await yieldToPaint();
    if (auditId !== activeAuditId) return;
    const audit = await auditGalleryDimensions(items, label, {
      onProgress(progress) {
        if (auditId !== activeAuditId) return;
        const now = performance.now();
        if (now - lastProgressMessage < 280 && progress.processed < progress.total) return;
        lastProgressMessage = now;
        setMessage(
          `Galeria usable: ${total} elemento(s). Refinando dimensiones en segundo plano... ${progress.processed}/${progress.total}`,
        );
      },
    });

    if (auditId !== activeAuditId) return;
    currentItems = audit.items;
    renderGallery(currentItems);
    setMessage(
      currentItems.length > 0
        ? `${label === "capture" ? "Captura local" : "Galeria manual"} lista: ${currentItems.length} elemento(s) utiles. ${auditSummaryText(audit)}.`
        : `${label === "capture" ? "La captura local" : "La galeria manual"} no trajo media util. ${auditSummaryText(audit)}.`,
      currentItems.length === 0,
    );
  } catch (error) {
    if (auditId !== activeAuditId) return;
    setMessage(`La galeria ya esta usable, pero fallo el audit de dimensiones: ${error.message}`, true);
  }
}

function updateFilterButtons() {
  elements.filterChips.forEach((chip) => {
    const active = galleryFilters[chip.dataset.filterGroup] === chip.dataset.filterValue;
    chip.classList.toggle("is-active", active);
    chip.setAttribute("aria-pressed", String(active));
  });
}

function updateGalleryControls() {
  const selected = selectedItems();
  const selectedVisible = visibleSelectedItems();
  const zipCount = zipCandidateItems().length;
  const hiddenByFilter = Math.max(0, currentItems.length - galleryViewItems.length);
  const everyVisibleSelected =
    galleryViewItems.length > 0 && galleryViewItems.every((item) => selectedItemKeys.has(itemKey(item)));
  const hasActionableOutput = currentItems.length > 0 || lastGalleryReport.length > 0;

  elements.actionRow.hidden = !hasActionableOutput;
  elements.galleryToolbar.hidden = currentItems.length === 0;
  elements.galleryEmpty.hidden = currentItems.length === 0 || galleryViewItems.length > 0;
  elements.resultsCount.textContent = selected.length
    ? `${galleryViewItems.length} visibles · ${selected.length} seleccionados`
    : `${galleryViewItems.length} ${galleryViewItems.length === 1 ? "elemento" : "elementos"}${hiddenByFilter ? ` · ${hiddenByFilter} ocultos` : ""}`;
  elements.selectionSummary.textContent = selected.length
    ? `${selected.length} seleccionado${selected.length === 1 ? "" : "s"}${selectedVisible.length !== selected.length ? ` · ${selectedVisible.length} visible${selectedVisible.length === 1 ? "" : "s"}` : ""}`
    : "Sin seleccion";
  elements.clearSelection.disabled = selected.length === 0;
  elements.selectVisible.disabled = galleryViewItems.length === 0;
  elements.selectVisible.textContent = everyVisibleSelected ? "Quitar visibles" : "Seleccionar visibles";
  elements.copyAll.disabled = currentItems.length === 0 || zipSourceItems().length === 0;
  elements.loadCapture.disabled = isStaticPagesMode;
  elements.upgradeQuality.disabled = currentItems.length === 0;
  elements.downloadLarge.disabled = zipCount === 0;
  elements.downloadLarge.textContent = selected.length > 0
    ? zipCount > 0
      ? isStaticPagesMode
        ? `Descargar ${zipCount} directas`
        : `Descargar ${zipCount} ZIP`
      : "Sin elegibles ZIP"
    : isStaticPagesMode
      ? "Descargar directas >500"
      : "Descargar >500 ZIP";
  elements.downloadReport.disabled = currentItems.length === 0 && lastGalleryReport.length === 0;
  elements.galleryStats.textContent = currentItems.length ? galleryStatsText() : "";
  updateFilterButtons();
}

function galleryGridMetrics(total) {
  const gap = 10;
  const minWidth = window.matchMedia("(max-width: 620px)").matches ? 150 : 176;
  const width = Math.max(elements.gallery.clientWidth || 0, minWidth);
  const columns = Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
  const cardWidth = Math.max(minWidth, (width - gap * (columns - 1)) / columns);
  const rowHeight = cardWidth + gap;
  const totalRows = Math.ceil(total / columns);
  const totalHeight = totalRows > 0 ? totalRows * rowHeight - gap : 0;
  return { columns, gap, cardWidth, rowHeight, totalRows, totalHeight };
}

function spacer(height) {
  const node = document.createElement("div");
  node.className = "gallery-spacer";
  node.style.height = `${Math.max(0, Math.round(height))}px`;
  return node;
}

function mediaSourceForItem(item) {
  return item.type === "video" ? item.url : item.previewUrl || item.url;
}

function mediaPosterForItem(item) {
  return item.type === "video" && item.previewUrl && item.previewUrl !== item.url ? item.previewUrl : "";
}

function ensureLazyMediaObserver() {
  if (!("IntersectionObserver" in window)) return null;
  if (lazyMediaObserver) return lazyMediaObserver;

  lazyMediaObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        loadLazyMedia(entry.target);
      });
    },
    { root: null, rootMargin: GALLERY_LAZY_ROOT_MARGIN, threshold: 0.01 },
  );
  return lazyMediaObserver;
}

function loadLazyMedia(media) {
  const src = media.dataset.src;
  if (!src) return;

  lazyMediaObserver?.unobserve(media);
  media.classList.remove("is-lazy");
  if (media.tagName === "VIDEO") {
    const poster = media.dataset.poster || "";
    if (poster) media.poster = poster;
    if (media.getAttribute("src") !== src) media.src = src;
    media.load();
  } else if (media.getAttribute("src") !== src) {
    media.src = src;
  }

  delete media.dataset.src;
  delete media.dataset.poster;
}

function releaseGalleryCard(node) {
  node.querySelectorAll("img, video").forEach((media) => {
    lazyMediaObserver?.unobserve(media);
  });
}

function syncGalleryCardCacheVersion() {
  if (galleryCardCacheVersion === galleryRenderVersion) return;

  galleryCardCache.forEach(releaseGalleryCard);
  elements.gallery.replaceChildren();
  galleryCardCache = new Map();
  galleryActiveCardKeys = new Set();
  galleryCardCacheVersion = galleryRenderVersion;
  lazyMediaObserver?.disconnect();
  lazyMediaObserver = null;
}

function galleryCardCacheKey(item, index) {
  return `${galleryRenderVersion}:${itemKey(item) || index}`;
}

function pruneGalleryCardCache(activeKeys) {
  if (galleryCardCache.size <= GALLERY_CARD_CACHE_LIMIT) return;

  for (const [key, node] of galleryCardCache) {
    if (activeKeys.has(key)) continue;
    releaseGalleryCard(node);
    galleryCardCache.delete(key);
    if (galleryCardCache.size <= GALLERY_CARD_CACHE_LIMIT) return;
  }
}

function attachLazyMedia(media, item, index) {
  const src = mediaSourceForItem(item);
  if (!src) return;

  media.dataset.src = src;
  const poster = mediaPosterForItem(item);
  if (poster) media.dataset.poster = poster;
  const alreadyLoaded = loadedGalleryMediaSources.has(src);
  media.classList.toggle("is-lazy", !alreadyLoaded);
  media.classList.toggle("is-loaded", alreadyLoaded);

  const eager = index < GALLERY_EAGER_MEDIA_COUNT;
  const observer = ensureLazyMediaObserver();
  if (eager || alreadyLoaded || !observer) {
    loadLazyMedia(media);
  } else {
    observer.observe(media);
  }
}

function loadRenderedGalleryMedia(root = elements.gallery) {
  root.querySelectorAll("img.is-lazy, video.is-lazy").forEach(loadLazyMedia);
}

function loadNearbyGalleryMedia() {
  const minY = -GALLERY_IMMEDIATE_LOAD_MARGIN;
  const maxY = window.innerHeight + GALLERY_IMMEDIATE_LOAD_MARGIN;
  elements.gallery.querySelectorAll("img.is-lazy, video.is-lazy").forEach((media) => {
    const card = media.closest(".media-card");
    const rect = card?.getBoundingClientRect();
    if (!rect || (rect.bottom >= minY && rect.top <= maxY)) loadLazyMedia(media);
  });
}

function createMediaCard(item, index) {
  const node = elements.template.content.firstElementChild.cloneNode(true);
  const preview = node.querySelector(".preview");
  const download = document.createElement("a");
  const select = document.createElement("button");
  const status = document.createElement("span");
  const error = document.createElement("div");
  const retry = document.createElement("button");
  const filename = filenameFor(item, index);
  const key = itemKey(item);

  preview.classList.add("m-clickable");
  node.dataset.itemKey = key;
  node.classList.toggle("is-selected", selectedItemKeys.has(key));
  node.classList.toggle("is-error", Boolean(item.loadError));
  node.setAttribute("aria-label", viewerCaptionFor(item, index, galleryViewItems.length));
  node.title = [
    viewerCaptionFor(item, index, galleryViewItems.length),
    itemStatusLabel(item),
    item.platform,
    item.source,
  ]
    .filter(Boolean)
    .join(" / ");
  preview.addEventListener("click", () => openMediaViewer(item, index, galleryViewItems));

  select.className = "media-select";
  select.type = "button";
  select.setAttribute("aria-label", selectedItemKeys.has(key) ? "Quitar de seleccion" : "Seleccionar para ZIP");
  select.setAttribute("aria-pressed", String(selectedItemKeys.has(key)));
  select.addEventListener("click", (event) => {
    event.stopPropagation();
    if (selectedItemKeys.has(key)) {
      selectedItemKeys.delete(key);
    } else {
      selectedItemKeys.add(key);
    }
    renderGallery();
  });
  preview.append(select);

  status.className = "media-status";
  status.textContent = itemStatusLabel(item);
  preview.append(status);

  let media;
  if (item.type === "video") {
    media = document.createElement("video");
    media.controls = false;
    media.muted = true;
    media.playsInline = true;
    media.preload = "metadata";
  } else {
    media = document.createElement("img");
    media.alt = item.caption || viewerCaptionFor(item, index, galleryViewItems.length);
    media.loading = index < GALLERY_EAGER_MEDIA_COUNT ? "eager" : "lazy";
    media.decoding = "async";
    if ("fetchPriority" in media) media.fetchPriority = index < 8 ? "high" : "low";
  }

  media.addEventListener("error", () => {
    item.loadError = true;
    node.classList.add("is-error");
    status.textContent = itemStatusLabel(item);
    error.hidden = false;
  });
  media.addEventListener("load", () => {
    item.loadError = false;
    loadedGalleryMediaSources.add(mediaSourceForItem(item));
    media.classList.add("is-loaded");
    if (item.type === "image" && media.naturalWidth && media.naturalHeight && (!item.width || !item.height)) {
      item.width = media.naturalWidth;
      item.height = media.naturalHeight;
      dimensionProbeCache.set(item.url, { width: item.width, height: item.height, ok: true, error: "" });
    }
    node.classList.remove("is-error");
    status.textContent = itemStatusLabel(item);
    error.hidden = true;
    scheduleGalleryControlsUpdate();
  });
  media.addEventListener("loadedmetadata", () => {
    if (item.type !== "video") return;
    item.loadError = false;
    loadedGalleryMediaSources.add(mediaSourceForItem(item));
    media.classList.add("is-loaded");
    if (media.videoWidth && media.videoHeight && (!item.width || !item.height)) {
      item.width = media.videoWidth;
      item.height = media.videoHeight;
      dimensionProbeCache.set(item.url, { width: item.width, height: item.height, ok: true, error: "" });
      status.textContent = itemStatusLabel(item);
      scheduleGalleryControlsUpdate();
    }
  });
  preview.append(media);
  attachLazyMedia(media, item, index);

  error.className = "media-error";
  error.hidden = !item.loadError;
  error.innerHTML = "<span>No cargo este item</span>";
  retry.className = "tertiary";
  retry.type = "button";
  retry.textContent = "Reintentar";
  retry.addEventListener("click", (event) => {
    event.stopPropagation();
    item.loadError = false;
    error.hidden = true;
    node.classList.remove("is-error");
    const src = mediaSourceForItem(item);
    lazyMediaObserver?.unobserve(media);
    media.removeAttribute("src");
    media.classList.remove("is-loaded");
    if (item.type === "video") media.load();
    requestAnimationFrame(() => {
      media.dataset.src = src;
      const poster = mediaPosterForItem(item);
      if (poster) media.dataset.poster = poster;
      loadLazyMedia(media);
    });
  });
  error.append(retry);
  preview.append(error);

  download.className = "download-link";
  configureDownloadLink(download, item, filename);
  preview.append(download);
  return node;
}

function placeVirtualCard(node, index, metrics) {
  const row = Math.floor(index / metrics.columns);
  const column = index % metrics.columns;
  const x = column * (metrics.cardWidth + metrics.gap);
  const y = row * metrics.rowHeight;
  node.style.width = `${metrics.cardWidth}px`;
  node.style.height = `${metrics.cardWidth}px`;
  node.style.setProperty("--gallery-card-transform", `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`);
}

function renderGalleryWindow() {
  galleryRenderRequest = 0;
  syncGalleryCardCacheVersion();

  const total = galleryViewItems.length;
  if (total === 0) {
    galleryWindowSignature = `empty:${galleryRenderVersion}`;
    galleryCardCache.forEach(releaseGalleryCard);
    galleryCardCache.clear();
    galleryActiveCardKeys.clear();
    elements.gallery.classList.remove("is-virtual");
    elements.gallery.style.height = "";
    elements.gallery.replaceChildren();
    return;
  }

  const fragment = document.createDocumentFragment();
  const activeKeys = new Set();
  const shouldVirtualize = total > GALLERY_VIRTUALIZE_AT;
  let startIndex = 0;
  let endIndex = total;
  let metrics = null;

  if (shouldVirtualize) {
    metrics = galleryGridMetrics(total);
    const galleryTop = elements.gallery.getBoundingClientRect().top + window.scrollY;
    const viewportTop = window.scrollY;
    const viewportBottom = viewportTop + window.innerHeight;
    const rawStartRow = Math.max(0, Math.floor((viewportTop - galleryTop) / metrics.rowHeight) - GALLERY_OVERSCAN_ROWS);
    const rawEndRow = Math.min(
      metrics.totalRows,
      Math.ceil((viewportBottom - galleryTop) / metrics.rowHeight) + GALLERY_OVERSCAN_ROWS,
    );
    const startRow = Math.max(0, Math.floor(rawStartRow / GALLERY_WINDOW_ROW_STEP) * GALLERY_WINDOW_ROW_STEP);
    const endRow = Math.min(
      metrics.totalRows,
      Math.ceil(rawEndRow / GALLERY_WINDOW_ROW_STEP) * GALLERY_WINDOW_ROW_STEP,
    );

    startIndex = Math.max(0, startRow * metrics.columns);
    endIndex = Math.min(total, endRow * metrics.columns);

    const signature = [
      "virtual",
      galleryRenderVersion,
      total,
      startIndex,
      endIndex,
      metrics.columns,
      Math.round(metrics.cardWidth),
      Math.round(metrics.totalHeight),
    ].join(":");
    if (signature === galleryWindowSignature) {
      return;
    }
    galleryWindowSignature = signature;
    elements.gallery.classList.add("is-virtual");
    elements.gallery.style.height = `${Math.ceil(metrics.totalHeight)}px`;
  } else {
    const signature = `full:${galleryRenderVersion}:${total}`;
    if (signature === galleryWindowSignature) {
      return;
    }
    galleryWindowSignature = signature;
    elements.gallery.classList.remove("is-virtual");
    elements.gallery.style.height = "";
  }

  galleryViewItems.slice(startIndex, endIndex).forEach((item, offset) => {
    const index = startIndex + offset;
    const key = galleryCardCacheKey(item, index);
    let card = galleryCardCache.get(key);
    if (!card) {
      card = createMediaCard(item, index);
      galleryCardCache.set(key, card);
    }
    activeKeys.add(key);
    if (metrics) placeVirtualCard(card, index, metrics);
    if (card.parentElement !== elements.gallery || !galleryActiveCardKeys.has(key)) {
      fragment.append(card);
    }
  });

  if (shouldVirtualize) {
    galleryActiveCardKeys.forEach((key) => {
      if (activeKeys.has(key)) return;
      const card = galleryCardCache.get(key);
      if (!card) return;
      releaseGalleryCard(card);
      card.remove();
    });
    if (fragment.childNodes.length > 0) {
      elements.gallery.append(fragment);
    }
    loadNearbyGalleryMedia();
    galleryActiveCardKeys = activeKeys;
  } else {
    loadRenderedGalleryMedia(fragment);
    elements.gallery.replaceChildren(fragment);
    galleryActiveCardKeys = activeKeys;
  }
  pruneGalleryCardCache(activeKeys);
}

function scheduleGalleryWindowRender() {
  if (galleryRenderRequest) return;
  galleryRenderRequest = requestAnimationFrame(renderGalleryWindow);
}

function renderGallery(items = currentItems) {
  currentItems = items;
  syncSelectedItems();
  galleryViewItems = filteredGalleryItems();
  galleryRenderVersion += 1;
  galleryWindowSignature = "";
  updateGalleryControls();
  scheduleGalleryWindowRender();
}

elements.filterChips.forEach((chip) => {
  chip.addEventListener("click", () => {
    const group = chip.dataset.filterGroup;
    if (!group) return;
    galleryFilters[group] = chip.dataset.filterValue || "all";
    renderGallery();
  });
});

elements.selectVisible.addEventListener("click", () => {
  const everyVisibleSelected =
    galleryViewItems.length > 0 && galleryViewItems.every((item) => selectedItemKeys.has(itemKey(item)));
  galleryViewItems.forEach((item) => {
    const key = itemKey(item);
    if (everyVisibleSelected) {
      selectedItemKeys.delete(key);
    } else {
      selectedItemKeys.add(key);
    }
  });
  renderGallery();
});

elements.clearSelection.addEventListener("click", () => {
  selectedItemKeys.clear();
  renderGallery();
});

window.addEventListener(
  "scroll",
  () => {
    if (galleryViewItems.length > GALLERY_VIRTUALIZE_AT) scheduleGalleryWindowRender();
  },
  { passive: true },
);
window.addEventListener("resize", () => {
  scheduleGalleryWindowRender();
  refreshViewerLayout();
});

elements.parseSource.addEventListener("click", async () => {
  const raw = elements.sourceInput.value;
  if (!raw.trim()) {
    setMessage("Pega primero HTML, JSON, source o URLs de la pagina.", true);
    return;
  }

  setMessage("Buscando media y resolviendo enlaces conocidos...");
  activeAuditId += 1;
  activeResolveId += 1;
  await yieldToBrowser();
  let parsed = parseMediaDetailed(raw).items;
  selectedItemKeys.clear();
  currentItems = parsed;
  renderGallery(parsed);
  if (parsed.length === 0) {
    setMessage("No encontre media util.", true);
    return;
  }
  setMessage(`Galeria manual usable: ${parsed.length} elemento(s). Refinando dimensiones en segundo plano...`);
  void resolveAndMergePageMedia(raw, "source");
  void runGalleryAudit(parsed, "source");
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

  logCaptureDebug("captura recibida", { summary: captureSummaryForDebug(capture) });

  setMessage("Leyendo captura local y resolviendo enlaces X si aparecen...");
  activeAuditId += 1;
  activeResolveId += 1;
  await yieldToBrowser();
  let items = parseMediaDetailed(capture.body).items;
  logCaptureDebug("despues de parse", { items, reportRows: lastGalleryReport });
  selectedItemKeys.clear();
  currentItems = items;
  renderGallery(items);
  if (items.length === 0) {
    setMessage("La captura local no trajo media util.", true);
    return;
  }
  setMessage(`Captura local usable: ${items.length} elemento(s). Refinando dimensiones en segundo plano...`);
  void resolveAndMergePageMedia(capture.body, "capture");
  void runGalleryAudit(items, "capture").then(() => {
    logCaptureDebug("despues de audit", { items: currentItems, reportRows: lastGalleryReport });
  });
});

elements.upgradeQuality.addEventListener("click", async () => {
  if (currentItems.length === 0) return;
  activeAuditId += 1;
  activeResolveId += 1;

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
      setMessage(`Buscando maxima calidad${isStaticPagesMode ? " en navegador" : ""}... ${completed}/${currentItems.length}`);
      return result.item;
    });

    currentItems = sortMediaItems(filterSmallKnownItems(dedupeItems(results)));
    renderGallery(currentItems);
    const failureText = [...failureSamples].filter(Boolean).slice(0, 2).join(" / ");
    setMessage(
      improved > 0
        ? `Mejore ${improved} de ${results.length} elemento(s).${isStaticPagesMode ? " En Pages se valida por carga real en el navegador, sin proxy." : " Si alguno sigue pequeno, esa pagina solo expuso miniaturas o el CDN rechazo la variante HD."}`
        : `Revise las URLs, pero no encontre variantes de mayor calidad que carguen.${failureText ? ` Motivo visto: ${failureText}.` : ""}`,
      improved === 0,
    );
  } catch (error) {
    setMessage(`No pude mejorar la calidad: ${error.message}`, true);
  } finally {
    elements.parseSource.disabled = false;
    elements.clearAll.disabled = false;
    if (!isStaticPagesMode) elements.loadCapture.disabled = false;
    renderGallery(currentItems);
  }
});

elements.downloadLarge.addEventListener("click", async () => {
  const zipItems = zipCandidateItems();
  const selectedCount = selectedItems().length;
  if (zipItems.length === 0) {
    setMessage("No hay elementos descargables en la vista actual: imagenes >=500 x 500 o videos, siempre sin dimension 540.", true);
    return;
  }

  if (isStaticPagesMode) {
    await downloadStaticItems(zipItems);
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
    setMessage(
      `Preparando ZIP con ${zipItems.length} elemento(s)${selectedCount ? " seleccionados" : " visibles"}, excluyendo resoluciones 540x...`,
    );
    const response = await fetch("/api/download-zip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: zipItems.map((item, index) => {
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
    elements.clearAll.disabled = false;
    if (!isStaticPagesMode) elements.loadCapture.disabled = false;
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
  setMessage("Reporte TXT generado en el navegador; no guarde historial local.");
});

elements.copyAll.addEventListener("click", async () => {
  const items = zipSourceItems();
  if (items.length === 0) return;
  await navigator.clipboard.writeText(items.map((item) => item.url).join("\n"));
  setMessage(selectedItemKeys.size > 0 ? "URLs seleccionadas copiadas." : "URLs visibles copiadas.");
});

elements.clearAll.addEventListener("click", () => {
  activeAuditId += 1;
  activeResolveId += 1;
  elements.sourceInput.value = "";
  currentItems = [];
  lastGalleryReport = [];
  selectedItemKeys.clear();
  renderGallery([]);
  setMessage("");
  if (!isStaticPagesMode) {
    fetch("/api/capture", { method: "DELETE" }).catch(() => {});
  }
});

elements.viewerClose.addEventListener("click", closeMediaViewer);
elements.viewerPrev.addEventListener("click", () => goToViewerItem(-1));
elements.viewerNext.addEventListener("click", () => goToViewerItem(1));
elements.viewerZoomOut.addEventListener("click", () => zoomViewerBy(0.8));
elements.viewerZoomReset.addEventListener("click", fitViewerMedia);
elements.viewerZoomIn.addEventListener("click", () => zoomViewerBy(1.25));
elements.viewerCopyUrl.addEventListener("click", async () => {
  if (!viewerState.item?.url) return;
  await navigator.clipboard.writeText(viewerState.item.url);
  setMessage(`URL copiada: ${elements.viewerCaption.textContent}`);
});
elements.viewer.addEventListener("click", (event) => {
  if (event.target === elements.viewer) closeMediaViewer();
});
elements.viewerStage.addEventListener("click", (event) => {
  if (viewerState.suppressClick) {
    event.preventDefault();
    event.stopPropagation();
    viewerState.suppressClick = false;
    return;
  }
  if (event.target === elements.viewerStage || event.target === viewerState.frame) closeMediaViewer();
});
elements.viewerStage.addEventListener("pointerdown", startViewerPan);
elements.viewerStage.addEventListener("pointermove", moveViewerPan);
elements.viewerStage.addEventListener("pointerup", endViewerPan);
elements.viewerStage.addEventListener("pointercancel", endViewerPan);
elements.viewerStage.addEventListener(
  "wheel",
  (event) => {
    if (elements.viewer.hidden || viewerState.item?.type === "video") return;
    event.preventDefault();
    zoomViewerBy(wheelZoomFactor(event));
  },
  { passive: false },
);
document.addEventListener("keydown", (event) => {
  if (elements.viewer.hidden) return;

  if (event.key === "Tab") {
    trapViewerFocus(event);
    return;
  }

  if (event.key === "Escape") {
    closeMediaViewer();
    return;
  }

  if (event.key === "ArrowLeft") {
    event.preventDefault();
    goToViewerItem(-1);
    return;
  }

  if (event.key === "ArrowRight") {
    event.preventDefault();
    goToViewerItem(1);
    return;
  }

  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    zoomViewerBy(1.25);
    return;
  }

  if (event.key === "-" || event.key === "_") {
    event.preventDefault();
    zoomViewerBy(0.8);
    return;
  }

  if (event.key === "0") {
    event.preventDefault();
    fitViewerMedia();
  }
});

if (isStaticPagesMode) {
  const privacyStatus = document.querySelector("#privacy-status");
  if (privacyStatus) privacyStatus.textContent = "Demo GitHub Pages";
  elements.downloadLarge.textContent = "Descargar directas >500";
  elements.loadCapture.disabled = true;
  setMessage("Modo Pages: puedes pegar HTML/JSON/URLs, auditar dimensiones, mejorar calidad en navegador y descargar enlaces directos. Captura local y ZIP con proxy requieren npm start.", true);
}

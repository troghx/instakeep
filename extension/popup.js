const statusNode = document.querySelector("#status");
const captureButton = document.querySelector("#capture");
const deepCaptureButton = document.querySelector("#deep-capture");
const appUrlInput = document.querySelector("#app-url");
const openAppLink = document.querySelector("#open-app");
const defaultAppUrl = "https://instakeep-troghx.netlify.app";

function normalizeAppUrl(value) {
  const raw = String(value || "").trim() || defaultAppUrl;
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("La app destino debe usar http o https.");
  }
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function loadAppUrl() {
  const stored = await chrome.storage.local.get({ appUrl: defaultAppUrl });
  try {
    return normalizeAppUrl(stored.appUrl);
  } catch {
    return defaultAppUrl;
  }
}

async function saveAppUrl(value) {
  const appUrl = normalizeAppUrl(value);
  await chrome.storage.local.set({ appUrl });
  if (appUrlInput) appUrlInput.value = appUrl;
  if (openAppLink) openAppLink.href = appUrl;
  return appUrl;
}

function isLocalEndpoint(endpointUrl) {
  try {
    const url = new URL(endpointUrl);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function compactCaptureForCloud(result) {
  return {
    ...result,
    html: "",
    text: "",
    resources: Array.isArray(result.resources) ? result.resources.slice(0, 2500) : [],
    elements: Array.isArray(result.elements) ? result.elements.slice(0, 2500) : [],
    mediaElements: Array.isArray(result.mediaElements) ? result.mediaElements : [],
    structuredMedia: Array.isArray(result.structuredMedia) ? result.structuredMedia : [],
    compactCloudCapture: true,
  };
}

function captureBodyForEndpoint(result, endpointUrl) {
  if (isLocalEndpoint(endpointUrl)) return JSON.stringify(result);

  let compact = compactCaptureForCloud(result);
  let body = JSON.stringify(compact);
  while (new Blob([body]).size > 5_200_000 && compact.resources.length + compact.elements.length > 0) {
    compact = {
      ...compact,
      resources: compact.resources.slice(0, Math.floor(compact.resources.length / 2)),
      elements: compact.elements.slice(0, Math.floor(compact.elements.length / 2)),
    };
    body = JSON.stringify(compact);
  }
  if (new Blob([body]).size > 5_200_000) {
    throw new Error("La captura compacta excede el limite cloud. Usa la app local para esta pagina.");
  }
  return body;
}

loadAppUrl().then((appUrl) => {
  if (appUrlInput) appUrlInput.value = appUrl;
  if (openAppLink) openAppLink.href = appUrl;
});

appUrlInput?.addEventListener("change", async () => {
  try {
    const appUrl = await saveAppUrl(appUrlInput.value);
    statusNode.textContent = `App destino guardada: ${appUrl}`;
  } catch (error) {
    statusNode.textContent = `URL invalida: ${error.message}`;
  }
});

async function collectCurrentPage(options = {}) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const maxResourceUrls = 60_000;
  const maxElementUrls = 60_000;
  const maxMediaElements = 30_000;
  const maxDeepSteps = 500;
  const deepStepDelayMs = 260;
  const settleDelayMs = 520;
  try {
    performance.setResourceTimingBufferSize?.(120_000);
  } catch {
    // Some pages lock down performance APIs.
  }

  const deep = Boolean(options.deep);
  const originalY = window.scrollY;
  const resourceSet = new Set();
  const elementSet = new Set();
  const mediaElementMap = new Map();
  let resourceCursor = 0;
  let styleCursor = 0;
  let completedSteps = 0;

  const attrs = [
    "content",
    "href",
    "poster",
    "src",
    "srcset",
    "data-full-url",
    "data-href",
    "data-image",
    "data-original",
    "data-src",
    "data-url",
    "data-video-url",
  ];
  const attrSelector = [
    "img",
    "video",
    "source",
    "a[href]",
    "meta[content]",
    "[poster]",
    "[src]",
    "[srcset]",
    "[data-full-url]",
    "[data-href]",
    "[data-image]",
    "[data-original]",
    "[data-src]",
    "[data-url]",
    "[data-video-url]",
  ].join(",");

  const addUrl = (target, value) => {
    if (target.size >= (target === resourceSet ? maxResourceUrls : maxElementUrls)) return;
    if (value && /^https?:\/\//i.test(value)) target.add(value);
  };

  const addUrlsFromText = (target, value) => {
    if (!value || target.size >= (target === resourceSet ? maxResourceUrls : maxElementUrls)) return;
    const text = String(value);
    for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\)]+/g)) {
      addUrl(target, match[0]);
    }
  };

  const rememberMediaElement = (node, rawUrl) => {
    if (mediaElementMap.size >= maxMediaElements && !mediaElementMap.has(rawUrl)) return;
    if (!/^https?:\/\//i.test(rawUrl || "")) return;

    const postLink = node.closest?.('a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]');
    const postHref = postLink?.getAttribute("href") || postLink?.href || "";
    const postShortcode = postHref.match(/\/(?:[^/]+\/)?(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i)?.[1] || "";
    const next = {
      url: rawUrl,
      tag: node.tagName.toLowerCase(),
      width: node.naturalWidth || node.videoWidth || node.width || 0,
      height: node.naturalHeight || node.videoHeight || node.height || 0,
      clientWidth: node.clientWidth || 0,
      clientHeight: node.clientHeight || 0,
      className: String(node.className || "").slice(0, 200),
      shortcode: postShortcode,
      caption: postShortcode && node.tagName.toLowerCase() === "img" ? node.alt || "" : "",
      postUrl: postShortcode ? new URL(postHref, location.href).toString() : "",
    };
    const previous = mediaElementMap.get(rawUrl);
    const previousPixels = (previous?.width || 0) * (previous?.height || 0);
    const nextPixels = (next.width || 0) * (next.height || 0);
    if (!previous || nextPixels > previousPixels) mediaElementMap.set(rawUrl, next);
  };

  const collectNewResources = () => {
    const entries = performance.getEntriesByType("resource");
    if (resourceCursor > entries.length) resourceCursor = 0;
    for (let index = resourceCursor; index < entries.length; index += 1) {
      addUrl(resourceSet, entries[index].name);
    }
    resourceCursor = entries.length;
  };

  const collectMediaNodes = () => {
    document.querySelectorAll("img, video, source").forEach((node) => {
      [node.currentSrc, node.src, node.poster].forEach((value) => {
        addUrl(elementSet, value);
      });
      addUrlsFromText(elementSet, node.getAttribute?.("srcset"));

      const url = node.currentSrc || node.src || node.poster || "";
      rememberMediaElement(node, url);
    });
  };

  const collectAttributeUrls = () => {
    document.querySelectorAll(attrSelector).forEach((node) => {
      attrs.forEach((attr) => {
        const value = node.getAttribute?.(attr);
        addUrlsFromText(elementSet, value);
      });
    });
  };

  const collectStyleUrls = (fullScan = false) => {
    const styledNodes = Array.from(document.querySelectorAll("[style]"));
    const limit = fullScan ? styledNodes.length : Math.min(styledNodes.length, styleCursor + 900);
    for (let index = fullScan ? 0 : styleCursor; index < limit; index += 1) {
      const style = getComputedStyle(styledNodes[index]);
      [style.backgroundImage, style.listStyleImage, style.borderImageSource].forEach((value) => {
        addUrlsFromText(elementSet, value);
      });
    }
    styleCursor = limit >= styledNodes.length ? 0 : limit;
  };

  const collectLight = () => {
    collectNewResources();
    collectMediaNodes();
  };

  const collectHeavy = (fullStyleScan = false) => {
    collectLight();
    collectAttributeUrls();
    collectStyleUrls(fullStyleScan);
  };

  const instagramShortcodeFromLocation = () => {
    if (!/instagram\.com$/i.test(location.hostname) && !/\.instagram\.com$/i.test(location.hostname)) return "";
    return location.pathname.match(/\/(?:[^/]+\/)?(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i)?.[1] || "";
  };

  const structuredCaption = (node) => {
    if (!node || typeof node !== "object") return "";
    if (typeof node.accessibility_caption === "string") return node.accessibility_caption;
    if (typeof node.caption === "string") return node.caption;
    if (node.caption && typeof node.caption.text === "string") return node.caption.text;
    const captionEdge = node.edge_media_to_caption?.edges?.[0]?.node?.text;
    return typeof captionEdge === "string" ? captionEdge : "";
  };

  const bestStructuredResource = (resources, mediaType = "") => {
    if (!Array.isArray(resources)) return null;
    return resources
      .map((item) => ({
        url: item?.url || item?.src || "",
        width: Number(item?.width || item?.config_width || 0),
        height: Number(item?.height || item?.config_height || 0),
        bitrate: Number(item?.bitrate || 0),
      }))
      .filter((item) => /^https?:\/\//i.test(item.url))
      .filter((item) => !mediaType || (mediaType === "video" ? /\.(m3u8?|m4v|mov|mp4|webm)(?:$|[?#])/i.test(item.url) || /video/i.test(item.url) : !/\.mp4|video/i.test(item.url)))
      .sort((a, b) => b.bitrate - a.bitrate || b.width * b.height - a.width * a.height)[0];
  };

  const postShortcodeFromUrl = (value) => {
    try {
      const url = new URL(value, location.href);
      return url.pathname.match(/\/(?:[^/]+\/)?(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i)?.[1] || "";
    } catch {
      return "";
    }
  };

  const instagramCarouselPostCandidates = () => {
    if (!/instagram\.com$/i.test(location.hostname) && !/\.instagram\.com$/i.test(location.hostname)) return [];
    const activeShortcode = instagramShortcodeFromLocation();
    if (activeShortcode) return [];

    const candidates = new Map();
    document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]').forEach((anchor) => {
      const shortcode = postShortcodeFromUrl(anchor.href || anchor.getAttribute("href") || "");
      if (!shortcode || candidates.has(shortcode)) return;

      const labelParts = [anchor.getAttribute("aria-label"), anchor.title, anchor.innerText];
      anchor.querySelectorAll("img").forEach((image) => {
        labelParts.push(image.alt, image.currentSrc, image.src);
      });
      anchor.querySelectorAll("svg, [aria-label], title").forEach((node) => {
        labelParts.push(node.getAttribute?.("aria-label"), node.textContent);
      });
      const label = labelParts.filter(Boolean).join(" ");
      const looksLikeCarousel = /secuencia|carousel|carrusel/i.test(label);
      if (!looksLikeCarousel) return;

      candidates.set(shortcode, {
        shortcode,
        url: new URL(anchor.getAttribute("href") || anchor.href, location.href).toString(),
        caption: anchor.querySelector("img")?.alt || "",
      });
    });

    return [...candidates.values()].slice(0, deep ? 36 : 18);
  };

  const instagramPostQueryDocIds = () => {
    const ids = new Set();
    ["require", "__r"].forEach((loaderName) => {
      try {
        const loader = window[loaderName];
        if (typeof loader !== "function") return;
        const value = loader("PolarisPostRootQuery_instagramRelayOperation");
        if (/^\d+$/.test(String(value || ""))) ids.add(String(value));
      } catch {
        // Instagram may not expose the module loader on every route.
      }
    });

    // Fallback observed in the current Instagram web bundle. If it drifts, the
    // module-loader path above usually supplies the fresh operation id.
    ids.add("26544629655158927");
    return [...ids];
  };

  const parseStructuredRootsFromHtml = (html) => {
    const roots = [];
    try {
      const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
      doc.querySelectorAll("script").forEach((script) => {
        const text = script.textContent.trim();
        if (!text.startsWith("{") && !text.startsWith("[")) return;
        try {
          roots.push(JSON.parse(text));
        } catch {
          // Ignore scripts that are not plain JSON.
        }
      });
    } catch {
      // Ignore malformed HTML.
    }
    return roots;
  };

  const fetchInstagramPostRoot = async (candidate, docIds) => {
    for (const docId of docIds) {
      try {
        const variables = encodeURIComponent(JSON.stringify({ shortcode: candidate.shortcode }));
        const response = await fetch(`/graphql/query/?doc_id=${encodeURIComponent(docId)}&variables=${variables}`, {
          credentials: "include",
          headers: {
            accept: "application/json",
            "x-ig-app-id": "936619743392459",
            "x-requested-with": "XMLHttpRequest",
          },
        });
        if (!response.ok) continue;
        const json = await response.json();
        if (json && typeof json === "object") return json;
      } catch {
        // Try the next known operation id or the HTML fallback.
      }
    }

    try {
      const response = await fetch(candidate.url, {
        credentials: "include",
        headers: { accept: "text/html,application/xhtml+xml" },
      });
      if (!response.ok) return null;
      return { __profileFetchedHtmlRoots: parseStructuredRootsFromHtml(await response.text()) };
    } catch {
      return null;
    }
  };

  const collectInstagramStructuredMedia = async () => {
    if (!/instagram\.com$/i.test(location.hostname) && !/\.instagram\.com$/i.test(location.hostname)) return [];

    const activeShortcode = instagramShortcodeFromLocation();
    const profileCandidates = instagramCarouselPostCandidates();
    const profileOrder = new Map(profileCandidates.map((candidate, index) => [candidate.shortcode, index]));
    const allowedShortcodes = new Set([
      ...profileCandidates.map((candidate) => candidate.shortcode),
      ...(activeShortcode ? [activeShortcode] : []),
    ]);
    const items = new Map();
    const seenObjects = new WeakSet();

    const addStructuredItem = (node, context = {}) => {
      const image =
        bestStructuredResource(node?.display_resources, "image") ||
        bestStructuredResource(node?.image_versions2?.candidates, "image") ||
        bestStructuredResource(node?.images, "image") ||
        bestStructuredResource(node?.display_url ? [{ url: node.display_url, ...node.dimensions }] : [], "image") ||
        bestStructuredResource(node?.display_uri ? [{ url: node.display_uri }] : [], "image") ||
        bestStructuredResource(node?.thumbnail_url ? [{ url: node.thumbnail_url }] : [], "image");
      const video =
        bestStructuredResource(node?.video_versions, "video") ||
        bestStructuredResource(node?.video_url ? [{ url: node.video_url }] : [], "video");
      const isVideo = Boolean(node?.is_video || node?.media_type === 2 || node?.video_url || node?.video_versions);
      const resource = isVideo && video ? video : image || video;
      if (!resource?.url) return;

      const key = resource.url;
      const previous = items.get(key);
      const next = {
        url: resource.url,
        previewUrl: image?.url || resource.url,
        type: isVideo ? "video" : "image",
        width: resource.width || node?.dimensions?.width || node?.original_width || 0,
        height: resource.height || node?.dimensions?.height || node?.original_height || 0,
        shortcode: context.shortcode || node?.shortcode || node?.code || "",
        carouselIndex: context.carouselIndex || 0,
        carouselTotal: context.carouselTotal || 0,
        caption: context.caption || structuredCaption(node),
      };
      const previousPixels = (previous?.width || 0) * (previous?.height || 0);
      const nextPixels = (next.width || 0) * (next.height || 0);
      if (!previous || nextPixels > previousPixels || (!previous.carouselIndex && next.carouselIndex)) items.set(key, next);
    };

    const walk = (node, context = {}) => {
      if (!node || typeof node !== "object" || seenObjects.has(node)) return;
      seenObjects.add(node);

      if (Array.isArray(node.__profileFetchedHtmlRoots)) {
        node.__profileFetchedHtmlRoots.forEach((root) => walk(root, context));
        return;
      }

      const nodeShortcode = node.shortcode || node.code || context.shortcode || "";
      const matchedShortcode = allowedShortcodes.has(nodeShortcode)
        ? nodeShortcode
        : allowedShortcodes.has(context.shortcode)
          ? context.shortcode
          : "";
      const sidecarEdges = node.edge_sidecar_to_children?.edges;
      const sidecarNodes = Array.isArray(sidecarEdges)
        ? sidecarEdges.map((edge) => edge?.node).filter(Boolean)
        : [];
      const carouselNodes = Array.isArray(node.carousel_media) ? node.carousel_media : [];
      const children = sidecarNodes.length > 0 ? sidecarNodes : carouselNodes;

      if (children.length > 0 && matchedShortcode) {
        const caption = structuredCaption(node) || context.caption || "";
        children.forEach((child, index) => {
          walk(child, {
            ...context,
            shortcode: matchedShortcode,
            carouselIndex: index + 1,
            carouselTotal: children.length,
            caption,
          });
        });
        return;
      }

      if (matchedShortcode) {
        addStructuredItem(node, {
          ...context,
          shortcode: matchedShortcode,
        });
      }

      Object.values(node).forEach((value) => {
        if (value && typeof value === "object") walk(value, matchedShortcode ? { ...context, shortcode: matchedShortcode } : context);
      });
    };

    document.querySelectorAll("script").forEach((script) => {
      const text = script.textContent.trim();
      if (!text.startsWith("{") && !text.startsWith("[")) return;
      try {
        walk(JSON.parse(text));
      } catch {
        // Ignore non-JSON scripts.
      }
    });

    if (!activeShortcode && profileCandidates.length > 0) {
      const docIds = instagramPostQueryDocIds();
      for (let index = 0; index < profileCandidates.length; index += 3) {
        const batch = profileCandidates.slice(index, index + 3);
        const roots = await Promise.all(batch.map((candidate) => fetchInstagramPostRoot(candidate, docIds)));
        roots.forEach((root, offset) => {
          if (root) {
            walk(root, {
              shortcode: batch[offset].shortcode,
              caption: batch[offset].caption,
            });
          }
        });
      }
    }

    return [...items.values()].sort((a, b) => {
      const aOrder = profileOrder.has(a.shortcode) ? profileOrder.get(a.shortcode) : 0;
      const bOrder = profileOrder.has(b.shortcode) ? profileOrder.get(b.shortcode) : 0;
      if (aOrder !== bOrder) return aOrder - bOrder;
      const shortcodeCompare = String(a.shortcode || "").localeCompare(String(b.shortcode || ""));
      if (shortcodeCompare) return shortcodeCompare;
      return (a.carouselIndex || 0) - (b.carouselIndex || 0);
    });
  };

  collectHeavy(true);

  if (deep) {
    let stagnant = 0;
    let previousHeight = 0;

    for (let step = 0; step < maxDeepSteps; step += 1) {
      window.scrollBy(0, Math.max(760, Math.floor(window.innerHeight * 0.95)));
      completedSteps = step + 1;
      await nextFrame();
      await sleep(step % 8 === 7 ? settleDelayMs : deepStepDelayMs);

      if (step % 5 === 4) {
        collectHeavy(step % 25 === 24);
      } else {
        collectLight();
      }

      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 8;
      const currentHeight = document.documentElement.scrollHeight;
      if (currentHeight === previousHeight && atBottom) {
        stagnant += 1;
      } else {
        stagnant = 0;
      }

      previousHeight = currentHeight;
      if (stagnant >= 5) break;
    }

    collectHeavy(true);
    window.scrollTo(0, originalY);
  }

  const resources = [...resourceSet];
  const elements = [...elementSet];
  const mediaElements = [...mediaElementMap.values()];
  const structuredMedia = await collectInstagramStructuredMedia();
  return {
    url: location.href,
    title: document.title,
    html: (document.documentElement?.outerHTML || "").slice(0, 35_000_000),
    text: (document.body?.innerText || "").slice(0, 2_000_000),
    resources,
    elements,
    mediaElements,
    structuredMedia,
    captureMode: deep ? "deep-scroll" : "visible",
    snapshots: deep ? completedSteps : 1,
    scrollSteps: completedSteps,
    resourceUrlCount: resources.length,
    elementUrlCount: elements.length,
    mediaElementCount: mediaElements.length,
    structuredMediaCount: structuredMedia.length,
  };
}

async function sendCapture(deep) {
  statusNode.textContent = deep ? "Capturando con scroll optimizado hasta 500 pasos..." : "Capturando visible...";
  captureButton.disabled = true;
  deepCaptureButton.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) {
      throw new Error("No hay pestana activa para capturar.");
    }

    if (!/^https?:\/\//i.test(tab.url || "")) {
      throw new Error("Abre una pagina web normal (http/https), no brave://, extensiones, PDF interno ni nueva pestana.");
    }

    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectCurrentPage,
      args: [{ deep }],
    });

    const result = injection?.result;
    if (!result?.url) {
      throw new Error("Brave no devolvio datos de esa pestana. Recarga la pagina social y vuelve a intentar.");
    }

    const appUrl = await saveAppUrl(appUrlInput?.value || (await loadAppUrl()));
    const endpointUrl = new URL("/api/capture", appUrl).toString();
    const captureBody = captureBodyForEndpoint(result, endpointUrl);
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: result.url,
        title: result.title,
        body: captureBody,
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    statusNode.textContent = `Captura enviada a ${new URL(appUrl).hostname}: ${result.mediaElementCount} media visibles, ${result.structuredMediaCount || 0} de carrusel, ${result.resourceUrlCount + result.elementUrlCount} URLs unicas, ${result.snapshots} pasos de scroll.`;
  } catch (error) {
    statusNode.textContent = `No pude capturar: ${error.message}`;
  } finally {
    captureButton.disabled = false;
    deepCaptureButton.disabled = false;
  }
}

captureButton.addEventListener("click", () => sendCapture(false));
deepCaptureButton.addEventListener("click", () => sendCapture(true));

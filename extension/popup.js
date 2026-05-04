const statusNode = document.querySelector("#status");
const captureButton = document.querySelector("#capture");
const deepCaptureButton = document.querySelector("#deep-capture");

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

    const next = {
      url: rawUrl,
      tag: node.tagName.toLowerCase(),
      width: node.naturalWidth || node.videoWidth || node.width || 0,
      height: node.naturalHeight || node.videoHeight || node.height || 0,
      clientWidth: node.clientWidth || 0,
      clientHeight: node.clientHeight || 0,
      className: String(node.className || "").slice(0, 200),
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
  return {
    url: location.href,
    title: document.title,
    html: (document.documentElement?.outerHTML || "").slice(0, 35_000_000),
    text: (document.body?.innerText || "").slice(0, 2_000_000),
    resources,
    elements,
    mediaElements,
    captureMode: deep ? "deep-scroll" : "visible",
    snapshots: deep ? completedSteps : 1,
    scrollSteps: completedSteps,
    resourceUrlCount: resources.length,
    elementUrlCount: elements.length,
    mediaElementCount: mediaElements.length,
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

    const response = await fetch("http://127.0.0.1:5177/api/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: result.url,
        title: result.title,
        body: JSON.stringify(result),
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    statusNode.textContent = `Captura enviada: ${result.mediaElementCount} media visibles, ${result.resourceUrlCount + result.elementUrlCount} URLs unicas, ${result.snapshots} pasos de scroll.`;
  } catch (error) {
    statusNode.textContent = `No pude capturar: ${error.message}`;
  } finally {
    captureButton.disabled = false;
    deepCaptureButton.disabled = false;
  }
}

captureButton.addEventListener("click", () => sendCapture(false));
deepCaptureButton.addEventListener("click", () => sendCapture(true));

function normalizePath(path) {
  if (!path) return "";
  const cleaned = path.replace(/\\/g, "/").trim().replace(/^\/+|\/+$/g, "");
  if (!cleaned) return "";

  const out = [];
  for (const segment of cleaned.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

function getDir(path) {
  const normalized = normalizePath(path);
  if (!normalized.includes("/")) return "";
  return normalized.slice(0, normalized.lastIndexOf("/"));
}

function resolvePath(baseFilePath, targetPath) {
  const cleanTarget = (targetPath || "").trim();
  if (
    !cleanTarget ||
    cleanTarget.startsWith("http://") ||
    cleanTarget.startsWith("https://") ||
    cleanTarget.startsWith("data:") ||
    cleanTarget.startsWith("blob:") ||
    cleanTarget.startsWith("mailto:") ||
    cleanTarget.startsWith("tel:") ||
    cleanTarget.startsWith("#")
  ) {
    return null;
  }

  const targetNoQuery = cleanTarget.split("?")[0].split("#")[0];
  if (targetNoQuery.startsWith("/")) {
    return normalizePath(targetNoQuery);
  }

  const baseDir = getDir(baseFilePath);
  return normalizePath(baseDir ? `${baseDir}/${targetNoQuery}` : targetNoQuery);
}

function contentTypeFor(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".js")) return "text/javascript";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".ico")) return "image/x-icon";
  if (lower.endsWith(".woff")) return "font/woff";
  if (lower.endsWith(".woff2")) return "font/woff2";
  if (lower.endsWith(".ttf")) return "font/ttf";
  if (lower.endsWith(".otf")) return "font/otf";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

// Escapes for use in url("...") and attribute values
function escapeAttr(value) {
  // Escape ", ), \, and control chars for CSS url context
  return String(value)
    .replace(/"/g, "&quot;")
    .replace(/[)\\\n\r\f]/g, (c) => {
      // CSS hex escape for control chars and )/\
      return `\\${c.charCodeAt(0).toString(16)} `;
    });
}

function addPreviewBridgeScript(doc) {
  const script = doc.createElement("script");
  script.textContent = `(function(){
    var send = function(type, payload) {
      try { parent.postMessage({ source: "recess-preview", type: type, payload: payload || {} }, "*"); } catch (e) {}
    };
    window.addEventListener("error", function(event) {
      send("runtime-error", {
        message: event.message || "Runtime error",
        source: event.filename || "",
        line: event.lineno || 0,
        column: event.colno || 0
      });
    });
    window.addEventListener("unhandledrejection", function(event) {
      var reason = event.reason;
      var message = reason && reason.message ? reason.message : String(reason);
      send("runtime-error", { message: "Unhandled rejection: " + message, source: "promise" });
    });
    var oldError = console.error;
    console.error = function() {
      var text = Array.prototype.slice.call(arguments).map(function(item){
        try { return typeof item === "string" ? item : JSON.stringify(item); } catch (e) { return String(item); }
      }).join(" ");
      send("console-error", { message: text || "console.error called" });
      return oldError.apply(console, arguments);
    };
    document.addEventListener("error", function(e) {
      var target = e.target || {};
      if (target.tagName === "LINK" || target.tagName === "SCRIPT" || target.tagName === "IMG" || target.tagName === "SOURCE" || target.tagName === "AUDIO" || target.tagName === "VIDEO") {
        send("asset-error", { url: target.href || target.src || target.poster || "" });
      }
    }, true);
    send("ready", {});
  })();`;

  if (doc.head) {
    doc.head.appendChild(script);
  } else if (doc.body) {
    doc.body.insertBefore(script, doc.body.firstChild);
  }
}

function cloneProjectFiles(project) {
  const map = new Map();
  for (const entry of project.files || []) {
    if (entry.type === "file") {
      map.set(normalizePath(entry.path), entry);
    }
  }
  return map;
}

function encodeDataUrl(fileEntry, contentOverride) {
  const blob = new Blob([contentOverride ?? fileEntry.content ?? ""], { type: contentTypeFor(fileEntry.path) });
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = (e) => reject(reader.error || e);
      reader.onabort = (e) => reject(reader.error || e);
      reader.readAsDataURL(blob);
    } catch (err) {
      reject(err);
    }
  });
}

async function rewriteCssUrls(cssText, cssPath, warnings, urlForPath) {
  const regex = /url\(([^)]+)\)/gi;
  let cursor = 0;
  let out = "";
  let match;
  while ((match = regex.exec(cssText))) {
    out += cssText.slice(cursor, match.index);
    const target = match[1].trim().replace(/^['"]|['"]$/g, "");
    const resolved = resolvePath(cssPath, target);
    if (!resolved) {
      out += match[0];
    } else {
      const nextUrl = await urlForPath(resolved);
      if (!nextUrl) {
        warnings.push(`Missing CSS asset: ${resolved}`);
        out += match[0];
      } else {
        out += `url("${escapeAttr(nextUrl)}")`;
      }
    }
    cursor = match.index + match[0].length;
  }
  out += cssText.slice(cursor);
  return out;
}

async function buildAssetUrl(path, fileMap, warnings, mode, cache) {
  const normalized = normalizePath(path);
  if (cache.has(`${mode}:${normalized}`)) return cache.get(`${mode}:${normalized}`);
  const fileEntry = fileMap.get(normalized);
  if (!fileEntry) {
    warnings.push(`Missing asset: ${normalized}`);
    return null;
  }

  let result = null;
  if (normalized.toLowerCase().endsWith(".css")) {
    const cssText = await rewriteCssUrls(
      fileEntry.content || "",
      normalized,
      warnings,
      (nextPath) => buildAssetUrl(nextPath, fileMap, warnings, mode, cache)
    );
    result = mode === "data"
      ? await encodeDataUrl(fileEntry, cssText)
      : URL.createObjectURL(new Blob([cssText], { type: contentTypeFor(fileEntry.path) }));
  } else if (mode === "data") {
    result = await encodeDataUrl(fileEntry);
  } else {
    result = URL.createObjectURL(new Blob([fileEntry.content || ""], { type: contentTypeFor(fileEntry.path) }));
  }

  cache.set(`${mode}:${normalized}`, result);
  return result;
}

async function rewriteDocumentAssets(doc, entryFilePath, fileMap, warnings, mode, cache) {
  const urlForPath = async (targetPath) => {
    const normalized = normalizePath(targetPath);
    if (cache.has(`${mode}:${normalized}`)) return cache.get(`${mode}:${normalized}`);
    return buildAssetUrl(normalized, fileMap, warnings, mode, cache);
  };

  const elements = [
    ["link[rel~='stylesheet'][href]", "href"],
    ["script[src]", "src"],
    ["img[src]", "src"],
    ["audio[src]", "src"],
    ["video[src]", "src"],
    ["source[src]", "src"],
    ["track[src]", "src"],
    ["link[rel~='icon'][href]", "href"],
    ["link[rel~='apple-touch-icon'][href]", "href"],
    ["video[poster]", "poster"]
  ];

  for (const [selector, attr] of elements) {
    const nodes = Array.from(doc.querySelectorAll(selector));
    for (const node of nodes) {
      const current = node.getAttribute(attr);
      const resolved = resolvePath(entryFilePath, current);
      if (!resolved) continue;
      const nextUrl = await urlForPath(resolved);
      if (!nextUrl) continue;
      node.setAttribute(attr, nextUrl);
    }
  }

  const styleTags = Array.from(doc.querySelectorAll("style"));
  for (const styleTag of styleTags) {
    styleTag.textContent = await rewriteCssUrls(
      styleTag.textContent || "",
      entryFilePath,
      warnings,
      (nextPath) => urlForPath(nextPath)
    );
  }

  if (doc.head) {
    const manifest = doc.querySelector('link[rel="manifest"]');
    if (manifest) manifest.remove();
  }
}

function addBaseDocumentBits(doc) {
  if (!doc.querySelector("meta[charset]")) {
    const charset = doc.createElement("meta");
    charset.setAttribute("charset", "utf-8");
    doc.head?.prepend(charset);
  }
  if (!doc.querySelector("meta[name='viewport']")) {
    const viewport = doc.createElement("meta");
    viewport.name = "viewport";
    viewport.content = "width=device-width, initial-scale=1.0";
    doc.head?.appendChild(viewport);
  }
}

async function buildDocument(project, mode, includeBridge) {
  const fileMap = cloneProjectFiles(project);
  const entryPath = normalizePath(project.entryFile || "index.html");
  const entry = fileMap.get(entryPath);
  if (!entry) throw new Error(`Entry file not found: ${entryPath}`);

  const parser = new DOMParser();
  const doc = parser.parseFromString(entry.content || "", "text/html");
  const warnings = [];
  const cache = new Map();

  await rewriteDocumentAssets(doc, entryPath, fileMap, warnings, mode, cache);
  addBaseDocumentBits(doc);
  if (includeBridge) addPreviewBridgeScript(doc);

  return {
    html: `<!doctype html>\n${doc.documentElement.outerHTML}`,
    warnings,
    urls: Array.from(cache.values()).filter((value) => typeof value === "string" && value.startsWith("blob:"))
  };
}

export function createPreviewRuntime(frameElement) {
  let activeBlobUrls = [];

  function resetBlobUrls() {
    activeBlobUrls.forEach((url) => URL.revokeObjectURL(url));
    activeBlobUrls = [];
  }

  async function render(project) {
    resetBlobUrls();
    let result;
    try {
      result = await buildDocument(project, "blob", true);
    } catch (err) {
      resetBlobUrls();
      throw err;
    }
    activeBlobUrls = result.urls;
    frameElement.srcdoc = result.html;
    return { warnings: result.warnings };
  }

  async function buildStandaloneHtml(project) {
    const result = await buildDocument(project, "data", false);
    return { html: result.html, warnings: result.warnings };
  }

  function dispose() {
    resetBlobUrls();
  }

  return { render, buildStandaloneHtml, dispose };
}

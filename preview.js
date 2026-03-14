function normalizePath(path) {
  if (!path) {
    return "";
  }

  const cleaned = path.replace(/\\/g, "/").trim().replace(/^\/+|\/+$/g, "");
  if (!cleaned) {
    return "";
  }

  const out = [];
  for (const segment of cleaned.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
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
  if (!normalized.includes("/")) {
    return "";
  }
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
  if (lower.endsWith(".txt")) return "text/plain";
  return "text/plain";
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
    // Asset load error capture
    document.addEventListener("error", function(e) {
      var target = e.target || {};
      if (target.tagName === "LINK" || target.tagName === "SCRIPT") {
        send("asset-error", { url: target.href || target.src || "" });
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

export function createPreviewRuntime(frameElement) {
  let activeBlobUrls = [];

  function resetBlobUrls() {
    activeBlobUrls.forEach((url) => URL.revokeObjectURL(url));
    activeBlobUrls = [];
  }

  function buildFileMap(project) {
    const map = new Map();
    for (const entry of project.files || []) {
      if (entry.type === "file") {
        map.set(normalizePath(entry.path), entry);
      }
    }
    return map;
  }

  function fileToBlobUrl(fileEntry) {
    const blob = new Blob([fileEntry.content || ""], { type: contentTypeFor(fileEntry.path) });
    const url = URL.createObjectURL(blob);
    activeBlobUrls.push(url);
    return url;
  }

  function rewriteLinkedAssets(doc, entryFilePath, fileMap, warnings) {
    const linkEls = Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'));
    linkEls.forEach((linkEl) => {
      const href = linkEl.getAttribute("href");
      const resolved = resolvePath(entryFilePath, href);
      if (!resolved) {
        return;
      }

      const file = fileMap.get(resolved);
      if (!file) {
        warnings.push(`Missing stylesheet file: ${resolved}`);
        return;
      }

      linkEl.setAttribute("href", fileToBlobUrl(file));
    });

    const scriptEls = Array.from(doc.querySelectorAll("script[src]"));
    scriptEls.forEach((scriptEl) => {
      const src = scriptEl.getAttribute("src");
      const resolved = resolvePath(entryFilePath, src);
      if (!resolved) {
        return;
      }

      const file = fileMap.get(resolved);
      if (!file) {
        warnings.push(`Missing script file: ${resolved}`);
        return;
      }

      scriptEl.setAttribute("src", fileToBlobUrl(file));
    });
  }

  function render(project) {
    resetBlobUrls();

    const fileMap = buildFileMap(project);
    const entryPath = normalizePath(project.entryFile || "index.html");
    const entry = fileMap.get(entryPath);

    if (!entry) {
      // Set fallback message in parent if possible
      if (window.parent && window.parent !== window) {
        try {
          window.parent.postMessage({ source: "recess-preview", type: "runtime-error", payload: { message: `Entry file not found: ${entryPath}` } }, "*");
        } catch (e) {}
      }
      throw new Error(`Entry file not found: ${entryPath}`);
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(entry.content || "", "text/html");
    const warnings = [];

    rewriteLinkedAssets(doc, entryPath, fileMap, warnings);
    addPreviewBridgeScript(doc);

    const html = `<!doctype html>\n${doc.documentElement.outerHTML}`;
    frameElement.srcdoc = html;

    return { warnings };
  }

  function dispose() {
    resetBlobUrls();
  }

  return { render, dispose };
}
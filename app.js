import { getAllProjects, getProject, putProject, deleteProject, getMetaValue, setMetaValue } from "./db.js";
import { createPreviewRuntime } from "./preview.js";

const LAST_PROJECT_META_KEY = "lastOpenProjectId";
const MAX_SNAPSHOTS = 12;
const STARTER_TEMPLATE = {
  name: "My Project",
  entryFile: "index.html",
  files: [
    { path: "index.html", type: "file", content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Recess Project</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <h1>Hello from Recess</h1>
  <img src="cover.svg" alt="Demo" width="160" />
  <button id="demoBtn">Tap me</button>
  <div id="output"></div>
  <script src="main.js"></script>
</body>
</html>` },
    { path: "styles.css", type: "file", content: `body {
  font-family: Arial, sans-serif;
  padding: 20px;
}
button {
  padding: 10px 14px;
  font-size: 16px;
}` },
    { path: "main.js", type: "file", content: `document.getElementById("demoBtn").addEventListener("click", () => {
  document.getElementById("output").textContent = "It works.";
});` },
    { path: "cover.svg", type: "file", content: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#0f172a"/><circle cx="86" cy="90" r="46" fill="#22c55e"/><rect x="132" y="58" width="120" height="64" rx="12" fill="#1e293b"/><text x="150" y="96" fill="#f8fafc" font-family="Arial, sans-serif" font-size="22">Recess</text></svg>` }
  ]
};

const $ = (id) => document.getElementById(id);
const els = {
  saveStatus: $("saveStatusText"), lastSaved: $("lastSavedText"), status: $("statusText"),
  projectName: $("projectNameInput"), entry: $("entryFileSelect"), editor: $("editorInput"),
  frame: $("previewFrame"), path: $("selectedPathText"), kind: $("selectedTypeText"),
  editorPane: $("editorPane"), previewPane: $("previewPane"), modeBtns: [...document.querySelectorAll(".mode-btn")],
  issuesWrap: $("previewIssuesWrap"), issuesList: $("previewIssuesList"),
  previewFallback: $("previewFallback"), previewFallbackMsg: $("previewFallbackMsg"),
  reloadPreviewBtn: $("reloadPreviewBtn"), clearDebugBtn: $("clearDebugBtn"),
  projectsBtn: $("projectsBtn"), treeBtn: $("treeBtn"), searchBtn: $("searchBtn"),
  runBtn: $("runBtn"), shareBtn: $("shareBtn"), saveBtn: $("saveBtn"), fileHandle: $("fileHandleBtn"),
  fileDrawer: $("fileDrawer"), fileBackdrop: $("fileDrawerBackdrop"), closeTree: $("closeTreeBtn"),
  tree: $("fileTree"), fileSearch: $("fileSearchInput"), newFile: $("newFileBtn"), newFolder: $("newFolderBtn"),
  duplicateNode: $("duplicateNodeBtn"), renameNode: $("renameNodeBtn"), deleteNode: $("deleteNodeBtn"),
  projectsDrawer: $("projectsDrawer"), projectsBackdrop: $("projectsDrawerBackdrop"), closeProjects: $("closeProjectsBtn"),
  projectsList: $("projectsList"), snapshotsList: $("snapshotsList"), newProject: $("newProjectBtn"),
  duplicateProject: $("duplicateProjectBtn"), loadProject: $("loadProjectBtn"), deleteProject: $("deleteProjectBtn"),
  exportProject: $("exportProjectBtn"), exportBundle: $("exportBundleBtn"), importProject: $("importProjectBtn"),
  snapshotProject: $("snapshotProjectBtn"), importInput: $("importProjectInput"),
  searchDrawer: $("searchDrawer"), searchBackdrop: $("searchDrawerBackdrop"), closeSearch: $("closeSearchBtn"),
  globalSearchInput: $("globalSearchInput"), searchResultsList: $("searchResultsList"),
  findInput: $("findInput"), replaceInput: $("replaceInput"), findNextBtn: $("findNextBtn"),
  replaceBtn: $("replaceBtn"), replaceAllBtn: $("replaceAllBtn"),
  modal: $("modalOverlay"), modalBackdrop: $("modalBackdrop"), modalTitle: $("modalTitle"), modalMsg: $("modalMessage"),
  modalWrap: $("modalInputWrap"), modalInput: $("modalInput"), modalCancel: $("modalCancelBtn"), modalConfirm: $("modalConfirmBtn")
};

const state = {
  projects: [], active: null, selectedPath: null, selectedProjectId: null, collapsed: new Set(),
  mode: "editor", issues: [], debugLogs: [], fileFilter: "", searchQuery: "", searchResults: []
};

const preview = createPreviewRuntime(els.frame);
let autosaveTimer = null;
let savePending = false;
let modalResolve = null;

function id(prefix) { return `${prefix}_${crypto?.randomUUID?.() || `${Date.now()}_${Math.floor(Math.random() * 1e6)}`}`; }
function status(msg) { els.status.textContent = msg; }
function normalizePath(p) {
  const raw = (p || "").replace(/\\/g, "/").trim().replace(/^\/+|\/+$/g, "");
  if (!raw) return "";
  const out = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}
function parentPath(p) { const n = normalizePath(p); return n.includes("/") ? n.slice(0, n.lastIndexOf("/")) : ""; }
function baseName(p) { const n = normalizePath(p); return n.includes("/") ? n.slice(n.lastIndexOf("/") + 1) : n; }
function joinPath(parent, name) { const a = normalizePath(parent), b = normalizePath(name); return a ? (b ? `${a}/${b}` : a) : b; }
function isEditable(path) { return /\.(html|css|js|json|txt|svg|md)$/i.test(path); }
function nodeSort(a, b) { return a.type === b.type ? a.path.localeCompare(b.path) : (a.type === "folder" ? -1 : 1); }
function summary(project) { return { id: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, entryFile: project.entryFile }; }
function nodeAt(path) { return state.active?.files.find((file) => file.path === path) || null; }
function htmlPaths(project) { return project.files.filter((file) => file.type === "file" && /\.html?$/i.test(file.path)).map((file) => file.path).sort(); }
function ensureEntry(project) {
  const files = htmlPaths(project);
  if (!files.length) project.entryFile = "index.html";
  else if (!project.entryFile || !files.includes(project.entryFile)) project.entryFile = files.includes("index.html") ? "index.html" : files[0];
}
function setSaveStatus(nextState, errorMsg) {
  els.saveStatus.classList.remove("saving", "error");
  if (nextState === "saving") { els.saveStatus.textContent = "Saving..."; els.saveStatus.classList.add("saving"); }
  else if (nextState === "error") { els.saveStatus.textContent = errorMsg || "Save failed"; els.saveStatus.classList.add("error"); }
  else els.saveStatus.textContent = "All changes saved";
}
function setLastSaved(ts) { els.lastSaved.textContent = ts ? `Last saved: ${new Date(ts).toLocaleTimeString()}` : ""; }
function normalizeProject(project) {
  const snapshots = Array.isArray(project.snapshots) ? project.snapshots.map((snap) => ({
    id: typeof snap.id === "string" ? snap.id : id("snap"),
    name: typeof snap.name === "string" && snap.name.trim() ? snap.name.trim() : "Snapshot",
    createdAt: typeof snap.createdAt === "number" ? snap.createdAt : Date.now(),
    entryFile: normalizePath(snap.entryFile || "index.html"),
    selectedPath: normalizePath(snap.selectedPath || ""),
    files: Array.isArray(snap.files) ? snap.files.map((file) => ({ ...file, path: normalizePath(file.path), name: file.name || baseName(file.path) })) : []
  })) : [];
  const normalized = {
    ...project,
    files: Array.isArray(project.files) ? project.files.map((file) => ({ ...file, path: normalizePath(file.path), name: file.name || baseName(file.path) })) : [],
    snapshots
  };
  ensureEntry(normalized);
  return normalized;
}
function starter(name) {
  const now = Date.now();
  return normalizeProject({
    id: id("proj"), name: (name || STARTER_TEMPLATE.name).trim() || "My Project", entryFile: STARTER_TEMPLATE.entryFile,
    files: STARTER_TEMPLATE.files.map((file) => ({ id: id(file.type === "folder" ? "folder" : "file"), name: baseName(file.path), path: normalizePath(file.path), type: file.type, content: file.type === "file" ? file.content : undefined })),
    snapshots: [], createdAt: now, updatedAt: now
  });
}
function cloneSnapshot(project) {
  return {
    id: id("snap"), createdAt: Date.now(), name: `${project.name} ${new Date().toLocaleString()}`,
    entryFile: project.entryFile, selectedPath: state.selectedPath, files: project.files.map((file) => ({ ...file }))
  };
}
function setIssues(items) { state.issues = (items || []).slice(0, 50); renderIssues(); }
function pushDebugLog(msg, type = "info") { state.debugLogs.unshift({ msg, type, ts: Date.now() }); state.debugLogs = state.debugLogs.slice(0, 100); renderIssues(); }
function clearDebugLogs() { state.debugLogs = []; renderIssues(); }
function renderIssues() {
  els.issuesList.innerHTML = "";
  if (!state.issues.length && !state.debugLogs.length) { els.issuesWrap.hidden = true; return; }
  els.issuesWrap.hidden = false;
  state.debugLogs.forEach((log) => {
    const li = document.createElement("li");
    li.textContent = `[${new Date(log.ts).toLocaleTimeString()}] ${log.type === "error" ? "[Error] " : ""}${log.msg}`;
    li.style.color = log.type === "error" ? "#fecaca" : "#b6e3b6";
    els.issuesList.appendChild(li);
  });
  state.issues.forEach((msg) => {
    const li = document.createElement("li");
    li.textContent = msg;
    li.style.color = "#fde2e2";
    els.issuesList.appendChild(li);
  });
}
function renderMode() {
  const previewMode = state.mode === "preview";
  els.modeBtns.forEach((button) => button.classList.toggle("is-active", button.dataset.mode === state.mode));
  els.editorPane.classList.toggle("is-active", !previewMode);
  els.previewPane.classList.toggle("is-active", previewMode);
}
function renderProjectBar() {
  if (!state.active) { els.projectName.value = ""; els.entry.innerHTML = ""; return; }
  els.projectName.value = state.active.name;
  ensureEntry(state.active);
  const html = htmlPaths(state.active);
  els.entry.innerHTML = "";
  if (!html.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No HTML files";
    els.entry.appendChild(option);
    els.entry.disabled = true;
    return;
  }
  els.entry.disabled = false;
  html.forEach((path) => {
    const option = document.createElement("option");
    option.value = path;
    option.textContent = path;
    option.selected = path === state.active.entryFile;
    els.entry.appendChild(option);
  });
}
function renderEditor() {
  const node = nodeAt(state.selectedPath);
  if (!node) {
    els.path.textContent = "No file selected"; els.kind.textContent = "";
    els.editor.value = ""; els.editor.disabled = true; els.editor.placeholder = "Select a file from the file tree.";
    return;
  }
  els.path.textContent = node.path;
  els.kind.textContent = node.type === "folder" ? "Folder" : "File";
  if (node.type !== "file") {
    els.editor.value = ""; els.editor.disabled = true; els.editor.placeholder = "Folders cannot be edited.";
    return;
  }
  els.editor.disabled = !isEditable(node.path);
  els.editor.value = node.content || "";
  els.editor.placeholder = els.editor.disabled ? "This file type is not editable yet." : "";
}
function treeMap(project) {
  const map = new Map();
  project.files.forEach((file) => map.set(file.path, []));
  project.files.forEach((file) => {
    const parent = parentPath(file.path);
    if (!map.has(parent)) map.set(parent, []);
    map.get(parent).push(file);
  });
  map.forEach((children) => children.sort(nodeSort));
  return map;
}
function fileMatchesFilter(file) { const q = state.fileFilter.trim().toLowerCase(); return !q || file.path.toLowerCase().includes(q); }
function folderHasVisibleChild(path) { const prefix = `${path}/`; return state.active.files.some((file) => file.path.startsWith(prefix) && fileMatchesFilter(file)); }
function renderTree() {
  els.tree.innerHTML = "";
  if (!state.active) return;
  const map = treeMap(state.active);
  const append = (parent, depth) => {
    (map.get(parent) || []).forEach((node) => {
      if (!fileMatchesFilter(node) && (node.type !== "folder" || !folderHasVisibleChild(node.path))) return;
      const li = document.createElement("li");
      const row = document.createElement("div");
      const collapse = document.createElement("button");
      const nodeBtn = document.createElement("button");
      const folder = node.type === "folder";
      const collapsed = state.collapsed.has(node.path);
      row.className = "tree-row";
      collapse.type = "button";
      collapse.className = "tree-collapse-btn";
      collapse.disabled = !folder;
      collapse.textContent = folder ? (collapsed ? "+" : "-") : "";
      collapse.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!folder) return;
        collapsed ? state.collapsed.delete(node.path) : state.collapsed.add(node.path);
        renderTree();
      });
      nodeBtn.type = "button";
      nodeBtn.className = "tree-node-btn";
      nodeBtn.classList.toggle("is-selected", node.path === state.selectedPath);
      nodeBtn.style.paddingLeft = `${10 + depth * 14}px`;
      nodeBtn.textContent = `${folder ? "[D]" : "[F]"} ${node.name}`;
      nodeBtn.addEventListener("click", () => {
        state.selectedPath = node.path;
        renderTree();
        renderEditor();
        if (window.innerWidth < 700 && node.type === "file") {
          closeDrawer(els.fileDrawer);
          setFileDrawerState(false);
          setTimeout(() => els.editor.focus(), 160);
        }
      });
      row.append(collapse, nodeBtn);
      li.appendChild(row);
      els.tree.appendChild(li);
      if (folder && !collapsed) append(node.path, depth + 1);
    });
  };
  append("", 0);
}
function renderProjects() {
  els.projectsList.innerHTML = "";
  [...state.projects].sort((a, b) => b.updatedAt - a.updatedAt).forEach((project) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "project-item";
    button.classList.toggle("is-selected", project.id === state.selectedProjectId);
    button.classList.toggle("is-active", !!state.active && project.id === state.active.id);
    button.textContent = `${project.name} (${new Date(project.updatedAt).toLocaleString()})${state.active && project.id === state.active.id ? " | Active" : ""}`;
    button.addEventListener("click", () => { state.selectedProjectId = project.id; renderProjects(); });
    li.appendChild(button);
    els.projectsList.appendChild(li);
  });
}
function renderSnapshots() {
  els.snapshotsList.innerHTML = "";
  const snapshots = state.active?.snapshots || [];
  if (!snapshots.length) {
    const li = document.createElement("li");
    li.className = "snapshot-item";
    li.textContent = "No snapshots yet.";
    els.snapshotsList.appendChild(li);
    return;
  }
  [...snapshots].sort((a, b) => b.createdAt - a.createdAt).forEach((snapshot) => {
    const li = document.createElement("li");
    const meta = document.createElement("div");
    const name = document.createElement("span");
    const time = document.createElement("span");
    const button = document.createElement("button");
    li.className = "snapshot-item";
    meta.className = "snapshot-meta";
    name.className = "snapshot-name";
    time.className = "snapshot-time";
    button.className = "btn";
    button.type = "button";
    button.textContent = "Restore";
    name.textContent = snapshot.name;
    time.textContent = new Date(snapshot.createdAt).toLocaleString();
    button.addEventListener("click", () => restoreSnapshotAction(snapshot.id).catch(() => status("Could not restore snapshot.")));
    meta.append(name, time);
    li.append(meta, button);
    els.snapshotsList.appendChild(li);
  });
}
function renderSearchResults() {
  els.searchResultsList.innerHTML = "";
  if (!state.searchResults.length) {
    const li = document.createElement("li");
    li.className = "project-item";
    li.textContent = state.searchQuery.trim() ? "No matches." : "Type to search files or content.";
    els.searchResultsList.appendChild(li);
    return;
  }
  state.searchResults.forEach((result) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "project-item";
    button.textContent = result.label;
    button.addEventListener("click", () => {
      state.selectedPath = result.path;
      closeDrawer(els.searchDrawer);
      renderTree();
      renderEditor();
      if (state.mode !== "editor") { state.mode = "editor"; renderMode(); }
      if (typeof result.selectionStart === "number") {
        setTimeout(() => {
          els.editor.focus();
          els.editor.setSelectionRange(result.selectionStart, result.selectionEnd);
        }, 80);
      }
      status(`Opened ${result.path}`);
    });
    li.appendChild(button);
    els.searchResultsList.appendChild(li);
  });
}
function openDrawer(el) { el.hidden = false; }
function closeDrawer(el) { el.hidden = true; }
function setFileDrawerState(isOpen) { document.body.classList.toggle("file-drawer-open", isOpen); }
function closeModal(result) {
  els.modal.hidden = true;
  if (modalResolve) {
    const resolve = modalResolve;
    modalResolve = null;
    resolve(result);
  }
}
function openModal({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", dangerous = false, input = false, value = "", placeholder = "" }) {
  els.modalTitle.textContent = title;
  els.modalMsg.textContent = message;
  els.modalConfirm.textContent = confirmLabel;
  els.modalCancel.textContent = cancelLabel;
  els.modalConfirm.classList.toggle("btn-danger", dangerous);
  els.modalConfirm.classList.toggle("btn-primary", !dangerous);
  els.modalWrap.hidden = !input;
  els.modalInput.value = value;
  els.modalInput.placeholder = placeholder;
  els.modal.hidden = false;
  setTimeout(() => (input ? els.modalInput : els.modalConfirm).focus(), 0);
  return new Promise((resolve) => { modalResolve = resolve; });
}
async function askText(opts) { const result = await openModal({ ...opts, input: true }); return !result || !result.ok ? null : (result.value || "").trim(); }
async function askConfirm(opts) { const result = await openModal(opts); return !!(result && result.ok); }
function refreshAll() { renderProjectBar(); renderProjects(); renderSnapshots(); renderTree(); renderEditor(); renderSearchResults(); }
function touch() { if (state.active) state.active.updatedAt = Date.now(); }
function ensureSelectedExists() {
  if (!state.active) { state.selectedPath = null; return; }
  if (state.selectedPath && nodeAt(state.selectedPath)) return;
  const firstFile = state.active.files.find((file) => file.type === "file");
  state.selectedPath = firstFile ? firstFile.path : null;
}
function pathExists(path, except = null) { return state.active.files.some((file) => file.path === path && file.path !== except); }
function selectedFolder() {
  if (!state.selectedPath) return "";
  const node = nodeAt(state.selectedPath);
  if (!node) return "";
  return node.type === "folder" ? node.path : parentPath(node.path);
}
function renameCollapsed(oldPath, nextPath) {
  const oldPrefix = `${oldPath}/`;
  const next = new Set();
  state.collapsed.forEach((path) => {
    if (path === oldPath) next.add(nextPath);
    else if (path.startsWith(oldPrefix)) next.add(`${nextPath}/${path.slice(oldPrefix.length)}`);
    else next.add(path);
  });
  state.collapsed = next;
}
function pruneCollapsed(path) {
  const prefix = `${path}/`;
  const next = new Set();
  state.collapsed.forEach((value) => { if (value !== path && !value.startsWith(prefix)) next.add(value); });
  state.collapsed = next;
}
function scheduleSave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  setSaveStatus("saving");
  savePending = true;
  autosaveTimer = setTimeout(() => { saveActive(true).catch(() => setSaveStatus("error", "Auto-save failed.")); }, 600);
}
async function saveActive(quiet = false) {
  if (!state.active) return;
  setSaveStatus("saving");
  savePending = true;
  try {
    touch();
    await putProject(state.active);
    await setMetaValue(LAST_PROJECT_META_KEY, state.active.id);
    const index = state.projects.findIndex((project) => project.id === state.active.id);
    const nextSummary = summary(state.active);
    if (index >= 0) state.projects[index] = nextSummary;
    else state.projects.push(nextSummary);
    renderProjects();
    setLastSaved(Date.now());
    setSaveStatus("saved");
    savePending = false;
    if (!quiet) status(`Saved ${state.active.name}`);
  } catch (error) {
    setSaveStatus("error", error && error.message);
    savePending = false;
    if (!quiet) status("Save failed.");
  }
}
async function loadById(projectId) {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found.");
  state.active = normalizeProject(project);
  state.selectedProjectId = state.active.id;
  ensureSelectedExists();
  updateSearchResults();
  refreshAll();
  await setMetaValue(LAST_PROJECT_META_KEY, state.active.id);
  setLastSaved(state.active.updatedAt || Date.now());
  setSaveStatus("saved");
  status(`Loaded ${state.active.name}`);
}
function nextCopyName(name) {
  const extIndex = name.lastIndexOf(".");
  return extIndex <= 0 ? `${name}-copy` : `${name.slice(0, extIndex)}-copy${name.slice(extIndex)}`;
}
function uniquePath(path) {
  let nextPath = normalizePath(path);
  while (pathExists(nextPath)) nextPath = joinPath(parentPath(nextPath), nextCopyName(baseName(nextPath)));
  return nextPath;
}
async function createProjectAction() {
  const name = await askText({ title: "New Project", message: "Create a new starter project", confirmLabel: "Create", value: "My Project" });
  if (name === null) return;
  const project = starter(name || "My Project");
  await putProject(project);
  state.projects.push(summary(project));
  state.selectedProjectId = project.id;
  await loadById(project.id);
}
async function duplicateProjectAction() {
  if (!state.active) return void status("Load a project first.");
  const clone = normalizeProject({
    ...state.active, id: id("proj"), name: `${state.active.name} Copy`,
    files: state.active.files.map((file) => ({ ...file, id: id(file.type === "folder" ? "folder" : "file") })),
    snapshots: (state.active.snapshots || []).map((snapshot) => ({ ...snapshot, id: id("snap"), files: snapshot.files.map((file) => ({ ...file, id: id(file.type === "folder" ? "folder" : "file") })) })),
    createdAt: Date.now(), updatedAt: Date.now()
  });
  await putProject(clone);
  state.projects.push(summary(clone));
  state.selectedProjectId = clone.id;
  await loadById(clone.id);
}
async function addFileAction() {
  if (!state.active) return;
  let name;
  while (true) {
    name = await askText({ title: "New File", message: "Enter a file name", confirmLabel: "Create", value: "new-file.txt" });
    if (name === null) return;
    if (!name.trim() || name.includes("/")) { status("Invalid file name."); continue; }
    const path = joinPath(selectedFolder(), name);
    if (pathExists(path)) { status("A file or folder already exists at that path."); continue; }
    break;
  }
  const path = joinPath(selectedFolder(), name);
  state.active.files.push({ id: id("file"), name, path, type: "file", content: "" });
  state.selectedPath = path;
  ensureEntry(state.active);
  updateSearchResults();
  refreshAll();
  scheduleSave();
  status(`Created file ${path}`);
}
async function addFolderAction() {
  if (!state.active) return;
  let name;
  while (true) {
    name = await askText({ title: "New Folder", message: "Enter a folder name", confirmLabel: "Create", value: "new-folder" });
    if (name === null) return;
    if (!name.trim() || name.includes("/")) { status("Invalid folder name."); continue; }
    const path = joinPath(selectedFolder(), name);
    if (pathExists(path)) { status("A file or folder already exists at that path."); continue; }
    break;
  }
  const path = joinPath(selectedFolder(), name);
  state.active.files.push({ id: id("folder"), name, path, type: "folder" });
  state.selectedPath = path;
  state.collapsed.delete(path);
  updateSearchResults();
  refreshAll();
  scheduleSave();
  status(`Created folder ${path}`);
}
async function duplicateNodeAction() {
  if (!state.active || !state.selectedPath) return void status("Select a file or folder first.");
  const selected = nodeAt(state.selectedPath);
  if (!selected) return void status("Selection not found.");
  if (selected.type === "file") {
    const nextPath = uniquePath(joinPath(parentPath(selected.path), nextCopyName(selected.name)));
    state.active.files.push({ ...selected, id: id("file"), name: baseName(nextPath), path: nextPath });
    state.selectedPath = nextPath;
  } else {
    const nextRoot = uniquePath(joinPath(parentPath(selected.path), `${selected.name}-copy`));
    const oldPrefix = `${selected.path}/`;
    const nextPrefix = `${nextRoot}/`;
    const copies = state.active.files.filter((file) => file.path === selected.path || file.path.startsWith(oldPrefix)).map((file) => {
      const nextPath = file.path === selected.path ? nextRoot : `${nextPrefix}${file.path.slice(oldPrefix.length)}`;
      return { ...file, id: id(file.type === "folder" ? "folder" : "file"), path: nextPath, name: baseName(nextPath) };
    });
    state.active.files.push(...copies);
    state.selectedPath = nextRoot;
  }
  updateSearchResults();
  refreshAll();
  scheduleSave();
  status(`Duplicated ${selected.path}`);
}
async function renameNodeAction() {
  if (!state.active || !state.selectedPath) return void status("Select a file or folder first.");
  const selected = nodeAt(state.selectedPath);
  if (!selected) return void status("Selection not found.");
  let nextName;
  while (true) {
    nextName = await askText({ title: "Rename", message: `Rename ${selected.path}`, confirmLabel: "Rename", value: selected.name });
    if (nextName === null) return;
    if (!nextName.trim() || nextName.includes("/")) { status("Invalid name."); continue; }
    const nextPath = joinPath(parentPath(selected.path), nextName);
    if (nextPath !== selected.path && pathExists(nextPath, selected.path)) { status("Another node already exists with that path."); continue; }
    break;
  }
  const nextPath = joinPath(parentPath(selected.path), nextName);
  if (selected.type === "file") {
    const oldPath = selected.path;
    selected.name = nextName;
    selected.path = nextPath;
    if (state.active.entryFile === oldPath) state.active.entryFile = nextPath;
  } else {
    const oldPath = selected.path, oldPrefix = `${oldPath}/`, nextPrefix = `${nextPath}/`;
    state.active.files.forEach((file) => {
      if (file.path === oldPath) { file.name = nextName; file.path = nextPath; }
      else if (file.path.startsWith(oldPrefix)) { file.path = `${nextPrefix}${file.path.slice(oldPrefix.length)}`; file.name = baseName(file.path); }
    });
    if (state.active.entryFile === oldPath) state.active.entryFile = nextPath;
    else if (state.active.entryFile.startsWith(oldPrefix)) state.active.entryFile = `${nextPrefix}${state.active.entryFile.slice(oldPrefix.length)}`;
    renameCollapsed(oldPath, nextPath);
  }
  state.selectedPath = nextPath;
  ensureEntry(state.active);
  updateSearchResults();
  refreshAll();
  scheduleSave();
  status(`Renamed to ${nextPath}`);
}
async function deleteNodeAction() {
  if (!state.active || !state.selectedPath) return void status("Select a file or folder first.");
  const selected = nodeAt(state.selectedPath);
  if (!selected) return void status("Selection not found.");
  const ok = await askConfirm({ title: "Delete", message: `Are you sure you want to delete ${selected.path}? This cannot be undone.\n\nAll files and folders inside will be permanently removed.`, confirmLabel: "Delete", dangerous: true });
  if (!ok) return;
  if (selected.type === "folder") {
    const prefix = `${selected.path}/`;
    state.active.files = state.active.files.filter((file) => file.path !== selected.path && !file.path.startsWith(prefix));
    if (state.active.entryFile === selected.path || state.active.entryFile.startsWith(prefix)) state.active.entryFile = "index.html";
    pruneCollapsed(selected.path);
  } else {
    state.active.files = state.active.files.filter((file) => file.path !== selected.path);
    if (state.active.entryFile === selected.path) state.active.entryFile = "index.html";
  }
  ensureEntry(state.active);
  ensureSelectedExists();
  updateSearchResults();
  refreshAll();
  scheduleSave();
  status(`Deleted ${selected.path}`);
}
async function deleteProjectAction() {
  if (!state.selectedProjectId) return void status("Select a project first.");
  if (state.projects.length <= 1) return void status("Keep at least one project.");
  const project = state.projects.find((item) => item.id === state.selectedProjectId);
  if (!project) return void status("Project not found.");
  const ok = await askConfirm({ title: "Delete Project", message: `Are you sure you want to delete project '${project.name}'? This cannot be undone.`, confirmLabel: "Delete", dangerous: true });
  if (!ok) return;
  await deleteProject(project.id);
  state.projects = state.projects.filter((item) => item.id !== project.id);
  state.selectedProjectId = state.projects[0].id;
  await loadById(state.selectedProjectId);
}
async function loadSelectedProjectAction() {
  if (!state.selectedProjectId) return void status("Select a project first.");
  await loadById(state.selectedProjectId);
  closeDrawer(els.projectsDrawer);
}
function sanitizeFileName(name) { return name.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "") || "project"; }
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
async function exportProjectAction() {
  const projectId = state.selectedProjectId || state.active?.id;
  if (!projectId) return void status("Select a project first.");
  const project = await getProject(projectId);
  if (!project) return void status("Project not found.");
  downloadBlob(new Blob([JSON.stringify(project, null, 2)], { type: "application/json" }), `${sanitizeFileName(project.name)}.recess.json`);
  status(`Exported ${project.name}`);
}
async function exportBundleAction() {
  if (!state.active) return void status("Load a project first.");
  const { html, warnings } = await preview.buildStandaloneHtml(state.active);
  downloadBlob(new Blob([html], { type: "text/html" }), `${sanitizeFileName(state.active.name)}.bundle.html`);
  if (warnings.length) setIssues(warnings);
  status(`Exported bundle for ${state.active.name}`);
}
function normalizeImported(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid project JSON format.");
  const seen = new Set();
  const files = (Array.isArray(raw.files) ? raw.files : []).map((file) => {
    if (!file || (file.type !== "file" && file.type !== "folder")) return null;
    const path = normalizePath(file.path || "");
    if (!path || seen.has(path)) return null;
    seen.add(path);
    return { id: typeof file.id === "string" ? file.id : id(file.type === "folder" ? "folder" : "file"), name: typeof file.name === "string" && file.name.trim() ? file.name.trim() : baseName(path), path, type: file.type, content: file.type === "file" ? String(file.content || "") : undefined };
  }).filter(Boolean);
  if (!files.length) throw new Error("Imported project has no valid files.");
  return normalizeProject({
    id: id("proj"), name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Imported Project",
    entryFile: typeof raw.entryFile === "string" ? normalizePath(raw.entryFile) : "index.html", files,
    snapshots: Array.isArray(raw.snapshots) ? raw.snapshots : [], createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(), updatedAt: Date.now()
  });
}
async function importProjectAction(file) {
  const parsed = JSON.parse(await file.text());
  const project = normalizeImported(parsed);
  await putProject(project);
  state.projects.push(summary(project));
  state.selectedProjectId = project.id;
  await loadById(project.id);
  status(`Imported ${project.name}`);
}
function updateProjectName() {
  if (!state.active) return;
  const next = els.projectName.value.trim();
  if (!next) { els.projectName.value = state.active.name; return; }
  if (next !== state.active.name) { state.active.name = next; scheduleSave(); renderProjects(); }
}
function updateEntry() { if (state.active) { state.active.entryFile = normalizePath(els.entry.value); scheduleSave(); } }
function updateSearchResults() {
  const query = state.searchQuery.trim().toLowerCase();
  if (!state.active || !query) { state.searchResults = []; renderSearchResults(); return; }
  const results = [];
  state.active.files.forEach((file) => {
    if (file.path.toLowerCase().includes(query)) results.push({ path: file.path, label: `${file.path} [path]` });
    if (file.type === "file" && typeof file.content === "string") {
      const index = file.content.toLowerCase().indexOf(query);
      if (index >= 0) {
        const excerpt = file.content.slice(Math.max(0, index - 18), Math.min(file.content.length, index + query.length + 32)).replace(/\s+/g, " ");
        results.push({ path: file.path, label: `${file.path} ${excerpt}`, selectionStart: index, selectionEnd: index + query.length });
      }
    }
  });
  state.searchResults = results.slice(0, 40);
  renderSearchResults();
}
function syncEditorToState() {
  const node = nodeAt(state.selectedPath);
  if (!node || node.type !== "file" || els.editor.disabled) return false;
  node.content = els.editor.value;
  updateSearchResults();
  scheduleSave();
  return true;
}
function findNext() {
  const term = els.findInput.value;
  if (!term) return void status("Enter text to find.");
  const content = els.editor.value;
  if (!content) return void status("Nothing to search.");
  const startAt = els.editor.selectionEnd || 0;
  let nextIndex = content.indexOf(term, startAt);
  if (nextIndex < 0) nextIndex = content.indexOf(term, 0);
  if (nextIndex < 0) return void status(`No match for "${term}".`);
  els.editor.focus();
  els.editor.setSelectionRange(nextIndex, nextIndex + term.length);
  status(`Found "${term}"`);
}
function replaceSelection() {
  const term = els.findInput.value;
  if (!term) return void status("Enter text to replace.");
  const start = els.editor.selectionStart;
  const end = els.editor.selectionEnd;
  if (start === end || els.editor.value.slice(start, end) !== term) return findNext();
  els.editor.setRangeText(els.replaceInput.value, start, end, "end");
  if (syncEditorToState()) status(`Replaced "${term}"`);
}
function replaceAllMatches() {
  const term = els.findInput.value;
  if (!term) return void status("Enter text to replace.");
  const content = els.editor.value;
  const count = content.split(term).length - 1;
  if (!count) return void status(`No match for "${term}".`);
  els.editor.value = content.split(term).join(els.replaceInput.value);
  if (syncEditorToState()) status(`Replaced ${count} match${count === 1 ? "" : "es"}.`);
}
async function saveSnapshotAction() {
  if (!state.active) return void status("Load a project first.");
  const name = await askText({ title: "Snapshot", message: "Save a restorable snapshot of this project", confirmLabel: "Save", value: `${state.active.name} ${new Date().toLocaleTimeString()}` });
  if (name === null) return;
  const snapshot = cloneSnapshot(state.active);
  if (name.trim()) snapshot.name = name.trim();
  state.active.snapshots = [snapshot, ...(state.active.snapshots || [])].slice(0, MAX_SNAPSHOTS);
  renderSnapshots();
  scheduleSave();
  status(`Saved snapshot "${snapshot.name}"`);
}
async function restoreSnapshotAction(snapshotId) {
  if (!state.active) return void status("Load a project first.");
  const snapshot = (state.active.snapshots || []).find((item) => item.id === snapshotId);
  if (!snapshot) return void status("Snapshot not found.");
  const ok = await askConfirm({ title: "Restore Snapshot", message: `Restore "${snapshot.name}"? Current edits in this project will be replaced.`, confirmLabel: "Restore" });
  if (!ok) return;
  state.active.files = snapshot.files.map((file) => ({ ...file }));
  state.active.entryFile = snapshot.entryFile;
  state.selectedPath = snapshot.selectedPath || snapshot.entryFile;
  ensureEntry(state.active);
  ensureSelectedExists();
  updateSearchResults();
  refreshAll();
  scheduleSave();
  status(`Restored snapshot "${snapshot.name}"`);
}
async function sharePreviewAction() {
  if (!state.active) return void status("Load a project first.");
  const { html, warnings } = await preview.buildStandaloneHtml(state.active);
  if (warnings.length) setIssues(warnings);
  const file = new File([html], `${sanitizeFileName(state.active.name)}.html`, { type: "text/html" });
  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ title: state.active.name, files: [file] });
    status(`Shared ${state.active.name}`);
    return;
  }
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  status("Opened preview in a new tab.");
}
async function runPreview() {
  if (!state.active) return void status("Load a project first.");
  setIssues([]);
  els.previewFallback.hidden = true;
  try {
    const result = await preview.render(state.active);
    setIssues(result.warnings || []);
    status(`Previewed ${state.active.name}`);
  } catch (error) {
    els.previewFallback.hidden = false;
    els.previewFallbackMsg.textContent = error.message || "Could not render preview.";
    pushDebugLog(`Preview failed: ${error.message || "Unknown error"}`, "error");
    status("Preview failed.");
  }
}
function registerPreviewMessages() {
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== "recess-preview") return;
    if (data.type === "runtime-error") {
      const payload = data.payload || {};
      const detail = payload.source ? ` (${payload.source}${payload.line ? `:${payload.line}` : ""})` : "";
      pushDebugLog(`Runtime: ${payload.message || "Unknown error"}${detail}`, "error");
    } else if (data.type === "console-error") {
      pushDebugLog(`Console error: ${(data.payload && data.payload.message) || "Unknown"}`, "error");
    } else if (data.type === "asset-error") {
      pushDebugLog(`Asset failed to load: ${data.payload && data.payload.url ? data.payload.url : "Unknown asset"}`, "error");
    }
  });
}
function registerEvents() {
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      document.body.classList.toggle("keyboard-open", window.visualViewport.height < window.innerHeight - 80);
    });
  }
  // Synchronous save for beforeunload: full project state to localStorage, summary to sendBeacon
  function saveActiveSync() {
    if (!savePending || !state.active) return;
    // 1. Save summary via sendBeacon (small metadata only)
    const meta = summary(state.active);
    const metaPayload = JSON.stringify(meta);
    if (navigator.sendBeacon) {
      try {
        const blob = new Blob([metaPayload], { type: "application/json" });
        navigator.sendBeacon("/api/active-meta", blob);
      } catch (e) {}
    }
    // 2. Save full project state to localStorage (with size guard)
    try {
      const fullPayload = JSON.stringify(state.active);
      // Guard: avoid storing >5MB (typical localStorage limit is 5MB)
      if (fullPayload.length < 4_500_000) {
        localStorage.setItem("recess-pending-project", fullPayload);
      }
    } catch (e) {}
  }
  window.addEventListener("beforeunload", () => { if (savePending) saveActiveSync(); });
  els.modalCancel.addEventListener("click", () => closeModal({ ok: false }));
  els.modalBackdrop.addEventListener("click", () => closeModal({ ok: false }));
  els.modalConfirm.addEventListener("click", () => closeModal({ ok: true, value: els.modalInput.value }));
  els.modalInput.addEventListener("keydown", (event) => { if (event.key === "Enter") closeModal({ ok: true, value: els.modalInput.value }); if (event.key === "Escape") closeModal({ ok: false }); });
  registerPreviewMessages();
  els.modeBtns.forEach((button) => button.addEventListener("click", () => { state.mode = button.dataset.mode; renderMode(); if (state.mode === "preview") runPreview(); }));
  els.reloadPreviewBtn.addEventListener("click", () => { runPreview(); pushDebugLog("Manual preview reload", "info"); });
  els.clearDebugBtn.addEventListener("click", () => { clearDebugLogs(); setIssues([]); });
  els.editor.addEventListener("input", () => syncEditorToState());
  els.projectName.addEventListener("blur", updateProjectName);
  els.projectName.addEventListener("keydown", (event) => { if (event.key === "Enter") els.projectName.blur(); });
  els.entry.addEventListener("change", updateEntry);
  els.findNextBtn.addEventListener("click", findNext);
  els.replaceBtn.addEventListener("click", replaceSelection);
  els.replaceAllBtn.addEventListener("click", replaceAllMatches);
  els.saveBtn.addEventListener("click", () => saveActive(false).catch(() => status("Save failed.")));
  els.runBtn.addEventListener("click", runPreview);
  els.shareBtn.addEventListener("click", () => sharePreviewAction().catch(() => status("Could not share preview.")));
  els.treeBtn.addEventListener("click", () => { openDrawer(els.fileDrawer); setFileDrawerState(true); });
  els.fileHandle.addEventListener("click", () => { openDrawer(els.fileDrawer); setFileDrawerState(true); });
  els.closeTree.addEventListener("click", () => { closeDrawer(els.fileDrawer); setFileDrawerState(false); });
  els.fileBackdrop.addEventListener("click", () => { closeDrawer(els.fileDrawer); setFileDrawerState(false); });
  els.fileSearch.addEventListener("input", () => { state.fileFilter = els.fileSearch.value; renderTree(); });
  els.newFile.addEventListener("click", () => addFileAction().catch(() => status("Could not create file.")));
  els.newFolder.addEventListener("click", () => addFolderAction().catch(() => status("Could not create folder.")));
  els.duplicateNode.addEventListener("click", () => duplicateNodeAction().catch(() => status("Could not duplicate node.")));
  els.renameNode.addEventListener("click", () => renameNodeAction().catch(() => status("Could not rename node.")));
  els.deleteNode.addEventListener("click", () => deleteNodeAction().catch(() => status("Could not delete node.")));
  els.projectsBtn.addEventListener("click", () => { state.selectedProjectId = state.active ? state.active.id : null; renderProjects(); openDrawer(els.projectsDrawer); });
  els.closeProjects.addEventListener("click", () => closeDrawer(els.projectsDrawer));
  els.projectsBackdrop.addEventListener("click", () => closeDrawer(els.projectsDrawer));
  els.searchBtn.addEventListener("click", () => { openDrawer(els.searchDrawer); renderSearchResults(); setTimeout(() => els.globalSearchInput.focus(), 40); });
  els.closeSearch.addEventListener("click", () => closeDrawer(els.searchDrawer));
  els.searchBackdrop.addEventListener("click", () => closeDrawer(els.searchDrawer));
  els.globalSearchInput.addEventListener("input", () => { state.searchQuery = els.globalSearchInput.value; updateSearchResults(); });
  els.newProject.addEventListener("click", () => createProjectAction().catch(() => status("Could not create project.")));
  els.duplicateProject.addEventListener("click", () => duplicateProjectAction().catch(() => status("Could not duplicate project.")));
  els.loadProject.addEventListener("click", () => loadSelectedProjectAction().catch(() => status("Could not load project.")));
  els.deleteProject.addEventListener("click", () => deleteProjectAction().catch(() => status("Could not delete project.")));
  els.exportProject.addEventListener("click", () => exportProjectAction().catch(() => status("Could not export project.")));
  els.exportBundle.addEventListener("click", () => exportBundleAction().catch(() => status("Could not export bundle.")));
  els.snapshotProject.addEventListener("click", () => saveSnapshotAction().catch(() => status("Could not save snapshot.")));
  els.importProject.addEventListener("click", () => { els.importInput.value = ""; els.importInput.click(); });
  els.importInput.addEventListener("change", async () => {
    const [file] = els.importInput.files || [];
    if (!file) return;
    try { await importProjectAction(file); }
    catch (error) { status(`Import failed: ${error.message}`); }
  });
}
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch(() => status("Service worker registration failed."));
    });
  }
}
async function bootstrap() {
  // Check for pending project recovery in localStorage
  let recovered = false;
  try {
    const pending = localStorage.getItem("recess-pending-project");
    if (pending) {
      const parsed = JSON.parse(pending);
      if (parsed && parsed.id && parsed.files && Array.isArray(parsed.files)) {
        // Restore as active project
        await putProject(parsed);
        state.projects = [summary(parsed)];
        await setMetaValue(LAST_PROJECT_META_KEY, parsed.id);
        await loadById(parsed.id);
        localStorage.removeItem("recess-pending-project");
        recovered = true;
      }
    }
  } catch (e) {}
  if (recovered) return;
  const all = await getAllProjects();
  if (!all.length) {
    const project = starter("My Project");
    await putProject(project);
    state.projects = [summary(project)];
    await setMetaValue(LAST_PROJECT_META_KEY, project.id);
    await loadById(project.id);
    return;
  }
  state.projects = all.map(summary);
  const last = await getMetaValue(LAST_PROJECT_META_KEY);
  const startId = state.projects.some((project) => project.id === last) ? last : state.projects[0].id;
  await loadById(startId);
}
async function init() {
  registerEvents();
  renderMode();
  renderIssues();
  renderSearchResults();
  try { await bootstrap(); refreshAll(); status("Ready."); }
  catch (error) { status(`Startup error: ${error.message}`); }
  registerServiceWorker();
}
window.addEventListener("beforeunload", () => preview.dispose());
init();

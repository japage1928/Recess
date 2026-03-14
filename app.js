import { getAllProjects, getProject, putProject, deleteProject, getMetaValue, setMetaValue } from "./db.js";
import { createPreviewRuntime } from "./preview.js";

const LAST_PROJECT_META_KEY = "lastOpenProjectId";
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
});` }
  ]
};

const $ = (id) => document.getElementById(id);
const els = {
    saveStatus: document.getElementById("saveStatusText"),
    lastSaved: document.getElementById("lastSavedText"),
  status: $("statusText"), projectName: $("projectNameInput"), entry: $("entryFileSelect"),
  editor: $("editorInput"), frame: $("previewFrame"), path: $("selectedPathText"), kind: $("selectedTypeText"),
  editorPane: $("editorPane"), previewPane: $("previewPane"), modeBtns: [...document.querySelectorAll(".mode-btn")],
  issuesWrap: $("previewIssuesWrap"), issuesList: $("previewIssuesList"),
  previewFallback: $("previewFallback"), previewFallbackMsg: $("previewFallbackMsg"),
  reloadPreviewBtn: $("reloadPreviewBtn"), clearDebugBtn: $("clearDebugBtn"),
  projectsBtn: $("projectsBtn"), treeBtn: $("treeBtn"), runBtn: $("runBtn"), saveBtn: $("saveBtn"),
  fileHandle: $("fileHandleBtn"),
  fileDrawer: $("fileDrawer"), fileBackdrop: $("fileDrawerBackdrop"), closeTree: $("closeTreeBtn"),
  tree: $("fileTree"), newFile: $("newFileBtn"), newFolder: $("newFolderBtn"), renameNode: $("renameNodeBtn"), deleteNode: $("deleteNodeBtn"),
  projectsDrawer: $("projectsDrawer"), projectsBackdrop: $("projectsDrawerBackdrop"), closeProjects: $("closeProjectsBtn"),
  projectsList: $("projectsList"), newProject: $("newProjectBtn"), loadProject: $("loadProjectBtn"), deleteProject: $("deleteProjectBtn"),
  exportProject: $("exportProjectBtn"), importProject: $("importProjectBtn"), importInput: $("importProjectInput"),
  modal: $("modalOverlay"), modalBackdrop: $("modalBackdrop"), modalTitle: $("modalTitle"), modalMsg: $("modalMessage"),
  modalWrap: $("modalInputWrap"), modalInput: $("modalInput"), modalCancel: $("modalCancelBtn"), modalConfirm: $("modalConfirmBtn")
};

const state = {
  projects: [], active: null, selectedPath: null, selectedProjectId: null, collapsed: new Set(),
  mode: "editor", issues: [],
  previewError: null,
  debugLogs: []
};

const preview = createPreviewRuntime(els.frame);
let autosaveTimer = null;
let savePending = false;
let lastSavedAt = null;
let modalResolve = null;

function id(prefix) { return `${prefix}_${crypto?.randomUUID?.() || `${Date.now()}_${Math.floor(Math.random() * 1e6)}`}`; }
function status(msg) { els.status.textContent = msg; }

function setSaveStatus(state, errorMsg) {
  if (!els.saveStatus) return;
  els.saveStatus.classList.remove("saving", "error");
  if (state === "saving") {
    els.saveStatus.textContent = "Saving...";
    els.saveStatus.classList.add("saving");
  } else if (state === "error") {
    els.saveStatus.textContent = errorMsg || "Save failed";
    els.saveStatus.classList.add("error");
  } else {
    els.saveStatus.textContent = "All changes saved";
  }
}

function setLastSaved(ts) {
  if (!els.lastSaved) return;
  if (!ts) {
    els.lastSaved.textContent = "";
    return;
  }
  const d = new Date(ts);
  els.lastSaved.textContent = `Last saved: ${d.toLocaleTimeString()}`;
}
function normalizePath(p) {
  const raw = (p || "").replace(/\\/g, "/").trim().replace(/^\/+|\/+$/g, "");
  if (!raw) return "";
  const out = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { out.pop(); continue; }
    out.push(part);
  }
  return out.join("/");
}
function parentPath(p) { const n = normalizePath(p); return n.includes("/") ? n.slice(0, n.lastIndexOf("/")) : ""; }
function baseName(p) { const n = normalizePath(p); return n.includes("/") ? n.slice(n.lastIndexOf("/") + 1) : n; }
function joinPath(parent, name) { const a = normalizePath(parent), b = normalizePath(name); return a ? (b ? `${a}/${b}` : a) : b; }
function isEditable(path) { return /\.(html|css|js|json|txt)$/i.test(path); }
function nodeSort(a, b) { return a.type === b.type ? a.path.localeCompare(b.path) : (a.type === "folder" ? -1 : 1); }
function summary(project) { return { id: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, entryFile: project.entryFile }; }
function nodeAt(path) { return state.active?.files.find((f) => f.path === path) || null; }
function htmlPaths(project) { return project.files.filter((f) => f.type === "file" && /\.html?$/i.test(f.path)).map((f) => f.path).sort(); }
function ensureEntry(project) {
  const files = htmlPaths(project);
  if (!files.length) { project.entryFile = "index.html"; return; }
  if (!project.entryFile || !files.includes(project.entryFile)) project.entryFile = files.includes("index.html") ? "index.html" : files[0];
}
function starter(name) {
  const now = Date.now();
  return {
    id: id("proj"), name: (name || STARTER_TEMPLATE.name).trim() || "My Project", entryFile: STARTER_TEMPLATE.entryFile,
    files: STARTER_TEMPLATE.files.map((f) => ({ id: id(f.type === "folder" ? "folder" : "file"), name: baseName(f.path), path: normalizePath(f.path), type: f.type, content: f.type === "file" ? f.content : undefined })),
    createdAt: now, updatedAt: now
  };
}
function setIssues(items) {
  state.issues = (items || []).slice(0, 50);
  renderIssues();
}
function pushIssue(text) {
  if (!text) return;
  state.issues.unshift(text);
  state.issues = state.issues.slice(0, 50);
  renderIssues();
}
function pushDebugLog(msg, type = "info") {
  state.debugLogs.unshift({ msg, type, ts: Date.now() });
  state.debugLogs = state.debugLogs.slice(0, 100);
  renderIssues();
}
function clearDebugLogs() {
  state.debugLogs = [];
  renderIssues();
}
function renderIssues() {
  els.issuesList.innerHTML = "";
  if (!state.issues.length && !state.debugLogs.length) {
    els.issuesWrap.hidden = true;
    return;
  }
  els.issuesWrap.hidden = false;
  // Show debug logs first, then issues
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
  els.modeBtns.forEach((b) => b.classList.toggle("is-active", b.dataset.mode === state.mode));
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
    const o = document.createElement("option"); o.value = ""; o.textContent = "No HTML files"; els.entry.appendChild(o); els.entry.disabled = true; return;
  }
  els.entry.disabled = false;
  html.forEach((p) => { const o = document.createElement("option"); o.value = p; o.textContent = p; o.selected = p === state.active.entryFile; els.entry.appendChild(o); });
}

function renderEditor() {
  const node = nodeAt(state.selectedPath);
  if (!node) {
    els.path.textContent = "No file selected"; els.kind.textContent = "";
    els.editor.value = ""; els.editor.disabled = true; els.editor.placeholder = "Select a file from the file tree.";
    return;
  }
  els.path.textContent = node.path; els.kind.textContent = node.type === "folder" ? "Folder" : "File";
  if (node.type !== "file") {
    els.editor.value = ""; els.editor.disabled = true; els.editor.placeholder = "Folders cannot be edited."; return;
  }
  els.editor.disabled = !isEditable(node.path);
  els.editor.value = node.content || "";
  els.editor.placeholder = els.editor.disabled ? "This file type is not editable in v2.5." : "";
}

function treeMap(project) {
  const map = new Map();
  project.files.forEach((f) => map.set(f.path, []));
  project.files.forEach((f) => { const p = parentPath(f.path); if (!map.has(p)) map.set(p, []); map.get(p).push(f); });
  map.forEach((arr) => arr.sort(nodeSort));
  return map;
}

function renderTree() {
  els.tree.innerHTML = "";
  if (!state.active) return;
  const map = treeMap(state.active);
  const append = (parent, depth) => {
    (map.get(parent) || []).forEach((n) => {
      const li = document.createElement("li");
      const row = document.createElement("div"); row.className = "tree-row";
      const collapse = document.createElement("button");
      const nodeBtn = document.createElement("button");
      const folder = n.type === "folder";
      const collapsed = state.collapsed.has(n.path);
      collapse.type = "button"; collapse.className = "tree-collapse-btn"; collapse.disabled = !folder; collapse.textContent = folder ? (collapsed ? "+" : "-") : "";
      collapse.addEventListener("click", () => { if (!folder) return; collapsed ? state.collapsed.delete(n.path) : state.collapsed.add(n.path); renderTree(); });
      nodeBtn.type = "button"; nodeBtn.className = "tree-node-btn"; nodeBtn.classList.toggle("is-selected", n.path === state.selectedPath);
      nodeBtn.style.paddingLeft = `${10 + depth * 14}px`; nodeBtn.textContent = `${folder ? "[D]" : "[F]"} ${n.name}`;
      nodeBtn.addEventListener("click", () => { state.selectedPath = n.path; renderTree(); renderEditor(); });
      row.append(collapse, nodeBtn); li.appendChild(row); els.tree.appendChild(li);
      if (folder && !collapsed) append(n.path, depth + 1);
    });
  };
  append("", 0);

  const selectedNode = els.tree.querySelector(".tree-node-btn.is-selected");
  if (selectedNode) {
    requestAnimationFrame(() => {
      selectedNode.scrollIntoView({ block: "nearest" });
    });
  }
}

function renderProjects() {
  els.projectsList.innerHTML = "";
  [...state.projects].sort((a, b) => b.updatedAt - a.updatedAt).forEach((p) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button"; b.className = "project-item";
    b.classList.toggle("is-selected", p.id === state.selectedProjectId);
    b.classList.toggle("is-active", !!state.active && p.id === state.active.id);
    b.textContent = `${p.name} (${new Date(p.updatedAt).toLocaleString()})${state.active && p.id === state.active.id ? " | Active" : ""}`;
    b.addEventListener("click", () => { state.selectedProjectId = p.id; renderProjects(); });
    li.appendChild(b); els.projectsList.appendChild(li);
  });
}

function openDrawer(el) { el.hidden = false; }
function closeDrawer(el) { el.hidden = true; }

function setFileDrawerState(isOpen) {
  document.body.classList.toggle("file-drawer-open", isOpen);
}

function closeModal(result) {
  els.modal.hidden = true;
  if (modalResolve) { const resolve = modalResolve; modalResolve = null; resolve(result); }
}

function openModal({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", dangerous = false, input = false, value = "", placeholder = "" }) {
  els.modalTitle.textContent = title; els.modalMsg.textContent = message;
  els.modalConfirm.textContent = confirmLabel; els.modalCancel.textContent = cancelLabel;
  els.modalConfirm.classList.toggle("btn-danger", dangerous); els.modalConfirm.classList.toggle("btn-primary", !dangerous);
  els.modalWrap.hidden = !input; els.modalInput.value = value; els.modalInput.placeholder = placeholder;
  els.modal.hidden = false; setTimeout(() => (input ? els.modalInput : els.modalConfirm).focus(), 0);
  return new Promise((resolve) => { modalResolve = resolve; });
}

async function askText(opts) { const r = await openModal({ ...opts, input: true }); return !r || !r.ok ? null : (r.value || "").trim(); }
async function askConfirm(opts) { const r = await openModal(opts); return !!(r && r.ok); }

function refreshAll() { renderProjectBar(); renderProjects(); renderTree(); renderEditor(); }
function touch() { if (state.active) state.active.updatedAt = Date.now(); }

function ensureSelectedExists() {
  if (!state.active) { state.selectedPath = null; return; }
  if (state.selectedPath && nodeAt(state.selectedPath)) return;
  const firstFile = state.active.files.find((f) => f.type === "file");
  state.selectedPath = firstFile ? firstFile.path : null;
}

function pathExists(path, except = null) {
  return state.active.files.some((f) => f.path === path && f.path !== except);
}

function selectedFolder() {
  if (!state.selectedPath) return "";
  const n = nodeAt(state.selectedPath);
  if (!n) return "";
  return n.type === "folder" ? n.path : parentPath(n.path);
}

function renameCollapsed(oldPath, nextPath) {
  const oldPrefix = `${oldPath}/`;
  const next = new Set();
  state.collapsed.forEach((p) => {
    if (p === oldPath) next.add(nextPath);
    else if (p.startsWith(oldPrefix)) next.add(`${nextPath}/${p.slice(oldPrefix.length)}`);
    else next.add(p);
  });
  state.collapsed = next;
}

function pruneCollapsed(path) {
  const prefix = `${path}/`;
  const next = new Set();
  state.collapsed.forEach((p) => { if (p !== path && !p.startsWith(prefix)) next.add(p); });
  state.collapsed = next;
}

function scheduleSave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  setSaveStatus("saving");
  savePending = true;
  autosaveTimer = setTimeout(() => {
    saveActive(true).catch(() => setSaveStatus("error", "Auto-save failed."));
  }, 600);
}

async function saveActive(quiet = false) {
  if (!state.active) return;
  setSaveStatus("saving");
  savePending = true;
  try {
    touch();
    await putProject(state.active);
    await setMetaValue(LAST_PROJECT_META_KEY, state.active.id);
    const i = state.projects.findIndex((p) => p.id === state.active.id);
    const s = summary(state.active);
    if (i >= 0) state.projects[i] = s; else state.projects.push(s);
    renderProjects();
    lastSavedAt = Date.now();
    setLastSaved(lastSavedAt);
    setSaveStatus("saved");
    savePending = false;
    if (!quiet) status(`Saved ${state.active.name}`);
  } catch (e) {
    setSaveStatus("error", e && e.message);
    savePending = false;
    if (!quiet) status("Save failed.");
  }
}

async function loadById(projectId) {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found.");
  state.active = project;
  state.selectedProjectId = project.id;
  ensureEntry(state.active);
  ensureSelectedExists();
  refreshAll();
  await setMetaValue(LAST_PROJECT_META_KEY, project.id);
  // Set last saved timestamp if available
  lastSavedAt = project.updatedAt || Date.now();
  setLastSaved(lastSavedAt);
  setSaveStatus("saved");
  status(`Loaded ${project.name}`);
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

async function addFileAction() {
  if (!state.active) return;
  let name;
  while (true) {
    name = await askText({ title: "New File", message: "Enter a file name (example: notes.txt)", confirmLabel: "Create", value: "new-file.txt" });
    if (name === null) return;
    if (!name.trim() || name.includes("/")) {
      status("Invalid file name.");
      continue;
    }
    const path = joinPath(selectedFolder(), name);
    if (pathExists(path)) {
      status("A file or folder already exists at that path.");
      continue;
    }
    break;
  }
  const path = joinPath(selectedFolder(), name);
  state.active.files.push({ id: id("file"), name, path, type: "file", content: "" });
  state.selectedPath = path; ensureEntry(state.active); refreshAll(); scheduleSave(); status(`Created file ${path}`);
}

async function addFolderAction() {
  if (!state.active) return;
  let name;
  while (true) {
    name = await askText({ title: "New Folder", message: "Enter a folder name", confirmLabel: "Create", value: "new-folder" });
    if (name === null) return;
    if (!name.trim() || name.includes("/")) {
      status("Invalid folder name.");
      continue;
    }
    const path = joinPath(selectedFolder(), name);
    if (pathExists(path)) {
      status("A file or folder already exists at that path.");
      continue;
    }
    break;
  }
  const path = joinPath(selectedFolder(), name);
  state.active.files.push({ id: id("folder"), name, path, type: "folder" });
  state.selectedPath = path; state.collapsed.delete(path); refreshAll(); scheduleSave(); status(`Created folder ${path}`);
}

async function renameNodeAction() {
  if (!state.active || !state.selectedPath) return void status("Select a file or folder first.");
  const selected = nodeAt(state.selectedPath);
  if (!selected) return void status("Selection not found.");
  let nextName;
  while (true) {
    nextName = await askText({ title: "Rename", message: `Rename ${selected.path}", confirmLabel: "Rename", value: selected.name });
    if (nextName === null) return;
    if (!nextName.trim() || nextName.includes("/")) {
      status("Invalid name.");
      continue;
    }
    const nextPath = joinPath(parentPath(selected.path), nextName);
    if (nextPath !== selected.path && pathExists(nextPath, selected.path)) {
      status("Another node already exists with that path.");
      continue;
    }
    break;
  }
  const nextPath = joinPath(parentPath(selected.path), nextName);
  if (selected.type === "file") {
    const oldPath = selected.path;
    selected.name = nextName; selected.path = nextPath;
    if (state.active.entryFile === oldPath) state.active.entryFile = nextPath;
  } else {
    const oldPath = selected.path, oldPrefix = `${oldPath}/`, nextPrefix = `${nextPath}/`;
    state.active.files.forEach((f) => {
      if (f.path === oldPath) { f.name = nextName; f.path = nextPath; return; }
      if (f.path.startsWith(oldPrefix)) { f.path = `${nextPrefix}${f.path.slice(oldPrefix.length)}`; f.name = baseName(f.path); }
    });
    if (state.active.entryFile === oldPath) state.active.entryFile = nextPath;
    else if (state.active.entryFile.startsWith(oldPrefix)) state.active.entryFile = `${nextPrefix}${state.active.entryFile.slice(oldPrefix.length)}`;
    renameCollapsed(oldPath, nextPath);
  }
  state.selectedPath = nextPath; ensureEntry(state.active); refreshAll(); scheduleSave(); status(`Renamed to ${nextPath}`);
}

async function deleteNodeAction() {
  if (!state.active || !state.selectedPath) return void status("Select a file or folder first.");
  const selected = nodeAt(state.selectedPath);
  if (!selected) return void status("Selection not found.");
  const ok = await askConfirm({
    title: "Delete",
    message: `Are you sure you want to delete ${selected.path}? This cannot be undone.\n\nAll files and folders inside will be permanently removed.`,
    confirmLabel: "Delete",
    dangerous: true
  });
  if (!ok) return;
  if (selected.type === "folder") {
    const prefix = `${selected.path}/`;
    state.active.files = state.active.files.filter((f) => f.path !== selected.path && !f.path.startsWith(prefix));
    if (state.active.entryFile === selected.path || state.active.entryFile.startsWith(prefix)) state.active.entryFile = "index.html";
    pruneCollapsed(selected.path);
  } else {
    state.active.files = state.active.files.filter((f) => f.path !== selected.path);
    if (state.active.entryFile === selected.path) state.active.entryFile = "index.html";
  }
  ensureEntry(state.active); ensureSelectedExists(); refreshAll(); scheduleSave(); status(`Deleted ${selected.path}`);
}
async function deleteProjectAction() {
  if (!state.selectedProjectId) return void status("Select a project first.");
  if (state.projects.length <= 1) return void status("Keep at least one project.");
  const project = state.projects.find((p) => p.id === state.selectedProjectId);
  if (!project) return void status("Project not found.");
  const ok = await askConfirm({
    title: "Delete Project",
    message: `Are you sure you want to delete project '${project.name}'? This cannot be undone.\n\nAll files and folders in this project will be permanently removed.`,
    confirmLabel: "Delete",
    dangerous: true
  });
  if (!ok) return;
  await deleteProject(project.id);
  state.projects = state.projects.filter((p) => p.id !== project.id);
  state.selectedProjectId = state.projects[0].id;
  await loadById(state.selectedProjectId);
}

async function loadSelectedProjectAction() {
  if (!state.selectedProjectId) return void status("Select a project first.");
  await loadById(state.selectedProjectId);
  closeDrawer(els.projectsDrawer);
}

function sanitizeFileName(name) { return name.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "") || "project"; }

async function exportProjectAction() {
  const projectId = state.selectedProjectId || state.active?.id;
  if (!projectId) return void status("Select a project first.");
  const project = await getProject(projectId);
  if (!project) return void status("Project not found.");
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${sanitizeFileName(project.name)}.recess.json`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  status(`Exported ${project.name}`);
}

function normalizeImported(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid project JSON format.");
  const seen = new Set();
  const files = (Array.isArray(raw.files) ? raw.files : []).map((f) => {
    if (!f || (f.type !== "file" && f.type !== "folder")) return null;
    const path = normalizePath(f.path || "");
    if (!path || seen.has(path)) return null;
    seen.add(path);
    return { id: typeof f.id === "string" ? f.id : id(f.type === "folder" ? "folder" : "file"), name: (typeof f.name === "string" && f.name.trim()) ? f.name.trim() : baseName(path), path, type: f.type, content: f.type === "file" ? String(f.content || "") : undefined };
  }).filter(Boolean);
  if (!files.length) throw new Error("Imported project has no valid files.");
  const project = {
    id: id("proj"), name: (typeof raw.name === "string" && raw.name.trim()) ? raw.name.trim() : "Imported Project",
    entryFile: typeof raw.entryFile === "string" ? normalizePath(raw.entryFile) : "index.html",
    files, createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(), updatedAt: Date.now()
  };
  ensureEntry(project);
  return project;
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

function renderTree() {
  els.tree.innerHTML = "";
  if (!state.active) return;
  const map = treeMap(state.active);
  const append = (parent, depth) => {
    (map.get(parent) || []).forEach((n) => {
      const li = document.createElement("li");
      const row = document.createElement("div"); row.className = "tree-row";
      const collapse = document.createElement("button");
      const nodeBtn = document.createElement("button");
      const folder = n.type === "folder";
      const collapsed = state.collapsed.has(n.path);
      collapse.type = "button"; collapse.className = "tree-collapse-btn"; collapse.disabled = !folder; collapse.textContent = folder ? (collapsed ? "+" : "-") : "";
      collapse.addEventListener("click", (e) => { e.stopPropagation(); if (!folder) return; collapsed ? state.collapsed.delete(n.path) : state.collapsed.add(n.path); renderTree(); });
      nodeBtn.type = "button"; nodeBtn.className = "tree-node-btn"; nodeBtn.classList.toggle("is-selected", n.path === state.selectedPath);
      nodeBtn.style.paddingLeft = `${10 + depth * 14}px`; nodeBtn.textContent = `${folder ? "[D]" : "[F]"} ${n.name}`;
      nodeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.selectedPath = n.path;
        renderTree();
        renderEditor();
        // On mobile, auto-close drawer and focus editor
        if (window.innerWidth < 700) {
          closeDrawer(els.fileDrawer);
          setFileDrawerState(false);
          if (els.editor && n.type === "file") {
            setTimeout(() => { els.editor.focus(); }, 250);
          }
        }
      });
      row.append(collapse, nodeBtn); li.appendChild(row); els.tree.appendChild(li);
      if (folder && !collapsed) append(n.path, depth + 1);
    });
  };
  append("", 0);

  const selectedNode = els.tree.querySelector(".tree-node-btn.is-selected");
  if (selectedNode) {
    requestAnimationFrame(() => {
      selectedNode.scrollIntoView({ block: "nearest" });
    });
  }
}
    if (!data || data.source !== "recess-preview") return;
    if (data.type === "runtime-error") {
      const p = data.payload || {};
      const detail = p.source ? ` (${p.source}${p.line ? `:${p.line}` : ""})` : "";
      pushDebugLog(`Runtime: ${p.message || "Unknown error"}${detail}`, "error");
    }
    if (data.type === "console-error") {
      pushDebugLog(`Console error: ${(data.payload && data.payload.message) || "Unknown"}`, "error");
    }
    if (data.type === "asset-error") {
      pushDebugLog(`Asset failed to load: ${data.payload && data.payload.url ? data.payload.url : "Unknown asset"}`, "error");
    }
  });
}

function registerEvents() {
      // On mobile, keep controls accessible after keyboard opens
      if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", () => {
          document.body.classList.toggle("keyboard-open", window.visualViewport.height < window.innerHeight - 80);
        });
      }
    // On page unload, try to save if pending
    window.addEventListener("beforeunload", (e) => {
      if (savePending) {
        saveActive(true);
        setSaveStatus("saving");
      }
    });
  els.modalCancel.addEventListener("click", () => closeModal({ ok: false }));
  els.modalBackdrop.addEventListener("click", () => closeModal({ ok: false }));
  els.modalConfirm.addEventListener("click", () => closeModal({ ok: true, value: els.modalInput.value }));
  els.modalInput.addEventListener("keydown", (e) => { if (e.key === "Enter") closeModal({ ok: true, value: els.modalInput.value }); if (e.key === "Escape") closeModal({ ok: false }); });

  registerPreviewMessages();

  els.modeBtns.forEach((b) => b.addEventListener("click", () => { state.mode = b.dataset.mode; renderMode(); if (state.mode === "preview") runPreview(); }));
  if (els.reloadPreviewBtn) {
    els.reloadPreviewBtn.addEventListener("click", () => {
      runPreview();
      pushDebugLog("Manual preview reload", "info");
    });
  }
  if (els.clearDebugBtn) {
    els.clearDebugBtn.addEventListener("click", () => {
      clearDebugLogs();
      setIssues([]);
    });
  }
  els.editor.addEventListener("input", () => { const n = nodeAt(state.selectedPath); if (!n || n.type !== "file" || els.editor.disabled) return; n.content = els.editor.value; scheduleSave(); });
  els.projectName.addEventListener("blur", updateProjectName);
  els.projectName.addEventListener("keydown", (e) => { if (e.key === "Enter") els.projectName.blur(); });
  els.entry.addEventListener("change", updateEntry);

  els.saveBtn.addEventListener("click", () => saveActive(false).catch(() => status("Save failed.")));
  els.runBtn.addEventListener("click", runPreview);

  els.treeBtn.addEventListener("click", () => { openDrawer(els.fileDrawer); setFileDrawerState(true); });
  els.fileHandle.addEventListener("click", () => { openDrawer(els.fileDrawer); setFileDrawerState(true); });
  els.closeTree.addEventListener("click", () => { closeDrawer(els.fileDrawer); setFileDrawerState(false); });
  els.fileBackdrop.addEventListener("click", () => { closeDrawer(els.fileDrawer); setFileDrawerState(false); });

  els.newFile.addEventListener("click", () => addFileAction().catch(() => status("Could not create file.")));
  els.newFolder.addEventListener("click", () => addFolderAction().catch(() => status("Could not create folder.")));
  els.renameNode.addEventListener("click", () => renameNodeAction().catch(() => status("Could not rename node.")));
  els.deleteNode.addEventListener("click", () => deleteNodeAction().catch(() => status("Could not delete node.")));

  els.projectsBtn.addEventListener("click", () => { state.selectedProjectId = state.active ? state.active.id : null; renderProjects(); openDrawer(els.projectsDrawer); });
  els.closeProjects.addEventListener("click", () => closeDrawer(els.projectsDrawer));
  els.projectsBackdrop.addEventListener("click", () => closeDrawer(els.projectsDrawer));

  els.newProject.addEventListener("click", () => createProjectAction().catch(() => status("Could not create project.")));
  els.loadProject.addEventListener("click", () => loadSelectedProjectAction().catch(() => status("Could not load project.")));
  els.deleteProject.addEventListener("click", () => deleteProjectAction().catch(() => status("Could not delete project.")));
  els.exportProject.addEventListener("click", () => exportProjectAction().catch(() => status("Could not export project.")));
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
  const all = await getAllProjects();
  if (!all.length) {
    const p = starter("My Project");
    await putProject(p);
    state.projects = [summary(p)];
    await setMetaValue(LAST_PROJECT_META_KEY, p.id);
    await loadById(p.id);
    return;
  }
  state.projects = all.map(summary);
  const last = await getMetaValue(LAST_PROJECT_META_KEY);
  const startId = state.projects.some((p) => p.id === last) ? last : state.projects[0].id;
  await loadById(startId);
}

async function init() {
  registerEvents();
  renderMode();
  renderIssues();
  try { await bootstrap(); refreshAll(); status("Ready."); }
  catch (error) { status(`Startup error: ${error.message}`); }
  registerServiceWorker();
}

window.addEventListener("beforeunload", () => preview.dispose());
init();

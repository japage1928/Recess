const DB_NAME = "recess-v2";
const DB_VERSION = 1;
const PROJECT_STORE = "projects";
const META_STORE = "meta";

let dbPromise;

function openDb() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(PROJECT_STORE)) {
        db.createObjectStore(PROJECT_STORE, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB"));
  });

  return dbPromise;
}

async function runTransaction(storeName, mode, operation) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);

    let operationResult;

    try {
      operationResult = operation(store);
    } catch (error) {
      reject(error);
      return;
    }

    tx.oncomplete = () => resolve(operationResult);
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

export async function getAllProjects() {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROJECT_STORE, "readonly");
    const store = tx.objectStore(PROJECT_STORE);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || new Error("Failed to read projects"));
  });
}

export async function getProject(projectId) {
  if (!projectId) {
    return null;
  }

  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROJECT_STORE, "readonly");
    const store = tx.objectStore(PROJECT_STORE);
    const request = store.get(projectId);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("Failed to read project"));
  });
}

export async function putProject(project) {
  return runTransaction(PROJECT_STORE, "readwrite", (store) => {
    store.put(project);
  });
}

export async function deleteProject(projectId) {
  return runTransaction(PROJECT_STORE, "readwrite", (store) => {
    store.delete(projectId);
  });
}

export async function getMetaValue(key) {
  if (!key) {
    return null;
  }

  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readonly");
    const store = tx.objectStore(META_STORE);
    const request = store.get(key);

    request.onsuccess = () => {
      const row = request.result;
      resolve(row ? row.value : null);
    };
    request.onerror = () => reject(request.error || new Error("Failed to read metadata"));
  });
}

export async function setMetaValue(key, value) {
  return runTransaction(META_STORE, "readwrite", (store) => {
    store.put({ key, value });
  });
}
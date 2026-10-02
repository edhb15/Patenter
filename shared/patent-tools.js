/* =========================================================
   PATENTER SHARED STORAGE  (used by app/index.html and
   app/editor/document.html — both pages open the same database)

   Database "patenter", version 3
     documents  keyPath "id"   indexes: updatedAt, type, status, kind
     meta       keyPath "key"

   Every row in "documents":
     id, title, kind ("file" | "editor"), type, ref, status, owner,
     createdAt, updatedAt   (numbers: ms since epoch)
     fileName, mimeType, size
     kind "file"   → blob       (uploaded in the library)
     kind "editor" → pages[]    (HTML per page, written by the editor)

   Rows written by the older "PatenterEditorDB" are copied in once.
========================================================= */

const PATENTER_DB_NAME = "patenter";
const PATENTER_DB_VERSION = 3;
const PATENTER_LEGACY_DB = "PatenterEditorDB";

// Accepts numbers, ISO strings or Dates; returns ms (0 if unknown).
function patenterToMs(value) {
    if (typeof value === "number") return value;
    if (value instanceof Date) return value.getTime();
    const ms = Date.parse(value || "");
    return Number.isNaN(ms) ? 0 : ms;
}

// Bring any record (old library row, old editor row, new row) to the shared shape.
function patenterNormalize(record) {
    const r = { ...record };
    r.kind = r.kind || (Array.isArray(r.pages) ? "editor" : "file");
    r.createdAt = patenterToMs(r.createdAt || r.savedAt || r.updatedAt) || Date.now();
    r.updatedAt = patenterToMs(r.updatedAt || r.savedAt) || r.createdAt;
    delete r.savedAt;
    r.title = r.title || "Untitled document";
    r.type = r.type || "Patent application";
    r.status = r.status || "Draft";
    r.owner = r.owner || "You";
    if (r.ref == null) r.ref = "";
    if (r.kind === "editor") {
        r.pages = Array.isArray(r.pages) ? r.pages : [""];
        r.mimeType = "text/html";
        r.fileName = `${r.title}.html`;
        r.size = new Blob(r.pages).size;
    }
    return r;
}

const patenterIsEditorDoc = r => !!r && (r.kind === "editor" || Array.isArray(r.pages));

function patenterRequest(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function patenterUpgrade(db, tx) {
    const docs = db.objectStoreNames.contains("documents")
        ? tx.objectStore("documents")
        : db.createObjectStore("documents", { keyPath: "id" });

    ["updatedAt", "type", "status", "kind"].forEach(name => {
        if (!docs.indexNames.contains(name)) docs.createIndex(name, name);
    });

    if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
    }

    // Rewrite existing rows (e.g. from library v1) into the shared shape.
    docs.openCursor().onsuccess = event => {
        const cursor = event.target.result;
        if (!cursor) return;
        cursor.update(patenterNormalize(cursor.value));
        cursor.continue();
    };
}

// Copy documents from the editor's old database the first time we run.
async function patenterMigrateLegacy(db) {
    const flag = await patenterRequest(
        db.transaction("meta", "readonly").objectStore("meta").get("migratedLegacyEditorDB")
    );
    if (flag) return;

    // Open the old DB without creating it if it never existed.
    const legacy = await new Promise(resolve => {
        let req;
        try { req = indexedDB.open(PATENTER_LEGACY_DB); } catch { return resolve(null); }
        req.onupgradeneeded = event => { if (event.oldVersion === 0) req.transaction.abort(); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = event => { event.preventDefault(); resolve(null); };
        req.onblocked = () => resolve(null);
    });

    let oldDocs = [];
    let lastOpenedId;
    if (legacy) {
        try {
            if (legacy.objectStoreNames.contains("documents")) {
                oldDocs = await patenterRequest(
                    legacy.transaction("documents", "readonly").objectStore("documents").getAll()
                );
            }
            if (legacy.objectStoreNames.contains("meta")) {
                const row = await patenterRequest(
                    legacy.transaction("meta", "readonly").objectStore("meta").get("lastOpenedId")
                );
                lastOpenedId = row && row.value;
            }
        } finally {
            legacy.close();
        }
    }

    await new Promise((resolve, reject) => {
        const tx = db.transaction(["documents", "meta"], "readwrite");
        const docs = tx.objectStore("documents");
        const meta = tx.objectStore("meta");
        oldDocs.forEach(doc => {
            docs.get(doc.id).onsuccess = e => {
                if (!e.target.result) docs.put(patenterNormalize({ ...doc, kind: "editor" }));
            };
        });
        if (lastOpenedId) {
            meta.get("lastOpenedId").onsuccess = e => {
                if (!e.target.result) meta.put({ key: "lastOpenedId", value: lastOpenedId });
            };
        }
        meta.put({ key: "migratedLegacyEditorDB", value: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("Migration aborted"));
    });
}

let patenterDbPromise = null;

function patenterOpenDB() {
    if (patenterDbPromise) return patenterDbPromise;

    patenterDbPromise = new Promise((resolve, reject) => {
        if (!("indexedDB" in window)) {
            reject(new Error("IndexedDB is not supported in this browser."));
            return;
        }
        const req = indexedDB.open(PATENTER_DB_NAME, PATENTER_DB_VERSION);
        req.onupgradeneeded = () => patenterUpgrade(req.result, req.transaction);
        req.onsuccess = () => {
            const db = req.result;
            // Another tab needs a newer version: let go so it isn't blocked.
            db.onversionchange = () => { db.close(); patenterDbPromise = null; };
            resolve(db);
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => {
            console.warn("Patenter database upgrade is waiting for another tab to close.");
            window.dispatchEvent(new CustomEvent("patenter-db-blocked"));
        };
    }).then(async db => {
        try { await patenterMigrateLegacy(db); } catch (err) { console.warn("Legacy migration skipped:", err); }
        return db;
    });

    patenterDbPromise.catch(() => { patenterDbPromise = null; });
    return patenterDbPromise;
}

// Read-modify-write several rows in ONE transaction, so edits made by the
// other page between the read and the write are never lost.
// patches: [{ id, changes, create? }] — create is used when the row is missing.
async function patenterPatch(patches) {
    if (!patches || !patches.length) return;

    const db = await patenterOpenDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction("documents", "readwrite");
        const store = tx.objectStore("documents");

        const queued = patches.map(({ id, changes, create }) => ({ id, changes, create }));
        let pending = queued.length;

        if (!pending) {
            tx.oncomplete = () => resolve();
            return;
        }

        queued.forEach(({ id, changes, create }) => {
            const request = store.get(id);
            request.onsuccess = () => {
                const current = request.result || create;
                if (!current) {
                    if (--pending === 0) {
                        tx.oncomplete = () => {
                            patenterNotify(queued.map(p => p.id));
                            resolve();
                        };
                    }
                    return;
                }

                const next = patenterNormalize({ ...current, ...changes, id });
                store.put(next);
                if (--pending === 0) {
                    tx.oncomplete = () => {
                        patenterNotify(queued.map(p => p.id));
                        resolve();
                    };
                }
            };
            request.onerror = () => {
                reject(request.error);
            };
        });

        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
    });
}

// Tell the other page (in other tabs) that rows changed.
const patenterChannel = "BroadcastChannel" in window ? new BroadcastChannel("patenter-db") : null;
function patenterNotify(ids) {
    try { patenterChannel && patenterChannel.postMessage({ type: "changed", ids }); } catch {}
}

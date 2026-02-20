// console.log("marked:", typeof marked, "DOMPurify:", typeof DOMPurify);
// console.log("APP.JS LOADED — landing debug v1");

import { encryptString, decryptString } from "./crypto.js";

const CLIENT_ID =
  "958128893648-pmplfiift02gv9q1gi0qidr1oj1sp6s8.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/drive.appdata";

const btnLogin = document.getElementById("btnLogin");
const statusEl = document.getElementById("status");

const passEl = document.getElementById("pass");
const editorEl = document.getElementById("editor");
const btnSave = document.getElementById("btnSave");
const postsEl = document.getElementById("posts");
const btnUnlock = document.getElementById("btnUnlock");
const previewToggleEl = document.getElementById("previewToggle");
const previewEl = document.getElementById("preview");
const screenConnect = document.getElementById("screenConnect");
const screenMain = document.getElementById("screenMain");
const btnLoginLanding = document.getElementById("btnLoginLanding");
const overlay = document.getElementById("overlay");
const overlayFrame = document.getElementById("overlayFrame");
const overlayClose = document.getElementById("overlayClose");
const linkPrivacy = document.getElementById("linkPrivacy");
const linkInstructions = document.getElementById("linkInstructions");
const linkTerms = document.getElementById("linkTerms");
const toggleShowPass = document.getElementById("toggleShowPass");
const DRAFT_KEY = "lightjournal_draft";
const btnDisconnect = document.getElementById("btnDisconnect");

let accessToken = null;
let tokenClient = null;
let journalFileId = null;
let autoLoadTimer = null;
let lastLoadedPass = null;
let loadSeq = 0;
let currentJournalName = "journal.enc";

editorEl.addEventListener("input", () => {
  localStorage.setItem(DRAFT_KEY, editorEl.value);
});

async function devClearSwAndCaches() {
  if (location.hostname !== "localhost" && location.hostname !== "127.0.0.1")
    return;

  // Unregister all service workers
  if ("serviceWorker" in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const reg of regs) {
      await reg.unregister();
    }
  }

  // Clear all caches
  if ("caches" in window) {
    const keys = await caches.keys();
    for (const k of keys) {
      await caches.delete(k);
    }
  }
}

// Restore draft on load
const savedDraft = localStorage.getItem(DRAFT_KEY);
if (savedDraft) {
  editorEl.value = savedDraft;
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

async function driveFetch(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    },
  });

  if (r.status === 401) {
    accessToken = null;
    resetUiForDisconnect();
    showLanding();
    setStatus("Session expired. Please reconnect to Drive.");
    throw new Error("Unauthorized");
  }

  if (!r.ok) {
    throw new Error(await r.text());
  }

  return r;
}

async function driveListAppDataFilesByName(name) {
  const q = `name='${name.replaceAll("'", "\\'")}' and trashed=false`;
  const url =
    "https://www.googleapis.com/drive/v3/files" +
    `?spaces=appDataFolder&q=${encodeURIComponent(q)}` +
    "&fields=files(id,name,modifiedTime,size)";

  const r = await driveFetch(url);
  return (await r.json()).files ?? [];
}

async function driveCreateAppDataFile(
  name,
  mimeType = "application/octet-stream",
) {
  const metadata = { name, parents: ["appDataFolder"], mimeType };

  const boundary = "-------lightjournalboundary";
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n` +
    `\r\n` +
    `--${boundary}--`;

  const r = await driveFetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
    {
      method: "POST",
      headers: {
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );

  const data = await r.json();
  return data.id;
}

async function driveDownloadFile(fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const r = await driveFetch(url);
  return await r.text();
}

async function driveUploadFile(fileId, content, mimeType = "application/json") {
  const url = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`;
  const r = await driveFetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": mimeType,
    },
    body: content,
  });
}

function openOverlay(url) {
  overlayFrame.src = url;
  overlay.style.display = "flex";
}

overlayClose.addEventListener("click", () => {
  overlay.style.display = "none";
  overlayFrame.src = "";
});

linkPrivacy.addEventListener("click", (e) => {
  e.preventDefault();
  openOverlay("./privacy.html");
});

linkInstructions.addEventListener("click", (e) => {
  e.preventDefault();
  openOverlay("./instructions.html");
});

linkTerms.addEventListener("click", (e) => {
  e.preventDefault();
  openOverlay("./terms.html");
});

function nowIso() {
  return new Date().toISOString();
}

function makeNdjsonLine(ts, md) {
  return JSON.stringify({ ts, md }) + "\n";
}

function parseNdjson(ndjson) {
  if (!ndjson) return [];
  return ndjson
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[c],
  );
}

function renderMarkdown(md) {
  const rawHtml = marked.parse ? marked.parse(md || "") : marked(md || "");
  return DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } });
}

function resetUiForDisconnect() {
  // Clear rendered sensitive content
  postsEl.innerHTML = "";
  previewEl.innerHTML = "";

  // Clear status and disable actions that require Drive/journal
  btnSave.disabled = true;

  // Optional: also clear any “loaded journal” state
  journalFileId = null;
  currentJournalName = null;
  lastLoadedPass = "";

  // Stop any pending autoload
  if (autoLoadTimer) {
    clearTimeout(autoLoadTimer);
    autoLoadTimer = null;
  }
}

function updatePreview() {
  if (!previewToggleEl.checked) {
    previewEl.innerHTML = "";
    previewEl.style.display = "none";
    return;
  }
  previewEl.style.display = "block";
  previewEl.innerHTML = renderMarkdown(editorEl.value || "");
}

function scheduleAutoLoad() {
  if (!accessToken) return;
  const pass = passEl.value;
  if (!pass) return; // passphrase required

  // if (pass === lastLoadedPass) return;

  if (autoLoadTimer) clearTimeout(autoLoadTimer);

  const mySeq = ++loadSeq;

  autoLoadTimer = setTimeout(async () => {
    try {
      const name = pass ? await journalNameForPassphrase(pass) : "journal.enc";
      const exists = await selectJournalIfExists(name);

      if (!exists) {
        // Don’t create journals just by typing.
        // Also don’t wipe existing posts.
        journalFileId = null;
        currentJournalName = name;
        btnSave.disabled = false; // allow saving to create it
        setStatus(
          "No journal yet for this passphrase. Write something and press Save to create it.",
        );
        return;
      }

      btnSave.disabled = false;
      await loadAndRender(pass);

      // Ignore stale results
      if (mySeq !== loadSeq) return;

      lastLoadedPass = pass;
      // loadAndRender sets the "Loaded..." status on success
    } catch (e) {
      // Ignore stale errors
      if (mySeq !== loadSeq) return;
      if (handleDriveAuthError(e)) return;
      setStatus("Error: " + humanError(e));
    }
  }, 350);
}

function humanError(e) {
  // WebCrypto decrypt failures are often DOMException with empty message
  const msg =
    e && (e.message || e.toString()) ? String(e.message || e.toString()) : "";

  // Common cases
  if (!msg || msg === "[object DOMException]")
    return "Wrong passphrase (or corrupted data).";
  if (msg.includes("OperationError"))
    return "Wrong passphrase (or corrupted data).";
  return msg;
}

function handleDriveAuthError(err) {
  const msg = String(err);

  // Google returns 401 or invalid_token when expired
  if (
    msg.includes("401") ||
    msg.includes("invalid_token") ||
    msg.includes("Login Required")
  ) {
    accessToken = null;
    journalFileId = null;

    setStatus("Connection expired. Please reconnect to Drive.");
    showLanding();
    return true;
  }

  return false;
}

function showLanding() {
  screenConnect.style.display = "block";
  screenMain.style.display = "none";
}

function showMain() {
  screenConnect.style.display = "none";
  screenMain.style.display = "block";
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;

  // When returning to the app, attempt to continue smoothly.
  if (!accessToken) {
    showLanding();
    return;
  }

  // If connected, try to load journal if passphrase is present.
  scheduleAutoLoad();
});

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function journalNameForPassphrase(pass) {
  // Use a short prefix so filenames stay readable; collision risk is negligible for personal use.
  const hex = await sha256Hex("lightjournal:" + pass);
  return `journal_${hex.slice(0, 16)}.enc`;
}

async function loadAndRender(passphrase) {
  if (!journalFileId) {
    throw new Error("Journal file not selected yet (enter passphrase).");
  }
  setStatus("Loading journal…");
  const encPayload = await driveDownloadFile(journalFileId);

  let plaintext = "";
  if (encPayload && encPayload.trim() !== "") {
    plaintext = await decryptString(passphrase, encPayload);
  }

  const posts = parseNdjson(plaintext);

  // Build UI off-screen first, so a wrong passphrase doesn't wipe the current view
  const frag = document.createDocumentFragment();

  for (const p of posts) {
    const dt = new Date(p.ts);

    const dateStr = dt.toLocaleString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

    const el = document.createElement("article");
    el.className = "post";
    el.innerHTML = `
    <div class="meta">${dateStr}</div>
    <div class="body">${renderMarkdown(p.md)}</div>
  `;
    frag.appendChild(el);
  }

  // Only now replace the visible list
  postsEl.innerHTML = "";
  postsEl.appendChild(frag);

  setStatus(`Loaded ${posts.length} posts ✅`);
}

async function findJournalFileIdByName(name) {
  const files = await driveListAppDataFilesByName(name);
  return files.length ? files[0].id : null;
}

async function ensureJournalFileByName(name) {
  setStatus("Checking Drive appData…");
  const files = await driveListAppDataFilesByName(name);

  if (files.length > 0) {
    journalFileId = files[0].id;
    currentJournalName = name;
    // console.log("Using journal file:", name, "id:", journalFileId);
    return;
  }

  journalFileId = await driveCreateAppDataFile(name);
  currentJournalName = name;
  // console.log("Created journal file:", name, "id:", journalFileId);
}

async function selectJournalIfExists(name) {
  const id = await findJournalFileIdByName(name);
  if (!id) return false;

  journalFileId = id;
  currentJournalName = name;
  // console.log("Using existing journal:", name, "id:", journalFileId);
  return true;
}

window.addEventListener("load", async () => {
  await devClearSwAndCaches();

  showLanding();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: async (resp) => {
      try {
        if (resp.error) {
          accessToken = null;
          setStatus("Not connected");
          showLanding();
          return;
        }

        accessToken = resp.access_token;

        showMain();
        btnSave.disabled = true;
        setStatus("Drive connected ✅ (enter passphrase)");

        scheduleAutoLoad();
      } catch (e) {
        console.error(e);
        if (handleDriveAuthError(e)) return;
        setStatus("Error: " + humanError(e));
      }
    },
  });

  btnLogin.addEventListener("click", () => {
    setStatus("Connecting to Drive…");
    tokenClient.requestAccessToken();
  });

  btnLoginLanding.addEventListener("click", () => {
    btnLogin.click();
  });

  //* setStatus("Not connected");

  btnSave.addEventListener("click", async () => {
    try {
      if (!accessToken) throw new Error("Not connected to Drive.");
      const pass = passEl.value;
      const md = editorEl.value.trim();

      if (!pass) throw new Error("Enter a passphrase first.");
      if (!md) throw new Error("Write something first.");

      const name = await journalNameForPassphrase(pass);
      await ensureJournalFileByName(name);

      btnSave.disabled = true;
      setStatus("Loading + decrypting…");

      const encPayload = await driveDownloadFile(journalFileId);

      let plaintext = "";
      if (encPayload && encPayload.trim() !== "") {
        plaintext = await decryptString(pass, encPayload);
      }

      const newLine = makeNdjsonLine(nowIso(), md);

      // Newest-first: prepend
      const updatedPlain = newLine + plaintext;

      setStatus("Encrypting…");
      const updatedEnc = await encryptString(pass, updatedPlain);

      setStatus("Uploading…");
      await driveUploadFile(journalFileId, updatedEnc, "application/json");

      localStorage.removeItem(DRAFT_KEY);

      editorEl.value = "";
      setStatus("Saved ✅");

      await loadAndRender(pass);
    } catch (e) {
      console.error(e);
      if (handleDriveAuthError(e)) return;
      setStatus("Error: " + humanError(e));
    } finally {
      btnSave.disabled = false;
    }
  });

  btnUnlock.addEventListener("click", async () => {
    try {
      if (!accessToken) throw new Error("Not connected to Drive.");

      const pass = passEl.value;
      if (!pass) throw new Error("Enter a passphrase first.");

      const name = await journalNameForPassphrase(pass);
      const exists = await selectJournalIfExists(name);
      if (!exists) {
        setStatus(
          "No journal yet for this passphrase. Write something and press Save to create it.",
        );
        return;
      }
      await loadAndRender(pass);
    } catch (e) {
      console.error(e);
      if (handleDriveAuthError(e)) return;
      setStatus("Error: " + humanError(e));
    }
  });

  btnDisconnect.addEventListener("click", () => {
    accessToken = null;
    resetUiForDisconnect();
    setStatus("Disconnected from Drive.");
    showLanding();
  });

  toggleShowPass.addEventListener("change", () => {
    passEl.type = toggleShowPass.checked ? "text" : "password";
  });

  editorEl.addEventListener("input", updatePreview);
  previewToggleEl.addEventListener("change", updatePreview);
  passEl.addEventListener("input", scheduleAutoLoad);

  // Check for autofilled passphrase after page load
  setTimeout(() => {
    if (passEl.value) {
      scheduleAutoLoad();
    }
  }, 400);

  updatePreview();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./service-worker.js")
      .catch((err) => console.error("SW registration failed:", err));
  });
}

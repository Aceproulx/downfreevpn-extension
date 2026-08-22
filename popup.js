const $ = (id) => document.getElementById(id);

const els = {
  authState: $("authState"),
  threshold: $("threshold"),
  freeOnly: $("freeOnly"),
  protocol: $("protocol"),
  platform: $("platform"),
  scanBtn: $("scanBtn"),
  scanInfo: $("scanInfo"),
  platformWrap: $("platformWrap"),
  listHead: $("listHead"),
  selectAll: $("selectAll"),
  matchCount: $("matchCount"),
  thrLabel: $("thrLabel"),
  dlBtn: $("dlBtn"),
  serverList: $("serverList"),
  progressWrap: $("progressWrap"),
  progressBar: $("progressBar"),
  progressText: $("progressText"),
  pauseBtn: $("pauseBtn"),
  cancelBtn: $("cancelBtn"),
  log: $("log"),
  error: $("error"),
};

let allServers = [];

function flagEmoji(cc) {
  if (!cc || cc.length !== 2) return "";
  return String.fromCodePoint(
    ...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)
  );
}

function showError(msg) {
  els.error.textContent = msg;
  els.error.hidden = !msg;
}

async function loadSettings() {
  const s = await chrome.storage.local.get({
    threshold: 75,
    freeOnly: true,
    protocol: "WG",
    platform: "Linux",
    folder: "servers",
    scan: null,
    checkedIds: null,
    migratedWgDefault: false,
  });

  // One-time: make WireGuard the default for existing installs
  if (!s.migratedWgDefault) {
    s.protocol = "WG";
    if (s.folder === "protonvpn-configs") s.folder = "servers";
    chrome.storage.local.set({
      migratedWgDefault: true,
      protocol: s.protocol,
      folder: s.folder,
    });
  }

  els.threshold.value = s.threshold;
  els.freeOnly.checked = s.freeOnly;
  els.protocol.value = s.protocol;
  els.platform.value = s.platform;

  updatePlatformVisibility();

  if (s.scan && Array.isArray(s.scan.servers)) {
    allServers = s.scan.servers;
    checkedIds = s.checkedIds && Array.isArray(s.checkedIds) ? s.checkedIds : null;
    renderList();
    setScanInfo(s.scan.scannedAt);
  }
}

function updatePlatformVisibility() {
  els.platformWrap.hidden = els.protocol.value === "WG";
}

let checkedIds = null; // null = default (all matching checked)

function setScanInfo(ts) {
  if (!ts) return;
  els.scanInfo.textContent = "scanned " + new Date(ts).toLocaleTimeString();
}

async function saveSettings() {
  chrome.storage.local.set({
    threshold: Number(els.threshold.value) || 75,
    freeOnly: els.freeOnly.checked,
    protocol: els.protocol.value,
    platform: els.platform.value,
  });
}

// ---- job progress (persisted in background, survives popup reopen) -------
const STALE_MS = 30000;

function jobIsStale(job) {
  return job.running && Date.now() - job.lastUpdate > STALE_MS;
}

function renderJob(job) {
  els.progressWrap.hidden = false;

  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  els.progressBar.style.width = pct + "%";

  const failedCount = (job.failed || []).length;
  const stale = jobIsStale(job);

  if (job.running && !stale) {
    els.dlBtn.disabled = true;
    els.pauseBtn.hidden = false;
    els.cancelBtn.hidden = false;
    els.pauseBtn.textContent = job.paused ? "Resume" : "Pause";
    els.progressText.textContent = job.paused
      ? `Paused — ${job.done}/${job.total}`
      : `Downloading… ${job.done}/${job.total}`;
  } else {
    els.dlBtn.disabled = false;
    els.pauseBtn.hidden = true;
    els.cancelBtn.hidden = true;

    if (job.running && stale) {
      els.progressText.textContent =
        "Interrupted (service worker restarted). You can start again.";
    } else if (job.cancelled) {
      els.progressText.textContent =
        `Cancelled at ${job.done}/${job.total}` +
        (failedCount ? `, ${failedCount} failed` : "");
    } else {
      els.progressText.textContent =
        `Done — ${job.done - failedCount} downloaded` +
        (failedCount ? `, ${failedCount} failed` : "");
    }
  }

  const started = new Date(job.startedAt).toLocaleTimeString();
  els.log.textContent =
    `[${started}] ${job.protocol} → ${job.folder}/ (${job.total} servers)\n` +
    (job.log || [])
      .map(
        (l) =>
          (l.ok ? "\u2714 " : "\u2718 ") +
          l.name +
          (l.ok ? "" : ` — ${l.error}`)
      )
      .join("\n") +
    (job.cancelled ? "\ncancelled" : "") +
    (job.running ? "\n…" : "");
  els.log.scrollTop = els.log.scrollHeight;
}

els.pauseBtn.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "pause" }).catch(() => null);
  if (!res || !res.ok) return;
  await refreshJob();
});

els.cancelBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "cancel" }).catch(() => {});
  await refreshJob();
});

async function refreshJob() {
  const { job } = await chrome.storage.local.get({ job: null });
  if (job) renderJob(job);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "progress") refreshJob();
});

// ---- server list ----------------------------------------------------------
function renderList() {
  const max = Number(els.threshold.value);
  const freeOnly = els.freeOnly.checked;
  const matches = allServers.filter(
    (s) =>
      (s.load !== null && s.load <= max) &&
      (!freeOnly || s.tier === 0)
  );

  els.matchCount.textContent = matches.length;
  els.thrLabel.textContent = max;
  els.listHead.hidden = allServers.length === 0;
  els.scanBtn.textContent = "Rescan";

  els.serverList.textContent = "";

  for (const srv of matches.sort((a, b) => a.load - b.load)) {
    const row = document.createElement("label");
    row.className = "server";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = checkedIds ? checkedIds.includes(srv.id) : true;
    cb.dataset.id = srv.id;

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `${flagEmoji(srv.exitCountry)} ${srv.name}`;

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = [srv.city, srv.domain].filter(Boolean).join(" · ");

    const load = document.createElement("span");
    load.className = "load " + (srv.load <= 50 ? "low" : "mid");
    load.textContent = srv.load + "%";

    row.append(cb, name, meta, load);
    els.serverList.appendChild(row);
  }
}

function persistChecked() {
  checkedIds = [
    ...els.serverList.querySelectorAll("input[type=checkbox]:checked"),
  ].map((cb) => cb.dataset.id);
  chrome.storage.local.set({ checkedIds });
}

els.serverList.addEventListener("change", persistChecked);

els.protocol.addEventListener("change", updatePlatformVisibility);

els.selectAll.addEventListener("change", () => {
  for (const cb of els.serverList.querySelectorAll("input[type=checkbox]"))
    cb.checked = els.selectAll.checked;
  persistChecked();
});

els.scanBtn.addEventListener("click", async () => {
  await saveSettings();
  showError("");
  els.scanBtn.disabled = true;
  els.authState.textContent = "scanning…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "scan" });
    if (!res.ok) throw new Error(res.error);
    allServers = res.servers;
    checkedIds = null; // fresh scan → all matching checked by default
    els.authState.textContent = "signed in";
    els.authState.className = "badge ok";
    const scannedAt = Date.now();
    chrome.storage.local.set({ scan: { servers: allServers, scannedAt } });
    renderList();
    setScanInfo(scannedAt);
  } catch (e) {
    els.authState.textContent = "not signed in?";
    els.authState.className = "badge bad";
    showError(e.message);
  } finally {
    els.scanBtn.disabled = false;
  }
});

els.dlBtn.addEventListener("click", async () => {
  await saveSettings();

  const { job } = await chrome.storage.local.get({ job: null });
  if (job && job.running && !jobIsStale(job)) return; // already running

  const selected = [
    ...els.serverList.querySelectorAll("input[type=checkbox]:checked"),
  ].map((cb) => allServers.find((s) => s.id === cb.dataset.id));

  if (selected.length === 0) return;

  showError("");
  await refreshJob(); // shows the fresh "Downloading… 0/N" state

  try {
    const { folder } = await chrome.storage.local.get({ folder: "servers" });
    const res = await chrome.runtime.sendMessage({
      type: "download",
      items: selected,
      protocol: els.protocol.value,
      platform: els.platform.value,
      folder,
    });
    if (!res.ok) throw new Error(res.error);
  } catch (e) {
    showError(e.message);
  } finally {
    refreshJob();
  }
});

loadSettings().then(refreshJob);

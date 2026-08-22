const API_ORIGIN = "https://account.protonvpn.com";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sanitizeName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function findProtonTabs() {
  return chrome.tabs.query({ url: API_ORIGIN + "/*" });
}

async function waitForTabComplete(tabId, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await sleep(300);
  }
  throw new Error("Timed out waiting for account.protonvpn.com tab to load");
}

// All API traffic is relayed through a content script inside an
// account.protonvpn.com tab so the request is same-origin and carries
// the session cookies (extension-initiated requests don't).
async function getRelayTab() {
  const tabs = await findProtonTabs();
  if (tabs.length) {
    const good = tabs.find((t) => !t.discarded && t.status === "complete");
    return good || tabs[0];
  }
  const tab = await chrome.tabs.create({
    url: API_ORIGIN + "/downloads",
    active: false,
  });
  await waitForTabComplete(tab.id);
  await sleep(2000); // let the app boot and settle its session
  return tab;
}

async function pingRelay(tabId, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: "ping" });
      if (r && r.pong) return true;
    } catch (_) {}
    await sleep(250);
  }
  return false;
}

async function injectRelay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["inject.js"],
      world: "MAIN",
    });
  } catch (_) {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (_) {}
}

let uidSeen = false;

async function callApi(path, opts = {}, attempt = 0) {
  let tab = await getRelayTab();

  if (tab.discarded || tab.frozen) {
    try {
      await chrome.tabs.reload(tab.id);
      await waitForTabComplete(tab.id);
      await sleep(1500);
    } catch (_) {}
    tab = await chrome.tabs.get(tab.id);
  }

  if (!(await pingRelay(tab.id))) {
    await injectRelay(tab.id);
    if (!(await pingRelay(tab.id, 5000))) {
      throw new Error(
        "Could not attach to the account.protonvpn.com tab. Refresh that tab once, then rescan."
      );
    }
  }

  const r = await chrome.tabs.sendMessage(tab.id, {
    type: "api",
    path,
    method: opts.method,
    body: opts.body,
  });
  if (!r || !r.ok) throw new Error(r && r.error ? r.error : "relay failed");

  if (!uidSeen && r.uidFound) uidSeen = true;

  // Early attempts can race the app's first API poll; retry gives inject.js
  // time to capture the real x-pm-uid. Rate limits get exponential backoff.
  if (r.status === 401 && attempt < 4) {
    await sleep(1500);
    return callApi(path, opts, attempt + 1);
  }
  if ((r.status === 429 || r.status === 503) && attempt < 5) {
    await sleep(Math.min(20000, 1500 * Math.pow(2, attempt)));
    return callApi(path, opts, attempt + 1);
  }
  return r;
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function assertApi(res) {
  let apiError = "";
  try {
    const j = JSON.parse(res.text);
    if (j.Error) apiError = j.Error;
  } catch (_) {}

  if (res.status === 401 || res.status === 403) {
    throw new ApiError(
      "Not signed in (" +
        res.status +
        (apiError ? ": " + apiError : "") +
        "). Reload the account.protonvpn.com tab, then rescan.",
      res.status
    );
  }
  if (res.status >= 400) {
    throw new ApiError(
      "HTTP " + res.status + (apiError ? ": " + apiError : ""),
      res.status
    );
  }
  return res.text;
}

async function getLogicalServers() {
  const res = await callApi("/api/vpn/v1/logicals?WithIpV6=1");
  const text = assertApi(res);
  const data = JSON.parse(text);
  if (!data.LogicalServers) {
    throw new Error(
      data.Error || "Unexpected API response (Code " + data.Code + ")"
    );
  }
  return data.LogicalServers;
}

// ---- WireGuard -------------------------------------------------------------
function b64FromBytes(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Proton registers an *Ed25519* client key; the .conf PrivateKey is the
// converted Curve25519 form: clamp(sha512(seed)[:32]) — verified identity:
// x25519_base(clamp(sha512(seed)[:32])) === montgomery_u(ed25519_pub)
async function generateWgIdentity() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
  ]);
  const edPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const seed = pkcs8.slice(-32); // PKCS#8 wrapper ends with the raw 32B seed
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-512", seed));
  const curvePriv = hash.slice(0, 32);
  curvePriv[0] &= 248;
  curvePriv[31] &= 127;
  curvePriv[31] |= 64;
  return { pubEd: b64FromBytes(edPub), priv: b64FromBytes(curvePriv) };
}

async function apiPost(path, body) {
  const res = await callApi(path, { method: "POST", body });
  return res;
}

async function ensureWgCert(firstPeer) {
  const { wgIdentity } = await chrome.storage.local.get({ wgIdentity: null });
  if (wgIdentity && wgIdentity.priv && wgIdentity.pubEd) return wgIdentity;

  const keys = await generateWgIdentity();
  const res = await apiPost("/api/vpn/v1/certificate", {
    ClientPublicKey: keys.pubEd,
    Mode: "persistent",
    DeviceName: "",
    Features: {
      Bouncing: "1",
      PortForwarding: false,
      SplitTCP: true,
      peerName: firstPeer?.name || "proton-config-dl",
      peerIp: firstPeer?.entryIp || "",
      peerPublicKey: firstPeer?.serverPubKey || "",
      platform: "Android",
    },
  });
  assertApi(res);
  await chrome.storage.local.set({ wgIdentity: keys });
  return keys;
}

function buildWgConfig(item, identity) {
  if (!item.serverPubKey || !item.entryIp) {
    throw new Error("missing server key/IP in scan data");
  }
  return [
    "[Interface]",
    "# Bouncing = 0",
    "# NAT-PMP (Port Forwarding) = off",
    "# VPN Accelerator = on",
    `PrivateKey = ${identity.priv}`,
    "Address = 10.2.0.2/32",
    "DNS = 10.2.0.1",
    "",
    "[Peer]",
    `# ${item.name}`,
    `PublicKey = ${item.serverPubKey}`,
    "AllowedIPs = 0.0.0.0/0, ::/0",
    `Endpoint = ${item.entryIp}:51820`,
    "",
    "PersistentKeepalive = 25",
    "",
  ].join("\n");
}

async function fetchConfigText(logicalId, protocol, platform, attempt = 0) {
  const path =
    "/api/vpn/v1/config?LogicalID=" +
    encodeURIComponent(logicalId) +
    "&Protocol=" +
    encodeURIComponent(protocol) +
    "&Platform=" +
    encodeURIComponent(platform);

  const res = await callApi(path);

  if ((res.status === 429 || res.status === 503) && attempt < 5) {
    await sleep(Math.min(20000, 1500 * Math.pow(2, attempt)));
    return fetchConfigText(logicalId, protocol, platform, attempt + 1);
  }

  const text = assertApi(res);
  if ((res.contentType || "").includes("application/json")) {
    const j = JSON.parse(text);
    throw new Error(j.Error || "API error Code=" + j.Code);
  }
  return text;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "scan") {
        const servers = await getLogicalServers();
        sendResponse({
          ok: true,
          servers: servers.map((s) => {
            const phys =
              Array.isArray(s.Servers) && s.Servers.length
                ? s.Servers.find((p) => p.Status === 1) || s.Servers[0]
                : null;
            return {
              id: s.ID,
              name: s.Name,
              tier: s.Tier,
              load: typeof s.Load === "number" ? s.Load : null,
              exitCountry: s.ExitCountry || "",
              city: s.City || "",
              domain: s.Domain || "",
              status: s.Status,
              entryIp: phys ? phys.EntryIP : "",
              serverPubKey: phys ? phys.X25519PublicKey : "",
            };
          }),
        });
        return;
      }

      if (msg.type === "download") {
        if (job && job.running) {
          sendResponse({
            ok: false,
            error: "A download is already in progress.",
          });
          return;
        }

        const { items, protocol, platform, folder } = msg;
        const isWg = String(protocol).toUpperCase() === "WG";
        const total = items.length;

        job = {
          running: true,
          paused: false,
          cancelled: false,
          total,
          done: 0,
          failed: [],
          log: [],
          protocol,
          platform,
          folder,
          startedAt: Date.now(),
          lastUpdate: Date.now(),
        };
        await persist();

        // WireGuard: one persistent cert covers every server (same as the
        // official apps); configs themselves are built locally.
        let identity = null;
        if (isWg) {
          try {
            identity = await ensureWgCert(items[0]);
          } catch (e) {
            job.running = false;
            job.finishedAt = Date.now();
            await persist();
            sendResponse({ ok: false, error: "Certificate failed: " + e.message });
            return;
          }
        }

        for (const item of items) {
          if (job.cancelled) break;
          while (job.paused && !job.cancelled) await sleep(200);
          if (job.cancelled) break;

          let text, fname;
          if (isWg) {
            fname = "wg-" + String(item.name).replace(/#/g, "-") + ".conf";
          } else {
            const label = sanitizeName(item.name);
            fname = `${label}_${String(protocol).toLowerCase()}_load${item.load ?? "?"}.conf`;
          }
          try {
            if (isWg) {
              text = buildWgConfig(item, identity);
            } else {
              text = await fetchConfigText(item.id, protocol, platform);
            }
            await chrome.downloads.download({
              url:
                "data:application/octet-stream;base64," + toBase64Utf8(text),
              filename: `${folder}/${fname}`,
              conflictAction: "uniquify",
              saveAs: false,
            });
            job.log.push({ ok: true, name: fname });
            notify({ type: "progress", ok: true, name: fname, load: item.load, done: ++job.done, total });
          } catch (e) {
            job.failed.push({ name: fname, error: e.message });
            job.log.push({ ok: false, name: fname, error: e.message });
            notify({ type: "progress", ok: false, name: fname, load: item.load, error: e.message, done: ++job.done, total });
          }
          job.lastUpdate = Date.now();
          await persist();
          await sleep(250);
        }

        const wasCancelled = job.cancelled;
        job.running = false;
        job.paused = false;
        job.finishedAt = Date.now();
        await persist();

        sendResponse({
          ok: true,
          total,
          cancelled: wasCancelled,
          done: job.done,
          failedCount: job.failed.length,
          failed: job.failed,
        });
        return;
      }

      if (msg.type === "pause" || msg.type === "resume") {
        if (job && job.running) {
          job.paused = msg.type === "pause";
          job.lastUpdate = Date.now();
          await persist();
        }
        sendResponse({ ok: true, running: !!(job && job.running), paused: !!(job && job.paused) });
        return;
      }

      if (msg.type === "cancel") {
        if (job && job.running) {
          job.cancelled = true;
          job.paused = false;
          job.lastUpdate = Date.now();
          await persist();
        }
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type" });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();

  return true; // async response
});

function notify(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {});
}

// ---- persistent job state (survives popup close & SW restarts) ------------
let job = null;

async function persist() {
  await chrome.storage.local.set({ job });
}

chrome.storage.local.get({ job: null }).then((v) => {
  job = v.job;
});

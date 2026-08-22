const API_ORIGIN = "https://account.protonvpn.com";

function findUid() {
  // published by inject.js (MAIN world hook on the app's own requests)
  try {
    const attr = document.documentElement.getAttribute("data-pvpn-uid");
    if (attr) return attr;
  } catch (_) {}

  const cm = document.cookie.match(/AUTH-([A-Za-z0-9_-]{8,64})=/);
  if (cm) return cm[1];

  for (const store of [localStorage, sessionStorage]) {
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (/uid/i.test(k)) {
          const m = (store.getItem(k) || "").match(/[A-Za-z0-9_-]{16,64}/);
          if (m) return m[0];
        }
      }
    } catch (_) {}
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "ping") {
    sendResponse({ pong: true });
    return;
  }

  if (msg.type !== "api") return;

  (async () => {
    try {
      const headers = {
        Accept: "application/vnd.protonmail.v1+json",
        "x-pm-appversion": "web-vpn-settings@5.0.353.0",
      };
      const uid = findUid();
      if (uid) headers["x-pm-uid"] = uid;

      const init = {
        method: msg.method || "GET",
        credentials: "include",
        headers,
      };
      if (init.method === "POST") {
        headers["Content-Type"] = "application/json";
        headers["Origin"] = API_ORIGIN;
        init.body = JSON.stringify(msg.body || {});
      }

      const res = await fetch(API_ORIGIN + msg.path, init);
      const ct = res.headers.get("content-type") || "";
      sendResponse({
        ok: true,
        status: res.status,
        contentType: ct,
        uidFound: !!uid,
        text: await res.text(),
      });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true; // async
});

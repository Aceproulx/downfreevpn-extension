// MAIN world — only job: capture the app's own x-pm-uid and publish it
// through a DOM attribute (visible to the isolated-world relay).
(function () {
  if (window.__pvpnHook) return;
  window.__pvpnHook = true;

  let pending = null;

  function publish(uid) {
    if (!uid) return true;
    const el = document.documentElement;
    if (el) {
      el.setAttribute("data-pvpn-uid", uid);
      return true;
    }
    pending = uid; // document.documentElement not ready yet (document_start)
    return false;
  }

  document.addEventListener("readystatechange", () => {
    if (pending) publish(pending);
  });

  const isApiUrl = (u) =>
    typeof u === "string" &&
    (/^https?:\/\/[^/]*protonvpn\.com\/api\//.test(u) ||
      u.startsWith("/api/"));

  function extract(headers) {
    if (!headers) return null;
    if (typeof Headers !== "undefined" && headers instanceof Headers) {
      return headers.get("x-pm-uid");
    }
    if (Array.isArray(headers)) {
      const found = headers.find(([k]) => /^x-pm-uid$/i.test(k));
      return found ? found[1] : null;
    }
    for (const k in headers) {
      if (/^x-pm-uid$/i.test(k)) return headers[k];
    }
    return null;
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (isApiUrl(typeof input === "string" ? input : input && input.url)) {
        const v =
          extract(init && init.headers) ||
          (input && typeof input === "object" ? extract(input.headers) : null);
        if (v) publish(v);
      }
    } catch (_) {}
    return origFetch.apply(this, arguments);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__pvpnUrl = url;
    return origOpen.apply(this, arguments);
  };
  const origSetHdr = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (/^x-pm-uid$/i.test(name) && isApiUrl(this.__pvpnUrl)) publish(value);
    } catch (_) {}
    return origSetHdr.apply(this, arguments);
  };
})();

# ProtonVPN Config Downloader (Chrome Extension)

Bulk-download ProtonVPN server configs — **WireGuard `.conf`** files (the ones the
downloads page generates via its "Create" button) or OpenVPN UDP/TCP — filtered by
server load, straight into your Downloads folder.

Built for the workflow: grab every free server running under a load threshold
(e.g. ≤ 75%) without clicking one-by-one.

## Features

- **Load filter** — only servers at or under your threshold (default 75%)
- **Free-only toggle** — Tier 0 servers only
- **WireGuard mode (default)** — registers one persistent device certificate,
  then builds every `wg-<SERVER>.conf` locally from live scan data
- **OpenVPN mode** — pulls per-server `.conf`/`.ovpn` configs (UDP/TCP, any platform)
- **Background jobs** — downloads continue if you close the popup; reopen it to see
  live progress or the final log
- **Pause / Resume / Cancel** for running jobs
- **Persistent state** — last scan results, your selection, and job history survive popup closes
- Rate-limit aware — automatic exponential backoff on 429/503

## Install

1. Clone or download this repo
2. Open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** → select this folder

## Use

1. Log into [account.protonvpn.com/downloads](https://account.protonvpn.com/downloads)
   in Chrome (the extension reuses that session through a same-origin relay)
2. Click the extension icon
3. Set max load %, keep **WireGuard (.conf)** selected, hit **Scan servers**
4. Adjust selection → **Download .conf**

Files land in `Downloads/servers/` as `wg-US-FREE-2.conf`, etc.

## How it works

All API traffic is relayed through a content script injected into your open
`account.protonvpn.com` tab, so requests are same-origin and carry your real
session cookies + `x-pm-uid` header (the extension captures it by hooking the
page's own fetch/XHR calls).

| Endpoint | Purpose |
|---|---|
| `GET  /api/vpn/v1/logicals` | Server list (name, load, tier, entry IP, public key) |
| `POST /api/vpn/v1/certificate` | Register Ed25519 client key → persistent cert |
| `GET  /api/vpn/v1/config` | OpenVPN config per logical server |

Key scheme (verified against RFC 8032/7748 identities):
- Registers a raw **Ed25519** public key with Proton
- Writes `PrivateKey = clamp(SHA-512(seed)[:32])` into each config — the standard
  Edwards→Montgomery conversion, so handshakes work with stock WireGuard

## Notes

- One persistent certificate is created and reused across runs (shows up in your
  Proton account devices). Delete it there + reload the extension to regenerate.
- Chrome will ask once to allow multiple downloads — accept.
- Free accounts: only Tier 0 servers are connectable.

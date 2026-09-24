> Run notes copied from the test box on 24 Sep 2026 (Europe/Brussels). Paths refer to the box layout. Logs, wallet files and secrets mentioned here are not in this repo. Secret paths are redacted.

# sixpack.wtf faucet probe (TN10)

Date: 2026-09-24 (Europe/Brussels)

## Surface
- Page: https://sixpack.wtf/faucet.html (static GitHub Pages)
- JS: `faucet.js` → `window.FAUCET_API` Cloudflare quick-tunnel origin
- **Not browser-only**: real JSON HTTP API; **no captcha** observed

## Endpoints
- `GET /api/faucet` → network, dripTkas, capTkas, faucetBalanceTkas, from
- `GET /api/faucet?address=kaspatest:...` → remaining for address/IP window
- `POST /api/faucet` body `{"address":"kaspatest:...","amount":"30000"}`
- `GET /api/faucet?job=<id>` while `pending`

## Limits
- dripTkas = 30000, capTkas = 30000, windowHours = 24
- Cap applies per IP **and** per address
- After one successful claim from this box IP: remaining 0 for ~24h
- Requesting amount=150 still credited **30000** tKAS (drip size wins)

## Captcha / auth
- None on page or API (only `Bypass-Tunnel-Reminder` for tunnel interstitial)

## Implication for 200×100
- Faucet **treasury** (~5M tKAS) is enough for Phase A
- **Public API** only yields 30k tKAS / desk IP / day ≈ 7–8 wallets at 4k each
- Need: multi-day claims, more IPs, or desk faucet coordination (pay-from wallet / unlimited)

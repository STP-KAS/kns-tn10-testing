> Copied from the test box. The KasWare HTML page mentioned below (`docs/kasware-create-tn10.html`) is not published here: this desk does not ship wallet integrations. The KasWare UI path was never verified on the box (extension not installed).

# KasWare create HTML flow (TN10)

Adapted from STP-KAS/kns-spec `docs/kasware-create.html` / `kasware.html` and KasWare vendor KRC20/KNS docs. kns-spec markdown wallet pages are withdrawn; HTML examples remain useful.

## Flow

1. User enters **label** (no `.kas`).
2. UI builds payload: `JSON.stringify({ op: "create", p: "domain", v: label })`.
3. **Check:** `POST https://api.knsdomains.org/tn10/api/v1/domains/check` with `{ domainNames: [label+".kas"], address }`.
4. **buildScript:** `await window.kasware.buildScript({ type: "KNS", data: payload })` → `{ script, p2shAddress }` (safe, no popup).
5. **Commit:** spend UTXOs → output to `p2shAddress` (example amount **1 KAS**), change back, `priorityFee` ~0.01 KAS.
6. **Reveal:** spend P2SH; **output 0** = KNS fee sink + price; change back; `priorityFee` ~0.02 KAS.
7. Call `submitCommitReveal(commit, reveal, script, "testnet-10")`. Inscription id ≈ `${revealIds[0]}i0`.

## TN10 substitutions vs mainnet HTML in kns-spec

| Item | Mainnet example | TN10 |
|------|-----------------|------|
| Check API | `api.knsdomains.org/mainnet/...` | `api.knsdomains.org/tn10/...` |
| Fee address | `kaspa:qyp4nvaq…` | `kaspatest:qq9h47etjv6x8jgcla0ecnp8mgrkfxm70ch3k60es5a50ypsf4h6sak3g0lru` |
| `networkId` arg | `"mainnet"` | `"testnet-10"` |
| KasWare network | mainnet | testnet-10 |

## Price (grapheme length)

1–2: 4200 · 3: 2100 · 4: 525 · 5+: **35** KAS (plus ~5% headroom).

## Working page in this tree

Open `docs/kasware-create-tn10.html` in a browser with the KasWare extension (Chrome/Android; not iOS). Do not call `requestAccounts()` on page load (vendor guidance).

## Smoke payer

Use the **backup funded** account in KasWare (primary file address is 0 TKAS). Confirm the extension’s active address matches the intended payer before reveal.

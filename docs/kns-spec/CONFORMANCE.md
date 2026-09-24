# Web4-ready `.kas` — what to ship

This is the implementer contract. Official KNS owns the indexer and profile inscriptions. Wallets own the UI. This kit is the shared checklist.

Official: [inscriptions](https://kns-2.gitbook.io/kns-docs-1/inscriptions/overview) · [wallets](https://kns-2.gitbook.io/kns-docs-1/supporting-wallet) · [indexer API](https://kns-2.gitbook.io/kns-docs-1/kns-indexer-api) · [integration note](https://kns-2.gitbook.io/kns-docs-1/kns-indexer-api/integration-important-note)

Schema: [`schemas/overlay-records.schema.json`](schemas/overlay-records.schema.json)  
Vectors: [`schemas/vectors.json`](schemas/vectors.json)  
Proposed profile keys: [`PROFILE.md`](PROFILE.md)

## MUST (or you are not KNS-compatible)

1. **URL-encode** every domain in API paths.
2. **Normalize** with [`@adraffy/ens-normalize`](https://www.npmjs.com/package/@adraffy/ens-normalize) (UTS-46). Reject what it rejects.
3. **Price with graphemes**, not `string.length`. Use [`graphemer`](https://www.npmjs.com/package/graphemer). Official: `🏳️‍🌈` is **1**. UTF-16 length is wrong.
4. **Check** `POST /api/v1/domains/check` before every create. A losing reveal still pays.
5. **Reveal output 0** pays `kaspa:qyp4nvaq3pdq7609z09fvdgwtc9c7rg07fuw5zgeee7xpr085de59eseqfcmynn` the table fee.
6. Wallet holds **domain × 1.05** KAS (text × 2) or inscribe fails “insufficient funds”.
7. Show this **exact class of warning** before sending to a resolved name:

> ⚠️ Before sending a transaction, please ensure that the resolved address is correct. Once a transfer is sent, it cannot be reversed. Any input errors may result in the loss of assets. Please verify carefully.

8. Show the **resolved `kaspa:` address**, not only the name.
9. **No ECDSA** addresses.
10. If the receiver is **not** a [supporting wallet](https://kns-2.gitbook.io/kns-docs-1/supporting-wallet), the domain will not be visible there and cannot be transferred out. Say so.
11. Kastle **mobile cannot inscribe**. Kastle **extension** can (two popups).

## SHOULD (Web4-ready)

12. Index these **profile keys** (each still a text inscription, same as website): `ipfs`, `kfs`, `contenthash`, `peer`, `onion`, `agent`, `kas`.
13. Resolve app bytes in order: `redirectUrl` → `website` → `ipfs` → `kfs` → `arweave` → `contenthash`.
14. Support `kns://alice.kas`, `/pay`, `/peer`. `https://alice.kas.limo` is optional and **leaks DNS**.
15. Fetch IPFS/KFS and **run the dApp on the user device**. Do not make Cloudflare the source of truth.
16. Authenticate overlay sessions with the name’s schnorr key (or `noise` record).
17. Offer **local resolve** via [simply-kaspa-indexer](https://github.com/supertypo/simply-kaspa-indexer) so a user is not forced through `api.knsdomains.org`.
18. Primary name (reverse): `GET /api/v1/primary-name/{owner}` — already in the official API. **Display it only if Domain API owner == that address** (ENS reverse rule).
19. One-shot resolve payload for wallets: `{ domain, owner, addr, primary, verified, records }` so clients stop N+1 calling Profile + Domain + Primary.
20. `kns://` **run** order is `ipfs` → `kfs` → `contenthash` only. Do not iframe `website` / `redirectUrl` as the dApp (that reintroduces CAs).
21. Default overlay rendezvous is a **capability**, not a public `/ip4/` multiaddr. Public `peer` is opt-in shop-window.
22. On domain transfer, offer **clear profile** so the buyer does not inherit Telegram/X.

## MUST NOT

- Claim consensus uniqueness of `.kas`. Indexer FCFS.
- Treat L1 multi-dot (`abc.def.kas`) as a parent-child subdomain.
- Ask for a seed.
- Publish `peer` on the public indexer and call it private. Public peer is a billboard. Private rendezvous uses `vault` / a capability.

## KNS product work (indexer + dashboard)

This is the one change that unlocks Web4 without a hard fork:

1. Add the SHOULD keys to **Edit Profile** (one text inscription each, 1 KAS).
2. Return them from **Profile API** (`?keys=` already exists).
3. Document them next to website / redirectUrl.
4. Keep existing keys. Do not break `.limo`.

Wallets then resolve `kns://` with no new consensus.

## Prove you did it

```powershell
go test ./...
go run ./cmd/kns-spec prove
go run ./cmd/kns-spec overlay kns.kas
go run ./cmd/kns-spec vectors
```

# The whole scheme (no theater)

`.kas` is a **human label** stored as a Kaspa inscription and **interpreted by an indexer**. It is not a new internet, not consensus uniqueness, and not private.

Live today: type `kns.kas` in a supporting wallet → indexer returns a `kaspa:` address → you send KAS. Profile fields (website, X, …) are extra inscriptions. [open.html](https://stp-kas.github.io/kns-spec/open.html) shows that split. `run` is empty until someone publishes an `ipfs://` CID.

Local host (this PC): `go run ./cmd/kns-spec serve` → http://127.0.0.1:8083/open.html — not GitHub, not a wallet.

## What is real vs paper

| Real | Paper (do not sell as shipped) |
| --- | --- |
| Inscription envelope `kns` + FCFS indexer | Nodes rejecting a second `alice.kas` |
| KasWare / Kastle ext / Kurncy / Kasanova | Every browser speaking `kns://` |
| `website` / `redirectUrl` / `.kas.limo` | Content-addressed dApp runtime |
| This kit’s snapshot + warning | Noise sessions, macaroons, mixnets |
| `KasName.sil` as a **lock** on some KAS | That lock making the label unique |
| Official API at api.knsdomains.org | Trustless resolve without their host |

`covenant_id` is hashed from an **outpoint**. It does not contain the name. A P2SH that *says* alice is still just a script hash.

## The scheme is mostly not crypto

```
Person
  → Wallet UI          (KasWare etc. — this is 90% of ENS)
  → Resolver           (their API, or your copy of the same rules)
  → Show kaspa: + warn (safety — required, not optional)
  → Normal HTTPS site  (today)  OR  CID on IPFS (if they add the key)
  → Normal KAS send    (money)
  → Pin / host / cache (ops: Pinata, kubo, a VPS — not L1)
```

Kaspa’s job is: **timestamp the inscription, move KAS, optionally lock a UTXO**.  
Everyone else’s job is: **agree how to read it, show the address, host the bytes, not leak lookups**.

## Solutions beyond the chain (do these)

1. **Wallet chrome** — Primary name on receive QR and send box. Paste `bob.kas`, show `kaspa:q…` before sign. This is how ENS won, not contenthash.
2. **One-shot `/resolve`** — one JSON for owner + payee + records. Wallets stop N+1 calls. Product API, not a fork.
3. **Reproducible indexer** — write the FCFS rules so a third party with [simply-kaspa-indexer](https://github.com/supertypo/simply-kaspa-indexer) gets the same owner. Until then uniqueness is “trust knsdomains.org.” That is a **spec + ops** problem.
4. **Pin the site** — if they add `ipfs`, someone must pin the CID. Default: user pins, or a pin service. L1 will not host the app.
5. **Don’t log lookups** — wallet talks to a user-set indexer or a local node. Public resolve APIs see every name you type (same as Infura / UD).
6. **Don’t inscribe email** — profile text is permanent and public. Hide email; use website + `.well-known/kas.json` as a *hint*. Ownership stays the inscription.
7. **Clear profile on transfer** — sold names must not keep the seller’s Telegram. Dashboard checkbox. Social, not consensus.
8. **`.kas.limo` is a gateway** — keep it for people with a normal browser. Do not call it decentralized. It needs DNS and a CA. When it dies, HTTPS names die; inscriptions remain.
9. **Payee ≠ owner** — `kas` record so the vault that holds the name is not the hot receive address. One extra text field.
10. **Browser extension / PWA** — intercept `*.kas` or `kns://` in software you ship. No ICANN petition. No L2. Chrome extension is the actual “new layer.”

## What not to build next

- A Kaspa EVM “so dApps can run.”
- Mixing spend-key Schnorr with libp2p ECDSA and calling it one identity.
- Public `/ip4/` on the inscription and calling it privacy.
- Marketing covenants as unique `.kas`.
- Rent. KNS already got that right: pay once.

## Monday for KNS (still no fork)

Add profile keys `ipfs` and `kas`. Return them from Profile API. KasWare: primary name + show address. Publish FCFS in one page. That is the whole scheme getting real. The rest of WEB4.md is a map, not a product.

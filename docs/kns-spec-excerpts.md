> Excerpts of [STP-KAS/kns-spec](https://github.com/STP-KAS/kns-spec) (commit `5cb0e6f`), kept as reference. Relative links inside point at files in that repo.

===== README.md =====
> **Experimental only. Not a product.** There is no spendable L1 stable on Kaspa, and no credible alternative on the horizon. Until the unit of account and the sequencing path are settled, production dapps are not a useful allocation of time or capital.
>
> Do not use wallet integrations on this GitHub. STP remains a clown. [DISCLAIMER.md](DISCLAIMER.md)

# KNS implementer kit

**URL for the KNS team:** https://stp-kas.github.io/kns-spec/

Letter in this repo: [FOR-KNS.md](FOR-KNS.md).

For the KNS team and wallets. Two objects. Do not mix them.

| Layer | On chain today | Uniqueness | Wallet |
| --- | --- | --- | --- |
| **Inscription** | `kns` commit-reveal envelope | Official indexer, first valid reveal | **KasWare** `buildScript({ type: "KNS" })` |
| **Covenant** | P2SH of `KasName.sil` | **Not** consensus. Script-hash lock only | Fund / later spend the P2SH |

Live uniqueness of `alice.kas` is still the [KNS indexer](https://api.knsdomains.org/mainnet). A KIP-20 `covenant_id` is hashed from an outpoint. It does not encode the label. Anyone can genesis another UTXO that writes `alice` in state. Nodes accept both.

Sister demo (Web4 UI, not this spec): [STP-KAS/kns](https://github.com/STP-KAS/kns).

## Implement this

Official docs: [inscriptions](https://kns-2.gitbook.io/kns-docs-1/inscriptions/overview) · [wallets](https://kns-2.gitbook.io/kns-docs-1/supporting-wallet) · [indexer API](https://kns-2.gitbook.io/kns-docs-1/kns-indexer-api) · [simply-kaspa-indexer](https://github.com/supertypo/simply-kaspa-indexer)

**Keep it real:** [`REAL.md`](REAL.md) — what is live vs paper, and the non-crypto work (wallet chrome, indexer spec, pinning, no lookup logs). Architecture map (not shipped): [`WEB4.md`](WEB4.md).

1. **Inscribe** with a [supporting wallet](WALLETS.md). KasWare ([`KASWARE.md`](KASWARE.md)) or Kastle **extension** ([`KASTLE.md`](KASTLE.md)). Kastle **mobile cannot inscribe**. Envelope: [`PROTOCOL.md`](PROTOCOL.md). Check the indexer first ([`INDEXER.md`](INDEXER.md)).
2. **Resolve** with `api.knsdomains.org`. URL-encode names. Warn before sending KAS to a resolved address.
3. **Optional elevate** to a Name UTXO: compile [`contracts/v1/KasName.sil`](contracts/v1/KasName.sil) with official **silverc v1.0.0** (Ori, 9 Sep 2026). Own-UTXO only. Continuation keeps the same sompi (fees from a sibling input). No `readInputState` of a foreign covenant ([silverscript#234](https://github.com/kaspanet/silverscript/pull/234) still unmerged). Battle-test notes: [`BATTLETEST.md`](BATTLETEST.md).

```powershell
go test ./...
go run ./cmd/kns-spec prove
go run ./cmd/kns-spec check kns.kas
go run ./cmd/kns-spec plan example
go run ./cmd/kns-spec resolve kns.kas
go run ./cmd/kns-spec overlay kns.kas
go run ./cmd/kns-spec vectors
go run ./cmd/kns-spec bind alice.kas <xonly> <noise-x25519>
go run ./cmd/kns-spec serve
# http://127.0.0.1:8083/open.html
```

## Proven mainnet txs

Checked 2026-09-08 against `api.kaspa.org`, `api.knsdomains.org`, and `indexer.kaspa.com` (the API behind [covenants.kaspa.com](https://covenants.kaspa.com/covenants)).

### 1. KNS inscription (KasWare-compatible envelope)

`kns.kas` reveal spends a P2SH whose redeem script is:

```
<xonly_pubkey> OP_CHECKSIG OP_FALSE OP_IF <kns> <0> <{"op":"create","p":"domain","v":"kns"}> OP_ENDIF
```

| | |
| --- | --- |
| name | `kns.kas` |
| inscription id | `223233acf8e5abea9291627a5edd859439c4553100c71309b86599f02414a532i0` |
| reveal tx | [explorer](https://explorer.kaspa.org/txs/223233acf8e5abea9291627a5edd859439c4553100c71309b86599f02414a532) |
| owner | `kaspa:qzt9yuqceqvt2vk9dz7ddzayaa5flnenkymec59xvzm55ln3k72vgecxjhnjp` |
| created | 2025-01-27 |

That reveal is a **pubkey spend with a `kns` envelope**, not a Toccata covenant program. The covenant explorer has no row for this tx. The indexer does.

### 2. Covenant deploys on covenants.kaspa.com

These are **unrevealed P2SH deploys**. Explorer action = `deploy`, status = `unrevealed`, identity = `scriptHashFallback` (no KIP-20 `covenant_id` on the UTXO yet). First output is the name lock.

| Name | KAS | Tx | Covenant |
| --- | ---: | --- | --- |
| bakery.kas | 0.5 | [095622d4…](https://covenants.kaspa.com/tx/095622d4aa4f46cac8a4012d289ed78a7bd16e9acd47d7e94ee17ae0d601f1ca) | [9baa5cb8…](https://covenants.kaspa.com/covenants/9baa5cb8f06876c1ba858c844e03d5d02da0419673761d4dea88e21c2432a685) |
| michelleobamaisaman.kas | 100 | [abf7d9e1…](https://covenants.kaspa.com/tx/abf7d9e1199e7d3c2fd7121b261aa3284eb062a19e5c2f1afefc0257f2d61c2d) | [f7fbf09a…](https://covenants.kaspa.com/covenants/f7fbf09ab0c90eb89228528590fa08ca4eb4e1ce73d62db57fb85f5626c69fd6) |
| trump.kas | 100 | [22ca97e1…](https://covenants.kaspa.com/tx/22ca97e171336859031fdc12c649e50711c330a43a7c8350f7038ab75abb1084) | [5a13bcd0…](https://covenants.kaspa.com/covenants/5a13bcd0132897fbd946853544c91ce9c3a57b1c7dfb9ce69c54bb3e745f37b1) |
| opus.kas | 100 | [bb8e054d…](https://covenants.kaspa.com/tx/bb8e054d8cf3f9f75dc99d76910669b48c8cff36d9d1fe1b378a007c653fadf3) | [72c55a09…](https://covenants.kaspa.com/covenants/72c55a09aea7f15bfad99d1efc148597bc4eead8fd53d07627f187942d99ea51) |
| opus.dei.kas | 100 | [34d410ef…](https://covenants.kaspa.com/tx/34d410ef5df5d75256334f6521c62f1654c624987e5ac0c049ed68c54061e7b7) | [6f7b81bd…](https://covenants.kaspa.com/covenants/6f7b81bdf9269b7edf495065630b2ec9c79b6143f27fff0c8101988ca7602084) |

`trump.kas` and `bakery.kas` already exist as **KNS inscriptions owned by other keys**. The P2SH above is a second object. `opus.kas` has no inscription (indexer: domain not found). Subnames (`opus.dei.kas`) are not an inscription op.

Machine-readable: [`proofs/proofs.json`](proofs/proofs.json). Re-check: `go run ./cmd/kns-spec prove`.

## What this repo is not

- Not the official KNS product ([app.knsdomains.org](https://app.knsdomains.org), [@knsdomain](https://x.com/knsdomain)).
- Not a deployed global registrar. No consensus uniqueness for `.kas`.
- Not a seed prompt. Never ask for a seed.

## License

MIT. Inscription protocol belongs to KNS. `KasName.sil` is compiled with official **silverc v1.0.0** (`3ed9733`, Ori / someone235). Template hash `c8c06c1abe007e97f78b3f1701a443a41f54c65b878113c0d6cf3ed4b47fa79b` (value-conservation + transfer clears pay/vault). Windows zip SHA256 `3e0d660c15a9e7ac90f3960da24d348b076b1891481bfe758db18accc8a102e1`.

===== KASWARE.md =====
# Withdrawn

KasWare integration notes were removed on 17 Sep 2026.

Do not use wallet integrations on this GitHub. STP remains a clown. This is a delusional desk, not a wallet kit.

Someone posts a Kaspa GitHub link and says it shipped. Open the link. Does it show a proposal, a development branch, a release, or an activation announcement? Then check the software you use. If the feature needs wallet support, a node release alone will not put it in your wallet.

Pay path: QR / `kaspa:` URI / paste a txid on your own stack. Never a seed.

===== PROTOCOL.md =====
# Inscription protocol

Source of truth (official):

- Inscriptions: https://kns-2.gitbook.io/kns-docs-1/inscriptions/overview
- Ops: https://kns-2.gitbook.io/kns-docs-1/inscriptions/operations
- Indexer API: https://kns-2.gitbook.io/kns-docs-1/kns-indexer-api
- Integration: https://kns-2.gitbook.io/kns-docs-1/kns-indexer-api/integration-important-note
- Wallets: https://kns-2.gitbook.io/kns-docs-1/supporting-wallet
- L1 indexer used by the resolver: https://github.com/supertypo/simply-kaspa-indexer

This file is the copy a wallet can implement without hunting. Wallets: [`WALLETS.md`](WALLETS.md). Indexers: [`INDEXER.md`](INDEXER.md). Overlay (`kns://`): [`OVERLAY.md`](OVERLAY.md).

## Envelope

Protocol id: `kns`. Commit-reveal P2SH. Same family as KRC-20.

```
<xonly_pubkey> OP_CHECKSIG OP_FALSE OP_IF <kns> <0> <payload> OP_ENDIF
```

KasWare builds this with `buildScript({ type: "KNS", data })`. Hardware (Tangem) uses ECDSA instead of Schnorr; the envelope is the same.

Mime / file inscriptions use a different inner layout (`OP_1 OP_1 <mime> <0> <hex>`). Domain ops below are JSON.

Max envelope 520 bytes. Label max 255 chars. ENS-normalize (`@adraffy/ens-normalize`). Visual length for price is grapheme length (`graphemer`). Emoji domains cannot be priced with UTF-16 `length`.

## Ops

| op | payload | When |
| --- | --- | --- |
| create | `{"op":"create","p":"domain","v":"<label>"}` | Register. `s` optional TLD, default `kas`. |
| transfer | `{"op":"transfer","p":"domain","id":"<inscriptionId>","to":"<kaspa addr>"}` | Owner change. `p` may be omitted for non-domain assets. |
| list | `{"op":"list","p":"domain","id":"<inscriptionId>"}` | Marketplace listing. |
| send | `{"op":"send","id":"<inscriptionId>"}` | Fill a listing. Previous outpoint must be a valid list. |

`p` is `"domain"`. `v` is the label **without** `.kas`. Compact JSON (`JSON.stringify(obj, null, 0)`).

Create of `example.kas`:

```json
{"op":"create","p":"domain","v":"example"}
```

Proven on mainnet: `kns.kas` used exactly `{"op":"create","p":"domain","v":"kns"}` in reveal `223233acf8e5abea9291627a5edd859439c4553100c71309b86599f02414a532`.

## Fees (reveal output 0)

Pay the protocol address **as output 0 of the reveal**.

| Network | Address |
| --- | --- |
| mainnet | `kaspa:qyp4nvaq3pdq7609z09fvdgwtc9c7rg07fuw5zgeee7xpr085de59eseqfcmynn` |
| tn10 | `kaspatest:qq9h47etjv6x8jgcla0ecnp8mgrkfxm70ch3k60es5a50ypsf4h6sak3g0lru` |

| Visual length | KAS |
| --- | ---: |
| 1–2 | 4200 |
| 3 | 2100 |
| 4 | 525 |
| 5+ | 35 |
| text inscription | 1 |

No renewal. First-come, first-served. Check availability **before** inscribing.

Wallet must hold extra KAS or inscribe fails “insufficient funds”: **domain × 1.05**, **text × 2** (unused extra is refunded).

Numeric clubs (official): 99 = `0.kas`–`99.kas` (leading zeros excluded except `0.kas`); 999 = `100`–`999`; 10k = `1000`–`9999`.

Reserved list (launch merkle root `09f78e4cc57ef2837e2d364b359f88da58c19b64cd79cdb1655b996ef14afcf7`): https://kns-2.gitbook.io/kns-docs-1/others/reserved-list

KNS does **not** support ECDSA addresses.

`POST https://api.knsdomains.org/mainnet/api/v1/domains/check` `{ "domainNames": ["example.kas"], "address": "<payer>" }`

## Resolve

URL-encode the name.

```
GET  /api/v1/{domain}/owner
GET  /api/v1/assets?owner=&asset=&type=domain
GET  /api/v1/asset/{assetId}/detail
GET  /api/v1/domain/{assetId}/profile?keys=redirectUrl,bio,avatarUrl,website,x,github,telegram,discord,email,banner
GET  /api/v1/primary-name/{owner}
POST /api/v1/domain/primary-name
```

Bases: `https://api.knsdomains.org/mainnet` and `/tn10`. OpenAPI: `https://apidoc.knsdomains.org/mainnet/`.

Before sending KAS to a resolved name, show: the address is indexer-derived, not consensus. Verify it. Transfers cannot be reversed.

## Profile

Each field is a **separate text inscription** (1 KAS), not a domain JSON op. Fields: avatar, website, banner, x, github, telegram, discord, email, redirectUrl, bio. They follow the domain on transfer. Same envelope, payload is the raw field text (or the value the indexer documents for that key).

## What inscription KNS cannot do

- Hierarchical subnames. L1 **will** inscribe multi-dot strings (`abc.def.kas`) as a **flat** asset. Official FAQ: that is not a parent-child subdomain. Only a later contract registrar can issue real subnames from `def.kas`.
- Consensus uniqueness. A second valid reveal for the same label is ignored by the indexer, not rejected by nodes.
- Store records in a UTXO. That is the covenant layer (`KasName.sil`).

## Covenant name UTXO (optional)

`KasName.sil` is **Silverscript v1.0.0**, one contract (not Argent). Constructor: owner pubkey + `sha256("kns/v1/" || label)`. Continuation **keeps the same sompi**; pay miner fees from a sibling P2PK input. `validateOutputState` does not lock amount by itself (official v1 tutorial).

===== INDEXER.md =====
# Indexers (official)

Two different machines. Do not mix them.

| Job | URL | What it is |
| --- | --- | --- |
| **KNS name resolver** | https://api.knsdomains.org/mainnet · TN10 `/tn10` | Official KNS indexer API: owner, check, profile, primary name. OpenAPI: https://apidoc.knsdomains.org/mainnet/ |
| **L1 block/tx indexer** | https://github.com/supertypo/simply-kaspa-indexer | Rust PostgreSQL indexer. KNS docs: “The KNS Resolver utilizes Supertypo’s Simply-Kaspa-Indexer.” |
| **Docs** | https://kns-2.gitbook.io/kns-docs-1/kns-indexer-api | Asset, detail, domain, check, profile, primary. |
| **Integration rules** | https://kns-2.gitbook.io/kns-docs-1/kns-indexer-api/integration-important-note | URL-encode names. Graphemer for fees. `@adraffy/ens-normalize`. Resolve warning. |

simply-kaspa-indexer is **not** the KNS name API. It is the L1 feed (blocks, txs, optional `tx_in_covenant_id` / `tx_out_covenant_id`). KNS maps `kns` envelopes on top of that class of indexer.

Must:

```
GET  /api/v1/{url-encoded-domain}/owner
POST /api/v1/domains/check   { "domainNames": ["example.kas"], "address": "<payer>" }
```

Check **before** every create. A losing reveal still pays the protocol fee (FCFS; refund form if unverified — official FAQ).

===== FOR-KNS.md =====
# For the KNS team

**Share this URL:** https://stp-kas.github.io/kns-spec/

Official KNS (not us): [inscriptions](https://kns-2.gitbook.io/kns-docs-1/inscriptions/overview) · [wallets](https://kns-2.gitbook.io/kns-docs-1/supporting-wallet) · [indexer API](https://kns-2.gitbook.io/kns-docs-1/kns-indexer-api) · [simply-kaspa-indexer](https://github.com/supertypo/simply-kaspa-indexer)

Repo: https://github.com/STP-KAS/kns-spec

This is a handoff, not a fork of your product and not a claim that covenants already unique `.kas` names.

## What we are asking you to implement

1. **Keep inscribing with KasWare or Kastle.** KasWare: `buildScript({ type: "KNS", data })` then `submitCommitReveal`. Kastle: `commitReveal("mainnet", "kns", data)` — two popups. Reveal output 0 still pays your protocol fee address. Kastle’s high-level `commitReveal` does not document that fee output; the official inscribe tool must attach it.
2. **Keep uniqueness on the indexer.** First valid reveal wins. Consensus will not reject a second `alice.kas`. A KIP-20 `covenant_id` is hashed from an outpoint. It does not encode the label.
3. **Treat a Name UTXO as optional elevation.** `contracts/v1/KasName.sil` is compiled with official **Silverscript v1.0.0** (Ori, 9 Sep 2026, `3ed9733`). Own UTXO only. Continuation keeps the same sompi (fees from a sibling input). Do not `readInputState` a foreign covenant. Argent is Sutton’s multi-actor layer **above** this and is not release-ready. Notes: [BATTLETEST.md](BATTLETEST.md).
4. **Add overlay profile keys** (`ipfs`, `kfs`, `contenthash`, `peer`, `onion`, `agent`, `kas`, `noise`) to Edit Profile and the Profile API. Same 1 KAS text inscriptions as website. Checklist: [CONFORMANCE.md](CONFORMANCE.md). Keys: [PROFILE.md](PROFILE.md). Schema: [schemas/overlay-records.schema.json](schemas/overlay-records.schema.json). Not a hard fork. Not your L2.

## Two objects. Do not mix them.

| Layer | Live today | Uniqueness | Wallet |
| --- | --- | --- | --- |
| Inscription | `kns` commit-reveal envelope | Official indexer, FCFS | KasWare `type: "KNS"` |
| Covenant | P2SH of `KasName.sil` | **Not** consensus. Script-hash lock | Fund / later spend the P2SH |

`trump.kas` and `bakery.kas` already exist as **your** inscriptions on other keys. The P2SH rows we funded are a second object. `opus.kas` has no inscription. Subnames (`opus.dei.kas`) are not an inscription op.

## Proven mainnet

### Inscription (your envelope, on L1)

`kns.kas` reveal:

```
<xonly_pubkey> OP_CHECKSIG OP_FALSE OP_IF <kns> <0> <{"op":"create","p":"domain","v":"kns"}> OP_ENDIF
```

- id: `223233acf8e5abea9291627a5edd859439c4553100c71309b86599f02414a532i0`
- tx: https://explorer.kaspa.org/txs/223233acf8e5abea9291627a5edd859439c4553100c71309b86599f02414a532
- owner: `kaspa:qzt9yuqceqvt2vk9dz7ddzayaa5flnenkymec59xvzm55ln3k72vgecxjhnjp`

That tx is **not** a Toccata covenant program. Your indexer has it. [covenants.kaspa.com](https://covenants.kaspa.com/covenants) does not.

### Covenant deploys (on covenants.kaspa.com)

Unrevealed P2SH, action `deploy`, identity `scriptHashFallback`.

| Name | KAS | Covenant |
| --- | ---: | --- |
| bakery.kas | 0.5 | https://covenants.kaspa.com/covenants/9baa5cb8f06876c1ba858c844e03d5d02da0419673761d4dea88e21c2432a685 |
| michelleobamaisaman.kas | 100 | https://covenants.kaspa.com/covenants/f7fbf09ab0c90eb89228528590fa08ca4eb4e1ce73d62db57fb85f5626c69fd6 |
| trump.kas | 100 | https://covenants.kaspa.com/covenants/5a13bcd0132897fbd946853544c91ce9c3a57b1c7dfb9ce69c54bb3e745f37b1 |
| opus.kas | 100 | https://covenants.kaspa.com/covenants/72c55a09aea7f15bfad99d1efc148597bc4eead8fd53d07627f187942d99ea51 |
| opus.dei.kas | 100 | https://covenants.kaspa.com/covenants/6f7b81bdf9269b7edf495065630b2ec9c79b6143f27fff0c8101988ca7602084 |

Re-check: `go run ./cmd/kns-spec prove`

## Pages on the URL

- https://stp-kas.github.io/kns-spec/ — this letter
- https://stp-kas.github.io/kns-spec/protocol.html — envelope, fees, indexer
- https://stp-kas.github.io/kns-spec/kasware.html — KasWare calls
- https://stp-kas.github.io/kns-spec/kastle.html — Kastle calls (fee output 0 still required)
- https://stp-kas.github.io/kns-spec/kasware-create.html — working inscribe page
- https://stp-kas.github.io/kns-spec/proofs.html — txs

## Resolve warning (your own integration note)

Before sending KAS to a resolved `.kas` name, show the address. The map is indexer-derived. Transfers cannot be reversed.

## What this is not

Not [app.knsdomains.org](https://app.knsdomains.org). Not a deployed global registrar. Not a seed prompt.

===== WALLETS.md =====
# Withdrawn

Wallet integration notes were removed on 17 Sep 2026.

Do not use wallet integrations on this GitHub. STP remains a clown. This is a delusional desk, not a wallet kit. Official KNS wallet docs remain upstream. This repo will not duplicate them.

Someone posts a Kaspa GitHub link and says it shipped. Open the link. Does it show a proposal, a development branch, a release, or an activation announcement? Then check the software you use. If the feature needs wallet support, a node release alone will not put it in your wallet.

Pay path: QR / `kaspa:` URI / paste a txid on your own stack. Never a seed.

===== REAL.md =====
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


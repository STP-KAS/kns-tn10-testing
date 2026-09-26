# The extra layer: names that are the internet, not a website on it

ENS put names **on** Ethereum. The web still runs on ICANN, CAs, and someone else’s HTTPS.

KNS can do the opposite: **Kaspa is settlement and identity. The name is the address of a private computer.** dApps run next to the user. The public web is optional.

This is not a new blockchain. It is not Tor-by-rebrand. It is a **name-addressed overlay** whose root of trust is PoW UTXO (and later a covenant name), not a registrar corporation.

Official KNS stays the inscription + indexer ([docs](https://kns-2.gitbook.io/kns-docs-1/inscriptions/overview)). This file is the layer **above** that.

## Why this can beat ENS (and where it cannot)

| ENS | KNS overlay |
| --- | --- |
| One registry contract. Political + liveness object. | Name as a **UTXO**. Parallel. Parent issues subnames; no global mutex. |
| Rent. ETH gas. | One-time inscription fee. No renewal ([FAQ](https://kns-2.gitbook.io/kns-docs-1/others/overview)). |
| Resolve via Ethereum RPC (often Infura). | Resolve via **your** node + [simply-kaspa-indexer](https://github.com/supertypo/simply-kaspa-indexer) + optional KNS API. |
| Pay in ETH/USDC elsewhere. | Pay **KAS** to the same name (`kaspa:` URI / 402). |
| TLS + CA to load the app. | Fetch `ipfs`/`kfs`/`contenthash`. Authenticate the peer with the **name’s key**. |
| DAO as root. | PoW as root. Indexer uniqueness today; covenant registrar when KNS bridges (they already said they will). |

Cannot claim today: consensus uniqueness of `alice.kas`. Indexer FCFS. Multi-dot L1 strings are **not** hierarchy ([FAQ](https://kns-2.gitbook.io/kns-docs-1/others/overview)). ECDSA addresses unsupported.

## Four planes

```
┌─────────────────────────────────────────────────────────┐
│  Run     local sandbox: HTML/WASM/agent from contenthash │
│  Session Noise/libp2p (or onion). Auth = name pubkey     │
│  Locate  records on the name: kas, ipfs, peer, onion…    │
│  Settle  Kaspa L1: KAS, optional KasName.sil, KIP-21     │
└─────────────────────────────────────────────────────────┘
```

The “new layer of the internet” is **Session + Locate**, pinned by **Settle**. Not an L2 EVM.

## URI

```
kns://alice.kas              open the app (content)
kns://alice.kas/pay          kaspa: address (always show it)
kns://alice.kas/peer         libp2p multiaddr
kns://alice.kas/onion        onion/I2P
kns://pay.shop.kas           only if a *parent* issued it (covenant). L1 multi-dot is a flat asset.
```

`https://alice.kas.limo` is a **leak**. Fine for the old web. The overlay path must not require DNS or a CA.

## Record keys (Web4-ready)

Inscription profiles already store a subset as text. The overlay reads this map. Empty keys are absent.

| Key | Meaning |
| --- | --- |
| `kas` | Payment address (must show before send) |
| `pay` | Optional pay URI |
| `ipfs` / `kfs` / `arweave` / `contenthash` / `website` / `redirectUrl` | App bytes. Order: redirectUrl → website → ipfs → kfs → arweave → contenthash |
| `peer` | libp2p multiaddr(s), comma-separated |
| `onion` | `onion://` or `i2p://` |
| `noise` | Noise static pubkey (hex) if not the Kaspa owner key |
| `agent` | URL or CID of an agent card (callable) |
| `lane` | Optional KIP-21 lane id for this name’s messages |
| `vault` / `vaultCommit` | Secret package (seed-only, not on-chain bytes) |
| `x` `github` `telegram` … | Public social, optional |

**Privacy max:** do not publish `peer` on a public indexer. Hand a capability (vault window, or a one-time `kns://` with a ticket). Public `peer` is discoverable. That is a choice.

## How a dApp runs here

1. User types `alice.kas`.
2. Client resolves **locally** if possible (own indexer). Else official API, with the resolve warning.
3. Fetch content from IPFS/KFS. **Run it on the user’s machine** (browser sandbox or local runtime). The server is not the source of truth.
4. Calls go to `peer` over Noise, signed by the name key. Payment is KAS 402 or a `kaspa:` URI.
5. Secrets stay in `vault` (seed, 5-minute window). Never in the inscription.

No Cloudflare. No Google DNS. No app store. KasWare/Kastle/Kurncy/Kasanova already hold the name; the overlay is a resolver + sandbox those wallets (or a companion) can grow into.

## How to create the layer on Kaspa (build order)

1. **Now (no new consensus)**  
   Record keys + `kns://` + local resolve via simply-kaspa-indexer + IPFS/KFS fetch + 402. This repo’s `internal/overlay`.

2. **Name as UTXO**  
   Elevate inscription → `KasName.sil`. Parent-issued subnames (`pay.shop.kas` only shop can mint). That is how hierarchy becomes real without a single ENS registry.

3. **Session**  
   Noise XX with **X25519** keys **bound** by a KIP-5 Schnorr signature. Do not claim libp2p PeerId = Kaspa schnorr (ECDSA vs BIP340). Default rendezvous is a capability, not a public multiaddr. See [WEB4.md](https://github.com/STP-KAS/kns-spec/blob/main/WEB4.md).

4. **Optional lane**  
   KIP-21 `lane` for ordered mail for that name. Not required to start.

5. **KNS bridge**  
   When official KNS moves inscriptions to contracts (their FAQ), the overlay does not change. The locate plane still reads the same keys.

## What this is not

- Not a Kaspa L2 EVM for “the new internet.”
- Not Tor unless the name sets `onion`.
- Not consensus uniqueness.
- Not a request for a seed.

## Implement

```go
rec := overlay.Parse(profileJSON)
target := rec.App()      // content
pay := rec.PayAddress()  // always display
peer := rec.Peer()       // overlay
```

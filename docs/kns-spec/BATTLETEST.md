# Battle-test (9–10 Sep 2026)

Checked against Ori’s Silverscript **v1.0.0**, Sutton’s Argent sync, KCC drafts, official silverc tutorial, ENS resolution practice, and CashScript-style covenant value rules.

## Layers (do not flatten)

| Layer | Who | Status | This kit |
| --- | --- | --- | --- |
| Consensus | KIP-16/17/20/21 | Active | Names are **not** unique in consensus |
| Single contract | Silverscript v1.0.0 ([Ori, 9 Sep](https://x.com/OriNewman/status/2097731203503640976)) | Tagged | `KasName.sil` |
| Multi-actor apps | Argent ([Sutton, 30 Aug](https://x.com/michaelsuttonil/status/2094140618045800510); [PR #60](https://github.com/argent-lang/argent/pull/60) merged 10 Sep, pinned to sil v1.0.0) | **Not release-ready** | Not used |
| Token convention | KCC-20 | Draft | Not a name |
| Inscription names | KNS indexer + KasWare/Kastle | Live | Primary path |

Sutton: Silverscript compiles one contract; Argent emits Silverscript for multi-actor apps. KasName is one UTXO. Keep it `.sil`.

## What failed the old KasName

Official v1 tutorial: `validateOutputState` **does not constrain amount**. CashScript / Mecenas examples always `require(tx.outputs[0].value == …)`. Without that, an owner spend can strip storage-mass KAS off the name lock.

**Implemented:** `continueAtValue` requires output 0 sompi == this input’s sompi. Pay miner fees from a **sibling P2PK input** (same idea as KCC-20 borrowed-receive funding).

Template hash is now `8f2a7f691e2e4172da7e97865c1350b14e357f9e9668d46d32b073ec642e67f0` (changed; expected).

## Other-chain practice we adopted

| Practice | Source | Here |
| --- | --- | --- |
| Show the resolved address before send | ENS design guidelines; KNS integration note | PROTOCOL + briefing warn |
| Registry vs resolver | ENS: registry owns, resolver holds records | Inscription = registry analogue; `kasPkh`/`vaultCommit` = thin resolver on the same UTXO. Full split needs a registrar. Not faked. |
| Normalize then hash | ENS namehash / UTS-46 | `LabelHash` = SHA-256(`kns/v1/` + lowercase label). **Not** recursive ENS namehash (no parent node on a single-label inscription). |
| Parent issues subnames | ENS setSubnodeOwner | Inscription create is one label. Subnames stay parent-issued covenant design. |
| Lineage, not copied script | CAT-20 vs KIP-20 (Ori DOG20) | `covenant_id` is outpoint-based. Label is not the id. |
| Do not read untrusted foreign state | CashScript; silverscript#234; Sutton “provenance assumptions” | No `readInputState`. |

## What we did not copy

- Argent actors / ICC / leader-delegator: name is one contract; Argent README still says not release-ready.
- KCC-02 owner_scheme byte: overkill for a pubkey-owned name. Treat owner as scheme `0x00` p2pk-schnorr.
- ENS rent/expiry: KNS is one-time fee, no renewal.
- Recursive namehash: no on-chain parent until a registrar exists.

## X / GitHub pins used

- Ori v1: https://x.com/OriNewman/status/2097731203503640976 — release https://github.com/kaspanet/silverscript/releases/tag/v1.0.0
- Sutton layers: https://x.com/michaelsuttonil/status/2094140618045800510
- Sutton #234 closed because provenance, not a merged pin: https://x.com/michaelsuttonil/status/2095472062701699101
- Argent → sil v1.0.0: https://github.com/argent-lang/argent/pull/60 (10 Sep 2026)
- IzioDev KCC-01/02/20 drafts still drafts
- `#243` compute-budget in artifact: still open

# SNRC v3 — security review & accepted risks

Review dates: 2026-06-14 (initial) and 2026-07-09 (independent re-review on the
Fable model — see the dated section at the end). Scope: the wrapper-free v3
contracts that differ from upstream ENS, plus the deploy scripts. The `.testing`
TLD is now live on mainnet; findings whose status changed with deployment reality
are called out in the re-review.

- `ens-contracts/contracts/ethregistrar/BaseRegistrarImplementation.sol` (v3 changes)
- `ens-contracts/contracts/simplex/MetadataRenderer.sol` (new)
- `ens-contracts/contracts/simplex/SubnameRegistrar.sol` (new)
- `scripts/deploy-local.mjs`, `scripts/deploy-testnet.mjs`, `scripts/deploy-mainnet.mjs`
- `ens-contracts/deploy/**` (@rocketh; local/test only)

This file is the durable record of findings and **which risks have been
explicitly accepted**, so a later auditor knows what was a conscious decision
versus an oversight. Update it when the design or these decisions change.

## Findings summary

| ID | Severity | Status | Summary |
|----|----------|--------|---------|
| H1 | High (operational) | Accepted (runbook) | Deployer keeps `SimplexController` ownership (incl. UUPS upgrade) until the multisig calls `acceptOwnership()` |
| L1 | Low / informational | Accepted | `SubnameRegistrar` holds a registry-wide operator grant; safe only by immutability + the `_controller(parentNode)==msg.sender` gate |
| L2 | Low / informational | Accepted (by design) | Subnames are **soulbound to the 2LD NFT** (`ownerOf` derives from the token holder); not independently owned or transferable |
| L3 | Low | Accepted | `setMetadataRenderer` does no contract/ERC-165 check (fat-finger → recoverable metadata outage) |
| L4 | Low | **Fixed** | Label length now capped at 63 bytes at deploy (`setMaxLabelLength(63)`) |
| L5 | Low / informational | Accepted | `PublicResolver`'s `nameWrapper` slot is the `SubnameRegistrar` (subname auth via `ownerOf`); the 2LD itself is never wrapped |
| L6 | Low / informational | Accepted | `maxLabelLength` is freely settable up/down (owner-trusted policy knob) |
| L7 | Low / informational | Accepted (read-side) | Enumeration / `tokenURI` include expired-but-unburned names; readers must filter by `nameExpires` |
| L8 | Low / informational | Accepted | `UniversalResolver` deployed with a `DummyGatewayProvider` (CCIP-read unused) |
| L9 | Low / informational | Accepted (read-side) | A re-registered 2LD's old subname records keep resolving until `purge`d (generation invalidates ownership immediately; record cleanup is lazy) |

No critical or high vulnerability was found **in the contracts** themselves;
the single High is in the deploy/ownership handoff.

> A second, independent review on 2026-07-09 (run on Fable) confirmed this ledger
> and added findings **N1–N8** — see [the re-review](#2026-07-09--independent-re-review-fable).

## Fixed

### L4 — Unbounded label length → capped at 63 bytes
`registerWithLabel` stores the plaintext label in `labelOf` and the
`MetadataRenderer` builds JSON+SVG from it. With `maxLabelLength = 0` (no limit)
a registrant could store arbitrarily large labels (self-paid SSTORE) and inflate
the `tokenURI` render. No injection risk (the renderer's JSON/XML escaping is
fuzz-verified), but unbounded is undesirable. **Fix:** all deploy scripts now
call `baseRegistrar.setMaxLabelLength(63)` (the DNS octet limit) right after
`setMetadataRenderer`, while the deployer still owns the registrar. 63 bytes =
63 ASCII characters; fewer for multibyte labels (the cap is on `bytes(label).length`).
Subname labels are capped the same way: `SubnameRegistrar.MAX_LABEL_LENGTH = 63`
(a constant, since that contract has no general owner), enforced in `createSubname`.

## Accepted risks

### H1 — Two-step ownership handoff window (operational)
`SimplexController` is `Ownable2StepUpgradeable`. The deploy script calls
`transferOwnership(coldOwner)`, which only sets `pendingOwner`; the cold owner
must then call `acceptOwnership()`. Until it does, the **ephemeral deployer key**
still owns the controller — including `_authorizeUpgrade` (UUPS), `setPriceOracle`,
`disableNftGate`, `setMinCharLength`, and `withdraw` (which pays `owner()`; there
is no `setTreasury`). (The registrar and reverse registrars are 1-step `Ownable`
and transfer immediately; only the controller has this window.)

**Accepted because** it is inherent to the ephemeral-deployer + 2-step pattern
and cannot be closed from the deploy script (only the cold owner can accept).
**Required operational mitigation (runbook):**
1. Immediately after deploy, the cold owner calls `SimplexController.acceptOwnership()`.
2. Verify `SimplexController.owner() == coldOwner` and `pendingOwner() == address(0)`.
3. Only then destroy/retire the deployer key. Treat it as fully privileged until step 2 passes.

### L1 — `SubnameRegistrar` registry-wide operator grant
Each user grants `ens.setApprovalForAll(subnameRegistrar, true)`, a
registry-wide operator permission over **all** their ENS nodes. This is safe
only because of two properties that an auditor must re-verify on any change:
1. The contract is **immutable** (no proxy, no general `owner`, no `delegatecall`,
   no `selfdestruct`) and its only operator-authorised registry write is
   `ens.setSubnodeRecord(parentNode, labelhash, address(this), resolver, 0)` in
   `createSubname` — i.e. it can only create a subnode **owned by itself** under
   a node the caller controls. (Its other registry writes, `setOwner`/`setResolver`
   in `_clear`, act only on nodes it already owns.)
2. `createSubname`/`deleteSubname` gate on `_controller(parentNode) == msg.sender`
   — the 2LD NFT holder (for a 2LD parent, the registry owner via auto-reclaim;
   for a subname parent, `ownerOf`). This is **load-bearing**: without it, since
   the contract is the grantor's operator, anyone could create subnames under
   another approver's node.

**Accepted** as the deliberate design (a minimal, single-purpose stand-in for the
NameWrapper). Users can revoke at any time with
`setApprovalForAll(subnameRegistrar, false)`. A `SubnameRegistrar` redeploy
requires users to re-approve the new address and re-create subnames.

### L2 — Subnames are soulbound to the 2LD NFT (by design)
A subname has no independent owner: in the registry it is owned by the
`SubnameRegistrar`, and its effective owner is whoever holds the parent 2LD token
(`ownerOf(node)` walks up the parent chain to the 2LD node, whose registry owner
tracks the NFT via BaseRegistrar **auto-reclaim** on transfer). Consequences,
all intended:
- Transferring the 2LD NFT moves every subname with it instantly — no reclaim,
  no re-seize, no stale ownership, and the previous owner loses all subname rights
  the moment the token leaves (including the ability to create new subnames,
  because the 2LD registry node also follows the NFT).
- Subnames are **not** independently sellable/transferable; integrators must not
  treat them as standalone assets.
- The verbatim `PublicResolver` authorises subname records against this `ownerOf`
  via its `nameWrapper` hook (see L5).
**Accepted by design.** See also L9 (re-registration cleanup is lazy).

### L3 — `setMetadataRenderer` has no contract check
Setting the renderer to an EOA or a non-conforming contract makes `tokenURI`
revert collection-wide until corrected (it low-level-calls the renderer and
ABI-decodes a `string`). **Accepted:** `onlyOwner` (multisig), not
attacker-reachable, and fully recoverable by setting a correct renderer. Deploy
scripts set a valid renderer; operators should spot-check `tokenURI(sampleId)`
after any future `setMetadataRenderer`.

### L5 — `PublicResolver`'s `nameWrapper` slot is the `SubnameRegistrar`
The verbatim `PublicResolver` is deployed with `nameWrapper = subnameRegistrar`
(not `address(0)`). Its `isAuthorised(node)` does `if (ens.owner(node) ==
nameWrapper) owner = nameWrapper.ownerOf(node)` — so for a subname node (owned by
the registrar) the resolver authorises records against the live 2LD holder
(`subnameRegistrar.ownerOf`), while a **2LD** node (owned directly by the NFT
holder via auto-reclaim) never takes that branch and authorises directly. So the
2LD is **not** wrapped; only subname auth routes through the registrar. The
registrar implements just the one function the resolver calls (`ownerOf(uint256)`);
no other `INameWrapper` method is invoked on this path. We do not modify the
verbatim resolver — only the constructor argument. **Accepted.**

### L6 — `maxLabelLength` not monotonic
Unlike the controller's `minCharLength` (monotonic decrease), the registrar's
`maxLabelLength` is freely settable up/down by the owner. An owner could set it
to a tiny value and block new registrations. **Accepted:** owner is the
multisig (trusted); it's a policy knob, not an attacker surface.

### L7 — Enumeration includes expired names
`ERC721Enumerable` (`totalSupply` / `tokenOfOwnerByIndex` / `balanceOf`) and
`tokenURI` reflect raw token ownership, which is only updated on
transfer/mint/burn — **not** on expiry (a name is burned only on re-registration
after its grace period). So they can disagree with the grace-period `ownerOf`.
**Accepted (read-side contract):** all readers (the dApp, resolvers, integrators)
MUST filter by `nameExpires(id) > block.timestamp`. Documented as an invariant
on `BaseRegistrarImplementation`.

### L8 — `DummyGatewayProvider` on the `UniversalResolver`
The `UniversalResolver` is deployed with a dummy CCIP-read gateway provider.
SNRC resolves on-chain (text records), so no off-chain gateway is relied upon.
**Accepted** as long as no CCIP-read path is introduced; revisit if off-chain
resolution is ever added.

### L9 — Re-registered 2LD's old subname records resolve until purged
When a 2LD expires and is re-registered, BaseRegistrar calls
`subnameRegistrar.onReregister(node)`, which bumps a per-2LD `generation`. This
invalidates the previous owner's subnames **immediately** at the ownership level:
`ownerOf` returns `address(0)` for them, so no one can modify them and the dApp
won't list them. But their **stored resolver records keep resolving** until the
registry/resolver storage is cleared — you cannot atomically delete an unbounded
number of subnames inside the re-registration tx. Cleanup is therefore a
permissionless, batched `purge(parentNode, labelhashes[])` (storage-refund
incentivised). **Accepted (read-side):** this matches plain ENS (an expired
name's subnames also linger until cleared); the dApp should `purge` on 2LD
acquisition. The leak is records-only — ownership/authorisation never transfers
to the new owner without an explicit `createSubname`.

## Assurances (verified properties)

- **No reentrancy surface** in the new contracts: the registry is trusted, the
  renderer is `view`, no ETH is handled, and the controller's record-write path
  is `nonReentrant` (covered by the `ReentrantResolver` test).
- **`labelOf` cannot be spoofed** (registrar or subname): the key is
  `keccak256(label)` and the value is `label`, so the stored entry is always the
  correct preimage; write-once only avoids redundant writes.
- **`registerWithLabel` is the only registration path** — every registration
  records its label; the raw-labelhash `register(uint256)` was removed.
- **Deploy ordering is sound:** reserved names are set and the TLD node is handed
  to the registrar before registration is possible; `setMetadataRenderer` /
  `setMaxLabelLength` run before the ownership handoff; the 60s commit-reveal
  blocks same-transaction front-running.
- **MetadataRenderer escaping is fuzz-verified** — no JSON or SVG injection from
  adversarial labels (`test/simplex/FuzzMetadataRenderer.test.ts`).
- Removing NameWrapper eliminated the prior renew-desync issue and the
  wrapper-aware-resolver authorization complexity.

---

## 2026-07-09 — independent re-review (Fable)

A fresh review of the same scope, run independently on the Fable model and
cross-checked against live mainnet state. It **confirms every ledger finding
above** (H1, L1–L9) and adds the items below. **Owner note:** the live cold owner
is the `simplexchat.eth` **EOA** (`0xDa06…0340`), not a multisig — read "multisig"
above as "the cold owner."

### Ledger status change

- **H1 — exposure elevated, still open.** 16 days after the `.testing` deploy
  (2026-06-23) the cold owner still has not called `acceptOwnership()`, so the
  ephemeral deployer EOA (`0xD83B…fBC9`) remains the controller owner — and the
  key is demonstrably **hot**: on 2026-07-09 it sent `disableNftGate()` then a
  `commit`/`register`. The blast radius is wider than first stated: the verbatim
  `PublicResolver` trusts `trustedETHController` (the proxy) for **every** node,
  so UUPS-upgrade authority ⇒ the ability to rewrite any name's
  `simplex.contact`/`simplex.channel` records (a routing hijack across all
  `.testing` names), plus arbitrary register/renew, an oracle swap, and a one-step
  `renounceOwnership()` brick. `trustedETHController` is immutable in the resolver,
  so recovery from a malicious upgrade would mean redeploying the resolver and
  migrating every name. **Action: complete the ownership handoff now; treat the
  deployer key as fully privileged until then.**

### New findings

| ID | Severity | Summary |
|----|----------|---------|
| N1 | Medium (operational) | NFT gate now disabled + zero pricing ⇒ open, free `.testing` registration |
| N2 | Low | A revived subname inherits the previous owner's resolver records |
| N3 | Low | Deleting a middle subname strands its descendants (records keep resolving) |
| N4 | Low / info | Reverse-record registrations always revert on mainnet (reverse registrars are `address(0)`) |
| N5 | Low / info | Unrestricted on-chain charset ⇒ display spoofing (homoglyph/bidi), not injection |
| N6 | Info | `purge`/`delete` linear-scan children — quadratic on large sets; purge front-first |
| N7 | Info | `withdraw()` pays `owner()` (the deployer during the H1 window); `renounceOwnership` not disabled |
| N8 | Info | Documentation drift (some fixed with this review) |

- **N1** — `nftGateEnabled()` is now `false` (disabled on-chain 2026-07-09,
  one-way) and the `.testing` price array is all zeros, so anyone can mass-register
  6+-char `.testing` names for gas only (the reserved list covers only `simplex`,
  `simplex-chat`). If unintended, recourse is `setPriceOracle` (still unfrozen) or
  a UUPS upgrade. Confirm intent.
- **N2** — `createSubname` revives a generation-dead node but leaves the old
  owner's `PublicResolver` records intact (`purge`/`_clear` zero the registry
  resolver pointer, not resolver storage). Mitigation: the dApp should
  `clearRecords(node)` alongside `createSubname`, and on 2LD acquisition.
- **N3** — `deleteSubname` on a middle node zeroes it but leaves descendants with
  a dangling `parentOf`; their records keep resolving and `purge` skips them while
  their generation still matches. Mitigation: delete leaf-first in the dApp, or
  accept as self-inflicted within a single owner.
- **N4** — `register()` still calls the reverse registrars when the reverse bits
  are set, but both are `address(0)` on mainnet, so such a call reverts after the
  60 s commit is spent. Mitigation: early-revert when a reverse bit is set with no
  reverse registrar, or ensure the dApp never sets the bits.
- **N5** — only min length (≥ 6 codepoints) and max bytes (≤ 63) are enforced;
  labels may contain homoglyph/bidi/zero-width characters. The renderer escaping
  blocks JSON/SVG injection, but lookalike names can be minted for
  marketplace/social spoofing. ENSIP-15-normalising clients won't resolve them.
  Accept (matches ENS's on-chain posture) or enforce an LDH charset in `valid()`.
- **N6** — `_removeChild` linear-scans `_children`; deleting/purging a large dead
  set naively is O(n·m). A front-of-array-first purge is O(1) per item.
  Self-inflicted; document the ordering.
- **N7** — permissionless `withdraw()` pays `owner()` (the deployer during the H1
  window; no funds at risk today with zero pricing, relevant once `.simplex`
  charges). The inherited one-step `renounceOwnership` is not disabled — an owner
  slip permanently orphans admin/upgrades. Consider overriding it to revert.
- **N8** — doc fixes applied with this review: H1 no longer claims a `setTreasury`
  (none exists; `withdraw` pays `owner()`) and clarifies "multisig" = the cold
  EOA. Still open **outside `docs/`** (flagged, not changed): `CLAUDE.md` line 95
  ("keeps upstream `register(uint256,…)`" — that function was removed) and
  `ens-contracts/docs/upgrades.md` (`__gap[49]` vs the code's `_reentrancyStatus`
  + `__gap[48]`).

**Verdict:** no new critical/high in the contracts themselves. The dominant risk
remains operational — the ownership handoff is still open with a hot deployer key
whose upgrade authority transitively controls every name's resolver records, and
that same key one-way-disabled the NFT gate (with zero pricing ⇒ open, free
registration).

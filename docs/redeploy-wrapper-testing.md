# Partial mainnet redeploy — fixed NameWrapper + Resolver for `.testing`

Replaces the `.eth`-hardcoded NameWrapper (`0x9be8…`, which mis-wraps `.testing`
names) with the TLD-parameterised one, plus a matching PublicResolver. **Nothing
is wrapped on the old wrapper (verified: 0 names), so there is no migration.**
The registry, BaseRegistrar, SimplexController, and every existing name are
untouched — only new contracts are deployed and the off-chain config is
repointed.

## What is / isn't changed on-chain

- **Deployed new:** `StaticMetadataService`, `NameWrapper` (fixed), `PublicResolver` (bound to the new wrapper).
- **No wiring needed:** the wrapper wraps via user `setApprovalForAll` + `reclaim`; it is *not* a registrar controller, and `register()` never touches it. The new resolver is per-registration (chosen by the dApp), not a registry default. So there are **no state-changing txs against the live deployment** beyond handing the new wrapper's ownership to the multisig.
- **Old wrapper `0x9be8…` stays deployed but unreferenced.**

## 1. Compile

```
pnpm --filter ens-contracts compile     # artifacts must reflect the 5-arg NameWrapper
```

## 2. Deploy

Uses the **same wait-for-cheap-base strategy as `deploy-mainnet.mjs`** (shared
`gas-tools.mjs`). It differs in one spot: the preflight gas is measured with
real-mainnet `eth_estimateGas` instead of a forked-node dry-run, because a
Hardhat fork cannot execute these deploys — their constructors call into the
*real* ENS registry via `ReverseClaimer`, and the fork aborts with "internal
error". (The successful estimate also confirms the deploys won't revert.) After
the ceiling-cost summary + Y/N confirm, the **real deploy is identical**: each tx
sent with `maxFeePerGas = MAX_BASE_FEE_GWEI` / zero priority, waiting for
`baseFee ≤ cap`, bumping the cap after a long stall, journalling each tx so a
re-run resumes.

```
DEPLOYER_KEY=0x...  MAINNET_RPC_URL=https://...  MAX_BASE_FEE_GWEI=0.078  \
  OWNER_ADDRESS=0xDa064C4567fAD2c9Da7b6DD08b5C2B2607960340  \
  METADATA_URI='https://<your-metadata-host>/mainnet/{id}'  \
  node scripts/redeploy-wrapper-testing.mjs
```

`MAX_BASE_FEE_GWEI` is required — pick it from Dune (e.g. 5th-percentile recent
base fee). `CONFIRM=yes` skips the prompt; `BUMP_AFTER_HOURS` / `BUMP_PCT` /
`FORK_PORT` behave as in `deploy-mainnet.mjs`.

On success the script **rewrites the repo-root `deployments.mainnet.testing.json`**
in place (`NameWrapper`, `PublicResolver`, `NameWrapperPublicResolver`,
`StaticMetadataService`), writes the JSONL journal, and prints the new addresses,
the **subgraph startBlocks**, and the **constructor args** for Etherscan. Call
the printed values `<NEW_WRAPPER>`, `<NEW_RESOLVER>`, `<NEW_METADATA>`,
`<WRAPPER_BLOCK>`, `<RESOLVER_BLOCK>` below.

> The metadata URI is swappable later via `NameWrapper.setMetadataService(addr)`
> (owner-only), so a placeholder is fine if the host isn't ready.

## 3. Config diffs (off-chain)

### 3a. `deployments.mainnet.testing.json`

The deploy script (Step 2) **already rewrote the repo-root copy** with these four
keys — review the git diff to confirm, then **copy it into `ens-app-v3/`** (the
two files are kept identical):

```
cp deployments.mainnet.testing.json ens-app-v3/deployments.mainnet.testing.json
```

The applied change is:

```diff
-  "NameWrapper": "0x9be8cf2b3d315a290de52f4c878a9e890269877f",
+  "NameWrapper": "<NEW_WRAPPER>",
-  "PublicResolver": "0x80fa1903e70af03e79c73fb7feae2fb33aebae01",
+  "PublicResolver": "<NEW_RESOLVER>",
-  "NameWrapperPublicResolver": "0x80fa1903e70af03e79c73fb7feae2fb33aebae01",
+  "NameWrapperPublicResolver": "<NEW_RESOLVER>",
+  "StaticMetadataService": "<NEW_METADATA>",
```

The dApp reads addresses only from this file (no hardcoded resolver tables), so
this is the entire dApp change. Rebuild/redeploy the dApp afterwards. Existing
names keep reading their own (old) resolver from the registry; only *new*
registrations use `<NEW_RESOLVER>`.

### 3b. `ens-subgraph/subgraph.yaml`

Point the NameWrapper datasource at the new wrapper, and **add** a second
Resolver datasource for the new resolver (keep the old one — existing names'
records live there):

```diff
   - kind: ethereum/contract
     name: NameWrapper
     ...
-      address: "0x9be8cf2b3d315a290de52f4c878a9e890269877f"
+      address: "<NEW_WRAPPER>"
       abi: NameWrapper
-      startBlock: 25250870
+      startBlock: <WRAPPER_BLOCK>
```

Then duplicate the existing `name: Resolver` datasource block as a new
`name: ResolverV2` (everything identical except name/address/startBlock):

```yaml
  - kind: ethereum/contract
    name: ResolverV2
    network: mainnet
    source:
      address: "<NEW_RESOLVER>"
      abi: Resolver
      startBlock: <RESOLVER_BLOCK>
    mapping:
      # ...copy the mapping block (file, entities, abis, eventHandlers) verbatim
      # from the existing `name: Resolver` datasource...
```

Redeploy the subgraph after editing.

### 3c. `ens-metadata-service` (env only — no code change)

```
ADDRESS_NAME_WRAPPER=<NEW_WRAPPER>
```

Restart/redeploy the service so its contract allowlist matches the new wrapper.
Also point `METADATA_URI` (above) at this service if not already.

## 4. Verify, tag, document

- Etherscan-verify the new `StaticMetadataService`, `NameWrapper`, `PublicResolver`:
  ```
  MAINNET_RPC_URL=https://... node scripts/prepare-wrapper-verification.mjs
  ETHERSCAN_API_KEY=... NETWORK=mainnet SIMPLEX_TLD=testing node scripts/verify-etherscan.mjs
  ```
  The first script refreshes `verification.mainnet.testing.json` with the three new
  addresses + ABI-encoded constructor args (reading the metadata URI from chain so
  it's byte-exact); the second submits them to Etherscan. Commit the refreshed
  `verification.mainnet.testing.json`.
- Smoke test on mainnet: register a fresh `.testing` name → `wrapETH2LD` → `NameWrapper.ownerOf(namehash(name.testing))` returns you → metadata renders → `unwrapETH2LD` round-trips.
- Git-tag the deploying commit: `simplex-mainnet-testing-v2` (per the deployment-version rule in CLAUDE.md).
- Update `CLAUDE.md`: NameWrapper is no longer "verbatim ENS" — note the TLD-parameterisation deviation; the "subnames / ERC-1155 trading via NameWrapper" claims are now true for `.testing`.
- Re-enable wrapping/subnames in the dApp (the preventive disable is no longer needed against the new wrapper).

## Rollback

Nothing migrates, so reverting is trivial: restore the old addresses in
`deployments.mainnet.testing.json` (+ revert the subgraph/metadata env) and the
deployment is back to today's state. The new contracts simply sit unused.

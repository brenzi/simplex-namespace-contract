# LEGACY — Sepolia deployment playbook

> **Historical / no longer active.** Sepolia is no longer part of the SNRC
> deployment plan. The active targets are local Hardhat and Ethereum mainnet —
> see [`../deployment.md`](../deployment.md). This document preserves the full
> Sepolia deploy procedure verbatim for the record and in case a public testnet
> is ever revived. The raw session transcript is in
> [`sepolia-log.md`](./sepolia-log.md).

---

## Sepolia testnet

Sepolia is chain id **11155111**. The deploy is fully automated by
`scripts/deploy-testnet.mjs`.

### Prerequisites

- A deployer EOA on Sepolia with **≥ 0.5 SepoliaETH** (a full deploy spends
  roughly 0.45 ETH). Sources: <https://sepoliafaucet.com>,
  <https://www.alchemy.com/faucets/ethereum-sepolia>.
- A Sepolia RPC URL — Alchemy / Infura / Tenderly all work. Public RPCs
  rate-limit heavily and will choke on the back-to-back tx burst.
- Submodules + dependencies installed and contracts compiled
  (`cd ens-contracts && npx hardhat compile`).

### Key model: ephemeral deployer, cold owner

`DEPLOYER_KEY` is treated as **ephemeral**. It holds only gas, signs the
deploy-time transactions, briefly holds `_owner` on every Ownable contract
so the script can wire things up, and is then handed off in one block at
the end of the run. After the cold owner submits `acceptOwnership()` on
the controller, the deployer EOA retains **no role on any deployed
contract** and can be discarded.

`OWNER_ADDRESS` defaults to **`0xDa064C4567fAD2c9Da7b6DD08b5C2B2607960340`**
— the EOA that owns `simplexchat.eth`, held in cold storage. Override via
the env var when deploying to a fresh environment (e.g. a Sepolia SAFE).

What gets transferred at end-of-deploy:

| Target                              | Type                | Effect                                              |
|-------------------------------------|---------------------|------------------------------------------------------|
| `BaseRegistrarImplementation` (v3)  | `Ownable` (1-step)  | controllers, `setResolver`, `setMetadataRenderer`, `setMaxLabelLength` |
| `MockSMPXNFT`                       | `Ownable` (1-step)  | future `mint(address)` calls                         |
| `ReverseRegistrar`                  | `Ownable` (1-step)  | `setController`                                      |
| `DefaultReverseRegistrar`           | `Ownable` (1-step)  | `setController`                                      |
| ENS `reverse` subnode               | `ENS.setOwner`      | controls the reverse namespace                       |
| ENS `eth-usd.data.eth` subnode      | `ENS.setOwner`      | locks the on-chain price oracle pointer              |
| ENS `data.eth` and `eth` subnodes   | `ENS.setOwner`      | parents of the above                                 |
| ENS root (`0x0`)                    | `ENS.setOwner`      | controls all TLD assignments                         |
| `SimplexController` (UUPS proxy)    | `Ownable2Step`      | admin + UUPS upgrade authority — **needs `acceptOwnership`** |

MockSMPXNFT token #0 is also minted directly to `OWNER_ADDRESS`, not the
deployer, so the deployer doesn't even hold a registration-gate NFT.

Concretely:

- Generate a fresh EOA (or use any Sepolia-only hot key). Fund with
  ~0.3 SepoliaETH.
- Run the deploy. The deployer signs ~25 setup transactions, then the
  final block of transferOwnership calls. All Ownable contracts move
  immediately; the controller moves via the two-step path.
- From a wallet controlling `OWNER_ADDRESS`, submit `acceptOwnership()`
  on the `SimplexController` proxy. After this, the cold owner alone
  controls admin actions + UUPS upgrades and the deployer is fully
  retired.

### Generate Ephemeral Key

```bash
node -e "(async()=>{const a=await import('viem/accounts');const k=a.generatePrivateKey();console.log('execute these in your console: \nexport DEPLOYER_KEY='+k);console.log('export ADDRESS='+a.privateKeyToAccount(k).address);})()"
```

Copy-paste and execute

### Deploy

```bash
export DEPLOYER_KEY=0xabc…
export SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<KEY>
# optional — defaults to the simplexchat.eth cold key
export OWNER_ADDRESS=0xC14ccEc78342e3DAf136E6C36025b397C377614e

# .testing first
node scripts/deploy-testnet.mjs

# .simplex once .testing has settled
SIMPLEX_TLD=simplex node scripts/deploy-testnet.mjs
```

The script:

1. Deploys the same stack as the local script with two differences:
   - **Oracle**: uses the **Sepolia Chainlink ETH/USD feed**
     (`0x694AA1769357215DE4FAC081bf1f309aDC325306`) directly — its
     `latestAnswer()` is what `ExponentialPremiumPriceOracle` reads, so the
     feed slots in for the local `DummyOracle`.
   - **NFT**: deploys a `MockSMPXNFT` and mints token #0 directly to
     `OWNER_ADDRESS` (not the deployer). The cold owner mints additional
     NFTs for testers via the contract's `mint(address)` function after
     deployment.
2. Pre-reserves `simplex` and `simplex-chat` while the deployer is still
   `_owner` on the `SimplexController`.
3. Transfers ownership of every Ownable contract (BaseRegistrar,
   NameWrapper, MockSMPXNFT, ReverseRegistrar, DefaultReverseRegistrar)
   to `OWNER_ADDRESS` (single-step — effective immediately).
4. Transfers all ENS subnodes the deployer owns (`reverse`,
   `eth-usd.data.eth`, `data.eth`, `eth`) and finally the ENS root to
   `OWNER_ADDRESS`.
5. Calls `controller.transferOwnership(OWNER_ADDRESS)` — sets
   `pendingOwner` on the proxy; the deployer is still admin on the
   controller until step 6.
6. The cold owner (`OWNER_ADDRESS`) calls `acceptOwnership()` out-of-band
   to finalise the handover. **The deploy is not considered complete
   until this step runs.**
7. Writes the address bundle to `deployments.sepolia.json` and verification
   metadata (impl address, initData, cold owner, deployer) to
   `verification.sepolia.json`.

### Source verification on Etherscan

After deploy, verify the SimplexController implementation + proxy with the
companion script:

```bash
export ETHERSCAN_API_KEY=…   # v2 multi-chain key
node scripts/verify-etherscan.mjs                   # Sepolia (default)
NETWORK=mainnet SIMPLEX_TLD=testing \
  node scripts/verify-etherscan.mjs                 # mainnet .testing
```

The script reads the matching `verification.${network}.${tld}.json` (or
the legacy flat `verification.sepolia.json` on Sepolia), finds the
matching Hardhat build-info JSON (standard-json solc input), and
submits each contract to Etherscan via the v2 multichain endpoint
(`ETHERSCAN_CHAIN_ID` is derived from `NETWORK` automatically). Polls
verification status for up to 2 minutes per contract.

On mainnet the verification metadata is **written automatically** by
`deploy-mainnet.mjs` at the end of every fresh deploy, so no extra
build step is needed. For a deploy that pre-dates the auto-write, run
`scripts/build-verification.mjs` once to reconstruct the file:

```bash
NETWORK=mainnet SIMPLEX_TLD=testing DEPLOYER=0x… \
  node scripts/build-verification.mjs
```

To verify additional verbatim ENS contracts, extend
`assembleVerification()` in `scripts/build-verification.mjs` and
re-emit the file.

### Changing prices post-deploy

`SimplexController` accepts a `setPriceOracle(IPriceOracle)` call from
its owner. This lets the cold owner swap the active oracle without a
controller redeploy. Two steps:

```bash
# 1. Deploy a fresh oracle. PRICES is the five USD/sec rates for label
#    lengths 1/2/3/4/5+. Use the comma-separated form. Default = production
#    curve ($1 / $8 / $32 / $128 per year). Use "0,0,0,0,0" for free.
DEPLOYER_KEY=0x... SEPOLIA_RPC_URL=https://... \
PRICES="0,0,0,0,0" \
  node scripts/deploy-oracle.mjs
# → prints the new oracle address + a setPriceOracle call to submit
# → appends an entry to oracles.sepolia.json so rollback is one address away
```

```
# 2. From a wallet controlling OWNER_ADDRESS, submit:
SimplexController.setPriceOracle(<new oracle address>)
```

The change takes effect immediately. To verify the new oracle on
Etherscan, copy the printed `priceOracleConstructorArgs` block into
`verification.sepolia.json` and rerun `scripts/verify-etherscan.mjs`.

When you're ready to lock pricing forever, the cold owner submits:

```
SimplexController.freezePriceOracle()
```

This is one-way — `setPriceOracle` will revert thereafter with
`PriceOracleAlreadyFrozen`.

### Completing the ownership handover

From a wallet controlling `OWNER_ADDRESS` (Ledger, SAFE, or whatever
custodies the simplexchat.eth EOA), submit:

```
SimplexController.acceptOwnership()
```

at the proxy address printed during deploy (also stored as
`ETHRegistrarController` in `deployments.sepolia.json`). Confirm with:

```bash
cast call <PROXY> "owner()(address)" --rpc-url $SEPOLIA_RPC_URL
# → 0xDa064C4567fAD2c9Da7b6DD08b5C2B2607960340
cast call <PROXY> "pendingOwner()(address)" --rpc-url $SEPOLIA_RPC_URL
# → 0x0000000000000000000000000000000000000000
```

Until the cold owner accepts, the ephemeral deployer EOA still has admin.
Discard the deployer key only after `acceptOwnership` has landed.


### Wire up the dApp

If you're running the dApp locally against Sepolia:

```bash
cd ens-app-v3
NEXT_PUBLIC_CHAIN_NAME=sepolia \
NEXT_PUBLIC_SIMPLEX_TLD=testing \
NEXT_PUBLIC_SEPOLIA_DEPLOYMENT_ADDRESSES="$(cat ../deployments.sepolia.json | tr -d '\n ')" \
pnpm dev
```

If you're deploying the dApp via Cloudflare Pages, commit
`deployments.sepolia.json` to the repo root — the build script reads it at
build time and bakes the addresses into the static export. See
[`../hosting-cloudflare.md`](../hosting-cloudflare.md).

### MetaMask setup

- Network: **Sepolia** (`https://eth-sepolia.public.blastapi.io` or your RPC)
- Account: any Sepolia-funded wallet. To register on the gated `.testing`
  TLD, the deployer needs to mint you an SMPXNFT via `MockSMPXNFT.mint(addr)`.

---

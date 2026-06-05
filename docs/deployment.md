# Deployment

Three deployment targets — local Hardhat, **Sepolia testnet**, Ethereum
mainnet. Each TLD (`.testing`, `.simplex`) is an independent deployment; run
the playbook once per TLD per network.

## Contents

- [Quick reference](#quick-reference)
- [Local Hardhat](#local-hardhat)
- [Sepolia testnet](#sepolia-testnet)
- [Mainnet](#mainnet)
- [dApp on Cloudflare Pages](#dapp-on-cloudflare-pages)
- [Frontend env vars](#frontend-env-vars)
- [Deploy-time env vars](#deploy-time-env-vars)
- [Verification](#verification)
- [Gotchas](#gotchas)

## Quick reference

| What                          | Command / Variable                                  |
|-------------------------------|------------------------------------------------------|
| Compile                       | `cd ens-contracts && npx hardhat compile`            |
| Local one-shot                | `./scripts/run-local.sh`                             |
| Local for `.simplex`          | `SIMPLEX_TLD=simplex ./scripts/run-local.sh`         |
| Deploy to Sepolia             | `DEPLOYER_KEY=… SEPOLIA_RPC_URL=… node scripts/deploy-testnet.mjs` |
| Deploy to mainnet             | `DEPLOYER_KEY=… MAINNET_RPC_URL=… MAX_BASE_FEE_GWEI=… SIMPLEX_TLD=… node scripts/deploy-mainnet.mjs` |
| Sepolia / mainnet cold owner  | `OWNER_ADDRESS` env (defaults to the simplexchat.eth cold key) |
| Verify on Etherscan           | `ETHERSCAN_API_KEY=… node scripts/verify-sepolia.mjs`     |
| Addresses output (local)      | stdout + `deployments.local.json`                    |
| Addresses output (Sepolia)    | stdout + `deployments.sepolia.json` + `verification.sepolia.json` |
| Addresses output (mainnet)    | stdout + `deployments.mainnet.${tld}.json` + `.journal.jsonl` + `.attempts.log` (**deployer must commit JSON + journal**) |
| Frontend env var (local)      | `NEXT_PUBLIC_DEPLOYMENT_ADDRESSES` (JSON)            |
| Frontend env var (Sepolia)    | `NEXT_PUBLIC_SEPOLIA_DEPLOYMENT_ADDRESSES` (JSON)    |
| TLD env var                   | `NEXT_PUBLIC_SIMPLEX_TLD` (`testing` or `simplex`)   |
| Chain selection               | `NEXT_PUBLIC_CHAIN_NAME` (`localhost`/`sepolia`/`mainnet`) |
| Static build flag             | `NEXT_PUBLIC_IPFS=1` (used by the Cloudflare Pages build) |

---

## Local Hardhat

`./scripts/run-local.sh` runs the following in a single process:

1. `npx hardhat --network hardhat node` — starts Hardhat at `127.0.0.1:8545`
   with chainId **1337**. The `--network hardhat` flag is required; without
   it, `npx hardhat node` defaults to chainId 31337 which the frontend's
   `localhostWithEns` chain does not recognise.
2. `node scripts/deploy-local.mjs` — deploys the stack for the TLD selected
   by `SIMPLEX_TLD` (default `testing`):
   - `ENSRegistry`, `BaseRegistrarImplementation`, `ReverseRegistrar`,
     `DefaultReverseRegistrar`, `NameWrapper`
   - `DummyOracle` (fixed ETH/USD = $1) + `ExponentialPremiumPriceOracle`
   - `MockSMPXNFT`, with token #0 minted to the deployer
   - `SimplexController` (deployed **before** `PublicResolver` so its address
     can be passed as `trustedETHController`)
   - `PublicResolver` (must trust the controller, otherwise `register()`
     reverts when writing resolver records)
   - `UniversalResolver`, mock `Multicall3` (provides both `aggregate3` and
     `tryAggregate`)
   - `eth-usd.data.eth` resolver record → `DummyOracle` (the frontend's
     `useEthPrice` resolves this ENS name on chain)
   - Two reserved labels by default: `simplex`, `simplex-chat`
   - Addresses persisted to `deployments.local.json` and printed as a JSON
     line prefixed with `NEXT_PUBLIC_DEPLOYMENT_ADDRESSES=`.
3. Starts the Next.js dev server with `NEXT_PUBLIC_DEPLOYMENT_ADDRESSES`,
   `NEXT_PUBLIC_PROVIDER`, and `NEXT_PUBLIC_SIMPLEX_TLD` exported.

### MetaMask setup

- Network: `Hardhat`, RPC `http://127.0.0.1:8545`, Chain ID `1337`
- Test account: import private key
  `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`
  (Hardhat account #0, 10000 ETH, holds SMPXNFT #0)

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
| `BaseRegistrarImplementation`       | `Ownable` (1-step)  | controls who can be a controller, sets resolver      |
| `NameWrapper`                       | `Ownable` (1-step)  | upgrade hook, metadata service, controllers          |
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
node scripts/verify-sepolia.mjs
```

The script reads `verification.sepolia.json`, finds the matching
Hardhat build-info JSON (standard-json solc input), and submits both
contracts to Etherscan, plus the `ExponentialPremiumPriceOracle` if its
metadata is recorded. Polls verification status for up to 2 minutes per
contract. To verify additional contracts (the verbatim ENS ones), add
entries to the `TARGETS` array in `scripts/verify-sepolia.mjs`.

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
`verification.sepolia.json` and rerun `scripts/verify-sepolia.mjs`.

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
build time and bakes the addresses into the static export. See the
section below.

### MetaMask setup

- Network: **Sepolia** (`https://eth-sepolia.public.blastapi.io` or your RPC)
- Account: any Sepolia-funded wallet. To register on the gated `.testing`
  TLD, the deployer needs to mint you an SMPXNFT via `MockSMPXNFT.mint(addr)`.

---

## Mainnet

Two separate deployments — `.testing` first, `.simplex` later. Both go to
Ethereum mainnet. Driven by `scripts/deploy-mainnet.mjs`, which reuses
the same ephemeral-deployer / cold-owner model as Sepolia but adds a
frugal gas strategy, a hard total-spend cap, and a journal-backed
resume mechanism for partial failures.

### Pre-flight

- **Chainlink ETH/USD feed**: `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419`
  (override with `ETHUSD_FEED`).
- **SMPXNFT contract**: `0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291`
  (override with `SMPXNFT_ADDR`). Unlike Sepolia, there is no
  MockSMPXNFT — the real contract is used directly.
- **Cold owner** (`OWNER_ADDRESS`): the SNCC multisig (mainnet SAFE). The
  end-of-deploy ownership handoff matches Sepolia: BaseRegistrar,
  NameWrapper, ReverseRegistrar, DefaultReverseRegistrar, all
  deployer-owned ENS subnodes, ENS root, and SimplexController via
  Ownable2Step. After the script finishes, the cold owner must call
  `controller.acceptOwnership()` to complete the SimplexController
  handover.
- **Ephemeral deployer**: a fresh EOA. Top it up with enough ETH for the
  full sequence — the script tells you exactly how much before sending
  any tx (see below).
- The `simplex` branch must be audit-finalised on both ens-contracts and
  ens-app-v3 forks (the `main...simplex` GitHub diff is the audit
  surface).

### Gas strategy at a glance

The script optimises for cost, not speed — it will happily take days
when mainnet stays expensive. For each tx:

1. **Priority fee is always 0.** The deployer never pays validators a tip.
2. **Cap**: `maxFeePerGas = MAX_BASE_FEE_GWEI` (e.g. `0.078`, picked from
   Dune as a low percentile of recent base fees).
3. **Submit policy**: before each tx, poll `latest.baseFeePerGas` every
   ~12 s. When `base ≤ cap`, submit. Don't try to push txs through
   above the cap.
4. **Inclusion**: once submitted, the tx is valid for any block where
   `baseFee ≤ maxFee`. Normally it mines within a block or two.
5. **Stall handling**: if the tx hasn't mined within `BUMP_AFTER_HOURS`
   (default 24h, configurable), the cap multiplies by `BUMP_PCT%`
   (default +20%) and the tx is resubmitted at the same nonce. Repeats
   indefinitely; every bump goes to the attempts log so you can see
   exactly how the cap drifted.
6. **Upfront cost ceiling**: at startup the script spawns
   `npx hardhat node --fork $MAINNET_RPC_URL` in the background and
   runs the full deploy sequence against the fork as a dry run. Total
   gas captured this way, times the cap, gives the worst-case spend.
   Real cost is usually lower (you pay the actual base fee at
   inclusion, not the cap).

### Step 0 — pick a cap and run

Choose `MAX_BASE_FEE_GWEI` from a Dune (or equivalent) base-fee
distribution — the 5th percentile of recent blocks is a reasonable
starting point. Then:

```sh
DEPLOYER_KEY=0x…                    # fresh ephemeral EOA
MAINNET_RPC_URL=https://…           # your RPC (used for fork + real)
MAX_BASE_FEE_GWEI=0.078              # the cap; tx will only land when base ≤ this
SIMPLEX_TLD=testing                  # or 'simplex' for the second TLD
OWNER_ADDRESS=0x…                    # SNCC mainnet SAFE (optional override)
BUMP_AFTER_HOURS=24                  # stall threshold, optional (default 24)
BUMP_PCT=20                          # bump on stall, optional (default 20)
node scripts/deploy-mainnet.mjs
```

The script first spawns a Hardhat fork of mainnet and runs the full
deploy sequence against it to gather per-step gas usage (~30–60s). It
then prints a preflight summary and waits for Y/N:

```
=== .testing mainnet deploy preflight ===
  Strategy:
    priority fee:         0 always
    maxFeePerGas:         0.0780 gwei  (your MAX_BASE_FEE_GWEI)
    submit policy:        wait for baseFee ≤ cap, then send (no escalation by default)
    bump rule:            after 24h of stall, cap × 1.2 and resubmit at same nonce

  Current chain:
    base fee:             0.4376 gwei  (ABOVE cap)

  Forked dry-run captured 25 steps:
    total gas used:       112,000,000 units
    ceiling cost @ cap:   0.008736 ETH  (= total gas × 0.0780 gwei)
    actual cost may be lower (paid at the chain's baseFee at inclusion, ≤ cap)

  Journal state:
    fresh deploy (no prior steps recorded)

  Deployer:
    address:              0x…
    balance:              0 ETH
    remaining ceiling:    0.008736 ETH  (112,000,000 gas left × cap)

  ⚠  Balance is below the remaining ceiling. Top up at least
     0.008736 ETH before proceeding.

Proceed? [y/N]
```

Pass `CONFIRM=yes` to skip the prompt in scripted runs. The dry run is
read-only against mainnet — it executes on a local fork and is torn
down before the prompt fires.

### Step 1 — what the deploy does

1. Deploys the full ENS-shape stack (ENSRegistry, BaseRegistrar,
   ReverseRegistrar, DefaultReverseRegistrar, NameWrapper,
   PublicResolver, UniversalResolver,
   ExponentialPremiumPriceOracle, SimplexController + UUPS proxy).
2. Wires the controller into the BaseRegistrar and ReverseRegistrar,
   pre-loads the default reserved labels (`simplex`, `simplex-chat`),
   and registers `eth-usd.data.eth` → Chainlink feed in the deployed
   registry so the frontend's `useEthPrice` hook resolves on chain.
3. Hands ownership of every persistent role off to `OWNER_ADDRESS`. The
   ENS-root transfer is the last write; afterwards the deployer can't
   reassign any TLD or contract role.

Per-tx output looks like:

```
  [step:001] estimated gas: 2,025,000 (raw 1,840,909 + 10%)
  [step:001] base 0.4376 gwei > cap 0.0780 gwei — waiting…
  [step:001] base 0.5012 gwei > cap 0.0780 gwei — waiting…
  …
  [step:001] submitted 0xabc…  (cap=0.0780 gwei, bumps=0)
  ✓ step:001: 0xENSREGISTRY…  (0.000147 ETH @ 0.0726 gwei, total 0.000147 ETH)
```

Each step prints the actual effective price it paid at inclusion (the
chain's base fee at that block; the cap was the ceiling). If the chain
sat above the cap for 24h after a submission, you'd see:

```
  [step:001] stalled — tx 0xabc… not included within 24h
  [step:001] stalled — bumping cap to 0.0936 gwei (bump 1)
  [step:001] submitted 0xdef…  (cap=0.0936 gwei, bumps=1)
```

### Step 2 — resume on interruption

If anything goes wrong — network drop, RPC outage, hitting the budget
cap, deployer running out of gas, Ctrl-C — just re-run with the same
env vars. The runner reads
`deployments.mainnet.${tld}.journal.jsonl`, skips every step already
recorded as mined, and picks up at the next one. Counter labels
(`step:001…NNN`) are deterministic from the script's operation order;
the journal stays valid as long as you don't reorder or insert
operations in `scripts/deploy-mainnet.mjs`. If you do edit the script
mid-flight, delete the journal and re-deploy.

Spend across all journaled steps is summed and subtracted from the
budget before the run — there's no double-counting.

### Step 3 — **commit the addresses file AND the journal**

When the script finishes it writes
`deployments.mainnet.${tld}.json` (final addresses) to the repo root.
Two file-state outputs travel with it:

- `deployments.mainnet.${tld}.journal.jsonl` — one line per successful
  tx, with hash, address, gas, effective price, and cost. **Commit
  this** — it is the paper trail for which tx produced which address
  and exactly how much was paid. Re-deploys read it for resume.
- `deployments.mainnet.${tld}.attempts.log` — every attempt (submitted,
  dropped, timeout, budget-block, submit-error) with the price tested
  and the reason it didn't land. Useful for post-mortems but verbose
  and often large; gitignore unless you want it in the audit trail.

```sh
git add deployments.mainnet.testing.json deployments.mainnet.testing.journal.jsonl
git commit -m "deploy: SNRC .testing mainnet addresses + journal"
git push
```

Without the addresses file in the repo, later runs of the dApp build
(Cloudflare Pages), Etherscan verification, upgrade ceremonies, and
operational tooling have no way to reference the deployment.

If a previous deploy attempt left a partial journal that the new run
rolled forward, the diff against `main` will show the journal growing
by exactly the steps that mined since the last commit — the addresses
file is recreated from scratch so any prior partial values are
replaced rather than appended.

### Step 4 — post-deploy

1. The cold owner calls `controller.acceptOwnership()` from the
   multisig to complete the SimplexController handover.
2. Add the mainnet addresses + RPC to the dApp's env (Cloudflare Pages
   build env vars) and trigger a rebuild.
3. Source-verify the contracts on Etherscan. The current
   `scripts/verify-sepolia.mjs` is Sepolia-shaped; either parameterise
   it for mainnet (separate change) or verify each contract by hand
   with the same constructor-arg JSON the script emits.
4. Run the read-only Playwright suite against the mainnet build (or a
   mainnet-aware variant of `test/e2e/sepolia-readonly.spec.ts`) to
   confirm the dApp resolves a known mainnet name.

Status: ready for review on a forked mainnet rehearsal before the first
real transaction. Walk the deploy on a Hardhat mainnet fork first.

---

## dApp on Cloudflare Pages

The dApp is built as a static SPA and served from
[`simplex-namespace-contract.pages.dev`](https://simplex-namespace-contract.pages.dev/).
Cloudflare watches the GitHub repo and rebuilds on every push.

### One-time setup

1. In the Cloudflare dashboard → **Workers & Pages** → **Create** →
   **Pages** → **Connect to Git**, pick the `simplex-namespace-contract`
   repo. Important: pick **Pages**, not Workers — the newer unified UI
   defaults to Workers, which uses `wrangler deploy` instead of
   `wrangler pages deploy` and fails with a permissions error against a
   Pages project name.
2. Build configuration:
   - **Build command**: `bash scripts/cloudflare-build.sh`
   - **Build output directory**: read from `wrangler.toml`
     (`pages_build_output_dir = "./ens-app-v3/out"`) — the newer
     dashboard no longer surfaces this field, but `wrangler.toml`
     supersedes it.
   - **Root directory**: empty.
3. Environment variables (Settings → Environment variables, Production):
   - `NODE_VERSION=22`
   - `NEXT_PUBLIC_CHAIN_NAME=sepolia` (or `mainnet` once that deploy lands)
   - `NEXT_PUBLIC_SIMPLEX_TLD=testing` (or `simplex`)
   - `NEXT_PUBLIC_IPFS=1`
4. Commit `deployments.sepolia.json` (and later
   `deployments.mainnet.${tld}.json`) to the repo root. The build script
   reads the file at build time with a node one-liner and injects its
   contents into `NEXT_PUBLIC_SEPOLIA_DEPLOYMENT_ADDRESSES` — there's
   nothing to paste into the dashboard for the address bundle.
5. `.gitmodules` must use **HTTPS** URLs for the two ENS forks, not SSH.
   Cloudflare's build runner has no SSH key; `git@github.com:…` clones
   fail at submodule init.
6. (Optional) Custom domain: Settings → Custom domains → add yours; add
   the corresponding DNS record at your registrar. The Cloudflare-pinned
   `og:image` URL in `src/pages/index.tsx` hardcodes the `pages.dev`
   host — swap to the custom domain at the same time to keep social
   previews resolving.

### What the build does

The Cloudflare-side build runs `scripts/cloudflare-build.sh`, which is
the canonical entry point — edit it (not the dashboard build command) to
change build steps. In order:

1. `git submodule update --init --recursive` — defensive, in case
   Cloudflare's submodule-init step is disabled. `.gitmodules` must
   resolve over HTTPS.
2. `export YARN_ENABLE_IMMUTABLE_INSTALLS=false` — a pnpm-installed git
   dep (`clones-with-immutable-args`) runs `yarn install` as its
   `prepare` step. Corepack upgrades yarn to 4.x, which defaults to
   immutable mode when `CI=true` (Cloudflare sets this) and refuses to
   migrate the embedded lockfile.
3. `corepack enable`.
4. `pnpm install --frozen-lockfile` in the parent.
5. `pnpm install --frozen-lockfile && npx hardhat compile` in
   `ens-contracts/` — the frontend reads ABIs from
   `ens-contracts/artifacts/`.
6. `pnpm install --no-frozen-lockfile --prefer-frozen-lockfile` in
   `ens-app-v3/` — `pnpm@10.x` validates patch-file content hashes
   against the lockfile and rejects `--frozen-lockfile` if any of the
   ~10 patched-dependency hashes drift. `--prefer-frozen-lockfile` keeps
   the lockfile authoritative for versions while allowing the patch
   hashes to refresh in place.
7. Inline the addresses + run the static export:
   ```sh
   export NEXT_PUBLIC_SEPOLIA_DEPLOYMENT_ADDRESSES="$(node -e ...read deployments.sepolia.json...)"
   pnpm build && pnpm export
   ```
   `jq` is not preinstalled on the Cloudflare build image — the script
   uses a node one-liner to minify the JSON, which is guaranteed available.
8. Cloudflare deploys `ens-app-v3/out/` to the Pages project. The
   `wrangler.toml`'s `pages_build_output_dir` tells the deploy step
   where to look.

### Routing on a static host

Next.js `rewrites()` in `next.config.mjs` are server-side only and
don't survive `next export`. To make path-based URLs like
`/foobar.testing` and `/foobar.testing/register` work on Cloudflare
Pages, the rewrites are mirrored in `ens-app-v3/public/_redirects`
using Netlify-compatible syntax (which Cloudflare also supports). The
file is copied into `ens-app-v3/out/` by `next export` and Cloudflare
honours it for edge rewrites.

Two caveats:

- **No regex constraints on path placeholders.** Next.js's
  `/:address(0x[a-fA-F0-9]{40}$)` → `/address?address=:address` rule
  can't be expressed in `_redirects`, so the implicit `0x…` profile
  shortcut is dropped. If you need it, route through `/address/0x…`
  explicitly.
- **Order matters.** First match wins. Multi-segment rules
  (`/:name/register`, `/tld/:tld`, etc.) come before the catch-all
  `/:name`. Real static pages (`/admin`, `/import`, `/register`, etc.)
  resolve to their `.html` files because Cloudflare checks static files
  before `_redirects`.

### Limitations

- **No server-side data fetching.** Anything that relied on
  `getServerSideProps` would fail the export step — there is no such
  code in our diff today; revisit if upstream ENS adds one.
- **Deployment freshness.** The address bundle is baked in at build
  time. Re-running `scripts/deploy-testnet.mjs` (or
  `scripts/deploy-mainnet.mjs`) only takes effect after the new
  `deployments.${network}.json` is committed and pushed.
- **Custom-domain icon swap.** If you add a custom domain, update the
  hardcoded `og:image` URL in `src/pages/index.tsx` so social previews
  resolve against the new host.

---

## Frontend env vars

| Variable                                          | Meaning                                          |
|---------------------------------------------------|--------------------------------------------------|
| `NEXT_PUBLIC_DEPLOYMENT_ADDRESSES`                | JSON object of contract addresses (local)        |
| `NEXT_PUBLIC_SEPOLIA_DEPLOYMENT_ADDRESSES`        | JSON object of contract addresses (Sepolia)      |
| `NEXT_PUBLIC_PROVIDER`                            | `http://127.0.0.1:8545` (local only)             |
| `NEXT_PUBLIC_CHAIN_NAME`                          | `localhost` / `sepolia` / `mainnet`              |
| `NEXT_PUBLIC_SIMPLEX_TLD`                         | `testing` or `simplex`                           |
| `NEXT_PUBLIC_IPFS`                                | `1` to enable static-export-friendly routing     |

## Deploy-time env vars

| Variable                                          | Meaning                                          |
|---------------------------------------------------|--------------------------------------------------|
| `DEPLOYER_KEY`                                    | Ephemeral hot key (gas only) — Sepolia / mainnet |
| `SEPOLIA_RPC_URL`                                 | JSON-RPC URL for Sepolia                         |
| `OWNER_ADDRESS`                                   | Final controller owner; defaults to cold key     |
| `SIMPLEX_TLD`                                     | `testing` (default) or `simplex`                 |
| `ETHUSD_FEED`                                     | Override the Chainlink ETH/USD feed              |
| `ETHERSCAN_API_KEY`                               | Etherscan v2 multi-chain key (for verify script) |

---

## Verification

After each deployment:

1. `npx hardhat compile` — no warnings.
2. Run the parent repo Playwright suite against the running frontend:
   `npx playwright test --config playwright.config.ts` — all 19 tests pass.
3. Manual smoke: search for a 6-char name → "Available"; register it; set
   `simplex.contact` and `simplex.channel`; visit `/<name>.testing` (local)
   or `/profile?name=<name>.testing` (Pages) and verify both records show
   as clickable links.
4. Admin panel `/admin`: confirm `minCharLength`, `nftGateEnabled`, owner.
5. Run `npx vitest run` from `ens-contracts/` — 21 SimplexController unit
   tests pass alongside the upstream ENS suite.

## Gotchas

The `CLAUDE.md` at the repo root lists a longer set of build-time gotchas
(Hardhat 3 chainId, `eth_createAccessList`, Multicall3 `aggregate3`, etc.).
Read that file before the first deployment of a new environment.

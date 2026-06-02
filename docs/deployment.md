# Deployment

Three deployment targets — local Hardhat, **Sepolia testnet**, Ethereum
mainnet. Each TLD (`.testing`, `.simplex`) is an independent deployment; run
the playbook once per TLD per network.

## Quick reference

| What                          | Command / Variable                                  |
|-------------------------------|------------------------------------------------------|
| Compile                       | `cd ens-contracts && npx hardhat compile`            |
| Local one-shot                | `./scripts/run-local.sh`                             |
| Local for `.simplex`          | `SIMPLEX_TLD=simplex ./scripts/run-local.sh`         |
| Deploy to Sepolia             | `DEPLOYER_KEY=… SEPOLIA_RPC_URL=… node scripts/deploy-testnet.mjs` |
| Sepolia cold owner            | `OWNER_ADDRESS` env (defaults to the simplexchat.eth cold key) |
| Verify on Etherscan           | `ETHERSCAN_API_KEY=… node scripts/verify-sepolia.mjs`     |
| Addresses output (local)      | stdout + `deployments.local.json`                    |
| Addresses output (Sepolia)    | stdout + `deployments.sepolia.json` + `verification.sepolia.json` |
| Frontend env var (local)      | `NEXT_PUBLIC_DEPLOYMENT_ADDRESSES` (JSON)            |
| Frontend env var (Sepolia)    | `NEXT_PUBLIC_SEPOLIA_DEPLOYMENT_ADDRESSES` (JSON)    |
| TLD env var                   | `NEXT_PUBLIC_SIMPLEX_TLD` (`testing` or `simplex`)   |
| Chain selection               | `NEXT_PUBLIC_CHAIN_NAME` (`localhost`/`sepolia`/`mainnet`) |
| Static build flag             | `NEXT_PUBLIC_IPFS=1` (used by the Pages workflow)    |

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

If you're deploying the dApp via the GitHub Pages workflow, commit
`deployments.sepolia.json` (it's read at build time by the workflow). See the
section below.

### MetaMask setup

- Network: **Sepolia** (`https://eth-sepolia.public.blastapi.io` or your RPC)
- Account: any Sepolia-funded wallet. To register on the gated `.testing`
  TLD, the deployer needs to mint you an SMPXNFT via `MockSMPXNFT.mint(addr)`.

---

## Mainnet

Two separate deployments — `.testing` first, `.simplex` later. Both go to
Ethereum mainnet.

### Pre-flight

- ETH/USD Chainlink feed: `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419`
- SMPXNFT contract: `0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291`
- `OWNER_ADDRESS` — the SNCC multisig (mainnet SAFE). Same ephemeral-
  deployer / cold-owner / two-step `acceptOwnership` model as Sepolia;
  the cold owner here is a multisig rather than an EOA. The full set of
  end-of-deploy ownership transfers (BaseRegistrar, NameWrapper,
  MockSMPXNFT, ReverseRegistrar, DefaultReverseRegistrar, all
  deployer-owned ENS subnodes, ENS root, and SimplexController via
  Ownable2Step) is identical to the Sepolia script.
- Audited `simplex` branch on both ENS forks (the `main...simplex` GitHub
  diff is the audit surface).

### Steps

1. Add a mainnet network to `ens-contracts/hardhat.config.ts` and a
   mainnet variant of `scripts/deploy-testnet.mjs` parameterised by the
   real Chainlink + SMPXNFT addresses.
2. For each TLD:
   - Deploy `ENSRegistry`, `BaseRegistrarImplementation`,
     `ReverseRegistrar`, `NameWrapper`, `PublicResolver`,
     `ExponentialPremiumPriceOracle`, `SimplexController`.
   - `base.addController(SimplexController)`.
   - Set the resolver record for `eth-usd.data.eth` so the frontend's
     `useEthPrice` hook resolves to the Chainlink feed.
3. Push the deployment addresses to the dApp's mainnet env vars and
   redeploy the SPA.
4. Pre-load the reserved-names list via `addReservedName` before opening
   registration.
5. Confirm `minCommitmentAge = 60` and `maxCommitmentAge = 86400`.

Status: pre-launch checklist. The deploy must be reviewed line-by-line on a
real fork before the first transaction.

---

## dApp on GitHub Pages

The workflow at `.github/workflows/deploy-pages.yml` builds the dApp as a
static SPA and deploys it to GitHub Pages on every push to `main`.

### One-time setup

1. In the repo settings → **Pages**, set **Source** to **GitHub Actions**.
2. Commit `deployments.sepolia.json` (output of `scripts/deploy-testnet.mjs`)
   to the repo root. The workflow reads it via `jq` and injects it into
   `NEXT_PUBLIC_SEPOLIA_DEPLOYMENT_ADDRESSES` at build time.
3. (Optional) If you want a custom domain, configure it in repo settings
   and add a `CNAME` file with the apex name into the workflow's `out/`
   directory before the upload step.

### What the workflow does

1. Checks out the repo with `submodules: recursive`.
2. Installs deps in the parent and both submodules.
3. Compiles ENS contracts (the frontend pulls ABIs from these artefacts).
4. Loads `deployments.sepolia.json` into a workflow output via `jq -c`.
5. Builds the SPA with:
   - `NEXT_PUBLIC_IPFS=1` — flips the ENS app to its existing
     query-string-based routing (path-based URLs like `/<name>.testing`
     work only with a runtime rewrite layer that doesn't exist on static
     hosts; the IPFS variant routes through `/profile?name=…` instead).
   - `NEXT_PUBLIC_CHAIN_NAME=sepolia`, `NEXT_PUBLIC_SIMPLEX_TLD=testing`,
     `NEXT_PUBLIC_SEPOLIA_DEPLOYMENT_ADDRESSES=<JSON>`.
6. Runs `pnpm build && pnpm export` and emits a `.nojekyll` marker so
   Pages serves the `_next/` directory without Jekyll filtering.
7. Uploads `ens-app-v3/out/` as a Pages artefact and deploys it.

### Limitations

- **No server-side rewrites.** The IPFS routing layer is route-equivalent
  but URLs look like `/profile?name=alice.testing` rather than
  `/alice.testing`.
- **No SSG/SSR data fetching.** Anything that relied on
  `getServerSideProps` would fail the export step — there is no such code
  in our diff today; revisit if upstream ENS adds one.
- **Deployment freshness.** The Sepolia addresses are baked in at build
  time. Re-running `scripts/deploy-testnet.mjs` only takes effect after
  you commit + push the updated `deployments.sepolia.json`.

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

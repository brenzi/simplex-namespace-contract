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
| Addresses output (local)      | stdout + `deployments.local.json`                    |
| Addresses output (Sepolia)    | stdout + `deployments.sepolia.json`                  |
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

- A deployer EOA on Sepolia with **≥ 0.3 SepoliaETH** (a full deploy spends
  roughly 0.2–0.25 ETH). Sources: <https://sepoliafaucet.com>,
  <https://www.alchemy.com/faucets/ethereum-sepolia>.
- A Sepolia RPC URL — Alchemy / Infura / Tenderly all work. Public RPCs
  rate-limit heavily and will choke on the back-to-back tx burst.
- Submodules + dependencies installed and contracts compiled
  (`cd ens-contracts && npx hardhat compile`).

### Deploy

```bash
export DEPLOYER_KEY=0xabc…
export SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<KEY>

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
   - **NFT**: deploys a `MockSMPXNFT` and mints token #0 to the deployer.
     Mint additional NFTs for testers via the contract's `mint(address)`
     function after deployment.
2. Pre-reserves `simplex` and `simplex-chat`.
3. Writes the resulting address bundle to `deployments.sepolia.json`.

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
- Treasury / deploy owner: SNCC multisig
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

# Deployment

This document covers all three deployment targets: local Hardhat, Hoodi
testnet, Ethereum mainnet. Each TLD (`.testing`, `.simplex`) is an independent
deployment — run the playbook once per TLD per network.

## Quick reference

| What                          | Command / Variable                                  |
|-------------------------------|------------------------------------------------------|
| Compile                       | `cd ens-contracts && npx hardhat compile`            |
| Local one-shot                | `./scripts/run-local.sh`                             |
| Local for `.simplex`          | `SIMPLEX_TLD=simplex ./scripts/run-local.sh`         |
| Deploy script (any network)   | `node scripts/deploy-local.mjs` *(local only today)* |
| Addresses output              | stdout + `deployments.local.json`                    |
| Frontend env var              | `NEXT_PUBLIC_DEPLOYMENT_ADDRESSES` (JSON)            |
| TLD env var                   | `NEXT_PUBLIC_SIMPLEX_TLD` (`testing` or `simplex`)   |

---

## Local Hardhat

This is what `./scripts/run-local.sh` does in a single process:

1. `npx hardhat --network hardhat node` — starts Hardhat at `127.0.0.1:8545`
   with chainId **1337** (the `--network hardhat` flag is critical; without
   it, `npx hardhat node` defaults to chainId 31337, which the frontend's
   `localhostWithEns` chain does not recognise).
2. `node scripts/deploy-local.mjs` — deploys the whole stack for the TLD
   selected by `SIMPLEX_TLD` (default `testing`):
   - `ENSRegistry`, `BaseRegistrarImplementation`, `ReverseRegistrar`,
     `DefaultReverseRegistrar`, `NameWrapper`
   - `DummyOracle` (fixed ETH/USD = $1) + `ExponentialPremiumPriceOracle`
   - `MockSMPXNFT`, with token #0 minted to the deployer
   - `SimplexController` (deployed **before** `PublicResolver` so its address
     can be passed as `trustedETHController`)
   - `PublicResolver` (passes the controller address — required, otherwise
     `register()` reverts when writing resolver records)
   - `UniversalResolver`, `Multicall3` (mock with both `aggregate3` and
     `tryAggregate`)
   - `eth-usd.data.eth` resolver record → `DummyOracle` (the frontend's
     `useEthPrice` resolves this name via ENS)
   - All addresses are written to `deployments.local.json` and printed as a
     JSON line prefixed with `NEXT_PUBLIC_DEPLOYMENT_ADDRESSES=`.
3. Starts the Next.js dev server with `NEXT_PUBLIC_DEPLOYMENT_ADDRESSES`,
   `NEXT_PUBLIC_PROVIDER`, and `NEXT_PUBLIC_SIMPLEX_TLD` exported.

### MetaMask setup

- Network: `Hardhat`, RPC `http://127.0.0.1:8545`, Chain ID `1337`
- Test account: import private key
  `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`
  (Hardhat account #0, 10000 ETH, holds SMPXNFT #0)

---

## Hoodi testnet

Hoodi is chain id **560048**. The deploy script `scripts/deploy-local.mjs` is
**not yet adapted to Hoodi** — only the local Hardhat case has been exercised.
To deploy:

1. Add a `hoodi` network to `ens-contracts/hardhat.config.ts`:
   ```ts
   hoodi: {
     type: 'http',
     url: process.env.HOODI_RPC_URL ?? 'https://rpc.hoodi.ethpandaops.io',
     chainId: 560048,
     accounts: [process.env.DEPLOYER_KEY!],
   }
   ```
2. Parameterise the deploy script (use the `RPC_URL` env var that
   `deploy-local.mjs` already accepts) and replace the hard-coded Hardhat
   account #0 import with a real key. Have it persist to
   `deployments.hoodi.json` instead of `deployments.local.json`.
3. Deploy `MockSMPXNFT` once and reuse across both TLDs. Mint at least one
   NFT to each tester account.
4. Use `DummyOracle` (set to a sensible ETH/USD value, e.g. `200000000000`
   for $2,000/ETH) instead of Chainlink — Hoodi does not have ENS price
   feeds.
5. After the script finishes, copy the `deployments.hoodi.json` payload into
   the frontend's `NEXT_PUBLIC_HOODI_DEPLOYMENT_ADDRESSES` env var.
6. Verify the frontend's `getNetworkFromUrl` honours `NEXT_PUBLIC_CHAIN_NAME=hoodi`
   and the Hoodi RPC URL is set via `NEXT_PUBLIC_HOODI_RPC_URL`.

Status: needs the network config and key handling above. Not yet automated.

---

## Mainnet

Two separate deployments — `.testing` first, `.simplex` later. Both go to
Ethereum mainnet.

### Pre-flight

- ETH/USD Chainlink feed address: `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419`
- SMPXNFT contract: `0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291`
- Treasury (deploy owner): SNCC multisig

### Steps

1. Verify forks on `simplex-network/ens-contracts` and
   `simplex-network/ens-app-v3` are rebased on the latest `simplex` branch
   and audited (the `main...simplex` diff on GitHub is the audit surface).
2. Add a mainnet config that mirrors the Hoodi config above but with:
   - `oracleAddress = 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419`
   - `smpxNftAddress = 0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291`
   - `nftGateEnabled = true` for `.testing`, `false` for `.simplex`
   - `minCharLength = 6`
3. For each TLD:
   - Deploy `ENSRegistry` (UUPS proxy), `BaseRegistrarImplementation` (UUPS
     proxy), `ReverseRegistrar`, `NameWrapper`, `PublicResolver`,
     `StablePriceOracle` (or `ExponentialPremiumPriceOracle` wrapping it),
     `SimplexController`.
   - `Root.setSubnodeOwner(namehash(tld), BaseRegistrar)` and lock the root
     so the TLD cannot be re-assigned.
   - `base.addController(SimplexController)`.
   - Set the resolver record for `eth-usd.data.eth` so the frontend's
     `useEthPrice` hook resolves to the Chainlink feed.
4. Push the deployment addresses to the frontend's mainnet env vars and
   redeploy the SPA.
5. Have the deploy owner pre-load the reserved-names list via
   `addReservedName` before opening registration.
6. Set the gas-tightening / commit-reveal ages (`minCommitmentAge = 60`,
   `maxCommitmentAge = 86400`).

Status: not yet automated. Treat this list as the pre-launch checklist; the
deploy must be reviewed line-by-line on a real fork before the first txn.

---

## Frontend env vars

| Variable                                     | Meaning                                          |
|----------------------------------------------|--------------------------------------------------|
| `NEXT_PUBLIC_DEPLOYMENT_ADDRESSES`           | JSON object of contract addresses (local)        |
| `NEXT_PUBLIC_HOODI_DEPLOYMENT_ADDRESSES`     | JSON object of contract addresses (Hoodi)        |
| `NEXT_PUBLIC_PROVIDER`                       | `http://127.0.0.1:8545` (local only)             |
| `NEXT_PUBLIC_HOODI_RPC_URL`                  | Hoodi RPC URL                                    |
| `NEXT_PUBLIC_CHAIN_NAME`                     | `localhost` / `hoodi` / `mainnet`                |
| `NEXT_PUBLIC_SIMPLEX_TLD`                    | `testing` or `simplex`                           |

---

## Verification

After each deployment:

1. `npx hardhat compile` — no warnings.
2. Run the parent repo Playwright suite against the running frontend:
   `npx playwright test --config playwright.config.ts` — all 14 tests pass.
3. Manual smoke: search for a 6-char name → "Available"; register it; set
   `simplex.contact` and `simplex.channel`; visit `/<name>.testing` and
   verify both records show as clickable links.
4. Admin panel `/admin`: confirm `minCharLength`, `nftGateEnabled`, owner.
5. Run `npx vitest run` from `ens-contracts/` — 21 SimplexController unit
   tests pass alongside the upstream ENS suite.

## Gotchas

The `CLAUDE.md` in this repo contains a longer list of build-time gotchas
(Hardhat 3 chainId, `eth_createAccessList`, Multicall3 `aggregate3`, etc.).
Read that file before the first deployment of a new environment.

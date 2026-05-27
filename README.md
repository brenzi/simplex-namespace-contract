# SimpleX Namespace Registry Contract (SNRC)

Decentralized namespace registry for [SimpleX Chat](https://simplex.chat), built as a minimal fork of [ENS](https://ens.domains). Maps human-readable names (`alice.testing`, `bob.simplex`) to SimpleX contact and channel links on Ethereum.

See [`snrc-implementation-plan.md`](./snrc-implementation-plan.md) for the full design and change justification.

## Repository structure

```
simplex-namespace-contract/           ← this repo
  ens-contracts/                      ← submodule: simplex-network/ens-contracts (simplex branch)
  ens-app-v3/                         ← submodule: simplex-network/ens-app-v3 (simplex branch)
  scripts/                            ← deployment scripts
```

## Setup

```bash
git clone --recurse-submodules git@github.com:simplex-network/simplex-namespace-contract.git
cd simplex-namespace-contract
```

Install dependencies in both submodules:

```bash
cd ens-contracts && pnpm install && cd ..
cd ens-app-v3 && pnpm install && cd ..
```

## Compile contracts

```bash
cd ens-contracts && npx hardhat compile
```

## Run tests

```bash
cd ens-contracts && npx vitest run
```

## Local deployment

### 1. Start a local Hardhat node

```bash
cd ens-contracts && npx hardhat node
```

### 2. Deploy contracts (in a second terminal)

```bash
cd ens-contracts && npx hardhat run ../scripts/deploy-local.ts --network localhost
```

Deploy `.simplex` TLD instead of `.testing`:

```bash
cd ens-contracts && SIMPLEX_TLD=simplex npx hardhat run ../scripts/deploy-local.ts --network localhost
```

The script outputs a `NEXT_PUBLIC_DEPLOYMENT_ADDRESSES` line — copy it for the next step.

### 3. Start the frontend (in a third terminal)

```bash
cd ens-app-v3
NEXT_PUBLIC_DEPLOYMENT_ADDRESSES='<paste JSON from step 2>' \
NEXT_PUBLIC_PROVIDER=http://127.0.0.1:8545 \
pnpm dev
```

Open http://localhost:3000. Connect MetaMask to `localhost:8545` using the test mnemonic:

```
test test test test test test test test test test test junk
```

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

## Prerequisites

- Node.js 22+
- pnpm 9+
- MetaMask browser extension

## Setup from scratch

```bash
git clone --recurse-submodules git@github.com:brenzi/simplex-namespace-contract.git
cd simplex-namespace-contract
```

Install dependencies:

```bash
pnpm install                          # parent repo (deploy script)
cd ens-contracts && pnpm install && cd ..
cd ens-app-v3 && pnpm install && cd ..
```

## Compile and test contracts

```bash
cd ens-contracts
npx hardhat compile                   # 166 Solidity files
npx vitest run                        # 1547 tests (1526 ENS + 21 SimplexController)
```

## Run locally

One command starts everything (Hardhat node, deploys contracts, starts frontend):

```bash
./scripts/run-local.sh
```

For `.simplex` TLD instead of `.testing`:

```bash
SIMPLEX_TLD=simplex ./scripts/run-local.sh
```

Open http://localhost:3000.

<details>
<summary>Manual setup (separate terminals)</summary>

**Terminal 1**: Hardhat node

```bash
cd ens-contracts && npx hardhat node
```

**Terminal 2**: Deploy + frontend

```bash
node scripts/deploy-local.mjs
# Copy the NEXT_PUBLIC_DEPLOYMENT_ADDRESSES line from the output, then:
cd ens-app-v3
NEXT_PUBLIC_DEPLOYMENT_ADDRESSES='<paste>' \
NEXT_PUBLIC_PROVIDER=http://127.0.0.1:8545 \
NEXT_PUBLIC_SIMPLEX_TLD=testing \
pnpm dev
```

</details>

## MetaMask setup

1. Add network: **Settings → Networks → Add Network**
   - Network name: `Hardhat`
   - RPC URL: `http://127.0.0.1:8545`
   - Chain ID: `1337`
   - Currency: `ETH`

2. Import test account: **Settings → Import Account → Private Key**
   ```
   0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
   ```
   This is Hardhat account #0 (deployer) — has 10000 ETH and owns NFT #0 (needed for `.testing` registration).

## What to test

### Search (homepage)

- Type a name like `myname` in the search bar — it should auto-complete to `myname.testing`
- Search for a 6+ character name → should show as **Available**
- Search for a 5-character name like `short` → should show as unavailable (min char length is 6)

### Registration flow

> Ignore the warning `Error syncing data`. It only appears on hardhat local testing

1. Search for an available 6+ char name (e.g., `testname`)
2. Click to register → should show pricing in ETH (converted from $1/year via oracle)
3. **Commit** transaction → confirm in MetaMask
4. Wait 60 seconds (commit-reveal delay)
5. **Register** transaction → confirm in MetaMask, pay ETH
6. Name should appear in **My Names**

### NFT gate (`.testing` only)

- Account #0 (deployer) holds NFT #0 — registration should work
- Import account #1 (`0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d`) — has no NFT, registration should fail with `NftRequired`

### Profile / text records

1. After registering a name, go to its profile
2. Edit records → set `simplex.contact` and `simplex.channel` text records
3. Save → confirm transaction
4. Reload → records should persist

### Admin panel

1. Go to http://localhost:3000/admin (must be connected as account #0 = deployer = owner)
2. Should show: controller address, owner, min char length (6), NFT gate (enabled)
3. **Lower min char length**: set to 5 → confirm tx → now 5-char names are registrable
4. **Reserve a name**: type `simplex` → click Reserve → confirm tx → trying to register `simplex.testing` should fail
5. **Unreserve**: unreserve `simplex` → now it's registrable again
6. **Register reserved**: reserve a name, then use "Register Reserved Name" to assign it to a specific address
7. **Disable NFT gate**: click → confirm → now any account can register (one-way, can't re-enable)

#### Lowering the minimum character length

At launch, only names of 6 characters or longer can be registered. The
contract owner can lower this limit over time as the namespace matures —
typically 6 → 5 → 4 → 3 — to ration out shorter, more desirable names.

To lower it from the UI:

1. Connect the deployer (admin) wallet and open http://localhost:3000/admin.
2. In the **Min Character Length** card, type the new minimum (lower than the
   current value) into the input.
3. Click **Set** and confirm the `setMinCharLength` transaction in MetaMask.
4. The status line reports `setMinCharLength confirmed`, then "Min char length"
   re-reads as the new value.
5. Search for a name shorter than the previous floor — the **"Min N chars"**
   tag disappears, the result shows **Available**, and the registration flow
   proceeds normally.

The change is **monotonic — strictly decreasing**. The contract reverts with
`MinCharLengthCanOnlyDecrease` if you submit a value greater than or equal
to the current minimum, so once a length tier opens it cannot be re-closed.

### Known limitations

- **No subgraph**: The ENS app uses The Graph for name queries. Without a local subgraph, some features (name list, search suggestions) may not work fully. Direct contract interactions (registration, profile editing) work.
- **Avatar/images disabled**: Avatar upload and display are intentionally hidden.
- **DNS features disabled**: DNS import page returns blank.
- **Logo placeholder**: SimpleX logo SVGs are text placeholders — replace with real brand assets.

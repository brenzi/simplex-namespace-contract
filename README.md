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

## Managing the set of registered names

Two distinct lifecycles change the on-chain registry: the **genesis state**
baked in by the deploy script, and **post-launch** owner-only operations
exposed through `SimplexController`. The admin panel
(`http://localhost:3000/admin`) is a thin wrapper over the post-launch
functions; you can call the same functions from a script or block explorer if
you prefer.

### Pre-deployment (genesis state)

Before the controller is renounced or handed off, every `.testing` /
`.simplex` deployment can be seeded with names in two ways. Edit
[`scripts/deploy-local.mjs`](./scripts/deploy-local.mjs) (or a copy adapted
for testnet / mainnet) and add the calls below at the end of `main()`, after
`controller` and `publicResolver` are deployed:

1. **Pre-reserve names** — prevents them from being publicly registered. Use
   for trademarks, official SimpleX names, abuse-prone words, or anything you
   want to hand-assign later.

   ```js
   for (const label of ['simplex', 'admin', 'support', 'help']) {
     await write(controller, 'addReservedName', [label])
   }
   ```

2. **Pre-register a reserved name to a known address** — calls
   `registerReserved(label, owner, duration)` which bypasses the public gate
   checks (length, NFT, even the reserved-name check itself). Use for
   handing out names to founders, partners, or a community multisig before
   the public phase.

   ```js
   const oneYear = 31536000n
   await write(controller, 'registerReserved', ['simplex', officialOwner, oneYear])
   ```

After running the modified deploy script the controller starts in the desired
state — `addReservedName` calls produce an entry in `reservedNames`,
`registerReserved` mints the BaseRegistrar ERC-721 to the chosen owner.

### Post-launch (admin operations)

After deployment the same calls are still available, just gated to the
controller owner. The admin panel exposes them as separate cards:

| What you want                                | Admin-panel card             | Underlying call                              |
|---------------------------------------------|------------------------------|----------------------------------------------|
| Block a name from public registration       | **Reserve a name**           | `addReservedName(label)`                     |
| Restore a name to public registration       | **Unreserve a name**         | `removeReservedName(label)`                  |
| Check whether a name is currently reserved  | **Check Reserved**           | `reservedNames(keccak256(label))` (read-only)|
| Assign a reserved name to a specific address | **Register Reserved Name**  | `registerReserved(label, owner, duration)`   |

Step-by-step (from the UI):

1. Connect the deployer/owner wallet and open `/admin`.
2. **To reserve**: type the bare label (e.g. `simplex`, not `simplex.testing`)
   in the **Reserve a name** input → **Reserve** → confirm tx. Any
   subsequent public `register()` for that label reverts with
   `NameReserved`.
3. **To unreserve**: type the same label in the **Unreserve a name** input →
   **Unreserve** → confirm tx. The name is back in the public pool.
4. **To assign**: fill **Register Reserved Name** with the label, the
   recipient address, and a duration in days. Click **Register**, confirm
   the tx, and the recipient becomes the owner of the BaseRegistrar NFT for
   that labelhash. This works whether or not the name was previously
   reserved — the function bypasses every gate including length, NFT, and
   reserved-name checks.

All four operations require the connected wallet to be `controller.owner()`.
Once the SimpleX namespace is mature you can renounce ownership (`Ownable`
inherits the standard OpenZeppelin pattern) to remove the admin's ability
to mutate this set further; from that point only public registrations and
expiries change the set.

### Verifying the on-chain state

Without a subgraph, the source of truth is the chain. Two quick checks:

- **Was a name reserved?** Read `reservedNames(keccak256("label"))` on the
  controller — returns `true` if reserved.
- **Who owns a name?** Read `ownerOf(uint256(keccak256("label")))` on the
  BaseRegistrar — reverts if the name is unregistered or expired.

The contract addresses are written to `deployments.local.json` after each
local deploy; use that file (or the equivalent for testnet/mainnet) to
target the right contracts.

## Known limitations

- **No subgraph**: The ENS app uses The Graph for name queries. Without a local subgraph, some features (name list, search suggestions) may not work fully. Direct contract interactions (registration, profile editing) work.
- **Avatar/images disabled**: Avatar upload and display are intentionally hidden.
- **DNS features disabled**: DNS import page returns blank.
- **Logo placeholder**: SimpleX logo SVGs are text placeholders — replace with real brand assets.

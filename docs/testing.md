# Testing

Three layers, run from three different directories.

| Layer             | Where                | Runner          | Count today |
|-------------------|----------------------|-----------------|------------:|
| Solidity unit     | `ens-contracts/`     | `npx vitest run` | 21 SNRC + 1526 ENS upstream |
| Frontend unit     | `ens-app-v3/`        | `pnpm test`     | varies (ENS upstream) |
| End-to-end        | parent repo          | `npx playwright test` | 19 |

## Solidity unit tests

The SNRC-specific suite lives in
`ens-contracts/test/simplex/TestSimplexController.test.ts`. It exercises:

- Commit-reveal happy path + too-early / too-late reverts
- NFT gate: blocked for non-holders on `.testing`, allowed on `.simplex`
- Reserved-name add/remove/registerReserved flows
- `setMinCharLength` monotonic-decrease guard
- `disableNftGate` one-way guard
- Ownership / `onlyOwner` access control

Run:

```bash
cd ens-contracts
npx vitest run                    # SNRC + upstream ENS suite, 1547 tests total
npx vitest run test/simplex       # just our additions
```

What's **not** covered in-contract today:

- A full integration test that walks the lifecycle (register → set records →
  transfer → renew → expire → re-register at premium → wrap in NameWrapper →
  admin operations). The plan called for one under
  `test/integration/full-flow.test.ts`. Some of this is covered cross-layer
  by the parent-repo e2e suite (registration + records + admin), but not
  the renew / expire / wrap paths.
- Formal coverage measurement. The plan target was >90% line coverage on
  `SimplexController`; we haven't run `npx hardhat coverage` against the SNRC
  branch yet.

## Frontend unit tests

The ens-app-v3 fork keeps the upstream vitest suite (`pnpm test`) running for
the parts we didn't touch. Most of our additions are exercised by the e2e
suite instead — there are no SNRC-specific frontend unit tests today.

## End-to-end (Playwright)

19 tests in `test/e2e/simplex-flow.spec.ts` in the parent repo. They share
one Hardhat instance and one Next.js dev server (`./scripts/run-local.sh`).

Tests are written so each can run individually against a fresh chain; a few
mutate controller state (admin lowering `minCharLength`, `disableNftGate`,
`addReservedNames`/`removeReservedNames`) and are placed late in the file so
earlier tests see a clean state. Three of the state-mutating tests
**adapt to whatever the current chain state is** (read `minCharLength` first,
lower by 1; `test.skip` when the gate has been disabled by a previous run)
rather than asserting the initial deploy values verbatim.

Run:

```bash
# from the parent repo, with the stack already running
npx playwright test --config playwright.config.ts

# single test
npx playwright test --grep "search shows name as available"
```

### Test catalogue

| Test                                                                                 | What it asserts                                                                                              |
|--------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------|
| `homepage loads and shows search`                                                    | The search box renders                                                                                       |
| `search appends .testing TLD`                                                        | Bare label auto-appends the configured TLD                                                                   |
| `search with connected wallet does not crash`                                        | Smoke test for the wallet-injected variant                                                                   |
| `search shows name as available`                                                     | An unregistered name surfaces the `Available` tag                                                            |
| `clicking available name navigates to registration`                                  | Search → `/register/<name>.testing`                                                                          |
| `full registration flow: commit and register`                                        | The whole UI commit/register flow ends with the **view-name** button                                         |
| `admin panel: view state and manage settings`                                        | `/admin` shows controller state + owner-only sections                                                        |
| `set simplex.contact during registration profile step`                               | Records added during registration are written on-chain                                                       |
| `set simplex.contact after registration via profile editor`                          | Records added via the profile editor are written + displayed                                                 |
| `registration fails for an account without the SMPX NFT`                             | `register()` reverts for a non-NFT-holder (contract-level)                                                   |
| `search marks too-short names with the controller minimum`                           | Search tag shows live `Min N chars`                                                                          |
| `my names lists a name registered by the connected wallet`                           | `/my/names` chain-scan fallback returns the registered name                                                  |
| `registration pricing page shows the SimpleX USD tiers`                              | `SimplexInfoPanel` shows the 4 tier cards with USD prices                                                    |
| `admin lowers min char length and registers a name at the new floor`                 | Reads current min, lowers by 1, registers a name at the new floor; **parametric** in starting state          |
| `NFT-gate banner shows and Next is disabled for a wallet without SMPXNFT`            | Banner + disabled Next button on `.testing`; **skips** if the gate has already been disabled                 |
| `pricing tier highlights the 4-char tier and the invoice agrees`                     | After lowering the limit to 4, a 4-char name highlights the `$32` tier and the FullInvoice shows ~32 ETH    |
| `attempting to register a reserved name shows a clear reserved banner`               | Reserved-name flow: dropdown shows `Reserved`, register page shows banner + disabled Next                    |
| `admin disables NFT gate, then a non-NFT-holder can register`                        | Contract-level: `disableNftGate` then ACCOUNT1 commits + registers successfully                              |
| `reserved name reverts; admin unreserves; same name can then be registered`          | Contract-level: reserved → revert; admin removes; succeeds                                                   |

## Running everything

```bash
# Solidity + ENS upstream
cd ens-contracts && npx vitest run

# Stack + Playwright e2e
cd ..
./scripts/run-local.sh                                                # in one terminal
npx playwright test --config playwright.config.ts                     # in another
```

## Gotchas

- **Port hygiene** — Next.js falls back to 3001 / 3002 / 3003 when 3000 is
  busy from a zombie process. The Playwright config hits port 3000 only;
  always kill stragglers between runs:
  ```bash
  lsof -ti :3000 :3001 :3002 :3003 :8545 | xargs -r kill -9
  ```
- **Hardhat chain time drift** — `evm_increaseTime` only moves forward. The
  full-registration test re-syncs `page.clock` to the post-advance block
  timestamp; if you skip that, the CountdownCircle's wall-clock check stays
  in the past and the finish button never enables.
- **Compile flow** — the frontend reads contract ABIs from
  `ens-contracts/artifacts/` at deploy time. If you change a contract, run
  `npx hardhat compile` before `./scripts/run-local.sh` so the new ABI is
  picked up.
- **State pollution** — three Playwright tests adapt to the current chain
  state (they read `minCharLength` / `nftGateEnabled` and either parametrise
  or skip). The non-adaptive registrar-state tests can still leave names
  registered on the chain; if you re-run a test that uses a fixed label
  (`testname`, etc.), restart the stack to get a clean BaseRegistrar.

The longer running list of build-time gotchas lives in `CLAUDE.md` at the
repo root.

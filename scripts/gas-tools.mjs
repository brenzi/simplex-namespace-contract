/**
 * Frugal gas helpers for live-network deploys.
 *
 * Strategy:
 *   - Submit every tx with `maxPriorityFeePerGas = 0`.
 *   - First attempt: `maxFeePerGas = 10% × currentBaseFee` (probes for a
 *     base-fee crash).
 *   - Watch the tx for 15 min. If still pending, dropped, or otherwise
 *     unmined, bump by √2 (=14142/10000) and resubmit at the same nonce.
 *     Each attempt also re-floors to 10% of the freshly-fetched current
 *     base fee, so a rising base fee can't strand us.
 *   - Up to MAX_ATTEMPTS bumps per tx (~30 → covers ~3000× base headroom).
 *   - Total deploy spend capped by `GAS_BUDGET_ETH`; before each attempt
 *     the runner does a real `estimateGas` for the tx (once per step,
 *     cached across attempts) and refuses to submit if
 *     `gasEstimate × maxFeePerGas` would push spend past the cap. An
 *     estimateGas revert fails the step immediately rather than burning
 *     attempts on a tx that would revert on chain.
 *
 * Resume:
 *   - Every successful tx appends a line to a JSONL journal
 *     (`deployments.${network}.${tld}.journal.jsonl`).
 *   - On startup, the runner loads the journal and skips any step whose
 *     label is already present. Step labels are monotonic (`step:001…N`),
 *     so the deploy script's operation order must be stable across runs.
 *     If you edit the script and insert/reorder steps, delete the journal
 *     and re-deploy.
 *
 * Logging:
 *   - Every attempt (success, drop, timeout, submit-error, budget-block)
 *     gets a JSONL entry in `deployments.${network}.${tld}.attempts.log`.
 *     One-line summaries also print to stderr for live monitoring.
 *
 * Exports:
 *   analyzeAndConfirm({publicClient, account, budgetWei, journalPath, label})
 *     → prints stats + resume state, prompts Y/N (or CONFIRM=yes), returns
 *       { spent, remaining, journal }.
 *
 *   createFrugalDeployer({publicClient, walletClient, account, budgetWei,
 *                         journalPath, attemptsLogPath})
 *     → returns { deploy(name, abi, bytecode, args), write(contract, fn, args),
 *                 spent(), completedSteps() }.
 */
import { encodeDeployData, encodeFunctionData, formatEther } from 'viem'
import { appendFileSync, existsSync, readFileSync } from 'fs'
import readline from 'readline'

const PROBE_BASE_PCT = 10n            // first attempt: 10% of current baseFee
const SQRT2_NUM = 14142n              // √2 ≈ 14142/10000 — bump factor per attempt
const SQRT2_DEN = 10000n
const ATTEMPT_TIMEOUT_MS = 15 * 60 * 1000
const POLL_INTERVAL_MS = 10_000
const POLL_GRACE_MS = 60_000          // grace before null = dropped
const MAX_ATTEMPTS = 30               // safety stop (30 × √2 ≈ 3000× base)
const FEE_HISTORY_BLOCKS = 50         // sample window for upfront stats

const fmtGwei = (wei) => (Number(wei) / 1e9).toFixed(4)
const fmtEth = (wei) => formatEther(wei)
const nowIso = () => new Date().toISOString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function bigMedian(values) {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return sorted[Math.floor(sorted.length / 2)]
}

async function fetchBaseStats(publicClient) {
  const history = await publicClient.request({
    method: 'eth_feeHistory',
    params: [`0x${FEE_HISTORY_BLOCKS.toString(16)}`, 'latest', []],
  })
  const baseFees = history.baseFeePerGas.map(BigInt)
  return {
    current: baseFees[baseFees.length - 1],
    median: bigMedian(baseFees),
  }
}

export function loadJournal(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse)
}

function sumSpent(journal) {
  return journal.reduce((acc, e) => acc + BigInt(e.costWei || 0), 0n)
}

async function promptYesNo(question) {
  if (process.env.CONFIRM === 'yes') {
    console.log(`${question}y  [auto via CONFIRM=yes]`)
    return true
  }
  if (!process.stdin.isTTY) {
    console.error('Not a TTY and CONFIRM!=yes — refusing to proceed.')
    return false
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'y')
    })
  })
}

export async function analyzeAndConfirm({ publicClient, account, budgetWei, journalPath, label }) {
  console.log(`\n=== Frugal deploy analysis: ${label} ===`)
  const { current, median } = await fetchBaseStats(publicClient)

  console.log(`  Recent base fee (last ${FEE_HISTORY_BLOCKS} blocks):`)
  console.log(`    current: ${fmtGwei(current)} gwei`)
  console.log(`    median:  ${fmtGwei(median)} gwei`)

  const journal = loadJournal(journalPath)
  const spent = sumSpent(journal)
  const remaining = budgetWei - spent
  const balance = await publicClient.getBalance({ address: account.address })

  console.log(`\n  Strategy:`)
  console.log(`    priority fee:        0 throughout`)
  console.log(`    first attempt:       10% of current base fee`)
  console.log(`    bump factor:         ×√2 per attempt (floor = 10% of fresh base)`)
  console.log(`    attempt timeout:     ${ATTEMPT_TIMEOUT_MS / 60000} min (poll mempool every ${POLL_INTERVAL_MS / 1000}s)`)
  console.log(`    drop detection:      tx visible then null → bumped; never visible after ${POLL_GRACE_MS / 1000}s grace → bumped`)
  console.log(`    safety stop:         ${MAX_ATTEMPTS} attempts/tx`)
  console.log(`    abort if next tx would push spend past the budget cap`)

  console.log(`\n  Budget:`)
  console.log(`    cap:               ${fmtEth(budgetWei)} ETH`)
  console.log(`    already spent:     ${fmtEth(spent)} ETH  (${journal.length} step${journal.length === 1 ? '' : 's'} in journal)`)
  console.log(`    remaining:         ${fmtEth(remaining)} ETH`)

  console.log(`\n  Deployer:`)
  console.log(`    address:           ${account.address}`)
  console.log(`    balance:           ${fmtEth(balance)} ETH`)

  if (journal.length > 0) {
    console.log(`\n  Resuming from journal:`)
    const tail = journal.slice(-5)
    for (const e of tail) {
      const addrFrag = e.address ? `  → ${e.address}` : ''
      console.log(`    ${e.step.padEnd(10)} ${e.txHash}${addrFrag}`)
    }
    if (journal.length > 5) console.log(`    ... and ${journal.length - 5} earlier step(s)`)
  }

  if (balance < remaining) {
    const shortfall = remaining - balance
    console.log(`\n  ⚠  Balance is BELOW remaining budget by ${fmtEth(shortfall)} ETH.`)
    console.log(`     The budget is the *cap*; the actual spend may be lower, but you`)
    console.log(`     should fund enough to cover the worst case before proceeding.`)
  }

  const ok = await promptYesNo('\nProceed? [y/N] ')
  if (!ok) {
    console.log('Aborted.')
    process.exit(1)
  }
  return { budgetWei, spentWei: spent, journal }
}

export function createFrugalDeployer({
  publicClient, walletClient, account,
  budgetWei, journalPath, attemptsLogPath,
}) {
  const journal = loadJournal(journalPath)
  const completed = new Map(journal.map((e) => [e.step, e]))
  let spent = sumSpent(journal)
  let stepCounter = 0

  function nextLabel() {
    stepCounter += 1
    return `step:${String(stepCounter).padStart(3, '0')}`
  }

  function logAttempt(entry) {
    appendFileSync(attemptsLogPath, JSON.stringify(entry) + '\n')
  }

  function recordSuccess(step, attempt, receipt) {
    const cost = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)
    spent += cost
    const entry = {
      ts: nowIso(),
      step,
      txHash: receipt.transactionHash,
      address: receipt.contractAddress || undefined,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
      costWei: cost.toString(),
      attempts: attempt,
    }
    appendFileSync(journalPath, JSON.stringify(entry) + '\n')
    completed.set(step, entry)
    logAttempt({
      ts: nowIso(), step, attempt, txHash: receipt.transactionHash,
      outcome: 'mined',
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
      gasUsed: receipt.gasUsed.toString(),
      costWei: cost.toString(),
    })
    const what = receipt.contractAddress || receipt.transactionHash.slice(0, 10) + '…'
    console.log(`  ✓ ${step}: ${what}  (${attempt} attempt${attempt === 1 ? '' : 's'}, ${fmtEth(cost)} ETH, spent total ${fmtEth(spent)} ETH)`)
    return entry
  }

  async function watchTx(hash) {
    const start = Date.now()
    let seenInMempool = false
    while (Date.now() - start < ATTEMPT_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS)
      const tx = await publicClient.getTransaction({ hash }).catch(() => null)
      if (tx) {
        seenInMempool = true
        if (tx.blockNumber !== null && tx.blockNumber !== undefined) {
          const receipt = await publicClient.getTransactionReceipt({ hash })
          return { status: 'mined', receipt }
        }
      } else if (seenInMempool) {
        return { status: 'dropped', reason: 'tx no longer in mempool (evicted or replaced)' }
      } else if (Date.now() - start > POLL_GRACE_MS) {
        return { status: 'dropped', reason: `tx never visible after ${POLL_GRACE_MS / 1000}s grace` }
      }
    }
    return { status: 'timeout', reason: `${ATTEMPT_TIMEOUT_MS / 60000}min watch elapsed` }
  }

  async function runStep(step, { to, data, value = 0n }) {
    if (completed.has(step)) {
      const e = completed.get(step)
      console.log(`  ↻ ${step}: already in journal (${e.txHash}) — skipped`)
      return e
    }

    // Real gas estimate for this exact tx. A revert here means the tx
    // would fail on submission — fail fast instead of burning attempts.
    // Cached for the whole step's attempt loop (gas use is independent
    // of maxFee, only the price varies).
    let gasEstimate
    try {
      const raw = await publicClient.estimateGas({
        account: account.address, to, data, value,
      })
      // 10% safety margin: block state shifts can move actual usage
      // slightly. Cost is paid at effectiveGasPrice × actualGasUsed,
      // so the margin only widens the budget guard, not the bill.
      gasEstimate = (raw * 110n) / 100n
      logAttempt({
        ts: nowIso(), step, attempt: 0,
        outcome: 'estimated', gasEstimate: gasEstimate.toString(),
        gasEstimateRaw: raw.toString(),
      })
      console.log(`  [${step}] estimated gas: ${gasEstimate.toLocaleString()} (raw ${raw.toLocaleString()} + 10%)`)
    } catch (e) {
      const msg = e.shortMessage || e.message || String(e)
      logAttempt({
        ts: nowIso(), step, attempt: 0,
        outcome: 'estimate-error', reason: msg,
      })
      throw new Error(`[${step}] estimateGas reverted — would fail on chain: ${msg}`)
    }

    const hashes = []
    let maxFee = 0n

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const block = await publicClient.getBlock({ blockTag: 'latest' })
      const base = block.baseFeePerGas
      const probeFloor = (base * PROBE_BASE_PCT) / 100n

      if (attempt === 1) {
        maxFee = probeFloor
      } else {
        const bumped = (maxFee * SQRT2_NUM) / SQRT2_DEN
        maxFee = bumped > probeFloor ? bumped : probeFloor
      }

      // Budget guard using the step's real gas estimate.
      const projected = maxFee * gasEstimate
      if (spent + projected > budgetWei) {
        logAttempt({
          ts: nowIso(), step, attempt,
          maxFee: maxFee.toString(), baseFeeAtSubmit: base.toString(),
          gasEstimate: gasEstimate.toString(),
          outcome: 'budget-block',
          reason: `projected ${fmtEth(projected)} ETH (${gasEstimate.toLocaleString()} gas × ${fmtGwei(maxFee)} gwei) would push spend past the ${fmtEth(budgetWei)} ETH cap`,
        })
        throw new Error(
          `[${step}] would exceed budget cap (${fmtEth(spent)} spent, ` +
            `${fmtEth(projected)} projected for next attempt, ${fmtEth(budgetWei)} cap)`,
        )
      }

      const nonce = await publicClient.getTransactionCount({
        address: account.address, blockTag: 'pending',
      })

      let hash
      try {
        hash = await walletClient.sendTransaction({
          to, data, value, nonce,
          maxFeePerGas: maxFee, maxPriorityFeePerGas: 0n,
        })
      } catch (e) {
        const msg = e.shortMessage || e.message || String(e)
        logAttempt({
          ts: nowIso(), step, attempt,
          maxFee: maxFee.toString(), baseFeeAtSubmit: base.toString(),
          outcome: 'submit-error', reason: msg,
        })
        console.warn(`  [${step}] attempt ${attempt}: submit failed — ${msg}`)
        // A previous-attempt hash might have mined while we were stalled.
        for (const h of hashes) {
          const r = await publicClient.getTransactionReceipt({ hash: h }).catch(() => null)
          if (r) return recordSuccess(step, attempt, r)
        }
        // Persistent errors should not retry forever.
        if (/insufficient funds|nonce too low/i.test(msg)) throw e
        // Bumpable errors (e.g. "tx underpriced", "fee too low"): continue.
        continue
      }
      hashes.push(hash)
      logAttempt({
        ts: nowIso(), step, attempt, txHash: hash,
        maxFee: maxFee.toString(), baseFeeAtSubmit: base.toString(),
        outcome: 'submitted',
      })
      console.log(
        `  [${step}] attempt ${attempt}/${MAX_ATTEMPTS}: ${hash}` +
          `  (maxFee=${fmtGwei(maxFee)} gwei, base=${fmtGwei(base)} gwei = ${fmtGwei(maxFee * 100n / base)}%)`,
      )

      const outcome = await watchTx(hash)
      if (outcome.status === 'mined') {
        return recordSuccess(step, attempt, outcome.receipt)
      }
      // Check whether an earlier replaced hash actually mined while we were watching.
      for (const h of hashes) {
        const r = await publicClient.getTransactionReceipt({ hash: h }).catch(() => null)
        if (r) return recordSuccess(step, attempt, r)
      }
      logAttempt({
        ts: nowIso(), step, attempt, txHash: hash,
        maxFee: maxFee.toString(), baseFeeAtSubmit: base.toString(),
        outcome: outcome.status, reason: outcome.reason,
      })
      console.log(`  [${step}] ${outcome.status} — ${outcome.reason}`)
    }
    throw new Error(`[${step}] exhausted ${MAX_ATTEMPTS} attempts`)
  }

  return {
    completedSteps: () => completed,
    spent: () => spent,

    deploy: async (name, abi, bytecode, args = []) => {
      const step = nextLabel()
      if (completed.has(step)) {
        const e = completed.get(step)
        console.log(`  ↻ ${step} (${name}): already in journal → ${e.address}`)
        return { address: e.address, abi }
      }
      const data = encodeDeployData({ abi, bytecode, args })
      const e = await runStep(step, { to: null, data })
      return { address: e.address, abi }
    },

    write: async (contract, fn, args) => {
      const step = nextLabel()
      if (completed.has(step)) {
        const e = completed.get(step)
        console.log(`  ↻ ${step} (${fn}): already in journal (${e.txHash})`)
        return
      }
      const data = encodeFunctionData({ abi: contract.abi, functionName: fn, args })
      await runStep(step, { to: contract.address, data })
    },
  }
}

/**
 * Gas-aware helpers for live-network deploys (mainnet first; testnet later).
 *
 * Two exports:
 *
 *   analyzeAndConfirm({publicClient, account, expectedGas, label})
 *     - Reads `eth_feeHistory` for the recent block window
 *     - Picks a "sub-normal" gas price (25th-percentile priority fee)
 *     - Estimates total deploy cost + required deployer balance
 *     - Prints the summary and pauses for interactive Y/N confirmation
 *       (or auto-yes with `CONFIRM=yes`)
 *     - Returns {maxFeePerGas, maxPriorityFeePerGas} to be used for every
 *       tx in the deploy
 *
 *   createAcceleratingDeployer({publicClient, walletClient, account, gasParams})
 *     - Returns {deploy, write} wrappers around viem's deploy/write paths
 *     - Each tx submits with the chosen gas, waits up to 5 min for
 *       inclusion, then resubmits at the SAME nonce with +30% gas if it
 *       hasn't mined. Up to 5 acceleration attempts before erroring.
 *     - If an earlier (replaced) hash actually got mined while we were
 *       sending the replacement, returns that receipt instead of failing.
 */
import { encodeDeployData, encodeFunctionData } from 'viem'
import readline from 'readline'

// Tuning knobs. Conservative defaults — adjust here if the deploy proves
// to need a different shape, rather than threading kwargs through.
const FEE_HISTORY_BLOCKS = 50      // sample size for the priority-fee percentile
const PRIORITY_PERCENTILE = 25     // 25th percentile = "sub-normal" priority
const MAXFEE_BASE_MULT = 2n        // maxFee = MAXFEE_BASE_MULT × baseFee + priority
const ACCEL_TIMEOUT_MS = 5 * 60 * 1000
const ACCEL_BUMP_PCT = 30n         // +30% per acceleration attempt
const ACCEL_MAX_ATTEMPTS = 5
const PRIORITY_FLOOR = 100_000_000n  // 0.1 gwei — never go below this

const fmtGwei = (wei) => (Number(wei) / 1e9).toFixed(3)
const fmtEth = (wei) => (Number(wei) / 1e18).toFixed(4)

function bigMedian(values) {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return sorted[Math.floor(sorted.length / 2)]
}

async function fetchFeeStats(publicClient) {
  // viem doesn't ship a typed eth_feeHistory wrapper; raw .request works.
  const history = await publicClient.request({
    method: 'eth_feeHistory',
    params: [
      `0x${FEE_HISTORY_BLOCKS.toString(16)}`,
      'latest',
      [PRIORITY_PERCENTILE],
    ],
  })
  const baseFees = history.baseFeePerGas.map(BigInt)
  // `reward` may be missing or empty on some RPCs; tolerate it.
  const priorityFees = (history.reward || [])
    .map((row) => (row && row[0] ? BigInt(row[0]) : 0n))
    .filter((v) => v > 0n)
  return { baseFees, priorityFees }
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

export async function analyzeAndConfirm({ publicClient, account, expectedGas, label = 'deploy' }) {
  console.log(`\n=== Gas analysis: ${label} ===`)
  const { baseFees, priorityFees } = await fetchFeeStats(publicClient)
  const currentBase = baseFees[baseFees.length - 1]
  const medianBase = bigMedian(baseFees)
  const medianPriority = priorityFees.length > 0 ? bigMedian(priorityFees) : PRIORITY_FLOOR

  console.log(`  Recent ${FEE_HISTORY_BLOCKS}-block stats:`)
  console.log(`    base fee (current):    ${fmtGwei(currentBase)} gwei`)
  console.log(`    base fee (median):     ${fmtGwei(medianBase)} gwei`)
  console.log(`    p${PRIORITY_PERCENTILE} priority (median):  ${fmtGwei(medianPriority)} gwei`)

  const maxPriorityFeePerGas =
    medianPriority > PRIORITY_FLOOR ? medianPriority : PRIORITY_FLOOR
  // 2× headroom over current base means one +30% acceleration bump
  // (1.3× priority + ~1× base) still fits comfortably under maxFee.
  const maxFeePerGas = currentBase * MAXFEE_BASE_MULT + maxPriorityFeePerGas

  console.log(`\n  Chosen gas params (sub-normal — p${PRIORITY_PERCENTILE}):`)
  console.log(`    maxPriorityFeePerGas:  ${fmtGwei(maxPriorityFeePerGas)} gwei`)
  console.log(`    maxFeePerGas:          ${fmtGwei(maxFeePerGas)} gwei`)
  console.log(`    expected wait per tx:  ~1–5 blocks at normal load`)
  console.log(`    acceleration:          +${ACCEL_BUMP_PCT}% gas after ${ACCEL_TIMEOUT_MS / 60000}min,`)
  console.log(`                           up to ${ACCEL_MAX_ATTEMPTS} attempts per tx`)

  const estimatedCost = expectedGas * maxFeePerGas
  const requiredBalance = (estimatedCost * 150n) / 100n
  const balance = await publicClient.getBalance({ address: account.address })

  console.log(`\n  Cost estimate:`)
  console.log(`    expected total gas:    ${expectedGas.toLocaleString()} units`)
  console.log(`    estimated cost:        ${fmtEth(estimatedCost)} ETH`)
  console.log(`    recommended balance:   ${fmtEth(requiredBalance)} ETH  (×1.5 safety buffer)`)
  console.log(`\n  Deployer:`)
  console.log(`    address:               ${account.address}`)
  console.log(`    current balance:       ${fmtEth(balance)} ETH`)

  if (balance < requiredBalance) {
    const shortfall = requiredBalance - balance
    console.log(`\n  ⚠  Balance is BELOW recommended. Top up at least ${fmtEth(shortfall)} ETH`)
    console.log(`     before proceeding.`)
  } else {
    console.log(`\n  ✓  Balance covers the recommended buffer.`)
  }

  const ok = await promptYesNo('\nProceed with deploy? [y/N] ')
  if (!ok) {
    console.log('Aborted.')
    process.exit(1)
  }
  return { maxFeePerGas, maxPriorityFeePerGas }
}

export function createAcceleratingDeployer({ publicClient, walletClient, account, gasParams }) {
  async function sendWithAccel({ to, data, value = 0n }, label) {
    const nonce = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: 'pending',
    })
    let maxFeePerGas = gasParams.maxFeePerGas
    let maxPriorityFeePerGas = gasParams.maxPriorityFeePerGas
    const hashes = []

    for (let attempt = 1; attempt <= ACCEL_MAX_ATTEMPTS; attempt++) {
      const hash = await walletClient.sendTransaction({
        to, data, value, nonce, maxFeePerGas, maxPriorityFeePerGas,
      })
      hashes.push(hash)
      console.log(
        `  [${label}] attempt ${attempt}/${ACCEL_MAX_ATTEMPTS}  ${hash}` +
          `  (maxFee=${fmtGwei(maxFeePerGas)} gwei)`,
      )

      try {
        return await publicClient.waitForTransactionReceipt({
          hash, timeout: ACCEL_TIMEOUT_MS,
        })
      } catch {
        // Maybe an earlier (replaced) hash got mined first — check them all.
        for (const h of hashes) {
          const r = await publicClient.getTransactionReceipt({ hash: h }).catch(() => null)
          if (r) {
            console.log(`  [${label}] mined as earlier tx ${h}`)
            return r
          }
        }
        if (attempt === ACCEL_MAX_ATTEMPTS) {
          throw new Error(`[${label}] not mined after ${attempt} attempts`)
        }
        maxFeePerGas = (maxFeePerGas * (100n + ACCEL_BUMP_PCT)) / 100n
        maxPriorityFeePerGas = (maxPriorityFeePerGas * (100n + ACCEL_BUMP_PCT)) / 100n
        console.warn(
          `  [${label}] no inclusion in ${ACCEL_TIMEOUT_MS / 60000}min` +
            `; bumping to ${fmtGwei(maxFeePerGas)} gwei and resubmitting at same nonce`,
        )
      }
    }
    throw new Error(`[${label}] exhausted acceleration attempts`)
  }

  async function deploy(name, abi, bytecode, args = []) {
    const data = encodeDeployData({ abi, bytecode, args })
    const receipt = await sendWithAccel({ to: null, data }, `deploy ${name}`)
    console.log(`${name}: ${receipt.contractAddress}`)
    return { address: receipt.contractAddress, abi }
  }

  async function write(contract, functionName, args) {
    const data = encodeFunctionData({ abi: contract.abi, functionName, args })
    await sendWithAccel({ to: contract.address, data }, functionName)
  }

  return { deploy, write }
}

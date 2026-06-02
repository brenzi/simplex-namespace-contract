#!/usr/bin/env node
/**
 * Deploy a fresh ExponentialPremiumPriceOracle on Sepolia. Use this when the
 * admin wants to switch the active price oracle on SimplexController without
 * a full controller redeploy.
 *
 * After this script prints the new oracle address, the cold owner submits:
 *
 *   SimplexController.setPriceOracle(<new oracle address>)
 *
 * to make the new prices take effect on chain.
 *
 * Required env vars:
 *   DEPLOYER_KEY        - hex private key of the (ephemeral) deployer EOA
 *   SEPOLIA_RPC_URL     - JSON-RPC URL for Sepolia
 *
 * Optional env vars:
 *   PRICES              - comma-separated USD/sec rates for 1/2/3/4/5+ chars.
 *                         Defaults to "0,0,4056075240196,1014018810049,31688087814"
 *                         which is the production curve ($1 / $8 / $32 / $128).
 *                         Use "0,0,0,0,0" for free (gas-only) registration.
 *   ETHUSD_FEED         - override the Chainlink ETH/USD feed (default = mainnet
 *                         Chainlink Sepolia feed used by deploy-testnet.mjs)
 *   START_PREMIUM       - initial dutch-auction premium in USD (default = 1e8 * 1e18)
 *   TOTAL_DAYS          - premium decay window (default = 21)
 *
 * Outputs the new oracle address to stdout and appends a one-line record to
 * `oracles.sepolia.json` (a running log of every oracle ever deployed).
 *
 * Run from the parent repo:
 *   DEPLOYER_KEY=0x... SEPOLIA_RPC_URL=https://... PRICES="0,0,0,0,0" \
 *     node scripts/deploy-oracle.mjs
 */
import { createPublicClient, createWalletClient, http } from 'viem'
import { sepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ARTIFACTS = join(__dirname, '..', 'ens-contracts', 'artifacts', 'contracts')

const rpcUrl = process.env.SEPOLIA_RPC_URL
const deployerKey = process.env.DEPLOYER_KEY
const ethUsdFeed = process.env.ETHUSD_FEED || '0x694AA1769357215DE4FAC081bf1f309aDC325306'
const pricesStr = process.env.PRICES || '0,0,4056075240196,1014018810049,31688087814'
const startPremium = BigInt(process.env.START_PREMIUM || '100000000000000000000000000')
const totalDays = BigInt(process.env.TOTAL_DAYS || '21')

if (!deployerKey) {
  console.error('ERROR: DEPLOYER_KEY env var is required.')
  process.exit(1)
}
if (!rpcUrl) {
  console.error('ERROR: SEPOLIA_RPC_URL env var is required.')
  process.exit(1)
}

const rentPrices = pricesStr.split(',').map((s) => BigInt(s.trim()))
if (rentPrices.length !== 5) {
  console.error(
    `ERROR: PRICES must be 5 comma-separated integers, got ${rentPrices.length}.`,
  )
  process.exit(1)
}

const account = privateKeyToAccount(deployerKey)
const transport = http(rpcUrl)
const publicClient = createPublicClient({ chain: sepolia, transport })
const walletClient = createWalletClient({ chain: sepolia, transport, account })

function loadArtifact(path) {
  const full = join(ARTIFACTS, path)
  const json = JSON.parse(readFileSync(full, 'utf8'))
  return { abi: json.abi, bytecode: json.bytecode }
}

async function main() {
  console.log(`Deploying ExponentialPremiumPriceOracle to Sepolia`)
  console.log(`  Deployer:   ${account.address}`)
  console.log(`  Chainlink:  ${ethUsdFeed}`)
  console.log(`  Prices:     [${rentPrices.join(', ')}]`)
  console.log(`  Premium:    ${startPremium}`)
  console.log(`  Total days: ${totalDays}\n`)

  const { abi, bytecode } = loadArtifact(
    'ethregistrar/ExponentialPremiumPriceOracle.sol/ExponentialPremiumPriceOracle.json',
  )
  const hash = await walletClient.deployContract({
    abi,
    bytecode,
    args: [ethUsdFeed, rentPrices, startPremium, totalDays],
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  const oracleAddress = receipt.contractAddress
  console.log(`Deployed: ${oracleAddress}`)
  console.log(`Tx:       ${hash}\n`)

  // Append a record to oracles.sepolia.json so the admin can roll back to a
  // previous oracle without redeploying. One entry per deploy run.
  const logPath = join(__dirname, '..', 'oracles.sepolia.json')
  const log = existsSync(logPath) ? JSON.parse(readFileSync(logPath, 'utf8')) : []
  log.push({
    address: oracleAddress,
    txHash: hash,
    blockNumber: Number(receipt.blockNumber),
    rentPrices: rentPrices.map(String),
    usdOracle: ethUsdFeed,
    startPremium: startPremium.toString(),
    totalDays: totalDays.toString(),
  })
  writeFileSync(logPath, JSON.stringify(log, null, 2))
  console.log(`Recorded in ${logPath}`)

  console.log(`\nTo activate, the cold owner submits:`)
  console.log(`  SimplexController.setPriceOracle(${oracleAddress})`)
  console.log(`\nTo verify on Etherscan, copy these constructor args into`)
  console.log(`verification.sepolia.json and re-run scripts/verify-sepolia.mjs:`)
  console.log(JSON.stringify({
    PriceOracle: oracleAddress,
    priceOracleConstructorArgs: {
      usdOracle: ethUsdFeed,
      rentPrices: rentPrices.map(String),
      startPremium: startPremium.toString(),
      totalDays: totalDays.toString(),
    },
  }, null, 2))
}

main().catch((err) => { console.error(err); process.exit(1) })

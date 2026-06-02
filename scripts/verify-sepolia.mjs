#!/usr/bin/env node
/**
 * Submit SimplexController impl + ERC1967 proxy to Etherscan for
 * source verification. Runs against Sepolia by default.
 *
 * Required env vars:
 *   ETHERSCAN_API_KEY  - V2 multi-chain key (etherscan.io account → API keys)
 *
 * Optional:
 *   ETHERSCAN_CHAIN_ID - target chain (default 11155111 = Sepolia)
 *
 * Reads:
 *   verification.sepolia.json  (written by deploy-testnet.mjs)
 *   ens-contracts/artifacts/build-info/*.json
 *
 * Run after deploy-testnet.mjs:
 *   ETHERSCAN_API_KEY=... node scripts/verify-sepolia.mjs
 *
 * Adding more contracts: extend the TARGETS array. Each entry needs
 * the source file path, the contract name as it appears in solc output,
 * the deployed address, and ABI-encoded constructor args (or '0x').
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { encodeAbiParameters } from 'viem'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const ARTIFACTS_ROOT = join(REPO_ROOT, 'ens-contracts', 'artifacts')

const apiKey = process.env.ETHERSCAN_API_KEY
const chainId = process.env.ETHERSCAN_CHAIN_ID || '11155111'

if (!apiKey) {
  console.error('ERROR: ETHERSCAN_API_KEY env var is required.')
  process.exit(1)
}

const verificationFile = join(REPO_ROOT, 'verification.sepolia.json')
const meta = JSON.parse(readFileSync(verificationFile, 'utf8'))

const proxyConstructorArgs = encodeAbiParameters(
  [{ type: 'address' }, { type: 'bytes' }],
  [meta.SimplexControllerImpl, meta.proxyInitData],
)

// Each target points at a Hardhat artifact JSON (relative to
// ens-contracts/artifacts/). The artifact carries `inputSourceName`,
// `contractName`, and `buildInfoId` — all we need to assemble the
// Etherscan submission. Add entries here for additional contracts.
const TARGETS = [
  {
    label: 'SimplexController (implementation)',
    address: meta.SimplexControllerImpl,
    artifact: 'contracts/simplex/SimplexController.sol/SimplexController.json',
    constructorArgs: '0x',
  },
  {
    label: 'SimplexControllerProxy (ERC1967)',
    address: meta.SimplexControllerProxy,
    artifact: 'contracts/simplex/SimplexControllerProxy.sol/SimplexControllerProxy.json',
    constructorArgs: proxyConstructorArgs,
  },
]

// Price oracle is optional in the metadata (only present from deploy-testnet
// onward; earlier `verification.sepolia.json` files won't have it).
if (meta.PriceOracle && meta.priceOracleConstructorArgs) {
  const a = meta.priceOracleConstructorArgs
  const oracleConstructorArgs = encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'uint256[]' },
      { type: 'uint256' },
      { type: 'uint256' },
    ],
    [
      a.usdOracle,
      a.rentPrices.map((s) => BigInt(s)),
      BigInt(a.startPremium),
      BigInt(a.totalDays),
    ],
  )
  TARGETS.push({
    label: 'ExponentialPremiumPriceOracle',
    address: meta.PriceOracle,
    artifact:
      'contracts/ethregistrar/ExponentialPremiumPriceOracle.sol/ExponentialPremiumPriceOracle.json',
    constructorArgs: oracleConstructorArgs,
  })
}

function loadArtifactAndBuildInfo(artifactRelPath) {
  const art = JSON.parse(readFileSync(join(ARTIFACTS_ROOT, artifactRelPath), 'utf8'))
  const buildInfoPath = join(
    ARTIFACTS_ROOT,
    'build-info',
    `${art.buildInfoId}.json`,
  )
  const buildInfo = JSON.parse(readFileSync(buildInfoPath, 'utf8'))
  return { art, buildInfo }
}

const ETHERSCAN_API = 'https://api.etherscan.io/v2/api'

async function verify(target) {
  console.log(`\n--- ${target.label} ---`)
  console.log(`  address: ${target.address}`)

  const { art, buildInfo } = loadArtifactAndBuildInfo(target.artifact)
  const compilerversion = `v${buildInfo.solcLongVersion}`
  console.log(`  compiler: ${compilerversion}`)
  console.log(`  source:   ${art.inputSourceName}:${art.contractName}`)

  const body = new URLSearchParams({
    module: 'contract',
    action: 'verifysourcecode',
    contractaddress: target.address,
    sourceCode: JSON.stringify(buildInfo.input),
    codeformat: 'solidity-standard-json-input',
    contractname: `${art.inputSourceName}:${art.contractName}`,
    compilerversion,
    constructorArguements: target.constructorArgs.replace(/^0x/, ''),
  })

  const url = `${ETHERSCAN_API}?chainid=${chainId}&apikey=${apiKey}`
  const res = await fetch(url, { method: 'POST', body })
  const json = await res.json()
  if (json.status !== '1') {
    console.error(`  FAILED: ${json.result || json.message}`)
    return null
  }
  const guid = json.result
  console.log(`  submitted, guid=${guid}`)
  return guid
}

async function pollStatus(guid) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 6000))
    const url = `${ETHERSCAN_API}?chainid=${chainId}&apikey=${apiKey}&module=contract&action=checkverifystatus&guid=${guid}`
    const res = await fetch(url)
    const json = await res.json()
    if (json.result === 'Pending in queue') {
      process.stdout.write('.')
      continue
    }
    process.stdout.write('\n')
    if (json.status === '1') return { ok: true, msg: json.result }
    return { ok: false, msg: json.result }
  }
  return { ok: false, msg: 'timed out after 2 minutes' }
}

let failures = 0
for (const t of TARGETS) {
  const guid = await verify(t)
  if (!guid) {
    failures++
    continue
  }
  const status = await pollStatus(guid)
  console.log(`  ${status.ok ? 'OK' : 'FAIL'}: ${status.msg}`)
  if (!status.ok) failures++
}

if (failures > 0) {
  console.error(`\n${failures} contract(s) failed verification.`)
  process.exit(1)
}
console.log('\nAll contracts verified.')

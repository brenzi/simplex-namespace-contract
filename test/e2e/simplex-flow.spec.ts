/**
 * End-to-end tests for SimpleX Namespace.
 *
 * Requires: ./scripts/run-local.sh running (Hardhat node + contracts + frontend)
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  injectHeadlessWeb3Provider,
  Web3RequestKind,
} from '@ensdomains/headless-web3-provider'
import { localhost } from 'viem/chains'

const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const ACCOUNT1_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

const hardhatChain = {
  ...localhost,
  id: 1337,
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
}

async function advanceTime(seconds: number) {
  await fetch('http://127.0.0.1:8545', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'evm_increaseTime', params: [seconds], id: 1 }),
  })
  await fetch('http://127.0.0.1:8545', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'evm_mine', params: [], id: 2 }),
  })
}

async function getBlockTimestamp(): Promise<number> {
  const res = await fetch('http://127.0.0.1:8545', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getBlockByNumber', params: ['latest', false], id: 1 }),
  })
  const { result } = await res.json()
  return parseInt(result.timestamp, 16)
}

async function syncBrowserClockToChain(page: any, offset: number = 0) {
  const blockTs = await getBlockTimestamp()
  await page.clock.install({ time: new Date((blockTs + offset) * 1000) })
}

async function connectWallet(page: any, wallet: any) {
  const connectButton = page.locator('[data-testid="connect-button"]').first()
  await connectButton.waitFor({ timeout: 10_000 })
  await connectButton.click()
  await page.waitForTimeout(1000)

  await page.getByText('Headless Web3 Provider').click()
  await page.waitForTimeout(500)

  const hasPerm = async () => wallet.getPendingRequestCount(Web3RequestKind.RequestPermissions) >= 1
  const hasAcct = async () => wallet.getPendingRequestCount(Web3RequestKind.RequestAccounts) >= 1

  for (let i = 0; i < 20; i++) { if (await hasPerm()) break; await page.waitForTimeout(250) }
  if (await hasPerm()) await wallet.authorize(Web3RequestKind.RequestPermissions)

  for (let i = 0; i < 20; i++) { if (await hasAcct()) break; await page.waitForTimeout(250) }
  if (await hasAcct()) await wallet.authorize(Web3RequestKind.RequestAccounts)

  await page.waitForTimeout(2000)
}

async function dismissOverlay(page: any) {
  const overlay = page.locator('[data-nextjs-dialog]')
  if (await overlay.isVisible({ timeout: 2000 }).catch(() => false)) {
    await page.locator('button[aria-label="Close"]').first().click().catch(() => {})
    await page.waitForTimeout(500)
  }
}

async function confirmTransaction(page: any, wallet: any) {
  const confirmBtn = page.getByTestId('transaction-modal-confirm-button')
  await confirmBtn.waitFor({ timeout: 10_000 })
  await confirmBtn.click()
  await wallet.authorize(Web3RequestKind.SendTransaction)
  await page.waitForTimeout(2000)
}

// Add a single record (key=value) via the add-records modal.
// If `key` matches a predefined option (e.g. simplex.contact, com.twitter), uses it;
// otherwise falls back to the "custom" option.
// Must be called from the Profile step (registration) or the Edit Profile modal (post-registration).
async function addProfileRecord(page: any, key: string, value: string) {
  await page.getByTestId('show-add-profile-records-modal-button').click()
  await page.waitForTimeout(500)
  const confirmDlg = page.getByTestId('confirmation-dialog-confirm-button')
  if (await confirmDlg.isVisible({ timeout: 1500 }).catch(() => false)) {
    await confirmDlg.click()
    await page.waitForTimeout(300)
  }
  const predefined = page.getByTestId(`profile-record-option-${key}`)
  const isPredefined = await predefined.isVisible({ timeout: 1000 }).catch(() => false)
  if (isPredefined) {
    await predefined.click()
    await page.getByTestId('add-profile-records-button').click()
    await page.waitForTimeout(500)
    await page.getByTestId(`profile-record-input-input-${key}`).fill(value)
  } else {
    await page.getByTestId('profile-record-option-custom').click()
    await page.getByTestId('add-profile-records-button').click()
    await page.waitForTimeout(500)
    await page.getByTestId('custom-profile-record-input-key').fill(key)
    await page.getByTestId('custom-profile-record-input-value').fill(value)
  }
  await page.waitForTimeout(300)
}

// Register a name end-to-end via direct contract calls (no UI). Used to set up
// state for tests that exercise post-registration flows without dragging in the
// frontend's registration-flow localStorage / cache quirks.
function loadDeployments(): Record<string, `0x${string}`> {
  // Resolve from the test file's location regardless of how the runner sets cwd.
  const path = join(process.cwd(), 'deployments.local.json')
  return JSON.parse(readFileSync(path, 'utf8'))
}

async function registerNameOnChain(label: string, withResolver: boolean = false, privateKey: string = DEPLOYER_KEY) {
  const { createPublicClient, createWalletClient, http, parseAbi } = await import('viem')
  const { privateKeyToAccount } = await import('viem/accounts')
  const account = privateKeyToAccount(privateKey as `0x${string}`)
  const wallet = createWalletClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545'), account })
  const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
  const deps = loadDeployments()
  const controller = deps.ETHRegistrarController
  const resolverAddr = withResolver ? deps.PublicResolver : ('0x0000000000000000000000000000000000000000' as `0x${string}`)
  const abi = parseAbi([
    'function register((string label, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, uint8 reverseRecord, bytes32 referrer)) external payable',
    'function makeCommitment((string label, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, uint8 reverseRecord, bytes32 referrer)) external pure returns (bytes32)',
    'function commit(bytes32) external',
    'function rentPrice(string,uint256) external view returns ((uint256 base, uint256 premium))',
  ])
  const reg = {
    label,
    owner: account.address,
    duration: 31536000n,
    secret: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
    resolver: resolverAddr,
    data: [] as `0x${string}`[],
    reverseRecord: 0,
    referrer: ('0x' + '00'.repeat(32)) as `0x${string}`,
  }
  const commitment = await pub.readContract({ address: controller, abi, functionName: 'makeCommitment', args: [reg] })
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: controller, abi, functionName: 'commit', args: [commitment] }) })
  await advanceTime(65)
  const price = await pub.readContract({ address: controller, abi, functionName: 'rentPrice', args: [label, 31536000n] })
  const value = ((price as any).base + (price as any).premium) * 12n / 10n
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: controller, abi, functionName: 'register', args: [reg], value }) })
}

async function readTextRecord(name: string, key: string): Promise<string | null> {
  const { createPublicClient, http, namehash, encodeFunctionData, decodeFunctionResult, parseAbi } = await import('viem')
  const client = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
  const node = namehash(name)
  const registry = loadDeployments().ENSRegistry
  const registryAbi = parseAbi(['function resolver(bytes32) view returns (address)'])
  const resolver = await client.readContract({ address: registry, abi: registryAbi, functionName: 'resolver', args: [node] })
  if (!resolver || resolver === '0x0000000000000000000000000000000000000000') return null
  const resolverAbi = parseAbi(['function text(bytes32, string) view returns (string)'])
  return await client.readContract({ address: resolver, abi: resolverAbi, functionName: 'text', args: [node, key] })
}

// Drives the registration flow from a connected wallet on the search page.
// If recordsToSet is supplied, adds them via the Profile step before continuing.
async function registerNameOnUI(
  page: any,
  wallet: any,
  uniqueName: string,
  recordsToSet?: Array<{ key: string; value: string }>,
) {
  const searchInput = page.locator('input[placeholder]').first()
  await searchInput.fill(uniqueName)
  await page.waitForTimeout(3000)
  await dismissOverlay(page)

  const result = page.locator('[data-testid="search-result-name"]').first()
  await result.click()
  await page.waitForTimeout(3000)
  await dismissOverlay(page)

  await expect(page.getByRole('heading', { name: /Register/ })).toBeVisible({ timeout: 15_000 })

  // Step 1: Pricing → Next
  await page.getByTestId('next-button').click()
  await page.waitForTimeout(1000)

  // Step 2: Profile — add records if requested, then submit
  const profileSubmit = page.getByTestId('profile-submit-button')
  if (await profileSubmit.isVisible({ timeout: 3000 }).catch(() => false)) {
    if (recordsToSet?.length) {
      for (const r of recordsToSet) await addProfileRecord(page, r.key, r.value)
    }
    await profileSubmit.click()
    await page.waitForTimeout(1000)
  }

  // Step 3: Info → Begin
  const beginButton = page.getByTestId('next-button')
  if (await beginButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await beginButton.click()
    await page.waitForTimeout(1000)
  }

  const closeIcon = page.getByTestId('close-icon')
  if (await closeIcon.isVisible({ timeout: 2000 }).catch(() => false)) {
    await closeIcon.click()
    await page.waitForTimeout(500)
  }

  // Start timer → commit
  await page.getByTestId('start-timer-button').click()
  await page.waitForTimeout(1000)
  await confirmTransaction(page, wallet)

  await expect(page.getByTestId('countdown-circle')).toBeVisible({ timeout: 10_000 })
  await advanceTime(70)
  await syncBrowserClockToChain(page, 70)
  await page.clock.runFor(1000)
  await page.waitForTimeout(1000)

  await expect(page.getByTestId('finish-button')).toBeEnabled({ timeout: 30_000 })
  await page.getByTestId('finish-button').click()
  await page.waitForTimeout(1000)
  await confirmTransaction(page, wallet)

  await expect(page.getByTestId('view-name')).toBeVisible({ timeout: 30_000 })
}

test.describe('SimpleX Namespace', () => {
  test('homepage loads and shows search', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('input[placeholder]').first()).toBeVisible({ timeout: 15_000 })
  })

  test('search appends .testing TLD', async ({ page }) => {
    await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)

    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill('myname')
    await page.waitForTimeout(1000)

    await expect(page.locator('[data-testid="search-result-name"]').first())
      .toContainText('.testing', { timeout: 10_000 })
  })

  test('search with connected wallet does not crash', async ({ page }) => {
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })

    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill('testname')
    await page.waitForTimeout(3000)
    await dismissOverlay(page)

    await expect(page.locator('[data-testid="search-result-name"]').first())
      .toContainText('.testing', { timeout: 10_000 })
  })

  test('search shows name as available', async ({ page }) => {
    page.on('console', (msg) => {
      const text = msg.text()
      if (text.includes('[simplex')) console.log('BROWSER:', text)
    })
    page.on('request', async (request) => {
      if (request.url() === 'http://127.0.0.1:8545/' && request.method() === 'POST') {
        try {
          const body = JSON.parse(request.postData() || '{}')
          if (body.method === 'eth_call' && body.params?.[0]?.to === '0x99bba657f2bbc93c02d617f8ba121cb8fc104acf') {
            console.log('REQ MULTICALL:', JSON.stringify(body.params[0]).slice(0, 500))
          }
        } catch {}
      }
    })
    page.on('response', async (response) => {
      if (response.url() === 'http://127.0.0.1:8545/' && response.request().method() === 'POST') {
        try {
          const body = JSON.parse(response.request().postData() || '{}')
          if (body.method === 'eth_call' && body.params?.[0]?.to === '0x99bba657f2bbc93c02d617f8ba121cb8fc104acf') {
            const respBody = await response.text()
            if (respBody.includes('error')) console.log('RESP MULTICALL ERR:', respBody.slice(0, 300))
          }
        } catch {}
      }
    })
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })

    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill('available')
    await page.waitForTimeout(5000)
    await dismissOverlay(page)

    await expect(page.locator('[data-testid="search-result-name"]').first())
      .toContainText('Available', { timeout: 10_000 })
  })

  test('clicking available name navigates to registration', async ({ page }) => {
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })

    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill('register')
    await page.waitForTimeout(3000)
    await dismissOverlay(page)

    const result = page.locator('[data-testid="search-result-name"]').first()
    await result.click()
    await page.waitForTimeout(3000)
    await dismissOverlay(page)

    await expect(page.getByRole('heading', { name: /Register/ })).toBeVisible({ timeout: 15_000 })
  })

  test('full registration flow: commit and register', async ({ page }) => {
    await syncBrowserClockToChain(page)
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })

    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    // Use a unique name per run to avoid collision with already-registered names
    const uniqueName = `reg${Date.now().toString(36)}`
    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill(uniqueName)
    await page.waitForTimeout(3000)
    await dismissOverlay(page)

    const result = page.locator('[data-testid="search-result-name"]').first()
    await result.click()
    await page.waitForTimeout(3000)
    await dismissOverlay(page)

    // Should be on registration page
    await expect(page.getByRole('heading', { name: /Register/ })).toBeVisible({ timeout: 15_000 })

    // Step 1: Pricing — click next
    const nextButton = page.getByTestId('next-button')
    await nextButton.waitFor({ timeout: 10_000 })
    await nextButton.click()
    await page.waitForTimeout(1000)

    // Step 2: Profile — skip (click submit/next)
    const profileSubmit = page.getByTestId('profile-submit-button')
    if (await profileSubmit.isVisible({ timeout: 3000 }).catch(() => false)) {
      await profileSubmit.click()
      await page.waitForTimeout(1000)
    }

    // Step 3: Info/Begin — click Begin
    const beginButton = page.getByTestId('next-button')
    if (await beginButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await beginButton.click()
      await page.waitForTimeout(1000)
    }

    // Transaction modal may appear — close it
    const closeIcon = page.getByTestId('close-icon')
    if (await closeIcon.isVisible({ timeout: 2000 }).catch(() => false)) {
      await closeIcon.click()
      await page.waitForTimeout(500)
    }

    // Start timer (commit transaction)
    const startTimer = page.getByTestId('start-timer-button')
    await startTimer.waitFor({ timeout: 10_000 })
    await startTimer.click()
    await page.waitForTimeout(1000)

    // Confirm commit transaction
    await confirmTransaction(page, wallet)

    // Wait for countdown to appear
    await expect(page.getByTestId('countdown-circle')).toBeVisible({ timeout: 10_000 })

    // Advance chain past minCommitmentAge, then set browser clock well past commit timestamp.
    // Browser cushion = 70s ensures countdown's commitTimestamp + 60000 < Date.now() is satisfied
    // regardless of which block the commit landed in.
    await advanceTime(70)
    await syncBrowserClockToChain(page, 70)
    await page.clock.runFor(1000)
    await page.waitForTimeout(1000)

    // Should show finish button enabled
    await expect(page.getByTestId('finish-button')).toBeEnabled({ timeout: 30_000 })

    // Click finish to start register transaction
    await page.getByTestId('finish-button').click()
    await page.waitForTimeout(1000)

    // Confirm register transaction
    await confirmTransaction(page, wallet)

    // Should show completion — view-name button appears
    await expect(page.getByTestId('view-name')).toBeVisible({ timeout: 30_000 })
  })

  test('admin panel: view state and manage settings', async ({ page }) => {
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })

    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    await page.goto('/admin')
    await page.waitForTimeout(5000)

    await expect(page.locator('text=SimpleX Namespace Admin')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('text=Min char length')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=You are the owner')).toBeVisible({ timeout: 5_000 })
  })

  test('set simplex.contact during registration profile step', async ({ page }) => {
    await syncBrowserClockToChain(page)
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })

    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    const uniqueName = `regp${Date.now().toString(36)}`
    const contactLink = `https://simplex.chat/contact#/?v=2-7&smp=smp%3A%2F%2Fexample-${uniqueName}`

    await registerNameOnUI(page, wallet, uniqueName, [
      { key: 'simplex.contact', value: contactLink },
    ])

    // Verify on-chain that the resolver has the text record set.
    const stored = await readTextRecord(`${uniqueName}.testing`, 'simplex.contact')
    expect(stored).toBe(contactLink)
  })

  test('set simplex.contact after registration via profile editor', async ({ page }) => {
    const uniqueName = `rege${Date.now().toString(36)}`
    const contactLink = `https://simplex.chat/contact#/?v=2-7&smp=smp%3A%2F%2Fexample-${uniqueName}`

    // Pre-register the name + set up a resolver via direct contract call. We need a
    // resolver attached for the profile page to show the Edit Profile action.
    await registerNameOnChain(uniqueName, /* withResolver */ true)

    await syncBrowserClockToChain(page)
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })

    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    await page.goto(`/${uniqueName}.testing`)
    await page.waitForTimeout(8000)
    await dismissOverlay(page)

    const editBtn = page.getByTestId('profile-action-Edit profile')
    await editBtn.waitFor({ timeout: 15_000 })
    await editBtn.click()
    await page.waitForTimeout(1000)

    await addProfileRecord(page, 'simplex.contact', contactLink)

    await page.getByTestId('profile-submit-button').click()
    await page.waitForTimeout(1000)
    await confirmTransaction(page, wallet)
    await page.waitForTimeout(2000)

    // Verify on-chain
    const stored = await readTextRecord(`${uniqueName}.testing`, 'simplex.contact')
    expect(stored).toBe(contactLink)

    // Verify the record actually shows in the profile UI (the bug the user hit:
    // setting a record persisted on-chain but didn't display because the profile
    // didn't fetch unknown keys without a subgraph).
    await page.reload()
    await page.waitForTimeout(5000)
    await dismissOverlay(page)
    const linkLocator = page.getByTestId('social-profile-button-simplex.contact')
    await expect(linkLocator).toBeVisible({ timeout: 15_000 })
    // Display text is the friendly label, not the raw URL
    await expect(linkLocator).toContainText('SimpleX contact')
    // …but the link href points at the actual record value
    await expect(linkLocator).toHaveAttribute('href', contactLink)
  })

  // Documents the contract-enforced NFT gate on the .testing TLD: an account
  // without an SMPXNFT cannot complete a registration. The check sits in
  // SimplexController._checkSimplexGates and only fires during register(), so
  // commit() succeeds. We drive commit via writeContract, then assert that the
  // register() simulation reverts with the NftRequired custom error.
  test('registration fails for an account without the SMPX NFT', async () => {
    const { createPublicClient, createWalletClient, http, parseAbi } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    const account = privateKeyToAccount(ACCOUNT1_KEY as `0x${string}`)
    const wallet = createWalletClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545'), account })
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const controller = loadDeployments().ETHRegistrarController
    const abi = parseAbi([
      'function register((string label, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, uint8 reverseRecord, bytes32 referrer)) external payable',
      'function makeCommitment((string label, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, uint8 reverseRecord, bytes32 referrer)) external pure returns (bytes32)',
      'function commit(bytes32) external',
      'function rentPrice(string,uint256) external view returns ((uint256 base, uint256 premium))',
      'error NftRequired()',
    ])
    const reg = {
      label: `nft${Date.now().toString(36)}`,
      owner: account.address,
      duration: 31536000n,
      secret: ('0x' + 'cc'.repeat(32)) as `0x${string}`,
      resolver: '0x0000000000000000000000000000000000000000' as `0x${string}`,
      data: [] as `0x${string}`[],
      reverseRecord: 0,
      referrer: ('0x' + '00'.repeat(32)) as `0x${string}`,
    }
    const commitment = await pub.readContract({ address: controller, abi, functionName: 'makeCommitment', args: [reg] })
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: controller, abi, functionName: 'commit', args: [commitment] }),
    })
    await advanceTime(65)
    const price = await pub.readContract({ address: controller, abi, functionName: 'rentPrice', args: [reg.label, 31536000n] })
    const value = ((price as any).base + (price as any).premium) * 12n / 10n

    // Pre-flight: confirm the gate is actually on. If a previous test disabled it,
    // this assertion documents the change rather than failing silently.
    const nftGateAbi = parseAbi([
      'function nftGateEnabled() view returns (bool)',
      'function smpxNft() view returns (address)',
    ])
    const gateOn = await pub.readContract({ address: controller, abi: nftGateAbi, functionName: 'nftGateEnabled' })
    const nft = await pub.readContract({ address: controller, abi: nftGateAbi, functionName: 'smpxNft' })
    expect(gateOn).toBe(true)
    const nftBalAbi = parseAbi(['function balanceOf(address) view returns (uint256)'])
    const bal = await pub.readContract({ address: nft, abi: nftBalAbi, functionName: 'balanceOf', args: [account.address] })
    expect(bal).toBe(0n)

    // Now the actual assertion: register() reverts for ACCOUNT1.
    let err: any
    try {
      await pub.simulateContract({ address: controller, abi, functionName: 'register', args: [reg], account, value })
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    // Hardhat returns a generic "Internal error" for custom revert errors instead
    // of the decoded name. The pre-flight checks above (gate on, NFT balance 0) make
    // it unambiguous that the revert is the NFT gate firing.
    expect(err.message).toMatch(/reverted|Internal error/i)
  })

  test('search marks too-short names with the controller minimum', async ({ page }) => {
    await page.goto('/')
    await page.waitForTimeout(2000)
    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill('abc')
    await page.waitForTimeout(3000)
    // The status tag carries the live contract minimum, not just a generic "Too Short"
    const result = page.locator('[data-testid="search-result-name"]').first()
    await expect(result).toContainText(/Min \d+ chars/)
  })

  test('my names lists a name registered by the connected wallet', async ({ page }) => {
    const { keccak256, toBytes } = await import('viem')
    const uniqueName = `mn${Date.now().toString(36)}`
    await registerNameOnChain(uniqueName)
    const labelhash = keccak256(toBytes(uniqueName))

    await syncBrowserClockToChain(page)
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)
    // Seed the ensjs label cache so the on-chain fallback can resolve the labelhash
    // back to the human label. (UI flow already does this on search; we skipped that
    // by registering via direct contract call.)
    await page.evaluate(({ label, hash }) => {
      const cache = JSON.parse(window.localStorage.getItem('ensjs:labels') || '{}')
      cache[hash] = label
      window.localStorage.setItem('ensjs:labels', JSON.stringify(cache))
    }, { label: uniqueName, hash: labelhash })
    await page.goto('/my/names')
    await page.waitForTimeout(8000)
    await dismissOverlay(page)
    const body = await page.textContent('body')
    expect(body).toContain(uniqueName)
  })

  test('registration pricing page shows the SimpleX USD tiers', async ({ page }) => {
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    const uniqueName = `tier${Date.now().toString(36)}`
    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill(uniqueName)
    await page.waitForTimeout(3000)
    await dismissOverlay(page)
    await page.locator('[data-testid="search-result-name"]').first().click()
    await page.waitForTimeout(3000)
    await dismissOverlay(page)

    await expect(page.getByTestId('simplex-info-panel')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('simplex-tier-3')).toContainText('$128')
    await expect(page.getByTestId('simplex-tier-4')).toContainText('$32')
    await expect(page.getByTestId('simplex-tier-5')).toContainText('$8')
    await expect(page.getByTestId('simplex-tier-6')).toContainText('$1')
  })

  test('NFT-gate banner shows and Next is disabled for a wallet without SMPXNFT', async ({ page }) => {
    // ACCOUNT1 has no SMPXNFT — the gate is on for .testing.
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [ACCOUNT1_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    const uniqueName = `nft${Date.now().toString(36)}`
    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill(uniqueName)
    await page.waitForTimeout(3000)
    await dismissOverlay(page)
    await page.locator('[data-testid="search-result-name"]').first().click()
    await page.waitForTimeout(3000)
    await dismissOverlay(page)

    await expect(page.getByTestId('simplex-nft-gate-helper')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('simplex-nft-gate-helper')).toContainText(
      /does not currently hold one/i,
    )
    const nextBtn = page.getByTestId('next-button')
    await expect(nextBtn).toBeDisabled({ timeout: 15_000 })
    await expect(nextBtn).toContainText(/SimpleX NFT required/i)
  })
})

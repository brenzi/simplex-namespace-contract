/**
 * End-to-end tests for SimpleX Namespace.
 *
 * Requires: ./scripts/run-local.sh running (Hardhat node + contracts + frontend)
 */
import { test, expect } from '@playwright/test'
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
})

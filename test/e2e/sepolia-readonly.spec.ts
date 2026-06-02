/**
 * Read-only smoke tests against the live Sepolia SNRC deployment.
 *
 * Run from the parent repo with the dApp already serving on :3000 against
 * Sepolia (NEXT_PUBLIC_CHAIN_NAME=sepolia + addresses):
 *
 *   npx playwright test --project=sepolia
 *
 * Required env vars:
 *   SEPOLIA_TEST_KEY  - hex private key of a Sepolia-funded throwaway EOA
 *                       (read-only tests — needs gas for nothing, but the
 *                       headless wallet still injects this key)
 *   SEPOLIA_RPC_URL   - JSON-RPC URL for Sepolia
 *
 * Tests are deliberately non-mutating:
 *   - no admin tx (would mutate the live testnet)
 *   - no register/commit (would mint NFTs and cost real Sepolia ETH)
 *   - no evm_* (Hardhat-only methods)
 *
 * Each test should be safe to run repeatedly without affecting the chain.
 */
import { test, expect } from '@playwright/test'
import { injectHeadlessWeb3Provider, Web3RequestKind } from '@ensdomains/headless-web3-provider'
import { sepolia } from 'viem/chains'

const SEPOLIA_TEST_KEY = (process.env.SEPOLIA_TEST_KEY || '') as `0x${string}`
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || ''

test.beforeAll(() => {
  if (!SEPOLIA_TEST_KEY || !SEPOLIA_RPC_URL) {
    throw new Error(
      'SEPOLIA_TEST_KEY and SEPOLIA_RPC_URL must be set to run the sepolia project',
    )
  }
})

const sepoliaChain = {
  ...sepolia,
  id: 11155111,
  rpcUrls: { default: { http: [SEPOLIA_RPC_URL] } },
}

async function connectWallet(page: any, wallet: any) {
  const connectButton = page.locator('[data-testid="connect-button"]').first()
  await connectButton.waitFor({ timeout: 15_000 })
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

  await page.waitForTimeout(2500)
}

async function dismissOverlay(page: any) {
  const overlay = page.locator('[data-nextjs-dialog]')
  if (await overlay.isVisible({ timeout: 1500 }).catch(() => false)) {
    await page.locator('button[aria-label="Close"]').first().click().catch(() => {})
    await page.waitForTimeout(400)
  }
}

test.describe('Sepolia SNRC — read-only smoke', () => {
  test('homepage loads and shows search input', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('input[placeholder]').first()).toBeVisible({ timeout: 30_000 })
  })

  test('search appends the .testing TLD', async ({ page }) => {
    await injectHeadlessWeb3Provider({ page, privateKeys: [SEPOLIA_TEST_KEY], chains: [sepoliaChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)

    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill('myname')
    await page.waitForTimeout(2500)

    await expect(page.locator('[data-testid="search-result-name"]').first())
      .toContainText('.testing', { timeout: 15_000 })
  })

  test('homepage shows yellow NFT-gate banner for a wallet without an SMPXNFT', async ({ page }) => {
    // The SEPOLIA_TEST_KEY wallet is intentionally not an SMPXNFT holder —
    // these tests can't safely mint one (gas + permanent state mutation),
    // so this banner is the steady-state we expect.
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [SEPOLIA_TEST_KEY], chains: [sepoliaChain] })
    await page.goto('/')
    await page.waitForTimeout(2500)
    await connectWallet(page, wallet)

    const banner = page.getByRole('alert').filter({ hasText: /SimpleX NFT required/i }).first()
    await expect(banner).toBeVisible({ timeout: 20_000 })
    await expect(banner.locator('a[href*="etherscan.io/token/0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291"]'))
      .toHaveCount(1)
  })

  test('clicking an available name without the NFT shows the SMPXNFT toast and does not navigate', async ({ page }) => {
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [SEPOLIA_TEST_KEY], chains: [sepoliaChain] })
    await page.goto('/')
    await page.waitForTimeout(2500)
    await connectWallet(page, wallet)

    // Pick a fresh label per run so it has been neither registered nor reserved.
    const uniqueName = `nogate${Date.now().toString(36)}`
    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill(uniqueName)
    await page.waitForTimeout(3500)
    await dismissOverlay(page)
    await page.locator('[data-testid="search-result-name"]').first().click()
    await page.waitForTimeout(3000)

    const toast = page.getByTestId('search-blocked-toast')
    await expect(toast).toBeVisible({ timeout: 15_000 })
    await expect(toast).toContainText(/SimpleX NFT required/i)
    expect(page.url()).not.toMatch(/\/register\//)
  })

  test('direct nav to /simplex.testing/register (reserved) shows the reserved helper', async ({ page }) => {
    // `simplex` was reserved at deploy time and is permanent state on
    // Sepolia, so this assertion is stable across runs. BaseRegistrar
    // reports it as `available` — reserved-status is a controller-side
    // gate that surfaces on the /register page, so we navigate there
    // directly (matches the Hardhat suite's reserved-name test).
    await page.goto('/simplex.testing/register')
    await page.waitForTimeout(4000)

    const helper = page.getByTestId('simplex-reserved-helper')
    await expect(helper).toBeVisible({ timeout: 20_000 })
    await expect(helper).toContainText(/reserved by the admin/i)
  })

  test('direct nav to a 4-char .testing name renders the yellow too-short warning', async ({ page }) => {
    // The on-chain minCharLength is 6 by default; any 4-char label below
    // the floor renders the too-short helper. Pick a fresh one per run so
    // we don't accidentally land on a registered name from a previous run.
    const rand = () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]
    const tooShort = `${rand()}${rand()}${rand()}${rand()}`
    await page.goto(`/${tooShort}.testing`)
    await page.waitForTimeout(4000)

    const warning = page.getByRole('alert').filter({ hasText: /is too short/i }).first()
    await expect(warning).toBeVisible({ timeout: 20_000 })
  })

  test('direct nav to /<name>.testing/register without the NFT shows the in-page gate banner', async ({ page }) => {
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [SEPOLIA_TEST_KEY], chains: [sepoliaChain] })
    const uniqueName = `nft${Date.now().toString(36)}`
    await page.goto(`/${uniqueName}.testing/register`)
    await page.waitForTimeout(2500)
    await connectWallet(page, wallet)
    await page.waitForTimeout(3500)
    await dismissOverlay(page)

    const helper = page.getByTestId('simplex-nft-gate-helper')
    await expect(helper).toBeVisible({ timeout: 20_000 })
    await expect(helper).toContainText(/does not currently hold one/i)

    const nextBtn = page.getByTestId('next-button')
    await expect(nextBtn).toBeDisabled({ timeout: 20_000 })
    await expect(nextBtn).toContainText(/SimpleX NFT required/i)
  })
})

/**
 * End-to-end test for SimpleX Namespace registration flow.
 *
 * Prerequisites:
 *   1. Hardhat node running:  cd ens-contracts && npx hardhat node
 *   2. Contracts deployed:    node scripts/deploy-local.mjs
 *   3. Frontend running:      cd ens-app-v3 && NEXT_PUBLIC_DEPLOYMENT_ADDRESSES='...' NEXT_PUBLIC_PROVIDER=http://127.0.0.1:8545 NEXT_PUBLIC_SIMPLEX_TLD=testing pnpm dev
 */
import { test, expect } from '@playwright/test'
import {
  injectHeadlessWeb3Provider,
  Web3RequestKind,
} from '@ensdomains/headless-web3-provider'
import { localhost } from 'viem/chains'

const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const hardhatChain = {
  ...localhost,
  id: 1337,
  rpcUrls: {
    default: { http: ['http://127.0.0.1:8545'] },
  },
}

async function connectWallet(page: any, wallet: any) {
  const connectButton = page.locator('[data-testid="connect-button"]').first()
  await connectButton.waitFor({ timeout: 10_000 })
  await connectButton.click()
  await page.waitForTimeout(1000)

  await page.getByText('Headless Web3 Provider').click()
  await page.waitForTimeout(500)

  // ENS app requests RequestPermissions first, then RequestAccounts
  const hasPerm = async () => wallet.getPendingRequestCount(Web3RequestKind.RequestPermissions) >= 1
  const hasAcct = async () => wallet.getPendingRequestCount(Web3RequestKind.RequestAccounts) >= 1

  // Wait for and authorize permissions
  for (let i = 0; i < 20; i++) {
    if (await hasPerm()) break
    await page.waitForTimeout(250)
  }
  if (await hasPerm()) await wallet.authorize(Web3RequestKind.RequestPermissions)

  // Wait for and authorize accounts
  for (let i = 0; i < 20; i++) {
    if (await hasAcct()) break
    await page.waitForTimeout(250)
  }
  if (await hasAcct()) await wallet.authorize(Web3RequestKind.RequestAccounts)

  await page.waitForTimeout(3000)
}

test.describe('SimpleX Namespace', () => {
  test('homepage loads and shows search', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('input[placeholder]').first()).toBeVisible({ timeout: 15_000 })
  })

  test('search appends .testing TLD', async ({ page }) => {
    await injectHeadlessWeb3Provider({
      page,
      privateKeys: [DEPLOYER_KEY],
      chains: [hardhatChain],
    })

    await page.goto('/')
    await page.waitForTimeout(2000)

    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill('myname')
    await page.waitForTimeout(1000)

    const searchResults = page.locator('[data-testid="search-result-name"]').first()
    await expect(searchResults).toContainText('.testing', { timeout: 10_000 })
  })

  test.skip('admin panel loads and shows state for owner', async ({ page }) => {
    const wallet = await injectHeadlessWeb3Provider({
      page,
      privateKeys: [DEPLOYER_KEY],
      chains: [hardhatChain],
    })

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

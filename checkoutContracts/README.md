# Zelf checkout contracts (Avalanche + BSC + Ethereum)

This folder holds **`ZelfAvalanchePay`**, **`ZelfBscPay`**, and **`ZelfEthPay`** for tag renewal checkout on **Avalanche C-Chain**, **BNB Smart Chain**, and **Ethereum** (mainnet or Sepolia).

- **Avalanche:** users send **native AVAX** (`pay`) or **USDC** (`payUsdc` + ERC-20 `approve`) through `ZelfAvalanchePay`; funds are forwarded to the Zelf treasury. The backend confirms via the `Paid` event (`POST /api/my-tags/smart-contract-payment-confirmation`, network `AVAX_SC`).
- **BSC:** users send **native BNB** (`pay`), **USDC** (`payUsdc`), or **USDT** (`payUsdt`) through `ZelfBscPay`; confirmation uses network `BSC_SC` and JWT slice `smartContractBSC`.
- **Ethereum:** users send **native ETH** (`pay`), **USDC** (`payUsdc`), or **USDT** (`payUsdt`) through `ZelfEthPay`; confirmation uses network `ETH_SC` and JWT slice `smartContractETH`.

**Treasury on BSC and Ethereum:** deploy `ZelfBscPay` / `ZelfEthPay` with the **same treasury address** as Avalanche — the address derived from **`AVALANCHE_PRIVATE_KEY`** (one EVM identity across chains; separate balances per network).

Canonical Solidity also lives at [`../contracts/src/avalanche/ZelfAvalanchePay.sol`](../contracts/src/avalanche/ZelfAvalanchePay.sol); keep them in sync if you edit one.

## Constructor arguments

1. **`_treasury`** — receives AVAX and USDC (production): `0x6d1e134efb40f25f4Fb4A63AAD0415b8C466a690`
2. **`_usdc`** — ERC-20 USDC on the **same chain** (mainnet Circle USDC on C-Chain: `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`; Fuji: use a test USDC or set `AVALANCHE_TAG_PAY_USDC_ADDRESS` for the Node deploy script).

## Prerequisites

- **Node.js** + zelf repo dependencies (`npm install` at repo root) — for the **no-Forge** deploy script below.
- **Optional — Foundry**: [https://book.getfoundry.sh/getting-started/installation](https://book.getfoundry.sh/getting-started/installation) if you prefer `forge create`.
- A wallet with **AVAX** on the target network for gas (deployer).
- **Never commit** deployer private keys or `.env` with secrets to git.

## Deploy without Foundry (Node + solc via npx)

From the **zelf repository root** (where `.env` lives):

1. Add to `.env` (same file the API uses). **Either** a hex private key **or** a BIP39 seed phrase:

   ```bash
   # Option A — raw hex key (64 hex chars, optional 0x)
   AVALANCHE_PRIVATE_KEY=0xabcdef...

   # Option B — mnemonic (quote the whole phrase so spaces are preserved)
   AVALANCHE_PRIVATE_KEY="word1 word2 ... word12"
   ```

   With a mnemonic, the default account is `m/44'/60'/0'/0/0`. To use another path:

   ```bash
   AVALANCHE_HD_PATH="m/44'/60'/0'/0/1"
   ```

   Optional:

   ```bash
   AVALANCHE_RPC_URL=https://api.avax.network/ext/bc/C/rpc
   AVALANCHE_CHAIN_ID=43114
   # Fuji: AVALANCHE_CHAIN_ID=43113 and Fuji RPC URL
   ZELF_CHECKOUT_TREASURY=0x6d1e134efb40f25f4Fb4A63AAD0415b8C466a690
   ```

2. Run:

   ```bash
   npm run deploy:checkout-avax
   ```

   The script compiles `src/ZelfAvalanchePay.sol` with `npx solc@0.8.20` (no global `forge`), then deploys with `ethers` using `AVALANCHE_PRIVATE_KEY`.

3. Compile only (no deploy, no key required):

   ```bash
   DRY_RUN=1 npm run deploy:checkout-avax
   ```

Script path: [`scripts/deploy-zelf-avalanche-pay.js`](scripts/deploy-zelf-avalanche-pay.js).

## Compile (Foundry)

From the **repository root** or from this folder:

```bash
cd checkoutContracts
forge build
```

If `forge` complains about missing `lib`, you can compile a single file with:

```bash
forge build --contracts src/ZelfAvalanchePay.sol
```

## Deploy — Avalanche Fuji (testnet, chain ID `43113`)

Public RPC (rate-limited): `https://api.avax-test.network/ext/bc/C/rpc`

```bash
export TREASURY=0x6d1e134efb40f25f4Fb4A63AAD0415b8C466a690
export RPC_URL=https://api.avax-test.network/ext/bc/C/rpc
# Use a dedicated deployer key; do not reuse production keys in CI logs
export PRIVATE_KEY=0x...

export USDC=0x5425890298aed601595a70AB037cDa88a2ac42d8
forge create src/ZelfAvalanchePay.sol:ZelfAvalanchePay \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --constructor-args "$TREASURY" "$USDC"
```

Copy the **deployed contract address** from the output.

### Backend env (Fuji)

Set on the API server (and restart):

| Variable | Example |
|----------|---------|
| `AVALANCHE_CHAIN_ID` | `43113` |
| `AVALANCHE_RPC_URL` | `https://api.avax-test.network/ext/bc/C/rpc` (or your node) |
| `AVALANCHE_TAG_PAY_CONTRACT_ADDRESS` | `<deployed ZelfAvalanchePay address>` |
| `AVALANCHE_TAG_PAY_USDC_ADDRESS` | Same `_usdc` token passed to the constructor |

Optional:

| Variable | Purpose |
|----------|---------|
| `AVALANCHE_TAG_PAY_CONFIRMATIONS` | Min confirmations before accepting a tx (default `1`) |

After this, `GET .../payment-options` responses include `smartContractAVAX` when AVAX is enabled for the domain, and the landing checkout can use wallet pay + `smart-contract-payment-confirmation`.

## Deploy — Avalanche C-Chain mainnet (chain ID `43114`)

Public RPC: `https://api.avax.network/ext/bc/C/rpc`  
Explorer: [Snowtrace](https://snowtrace.io)

```bash
export TREASURY=0x6d1e134efb40f25f4Fb4A63AAD0415b8C466a690
export RPC_URL=https://api.avax.network/ext/bc/C/rpc
export PRIVATE_KEY=0x...
export USDC=0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E

forge create src/ZelfAvalanchePay.sol:ZelfAvalanchePay \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --constructor-args "$TREASURY" "$USDC"
```

### Backend env (mainnet)

| Variable | Example |
|----------|---------|
| `AVALANCHE_CHAIN_ID` | `43114` |
| `AVALANCHE_RPC_URL` | Your mainnet C-Chain HTTPS endpoint |
| `AVALANCHE_TAG_PAY_CONTRACT_ADDRESS` | `<deployed address>` |
| `AVALANCHE_TAG_PAY_USDC_ADDRESS` | Same USDC as constructor (e.g. Circle native USDC on mainnet) |

Use a reliable RPC (QuickNode, Infura, etc.) in production.

## Verify contract (optional)

If you use Foundry with a Snowtrace API key:

**Fuji**

```bash
forge verify-contract <DEPLOYED_ADDRESS> \
  src/ZelfAvalanchePay.sol:ZelfAvalanchePay \
  --chain avalanche-fuji \
  --constructor-args $(cast abi-encode "constructor(address)" 0x6d1e134efb40f25f4Fb4A63AAD0415b8C466a690) \
  --etherscan-api-key $SNOWTRACE_API_KEY
```

**Mainnet** — use `--chain avalanche` and the same constructor-args encoding.

Exact flags depend on your `forge` / `cast` version; see `forge verify-contract --help`.

## Deploy with Remix (no Foundry)

1. Open [Remix](https://remix.ethereum.org).
2. Create file `ZelfAvalanchePay.sol` and paste the contents of `src/ZelfAvalanchePay.sol`.
3. Compiler: **0.8.20+**, enable optimization if you like.
4. **Deploy & run**: Environment **Injected Provider**, select Fuji or Avalanche mainnet in MetaMask.
5. Constructor arguments: treasury `0x6d1e134efb40f25f4Fb4A63AAD0415b8C466a690` and USDC token for that network.
6. Deploy and save the contract address for `AVALANCHE_TAG_PAY_CONTRACT_ADDRESS`.

## Post-deploy checklist

1. **Contract address** set in `AVALANCHE_TAG_PAY_CONTRACT_ADDRESS`.
2. **`AVALANCHE_TAG_PAY_USDC_ADDRESS`** matches the USDC token used at deploy (required for `payUsdc` + JWT `usdc` branch).
3. **`AVALANCHE_CHAIN_ID`** matches the network where the contract was deployed (`43113` or `43114`).
4. **`AVALANCHE_RPC_URL`** points to the **same** network (Fuji RPC for Fuji contract, mainnet RPC for mainnet contract).
5. Smoke test: call `pay` with a small AVAX amount on Fuji, confirm `Paid` appears on the explorer and the treasury balance increases.
6. Optional: approve + `payUsdc` with test USDC; treasury must accept ERC-20.
7. From the landing app, run through AVAX checkout with wallet pay (AVAX or USDC) and confirm the backend returns `confirmed: true` after the tx mines.

## Frontend (landing app)

The Next.js app under `landing-zelf-nextjs` is already wired for this flow: it reads `smartContractAVAX` from `GET /api/my-tags/payment-options` (proxied as `/api/tags/payment-options`) and shows **Pay with Avalanche wallet** on the AVAX checkout page when that object is present.

1. **Align chain ID and RPC on the API** (required). If your `AVALANCHE_RPC_URL` is a **testnet** endpoint (URL contains `testnet` / Fuji), set `AVALANCHE_CHAIN_ID=43113`. If it is **mainnet** C-Chain, use `43114` and a mainnet RPC. A mismatch causes `provider_chain_mismatch` during `smart-contract-payment-confirmation`.

2. **Point the landing app at your API** (local or staging). In `landing-zelf-nextjs` `.env.local`:

   ```bash
   NEXT_PUBLIC_API_URL=https://your-api-host
   ```

   If unset, the app defaults to `https://v4.zelf.world` (see `app/api/tags/payment-options/route.ts` and `payment-confirmation` / `smart-contract-payment-confirmation` routes).

3. **Run the landing app** (`npm run dev`, port 3009 per project docs). Complete session init as today, search for an **existing** tag (renewal flow), open **AVAX** checkout. You should see the wallet panel plus the legacy QR/address.

4. **Wallet**: MetaMask (or another injected wallet) must use the **same chain** as `smartContractAVAX.chainId` in the payment-options response (from your backend config). Fund the paying account with **native AVAX on that network** (Fuji AVAX for `43113`).

5. **Quick API check** (optional): after payment-options, confirm the JSON includes `data.smartContractAVAX` with `paymentId`, `expectedWei`, `chainId`, and `contractAddress`. If it is missing, the API is not emitting smart-checkout data (e.g. `AVALANCHE_TAG_PAY_CONTRACT_ADDRESS` empty, AVAX disabled for the domain, or `prices.AVAX` null).

## Security notes

- The **treasury** is **immutable** after deploy; to change it you must deploy a new contract and update env + any cached payment sessions.
- The backend trusts **only** its configured `AVALANCHE_TAG_PAY_CONTRACT_ADDRESS` and the **JWT** (`paymentId`, `expectedWei`, `tagName`); it does not take the contract address from the client body for verification.
- Keep the deployer key and RPC keys out of logs and tickets.

## Event reference (for debugging)

```text
Paid(bytes32 indexed paymentId, address indexed payer, uint256 amount, string tagFull)
```

The API decodes this log to match `smartContractAVAX.paymentId` and either `expectedWei` (native `pay`) or `usdc.expectedAmount` (`payUsdc`), inferred from the transaction calldata — not from a client-supplied flag.

---

## ZelfBscPay (BNB Smart Chain)

Source: [`src/ZelfBscPay.sol`](src/ZelfBscPay.sol). Deploy script: [`scripts/deploy-zelf-bsc-pay.js`](scripts/deploy-zelf-bsc-pay.js).

### Constructor

1. **`_treasury`** — same address as Avalanche tag-pay treasury (from `Wallet.from(AVALANCHE_PRIVATE_KEY).address` in the deploy script).
2. **`_usdc`** — USDC on the target BSC network (mainnet example: `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`; verify on [BscScan](https://bscscan.com) before production).
3. **`_usdt`** — USDT on BSC (mainnet example: `0x55d398326f99059fF775485246999027B3197955`).

### Deploy (Node, no Foundry)

From the **zelf** repository root:

```bash
# Uses AVALANCHE_PRIVATE_KEY for deployer + treasury (same pattern as Avalanche deploy)
npm run deploy:checkout-bsc
```

Optional env overrides (see script output): `BSC_RPC_URL`, `BSC_CHAIN_ID` (`56` mainnet, `97` Chapel testnet), `BSC_TAG_PAY_USDC_ADDRESS`, `BSC_TAG_PAY_USDT_ADDRESS`.

`DRY_RUN=1 npm run deploy:checkout-bsc` compiles only.

### Backend env (API server)

| Variable | Example |
|----------|---------|
| `BSC_CHAIN_ID` | `56` or `97` |
| `BSC_RPC_URL` | HTTPS JSON-RPC for the same network |
| `BSC_TAG_PAY_CONTRACT_ADDRESS` | Deployed `ZelfBscPay` |
| `BSC_TAG_PAY_USDC_ADDRESS` | Same USDC as constructor |
| `BSC_TAG_PAY_USDT_ADDRESS` | Same USDT as constructor |
| `BSC_TAG_PAY_CONFIRMATIONS` | `1` (optional) |

After restart, `GET .../payment-options` includes `smartContractBSC` when **BNB** is enabled for the domain and `prices.BNB` is set (see domain config below) and this contract env is present.

### Domain / license JSON (BNB checkout)

Enable BNB for a TLD either:

- **Legacy:** `tags.payment.currencies` includes **`BNB`** (allowed by license create/update validation), or  
- **Networks:** `tags.payment.networks.bsc.enabled: true` and `tags.payment.networks.bsc.nativeCurrency.enabled: true` and `tags.payment.networks.bsc.nativeCurrency.code: "BNB"`.

### Landing app

Set `NEXT_PUBLIC_BSC_*` / `BSC_*` as generated by `landing-zelf-nextjs/scripts/generate-environment.mjs` so the checkout page can add the BSC chain and call `pay` / `payUsdc` / `payUsdt`.

---

## ZelfEthPay (Ethereum)

Source: [`src/ZelfEthPay.sol`](src/ZelfEthPay.sol). Deploy script: [`scripts/deploy-zelf-eth-pay.js`](scripts/deploy-zelf-eth-pay.js).

### Constructor

1. **`_treasury`** — same address as Avalanche / BSC tag-pay treasury (from `Wallet.from(AVALANCHE_PRIVATE_KEY).address` in the deploy script).
2. **`_usdc`** — USDC on the target Ethereum network (mainnet: Circle USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`; Sepolia: use a test USDC from the script defaults or env).
3. **`_usdt`** — USDT on Ethereum (mainnet example: `0xdAC17F958D2ee523a2206206994597C13D831ec7`).

### Deploy (Node, no Foundry)

From the **zelf** repository root:

```bash
# Uses AVALANCHE_PRIVATE_KEY for deployer + treasury (same pattern as Avalanche / BSC deploy)
npm run deploy:checkout-eth
```

Optional env overrides (see script output): `ETHEREUM_RPC_URL`, `ETHEREUM_CHAIN_ID` (`1` mainnet, `11155111` Sepolia), `ETHEREUM_TAG_PAY_USDC_ADDRESS`, `ETHEREUM_TAG_PAY_USDT_ADDRESS`.

`DRY_RUN=1 npm run deploy:checkout-eth` compiles only.

### Backend env (API server)

| Variable | Example |
|----------|---------|
| `ETHEREUM_CHAIN_ID` | `1` or `11155111` |
| `ETHEREUM_RPC_URL` | HTTPS JSON-RPC for the same network |
| `ETHEREUM_TAG_PAY_CONTRACT_ADDRESS` | Deployed `ZelfEthPay` |
| `ETHEREUM_TAG_PAY_USDC_ADDRESS` | Same USDC as constructor |
| `ETHEREUM_TAG_PAY_USDT_ADDRESS` | Same USDT as constructor |
| `ETHEREUM_TAG_PAY_CONFIRMATIONS` | `1` (optional) |

After restart, `GET .../payment-options` includes `smartContractETH` when **ETH** is enabled for the domain and `prices.ETH` is set and this contract env is present.

### Landing app

Set `NEXT_PUBLIC_ETHEREUM_*` / `ETHEREUM_*` as generated by `landing-zelf-nextjs/scripts/generate-environment.mjs` so the checkout page can add the Ethereum network and call `pay` / `payUsdc` / `payUsdt`.

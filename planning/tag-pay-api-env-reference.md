# Tag pay API `.env` reference

**Do not commit this file with production secrets.** Copy lines into your API `.env`; names match [Core/config.js](../Core/config.js).

## Deploy script fixes applied

All checkout deploy scripts now normalize addresses with `ethers.getAddress(...toLowerCase())` so default token literals and env values work with ethers v6.

## Treasury note

Deploy output showed **treasury = deployer** because `ZELF_CHECKOUT_TREASURY` was not picked up for these runs (or matched deployer). To send constructor treasury to `0x6d1e134efb40f25f4Fb4A63AAD0415b8C466a690`, set in **zelf** `.env`:

`ZELF_CHECKOUT_TREASURY=0x6d1e134efb40f25f4Fb4A63AAD0415b8C466a690`

then **redeploy** any chain where you need that treasury. Existing deployments above use deployer as treasury unless you redeploy.

---

## Results from this session

### BSC — deployed

```env
BSC_TAG_PAY_CONTRACT_ADDRESS=0x8c5f18173AB9bd0138a79cd3D2653c62EB214E82
BSC_TAG_PAY_USDC_ADDRESS=0x8Ac76c51CC950d9822d68b83FE1AD97B32Cd580D
BSC_TAG_PAY_USDT_ADDRESS=0x55d398326f99059fF775485246999027B3197955
BSC_CHAIN_ID=56
BSC_RPC_URL=https://bsc-dataseed.binance.org
```

### Ethereum — deployed

First attempt with default RPC `https://eth.llamarpc.com` failed with **`Nonce too low`** even though `eth_getTransactionCount` was `0` (misleading RPC behavior). Retry with **`ETHEREUM_RPC_URL=https://ethereum.publicnode.com`** succeeded.

Tx: `0x944e633a02635209ebed2641bb2c4f0091807088c3a5a7aa1721136d139fb5fd`

**Note:** Same contract address as Polygon is expected: CREATE address depends only on deployer + nonce; first deploy on each chain used nonce `0`, so both are `0x7c6a168455C94092f8d51aBC515B73f4Ed9813a6` (different chains, not the same contract instance).

```env
ETHEREUM_TAG_PAY_CONTRACT_ADDRESS=0x7c6a168455C94092f8d51aBC515B73f4Ed9813a6
ETHEREUM_TAG_PAY_USDC_ADDRESS=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
ETHEREUM_TAG_PAY_USDT_ADDRESS=0xdAC17F958D2ee523a2206206994597C13D831ec7
ETHEREUM_CHAIN_ID=1
ETHEREUM_RPC_URL=https://ethereum.publicnode.com
```

### Polygon — deployed

```env
POLYGON_TAG_PAY_CONTRACT_ADDRESS=0x7c6a168455C94092f8d51aBC515B73f4Ed9813a6
POLYGON_TAG_PAY_USDC_ADDRESS=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
POLYGON_TAG_PAY_USDT_ADDRESS=0xc2132D05D31c914a87C6611C10748AEb04B58e8F
POLYGON_CHAIN_ID=137
POLYGON_RPC_URL=<use the RPC URL from your zelf .env POLYGON_RPC_URL if set, else https://polygon-rpc.com>
```

### Base — deployed

Tx: `0x325b5fb4d1d2c450c36b5a1b892603837746f429092921d21802236189f8b87e`

Same pay contract address as Ethereum/Polygon (`0x7c6a…`) — first contract deployment from this deployer on Base used nonce `0`, matching the other chains where that was also the first deploy.

```env
BASE_TAG_PAY_CONTRACT_ADDRESS=0x7c6a168455C94092f8d51aBC515B73f4Ed9813a6
BASE_TAG_PAY_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
BASE_TAG_PAY_USDT_ADDRESS=0xfde4C96ce3cAfAC9F2Df3573baE2D715D34B25A0
BASE_CHAIN_ID=8453
BASE_RPC_URL=https://mainnet.base.org
```

## Full template (fill gaps after remaining deploys)

```env
# BSC
BSC_TAG_PAY_CONTRACT_ADDRESS=0x8c5f18173AB9bd0138a79cd3D2653c62EB214E82
BSC_TAG_PAY_USDC_ADDRESS=0x8Ac76c51CC950d9822d68b83FE1AD97B32Cd580D
BSC_TAG_PAY_USDT_ADDRESS=0x55d398326f99059fF775485246999027B3197955
BSC_CHAIN_ID=56
BSC_RPC_URL=https://bsc-dataseed.binance.org

# Ethereum
ETHEREUM_TAG_PAY_CONTRACT_ADDRESS=0x7c6a168455C94092f8d51aBC515B73f4Ed9813a6
ETHEREUM_TAG_PAY_USDC_ADDRESS=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
ETHEREUM_TAG_PAY_USDT_ADDRESS=0xdAC17F958D2ee523a2206206994597C13D831ec7
ETHEREUM_CHAIN_ID=1
ETHEREUM_RPC_URL=https://ethereum.publicnode.com

# Polygon
POLYGON_TAG_PAY_CONTRACT_ADDRESS=0x7c6a168455C94092f8d51aBC515B73f4Ed9813a6
POLYGON_TAG_PAY_USDC_ADDRESS=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
POLYGON_TAG_PAY_USDT_ADDRESS=0xc2132D05D31c914a87C6611C10748AEb04B58e8F
POLYGON_CHAIN_ID=137
POLYGON_RPC_URL=https://polygon-rpc.com

# Base
BASE_TAG_PAY_CONTRACT_ADDRESS=0x7c6a168455C94092f8d51aBC515B73f4Ed9813a6
BASE_TAG_PAY_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
BASE_TAG_PAY_USDT_ADDRESS=0xfde4C96ce3cAfAC9F2Df3573baE2D715D34B25A0
BASE_CHAIN_ID=8453
BASE_RPC_URL=https://mainnet.base.org
```

Optional per chain: `*_TAG_PAY_CONFIRMATIONS=1`

## Verify config loading

From zelf root, with env vars exported or in shell:

`node -e "const c=require('./Core/config'); console.log(c.bsc.tagPayContractAddress, c.polygon.tagPayContractAddress);"`

## All five compile checks

`DRY_RUN=1 npm run deploy:checkout-bsc` (and `-eth`, `-polygon`, `-base`) — all succeeded before live deploys.

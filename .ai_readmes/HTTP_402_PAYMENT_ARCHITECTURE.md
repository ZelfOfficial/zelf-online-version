# HTTP 402 Payment Required - Multi-Chain Micro-Payments Architecture

## Overview

This architecture implements HTTP 402 (Payment Required) for ZelfProof services using the ZNS token across multiple blockchains. Users can pay for API access using ZNS tokens on Solana, Avalanche, or Base.

## Architecture Components

### 1. Payment Middleware (`/Repositories/ZelfProof/middlewares/payment.middleware.js`)

Central orchestrator that:

-   Validates payment headers
-   Routes to appropriate chain verification service
-   Prevents replay attacks
-   Manages subscription bypasses
-   Tracks payment usage

### 2. Chain-Specific Verification Modules

#### Solana (`/Repositories/Solana/modules/payment-verification.module.js`)

-   **ZNS Token**: `GfF6PSkH8bKLkws5RMFdzgASwcVbgCfhhKfp8zeoFBkx`
-   **Confirmations**: 1 block (~400ms)
-   **Method**: SPL Token transfer verification
-   **Technology**: @solana/web3.js

#### Avalanche (`/Repositories/Avalanche/modules/payment-verification.module.js`)

-   **ZNS Token**: TBD (update when deployed)
-   **Confirmations**: 3 blocks (~6 seconds)
-   **Method**: ERC20 Transfer event parsing
-   **Technology**: ethers.js v6

#### Base (`/Repositories/base/modules/payment-verification.module.js`)

-   **ZNS Token**: TBD (update when deployed)
-   **Confirmations**: 2 blocks (~4 seconds)
-   **Method**: ERC20 Transfer event parsing
-   **Technology**: ethers.js v6

## Pricing Structure

| Endpoint                          | Cost (ZNS) | Description                |
| --------------------------------- | ---------- | -------------------------- |
| `/api/zelf-proof/encrypt`         | 0.1        | Standard encryption        |
| `/api/zelf-proof/encrypt-qr-code` | 0.15       | Encryption + QR generation |
| `/api/zelf-proof/decrypt`         | 0.05       | Decryption service         |
| `/api/zelf-proof/preview`         | 0.01       | Preview without decryption |

## How It Works

### Payment Flow

```
1. User makes API request without payment
   ↓
2. Server returns 402 with payment instructions
   ↓
3. User sends ZNS tokens on their preferred chain
   ↓
4. User retries request with payment headers
   ↓
5. Middleware verifies transaction on-chain
   ↓
6. If valid, request proceeds to endpoint
   ↓
7. Payment is marked as used (prevents replay)
```

### Request Headers

```http
POST /api/zelf-proof/encrypt
Authorization: Bearer <jwt_token>
x-payment-chain: solana
x-payment-tx: <transaction_hash>
x-payment-proof: <optional_proof>
x-wallet-address: <user_wallet_address>
Content-Type: application/json
```

### Example: First Request (No Payment)

```bash
curl -X POST https://v4.zelf.world/api/zelf-proof/encrypt \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "publicData": {"name": "John"},
    "faceBase64": "...",
    "os": "DESKTOP"
  }'
```

**Response (402):**

```json
{
    "error": "Payment Required",
    "message": "This endpoint requires payment to access",
    "paymentDetails": {
        "cost": 0.1,
        "token": "ZNS",
        "acceptedChains": ["solana", "avalanche", "base"],
        "description": "ZelfProof Encryption Service"
    },
    "instructions": {
        "step1": "Send the required amount of ZNS tokens to the service wallet",
        "step2": "Include the transaction hash in the 'x-payment-tx' header",
        "step3": "Include the chain name in the 'x-payment-chain' header",
        "step4": "Include the payment proof in the 'x-payment-proof' header"
    }
}
```

### Example: Request with Payment (Solana)

```bash
# 1. Send 0.1 ZNS tokens on Solana to service wallet
# 2. Get transaction signature
# 3. Make request with payment headers

curl -X POST https://v4.zelf.world/api/zelf-proof/encrypt \
  -H "Authorization: Bearer <token>" \
  -H "x-payment-chain: solana" \
  -H "x-payment-tx: 5KqZ..." \
  -H "x-wallet-address: 7xKXt..." \
  -H "Content-Type: application/json" \
  -d '{
    "publicData": {"name": "John"},
    "faceBase64": "...",
    "os": "DESKTOP"
  }'
```

**Response (200):**

```json
{
    "success": true,
    "zelfProof": "...",
    "identifier": "..."
}
```

## Security Features

### 1. Replay Attack Prevention

-   Each transaction hash can only be used once
-   Payments are cached in Redis with 30-day expiration
-   Permanent record stored in database

### 2. Amount Verification

-   Exact amount matching (or overpayment accepted)
-   Prevents underpayment attacks

### 3. Wallet Verification

-   Confirms payment came from authenticated user's wallet
-   Prevents payment theft/reuse

### 4. Confirmation Requirements

-   Solana: 1 confirmation
-   Avalanche: 3 confirmations
-   Base: 2 confirmations

### 5. Subscription Bypass

-   Users with active paid subscriptions bypass payment
-   Checked before payment verification

## Environment Variables

Add these to your `.env` file:

```bash
# Solana
SOLANA_RPC_ENDPOINT=https://api.mainnet-beta.solana.com
SOLANA_SERVICE_WALLET=<your_solana_wallet>

# Avalanche
AVALANCHE_RPC_ENDPOINT=https://api.avax.network/ext/bc/C/rpc
AVALANCHE_ZNS_TOKEN=<zns_token_address_on_avalanche>
AVALANCHE_SERVICE_WALLET=<your_avalanche_wallet>

# Base
BASE_RPC_ENDPOINT=https://mainnet.base.org
BASE_ZNS_TOKEN=<zns_token_address_on_base>
BASE_SERVICE_WALLET=<your_base_wallet>
```

## Database Schema

### Payments Table

```sql
CREATE TABLE payments (
  id UUID PRIMARY KEY,
  tx_hash VARCHAR(255) NOT NULL,
  chain VARCHAR(50) NOT NULL,
  amount DECIMAL(18, 8) NOT NULL,
  endpoint VARCHAR(255) NOT NULL,
  user_id UUID,
  wallet_address VARCHAR(255),
  verified_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tx_hash, chain)
);

CREATE INDEX idx_payments_user ON payments(user_id);
CREATE INDEX idx_payments_tx ON payments(tx_hash, chain);
```

## Frontend Integration

### React/TypeScript Example

```typescript
import axios from "axios";

interface PaymentDetails {
    cost: number;
    token: string;
    acceptedChains: string[];
}

async function callPaidEndpoint(endpoint: string, data: any, chain: "solana" | "avalanche" | "base", txHash: string, walletAddress: string) {
    try {
        const response = await axios.post(endpoint, data, {
            headers: {
                Authorization: `Bearer ${getToken()}`,
                "x-payment-chain": chain,
                "x-payment-tx": txHash,
                "x-wallet-address": walletAddress,
            },
        });

        return response.data;
    } catch (error) {
        if (error.response?.status === 402) {
            const paymentDetails: PaymentDetails = error.response.data.paymentDetails;

            // Show payment UI to user
            await showPaymentModal(paymentDetails);

            // After payment, retry with transaction hash
            return callPaidEndpoint(endpoint, data, chain, txHash, walletAddress);
        }

        throw error;
    }
}
```

## Testing

### Test Payment Verification (Solana)

```javascript
const SolanaPayment = require("./Repositories/Solana/modules/payment-verification.module");

async function testPayment() {
    const result = await SolanaPayment.verifyPayment({
        txHash: "5KqZ...",
        expectedAmount: 0.1,
        userWallet: "7xKXt...",
    });

    console.log("Payment valid:", result.valid);
    console.log("Details:", result.details);
}
```

## Deployment Checklist

-   [ ] Deploy ZNS token to Avalanche
-   [ ] Deploy ZNS token to Base
-   [ ] Update token addresses in config
-   [ ] Set up service wallets on all chains
-   [ ] Configure environment variables
-   [ ] Set up Redis for payment caching
-   [ ] Create payments database table
-   [ ] Test payment flow on each chain
-   [ ] Update API documentation
-   [ ] Implement frontend payment UI

## Benefits

✅ **Multi-Chain Support**: Users can pay on their preferred chain  
✅ **Micro-Payments**: Pay only for what you use  
✅ **Subscription Bypass**: Paid subscribers get unlimited access  
✅ **Replay Protection**: Prevents payment reuse  
✅ **Fast Verification**: On-chain verification in seconds  
✅ **Transparent Pricing**: Clear cost per endpoint  
✅ **Scalable**: Easy to add new chains or endpoints

## Future Enhancements

1. **Payment Batching**: Allow users to pre-pay for multiple requests
2. **Dynamic Pricing**: Adjust prices based on demand
3. **Payment Channels**: Lightning Network for Bitcoin, State Channels for Ethereum
4. **Fiat On-Ramp**: Allow credit card payments that auto-convert to ZNS
5. **Loyalty Rewards**: Discount for frequent users
6. **Cross-Chain Swaps**: Auto-swap from any token to ZNS

## Support

For issues or questions:

-   Check transaction on blockchain explorer
-   Verify wallet has sufficient ZNS balance
-   Ensure correct chain is selected
-   Check transaction confirmations
-   Contact support with transaction hash

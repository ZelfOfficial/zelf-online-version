# Tags API - Postman Collection

This Postman collection provides comprehensive testing for the multi-domain Tags API system, supporting `.zelf`, `.avax`, `.btc`, `.tech` and custom domains.

## 🚀 Quick Start

### 1. Import Collection
1. Open Postman
2. Click **Import** → **Upload Files**
3. Select `Tags-API-Collection.json`
4. Click **Import**

### 2. Set Environment Variables
The collection uses these variables:

| Variable | Description | Example Value |
|----------|-------------|---------------|
| `base_url` | API base URL | `http://localhost:3000` |
| `jwt_token` | JWT authentication token | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` |
| `domain` | Domain to test | `avax`, `btc`, `tech` |
| `tag_name` | Tag name for testing | `testuser`, `myname` |

### 3. Authentication
1. Get a JWT token from your authentication endpoint
2. Set the `jwt_token` variable
3. The collection uses Bearer token authentication

## 📁 Collection Structure

### 1. **Domain Management**
- **Get All Supported Domains** - List all available domains
- **Get Domain Configuration** - Get specific domain config
- **Get Domain Pricing** - Get pricing for a domain
- **Get Domain Payment Options** - Get payment methods/currencies

### 2. **Tag Search & Discovery**
- **Search Tag v2** - Search for specific tag
- **Search Tags by Domain** - Get all tags in a domain
- **Search Tags by Storage Key** - Search by storage key
- **Search Hold Domain** - Search for hold domains (.hold)
- **Get Availability Summary** - Check tag availability

### 3. **Tag Operations**
- **Lease Tag** - Create new tag with payment
- **Decrypt Tag** - Access tag's private data
- **Preview Tag** - Preview tag without decrypting
- **Update Tag** - Renew/update tag
- **Delete Tag** - Delete a tag

### 4. **Payment Operations**
- **Calculate Payment** - Calculate pricing with discounts
- **Validate Payment Method** - Check payment method support
- **Validate Currency** - Check currency support
- **Check Affordability** - Check if user can afford operation
- **Get Pricing Table** - Get complete pricing for all domains

### 5. **My Tags (User Operations)**
- **Get My Tags** - Get user's owned tags
- **Get My Tags by Domain** - Get user's tags in specific domain
- **Transfer Tag** - Transfer ownership to another user
- **Renew Tag** - Renew tag for additional time
- **How to Renew Tag** - Get renewal instructions

### 6. **System Health & Monitoring**
- **Check System Health** - Overall system health
- **Check Domain Health** - Specific domain health
- **Get Domain Stats** - Domain statistics
- **Get System Stats** - Overall system statistics

### 7. **Advanced Operations**
- **Lease Offline Tag** - Create tag with offline proof
- **Lease Confirmation** - Confirm payment
- **Create ZelfPay** - Create ZelfPay for tag
- **Preview ZelfProof** - Preview ZelfProof

## 🔧 Configuration

### Domain Testing
The collection supports testing with different domains:

```json
{
  "zelf": "Free domain (0 cents)",
  "avax": "Avalanche domain ($1.00)",
  "btc": "Bitcoin domain ($0.50)",
  "tech": "Tech domain ($0.75)"
}
```

### Payment Methods
The collection documents the currently supported payment methods:

- **crypto** - Cryptocurrency payments
- **stripe** - Credit and debit card payments

### Currencies
Supported currencies vary by domain:

- **USD** - US Dollar (all domains)
- **BTC** - Bitcoin (most domains)
- **ETH** - Ethereum (most domains)
- **SOL** - Solana (zelf, tech)
- **AVAX** - Avalanche (avax domain)

## 🧪 Testing Scenarios

### 1. **Basic Tag Creation**
```bash
# 1. Set domain variable (e.g., "avax")
# 2. Set tag_name variable (e.g., "testuser")
# 3. Run "Lease Tag" request
# 4. Check response for success
```

### 2. **Multi-Domain Testing**
```bash
# Test each domain:
# 1. zelf (free)
# 2. avax ($1.00)
# 3. btc ($0.50)
# 4. tech ($0.75)
```

### 3. **Payment Testing**
```bash
# 1. Calculate payment for different domains
# 2. Validate payment methods
# 3. Test affordability checks
# 4. Process actual payments
```

### 4. **Hold Domain Testing**
```bash
# 1. Search for hold domains (.hold)
# 2. Test hold domain creation
# 3. Verify hold domain logic
```

## 📊 Response Examples

### Successful Tag Creation
```json
{
  "success": true,
  "tagName": "testuser.avax",
  "domain": "avax",
  "domainConfig": {
    "type": "custom",
    "price": 100,
    "holdSuffix": ".hold"
  },
  "ipfs": {
    "hash": "QmHash...",
    "url": "https://ipfs.io/ipfs/QmHash..."
  },
  "arweave": {
    "id": "arweave_tx_id",
    "url": "https://arweave.net/arweave_tx_id"
  },
  "zelfProof": "encrypted_proof_data",
  "zelfProofQRCode": "data:image/png;base64...",
  "expiresAt": "2025-01-15T10:30:00.000Z",
  "registeredAt": "2024-01-15T10:30:00.000Z",
  "paymentInfo": {
    "amount": 85,
    "currency": "USD",
    "paymentMethod": "crypto",
    "duration": "yearly"
  }
}
```

### Domain Configuration
```json
{
  "success": true,
  "domain": "avax",
  "type": "custom",
  "price": 100,
  "holdSuffix": ".hold",
  "status": "active",
  "owner": "avalanche-community",
  "description": "Avalanche community domain",
  "features": ["biometric", "wallet", "payment", "transfer", "renewal"],
  "payment": {
    "methods": ["crypto", "stripe"],
    "currencies": ["USD", "AVAX", "BTC", "ETH"],
    "discounts": {
      "yearly": 0.15,
      "lifetime": 0.3
    }
  },
  "limits": {
    "maxTagsPerUser": 5,
    "maxTransferPerDay": 3,
    "maxRenewalPerDay": 2
  }
}
```

## 🚨 Error Handling

### Common Error Responses
```json
{
  "success": false,
  "error": "Domain not supported",
  "code": "DOMAIN_NOT_SUPPORTED"
}
```

```json
{
  "success": false,
  "error": "Tag already exists",
  "code": "TAG_EXISTS"
}
```

```json
{
  "success": false,
  "error": "Payment method 'paypal' not supported for domain 'avax'",
  "code": "INVALID_PAYMENT_METHOD"
}
```

## 🔍 Debugging

### Pre-request Scripts
The collection includes pre-request scripts that:
- Auto-generate test data if not set
- Randomly select domains for testing
- Set up common variables

### Test Scripts
Each request includes test scripts that:
- Log response status and body
- Validate response codes
- Log errors for debugging

### Console Logging
Check the Postman console for detailed logs:
- Response data
- Error messages
- Variable values
- Debug information

## 📝 Notes

1. **Authentication Required**: Most endpoints require JWT authentication
2. **Domain Validation**: All requests validate domain support
3. **Payment Integration**: Paid domains require payment processing
4. **Hold Domains**: Test with `.hold` suffix for hold functionality
5. **Rate Limiting**: Be aware of rate limits for testing

## 🆘 Troubleshooting

### Common Issues
1. **401 Unauthorized** - Check JWT token
2. **400 Bad Request** - Validate request body
3. **404 Not Found** - Check endpoint URLs
4. **500 Internal Error** - Check server logs

### Getting Help
1. Check the console logs in Postman
2. Verify environment variables
3. Test with different domains
4. Check server status endpoints

## 🔄 Updates

This collection will be updated as new features are added to the Tags API system. Check the version number in the collection info for updates.

---

**Happy Testing! 🚀**

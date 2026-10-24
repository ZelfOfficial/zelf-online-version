# Zelf Name Service (ZNS) - Backend API

Welcome to the official repository for the **Zelf Name Service (ZNS)** Backend API, part of the **Zelf Wallet** project. This API offers essential functionalities for searching and registering Zelf names, encrypting and decrypting wallets, and managing ZelfProofs.

## Table of Contents
- [Introduction](#introduction)
- [API Overview](#api-overview)
- [Endpoints](#endpoints)
- [Setup](#setup)
- [Contributing](#contributing)
- [License](#license)

## Introduction

The **Zelf Name Service (ZNS)** provides a novel approach to managing cryptographic wallets by linking them to a self-custody proof system known as **ZelfProof**, which is generated using zk-Face Proof technology. This ensures maximum security and privacy for users, without the need for traditional private keys or hardware wallets.

Through the API, users can:
- Search for and register Zelf names.
- Encrypt and decrypt wallets using zk-Face Proofs.
- Store ZelfProofs securely on IPFS for easy recovery.
- Leverage advanced cryptography for wallet and data encryption.

## API Overview

The ZNS backend provides endpoints to:
1. **Search** for existing Zelf names.
2. **Register** new Zelf names.
3. **Encrypt/Decrypt** wallets using **ZelfProofs**.
4. **Preview** ZelfProof wallets.
5. **Upload to IPFS** to secure encrypted data.

Each of these functionalities integrates with the underlying **zk-Face Proof** architecture to ensure that no biometric data is stored, and that all proofs are privacy-preserving and unlinkable.

## Endpoints

### **Zelf Wallet Endpoints**

| Method | Endpoint                | Description                                |
|--------|-------------------------|--------------------------------------------|
| `GET`  | `/my-wallets`            | Fetch a list of all wallets.               |
| `GET`  | `/my-wallets/:id`        | Get details of a specific wallet by ID.    |
| `POST` | `/my-wallets`            | Create a new wallet.                       |
| `POST` | `/my-wallets/import`     | Import an existing wallet.                 |
| `POST` | `/my-wallets/decrypt`    | Decrypt an existing wallet.                |
| `POST` | `/my-wallets/ipfs`       | Upload wallet to IPFS.                     |

### **ZelfProof Endpoints**

| Method | Endpoint                          | Description                                        |
|--------|-----------------------------------|----------------------------------------------------|
| `POST` | `/zelf-proof/encrypt`             | Encrypt a wallet with ZelfProof.                   |
| `POST` | `/zelf-proof/encrypt-qr-code`     | Generate QR code for the encrypted wallet.         |
| `POST` | `/zelf-proof/decrypt`             | Decrypt a wallet using ZelfProof.                  |
| `POST` | `/zelf-proof/preview`             | Preview the encrypted wallet details.              |

### **Session Endpoints**

| Method | Endpoint                          | Description                                        |
|--------|-----------------------------------|----------------------------------------------------|
| `GET`  | `/sessions/yek-cilbup`            | Retrieve a public key.                             |
| `POST` | `/sessions`                       | Create a new session.                              |
| `POST` | `/sessions/decrypt-content`       | Decrypt content in a session.                      |

### **IPFS Endpoints**

| Method | Endpoint                          | Description                                        |
|--------|-----------------------------------|----------------------------------------------------|
| `GET`  | `/open/ipfs`                      | Fetch details of IPFS-stored data.                 |

### **Etherscan Integration**

| Method | Endpoint                          | Description                                        |
|--------|-----------------------------------|----------------------------------------------------|
| `GET`  | `/ethereum/address`               | Validate and retrieve Ethereum address details.    |
| `GET`  | `/ethereum/transactions`          | Fetch Ethereum transaction details.                |
| `GET`  | `/ethereum/gas-tracker`           | Retrieve Ethereum gas price data.                  |
| `POST` | `/ethereum/gas-tracker`           | Track Ethereum gas usage.                          |

## Setup

To run the API locally, follow these steps:

1. Clone the repository:
   ```bash
   git clone https://github.com/your-repo/zelf-zns-backend.git
   cd zelf-zns-backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables:
   This is mainly for the Zelf Team, but if you require to run a version in your own server, ask for the .env to our team at miguel@verifik.co
   Ensure that you have the necessary credentials for IPFS, Ethereum, and other services in a `.env` file.
   Deploys must set `FACE_POW_HMAC_SECRET` (`openssl rand -hex 32`). Face checks, including Zelf Keys slot purchase, need it before they can issue a proof-of-work challenge. See `Repositories/Face/README.md` and `.env.example`.

4. Start the server:
   ```bash
   npm start
   ```

The API will be available at `http://localhost:3000`.

## Contributing

We welcome contributions to improve the functionality of the Zelf Name Service API. Please follow the [contributing guidelines](CONTRIBUTING.md) and submit a pull request with your changes.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.


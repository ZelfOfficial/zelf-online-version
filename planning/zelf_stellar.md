# Zelf Legacy: Biometric Inheritance Infrastructure for Stellar

## SCF #42 | Build Track | Open Track

**Requested Budget:** $90,000 USD (in XLM)

**Website:** [https://zelf.world/zelf-legacy](https://zelf.world/zelf-legacy)

**Documentation:** [https://docs.zelf.world](https://docs.zelf.world)

**Organization:** Zelf World LLC (Wyoming, USA) / Verifik SAS (Colombia)

**GitHub:** [https://github.com/Open-Verifik](https://github.com/Open-Verifik)

---

## Executive Summary

Zelf Legacy lets Stellar wallets and apps handle inheritance without moving funds or trusting a central party. Users keep full control; beneficiaries get access only after verified inactivity and biometric proof. No private keys exposed, no biometric data stored.

We've built the hard part already. Our ZelfProof tech derives a private key from your face (optionally plus a password) so you can run a self-custody wallet with no seed phrases and no servers. The output is a ~350-byte encrypted packet, not a biometric template. Live face scan + liveness detection verifies; add a password and you get two factors. SDK runs on Web Extension, iOS, and Android. We tried Solana and Avalanche as proof of concept; the fit wasn't there for inheritance and payments. Stellar gets it: payments, rightful owners, leaving assets to family when you're gone. The $90k funds building Soroban contracts, heartbeat protocol, oracle integration, and tooling from scratch for Stellar. Not a port.

---

## Products & Services

### What Is Zelf Legacy?

Zelf Legacy solves the most critical unaddressed problem in crypto: **"What happens to your assets when you die?"**

Most inheritance schemes lock your funds in a contract. We don't. Zelf Legacy passes **access rights** to beneficiaries only after inactivity is verified and they prove who they are (face + ID). Your assets stay where they are.

### How It Works

#### Step 1: Create Your Will

You turn on Legacy Mode in the Zelf app and pick your beneficiaries. Each one is bound via ZelfProof. Their face is the key. We never store biometric data.

- Legal Smart Contract Wrapper on Soroban
- Biometric Beneficiary Designation via ZelfProof
- Policy encrypted and stored on IPFS & Arweave (immutable, decentralized)
- Shamir's Secret Sharing (SSS) splits the seed phrase into shares. You set the rules: 2 of 3, 3 of 5, lawyer or no lawyer, 1 beneficiary or several. Threshold is configurable.

#### Step 2: Heartbeat Protocol

The app pings the Soroban contract periodically to prove you're alive. ZK compression keeps it cheap and private:

- Nobody can tell if you have a policy
- Heartbeats are signed; liveness detection blocks spoofs
- You set the inactivity window (30 days to 24 months) and grace period
- ZK cuts on-chain storage by 100–1000x

#### Step 3: Secure Claim

Once inactivity and grace period are over, beneficiaries can claim. Three checks:

1. Face match: live scan against the ZelfProof the holder registered. No biometric data shared.
2. ID check: Verifik's KYC (190+ countries). (Verifik is our web2 company)
3. ZK proof on Soroban: contract verifies entitlement and releases credentials. Keys stay off-chain.

### Why This Is Superior to Fund-Transfer Inheritance

| Approach | Fund Transfer (typical approach) | Access Rights (Zelf Legacy) |
|---|---|---|
| **User retains control** | No. Funds locked in contract | Yes. Full control until inheritance |
| **Smart contract risk** | High. Funds at risk if contract is exploited | Minimal. Contract holds policies, not funds |
| **DeFi composability** | Broken. Locked funds can't be used | Preserved. Assets remain active |
| **Yield/staking** | Lost during lock period | Continues normally |
| **Multi-chain assets** | Requires per-chain deployment | Single policy covers cross-chain access |
| **Legal enforceability** | Uncertain. Code-is-law | Supported. Produces verifiable evidence for lawful off-chain execution |

---

## Technical Architecture

### Core Components (Soroban Adaptation)

```
┌─────────────────────────────────────────────────────────┐
│                    ZELF LEGACY ON STELLAR                │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐    ┌──────────────┐   ┌─────────────┐│
│  │  ZelfProof    │    │  Heartbeat   │   │  Soroban    ││
│  │  Biometric    │───▶│  Protocol    │──▶│  Inheritance││
│  │  Engine       │    │  (ZK Comp.)  │   │  Registry   ││
│  │  (Offline)    │    │              │   │  Contract   ││
│  └──────────────┘    └──────────────┘   └──────┬──────┘│
│         │                                        │       │
│         │            ┌──────────────┐            │       │
│         │            │  Guardian    │            │       │
│         └───────────▶│  Oracle      │◀───────────┘      │
│                      │  Service     │                    │
│                      └──────────────┘                    │
│                             │                            │
│                      ┌──────────────┐                    │
│                      │  Claim       │                    │
│                      │  Verification│                    │
│                      │  Module      │                    │
│                      └──────────────┘                    │
│                                                          │
│  Storage Layer:                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐      │
│  │  Arweave  │  │  IPFS    │  │  Stellar Ledger  │      │
│  │  (Proofs) │  │  (Policy)│  │  (State/Events)  │      │
│  └──────────┘  └──────────┘  └──────────────────┘      │
└─────────────────────────────────────────────────────────┘
```

### 1. ZelfProof Biometric Engine (Existing, Production)

Our proprietary biometric encryption technology operates **entirely offline, without servers, databases, or internet connectivity**:

- **Input**: User's face (captured locally via device camera) and metadata to encrypt
- **Process**: `ZelfEncrypt` proprietary algorithm: elliptic curve cryptography combined with neural face feature extraction
- **Output**: `ZelfProof`, an encrypted packet **devoid of any biometric information**, safe for on-chain storage and transmission

**Why this matters for Stellar**: No other inheritance solution can perform identity verification without a centralized server or oracle trust assumption. Zelf enables **truly decentralized beneficiary verification**. The Soroban contract can validate entitlement without ever seeing, storing, or processing biometric data.

**Platform availability (shipping today):**
- JavaScript/TypeScript SDK (Web)
- iOS SDK (Swift)
- Android SDK (Java/Kotlin)

### 2. Soroban Inheritance Registry Contract (To Be Developed)

A Soroban smart contract implementing:

- **Policy Registration**: Asset holders register inheritance policies specifying 1 to 5 beneficiaries and the lawyer, Shamir's Secret Sharing threshold configuration, and inactivity thresholds. The seed phrase is split into shares (Using Shamir's secret) at policy creation; no asset allocation or fund transfer is involved.
- **Heartbeat Tracking**: Receives and validates ZK-compressed heartbeat proofs, updating the policy's liveness state using Soroban's `Persistent` storage
- **Claim Processing**: Validates beneficiary entitlement proofs (ZelfProof verification), enforces grace periods, and upon successful verification, enables beneficiaries and lawyer to reconstruct the seed phrase from their Shamir shares.
- **Multi-sig Support**: Optional integration with Stellar's native multi-signature capabilities for institutional use cases
- **Soroban Storage Optimization**: Uses Soroban's three-tier storage model (Persistent for policies, Temporary for heartbeat state, Instance for contract config) to minimize costs

**Migration advantage**: Both Solana and Soroban use **Rust** as the primary smart contract language. Our existing Solana program logic (written in Rust with Anchor) can be adapted to Soroban's SDK with these changes:
- Replace Anchor macros with Soroban's `#[contract]` and `#[contractimpl]` macros
- Adapt account model (Solana accounts → Soroban typed storage)
- Replace `msg.sender` patterns with Soroban's `require_auth()` model
- Use Soroban's native `Env` parameter for blockchain interaction
- Use `soroban-sdk` testing utilities instead of Anchor's test framework

**Estimated porting effort**: 60-70% of business logic is directly reusable. Storage patterns and authentication require rewriting.

### 3. Heartbeat Protocol (Adapted from Solana/Light Protocol)

On Solana, we use Light Protocol for ZK-compressed state management. On Stellar/Soroban, we will adapt this to:

- **Soroban Events**: Use Soroban's event system for heartbeat emission (lower cost than state storage)
- **Merkle Proof Accumulator**: Implement a compact Merkle tree in the Soroban contract to track heartbeat history without per-beat state bloat
- **BLS12-381 Support**: Use Soroban's native BLS12-381 elliptic curve support for efficient ZK proof verification on-chain
- **Compressed Proofs (optional)**: Batch multiple heartbeats into a single proof, submitted periodically to minimize transaction costs

### 4. Guardian Oracle Service (Proof of Concept)

A notification service (proof of concept, to be completed) that:

- Monitors inactivity time and grace period; when both expire, notifies the lawyer that the people involved in the inheritance plan can access the creator's funds
- If the lawyer is unaware of the process or fails to notify beneficiaries, automatically notifies beneficiaries directly after an additional grace period
- Provides Soroban-compatible oracle responses via standardized interface

### 5. Developer SDK & Integration Layer (To Be Developed for Stellar)

- **Stellar Wallet SDK**: Drop-in module for Stellar wallets to add "Legacy Mode"
- **Soroban Contract SDK**: High-level Rust crate wrapping the inheritance contract interactions
- **JavaScript/TypeScript Client**: For web applications integrating inheritance features
- **REST API Bridge**: For custodians and institutions preferring traditional API integration

---

## Traction Evidence

### Existing Production Infrastructure

Zelf has **shipping products and real users**:

1. **ZelfProof Technology**: In production across multiple platforms, trusted by Circle, Ar.io, Pinata, ID R&D, and OffChain Labs
2. **Biometric SDK**: Deployed across 3 platforms (Web Extension, iOS, Android) with enterprise customers
3. **Verifik Identity Platform**: 5+ years operating a production identity verification platform supporting 190+ countries, with government database integrations, liveness detection, and KYC/AML compliance
4. **Zelf Name Service (ZNS)**: Live product. The world's first wallet using ZK Face Proof for seed phrase management, available on Google Play | App Store for iOS devices and as a browser extension.
5. **Multi-chain Development**: Legacy module actively under development on Solana (Light Protocol integration) and Avalanche, with significant code completion
6. **Token Pre-Sale**: Active ZNS token pre-sale demonstrating community traction and market demand
7. **Open Source**: Core SDKs and extension published on GitHub under Open-Verifik organization

### Enterprise Partnerships

- **Circle**: USDC integration and trust validation
- **Ar.io**: Decentralized storage integration
- **Pinata**: IPFS pinning for proof storage
- **ID R&D**: Liveness detection technology partnership
- **OffChain Labs**: Infrastructure collaboration
- **Avalanche**: We participated in a Privacy hackathon and won 1st place.

### Why Stellar?

We care about payments, rightful owners, and passing assets to family when it matters. So does Stellar.

Stellar's architecture fits inheritance well:

1. **Low transaction costs**: Heartbeat signals and policy updates must be economically sustainable over years or decades. Stellar's sub-cent fees make this viable.
2. **5-second finality**: Critical for time-sensitive claim processing
3. **Soroban's Rust ecosystem**: Direct code portability from our Solana Rust codebase
4. **BLS12-381 support**: Native support for the cryptographic curves our ZK proofs require
5. **Real-world financial infrastructure**: Stellar's focus on real-world assets and financial inclusion aligns with inheritance, a fundamentally real-world financial need.
6. **Multi-asset support**: A single seed phrase unlocks the wallet holding assets across chains; inheritance policies govern wallet access, not per-asset allocation
7. **Regulatory alignment**: Stellar's compliance-friendly design supports the legal enforceability requirements of inheritance

---

## Requested Budget

**Total: $90,000 USD (in XLM)**

### Tranche 1: MVP ($25,000)

**Deliverable 1: Soroban Inheritance Registry Contract + ZelfProof Integration** + Demo in Testnet

**Timeline:** 5 weeks (April 1 – May 6, 2026)

**Description:**

Build the Soroban contract that stores inheritance policy metadata (who holds which Shamir share, inactivity windows, grace periods) and enforces claim eligibility. The contract integrates with ZelfProof for biometric verification of beneficiaries and the lawyer. Users register 1 to 5 beneficiaries plus a lawyer; the seed phrase is split into shares at setup. When the claim flow completes, beneficiaries and lawyer reconstruct the phrase off-chain. No funds ever touch the contract.

We adapt the state machine and policy rules from our live Solana build (which is very expensive at the moment), swapping Anchor for Soroban macros and PDAs for typed storage.

**Deliverables:**

- Soroban smart contract implementing inheritance policy logic deployed on Stellar Testnet
- ZelfProof verification module integrated into the contract (on-chain proof validation)
- Ability to create an inheritance policy specifying:
  - 1 to 5 beneficiaries and the lawyer (each with ZelfProof biometric binding)
  - Shamir's Secret Sharing configuration (threshold for reconstruction)
  - Claim conditions (inactivity period, grace period)
  - No asset allocation; policy governs wallet access only
- Heartbeat Protocol implementation on Soroban:
  - Heartbeat accumulator contract (tracks liveness signals)
  - Privacy-preserving heartbeat emission (no policy existence leakage)
  - Configurable inactivity thresholds (30 days to 24 months)
  - Grace period management with notification hooks
  - Merkle proof-based heartbeat history verification
- Successful execution of a simulated inheritance event on Stellar Testnet demonstrating:
  - Policy creation with biometric binding
  - Heartbeat submission and tracking (with liveness detection)
  - Inactivity detection and claim eligibility
  - Beneficiary verification via ZelfProof
  - Seed phrase reconstruction from Shamir shares (no fund transfers)
- Public GitHub repository containing:
  - Soroban contract code (Rust)
  - Unit tests
  - Integration tests using `soroban-cli`
  - Deployment scripts for Testnet
- Technical documentation:
  - Contract architecture diagrams
  - Policy configuration guide
  - Comparison with Solana implementation (migration notes)
  - live demo working with testnet

### Tranche 2: Testnet ($35,000)

**Deliverable 2: Guardian Oracle + Claim Verification Pipeline**

**Timeline:** 6 weeks (May 7 – June 17, 2026)

**Description:**

Implementation of the Guardian Oracle notification service and the claim verification pipeline. When inactivity and grace period expire, the oracle notifies the lawyer (or beneficiaries directly if the lawyer does not act). The claim flow validates that the claimant matches the registered ZelfProof before enabling seed phrase reconstruction.

**Deliverables:**

- Guardian Oracle Service:
  - Soroban-compatible oracle interface contract on Stellar Testnet
  - Monitors inactivity and grace period; notifies lawyer when beneficiaries can access funds
  - Fallback: if lawyer does not notify beneficiaries, automatically notifies beneficiaries after additional grace period
  - Oracle node reference implementation
- Claim verification pipeline:
  - When a beneficiary claims, they prove they match the registered ZelfProof (biometric verification runs client-side)
  - Contract validates the claim is authorized; no identity data is stored or exposed on-chain
- End-to-end test demonstrating complete workflow:
  - Policy creation → heartbeat monitoring → inactivity detection → lawyer notification (or direct beneficiary notification if lawyer does not act) → beneficiary claim → ZelfProof verification → seed phrase reconstruction from Shamir shares
- Open-source repositories:
  - Guardian Oracle interface and reference implementation
  - Integration test suite
- Technical documentation:
  - Oracle interface specification
  - Claim verification flow and security model

### Tranche 3: Mainnet ($30,000)

**Deliverable 3: Developer SDK, Wallet Integration, Documentation & Mainnet Launch**

**Timeline:** 6 weeks (June 18 – July 29, 2026)

**Description:**

Creation of developer tooling, wallet integration modules, and documentation enabling any Stellar wallet, custodian, or financial application to add inheritance capabilities. Includes a demonstration application, mainnet deployment, and UX-ready onboarding flows.

**Deliverables:**

- **Stellar Wallet SDK** (`@zelf/stellar-legacy-sdk`):
  - TypeScript/JavaScript package for web wallets
  - Policy creation, heartbeat management, claim processing
  - ZelfProof biometric integration (uses existing production SDKs)
  - Freighter wallet integration example (maybe?)
  - Lobstr wallet integration example (maybe?)
- **Soroban Contract SDK** (`zelf-legacy-soroban`):
  - Rust crate for direct Soroban contract interaction
  - High-level API for policy management
  - Testing utilities and mock environments
- **Demonstration Application**:
  - Web Extension application showing complete inheritance flow
  - Android application showing complete inheritance flow
  - iOS application showing complete inheritance flow
  - Policy creation with biometric beneficiary binding
  - Heartbeat monitoring dashboard (inside the Web Extension, Android & iOS apps)
  - Claim simulation interface
  - Deployed and accessible for public testing
- **Mainnet Deployment**:
  - All contracts deployed on Stellar Mainnet
  - Guardian Oracle service operational
  - Monitoring and alerting infrastructure
- **Developer Documentation**:
  - Architecture diagrams and system overview
  - Step-by-step integration guide for wallet developers
  - API reference documentation
  - Security best practices guide
  - Example applications and code samples
  - Video tutorials (2-3 walkthroughs)
- **UX Readiness** (per SCF 7.0 requirements):
  - Onboarding flow for inheritance policy creation
  - Beneficiary claim flow with biometric verification
  - Mobile-responsive interface
  - Usability testing results

---

## Alternative Approaches and Their Limitations

Some inheritance solutions in the ecosystem use a fund-transfer model: verifiable life-status attestations trigger conditional asset transfers to or through smart contracts. This approach shares several common pitfalls:

#### 1. Architecture Stage vs. Production

Many proposals remain at the "architecture validation stage" with only design documents, patent applications, and early ecosystem discussions. No shipping product, no users, no SDK.

**Zelf's position**: We have production SDKs across 5 platforms, enterprise customers (Circle, Ar.io, Pinata), a shipping wallet app, and active multi-chain development of the Legacy feature.

#### 2. Undefined Zero-Knowledge Implementation

Solutions that claim "zero-knowledge entitlement verification" often provide no specifics on which ZK framework they will use, how proofs will be generated or verified, or how they will handle the substantial research challenges in ZK circuit development. Building production-grade ZK infrastructure from scratch typically requires $500K to $2M+ and dedicated teams.

**Zelf's position**: We use a production-proven biometric verification system (ZelfProof) that already performs zero-knowledge face matching without storing biometric data. No new ZK circuits need to be designed from scratch. We adapt existing production infrastructure.

#### 3. Fund-Transfer Model Creates Unacceptable Risk

Approaches that involve "conditional asset transfers" require funds to be moved to or through smart contracts. This creates custody risk (smart contract bugs), opportunity cost (locked funds cannot participate in DeFi or staking), composability loss (assets become illiquid), and regulatory exposure (holding user funds may trigger money transmitter regulations).

**Zelf's position**: We transfer **access rights**, not funds. Assets remain in the user's wallet, fully under their control, earning yield, participating in DeFi, until the moment of inheritance. This is fundamentally safer and more practical.

#### 4. Single Oracle Dependency

Solutions that rely on external oracle interfaces for death-status attestations create a single point of failure and trust. If the oracle is compromised, manipulated, or unavailable, the entire system fails.

**Zelf's position**: Our three-layer verification (Heartbeat Protocol + Liveness Detection + KYC Matching) creates defense in depth. The heartbeat is automated and tamper-proof. The claim process requires physical biometric presence. No single oracle can trigger false inheritance.

#### 5. Execution Risk

Projects with minimal teams or unproven engineering capacity face significant execution risk when the scope includes Soroban smart contracts, ZK circuits, oracle infrastructure, and developer SDKs.

**Zelf's position**: Zelf/Verifik has 10+ engineers with 5+ years of production experience in biometrics, identity verification, blockchain integration, and SDK development across multiple platforms.

#### 6. Ecosystem Integration

Solutions without existing users, wallet partnerships, or SDK users have not demonstrated the ability to ship developer tools that the ecosystem will adopt.

**Zelf's position**: Our biometric SDKs are already integrated by enterprise customers. We have proven our ability to ship cross-platform tools that developers actually use.

---

## Soroban / Stellar Technical Adaptation Plan

### What We Already Have (Proven Components)

| Component | Current Stack | Soroban Adaptation Effort |
|---|---|---|
| **ZelfProof Engine** | TypeScript/Native (offline) | **None**. Runs client-side, chain-agnostic |
| **Inheritance Business Logic** | Rust (Solana/Anchor) | **Medium**. Same language, different SDK/macros |
| **Heartbeat Protocol** | Solana + Light Protocol (ZK compression) | **Medium**. Adapt to Soroban events and Merkle tree |
| **Biometric SDKs** | Web, iOS, Android, Flutter, RN | **None**. Client-side, chain-agnostic |
| **KYC/AML Verification** | Verifik Production API | **None**. Backend service, chain-agnostic |
| **Guardian Oracle** | Proof of concept (Node.js) | **Medium**. Complete and adapt to Soroban |
| **Arweave/IPFS Storage** | Production integration | **None**. Storage layer is chain-agnostic |

### Key Technical Differences: Soroban vs. Solana

| Aspect | Solana (Current) | Soroban (Target) |
|---|---|---|
| **Language** | Rust (Anchor framework) | Rust (Soroban SDK) |
| **Runtime** | SVM (Solana Virtual Machine) | WASM (WebAssembly) |
| **Auth Model** | `msg.sender` implicit | `require_auth()` explicit |
| **Storage** | Accounts (PDAs) | Typed storage (Persistent/Temporary/Instance) |
| **Finality** | ~400ms | ~5 seconds |
| **Tx Cost** | ~$0.00025 | ~$0.0001 |
| **ZK Support** | Via Light Protocol (external) | Native BLS12-381 curves |
| **Testing** | Anchor test framework | `soroban-cli` + SDK test utils |
| **Token Standard** | SPL Tokens | Stellar Assets + Soroban Tokens |

### Migration Strategy

1. **Core contract logic**: Port Rust business logic from Anchor macros to Soroban macros. Storage patterns change significantly (PDAs → typed storage), but the inheritance state machine is identical.

2. **Authentication**: Replace implicit `msg.sender` with Soroban's explicit `require_auth()`. More verbose but equally secure.

3. **ZK compression**: Replace Light Protocol integration with Soroban-native approach using BLS12-381 curves for proof verification and Merkle accumulator for heartbeat compression.

4. **Token interactions**: Replace SPL token operations with Stellar asset and Soroban token operations.

5. **Testing**: Migrate from Anchor's test framework to Soroban's built-in testing utilities, which provide simulated environments and cost estimation.

---

## Team

### Core Team

**Miguel Treviño**, Co-Founder & CTO
- 10+ years of software engineering experience
- Built and scaled Verifik identity verification platform (190+ countries)
- Expertise in biometrics, cryptography, and blockchain integration
- Led development of ZelfProof biometric encryption technology
- DevOps and infrastructure management at scale
- Multi-chain development experience (Solana, Avalanche, Arweave, Ethereum, Bitcoin)

**Carlos Bleck**, Lead Mobile Engineer
- 10+ years of mobile development experience
- Built multiple applications in different industries like Ride-sharing, Self Custodian wallets, etc
- Expertise in Android & iOS native development and blockchain integrations
- Led the mobile development of Zelf Name Service
- Multi-chain development experience (Solana, Avalanche, Arweave, Ethereum, Bitcoin)

**Johan Castellanos** Co-Founder & CEO
- 

### Technology Partners

- **ID R&D**: Liveness detection technology
- **Pinata**: IPFS infrastructure
- **Ar.io / Arweave**: Permanent decentralized storage
- **Circle**: USDC and stablecoin integration
- **Light Protocol**: ZK compression (Solana, informing Stellar adaptation)

### Advisory

- Legal counsel experienced in digital asset inheritance law across multiple jurisdictions
- Blockchain security auditors (planned: Ackee Blockchain or OtterSec for Soroban contracts)

---

## Post-Launch Maintenance

After mainnet launch, Zelf commits to:

1. **Ongoing contract maintenance**: Bug fixes, security patches, and Soroban version upgrades
2. **SDK updates**: Keeping pace with Stellar SDK releases and wallet ecosystem changes
3. **Oracle operation**: Continuous operation of Guardian Oracle service nodes
4. **Developer support**: Active GitHub issue management, documentation updates, and community engagement
5. **Ecosystem expansion**: Integrating with additional Stellar wallets and custodians as they adopt the standard
6. **Revenue model**: Sustainable through Zelf's existing SaaS licensing (per-transaction and per-annual-active-user pricing). The grant funds development, not operations.

---

## Risk Mitigation

| Risk | Mitigation |
|---|---|
| Soroban contract security | Third-party audit by Ackee Blockchain or OtterSec before mainnet |
| ZK proof performance on Soroban | Use native BLS12-381 support; fallback to off-chain verification with on-chain attestation |
| Oracle manipulation | Multi-signal attestation requirement; no single oracle can trigger inheritance |
| Regulatory uncertainty | Jurisdiction-aware policy framework; legal counsel integration; access-rights model avoids custody classification |
| User adoption | Integration with existing Stellar wallets (Freighter, Lobstr) reduces friction; SDK-first approach |
| Key person risk | 10+ person engineering team with documented architecture; all code open-source |

---

## Why Fund Zelf Legacy?

1. **Execution certainty**: We have a shipping product, production infrastructure, and multi-chain development experience. We are not starting from architecture slides.

2. **Superior technology**: ZelfProof biometric encryption is production-proven, serverless, and privacy-preserving. We adapt existing infrastructure rather than building ZK circuits from scratch.

3. **Safer architecture**: Access-rights inheritance keeps funds in user wallets. Fund-transfer approaches create systemic risk.

4. **Stronger verification**: Three-layer biometric verification (heartbeat + liveness + KYC) beats single-oracle dependency.

5. **Ecosystem value**: Our SDKs bring an existing developer community and enterprise partnerships to Stellar.

6. **Budget efficiency**: We're adapting proven Rust code and production infrastructure to Soroban, not building everything from scratch. Every dollar goes further.

7. **Long-term sustainability**: Zelf has a revenue model (SaaS licensing) that ensures post-grant sustainability.

---

## Open Source Commitment

All Stellar-specific deliverables will be open-sourced under the MIT license:

- Soroban inheritance contracts
- Heartbeat protocol implementation
- Guardian Oracle interface
- Developer SDKs (TypeScript + Rust)
- Demonstration application
- Documentation and integration guides

Core ZelfProof biometric engine remains proprietary (trade secret) but is available via published SDKs with free tier access for Stellar ecosystem developers.

---

## Summary

Zelf Legacy represents the most credible, technically mature, and immediately executable inheritance infrastructure proposal for the Stellar ecosystem. We are not asking the SCF to fund a research project. We are asking it to fund the Stellar adaptation of production infrastructure that is already being built across multiple chains.

The $90,000 investment will deliver:
- A complete Soroban inheritance contract suite
- Privacy-preserving heartbeat protocol
- Multi-signal death verification oracle
- Developer SDKs for wallet and custodian integration
- A demonstration application
- Mainnet deployment with ongoing maintenance

All built on top of the only serverless, offline-capable biometric encryption technology in the blockchain ecosystem.

**Zelf Legacy: Inherit your legacy without compromise.**

---

*Submitted by Zelf World LLC / Verifik SAS*
*Contact: [team@zelf.world](mailto:team@zelf.world)*
*Website: [https://zelf.world/zelf-legacy](https://zelf.world/zelf-legacy)*
*GitHub: [https://github.com/Open-Verifik](https://github.com/Open-Verifik)*

---

**Alternative proposal titles (40 chars or less):**

1. Zelf Legacy: Inheritance for Stellar
2. Biometric Inheritance Infrastructure
3. Death-Proof Your Crypto
4. Your Face. Your Legacy. Forever.
5. Keys That Outlive You

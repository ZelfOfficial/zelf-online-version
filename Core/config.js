const existingNodeEnv = process.env.NODE_ENV;
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env"), override: true });
if (existingNodeEnv) {
    process.env.NODE_ENV = existingNodeEnv;
}

const API_ROOT = "/api";
const splitCsv = (value) =>
    String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
const csvOrDefault = (value, fallback) => {
    const items = splitCsv(value);
    return items.length ? items : fallback;
};

const parseWhatsAppExtraApiKeys = () => {
    if (!process.env.WHATSAPP_EXTRA_API_KEYS) return {};

    try {
        return JSON.parse(process.env.WHATSAPP_EXTRA_API_KEYS);
    } catch (error) {
        console.error("Invalid WHATSAPP_EXTRA_API_KEYS JSON:", error.message);
        return {};
    }
};

/** Absolute origin for zelf-dashboard Plan & Billing Stripe redirects (success/cancel). */
const stripeDashboardUrlBase = String(
    (process.env.DASHBOARD_URL || process.env.FRONTEND_URL || "https://dashboard.zelf.world").trim() || "https://dashboard.zelf.world",
).replace(/\/$/, "");

/** Default Arweave gateway pool — override per server via .env (see arwave in configuration). */
const ARWEAVE_DEFAULT_PUBLIC_GATEWAY_URL = "https://arweave.net";
const ARWEAVE_DEFAULT_GRAPHQL_GATEWAYS = [
    "https://arweave-search.goldsky.com",
    "https://arweave.net",
    "https://turbo-gateway.com",
    "https://ardrive.net",
];
const ARWEAVE_DEFAULT_ARNS_GATEWAY_HOST = "arweave.net";

/** Positive finite float from env; otherwise `fallback` (for USD rates and REWARD_PRICE). */
const parsePositiveFloat = (value, fallback) => {
    const n = parseFloat(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

const configuration = {
    name: "API",
    env: process.env.NODE_ENV || "development",
    port: process.env.PORT || "3000",
    base_url: process.env.BASE_URL || "https://verifik.co",
    sessionSecret: process.env.SESSION_SECRET,
    so: process.env.ENVOS,
    sessions: {
        version: 2,
        globalLimit: process.env.GLOBAL_LIMIT || 5 * 60 * 10, // 5 requests per second for 10 minutes
        previewLimit: process.env.PREVIEW_LIMIT || 1 * 30 * 10, // 1 request per 2 seconds for 10 minutes
        searchLimit: process.env.SEARCH_LIMIT || 1 * 30 * 10, // 1 request per 2 seconds for 10 minutes
        leaseLimit: process.env.LEASE_LIMIT || 15, // 30 requests max per 10 minutes
        decryptLimit: process.env.DECRYPT_LIMIT || 30, // 30 requests max per 10 minutes
    },
    email_providers: {
        mailgun: {
            proxyEmail: process.env.MAILGUN_PROXY_EMAIL || "miguel@zelf.world",
            apiKey: process.env.MAILGUN_API_KEY,
        },
    },
    signedData: {
        key: process.env.SECRET_KEY_PRICI,
    },
    debug: {
        mongo: process.env.DEBUG_MONGO === "true",
        sendEmail: process.env.DEBUG_SEND_EMAIL === "true",
    },
    db: {
        uri: process.env.MONGODB_URI_PROD || process.env.MONGODB_URI,
        user: process.env.MONGO_USER,
        password: process.env.MONGO_PASSWORD,
        poolSize: Number(process.env.MONGO_POOLSIZE) || 50,
        test_uri: "mongodb://127.0.0.1:27017/testdb",
    },
    queue: {
        collectionName: process.env.QUEUE_NAME,
        instance: Number(process.env.QUEUE_INSTANCE),
        time: process.env.QUEUE_TIME,
    },
    JWT_SECRET: process.env.CONNECTION_KEY,
    SUPERADMIN_JWT_SECRET: process.env.SUPER_ADMINS_JWT_SECRET,
    encryptionSecret: process.env.FRONTEND_KEY,
    basePath: (path) => {
        return API_ROOT.replace(/\/$/, "") + "/" + path.replace(/^\//, "");
    },
    full_url: process.env.BASE_URL + ":" + process.env.PORT,
    zelfEncrypt: {
        serverKey: process.env.ZELF_ENCRYPT_SERVER_KEY,
    },
    zelfProof: {
        url: process.env.ZELF_PROOF_URL || "https://v4.zelf.world",
        apiKey: process.env.ZELF_PROOF_API_KEY || "password",
        skipArweave: process.env.SKIP_ARWEAVE || false,
    },
    /** ZelfEncrypt v4 stack for ZelfID / HumanAuthn (`https://v4.zelf.world` + `/zelf-v4/*`). Tags stay on zelfProof.url + `/zelf/*`. */
    zelfProofV4: {
        url: process.env.ZELF_PROOF_V4_URL || "https://v4.zelf.world",
        apiKey: process.env.ZELF_PROOF_API_KEY_V4 || process.env.ZELF_PROOF_V4_API_KEY || "password",
        pathPrefix: process.env.ZELF_PROOF_V4_PATH_PREFIX || "/zelf-v4",
    },
    token: {
        rewardPrice: parsePositiveFloat(process.env.REWARD_PRICE, 0.05),
        whitelist: process.env.WHITELIST || "",
        priceEnv: process.env.PRICE_ENV || "production",
    },
    /** Dashboard Plan & Billing copy + subscription pricing disclosure (USD per operation before ZNS conversion). */
    subscriptionPricing: {
        encryptUsd: parsePositiveFloat(process.env.API_USAGE_ENCRYPT_USD, 0.1),
        activeUserMonthlyUsd: parsePositiveFloat(process.env.API_USAGE_ACTIVE_USER_USD, 0.1),
        decryptWithLivenessUsd: parsePositiveFloat(process.env.API_USAGE_DECRYPT_WITH_LIVENESS_USD, 0.05),
        decryptNoLivenessUsd: parsePositiveFloat(process.env.API_USAGE_DECRYPT_NO_LIVENESS_USD, 0.01),
        /** Free decrypts per month when liveness applies (marketing / disclosure). */
        decryptIncludedPerMonth: (() => {
            const raw = process.env.API_USAGE_DECRYPT_INCLUDED_PER_MONTH;
            if (raw === undefined || raw === "") return 10;
            const n = Math.floor(Number(raw));
            return Number.isFinite(n) && n >= 0 ? n : 10;
        })(),
    },
    landingUrl: process.env.LANDING_URL || (process.env.NODE_ENV === "development" ? "http://localhost:3009" : "https://zelf.world"),
    pgp: {
        secretKey: process.env.PGP_SECRET_KEY || "",
        passphrase: process.env.PGP_PASSPHRASE || "",
        globalSecretKey: process.env.PGP_GLOBAL_SECRET_KEY || "",
        globalPassphrase: process.env.PGP_GLOBAL_PASSPHRASE || "",
    },
    etherscan: {
        urlEtherscan: "https://api.etherscan.io/api",
        apiKey: process.env.ETHERSCAN_API_KEY || process.env.INFURA_APIKEY,
        /** Cap ERC-20 rows in GET /api/ethereum/address (whale wallets can hold thousands). */
        addressMaxTokens: Number(process.env.ETHEREUM_ADDRESS_MAX_TOKENS) || 150,
        /** Drop holdings below this USD value from the address overview. */
        addressMinFiatUsd: Number(process.env.ETHEREUM_ADDRESS_MIN_FIAT_USD) || 0.01,
        /** Max concurrent CMC id lookups when Ethplorer fallback formats tokens. */
        addressCmcConcurrency: Number(process.env.ETHEREUM_ADDRESS_CMC_CONCURRENCY) || 5,
        /** Max concurrent Alchemy metadata RPC calls for capped token rows. */
        addressMetadataConcurrency: Number(process.env.ETHEREUM_ADDRESS_METADATA_CONCURRENCY) || 5,
    },
    binance: {
        urlBinance: "https://api.binance.com/",
    },
    mailgun: {
        apiKey: process.env.MAILGUN_API_KEY || "my_key",
    },
    terms: {
        zk: process.env.ZK1 || "_",
        _zk: process.env.ZELF1 || "_",
    },
    arwave: {
        env: process.env.ARWAVE_ENV || "production",
        key: process.env.ARWAVE_KEY,
        publicGatewayUrl: process.env.ARWEAVE_PUBLIC_GATEWAY_URL || ARWEAVE_DEFAULT_PUBLIC_GATEWAY_URL,
        graphqlGateways: csvOrDefault(process.env.ARWEAVE_GRAPHQL_GATEWAYS, ARWEAVE_DEFAULT_GRAPHQL_GATEWAYS),
        arnsGatewayHost: process.env.ARWEAVE_ARNS_GATEWAY_HOST || ARWEAVE_DEFAULT_ARNS_GATEWAY_HOST,
        owner: process.env.ARWEAVE_OWNER,
        n: process.env.ARWAVE_N,
        e: process.env.ARWAVE_E,
        d: process.env.ARWAVE_D,
        p: process.env.ARWAVE_P,
        q: process.env.ARWAVE_Q,
        dp: process.env.ARWAVE_DP,
        dq: process.env.ARWAVE_DQ,
        qi: process.env.ARWAVE_QI,
        hold: {
            owner: process.env._ARWEAVE_OWNER,
            n: process.env._ARWAVE_N,
            e: process.env._ARWAVE_E,
            d: process.env._ARWAVE_D,
            p: process.env._ARWAVE_P,
            q: process.env._ARWAVE_Q,
            dp: process.env._ARWAVE_DP,
            dq: process.env._ARWAVE_DQ,
            qi: process.env._ARWAVE_QI,
        },
        parentName: process.env.ARWEAVE_PARENT_NAME,
        processId: process.env.ARWEAVE_PROCESS_ID,
        transactionId: process.env.ARWEAVE_TRANSACTION_ID,
    },
    pinata: {
        apiKey: process.env.PINATA_API_KEY || process.env.__PINATA_API_KEY || process.env["2_PINATA_API_KEY"],
        secretKey: process.env.PINATA_API_SECRET || process.env.__PINATA_API_SECRET || process.env["2_PINATA_API_SECRET"],
        jwt: process.env.PINATA_JWT || process.env.__PINATA_JWT || process.env["2_PINATA_JWT"],
        gatewayUrl: process.env.PINATA_GATEWAY_URL || process.env.__PINATA_GATEWAY_URL || process.env["2_PINATA_GATEWAY_URL"],
        // VaultLegacy relay uses _prefixed env vars (dev/alternate Pinata account)
        vaultLegacy: {
            apiKey: process.env._PINATA_API_KEY,
            secretKey: process.env._PINATA_API_SECRET,
            jwt: process.env._PINATA_JWT,
        },
    },
    arns: {
        processId: process.env.ARNS_PROCESS_ID,
        index_transaction_id: process.env.ARNS_INDEX_TRANSACTION_ID,
        blockdag_transaction_id: process.env.ARNS_BLOCKDAG_TRANSACTION_ID || "9Kz-HCKRaWmM5fAc9A2q7sJbUIRAGQ5X9GDKdI7l76Q",
    },
    walrus: {
        network: process.env.WALRUS_NETWORK || "testnet",
        privateKey: process.env.WALRUS_PRIVATE_KEY,
        suiRpcUrl: process.env.WALRUS_SUI_RPC_URL || "https://fullnode.testnet.sui.io:443",
        defaultEpochs: Number(process.env.WALRUS_DEFAULT_EPOCHS) || 5,
        maxFileSize: Number(process.env.WALRUS_MAX_FILE_SIZE) || 100 * 1024, // 100KB
    },
    google: {
        captchaProjectID: process.env.CAPTCHA_PROJECT_ID,
        webSiteKey: process.env.CAPTCHA_WEB_SITE_KEY,
        androidSiteKey: process.env.CAPTCHA_ANDROID_SITE_KEY,
        iOSSiteKey: process.env.CAPTCHA_IOS_SITE_KEY,
        captchaApproval: Boolean(process.env.CAPTCHA_APPROVAL === "true"),
        geminiApiKey: process.env.GEMINI_API_KEY,
        geminiAuthMode: process.env.GEMINI_AUTH_MODE || "api_key", // 'api_key' or 'service_account'
    },
    revenueCat: {
        allowedEmail: process.env.REVENUECAT_ALLOWED_EMAIL,
    },
    solana: {
        rpcUrl:
            process.env.SOLANA_RPC_URL ||
            process.env.SOLANA_RPC_ENDPOINT ||
            (process.env.SOLANA_NODE_SECRET
                ? `https://flashy-ultra-choice.solana-mainnet.quiknode.pro/${process.env.SOLANA_NODE_SECRET}/`
                : "https://api.mainnet-beta.solana.com"),
        senderPublicKey: process.env.SOLANA_SENDER_PUBLIC_KEY,
        sender: process.env.SENDER_KEY,
        nodeSecret: process.env.SOLANA_NODE_SECRET,
        tokenMintAddress: process.env.SOLANA_TOKEN_MINT_ADDRESS,
        devModeTokens: process.env.SOLANA_DEV_MODE_TOKENS,
        useKit: process.env.SOLANA_USE_KIT === "true",
        jupiterApiKey: process.env.JUP_API_KEY,
    },
    ton: {
        rpcUrl: process.env.TON_RPC_URL || "https://toncenter.com/api/v2/jsonRPC",
        apiKey: process.env.TON_API_KEY || "",
        indexerUrl: process.env.TON_INDEXER_URL || "https://tonapi.io",
        serviceWalletAddress: process.env.TON_SERVICE_WALLET_ADDRESS || "",
        usdtJettonMaster:
            process.env.TON_USDT_JETTON_MASTER || "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs",
        timeoutMs: Number(process.env.TON_TIMEOUT_MS) || 30000,
    },
    aptos: {
        network: process.env.APTOS_NETWORK || "mainnet",
        fullnodeUrl: process.env.APTOS_FULLNODE_URL || "",
        indexerUrl: process.env.APTOS_INDEXER_URL || "",
        apiKey: process.env.APTOS_API_KEY || "",
        timeoutMs: Number(process.env.APTOS_TIMEOUT_MS) || 30000,
        maxGasAmount: Number(process.env.APTOS_MAX_GAS_AMOUNT) || 200000,
    },
    canton: {
        network: process.env.CANTON_NETWORK || "devnet",
        ledgerApiUrl: process.env.CANTON_LEDGER_API_URL || "",
        validatorApiUrl: process.env.CANTON_VALIDATOR_API_URL || "",
        scanApiUrl: process.env.CANTON_SCAN_API_URL || "",
        registryApiUrl: process.env.CANTON_REGISTRY_API_URL || "",
        instrumentId: process.env.CANTON_INSTRUMENT_ID || "Amulet",
        authMethod: process.env.CANTON_AUTH_METHOD || "client_credentials",
        authConfigUrl: process.env.CANTON_AUTH_CONFIG_URL || "",
        authIssuer: process.env.CANTON_AUTH_ISSUER || "",
        authClientId: process.env.CANTON_AUTH_CLIENT_ID || "",
        authClientSecret: process.env.CANTON_AUTH_CLIENT_SECRET || "",
        authAudience: process.env.CANTON_AUTH_AUDIENCE || "",
        authScope: process.env.CANTON_AUTH_SCOPE || "",
        staticToken: process.env.CANTON_STATIC_TOKEN || "",
        allowedParties: String(process.env.CANTON_ALLOWED_PARTIES || "")
            .split(",")
            .map((partyId) => partyId.trim())
            .filter(Boolean),
        allowUnboundParties: process.env.CANTON_ALLOW_UNBOUND_PARTIES === "true",
        timeoutMs: Number(process.env.CANTON_TIMEOUT_MS) || 30000,
    },
    oklink: {
        apiKey: process.env.OKLINK_API_KEY,
    },
    alchemy: {
        apiKey: process.env.ALCHEMY_API_KEY,
        timeoutMs: Number(process.env.ALCHEMY_TIMEOUT_MS) || 30000,
        maxTokenMetadataRequests: Number(process.env.ALCHEMY_MAX_TOKEN_METADATA_REQUESTS) || 50,
        curatedTokens: {
            avalanche: {
                USDC: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
                USDT: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
            },
        },
        networks: {
            ethereum:
                process.env.ALCHEMY_ETHEREUM_URL ||
                (process.env.ALCHEMY_API_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : null),
            polygon:
                process.env.ALCHEMY_POLYGON_URL ||
                (process.env.ALCHEMY_API_KEY ? `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : null),
            arbitrum:
                process.env.ALCHEMY_ARBITRUM_URL ||
                (process.env.ALCHEMY_API_KEY ? `https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : null),
            optimism:
                process.env.ALCHEMY_OPTIMISM_URL ||
                (process.env.ALCHEMY_API_KEY ? `https://opt-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : null),
            avalanche:
                process.env.ALCHEMY_AVALANCHE_URL ||
                (process.env.ALCHEMY_API_KEY ? `https://avax-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : null),
        },
    },
    lifi: {
        url: process.env.LIFI_API_URL || "https://li.quest/v1",
        apiKey: process.env.LIFI_API_KEY,
        integrator: process.env.LIFI_INTEGRATOR,
    },
    fantom: {
        rpcUrl: process.env.FANTOM_RPC_URL || "https://fragrant-wild-smoke.fantom.quiknode.pro/9f6de2bac71c11f7c08e97e7be74a9d770c62a86",
    },
    stripe: {
        frontendUrl: process.env.FRONTEND_URL || "http://localhost:4200",
        redirectUrl: process.env.STRIPE_REDIRECTURL || "https://verifik.app",
        secretKey: process.env.STRIPE_SECRET_KEY || "",
        taxes: 0.19,
        zelfKeys: {
            success: `${process.env.FRONTEND_URL}/zelfkeys/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel: `${process.env.FRONTEND_URL}/zelfkeys/cancel?canceled=true`,
        },
        dashboard: {
            /** Absolute origin only (no trailing slash); used for checkout + portal return URLs */
            origin: stripeDashboardUrlBase,
            success: `${stripeDashboardUrlBase}/settings/plan-billing?session_id={CHECKOUT_SESSION_ID}`,
            cancel: `${stripeDashboardUrlBase}/settings/plan-billing?canceled=true`,
        },
        plans: {
            basic: {
                currency: "usd",
                description: "20 new encryptions per month.",
                interval: "month",
                name: "Basic Plan",
                price: 4.99,
                priceId: process.env.STRIPE_BASIC_PRICE_ID,
            },
            pro: {
                currency: "usd",
                description: "50 new encryptions per month",
                interval: "month",
                name: "Pro Plan",
                price: 9.99,
                priceId: process.env.STRIPE_PRO_PRICE_ID,
            },
            enterprise: {
                currency: "usd",
                description: "100 new encryptions per month.",
                interval: "month",
                name: "Enterprise Plan",
                price: 19.99,
                priceId: process.env.STRIPE_ENTERPRISE_PRICE_ID,
            },
        },
    },
    avalanche: {
        contractAddress: process.env.AVALANCHE_CONTRACT_ADDRESS || "0x6C995090C530756d59E6eEa5a3bA209863e0E167",
        /** ZelfAvalanchePay.sol — native AVAX + USDC tag checkout */
        tagPayContractAddress: (process.env.AVALANCHE_TAG_PAY_CONTRACT_ADDRESS || "").trim(),
        /** ERC-20 USDC on same chain as tag pay (constructor arg; used for payUsdc + JWT) */
        tagPayUsdcAddress: (process.env.AVALANCHE_TAG_PAY_USDC_ADDRESS || "").trim(),
        tagPayConfirmations: Math.max(1, Number(process.env.AVALANCHE_TAG_PAY_CONFIRMATIONS) || 1),
        createNFT: process.env.AVALANCHE_CREATE_NFT === "true",
        rpcUrl: process.env.AVALANCHE_RPC_URL,
        chainId: Number(process.env.AVALANCHE_CHAIN_ID) || 43114, // Avalanche C-Chain mainnet; use 43113 for Fuji
        privateKey: process.env.WALRUS_PRIVATE_KEY,
    },
    /** ZelfBscPay.sol — native BNB + USDC + USDT tag checkout */
    bsc: {
        tagPayContractAddress: (process.env.BSC_TAG_PAY_CONTRACT_ADDRESS || "").trim(),
        tagPayUsdcAddress: (process.env.BSC_TAG_PAY_USDC_ADDRESS || "").trim(),
        tagPayUsdtAddress: (process.env.BSC_TAG_PAY_USDT_ADDRESS || "").trim(),
        tagPayConfirmations: Math.max(1, Number(process.env.BSC_TAG_PAY_CONFIRMATIONS) || 1),
        rpcUrl: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
        chainId: Number(process.env.BSC_CHAIN_ID) || 56,
    },
    /** ZelfEthPay.sol — native ETH + USDC + USDT tag checkout */
    ethereum: {
        tagPayContractAddress: (process.env.ETHEREUM_TAG_PAY_CONTRACT_ADDRESS || "").trim(),
        tagPayUsdcAddress: (process.env.ETHEREUM_TAG_PAY_USDC_ADDRESS || "").trim(),
        tagPayUsdtAddress: (process.env.ETHEREUM_TAG_PAY_USDT_ADDRESS || "").trim(),
        tagPayConfirmations: Math.max(1, Number(process.env.ETHEREUM_TAG_PAY_CONFIRMATIONS) || 1),
        rpcUrl: process.env.ETHEREUM_RPC_URL || "https://eth.llamarpc.com",
        chainId: Number(process.env.ETHEREUM_CHAIN_ID) || 1,
    },
    /** ZelfPolygonPay.sol — native POL + USDC + USDT tag checkout */
    polygon: {
        tagPayContractAddress: (process.env.POLYGON_TAG_PAY_CONTRACT_ADDRESS || "").trim(),
        tagPayUsdcAddress: (process.env.POLYGON_TAG_PAY_USDC_ADDRESS || "").trim(),
        tagPayUsdtAddress: (process.env.POLYGON_TAG_PAY_USDT_ADDRESS || "").trim(),
        tagPayConfirmations: Math.max(1, Number(process.env.POLYGON_TAG_PAY_CONFIRMATIONS) || 1),
        rpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
        chainId: Number(process.env.POLYGON_CHAIN_ID) || 137,
    },
    /** ZelfBasePay.sol — native ETH on Base + USDC + USDT tag checkout */
    base: {
        tagPayContractAddress: (process.env.BASE_TAG_PAY_CONTRACT_ADDRESS || "").trim(),
        tagPayUsdcAddress: (process.env.BASE_TAG_PAY_USDC_ADDRESS || "").trim(),
        tagPayUsdtAddress: (process.env.BASE_TAG_PAY_USDT_ADDRESS || "").trim(),
        tagPayConfirmations: Math.max(1, Number(process.env.BASE_TAG_PAY_CONFIRMATIONS) || 1),
        rpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
        chainId: Number(process.env.BASE_CHAIN_ID) || 8453,
    },
    erc8004: {
        rpcUrl: process.env.ERC8004_RPC_URL || process.env.AVALANCHE_RPC_URL || "https://api.avax.network/ext/bc/C/rpc",
        chainId: Number(process.env.ERC8004_CHAIN_ID || 43114),
        identityRegistryAddress: process.env.ERC8004_IDENTITY_REGISTRY || "0xd3c6Fa69B3719a1877145Ff72313F75dc0Af0F69",
        reputationRegistryAddress: process.env.ERC8004_REPUTATION_REGISTRY || "0x5Db2BdA967b4beE92E91e8cf74627655ae3cde83",
        validationRegistryAddress: process.env.ERC8004_VALIDATION_REGISTRY || "0x5E73485fFD6705A7ece0e046C2eb21673120E360",
    },
    cryptoPayments: {
        demoMode: process.env.CRYPTO_PAYMENTS_DEMO_MODE === "true" || false,
        demoMultiplier: 0.005, // 0.5% of original price for demo mode (max $0.049 for $9.99)
    },
    /** VaultLegacy demo wills — never enable LEGACY_DEMO_MODE on production v4.zelf.world */
    legacyDemo: {
        enabled: process.env.LEGACY_DEMO_MODE === "true",
        lawyerAddress: (process.env.LEGACY_DEMO_LAWYER_ADDRESS || "").trim().toLowerCase(),
        lawyerPrivateKey: process.env.LEGACY_DEMO_LAWYER_PRIVATE_KEY || "",
        heartbeatInterval: Number(process.env.LEGACY_DEMO_HEARTBEAT_INTERVAL) || 2592000,
    },
    rpc: {
        /** Upstream JSON-RPC timeout (simulateTransaction / sendTransaction can be slow on Solana). Override with RPC_PROXY_TIMEOUT_MS. */
        timeoutMs: Number(process.env.RPC_PROXY_TIMEOUT_MS) || 45000,
        maxParamsLength: Number(process.env.RPC_PROXY_MAX_PARAMS_LENGTH) || 25,
        /** Protects GET/POST /api/rpc-callers/* together with JWT + X-RPC-Caller-Admin header */
        callerAdminSecret: process.env.RPC_CALLER_ADMIN_SECRET || "",
        /** Per-IP Mongo window buckets (UTC minutes). Swap to Redis if volume requires lower latency. */
        rateLimit: {
            enabled: process.env.RPC_RATE_LIMIT_ENABLED !== "false",
            maxPerMinute: Number(process.env.RPC_RATE_LIMIT_PER_MINUTE) || 300,
            rollingMinutes: Math.max(1, Number(process.env.RPC_RATE_LIMIT_ROLLING_MINUTES) || 5),
            /** Max requests summed over the last `rollingMinutes` (0 = disable rolling check; per-minute only). */
            maxInRollingWindow: Number(process.env.RPC_RATE_LIMIT_MAX_ROLLING) || 1200,
            windowTtlMs: Number(process.env.RPC_RATE_LIMIT_WINDOW_TTL_MS) || 2 * 60 * 60 * 1000,
        },
        allowedMethods: csvOrDefault(process.env.RPC_PROXY_ALLOWED_METHODS, [
            "eth_blockNumber",
            "eth_call",
            "eth_chainId",
            "eth_estimateGas",
            "eth_feeHistory",
            "eth_gasPrice",
            "eth_getBalance",
            "eth_getBlockByHash",
            "eth_getBlockByNumber",
            "eth_getCode",
            "eth_getStorageAt",
            "eth_getTransactionByHash",
            "eth_getTransactionCount",
            "eth_getTransactionReceipt",
            "eth_maxPriorityFeePerGas",
            "net_version",
            "web3_clientVersion",
            "eth_sendRawTransaction",
            "eth_sendTransaction",
            // Solana JSON-RPC (wallet / extension; include if you set RPC_PROXY_ALLOWED_METHODS)
            "getAccountInfo",
            "getBalance",
            "getBlock",
            "getBlockHeight",
            "getBlockProduction",
            "getBlocks",
            "getBlocksWithLimit",
            "getEpochInfo",
            "getFeeForMessage",
            "getFirstAvailableBlock",
            "getGenesisHash",
            "getHealth",
            "getLatestBlockhash",
            "getMinimumBalanceForRentExemption",
            "getMultipleAccounts",
            "getProgramAccounts",
            "getRecentPrioritizationFees",
            "getSignaturesForAddress",
            "getSignatureStatuses",
            "getSlot",
            "getTokenAccountBalance",
            "getTokenAccountsByOwner",
            "getTransaction",
            "getVersion",
            "isBlockhashValid",
            "requestAirdrop",
            "sendTransaction",
            "simulateTransaction",
            // Sui JSON-RPC (global allowlist; if you set RPC_PROXY_ALLOWED_METHODS, include these too)
            "sui_getChainIdentifier",
            "sui_getObject",
            "sui_multiGetObjects",
            "sui_getNormalizedMoveModule",
            "sui_getNormalizedMoveModulesByPackage",
            "sui_getNormalizedMoveFunction",
            "sui_getNormalizedMoveStruct",
            "sui_getCoinMetadata",
            "sui_getTotalSupply",
            "sui_getMoveFunctionArgTypes",
            "sui_getProtocolConfig",
            "sui_getLoadedChildObjects",
            "sui_tryGetPastObject",
            "sui_getDynamicFieldObject",
            "sui_getDynamicFields",
            "sui_getTransactionBlock",
            "sui_multiGetTransactionBlocks",
            "sui_getCheckpoint",
            "sui_getCheckpoints",
            "sui_getLatestCheckpointSequenceNumber",
            "sui_getEvents",
            "sui_getLatestSuiSystemState",
            "sui_getReferenceGasPrice",
            "suix_getStakes",
            "suix_getValidatorsApy",
            "suix_getCommitteeInfo",
            "sui_queryTransactionBlocks",
            "sui_queryEvents",
            "sui_queryObjects",
            "sui_resolveNameServiceNames",
            "sui_resolveNameServiceAddress",
            "sui_getAllBalances",
            "sui_getBalance",
            "sui_getCoins",
            "sui_getAllCoins",
            "dryRunTransactionBlock",
            "executeTransactionBlock",
            "devInspectTransactionBlock",
            "unsafe_transferObject",
            "unsafe_pay",
            "unsafe_paySui",
            "unsafe_payAllSui",
            "unsafe_mergeCoins",
            "unsafe_splitCoins",
            "unsafe_moveCall",
            "unsafe_batchTransaction",
        ]),
        blockedMethodPrefixes: csvOrDefault(process.env.RPC_PROXY_BLOCKED_PREFIXES, [
            "admin_",
            "debug_",
            "engine_",
            "miner_",
            "ots_",
            "personal_",
            "trace_",
            "txpool_",
        ]),
        blockedMethods: csvOrDefault(process.env.RPC_PROXY_BLOCKED_METHODS, [
            "eth_getFilterChanges",
            "eth_getFilterLogs",
            "eth_getLogs",
            "eth_newBlockFilter",
            "eth_newFilter",
            "eth_newPendingTransactionFilter",
            "eth_subscribe",
            "eth_unsubscribe",
        ]),
        chains: {
            ethereum: {
                chainId: Number(process.env.ETHEREUM_CHAIN_ID) || 1,
                rpcUrl: process.env.RPC_PROXY_ETHEREUM_URL || process.env.ETHEREUM_RPC_URL || "https://eth.llamarpc.com",
            },
            avalanche: {
                chainId: Number(process.env.AVALANCHE_CHAIN_ID) || 43114,
                rpcUrl: process.env.RPC_PROXY_AVALANCHE_URL || process.env.AVALANCHE_RPC_URL || "https://api.avax.network/ext/bc/C/rpc",
            },
            polygon: {
                chainId: Number(process.env.POLYGON_CHAIN_ID) || 137,
                rpcUrl: process.env.RPC_PROXY_POLYGON_URL || process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
            },
            bsc: {
                chainId: Number(process.env.BSC_CHAIN_ID) || 56,
                rpcUrl: process.env.RPC_PROXY_BSC_URL || process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
            },
            arbitrum: {
                chainId: Number(process.env.ARBITRUM_CHAIN_ID) || 42161,
                rpcUrl: process.env.RPC_PROXY_ARBITRUM_URL || process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
            },
            optimism: {
                chainId: Number(process.env.OPTIMISM_CHAIN_ID) || 10,
                rpcUrl: process.env.RPC_PROXY_OPTIMISM_URL || process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
            },
            base: {
                chainId: Number(process.env.BASE_CHAIN_ID) || 8453,
                rpcUrl: process.env.RPC_PROXY_BASE_URL || process.env.BASE_RPC_URL || "https://mainnet.base.org",
            },
            blockdag: {
                chainId: Number(process.env.BLOCKDAG_CHAIN_ID) || 1404,
                rpcUrl:
                    process.env.RPC_PROXY_BLOCKDAG_URL ||
                    process.env.BLOCKDAG_MAIN_RPC_URL ||
                    process.env.BLOCKDAG_RPC_URL ||
                    "https://rpc.bdagscan.com",
            },
            /** Sui: chainId is a logical Zelf id for /api/rpc/chains (not an EVM chain id). */
            sui: {
                chainId: Number(process.env.SUI_CHAIN_ID) || 101,
                rpcUrl: process.env.RPC_PROXY_SUI_URL || process.env.SUI_RPC_URL || "https://fullnode.mainnet.sui.io:443",
            },
        },
    },
    /** JWT-only RPC proxy for the wallet extension (POST /api/protected/rpc/:chainKey). Uses EXTENSION_* URLs with fallback to public chain URLs. */
    extension: {
        rpc: {
            chains: {
                ethereum: {
                    chainId: Number(process.env.ETHEREUM_CHAIN_ID) || 1,
                    rpcUrl:
                        process.env.EXTENSION_ETHEREUM_RPC_URL ||
                        process.env.RPC_PROXY_ETHEREUM_URL ||
                        process.env.ETHEREUM_RPC_URL ||
                        "https://eth.llamarpc.com",
                },
                avalanche: {
                    chainId: Number(process.env.AVALANCHE_CHAIN_ID) || 43114,
                    rpcUrl:
                        process.env.EXTENSION_AVALANCHE_RPC_URL ||
                        process.env.RPC_PROXY_AVALANCHE_URL ||
                        process.env.AVALANCHE_RPC_URL ||
                        "https://api.avax.network/ext/bc/C/rpc",
                },
                polygon: {
                    chainId: Number(process.env.POLYGON_CHAIN_ID) || 137,
                    rpcUrl:
                        process.env.EXTENSION_POLYGON_RPC_URL ||
                        process.env.RPC_PROXY_POLYGON_URL ||
                        process.env.POLYGON_RPC_URL ||
                        "https://polygon-rpc.com",
                },
                bsc: {
                    chainId: Number(process.env.BSC_CHAIN_ID) || 56,
                    rpcUrl:
                        process.env.EXTENSION_BSC_RPC_URL ||
                        process.env.RPC_PROXY_BSC_URL ||
                        process.env.BSC_RPC_URL ||
                        "https://bsc-dataseed.binance.org",
                },
                arbitrum: {
                    chainId: Number(process.env.ARBITRUM_CHAIN_ID) || 42161,
                    rpcUrl:
                        process.env.EXTENSION_ARBITRUM_RPC_URL ||
                        process.env.RPC_PROXY_ARBITRUM_URL ||
                        process.env.ARBITRUM_RPC_URL ||
                        "https://arb1.arbitrum.io/rpc",
                },
                optimism: {
                    chainId: Number(process.env.OPTIMISM_CHAIN_ID) || 10,
                    rpcUrl:
                        process.env.EXTENSION_OPTIMISM_RPC_URL ||
                        process.env.RPC_PROXY_OPTIMISM_URL ||
                        process.env.OPTIMISM_RPC_URL ||
                        "https://mainnet.optimism.io",
                },
                base: {
                    chainId: Number(process.env.BASE_CHAIN_ID) || 8453,
                    rpcUrl:
                        process.env.EXTENSION_BASE_RPC_URL ||
                        process.env.RPC_PROXY_BASE_URL ||
                        process.env.BASE_RPC_URL ||
                        "https://mainnet.base.org",
                },
                blockdag: {
                    chainId: Number(process.env.BLOCKDAG_CHAIN_ID) || 1404,
                    rpcUrl:
                        process.env.EXTENSION_BLOCKDAG_RPC_URL ||
                        process.env.RPC_PROXY_BLOCKDAG_URL ||
                        process.env.BLOCKDAG_MAIN_RPC_URL ||
                        process.env.BLOCKDAG_RPC_URL ||
                        "https://rpc.bdagscan.com",
                },
                /** Solana: logical chainId for /api/protected/rpc/chains only (distinct from Sui 101 in public rpc). */
                solana: {
                    chainId: Number(process.env.SOLANA_PROXY_CHAIN_ID) || 102,
                    rpcUrl:
                        process.env.EXTENSION_SOLANA_RPC_URL ||
                        process.env.SOLANA_RPC_URL ||
                        process.env.SOLANA_RPC_ENDPOINT ||
                        (process.env.SOLANA_NODE_SECRET
                            ? `https://flashy-ultra-choice.solana-mainnet.quiknode.pro/${process.env.SOLANA_NODE_SECRET}/`
                            : "https://api.mainnet-beta.solana.com"),
                },
            },
            /**
             * Full `Origin` values allowed for /api/protected/rpc/* (JWT still required).
             * Built from PROTECTED_RPC_ALLOWED_ORIGINS (CSV of full origins) plus
             * PROTECTED_RPC_CHROME_EXTENSION_IDS (CSV of ids → chrome-extension://<id>).
             * Empty array = do not enforce Origin (backward compatible; set in production).
             */
            allowedRequestOrigins: (() => {
                const fromFull = splitCsv(process.env.PROTECTED_RPC_ALLOWED_ORIGINS);
                const fromIds = splitCsv(process.env.PROTECTED_RPC_CHROME_EXTENSION_IDS)
                    .map((raw) => {
                        const id = String(raw)
                            .trim()
                            .replace(/^chrome-extension:\/\//i, "");
                        return id ? `chrome-extension://${id}` : null;
                    })
                    .filter(Boolean);
                return [...new Set([...fromFull, ...fromIds])];
            })(),
        },
    },
    /** Verifik WhatsApp relay — Meta Graph API egress from Zelf (non-GCP). */
    whatsApp: {
        phoneIdentifier: process.env.WHATSAPP_API_PHONE_IDENTIFIER || "111417608275326",
        relayApiKey: process.env.VERIFIK_WHATSAPP_RELAY_API_KEY || "",
        apiKeys: {
            default: process.env.WHATSAPP_API_TOKEN || "",
            111417608275326: process.env.WHATSAPP_API_TOKEN || "",
            624749820726878: process.env.TCC_WHATSAPP_API_KEY || "",
            ...parseWhatsAppExtraApiKeys(),
        },
    },
    /**
     * OneSignal REST API for server push (Repositories/TxNotifications). The app API key is
     * IP-allowlisted to the production server, so calls from any other machine return 401.
     */
    oneSignal: {
        appId: (process.env.ONESIGNAL_APP_ID || "").trim(),
        appApiKey: (process.env.ONESIGNAL_APP_API_KEY || "").trim(),
        apiUrl: (process.env.ONESIGNAL_API_URL || "https://api.onesignal.com").trim().replace(/\/$/, ""),
        timeoutMs: Number(process.env.ONESIGNAL_TIMEOUT_MS) || 15000,
    },
    /** Push for received transfers: device registry + standalone watcher (`npm run tx-watcher`). */
    txNotifications: {
        /** Watcher computes pushes and writes the push log but never calls OneSignal. */
        dryRun: process.env.TX_WATCHER_DRY_RUN === "true",
        tickMs: Number(process.env.TX_WATCHER_TICK_MS) || 60 * 1000,
        addressIntervalMs: Number(process.env.TX_WATCHER_ADDRESS_INTERVAL_MS) || 2 * 60 * 1000,
        leaseMs: Number(process.env.TX_WATCHER_LEASE_MS) || 3 * 60 * 1000,
        maxCursorsPerTick: Number(process.env.TX_WATCHER_MAX_CURSORS_PER_TICK) || 600,
        maxIndividualPushesPerCycle: Number(process.env.TX_PUSH_MAX_INDIVIDUAL_PER_CYCLE) || 3,
        deviceStaleDays: Number(process.env.TX_PUSH_DEVICE_STALE_DAYS) || 60,
        requestTimeoutMs: Number(process.env.TX_WATCHER_REQUEST_TIMEOUT_MS) || 20000,
        suiGraphqlUrl: (process.env.SUI_GRAPHQL_URL || "https://graphql.mainnet.sui.io/graphql").trim(),
        stellarHorizonUrl: (process.env.STELLAR_HORIZON_URL || "https://horizon.stellar.org").trim().replace(/\/$/, ""),
        bitcoinEsploraUrls: csvOrDefault(process.env.BITCOIN_ESPLORA_URLS, ["https://mempool.space/api", "https://blockstream.info/api"]),
        blockdagScanApiUrl: (process.env.BLOCKDAG_SCAN_API_URL || "https://api.bdagscan.com/v1/api").trim().replace(/\/$/, ""),
        /** Extra EVM JSON-RPC endpoints (CSV) tried before the configured chain RPC and the public fallback. */
        evmRpcUrls: {
            ethereum: splitCsv(process.env.TX_WATCHER_ETHEREUM_RPC_URLS),
            polygon: splitCsv(process.env.TX_WATCHER_POLYGON_RPC_URLS),
            avalanche: splitCsv(process.env.TX_WATCHER_AVALANCHE_RPC_URLS),
            bsc: splitCsv(process.env.TX_WATCHER_BSC_RPC_URLS),
        },
    },
    /** ZelfBlockDagPay.sol — native BDAG tag checkout only */
    blockdag: {
        defaultCollectionAddress: process.env.BLOCKDAG_DEFAULT_COLLECTION_ADDRESS || null,
        factoryAddress: process.env.BLOCKDAG_FACTORY_ADDRESS || "0x7c6a168455C94092f8d51aBC515B73f4Ed9813a6",
        // Public RPC only — dapps-rpc.bdagscan.com is blocked/unreachable from prod and local.
        mainRpcUrl: process.env.BLOCKDAG_MAIN_RPC_URL || process.env.BLOCKDAG_RPC_URL || "https://rpc.bdagscan.com",
        rpcUrl: process.env.BLOCKDAG_RPC_URL || "https://rpc.bdagscan.com",
        chainId: Number(process.env.BLOCKDAG_CHAIN_ID) || 1404,
        tagPayContractAddress: (process.env.BLOCKDAG_TAG_PAY_CONTRACT_ADDRESS || "").trim(),
        tagPayConfirmations: Math.max(1, Number(process.env.BLOCKDAG_TAG_PAY_CONFIRMATIONS) || 1),
        nowNodesAPIKey: process.env.BLOCKDAG_NOW_NODES_API_KEY,
    },
};

/**
 * JSON for GET /api/subscription-plans (`pricingMeta`). Token counts use ceil(usd / rewardPrice).
 */
const buildSubscriptionPricingMeta = () => {
    const rp = Number(configuration.token.rewardPrice);
    const rewardPrice = Number.isFinite(rp) && rp > 0 ? rp : 0.05;
    const sp = configuration.subscriptionPricing;
    const ceilTok = (usd) => Math.ceil(Number(usd) / rewardPrice);
    const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : String(n));

    return {
        rewardPrice,
        rewardPriceFormatted: fmt(rewardPrice),
        encryptUsd: sp.encryptUsd,
        encryptUsdFormatted: fmt(sp.encryptUsd),
        activeUserMonthlyUsd: sp.activeUserMonthlyUsd,
        activeUserMonthlyUsdFormatted: fmt(sp.activeUserMonthlyUsd),
        decryptWithLivenessUsd: sp.decryptWithLivenessUsd,
        decryptWithLivenessUsdFormatted: fmt(sp.decryptWithLivenessUsd),
        decryptNoLivenessUsd: sp.decryptNoLivenessUsd,
        decryptNoLivenessUsdFormatted: fmt(sp.decryptNoLivenessUsd),
        decryptIncludedPerMonth: sp.decryptIncludedPerMonth,
        encryptTokens: ceilTok(sp.encryptUsd),
        activeUserMonthlyTokens: ceilTok(sp.activeUserMonthlyUsd),
        decryptWithLivenessTokens: ceilTok(sp.decryptWithLivenessUsd),
        decryptNoLivenessTokens: ceilTok(sp.decryptNoLivenessUsd),
    };
};

module.exports = configuration;
module.exports.buildSubscriptionPricingMeta = buildSubscriptionPricingMeta;

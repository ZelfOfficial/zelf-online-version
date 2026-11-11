const SolanaPaymentService = require("../../Solana/modules/payment-verification.module");
const AvalanchePaymentService = require("../../Avalanche/modules/payment-verification.module");
const BasePaymentService = require("../../base/modules/payment-verification.module");
const IPFSModule = require("../../IPFS/modules/ipfs.module");

/**
 * HTTP 402 Payment Required Middleware
 * Supports multi-chain micro-payments with ZNS token
 *
 * Supported Chains:
 * - Solana (ZNS: GfF6PSkH8bKLkws5RMFdzgASwcVbgCfhhKfp8zeoFBkx)
 * - Avalanche (ZNS: TBD)
 * - Base (ZNS: TBD)
 */

// Payment configuration per endpoint
const PAYMENT_CONFIG = {
	"/api/human-authn/encrypt": {
		cost: 0.1, // 0.1 ZNS tokens
		chains: ["solana", "avalanche", "base"],
		description: "Human Authn Encryption Service",
	},
	"/api/human-authn/encrypt-qr-code": {
		cost: 0.15, // 0.15 ZNS tokens (slightly more for QR generation)
		chains: ["solana", "avalanche", "base"],
		description: "Human Authn QR Code Encryption Service",
	},
	"/api/human-authn/decrypt": {
		cost: 0.05, // 0.05 ZNS tokens (cheaper for decryption)
		chains: ["solana", "avalanche", "base"],
		description: "Human Authn Decryption Service",
	},
	"/api/human-authn/preview": {
		cost: 0.01, // 0.01 ZNS tokens (cheapest for preview)
		chains: ["solana", "avalanche", "base"],
		description: "Human Authn Preview Service",
	},
};

// Chain-specific payment services
const PAYMENT_SERVICES = {
	solana: SolanaPaymentService,
	avalanche: AvalanchePaymentService,
	base: BasePaymentService,
};

/**
 * Main payment verification middleware
 * Checks if payment has been made before allowing access to the endpoint
 */
const paymentRequired = async (ctx, next) => {
	try {
		// Get endpoint configuration
		const endpoint = ctx.path;
		const paymentConfig = PAYMENT_CONFIG[endpoint];

		if (!paymentConfig) {
			// No payment required for this endpoint
			return await next();
		}

		// Check if user has a valid subscription (bypass payment)
		if (await hasValidSubscription(ctx)) {
			return await next();
		}

		// Extract payment proof from request headers
		const paymentProof = ctx.headers["x-payment-proof"];
		const paymentChain = ctx.headers["x-payment-chain"]?.toLowerCase();
		const paymentTxHash = ctx.headers["x-payment-tx"];

		if (!paymentProof || !paymentChain || !paymentTxHash) {
			ctx.status = 402;
			ctx.body = {
				error: "Payment Required",
				message: "This endpoint requires payment to access",
				paymentDetails: {
					cost: paymentConfig.cost,
					token: "ZNS",
					acceptedChains: paymentConfig.chains,
					description: paymentConfig.description,
				},
				instructions: {
					step1: "Send the required amount of ZNS tokens to the service wallet",
					step2: "Include the transaction hash in the 'x-payment-tx' header",
					step3: "Include the chain name in the 'x-payment-chain' header (solana, avalanche, or base)",
					step4: "Include the payment proof in the 'x-payment-proof' header",
				},
			};
			return;
		}

		// Validate chain is supported
		if (!paymentConfig.chains.includes(paymentChain)) {
			ctx.status = 400;
			ctx.body = {
				error: "Invalid Payment Chain",
				message: `Chain '${paymentChain}' is not supported for this endpoint`,
				acceptedChains: paymentConfig.chains,
			};
			return;
		}

		// Get the appropriate payment service for the chain
		const PaymentService = PAYMENT_SERVICES[paymentChain];

		if (!PaymentService) {
			ctx.status = 500;
			ctx.body = {
				error: "Payment Service Unavailable",
				message: `Payment verification service for '${paymentChain}' is not available`,
			};
			return;
		}

		// Verify the payment
		const verificationResult = await PaymentService.verifyPayment({
			txHash: paymentTxHash,
			expectedAmount: paymentConfig.cost,
			proof: paymentProof,
			userWallet: ctx.state.user?.walletAddress || ctx.headers["x-wallet-address"],
		});

		if (!verificationResult.valid) {
			ctx.status = 402;
			ctx.body = {
				error: "Payment Verification Failed",
				message: verificationResult.reason || "Payment could not be verified",
				details: verificationResult.details,
			};
			return;
		}

		// Check if payment has already been used (prevent replay attacks)
		if (await isPaymentUsed(paymentTxHash)) {
			ctx.status = 409;
			ctx.body = {
				error: "Payment Already Used",
				message: "This payment has already been used for a previous request",
			};
			return;
		}

		// Run the handler before recording usage. optionalJwt (earlier in the chain) does not
		// record a charge; usage is recorded here only after the handler returns.
		await next();

		// A zelfproof that cannot be parsed is rejected input. Do not consume or count the payment.
		if (ctx.state.invalidZelfproof === true || (ctx.status === 400 && ctx.body?.code === "INVALID_ZELFPROOF")) {
			return;
		}

		await markPaymentAsUsed({
			txHash: paymentTxHash,
			chain: paymentChain,
			amount: paymentConfig.cost,
			endpoint,
			userId: ctx.state.user?.id,
			timestamp: new Date(),
		});

		ctx.state.paymentInfo = {
			chain: paymentChain,
			amount: paymentConfig.cost,
			txHash: paymentTxHash,
			verified: true,
		};
	} catch (error) {
		console.error("Payment verification error:", error);
		ctx.status = 500;
		ctx.body = {
			error: "Payment Verification Error",
			message: "An error occurred while verifying payment",
			details: error.message,
		};
	}
};

/**
 * Check if user has a valid subscription that bypasses payment
 */
const hasValidSubscription = async (ctx) => {
	try {
		// Check if user has an active subscription
		const userId = ctx.state.user?.id;
		if (!userId) return false;

		// Query subscription status from database
		// This would integrate with your existing subscription system
		const subscription = await getSubscriptionStatus(userId);

		return subscription && subscription.active && subscription.plan !== "free";
	} catch (error) {
		console.error("Subscription check error:", error);
		return false;
	}
};

/**
 * Check if a payment has already been used
 */
const isPaymentUsed = async (txHash) => {
	try {
		// Check IPFS for historical payments
		// This queries the IPFS index
		const payment = await findPaymentByTxHash(txHash);

		return payment !== null;
	} catch (error) {
		console.error("Payment check error:", error);
		// Fail closed - assume payment is used if we can't verify
		return true;
	}
};

/**
 * Mark a payment as used to prevent replay attacks
 */
const markPaymentAsUsed = async (paymentData) => {
	try {
		// Store in IPFS for permanent record and replay protection
		await savePaymentRecord(paymentData);
	} catch (error) {
		console.error("Error marking payment as used:", error);
		throw error;
	}
};

/**
 * Helper: Get subscription status (placeholder - integrate with your subscription system)
 */
const getSubscriptionStatus = async (userId) => {
	// TODO: Integrate with your existing subscription system
	// Example:
	// const SubscriptionModule = require("../../SubscriptionPlan/modules/subscription.module");
	// return await SubscriptionModule.getActiveSubscription(userId);
	return null;
};

/**
 * Helper: Find payment by transaction hash using IPFS Filter
 */
const findPaymentByTxHash = async (txHash) => {
	try {
		// Query IPFS for metadata key "paymentTx" matching the hash
		// This relies on IPFS provider supporting metadata filtering
		const results = await IPFSModule.get({ key: "paymentTx", value: txHash });

		if (results && results.length > 0) {
			return results[0];
		}
		return null;
	} catch (error) {
		console.error("Error finding payment in IPFS:", error);
		return null;
	}
};

/**
 * Helper: Save payment record to IPFS
 */
const savePaymentRecord = async (paymentData) => {
	try {
		const receipt = {
			...paymentData,
			type: "ZELF_PAYMENT_RECEIPT",
			version: "1.0",
			timestamp: new Date().toISOString(),
		};

		const base64 = Buffer.from(JSON.stringify(receipt)).toString("base64");

		// Insert into IPFS with metadata for indexing
		const result = await IPFSModule.insert(
			{
				base64,
				name: `PaymentReceipt_${paymentData.txHash}`,
				pinIt: true,
				metadata: {
					paymentTx: `${paymentData.txHash}`,
					chain: `${paymentData.chain}`,
					amount: `${paymentData.amount}`,
					type: "ZELF_PAYMENT",
				},
			},
			{ pro: true }
		);

		if (!result) {
			throw new Error("Failed to save payment record to IPFS (Insert returned null)");
		}

		return result;
	} catch (error) {
		console.error("Error saving payment record to IPFS:", error);
		throw error;
	}
};

/**
 * Optional: Get payment statistics for analytics
 */
const getPaymentStats = async (ctx) => {
	try {
		const userId = ctx.state.user?.id;

		if (!userId) {
			ctx.status = 401;
			ctx.body = { error: "Unauthorized" };
			return;
		}

		// Get user's payment history
		const stats = await getUserPaymentStats(userId);

		ctx.status = 200;
		ctx.body = {
			success: true,
			stats,
		};
	} catch (error) {
		console.error("Error fetching payment stats:", error);
		ctx.status = 500;
		ctx.body = {
			error: "Failed to fetch payment statistics",
			message: error.message,
		};
	}
};

/**
 * Helper: Get user payment statistics
 */
const getUserPaymentStats = async (userId) => {
	// TODO: Implement payment statistics aggregation
	return {
		totalPaid: 0,
		transactionCount: 0,
		chainBreakdown: {
			solana: 0,
			avalanche: 0,
			base: 0,
		},
	};
};

module.exports = {
	paymentRequired,
	getPaymentStats,
	PAYMENT_CONFIG,
};

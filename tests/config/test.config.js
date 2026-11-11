// Test environment configuration
// This ensures tests never interfere with production or development databases unintentionally
// NO MOCKING POLICY - All tests work with real data

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: false });

/** Same idea as Core/config.js db.uri; optional MONGODB_URI_TEST for a dedicated Atlas test DB. */
const mongoTestUri =
	process.env.MONGODB_URI_TEST ||
	process.env.MONGODB_URI_PROD ||
	process.env.MONGODB_URI ||
	"mongodb://127.0.0.1:27017/zelf_testing";

module.exports = {
	// Database configuration for testing
	database: {
		uri: mongoTestUri,
		options: {
			// Additional options for test isolation
			maxPoolSize: 1, // Limit connections for tests
			serverSelectionTimeoutMS: 5000, // Keep alive for 5 seconds
			socketTimeoutMS: 45000, // Close sockets after 45 seconds
		},
		/** globalSetup.js retries until MongoDB accepts connections (same idea as server.js waiting for mongoose "open"). */
		wait: {
			maxAttempts: Number(process.env.JEST_MONGO_MAX_ATTEMPTS) || 60,
			delayMs: Number(process.env.JEST_MONGO_RETRY_DELAY_MS) || 1000,
		},
	},

	// Environment variables for testing
	env: {
		NODE_ENV: "test",
		JWT_SECRET: "test-jwt-secret-key-for-testing-only",
		MONGODB_URI: mongoTestUri,
		// Add any other test-specific environment variables here
		/** Align with local `npm start` / `.env` (e.g. 3003). Override with `PORT` in shell when running Jest. */
		PORT: Number(process.env.PORT) || 3003,
		LOG_LEVEL: "info", // Keep logs for debugging real data operations
		// NO MOCKING - Use real external service URLs
		SOLANA_TOKEN_MINT_ADDRESS: process.env.SOLANA_TOKEN_MINT_ADDRESS || "GfF6PSkH8bKLkws5RMFdzgASwcVbgCfhhKfp8zeoFBkx",
		EXTERNAL_API_URL: process.env.EXTERNAL_API_URL || "https://api.example.com",
		BLOCKCHAIN_RPC_URL: process.env.BLOCKCHAIN_RPC_URL || "https://mainnet.infura.io/v3/your-key",
	},

	// Test-specific configurations
	test: {
		timeout: 30000, // 30 seconds timeout for async tests
		retries: 0, // No retries for tests
		parallel: false, // Run tests sequentially to avoid conflicts
		// NO MOCKING POLICY
		useRealData: true, // Always use real data
		mockExternalServices: false, // Never mock external services
		mockDatabase: false, // Never mock database operations
	},

	// Real data testing configuration
	realData: {
		// Test with real blockchain data
		useRealBlockchainData: true,
		// Test with real API responses
		useRealApiResponses: true,
		// Test with real database operations
		useRealDatabaseOperations: true,
		// Test with real external service calls
		useRealExternalServices: true,
	},
};

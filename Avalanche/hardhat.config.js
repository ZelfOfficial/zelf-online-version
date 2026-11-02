import "@nomicfoundation/hardhat-ethers";
import dotenv from "dotenv";

dotenv.config();

/** @type import('hardhat/config').HardhatUserConfig */
export default {
	solidity: {
		version: "0.8.20",
		settings: {
			optimizer: {
				enabled: true,
				runs: 200,
			},
			viaIR: true,
		},
	},
	networks: {
		// Avalanche Mainnet
		avalanche: {
			type: "http",
			url: process.env.AVALANCHE_RPC_URL || "https://api.avax.network/ext/bc/C/rpc",
			chainId: 43114,
			accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
			gasPrice: 25000000000, // 25 gwei
		},
		// Avalanche Fuji Testnet
		fuji: {
			type: "http",
			url: "https://api.avax-test.network/ext/bc/C/rpc",
			chainId: 43113,
			accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
			gasPrice: 25000000000, // 25 gwei
		},
		// Local development
		hardhat: {
			type: "edr-simulated",
			chainId: 1337,
		},
	},
	etherscan: {
		apiKey: {
			avalanche: "", // Optional: Add SNOWTRACE_API_KEY for automatic verification
			fuji: "", // Optional: Add SNOWTRACE_API_KEY for automatic verification
		},
		customChains: [
			{
				network: "avalanche",
				chainId: 43114,
				urls: {
					apiURL: "https://api.snowtrace.io/api",
					browserURL: "https://snowtrace.io",
				},
			},
			{
				network: "fuji",
				chainId: 43113,
				urls: {
					apiURL: "https://api-testnet.snowtrace.io/api",
					browserURL: "https://testnet.snowtrace.io",
				},
			},
		],
	},
	paths: {
		sources: "./contracts",
		tests: "./test",
		cache: "./cache",
		artifacts: "./artifacts",
	},
	mocha: {
		timeout: 40000,
	},
};

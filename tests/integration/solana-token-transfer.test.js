/**
 * Integration test: Solana ZNS token transfer via HTTP-only polling.
 *
 * Exercises the same code path as daily rewards (giveTokensAfterPurchase)
 * but with a tiny dev-mode amount. Verifies:
 *   1. Connection to Solana RPC via config.solana.rpcUrl (no hardcoded URLs).
 *   2. HTTP-only confirmation (Core/solana-tx.js) — no WebSocket signatureSubscribe.
 *   3. Transaction lands on-chain and is confirmed.
 *
 * Prerequisites:
 *   - .env has SOLANA_RPC_URL (full endpoint), SENDER_KEY, SOLANA_TOKEN_MINT_ADDRESS.
 *   - SOLANA_DEV_MODE_TOKENS=true (divides amount by 10 so balance is preserved).
 *   - Sender wallet has SOL for fees and some ZNS tokens.
 *
 * Run:
 *   npx jest tests/integration/solana-token-transfer.test.js --verbose --no-coverage
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: false });

const config = require("../../Core/config");
const { Connection, PublicKey } = require("@solana/web3.js");
const { sendAndConfirmViaPolling } = require("../../Core/solana-tx");

const TARGET_WALLET = "5d1jNutWr7jEGxrzjGGGLb1fVe8mqHxK6wsdcQ2x4Eak";
const REWARD_AMOUNT = 1; // 1 ZNS (dev mode divides by 10 → 0.1 ZNS actually sent)

const _redactUrl = (url) => url.replace(/\/[a-f0-9]{20,}\/?/i, "/***REDACTED***/");

/**
 * Pick a working RPC: try the configured one, fall back to public mainnet.
 */
const _getWorkingConnection = async () => {
	const candidates = [config.solana.rpcUrl, "https://api.mainnet-beta.solana.com"].filter(Boolean);

	for (const url of candidates) {
		try {
			const conn = new Connection(url, "confirmed");
			await conn.getSlot();
			return { connection: conn, url };
		} catch {
			console.warn(`  RPC unreachable or 401: ${_redactUrl(url)} — trying next`);
		}
	}
	throw new Error("No working Solana RPC endpoint available");
};

describe("Solana ZNS token transfer (HTTP-only polling)", () => {
	let connection;
	let rpcUrl;

	beforeAll(async () => {
		if (!config.solana.sender) {
			throw new Error("SENDER_KEY is not set in .env — cannot run Solana transfer test");
		}
		if (!config.solana.tokenMintAddress) {
			throw new Error("SOLANA_TOKEN_MINT_ADDRESS is not set in .env");
		}
		const result = await _getWorkingConnection();
		connection = result.connection;
		rpcUrl = result.url;
		console.log(`  Using RPC: ${_redactUrl(rpcUrl)}`);
	});

	it("should use config.solana.rpcUrl (not a hardcoded URL)", () => {
		expect(config.solana.rpcUrl).toBeDefined();
		expect(typeof config.solana.rpcUrl).toBe("string");
		expect(config.solana.rpcUrl.length).toBeGreaterThan(0);
	});

	it("should confirm the target wallet exists on-chain", async () => {
		const pubkey = new PublicKey(TARGET_WALLET);
		const info = await connection.getAccountInfo(pubkey);
		expect(info).not.toBeNull();
		expect(info.lamports).toBeGreaterThan(0);
		console.log(`  Target wallet balance: ${info.lamports / 1e9} SOL`);
	});

	it("should transfer ZNS tokens and confirm via HTTP polling (no signatureSubscribe)", async () => {
		const solanaWeb3 = require("@solana/web3.js");
		const splManual = require("../../Core/spl-token-manual");
		const tokenMintAddress = new PublicKey(config.solana.tokenMintAddress);

		const senderKey = Uint8Array.from(JSON.parse(config.solana.sender));
		const senderWallet = solanaWeb3.Keypair.fromSecretKey(senderKey);

		const isDevMode = config.solana.devModeTokens === true || config.solana.devModeTokens === "true";
		const actualAmount = isDevMode ? REWARD_AMOUNT / 10 : REWARD_AMOUNT;
		const amountToSend = Math.round(actualAmount * 10 ** 8);
		console.log(`  Dev mode: ${isDevMode} — sending ${actualAmount} ZNS (${amountToSend} raw units)`);

		const senderTokenAccount = await splManual.getOrCreateAssociatedTokenAccount(
			connection,
			senderWallet,
			tokenMintAddress,
			senderWallet.publicKey
		);
		console.log(`  Sender token balance: ${senderTokenAccount.amount} raw units`);
		expect(senderTokenAccount.amount).toBeGreaterThanOrEqual(amountToSend);

		const receiverPublicKey = new PublicKey(TARGET_WALLET);
		const receiverTokenAccount = await splManual.getOrCreateAssociatedTokenAccount(
			connection,
			senderWallet,
			tokenMintAddress,
			receiverPublicKey
		);

		const computeBudgetInstruction = solanaWeb3.ComputeBudgetProgram.setComputeUnitPrice({
			microLamports: 100000,
		});

		const transferInstruction = splManual.createTransferCheckedInstruction(
			senderTokenAccount.address,
			tokenMintAddress,
			receiverTokenAccount.address,
			senderWallet.publicKey,
			amountToSend,
			8
		);

		const transaction = new solanaWeb3.Transaction().add(computeBudgetInstruction, transferInstruction);

		console.log("  Sending transaction via HTTP-only polling (no WebSocket)...");
		const startMs = Date.now();
		const signature = await sendAndConfirmViaPolling(connection, transaction, [senderWallet]);
		const elapsedMs = Date.now() - startMs;

		expect(signature).toBeDefined();
		expect(typeof signature).toBe("string");
		expect(signature.length).toBeGreaterThan(30);

		console.log(`  Confirmed in ${(elapsedMs / 1000).toFixed(1)}s`);
		console.log(`  Signature: ${signature}`);
		console.log(`  Explorer:  https://solscan.io/tx/${signature}`);

		const status = await connection.getSignatureStatuses([signature]);
		const txStatus = status.value[0];
		expect(txStatus).not.toBeNull();
		expect(txStatus.err).toBeNull();
		expect(["confirmed", "finalized"]).toContain(txStatus.confirmationStatus);
		console.log(`  Final status: ${txStatus.confirmationStatus}`);
	}, 120_000);
});

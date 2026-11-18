/**
 * Referral reward transfer (#515). The Solana connection is an in-memory fake: nothing here
 * may broadcast a real transaction.
 */
const mockConnection = {};

jest.mock("@solana/web3.js", () => ({
	...jest.requireActual("@solana/web3.js"),
	Connection: jest.fn(() => mockConnection),
}));

const solanaWeb3 = jest.requireActual("@solana/web3.js");
const mockSender = solanaWeb3.Keypair.generate();
const mockMint = solanaWeb3.Keypair.generate().publicKey;

jest.mock("../../Core/config", () => ({
	solana: { rpcUrl: "http://fake-rpc.invalid", sender: JSON.stringify(Array.from(mockSender.secretKey)), tokenMintAddress: mockMint.toBase58() },
}));

const bs58 = require("bs58").default || require("bs58");
const spl = require("../../Core/spl-token-manual");
const RewardTransfer = require("../../Repositories/Tags/modules/referral-reward-transfer");

const RECEIVER = "E5zQvcpuRdtcwZfRxBKHLgnUQRf6wCsYBf75Lix5upEG";
const tokenAccountData = (amount) => {
	const data = Buffer.alloc(165);
	data.writeBigUInt64LE(BigInt(amount), 64);
	return data;
};
const mintAccount = (decimals) => {
	const data = Buffer.alloc(82);
	data.writeUInt8(decimals, 44);
	return { data, owner: spl.TOKEN_PROGRAM_ID };
};
/** The mint answers with its layout; every other address is the rewards wallet token account. */
const accounts = ({ balance = 75_607 * 1e8, decimals = 8 } = {}) => async (address) =>
	address.equals(mockMint) ? mintAccount(decimals) : { data: tokenAccountData(balance) };

let calls;

beforeEach(() => {
	calls = [];
	Object.assign(mockConnection, {
		getAccountInfo: jest.fn(accounts()),
		getLatestBlockhash: jest.fn(async () => ({ blockhash: solanaWeb3.Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 })),
		sendRawTransaction: jest.fn(async (raw) => {
			calls.push("send");
			return "ignored";
		}),
		getSignatureStatuses: jest.fn(async () => ({ value: [{ confirmationStatus: "confirmed", err: null }] })),
		getBlockHeight: jest.fn(async () => {
			calls.push("height");
			return 990;
		}),
	});
});

describe("sendRewardTransfer", () => {
	test("a denylisted receiver is rejected before any broadcast", async () => {
		const previous = process.env.ZNS_PAYOUT_DENYLIST;
		process.env.ZNS_PAYOUT_DENYLIST = ` ${RECEIVER} , other`;

		try {
			await expect(RewardTransfer.sendRewardTransfer(10, RECEIVER, { onSigned: async () => {} })).rejects.toMatchObject({
				message: "403:PAYOUT_ADDRESS_BLOCKED",
				status: 403,
				code: "PAYOUT_ADDRESS_BLOCKED",
			});
			expect(mockConnection.sendRawTransaction).not.toHaveBeenCalled();
			expect(calls).toEqual([]);
		} finally {
			if (previous === undefined) delete process.env.ZNS_PAYOUT_DENYLIST;
			else process.env.ZNS_PAYOUT_DENYLIST = previous;
		}
	});

	test("denylist comparison stays case-sensitive", async () => {
		const previous = process.env.ZNS_PAYOUT_DENYLIST;
		process.env.ZNS_PAYOUT_DENYLIST = RECEIVER.toLowerCase();

		try {
			const result = await RewardTransfer.sendRewardTransfer(10, RECEIVER, { onSigned: async () => {}, pollIntervalMs: 1 });
			expect(result.state).toBe("confirmed");
			expect(mockConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
		} finally {
			if (previous === undefined) delete process.env.ZNS_PAYOUT_DENYLIST;
			else process.env.ZNS_PAYOUT_DENYLIST = previous;
		}
	});

	test("signs once, stores the signature before the broadcast and creates the account in the same transaction", async () => {
		const onSigned = jest.fn(async () => calls.push("stored"));

		const result = await RewardTransfer.sendRewardTransfer(10, RECEIVER, { onSigned, pollIntervalMs: 1 });

		expect(calls).toEqual(["stored", "send"]);
		const raw = mockConnection.sendRawTransaction.mock.calls[0][0];
		const sent = solanaWeb3.Transaction.from(raw);
		expect(result).toEqual({ state: "confirmed", signature: bs58.encode(sent.signature), lastValidBlockHeight: 1000 });
		expect(onSigned).toHaveBeenCalledWith({ signature: result.signature, lastValidBlockHeight: 1000 });

		const [priorityFee, createAccount, transfer] = sent.instructions;
		expect(priorityFee.programId.equals(solanaWeb3.ComputeBudgetProgram.programId)).toBe(true);
		expect(createAccount.programId.equals(spl.ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
		expect([...createAccount.data]).toEqual([1]); // CreateIdempotent
		const receiverAccount = spl.getAssociatedTokenAddress(new solanaWeb3.PublicKey(RECEIVER), mockMint);
		expect(createAccount.keys[1].pubkey.equals(receiverAccount)).toBe(true);
		expect(transfer.data.readBigUInt64LE(1)).toBe(1_000_000_000n);
		expect(transfer.keys[2].pubkey.equals(receiverAccount)).toBe(true);
	});

	test("nothing is broadcast when the signature cannot be stored", async () => {
		await expect(
			RewardTransfer.sendRewardTransfer(10, RECEIVER, { onSigned: async () => Promise.reject(new Error("mongo down")) })
		).rejects.toThrow("mongo down");
		expect(mockConnection.sendRawTransaction).not.toHaveBeenCalled();
	});

	test("an empty rewards wallet fails before signing", async () => {
		mockConnection.getAccountInfo.mockImplementation(accounts({ balance: 5 * 1e8 }));
		const onSigned = jest.fn();

		await expect(RewardTransfer.sendRewardTransfer(10, RECEIVER, { onSigned })).rejects.toThrow("rewards_wallet_insufficient_balance");
		expect(onSigned).not.toHaveBeenCalled();
		expect(mockConnection.sendRawTransaction).not.toHaveBeenCalled();
	});

	test("a broadcast error after signing is unknown, not failed", async () => {
		mockConnection.sendRawTransaction.mockRejectedValue(new Error("socket hang up"));

		const result = await RewardTransfer.sendRewardTransfer(10, RECEIVER, { onSigned: async () => {} });

		expect(result).toMatchObject({ state: "pending", lastValidBlockHeight: 1000, error: "socket hang up" });
	});

	test("an unconfirmed transfer is reported as pending after the wait, without re-signing", async () => {
		mockConnection.getSignatureStatuses.mockResolvedValue({ value: [null] });

		const result = await RewardTransfer.sendRewardTransfer(10, RECEIVER, { onSigned: async () => {}, waitMs: 20, pollIntervalMs: 1 });

		expect(result.state).toBe("pending");
		expect(mockConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
		expect(mockConnection.getLatestBlockhash).toHaveBeenCalledTimes(1);
	});

	test("a transaction that executed with an error is failed", async () => {
		mockConnection.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: "confirmed", err: { InstructionError: [2, { Custom: 1 }] } }] });

		const result = await RewardTransfer.sendRewardTransfer(10, RECEIVER, { onSigned: async () => {}, pollIntervalMs: 1 });

		expect(result).toMatchObject({ state: "failed", error: '{"InstructionError":[2,{"Custom":1}]}' });
	});
});

describe("getRewardTransferOutcome", () => {
	const lookup = (status) => mockConnection.getSignatureStatuses.mockImplementation(async () => {
		calls.push("status");
		return { value: [status] };
	});

	test("reads the finalized height before the status", async () => {
		lookup(null);
		await RewardTransfer.getRewardTransferOutcome({ signature: "sig", lastValidBlockHeight: 1000 });
		expect(calls).toEqual(["height", "status"]);
		expect(mockConnection.getSignatureStatuses).toHaveBeenCalledWith(["sig"], { searchTransactionHistory: true });
	});

	test.each([
		["landed and succeeded", { confirmationStatus: "finalized", err: null }, 1200, "confirmed"],
		["landed and failed", { confirmationStatus: "confirmed", err: { InstructionError: [2, "x"] } }, 1200, "failed"],
		["seen but only processed", { confirmationStatus: "processed", err: null }, 1200, "pending"],
		["not found while it can still land", null, 1000, "pending"],
		["not found after its blockhash expired", null, 1001, "expired"],
		["not found but too old to trust the history", null, 1000 + RewardTransfer.MAX_AUTO_RECONCILE_BLOCKS + 1, "pending"],
	])("%s", async (_name, status, height, expected) => {
		lookup(status);
		mockConnection.getBlockHeight.mockResolvedValue(height);
		await expect(RewardTransfer.getRewardTransferOutcome({ signature: "sig", lastValidBlockHeight: 1000 })).resolves.toMatchObject({ state: expected });
	});

	test("a missing block height never counts as expired", async () => {
		lookup(null);
		mockConnection.getBlockHeight.mockResolvedValue(5000);
		await expect(RewardTransfer.getRewardTransferOutcome({ signature: "sig" })).resolves.toMatchObject({ state: "pending" });
	});
});

test("amounts are whole ZNS, including rewards of 1000 ZNS or more", () => {
	expect(RewardTransfer.toBaseUnits(10)).toBe(1_000_000_000);
	expect(RewardTransfer.toBaseUnits(1500)).toBe(150_000_000_000);
	expect(RewardTransfer.toBaseUnits(1.25)).toBe(125_000_000);
	expect(RewardTransfer.toBaseUnits(250, 8)).toBe(25_000_000_000);
	expect(RewardTransfer.toBaseUnits(1500, 6)).toBe(1_500_000_000);
	expect(() => RewardTransfer.toBaseUnits(0)).toThrow("invalid_reward_amount");
	expect(() => RewardTransfer.toBaseUnits("abc")).toThrow("invalid_reward_amount");
	expect(() => RewardTransfer.toBaseUnits(null)).toThrow("invalid_reward_amount");
	expect(() => RewardTransfer.toBaseUnits(true)).toThrow("invalid_reward_amount");
	expect(() => RewardTransfer.toBaseUnits(10, 8.5)).toThrow("invalid_mint_decimals");
});

describe("mint decimals (2026-10-01 audit)", () => {
	const freshModule = () => {
		let fresh;
		jest.isolateModules(() => {
			fresh = require("../../Repositories/Tags/modules/referral-reward-transfer");
		});
		return fresh;
	};

	test("a reward of 1000 ZNS or more is sent in full, converted with the mint decimals", async () => {
		const result = await RewardTransfer.sendRewardTransfer(1500, RECEIVER, { onSigned: async () => {}, pollIntervalMs: 1 });

		const sent = solanaWeb3.Transaction.from(mockConnection.sendRawTransaction.mock.calls[0][0]);
		const transfer = sent.instructions[2];
		expect(result.state).toBe("confirmed");
		expect(transfer.data.readBigUInt64LE(1)).toBe(150_000_000_000n);
		expect(transfer.data.readUInt8(9)).toBe(8);
	});

	test("the decimals come from the mint account, not from a constant", async () => {
		mockConnection.getAccountInfo.mockImplementation(accounts({ decimals: 6, balance: 10_000 * 1e6 }));
		const fresh = freshModule();

		await fresh.sendRewardTransfer(250, RECEIVER, { onSigned: async () => {}, pollIntervalMs: 1 });

		const transfer = solanaWeb3.Transaction.from(mockConnection.sendRawTransaction.mock.calls[0][0]).instructions[2];
		expect(transfer.data.readBigUInt64LE(1)).toBe(250_000_000n);
		expect(transfer.data.readUInt8(9)).toBe(6);
	});

	test("an unreadable mint fails before anything is signed", async () => {
		mockConnection.getAccountInfo.mockImplementation(async () => ({ data: tokenAccountData(1) }));
		const fresh = freshModule();
		const onSigned = jest.fn();

		await expect(fresh.sendRewardTransfer(10, RECEIVER, { onSigned })).rejects.toThrow("reward_mint_unreadable");
		expect(onSigned).not.toHaveBeenCalled();
		expect(mockConnection.sendRawTransaction).not.toHaveBeenCalled();
	});

	test("the mint is read once per process", async () => {
		const fresh = freshModule();

		await fresh.sendRewardTransfer(10, RECEIVER, { onSigned: async () => {}, pollIntervalMs: 1 });
		await fresh.sendRewardTransfer(10, RECEIVER, { onSigned: async () => {}, pollIntervalMs: 1 });

		const mintReads = mockConnection.getAccountInfo.mock.calls.filter(([address]) => address.equals(mockMint));
		expect(mintReads).toHaveLength(1);
	});
});

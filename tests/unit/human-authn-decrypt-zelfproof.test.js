const mockPost = jest.fn();
const mockVerifyPayment = jest.fn();
const mockIpfsGet = jest.fn();
const mockIpfsInsert = jest.fn();

jest.mock("../../Core/axios", () => ({
	getEncryptionInstance: () => ({
		post: (...args) => mockPost(...args),
	}),
}));

jest.mock("../../Repositories/Solana/modules/payment-verification.module", () => ({
	verifyPayment: (...args) => mockVerifyPayment(...args),
}));

jest.mock("../../Repositories/Avalanche/modules/payment-verification.module", () => ({
	verifyPayment: (...args) => mockVerifyPayment(...args),
}));

jest.mock("../../Repositories/base/modules/payment-verification.module", () => ({
	verifyPayment: (...args) => mockVerifyPayment(...args),
}));

jest.mock("../../Repositories/IPFS/modules/ipfs.module", () => ({
	get: (...args) => mockIpfsGet(...args),
	insert: (...args) => mockIpfsInsert(...args),
}));

const Controller = require("../../Repositories/HumanAuthn/controllers/human-authn.controller");
const { decryptValidation } = require("../../Repositories/HumanAuthn/middlewares/human-authn.middleware");
const { optionalJwt } = require("../../Repositories/HumanAuthn/middlewares/optional-jwt.middleware");
const { paymentRequired } = require("../../Repositories/HumanAuthn/middlewares/payment.middleware");

const FACE = "face-image-bytes";
const PASSWORD = "correct horse battery";
const ZELFPROOF = "not-a-valid-zelfproof";

const parseFailure = (data) => {
	const error = new Error("upstream decrypt failed");
	error.response = { status: 500, data };
	return error;
};

const baseBody = (overrides = {}) => ({
	faceBase64: FACE,
	password: PASSWORD,
	os: "DESKTOP",
	zelfProof: ZELFPROOF,
	...overrides,
});

const createContext = (body) => ({
	path: "/api/human-authn/decrypt",
	method: "POST",
	headers: {
		authorization: "Bearer not-a-jwt",
		"x-payment-proof": "proof",
		"x-payment-chain": "solana",
		"x-payment-tx": "tx-parse-1",
	},
	request: { body, query: {} },
	state: {},
});

const runDecryptChain = async (ctx) => {
	const layers = [optionalJwt, paymentRequired, decryptValidation, Controller.decrypt];
	let index = 0;

	const dispatch = async () => {
		const layer = layers[index];
		index += 1;

		if (!layer) return;

		await layer(ctx, dispatch);
	};

	await dispatch();
};

describe("human-authn decrypt zelfproof input", () => {
	let consoleError;

	beforeEach(() => {
		mockPost.mockReset();
		mockVerifyPayment.mockReset();
		mockIpfsGet.mockReset();
		mockIpfsInsert.mockReset();
		mockVerifyPayment.mockResolvedValue({ valid: true });
		mockIpfsGet.mockResolvedValue(null);
		mockIpfsInsert.mockResolvedValue({ cid: "receipt" });
		consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleError.mockRestore();
	});

	it("returns 400 INVALID_ZELFPROOF for an unparseable proof, logs one line, and does not record payment", async () => {
		mockPost.mockRejectedValue(
			parseFailure({
				code: "ERR_PARSE_FAILED",
				message: "FAILED TO PARSE THE ZELFPROOF BYTES AS A VALID ZELFPROOF",
				status: 500,
			})
		);

		const ctx = createContext(baseBody());

		await runDecryptChain(ctx);

		expect(ctx.status).toBe(400);
		expect(ctx.body).toEqual({
			error: "FAILED TO PARSE THE ZELFPROOF BYTES AS A VALID ZELFPROOF",
			code: "INVALID_ZELFPROOF",
		});
		expect(ctx.state.paymentInfo).toBeUndefined();
		expect(mockIpfsInsert).not.toHaveBeenCalled();
		expect(mockPost).toHaveBeenCalledWith(
			"/zelf/decrypt",
			expect.objectContaining({
				face_base_64: FACE,
				password: PASSWORD,
				senseprint_base_64: ZELFPROOF,
			})
		);
		expect(consoleError).toHaveBeenCalledTimes(1);
		expect(consoleError).toHaveBeenCalledWith("INVALID_ZELFPROOF");
		expect(consoleError.mock.calls[0]).toHaveLength(1);
		expect(consoleError.mock.calls[0][0]).not.toMatch(/\n|^\s*at /);
	});

	it("accepts the same parse failure when only the upstream message identifies it", async () => {
		mockPost.mockRejectedValue(
			parseFailure({
				message: "failed to parse the zelfproof bytes as a valid zelfproof",
			})
		);

		const ctx = createContext(baseBody());

		await runDecryptChain(ctx);

		expect(ctx.status).toBe(400);
		expect(ctx.body.code).toBe("INVALID_ZELFPROOF");
		expect(mockIpfsInsert).not.toHaveBeenCalled();
		expect(consoleError).toHaveBeenCalledTimes(1);
		expect(consoleError).toHaveBeenCalledWith("INVALID_ZELFPROOF");
	});

	it("returns a valid proof unchanged and still requires face and password", async () => {
		const decrypted = { publicData: { hello: "world" } };
		mockPost.mockResolvedValue({ data: decrypted });

		const ctx = createContext(baseBody());

		await runDecryptChain(ctx);

		expect(ctx.body).toEqual(decrypted);
		expect(ctx.status).toBeUndefined();
		expect(mockPost).toHaveBeenCalledWith(
			"/zelf/decrypt",
			expect.objectContaining({
				face_base_64: FACE,
				password: PASSWORD,
				senseprint_base_64: ZELFPROOF,
			})
		);
		expect(mockIpfsInsert).toHaveBeenCalledTimes(1);
		expect(ctx.state.paymentInfo).toMatchObject({ txHash: "tx-parse-1", verified: true });
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("still records payment for a decrypt failure that is not a parse error", async () => {
		mockPost.mockRejectedValue(
			parseFailure({
				code: "AUTH_FAILED",
				message: "INVALID PASSWORD",
			})
		);

		const ctx = createContext(baseBody());

		await runDecryptChain(ctx);

		expect(ctx.status).toBe(401);
		expect(ctx.body).toEqual({ error: "INVALID PASSWORD" });
		expect(mockIpfsInsert).toHaveBeenCalledTimes(1);
		expect(mockPost).toHaveBeenCalledWith(
			"/zelf/decrypt",
			expect.objectContaining({
				face_base_64: FACE,
				password: PASSWORD,
			})
		);
	});
});

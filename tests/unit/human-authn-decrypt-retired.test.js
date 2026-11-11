const mockPost = jest.fn();

jest.mock("../../Core/axios", () => ({
	getEncryptionInstance: () => ({
		post: (...args) => mockPost(...args),
	}),
}));

const Koa = require("koa");
const Router = require("@koa/router");
const request = require("supertest");

const registerHumanAuthn = require("../../Repositories/HumanAuthn/routes/human-authn.route");
const registerZelfProof = require("../../Repositories/ZelfProof/routes/zelf-proof.route");
const HumanAuthnController = require("../../Repositories/HumanAuthn/controllers/human-authn.controller");
const ZelfProofController = require("../../Repositories/ZelfProof/controllers/zelf-proof.controller");
const ZelfProofMiddleware = require("../../Repositories/ZelfProof/middlewares/zelf-proof.middleware");
const ZelfProofPayment = require("../../Repositories/ZelfProof/middlewares/payment.middleware");

const V4_DECRYPT = "https://v4.zelf.world/api/human-authn/decrypt";

const findPost = (router, path) => router.stack.find((layer) => layer.path === path && layer.methods.includes("POST"));

describe("v3 human-authn decrypt is retired", () => {
	const router = new Router();
	const app = new Koa();

	beforeAll(() => {
		registerHumanAuthn(router);
		registerZelfProof(router);
		app.use(router.routes());
		app.use(router.allowedMethods());
	});

	beforeEach(() => {
		mockPost.mockClear();
	});

	it("returns 410 before auth, payment, and validation, and does not call upstream", async () => {
		const layer = findPost(router, "/api/human-authn/decrypt");

		expect(layer.stack).toEqual([HumanAuthnController.decrypt]);

		const response = await request(app.callback())
			.post("/api/human-authn/decrypt")
			.set("Authorization", "Bearer not-a-jwt")
			.set("x-payment-proof", "proof")
			.set("x-payment-chain", "solana")
			.set("x-payment-tx", "tx-should-not-count")
			.send({
				faceBase64: "face-bytes",
				password: "secret",
				os: "DESKTOP",
				zelfProof: "not-a-proof",
			});

		expect(response.status).toBe(410);
		expect(response.body).toEqual({
			code: "ENDPOINT_MOVED_TO_V4",
			message: `This endpoint has moved. Use ${V4_DECRYPT}`,
			newEndpoint: V4_DECRYPT,
		});
		expect(mockPost).not.toHaveBeenCalled();
	});

	it("leaves POST /api/zelf-proof/decrypt on its existing payment, validation, and decrypt handlers", async () => {
		const layer = findPost(router, "/api/zelf-proof/decrypt");

		expect(layer.stack).toEqual([
			ZelfProofPayment.paymentRequired,
			ZelfProofMiddleware.decryptValidation,
			ZelfProofController.decrypt,
		]);
		expect(layer.stack).not.toContain(HumanAuthnController.decrypt);

		const response = await request(app.callback()).post("/api/zelf-proof/decrypt").send({
			faceBase64: "face-bytes",
			password: "secret",
			os: "DESKTOP",
			zelfProof: "proof",
		});

		expect(response.status).toBe(402);
		expect(response.body.error).toBe("Payment Required");
		expect(mockPost).not.toHaveBeenCalled();
	});
});

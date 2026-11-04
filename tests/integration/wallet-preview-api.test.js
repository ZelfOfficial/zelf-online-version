/**
 * POST /api/wallets/preview is public. A missing session must not crash validation,
 * and a v4 proof must reach the v4 preview stack.
 */
jest.mock("../../Repositories/ZelfProof/modules/zelf-proof.module", () => ({
    decrypt: jest.fn(),
    preview: jest.fn(),
    encrypt: jest.fn(),
    encryptQRCode: jest.fn(),
    ZELFPROOF_CLIENT_ERROR_STATUS: {},
}));

const request = require("supertest");
const Koa = require("koa");
const Router = require("@koa/router");
const bodyParser = require("koa-bodyparser");
const ZelfProof = require("../../Repositories/ZelfProof/modules/zelf-proof.module");
const walletRoutes = require("../../Repositories/Wallet/routes/unprotected-wallet.route");

const parseError = () => {
    const error = new Error("failed to parse");
    error.code = "ERR_INVALID_ZELFPROOF";
    error.status = 400;
    return error;
};

describe("POST /api/wallets/preview", () => {
    let app;

    beforeAll(() => {
        const router = new Router();
        walletRoutes(router);
        app = new Koa();
        app.use(bodyParser());
        app.use(router.routes());
        app.use(router.allowedMethods());
    });

    beforeEach(() => {
        ZelfProof.preview.mockReset();
        ZelfProof.preview.mockImplementation(async (data) => {
            if (data.stack === "v4") return { publicData: { zelfName: "name.zelf", v: 4 } };
            throw parseError();
        });
    });

    test("an unauthenticated caller previews a v4 proof", async () => {
        const response = await request(app.callback()).post("/api/wallets/preview").send({ zelfProof: "v4-proof" });

        expect(response.status).toBe(200);
        expect(response.body.data.publicData).toMatchObject({ zelfName: "name.zelf", v: 4 });
        expect(ZelfProof.preview.mock.calls.some((call) => call[0].stack === "v4")).toBe(true);
    });

    test("a missing proof is a validation error", async () => {
        const response = await request(app.callback()).post("/api/wallets/preview").send({});

        expect(response.status).toBe(409);
        expect(response.body.validationError).toEqual(expect.any(String));
    });
});

/**
 * Wallet decrypt and preview choose the ZelfEncrypt stack from the record version.
 * A proof that the legacy stack cannot parse is retried on v4. A legacy proof stays on the legacy stack.
 */
jest.mock("../../Repositories/ZelfProof/modules/zelf-proof.module", () => ({
    decrypt: jest.fn(),
    preview: jest.fn(),
    encrypt: jest.fn(),
    encryptQRCode: jest.fn(),
}));

const ZelfProof = require("../../Repositories/ZelfProof/modules/zelf-proof.module");
const { decrypt, preview } = require("../../Repositories/Wallet/modules/encryption");

const parseError = () => {
    const error = new Error("failed to parse");
    error.code = "ERR_INVALID_ZELFPROOF";
    error.status = 400;
    return error;
};

describe("wallet decrypt stack", () => {
    beforeEach(() => {
        ZelfProof.decrypt.mockReset();
        ZelfProof.preview.mockReset();
    });

    test("a v4 proof is decrypted on the v4 stack after the legacy stack cannot parse it", async () => {
        ZelfProof.decrypt.mockImplementation(async (data) => {
            if (data.stack === "v4") return { metadata: { stack: "v4" } };
            throw parseError();
        });

        const result = await decrypt({ zelfProof: "v4-proof", faceBase64: "face" });

        expect(result.metadata.stack).toBe("v4");
        expect(ZelfProof.decrypt).toHaveBeenCalledTimes(2);
        expect(ZelfProof.decrypt.mock.calls[0][0].stack).toBeUndefined();
        expect(ZelfProof.decrypt.mock.calls[1][0].stack).toBe("v4");
    });

    test("an older proof stays on the legacy stack", async () => {
        ZelfProof.decrypt.mockResolvedValue({ metadata: { stack: "legacy" } });

        const result = await decrypt({ zelfProof: "legacy-proof", faceBase64: "face", v: 3 });

        expect(result.metadata.stack).toBe("legacy");
        expect(ZelfProof.decrypt).toHaveBeenCalledTimes(1);
        expect(ZelfProof.decrypt.mock.calls[0][0].stack).toBeUndefined();
    });

    test("a record marked v4 uses only the v4 stack", async () => {
        ZelfProof.decrypt.mockImplementation(async (data) => {
            if (data.stack !== "v4") throw new Error("wrong stack");
            return { metadata: { stack: "v4" } };
        });

        const result = await decrypt({
            zelfProof: "v4-proof",
            faceBase64: "face",
            publicData: { v: 4 },
        });

        expect(result.metadata.stack).toBe("v4");
        expect(ZelfProof.decrypt).toHaveBeenCalledTimes(1);
    });

    test("preview uses the v4 stack when the legacy stack cannot parse the proof", async () => {
        ZelfProof.preview.mockImplementation(async (data) => {
            if (data.stack === "v4") return { publicData: { zelfName: "name.zelf", v: 4 } };
            throw parseError();
        });

        const result = await preview({ zelfProof: "v4-proof" });

        expect(result.publicData.v).toBe(4);
        expect(ZelfProof.preview).toHaveBeenCalledTimes(2);
    });

    test("preview of an older proof stays on the legacy stack", async () => {
        ZelfProof.preview.mockResolvedValue({ publicData: { zelfName: "old.zelf", v: 3 } });

        const result = await preview({ zelfProof: "legacy-proof", encryptVersion: 3 });

        expect(result.publicData.v).toBe(3);
        expect(ZelfProof.preview).toHaveBeenCalledTimes(1);
        expect(ZelfProof.preview.mock.calls[0][0].stack).toBeUndefined();
    });
});

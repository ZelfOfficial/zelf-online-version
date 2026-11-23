jest.mock("../../Core/ipfs", () => ({
    unPinFiles: jest.fn(),
}));

jest.mock("../../Repositories/ZSend/models/zsend-envelope.model", () => ({
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    find: jest.fn(),
    updateOne: jest.fn(),
}));

jest.mock("../../Repositories/ZSend/models/zsend-certificate.model", () => ({
    find: jest.fn(),
    exists: jest.fn(),
}));

jest.mock("../../Repositories/ZSend/modules/zsend-certificates.module", () => ({
    requireActiveRecord: jest.fn(),
}));

const IPFS = require("../../Core/ipfs");
const Model = require("../../Repositories/ZSend/models/zsend-envelope.model");
const { unpinCiphertext } = require("../../Repositories/ZSend/modules/zsend-blobs.module");
const { pruneExpired, revoke } = require("../../Repositories/ZSend/modules/zsend-envelopes.module");

const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

const record = {
    _id: "env-id",
    envelopeId: "env-1",
    fromIdentifier: "sender-1",
    fromTagName: "alice.zelf",
    toTagName: "bob.zelf",
    toDomain: "zelf",
    purposeId: "zsend:bob.zelf",
    kind: "file",
    status: "pending",
    blobOwnedByZSend: true,
    cipher: { cid, byteLength: 12 },
    createdAt: new Date("2026-01-01T00:00:00Z"),
};

describe("zSend unpin on revoke and expiry", () => {
    beforeEach(() => {
        IPFS.unPinFiles.mockReset();
        IPFS.unPinFiles.mockResolvedValue([{ id: "file-123", status: "OK" }]);
        Model.findOne.mockReset();
        Model.findOneAndUpdate.mockReset();
        Model.find.mockReset();
        Model.updateOne.mockReset();
    });

    test("returns false and logs when the delete fails", async () => {
        IPFS.unPinFiles.mockRejectedValue(Object.assign(new Error("IPFS_UNPIN_FAILED"), { code: "IPFS_UNPIN_FAILED" }));
        const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});

        await expect(unpinCiphertext(cid)).resolves.toBe(false);

        expect(errorLog).toHaveBeenCalledWith(
            "zsend_unpin_failed",
            expect.objectContaining({ cid, code: "IPFS_UNPIN_FAILED" })
        );
        errorLog.mockRestore();
    });

    test("revoke and expiry delete the ciphertext pin and still update the envelope", async () => {
        Model.findOne.mockResolvedValue(record);
        Model.findOneAndUpdate.mockResolvedValue({ ...record, status: "revoked", cipher: { cid: null } });

        const revoked = await revoke({ envelopeId: record.envelopeId }, { identifier: "sender-1" });

        expect(IPFS.unPinFiles).toHaveBeenCalledWith([cid]);
        expect(revoked.status).toBe("revoked");

        IPFS.unPinFiles.mockClear();
        Model.find.mockResolvedValue([record]);
        Model.updateOne.mockResolvedValue({ acknowledged: true });

        const pruned = await pruneExpired();

        expect(pruned).toEqual({ expired: 1 });
        expect(IPFS.unPinFiles).toHaveBeenCalledWith([cid]);
        expect(Model.updateOne).toHaveBeenCalledWith(
            { _id: record._id },
            expect.objectContaining({
                $set: expect.objectContaining({ status: "expired", "cipher.cid": null }),
            })
        );
    });
});
jest.mock("../../Repositories/IPFS/modules/ipfs.module", () => ({
    get: jest.fn(),
    insert: jest.fn(),
    unPinFiles: jest.fn(),
}));

jest.mock("../../Repositories/Client/modules/client.module", () => ({
    get: jest.fn(),
}));

jest.mock("../../Repositories/ZelfProof/modules/zelf-proof.module", () => ({
    decrypt: jest.fn(),
    encrypt: jest.fn(),
}));

jest.mock("axios", () => ({
    get: jest.fn(),
}));

const IPFS = require("../../Repositories/IPFS/modules/ipfs.module");
const ClientModule = require("../../Repositories/Client/modules/client.module");
const zelfProof = require("../../Repositories/ZelfProof/modules/zelf-proof.module");
const axios = require("axios");
const { updateRole, savePasskey } = require("../../Repositories/Staff/modules/staff.module");

const staffRecord = (owner) => ({
    id: "staff-pin",
    url: "https://ipfs.example/staff",
    publicData: { staffOwnerEmail: owner, staffEmail: "member@client.test", staffRole: "read" },
});

beforeEach(() => {
    jest.clearAllMocks();
    IPFS.insert.mockResolvedValue({ IpfsHash: "cid-new" });
    IPFS.unPinFiles.mockResolvedValue([]);
    axios.get.mockResolvedValue({ data: { role: "read", zelfProof: "proof" } });
    ClientModule.get.mockResolvedValue({ url: "https://ipfs.example/client" });
    zelfProof.decrypt.mockResolvedValue({ metadata: {} });
});

describe("staff updateRole", () => {
    const body = {
        staffEmail: "member@client.test",
        newRole: "write",
        faceBase64: "face",
        masterPassword: "secret",
    };

    test("rejects a staff member outside the caller organization", async () => {
        IPFS.get.mockResolvedValue([staffRecord("other@client.test")]);

        await expect(updateRole(body, { email: "owner@client.test" })).rejects.toMatchObject({
            status: 403,
            code: "STAFF_NOT_IN_CLIENT",
        });
        expect(IPFS.unPinFiles).not.toHaveBeenCalled();
        expect(zelfProof.decrypt).not.toHaveBeenCalled();
    });

    test("rejects a caller who is not an admin of that organization", async () => {
        await expect(
            updateRole(body, { email: "reader@client.test", accountType: "staff", role: "read", ownerEmail: "owner@client.test" })
        ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
        expect(IPFS.get).not.toHaveBeenCalled();
    });

    test("updates a member of the caller organization after face and password", async () => {
        IPFS.get.mockResolvedValue([staffRecord("owner@client.test")]);

        const result = await updateRole(body, { email: "owner@client.test" });

        expect(result.newRole).toBe("write");
        expect(zelfProof.decrypt).toHaveBeenCalledWith(
            expect.objectContaining({ faceBase64: "face", password: "secret" })
        );
        expect(IPFS.insert).toHaveBeenCalled();
    });
});

describe("staff savePasskey", () => {
    const passkey = { credentialId: "cred", salt: "salt", iv: "iv", ciphertext: "cipher" };

    test("refuses to write a passkey for another email", async () => {
        await expect(savePasskey({ email: "other@client.test", passkey }, { email: "owner@client.test" })).rejects.toMatchObject({
            status: 403,
            code: "PASSKEY_OWNER_MISMATCH",
        });
        expect(IPFS.get).not.toHaveBeenCalled();
        expect(IPFS.unPinFiles).not.toHaveBeenCalled();
    });

    test("registers a passkey only for the authenticated email", async () => {
        IPFS.get.mockResolvedValue([]);

        const result = await savePasskey({ email: "owner@client.test", passkey }, { email: "owner@client.test" });

        expect(result.success).toBe(true);
        expect(IPFS.get).toHaveBeenCalledWith({ key: "passKeysEmail", value: "owner@client.test" });
        expect(IPFS.insert).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({ passKeysEmail: "owner@client.test" }),
            }),
            { pro: true }
        );
    });
});

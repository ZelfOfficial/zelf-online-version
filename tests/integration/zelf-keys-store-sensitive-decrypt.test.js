/**
 * Store path after the face whitelist strips removePGP.
 * Phone sessions have no session PGP key and send plaintext.
 * Extension sessions encrypt secrets to the session public key.
 * zOTP setup keys stay plaintext; this file only checks the gate still lets them through.
 */
process.env.PGP_PASSPHRASE = process.env.PGP_PASSPHRASE || "zelf-key-store-test-passphrase";
process.env.FACE_BODY_WHITELIST_ENABLED = "true";
process.env.FACE_REPLAY_DETECTION_ENABLED = "false";
process.env.FACE_POW_ENFORCEMENT = "log";
process.env.FACE_NONCE_ENFORCEMENT = "log";

jest.setTimeout(180000);

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const openpgp = require("openpgp");

const config = require("../../Core/config");
const FaceMiddleware = require("../../Repositories/Face/middlewares/face.middleware");
const PGPKeyModule = require("../../Repositories/PGP/modules/pgp-keys.module");
const TagsParts = require("../../Repositories/Tags/modules/tags-parts.module");
const {
    storePasswordValidation,
    storePasswordsBulkValidation,
    storeNotesValidation,
    storeCreditCardValidation,
    storeZOTPValidation,
} = require("../../Repositories/ZelfKeys/middlewares/zelf-key.middleware");

const EXTENSION_ID = "ext-user-zelf-keys";
const PHONE_ID = "phone-user-zelf-keys";

const phoneUser = { identifier: PHONE_ID, session: "phone-sess", domain: "zelf" };
const extensionUser = { identifier: EXTENSION_ID, session: "ext-sess", domain: "zelf" };

let memoryServer;
let sessionPublicKey;

const encryptForExtension = async (text) => {
    const publicKey = await openpgp.readKey({ armoredKey: sessionPublicKey });

    return openpgp.encrypt({
        message: await openpgp.createMessage({ text }),
        encryptionKeys: publicKey,
    });
};

const passValidation = async (middleware, body) => {
    const ctx = { request: { body: { ...body } } };
    let accepted = false;

    await middleware(ctx, async () => {
        accepted = true;
    });

    if (!accepted) {
        throw new Error(`store validation rejected the payload: ${JSON.stringify(ctx.body)}`);
    }
    expect(ctx.status).toBeUndefined();

    return ctx.request.body;
};

const passGate = async (action, body) => {
    config.faceSecurity.bodyWhitelist.enabled = true;
    config.faceSecurity.bodyWhitelist.strict = false;
    config.faceSecurity.replay.enabled = false;

    const headers = {};
    const ctx = {
        request: {
            body: { ...body },
            ip: "203.0.113.50",
        },
        state: {
            user: { session: "sess-store", identifier: EXTENSION_ID, tagName: "alice", domain: "zelf" },
        },
        path: "/api/zelf-keys/store",
        status: undefined,
        body: undefined,
        set(name, value) {
            headers[name.toLowerCase()] = value;
        },
        get(name) {
            return headers[name.toLowerCase()];
        },
    };

    await FaceMiddleware.gate(action)(ctx, async () => {
        ctx.status = 200;
        ctx.body = { ok: true };
    });

    expect(ctx.status).toBe(200);
    expect(ctx.request.body.removePGP).toBeUndefined();

    return ctx.request.body;
};

const acceptStore = async (middleware, action, body) => passGate(action, await passValidation(middleware, body));

beforeAll(async () => {
    jest.setTimeout(120000);
    memoryServer = await MongoMemoryServer.create();
    if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
    }
    await mongoose.connect(memoryServer.getUri());
    const generated = await PGPKeyModule.generateKey("session", EXTENSION_ID, "Extension", "ext@zelf.world");
    sessionPublicKey = generated.publicKey;
});

afterAll(async () => {
    await mongoose.disconnect();
    if (memoryServer) await memoryServer.stop();
});

describe("Zelf Key store after removePGP is stripped", () => {
    it("stores a plaintext password for a phone session with no session key", async () => {
        const body = await acceptStore(storePasswordValidation, "store-password", {
            website: "https://github.com",
            username: "ada",
            password: "plain-site-secret",
            faceBase64: "face-plain-password",
            masterPassword: "plain-master",
            removePGP: true,
            os: "ANDROID",
        });

        const secret = await TagsParts.decryptPasswordParams(body, phoneUser);
        const credentials = await TagsParts.decryptParams(
            { password: body.masterPassword, faceBase64: body.faceBase64 },
            phoneUser,
        );

        expect(secret).toEqual({ password: "plain-site-secret" });
        expect(credentials.password).toBe("plain-master");
        expect(credentials.face).toBe("face-plain-password");
    });

    it("stores an extension password encrypted to the session key", async () => {
        const body = await acceptStore(storePasswordValidation, "store-password", {
            website: "https://github.com",
            username: "ada",
            password: await encryptForExtension("armored-site-secret"),
            faceBase64: "face-armored-password",
            masterPassword: await encryptForExtension("armored-master"),
            removePGP: true,
            os: "DESKTOP",
        });

        const secret = await TagsParts.decryptPasswordParams(body, extensionUser);
        const credentials = await TagsParts.decryptParams(
            { password: body.masterPassword, faceBase64: body.faceBase64 },
            extensionUser,
        );

        expect(secret).toEqual({ password: "armored-site-secret" });
        expect(credentials.password).toBe("armored-master");
        expect(credentials.face).toBe("face-armored-password");
    });

    it("rejects an armored password when the phone session has no key", async () => {
        const body = await acceptStore(storePasswordValidation, "store-password", {
            website: "https://github.com",
            username: "ada",
            password: await encryptForExtension("needs-a-key"),
            faceBase64: "face-phone-armored-password",
            removePGP: true,
        });

        jest.spyOn(console, "error").mockImplementation(() => {});

        try {
            await expect(TagsParts.decryptPasswordParams(body, phoneUser)).rejects.toThrow("412:encryption_key_didnt_match");
        } finally {
            console.error.mockRestore();
        }
    });

    it("stores a plaintext credit card for a phone session", async () => {
        const body = await acceptStore(storeCreditCardValidation, "store-credit-card", {
            cardName: "Ada Lovelace",
            cardNumber: "4111111111111111",
            expiryMonth: "12",
            expiryYear: "2099",
            cvv: "123",
            bankName: "Test Bank",
            faceBase64: "face-plain-card",
            masterPassword: "plain-master",
            removePGP: true,
        });

        const secret = await TagsParts.decryptCreditCardParams(body, phoneUser);

        expect(secret).toEqual({
            cvv: "123",
            cardNumber: "4111111111111111",
            masterPassword: "plain-master",
        });
    });

    it("stores an extension credit card encrypted to the session key", async () => {
        const body = await acceptStore(storeCreditCardValidation, "store-credit-card", {
            cardName: "Ada Lovelace",
            cardNumber: await encryptForExtension("4111111111111111"),
            expiryMonth: "12",
            expiryYear: "2099",
            cvv: await encryptForExtension("123"),
            bankName: "Test Bank",
            faceBase64: "face-armored-card",
            masterPassword: await encryptForExtension("armored-master"),
            removePGP: true,
        });

        const secret = await TagsParts.decryptCreditCardParams(body, extensionUser);

        expect(secret).toEqual({
            cvv: "123",
            cardNumber: "4111111111111111",
            masterPassword: "armored-master",
        });
    });

    it("stores plaintext notes and does not add content", async () => {
        const body = await acceptStore(storeNotesValidation, "store-notes", {
            title: "Servers",
            keyValuePairs: { host: "db.example", port: "5432" },
            faceBase64: "face-plain-notes",
            removePGP: true,
        });

        const secret = await TagsParts.decryptNotesParams(body, phoneUser);

        expect(secret.keyValuePairs).toEqual({ host: "db.example", port: "5432" });
        expect(secret.keyValuePairs.content).toBeUndefined();
    });

    it("stores extension notes with an armored value and plaintext siblings", async () => {
        const body = await acceptStore(storeNotesValidation, "store-notes", {
            title: "Servers",
            keyValuePairs: {
                host: "db.example",
                content: await encryptForExtension("secret note"),
            },
            faceBase64: "face-armored-notes",
            removePGP: true,
        });

        const secret = await TagsParts.decryptNotesParams(body, extensionUser);

        expect(secret.keyValuePairs).toEqual({
            host: "db.example",
            content: "secret note",
        });
    });

    it("stores a plaintext bulk import for a phone session", async () => {
        const body = await acceptStore(storePasswordsBulkValidation, "store-passwords-bulk", {
            faceBase64: "face-plain-bulk",
            masterPassword: "plain-master",
            removePGP: true,
            passwords: [
                { website: "https://a.example", username: "a", password: "plain-a" },
                { website: "https://b.example", username: "b", password: "plain-b" },
            ],
        });

        const secrets = await Promise.all(
            body.passwords.map((item) => TagsParts.decryptPasswordParams({ ...item, removePGP: body.removePGP }, phoneUser)),
        );

        expect(secrets).toEqual([{ password: "plain-a" }, { password: "plain-b" }]);
    });

    it("stores a bulk import of extension passwords encrypted to the session key", async () => {
        const body = await acceptStore(storePasswordsBulkValidation, "store-passwords-bulk", {
            faceBase64: "face-armored-bulk",
            masterPassword: await encryptForExtension("armored-master"),
            removePGP: true,
            passwords: [
                { website: "https://a.example", username: "a", password: await encryptForExtension("secret-a") },
                { website: "https://b.example", username: "b", password: await encryptForExtension("secret-b") },
            ],
        });

        const credentials = await TagsParts.decryptParams(
            { password: body.masterPassword, faceBase64: body.faceBase64 },
            extensionUser,
        );
        const secrets = await Promise.all(
            body.passwords.map((item) =>
                TagsParts.decryptPasswordParams({ ...item, removePGP: body.removePGP }, extensionUser),
            ),
        );

        expect(credentials.password).toBe("armored-master");
        expect(secrets).toEqual([{ password: "secret-a" }, { password: "secret-b" }]);
    });

    it("still accepts a plaintext zOTP setup key after removePGP is stripped", async () => {
        const body = await acceptStore(storeZOTPValidation, "store-zotp", {
            username: "ada@zelf.world",
            setupKey: "JBSWY3DPEHPK3PXP",
            issuer: "GitHub",
            faceBase64: "face-zotp",
            removePGP: true,
        });

        expect(body.setupKey).toBe("JBSWY3DPEHPK3PXP");
        expect(body.username).toBe("ada@zelf.world");
        expect(body.issuer).toBe("GitHub");
    });
});

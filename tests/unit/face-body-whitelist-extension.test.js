const config = require("../../Core/config");
const {
    pickWhitelistedBody,
    STRIPPED_SERVER_ONLY_FIELDS,
} = require("../../Repositories/Face/modules/face-body-whitelist.module");

describe("face body whitelist — extension v4 payloads", () => {
    beforeEach(() => {
        config.faceSecurity.bodyWhitelist.enabled = true;
        config.faceSecurity.bodyWhitelist.strict = false;
    });

    it("my-tags transfer keeps newOwnerEmail, password, and os (tags.service TagTransferRequest)", () => {
        const { body, rejected, strictWouldReject } = pickWhitelistedBody(
            {
                tagName: "alice.zelf",
                domain: "zelf",
                newOwnerEmail: "newowner@example.com",
                faceBase64: "Zm9v",
                os: "DESKTOP",
                password: "-----BEGIN PGP MESSAGE-----",
                captchaToken: "tok",
            },
            "my-tags-transfer"
        );

        expect(rejected).toEqual([]);
        expect(body.newOwnerEmail).toBe("newowner@example.com");
        expect(body.password).toContain("PGP");
        expect(body.os).toBe("DESKTOP");
        expect(strictWouldReject).not.toContain("newOwnerEmail");
    });

    it("tags lease-recovery keeps newTagName and maps it to tagName for controllers", () => {
        const { body } = pickWhitelistedBody(
            {
                zelfProof: "proof-bytes",
                newTagName: "recovered",
                domain: "zelf",
                faceBase64: "Zm9v",
                password: "secret",
                os: "DESKTOP",
                captchaToken: "tok",
            },
            "lease-recovery"
        );

        expect(body.newTagName).toBe("recovered");
        expect(body.tagName).toBe("recovered");
        expect(body.zelfProof).toBe("proof-bytes");
    });

    it("strips only server-only fields by default (tolerance/removePGP)", () => {
        const { body, strippedServerOnly } = pickWhitelistedBody(
            {
                tagName: "a.zelf",
                domain: "zelf",
                faceBase64: "x",
                os: "DESKTOP",
                tolerance: "HARDENED",
                removePGP: true,
                customClientField: "keep-me",
            },
            "decrypt"
        );

        expect(strippedServerOnly).toEqual(expect.arrayContaining(["tolerance", "removePGP"]));
        expect(body.tolerance).toBeUndefined();
        expect(body.removePGP).toBeUndefined();
        expect(body.customClientField).toBe("keep-me");
    });

    it("strict mode drops unknown keys; loose mode keeps them and reports strictWouldReject", () => {
        config.faceSecurity.bodyWhitelist.strict = false;
        const loose = pickWhitelistedBody({ tagName: "a", faceBase64: "f", unknownKey: 1 }, "decrypt");
        expect(loose.body.unknownKey).toBe(1);
        expect(loose.strictWouldReject).toContain("unknownKey");

        config.faceSecurity.bodyWhitelist.strict = true;
        const strict = pickWhitelistedBody(
            { tagName: "a", faceBase64: "f", unknownKey: 1, domain: "zelf", os: "DESKTOP" },
            "decrypt"
        );
        expect(strict.body.unknownKey).toBeUndefined();
        expect(strict.rejected).toContain("unknownKey");
    });

    it("payment-confirmation keeps the quote token, network, and face proof", () => {
        config.faceSecurity.bodyWhitelist.strict = true;
        const { body, rejected } = pickWhitelistedBody(
            {
                tagName: "myname",
                domain: "zelf",
                network: "FREE",
                token: "signed.jwt",
                faceBase64: "face",
                masterPassword: "secret",
                pow: { challengeId: "c", solution: 1 },
                faceNonce: "nonce",
                unknownKey: "drop",
            },
            "payment-confirmation"
        );
        expect(rejected).toContain("unknownKey");
        expect(body.token).toBe("signed.jwt");
        expect(body.network).toBe("FREE");
        expect(body.faceBase64).toBe("face");
        expect(body.masterPassword).toBe("secret");
        expect(body.pow).toEqual({ challengeId: "c", solution: 1 });
        expect(body.faceNonce).toBe("nonce");
    });

    it("documents server-only strip list", () => {
        expect(STRIPPED_SERVER_ONLY_FIELDS).toContain("removePGP");
        expect(STRIPPED_SERVER_ONLY_FIELDS).toContain("tolerance");
    });
});

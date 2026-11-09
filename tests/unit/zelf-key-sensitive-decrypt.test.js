const SessionModule = require("../../Repositories/Session/modules/session.module");
const TagsParts = require("../../Repositories/Tags/modules/tags-parts.module");

const armored = (value) => `-----BEGIN PGP MESSAGE-----\n${value}\n-----END PGP MESSAGE-----`;

describe("Zelf Key sensitive fields (PGP or plaintext)", () => {
    const authUser = { identifier: "phone-session", session: "sess-phone" };
    let sessionDecrypt;

    beforeEach(() => {
        sessionDecrypt = jest.spyOn(SessionModule, "sessionDecrypt").mockImplementation(async (value) => value.split("\n")[1]);
    });

    afterEach(() => {
        sessionDecrypt.mockRestore();
    });

    describe("password", () => {
        it("keeps plaintext when removePGP was stripped", async () => {
            const out = await TagsParts.decryptPasswordParams({ password: "site-secret" }, authUser);

            expect(out).toEqual({ password: "site-secret" });
            expect(sessionDecrypt).not.toHaveBeenCalled();
        });

        it("does not decrypt a password that only contains the PGP header mid-string", async () => {
            const password = "prefix -----BEGIN PGP MESSAGE----- suffix";
            const out = await TagsParts.decryptPasswordParams({ password }, authUser);

            expect(out).toEqual({ password });
            expect(sessionDecrypt).not.toHaveBeenCalled();
        });

        it("session-decrypts an armored password", async () => {
            const out = await TagsParts.decryptPasswordParams({ password: armored("site-secret") }, authUser);

            expect(out).toEqual({ password: "site-secret" });
            expect(sessionDecrypt).toHaveBeenCalledTimes(1);
        });

        it("ignores removePGP for both plaintext and armored passwords", async () => {
            const plain = await TagsParts.decryptPasswordParams({ password: "site-secret", removePGP: true }, authUser);
            const wrapped = await TagsParts.decryptPasswordParams({ password: armored("site-secret"), removePGP: true }, authUser);

            expect(plain).toEqual({ password: "site-secret" });
            expect(wrapped).toEqual({ password: "site-secret" });
            expect(sessionDecrypt).toHaveBeenCalledTimes(1);
        });

        it("propagates a missing session key for armored passwords", async () => {
            sessionDecrypt.mockRejectedValueOnce(new Error("412:encryption_key_didnt_match"));

            await expect(TagsParts.decryptPasswordParams({ password: armored("site-secret") }, authUser)).rejects.toThrow(
                "412:encryption_key_didnt_match",
            );
        });
    });

    describe("credit card", () => {
        it("keeps plaintext card fields when removePGP was stripped", async () => {
            const out = await TagsParts.decryptCreditCardParams(
                {
                    cvv: "123",
                    cardNumber: "4111111111111111",
                    masterPassword: "master-plain",
                },
                authUser,
            );

            expect(out).toEqual({
                cvv: "123",
                cardNumber: "4111111111111111",
                masterPassword: "master-plain",
            });
            expect(sessionDecrypt).not.toHaveBeenCalled();
        });

        it("session-decrypts armored card fields and leaves a missing master password empty", async () => {
            const out = await TagsParts.decryptCreditCardParams(
                {
                    cvv: armored("123"),
                    cardNumber: armored("4111111111111111"),
                },
                authUser,
            );

            expect(out).toEqual({
                cvv: "123",
                cardNumber: "4111111111111111",
                masterPassword: null,
            });
            expect(sessionDecrypt).toHaveBeenCalledTimes(2);
        });
    });

    describe("notes", () => {
        it("keeps plaintext pairs and does not invent content", async () => {
            const keyValuePairs = { host: "db.example", port: "5432" };
            const out = await TagsParts.decryptNotesParams({ keyValuePairs }, authUser);

            expect(out.keyValuePairs).toBe(keyValuePairs);
            expect(out.keyValuePairs.content).toBeUndefined();
            expect(sessionDecrypt).not.toHaveBeenCalled();
        });

        it("session-decrypts only armored note values", async () => {
            const keyValuePairs = {
                host: "db.example",
                content: armored("secret note"),
            };
            const out = await TagsParts.decryptNotesParams({ keyValuePairs, removePGP: true }, authUser);

            expect(out.keyValuePairs).toEqual({
                host: "db.example",
                content: "secret note",
            });
            expect(keyValuePairs.content).toBe(armored("secret note"));
            expect(sessionDecrypt).toHaveBeenCalledTimes(1);
        });
    });

    describe("bulk passwords", () => {
        it("decrypts each row on its own, plaintext or armored, without removePGP", async () => {
            const rows = [{ password: "plain-a" }, { password: armored("secret-b") }, { password: "plain-c" }];

            const out = await Promise.all(rows.map((row) => TagsParts.decryptPasswordParams(row, authUser)));

            expect(out).toEqual([{ password: "plain-a" }, { password: "secret-b" }, { password: "plain-c" }]);
            expect(sessionDecrypt).toHaveBeenCalledTimes(1);
        });
    });
});

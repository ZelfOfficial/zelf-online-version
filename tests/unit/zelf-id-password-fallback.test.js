const { decryptWithPasswordFallback, isPasswordRequiredError } = require("../../Repositories/ZelfID/modules/zelf-id-password.module");

const requiredError = () => Object.assign(new Error("A PASSWORD IS REQUIRED TO DECRYPT THIS ZELFPROOF."), { code: "ERR_PASSWORD_REQUIRED", status: 409 });

describe("decryptWithPasswordFallback", () => {
	test("stale hasPassword=false + securePassword: retries with the real password (qa.zelf regression)", async () => {
		const decrypt = jest.fn(async ({ password }) => {
			if (!password) throw requiredError();
			return { metadata: { mnemonic: "m" } };
		});
		const { result, password } = await decryptWithPasswordFallback(decrypt, { zelfProof: "p" }, { password: "s3cret!", securityType: "securePassword", hasPassword: "false" });
		expect(result.metadata.mnemonic).toBe("m");
		expect(password).toBe("s3cret!");
		expect(decrypt).toHaveBeenCalledTimes(2);
	});

	test("also retries when decrypt returns an error object", async () => {
		const decrypt = jest.fn(async ({ password }) => (password ? { ok: 1 } : { error: { code: "ERR_PASSWORD_REQUIRED" } }));
		const { result } = await decryptWithPasswordFallback(decrypt, {}, { password: "pw", hasPassword: "false" });
		expect(result).toEqual({ ok: 1 });
	});

	test("face-only proof: first attempt without password succeeds, no retry", async () => {
		const decrypt = jest.fn(async () => ({ ok: 1 }));
		const { password } = await decryptWithPasswordFallback(decrypt, {}, { password: "pw", hasPassword: "false" });
		expect(password).toBeNull();
		expect(decrypt).toHaveBeenCalledTimes(1);
	});

	test("placeholder never becomes a password", async () => {
		const decrypt = jest.fn(async () => {
			throw requiredError();
		});
		await expect(decryptWithPasswordFallback(decrypt, {}, { password: "NO_PASSWORD_PLACEHOLDER", hasPassword: "false" })).rejects.toMatchObject({ code: "ERR_PASSWORD_REQUIRED" });
		expect(decrypt).toHaveBeenCalledTimes(1);
	});

	test("hasPassword=true sends the password first; wrong password is not retried", async () => {
		const err = Object.assign(new Error("bad"), { code: "ERR_INVALID_PASSWORD" });
		const decrypt = jest.fn(async () => {
			throw err;
		});
		await expect(decryptWithPasswordFallback(decrypt, {}, { password: "pw", hasPassword: "true" })).rejects.toBe(err);
		expect(decrypt).toHaveBeenCalledWith({ password: "pw" });
		expect(decrypt).toHaveBeenCalledTimes(1);
	});

	test("isPasswordRequiredError", () => {
		expect(isPasswordRequiredError(requiredError())).toBe(true);
		expect(isPasswordRequiredError({ message: "x" })).toBe(false);
	});
});

describe("PGP-or-plaintext params (single password field)", () => {
	jest.resetModules();
	const SessionModule = require("../../Repositories/Session/modules/session.module");
	const TagsParts = require("../../Repositories/Tags/modules/tags-parts.module");
	const armored = (v) => `-----BEGIN PGP MESSAGE-----\n${v}\n-----END PGP MESSAGE-----`;

	test("armored fields are session-decrypted, plaintext passes through, removePGP ignored", async () => {
		const spy = jest.spyOn(SessionModule, "sessionDecrypt").mockImplementation(async (v) => v.split("\n")[1]);
		const out = await TagsParts.decryptParams({ password: armored("s3cret!"), faceBase64: "plainface", removePGP: true }, {});
		expect(out).toEqual({ password: "s3cret!", mnemonic: null, face: "plainface" });
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	test("pin/password derived from decrypted plaintext", () => {
		const { resolveSecurityType } = require("../../Repositories/ZelfID/modules/zelf-id-password.module");
		expect(resolveSecurityType("123456")).toBe("pin");
		expect(resolveSecurityType("s3cret!")).toBe("password");
	});
});

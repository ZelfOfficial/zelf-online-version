const jwt = require("jsonwebtoken");
const config = require("../../Core/config");
const SessionModule = require("../../Repositories/Session/modules/session.module");

if (!config.JWT_SECRET) config.JWT_SECRET = "test-jwt-secret-key-for-testing-only";

describe("session identity is stamped only from the stored record", () => {
	test("a new session document ignores client tagName, verifiedTagName, zelfName, and identity", () => {
		const document = SessionModule.newSessionDocument({
			clientIP: "203.0.113.8",
			identifier: "device-1",
			domain: "zelf",
			tagName: "bob.zelf",
			verifiedTagName: "bob.zelf",
			zelfName: "bob.zelf",
			identity: { tagName: "bob.zelf", zelfName: "bob.zelf" },
			verifiedAt: new Date(),
			verifiedUntil: new Date(),
			type: "general",
		});

		expect(SessionModule.CLIENT_IDENTITY_FIELDS).toEqual(
			expect.arrayContaining(["tagName", "verifiedTagName", "zelfName", "identity"])
		);
		expect(document.tagName).toBeNull();
		expect(document.verifiedTagName).toBeNull();
		expect(document.verifiedAt).toBeNull();
		expect(document.verifiedUntil).toBeNull();
		expect(document.identifier).toBe("device-1");
	});

	test("session JWT claims omit client identity fields and expire with the 10 minute session", () => {
		const activatedAt = new Date();
		const session = {
			_id: "507f1f77bcf86cd799439011",
			domain: "zelf",
			identifier: "device-1",
			clientIP: "203.0.113.8",
			activatedAt,
			tagName: "bob.zelf",
			verifiedTagName: "bob.zelf",
			zelfName: "bob.zelf",
		};

		const claims = SessionModule.sessionJwtClaims(session, null);
		expect(claims.tagName).toBeUndefined();
		expect(claims.verifiedTagName).toBeUndefined();
		expect(claims.zelfName).toBeUndefined();
		expect(claims.identity).toBeUndefined();
		expect(claims.session).toBe(session._id);

		const startedAt = new Date("2026-01-01T00:00:00.000Z");
		const expiresIn = SessionModule.sessionJwtExpiresInSeconds(startedAt, startedAt);
		expect(expiresIn).toBe(10 * 60);

		const token = jwt.sign(claims, config.JWT_SECRET, { expiresIn });
		const decoded = jwt.verify(token, config.JWT_SECRET);
		expect(decoded.tagName).toBeUndefined();
		expect(decoded.exp - decoded.iat).toBe(10 * 60);

		const oneSecondLeft = new Date("2026-01-01T00:09:59.000Z");
		expect(SessionModule.sessionJwtExpiresInSeconds(startedAt, oneSecondLeft)).toBe(1);
	});

	const expectCode = (run, code) => {
		try {
			run();
		} catch (error) {
			expect(error.status).toBe(403);
			expect(error.code).toBe(code);
			expect(error.clientCode).toBe(code);
			return;
		}
		throw new Error(`expected ${code}`);
	};

	test("a requested name that is not the stored record is ZELF_NAME_MISMATCH and is not a stamp", () => {
		expectCode(
			() =>
				SessionModule.resolveVerificationStamp({
					stored: { zelfName: "alice.zelf", zelfProof: "stored-proof" },
					requestedName: "bob.zelf",
					decryptedName: "alice.zelf",
					clientProof: "stored-proof",
					domain: "zelf",
				}),
			"ZELF_NAME_MISMATCH"
		);
	});

	test("a decrypted name that is not the stored record is ZELF_NAME_MISMATCH and is not a stamp", () => {
		expectCode(
			() =>
				SessionModule.resolveVerificationStamp({
					stored: { zelfName: "alice.zelf", zelfProof: "stored-proof" },
					requestedName: "alice",
					decryptedName: "victim.zelf",
					clientProof: "stored-proof",
					domain: "zelf",
				}),
			"ZELF_NAME_MISMATCH"
		);
	});

	test("a blob that is not the stored zelfProof is ZELF_PROOF_MISMATCH and is not a stamp", () => {
		expectCode(
			() =>
				SessionModule.resolveVerificationStamp({
					stored: { zelfName: "alice.zelf", zelfProof: "stored-proof" },
					requestedName: "alice.zelf",
					decryptedName: "alice.zelf",
					clientProof: "other-proof",
					domain: "zelf",
				}),
			"ZELF_PROOF_MISMATCH"
		);
	});

	test("a matching stored record stamps that record's zelfName, not the client label", () => {
		const stampName = SessionModule.resolveVerificationStamp({
			stored: { zelfName: "alice.zelf", zelfProof: "stored-proof" },
			requestedName: "Alice",
			decryptedName: "alice.zelf",
			clientProof: "stored-proof",
			domain: "zelf",
		});

		expect(stampName).toBe("alice.zelf");
	});

	test("decrypt without a stored record does not stamp, and a conflicting client name is still rejected", () => {
		expect(
			SessionModule.resolveVerificationStamp({
				stored: null,
				requestedName: "alice",
				decryptedName: "alice.zelf",
				clientProof: "local-proof",
				domain: "zelf",
			})
		).toBeNull();

		expectCode(
			() =>
				SessionModule.resolveVerificationStamp({
					stored: null,
					requestedName: "bob.zelf",
					decryptedName: "alice.zelf",
					clientProof: "local-proof",
					domain: "zelf",
				}),
			"ZELF_NAME_MISMATCH"
		);
	});
});

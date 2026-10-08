jest.mock("../../Repositories/Wallet/modules/stellar", () => ({
	createStellarWallet: () => ({ address: "GMOCK", secretKey: "mock" }),
	healPublicDataXlm: (publicData) => ({
		stellar: { address: publicData.xlmAddress || "GMOCK", secretKey: "mock" },
		shouldPersistXlm: false,
		hadXlmBeforeHeal: Boolean(publicData.xlmAddress),
	}),
}));

jest.mock("../../Repositories/ZelfProof/modules/zelf-proof.module", () => ({
	upgrade: jest.fn(async () => ({ zelfProof: "upgraded-v4-proof" })),
}));

jest.mock("../../Repositories/Tags/modules/qr-zelfproof-extractor.module", () => ({
	generateQRFromZelfProof: jest.fn(async () => "data:image/png;base64,qr"),
}));

jest.mock("../../Repositories/Tags/modules/tags-ipfs.module", () => ({
	hydrateContinuationAddresses: jest.fn(async (publicData) => publicData),
	listContinuationSiblingPinIds: jest.fn(async () => []),
	unpinContinuationSiblings: jest.fn(async () => null),
	unPinFiles: jest.fn(async () => null),
	insertSearchablePins: jest.fn(async () => ({ id: "ipfs-1" })),
	upsertSearchablePins: jest.fn(async () => ({ id: "ipfs-1" })),
}));

jest.mock("../../Repositories/Tags/modules/tags-arweave.module", () => ({
	tagRegistration: jest.fn(async () => ({ id: "arw-1" })),
}));

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
	getDomainConfig: () => ({
		name: "zelf",
		getTagKey: () => "tagName",
		tags: { storage: { keyPrefix: "tagName" } },
		isArweaveEnabled: () => false,
	}),
}));

const { upgrade } = require("../../Repositories/ZelfProof/modules/zelf-proof.module");
const { generateQRFromZelfProof } = require("../../Repositories/Tags/modules/qr-zelfproof-extractor.module");
const { upgradeLegacyProofAndRepin, tryUpgradeLegacyProofAndRepin, buildRepinExtraParams } = require("../../Repositories/Tags/modules/sync-tag-records.module");

describe("upgradeLegacyProofAndRepin", () => {
	test("upgrades the proof, stamps v=4 and premium for planless mainnet", async () => {
		const tagObject = {
			id: "old-pin",
			zelfProof: "legacy-316-proof",
			publicData: {
				tagName: "abcdef.zelf",
				domain: "zelf",
				type: "mainnet",
				hasPassword: "true",
				origin: "online",
				registeredAt: "2026-09-01 21:00:00",
				expiresAt: "2027-09-01 21:00:00",
			},
		};

		const result = await upgradeLegacyProofAndRepin(tagObject, {
			faceBase64: "face",
			password: "secret",
			tagsToAdd: [],
		});

		expect(upgrade).toHaveBeenCalledWith(
			expect.objectContaining({
				stack: "v4",
				zelfProof: "legacy-316-proof",
				requireLiveness: false,
			})
		);
		expect(generateQRFromZelfProof).toHaveBeenCalledWith("upgraded-v4-proof");
		expect(result.upgraded).toBe(true);
		expect(tagObject.zelfProof).toBe("upgraded-v4-proof");
		expect(tagObject.publicData.v).toBe(4);
		expect(tagObject.publicData.plan).toBe("premium");
		expect(tagObject.zelfProofQRCode).toBe("data:image/png;base64,qr");
	});

	test("does not invent a plan for a hold reservation", async () => {
		const tagObject = {
			id: "hold-pin",
			zelfProof: "legacy-316-proof",
			zelfProofQRCode: "old-qr",
			publicData: {
				tagName: "abcdef.zelf.hold",
				domain: "zelf",
				type: "hold",
				expiresAt: "2026-10-01 12:00:00",
			},
		};

		await upgradeLegacyProofAndRepin(tagObject, { faceBase64: "face" });

		expect(tagObject.publicData.v).toBe(4);
		expect(tagObject.publicData.plan).toBeUndefined();
		expect(buildRepinExtraParams(tagObject.publicData).plan).toBeUndefined();
	});

	test("tryUpgradeLegacyProofAndRepin does not throw when upgrade fails", async () => {
		upgrade.mockRejectedValueOnce(Object.assign(new Error("VERIFICATION FAILED."), { code: "ERR_VERIFICATION_FAILED", status: 500 }));

		const tagObject = {
			id: "old-pin",
			zelfProof: "legacy-316-proof",
			publicData: { tagName: "abcdef.zelf", domain: "zelf" },
		};

		const result = await tryUpgradeLegacyProofAndRepin(tagObject, { faceBase64: "face" });

		expect(result).toEqual({ upgraded: false });
		expect(tagObject.zelfProof).toBe("legacy-316-proof");
		expect(tagObject.publicData.v).toBeUndefined();
	});
});

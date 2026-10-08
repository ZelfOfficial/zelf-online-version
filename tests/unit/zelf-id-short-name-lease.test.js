jest.mock("../../Repositories/Wallet/modules/stellar", () => ({
	createStellarWallet: jest.fn(),
	healPublicDataXlm: jest.fn(),
}));

const moment = require("moment");
const { FREE_EXPIRATION_YEARS, getBareName } = require("../../Repositories/ZelfID/modules/zelf-id-plan.module");

const licenseDomain = () => ({
	getTagKey: () => "tagName",
	name: "zelf",
	isArweaveEnabled: () => false,
	getPrice: (tagName, duration, referralTagName, options = {}) => ({
		duration: `${duration}`,
		price: options.plan === "unlimited" ? 150 : 40,
		currency: "USD",
		reward: 0,
		discount: 0,
		priceWithoutDiscount: options.plan === "unlimited" ? 150 : 40,
		discountType: "percentage",
	}),
});

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
	getDomainConfig: () => licenseDomain(),
}));

jest.mock("../../Repositories/ZelfID/modules/zelf-ids-registration.module", () => ({
	confirmZelfId: jest.fn(async (tagObject, _ref, _domainConfig, _securityType, _authUser, options = {}) => {
		const bare = getBareName(tagObject.tagName || tagObject.zelfName);
		const tagName = `${bare}.zelf`;
		const plan = options.plan || "free";
		const expiresAt = moment().add(plan === "free" ? FREE_EXPIRATION_YEARS : 1, "year").format("YYYY-MM-DD HH:mm:ss");
		tagObject.ipfs = {
			publicData: {
				tagName,
				plan,
				type: "mainnet",
				expiresAt,
			},
		};
	}),
	reserveZelfId: jest.fn(),
}));

jest.mock("../../Repositories/HumanAuthn/modules/human-authn.module", () => ({
	preview: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/qr-zelfproof-extractor.module", () => ({
	extractZelfProofFromQR: jest.fn(async () => "proof-string"),
	generateQRFromZelfProof: jest.fn(async () => "data:image/png;base64,qr"),
}));

jest.mock("../../Repositories/ZelfID/modules/zelf-id-parts.module", () => ({
	decryptParams: jest.fn(async () => ({ password: null, face: "face" })),
}));

jest.mock("../../Repositories/Tags/modules/tags.module", () => ({
	_findDuplicatedTag: jest.fn(),
	_validateReferral: jest.fn(async () => null),
	previewZelfProof: jest.fn(),
	searchTag: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tags-parts.module", () => ({
	decryptParams: jest.fn(async () => ({ password: null })),
	getTagNameFromPublicData: jest.fn(),
}));

jest.mock("../../Repositories/ZelfProof/modules/zelf-proof.module", () => ({
	preview: jest.fn(),
}));

const ZelfIdsRegistrationModule = require("../../Repositories/ZelfID/modules/zelf-ids-registration.module");
const HumanAuthnModule = require("../../Repositories/HumanAuthn/modules/human-authn.module");
const ZelfProofModule = require("../../Repositories/ZelfProof/modules/zelf-proof.module");
const ZelfIdsOfflineModule = require("../../Repositories/ZelfID/modules/zelf-ids-offline.module");
const ZelfIdModule = require("../../Repositories/ZelfID/modules/zelf-id.module");
const { persistZelfIdLease } = ZelfIdModule;
const { leaseOfflineTag } = require("../../Repositories/Tags/modules/tags-offline.module");

const expectFreeMainnetLease = (publicData, bare) => {
	expect(publicData.tagName).toBe(`${bare}.zelf`);
	expect(publicData.plan).toBe("free");
	expect(publicData.type).toBe("mainnet");
	const years = moment(publicData.expiresAt, "YYYY-MM-DD HH:mm:ss").diff(moment(), "year", true);
	expect(years).toBeGreaterThanOrEqual(99);
	expect(publicData.tagName).not.toMatch(/\.hold/i);
};

describe("short Zelf ID names lease as free mainnet (no new .hold)", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		ZelfIdModule._findDuplicatedTag = jest.fn();
		ZelfIdModule._validateReferral = jest.fn(async () => null);
	});

	test("persistZelfIdLease — POST /api/zelf-ids/lease path (shared persist)", async () => {
		const tagObject = { tagName: "a", domain: "zelf", zelfProofQRCode: "qr", hasPassword: "false", duration: "1" };

		await persistZelfIdLease(tagObject, null, licenseDomain(), null, { pro: true });

		expect(ZelfIdsRegistrationModule.reserveZelfId).not.toHaveBeenCalled();
		expect(ZelfIdsRegistrationModule.confirmZelfId).toHaveBeenCalledWith(
			tagObject,
			null,
			expect.any(Object),
			null,
			{ pro: true },
			{ plan: "free" }
		);
		expect(tagObject.price).toBe(0);
		expectFreeMainnetLease(tagObject.ipfs.publicData, "a");
	});

	test("leaseOffline — POST /api/zelf-ids/lease-offline", async () => {
		HumanAuthnModule.preview.mockResolvedValue({
			passwordLayer: "WithoutPassword",
			publicData: { tagName: "b.zelf", domain: "zelf" },
		});

		const result = await ZelfIdsOfflineModule.leaseOffline(
			{
				tagName: "b",
				domain: "zelf",
				zelfProof: "proof-string",
			},
			{ pro: true }
		);

		expect(ZelfIdsRegistrationModule.reserveZelfId).not.toHaveBeenCalled();
		expect(ZelfIdsRegistrationModule.confirmZelfId).toHaveBeenCalled();
		expectFreeMainnetLease(result.zelfIDObject.publicData, "b");
		expect(result.tagName).toBe("b.zelf");
	});

	test("leaseOfflineTag — POST /api/tags/lease-offline v4 shim", async () => {
		ZelfProofModule.preview.mockResolvedValue({
			passwordLayer: "WithoutPassword",
			publicData: { tagName: "c.zelf", domain: "zelf" },
		});
		HumanAuthnModule.preview.mockResolvedValue({
			passwordLayer: "WithoutPassword",
			publicData: { tagName: "c.zelf", domain: "zelf" },
		});

		const result = await leaseOfflineTag(
			{
				tagName: "c",
				domain: "zelf",
				zelfProof: "v4-proof",
				sync: false,
			},
			{ pro: true }
		);

		expect(ZelfIdsRegistrationModule.reserveZelfId).not.toHaveBeenCalled();
		expect(ZelfIdsRegistrationModule.confirmZelfId).toHaveBeenCalled();
		expect(result.tagName).toBe("c.zelf");
		expect(result.origin).toBe("offline");
		const leasedTagObject = ZelfIdsRegistrationModule.confirmZelfId.mock.calls.at(-1)[0];
		expectFreeMainnetLease(leasedTagObject.ipfs.publicData, "c");
	});
});

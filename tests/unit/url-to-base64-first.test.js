jest.mock("../../Core/safe-image-fetch", () => ({
	fetchAllowedImage: jest.fn(),
}));

const { fetchAllowedImage } = require("../../Core/safe-image-fetch");
const { urlToBase64First } = require("../../Repositories/Tags/modules/tags-parts.module");

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);

const rejectImage = () => {
	const error = new Error("IMAGE_URL_FETCH_FAILED");
	error.code = "IMAGE_URL_FETCH_FAILED";
	return Promise.reject(error);
};

describe("urlToBase64First", () => {
	beforeEach(() => {
		fetchAllowedImage.mockReset();
	});

	it("returns null when all URLs fail", async () => {
		fetchAllowedImage.mockImplementation(rejectImage);
		const out = await urlToBase64First(["https://arweave.net/missing", "https://ipfs.io/ipfs/missing"]);
		expect(out).toBeNull();
		expect(fetchAllowedImage).toHaveBeenCalledTimes(2);
	});

	it("uses second URL when first returns 404", async () => {
		fetchAllowedImage.mockImplementation(async (url) => {
			if (String(url).includes("arweave")) return rejectImage();
			return { buffer: png, contentType: "image/png" };
		});
		const out = await urlToBase64First(["https://arweave.net/dead", "https://gateway.pinata.cloud/ipfs/QmGood"]);
		expect(out).toMatch(/^data:image\/png;base64,/);
		expect(fetchAllowedImage).toHaveBeenCalledTimes(2);
	});

	it("skips duplicate URLs", async () => {
		fetchAllowedImage.mockImplementation(rejectImage);
		await urlToBase64First(["https://arweave.net/x", "https://arweave.net/x", "https://arweave.net/x"]);
		expect(fetchAllowedImage).toHaveBeenCalledTimes(1);
	});
});

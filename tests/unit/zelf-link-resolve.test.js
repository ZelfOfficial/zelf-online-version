const gw = require("../../Repositories/Arweave/modules/arweave-gateway.module");
const { parseZelfName } = require("../../Repositories/ZelfLink/routes/zelf-link.routes");

describe("Zelf Link gateways", () => {
	beforeEach(() => gw._clearZelfLinkCache());

	test("ar.io is the primary gateway", () => {
		expect(gw.getArnsGatewayHosts()[0]).toBe("ar.io");
		expect(gw.buildArnsUndernameUrl("abc", "zelf")).toBe("https://abc_zelf.ar.io");
		expect(gw.buildArnsUndernameUrls("abc", "bdag")[0]).toBe("https://abc_bdag_zelf.ar.io");
	});

	test("falls back to the next working gateway and caches", async () => {
		const probe = jest.fn(async (url) => !url.includes(".ar.io"));
		const first = await gw.resolveZelfLink("abc", "zelf", { probe });
		expect(first.resolved).toBe(true);
		expect(first.url).toBe(gw.buildArnsUndernameUrls("abc", "zelf")[1]);
		const calls = probe.mock.calls.length;
		const second = await gw.resolveZelfLink("abc", "zelf", { probe });
		expect(second.cached).toBe(true);
		expect(probe.mock.calls.length).toBe(calls);
	});

	test("unresolved returns primary url", async () => {
		const r = await gw.resolveZelfLink("nope", "zelf", { probe: async () => false });
		expect(r).toMatchObject({ resolved: false, url: "https://nope_zelf.ar.io" });
	});

	test("parses names", () => {
		expect(parseZelfName("Jim.zelf")).toEqual({ tagName: "jim", domain: "zelf" });
		expect(parseZelfName("jim")).toEqual({ tagName: "jim", domain: "zelf" });
		expect(parseZelfName("../x")).toBeNull();
	});
});

describe("zelf-link route", () => {
	let handler;
	require("../../Repositories/ZelfLink/routes/zelf-link.routes")({ get: (_p, h) => (handler = h) });
	const ctxFor = (query = {}) => ({ params: { zelfName: "x.zelf" }, query, set: jest.fn(), redirect: jest.fn() });
	afterEach(() => jest.restoreAllMocks());

	test("not found: 404 JSON, HTML page, no redirect", async () => {
		jest.spyOn(gw, "resolveZelfLink").mockResolvedValue({ url: "https://x_zelf.ar.io", urls: [], resolved: false });
		const json = ctxFor({ format: "json" });
		await handler(json);
		expect(json.status).toBe(404);
		expect(json.body.error).toBe("zelf_link_not_found");
		const html = ctxFor();
		await handler(html);
		expect(html.status).toBe(404);
		expect(html.type).toBe("html");
		expect(html.body).toContain("x.zelf");
		expect(html.redirect).not.toHaveBeenCalled();
	});

	test("found: redirects", async () => {
		jest.spyOn(gw, "resolveZelfLink").mockResolvedValue({ url: "https://x_zelf.ar.io", urls: [], resolved: true });
		const ctx = ctxFor();
		await handler(ctx);
		expect(ctx.redirect).toHaveBeenCalledWith("https://x_zelf.ar.io");
	});
});

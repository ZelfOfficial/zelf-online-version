/**
 * Domain license cache (2026-10-01 audit). The cache is the real node-cache instance with its
 * real 2-hour TTL and the clock is moved with jest's fake timers. Only Pinata and the license
 * JSON downloads are in-memory fakes: no test may reach the network.
 */
// The suite exercises stale-while-revalidate timing with a 2-hour TTL; production defaults to 60s.
process.env.LICENSE_CACHE_TTL_SECONDS = "7200";

const mockIpfsGet = jest.fn();
const mockHttpGet = jest.fn();

jest.mock("../../Repositories/IPFS/modules/ipfs.module", () => ({ get: (...args) => mockIpfsGet(...args) }));
jest.mock("../../Core/axios", () => ({ getEncryptionInstance: () => ({ get: (...args) => mockHttpGet(...args) }) }));

const T0 = new Date("2026-10-01T12:00:00.000Z").getTime();
const MINUTE = 60 * 1000;
const TTL = 120 * MINUTE;

let SupportedDomains;
let cache;

const license = (name, extra = {}) => ({ name, status: "active", type: "official", ...extra });
const pins = (names) => names.map((name) => ({ id: `pin-${name}`, url: `https://ipfs.invalid/${name}` }));
const at = (ms) => jest.setSystemTime(T0 + ms);
const flush = () => new Promise((resolve) => jest.requireActual("timers").setImmediate(resolve));
const deferred = () => {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

beforeEach(() => {
	jest.useFakeTimers({ now: T0 });
	jest.spyOn(console, "info").mockImplementation(() => {});
	jest.spyOn(console, "warn").mockImplementation(() => {});
	jest.spyOn(console, "error").mockImplementation(() => {});
	mockIpfsGet.mockReset();
	mockHttpGet.mockReset();
	mockHttpGet.mockImplementation(async (url) => ({ data: license(url.split("/").pop()) }));

	// A fresh worker: new module state and a new cache instance.
	jest.resetModules();
	SupportedDomains = require("../../Repositories/Tags/config/supported-domains");
	cache = require("../../cache/manager").getCacheInstance();
});

afterEach(() => {
	jest.useRealTimers();
	jest.restoreAllMocks();
});

test("a reload with identical data restarts the TTL", async () => {
	SupportedDomains.getSupportedDomains([license("zelf"), license("avax")]);
	mockIpfsGet.mockResolvedValue(pins(["zelf", "avax"]));

	at(90 * MINUTE);
	await SupportedDomains.loadDynamicDomains(null, true);

	// Past the TTL of the first save: only the identical reload keeps the entry alive.
	at(150 * MINUTE);
	expect(cache.get("official-license-domains")).toBeTruthy();
	expect(cache.getTtl("official-license-domains")).toBe(T0 + 90 * MINUTE + TTL);
	expect(SupportedDomains.getDomainConfig("zelf")?.name).toBe("zelf");
	expect(mockIpfsGet).toHaveBeenCalledTimes(1);
});

test("after expiry every lookup keeps the last licenses while one shared reload runs", async () => {
	SupportedDomains.getSupportedDomains([license("zelf", { description: "old" })]);
	const pinata = deferred();
	mockIpfsGet.mockReturnValue(pinata.promise);
	mockHttpGet.mockImplementation(async () => ({ data: license("zelf", { description: "fresh" }) }));

	at(TTL + MINUTE);
	expect(cache.get("official-license-domains")).toBeUndefined();

	const lookups = Array.from({ length: 5 }, () => SupportedDomains.getDomainConfig("zelf"));
	const waiting = [SupportedDomains.loadDynamicDomains(), SupportedDomains.loadDynamicDomains()];

	expect(lookups.every((domain) => domain?.name === "zelf" && domain.description === "old")).toBe(true);
	expect(SupportedDomains.isSupported("zelf")).toBe(true);
	expect(mockIpfsGet).toHaveBeenCalledTimes(1);

	pinata.resolve(pins(["zelf"]));
	const [first, second] = await Promise.all(waiting);

	expect(first).toBe(second);
	expect(SupportedDomains.getDomainConfig("zelf").description).toBe("fresh");
	expect(cache.getTtl("official-license-domains")).toBe(T0 + TTL + MINUTE + TTL);
	expect(mockIpfsGet).toHaveBeenCalledTimes(1);
});

test("a failed reload keeps serving the last licenses and background retries are spaced out", async () => {
	SupportedDomains.getSupportedDomains([license("zelf")]);
	mockIpfsGet.mockRejectedValue(new Error("pinata down"));

	at(TTL + MINUTE);
	const loaded = await SupportedDomains.loadDynamicDomains();

	expect(Object.keys(loaded)).toEqual(["zelf"]);
	expect(SupportedDomains.getDomainConfig("zelf")?.name).toBe("zelf");
	expect(SupportedDomains.getDomainConfig("zelf")?.name).toBe("zelf");
	await flush();
	expect(mockIpfsGet).toHaveBeenCalledTimes(1);

	at(TTL + MINUTE + 31 * 1000);
	expect(SupportedDomains.getDomainConfig("zelf")?.name).toBe("zelf");
	await flush();
	expect(mockIpfsGet).toHaveBeenCalledTimes(2);
});

test("an empty reload never replaces the known licenses", async () => {
	SupportedDomains.getSupportedDomains([license("zelf"), license("avax")]);
	mockIpfsGet.mockResolvedValue([]);

	at(TTL + MINUTE);
	const loaded = await SupportedDomains.loadDynamicDomains();

	expect(Object.keys(loaded).sort()).toEqual(["avax", "zelf"]);
	expect(cache.get("official-license-domains")).toBeUndefined();
	expect(SupportedDomains.getDomainConfig("avax")?.name).toBe("avax");

	// Something else writing an empty map is a miss too, never an empty config.
	cache.set("official-license-domains", {});
	expect(SupportedDomains.getDomainConfig("zelf")?.name).toBe("zelf");
});

test("a license save after expiry keeps the other domains", () => {
	SupportedDomains.getSupportedDomains([license("zelf"), license("avax")]);

	at(TTL + MINUTE);
	SupportedDomains.upsertCachedDomain(license("avax", { description: "renewed" }));

	expect(Object.keys(cache.get("official-license-domains")).sort()).toEqual(["avax", "zelf"]);
	expect(SupportedDomains.getDomainConfig("zelf")?.name).toBe("zelf");
	expect(SupportedDomains.getDomainConfig("avax").description).toBe("renewed");
});

test("only a worker that never loaded licenses answers the static list, and starts one reload", async () => {
	const pinata = deferred();
	mockIpfsGet.mockReturnValue(pinata.promise);

	expect(SupportedDomains.getSupportedDomains()).toEqual({});
	expect(SupportedDomains.getDomainConfig("zelf")).toBeNull();
	expect(mockIpfsGet).toHaveBeenCalledTimes(1);

	pinata.resolve(pins(["zelf"]));
	await flush();
	await flush();

	expect(SupportedDomains.getDomainConfig("zelf")?.name).toBe("zelf");
});

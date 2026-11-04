const { createSwrCache } = require("../../Core/utils/swr-snapshot-cache");

describe("swr snapshot cache", () => {
    test("fresh, stale-while-revalidate and shared in-flight load", async () => {
        let t = 0;
        let calls = 0;
        const c = createSwrCache({ ttlMs: 10, maxStaleMs: 100, now: () => t });
        const loader = async () => ++calls;
        const [a, b] = await Promise.all([c.get("k", loader), c.get("k", loader)]);
        expect(a.value).toBe(1);
        expect(b.value).toBe(1);
        expect(calls).toBe(1);
        t = 50;
        const stale = await c.get("k", loader);
        expect(stale).toMatchObject({ value: 1, stale: true });
        await new Promise((r) => setImmediate(r));
        expect((await c.get("k", loader)).value).toBe(2);
        t = 1000;
        expect((await c.get("k", loader)).value).toBe(3);
    });

    test("warmer refreshes used keys in the background", async () => {
        jest.useFakeTimers();
        let calls = 0;
        const c = createSwrCache({ ttlMs: 1000, warmIntervalMs: 100 });
        await c.get("k", async () => ++calls);
        jest.advanceTimersByTime(250);
        jest.useRealTimers();
        await new Promise((r) => setImmediate(r));
        expect(calls).toBeGreaterThanOrEqual(2);
    });
});

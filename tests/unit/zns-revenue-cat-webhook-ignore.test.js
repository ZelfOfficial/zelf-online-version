jest.mock("../../Core/ipfs", () => ({
    filter: jest.fn(),
    pinFile: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tags.module", () => ({
    previewTag: jest.fn(),
    searchTag: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/my-tags.module", () => ({
    addDurationToTag: jest.fn(),
}));

const pinata = require("../../Core/ipfs");
const TagsModule = require("../../Repositories/Tags/modules/tags.module");
const { webhookHandler } = require("../../Repositories/ZelfNameService/modules/revenue-cat.module");

const attr = (value) => ({ value, updated_at_ms: 1 });

const rcEvent = (type, overrides = {}) => ({
    type,
    id: `evt_${type}`,
    environment: "PRODUCTION",
    product_id: "zelf_keys_plan_pro:zelf-keys-pro",
    transaction_id: "GPA.1..1",
    subscriber_attributes: {},
    ...overrides,
});

describe("ZNS RevenueCat webhook: events it does not act on", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, "info").mockImplementation(() => {});
    });

    afterEach(() => {
        console.info.mockRestore();
    });

    it.each(["EXPIRATION", "BILLING_ISSUE", "SUBSCRIPTION_EXTENDED", "UNCANCELLATION", "TEST"])(
        "acknowledges %s instead of failing with 500",
        async (type) => {
            await expect(webhookHandler({ event: rcEvent(type) })).resolves.toEqual({
                ignored: true,
                reason: "unhandled_event_type",
                type,
            });
            expect(pinata.filter).not.toHaveBeenCalled();
        }
    );

    it.each(["INITIAL_PURCHASE", "RENEWAL", "CANCELLATION"])(
        "acknowledges a Zelf Keys %s sent without zelfName instead of failing with 400",
        async (type) => {
            await expect(webhookHandler({ event: rcEvent(type) })).resolves.toEqual({
                ignored: true,
                reason: "zelf_name_missing",
                type,
            });
            expect(pinata.filter).not.toHaveBeenCalled();
        }
    );

    it("still processes a Zelf Keys RENEWAL that carries zelfName", async () => {
        pinata.filter.mockResolvedValueOnce([]);
        TagsModule.searchTag.mockResolvedValueOnce({ available: true });

        await expect(
            webhookHandler({
                event: rcEvent("RENEWAL", {
                    subscriber_attributes: { zelfName: attr("alice.zelf"), ethAddress: attr("0xabc") },
                }),
            })
        ).rejects.toThrow("tag_not_found");

        expect(pinata.filter).toHaveBeenCalledWith("transactionId", "GPA.1..1");
        expect(TagsModule.searchTag).toHaveBeenCalledWith(expect.objectContaining({ tagName: "alice", domain: "zelf" }), {});
    });

    it("still processes NON_RENEWING_PURCHASE (Zelf ID purchases are not ignored)", async () => {
        const event = rcEvent("NON_RENEWING_PURCHASE", {
            product_id: "zelf_name_service_char_6_to_15_years_1",
            subscriber_attributes: { zelfName: attr("alice.zelf"), ethAddress: attr("0xabc"), duration: attr("1") },
        });
        TagsModule.previewTag.mockResolvedValueOnce({
            tagObject: { publicData: { eventID: event.id, ethAddress: "0xabc" } },
            preview: {},
        });

        await expect(webhookHandler({ event })).rejects.toThrow("webhook_already_processed");
        expect(TagsModule.previewTag).toHaveBeenCalledWith(expect.objectContaining({ tagName: "alice", domain: "zelf" }), {});
    });
});

describe("ZNS RevenueCat: NON_RENEWING_PURCHASE without zelfName", () => {
    test("is ignored instead of crashing on zelfName.split", async () => {
        jest.clearAllMocks();
        jest.spyOn(console, "info").mockImplementation(() => {});
        const result = await webhookHandler({ event: rcEvent("NON_RENEWING_PURCHASE", { subscriber_attributes: undefined }) });
        expect(result).toMatchObject({ ignored: true, reason: "zelf_name_missing" });
        expect(TagsModule.previewTag).not.toHaveBeenCalled();
        console.info.mockRestore();
    });
});

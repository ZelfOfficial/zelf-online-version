/**
 * OneSignal request body and response handling for received-transfer pushes
 * (Zelf #566 §3). Pure logic: no request is ever sent from tests.
 */
const crypto = require("crypto");

const {
    buildSummaryPayload,
    buildTransferPayload,
    pickLanguage,
    shortAddress,
    transferDigest,
    uuidFromDigest,
} = require("../../Repositories/TxNotifications/modules/push-message.util");
const { interpretOneSignalResponse } = require("../../Repositories/TxNotifications/modules/onesignal.client");

const APP_ID = "e8a5079a-3958-4261-9b23-6a9459f0e118";
const RECEIVER = "0x28C6c06298d514Db089934071355E5743bf21d60";
const SENDER = "0x6f7e32c8b14eeceb7f5b842570aff50967f7a2d6";

const device = (language = "es") => ({
    _id: "665f00000000000000000001",
    pushSubscriptionId: "0b2b3c4d-1111-4222-8333-944455556666",
    language,
    tagName: "qa99.zelf",
    addresses: [{ network: "ethereum", address: RECEIVER, key: `ethereum:${RECEIVER.toLowerCase()}` }],
});

const transfer = (overrides = {}) => ({
    network: "ethereum",
    hash: "0x96dad0513fa5cbb18f08479eae77fde59d7ccc294b1111f500e91a7892b066c1",
    amount: "1.181844244575885",
    asset: "ETH",
    from: SENDER,
    timestampMs: Date.parse("2026-09-30T15:00:00.000Z"),
    native: true,
    ...overrides,
});

describe("tx-notifications push text", () => {
    it("Spanish: title and body with amount, asset, network and short sender", () => {
        const payload = buildTransferPayload({ appId: APP_ID, device: device("es"), transfer: transfer() });
        expect(payload.headings).toEqual({ en: "Transacción recibida" });
        expect(payload.contents).toEqual({ en: "Recibiste 1.18184424 ETH en Ethereum de 0x6f…a2d6" });
    });

    it("English for en and for every other language", () => {
        for (const language of ["en", "en-US", "pt", "fr", null]) {
            const payload = buildTransferPayload({ appId: APP_ID, device: { ...device(), language }, transfer: transfer({ network: "bsc", asset: "USDT", amount: "73.505", native: false }) });
            expect(payload.headings).toEqual({ en: "Transaction received" });
            expect(payload.contents).toEqual({ en: "You received 73.505 USDT on BNB Smart Chain from 0x6f…a2d6" });
        }
    });

    it("regional Spanish variants use Spanish", () => {
        expect(pickLanguage("es-CO")).toBe("es");
        expect(pickLanguage("es_419")).toBe("es");
        expect(pickLanguage("est")).toBe("en");
    });

    it("unknown amount: 'Recibiste {asset} en {Network}'", () => {
        const es = buildTransferPayload({ appId: APP_ID, device: device("es"), transfer: transfer({ network: "stellar", asset: "XLM", amount: null }) });
        const en = buildTransferPayload({ appId: APP_ID, device: device("en"), transfer: transfer({ network: "stellar", asset: "XLM", amount: null }) });
        expect(es.contents.en).toBe("Recibiste XLM en Stellar");
        expect(en.contents.en).toBe("You received XLM on Stellar");
    });

    it("unknown sender drops the 'de …' part", () => {
        const payload = buildTransferPayload({ appId: APP_ID, device: device("es"), transfer: transfer({ network: "bitcoin", asset: "BTC", amount: "0.5", from: null }) });
        expect(payload.contents.en).toBe("Recibiste 0.5 BTC en Bitcoin");
    });

    it("short address is first 4 + … + last 4", () => {
        expect(shortAddress("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9")).toBe("5tzF…uAi9");
        expect(shortAddress("")).toBeNull();
    });

    it("summary push: singular and plural, opens the newest transfer", () => {
        const older = transfer({ hash: "0x01", timestampMs: 1000 });
        const newer = transfer({ network: "solana", asset: "SOL", hash: "sig-2", timestampMs: 2000 });
        const many = buildSummaryPayload({ appId: APP_ID, device: device("es"), transfers: [older, newer] });
        expect(many.contents.en).toBe("Recibiste 2 transacciones nuevas");
        expect(many.data).toMatchObject({ type: "tx_received", network: "solana", hash: "sig-2", asset: "SOL", timestamp: "2000", summary: "true", count: "2" });

        const one = buildSummaryPayload({ appId: APP_ID, device: device("en"), transfers: [older] });
        expect(one.contents.en).toBe("You received 1 new transaction");
    });
});

describe("tx-notifications OneSignal payload", () => {
    const payload = buildTransferPayload({ appId: APP_ID, device: device("es"), transfer: transfer() });

    it("targets the subscription on the zelf_transactions channel with a 24 h ttl", () => {
        expect(payload.app_id).toBe(APP_ID);
        expect(payload.include_subscription_ids).toEqual(["0b2b3c4d-1111-4222-8333-944455556666"]);
        expect(payload.existing_android_channel_id).toBe("zelf_transactions");
        expect(payload.ttl).toBe(86400);
        const t = transfer();
        expect(payload.data).toEqual({
            type: "tx_received",
            network: "ethereum",
            hash: t.hash,
            amount: String(t.amount),
            asset: t.asset,
            sender: shortAddress(t.from),
            timestamp: String(t.timestampMs),
            date: new Date(t.timestampMs).toISOString(),
        });
        Object.values(payload.data).forEach((v) => expect(typeof v).toBe("string"));
    });

    it("collapse id and idempotency key derive from sha256(network|hash|pushSubscriptionId)", () => {
        const digest = crypto.createHash("sha256").update(`ethereum|${transfer().hash}|0b2b3c4d-1111-4222-8333-944455556666`).digest("hex");
        expect(transferDigest("ethereum", transfer().hash, "0b2b3c4d-1111-4222-8333-944455556666")).toBe(digest);
        expect(payload.collapse_id).toBe(digest.slice(0, 32));
        expect(payload.idempotency_key).toBe(uuidFromDigest(digest));
        expect(payload.idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it("is deterministic per (network, hash, device) and different for another device", () => {
        const again = buildTransferPayload({ appId: APP_ID, device: device("es"), transfer: transfer() });
        const other = buildTransferPayload({ appId: APP_ID, device: { ...device("es"), pushSubscriptionId: "0b2b3c4d-1111-4222-8333-944455550000" }, transfer: transfer() });
        expect(again.idempotency_key).toBe(payload.idempotency_key);
        expect(other.idempotency_key).not.toBe(payload.idempotency_key);
    });

    it("never carries a full address, the tag name or the receiving address", () => {
        const text = JSON.stringify(payload).toLowerCase();
        expect(text).not.toContain(RECEIVER.toLowerCase());
        expect(text).not.toContain(SENDER.toLowerCase());
        expect(text).not.toContain("qa99");
    });
});

describe("tx-notifications OneSignal responses", () => {
    const id = "0b2b3c4d-1111-4222-8333-944455556666";

    it("200 with an id is sent", () => {
        expect(interpretOneSignalResponse(200, { id: "b98881cc-1e94-4366-bbd9-db8f3429292b", external_id: null, errors: {} }, id)).toEqual({
            outcome: "sent",
            notificationId: "b98881cc-1e94-4366-bbd9-db8f3429292b",
        });
    });

    it("invalid_player_ids naming the subscription disables the device", () => {
        expect(interpretOneSignalResponse(200, { id: "x", errors: { invalid_player_ids: [id] } }, id).outcome).toBe("invalid_subscription");
    });

    it("'All included players are not subscribed' disables the device", () => {
        expect(interpretOneSignalResponse(200, { id: "", errors: ["All included players are not subscribed"] }, id).outcome).toBe("invalid_subscription");
    });

    it("auth and rate-limit answers stop the cycle; 5xx is retryable; other 4xx is not", () => {
        expect(interpretOneSignalResponse(401, { errors: ["Access denied.  Please include an 'Authorization: ...' header with a valid API key"] }, id).outcome).toBe("auth_error");
        expect(interpretOneSignalResponse(429, {}, id).outcome).toBe("rate_limited");
        expect(interpretOneSignalResponse(503, {}, id)).toEqual({ outcome: "failed", retryable: true, error: "onesignal_http_503" });
        expect(interpretOneSignalResponse(400, { errors: ["Message Notifications must have English language content"] }, id)).toEqual({
            outcome: "failed",
            retryable: false,
            error: "Message Notifications must have English language content",
        });
    });
});

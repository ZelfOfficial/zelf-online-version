const crypto = require("crypto");

const { displayAmount } = require("./amount.util");
const { networkDisplayName } = require("./networks");

/**
 * Text and OneSignal request body for received-transfer pushes (contract #566 §3).
 * Pure functions: no I/O, so the exact payload is unit-tested.
 *
 * Privacy: the body only ever carries a shortened sender ("0xB8a…1f3c"); never
 * the receiving address, the tag name, seeds or keys.
 */

const ANDROID_CHANNEL_ID = "zelf_transactions";
const PUSH_TTL_SECONDS = 86400;

const TEXTS = {
    es: {
        title: "Transacción recibida",
        full: (t) => `Recibiste ${t.amount} ${t.asset} en ${t.network} de ${t.sender}`,
        noSender: (t) => `Recibiste ${t.amount} ${t.asset} en ${t.network}`,
        noAmount: (t) => `Recibiste ${t.asset} en ${t.network}`,
        summary: (count) => (count === 1 ? "Recibiste 1 transacción nueva" : `Recibiste ${count} transacciones nuevas`),
    },
    en: {
        title: "Transaction received",
        full: (t) => `You received ${t.amount} ${t.asset} on ${t.network} from ${t.sender}`,
        noSender: (t) => `You received ${t.amount} ${t.asset} on ${t.network}`,
        noAmount: (t) => `You received ${t.asset} on ${t.network}`,
        summary: (count) => (count === 1 ? "You received 1 new transaction" : `You received ${count} new transactions`),
    },
};

/** "es", "es-CO", "es_419" → es; anything else → en. */
const pickLanguage = (language) => (/^es([_-]|$)/i.test(String(language || "")) ? "es" : "en");

/** First 4 + "…" + last 4. */
const shortAddress = (address) => {
    const value = String(address || "").trim();
    if (!value) return null;
    if (value.length <= 10) return value;
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
};

const sha256Hex = (value) => crypto.createHash("sha256").update(value).digest("hex");

/** Deterministic RFC 9562 v4-shaped UUID from a hex digest (OneSignal idempotency_key must be a UUID). */
const uuidFromDigest = (digest) => {
    const bytes = Buffer.from(digest.slice(0, 32), "hex");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** sha256(network|hash|pushSubscriptionId): the same transfer never reaches the same device twice. */
const transferDigest = (network, hash, pushSubscriptionId) => sha256Hex(`${network}|${hash}|${pushSubscriptionId}`);

const summaryDigest = (transfers, pushSubscriptionId) =>
    sha256Hex(`summary|${transfers.map((t) => `${t.network}:${t.hash}`).sort().join(",")}|${pushSubscriptionId}`);

const transferText = (transfer, language) => {
    const texts = TEXTS[pickLanguage(language)];
    const amount = transfer.amount ? displayAmount(transfer.amount) : null;
    const parts = {
        amount,
        asset: transfer.asset,
        network: networkDisplayName(transfer.network),
        sender: shortAddress(transfer.from),
    };

    let body;
    if (!amount) body = texts.noAmount(parts);
    else if (!parts.sender) body = texts.noSender(parts);
    else body = texts.full(parts);

    return { title: texts.title, body };
};

/** Push `data` for one transfer: everything the app needs to render the detail (#561). Values are strings for OneSignal. */
const transferData = (transfer) => {
    const data = { type: "tx_received", network: transfer.network, hash: transfer.hash };
    if (transfer.amount != null && transfer.amount !== "") data.amount = String(transfer.amount);
    if (transfer.asset) data.asset = String(transfer.asset);
    // Push payloads never carry a full address (privacy invariant); the app can resolve the full sender from network+hash.
    const sender = shortAddress(transfer.from);
    if (sender) data.sender = sender;
    if (Number.isFinite(Number(transfer.timestampMs)) && transfer.timestampMs != null) {
        data.timestamp = String(transfer.timestampMs);
        data.date = new Date(Number(transfer.timestampMs)).toISOString();
    }
    return data;
};

const basePayload = ({ appId, pushSubscriptionId, title, body, data, digest }) => ({
    app_id: appId,
    include_subscription_ids: [pushSubscriptionId],
    headings: { en: title },
    contents: { en: body },
    data,
    existing_android_channel_id: ANDROID_CHANNEL_ID,
    collapse_id: digest.slice(0, 32),
    idempotency_key: uuidFromDigest(digest),
    ttl: PUSH_TTL_SECONDS,
    priority: 10,
});

/**
 * One transfer → one push. The text is already localized to the device's app
 * language, so it goes in `en`, which OneSignal shows for every device language.
 */
const buildTransferPayload = ({ appId, device, transfer }) => {
    const { title, body } = transferText(transfer, device.language);
    return basePayload({
        appId,
        pushSubscriptionId: device.pushSubscriptionId,
        title,
        body,
        data: transferData(transfer),
        digest: transferDigest(transfer.network, transfer.hash, device.pushSubscriptionId),
    });
};

/**
 * Flood control: the transfers past the individual quota become one push
 * ("Recibiste N transacciones nuevas"). Tapping it opens the newest one.
 */
const buildSummaryPayload = ({ appId, device, transfers }) => {
    const texts = TEXTS[pickLanguage(device.language)];
    const newest = transfers.reduce((latest, t) => (t.timestampMs >= latest.timestampMs ? t : latest), transfers[0]);
    return basePayload({
        appId,
        pushSubscriptionId: device.pushSubscriptionId,
        title: texts.title,
        body: texts.summary(transfers.length),
        data: {
            type: "tx_received",
            network: newest.network,
            ...transferData(newest),
            summary: "true",
            count: String(transfers.length),
        },
        digest: summaryDigest(transfers, device.pushSubscriptionId),
    });
};

module.exports = {
    transferData,
    ANDROID_CHANNEL_ID,
    PUSH_TTL_SECONDS,
    buildSummaryPayload,
    buildTransferPayload,
    pickLanguage,
    shortAddress,
    summaryDigest,
    transferDigest,
    transferText,
    uuidFromDigest,
};

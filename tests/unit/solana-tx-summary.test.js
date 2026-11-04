// Real mainnet transactions (trimmed). Before, every row was "0 SOL" with no direction and
// the apps showed "Recibido 0 SOL" even for a 10 ZNS referral reward.
const { summarizeParsedTransaction } = require("../../Repositories/Solana/modules/solana-tx-summary");

const fixture = (name) => require(`./fixtures/solana/${name}.json`);

const QA99 = "E5zQvcpuRdtcwZfRxBKHLgnUQRf6wCsYBf75Lix5upEG";
const ZNS_MINT = "GfF6PSkH8bKLkws5RMFdzgASwcVbgCfhhKfp8zeoFBkx";

describe("summarizeParsedTransaction", () => {
    it("shows a ZNS referral reward as +10 ZNS from the rewards wallet", () => {
        const summary = summarizeParsedTransaction(fixture("zns-reward-in"), QA99);

        expect(summary).toMatchObject({ traffic: "IN", amount: 10, asset: "ZNS", to: QA99, tokenMint: ZNS_MINT });
        expect(summary.from).toMatch(/^6CFZqP/);
    });

    it("reports a real zero-lamport transfer as 0 SOL received from the payer", () => {
        const summary = summarizeParsedTransaction(fixture("zero-sol-transfer"), QA99);

        expect(summary).toMatchObject({ traffic: "IN", amount: 0, asset: "SOL", to: QA99 });
        expect(summary.from).toMatch(/^ByT9nU/);
    });

    it("uses the token movement when the token account is created in the same transaction", () => {
        const owner = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
        const summary = summarizeParsedTransaction(fixture("spl-in-new-token-account"), owner);

        expect(summary).toMatchObject({ traffic: "IN", amount: 308, to: owner });
        expect(summary.tokenMint).toMatch(/^8Yt8jQ/);
        expect(summary.asset).toMatch(/…/); // unknown mint → shortened address
    });

    it("leaves the fee out of SOL sent by the fee payer", () => {
        const owner = "Owner1111111111111111111111111111111111111";
        const other = "Other1111111111111111111111111111111111111";
        const tx = {
            meta: { fee: 5000, preBalances: [2_000_000_000, 0], postBalances: [1_499_995_000, 500_000_000], preTokenBalances: [], postTokenBalances: [] },
            transaction: { message: { accountKeys: [{ pubkey: owner }, { pubkey: other }] } },
        };

        expect(summarizeParsedTransaction(tx, owner)).toEqual({ traffic: "OUT", amount: 0.5, asset: "SOL", from: owner, to: other });
        expect(summarizeParsedTransaction(tx, other)).toEqual({ traffic: "IN", amount: 0.5, asset: "SOL", from: owner, to: other });
    });

    it("returns null when the transaction or the owner is missing", () => {
        expect(summarizeParsedTransaction(null, QA99)).toBeNull();
        expect(summarizeParsedTransaction(fixture("zns-reward-in"), "")).toBeNull();
        expect(summarizeParsedTransaction(fixture("zero-sol-transfer"), "NotInThisTx111111111111111111111111111111")).toBeNull();
    });
});

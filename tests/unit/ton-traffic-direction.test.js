const { Address } = require("@ton/core");
const { mapEventsToTransactions } = require("../../Repositories/TON/modules/ton-scrapping.module");
const { sameTonAddress } = require("../../Repositories/TON/modules/ton-address.util");

const me = new Address(0, Buffer.alloc(32, 7));
const other = new Address(0, Buffer.alloc(32, 9));
const friendly = me.toString({ bounceable: false });
const ev = (sender, recipient) => ({
	event_id: "h", timestamp: 1700000000, lt: 1,
	actions: [{ type: "TonTransfer", TonTransfer: { sender: { address: sender }, recipient: { address: recipient }, amount: 1e9 } }],
});

describe("TON traffic direction (#556)", () => {
	test("raw vs friendly forms match", () => {
		expect(sameTonAddress(me.toRawString(), friendly)).toBe(true);
		expect(sameTonAddress(me.toRawString(), me.toString())).toBe(true);
		expect(sameTonAddress(other.toRawString(), friendly)).toBe(false);
		expect(sameTonAddress("", friendly)).toBe(false);
	});
	test("sent from raw sender is OUT, received is IN", () => {
		const [sent] = mapEventsToTransactions([ev(me.toRawString(), other.toRawString())], friendly);
		const [recv] = mapEventsToTransactions([ev(other.toRawString(), me.toRawString())], friendly);
		expect(sent.traffic).toBe("OUT");
		expect(recv.traffic).toBe("IN");
	});

	test("incoming scam-flagged events are dropped; the account's own sends never are", () => {
		const scam = (event) => ({ ...event, event_id: `${event.event_id}-scam`, is_scam: true });
		const out = mapEventsToTransactions(
			[scam(ev(other.toRawString(), me.toRawString())), scam(ev(me.toRawString(), other.toRawString())), ev(other.toRawString(), me.toRawString())],
			friendly
		);
		expect(out.map((t) => [t.hash, t.traffic])).toEqual([
			["h-scam", "OUT"],
			["h", "IN"],
		]);
	});
});

describe("qa99 send followed by a spam broadcast (#556, recorded from TonAPI)", () => {
	const { response, account, friendly: qa99 } = require("../fixtures/tx-notifications/ton-events-send-then-spam.json");
	const [spam, send] = response.events;

	test("fixture: the send is 01:52:15Z and the 0.00001 TON scam-flagged spam lands 24 s later", () => {
		expect(Address.parse(qa99).toRawString()).toBe(account);
		expect(send.timestamp).toBe(1791942735);
		expect(send.actions[0].TonTransfer.amount).toBe(887811953);
		expect(send.actions[0].TonTransfer.sender.address).toBe(account);
		expect(spam.timestamp - send.timestamp).toBe(24);
		expect(spam.is_scam).toBe(true);
		expect(spam.actions[0].TonTransfer.amount).toBe(10000);
		expect(spam.actions[0].TonTransfer.recipient.address).toBe(account);
	});

	test.each([
		["friendly EQ", qa99],
		["friendly UQ", Address.parse(qa99).toString({ bounceable: false })],
		["raw", account],
	])("history for the %s address shows only the send, as OUT", (_, address) => {
		const transactions = mapEventsToTransactions(response.events, address);
		expect(transactions).toHaveLength(1);
		expect(transactions[0]).toMatchObject({
			hash: send.event_id,
			traffic: "OUT",
			amount: "0.887812",
			asset: "TON",
			from: account,
			to: send.actions[0].TonTransfer.recipient.address,
		});
	});
});

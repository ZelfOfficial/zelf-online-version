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
});

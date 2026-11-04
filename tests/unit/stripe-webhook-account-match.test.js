/**
 * invoice.payment_succeeded on the shared Stripe account.
 * No Zelf source and no IPFS account → ignore (Verifik and any other non-Zelf invoice).
 * A Zelf source, a failed account lookup, or a failure while saving a matched account still throws.
 */
const mockSubscriptionsRetrieve = jest.fn();
const mockCustomersRetrieve = jest.fn();
const mockIpfsGet = jest.fn();
const mockSaveSubscriptionRecord = jest.fn();
const mockGrantZns = jest.fn();

jest.mock("stripe", () =>
	jest.fn().mockImplementation(() => ({
		subscriptions: { retrieve: mockSubscriptionsRetrieve },
		customers: { retrieve: mockCustomersRetrieve },
	}))
);

jest.mock("../../Repositories/IPFS/modules/ipfs.module", () => ({
	get: (...args) => mockIpfsGet(...args),
}));

jest.mock("../../Repositories/License/modules/license.module", () => ({
	saveSubscriptionRecord: (...args) => mockSaveSubscriptionRecord(...args),
}));

jest.mock("../../Repositories/SubscriptionPlan/modules/subscription-zns-grant.module", () => ({
	tryGrantMonthlyZnsForPaidInvoice: (...args) => mockGrantZns(...args),
}));

const { processWebhookEvent } = require("../../Repositories/Stripe/modules/stripe.module");

const invoiceEvent = (invoice, id = "evt_invoice_1") => ({
	id,
	object: "event",
	type: "invoice.payment_succeeded",
	data: { object: invoice },
});

const baseInvoice = {
	id: "in_1",
	subscription: "sub_1",
	customer: "cus_1",
	amount_paid: 499,
	currency: "usd",
	status_transitions: { paid_at: 1710000000 },
	metadata: {},
};

const subscriptionOf = (source) => ({
	id: "sub_1",
	metadata: source ? { source } : {},
	items: { data: [{ price: { id: "price_basic" } }] },
	current_period_start: 1710000000,
	current_period_end: 1712592000,
});

beforeEach(() => {
	jest.spyOn(console, "error").mockImplementation(() => {});
	jest.spyOn(console, "warn").mockImplementation(() => {});
	mockSubscriptionsRetrieve.mockReset();
	mockCustomersRetrieve.mockReset();
	mockIpfsGet.mockReset();
	mockSaveSubscriptionRecord.mockReset();
	mockGrantZns.mockReset();
	mockSubscriptionsRetrieve.mockResolvedValue(subscriptionOf(null));
	mockCustomersRetrieve.mockResolvedValue({ id: "cus_1", email: "billing@verifik.example" });
	mockGrantZns.mockResolvedValue({ skippedReason: "test" });
});

afterEach(() => jest.restoreAllMocks());

test("a non-Zelf invoice whose email matches no account is ignored", async () => {
	mockIpfsGet.mockResolvedValue([]);

	const result = await processWebhookEvent(invoiceEvent(baseInvoice));

	expect(result).toEqual({ ignored: true, reason: "account_not_found" });
	expect(mockIpfsGet).toHaveBeenCalledWith({
		key: "accountEmail",
		value: "billing@verifik.example",
		throwOnError: true,
	});
	expect(mockSaveSubscriptionRecord).not.toHaveBeenCalled();
	expect(mockGrantZns).not.toHaveBeenCalled();
});

test("an invoice with no email and no Zelf source is ignored without an account lookup", async () => {
	mockCustomersRetrieve.mockResolvedValue({ id: "cus_1", email: null });

	const result = await processWebhookEvent(invoiceEvent(baseInvoice, "evt_no_email"));

	expect(result).toEqual({ ignored: true, reason: "account_not_found" });
	expect(mockIpfsGet).not.toHaveBeenCalled();
});

test("a Zelf-sourced invoice that misses its account still fails so Stripe retries", async () => {
	mockSubscriptionsRetrieve.mockResolvedValue(subscriptionOf("dashboard"));
	mockCustomersRetrieve.mockResolvedValue({ id: "cus_1", email: "owner@zelf.example" });
	mockIpfsGet.mockResolvedValue([]);

	await expect(processWebhookEvent(invoiceEvent(baseInvoice, "evt_dashboard"))).rejects.toThrow("404:account_not_found");
	expect(mockSaveSubscriptionRecord).not.toHaveBeenCalled();
});

test("a failed account lookup still fails so Stripe retries", async () => {
	mockIpfsGet.mockRejectedValue(new Error("pinata_unavailable"));

	await expect(processWebhookEvent(invoiceEvent(baseInvoice, "evt_ipfs_down"))).rejects.toThrow("pinata_unavailable");
	expect(mockSaveSubscriptionRecord).not.toHaveBeenCalled();
});

test("a matched Zelf account is still saved", async () => {
	mockCustomersRetrieve.mockResolvedValue({ id: "cus_1", email: "owner@zelf.example" });
	mockIpfsGet.mockImplementation(async ({ key }) => {
		if (key === "accountEmail") return [{ id: "account-1" }];
		if (key === "licenseOwner") return [{ id: "license-1", url: "ipfs://license" }];
		return [];
	});
	mockSaveSubscriptionRecord.mockResolvedValue({ id: "subscription-record" });

	const result = await processWebhookEvent(invoiceEvent({ ...baseInvoice, metadata: {} }, "evt_zelf_invoice"));

	expect(result.status).toBe("success");
	expect(result.action).toBe("invoice_payment_succeeded");
	expect(mockSaveSubscriptionRecord).toHaveBeenCalledTimes(1);
	expect(mockSaveSubscriptionRecord.mock.calls[0][0]).toMatchObject({ id: "license-1" });
	expect(mockSaveSubscriptionRecord.mock.calls[0][1]).toMatchObject({
		invoiceId: "in_1",
		customerEmail: "owner@zelf.example",
	});
	expect(mockGrantZns).toHaveBeenCalledTimes(1);
});

test("a matched account that fails while saving still fails so Stripe retries", async () => {
	mockCustomersRetrieve.mockResolvedValue({ id: "cus_1", email: "owner@zelf.example" });
	mockIpfsGet.mockImplementation(async ({ key }) => (key === "accountEmail" ? [{ id: "account-1" }] : []));
	mockSaveSubscriptionRecord.mockRejectedValue(new Error("plan_not_found"));

	await expect(processWebhookEvent(invoiceEvent(baseInvoice, "evt_save_fail"))).rejects.toThrow("plan_not_found");
});

test("an event type the legacy handler does not implement stays unhandled", async () => {
	const result = await processWebhookEvent({
		id: "evt_other",
		type: "customer.created",
		data: { object: { id: "cus_x" } },
	});

	expect(result).toEqual({ status: "unhandled", eventType: "customer.created" });
	expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
});

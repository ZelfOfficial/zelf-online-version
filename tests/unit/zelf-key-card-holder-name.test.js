const { CARD_HOLDER_NAME_PATTERN, storeCreditCardValidation } = require("../../Repositories/ZelfKeys/middlewares/zelf-key.middleware");

const body = (cardName) => ({ cardName, cardNumber: "4111111111111111", expiryMonth: "12", expiryYear: "2099", cvv: "123", bankName: "Bank", faceBase64: "x" });
const run = async (cardName) => {
	const ctx = { request: { body: body(cardName) } };
	let passed = false;
	await storeCreditCardValidation(ctx, async () => { passed = true; });
	return passed;
};

describe("cardName (#574) matches the iOS/Android CardHolderName rule", () => {
	it.each([
		"Andrés Londoño", "María José Pérez", "O'Brien", "O\u2019Brien", "Jean-Luc", "Ana M. Pérez", "Müller",
		"Col\u00B7lell", "ジョン・スミス", "Иван Петров", "王小明", "محمد", "देवनागरी", "Jose\u0301", " Ana ", "Ana  Maria",
	])("accepts %p", async (n) => expect(await run(n)).toBe(true));

	it.each(["Andres123", "123456", "Maria@Perez", "-", ".", "   ", "", "Ana 😀", "A_B"])(
		"rejects %p", async (n) => expect(await run(n)).toBe(false));

	it("pattern exported", () => expect(CARD_HOLDER_NAME_PATTERN).toBeInstanceOf(RegExp));
});

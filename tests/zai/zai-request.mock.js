/** In-memory stand-in for the zai_requests Mongo model (create / findOne / findOneAndUpdate / updateOne). */
const store = new Map();
const matches = (doc, q) =>
    Object.entries(q).every(([k, v]) => {
        if (v && typeof v === "object" && "$gt" in v) return doc[k] > v.$gt;
        return doc[k] === v;
    });
const lean = (v) => ({ lean: async () => (v ? JSON.parse(JSON.stringify(v)) : null) });
module.exports = {
    __store: store,
    create: jest.fn(async (doc) => {
        if (store.has(doc.requestId)) throw new Error("duplicate");
        store.set(doc.requestId, { status: "pending", text: "", answeredAt: null, ...doc });
    }),
    findOne: jest.fn((q) => lean([...store.values()].find((d) => matches(d, q)))),
    findOneAndUpdate: jest.fn((q, u) => {
        const d = [...store.values()].find((x) => matches(x, q));
        if (d) Object.assign(d, u.$set);
        return lean(d);
    }),
    updateOne: jest.fn(async (q, u) => {
        const d = [...store.values()].find((x) => matches(x, q));
        if (d) Object.assign(d, u.$set);
        return { modifiedCount: d ? 1 : 0 };
    }),
};

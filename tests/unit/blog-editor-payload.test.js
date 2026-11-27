const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const BlogMiddleware = require("../../Repositories/Blogs/middlewares/blog.middleware");
const BlogModule = require("../../Repositories/Blogs/modules/blog.module");
const BlogModel = require("../../Repositories/Blogs/models/blog.model");

jest.setTimeout(120000);

const editorPayload = (overrides = {}) => ({
    slug: `editor-post-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: "How Zelf names work",
    description: "",
    author: "",
    date: "2026-11-27",
    markdownContent: "# Hello\n\nA post.",
    coverImage: "",
    imageAlt: "",
    caption: "",
    tags: ["wallet", "cat:security", "pillar:security"],
    categories: ["Security", "Wallets"],
    published: false,
    locale: "es",
    canonicalSlug: "",
    metaTitle: "",
    metaDescription: "",
    faqs: [
        { question: "What is a Zelf name?", answer: "A face-secured name for your wallet." },
        { question: "", answer: "" },
    ],
    ...overrides,
});

const runValidation = async (validation, body) => {
    const next = jest.fn();
    const ctx = { request: { body }, status: 200 };
    await validation(ctx, next);
    return { ctx, next };
};

describe("blog admin editor payload", () => {
    describe("strict validation", () => {
        test.each([
            ["create", BlogMiddleware.createValidation],
            ["update", BlogMiddleware.updateValidation],
        ])("%s accepts the full editor payload, including empty optional strings", async (_label, validation) => {
            const body = editorPayload();
            const { ctx, next } = await runValidation(validation, body);

            expect(next).toHaveBeenCalledTimes(1);
            expect(ctx.status).toBe(200);
            expect(ctx.request.body).toEqual(body);
        });

        test("update accepts a categories-only body", async () => {
            const { ctx, next } = await runValidation(BlogMiddleware.updateValidation, { categories: [] });

            expect(next).toHaveBeenCalledTimes(1);
            expect(ctx.status).toBe(200);
        });

        test("create still accepts a legacy payload that omits the editor fields", async () => {
            const { ctx, next } = await runValidation(BlogMiddleware.createValidation, {
                slug: "legacy-post",
                title: "Legacy",
                markdownContent: "body",
            });

            expect(next).toHaveBeenCalledTimes(1);
            expect(ctx.status).toBe(200);
        });

        test.each([
            ["create", BlogMiddleware.createValidation],
            ["update", BlogMiddleware.updateValidation],
        ])("%s still rejects unknown keys", async (_label, validation) => {
            const { ctx, next } = await runValidation(validation, {
                ...editorPayload(),
                _id: "507f1f77bcf86cd799439011",
                createdAt: "2020-01-01",
            });

            expect(next).not.toHaveBeenCalled();
            expect(ctx.status).toBe(409);
            expect(ctx.body.code).toBe("UNKNOWN_FIELD");
            expect(ctx.body.validationError).toContain('"createdAt" is not allowed');
        });

        test("create still rejects an empty required slug", async () => {
            const { ctx, next } = await runValidation(BlogMiddleware.createValidation, editorPayload({ slug: "" }));

            expect(next).not.toHaveBeenCalled();
            expect(ctx.status).toBe(409);
            expect(ctx.body.code).toBe("VALIDATION_ERROR");
        });

        test.each([
            ["categories is a string", { categories: "Security" }, "VALIDATION_ERROR"],
            ["categories contain an empty string", { categories: ["Security", ""] }, "VALIDATION_ERROR"],
            ["categories contain a non-string", { categories: ["Security", 1] }, "VALIDATION_ERROR"],
            ["faqs is not an array", { faqs: { question: "Q", answer: "A" } }, "VALIDATION_ERROR"],
            ["a faq is missing answer", { faqs: [{ question: "Q" }] }, "VALIDATION_ERROR"],
            ["a faq answer is not a string", { faqs: [{ question: "Q", answer: 1 }] }, "VALIDATION_ERROR"],
            ["a faq has an unknown key", { faqs: [{ question: "Q", answer: "A", extra: true }] }, "UNKNOWN_FIELD"],
            ["caption is not a string", { caption: 12 }, "VALIDATION_ERROR"],
            ["metaTitle is not a string", { metaTitle: ["title"] }, "VALIDATION_ERROR"],
            ["metaDescription is not a string", { metaDescription: { text: "x" } }, "VALIDATION_ERROR"],
        ])("create rejects an invalid editor field when %s", async (_label, overrides, code) => {
            const { ctx, next } = await runValidation(BlogMiddleware.createValidation, editorPayload(overrides));

            expect(next).not.toHaveBeenCalled();
            expect(ctx.status).toBe(409);
            expect(ctx.body.code).toBe(code);
        });

        test.each([
            ["categories is a string", { categories: "Security" }, "VALIDATION_ERROR"],
            ["a faq is missing question", { faqs: [{ answer: "A" }] }, "VALIDATION_ERROR"],
            ["a faq has an unknown key", { faqs: [{ question: "Q", answer: "A", extra: true }] }, "UNKNOWN_FIELD"],
            ["metaDescription is not a string", { metaDescription: 4 }, "VALIDATION_ERROR"],
        ])("update rejects an invalid editor field when %s", async (_label, overrides, code) => {
            const { ctx, next } = await runValidation(BlogMiddleware.updateValidation, overrides);

            expect(next).not.toHaveBeenCalled();
            expect(ctx.status).toBe(409);
            expect(ctx.body.code).toBe(code);
        });
    });

    describe("persistence", () => {
        let memory;

        beforeAll(async () => {
            memory = await MongoMemoryServer.create();
            if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
            await mongoose.connect(memory.getUri());
        });

        afterAll(async () => {
            await mongoose.disconnect();
            if (memory) await memory.stop();
        });

        afterEach(async () => {
            await BlogModel.deleteMany({});
        });

        test("create stores the full editor payload, including empty strings", async () => {
            const payload = editorPayload({
                caption: "",
                coverImage: "",
                canonicalSlug: "",
                metaTitle: "",
                metaDescription: "",
            });

            const created = await BlogModule.create(payload);
            const stored = await BlogModel.findById(created._id).lean();

            expect(stored.slug).toBe(payload.slug);
            expect(stored.title).toBe(payload.title);
            expect(stored.description).toBe("");
            expect(stored.author).toBe("");
            expect(stored.markdownContent).toBe(payload.markdownContent);
            expect(stored.coverImage).toBe("");
            expect(stored.imageAlt).toBe("");
            expect(stored.caption).toBe("");
            expect(stored.tags).toEqual(payload.tags);
            expect(stored.categories).toEqual(["Security", "Wallets"]);
            expect(stored.published).toBe(false);
            expect(stored.locale).toBe("es");
            expect(stored.canonicalSlug).toBe("");
            expect(stored.metaTitle).toBe("");
            expect(stored.metaDescription).toBe("");
            expect(stored.faqs).toEqual(payload.faqs);
            expect(stored.date).toBeInstanceOf(Date);

            const shown = await BlogModule.show({ slug: payload.slug, where_locale: "es" });
            expect(shown.categories).toEqual(["Security", "Wallets"]);
            expect(shown.faqs).toHaveLength(2);
            expect(shown.caption).toBe("");
        });

        test("update replaces editor fields and can clear them back to empty", async () => {
            const created = await BlogModule.create(
                editorPayload({
                    description: "First excerpt",
                    author: "Ada",
                    coverImage: "https://zelf.world/images/blog/cover.png",
                    imageAlt: "Cover",
                    caption: "A caption",
                    canonicalSlug: "how-zelf-names-work",
                    metaTitle: "Meta title",
                    metaDescription: "Meta description",
                    categories: ["Security"],
                    faqs: [{ question: "Old?", answer: "Old." }],
                })
            );

            const updated = await BlogModule.update({
                id: created._id,
                title: "Updated title",
                description: "",
                author: "",
                coverImage: "",
                imageAlt: "",
                caption: "",
                canonicalSlug: "",
                metaTitle: "",
                metaDescription: "",
                categories: ["Wallets", "Payments"],
                faqs: [{ question: "New?", answer: "New." }],
                published: true,
            });

            const stored = await BlogModel.findById(updated._id).lean();
            expect(stored.title).toBe("Updated title");
            expect(stored.slug).toBe(created.slug);
            expect(stored.markdownContent).toBe(created.markdownContent);
            expect(stored.description).toBe("");
            expect(stored.author).toBe("");
            expect(stored.coverImage).toBe("");
            expect(stored.imageAlt).toBe("");
            expect(stored.caption).toBe("");
            expect(stored.canonicalSlug).toBe("");
            expect(stored.metaTitle).toBe("");
            expect(stored.metaDescription).toBe("");
            expect(stored.categories).toEqual(["Wallets", "Payments"]);
            expect(stored.faqs).toEqual([{ question: "New?", answer: "New." }]);
            expect(stored.published).toBe(true);
        });

        test("a categories-only update leaves the rest of the post in place", async () => {
            const payload = editorPayload({
                caption: "Keep me",
                metaTitle: "Keep title",
                faqs: [{ question: "Stay?", answer: "Yes." }],
            });
            const created = await BlogModule.create(payload);

            await BlogModule.update({ id: created._id, categories: ["Payments"] });

            const stored = await BlogModel.findById(created._id).lean();
            expect(stored.categories).toEqual(["Payments"]);
            expect(stored.caption).toBe("Keep me");
            expect(stored.metaTitle).toBe("Keep title");
            expect(stored.faqs).toEqual([{ question: "Stay?", answer: "Yes." }]);
            expect(stored.markdownContent).toBe(payload.markdownContent);
            expect(stored.slug).toBe(payload.slug);
        });

        test("a legacy post can be read and later updated with editor fields", async () => {
            const legacy = await BlogModule.create({
                slug: `legacy-${Date.now()}`,
                title: "Legacy post",
                markdownContent: "Original body",
                published: true,
            });

            const read = await BlogModule.show({ id: legacy._id });
            expect(read.title).toBe("Legacy post");
            expect(read.markdownContent).toBe("Original body");

            const storedLegacy = await BlogModel.findById(legacy._id).lean();
            expect(storedLegacy.caption).toBeUndefined();
            expect(storedLegacy.categories).toBeUndefined();
            expect(storedLegacy.faqs).toBeUndefined();
            expect(storedLegacy.metaTitle).toBeUndefined();

            const updated = await BlogModule.update({
                id: legacy._id,
                caption: "Added later",
                categories: ["Security"],
                metaTitle: "SEO title",
                metaDescription: "SEO description",
                faqs: [{ question: "Added?", answer: "Yes." }],
            });

            expect(updated.markdownContent).toBe("Original body");
            expect(updated.caption).toBe("Added later");
            expect(updated.categories).toEqual(["Security"]);
            expect(updated.metaTitle).toBe("SEO title");
            expect(updated.metaDescription).toBe("SEO description");
            expect(updated.faqs.map((faq) => ({ question: faq.question, answer: faq.answer }))).toEqual([
                { question: "Added?", answer: "Yes." },
            ]);
        });
    });
});

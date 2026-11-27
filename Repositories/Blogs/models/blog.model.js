const mongoose = require("mongoose");
const { String, Number, Boolean, Date, Array } = mongoose.Schema.Types;
const { requiredField, defaultField, addBasicPlugins } = require("../../../Core/mongoose-utils");

const Schema = mongoose.Schema;

const BlogSchema = new Schema({
    slug: { ...requiredField(String) },
    title: requiredField(String),
    description: { type: String, required: false },
    author: { type: String, required: false },
    date: defaultField(Date, Date.now),
    markdownContent: requiredField(String),
    coverImage: { type: String, required: false },
    imageAlt: { type: String, required: false },
    caption: { type: String, required: false },
    tags: [
        {
            type: String,
        },
    ],
    categories: {
        type: [{ type: String }],
        default: undefined,
    },
    published: defaultField(Boolean, true),
    canonicalSlug: { type: String, required: false },
    locale: defaultField(String, "en"),
    metaTitle: { type: String, required: false },
    metaDescription: { type: String, required: false },
    faqs: {
        type: [
            {
                _id: false,
                question: { type: String, required: false },
                answer: { type: String, required: false },
            },
        ],
        default: undefined,
    },
});

// Compound index for slug and locale mapping (since multiple locales might share same slug base or translations)
BlogSchema.index({ slug: 1, locale: 1 }, { unique: true });

BlogSchema.pre("save", async (next) => {
    next();
});

BlogSchema.post("save", async (next) => {});

BlogSchema.methods = {};

addBasicPlugins(BlogSchema);

const Blog = mongoose.model("Blog", BlogSchema);

module.exports = Blog;

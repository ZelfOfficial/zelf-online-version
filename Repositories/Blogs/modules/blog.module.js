const Model = require("../models/blog.model");

const BLOG_WRITABLE_FIELDS = [
    "slug",
    "title",
    "description",
    "author",
    "date",
    "markdownContent",
    "coverImage",
    "imageAlt",
    "tags",
    "published",
    "canonicalSlug",
    "locale",
];

const pickWritable = (data = {}) => {
    const out = {};
    for (const key of BLOG_WRITABLE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = data[key];
    }
    return out;
};

function _truthy(v) {
    return v === true || v === "true" || v === 1 || v === "1";
}

/**
 * Build Mongo filter for GET /blogs.
 * MongoORM `where_locale` / `where_published` are exact-match; imported or legacy docs often omit `locale`
 * (schema default is en) or store loose values, which made listings empty while Compass still showed rows.
 */
function buildBlogListFilter(params = {}) {
    const filter = {};
    const and = [];

    const includeDrafts = _truthy(params.includeDrafts);
    const explicitPublished = params.where_published !== undefined && params.where_published !== "";

    let pubClause = null;
    if (!includeDrafts && !explicitPublished) {
        /** Public list: exclude only explicit drafts (boolean/string 0). Omit missing/unusual legacy shapes — Compass counts ≠ matched-by-this-query rows if almost everything is draft:false. */
        pubClause = {
            $nor: [{ published: false }, { published: "false" }, { published: 0 }, { published: "0" }],
        };
    } else if (explicitPublished) {
        pubClause = _truthy(params.where_published) ? { $or: [{ published: true }, { published: "true" }] } : { published: false };
    }

    if (pubClause) {
        and.push(pubClause);
    }

    const loc = params.where_locale;
    if (loc === "en") {
        and.push({
            $or: [{ locale: "en" }, { locale: { $exists: false } }, { locale: null }, { locale: "" }],
        });
    } else if (loc) {
        filter.locale = loc;
    }

    const canonical = typeof params.where_canonicalSlug === "string" ? params.where_canonicalSlug.trim() : "";
    if (canonical) {
        and.push({ canonicalSlug: canonical });
    }

    if (and.length) {
        filter.$and = and;
    }

    return filter;
}

const get = async (params = {}, authUser = {}) => {
    const mongoFilter = buildBlogListFilter(params);

    let q = Model.find(mongoFilter).sort(params.sort || "-createdAt");

    const canonicalLookup = typeof params.where_canonicalSlug === "string" ? params.where_canonicalSlug.trim() : "";

    if (canonicalLookup) {
        q = q.select("slug locale canonicalSlug published createdAt").lean();
    }

    if (params.limit) {
        q = q.limit(Number(params.limit));
    }

    return q.exec();
};

const show = async (params = {}, authUser = {}) => {
    if (params.id || params._id) {
        return await Model.findById(params.id || params._id);
    }

    const slug = params.slug || params.where_slug;

    let localeFilter = params.where_locale;
    if (localeFilter === undefined || localeFilter === "") {
        localeFilter = params.locale !== undefined && params.locale !== "" ? params.locale : undefined;
    }

    /** Match GET /blogs/:slug?where_locale=en to legacy rows (missing/null/empty locale), same as buildBlogListFilter. */
    const clauses = [];
    if (slug) {
        clauses.push({ slug });
    }
    if (localeFilter === "en") {
        clauses.push({
            $or: [{ locale: "en" }, { locale: { $exists: false } }, { locale: null }, { locale: "" }],
        });
    } else if (localeFilter) {
        clauses.push({ locale: localeFilter });
    }

    const query = clauses.length === 0 ? {} : clauses.length === 1 ? clauses[0] : { $and: clauses };

    return await Model.findOne(query);
};

const create = async (data, authUser) => {
    const blog = new Model(pickWritable(data));
    await blog.save();
    return blog;
};

const update = async (data, authUser) => {
    const identifier = data.id || data._id;

    const blog = await Model.findById(identifier);
    if (!blog) throw new Error("404");

    Object.assign(blog, pickWritable(data));

    await blog.save();

    return blog;
};

const destroy = async (params, authUser) => {
    const identifier = params.id || params._id;
    const blog = await Model.findById(identifier);
    if (!blog) throw new Error("404");

    await blog.deleteOne();
    return { success: true };
};

module.exports = {
    get,
    show,
    create,
    update,
    destroy,
    BLOG_WRITABLE_FIELDS,
    pickWritable,
};

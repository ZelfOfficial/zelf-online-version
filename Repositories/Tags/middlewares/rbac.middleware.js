const { BLOCKED_PRIVILEGE_TYPES, TOKEN_TYPES } = require("../../../Core/jwt-claims");

const deny = (ctx, code) => {
    ctx.status = 403;
    ctx.body = { error: code, code };
};

const isStaffToken = (user) => {
    if (!user) return false;
    if (user.typ === TOKEN_TYPES.staff) return true;
    const accountType = user.accountType || "";
    return !user.typ && Number.isFinite(user.exp) && (accountType === "staff" || accountType === "staff_account");
};

const isOwnerToken = (user) => {
    if (!user || isStaffToken(user)) return false;
    if (BLOCKED_PRIVILEGE_TYPES.has(user.typ)) return false;
    if (user.typ === TOKEN_TYPES.client || user.typ === TOKEN_TYPES.lawyer || user.typ === TOKEN_TYPES.session || user.typ === TOKEN_TYPES.duration) {
        return true;
    }
    return !user.typ && Number.isFinite(user.exp);
};

const requireAdmin = async (ctx, next) => {
    const user = ctx.state.user;
    if (!user) {
        ctx.status = 401;
        ctx.body = { error: "UNAUTHORIZED", code: "UNAUTHORIZED" };
        return;
    }

    if (BLOCKED_PRIVILEGE_TYPES.has(user.typ)) {
        deny(ctx, "INVALID_TOKEN_TYPE");
        return;
    }

    if (isStaffToken(user)) {
        const role = user.role || "read";
        if (role === "admin") {
            await next();
            return;
        }
        deny(ctx, "ADMIN_ACCESS_REQUIRED");
        return;
    }

    if (isOwnerToken(user) && user.typ !== TOKEN_TYPES.session && user.typ !== TOKEN_TYPES.duration) {
        await next();
        return;
    }

    deny(ctx, "ADMIN_ACCESS_REQUIRED");
};

const requireWrite = async (ctx, next) => {
    const user = ctx.state.user;
    if (!user) {
        ctx.status = 401;
        ctx.body = { error: "UNAUTHORIZED", code: "UNAUTHORIZED" };
        return;
    }

    if (BLOCKED_PRIVILEGE_TYPES.has(user.typ)) {
        deny(ctx, "INVALID_TOKEN_TYPE");
        return;
    }

    if (isStaffToken(user)) {
        const role = user.role || "read";
        if (role === "admin" || role === "write") {
            await next();
            return;
        }
        deny(ctx, "WRITE_ACCESS_REQUIRED");
        return;
    }

    if (isOwnerToken(user)) {
        await next();
        return;
    }

    deny(ctx, "WRITE_ACCESS_REQUIRED");
};

module.exports = {
    requireAdmin,
    requireWrite,
};

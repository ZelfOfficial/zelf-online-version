const Model = require("../models/super-admin.model");
const MongoORM = require("../../../Core/mongo-orm");
const crypto = require("crypto");
const config = require("../../../Core/config");
const { signToken, TOKEN_TYPES, SUPER_ADMIN_ROLES, normalizeSuperAdminRole } = require("../../../Core/jwt-claims");
const moment = require("moment");
const Mailgun = require("../../../Core/mailgun");

const OTP_MAX_ATTEMPTS = 5;
const SUPER_ADMIN_TOKEN_HOURS = 12;

const SENSITIVE_FIELDS = ["apiKey", "otp", "otpExpiration", "otpAttempts", "secretKey", "JWTPhrase"];

const sanitizeSuperAdmin = (record) => {
    if (!record) return record;
    const raw = typeof record.toObject === "function" ? record.toObject() : { ...(record._doc || record) };
    for (const key of SENSITIVE_FIELDS) {
        delete raw[key];
    }
    return raw;
};

const isInactive = (superAdmin) => {
    if (!superAdmin) return true;
    return superAdmin.disabled === true || superAdmin.active === false || superAdmin.status === "banned" || superAdmin.status === "inactive";
};

const generateOtp = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

const authError = (status, code) => {
    const error = new Error(code);
    error.status = status;
    error.code = code;
    return error;
};

const resolveIssuedRole = (superAdmin, requestedRole) => {
    const adminRole = normalizeSuperAdminRole(superAdmin?.role);
    const reqRole = requestedRole ? normalizeSuperAdminRole(requestedRole) : adminRole;
    if (adminRole === SUPER_ADMIN_ROLES.blog || reqRole === SUPER_ADMIN_ROLES.blog) {
        return SUPER_ADMIN_ROLES.blog;
    }
    return SUPER_ADMIN_ROLES.superAdmin;
};

const signSuperAdminToken = (superAdmin, options = {}) => {
    const role = resolveIssuedRole(superAdmin, options.role || options.scope);
    return signToken(
        {
            tokenVersion: Number(superAdmin.tokenVersion || 0),
            role,
            exp: moment().add(SUPER_ADMIN_TOKEN_HOURS, "hours").unix(),
        },
        config.JWT_SECRET,
        {
            typ: TOKEN_TYPES.superAdmin,
            superAdminId: superAdmin._id,
            role,
        }
    );
};

const get = async (params = {}, authUser = {}, options = {}) => {
    const queryParams = {
        ...params,
    };

    const result = await MongoORM.buildQuery(queryParams, Model, null, []);
    if (options.raw) return result;
    if (Array.isArray(result)) return result.map(sanitizeSuperAdmin);
    if (result && Array.isArray(result.docs)) {
        return { ...result, docs: result.docs.map(sanitizeSuperAdmin) };
    }
    return sanitizeSuperAdmin(result);
};

const show = async (params = {}, authUser = {}) => {
    let queryParams = {
        findOne: true,
        ...params,
    };

    if (params.id || params._id) {
        queryParams.where__id = params.id || params._id;
    }

    if (authUser?.superAdminId) {
        queryParams.where__id = authUser.superAdminId;
    }

    const result = await MongoORM.buildQuery(queryParams, Model, null, []);
    return sanitizeSuperAdmin(result);
};

const create = async (data, authUser) => {
    const apiKey = `su_${crypto.randomBytes(12).toString("hex").slice(0, 24)}`;

    const superAdmin = new Model({
        name: data.name || "NA",
        status: data.status || "joined",
        role: normalizeSuperAdminRole(data.role),
        avatar: data.avatar || null,
        countryCode: data.countryCode,
        phone: data.phone,
        email: data.email,
        active: true,
        apiKey,
    });

    await superAdmin.save();

    return {
        ...sanitizeSuperAdmin(superAdmin),
        apiKey,
    };
};

const update = async (data, authUser) => {};

const destroy = async (data, authUser) => {};

const auth = async (data, authUser) => {
    const { apiKey, email } = data;

    const superAdmin = await get(
        {
            where_email: email,
            findOne: true,
        },
        {},
        { raw: true }
    );

    if (!superAdmin) throw authError(404, "SUPER_ADMIN_NOT_FOUND");

    if (isInactive(superAdmin)) {
        throw authError(403, "SUPER_ADMIN_INACTIVE");
    }

    const isKeyValid = await superAdmin.isValidApiKey(apiKey);

    if (!isKeyValid) throw authError(403, "SUPER_ADMIN_FORBIDDEN");

    const role = resolveIssuedRole(superAdmin, data.role || data.scope);

    return {
        token: signSuperAdminToken(superAdmin, { role }),
        role,
    };
};

const requestOtp = async (data) => {
    const { email } = data;

    const superAdmin = await get(
        {
            where_email: email,
            findOne: true,
        },
        {},
        { raw: true }
    );

    if (!superAdmin || isInactive(superAdmin)) {
        // Do not leak existence, just return success
        return { message: "If this email is a super admin, an OTP has been sent." };
    }

    const otp = generateOtp();

    superAdmin.otp = otp;

    superAdmin.otpExpiration = moment().add(15, "minutes").toDate();

    superAdmin.otpAttempts = 0;

    await superAdmin.save();

    await Mailgun.sendCustomEmail(
        email,
        "otp",
        {
            subject: "Zelf Super Admin - Your Login Code",
            message: `Use the code below to sign in to your admin account. It will expire in 15 minutes.`,
            otp,
            authLink: "",
            do_not_share: "Please do not share this code with anyone.",
            did_not_request: "If you didn't request this code, you can safely ignore this email.",
            verifikSigned: false,
        },
        "en"
    );

    return { message: "If this email is a super admin, an OTP has been sent." };
};

const verifyOtp = async (data) => {
    const { email, code } = data;

    const superAdmin = await get(
        {
            where_email: email,
            findOne: true,
        },
        {},
        { raw: true }
    );

    if (!superAdmin) throw authError(401, "INVALID_EMAIL_OR_CODE");

    if (isInactive(superAdmin)) {
        superAdmin.otp = undefined;
        superAdmin.otpExpiration = undefined;
        superAdmin.otpAttempts = 0;
        await superAdmin.save();
        throw authError(403, "SUPER_ADMIN_INACTIVE");
    }

    if (!superAdmin.otp || !superAdmin.otpExpiration) throw authError(401, "INVALID_EMAIL_OR_CODE");

    if (moment().isAfter(moment(superAdmin.otpExpiration))) {
        throw authError(401, "CODE_EXPIRED");
    }

    const isMatch = await new Promise((resolve) => {
        superAdmin.compareOTP(code, (err, match) => {
            if (err) resolve(false);
            resolve(match);
        });
    });

    if (!isMatch) {
        superAdmin.otpAttempts = Number(superAdmin.otpAttempts || 0) + 1;

        if (superAdmin.otpAttempts >= OTP_MAX_ATTEMPTS) {
            superAdmin.otp = undefined;
            superAdmin.otpExpiration = undefined;
            superAdmin.otpAttempts = 0;
            await superAdmin.save();
            throw authError(401, "OTP_ATTEMPTS_EXCEEDED");
        }

        await superAdmin.save();
        throw authError(401, "INVALID_EMAIL_OR_CODE");
    }

    superAdmin.otp = undefined;
    superAdmin.otpExpiration = undefined;
    superAdmin.otpAttempts = 0;
    await superAdmin.save();

    const role = resolveIssuedRole(superAdmin, data.role || data.scope);

    return {
        token: signSuperAdminToken(superAdmin, { role }),
        role,
    };
};

module.exports = {
    get,
    show,
    create,
    update,
    destroy,
    auth,
    requestOtp,
    verifyOtp,
    signSuperAdminToken,
    resolveIssuedRole,
    sanitizeSuperAdmin,
    OTP_MAX_ATTEMPTS,
    SUPER_ADMIN_TOKEN_HOURS,
};

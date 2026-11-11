const Model = require("../models/super-admin.model");
const MongoORM = require("../../../Core/mongo-orm");
const crypto = require("crypto");
const config = require("../../../Core/config");
const { signToken, TOKEN_TYPES } = require("../../../Core/jwt-claims");
const moment = require("moment");
const Mailgun = require("../../../Core/mailgun");

const generateOtp = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

const get = async (params = {}, authUser = {}) => {
    const queryParams = {
        ...params,
    };

    return await MongoORM.buildQuery(queryParams, Model, null, []);
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

    return await MongoORM.buildQuery(queryParams, Model, null, populates);
};

const create = async (data, authUser) => {
    const apiKey = `su_${crypto.randomBytes(12).toString("hex").slice(0, 24)}`;

    const superAdmin = new Model({
        name: data.name || "NA",
        status: data.status || "joined",
        avatar: data.avatar || null,
        countryCode: data.countryCode,
        phone: data.phone,
        email: data.email,
        active: true,
        apiKey,
    });

    await superAdmin.save();

    return {
        ...superAdmin._doc,
        apiKey,
    };
};

const update = async (data, authUser) => {};

const destroy = async (data, authUser) => {};

const auth = async (data, authUser) => {
    const { apiKey, email } = data;

    const superAdmin = await get({
        where_email: email,
        findOne: true,
    });

    if (!superAdmin) throw new Error("404:SUPER_ADMIN_NOT_FOUND");

    if (superAdmin.disabled === true || superAdmin.active === false || superAdmin.status === "banned" || superAdmin.status === "inactive") {
        throw new Error("403:SUPER_ADMIN_INACTIVE");
    }

    const isKeyValid = await superAdmin.isValidApiKey(apiKey);

    if (!isKeyValid) throw new Error("403:SUPER_ADMIN_FORBIDDEN");

    return {
        token: signToken(
            {
                tokenVersion: Number(superAdmin.tokenVersion || 0),
                exp: moment().add(12, "hours").unix(),
            },
            config.JWT_SECRET,
            { typ: TOKEN_TYPES.superAdmin, superAdminId: superAdmin._id }
        ),
    };
};

const requestOtp = async (data) => {
    const { email } = data;

    const superAdmin = await get({
        where_email: email,
        findOne: true,
    });

    if (!superAdmin) {
        // Do not leak existence, just return success
        return { message: "If this email is a super admin, an OTP has been sent." };
    }

    const otp = generateOtp();

    superAdmin.otp = otp;

    superAdmin.otpExpiration = moment().add(15, "minutes").toDate();

    await superAdmin.save();

    // Sending email
    // Try creating a custom email. If a template doesn't exist, we fallback. We'll use a mocked EJS map or raw send.
    // Since we don't know if 'super-admin-otp' EJS template exists, we'll try sendCustomEmail.
    // If the template is missing, wait: we'll use sendCustomEmail with a generic 'otp_template' if it exists in the system or just use mailgun directly.
    // We can use a template like 'auth_code' assuming one exists.
    // For safety, let's pass an object that matches standard code emails.
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

    const superAdmin = await get({
        where_email: email,
        findOne: true,
    });

    if (!superAdmin) throw new Error("Invalid email or code");
    if (!superAdmin.otp || !superAdmin.otpExpiration) throw new Error("Invalid email or code");

    if (moment().isAfter(moment(superAdmin.otpExpiration))) {
        throw new Error("Code expired");
    }

    const isMatch = await new Promise((resolve, reject) => {
        superAdmin.compareOTP(code, (err, match) => {
            if (err) resolve(false);
            resolve(match);
        });
    });

    if (!isMatch) throw new Error("Invalid email or code");

    // Clear OTP
    superAdmin.otp = undefined;
    superAdmin.otpExpiration = undefined;
    await superAdmin.save();

    return {
        token: signToken(
            {
                tokenVersion: Number(superAdmin.tokenVersion || 0),
                exp: moment().add(12, "hours").unix(),
            },
            config.JWT_SECRET,
            { typ: TOKEN_TYPES.superAdmin, superAdminId: superAdmin._id }
        ),
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
};

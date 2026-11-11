const mongoose = require("mongoose");

const mongooseStringQuery = require("mongoose-string-query");

const timestamps = require("mongoose-timestamp");

const bcrypt = require("bcrypt-nodejs");

const SALT_WORK_FACTOR = 10;

const Schema = mongoose.Schema;

const { ObjectId, Date, Number, String, Boolean } = Schema.Types;

//####################################################//
const { requiredEnumField, optionalEnumField, requiredField, refField, defaultField } = require("../../../Core/mongoose-utils");

const SuperAdminSchema = new Schema({
    name: requiredField(String),
    status: requiredEnumField(String, ["invited", "joined", "banned", "inactive"], "joined"),
    avatar: defaultField(String, null),
    countryCode: {
        type: String,
        required: false,
    },
    phone: {
        type: String,
        required: false,
        unique: true,
        index: {
            unique: true,
        },
    },
    email: {
        type: String,
        required: true,
        unique: true,
        index: {
            unique: true,
        },
    },
    active: {
        type: Boolean,
        required: true,
        default: true,
    },
    disabled: {
        type: Boolean,
        required: true,
        default: false,
    },
    tokenVersion: {
        type: Number,
        required: true,
        default: 0,
    },
    tokensValidAfter: {
        type: Date,
        required: false,
    },
    isVerified: defaultField(Boolean, false),
    notes: {
        type: Schema.Types.String,
        required: false,
    },
    JWTPhrase: {
        type: String,
        required: false,
    },
    secretKey: {
        type: String,
        required: false,
        default: null,
    },
    language: {
        type: String,
        required: true,
        default: "en",
    },
    apiKey: {
        type: String,
        required: true,
        default: null,
    },
    otp: {
        type: String,
        required: false,
    },
    otpExpiration: {
        type: Date,
        required: false,
    },
    otpAttempts: {
        type: Number,
        required: true,
        default: 0,
    },
});

SuperAdminSchema.pre("save", async function (next) {
    let user = this;
    // only hash the password if it has been modified (or is new)
    if (!user.isModified("apiKey") && !user.isModified("otp")) return next();

    if (user.isModified("apiKey")) {
        // generate a salt
        bcrypt.genSalt(SALT_WORK_FACTOR, apiKeyEncrypted);

        function apiKeyEncrypted(err, salt) {
            if (err) return next("Error encrypting the password => ", err);
            // hash the apiKey using our new salt
            bcrypt.hash(
                user.apiKey,
                salt,
                function (error, progress) {},
                function (err, hash) {
                    if (err) return next(err);

                    user.apiKey = hash;

                    // Now process OTP if modified
                    if (user.isModified("otp") && user.otp) {
                        bcrypt.genSalt(SALT_WORK_FACTOR, function (err, otpSalt) {
                            if (err) return next(err);
                            bcrypt.hash(
                                user.otp,
                                otpSalt,
                                function (error, p) {},
                                function (err, otpHash) {
                                    if (err) return next(err);
                                    user.otp = otpHash;
                                    next();
                                }
                            );
                        });
                    } else {
                        next();
                    }
                }
            );
        }
    } else if (user.isModified("otp") && user.otp) {
        bcrypt.genSalt(SALT_WORK_FACTOR, function (err, salt) {
            if (err) return next(err);
            bcrypt.hash(
                user.otp,
                salt,
                function (error, p) {},
                function (err, hash) {
                    if (err) return next(err);
                    user.otp = hash;
                    next();
                }
            );
        });
    } else {
        next();
    }
});

// Method to compare a provided API key with the stored hash
const isValidApiKey = async function (apiKey) {
    return await new Promise((resolve, reject) => {
        bcrypt.compare(apiKey, this.apiKey, function (err, isValid) {
            if (err) return reject(err);

            return resolve(isValid);
        });
    });
};

/**
 * @method comparing password to authenticate user
 * @param {string} candidatePassword
 * @param {function} callback
 */
function comparePassword(candidatePassword, callback) {
    bcrypt.compare(candidatePassword, this.password, function (err, isMatch) {
        if (err) return callback(err);

        callback(null, isMatch);
    });
}

/**
 * #model methods
 */
SuperAdminSchema.methods = {
    comparePassword,
    compareOTP,
    isValidApiKey,
};

/**
 * @method comparing password to authenticate user
 * @param {string} incomingOTP
 * @param {function} callback
 */
function compareOTP(incomingOTP, callback) {
    bcrypt.compare(incomingOTP, this.otp, function (err, isMatch) {
        if (err) return callback(err);

        callback(null, isMatch);
    });
}

SuperAdminSchema.plugin(timestamps);

SuperAdminSchema.plugin(mongooseStringQuery);

const SuperAdmin = mongoose.model("SuperAdmin", SuperAdminSchema);

module.exports = SuperAdmin;

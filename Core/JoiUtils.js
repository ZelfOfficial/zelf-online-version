const JoiDate = require("@joi/date");
const Joi = require("joi").extend(JoiDate);

const recordShow = ["10", "25", "50", "100"];

const crypto = ["ETH", "SOL", "BTC", "CB"];

const zelfNameDuration = ["1"]; //, "2", "3", "4", "5", "lifetime"

const base64ImageRegExp = /^data:image\/(png|jpeg|jpg|gif|bmp);base64,([A-Za-z0-9+/=]+)$/;

const _customErrors = (errors) => {
    errors.forEach((err) => {
        switch (err.code) {
            case "forbidden":
                err.message = `forbidden ${err.local.key}\n`;

                break;
            case "alternatives.match":
                err.message = `invalid ${err.local.key}\n`;

                break;
            case "any.required":
                err.message = `missing ${err.local.key}\n`;

                break;
            case "string.empty":
                err.message = `missing ${err.local.key}\n`;

                break;
            case "date.format":
                err.message = `${err.local.key} format required: ${err.local.format}\n`;

                break;
            case "number.min":
                err.message = `${err.local.key} minimun is: ${err.local.limit}\n`;

                break;
            case "number.max":
                err.message = `${err.local.key} maximum is: ${err.local.limit}\n`;

                break;
            case "string.min":
                err.message = `${err.local.key} minimun length: ${err.local.limit}\n`;

                break;
            case "string.max":
                err.message = `${err.local.key} maximum length: ${err.local.limit}\n`;

                break;
            case "string.regex":
            case "object.regex":
            case "string.pattern.base":
                err.message = `Format incorrect: ${err.local.key}`;

                break;
            case "any.only":
                err.message = `${err.local.key} must be one of: [${err.local.valids.join(",")}]`;

                break;
            default:
                // console.error(err);
                break;
        }
    });

    return errors;
};

const array = () => Joi.array().error(_customErrors);
/** JSON-RPC 2.0 `params` may be an array or an object; omit or null becomes []. */
const jsonRpcParams = () =>
    Joi.alternatives()
        .try(Joi.array(), Joi.object())
        .optional()
        .allow(null)
        .default([])
        .error(_customErrors);
const any = () => Joi.any().error(_customErrors);
const boolean = () => Joi.boolean().error(_customErrors);
const dateOfBirth = () => Joi.date().raw().format("DD/MM/YYYY").error(_customErrors);
const dateWithFormat = () => Joi.date().raw().format("DD/MM/YYYY").error(_customErrors);
const firstName = () => Joi.string().min(2).error(_customErrors);
const forbidden = () => Joi.forbidden().error(_customErrors);
const imageBase64WithType = () => Joi.string().regex(base64ImageRegExp).error(_customErrors);
const lastName = () => Joi.string().min(2).error(_customErrors);
const line = () => Joi.string().min(1).error(_customErrors);
const manufacturer = () => Joi.string().min(1).error(_customErrors);
const model = () => Joi.string().min(1).error(_customErrors);
const number = () => Joi.number().error(_customErrors);
const minMaxNumber = (min, max) => Joi.number().min(min).max(max).error(_customErrors);
const object = (schema) => Joi.object(schema);
const objectId = () => Joi.string().hex().length(24).error(_customErrors);
const string = () => Joi.string().error(_customErrors);
const stringOrNumber = () => Joi.alternatives().try(Joi.string(), Joi.number());
const symbol = () => Joi.string().min(1).error(_customErrors);
const email = () => Joi.string().email().error(_customErrors);

const zelfNameDuration_ = () =>
    Joi.string()
        .valid(...zelfNameDuration)
        .error(_customErrors);

const crypto_ = () =>
    Joi.string()
        .valid(...crypto)
        .error(_customErrors);

const province = () =>
    Joi.string()
        .valid(...provinceCA)
        .error(_customErrors);

const showRecords = () =>
    Joi.string()
        .valid(...recordShow)
        .error(_customErrors);

const stringEnum = (enumArray) =>
    Joi.string()
        .valid(...enumArray)
        .error(_customErrors);

const urlSecure = () =>
    Joi.string()
        .uri({
            scheme: ["https"],
            allowQuerySquareBrackets: true,
        })
        .error(_customErrors);

const validate = (schemaObj, params, or = undefined) => {
    let schema = Joi.object(schemaObj)
        .options({
            abortEarly: false,
        })
        .unknown(true);

    if (or) {
        schema = schema.or(...or);
    }

    return schema.validate(params);
};

const validateStrict = (schemaObj, params) =>
    Joi.object(schemaObj)
        .options({
            abortEarly: false,
        })
        .unknown(false)
        .validate(params || {});

const fileObject = () =>
    Joi.object({
        base64: Joi.string().required(),
        extension: Joi.string().required(),
    });

const alternative = (key, value, then, otherwise) => {
    return Joi.alternatives().conditional(key, { is: value, then, otherwise });
};

const alternativeMany = (schema) => {
    return Joi.alternatives().try(schema);
};

const jsonObjectWithMinKeys = () =>
    Joi.object()
        .min(1) // Ensures the object has at least one key
        .error(_customErrors);

const stringKeyValueObject = () =>
    Joi.object()
        .min(1) // Ensures the object has at least one key
        .pattern(Joi.string(), Joi.string()) // All keys and values must be strings
        .error(_customErrors);

const stringOptionalEmptyAsNull = () =>
    Joi.string()
        .allow("")
        .custom((value, helpers) => {
            return value === "" ? null : value;
        })
        .error(_customErrors);

module.exports = {
    alternative,
    alternativeMany,
    any,
    array,
    boolean,
    crypto_,
    dateOfBirth,
    dateWithFormat,
    email,
    fileObject,
    firstName,
    forbidden,
    imageBase64WithType,
    jsonRpcParams,
    jsonObjectWithMinKeys,
    lastName,
    line,
    manufacturer,
    minMaxNumber,
    model,
    number,
    object,
    objectId,
    province,
    showRecords,
    string,
    stringEnum,
    stringKeyValueObject,
    stringOptionalEmptyAsNull,
    stringOrNumber,
    symbol,
    urlSecure,
    validate,
    validateStrict,
    zelfNameDuration_,
};

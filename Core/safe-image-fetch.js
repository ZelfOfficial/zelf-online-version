/**
 * Download a Zelf Proof QR image.
 *
 * Callers pass an IPFS or Arweave gateway URL (Pinata dedicated gateways,
 * ipfs.zelf.world, arweave.net, ar.io undernames, and the gateways in config).
 * Only https hosts on that allowlist are fetched. Each candidate is resolved
 * first, non-routable answers are refused, and every redirect is checked again.
 */

const dns = require("dns");
const https = require("https");
const net = require("net");
const { Buffer } = require("buffer");
const config = require("./config");

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 4000;
const MAX_REDIRECTS = 3;

/** Gateway families that serve Zelf Proof QR images, matched as the host or a subdomain. */
const STATIC_GATEWAY_SUFFIXES = Object.freeze([
    "mypinata.cloud",
    "pinata.cloud",
    "ipfs.zelf.world",
    "ar.io",
    "arweave.net",
    "ar-io.dev",
    "ar-io.net",
    "g8way.io",
    "ardrive.net",
    "turbo-gateway.com",
    "arweave-search.goldsky.com",
    "ipfs.io",
    "dweb.link",
    "w3s.link",
    "nftstorage.link",
    "cloudflare-ipfs.com",
]);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

const imageError = (code) => {
    const error = new Error(code);
    error.code = code;
    return error;
};

const headerValue = (headers, name) => {
    if (!headers) return "";
    const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
    if (Array.isArray(value)) return String(value[0] || "");
    return value == null ? "" : String(value);
};

const hostnameOf = (value) => {
    const text = String(value || "").trim();
    if (!text) return "";
    try {
        const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
        return new URL(withScheme).hostname.toLowerCase().replace(/\.$/, "");
    } catch (_error) {
        return text.toLowerCase().replace(/^\.+|\.+$/g, "");
    }
};

const hostMatches = (hostname, rule) => {
    const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
    const allowed = String(rule || "").toLowerCase().replace(/\.$/, "");
    if (!host || !allowed || allowed.includes("/") || !allowed.includes(".")) return false;
    return host === allowed || host.endsWith(`.${allowed}`);
};

const configuredGatewayHosts = () => {
    const arwave = config.arwave || {};
    const candidates = [
        process.env.PINATA_GATEWAY_URL,
        process.env._PINATA_GATEWAY_URL,
        process.env.__PINATA_GATEWAY_URL,
        process.env["2_PINATA_GATEWAY_URL"],
        config.pinata?.gatewayUrl,
        arwave.publicGatewayUrl,
        arwave.arnsGatewayHost,
        ...(Array.isArray(arwave.graphqlGateways) ? arwave.graphqlGateways : []),
        ...(Array.isArray(arwave.arnsGatewayHosts) ? arwave.arnsGatewayHosts : []),
    ];
    return candidates.map(hostnameOf).filter(Boolean);
};

const isHostAllowed = (hostname) => {
    const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
    if (!host || net.isIP(host)) return false;
    const rules = [...STATIC_GATEWAY_SUFFIXES, ...configuredGatewayHosts()];
    return rules.some((rule) => hostMatches(host, rule));
};

const ipv4ToInt = (ip) => {
    const parts = String(ip).split(".");
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const octet = Number(part);
        if (octet > 255) return null;
        value = (value * 256 + octet) >>> 0;
    }
    return value;
};

const inCidrV4 = (ip, base, bits) => {
    const address = ipv4ToInt(ip);
    const network = ipv4ToInt(base);
    if (address == null || network == null) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (address & mask) === (network & mask);
};

const BLOCKED_V4 = Object.freeze([
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
]);

const isBlockedV4 = (ip) => BLOCKED_V4.some(([base, bits]) => inCidrV4(ip, base, bits));

const ipv6ToBytes = (ip) => {
    let addr = String(ip || "").toLowerCase();
    const zone = addr.indexOf("%");
    if (zone !== -1) addr = addr.slice(0, zone);
    if (!addr) return null;

    const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) {
        const v4 = ipv4ToInt(mapped[1]);
        if (v4 == null) return null;
        const out = Buffer.alloc(16);
        out[10] = 0xff;
        out[11] = 0xff;
        out.writeUInt32BE(v4, 12);
        return out;
    }

    const absorbDotted = (groups) => {
        if (!groups.length) return groups;
        const last = groups[groups.length - 1];
        if (!last.includes(".")) return groups;
        const v4 = ipv4ToInt(last);
        if (v4 == null) return null;
        groups.pop();
        groups.push(((v4 >>> 16) & 0xffff).toString(16));
        groups.push((v4 & 0xffff).toString(16));
        return groups;
    };

    let groups;
    if (!addr.includes("::")) {
        groups = absorbDotted(addr.split(":"));
        if (!groups || groups.length !== 8) return null;
    } else {
        const halves = addr.split("::");
        if (halves.length !== 2) return null;
        let head = halves[0] ? halves[0].split(":") : [];
        let tail = halves[1] ? halves[1].split(":") : [];
        head = absorbDotted(head);
        tail = absorbDotted(tail);
        if (!head || !tail) return null;
        const missing = 8 - (head.length + tail.length);
        if (missing < 0) return null;
        groups = [...head, ...Array(missing).fill("0"), ...tail];
    }

    if (groups.length !== 8) return null;
    const out = Buffer.alloc(16);
    for (let index = 0; index < groups.length; index++) {
        const group = groups[index];
        if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
        out.writeUInt16BE(parseInt(group, 16), index * 2);
    }
    return out;
};

const hasPrefix = (bytes, prefixBytes, bits) => {
    const full = Math.floor(bits / 8);
    const rest = bits % 8;
    for (let index = 0; index < full; index++) {
        if (bytes[index] !== prefixBytes[index]) return false;
    }
    if (!rest) return true;
    const mask = (0xff << (8 - rest)) & 0xff;
    return (bytes[full] & mask) === (prefixBytes[full] & mask);
};

const isBlockedV6 = (ip) => {
    const bytes = ipv6ToBytes(ip);
    if (!bytes) return true;

    const embeddedV4 = () => {
        const value = bytes.readUInt32BE(12);
        return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
    };

    // IPv4-mapped and IPv4-compatible.
    const mapped = bytes.subarray(0, 12).equals(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]));
    const compatible = bytes.subarray(0, 12).equals(Buffer.alloc(12)) && !bytes.subarray(12).equals(Buffer.alloc(4));
    if (mapped || compatible) return isBlockedV4(embeddedV4());

    if (bytes.equals(Buffer.alloc(16))) return true;
    if (bytes.equals(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]))) return true;

    // fe80::/10 link-local, fc00::/7 unique local, ff00::/8 multicast.
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
    if ((bytes[0] & 0xfe) === 0xfc) return true;
    if (bytes[0] === 0xff) return true;

    // 2001:db8::/32 documentation.
    if (hasPrefix(bytes, Buffer.from([0x20, 0x01, 0x0d, 0xb8]), 32)) return true;

    // 2002::/16 6to4 and 64:ff9b::/96 NAT64 embed an IPv4 address.
    if (hasPrefix(bytes, Buffer.from([0x20, 0x02]), 16)) {
        const embedded = [bytes[2], bytes[3], bytes[4], bytes[5]].join(".");
        return isBlockedV4(embedded);
    }
    if (hasPrefix(bytes, Buffer.from([0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0]), 96)) {
        return isBlockedV4(embeddedV4());
    }
    // 64:ff9b:1::/48 is locally assigned translation space.
    if (hasPrefix(bytes, Buffer.from([0x00, 0x64, 0xff, 0x9b, 0x00, 0x01]), 48)) return true;

    return false;
};

const isBlockedAddress = (ip) => {
    const family = net.isIP(String(ip || ""));
    if (family === 4) return isBlockedV4(ip);
    if (family === 6) return isBlockedV6(ip);
    return true;
};

const defaultLookup = async (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

const assertSafeImageUrl = async (rawUrl, lookup = defaultLookup) => {
    let url;
    try {
        url = new URL(String(rawUrl || "").trim());
    } catch (_error) {
        throw imageError("IMAGE_URL_HOST_NOT_ALLOWED");
    }

    if (url.username || url.password) throw imageError("IMAGE_URL_HOST_NOT_ALLOWED");
    if (url.protocol !== "https:") throw imageError("IMAGE_URL_NOT_HTTPS");
    if (url.port && url.port !== "443") throw imageError("IMAGE_URL_HOST_NOT_ALLOWED");

    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (net.isIP(hostname)) {
        if (isBlockedAddress(hostname)) throw imageError("IMAGE_URL_BLOCKED_ADDRESS");
        throw imageError("IMAGE_URL_HOST_NOT_ALLOWED");
    }
    if (!isHostAllowed(hostname)) throw imageError("IMAGE_URL_HOST_NOT_ALLOWED");

    let records;
    try {
        records = await lookup(hostname);
    } catch (_error) {
        throw imageError("IMAGE_URL_UNRESOLVED");
    }
    const addresses = (Array.isArray(records) ? records : [records])
        .map((record) => (typeof record === "string" ? { address: record, family: net.isIP(record) } : record))
        .filter((record) => record && record.address);

    if (!addresses.length) throw imageError("IMAGE_URL_UNRESOLVED");
    if (addresses.some((record) => isBlockedAddress(record.address))) {
        throw imageError("IMAGE_URL_BLOCKED_ADDRESS");
    }

    const chosen = addresses[0];
    return {
        href: url.href,
        hostname,
        address: chosen.address,
        family: chosen.family === 6 || chosen.family === "IPv6" ? 6 : 4,
    };
};

const pinnedLookup = (address, family) => (hostname, options, callback) => {
    if (typeof options === "function") {
        callback = options;
        options = {};
    }
    if (options && options.all) {
        callback(null, [{ address, family }]);
        return;
    }
    callback(null, address, family);
};

const defaultTransport = ({ href, hostname, address, family }) =>
    new Promise((resolve, reject) => {
        const target = new URL(href);
        let settled = false;
        const fail = (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        };
        const succeed = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        const req = https.request(
            {
                protocol: "https:",
                hostname,
                servername: hostname,
                port: 443,
                method: "GET",
                path: `${target.pathname}${target.search}`,
                headers: {
                    accept: "image/png, image/jpeg, application/octet-stream",
                    host: hostname,
                },
                lookup: pinnedLookup(address, family),
                timeout: TIMEOUT_MS,
            },
            (res) => {
                const chunks = [];
                let total = 0;
                const declared = Number(headerValue(res.headers, "content-length"));
                if (Number.isFinite(declared) && declared > MAX_BYTES) {
                    req.destroy();
                    fail(imageError("IMAGE_URL_TOO_LARGE"));
                    return;
                }
                res.on("data", (chunk) => {
                    total += chunk.length;
                    if (total > MAX_BYTES) {
                        req.destroy();
                        fail(imageError("IMAGE_URL_TOO_LARGE"));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on("end", () => {
                    succeed({
                        status: res.statusCode || 0,
                        headers: res.headers || {},
                        buffer: Buffer.concat(chunks),
                    });
                });
                res.on("error", () => fail(imageError("IMAGE_URL_FETCH_FAILED")));
            }
        );

        req.on("timeout", () => {
            req.destroy();
            fail(imageError("IMAGE_URL_TIMEOUT"));
        });
        req.on("error", (error) => {
            if (error && error.code && String(error.code).startsWith("IMAGE_URL_")) fail(error);
            else fail(imageError("IMAGE_URL_FETCH_FAILED"));
        });
        req.end();
    });

const isRedirect = (status) => status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

const redirectTarget = (headers, currentHref) => {
    const location = headerValue(headers, "location").trim();
    if (!location) return null;
    try {
        return new URL(location, currentHref).href;
    } catch (_error) {
        return null;
    }
};

const isPngOrJpeg = (buffer) => {
    if (!Buffer.isBuffer(buffer)) return false;
    if (buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return true;
    return buffer.length >= JPEG_SIGNATURE.length && buffer.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE);
};

const allowedContentType = (contentType) => {
    const mime = String(contentType || "").split(";")[0].trim().toLowerCase();
    return mime === "image/png" || mime === "image/jpeg" || mime === "image/jpg" || mime === "application/octet-stream";
};

/**
 * @param {string} rawUrl
 * @param {{ lookup?: Function, transport?: Function }} [deps]
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
const fetchAllowedImage = async (rawUrl, deps = {}) => {
    const lookup = deps.lookup || defaultLookup;
    const transport = deps.transport || defaultTransport;
    let current = rawUrl;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const checked = await assertSafeImageUrl(current, lookup);
        const response = await transport(checked);
        const status = Number(response?.status || 0);

        if (isRedirect(status)) {
            if (hop === MAX_REDIRECTS) throw imageError("IMAGE_URL_REDIRECT_BLOCKED");
            const next = redirectTarget(response.headers, checked.href);
            if (!next) throw imageError("IMAGE_URL_REDIRECT_BLOCKED");
            current = next;
            continue;
        }

        if (status !== 200) throw imageError("IMAGE_URL_FETCH_FAILED");

        const contentType = headerValue(response.headers, "content-type");
        if (!allowedContentType(contentType)) throw imageError("IMAGE_URL_TYPE_NOT_ALLOWED");

        const buffer = Buffer.isBuffer(response.buffer) ? response.buffer : Buffer.from(response.buffer || []);
        if (buffer.length > MAX_BYTES) throw imageError("IMAGE_URL_TOO_LARGE");
        if (!isPngOrJpeg(buffer)) throw imageError("IMAGE_URL_TYPE_NOT_ALLOWED");

        const mime = contentType.split(";")[0].trim().toLowerCase();
        return { buffer, contentType: mime === "image/jpeg" || mime === "image/jpg" ? "image/jpeg" : mime };
    }

    throw imageError("IMAGE_URL_REDIRECT_BLOCKED");
};

module.exports = {
    MAX_BYTES,
    STATIC_GATEWAY_SUFFIXES,
    assertSafeImageUrl,
    fetchAllowedImage,
    imageError,
    isBlockedAddress,
    isHostAllowed,
};

/**
 * Staff-only gift: grant a license-priced plan + duration to a Zelf ID at price 0.
 * - Caller must be staff (write/admin) of the name's license domain.
 * - The exact plan + duration must exist in the domain license (`tags.payment.planPricing`); nothing hardcoded.
 * - Free name: rebuilt from the proof with the lease-offline logic (keeping the proof's own version/type), then stamped.
 * - Existing name: stamped with the same code a paid upgrade uses (addDurationToTag), price 0, paymentMethod "gift".
 */
const { getDomainConfig } = require("../../Tags/config/supported-domains");
const { assertLicenseOffersPlan, getBareName } = require("./zelf-id-plan.module");

const STAFF_TYPES = new Set(["staff", "staff_account"]);
const WRITE_ROLES = new Set(["write", "admin"]);

const httpError = (code) => new Error(code);

const assertStaffWriter = (jwt) => {
    if (!jwt) throw httpError("401:unauthorized");
    if (!STAFF_TYPES.has(jwt.accountType)) throw httpError("403:staff_only");
    if (!WRITE_ROLES.has(String(jwt.role || "read"))) throw httpError("403:write_access_required");
};

const linksOf = (tagObject = {}) => {
    const ipfs = Array.isArray(tagObject.ipfs) ? tagObject.ipfs[0] : tagObject.ipfs || tagObject;
    const arweave = Array.isArray(tagObject.arweave) ? tagObject.arweave[0] : tagObject.arweave;
    return {
        ipfs: ipfs?.url || null,
        cid: ipfs?.cid || ipfs?.ipfs_pin_hash || null,
        arweave: arweave?.url || null,
    };
};

const giftZelfId = async (params = {}, jwt, deps = {}) => {
    const resolveAuthorizedDomain =
        deps.resolveAuthorizedDomain || require("../../License/modules/license-domain-access.module").resolveAuthorizedDomain;
    const ZelfIdModule = deps.ZelfIdModule || require("./zelf-id.module");
    const Offline = deps.Offline || require("./zelf-ids-offline.module");
    const { addDurationToTag } = deps.MyZelfId || require("./my-zelf-id.module");
    const GiftModel = deps.GiftModel || require("../models/zelf-id-staff-gift.model");
    const getConfig = deps.getDomainConfig || getDomainConfig;

    assertStaffWriter(jwt);

    const domain = String(params.domain || "").trim().toLowerCase().replace(/^\./, "");
    const bare = getBareName(params.tagName).toLowerCase();
    const plan = String(params.plan || "").trim().toLowerCase();
    const duration = `${params.duration ?? ""}`.trim().toLowerCase();
    const reason = String(params.reason || "").trim();
    if (!domain || !bare || !plan || !duration || !reason) throw httpError("409:missing_gift_fields");

    await resolveAuthorizedDomain(jwt, domain);

    const domainConfig = getConfig(domain);
    if (!domainConfig) throw httpError("409:unsupported_domain");
    const fullName = `${bare}.${domain}`;

    assertLicenseOffersPlan({ domainConfig, tagName: fullName, plan, duration });

    let action = "gifted";
    let provenance;
    let search = await ZelfIdModule.searchTag({ tagName: fullName, domain, domainConfig, environment: "all" }, jwt);

    if (search.available || !search.tagObject) {
        if (!params.zelfProof && !params.zelfProofQRCode) throw httpError("409:zelf_proof_required_to_rebuild");
        const rebuilt = await Offline.leaseOffline(
            {
                tagName: fullName,
                domain,
                zelfProof: params.zelfProof,
                zelfProofQRCode: params.zelfProofQRCode,
                preserveProvenance: true,
            },
            jwt
        );
        provenance = rebuilt.provenance;
        action = "rebuilt_and_gifted";
        search = await ZelfIdModule.searchTag({ tagName: fullName, domain, domainConfig, environment: "all" }, jwt);
        if (search.available || !search.tagObject) throw httpError("409:rebuild_not_visible_yet");
    }

    const tagObject = search.tagObject;
    if (!provenance && params.preserveProvenance) {
        // Existing record: relabel version/type from the proof's own cleartext, not from the stored stamp.
        let proof = params.zelfProof || tagObject.zelfProof || tagObject.publicData?.zelfProof;
        if (!proof && params.zelfProofQRCode) {
            const { extractZelfProofFromQR } = deps.QR || require("../../Tags/modules/qr-zelfproof-extractor.module");
            proof = await extractZelfProofFromQR(params.zelfProofQRCode);
        }
        if (!proof) throw httpError("409:zelf_proof_required_to_preserve_provenance");
        const { publicData: proofPublic } = await Offline.previewHumanAuthn({ zelfProof: proof });
        provenance = Offline.detectProofProvenance(proofPublic);
        tagObject.publicData = { ...(tagObject.publicData || {}), v: provenance.version, origin: provenance.type };
    }
    if (!provenance) provenance = Offline.detectProofProvenance(tagObject.publicData || {});

    const result = await addDurationToTag(
        {
            tagName: bare,
            domain,
            duration: duration === "lifetime" ? "lifetime" : parseInt(duration, 10),
            plan,
            price: 0,
            paymentMethod: "gift",
            domainConfig,
        },
        tagObject
    );

    const stamped = result?.tagObject || tagObject;
    const expiresAt = result?.expiresAt || stamped?.publicData?.expiresAt || null;
    const links = linksOf(stamped);

    await GiftModel.create({
        tagName: fullName,
        domain,
        plan,
        duration,
        reason,
        staffId: String(jwt._id || jwt.id || jwt.staffId || ""),
        staffEmail: String(jwt.email || ""),
        ownerEmail: String(jwt.ownerEmail || ""),
        action,
        proofVersion: provenance?.version || "",
        proofType: provenance?.type || "",
        expiresAt: expiresAt || "",
        ipfsCid: links.cid || "",
    });

    return { tagName: fullName, domain, plan, duration, action, paymentMethod: "gift", price: 0, expiresAt, provenance, links };
};

module.exports = { giftZelfId, assertStaffWriter };

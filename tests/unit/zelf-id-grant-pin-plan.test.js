/**
 * A grant must change the plan later reads see on the pin.
 * Pinata returns the existing pin when the QR bytes are unchanged; the keyvalues still have to move.
 */
jest.mock("../../Core/ipfs", () => {
    const store = new Map();
    return {
        pinFile: jest.fn(async () => ({
            id: "pin-1",
            cid: "bafy-same",
            is_duplicate: true,
            metadata: { keyvalues: { extraParams: JSON.stringify({ plan: "free", duration: "100" }) } },
        })),
        upload: jest.fn(),
        updateFileKeyvalues: jest.fn(async (id, keyvalues) => {
            store.set(id, keyvalues);
            return { id, cid: "bafy-same", metadata: { keyvalues } };
        }),
        getFileById: jest.fn(async (id) => ({
            id,
            cid: "bafy-same",
            metadata: { keyvalues: store.get(id) || {} },
        })),
        deleteFiles: jest.fn(async () => null),
        unPinFiles: jest.fn(async () => null),
        filter: jest.fn(async () => []),
        filterPaged: jest.fn(async () => ({ files: [], nextPageToken: null })),
        retrieve: jest.fn(),
        __store: store,
    };
});

jest.mock("../../Repositories/Tags/modules/tag-smart-contract-payment.module", () => ({
    throwPaymentConfirmationTagNotFound: jest.fn(),
    verifySmartContractPayment: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/my-tags.module", () => ({
    confirmPayUniqueAddress: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tags.module", () => ({
    decryptTag: jest.fn(async () => ({})),
}));

jest.mock("../../Repositories/ZelfID/modules/zelf-id.module", () => ({
    searchTag: jest.fn(),
}));

const { Domain } = require("../../Repositories/Tags/modules/domain.class");
const { zelfPlanLicenseData } = require("../fixtures/zelf-plan-license.fixture");
const IPFS = require("../../Core/ipfs");
const { formatRecord } = require("../../Repositories/Tags/modules/tags-ipfs.module");
const { addDurationToTag } = require("../../Repositories/ZelfID/modules/my-zelf-id.module");
const { buildMyPlan } = require("../../Repositories/ZelfID/modules/zelf-ids-my-plan.module");
const { readLeaseSearchResult } = require("../../Repositories/ZelfID/modules/zelf-id-plan-term.module");

const domainConfig = new Domain({
    ...zelfPlanLicenseData(),
    tags: {
        ...zelfPlanLicenseData().tags,
        storage: { keyPrefix: "tagName", ipfsEnabled: true, arweaveEnabled: false, walrusEnabled: false },
    },
});

describe("a grant updates the plan search and my-plan read", () => {
    test("the duplicate pin receives the new plan", async () => {
        const tag = {
            zelfProofQRCode: "qr",
            ipfsId: "pin-1",
            id: "pin-1",
            cid: "bafy-same",
            publicData: {
                tagName: "grantpin.zelf",
                type: "mainnet",
                plan: "free",
                duration: "100",
                expiresAt: "2126-01-01 00:00:00",
                registeredAt: "2019-06-01 00:00:00",
                hasPassword: "true",
                origin: "online",
                v: "4",
            },
        };

        await addDurationToTag(
            {
                tagName: "grantpin",
                price: 29,
                billableUsdPrice: 29,
                domain: "zelf",
                duration: 1,
                plan: "premium",
                domainConfig,
                paymentMethod: "stripe",
            },
            tag
        );

        expect(IPFS.deleteFiles).not.toHaveBeenCalled();
        const keyvalues = IPFS.updateFileKeyvalues.mock.calls[0][1];
        const extra = keyvalues.extraParams
            ? typeof keyvalues.extraParams === "string"
                ? JSON.parse(keyvalues.extraParams)
                : keyvalues.extraParams
            : keyvalues;
        expect(extra.plan).toBe("premium");

        const searched = formatRecord({ id: "pin-1", metadata: { keyvalues } });
        const result = await readLeaseSearchResult({ tagObject: { publicData: { ...searched.publicData } } });
        expect(result.tagObject.publicData.plan).toBe("premium");

        const myPlan = await buildMyPlan(
            { publicData: { ...searched.publicData } },
            { zelfName: "grantpin.zelf", domainConfig }
        );
        expect(myPlan.plan).toBe("premium");
    });
});

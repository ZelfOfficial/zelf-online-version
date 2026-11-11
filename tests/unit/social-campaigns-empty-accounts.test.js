jest.mock("../../Repositories/Tags/modules/my-tags.module", () => ({}));
jest.mock("../../Repositories/Tags/modules/tags-search.module", () => ({}));
jest.mock("../../Repositories/SocialCampaigns/models/social-campaign-record.model", () => ({
    findOne: jest.fn(),
}));

const Model = require("../../Repositories/SocialCampaigns/models/social-campaign-record.model");
const { validateX, validateLinkedIn } = require("../../Repositories/SocialCampaigns/modules/social-campaigns.module");
const { errorHandler } = require("../../Core/http-handler");

const record = {
    email: "a@b.c",
    tagName: "alice",
    domain: "zelf",
    verified: true,
    followedX: false,
    followedLinkedin: false,
};

describe("social campaign accounts", () => {
    beforeEach(() => {
        Model.findOne.mockResolvedValue(record);
    });

    test("validateX and validateLinkedIn refuse when no accounts are configured", async () => {
        await expect(validateX("a@b.c", "alice", "zelf", "img", null, {})).rejects.toThrow("400:social_accounts_not_configured");
        await expect(validateLinkedIn("a@b.c", "alice", "zelf", "img", "someone", {})).rejects.toThrow("400:social_accounts_not_configured");

        const handled = errorHandler(new Error("400:social_accounts_not_configured"));
        expect(handled.status).toBe(400);
        expect(handled.message).toBe("social_accounts_not_configured");
    });
});

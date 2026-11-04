describe("default PoW ladder (production defaults)", () => {
    let FacePow;

    beforeAll(() => {
        jest.resetModules();
        process.env.FACE_ATTEMPT_POW_AFTER_FAILURES = "2";
        process.env.FACE_POW_BASE_DIFFICULTY = "16";
        process.env.FACE_POW_MAX_DIFFICULTY = "19";
        delete require.cache[require.resolve("../../Core/config")];
        FacePow = require("../../Repositories/Face/modules/face-pow.module");
    });

    it("issues 16 bits at first PoW threshold, then +1 per two failures up to 19", () => {
        expect(FacePow.difficultyForFailures(0)).toBe(16);
        expect(FacePow.difficultyForFailures(1)).toBe(16);
        expect(FacePow.difficultyForFailures(2)).toBe(16);
        expect(FacePow.difficultyForFailures(3)).toBe(16);
        expect(FacePow.difficultyForFailures(4)).toBe(17);
        expect(FacePow.difficultyForFailures(6)).toBe(18);
        expect(FacePow.difficultyForFailures(8)).toBe(19);
        expect(FacePow.difficultyForFailures(100)).toBe(19);
    });
});

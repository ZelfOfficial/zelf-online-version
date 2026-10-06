const fs = require("fs");
const path = require("path");
const { sendCustomEmail } = require("../Core/mailgun");
// specific to this script
const BLOG_POST_PATH = path.join(__dirname, "../../ai-made/landing-zelf-nextjs/content/blog/bitcoin-erases-election-gains-analysis.mdx");
const TEST_EMAIL = "miguel.trevinom@gmail.com";

const parseMDX = (content) => {
    const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
    const match = content.match(frontmatterRegex);
    let frontmatter = {};
    let body = content;

    if (match) {
        const yaml = match[1];
        body = content.replace(match[0], "").trim();

        yaml.split("\n").forEach((line) => {
            const [key, ...value] = line.split(":");
            if (key && value) {
                frontmatter[key.trim()] = value
                    .join(":")
                    .trim()
                    .replace(/^['"]|['"]$/g, "");
            }
        });
    }

    return { frontmatter, body };
};

const markdownToHtml = (markdown) => {
    // Basic Markdown to HTML converter for the email
    let html = markdown
        .replace(/^### (.*$)/gim, "<h3>$1</h3>")
        .replace(/^## (.*$)/gim, "<h2>$1</h2>")
        .replace(/^# (.*$)/gim, "<h1>$1</h1>")
        .replace(/\*\*(.*)\*\*/gim, "<strong>$1</strong>")
        .replace(/\*(.*)\*/gim, "<em>$1</em>")
        .replace(/!\[(.*?)\]\((.*?)\)/gim, '<img alt="$1" src="$2" />')
        .replace(/\[(.*?)\]\((.*?)\)/gim, '<a href="$2">$1</a>')
        .replace(/^\s*\n\*/gm, "<ul>\n*")
        .replace(/^(\*.+)\s*\n([^\*])/gm, "$1\n</ul>\n\n$2")
        .replace(/^\* (.*)/gm, "<li>$1</li>")
        .replace(/\n\n/gim, "<br/><br/>"); // simplistic paragraph handling

    return html;
};

const main = async () => {
    try {
        console.log("Reading blog post...");
        const content = fs.readFileSync(BLOG_POST_PATH, "utf8");
        const { frontmatter, body } = parseMDX(content);

        console.log(`Parsed blog post: "${frontmatter.title}"`);

        const htmlContent = markdownToHtml(body);

        // Correct image path if it's relative or local to the frontend
        let imageUrl = frontmatter.image;
        if (imageUrl && imageUrl.startsWith("/")) {
            imageUrl = `https://zelf.world${imageUrl}`;
        }

        console.log(`Sending test email to ${TEST_EMAIL}...`);

        await sendCustomEmail(TEST_EMAIL, "newsletter_blog", {
            title: frontmatter.title,
            image: imageUrl,
            content: htmlContent,
            url: `https://zelf.world/blog/bitcoin-erases-election-gains-analysis`, // hardcoded for this test
            sincerely: "Happy Reading,",
            subject: frontmatter.title, // Ensure subject is set
            pixelUrl: `https://v4.zelf.world/api/articles/track/test-article-id/test-subscriber-id`, // Test pixel
        });

        console.log("Done!");
        process.exit(0);
    } catch (error) {
        console.error("Error:", error);
        process.exit(1);
    }
};

main();

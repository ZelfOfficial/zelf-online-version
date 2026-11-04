#!/usr/bin/env node
/**
 * Derive a Solana key from a 12- or 24-word recovery phrase.
 *
 * The phrase is read from the arguments, or from one stdin line when omitted.
 * Do not pass the phrase as a shell argument if the shell records history.
 *
 * Usage:
 *   node scripts/solana-key-from-mnemonic.mjs
 *   node scripts/solana-key-from-mnemonic.mjs --account 1
 *   printf '%s\n' "word1 word2 ... word24" | node scripts/solana-key-from-mnemonic.mjs
 */

import { createRequire } from "module";
import readline from "readline";

const require = createRequire(import.meta.url);
const bip39 = require("bip39");
const { derivePath } = require("ed25519-hd-key");
const nacl = require("tweetnacl");
const bs58 = require("bs58").default;

const ANT_OWNER = "foQopMooDKxeKdzCyZhkVToVhJG8kKTiZjERba8VpoR";

const readPhrase = async (wordsFromArgs) => {
	if (wordsFromArgs.length > 0) return wordsFromArgs.join(" ").trim().toLowerCase();
	if (process.stdin.isTTY) {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		const line = await new Promise((resolve) => {
			rl.question("Recovery phrase: ", resolve);
		});
		rl.close();
		return line.trim().toLowerCase();
	}
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8").trim().toLowerCase();
};

const deriveAccount = (seed, path) => {
	const { key } = derivePath(path, seed);
	const keyPair = nacl.sign.keyPair.fromSeed(key);
	return {
		path,
		address: bs58.encode(keyPair.publicKey),
		secret: bs58.encode(keyPair.secretKey),
	};
};

const parseArgs = (argv) => {
	const words = [];
	let account = 0;
	let passphrase = "";
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--account") {
			account = Number(argv[index + 1]);
			index++;
			continue;
		}
		if (arg === "--passphrase") {
			passphrase = argv[index + 1] || "";
			index++;
			continue;
		}
		words.push(arg);
	}
	if (!Number.isInteger(account) || account < 0) {
		throw new Error("--account must be a non-negative integer");
	}
	return { words, account, passphrase };
};

const main = async () => {
	const { words, account, passphrase } = parseArgs(process.argv.slice(2));
	const phrase = await readPhrase(words);
	const wordCount = phrase.split(/\s+/).filter(Boolean).length;
	if (wordCount !== 12 && wordCount !== 24) {
		throw new Error(`Expected 12 or 24 words, received ${wordCount}`);
	}
	if (!bip39.validateMnemonic(phrase)) {
		throw new Error("Recovery phrase is not a valid BIP39 mnemonic");
	}

	const seed = await bip39.mnemonicToSeed(phrase, passphrase);
	const paths = [
		`m/44'/501'/${account}'/0'`,
		`m/44'/501'/${account === 0 ? 1 : 0}'/0'`,
		`m/44'/501'/${account}'`,
	];
	const seen = new Set();
	const derived = paths
		.filter((path) => (seen.has(path) ? false : seen.add(path)))
		.map((path) => deriveAccount(seed, path));

	const match = derived.find((row) => row.address === ANT_OWNER);
	for (const row of derived) {
		const mark = row.address === ANT_OWNER ? "  name-token owner" : "";
		console.log(`${row.path}  ${row.address}${mark}`);
	}

	const chosen = match || derived[0];
	console.log("");
	if (match) {
		console.log("This phrase controls the zelf name token.");
	} else {
		console.log("None of these addresses is the zelf name-token owner foQopMooDKxeKdzCyZhkVToVhJG8kKTiZjERba8VpoR.");
		console.log(`Printing the secret for ${chosen.path}.`);
	}
	console.log(`ARNS_SOLANA_OWNER_PRIVATE_KEY=${chosen.secret}`);
};

main().catch((error) => {
	console.error(error.message || error);
	process.exit(1);
});

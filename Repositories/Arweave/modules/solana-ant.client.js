const bs58 = require("bs58");
const config = require("../../../Core/config");

const DEFAULT_MINT = "5mwShV7zD67vCRzSXeJg9Gmvni7akqHTst59iA9PwGwu";
const DEFAULT_PROGRAM = "2MWexMHfMhGJwMHv9Qm9YAVCqjUFUJwDJAysW4oCUGk5";

const codec = () => bs58.default || bs58;

const secretBytes = (value) => {
	const trimmed = String(value || "").trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("[")) return Uint8Array.from(JSON.parse(trimmed));
	return codec().decode(trimmed);
};

let kitPromise;

const loadKit = () => {
	if (!kitPromise) {
		kitPromise = Promise.all([import("@ar.io/sdk-solana"), import("@solana/kit"), import("@ar.io/solana-contracts/ant")]);
	}
	return kitPromise;
};

const mintId = () => process.env.ARNS_SOLANA_MINT || config.arns.solanaMint || DEFAULT_MINT;
const programId = () => process.env.ARNS_SOLANA_PROGRAM_ID || DEFAULT_PROGRAM;

const getRecords = async () => {
	const [{ SolanaANTReadable }, { createSolanaRpc, address }] = await loadKit();
	const ant = new SolanaANTReadable({
		rpc: createSolanaRpc(config.solana.rpcUrl),
		processId: mintId(),
		antProgramId: address(programId()),
	});
	return (await ant.getRecords()) || {};
};

const setRecord = async ({ recordKey, transactionId, ttlSeconds = 3600 }) => {
	const [{ getAntRecordPDA }, kit, { getSetRecordInstructionAsync }] = await loadKit();
	const {
		address,
		appendTransactionMessageInstructions,
		createKeyPairSignerFromBytes,
		createSolanaRpc,
		createTransactionMessage,
		getBase64EncodedWireTransaction,
		pipe,
		setTransactionMessageFeePayerSigner,
		setTransactionMessageLifetimeUsingBlockhash,
		signTransactionMessageWithSigners,
	} = kit;

	const ownerBytes = secretBytes(process.env.ARNS_SOLANA_OWNER_PRIVATE_KEY);
	if (!ownerBytes) throw new Error("Missing ARNS_SOLANA_OWNER_PRIVATE_KEY");

	const owner = await createKeyPairSignerFromBytes(ownerBytes);
	const payerBytes = secretBytes(config.solana.sender);
	const payer = payerBytes ? await createKeyPairSignerFromBytes(payerBytes) : owner;
	const rpc = createSolanaRpc(config.solana.rpcUrl);
	const mint = address(mintId());
	const program = address(programId());
	const [recordPda] = await getAntRecordPDA(mint, recordKey, program);
	const { value: blockhash } = await rpc.getLatestBlockhash().send();
	const instruction = await getSetRecordInstructionAsync(
		{
			asset: mint,
			record: recordPda,
			caller: owner,
			undername: recordKey,
			target: transactionId,
			targetProtocol: 0,
			ttlSeconds,
			priority: recordKey === "@" ? 0 : null,
			recordOwner: null,
		},
		{ programAddress: program }
	);
	const message = pipe(
		createTransactionMessage({ version: 0 }),
		(current) => setTransactionMessageFeePayerSigner(payer, current),
		(current) => setTransactionMessageLifetimeUsingBlockhash(blockhash, current),
		(current) => appendTransactionMessageInstructions([instruction], current)
	);
	const signed = await signTransactionMessageWithSigners(message);
	const signature = await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64" }).send();
	return { id: signature };
};

module.exports = {
	getRecords,
	setRecord,
};

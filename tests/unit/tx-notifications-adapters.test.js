/**
 * Chain adapters of the received-transfer watcher (Zelf #566), parsed from
 * responses recorded on mainnet (public data) into tests/fixtures/tx-notifications.
 * The only fixture not read from its own provider is the Alchemy one: no Alchemy
 * key exists outside the server, so it is real Ethereum data in Alchemy's
 * documented response shape (see its `_note`).
 */
const path = require("path");

const bitcoin = require("../../Repositories/TxNotifications/adapters/bitcoin.adapter");
const blockdag = require("../../Repositories/TxNotifications/adapters/blockdag.adapter");
const solana = require("../../Repositories/TxNotifications/adapters/solana.adapter");
const stellar = require("../../Repositories/TxNotifications/adapters/stellar.adapter");
const sui = require("../../Repositories/TxNotifications/adapters/sui.adapter");
const ton = require("../../Repositories/TxNotifications/adapters/ton.adapter");
const aptos = require("../../Repositories/TxNotifications/adapters/aptos.adapter");
const evmRpc = require("../../Repositories/TxNotifications/adapters/evm-rpc.adapter");
const alchemy = require("../../Repositories/TxNotifications/adapters/evm-alchemy.adapter");
const { isPermanentAlchemyFailure } = require("../../Repositories/TxNotifications/adapters");
const { passesValueFilter } = require("../../Repositories/TxNotifications/modules/delivery-planner");

const fixture = (name) => require(path.join(__dirname, "../fixtures/tx-notifications", name));

describe("solana adapter", () => {
    it("SOL sent by an exchange hot wallet is incoming for the recipient", () => {
        const { response, recipient, sender } = fixture("solana-tx-sol-withdrawal.json");
        expect(solana.parseSolanaTransaction(response, recipient)).toEqual({
            network: "solana",
            hash: "67izSN1Jg6jgSdQNcsqi147qrDAnUX6u4dppMGvvbiqvp8ZdZfVY7w1oz1JoKHMvH9ES7gdLNK2gyqw4bBWH7ocS",
            amount: "1.844217",
            asset: "SOL",
            from: sender,
            timestampMs: 1790788889000,
            native: true,
        });
    });

    it("the same transaction is the sender's own send (it signed it): never pushed to the sender", () => {
        const { response, sender } = fixture("solana-tx-sol-withdrawal.json");
        expect(solana.parseSolanaTransaction(response, sender)).toBeNull();
    });

    it("USDC into an existing token account is found from token balances even though the wallet is not an account key", () => {
        const { response, recipient, sender } = fixture("solana-tx-usdc-existing-ata.json");
        expect(response.transaction.message.accountKeys.some((key) => key.pubkey === recipient)).toBe(false);
        expect(solana.parseSolanaTransaction(response, recipient)).toMatchObject({
            hash: "4hMhFivXFxazkNe69jg38Yxv8w5ursrZjunTUCku8Q6Smw5siPFxXMEEU7iE1LYiujmWzuUV8BKk4BD4HmUBV5aP",
            amount: "0.079999",
            asset: "USDC",
            from: sender,
            native: false,
        });
    });

    it("a token outside the curated list (airdrop spam) is ignored", () => {
        const { response, recipient } = fixture("solana-tx-uncurated-token.json");
        expect(solana.parseSolanaTransaction(response, recipient)).toBeNull();
    });

    it("follows only token accounts of curated mints (here 1 of 90: the USDC account)", () => {
        const { responses } = fixture("solana-token-accounts.json");
        const all = responses.flatMap((r) => r.value);
        expect(all).toHaveLength(90);
        const followed = solana.curatedTokenAccounts(responses);
        expect(followed).toEqual(["9xk153oskm1q5n2qMRXMTFLSi2oXd3TD3URmG9WJS3hn"]);
        expect(all.find((v) => v.pubkey === followed[0]).account.data.parsed.info.mint).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    });

    it("watches both the SPL Token and Token-2022 programs", () => {
        expect(solana.TOKEN_PROGRAMS).toEqual(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
    });
});

describe("bitcoin adapter (Esplora)", () => {
    const { response, address } = fixture("bitcoin-address-txs.json");
    const parsed = response.map((tx) => bitcoin.parseBitcoinTransaction(tx, address));

    it("counts only outputs to the address, confirmed, and not funded by it", () => {
        expect(parsed.filter(Boolean).map((t) => [t.hash.slice(0, 10), t.amount])).toEqual([
            ["5bdf8da471", "85.73836384"],
            ["a1d3b23bba", "99.78033606"],
            ["6b6802a7c2", "82.50996541"],
        ]);
        expect(parsed[3]).toMatchObject({ network: "bitcoin", asset: "BTC", from: "12PXqjpvyV23mU7M4JRZGd3T1mmKo6bpU3", timestampMs: 1790786315000 });
    });

    it("ignores unconfirmed transactions and own sends (the address funds an input)", () => {
        expect(response[0].status.confirmed).toBe(false);
        expect(parsed[0]).toBeNull();
        for (const i of [1, 2]) {
            expect(response[i].vin.some((input) => input.prevout?.scriptpubkey_address === address)).toBe(true);
            expect(parsed[i]).toBeNull();
        }
    });
});

describe("ton adapter (TonAPI events)", () => {
    it("incoming TON and whitelisted jettons, compared as raw addresses", () => {
        const { response, account } = fixture("ton-events.json");
        const parsed = response.events.map((event) => ton.parseTonEvent(event, account)).filter(Boolean);
        expect(parsed).toHaveLength(24);
        expect(parsed[0]).toEqual({
            network: "ton",
            hash: "bf3a09ec32ee7f7af93a5d9c3304bfdba76a1e1bca4acf87adca10d51837775a",
            amount: "0.834187617",
            asset: "TON",
            from: "UQA_C7P24M6orbnw-K9PyoFfdqvbQqcYokS204QVGb3p3Nhq",
            timestampMs: 1790788829000,
            native: true,
        });
        expect(parsed.filter((t) => t.asset === "USD₮").map((t) => t.amount)).toEqual(["1.0365", "138.619813"]);
    });

    it("the same account given as EQ/UQ friendly form resolves to the same raw key", () => {
        const { account } = fixture("ton-events.json");
        const { Address } = require("@ton/core");
        const friendly = Address.parse(account).toString({ bounceable: false });
        expect(ton.toRaw(friendly)).toBe(account);
    });

    it("scam-flagged events and unverified jettons are ignored; dust is left to the planner", () => {
        const { response, account } = fixture("ton-events-spam.json");
        const scam = response.events.filter((event) => event.is_scam);
        expect(scam.length).toBe(8);
        for (const event of scam) expect(ton.parseTonEvent(event, account)).toBeNull();

        const unverified = response.events.find((event) =>
            event.actions.some((a) => a.type === "JettonTransfer" && a.JettonTransfer.jetton.verification === "none")
        );
        expect(ton.parseTonEvent(unverified, account)).toBeNull();

        const parsed = response.events.map((event) => ton.parseTonEvent(event, account)).filter(Boolean);
        const dust = parsed.filter((t) => t.amount === "0.0001");
        expect(dust).toHaveLength(6);
        for (const t of dust) expect(passesValueFilter(t)).toBe(false);
    });

    it("a send is never a push, and the 0.00001 TON spam right after it is neither (#556)", () => {
        const { response, account } = fixture("ton-events-send-then-spam.json");
        const [spam, send] = response.events;
        expect(ton.parseTonEvent(send, account)).toBeNull();
        expect(ton.parseTonEvent(spam, account)).toBeNull();

        // Even if TonAPI had not flagged it yet when the watcher polled, it is dust for the planner.
        const unflagged = ton.parseTonEvent({ ...spam, is_scam: false }, account);
        expect(unflagged).toMatchObject({ network: "ton", hash: spam.event_id, amount: "0.00001", asset: "TON", native: true });
        expect(passesValueFilter(unflagged)).toBe(false);
    });
});

describe("stellar adapter (Horizon payments)", () => {
    it("payments to the account count, payments it made do not", () => {
        const { response, account } = fixture("stellar-payments.json");
        const records = response._embedded.records;
        const parsed = records.map((record) => stellar.parseStellarRecord(record, account));
        expect(parsed.filter(Boolean)).toHaveLength(38);
        expect(records.filter((r, i) => !parsed[i]).every((r) => r.from === account)).toBe(true);
        expect(parsed[0]).toEqual({
            network: "stellar",
            hash: "321f1cfd494f16a9da5ca556e497a1303075c5d49142bf43287959fd5ea19b8f",
            timestampMs: 1790788762000,
            amount: "0.001",
            asset: "XLM",
            from: "GBNRDIAXLVSBYQLHD4LW24BEV64JCWM54757YWLYDQZFV33XSUF52UAQ",
            native: true,
        });
        expect([...new Set(parsed.filter(Boolean).map((t) => t.asset))].sort()).toEqual(["USDC", "XLM"]);
    });

    it("create_account is the first funding (amount = starting balance)", () => {
        const { response, account } = fixture("stellar-create-account.json");
        expect(stellar.parseStellarRecord(response._embedded.records[0], account)).toMatchObject({
            hash: "9517a9b4b8b843cd0db09396aaa1ba0d471a35f5bb3af141f408929120fdffd3",
            amount: "1.01",
            asset: "XLM",
            from: "GBC7NMD7UZBEEV2ONYQ73X3J6PBOCE57W574F5GIRFM7XX4L6BVGQQLU",
        });
    });

    it("account_merge into the account is received with an unknown amount; accounts it created are not", () => {
        const { response, account } = fixture("stellar-account-merge.json");
        const [merge, ...created] = response._embedded.records;
        expect(stellar.parseStellarRecord(merge, account)).toMatchObject({ amount: null, asset: "XLM", from: "GCWP4R6G72I5E62HKAAW4TKDBWIRF4JRWNQ64S62LMMGO7HCZ2SEYO6J" });
        for (const record of created) expect(stellar.parseStellarRecord(record, account)).toBeNull();
    });
});

describe("sui adapter (GraphQL)", () => {
    it("positive SUI balance change for the address in a transaction someone else sent", () => {
        const { response, address } = fixture("sui-transactions.json");
        const parsed = response.data.transactions.nodes.map((node) => sui.parseSuiTransaction(node, address)).filter(Boolean);
        expect(parsed).toEqual([
            {
                network: "sui",
                hash: "4msw82FU7zpYbZz6TiocYxCDGmzGdyfTcMG5AQKPX95X",
                amount: "0.012195224",
                asset: "SUI",
                from: "0xd265672730b0540ffd3569530682a0f02ef984b703457790554eb0e19329663a",
                timestampMs: 1790789260287,
                native: true,
            },
        ]);
    });

    it("the sender of that transaction does not see it as received", () => {
        const { response, address } = fixture("sui-transactions.json");
        const node = response.data.transactions.nodes.find((n) => sui.parseSuiTransaction(n, address));
        expect(sui.parseSuiTransaction(node, node.sender.address)).toBeNull();
    });
});

describe("blockdag adapter (bdagscan)", () => {
    const { response, address } = fixture("blockdag-address-txs.json");

    it("native BDAG received", () => {
        const parsed = response.data.map((row) => blockdag.parseBlockdagTransaction(row, address)).filter(Boolean);
        expect(parsed).toHaveLength(25);
        expect(parsed[0]).toEqual({
            network: "blockdag",
            hash: "0x321ff3a95cc7fd95de3c4d611e99d5b415e20925fcbbbbbc2418b14a033c9e0c",
            amount: "13.053",
            asset: "BDAG",
            from: "0x432a023D1A98557B53aA32c9427e408AE2DD121B",
            timestampMs: 1790789372000,
            native: true,
        });
    });

    it("for the sender the same rows are outgoing", () => {
        const sender = response.data[0].from.toLowerCase();
        expect(response.data.map((row) => blockdag.parseBlockdagTransaction(row, sender)).filter(Boolean)).toHaveLength(0);
    });

    it("normalizes explorer values", () => {
        expect(blockdag.decimalValue("20")).toBe("20");
        expect(blockdag.decimalValue("13.0500")).toBe("13.05");
        expect(blockdag.decimalValue("1e-7")).toBe("0.0000001");
        expect(blockdag.decimalValue("0")).toBe("0");
        expect(blockdag.decimalValue("abc")).toBeNull();
    });
});

describe("EVM JSON-RPC adapter (BSC, and ETH/Polygon/Avalanche without Alchemy)", () => {
    it("BEP-20 Transfer logs of curated tokens become transfers with exact 18-decimal amounts", () => {
        const { response, request, owner } = fixture("bsc-get-logs.json");
        expect(request.topics[2]).toBe(evmRpc.padTopic(owner));
        const parsed = response.map((log) => evmRpc.parseTransferLog("bsc", log));
        expect(parsed.map((t) => [t.asset, t.amount])).toEqual([
            ["USDT", "73.505"],
            ["USDT", "97"],
            ["USDT", "550416.99999999997247488"],
            ["USDT", "1073.655750657841193457"],
            ["USDT", "3932"],
        ]);
        expect(parsed[0]).toMatchObject({ from: "0x3fc37b769b692c5dd7997ae03d62392e6ce0812d", timestampMs: 1790788952000, native: false });
    });

    it("the transaction lookup used for the own-send check returns the token sender here", () => {
        const { response, transactionOfFirstLog, owner } = fixture("bsc-get-logs.json");
        expect(transactionOfFirstLog.hash).toBe(response[0].transactionHash);
        expect(transactionOfFirstLog.from.toLowerCase()).not.toBe(owner);
    });

    it("ERC-20 on Ethereum uses the curated decimals (USDT has 6)", () => {
        const { response } = fixture("ethereum-get-logs.json");
        expect(evmRpc.parseTransferLog("ethereum", response[0])).toMatchObject({ asset: "USDT", amount: "4527.847817" });
    });

    it("logs of contracts outside the curated list are ignored", () => {
        const { response } = fixture("bsc-get-logs.json");
        expect(evmRpc.parseTransferLog("bsc", { ...response[0], address: "0x000000000000000000000000000000000000dead" })).toBeNull();
    });

    it("native BNB to the owner is found in a full block; a successful receipt confirms it", () => {
        const { block, receipt, owner } = fixture("bsc-block-native.json");
        const found = evmRpc.nativeTransfersInBlock("bsc", block, owner);
        expect(found).toEqual([
            {
                network: "bsc",
                hash: "0xd5ee6ee6ea912ae8df0dc6f3d303a5babf15d07b2df7164411185dd6a247ad33",
                amount: "100",
                asset: "BNB",
                from: "0x239bb39e1f264a1625df2d3bae783d102e16d82f",
                blockNumber: 124948194,
                timestampMs: 1790789142000,
                native: true,
            },
        ]);
        expect(receipt.status).toBe("0x1");
        expect(evmRpc.nativeTransfersInBlock("bsc", block, found[0].from)).toEqual([]);
    });
});

describe("EVM Alchemy adapter (Ethereum / Polygon / Avalanche)", () => {
    const { response, owner } = fixture("alchemy-asset-transfers.json");
    const rows = response.result.transfers;

    it("native (external) and curated ERC-20 rows become transfers, from rawContract values", () => {
        const parsed = rows.map((row) => alchemy.parseAlchemyTransfer("ethereum", row, owner));
        const byCategory = Object.fromEntries(rows.map((row, i) => [row.category === "erc20" ? row.asset : row.category, parsed[i]]));

        expect(byCategory.LINK).toBeNull();
        expect(byCategory.USDT).toMatchObject({ amount: "4527.847817", asset: "USDT", native: false, hash: "0x65df4f3b9025329d6d5eabc70af16ceba777243f6d1b63cc43f6a847cf8e4cc9" });
        expect(byCategory.external).toMatchObject({
            amount: "1.181844244575885",
            asset: "ETH",
            native: true,
            from: "0x6f7e32c8b14eeceb7f5b842570aff50967f7a2d6",
            timestampMs: 1790788991000,
        });
    });

    it("rows not addressed to the owner, self transfers and NFTs are ignored", () => {
        const external = rows.find((row) => row.category === "external");
        expect(alchemy.parseAlchemyTransfer("ethereum", { ...external, to: "0x000000000000000000000000000000000000dead" }, owner)).toBeNull();
        expect(alchemy.parseAlchemyTransfer("ethereum", { ...external, from: owner }, owner)).toBeNull();
        expect(alchemy.parseAlchemyTransfer("ethereum", { ...external, category: "erc721" }, owner)).toBeNull();
    });

    it("Polygon and Avalanche use their native symbol; Avalanche does not ask for internal transfers", () => {
        const external = rows.find((row) => row.category === "external");
        expect(alchemy.parseAlchemyTransfer("polygon", external, owner).asset).toBe("POL");
        expect(alchemy.parseAlchemyTransfer("avalanche", external, owner).asset).toBe("AVAX");
        expect(alchemy.CHAINS.avalanche.categories).not.toContain("internal");
    });

    it("a refused method or key switches the network to plain JSON-RPC; timeouts do not", () => {
        expect(isPermanentAlchemyFailure({ code: "ethereum_alchemy_rpc_-32601" })).toBe(true);
        expect(isPermanentAlchemyFailure({ code: "avalanche_alchemy_http_401" })).toBe(true);
        expect(isPermanentAlchemyFailure({ code: "ethereum_alchemy_http_429" })).toBe(false);
        expect(isPermanentAlchemyFailure({ code: "ethereum_alchemy_ECONNABORTED" })).toBe(false);
    });
});

describe("aptos adapter (Indexer + fullnode)", () => {
    const { deposits, transaction, owner } = fixture("aptos-deposits.json");
    const activities = deposits.response.data.fungible_asset_activities;
    const parsed = aptos.depositsByVersion(activities);

    it("keeps one curated, successful deposit per transaction version; withdrawals are dropped", () => {
        expect(activities).toHaveLength(25);
        expect(activities.some((a) => a.type === "0x1::fungible_asset::Withdraw")).toBe(true);
        expect(parsed).toHaveLength(10);
        expect(parsed.slice(0, 2)).toEqual([
            { version: "7429034601", seenId: "v7429034601", amount: "0.088835", asset: "USDC", native: false, timestampMs: 1790789205000 },
            { version: "7429034350", seenId: "v7429034350", amount: "0.01290077", asset: "APT", native: true, timestampMs: 1790789204000 },
        ]);
    });

    it("joins the fullnode transaction for the hash and the sender", () => {
        const deposit = parsed.find((d) => d.version === String(transaction.response.version));
        expect(aptos.toAptosTransfer(deposit, transaction.response, owner)).toEqual({
            network: "aptos",
            hash: "0xf990691448b604dd21533d176317313d3325cae03503c0f5b96a386d7ec2b911",
            seenId: "v7429034601",
            amount: "0.088835",
            asset: "USDC",
            from: "0xf870a3b5879362a5887008cff396f5ab9983aa5612a27db2edce0d2c9bfa4494",
            timestampMs: 1790789205000,
            native: false,
        });
    });

    it("a deposit inside a transaction the owner sent (a swap) or a failed one is not received", () => {
        const deposit = parsed.find((d) => d.version === String(transaction.response.version));
        expect(aptos.toAptosTransfer(deposit, { ...transaction.response, sender: owner }, owner)).toBeNull();
        expect(aptos.toAptosTransfer(deposit, { ...transaction.response, success: false }, owner)).toBeNull();
    });
});

const axios = require("axios");
const https = require("https");

const API_BALANCE_URL = "https://api.bdagscan.com/v1/api/transaction/getAddressInfo?address=0x1BC125bC681685f216935798453F70fb423eB392";
const API_TRANSACTIONS_URL = "https://api.bdagscan.com/v1/api/transaction/getTransactionByAddress";

const agent = new https.Agent({
    rejectUnauthorized: true,
});

const instance = axios.create({
    timeout: 10000,
    httpsAgent: agent,
});

const generateRandomUserAgent = () => {
    const userAgents = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
};

async function testBlockDagApi() {
    console.log("---------------------------------------------------");
    console.log("Testing BlockDAG Address Balance API...");
    console.log(`URL: ${API_BALANCE_URL}`);

    try {
        const balanceResponse = await instance.get(API_BALANCE_URL, {
            headers: {
                "Content-Type": "application/json",
                authority: "api.bdagscan.com",
                "User-Agent": generateRandomUserAgent(),
            },
        });

        console.log("Status:", balanceResponse.status);
        if (balanceResponse.data && balanceResponse.data.status === 200) {
            console.log("✅ SUCCESS: Balance API worked");
            console.log("Data snippet:", JSON.stringify(balanceResponse.data.data, null, 2));
        } else {
            console.log("❌ FAILED: Balance API returned unexpected status");
        }
    } catch (error) {
        console.error("❌ ERROR (Balance):", error.message);
    }

    console.log("\n---------------------------------------------------");
    console.log("Testing BlockDAG Transactions API...");
    console.log(`URL: ${API_TRANSACTIONS_URL}`);

    try {
        const txResponse = await instance.get(API_TRANSACTIONS_URL, {
            params: {
                address: "0x1BC125bC681685f216935798453F70fb423eB392",
                limit: 5,
                page: 1,
                export: false,
            },
            headers: {
                "Content-Type": "application/json",
                authority: "api.bdagscan.com",
                "User-Agent": generateRandomUserAgent(),
            },
        });

        console.log("Status:", txResponse.status);
        if (txResponse.data && txResponse.data.status === 200) {
            console.log("✅ SUCCESS: Transactions API worked");
            console.log(`Retrieved ${txResponse.data.data ? txResponse.data.data.length : 0} transactions`);
            if (txResponse.data.data && txResponse.data.data.length > 0) {
                console.log("First transaction sample:", JSON.stringify(txResponse.data.data[0], null, 2));
            }
        } else {
            console.log("❌ FAILED: Transactions API returned unexpected status");
            // console.log(JSON.stringify(txResponse.data, null, 2));
        }
    } catch (error) {
        console.error("❌ ERROR (Transactions):", error.message);
        if (error.response) {
            console.error("Error Response Data:", error.response.data);
        }
    }

    console.log("---------------------------------------------------");
    console.log("Testing BlockDAG Transaction Details API...");
    const txHash = "0xd21b0a14cca435a4348f719f417835b6d2c4461f21209125fd916f3230bfcf93";
    const API_TX_DETAILS_URL = `https://api.bdagscan.com/v1/api/transaction/getTransactionDetails?txnHash=${txHash}`;
    console.log(`URL: ${API_TX_DETAILS_URL}`);

    try {
        const txDetailResponse = await instance.get(API_TX_DETAILS_URL, {
            headers: {
                "Content-Type": "application/json",
                authority: "api.bdagscan.com",
                "User-Agent": generateRandomUserAgent(),
            },
        });

        console.log("Status:", txDetailResponse.status);
        if (txDetailResponse.data && txDetailResponse.data.status === 200) {
            console.log("✅ SUCCESS: Transaction Details API worked");
            console.log("Transaction Details:", JSON.stringify(txDetailResponse.data.data, null, 2));
        } else {
            console.log("❌ FAILED: Transaction Details API returned unexpected status");
        }
    } catch (error) {
        console.error("❌ ERROR (Tx Details):", error.message);
        if (error.response) {
            console.error("Error Response Data:", error.response.data);
        }
    }

    console.log("---------------------------------------------------");
    console.log("Testing BlockDAG Price API...");
    const API_PRICE_URL = "https://api.blockdagnetwork.io/api/v2/base/public/current_price";
    console.log(`URL: ${API_PRICE_URL}`);

    try {
        const priceResponse = await axios.get(API_PRICE_URL, {
            headers: {
                "Content-Type": "application/json",
                "User-Agent": generateRandomUserAgent(),
            },
            httpsAgent: agent,
        });

        console.log("Status:", priceResponse.status);
        if (priceResponse.data) {
            console.log("✅ SUCCESS: Price API worked");
            console.log("Price Data:", JSON.stringify(priceResponse.data, null, 2));
        } else {
            console.log("❌ FAILED: Price API returned no data");
        }
    } catch (error) {
        console.error("❌ ERROR (Price):", error.message);
        if (error.response) {
            console.error("Error Response Data:", error.response.data);
            console.error("Error Response Status:", error.response.status);
        }
    }
    console.log("---------------------------------------------------");
}

testBlockDagApi();

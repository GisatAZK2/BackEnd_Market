import fetch from "node-fetch";

const secretKey = "xnd_development_7bJW6B7fb2eerAUjR6QVijzwtX3UbqwAMGjpM3XP6bkSzfEK90trgNDVCrEN4RY"; 

async function testDisbursement() {
  const url = "https://api.xendit.co/disbursements";
  const payload = {
    external_id: `disb-test-${Date.now()}`,
    amount: 50000,
    bank_code: "BNI", // beda: disbursement pakai bank_code bukan channelCode
    account_holder_name: "Amba Dev",
    account_number: "1234567890",
    description: "Withdraw test (Disbursement API)"
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:
        "Basic " + Buffer.from(secretKey + ":").toString("base64"),
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  console.log("✅ Disbursement Response:", data);
}

testDisbursement().catch(console.error);

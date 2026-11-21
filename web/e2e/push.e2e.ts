// The broadcast page (docs/FRONTEND.md "Broadcast") against the scenario's chain: a pasted
// transaction is read without sending it, a known one is not offered for sending, a dear one asks
// for a second press, and one press sends a new one to the node.
import { chain, expect, test } from "./fixtures";

// The next block's rate may be refused while the server's fee level settles on regtest.
test.use({ consoleErrorsAllowed: [/status of 503/] });

// Spends the coinbase of block 11 (50 BTC to the miner script, anyone can spend): 1 BTC to the
// scenario's P2WPKH address, change back, 2 sat/vB. Built by the harness's own `build`, unsent.
// Only this test spends it; the tests that mine later take the oldest coin still unspent.
const send = {
  txid: "9ca18c8869ecad2c26267c6f3295543656b51b379a3c83326d4c9fd9af028016",
  hex:
    "020000000001019488942297c6a4b0af7f951be78acf0dad53e5309fdd908539283bc45c3e8973000000000" +
    "0fdffffff0200e1f505000000001600147503ccb2c772094595aa0491a48c29de61c04e6102101024010000" +
    "002200204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc3326001015100000000",
};
// Spends the coinbase of block 12 at 3,000 sat/vB. Never sent.
const dear =
  "0200000000010104d9ab606b34a528e27d9e32358fff4a6473f3875586779a3f29394b7b532350000000000" +
  "0fdffffff0200286bee000000001600147503ccb2c772094595aa0491a48c29de61c04e61b8f9943b000000" +
  "002200204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc3326001015100000000";

test("a pasted transaction is read before anything is sent, and one press sends it", async ({
  page,
  request,
}) => {
  await page.goto("/regtest/tx/push");
  await expect(
    page.getByRole("heading", { level: 1, name: "Broadcast a transaction" }),
  ).toBeVisible();
  const box = page.getByRole("textbox", { name: "Signed transaction in hex" });
  const button = page.getByRole("button", { name: /^Broadcast/ });

  // Not hex: said at once, with nothing asked.
  await box.fill("<script>");
  await expect(page.getByText("Not hex")).toBeVisible();

  // A confirmed transaction: its outputs and where it is, and nothing to send.
  const raw = await (await request.get(`/regtest/api/tx/${chain.txs.script_types}/hex`)).text();
  await box.fill(raw);
  await expect(page.getByText("Already confirmed")).toBeVisible();
  await expect(page.getByText("In block 106.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Inputs and outputs" })).toBeVisible();
  await expect(button).toHaveCount(0);
  // Its outputs as the node has them: the scenario spent two of them.
  await expect(page.getByRole("link", { name: /^Spent in transaction/ })).toHaveCount(2);

  // A dear one asks for a second thought before it can go.
  await box.fill(dear);
  await expect(page.getByText(/It pays 3.000 sat\/vB/)).toBeVisible();
  await expect(button).toHaveText("Broadcast anyway");

  // Hex wrapped over lines reads the same. Pressing sends it, and the node has it.
  await box.fill(send.hex.replaceAll(/(.{64})/g, "$1\n"));
  await expect(page.getByText("2.00 sat/vB").first()).toBeVisible();
  await expect(page.getByText("Check before you send")).toHaveCount(0);
  // What was never sent is neither spent nor unspent: no card says either.
  await expect(page.locator(".tx-flow").getByText("Unspent")).toHaveCount(0);
  await expect(page.locator(".tx-flow__status")).toHaveCount(0);
  await expect(button).toHaveText("Broadcast");
  // Before it is sent, what sending it would show (docs/FRONTEND.md "Privacy check").
  const notSent =
    "It is not sent yet: a wallet can still change which coins it spends and where the change goes.";
  await expect(
    page.getByRole("region", { name: "Once it is sent, anyone can read this from it" }),
  ).toContainText(notSent);
  await button.click();
  await expect(page.getByText("Sent", { exact: true })).toBeVisible();
  // Once sent, what the transaction page says: no "not sent yet".
  await expect(page.getByRole("region", { name: "What an observer can read" })).toBeVisible();
  await expect(page.getByText(notSent)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Follow it on its page" })).toHaveAttribute(
    "href",
    `/regtest/tx/${send.txid}`,
  );
  const tx = await request.get(`/regtest/api/tx/${send.txid}`);
  expect(await tx.json()).toMatchObject({ txid: send.txid, status: { confirmed: false } });

  // Read again, it is the node's now.
  await page.reload();
  await box.fill(send.hex);
  await expect(page.getByText("Already in the mempool")).toBeVisible();
  await expect(button).toHaveCount(0);
});

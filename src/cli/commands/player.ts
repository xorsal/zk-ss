/**
 * Player Commands - Game actions for participants
 *
 * Commands:
 * - enroll: Enroll in a game
 * - register: Register as sender (claim a slot)
 * - claim: Claim as receiver (select someone else's slot)
 * - delivery: View delivery data for your slot
 */

import { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode } from "@aztec/aztec.js/node";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { TestWallet } from "@aztec/test-wallet/server";
import { connectToContract, getGameInfo, PHASE, PHASE_NAMES } from "../services/contract.js";
import { getEncryptionPublicKey, getSponsoredPaymentMethod } from "../services/wallet.js";
import { encryptDeliveryData, decryptDeliveryData, isEncryptedDataEmpty } from "../services/crypto.js";
import { loadConfig, getContractAddress } from "../services/config.js";
import * as display from "../utils/display.js";
import * as prompts from "../utils/prompts.js";

/**
 * Enroll in a game.
 */
export async function enroll(
  wallet: TestWallet,
  callerAddress: AztecAddress,
  secretKey: Fr,
  node: AztecNode,
  options: { game?: number }
): Promise<void> {
  const contractAddress = getContractAddress();
  const contract = await connectToContract(
    wallet,
    AztecAddress.fromString(contractAddress),
    node
  );

  const config = loadConfig();
  const gameId = options.game ?? config.currentGameId;

  if (!gameId) {
    display.error("No game ID specified. Use --game <id>");
    return;
  }

  // Check phase
  const { phase, phaseName } = await getGameInfo(contract, BigInt(gameId), callerAddress);
  if (phase !== PHASE.ENROLLMENT) {
    display.error(`Cannot enroll. Game is in ${phaseName} phase.`);
    return;
  }

  display.step(`Enrolling in game #${gameId}...`);

  const paymentMethod = await getSponsoredPaymentMethod(wallet);
  await contract
    .withWallet(wallet)
    .methods.enroll(BigInt(gameId))
    .send({ from: callerAddress, fee: { paymentMethod } })
    .wait();

  display.success(`Enrolled in game #${gameId}!`);
  display.info("Wait for the admin to advance to Sender Registration phase.");
}

/**
 * Register as sender (claim a slot).
 */
export async function registerAsSender(
  wallet: TestWallet,
  callerAddress: AztecAddress,
  secretKey: Fr,
  node: AztecNode,
  options: { game?: number; slot?: number }
): Promise<void> {
  const contractAddress = getContractAddress();
  const contract = await connectToContract(
    wallet,
    AztecAddress.fromString(contractAddress),
    node
  );

  const config = loadConfig();
  const gameId = options.game ?? config.currentGameId;

  if (!gameId) {
    display.error("No game ID specified. Use --game <id>");
    return;
  }

  // Check phase
  const { phase, phaseName } = await getGameInfo(contract, BigInt(gameId), callerAddress);
  if (phase !== PHASE.SENDER_REGISTRATION) {
    display.error(`Cannot register as sender. Game is in ${phaseName} phase.`);
    return;
  }

  // Get slot
  let slot = options.slot;
  if (!slot) {
    slot = await prompts.promptSlot("Choose a slot number to claim:");
  }

  // Check if slot is already claimed
  const isClaimed = await contract.methods
    .is_slot_claimed(BigInt(gameId), slot)
    .simulate({ from: callerAddress });

  if (isClaimed) {
    display.error(`Slot ${slot} is already claimed. Choose a different slot.`);
    return;
  }

  // Get encryption public key from secret key
  display.step("Deriving encryption key...");
  const encryptionKey = await getEncryptionPublicKey(secretKey);

  display.step(`Registering as sender for slot ${slot}...`);

  const paymentMethod = await getSponsoredPaymentMethod(wallet);
  await contract
    .withWallet(wallet)
    .methods.register_as_sender(BigInt(gameId), slot, encryptionKey)
    .send({ from: callerAddress, fee: { paymentMethod } })
    .wait();

  display.success(`Registered as sender for slot ${slot}!`);
  display.keyValue("Your slot", slot.toString());
  display.info("Your encryption key has been published. Wait for Receiver Claim phase.");
}

/**
 * Claim as receiver (select someone else's slot).
 *
 * Self-selection is prevented via nullifier collision: if you try to claim your
 * own slot, you push the same nullifier twice and the transaction reverts.
 */
export async function claimAsReceiver(
  wallet: TestWallet,
  callerAddress: AztecAddress,
  secretKey: Fr,
  node: AztecNode,
  options: { game?: number; slot?: number }
): Promise<void> {
  const contractAddress = getContractAddress();
  const contract = await connectToContract(
    wallet,
    AztecAddress.fromString(contractAddress),
    node
  );

  const config = loadConfig();
  const gameId = options.game ?? config.currentGameId;

  if (!gameId) {
    display.error("No game ID specified. Use --game <id>");
    return;
  }

  // Check phase
  const { phase, phaseName } = await getGameInfo(contract, BigInt(gameId), callerAddress);
  if (phase !== PHASE.RECEIVER_CLAIM) {
    display.error(`Cannot claim as receiver. Game is in ${phaseName} phase.`);
    return;
  }

  // Get target slot
  let targetSlot = options.slot;
  if (!targetSlot) {
    targetSlot = await prompts.promptSlot("Choose a slot to claim as receiver:");
  }

  // Check if slot is claimed (as sender)
  const isClaimed = await contract.methods
    .is_slot_claimed(BigInt(gameId), targetSlot)
    .simulate({ from: callerAddress });

  if (!isClaimed) {
    display.error(`Slot ${targetSlot} has no sender. Choose a different slot.`);
    return;
  }

  // Get sender's encryption key for the slot
  const senderKey = await contract.methods
    .get_slot_encryption_key(BigInt(gameId), BigInt(targetSlot))
    .simulate({ from: callerAddress });

  display.info(`Slot ${targetSlot} sender's public key: ${display.formatAddress(senderKey.x.toString())}`);

  // Get delivery address from user
  const deliveryAddress = await prompts.promptDeliveryAddress();

  // Encrypt delivery address using the sender's public key (real ECIES encryption)
  // Issue 5 fix: Now supports up to 111 bytes (8 field elements)
  display.step("Encrypting delivery address with sender's public key...");

  let encryptedDeliveryData: [Fr, Fr, Fr, Fr, Fr, Fr, Fr, Fr];
  try {
    encryptedDeliveryData = await encryptDeliveryData(deliveryAddress, senderKey);
    display.success("Delivery address encrypted!");
  } catch (err: any) {
    display.error(`Encryption failed: ${err.message}`);
    return;
  }

  display.step(`Claiming slot ${targetSlot} as receiver...`);

  // If we try to claim our own slot, the transaction will revert due to nullifier collision
  const paymentMethod = await getSponsoredPaymentMethod(wallet);
  await contract
    .withWallet(wallet)
    .methods.claim_as_receiver(
      BigInt(gameId),
      targetSlot,
      encryptedDeliveryData
    )
    .send({ from: callerAddress, fee: { paymentMethod } })
    .wait();

  display.success(`Claimed slot ${targetSlot} as receiver!`);
  display.info("Your encrypted delivery address has been stored.");
  display.info("The sender of slot " + targetSlot + " will send you a gift!");
}

/**
 * View delivery data for your slot.
 */
export async function viewDeliveryData(
  wallet: TestWallet,
  callerAddress: AztecAddress,
  secretKey: Fr,
  node: AztecNode,
  options: { game?: number; slot?: number }
): Promise<void> {
  const contractAddress = getContractAddress();
  const contract = await connectToContract(
    wallet,
    AztecAddress.fromString(contractAddress),
    node
  );

  const config = loadConfig();
  const gameId = options.game ?? config.currentGameId;

  if (!gameId) {
    display.error("No game ID specified. Use --game <id>");
    return;
  }

  // Check phase
  const { phase, phaseName } = await getGameInfo(contract, BigInt(gameId), callerAddress);
  if (phase < PHASE.RECEIVER_CLAIM) {
    display.error(`No delivery data yet. Game is in ${phaseName} phase.`);
    return;
  }

  // Get slot
  let slot = options.slot;
  if (!slot) {
    slot = await prompts.promptSlot("Enter your sender slot number:");
  }

  display.step(`Retrieving delivery data for slot ${slot}...`);

  try {
    const deliveryData = await contract.methods
      .get_slot_delivery_data(BigInt(gameId), BigInt(slot))
      .simulate({ from: callerAddress });

    // Issue 5 fix: Now using 8 fields instead of 4
    if (isEncryptedDataEmpty([
      deliveryData[0], deliveryData[1], deliveryData[2], deliveryData[3],
      deliveryData[4], deliveryData[5], deliveryData[6], deliveryData[7]
    ])) {
      display.warn(`No delivery data found for slot ${slot}.`);
      display.info("The receiver may not have claimed this slot yet.");
      return;
    }

    display.header("Encrypted Delivery Data");
    display.keyValue("Ephemeral PubKey X", deliveryData[0].toString().slice(0, 20) + "...");
    display.keyValue("Ephemeral PubKey Y", deliveryData[1].toString().slice(0, 20) + "...");
    display.keyValue("Ciphertext (6 fields)", "...");

    // Decrypt using the sender's private key (derived from the passphrase secret)
    display.step("Decrypting with your private key...");

    try {
      // Derive the encryption private key from the secret key
      // This is the same key that was used to generate the public key during registration
      const encryptionPrivateKey = deriveSigningKey(secretKey);

      const decryptedAddress = await decryptDeliveryData(
        [
          deliveryData[0], deliveryData[1], deliveryData[2], deliveryData[3],
          deliveryData[4], deliveryData[5], deliveryData[6], deliveryData[7]
        ],
        encryptionPrivateKey
      );

      display.header("Decrypted Delivery Data");
      display.success("Decryption successful!");
      display.keyValue("Delivery Address", decryptedAddress);
      display.divider();
      display.info("Ship your gift to this address!");
    } catch (decryptErr: any) {
      display.warn("Decryption failed. This could mean:");
      display.info("  - You're not the sender of this slot");
      display.info("  - The data wasn't encrypted with your public key");
      display.info("  - The encrypted data is corrupted");
      display.keyValue("Error", decryptErr.message);
    }
  } catch (err: any) {
    display.error(`Failed to get delivery data: ${err.message}`);
  }
}

/**
 * Register player commands with commander.
 */
export function registerPlayerCommands(
  program: Command,
  getWallet: () => Promise<{ wallet: TestWallet; accountAddress: AztecAddress; secretKey: Fr; node: AztecNode }>
): void {
  program
    .command("enroll")
    .description("Enroll in a Secret Santa game")
    .option("--game <id>", "Game ID", parseInt)
    .action(async (options) => {
      try {
        const { wallet, accountAddress, secretKey, node } = await getWallet();
        await enroll(wallet, accountAddress, secretKey, node, options);
      } catch (err: any) {
        display.error(err.message);
        process.exit(1);
      }
    });

  program
    .command("register")
    .description("Register as sender (claim a slot)")
    .option("--game <id>", "Game ID", parseInt)
    .option("--slot <number>", "Slot number to claim", parseInt)
    .action(async (options) => {
      try {
        const { wallet, accountAddress, secretKey, node } = await getWallet();
        await registerAsSender(wallet, accountAddress, secretKey, node, options);
      } catch (err: any) {
        display.error(err.message);
        process.exit(1);
      }
    });

  program
    .command("claim")
    .description("Claim as receiver (select a slot to receive from)")
    .option("--game <id>", "Game ID", parseInt)
    .option("--slot <number>", "Slot number to claim", parseInt)
    .action(async (options) => {
      try {
        const { wallet, accountAddress, secretKey, node } = await getWallet();
        await claimAsReceiver(wallet, accountAddress, secretKey, node, {
          game: options.game,
          slot: options.slot,
        });
      } catch (err: any) {
        display.error(err.message);
        process.exit(1);
      }
    });

  program
    .command("delivery")
    .description("View delivery data for your slot")
    .option("--game <id>", "Game ID", parseInt)
    .option("--slot <number>", "Your sender slot number", parseInt)
    .action(async (options) => {
      try {
        const { wallet, accountAddress, secretKey, node } = await getWallet();
        await viewDeliveryData(wallet, accountAddress, secretKey, node, options);
      } catch (err: any) {
        display.error(err.message);
        process.exit(1);
      }
    });
}

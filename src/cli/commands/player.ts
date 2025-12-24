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
import { connectToContract, getGameInfo, getGameState, PHASE, PHASE_NAMES } from "../services/contract.js";
import { getEncryptionPublicKey, getSponsoredPaymentMethod } from "../services/wallet.js";
import { encryptDeliveryData, decryptDeliveryData, isEncryptedDataEmpty } from "../services/crypto.js";
import { getContractAddress, getEffectiveGameId } from "../services/config.js";
import * as display from "../utils/display.js";
import * as prompts from "../utils/prompts.js";
import type { SecretSantaContract } from "../../../artifacts/SecretSanta.js";

const POLL_INTERVAL_MS = 12000; // 12 seconds

/**
 * Poll for phase change. Returns when phase changes from currentPhase.
 */
async function waitForPhaseChange(
  contract: SecretSantaContract,
  gameId: bigint,
  currentPhase: number,
  callerAddress: AztecAddress
): Promise<number> {
  display.divider();
  display.info(`Waiting for phase change... (polling every ${POLL_INTERVAL_MS / 1000}s, Ctrl+C to exit)`);

  let lastPhase = currentPhase;

  while (true) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    try {
      const { phase, phaseName } = await getGameInfo(contract, gameId, callerAddress);

      if (phase !== lastPhase) {
        display.divider();
        display.success(`Phase changed to: ${phaseName}`);
        return phase;
      }

      // Show a dot to indicate we're still polling
      process.stdout.write(".");
    } catch (err) {
      // Ignore errors during polling, just keep trying
      process.stdout.write("x");
    }
  }
}

/**
 * Enroll in a game.
 */
export async function enroll(
  wallet: TestWallet,
  callerAddress: AztecAddress,
  secretKey: Fr,
  node: AztecNode,
  options: { game?: number }
): Promise<{ contract: SecretSantaContract; gameId: number } | void> {
  const contractAddress = getContractAddress();
  const contract = await connectToContract(
    wallet,
    AztecAddress.fromString(contractAddress),
    node
  );

  const gameId = getEffectiveGameId(options.game);

  if (!gameId) {
    display.error("No game ID specified. Use --game <id> or set GAME env var");
    return;
  }

  // Check phase
  const { phase, phaseName } = await getGameInfo(contract, BigInt(gameId), callerAddress);
  if (phase !== PHASE.JOIN) {
    display.error(`Cannot enroll. Game is in ${phaseName} phase.`);
    return;
  }

  display.step(`Enrolling in game #${gameId}...`);

  const paymentMethod = await getSponsoredPaymentMethod(wallet);
  const txStart = Date.now();
  await contract
    .withWallet(wallet)
    .methods.enroll(BigInt(gameId))
    .send({ from: callerAddress, fee: { paymentMethod } })
    .wait();
  const txDuration = Date.now() - txStart;

  display.success(`Enrolled in game #${gameId}!`);
  display.txTiming("Transaction time", txDuration);

  // Wait for phase change
  const newPhase = await waitForPhaseChange(contract, BigInt(gameId), PHASE.JOIN, callerAddress);

  if (newPhase === PHASE.CLAIM) {
    display.info("You can now register as a sender. Pick a slot number.");
    return { contract, gameId };
  }
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
): Promise<{ contract: SecretSantaContract; gameId: number; senderSlot: number } | void> {
  const contractAddress = getContractAddress();
  const contract = await connectToContract(
    wallet,
    AztecAddress.fromString(contractAddress),
    node
  );

  const gameId = getEffectiveGameId(options.game);

  if (!gameId) {
    display.error("No game ID specified. Use --game <id> or set GAME env var");
    return;
  }

  // Get full game state in single RPC call
  display.step("Fetching game state...");
  const state = await getGameState(contract, BigInt(gameId), callerAddress);
  if (state.phase !== PHASE.CLAIM) {
    display.error(`Cannot register as sender. Game is in ${state.phaseName} phase.`);
    return;
  }

  // Get slot - with live polling if interactive
  let slot = options.slot;
  if (!slot) {
    const availableSlots: number[] = [];
    for (let i = 1; i <= state.participantCount; i++) {
      if (!state.senderSlots.includes(i)) {
        availableSlots.push(i);
      }
    }
    if (availableSlots.length === 0) {
      display.error("No available slots remaining.");
      return;
    }

    // Create state fetcher for live polling
    const fetchState = async () => {
      const newState = await getGameState(contract, BigInt(gameId), callerAddress);
      return {
        senderSlots: newState.senderSlots,
        receiverSlots: newState.receiverSlots,
        participantCount: newState.participantCount,
      };
    };

    slot = await prompts.promptSlotWithPolling(
      "sender",
      { senderSlots: state.senderSlots, receiverSlots: state.receiverSlots, participantCount: state.participantCount },
      fetchState,
      POLL_INTERVAL_MS
    );
  } else {
    // Validate provided slot is available
    if (state.senderSlots.includes(slot)) {
      display.error(`Slot ${slot} is already claimed. Choose a different slot.`);
      return;
    }
  }

  // Get encryption public key from secret key
  display.step("Deriving encryption key...");
  const encryptionKey = await getEncryptionPublicKey(secretKey);

  display.step(`Registering as sender for slot ${slot}...`);

  const paymentMethod = await getSponsoredPaymentMethod(wallet);
  const txStart = Date.now();
  await contract
    .withWallet(wallet)
    .methods.register_as_sender(BigInt(gameId), slot, encryptionKey)
    .send({ from: callerAddress, fee: { paymentMethod } })
    .wait();
  const txDuration = Date.now() - txStart;

  display.success(`Registered as sender for slot ${slot}!`);
  display.keyValue("Your slot", slot.toString());
  display.txTiming("Transaction time", txDuration);

  // Wait for phase change
  const newPhase = await waitForPhaseChange(contract, BigInt(gameId), PHASE.CLAIM, callerAddress);

  if (newPhase === PHASE.MATCH) {
    display.info("You can now claim as a receiver. Your slot will be auto-assigned.");
    return { contract, gameId, senderSlot: slot };
  }
}

/**
 * Claim as receiver using cyclic permutation.
 *
 * Your receiver slot is automatically assigned: (your_sender_slot % participant_count) + 1
 * This guarantees a valid derangement (no one receives from themselves).
 */
export async function claimAsReceiver(
  wallet: TestWallet,
  callerAddress: AztecAddress,
  secretKey: Fr,
  node: AztecNode,
  options: { game?: number; senderSlot?: number }
): Promise<{ contract: SecretSantaContract; gameId: number; senderSlot: number } | void> {
  const contractAddress = getContractAddress();
  const contract = await connectToContract(
    wallet,
    AztecAddress.fromString(contractAddress),
    node
  );

  const gameId = getEffectiveGameId(options.game);

  if (!gameId) {
    display.error("No game ID specified. Use --game <id> or set GAME env var");
    return;
  }

  // Get full game state in single RPC call
  display.step("Fetching game state...");
  const state = await getGameState(contract, BigInt(gameId), callerAddress);
  if (state.phase !== PHASE.MATCH) {
    display.error(`Cannot claim as receiver. Game is in ${state.phaseName} phase.`);
    return;
  }

  // Get sender slot (from options or prompt)
  let senderSlot = options.senderSlot;
  if (!senderSlot) {
    senderSlot = await prompts.promptSlot("Enter YOUR sender slot number:");
  }

  // Calculate receiver slot using cyclic permutation: (sender_slot % count) + 1
  const participantCount = state.participantCount;
  const targetSlot = (senderSlot % participantCount) + 1;

  display.info(`Your sender slot: ${senderSlot}`);
  display.info(`Assigned receiver slot (cyclic): ${targetSlot}`);

  // Get sender's encryption key for the target slot
  const senderKey = await contract.methods
    .get_slot_encryption_key(BigInt(gameId), BigInt(targetSlot))
    .simulate({ from: callerAddress });

  display.info(`Slot ${targetSlot} sender's public key: ${display.formatAddress(senderKey.x.toString())}`);

  // Get delivery address from user
  const deliveryAddress = await prompts.promptDeliveryAddress();

  // Encrypt delivery address using the sender's public key
  display.step("Encrypting delivery address with sender's public key...");

  let encryptedDeliveryData: [Fr, Fr, Fr, Fr, Fr, Fr, Fr, Fr];
  try {
    encryptedDeliveryData = await encryptDeliveryData(deliveryAddress, senderKey);
    display.success("Delivery address encrypted!");
  } catch (err: any) {
    display.error(`Encryption failed: ${err.message}`);
    return;
  }

  display.step(`Claiming as receiver (slot ${targetSlot} auto-assigned)...`);

  const paymentMethod = await getSponsoredPaymentMethod(wallet);
  const txStart = Date.now();
  await contract
    .withWallet(wallet)
    .methods.claim_receiver(
      BigInt(gameId),
      participantCount,
      encryptedDeliveryData
    )
    .send({ from: callerAddress, fee: { paymentMethod } })
    .wait();
  const txDuration = Date.now() - txStart;

  display.success(`Claimed as receiver! You will receive from slot ${targetSlot}.`);
  display.txTiming("Transaction time", txDuration);
  display.info("Your encrypted delivery address has been stored.");
  display.info(`The sender of slot ${targetSlot} will send you a gift!`);

  // Wait for phase change
  const newPhase = await waitForPhaseChange(contract, BigInt(gameId), PHASE.MATCH, callerAddress);

  if (newPhase === PHASE.REVEAL) {
    display.info("Game complete! You can now view your recipient's delivery address.");
    return { contract, gameId, senderSlot };
  }
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

  const gameId = getEffectiveGameId(options.game);

  if (!gameId) {
    display.error("No game ID specified. Use --game <id> or set GAME env var");
    return;
  }

  // Check phase
  const { phase, phaseName } = await getGameInfo(contract, BigInt(gameId), callerAddress);
  if (phase < PHASE.MATCH) {
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
        const result = await enroll(wallet, accountAddress, secretKey, node, options);

        // Chain to register if phase changed
        if (result) {
          // Fetch slot availability using single RPC call
          const regState = await getGameState(result.contract, BigInt(result.gameId), accountAddress);

          // Create state fetcher for live polling
          const fetchRegState = async () => {
            const s = await getGameState(result.contract, BigInt(result.gameId), accountAddress);
            return { senderSlots: s.senderSlots, receiverSlots: s.receiverSlots, participantCount: s.participantCount };
          };

          const slot = await prompts.promptSlotWithPolling(
            "sender",
            { senderSlots: regState.senderSlots, receiverSlots: regState.receiverSlots, participantCount: regState.participantCount },
            fetchRegState,
            POLL_INTERVAL_MS
          );
          const registerResult = await registerAsSenderInternal(
            wallet, accountAddress, secretKey, result.contract, result.gameId, slot
          );

          // Chain to claim if phase changed
          if (registerResult) {
            // No slot selection needed - cyclic assignment handles it automatically
            const claimResult = await claimAsReceiverInternal(
              wallet, accountAddress, secretKey, registerResult.contract,
              registerResult.gameId, registerResult.senderSlot
            );

            // Chain to delivery if phase changed
            if (claimResult) {
              await viewDeliveryData(wallet, accountAddress, secretKey, node, {
                game: claimResult.gameId,
                slot: claimResult.senderSlot,
              });
            }
          }
        }
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
        const result = await registerAsSender(wallet, accountAddress, secretKey, node, options);

        // Chain to claim if phase changed
        if (result) {
          // No slot selection needed - cyclic assignment handles it automatically
          const claimResult = await claimAsReceiverInternal(
            wallet, accountAddress, secretKey, result.contract,
            result.gameId, result.senderSlot
          );

          // Chain to delivery if phase changed
          if (claimResult) {
            await viewDeliveryData(wallet, accountAddress, secretKey, node, {
              game: claimResult.gameId,
              slot: claimResult.senderSlot,
            });
          }
        }
      } catch (err: any) {
        display.error(err.message);
        process.exit(1);
      }
    });

  program
    .command("claim")
    .description("Claim as receiver (auto-assigned via cyclic permutation)")
    .option("--game <id>", "Game ID", parseInt)
    .option("--sender-slot <number>", "Your sender slot number", parseInt)
    .action(async (options) => {
      try {
        const { wallet, accountAddress, secretKey, node } = await getWallet();
        const result = await claimAsReceiver(wallet, accountAddress, secretKey, node, {
          game: options.game,
          senderSlot: options.senderSlot,
        });

        // Chain to delivery if phase changed
        if (result) {
          await viewDeliveryData(wallet, accountAddress, secretKey, node, {
            game: result.gameId,
            slot: result.senderSlot,
          });
        }
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

/**
 * Internal register function that reuses existing contract connection.
 */
async function registerAsSenderInternal(
  wallet: TestWallet,
  callerAddress: AztecAddress,
  secretKey: Fr,
  contract: SecretSantaContract,
  gameId: number,
  slot: number
): Promise<{ contract: SecretSantaContract; gameId: number; senderSlot: number } | void> {
  // Check if slot is already claimed using single RPC call
  const state = await getGameState(contract, BigInt(gameId), callerAddress);

  if (state.senderSlots.includes(slot)) {
    display.error(`Slot ${slot} is already claimed. Choose a different slot.`);
    return;
  }

  // Get encryption public key from secret key
  display.step("Deriving encryption key...");
  const encryptionKey = await getEncryptionPublicKey(secretKey);

  display.step(`Registering as sender for slot ${slot}...`);

  const paymentMethod = await getSponsoredPaymentMethod(wallet);
  const txStart = Date.now();
  await contract
    .withWallet(wallet)
    .methods.register_as_sender(BigInt(gameId), slot, encryptionKey)
    .send({ from: callerAddress, fee: { paymentMethod } })
    .wait();
  const txDuration = Date.now() - txStart;

  display.success(`Registered as sender for slot ${slot}!`);
  display.keyValue("Your slot", slot.toString());
  display.txTiming("Transaction time", txDuration);

  // Wait for phase change
  const newPhase = await waitForPhaseChange(contract, BigInt(gameId), PHASE.CLAIM, callerAddress);

  if (newPhase === PHASE.MATCH) {
    display.info("You can now claim as a receiver. Your slot will be auto-assigned.");
    return { contract, gameId, senderSlot: slot };
  }
}

/**
 * Internal claim function that reuses existing contract connection.
 * Uses cyclic permutation to auto-assign receiver slot.
 */
async function claimAsReceiverInternal(
  wallet: TestWallet,
  callerAddress: AztecAddress,
  secretKey: Fr,
  contract: SecretSantaContract,
  gameId: number,
  senderSlot: number
): Promise<{ contract: SecretSantaContract; gameId: number; senderSlot: number } | void> {
  // Get game state for participant count
  const state = await getGameState(contract, BigInt(gameId), callerAddress);

  // Calculate receiver slot using cyclic permutation: (sender_slot % count) + 1
  const participantCount = state.participantCount;
  const targetSlot = (senderSlot % participantCount) + 1;

  display.info(`Your sender slot: ${senderSlot}`);
  display.info(`Assigned receiver slot (cyclic): ${targetSlot}`);

  // Get sender's encryption key for the slot
  const senderKey = await contract.methods
    .get_slot_encryption_key(BigInt(gameId), BigInt(targetSlot))
    .simulate({ from: callerAddress });

  display.info(`Slot ${targetSlot} sender's public key: ${display.formatAddress(senderKey.x.toString())}`);

  // Get delivery address from user
  const deliveryAddress = await prompts.promptDeliveryAddress();

  display.step("Encrypting delivery address with sender's public key...");

  let encryptedDeliveryData: [Fr, Fr, Fr, Fr, Fr, Fr, Fr, Fr];
  try {
    encryptedDeliveryData = await encryptDeliveryData(deliveryAddress, senderKey);
    display.success("Delivery address encrypted!");
  } catch (err: any) {
    display.error(`Encryption failed: ${err.message}`);
    return;
  }

  display.step(`Claiming as receiver (slot ${targetSlot} auto-assigned)...`);

  const paymentMethod = await getSponsoredPaymentMethod(wallet);
  const txStart = Date.now();
  await contract
    .withWallet(wallet)
    .methods.claim_receiver(
      BigInt(gameId),
      participantCount,
      encryptedDeliveryData
    )
    .send({ from: callerAddress, fee: { paymentMethod } })
    .wait();
  const txDuration = Date.now() - txStart;

  display.success(`Claimed as receiver! You will receive from slot ${targetSlot}.`);
  display.txTiming("Transaction time", txDuration);
  display.info("Your encrypted delivery address has been stored.");
  display.info(`The sender of slot ${targetSlot} will send you a gift!`);

  // Wait for phase change
  const newPhase = await waitForPhaseChange(contract, BigInt(gameId), PHASE.MATCH, callerAddress);

  if (newPhase === PHASE.REVEAL) {
    display.info("Game complete! You can now view your recipient's delivery address.");
    return { contract, gameId, senderSlot };
  }
}

/**
 * ZK Secret Santa - End-to-End Test
 *
 * This test covers the full Secret Santa game flow:
 * 1. Deploy contract
 * 2. Create a game
 * 3. Enroll 3 participants
 * 4. Advance to sender registration
 * 5. Each participant registers with a unique slot + encryption pubkey
 * 6. Advance to receiver claim
 * 7. Each participant claims a different slot with encrypted delivery data
 * 8. Complete the game
 * 9. Senders retrieve and decrypt delivery data
 *
 * PREREQUISITES:
 * - Run the Aztec sandbox: `aztec start --sandbox`
 * - The sandbox provides pre-funded test accounts
 */

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { INITIAL_TEST_SECRET_KEYS } from "@aztec/accounts/testing";
import { deriveMasterIncomingViewingSecretKey, derivePublicKeyFromSecretKey } from "@aztec/stdlib/keys";
import type { GrumpkinScalar } from "@aztec/foundation/curves/grumpkin";
import { deploySecretSanta, setupTestSuite } from "./utils.js";
import { SecretSantaContract } from "../../artifacts/SecretSanta.js";
import { encryptDeliveryData, decryptDeliveryData } from "../cli/services/crypto.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const PHASE_ENROLLMENT = 1;
const PHASE_SENDER_REGISTRATION = 2;
const PHASE_RECEIVER_CLAIM = 3;
const PHASE_COMPLETED = 4;

describe("Secret Santa Contract E2E", () => {
  let pxe: Awaited<ReturnType<typeof setupTestSuite>>["pxe"];
  let store: Awaited<ReturnType<typeof setupTestSuite>>["store"];
  let wallet: Awaited<ReturnType<typeof setupTestSuite>>["wallet"];
  let accounts: AztecAddress[];

  // Alice is both owner/admin AND a participant
  let alice: AztecAddress;
  let bob: AztecAddress;
  let carl: AztecAddress;

  let contract: SecretSantaContract;
  let gameId: bigint;

  // Encryption keypairs derived from test account secrets
  let alicePrivateKey: GrumpkinScalar;
  let bobPrivateKey: GrumpkinScalar;
  let carlPrivateKey: GrumpkinScalar;
  let aliceEncryptionKey: { x: Fr; y: Fr; is_infinite: boolean };
  let bobEncryptionKey: { x: Fr; y: Fr; is_infinite: boolean };
  let carlEncryptionKey: { x: Fr; y: Fr; is_infinite: boolean };

  beforeAll(async () => {
    ({ pxe, store, wallet, accounts } = await setupTestSuite());
    // Alice is both owner AND participant
    [alice, bob, carl] = accounts;
    console.log("Connected to Aztec sandbox with test accounts");
    console.log(`  Alice (owner + participant): ${alice.toString()}`);
    console.log(`  Bob (participant): ${bob.toString()}`);
    console.log(`  Carl (participant): ${carl.toString()}`);

    // Derive deterministic encryption keypairs from test account secrets
    // These use the same keys as Aztec's master incoming viewing keys
    alicePrivateKey = deriveMasterIncomingViewingSecretKey(INITIAL_TEST_SECRET_KEYS[0]);
    bobPrivateKey = deriveMasterIncomingViewingSecretKey(INITIAL_TEST_SECRET_KEYS[1]);
    carlPrivateKey = deriveMasterIncomingViewingSecretKey(INITIAL_TEST_SECRET_KEYS[2]);

    const alicePubKey = await derivePublicKeyFromSecretKey(alicePrivateKey);
    const bobPubKey = await derivePublicKeyFromSecretKey(bobPrivateKey);
    const carlPubKey = await derivePublicKeyFromSecretKey(carlPrivateKey);

    // Convert Point to the format expected by the contract
    aliceEncryptionKey = { x: new Fr(alicePubKey.x.toBigInt()), y: new Fr(alicePubKey.y.toBigInt()), is_infinite: alicePubKey.isInfinite };
    bobEncryptionKey = { x: new Fr(bobPubKey.x.toBigInt()), y: new Fr(bobPubKey.y.toBigInt()), is_infinite: bobPubKey.isInfinite };
    carlEncryptionKey = { x: new Fr(carlPubKey.x.toBigInt()), y: new Fr(carlPubKey.y.toBigInt()), is_infinite: carlPubKey.isInfinite };

    console.log("Derived encryption keys from account secrets");
  });

  afterAll(async () => {
    await store.delete();
  });

  it("full secret santa game flow", async () => {
    // ============================================================
    // STEP 1: Deploy the contract (Alice is the contract owner)
    // ============================================================
    console.log("\n--- Step 1: Deploying contract ---");
    contract = await deploySecretSanta(wallet, alice);
    console.log(`SecretSanta contract deployed at ${contract.address}`);

    // ============================================================
    // STEP 2: Alice (owner) creates a game with exactly 3 participants
    // ============================================================
    console.log("\n--- Step 2: Alice creating game ---");
    await contract.methods
      .create_game(3, 3) // min 3, max 3 participants
      .send({ from: alice })
      .wait();

    gameId = (await contract.methods.get_next_game_id().simulate({ from: alice })) - 1n;
    console.log(`Game created with ID: ${gameId}`);

    const initialPhase = await contract.methods.get_game_phase(gameId).simulate({ from: alice });
    expect(initialPhase).toBe(BigInt(PHASE_ENROLLMENT));

    // ============================================================
    // STEP 3: Enroll 3 participants
    // ============================================================
    console.log("\n--- Step 3: Enrolling participants ---");

    await contract.withWallet(wallet).methods.enroll(gameId).send({ from: alice }).wait();
    await contract.withWallet(wallet).methods.enroll(gameId).send({ from: bob }).wait();
    await contract.withWallet(wallet).methods.enroll(gameId).send({ from: carl }).wait();

    const participantCount = await contract.methods.get_participant_count(gameId).simulate({ from: alice });
    expect(participantCount).toBe(3n);

    // ============================================================
    // STEP 4: Alice (owner) advances to SENDER_REGISTRATION phase
    // ============================================================
    console.log("\n--- Step 4: Alice advancing to SENDER_REGISTRATION ---");
    await contract.methods.advance_phase(gameId).send({ from: alice }).wait();

    const senderPhase = await contract.methods.get_game_phase(gameId).simulate({ from: alice });
    expect(senderPhase).toBe(BigInt(PHASE_SENDER_REGISTRATION));

    // ============================================================
    // STEP 5: Each participant registers as sender with a slot + encryption key
    // Encryption keys are derived from test account secrets in beforeAll
    // ============================================================
    console.log("\n--- Step 5: Registering senders with encryption keys ---");

    await contract.withWallet(wallet).methods.register_as_sender(gameId, 1, aliceEncryptionKey).send({ from: alice }).wait();
    await contract.withWallet(wallet).methods.register_as_sender(gameId, 2, bobEncryptionKey).send({ from: bob }).wait();
    await contract.withWallet(wallet).methods.register_as_sender(gameId, 3, carlEncryptionKey).send({ from: carl }).wait();

    expect(await contract.methods.is_slot_claimed(gameId, 1).simulate({ from: alice })).toBe(true);
    expect(await contract.methods.is_slot_claimed(gameId, 2).simulate({ from: alice })).toBe(true);
    expect(await contract.methods.is_slot_claimed(gameId, 3).simulate({ from: alice })).toBe(true);

    // Verify encryption keys were stored
    const storedKey1 = await contract.methods.get_slot_encryption_key(gameId, 1n).simulate({ from: alice });
    const storedKey2 = await contract.methods.get_slot_encryption_key(gameId, 2n).simulate({ from: alice });
    const storedKey3 = await contract.methods.get_slot_encryption_key(gameId, 3n).simulate({ from: alice });
    expect(storedKey1.x).toBe(aliceEncryptionKey.x.toBigInt());
    expect(storedKey2.x).toBe(bobEncryptionKey.x.toBigInt());
    expect(storedKey3.x).toBe(carlEncryptionKey.x.toBigInt());

    // ============================================================
    // STEP 6: Alice (owner) advances to RECEIVER_CLAIM phase
    // ============================================================
    console.log("\n--- Step 6: Alice advancing to RECEIVER_CLAIM ---");
    await contract.methods.advance_phase(gameId).send({ from: alice }).wait();

    const receiverPhase = await contract.methods.get_game_phase(gameId).simulate({ from: alice });
    expect(receiverPhase).toBe(BigInt(PHASE_RECEIVER_CLAIM));

    // ============================================================
    // STEP 7: Each participant claims as receiver for a different slot
    // Alice (slot 1) claims slot 2 (Bob's) with encrypted delivery data
    // Bob (slot 2) claims slot 3 (Carl's) with encrypted delivery data
    // Carl (slot 3) claims slot 1 (Alice's) with encrypted delivery data
    //
    // The contract uses nullifier collision to verify each caller is NOT
    // the sender of the slot they're claiming.
    //
    // Each receiver encrypts their delivery address using the slot owner's
    // public encryption key (ECIES encryption).
    // ============================================================
    console.log("\n--- Step 7: Claiming as receivers with ECIES encrypted delivery data ---");

    // Define delivery addresses for each participant
    const aliceAddress = "Alice's delivery address: 123 Main St, North Pole";
    const bobAddress = "Bob's delivery address: 456 Elf Lane, Workshop City";
    const carlAddress = "Carl's delivery address: 789 Reindeer Road, Snow Village";

    // Alice claims slot 2 (Bob's slot) - encrypts her address with Bob's public key
    // Bob will be able to decrypt and see Alice's address
    console.log("  Alice encrypting her address for Bob (slot 2 owner)...");
    const aliceEncryptedData = await encryptDeliveryData(aliceAddress, {
      x: bobEncryptionKey.x.toBigInt(),
      y: bobEncryptionKey.y.toBigInt(),
      is_infinite: bobEncryptionKey.is_infinite,
    });
    await contract.withWallet(wallet).methods.claim_as_receiver(gameId, 2, aliceEncryptedData).send({ from: alice }).wait();
    console.log("  Alice claimed slot 2 successfully");

    // Bob claims slot 3 (Carl's slot) - encrypts his address with Carl's public key
    // Carl will be able to decrypt and see Bob's address
    console.log("  Bob encrypting his address for Carl (slot 3 owner)...");
    const bobEncryptedData = await encryptDeliveryData(bobAddress, {
      x: carlEncryptionKey.x.toBigInt(),
      y: carlEncryptionKey.y.toBigInt(),
      is_infinite: carlEncryptionKey.is_infinite,
    });
    await contract.withWallet(wallet).methods.claim_as_receiver(gameId, 3, bobEncryptedData).send({ from: bob }).wait();
    console.log("  Bob claimed slot 3 successfully");

    // Carl claims slot 1 (Alice's slot) - encrypts his address with Alice's public key
    // Alice will be able to decrypt and see Carl's address
    console.log("  Carl encrypting his address for Alice (slot 1 owner)...");
    const carlEncryptedData = await encryptDeliveryData(carlAddress, {
      x: aliceEncryptionKey.x.toBigInt(),
      y: aliceEncryptionKey.y.toBigInt(),
      is_infinite: aliceEncryptionKey.is_infinite,
    });
    await contract.withWallet(wallet).methods.claim_as_receiver(gameId, 1, carlEncryptedData).send({ from: carl }).wait();
    console.log("  Carl claimed slot 1 successfully");

    // Verify encrypted delivery data was stored (first field is ephemeral pubkey X)
    const storedDelivery1 = await contract.methods.get_slot_delivery_data(gameId, 1n).simulate({ from: alice });
    const storedDelivery2 = await contract.methods.get_slot_delivery_data(gameId, 2n).simulate({ from: alice });
    const storedDelivery3 = await contract.methods.get_slot_delivery_data(gameId, 3n).simulate({ from: alice });
    expect(storedDelivery1[0]).toBe(carlEncryptedData[0].toBigInt());
    expect(storedDelivery2[0]).toBe(aliceEncryptedData[0].toBigInt());
    expect(storedDelivery3[0]).toBe(bobEncryptedData[0].toBigInt());

    // ============================================================
    // STEP 8: Alice (owner) advances to COMPLETED phase
    // ============================================================
    console.log("\n--- Step 8: Alice completing game ---");
    await contract.methods.advance_phase(gameId).send({ from: alice }).wait();

    const finalPhase = await contract.methods.get_game_phase(gameId).simulate({ from: alice });
    expect(finalPhase).toBe(BigInt(PHASE_COMPLETED));

    // ============================================================
    // STEP 9: Senders decrypt delivery data to reveal peer addresses
    // Each sender retrieves encrypted data from their slot and decrypts
    // using their private key to reveal who they need to send a gift to.
    // ============================================================
    console.log("\n--- Step 9: Senders decrypt delivery data to reveal peer addresses ---");

    // Alice owns slot 1 - decrypts to see Carl's address
    // (Carl claimed slot 1 and encrypted his address with Alice's pubkey)
    const aliceRetrieved = await contract.methods.get_slot_delivery_data(gameId, 1n).simulate({ from: alice });
    const decryptedForAlice = await decryptDeliveryData(
      aliceRetrieved as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
      alicePrivateKey
    );
    console.log(`  Alice (slot 1) decrypts: "${decryptedForAlice}"`);
    expect(decryptedForAlice).toBe(carlAddress);

    // Bob owns slot 2 - decrypts to see Alice's address
    // (Alice claimed slot 2 and encrypted her address with Bob's pubkey)
    const bobRetrieved = await contract.methods.get_slot_delivery_data(gameId, 2n).simulate({ from: bob });
    const decryptedForBob = await decryptDeliveryData(
      bobRetrieved as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
      bobPrivateKey
    );
    console.log(`  Bob (slot 2) decrypts: "${decryptedForBob}"`);
    expect(decryptedForBob).toBe(aliceAddress);

    // Carl owns slot 3 - decrypts to see Bob's address
    // (Bob claimed slot 3 and encrypted his address with Carl's pubkey)
    const carlRetrieved = await contract.methods.get_slot_delivery_data(gameId, 3n).simulate({ from: carl });
    const decryptedForCarl = await decryptDeliveryData(
      carlRetrieved as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
      carlPrivateKey
    );
    console.log(`  Carl (slot 3) decrypts: "${decryptedForCarl}"`);
    expect(decryptedForCarl).toBe(bobAddress);

    // ============================================================
    // VERIFICATION
    // ============================================================
    console.log("\n--- Verification ---");

    const contractOwner = await contract.methods.get_admin().simulate({ from: alice });
    expect(contractOwner.toString()).toBe(alice.toString());

    const finalCount = await contract.methods.get_participant_count(gameId).simulate({ from: alice });
    expect(finalCount).toBe(3n);

    console.log("\n=== Secret Santa game completed successfully! ===");
    console.log("Gift assignments (senders decrypt to get receiver addresses):");
    console.log("  Alice (slot 1) -> decrypts Carl's address -> ships to Carl");
    console.log("  Bob (slot 2) -> decrypts Alice's address -> ships to Alice");
    console.log("  Carl (slot 3) -> decrypts Bob's address -> ships to Bob");
  });
});

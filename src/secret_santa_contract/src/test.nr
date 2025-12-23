use crate::SecretSanta;
use crate::types::{
    PHASE_JOIN, PHASE_CLAIM, PHASE_MATCH, PHASE_REVEAL,
};

use dep::aztec::{
    protocol_types::{address::AztecAddress, point::Point, traits::ToField},
    test::helpers::test_environment::TestEnvironment,
};

use std::embedded_curve_ops::{EmbeddedCurveScalar, fixed_base_scalar_mul};

/// Deploy the SecretSanta contract with a given admin
unconstrained fn deploy_secret_santa(
    env: &mut TestEnvironment,
    admin: AztecAddress,
) -> AztecAddress {
    let initializer = SecretSanta::interface().constructor(admin);
    env.deploy("SecretSanta").with_public_initializer(admin, initializer)
}

/// Derive a deterministic encryption key pair from an account address
/// Uses the address as a seed to derive keys - this ensures each account gets unique keys
/// In production, users would publish their actual ivpk_m (incoming viewing public key)
/// and decrypt using their ivsk_m (incoming viewing secret key)
fn derive_encryption_keypair_from_account(account: AztecAddress) -> Point {
    // Use the account address as a deterministic seed
    let private_key = EmbeddedCurveScalar::from_field(account.to_field());
    fixed_base_scalar_mul(private_key)
}

/// Full Secret Santa game flow test
///
/// This test covers:
/// 1. Deploy contract
/// 2. Create a game
/// 3. Enroll 3 participants
/// 4. Advance to sender registration
/// 5. Each participant registers with a unique slot + encryption key
/// 6. Advance to receiver claim
/// 7. Each participant claims a different slot (proving NOT self-assignment)
/// 8. Advance to completed
/// 9. Verify delivery data can be retrieved
#[test]
unconstrained fn test_full_secret_santa_game() {
    // ============================================================
    // SETUP
    // ============================================================
    let mut env = TestEnvironment::new();

    // Create 3 participants + 1 admin (can be same as participant)
    let alice = env.create_light_account();
    let bob = env.create_light_account();
    let carol = env.create_light_account();

    // Derive encryption keys from each account's address
    // In production, users would publish their actual ivpk_m
    let alice_key = derive_encryption_keypair_from_account(alice);
    let bob_key = derive_encryption_keypair_from_account(bob);
    let carol_key = derive_encryption_keypair_from_account(carol);

    // ============================================================
    // STEP 1: Deploy the contract
    // ============================================================
    let contract_address = deploy_secret_santa(&mut env, alice);

    // Verify admin is set correctly
    let admin = env.view_public(SecretSanta::at(contract_address).get_admin());
    assert(admin == alice, "Admin should be Alice");

    // ============================================================
    // STEP 2: Create a game
    // ============================================================
    let _game_result = env.call_public(
        alice,
        SecretSanta::at(contract_address).create_game(3, 10), // min 3, max 10
    );

    let game_id: Field = 1; // First game has ID 1

    // Verify initial phase is ENROLLMENT
    let phase = env.simulate_utility(SecretSanta::at(contract_address).get_game_phase(game_id));
    assert(phase == PHASE_JOIN as u8, "Should be in JOIN phase");

    // ============================================================
    // STEP 3: Enroll 3 participants
    // ============================================================
    env.call_private(alice, SecretSanta::at(contract_address).enroll(game_id));
    env.call_private(bob, SecretSanta::at(contract_address).enroll(game_id));
    env.call_private(carol, SecretSanta::at(contract_address).enroll(game_id));

    // Verify participant count
    let count =
        env.simulate_utility(SecretSanta::at(contract_address).get_participant_count(game_id));
    assert(count == 3, "Should have 3 participants");

    // ============================================================
    // STEP 4: Advance to SENDER_REGISTRATION phase
    // ============================================================
    env.call_public(alice, SecretSanta::at(contract_address).advance_phase(game_id));

    let phase = env.simulate_utility(SecretSanta::at(contract_address).get_game_phase(game_id));
    assert(phase == PHASE_CLAIM as u8, "Should be in CLAIM phase");

    // ============================================================
    // STEP 5: Each participant registers as sender with slot + encryption key
    // Using each user's ivpk_m (incoming viewing public key) as their encryption key
    // Only the account owner can decrypt messages encrypted to their ivpk_m
    // Keys were retrieved at the start of the test (before contract calls)
    // ============================================================

    // Alice takes slot 1
    env.call_private(
        alice,
        SecretSanta::at(contract_address).register_as_sender(game_id, 1, alice_key),
    );

    // Bob takes slot 2
    env.call_private(
        bob,
        SecretSanta::at(contract_address).register_as_sender(game_id, 2, bob_key),
    );

    // Carol takes slot 3
    env.call_private(
        carol,
        SecretSanta::at(contract_address).register_as_sender(game_id, 3, carol_key),
    );

    // Verify slots are claimed
    let slot1_claimed =
        env.simulate_utility(SecretSanta::at(contract_address).is_slot_claimed(game_id, 1));
    let slot2_claimed =
        env.simulate_utility(SecretSanta::at(contract_address).is_slot_claimed(game_id, 2));
    let slot3_claimed =
        env.simulate_utility(SecretSanta::at(contract_address).is_slot_claimed(game_id, 3));
    assert(slot1_claimed, "Slot 1 should be claimed");
    assert(slot2_claimed, "Slot 2 should be claimed");
    assert(slot3_claimed, "Slot 3 should be claimed");

    // Verify encryption keys were stored
    let stored_key1 =
        env.simulate_utility(SecretSanta::at(contract_address).get_slot_encryption_key(game_id, 1));
    let stored_key2 =
        env.simulate_utility(SecretSanta::at(contract_address).get_slot_encryption_key(game_id, 2));
    let stored_key3 =
        env.simulate_utility(SecretSanta::at(contract_address).get_slot_encryption_key(game_id, 3));
    assert(stored_key1.x == alice_key.x, "Alice's key should be stored at slot 1");
    assert(stored_key2.x == bob_key.x, "Bob's key should be stored at slot 2");
    assert(stored_key3.x == carol_key.x, "Carol's key should be stored at slot 3");

    // ============================================================
    // STEP 6: Advance to RECEIVER_CLAIM phase
    // ============================================================
    env.call_public(alice, SecretSanta::at(contract_address).advance_phase(game_id));

    let phase = env.simulate_utility(SecretSanta::at(contract_address).get_game_phase(game_id));
    assert(phase == PHASE_MATCH as u8, "Should be in MATCH phase");

    // ============================================================
    // STEP 7: Each participant claims a different slot (not their own)
    //
    // Assignment:
    // - Alice (owns slot 1) claims slot 2 (Bob's) -> Alice receives from Bob
    // - Bob (owns slot 2) claims slot 3 (Carol's) -> Bob receives from Carol
    // - Carol (owns slot 3) claims slot 1 (Alice's) -> Carol receives from Alice
    //
    // The contract verifies each caller is NOT the sender of the slot they're
    // claiming using constrained public verification (Issue 1 fix).
    // ============================================================

    // Alice claims slot 2 with encrypted delivery data (8 fields for longer payloads)
    let alice_delivery_data: [Field; 8] = [0x1111, 0x2222, 0x3333, 0x4444, 0, 0, 0, 0];
    env.call_private(
        alice,
        SecretSanta::at(contract_address).claim_as_receiver(
            game_id,
            2, // target slot
            alice_delivery_data,
        ),
    );

    // Bob claims slot 3 with encrypted delivery data
    let bob_delivery_data: [Field; 8] = [0x5555, 0x6666, 0x7777, 0x8888, 0, 0, 0, 0];
    env.call_private(
        bob,
        SecretSanta::at(contract_address).claim_as_receiver(
            game_id,
            3, // target slot
            bob_delivery_data,
        ),
    );

    // Carol claims slot 1 with encrypted delivery data
    let carol_delivery_data: [Field; 8] = [0x9999, 0xaaaa, 0xbbbb, 0xcccc, 0, 0, 0, 0];
    env.call_private(
        carol,
        SecretSanta::at(contract_address).claim_as_receiver(
            game_id,
            1, // target slot
            carol_delivery_data,
        ),
    );

    // Verify encrypted delivery data was stored
    let stored_delivery1 =
        env.simulate_utility(SecretSanta::at(contract_address).get_slot_delivery_data(game_id, 1));
    let stored_delivery2 =
        env.simulate_utility(SecretSanta::at(contract_address).get_slot_delivery_data(game_id, 2));
    let stored_delivery3 =
        env.simulate_utility(SecretSanta::at(contract_address).get_slot_delivery_data(game_id, 3));

    // Carol claimed slot 1, so slot 1 has Carol's delivery data
    assert(stored_delivery1[0] == carol_delivery_data[0], "Slot 1 should have Carol's data");
    // Alice claimed slot 2, so slot 2 has Alice's delivery data
    assert(stored_delivery2[0] == alice_delivery_data[0], "Slot 2 should have Alice's data");
    // Bob claimed slot 3, so slot 3 has Bob's delivery data
    assert(stored_delivery3[0] == bob_delivery_data[0], "Slot 3 should have Bob's data");

    // ============================================================
    // STEP 8: Advance to COMPLETED phase
    // ============================================================
    env.call_public(alice, SecretSanta::at(contract_address).advance_phase(game_id));

    let phase = env.simulate_utility(SecretSanta::at(contract_address).get_game_phase(game_id));
    assert(phase == PHASE_REVEAL as u8, "Should be in REVEAL phase");

    // ============================================================
    // VERIFICATION: Final state
    // ============================================================

    // Final participant count
    let final_count =
        env.simulate_utility(SecretSanta::at(contract_address).get_participant_count(game_id));
    assert(final_count == 3, "Should still have 3 participants");

    // Game flow complete!
    // Now senders can retrieve encrypted delivery data and decrypt off-chain:
    // - Alice (slot 1) reads slot 1 delivery data -> decrypts Carol's address
    // - Bob (slot 2) reads slot 2 delivery data -> decrypts Alice's address
    // - Carol (slot 3) reads slot 3 delivery data -> decrypts Bob's address
}

/// Test that a participant cannot claim their own slot as receiver
/// Self-selection is prevented via nullifier collision - if you try to claim
/// your own slot, you push the same nullifier twice, causing a collision.
#[test(should_fail)]
unconstrained fn test_cannot_claim_own_slot() {
    let mut env = TestEnvironment::new();

    let alice = env.create_light_account();
    let bob = env.create_light_account();
    let carol = env.create_light_account();

    // Derive encryption keys from each account's address
    let alice_key = derive_encryption_keypair_from_account(alice);
    let bob_key = derive_encryption_keypair_from_account(bob);
    let carol_key = derive_encryption_keypair_from_account(carol);

    let contract_address = deploy_secret_santa(&mut env, alice);
    let game_id: Field = 1;

    // Create game and enroll
    env.call_public(alice, SecretSanta::at(contract_address).create_game(3, 10));
    env.call_private(alice, SecretSanta::at(contract_address).enroll(game_id));
    env.call_private(bob, SecretSanta::at(contract_address).enroll(game_id));
    env.call_private(carol, SecretSanta::at(contract_address).enroll(game_id));

    // Advance to sender registration
    env.call_public(alice, SecretSanta::at(contract_address).advance_phase(game_id));

    env.call_private(
        alice,
        SecretSanta::at(contract_address).register_as_sender(game_id, 1, alice_key),
    );
    env.call_private(
        bob,
        SecretSanta::at(contract_address).register_as_sender(game_id, 2, bob_key),
    );
    env.call_private(
        carol,
        SecretSanta::at(contract_address).register_as_sender(game_id, 3, carol_key),
    );

    // Advance to receiver claim
    env.call_public(alice, SecretSanta::at(contract_address).advance_phase(game_id));

    // Alice tries to claim her own slot (slot 1) - THIS SHOULD FAIL
    // Alice already pushed sender_nullifier = hash(Alice, game_id, 1) during registration.
    // When she tries to claim slot 1, she pushes the same nullifier again causing collision
    let delivery_data: [Field; 8] = [1, 2, 3, 4, 5, 6, 7, 8];

    env.call_private(
        alice,
        SecretSanta::at(contract_address).claim_as_receiver(
            game_id,
            1, // Alice trying to claim slot 1 (her own slot!)
            delivery_data,
        ),
    );
}

/// Test that duplicate enrollment is prevented
#[test(should_fail)]
unconstrained fn test_cannot_enroll_twice() {
    let mut env = TestEnvironment::new();

    let alice = env.create_light_account();

    let contract_address = deploy_secret_santa(&mut env, alice);
    let game_id: Field = 1;

    // Create game
    env.call_public(alice, SecretSanta::at(contract_address).create_game(3, 10));

    // First enrollment should succeed
    env.call_private(alice, SecretSanta::at(contract_address).enroll(game_id));

    // Second enrollment should fail (duplicate nullifier)
    env.call_private(alice, SecretSanta::at(contract_address).enroll(game_id));
}

/// Test that slot cannot be claimed twice
#[test(should_fail_with = "Slot already claimed")]
unconstrained fn test_cannot_claim_same_slot_twice() {
    let mut env = TestEnvironment::new();

    let alice = env.create_light_account();
    let bob = env.create_light_account();
    let carol = env.create_light_account();

    // Derive encryption keys from each account's address
    let alice_key = derive_encryption_keypair_from_account(alice);
    let bob_key = derive_encryption_keypair_from_account(bob);

    let contract_address = deploy_secret_santa(&mut env, alice);
    let game_id: Field = 1;

    // Create game and enroll
    env.call_public(alice, SecretSanta::at(contract_address).create_game(3, 10));
    env.call_private(alice, SecretSanta::at(contract_address).enroll(game_id));
    env.call_private(bob, SecretSanta::at(contract_address).enroll(game_id));
    env.call_private(carol, SecretSanta::at(contract_address).enroll(game_id));

    // Advance to sender registration
    env.call_public(alice, SecretSanta::at(contract_address).advance_phase(game_id));

    // Alice takes slot 1 using her ivpk_m
    env.call_private(
        alice,
        SecretSanta::at(contract_address).register_as_sender(game_id, 1, alice_key),
    );

    // Bob tries to take slot 1 (already claimed) - SHOULD FAIL
    env.call_private(
        bob,
        SecretSanta::at(contract_address).register_as_sender(game_id, 1, bob_key),
    );
}

/// Test game creation with minimum participants requirement
#[test(should_fail_with = "Need at least 3 participants")]
unconstrained fn test_min_participants_required() {
    let mut env = TestEnvironment::new();
    let alice = env.create_light_account();

    let contract_address = deploy_secret_santa(&mut env, alice);

    // Try to create game with only 2 minimum participants - SHOULD FAIL
    env.call_public(alice, SecretSanta::at(contract_address).create_game(2, 10));
}

/// Test batch query for claimed slots
#[test]
unconstrained fn test_batch_query_claimed_slots() {
    let mut env = TestEnvironment::new();

    let alice = env.create_light_account();
    let bob = env.create_light_account();
    let carol = env.create_light_account();

    let alice_key = derive_encryption_keypair_from_account(alice);
    let bob_key = derive_encryption_keypair_from_account(bob);
    let carol_key = derive_encryption_keypair_from_account(carol);

    let contract_address = deploy_secret_santa(&mut env, alice);
    let game_id: Field = 1;

    // Create game and enroll 3 participants
    env.call_public(alice, SecretSanta::at(contract_address).create_game(3, 10));
    env.call_private(alice, SecretSanta::at(contract_address).enroll(game_id));
    env.call_private(bob, SecretSanta::at(contract_address).enroll(game_id));
    env.call_private(carol, SecretSanta::at(contract_address).enroll(game_id));

    // Advance to sender registration
    env.call_public(alice, SecretSanta::at(contract_address).advance_phase(game_id));

    // Before any slots are claimed, batch query should return all false
    let slots_before =
        env.simulate_utility(SecretSanta::at(contract_address).get_all_claimed_slots(game_id, 3));
    assert(!slots_before[0], "Slot 1 should not be claimed yet");
    assert(!slots_before[1], "Slot 2 should not be claimed yet");
    assert(!slots_before[2], "Slot 3 should not be claimed yet");

    // Alice claims slot 1
    env.call_private(
        alice,
        SecretSanta::at(contract_address).register_as_sender(game_id, 1, alice_key),
    );

    // After Alice claims, batch query should show slot 1 as claimed
    let slots_after_alice =
        env.simulate_utility(SecretSanta::at(contract_address).get_all_claimed_slots(game_id, 3));
    assert(slots_after_alice[0], "Slot 1 should be claimed after Alice");
    assert(!slots_after_alice[1], "Slot 2 should not be claimed yet");
    assert(!slots_after_alice[2], "Slot 3 should not be claimed yet");

    // Bob claims slot 2, Carol claims slot 3
    env.call_private(
        bob,
        SecretSanta::at(contract_address).register_as_sender(game_id, 2, bob_key),
    );
    env.call_private(
        carol,
        SecretSanta::at(contract_address).register_as_sender(game_id, 3, carol_key),
    );

    // All slots should now be claimed
    let slots_final =
        env.simulate_utility(SecretSanta::at(contract_address).get_all_claimed_slots(game_id, 3));
    assert(slots_final[0], "Slot 1 should be claimed");
    assert(slots_final[1], "Slot 2 should be claimed");
    assert(slots_final[2], "Slot 3 should be claimed");

    // Advance to receiver claim and test receiver batch query
    env.call_public(alice, SecretSanta::at(contract_address).advance_phase(game_id));

    // Before any receiver claims
    let receiver_slots_before = env.simulate_utility(
        SecretSanta::at(contract_address).get_all_receiver_claimed_slots(game_id, 3),
    );
    assert(!receiver_slots_before[0], "Receiver slot 1 should not be claimed yet");
    assert(!receiver_slots_before[1], "Receiver slot 2 should not be claimed yet");
    assert(!receiver_slots_before[2], "Receiver slot 3 should not be claimed yet");

    // Each claims a different slot (not their own)
    let delivery_data: [Field; 8] = [1, 2, 3, 4, 5, 6, 7, 8];
    env.call_private(
        alice,
        SecretSanta::at(contract_address).claim_as_receiver(game_id, 2, delivery_data),
    );
    env.call_private(
        bob,
        SecretSanta::at(contract_address).claim_as_receiver(game_id, 3, delivery_data),
    );
    env.call_private(
        carol,
        SecretSanta::at(contract_address).claim_as_receiver(game_id, 1, delivery_data),
    );

    // All receiver slots should now be claimed
    let receiver_slots_final = env.simulate_utility(
        SecretSanta::at(contract_address).get_all_receiver_claimed_slots(game_id, 3),
    );
    assert(receiver_slots_final[0], "Receiver slot 1 should be claimed");
    assert(receiver_slots_final[1], "Receiver slot 2 should be claimed");
    assert(receiver_slots_final[2], "Receiver slot 3 should be claimed");
}

mod types;
mod test;

use dep::aztec::macros::aztec;

/// ZK Secret Santa Contract
///
/// A privacy-preserving Secret Santa protocol implemented on Aztec.
/// Based on the paper "ZK Secret Santa" (arXiv:2501.06515v1)
#[aztec]
pub contract SecretSanta {
    use dep::aztec::{
        macros::{
            functions::{external, initializer, internal, view},
            storage::storage,
        },
        messages::message_delivery::MessageDelivery,
        note::{note_getter_options::NoteGetterOptions, note_interface::NoteProperties},
        protocol_types::{
            address::AztecAddress, hash::poseidon2_hash_with_separator,
            point::Point, traits::ToField,
        },
        state_vars::{Map, PrivateSet, PublicImmutable, PublicMutable},
        utils::comparison::Comparator,
    };

    use crate::types::{
        NULLIFIER_DOMAIN_ENROLLMENT, NULLIFIER_DOMAIN_RECEIVER, NULLIFIER_DOMAIN_SENDER,
        PHASE_COMPLETED, PHASE_ENROLLMENT, PHASE_RECEIVER_CLAIM, PHASE_SENDER_REGISTRATION,
        participant_note::ParticipantNote, receiver_note::ReceiverNote, sender_note::SenderNote,
    };

    // ============================================================
    // STORAGE
    // ============================================================

    #[storage]
    struct Storage<Context> {
        admin: PublicImmutable<AztecAddress, Context>,
        next_game_id: PublicMutable<Field, Context>,
        game_phases: Map<Field, PublicMutable<u8, Context>, Context>,
        participant_counts: Map<Field, PublicMutable<u32, Context>, Context>,
        max_participants: Map<Field, PublicMutable<u32, Context>, Context>,
        slot_claimed: Map<Field, Map<Field, PublicMutable<bool, Context>, Context>, Context>,
        // Sender's encryption public key for each slot (public - anyone can see, but not WHO owns it)
        slot_encryption_keys: Map<Field, Map<Field, PublicMutable<Point, Context>, Context>, Context>,
        // Encrypted delivery data for each slot (receiver posts, only sender can decrypt)
        slot_delivery_data: Map<Field, Map<Field, PublicMutable<[Field; 4], Context>, Context>, Context>,
        participants: Map<AztecAddress, PrivateSet<ParticipantNote, Context>, Context>,
        sender_assignments: Map<AztecAddress, PrivateSet<SenderNote, Context>, Context>,
        receiver_claims: Map<AztecAddress, PrivateSet<ReceiverNote, Context>, Context>,
    }

    // ============================================================
    // NULLIFIER COMPUTATION HELPERS
    // ============================================================

    #[contract_library_method]
    fn compute_enrollment_nullifier(participant: AztecAddress, game_id: Field) -> Field {
        poseidon2_hash_with_separator(
            [participant.to_field(), game_id],
            NULLIFIER_DOMAIN_ENROLLMENT,
        )
    }

    #[contract_library_method]
    fn compute_sender_nullifier(sender: AztecAddress, game_id: Field, slot: Field) -> Field {
        poseidon2_hash_with_separator(
            [sender.to_field(), game_id, slot],
            NULLIFIER_DOMAIN_SENDER,
        )
    }

    #[contract_library_method]
    fn compute_receiver_nullifier(receiver: AztecAddress, game_id: Field) -> Field {
        poseidon2_hash_with_separator([receiver.to_field(), game_id], NULLIFIER_DOMAIN_RECEIVER)
    }

    // ============================================================
    // PUBLIC FUNCTIONS
    // ============================================================

    #[external("public")]
    #[initializer]
    fn constructor(admin: AztecAddress) {
        assert(!admin.is_zero(), "Invalid admin address");
        storage.admin.initialize(admin);
        storage.next_game_id.write(1);
    }

    #[external("public")]
    fn create_game(min_participants: u32, max_participants_param: u32) -> pub Field {
        assert(min_participants >= 3, "Need at least 3 participants");
        assert(max_participants_param >= min_participants, "Max must be >= min");

        let game_id = storage.next_game_id.read();

        storage.game_phases.at(game_id).write(PHASE_ENROLLMENT);
        storage.participant_counts.at(game_id).write(0);
        storage.max_participants.at(game_id).write(max_participants_param);
        storage.next_game_id.write(game_id + 1);

        game_id
    }

    #[external("public")]
    fn advance_phase(game_id: Field) {
        let current_phase = storage.game_phases.at(game_id).read();

        if current_phase == PHASE_ENROLLMENT {
            storage.game_phases.at(game_id).write(PHASE_SENDER_REGISTRATION);
        } else if current_phase == PHASE_SENDER_REGISTRATION {
            storage.game_phases.at(game_id).write(PHASE_RECEIVER_CLAIM);
        } else if current_phase == PHASE_RECEIVER_CLAIM {
            storage.game_phases.at(game_id).write(PHASE_COMPLETED);
        } else {
            assert(false, "Cannot advance from current phase");
        }
    }

    #[internal]
    #[external("public")]
    fn _increment_participant_count(game_id: Field) {
        let max_p = storage.max_participants.at(game_id).read();
        let current_count = storage.participant_counts.at(game_id).read();
        assert(current_count < max_p, "Game is full");
        storage.participant_counts.at(game_id).write(current_count + 1);
    }

    #[internal]
    #[external("public")]
    fn _try_claim_slot(game_id: Field, slot: u32, encryption_key: Point) {
        let participant_count = storage.participant_counts.at(game_id).read();

        assert(slot >= 1, "Slot must be >= 1");
        assert(slot <= participant_count, "Slot exceeds participant count");

        let already_claimed = storage.slot_claimed.at(game_id).at(slot as Field).read();
        assert(!already_claimed, "Slot already claimed");
        storage.slot_claimed.at(game_id).at(slot as Field).write(true);

        // Store sender's encryption public key for this slot
        // Anyone can see the key, but NOT who owns it
        storage.slot_encryption_keys.at(game_id).at(slot as Field).write(encryption_key);
    }

    #[internal]
    #[external("public")]
    fn _store_delivery_data(game_id: Field, slot: u32, encrypted_data: [Field; 4]) {
        // Store encrypted delivery data for the slot
        // Only the sender (who owns the encryption private key) can decrypt
        storage.slot_delivery_data.at(game_id).at(slot as Field).write(encrypted_data);
    }

    // ============================================================
    // PRIVATE FUNCTIONS
    // ============================================================

    #[external("private")]
    fn enroll(game_id: Field) {
        let caller = context.msg_sender().unwrap();

        let note = ParticipantNote::new(caller, game_id);
        storage.participants.at(caller).insert(note).emit(caller, MessageDelivery.CONSTRAINED_ONCHAIN);

        let enrollment_nullifier = compute_enrollment_nullifier(caller, game_id);
        context.push_nullifier(enrollment_nullifier);

        SecretSanta::at(context.this_address())
            ._increment_participant_count(game_id)
            .enqueue(&mut context);
    }

    #[external("private")]
    fn register_as_sender(game_id: Field, chosen_slot: u32, encryption_key: Point) {
        let caller = context.msg_sender().unwrap();

        // Verify enrollment by filtering for notes matching this game_id
        let options = NoteGetterOptions::new()
            .select(ParticipantNote::properties().game_id, Comparator.EQ, game_id)
            .set_limit(1);
        let participant_notes = storage.participants.at(caller).get_notes(options);
        assert(participant_notes.len() > 0, "Not enrolled in this game");

        let sender_note = SenderNote::new(caller, game_id, chosen_slot as Field);
        storage.sender_assignments.at(caller).insert(sender_note).emit(
            caller,
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );

        let sender_nullifier = compute_sender_nullifier(caller, game_id, chosen_slot as Field);
        context.push_nullifier(sender_nullifier);

        // Claim slot and publish encryption key (key is public, owner is hidden)
        SecretSanta::at(context.this_address())
            ._try_claim_slot(game_id, chosen_slot, encryption_key)
            .enqueue(&mut context);
    }

    #[external("private")]
    fn claim_as_receiver(
        game_id: Field,
        target_slot: u32,
        sender_nullifier: Field,
        encrypted_delivery_data: [Field; 4],
    ) {
        let caller = context.msg_sender().unwrap();

        // Verify enrollment by filtering for notes matching this game_id
        let options = NoteGetterOptions::new()
            .select(ParticipantNote::properties().game_id, Comparator.EQ, game_id)
            .set_limit(1);
        let participant_notes = storage.participants.at(caller).get_notes(options);
        assert(participant_notes.len() > 0, "Not enrolled in this game");

        // THE KEY SECURITY CHECK: Prove we're not selecting ourselves
        let my_potential_nullifier = compute_sender_nullifier(caller, game_id, target_slot as Field);
        assert(my_potential_nullifier != sender_nullifier, "Cannot select yourself as sender");

        let receiver_nullifier = compute_receiver_nullifier(caller, game_id);
        context.push_nullifier(receiver_nullifier);

        let receiver_note = ReceiverNote::new(caller, game_id, target_slot as Field, sender_nullifier);
        storage.receiver_claims.at(caller).insert(receiver_note).emit(
            caller,
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );

        // Store encrypted delivery data for the sender
        // Receiver encrypts off-chain using slot's public key, only sender can decrypt
        SecretSanta::at(context.this_address())
            ._store_delivery_data(game_id, target_slot, encrypted_delivery_data)
            .enqueue(&mut context);
    }

    // ============================================================
    // VIEW / UNCONSTRAINED FUNCTIONS
    // ============================================================

    #[external("utility")]
    unconstrained fn get_game_phase(game_id: Field) -> u8 {
        storage.game_phases.at(game_id).read()
    }

    #[external("utility")]
    unconstrained fn get_participant_count(game_id: Field) -> u32 {
        storage.participant_counts.at(game_id).read()
    }

    #[external("utility")]
    unconstrained fn is_slot_claimed(game_id: Field, slot: Field) -> bool {
        storage.slot_claimed.at(game_id).at(slot).read()
    }

    #[external("utility")]
    unconstrained fn get_next_game_id() -> Field {
        storage.next_game_id.read()
    }

    /// Get the encryption public key for a slot (used by receivers to encrypt delivery data)
    #[external("utility")]
    unconstrained fn get_slot_encryption_key(game_id: Field, slot: Field) -> Point {
        storage.slot_encryption_keys.at(game_id).at(slot).read()
    }

    /// Get the encrypted delivery data for a slot (used by senders to retrieve their receiver's info)
    #[external("utility")]
    unconstrained fn get_slot_delivery_data(game_id: Field, slot: Field) -> [Field; 4] {
        storage.slot_delivery_data.at(game_id).at(slot).read()
    }

    /// Get max participants for a game
    #[external("utility")]
    unconstrained fn get_max_participants(game_id: Field) -> u32 {
        storage.max_participants.at(game_id).read()
    }

    #[external("public")]
    #[view]
    fn get_admin() -> pub AztecAddress {
        storage.admin.read()
    }
}

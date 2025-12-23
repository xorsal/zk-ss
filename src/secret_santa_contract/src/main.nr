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
            events::event,
            functions::{external, initializer, only_self, view},
            storage::storage,
        },
        messages::message_delivery::MessageDelivery,
        note::{note_getter_options::NoteGetterOptions, note_interface::NoteProperties},
        protocol_types::{
            address::AztecAddress, hash::poseidon2_hash_with_separator,
            point::Point, traits::ToField,
        },
        state_vars::{Map, Owned, PrivateSet, PublicImmutable, PublicMutable},
        utils::comparison::Comparator,
    };

    use crate::types::{
        NULLIFIER_DOMAIN_ENROLLMENT, NULLIFIER_DOMAIN_RECEIVER, NULLIFIER_DOMAIN_SENDER,
        PHASE_COMPLETED, PHASE_ENROLLMENT, PHASE_RECEIVER_CLAIM, PHASE_SENDER_REGISTRATION,
        participant_note::ParticipantNote, receiver_note::ReceiverNote, sender_note::SenderNote,
    };

    // ============================================================
    // EVENTS
    // ============================================================

    #[event]
    struct SlotClaimed {
        game_id: Field,
        slot: Field,
    }

    #[event]
    struct ReceiverClaimed {
        game_id: Field,
        slot: Field,
    }

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
        // Increased to 8 fields for longer payloads (~111 bytes)
        slot_delivery_data: Map<Field, Map<Field, PublicMutable<[Field; 8], Context>, Context>, Context>,
        participants: Owned<PrivateSet<ParticipantNote, Context>, Context>,
        sender_assignments: Owned<PrivateSet<SenderNote, Context>, Context>,
        receiver_claims: Owned<PrivateSet<ReceiverNote, Context>, Context>,
        // Prevents multiple receivers claiming the same slot (ensures valid permutation)
        slot_receiver_claimed: Map<Field, Map<Field, PublicMutable<bool, Context>, Context>, Context>,
        // Tracks receiver claims to verify all participants claimed before completing
        receiver_claim_counts: Map<Field, PublicMutable<u32, Context>, Context>,
        // Tracks sender registrations to verify all participants registered before receiver phase
        sender_registration_counts: Map<Field, PublicMutable<u32, Context>, Context>,
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
        self.storage.admin.initialize(admin);
        self.storage.next_game_id.write(1);
    }

    #[external("public")]
    fn create_game(min_participants: u32, max_participants_param: u32) -> pub Field {
        let caller = self.msg_sender().unwrap();
        assert(caller.eq(self.storage.admin.read()), "Only admin can create games");
        assert(min_participants >= 3, "Need at least 3 participants");
        assert(max_participants_param >= min_participants, "Max must be >= min");

        let game_id = self.storage.next_game_id.read();

        self.storage.game_phases.at(game_id).write(PHASE_ENROLLMENT);
        self.storage.participant_counts.at(game_id).write(0);
        self.storage.max_participants.at(game_id).write(max_participants_param);
        self.storage.next_game_id.write(game_id + 1);

        game_id
    }

    #[external("public")]
    fn advance_phase(game_id: Field) {
        let caller = self.msg_sender().unwrap();
        assert(caller.eq(self.storage.admin.read()), "Only admin can advance phases");
        let current_phase = self.storage.game_phases.at(game_id).read();

        if current_phase == PHASE_ENROLLMENT {
            // Verify minimum participants before advancing
            let count = self.storage.participant_counts.at(game_id).read();
            assert(count >= 3, "Need at least 3 participants to start");
            self.storage.game_phases.at(game_id).write(PHASE_SENDER_REGISTRATION);
        } else if current_phase == PHASE_SENDER_REGISTRATION {
            // Verify all participants have registered as senders
            let participant_count = self.storage.participant_counts.at(game_id).read();
            let sender_count = self.storage.sender_registration_counts.at(game_id).read();
            assert(
                sender_count == participant_count,
                "Not all participants have registered as senders",
            );
            self.storage.game_phases.at(game_id).write(PHASE_RECEIVER_CLAIM);
        } else if current_phase == PHASE_RECEIVER_CLAIM {
            // Verify all slots have receivers before completing
            let participant_count = self.storage.participant_counts.at(game_id).read();
            let receiver_count = self.storage.receiver_claim_counts.at(game_id).read();
            assert(
                receiver_count == participant_count,
                "Not all participants have claimed a receiver slot",
            );
            self.storage.game_phases.at(game_id).write(PHASE_COMPLETED);
        } else {
            assert(false, "Cannot advance from current phase");
        }
    }

    #[external("public")]
    #[only_self]
    fn _increment_participant_count(game_id: Field) {
        let phase = self.storage.game_phases.at(game_id).read();
        assert(phase == PHASE_ENROLLMENT, "Not in enrollment phase");

        let max_p = self.storage.max_participants.at(game_id).read();
        let current_count = self.storage.participant_counts.at(game_id).read();
        assert(current_count < max_p, "Game is full");
        self.storage.participant_counts.at(game_id).write(current_count + 1);
    }

    #[external("public")]
    #[only_self]
    fn _try_claim_slot(game_id: Field, slot: u32, encryption_key: Point) {
        let phase = self.storage.game_phases.at(game_id).read();
        assert(phase == PHASE_SENDER_REGISTRATION, "Not in sender registration phase");

        let participant_count = self.storage.participant_counts.at(game_id).read();

        assert(slot >= 1, "Slot must be >= 1");
        assert(slot <= participant_count, "Slot exceeds participant count");

        let already_claimed = self.storage.slot_claimed.at(game_id).at(slot as Field).read();
        assert(!already_claimed, "Slot already claimed");
        self.storage.slot_claimed.at(game_id).at(slot as Field).write(true);

        // Store sender's encryption public key for this slot
        // Anyone can see the key, but NOT who owns it
        self.storage.slot_encryption_keys.at(game_id).at(slot as Field).write(encryption_key);

        let sender_count = self.storage.sender_registration_counts.at(game_id).read();
        self.storage.sender_registration_counts.at(game_id).write(sender_count + 1);

        // Emit public event for slot claim
        self.emit(SlotClaimed { game_id, slot: slot as Field });
    }

    #[external("public")]
    #[only_self]
    fn _store_delivery_data(game_id: Field, slot: u32, encrypted_data: [Field; 8]) {
        // Store encrypted delivery data for the slot
        // Only the sender (who owns the encryption private key) can decrypt
        self.storage.slot_delivery_data.at(game_id).at(slot as Field).write(encrypted_data);
    }

    #[external("public")]
    #[only_self]
    fn _mark_receiver_claim(game_id: Field, slot: u32) {
        let phase = self.storage.game_phases.at(game_id).read();
        assert(phase == PHASE_RECEIVER_CLAIM, "Not in receiver claim phase");

        let slot_has_sender = self.storage.slot_claimed.at(game_id).at(slot as Field).read();
        assert(slot_has_sender, "Slot has no sender registered");

        let already_claimed =
            self.storage.slot_receiver_claimed.at(game_id).at(slot as Field).read();
        assert(!already_claimed, "Slot already has a receiver");
        self.storage.slot_receiver_claimed.at(game_id).at(slot as Field).write(true);

        let count = self.storage.receiver_claim_counts.at(game_id).read();
        self.storage.receiver_claim_counts.at(game_id).write(count + 1);

        // Emit public event for receiver claim
        self.emit(ReceiverClaimed { game_id, slot: slot as Field });
    }

    // ============================================================
    // PRIVATE FUNCTIONS
    // ============================================================

    #[external("private")]
    fn enroll(game_id: Field) {
        let caller = self.msg_sender().unwrap();

        let note = ParticipantNote::new(caller, game_id);
        self.storage.participants.at(caller).insert(note).deliver(MessageDelivery.CONSTRAINED_ONCHAIN);

        let enrollment_nullifier = compute_enrollment_nullifier(caller, game_id);
        self.context.push_nullifier(enrollment_nullifier);

        self.enqueue_self._increment_participant_count(game_id);
    }

    #[external("private")]
    fn register_as_sender(game_id: Field, chosen_slot: u32, encryption_key: Point) {
        let caller = self.msg_sender().unwrap();

        // Verify enrollment by filtering for notes matching this game_id
        let options = NoteGetterOptions::new()
            .select(ParticipantNote::properties().game_id, Comparator.EQ, game_id)
            .set_limit(1);
        let participant_notes = self.storage.participants.at(caller).get_notes(options);
        assert(participant_notes.len() > 0, "Not enrolled in this game");

        let sender_note = SenderNote::new(caller, game_id, chosen_slot as Field);
        self.storage.sender_assignments.at(caller).insert(sender_note).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );

        let sender_nullifier = compute_sender_nullifier(caller, game_id, chosen_slot as Field);
        self.context.push_nullifier(sender_nullifier);

        // Claim slot and publish encryption key (key is public, owner is hidden)
        self.enqueue_self._try_claim_slot(game_id, chosen_slot, encryption_key);
    }

    #[external("private")]
    fn claim_as_receiver(
        game_id: Field,
        target_slot: u32,
        encrypted_delivery_data: [Field; 8],
    ) {
        let caller = self.msg_sender().unwrap();

        // Verify enrollment by filtering for notes matching this game_id
        let options = NoteGetterOptions::new()
            .select(ParticipantNote::properties().game_id, Comparator.EQ, game_id)
            .set_limit(1);
        let participant_notes = self.storage.participants.at(caller).get_notes(options);
        assert(participant_notes.len() > 0, "Not enrolled in this game");

        // SECURITY CHECK: Prevent self-selection via nullifier collision
        // If caller IS the sender of target_slot, they already pushed this nullifier
        // during register_as_sender. Pushing it again causes a collision and TX reverts.
        // If caller is NOT the sender, this is a different nullifier (different address)
        // so no collision occurs.
        let self_selection_check = compute_sender_nullifier(caller, game_id, target_slot as Field);
        self.context.push_nullifier(self_selection_check);

        let receiver_nullifier = compute_receiver_nullifier(caller, game_id);
        self.context.push_nullifier(receiver_nullifier);

        let receiver_note = ReceiverNote::new(caller, game_id, target_slot as Field);
        self.storage.receiver_claims.at(caller).insert(receiver_note).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );

        self.enqueue_self._mark_receiver_claim(game_id, target_slot);

        // Store encrypted delivery data for the sender
        // Receiver encrypts off-chain using slot's public key, only sender can decrypt
        self.enqueue_self._store_delivery_data(game_id, target_slot, encrypted_delivery_data);
    }

    // ============================================================
    // VIEW / UNCONSTRAINED FUNCTIONS
    // ============================================================

    #[external("utility")]
    unconstrained fn get_game_phase(game_id: Field) -> u8 {
        self.storage.game_phases.at(game_id).read()
    }

    #[external("utility")]
    unconstrained fn get_participant_count(game_id: Field) -> u32 {
        self.storage.participant_counts.at(game_id).read()
    }

    #[external("utility")]
    unconstrained fn is_slot_claimed(game_id: Field, slot: Field) -> bool {
        self.storage.slot_claimed.at(game_id).at(slot).read()
    }

    #[external("utility")]
    unconstrained fn get_next_game_id() -> Field {
        self.storage.next_game_id.read()
    }

    /// Get the encryption public key for a slot (used by receivers to encrypt delivery data)
    #[external("utility")]
    unconstrained fn get_slot_encryption_key(game_id: Field, slot: Field) -> Point {
        self.storage.slot_encryption_keys.at(game_id).at(slot).read()
    }

    /// Get the encrypted delivery data for a slot (used by senders to retrieve their receiver's info)
    #[external("utility")]
    unconstrained fn get_slot_delivery_data(game_id: Field, slot: Field) -> [Field; 8] {
        self.storage.slot_delivery_data.at(game_id).at(slot).read()
    }

    /// Check if a slot has been claimed by a receiver
    #[external("utility")]
    unconstrained fn is_slot_receiver_claimed(game_id: Field, slot: Field) -> bool {
        self.storage.slot_receiver_claimed.at(game_id).at(slot).read()
    }

    /// Get the count of receiver claims for a game
    #[external("utility")]
    unconstrained fn get_receiver_claim_count(game_id: Field) -> u32 {
        self.storage.receiver_claim_counts.at(game_id).read()
    }

    /// Get max participants for a game
    #[external("utility")]
    unconstrained fn get_max_participants(game_id: Field) -> u32 {
        self.storage.max_participants.at(game_id).read()
    }

    /// Get all claimed slots for a game in a single call (supports up to 128 slots)
    #[external("utility")]
    unconstrained fn get_all_claimed_slots(game_id: Field, max_slots: u32) -> [bool; 128] {
        let mut result: [bool; 128] = [false; 128];
        for i in 0..128 {
            if i < max_slots {
                let slot = (i + 1) as Field;
                result[i] = self.storage.slot_claimed.at(game_id).at(slot).read();
            }
        }
        result
    }

    /// Get all receiver-claimed slots for a game in a single call (supports up to 128 slots)
    #[external("utility")]
    unconstrained fn get_all_receiver_claimed_slots(game_id: Field, max_slots: u32) -> [bool; 128] {
        let mut result: [bool; 128] = [false; 128];
        for i in 0..128 {
            if i < max_slots {
                let slot = (i + 1) as Field;
                result[i] = self.storage.slot_receiver_claimed.at(game_id).at(slot).read();
            }
        }
        result
    }

    /// Get complete game state in a single call
    /// Returns: (phase, participant_count, max_participants, sender_count, receiver_count, sender_slots[128], receiver_slots[128])
    #[external("utility")]
    unconstrained fn get_game_state(game_id: Field) -> (u8, u32, u32, u32, u32, [bool; 128], [bool; 128]) {
        let phase = self.storage.game_phases.at(game_id).read();
        let participant_count = self.storage.participant_counts.at(game_id).read();
        let max_participants = self.storage.max_participants.at(game_id).read();
        let receiver_count = self.storage.receiver_claim_counts.at(game_id).read();

        let mut sender_slots: [bool; 128] = [false; 128];
        let mut receiver_slots: [bool; 128] = [false; 128];
        let mut sender_count: u32 = 0;

        for i in 0..128 {
            if i < max_participants {
                let slot = (i + 1) as Field;
                let is_sender = self.storage.slot_claimed.at(game_id).at(slot).read();
                let is_receiver = self.storage.slot_receiver_claimed.at(game_id).at(slot).read();
                sender_slots[i] = is_sender;
                receiver_slots[i] = is_receiver;
                if is_sender {
                    sender_count += 1;
                }
            }
        }

        (phase, participant_count, max_participants, sender_count, receiver_count, sender_slots, receiver_slots)
    }

    #[external("public")]
    #[view]
    fn get_admin() -> pub AztecAddress {
        self.storage.admin.read()
    }
}

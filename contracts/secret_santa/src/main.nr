use dep::aztec::macros::aztec;

/// ZK Secret Santa - Aztec Native Implementation (Simplified MVP)
#[aztec]
pub contract SecretSanta {
    use dep::aztec::{
        macros::{
            storage::storage,
            functions::{external, initializer, view},
        },
        protocol_types::{
            address::AztecAddress,
            hash::poseidon2_hash,
            traits::ToField,
        },
        state_vars::{Map, PublicMutable, PublicImmutable},
    };

    // Game states
    global STATE_REGISTRATION: u8 = 0;
    global STATE_SUBMISSION: u8 = 1;
    global STATE_DISCLOSURE: u8 = 2;
    global STATE_COMPLETE: u8 = 3;

    global MAX_PARTICIPANTS: u32 = 8;

    #[storage]
    struct Storage<Context> {
        admin: PublicMutable<AztecAddress, Context>,
        game_state: PublicMutable<u8, Context>,
        event_id: PublicImmutable<Field, Context>,
        participant_count: PublicMutable<u32, Context>,
        participants: Map<u32, PublicMutable<AztecAddress, Context>, Context>,
        sender_count: PublicMutable<u32, Context>,
        sender_nullifiers: Map<u32, PublicMutable<Field, Context>, Context>,
        sender_randomness: Map<u32, PublicMutable<Field, Context>, Context>,
        assignments: Map<u32, PublicMutable<AztecAddress, Context>, Context>,
        spent_nullifiers: Map<Field, PublicMutable<bool, Context>, Context>,
        has_disclosed: Map<AztecAddress, PublicMutable<bool, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(admin: AztecAddress) {
        storage.admin.write(admin);
        storage.game_state.write(STATE_REGISTRATION);
        storage.participant_count.write(0);
        storage.sender_count.write(0);
        let event_id = poseidon2_hash([context.this_address().to_field(), 1]);
        storage.event_id.initialize(event_id);
    }

    #[external("public")]
    fn register_participants(
        p0: AztecAddress,
        p1: AztecAddress,
        p2: AztecAddress,
        p3: AztecAddress,
        p4: AztecAddress,
        p5: AztecAddress,
        p6: AztecAddress,
        p7: AztecAddress,
        count: u32
    ) {
        assert(storage.admin.read().eq(context.msg_sender().unwrap()), "Only admin");
        assert(storage.game_state.read() == STATE_REGISTRATION, "Wrong state");
        assert(count >= 2, "Need at least 2");
        assert(count <= MAX_PARTICIPANTS, "Too many");

        let participants = [p0, p1, p2, p3, p4, p5, p6, p7];
        for i in 0..MAX_PARTICIPANTS {
            if i < count {
                storage.participants.at(i).write(participants[i]);
            }
        }
        storage.participant_count.write(count);
    }

    #[external("public")]
    fn advance_state() {
        assert(storage.admin.read().eq(context.msg_sender().unwrap()), "Only admin");
        let current = storage.game_state.read();
        assert(current < STATE_COMPLETE, "Already complete");
        storage.game_state.write(current + 1);
    }

    /// Submit randomness with a nullifier derived off-chain
    /// In production, this would be done via private function
    #[external("public")]
    fn submit_randomness(nullifier: Field, randomness: Field) {
        assert(storage.game_state.read() == STATE_SUBMISSION, "Wrong state");
        assert(!storage.spent_nullifiers.at(nullifier).read(), "Nullifier spent");

        let index = storage.sender_count.read();
        storage.sender_nullifiers.at(index).write(nullifier);
        storage.sender_randomness.at(index).write(randomness);
        storage.sender_count.write(index + 1);
        storage.spent_nullifiers.at(nullifier).write(true);
    }

    /// Disclose as receiver - proves off-chain that receiver_nullifier != sender_nullifier
    #[external("public")]
    fn disclose_receiver(sender_index: u32, receiver_nullifier: Field) {
        let receiver = context.msg_sender().unwrap();
        assert(storage.game_state.read() == STATE_DISCLOSURE, "Wrong state");
        assert(!storage.has_disclosed.at(receiver).read(), "Already disclosed");
        assert(sender_index < storage.sender_count.read(), "Invalid index");

        let sender_nullifier = storage.sender_nullifiers.at(sender_index).read();
        // In production, this check happens in ZK proof
        // Here we trust the caller provides a valid receiver_nullifier
        assert(receiver_nullifier != sender_nullifier, "Cannot choose yourself");

        assert(storage.assignments.at(sender_index).read().is_zero(), "Already assigned");

        storage.assignments.at(sender_index).write(receiver);
        storage.has_disclosed.at(receiver).write(true);
    }

    // View functions
    #[external("public")]
    #[view]
    fn get_admin() -> AztecAddress {
        storage.admin.read()
    }

    #[external("public")]
    #[view]
    fn get_game_state() -> u8 {
        storage.game_state.read()
    }

    #[external("public")]
    #[view]
    fn get_event_id() -> Field {
        storage.event_id.read()
    }

    #[external("public")]
    #[view]
    fn get_participant_count() -> u32 {
        storage.participant_count.read()
    }

    #[external("public")]
    #[view]
    fn get_participant(index: u32) -> AztecAddress {
        storage.participants.at(index).read()
    }

    #[external("public")]
    #[view]
    fn get_sender_count() -> u32 {
        storage.sender_count.read()
    }

    #[external("public")]
    #[view]
    fn get_sender_nullifier(index: u32) -> Field {
        storage.sender_nullifiers.at(index).read()
    }

    #[external("public")]
    #[view]
    fn get_sender_randomness(index: u32) -> Field {
        storage.sender_randomness.at(index).read()
    }

    #[external("public")]
    #[view]
    fn get_assignment(sender_index: u32) -> AztecAddress {
        storage.assignments.at(sender_index).read()
    }
}

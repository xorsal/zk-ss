use dep::aztec::{
    macros::notes::note,
    oracle::random::random,
    protocol_types::{address::AztecAddress, traits::{Deserialize, Packable, Serialize}},
};

/// Note representing a receiver's claim of a sender slot in a Secret Santa game.
#[derive(Deserialize, Eq, Packable, Serialize)]
#[note]
pub struct ReceiverNote {
    owner: AztecAddress,
    randomness: Field,
    game_id: Field,
    claimed_slot: Field,
}

impl ReceiverNote {
    pub fn new(owner: AztecAddress, game_id: Field, claimed_slot: Field) -> Self {
        // Safety: Randomness is used to preserve privacy. A malicious sender could use
        // non-random values but they already know the note contents anyway.
        let randomness = unsafe { random() };
        ReceiverNote { owner, randomness, game_id, claimed_slot }
    }

    pub fn get_game_id(self) -> Field {
        self.game_id
    }

    pub fn get_claimed_slot(self) -> Field {
        self.claimed_slot
    }

    pub fn get_owner(self) -> AztecAddress {
        self.owner
    }
}

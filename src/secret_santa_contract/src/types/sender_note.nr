use dep::aztec::{
    macros::notes::note,
    oracle::random::random,
    protocol_types::{address::AztecAddress, traits::{Deserialize, Packable, Serialize}},
};

/// Note representing a sender's slot assignment in a Secret Santa game.
#[derive(Deserialize, Eq, Packable, Serialize)]
#[note]
pub struct SenderNote {
    owner: AztecAddress,
    randomness: Field,
    game_id: Field,
    slot: Field,
}

impl SenderNote {
    pub fn new(owner: AztecAddress, game_id: Field, slot: Field) -> Self {
        // Safety: Randomness is used to preserve privacy. A malicious sender could use
        // non-random values but they already know the note contents anyway.
        let randomness = unsafe { random() };
        SenderNote { owner, randomness, game_id, slot }
    }

    pub fn get_game_id(self) -> Field {
        self.game_id
    }

    pub fn get_slot(self) -> Field {
        self.slot
    }

    pub fn get_owner(self) -> AztecAddress {
        self.owner
    }
}

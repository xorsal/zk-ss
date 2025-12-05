use dep::aztec::{
    macros::notes::note,
    oracle::random::random,
    protocol_types::{address::AztecAddress, traits::{Deserialize, Packable, Serialize}},
};

/// Note containing encrypted delivery information from a receiver to their assigned sender.
#[derive(Deserialize, Eq, Packable, Serialize)]
#[note]
pub struct DeliveryNote {
    owner: AztecAddress,
    randomness: Field,
    game_id: Field,
    slot: Field,
    encrypted_data_0: Field,
    encrypted_data_1: Field,
    encrypted_data_2: Field,
    encrypted_data_3: Field,
}

impl DeliveryNote {
    pub fn new(
        owner: AztecAddress,
        game_id: Field,
        slot: Field,
        encrypted_data: [Field; 4],
    ) -> Self {
        // Safety: Randomness is used to preserve privacy. A malicious sender could use
        // non-random values but they already know the note contents anyway.
        let randomness = unsafe { random() };
        DeliveryNote {
            owner,
            randomness,
            game_id,
            slot,
            encrypted_data_0: encrypted_data[0],
            encrypted_data_1: encrypted_data[1],
            encrypted_data_2: encrypted_data[2],
            encrypted_data_3: encrypted_data[3],
        }
    }

    pub fn get_game_id(self) -> Field {
        self.game_id
    }

    pub fn get_slot(self) -> Field {
        self.slot
    }

    pub fn get_encrypted_data(self) -> [Field; 4] {
        [
            self.encrypted_data_0,
            self.encrypted_data_1,
            self.encrypted_data_2,
            self.encrypted_data_3,
        ]
    }

    pub fn get_owner(self) -> AztecAddress {
        self.owner
    }
}

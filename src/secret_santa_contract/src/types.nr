pub mod participant_note;
pub mod sender_note;
pub mod receiver_note;
pub mod delivery_note;

/// Game phases
pub global PHASE_ENROLLMENT: u8 = 1;
pub global PHASE_SENDER_REGISTRATION: u8 = 2;
pub global PHASE_RECEIVER_CLAIM: u8 = 3;
pub global PHASE_COMPLETED: u8 = 4;

/// Nullifier domain separators
pub global NULLIFIER_DOMAIN_ENROLLMENT: Field = 1;
pub global NULLIFIER_DOMAIN_SENDER: Field = 2;
pub global NULLIFIER_DOMAIN_RECEIVER: Field = 3;

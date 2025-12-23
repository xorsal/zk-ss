# ZK Secret Santa

Privacy-preserving Secret Santa on Aztec. Nobody knows who sends to whom.

## Install

```bash
git clone <REPO>
cd zk-ss
yarn install
yarn ccc
```

## Player Commands

### Setup (one-time)

```bash
yarn cli --next-devnet setup --connect <CONTRACT_ADDRESS>
export ZK_PASSPHRASE="your-secret-phrase"
export GAME=<GAME_ID>
```

### Play (automatic flow)

```bash
yarn cli --next-devnet -p $ZK_PASSPHRASE enroll --game $GAME
```

The CLI polls and guides you through all phases automatically.

### Manual Commands

```bash
yarn cli --next-devnet -p $ZK_PASSPHRASE enroll --game $GAME        # Join a game
yarn cli --next-devnet -p $ZK_PASSPHRASE register --slot <N>        # Pick a sender slot
yarn cli --next-devnet -p $ZK_PASSPHRASE claim --slot <N>           # Pick a receiver slot (different from yours)
yarn cli --next-devnet -p $ZK_PASSPHRASE delivery --slot <N>        # View your recipient's address
```

### Utility

```bash
yarn cli info                      # Show config
yarn cli --next-devnet status      # Game status
```

## Admin Commands

### Deploy & Create Game

```bash
yarn cli --next-devnet setup --full-deploy
yarn cli --next-devnet admin create --min 3 --max 3
```

### Manage Game

```bash
export ZK_PASSPHRASE="secret-santa-admin"
yarn cli --next-devnet -p $ZK_PASSPHRASE status --game $GAME
yarn cli --next-devnet -p $ZK_PASSPHRASE admin advance --game $GAME
```

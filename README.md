# Pool script to help with migration of nomination pool members to Delegation based staking

More details on the migration can be
found [here](https://support.polkadot.network/support/solutions/articles/65000188140-changes-for-nomination-pool-members-and-opengov-participation).

## Pre-requisites

- Install yarn: `npm install --global yarn`
- Install dependencies: `yarn install`
- Dry run: `yarn run main -e "wss://polkadot-rpc.dwellir.com" -d true`

## Migration
- Setup a wallet with env variable `DOT_BOT_MNEMONIC` and funds to pay for the migration fees.
- Keep BATCH_SIZE to 1 for the transactions to be free.
- Transfer 12+ DOTs to admin account.
- Run the migration script: `yarn run main -e "wss://polkadot-rpc.dwellir.com -d false -s 0"`

## Recommended Params

Westend: 12169 members, set `BATCH_SIZE` to 1 to monitor errors. Took 3.5 hours to migrate all members.

Kusama has around ~3400 members. ~1 hour to migrate all members.

Polkadot has around ~40000 members. Would take around 11 hours with 12 account bots. Parallelize to make it faster.

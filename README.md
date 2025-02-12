# Pool script to help with migration of nomination pool members to Delegation based staking

More details on the migration can be
found [here](https://support.polkadot.network/support/solutions/articles/65000188140-changes-for-nomination-pool-members-and-opengov-participation).

## Pre-requisites

- Install yarn: `npm install --global yarn`
- Install dependencies: `yarn install`
- Dry run: `yarn run main -e "wss://polkadot-rpc.dwellir.com" -d true`

## Migration

- Setup a wallet with env variable `DOT_BOT_MNEMONIC` and funds to pay for the migration fees.
- Set the `BATCH_SIZE` to desired value. A value of 1 would send single transaction which is more transparent to errors
  on
  subscan but slower.

## Recommended Params

Westend: 12169 members, set `BATCH_SIZE` to 1 to monitor errors. Took 3.5 hours to migrate all members.

Kusama has around ~3400 members. Set `BATCH_SIZE` to 10 since we will do this for Polkadot and know if there are any
potential issues with the script. It should take around 6 minutes to migrate all members.

Polkadot has around ~40000 members. If we set `BATCH_SIZE` to 10, it will take around 1 hour to migrate all members.

// needed as of 7.x series, see CHANGELOG of the api repo.
import '@polkadot/api-augment';
import '@polkadot/types-augment';
import { u8aToHex, hexToNumber } from '@polkadot/util';
import { ApiPromise, Keyring, WsProvider } from '@polkadot/api';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const optionsPromise = yargs(hideBin(process.argv))
	.option('endpoint', {
		alias: 'e',
		type: 'string',
		default: 'wss://westend-rpc.dwellir.com',
		description: 'the wss endpoint. It must allow unsafe RPCs.',
		demandOption: true
	})
	.option('dry', {
		alias: 'd',
		type: 'boolean',
		default: true,
		description: 'if dry run is enabled, no transactions will be sent.'
	}).argv;

async function main() {
	const options = await optionsPromise;
	const provider = new WsProvider(options.endpoint);
	const api = await ApiPromise.create({ provider });
	const latest = await api.derive.chain.bestNumber();
	const latest_hash = await api.rpc.chain.getBlockHash(latest);
	const apiAt = await api.at(latest_hash);
	// sr25519 keyring
	const keyring = new Keyring({ type: 'sr25519' });
	const MNEMONIC = process.env.DOT_BOT_MNEMONIC;
	const admin = keyring.createFromUri(`${MNEMONIC}`).address;

	console.log(
		`****************** Connected to node: ${(await api.rpc.system.chain()).toHuman()} [ss58: ${
			api.registry.chainSS58
		}] ******************`
	);

	// go over all pools.
	const pool_keys = await apiAt.query.nominationPools.bondedPools.keys();
	// for (const key of pool_keys) {
	// 	// check for pool migration
	// 	const should_migrate = await api.rpc.state.call(
	// 		'NominationPoolsApi_pool_needs_delegate_migration',
	// 		key.toHex()
	// 	);
	// 	// const should_migrate = await apiAt.call.nominationPoolsApi.pool_needs_delegate_migration(key);
	//
	// 	if (should_migrate) {
	// 		if (options.dry) {
	// 			console.log(`Pool #${key.toHuman()} needs migration.`);
	// 		} else {
	// 			const do_pool_migrate = api.tx.nominationPools.migrate_pool_to_delegate_stake(key);
	// 			const hash = await do_pool_migrate.signAndSend(admin);
	// 			console.log('do_pool_migrate completed with hash', hash.toHex());
	// 		}
	// 	}
	//
	// 	// check for pool slash
	// 	const pool_pending_slash = await apiAt.call.nominationPoolsApi.pool_pending_slash(key);
	// 	console.log(`Pool #${key.toHuman()} has pending slash of ${pool_pending_slash.toHuman()}.`);
	// }

	// go over all pool members.
	const member_keys = await apiAt.query.nominationPools.poolMembers.keys();
	for (const key of member_keys) {
		// check for pool migration
		const keyring = new Keyring();
		const member_acc = u8aToHex(keyring.decodeAddress(key.toHuman()?.toString()));
		const should_migrate_delegation = await api.rpc.state.call(
			'NominationPoolsApi_member_needs_delegate_migration',
			member_acc
		);
		// const should_migrate_delegation =
		// 	await apiAt.call.nominationPoolsApi.member_needs_delegate_migration(key);

		if (should_migrate_delegation) {
			if (options.dry) {
				console.log(`Member ${key.toHuman()} needs delegation migration.`);
			} else {
				const do_member_migrate = api.tx.nominationPools.migrate_delegation(key);
				const hash = await do_member_migrate.signAndSend(admin);
				console.log('do_pool_migrate completed with hash', hash.toHex());
			}
		}

		const member_pending_slash_raw = await api.rpc.state.call(
			'NominationPoolsApi_member_pending_slash',
			member_acc
		);

		const member_pending_slash = api.createType(
			'Balance',
			hexToNumber(member_pending_slash_raw.toString())
		);

		const should_slash_member = member_pending_slash.gtn(0);
		if (should_slash_member) {
			if (options.dry) {
				console.log(`Member ${key.toHuman()} has pending slash of ${member_pending_slash}.`);
			} else {
				const do_member_slash = api.tx.nominationPools.apply_slash(key);
				const hash = await do_member_slash.signAndSend(admin);
				console.log('do_member_slash completed with hash', hash.toHex());
			}
		}
	}

	process.exit(0);
}

main().catch(console.error);

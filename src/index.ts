// needed as of 7.x series, see CHANGELOG of the api repo.
import '@polkadot/api-augment';
import '@polkadot/types-augment';
import { u8aToHex, hexToNumber, numberToHex } from '@polkadot/util';
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
	const admin = keyring.createFromUri(`${MNEMONIC}`);

	console.log(
		`${admin.meta.name}: has address ${admin.address} with publicKey [${admin.publicKey}]`
	);

	console.log(
		`****************** Connected to node: ${(await api.rpc.system.chain()).toHuman()} [ss58: ${
			api.registry.chainSS58
		}] ******************`
	);

	// go over all pools.
	const pool_keys = await apiAt.query.nominationPools.bondedPools.keys();
	let to_migrate = 0;
	let to_not_migrate = 0;
	for (const key of pool_keys) {
		// check for pool migration
		const pool_id = api.createType('u32', key.toHuman());
		const pool_id_hex = hexToLe(numberToHex(api.createType('u32', key.toHuman()).toNumber()));
		const result = await api.rpc.state.call(
			'NominationPoolsApi_pool_needs_delegate_migration',
			pool_id_hex
		);

		const should_migrate = result.toHex() == '0x01';

		if (should_migrate) {
			console.log(`Pool #${pool_id} needs migration.`);
			to_migrate++;
			if (!options.dry) {
				const do_pool_migrate = api.tx.nominationPools.migratePoolToDelegateStake(pool_id);
				const hash = await do_pool_migrate.signAndSend(admin);
				console.log(`pool #${pool_id} completed with hash`, hash.toHex());
				break;
			}
		} else {
			to_not_migrate++;
		}

		// check for pool slash
		// const pool_pending_slash = await apiAt.call.nominationPoolsApi.pool_pending_slash(key);
		// console.log(`Pool #${key.toHuman()} has pending slash of ${pool_pending_slash.toHuman()}.`);
	}

	console.log(`Pools to migrate: ${to_migrate}, Pools to not migrate: ${to_not_migrate}`);

	// go over all pool members.
	const member_keys = await apiAt.query.nominationPools.poolMembers.keys();
	for (const key of member_keys) {
		// check for pool migration
		const keyring = new Keyring();
		const member_account = keyring.decodeAddress(key.toHuman()?.toString());
		const member_acc_hex = u8aToHex(member_account);
		const should_migrate_delegation = await api.rpc.state.call(
			'NominationPoolsApi_member_needs_delegate_migration',
			member_acc_hex
		);

		if (should_migrate_delegation) {
			console.log(`Member ${key.toHuman()} needs delegation migration.`);
			if (!options.dry) {
				const do_member_migrate = api.tx.nominationPools.migrateDelegation(member_account);
				const hash = await do_member_migrate.signAndSend(admin);
				console.log(`Member ${key.toHuman()} migration submitted with hash`, hash.toHex());
				break;
			}
		}

		const member_pending_slash_raw = await api.rpc.state.call(
			'NominationPoolsApi_member_pending_slash',
			member_acc_hex
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
				const do_member_slash = api.tx.nominationPools.applySlash(member_account);
				const hash = await do_member_slash.signAndSend(admin);
				console.log(
					`Member ${key.toHuman()} pending slash apply submitted with hash`,
					hash.toHex()
				);
			}
		}
	}

	process.exit(0);
}

main().catch(console.error);

function padHexString(hexString: string): string {
	// Ensure the hex string is at least 8 characters long (excluding '0x')
	while (hexString.length < 10) {
		hexString += '0'; // Append '0' to the end
	}
	return hexString;
}

function hexToLe(hexString: string): string {
	// Remove "0x" prefix if present
	if (hexString.startsWith('0x')) {
		hexString = hexString.slice(2);
	}

	// Split the hex string into pairs of characters
	const pairs = hexString.match(/.{1,2}/g);

	if (!pairs) {
		throw new Error('Invalid hex string format');
	}

	// Reverse the order of the pairs
	const reversedPairs = pairs.reverse();

	// Join the reversed pairs into a new hex string
	const littleEndianHex = '0x' + reversedPairs.join('');

	return padHexString(littleEndianHex);
}

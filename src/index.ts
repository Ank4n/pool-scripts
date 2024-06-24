// needed as of 7.x series, see CHANGELOG of the api repo.
import '@polkadot/api-augment';
import '@polkadot/types-augment';
import { u8aToHex, hexToNumber, numberToHex } from '@polkadot/util';
import { ApiPromise, Keyring, WsProvider } from '@polkadot/api';
import type { KeyringPair } from '@polkadot/keyring/types';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const DELAY = 10000;
const BATCH_SIZE = 5;

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

	// Read ED.
	const ED = api.consts.balances.existentialDeposit;
	console.log(`Existential Deposit: ${ED}`);

	// go over all pools.
	// const pool_keys = await apiAt.query.nominationPools.bondedPools.keys();
	let toMigrate = 0;
	let alreadyMigrated = 0;
	let txs = [];
	/*
	for (const key of pool_keys) {
		if (txs.length >= BATCH_SIZE) {
			await batch_send(api, admin, txs);
			console.log(`Waiting for ${DELAY / 1000} seconds.`);
			await new Promise((f) => setTimeout(f, DELAY));
			txs = [];
			console.log(`Cleared txns. ${txs.length}`);
		}
		// check for pool migration
		const pool_id = api.createType('u32', key.toHuman());
		const pool_id_hex = hexToLe(numberToHex(api.createType('u32', key.toHuman()).toNumber()));
		const result = await api.rpc.state.call(
			'NominationPoolsApi_pool_needs_delegate_migration',
			pool_id_hex
		);

		const should_migrate = result.toHex() == '0x01';

		if (should_migrate) {
			toMigrate++;
			if (!options.dry) {
				console.log(`Migrating Pool #${pool_id}.`);
				const do_pool_migrate = api.tx.nominationPools.migratePoolToDelegateStake(pool_id);
				txs.push(do_pool_migrate);
			}
		} else {
			alreadyMigrated++;
		}
	}

	console.log(`Pools to migrate: ${toMigrate} | already migrated: ${alreadyMigrated}`);
*/
	// go over all pool members.
	toMigrate = 0;
	alreadyMigrated = 0;
	let balanceLow = 0;
	let alreadyStaking = 0;
	const member_keys = await apiAt.query.nominationPools.poolMembers.keys();
	const total = member_keys.length;
	let processing = 0;
	const progressStep = Math.round(total / 500);

	console.log(
		`${new Date().toISOString()} :: Starting processing migration for ${total} pool members`
	);

	for (const key of member_keys) {
		processing++;
		// batch tx if queue is full.
		if (txs.length >= BATCH_SIZE) {
			await batch_send(api, admin, txs);
			console.log(`Waiting for ${DELAY / 1000} seconds.`);
			// wait for 6 seconds
			await new Promise((f) => setTimeout(f, DELAY));
			txs = [];
			console.log(`Cleared txns. ${txs.length}`);
		}
		// print progress
		if (processing % progressStep == 0) {
			printProgress(
				`>> Processed ${
					Math.round((processing * 10000) / total) / 100
				} %. Stats: ${toMigrate} to migrate | ${alreadyMigrated} already migrated | ${balanceLow} balance low | ${alreadyStaking} already staking directly. <<`
			);
		}

		// check for pool migration
		const keyring = new Keyring();
		const member_account = keyring.decodeAddress(key.toHuman()?.toString());
		const member_acc_hex = u8aToHex(member_account);

		// check member balance
		const { data: member_balance } = await api.query.system.account(member_account);
		const is_balance_low = member_balance.free.lt(ED);
		// check if member is already staking directly.
		const is_staking_directly = (await api.query.staking.bonded(member_account)).isSome;

		const result = await api.rpc.state.call(
			'NominationPoolsApi_member_needs_delegate_migration',
			member_acc_hex
		);

		const should_migrate_delegation = result.toHex() == '0x01';
		if (is_balance_low) {
			balanceLow++;
		} else if (is_staking_directly) {
			alreadyStaking++;
			// console.log(`Member ${key.toHuman()} is already staking directly.`);
		} else if (should_migrate_delegation) {
			toMigrate++;
			if (!options.dry) {
				console.log(`Migrating member ${key.toHuman()}.`);
				const do_member_migrate = api.tx.nominationPools.migrateDelegation(member_account);
				txs.push(do_member_migrate);
			}
		} else {
			alreadyMigrated++;
			// console.log(
			// 	`Member ${key.toHuman()} already migrated 🎉🎉. Total migrated: ${alreadyMigrated}.`
			// );
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
			console.log(`Member ${key.toHuman()} has pending slash of ${member_pending_slash}.`);
			if (!options.dry) {
				const do_member_slash = api.tx.nominationPools.applySlash(member_account);
				txs.push(do_member_slash);
			}
		}
	}

	console.log(`${toMigrate} members need delegation migration.`);
	console.log(`${alreadyMigrated} members already migrated.`);
	console.log(`${alreadyStaking} members cannot be migrated since they are staking directly.`);
	console.log(`${balanceLow} members cannot be migrated since their balance is too low.`);

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

async function batch_send(api: ApiPromise, signer: KeyringPair, txs: any[]) {
	if (txs.length > 1) {
		await api.tx.utility.batch(txs).signAndSend(signer, ({ status }) => {
			if (status.isInBlock) {
				console.log(`included in ${status.asInBlock}`);
			}
		});
		console.log(`Sent ${txs.length} transactions.`);
	} else if (txs.length == 1) {
		await txs[0].signAndSend(signer);
		console.log(`Sent ${txs.length} transactions.`);
	}
}

function printProgress(progress: string) {
	process.stdout.clearLine(0);
	process.stdout.cursorTo(0);
	process.stdout.write(progress);
}

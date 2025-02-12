// needed as of 7.x series, see CHANGELOG of the api repo.
import '@polkadot/api-augment';
import '@polkadot/types-augment';
import { u8aToHex, hexToNumber, numberToHex } from '@polkadot/util';
import { ApiPromise, Keyring, WsProvider } from '@polkadot/api';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const DELAY = 1000;
const BATCH_SIZE = 10;

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

let balanceLow = 0;
let alreadyStaking = 0;
let toMigrate = 0;
let alreadyMigrated = 0;
let totalToProcess = 0;
let processed = 0;
// report progress every 50 iterations.
const progressStep = 50;
// how many transacting accounts to use
const ACCOUNTS_TO_USE = 12;
// balance to top up transacting accounts
const TOPUP_BALANCE = 1000000000000;

const MNEMONIC = process.env.DOT_BOT_MNEMONIC;

async function main() {
	const options = await optionsPromise;
	const provider = new WsProvider(options.endpoint);
	const api = await ApiPromise.create({ provider });
	const latest = await api.derive.chain.bestNumber();
	const latest_hash = await api.rpc.chain.getBlockHash(latest);
	const apiAt = await api.at(latest_hash);

	// sr25519 keyring
	const keyring = new Keyring({ type: 'sr25519' });
	const admin = keyring.createFromUri(`${MNEMONIC}`);

	console.log(`Using address ${admin.address} to migrate the pool members.`);

	console.log(`Connected to node: **${(await api.rpc.system.chain()).toHuman()}**`);

	// Read ED.
	const ED = api.consts.balances.existentialDeposit;
	console.log(`Existential Deposit: ${ED}`);
	// Min join bond
	const minJoinBond = await api.query.nominationPools.minJoinBond();
	console.log(`Min join bond: ${minJoinBond}`);
	const minBalance = Math.max(ED.toNumber(), minJoinBond.toNumber());

	// Top up transacting accounts
	if (!options.dry) {
		await topup_signers(api);
	}

	// go over all pools.
	console.log(`\n PHASE 1: Migrating pools.\n`);

	const pool_keys = await apiAt.query.nominationPools.bondedPools.keys();
	totalToProcess = pool_keys.length;
	console.log(
		`\n${new Date().toISOString()} :: Starting processing migration for ${totalToProcess} pools`
	);
	let txs = [];
	for (const key of pool_keys) {
		if (txs.length >= BATCH_SIZE) {
			await batch_send(api, txs);
			printProgress(`Waiting for ${DELAY / 1000} seconds.`, true);
			await new Promise((f) => setTimeout(f, DELAY));
			// clear txns.
			txs = [];
		}
		printProgress(``);

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
				printProgress(`Migrating Pool #${pool_id}.`, true);
				const do_pool_migrate = api.tx.nominationPools.migratePoolToDelegateStake(pool_id);
				txs.push(do_pool_migrate);
			}
		} else {
			alreadyMigrated++;
		}
		processed++;
	}

	console.log(
		`\nFinished migrating ${toMigrate} pools. Skipped ${alreadyMigrated} pools which were already migrated.\n`
	);

	// reset counters
	totalToProcess = 0;
	processed = 0;
	toMigrate = 0;
	alreadyMigrated = 0;

	// go over all pool members.
	console.log(`PHASE 2: Migrating pool members.`);
	const memberKeys = await apiAt.query.nominationPools.poolMembers.keys();
	totalToProcess = memberKeys.length;

	console.log(
		`\n${new Date().toISOString()} :: Starting processing migration for ${totalToProcess} pool members`
	);

	for (const key of memberKeys) {
		// batch tx if queue is full.
		if (txs.length >= BATCH_SIZE) {
			await batch_send(api, txs);
			printProgress(
				`Dispatched ${txs.length} transactions. Waiting for ${DELAY / 1000} seconds.`,
				true
			);
			// wait for 6 seconds
			await new Promise((f) => setTimeout(f, DELAY));
			// clear txns.
			txs = [];
		}
		printProgress(
			`Skipped migrations >> ${balanceLow} has low balance | ${alreadyStaking} staking directly.`
		);

		// check for pool migration
		const keyring = new Keyring();
		const member_account = keyring.decodeAddress(key.toHuman()?.toString());
		const member_acc_hex = u8aToHex(member_account);

		// check member balance
		const { data: member_balance } = await api.query.system.account(member_account);
		let is_balance_low = false;
		try {
			// this can fail if balance is larger than what number can hold.
			is_balance_low = member_balance.free.toNumber() < minBalance;
		} catch (e) {
			console.log(`Error while checking balance for ${key.toHuman()}.`);
		}
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
				printProgress(`Migrating member ${key.toHuman()}.`, true);
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
			// console.log(`Member ${key.toHuman()} has pending slash of ${member_pending_slash}.`);
			if (!options.dry) {
				const do_member_slash = api.tx.nominationPools.applySlash(member_account);
				txs.push(do_member_slash);
			}
		}

		processed++;
	}

	console.log(`\n ** Pool member migration Summary **`);
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

async function batch_send(api: ApiPromise, txs: any[]) {
	const keyring = new Keyring({ type: 'sr25519' });
	const seed = toMigrate % ACCOUNTS_TO_USE;
	const signer = keyring.addFromUri(`${MNEMONIC}//${seed}`);
	try {
		if (txs.length > 1) {
			await api.tx.utility.batch(txs).signAndSend(signer, ({ status }) => {
				if (status.isInBlock) {
					// console.log(`included in ${status.asInBlock}`);
				}
			});
		} else if (txs.length == 1) {
			await txs[0].signAndSend(signer);
		}
	} catch (error) {
		console.error(`Error while dispatching a transaction: ${error}`);
	}
}

async function topup_signers(api: ApiPromise) {
	const keyring = new Keyring({ type: 'sr25519' });
	const admin = keyring.createFromUri(`${MNEMONIC}`);

	for (let i = 0; i < ACCOUNTS_TO_USE; i++) {
		const signer = keyring.addFromUri(`${MNEMONIC}//${i}`);
		const { data: signer_balance } = await api.query.system.account(signer.address);
		const free_bal = signer_balance.free.toNumber();
		console.log(`Balance for signer with seed ${i} is ${free_bal}`);

		if (free_bal < TOPUP_BALANCE) {
			const topup = TOPUP_BALANCE - free_bal;
			console.log(`Topping up signer ${signer.address} (seed: ${i}) with ${topup}`);
			await api.tx.balances.transferKeepAlive(signer.address, topup).signAndSend(admin);
			// wait for 12 seconds before sending another tx.
			await new Promise((f) => setTimeout(f, 12000));
		}
	}
}

function printProgress(additional: string, force = false) {
	if (processed % progressStep == 0 || force) {
		process.stdout.clearLine(0);
		process.stdout.cursorTo(0);
		process.stdout.write(
			`Progress ${Math.round((processed * 10000) / totalToProcess) / 100}%` +
				` | Processed ${processed}/${totalToProcess}` +
				` | Stats: ${toMigrate} to migrate | ${alreadyMigrated} already migrated` +
				` | ${additional}`
		);
	}
}

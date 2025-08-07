// needed as of 7.x series, see CHANGELOG of the api repo.
import '@polkadot/api-augment';
import '@polkadot/types-augment';
import { u8aToHex, hexToNumber, numberToHex } from '@polkadot/util';
import { ApiPromise, Keyring, WsProvider } from '@polkadot/api';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// Delay between repeating transactions from the same account.
const DELAY = 3000;
// Setting it to more than one will batch transactions and they have fees.
const BATCH_SIZE = 1;
// how many transacting accounts to use
const ACCOUNTS_TO_USE = 6;
// balance to top up transacting accounts. This should be at least ED.
// KSM ED = 333,333,333 => 0.0003
// DOT ED = 10,000,000,000
const TOPUP_BALANCE = 18_000_000_000; // 1.8 DOT

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
	})
	.option('start_from', {
		alias: 's',
		type: 'number',
		default: 0,
		description: 'Start iterating from this index.'
	})
	.option('first_seed', {
		alias: 'f',
		type: 'number',
		default: 0,
		description: 'Use this as the first seed for the transacting account.'
	}).argv;

let toMigrate = 0;
let alreadyMigrated = 0;
let totalToProcess = 0;
let processed = 0;
// report progress every 50 iterations.
const progressStep = 50;
let shift_seed = 0;

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
	const { data: admin_balance } = await api.query.system.account(admin.address);

	console.log(
		`Using address ${
			admin.address
		} with balance ${admin_balance.free.toNumber()} to migrate the pool members.`
	);

	console.log(`\nParams: 
	\nDelay: ${DELAY / 1000} seconds 
	\nSeeding from: ${options.first_seed} 
	\nAccounts to use: ${ACCOUNTS_TO_USE} 
	\nStarting migration from: ${options.start_from} member index
	\nDry run: ${options.dry}
	\nEndpoint: ${options.endpoint}
	\n`);

	console.log(`Connected to node: **${(await api.rpc.system.chain()).toHuman()}**`);
	shift_seed = options.first_seed;

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
	let txs = [];

	const skipBy = options.start_from;

	// reset counters
	totalToProcess = 0;
	processed = 0;
	toMigrate = 0;
	alreadyMigrated = 0;

	// go over all pool members.
	console.log(`PHASE 2: Migrating pool members.`);
	const dualStakers = [];
	const memberKeys = await apiAt.query.nominationPools.poolMembers.keys();
	totalToProcess = memberKeys.length;

	console.log(
		`\n${new Date().toISOString()} :: Starting processing migration for ${totalToProcess} pool members`
	);

	for (const key of memberKeys.slice(skipBy)) {
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
		printProgress(`Skipped migrations >> ${dualStakers.length} dual staking.`);

		// check for pool migration
		const keyring = new Keyring();
		const member_account = keyring.decodeAddress(key.toHuman()?.toString());
		const member_acc_hex = u8aToHex(member_account);

		// check if member is already staking directly.
		// const is_staking_directly = (await api.query.staking.bonded(member_account)).isSome;
		// allow everyone to migrate.
		const is_staking_directly = false;

		const result = await api.rpc.state.call(
			'NominationPoolsApi_member_needs_delegate_migration',
			member_acc_hex
		);

		const should_migrate_delegation = result.toHex() == '0x01';
		if (is_staking_directly) {
			dualStakers.push(key.toHuman());
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
	console.log(`${dualStakers.length} members cannot be migrated since they are staking directly.`);
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
	const seed = ((toMigrate / BATCH_SIZE) % ACCOUNTS_TO_USE) + shift_seed;
	const signer = keyring.addFromUri(`${MNEMONIC}//${seed}`);
	// printProgress(`BATCH_SEND: Dispatching ${txs.length} transactions using seed ${seed}.`, true);

	// ensure signer has enough balance.
	const { data: signer_balance } = await api.query.system.account(signer.address);
	const free_bal = signer_balance.free.toNumber();

	if (free_bal < TOPUP_BALANCE) {
		console.error(`Signer ${signer.address} has insufficient balance: ${free_bal}. EXITING.`);
		process.exit(1);
	}

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

	for (let i = shift_seed; i < shift_seed + ACCOUNTS_TO_USE; i++) {
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

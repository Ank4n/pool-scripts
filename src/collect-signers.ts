// needed as of 7.x series, see CHANGELOG of the api repo.
import '@polkadot/api-augment';
import '@polkadot/types-augment';
import { ApiPromise, Keyring, WsProvider } from '@polkadot/api';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// Delay between repeating transactions from the same account.
const DELAY = 12000;
const ACCOUNTS_TO_USE = 32;

const optionsPromise = yargs(hideBin(process.argv)).option('endpoint', {
	alias: 'e',
	type: 'string',
	default: 'wss://westend-rpc.dwellir.com',
	description: 'the wss endpoint. It must allow unsafe RPCs.',
	demandOption: true
}).argv;

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
		`Funds will be moved to address ${
			admin.address
		} with initial balance ${admin_balance.free.toNumber()}.`
	);

	console.log(`\nParams: 
	\nDelay: ${DELAY / 1000} seconds 
	\nAccounts to use: ${ACCOUNTS_TO_USE} 
	\nEndpoint: ${options.endpoint}
	\n`);

	console.log(`Connected to node: **${(await api.rpc.system.chain()).toHuman()}**`);

	await collectSigners(api);
	process.exit(0);
}

main().catch(console.error);

async function collectSigners(api: ApiPromise) {
	const keyring = new Keyring({ type: 'sr25519' });
	const admin = keyring.createFromUri(`${MNEMONIC}`);

	for (let i = 0; i < ACCOUNTS_TO_USE; i++) {
		const signer = keyring.addFromUri(`${MNEMONIC}//${i}`);
		const { data: signer_balance } = await api.query.system.account(signer.address);
		const free_bal = signer_balance.free.toNumber();
		console.log(`Balance for signer with seed ${i} is ${free_bal}`);

		if (free_bal > 0) {
			await api.tx.balances.transferAll(admin.address, false).signAndSend(signer);
			await new Promise((f) => setTimeout(f, 12000));
			const { data: admin_balance } = await api.query.system.account(admin.address);
			console.log(`New balance for admin is ${admin_balance}`);
		}
	}
}

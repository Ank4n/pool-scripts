// needed as of 7.x series, see CHANGELOG of the api repo.
import '@polkadot/api-augment';
import '@polkadot/types-augment';
import { u8aToHex, hexToNumber, numberToHex } from '@polkadot/util';
import { ApiPromise, Keyring, WsProvider } from '@polkadot/api';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const optionsPromise = yargs(hideBin(process.argv)).option('endpoint', {
	alias: 'e',
	type: 'string',
	default: 'wss://westend-rpc.dwellir.com',
	description: 'the wss endpoint. It must allow unsafe RPCs.',
	demandOption: true
}).argv;

// report progress every 50 iterations.
const progressStep = 10;

let totalToProcess = 0;
let processed = 0;
const start = Date.now();

async function main() {
	const options = await optionsPromise;
	const provider = new WsProvider(options.endpoint);
	const api = await ApiPromise.create({ provider });
	const latest = await api.derive.chain.bestNumber();
	const latest_hash = await api.rpc.chain.getBlockHash(latest);
	const apiAt = await api.at(latest_hash);

	const keyring = new Keyring({ type: 'sr25519' });

	console.log(`\nParams: 
	\nEndpoint: ${options.endpoint}
	\n`);

	console.log(`Connected to node: **${(await api.rpc.system.chain()).toHuman()}**`);

	// number of provider -> frequency.
	const stakerProvider = new Map<number, number>();
	// number of consumer -> frequency.
	const stakerConsumer = new Map<number, number>();

	// number of provider -> frequency.
	const vstakerProvider = new Map<number, number>();
	// number of consumer -> frequency.
	const vstakerConsumer = new Map<number, number>();

	// number of provider -> frequency.
	const poolMemProvider = new Map<number, number>();
	// number of consumer -> frequency.
	const poolMemConsumer = new Map<number, number>();

	const stakers = await apiAt.query.staking.bonded.entries();
	const poolMembers = await apiAt.query.nominationPools.poolMembers.keys();

	// reset counters
	totalToProcess = stakers.length + poolMembers.length;
	processed = 0;

	// Go over all stakers (includes pool accounts).
	console.log(`PHASE 1: Go over all stakers.`);

	for (const [
		{
			args: [stash]
		},
		controller
	] of stakers) {
		printProgress();

		if (stash.toHuman() !== controller.unwrap().toHuman()) {
			console.log(`WARN:: stash ${stash} and controller ${controller} not same.`);
		}

		const account = keyring.decodeAddress(stash.toHuman()?.toString());
		const account_hex = u8aToHex(account);
		const account_info = await api.query.system.account(account_hex);
		const providers = account_info.providers.toNumber();
		const consumers = account_info.consumers.toNumber();

		if ((await api.query.staking.virtualStakers(account_hex)).isSome) {
			vstakerProvider.set(providers, (stakerProvider.get(providers) || 0) + 1);
			vstakerConsumer.set(consumers, (stakerConsumer.get(consumers) || 0) + 1);
		} else {
			stakerProvider.set(providers, (stakerProvider.get(providers) || 0) + 1);
			stakerConsumer.set(consumers, (stakerConsumer.get(consumers) || 0) + 1);
		}

		processed++;
	}

	console.log(`PHASE 2: Go over pool members.`);

	for (const key of poolMembers) {
		printProgress();
		const account = keyring.decodeAddress(key.toHuman()?.toString());
		const account_hex = u8aToHex(account);
		const account_info = await api.query.system.account(account_hex);
		const providers = account_info.providers.toNumber();
		const consumers = account_info.consumers.toNumber();

		poolMemProvider.set(providers, (poolMemProvider.get(providers) || 0) + 1);
		poolMemConsumer.set(consumers, (poolMemConsumer.get(consumers) || 0) + 1);
		processed++;
	}

	console.log(`\n # Provider Consumer Ref summary`);

	console.log(`\n ## Solo Staker Providers`);
	console.log(`************************`);
	console.log(stakerProvider);
	console.log(`************************`);

	console.log(`\n ## Solo Staker Consumers`);
	console.log(`************************`);
	console.log(stakerConsumer);
	console.log(`************************`);

	console.log(`\n ## Virtual Staker Providers`);
	console.log(`************************`);
	console.log(vstakerProvider);
	console.log(`************************`);

	console.log(`\n ## Virtual Staker Consumers`);
	console.log(`************************`);
	console.log(vstakerConsumer);
	console.log(`************************`);

	console.log(`\n ## Pool member Providers`);
	console.log(`************************`);
	console.log(poolMemProvider);
	console.log(`************************`);

	console.log(`\n ## Pool member Consumers`);
	console.log(`************************`);
	console.log(poolMemConsumer);
	console.log(`************************`);

	process.exit(0);
}

main().catch(console.error);

function printProgress() {
	if (processed % progressStep == 0) {
		const progress = Math.round((processed * 10000) / totalToProcess) / 100;
		const elapsed = Math.round((Date.now() - start) / 1000);
		const estimatedTotalTime = Math.round((elapsed * 100) / progress);
		const estimatedTimeLeft = estimatedTotalTime - elapsed;

		process.stdout.clearLine(0);
		process.stdout.cursorTo(0);
		process.stdout.write(
			`Progress ${progress}%` +
				` | Processed ${processed}/${totalToProcess}` +
				` | Elapsed ${elapsed}s` +
				` | Left ${estimatedTimeLeft}s.`
		);
	}
}

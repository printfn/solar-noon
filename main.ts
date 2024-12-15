import { find as geoTzFind } from 'geo-tz/now';
import { readFile, writeFile } from 'node:fs/promises';
import { sep } from 'node:path';
import { exit } from 'node:process';
import { promisify } from 'node:util';
import { brotliCompress, brotliDecompress } from 'node:zlib';
import 'temporal-polyfill/global';

const locale = 'en';

type Response = {
	lat: string;
	lon: string;
	display_name: string;
};

const CACHE_FILEPATH = import.meta.dirname + sep + 'cache.json.br';

type Cache = {
	[url: string]: {
		data: Response[];
		lastCached: string;
		lastRetrieved: string;
	};
};

async function loadCache(): Promise<Cache> {
	try {
		const compressedData = await readFile(CACHE_FILEPATH, null);
		const data = await promisify(brotliDecompress)(compressedData);
		return JSON.parse(data.toString('utf-8'));
	} catch (err) {
		if (err.code === 'ENOENT') {
			await saveCache({});
			return await loadCache();
		}
		throw err;
	}
}

async function saveCache(cache: Cache) {
	const data = JSON.stringify(cache, null, 4);
	const compressedData = await promisify(brotliCompress)(data);
	await writeFile(CACHE_FILEPATH, compressedData, null);
}

async function cachedFetch(url: string): Promise<Response[]> {
	const cache: Cache = await loadCache();

	if (cache[url]) {
		const entry = cache[url];
		entry.lastRetrieved = Temporal.Now.instant().toString();
		await saveCache(cache);
		return entry.data;
	}

	// console.debug(`GET ${url}`);
	const response = await fetch(url, {
		headers: {
			'User-Agent': 'github.com/printfn/solar-noon-checker',
		},
	});
	if (!response.ok) {
		throw new Error(`failed to fetch ${url}: ${response.statusText}`);
	}
	const data: Response[] = await response.json();
	cache[url] = {
		data,
		lastCached: Temporal.Now.instant().toString(),
		lastRetrieved: Temporal.Now.instant().toString(),
	};
	await saveCache(cache);
	return data;
}

async function geocode(location: string) {
	const endpoint = 'https://nominatim.openstreetmap.org/search';
	const url = `${endpoint}?q=${encodeURIComponent(location)}&format=jsonv2&accept-language=${locale}`;
	const json = await cachedFetch(url);
	return json.map(location => ({
		...location,
		lat: parseFloat(location.lat),
		lon: parseFloat(location.lon),
	}));
}

function findTimezones(lat: number, lon: number) {
	const tzs = geoTzFind(lat, lon);
	if (tzs.length > 1) {
		console.warn(
			`Warning: ambiguous time zones for coordinates ${lat},${lon}:`,
			tzs.join(', '),
		);
	}
	return tzs;
}

function nextTransition(
	date: Temporal.ZonedDateTime,
): Temporal.ZonedDateTime | null {
	if ('getTimeZoneTransition' in date) {
		return (date.getTimeZoneTransition as any)('next');
	}
	return (
		date
			.getTimeZone()
			.getNextTransition?.(date.toInstant())
			?.toZonedDateTimeISO(date.timeZoneId) ?? null
	);
}

function getTimeZoneOffset(date: Temporal.ZonedDateTime | Temporal.Duration) {
	let offsetMs = 0;
	if (date instanceof Temporal.ZonedDateTime) {
		const e1 = date
			.toPlainDateTime()
			.toZonedDateTime('UTC')
			.toInstant().epochMilliseconds;
		const e2 = date.toInstant().epochMilliseconds;
		offsetMs = e1 - e2;
	} else {
		offsetMs = date.total('milliseconds');
	}
	const plainTime = Temporal.PlainTime.from('00:00').add({
		milliseconds: Math.round(Math.abs(offsetMs)),
	});
	const sign = offsetMs < 0 ? '-' : '+';
	return `UTC${sign}${plainTime.toString({ smallestUnit: 'minutes' })}`;
}

function solarNoon(date: Temporal.ZonedDateTime, lon: number) {
	const noon = Temporal.PlainTime.from('12:00')
		.toZonedDateTime({
			timeZone: 'UTC',
			plainDate: date.toPlainDate(),
		})
		.subtract({ milliseconds: Math.round((lon / 180) * 12 * 60 * 60 * 1000) })
		.withTimeZone(date.timeZoneId);
	return {
		date: noon.toPlainDate().toLocaleString(locale, { dateStyle: 'full' }),
		time: noon.toPlainTime().toLocaleString(locale, { timeStyle: 'long' }),
		tz: getTimeZoneOffset(noon),
	};
}

function solarNoons(tz: string, lon: number) {
	const now = Temporal.Now.zonedDateTimeISO(tz);
	const futureTransitions: Temporal.ZonedDateTime[] = [];
	while (futureTransitions.length < 2) {
		const nextDate = nextTransition(futureTransitions.at(-1) ?? now);
		if (nextDate === null) break;
		futureTransitions.push(nextDate);
	}
	return {
		current: solarNoon(now, lon),
		futureTransitions: futureTransitions.map(d => solarNoon(d, lon)),
	};
}

async function calculate(location: string) {
	const locations = (await geocode(location)).flatMap(location =>
		findTimezones(location.lat, location.lon).map(tz => ({ tz, location })),
	);
	for (let i = 0; i < locations.length; ++i) {
		if (i > 0) {
			console.log();
		}
		const { location, tz } = locations[i];
		const noons = solarNoons(tz, location.lon);
		console.log(`Location: ${location.display_name}`);
		console.log(`Coordinates: ${location.lat}, ${location.lon}`);
		console.log(`Time zone: ${tz}`);
		console.log(
			`Solar noon is currently at ${noons.current.time} (${noons.current.tz})`,
		);
		if (noons.futureTransitions.length === 0) {
			console.log(
				'No daylight saving or other time zone changes are scheduled.',
			);
		} else {
			for (const { date, time, tz } of noons.futureTransitions) {
				console.log(`From ${date}, solar noon will shift to ${time} (${tz})`);
			}
		}
		const optimalTz = getTimeZoneOffset(
			Temporal.Duration.from({ hours: Math.round((location.lon / 180) * 12) }),
		);
		console.log(`The optimal whole-hour UTC offset would be ${optimalTz}`);
	}
}

if (process.argv.length < 3) {
	console.error('Please specify a location as a command-line argument');
	exit(1);
}

await calculate(process.argv.slice(2).join(' '));

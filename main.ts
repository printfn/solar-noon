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
	let tz: Temporal.TimeZoneProtocol;
	if ('timeZone' in date) {
		tz = date.timeZone as Temporal.TimeZoneProtocol;
	} else {
		tz = date.getTimeZone();
	}
	return (
		tz.getNextTransition?.(date.toInstant())?.toZonedDateTimeISO(tz) ?? null
	);
}

function getTimeZoneOffset(offset: Temporal.Duration) {
	const plainTime = Temporal.PlainTime.from('00:00')
		.add(offset.abs())
		.toString({ smallestUnit: 'minutes' });
	const sign = offset.sign < 0 ? '-' : '+';
	return new Temporal.ZonedDateTime(0n, `${sign}${plainTime}`).offset;
}

function nextSolarNoon(date: Temporal.ZonedDateTime, lon: number) {
	const solarNoon = 43200000 - Math.round((lon / 180) * 12 * 60 * 60 * 1000);
	let diff = solarNoon - (date.epochMilliseconds % 86400000);
	while (diff < 0) {
		diff += 86400000;
	}
	return date.add({ milliseconds: diff });
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
		current: nextSolarNoon(now, lon),
		futureTransitions: futureTransitions.map(d => ({
			transition: d,
			solarNoon: nextSolarNoon(d, lon),
		})),
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
		const formattedCurrentNoonTime = noons.current
			.toPlainTime()
			.toLocaleString(locale, { timeStyle: 'long' });
		console.log(
			`Solar noon is currently at ${formattedCurrentNoonTime} (${noons.current.offset})`,
		);
		if (noons.futureTransitions.length === 0) {
			console.log(
				'No daylight saving or other time zone changes are scheduled.',
			);
		} else {
			for (const { transition, solarNoon } of noons.futureTransitions) {
				const formattedTransitionDate = transition
					.toPlainDate()
					.toLocaleString(locale, { dateStyle: 'full' });
				const formattedSolarNoonTime = solarNoon
					.toPlainTime()
					.toLocaleString(locale, { timeStyle: 'long' });
				console.log(
					`From ${formattedTransitionDate}, solar noon will shift to ${formattedSolarNoonTime} (${solarNoon.offset})`,
				);
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

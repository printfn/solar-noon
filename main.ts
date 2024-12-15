import { find as geoTzFind } from 'geo-tz/now';
import { exit } from 'node:process';
import 'temporal-polyfill/global';

const locale = 'en';

async function geocode(location: string) {
	const endpoint = 'https://nominatim.openstreetmap.org/search';
	const url = `${endpoint}?q=${encodeURIComponent(location)}&format=jsonv2&accept-language=${locale}`;
	// console.debug(`GET ${url}`);
	const response = await fetch(url, {
		headers: {
			'User-Agent': 'solar-noon-checker',
		},
	});
	type Response = {
		lat: string;
		lon: string;
		display_name: string;
	};
	const json: Response[] = await response.json();
	/*
[
	{
		place_id: 241348419,
		licence: 'Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright',
		osm_type: 'relation',
		osm_id: 1543125,
		lat: '35.6768601',
		lon: '139.7638947',
		category: 'boundary',
		type: 'administrative',
		place_rank: 8,
		importance: 0.82108616521785,
		addresstype: 'province',
		name: 'Tokyo',
		display_name: 'Tokyo, Japan',
		boundingbox: [ '20.2145811', '35.8984245', '135.8536855', '154.2055410' ]
	},
	// ...
]
	*/
	return json.map(location => ({ ...location, lat: parseFloat(location.lat), lon: parseFloat(location.lon) }));
}

function findTimezones(lat: number, lon: number) {
	const tzs = geoTzFind(lat, lon);
	if (tzs.length > 1) {
		console.warn(`Warning: ambiguous time zones for coordinates ${lat},${lon}:`, tzs.join(', '));
	}
	return tzs;
}

function nextTransition(date: Temporal.ZonedDateTime): Temporal.ZonedDateTime | null {
	if ('getTimeZoneTransition' in date) {
		return (date.getTimeZoneTransition as any)('next');
	}
	return date.getTimeZone().getNextTransition?.(date.toInstant())?.toZonedDateTimeISO(date.timeZoneId) ?? null;
}

function solarNoon(date: Temporal.ZonedDateTime, lon: number) {
	const noon = Temporal.PlainTime.from('12:00')
		.toZonedDateTime({
			timeZone: 'UTC',
			plainDate: date.toPlainDate(),
		})
		.subtract({ milliseconds: Math.round(lon / 180 * 12 * 60 * 60 * 1000) })
		.withTimeZone(date.timeZoneId);
	return {
		date: noon.toPlainDate().toLocaleString(locale, { dateStyle: 'full' }),
		time: noon.toPlainTime().toLocaleString(locale, { timeStyle: 'long' }),
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
	const locations = (await geocode(location))
		.flatMap(location => findTimezones(location.lat, location.lon).map(tz => ({ tz, location })));
	for (let i = 0; i < locations.length; ++i) {
		if (i > 0) {
			console.log();
		}
		const { location, tz } = locations[i];
		const noons = solarNoons(tz, location.lon);
		console.log(`Location: ${location.display_name}`);
		console.log(`Coordinates: ${location.lat}, ${location.lon}`);
		console.log(`Time zone: ${tz}`);
		console.log(`Solar noon is currently at ${noons.current.time}`);
		if (noons.futureTransitions.length === 0) {
			console.log('No daylight saving or other time zone changes are scheduled.');
		} else {
			for (const { date, time } of noons.futureTransitions) {
				console.log(`From ${date}, solar noon will shift to ${time}`);
			}
		}
	}
}

if (process.argv.length < 3) {
	console.error('Please specify a location as a command-line argument');
	exit(1);
}

await calculate(process.argv.slice(2).join(' '));

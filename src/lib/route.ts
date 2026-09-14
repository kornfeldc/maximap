export interface GeocodedStop {
	name: string;
	lat: number;
	lon: number;
}

export interface RouteResult {
	coords: [number, number][]; // [lat, lon]
	distanceKm: number;
	stops: GeocodedStop[];
	failed: string[];
}

/**
 * Geocodes a city name. Primary: Nominatim (OpenStreetMap).
 * Falls back to Photon (Komoot) if Nominatim is unavailable or rate-limited.
 */
export async function geocodeCity(name: string): Promise<GeocodedStop | null> {
	try {
		const r = await geocodeNominatim(name);
		if (r) return r;
	} catch {
		/* Nominatim nicht erreichbar -> Fallback */
	}
	return geocodePhoton(name);
}

async function geocodeNominatim(name: string): Promise<GeocodedStop | null> {
	const url =
		'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=de&countrycodes=at&q=' +
		encodeURIComponent(name);
	const res = await fetch(url, { headers: { Accept: 'application/json' } });
	if (!res.ok) throw new Error(`Geokodierung fehlgeschlagen für "${name}"`);
	const data: Array<{ lat: string; lon: string }> = await res.json();
	if (!data.length) return null;
	return { name, lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

async function geocodePhoton(name: string): Promise<GeocodedStop | null> {
	// Alle Eingaben sind in Österreich: Suche über Bounding-Box von Österreich einschränken
	const url =
		'https://photon.komoot.io/api/?limit=1&lang=de&bbox=9.0,46.3,17.5,49.1&q=' +
		encodeURIComponent(name);
	const res = await fetch(url, { headers: { Accept: 'application/json' } });
	if (!res.ok) throw new Error(`Geokodierung fehlgeschlagen für "${name}"`);
	const data = await res.json();
	const f = data.features?.[0];
	if (!f) return null;
	const [lon, lat] = f.geometry.coordinates;
	return { name, lat, lon };
}

/**
 * Fetches the driving route through all stops from the free OSRM demo server.
 * Supports far more than 20 waypoints.
 */
export async function fetchRoute(
	stops: GeocodedStop[]
): Promise<{ coords: [number, number][]; distanceKm: number }> {
	const coordsStr = stops.map((s) => `${s.lon},${s.lat}`).join(';');
	const url = `https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson`;
	const res = await fetch(url);
	if (!res.ok) throw new Error('Routenberechnung fehlgeschlagen (OSRM)');
	const data = await res.json();
	if (data.code !== 'Ok' || !data.routes?.length) {
		throw new Error('Routenberechnung fehlgeschlagen: keine Route gefunden');
	}
	const route = data.routes[0];
	const coords: [number, number][] = route.geometry.coordinates.map(
		(c: [number, number]) => [c[1], c[0]] as [number, number]
	);
	return { coords, distanceKm: route.distance / 1000 };
}
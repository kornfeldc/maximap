export interface ParsedStop {
	name: string;
	pause: boolean;
}

/**
 * Parst unstrukturierten Text (z. B. aus WhatsApp/E-Mail kopiert) in eine Orteliste.
 * Das Trennzeichen ist bewusst nicht fix: erkannt werden Zeilenumbrüche, Komma,
 * Semikolon, Strichpunkt, Pipe, Slash, Tab, Aufzählungszeichen, Pfeile und
 * Bindestriche mit Leerzeichen. Bindestriche ohne Leerzeichen bleiben erhalten
 * (z. B. "Garmisch-Partenkirchen").
 * "(Pause)" hinter einem Ort markiert diesen automatisch als Pause.
 */
export function parseStopsText(
	text: string,
	options?: { linesOnly?: boolean }
): ParsedStop[] {
	let t = text.replace(/\r\n?/g, '\n');
	if (options?.linesOnly) {
		// Import-Modus: ausschließlich Zeilenumbrüche als Trenner
		t = t
			.replace(/^[ \t]*[-*•][ \t]+/gm, '')
			.replace(/\t+/g, ' ');
	} else {
		t = t
		// Aufzählungszeichen und Tabs als Trenner
		.replace(/[•·▪◦‣]/g, '\n')
		.replace(/\t+/g, '\n')
		// Pfeile und Gedankenstriche (auch ohne Leerzeichen)
		.replace(/\s*(?:->|=>|→|–|—)\s*/g, '\n')
		// Bindestrich mit Leerzeichen als Trenner ("Garmisch-Partenkirchen" bleibt intakt)
		.replace(/[ \t]-(?=[ \t])/g, '\n')
		.replace(/[;,|/]/g, '\n')
		.replace(/\s+(?:und|&)\s+/gi, '\n');
	}

	const seen = new Set<string>();
	const out: ParsedStop[] = [];
	for (const raw of t.split('\n')) {
		let s = raw.trim();
		// "(Pause)" erkennen und entfernen
		let pause = false;
		const pauseMatch = s.match(/\(\s*pause\s*\)/i);
		if (pauseMatch) {
			pause = true;
			s = s.replace(pauseMatch[0], '');
		}
		// Nummerierungs- und Aufzählungspräfixe entfernen ("1.", "2)", "Stop 3:", "- ")
		s = s
			.replace(/^(?:stop|stopp|etappe|ziel|ort)\s*\d*\s*[.:)\]-]*\s*/i, '')
			.replace(/^\d+\s*[.)]\s*/, '')
			.replace(/^[-*•\s]+/, '')
			.replace(/[.]*\s*$/, '')
			.replace(/["“”]+/g, '')
			.trim();
		if (!s || s.length < 2) continue;
		if (/^\d+$/.test(s)) continue; // reine Nummernzeilen sind keine Orte
		const key = s.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ name: s, pause });
	}
	return out;
}
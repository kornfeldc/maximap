<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { browser } from '$app/environment';
	import 'leaflet/dist/leaflet.css';
	import type L from 'leaflet';
	import { geocodeCity, fetchRoute, type GeocodedStop } from '$lib/route';
import { parseStopsText } from '$lib/parse';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import {
		Card,
		CardContent,
		CardFooter,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';

	const STORAGE_KEY = 'maximap.state.v1';

	// ---------- Persistierter Zustand (nur localStorage, kein Backend) ----------
	interface StopEntry {
		id: number;
		name: string;
		pause: boolean;
	}

	interface PersistedState {
		stops: StopEntry[];
		title: string;
		tripDate: string;
		showLogo: boolean;
	}

	let stopIdCounter = 1;
	function nextStopId(): number {
		return ++stopIdCounter;
	}

	function normalizeStops(raw: unknown): StopEntry[] {
		if (!Array.isArray(raw)) return [];
		return raw.map((s) => ({
			id: nextStopId(),
			name: typeof s === 'string' ? s : String(s?.name ?? ''),
			pause: typeof s === 'object' && s !== null ? Boolean(s?.pause) : false
		}));
	}

	function loadState(): PersistedState {
		const fallback: PersistedState = {
			stops: [
				{ id: nextStopId(), name: '', pause: false },
				{ id: nextStopId(), name: '', pause: false }
			],
			title: 'Gemeinschaftsfahrt',
			tripDate: '',
			showLogo: true
		};
		if (!browser) return fallback;
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (raw) {
				const parsed = JSON.parse(raw);
				return { ...fallback, ...parsed, stops: normalizeStops(parsed.stops) };
			}
		} catch {
			/* ignore */
		}
		return fallback;
	}

	let stops = $state<StopEntry[]>(
		loadState().stops.length
			? loadState().stops
			: [
					{ id: nextStopId(), name: '', pause: false },
					{ id: nextStopId(), name: '', pause: false }
				]
	);
	let title = $state(loadState().title);
	let tripDate = $state(loadState().tripDate);
	let showLogo = $state(loadState().showLogo);
	let panelOpen = $state(true);

	$effect(() => {
		if (!browser) return;
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ stops, title, tripDate, showLogo }));
	});

	// ---------- Karten-/Routen-Zustand ----------
	let mapEl: HTMLDivElement | undefined = $state();
	let map: L.Map | undefined;
	let leafletLib: typeof import('leaflet') | undefined;
	let routeLine: L.Polyline | undefined;
let casingLine: L.Polyline | undefined;
	let markers: L.Marker[] = [];
	let group: L.LayerGroup | undefined;
	let imageryLayer: L.TileLayer | undefined;
	let labelLayer: L.TileLayer | undefined;
	let currentRouteCoords: [number, number][] = [];

	let busy = $state(false);
	let progressText = $state('');
	let errorMessage = $state('');
	let routeDistanceKm = $state<number | null>(null);
	let resolvedStops = $state<(GeocodedStop & { pause: boolean })[]>([]);
	let failedStops = $state<string[]>([]);

	let printing = $state(false);
	let printImage = $state('');
	let saveOpen = $state(false);

	onMount(() => {
		import('leaflet').then(({ default: L }) => {
			leafletLib = L;
			map = L.map(mapEl!, {
			zoomControl: false,
			attributionControl: false,
			worldCopyJump: true
		}).setView([47.8509991, 16.6255695], 12); // Start: Schützen am Gebirge

		imageryLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
			maxZoom: 19,
			attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics',
			crossOrigin: true
		}).addTo(map);

		// Stadt- und Ortsnamen über dem Satellitenbild
		labelLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
			maxZoom: 19,
			opacity: 0.9,
			crossOrigin: true
		}).addTo(map);

		L.control.zoom({ position: 'bottomleft' }).addTo(map);
		L.control
			.attribution({ position: 'bottomleft', prefix: false })
			.addAttribution('Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics')
			.addTo(map);

			group = L.layerGroup().addTo(map);
		});

		return () => {
			map?.remove();
			map = undefined;
		};
	});

	function clearRouteVisuals() {
		group?.clearLayers();
		markers = [];
		routeLine = undefined;
		casingLine = undefined;
		currentRouteCoords = [];
	}

	function markerIcon(index: number, isPause: boolean, isStart: boolean, isEnd: boolean) {
		const L = leafletLib!;
		const big = isPause || isStart || isEnd;
		const size = big ? 40 : 30;
		const cls = isStart ? ' stop-marker-start' : isEnd ? ' stop-marker-end' : isPause ? ' stop-marker-pause' : '';
		const badges =
			(isStart ? '<span class="marker-corner start">S</span>' : '') +
			(isEnd ? '<span class="marker-corner end">Z</span>' : '') +
			(isPause ? '<span class="pause-badge" title="Pause">⏸</span>' : '');
		return L.divIcon({
			className: 'stop-marker-wrapper',
			html: `<div class="stop-marker${cls}" style="width:${size}px;height:${size}px;font-size:${
				big ? 17 : 14
			}px">${index + 1}${badges}</div>`,
			iconSize: [size, size],
			iconAnchor: [size / 2, size / 2]
		});
	}

	async function computeRoute() {
		if (busy) return;
		errorMessage = '';
		routeDistanceKm = null;
		resolvedStops = [];
		failedStops = [];

		const entries = stops.map((s) => ({ name: s.name.trim(), pause: s.pause })).filter((e) => e.name.length > 0);
		if (entries.length < 2) {
			errorMessage = 'Bitte mindestens zwei Orte eingeben.';
			clearRouteVisuals();
			return;
		}

		busy = true;
		try {
			// 1) Alle Orte geokodieren
			const found: (GeocodedStop & { pause: boolean })[] = [];
			const failed: string[] = [];
			for (let i = 0; i < entries.length; i++) {
				progressText = `Orte werden gesucht … ${i + 1}/${entries.length}`;
				// Nominatim erlaubt max. 1 Anfrage/Sekunde
				if (i > 0) await new Promise((r) => setTimeout(r, 1100));
				let g: GeocodedStop | null = null;
				for (let attempt = 0; attempt < 2; attempt++) {
					try {
						g = await geocodeCity(entries[i].name);
						break;
					} catch {
						if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
					}
				}
				if (g) found.push({ ...g, pause: entries[i].pause });
				else failed.push(entries[i].name);
			}
			failedStops = failed;

			if (found.length < 2) {
				errorMessage = 'Zu viele Orte konnten nicht gefunden werden. Bitte prüfen.';
				clearRouteVisuals();
				return;
			}

			// 2) Route berechnen
			progressText = 'Route wird berechnet …';
			const { coords, distanceKm } = await fetchRoute(found);

			// 3) Karte zeichnen
			clearRouteVisuals();
			currentRouteCoords = coords;
			const L = leafletLib!;
			casingLine = L.polyline(coords, { color: '#0f172a', weight: 9, opacity: 0.9 }).addTo(group!);
			routeLine = L.polyline(coords, { color: '#fbbf24', weight: 5, opacity: 1 }).addTo(group!);
			found.forEach((s, i) => {
				const icon = markerIcon(i, s.pause, i === 0, i === found.length - 1);
				const m = L.marker([s.lat, s.lon], { icon }).addTo(group!);
				m.bindTooltip(`${i + 1}. ${s.name}${s.pause ? ' (Pause)' : ''}${i === 0 ? ' – Start' : ''}${i === found.length - 1 ? ' – Ziel' : ''}`, { direction: 'top', offset: [0, -12] });
				markers.push(m);
			});
			map?.fitBounds(casingLine.getBounds(), { padding: [80, 80] });

			resolvedStops = found;
			routeDistanceKm = distanceKm;
		} catch (e) {
			errorMessage = e instanceof Error ? e.message : 'Unbekannter Fehler';
			clearRouteVisuals();
		} finally {
			busy = false;
			progressText = '';
		}
	}

	function addStop(afterIndex?: number): number {
		const entry: StopEntry = { id: nextStopId(), name: '', pause: false };
		if (afterIndex === undefined || afterIndex >= stops.length - 1) {
			stops = [...stops, entry];
		} else {
			stops = [...stops.slice(0, afterIndex + 1), entry, ...stops.slice(afterIndex + 1)];
		}
		return entry.id;
	}

	function removeStop(i: number) {
		stops = stops.filter((_, idx) => idx !== i);
	}

	function moveStop(i: number, dir: -1 | 1) {
		const j = i + dir;
		if (j < 0 || j >= stops.length) return;
		const copy = [...stops];
		[copy[i], copy[j]] = [copy[j], copy[i]];
		stops = copy;
	}

	// ---------- Liste einfügen (unstrukturierter Text) ----------
	let pasteOpen = $state(false);
	let pasteText = $state('');
	let fileInput: HTMLInputElement | undefined = $state();

	// ---------- Tastatursteuerung für die Ortsliste ----------
	async function focusStop(id: number) {
		await tick();
		const el = document.getElementById(`ort-${id}`) as HTMLInputElement | null;
		if (!el) return;
		el.focus();
		el.setSelectionRange(el.value.length, el.value.length);
		el.scrollIntoView({ block: 'nearest' });
	}

	function handleStopKeydown(i: number) {
		return async (e: KeyboardEvent) => {
			if (e.isComposing) return;
			if (e.key === 'Enter') {
				e.preventDefault();
				if (i < stops.length - 1) {
					await focusStop(stops[i + 1].id);
				} else if (stops[i].name.trim()) {
					const id = addStop();
					await focusStop(id);
				}
			} else if (e.key === 'ArrowDown' && i < stops.length - 1) {
				e.preventDefault();
				await focusStop(stops[i + 1].id);
			} else if (e.key === 'ArrowUp' && i > 0) {
				e.preventDefault();
				await focusStop(stops[i - 1].id);
			}
		};
	}

	// ---------- Import / Export der Route ----------
	function exportRouteJson(): string {
		return JSON.stringify(
			{
				app: 'maximap',
				version: 1,
				title,
				stops: stops.map(({ name, pause }) => ({ name, pause }))
			},
			null,
			2
		);
	}

	function saveRouteFile() {
		const blob = new Blob([exportRouteJson()], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${(title.trim() || 'gemeinschaftsfahrt').replace(/[^\w\- äöüßÄÖÜ]/g, '')}.maximap.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	let copied = $state(false);
	async function copyRouteToClipboard() {
		try {
			await navigator.clipboard.writeText(exportRouteJson());
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			errorMessage = 'Zwischenablage nicht verfügbar.';
		}
	}

	function importRouteText(text: string): boolean {
		const trimmed = text.trim();
		if (trimmed.startsWith('{')) {
			try {
				const obj = JSON.parse(trimmed);
				if (Array.isArray(obj.stops) && obj.stops.length) {
					stops = obj.stops.map((s: unknown) => ({
						id: nextStopId(),
						name: typeof s === 'string' ? s : String((s as { name?: unknown })?.name ?? ''),
						pause: typeof s === 'object' && s !== null ? Boolean((s as { pause?: unknown })?.pause) : false
					}));
					if (typeof obj.title === 'string' && obj.title.trim()) title = obj.title;
					pasteText = '';
					pasteOpen = false;
					errorMessage = '';
					return true;
				}
			} catch {
				/* fällt auf Text-Import durch */
			}
			errorMessage = 'Ungültige Routendatei.';
			return false;
		}
		const parsed = parseStopsText(text, { linesOnly: true });
		if (parsed.length) {
			stops = parsed.map((p) => ({ id: nextStopId(), name: p.name, pause: p.pause }));
			pasteText = '';
			pasteOpen = false;
			errorMessage = '';
			return true;
		}
		errorMessage = 'In dem Text wurden keine Orte erkannt.';
		return false;
	}

	async function openRouteFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		importRouteText(await file.text());
		input.value = '';
	}

		// ---------- Export / Druck ----------
	function roundRectPath(
		ctx: CanvasRenderingContext2D,
		x: number,
		y: number,
		w: number,
		h: number,
		r: number
	) {
		ctx.beginPath();
		ctx.moveTo(x + r, y);
		ctx.arcTo(x + w, y, x + w, y + h, r);
		ctx.arcTo(x + w, y + h, x, y + h, r);
		ctx.arcTo(x, y + h, x, y, r);
		ctx.arcTo(x, y, x + w, y, r);
		ctx.closePath();
	}

	/** Lädt das Logo als Bild (für Overlay-Zeichnung). */
	function loadLogoImage(): Promise<HTMLImageElement | null> {
		return new Promise((resolve) => {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = () => resolve(null);
			img.src = '/logo.png';
		});
	}

	/** Misst die Stopplisten-Overlay-Größe (für Ausrichtung der Route beim Export). */
	function computeStopsBoxLayout(): { w: number; h: number } {
		const cssW = 794;
		const cssH = 1123;
		if (!resolvedStops.length) return { w: 0, h: 0 };
		const twoCols = resolvedStops.length > 16;
		const rowH = 23;
		const pad = 14;
		const headH = 30;
		const rowsPerCol = twoCols ? Math.ceil(resolvedStops.length / 2) : resolvedStops.length;
		const h = headH + rowsPerCol * rowH + pad;
		const c = document.createElement('canvas').getContext('2d')!;
		c.font = '12.5px sans-serif';
		let nameW = 0;
		for (const s of resolvedStops) nameW = Math.max(nameW, c.measureText(s.name).width);
		const colW = Math.min(46 + nameW + 60, cssW / 2 - 40);
		const w = twoCols ? colW * 2 + pad : colW + pad * 2;
		return { w: Math.min(w, cssW * 0.8), h: Math.min(h, cssH * 0.6) };
	}

	/** Misst die einspaltige Stoppliste für das Hochformat-Layout (hohe Route). */
	function computeStopsBoxLayoutTall(): { w: number; h: number } {
		if (!resolvedStops.length) return { w: 0, h: 0 };
		const c = document.createElement('canvas').getContext('2d')!;
		c.font = '12.5px sans-serif';
		let nameW = 0;
		for (const s of resolvedStops) nameW = Math.max(nameW, c.measureText(s.name).width);
		const w = 46 + nameW + 60;
		const h = 30 + resolvedStops.length * 23 + 14;
		return { w, h };
	}

	/**
	 * Erzeugt das Export-Bild: Karte im A4-Hochformat-Seitenverhältnis,
	 * die den vollen Bereich füllt. Titel, Logo und Stoppliste werden als
	 * Overlays direkt auf die Karte gezeichnet (wie in der Vorschau).
	 */
	async function captureMap(): Promise<{ dataUrl: string; width: number; height: number }> {
		if (!map || !mapEl) throw new Error('Karte nicht bereit');
		const L = leafletLib!;

		// A4-Hochformat in CSS-Pixeln (96 dpi), 2.5x für Druckqualität
		const cssW = 794;
		const cssH = 1123;
		const scale = 2.5;

		// Ansicht merken und Karte temporär ins Hochformat bringen
		const prevCenter = map.getCenter();
		const prevZoom = map.getZoom();
		const prevStyle = mapEl.getAttribute('style') ?? '';
		mapEl.style.position = 'fixed';
		mapEl.style.left = '0';
		mapEl.style.top = '0';
		mapEl.style.width = `${cssW}px`;
		mapEl.style.height = `${cssH}px`;
		mapEl.style.zIndex = '-1';
		mapEl.style.inset = 'auto';
		map.invalidateSize();

		// Ausrichtung bestimmen: Ist die Route höher als breit? Dann kommt die
		// Stoppliste rechts in eine einspaltige Liste und die Route wird links
		// ausgerichtet. Sonst bleibt das bisherige Layout (Liste unten rechts).
		let bbox: { w: number; h: number } | null = null;
		if (currentRouteCoords.length > 1) {
			const b = L.latLngBounds(currentRouteCoords);
			bbox = { w: b.getEast() - b.getWest(), h: b.getNorth() - b.getSouth() };
		}
		// Breitengrad-Korrektur: Bei gleichen Meter-Distanzen sind Breitengrade
		// "wertvoller", daher mit cos(Breite) in Längengrad-Einheiten umrechnen.
		const routeIsTall =
			bbox !== null && bbox.h / Math.max(bbox.w, 1e-9) > 0.85;

		if (currentRouteCoords.length > 1) {
			// Overlays einrechnen: Titelbox oben links, Logo oben rechts.
			// Hohe Route: Route links, Stoppliste einspaltig rechts unten.
			// Breite Route: Stoppliste unten rechts wie bisher.
			const titleTop = 16 + 70 + 16; // Titelbox unten
			const padTopLeft: [number, number] = routeIsTall
				? [24, Math.max(titleTop, 60)]
				: [Math.round(computeStopsBoxLayout().w * 0.45), Math.max(titleTop, 90)];
			const padBotRight: [number, number] = routeIsTall
				? [computeStopsBoxLayoutTall().w + 24, 24]
				: [
						Math.round(computeStopsBoxLayout().w * 0.6),
						Math.round(computeStopsBoxLayout().h * 0.75)
					];
			map.fitBounds(L.latLngBounds(currentRouteCoords), {
				paddingTopLeft: padTopLeft,
				paddingBottomRight: padBotRight
			});
		}

		// Auf geladene Kacheln warten (max. 5 s)
		await new Promise<void>((resolve) => {
			let done = false;
			const finish = () => {
				if (!done) {
					done = true;
					resolve();
				}
			};
			let pending = 0;
			for (const layer of [imageryLayer, labelLayer]) {
				if (!layer) continue;
				pending++;
				layer.once('load', finish);
			}
			if (pending === 0) finish();
			else setTimeout(finish, 5000);
		});
		await new Promise((r) => setTimeout(r, 350));

		const rect = mapEl.getBoundingClientRect();
		const canvas = document.createElement('canvas');
		canvas.width = Math.round(cssW * scale);
		canvas.height = Math.round(cssH * scale);
		const ctx = canvas.getContext('2d')!;
		ctx.scale(scale, scale);
		ctx.fillStyle = '#000000';
		ctx.fillRect(0, 0, cssW, cssH);

		// 1) Kacheln
		for (const t of mapEl.querySelectorAll('img.leaflet-tile')) {
			const img = t as HTMLImageElement;
			if (!img.complete || img.naturalWidth === 0) continue;
			const r = img.getBoundingClientRect();
			try {
				ctx.drawImage(img, r.left - rect.left, r.top - rect.top, r.width, r.height);
			} catch {
				/* Kachel überspringen */
			}
		}

		// 2) Route (dunkle Kontur + gelbe Linie)
		const pts = currentRouteCoords.map((c) => map!.latLngToContainerPoint([c[0], c[1]]));
		if (pts.length > 1) {
			const drawLine = (weight: number, color: string) => {
				ctx.beginPath();
				ctx.moveTo(pts[0].x, pts[0].y);
				for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
				ctx.lineWidth = weight;
				ctx.strokeStyle = color;
				ctx.lineJoin = 'round';
				ctx.lineCap = 'round';
				ctx.stroke();
			};
			drawLine(9, '#0f172a');
			drawLine(5, '#fbbf24');
		}

		// 3) Marker
		resolvedStops.forEach((s, i) => {
			const p = map!.latLngToContainerPoint([s.lat, s.lon]);
			const isStart = i === 0;
			const isEnd = i === resolvedStops.length - 1;
			const big = s.pause || isStart || isEnd;
			const r = big ? 19 : 14;
			ctx.beginPath();
			ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
			ctx.fillStyle = isStart ? '#22c55e' : isEnd ? '#0f172a' : s.pause ? '#38bdf8' : '#fbbf24';
			ctx.fill();
			ctx.lineWidth = 3;
			ctx.strokeStyle = '#0f172a';
			ctx.stroke();
			ctx.fillStyle = isStart || isEnd ? '#ffffff' : '#0f172a';
			ctx.font = big ? 'bold 16px sans-serif' : 'bold 14px sans-serif';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText(String(i + 1), p.x, p.y + 1);
			ctx.textAlign = 'left';
			ctx.textBaseline = 'alphabetic';
			if (isStart || isEnd) {
				ctx.beginPath();
				ctx.arc(p.x + 18, p.y - 17, 13, 0, Math.PI * 2);
				ctx.fillStyle = isStart ? '#22c55e' : '#0f172a';
				ctx.fill();
				ctx.lineWidth = 2.5;
				ctx.strokeStyle = '#ffffff';
				ctx.stroke();
				ctx.fillStyle = '#ffffff';
				ctx.font = 'bold 14px sans-serif';
				ctx.textAlign = 'center';
				ctx.fillText(isStart ? 'S' : 'Z', p.x + 18, p.y - 12);
				ctx.textAlign = 'left';
			}
			if (s.pause) {
				ctx.beginPath();
				ctx.arc(p.x + 18, p.y + 18, 13, 0, Math.PI * 2);
				ctx.fillStyle = '#38bdf8';
				ctx.fill();
				ctx.lineWidth = 2.5;
				ctx.strokeStyle = '#0f172a';
				ctx.stroke();
				ctx.fillStyle = '#0f172a';
				ctx.fillRect(p.x + 18 - 4, p.y + 18 - 6, 2.5, 10);
				ctx.fillRect(p.x + 18 + 1, p.y + 18 - 5 + 0, 2.5, 10);
			}
		});

		// 4) Overlay: Titelbox oben links
		ctx.textAlign = 'left';
		ctx.textBaseline = 'alphabetic';
		if (title.trim()) {
			const subParts: string[] = [];
			if (tripDate.trim()) subParts.push(tripDate.trim());
			if (routeDistanceKm !== null) subParts.push(`Gesamtstrecke: ca. ${routeDistanceKm.toFixed(0)} km`);
			const sub = subParts.join(' · ');
			ctx.font = 'bold 24px sans-serif';
			const titleW = ctx.measureText(title.trim()).width;
			ctx.font = '13px sans-serif';
			const boxW = (sub ? Math.max(titleW, ctx.measureText(sub).width) : titleW) + 30;
			const boxH = sub ? 70 : 42;
			roundRectPath(ctx, 16, 16, boxW, boxH, 12);
			ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
			ctx.fill();
			ctx.fillStyle = '#ffffff';
			ctx.font = 'bold 24px sans-serif';
			ctx.fillText(title.trim(), 30, 16 + (sub ? 33 : 28));
			if (sub) {
				ctx.fillStyle = '#cbd5e1';
				ctx.font = '13px sans-serif';
				ctx.fillText(sub, 30, 16 + 56);
			}
		}

		// 5) Overlay: Logo oben rechts
		if (showLogo) {
			try {
				const logo = await loadLogoImage();
				if (logo) {
					const w = 110;
					const h = w * (logo.height / logo.width);
					ctx.save();
					ctx.shadowColor = 'rgba(0,0,0,0.5)';
					ctx.shadowBlur = 12;
					ctx.drawImage(logo, cssW - 16 - w, 16, w, h);
					ctx.restore();
				}
			} catch {
				/* Logo überspringen */
			}
		}

		// 6) Overlay: Stoppliste
		//    - Hohe Route: einspaltige Liste rechts über die volle Höhe
		//    - Breite Route: Liste unten rechts (ggf. zweispaltig), wie bisher
		if (resolvedStops.length) {
			const rowH = 23;
			const pad = 14;
			const headH = 30;
			let boxX: number;
			let boxY: number;
			let boxW: number;
			let boxH: number;
			let positions: Array<{ x: number; y: number }> = [];

			if (routeIsTall) {
				const listW = 230;
				const listPad = 12;
				const maxTextW = listW - listPad * 2 - 26;

				// Zeilen mit Umbruch messen: Jeder Stopp kann mehrzeilig sein
				ctx.font = '12.5px sans-serif';
				const rowsFor = (name: string, tagW: number): string[] => {
					const words = name.split(/\s+/);
					const lines: string[] = [];
					let cur = '';
					for (const word of words) {
						const test = cur ? cur + ' ' + word : word;
						if (ctx.measureText(test).width > maxTextW - tagW && cur) {
							lines.push(cur);
							cur = word;
						} else {
							cur = test;
						}
					}
					if (cur) lines.push(cur);
					return lines;
				};

				const entries = resolvedStops.map((s, i) => {
					const isStart = i === 0;
					const isEnd = i === resolvedStops.length - 1;
					let tagW = 0;
					const tags: Array<[string, string, string]> = [];
					if (isStart) tags.push(['Start', '#22c55e', '#ffffff']);
					if (isEnd) tags.push(['Ziel', '#334155', '#ffffff']);
					if (s.pause) tags.push(['Pause', '#38bdf8', '#0f172a']);
					ctx.font = 'bold 9.5px sans-serif';
					for (const [label] of tags) tagW += ctx.measureText(label).width + 10;
					if (tags.length) tagW += 4 * (tags.length - 1) + 4;
					const lines = rowsFor(s.name, tagW);
					return { s, i, tags, lines };
				});

				const lineH = 16;
				boxW = listW;
				boxH = headH + entries.reduce((sum, e) => sum + e.lines.length * lineH + 6, 0) + 6;
				boxX = cssW - 16 - boxW;
				boxY = cssH - 16 - boxH;
				let yy = boxY + headH + 4;
				positions = entries.map((e) => {
					const pos = { x: boxX + listPad, y: yy + 12 };
					yy += e.lines.length * lineH + 6;
					return pos;
				});

				roundRectPath(ctx, boxX, boxY, boxW, boxH, 12);
				ctx.fillStyle = 'rgba(0, 0, 0, 0.74)';
				ctx.fill();

				ctx.font = 'bold 13px sans-serif';
				ctx.fillStyle = '#ffffff';
				ctx.fillText('ETAPPEN / STOPPS', boxX + listPad + 2, boxY + 21);

				ctx.textAlign = 'left';
				for (const e of entries) {
					const pos = positions[e.i];
					// Marker-Kreis auf der ersten Zeile
					const isStart = e.i === 0;
					const isEnd = e.i === resolvedStops.length - 1;
					const cy = pos.y - 4;
					ctx.beginPath();
					ctx.arc(pos.x + 10, cy, 10, 0, Math.PI * 2);
					ctx.fillStyle = isStart ? '#22c55e' : isEnd ? '#0f172a' : e.s.pause ? '#38bdf8' : '#fbbf24';
					ctx.fill();
					ctx.lineWidth = 2;
					ctx.strokeStyle = e.s.pause || isEnd ? '#0f172a' : '#ffffff';
					ctx.stroke();
					ctx.fillStyle = isStart || isEnd ? '#ffffff' : '#0f172a';
					ctx.font = 'bold 11px sans-serif';
					ctx.textAlign = 'center';
					ctx.textBaseline = 'middle';
					ctx.fillText(String(e.i + 1), pos.x + 10, cy + 0.5);
					ctx.textAlign = 'left';
					ctx.textBaseline = 'alphabetic';

					// Namenszeilen (umgebrochen)
					ctx.font = '12.5px sans-serif';
					ctx.fillStyle = '#ffffff';
					e.lines.forEach((line, li) => {
						ctx.fillText(line, pos.x + 26, pos.y + li * lineH);
					});

					// Tags rechtsbündig auf der ersten Zeile
					let tx = boxX + boxW - listPad;
					ctx.font = 'bold 9.5px sans-serif';
					for (const [label, bg, fg] of [...e.tags].reverse()) {
						const tw = ctx.measureText(label).width + 10;
						tx -= tw;
						roundRectPath(ctx, tx, pos.y - 10.5, tw, 13, 4);
						ctx.fillStyle = bg;
						ctx.fill();
						ctx.fillStyle = fg;
						ctx.fillText(label, tx + 5, pos.y - 1);
						tx -= 4;
					}
				}
				ctx.textAlign = 'left';
			} else {
				const twoCols = resolvedStops.length > 16;
				const rowsPerCol = twoCols ? Math.ceil(resolvedStops.length / 2) : resolvedStops.length;
				boxH = headH + rowsPerCol * rowH + pad;
				ctx.font = '12.5px sans-serif';
				let nameW = 0;
				for (const s of resolvedStops) nameW = Math.max(nameW, ctx.measureText(s.name).width);
				const colW = Math.min(46 + nameW + 60, cssW / 2 - 40);
				boxW = twoCols ? colW * 2 + pad : colW + pad * 2;
				boxX = cssW - 16 - boxW;
				boxY = cssH - 16 - boxH;
				positions = resolvedStops.map((_, i) => {
					const col = twoCols ? (i < rowsPerCol ? 0 : 1) : 0;
					const row = twoCols ? i % rowsPerCol : i;
					return { x: boxX + pad + col * (colW + 10), y: boxY + headH + row * rowH + 12 };
				});
			}

			if (!routeIsTall) {
			roundRectPath(ctx, boxX, boxY, boxW, boxH, 12);
			ctx.fillStyle = 'rgba(0, 0, 0, 0.74)';
			ctx.fill();

			ctx.font = 'bold 13px sans-serif';
			ctx.fillStyle = '#ffffff';
			ctx.fillText('ETAPPEN / STOPPS', boxX + pad + 2, boxY + 21);

			const drawRow = (
				s: (typeof resolvedStops)[number],
				i: number,
				x: number,
				y: number,
				maxW: number
			) => {
				const isStart = i === 0;
				const isEnd = i === resolvedStops.length - 1;
				const cy = y - 4;
				ctx.beginPath();
				ctx.arc(x + 10, cy, 10, 0, Math.PI * 2);
				ctx.fillStyle = isStart
					? '#22c55e'
					: isEnd
						? '#0f172a'
						: s.pause
							? '#38bdf8'
							: '#fbbf24';
				ctx.fill();
				ctx.lineWidth = 2;
				ctx.strokeStyle = s.pause || isEnd ? '#0f172a' : '#ffffff';
				ctx.stroke();
				ctx.fillStyle = isStart || isEnd ? '#ffffff' : '#0f172a';
				ctx.font = 'bold 11px sans-serif';
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.fillText(String(i + 1), x + 10, cy + 0.5);
				ctx.textAlign = 'left';
				ctx.textBaseline = 'alphabetic';

				// Tags reserveren Platz
				let tagW = 0;
				const tags: Array<[string, string, string]> = [];
				if (isStart) tags.push(['Start', '#22c55e', '#ffffff']);
				if (isEnd) tags.push(['Ziel', '#334155', '#ffffff']);
				if (s.pause) tags.push(['Pause', '#38bdf8', '#0f172a']);
				ctx.font = 'bold 9.5px sans-serif';
				for (const [label] of tags) tagW += ctx.measureText(label).width + 10;
				if (tags.length) tagW += 4 * (tags.length - 1) + 4;

				// Name ggf. kürzen
				ctx.font = '12.5px sans-serif';
				const maxName = maxW - 34 - tagW;
				let name = s.name;
				while (name.length > 3 && ctx.measureText(name + '…').width > maxName) {
					name = name.slice(0, -1);
				}
				if (name !== s.name) name += '…';
				ctx.font = '12.5px sans-serif';
				ctx.fillStyle = '#ffffff';
				ctx.fillText(name, x + 26, y);

				// Tags zeichnen
				let tx = x + 26 + ctx.measureText(name).width + 6;
				for (const [label, bg, fg] of tags) {
					ctx.font = 'bold 9.5px sans-serif';
					const tw = ctx.measureText(label).width + 10;
					roundRectPath(ctx, tx, y - 10.5, tw, 13, 4);
					ctx.fillStyle = bg;
					ctx.fill();
					ctx.fillStyle = fg;
					ctx.fillText(label, tx + 5, y - 1);
						tx += tw + 4;
				}
			};

			const rowMaxW = resolvedStops.length > 16 ? (boxW - pad) / 2 - 10 : boxW - pad * 2;
			resolvedStops.forEach((s, i) => {
				drawRow(s, i, positions[i].x, positions[i].y, rowMaxW);
			});
			}
		}

		// 6) Quellenangabe
		ctx.font = '11px sans-serif';
		ctx.fillStyle = 'rgba(255,255,255,0.85)';
		ctx.fillText('Kartendaten © Esri, Maxar, Earthstar Geographics', 12, cssH - 10);

		// 7) Ansicht wiederherstellen
		mapEl.setAttribute('style', prevStyle);
		map.invalidateSize();
		map.setView(prevCenter, prevZoom);

		return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
	}

async function savePng() {
		if (busy) return;
		busy = true;
		errorMessage = '';
		try {
			progressText = 'Karte wird erzeugt …';
			const { dataUrl } = await captureMap();
			const a = document.createElement('a');
			a.href = dataUrl;
			a.download = 'gemeinschaftsfahrt-route.png';
			a.click();
		} catch (e) {
			errorMessage = e instanceof Error ? e.message : 'Export fehlgeschlagen';
		} finally {
			busy = false;
			progressText = '';
		}
	}

	/** Lädt das Logo als DataURL (für PDF-Export). */
	function loadLogoDataUrl(): Promise<{ dataUrl: string; ratio: number } | null> {
		return new Promise((resolve) => {
			const img = new Image();
			img.onload = () => {
				const c = document.createElement('canvas');
				c.width = img.naturalWidth;
				c.height = img.height;
				c.getContext('2d')!.drawImage(img, 0, 0);
				resolve({ dataUrl: c.toDataURL('image/png'), ratio: img.height / img.width });
			};
			img.onerror = () => resolve(null);
			img.src = '/logo.png';
		});
	}

	/** Erzeugt ein A4-Hochformat-PDF mit Karte, Kopfzeile und Stoppliste. */
	async function savePdf() {
		if (busy) return;
		if (resolvedStops.length < 2) {
			errorMessage = 'Bitte zuerst eine Route berechnen.';
			return;
		}
		busy = true;
		errorMessage = '';
		try {
			progressText = 'PDF wird erzeugt …';
			const { dataUrl } = await captureMap();
			const { default: JsPDF } = await import('jspdf');
			const doc = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
			// Die Karte füllt die gesamte A4-Seite; alle Inhalte sind Overlays im Bild
			doc.addImage(dataUrl, 'PNG', 0, 0, 210, 297);
			doc.setProperties({ title: title || 'Gemeinschaftsfahrt' });
			doc.save(`${(title.trim() || 'gemeinschaftsfahrt').replace(/[^\w äöüßÄÖÜ-]/g, '')}.pdf`);
		} catch (e) {
			errorMessage = e instanceof Error ? e.message : 'PDF-Export fehlgeschlagen';
		} finally {
			busy = false;
			progressText = '';
		}
	}

	async function printMap() {
		if (busy) return;
		if (resolvedStops.length < 2) {
			errorMessage = 'Bitte zuerst eine Route berechnen.';
			return;
		}
		busy = true;
		errorMessage = '';
		try {
			progressText = 'Karte wird vorbereitet …';
			printImage = (await captureMap()).dataUrl;
			printing = true;
			await tick();
			window.print();
		} catch (e) {
			errorMessage = e instanceof Error ? e.message : 'Druck fehlgeschlagen';
			printing = false;
		} finally {
			busy = false;
			progressText = '';
		}
	}

	function onAfterPrint() {
		printing = false;
		printImage = '';
	}

</script>

<svelte:window onafterprint={onAfterPrint} />

<svelte:head>
	<title>Maximap – Routenplaner für Gemeinschaftsfahrten</title>
</svelte:head>

<div class="app-ui fixed inset-0 overflow-hidden">
	<!-- Karte: füllt den ganzen Bildschirm -->
	<div bind:this={mapEl} class="absolute inset-0 z-0"></div>

	<!-- Logo oben rechts -->
	{#if showLogo}
		<div class="logo-box absolute top-4 right-4 z-[900]">
			<img src="/logo.png" alt="Vereinslogo" />
		</div>
	{/if}

	<!-- Eingabebereich oben links -->
	<div class="absolute top-4 left-4 z-[1000] w-[380px] max-w-[calc(100vw-2rem)]">
		{#if panelOpen}
			<Card class="bg-background/95 shadow-xl">
				<CardHeader class="pb-3">
					<CardTitle class="flex items-center justify-between">
						<span>Gemeinschaftsfahrt planen</span>
						<button
							class="text-muted-foreground hover:text-foreground text-xs"
							onclick={() => (panelOpen = false)}
							aria-label="Eingabebereich einklappen">▲ einklappen</button
						>
					</CardTitle>
				</CardHeader>
				<CardContent class="space-y-3">
					<div>
						<label class="mb-1 block text-sm font-medium" for="titel">Titel</label>
						<Input id="titel" bind:value={title} placeholder="z. B. Sommerausfahrt 2026" />
					</div>

					<div>
						<label class="mb-1 block text-sm font-medium" for="datum"
							>Datum (optional, leer = nicht anzeigen)</label
						>
						<Input id="datum" bind:value={tripDate} placeholder="z. B. 15. August 2026" />
					</div>

					<div>
						<p class="mb-1 block text-sm font-medium">Orte (in Reihenfolge der Fahrt)</p>
						<div class="max-h-72 space-y-2 overflow-y-auto pr-1">
							{#each stops as stop, i (stop.id)}
								<div class="flex items-center gap-1.5">
									<span class="w-6 shrink-0 text-right text-sm font-semibold {stop.pause ? 'text-sky-600 dark:text-sky-300' : 'text-muted-foreground'}"
										>{i + 1}.</span
									>
									<Input
											id={`ort-${stop.id}`}
											bind:value={stops[i].name}
											placeholder="Ort {i + 1}"
											onkeydown={handleStopKeydown(i)}
										/>
									<button
										type="button"
										class="h-8 w-8 shrink-0 rounded-md border text-sm transition-colors {stop.pause
											? 'border-sky-500 bg-sky-500/20 text-sky-600 dark:text-sky-300'
											: 'border-input text-muted-foreground hover:bg-accent'}"
										onclick={() => (stops[i].pause = !stops[i].pause)}
										aria-pressed={stop.pause}
										title={stop.pause ? 'Pause: wieder entfernen' : 'Als Pause markieren'}
										aria-label="Als Pause markieren">⏸</button
									>
									<div class="flex shrink-0 flex-col gap-0">
										<button
											type="button"
											class="text-muted-foreground hover:bg-accent hover:text-foreground h-4 w-6 rounded-t border border-input text-[10px] leading-none"
											onclick={() => moveStop(i, -1)}
											disabled={i === 0}
											title="Nach oben verschieben"
											aria-label="Ort nach oben verschieben">▲</button
										>
										<button
											type="button"
											class="text-muted-foreground hover:bg-accent hover:text-foreground h-4 w-6 rounded-b border border-input text-[10px] leading-none"
											onclick={() => moveStop(i, 1)}
											disabled={i === stops.length - 1}
											title="Nach unten verschieben"
											aria-label="Ort nach unten verschieben">▼</button
										>
									</div>
									<button
										type="button"
										class="text-muted-foreground hover:bg-accent hover:text-foreground h-8 w-6 shrink-0 rounded-md border border-input text-xs"
										onclick={() => addStop(i)}
										title="Neuen Ort danach einfügen"
										aria-label="Neuen Ort danach einfügen">+</button
									>
									<Button
										variant="ghost"
										size="icon"
										class="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
										onclick={() => removeStop(i)}
										aria-label="Ort entfernen">✕</Button
									>
								</div>
							{/each}
						</div>
						<Button variant="outline" size="sm" class="mt-2 w-full" onclick={() => addStop()}
							>+ Ort hinzufügen</Button
						>
					</div>

					<div>
						{#if pasteOpen}
							<label class="mb-1 block text-sm font-medium" for="paste-box">Route importieren – eine Zeile = ein Ort (Nummerierung und "(Pause)" werden erkannt)</label>
							<textarea
							id="paste-box"
							bind:value={pasteText}
							rows="5"
							class="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
							placeholder={"Schützen am Gebirge\nIllmitz (Pause)\nEisenstadt"}
							></textarea>
							<div class="mt-2 flex flex-wrap gap-2">
								<Button size="sm" onclick={() => importRouteText(pasteText)}>Liste übernehmen</Button>
								<Button size="sm" variant="outline" onclick={() => fileInput?.click()}>📁 Datei öffnen</Button>
								<input
								bind:this={fileInput}
								type="file"
								accept=".json,.txt,text/plain,application/json"
								class="hidden"
								onchange={openRouteFile}
								/>
								<Button
								size="sm"
								variant="ghost"
								onclick={() => {
									pasteOpen = false;
									pasteText = '';
								}}>Abbrechen</Button
								>
							</div>
						{:else}
							<Button variant="outline" size="sm" class="w-full" onclick={() => (pasteOpen = true)}
							>📋 Liste importieren</Button
							>
						{/if}
					</div>

					<div class="flex flex-wrap gap-2">
						<Button variant="outline" size="sm" onclick={saveRouteFile} title="Route als Datei speichern (JSON)"
							>💾 Route speichern</Button
						>
						<Button variant="outline" size="sm" onclick={copyRouteToClipboard}
							title="Route als JSON in die Zwischenablage kopieren"
							>{copied ? '✓ kopiert' : '📄 In Zwischenablage'}</Button
						>
					</div>

					<label class="flex items-center gap-2 text-sm">
						<input type="checkbox" bind:checked={showLogo} class="accent-primary h-4 w-4" />
						Logo auf der Karte anzeigen
					</label>

					{#if busy}
						<p class="text-sm text-muted-foreground">{progressText}</p>
					{/if}
					{#if errorMessage}
						<p class="text-sm text-destructive">{errorMessage}</p>
					{/if}
					{#if routeDistanceKm !== null}
						<p class="text-sm text-muted-foreground">
							Gesamtstrecke: ca. <strong>{routeDistanceKm.toFixed(0)} km</strong>
							{#if failedStops.length}
								· <span class="text-destructive">nicht gefunden: {failedStops.join(', ')}</span>
							{/if}
						</p>
					{/if}
				</CardContent>
				<CardFooter class="flex flex-wrap gap-2">
					<Button onclick={computeRoute} disabled={busy}>Route berechnen</Button>
					<Button variant="outline" onclick={() => (saveOpen = true)} disabled={busy}
						>Speichern …</Button
					>
					<Button variant="outline" onclick={printMap} disabled={busy}>Drucken (A4)</Button>
				</CardFooter>
			</Card>
		{:else}
			<Button onclick={() => (panelOpen = true)} class="shadow-lg"
				>▲ Gemeinschaftsfahrt planen</Button
			>
		{/if}
	</div>

	<!-- Stopliste unten rechts -->
	{#if resolvedStops.length}
		<div class="stops-box absolute right-4 bottom-4 z-[900] w-[300px] max-h-[50vh] overflow-y-auto">
			<div class="rounded-lg border border-white/20 bg-black/70 p-3 text-white shadow-xl backdrop-blur">
				<h2 class="mb-2 text-sm font-bold tracking-wide uppercase">Etappen / Stopps</h2>
				<ol class="space-y-1 text-sm">
					{#each resolvedStops as s, i (i)}
						<li class="flex items-center gap-2">
							<span
								class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full {i === 0
									? 'bg-green-500'
									: i === resolvedStops.length - 1
										? 'bg-slate-900'
										: s.pause
											? 'bg-sky-400'
											: 'bg-amber-400'} text-xs font-bold {i === resolvedStops.length - 1
										? 'text-white'
										: 'text-black'}"
								>{i + 1}</span
							>
							<span class="truncate">
								{s.name}
								{#if i === 0}<span class="text-green-300" title="Start">⚑ Start</span>{/if}
								{#if i === resolvedStops.length - 1}<span class="text-slate-300" title="Ziel">⚑ Ziel</span>{/if}
								{#if s.pause}<span class="text-sky-300" title="Pause">⏸ Pause</span>{/if}
							</span>
						</li>
					{/each}
				</ol>
			</div>
		</div>
	{/if}
</div>

<!-- Speichern-Dialog -->
<Dialog.Root bind:open={saveOpen}>
	<Dialog.Content class="sm:max-w-[420px]">
		<Dialog.Header>
			<Dialog.Title>Karte speichern</Dialog.Title>
			<Dialog.Description>Wie möchtest du die Karte exportieren?</Dialog.Description>
		</Dialog.Header>
		<div class="grid gap-3">
			<button
				type="button"
				class="border-input hover:bg-accent hover:text-accent-foreground flex items-center gap-3 rounded-lg border p-4 text-left transition-colors"
				onclick={() => {
					saveOpen = false;
					savePng();
				}}
			>
				<span class="text-2xl">🖼️</span>
				<span>
					<span class="block text-sm font-semibold">PNG-Bild</span>
					<span class="text-muted-foreground block text-xs"
						>Karte als Bilddatei in hoher Auflösung</span
					>
				</span>
			</button>
			<button
				type="button"
				class="border-input hover:bg-accent hover:text-accent-foreground flex items-center gap-3 rounded-lg border p-4 text-left transition-colors"
				onclick={() => {
					saveOpen = false;
					savePdf();
				}}
			>
				<span class="text-2xl">📄</span>
				<span>
					<span class="block text-sm font-semibold">PDF (A4 Hochformat)</span>
					<span class="text-muted-foreground block text-xs"
						>Fertig formatiertes Dokument mit Logo, Titel und Stoppliste</span
					>
				</span>
			</button>
		</div>
		{#if busy}<p class="text-muted-foreground mt-3 text-sm">{progressText}</p>{/if}
		{#if errorMessage}<p class="text-destructive mt-3 text-sm">{errorMessage}</p>{/if}
		<Dialog.Close
			class="text-muted-foreground hover:text-foreground absolute top-4 right-4 text-sm">✕</Dialog.Close
		>
	</Dialog.Content>
</Dialog.Root>

<!-- Druck-Layout: A4 Hochformat (Karte füllt die Seite, Overlays sind im Bild) -->
{#if printing}
	<div class="print-sheet">
		<img src={printImage} alt="Routenkarte" />
	</div>
{/if}

<style>
	/* Nummerierte Marker auf der Karte (reines Hex-CSS, damit html2canvas funktioniert) */
	:global(.stop-marker-wrapper) {
		background: transparent;
		border: none;
	}
	:global(.stop-marker) {
		width: 30px;
		height: 30px;
		border-radius: 50%;
		background: #fbbf24;
		border: 3px solid #0f172a;
		color: #0f172a;
		font-weight: 700;
		font-size: 14px;
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
		position: relative;
	}
	:global(.stop-marker-pause) {
		background: #38bdf8;
	}
	:global(.stop-marker-start) {
		background: #22c55e;
		color: #ffffff;
	}
	:global(.stop-marker-end) {
		background: #0f172a;
		color: #ffffff;
	}
	:global(.marker-corner) {
		position: absolute;
		top: -11px;
		right: -11px;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		border: 2.5px solid #ffffff;
		color: #ffffff;
		font-size: 12px;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
	}
	:global(.marker-corner.start) {
		background: #22c55e;
	}
	:global(.marker-corner.end) {
		background: #0f172a;
	}
	:global(.pause-badge) {
		position: absolute;
		right: -8px;
		bottom: -8px;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: #38bdf8;
		border: 2px solid #0f172a;
		color: #0f172a;
		font-size: 9px;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.logo-box img {
		width: 110px;
		height: auto;
		filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.5));
	}

	/* ---------- Drucklayout A4 Hochformat ---------- */
	.print-sheet {
		display: none;
	}

	@media print {
		@page {
			size: A4 portrait;
			margin: 0;
		}

		.app-ui {
			display: none !important;
		}

		.print-sheet {
			display: block;
			width: 210mm;
			height: 297mm;
		}

		.print-sheet img {
			width: 210mm;
			height: 297mm;
			object-fit: cover;
		}
	}
</style>
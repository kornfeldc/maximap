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

	// ---------- Export-Editor (A4-Vorschau mit frei positionierbaren Elementen) ----------
	const A4_W = 794;
	const A4_H = 1123;
	interface ExportLayout {
		titleX: number;
		titleY: number;
		logoX: number;
		logoY: number;
		logoW: number;
		legendX: number;
		legendY: number;
		legendW: number;
	}
	let exportOpen = $state(false);
	let exportBusy = $state(false);
	let exportLayout = $state<ExportLayout>({
		titleX: 16,
		titleY: 16,
		logoX: A4_W - 16 - 110,
		logoY: 16,
		logoW: 110,
		legendX: A4_W - 16 - 240,
		legendY: A4_H - 16 - 320,
		legendW: 240
	});
	let exportLayoutTouched = false;
	let frameHost: HTMLDivElement | undefined = $state();
	let frameInner: HTMLDivElement | undefined = $state();
	let frameScale = $state(1);
	let mapHome: HTMLElement | null = null;
	let prevExportView: { center: L.LatLng; zoom: number } | null = null;
	let legendCols = $derived(legendColumns(exportLayout.legendW).cols);
	let dragTarget = $state<'title' | 'logo' | 'legend' | null>(null);
	let dragKind: 'move' | 'resize' | null = null;
	let dragStart = { x: 0, y: 0, base: { x: 0, y: 0, w: 0 } };

	onMount(() => {
		import('leaflet').then(({ default: L }) => {
			leafletLib = L;
			map = L.map(mapEl!, {
			zoomControl: false,
			zoomSnap: 0.25,
			zoomDelta: 0.5,
			wheelPxPerZoomLevel: 120,
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

	/** Start und Ziel am selben Ort? (gleiche Geokodierung) */
	function startEqualsGoal(): boolean {
		if (resolvedStops.length < 2) return false;
		const a = resolvedStops[0];
		const b = resolvedStops[resolvedStops.length - 1];
		return Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lon - b.lon) < 1e-6;
	}

	function markerIcon(index: number, isPause: boolean, isStart: boolean, isEnd: boolean) {
		const L = leafletLib!;
		// Start=Ziel am selben Ort: eine kombinierte Blase mit beiden Fahnen, ohne Nummer
		if (isStart && isEnd && startEqualsGoal()) {
			const size = 52;
			const html =
				'<div class="stop-marker combined" style="width:' + size + 'px;height:' + size + 'px">' +
				'<span class="half start"></span><span class="half end"></span>' +
				'<span class="marker-flag start" title="Start">⚑</span>' +
				'<span class="marker-flag end" title="Ziel">⚑</span>' +
				'</div>';
			return L.divIcon({
				className: 'stop-marker-wrapper',
				html,
				iconSize: [size, size],
				iconAnchor: [size / 2, size / 2]
			});
		}
		const big = isPause || isStart || isEnd;
		const size = big ? 40 : 30;
		const cls = isStart ? ' stop-marker-start' : isEnd ? ' stop-marker-end' : isPause ? ' stop-marker-pause' : '';
		const badges =
			(isStart ? '<span class="marker-flag start" title="Start">⚑</span>' : '') +
			(isEnd ? '<span class="marker-flag end" title="Ziel">⚑</span>' : '') +
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
			const sameStartGoal =
				found.length >= 2 &&
				Math.abs(found[0].lat - found[found.length - 1].lat) < 1e-6 &&
				Math.abs(found[0].lon - found[found.length - 1].lon) < 1e-6;
			found.forEach((s, i) => {
				const isEnd = i === found.length - 1;
				if (sameStartGoal && isEnd) return; // kombinierte Blase am Start
				const icon = markerIcon(i, s.pause, i === 0, isEnd);
				const m = L.marker([s.lat, s.lon], { icon }).addTo(group!);
				const startEndLabel =
					sameStartGoal && i === 0 ? ' – Start und Ziel' : i === 0 ? ' – Start' : isEnd ? ' – Ziel' : '';
				m.bindTooltip(`${i + 1}. ${s.name}${s.pause ? ' (Pause)' : ''}${startEndLabel}`, { direction: 'top', offset: [0, -12] });
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

	// ---------- Export-Editor: Logik ----------

	let legendMeasureCtx: CanvasRenderingContext2D | null = null;
	function legendCtx(): CanvasRenderingContext2D {
		legendMeasureCtx ??= document.createElement('canvas').getContext('2d')!;
		return legendMeasureCtx;
	}

	function legendTagsFor(i: number): Array<[string, string, string]> {
		const tags: Array<[string, string, string]> = [];
		if (i === 0) tags.push(['Start', '#22c55e', '#ffffff']);
		if (i === resolvedStops.length - 1) tags.push(['Ziel', '#334155', '#ffffff']);
		if (resolvedStops[i]?.pause) tags.push(['Pause', '#38bdf8', '#0f172a']);
		return tags;
	}

	function legendTagWidth(tags: Array<[string, string, string]>): number {
		const c = legendCtx();
		c.font = 'bold 9.5px sans-serif';
		let w = 0;
		for (const [label] of tags) w += c.measureText(label).width + 10;
		if (tags.length) w += 4 * (tags.length - 1) + 4;
		return w;
	}

	function legendWrapLines(name: string, tagW: number, maxTextW: number): string[] {
		const c = legendCtx();
		c.font = '12.5px sans-serif';
		const words = name.split(/\s+/);
		const lines: string[] = [];
		let cur = '';
		for (const word of words) {
			const test = cur ? cur + ' ' + word : word;
			if (c.measureText(test).width > maxTextW - tagW && cur) {
				lines.push(cur);
				cur = word;
			} else {
				cur = test;
			}
		}
		if (cur) lines.push(cur);
		return lines;
	}

	function legendRowHeight(lines: number): number {
		return Math.max(22, lines * 16);
	}

	/**
	 * Verteilt die Stopps auf Spalten: ab ca. 230 px Breite pro Spalte wird
	 * der Listeninhalt mehrspaltig (ausbalanciert nach Zeilensumme).
	 */
	function legendColumns(width: number) {
		if (!browser || !resolvedStops.length) return { cols: [] as Array<Array<{ s: (typeof resolvedStops)[number]; i: number; tags: Array<[string, string, string]>; lines: string[] }>>, colW: width };
		const nCols = Math.max(1, Math.min(3, Math.floor(width / 230)));
		const colW = width / nCols;
		const maxTextW = colW - 24 - 26;
		const entries = resolvedStops.map((s, i) => {
			const tags = legendTagsFor(i);
			const tagW = legendTagWidth(tags);
			return { s, i, tags, lines: legendWrapLines(s.name, tagW, maxTextW) };
		});
		const rowH = (e: { lines: string[] }) => legendRowHeight(e.lines.length) + 6;
		const total = entries.reduce((sum, e) => sum + rowH(e), 0);
		const target = total / nCols;
		const cols: Array<typeof entries> = [[]];
		let h = 0;
		for (const e of entries) {
			if (cols.length < nCols && h + rowH(e) / 2 > target) {
				cols.push([]);
				h = 0;
			}
			cols[cols.length - 1].push(e);
			h += rowH(e);
		}
		return { cols, colW };
	}

	function defaultLegendHeight(w: number): number {
		if (!resolvedStops.length) return 100;
		const { cols } = legendColumns(w);
		const heights = cols.map((col) =>
			col.reduce((sum, e) => sum + legendRowHeight(e.lines.length) + 6, 0)
		);
		return 30 + Math.max(...heights, 22) + 6;
	}

	function resetExportLayout() {
		const legendW = 240;
		exportLayout = {
			titleX: 16,
			titleY: 16,
			logoX: A4_W - 16 - 110,
			logoY: 16,
			logoW: 110,
			legendX: A4_W - 16 - legendW,
			legendY: A4_H - 16 - defaultLegendHeight(legendW),
			legendW
		};
	}

	$effect(() => {
		if (exportOpen) void afterExportOpen();
	});

	function openExport() {
		if (resolvedStops.length < 2) {
			errorMessage = 'Bitte zuerst eine Route berechnen.';
			return;
		}
		if (!exportLayoutTouched) resetExportLayout();
		prevExportView = map ? { center: map.getCenter(), zoom: map.getZoom() } : null;
		mapHome = mapEl?.parentElement ?? null;
		exportOpen = true;
	}

	async function afterExportOpen() {
		await tick();
		if (!frameHost || !mapEl || !map) return;
		mapHome = mapEl.parentElement ?? mapHome;
		frameHost.appendChild(mapEl);
		map.invalidateSize();
		fitRouteInFrame();
		updateFrameScale();
	}

	function fitRouteInFrame() {
		if (!map || !leafletLib || currentRouteCoords.length < 2) return;
		map.fitBounds(leafletLib.latLngBounds(currentRouteCoords), {
			paddingTopLeft: [24, 110],
			paddingBottomRight: [280, 24]
		});
	}

	function updateFrameScale() {
		if (!frameInner) return;
		const stage = frameInner.parentElement?.parentElement;
		const availW = (stage?.clientWidth ?? window.innerWidth) - 32;
		const availH = (stage?.clientHeight ?? window.innerHeight) - 32;
		frameScale = Math.max(0.2, Math.min(1, availW / A4_W, availH / A4_H));
	}

	function closeExport() {
		exportOpen = false;
		if (mapHome && mapEl) {
			mapHome.appendChild(mapEl);
			map?.invalidateSize();
			if (prevExportView) map?.setView(prevExportView.center, prevExportView.zoom);
		}
	}

	function startOverlayDrag(
		e: PointerEvent,
		kind: 'title' | 'logo' | 'legend',
		mode: 'move' | 'resize'
	) {
		e.preventDefault();
		e.stopPropagation();
		const rect = frameInner?.getBoundingClientRect();
		if (!rect) return;
		const scale = rect.width / A4_W;
		const base =
			kind === 'title'
				? { x: exportLayout.titleX, y: exportLayout.titleY, w: 0 }
				: kind === 'logo'
					? { x: exportLayout.logoX, y: exportLayout.logoY, w: exportLayout.logoW }
					: { x: exportLayout.legendX, y: exportLayout.legendY, w: exportLayout.legendW };
		dragTarget = kind;
		dragKind = mode;
		dragStart = { x: e.clientX / scale, y: e.clientY / scale, base };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function onOverlayDrag(e: PointerEvent) {
		if (!dragTarget || !dragKind) return;
		const rect = frameInner?.getBoundingClientRect();
		if (!rect) return;
		const scale = rect.width / A4_W;
		const dx = e.clientX / scale - dragStart.x;
		const dy = e.clientY / scale - dragStart.y;
		const base = dragStart.base;
		if (dragKind === 'move') {
			const x = Math.max(0, Math.min(A4_W - 40, base.x + dx));
			const y = Math.max(0, Math.min(A4_H - 30, base.y + dy));
			if (dragTarget === 'title') {
				exportLayout.titleX = Math.round(x);
				exportLayout.titleY = Math.round(y);
			} else if (dragTarget === 'logo') {
				exportLayout.logoX = Math.round(x);
				exportLayout.logoY = Math.round(y);
			} else {
				exportLayout.legendX = Math.round(x);
				exportLayout.legendY = Math.round(y);
			}
		} else if (dragKind === 'resize') {
			if (dragTarget === 'legend') {
				exportLayout.legendW = Math.round(Math.max(160, Math.min(700, base.w + dx)));
			} else if (dragTarget === 'logo') {
				exportLayout.logoW = Math.round(Math.max(50, Math.min(320, base.w + dx)));
			}
		}
		exportLayoutTouched = true;
	}

	function endOverlayDrag() {
		dragTarget = null;
		dragKind = null;
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
		let frameTransform = '';
		if (!exportOpen) {
			mapEl.style.position = 'fixed';
			mapEl.style.left = '0';
			mapEl.style.top = '0';
			mapEl.style.width = `${cssW}px`;
			mapEl.style.height = `${cssH}px`;
			mapEl.style.zIndex = '-1';
			mapEl.style.inset = 'auto';
		} else {
			// Dialog-Skalierung für die Aufnahme neutralisieren
			frameTransform = frameInner?.style.transform ?? '';
			if (frameInner) frameInner.style.transform = 'none';
		}
		map.invalidateSize();

		// Im Export-Editor ist die Ansicht bewusst gewählt -> nicht neu einpassen
		if (!exportOpen && currentRouteCoords.length > 1) {
			const stopsBox = computeStopsBoxLayout();
			const titleTop = 16 + 70 + 16; // Titelbox unten
			const padTopLeft: [number, number] = [60, Math.max(titleTop, 90)];
			const padBotRight: [number, number] = [
				Math.round(stopsBox.w * 0.6),
				Math.round(computeStopsBoxLayoutTall().h * 0.75)
			];
			map.fitBounds(L.latLngBounds(currentRouteCoords), {
				paddingTopLeft: padTopLeft,
				paddingBottomRight: padBotRight
			});
		}

		// Auf geladene Kacheln warten (max. 5 s; im Editor kürzer, da schon sichtbar)
		const tileTimeout = exportOpen ? 800 : 5000;
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
			else setTimeout(finish, tileTimeout);
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

		// 3) Marker (Start=Ziel am selben Ort -> eine kombinierte Blase statt zwei)
		const combinedStartGoal = startEqualsGoal();
		resolvedStops.forEach((s, i) => {
			const isStart = i === 0;
			const isEnd = i === resolvedStops.length - 1;
			if (combinedStartGoal && (isStart || isEnd)) return; // wird gemeinsam gezeichnet
			const p = map!.latLngToContainerPoint([s.lat, s.lon]);
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
				// Fahnen-Badges wie in der Vorschau; bei Start=Ziel nur ein kombiniertes Badge
				const flagAt = (fx: number, startFlag: boolean, combinedFlag: boolean) => {
					const w = combinedFlag ? 26 : 22;
					const h = combinedFlag ? 26 : 22;
					const x = fx - w / 2;
					const y = p.y - 17 - h / 2 + 4;
					// Fadenkreuz-Form: runde Ecken oben, Spitze unten links (wie .marker-flag)
					ctx.beginPath();
					ctx.moveTo(x + w, y);
					ctx.lineTo(x + w, y + h * 0.75);
					ctx.lineTo(x + w * 0.35, y + h * 0.75);
					ctx.lineTo(x, y + h);
					ctx.lineTo(x, y);
					ctx.closePath();
					if (combinedFlag) {
						ctx.save();
						ctx.clip();
						ctx.fillStyle = '#22c55e';
						ctx.fillRect(x, y, w / 2, h);
						ctx.fillStyle = '#0f172a';
						ctx.fillRect(x + w / 2, y, w / 2, h);
						ctx.restore();
					} else {
						ctx.fillStyle = startFlag ? '#22c55e' : '#0f172a';
						ctx.fill();
					}
					ctx.lineWidth = 2;
					ctx.strokeStyle = '#ffffff';
					ctx.stroke();
				};
				if (isStart && isEnd && startEqualsGoal()) {
					flagAt(p.x + 20, true, true);
				} else {
					if (isStart) flagAt(p.x - 16, true, false);
					if (isEnd) flagAt(p.x + 20, false, false);
				}
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

		// 3b) Kombinierte Start/Ziel-Blase am selben Ort (beide Fahnen, keine Nummer)
		if (combinedStartGoal) {
			const s0 = resolvedStops[0];
			const p = map!.latLngToContainerPoint([s0.lat, s0.lon]);
			const r = 24;
			ctx.beginPath();
			ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
			ctx.save();
			ctx.clip();
			ctx.fillStyle = '#22c55e';
			ctx.fillRect(p.x - r, p.y - r, r, r * 2);
			ctx.fillStyle = '#0f172a';
			ctx.fillRect(p.x, p.y - r, r, r * 2);
			ctx.restore();
			ctx.lineWidth = 3.5;
			ctx.strokeStyle = '#ffffff';
			ctx.stroke();
			ctx.lineWidth = 1.5;
			ctx.strokeStyle = '#0f172a';
			ctx.stroke();
			// Beide Fahnen oben mittig nebeneinander
			const flagAt = (fx: number, startFlag: boolean) => {
				const w = 22;
				const h = 22;
				const x = fx - w / 2;
				const y = p.y - r - h + 6;
				ctx.beginPath();
				ctx.moveTo(x + w, y);
				ctx.lineTo(x + w, y + h * 0.75);
				ctx.lineTo(x + w * 0.35, y + h * 0.75);
				ctx.lineTo(x, y + h);
				ctx.lineTo(x, y);
				ctx.closePath();
				ctx.fillStyle = startFlag ? '#22c55e' : '#0f172a';
				ctx.fill();
				ctx.lineWidth = 2;
				ctx.strokeStyle = '#ffffff';
				ctx.stroke();
			};
			flagAt(p.x - 13, true);
			flagAt(p.x + 13, false);
		}

		// 4) Overlay: Titelbox (Position aus dem Export-Editor)
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
			const tx = Math.min(exportLayout.titleX, cssW - boxW - 4);
			const ty = Math.min(exportLayout.titleY, cssH - boxH - 4);
			roundRectPath(ctx, tx, ty, boxW, boxH, 12);
			ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
			ctx.fill();
			ctx.fillStyle = '#ffffff';
			ctx.font = 'bold 24px sans-serif';
			ctx.fillText(title.trim(), tx + 14, ty + (sub ? 33 : 28));
			if (sub) {
				ctx.fillStyle = '#cbd5e1';
				ctx.font = '13px sans-serif';
				ctx.fillText(sub, tx + 14, ty + 56);
			}
		}

		// 5) Overlay: Logo (Position/Groesse aus dem Export-Editor)
		if (showLogo) {
			try {
				const logo = await loadLogoImage();
				if (logo) {
					const w = exportLayout.logoW;
					const h = w * (logo.height / logo.width);
					ctx.save();
					ctx.shadowColor = 'rgba(0,0,0,0.5)';
					ctx.shadowBlur = 12;
					ctx.drawImage(logo, exportLayout.logoX, exportLayout.logoY, w, h);
					ctx.restore();
				}
			} catch {
				/* Logo ueberspringen */
			}
		}

		// 6) Overlay: Stoppliste (Position/Breite aus dem Export-Editor; breit = mehrspaltig)
		if (resolvedStops.length) {
			const headH = 30;
			const lineH = 16;
			const listPad = 12;
			const boxW = exportLayout.legendW;
			const { cols } = legendColumns(boxW);
			const colW = boxW / Math.max(1, cols.length);

			const colHeights = cols.map((col) =>
				col.reduce((sum, e) => sum + legendRowHeight(e.lines.length) + 6, 0)
			);
			const boxH = headH + Math.max(...colHeights, 22) + 6;
			const boxX = Math.max(4, Math.min(exportLayout.legendX, cssW - boxW - 4));
			const boxY = Math.max(4, Math.min(exportLayout.legendY, cssH - boxH - 4));

			roundRectPath(ctx, boxX, boxY, boxW, boxH, 12);
			ctx.fillStyle = 'rgba(0, 0, 0, 0.74)';
			ctx.fill();

			ctx.font = 'bold 13px sans-serif';
			ctx.fillStyle = '#ffffff';
			ctx.fillText('ETAPPEN / STOPPS', boxX + listPad + 2, boxY + 21);

			ctx.textAlign = 'left';
			for (let ci = 0; ci < cols.length; ci++) {
				const colX = boxX + ci * colW;
				let yy = boxY + headH;
				for (const e of cols[ci]) {
					const rowH = legendRowHeight(e.lines.length);
					const cy = yy + 12;
					const isStart = e.i === 0;
					const isEnd = e.i === resolvedStops.length - 1;
					ctx.beginPath();
					ctx.arc(colX + listPad + 10, cy, 10, 0, Math.PI * 2);
					ctx.fillStyle = isStart ? '#22c55e' : isEnd ? '#0f172a' : e.s.pause ? '#38bdf8' : '#fbbf24';
					ctx.fill();
					ctx.lineWidth = 2;
					ctx.strokeStyle = e.s.pause || isEnd ? '#0f172a' : '#ffffff';
					ctx.stroke();
					ctx.fillStyle = isStart || isEnd ? '#ffffff' : '#0f172a';
					ctx.font = 'bold 11px sans-serif';
					ctx.textAlign = 'center';
					ctx.textBaseline = 'middle';
					ctx.fillText(String(e.i + 1), colX + listPad + 10, cy + 0.5);
					ctx.textAlign = 'left';
					ctx.textBaseline = 'alphabetic';

					ctx.font = '12.5px sans-serif';
					ctx.fillStyle = '#ffffff';
					e.lines.forEach((line, li) => {
						ctx.fillText(line, colX + listPad + 26, yy + 12 + li * lineH);
					});

					let tx = colX + colW - listPad;
					ctx.font = 'bold 9.5px sans-serif';
					for (const [label, bg, fg] of [...e.tags].reverse()) {
						const tw = ctx.measureText(label).width + 10;
						tx -= tw;
						roundRectPath(ctx, tx, yy + 1.5, tw, 13, 4);
						ctx.fillStyle = bg;
						ctx.fill();
						ctx.fillStyle = fg;
						ctx.fillText(label, tx + 5, yy + 11);
						tx -= 4;
					}
					yy += rowH + 6;
				}
			}
		}

		// 6) Quellenangabe
		ctx.font = '11px sans-serif';
		ctx.fillStyle = 'rgba(255,255,255,0.85)';
		ctx.fillText('Kartendaten © Esri, Maxar, Earthstar Geographics', 12, cssH - 10);

		// 7) Ansicht wiederherstellen (im Export-Editor bleibt die gewählte Ansicht)
		if (frameInner) frameInner.style.transform = frameTransform;
		if (!exportOpen) {
			mapEl.setAttribute('style', prevStyle);
			map.invalidateSize();
			map.setView(prevCenter, prevZoom);
		}

		return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
	}

async function savePng() {
		if (busy || exportBusy) return;
		exportBusy = true;
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
			exportBusy = false;
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
		if (busy || exportBusy) return;
		if (resolvedStops.length < 2) {
			errorMessage = 'Bitte zuerst eine Route berechnen.';
			return;
		}
		exportBusy = true;
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
			exportBusy = false;
			progressText = '';
		}
	}

	async function printMap() {
		if (busy || exportBusy) return;
		if (resolvedStops.length < 2) {
			errorMessage = 'Bitte zuerst eine Route berechnen.';
			return;
		}
		exportBusy = true;
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
			exportBusy = false;
			progressText = '';
		}
	}

	function onAfterPrint() {
		printing = false;
		printImage = '';
	}

</script>

<svelte:window onafterprint={onAfterPrint} onresize={updateFrameScale} />

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
					<Button variant="outline" onclick={openExport} disabled={busy}>Export / Drucken (A4)</Button>
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


<!-- Druck-Layout: A4 Hochformat (Karte füllt die Seite, Overlays sind im Bild) -->
<!-- Export-Editor: A4-Vorschau mit verschiebbaren Elementen -->
{#if exportOpen}
	<div class="fixed inset-0 z-[4000] flex flex-col bg-black/80 backdrop-blur-sm">
		<!-- Kopfzeile -->
		<div class="flex flex-wrap items-center gap-2 px-4 py-2 text-white">
			<span class="text-sm font-semibold">Export-Vorschau (A4 Hochformat)</span>
			<span class="text-muted-foreground hidden text-xs sm:inline"
				>· Elemente ziehen zum Verschieben, Eckgriff zum Skalieren, Karte frei verschieben/zoomen</span
			>
			<div class="ml-auto flex flex-wrap items-center gap-2">
				<Button variant="outline" size="sm" class="bg-slate-800 text-white hover:bg-slate-700 hover:text-white dark:bg-input/30 dark:text-foreground" onclick={fitRouteInFrame}>Route einpassen</Button>
				<Button variant="outline" size="sm" class="bg-slate-800 text-white hover:bg-slate-700 hover:text-white dark:bg-input/30 dark:text-foreground" onclick={resetExportLayout}>Layout zurücksetzen</Button>
				<Button variant="outline" size="sm" class="bg-slate-800 text-white hover:bg-slate-700 hover:text-white dark:bg-input/30 dark:text-foreground" onclick={closeExport}>Fertig</Button>
			</div>
		</div>
		<!-- A4-Bühne -->
		<div class="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
			<div style="width:{A4_W * frameScale}px;height:{A4_H * frameScale}px" class="relative">
				<div
					bind:this={frameInner}
					style="width:{A4_W}px;height:{A4_H}px;transform:scale({frameScale});transform-origin:top left"
					class="absolute top-0 left-0 overflow-hidden rounded-sm bg-black shadow-2xl ring-1 ring-white/30"
				>
					<div bind:this={frameHost} class="relative h-full w-full"></div>

					<!-- Titelbox -->
					{#if title.trim()}
						<div
							role="button"
							tabindex="0"
							aria-label="Titelbox verschieben"
							class="export-hit absolute cursor-move rounded-xl bg-slate-900/88 px-3.5 py-2 {dragTarget === 'title' ? 'ring-2 ring-amber-400' : 'hover:ring-2 hover:ring-white/60'}"
							style="left:{exportLayout.titleX}px;top:{exportLayout.titleY}px"
							onpointerdown={(e) => startOverlayDrag(e, 'title', 'move')}
							onpointermove={onOverlayDrag}
							onpointerup={endOverlayDrag}
							onpointercancel={endOverlayDrag}
						>
							<p class="text-2xl leading-tight font-bold text-white">{title}</p>
							{#if tripDate.trim() || routeDistanceKm !== null}
								<p class="text-[13px] text-slate-300">
									{[tripDate.trim(), routeDistanceKm !== null ? `Gesamtstrecke: ca. ${routeDistanceKm.toFixed(0)} km` : ''].filter(Boolean).join(' · ')}
								</p>
							{/if}
						</div>
					{/if}

					<!-- Logo -->
					{#if showLogo}
						<div
							role="button"
							tabindex="0"
							aria-label="Logo verschieben"
							class="export-hit absolute cursor-move {dragTarget === 'logo' ? 'ring-2 ring-amber-400' : 'hover:ring-2 hover:ring-white/60'}"
							style="left:{exportLayout.logoX}px;top:{exportLayout.logoY}px;width:{exportLayout.logoW}px"
							onpointerdown={(e) => startOverlayDrag(e, 'logo', 'move')}
							onpointermove={onOverlayDrag}
							onpointerup={endOverlayDrag}
							onpointercancel={endOverlayDrag}
						>
							<img src="/logo.png" alt="Vereinslogo" style="width:{exportLayout.logoW}px" />
							<button
								type="button"
								class="absolute -right-1 -bottom-1 h-4 w-4 cursor-nwse-resize rounded-sm bg-amber-400 opacity-80"
								aria-label="Logo-Größe ändern"
								onpointerdown={(e) => startOverlayDrag(e, 'logo', 'resize')}
								onpointermove={onOverlayDrag}
								onpointerup={endOverlayDrag}
								onpointercancel={endOverlayDrag}></button>
						</div>
					{/if}

					<!-- Stoppliste -->
					<div
						role="button"
						tabindex="0"
						aria-label="Stoppliste verschieben"
						class="export-hit absolute cursor-move rounded-xl bg-black/74 {dragTarget === 'legend' ? 'ring-2 ring-amber-400' : 'hover:ring-2 hover:ring-white/60'}"
						style="left:{exportLayout.legendX}px;top:{exportLayout.legendY}px;width:{exportLayout.legendW}px"
						onpointerdown={(e) => startOverlayDrag(e, 'legend', 'move')}
						onpointermove={onOverlayDrag}
						onpointerup={endOverlayDrag}
						onpointercancel={endOverlayDrag}
					>
						<p class="px-3.5 pt-1.5 pb-1 text-[13px] font-bold tracking-wide text-white uppercase">Etappen / Stopps</p>
						<div class="flex pb-1.5">
							{#each legendCols as col, ci (ci)}
								<div class="min-w-0 flex-1 px-3">
									{#each col as item (item.i)}
										<div class="mb-1.5 flex items-start gap-1.5">
											<span
												class="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold {item.i === 0
													? 'bg-green-500 text-white'
													: item.i === resolvedStops.length - 1
														? 'bg-slate-900 text-white ring-2 ring-white'
														: item.s.pause
															? 'bg-sky-400 text-slate-900'
															: 'bg-amber-400 text-slate-900'}">{item.i + 1}</span
											>
											<p class="min-w-0 flex-1 text-[12.5px] leading-4 text-white">
												{#if item.i === 0 || item.i === resolvedStops.length - 1 || item.s.pause}
													<span class="float-right ml-1 inline-flex gap-1">
														{#if item.i === 0}<span class="rounded bg-green-500 px-1.5 py-px text-[9.5px] font-bold text-white">Start</span>{/if}
														{#if item.i === resolvedStops.length - 1}<span class="rounded bg-slate-700 px-1.5 py-px text-[9.5px] font-bold text-white">Ziel</span>{/if}
														{#if item.s.pause}<span class="rounded bg-sky-400 px-1.5 py-px text-[9.5px] font-bold text-slate-900">Pause</span>{/if}
													</span>
												{/if}
												{item.s.name}
											</p>
										</div>
									{/each}
								</div>
							{/each}
						</div>
						<button
							type="button"
							class="absolute -right-1.5 -bottom-1.5 h-5 w-5 cursor-nwse-resize rounded-sm bg-amber-400 opacity-80"
							aria-label="Liste breiter/schmaler machen"
							onpointerdown={(e) => startOverlayDrag(e, 'legend', 'resize')}
							onpointermove={onOverlayDrag}
							onpointerup={endOverlayDrag}
							onpointercancel={endOverlayDrag}></button>
					</div>
				</div>
			</div>
		</div>
		<!-- Fußzeile mit Export-Aktionen -->
		<div class="flex flex-wrap items-center justify-center gap-2 px-4 py-3">
			<Button onclick={savePng} disabled={exportBusy}>🖼️ PNG speichern</Button>
			<Button onclick={savePdf} disabled={exportBusy}>📄 PDF speichern</Button>
			<Button variant="outline" class="bg-slate-800 text-white hover:bg-slate-700 hover:text-white" onclick={printMap} disabled={exportBusy}>🖨️ Drucken</Button>
			{#if exportBusy}
				<span class="text-muted-foreground text-sm">{progressText}</span>
			{/if}
			{#if errorMessage}
				<span class="text-destructive text-sm">{errorMessage}</span>
			{/if}
		</div>
	</div>
{/if}

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
	:global(.marker-flag) {
		position: absolute;
		top: -14px;
		right: -10px;
		width: 22px;
		height: 22px;
		border-radius: 50% 50% 50% 4px;
		border: 2px solid #ffffff;
		color: #ffffff;
		font-size: 13px;
		line-height: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
		overflow: hidden;
	}
	:global(.marker-flag.start) {
		background: #22c55e;
	}
	:global(.marker-flag.end) {
		background: #0f172a;
		top: -14px;
		right: 8px;
	}
	:global(.marker-flag.combined) {
		background: linear-gradient(135deg, #22c55e 50%, #0f172a 50%);
		width: 26px;
		height: 26px;
		top: -16px;
		right: -12px;
		font-size: 14px;
	}
	/* Kombinierte Start/Ziel-Blase: halb grün, halb dunkel, beide Fahnen oben */
	:global(.stop-marker.combined) {
		background: transparent;
		border: none;
		box-shadow: none;
		overflow: visible;
	}
	:global(.stop-marker.combined .half) {
		position: absolute;
		top: 6px;
		left: 6px;
		width: 40px;
		height: 40px;
		border-radius: 50%;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
	}
	:global(.stop-marker.combined .half.start) {
		background: #22c55e;
		clip-path: inset(0 50% 0 0);
		border-left: 3px solid #0f172a;
	}
	:global(.stop-marker.combined .half.end) {
		background: #0f172a;
		clip-path: inset(0 0 0 50%);
	}
	:global(.stop-marker.combined .marker-flag) {
		top: -6px;
	}
	:global(.stop-marker.combined .marker-flag.start) {
		right: 28px;
	}
	:global(.stop-marker.combined .marker-flag.end) {
		right: 2px;
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
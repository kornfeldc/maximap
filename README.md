# Maximap – Routenplaner für Gemeinschaftsfahrten

Einfaches Tool für Motorradclubs: Orte eingeben, Route auf Satellitenkarte ansehen, als A4-Hochformat drucken oder als PNG speichern.

## Features

- **Ortsliste**: Beliebig viele Stopps als Eingabefelder (mehr als 20 möglich), Nummerierung automatisch
- **Satellitenkarte**: Esri World Imagery (kostenlos, kein API-Key) mit Ortsnamen
- **Route**: Echte Straßenroute über den kostenlosen OSRM-Demodienst (keine Navi-Ansagen, nur die Linie)
- **Etappenliste**: Sichtbare Liste aller Stopps am rechten unteren Rand
- **Logo**: Vereinslogo wird oben rechts auf der Karte angezeigt (ein-/ausschaltbar), Dummy-Logo liegt unter `static/logo.png` – einfach durch das echte Logo ersetzen
- **Export**: "Drucken (A4)" erzeugt ein druckfertiges A4-Hochformat-Layout (Karte + Stoppliste + Logo + Titel); "Speichern (PNG)" lädt die Karte als Bilddatei
- **Deutsch**: Komplette Oberfläche auf Deutsch
- **Kein Backend**: keine Datenbank, keine Logins – alles nur im Browser (localStorage)

## Freie Dienste im Einsatz

| Dienst | Zweck | Hinweis |
| --- | --- | --- |
| Esri World Imagery | Satellitenkacheln | frei mit Quellenangabe |
| OSRM (Demo-Server) | Straßenroute | Demo, fair use |
| Nominatim (OSM) | Ortssuche | max. 1 Anfrage/Sekunde (wird eingehalten) |
| Photon (Komoot) | Ortssuche-Fallback | greift automatisch, wenn Nominatim blockiert |

## Tech-Stack

- **SvelteKit 2** mit **Svelte 5** (Runes-Modus)
- **TypeScript** (geprüft via `svelte-check`)
- **Tailwind CSS v4** (CSS-basierte Konfiguration)
- **shadcn-svelte**-Komponenten (bits-ui)
- **Leaflet** für die Satellitenkarte
- **jspdf** für den PNG-Export
- **Vite** als Build-Tool

## vibe coded

Diese App wurde vollständig **vibe coded** – mit [Orca ADE](https://www.onorca.dev/) als Umgebung, [Crush](https://charm.land/) als Harness und [GLM 5.3 Flash](https://z.ai/model-api) als Modell.

## Entwicklung

```bash
npm install
npm run dev
```

Die App läuft dann auf http://localhost:5173.

## Logo austauschen

Einfach `static/logo.png` durch das eigene Logo (PNG mit Transparenz) ersetzen.
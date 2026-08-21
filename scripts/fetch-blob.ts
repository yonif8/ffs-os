// fetch-blob.ts — run one data source for real, right now, and write the blob to a file.
//
// This is the bridge that lets the whole live-data path be proven from the PC before the
// Android app is wired to it: the network fetch, the parsing and the FFSM encoding are the
// SHIPPING ones (src/data/sources/*), and the file it drops is what
// `g2flash/tools/push_data.sh` sends to the glasses.
//
//     bun run scripts/fetch-blob.ts weather --out /tmp/blob.bin
//     bun run scripts/fetch-blob.ts headlines --out /tmp/blob.bin --count 5
//     bun run scripts/fetch-blob.ts weather --place "Tel Aviv" --lat 32.07 --lon 34.78
//
// then, from the workspace root:
//
//     g2flash/tools/push_data.sh --app 3 --seq 1 --in /tmp/blob.bin
//
// ⛔ It prints the DECODED content to stdout so the operator can read it and compare it with
//    the HUD — that is the whole point of the comparison. It is therefore for a terminal,
//    NOT for `src/os/log.ts`: nothing here goes near the off-device telemetry pipe, and this
//    script must never be imported by the app.
//
// Both sources are keyless, account-less public HTTPS APIs; the only Android permission the
// real app needs for either is INTERNET. See src/data/sources/*.ts for why that matters.

import { jsonFetcher } from "../src/data";
import { headlinesSource } from "../src/data/sources/headlines";
import { weatherSource } from "../src/data/sources/weather";
import { decodeFfsm } from "../src/sdk/ffsm";
import { FFSC_MAX_BLOB } from "../src/sdk/ffsc";

// Declared rather than pulled in as `@types/bun`: this script is the only thing in the repo
// that touches the Bun global, and a dev-dependency for one function signature is a worse
// trade than four lines. It is exact — if `Bun.write` ever changes shape, tsc says so here.
declare const Bun: { write(path: string, data: Uint8Array): Promise<number> };

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

const which = process.argv[2] ?? "weather";
const out = arg("out", "blob.bin")!;

const fetchJson = await jsonFetcher(10_000);
const source =
  which === "headlines"
    ? headlinesSource({ fetchJson, count: Number(arg("count", "6")), label: arg("label", "HN") })
    : weatherSource({
        fetchJson,
        place: {
          name: arg("place", "London")!,
          latitude: Number(arg("lat", "51.5072")),
          longitude: Number(arg("lon", "-0.1276")),
        },
      });

const now = Date.now();
const blob = await source.fetch(now);

await Bun.write(out, blob);

console.log(`source   ${source.id}  (app_id ${source.appId})`);
console.log(`blob     ${blob.length} B  (channel cap ${FFSC_MAX_BLOB})`);
console.log(`written  ${out}`);
console.log(`fetched  ${new Date(now).toISOString()}`);
console.log("");
console.log("what the glasses will draw — compare this against the camera frame:");
for (const t of decodeFfsm(blob)) {
  console.log(`  [${t.name}]${t.unread ? " *" : ""}`);
  for (const m of t.messages) console.log(`     ${String(m.ageMin).padStart(5)}m  ${m.body}`);
}
console.log("");
console.log("next:  g2flash/tools/push_data.sh --app %d --seq <N> --in %s", source.appId, out);
console.log("       (bump <N> every push, or the glasses correctly treat it as a duplicate)");

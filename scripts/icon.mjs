// The Marketplace and Open VSX icon, media/icon.png, made from the activity
// bar's glyph (media/matterwave.svg): the same two waves, in the brand's
// blue on its dark ground, as the 128x128 PNG both registries require.
// Run `pnpm run icon` after changing the glyph and commit the result.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 128;
const GROUND = "#0B0C0E";
const WAVE = "#38bdf8";

const glyph = readFileSync(path.join(root, "media", "matterwave.svg"), "utf8");
const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(glyph)?.[1];
if (!inner) throw new Error("media/matterwave.svg has no <svg> body");

// The glyph's waves sit low in its 24x24 box; scaled to 80% and moved up,
// they are centred on the ground with a margin all round.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24">
<rect width="24" height="24" rx="5" fill="${GROUND}"/>
<g fill="none" stroke="${WAVE}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" transform="translate(2.4 0.4) scale(0.8)">${inner}</g>
</svg>`;

const png = new Resvg(svg, { fitTo: { mode: "width", value: SIZE } }).render().asPng();
writeFileSync(path.join(root, "media", "icon.png"), png);
console.log(`media/icon.png: ${SIZE}x${SIZE}, ${png.length} bytes`);

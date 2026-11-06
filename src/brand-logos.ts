// Marks for catalog apps that have no Simple Icons glyph. Files are the toolkit logos the landing page
// uses (trademarks belong to their owners; shown only to identify the apps). Name a file after the preset id,
// with dashes written as underscores.
const files = import.meta.glob("./logos/*.{svg,png}", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
export const logoFiles: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([path, url]) => [path.slice(8).replace(/\.[a-z]+$/, "").replace(/_/g, "-"), url]),
);

// Finds the gateway tools that match a task, so an agent loads a handful of schemas instead of
// every tool of every connected app. Ranking is BM25 over the tool and app names, the title,
// the description, and the input names, with light stemming and a few verb synonyms.

export type SearchDoc = {
  name: string;
  app: string;
  title?: string;
  description?: string;
  inputs?: string[];
};

const STOP = new Set(["a", "an", "the", "to", "of", "for", "in", "on", "and", "or", "by", "with", "from", "my", "me", "i", "is", "it", "this", "that", "all", "any", "some", "be", "as", "at", "into", "use", "which", "what", "who", "where", "when", "how", "am", "are", "do", "does", "can", "please", "need", "want"]);
// Words agents use for the same action. Each maps to one canonical form.
const SYNONYMS: Record<string, string> = {
  // Only true equivalents: merging distinct ideas ("draft" and "create") would blur the ranking.
  fetch: "get", read: "get", show: "get", view: "get", retrieve: "get", lookup: "find", search: "find",
  make: "create", add: "create", insert: "create",
  edit: "update", change: "update", modify: "update", rename: "update", patch: "update",
  remove: "delete", erase: "delete", destroy: "delete",
  enumerate: "list", browse: "list",
  org: "organisation", orgs: "organisation", organization: "organisation", organizations: "organisation",
  people: "person",
};

function stem(word: string) {
  let w = word;
  if (w.length > 5 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(ses|xes|ches|shes)$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  return w;
}

export function terms(text: string): string[] {
  return text
    // Split camelCase and snake/kebab case so "listLeads" and "list_leads" both index "list", "lead".
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t))
    .map((t) => SYNONYMS[t] || t)
    .map(stem)
    .map((t) => SYNONYMS[t] || t);
}

// Name and app words count more than prose: "create_campaign" should beat a description that mentions campaigns.
function fields(d: SearchDoc): [string[], number][] {
  return [
    [terms(d.name.split("__").slice(1).join(" ") || d.name), 3],
    [terms(d.app), 2],
    [terms(d.title || ""), 2],
    [terms(d.description || ""), 1],
    [terms((d.inputs || []).join(" ")), 0.5],
  ];
}

type Indexed = { doc: SearchDoc; tf: Map<string, number>; length: number };

export class ToolIndex {
  private docs: Indexed[];
  private df = new Map<string, number>();
  private avg: number;
  constructor(docs: SearchDoc[]) {
    this.docs = docs.map((doc) => {
      const tf = new Map<string, number>();
      let length = 0;
      for (const [words, weight] of fields(doc))
        for (const w of words) {
          tf.set(w, (tf.get(w) || 0) + weight);
          length += weight;
        }
      for (const w of tf.keys()) this.df.set(w, (this.df.get(w) || 0) + 1);
      return { doc, tf, length };
    });
    this.avg = this.docs.reduce((n, d) => n + d.length, 0) / Math.max(1, this.docs.length);
  }
  search(query: string, limit = 8, app?: string): SearchDoc[] {
    const pool = app ? this.docs.filter((d) => sameApp(d.doc.app, d.doc.name, app)) : this.docs;
    const q = [...new Set(terms(query))];
    if (!q.length) return pool.slice(0, limit).map((d) => d.doc);
    const N = this.docs.length, k1 = 1.2, b = 0.75;
    const scored = pool
      .map((d) => {
        let score = 0, matched = 0;
        for (const t of q) {
          let f = d.tf.get(t) || 0;
          // A prefix hit ("camp" → "campaign") counts for less than an exact word.
          if (!f && t.length >= 4) for (const [w, n] of d.tf) if (w.startsWith(t)) f = Math.max(f, n * 0.5);
          if (!f) continue;
          matched++;
          const df = this.df.get(t) || 1;
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / this.avg));
        }
        // Prefer tools that cover more of the request, not just one very rare word.
        return { d, score: score * (0.5 + matched / q.length) };
      })
      .filter((s) => s.score > 0)
      .sort((x, y) => y.score - x.score || x.d.doc.name.localeCompare(y.d.doc.name));
    return scored.slice(0, limit).map((s) => s.d.doc);
  }
}

// An app is named either by its display name ("Mail Orbyt") or its tool prefix ("mail_orbyt").
export function sameApp(appName: string, toolName: string, wanted: string) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const want = norm(wanted);
  return !!want && (norm(appName) === want || norm(toolName.split("__")[0]) === want);
}

import type { Group } from "./upstream.js";

// Sources sort their tools differently. Tools from sources without the primary source's groups are
// placed in the same groups by what they say about themselves, so the catalog reads as one list.
const RULES: [RegExp, Group][] = [
  [/linkedin/i, { slug: "linkedin", label: "LinkedIn", category: "Social", summary: "" }],
  [/instagram/i, { slug: "instagram", label: "Instagram", category: "Social", summary: "" }],
  [/tiktok/i, { slug: "tiktok", label: "TikTok", category: "Social", summary: "" }],
  [/youtube/i, { slug: "youtube", label: "YouTube", category: "Social", summary: "" }],
  [/reddit/i, { slug: "reddit", label: "Reddit", category: "Social", summary: "" }],
  [/facebook|meta ads/i, { slug: "facebook", label: "Facebook", category: "Social", summary: "" }],
  [/\b(twitter|x\.com|tweets?)\b/i, { slug: "x", label: "X (Twitter)", category: "Social", summary: "" }],
  [/amazon/i, { slug: "amazon", label: "Amazon", category: "E-commerce", summary: "" }],
  [/\bmaps?\b|places?|local business|yelp|tripadvisor/i, { slug: "maps", label: "Maps & local places", category: "Maps & local", summary: "" }],
  [/\b(job|jobs|hiring|ats|career)\b/i, { slug: "jobs", label: "Jobs & hiring", category: "Enrichment", summary: "" }],
  [/email|phone|contact|person|people|lead|prospect/i, { slug: "people", label: "People & contact data", category: "Enrichment", summary: "" }],
  [/compan|firmograph|funding|crunchbase|domain info/i, { slug: "companies", label: "Company data", category: "Enrichment", summary: "" }],
  [/keyword|backlink|seo|serp|search results/i, { slug: "web", label: "Open web & SEO data", category: "SEO/AEO", summary: "" }],
  [/scrap|crawl|extract|web page|website|search/i, { slug: "web", label: "Open web & SEO data", category: "SEO/AEO", summary: "" }],
  [/stock|crypto|market data|finance/i, { slug: "stocks", label: "Market data", category: "Market data", summary: "" }],
  [/image|video|voice|speech|audio|music/i, { slug: "media", label: "Images, video & voice", category: "AI generation", summary: "" }],
];
const OTHER: Group = { slug: "more", label: "More data tools", category: "Other", summary: "Other ready data tools." };
export const groupFor = (text: string): Group => RULES.find(([re]) => re.test(text))?.[1] ?? OTHER;

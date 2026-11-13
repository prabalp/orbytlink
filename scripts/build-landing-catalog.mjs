// Refresh with: node --import tsx scripts/build-landing-catalog.mjs
import fs from 'node:fs';
import { vendoredSkills } from '../server/skills-data.ts';
import { workflowTemplates } from '../src/workflow-templates.ts';
import { catalog as connectionPresets } from '../src/catalog.ts';
import { brands } from '../src/brand-icons.ts';

function parseCSV(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if (char === '\n' && !quoted) { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const headers = rows.shift();
  return rows.map(values => Object.fromEntries(headers.map((key, i) => [key, values[i] || ''])));
}
const groups = [
  ['Advertising & creators', /\bads$|advertising|\bcreators?\b|influencer|xingtu|pugongying|huxuan/i],
  ['Shopping & marketplaces', /shop|commerce|amazon|taobao|tmall|jd\.com|walmart|ebay|1688|xianyu|goofish|dewu|poizon|etsy|home depot|lazada|steam|temu/i],
  ['People & companies', /people|company|companies|contact|crunchbase|leadmagic|limadata|lusha|predictleads|prospeo|tomba|zerobounce|apollo|clay|crustdata|hunter|icypeas|linkedin/i],
  ['Search & web data', /seo|serp|keyword|search console|analytics|tag manager|ahrefs|exa$|exa search|firecrawl|scrap|openweb|parallel|semrush|serper|supadata|surf$|tavily|tikhub|tinyfish|you\.com|apify|bright data|browser use|cloro|context\.dev|open web|visibility|business profile/i],
  ['AI & content', /generation|judgment|luma|magicSlides|mathpix|memelord|minimax|mistral|openai|openrouter|pdf\.co|photoroom|artificial analysis|black forest|deepgram|deepseek|elevenlabs|fal\.ai|fish audio|gemini|higgsfield|html\/css/i],
  ['Finance & markets', /market data|marketstack|twelve data|alpha vantage|coingecko|eodhd|finnhub|economic/i],
  ['Maps, travel & weather', /weather|maps|places|airbnb|booking|tripadvisor|yelp|beike|zillow|graphhopper|flights|ipinfo|carsxe/i],
  ['Research & knowledge', /academic|biomedical|wikipedia|openalex|vaquill|medium|substack|douban/i],
  ['Jobs & developer tools', /github|package registr|stack overflow|slack|hacker news|product hunt|indeed|remote|glassdoor|career|job search|cloudflare/i],
  ['Social & media', /douyin|tiktok|instagram|youtube|twitter|facebook|weibo|zhihu|reddit|bilibili|kuaishou|xiaohongshu|wechat|threads|pipixia|lemon8|toutiao|xigua|spotify|link-in-bio|pinterest|rumble|apple music|twitch|bluesky|snapchat|soundcloud|truth social|youku|kick$|imdb|app store|google play|telegram|listen notes|social media/i],
];
const rows = parseCSV(fs.readFileSync('docs/pay-per-call-tools.csv', 'utf8'));
// Keep the public catalog focused on English-facing tools. Exclude the requested
// regional marketplaces and related local-language platforms, not global brands
// based on their country of origin. Preserve the original research CSV.
const excludedRegionalTools = /douyin|xingtu|pugongying|xiaohongshu|qq huxuan|weibo|zhihu|bilibili|kuaishou|wechat|pipixia|toutiao|xigua|youku|taobao|tmall|jd\.com|beike|lianjia|^1688$|xianyu|goofish|dewu|poizon|douban|baidu|naver|yandex|seznam/i;
const tools = new Map();
for (const row of rows) {
  if (row.category === 'Platform' || row.tool === '(A-Z gaps)' || excludedRegionalTools.test(row.tool)) continue;
  const key = row.tool.toLowerCase();
  if (!tools.has(key)) tools.set(key, { name: row.tool, category: groups.find(([, pattern]) => pattern.test(row.tool))?.[0] || 'Other APIs', sources: [] });
  tools.get(key).sources.push({ name: row.source, notes: row.notes });
}
// The research CSV covers paid APIs, not common workspace connectors. Add the
// verified connections from the app's preset catalog, skipping duplicates.
const presetCategories = {
  'Documents & Files': 'Documents & files',
  Communication: 'Communication',
  'Calendar & Contacts': 'Calendar & contacts',
  'Project Management': 'Project management',
  'Developer Tools': 'Developer tools',
  'Payments & Finance': 'Payments & finance',
};
for (const preset of connectionPresets) {
  const key = preset.name.toLowerCase();
  if (!tools.has(key)) tools.set(key, {
    name: preset.name,
    category: presetCategories[preset.segment] || preset.segment,
    sources: [],
  });
}
const existingLogoScript = fs.readFileSync('landing/catalog-logos.js', 'utf8');
const logosMatch = existingLogoScript.match(/window\.orbytLogos = (.*);\s*$/s);
const logos = logosMatch ? JSON.parse(logosMatch[1]) : {};
const brandAliases = {
  'Google Drive': 'google-drive', 'Google Docs': 'google-docs',
  'Google Sheets': 'google-sheets', 'Google Slides': 'google-slides',
  Gmail: 'gmail', 'Google Chat': 'google-chat', 'Google Calendar': 'google-calendar',
  'Google Contacts': 'google-people', Notion: 'notion', Linear: 'linear',
  'Atlassian (Jira & Confluence)': 'atlassian', Stripe: 'stripe',
};
for (const [name, iconId] of Object.entries(brandAliases)) {
  const icon = brands[iconId];
  if (icon) logos[name] = { path: icon.path, hex: icon.hex };
}
fs.writeFileSync('landing/catalog-logos.js', `// Brand marks: Simple Icons (CC0-1.0) and toolkit logos. Trademarks belong to their owners.\nwindow.orbytLogos = ${JSON.stringify(logos)};\n`);
const metadata = fs.readFileSync('server/skills.ts', 'utf8');
const skills = vendoredSkills.map(skill => {
  const match = metadata.match(new RegExp(`(?:"${skill.id}"|\\b${skill.id}): \\{ title: "([^"]+)", category: "([^"]+)"`));
  return { name: match?.[1] || skill.name, category: match?.[2] || 'Other', description: skill.description, source: skill.source.repo, url: `https://github.com/${skill.source.repo}/tree/${skill.source.commit}/${skill.source.path}` };
});
const workflows = workflowTemplates.map(item => ({ name: item.name, category: 'Workflow templates', description: item.description, steps: item.steps.map(step => ({ app: step.app, label: step.label })) }));
fs.writeFileSync('landing/catalog-data.js', `// Generated from bundled skills, verified connection presets and workflow templates.\nwindow.orbytCatalog = ${JSON.stringify({ skills, tools: [...tools.values()].map(({ sources, ...tool }) => tool).sort((a,b) => a.name.localeCompare(b.name)), workflows }, null, 2)};\n`);
console.log(`${skills.length} skills, ${tools.size} tools, ${workflows.length} workflows`);

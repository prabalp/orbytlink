"""Fetch local toolkit logos. Existing vector marks are retained; no runtime logo requests."""
import concurrent.futures, json, pathlib, re, urllib.request
root = pathlib.Path(__file__).resolve().parents[1]
def read_global(name):
    text = (root / 'landing' / name).read_text()
    return json.loads(text.split(' = ', 1)[1].rstrip(';\n'))
data = read_global('catalog-data.js')
logos = read_global('catalog-logos.js')
assets = root / 'landing' / 'logos'
assets.mkdir(exist_ok=True)
# These entries describe capabilities, not individual brands; give each a pictogram.
generic = {'Academic literature','AI judgment','AI Visibility / AEO','Company data','Creators & influencers','Crypto Market Data','Economic indicators','Health & biomedical','Image generation','Job Search','Link-in-bio pages','Music generation','Open web & SEO data','Other market data','Package registries','People & contact data','Places (local search)','Social Media Cross-Platform Search','Stock Market Data','Video generation','Voice generation','Weather'}
aliases = {'API Ninjas':['api_ninjas'], 'API-Sports':['api_sports'], 'Bing Keyword Data':['bing'], 'Black Forest Labs':['black_forest_labs','blackforestlabs'], 'Browser Use':['browser_use'], 'DuckDuckGo SERP':['duckduckgo'], 'EODHD APIs':['eodhd_apis','eodhd'], 'Exa Search':['exa'], 'Fal.ai':['fal_ai','fal'], 'Firecrawl Scrape URL':['firecrawl'], 'Gemini':['googlegemini','gemini'], 'Hacker News':['hackernews'], 'Home Depot':['homedepot'], 'HTML/CSS to Image':['html_to_image','html_css_to_image'], 'Ignav Flights':['ignav'], 'Luma Labs':['luma','luma_labs'], 'Microsoft Advertising':['microsoft_ads','bing'], 'OpenAI':['openai'], 'OpenAlex':['openalex'], 'PDF.co':['pdf_co'], 'People Data Labs':['peopledatalabs','people_data_labs'], 'Remote OK':['remoteok'], 'The Companies API':['the_companies_api'], 'Truth Social':['truthsocial'], 'We Work Remotely':['weworkremotely'], 'Web3 Career':['web3_career'], 'Yahoo SERP':['yahoo'], 'You.com':['youcom','you']}
domains={'Temu':'temu.com','Walmart':'walmart.com','Ignav Flights':'ignav.com','Remote OK':'remoteok.com','The Companies API':'thecompaniesapi.com','Black Forest Labs':'bfl.ai','Home Depot':'homedepot.com','Truth Social':'truthsocial.com','DuckDuckGo SERP':'duckduckgo.com','Bright Data':'brightdata.com','Bing Keyword Data':'bing.com','You.com':'you.com','Lazada':'lazada.com','Microsoft Advertising':'ads.microsoft.com','IPinfo':'ipinfo.io','Listen Notes':'listennotes.com','Yahoo SERP':'yahoo.com','We Work Remotely':'weworkremotely.com','Lemon8':'lemon8-app.com','Gemini':'gemini.google.com'}
def fetch(item):
    name = item['name']
    if name in logos and 'src' in logos[name] and b'composio-fallback' in (root/'landing'/logos[name]['src']).read_bytes():
        del logos[name]
    if name in logos or name in generic: return None
    normal = re.sub('[^a-z0-9]+', '_', name.lower()).strip('_')
    candidates = list(dict.fromkeys(aliases.get(name, []) + [normal, normal.replace('_','')]))
    for slug in candidates:
        url = 'https://logos.composio.dev/api/' + slug
        try:
            req = urllib.request.Request(url, headers={'User-Agent':'OrbytLink-catalog-assets/1.0'})
            with urllib.request.urlopen(req, timeout=12) as response:
                mime = response.headers.get_content_type(); content = response.read()
            if not mime.startswith('image/') or len(content)<80 or b'composio-fallback' in content: continue
            ext = {'image/svg+xml':'svg','image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/x-icon':'ico','image/vnd.microsoft.icon':'ico'}.get(mime)
            if not ext: continue
            filename = normal + '.' + ext
            (assets / filename).write_bytes(content)
            return name, {'src':'logos/'+filename, 'origin':url}
        except Exception: pass
    if name in domains:
        url='https://www.google.com/s2/favicons?sz=128&domain='+domains[name]
        try:
            with urllib.request.urlopen(url,timeout=15) as response:
                content=response.read();mime=response.headers.get_content_type()
            if mime.startswith('image/') and len(content)>100:
                filename=normal+'.png';(assets/filename).write_bytes(content)
                old=assets/(normal+'.svg')
                if old.exists() and b'composio-fallback' in old.read_bytes():old.unlink()
                return name, {'src':'logos/'+filename,'origin':'https://'+domains[name]}
        except Exception:pass
    return name, None
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    for result in pool.map(fetch, data['tools']):
        if result:
            name, logo = result
            if logo: logos[name]=logo
            else: print('MISSING', name)
(root/'landing/catalog-logos.js').write_text('// Brand marks: Simple Icons (CC0-1.0) and toolkit logos. Trademarks belong to their owners.\nwindow.orbytLogos = '+json.dumps(logos,separators=(',',':'))+';\n')
print('Branded tools covered:',sum(x['name'] in logos for x in data['tools']), 'of',len(data['tools'])-len(generic))

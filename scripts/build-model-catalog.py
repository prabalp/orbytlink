"""Build the public model catalog from a dated snapshot; prices include a 5% markup.
Refresh docs/ai-models-snapshot.json from its source before regenerating.
Supplemental rates are verified against the individual model pages, 2026-11-04.
"""
import json, pathlib
from decimal import Decimal
root=pathlib.Path(__file__).resolve().parents[1]
snapshot=json.loads((root/'docs/ai-models-snapshot.json').read_text())
categories={'language':'Text & reasoning','image':'Image generation','video':'Video generation','embedding':'Embeddings','speech':'Speech generation','transcription':'Transcription','realtime':'Realtime','reranking':'Reranking','evaluation':'Evaluation'}
# Missing structured API rates, verified on /ai-gateway/models/<model-slug>.
supplements={
 'bfl/flux-2-flex':('0.06','megapixel'), 'bfl/flux-2-klein-4b':('0.014','megapixel'),
 'bfl/flux-2-klein-9b':('0.015','megapixel'), 'bfl/flux-2-max':('0.07','megapixel'),
 'bfl/flux-2-pro':('0.03','megapixel'), 'bfl/flux-3-video':('0.06','second'),
 'cohere/rerank-v3.5':('2','1K queries'), 'cohere/rerank-v4-fast':('2','1K queries'),
 'cohere/rerank-v4-pro':('2.5','1K queries'), 'elevenlabs/scribe-v2-realtime':('0.39','hour of audio'),
 'prodia/flux-fast-schnell':('0.001','image')}
rate_units={
 'input':('Input','1M tokens',1000000), 'output':('Output','1M tokens',1000000),
 'input_cache_read':('Cached input','1M tokens',1000000),'input_cache_write':('Cache write','1M tokens',1000000),
 'image':('Image','image',1), 'speech_input_character_cost':('Text input','1M characters',1000000),
 'speech_output_cost_per_second':('Audio output','minute',60),
 'transcription_duration_cost_per_second':('Audio input','minute',60),
 'audio_input_token_cost':('Audio input','1M audio tokens',1000000),
 'audio_output_token_cost':('Audio output','1M audio tokens',1000000),
 'realtime_session_duration_cost_per_second':('Session','minute',60),
 'realtime_client_message_cost':('Client message','message',1),
 # The public model pages list search prices per 1,000 requests.
 'web_search':('Web search','1K requests',1), 'maps_search':('Maps search','1K requests',1),
 'cost_per_million_tokens':('Video tokens','1M video tokens',1)}
def money(value,multiplier=1):return format(Decimal(str(value))*Decimal('1.05')*Decimal(multiplier),'f')
def label(key):return key.replace('_',' ').capitalize()
def build_rates(pricing,typ):
 rates=[]
 def add(name,value,unit,multiplier=1,condition='Standard'):
  rates.append({'label':name,'amount':money(value,multiplier),'unit':unit,'condition':condition})
 def walk(obj,path='Standard'):
  for key,value in obj.items():
   if key in rate_units:
    if key=='input' and any(k in obj for k in ['speech_input_character_cost','transcription_duration_cost_per_second']):continue
    name,unit,mult=rate_units[key];add(name,value,unit,mult,path)
   elif key.endswith('_tiers') and isinstance(value,list):
    base=key.removesuffix('_tiers');name,unit,mult=rate_units[base]
    for tier in value:
     context=f"{tier.get('min',0):,} to {tier['max']-1:,} input tokens" if 'max' in tier else f"{tier.get('min',0):,}+ input tokens"
     add(name,tier['cost'],unit,mult,context if path=='Standard' else path+' · '+context)
   elif key in ['video_duration_pricing','image_dimension_quality_pricing']:
    for tier in value:
     condition=' · '.join(f"{label(k)}: {str(v).lower() if isinstance(v,bool) else v}" for k,v in tier.items() if k not in ['cost','cost_per_second'])
     if 'cost_per_second' in tier:add('Video output',tier['cost_per_second'],'second',1,condition or path)
     elif 'cost' in tier:add('Image',tier['cost'],'image',1,condition or path)
   elif key=='video_token_pricing':
    for tier in value.get('tiers',[]):
     for variant,config in tier.items():
      if isinstance(config,dict):walk(config, f"{tier.get('resolution','')} · {label(variant)}")
   elif key=='peak_pricing':continue
   elif isinstance(value,dict):
    if key=='long_context':
     walk({k:v for k,v in value.items() if k!='threshold'},path+f" · {value.get('threshold',0):,}+ input tokens")
    else:walk(value,label(key) if path=='Standard' else path+' · '+label(key))
 walk(pricing)
 return rates
models=[]
for raw in snapshot['data']:
 pricing=raw.get('pricing',{});rates=build_rates(pricing,raw['type'])
 if raw['id'] in supplements:
  amount,unit=supplements[raw['id']];rates.append({'label':'Usage','amount':money(amount),'unit':unit,'condition':'Starting rate' if raw['id']=='bfl/flux-3-video' else 'Standard'})
 def primary(side):
  labels = ['Input'] if side=='input' else ['Output']
  if raw['type']=='speech' and side=='input':labels=['Text input','Input']
  if raw['type']=='transcription' and side=='input':labels=['Audio input','Input']
  if raw['type']=='speech' and side=='output':labels=['Audio output','Output']
  for name in labels:
   match=next((r for r in rates if r['label']==name and r['condition']=='Standard'),None)
   if match:return match
  return None
 input_rate,output_rate=primary('input'),primary('output')
 extras=[r for r in rates if r not in [input_rate,output_rate] and r['label'] not in ['Cached input','Cache write']]
 extra=next((r for r in extras if r['condition']=='Standard'),None)
 if not extra and extras:
  extra=min(extras,key=lambda r:Decimal(r['amount']));extra={**extra,'from':len(extras)>1 or extra['condition']=='Starting rate'}
 # Do not repeat language-model context-tier rates as an unrelated extra charge.
 if extra and extra['label'] in ['Input','Output'] and raw['type']=='language':extra=None
 models.append({'id':raw['id'],'name':raw['name'],'provider':raw['owned_by'],'category':categories[raw['type']], 'type':raw['type'],'context':raw.get('context_window') or None,'inputRate':input_rate,'outputRate':output_rate,'extraRate':extra,'rates':rates,'tags':raw.get('tags',[]),'modalities':raw.get('modalities',{}),'variable':bool(pricing.get('varies_by_provider')),'peak':pricing.get('peak_pricing'),'tiered':any(k.endswith('_tiers') for k in pricing),'notes':pricing.get('video_token_pricing',{}).get('notes','')})
order=list(categories.values())
models.sort(key=lambda m:(order.index(m['category']),m['provider'],m['name'].lower()))
output={'updatedAt':snapshot['fetchedAt'],'models':models}
(root/'landing/model-data.js').write_text('// Generated pricing catalog. Regenerate with scripts/build-model-catalog.py.\nwindow.orbytModels = '+json.dumps(output,separators=(',',':'))+';\n')
print(len(models),'models;',sum(not m['rates'] for m in models),'prices pending')

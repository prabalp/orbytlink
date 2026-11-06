"""Pricing checks: run python3 -m unittest discover -s tests -p test_model_catalog.py."""
import json
import pathlib
import unittest
from decimal import Decimal
ROOT=pathlib.Path(__file__).resolve().parents[1]
RAW=json.loads((ROOT/'docs/ai-models-snapshot.json').read_text())['data']
PUBLIC=json.loads((ROOT/'landing/model-data.js').read_text().split(' = ',1)[1].rstrip(';\n'))['models']
BY_ID={item['id']:item for item in PUBLIC}
class ModelCatalogPricing(unittest.TestCase):
    def test_every_model_is_retained_once(self):
        self.assertEqual(len(PUBLIC),len(RAW))
        self.assertEqual(set(BY_ID),{item['id'] for item in RAW})
    def test_all_standard_token_prices_include_exact_markup(self):
        for raw in RAW:
            for key,label in [('input','Input'),('output','Output'),('input_cache_read','Cached input'),('input_cache_write','Cache write')]:
                price=raw.get('pricing',{}).get(key)
                if price is None:continue
                if key=='input' and any(k in raw['pricing'] for k in ['speech_input_character_cost','transcription_duration_cost_per_second']):continue
                rate=next(r for r in BY_ID[raw['id']]['rates'] if r['label']==label and r['condition']=='Standard')
                self.assertEqual(Decimal(rate['amount']),Decimal(price)*Decimal('1.05')*1000000,raw['id'])
    def test_every_context_tier_preserves_bounds_and_prices(self):
        for raw in RAW:
            for key,label in [('input_tiers','Input'),('output_tiers','Output'),('input_cache_read_tiers','Cached input'),('input_cache_write_tiers','Cache write')]:
                for tier in raw.get('pricing',{}).get(key,[]):
                    condition=f"{tier.get('min',0):,} to {tier['max']-1:,} input tokens" if 'max' in tier else f"{tier.get('min',0):,}+ input tokens"
                    rate=next(r for r in BY_ID[raw['id']]['rates'] if r['label']==label and r['condition']==condition)
                    self.assertEqual(Decimal(rate['amount']),Decimal(tier['cost'])*Decimal('1.05')*1000000)
    def test_media_units_are_not_token_units(self):
        speech=BY_ID['elevenlabs/eleven-flash-v2']['inputRate']
        self.assertEqual(speech['unit'],'1M characters')
        self.assertEqual(Decimal(speech['amount']),Decimal('21'))
        image=BY_ID['bfl/flux-2-pro']['extraRate']
        self.assertEqual(image['unit'],'megapixel')
        self.assertEqual(Decimal(image['amount']),Decimal('0.0315'))
        rerank=BY_ID['cohere/rerank-v4-pro']['extraRate']
        self.assertEqual(rerank['unit'],'1K queries')
        self.assertEqual(Decimal(rerank['amount']),Decimal('2.625'))
        audio=BY_ID['elevenlabs/scribe-v2']['inputRate']
        self.assertEqual(audio['unit'],'minute')
        self.assertEqual(Decimal(audio['amount']),Decimal('0.000030556')*Decimal('1.05')*60)
    def test_missing_rates_are_not_free(self):
        for model_id in ['microsoft/mai-transcribe-2-streaming','topaz/proteus','topaz/starlight-precise-2.6','topaz/wonder-3.5']:
            self.assertEqual(BY_ID[model_id]['rates'],[])
            self.assertIsNone(BY_ID[model_id]['inputRate'])
            self.assertIsNone(BY_ID[model_id]['extraRate'])
if __name__=='__main__':unittest.main()

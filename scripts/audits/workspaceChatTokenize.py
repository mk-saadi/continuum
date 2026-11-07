#!/usr/bin/env python3
"""Measure captured requests without publishing their content.

Compile ggufPromptTokens.cpp against the matching llama.cpp headers/libraries.
Requires Jinja2. This renders the GGUF template with Python Jinja2, NOT the
server's minja implementation; counts are retrospective template measurements.
Never substitutes these counts for historical provider usage.
"""
import argparse
import hashlib
import json
import subprocess
import jinja2

p = argparse.ArgumentParser()
p.add_argument('--tokenizer', required=True)
p.add_argument('--model', required=True)
p.add_argument('requests', nargs='+')
a = p.parse_args()

def invoke(text='', template=False):
    return subprocess.run([a.tokenizer, a.model] + (['template'] if template else []),
                          input=text, text=True, capture_output=True, check=True).stdout

template = invoke(template=True)
env = jinja2.Environment()
def fail(message):
    raise ValueError(message)
env.globals['raise_exception'] = fail
env.filters['tojson'] = lambda value, **kwargs: json.dumps(value, ensure_ascii=False, **kwargs)
render = env.from_string(template)

def measure(body):
    rendered = render.render(messages=body['messages'], tools=body.get('tools', []),
                             add_generation_prompt=True, enable_thinking=True,
                             bos_token='', eos_token='<|im_end|>')
    return {'tokens': int(invoke(rendered)), 'renderedBytes': len(rendered.encode())}

records = []
for filename in a.requests:
    raw = open(filename, 'rb').read()
    body = json.loads(raw)
    records.append({'requestSha256': hashlib.sha256(raw).hexdigest(),
                    'serializedBytes': len(raw), 'toolCount': len(body.get('tools', [])),
                    'measured': measure(body),
                    'withoutTools': measure({**body, 'tools': []})})
print(json.dumps({'method': 'GGUF tokenizer, Python Jinja2 embedded template, thinking enabled; not server replay',
                  'templateSha256': hashlib.sha256(template.encode()).hexdigest(),
                  'records': records}, indent=2))

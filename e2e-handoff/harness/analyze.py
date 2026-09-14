#!/usr/bin/env python3
"""Per-request view of the proxy captures: tokens in/out, stop reason, block types, time to first byte, total."""
import json, re, sys, glob, os
d = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__)) + '/proxy'
since = sys.argv[2] if len(sys.argv) > 2 else ''
rows = []
for line in open(f'{d}/index.log'):
    m = json.loads(line)
    if not m['url'].startswith('/v1/messages') or m['started'][11:19] < since: continue
    rid = m['id']; resp = f'{d}/{rid}.response.txt'; req = f'{d}/{rid}.request.json'
    out_tok = in_tok = None; stop = None; blocks = []; think_chars = 0; text_chars = 0
    if os.path.exists(resp):
        body = open(resp, errors='replace').read()
        for ev in re.findall(r'^data: (\{.*\})$', body, re.M):
            try: e = json.loads(ev)
            except Exception: continue
            t = e.get('type')
            if t == 'message_start': in_tok = e['message']['usage'].get('input_tokens')
            elif t == 'content_block_start': blocks.append(e['content_block'].get('type'))
            elif t == 'content_block_delta':
                dl = e['delta']; 
                if dl.get('type') == 'thinking_delta': think_chars += len(dl.get('thinking', ''))
                if dl.get('type') == 'text_delta': text_chars += len(dl.get('text', ''))
            elif t == 'message_delta': stop = e['delta'].get('stop_reason'); out_tok = e.get('usage', {}).get('output_tokens')
    last = ''
    if os.path.exists(req):
        r = json.load(open(req)); msgs = r.get('messages', [])
        if msgs:
            c = msgs[-1].get('content'); last = ','.join(b.get('type', '?') for b in c) if isinstance(c, list) else 'text'
    rows.append((m['started'][11:19], rid[-3:], in_tok, out_tok, stop, '+'.join(blocks) or '-', think_chars, text_chars, m.get('ttfbMs'), m.get('totalMs'), last))
print(f"{'time':8} {'id':3} {'in':>6} {'out':>5} {'stop':10} {'blocks':22} {'think':>6} {'text':>6} {'ttfb':>7} {'total':>7}  last-msg")
for r in rows: print(f"{r[0]:8} {r[1]:3} {str(r[2]):>6} {str(r[3]):>5} {str(r[4]):10} {r[5][:22]:22} {r[6]:>6} {r[7]:>6} {str(r[8]):>7} {str(r[9]):>7}  {r[10]}")

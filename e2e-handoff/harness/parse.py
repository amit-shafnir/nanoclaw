import sys, json
for path in sys.argv[1:]:
    print(f"########## {path.rsplit('/',1)[-1]}")
    for line in open(path):
        try: d = json.loads(line)
        except Exception: continue
        m = d.get("message") or {}
        role = m.get("role") or d.get("type")
        if role not in ("user", "assistant"): continue
        content = m.get("content"); blocks = []
        if isinstance(content, list):
            for b in content:
                t = b.get("type")
                if t == "text": blocks.append(("text", len(b.get("text", "")), b.get("text", "")[:80].replace("\n", " ")))
                elif t == "thinking": blocks.append(("THINKING", len(b.get("thinking", ""))))
                elif t == "tool_use": blocks.append(("tool_use", b.get("name"), json.dumps(b.get("input"))[:80]))
                elif t == "tool_result":
                    c = b.get("content", ""); blocks.append(("tool_result", len(json.dumps(c))))
        elif isinstance(content, str): blocks.append(("str", len(content), content[:160].replace("\n", " ")))
        u = m.get("usage") or {}
        ts = (d.get("timestamp") or "")[11:19]
        print(f"{ts} {role:9} out={u.get('output_tokens','-')!s:>5} in={u.get('input_tokens','-')!s:>6} stop={m.get('stop_reason','-')!s:10} {blocks}"[:360])

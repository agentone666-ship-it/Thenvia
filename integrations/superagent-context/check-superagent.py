#!/usr/bin/env python3
"""Conformance test only: does not install plugins, change policy or start a session."""
import json,pathlib,subprocess,sys,uuid
root=pathlib.Path(sys.argv[1]).resolve()
here=pathlib.Path(__file__).resolve().parent
test=root/'tests'/('agentone-source-'+uuid.uuid4().hex+'.spec.ts')
text=(here/'superagent-contract.spec.template').read_text()
text=text.replace('__SOURCE_MODULE__',json.dumps(str(here/'source.mjs'))).replace('__PROTOCOL_MODULE__',json.dumps(str(here/'protocol.mjs')))
try:
    test.write_text(text)
    result=subprocess.run(['pnpm','exec','vitest','run',str(test.relative_to(root))],cwd=root)
    sys.exit(result.returncode)
finally:test.unlink(missing_ok=True)

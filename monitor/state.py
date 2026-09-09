import json, sys, datetime
state = {}
try: state = json.load(open(sys.argv[2]))
except Exception: pass
state["lastVersion"] = sys.argv[1]
state["lastCheck"] = datetime.datetime.utcnow().isoformat() + "Z"
json.dump(state, open(sys.argv[2], "w"), indent=1)

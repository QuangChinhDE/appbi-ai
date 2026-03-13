import requests
import json

# List datasources
r = requests.get('http://localhost:8000/api/v1/datasources/')
print(f'Status: {r.status_code}')
data = r.json()
print(f'Found {len(data)} datasources')
for d in data[:5]:
    print(f"  {d['id']}: {d['name']} ({d['type']})")

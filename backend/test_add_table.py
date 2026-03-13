import requests
import json

# Try to add a table to workspace 2
workspace_id = 2
datasource_id = 3

payload = {
    "datasource_id": datasource_id,
    "source_table_name": "analytic_workflow.danh_sach_san_pham",
    "display_name": "Danh Sach San Pham",
    "enabled": True
}

print(f"Adding table to workspace {workspace_id}...")
print(f"Payload: {json.dumps(payload, indent=2)}")

r = requests.post(
    f'http://localhost:8000/api/v1/dataset-workspaces/{workspace_id}/tables',
    json=payload
)

print(f'\nStatus: {r.status_code}')
if r.status_code < 400:
    print(f'Response: {json.dumps(r.json(), indent=2)}')
else:
    print(f'Error: {r.text}')

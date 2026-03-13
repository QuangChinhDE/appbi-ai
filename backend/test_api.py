"""
Test semantic query API endpoint
"""
import requests
import json

response = requests.post(
    'http://localhost:8000/api/v1/semantic/query',
    json={
        'explore': 'orders',
        'dimensions': ['orders.order_date'],
        'measures': ['orders.count'],
        'filters': {},
        'sorts': [],
        'limit': 5
    }
)

print(f"Status: {response.status_code}")

if response.status_code == 200:
    result = response.json()
    print(f"\n✓ SQL Generated:")
    print(result.get('sql', ''))
    print(f"\n✓ Columns: {result.get('columns', [])}")
    print(f"✓ Rows: {result.get('row_count', 0)}")
    print(f"✓ Execution Time: {result.get('execution_time_ms', 0):.2f}ms")
    
    if result.get('data'):
        print(f"\n✓ Sample Data:")
        for i, row in enumerate(result['data'][:3]):
            print(f"  Row {i+1}: {row}")
else:
    print(f"\n✗ Error: {response.text}")

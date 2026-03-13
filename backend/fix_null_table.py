"""Fix broken table with NULL source_table_name"""
import sys
sys.path.insert(0, '.')

from app.core.database import SessionLocal
from app.models.dataset_workspace import DatasetWorkspaceTable

db = SessionLocal()

# Find table with NULL source_table_name
table = db.query(DatasetWorkspaceTable).filter(
    DatasetWorkspaceTable.id == 5
).first()

if table:
    print(f'Found broken table:')
    print(f'  ID: {table.id}')
    print(f'  Display Name: {table.display_name}')
    print(f'  Source Kind: {table.source_kind}')
    print(f'  Source Table Name: {table.source_table_name}')
    
    # Delete it
    db.delete(table)
    db.commit()
    print('\n✅ Deleted successfully')
else:
    print('Table not found')

db.close()

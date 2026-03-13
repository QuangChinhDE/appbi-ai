"""Delete table 6"""
import sys
sys.path.insert(0, '.')

from app.core.database import SessionLocal
from app.models.dataset_workspace import DatasetWorkspaceTable

db = SessionLocal()
table = db.query(DatasetWorkspaceTable).filter(DatasetWorkspaceTable.id == 6).first()

if table:
    print(f'Deleting table ID: {table.id}')
    print(f'  Display Name: {repr(table.display_name)}')
    db.delete(table)
    db.commit()
    print('✅ Deleted successfully')
else:
    print('Table not found')

db.close()

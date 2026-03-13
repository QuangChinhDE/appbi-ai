"""Direct test of adding table to workspace"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.core.database import SessionLocal
from app.models.dataset_workspace import DatasetWorkspace, DatasetWorkspaceTable

db = SessionLocal()

try:
    # Find workspace
    workspace = db.query(DatasetWorkspace).filter(DatasetWorkspace.id == 2).first()
    if not workspace:
        print("ERROR: Workspace 2 not found")
        sys.exit(1)
    
    print(f"Found workspace: {workspace.name}")
    
    # Create table
    print("Creating table...")
    table = DatasetWorkspaceTable(
        workspace_id=2,
        datasource_id=3,
        source_table_name="analytic_workflow.danh_sach_san_pham",
        display_name="Danh Sach San Pham",
        enabled=True
    )
    
    print("Adding to session...")
    db.add(table)
    
    print("Committing...")
    db.commit()
    
    print("Refreshing...")
    db.refresh(table)
    
    print(f"SUCCESS! Created table {table.id}: {table.display_name}")
    
except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()
finally:
    db.close()

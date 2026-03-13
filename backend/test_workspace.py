"""Test script to check workspace endpoint and see actual error"""
import sys
import os

# Add backend to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def test_direct_service():
    """Test the service directly to see the error"""
    try:
        from app.core.database import SessionLocal
        from app.services.dataset_workspace_crud import DatasetWorkspaceCRUDService
        
        print("Creating database session...")
        db = SessionLocal()
        
        print("Calling get_all_workspaces...")
        workspaces = DatasetWorkspaceCRUDService.get_all_workspaces(db)
        
        print(f"Success! Got {len(workspaces)} workspaces")
        for ws in workspaces:
            print(f"  - {ws.id}: {ws.name}")
            
        db.close()
        
    except Exception as e:
        print(f"ERROR: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    test_direct_service()

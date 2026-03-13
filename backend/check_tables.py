"""Quick script to check database tables and data"""
import sys
sys.path.insert(0, '.')

from app.core.database import SessionLocal
from app.models.models import DataSource, Dataset, Dashboard
from sqlalchemy import text

def check_database():
    db = SessionLocal()
    try:
        # Check data sources
        sources = db.query(DataSource).all()
        print(f"\n📊 Data Sources: {len(sources)}")
        for src in sources:
            print(f"  - {src.name} ({src.type})")
        
        # Check datasets
        datasets = db.query(Dataset).all()
        print(f"\n📋 Datasets: {len(datasets)}")
        for ds in datasets:
            print(f"  - {ds.name} (source_id: {ds.data_source_id})")
        
        # Check dashboards
        dashboards = db.query(Dashboard).all()
        print(f"\n📈 Dashboards: {len(dashboards)}")
        for d in dashboards:
            print(f"  - {d.name} ({len(d.dashboard_charts)} charts)")
            if d.filters_config:
                print(f"    Filters: {len(d.filters_config)}")
        
        # Check all tables
        result = db.execute(text("""
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
            ORDER BY table_name
        """))
        
        print(f"\n📚 All Tables:")
        for row in result:
            print(f"  - {row[0]}")
            
    finally:
        db.close()

if __name__ == "__main__":
    check_database()

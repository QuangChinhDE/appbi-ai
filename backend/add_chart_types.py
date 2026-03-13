"""
Add new chart types to database enum
"""
from sqlalchemy import create_engine, text
import os

DATABASE_URL = os.getenv('DATABASE_URL', 'postgresql://thom_tran:thom_tran!&*0525@35.188.119.206:5432/thom_tran')

engine = create_engine(DATABASE_URL)

new_types = ['AREA', 'STACKED_BAR', 'GROUPED_BAR', 'SCATTER', 'KPI']

with engine.connect() as conn:
    # Start a transaction
    trans = conn.begin()
    try:
        for chart_type in new_types:
            # Check if value already exists
            result = conn.execute(text(f"""
                SELECT EXISTS (
                    SELECT 1 FROM pg_type t 
                    JOIN pg_enum e ON t.oid = e.enumtypid  
                    WHERE t.typname = 'charttype' 
                    AND e.enumlabel = '{chart_type}'
                )
            """))
            exists = result.scalar()
            
            if not exists:
                print(f"Adding {chart_type}...")
                conn.execute(text(f"ALTER TYPE charttype ADD VALUE '{chart_type}'"))
                conn.commit()  # Commit each ALTER TYPE separately
                print(f"✓ Added {chart_type}")
            else:
                print(f"- {chart_type} already exists")
        
        print("\n✅ All chart types added successfully!")
    except Exception as e:
        trans.rollback()
        print(f"❌ Error: {e}")
        raise

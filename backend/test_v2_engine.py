"""
Test semantic query engine v2
"""
from sqlalchemy.orm import Session
from app.core.database import engine
from app.services.semantic_query_engine_v2 import SemanticQueryEngineV2

session = Session(engine)

try:
    # Test basic query
    query_engine = SemanticQueryEngineV2(session, database_type="postgresql")
    
    sql, columns, pivot_metadata = query_engine.generate_sql(
        explore_name="orders",
        dimensions=["orders.order_date"],
        measures=["orders.count"],
        filters={},
        sorts=[{"field": "orders.count", "direction": "desc"}],
        limit=10
    )
    
    print("✓ V2 Engine initialized successfully")
    print(f"\n✓ Generated SQL:\n{sql}")
    print(f"\n✓ Columns: {columns}")
    print(f"✓ Warnings: {query_engine.warnings}")
    
except Exception as e:
    print(f"✗ Error: {e}")
    import traceback
    traceback.print_exc()
finally:
    session.close()

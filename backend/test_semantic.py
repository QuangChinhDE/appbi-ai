"""
Test script to create sample semantic layer definitions and test query execution
"""
from sqlalchemy.orm import Session
from app.core.database import engine
from app.models.semantic import SemanticView, SemanticModel, SemanticExplore

# Create session
session = Session(engine)

try:
    # Create a sample view for orders
    orders_view = SemanticView(
        name="orders",
        sql_table_name="orders",  # Assuming orders table exists
        dimensions=[
            {
                "name": "order_id",
                "type": "number",
                "sql": "${TABLE}.id",
                "label": "Order ID",
                "description": "Unique order identifier",
                "hidden": False
            },
            {
                "name": "order_date",
                "type": "date",
                "sql": "${TABLE}.created_at",
                "label": "Order Date",
                "description": "When the order was placed",
                "hidden": False
            },
            {
                "name": "status",
                "type": "string",
                "sql": "${TABLE}.status",
                "label": "Status",
                "description": "Order status",
                "hidden": False
            }
        ],
        measures=[
            {
                "name": "count",
                "type": "count",
                "sql": "*",
                "label": "Count of Orders",
                "description": "Total number of orders",
                "hidden": False
            }
        ],
        description="Orders table"
    )
    
    # Create a model
    ecommerce_model = SemanticModel(
        name="ecommerce",
        description="E-commerce analytics model"
    )
    
    session.add(orders_view)
    session.add(ecommerce_model)
    session.commit()
    session.refresh(orders_view)
    session.refresh(ecommerce_model)
    
    # Create an explore
    orders_explore = SemanticExplore(
        name="orders",
        model_id=ecommerce_model.id,
        base_view_id=orders_view.id,
        base_view_name="orders",
        joins=[],  # No joins for now
        default_filters={},
        description="Explore orders"
    )
    
    session.add(orders_explore)
    session.commit()
    
    print(f"✓ Created semantic view: {orders_view.name} (ID: {orders_view.id})")
    print(f"✓ Created semantic model: {ecommerce_model.name} (ID: {ecommerce_model.id})")
    print(f"✓ Created semantic explore: {orders_explore.name} (ID: {orders_explore.id})")
    
    # Test SQL generation
    from app.services.semantic_query_engine import SemanticQueryEngine
    
    engine_instance = SemanticQueryEngine(session)
    sql, columns = engine_instance.generate_sql(
        explore_name="orders",
        dimensions=["orders.order_date", "orders.status"],
        measures=["orders.count"],
        filters={},
        sorts=[{"field": "orders.count", "direction": "desc"}],
        limit=100
    )
    
    print(f"\n✓ Generated SQL:\n{sql}")
    print(f"\n✓ Columns: {columns}")
    
except Exception as e:
    print(f"✗ Error: {e}")
    import traceback
    traceback.print_exc()
    session.rollback()
finally:
    session.close()

import psycopg2

conn = psycopg2.connect(
    'postgresql://thom_tran:thom_tran!&*0525@35.188.119.206:5432/thom_tran'
)
cur = conn.cursor()

try:
    # Check current enum values
    cur.execute("""
        SELECT e.enumlabel 
        FROM pg_enum e
        JOIN pg_type t ON e.enumtypid = t.oid
        WHERE t.typname = 'charttype'
        ORDER BY e.enumsortorder;
    """)
    
    values = cur.fetchall()
    print('Current charttype enum values:')
    for v in values:
        print(f'  - "{v[0]}"')
    
    # Check if 'table' exists
    has_table = any(v[0] == 'table' for v in values)
    print(f'\nHas "table" value: {has_table}')
    
    has_TABLE = any(v[0] == 'TABLE' for v in values)
    print(f'Has "TABLE" value: {has_TABLE}')
    
    if not has_TABLE:
        print('\nAttempting to add "TABLE" value...')
        cur.execute("ALTER TYPE charttype ADD VALUE 'TABLE'")
        conn.commit()
        print('✓ Successfully added "TABLE" value')
    
except Exception as e:
    print(f'Error: {e}')
finally:
    cur.close()
    conn.close()

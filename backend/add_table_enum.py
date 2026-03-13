import psycopg2

conn = psycopg2.connect(
    'postgresql://thom_tran:thom_tran!&*0525@35.188.119.206:5432/thom_tran'
)
cur = conn.cursor()

try:
    cur.execute("ALTER TYPE charttype ADD VALUE 'table'")
    conn.commit()
    print('✓ Successfully added "table" value to charttype enum')
except Exception as e:
    print(f'Error: {e}')
finally:
    cur.close()
    conn.close()

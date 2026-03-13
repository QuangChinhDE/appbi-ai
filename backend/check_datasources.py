from sqlalchemy import create_engine, text

engine = create_engine('postgresql://thom_tran:thom_tran!&*0525@35.188.119.206:5432/thom_tran')

with engine.connect() as conn:
    result = conn.execute(text('SELECT id, name, type FROM datasources'))
    rows = result.fetchall()
    
    print('Datasources in database:')
    if rows:
        for row in rows:
            print(f'  ID: {row[0]}, Name: {row[1]}, Type: {row[2]}')
    else:
        print('  ❌ No datasources found')
        print('\nYou need to create a datasource first!')

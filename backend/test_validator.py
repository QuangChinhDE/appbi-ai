"""Test SQL Validator"""
from app.services.query_validator import QueryValidator, QueryValidationError

print('Test 1: Valid SELECT')
try:
    result = QueryValidator.validate_and_clean('SELECT * FROM orders')
    print(f'✅ Valid: {result}')
except QueryValidationError as e:
    print(f'❌ Error: {e}')

print('\nTest 2: Invalid DELETE')
try:
    result = QueryValidator.validate_and_clean('DELETE FROM orders')
    print(f'✅ Valid: {result}')
except QueryValidationError as e:
    print(f'❌ Error: {e}')

print('\nTest 3: Multiple statements')
try:
    result = QueryValidator.validate_and_clean('SELECT * FROM orders; DROP TABLE orders')
    print(f'✅ Valid: {result}')
except QueryValidationError as e:
    print(f'❌ Error: {e}')

print('\nTest 4: SQL comments')
try:
    result = QueryValidator.validate_and_clean('SELECT * FROM orders -- comment')
    print(f'✅ Valid: {result}')
except QueryValidationError as e:
    print(f'❌ Error: {e}')

print('\nTest 5: Valid SELECT with JOINs')
try:
    result = QueryValidator.validate_and_clean('''
        SELECT o.*, c.name 
        FROM orders o 
        JOIN customers c ON o.customer_id = c.id
    ''')
    print(f'✅ Valid: {result[:50]}...')
except QueryValidationError as e:
    print(f'❌ Error: {e}')

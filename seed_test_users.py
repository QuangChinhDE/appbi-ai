import sys, os
sys.path.insert(0, '/home/appbi/AppBI/Dashboard-App/backend')
os.environ['DATABASE_URL'] = 'postgresql+psycopg2://appbi:appbi@localhost:5432/appbi'
os.environ['SECRET_KEY'] = 'dev-secret-key-for-testing'

import warnings
warnings.filterwarnings('ignore')

from app.core.database import SessionLocal
from app.models.user import User, UserStatus
from app.api.auth import hash_password
import uuid

# Permission presets
PRESETS = {
    'admin': {'data_sources':'full','datasets':'full','workspaces':'full','explore_charts':'full','dashboards':'full','ai_chat':'full','settings':'full'},
    'editor': {'data_sources':'view','datasets':'edit','workspaces':'edit','explore_charts':'edit','dashboards':'edit','ai_chat':'edit','settings':'none'},
    'viewer': {'data_sources':'none','datasets':'none','workspaces':'none','explore_charts':'none','dashboards':'view','ai_chat':'none','settings':'none'},
}

db = SessionLocal()

test_users = [
    ('admin@appbi.io',  'Admin AppBI',  'admin'),
    ('editor@appbi.io', 'Editor User',  'editor'),
    ('viewer@appbi.io', 'Viewer User',  'viewer'),
    ('alice@appbi.io',  'Alice Nguyen', 'editor'),
    ('bob@appbi.io',    'Bob Tran',     'viewer'),
]

for email, full_name, preset in test_users:
    existing = db.query(User).filter(User.email == email).first()
    if existing:
        print(f'  SKIP: {email}')
        continue
    u = User(
        id=uuid.uuid4(),
        email=email,
        password_hash=hash_password('123456'),
        full_name=full_name,
        status=UserStatus.ACTIVE,
        permissions=PRESETS[preset],
    )
    db.add(u)
    print(f'  CREATED: {email} [{preset}]')

db.commit()
db.close()
print('All done.')

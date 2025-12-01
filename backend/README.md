# AppBI Backend

FastAPI-based backend for the AppBI Business Intelligence tool.

## Quick Start

1. **Install dependencies**:
   ```powershell
   pip install -r requirements.txt
   ```

2. **Setup environment**:
   ```powershell
   cp .env.example .env
   # Edit .env with your database credentials
   ```

3. **Run migrations**:
   ```powershell
   alembic revision --autogenerate -m "Initial migration"
   alembic upgrade head
   ```

4. **Start server**:
   ```powershell
   python run.py
   # or
   uvicorn app.main:app --reload
   ```

Visit http://localhost:8000/docs for API documentation.
